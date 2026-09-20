// @vitest-environment jsdom
//
// A task checkbox must not write into a view the user cannot edit.
//
// Read-only has two spellings in this editor and a widget has to answer
// both: `Wysiwyg.svelte` locks with `EditorView.editable`, while
// `RichPrompt.svelte` locks its composer with `EditorState.readOnly` and
// keeps `editable` true. Each mount below wires the real value sync the
// way `Wysiwyg.svelte` does, so a write that reaches the document also
// shows up as the autosave the user never asked for.

import { afterEach, describe, expect, test } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { chanMarkdown } from "../markdown/grammar";
import { chanDecorations } from "../decorations";
import { createValueSync } from "../base";

const DOC = "- [ ] task";

let view: EditorView | undefined;
let host: HTMLDivElement | undefined;

/// A decorated editor over `DOC` with the lock extensions applied, plus the
/// value-sync listener Wysiwyg registers. `writes` collects what would be
/// handed to the autosave.
function mount(lock: Extension[]): { writes: string[] } {
  host = document.createElement("div");
  document.body.append(host);
  const writes: string[] = [];
  const sync = createValueSync();
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: DOC,
      extensions: [
        chanMarkdown(),
        chanDecorations(),
        EditorView.updateListener.of((u) => {
          sync.onDocChanged(u, (s) => writes.push(s));
        }),
        ...lock,
      ],
    }),
  });
  return { writes };
}

/// The user's click: the widget toggles from its own mousedown handler,
/// because it preventDefaults the native change event.
function clickCheckbox(): void {
  const box = view!.dom.querySelector(".cm-md-task-checkbox");
  expect(box).toBeTruthy();
  box!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
}

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = undefined;
  host = undefined;
});

describe("a checkbox click in a view the user cannot edit", () => {
  test("a read-mode document (editable off) is not written", () => {
    const { writes } = mount([EditorView.editable.of(false)]);
    clickCheckbox();
    expect(view!.state.doc.toString()).toBe(DOC);
    expect(writes).toEqual([]);
  });

  test("a locked composer (state readOnly, editable on) is not written", () => {
    const { writes } = mount([
      EditorState.readOnly.of(true),
      EditorView.editable.of(true),
    ]);
    clickCheckbox();
    expect(view!.state.doc.toString()).toBe(DOC);
    expect(writes).toEqual([]);
  });

  test("an editable document still toggles and reports one write", () => {
    const { writes } = mount([]);
    clickCheckbox();
    expect(view!.state.doc.toString()).toBe("- [x] task");
    expect(writes).toEqual(["- [x] task"]);
  });
});
