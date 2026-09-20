// @vitest-environment jsdom
//
// Two images on one source line, the caret inside the second. The caret
// makes that image render as a preview block ABOVE the line, and a block
// widget's live position is the line's start, which is where the first
// image begins. Every action the preview offers resolves its own source
// range, so each one below asks for the second image and must not get the
// first: a read that copies the wrong markdown is wrong, and a write that
// moves the caret or the range into another image is worse.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { chanMarkdown } from "../markdown/grammar";
import {
  IMAGE_MOVE_MIME,
  imageCaretRedirect,
  imageDecorations,
  selectedImageMarkdown,
} from "./image";

const writeClipboardText = vi.fn(async (_text: string) => {});
vi.mock("../../api/desktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/desktop")>()),
  writeClipboardText: (text: string) => writeClipboardText(text),
}));

const FIRST = "![one](1.png)";
const SECOND = "![two](2.png)";
const DOC = `${FIRST} ${SECOND}`;
/// Strictly inside the second image's URL slot, which is what puts it in
/// edit mode and renders the preview block.
const CARET = DOC.indexOf("2.png") + 3;

let view: EditorView | undefined;
let target: HTMLDivElement | undefined;

function mount(): void {
  target = document.createElement("div");
  document.body.append(target);
  view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      selection: { anchor: CARET },
      extensions: [
        chanMarkdown(),
        imageDecorations({ getCurrentPath: () => null }),
        imageCaretRedirect(),
      ],
    }),
    parent: target,
  });
}

/// The wrap that stands for one image. Both images have one, and the
/// preview's is the one the actions below are driven from.
function wrapFor(src: string): HTMLElement {
  const wraps = Array.from(
    view!.dom.querySelectorAll<HTMLElement & { _chanImg?: { src: string } }>(
      ".cm-md-image-wrap",
    ),
  );
  const found = wraps.find((el) => el._chanImg?.src === src);
  expect(found, `no image wrap for ${src}`).toBeTruthy();
  return found!;
}

function secondRange(): { from: number; to: number } {
  const from = DOC.indexOf(SECOND);
  return { from, to: from + SECOND.length };
}

beforeEach(() => {
  writeClipboardText.mockClear();
});

afterEach(() => {
  view?.destroy();
  target?.remove();
  view = undefined;
  target = undefined;
  document.body.innerHTML = "";
});

describe("the editing preview of the second image on a line", () => {
  test("the Copy button copies the second image's markdown", async () => {
    mount();
    wrapFor("2.png")
      .querySelector(".cm-md-image-copy")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await vi.waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalledWith(SECOND);
    });
  });

  test("Cmd+C on its ring copies the second image's markdown", async () => {
    mount();
    wrapFor("2.png").dataset.selected = "true";
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalledWith(SECOND);
    });
  });

  test("right-click Copy reads the second image's markdown", () => {
    mount();
    wrapFor("2.png").dataset.selected = "true";
    expect(selectedImageMarkdown(view!)).toBe(SECOND);
  });

  test("Edit puts the caret in the second image's URL", () => {
    mount();
    view!.dispatch({ selection: { anchor: DOC.indexOf("2.png") + 4 } });
    wrapFor("2.png")
      .querySelector(".cm-md-image-action")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const { from, to } = secondRange();
    const head = view!.state.selection.main.head;
    expect(head).toBeGreaterThan(from);
    expect(head).toBeLessThan(to);
  });

  test("drag-to-move carries the second image's range", () => {
    mount();
    const data = new Map<string, string>();
    const event = new Event("dragstart", { bubbles: true }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", {
      value: {
        setData: (type: string, value: string) => data.set(type, value),
        setDragImage: () => {},
        effectAllowed: "",
      },
    });
    wrapFor("2.png").querySelector("img")!.dispatchEvent(event);
    expect(data.get(IMAGE_MOVE_MIME)).toBe(JSON.stringify(secondRange()));
  });
});
