// Socket frames establish every reasserted mode, including urxvt 1015.
// Ghostty also proves alternate-screen replay exclusion. These arms cover
// the attach wire, not 1016 pixel-input encoding.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAttachedTerminal, TERMINAL_SURFACE } from "../lib/terminal-attach.mjs";
import { startTerminalFixture } from "../lib/terminal-fixture.mjs";
import { readTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const CPR = "\x1b[3;12R";
const QUERY = "\x1b[3;12H\x1b[6n";
const TRACKED_MODES = [1, 9, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 2004];
const SUPPORT = {
  ghostty: "web/packages/ghostty-web-ng/lib/terminal.ts passes only hasSgrMouseMode(1006); lib/input-handler.ts sendMouseEvent chooses SGR cells or X10, and vt/ghosttyVt.ts hasMouseTracking excludes 9; this input binding implements none of the newly tracked modes 9, 1001, 1005, 1015, 1016",
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const inputSince = (fixture, index) => Buffer.concat(fixture.records.slice(index)
  .filter((record) => record.type === "keys")
  .map((record) => Buffer.from(record.base64, "base64")));
const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

async function until(label, read, accept, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  do {
    last = await read();
    if (accept(last)) return last;
    await sleep(50);
  } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}

function layoutTerminals(node) {
  if (!node) return [];
  if (node.k === "s") return [...layoutTerminals(node.a), ...layoutTerminals(node.b)];
  return [...(node.t ?? []), ...(node.bt ?? [])].filter((tab) => tab.k === "t");
}

async function waitSaved(ctx, windowId, name, id) {
  const token = new URL(ctx.serverUrl).searchParams.get("t");
  await until("the saved layout holds the existing terminal id", async () => {
    const url = new URL("/api/session", ctx.serverUrl);
    url.searchParams.set("w", windowId);
    const response = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    if (response.status === 204) return [];
    assert.ok(response.ok, `GET /api/session: ${response.status}`);
    return layoutTerminals((await response.json()).layout).map((tab) => ({ name: tab.n, id: tab.tsid }));
  }, (tabs) => tabs.some((tab) => tab.name === name && tab.id === id));
}

async function traceTerminalSockets(page) {
  const cdp = await page.createCDPSession();
  const connections = [];
  const requests = new Map();
  await cdp.send("Network.enable");
  cdp.on("Network.webSocketCreated", ({ requestId, url }) => {
    const parsed = new URL(url);
    if (parsed.pathname !== "/api/terminal/ws") return;
    // Never retain the URL, bearer token, command or environment query.
    const connection = { session: parsed.searchParams.get("session"),
      since: parsed.searchParams.get("since"), generation: parsed.searchParams.get("generation"), frames: [] };
    requests.set(requestId, connection);
    connections.push(connection);
  });
  cdp.on("Network.webSocketFrameReceived", ({ requestId, response }) => {
    const connection = requests.get(requestId);
    if (!connection) return;
    if (response.opcode === 2) {
      connection.frames.push({ binary: response.payloadData });
    } else if (response.opcode === 1) {
      let frame;
      try { frame = JSON.parse(response.payloadData); } catch { return; }
      if (frame.type === "session") connection.frames.push({
        type: "session", id: frame.id, name: frame.name, seq: frame.seq, generation: frame.generation,
        replay_bytes: frame.replay_bytes, missed_bytes: frame.missed_bytes,
      });
      else if (frame.type === "ready") connection.frames.push({ type: "ready", cols: frame.cols, rows: frame.rows });
      else if (frame.type === "error" || frame.type === "closed" || frame.type === "exit") {
        connection.frames.push({ type: frame.type });
      }
    }
  });
  return { connections, close: () => cdp.detach() };
}

async function prelude(trace, name, start = 0) {
  return until(`${name}: session and ready on one socket`, () => {
    for (const connection of trace.connections.slice(start)) {
      const sessionIndex = connection.frames.findIndex((frame) => frame.type === "session" && frame.name === name);
      if (sessionIndex < 0) continue;
      const readyIndex = connection.frames.findIndex((frame, index) => index > sessionIndex && frame.type === "ready");
      if (readyIndex < 0) continue;
      const frames = connection.frames.slice(sessionIndex, readyIndex + 1);
      return { request: { session: connection.session, since: connection.since, generation: connection.generation },
        session: frames[0], ready: frames.at(-1), frames,
        binary: Buffer.concat(frames.filter((frame) => frame.binary !== undefined)
          .map((frame) => Buffer.from(frame.binary, "base64"))).toString("latin1") };
    }
    return null;
  }, Boolean);
}

async function currentRow(cs, name, id) {
  return until(`${name}: the same PTY is attached`, async () => {
    const listed = JSON.parse((await cs(["list", "--json"])).stdout);
    return Object.values(listed.groups ?? {}).flat().find((row) => row.name === name) ?? null;
  }, (row) => row?.session_id === id && row.pane && row.tab);
}

function screenSelector(row, backend) {
  const tab = `.pane[data-pane-id="${row.pane}"] .terminal-tab.active[data-terminal-tab-id="${row.tab}"]`;
  return `${tab} ${TERMINAL_SURFACE}`;
}

async function screenBox(page, row, backend) {
  const screen = await page.waitForSelector(screenSelector(row, backend), { visible: true, timeout: 20_000 });
  const box = await screen.boundingBox();
  assert.ok(box && box.width > 100 && box.height > 100, `${backend}: renderer has a visible box`);
  return box;
}

async function selectionFocus(page, tab) {
  return page.evaluate((query) => {
    const input = document.querySelector(`${query} textarea`);
    const active = document.activeElement;
    return { textareaFound: Boolean(input), textareaFocused: Boolean(input && active === input),
      active: active ? { tag: active.tagName, id: active.id.slice(0, 160),
        classes: String(active.className).slice(0, 240),
        tab: active.closest("[data-terminal-tab-id]")?.getAttribute("data-terminal-tab-id") ?? null } : null };
  }, tab);
}

async function copyChord(page) {
  try {
    await page.keyboard.down("Control");
    try {
      await page.keyboard.down("Shift");
      await page.keyboard.press("KeyC");
    } finally { await page.keyboard.up("Shift"); }
  } finally { await page.keyboard.up("Control"); }
}

async function observeCopies(page) {
  await page.evaluate(() => {
    if (window.__copy270) throw new Error("a clipboard observer is already installed");
    const clipboard = navigator.clipboard;
    const descriptor = Object.getOwnPropertyDescriptor(clipboard, "writeText");
    const writeText = clipboard.writeText;
    const state = { phase: "drag", writes: [], pending: 0, overflow: false };
    Object.defineProperty(clipboard, "writeText", { configurable: true, writable: true,
      value: async function (text) {
        const record = { phase: state.phase, status: "pending", length: text.length,
          text: text.slice(0, 8192), truncated: text.length > 8192 };
        if (state.writes.length < 32) state.writes.push(record);
        else state.overflow = true;
        state.pending++;
        try {
          await writeText.call(this, text);
          record.status = "fulfilled";
        } catch (error) {
          record.status = "rejected";
          record.error = String(error.message).slice(0, 240);
          throw error;
        } finally { state.pending--; }
      } });
    state.reset = async (phase, sentinel) => {
      if (state.pending || state.overflow) throw new Error("unsettled clipboard writes before phase change");
      state.phase = phase;
      await writeText.call(clipboard, sentinel);
    };
    state.snapshot = () => ({ writes: state.writes, pending: state.pending, overflow: state.overflow });
    state.close = () => {
      if (descriptor) Object.defineProperty(clipboard, "writeText", descriptor);
      else delete clipboard.writeText;
    };
    window.__copy270 = state;
  });
}

async function settleCopies(page, receipt, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    receipt.writes = await page.evaluate(() => window.__copy270.snapshot());
    assert.ok(!receipt.writes.overflow, "clipboard diagnostics stay within their bound");
    if (!receipt.writes.pending) return;
    await sleep(50);
  } while (Date.now() < deadline);
  throw new Error("clipboard writes did not settle before the next selection phase");
}

// Each chord needs its own completed native write. A delayed drag or
// diagnostic write must settle before the next sentinel is installed.
async function selectionCopy(page, receipt, phase, sentinel, timeoutMs, required) {
  await page.evaluate(({ phase, sentinel }) => window.__copy270.reset(phase, sentinel), { phase, sentinel });
  await copyChord(page);
  const deadline = Date.now() + timeoutMs;
  do {
    receipt.writes = await page.evaluate(() => window.__copy270.snapshot());
    assert.ok(!receipt.writes.overflow, "clipboard diagnostics stay within their bound");
    const completed = receipt.writes.writes.some((write) => write.phase === phase && write.status === "fulfilled");
    const text = await page.evaluate(() => navigator.clipboard.readText());
    receipt.copied = completed && text !== sentinel;
    receipt.length = text.length;
    receipt.text = text.slice(0, 8192);
    receipt.truncated = text.length > receipt.text.length;
    if (!receipt.writes.pending && receipt.copied) return text;
    await sleep(50);
  } while (Date.now() < deadline);
  receipt.timedOut = true;
  assert.equal(receipt.writes.pending, 0, "a timed-out selection write cannot cross into the next phase");
  assert.ok(!required, "the visible selection reaches the clipboard after textarea focus");
  return null;
}

// Select the visible grid so the copy represents the alternate-screen draw
// without including saved normal-buffer history.
async function copyVisible(page, row, backend, receipts) {
  const receipt = { gesture: "ordinary-drag" };
  receipts.push(receipt);
  const box = await screenBox(page, row, backend);
  const sentinel = "270-selection-not-copied";
  await observeCopies(page);
  try {
    await page.evaluate((value) => window.__copy270.reset("drag", value), sentinel);
    await page.mouse.move(box.x + 1, box.y + 1);
    // Mouse reporting is disabled, so an ordinary drag selects the grid.
    try {
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 2, box.y + box.height - 2, { steps: 12 });
    } finally { await page.mouse.up(); }
    receipt.drag = {};
    await settleCopies(page, receipt.drag, 20_000);
    const tab = `.pane[data-pane-id="${row.pane}"] .terminal-tab.active[data-terminal-tab-id="${row.tab}"]`;
    // A successful diagnostic copy can itself refocus the terminal.
    receipt.beforeFocus = await selectionFocus(page, tab);
    await selectionCopy(page, receipt.beforeFocus, "before-focus", `${sentinel}-before-focus`, 1000, false);
    await page.$eval(`${tab} textarea`, (input) => input.focus());
    receipt.afterFocus = await selectionFocus(page, tab);
    assert.ok(receipt.afterFocus.textareaFocused, `${backend}: the owned textarea takes focus`);
    return await selectionCopy(page, receipt.afterFocus, "after-focus", sentinel, 20_000, true);
  } finally {
    receipt.clipboard = await page.evaluate(() => {
      const state = window.__copy270;
      try { return state.snapshot(); }
      finally { state.close(); delete window.__copy270; }
    });
  }
}

async function parsedOutput(fixture, bytes = "") {
  const index = fixture.records.length;
  await fixture.send("bytes", { base64: Buffer.from(bytes + QUERY).toString("base64") });
  // The server's fallback replies 1;1. Only the renderer can reply 3;12
  // after parsing the preceding output and the explicit cursor placement.
  await fixture.waitFor(() => inputSince(fixture, index).includes(Buffer.from(CPR)));
  return inputSince(fixture, index).toString("base64");
}

async function reloadSame(ctx, page, cs, trace, row, name, before, fullReplay = false) {
  await waitSaved(ctx, row.window, name, before.session.id);
  const connectionStart = trace.connections.length;
  let hook;
  try {
    if (fullReplay) {
      // Unload captures the old view again. Remove only its snapshot in the
      // new document, before the component can select that resume cursor.
      hook = await page.evaluateOnNewDocument((sessionId, origin) => {
        if (window.top !== window || location.origin !== origin) return;
        localStorage.removeItem(`chan:term-snapshot:${sessionId}`);
      }, before.session.id, new URL(ctx.serverUrl).origin);
    }
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  } finally {
    if (hook) await page.removeScriptToEvaluateOnNewDocument(hook.identifier);
  }
  await page.waitForSelector(".pane", { timeout: 20_000 });
  await ctx.waitWindowLive(row.window);
  const after = await prelude(trace, name, connectionStart);
  assert.equal(after.session.id, before.session.id, "reload reattaches the same PTY");
  assert.equal(after.session.generation, before.session.generation, "reload does not restart the program");
  return { row: await currentRow(cs, name, before.session.id), prelude: after };
}

export default {
  name: "terminal-alternate-replay-and-mouse-modes",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
    await page.bringToFront();
    const windowId = await page.evaluate(() => new URL(location.href).searchParams.get("w")?.trim()
      || sessionStorage.getItem("chan.session.window")?.trim() || "");
    assert.ok(windowId, "the smoke window has an id");
    await ctx.waitWindowLive(windowId);
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const originalMouseCapture = (await readTerminalPrefs(page, token)).mouse_capture;
    const cs = (args) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
      cwd: ctx.workspaceDir,
      env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId },
      timeout: 90_000,
    });
    const backend = "ghostty";
    const failures = [];
    const results = [];
    try {
      await writeTerminalPrefs(page, token, { mouse_capture: true });
      for (const arm of ["1047", "modes"]) {
        const name = `AltReplay270-${backend}-${arm}`;
        const result = { backend, arm, support: SUPPORT[backend], accepted: false };
        const trace = await traceTerminalSockets(page);
        const fixture = await startTerminalFixture({
          logPath: join(ctx.outDir, `270-${backend}-${arm}-fixture.bin`), deadlineMs: 20_000,
        });
        let privateDir;
        let creationAttempted = false;
        const fail = (error) => {
          const message = String(error.message).replaceAll(fixture.env.TERMINAL_FIXTURE_TOKEN, "[redacted]");
          result.accepted = false;
          (result.errors ??= []).push(message);
          failures.push(`${backend}/${arm}: ${message}`);
        };
        try {
          // Spawn env travels in the browser's initial socket URL, which the
          // runner records. Source credentials only inside the owned PTY.
          privateDir = mkdtempSync(join(tmpdir(), "chan-alt-replay-"));
          const envFile = join(privateDir, "fixture-env");
          writeFileSync(envFile, Object.entries(fixture.env)
            .map(([key, value]) => `export ${key}=${shellQuote(value)}\n`).join(""), { mode: 0o600 });
          creationAttempted = true;
          let row = await openAttachedTerminal(ctx, page, cs, windowId, name);
          result.before = await prelude(trace, name);
          const normal = `NORMAL270_${backend}`;
          const initial = `ALT270_${backend}`;
          const mode = arm === "1047" ? "1047" : "1049";
          result.bootstrap = "stty -opost -echo && printf '\\033[H\\033[2J\\033[3J' && "
            + `printf '%s\\r\\n' ${shellQuote(normal)} && `
            + `printf '\\033[?${mode}h\\033[2J\\033[H%s\\r\\n' ${shellQuote(initial)} && `
            + `. ${shellQuote(envFile)} && `
            + fixture.command;
          await cs(["write", "--tab-name", name, result.bootstrap + "\n"]);
          result.fixture = await fixture.ready();
          assert.ok(result.fixture.tty && result.fixture.raw, "the fixture records a real raw PTY");
          result.initialParserReply = await parsedOutput(fixture);

          if (arm === "1047") {
            result.selectionCopies = [];
            result.initialVisible = await copyVisible(page, row, backend, result.selectionCopies);
            assert.ok(result.initialVisible.includes(initial), "the alternate-screen draw is visible before reload");
            assert.ok(!result.initialVisible.includes(normal), "the initial alternate screen excludes normal text");
            await ctx.shot(`270-${backend}-1047-before`);
            const restored = await reloadSame(ctx, page, cs, trace, row, name, result.before, true);
            row = restored.row;
            result.after = restored.prelude;
            assert.equal(result.after.request.session, result.before.session.id, "the reload request attaches the same PTY");
            assert.equal(result.after.request.since, "0", "full replay requires an explicit since=0 request");
            const live = `AFTER270_${backend}`;
            result.restoredParserReply = await parsedOutput(fixture, `\x1b[H${live}`);
            result.restoredVisible = await copyVisible(page, row, backend, result.selectionCopies);
            await ctx.shot(`270-${backend}-1047-after`);
            assert.ok(result.restoredVisible.includes(live), "the reattached view draws live output");
            assert.ok(!result.restoredVisible.includes(normal), "normal-screen text never enters the reattached view");
            assert.equal(result.after.session.replay_bytes, 0, "the 1047 attach replays no normal-screen bytes");
            assert.ok(!result.after.binary.includes(normal), "the attach wire carries no normal-screen marker");
          } else if (arm === "modes") {
            result.programSetModes = TRACKED_MODES;
            result.modesParserReply = await parsedOutput(fixture, `\x1b[?${TRACKED_MODES.join(";")}h`);
            const restored = await reloadSame(ctx, page, cs, trace, row, name, result.before);
            row = restored.row;
            result.after = restored.prelude;
            result.restoredParserReply = await parsedOutput(fixture, `\x1b[HMODES270_${backend}`);
            result.reassertedModes = TRACKED_MODES.filter((mode) => result.after.binary.includes(`\x1b[?${mode}h`));
            await ctx.shot(`270-${backend}-modes-after`);
            assert.deepEqual(result.reassertedModes, TRACKED_MODES, "the real attach prelude reasserts every mode the program set, including 1015");
            result.clickAcceptance = { applicable: false, reason: SUPPORT.ghostty, coverage: "socket prelude only" };
          }
          result.accepted = true;
        } catch (error) {
          fail(error);
          await ctx.shot(`270-${backend}-${arm}-failure`).catch(() => {});
        } finally {
          result.flush = await fixture.send("barrier", { name: "cleanup" }).catch((error) => {
            fail(new Error(`fixture flush: ${error.message}`));
            return null;
          });
          // Creation can succeed before the helper's attachment wait fails.
          if (creationAttempted) await cs(["close", "--tab-name", name]).then(() => {
            result.terminalClosed = true;
          }).catch((error) => {
            fail(new Error(`close owned terminal: ${error.message}`));
          });
          await fixture.close().then(() => { result.fixtureClosed = true; }).catch(fail);
          if (privateDir) {
            try {
              rmSync(privateDir, { recursive: true });
              result.credentialsRemoved = true;
            } catch (error) { fail(error); }
          }
          result.records = fixture.records;
          result.connections = trace.connections;
          await trace.close().then(() => { result.traceClosed = true; }).catch(fail);
          writeFileSync(join(ctx.outDir, `270-${backend}-${arm}.json`), JSON.stringify(result, null, 2) + "\n");
          results.push({ backend, arm, accepted: result.accepted, errors: result.errors ?? [],
            evidence: `270-${backend}-${arm}.json` });
        }
      }
    } finally {
      await writeTerminalPrefs(page, token, { mouse_capture: originalMouseCapture });
    }
    const details = { arms: results, support: SUPPORT };
    if (failures.length) throw Object.assign(new Error(failures.join("\n")), { smokeDetails: details });
    assert.deepEqual(results.map(({ backend, arm }) => `${backend}/${arm}`), ["ghostty/1047", "ghostty/modes"],
      "Ghostty ran every required replay and prelude arm");
    return details;
  },
};
