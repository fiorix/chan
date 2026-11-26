// The app's find bar over a terminal at the largest scrollback, read in a
// real browser: what the bar shows and does through its input, its count
// and its keys, against the buffer as the widget's public API reads it.
//
// Every line is numbered ("<nnnnnn> ...") and about 1.3 times the
// terminal's width, so it takes two rows both at that width and at 0.7 of
// it, and a reflow between the two widths prunes nothing. It holds twelve
// "e" in two segments. "e" is a dense query; a match is identified by its
// line and its offset there. The fill prints the line's tail from a shell
// variable, so every command line is short.
//
//   BUDGET  -- the terminal was built with the setting, 50 MB, as its
//              history budget in bytes (`options.scrollbackBytes`) and no
//              line cap of its own (`options.scrollback` at the widget's
//              default of 10,000).
//   FILL    -- 60,000 lines, more than the history holds, so it is full.
//   SCAN    -- the find chord opens the bar and "e" is typed into it. Every
//              text the count shows is recorded until it settles, and none
//              may be a zero total while the scan runs ("? of 0+" or
//              "0 of 0+"). Settled, it reads "1 of N" with N the "e" in the
//              buffer's plain text, `search-all` holds N ranges, and the
//              active match on `search-active` is the buffer's last "e".
//   STEPS   -- STEP_PAIRS times, Enter and then Shift+Enter: Enter must show
//              "2 of N" with the active match on the "e" before the
//              buffer's last, Shift+Enter "1 of N" back on the last one.
//   RESIZE  -- from the match UP presses above the newest, the page narrows
//              to 0.7 of its width and widens back. Once the count settles
//              after each, the active match must be on the same line and
//              offset, on the row of its line that offset falls on at that
//              width, and the count must read as it did. The leg reads find
//              only when its instrument holds: the history's rows and the
//              buffer's "e" after each resize equal those before, and a
//              partial count was seen after it, so the settled one is the
//              rescan's.
//   ABSENT  -- the query is cleared and "zqj", which nothing in the buffer
//              holds, typed. While its scan runs the count reads
//              "searching", never a zero total, and settled "0 of 0". The
//              reading counts only when a partial count was seen.
//
// Recorded, not gating: the page's frame gaps from the keystroke that
// starts SCAN until its count settles, and each press's step-to-paint time,
// from its keydown to the start of the first animation frame after the
// count showed the press's index (the frame that paints it), with the time
// the bar took to show it. The widget's README sets a 12 ms scheduling
// target for its frame work and states it is not a hard frame-time
// guarantee at this history, so no frame number decides the verdict.
//
// Verdict: FAIL when a reading above fails or an instrument does not hold.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureGhosttyTerminals } from "../lib/ghostty-capture.mjs";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { readTerminalPrefs, restoreTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const TAB = "SmokeFindBar350";
const SEGMENT = "a e i o u e e e e e";
// "<nnnnnn> ", the fixed-width number every line opens with.
const PREFIX = 7;
const FILL = 60_000;
const SCROLLBACK_MB = 50;
const MIB = 1_048_576;
const WIDGET_DEFAULT_LINES = 10_000;
const STEP_PAIRS = 10;
const UP = 25;
const ABSENT = "zqj";
// A count that says the buffer holds no match while the scan still runs.
const ZERO_PARTIAL = /^(\?|\d+) of 0\+$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  name: "terminal-find-bar",
  async run(ctx) {
    const socket = ctx.controlSocket;
    if (!socket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
    await page.bringToFront();
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const windowId = await page.evaluate(
      () => new URL(location.href).searchParams.get("w")?.trim() || window.sessionStorage.getItem("chan.session.window")?.trim() || "",
    );
    if (!windowId) throw new Error("could not resolve the page's window id");
    const env = { ...process.env, CHAN_CONTROL_SOCKET: socket, CHAN_WINDOW_ID: windowId };
    const cs = (args) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], { cwd: ctx.workspaceDir, env, timeout: 120_000 });
    const original = await readTerminalPrefs(page, token);
    const pageViewport = page.viewport();
    if (!pageViewport) throw new Error("the page has no fixed viewport to narrow");
    const details = { correctness: {}, recorded: {} };
    const failures = [];
    try {
      const chunk = await captureGhosttyTerminals(page, "__ghostty350");
      if (!chunk) throw new Error("no entry module of the page names a ghostty-web chunk");
      await writeTerminalPrefs(page, token, { scrollback_mb: SCROLLBACK_MB });
      const row = await openAttachedTerminal(ctx, page, cs, windowId, TAB);
      const tabQuery = `.pane[data-pane-id="${row.pane}"] .terminal-tab.active[data-terminal-tab-id="${row.tab}"]`;
      const hostQuery = `${tabQuery} .terminal-host`;
      const inputQuery = `${tabQuery} .terminal-find input.find`;
      const countQuery = `${tabQuery} .terminal-find .find-count`;
      const term = await page.evaluateHandle((q) => window.__ghostty350.term(q), hostQuery);

      async function until(what, read, ms = 180_000) {
        const end = Date.now() + ms;
        for (;;) {
          const value = await read();
          if (value) return value;
          if (Date.now() > end) throw new Error(`timed out: ${what}`);
          await sleep(200);
        }
      }

      // Readers on the widget's public API, kept on the page for every leg.
      await term.evaluate((t) => {
        const wrapped = (row) => {
          const sb = t.getScrollbackLength();
          return row >= sb ? t.core.isRowWrapped(row - sb) : t.core.isScrollbackRowWrapped(row);
        };
        const rowText = (row) => t.core.plainText({ startRow: row, startCol: 0, endRow: row, endCol: t.cols - 1 }) ?? "";
        const isE = (c) => c === "e" || c === "E";
        const lastRow = () => t.getScrollbackLength() + t.rows - 1;
        window.__find350 = {
          // The "e" in the buffer's plain text, as find counts them.
          count() {
            const text = t.core.plainText() ?? "";
            let n = 0;
            for (const c of text) if (isE(c)) n++;
            return n;
          },
          // The last "e" before a cell; with no cell, the buffer's last "e".
          lastBefore(row = lastRow(), col = t.cols) {
            for (let r = row, c = col - 1; r >= 0; r--, c = Infinity) {
              const text = rowText(r);
              for (let i = Math.min(c, text.length - 1); i >= 0; i--) if (isE(text[i])) return { absoluteRow: r, col: i };
            }
            return null;
          },
          // A range as its line's number and the offset in the line.
          identity(r) {
            if (!r) return null;
            let first = r.start.absoluteRow;
            while (first > 0 && wrapped(first)) first--;
            const line = t.core.plainText({ startRow: first, startCol: 0, endRow: first, endCol: t.cols - 1 }) ?? "";
            const text = t.core.plainText({ startRow: r.start.absoluteRow, startCol: r.start.col, endRow: r.end.absoluteRow, endCol: r.end.col });
            return { line: line.split(" ")[0], offset: (r.start.absoluteRow - first) * t.cols + r.start.col, rowInLine: r.start.absoluteRow - first, text };
          },
          read() {
            return {
              state: t.search.state,
              active: t.highlights.get("search-active")?.ranges?.[0] ?? null,
              all: t.highlights.get("search-all")?.ranges?.length ?? 0,
              history: t.getScrollbackLength(),
              cols: t.cols,
            };
          },
        };
      });
      const read = () => term.evaluate((t) => window.__find350.read());
      const count = () => page.evaluate((q) => document.querySelector(q)?.textContent ?? null, countQuery);
      const settled = (text) => text !== null && text !== "" && text !== "searching" && !text.endsWith("+") && !text.startsWith("?");
      const sameCell = (range, cell) => range !== null && cell !== null &&
        range.start.absoluteRow === cell.absoluteRow && range.start.col === cell.col &&
        range.end.absoluteRow === cell.absoluteRow && range.end.col === cell.col;
      const at = (value) => JSON.stringify(value);

      // BUDGET
      details.correctness.budget = await term.evaluate((t) => ({ bytes: t.options.scrollbackBytes ?? null, lines: t.options.scrollback ?? null }));
      if (details.correctness.budget.bytes !== SCROLLBACK_MB * MIB) {
        failures.push(`budget: the terminal was built with scrollbackBytes ${details.correctness.budget.bytes}, not ${SCROLLBACK_MB * MIB}`);
      }
      if (details.correctness.budget.lines !== WIDGET_DEFAULT_LINES) {
        failures.push(`budget: the terminal was built with a line cap of ${details.correctness.budget.lines}, not the widget's default ${WIDGET_DEFAULT_LINES}`);
      }

      // FILL
      const cols = await term.evaluate((t) => t.cols);
      const second = Math.round(0.8 * cols);
      const gap = second - PREFIX - SEGMENT.length - 2;
      const end = Math.round(1.3 * cols) - second - SEGMENT.length - 1;
      if (gap < 1 || end < 1) throw new Error(`a ${cols}-column terminal is too narrow for the line shape`);
      const tail = `${SEGMENT} ${"x".repeat(gap)} ${SEGMENT} ${"x".repeat(end)}`;
      details.lines = { cols, length: PREFIX + tail.length };
      // The command line spells the mark with an empty quote inside, so only
      // the output's own line holds it whole.
      await cs(["write", "--tab-name", TAB, `PS1='$ '; T='${tail}'; clear\n`]);
      await cs(["write", "--tab-name", TAB,
        `awk -v t="$T" 'BEGIN{for(i=1;i<=${FILL};i++) printf "%06d %s\\n", i, t}'; echo DONE350''x\n`]);
      await until("the fill", () => term.evaluate((t) => {
        const sb = t.getScrollbackLength();
        return (t.core.plainText({ startRow: sb, startCol: 0, endRow: sb + t.rows - 1, endCol: t.cols - 1 }) ?? "").includes("DONE350x");
      }));
      await sleep(500);
      details.fill = await read();

      // The page's frames, the bar's count changes and the find input's
      // Enter keydowns, each on the page clock.
      await page.evaluate(() => {
        const probe = window.__probe350 = { frames: [], counts: [], presses: [], on: true };
        const loop = (t) => { if (!probe.on) return; probe.frames.push(t); requestAnimationFrame(loop); };
        requestAnimationFrame(loop);
      });
      const pressFindChord = async () => {
        await page.evaluate((q) => document.querySelector(`${q} textarea`)?.focus(), hostQuery);
        const mac = await page.evaluate(() => /Mac/.test(navigator.userAgent));
        const modifiers = mac ? ["Meta"] : ["Control", "Shift"];
        for (const key of modifiers) await page.keyboard.down(key);
        await page.keyboard.press("KeyF");
        for (const key of modifiers.reverse()) await page.keyboard.up(key);
      };
      await pressFindChord();
      await page.waitForFunction((q) => document.activeElement === document.querySelector(q), { timeout: 10_000 }, inputQuery)
        .catch(async (error) => {
          await ctx.shot("350-not-open").catch(() => {});
          throw new Error(`the find chord did not open a focused find bar: ${error.message}`);
        });
      await page.evaluate(([inputQuery, countQuery]) => {
        const probe = window.__probe350;
        const counted = document.querySelector(countQuery);
        probe.observer = new MutationObserver(() => probe.counts.push({ t: performance.now(), text: counted.textContent }));
        probe.observer.observe(counted, { characterData: true, childList: true, subtree: true });
        document.querySelector(inputQuery).addEventListener("keydown", (e) => {
          if (e.key === "Enter") probe.presses.push({ t: performance.now(), shift: e.shiftKey });
          else if (e.key.length === 1) probe.typed = performance.now();
        }, true);
      }, [inputQuery, countQuery]);
      const probe = () => page.evaluate(() => {
        const p = window.__probe350;
        return { frames: p.frames, counts: p.counts, presses: p.presses, typed: p.typed ?? null };
      });
      const q = (xs, p) => {
        const s = [...xs].sort((x, y) => x - y);
        return s.length ? Math.round(s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] * 100) / 100 : null;
      };
      const spread = (xs) => ({ n: xs.length, median: q(xs, 0.5), p95: q(xs, 0.95), max: q(xs, 1) });

      // SCAN
      await page.keyboard.type("e");
      const scanText = await until("the count settles on e", async () => {
        const text = await count();
        return settled(text) ? text : null;
      });
      const afterScan = await probe();
      const scan = await read();
      const buffer = await term.evaluate(() => window.__find350.count());
      const newest = await term.evaluate(() => window.__find350.lastBefore());
      const shown = afterScan.counts.map((c) => c.text);
      details.correctness.scan = { shown: shown.length, firstShown: shown.slice(0, 5), text: scanText, state: scan.state, all: scan.all, buffer, newest, active: scan.active };
      const zeroes = shown.filter((text) => ZERO_PARTIAL.test(text));
      if (zeroes.length) failures.push(`scan: the count showed a zero total while the scan ran: ${at([...new Set(zeroes)])}`);
      if (scanText !== `1 of ${buffer}`) failures.push(`scan: the settled count reads ${at(scanText)}, not "1 of ${buffer}"`);
      if (scan.all !== buffer) failures.push(`scan: search-all holds ${scan.all} ranges, not the buffer's ${buffer} "e"`);
      if (!sameCell(scan.active, newest)) failures.push(`scan: the active match is ${at(scan.active)}, not the buffer's last "e" at ${at(newest)}`);
      const scanFrames = afterScan.frames.filter((t) => afterScan.typed !== null && t >= afterScan.typed && t <= (afterScan.counts.at(-1)?.t ?? t));
      details.recorded.scan = {
        ms: afterScan.typed !== null && afterScan.counts.length ? Math.round(afterScan.counts.at(-1).t - afterScan.typed) : null,
        frames: scanFrames.length,
        gap: spread(scanFrames.slice(1).map((t, i) => t - scanFrames[i])),
      };
      await ctx.shot("350-scan").catch(() => {});

      // STEPS
      const total = buffer;
      const older = newest && await term.evaluate((t, c) => window.__find350.lastBefore(c.absoluteRow, c.col), newest);
      const presses = [];
      async function press(shift, expectText, expectCell) {
        const before = (await probe()).presses.length;
        if (shift) await page.keyboard.down("Shift");
        await page.keyboard.press("Enter");
        if (shift) await page.keyboard.up("Shift");
        const text = await until(`the count reads ${expectText}`, async () => ((await count()) === expectText ? expectText : null), 10_000)
          .catch(() => null);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        const p = await probe();
        const pressed = p.presses[before];
        const shownAt = pressed ? p.counts.find((c) => c.t >= pressed.t && c.text === expectText) : undefined;
        const painted = shownAt ? p.frames.find((t) => t >= shownAt.t) : undefined;
        const s = await read();
        const reading = {
          direction: shift ? "newer" : "older",
          text: await count(),
          landed: text === expectText && sameCell(s.active, expectCell),
          shownMs: pressed && shownAt ? Math.round((shownAt.t - pressed.t) * 100) / 100 : null,
          paintMs: pressed && painted !== undefined ? Math.round((painted - pressed.t) * 100) / 100 : null,
        };
        presses.push(reading);
        if (!reading.landed) failures.push(`steps: ${reading.direction} read ${at(reading.text)} on ${at(s.active)}, not ${at(expectText)} on ${at(expectCell)}`);
        return reading;
      }
      for (let i = 0; i < STEP_PAIRS; i++) {
        await press(false, `2 of ${total}`, older);
        await press(true, `1 of ${total}`, newest);
      }
      const paint = (direction) => presses.filter((p) => p.direction === direction && p.paintMs !== null);
      details.recorded.steps = Object.fromEntries(["older", "newer"].map((d) => [d, {
        paint: spread(paint(d).map((p) => p.paintMs)),
        shown: spread(paint(d).map((p) => p.shownMs)),
      }]));
      if (presses.some((p) => p.paintMs === null)) failures.push(`steps: the instrument saw no paint for ${presses.filter((p) => p.paintMs === null).length} presses`);

      // RESIZE
      for (let i = 0; i < UP; i++) await page.keyboard.press("Enter");
      const startText = await until(`the count reads ${UP + 1} of ${total}`, async () => ((await count()) === `${UP + 1} of ${total}` ? (await count()) : null), 10_000);
      const start = await read();
      const startIdentity = await term.evaluate((t, r) => window.__find350.identity(r), start.active);
      details.resize = { start: { text: startText, identity: startIdentity, history: start.history }, steps: [] };
      const instrument = [];
      for (const width of [Math.round(pageViewport.width * 0.7), pageViewport.width]) {
        const mark = (await probe()).counts.length;
        await page.setViewport({ ...pageViewport, width });
        await until(`the terminal refits at ${width}px`, async () => (await read()).cols !== (details.resize.steps.at(-1)?.cols ?? start.cols));
        const text = await until(`the count settles after the resize to ${width}px`, async () => {
          const t = await count();
          return settled(t) ? t : null;
        });
        const s = await read();
        const identity = await term.evaluate((t, r) => window.__find350.identity(r), s.active);
        const bufferNow = await term.evaluate(() => window.__find350.count());
        const expectedRow = Math.floor(startIdentity.offset / s.cols);
        const rescan = (await probe()).counts.slice(mark).map((c) => c.text);
        details.resize.steps.push({ width, cols: s.cols, text, identity, history: s.history, buffer: bufferNow, expectedRow, rescan: rescan.slice(0, 5) });
        if (!rescan.some((t) => !settled(t))) instrument.push(`at ${width}px no partial count was seen, so the settled count is not the rescan's`);
        if (s.history !== start.history || bufferNow !== buffer) instrument.push(`at ${width}px the history holds ${s.history} rows and ${bufferNow} "e", not ${start.history} and ${buffer}`);
        if (text !== startText) failures.push(`resize to ${width}px: the count reads ${at(text)}, not ${at(startText)}`);
        if (!identity || identity.line !== startIdentity.line || identity.offset !== startIdentity.offset || identity.rowInLine !== expectedRow || !/^e$/i.test(identity.text ?? "")) {
          failures.push(`resize to ${width}px: the active match is ${at(identity)}, not line ${startIdentity.line} offset ${startIdentity.offset} on its row ${expectedRow}`);
        }
        await ctx.shot(`350-resize-${width}`).catch(() => {});
      }
      for (const message of instrument) failures.push(`resize instrument: ${message}`);

      // ABSENT
      const before = (await probe()).counts.length;
      await page.evaluate((q) => {
        const input = document.querySelector(q);
        input?.focus();
        input?.select();
      }, inputQuery);
      await page.keyboard.press("Backspace");
      await until("the count goes blank on an empty query", async () => (await count()) === "", 10_000);
      await page.keyboard.type(ABSENT);
      const absentText = await until("the count settles on the absent query", async () => {
        const text = await count();
        return text === "0 of 0" ? text : null;
      });
      const absentShown = (await probe()).counts.slice(before).map((c) => c.text).filter((text) => text !== "");
      details.correctness.absent = { shown: absentShown, text: absentText };
      if (!absentShown.some((text) => text === "searching" || text.endsWith("+"))) {
        failures.push(`absent instrument: no partial count was seen before ${at(absentText)} (${at(absentShown)})`);
      } else {
        const zero = absentShown.filter((text) => ZERO_PARTIAL.test(text));
        if (zero.length) failures.push(`absent: the count showed a zero total while the scan ran: ${at([...new Set(zero)])}`);
        if (!absentShown.includes("searching")) failures.push(`absent: the count never read "searching" while the scan ran: ${at(absentShown)}`);
      }

      details.verdict = failures.length ? "FAIL" : "PASS";
      details.failures = failures;
      details.presses = presses;
      writeFileSync(join(ctx.outDir, "350-terminal-find-bar.json"), JSON.stringify(details, null, 2) + "\n");
      console.log(`350 recorded (not gating): ${JSON.stringify(details.recorded)}`);
      console.log(`350 verdict: ${details.verdict} budget=${details.correctness.budget.bytes}/${details.correctness.budget.lines} count=${scanText}/${buffer} all=${scan.all} newest=${sameCell(scan.active, newest) ? "bottom-most" : "wrong"} steps=${presses.filter((p) => p.landed).length}/${presses.length} resize=${instrument.length ? "instrument" : details.resize.steps.map((s) => s.text === startText && s.identity?.offset === startIdentity.offset ? "kept" : "lost").join(",")} absent=${at(absentShown)}`);
      if (failures.length) throw Object.assign(new Error(`350 verdict: FAIL: ${failures.join("; ")}`), { smokeDetails: details });
      return { verdict: details.verdict, recorded: details.recorded };
    } finally {
      await page.setViewport(pageViewport).catch(() => {});
      await cs(["close", "--tab-name", TAB]).catch(() => {});
      await page.evaluate(() => {
        const probe = window.__probe350;
        if (probe) { probe.on = false; probe.observer?.disconnect(); }
        delete window.__probe350;
        delete window.__find350;
        window.__ghostty350?.restore();
      }).catch(() => {});
      await restoreTerminalPrefs(ctx, page, token, original).catch(() => {});
    }
  },
};
