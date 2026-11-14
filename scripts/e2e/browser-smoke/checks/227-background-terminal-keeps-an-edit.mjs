// A ghostty terminal that opens in a pane that is not the focused one moves
// no focus. A window holds a CSV file in its focused pane and a ghostty
// terminal in the other, and is saved so; a new page opens the window by its
// id alone, so it comes back from its session with the terminal reattaching
// in the background pane, as at a reload. The page's fetch of the terminal
// core is held until one of the CSV's cells is being edited, then released:
// the terminal opens while the edit holds the keyboard. The cell's input
// records every blur and the page every focus change; the edit has to stay
// open with its draft, hold the keyboard, see no blur and take the next key.
// A CSV cell commits and closes its edit on blur, so a terminal that took the
// keyboard even for a moment ends it. Last, a terminal opened in the focused
// pane takes the keyboard. (`cs terminal new` makes the pane it opens in the
// focused one, so it is the restore that opens a terminal in the background.)

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTerminalPrefs, writeTerminalPrefs } from "../lib/terminal-prefs.mjs";
import { windowSessions } from "../lib/pane-strip.mjs";

const RUN = Date.now().toString(36);
const WINDOW = `ghostty-open-227-${RUN}`;
const CSV = `ghostty-open-227-${RUN}.csv`;
const CELL = 'button.cell[data-cell="1:0"]';
const EDIT = ".csv-table td input";
const CANVAS = ".terminal-tab .terminal-host canvas";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rendered(value) {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return value == null ? "" : String(value);
}

function cs(ctx, args) {
  return ctx.exec(ctx.chanBin, ["shell", ...args], {
    cwd: ctx.workspaceDir,
    env: {
      ...process.env,
      CHAN_CONTROL_SOCKET: ctx.controlSocket,
      CHAN_WINDOW_ID: WINDOW,
      CHAN_WORKSPACE_PATH: ctx.workspaceDir,
    },
    timeout: 90_000,
  });
}

async function paneList(ctx) {
  const { stdout } = await cs(ctx, ["pane", "list", "--window", WINDOW, "--json"]);
  return JSON.parse(rendered(stdout));
}

async function layoutSettled(ctx, accept, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await paneList(ctx).catch((error) => ({ error: error?.message ?? String(error) }));
    if (!last.error && accept(last)) return last;
    await sleep(200);
  }
  throw new Error(`${label}: not reached within ${timeout}ms; the window reads ${JSON.stringify(last)}`);
}

/// The window's saved layout, read from the server.
async function savedLayout(ctx) {
  const url = new URL("/api/session", ctx.serverUrl);
  url.search = "";
  url.searchParams.set("w", WINDOW);
  const token = new URL(ctx.serverUrl).searchParams.get("t");
  const response = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`GET /api/session: ${response.status}`);
  return (await response.json()).layout ?? null;
}

function focusedLeaf(node) {
  if (!node) return null;
  if (node.k === "s") return focusedLeaf(node.a) ?? focusedLeaf(node.b);
  return node.f ? node : null;
}

/// Where the keyboard is: the terminal (host or textarea), the cell's edit,
/// a cell's button, or another element.
function focusOf(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (el?.closest?.(".terminal-tab")) return el.tagName === "TEXTAREA" ? "terminal-textarea" : "terminal";
    if (el?.matches?.(".csv-table td input")) return "cell-edit";
    if (el?.matches?.(".csv-table button.cell")) return `cell-${el.getAttribute("data-cell")}`;
    return `${el?.tagName ?? "none"}.${el?.className?.toString?.() ?? ""}`;
  });
}

async function focusSettled(page, accept, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  let focus = await focusOf(page);
  while (!accept(focus) && Date.now() < deadline) {
    await sleep(50);
    focus = await focusOf(page);
  }
  return focus;
}

async function windowPage(ctx, holdCore = null) {
  const page = await ctx.browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.bringToFront();
  if (holdCore) {
    // Only the terminal core's fetch waits; every other request goes on.
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.isInterceptResolutionHandled()) return;
      if (new URL(request.url()).pathname.endsWith(".wasm")) holdCore.push(request);
      else void request.continue();
    });
  }
  const url = new URL(ctx.serverUrl);
  url.searchParams.set("w", WINDOW);
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  return page;
}

/// The window laid out and saved: the CSV in the focused pane, a ghostty
/// terminal in the other.
async function layOut(ctx, page, terminals) {
  await page.waitForSelector(".pane .editor-wrap", { timeout: 30_000 });
  await ctx.waitWindowLive(WINDOW);
  await cs(ctx, ["open", CSV, "--window", WINDOW]);
  await page.waitForSelector(`.pane ${CELL}`, { visible: true, timeout: 20_000 });
  const csvPane = (await layoutSettled(ctx, (value) => value.panes.length === 1, "the CSV's window")).panes[0].id;
  await cs(ctx, ["pane", "new", "right", "--window", WINDOW, "--pane", csvPane]);
  const two = await layoutSettled(ctx, (value) => value.panes.length === 2, "the split");
  const terminalPane = two.panes.find((pane) => pane.id !== csvPane).id;
  const name = `ghostty-open-227-bg-${RUN}`;
  terminals.push(name);
  await cs(ctx, ["terminal", "new", "--tab-name", name, "--window", WINDOW, "--pane", terminalPane]);
  await page.waitForSelector(`.pane[data-pane-id="${terminalPane}"] ${CANVAS}`, { visible: true, timeout: 30_000 });
  await page.click(`.pane[data-pane-id="${csvPane}"] ${CELL}`);
  await page.waitForSelector(EDIT, { visible: true, timeout: 10_000 });
  await page.keyboard.press("Escape");
  await layoutSettled(ctx, (value) => value.activePaneId === csvPane, "the CSV's pane focused");
  const deadline = Date.now() + 15_000;
  let leaf = null;
  while (Date.now() < deadline) {
    leaf = focusedLeaf(await savedLayout(ctx));
    if ((leaf?.t ?? []).some((tab) => tab.p === CSV)) break;
    await sleep(200);
  }
  if (!(leaf?.t ?? []).some((tab) => tab.p === CSV)) {
    throw new Error(`the saved session never focused the CSV's pane: ${JSON.stringify(leaf)}`);
  }
  return { csvPane, terminalPane };
}

/// Mark the cell's input and record, from here on, every blur it sees and
/// every element the page focuses, with the time since the mark.
function recordFocus(page) {
  return page.evaluate((selector) => {
    const input = document.querySelector(selector);
    if (!input) return false;
    const started = performance.now();
    const ms = () => Math.round(performance.now() - started);
    const describe = (el) => {
      if (!(el instanceof Element)) return String(el);
      if (el.closest(".terminal-tab")) return `terminal ${el.tagName}`;
      return `${el.tagName}.${el.className?.toString?.() ?? ""}`;
    };
    const record = { blurs: [], focusins: [] };
    input.setAttribute("data-smoke-227", "edit");
    input.addEventListener("blur", () => record.blurs.push({ ms: ms() }));
    document.addEventListener("focusin", (e) => record.focusins.push({ ms: ms(), to: describe(e.target) }), true);
    window.__smoke227 = record;
    return true;
  }, EDIT);
}

/// The window opened again by its id, the terminal held at its core's fetch
/// while a cell is edited, then let open.
async function restoreArm(ctx, saved, adopt) {
  const arm = "restore";
  const held = [];
  const page = await windowPage(ctx, held);
  adopt(page);
  await page.waitForSelector(`.pane ${CELL}`, { visible: true, timeout: 30_000 });
  await page.waitForSelector(".pane .terminal-tab", { timeout: 30_000 });
  const deadline = Date.now() + 15_000;
  while (held.length === 0 && Date.now() < deadline) await sleep(50);
  const heldCore = held.length;
  await ctx.waitWindowLive(WINDOW);
  const before = await paneList(ctx);
  const ids = await page.evaluate(() => ({
    csvPane: document.querySelector(".pane:has(.csv-table)")?.getAttribute("data-pane-id") ?? null,
    terminalPane: document.querySelector(".pane:has(.terminal-tab)")?.getAttribute("data-pane-id") ?? null,
  }));
  // A restore numbers its panes afresh.
  if (!ids.csvPane || !ids.terminalPane || ids.csvPane === ids.terminalPane) {
    throw new Error(`${arm}: the window came back without its two panes: ${JSON.stringify({ saved, restored: ids })}`);
  }
  const { csvPane, terminalPane } = ids;
  await page.click(`.pane[data-pane-id="${csvPane}"] ${CELL}`);
  await page.waitForSelector(EDIT, { visible: true, timeout: 10_000 });
  const startFocus = await focusSettled(page, (holder) => holder === "cell-edit");
  await page.keyboard.press("End");
  await page.keyboard.type("-edit");
  const canvasBefore = Boolean(await page.$(`.pane[data-pane-id="${terminalPane}"] ${CANVAS}`));
  if (!(await recordFocus(page))) throw new Error(`${arm}: the cell's edit is not open`);

  for (const request of held.splice(0)) await request.continue();
  await page.waitForSelector(`.pane[data-pane-id="${terminalPane}"] ${CANVAS}`, { visible: true, timeout: 30_000 });
  // Past the terminal's open, its attach and any zero-delay focus retry.
  await sleep(1_500);
  const after = await paneList(ctx);
  const read = await page.evaluate(() => {
    const input = document.querySelector('[data-smoke-227="edit"]');
    return {
      open: Boolean(input?.isConnected),
      holds: document.activeElement === input,
      value: input?.value ?? null,
      ...window.__smoke227,
    };
  });
  const focus = await focusOf(page);
  if (read.holds) await page.keyboard.type("!");
  const typed = await page.evaluate(() => document.querySelector('[data-smoke-227="edit"]')?.value ?? null);
  return {
    arm,
    heldCore,
    canvasBefore,
    startFocus,
    activeBefore: before.activePaneId,
    activeAfter: after.activePaneId,
    focus,
    typed,
    ...read,
    csvPane,
    page,
  };
}

function checkRestore(result, csvPane, failures) {
  const { arm } = result;
  if (result.heldCore === 0 || result.canvasBefore) failures.push(`${arm}: the terminal opened before the edit (held ${result.heldCore}, canvas ${result.canvasBefore})`);
  if (result.startFocus !== "cell-edit") failures.push(`${arm}: the cell's edit did not take the keyboard (${result.startFocus})`);
  if (result.activeBefore !== csvPane || result.activeAfter !== csvPane) {
    failures.push(`${arm}: the CSV's pane was not the focused one throughout (${result.activeBefore} -> ${result.activeAfter})`);
  }
  if (!result.open) failures.push(`${arm}: the cell's edit closed`);
  if (result.blurs?.length) failures.push(`${arm}: the cell's edit saw ${result.blurs.length} blur(s): ${JSON.stringify(result.focusins)}`);
  if (!result.holds) failures.push(`${arm}: the keyboard went to ${result.focus}`);
  if (result.value !== "figs-edit") failures.push(`${arm}: the draft read ${JSON.stringify(result.value)}`);
  if (result.typed !== "figs-edit!") failures.push(`${arm}: the next key left the draft ${JSON.stringify(result.typed)}`);
}

/// A terminal opened in the focused pane takes the keyboard from the cell.
async function focusedArm(ctx, page, csvPane, terminals) {
  const arm = "focused";
  await page.click(`.pane[data-pane-id="${csvPane}"] ${CELL}`);
  await page.waitForSelector(EDIT, { visible: true, timeout: 10_000 });
  await page.keyboard.press("Escape");
  const startFocus = await focusSettled(page, (holder) => holder.startsWith("cell-"));
  const name = `ghostty-open-227-fg-${RUN}`;
  terminals.push(name);
  await cs(ctx, ["terminal", "new", "--tab-name", name, "--window", WINDOW, "--pane", csvPane]);
  await page.waitForSelector(`.pane[data-pane-id="${csvPane}"] .terminal-tab.active .terminal-host canvas`, {
    visible: true,
    timeout: 30_000,
  });
  const focus = await focusSettled(page, (holder) => holder.startsWith("terminal"));
  const after = await paneList(ctx);
  return { arm, startFocus, activeAfter: after.activePaneId, focus };
}

export default {
  name: "background-terminal-keeps-an-edit",
  async run(ctx) {
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const file = join(ctx.workspaceDir, CSV);
    writeFileSync(file, "name,count\nfigs,1\nplums,2\n");
    const failures = [];
    const results = [];
    const terminals = [];
    let page = await windowPage(ctx);
    let originalPrefs = null;
    let primary = null;
    try {
      originalPrefs = await readTerminalPrefs(page, token);
      await writeTerminalPrefs(page, token, { ghostty: true });
      const panes = await layOut(ctx, page, terminals);
      // The new page loads the window only once the old one is gone, so the
      // window comes back from its session rather than joining the open page.
      const old = page;
      await old.close();
      const restore = await restoreArm(ctx, panes, (reopened) => { page = reopened; });
      const { page: _page, ...reading } = restore;
      results.push(reading);
      checkRestore(reading, restore.csvPane, failures);
      await ctx.shot("227-restore", page);
      await page.keyboard.press("Escape");

      const focused = await focusedArm(ctx, page, restore.csvPane, terminals);
      results.push(focused);
      if (!focused.startFocus.startsWith("cell-")) failures.push(`focused: the cell did not hold the keyboard first (${focused.startFocus})`);
      if (focused.activeAfter !== restore.csvPane) failures.push(`focused: the focused pane moved to ${focused.activeAfter}`);
      if (!focused.focus.startsWith("terminal")) failures.push(`focused: the terminal in the focused pane left the keyboard on ${focused.focus}`);
      if (failures.length) throw new Error(`${failures.length} assertion(s) failed:\n  ${failures.join("\n  ")}`);
      return results;
    } catch (error) {
      primary = error;
      await ctx.shot("227-failure", page).catch(() => {});
      throw error;
    } finally {
      console.log(`[smoke]   background open ${JSON.stringify(results)}`);
      for (const name of terminals) {
        await cs(ctx, ["terminal", "close", "--tab-name", name]).catch((error) => {
          console.log(`[smoke]   closing ${name} failed: ${error?.message ?? error}`);
        });
      }
      try {
        const deadline = Date.now() + 10_000;
        while ((await windowSessions(page, token)).length > 0 && Date.now() < deadline) await sleep(200);
      } catch (error) {
        console.log(`[smoke]   reading the window's sessions failed: ${error?.message ?? error}`);
      }
      try { if (originalPrefs) await writeTerminalPrefs(page, token, { ghostty: originalPrefs.ghostty }); }
      catch (error) { if (primary) console.log(`[smoke]   terminal preference cleanup also failed: ${error?.message ?? error}`); else primary = error; }
      await page.close().catch(() => {});
      const url = new URL("/api/session", ctx.serverUrl);
      url.search = "";
      url.searchParams.set("w", WINDOW);
      await fetch(url, { method: "DELETE", headers: token ? { authorization: `Bearer ${token}` } : {} }).catch(() => {});
      rmSync(file, { force: true });
      if (primary) throw primary;
    }
  },
};
