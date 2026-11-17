// A ghostty terminal at a device scale factor of 2 whose canvas drawing
// state the host discards while hidden must repaint at full scale on the
// visible flip. Same shape as check 204, but the discard leaves an
// identity transform behind, so at ratio 1 the scale assertions below fail
// as a precondition instead of passing with nothing proven.
//
//   PAINT  -- open a ghostty terminal at deviceScaleFactor 2, print text
//             including a full-width line, arm a WINCH trap, and wait for
//             the server-side scrollback and for stable painted pixels in
//             every quarter of the backing store at scale 2.
//   HIDE   -- bring another page of the same context to the front so the
//             terminal's page turns hidden, then drop the canvas drawing
//             state by a same-size reset: the bitmap goes transparent while
//             the size is unchanged.
//   RESUME -- bring the page back (visibilitychange visible, the signal the
//             terminal's host-resume listener runs on) and wait for every
//             quarter to hold its baseline paint again within a band, at
//             scale 2, with the backing size unchanged and no WINCH observed
//             on the PTY.
//
// Each bounded wait below is a hang guard: it bounds a stuck engine, and
// its timeout reports which stage hung.

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
        `for i in $(seq -w 1 ${LINES}); do printf '${MARK}LINE_%s the quick brown fox jumps over the lazy dog, packing my box with five dozen liquor jugs\\n' "$i"; done; printf '${MARK}%s\\n' DONE\n; printf '%0180d\\n' 0`]);
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
      // The scale the defect cannot show without: at ratio 1 this check
      // would pass with nothing proven, so a paint off scale 2 fails the
      // check instead of running it.
      if (baseline.scaleX !== 2 || baseline.scaleY !== 2) {
        throw new Error(`precondition: the stable paint was not at scale 2: ${JSON.stringify(baseline)}`);
      }
      // Arm the PTY observation: any grid publication resizes the pty and
      // the shell reports it. The trap install goes out alone, then a
      // readback proves it landed intact: a truncated write (as one guest
      // run showed) reads back without the mark and fails here as an
      // instrument fault, not as a resize.
      // Settle: the trap write follows a scrollback poll within milliseconds,
      // and one guest run lost the head of that write to the prompt redraw.
      await sleep(1_000);
      await cs(["write", "--tab-name", TAB, `trap 'echo ${MARK}WINCH' WINCH\n`]);
      await cs(["write", "--tab-name", TAB, `trap -p WINCH\n`]);
      try {
        await waitScrollback(`${MARK}WINCH`, 30_000);
      } catch (error) {
        throw new Error(`instrument fault: the WINCH trap did not arm: ${error.message}`);
      }
      await cs(["write", "--tab-name", TAB, `echo ${MARK}TRAP_SET\n`]);
      await waitScrollback(`${MARK}TRAP_SET`, 30_000);
      // Count the mark now: the typed trap line and the readback above both
      // carry it, so the end state must hold exactly this many. A resize
      // across the resume adds one more.
      const countMarks = (text) => (text.match(new RegExp(`${MARK}WINCH`, "g")) || []).length;
      const armedMarks = countMarks((await cs(["scrollback", "--tab-name", TAB])).stdout);
      if (armedMarks === 0) {
        throw new Error("instrument fault: the trap arming lines left no mark to count");
      }

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
      // Quiesce: let any in-flight hidden paint land before the flip, so the
      // resume loop measures the flip's own repaint and nothing earlier.
      await sleep(1_500);

      // RESUME
      await page.bringToFront();
      await page.waitForFunction(() => document.visibilityState === "visible", { polling: 100, timeout: 10_000 });
      // A repaint that drops the glyphs still paints the background, and a
      // wrong-scale one moves the counts: each quarter must land back
      // inside a band around its own baseline, on both sides.
      const band = (b) => Math.max(200, Math.round(b * 0.02));
      const resumeDeadline = Date.now() + 10_000;
      let after = null;
      for (;;) {
        after = await measure();
        if (after && after.width === baseline.width && after.height === baseline.height
            && after.scaleX === 2 && after.scaleY === 2
            && after.quarters.every((q, i) => Math.abs(q - baseline.quarters[i]) <= band(baseline.quarters[i]))) break;
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
      const endScrollback = (await cs(["scrollback", "--tab-name", TAB])).stdout;
      if (!endScrollback.includes(`${MARK}TRAP_SET`)) {
        throw new Error("the WINCH trap never armed: no size published to the PTY can be ruled out");
      }
      if (countMarks(endScrollback) !== armedMarks) {
        throw new Error(`a resize reached the PTY across the resume: ${JSON.stringify(endScrollback.slice(-500))}`);
      }
      return readings;
    } finally {
      await front?.close().catch(() => {});
      await cs(["close", "--tab-name", TAB]).catch(() => {});
    }
  },
};
