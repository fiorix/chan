// Fast numbered streams through a ghostty terminal arrive whole, in headless
// Chrome.
//
//   short:   `seq 1 400000`, about 3.1 MB. An unpaced server's broadcast and
//            socket buffers absorb this much, so this leg passes without
//            pacing too.
//   stalled: `seq 1 4000000`, about 35 MB, with the page's main thread stopped
//            for 3 s partway through, inside the 5 s bound. This is the leg
//            an unpaced server fails, with its lag line.
//
// Each leg reads every byte the page's socket handed to the app, in order,
// then what the terminal itself retains: consecutive numbers ending at the
// last one, no lag line and no missed-bytes line. A gap over 6 s between 2 s
// wake ticks probes the socket and redials only if no frame answers in time.
// This check does not deliberately trigger that probe. It says nothing about
// WebKit.

import assert from "node:assert/strict";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { readTerminalPrefs, restoreTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";
import {
  installStreamProbe, readGhosttyText, trackGhosttyTerminals, until,
} from "../lib/stream-probe.mjs";

const NAME = "FastStream334";
const LEGS = [
  { key: "short", count: 400_000, stallAfterLines: null },
  { key: "stalled", count: 4_000_000, stallAfterLines: 500_000 },
].map((leg) => ({ ...leg, begin: `__${leg.key}334_BEGIN__`, end: `__${leg.key}334_END__` }));
const STALL_MS = 3_000;

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
      await writeTerminalPrefs(page, token, { secret_masking: false });
      assert.ok(await trackGhosttyTerminals(page), "the entry module names a ghostty-web chunk");
      await page.evaluate(installStreamProbe);
      const command = ["stty -echo", ...LEGS.flatMap(({ begin, end, count }) => [
        "IFS= read -r _", `printf '${begin}\\n'`, `seq -f %.0f 1 ${count}`, `printf '${end}'`,
      ]), "exec sleep 600"].join("; ");
      await openAttachedTerminal(ctx, page, cs, windowId, NAME, "ghostty", ["--command", command]);
      const read = () => page.evaluate((name) => __streamProbe.read(name), NAME);
      await until("the terminal socket is ready", read, (state) => state?.ready);
      const legs = {};
      for (const leg of LEGS) {
        await page.evaluate((name, { begin, end, count }) => {
          __streamProbe.verifySeq(name, begin, count, end);
          __streamProbe.input(name, "\r");
        }, NAME, leg);
        if (leg.stallAfterLines !== null) {
          await until(`the ${leg.key} stream is under way`, read,
            (state) => state.verifier.lines >= leg.stallAfterLines || state.verifier.done
              || state.verifier.mismatch || state.allErrors.length > 0, 120_000);
          await page.evaluate((name, ms) => __streamProbe.stall(name, ms), NAME, STALL_MS);
        }
        const finished = await until(`the ${leg.key} stream reaches its end marker`, read,
          (state) => state.verifier.done || state.verifier.mismatch || state.allErrors.length > 0, 240_000);
        assert.deepEqual(finished.allErrors, [], `${leg.key}: the terminal prints no lag line`);
        if (finished.verifier.mismatch) {
          const sockets = await page.evaluate((name) => __streamProbe.readAll(name), NAME);
          throw new Error(`${leg.key}: a number arrived out of order: ${JSON.stringify({
            mismatch: finished.verifier.mismatch,
            sockets: sockets.map(({ handled, frames, acks, lastAck, cursor, ready, sessions }) => ({
              handled, frames, acks, lastAck, cursor, ready, sessions,
            })),
          })}`);
        }
        assert.equal(finished.verifier.lines, leg.count, `${leg.key}: the page handled the whole stream`);
        assert.equal(finished.socketCount, 1, `${leg.key}: the view kept its socket`);
        assert.equal(finished.sessions.length, 1, `${leg.key}: no recovery was needed`);
        if (leg.stallAfterLines !== null) assert.ok(finished.stalls.at(-1)?.ended, `${leg.key}: the stall ran`);
        const retained = await readGhosttyText(page);
        assert.ok(!retained.text.includes("terminal output lagged"), `${leg.key}: no lag line in the buffer`);
        assert.ok(!retained.text.includes("terminal replay missed"), `${leg.key}: no missed-bytes line in the buffer`);
        const numbers = retained.text.split("\n").map((line) => line.trim())
          .filter((line) => /^\d+$/.test(line)).map(Number);
        assert.ok(numbers.length >= retained.rows - 2, `${leg.key}: the terminal retains the stream: ${numbers.length}`);
        for (let index = 1; index < numbers.length; index += 1) {
          assert.equal(numbers[index], numbers[index - 1] + 1, `${leg.key}: retained line ${index} follows its neighbour`);
        }
        assert.equal(numbers.at(-1), leg.count, `${leg.key}: the retained text ends at the last number`);
        legs[leg.key] = { lines: finished.verifier.lines, retainedLines: numbers.length, acks: finished.acks };
      }
      await ctx.shot("334-whole-stream");
      return { legs };
    } finally {
      await cs(["close", "--tab-name", NAME]).catch(() => {});
      await restoreTerminalPrefs(ctx, page, token, original);
    }
  },
};
