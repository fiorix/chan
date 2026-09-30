import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { startTerminalCutProxy } from "./terminal-cut-proxy.mjs";

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
      if (boundary === "after-ready") assert.deepEqual(client.delivered, frames.slice(0, 3));
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
