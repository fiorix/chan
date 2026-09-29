// @vitest-environment jsdom
//
// A task checkbox shows the source's `[ ]` or `[x]` and nothing else. Its
// mousedown handler is the one way it toggles, so a click that reaches the
// native box another way (Space on a focused box is a click with detail 0)
// must not flip the box while the source stays as it was.

import { afterEach, describe, expect, test } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { chanMarkdown } from "../markdown/grammar";
import { chanDecorations } from "../decorations";

const DOC = "- [ ] task";
let view: EditorView | undefined;
let host: HTMLDivElement | undefined;

function mount(lock: Extension[] = []): HTMLInputElement {
  host = document.createElement("div");
  document.body.append(host);
  view = new EditorView({
    parent: host,
    state: EditorState.create({ doc: DOC, extensions: [chanMarkdown(), chanDecorations(), ...lock] }),
  });
  const box = view.dom.querySelector<HTMLInputElement>(".cm-md-task-checkbox");
  expect(box).toBeTruthy();
  return box!;
}

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = undefined;
  host = undefined;
});

describe("a task checkbox", () => {
  test("is out of the tab order", () => {
    expect(mount().tabIndex).toBe(-1);
  });

  test.each([
    ["an editable document", []],
    ["a read-mode document", [EditorView.editable.of(false)]],
  ] as const)("a click that is not its mousedown flips neither the box nor the source (%s)", (_label, lock) => {
    const box = mount([...lock]);
    box.click();
    expect({ checked: box.checked, doc: view!.state.doc.toString() }).toEqual({ checked: false, doc: DOC });
  });
});
