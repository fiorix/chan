// TCP relay that adds fixed one-way latency in each direction between
// the browser and the chan server. Latency has to be injected at the
// socket layer because Chrome's Network.emulateNetworkConditions does
// not delay WebSocket frames, and the doc/scene/terminal sync paths
// all ride WebSockets. Chunks are delivered at receipt time + delay
// with ordering preserved even across setLatency changes.

import { createServer, connect } from "node:net";

export function startDelayProxy({ targetHost = "127.0.0.1", targetPort, latencyMs = 0 }) {
  let delay = latencyMs;
  const sockets = new Set();

  // Delivery is monotonic per direction: a chunk never overtakes an
  // earlier one, even when setLatency lowers the delay mid-stream.
  const pipeDelayed = (src, dst) => {
    let lastAt = 0;
    const after = (fn) => {
      const at = Math.max(Date.now() + delay, lastAt);
      lastAt = at;
      setTimeout(fn, Math.max(0, at - Date.now()));
    };
    src.on("data", (chunk) => after(() => {
      if (!dst.destroyed) dst.write(chunk);
    }));
    src.on("end", () => after(() => {
      if (!dst.destroyed) dst.end();
    }));
    src.on("error", () => after(() => dst.destroy()));
  };

  const server = createServer((client) => {
    const up = connect({ host: targetHost, port: targetPort });
    sockets.add(client);
    sockets.add(up);
    up.on("connect", () => {
      pipeDelayed(client, up);
      pipeDelayed(up, client);
    });
    up.on("error", () => client.destroy());
    client.on("close", () => sockets.delete(client));
    up.on("close", () => sockets.delete(up));
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        setLatency(ms) {
          delay = ms;
        },
        close() {
          for (const s of sockets) s.destroy();
          sockets.clear();
          return new Promise((r) => server.close(r));
        },
      });
    });
  });
}
