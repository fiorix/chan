// What a page's terminal socket carried, read from inside the page: bytes and
// frames handed to the app, the session frames, error lines, acknowledgements
// and the raw stream cursor the app should hold. It keeps counters, never
// payloads, so a flood costs the page little.

/// Runs in the page, before the app opens the socket it observes.
export function installStreamProbe() {
  if (globalThis.__streamProbe) return;
  const Native = globalThis.WebSocket;
  const setHandler = Object.getOwnPropertyDescriptor(Native.prototype, "onmessage").set;
  const sockets = [];
  // A redial replays from the cursor, so one stream outlives its sockets.
  const verifiers = new Map();
  const view = (entry) => ({
    name: entry.name, askedAck: entry.askedAck, handled: entry.handled, frames: entry.frames,
    acks: entry.acks, lastAck: entry.lastAck, sessions: entry.sessions, errors: entry.errors,
    cursor: entry.cursor, ready: entry.ready, stalls: entry.stalls,
    verifier: verifiers.get(entry.name)?.state ?? null,
    socketCount: sockets.filter((other) => other.name === entry.name).length,
    allErrors: sockets.filter((other) => other.name === entry.name).flatMap((other) => other.errors),
  });
  globalThis.WebSocket = class extends Native {
    constructor(url, protocols) {
      super(url, protocols);
      const parsed = new URL(url, location.href);
      if (!parsed.pathname.endsWith("/api/terminal/ws")) return;
      const entry = {
        peer: this, name: parsed.searchParams.get("tab_name"), askedAck: parsed.searchParams.get("ack"),
        handled: 0, frames: 0, acks: 0, lastAck: null, sessions: [], errors: [], cursor: null, ready: false,
        stalls: [],
      };
      sockets.push(entry);
      const send = this.send.bind(this);
      this.send = (data) => {
        if (typeof data === "string" && data.startsWith('{"type":"ack"')) {
          entry.acks += 1;
          entry.lastAck = JSON.parse(data).seq;
        }
        return send(data);
      };
      let handler;
      Object.defineProperty(this, "onmessage", {
        configurable: true,
        get: () => handler,
        set: (value) => {
          handler = value;
          setHandler.call(this, typeof value !== "function" ? value : (event) => {
            if (event.data instanceof ArrayBuffer) {
              entry.handled += event.data.byteLength;
              entry.frames += 1;
              if (entry.ready) entry.cursor += event.data.byteLength;
              verifiers.get(entry.name)?.push(new Uint8Array(event.data), {
                socket: sockets.indexOf(entry), frame: entry.frames, ready: entry.ready, session: entry.sessions.length,
              });
            } else if (typeof event.data === "string") {
              let frame = null;
              try { frame = JSON.parse(event.data); } catch { /* not a control frame */ }
              if (frame?.type === "session") {
                entry.cursor = frame.seq;
                entry.ready = false;
                entry.sessions.push({
                  id: frame.id, seq: frame.seq, missed: frame.missed_bytes ?? 0, replay: frame.replay_bytes ?? 0,
                  window: frame.ack_window ?? null, handledBefore: entry.handled,
                });
              } else if (frame?.type === "ready") entry.ready = true;
              else if (frame?.type === "error") entry.errors.push(String(frame.message ?? frame.reason));
            }
            return value.call(this, event);
          });
        },
      });
    }
  };
  const find = (name) => sockets.findLast((entry) => entry.name === name);
  // The page treats a long gap between its 2 s wake probes as a machine sleep
  // and replaces the socket, so whether a stall trips it depends on where the
  // stall falls between two ticks. A stall that starts on a tick is measured
  // alone. Only intervals made after this probe are seen, which is the
  // terminal's own detector when the terminal opens after it.
  const nativeSetInterval = globalThis.setInterval;
  const wakeProbes = [];
  let afterWakeProbe = null;
  globalThis.setInterval = function (handler, delay, ...rest) {
    if (delay !== 2000 || typeof handler !== "function") return nativeSetInterval(handler, delay, ...rest);
    const probe = { ticks: 0 };
    wakeProbes.push(probe);
    return nativeSetInterval(function (...args) {
      const result = handler.apply(this, args);
      probe.ticks += 1;
      if (afterWakeProbe && probe === wakeProbes.at(-1)) {
        const run = afterWakeProbe;
        afterWakeProbe = null;
        run();
      }
      return result;
    }, delay, ...rest);
  };
  const runStall = (entry, ms, lead) => {
    const record = { at: Date.now(), handled: entry.handled, sessions: entry.sessions.length, ms, lead };
    entry.stalls.push(record);
    const end = Date.now() + ms;
    while (Date.now() < end) { /* the stall */ }
    record.ended = Date.now();
  };
  globalThis.__streamProbe = {
    read: (name) => { const entry = find(name); return entry ? view(entry) : null; },
    /// Every socket this terminal has had, oldest first: a redial adds one.
    readAll: (name) => sockets.filter((entry) => entry.name === name).map(view),
    input: (name, data) => find(name).peer.send(JSON.stringify({ type: "input", data })),
    /// Check the stream between two markers: `seq 1 count`, or `count` copies
    /// of one line when `text` is given.
    verifySeq(name, begin, count, end, text = null) {
      const encoder = new TextEncoder();
      const state = { phase: "before", next: 1, lines: 0, mismatch: null, done: false };
      const head = encoder.encode(`${begin}\r\n`);
      const tail = encoder.encode(end);
      let want = head, at = 0, previous = new Uint8Array(0);
      const printable = (bytes) => Array.from(bytes, (byte) => (
        byte >= 32 && byte < 127 ? String.fromCharCode(byte) : `<${byte.toString(16)}>`)).join("");
      const fixed = text === null ? null : encoder.encode(`${text}\r\n`);
      const line = () => fixed ?? encoder.encode(`${state.next}\r\n`);
      verifiers.set(name, {
        state,
        push(bytes, where) {
          for (let index = 0; index < bytes.length && !state.done && !state.mismatch; index += 1) {
            const byte = bytes[index];
            if (byte === want[at]) {
              at += 1;
              if (at < want.length) continue;
              at = 0;
              if (state.phase === "before") {
                state.phase = "lines";
                want = line();
              } else if (state.phase === "lines") {
                state.lines += 1;
                state.next += 1;
                if (state.next > count) { state.phase = "end"; want = tail; } else want = line();
              } else state.done = true;
            } else if (state.phase === "before") {
              at = byte === want[0] ? 1 : 0;
            } else {
              const before = index >= 48 ? bytes.subarray(index - 48, index)
                : new Uint8Array([...previous.subarray(Math.max(0, previous.length - 48 + index)), ...bytes.subarray(0, index)]);
              state.mismatch = {
                afterLine: state.lines, wanted: state.next, byte, offsetInLine: at, ...where,
                indexInFrame: index, frameBytes: bytes.length,
                before: printable(before), after: printable(bytes.subarray(index, index + 48)),
              };
            }
          }
          previous = bytes;
        },
      });
    },
    /// Cut the terminal's socket, as a dropped connection would.
    drop: (name) => find(name).peer.close(),
    /// Stop the page's main thread for `ms`, recording what it had handled.
    stall(name, ms) {
      const entry = find(name);
      setTimeout(() => runStall(entry, ms, null), 0);
    },
    wakeProbeCount: () => wakeProbes.length,
    /// The same stall, `lead` ms after the next wake probe. With no lead the
    /// probe sees a gap of `ms`; a lead adds to the gap it sees.
    stallAtWakeProbe(name, ms, lead = 0) {
      const entry = find(name);
      afterWakeProbe = () => {
        if (lead > 0) setTimeout(() => runStall(entry, ms, lead), lead);
        else runStall(entry, ms, 0);
      };
    },
  };
}

/// Every ghostty-web Terminal the page opens from now on, kept in the page.
export async function trackGhosttyTerminals(page) {
  return page.evaluate(async () => {
    for (const script of document.querySelectorAll('script[type="module"][src]')) {
      const name = /ghostty-web-[\w-]+\.js/.exec(await (await fetch(script.src)).text())?.[0];
      if (!name) continue;
      const { Terminal } = await import(new URL(name, script.src).href);
      const open = Terminal.prototype.open;
      globalThis.__ghosttyTerminals = [];
      Terminal.prototype.open = function (...args) {
        globalThis.__ghosttyTerminals.push(this);
        return open.apply(this, args);
      };
      // A flood scrolls chan's own lines out of the history within a second,
      // so they are read as the app writes them. Those writes are short.
      globalThis.__terminalNotices = [];
      const write = Terminal.prototype.write;
      const decoder = new TextDecoder();
      Terminal.prototype.write = function (data, ...rest) {
        const text = typeof data === "string" ? data : data.length < 256 ? decoder.decode(data) : "";
        for (const match of text.matchAll(/terminal (?:replay missed \d+ bytes|error: [^\r\n]*)/g)) {
          globalThis.__terminalNotices.push(match[0]);
        }
        return write.call(this, data, ...rest);
      };
      return true;
    }
    return false;
  });
}

/// The whole text the newest Ghostty terminal retains, history and screen.
export function readGhosttyText(page) {
  return page.evaluate(() => {
    const term = globalThis.__ghosttyTerminals.at(-1);
    const history = term.getScrollbackLength();
    const text = term.wasmTerm.plainText({
      startRow: 0, startCol: 0, endRow: history + term.rows - 1, endCol: term.cols - 1,
    }) ?? "";
    return { history, rows: term.rows, text };
  });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(label, read, accept, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  do {
    last = await read();
    if (accept(last)) return last;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(last)?.slice(0, 1200)}`);
}
