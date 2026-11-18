import assert from "node:assert/strict";
import { connect, createServer } from "node:net";
import test from "node:test";
import { clientFrameReader, startRelay } from "./flow-relay.mjs";

/// A server that echoes every chunk back.
async function startEcho() {
  const sockets = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("data", (chunk) => socket.write(chunk));
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function dial(port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => resolve(socket));
    socket.once("error", reject);
  });
}

/// The first `bytes` the socket reads, and how long they took from now.
function read(socket, bytes) {
  const started = Date.now();
  return new Promise((resolve) => {
    let got = Buffer.alloc(0);
    const onData = (chunk) => {
      got = Buffer.concat([got, chunk]);
      if (got.length < bytes) return;
      socket.off("data", onData);
      resolve({ text: got.toString("latin1"), ms: Date.now() - started });
    };
    socket.on("data", onData);
  });
}

const closed = (socket) => new Promise((resolve) => {
  if (socket.destroyed) resolve();
  else socket.once("close", resolve);
});

/// A client's frame: FIN, the opcode, the mask bit and length, a key, and the
/// payload masked with it.
function maskedFrame(opcode, payload) {
  const body = Buffer.from(payload);
  const key = Buffer.from([1, 2, 3, 4]);
  const head = body.length < 126
    ? Buffer.from([0x80 | opcode, 0x80 | body.length])
    : Buffer.from([0x80 | opcode, 0x80 | 126, body.length >> 8, body.length & 0xff]);
  const masked = Buffer.from(body.map((byte, i) => byte ^ key[i % 4]));
  return Buffer.concat([head, key, masked]);
}

test("delays each direction and holds a silenced flow until it resumes", async () => {
  const echo = await startEcho();
  const relay = await startRelay(echo.port);
  try {
    const socket = await dial(relay.port);
    socket.write("GET /feed HTTP/1.1\r\nHost: x\r\n\r\n");
    await read(socket, 31);
    relay.setDelay(150);
    socket.write("ping");
    const delayed = await read(socket, 4);
    assert.equal(delayed.text, "ping");
    assert.ok(delayed.ms >= 280, `a round trip at 150 ms each way took ${delayed.ms} ms`);
    relay.setDelay(0);
    relay.silence();
    socket.write("held");
    const held = read(socket, 4);
    const early = await Promise.race([held, new Promise((resolve) => setTimeout(() => resolve(null), 300))]);
    assert.equal(early, null, "a silenced flow delivered");
    relay.resume();
    assert.equal((await held).text, "held");
    socket.destroy();
  } finally {
    await relay.close();
    await echo.close();
  }
});

test("shows each chunk with its flow's path and head, drops open flows and refuses new ones", async () => {
  const echo = await startEcho();
  const relay = await startRelay(echo.port);
  const seen = [];
  relay.tap((flow, index, chunk) => seen.push({ path: flow.path, head: flow.head, index, chunk: chunk.toString("latin1") }));
  try {
    const socket = await dial(relay.port);
    const request = "GET /api/watch?t=x HTTP/1.1\r\nHost: x\r\nUser-Agent: probe\r\n\r\n";
    socket.write(request);
    await read(socket, request.length);
    assert.deepEqual(seen.map((s) => [s.path, s.index]), [["/api/watch", 0], ["/api/watch", 1]]);
    assert.equal(seen[0].head, "GET /api/watch?t=x HTTP/1.1\r\nHost: x\r\nUser-Agent: probe");
    relay.drop();
    await closed(socket);
    relay.refuse(true);
    const refused = await dial(relay.port);
    await closed(refused);
    relay.refuse(false);
    const again = await dial(relay.port);
    again.write("back");
    assert.equal((await read(again, 4)).text, "back");
    again.destroy();
  } finally {
    await relay.close();
    await echo.close();
  }
});

/// `promise`, or a failure naming `what` once `ms` pass: a read on a closed
/// socket and the close of an open one never settle by themselves.
function within(promise, what, ms = 2_000) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no ${what} in ${ms} ms`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

test("drops and refuses only the flows a caller names by their request", async () => {
  const echo = await startEcho();
  const relay = await startRelay(echo.port);
  const pageHead = "GET /terminal/ws HTTP/1.1\r\nHost: x\r\nUser-Agent: WebKit\r\n\r\n";
  const feedHead = "GET /api/library/windows/watch HTTP/1.1\r\nHost: x\r\n\r\n";
  const page = (flow) => /^user-agent:/im.test(flow.head ?? "");
  try {
    const pageSocket = await dial(relay.port);
    pageSocket.write(pageHead);
    await read(pageSocket, pageHead.length);
    const feed = await dial(relay.port);
    feed.write(feedHead);
    await read(feed, feedHead.length);

    relay.drop(page);
    relay.refuse(true, page);
    await within(closed(pageSocket), "close of the named flow");
    feed.write("ping");
    assert.equal((await within(read(feed, 4), "echo on the flow the caller did not name")).text, "ping");

    const refused = await dial(relay.port);
    refused.write(pageHead);
    await within(closed(refused), "close of a new named flow");
    assert.equal(relay.flows.at(-1).refused, true);
    const feedAgain = await dial(relay.port);
    feedAgain.write(feedHead);
    assert.equal((await within(read(feedAgain, feedHead.length), "echo on a new flow the caller did not name")).text, feedHead);
    assert.equal(relay.summary().refusingSome, true);

    relay.refuse(false);
    const back = await dial(relay.port);
    back.write(pageHead);
    assert.equal((await within(read(back, pageHead.length), "echo once the refusal ends")).text, pageHead);
    assert.equal(relay.summary().refusingSome, false);
    for (const socket of [feed, feedAgain, back]) socket.destroy();
  } finally {
    await relay.close();
    await echo.close();
  }
});

test("reads a client's masked frames across chunks", () => {
  const reader = clientFrameReader();
  const long = "x".repeat(300);
  const bytes = Buffer.concat([maskedFrame(1, '{"type":"ping"}'), maskedFrame(9, ""), maskedFrame(1, long)]);
  assert.deepEqual(reader.push(bytes.subarray(0, 5)), []);
  const frames = [...reader.push(bytes.subarray(5, 30)), ...reader.push(bytes.subarray(30))];
  assert.deepEqual(frames, [
    { opcode: 1, text: '{"type":"ping"}' },
    { opcode: 9, text: null },
    { opcode: 1, text: long },
  ]);
});
