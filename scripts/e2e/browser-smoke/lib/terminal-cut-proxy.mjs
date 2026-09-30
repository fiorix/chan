import http from "node:http";
import net from "node:net";
import { EventEmitter, once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";

const boundaries = new Set(["before-session", "after-session", "inside-replay", "before-ready", "after-ready"]);
const fault = (code) => Object.assign(new Error(code), { code });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // The controller can inspect a failure after the socket has closed.
  promise.catch(() => {});
  return { promise, resolve, reject };
};

/** Loopback relay with explicitly armed terminal-message cuts. */
export async function startTerminalCutProxy({
  targetUrl, path, session, ordinal = 1, deadlineMs = 5000,
  maxQueueBytes = 8 * 1024 * 1024, maxQueueMessages = 4096,
  maxTraceBytes = 64 * 1024 * 1024,
}) {
  const target = new URL(targetUrl);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" ||
      target.username || target.password || target.search || target.hash || target.pathname !== "/") {
    throw fault("LOOPBACK_ORIGIN_REQUIRED");
  }
  if (!path?.startsWith("/") || path.includes("?") || !session ||
      !Number.isSafeInteger(ordinal) || ordinal < 1 ||
      ![deadlineMs, maxQueueBytes, maxQueueMessages, maxTraceBytes].every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw fault("INVALID_SELECTION_OR_LIMIT");
  }
  const events = new EventEmitter();
  const records = [];
  const sockets = new Set();
  const peers = new Set();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  let cut, armNumber = 0, pendingCut = false;
  let connections = 0, traceBytes = 0, armed, selected, timer, failure, receipt, closed = false;

  function watch(socket) {
    if (sockets.has(socket)) return socket;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    return socket;
  }
  function record(value) {
    records.push(value);
    events.emit("record", value);
    return value;
  }
  function stopPair(pair) {
    pair.client?.terminate();
    pair.up.terminate();
  }
  function endPair(pair, code) {
    if (pair.ended || pair.cutting) return;
    pair.ended = true;
    pair.queue.length = 0;
    pair.queuedBytes = 0;
    record({ event: "end", connection: pair.ordinal, code });
    stopPair(pair);
  }
  function pairFailure(pair, code) {
    if ((pair === selected && armed) || (receipt && !code.endsWith("_CLOSED_BEFORE_CUT"))) fail(code);
    else endPair(pair, code);
  }
  function fail(code) {
    if (failure || closed) return;
    failure = fault(code);
    clearTimeout(timer);
    record({ event: "failure", code });
    cut?.reject(failure);
    events.emit("failure", failure);
    for (const pair of peers) {
      pair.queue.length = 0;
      pair.queuedBytes = 0;
      stopPair(pair);
    }
  }
  function frameRecord(pair, direction, bytes, binary, source = null, offset = 0) {
    traceBytes += bytes.length;
    if (traceBytes > maxTraceBytes) { fail("TRACE_LIMIT"); return null; }
    let control = null;
    if (!binary) {
      try { control = JSON.parse(bytes.toString()); } catch { /* Text need not be JSON. */ }
    }
    const value = {
      event: "frame", connection: pair.ordinal, direction,
      frame: ++pair[direction], binary, length: bytes.length,
      bytes: bytes.toString("base64"), type: control?.type ?? null,
      source, offset,
    };
    if (direction === "received") pair.receivedBytes += bytes.length;
    else pair.forwardedBytes += bytes.length;
    record(value);
    return { ...value, control };
  }
  function hold(pair, item) {
    if (pair.queuedBytes + item.bytes.length > maxQueueBytes || pair.queue.length >= maxQueueMessages) {
      fail("QUEUE_LIMIT");
      return;
    }
    pair.queue.push(item);
    pair.queuedBytes += item.bytes.length;
  }
  async function disconnect(pair, boundaryFrame) {
    if (pair.cutting || failure || closed) return;
    pair.cutting = true;
    armed = null;
    clearTimeout(timer);
    const snapshot = {
      arm: armNumber, boundary: pair.boundary, connection: pair.ordinal, sessionOrdinal: pair.sessions,
      upstreamFrame: boundaryFrame,
      receivedBytes: pair.receivedBytes, forwardedBytes: pair.forwardedBytes,
      replayBytes: pair.replayBytes, replayForwarded: pair.replayForwarded,
      lastAcknowledged: pair.lastAcknowledged,
      held: pair.queue.map(({ source, bytes, binary, offset }) => ({
        source, binary, offset, length: bytes.length, bytes: bytes.toString("base64"),
      })),
    };
    const ends = [pair.client, pair.up].map((socket) => socket.readyState === WebSocket.CLOSED
      ? Promise.resolve() : new Promise((resolve) => socket.once("close", resolve)));
    stopPair(pair);
    const deadline = setTimeout(() => fail("DISCONNECT_TIMEOUT"), deadlineMs);
    await Promise.all(ends);
    clearTimeout(deadline);
    if (failure || closed) return;
    receipt = { ...snapshot, disconnect: { client: "closed", upstream: "closed" } };
    pendingCut = false;
    record({ event: "cut", ...receipt });
    cut.resolve(receipt);
  }
  async function deliver(pair, item, awaitAck = false) {
    if (pair.client.readyState !== WebSocket.OPEN) {
      pairFailure(pair, "CLIENT_CLOSED_BEFORE_CUT");
      return;
    }
    const sent = frameRecord(pair, "forwarded", item.bytes, item.binary, item.source, item.offset);
    if (!sent) return;
    if (awaitAck) pair.awaiting = { frame: sent.frame, source: item.source };
    await new Promise((resolve, reject) => pair.client.send(item.bytes, { binary: item.binary },
      (error) => error ? reject(error) : resolve()));
  }
  async function pump(pair) {
    if (pair.pumping || pair.awaiting || pair.cutting || pair.ended || failure || closed) return;
    pair.pumping = true;
    try {
      while (pair.queue.length && !pair.awaiting && !pair.cutting && !pair.ended && !failure && !closed) {
        const item = pair.queue.shift();
        pair.queuedBytes -= item.bytes.length;
        if (item.type === "session") {
          pair.sessions++;
          pair.replayBytes = item.control.replay_bytes;
          pair.replayForwarded = 0;
        }
        const active = armed && pair === selected && pair.sessions === armed.sessionOrdinal;
        if (active && item.type === "session") {
          if (armed.boundary === "before-session") {
            pair.queue.unshift(item); pair.queuedBytes += item.bytes.length;
            pair.awaiting = { frame: pair.forwarded, source: item.source };
            if (pair.forwarded === 0 || pair.lastAcknowledged?.frame === pair.forwarded) void disconnect(pair, item.source);
            break;
          }
          if (armed.boundary === "inside-replay" &&
              (!Number.isSafeInteger(pair.replayBytes) || armed.bytes >= pair.replayBytes)) {
            fail("INVALID_REPLAY_BOUNDARY"); break;
          }
        }
        if (active && armed.boundary === "before-ready" && item.type === "ready") {
          pair.queue.unshift(item); pair.queuedBytes += item.bytes.length;
          pair.awaiting = { frame: pair.forwarded, source: item.source };
          if (pair.lastAcknowledged?.frame === pair.forwarded) void disconnect(pair, item.source);
          break;
        }
        if (active && item.binary && armed.boundary === "inside-replay" && pair.replayBytes !== null) {
          const remaining = armed.bytes - pair.replayForwarded;
          const length = Math.min(remaining, item.bytes.length);
          pair.replayForwarded += length;
          if (length < item.bytes.length) {
            pair.queue.unshift({ ...item, bytes: item.bytes.subarray(length), offset: length });
            pair.queuedBytes += item.bytes.length - length;
          }
          await deliver(pair, { ...item, bytes: item.bytes.subarray(0, length) }, length === remaining);
        } else {
          if (active && item.binary && Number.isSafeInteger(pair.replayBytes)) {
            pair.replayForwarded += Math.min(item.bytes.length, Math.max(0, pair.replayBytes - pair.replayForwarded));
          }
          const atBoundary = active && ((armed.boundary === "after-session" && item.type === "session") ||
            (armed.boundary === "after-ready" && item.type === "ready"));
          await deliver(pair, item, atBoundary);
        }
      }
    } catch { if (!pair.cutting && !pair.ended && !closed) pairFailure(pair, "FORWARD_FAILED"); }
    finally { pair.pumping = false; }
  }

  const server = http.createServer((req, res) => {
    const up = http.request(target, { method: req.method, path: req.url, headers: req.headers }, (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.on("error", () => res.destroy());
      response.pipe(res);
    });
    up.on("socket", watch);
    up.on("error", () => {
      if (res.headersSent) res.destroy();
      else { res.writeHead(502); res.end(); }
    });
    req.on("aborted", () => up.destroy());
    req.pipe(up);
  });
  server.on("connection", watch);
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, target);
    if (url.pathname !== path || url.searchParams.get("session") !== session) {
      const up = watch(net.connect({ host: target.hostname, port: target.port || 80 }));
      up.on("connect", () => {
        up.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` +
          req.rawHeaders.reduce((s, value, i) => s + value + (i % 2 ? "\r\n" : ": "), "") + "\r\n");
        up.write(head);
        up.pipe(socket); socket.pipe(up);
      });
      up.on("error", () => socket.destroy());
      socket.on("close", () => up.destroy());
      up.on("close", () => socket.destroy());
      return;
    }
    const n = ++connections;
    const headers = { ...req.headers };
    for (const name of Object.keys(headers)) {
      if (name.startsWith("sec-websocket-") || name === "connection" || name === "upgrade") delete headers[name];
    }
    const protocols = req.headers["sec-websocket-protocol"]?.split(",").map((s) => s.trim()) ?? [];
    const up = new WebSocket(`ws://${target.host}${req.url}`, protocols, {
      headers, perMessageDeflate: false, handshakeTimeout: deadlineMs,
    });
    const pair = { up, client: null, ordinal: n, queue: [], queuedBytes: 0,
      received: 0, forwarded: 0, receivedBytes: 0, forwardedBytes: 0,
      replayBytes: null, replayForwarded: 0, lastAcknowledged: null, sessions: 0,
    };
    peers.add(pair);
    if (n === armed?.ordinal) { selected = pair; pair.boundary = armed.boundary; }
    record({ event: "connection", connection: n, path, session,
      query: Object.fromEntries(["since", "generation", "cols", "rows"].filter((k) => url.searchParams.has(k))
        .map((k) => [k, url.searchParams.get(k)])),
    });
    up.on("open", () => {
      // The upstream's chosen subprotocol is authoritative for this handshake.
      wss.options.handleProtocols = () => up.protocol || false;
      wss.handleUpgrade(req, socket, head, (client) => {
        pair.client = client;
        client.on("error", () => { if (!pair.cutting && !closed) pairFailure(pair, "CLIENT_ERROR"); });
        client.on("message", (bytes, binary) => {
          if (up.bufferedAmount + bytes.length > maxQueueBytes) { fail("INPUT_QUEUE_LIMIT"); return; }
          if (up.readyState === WebSocket.OPEN) up.send(bytes, { binary });
        });
        client.on("close", () => {
          if (!pair.cutting && !closed) pairFailure(pair, "CLIENT_CLOSED_BEFORE_CUT");
          up.terminate();
        });
      });
    });
    up.on("message", (data, binary) => {
      if (pair.cutting || pair.ended || failure || closed) return;
      const bytes = Buffer.from(data);
      const frame = frameRecord(pair, "received", bytes, binary);
      if (!frame) return;
      hold(pair, { bytes, binary, source: frame.frame, type: frame.type, control: frame.control, offset: 0 });
      void pump(pair);
    });
    up.on("error", () => { socket.destroy(); if (!pair.cutting && !closed) pairFailure(pair, "UPSTREAM_ERROR"); });
    up.on("close", () => {
      if (!pair.cutting && !closed) pairFailure(pair, "UPSTREAM_CLOSED_BEFORE_CUT");
      pair.client?.terminate();
      peers.delete(pair);
    });
    socket.on("close", () => { if (!pair.client) up.terminate(); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    records,
    arm({ boundary, bytes, ordinal: nextOrdinal = armNumber ? connections + 1 : ordinal, sessionOrdinal = 1 } = {}) {
      if (closed || failure || pendingCut) throw fault("CONTROLLER_DISARMED");
      if (!boundaries.has(boundary) || (boundary === "inside-replay" && (!Number.isSafeInteger(bytes) || bytes <= 0))) {
        throw fault("INVALID_BOUNDARY");
      }
      if (![nextOrdinal, sessionOrdinal].every((n) => Number.isSafeInteger(n) && n > 0)) throw fault("INVALID_ARM_SELECTION");
      const pair = [...peers].find((p) => p.ordinal === nextOrdinal && !p.ended && !p.cutting);
      if (nextOrdinal <= connections && (!pair || sessionOrdinal <= pair.sessions)) throw fault("CONTROLLER_DISARMED");
      selected = pair;
      if (pair) pair.boundary = boundary;
      cut = deferred();
      armNumber++;
      pendingCut = true;
      armed = { boundary, bytes, ordinal: nextOrdinal, sessionOrdinal };
      timer = setTimeout(() => fail(!selected ? "NO_SELECTED_SOCKET" : selected.awaiting ? "ACK_TIMEOUT" : "FRAME_TIMEOUT"), deadlineMs);
    },
    acknowledge({ connection, frame, drained = false }) {
      const pair = [...peers].find((p) => p.ordinal === connection);
      if (!pair || pair.cutting || closed || failure || !Number.isSafeInteger(frame) || frame <= 0 ||
          frame > pair.forwarded || frame <= (pair.lastAcknowledged?.frame ?? 0)) throw fault("INVALID_ACK");
      pair.lastAcknowledged = { frame, drained: Boolean(drained) };
      record({ event: "ack", connection, ...pair.lastAcknowledged });
      if (pair.awaiting?.frame === frame) void disconnect(pair, pair.awaiting.source);
    },
    waitForCut() {
      if (failure) return Promise.reject(failure);
      if (!cut) return Promise.reject(fault("NOT_ARMED"));
      return cut.promise;
    },
    waitForRecord(predicate, timeoutMs = deadlineMs) {
      const found = records.find(predicate);
      if (found) return Promise.resolve(found);
      if (failure || closed) return Promise.reject(failure ?? fault("PROXY_CLOSED"));
      return new Promise((resolve, reject) => {
        const finish = (error, value) => {
          clearTimeout(timeout); events.off("record", onRecord); events.off("failure", onFailure);
          error ? reject(error) : resolve(value);
        };
        const onRecord = (value) => { if (predicate(value)) finish(null, value); };
        const onFailure = (error) => finish(error);
        const timeout = setTimeout(() => finish(fault("RECORD_TIMEOUT")), timeoutMs);
        events.on("record", onRecord); events.on("failure", onFailure);
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      if (pendingCut && !failure) cut.reject(fault("PROXY_CLOSED_BEFORE_CUT"));
      events.emit("failure", fault("PROXY_CLOSED"));
      const ended = [...peers].flatMap((p) => [p.client, p.up]).filter(Boolean).map((socket) =>
        socket.readyState === WebSocket.CLOSED ? Promise.resolve() : new Promise((resolve) => socket.once("close", resolve)));
      for (const pair of peers) stopPair(pair);
      for (const socket of sockets) socket.destroy();
      await Promise.all([new Promise((resolve) => server.close(resolve)),
        new Promise((resolve) => wss.close(resolve)), ...ended]);
    },
  };
}
