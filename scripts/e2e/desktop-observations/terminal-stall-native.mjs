#!/usr/bin/env node
// A main-thread stall under a fast stream, on the real WebKitGTK desktop. The
// engine keeps accepting sends through the stall and queues them in the page
// process, so what a terminal does at the end of the stall decides whether
// that backlog is parsed or thrown away. The shell driver owns the desktop and
// the display; this owns the terminals, the devserver, the stall and the
// readings.
//
// Two arms, because the wake path differs by connection:
// - local: a window of the desktop's embedded server, which takes no wake
//   probe. The stall runs past the 45 s read deadline, whose close a queued
//   frame must cancel.
// - devserver: a window of a direct devserver, whose socket is probed at the
//   wake and must be kept, with the pong queued behind the backlog.
//
// In each, the terminal runs `seq` once the page is stalled, then asks for the
// cursor position, which it can only answer after parsing everything ahead of
// the query. The page's socket handler checks each line against the next
// number as it arrives.
//
// Exit 0 when each socket was kept and each stream arrived whole and in order,
// 10 when one was not, 3 when a step the readings rest on did not happen.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const [inspector, work, chan, output] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_STALL_MS = Number(process.env.STALL_LOCAL_MS ?? 50_000);
const DEVSERVER_STALL_MS = Number(process.env.STALL_MS ?? 30_000);
const LINES = Number(process.env.STALL_LINES ?? 15_000_000);
// How long after the stall a socket has to show a replacement.
const SETTLE_MS = 12_000;
const DRAIN_TIMEOUT_MS = Number(process.env.STALL_DRAIN_TIMEOUT_MS ?? 300_000);
// A window after the stall in which the heartbeat's one overdue ping may run,
// and in which a wake probe adds its own.
const PING_WINDOW_MS = 4_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const secrets = [];
const mask = (text) => secrets.reduce((s, secret) => s.replaceAll(secret, "<token>"), String(text))
  .replace(/([?&]t=)[^&\s"']+/g, "$1<token>");

class Inconclusive extends Error {}

/// The value of `expression` in the page of the window `windowId`.
async function inPage(windowId, expression) {
  const guarded = `(() => {
    if (new URL(location.href).searchParams.get('w') !== ${JSON.stringify(windowId)}) return { skip: true };
    return { value: (${expression}) };
  })()`;
  const { stdout } = await run(process.execPath, [path.join(here, "inspect.mjs"), inspector, "all", guarded],
    { maxBuffer: 1 << 22, timeout: 30_000 });
  for (const line of stdout.trim().split("\n").filter(Boolean)) {
    const page = JSON.parse(line);
    if (page.value && !page.value.skip) return page.value.value;
  }
  throw new Error("the window's page did not answer");
}

/// Read until accepted, waiting out a stalled main thread, which answers nothing.
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
    if (Date.now() >= deadline) throw new Inconclusive(`${label}: ${mask(JSON.stringify(last))}`);
    await sleep(250);
  }
}

function installTrace(tabName) {
  if (window.__stallNative) return true;
  const Native = window.WebSocket;
  const trace = window.__stallNative = { sockets: [], pings: [], stall: null, lines: 0, next: 1, faults: 0, firstFault: null, begun: false, ended: false, answered: false };
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
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (data === '{"type":"ping"}') trace.pings.push(Date.now());
        return send(data);
      };
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
    begun: trace.begun, ended: trace.ended, answered: trace.answered, pings: trace.pings.slice(-64),
    sockets: trace.sockets.map((record) => ({ createdAt: record.createdAt, state: record.socket.readyState, bytes: record.bytes, ready: record.ready, sessions: record.sessions })),
  });
  return true;
}

/// One stall under one stream in the window `windowId`. `probed` says whether
/// this connection takes a wake probe.
async function stallArm({ label, windowId, env, stallMs, probed }) {
  const name = `Stall${label}`;
  const go = path.join(work, `stall-go-${label}`);
  const readTrace = () => inPage(windowId, "window.__stallNative.read()");
  await inPage(windowId, `(${installTrace.toString()})(${JSON.stringify(name)})`);
  const command = [
    "stty -echo -icanon", "printf '\\n__B__\\n'",
    'while [ ! -e "$STALL_GO" ]; do sleep 0.02; done',
    `seq 1 ${LINES}`, "printf '__E__\\n'", "printf '\\033[6n'",
    "IFS= read -r -d R reply", "printf '\\n__C__\\n'", "exec sleep 900",
  ].join("; ");
  await run(chan, ["shell", "terminal", "new", "--window", windowId, "--tab-name", name, "--command", command, "--env", `STALL_GO=${go}`],
    { env, timeout: 30_000 });
  await until(`${label}: the terminal attached and began`, readTrace, (seen) => seen.begun && seen.sockets.at(-1)?.ready, 60_000);
  const ghostty = await inPage(windowId, `document.querySelectorAll(".terminal-tab.active .terminal-host > canvas").length`);
  if (!ghostty) throw new Inconclusive(`${label}: the active terminal is not on the ghostty backend`);

  await inPage(windowId, `window.__stallNative.startStall(${stallMs})`);
  await sleep(400);
  fs.writeFileSync(go, "");
  const stall = (await until(`${label}: the stall ended`, readTrace, (seen) => seen.stall?.end, stallMs + 60_000)).stall;
  if (stall.end - stall.start < stallMs) throw new Inconclusive(`${label}: stalled only ${stall.end - stall.start} ms`);
  const atStallEnd = await readTrace();

  // The stream ends on the socket that survived, or, after a replacement,
  // on what the replay and the live stream left of it.
  let drained = true;
  const drainStarted = Date.now();
  await until(`${label}: the parser reached the end of the stream`, readTrace, (seen) => seen.answered, DRAIN_TIMEOUT_MS)
    .catch((error) => { if (!(error instanceof Inconclusive)) throw error; drained = false; });
  const drainMs = Date.now() - drainStarted;
  await sleep(SETTLE_MS);
  const seen = await readTrace();
  const missed = seen.sockets.flatMap((socket) => socket.sessions).map((session) => session.missed);
  const pingsAfterStall = seen.pings.filter((at) => at >= stall.end && at < stall.end + PING_WINDOW_MS).length;
  const reading = {
    label, probed, stallMs: stall.end - stall.start,
    linesExpected: LINES, lines: seen.lines, faults: seen.faults, firstFault: seen.firstFault,
    sockets: seen.sockets.length,
    socketBytes: seen.sockets.map((socket) => socket.bytes),
    bytesAtStallEnd: atStallEnd.sockets.map((socket) => socket.bytes),
    missed, drained, drainMs, pingsAfterStall,
  };
  const whole = reading.sockets === 1 && missed.every((count) => count === 0) && reading.faults === 0
    && reading.lines === LINES && drained;
  // The heartbeat is overdue after a stall and sends one ping; a probe is one more.
  const probeAsExpected = probed ? pingsAfterStall >= 2 : pingsAfterStall <= 1;
  reading.held = whole && probeAsExpected;
  console.log(`${label}: ${JSON.stringify(reading)}`);
  if (!whole) {
    console.log(`FAULT ${label}: sockets=${reading.sockets} missed=${JSON.stringify(missed)} lines=${reading.lines}/${LINES} faults=${reading.faults} drained=${drained}`);
  } else if (!probeAsExpected) {
    console.log(`FAULT ${label}: ${pingsAfterStall} pings in the ${PING_WINDOW_MS} ms after the stall, ${probed ? "expected a wake probe" : "expected no wake probe"}`);
  } else {
    console.log(`held ${label}: one socket, ${LINES} lines whole and in order, drained in ${drainMs} ms, ${pingsAfterStall} pings after the stall`);
  }
  return reading;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/// A direct devserver with one of its terminal windows open on the desktop.
async function openDevserverWindow(logs, started) {
  const devHome = path.join(work, "devserver-home");
  fs.mkdirSync(devHome);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(chan, ["devserver", "run", "--service=none", "--bind=127.0.0.1", `--port=${port}`], {
    env: { ...process.env, CHAN_HOME: devHome, CHAN_WINDOW_ID: "", CHAN_CONTROL_SOCKET: "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  started(server);
  server.stdout.on("data", (data) => logs.push(data.toString()));
  server.stderr.on("data", (data) => logs.push(data.toString()));
  await until("the devserver started", async () => {
    if (server.exitCode !== null) throw new Inconclusive("the devserver exited during startup");
    return (await fetch(`${base}/api/devserver/info`, { signal: AbortSignal.timeout(1000) })).ok;
  }, Boolean, 60_000);
  const token = JSON.parse(fs.readFileSync(path.join(devHome, "devserver/config.json"))).devserver_token;
  secrets.push(token);
  const cliEnv = { ...process.env };
  delete cliEnv.CHAN_WINDOW_ID;
  delete cliEnv.CHAN_CONTROL_SOCKET;
  await run(chan, ["devserver", "register", `${base}/?t=${token}`, "--name", "stall"], { env: cliEnv, timeout: 90_000 });
  await run(chan, ["devserver", "connect", "stall"], { env: cliEnv, timeout: 90_000 });
  await until("the desktop connected to the devserver", async () => {
    const { stdout } = await run(chan, ["devserver", "ls", "--json"], { env: cliEnv, timeout: 30_000 });
    return JSON.parse(stdout).devservers.some((entry) => entry.label === "stall" && entry.status === "connected");
  }, Boolean, 60_000);
  const response = await fetch(`${base}/api/library/windows`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ kind: "terminal" }), signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Inconclusive(`opening a devserver window: HTTP ${response.status}`);
  const opened = await response.json();
  secrets.push(opened.token);
  const windowId = opened.window_id;
  await until("the devserver's window opened", () => inPage(windowId, "document.readyState"), (state) => state === "complete", 60_000);
  const lib = await inPage(windowId, "new URLSearchParams(location.search).get('lib')");
  if (!lib || lib === "local") throw new Inconclusive(`the devserver's window reads library ${lib}`);
  // A devserver's socket is named for its home, not its pid, and the window
  // answers on it only once its page has registered.
  const control = await until("a control socket reaches the devserver's window", async () => {
    for (const entry of fs.readdirSync(process.env.XDG_RUNTIME_DIR)) {
      if (!entry.startsWith("chan-control-")) continue;
      const candidate = path.join(process.env.XDG_RUNTIME_DIR, entry);
      try {
        await run(chan, ["shell", "pane", "list", "--window", windowId, "--json"],
          { env: { ...cliEnv, CHAN_CONTROL_SOCKET: candidate, CHAN_WINDOW_ID: windowId }, timeout: 15_000 });
        return candidate;
      } catch { /* another tenant's socket, or the window is not live yet */ }
    }
    return null;
  }, Boolean, 60_000);
  return { windowId, env: { ...cliEnv, CHAN_CONTROL_SOCKET: control, CHAN_WINDOW_ID: windowId } };
}

async function main() {
  const logs = [];
  const readings = [];
  let server = null;
  try {
    readings.push(await stallArm({
      label: "Local", windowId: process.env.CHAN_WINDOW_ID, env: { ...process.env }, stallMs: LOCAL_STALL_MS, probed: false,
    }));
    const devserver = await openDevserverWindow(logs, (child) => { server = child; });
    readings.push(await stallArm({
      label: "Devserver", windowId: devserver.windowId, env: devserver.env, stallMs: DEVSERVER_STALL_MS, probed: true,
    }));
  } finally {
    server?.kill();
    fs.writeFileSync(path.join(output, "devserver.log"), mask(logs.join("")));
    fs.writeFileSync(path.join(output, "results.json"), `${mask(JSON.stringify(readings, null, 2))}\n`);
  }
  return readings.every((reading) => reading.held) ? 0 : 10;
}

main().then((status) => { process.exitCode = status; }, (error) => {
  console.error(`INCONCLUSIVE: ${mask(error.message)}`);
  process.exitCode = 3;
});
