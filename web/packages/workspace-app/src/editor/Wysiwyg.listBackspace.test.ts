// @vitest-environment jsdom
// Backspace at the start of a list item's text, through a mounted Wysiwyg and
// real keydown events, so the binding's place ahead of the default deletion is
// under test: a nested item moves one level out as Shift-Tab moves it, and a
// top-level item loses its marker in one press, its text then read as markdown
// reads a line with no marker in that place: under another item it continues
// that item's paragraph, and after a blank line it is a paragraph of its own.
import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import { EditorView } from "@codemirror/view";
import Wysiwyg from "./Wysiwyg.svelte";

const mounted: Array<Record<string, unknown>> = [];
afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  document.body.innerHTML = "";
});

async function mountWysiwyg(value: string): Promise<{ content: HTMLElement; view: EditorView }> {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(
    mount(Wysiwyg, { target, props: { value, currentPath: "note.md" } }) as Record<string, unknown>,
  );
  for (let i = 0; i < 10 && !target.querySelector(".cm-content"); i++) {
    await tick();
    await Promise.resolve();
  }
  const content = target.querySelector(".cm-content") as HTMLElement;
  const view = EditorView.findFromDOM(content) as EditorView;
  return { content, view };
}

function press(el: HTMLElement, key: string, mods: Partial<KeyboardEventInit> = {}): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }));
}

/// The document and caret after one key at `caret`.
async function afterKey(doc: string, caret: number, key: string, mods: Partial<KeyboardEventInit> = {}): Promise<{ doc: string; head: number }> {
  const { content, view } = await mountWysiwyg(doc);
  await tick();
  view.dispatch({ selection: { anchor: caret } });
  press(content, key, mods);
  await tick();
  return { doc: view.state.doc.toString(), head: view.state.selection.main.head };
}

const backspace = (doc: string, caret: number) => afterKey(doc, caret, "Backspace");
const shiftTab = (doc: string, caret: number) => afterKey(doc, caret, "Tab", { shiftKey: true });

describe("Backspace at the start of a nested item's text moves it one level out", () => {
  test("a nested bullet", async () => {
    expect(await backspace("* one\n  * two", 10)).toEqual({ doc: "* one\n* two", head: 8 });
  });

  test("a nested ordered item, as Shift-Tab moves it", async () => {
    const doc = "1. one\n   1. sub\n2. two";
    const result = await backspace(doc, 13);
    expect(result).toEqual(await shiftTab(doc, 13));
    expect(result).toEqual({ doc: "1. one\n1. sub\n2. two", head: 10 });
  });

  test("a bullet nested under an ordered item", async () => {
    expect(await backspace("1. one\n   * sub", 12)).toEqual({ doc: "1. one\n* sub", head: 9 });
  });

  test("a nested item after its parent's continuation line", async () => {
    // The tree nests `  * two` in the first item although the line above it
    // is not a list line.
    expect(await backspace("* one\n  more\n  * two", 17)).toEqual({ doc: "* one\n  more\n* two", head: 15 });
  });

  test("a nested task keeps its box", async () => {
    expect(await backspace("- [ ] one\n  - [ ] two", 18)).toEqual({ doc: "- [ ] one\n- [ ] two", head: 16 });
  });
});

describe("Backspace at the start of a top-level item's text removes its marker in one press", () => {
  test("a bullet under another item, its text continuing that item's paragraph", async () => {
    expect(await backspace("* one\n* two", 8)).toEqual({ doc: "* one\ntwo", head: 6 });
  });

  test("an indented item with nothing above it, its text a paragraph", async () => {
    expect(await backspace("  * two", 4)).toEqual({ doc: "two", head: 0 });
  });

  test("a task under another task, marker, box and gap together, its text continuing the item above", async () => {
    expect(await backspace("- [ ] one\n- [ ] two", 16)).toEqual({ doc: "- [ ] one\ntwo", head: 10 });
  });
});

describe("Backspace anywhere else is the default deletion", () => {
  test("inside a nested item's text", async () => {
    expect(await backspace("* one\n  * two", 11)).toEqual({ doc: "* one\n  * wo", head: 10 });
  });

  test("on a list-shaped line in a fence", async () => {
    expect(await backspace("```\n  - name: x\n```", 8)).toEqual({ doc: "```\n  -name: x\n```", head: 7 });
  });

  test("with a selection that ends at a nested item's text start, deleting the selection", async () => {
    const { content, view } = await mountWysiwyg("* one\n  * two");
    await tick();
    view.dispatch({ selection: { anchor: 13, head: 10 } });
    press(content, "Backspace");
    await tick();
    expect(view.state.doc.toString()).toBe("* one\n  * ");
  });

  test("on a list-shaped line in a fence inside an item", async () => {
    expect(await backspace("* one\n\n  ```\n  - x\n  ```", 17)).toEqual({ doc: "* one\n\n  ```\n  -x\n  ```", head: 16 });
  });
});
