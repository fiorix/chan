// A ghostty view whose page stops under an endless `yes`, in headless Chrome.
//
// The page's main thread is stopped twice by a busy loop. A 3 s stall is
// inside the 5 s bound: the view catches up with no recovery and no loss. A
// 30 s stall is past it: the program goes on, what the page had queued when
// it came back is at most the advertised window, and the view resumes from
// the ring, on its socket or a redial, with a count of what it missed and no
// lag line.
//
// A second view of the session runs here in Node on the terminal socket's own
// protocol, so a stall of the page cannot stop it. It acknowledges what it
// reads and checks every byte against the flood's repeating line: it must
// stay whole, with no recovery, and never wait longer than the bound plus a
// scheduling margin. At the end Ctrl+C reaches the program through the
// stalled view's socket, and both views must agree on the stream's position.
//
// It says nothing about WebKit, whose stall the desktop driver reads, or
// about the xterm.js engine.

import assert from "node:assert/strict";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { readTerminalPrefs, restoreTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";
import {
  installStreamProbe, readGhosttyText, sleep, trackGhosttyTerminals, until,
} from "../lib/stream-probe.mjs";

const NAME = "StalledView335";
const PROMPT = "__P335__";
const MARK = "__FLOOD335__\r\n";
const LINE = Buffer.from("the quick brown fox\r\n");
const SHORT_STALL_MS = 3_000;
const LONG_STALL_MS = 30_000;
/// The 5 s bound, plus room for a loaded four-CPU guest to schedule the wake.
const MAX_HOLD_MS = 8_000;

/// The second view: reads, verifies and acknowledges like a live client.
function openSecondView(ctx, token, session) {
  const url = new URL("/api/terminal/ws", ctx.serverUrl);
  url.search = new URLSearchParams({ session, since: "0", ack: "1", t: token }).toString();
  url.protocol = url.protocol.replace("http", "ws");
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const view = {
    socket, open: false, ready: false, window: null, generation: null, position: 0, reported: 0, replayLeft: 0,
    bytes: 0, sessions: 0, missed: 0, errors: [], lastFrameAt: 0, maxGapMs: 0, gapFrom: null,
    marked: false, seen: "", phase: 0, checked: 0, mismatch: null, verifying: true,
  };
  const verify = (bytes) => {
    let index = 0;
    if (!view.marked) {
      view.seen = (view.seen + Buffer.from(bytes).toString("latin1")).slice(-(1 << 16));
      const at = view.seen.indexOf(MARK);
      if (at < 0) { view.seen = view.seen.slice(-MARK.length); return; }
      view.marked = true;
      const rest = view.seen.length - at - MARK.length;
      index = bytes.length - rest;
    }
    for (; index < bytes.length && !view.mismatch; index += 1) {
      if (bytes[index] !== LINE[view.phase]) {
        view.mismatch = { checked: view.checked, byte: bytes[index], wanted: LINE[view.phase] };
        break;
      }
      view.phase = (view.phase + 1) % LINE.length;
      view.checked += 1;
    }
  };
  const report = () => {
    if (view.window === null || view.position <= view.reported) return;
    view.reported = view.position;
    socket.send(JSON.stringify({ type: "ack", generation: view.generation, seq: view.position }));
  };
  const timer = setInterval(report, 50);
  socket.addEventListener("open", () => { view.open = true; });
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      const frame = JSON.parse(event.data);
      if (frame.type === "session") {
        view.sessions += 1;
        view.missed += frame.missed_bytes ?? 0;
        view.window = frame.ack_window ?? null;
        view.generation = frame.generation;
        view.replayLeft = frame.replay_bytes ?? 0;
        view.position = frame.seq - view.replayLeft;
        view.reported = view.position;
      } else if (frame.type === "ready") view.ready = true;
      else if (frame.type === "error") view.errors.push(String(frame.message));
      return;
    }
    const bytes = new Uint8Array(event.data);
    const now = Date.now();
    if (view.gapFrom !== null && view.lastFrameAt) {
      const gap = now - Math.max(view.lastFrameAt, view.gapFrom);
      if (gap > view.maxGapMs) view.maxGapMs = gap;
    }
    view.lastFrameAt = now;
    view.bytes += bytes.length;
    const raw = view.ready ? bytes.length : Math.min(bytes.length, view.replayLeft);
    if (!view.ready) view.replayLeft -= raw;
    view.position += raw;
    if (view.verifying) verify(bytes);
    if (view.window !== null && view.position - view.reported >= view.window / 8) report();
  });
  view.close = () => { clearInterval(timer); socket.close(); };
  return view;
}

export default {
  name: "terminal-stalled-view-bounded",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
    await page.bringToFront();
    const windowId = await page.evaluate(() => new URL(location.href).searchParams.get("w")?.trim()
      || sessionStorage.getItem("chan.session.window")?.trim() || "");
    assert.ok(windowId, "the page's window id");
    await ctx.waitWindowLive(windowId);
    const cs = (args) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
      cwd: ctx.workspaceDir,
      env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId },
      timeout: 90_000,
    });
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const original = await readTerminalPrefs(page, token);
    let second = null;
    try {
      await writeTerminalPrefs(page, token, { ghostty: true, secret_masking: false });
      assert.ok(await trackGhosttyTerminals(page), "the entry module names a ghostty-web chunk");
      await page.evaluate(installStreamProbe);
      const shell = `stty -echo; export PS1='${PROMPT} '; unset PROMPT_COMMAND; exec /bin/bash --noprofile --norc -i`;
      await openAttachedTerminal(ctx, page, cs, windowId, NAME, "ghostty", ["--command", shell]);
      const read = () => page.evaluate((name) => __streamProbe.read(name), NAME);
      const attached = await until("the page's socket is ready", read, (state) => state?.ready);
      second = openSecondView(ctx, token, attached.sessions[0].id);
      await until("the second view is ready", async () => second.ready, Boolean);

      await page.evaluate((name) => __streamProbe.input(
        name, "printf '__FLOOD335__\\n'; yes 'the quick brown fox'\r",
      ), NAME);
      await until("the flood reaches both views", read, (state) => state.handled > 1 << 18 && second.checked > 1 << 18);

      // Inside the bound: nothing is lost and nothing recovers.
      await page.evaluate((name, ms) => __streamProbe.stall(name, ms), NAME, SHORT_STALL_MS);
      await sleep(SHORT_STALL_MS + 500);
      const afterShort = await until("the page runs after the short stall", read, (state) => state.stalls[0]?.ended);
      await sleep(1_000);
      const settled = await read();
      assert.deepEqual(settled.errors, [], "no lag line after a stall inside the bound");
      assert.equal(settled.sessions.length, 1, "a stall inside the bound needs no recovery");
      assert.ok(settled.handled > afterShort.stalls[0].handled, "the view caught up and goes on");

      // Past the bound.
      const before = second.bytes;
      second.gapFrom = Date.now();
      second.maxGapMs = 0;
      await page.evaluate((name, ms) => __streamProbe.stall(name, ms), NAME, LONG_STALL_MS);
      await sleep(LONG_STALL_MS);
      const during = second.bytes - before;
      const maxHoldMs = second.maxGapMs;
      second.gapFrom = null;
      // The view comes back on its socket or, when the page takes the long
      // timer gap for a sleep, on a redial. Each carries the count.
      const views = await until("the stalled view resumes", async () => {
        try { return await page.evaluate((name) => __streamProbe.readAll(name), NAME); } catch { return null; }
      }, (all) => {
        const at = all?.findIndex((entry) => entry.stalls[1]) ?? -1;
        if (at < 0 || !all[at].stalls[1].ended) return false;
        return all[at].sessions.length > 1 || all[at].errors.length > 0 || (at < all.length - 1 && all.at(-1).ready);
      }, 90_000);
      const held = views.find((entry) => entry.stalls[1]);
      const latest = views.at(-1);
      const sameSocket = held.sessions.length > 1;
      assert.deepEqual([...held.errors, ...(sameSocket ? [] : latest.errors)], [], "the lag line is gone");
      const recovery = sameSocket ? held.sessions[1] : latest.sessions[0];
      assert.ok(recovery.window > 0, "the server advertised a window");
      const queued = (sameSocket ? recovery.handledBefore : held.handled) - held.stalls[1].handled;
      assert.ok(queued <= recovery.window,
        `the page queued ${queued} bytes during the stall, past the ${recovery.window} byte window`);
      assert.ok(recovery.missed > 0, "a 30 s flood outruns the ring, and the loss is counted");
      assert.ok(held.acks > 0, "the view acknowledged what it parsed");

      assert.ok(maxHoldMs <= MAX_HOLD_MS, `the second view waited ${maxHoldMs} ms`);
      assert.ok(during > 4 * 1024 * 1024, `the second view kept receiving: ${during} bytes in the stall`);
      assert.equal(second.sessions, 1, "the second view needed no recovery");
      assert.deepEqual(second.errors, [], "the second view printed no error");
      assert.equal(second.mismatch, null, "the second view holds every byte, once and in order");

      // Ctrl+C reaches the program through the view that was stalled.
      second.verifying = false;
      await page.evaluate((name) => __streamProbe.input(name, "\x03"), NAME);
      let quiet = second.bytes;
      await until("the flood stops", async () => {
        const stopped = second.bytes === quiet;
        quiet = second.bytes;
        await sleep(700);
        return stopped && second.bytes === quiet;
      }, Boolean, 30_000);
      const final = await until("both views reach one position", read,
        (state) => state.ready && state.cursor === second.position, 30_000);
      const retained = await readGhosttyText(page);
      const notices = await page.evaluate(() => __terminalNotices);
      assert.deepEqual(notices, [`terminal replay missed ${recovery.missed} bytes`],
        "the terminal says once how many bytes it missed, and prints no error");
      assert.ok(!retained.text.includes("terminal output lagged"), "no lag line in the buffer");
      assert.ok(retained.text.includes(PROMPT), "the shell's prompt came back after Ctrl+C");
      await ctx.shot("335-after-stall");
      return {
        resumedBy: sameSocket ? "socket" : "redial", sockets: views.length, notices,
        queued, window: recovery.window, missed: recovery.missed, secondViewMaxHoldMs: maxHoldMs,
        secondViewBytesDuringStall: during, secondViewChecked: second.checked, cursor: final.cursor, acks: final.acks,
      };
    } finally {
      second?.close();
      await cs(["close", "--tab-name", NAME]).catch(() => {});
      await restoreTerminalPrefs(ctx, page, token, original);
    }
  },
};
