// Files tab navigation and readings use the directory view's accessible controls.

export const FILE_LIST = '[role="listbox"][aria-label="Directory contents"]';
export const FILE_ROW = `${FILE_LIST} [role="option"]`;
const TABS = '[role="tablist"] [role="tab"]';

export function filePath(path) {
  if (typeof path !== "string" || path.startsWith("/") || path.includes("\0")) {
    throw new Error(`expected a workspace-relative path: ${JSON.stringify(path)}`);
  }
  const parts = path.split("/").filter((part) => part && part !== ".");
  if (parts.includes("..")) throw new Error(`parent traversal in file path: ${path}`);
  return parts.join("/");
}

export function filesReady(state) {
  return state.visible && state.directory !== null && !state.filter &&
    !state.retry &&
    !state.status.some((text) => /Loading files|Workspace root unavailable|File listing failed/.test(text));
}

function within(scope, selector) {
  return scope ? `${scope} ${selector}` : selector;
}

export async function browserTab(page, scope = "") {
  const tabs = await page.$$(within(scope, TABS));
  const candidates = [];
  for (const tab of tabs) {
    const info = await tab.evaluate((el) => ({
      title: el.title, active: el.getAttribute("aria-selected") === "true",
      focused: el.closest('[role="region"][aria-label="editor pane"]')?.classList.contains("focused"),
    }));
    if (info.title !== "File Browser" && !info.title.startsWith("File Browser: ")) {
      await tab.dispose();
      continue;
    }
    candidates.push({ tab, score: Number(info.focused) * 2 + Number(info.active) });
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const candidate of candidates.slice(1)) await candidate.tab.dispose();
  return candidates[0]?.tab ?? null;
}

async function paneScope(page, scope) {
  if (scope) return scope;
  const tab = await browserTab(page);
  const id = await tab?.evaluate((el) => el.closest('[role="region"][aria-label="editor pane"]')?.getAttribute("data-pane-id"));
  await tab?.dispose();
  return id ? `[role="region"][data-pane-id=${JSON.stringify(id)}]` : "";
}

async function snapshot(page, scope) {
  return page.evaluate(({ scope, listSelector }) => {
    const host = scope ? document.querySelector(scope) : document;
    const list = host?.querySelector(listSelector);
    const surface = list?.closest('[role="presentation"]');
    const visible = Boolean(list?.checkVisibility() && list.getBoundingClientRect().width);
    const crumbs = surface?.querySelector('nav[aria-label="Breadcrumbs"]');
    const directory = crumbs ? [...crumbs.querySelectorAll("button")].slice(1).map((el) => el.textContent.trim()).join("/") : null;
    const rows = [...(list?.querySelectorAll('[role="option"]') ?? [])].map((row) => {
      const label = row.querySelector('button, [role="button"]');
      const name = label?.textContent?.trim() ?? "";
      return {
        name,
        path: directory ? `${directory}/${name}` : name,
        selected: row.getAttribute("aria-selected") === "true",
        directory: label?.getAttribute("role") === "button",
      };
    });
    return {
      visible, directory, rows,
      filter: surface?.querySelector('input[aria-label="Filter this folder"]')?.value ?? "",
      retry: [...(surface?.querySelectorAll("button") ?? [])].some((button) => button.textContent.trim() === "Retry loading this folder"),
      status: [...(list?.parentElement?.querySelectorAll('[role="status"]') ?? [])].map((el) => el.textContent.trim()),
    };
  }, { scope, listSelector: FILE_LIST });
}

async function waitListing(page, label, scope, accept, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let state;
  do {
    state = await snapshot(page, scope);
    if (filesReady(state) && accept(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`${label}; Files holds ${JSON.stringify(state)}`);
}

export async function showFiles(page, scope = "") {
  await page.bringToFront();
  let tab = await browserTab(page, scope);
  const opened = !tab;
  if (!tab) {
    if (scope) {
      const active = await page.$(within(scope, '[role="tab"][aria-selected="true"]'));
      if (active) { await active.click(); await active.dispose(); }
      else await page.click(scope);
    }
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.files.toggle" } })));
    const deadline = Date.now() + 15_000;
    while (!tab && Date.now() < deadline) {
      tab = await browserTab(page, scope);
      if (!tab) await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!tab) throw new Error(`Files tab did not appear; tabs=${JSON.stringify(await page.$$eval(TABS, (tabs) => tabs.map((el) => el.title)))}`);
  await tab.click();
  await tab.dispose();
  scope = await paneScope(page, scope);
  await page.waitForSelector(within(scope, FILE_LIST), { visible: true, timeout: 15_000 });
  return opened;
}

export async function readFiles(page, scope = "") {
  const state = await snapshot(page, await paneScope(page, scope));
  if (!state.visible) throw new Error(`Files listing is absent or hidden; Files holds ${JSON.stringify(state)}`);
  return state;
}

export async function navigateFiles(page, directory, scope = "") {
  directory = filePath(directory);
  await showFiles(page, scope);
  scope = await paneScope(page, scope);
  const clear = await page.$(within(scope, 'button[aria-label="Clear filter"]'));
  if (clear) await clear.click();
  if ((await readFiles(page, scope)).directory !== directory) {
    await page.click(within(scope, 'button[aria-label="Enter directory path"]'));
    const input = await page.waitForSelector(within(scope, 'input[aria-label="Directory path"]'), { visible: true });
    await input.click({ count: 3 });
    await page.keyboard.press("Backspace");
    await input.type(directory || "/");
    await input.press("Enter");
  }
  return waitListing(page, `directory ${JSON.stringify(directory)} did not load`, scope, (state) => state.directory === directory);
}

export async function fileRow(page, name, scope = "") {
  scope = await paneScope(page, scope);
  await readFiles(page, scope);
  const handle = await page.evaluateHandle(({ selector, name }) => [...document.querySelectorAll(selector)].find((row) => row.querySelector('button, [role="button"]')?.textContent?.trim() === name) ?? null, { selector: within(scope, FILE_ROW), name });
  const row = handle.asElement();
  if (!row) await handle.dispose();
  return row;
}

export async function waitFileRow(page, name, present = true, { timeout = 15_000, scope = "" } = {}) {
  scope = await paneScope(page, scope);
  await waitListing(page, `row ${JSON.stringify(name)} did not become ${present ? "present" : "absent"}`, scope, (state) => state.rows.some((row) => row.name === name) === present, timeout);
  return present ? fileRow(page, name, scope) : null;
}

async function pathRow(page, path, scope) {
  path = filePath(path);
  if (!path) throw new Error("a file or directory row needs a nonempty path");
  const parts = path.split("/");
  const name = parts.pop();
  await navigateFiles(page, parts.join("/"), scope);
  return waitFileRow(page, name, true, { scope });
}

export async function selectFile(page, path, { details = false, scope = "" } = {}) {
  const row = await pathRow(page, path, scope);
  await row.click();
  if (details) {
    scope = await paneScope(page, scope);
    const toggle = await page.$(within(scope, 'button[aria-label="Toggle details"]'));
    if (await toggle.evaluate((el) => el.getAttribute("aria-pressed") !== "true")) await toggle.click();
    await page.waitForFunction(({ selector, path }) => document.querySelector(`${selector} aside[aria-label="Details"] h3[title]`)?.getAttribute("title") === path, { timeout: 15_000 }, { selector: scope, path: filePath(path) });
  }
  return row;
}

export async function openFile(page, path, scope = "") {
  const row = await pathRow(page, path, scope);
  scope = await paneScope(page, scope);
  // Details can cover the listing in a narrow pane; expose the row before the pointer opens it.
  const closeDetails = await page.$(within(scope, 'aside[aria-label="Details"] button[aria-label="Close Details"]'));
  if (closeDetails) {
    await closeDetails.click();
    await page.waitForSelector(within(scope, 'aside[aria-label="Details"]'), { hidden: true, timeout: 10_000 });
    await closeDetails.dispose();
  }
  await row.click({ count: 2 });
}
