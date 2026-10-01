// @vitest-environment jsdom

import { afterEach, describe, expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";

/// Mounts a minimal CM6 editor with the markdown language seeded
/// the same way Source.svelte's source mode does. Runs Enter at
/// the given caret position and returns the resulting doc.
function runEnterAt(seed: string, caret: number, addKeymap: boolean): string {
  const target = document.createElement("div");
  document.body.append(target);
  try {
    const state = EditorState.create({
      doc: seed,
      selection: { anchor: caret },
      extensions: [
        keymap.of(defaultKeymap),
        markdown({ addKeymap }),
      ],
    });
    const view = new EditorView({ state, parent: target });
    try {
      const evt = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
      view.contentDOM.dispatchEvent(evt);
      return view.state.doc.toString();
    } finally {
      view.destroy();
    }
  } finally {
    target.remove();
  }
}

/// Mounts the same minimal source-mode editor, then types `text`
/// one character at a time through the `input.type` user-event path
/// (the path CM6 routes real keystrokes through, and the only path a
/// markdown input rule could hook via `EditorView.inputHandler`).
/// Returns the resulting doc. This exercises the TYPING side of the
/// source-mode contract: typing a list marker (`* `, `- `, `1. `)
/// must stay raw text, never transform into list mode.
function typeInto(seed: string, caret: number, text: string, addKeymap: boolean): string {
  const target = document.createElement("div");
  document.body.append(target);
  try {
    const state = EditorState.create({
      doc: seed,
      selection: { anchor: caret },
      extensions: [
        keymap.of(defaultKeymap),
        markdown({ addKeymap }),
      ],
    });
    const view = new EditorView({ state, parent: target });
    try {
      for (const ch of text) {
        const head = view.state.selection.main.head;
        view.dispatch(
          view.state.update({
            changes: { from: head, insert: ch },
            selection: { anchor: head + ch.length },
            userEvent: "input.type",
          }),
        );
      }
      return view.state.doc.toString();
    } finally {
      view.destroy();
    }
  } finally {
    target.remove();
  }
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("source-mode markdown extension", () => {
  test("with addKeymap=true (default), Enter after `1. ` auto-continues to `2. `", () => {
    // Positive control: with the markdown keymap on, this harness's
    // Enter continues the list, so the plain newline in the
    // addKeymap=false cases below comes from the flag and not from a
    // harness that cannot continue one.
    const seed = "1. item";
    const after = runEnterAt(seed, seed.length, true);
    // Default markdownKeymap should insert "\n2. " after the
    // existing item.
    expect(after).toBe("1. item\n2. ");
  });

  test("with addKeymap=false, Enter after `1. ` just inserts a newline (raw editing)", () => {
    const seed = "1. item";
    const after = runEnterAt(seed, seed.length, false);
    expect(after).toBe("1. item\n");
  });

  test("with addKeymap=false, Enter after `- ` does not auto-continue a bullet", () => {
    const seed = "- item";
    const after = runEnterAt(seed, seed.length, false);
    expect(after).toBe("- item\n");
  });

  test("with addKeymap=false, Enter after `* ` does not auto-continue a star bullet", () => {
    const seed = "* item";
    const after = runEnterAt(seed, seed.length, false);
    expect(after).toBe("* item\n");
  });

  test("with addKeymap=false, Enter after `1) ` does not auto-continue the alternate ordered marker", () => {
    const seed = "1) item";
    const after = runEnterAt(seed, seed.length, false);
    expect(after).toBe("1) item\n");
  });
});

// Typing a list marker in source mode must not trigger any markdown
// list transform. Source.svelte seeds the language with
// `addKeymap: false`, so typing `* `, `- `, `1. ` at line start
// leaves the literal text in the buffer. These pin the TYPING path
// (the existing block pins Enter).
describe("source-mode list-marker typing", () => {
  test("typing `* ` at line start stays raw, no bullet transform", () => {
    // Caret on a fresh blank line; type the marker plus content.
    const after = typeInto("a\n", 2, "* hello", false);
    expect(after).toBe("a\n* hello");
  });

  test("typing `- ` at line start stays raw, no bullet transform", () => {
    const after = typeInto("a\n", 2, "- hello", false);
    expect(after).toBe("a\n- hello");
  });

  test("typing `1. ` at line start stays raw, no ordered-list transform", () => {
    const after = typeInto("a\n", 2, "1. hello", false);
    expect(after).toBe("a\n1. hello");
  });

  test("typing the marker into an empty doc stays raw", () => {
    const after = typeInto("", 0, "* x", false);
    expect(after).toBe("* x");
  });
});
