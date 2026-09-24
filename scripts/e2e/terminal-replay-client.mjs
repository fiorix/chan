#!/usr/bin/env node
// A long-lived terminal WebSocket client for devserver-terminal-replay.sh.
//
// It holds one socket per terminal across devserver restarts, redialing with
// the SPA's capped backoff, and writes what the terminal was sent:
//   <out>/<name>.screen   every byte written to the terminal view, in order:
//                         PTY bytes (replay and live) plus any line the SPA
//                         prints itself ("terminal replay missed N bytes",
//                         "terminal error: ...", "session ended (...)")
//   <out>/<name>.events   one JSON line per dial, prelude and control frame
//   <out>/<name>.state    the latest cursor and counters, rewritten per frame
//
// --mode keep   resumes every redial from the byte cursor and generation of
//               the last prelude it saw, across failed dials and across the
//               `closed` frame with reason `shutdown` a graceful restart sends
//               as it detaches a parked session: the server's resume contract,
//               and what the screen must match.
// --mode fresh  dials once with since=0 and no generation and exits at the
//               ready frame: the attach of a brand-new view, which is what a
//               window the SPA reloads after a restart makes when it has no
//               cached snapshot for the terminal (always on the ghostty
//               backend). Its screen is the replay alone and its state carries
//               missed_bytes.
//
// Usage: terminal-replay-client.mjs --base URL --chan-home DIR --out DIR
//          --mode keep|fresh --term NAME:SESSION:WINDOW:FOCUSED [--term ...]

import fs from "node:fs";
import path from "node:path";

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 8_000;
const PING_MS = 20_000;

function parseArgs(argv) {
  const opts = { terms: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) usage(`missing value for ${flag}`);
    if (flag === "--base") opts.base = value;
    else if (flag === "--chan-home") opts.chanHome = value;
    else if (flag === "--out") opts.out = value;
    else if (flag === "--mode") opts.mode = value;
    else if (flag === "--term") {
      const [name, session, window, focused] = value.split(":");
      if (!name || !session || !window || !["0", "1"].includes(focused)) {
        usage(`bad --term ${value}`);
      }
      opts.terms.push({ name, session, window, focused: focused === "1" });
    } else usage(`unknown flag ${flag}`);
  }
  if (!opts.base || !opts.chanHome || !opts.out || !opts.terms.length) usage("missing flags");
  if (!["keep", "fresh"].includes(opts.mode)) usage("--mode must be keep or fresh");
  return opts;
}

function usage(message) {
  console.error(`terminal-replay-client: ${message}`);
  console.error(
    "usage: terminal-replay-client.mjs --base URL --chan-home DIR --out DIR --mode keep|fresh --term NAME:SESSION:WINDOW:FOCUSED ...",
  );
  process.exit(2);
}

if (typeof WebSocket !== "function") {
  console.error("terminal-replay-client: this client needs Node's WebSocket implementation");
  process.exit(2);
}

const opts = parseArgs(process.argv.slice(2));
fs.mkdirSync(opts.out, { recursive: true });

// The window's tenant prefix and token, read fresh on every dial: a devserver
// restart re-mounts the tenants, so a route cached from the previous process
// proves nothing about the next one.
async function windowRoute(windowId) {
  const config = JSON.parse(
    fs.readFileSync(path.join(opts.chanHome, "devserver", "config.json"), "utf8"),
  );
  const res = await fetch(`${opts.base}/api/library/windows`, {
    headers: { Authorization: `Bearer ${config.devserver_token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`windows listing answered ${res.status}`);
  const row = (await res.json()).find((r) => r.window_id === windowId);
  if (!row) throw new Error(`window ${windowId} is not listed`);
  return { prefix: row.prefix, token: row.token };
}

class Terminal {
  constructor(spec) {
    Object.assign(this, spec);
    this.screenPath = path.join(opts.out, `${spec.name}.screen`);
    this.eventsPath = path.join(opts.out, `${spec.name}.events`);
    this.statePath = path.join(opts.out, `${spec.name}.state`);
    fs.writeFileSync(this.screenPath, "");
    fs.writeFileSync(this.eventsPath, "");
    this.seq = 0;
    this.generation = null;
    this.replayActive = false;
    this.connected = false;
    this.dials = 0;
    this.failedDials = 0;
    this.preludes = 0;
    this.readies = 0;
    this.printed = [];
    this.missedBytes = 0;
    this.backoff = BACKOFF_MIN_MS;
    this.ws = null;
    this.ping = null;
    this.writeState();
  }

  event(record) {
    fs.appendFileSync(
      this.eventsPath,
      `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`,
    );
  }

  // A line the SPA writes into the terminal itself, not PTY output.
  print(line) {
    this.printed.push(line);
    fs.appendFileSync(this.screenPath, `\r\n${line}\r\n`);
    this.event({ type: "printed", line });
  }

  writeState() {
    const state = {
      name: this.name,
      mode: opts.mode,
      connected: this.connected,
      seq: this.seq,
      generation: this.generation,
      dials: this.dials,
      failed_dials: this.failedDials,
      preludes: this.preludes,
      readies: this.readies,
      replay_active: this.replayActive,
      printed: this.printed,
      missed_bytes: this.missedBytes,
      screen_bytes: fs.statSync(this.screenPath).size,
    };
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, this.statePath);
  }

  scheduleRedial() {
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    setTimeout(() => void this.dial(), delay);
  }

  async dial() {
    this.dials += 1;
    const since = this.seq;
    const generation = this.generation;
    let route;
    try {
      route = await windowRoute(this.window);
    } catch (error) {
      this.failedDials += 1;
      this.event({ type: "dial_failed", stage: "route", error: String(error.message ?? error) });
      this.writeState();
      this.scheduleRedial();
      return;
    }
    const query = new URLSearchParams({
      cols: "80",
      rows: "24",
      tab_name: this.name,
      window_id: this.window,
      session: this.session,
      since: String(since),
      t: route.token,
    });
    if (generation !== null) query.set("generation", String(generation));
    const url = `${opts.base.replace(/^http/, "ws")}${route.prefix}/api/terminal/ws?${query}`;
    this.event({ type: "dial", since, generation });
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    let opened = false;
    ws.addEventListener("open", () => {
      opened = true;
      this.connected = true;
      ws.send(JSON.stringify({ type: "focus", focused: this.focused }));
      this.ping = setInterval(() => {
        try {
          ws.send(JSON.stringify({ type: "ping" }));
        } catch {}
      }, PING_MS);
      this.writeState();
    });
    ws.addEventListener("message", (event) => this.onMessage(event));
    ws.addEventListener("close", (event) => {
      clearInterval(this.ping);
      this.connected = false;
      if (!opened) this.failedDials += 1;
      this.event({ type: "close", opened, code: event.code, reason: event.reason });
      this.writeState();
      if (this.ended) return;
      if (opts.mode === "fresh") {
        console.error(`terminal-replay-client: ${this.name} closed before its replay finished`);
        process.exit(1);
      }
      this.scheduleRedial();
    });
    ws.addEventListener("error", () => {});
  }

  onMessage(event) {
    if (typeof event.data !== "string") {
      const bytes = Buffer.from(event.data);
      fs.appendFileSync(this.screenPath, bytes);
      // Replay chunks rebuild history up to the prelude seq already adopted.
      if (!this.replayActive) this.seq += bytes.length;
      this.writeState();
      return;
    }
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    if (frame.type === "session") {
      this.preludes += 1;
      this.backoff = BACKOFF_MIN_MS;
      this.replayActive = true;
      this.seq = frame.seq;
      this.generation = frame.generation;
      this.event({
        type: "session",
        seq: frame.seq,
        generation: frame.generation,
        missed_bytes: frame.missed_bytes ?? 0,
      });
      const missed = Math.max(0, Math.floor(frame.missed_bytes ?? 0));
      this.missedBytes = missed;
      // A fresh probe's screen is the replay alone, compared byte for byte.
      if (missed > 0 && opts.mode !== "fresh") this.print(`terminal replay missed ${missed} bytes`);
    } else if (frame.type === "ready") {
      this.readies += 1;
      this.replayActive = false;
      this.event({ type: "ready" });
      if (opts.mode === "fresh") {
        this.ended = true;
        this.writeState();
        this.ws?.close();
        const done = terminals.every((terminal) => terminal.ended);
        if (done) setTimeout(() => process.exit(0), 100);
        return;
      }
    } else if (frame.type === "error") {
      const detail = frame.message ?? frame.reason ?? "unknown error";
      this.event({ type: "error", detail });
      if (!detail.includes("unknown variant `ping`")) this.print(`terminal error: ${detail}`);
    } else if (frame.type === "closed" && frame.reason === "shutdown") {
      // A graceful restart detaching a parked session; the next process
      // adopts it under the same id, so this client redials.
      this.event({ type: "closed", reason: frame.reason });
    } else if (frame.type === "closed") {
      this.ended = true;
      this.print(`session ended (${frame.reason})`);
    } else if (frame.type === "exit") {
      this.ended = true;
      this.print("process exited");
    }
    this.writeState();
  }
}

const terminals = opts.terms.map((spec) => new Terminal(spec));
for (const terminal of terminals) void terminal.dial();
if (opts.mode === "fresh") {
  setTimeout(() => {
    console.error("terminal-replay-client: fresh attach did not finish within 30s");
    process.exit(1);
  }, 30_000);
}

function shutdown() {
  for (const terminal of terminals) {
    terminal.ended = true;
    try {
      terminal.ws?.close();
    } catch {}
  }
  setTimeout(() => process.exit(0), 200);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
