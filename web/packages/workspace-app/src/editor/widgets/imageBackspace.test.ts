// @vitest-environment jsdom

import { afterEach, describe, expect, test } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { chanMarkdown } from "../markdown/grammar";
import { imageCaretRedirect, imageDecorations } from "./image";

/// Mount the editor stack the way Wysiwyg.svelte does for image
/// editing: markdown language (Image nodes), the image decorations
/// (which register EditorView.atomicRanges), the caret-redirect
/// selection ring, and the default keymap (Backspace ->
/// deleteCharBackward). Returns the live view so a test can drive
/// keystrokes through the real DOM event path - the global keydown
/// listener installed by imageDecorations only sees events that
/// bubble up to `document`.
function mount(doc: string, caret: number): { view: EditorView; cleanup: () => void } {
  const target = document.createElement("div");
  document.body.append(target);
  const state = EditorState.create({
    doc,
    selection: { anchor: caret },
    extensions: [
      keymap.of(defaultKeymap),
      chanMarkdown(),
      imageDecorations({ getCurrentPath: () => null }),
      imageCaretRedirect(),
    ],
  });
  const view = new EditorView({ state, parent: target });
  return {
    view,
    cleanup: () => {
      view.destroy();
      target.remove();
    },
  };
}

/// Dispatch a real key keydown on the content DOM so it bubbles to
/// both CM6's handler and the document-level listener, matching the
/// runtime event order.
function press(view: EditorView, key: string): void {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true }),
  );
}

function pressBackspace(view: EditorView): void {
  press(view, "Backspace");
}

const IMG = "![a](b.png)"; // 11 chars: image source span [0, 11)

afterEach(() => {
  document.body.innerHTML = "";
});

describe("backspace near an inline image", () => {
  test("caret one position past the image -> deletes one char, keeps the image", () => {
    // `![a](b.png)X` with the caret after X (pos 12).
    const { view, cleanup } = mount(`${IMG}X`, IMG.length + 1);
    try {
      pressBackspace(view);
      expect(view.state.doc.toString()).toBe(IMG);
    } finally {
      cleanup();
    }
  });

  test("caret two positions past the image -> deletes one char, keeps the image", () => {
    // `![a](b.png)Xy` with the caret after y (pos 13). Deletes y.
    const { view, cleanup } = mount(`${IMG}Xy`, IMG.length + 2);
    try {
      pressBackspace(view);
      expect(view.state.doc.toString()).toBe(`${IMG}X`);
    } finally {
      cleanup();
    }
  });

  test("ring set by a click while caret is past the image -> backspace still deletes a char, not the image", () => {
    // Clicking the image lights the selection ring WITHOUT moving the
    // caret, so a later Backspace (caret one past) must delete one
    // character and leave the image.
    const { view, cleanup } = mount(`${IMG}X`, IMG.length + 1);
    try {
      const wrap = view.dom.querySelector(
        ".cm-md-image-wrap",
      ) as HTMLElement | null;
      expect(wrap).not.toBeNull();
      wrap!.dataset.selected = "true";
      pressBackspace(view);
      expect(view.state.doc.toString()).toBe(IMG);
    } finally {
      cleanup();
    }
  });

  test("caret AT the trailing edge -> backspace deletes the whole image (kept)", () => {
    // `![a](b.png)X` with the caret right after the image (pos 11).
    const { view, cleanup } = mount(`${IMG}X`, IMG.length);
    try {
      pressBackspace(view);
      expect(view.state.doc.toString()).toBe("X");
    } finally {
      cleanup();
    }
  });

  test("caret AT the leading edge -> Delete (forward) deletes the whole image (kept)", () => {
    // `X![a](b.png)` with the caret right before the image (pos 1).
    const { view, cleanup } = mount(`X${IMG}`, 1);
    try {
      press(view, "Delete");
      expect(view.state.doc.toString()).toBe("X");
    } finally {
      cleanup();
    }
  });

  test("backspace AT the leading edge edits the preceding char, not the image (directional)", () => {
    // `X![a](b.png)` with the caret right before the image (pos 1).
    // Backspace deletes content BEFORE the caret -> the X, not the
    // image that sits after the caret.
    const { view, cleanup } = mount(`X${IMG}`, 1);
    try {
      pressBackspace(view);
      expect(view.state.doc.toString()).toBe(IMG);
    } finally {
      cleanup();
    }
  });
});

describe("arrow-key navigation stays atomic across an image", () => {
  test("ArrowRight from before the image jumps to the far side in one step", () => {
    const { view, cleanup } = mount(`${IMG}X`, 0);
    try {
      view.dispatch({ selection: EditorSelection.cursor(0) });
      // Emulate the atomic motion the default keymap performs.
      const moved = view.moveByChar(view.state.selection.main, true);
      expect(moved.head).toBe(IMG.length);
    } finally {
      cleanup();
    }
  });
});
