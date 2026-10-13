import { openSync, writeSync } from "node:fs";

const logPath = process.argv[2];
if (!logPath?.startsWith("/") || !process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error("usage: ftrip-reader.mjs /absolute/log on a PTY");
}
const fd = openSync(logPath, "wx", 0o600);
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (bytes) => writeSync(fd, `${JSON.stringify({ type: "input", hex: bytes.toString("hex") })}\n`));
writeSync(fd, `${JSON.stringify({ type: "ready", pid: process.pid })}\n`);
process.stdout.write("\x1b[?1004hFTRIP_READY\r\n");
