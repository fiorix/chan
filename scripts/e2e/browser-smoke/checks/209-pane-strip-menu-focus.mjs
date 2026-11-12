// Read the keyboard holder when the pane strip opens its own menu over a
// terminal or the empty pane's welcome. The PTY recorder distinguishes focus
// that merely looks right from keys that reach the terminal after the menu.

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeEveryTerminal,
  dispatchCommand,
  readPaneStripPreference,
  writePaneStripPreference,
} from "../lib/pane-strip.mjs";
import { recordedSince, startRecorder } from "../lib/pty-recorder.mjs";
import { readTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const RUN = Date.now().toString(36);
const TERMINAL = ".pane .terminal-tab.active";
const MENU = ".hamburger-menu";
const LAUNCHER = '[role="dialog"][aria-label="Command launcher"]';
const ENGINE = { xterm: ".terminal.xterm .xterm-screen", ghostty: ".terminal-host canvas" };
const TYPED = "78";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function focusOf(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (el?.closest?.(".terminal-tab .terminal-host")) return "terminal";
    if (el?.closest?.(".welcome")) return "welcome";
    return `${el?.tagName ?? "none"}.${el?.className?.toString?.() ?? ""}`;
  });
}

function centreOf(page, selector) {
  return page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

async function suiteWindow(ctx, name) {
  const page = await ctx.browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.bringToFront();
  const url = new URL(ctx.serverUrl);
  url.searchParams.set("w", `strip-focus-209-${name}-${RUN}`);
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".pane .editor-wrap", { timeout: 30_000 });
  return page;
}

async function openTerminal(page, engine) {
  const before = await page.$$eval(".terminal-tab", (tabs) => tabs.length);
  await dispatchCommand(page, "app.terminal.toggle");
  await page.waitForFunction((n) => document.querySelectorAll(".terminal-tab").length > n, { timeout: 30_000 }, before);
  await page.waitForSelector(`${TERMINAL} ${ENGINE[engine]}`, { visible: true, timeout: 30_000 });
  await sleep(1_000);
}

async function openStretch(page, selector = ".pane .tabs .dead-zone") {
  const point = await centreOf(page, selector);
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page.waitForSelector(MENU, { visible: true, timeout: 10_000 });
}

async function clickStretchOutsideMenu(page) {
  const point = await page.$eval(".pane .tabs .dead-zone", (el) => {
    const r = el.getBoundingClientRect();
    const y = r.top + r.height / 2;
    for (const x of [r.left + 4, r.right - 4]) {
      if (document.elementFromPoint(x, y)?.closest(".dead-zone") === el) return { x, y };
    }
    throw new Error("the menu covers both ends of the strip's empty stretch");
  });
  await page.mouse.click(point.x, point.y);
}

/// Click the pane menu's Command launcher row, then close the launcher with
/// Escape; answers whether the menu and the launcher both closed.
async function launcherRow(page) {
  const point = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".hamburger-menu button")].find(
      (button) => button.querySelector(".menu-row-label")?.textContent?.trim() === "Command launcher",
    );
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (!point) throw new Error("the pane menu has no Command launcher row");
  await page.mouse.click(point.x, point.y);
  await page.waitForSelector(LAUNCHER, { visible: true, timeout: 10_000 });
  const menuClosed = await page.waitForSelector(MENU, { hidden: true, timeout: 10_000 }).then(() => true, () => false);
  await page.keyboard.press("Escape");
  const launcherClosed = await page.waitForSelector(LAUNCHER, { hidden: true, timeout: 10_000 }).then(() => true, () => false);
  return menuClosed && launcherClosed;
}

async function terminalArm(page, file, engine, arm, action, otherPane = false) {
  const offset = statSync(file).size;
  if (otherPane) {
    const point = await page.evaluate(() => {
      const pane = [...document.querySelectorAll(".pane")].find((node) => !node.querySelector(".terminal-tab"));
      const stretch = pane?.querySelector(".tabs .dead-zone");
      if (!stretch) return null;
      const r = stretch.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (!point) throw new Error("the split has no other pane's strip stretch");
    await page.mouse.click(point.x, point.y, { button: "right" });
    await page.waitForSelector(MENU, { visible: true, timeout: 10_000 });
  } else if (action !== "control") {
    await openStretch(page);
  }
  const opened = action === "control" ? null : await focusOf(page);
  let closed = null;
  if (action === "escape" || action === "split") {
    await page.keyboard.press("Escape");
    closed = await page.waitForSelector(MENU, { hidden: true, timeout: 2_000 }).then(() => true, () => false);
  } else if (action === "outside") {
    const host = await centreOf(page, `${TERMINAL} .terminal-host`);
    await page.mouse.click(host.x, host.y);
    closed = await page.waitForSelector(MENU, { hidden: true, timeout: 2_000 }).then(() => true, () => false);
  } else if (action === "launcher") {
    closed = await launcherRow(page);
  } else if (action === "left") {
    await clickStretchOutsideMenu(page);
    closed = await page.waitForSelector(MENU, { hidden: true, timeout: 2_000 }).then(() => true, () => false);
  }
  const focus = await focusOf(page);
  if (focus !== "terminal" || closed === false) {
    if (closed === false) await page.keyboard.press("Escape");
    const host = await centreOf(page, `${TERMINAL} .terminal-host`);
    await page.mouse.click(host.x, host.y);
  }
  await page.keyboard.type("x");
  return { arm, engine, opened, closed, focus, pty: await recordedSince(arm, file, offset, TYPED) };
}

function checkTerminal(result, failures) {
  if (result.arm.endsWith("control")) {
    if (result.focus !== "terminal" || JSON.stringify(result.pty) !== JSON.stringify([TYPED])) {
      failures.push(`${result.arm}: the no-menu control read ${JSON.stringify(result)}`);
    }
    return;
  }
  if (result.opened !== "terminal") failures.push(`${result.arm}: the menu opened over ${result.opened}, not the terminal`);
  if (!result.closed) failures.push(`${result.arm}: the menu or launcher stayed open`);
  if (result.focus !== "terminal") failures.push(`${result.arm}: closing left focus on ${result.focus}, not the terminal`);
  if (JSON.stringify(result.pty) !== JSON.stringify([TYPED])) failures.push(`${result.arm}: the PTY read ${JSON.stringify(result.pty)}, not only x`);
}

async function terminalWindow(ctx, dir, engine, failures) {
  const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
  const page = await suiteWindow(ctx, engine);
  const results = [];
  let originalPrefs = null;
  let originalStrip = null;
  let primary = null;
  try {
    originalPrefs = await readTerminalPrefs(page, token);
    originalStrip = await readPaneStripPreference(page, token);
    if (originalStrip.on) await writePaneStripPreference(page, token, false);
    await writeTerminalPrefs(page, token, { ghostty: engine === "ghostty" });
    await openTerminal(page, engine);
    const file = join(dir, `${engine}.bytes`);
    await startRecorder(page, file);
    for (const action of ["control", "escape", "outside", "launcher", "left"]) {
      const result = await terminalArm(page, file, engine, `${engine}-${action}`, action);
      results.push(result);
      checkTerminal(result, failures);
    }
    const host = await centreOf(page, `${TERMINAL} .terminal-host`);
    await page.mouse.click(host.x, host.y);
    await dispatchCommand(page, "app.pane.splitRight");
    await page.waitForFunction(() => document.querySelectorAll(".pane").length === 2, { timeout: 10_000 });
    const splitHost = await centreOf(page, `${TERMINAL} .terminal-host`);
    await page.mouse.click(splitHost.x, splitHost.y);
    const split = await terminalArm(page, file, engine, `${engine}-split`, "split", true);
    results.push(split);
    checkTerminal(split, failures);
    await ctx.shot(`209-${engine}`, page);
    return results;
  } catch (error) {
    primary = error;
    await ctx.shot(`209-${engine}-failure`, page).catch(() => {});
    throw error;
  } finally {
    console.log(`[smoke]   strip focus ${JSON.stringify(results)}`);
    const failedBeforeCleanup = primary !== null;
    try {
      if (originalPrefs) {
        const host = await centreOf(page, `${TERMINAL} .terminal-host`).catch(() => null);
        if (host) await page.mouse.click(host.x, host.y);
        await closeEveryTerminal(page, "cleanup", token);
      }
    } catch (error) {
      if (primary) console.log(`[smoke]   terminal cleanup also failed: ${error?.message ?? error}`);
      else primary = error;
    }
    try { if (originalPrefs) await writeTerminalPrefs(page, token, { ghostty: originalPrefs.ghostty }); }
    catch (error) { if (primary) console.log(`[smoke]   terminal preference cleanup also failed: ${error?.message ?? error}`); else primary = error; }
    try { if (originalStrip?.on) await writePaneStripPreference(page, token, true); }
    catch (error) { if (primary) console.log(`[smoke]   strip preference cleanup also failed: ${error?.message ?? error}`); else primary = error; }
    await page.close().catch(() => {});
    if (primary && !results.length) console.log(`[smoke]   ${engine}: no completed arms`);
    if (!failedBeforeCleanup && primary) throw primary;
  }
}

async function emptyWindow(ctx, failures) {
  const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
  const page = await suiteWindow(ctx, "empty");
  const results = [];
  let originalStrip = null;
  try {
    originalStrip = await readPaneStripPreference(page, token);
    if (originalStrip.on) await writePaneStripPreference(page, token, false);
    await page.waitForSelector(".pane .welcome", { visible: true, timeout: 15_000 });
    const welcome = await centreOf(page, ".pane .welcome");
    await page.mouse.click(welcome.x, welcome.y);
    await openStretch(page);
    const escapeOpened = await focusOf(page);
    await page.keyboard.press("Escape");
    const escapeClosed = await page.waitForSelector(MENU, { hidden: true, timeout: 2_000 }).then(() => true, () => false);
    const escapeFocus = await focusOf(page);
    const escape = { arm: "empty-escape", engine: null, opened: escapeOpened, closed: escapeClosed, focus: escapeFocus, pty: null };
    results.push(escape);
    if (escape.opened !== "welcome" || !escape.closed || escape.focus !== "welcome") failures.push(`${escape.arm}: ${JSON.stringify(escape)}`);
    await page.mouse.click(welcome.x, welcome.y);
    await openStretch(page);
    const launcherOpened = await focusOf(page);
    const launcherClosed = await launcherRow(page);
    const launcherFocus = await focusOf(page);
    const command = { arm: "empty-launcher", engine: null, opened: launcherOpened, closed: launcherClosed, focus: launcherFocus, pty: null };
    results.push(command);
    if (command.opened !== "welcome" || !command.closed || command.focus !== "welcome") failures.push(`${command.arm}: ${JSON.stringify(command)}`);
    await page.mouse.click(welcome.x, welcome.y);
    await openStretch(page);
    const leftOpened = await focusOf(page);
    await clickStretchOutsideMenu(page);
    const leftClosed = await page.waitForSelector(MENU, { hidden: true, timeout: 2_000 }).then(() => true, () => false);
    const leftFocus = await focusOf(page);
    const left = { arm: "empty-left", engine: null, opened: leftOpened, closed: leftClosed, focus: leftFocus, pty: null };
    results.push(left);
    if (left.opened !== "welcome" || !left.closed || left.focus !== "welcome") failures.push(`${left.arm}: ${JSON.stringify(left)}`);
    await ctx.shot("209-empty", page);
    return results;
  } finally {
    console.log(`[smoke]   empty focus ${JSON.stringify(results)}`);
    try { if (originalStrip?.on) await writePaneStripPreference(page, token, true); }
    finally { await page.close().catch(() => {}); }
  }
}

export default {
  name: "pane-strip-menu-focus",
  async run(ctx) {
    const dir = mkdtempSync(join(tmpdir(), "chan-strip-focus-209-"));
    const failures = [];
    try {
      const details = {
        xterm: await terminalWindow(ctx, dir, "xterm", failures),
        ghostty: await terminalWindow(ctx, dir, "ghostty", failures),
        empty: await emptyWindow(ctx, failures),
      };
      console.log(`[smoke]   pane strip focus ${JSON.stringify(details)}`);
      if (failures.length) throw new Error(`${failures.length} arm(s) failed:\n  ${failures.join("\n  ")}`);
      return details;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
