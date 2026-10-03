import { createHash, randomBytes } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { open } from "node:fs/promises";
import net from "node:net";
import { fileURLToPath } from "node:url";

const error = (code) => Object.assign(new Error(code), { code });
const fixturePath = fileURLToPath(import.meta.url);
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function jsonLines(socket, receive, failed) {
  let pending = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    pending += chunk;
    if (pending.length > 1024 * 1024) { failed(error("CONTROL_LIMIT")); socket.destroy(); return; }
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      try { receive(JSON.parse(line)); } catch { failed(error("INVALID_CONTROL")); socket.destroy(); return; }
    }
  });
  socket.on("error", () => failed(error("CONTROL_SOCKET_ERROR")));
}

/** Control endpoint for exactly one raw terminal fixture process. */
export async function startTerminalFixture({ logPath, deadlineMs = 5000 }) {
  if (!logPath?.startsWith("/") || !Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw error("INVALID_FIXTURE_OPTIONS");
  const token = randomBytes(24).toString("hex");
  const events = new EventEmitter(), records = [], pending = new Map(), sockets = new Set();
  let peer, identity, failure, nextId = 0, stopped = false;
  const fail = (reason) => {
    failure ??= reason;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(failure); }
    pending.clear();
    events.emit("failure", failure);
  };
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    let authenticated = false;
    jsonLines(socket, (message) => {
      if (!authenticated) {
        if (peer || message.token !== token || message.type !== "hello") {
          fail(error("FIXTURE_IDENTITY_REFUSED")); socket.destroy(); return;
        }
        authenticated = true; peer = socket;
        identity = { type: "hello", pid: message.pid, tty: message.tty, raw: message.raw, cols: message.cols, rows: message.rows };
        records.push(identity); events.emit("record", identity);
        return;
      }
      records.push(message); events.emit("record", message);
      if (message.type === "reply") {
        const request = pending.get(message.id);
        if (!request) { fail(error("UNEXPECTED_REPLY")); return; }
        pending.delete(message.id); clearTimeout(request.timer);
        message.ok ? request.resolve(message.value) : request.reject(error(message.code));
      }
    }, fail);
    socket.on("close", () => { if (!stopped) fail(error("FIXTURE_DISCONNECTED")); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  function waitFor(predicate) {
    const found = records.find(predicate);
    if (found) return Promise.resolve(found);
    if (failure || stopped) return Promise.reject(failure ?? error("FIXTURE_STOPPED"));
    return new Promise((resolve, reject) => {
      const finish = (reason, value) => {
        clearTimeout(timer); events.off("record", onRecord); events.off("failure", onFailure);
        reason ? reject(reason) : resolve(value);
      };
      const onRecord = (message) => { if (predicate(message)) finish(null, message); };
      const onFailure = (reason) => finish(reason);
      const timer = setTimeout(() => finish(error("FIXTURE_EVENT_TIMEOUT")), deadlineMs);
      events.on("record", onRecord); events.on("failure", onFailure);
    });
  }
  async function command(op, args = {}) {
    await waitFor((record) => record.type === "hello");
    if (failure || stopped) throw failure ?? error("FIXTURE_STOPPED");
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(error("FIXTURE_COMMAND_TIMEOUT")); }, deadlineMs);
      pending.set(id, { resolve, reject, timer });
      peer.write(JSON.stringify({ ...args, op, id }) + "\n");
    });
  }
  return {
    // The caller supplies these env vars to the terminal it creates, never to
    // its hosting devserver. The fixture itself requires a real raw PTY.
    command: `exec ${shellQuote(process.execPath)} ${shellQuote(fixturePath)}`,
    env: { TERMINAL_FIXTURE_PORT: String(server.address().port), TERMINAL_FIXTURE_TOKEN: token, TERMINAL_FIXTURE_LOG: logPath },
    records, ready: () => waitFor((record) => record.type === "hello"), send: command, waitFor,
    async close() {
      if (stopped) return;
      stopped = true;
      fail(error("FIXTURE_STOPPED"));
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Run in a PTY; output advances only through acknowledged control commands. */
export async function runTerminalFixture({ port, token, logPath, input = process.stdin, output = process.stdout }) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") throw error("PTY_REQUIRED");
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !token || !logPath?.startsWith("/")) throw error("INVALID_FIXTURE_OPTIONS");
  const log = await open(logPath, "wx", 0o600);
  const socket = net.connect({ host: "127.0.0.1", port });
  const ended = new Promise((resolve) => socket.once("close", resolve));
  let chain = Promise.resolve(), offset = 0, row = 0, alternate = false, barrier = null, failure;
  const hash = createHash("sha256");
  const originalRaw = input.isRaw;
  const send = (value) => socket.write(JSON.stringify(value) + "\n");
  const named = (name) => typeof name === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(name);
  const snapshot = () => ({ offset, sha256: hash.copy().digest("hex"), row, alternate, barrier });
  async function emit(bytes) {
    if (barrier !== null) throw error("BARRIER_HELD");
    await log.writeFile(bytes);
    await new Promise((resolve, reject) => output.write(bytes, (reason) => reason ? reject(reason) : resolve()));
    hash.update(bytes); offset += bytes.length;
  }
  async function execute(message) {
    const { op, name } = message;
    switch (op) {
      case "rows": {
        if (!named(message.prefix) || !Number.isInteger(message.count) || message.count < 1 || message.count > 100000) throw error("INVALID_ROWS");
        for (let n = 0; n < message.count; n++) {
          await emit(Buffer.from(`${message.prefix}:${String(row).padStart(8, "0")}\r\n`)); row++;
        }
        break;
      }
      case "marker":
        if (!named(name)) throw error("INVALID_NAME");
        await emit(Buffer.from(`MARKER:${name}\r\n`)); break;
      case "bytes":
        if (typeof message.base64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.base64)) throw error("INVALID_BYTES");
        await emit(Buffer.from(message.base64, "base64")); break;
      case "alternate":
        if (typeof message.enabled !== "boolean") throw error("INVALID_ALTERNATE");
        await emit(Buffer.from(message.enabled ? "\x1b[?1049h" : "\x1b[?1049l"));
        alternate = message.enabled; break;
      case "redraw":
        if (!alternate || !named(name)) throw error("INVALID_REDRAW");
        await emit(Buffer.from(`\x1b[2J\x1b[HSCREEN:${name}\r\n`)); break;
      case "barrier":
        if (barrier !== null || !named(name)) throw error("INVALID_BARRIER");
        barrier = name; await log.sync(); break;
      case "resume":
        if (barrier === null || name !== barrier) throw error("BARRIER_MISMATCH");
        barrier = null; break;
      case "stop":
        await log.sync(); break;
      default: throw error("UNKNOWN_COMMAND");
    }
    return snapshot();
  }
  const received = (bytes) => send({ type: "keys", base64: Buffer.from(bytes).toString("base64") });
  const fail = (reason) => { failure ??= reason; socket.destroy(); };
  try {
    await once(socket, "connect");
    input.setRawMode(true); input.on("data", received); input.resume();
    send({ type: "hello", token, pid: process.pid, tty: true, raw: input.isRaw, cols: output.columns, rows: output.rows });
    jsonLines(socket, (message) => {
      chain = chain.then(async () => {
        try {
          const value = await execute(message);
          send({ type: "reply", id: message.id, ok: true, value });
          if (message.op === "stop") socket.end();
        } catch (reason) {
          send({ type: "reply", id: message.id, ok: false, code: reason.code ?? "FIXTURE_IO_FAILED" });
        }
      }).catch(fail);
    }, fail);
    await ended;
    await chain;
    if (failure) throw failure;
  } finally {
    input.off("data", received); input.pause(); input.setRawMode(Boolean(originalRaw));
    socket.destroy(); await log.close();
  }
}

if (process.argv[1] === fixturePath) {
  runTerminalFixture({ port: Number(process.env.TERMINAL_FIXTURE_PORT), token: process.env.TERMINAL_FIXTURE_TOKEN,
    logPath: process.env.TERMINAL_FIXTURE_LOG }).catch((reason) => {
    process.stderr.write(`terminal fixture: ${reason.code ?? "FAILED"}\n`); process.exitCode = 1;
  });
}
