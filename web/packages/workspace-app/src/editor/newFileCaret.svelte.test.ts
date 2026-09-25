// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type ComponentProps, flushSync, mount, unmount } from "svelte";
import { EditorView } from "@codemirror/view";
import SourceComponent from "./Source.svelte";
import WysiwygComponent from "./Wysiwyg.svelte";
import { installEditorDom } from "../__tests__/wysiwyg";

installEditorDom();

// A file opened without an explicit caret (File Browser double-click,
// `cs open <file>`) must still land with a usable, focused caret -- not
// stay unfocused until the user clicks in. The Draft path (Cmd+N) works
// because it passes initialSelection; plain opens omit it. Each editor
// treats an absent caret as document start (0,0) and re-claims focus once
// content lands.
//
// But that re-claim must run ONLY when external content actually lands, not
// on the keystroke echo that writes `value` back from the live doc: a new
// empty file goes empty -> non-empty on the FIRST keystroke, and placing the
// caret there would reset it to 0 so "Hello" lands as "elloH".

// ---- behavioral: mount the real editors and drive the value<->doc loop ----

const components: Array<[string, typeof SourceComponent]> = [
  ["Source", SourceComponent],
  ["Wysiwyg", WysiwygComponent as unknown as typeof SourceComponent],
];

const mounted: Array<Record<string, unknown>> = [];

beforeEach(() => {
  // Source/Wysiwyg read the resolved theme + may touch canvas on mount in
  // some paths; stub both so the editor mounts cleanly under jsdom.
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent() {
          return false;
        },
      }) as unknown as MediaQueryList,
  );
  HTMLCanvasElement.prototype.getContext =
    (() => null) as unknown as HTMLCanvasElement["getContext"];
});

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function mountEditor(
  Comp: typeof SourceComponent,
  props: Record<string, unknown>,
): EditorView {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(Comp, {
    target,
    props: {
      autoFocus: false,
      path: "note.md",
      value: "",
      ...props,
    } as ComponentProps<typeof SourceComponent>,
  });
  mounted.push(component);
  flushSync();
  const dom =
    target.querySelector<HTMLElement>(".cm-editor") ??
    target.querySelector<HTMLElement>(".cm-content");
  const view = dom ? EditorView.findFromDOM(dom) : null;
  if (!view) throw new Error("editor view did not mount");
  return view;
}

// Insert one character at a time at the live caret, flushing the component's
// value->doc $effect between keystrokes -- exactly the loop that produced the
// "elloH" reorder.
function typeChars(view: EditorView, text: string): void {
  for (const ch of text) {
    const at = view.state.selection.main.head;
    view.dispatch({
      changes: { from: at, insert: ch },
      selection: { anchor: at + ch.length },
    });
    flushSync();
  }
}

describe("first keystroke does not reorder text (new empty file)", () => {
  for (const [name, Comp] of components) {
    test(`${name}: typing into a new empty file preserves order`, () => {
      const view = mountEditor(Comp, { value: "" });
      typeChars(view, "Hello");
      expect(view.state.doc.toString()).toBe("Hello");
    });
  }
});

describe("persisted caret survives mount (reopened file)", () => {
  for (const [name, Comp] of components) {
    test(`${name}: caret lands at the persisted offset, not document start`, () => {
      const view = mountEditor(Comp, {
        value: "abcdef",
        initialCaret: { from: 3, to: 3 },
      });
      expect(view.state.selection.main.head).toBe(3);
    });
  }
});

// ---- resetCaret re-drives an ALREADY-mounted, latched editor ----
//
// A pane keeps one editor per tab alive, and `initialCaret` is a one-shot
// mount snapshot (maybeRestoreCaret latches via caretRestored). So re-opening a
// kept-alive tab (File-Browser reclick, `cs open` twice) cannot move the caret
// through the prop. `resetCaret` is the imperative channel the tab host drives
// instead; it must move the caret of a live editor and clamp to the doc.

describe("resetCaret re-drives an already-mounted editor", () => {
  for (const [name, Comp] of components) {
    test(`${name}: resetCaret moves the caret after the mount-time caret latched`, () => {
      const target = document.createElement("div");
      document.body.append(target);
      const component = mount(Comp, {
        target,
        props: {
          autoFocus: false,
          path: "note.md",
          value: "abcdef",
          initialCaret: { from: 5, to: 5 },
        } as ComponentProps<typeof SourceComponent>,
      });
      mounted.push(component);
      flushSync();
      const dom =
        target.querySelector<HTMLElement>(".cm-editor") ??
        target.querySelector<HTMLElement>(".cm-content");
      const view = dom ? EditorView.findFromDOM(dom) : null;
      if (!view) throw new Error("editor view did not mount");
      // The mount-time caret latched at offset 5; the prop is now inert.
      expect(view.state.selection.main.head).toBe(5);
      const reset = (
        component as unknown as { resetCaret: (from: number, to: number) => void }
      ).resetCaret;
      reset(1, 1);
      flushSync();
      expect(view.state.selection.main.head).toBe(1);
      // A command beyond the doc clamps to its length (the large-file park
      // guard: an early command on a partially-streamed doc is a safe no-op).
      reset(999, 999);
      flushSync();
      expect(view.state.selection.main.head).toBe(6);
    });
  }
});

/// One animation frame: the editors defer their focus re-claim past it.
function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

describe("content landing in a file opened with no caret", () => {
  for (const [name, Comp] of components) {
    test(`${name}: places the caret at the start and focuses the editor after a same-tick blur`, async () => {
      const props = $state({ autoFocus: true, path: "note.md", value: "" });
      const target = document.createElement("div");
      document.body.append(target);
      mounted.push(mount(Comp, { target, props: props as ComponentProps<typeof SourceComponent> }));
      flushSync();
      const view = EditorView.findFromDOM(
        (target.querySelector<HTMLElement>(".cm-editor") ?? target.querySelector<HTMLElement>(".cm-content"))!,
      )!;
      await nextFrame();

      props.value = "first line\nsecond line";
      flushSync();
      // The open path can park focus elsewhere in the same tick.
      view.contentDOM.blur();
      expect(view.hasFocus).toBe(false);
      await nextFrame();
      expect(view.state.selection.main.head).toBe(0);
      expect(view.hasFocus, "focus re-claimed once the content landed").toBe(true);
    });
  }
});

describe("resetCaret on an editor that owns its focus", () => {
  for (const [name, Comp] of components) {
    test(`${name}: scrolls the caret into view and focuses the editor`, async () => {
      const scroll = vi.spyOn(EditorView, "scrollIntoView");
      const target = document.createElement("div");
      document.body.append(target);
      const component = mount(Comp, {
        target,
        props: { autoFocus: true, path: "note.md", value: "abcdef" } as ComponentProps<typeof SourceComponent>,
      });
      mounted.push(component);
      flushSync();
      await nextFrame();
      const view = EditorView.findFromDOM(
        (target.querySelector<HTMLElement>(".cm-editor") ?? target.querySelector<HTMLElement>(".cm-content"))!,
      )!;
      const focus = vi.spyOn(view, "focus");
      scroll.mockClear();

      (component as unknown as { resetCaret: (from: number, to: number) => void }).resetCaret(2, 4);
      flushSync();
      expect(view.state.selection.main).toMatchObject({ anchor: 2, head: 4 });
      expect(scroll).toHaveBeenCalledWith(2, { y: "nearest" });
      await nextFrame();
      expect(focus).toHaveBeenCalled();
      scroll.mockRestore();
    });
  }
});
