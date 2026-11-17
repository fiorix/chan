// A ghostty terminal at a device scale factor of 2 whose canvas drawing
// state the host resets while hidden must repaint at full scale on the
// visible flip: the owner's half-scale terminals after a sleep. Same shape
// as check 204, but the reset leaves an identity transform behind, so at
// ratio 1 the defect cannot show and at ratio 2 the top-left quarter keeps
// every painted pixel.
//
//   PAINT  -- open a ghostty terminal at deviceScaleFactor 2, print pages
//             of text, wait for the server-side scrollback and for the
//             painted pixels in every quarter of the backing store.
//   HIDE   -- bring another page of the same context to the front so the
//             terminal's page turns hidden, then drop the canvas drawing
//             state by a same-size reset: the transform reads identity
//             while the size is unchanged.
//   RESUME -- bring the page back (visibilitychange visible, the signal the
//             terminal's host-resume listener runs on) and wait for every
//             quarter to hold painted pixels again, with the grid unchanged
//             and no resize sent to the PTY.
//
// Red at the base: after the flip the painted pixels sit in the top-left
// quarter only. Green: all four quarters hold paint as before the reset.

import { openAttachedTerminal, TERMINAL_SURFACES } from "../lib/terminal-attach.mjs";

const TAB = "SmokeHalfscale293";
const MARK = "HS293_";
const LINES = 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  name: "terminal-ghosty-halfscale-repaint",
  async run(ctx) {
    const socket = ctx.controlSocket;
    if (!socket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
    await page.bringToFront();
    const windowId = await page.evaluate(
      () =>
        new URL(location.href).searchParams.get("w")?.trim() ||
        window.sessionStorage.getItem("chan.session.window")?.trim() ||
        "",
    );
    if (!windowId) throw new Error("could not resolve the page's window id");
    const env = { ...process.env, CHAN_CONTROL_SOCKET: socket, CHAN_WINDOW_ID: windowId };
    const cs = (args, opts = {}) =>
      ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
        cwd: ctx.workspaceDir,
        env,
        timeout: 90_000,
        ...opts,
      });

    async function waitScrollback(needle, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      let last = "";
      for (;;) {
        try {
          last = (await cs(["scrollback", "--tab-name", TAB])).stdout;
          if (last.includes(needle)) return;
        } catch {
          // The session may still be registering; keep polling.
        }
        if (Date.now() > deadline) {
          throw new Error(`scrollback of ${TAB} never showed ${JSON.stringify(needle)}; last scrollback:\n${last.slice(-2000)}`);
        }
        await sleep(300);
      }
    }

    const row = await openAttachedTerminal(ctx, page, cs, windowId, TAB, "ghostty");
    const canvas =
      `.pane[data-pane-id="${row.pane}"] ` +
      `.terminal-tab.active[data-terminal-tab-id="${row.tab}"] ${TERMINAL_SURFACES.ghostty}`;

    /// Painted pixels per quarter of the backing store, plus the canvas
    /// transform and grid. A half-scale paint leaves three quarters empty.
    const measure = () =>
      page.evaluate((query) => {
        const c = document.querySelector(query);
        if (!c) return null;
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        const w = c.width >> 1;
        const h = c.height >> 1;
        const quarters = [0, 0, 0, 0];
        for (let y = 0; y < c.height; y += 2) {
          for (let x = 0; x < c.width; x += 4) {
            const at = (y * c.width + x) * 4;
            if (d[at] + d[at + 1] + d[at + 2] > 30) quarters[(y < h ? 0 : 2) + (x < w ? 0 : 1)] += 1;
          }
        }
        const t = c.getContext("2d").getTransform();
        return {
          quarters, width: c.width, height: c.height, scaleX: t.a, scaleY: t.d,
          visibility: document.visibilityState,
        };
      }, canvas);

    let front = null;
    const readings = {};
    try {
      // PAINT
      await cs(["write", "--tab-name", TAB,
        `for i in $(seq -w 1 ${LINES}); do printf '${MARK}LINE_%s the quick brown fox jumps over the lazy dog, packing my box with five dozen liquor jugs\\n' "$i"; done; printf '${MARK}%s\\n' DONE\n`]);
      await waitScrollback(`${MARK}DONE`);
      let baseline = null;
      let previous = null;
      const deadline = Date.now() + 30_000;
      for (;;) {
        const now = await measure();
        if (now && now.quarters.every((q) => q > 2_000) && previous && previous.quarters.every((q, i) => Math.abs(q - now.quarters[i]) < now.quarters[i] / 4)) {
          baseline = now;
          break;
        }
        if (Date.now() > deadline) {
          await ctx.shot("ghostty-halfscale-no-baseline");
          throw new Error(`the canvas never held a stable full-scale paint; last ${JSON.stringify(now)}`);
        }
        previous = now;
        await sleep(300);
      }
      readings.baseline = baseline;

      // HIDE
      front = await ctx.browser.newPage();
      await front.setContent("<p>front</p>");
      await front.bringToFront();
      await page.waitForFunction(() => document.visibilityState === "hidden", { polling: 100, timeout: 10_000 });
      await page.evaluate((query) => {
        const c = document.querySelector(query);
        c.width = c.width;
      }, canvas);
      readings.hidden = await measure();
      if (readings.hidden.quarters.slice(1).some((q) => q !== 0)) {
        throw new Error(`the discard left paint outside the top-left quarter: ${JSON.stringify(readings.hidden)}`);
      }
      if (readings.hidden.scaleX !== 1 || readings.hidden.scaleY !== 1) {
        throw new Error(`the discard did not reset the transform: ${JSON.stringify(readings.hidden)}`);
      }
      await sleep(1_500);

      // RESUME
      await page.bringToFront();
      await page.waitForFunction(() => document.visibilityState === "visible", { polling: 100, timeout: 10_000 });
      const floor = baseline.quarters.map((q) => Math.floor(q / 2));
      const resumeDeadline = Date.now() + 10_000;
      let after = null;
      for (;;) {
        after = await measure();
        if (after && after.width === baseline.width && after.height === baseline.height && after.quarters.every((q, i) => q >= floor[i])) break;
        if (Date.now() > resumeDeadline) {
          readings.after = after;
          await ctx.shot("ghostty-halfscale-not-repainted");
          throw new Error(
            `the terminal did not repaint at full scale after the visible flip: ` +
            `baseline ${JSON.stringify(baseline.quarters)}, after ${JSON.stringify(after?.quarters)} ${baseline.width}x${baseline.height} vs ${after?.width}x${after?.height}`,
          );
        }
        await sleep(100);
      }
      readings.after = after;
      await ctx.shot("ghostty-halfscale-repainted");
      return readings;
    } finally {
      await front?.close().catch(() => {});
      await cs(["close", "--tab-name", TAB]).catch(() => {});
    }
  },
};
