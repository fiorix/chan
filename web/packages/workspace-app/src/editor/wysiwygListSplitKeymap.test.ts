// @vitest-environment jsdom
// The long-item flow through the real Wysiwyg keymap: Enter with the caret
// mid-way through a list item splits it into two items, and Tab on the new
// item nests it (consumed, so it never escapes to the browser's focus nav).
// Both keys go through a mounted Wysiwyg and real keydown events, so the
// binding order in the Prec.high keymap is under test, not just the command.
import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import { EditorView } from "@codemirror/view";
import Wysiwyg from "./Wysiwyg.svelte";

const mounted: Array<Record<string, unknown>> = [];
afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
});

async function mountWysiwyg(value: string): Promise<{ content: HTMLElement; view: EditorView }> {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(
    mount(Wysiwyg, { target, props: { value, currentPath: "note.md" } }) as Record<
      string,
      unknown
    >,
  );
  for (let i = 0; i < 10 && !target.querySelector(".cm-content"); i++) {
    await tick();
    await Promise.resolve();
  }
  const content = target.querySelector(".cm-content") as HTMLElement;
  const view = EditorView.findFromDOM(content) as EditorView;
  return { content, view };
}

/// Dispatch a keydown on the content DOM; true when CM6 consumed it
/// (preventDefault), which is what keeps Tab inside the editor.
function press(el: HTMLElement, key: string, mods: Partial<KeyboardEventInit> = {}): boolean {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods });
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
}

describe("Enter mid-item splits the item, then Tab nests the new item", () => {
  test("bullet: Enter after a word moves the tail into a new bullet and Tab nests it", async () => {
    const { content, view } = await mountWysiwyg("- the quick brown fox");
    await tick();
    view.dispatch({ selection: { anchor: 17 } }); // right after "brown"
    expect(press(content, "Enter")).toBe(true);
    await tick();
    expect(view.state.doc.toString()).toBe("- the quick brown\n- fox");
    expect(view.state.selection.main.head).toBe(20); // after the new "- "
    // Tab on the split-off item nests it under its sibling and is consumed.
    expect(press(content, "Tab")).toBe(true);
    await tick();
    expect(view.state.doc.toString()).toBe("- the quick brown\n  - fox");
    // Shift-Tab brings it back, still consumed.
    expect(press(content, "Tab", { shiftKey: true })).toBe(true);
    await tick();
    expect(view.state.doc.toString()).toBe("- the quick brown\n- fox");
  });

  test("ordered: the split item takes the next number and the tail renumbers", async () => {
    const { content, view } = await mountWysiwyg("1. alpha beta\n2. gamma");
    await tick();
    view.dispatch({ selection: { anchor: 8 } }); // right after "alpha"
    expect(press(content, "Enter")).toBe(true);
    await tick();
    expect(view.state.doc.toString()).toBe("1. alpha\n2. beta\n3. gamma");
    expect(view.state.selection.main.head).toBe(12);
  });

  test("task: the moved text gets a fresh unchecked box", async () => {
    const { content, view } = await mountWysiwyg("- [x] done next");
    await tick();
    view.dispatch({ selection: { anchor: 10 } }); // right after "done"
    expect(press(content, "Enter")).toBe(true);
    await tick();
    expect(view.state.doc.toString()).toBe("- [x] done\n- [ ] next");
  });

  test("Enter at the very start of a list line still just opens a line above it", async () => {
    const { content, view } = await mountWysiwyg("- hello");
    await tick();
    view.dispatch({ selection: { anchor: 0 } });
    expect(press(content, "Enter")).toBe(true);
    await tick();
    expect(view.state.doc.toString()).toBe("\n- hello");
  });
});

describe("Enter on a list-shaped line inside a fenced code block", () => {
  test("mid-line Enter inside a YAML fence wraps the line without inventing a bullet", async () => {
    const { content, view } = await mountWysiwyg("```yaml\n- name: build the thing\n```");
    await tick();
    view.dispatch({ selection: { anchor: 21 } }); // right after "build"
    expect(press(content, "Enter")).toBe(true);
    await tick();
    const doc = view.state.doc.toString();
    expect(doc.startsWith("```yaml\n- name: build\n")).toBe(true);
    expect(doc).not.toContain("\n- the thing");
    // The fence's own renumber/continuation never fires: one leading marker only.
    expect(doc.match(/^- /gm)?.length ?? 0).toBe(1);
  });

  test("end-of-line Enter inside a fence is a plain newline, not a new bullet", async () => {
    const { content, view } = await mountWysiwyg("```\n- item\n```");
    await tick();
    view.dispatch({ selection: { anchor: 10 } }); // end of "- item"
    expect(press(content, "Enter")).toBe(true);
    await tick();
    expect(view.state.doc.toString()).toBe("```\n- item\n\n```");
  });
});
