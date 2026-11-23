import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { drainPointerInput, pointerInputSince, pointerReports, runPointerCheck } from "./terminal-pointer.mjs";

const keys = (text) => ({ type: "keys", base64: Buffer.from(text, "latin1").toString("base64") });

test("raw reports survive fragmented records without accepting old input or control replies", () => {
  const fixture = { records: [keys("old"), keys("\x1b[<0;"), { type: "reply", ok: true }, keys("2;3M\x1b[<0;8;9m")] };
  const input = pointerInputSince(fixture, 1);
  assert.equal(input, "\x1b[<0;2;3M\x1b[<0;8;9m");
  assert.deepEqual(pointerReports(input), [
    { button: 0, col: 2, row: 3, end: "M" },
    { button: 0, col: 8, row: 9, end: "m" },
  ]);
});

test("the SGR reader rejects junk, truncated reports, and invalid coordinates", () => {
  for (const input of ["x\x1b[<0;2;3M", "\x1b[<0;2;3Mx", "\x1b[<0;2;", "\x1b[<0;0;1M", "\x1b[<0;1;0m", "\x1b[2;3R"]) {
    assert.throws(() => pointerReports(input), /only complete SGR reports/, JSON.stringify(input));
  }
  assert.deepEqual(pointerReports(""), []);
  assert.equal(pointerReports("\x1b[<0;2;3m\x1b[<0;2;3m").length, 2, "duplicate releases stay visible to the caller");
});

test("drain requires a new complete cursor reply and retains all preceding gesture bytes", async () => {
  const fixture = {
    records: [keys("\x1b[9;9R")],
    async send(op, args) {
      assert.equal(op, "bytes");
      assert.equal(Buffer.from(args.base64, "base64").toString(), "\x1b[?1000h\x1b[6n");
    },
    async waitFor(predicate) {
      assert.equal(predicate(), false, "a stale reply is not a round trip");
      this.records.push(keys("\x1b[<0;2;3M\x1b[4;"));
      assert.equal(predicate(), false, "a partial reply cannot end the drain");
      this.records.push(keys("1R"));
      assert.equal(predicate(), true);
    },
  };
  assert.deepEqual(await drainPointerInput(fixture, "\x1b[?1000h"), {
    input: "\x1b[<0;2;3M", reply: "\x1b[4;1R",
  });
});

test("drain propagates a missing-reply failure instead of reporting silence", async () => {
  const fixture = { records: [], async send() {}, async waitFor() { throw new Error("FIXTURE_EVENT_TIMEOUT"); } };
  await assert.rejects(drainPointerInput(fixture), /FIXTURE_EVENT_TIMEOUT/);
});

test("native sequence evidence rejects missing, synthetic, wrong-type and foreign-pointer events", async () => {
  const { requirePointerSequence } = await import("./terminal-pointer.mjs");
  const sequence = ["pointerdown", "pointermove", "pointerup"].map((type) => ({
    type, pointerId: 7, pointerType: "pen", isPrimary: true, isTrusted: true, onCanvas: true,
    buttons: type === "pointerup" ? 0 : 1,
  }));
  assert.equal(requirePointerSequence(sequence, "pen"), sequence[0]);
  const cancelledTouch = sequence.map((event) => ({ ...event, pointerType: "touch",
    type: event.type === "pointerup" ? "pointercancel" : event.type }));
  assert.equal(requirePointerSequence(cancelledTouch, "touch", "pointercancel"), cancelledTouch[0]);
  assert.throws(() => requirePointerSequence(cancelledTouch, "touch"), { code: "POINTER_UNAVAILABLE" });
  for (const field of ["isPrimary", "isTrusted", "onCanvas"]) {
    for (let index = 0; index < sequence.length; index++) {
      const bad = sequence.map((event, n) => n === index ? { ...event, [field]: false } : event);
      assert.throws(() => requirePointerSequence(bad, "pen"), { code: "POINTER_UNAVAILABLE" });
    }
  }
  for (let index = 0; index < sequence.length; index++) {
    assert.throws(() => requirePointerSequence(sequence.filter((_, n) => n !== index), "pen"), { code: "POINTER_UNAVAILABLE" });
  }
  assert.throws(() => requirePointerSequence(sequence, "touch"), { code: "POINTER_UNAVAILABLE" });
  assert.throws(() => requirePointerSequence(sequence.map((event, n) => n === 1 ? { ...event, pointerId: 8 } : event), "pen"), { code: "POINTER_UNAVAILABLE" });
  assert.throws(() => requirePointerSequence(sequence.map((event, n) => n === 1 ? { ...event, buttons: 0 } : event), "pen"), { code: "POINTER_UNAVAILABLE" });
});

test("painted thumb location comes from pixels and rejects a hidden, flat or ambiguous strip", async () => {
  const { paintedThumbBand } = await import("./terminal-pointer.mjs");
  const strip = Array(100).fill(7);
  strip.fill(42, 25, 45);
  assert.deepEqual(paintedThumbBand(strip), { start: 25, end: 45, track: 7, peak: 42 });
  const moved = Array(100).fill(7);
  moved.fill(42, 61, 81);
  assert.deepEqual(paintedThumbBand(moved), { start: 61, end: 81, track: 7, peak: 42 });
  for (const samples of [[], Array(100).fill(0), Array(100).fill(42), [...strip, NaN]]) {
    assert.throws(() => paintedThumbBand(samples));
  }
  const doubled = [...strip];
  doubled.fill(42, 70, 90);
  assert.throws(() => paintedThumbBand(doubled), /one painted thumb/);
  const short = Array(100).fill(7);
  short.fill(42, 30, 32);
  assert.throws(() => paintedThumbBand(short), /usable height/);
});

test("unavailable input stays a runner skip without masking a product or cleanup failure", async () => {
  const { pointerCheckError } = await import("./terminal-pointer.mjs");
  const details = { legs: { pen: { status: "unavailable" }, touch: { status: "passed" } }, failures: ["pen unavailable"] };
  const skipped = pointerCheckError(details);
  assert.equal(skipped.smokeSkip, true);
  assert.equal(skipped.smokeDetails, details);
  for (const extra of ["touch reports", "cleanup failed"]) {
    const failed = pointerCheckError({ ...details, failures: [...details.failures, extra] });
    assert.notEqual(failed.smokeSkip, true);
    assert.ok(failed.message.includes(extra));
  }
  assert.notEqual(pointerCheckError({ legs: { pen: { status: "failed" } }, failures: ["pen failed"] }).smokeSkip, true);
});

// Replace only the PTY process boundary and served browser chunk. The check
// orchestration, attachment, preferences and page callbacks run unchanged.
let activeFixture;
export const startPointerTestFixture = () => activeFixture;
export class PointerTestTerminal {
  open(element) { this.element = element; }
}

function checkFixture(t, { reply = "\x1b[2;1R", history = 0, missingInstance = false, chunk = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "chan-pointer-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixtureModule = `data:text/javascript,${encodeURIComponent(`export { startPointerTestFixture as startTerminalFixture } from ${JSON.stringify(import.meta.url)};`)}`;
  const terminalModule = `data:text/javascript,${encodeURIComponent(`export { PointerTestTerminal as Terminal } from ${JSON.stringify(import.meta.url)};`)}`;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL === new URL("./terminal-pointer.mjs", import.meta.url).href && specifier === "./terminal-fixture.mjs") {
        return { url: fixtureModule, shortCircuit: true };
      }
      if (specifier === "file:///pointer-smoke/ghostty-web-stub.js") return { url: terminalModule, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  const globals = (values) => {
    for (const [key, value] of Object.entries(values)) {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
      t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
    }
  };
  const canvas = Object.assign(new EventTarget(), {
    getBoundingClientRect: () => ({ left: 10, top: 10, width: 800, height: 480 }),
  });
  const host = { querySelector: () => canvas };
  const document = Object.assign(new EventTarget(), {
    querySelector: (query) => query.endsWith(" .terminal-host") ? host : canvas,
    querySelectorAll: () => chunk ? [{ src: "file:///pointer-smoke/entry.js" }] : [],
  });
  globals({ document, window: {}, location: { href: "http://test.invalid/?w=window" },
    navigator: { clipboard: { writeText: async () => {} } }, requestAnimationFrame: (callback) => callback() });
  const handle = (value) => ({
    evaluate: async (fn, ...args) => fn(value, ...args),
    evaluateHandle: async (fn, ...args) => handle(await fn(value, ...args)),
    dispose: async () => {},
  });
  const page = Object.assign(new EventEmitter(), {
    bringToFront: async () => {},
    evaluate: async (fn, ...args) => fn(...args),
    evaluateHandle: async (fn, ...args) => handle(await fn(...args)),
    waitForSelector: async () => {},
    mouse: { reset: async () => {} },
    createCDPSession: async () => ({ send: async () => {}, detach: async () => {} }),
  });
  let acceptResponse, finishRefresh;
  page.waitForResponse = (predicate) => {
    acceptResponse = predicate;
    return new Promise((resolve) => { finishRefresh = resolve; });
  };
  let preferences = { mouse_capture: false, secret_masking: false };
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    if (url === "file:///pointer-smoke/entry.js") return new Response('import("ghostty-web-stub.js")');
    assert.equal(url, "/api/config");
    if (options.method === "PATCH") {
      preferences = JSON.parse(options.body).preferences.terminal;
      requests.push(preferences);
      writeFileSync(join(root, "server.toml"), `[terminal]\nmouse_capture = ${preferences.mouse_capture}\nsecret_masking = ${preferences.secret_masking}\n`);
      const patch = { url: () => "http://test.invalid/api/config", method: () => "PATCH" };
      const refresh = { url: () => "http://test.invalid/api/workspace", method: () => "GET" };
      page.emit("request", patch);
      page.emit("request", refresh);
      const response = { request: () => refresh, ok: () => true, json: async () => ({ preferences: { terminal: preferences } }) };
      assert.equal(await acceptResponse(response), true);
      finishRefresh(response);
      return new Response(null, { status: 200 });
    }
    return Response.json({ revision: 1, preferences: { terminal: preferences } });
  });
  const fixture = activeFixture = {
    records: [], command: "stub-pty", env: { TERMINAL_FIXTURE_TOKEN: "stub-token" },
    ready: async () => ({ tty: true, raw: true }),
    send: async (op, args) => {
      assert.equal(op, "bytes");
      assert.ok(Buffer.from(args.base64, "base64").toString().endsWith("\x1b[6n"));
      fixture.records.push(keys(reply));
    },
    waitFor: async (predicate) => assert.ok(predicate(), "the stub supplied a complete DSR reply"),
    close: async () => { fixture.closed = true; },
  };
  const commands = [], shots = [];
  const terminal = Object.assign(new PointerTestTerminal(), {
    cols: 80, rows: 24, getMode: () => false, getScrollbackLength: () => history,
  });
  const ctx = {
    page, browser: { id: "context" }, controlSocket: "/stub/socket", chanBin: "/stub/chan",
    serverUrl: "http://test.invalid/?t=token", outDir: root, workspaceDir: root, chanHome: root,
    waitWindowLive: async (id) => assert.equal(id, "window"), shot: async (name) => shots.push(name),
    exec: async (bin, args) => {
      assert.equal(bin, "/stub/chan");
      assert.deepEqual(args.slice(0, 2), ["shell", "terminal"]);
      commands.push(args.slice(2));
      if (args[2] === "new") {
        if (missingInstance) terminal.element = host;
        else terminal.open(host);
        const newest = Object.assign(new PointerTestTerminal(), {
          cols: 80, rows: 24, getMode: () => false, getScrollbackLength: () => 0,
        });
        newest.open({ querySelector: () => canvas });
      }
      return { stdout: JSON.stringify({ groups: { Default: [{
        name: "Pointer901-probe", pane: "pane", tab: "tab", window: "window", window_status: "alive",
      }] } }) };
    },
  };
  return { ctx, terminal, fixture, commands, shots, requests,
    saved: () => JSON.parse(readFileSync(join(root, "901-pointer.json"), "utf8")) };
}

test("runPointerCheck saves successful legs and restores its instruments and preferences", async (t) => {
  const f = checkFixture(t);
  const details = await runPointerCheck(f.ctx, 901, async ({ open, leg }) => {
    await leg("selection", async () => {
      const resource = await open("probe");
      assert.equal(await resource.term.evaluate((terminal) => terminal), f.terminal, "lookup uses the host, not the newest instance");
      assert.equal((await resource.prepare("TEXT")).cols, 80);
    });
  });
  assert.equal(details.legs.selection.status, "passed");
  assert.deepEqual(details.failures, []);
  assert.deepEqual(f.saved(), details);
  assert.equal(f.fixture.closed, true);
  assert.equal(window.__pointerSmoke, undefined);
  assert.deepEqual(f.requests.at(-1), { mouse_capture: false, secret_masking: false });
  assert.ok(f.commands.some((args) => args[0] === "close"));
});

test("runPointerCheck propagates a product failure even beside an unavailable leg", async (t) => {
  const f = checkFixture(t);
  await assert.rejects(runPointerCheck(f.ctx, 901, async ({ leg }) => {
    await leg("native", async () => { throw Object.assign(new Error("no pen"), { code: "POINTER_UNAVAILABLE" }); });
    await leg("selection", async () => { throw new Error("wrong selected text"); });
    await leg("later", async () => {});
  }), (error) => {
    assert.notEqual(error.smokeSkip, true);
    assert.equal(error.smokeDetails.legs.native.status, "unavailable");
    assert.equal(error.smokeDetails.legs.selection.status, "failed");
    assert.equal(error.smokeDetails.legs.later.status, "passed");
    assert.deepEqual(error.smokeDetails.unexercised, { native: "no pen" });
    assert.match(error.message, /selection \(failed\): wrong selected text/);
    assert.deepEqual(f.saved(), error.smokeDetails);
    return true;
  });
  assert.deepEqual(f.shots, ["901-native-unavailable", "901-selection-failed"]);
});

test("runPointerCheck skips an unavailable-only failure without losing passed legs", async (t) => {
  const f = checkFixture(t);
  await assert.rejects(runPointerCheck(f.ctx, 901, async ({ leg }) => {
    await leg("connected", async () => {});
    await leg("native", async () => { throw Object.assign(new Error("no pen"), { code: "POINTER_UNAVAILABLE" }); });
  }), (error) => {
    assert.equal(error.smokeSkip, true);
    assert.equal(error.smokeDetails.legs.connected.status, "passed");
    assert.equal(error.smokeDetails.legs.native.status, "unavailable");
    assert.deepEqual(f.saved(), error.smokeDetails);
    return true;
  });
});

for (const [label, options, expected] of [
  ["an uncaptured attached instance", { missingInstance: true }, /attached Ghostty terminal was not captured/],
  ["a wrapped fixture cursor reply", { reply: "\x1b[3;1R" }, /fixture text reached the parser without wrapping/],
  ["retained history", { history: 5 }, /each exact-selection gesture starts with empty scrollback/],
]) {
  test(`runPointerCheck rejects ${label} before the gesture`, async (t) => {
    const f = checkFixture(t, options);
    let gesture = false;
    await assert.rejects(runPointerCheck(f.ctx, 901, async ({ open, leg }) => {
      await leg("selection", async () => {
        const resource = await open("probe");
        await resource.prepare("TEXT");
        gesture = true;
      });
    }), (error) => {
      assert.match(error.message, expected);
      assert.equal(error.smokeDetails.legs.selection.status, "failed");
      assert.notEqual(error.smokeSkip, true);
      return true;
    });
    assert.equal(gesture, false);
    assert.equal(f.fixture.closed, true);
  });
}

test("runPointerCheck rejects a missing chunk before installing clipboard capture or running its body", async (t) => {
  const f = checkFixture(t, { chunk: false });
  let body = false;
  await assert.rejects(runPointerCheck(f.ctx, 901, async () => { body = true; }), (error) => {
    assert.match(error.message, /the entry module names a Ghostty chunk/);
    assert.notEqual(error.smokeSkip, true);
    assert.deepEqual(error.smokeDetails.legs, {});
    return true;
  });
  assert.equal(body, false);
});
