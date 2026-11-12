// A long command in a ghostty terminal copies by every path as the one line
// it is, and pasted into a second terminal it runs once as one command; a
// pasted text that would end its own bracket reaches the program with the
// bracket intact and its line ends as xterm.js sends them.
//
// Engine: headless Chrome through puppeteer-core; the result names the
// browser's version. It says nothing about WebKit, chan-desktop's native
// clipboard or the PRIMARY selection.
//
// Terminal A (ghostty; terminal.ghostty written before and restored after)
// clears itself, takes the prompt "$ " and has a command typed at it, not
// run: `echo WORD 223-ok-$((6*7)) >> DIR/ran`, where WORD is a path long
// enough that the terminal's width cuts it in the middle, so the line
// soft-wraps onto a second row and the wrap falls inside a word. The check
// reaches the page's ghostty-web Terminal as 211 does (its open() wrapped
// before the terminal opens) to read the grid and assert that wrap from the
// core. Each copy writes a sentinel to Chrome's clipboard first and reads the
// clipboard back after:
//
//   release    -- a drag from the command's first cell to its last; ghostty-web
//                 copies on release.
//   chord      -- Ctrl+Shift+C over that selection.
//   menu       -- the body menu's Copy row over that selection.
//   scrollback -- the body menu's Copy scrollback: the prompt and the command.
//   word       -- a double click on WORD's first row: the whole of WORD.
//   line       -- a triple click on the command's second row: the prompt and
//                 the command.
//
// Terminal B (ghostty) then has the release copy's text written back to the
// clipboard and pasted by the chord and by the menu's Paste row, each
// followed by Enter: each paste runs once as one command, so DIR/ran holds
// one line per paste, WORD and 223-ok-42. Last, B's shell asks for bracketed
// paste and turns into the raw recorder (lib/pty-recorder.mjs), and a text
// holding ESC[201~, a colour escape, Ctrl+C and CRLF and LF line ends is
// pasted by the chord and by the menu: the PTY reads ESC[200~, the text with
// each of those control bytes a space and each line end a CR, and ESC[201~,
// once.

import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { startRecorder } from "../lib/pty-recorder.mjs";
import { readTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const RUN = Date.now().toString(36);
const SOURCE = "SmokeCopy223A";
const TARGET = "SmokeCopy223B";
const MENU = ".terminal-tab-menu-bubble";
const SENTINEL = `223-clipboard-sentinel-${RUN}`;
const OPEN = "\x1b[200~";
const CLOSE = "\x1b[201~";
const PROMPT = "$ ";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/// A text that would end its own bracket, colour the screen and interrupt
/// the shell, with CRLF and LF line ends; and the bytes chan pastes for it
/// under bracketed paste.
function hostile(how) {
  const text = `223 ${how} ${RUN}\x1b[201~; echo injected\r\nprintf '\x1b[31mred\x1b[0m'\x03\nlast`;
  const cleaned = `223 ${how} ${RUN} [201~; echo injected\rprintf ' [31mred [0m' \rlast`;
  return { text, want: OPEN + cleaned + CLOSE };
}

/// Every ghostty-web Terminal the page opens from now on, kept in the page.
async function trackGhosttyTerminals(page) {
  return page.evaluate(async () => {
    for (const script of document.querySelectorAll('script[type="module"][src]')) {
      const name = /ghostty-web-[\w-]+\.js/.exec(await (await fetch(script.src)).text())?.[0];
      if (!name) continue;
      const url = new URL(name, script.src).href;
      const { Terminal } = await import(url);
      const open = Terminal.prototype.open;
      window.__ghosttyTerminals223 = [];
      Terminal.prototype.open = function (...args) {
        window.__ghosttyTerminals223.push(this);
        return open.apply(this, args);
      };
      return url;
    }
    return null;
  });
}

/// The ghostty-web Terminal whose element is the host of the tab `row` names.
async function terminalOf(page, row) {
  const hostQuery = `.pane[data-pane-id="${row.pane}"] .terminal-tab.active[data-terminal-tab-id="${row.tab}"] .terminal-host`;
  const term = await page.evaluateHandle((query) => {
    const host = document.querySelector(query);
    return window.__ghosttyTerminals223.find((t) => !t.isDisposed && host && t.element === host) ?? null;
  }, hostQuery);
  if (!(await term.evaluate((t) => t !== null))) throw new Error(`no ghostty-web Terminal holds the host ${hostQuery}`);
  return { term, hostQuery };
}

/// The core's text of the whole buffer, as a copy reads it.
const bufferText = (term) => term.evaluate((t) => t.wasmTerm.plainText() ?? "");

async function waitFor(label, probe, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`${label}: timed out`);
    await sleep(100);
  }
}

/// The centre of cell (col, row) of the screen, in page pixels.
async function cellCentre(term, col, row) {
  return term.evaluate((t, at) => {
    const box = t.renderer.getCanvas().getBoundingClientRect();
    const { width, height } = t.renderer.getMetrics();
    return { x: box.left + (at.col + 0.5) * width, y: box.top + (at.row + 0.5) * height };
  }, { col, row });
}

/// The screen cell of index `i` of the prompt's line, the prompt on row 0.
function cellOf(i, cols) {
  return { col: i % cols, row: Math.floor(i / cols) };
}

async function writeClipboard(page, text) {
  const answer = await page.evaluate(async (value) => {
    try {
      await navigator.clipboard.writeText(value);
      return (await navigator.clipboard.readText()) === value ? null : "the clipboard read back a different text";
    } catch (error) {
      return String(error);
    }
  }, text);
  if (answer) throw new Error(`Chrome refused the clipboard write: ${answer}`);
}

/// The clipboard's text once `act` replaced the sentinel, or the sentinel
/// when five seconds pass without a copy.
async function copied(page, act) {
  await writeClipboard(page, SENTINEL);
  await act();
  const deadline = Date.now() + 5_000;
  for (;;) {
    const text = await page.evaluate(() => navigator.clipboard.readText());
    if (text !== SENTINEL || Date.now() > deadline) return text;
    await sleep(100);
  }
}

async function chord(page, key, commands) {
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.down(key, commands ? { commands } : undefined);
  await page.keyboard.up(key);
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
}

/// Right-click `at`, then the body menu's row labelled `label`.
async function menuRow(page, at, label) {
  await page.mouse.click(at.x, at.y, { button: "right" });
  await page.waitForSelector(MENU, { visible: true, timeout: 10_000 });
  for (const row of await page.$$(`${MENU} button.mbtn`)) {
    const text = await row.$eval(".mbtn-label", (el) => el.textContent?.trim() ?? "").catch(() => "");
    if (text === label) {
      await row.click();
      await page.waitForSelector(MENU, { hidden: true, timeout: 5_000 });
      return;
    }
  }
  throw new Error(`the body menu has no ${label} row`);
}

/// The lines of DIR/ran once it holds `n`, settled for half a second.
async function ranLines(file, n) {
  const read = () => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
  const deadline = Date.now() + 10_000;
  while (read().length < n && Date.now() < deadline) await sleep(100);
  await sleep(500);
  return read();
}

/// The bytes the recorder holds past `offset`, once the closing bracket of a
/// paste ending in `last` has arrived and half a second added nothing.
async function recordedPaste(file, offset, last) {
  const read = () => readFileSync(file).subarray(offset).toString("utf8");
  const deadline = Date.now() + 10_000;
  let seen = read();
  while (!seen.includes(`${last}${CLOSE}`) && Date.now() < deadline) {
    await sleep(100);
    seen = read();
  }
  await sleep(500);
  return read();
}

export default {
  name: "ghostty-copy-paste",
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
      ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], { cwd: ctx.workspaceDir, env, timeout: 90_000, ...opts });
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const original = await readTerminalPrefs(page, token);
    const dir = mkdtempSync(join(tmpdir(), "chan-copy-223-"));
    const ran = join(dir, "ran");
    const failures = [];
    const result = { browser: await ctx.browser.browser().version(), copies: {}, runs: [], pastes: [] };
    try {
      if (original.ghostty !== true) await writeTerminalPrefs(page, token, { ghostty: true });
      if (!(await trackGhosttyTerminals(page))) throw new Error("no entry module of the page names a ghostty-web chunk");

      // Terminal A: the long command at the prompt.
      const a = await terminalOf(page, await openAttachedTerminal(ctx, page, cs, windowId, SOURCE, "ghostty"));
      await cs(["write", "--tab-name", SOURCE, `PS1='${PROMPT}'; printf '\\033[H\\033[2J\\033[3J'\n`]);
      await waitFor("A's cleared prompt", async () => (await bufferText(a.term)) === PROMPT.trimEnd());
      const cols = await a.term.evaluate((t) => t.cols);
      // WORD starts after "$ echo " and runs twelve cells past the first row.
      const start = PROMPT.length + "echo ".length;
      const fill = `/srv/backups/${RUN}/` + "nightly-archive-".repeat(Math.ceil(cols / 16) + 2);
      const word = fill.slice(0, cols - start + 12);
      const command = `echo ${word} 223-ok-$((6*7)) >> ${ran}`;
      const line = PROMPT + command;
      result.cols = cols;
      result.command = command;
      if (line.length > 2 * cols) throw new Error(`the command takes more than two rows of ${cols} columns`);
      const host = await cellCentre(a.term, Math.floor(cols / 2), 3);
      await page.mouse.click(host.x, host.y);
      await page.keyboard.type(command);
      await waitFor("A's typed command", async () => (await bufferText(a.term)) === line);
      const grid = await a.term.evaluate((t) => ({
        wrapped: t.wasmTerm.isRowWrapped(1),
        history: t.getScrollbackLength(),
        viewportY: t.getViewportY(),
      }));
      result.grid = grid;
      if (!grid.wrapped || grid.history !== 0 || grid.viewportY !== 0) {
        throw new Error(`A's command did not soft-wrap from the first screen row: ${JSON.stringify(grid)}`);
      }
      await ctx.shot("223-typed");

      const expectCopy = (path, text, want) => {
        result.copies[path] = text;
        if (text !== want) failures.push(`${path}: the clipboard holds ${JSON.stringify(text)}, not ${JSON.stringify(want)}`);
      };
      const first = await cellCentre(a.term, PROMPT.length, 0);
      const lastCell = cellOf(line.length - 1, cols);
      const last = await cellCentre(a.term, lastCell.col, lastCell.row);
      expectCopy("release", await copied(page, async () => {
        await page.mouse.move(first.x, first.y);
        await page.mouse.down();
        for (let s = 1; s <= 8; s++) {
          await page.mouse.move(first.x + ((last.x - first.x) * s) / 8, first.y + ((last.y - first.y) * s) / 8);
        }
        await page.mouse.up();
      }), command);
      await ctx.shot("223-selected");
      expectCopy("chord", await copied(page, () => chord(page, "KeyC")), command);
      expectCopy("menu", await copied(page, () => menuRow(page, first, "Copy")), command);
      expectCopy("scrollback", await copied(page, () => menuRow(page, first, "Copy scrollback")), line);
      const inWord = await cellCentre(a.term, start + 3, 0);
      expectCopy("word", await copied(page, () => page.mouse.click(inWord.x, inWord.y, { count: 2 })), word);
      await ctx.shot("223-word");
      const onSecondRow = await cellCentre(a.term, 3, 1);
      expectCopy("line", await copied(page, () => page.mouse.click(onSecondRow.x, onSecondRow.y, { count: 3 })), line);
      await ctx.shot("223-line");

      // Terminal B: the copy pasted and run, by the chord and by the menu.
      const b = await terminalOf(page, await openAttachedTerminal(ctx, page, cs, windowId, TARGET, "ghostty"));
      await cs(["write", "--tab-name", TARGET, `PS1='${PROMPT}'; printf '\\033[H\\033[2J\\033[3J'\n`]);
      await waitFor("B's cleared prompt", async () => (await bufferText(b.term)) === PROMPT.trimEnd());
      const bHost = await cellCentre(b.term, Math.floor(cols / 2), 3);
      const ranWant = `${word} 223-ok-42`;
      for (const [n, how] of [[1, "chord"], [2, "menu"]]) {
        await writeClipboard(page, result.copies.release);
        await page.mouse.click(bHost.x, bHost.y);
        if (how === "chord") await chord(page, "KeyV", ["paste"]);
        else await menuRow(page, bHost, "Paste");
        await sleep(300);
        await page.keyboard.press("Enter");
        const lines = await ranLines(ran, n);
        result.runs.push({ how, lines });
        if (lines.length !== n || lines[n - 1] !== ranWant) {
          failures.push(`run-${how}: after the paste and Enter ${ran} holds ${JSON.stringify(lines)}, not ${n} line(s) ending ${JSON.stringify(ranWant)}`);
        }
      }
      await ctx.shot("223-ran");

      // B as the raw recorder under bracketed paste.
      const file = join(dir, "pasted.bytes");
      await startRecorder(page, file, { bracketedPaste: true });
      for (const how of ["chord", "menu"]) {
        const { text, want } = hostile(how);
        await writeClipboard(page, text);
        const offset = statSync(file).size;
        await page.mouse.click(bHost.x, bHost.y);
        if (how === "chord") await chord(page, "KeyV", ["paste"]);
        else await menuRow(page, bHost, "Paste");
        const bytes = await recordedPaste(file, offset, "last");
        result.pastes.push({ how, bytes });
        if (bytes !== want) failures.push(`paste-${how}: the PTY read ${JSON.stringify(bytes)}, not ${JSON.stringify(want)}`);
      }

      for (const [path, text] of Object.entries(result.copies)) console.log(`[smoke]   copy ${path}: ${JSON.stringify(text)}`);
      for (const run of result.runs) console.log(`[smoke]   run ${run.how}: ${JSON.stringify(run.lines)}`);
      for (const paste of result.pastes) console.log(`[smoke]   paste ${paste.how}: PTY ${JSON.stringify(paste.bytes)}`);
      console.log(`[smoke]   ${result.browser}; ${cols} columns`);
      if (failures.length) throw new Error(`${failures.length} leg(s) failed:\n  ${failures.join("\n  ")}`);
      return result;
    } catch (error) {
      await ctx.shot("223-failure").catch(() => {});
      throw error;
    } finally {
      await cs(["close", "--tab-name", TARGET]).catch(() => {});
      await cs(["close", "--tab-name", SOURCE]).catch(() => {});
      if (original.ghostty !== true) await writeTerminalPrefs(page, token, { ghostty: original.ghostty }).catch(() => {});
      await page.evaluate(() => navigator.clipboard.writeText("")).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
