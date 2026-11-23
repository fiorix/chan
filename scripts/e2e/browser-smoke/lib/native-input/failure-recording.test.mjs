import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { CASES } from "./cases.mjs";
import { FIELDS, INSTALL_SRC, READ_SRC } from "./page.mjs";
import { validateCaseFile } from "./schema.mjs";

// Run each driver's verdict and persistence block with a measured snapshot.
// No browser, inspector, child process or PTY is started by these controls.
for (const [engine, relative] of [
  ["chrome", "../../checks/343-native-input-record.mjs"],
  ["webkit", "../../../desktop-observations/native-input-record.mjs"],
]) {
  for (const [missing, focused] of [[true, true], [false, true], [false, false]]) {
    test(`${engine} retains the snapshot with keyup ${missing ? "missing" : "present"} and pane-tree focus ${focused}`, async (t) => {
      const outDir = mkdtempSync(join(tmpdir(), "native-failure-control-"));
      t.after(() => rmSync(outDir, { recursive: true, force: true }));
      const source = readFileSync(new URL(relative, import.meta.url), "utf8");
      const start = source.indexOf("const types = new Set(snap.events.map");
      const last = "summary.cases[c.id] = verdict.status;";
      const end = source.indexOf(last, start);
      assert.ok(start >= 0 && end > start, "the driver's complete verdict/persistence block is available");
      const c = CASES.find((entry) => entry.id === "ctrl-shift-a");
      const event = (type) => ({
        ...Object.fromEntries(FIELDS.map((field) => [field, null])),
        type, t: 1, key: "A", code: "KeyA", keyCode: 65, location: 0,
        ctrlKey: true, shiftKey: true, altKey: false, metaKey: false,
        isTrusted: true, defaultPrevented: false, gotThrough: true, target: "textarea",
      });
      const snap = { events: [event("keydown"), ...(missing ? [] : [event("keyup")])],
        bytes: [], focused: { tag: "INPUT", inHost: false }, paneTreeFocused: focused, textareaPresent: true, terms: 1 };
      const summary = { engine, engineVersion: "control", worktreeSha: "a".repeat(40), cases: {} };
      const failures = [];
      await vm.runInNewContext(`(async () => { for (const c of cases) {
        ${source.slice(start, end + last.length)}
      } })()`, {
        cases: [c], snap, summary, unavailable: null,
        ptyBytes: "", drained: { reply: "\x1b[1;1R" }, programSetup: { input: "", reply: "\x1b[1;1R" }, offset: 0,
        recorderId: "host-control", process: { platform: "linux", arch: "x64" }, guestLayout: async () => "us",
        validateCaseFile, writeFileSync, join, outDir, a: { out: outDir },
        fail(reason, kind) {
          failures.push({ reason, kind });
          summary.cases[c.id] = "failed";
          writeFileSync(join(outDir, `${c.id}.error.txt`), reason + "\n");
        },
      });
      const fixture = JSON.parse(readFileSync(join(outDir, `${c.id}.json`), "utf8"));
      assert.deepEqual(fixture.domEvents, snap.events, "failure evidence retains fields and ordering");
      assert.deepEqual(fixture.observed, { widget: "", pty: "" });
      assert.deepEqual(validateCaseFile(fixture), []);
      const reason = missing ? "missing DOM event types: keyup" : !focused ? "the pane tree filter did not take focus" : "";
      assert.equal(summary.cases[c.id], reason ? "failed" : "ok");
      assert.equal(fixture.verdict.status, summary.cases[c.id]);
      assert.deepEqual(failures, reason ? [{ reason, kind: "property" }] : []);
      if (reason) {
        assert.equal(fixture.verdict.reason, reason);
        assert.equal(readFileSync(join(outDir, `${c.id}.error.txt`), "utf8"), fixture.verdict.reason + "\n");
      }
    });
  }
}

test("the recorder follows a chord's keyup into the pane tree without recording unrelated input", async () => {
  const listeners = { capture: new Map(), bubble: new Map() };
  const window = {
    addEventListener(type, listener, capture) {
      const map = capture ? listeners.capture : listeners.bubble;
      map.set(type, [...(map.get(type) ?? []), listener]);
    },
    removeEventListener() {},
  };
  const node = (tagName, names) => ({ tagName, classList: { contains: (name) => names.includes(name) } });
  const host = node("DIV", ["terminal-host"]);
  const textarea = node("TEXTAREA", []);
  const tree = node("DIV", ["pane-tree"]);
  const input = { ...node("INPUT", []), getAttribute: () => "Filter tabs", closest: (selector) => selector === ".pane-tree" ? tree : null };
  const document = { activeElement: input, querySelector: () => textarea };
  const context = vm.createContext({ window, document, queueMicrotask, performance: { now: () => 1 } });
  vm.runInContext(INSTALL_SRC, context);
  const dispatch = (type, path) => {
    const event = { type, key: "A", code: "KeyA", isTrusted: true, defaultPrevented: false, composedPath: () => path };
    for (const listener of listeners.capture.get(type) ?? []) listener(event);
    for (const listener of listeners.bubble.get(type) ?? []) listener(event);
  };
  dispatch("keydown", [textarea, host, window]);
  dispatch("keyup", [input, tree, window]);
  dispatch("keyup", [node("INPUT", []), window]);
  await Promise.resolve();
  const snapshot = JSON.parse(JSON.stringify(vm.runInContext(READ_SRC, context)));
  assert.deepEqual(snapshot.events.map(({ type, target, defaultPrevented, gotThrough }) => ({ type, target, defaultPrevented, gotThrough })), [
    { type: "keydown", target: "textarea", defaultPrevented: false, gotThrough: true },
    { type: "keyup", target: "pane-tree", defaultPrevented: false, gotThrough: true },
  ]);
  assert.equal(snapshot.paneTreeFocused, true);
  document.activeElement = { ...input, closest: () => null };
  assert.equal(vm.runInContext(READ_SRC, context).paneTreeFocused, false);
  const chord = CASES.find((entry) => entry.id === "ctrl-shift-a");
  assert.equal(chord.expect.paneTreeFocused, true, "the case requires the app chord's visible effect");
});
