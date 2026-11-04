// A ghostty terminal whose window sat off-screen can come back with its
// canvas pixels gone: the WHATWG canvas wiki's lost or discarded 2D backing
// store, same size, blank, the page not told. ghostty-web's frame loop then
// repaints only the rows its core marks dirty, so the screen stays blank
// until a grid change forces a full pass. chan's host-resume recovery runs
// on the visible flip and must repaint every row the way a resize does.
//
//   PAINT  -- open a ghostty terminal, run twenty marker lines down the PTY,
//             wait for the server-side scrollback and for the canvas to hold
//             a stable count of painted pixels: the baseline.
//   HIDE   -- bring another page of the same context to the front so the
//             terminal's page turns hidden (a real visibilitychange), and
//             while hidden drop the canvas backing store by a same-size
//             reset: zero painted pixels, the renderer's size check unchanged.
//   RESUME -- bring the page back (visibilitychange visible, the signal the
//             terminal's host-resume listener runs on) and wait for the
//             painted pixels to return to the baseline's band.
//
// Headless Chrome keeps a hidden page's canvas through hibernation and a
// simulated memory pressure, so the discard is applied by the check rather
// than waited for; the property proved is the page's half, the repaint.

import { openAttachedTerminal } from "../lib/terminal-attach.mjs";

const TAB = "SmokeOffscreen201";
const MARK = "OFF201_";
const LINES = 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  name: "terminal-ghostty-offscreen-repaint",
  async run(ctx) {
    const socket = ctx.controlSocket;
    if (!socket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
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
      `.terminal-tab.active[data-terminal-tab-id="${row.tab}"] .terminal-host canvas`;

    /// Pixels that differ from the canvas's most common color (its
    /// background), read straight from the 2D context.
    const measure = () =>
      page.evaluate((query) => {
        const c = document.querySelector(query);
        if (!c) return null;
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        const counts = new Map();
        for (let i = 0; i < d.length; i += 4 * 97) {
          const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const bg = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        const br = (bg >> 16) & 255, bgc = (bg >> 8) & 255, bb = bg & 255;
        let painted = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (Math.abs(d[i] - br) + Math.abs(d[i + 1] - bgc) + Math.abs(d[i + 2] - bb) > 60) painted += 1;
        }
        return { painted, width: c.width, height: c.height, visibility: document.visibilityState };
      }, canvas);

    // Opened at HIDE: a new page comes to the front as it opens, and the
    // terminal's page must be visible while it paints the baseline.
    let front = null;
    const readings = {};
    try {
      // PAINT
      await cs(["write", "--tab-name", TAB,
        `for i in $(seq -w 1 ${LINES}); do printf '${MARK}LINE_%s the quick brown fox jumps over the lazy dog\\n' "$i"; done; printf '${MARK}%s\\n' DONE\n`]);
      await waitScrollback(`${MARK}DONE`);
      let baseline = null;
      let previous = null;
      const deadline = Date.now() + 20_000;
      for (;;) {
        const now = await measure();
        if (now && now.painted > 2_000 && previous && previous.painted === now.painted) { baseline = now; break; }
        if (Date.now() > deadline) {
          await ctx.shot("ghostty-offscreen-no-baseline");
          throw new Error(`the canvas never held a stable painted count; last ${JSON.stringify(now)}`);
        }
        previous = now;
        await sleep(300);
      }
      readings.baseline = baseline;
      await page.evaluate(() => {
        window.__offscreen201 = [];
        document.addEventListener("visibilitychange", () => window.__offscreen201.push(document.visibilityState));
      });

      // HIDE. Interval polling: a hidden page runs no animation frames.
      front = await ctx.browser.newPage();
      await front.setContent("<p>front</p>");
      await front.bringToFront();
      await page.waitForFunction(() => document.visibilityState === "hidden", { polling: 100, timeout: 10_000 });
      await page.evaluate((query) => {
        const c = document.querySelector(query);
        c.width = c.width;
      }, canvas);
      readings.hidden = await measure();
      if (readings.hidden.painted !== 0) {
        throw new Error(`the discard left painted pixels: ${JSON.stringify(readings.hidden)}`);
      }
      await sleep(1_500);

      // RESUME
      await page.bringToFront();
      await page.waitForFunction(() => document.visibilityState === "visible", { polling: 100, timeout: 10_000 });
      const floor = Math.floor(baseline.painted / 2);
      const ceiling = Math.ceil(baseline.painted * 1.5);
      const resumeDeadline = Date.now() + 5_000;
      let after = null;
      for (;;) {
        after = await measure();
        if (after && after.painted >= floor && after.painted <= ceiling) break;
        if (Date.now() > resumeDeadline) {
          readings.after = after;
          readings.visibility = await page.evaluate(() => window.__offscreen201);
          await ctx.shot("ghostty-offscreen-not-repainted");
          throw new Error(
            `the terminal did not repaint after the visible flip: ` +
              `baseline ${baseline.painted}, after ${after?.painted} painted pixels; ` +
              `visibility ${JSON.stringify(readings.visibility)}`,
          );
        }
        await sleep(100);
      }
      readings.after = after;
      readings.visibility = await page.evaluate(() => window.__offscreen201);
      await ctx.shot("ghostty-offscreen-repainted");
      return readings;
    } finally {
      await front?.close().catch(() => {});
      await cs(["close", "--tab-name", TAB]).catch(() => {});
    }
  },
};
