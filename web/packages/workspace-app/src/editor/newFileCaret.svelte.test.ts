// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type ComponentProps, flushSync, mount, unmount } from "svelte";
import { EditorView } from "@codemirror/view";
import SourceComponent from "./Source.svelte";
import WysiwygComponent from "./Wysiwyg.svelte";
import source from "./Source.svelte?raw";
import wysiwyg from "./Wysiwyg.svelte?raw";

// A file opened without an explicit caret (File Browser double-click,
// `cs open <file>`) must still land with a usable, focused caret -- not
// stay unfocused until the user clicks in. The Draft path (Cmd+N) works
// because it passes initialSelection; plain opens omit it. The fix lives
// in each editor's maybeRestoreCaret(): treat an absent caret as document
// start (0,0) and re-claim focus once content lands, instead of bailing.
//
// But that re-claim must run ONLY when external content actually lands, not
// on the keystroke echo that writes `value` back from the live doc: a new
// empty file goes empty -> non-empty on the FIRST keystroke, and re-running
// maybeRestoreCaret there resets the caret to 0 so "Hello" lands as "elloH".

const rawEditors: Array<[string, string]> = [
  ["Source.svelte", source],
  ["Wysiwyg.svelte", wysiwyg],
];

describe("new-file caret + focus (no persisted caret)", () => {
  for (const [name, src] of rawEditors) {
    test(`${name}: maybeRestoreCaret no longer bails when no caret is supplied`, () => {
      // The early-return guard must NOT include the !caretPending bail --
      // that is what skipped caret placement + the focus re-claim for
      // plain opens.
      expect(src).not.toMatch(
        /function maybeRestoreCaret\(\): void \{\s*if \([^)]*!caretPending[^)]*\) return;/,
      );
      expect(src).toMatch(
        /function maybeRestoreCaret\(\): void \{\s*if \(caretRestored \|\| !view\) return;/,
      );
    });

    test(`${name}: absent caret defaults to document start (0,0)`, () => {
      expect(src).toMatch(
        /const target = caretPending \?\? \{ from: 0, to: 0 \};/,
      );
    });

    test(`${name}: re-claims focus after placing the caret`, () => {
      // The dispatch + caretRestored + deferred focus must all sit inside
      // maybeRestoreCaret so the content-land path focuses regardless of
      // whether a caret was supplied.
      expect(src).toMatch(
        /function maybeRestoreCaret\(\): void \{[\s\S]*?caretRestored = true;[\s\S]*?requestAnimationFrame\(\(\) => \{[\s\S]*?view\.focus\(\);/,
      );
    });

    test(`${name}: value $effect only restores the caret on a real content change`, () => {
      // Gating maybeRestoreCaret on the doc actually changing across
      // applyExternal is what stops the first-keystroke reorder: a keystroke
      // echo is a no-op apply (doc unchanged), so the caret is left alone.
      expect(src).toMatch(
        /const before = view\?\.state\.doc\.toString\(\);[\s\S]*?sync\.applyExternal\(view, value\);[\s\S]*?if \(view && before !== view\.state\.doc\.toString\(\)\) maybeRestoreCaret\(\);/,
      );
    });
  }
});

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

describe("resetCaret export shape", () => {
  for (const [name, src] of rawEditors) {
    test(`${name}: exports resetCaret with selection + scrollIntoView + focus`, () => {
      expect(src).toMatch(
        /export function resetCaret\(from: number, to: number\): void \{[\s\S]*?selection: \{ anchor: f, head: t \},[\s\S]*?EditorView\.scrollIntoView\(f, \{ y: "nearest" \}\),[\s\S]*?view\.focus\(\);/,
      );
    });

    test(`${name}: resetCaret is NOT gated by the caretRestored latch`, () => {
      // It is the LIVE re-drive; a caretRestored guard would defeat the fix.
      expect(src).not.toMatch(
        /export function resetCaret\([^)]*\): void \{\s*if \([^)]*caretRestored/,
      );
    });
  }
});
