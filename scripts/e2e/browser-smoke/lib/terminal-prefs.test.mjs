import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openAttachedTerminal } from "./terminal-attach.mjs";
import { assertTerminalPrefs, openLegacyConfiguredTerminal, restoreTerminalPrefs, writeTerminalPrefs } from "./terminal-prefs.mjs";

for (const ghostty of [true, false, undefined, null]) {
  test(`ordinary writes refuse an explicit retired key ${ghostty} before reads`, () => {
    const page = { on: () => assert.fail("no listeners or reads before refusal") };
    assert.throws(() => writeTerminalPrefs(page, "", { ghostty }), /retired terminal preference ghostty/);
  });
}

for (const ghostty of ["false", 0, null]) {
  test(`legacy writes refuse non-boolean ${JSON.stringify(ghostty)} before reads`, () => {
    assert.throws(() => openLegacyConfiguredTerminal({}, {}, () => assert.fail("no spawn"), "w", "n", ghostty),
      /must be a boolean/);
  });
}

function legacyFixture(t, { echo = false, surface = true, status = 200 } = {}) {
  const requests = [], commands = [];
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, ...options });
    if (options.method === "PATCH") return new Response(null, { status });
    const terminal = { mouse_capture: true };
    if (echo || reads++ === 0) terminal.ghostty = false;
    return Response.json({ revision: 3, preferences: { terminal } });
  });
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else delete globalThis.document;
  });
  globalThis.document = {
    querySelector: (selector) => surface && selector.endsWith(".terminal-host > canvas")
      ? { getBoundingClientRect: () => ({ width: 800, height: 600 }) } : null,
    querySelectorAll: () => [],
  };
  let clockReads = 0;
  t.mock.method(Date, "now", () => clockReads++ === 0 ? 0 : 60_001);
  const row = { name: "legacy", pane: "pane", tab: "tab", session_id: "session", window: "w", window_status: "alive" };
  return {
    requests, commands, row,
    ctx: { serverUrl: "http://test.invalid/?t=token", shot: async () => {} },
    page: { evaluate: async (fn, arg) => fn(arg) },
    cs: async (args) => { commands.push(args); return { stdout: JSON.stringify({ groups: { Default: [row] } }) }; },
  };
}

for (const ghostty of [undefined, true, false]) {
  test(`legacy ${ghostty} is accepted, absent from readback, and opens Ghostty`, async (t) => {
    const f = legacyFixture(t);
    assert.deepEqual(await openLegacyConfiguredTerminal(f.ctx, f.page, f.cs, "w", "legacy", ghostty), f.row);
    assert.equal(f.requests.length, 3);
    assert.equal(JSON.parse(f.requests[1].body).preferences.terminal.ghostty, ghostty);
    assert.equal(Object.hasOwn(JSON.parse(f.requests[1].body).preferences.terminal, "ghostty"), ghostty !== undefined);
    assert.equal(JSON.parse(f.requests[1].body).preferences.terminal.mouse_capture, true);
    assert.equal(JSON.parse(f.requests[1].body).expected_revision, 3);
    assert.deepEqual(f.commands, [["new", "--tab-name", "legacy"], ["list", "--json"]]);
    assert.throws(() => openAttachedTerminal(f.ctx, f.page, f.cs, "w", "retired", "xterm"),
      /retired or unsupported terminal backend/);
    assert.equal(f.commands.length, 2, "legacy compatibility cannot authorize an xterm spawn");
  });
}

test("a retained legacy key fails canonical readback before spawn", async (t) => {
  const f = legacyFixture(t, { echo: true });
  await assert.rejects(openLegacyConfiguredTerminal(f.ctx, f.page, f.cs, "w", "legacy", false), /survived canonical readback/);
  assert.deepEqual(f.commands, []);
});

test("a rejected legacy PATCH fails before spawn", async (t) => {
  const f = legacyFixture(t, { status: 400 });
  await assert.rejects(openLegacyConfiguredTerminal(f.ctx, f.page, f.cs, "w", "legacy", false), /PATCH -> 400/);
  assert.deepEqual(f.commands, []);
});

test("legacy acceptance without a visible Ghostty canvas is not a pass", async (t) => {
  const f = legacyFixture(t, { surface: false });
  await assert.rejects(openLegacyConfiguredTerminal(f.ctx, f.page, f.cs, "w", "legacy", false), /terminal not attached/);
});

function patchFixture(t, terminal) {
  let requestListener, acceptResponse, finishRefresh, patchBody;
  const page = {
    on: (_event, listener) => { requestListener = listener; }, off: () => {},
    evaluate: (fn, arg) => fn(arg),
    waitForResponse: (predicate) => {
      acceptResponse = predicate;
      return new Promise((resolve) => { finishRefresh = resolve; });
    },
  };
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (options.method === "PATCH") {
      patchBody = JSON.parse(options.body);
      terminal = patchBody.preferences.terminal;
      const patch = { url: () => "http://test.invalid/api/config", method: () => "PATCH" };
      const refresh = { url: () => "http://test.invalid/api/workspace", method: () => "GET" };
      requestListener(patch);
      requestListener(refresh);
      const response = { request: () => refresh, ok: () => true, json: async () => ({ preferences: { terminal } }) };
      assert.equal(await acceptResponse(response), true);
      finishRefresh(response);
      return new Response(null, { status: 200 });
    }
    return Response.json({ revision: 7, preferences: { terminal } });
  });
  return { page, body: () => patchBody };
}

test("ordinary PATCH drops an inherited retired key and preserves unrelated preferences", async (t) => {
  const f = patchFixture(t, { ghostty: false, mouse_capture: true, program_status: false });
  await writeTerminalPrefs(f.page, "", { program_status: true });
  assert.deepEqual(f.body(), {
    expected_revision: 7,
    preferences: { terminal: { mouse_capture: true, program_status: true } },
  });
});

test("restoring preferences strips an inherited retired key without losing original values", async (t) => {
  const original = { ghostty: false, mouse_capture: false, secret_masking: true, program_status: false };
  const f = patchFixture(t, { ghostty: true, mouse_capture: true, secret_masking: false, program_status: true });
  const ctx = prefsFixture(t, "[terminal]\nmouse_capture = false\nsecret_masking = true\n");
  await restoreTerminalPrefs(ctx, f.page, "", original);
  assert.deepEqual(f.body(), {
    expected_revision: 7,
    preferences: { terminal: { mouse_capture: false, secret_masking: true, program_status: false } },
  });
  assert.deepEqual(original, { ghostty: false, mouse_capture: false, secret_masking: true, program_status: false });
});

function prefsFixture(t, source) {
  const chanHome = mkdtempSync(join(tmpdir(), "chan-terminal-prefs-"));
  t.after(() => rmSync(chanHome, { recursive: true, force: true }));
  const path = join(chanHome, "server.toml");
  if (source !== undefined) writeFileSync(path, source);
  // A mismatch expires without a ten-second sleep.
  let reads = 0;
  t.mock.method(Date, "now", () => reads++ < 2 ? 0 : reads * 20_000);
  return { chanHome, path };
}

test("a missing prefs file cannot prove an absent key", async (t) => {
  await assert.rejects(assertTerminalPrefs(prefsFixture(t), { ghostty: null }), /ENOENT/);
});

test("a caller can explicitly require a missing prefs file", async (t) => {
  await assertTerminalPrefs(prefsFixture(t), { ghostty: null }, { expectMissingFile: true });
});

test("a missing file cannot satisfy an expected preference value", async (t) => {
  await assert.rejects(assertTerminalPrefs(prefsFixture(t), { mouse_capture: true }, { expectMissingFile: true }),
    /missing file cannot persist/);
});

test("an existing file cannot satisfy a missing-file expectation", async (t) => {
  await assert.rejects(assertTerminalPrefs(prefsFixture(t, ""), { ghostty: null }, { expectMissingFile: true }),
    /expected server.toml to be missing/);
});

for (const expectMissingFile of [false, true]) {
  test(`an unreadable prefs path fails with expectMissingFile=${expectMissingFile}`, async (t) => {
    const ctx = prefsFixture(t);
    mkdirSync(ctx.path);
    await assert.rejects(assertTerminalPrefs(ctx, { ghostty: null }, { expectMissingFile }), /EISDIR/);
  });
}

for (const source of [
  "[terminal\nghostty = false\n",
  "[terminal]\nghostty = maybe\n",
  "[terminal]\nghostty = true\nghostty = false\n",
  "[terminal]\nmouse_capture = true\n[other]\nbroken = [\n",
  Buffer.from('[terminal]\nghostty = "\xff"\n', "latin1"),
]) {
  test(`invalid TOML cannot satisfy an absent key: ${JSON.stringify(source)}`, async (t) => {
    await assert.rejects(assertTerminalPrefs(prefsFixture(t, source), { secret_masking: null }), /invalid server.toml/);
  });
}

test("only the terminal table supplies preference values", async (t) => {
  const ctx = prefsFixture(t, '[other]\nmouse_capture = false\nghostty = false\n[terminal]\n"mouse_capture" = true # enabled\nscrollback_mb = 1_024\n');
  await assertTerminalPrefs(ctx, { ghostty: null, mouse_capture: true, scrollback_mb: 1024 });
});

test("an assignment in another table cannot satisfy a terminal value", async (t) => {
  await assert.rejects(assertTerminalPrefs(prefsFixture(t, "[other]\nmouse_capture = true\n"), { mouse_capture: true }),
    /did not persist/);
});

test("a nested terminal table cannot satisfy a terminal value", async (t) => {
  await assert.rejects(assertTerminalPrefs(prefsFixture(t, "[terminal.other]\nmouse_capture = true\n"), { mouse_capture: true }),
    /did not persist/);
});

test("a string value cannot satisfy a boolean expectation or key absence", async (t) => {
  const ctx = prefsFixture(t, '[terminal]\nghostty = "false"\n');
  await assert.rejects(assertTerminalPrefs(ctx, { ghostty: false }), /did not persist/);
  await assert.rejects(assertTerminalPrefs(ctx, { ghostty: null }), /did not persist/);
});

test("the terminal preference table must be a table", async (t) => {
  await assert.rejects(assertTerminalPrefs(prefsFixture(t, "terminal = false\n"), { ghostty: null }), /terminal must be a table/);
});
