// A page whose main thread stalls past the wake threshold keeps a healthy
// terminal socket: what the engine queued during the stall is parsed once and
// in order, on the same socket, and nothing is replayed. A socket whose peer
// stopped answering is still replaced, within a stated bound of its last
// frame, even when a queued backlog keeps it busy for a while after the wake.
// Ghostty only.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { startTerminalFixture } from "../lib/terminal-fixture.mjs";
import { readTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const WAKE_STALL_MS = 30_000;
// Past the 45 s read deadline, whose timer is due while the page is stalled.
const LONG_STALL_MS = 50_000;
const SHORT_STALL_MS = 8_000;
// The read deadline, and how long after it a stall that spans it ends.
const READ_DEADLINE_MS = 45_000;
const DEADLINE_EDGES_MS = [150, 800];
// A healthy link whose pong takes this long, inside the 3 s quiet bound, and
// a stall under the wake threshold that the pong lands in.
const SLOW_PONG_MS = 2_800;
const QUIET_STALL_AFTER_MS = 2_600;
const QUIET_STALL_MS = 2_000;
// Each way, for a round trip past the old flat 3 s bound. The delay is on real
// TCP flows in the check's private network namespace.
const SLOW_LINK_ONE_WAY_MS = 1_600;
// Slow enough that a backlog is still queued when the keys are pressed.
const PACE_BYTES_PER_SECOND = 100 * 1024;
// Fast enough that a full window drains inside the input hold's cap.
const FULL_WINDOW_PACE_BYTES_PER_SECOND = 300 * 1024;
// The wake detector's 2 s probe, the 3 s quiet bound and a margin for ticks.
const REPLACE_BOUND_MS = 7_000;
// Over the 2 MiB replay ring, under what the server's broadcast holds for a
// socket that is not reading, so a replaced socket shows a loss and a kept one
// shows none.
const STREAM_BLOCKS = 4;
const BLOCK_BYTES = 700 * 1024;
const NOTICE = "Reconnected. Input typed while disconnected may not have been sent.";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function streamBlocks(prefix, blocks, blockBytes) {
  const out = [];
  let row = 0;
  for (let block = 0; block < blocks; block += 1) {
    const lines = [];
    let size = 0;
    while (size < blockBytes) {
      const line = `${prefix}:${String(row).padStart(8, "0")}\r\n`;
      lines.push(line);
      size += line.length;
      row += 1;
    }
    out.push(Buffer.from(lines.join(""), "latin1"));
  }
  return out;
}

/// A TCP relay whose flows can go silent in both directions with their
/// sockets left open, which is what a peer lost across a sleep looks like from
/// the page: the socket reads OPEN, sends succeed and nothing comes back.
async function startRelay(targetPort) {
  const flows = [];
  const server = createServer((client) => {
    const upstream = connect({ host: "127.0.0.1", port: targetPort });
    const flow = {
      client, upstream, dead: false, toClient: 0, delayMs: 0, uplinkDelayMs: 0, paced: [], pacedBytes: 0, pacer: null,
      /// Forward the server's bytes at this rate, queued in order; 0 lets the
      /// queue go and stops pacing.
      pace(bytesPerSecond) {
        clearInterval(flow.pacer);
        flow.pacer = null;
        if (bytesPerSecond > 0) {
          const slice = Math.ceil(bytesPerSecond / 20);
          flow.pacer = setInterval(() => {
            let budget = slice;
            while (budget > 0 && flow.paced.length) {
              const head = flow.paced[0];
              const part = head.subarray(0, budget);
              if (part.length === head.length) flow.paced.shift();
              else flow.paced[0] = head.subarray(part.length);
              flow.pacedBytes -= part.length;
              budget -= part.length;
              writeToClient(part);
            }
          }, 50);
          return;
        }
        for (const chunk of flow.paced.splice(0)) writeToClient(chunk);
        flow.pacedBytes = 0;
      },
    };
    const writeToClient = (chunk) => {
      if (flow.dead || client.destroyed) return;
      flow.toClient += chunk.length;
      client.write(chunk);
    };
    flows.push(flow);
    client.on("data", (chunk) => {
      const forward = () => { if (!flow.dead && !upstream.destroyed) upstream.write(chunk); };
      if (flow.uplinkDelayMs > 0) setTimeout(forward, flow.uplinkDelayMs);
      else forward();
    });
    upstream.on("data", (chunk) => {
      if (flow.pacer) {
        flow.paced.push(chunk);
        flow.pacedBytes += chunk.length;
      } else if (flow.delayMs > 0) setTimeout(() => writeToClient(chunk), flow.delayMs);
      else writeToClient(chunk);
    });
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => { clearInterval(flow.pacer); upstream.destroy(); });
    upstream.on("close", () => { if (!flow.dead) client.destroy(); });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    flows,
    kill(flow) { flow.dead = true; },
    async close() {
      for (const flow of flows) { clearInterval(flow.pacer); flow.client.destroy(); flow.upstream.destroy(); }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function installTrace() {
  if (window.__stall332) return;
  const Native = window.WebSocket;
  const trace = window.__stall332 = { sockets: [], relays: {}, capturing: false, stall: null };
  window.WebSocket = new Proxy(Native, {
    construct(target, args) {
      const url = new URL(args[0], location.href);
      if (!url.pathname.endsWith("/api/terminal/ws")) return Reflect.construct(target, args);
      const name = url.searchParams.get("tab_name");
      if (trace.relays[name]) url.host = `127.0.0.1:${trace.relays[name]}`;
      const socket = Reflect.construct(target, [url.href, ...args.slice(1)]);
      const record = { name, socket, createdAt: Date.now(), ready: false, sessions: [], bytes: 0, chunks: [], lastFrameAt: null, framesAfterStall: 0, acks: [], inputs: [], pongs: [] };
      trace.sockets.push(record);
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (typeof data === "string" && data.startsWith('{"type":"ack"')) record.acks.push(Date.now());
        if (typeof data === "string" && data.startsWith('{"type":"input"')) record.inputs.push({ at: Date.now(), data: JSON.parse(data).data });
        if (data === '{"type":"ping"}' && trace.afterPing && trace.stall?.end) {
          const { afterMs, stallMs } = trace.afterPing;
          trace.afterPing = null;
          setTimeout(() => {
            const start = Date.now();
            while (Date.now() < start + stallMs) { /* hold the main thread */ }
            trace.secondStall = { start, end: Date.now() };
          }, afterMs);
        }
        return send(data);
      };
      socket.addEventListener("message", (event) => {
        record.lastFrameAt = Date.now();
        if (trace.afterFrame?.name === name) {
          // The stall starts on a later task, after the app's handler for
          // this frame has armed the read deadline.
          const until = record.lastFrameAt + trace.afterFrame.spanMs;
          trace.afterFrame = null;
          trace.stall = { requested: until - record.lastFrameAt, start: null, end: null, frameAt: record.lastFrameAt };
          setTimeout(() => {
            trace.stall.start = Date.now();
            while (Date.now() < until) { /* hold the main thread */ }
            trace.stall.end = Date.now();
          }, 0);
        }
        if (trace.stall?.end && record.lastFrameAt >= trace.stall.end) record.framesAfterStall += 1;
        if (typeof event.data !== "string") {
          const bytes = new Uint8Array(event.data);
          record.bytes += bytes.length;
          if (trace.capturing) record.chunks.push(bytes);
          return;
        }
        let frame;
        try { frame = JSON.parse(event.data); } catch { return; }
        if (frame.type === "ready") record.ready = true;
        if (frame.type === "pong") record.pongs.push(Date.now());
        if (frame.type === "session") record.sessions.push({ missed: frame.missed_bytes ?? 0, replay: frame.replay_bytes ?? 0, window: frame.ack_window ?? null, bytesBefore: record.bytes });
      });
      return socket;
    },
  });
  trace.restore = () => { window.WebSocket = Native; delete window.__stall332; };
  trace.capture = () => {
    trace.capturing = true;
    for (const record of trace.sockets) record.chunks = [];
  };
  // Starts on its own task, so the evaluate that asks for it returns first.
  trace.startStall = (ms) => {
    trace.stall = { requested: ms, start: null, end: null };
    setTimeout(() => {
      trace.stall.start = Date.now();
      while (Date.now() < trace.stall.start + ms) { /* hold the main thread */ }
      trace.stall.end = Date.now();
    }, 100);
  };
  trace.read = (name) => ({
    stall: trace.stall,
    sockets: trace.sockets.filter((record) => record.name === name).map((record) => ({
      createdAt: record.createdAt, state: record.socket.readyState, ready: record.ready, sessions: record.sessions,
      bytes: record.bytes, captured: record.chunks.reduce((total, chunk) => total + chunk.length, 0),
      lastFrameAt: record.lastFrameAt, framesAfterStall: record.framesAfterStall,
      acks: record.acks.slice(-256), inputs: record.inputs.slice(-16), pongs: record.pongs.slice(-16),
    })),
  });
  trace.digest = async (name) => {
    const chunks = trace.sockets.filter((record) => record.name === name).flatMap((record) => record.chunks);
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const whole = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) { whole.set(chunk, at); at += chunk.length; }
    const hash = await crypto.subtle.digest("SHA-256", whole);
    return { length: total, sha256: [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("") };
  };
}

const read = (page, name) => page.evaluate((tab) => window.__stall332.read(tab), name);

async function until(label, probe, accept, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  do {
    last = await probe();
    if (accept(last)) return last;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}

const keysOf = (fixture) => Buffer.concat(fixture.records.filter((record) => record.type === "keys")
  .map((record) => Buffer.from(record.base64, "base64"))).toString("latin1");
const cursorReports = (fixture) => (keysOf(fixture).match(/\x1b\[\d+;\d+R/g) ?? []).length;

/// On a page that is running and caught up, the terminal's answer shows its
/// parser reached the query. Behind a stall or a paced link it shows nothing:
/// the library answers an unanswered query itself after 150 ms.
async function queryParsed(fixture, timeoutMs) {
  const before = cursorReports(fixture);
  await fixture.send("bytes", { base64: Buffer.from("\x1b[6n").toString("base64") });
  await until("the terminal answers a cursor query", async () => cursorReports(fixture), (count) => count > before, timeoutMs);
}

async function stallEnded(page, timeoutMs) {
  return until("the page stall ended", () => page.evaluate(() => window.__stall332.stall),
    (stall) => stall?.end, timeoutMs);
}

async function openTab(ctx, page, cs, windowId, name, fixture) {
  const spawnArgs = ["--command", `stty -opost -echo && ${fixture.command}`,
    ...Object.entries(fixture.env).flatMap(([key, value]) => ["--env", `${key}=${value}`])];
  const row = await openAttachedTerminal(ctx, page, cs, windowId, name, "ghostty", spawnArgs);
  await fixture.ready();
  await until("the terminal socket is ready", () => read(page, name), (seen) => seen.sockets.at(-1)?.ready, 30_000);
  return row;
}

/// A stall under a fast stream, the stream written while the page is stalled.
async function streamLeg(page, fixture, name, stallMs, prefix) {
  await queryParsed(fixture, 20_000);
  const blocks = streamBlocks(prefix, STREAM_BLOCKS, BLOCK_BYTES);
  const query = Buffer.from("\x1b[6n");
  const expected = createHash("sha256");
  for (const block of blocks) expected.update(block);
  expected.update(query);
  const expectedLength = blocks.reduce((sum, block) => sum + block.length, query.length);
  const reportsBefore = cursorReports(fixture);
  const start = await read(page, name);
  const socketsBefore = start.sockets.length;
  const sessionsBefore = start.sockets.flatMap((socket) => socket.sessions).length;
  await page.evaluate((ms) => { window.__stall332.capture(); window.__stall332.startStall(ms); }, stallMs);
  await sleep(400);
  for (const block of blocks) await fixture.send("bytes", { base64: block.toString("base64") });
  await fixture.send("bytes", { base64: query.toString("base64") });
  const stall = await stallEnded(page, stallMs + 60_000);
  assert.ok(stall.end - stall.start >= stallMs, `the page was stalled for ${stall.end - stall.start} ms`);
  let answered = true;
  await until("the cursor query after the stream", async () => cursorReports(fixture), (count) => count > reportsBefore, 90_000)
    .catch(() => { answered = false; });
  // A replacement after the drain would still count against this leg.
  await sleep(6_000);
  const seen = await read(page, name);
  const digest = await page.evaluate((tab) => window.__stall332.digest(tab), name);
  const observed = {
    stallMs: stall.end - stall.start,
    answered,
    newSockets: seen.sockets.length - socketsBefore,
    recoveries: seen.sockets.flatMap((socket) => socket.sessions).slice(sessionsBefore),
    expectedLength,
    receivedLength: digest.length,
    whole: digest.sha256 === expected.digest("hex"),
  };
  assert.equal(observed.newSockets, 0, `the healthy socket was replaced: ${JSON.stringify(observed)}`);
  // A paced server that stopped waiting for the stalled view resumes it on
  // this socket from the ring, which must hold everything the view lacks.
  assert.ok(observed.recoveries.every((session) => session.window > 0 && session.missed === 0),
    `the socket lost bytes in a recovery: ${JSON.stringify(observed)}`);
  assert.ok(observed.answered, `the parser never reached the end of the stream: ${JSON.stringify(observed)}`);
  assert.equal(observed.receivedLength, expectedLength, `stream length: ${JSON.stringify(observed)}`);
  assert.ok(observed.whole, `the stream is not whole and in order: ${JSON.stringify(observed)}`);
  return observed;
}

/// An idle healthy terminal across a wake: nothing is sent to it and nothing
/// about its connection changes.
async function idleLeg(page, fixture, name) {
  await queryParsed(fixture, 20_000);
  const before = await read(page, name);
  await page.evaluate((ms) => window.__stall332.startStall(ms), SHORT_STALL_MS);
  await stallEnded(page, SHORT_STALL_MS + 30_000);
  await sleep(REPLACE_BOUND_MS);
  const after = await read(page, name);
  const notice = await page.evaluate((text) => document.body.innerText.includes(text), NOTICE);
  const observed = {
    socketsBefore: before.sockets.length, socketsAfter: after.sockets.length,
    sessionsBefore: before.sockets.flatMap((socket) => socket.sessions).length,
    sessionsAfter: after.sockets.flatMap((socket) => socket.sessions).length,
    bytesBefore: before.sockets.at(-1).bytes, bytesAfter: after.sockets.at(-1).bytes, notice,
  };
  assert.equal(observed.socketsAfter, observed.socketsBefore, `an idle socket was replaced: ${JSON.stringify(observed)}`);
  assert.equal(observed.sessionsAfter, observed.sessionsBefore, `an idle socket was reattached: ${JSON.stringify(observed)}`);
  assert.equal(observed.bytesAfter, observed.bytesBefore, `an idle terminal received output: ${JSON.stringify(observed)}`);
  assert.equal(observed.notice, false, "an idle terminal shows the Reconnected note");
  await queryParsed(fixture, 20_000);
  return observed;
}

/// A stall that starts on a frame and ends just after that frame's read
/// deadline, the one ordering in which the deadline's timer is due with no
/// time to spare. The socket is healthy throughout, so it must be kept.
async function deadlineEdgeLeg(page, fixture, name, edgeMs) {
  await queryParsed(fixture, 20_000);
  const before = (await read(page, name)).sockets.length;
  await page.evaluate((tab, spanMs) => {
    window.__stall332.stall = null;
    window.__stall332.afterFrame = { name: tab, spanMs };
  }, name, READ_DEADLINE_MS + edgeMs);
  await fixture.send("bytes", { base64: Buffer.from("\x1b[6n").toString("base64") });
  const stall = await stallEnded(page, READ_DEADLINE_MS + 30_000);
  await sleep(REPLACE_BOUND_MS);
  const seen = await read(page, name);
  const observed = {
    edgeMs, endedAfterDeadlineMs: stall.end - (stall.frameAt + READ_DEADLINE_MS), stallMs: stall.end - stall.start,
    socketsBefore: before, socketsAfter: seen.sockets.length, states: seen.sockets.map((socket) => socket.state),
  };
  assert.equal(observed.socketsAfter, before, `a stall ending at the read deadline replaced a healthy socket: ${JSON.stringify(observed)}`);
  await queryParsed(fixture, 20_000);
  return observed;
}

/// A healthy link whose pong takes most of the quiet bound, with a stall under
/// the wake threshold that the pong lands in: the time the stall skips must
/// not settle the probe ahead of the frame it held back. The control is the
/// same link with no second stall.
async function quietProbeLeg(page, fixture, relay, name) {
  await queryParsed(fixture, 20_000);
  const flow = relay.flows.at(-1);
  const before = (await read(page, name)).sockets.length;
  flow.delayMs = SLOW_PONG_MS;
  try {
    await page.evaluate((ms) => window.__stall332.startStall(ms), SHORT_STALL_MS);
    await sleep(200);
    await stallEnded(page, SHORT_STALL_MS + 30_000);
    await sleep(REPLACE_BOUND_MS);
    const control = (await read(page, name)).sockets.length;
    assert.equal(control, before, "control: a pong inside the bound kept the socket");
    await page.evaluate((afterMs, stallMs, ms) => {
      window.__stall332.secondStall = null;
      window.__stall332.startStall(ms);
      window.__stall332.afterPing = { afterMs, stallMs };
    }, QUIET_STALL_AFTER_MS, QUIET_STALL_MS, SHORT_STALL_MS);
    await sleep(200);
    await stallEnded(page, SHORT_STALL_MS + 30_000);
    const second = await until("the second stall ran", () => page.evaluate(() => window.__stall332.secondStall),
      (value) => value?.end, 20_000);
    await sleep(REPLACE_BOUND_MS);
    const seen = await read(page, name);
    const observed = { control, socketsBefore: before, socketsAfter: seen.sockets.length, secondStallMs: second.end - second.start };
    assert.equal(observed.socketsAfter, before, `a short stall inside the probe replaced a healthy socket: ${JSON.stringify(observed)}`);
    return observed;
  } finally {
    flow.delayMs = 0;
    await sleep(SLOW_PONG_MS);
  }
}

/// A healthy link with a round trip past the 3 s floor keeps its socket across
/// a wake: the probe's limit follows the round trip the socket measured.
async function slowLinkLeg(page, fixture, relay, name, selector) {
  await queryParsed(fixture, 20_000);
  await page.click(`${selector} .terminal-host`);
  const flow = relay.flows.at(-1);
  const before = (await read(page, name)).sockets.length;
  flow.delayMs = SLOW_LINK_ONE_WAY_MS;
  flow.uplinkDelayMs = SLOW_LINK_ONE_WAY_MS;
  try {
    // A typed key's ping, 1 s later, measures the slow round trip.
    await page.keyboard.type("r");
    await fixture.waitFor((record) => record.type === "keys" && Buffer.from(record.base64, "base64").includes("r"));
    await sleep(1_000 + 2 * SLOW_LINK_ONE_WAY_MS + 500);
    await page.evaluate((ms) => window.__stall332.startStall(ms), SHORT_STALL_MS);
    await sleep(200);
    const stall = await stallEnded(page, SHORT_STALL_MS + 30_000);
    await sleep(2 * SLOW_LINK_ONE_WAY_MS + REPLACE_BOUND_MS);
    const seen = await read(page, name);
    const observed = {
      roundTripMs: 2 * SLOW_LINK_ONE_WAY_MS, stallMs: stall.end - stall.start,
      socketsBefore: before, socketsAfter: seen.sockets.length,
    };
    assert.equal(observed.socketsAfter, before, `a healthy slow link lost its socket at a wake: ${JSON.stringify(observed)}`);
    return observed;
  } finally {
    flow.delayMs = 0;
    flow.uplinkDelayMs = 0;
    await sleep(2 * SLOW_LINK_ONE_WAY_MS);
  }
}

/// An interrupt during a backlog goes at once, with the keys held ahead of it
/// in order, while the socket is still unproven. The relay paces the server's
/// bytes so the pong stays queued behind the backlog.
async function interruptLeg(page, fixture, relay, name, selector) {
  await queryParsed(fixture, 20_000);
  await page.click(`${selector} .terminal-host`);
  const flow = relay.flows.at(-1);
  const socketsBefore = (await read(page, name)).sockets.length;
  const keysBefore = keysOf(fixture).length;
  const typedSince = () => keysOf(fixture).slice(keysBefore).replace(/\x1b\[\d+;\d+R/g, "");
  const interrupt = /\x03/;
  flow.pace(PACE_BYTES_PER_SECOND);
  try {
    await page.evaluate((ms) => window.__stall332.startStall(ms), SHORT_STALL_MS);
    await sleep(400);
    for (const block of streamBlocks("INTR332", 2, BLOCK_BYTES)) {
      await fixture.send("bytes", { base64: block.toString("base64") });
    }
    await stallEnded(page, SHORT_STALL_MS + 30_000);
    // The wake detector's first tick after the stall starts the hold.
    await sleep(500);
    await page.keyboard.type("k");
    await sleep(400);
    const heldWhileUnproven = !typedSince().includes("k");
    const pressedAt = Date.now();
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyC");
    await page.keyboard.up("Control");
    await until("the interrupt reached the PTY", async () => typedSince(), (text) => interrupt.test(text), 5_000);
    const reachedMs = Date.now() - pressedAt;
    const backlogLeft = flow.pacedBytes;
    flow.pace(0);
    await queryParsed(fixture, 60_000);
    const typed = typedSince();
    const seen = await read(page, name);
    const observed = {
      heldWhileUnproven, reachedMs, backlogLeft,
      typed: JSON.stringify(typed), newSockets: seen.sockets.length - socketsBefore,
    };
    assert.ok(heldWhileUnproven, `a key was not held while the socket was unproven: ${JSON.stringify(observed)}`);
    assert.ok(backlogLeft > 0, `the backlog had drained before the interrupt: ${JSON.stringify(observed)}`);
    assert.ok(reachedMs < 2_000, `the interrupt waited: ${JSON.stringify(observed)}`);
    assert.equal(typed.split("k").length - 1, 1, `the held key did not arrive exactly once: ${JSON.stringify(observed)}`);
    assert.ok(typed.indexOf("k") < typed.search(interrupt), `the interrupt passed the key held ahead of it: ${JSON.stringify(observed)}`);
    assert.equal(observed.newSockets, 0, `the socket was replaced: ${JSON.stringify(observed)}`);
    return observed;
  } finally {
    flow.pace(0);
  }
}

/// A stall long enough to fill the acknowledgement window, then a wake. The
/// relay paces the drain while acknowledgements keep leaving, the socket is
/// kept, and a key typed after the stall goes out once and never ahead of the
/// first pong. Whether the key meets the hold depends on when that pong lands,
/// so the hold itself is pinned by the mounted tests.
async function fullWindowLeg(page, fixture, relay, name, selector) {
  await queryParsed(fixture, 20_000);
  await page.click(`${selector} .terminal-host`);
  await sleep(2_500);
  const flow = relay.flows.at(-1);
  const blocks = streamBlocks("WINDOW332", STREAM_BLOCKS, BLOCK_BYTES);
  const query = Buffer.from("\x1b[6n");
  const expected = createHash("sha256");
  for (const block of blocks) expected.update(block);
  expected.update(query);
  const expectedLength = blocks.reduce((sum, block) => sum + block.length, query.length);
  const start = await read(page, name);
  const socketsBefore = start.sockets.length;
  const socketAt = socketsBefore - 1;
  const sessionsBefore = start.sockets[socketAt].sessions.length;
  const bytesAtStall = start.sockets[socketAt].bytes;
  const keysBefore = keysOf(fixture).length;
  flow.pace(FULL_WINDOW_PACE_BYTES_PER_SECOND);
  try {
    await page.evaluate((ms) => { window.__stall332.capture(); window.__stall332.startStall(ms); }, SHORT_STALL_MS);
    await sleep(400);
    for (const block of blocks) await fixture.send("bytes", { base64: block.toString("base64") });
    await fixture.send("bytes", { base64: query.toString("base64") });
    const stall = await stallEnded(page, SHORT_STALL_MS + 30_000);
    await sleep(500);
    const queuedAtKey = flow.pacedBytes;
    await page.keyboard.type("w");
    await until("the whole stream arrives", () => read(page, name),
      (now) => now.sockets.reduce((total, record) => total + record.captured, 0) >= expectedLength, 90_000);
    await until("the held key arrives", async () => keysOf(fixture).slice(keysBefore), (text) => text.includes("w"), 30_000);
    await sleep(1_000);
    const seen = await read(page, name);
    const socket = seen.sockets[socketAt];
    const digest = await page.evaluate((tab) => window.__stall332.digest(tab), name);
    const key = socket.inputs.find((input) => input.data === "w" && input.at >= stall.end);
    const firstPong = socket.pongs.find((at) => at >= stall.end);
    const recovery = socket.sessions[sessionsBefore];
    const observed = {
      newSockets: seen.sockets.length - socketsBefore,
      window: recovery?.window ?? null,
      queuedBytes: recovery ? recovery.bytesBefore - bytesAtStall : null,
      missed: socket.sessions.slice(sessionsBefore).map((session) => session.missed),
      queuedAtKey,
      keyAfterPongMs: key && firstPong ? key.at - firstPong : null,
      acksAfterStall: socket.acks.filter((at) => at >= stall.end).length,
      copies: keysOf(fixture).slice(keysBefore).split("w").length - 1,
      receivedLength: digest.length, expectedLength, whole: digest.sha256 === expected.digest("hex"),
    };
    assert.equal(observed.newSockets, 0, `the socket was replaced: ${JSON.stringify(observed)}`);
    assert.ok(recovery?.window > 0, `the stall did not reach a paced recovery: ${JSON.stringify(observed)}`);
    assert.ok(observed.queuedBytes >= recovery.window / 2, `the window was not full: ${JSON.stringify(observed)}`);
    assert.ok(observed.missed.every((count) => count === 0), `bytes were missed: ${JSON.stringify(observed)}`);
    assert.ok(queuedAtKey > 0, `the backlog had drained before the key: ${JSON.stringify(observed)}`);
    assert.ok(observed.keyAfterPongMs !== null && observed.keyAfterPongMs >= 0, `the key went out before the pong: ${JSON.stringify(observed)}`);
    assert.ok(observed.acksAfterStall > 0, `no acknowledgement left after the stall: ${JSON.stringify(observed)}`);
    assert.equal(observed.copies, 1, `the held key arrived ${observed.copies} times: ${JSON.stringify(observed)}`);
    assert.ok(observed.whole, `the stream is not whole and in order: ${JSON.stringify(observed)}`);
    return observed;
  } finally {
    flow.pace(0);
  }
}

/// A peer lost across a wake: the socket is replaced within the bound, a key
/// typed during the probe arrives exactly once on the replacement, and the
/// terminal works afterward.
async function halfOpenLeg(page, fixture, relay, name, selector) {
  await queryParsed(fixture, 20_000);
  await page.click(`${selector} .terminal-host`);
  // An earlier leg's last key gets its ping 1 s later. Answered first, so a
  // Reconnected note here can only be about this leg's key.
  await sleep(2_500);
  // The latest round trip sets the probe's deadline, and an earlier leg's slow
  // link or paced backlog can leave a long one, up to the 10 s cap. A heartbeat
  // on the link as it is now gives this leg the 3 s floor its bound is about.
  const lastPong = (await read(page, name)).sockets.at(-1).pongs.at(-1) ?? 0;
  await until("a heartbeat on the settled link", () => read(page, name),
    (seen) => (seen.sockets.at(-1).pongs.at(-1) ?? 0) > lastPong, 25_000);
  const before = (await read(page, name)).sockets.length;
  const flow = relay.flows.at(-1);
  relay.kill(flow);
  await page.evaluate((ms) => window.__stall332.startStall(ms), SHORT_STALL_MS);
  const stall = await stallEnded(page, SHORT_STALL_MS + 30_000);
  // After the wake detector's first tick, so the key meets the probe.
  await sleep(500);
  const keysBefore = keysOf(fixture).length;
  await page.keyboard.type("q");
  const replaced = await until("the dead socket is replaced", () => read(page, name),
    (seen) => seen.sockets.length > before && seen.sockets.at(-1).ready, 30_000);
  const replacement = replaced.sockets.at(-1);
  const replaceMs = replacement.createdAt - stall.end;
  assert.ok(replaceMs <= REPLACE_BOUND_MS, `replaced ${replaceMs} ms after the stall, past the ${REPLACE_BOUND_MS} ms bound`);
  const copies = () => keysOf(fixture).slice(keysBefore).split("q").length - 1;
  const arrived = await until("the key typed during the probe arrives", async () => copies(), (count) => count > 0, 5_000)
    .catch(() => 0);
  await sleep(1_000);
  const delivered = copies();
  const notice = await page.evaluate((text) => document.body.innerText.includes(text), NOTICE);
  assert.equal(delivered, 1, `the key typed during the probe arrived ${delivered} times (first read ${arrived}, note ${notice})`);
  assert.equal(notice, false, "a key delivered to the replacement still showed the Reconnected note");
  await page.keyboard.type("Z");
  await fixture.waitFor((record) => record.type === "keys" && Buffer.from(record.base64, "base64").includes("Z"));
  await queryParsed(fixture, 20_000);
  return { replaceMs, delivered, notice };
}

/// A peer lost with a backlog already queued: the backlog drains, which is no
/// proof the peer is there, and the socket is replaced within the bound of its
/// last frame with nothing lost.
async function backlogLeg(page, fixture, relay, name) {
  await queryParsed(fixture, 20_000);
  const before = (await read(page, name)).sockets.length;
  const flow = relay.flows.at(-1);
  const [block] = streamBlocks("BACKLOG332", 1, 400 * 1024);
  const sentBefore = flow.toClient;
  await page.evaluate((ms) => window.__stall332.startStall(ms), SHORT_STALL_MS);
  await sleep(400);
  await fixture.send("bytes", { base64: block.toString("base64") });
  await until("the relay forwarded the backlog", async () => flow.toClient - sentBefore, (sent) => sent >= block.length, 6_000);
  relay.kill(flow);
  await stallEnded(page, SHORT_STALL_MS + 30_000);
  const replaced = await until("the socket behind the backlog is replaced", () => read(page, name),
    (seen) => seen.sockets.length > before && seen.sockets.at(-1).ready, 30_000);
  const old = replaced.sockets[before - 1];
  const replacement = replaced.sockets.at(-1);
  const afterLastFrameMs = replacement.createdAt - old.lastFrameAt;
  assert.ok(old.framesAfterStall > 0, "the backlog drained after the stall");
  assert.ok(afterLastFrameMs <= REPLACE_BOUND_MS, `replaced ${afterLastFrameMs} ms after its last frame, past the ${REPLACE_BOUND_MS} ms bound`);
  assert.deepEqual(replacement.sessions.map((session) => session.missed), [0], "the redial reported missed bytes");
  await queryParsed(fixture, 20_000);
  return { drainedFrames: old.framesAfterStall, afterLastFrameMs };
}

export default {
  name: "terminal-stall-keeps-socket",
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
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const original = await readTerminalPrefs(page, token);
    const result = {};
    const pageErrors = [];
    const onError = (error) => pageErrors.push(String(error));
    page.on("pageerror", onError);
    const failures = [];
    // Every leg runs and reports, so one red does not hide the next.
    const leg = async (label, body) => {
      try {
        result[label] = await body();
      } catch (error) {
        result[label] = { failed: String(error.message) };
        failures.push(`${label}: ${error.message}`);
      }
    };
    const fixtures = [];
    const openTabs = new Set();
    let relay;
    const openFixture = async (label) => {
      const fixture = await startTerminalFixture({ logPath: join(ctx.outDir, `332-${label}-output.bin`), deadlineMs: 60_000 });
      fixtures.push(fixture);
      return fixture;
    };
    try {
      await writeTerminalPrefs(page, token, { ghostty: true });
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await ctx.waitWindowLive(windowId);
      await page.evaluate(installTrace);

      const healthy = "Stall332";
      const healthyFixture = await openFixture("healthy");
      openTabs.add(healthy);
      await openTab(ctx, page, cs, windowId, healthy, healthyFixture);
      await leg("idle", () => idleLeg(page, healthyFixture, healthy));
      await leg("stream", () => streamLeg(page, healthyFixture, healthy, WAKE_STALL_MS, "STALL332"));
      await leg("longStream", () => streamLeg(page, healthyFixture, healthy, LONG_STALL_MS, "LONG332"));
      for (const edgeMs of DEADLINE_EDGES_MS) {
        await leg(`deadlineEdge${edgeMs}`, () => deadlineEdgeLeg(page, healthyFixture, healthy, edgeMs));
      }
      await cs(["close", "--tab-name", healthy]);
      openTabs.delete(healthy);

      relay = await startRelay(Number(new URL(ctx.serverUrl).port));
      const dead = "Dead332";
      await page.evaluate((tab, port) => { window.__stall332.relays[tab] = port; }, dead, relay.port);
      const deadFixture = await openFixture("dead");
      openTabs.add(dead);
      const row = await openTab(ctx, page, cs, windowId, dead, deadFixture);
      const selector = `.pane[data-pane-id="${row.pane}"] .terminal-tab.active[data-terminal-tab-id="${row.tab}"]`;
      await leg("quietProbe", () => quietProbeLeg(page, deadFixture, relay, dead));
      await leg("slowLink", () => slowLinkLeg(page, deadFixture, relay, dead, selector));
      await leg("interrupt", () => interruptLeg(page, deadFixture, relay, dead, selector));
      await leg("fullWindow", () => fullWindowLeg(page, deadFixture, relay, dead, selector));
      await leg("halfOpen", () => halfOpenLeg(page, deadFixture, relay, dead, selector));
      await leg("backlog", () => backlogLeg(page, deadFixture, relay, dead));
      await cs(["close", "--tab-name", dead]);
      openTabs.delete(dead);
      assert.deepEqual(pageErrors, []);
      if (failures.length) throw new Error(failures.join("\n"));
    } finally {
      writeFileSync(join(ctx.outDir, "332-result.json"), `${JSON.stringify({ result, pageErrors }, null, 2)}\n`);
      page.off("pageerror", onError);
      for (const name of openTabs) await cs(["close", "--tab-name", name]).catch(() => {});
      await page.evaluate(() => window.__stall332?.restore()).catch(() => {});
      await relay?.close().catch(() => {});
      for (const fixture of fixtures) await fixture.close().catch(() => {});
      await writeTerminalPrefs(page, token, { ghostty: original.ghostty }).catch(() => {});
    }
  },
};
