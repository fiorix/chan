// @vitest-environment jsdom
//
// The file preview popover is one per page: a second open, whether a click on
// the same pill, a click on another pill, or an open with no click (the body
// menu's Preview, a mention whose contact resolved), leaves one preview on
// screen, and the keys go to that one.

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return { ...actual, api: { ...actual.api, read: vi.fn(() => new Promise(() => {})) } };
});

import { openPreviewPopover } from "./preview_popover";

const handles: Array<{ dismiss: () => void }> = [];
const opened: Array<{ open: number; path: string }> = [];
let opens = 0;

afterEach(() => {
  for (const handle of handles.splice(0)) handle.dismiss();
  opened.length = 0;
  opens = 0;
  document.body.replaceChildren();
});

/// Open a preview of `path` under `anchor` and record, by the open's sequence
/// number, every Open it commits to.
function open(anchor: HTMLElement, path: string): void {
  const seq = ++opens;
  handles.push(
    openPreviewPopover({
      anchor,
      path,
      onOpen: () => opened.push({ open: seq, path }),
    }),
  );
}

/// A pill that previews its file on a primary mousedown, as the wiki pill does
/// in read mode.
function pill(path: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "cm-md-wiki-pill";
  el.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    open(el, path);
  });
  document.body.append(el);
  return el;
}

function click(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
}

function press(key: string, mods: Partial<KeyboardEventInit> = {}): void {
  const at = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  at.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }));
}

/// The popover wires its listeners in a zero-delay timeout.
const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const popovers = () => document.querySelectorAll<HTMLElement>(".md-preview-popover");

type SecondOpen = (first: HTMLElement) => void;
const SECOND_OPENS: Array<[string, SecondOpen]> = [
  ["a second click on the same pill", (first) => click(first)],
  ["a click on another pill", () => click(pill("b.md"))],
  ["an open with no click, as the body menu does", () => open(pill("b.md"), "b.md")],
];

describe("one preview popover at a time", () => {
  test.each(SECOND_OPENS)("after %s one popover is on screen and one Escape closes it", async (_, second) => {
    const first = pill("a.md");
    click(first);
    await macrotask();
    second(first);
    await macrotask();

    expect(popovers().length).toBe(1);
    press("Escape");
    expect(popovers().length).toBe(0);
  });

  test.each(SECOND_OPENS)("after %s Mod+Enter opens the file of the preview that is showing", async (_, second) => {
    const first = pill("a.md");
    click(first);
    await macrotask();
    second(first);
    await macrotask();

    // The popover appended last paints on top: it is the preview the user
    // sees.
    const showing = [...popovers()].at(-1)!;
    const shown = showing.querySelector(".md-preview-path")!.textContent;
    press("Enter", { ctrlKey: true });

    expect(opened).toEqual([{ open: opens, path: shown }]);
    expect(popovers().length).toBe(0);
  });
});
