// The Workspace details command clears the tab that shows the details, not the focused dock.
// A dock holds a selected row beside a Files tab with a selected file; the
// launcher's Workspace details runs; the tab's inspector shows the workspace
// body while the dock keeps its selection and the tab's own selection is gone.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { navigateFiles, waitFileRow } from "../lib/files.mjs";
import { token } from "../lib/drafts.mjs";
import { poll } from "../lib/launcher-devserver.mjs";

const LAUNCHER = '[role="dialog"][aria-label="Command launcher"]';
const LAUNCHER_INPUT = `${LAUNCHER} input[role="combobox"]`;
const DOCK = 'aside[aria-label="left file browser"] .browser';

async function launcher(page, title) {
  await page.keyboard.down("Control");
  await page.keyboard.down("Alt");
  await page.keyboard.press("KeyK");
  await page.keyboard.up("Alt");
  await page.keyboard.up("Control");
  await page.waitForSelector(LAUNCHER_INPUT, { visible: true });
  await page.waitForFunction((selector) => {
    const input = document.querySelector(selector);
    return input === document.activeElement && input.selectionStart === 0 && input.selectionEnd === input.value.length;
  }, {}, LAUNCHER_INPUT);
  await page.type(LAUNCHER_INPUT, title);
  await page.waitForFunction((selector, wanted) =>
    document.querySelector(`${selector} [role="option"][aria-selected="true"] .deck-result-title`)?.textContent?.trim() === wanted,
  {}, LAUNCHER, title);
  await page.keyboard.press("Enter");
  await page.waitForSelector(LAUNCHER, { hidden: true });
}

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
  const row = treeRow(root, path);
  await page.waitForSelector(row, { visible: true });
  if (await page.$eval(row, (node) => node.getAttribute("aria-expanded") === "true") !== true) {
    await page.click(`${row} .twirl`);
  }
  await page.waitForFunction((selector) =>
    document.querySelector(selector)?.getAttribute("aria-expanded") === "true", {}, row);
}

export default {
  name: "file-browser-details-dock",
  async run(ctx) {
    const { page } = ctx;
    await page.bringToFront();
    const prefix = `details-dock-${Date.now()}`;
    const directory = `${prefix}/notes`;
    const fixture = join(ctx.workspaceDir, prefix);
    mkdirSync(join(ctx.workspaceDir, directory), { recursive: true });
    writeFileSync(join(ctx.workspaceDir, directory, "a.md"), "dock file\n");
    writeFileSync(join(ctx.workspaceDir, directory, "b.md"), "tab file\n");
    const authToken = token(ctx);
    const { docks: originalDocks } = await readDocks(page, authToken);
    try {
      await setDock(page, "left", true, authToken);

      await navigateFiles(page, directory);
      const tabRow = await waitFileRow(page, "b.md", true, { timeout: 15_000 });
      if (!tabRow) throw new Error("file row b.md not found in the Files tab");
      await tabRow.click();
      await tabRow.dispose();
      await page.waitForFunction((wanted) => [...document.querySelectorAll('.browser:not(.dock) [role="option"]')].some(
        (row) => (row.getAttribute("title") ?? "").endsWith(wanted) && row.getAttribute("aria-selected") === "true",
      ), { timeout: 15_000 }, `${directory}/b.md`);

      await expand(page, ctx.workspaceDir, directory);
      const dockRow = treeRow(ctx.workspaceDir, join(directory, "a.md"));
      await page.waitForSelector(`${dockRow} .row-icon`, { visible: true, timeout: 15_000 });
      await page.click(`${dockRow} .row-icon`);
      await page.focus(`${DOCK} .tree`);
      await page.waitForFunction((wanted) => {
        const tree = document.querySelector('aside[aria-label="left file browser"] .browser .tree');
        const active = document.getElementById(tree?.getAttribute("aria-activedescendant") ?? "");
        return (active?.getAttribute("title") ?? "").endsWith(wanted);
      }, { timeout: 15_000 }, `${directory}/a.md`);

      await launcher(page, "Workspace details");

      await page.waitForFunction(() => [...document.querySelectorAll(".browser:not(.dock) .kind-chip.workspace")].some(
        (chip) => chip.textContent?.trim() === "workspace",
      ), { timeout: 15_000 });
      await page.waitForFunction((wanted) => [...document.querySelectorAll('aside[aria-label="left file browser"] [role="treeitem"]')].some(
        (row) => (row.getAttribute("title") ?? "").endsWith(wanted) && row.getAttribute("aria-selected") === "true",
      ), { timeout: 15_000 }, `${directory}/a.md`);
      await page.waitForFunction((wanted) => [...document.querySelectorAll('.browser:not(.dock) [role="option"]')].some(
        (row) => (row.getAttribute("title") ?? "").endsWith(wanted) && row.getAttribute("aria-selected") !== "true",
      ), { timeout: 15_000 }, `${directory}/b.md`);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      await setDock(page, "left", originalDocks.left === true, authToken);
    }
  },
};
