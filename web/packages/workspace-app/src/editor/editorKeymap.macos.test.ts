// @vitest-environment jsdom
//
// On macOS Shift-Ctrl-A selects in both editors and inserts no block
// comment: on a list item to the item's text start in Wysiwyg (the list-prefix
// keymap), else to the line start (CodeMirror's emacs-style macOS keys, which
// exist on no other platform, so a selection here also shows the platform
// took effect). Real keydown events through the mounted editors.

import { afterEach, describe, expect, test } from "vitest";
import {
  ITEM_END, ITEM_LINE_START, ITEM_TEXT_START, KEY_DOC, MAC, PLAIN_END, PLAIN_LINE_START,
  press, setPlatform, shiftCtrlA, unmountEditors,
} from "../__tests__/editorKeys";

setPlatform(MAC);
afterEach(unmountEditors);

describe("on macOS Shift-Ctrl-A selects and inserts no block comment", () => {
  test("Wysiwyg, a list item: to the item's text start", async () => {
    expect(await press("Wysiwyg", ITEM_END, shiftCtrlA)).toEqual({ doc: KEY_DOC, anchor: ITEM_END, head: ITEM_TEXT_START });
  });

  test("Wysiwyg, a plain line: to the line start", async () => {
    expect(await press("Wysiwyg", PLAIN_END, shiftCtrlA)).toEqual({ doc: KEY_DOC, anchor: PLAIN_END, head: PLAIN_LINE_START });
  });

  test.each([
    ["a list item", ITEM_END, ITEM_LINE_START],
    ["a plain line", PLAIN_END, PLAIN_LINE_START],
  ])("Source, %s: to the line start", async (_label, at, start) => {
    expect(await press("Source", at, shiftCtrlA)).toEqual({ doc: KEY_DOC, anchor: at, head: start });
  });
});
