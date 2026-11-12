// @vitest-environment jsdom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import OutlineBody from "./OutlineBody.svelte";
import {
  allCommands,
  commandById,
  registerCommands,
  unregisterCommands,
  type Command,
} from "../state/commands";

// OutlineBody, the file editor's outline inspector: the buffer's ATX headings
// in document order, with heading-looking lines inside fenced code left out.
// On a slide deck it shows the deck's thumbnails under the deck's two
// actions, each worded by its command.

const mounted: Array<Record<string, any>> = [];
let catalog: Command[] | null = null;

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  document.body.innerHTML = "";
  if (catalog) {
    unregisterCommands(() => true);
    registerCommands(catalog);
    catalog = null;
  }
});

function outlineRows(content: string): string[] {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(OutlineBody, { target, props: { content, onSelect: () => {} } }));
  flushSync();
  return [...target.querySelectorAll(".outline-list button")].map((b) => b.textContent ?? "");
}

describe("OutlineBody", () => {
  test("lists the headings in document order", () => {
    expect(outlineRows("# One\ntext\n## Two\n")).toEqual(["One", "Two"]);
  });

  test("closes a list item's fence at the item's content column", () => {
    const content = "# Setup\n- ```sh\n  make\n  ```\n# Usage\n```sh\n# a comment\n```\n# Last\n";
    expect(outlineRows(content)).toEqual(["Setup", "Usage", "Last"]);
  });

  test("reads a tab-indented backtick run as indented code, not a fence", () => {
    expect(outlineRows("# A\n\n\t```\n\n# B\n")).toEqual(["A", "B"]);
  });

  test("leaves out a #-looking line inside a fence indented up to three spaces", () => {
    expect(outlineRows("# One\n  ```sh\n# a shell comment\n  ```\n## Two\n")).toEqual([
      "One",
      "Two",
    ]);
  });

  test("leaves out a comment line of leading YAML frontmatter, and keeps the body's lines", () => {
    const content = "---\ntitle: Plan\n# a YAML comment\n---\n# Body\n";
    expect(outlineRows(content)).toEqual(["Body"]);
    const target = document.createElement("div");
    document.body.appendChild(target);
    const selected: number[] = [];
    mounted.push(mount(OutlineBody, { target, props: { content, onSelect: (h: { line: number }) => selected.push(h.line) } }));
    flushSync();
    [...target.querySelectorAll<HTMLButtonElement>(".outline-list button")].at(-1)!.click();
    expect(selected, "the body heading keeps its source line").toEqual([4]);
  });

  test("reads an opening --- with no closer as a rule, so the heading below it stays", () => {
    expect(outlineRows("---\n# Title\ntext\n")).toEqual(["Title"]);
  });
});


describe("slide thumbnails", () => {
  const content = '---\nchan:\n  kind: slides\n---\n# First\n\n<hr class="chan-page-break">\n\nA slide without a heading.\n';

  test("renders the current buffer, with a selectable heading-free slide", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const selected: number[] = [];
    mounted.push(mount(OutlineBody, { target, props: { content, caretLine: 8, onSelect: h => selected.push(h.line) } }));
    flushSync();
    const buttons = [...target.querySelectorAll<HTMLButtonElement>(".slide-thumb")];
    expect(buttons).toHaveLength(2);
    expect(buttons[1]!.getAttribute("aria-current")).toBe("true");
    buttons[1]!.click();
    expect(selected).toEqual([7]);
    expect(target.querySelector(".slide-label, .slide-empty, .slide-heading-list")).toBeNull();
    await vi.waitFor(() => expect(buttons[1]!.querySelector(".slide-miniature")?.textContent).toContain("A slide without a heading."));
  });

  test("keeps keyboard navigation in slide order", () => {
    const target = document.createElement("div");
    document.body.append(target);
    const selected: number[] = [];
    mounted.push(mount(OutlineBody, { target, props: { content, onSelect: h => selected.push(h.line) } }));
    flushSync();
    const buttons = [...target.querySelectorAll<HTMLButtonElement>(".slide-thumb")];
    buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
    expect(selected).toEqual([7]);
    expect(document.activeElement).toBe(buttons[1]);
    buttons[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
    expect(selected).toEqual([7, 4]);
    expect(document.activeElement).toBe(buttons[0]);
  });
});

describe("a deck's actions", () => {
  const DECK = '---\nchan:\n  kind: slides\n---\n# First\n';
  const PREVIEW = "app.slides.preview";
  const PRESENT = "app.slides.present";

  function title(id: string): string {
    const command = commandById(id);
    if (!command) throw new Error(`no command ${id}`);
    return command.title;
  }

  function actions(props: Record<string, unknown> = {}): HTMLButtonElement[] {
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(OutlineBody, { target, props: { content: DECK, onSelect: () => {}, ...props } }));
    flushSync();
    return [...target.querySelectorAll<HTMLButtonElement>(".slide-action")];
  }

  test("carry the titles of the preview and present commands, and run the host's handlers", () => {
    const onPreview = vi.fn();
    const onPlay = vi.fn();
    const [preview, present] = actions({ onPreview, onPlay });

    expect([preview!.textContent?.trim(), present!.textContent?.trim()]).toEqual([title(PREVIEW), title(PRESENT)]);
    preview!.click();
    present!.click();
    expect([onPreview.mock.calls.length, onPlay.mock.calls.length]).toEqual([1, 1]);
  });

  test("follow the catalog when a title there changes, in the label and in the tooltip", () => {
    catalog = allCommands();
    unregisterCommands(() => true);
    registerCommands(catalog.map((command) => ({ ...command, title: `<${command.id}>` })));
    const [preview, present] = actions({ previewChord: "Ctrl+Enter" });

    expect([preview!.textContent?.trim(), present!.textContent?.trim()]).toEqual([`<${PREVIEW}>`, `<${PRESENT}>`]);
    // The tooltip adds the deck's aspect ratio, and the chord where the
    // action has one.
    expect([preview!.title, present!.title]).toEqual([`<${PREVIEW}> (16:9, Ctrl+Enter)`, `<${PRESENT}> (16:9)`]);
  });

  test("are not shown over a document that is not a deck", () => {
    expect(actions({ content: "# One\n" })).toEqual([]);
  });
});
