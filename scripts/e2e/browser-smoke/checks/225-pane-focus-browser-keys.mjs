// A terminal above a file browser: after a press into the terminal, a pane
// focus move to the browser hands it the keyboard. Each arm presses into the
// terminal with the left or the right button (the right one opens the
// terminal's menu, closed with Escape), moves the focus by Next pane, Hybrid
// Nav's commit, a press on the browser pane's strip or on its tab, and reads
// where the keyboard went; an ArrowDown then has to move the browser's
// selection, and the PTY recorder has to read nothing but the marker typed
// back in the terminal. A Hybrid Nav commit that stays on the terminal's pane
// keeps the keyboard there, and so does a press on the browser's own chrome
// hand it to the browser. Last, with the browser's pane focused and saved, the
// page closes and a new one opens the window by its id alone, as check 224
// does: the window comes back from its saved session with the terminal
// reattaching in the background pane, and the keyboard is the browser's.

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_ROW, navigateFiles } from "../lib/files.mjs";
import {
  closeEveryTerminal,
  dispatchCommand,
  readPaneStripPreference,
  writePaneStripPreference,
} from "../lib/pane-strip.mjs";
import { recordedSince, startRecorder } from "../lib/pty-recorder.mjs";
import { readTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const RUN = Date.now().toString(36);
const DIR = `pane-focus-225-${RUN}`;
const FILES = 60;
const TERMINAL = ".pane .terminal-tab.active";
const ENGINE = { xterm: ".terminal.xterm .xterm-screen", ghostty: ".terminal-host canvas" };
const MENU = ".terminal-tab-menu-bubble";
const TYPED = "78";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/// The PTY's bytes since `offset` once the marker is among them, or the
/// timeout as the reading, so a keyboard left elsewhere fails its arm alone.
async function ptySince(label, file, offset) {
  try {
    return await recordedSince(label, file, offset, TYPED);
  } catch (error) {
    return [`no marker: ${error?.message ?? error}`];
  }
}

function seedFolder(ctx) {
  const dir = join(ctx.workspaceDir, DIR);
  mkdirSync(dir);
  for (let i = 0; i < FILES; i += 1) writeFileSync(join(dir, `f${String(i).padStart(2, "0")}.txt`), `${i}\n`);
  return dir;
}

/// Where the keyboard is: the terminal's host or its textarea, an element of
/// the file browser, or another element.
function focusOf(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (el?.closest?.(".terminal-tab .terminal-host")) return el.tagName === "TEXTAREA" ? "terminal-textarea" : "terminal";
    const browser = el?.closest?.(".browser");
    if (browser) return el.getAttribute("role") === "listbox" ? "browser-list" : `browser-${el.tagName}`;
    return `${el?.tagName ?? "none"}.${el?.className?.toString?.() ?? ""}`;
  });
}

/// Where the keyboard is once `accept` holds for it, or where it is after the
/// wait, so a keyboard left elsewhere fails its arm with the reading.
async function focusSettled(page, accept, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  let focus = await focusOf(page);
  while (!accept(focus) && Date.now() < deadline) {
    await sleep(50);
    focus = await focusOf(page);
  }
  return focus;
}

/// The browser pane's selected row, its list's scroll offset and whether the
/// pane carries the focus border.
function browserState(page) {
  return page.evaluate((rowSelector) => {
    const browser = document.querySelector(".pane .browser");
    const pane = browser?.closest(".pane");
    const rows = [...(browser?.querySelectorAll(rowSelector) ?? [])];
    const selected = rows.filter((row) => row.getAttribute("aria-selected") === "true")
      .map((row) => row.querySelector('button, [role="button"]')?.textContent?.trim() ?? "");
    return {
      focusedPane: Boolean(pane?.classList.contains("focused")),
      selected,
      scroll: Math.round(browser?.querySelector(".tree-wrap")?.scrollTop ?? -1),
    };
  }, FILE_ROW);
}

function centreOf(page, selector) {
  return page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

async function suiteWindow(ctx, name) {
  const page = await ctx.browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.bringToFront();
  const url = new URL(ctx.serverUrl);
  url.searchParams.set("w", `pane-focus-225-${name}-${RUN}`);
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

/// Press into the terminal with `button`; a right press opens the terminal's
/// menu, which Escape closes without moving the keyboard. With `want`, the
/// press is made again until that element holds the keyboard through a short
/// hold: a host resume (the window regaining focus) refocuses the terminal's
/// host and can take it from the textarea.
async function pressTerminal(page, button, want = null) {
  let focus = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const host = await centreOf(page, `${TERMINAL} .terminal-host`);
    await page.mouse.click(host.x, host.y, { button });
    if (button === "right") {
      await page.waitForSelector(MENU, { visible: true, timeout: 10_000 });
      await page.keyboard.press("Escape");
      await page.waitForSelector(MENU, { hidden: true, timeout: 10_000 });
    }
    focus = await focusSettled(page, (held) => held.startsWith("terminal"));
    if (!want) return focus;
    await sleep(150);
    focus = await focusOf(page);
    if (focus === want) return focus;
  }
  return focus;
}

async function chord(page, modifier, key) {
  await page.keyboard.down(modifier);
  await page.keyboard.press(key);
  await page.keyboard.up(modifier);
}

async function clickIn(page, selector) {
  const point = await centreOf(page, selector);
  await page.mouse.click(point.x, point.y);
}

/// Enter Hybrid Nav, run `steps` in it and commit with Enter. A Hybrid Nav that
/// did not open or close fails the arm through what the keyboard did, not a
/// throw, so every arm reads.
async function hybridNav(page, steps) {
  const PREVIEW = '[aria-label="Hybrid Nav preview"]';
  await chord(page, "Control", "Period");
  await page.keyboard.press("KeyH");
  const opened = await page.waitForSelector(PREVIEW, { timeout: 5_000 }).then(() => true, () => false);
  if (!opened) return false;
  for (const key of steps) await page.keyboard.press(key);
  await page.keyboard.press("Enter");
  const closed = await page.waitForSelector(PREVIEW, { hidden: true, timeout: 5_000 }).then(() => true, () => false);
  if (!closed) {
    // Leave Hybrid Nav so the next arm starts from the window, not the
    // preview: the element that kept the keys took the Enter.
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press("Escape");
    await page.waitForSelector(PREVIEW, { hidden: true, timeout: 5_000 }).catch(() => {});
  }
  return closed;
}

const MOVES = {
  next: (page) => chord(page, "Alt", "BracketRight"),
  hybrid: (page) => hybridNav(page, ["ArrowDown"]),
  strip: (page) => clickIn(page, ".pane:has(.browser) .tabs .dead-zone"),
  tab: (page) => clickIn(page, ".pane:has(.browser) .tabs .tab-row > .tab.active"),
};

/// Type the marker back in the terminal and read every byte the PTY took
/// since `offset`; anything before the marker leaked from the browser arm.
async function markerSince(page, file, offset, label) {
  await pressTerminal(page, "left");
  await page.keyboard.type("x");
  return ptySince(label, file, offset);
}

async function moveArm(page, file, engine, press, move) {
  const arm = `${engine}-${press}-${move}`;
  const holder = await pressTerminal(page, press, expectedHolder(engine, press));
  const offset = statSync(file).size;
  const before = await browserState(page);
  await MOVES[move](page);
  const focus = await focusSettled(page, (held) => held.startsWith("browser-"));
  const after = await browserState(page);
  await page.keyboard.press("ArrowDown");
  const stepped = await selectionSettled(page, before.selected);
  const pty = await markerSince(page, file, offset, arm);
  return { arm, holder, expected: expectedHolder(engine, press), focus, before, after, stepped, pty };
}

/// The browser's state once its selection differs from `from`, or after the
/// wait.
async function selectionSettled(page, from, timeout = 3_000) {
  const deadline = Date.now() + timeout;
  let state = await browserState(page);
  while (JSON.stringify(state.selected) === JSON.stringify(from) && Date.now() < deadline) {
    await sleep(50);
    state = await browserState(page);
  }
  return state;
}

/// The keyboard holder a press leaves in the terminal: the host after a left
/// press on ghostty, the textarea after a right one (the case the blur has to
/// reach) and always on xterm.js.
function expectedHolder(engine, press) {
  return engine === "ghostty" && press === "left" ? "terminal" : "terminal-textarea";
}

function checkMove(result, failures) {
  const { arm, holder, expected, focus, before, after, stepped, pty } = result;
  if (holder !== expected) failures.push(`${arm}: the press left the keyboard on ${holder}, not ${expected}`);
  if (!after.focusedPane) failures.push(`${arm}: the browser's pane did not take the focus border`);
  if (!focus.startsWith("browser-")) failures.push(`${arm}: the keyboard went to ${focus}, not the browser`);
  if (JSON.stringify(after.selected) !== JSON.stringify(before.selected)) failures.push(`${arm}: the move changed the selection ${JSON.stringify(before.selected)} to ${JSON.stringify(after.selected)}`);
  if (after.scroll !== before.scroll) failures.push(`${arm}: the move scrolled the list from ${before.scroll} to ${after.scroll}`);
  const index = (names) => (names.length === 1 ? Number(names[0].slice(1, 3)) : NaN);
  if (index(stepped.selected) !== index(before.selected) + 1) failures.push(`${arm}: ArrowDown moved the selection ${JSON.stringify(before.selected)} to ${JSON.stringify(stepped.selected)}`);
  if (JSON.stringify(pty) !== JSON.stringify([TYPED])) failures.push(`${arm}: the PTY read ${JSON.stringify(pty)}, not only the marker`);
}

async function stayArm(page, file, engine, press) {
  const arm = `${engine}-${press}-hybrid-stay`;
  const holder = await pressTerminal(page, press, expectedHolder(engine, press));
  const offset = statSync(file).size;
  const committed = await hybridNav(page, []);
  const focus = await focusSettled(page, (held) => held.startsWith("terminal"));
  await page.keyboard.type("x");
  const pty = await ptySince(arm, file, offset);
  return { arm, holder, expected: expectedHolder(engine, press), committed, focus, pty };
}

/// A press on the browser's own chrome, at a point whose element has no
/// focusable ancestor inside the browser.
async function chromeArm(page, engine) {
  await pressTerminal(page, "left");
  const point = await page.evaluate(() => {
    const browser = document.querySelector(".pane .browser");
    const r = browser.getBoundingClientRect();
    for (let y = r.top + 2; y < r.bottom; y += 6) {
      for (let x = r.left + 2; x < r.right; x += 12) {
        const el = document.elementFromPoint(x, y);
        if (!el || !browser.contains(el)) continue;
        if (el.closest("button, input, textarea, select, a[href], [tabindex], [role='option']")) continue;
        return { x, y, target: `${el.tagName}.${el.className?.toString?.() ?? ""}` };
      }
    }
    return null;
  });
  if (!point) throw new Error(`${engine}-chrome: no point on the browser's chrome without a focusable ancestor`);
  await page.mouse.click(point.x, point.y);
  const focus = await focusSettled(page, (held) => held.startsWith("browser-"));
  return { arm: `${engine}-chrome`, target: point.target, focus };
}

/// The window's saved layout, read from the server.
async function savedLayout(ctx, windowId) {
  const url = new URL("/api/session", ctx.serverUrl);
  url.search = "";
  url.searchParams.set("w", windowId);
  const token = new URL(ctx.serverUrl).searchParams.get("t");
  const response = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`GET /api/session: ${response.status}`);
  return (await response.json()).layout ?? null;
}

/// With the browser's pane focused and saved so, the window opened again by
/// its id alone comes back from its session and the keyboard is the
/// browser's, not the terminal's reattaching in the other pane. `adopt` takes
/// the new page as soon as it opens, so cleanup and a failure's shot reach it.
async function restoreArm(ctx, page, engine, adopt) {
  const arm = `${engine}-restore`;
  await clickIn(page, ".pane:has(.browser) .browser-status");
  const windowId = new URL(page.url()).searchParams.get("w");
  const deadline = Date.now() + 10_000;
  const focusedLeaf = (node) => {
    if (!node) return null;
    if (node.k === "s") return focusedLeaf(node.a) ?? focusedLeaf(node.b);
    return node.f ? node : null;
  };
  let leaf = null;
  while (Date.now() < deadline) {
    leaf = focusedLeaf(await savedLayout(ctx, windowId));
    if ((leaf?.t ?? []).some((tab) => tab.k === "b")) break;
    await sleep(200);
  }
  if (!(leaf?.t ?? []).some((tab) => tab.k === "b")) throw new Error(`${arm}: the saved session never focused the browser's pane: ${JSON.stringify(leaf)}`);
  const url = new URL(ctx.serverUrl);
  url.searchParams.set("w", windowId);
  // The new page is adopted before the old one closes, so cleanup always has
  // a live page; it loads the window only after the old one is gone, so the
  // window comes back from its session rather than joining the open page.
  const old = page;
  page = await ctx.browser.newPage();
  adopt(page);
  await old.close();
  await page.setViewport({ width: 1280, height: 900 });
  await page.bringToFront();
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(`${TERMINAL} ${ENGINE[engine]}`, { visible: true, timeout: 30_000 });
  await page.waitForFunction((selector) => document.querySelectorAll(selector).length > 0, { timeout: 15_000 }, FILE_ROW);
  // Past the terminal's open and ghostty-web's zero-delay focus retry,
  // sampled so a reading shows what took the keyboard and when.
  const timeline = [];
  const started = Date.now();
  while (Date.now() - started < 1_500) {
    const focus = await focusOf(page);
    if (timeline.at(-1)?.focus !== focus) timeline.push({ ms: Date.now() - started, focus });
    await sleep(25);
  }
  const state = await browserState(page);
  return { arm, focus: await focusOf(page), focusedPane: state.focusedPane, timeline };
}

async function engineWindow(ctx, dir, engine, failures) {
  const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
  let page = await suiteWindow(ctx, engine);
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
    await dispatchCommand(page, "app.pane.splitDown");
    await page.waitForFunction(() => document.querySelectorAll(".pane").length === 2, { timeout: 10_000 });
    await navigateFiles(page, DIR);
    await page.waitForFunction((selector, n) => document.querySelectorAll(selector).length === n, { timeout: 15_000 }, FILE_ROW, FILES);
    // A selection a few rows down a list scrolled off its top, so a move
    // that resets either shows.
    await page.$eval(".pane .browser .tree-wrap", (wrap) => { wrap.scrollTop = 40; });
    const rows = await page.$$(FILE_ROW);
    const visible = [];
    for (const row of rows) if (await row.isIntersectingViewport()) visible.push(row);
    await visible[2].click();
    await sleep(300);

    const control = { arm: `${engine}-control`, offset: statSync(file).size };
    control.focus = await pressTerminal(page, "left");
    await page.keyboard.type("x");
    control.pty = await recordedSince(control.arm, file, control.offset, TYPED);
    results.push(control);
    if (!control.focus.startsWith("terminal") || JSON.stringify(control.pty) !== JSON.stringify([TYPED])) {
      failures.push(`${control.arm}: the recorder control read ${JSON.stringify(control)}`);
    }

    for (const press of ["left", "right"]) {
      for (const move of Object.keys(MOVES)) {
        const result = await moveArm(page, file, engine, press, move);
        results.push(result);
        checkMove(result, failures);
      }
      const stay = await stayArm(page, file, engine, press);
      results.push(stay);
      if (stay.holder !== stay.expected || !stay.committed || !stay.focus.startsWith("terminal") || JSON.stringify(stay.pty) !== JSON.stringify([TYPED])) {
        failures.push(`${stay.arm}: Hybrid Nav's commit on the terminal's pane read ${JSON.stringify(stay)}`);
      }
    }
    const chrome = await chromeArm(page, engine);
    results.push(chrome);
    if (!chrome.focus.startsWith("browser-")) failures.push(`${chrome.arm}: a press on ${chrome.target} left the keyboard on ${chrome.focus}`);
    const restore = await restoreArm(ctx, page, engine, (reopened) => { page = reopened; });
    results.push(restore);
    if (!restore.focusedPane) failures.push(`${restore.arm}: the restored window focused another pane than the saved one`);
    if (!restore.focus.startsWith("browser-")) failures.push(`${restore.arm}: the restored window left the keyboard on ${restore.focus}`);
    await ctx.shot(`225-${engine}`, page);
    return results;
  } catch (error) {
    primary = error;
    await ctx.shot(`225-${engine}-failure`, page).catch(() => {});
    throw error;
  } finally {
    console.log(`[smoke]   pane focus ${JSON.stringify(results)}`);
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
    const windowId = new URL(page.url()).searchParams.get("w");
    await page.close().catch(() => {});
    // The restore arm saved this window's session; it goes with the check.
    if (windowId) {
      const url = new URL("/api/session", ctx.serverUrl);
      url.search = "";
      url.searchParams.set("w", windowId);
      await fetch(url, { method: "DELETE", headers: token ? { authorization: `Bearer ${token}` } : {} }).catch(() => {});
    }
    if (!failedBeforeCleanup && primary) throw primary;
  }
}

export default {
  name: "pane-focus-browser-keys",
  async run(ctx) {
    const dir = mkdtempSync(join(tmpdir(), "chan-pane-focus-225-"));
    const folder = seedFolder(ctx);
    const failures = [];
    try {
      const details = {
        xterm: await engineWindow(ctx, dir, "xterm", failures),
        ghostty: await engineWindow(ctx, dir, "ghostty", failures),
      };
      if (failures.length) throw new Error(`${failures.length} arm(s) failed:\n  ${failures.join("\n  ")}`);
      return details;
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(folder, { recursive: true, force: true });
    }
  },
};
