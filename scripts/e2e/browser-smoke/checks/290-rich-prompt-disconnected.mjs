// A real terminal socket is cut and its redial held before the handshake.
// The composer must explain a refused submit without losing the draft or
// sending it later on its own. Explicit retry is checked on the PTY too.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openAttachedTerminal, readTerminalAttachment } from "../lib/terminal-attach.mjs";
import { startTerminalCutProxy } from "../lib/terminal-cut-proxy.mjs";
import { startTerminalFixture } from "../lib/terminal-fixture.mjs";

const NOTICE = "terminal not connected; try again";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function routeTerminal({ session, relay }) {
  const NativeSocket = window.WebSocket;
  const trace = window.__prompt290 = { sockets: [], prompts: [] };
  window.WebSocket = new Proxy(NativeSocket, {
    construct(target, args) {
      const url = new URL(args[0], location.href);
      if (url.pathname !== "/api/terminal/ws" || url.searchParams.get("session") !== session) {
        return Reflect.construct(target, args);
      }
      url.protocol = "ws:";
      url.host = new URL(relay).host;
      const socket = Reflect.construct(target, [url.href, ...args.slice(1)]);
      const record = { socket, ready: false, delivered: [] };
      trace.sockets.push(record);
      const connection = trace.sockets.length;
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        let frame;
        try { frame = JSON.parse(event.data); } catch { return; }
        if (frame.type === "ready") record.ready = true;
        if (frame.type === "prompt-delivered") record.delivered.push(frame.id);
      });
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (typeof data === "string") {
          let frame;
          try { frame = JSON.parse(data); } catch { /* Raw input is not JSON. */ }
          if (frame?.type === "prompt") trace.prompts.push({ ...frame, connection });
        }
        return send(data);
      };
      return socket;
    },
  });
  trace.restore = () => { window.WebSocket = NativeSocket; };
}

async function state(page, card) {
  return page.evaluate((card) => {
    const composer = card ? document.querySelector(card) : null;
    const editor = composer?.querySelector(".cm-content");
    const note = composer?.querySelector(".rp-text");
    const trace = window.__prompt290;
    return {
      text: editor?.textContent ?? null,
      editable: editor?.getAttribute("contenteditable") === "true",
      pending: composer?.classList.contains("pending") ?? null,
      note: note?.textContent ?? null,
      live: note?.getAttribute("aria-live") ?? null,
      sockets: trace?.sockets.map(({ socket, ready, delivered }) => ({ state: socket.readyState, ready, delivered })) ?? [],
      prompts: trace?.prompts ?? [],
    };
  }, card);
}

async function waitFor(page, card, label, accept, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let observed;
  do {
    observed = await state(page, card);
    if (accept(observed)) return observed;
    await sleep(50);
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(observed)}`);
}

const keys = (fixture) => Buffer.concat(fixture.records.filter((record) => record.type === "keys")
  .map((record) => Buffer.from(record.base64, "base64"))).toString("utf8");

export async function waitSaved(ctx, page, windowId, name) {
  const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
  await page.waitForFunction(async ({ windowId, name, token }) => {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const response = await fetch(`/api/session?w=${encodeURIComponent(windowId)}`, { headers });
    // A fresh window has no saved session until its debounced write lands.
    if (response.status === 204) return false;
    return response.ok && JSON.stringify((await response.json()).layout ?? null).includes(name);
  }, { timeout: 20_000, polling: 100 }, { windowId, name, token });
}

export async function waitRestoredTerminal(page, cs, windowId, original, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let placement = null;
  for (;;) {
    const { row, selector, attached } = await readTerminalAttachment(page, cs, (entry) =>
      entry.session_id === original.session_id && entry.window === windowId);
    // Session identity survives a reload; pane and tab IDs are regenerated.
    placement = row ? { session_id: row.session_id, window: row.window, pane: row.pane, tab: row.tab } : null;
    if (attached) return { ...placement, selector };
    if (Date.now() >= deadline) {
      assert.fail(`restored terminal not attached: ${JSON.stringify(placement)}`);
    }
    await sleep(100);
  }
}

export default {
  name: "rich-prompt-disconnected",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
    await page.bringToFront();
    const windowId = await page.evaluate(() => new URL(location.href).searchParams.get("w")?.trim()
      || sessionStorage.getItem("chan.session.window")?.trim() || "");
    assert.ok(windowId, "the check page has a window id");
    await ctx.waitWindowLive(windowId);
    const cs = (args) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
      cwd: ctx.workspaceDir,
      env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId },
      timeout: 90_000,
    });
    const backend = "ghostty";
    const failures = [];
    const name = `Prompt290-${backend}`;
    const text = `PROMPT290-${backend}`;
    const revised = `${text} revised`;
    const result = { backend, passed: false, pageErrors: [], cleanupErrors: [] };
    const onError = (error) => result.pageErrors.push(String(error));
    const fixture = await startTerminalFixture({ logPath: join(ctx.outDir, `290-${backend}-output.bin`), deadlineMs: 20_000 });
    let proxy, script, card = null, opened = false;
    page.on("pageerror", onError);
    try {
      const spawnArgs = ["--command", "stty -opost -echo && " + fixture.command,
        ...Object.entries(fixture.env).flatMap(([key, value]) => ["--env", `${key}=${value}`])];
      const row = await openAttachedTerminal(ctx, page, cs, windowId, name, spawnArgs);
      opened = true;
      result.fixture = await fixture.ready();
      assert.ok(result.fixture.tty && result.fixture.raw, "the fixture runs in a raw PTY");
      await waitSaved(ctx, page, windowId, name);
      proxy = await startTerminalCutProxy({ targetUrl: `${new URL(ctx.serverUrl).origin}/`,
        path: "/api/terminal/ws", session: row.session_id, deadlineMs: 60_000 });
      proxy.arm({ boundary: "after-ready" });
      proxy.holdRedial();
      script = await page.evaluateOnNewDocument(routeTerminal, { session: row.session_id, relay: proxy.url });
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await ctx.waitWindowLive(windowId);
      // Ready follows the server's placement update for this same session.
      await waitFor(page, card, "the reloaded terminal received ready", (value) => value.sockets[0]?.ready);
      result.attachment = await waitRestoredTerminal(page, cs, windowId, row);
      const terminal = result.attachment.selector;
      card = `${terminal} .rich-prompt`;
      await page.click(`${terminal} .terminal-host`);
      await page.keyboard.down("Control");
      await page.keyboard.down("Alt");
      await page.keyboard.press("KeyP");
      await page.keyboard.up("Alt");
      await page.keyboard.up("Control");
      await page.waitForSelector(`${card} .cm-content`, { visible: true, timeout: 15_000 });
      await page.click(`${card} .cm-content`);
      await page.keyboard.type(text);
      await waitFor(page, card, "the initial draft is editable", (value) => value.text === text && value.editable && !value.pending);
      const ready = await proxy.waitForRecord((record) => record.event === "frame" && record.connection === 1
        && record.direction === "forwarded" && record.type === "ready");
      // A later browser task has seen the mounted composer; the ready
      // handler has returned. This check makes no parser-drain assertion.
      proxy.acknowledge({ connection: 1, frame: ready.frame });
      result.cut = await proxy.waitForCut();
      assert.deepEqual(result.cut.disconnect, { client: "closed", upstream: "closed" });
      await proxy.waitForHeldRedial();
      result.held = await waitFor(page, card, "the redial is genuinely CONNECTING", (value) =>
        value.sockets.length === 2 && value.sockets[0].state === 3 && value.sockets[1].state === 0);
      assert.equal(proxy.records.filter((record) => record.event === "connection").length, 1,
        "the held redial has no upstream connection");

      await page.click(`${card} .rp-primary`);
      result.refused = await waitFor(page, card, "disconnected submit shows its refusal", (value) => value.note === NOTICE, 3000);
      assert.deepEqual(result.refused.sockets.map((socket) => socket.state), [3, 0]);
      assert.equal(result.refused.text, text);
      assert.equal(result.refused.editable, true);
      assert.equal(result.refused.pending, false);
      assert.equal(result.refused.live, "polite");
      assert.deepEqual(result.refused.prompts, []);
      assert.equal(keys(fixture), "");
      await page.click(`${card} .cm-content`);
      await page.keyboard.press("End");
      await page.keyboard.type(" revised");
      result.edited = await waitFor(page, card, "the refused draft stays editable", (value) => value.text === revised && value.editable && !value.pending);
      assert.deepEqual(result.edited.sockets.map((socket) => socket.state), [3, 0],
        "fixture precondition: the held redial has not reached its connect deadline");
      // Release before the terminal's normal connect deadline. The real
      // note lifetime is observed after reconnect, with no clock shim.
      proxy.releaseRedial();
      await ctx.shot(`290-${backend}-refusal-notice`);
      await waitFor(page, card, "the redial has received ready", (value) => value.sockets[1]?.ready && value.sockets[1].state === 1);
      // Neither reconnect nor the refusal timer may send the draft.
      result.reconnected = await waitFor(page, card, "the refusal is transient and the connected draft remains unsent", (value) => value.note === null, 7000);
      assert.equal(result.reconnected.text, revised);
      assert.equal(result.reconnected.editable, true);
      assert.equal(result.reconnected.pending, false);
      assert.deepEqual(result.reconnected.prompts, []);
      assert.equal(keys(fixture), "");
      await ctx.shot(`290-${backend}-reconnected-unsent`);
      await page.click(`${card} .rp-primary`);
      result.sent = await waitFor(page, card, "the explicit retry sends one prompt", (value) => value.prompts.length === 1);
      assert.equal(result.sent.prompts[0].data, revised);
      assert.equal(result.sent.prompts[0].connection, 2);
      assert.equal(typeof result.sent.prompts[0].id, "string");
      const id = result.sent.prompts[0].id;
      await fixture.waitFor(() => keys(fixture).includes(revised));
      result.delivered = await waitFor(page, card, "the delivered retry clears the composer", (value) =>
        value.sockets[1].delivered.includes(id) && value.text === "" && !value.pending);
      assert.equal(result.delivered.prompts.length, 1);
      assert.equal(result.delivered.note, null);
      result.ptyInput = keys(fixture);
      assert.equal(result.ptyInput.split(revised).length - 1, 1, "the PTY receives the revised text once");
      assert.deepEqual(proxy.records.filter((record) => record.event === "failure"), []);
      assert.deepEqual(result.pageErrors, []);
      await ctx.shot(`290-${backend}-delivered`);
      result.passed = true;
    } catch (error) {
      result.failure = String(error.message).replaceAll(fixture.env.TERMINAL_FIXTURE_TOKEN, "[redacted]");
      failures.push(`${backend}: ${result.failure}`);
      result.final = await state(page, card).catch(() => null);
      await ctx.shot(`290-${backend}-failure`).catch(() => {});
    } finally {
      result.proxy = proxy?.records ?? [];
      result.records = fixture.records;
      const cleanup = async (label, action) => {
        try { await action(); } catch (error) {
          result.cleanupErrors.push(`${label}: ${error.message}`);
          failures.push(`${backend}: ${label}: ${error.message}`);
          result.passed = false;
        }
      };
      if (script) await cleanup("remove routing script", () => page.removeScriptToEvaluateOnNewDocument(script.identifier));
      await cleanup("restore native socket constructor", () => page.evaluate(() => window.__prompt290?.restore()));
      await cleanup("close cut proxy", () => proxy?.close());
      await cleanup("fixture flush", () => fixture.send("barrier", { name: "cleanup" }));
      await cleanup("owned terminal cleanup", async () => {
        try { await cs(["close", "--tab-name", name]); } catch (error) { if (opened) throw error; }
      });
      await cleanup("close fixture", () => fixture.close());
      page.off("pageerror", onError);
      if (result.passed && result.pageErrors.length) {
        result.passed = false;
        failures.push(`${backend}: browser exceptions: ${result.pageErrors.join("; ")}`);
      }
      writeFileSync(join(ctx.outDir, `290-${backend}.json`),
        JSON.stringify(result, null, 2).replaceAll(fixture.env.TERMINAL_FIXTURE_TOKEN, "[redacted]") + "\n");
    }
    if (failures.length) throw new Error(failures.join("\n"));
  },
};
