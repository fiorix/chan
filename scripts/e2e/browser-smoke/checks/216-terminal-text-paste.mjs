// Text pasted into a terminal, by the paste chord and by the body menu's
// Paste row, reaches the program once with the expected bytes,
// bracketed when the program asked for it and plain when it did not.
//
// Engine: headless Chrome through puppeteer-core; the result names the
// browser's version. It says nothing about WebKit, where chan-desktop reads
// the clipboard natively for the menu's row.
//
// In a window of its own, two Ghostty terminals each run a shell that turns
// into a raw recorder of every byte its PTY receives: one asks for
// bracketed paste (DECSET 2004) first, the other does not. Four pastes per
// terminal, two texts by each of two paths. Each text names its leg; the plain
// one has a space, an LF and a CRLF, and the hostile one, check 223's, would
// end its own bracket, colour the screen and interrupt the shell, with a CRLF
// and an LF:
//
//   chord -- the text is written to Chrome's clipboard with writeText and
//            Ctrl+Shift+V is pressed on the focused terminal with the devtools
//            key event's paste command, so Chrome fires a trusted paste
//            carrying its clipboard's text. chan matches the chord and leaves
//            the browser's paste to the terminal's own listener.
//   menu  -- a right-click opens the body menu, whose Paste row reads the
//            clipboard itself and pastes through the terminal's paste API.
//
// The PTY must read the text once, between ESC[200~ and ESC[201~ under
// bracketed paste and bare without it, with each line break a CR, the byte
// Enter sends. Each LF and CRLF becomes CR, and the hostile text's ESC and
// Ctrl+C become spaces, so its ESC[201~ cannot end the bracket. These byte
// expectations are fixed here, independently of the terminal's paste
// implementation. A capture listener records the trusted paste events the
// page saw for the chord.

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeEveryTerminal } from "../lib/pane-strip.mjs";
import { startRecorder } from "../lib/pty-recorder.mjs";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";

const RUN = Date.now().toString(36);
const TERMINAL = ".pane .terminal-tab.active";
const MENU = ".terminal-tab-menu-bubble";
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

/// The bytes the recorder holds past `offset`, as text, once `end` (the
/// paste's last line, with its closing bracket under bracketed paste) has
/// arrived and a further half second added nothing; or whatever arrived when
/// ten seconds pass without it.
async function pastedSince(file, offset, end) {
  const read = () => readFileSync(file).subarray(offset).toString("latin1");
  const deadline = Date.now() + 10_000;
  let seen = read();
  while (!seen.includes(end) && Date.now() < deadline) {
    await sleep(100);
    seen = read();
  }
  if (!seen.includes(end)) return { complete: false, bytes: seen };
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

/// Open a Ghostty terminal in the window's pane and wait for its renderer.
async function openTerminal(ctx, page, cs, windowId, name) {
  const before = await settledTerminalCount(page);
  await openAttachedTerminal(ctx, page, cs, windowId, name);
  await page.waitForFunction((n) => document.querySelectorAll(".terminal-tab").length > n, { timeout: 30_000 }, before);
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

/// The text a leg pastes, named by `label`, and the bytes the PTY must read
/// for it: line ends as CRs, the hostile text's control bytes as spaces, and
/// the frame under bracketed paste.
function legText(kind, label, bracketed) {
  const plain = kind === "plain";
  const text = plain
    ? `216 ${label} ${RUN}\nsecond line\r\nthird line`
    : `216 ${label} ${RUN}\x1b[201~; echo injected\r\nprintf '\x1b[31mred\x1b[0m'\x03\nlast`;
  const lines = plain
    ? text.replace(/\r?\n/g, "\r")
    : `216 ${label} ${RUN} [201~; echo injected\rprintf ' [31mred [0m' \rlast`;
  const last = plain ? "third line" : "last";
  return { text, want: bracketed ? OPEN + lines + CLOSE : lines, end: bracketed ? last + CLOSE : last };
}

/// One paste over the recorder: write the `kind` text to the clipboard, paste
/// it by `how`, and return what the PTY read and what the page saw.
async function pasteLeg(ctx, page, file, mode, how, kind, failures) {
  const bracketed = mode === "bracketed";
  const { text, want, end } = legText(kind, `${how} ghostty ${mode} ${kind}`, bracketed);
  await writeClipboardText(page, text);
  const offset = statSync(file).size;
  const events = await page.evaluate(() => window.__pastes216.length);
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
    await ctx.shot(`216-ghostty-${mode}-menu-${kind}`, page);
    await clickMenuPaste(page);
  }
  const pty = await pastedSince(file, offset, end);
  const seen = await page.evaluate((from) => window.__pastes216.slice(from), events);
  const leg = `ghostty-${mode}-${how}-${kind}`;
  const result = { leg, text, pty: pty.bytes, complete: pty.complete, events: seen, focus: await focusOnTerminal(page) };
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
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const windowId = `text-paste-216-${RUN}`;
    const cs = (args) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
      cwd: ctx.workspaceDir,
      env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId },
      timeout: 60_000,
    });
    const dir = mkdtempSync(join(tmpdir(), "chan-paste-216-"));
    const page = await ctx.browser.newPage();
    const failures = [];
    const result = { backend: "ghostty", browser: await ctx.browser.browser().version(), legs: [] };
    let primary = null;
    try {
      await page.setViewport({ width: 1280, height: 800 });
      await page.bringToFront();
      const url = new URL(ctx.serverUrl);
      url.searchParams.set("w", windowId);
      await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(".pane .editor-wrap", { timeout: 30_000 });
      await ctx.waitWindowLive(windowId);
      await page.evaluate(recordPastes);
      for (const mode of ["bracketed", "unbracketed"]) {
        await openTerminal(ctx, page, cs, windowId, `Paste216-${RUN}-${mode}`);
        const file = join(dir, `ghostty-${mode}.bytes`);
        await startRecorder(page, file, { bracketedPaste: mode === "bracketed" });
        for (const how of ["chord", "menu"]) {
          for (const kind of ["plain", "hostile"]) {
            result.legs.push(await pasteLeg(ctx, page, file, mode, how, kind, failures));
          }
        }
        await ctx.shot(`216-ghostty-${mode}`, page);
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
