// `seq 1 400000` through a ghostty terminal that falls behind arrives whole,
// in headless Chrome with the page's CPU throttled 20 times: unthrottled, the
// page keeps up with this load and the check would prove nothing. It reads
// every byte the page's sockets handed to the app and walks the numbers in
// order, then reads what the terminal itself retains: its history and screen
// must be consecutive numbers ending at the last one, with no lag line and no
// missed-bytes line. It says nothing about WebKit or the xterm.js engine.

import assert from "node:assert/strict";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { readTerminalPrefs, restoreTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";
import {
  installStreamProbe, readGhosttyText, trackGhosttyTerminals, until,
} from "../lib/stream-probe.mjs";

const NAME = "FastStream334";
const COUNT = 400_000;
const BEGIN = "__SEQ334_BEGIN__";
const END = "__SEQ334_END__";
const CPU_THROTTLE = 20;

export default {
  name: "terminal-fast-stream-whole",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
    await page.bringToFront();
    const windowId = await page.evaluate(() => new URL(location.href).searchParams.get("w")?.trim()
      || sessionStorage.getItem("chan.session.window")?.trim() || "");
    assert.ok(windowId, "the page's window id");
    await ctx.waitWindowLive(windowId);
    const cs = (args) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
      cwd: ctx.workspaceDir,
      env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId },
      timeout: 90_000,
    });
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const original = await readTerminalPrefs(page, token);
    try {
      await writeTerminalPrefs(page, token, { ghostty: true, secret_masking: false });
      assert.ok(await trackGhosttyTerminals(page), "the entry module names a ghostty-web chunk");
      await page.evaluate(installStreamProbe);
      const command = `stty -echo; IFS= read -r _; printf '${BEGIN}\\n'; seq 1 ${COUNT}; printf '${END}'; exec sleep 600`;
      await openAttachedTerminal(ctx, page, cs, windowId, NAME, "ghostty", ["--command", command]);
      const read = () => page.evaluate((name) => __streamProbe.read(name), NAME);
      await until("the terminal socket is ready", read, (state) => state?.ready);
      await page.emulateCPUThrottling(CPU_THROTTLE);
      await page.evaluate((name, begin, count, end) => {
        __streamProbe.verifySeq(name, begin, count, end);
        __streamProbe.input(name, "\r");
      }, NAME, BEGIN, COUNT, END);

      const finished = await until("the stream reaches its end marker", read,
        (state) => state.verifier.done || state.verifier.mismatch || state.allErrors.length > 0, 240_000);
      await page.emulateCPUThrottling(null);
      assert.deepEqual(finished.allErrors, [], "the terminal prints no lag line");
      assert.equal(finished.verifier.mismatch, null, "every number arrives once and in order");
      assert.equal(finished.verifier.lines, COUNT, "the page handled the whole sequence");
      assert.equal(finished.socketCount, 1, "the view kept its socket");
      assert.equal(finished.sessions.length, 1, "no recovery was needed");

      const retained = await readGhosttyText(page);
      const lines = retained.text.split("\n").map((line) => line.trim()).filter(Boolean);
      assert.ok(!retained.text.includes("terminal output lagged"), "no lag line in the buffer");
      assert.ok(!retained.text.includes("terminal replay missed"), "no missed-bytes line in the buffer");
      const numbers = lines.filter((line) => /^\d+$/.test(line)).map(Number);
      assert.ok(numbers.length >= retained.rows - 2, `the terminal retains the stream: ${numbers.length}`);
      for (let index = 1; index < numbers.length; index += 1) {
        assert.equal(numbers[index], numbers[index - 1] + 1, `retained line ${index} follows its neighbour`);
      }
      assert.equal(numbers.at(-1), COUNT, "the retained text ends at the last number");
      await ctx.shot("334-whole-stream");
      return {
        cpuThrottle: CPU_THROTTLE, lines: finished.verifier.lines, retainedLines: numbers.length, acks: finished.acks,
      };
    } finally {
      await page.emulateCPUThrottling(null).catch(() => {});
      await cs(["close", "--tab-name", NAME]).catch(() => {});
      await restoreTerminalPrefs(ctx, page, token, original);
    }
  },
};
