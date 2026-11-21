#!/usr/bin/env node
// A main-thread stall under a fast stream, on the real WebKitGTK desktop. The
// engine keeps accepting sends through the stall and queues them in the page
// process, so what a terminal does at the end of the stall decides whether
// that backlog is parsed or thrown away. The shell driver owns the desktop and
// the display; this owns the terminal, the stall and the readings.
//
// The terminal runs `seq` once the page is stalled, then asks for the cursor
// position, which it can only answer after parsing everything ahead of the
// query. The page's socket handler checks each line of the stream against the
// next number as it arrives.
//
// Exit 0 when the socket was kept and the stream arrived whole and in order,
// 10 when it was not, 3 when a step the reading rests on did not happen.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const [inspector, work, chan, output] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const NAME = "StallNative";
const STALL_MS = Number(process.env.STALL_MS ?? 30_000);
const LINES = Number(process.env.STALL_LINES ?? 40_000_000);
// How long after the stall the socket has to show a replacement.
const SETTLE_MS = 8_000;
const DRAIN_TIMEOUT_MS = Number(process.env.STALL_DRAIN_TIMEOUT_MS ?? 300_000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Inconclusive extends Error {}

async function page(expression) {
  const { stdout } = await run("node", [path.join(here, "inspect.mjs"), inspector, "eval", "/workspace-", expression],
    { maxBuffer: 4 * 1024 * 1024, timeout: 15_000 });
  return stdout.trim() ? JSON.parse(stdout) : undefined;
}

/// Read the page, waiting out a stalled main thread, which answers nothing.
async function until(label, read, accept, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await read();
      if (accept(last)) return last;
    } catch (error) {
      last = { unreadable: String(error.message).slice(0, 200) };
    }
    if (Date.now() >= deadline) throw new Inconclusive(`${label}: ${JSON.stringify(last)}`);
    await sleep(250);
  }
}

function installTrace(tabName) {
  if (window.__stallNative) return true;
  const Native = window.WebSocket;
  const trace = window.__stallNative = { sockets: [], stall: null, lines: 0, next: 1, faults: 0, firstFault: null, begun: false, ended: false, answered: false };
  let value = 0, digits = 0, text = "";
  const line = () => {
    if (text) {
      if (text.endsWith("__B__")) trace.begun = true;
      else if (text.endsWith("__E__")) trace.ended = true;
      else if (text.endsWith("__C__")) trace.answered = true;
    } else if (digits && trace.begun && !trace.ended) {
      trace.lines += 1;
      if (value !== trace.next) {
        trace.faults += 1;
        trace.firstFault ??= { want: trace.next, got: value };
      }
      trace.next = value + 1;
    }
    value = 0; digits = 0; text = "";
  };
  const feed = (bytes) => {
    for (let i = 0; i < bytes.length; i += 1) {
      const byte = bytes[i];
      if (byte >= 48 && byte <= 57 && !text) { value = value * 10 + byte - 48; digits += 1; }
      else if (byte === 10) line();
      else if (byte !== 13 && text.length < 32) text += String.fromCharCode(byte);
    }
  };
  window.WebSocket = new Proxy(Native, {
    construct(target, args) {
      const socket = Reflect.construct(target, args);
      const url = new URL(args[0], location.href);
      if (!url.pathname.endsWith("/api/terminal/ws") || url.searchParams.get("tab_name") !== tabName) return socket;
      const record = { createdAt: Date.now(), socket, bytes: 0, ready: false, sessions: [] };
      trace.sockets.push(record);
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
          const bytes = new Uint8Array(event.data);
          record.bytes += bytes.length;
          feed(bytes);
          return;
        }
        let frame;
        try { frame = JSON.parse(event.data); } catch { return; }
        if (frame.type === "ready") record.ready = true;
        if (frame.type === "session") record.sessions.push({ missed: frame.missed_bytes ?? 0 });
      });
      return socket;
    },
  });
  trace.startStall = (ms) => {
    trace.stall = { start: null, end: null };
    setTimeout(() => {
      trace.stall.start = Date.now();
      while (Date.now() < trace.stall.start + ms) { /* hold the main thread */ }
      trace.stall.end = Date.now();
    }, 100);
    return true;
  };
  trace.read = () => ({
    stall: trace.stall, lines: trace.lines, next: trace.next, faults: trace.faults, firstFault: trace.firstFault,
    begun: trace.begun, ended: trace.ended, answered: trace.answered,
    sockets: trace.sockets.map((record) => ({ createdAt: record.createdAt, state: record.socket.readyState, bytes: record.bytes, ready: record.ready, sessions: record.sessions })),
  });
  return true;
}

const readTrace = () => page("window.__stallNative.read()");

async function main() {
  const go = path.join(work, "stall-go");
  const env = { ...process.env };
  await page(`(${installTrace.toString()})(${JSON.stringify(NAME)})`);
  const command = [
    "stty -echo -icanon", "printf '\\n__B__\\n'",
    'while [ ! -e "$STALL_GO" ]; do sleep 0.02; done',
    `seq 1 ${LINES}`, "printf '__E__\\n'", "printf '\\033[6n'",
    "IFS= read -r -d R reply", "printf '\\n__C__\\n'", "exec sleep 900",
  ].join("; ");
  await run(chan, ["shell", "terminal", "new", "--tab-name", NAME, "--command", command, "--env", `STALL_GO=${go}`],
    { env, timeout: 30_000 });
  await until("the terminal attached and began", readTrace, (seen) => seen.begun && seen.sockets.at(-1)?.ready, 60_000);
  const backend = await page(`document.querySelectorAll(".terminal-tab.active .terminal-host > canvas").length`);
  if (!backend) throw new Inconclusive("the active terminal is not on the ghostty backend");

  await page(`window.__stallNative.startStall(${STALL_MS})`);
  await sleep(400);
  fs.writeFileSync(go, "");
  const stall = (await until("the stall ended", readTrace, (seen) => seen.stall?.end, STALL_MS + 60_000)).stall;
  if (stall.end - stall.start < STALL_MS) throw new Inconclusive(`stalled only ${stall.end - stall.start} ms`);
  const atStallEnd = await readTrace();

  // The stream ends on the socket that survived, or, after a replacement,
  // on what the replay and the live stream left of it.
  let drained = true;
  const drainStarted = Date.now();
  await until("the parser reached the end of the stream", readTrace, (seen) => seen.answered, DRAIN_TIMEOUT_MS)
    .catch((error) => { if (!(error instanceof Inconclusive)) throw error; drained = false; });
  const drainMs = Date.now() - drainStarted;
  await sleep(SETTLE_MS);
  const seen = await readTrace();
  const missed = seen.sockets.flatMap((socket) => socket.sessions).map((session) => session.missed);
  const reading = {
    stallMs: stall.end - stall.start,
    linesExpected: LINES,
    linesInOrder: seen.lines - seen.faults,
    lines: seen.lines,
    faults: seen.faults,
    firstFault: seen.firstFault,
    sockets: seen.sockets.length,
    socketBytes: seen.sockets.map((socket) => socket.bytes),
    bytesAtStallEnd: atStallEnd.sockets.map((socket) => socket.bytes),
    missed,
    drained,
    drainMs,
  };
  fs.writeFileSync(path.join(output, "results.json"), `${JSON.stringify(reading, null, 2)}\n`);
  console.log(JSON.stringify(reading));
  const held = reading.sockets === 1 && missed.every((count) => count === 0) && reading.faults === 0
    && reading.lines === LINES && drained;
  if (!held) {
    console.log(`FAULT: sockets=${reading.sockets} missed=${JSON.stringify(missed)} lines=${reading.lines}/${LINES} faults=${reading.faults} drained=${drained}`);
    return 10;
  }
  console.log(`held: one socket, ${LINES} lines whole and in order, drained in ${drainMs} ms`);
  return 0;
}

main().then((status) => { process.exitCode = status; }, (error) => {
  console.error(`INCONCLUSIVE: ${error.message}`);
  process.exitCode = 3;
});
