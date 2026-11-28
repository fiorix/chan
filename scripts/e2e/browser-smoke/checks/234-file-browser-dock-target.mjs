// The dock hands its file commands to the focused pane's tab on close.
// A left dock holds a selected row beside a Files tab with a selected
// file; the dock's own menu row closes it; the launcher's Copy path copies
// the tab's selection, which the clipboard read proves by holding the tab's
// file, and leaves the keyboard inside the tab's tree.
// Closing by the menu row: the Hybrid Nav chord remounts the focused tab
// on its own, so it cannot go red here.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { navigateFiles, waitFileRow } from "../lib/files.mjs";
import { token } from "../lib/drafts.mjs";
import { poll } from "../lib/launcher-devserver.mjs";

const DOCK = 'aside[aria-label="left file browser"] .browser';
const LAUNCHER = '[role="dialog"][aria-label="Command launcher"]';
const LAUNCHER_INPUT = `${LAUNCHER} input[role="combobox"]`;

async function readDocks(page, authToken) {
  return page.evaluate(async (authToken) => {
    const prefix = document.querySelector('meta[name="chan-prefix"]')?.getAttribute("content") ?? "";
    const headers = authToken ? { authorization: `Bearer ${authToken}` } : {};
    const response = await fetch(`${prefix}/api/config`, { headers });
    if (!response.ok) throw new Error(`GET /api/config -> ${response.status}`);
    const config = await response.json();
    return { revision: config.revision, docks: config.preferences.browser_side_panes };
  }, authToken);
}

async function setDock(page, side, wanted, authToken) {
  const current = await readDocks(page, authToken);
  // Server-owned setup avoids an optimistic dock toggle racing a workspace
  // snapshot. The page learns the saved preference through its own refresh.
  await page.evaluate(async ({ authToken, current, side, wanted }) => {
    const prefix = document.querySelector('meta[name="chan-prefix"]')?.getAttribute("content") ?? "";
    const headers = { "content-type": "application/json" };
    if (authToken) headers.authorization = `Bearer ${authToken}`;
    const response = await fetch(`${prefix}/api/config`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        expected_revision: current.revision,
        preferences: { browser_side_panes: { ...current.docks, [side]: wanted } },
      }),
    });
    if (!response.ok) throw new Error(`PATCH /api/config -> ${response.status} ${await response.text()}`);
  }, { authToken, current, side, wanted });
  await poll(`${side} dock preference saved as ${wanted}`, async () =>
    (await readDocks(page, authToken)).docks[side] === wanted);
  const selector = `aside[aria-label="${side} file browser"]`;
  await page.waitForSelector(selector, wanted ? { visible: true } : { hidden: true });
}

function treeRow(root, path) {
  return `${DOCK} [role="treeitem"][title=${JSON.stringify(join(root, path))}]`;
}

async function expand(page, root, path) {
  // Walk each prefix: a nested row never appears until its parent opens.
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const row = treeRow(root, parts.slice(0, i).join("/"));
    await page.waitForSelector(row, { visible: true, timeout: 15_000 });
    if (await page.$eval(row, (node) => node.getAttribute("aria-expanded") === "true") !== true) {
      await page.click(`${row} .twirl`);
    }
    await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("aria-expanded") === "true",
      { timeout: 15_000 }, row);
  }
}

async function menuRow(page, title) {
  const found = await page.evaluateHandle((name) => [...document.querySelectorAll(".hamburger-menu button")].find(
    (candidate) => candidate.querySelector(".menu-row-label")?.textContent?.trim() === name) ?? null, title);
  const element = found.asElement();
  if (!element) throw new Error(`dock menu row ${JSON.stringify(title)} not found`);
  return element;
}

async function launcher(page, title) {
  await page.keyboard.down("Control");
  await page.keyboard.down("Alt");
  await page.keyboard.press("KeyK");
  await page.keyboard.up("Alt");
  await page.keyboard.up("Control");
  await page.waitForSelector(LAUNCHER_INPUT, { visible: true });
  await page.type(LAUNCHER_INPUT, title);
  await page.waitForFunction((dialog, wanted) =>
    [...document.querySelectorAll(`${dialog} [role="option"][aria-selected="true"] .deck-result-title`)]
      .some((row) => row.textContent?.trim() === wanted), { timeout: 15_000 }, LAUNCHER, title);
  await page.keyboard.press("Enter");
  await page.waitForSelector(LAUNCHER, { hidden: true });
}

export default {
  name: "file-browser-dock-target",
  async run(ctx) {
    const { page } = ctx;
    await page.bringToFront();
    const prefix = `details-dock-${Date.now()}`;
    const fixture = join(ctx.workspaceDir, prefix);
    mkdirSync(join(fixture, "docs"), { recursive: true });
    mkdirSync(join(fixture, "notes"), { recursive: true });
    writeFileSync(join(fixture, "docs", "a.md"), "dock file\n");
    writeFileSync(join(fixture, "notes", "b.md"), "tab file\n");
    const authToken = token(ctx);
    const { docks: originalDocks } = await readDocks(page, authToken);
    try {
      await setDock(page, "left", true, authToken);

      await navigateFiles(page, join(prefix, "notes"));
      const tabRow = await waitFileRow(page, "b.md", true, { timeout: 15_000 });
      if (!tabRow) throw new Error("file row b.md not found in the Files tab");
      await tabRow.click();
      await tabRow.dispose();
      await page.waitForFunction((wanted) => [...document.querySelectorAll('.browser:not(.dock) [role="option"]')].some(
        (row) => (row.getAttribute("title") ?? "").endsWith(wanted) && row.getAttribute("aria-selected") === "true",
      ), { timeout: 15_000 }, `${prefix}/notes/b.md`);

      await expand(page, ctx.workspaceDir, join(prefix, "docs"));
      const dockRow = treeRow(ctx.workspaceDir, join(prefix, "docs", "a.md"));
      await page.waitForSelector(`${dockRow} .row-icon`, { visible: true, timeout: 15_000 });
      await page.click(dockRow);
      await page.focus(`${DOCK} .tree`);
      await page.waitForFunction((wanted) => {
        const tree = document.querySelector('aside[aria-label="left file browser"] .browser .tree');
        const active = document.getElementById(tree?.getAttribute("aria-activedescendant") ?? "");
        return (active?.getAttribute("title") ?? "").endsWith(wanted);
      }, { timeout: 15_000 }, `${prefix}/docs/a.md`);

      await page.click(`${DOCK} .browser-toolbar button[aria-label="Menu"]`);
      await (await menuRow(page, "Left file browser dock")).click();
      await page.waitForSelector('aside[aria-label="left file browser"]', { hidden: true, timeout: 15_000 });

      await launcher(page, "Copy path");
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      if (!copied.endsWith(`${prefix}/notes/b.md`)) {
        throw new Error(`Copy path took ${JSON.stringify(copied.slice(-80))}, want the tab's b.md`);
      }
      const tree = await page.evaluate(() => {
        const active = document.activeElement;
        return active ? !!active.closest(".browser:not(.dock)") : false;
      });
      if (!tree) throw new Error("the keyboard is not inside the tab's tree");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      await setDock(page, "left", originalDocks.left === true, authToken);
    }
  },
};
