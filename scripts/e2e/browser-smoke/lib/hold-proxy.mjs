// TCP relay between the browser and the chan server that can hold what the
// server sends, by the kind of connection: a check freezes the server-to-page
// direction across a mutation's answer deadline and lets it go after, so the
// page meets the server's late answer and its announcing frame in the order a
// slow server would make. A connection's kind is read from its first request
// head as it is forwarded unchanged: a WebSocket upgrade to the event socket,
// `/ws` under the window's tenant prefix, is a `socket`, and everything else,
// the terminal and document sockets under `/api/` among it, is `http`. The
// page-to-server direction is never held. A held direction is `pipeHeld`'s
// queue, delivered in the order received at release.

import { connect, createServer } from "node:net";
import { pipeHeld } from "./delay-proxy.mjs";

const HEAD_END = "\r\n\r\n";
const HEAD_LIMIT = 64 * 1024;

/// The kind of a connection whose first request head is `head`.
export function connectionKind(head) {
  const [requestLine = "", ...headers] = head.split("\r\n");
  const path = requestPath(requestLine);
  const upgrade = headers.some((line) => /^upgrade:\s*websocket\s*$/i.test(line));
  const eventSocket = path === "/ws" || (path.endsWith("/ws") && !path.includes("/api/"));
  return upgrade && eventSocket ? "socket" : "http";
}

function requestPath(requestLine) {
  return (requestLine.split(" ")[1] ?? "").split("?")[0];
}

export function startHoldProxy({ targetHost = "127.0.0.1", targetPort }) {
  const held = { http: false, socket: false };
  const connections = [];
  const sockets = new Set();

  const server = createServer((client) => {
    const up = connect({ host: targetHost, port: targetPort });
    sockets.add(client);
    sockets.add(up);
    client.on("close", () => sockets.delete(client));
    up.on("close", () => sockets.delete(up));
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
    // Nothing reaches the page before the connection's kind is known.
    const down = pipeHeld(up, client, { held: true });
    const connection = { kind: null, path: null, down };
    let head = "";
    client.on("data", (chunk) => {
      if (connection.kind === null) {
        head += chunk.toString("latin1");
        const end = head.indexOf(HEAD_END);
        if (end >= 0 || head.length > HEAD_LIMIT) {
          const requestHead = end >= 0 ? head.slice(0, end) : head;
          connection.kind = connectionKind(requestHead);
          connection.path = requestPath(requestHead.split("\r\n", 1)[0]);
          connections.push(connection);
          if (!held[connection.kind]) down.release();
        }
      }
      if (!up.destroyed) up.write(chunk);
    });
    client.on("end", () => {
      if (!up.destroyed) up.end();
    });
  });

  const known = (kind) => {
    if (kind !== "http" && kind !== "socket") throw new Error(`no connection kind ${kind}`);
    return kind;
  };
  const of = (kind) => connections.filter((connection) => connection.kind === known(kind));

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        /// Queue what the server sends on every connection of `kind`, those
        /// open now and those opened while held.
        hold(kind) {
          held[known(kind)] = true;
          for (const connection of of(kind)) connection.down.hold();
        },
        /// Deliver what was queued, in order, and stop holding `kind`.
        release(kind) {
          held[known(kind)] = false;
          for (const connection of of(kind)) connection.down.release();
        },
        /// How many chunks the server sent on connections of `kind` that are
        /// queued and not yet delivered.
        queued(kind) {
          return of(kind).reduce((sum, connection) => sum + connection.down.queued, 0);
        },
        /// The connections whose kind is known, with the path each first
        /// asked for (no query, so no token).
        connections() {
          return connections.map(({ kind, path }) => ({ kind, path }));
        },
        close() {
          for (const socket of sockets) socket.destroy();
          sockets.clear();
          return new Promise((done) => server.close(done));
        },
      });
    });
  });
}
