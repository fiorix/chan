// Text pasted into a terminal, by the paste chord and by the body menu's
// Paste row, reaches the program once, bracketed, on both engines.
//
// Engine: headless Chrome through puppeteer-core; the result names the
// browser's version. It says nothing about WebKit, where chan-desktop reads
// the clipboard natively for the menu's row.
//
// In a window of its own, a terminal on xterm.js and then one on ghostty
// (terminal.ghostty written before each and restored after) runs a shell
// that asks for bracketed paste (DECSET 2004) and then turns into a raw
// recorder of every byte its PTY receives. Two pastes per engine, each of a
// text with a space and a line break that names its leg:
//
//   chord -- the text is written to Chrome's clipboard with writeText and
//            Ctrl+Shift+V is pressed on the focused terminal with the devtools
//            key event's paste command, so Chrome fires a trusted paste
//            carrying its clipboard's text. chan matches the chord and leaves
//            the browser's paste to the engine's own listener.
//   menu  -- a right-click opens the body menu, which names its engine, and
//            its Paste row reads the clipboard itself and pastes through the
//            engine's paste.
//
// The PTY must read exactly ESC[200~, the text and ESC[201~, once. The line
// break is each engine's own, as read from their sources and asserted as the
// product does it today: xterm.js rewrites each \n (and \r\n) as \r before it
// brackets the text, the byte Enter sends, while ghostty-web sends the text as
// the clipboard holds it, \n included, under bracketed paste. A capture
// listener records the trusted paste events the page saw for the chord.

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeEveryTerminal, dispatchCommand } from "../lib/pane-strip.mjs";
import { startRecorder } from "../lib/pty-recorder.mjs";
import { readTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const RUN = Date.now().toString(36);
const TERMINAL = ".pane .terminal-tab.active";
const MENU = ".terminal-tab-menu-bubble";
const ENGINE = { xterm: ".terminal.xterm .xterm-screen", ghostty: ".terminal-host canvas" };
const LINE_BREAK = { xterm: "\r", ghostty: "\n" };
const OPEN = "\x1b[200~";
const CLOSE = "\x1b[201~";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function centreOf(page, selector) {
  return page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

function focusOnTerminal(page) {
  return page.evaluate(() => document.activeElement?.closest?.(".terminal-tab .terminal-host") != null);
}

/// Installed on the check's page: every paste event as the page saw it, in
/// the capture phase before any handler.
function recordPastes() {
  window.__pastes216 = [];
  window.addEventListener("paste", (event) => {
    const data = event.clipboardData;
    window.__pastes216.push({
      trusted: event.isTrusted,
      types: data ? [...data.types] : null,
      text: data ? data.getData("text/plain") : null,
      inTerminal: event.target instanceof Element && event.target.closest(".terminal-tab .terminal-host") != null,
    });
  }, true);
}

async function writeClipboardText(page, text) {
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

async function pressPasteChord(page) {
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.down("KeyV", { commands: ["paste"] });
  await page.keyboard.up("KeyV");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
}

/// The bytes the recorder holds past `offset`, as text, once the closing
/// bracket has arrived and a further half second added nothing; or whatever
/// arrived when ten seconds pass without it.
async function pastedSince(file, offset) {
  const read = () => readFileSync(file).subarray(offset).toString("latin1");
  const deadline = Date.now() + 10_000;
  let seen = read();
  while (!seen.includes(CLOSE) && Date.now() < deadline) {
    await sleep(100);
    seen = read();
  }
  if (!seen.includes(CLOSE)) return { complete: false, bytes: seen };
  await sleep(500);
  return { complete: true, bytes: read() };
}

/// How many terminals the window mounts, once the count has held for a second.
async function settledTerminalCount(page) {
  const count = () => page.$$eval(".terminal-tab", (tabs) => tabs.length);
  let last = await count();
  let since = Date.now();
  const deadline = Date.now() + 30_000;
  while (Date.now() - since < 1_000) {
    if (Date.now() > deadline) throw new Error(`the window's terminal count never settled; last ${last}`);
    await sleep(150);
    const now = await count();
    if (now !== last) {
      last = now;
      since = Date.now();
    }
  }
  return last;
}

/// Open a terminal on `engine` in the window's pane and wait for its renderer.
async function openTerminal(page, engine) {
  const before = await settledTerminalCount(page);
  await dispatchCommand(page, "app.terminal.toggle");
  await page.waitForFunction((n) => document.querySelectorAll(".terminal-tab").length > n, { timeout: 30_000 }, before);
  await page.waitForSelector(`${TERMINAL} ${ENGINE[engine]}`, { visible: true, timeout: 30_000 });
  // A moment for the shell's prompt; keys typed before it wait in the PTY.
  await sleep(1_000);
}

/// Click the body menu's Paste row and wait for the menu to close.
async function clickMenuPaste(page) {
  const rows = await page.$$(`${MENU} button.mbtn`);
  for (const row of rows) {
    const label = await row.$eval(".mbtn-label", (el) => el.textContent?.trim() ?? "").catch(() => "");
    if (label === "Paste") {
      await row.click();
      await page.waitForSelector(MENU, { hidden: true, timeout: 5_000 });
      return;
    }
  }
  throw new Error("the body menu has no Paste row");
}

/// One paste over the recorder: write `text` to the clipboard, paste it by
/// `how`, and return what the PTY read and what the page saw.
async function pasteLeg(ctx, page, file, engine, how, failures) {
  const text = `216 ${how} ${engine} ${RUN}\nsecond line`;
  const want = OPEN + text.replace(/\r?\n/g, LINE_BREAK[engine]) + CLOSE;
  await writeClipboardText(page, text);
  const offset = statSync(file).size;
  const events = await page.evaluate(() => window.__pastes216.length);
  let menuEngine = null;
  if (how === "chord") {
    if (!(await focusOnTerminal(page))) {
      const host = await centreOf(page, `${TERMINAL} .terminal-host`);
      await page.mouse.click(host.x, host.y);
      await sleep(200);
    }
    await pressPasteChord(page);
  } else {
    const host = await centreOf(page, `${TERMINAL} .terminal-host`);
    await page.mouse.click(host.x, host.y, { button: "right" });
    await page.waitForSelector(MENU, { visible: true, timeout: 10_000 });
    menuEngine = await page.$eval(`${MENU} .terminal-backend-label`, (el) => el.getAttribute("data-terminal-backend"));
    await ctx.shot(`216-${engine}-menu`, page);
    await clickMenuPaste(page);
  }
  const pty = await pastedSince(file, offset);
  const seen = await page.evaluate((from) => window.__pastes216.slice(from), events);
  const leg = `${engine}-${how}`;
  const result = { leg, text, pty: pty.bytes, complete: pty.complete, events: seen, focus: await focusOnTerminal(page) };
  if (menuEngine !== null) {
    result.menuEngine = menuEngine;
    if (menuEngine !== engine) failures.push(`${leg}: the body menu names the engine ${menuEngine}, not ${engine}`);
  }
  if (pty.bytes !== want) {
    failures.push(`${leg}: the PTY read ${JSON.stringify(pty.bytes)}, not ${JSON.stringify(want)}`);
  }
  if (how === "chord") {
    const trusted = seen.filter((event) => event.trusted && event.inTerminal);
    if (trusted.length !== 1 || trusted[0].text !== text) {
      failures.push(`${leg}: the page saw ${JSON.stringify(seen)}, not one trusted paste of the text in the terminal`);
    }
  }
  if (!result.focus) failures.push(`${leg}: after the paste the keyboard is not on the terminal`);
  return result;
}

export default {
  name: "terminal-text-paste",
  async run(ctx) {
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const dir = mkdtempSync(join(tmpdir(), "chan-paste-216-"));
    const page = await ctx.browser.newPage();
    const failures = [];
    const result = { browser: await ctx.browser.browser().version(), legs: [] };
    let prefs = null;
    let primary = null;
    try {
      await page.setViewport({ width: 1280, height: 800 });
      await page.bringToFront();
      const url = new URL(ctx.serverUrl);
      url.searchParams.set("w", `text-paste-216-${RUN}`);
      await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(".pane .editor-wrap", { timeout: 30_000 });
      await page.evaluate(recordPastes);
      prefs = await readTerminalPrefs(page, token);
      for (const engine of ["xterm", "ghostty"]) {
        await writeTerminalPrefs(page, token, { ghostty: engine === "ghostty" });
        await openTerminal(page, engine);
        const file = join(dir, `${engine}.bytes`);
        await startRecorder(page, file, { bracketedPaste: true });
        for (const how of ["chord", "menu"]) {
          result.legs.push(await pasteLeg(ctx, page, file, engine, how, failures));
        }
        await ctx.shot(`216-${engine}`, page);
      }
      for (const leg of result.legs) {
        console.log(`[smoke]   ${leg.leg}: PTY ${JSON.stringify(leg.pty)}; paste events ${JSON.stringify(leg.events.map((e) => ({ trusted: e.trusted, types: e.types })))}`);
      }
      console.log(`[smoke]   ${result.browser}`);
      if (failures.length) throw new Error(`${failures.length} leg(s) failed:\n  ${failures.join("\n  ")}`);
      return result;
    } catch (error) {
      primary = error;
      await ctx.shot("216-failure", page).catch(() => {});
      throw error;
    } finally {
      const cleanups = [
        () => closeEveryTerminal(page, "cleanup", token),
        async () => { if (prefs) await writeTerminalPrefs(page, token, { ghostty: prefs.ghostty }); },
        () => page.evaluate(() => navigator.clipboard.writeText("")),
        () => page.close(),
      ];
      let first = null;
      for (const step of cleanups) {
        try {
          await step();
        } catch (error) {
          if (primary || first) console.log(`[smoke]   cleanup also failed: ${error?.message ?? error}`);
          else first = error;
        }
      }
      rmSync(dir, { recursive: true, force: true });
      if (!primary && first) throw first;
    }
  },
};
