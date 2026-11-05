// The pane's right-click menu and the terminal's both reach the command
// launcher, in real Chrome with the browser's own right-click.
//
// An empty pane opens chan's menu in place of the browser's (the page takes
// the trusted contextmenu): Commands with the launcher's chord, then Reload
// with its chord, and no Open Inspector, which is the desktop's row only. The
// labels are this platform's, read once as Linux Chrome and once with a
// macOS user agent. The strip's empty stretch opens the same menu. With
// pane_strip_auto_hide on, a lone terminal on side A draws no strip; flipped
// to the empty side B, which draws none either, the body still opens the
// menu. Back on A, the terminal's own menu ends with Commands after a
// separator. Every Commands opens the launcher; Escape closes it and hands
// focus back to what was right-clicked when that takes focus: the empty
// pane's welcome, and the terminal.
//
// Each arm opens its own window. The preference is restored to what the
// check found, and the terminal it opened is closed.

import assert from "node:assert/strict";
import { armFlip, paneFlip } from "../lib/flip.mjs";
import {
  closeEveryTerminal,
  dispatchCommand,
  readPaneStripPreference,
  stripHidden,
  waitPaneStrip,
  writePaneStripPreference,
} from "../lib/pane-strip.mjs";

const RUN = Date.now().toString(36);
const LAUNCHER = '[role="dialog"][aria-label="Command launcher"]';
const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/// A page in the background gets no animation frames, which the app and the
/// waits here run on, so the page driven next is brought to the front.
async function openWindow(ctx, page, name) {
  await page.bringToFront();
  const url = new URL(ctx.serverUrl);
  url.searchParams.set("w", `ctx-menu-206-${name}-${RUN}`);
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".pane .editor-wrap", { timeout: 30_000 });
}

/// Right-click a point with the browser's pointer; returns whether the event
/// was the browser's and whether the page took it, read after its handlers.
async function rightClick(page, point) {
  await page.evaluate(() => {
    window.__contextMenu = null;
    window.addEventListener("contextmenu", (e) => {
      window.__contextMenu = { trusted: e.isTrusted, prevented: e.defaultPrevented };
    }, { once: true });
  });
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page.waitForFunction(() => window.__contextMenu !== null, { timeout: 10_000 });
  return page.evaluate(() => window.__contextMenu);
}

function centreOf(page, selector) {
  return page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

/// The pane menu's rows, label and chord, once it is up.
async function paneMenuRows(page) {
  await page.waitForSelector(".hamburger-menu button", { visible: true, timeout: 10_000 });
  return page.$$eval(".hamburger-menu button", (buttons) => buttons.map((b) => [
    b.querySelector(".menu-row-label")?.textContent?.trim() ?? "",
    b.querySelector(".menu-row-chord")?.textContent?.trim() ?? "",
  ]));
}

/// Click a menu row by its label with the pointer, open the launcher, then
/// close it with Escape; returns what holds focus after the close.
async function runCommands(page, rowSelector, labelSelector, label, arm) {
  const point = await page.evaluate(({ rowSelector, labelSelector, label }) => {
    const row = [...document.querySelectorAll(rowSelector)].find((b) => b.querySelector(labelSelector)?.textContent?.trim() === label);
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, { rowSelector, labelSelector, label });
  assert.ok(point, `${arm}: no ${label} row in the menu`);
  await page.mouse.click(point.x, point.y);
  await page.waitForSelector(LAUNCHER, { visible: true, timeout: 10_000 }).catch(async (cause) => {
    const state = await page.evaluate(() => ({
      menus: [...document.querySelectorAll(".hamburger-menu, .terminal-tab-menu-bubble")].map((m) => m.className),
      dialogs: [...document.querySelectorAll('[role="dialog"]')].map((d) => d.getAttribute("aria-label")),
      active: document.activeElement?.tagName + "." + document.activeElement?.className,
    }));
    throw new Error(`${arm}: the launcher did not open after Commands at ${JSON.stringify(point)}: ${JSON.stringify(state)}`, { cause });
  });
  const menuGone = await page.evaluate(() => !document.querySelector(".hamburger-menu, .terminal-tab-menu-bubble"));
  assert.ok(menuGone, "the menu closed when Commands ran");
  const opened = await page.evaluate(() => document.activeElement?.tagName + "." + document.activeElement?.className);
  await page.keyboard.press("Escape");
  await page.waitForSelector(LAUNCHER, { hidden: true, timeout: 10_000 }).catch(async (cause) => {
    const active = await page.evaluate(() => document.activeElement?.tagName + "." + document.activeElement?.className);
    throw new Error(`${arm}: Escape left the launcher open; focus was on ${opened} as it opened and is on ${active}`, { cause });
  });
  return page.evaluate(() => {
    const el = document.activeElement;
    return {
      welcome: Boolean(el?.closest(".welcome")),
      terminal: Boolean(el?.closest(".terminal-tab")),
      tag: el?.tagName ?? null,
      className: el?.className?.toString?.() ?? null,
    };
  });
}

export default {
  name: "pane-context-commands",
  async run(ctx) {
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const page = await ctx.browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const macPage = await ctx.browser.newPage();
    await macPage.setUserAgent(MAC_UA);
    await macPage.setViewport({ width: 1280, height: 800 });
    const details = {};
    let original = null;
    let terminalOpened = false;
    try {
      await openWindow(ctx, page, "empty");
      original = await readPaneStripPreference(page, token);
      if (original.on) await writePaneStripPreference(page, token, false);

      // An empty pane with its strip drawn: its body and the strip's empty
      // stretch both open chan's menu.
      await page.waitForSelector(".pane .welcome", { timeout: 15_000 });
      details.emptyBody = await rightClick(page, await centreOf(page, ".pane .editor-wrap"));
      details.emptyRows = await paneMenuRows(page);
      assert.deepEqual(details.emptyBody, { trusted: true, prevented: true }, `the page takes the right-click: ${JSON.stringify(details.emptyBody)}`);
      assert.deepEqual(details.emptyRows, [["Commands", "Ctrl+Alt+K"], ["Reload", "Ctrl+Shift+R"]], `Linux Chrome rows: ${JSON.stringify(details.emptyRows)}`);
      await ctx.shot("206-empty-menu", page);
      details.emptyFocus = await runCommands(page, ".hamburger-menu button", ".menu-row-label", "Commands", "empty pane");
      assert.ok(details.emptyFocus.welcome, `focus returned to the welcome: ${JSON.stringify(details.emptyFocus)}`);

      details.stripStretch = await rightClick(page, await centreOf(page, ".pane .tabs .dead-zone"));
      details.stripRows = await paneMenuRows(page);
      assert.ok(details.stripStretch.prevented, `the strip's empty stretch takes the right-click: ${JSON.stringify(details.stripStretch)}`);
      assert.deepEqual(details.stripRows, details.emptyRows, "the strip's stretch opens the same menu");
      await page.keyboard.press("Escape");
      await page.waitForSelector(".hamburger-menu", { hidden: true, timeout: 10_000 });

      // The same menu as macOS Chrome labels it: the launcher keeps the web
      // chord, Reload takes Cmd.
      await openWindow(ctx, macPage, "mac");
      details.macRows = await (async () => {
        await rightClick(macPage, await centreOf(macPage, ".pane .editor-wrap"));
        return paneMenuRows(macPage);
      })();
      assert.deepEqual(details.macRows, [["Commands", "Ctrl+Alt+K"], ["Reload", "Cmd+R"]], `macOS Chrome rows: ${JSON.stringify(details.macRows)}`);
      await macPage.keyboard.press("Escape");

      // Auto-hide on: a lone terminal on A, then the empty side B, neither
      // with a strip.
      await openWindow(ctx, page, "sides");
      await writePaneStripPreference(page, token, true);
      await dispatchCommand(page, "app.terminal.toggle");
      terminalOpened = true;
      await waitPaneStrip(page, "a lone terminal on A", (s) => s.side === "A" && s.terminals === 1 && stripHidden(s));
      // The terminal's renderer, whichever engine draws it, is up.
      await page.waitForSelector(".pane .terminal-tab.active .terminal-host > *", { timeout: 30_000 });
      const paneId = await page.$eval(".pane", (pane) => pane.getAttribute("data-pane-id"));
      const toB = await armFlip(page, paneFlip(paneId));
      await dispatchCommand(page, "app.pane.flip");
      await toB.settled("flip to B");
      await toB.assertSettled("flip to B");
      details.sideB = await waitPaneStrip(page, "the empty side B", (s) => s.side === "B" && s.tabs.length === 0 && stripHidden(s));
      details.sideBBody = await rightClick(page, await centreOf(page, ".pane .editor-wrap"));
      details.sideBRows = await paneMenuRows(page);
      assert.ok(details.sideBBody.prevented, `side B's body takes the right-click: ${JSON.stringify(details.sideBBody)}`);
      assert.deepEqual(details.sideBRows, details.emptyRows, `side B's rows: ${JSON.stringify(details.sideBRows)}`);
      await ctx.shot("206-side-b-menu", page);
      await runCommands(page, ".hamburger-menu button", ".menu-row-label", "Commands", "side B");

      // Back on A, the terminal's own menu ends with Commands.
      const toA = await armFlip(page, paneFlip(paneId));
      await dispatchCommand(page, "app.pane.flip");
      await toA.settled("flip to A");
      await toA.assertSettled("flip to A");
      await waitPaneStrip(page, "the terminal on A", (s) => s.side === "A" && s.tabs.length === 1);
      details.terminalBody = await rightClick(page, await centreOf(page, ".pane .terminal-tab.active"));
      await page.waitForSelector('.terminal-tab-menu-bubble[role="menu"]', { visible: true, timeout: 10_000 });
      details.terminalRows = await page.$$eval('.terminal-tab-menu-bubble[role="menu"] .msep, .terminal-tab-menu-bubble[role="menu"] button.mbtn', (rows) =>
        rows.map((row) => row.classList.contains("msep") ? ["---", ""] : [
          row.querySelector(".mbtn-label")?.textContent?.trim() ?? "",
          row.querySelector(".mbtn-chord")?.textContent?.trim() ?? "",
        ]));
      assert.ok(details.terminalBody.prevented, `the terminal takes its right-click: ${JSON.stringify(details.terminalBody)}`);
      assert.deepEqual(details.terminalRows.slice(-2), [["---", ""], ["Commands", "Ctrl+Alt+K"]], `the terminal menu ends with Commands: ${JSON.stringify(details.terminalRows)}`);
      await ctx.shot("206-terminal-menu", page);
      details.terminalFocus = await runCommands(page, '.terminal-tab-menu-bubble button.mbtn', ".mbtn-label", "Commands", "terminal");
      assert.ok(details.terminalFocus.terminal, `focus returned to the terminal: ${JSON.stringify(details.terminalFocus)}`);

      console.log(`[smoke]   ${JSON.stringify(details)}`);
      return details;
    } finally {
      try {
        if (terminalOpened) await closeEveryTerminal(page, "cleanup");
      } finally {
        try {
          if (original) await writePaneStripPreference(page, token, original.on);
        } finally {
          await macPage.close().catch(() => {});
          await page.close().catch(() => {});
        }
      }
    }
  },
};
