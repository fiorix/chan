// A command Muse printed across two rows copies by every path as the one
// line it is in a ghostty terminal whose session runs Muse, and keeps its
// line break in a session that runs another program; in the Muse session a
// real two-line output and a full-width rule over a line keep theirs.
//
// Engine: headless Chrome through puppeteer-core; the result names the
// browser's version. It says nothing about WebKit.
//
// The fixture is Muse Code's own output, recorded from a real session at 80
// by 24 (fixtures/muse-code-block.json): a code block's line drawn to the
// last column and cut there, mid-word, with the rest drawn on the row below
// after a scroll of the rows above, then the same line drawn again after an
// absolute cursor move. Neither is an autowrap, so the core sets no wrap
// flag between the two rows.
//
// Two stand-ins replay it, each a bash script that waits for a file, clears
// the screen and its history, writes both fixture slices in the order Muse
// wrote them, then a two-line output on rows 16 and 17 and a full-width rule
// of U+2500 over a line on rows 19 and 20, and waits. The Muse terminal
// spawns the one named `muse`, so the server derives the Muse agent from
// its spawn command and the foreground command reads `muse`; the control
// terminal spawns the same script named `replay`, which names no agent.
// Each is sized to exactly 80 columns before the replay starts, by
// resizing the page from the terminal's cell width; a terminal that is not
// at 80 columns fails the check. The check reaches the page's ghostty-web
// Terminal as 223 does, reads the core's wrap flag for every replayed row
// (none set), and reads the session and program frames the page received
// for each terminal's agent and foreground command. Each copy writes a
// sentinel to Chrome's clipboard first and reads the clipboard back after:
//
//   release    -- a drag from the command's first cell to its last; ghostty-web
//                 copies on release.
//   chord      -- Ctrl+Shift+C over that selection.
//   menu       -- the body menu's Copy row over that selection.
//   scrollback -- the body menu's Copy scrollback, its non-empty lines.
//   word       -- a double click on the last column of the cut row.
//   line       -- a triple click on the line's second row.
//   output     -- (Muse only) a drag over the two-line output.
//   rule       -- (Muse only) a drag over the rule and the line under it.
//
// In the Muse terminal every path reads the command whole (the word reads
// `wrapprobe-delta`, the line and the scrollback carry the row's prefix);
// in the control terminal every path reads the break at the cut.

import { captureGhosttyTerminals } from "../lib/ghostty-capture.mjs";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const PROVENANCE = JSON.parse(readFileSync(join(FIXTURES, "muse-code-block.json"), "utf8"));
const COLS = PROVENANCE.cols;
const ROWS = PROVENANCE.rows;
const COMMAND = PROVENANCE.expected_command;
const PREFIX = PROVENANCE.row_prefix;
const FIRST_ROW = (PREFIX + COMMAND).slice(0, COLS);
const SECOND_ROW = (PREFIX + COMMAND).slice(COLS);
/// The screen rows (0 the top) the replay leaves its lines on.
const LINE_ROW = 12;
const OUTPUT = ["first line of output", "second line"];
const OUTPUT_ROW = 15;
const RULE = "\u2500".repeat(COLS);
const UNDER_RULE = "line under the rule";
const RULE_ROW = 18;

const RUN = Date.now().toString(36);
const MUSE = "SmokeMuseCopy330";
const CONTROL = "SmokeReplayCopy330";
const MENU = ".terminal-tab-menu-bubble";
const SENTINEL = `330-clipboard-sentinel-${RUN}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/// The stand-in script: waits for `go`, then replays the fixture and the
/// controls, and waits with no exec, so the script stays the foreground
/// process and its name the foreground command.
function standIn(dir) {
  return [
    "#!/bin/bash",
    `while [ ! -e '${dir}/go' ]; do sleep 0.1; done`,
    "printf '\\033[H\\033[2J\\033[3J'",
    `cat '${dir}/muse-code-block-scroll.bin' '${dir}/muse-code-block-cup.bin'`,
    `printf '\\033[${OUTPUT_ROW + 1};1H%s\\033[${OUTPUT_ROW + 2};1H%s' '${OUTPUT[0]}' '${OUTPUT[1]}'`,
    `printf '\\033[${RULE_ROW + 1};1H%s\\033[${RULE_ROW + 2};1H%s' '${RULE}' '${UNDER_RULE}'`,
    "while :; do sleep 3600; done",
    "",
  ].join("\n");
}

/// The ghostty-web Terminal whose element is the host of the tab `row` names.
async function terminalOf(page, row) {
  const hostQuery = `.pane[data-pane-id="${row.pane}"] .terminal-tab.active[data-terminal-tab-id="${row.tab}"] .terminal-host`;
  const term = await page.evaluateHandle((query) => {
    const host = document.querySelector(query);
    return window.__ghostty330.terminals.find((t) => t.core !== undefined && host && t.element === host) ?? null;
  }, hostQuery);
  if (!(await term.evaluate((t) => t !== null))) throw new Error(`no ghostty-web Terminal holds the host ${hostQuery}`);
  return term;
}

const bufferText = (term) => term.evaluate((t) => {
  if (!t.core) throw new Error("Ghostty core unavailable for buffer read");
  const text = t.core.plainText();
  if (text === null) throw new Error("Ghostty plainText returned null for buffer read");
  return text;
});

async function waitFor(label, probe, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`${label}: timed out`);
    await sleep(100);
  }
}

/// Resize the page until the terminal fits exactly COLS columns; the fit
/// takes as many whole cells as the host holds, so each step moves the
/// page's width by the missing cells and half a cell more.
async function sizeTo80(page, term, label) {
  const readings = [];
  for (let step = 0; step < 8; step++) {
    const grid = await term.evaluate((t) => ({ cols: t.cols, rows: t.rows, cell: t.getMetrics().width }));
    const viewport = page.viewport() ?? { width: 1280, height: 900 };
    readings.push({ ...grid, width: viewport.width });
    if (grid.cols === COLS && grid.rows >= ROWS) return readings;
    const width = Math.round(viewport.width + (COLS - grid.cols + 0.5) * grid.cell);
    const height = grid.rows >= ROWS ? viewport.height : viewport.height + (ROWS + 2 - grid.rows) * 24;
    await page.setViewport({ width, height });
    await waitFor(`${label}: the terminal's refit after a resize to ${width}x${height}`, () =>
      term.evaluate((t, was) => t.cols !== was.cols || t.rows !== was.rows, grid), 3_000).catch(() => {});
  }
  throw new Error(`${label}: the terminal is not at ${COLS} columns and ${ROWS} rows or more after sizing the page: ${JSON.stringify(readings)}`);
}

/// The centre of cell (col, row) of the screen, in page pixels.
async function cellCentre(term, col, row) {
  return term.evaluate((t, at) => {
    const box = t.element.querySelector(":scope > canvas").getBoundingClientRect();
    const { width, height } = t.getMetrics();
    return { x: box.left + (at.col + 0.5) * width, y: box.top + (at.row + 0.5) * height };
  }, { col, row });
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

async function copyChord(page) {
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.down("KeyC");
  await page.keyboard.up("KeyC");
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

async function drag(page, term, from, to) {
  const a = await cellCentre(term, from[0], from[1]);
  const b = await cellCentre(term, to[0], to[1]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let s = 1; s <= 8; s++) await page.mouse.move(a.x + ((b.x - a.x) * s) / 8, a.y + ((b.y - a.y) * s) / 8);
  await page.mouse.up();
}

/// The session and program frames the page receives, by session id.
async function recordSessionFrames(page) {
  const sessions = new Map();
  const cdp = await page.target().createCDPSession();
  await cdp.send("Network.enable");
  cdp.on("Network.webSocketFrameReceived", ({ response }) => {
    if (response.opcode !== 1) return;
    let frame;
    try {
      frame = JSON.parse(response.payloadData);
    } catch {
      return;
    }
    if (frame?.type === "session") {
      sessions.set(frame.id, { submitAgent: frame.submit_agent ?? null, command: frame.program?.command ?? null });
    } else if (frame?.type === "program" && sessions.has(frame.id)) {
      sessions.get(frame.id).command = frame.program?.command ?? null;
    }
  });
  return sessions;
}

export default {
  name: "muse-wrapped-command-copy",
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
    const dir = mkdtempSync(join(tmpdir(), "chan-copy-330-"));
    const failures = [];
    const result = { browser: await ctx.browser.browser().version(), terminals: {} };
    try {
      for (const name of ["muse-code-block-scroll.bin", "muse-code-block-cup.bin"]) copyFileSync(join(FIXTURES, name), join(dir, name));
      for (const name of ["muse", "replay"]) writeFileSync(join(dir, name), standIn(dir), { mode: 0o755 });
      if (!(await captureGhosttyTerminals(page, "__ghostty330"))) throw new Error("no entry module of the page names a ghostty-web chunk");
      const sessions = await recordSessionFrames(page);
      await page.setViewport({ width: 1280, height: 900 });

      for (const [tab, script, runsMuse] of [[MUSE, "muse", true], [CONTROL, "replay", false]]) {
        const label = runsMuse ? "muse" : "control";
        const record = { copies: {} };
        result.terminals[label] = record;
        const goFile = join(dir, "go");
        rmSync(goFile, { force: true });
        const term = await terminalOf(page, await openAttachedTerminal(ctx, page, cs, windowId, tab, "ghostty", ["--command", `exec ${join(dir, script)}`]));
        record.sizing = await sizeTo80(page, term, label);

        // The two readings the tab decides from, as the page received them.
        const [sessionId, signals] = await waitFor(`${label}: a session frame naming the foreground command ${script}`, () =>
          [...sessions.entries()].find(([, s]) => s.command === script) ?? null);
        record.session = { id: sessionId, ...signals };
        if ((signals.submitAgent === "muse") !== runsMuse) {
          throw new Error(`${label}: the server derived the agent ${JSON.stringify(signals.submitAgent)} for the spawn command ${script}`);
        }

        writeFileSync(goFile, "");
        await waitFor(`${label}: the replay on screen`, async () => (await bufferText(term)).includes(UNDER_RULE));
        const grid = await term.evaluate((t, rows) => ({
          cols: t.cols,
          rows: t.rows,
          history: t.getScrollbackLength(),
          viewportY: t.getViewportY(),
          wrapped: Object.fromEntries(rows.map((r) => [r, t.core.isRowWrapped(r)])),
          text: Object.fromEntries(rows.map((r) => [r, t.core.plainText({ startCol: 0, startRow: t.getScrollbackLength() + r, endCol: t.cols - 1, endRow: t.getScrollbackLength() + r })])),
        }), [LINE_ROW, LINE_ROW + 1, OUTPUT_ROW, OUTPUT_ROW + 1, RULE_ROW, RULE_ROW + 1]);
        record.grid = grid;
        if (grid.cols !== COLS) throw new Error(`${label}: the terminal holds ${grid.cols} columns after the replay, not ${COLS}`);
        if (grid.viewportY !== 0) throw new Error(`${label}: the view is scrolled back ${grid.viewportY} rows`);
        const wantRows = { [LINE_ROW]: FIRST_ROW, [LINE_ROW + 1]: SECOND_ROW, [OUTPUT_ROW]: OUTPUT[0], [OUTPUT_ROW + 1]: OUTPUT[1], [RULE_ROW]: RULE, [RULE_ROW + 1]: UNDER_RULE };
        for (const [row, want] of Object.entries(wantRows)) {
          if (grid.text[row] !== want) throw new Error(`${label}: screen row ${row} reads ${JSON.stringify(grid.text[row])}, not ${JSON.stringify(want)}`);
        }
        // Acceptance's reading: Muse set no wrap flag the core could join.
        const flagged = Object.entries(grid.wrapped).filter(([, on]) => on).map(([row]) => row);
        if (flagged.length) throw new Error(`${label}: the core marks rows ${flagged.join(", ")} as soft-wrapped`);
        await ctx.shot(`330-${label}-replayed`);

        const expectCopy = (path, text, want) => {
          record.copies[path] = text;
          if (text !== want) failures.push(`${label} ${path}: the clipboard holds ${JSON.stringify(text)}, not ${JSON.stringify(want)}`);
        };
        const broken = `${FIRST_ROW.slice(PREFIX.length)}\n${SECOND_ROW}`;
        const commandCopy = runsMuse ? COMMAND : broken;
        const first = await cellCentre(term, PREFIX.length, LINE_ROW);
        expectCopy("release", await copied(page, () => drag(page, term, [PREFIX.length, LINE_ROW], [SECOND_ROW.length - 1, LINE_ROW + 1])), commandCopy);
        expectCopy("chord", await copied(page, () => copyChord(page)), commandCopy);
        expectCopy("menu", await copied(page, () => menuRow(page, first, "Copy")), commandCopy);
        const lines = await copied(page, () => menuRow(page, first, "Copy scrollback"));
        expectCopy(
          "scrollback",
          JSON.stringify(lines.split("\n").filter((line) => line !== "")),
          JSON.stringify([...(runsMuse ? [PREFIX + COMMAND] : [FIRST_ROW, SECOND_ROW]), ...OUTPUT, RULE, UNDER_RULE]),
        );
        const cut = await cellCentre(term, COLS - 1, LINE_ROW);
        expectCopy("word", await copied(page, () => page.mouse.click(cut.x, cut.y, { count: 2 })), runsMuse ? "wrapprobe-delta" : "wrapprobe-de");
        const second = await cellCentre(term, 10, LINE_ROW + 1);
        expectCopy("line", await copied(page, () => page.mouse.click(second.x, second.y, { count: 3 })), runsMuse ? PREFIX + COMMAND : SECOND_ROW);
        if (runsMuse) {
          expectCopy("output", await copied(page, () => drag(page, term, [0, OUTPUT_ROW], [OUTPUT[1].length - 1, OUTPUT_ROW + 1])), OUTPUT.join("\n"));
          expectCopy("rule", await copied(page, () => drag(page, term, [0, RULE_ROW], [UNDER_RULE.length - 1, RULE_ROW + 1])), `${RULE}\n${UNDER_RULE}`);
        }
        await ctx.shot(`330-${label}-copied`);
        await cs(["close", "--tab-name", tab]).catch(() => {});
      }

      for (const [label, record] of Object.entries(result.terminals)) {
        console.log(`[smoke]   ${label}: agent ${JSON.stringify(record.session.submitAgent)}, foreground ${JSON.stringify(record.session.command)}, ${record.grid.cols}x${record.grid.rows}, history ${record.grid.history}, wrap flags ${JSON.stringify(record.grid.wrapped)}`);
        for (const [path, text] of Object.entries(record.copies)) console.log(`[smoke]   ${label} copy ${path}: ${JSON.stringify(text)}`);
      }
      console.log(`[smoke]   ${result.browser}; ${COLS} columns`);
      if (failures.length) throw new Error(`${failures.length} leg(s) failed:\n  ${failures.join("\n  ")}`);
      return result;
    } catch (error) {
      await ctx.shot("330-failure").catch(() => {});
      error.smokeDetails = result;
      throw error;
    } finally {
      await cs(["close", "--tab-name", CONTROL]).catch(() => {});
      await cs(["close", "--tab-name", MUSE]).catch(() => {});
      await page.evaluate(() => window.__ghostty330?.restore()).catch(() => {});
      await page.evaluate(() => navigator.clipboard.writeText("")).catch(() => {});
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  },
};
