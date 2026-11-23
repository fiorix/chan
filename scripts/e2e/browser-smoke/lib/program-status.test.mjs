import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseProgramCell, ringProgress, statusPrintf, statusPrintfBel, statusPrintfRaw, withProgramStatusBackend, withProgramStatusTabs } from "./program-status.mjs";

const oldList = `## default\n\n| name | session | status | queue |\n| --- | --- | --- | --- |\n| other | s0 | alive | 0 |\n| subject | s1 | alive | 0 |\n`;
const newList = `## default\n\n| name | session | status | program | queue |\n| --- | --- | --- | --- | --- |\n| other | s0 | alive | idle | 0 |\n| subject | s1 | alive | working 40% | 0 |\n`;

test("the list reader selects the named session and distinguishes an absent column", () => {
  assert.equal(parseProgramCell(newList, "s1"), "working 40%");
  assert.equal(parseProgramCell(oldList, "s1"), null);
  assert.throws(() => parseProgramCell(newList, "missing"), /session missing absent/);
});

test("the report driver emits the specification's OSC bytes, not an emitter's output", () => {
  const command = statusPrintf("state=working:progress=40");
  assert.deepEqual(execFileSync("bash", ["-c", command]),
    Buffer.from("\x1b]7501;state=working:progress=40\x1b\\"));
  const body = "state=blocked:id=a/b:app=app+v.1:title=QSxiLytfLQ==:msg=YSxiLytfLQ==";
  assert.deepEqual(execFileSync("bash", ["-c", statusPrintf(body)]), Buffer.from(`\x1b]7501;${body}\x1b\\`));
  assert.deepEqual(execFileSync("bash", ["-c", statusPrintfBel(body)]), Buffer.from(`\x1b]7501;${body}\x07`));
  assert.deepEqual(execFileSync("bash", ["-c", statusPrintfRaw("\\033]7501;state=working\\033\\\\")]),
    Buffer.from("\x1b]7501;state=working\x1b\\"));
  assert.deepEqual(execFileSync("bash", ["-c", statusPrintfRaw("\\033]7501;state=done\\033[0m")]),
    Buffer.from("\x1b]7501;state=done\x1b[0m"));
  assert.deepEqual(execFileSync("bash", ["-c", statusPrintfRaw("\\033]7501;state=working")]),
    Buffer.from("\x1b]7501;state=working"));
  assert.deepEqual(execFileSync("bash", ["-c", statusPrintfRaw("\\033\\\\")]), Buffer.from("\x1b\\"));
  assert.deepEqual(execFileSync("bash", ["-c", statusPrintfRaw("\\033]7501;state=working\\030\\033c\\377")]),
    Buffer.concat([Buffer.from("\x1b]7501;state=working\x18\x1bc"), Buffer.from([0xff])]));
  assert.throws(() => statusPrintf("state=working'`"), /fixed specification body/);
  assert.throws(() => statusPrintf("state=working%sn"), /fixed specification body/);
  assert.throws(() => statusPrintfRaw("\\033'`"), /fixed raw printf format/);
});

test("the ring reader uses the drawn stroke and not its label", () => {
  assert.equal(ringProgress({ activity: "ring", pathLength: "100", ring: "40 100", activityLabel: "working, 99%" }), 40);
  assert.equal(ringProgress({ activity: "spinner", pathLength: "100", ring: "40 100" }), null);
  assert.equal(ringProgress({ activity: "ring", pathLength: "99", ring: "40 100" }), null);
});

for (const backend of ["xterm", "unknown", false, true, undefined, null, ["xterm", "ghostty"]]) {
  test(`program-status refuses ${JSON.stringify(backend)} before reading its context`, () => {
    const reads = [];
    const ctx = { get controlSocket() { reads.push("controlSocket"); return null; } };
    assert.throws(() => {
      const result = withProgramStatusBackend(ctx, "test", backend, () => assert.fail("callback must not run"));
      result?.catch(() => {});
    }, /retired or unsupported terminal backend/);
    assert.deepEqual(reads, [], "no page read, config write or terminal spawn can precede refusal");
  });
}

test("the program-status facade opens exactly one Ghostty subject/front pair", async (t) => {
  const chanHome = mkdtempSync(join(tmpdir(), "chan-status-helper-"));
  t.after(() => rmSync(chanHome, { recursive: true, force: true }));
  writeFileSync(join(chanHome, "server.toml"), "[terminal]\nprogram_status = true\nmouse_capture = true\n");
  const preferences = { ghostty: true, program_status: true, mouse_capture: true };
  const commands = [], rows = [], patches = [];
  let requestListener, refreshed;
  const page = {
    url: async () => "http://test.invalid/?w=window",
    evaluateOnNewDocument: async () => {}, reload: async () => {}, waitForSelector: async () => {},
    waitForFunction: async () => {},
    on: (_event, listener) => { requestListener = listener; }, off: () => {},
    waitForResponse: (accept) => new Promise((resolve, reject) => { refreshed = async (response) => {
      try { if (await accept(response)) resolve(response); } catch (error) { reject(error); }
    }; }),
    evaluate: async (_fn, arg) => {
      if (arg === "") return { ...preferences };
      if (arg?.patch) {
        patches.push(arg.patch);
        const patch = { url: () => "http://test.invalid/api/config", method: () => "PATCH" };
        const workspace = { url: () => "http://test.invalid/api/workspace", method: () => "GET" };
        requestListener(patch);
        requestListener(workspace);
        await refreshed({ request: () => workspace, ok: () => true, json: async () => ({ preferences: { terminal: preferences } }) });
      }
      if (typeof arg === "string" && arg.startsWith(".pane")) return true;
    },
    $$: async () => rows.map((row) => ({ $eval: async () => row.name, click: async () => {} })),
  };
  const ctx = {
    page, chanHome, controlSocket: "inert", chanBin: "inert", workspaceDir: chanHome,
    serverUrl: "http://test.invalid", waitWindowLive: async () => {}, shot: async () => {},
    exec: async (_bin, argv) => {
      commands.push(argv);
      if (argv[1] === "terminal" && argv[2] === "new") {
        const name = argv[4];
        rows.push({ name, window: "window", window_status: "alive", pane: "pane", tab: name, session_id: `session-${name}` });
      }
      return { stdout: JSON.stringify({ groups: { Default: rows } }) };
    },
  };
  let calls = 0;
  await withProgramStatusTabs(ctx, "test", async (tab) => {
    calls++;
    assert.equal(tab.backend, "ghostty");
    assert.equal(tab.subject, "StatustestghosttyS");
    assert.equal(tab.front, "StatustestghosttyF");
    assert.notEqual(tab.subjectRow.session_id, tab.frontRow.session_id);
  });
  assert.equal(calls, 1);
  assert.deepEqual(patches, [{ program_status: true }]);
  assert.deepEqual(commands.filter((argv) => argv[2] === "new").map((argv) => argv[4]),
    ["StatustestghosttyS", "StatustestghosttyF"]);
  assert.equal(commands.filter((argv) => argv[2] === "close-tab").length, 2);
});
