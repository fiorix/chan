// @vitest-environment jsdom
// R3: a Wysiwyg host with no `onSubmit` (the file editor) must NOT insert a
// blank line on Cmd/Ctrl+Enter. The chord is consumed as a no-op instead of
// falling through to CM6's default Mod-Enter (insertBlankLine). With an
// `onSubmit` wired (a chat-style host) the chord still submits.
import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import Wysiwyg from "./Wysiwyg.svelte";

const mounted: Array<Record<string, unknown>> = [];
afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
});

async function mountWysiwyg(props: {
  value: string;
  currentPath?: string | null;
  onSubmit?: () => void;
}): Promise<{ content: HTMLElement; view: EditorView }> {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(Wysiwyg, { target, props }) as Record<string, unknown>);
  for (let i = 0; i < 10 && !target.querySelector(".cm-content"); i++) {
    await tick();
    await Promise.resolve();
  }
  const content = target.querySelector(".cm-content") as HTMLElement;
  const view = EditorView.findFromDOM(content) as EditorView;
  return { content, view };
}

function press(el: HTMLElement, key: string, mods: Partial<KeyboardEventInit> = {}): void {
  el.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }),
  );
}

describe("R3: Mod-Enter in a no-onSubmit Wysiwyg host (the file editor)", () => {
  test("Cmd/Ctrl+Enter on a plain line does NOT insert a blank line", async () => {
    const { content, view } = await mountWysiwyg({ value: "hello world", currentPath: "note.md" });
    await tick();
    view.dispatch({ selection: { anchor: 5 } });
    const before = view.state.doc.toString();
    press(content, "Enter", { ctrlKey: true });
    press(content, "Enter", { metaKey: true });
    await tick();
    expect(view.state.doc.toString()).toBe(before); // consumed, no blank line
  });

  test("with onSubmit wired, Mod-Enter submits once and leaves the doc unchanged", async () => {
    const onSubmit = vi.fn();
    const { content, view } = await mountWysiwyg({
      value: "hello world",
      currentPath: "note.md",
      onSubmit,
    });
    await tick();
    view.dispatch({ selection: { anchor: 5 } });
    const before = view.state.doc.toString();
    press(content, "Enter", { ctrlKey: true });
    press(content, "Enter", { metaKey: true });
    await tick();
    expect(view.state.doc.toString()).toBe(before);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

// A pasted image leaves its atom ring-selected (caret at the atom edge),
// and the image widget's document-level keydown listener treats a bubbling
// Mod-Enter as the View chord (fullscreen zoom). A chat host's submit must
// consume the chord entirely; the file editor keeps the bubbling on purpose
// (ring + Mod-Enter View is the feature there).
describe("Mod-Enter with a ring-selected image", () => {
  const IMG_DOC = "![](photo.png#w=250)\nhello";
  const ATOM_END = "![](photo.png#w=250)".length;

  afterEach(() => {
    for (const el of document.querySelectorAll(".md-image-zoom")) el.remove();
  });

  async function ringSelect(view: EditorView, content: HTMLElement): Promise<HTMLElement | null> {
    view.dispatch({ selection: { anchor: ATOM_END } });
    await tick();
    await Promise.resolve();
    return content
      .closest(".cm-editor")
      ?.querySelector<HTMLElement>(".cm-md-image-wrap[data-selected]") ?? null;
  }

  test("chat host: submit does NOT open the image zoom", async () => {
    const onSubmit = vi.fn();
    const { content, view } = await mountWysiwyg({
      value: IMG_DOC,
      currentPath: "note.md",
      onSubmit,
    });
    await tick();
    const ring = await ringSelect(view, content);
    expect(ring, "image atom must be ring-selected before the chord").toBeTruthy();
    press(content, "Enter", { ctrlKey: true });
    await tick();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".md-image-zoom")).toBeNull();
  });

  test("file editor: the ring + Mod-Enter View chord still opens the zoom", async () => {
    const { content, view } = await mountWysiwyg({
      value: IMG_DOC,
      currentPath: "note.md",
    });
    await tick();
    const ring = await ringSelect(view, content);
    expect(ring, "image atom must be ring-selected before the chord").toBeTruthy();
    press(content, "Enter", { ctrlKey: true });
    await tick();
    expect(document.querySelector(".md-image-zoom")).toBeTruthy();
  });
});
