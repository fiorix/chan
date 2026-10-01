// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { chanMarkdown } from "../markdown/grammar";
import {
  imageCaretRedirect,
  imageDecorations,
  selectedImageMarkdown,
} from "./image";

// Mount the image editing stack (markdown Image nodes + the atom
// decorations + the selection-ring redirect) the way Wysiwyg does, and
// return the live view. The Cmd+C handler is a document-level listener
// that imageDecorations installs on render, so events must bubble to
// `document`.
function mount(
  doc: string,
  caret: number,
): { view: EditorView; cleanup: () => void } {
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

const IMG = "![a](b.png)";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("editor image copy writes the underlying markdown", () => {
  test("selectedImageMarkdown returns the source of the ring-selected image", () => {
    const { view, cleanup } = mount(IMG, 0);
    const wrap = view.dom.querySelector<HTMLElement>(".cm-md-image-wrap");
    expect(wrap).not.toBeNull();
    wrap!.dataset.selected = "true";
    expect(selectedImageMarkdown(view)).toBe(IMG);
    cleanup();
  });

  test("selectedImageMarkdown is null with no image ring selected", () => {
    const { view, cleanup } = mount(IMG, 0);
    expect(selectedImageMarkdown(view)).toBeNull();
    cleanup();
  });

  test("Cmd+C on a selected image copies its markdown, not pixels", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const { view, cleanup } = mount(IMG, 0);
    const wrap = view.dom.querySelector<HTMLElement>(".cm-md-image-wrap");
    wrap!.dataset.selected = "true";
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true }),
    );
    expect(writeText).toHaveBeenCalledWith(IMG);
    cleanup();
  });

  test("two failed button copies restore the image button title", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const { view, cleanup } = mount(IMG, 0);
    const button = view.dom.querySelector<HTMLButtonElement>(".cm-md-image-copy");
    expect(button).not.toBeNull();
    vi.useFakeTimers();
    try {
      button!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      await vi.advanceTimersByTimeAsync(300);
      button!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      await vi.advanceTimersByTimeAsync(2500);
      expect(writeText).toHaveBeenCalledTimes(2);
      expect(button!.title).toBe("copy image to clipboard");
    } finally {
      vi.useRealTimers();
      cleanup();
    }
  });
});
