// Find in a ghostty terminal, end to end over libghostty-vt's search.
//
//   OUTPUT -- a ghostty terminal runs `seq 1 5000` under a bare prompt, with
//             the screen and its history cleared first, so the buffer holds
//             the numbers, a marker line and the prompt.
//   OPEN   -- the find chord on ghostty's textarea (Cmd+F on macOS,
//             Ctrl+Shift+F elsewhere, as trusted CDP keys) opens the find
//             bar with its input focused.
//   4999   -- typing 4999 selects its one match and the count reads 1 of 1.
//   99     -- typing 99 instead selects the newest of its matches, the
//             right-hand one on the 4999 row, and the count reads 1 of N,
//             N counted from 1..5000.
//   OLDER  -- Enter steps to older matches, through 4999's other one and
//             4998 to 4990 on the screen with the viewport still, then to
//             4899 above it: the viewport moves and centres that row.
//   RESIZE -- the page narrows, then widens back, and the terminal reflows
//             to each width. libghostty-vt forgets its selected match on a
//             resize and scans again; find keeps the match itself, so each
//             time the same match is selected again once the scan finds it:
//             the count reads the same k of N, the selection is that match,
//             its text the needle, and it is on the screen. Enter then goes
//             on from it to the next older match, k+1 of N.
//   ESCAPE -- Escape closes the bar and clears the selection.
//   OLDEST -- the chord opens the bar again with the query it kept, and
//             Shift+Enter, the first step of a fresh search, lands on the
//             oldest match, the 99 on line 99, once the scan completes:
//             not on the oldest of the matches found when the key went
//             down, which the core would wrap to. The count reads N of N
//             and the match is on the screen. Escape closes the bar.
//   REOPEN -- the chord opens the bar again, then Escape and the find
//             command run in one task: the bar reopens before any zero-delay
//             refocus ghostty-web could have scheduled, and keeps the
//             keyboard past it. A trusted Escape closes the bar, the
//             keyboard goes back to the terminal, and a command typed next
//             runs in the shell.
//
// The selection and the viewport are read from ghostty-web's own Terminal
// in the page: its SelectionManager's anchors (absolute rows, 0 the oldest
// history row), its viewport offset (lines scrolled back from the bottom)
// and the binding's text of the selected row. Before the terminal opens,
// the check imports the lazily loaded ghostty-web chunk itself, by the name
// the app's entry module gives it, and wraps its Terminal's open() to keep
// each terminal opened; the module map hands the app the same module, so
// the check then holds the Terminal whose element is this tab's terminal
// host. A heap walk for the instance (Runtime.queryObjects) outruns the
// protocol timeout on this page.

import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { readTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const TAB = "SmokeGhosttyFind211";
const MARK = "FIND211_";
const LAST = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// The matches of `needle` in `seq 1 LAST`, newest first, each with its line
/// and its first and last column. The core reports every position a needle
/// starts at, overlapping ones included (4999 holds 99 twice), and orders a
/// row's matches right to left.
function matchesOf(needle) {
  const found = [];
  for (let n = LAST; n >= 1; n--) {
    const line = String(n);
    for (let col = line.length - needle.length; col >= 0; col--) {
      if (line.startsWith(needle, col)) found.push({ line, col, end: col + needle.length - 1 });
    }
  }
  return found;
}

export default {
  name: "terminal-ghostty-find",
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

    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const original = await readTerminalPrefs(page, token);
    const flipped = original.ghostty !== true;
    const pageViewport = page.viewport();
    let resized = false;
    const readings = {};
    try {
      if (flipped) await writeTerminalPrefs(page, token, { ghostty: true });
      const chunk = await page.evaluate(async () => {
        for (const script of document.querySelectorAll('script[type="module"][src]')) {
          const name = /ghostty-web-[\w-]+\.js/.exec(await (await fetch(script.src)).text())?.[0];
          if (!name) continue;
          const url = new URL(name, script.src).href;
          const { Terminal } = await import(url);
          const open = Terminal.prototype.open;
          window.__ghosttyTerminals211 = [];
          Terminal.prototype.open = function (...args) {
            window.__ghosttyTerminals211.push(this);
            return open.apply(this, args);
          };
          return url;
        }
        return null;
      });
      if (!chunk) throw new Error("no entry module of the page names a ghostty-web chunk");
      const row = await openAttachedTerminal(ctx, page, cs, windowId, TAB, "ghostty");
      const tabQuery = `.pane[data-pane-id="${row.pane}"] .terminal-tab.active[data-terminal-tab-id="${row.tab}"]`;
      const hostQuery = `${tabQuery} .terminal-host`;
      const inputQuery = `${tabQuery} .terminal-find input.find`;
      const countQuery = `${tabQuery} .terminal-find .find-count`;

      // OUTPUT
      await cs(["write", "--tab-name", TAB,
        `PS1='$ '; printf '\\033[H\\033[2J\\033[3J'; seq 1 ${LAST}; printf '${MARK}%s\\n' DONE\n`]);

      const term = await page.evaluateHandle((query) => {
        const host = document.querySelector(query);
        return window.__ghosttyTerminals211.find((t) => !t.isDisposed && host && t.element === host) ?? null;
      }, hostQuery);
      if (!(await term.evaluate((t) => t !== null))) {
        throw new Error(`no ghostty-web Terminal from ${chunk} holds this tab's terminal host`);
      }

      /// The terminal as find leaves it: the selection's anchors, its text
      /// and the text of its start row, the viewport offset, the history
      /// length and the grid.
      const state = () => term.evaluate((t) => {
        const m = t.selectionManager;
        const start = m?.selectionStart ?? null;
        const end = m?.selectionEnd ?? null;
        const rowText = (r) => t.wasmTerm.plainText({ startRow: r, startCol: 0, endRow: r, endCol: t.cols - 1 });
        return {
          start,
          end,
          startRowText: start ? rowText(start.absoluteRow) : null,
          hasSelection: t.hasSelection(),
          selectedText: t.hasSelection() ? t.getSelection() : "",
          viewportY: t.getViewportY(),
          scrollback: t.getScrollbackLength(),
          rows: t.rows,
          cols: t.cols,
        };
      });
      const onScreen = (s, absoluteRow) => absoluteRow - s.scrollback + Math.floor(s.viewportY);

      const deadline = Date.now() + 30_000;
      while (!(await term.evaluate((t, mark) => (t.wasmTerm.plainText() ?? "").includes(`${mark}DONE`), MARK))) {
        if (Date.now() > deadline) {
          await ctx.shot("ghostty-find-no-output");
          throw new Error(`the terminal never showed ${MARK}DONE`);
        }
        await sleep(200);
      }
      await ctx.shot("ghostty-find-output");

      /// Waits until the count reads `want` and the selection's row reads
      /// `line`; throws with what the page showed.
      async function waitFor(stage, want, line) {
        const until = Date.now() + 15_000;
        let last = null;
        for (;;) {
          const count = await page.evaluate((q) => document.querySelector(q)?.textContent ?? null, countQuery);
          last = { count, ...(await state()) };
          if (count === want && last.startRowText === line) return last;
          if (Date.now() > until) {
            await ctx.shot(`ghostty-find-${stage}-failure`);
            throw new Error(`${stage}: expected count ${JSON.stringify(want)} on row ${JSON.stringify(line)}; page showed ${JSON.stringify(last)}`);
          }
          await sleep(50);
        }
      }
      function expectMatch(stage, s, match) {
        if (s.start?.col !== match.col || s.end?.col !== match.end || s.start?.absoluteRow !== s.end?.absoluteRow) {
          throw new Error(`${stage}: the selection is not the match at columns ${match.col}-${match.end}: ${JSON.stringify(s)}`);
        }
      }

      // OPEN
      const mac = await page.evaluate(() => /Mac/.test(navigator.userAgent));
      const pressFindChord = async () => {
        await page.evaluate((q) => document.querySelector(`${q} textarea`)?.focus(), hostQuery);
        const modifiers = mac ? ["Meta"] : ["Control", "Shift"];
        for (const key of modifiers) await page.keyboard.down(key);
        await page.keyboard.press("KeyF");
        for (const key of modifiers.reverse()) await page.keyboard.up(key);
      };
      await pressFindChord();
      await page.waitForFunction((q) => document.activeElement === document.querySelector(q), { timeout: 10_000 }, inputQuery)
        .catch(async (error) => {
          await ctx.shot("ghostty-find-not-open");
          throw new Error(`the find chord did not open a focused find bar: ${error.message}`);
        });

      // 4999
      await page.keyboard.type("4999");
      const only = matchesOf("4999");
      readings.query4999 = await waitFor("4999", `1 of ${only.length}`, only[0].line);
      if (only.length !== 1) throw new Error(`4999 should match one line, counted ${only.length}`);
      expectMatch("4999", readings.query4999, only[0]);
      await ctx.shot("ghostty-find-4999");

      // 99
      const nines = matchesOf("99");
      await page.evaluate((q) => document.querySelector(q).select(), inputQuery);
      await page.keyboard.type("99");
      const newest = await waitFor("99", `1 of ${nines.length}`, nines[0].line);
      expectMatch("99", newest, nines[0]);
      if (newest.viewportY !== 0) throw new Error(`99: the newest match is on the screen, yet the viewport moved: ${JSON.stringify(newest)}`);
      readings.query99 = newest;
      await ctx.shot("ghostty-find-99-newest");

      // OLDER
      const steps = [];
      let revealed = null;
      for (let k = 1; k < nines.length && !revealed; k++) {
        const before = await state();
        const wasOff = (() => {
          // The row the next match is on, counted from the selected one: one
          // line per number, so the gap is the difference of the numbers.
          const r = before.start.absoluteRow - (Number(nines[k - 1].line) - Number(nines[k].line));
          const at = onScreen(before, r);
          return at < 0 || at >= before.rows;
        })();
        await page.keyboard.press("Enter");
        const s = await waitFor(`older-${k}`, `${k + 1} of ${nines.length}`, nines[k].line);
        expectMatch(`older-${k}`, s, nines[k]);
        const at = onScreen(s, s.start.absoluteRow);
        steps.push({ line: nines[k].line, viewportY: s.viewportY, onScreen: at });
        if (at < 0 || at >= s.rows) throw new Error(`older-${k}: the selected match is off the screen: ${JSON.stringify(s)}`);
        if (!wasOff && s.viewportY !== before.viewportY) {
          throw new Error(`older-${k}: a match on the screen moved the viewport: ${JSON.stringify({ before, after: s })}`);
        }
        if (wasOff) {
          if (at !== Math.floor(s.rows / 2)) {
            throw new Error(`older-${k}: the revealed match is not centred: ${JSON.stringify(s)}`);
          }
          revealed = { from: before.viewportY, ...s };
        }
      }
      readings.older = steps;
      if (!revealed) throw new Error(`no match of 99 was off the screen: ${JSON.stringify(steps)}`);
      if (!(revealed.viewportY > revealed.from)) {
        throw new Error(`the viewport did not scroll back to the older match: ${JSON.stringify(revealed)}`);
      }
      readings.revealed = revealed;
      await ctx.shot("ghostty-find-older-revealed");

      // RESIZE
      const size = pageViewport ?? { width: 1600, height: 1000 };
      readings.resize = [];
      // The active match is nines[k], counted k + 1 of N.
      let k = steps.length;
      for (const [stage, width] of [["narrower", size.width - 400], ["wider", size.width]]) {
        const before = await state();
        const kept = nines[k];
        const want = `${k + 1} of ${nines.length}`;
        resized = true;
        await page.setViewport({ ...size, width });
        const until = Date.now() + 15_000;
        let after = null;
        for (;;) {
          const count = await page.evaluate((q) => document.querySelector(q)?.textContent ?? null, countQuery);
          after = { count, ...(await state()) };
          if (after.cols !== before.cols && count === want && after.startRowText === kept.line) break;
          if (Date.now() > until) {
            await ctx.shot(`ghostty-find-resize-${stage}-failure`);
            throw new Error(`resize ${stage}: expected a reflowed grid and the match kept, ${want} on row ${JSON.stringify(kept.line)}; page showed ${JSON.stringify({ before, after })}`);
          }
          await sleep(50);
        }
        if (stage === "narrower" && !(after.cols < before.cols)) {
          throw new Error(`resize ${stage}: the grid did not narrow: ${JSON.stringify({ before, after })}`);
        }
        expectMatch(`resize-${stage}`, after, kept);
        if (after.selectedText !== "99") throw new Error(`resize ${stage}: the selected text is not the match: ${JSON.stringify(after)}`);
        const keptAt = onScreen(after, after.start.absoluteRow);
        if (keptAt < 0 || keptAt >= after.rows) throw new Error(`resize ${stage}: the kept match is off the screen: ${JSON.stringify(after)}`);
        await ctx.shot(`ghostty-find-resize-${stage}`);
        await page.keyboard.press("Enter");
        k += 1;
        const next = await waitFor(`resize-${stage}-enter`, `${k + 1} of ${nines.length}`, nines[k].line);
        expectMatch(`resize-${stage}-enter`, next, nines[k]);
        const at = onScreen(next, next.start.absoluteRow);
        if (at < 0 || at >= next.rows) throw new Error(`resize ${stage}: the next match is off the screen: ${JSON.stringify(next)}`);
        readings.resize.push({ stage, colsBefore: before.cols, after, next });
        await ctx.shot(`ghostty-find-resize-${stage}-enter`);
      }

      // ESCAPE
      await page.keyboard.press("Escape");
      await page.waitForFunction((q) => !document.querySelector(q), { timeout: 10_000 }, inputQuery);
      const closed = await state();
      readings.closed = closed;
      if (closed.hasSelection || closed.start || closed.end) {
        await ctx.shot("ghostty-find-escape-failure");
        throw new Error(`Escape left the selection: ${JSON.stringify(closed)}`);
      }
      await ctx.shot("ghostty-find-closed");

      // OLDEST
      await pressFindChord();
      await page.waitForFunction((q) => document.activeElement === document.querySelector(q), { timeout: 10_000 }, inputQuery)
        .catch(async (error) => {
          await ctx.shot("ghostty-find-oldest-not-open");
          throw new Error(`oldest: the find chord did not open a focused find bar: ${error.message}`);
        });
      const kept = await page.evaluate((q) => document.querySelector(q)?.value ?? null, inputQuery);
      if (kept !== "99") throw new Error(`oldest: the reopened bar did not keep its query: ${JSON.stringify(kept)}`);
      await page.keyboard.down("Shift");
      await page.keyboard.press("Enter");
      await page.keyboard.up("Shift");
      const oldest = nines[nines.length - 1];
      const first = await waitFor("oldest", `${nines.length} of ${nines.length}`, oldest.line);
      expectMatch("oldest", first, oldest);
      const firstAt = onScreen(first, first.start.absoluteRow);
      if (firstAt < 0 || firstAt >= first.rows) throw new Error(`oldest: the selected match is off the screen: ${JSON.stringify(first)}`);
      readings.oldest = first;
      await ctx.shot("ghostty-find-oldest");
      await page.keyboard.press("Escape");
      await page.waitForFunction((q) => !document.querySelector(q), { timeout: 10_000 }, inputQuery)
        .catch(async (error) => {
          await ctx.shot("ghostty-find-oldest-escape-failure");
          throw new Error(`oldest: Escape did not close the bar: ${error.message}`);
        });

      // REOPEN
      await pressFindChord();
      await page.waitForFunction((q) => document.activeElement === document.querySelector(q), { timeout: 10_000 }, inputQuery)
        .catch(async (error) => {
          await ctx.shot("ghostty-find-reopen-not-open");
          throw new Error(`reopen: the find chord did not open a focused find bar: ${error.message}`);
        });
      readings.reopened = await page.evaluate(async (q) => {
        document.querySelector(q).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.find.open" } }));
        await new Promise((resolve) => setTimeout(resolve, 250));
        const input = document.querySelector(q);
        return { open: !!input, focused: !!input && document.activeElement === input, active: document.activeElement?.tagName ?? null };
      }, inputQuery);
      if (!readings.reopened.open || !readings.reopened.focused) {
        await ctx.shot("ghostty-find-reopen-failure");
        throw new Error(`reopen: the bar reopened at once did not keep the keyboard: ${JSON.stringify(readings.reopened)}`);
      }
      await page.keyboard.press("Escape");
      await page.waitForFunction((q) => !document.querySelector(q), { timeout: 10_000 }, inputQuery)
        .catch(async (error) => {
          await ctx.shot("ghostty-find-reopen-escape-failure");
          throw new Error(`reopen: Escape did not close the reopened bar: ${error.message}`);
        });
      const keyboard = await page.evaluate((q) => {
        const host = document.querySelector(q);
        return !!host && host.contains(document.activeElement);
      }, hostQuery);
      if (!keyboard) throw new Error("reopen: Escape did not hand the keyboard back to the terminal");
      await page.keyboard.type(`echo ${MARK}$((6*7))\n`);
      const typed = Date.now() + 15_000;
      while (!(await term.evaluate((t, mark) => (t.wasmTerm.plainText() ?? "").includes(`${mark}42`), MARK))) {
        if (Date.now() > typed) {
          await ctx.shot("ghostty-find-reopen-typing-failure");
          throw new Error("reopen: a command typed after Escape never ran in the shell");
        }
        await sleep(100);
      }
      await ctx.shot("ghostty-find-reopen-typed");
      return readings;
    } finally {
      if (resized && pageViewport) await page.setViewport(pageViewport).catch(() => {});
      await cs(["close", "--tab-name", TAB]).catch(() => {});
      if (flipped) await writeTerminalPrefs(page, token, { ghostty: original.ghostty }).catch(() => {});
    }
  },
};
