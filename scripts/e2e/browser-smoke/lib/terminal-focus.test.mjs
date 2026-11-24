import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertKeyboard, focusReports, runFocusCheck } from "./terminal-focus.mjs";

// A page that answers every read with the window id: enough for the harness
// to reach a body that opens no terminal.
function checkFixture(t) {
  const outDir = mkdtempSync(join(tmpdir(), "chan-focus-check-"));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  const page = { bringToFront: async () => {}, evaluate: async () => "window", on: () => {}, off: () => {} };
  return {
    ctx: { page, outDir, controlSocket: "/stub/socket", waitWindowLive: async () => {}, shot: async () => {} },
    saved: () => JSON.parse(readFileSync(join(outDir, "901-focus.json"), "utf8")),
  };
}

test("a failed leg still runs every restorer, the newest first, and fails the check", async (t) => {
  const f = checkFixture(t);
  const ran = [];
  await assert.rejects(runFocusCheck(f.ctx, 901, async ({ leg, restore }) => {
    restore("first", async () => { ran.push("first"); });
    restore("second", async () => { ran.push("second"); });
    await leg("probe", async () => assert.fail("the leg's assertion"));
    await leg("later", async () => {});
  }), (error) => {
    assert.match(error.message, /^probe \(failed\): the leg's assertion$/);
    assert.notEqual(error.smokeSkip, true);
    return true;
  });
  assert.deepEqual(ran, ["second", "first"]);
  assert.deepEqual(Object.values(f.saved().legs).map((leg) => leg.status), ["failed", "passed"]);
});

test("a body that throws still runs its restorers, and a restorer that fails is reported beside it", async (t) => {
  const f = checkFixture(t);
  const ran = [];
  await assert.rejects(runFocusCheck(f.ctx, 901, async ({ restore }) => {
    restore("first", async () => { ran.push("first"); });
    restore("second", async () => { ran.push("second"); throw new Error("not restored"); });
    throw new Error("setup stopped");
  }), { message: "setup/body: setup stopped\nsecond: not restored" });
  assert.deepEqual(ran, ["second", "first"]);
  assert.deepEqual(f.saved().failures, ["setup/body: setup stopped", "second: not restored"]);
});

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
