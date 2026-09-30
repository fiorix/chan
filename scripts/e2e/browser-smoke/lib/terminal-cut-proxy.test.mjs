import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { startTerminalCutProxy } from "./terminal-cut-proxy.mjs";
import { startTerminalFixture, runTerminalFixture } from "./terminal-fixture.mjs";

const text = (value) => [Buffer.from(JSON.stringify(value)), false];
const replay = Buffer.from("row-0:\u00e9\x1b[31mRED\x1b[0m\r\n");
const session = text({ type: "session", id: "wanted", generation: "g1", seq: replay.length, replay_bytes: replay.length });
const ready = text({ type: "ready" });
const frames = [session, [replay, true], ready, [Buffer.from("live"), true]];
const digest = (items) => createHash("sha256").update(Buffer.concat(items.map(([bytes]) => bytes))).digest("hex");

async function rig(t, { messages = frames, ordinal = 1, deadlineMs = 5000, ...limits } = {}) {
  const sockets = new Set(), clients = new Set(), upstream = [];
  const httpServer = http.createServer((req, res) => {
    res.writeHead(201, { "x-echo": req.headers["x-echo"] ?? "absent" });
    req.pipe(res);
  });
  httpServer.on("connection", (socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
  });
  const wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (socket, req) => {
    upstream.push({ socket, url: req.url, headers: req.headers });
    socket.on("error", () => {});
    socket.on("message", (bytes, binary) => socket.send(bytes, { binary }));
    for (const [bytes, binary] of messages) socket.send(bytes, { binary });
  });
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const targetUrl = `http://127.0.0.1:${httpServer.address().port}`;
  const proxy = await startTerminalCutProxy({ targetUrl, path: "/terminal/ws", session: "wanted", ordinal, deadlineMs, ...limits });
  const port = new URL(proxy.url).port;
  t.after(async () => {
    for (const client of clients) client.terminate();
    await proxy.close();
    for (const client of wss.clients) client.terminate();
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise((resolve) => wss.close(resolve)), new Promise((resolve) => httpServer.close(resolve))]);
    assert.equal(httpServer.listening, false);
    assert.equal(wss.clients.size, 0);
    const probe = net.connect({ host: "127.0.0.1", port });
    await assert.rejects(once(probe, "connect"), { code: "ECONNREFUSED" });
    probe.destroy();
  });
  function dial(query = "session=wanted", pathname = "/terminal/ws", acknowledge = false) {
    const socket = new WebSocket(`${proxy.url.replace("http:", "ws:")}${pathname}?${query}`, {
      headers: { authorization: "Bearer DO_NOT_RECORD", origin: targetUrl },
    });
    clients.add(socket);
    const delivered = [];
    socket.on("error", () => {});
    socket.on("message", (data, binary) => {
      delivered.push([Buffer.from(data), binary]);
      if (acknowledge) proxy.acknowledge({ connection: ordinal, frame: delivered.length, drained: true });
    });
    const closed = new Promise((resolve) => socket.once("close", resolve));
    return { socket, delivered, closed };
  }
  return { proxy, dial, upstream, targetUrl };
}

for (const boundary of ["before-session", "after-session", "inside-replay", "after-ready"]) {
  test(`cut ${boundary} carries its wire receipt`, { timeout: 10000 }, async (t) => {
    const { proxy, dial } = await rig(t);
    proxy.arm({ boundary, bytes: 7 });
    const client = dial("session=wanted&token=DO_NOT_RECORD&since=0", "/terminal/ws", true);
    const receipt = await proxy.waitForCut();
    await client.closed;
    assert.equal(receipt.boundary, boundary);
    assert.equal(receipt.connection, 1);
    assert.deepEqual(receipt.disconnect, { client: "closed", upstream: "closed" });
    const received = proxy.records.filter((r) => r.event === "frame" && r.direction === "received");
    assert.equal(receipt.receivedBytes, received.reduce((sum, r) => sum + r.length, 0));
    assert.equal(receipt.forwardedBytes, client.delivered.reduce((sum, [bytes]) => sum + bytes.length, 0));
    assert.equal(JSON.stringify(proxy.records).includes("DO_NOT_RECORD"), false);
    assert.equal(receipt.upstreamFrame, boundary === "after-ready" ? 3 : boundary === "inside-replay" ? 2 : 1);
    if (boundary === "before-session") {
      assert.deepEqual(client.delivered, []);
      assert.equal(receipt.lastAcknowledged, null);
      assert.equal(receipt.held[0].bytes, session[0].toString("base64"));
    } else {
      assert.deepEqual(receipt.lastAcknowledged, { frame: client.delivered.length, drained: true });
      if (boundary === "after-session") assert.deepEqual(client.delivered, [session]);
      if (boundary === "inside-replay") {
        assert.deepEqual(client.delivered, [session, [replay.subarray(0, 7), true]]);
        assert.equal(receipt.replayForwarded, 7);
        assert.equal(receipt.held[0].offset, 7);
        assert.equal(receipt.held[0].bytes, replay.subarray(7).toString("base64"));
      }
      if (boundary === "after-ready") {
        assert.deepEqual(client.delivered, frames.slice(0, 3));
        assert.equal(receipt.replayForwarded, replay.length);
      }
    }
    assert.throws(() => proxy.arm({ boundary }), { code: "CONTROLLER_DISARMED" });
    const recovery = dial("session=wanted&since=0");
    await proxy.waitForRecord((r) => r.connection === 2 && r.direction === "forwarded" && r.frame === frames.length);
    await new Promise((resolve) => recovery.delivered.length === frames.length ? resolve() :
      recovery.socket.on("message", () => { if (recovery.delivered.length === frames.length) resolve(); }));
    assert.deepEqual(recovery.delivered, frames);
    assert.equal(proxy.records.filter((r) => r.event === "cut").length, 1);
  });
}

test("uncut streams preserve types, split UTF-8 and ANSI, HTTP and input", { timeout: 10000 }, async (t) => {
  const messages = [session, [Buffer.from([0xc3]), true], [Buffer.from([0xa9, 0x1b]), true],
    [Buffer.from("[31mred\x1b["), true], [Buffer.from("0m"), true], ready];
  const { proxy, dial, upstream } = await rig(t, { messages });
  const client = dial();
  await once(client.socket, "open");
  const echoed = Buffer.from([0, 255, 27]);
  client.socket.send(echoed);
  await proxy.waitForRecord((r) => r.direction === "forwarded" && r.frame === messages.length + 1);
  if (client.delivered.length < messages.length + 1) await once(client.socket, "message");
  assert.deepEqual(client.delivered, [...messages, [echoed, true]]);
  const before = proxy.records.filter((r) => r.direction === "received").map((r) => [Buffer.from(r.bytes, "base64"), r.binary]);
  assert.equal(digest(before), digest(client.delivered));
  assert.equal(upstream[0].headers.authorization, "Bearer DO_NOT_RECORD");
  const response = await fetch(`${proxy.url}/echo?keep=1`, { method: "POST", body: "body", headers: { "x-echo": "kept" } });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-echo"), "kept");
  assert.equal(await response.text(), "body");
  await assert.rejects(proxy.waitForCut(), { code: "NOT_ARMED" });
});

test("selection counts only the named path and session", { timeout: 10000 }, async (t) => {
  const { proxy, dial } = await rig(t, { ordinal: 2 });
  proxy.arm({ boundary: "after-session" });
  for (const [query, path] of [["session=other", "/terminal/ws"], ["session=wanted", "/other"], ["session=wanted", "/terminal/ws"]]) {
    const peer = dial(query, path);
    await once(peer.socket, "open");
    if (peer.delivered.length < frames.length) await new Promise((resolve) => peer.socket.on("message", () => {
      if (peer.delivered.length === frames.length) resolve();
    }));
    assert.deepEqual(peer.delivered, frames);
  }
  dial("session=wanted", "/terminal/ws", true);
  assert.equal((await proxy.waitForCut()).connection, 2);
  assert.equal(proxy.records.filter((r) => r.event === "connection").length, 2);
});

test("an earlier client close with a delivery in flight leaves the armed pair usable", { timeout: 10000 }, async (t) => {
  const { proxy, dial } = await rig(t, { ordinal: 2 });
  const send = WebSocket.prototype.send;
  let release;
  const port = Number(new URL(proxy.url).port);
  t.mock.method(WebSocket.prototype, "send", function (bytes, options, callback) {
    if (this._socket?.localPort === port && !release) {
      return send.call(this, bytes, options, (error) => { release = () => callback(error); });
    }
    return send.call(this, bytes, options, callback);
  });
  t.after(() => release?.());
  proxy.arm({ boundary: "after-session" });
  const earlier = dial();
  await proxy.waitForRecord((r) => r.connection === 1 && r.direction === "received" && r.frame === frames.length);
  await once(earlier.socket, "message");
  earlier.socket.close();
  await earlier.closed;
  release();
  dial("session=wanted", "/terminal/ws", true);
  await assert.doesNotReject(proxy.waitForCut(), "an ordinary earlier close must not fail the selected cut");
  assert.equal(proxy.records.filter((r) => r.event === "cut")[0].connection, 2);
  assert.equal(proxy.records.some((r) => r.event === "failure"), false);
});

test("a replay cut spans source messages without changing byte order", { timeout: 10000 }, async (t) => {
  const { proxy, dial } = await rig(t, { messages: [session, [replay.subarray(0, 3), true], [replay.subarray(3), true], ready] });
  proxy.arm({ boundary: "inside-replay", bytes: 7 });
  const peer = dial("session=wanted", "/terminal/ws", true);
  const receipt = await proxy.waitForCut();
  assert.equal(receipt.upstreamFrame, 3);
  assert.deepEqual(Buffer.concat(peer.delivered.filter(([, binary]) => binary).map(([data]) => data)), replay.subarray(0, 7));
});

for (const [name, setup, expected] of [
  ["absent selection", () => {}, "NO_SELECTED_SOCKET"],
  ["absent frame", ({ dial }) => dial(), "FRAME_TIMEOUT"],
  ["lost acknowledgement", ({ dial }) => dial(), "ACK_TIMEOUT"],
]) {
  test(`refuses ${name}`, { timeout: 10000 }, async (t) => {
    const context = await rig(t, { messages: name === "absent frame" ? [] : frames, deadlineMs: 1000 });
    context.proxy.arm({ boundary: "after-session" });
    setup(context);
    await assert.rejects(context.proxy.waitForCut(), { code: expected });
    assert.deepEqual(context.proxy.records.filter((r) => r.event === "failure").map((r) => r.code), [expected]);
  });
}

test("held queue has a byte bound", { timeout: 10000 }, async (t) => {
  const { proxy, dial } = await rig(t, { maxQueueBytes: 150, messages: [session, [Buffer.alloc(151), true]] });
  proxy.arm({ boundary: "after-session" });
  dial();
  await assert.rejects(proxy.waitForCut(), { code: "QUEUE_LIMIT" });
});

test("invalid replay offset and invalid acknowledgements refuse", { timeout: 10000 }, async (t) => {
  const { proxy, dial } = await rig(t);
  assert.throws(() => proxy.arm({ boundary: "inside-replay", bytes: 0 }), { code: "INVALID_BOUNDARY" });
  assert.throws(() => proxy.acknowledge({ connection: 1, frame: 1 }), { code: "INVALID_ACK" });
  proxy.arm({ boundary: "inside-replay", bytes: replay.length });
  dial();
  await assert.rejects(proxy.waitForCut(), { code: "INVALID_REPLAY_BOUNDARY" });
});

test("fixture commands, raw keys and barriers agree with its append-only log", { timeout: 10000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "chan-terminal-fixture-test-"));
  const logPath = join(dir, "emitted.bin");
  const controller = await startTerminalFixture({ logPath });
  const input = new PassThrough(), output = new PassThrough(), emitted = [];
  input.isTTY = output.isTTY = true;
  input.setRawMode = (raw) => { input.isRaw = raw; };
  output.columns = 80; output.rows = 24;
  output.on("data", (bytes) => emitted.push(Buffer.from(bytes)));
  const run = runTerminalFixture({ port: Number(controller.env.TERMINAL_FIXTURE_PORT),
    token: controller.env.TERMINAL_FIXTURE_TOKEN, logPath, input, output });
  run.catch(() => {});
  t.after(async () => { await controller.close(); await run; await rm(dir, { recursive: true }); });
  const identity = await controller.ready();
  assert.equal(identity.raw, true);
  assert.equal(identity.cols, 80);
  await controller.send("rows", { prefix: "unique", count: 2 });
  await controller.send("marker", { name: "main" });
  await controller.send("alternate", { enabled: true });
  await controller.send("redraw", { name: "alt" });
  await controller.send("bytes", { base64: Buffer.from("\x1b[?1h").toString("base64") });
  input.write(Buffer.from([27, 79, 65]));
  assert.equal((await controller.waitFor((r) => r.type === "keys")).base64, Buffer.from([27, 79, 65]).toString("base64"));
  await controller.send("alternate", { enabled: false });
  const barrier = await controller.send("barrier", { name: "finite" });
  const expected = Buffer.from("unique:00000000\r\nunique:00000001\r\nMARKER:main\r\n\x1b[?1049h\x1b[2J\x1b[HSCREEN:alt\r\n\x1b[?1h\x1b[?1049l");
  assert.deepEqual(Buffer.concat(emitted), expected);
  assert.deepEqual(await readFile(logPath), expected);
  assert.equal(barrier.offset, expected.length);
  assert.equal(barrier.sha256, createHash("sha256").update(expected).digest("hex"));
  await assert.rejects(controller.send("marker", { name: "blocked" }), { code: "BARRIER_HELD" });
  await assert.rejects(controller.send("resume", { name: "wrong" }), { code: "BARRIER_MISMATCH" });
  await assert.rejects(controller.send("bytes", { base64: "!" }), { code: "INVALID_BYTES" });
  assert.deepEqual(await readFile(logPath), expected);
  await controller.send("resume", { name: "finite" });
  await controller.send("rows", { prefix: "unique", count: 1 });
  assert.deepEqual(await readFile(logPath), Buffer.concat([expected, Buffer.from("unique:00000002\r\n")]));
  await controller.send("stop");
  await run;
  assert.equal(input.isRaw, false);
});

test("fixture refuses a missing peer and a non-PTY", { timeout: 10000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "chan-terminal-fixture-test-"));
  const controller = await startTerminalFixture({ logPath: join(dir, "unused.bin"), deadlineMs: 100 });
  t.after(async () => { await controller.close(); await rm(dir, { recursive: true }); });
  await assert.rejects(controller.ready(), { code: "FIXTURE_EVENT_TIMEOUT" });
  await assert.rejects(runTerminalFixture({ input: new PassThrough(), output: new PassThrough() }), { code: "PTY_REQUIRED" });
});
