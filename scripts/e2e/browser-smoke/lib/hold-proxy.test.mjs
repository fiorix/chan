import assert from "node:assert/strict";
import { connect, createServer } from "node:net";
import test from "node:test";
import { connectionKind, startHoldProxy } from "./hold-proxy.mjs";

const SWITCHED = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n";
const FRAMES = ["one", "two", "three"];
const ANSWER = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";

/// A server that answers an upgrade with three frames and any other request
/// with a short answer, and records what each connection sent it.
async function startUpstream() {
  const heard = [];
  const server = createServer((socket) => {
    let head = "";
    let answered = false;
    socket.on("data", (chunk) => {
      head += chunk.toString("latin1");
      heard.push(chunk.toString("latin1"));
      if (answered || !head.includes("\r\n\r\n")) return;
      answered = true;
      if (/^upgrade: websocket$/im.test(head)) {
        socket.write(SWITCHED);
        for (const frame of FRAMES) socket.write(frame);
      } else {
        socket.end(ANSWER);
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    heard,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/// A client of the proxy that sends `head` and keeps all it receives.
function client(port, head) {
  const socket = connect({ host: "127.0.0.1", port });
  const record = { socket, received: "", ended: false };
  socket.on("data", (chunk) => {
    record.received += chunk.toString("latin1");
  });
  socket.on("end", () => {
    record.ended = true;
  });
  socket.on("error", () => {});
  socket.write(head);
  return record;
}

/// Wait for `probe` across event-loop turns, never on a clock.
async function until(label, probe) {
  for (let turn = 0; turn < 200_000; turn += 1) {
    if (probe()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`never: ${label}`);
}

const SOCKET_HEAD = "GET /ws?t=secret HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n";
const HTTP_HEAD = "GET /api/drafts?t=secret HTTP/1.1\r\nHost: x\r\n\r\n";

test("a connection's kind is read from its first request head", () => {
  const upgrade = (path) => `GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade`;
  assert.equal(connectionKind(upgrade("/ws?t=x")), "socket");
  assert.equal(connectionKind(upgrade("/demo/ws")), "socket", "the event socket under a tenant prefix");
  assert.equal(connectionKind(upgrade("/api/terminal/ws?session=s")), "http", "a terminal socket");
  assert.equal(connectionKind("GET /ws HTTP/1.1\r\nHost: x"), "http", "no upgrade");
  assert.equal(connectionKind("POST /api/drafts/new HTTP/1.1\r\nHost: x"), "http");
});

test("a held socket delivers nothing until release, then everything in order, while HTTP flows", async () => {
  const upstream = await startUpstream();
  const proxy = await startHoldProxy({ targetPort: upstream.port });
  try {
    proxy.hold("socket");
    const socket = client(proxy.port, SOCKET_HEAD);
    await until("the server's answer queued on the held socket", () => proxy.queued("socket") > 0);
    socket.socket.write("ping");
    await until("the page's bytes reaching the server while held", () => upstream.heard.join("").endsWith("ping"));

    const http = client(proxy.port, HTTP_HEAD);
    await until("the HTTP answer through", () => http.ended);
    assert.equal(http.received, ANSWER, "the other kind flows");
    assert.equal(socket.received, "", "the held socket delivered nothing");

    proxy.release("socket");
    const expected = SWITCHED + FRAMES.join("");
    await until("the held bytes delivered", () => socket.received.length >= expected.length);
    assert.equal(socket.received, expected);
    assert.deepEqual(proxy.connections(), [
      { kind: "socket", path: "/ws" },
      { kind: "http", path: "/api/drafts" },
    ]);
    socket.socket.destroy();
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("held HTTP holds connections opened after the hold, while the socket flows", async () => {
  const upstream = await startUpstream();
  const proxy = await startHoldProxy({ targetPort: upstream.port });
  try {
    const socket = client(proxy.port, SOCKET_HEAD);
    const expected = SWITCHED + FRAMES.join("");
    await until("the socket's frames through", () => socket.received.length >= expected.length);

    proxy.hold("http");
    const http = client(proxy.port, HTTP_HEAD);
    await until("the HTTP answer queued", () => proxy.queued("http") > 0);
    assert.equal(http.received, "", "the held HTTP connection delivered nothing");
    assert.equal(socket.received, expected, "the socket flowed");

    proxy.release("http");
    await until("the HTTP answer delivered", () => http.ended);
    assert.equal(http.received, ANSWER);
    socket.socket.destroy();
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
