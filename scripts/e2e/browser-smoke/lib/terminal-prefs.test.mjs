import assert from "node:assert/strict";
import { test } from "node:test";
import { openAttachedTerminal } from "./terminal-attach.mjs";
import { openLegacyConfiguredTerminal, writeTerminalPrefs } from "./terminal-prefs.mjs";

for (const ghostty of [true, false, undefined, null]) {
  test(`ordinary writes refuse an explicit retired key ${ghostty} before reads`, () => {
    const page = { on: () => assert.fail("no listeners or reads before refusal") };
    assert.throws(() => writeTerminalPrefs(page, "", { ghostty }), /retired terminal preference ghostty/);
  });
}

for (const ghostty of ["false", 0, undefined, null]) {
  test(`legacy writes refuse non-boolean ${JSON.stringify(ghostty)} before reads`, () => {
    assert.throws(() => openLegacyConfiguredTerminal({}, {}, () => assert.fail("no spawn"), "w", "n", ghostty),
      /must be a boolean/);
  });
}

function legacyFixture(t, { echo = false, surface = true, status = 200 } = {}) {
  const requests = [], commands = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, ...options });
    if (options.method === "PATCH") return new Response(null, { status });
    return Response.json({ revision: 3, preferences: { terminal: echo ? { ghostty: false } : { mouse_capture: true } } });
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

for (const ghostty of [true, false]) {
  test(`legacy ${ghostty} is accepted, absent from readback, and opens Ghostty`, async (t) => {
    const f = legacyFixture(t);
    assert.deepEqual(await openLegacyConfiguredTerminal(f.ctx, f.page, f.cs, "w", "legacy", ghostty), f.row);
    assert.equal(f.requests.length, 3);
    assert.equal(JSON.parse(f.requests[1].body).preferences.terminal.ghostty, ghostty);
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

test("ordinary PATCH drops an inherited retired key and preserves unrelated preferences", async (t) => {
  let terminal = { ghostty: false, mouse_capture: true, program_status: false };
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
  await writeTerminalPrefs(page, "", { program_status: true });
  assert.deepEqual(patchBody, {
    expected_revision: 7,
    preferences: { terminal: { mouse_capture: true, program_status: true } },
  });
});
