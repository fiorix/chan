// @vitest-environment jsdom
//
// The image reads the editor's reveal selection: a press CodeMirror handles
// that places its caret inside an image's source keeps the image drawn, with
// no edit preview, while the button is held, and enters edit mode at the
// release. The image's own press lights its ring and places no caret, so the
// press here is the one CodeMirror makes: the hold's start, then the pointer
// selection.

import { afterEach, expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forceParsing } from "@codemirror/language";
import { mouseUp } from "../../__tests__/pointer";
import { clickToPlaceCaret } from "../click_caret";
import { startHold } from "../decorations/selection";
import { chanMarkdown } from "../markdown/grammar";
import { imageDecorations } from "./image";

const DOC = "before\n\n![a](b.png)\n\nafter";
const IN_SOURCE = DOC.indexOf("b.png") + 1;

afterEach(() => {
  document.body.innerHTML = "";
});

test("keeps the image drawn without its edit preview through a held pointer selection and enters edit mode at the release", () => {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: DOC,
      selection: { anchor: 0 },
      extensions: [chanMarkdown(), imageDecorations({ getCurrentPath: () => null }), clickToPlaceCaret()],
    }),
  });
  forceParsing(view, view.state.doc.length, 5000);
  const inline = () => parent.querySelector('.cm-md-image-wrap:not([data-editing="true"])');
  const preview = () => parent.querySelector('.cm-md-image-wrap[data-editing="true"]');
  expect(inline(), "the image renders inline").not.toBeNull();

  view.dispatch({ effects: startHold.of({ reveal: view.state.selection, scroll: false }) });
  view.dispatch({ selection: { anchor: IN_SOURCE }, userEvent: "select.pointer" });

  expect(inline()).not.toBeNull();
  expect(preview()).toBeNull();

  mouseUp();

  expect(inline()).toBeNull();
  expect(preview()).not.toBeNull();
  expect(parent.textContent).toContain("![a](b.png)");
  view.destroy();
});
