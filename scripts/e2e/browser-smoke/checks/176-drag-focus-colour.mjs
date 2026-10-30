// Drag-and-drop highlights and resize bars wear the window's focus colour.
//
// Two panes of one window. For no colour chosen and for each of the four
// presets, in the dark and the light scheme, the check drives the app's own
// handlers and reads the painted colours: a tab dragged from the left pane
// over the right pane's tab strip (the strip's inset ring and the insertion
// marker) and over the right pane's body edge (the edge-split overlay); the
// floating Outline card's resize bar on hover and on keyboard focus; the
// docked file browser's resize handle on hover and at rest. With no colour
// chosen each reads the scheme's accent; with a preset chosen, the preset's
// colour.
// After a reload with orange chosen, the panes and the docked handle read
// orange from the window's restored preset.
//
// The scheme follows the system choice, which the check emulates, so no
// preference is written for it. The docked file browser is a server
// preference: the check restores the value it found and waits until the
// server holds it, since the page writes it after the dock leaves the DOM and
// a page closed first can drop the write; a later check that finds the dock
// open opens no File Browser tab.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { request, waitFor } from "../lib/drafts.mjs";

const WINDOW = "focus-colour-176";
const FILES = ["focus-colour-a.md", "focus-colour-b.md", "focus-colour-c.md"];

// The focus colour presets (`NAMED_PANE_HEX` in `state/paneColor.ts`) and the
// scheme accents (`--pane-focus` in `App.svelte`).
const PRESETS = {
  blue: "rgb(56, 139, 253)",
  orange: "rgb(249, 115, 22)",
  green: "rgb(34, 197, 94)",
  pink: "rgb(255, 95, 183)",
};
const SCHEME_ACCENT = { dark: "rgb(56, 139, 253)", light: "rgb(122, 166, 224)" };
const TRANSPARENT = "rgba(0, 0, 0, 0)";

function layoutHash() {
  const tab = (p, extra = {}) => ({ p, m: "wysiwyg", ...extra });
  return "s=" + encodeURIComponent(JSON.stringify({
    k: "s", d: "r",
    a: { k: "l", f: 1, t: [tab(FILES[0], { a: 1, ol: 1, ow: 240 }), tab(FILES[1])] },
    b: { k: "l", t: [tab(FILES[2], { a: 1 })] },
  }));
}

/// Whether the left dock is open, by the server's preference and in the page.
async function leftDock(ctx, page) {
  const config = await request(ctx, "/api/config");
  if (config.status !== 200) throw new Error(`GET /api/config -> ${config.status}`);
  return {
    saved: config.json?.preferences?.browser_side_panes?.left === true,
    shown: (await page.$(".browser-side-pane.left")) !== null,
  };
}

const LAUNCHER_INPUT = '[role="dialog"][aria-label="Command launcher"] input[role="combobox"]';

/// A command the launcher lists, run from the launcher as a person runs it:
/// the window's `chan:command` event reaches only the commands App.svelte
/// dispatches by name.
async function launcherCommand(page, title) {
  await page.click(".pane .hamburger-trigger");
  await page.waitForSelector(".hamburger-menu", { visible: true });
  const opened = await page.evaluate(() => {
    const button = [...document.querySelectorAll(".hamburger-menu button")]
      .find((b) => b.querySelector(".menu-row-label")?.textContent?.trim() === "Commands");
    button?.click();
    return Boolean(button);
  });
  assert.ok(opened, "the pane menu has a Commands row");
  const input = await page.waitForSelector(LAUNCHER_INPUT, { visible: true });
  await input.click({ count: 3 });
  await page.keyboard.type(title);
  await page.waitForFunction((title) => [...document.querySelectorAll('[role="option"] .deck-result-title')]
    .some((n) => n.textContent?.trim() === title), { timeout: 10_000 }, title);
  await page.evaluate((title) => [...document.querySelectorAll('[role="option"] .deck-result-title')]
    .find((n) => n.textContent?.trim() === title)?.closest('[role="option"]')?.click(), title);
  await page.waitForSelector(LAUNCHER_INPUT, { hidden: true, timeout: 10_000 });
}

/// The pane menu's focus border colour row.
async function chooseColour(page, color) {
  await page.click(".pane .hamburger-trigger");
  await page.waitForSelector(`.hamburger-menu .color-dot.${color}`, { visible: true });
  await page.$eval(`.hamburger-menu .color-dot.${color}`, (dot) => dot.closest("button").click());
  await page.waitForFunction((color) => document.querySelector(".pane")?.dataset.focusColor === color &&
    !document.querySelector(".hamburger-menu"), { timeout: 10_000 }, color);
}

/// The element's computed property once its running transitions end, so a
/// colour read is the end state and not a step of the 100 ms fade the handle
/// and the strip carry.
async function style(page, selector, property) {
  return page.$eval(selector, async (el, property) => {
    await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => {})));
    return getComputedStyle(el)[property];
  }, property);
}

/// The app's real dragstart on the left pane's active tab, then a dragover on
/// the right pane's first tab and one at its body's left edge.
async function tabDragReadings(page) {
  await page.evaluate(() => {
    const [a, b] = document.querySelectorAll(".pane");
    const dt = new DataTransfer();
    window.__focusColourDrag = dt;
    const fire = (el, type, x, y) => el.dispatchEvent(new DragEvent(type, {
      bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y,
    }));
    fire(a.querySelector(".tabs .tab.active"), "dragstart", 0, 0);
    const tab = b.querySelector(".tabs .tab");
    const r = tab.getBoundingClientRect();
    fire(tab, "dragover", r.left + 2, r.top + r.height / 2);
  });
  await page.waitForFunction(() => {
    const b = document.querySelectorAll(".pane")[1];
    return b.querySelector(".tabs.drop-active") && b.querySelector(".drop-bar");
  }, { timeout: 10_000 });
  const strip = await page.evaluate(async () => {
    const b = document.querySelectorAll(".pane")[1];
    const tabs = b.querySelector(".tabs");
    await Promise.all(tabs.getAnimations().map((a) => a.finished.catch(() => {})));
    return { stripShadow: getComputedStyle(tabs).boxShadow, marker: getComputedStyle(b.querySelector(".drop-bar")).backgroundColor };
  });
  await page.evaluate(() => {
    const b = document.querySelectorAll(".pane")[1];
    const dt = window.__focusColourDrag;
    b.querySelector(".tabs").dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true, dataTransfer: dt }));
    const wrap = b.querySelector(".editor-wrap");
    const r = wrap.getBoundingClientRect();
    wrap.dispatchEvent(new DragEvent("dragover", {
      bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 3, clientY: r.top + r.height / 2,
    }));
  });
  await page.waitForFunction(() => document.querySelectorAll(".pane")[1].querySelector(".editor-wrap.body-drop-left"), { timeout: 10_000 });
  const edge = await page.evaluate(() => {
    const wrap = document.querySelectorAll(".pane")[1].querySelector(".editor-wrap");
    return getComputedStyle(wrap, "::after").borderLeftColor;
  });
  // End the drag where it started, with no drop effect, so the source keeps
  // its tab.
  await page.evaluate(() => {
    const [a, b] = document.querySelectorAll(".pane");
    const dt = window.__focusColourDrag;
    dt.dropEffect = "none";
    b.querySelector(".editor-wrap").dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true, dataTransfer: dt }));
    a.querySelector(".tabs .tab.active").dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: dt }));
    delete window.__focusColourDrag;
  });
  await page.waitForFunction(() => !document.querySelector(".tabs.drop-active, .drop-bar, .editor-wrap[class*=body-drop-]"), { timeout: 10_000 });
  assert.equal(await page.evaluate(() => document.querySelectorAll(".pane")[0].querySelectorAll(".tabs .tab").length), 2,
    "the drag left the source's tabs in place");
  return { ...strip, edge };
}

async function resizeBarReadings(page) {
  const bar = '[aria-label="Resize Outline"]';
  await page.hover(bar);
  const hover = await style(page, bar, "backgroundColor");
  await page.mouse.move(5, 5);
  await page.focus(bar);
  await page.keyboard.press("Shift");
  assert.ok(await page.$eval(bar, (el) => el.matches(":focus-visible")), "the bar takes keyboard focus");
  const focus = await style(page, bar, "backgroundColor");
  await page.$eval(bar, (el) => el.blur());
  const rest = await style(page, bar, "backgroundColor");
  return { hover, focus, rest };
}

async function dockReadings(page) {
  const handle = ".browser-side-pane.left .handle";
  await page.hover(handle);
  const hover = await style(page, handle, "backgroundColor");
  await page.mouse.move(700, 450);
  const rest = await style(page, handle, "backgroundColor");
  return { hover, rest };
}

async function arm(page, label, expected) {
  const drag = await tabDragReadings(page);
  const bars = await resizeBarReadings(page);
  const dock = await dockReadings(page);
  const reading = { label, expected, drag, bars, dock };
  const fail = (what, got) => `${label}: ${what} reads ${got}, expected ${expected}`;
  assert.ok(drag.stripShadow.includes(expected), fail("the tab strip under a dragged tab", drag.stripShadow));
  assert.equal(drag.marker, expected, fail("the insertion marker", drag.marker));
  assert.equal(drag.edge, expected, fail("the edge-split overlay", drag.edge));
  assert.equal(bars.hover, expected, fail("the Outline card's resize bar on hover", bars.hover));
  assert.equal(bars.focus, expected, fail("the Outline card's resize bar on keyboard focus", bars.focus));
  assert.equal(bars.rest, TRANSPARENT, fail("the Outline card's resize bar at rest", bars.rest));
  assert.equal(dock.hover, expected, fail("the docked handle on hover", dock.hover));
  assert.equal(dock.rest, TRANSPARENT, fail("the docked handle at rest", dock.rest));
  return reading;
}

async function scheme(page, name) {
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: name }]);
  await page.waitForFunction((name) => document.documentElement.dataset.theme === name, { timeout: 10_000 }, name)
    .catch(() => { throw new Error(`the page did not follow the ${name} system scheme; is the stored theme choice "system"?`); });
}

export default {
  name: "drag-focus-colour",
  async run(ctx) {
    for (const f of FILES) writeFileSync(join(ctx.workspaceDir, f), `# ${f}\n\n${"A line of text.\n\n".repeat(8)}`);
    const page = await ctx.browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const url = new URL(ctx.serverUrl);
    url.searchParams.set("w", WINDOW);
    url.hash = layoutHash();
    const details = { arms: [] };
    let dockFound = null;
    let failed = false;
    try {
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
      await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForFunction(() => document.querySelectorAll(".pane").length === 2 &&
        document.querySelector('[aria-label="Resize Outline"]'), { timeout: 30_000 });
      const found = await leftDock(ctx, page);
      assert.equal(found.shown, found.saved, "the page shows the dock the server holds");
      dockFound = found.saved;
      if (!dockFound) {
        await launcherCommand(page, "Toggle left file browser dock");
        await page.waitForSelector(".browser-side-pane.left .handle", { timeout: 10_000 });
        await waitFor("the left dock saved open", 15_000, async () => (await leftDock(ctx, page)).saved);
      }
      assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue("--pane-highlight-color")), "",
        "a fresh window carries no chosen colour");
      for (const name of ["dark", "light"]) {
        await scheme(page, name);
        details.arms.push(await arm(page, `no colour chosen, ${name}`, SCHEME_ACCENT[name]));
      }
      for (const [color, expected] of Object.entries(PRESETS)) {
        await chooseColour(page, color);
        for (const name of ["dark", "light"]) {
          await scheme(page, name);
          details.arms.push(await arm(page, `${color}, ${name}`, expected));
        }
      }
      await ctx.shot("176-orange-last-arm", page);
      // After a reload the window restores its preset from its session, and a
      // standalone server re-applies no chosen colour to the document root:
      // the panes and the docked handle read the preset, the handle from the
      // app root's.
      await chooseColour(page, "orange");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelectorAll(".pane").length === 2 &&
        document.querySelector(".browser-side-pane.left .handle"), { timeout: 30_000 });
      details.afterReload = {
        rootColour: await page.evaluate(() => document.documentElement.style.getPropertyValue("--pane-highlight-color")),
        paneFocusColor: await page.$eval(".pane", (el) => el.dataset.focusColor),
        drag: await tabDragReadings(page),
        dock: await dockReadings(page),
      };
      console.log(`[smoke]   after reload: ${JSON.stringify(details.afterReload)}`);
      const orange = PRESETS.orange;
      assert.equal(details.afterReload.paneFocusColor, "orange", "the reloaded window restored its preset");
      assert.ok(details.afterReload.drag.stripShadow.includes(orange), `after a reload the tab strip under a dragged tab reads ${details.afterReload.drag.stripShadow}, expected ${orange}`);
      assert.equal(details.afterReload.dock.hover, orange, `after a reload the docked handle on hover reads ${details.afterReload.dock.hover}, expected ${orange}`);
      return details;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        if (dockFound === false) {
          if ((await leftDock(ctx, page)).shown) await launcherCommand(page, "Toggle left file browser dock");
          await waitFor("the left dock closed in the page and saved closed", 15_000, async () => {
            const dock = await leftDock(ctx, page);
            return !dock.saved && !dock.shown;
          });
        }
      } catch (error) {
        // A failed restore fails the check, unless the check has already failed,
        // whose error is the one reported.
        if (!failed) throw error;
        console.log(`[smoke]   the left dock was not restored: ${error.message}`);
      } finally {
        await page.close().catch(() => {});
      }
    }
  },
};
