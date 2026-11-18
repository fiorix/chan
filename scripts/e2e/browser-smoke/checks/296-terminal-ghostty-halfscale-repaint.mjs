// A ghostty terminal at a device scale factor of 2 whose canvas drawing
// state the host discards while hidden must repaint at full scale on the
// visible flip, glyphs included. Same shape as check 204, but the discard
// leaves an identity transform behind, so at ratio 1 the scale assertions
// below fail as a precondition instead of passing with nothing proven.
//
//   PAINT  -- open a ghostty terminal at deviceScaleFactor 2, print prose
//             plus a full-width line, and wait for the server-side
//             scrollback and for stable painted pixels in every quarter of
//             the backing store at scale 2. The socket already saw the
//             open's own resize frame, which proves the frame counter below
//             observes publications.
//   HIDE   -- bring another page of the same context to the front so the
//             terminal's page turns hidden, then drop the canvas drawing
//             state by a same-size reset: the bitmap goes transparent while
//             the size is unchanged. A second read right before the flip
//             proves the store still blank.
//   RESUME -- bring the page back (visibilitychange visible, the signal the
//             terminal's host-resume listener runs on) and wait for every
//             quarter to hold its baseline ink again within a band, at
//             scale 2, with the backing size unchanged and no resize frame
//             sent on the terminal's socket in between.
//
// Ink is samples differing from the quarter's background colour, which is
// the baseline's own most frequent sample; opaque coverage must equal the
// sample total. Each bounded wait below is a hang guard: it bounds a stuck
// engine, and its timeout reports which stage hung.

import { openAttachedTerminal, TERMINAL_SURFACES } from "../lib/terminal-attach.mjs";

const TAB = "SmokeHalfscale296";
const MARK = "HS296_";
const LINES = 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  name: "terminal-ghostty-halfscale-repaint",
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

    // Resize frames the terminal publishes to the server, read off the
    // socket itself: a same-size publication never reaches a WINCH trap.
    const cdp = await page.createCDPSession();
    await cdp.send("Network.enable");
    const sentResizes = [];
    cdp.on("Network.webSocketFrameSent", ({ response }) => {
      let frame = null;
      try { frame = JSON.parse(response.payloadData); } catch { return; }
      if (frame?.type === "resize") sentResizes.push({ cols: frame.cols, rows: frame.rows, at: Date.now() });
    });

    const row = await openAttachedTerminal(ctx, page, cs, windowId, TAB, "ghostty");
    const canvas =
      `.pane[data-pane-id="${row.pane}"] ` +
      `.terminal-tab.active[data-terminal-tab-id="${row.tab}"] ${TERMINAL_SURFACES.ghostty}`;

    /// Painted pixels per quarter of the backing store, plus the canvas
    /// transform and grid. Ink is samples differing from the baseline's
    /// own most frequent colour; a repaint that fills backgrounds and
    /// drops every glyph reads full coverage with no ink.
    const measure = () =>
      page.evaluate((query) => {
        const c = document.querySelector(query);
        if (!c) return null;
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        const w = c.width >> 1;
        const h = c.height >> 1;
        const at = (x, y) => (y * c.width + x) * 4;
        const quarterOf = (x, y) => (y < h ? 0 : 2) + (x < w ? 0 : 1);
        const total = [0, 0, 0, 0];
        const seen = new Map();
        for (let y = 0; y < c.height; y += 2) {
          for (let x = 0; x < c.width; x += 4) {
            const q = quarterOf(x, y);
            total[q]++;
            const o = at(x, y);
            if (d[o + 3] === 0) continue;
            const key = (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
            seen.set(key, (seen.get(key) || 0) + 1);
          }
        }
        let bg = 0;
        let bgCount = -1;
        for (const [key, n] of seen) {
          if (n > bgCount) {
            bg = key;
            bgCount = n;
          }
        }
        const br = (bg >> 16) & 255;
        const bgg = (bg >> 8) & 255;
        const bb = bg & 255;
        const opaque = [0, 0, 0, 0];
        const ink = [0, 0, 0, 0];
        for (let y = 0; y < c.height; y += 2) {
          for (let x = 0; x < c.width; x += 4) {
            const q = quarterOf(x, y);
            const o = at(x, y);
            if (d[o + 3] === 0) continue;
            opaque[q]++;
            if (Math.abs(d[o] - br) + Math.abs(d[o + 1] - bgg) + Math.abs(d[o + 2] - bb) > 36) ink[q]++;
          }
        }
        const t = c.getContext("2d").getTransform();
        return {
          total, opaque, ink, bg: [br, bgg, bb],
          quarters: opaque, width: c.width, height: c.height,
          scaleX: t.a, scaleY: t.d,
          visibility: document.visibilityState,
        };
      }, canvas);

    let front = null;
    const readings = {};
    try {
      // PAINT
      await cs(["write", "--tab-name", TAB,
        `for i in $(seq -w 1 ${LINES}); do printf '${MARK}LINE_%s the quick brown fox jumps over the lazy dog, packing my box with five dozen liquor jugs\\n' "$i"; done; cols=$(tput cols 2>/dev/null || echo 200); printf "%0\${cols}d\\n" 0; printf '${MARK}%s\\n' DONE
`]);
      await waitScrollback(`${MARK}DONE`);
      if ((await cs(["scrollback", "--tab-name", TAB])).stdout.includes("syntax error")) {
        throw new Error("the paint write did not submit cleanly");
      }
      // A cursor-only repaint leaves dozens of ink samples; the prose
      // plus the full-width line leaves thousands in every quarter.
      const INK_FLOOR = 300;
      const quiet = (a, b) =>
        a && b && a.opaque.every((q, i) => q === b.opaque[i]) &&
        a.ink.every((q, i) => Math.abs(q - b.ink[i]) <= Math.max(50, b.ink[i] * 0.05));
      let baseline = null;
      let previous = null;
      const deadline = Date.now() + 30_000;
      for (;;) {
        const now = await measure();
        if (now && now.opaque.every((q, i) => q === now.total[i]) && now.ink.every((q) => q >= INK_FLOOR) && quiet(previous, now)) {
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
      // The scale the defect cannot show without: at ratio 1 this check
      // would pass with nothing proven, so a paint off scale 2 fails the
      // check instead of running it.
      if (baseline.scaleX !== 2 || baseline.scaleY !== 2) {
        throw new Error(`precondition: the stable paint was not at scale 2: ${JSON.stringify(baseline)}`);
      }
      // Positive control: the open published its grid, so the counter
      // below observes publications; a blind counter would prove nothing.
      if (sentResizes.length === 0) {
        throw new Error("instrument fault: the frame counter never saw the open's resize");
      }
      const hideMark = sentResizes.length;

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
      if (readings.hidden.quarters.some((q) => q !== 0)) {
        throw new Error(`the discard left paint behind: ${JSON.stringify(readings.hidden)}`);
      }
      if (readings.hidden.scaleX !== 1 || readings.hidden.scaleY !== 1) {
        throw new Error(`the discard did not reset the transform: ${JSON.stringify(readings.hidden)}`);
      }
      await sleep(1_500);
      // The store still blank right before the flip: a paint landing
      // during the quiesce would count as the flip's.
      readings.hidden2 = await measure();
      if (readings.hidden2.quarters.some((q) => q !== 0)) {
        throw new Error(`instrument fault: paint landed while hidden: ${JSON.stringify(readings.hidden2)}`);
      }

      // RESUME
      await page.bringToFront();
      await page.waitForFunction(() => document.visibilityState === "visible", { polling: 100, timeout: 10_000 });
      // A repaint that drops the glyphs still paints the background, and a
      // wrong-scale one moves the counts: each quarter must land back
      // inside a band around its own baseline, on both sides.
      const band = (b) => Math.max(200, Math.round(b * 0.1));
      const resumeStart = Date.now();
      const resumeDeadline = Date.now() + 10_000;
      let after = null;
      for (;;) {
        after = await measure();
        if (after && after.width === baseline.width && after.height === baseline.height
            && after.scaleX === 2 && after.scaleY === 2
            && after.opaque.every((q, i) => q === after.total[i])
            && after.ink.every((q, i) => Math.abs(q - baseline.ink[i]) <= band(baseline.ink[i]))) break;
        if (Date.now() > resumeDeadline) {
          readings.after = after;
          readings.resumeMs = Date.now() - resumeStart;
          await ctx.shot("ghostty-halfscale-not-repainted");
          throw new Error(
            `the terminal did not repaint at full scale after the visible flip: ` +
            `baseline ink ${JSON.stringify(baseline.ink)}, after ${JSON.stringify(after?.ink)} ${baseline.width}x${baseline.height} vs ${after?.width}x${after?.height}` +
            ` at scale ${after?.scaleX}x${after?.scaleY} after ${readings.resumeMs} ms`,
          );
        }
        await sleep(100);
      }
      readings.after = after;
      readings.resumeMs = Date.now() - resumeStart;
      await ctx.shot("ghostty-halfscale-repainted");
      if ((await cs(["scrollback", "--tab-name", TAB])).stdout.includes("syntax error")) {
        throw new Error("the terminal text holds a syntax error");
      }
      if (sentResizes.length !== hideMark) {
        throw new Error(`a resize reached the socket across the flip: ${JSON.stringify(sentResizes.slice(hideMark))}`);
      }
      return readings;
    } finally {
      await front?.close().catch(() => {});
      await cs(["close", "--tab-name", TAB]).catch(() => {});
    }
  },
};
