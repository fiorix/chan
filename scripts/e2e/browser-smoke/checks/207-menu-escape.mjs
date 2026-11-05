// Escape over a terminal's menu, and an editor's, in real Chrome with the
// browser's own keys and right-click.
//
// The terminal keeps the keyboard while its menu is open, and each engine
// takes Escape at the focused element and sends ESC to the PTY. On xterm.js
// and on ghostty, in a workspace window and in a standalone terminal window,
// the body menu (a right-click in the terminal) and, in the workspace window,
// the tab's menu from the strip are opened over a shell turned into a raw
// recorder of every byte the PTY receives. Escape must close the menu and
// leave focus on the terminal, and the PTY must read only the x typed next,
// no ESC. A control press with no menu open must reach the PTY as ESC, which
// proves the recorder sees one.
//
// An editor keeps the keyboard the same way, and CodeMirror collapses a
// selection on Escape: over its body menu and its tab menu, Escape closes the
// menu and keeps the selection, and the control press with no menu open
// collapses it.
//
// The workspace terminal arms and the editor arms each run in a window of
// their own on the suite's server, and the standalone arms in the terminal
// window a throwaway `chan devserver` mints. The preferences changed on the
// suite's server are restored to what the check found, and the terminals it
// opened there are closed.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchWindows, goto, killChild, poll, spawnDevserver } from "../lib/launcher-devserver.mjs";
import {
  closeEveryTerminal,
  dispatchCommand,
  readPaneStripPreference,
  writePaneStripPreference,
} from "../lib/pane-strip.mjs";
import { readTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";

const RUN = Date.now().toString(36);
const ESC = "1b";
const TYPED = "78";
const TERMINAL = ".pane .terminal-tab.active";
const TERMINAL_MENU = ".terminal-tab-menu-bubble";
const EDITOR = ".editor-tab.active .cm-content";
const EDITOR_MENU = ".tab-menu-bubble";
const ENGINE = { xterm: ".terminal.xterm .xterm-screen", ghostty: ".terminal-host canvas" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function centreOf(page, selector) {
  return page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

async function waitFile(label, path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`${label}: ${path} did not appear within ${timeoutMs}ms`);
    await sleep(100);
  }
}

/// Where the keyboard is: the terminal, the editor, or another element.
function focusOf(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (el?.closest?.(".terminal-tab .terminal-host")) return "terminal";
    if (el?.closest?.(".cm-content")) return "editor";
    return `${el?.tagName ?? "none"}.${el?.className?.toString?.() ?? ""}`;
  });
}

/// Every menu's right-click, on the active terminal or the active tab.
const OPEN = {
  body: async (page) => {
    const { x, y } = await centreOf(page, `${TERMINAL} .terminal-host`);
    await page.mouse.click(x, y, { button: "right" });
  },
  strip: async (page) => {
    const { x, y } = await centreOf(page, ".pane .tabs .tab.active .path");
    await page.mouse.click(x, y, { button: "right" });
  },
};

/// Turn the active terminal's shell into a recorder: in raw mode, dd writes
/// every byte the PTY receives to `file`, one at a time, with no line editing
/// that a stray byte could leave in a state of its own.
async function startRecorder(page, file) {
  const host = await centreOf(page, `${TERMINAL} .terminal-host`);
  await page.mouse.click(host.x, host.y);
  await page.keyboard.type(`stty raw -echo && exec dd bs=1 status=none of=${file}`);
  await page.keyboard.press("Enter");
  await waitFile(`the recorder ${file}`, file, 30_000);
  await sleep(300);
}

/// The bytes the recorder holds past `offset`, once the `x` that ends an arm
/// is among them.
async function recordedSince(label, file, offset) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const bytes = [...readFileSync(file).subarray(offset)].map((b) => b.toString(16).padStart(2, "0"));
    if (bytes.includes(TYPED)) return bytes;
    if (Date.now() > deadline) throw new Error(`${label}: the x typed after Escape never reached the PTY; it read ${JSON.stringify(bytes)}`);
    await sleep(100);
  }
}

/// One arm over the recorder: open the menu (or none, for the control),
/// press Escape, read the menu and the focus, type `x`, and return every byte
/// the PTY received meanwhile.
async function terminalArm(page, file, label, open) {
  const offset = statSync(file).size;
  let opened = null;
  let engine = null;
  if (open) {
    await open(page);
    await page.waitForSelector(TERMINAL_MENU, { visible: true, timeout: 10_000 });
    opened = await focusOf(page);
    // The body menu names the engine that draws this terminal.
    engine = await page.$eval(`${TERMINAL_MENU} .terminal-backend-label`, (el) => el.getAttribute("data-terminal-backend")).catch(() => null);
  }
  await page.keyboard.press("Escape");
  const closed = open
    ? await page.waitForSelector(TERMINAL_MENU, { hidden: true, timeout: 2_000 }).then(() => true, () => false)
    : null;
  const focus = await focusOf(page);
  if (focus !== "terminal" || closed === false) {
    // Hand the keyboard back so the arm can end and say what the PTY read.
    const host = await centreOf(page, `${TERMINAL} .terminal-host`);
    await page.mouse.click(host.x, host.y);
    await sleep(200);
  }
  await page.keyboard.type("x");
  return { arm: label, engine, opened, closed, focus, pty: await recordedSince(label, file, offset) };
}

/// How many terminals the window mounts, once a reload's restored terminals
/// have all come back: the count has held for a second.
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

/// The control and the menu arms on `engine`, each checked: with no menu
/// open the PTY reads ESC and then x; every menu opens with the terminal
/// focused, closes on Escape, leaves the terminal focused, and the PTY reads
/// only the x.
async function terminalArms(page, dir, prefix, engine, menus, failures) {
  const file = join(dir, `${prefix}-${engine}.bytes`);
  await startRecorder(page, file);
  const results = [];
  const control = await terminalArm(page, file, `${prefix}-${engine}-control`, null);
  results.push(control);
  if (JSON.stringify(control.pty) !== JSON.stringify([ESC, TYPED])) {
    failures.push(`${control.arm}: with no menu open the PTY read ${JSON.stringify(control.pty)}, not ESC then x; the recorder cannot see an ESC`);
  }
  for (const menu of menus) {
    const result = await terminalArm(page, file, `${prefix}-${engine}-${menu}`, OPEN[menu]);
    results.push(result);
    if (menu === "body" && result.engine !== engine) failures.push(`${result.arm}: the body menu names the engine ${result.engine}, not ${engine}`);
    if (result.opened !== "terminal") failures.push(`${result.arm}: the menu opened with focus on ${result.opened}, not the terminal`);
    if (!result.closed) failures.push(`${result.arm}: Escape left the menu open`);
    if (result.focus !== "terminal") failures.push(`${result.arm}: after Escape focus is on ${result.focus}`);
    if (JSON.stringify(result.pty) !== JSON.stringify([TYPED])) {
      failures.push(`${result.arm}: the PTY read ${JSON.stringify(result.pty)}, not only the x typed after Escape`);
    }
  }
  return results;
}

function editorSelection(page) {
  return page.evaluate((selector) => {
    const main = document.querySelector(selector)?.cmTile?.root?.view?.state.selection.main;
    return main ? [main.anchor, main.head] : null;
  }, EDITOR);
}

/// Select a word in the editor, open the menu (or none), press Escape, and
/// read the menu, the focus and the selection.
async function editorArm(page, label, open) {
  const selected = await page.evaluate((selector) => {
    const view = document.querySelector(selector)?.cmTile?.root?.view;
    if (!view) throw new Error("editor view unavailable");
    view.dispatch({ selection: { anchor: 2, head: 6 } });
    view.focus();
    const at = view.coordsAtPos(4);
    return { x: at.left, y: (at.top + at.bottom) / 2 };
  }, EDITOR);
  await sleep(200);
  if (open === "body") await page.mouse.click(selected.x, selected.y, { button: "right" });
  if (open === "strip") await OPEN.strip(page);
  if (open) await page.waitForSelector(EDITOR_MENU, { visible: true, timeout: 10_000 });
  const before = await editorSelection(page);
  await page.keyboard.press("Escape");
  const closed = open
    ? await page.waitForSelector(EDITOR_MENU, { hidden: true, timeout: 2_000 }).then(() => true, () => false)
    : null;
  const result = { arm: label, closed, focus: await focusOf(page), before, after: await editorSelection(page) };
  if (closed === false) await page.mouse.click(5, 5);
  return result;
}

/// Run the cleanups in order, each even when one before it threw. A cleanup
/// that throws after the arms already failed is logged, so the arms' own
/// failure is the one reported.
async function cleanUp(primary, steps) {
  let first = null;
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      if (primary || first) console.log(`[smoke]   cleanup also failed: ${error?.message ?? error}`);
      else first = error;
    }
  }
  if (!primary && first) throw first;
}

/// Open a window of its own on the suite's server.
async function suiteWindow(ctx, name) {
  const page = await ctx.browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.bringToFront();
  const windowId = `menu-escape-207-${name}-${RUN}`;
  const url = new URL(ctx.serverUrl);
  url.searchParams.set("w", windowId);
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".pane .editor-wrap", { timeout: 30_000 });
  return { page, windowId };
}

/// The suite server's tenant, with the strip drawn: both engines' terminal
/// arms in one window.
async function workspaceTerminals(ctx, dir, failures) {
  const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
  const { page } = await suiteWindow(ctx, "terminal");
  const results = [];
  let prefs = null;
  let strip = null;
  let primary = null;
  try {
    prefs = await readTerminalPrefs(page, token);
    strip = await readPaneStripPreference(page, token);
    if (strip.on) await writePaneStripPreference(page, token, false);
    for (const engine of ["xterm", "ghostty"]) {
      await writeTerminalPrefs(page, token, { ghostty: engine === "ghostty" });
      await openTerminal(page, engine);
      results.push(...await terminalArms(page, dir, "workspace", engine, ["body", "strip"], failures));
    }
    await ctx.shot("207-workspace-terminal", page);
    return results;
  } catch (error) {
    primary = error;
    await ctx.shot("207-workspace-terminal-failure", page).catch(() => {});
    throw error;
  } finally {
    console.log(`[smoke]   workspace terminals ${JSON.stringify(results)}`);
    await cleanUp(primary, [
      () => closeEveryTerminal(page, "cleanup", token),
      async () => { if (prefs) await writeTerminalPrefs(page, token, { ghostty: prefs.ghostty }); },
      async () => { if (strip?.on) await writePaneStripPreference(page, token, true); },
      () => page.close(),
    ]);
  }
}

/// An editor on the seeded document in a window of its own, with the strip
/// drawn: the control and the two menus.
async function workspaceEditor(ctx, failures) {
  const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
  const { page, windowId } = await suiteWindow(ctx, "editor");
  const results = [];
  let strip = null;
  let primary = null;
  try {
    strip = await readPaneStripPreference(page, token);
    if (strip.on) await writePaneStripPreference(page, token, false);
    await ctx.waitWindowLive(windowId);
    await ctx.exec(ctx.chanBin, ["shell", "open", "doc.md"], {
      cwd: ctx.workspaceDir,
      env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId },
      timeout: 30_000,
    });
    await page.waitForSelector(EDITOR, { visible: true, timeout: 30_000 });
    await sleep(500);
    const control = await editorArm(page, "editor-control", null);
    results.push(control);
    if (control.after?.[0] !== control.after?.[1] || control.after?.[1] !== 6) {
      failures.push(`${control.arm}: with no menu open Escape left the selection ${JSON.stringify(control.after)}; the editor did not take it`);
    }
    for (const menu of ["body", "strip"]) {
      const result = await editorArm(page, `editor-${menu}`, menu);
      results.push(result);
      if (!result.closed) failures.push(`${result.arm}: Escape left the menu open`);
      if (result.focus !== "editor") failures.push(`${result.arm}: after Escape focus is on ${result.focus}`);
      if (JSON.stringify(result.after) !== JSON.stringify([2, 6])) {
        failures.push(`${result.arm}: Escape reached the editor, which moved the selection from ${JSON.stringify(result.before)} to ${JSON.stringify(result.after)}`);
      }
    }
    await ctx.shot("207-workspace-editor", page);
    return results;
  } catch (error) {
    primary = error;
    await ctx.shot("207-workspace-editor-failure", page).catch(() => {});
    throw error;
  } finally {
    console.log(`[smoke]   workspace editor ${JSON.stringify(results)}`);
    await cleanUp(primary, [
      async () => { if (strip?.on) await writePaneStripPreference(page, token, true); },
      () => page.close(),
    ]);
  }
}

function terminalWindowUrl(origin, row) {
  const prefix = `/${row.prefix.replace(/^\/+|\/+$/g, "")}`;
  const url = new URL(`${prefix}/`, origin);
  url.searchParams.set("kind", "terminal");
  url.searchParams.set("w", row.window_id);
  url.searchParams.set("t", row.token);
  return url.toString();
}

/// Set the standalone tenant's engine through its own config route and read
/// it back.
async function writeTenantEngine(page, token, ghostty) {
  await page.evaluate(async ({ authToken, value }) => {
    const prefix = document.querySelector('meta[name="chan-prefix"]')?.getAttribute("content") ?? "";
    const headers = { "content-type": "application/json", authorization: `Bearer ${authToken}` };
    const got = await fetch(`${prefix}/api/config`, { headers });
    if (!got.ok) throw new Error(`GET /api/config -> ${got.status}`);
    const config = await got.json();
    const response = await fetch(`${prefix}/api/config`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        expected_revision: config.revision,
        preferences: { terminal: { ...config.preferences.terminal, ghostty: value } },
      }),
    });
    if (!response.ok) throw new Error(`PATCH /api/config -> ${response.status} ${await response.text()}`);
  }, { authToken: token, value: ghostty });
  await poll(`the standalone tenant's terminal.ghostty=${ghostty}`, () => page.evaluate(async ({ authToken, value }) => {
    const prefix = document.querySelector('meta[name="chan-prefix"]')?.getAttribute("content") ?? "";
    const response = await fetch(`${prefix}/api/config`, { headers: { authorization: `Bearer ${authToken}` } });
    if (!response.ok) throw new Error(`GET /api/config -> ${response.status}`);
    return (await response.json()).preferences.terminal?.ghostty === value;
  }, { authToken: token, value: ghostty }));
}

/// A throwaway devserver's terminal window: the body menu on each engine,
/// each in a terminal opened after the window reloads on that engine.
async function standaloneTerminals(ctx, dir, failures) {
  let chanHome = null;
  let devserver = null;
  let page = null;
  const results = [];
  try {
    chanHome = mkdtempSync(join(tmpdir(), "chan-menu-207-home-"));
    devserver = spawnDevserver(ctx.chanBin, chanHome, ["--no-tunnel"]);
    page = await ctx.browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.bringToFront();
    const launchUrl = await devserver.url;
    const origin = new URL(launchUrl).origin;
    const token = new URL(launchUrl).searchParams.get("t");
    if (!token) throw new Error("the devserver's launch URL has no management token");
    const row = await poll("the minted terminal window", async () =>
      (await fetchWindows(origin, token)).find((r) => r.kind === "terminal" && r.token) ?? null);
    const address = terminalWindowUrl(origin, row);
    for (const engine of ["xterm", "ghostty"]) {
      await goto(page, address);
      await page.waitForSelector(".pane .terminal-tab", { timeout: 30_000 });
      await writeTenantEngine(page, row.token, engine === "ghostty");
      await goto(page, address);
      await page.waitForSelector(".pane .terminal-tab", { timeout: 30_000 });
      await openTerminal(page, engine);
      results.push(...await terminalArms(page, dir, "standalone", engine, ["body"], failures));
    }
    await ctx.shot("207-standalone-terminal", page);
    return results;
  } catch (error) {
    if (page) await ctx.shot("207-standalone-terminal-failure", page).catch(() => {});
    throw error;
  } finally {
    console.log(`[smoke]   standalone terminals ${JSON.stringify(results)}`);
    if (page) await page.close().catch(() => {});
    if (devserver) await killChild(devserver.child);
    if (chanHome) rmSync(chanHome, { recursive: true, force: true });
  }
}

export default {
  name: "menu-escape",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid; the editor arm opens its file through it");
    const dir = mkdtempSync(join(tmpdir(), "chan-menu-207-"));
    const failures = [];
    try {
      const details = {
        workspace: await workspaceTerminals(ctx, dir, failures),
        editor: await workspaceEditor(ctx, failures),
        standalone: await standaloneTerminals(ctx, dir, failures),
      };
      if (failures.length) throw new Error(`${failures.length} arm(s) failed:\n  ${failures.join("\n  ")}`);
      return details;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
