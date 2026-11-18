// A TCP relay in front of one local port that delays or silences every HTTP
// and WebSocket flow through it, for checks that put a slow or silent link
// between a client and its server. It can also drop every open flow, refuse
// new ones, and show a caller each chunk with the flow it belongs to.

import { createServer, connect } from "node:net";

/// Start a relay on a free loopback port to `targetPort` on `host`. Each
/// flow records its request path and head (the request line and headers,
/// latin1) once they have arrived.
export async function startRelay(targetPort, { host = "127.0.0.1" } = {}) {
  const flows = [];
  const taps = [];
  let silent = false;
  let refusing = false;
  let latencyMs = 0;
  const server = createServer({ allowHalfOpen: true }, (client) => {
    // A refused connection is closed as it is accepted, as a dead link
    // would leave a dial with nothing.
    if (refusing) {
      client.destroy();
      return;
    }
    const flow = {
      client, upstream: null, path: null, head: null, queues: [], resume: [],
      closed: false, clientEnded: false,
    };
    flows.push(flow);
    let requestHead = Buffer.alloc(0);

    const direction = (source, targetSocket, index) => {
      const queue = [];
      flow.queues[index] = queue;
      let timer = null;
      let waitingDrain = false;
      const pump = () => {
        const target = targetSocket();
        if (!target) return;
        if (timer || waitingDrain || silent || target.destroyed || !queue.length) return;
        const wait = Math.max(0, queue[0].due - Date.now());
        if (wait > 0) {
          timer = setTimeout(() => {
            timer = null;
            pump();
          }, wait);
          return;
        }
        while (!silent && !target.destroyed && queue.length && queue[0].due <= Date.now()) {
          const item = queue.shift();
          if (item.end) {
            target.end();
            return;
          }
          if (!target.write(item.data)) {
            waitingDrain = true;
            return;
          }
        }
        if (queue.length) pump();
      };
      source.on("data", (data) => {
        if (index === 0 && flow.head === null) {
          requestHead = Buffer.concat([requestHead, data]);
          if (flow.path === null) {
            const end = requestHead.indexOf(10);
            if (end >= 0) {
              const targetPath = requestHead.toString("utf8", 0, end).split(" ")[1];
              flow.path = targetPath ? new URL(targetPath, "http://127.0.0.1").pathname : "unknown";
            }
          }
          const headEnd = requestHead.indexOf("\r\n\r\n");
          if (headEnd >= 0 || requestHead.length > 16_384) {
            flow.head = requestHead.toString("latin1", 0, headEnd >= 0 ? headEnd : requestHead.length);
            requestHead = Buffer.alloc(0);
          }
        }
        for (const tap of taps) tap(flow, index, data);
        queue.push({ data, due: Date.now() + latencyMs });
        pump();
      });
      source.on("end", () => {
        if (index === 0) flow.clientEnded = true;
        queue.push({ end: true, due: Date.now() + latencyMs });
        pump();
      });
      return (drained = false) => {
        if (drained) waitingDrain = false;
        if (timer) clearTimeout(timer);
        timer = null;
        pump();
      };
    };
    flow.resume.push(direction(client, () => flow.upstream, 0));
    flow.openUpstream = () => {
      if (flow.upstream || client.destroyed || flow.clientEnded || client.readableEnded) return;
      const upstream = connect({ host, port: targetPort, allowHalfOpen: true });
      flow.upstream = upstream;
      flow.resume.push(direction(upstream, () => client, 1));
      upstream.on("drain", () => flow.resume[0](true));
      client.on("drain", () => flow.resume[1](true));
      upstream.on("error", () => { client.destroy(); upstream.destroy(); });
      upstream.on("close", () => { flow.closed = client.destroyed && upstream.destroyed; });
      flow.resume[0]();
    };
    client.on("error", () => {
      client.destroy();
      flow.upstream?.destroy();
    });
    client.on("close", () => {
      flow.closed = client.destroyed && (flow.upstream?.destroyed ?? true);
    });
    // A connection accepted during silence stays local until the link returns.
    if (!silent) flow.openUpstream();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    flows,
    setDelay(ms) {
      latencyMs = ms;
      for (const flow of flows) flow.resume.forEach((resume) => resume());
    },
    silence() { silent = true; },
    resume() {
      silent = false;
      for (const flow of flows) {
        if (!flow.upstream) {
          if (flow.client.destroyed || flow.clientEnded || flow.client.readableEnded) {
            flow.client.destroy();
            continue;
          }
          flow.openUpstream();
        }
        flow.resume.forEach((resume) => resume());
      }
    },
    /// Close every open flow at both ends, as a link that went away does.
    drop() {
      for (const flow of flows) {
        flow.client.destroy();
        flow.upstream?.destroy();
      }
    },
    /// While on, close each new connection as it is accepted.
    refuse(on) { refusing = on; },
    /// Call `fn(flow, index, chunk)` for each chunk as it arrives, before any
    /// delay: index 0 is the client's, 1 the server's.
    tap(fn) { taps.push(fn); },
    summary() {
      return {
        silent,
        refusing,
        latencyMs,
        flows: flows.map((flow) => ({
          path: flow.path,
          closed: flow.closed,
          queued: flow.queues.map((queue) => queue.length),
        })),
      };
    },
    async close() {
      for (const flow of flows) {
        flow.client.destroy();
        flow.upstream?.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/// Read the WebSocket frames a client sends, masked as a client's are, from
/// the bytes after its upgrade request: `push(chunk)` answers the complete
/// frames it finished, each `{ opcode, text }` with the payload unmasked.
export function clientFrameReader() {
  let buffered = Buffer.alloc(0);
  return {
    push(chunk) {
      buffered = Buffer.concat([buffered, chunk]);
      const frames = [];
      for (;;) {
        if (buffered.length < 2) break;
        const opcode = buffered[0] & 0x0f;
        const masked = (buffered[1] & 0x80) !== 0;
        let length = buffered[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffered.length < 4) break;
          length = buffered.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffered.length < 10) break;
          length = Number(buffered.readBigUInt64BE(2));
          offset = 10;
        }
        const keyAt = offset;
        if (masked) offset += 4;
        if (buffered.length < offset + length) break;
        const payload = Buffer.from(buffered.subarray(offset, offset + length));
        if (masked) {
          for (let i = 0; i < payload.length; i++) payload[i] ^= buffered[keyAt + (i % 4)];
        }
        frames.push({ opcode, text: opcode === 1 ? payload.toString("utf8") : null });
        buffered = buffered.subarray(offset + length);
      }
      return frames;
    },
  };
}
