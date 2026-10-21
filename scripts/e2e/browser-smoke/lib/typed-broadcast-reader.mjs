// A raw-mode program for check 178, run in a terminal: it records every byte
// its PTY delivers as an input row with a monotonic stamp, and as the source
// it prints 720-character lines every 2 ms between SIGUSR2 and SIGUSR1 and
// asks for the cursor position on SIGHUP, which the terminal answers on its
// input. Usage: typed-broadcast-reader.mjs source|target /absolute/log.jsonl

import { openSync, writeSync } from "node:fs";

const [role, logPath] = process.argv.slice(2);
if (!["source", "target"].includes(role) || !logPath?.startsWith("/")) {
  throw new Error("usage: typed-broadcast-reader.mjs source|target /absolute/log.jsonl");
}
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("PTY required");

const fd = openSync(logPath, "wx", 0o600);
const record = (row) => writeSync(fd, `${JSON.stringify({ ...row, tNs: process.hrtime.bigint().toString() })}\n`);
let interval = null;
let line = 0;
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (bytes) => record({ type: "input", hex: bytes.toString("hex") }));
process.on("SIGUSR2", () => {
  if (role !== "source" || interval) return;
  record({ type: "stream-start" });
  interval = setInterval(() => {
    const n = line++;
    record({ type: "stream", line: n });
    process.stdout.write(`TBCAST_STREAM_${String(n).padStart(6, "0")}:${"x".repeat(720)}\r\n`);
  }, 2);
});
process.on("SIGUSR1", () => {
  if (!interval) return;
  clearInterval(interval);
  interval = null;
  record({ type: "stream-stop" });
});
process.on("SIGHUP", () => {
  if (role !== "source") return;
  record({ type: "cursor-request" });
  process.stdout.write("\x1b[6n");
});
record({ type: "ready", role, pid: process.pid });
process.stdout.write(`TBCAST_READY_${role}\r\n`);
