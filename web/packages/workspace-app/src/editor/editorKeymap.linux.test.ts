// @vitest-environment jsdom
//
// On Linux Shift-Alt-A inserts the block comment in Markdown in both editors,
// and Shift-Ctrl-A, bound only on macOS, leaves the document and the caret as
// they are, which also shows the platform took effect. Real keydown events
// through the mounted editors.

import { afterEach, describe, expect, test } from "vitest";
import { KEY_DOC, LINUX, PLAIN_END, press, setPlatform, shiftAltA, shiftCtrlA, unmountEditors } from "../__tests__/editorKeys";

setPlatform(LINUX);
afterEach(unmountEditors);

describe("on Linux", () => {
  test.each(["Wysiwyg", "Source"] as const)("%s: Shift-Alt-A inserts the block comment", async (editor) => {
    expect((await press(editor, PLAIN_END, shiftAltA)).doc).toBe(`${KEY_DOC}<!--  -->`);
  });

  test.each(["Wysiwyg", "Source"] as const)("%s: Shift-Ctrl-A does nothing", async (editor) => {
    expect(await press(editor, PLAIN_END, shiftCtrlA)).toEqual({ doc: KEY_DOC, anchor: PLAIN_END, head: PLAIN_END });
  });
});
