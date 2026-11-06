import { existsSync, readFileSync } from "node:fs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFile(label, path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`${label}: ${path} did not appear within ${timeoutMs}ms`);
    await sleep(100);
  }
}

/// Turn the active terminal's shell into a recorder: in raw mode, dd writes
/// every byte the PTY receives to `file`, one at a time, with no line editing
/// that a stray byte could leave in a state of its own.
export async function startRecorder(page, file) {
  const host = await page.$eval(".pane .terminal-tab.active .terminal-host", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(host.x, host.y);
  await page.keyboard.type(`stty raw -echo && exec dd bs=1 status=none of=${file}`);
  await page.keyboard.press("Enter");
  await waitFile(`the recorder ${file}`, file, 30_000);
  await sleep(300);
}

/// The bytes the recorder holds past `offset`, once `expectedByte` is among them.
export async function recordedSince(label, file, offset, expectedByte) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const bytes = [...readFileSync(file).subarray(offset)].map((b) => b.toString(16).padStart(2, "0"));
    if (bytes.includes(expectedByte)) return bytes;
    if (Date.now() > deadline) throw new Error(`${label}: byte ${expectedByte} never reached the PTY; it read ${JSON.stringify(bytes)}`);
    await sleep(100);
  }
}
