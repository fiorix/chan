// TCP relay that adds fixed one-way latency in each direction between
// the browser and the chan server. Latency has to be injected at the
// socket layer because Chrome's Network.emulateNetworkConditions does
// not delay WebSocket frames, and the doc/scene/terminal sync paths
// all ride WebSockets. Chunks are delivered at receipt time + delay
// with ordering preserved even across setLatency changes.

import { createServer, connect } from "node:net";

export function pipeDelayed(src, dst, getDelay, now = Date.now) {
  // Delivery is monotonic per direction: a chunk never overtakes an
  // earlier one, even when setLatency lowers the delay mid-stream.
  let lastAt = 0;
  const pending = [];
  const deliver = () => {
    const due = pending[0].at;
    do {
      pending.shift().fn();
    } while (pending.length && pending[0].at <= due);
    if (pending.length) {
      setTimeout(deliver, Math.max(0, pending[0].at - now()));
    }
  };
  const after = (fn) => {
    const receivedAt = now();
    const at = Math.max(receivedAt + getDelay(), lastAt);
    lastAt = at;
    pending.push({ at, fn });
    if (pending.length === 1) {
      setTimeout(deliver, Math.max(0, at - receivedAt));
    }
  };
  src.on("data", (chunk) => after(() => {
    if (!dst.destroyed) dst.write(chunk);
  }));
  src.on("end", () => after(() => {
    if (!dst.destroyed) dst.end();
  }));
  src.on("error", () => after(() => dst.destroy()));
}

// The same ordering with a delay that ends at a release instead of at a
// time: what `src` sends while held is queued, and `release()` delivers it in
// the order received before anything that arrives after. Nothing overtakes a
// queued chunk, and a held end or error waits behind the data before it.
export function pipeHeld(src, dst, { held = false } = {}) {
  let holding = held;
  const pending = [];
  const after = (fn) => {
    if (holding || pending.length) pending.push(fn);
    else fn();
  };
  src.on("data", (chunk) => after(() => {
    if (!dst.destroyed) dst.write(chunk);
  }));
  src.on("end", () => after(() => {
    if (!dst.destroyed) dst.end();
  }));
  src.on("error", () => after(() => dst.destroy()));
  return {
    get held() {
      return holding;
    },
    get queued() {
      return pending.length;
    },
    hold() {
      holding = true;
    },
    release() {
      holding = false;
      while (pending.length && !holding) pending.shift()();
    },
  };
}

export function startDelayProxy({ targetHost = "127.0.0.1", targetPort, latencyMs = 0, now = Date.now }) {
  let delay = latencyMs;
  const sockets = new Set();

  const server = createServer((client) => {
    const up = connect({ host: targetHost, port: targetPort });
    sockets.add(client);
    sockets.add(up);
    up.on("connect", () => {
      pipeDelayed(client, up, () => delay, now);
      pipeDelayed(up, client, () => delay, now);
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
