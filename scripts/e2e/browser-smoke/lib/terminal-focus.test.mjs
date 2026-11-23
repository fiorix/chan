import assert from "node:assert/strict";
import test from "node:test";
import { assertKeyboard, focusReports } from "./terminal-focus.mjs";

test("focus byte reader retains every report around replayed cursor replies", () => {
  assert.deepEqual(focusReports("\x1b[1;2R\x1b[I\x1b[O\x1b[24;80R"), ["\x1b[I", "\x1b[O"]);
  assert.deepEqual(focusReports("\x1b[1;1R"), []);
  for (const bytes of ["x", "\x1b[", "\x1b[0;1R", "\x1b[I\x1b[Oextra"]) {
    assert.throws(() => focusReports(bytes), /only complete/);
  }
});

const composer = () => ({
  active: { tag: "DIV", terminal: false, composer: true },
  terminal: { present: true, textareaPresent: true, containsFocus: false, hostFocused: false, textareaFocused: false, composerFocused: true },
});

test("composer guard rejects a terminal textarea steal and missing input", () => {
  assertKeyboard(composer(), "composer");
  const stolen = composer();
  stolen.active = { tag: "TEXTAREA", terminal: true, composer: false };
  stolen.terminal.textareaFocused = true;
  stolen.terminal.containsFocus = true;
  stolen.terminal.composerFocused = false;
  assert.throws(() => assertKeyboard(stolen, "composer"), /composer holds/);
  const missing = composer();
  missing.terminal.textareaPresent = false;
  assert.throws(() => assertKeyboard(missing, "composer"), /terminal and its input exist/);
});

test("terminal guard checks the actual host or textarea, not just the active tab", () => {
  const reading = composer();
  assert.throws(() => assertKeyboard(reading, "terminal"), /host or its textarea/);
  reading.active = { tag: "DIV", terminal: true, composer: false };
  reading.terminal.hostFocused = true;
  reading.terminal.containsFocus = true;
  reading.terminal.composerFocused = false;
  assertKeyboard(reading, "terminal");
  reading.active.tag = "TEXTAREA";
  reading.terminal.hostFocused = false;
  reading.terminal.textareaFocused = true;
  assertKeyboard(reading, "terminal");
  reading.terminal.textareaFocused = false;
  assert.throws(() => assertKeyboard(reading, "terminal"), /textarea focus agrees/);
});
