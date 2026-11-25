// Two ways a page under a fast paced stream reads as a machine sleep without
// being one, in headless Chrome on ghostty. In both the socket is healthy, so
// it must be kept and the stream must arrive whole and in order.
//
//   late:     a 4.8 s stall, inside the server's 5 s bound, that starts 1.9 s
//             after a wake probe's tick. The 2 s probes then land more than
//             6 s apart, though the stall alone is under the wake threshold.
//             Five runs, one stream each.
//   throttle: the page's CPU slowed 20 times, so the probes land that far
//             apart with no single long stall.
//
// It says nothing about WebKit, whose stall the desktop driver reads.

import assert from "node:assert/strict";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { readTerminalPrefs, restoreTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";
import {
  installStreamProbe, readGhosttyText, trackGhosttyTerminals, until,
} from "../lib/stream-probe.mjs";

const NAME = "WakePaced333";
const LATE_RUNS = 5;
const LATE_COUNT = 8_000_000;
const LATE_STALL_MS = 4_800;
const LATE_LEAD_MS = 1_900;
const THROTTLE = 20;
const THROTTLE_COUNT = 400_000;
const LEGS = [
  ...Array.from({ length: LATE_RUNS }, (_, run) => ({ key: `late${run}`, count: LATE_COUNT, throttle: null })),
  { key: "throttle", count: THROTTLE_COUNT, throttle: THROTTLE },
].map((leg) => ({ ...leg, begin: `__${leg.key}333_BEGIN__`, end: `__${leg.key}333_END__` }));

export default {
  name: "terminal-wake-on-paced-stream",
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
    const failures = [];
    const readings = {};
    try {
      await writeTerminalPrefs(page, token, { secret_masking: false });
      assert.ok(await trackGhosttyTerminals(page), "the entry module names a ghostty-web chunk");
      await page.evaluate(installStreamProbe);
      const command = ["stty -echo", ...LEGS.flatMap(({ begin, end, count }) => [
        "IFS= read -r _", `printf '${begin}\\n'`, `seq -f %.0f 1 ${count}`, `printf '${end}'`,
      ]), "exec sleep 600"].join("; ");
      await openAttachedTerminal(ctx, page, cs, windowId, NAME, ["--command", command]);
      const read = () => page.evaluate((name) => __streamProbe.read(name), NAME);
      await until("the terminal socket is ready", read, (state) => state?.ready);
      assert.equal(await page.evaluate(() => __streamProbe.wakeProbeCount()), 1,
        "the probe sees exactly the terminal's wake detector");
      for (const leg of LEGS) {
        const before = await page.evaluate((name) => __streamProbe.readAll(name), NAME);
        const socketsBefore = before.length;
        const sessionsBefore = before.reduce((sum, socket) => sum + socket.sessions.length, 0);
        const stallsBefore = before.at(-1).stalls.length;
        await page.emulateCPUThrottling(leg.throttle);
        await page.evaluate((name, { begin, end, count }) => {
          __streamProbe.verifySeq(name, begin, count, end);
          __streamProbe.input(name, "\r");
        }, NAME, leg);
        if (leg.throttle === null) {
          await until(`${leg.key}: the stream is under way`, read, (state) => state.verifier.lines > 0, 60_000);
          await page.evaluate((name, ms, lead) => __streamProbe.stallAtWakeProbe(name, ms, lead),
            NAME, LATE_STALL_MS, LATE_LEAD_MS);
        }
        const finished = await until(`${leg.key}: the stream reaches its end marker`, async () => {
          try { return await read(); } catch { return null; }
        }, (state) => state?.verifier?.done || state?.verifier?.mismatch || state?.allErrors.length > 0, 420_000);
        await page.emulateCPUThrottling(null);
        const sockets = await page.evaluate((name) => __streamProbe.readAll(name), NAME);
        const sessions = sockets.flatMap((socket) => socket.sessions).slice(sessionsBefore);
        const stall = leg.throttle === null ? sockets.flatMap((socket) => socket.stalls)[stallsBefore] : null;
        const observed = {
          lines: finished.verifier.lines, expected: leg.count, mismatch: finished.verifier.mismatch,
          newSockets: sockets.length - socketsBefore, newSessions: sessions.length,
          missed: sessions.map((session) => session.missed), errors: finished.allErrors,
          stall: stall ? { ms: stall.ended - stall.at, lead: stall.lead, ended: Boolean(stall.ended) } : null,
        };
        readings[leg.key] = observed;
        const problems = [];
        if (observed.newSockets !== 0) problems.push("the healthy socket was replaced");
        if (observed.missed.some((count) => count > 0)) problems.push("bytes were reported missed");
        if (observed.errors.length) problems.push("the terminal printed an error line");
        if (observed.mismatch) problems.push("a number arrived out of order");
        if (observed.lines !== leg.count) problems.push("the stream is not whole");
        if (leg.throttle === null && !(stall?.ended && stall.ended - stall.at >= LATE_STALL_MS)) {
          problems.push("the stall did not run inside the stream");
        }
        if (problems.length) failures.push(`${leg.key}: ${problems.join("; ")}: ${JSON.stringify(observed)}`);
      }
      const retained = await readGhosttyText(page);
      assert.ok(retained.text.includes(LEGS.at(-1).end), "the final stream end marker is in the retained buffer");
      assert.ok(!retained.text.includes("terminal output lagged"), "no lag line in the buffer");
      await ctx.shot("333-after-streams");
      if (failures.length) throw new Error(failures.join("\n"));
      return readings;
    } finally {
      await page.emulateCPUThrottling(null).catch(() => {});
      await cs(["close", "--tab-name", NAME]).catch(() => {});
      await restoreTerminalPrefs(ctx, page, token, original);
    }
  },
};
