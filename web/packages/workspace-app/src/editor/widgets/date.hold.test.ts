// @vitest-environment jsdom
//
// The date pill reads the editor's reveal selection: a press CodeMirror
// handles that places its caret inside the date keeps the pill drawn while
// the button is held, and the date's source shows at the release. The pill's
// own press opens its picker and places no caret, so the press here is the
// one CodeMirror makes: the hold's start, then the pointer selection.

import { afterEach, expect, test } from "vitest";
import { mouseUp } from "../../__tests__/pointer";
import { installEditorDom, mountWysiwyg, settle, unmountWysiwygs } from "../../__tests__/wysiwyg";
import { startHold } from "../decorations/selection";

installEditorDom();

afterEach(() => {
  unmountWysiwygs();
  document.body.innerHTML = "";
});

const DOC = "due 2026-08-11 soon";

test("keeps the pill drawn through a held pointer selection inside the date and shows the date at the release", async () => {
  const { view, content } = await mountWysiwyg({ value: DOC, currentPath: "note.md" });
  view.dispatch({ selection: { anchor: 0 } });
  await settle();
  const pill = content.querySelector(".cm-md-date-pill");
  expect(pill, "the date renders as a pill").not.toBeNull();

  view.dispatch({ effects: startHold.of({ reveal: view.state.selection, scroll: false }) });
  view.dispatch({ selection: { anchor: DOC.indexOf("08") }, userEvent: "select.pointer" });

  expect(content.querySelector(".cm-md-date-pill")).toBe(pill);

  mouseUp();

  expect(content.querySelector(".cm-md-date-pill")).toBeNull();
  expect(content.textContent).toContain("2026-08-11");
});
