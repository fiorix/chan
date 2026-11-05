// The pane strip under the auto-hide preference, read as the page paints it:
// the strip's computed display and box, the tabs it lists, the visible side,
// the mounted terminals and whether the empty pane's welcome is up. A
// preference write goes through a revisioned PATCH /api/config and is read
// back from the server; the page learns of it through its own refresh, so a
// check waits for the painted consequence it expects rather than the write.

import { armFlip, paneFlip } from "./flip.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const LAUNCHER_INPUT = '[role="dialog"][aria-label="Command launcher"] input[role="combobox"]';
const LAUNCHER_SELECTED_TITLE =
  '[role="dialog"][aria-label="Command launcher"] [role="option"][aria-selected="true"] .deck-result-title';

/// The host command bus, which reaches the ids App.svelte's dispatch switch
/// names (new terminal, flip pane, close tab, the launcher toggle).
export function dispatchCommand(page, name) {
  return page.evaluate(
    (commandName) => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: commandName } })),
    name,
  );
}

/// Open the command launcher, type a command's exact title and prepare it
/// as the selected row; the caller presses Enter, since it may want to arm
/// an observer between the selection and the run. Registry-only commands
/// (send to side, among others) have no switch case, so the bus cannot
/// reach them and this is their user path.
export async function selectLauncherCommand(page, title) {
  await dispatchCommand(page, "app.launcher.toggle");
  await page.waitForSelector(LAUNCHER_INPUT, { timeout: 10_000 });
  await page.type(LAUNCHER_INPUT, title);
  try {
    await page.waitForFunction(
      (selector, wanted) => document.querySelector(selector)?.textContent?.trim() === wanted,
      { timeout: 10_000 },
      LAUNCHER_SELECTED_TITLE,
      title,
    );
  } catch (cause) {
    const rows = await page.$$eval(
      '[role="dialog"][aria-label="Command launcher"] .deck-result-title',
      (nodes) => nodes.map((node) => node.textContent?.trim() ?? ""),
    ).catch(() => []);
    throw new Error(`the launcher did not select "${title}"; its rows are ${JSON.stringify(rows)}`, { cause });
  }
}

export async function readPaneStrip(page, paneSelector = ".pane") {
  return page.evaluate((selector) => {
    const pane = document.querySelector(selector);
    if (!pane) return { pane: false, strip: false, display: null, height: 0, tabs: [], side: null, terminals: 0, welcome: false };
    const tabs = pane.querySelector(".tabs");
    const rect = tabs?.getBoundingClientRect();
    return {
      pane: true,
      strip: Boolean(tabs),
      display: tabs ? getComputedStyle(tabs).display : null,
      height: rect ? Math.round(rect.height) : 0,
      tabs: tabs
        ? [...tabs.querySelectorAll('[role="tab"]')].map((tab) => tab.getAttribute("title") || tab.textContent?.trim() || "")
        : [],
      side: pane.querySelector(".pane-card-inner")?.getAttribute("data-side-label") ?? null,
      terminals: pane.querySelectorAll(".terminal-tab").length,
      welcome: Boolean(pane.querySelector(".welcome")),
    };
  }, paneSelector);
}

/// The strip is painted: in the DOM, not display none, and with a box.
export function stripShown(state) {
  return state.strip && state.display !== "none" && state.height > 0;
}

/// The strip is in the DOM and hidden by display, which is how both the
/// auto-hide rule and the tmux rule take it out of the layout.
export function stripHidden(state) {
  return state.strip && state.display === "none";
}

export async function waitPaneStrip(page, label, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readPaneStrip(page);
    if (predicate(last)) return last;
    await sleep(200);
  }
  throw new Error(`${label}: not reached within ${timeoutMs}ms; the pane holds ${JSON.stringify(last)}`);
}

/// Preference reads and writes go to the serving tenant's own config route,
/// under the prefix the shell advertises, as the page's own requests do.
export async function readPaneStripPreference(page, token) {
  return page.evaluate(async (authToken) => {
    const prefix = document.querySelector('meta[name="chan-prefix"]')?.getAttribute("content") ?? "";
    const headers = authToken ? { authorization: `Bearer ${authToken}` } : {};
    const response = await fetch(`${prefix}/api/config`, { headers });
    if (!response.ok) throw new Error(`GET /api/config -> ${response.status}`);
    const config = await response.json();
    return { revision: config.revision, on: config.preferences.pane_strip_auto_hide === true };
  }, token);
}

export async function writePaneStripPreference(page, token, on) {
  await page.evaluate(async ({ authToken, value }) => {
    const prefix = document.querySelector('meta[name="chan-prefix"]')?.getAttribute("content") ?? "";
    const headers = { "content-type": "application/json" };
    if (authToken) headers.authorization = `Bearer ${authToken}`;
    const got = await fetch(`${prefix}/api/config`, { headers });
    if (!got.ok) throw new Error(`GET /api/config -> ${got.status}`);
    const config = await got.json();
    const response = await fetch(`${prefix}/api/config`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ expected_revision: config.revision, preferences: { pane_strip_auto_hide: value } }),
    });
    if (!response.ok) throw new Error(`PATCH /api/config -> ${response.status} ${await response.text()}`);
  }, { authToken: token, value: on });
  const deadline = Date.now() + 10_000;
  let last = null;
  do {
    last = await readPaneStripPreference(page, token);
    if (last.on === on) return;
    await sleep(200);
  } while (Date.now() < deadline);
  throw new Error(`the server did not read back pane_strip_auto_hide=${on}; last=${JSON.stringify(last)}`);
}

/// Close the visible side's active tab, taking the "Close tab?" confirmation
/// a live terminal raises, and wait until the pane mounts one terminal fewer.
export async function closeActiveTerminal(page, label) {
  const before = await readPaneStrip(page);
  await dispatchCommand(page, "app.tab.close");
  const deadline = Date.now() + 15_000;
  let last = before;
  while (Date.now() < deadline) {
    last = await readPaneStrip(page);
    if (last.terminals < before.terminals) return last;
    const dialog = await page.$('[role="dialog"][aria-labelledby="confirm-title"]');
    if (dialog) {
      for (const button of await dialog.$$("button")) {
        if (await button.evaluate((node) => node.textContent?.trim() === "Close")) {
          await button.click();
          break;
        }
      }
    }
    await sleep(200);
  }
  throw new Error(`${label}: the terminal count stayed at ${last.terminals}; the pane holds ${JSON.stringify(last)}`);
}

/// The live terminal sessions the server attributes to the page's window, read
/// from the tenant's terminal roster.
export async function windowSessions(page, token) {
  return page.evaluate(async (authToken) => {
    const windowId = new URL(location.href).searchParams.get("w")?.trim() ||
      sessionStorage.getItem("chan.session.window")?.trim() || "";
    if (!windowId) throw new Error("the page has no window id");
    const prefix = document.querySelector('meta[name="chan-prefix"]')?.getAttribute("content") ?? "";
    const headers = authToken ? { authorization: `Bearer ${authToken}` } : {};
    const response = await fetch(`${prefix}/api/terminals/roster`, { headers });
    if (!response.ok) throw new Error(`GET /api/terminals/roster -> ${response.status}`);
    const { sessions = [] } = await response.json();
    return sessions
      .filter((session) => session.window_id === windowId)
      .map((session) => ({ id: session.id, name: session.tab_name, group: session.tab_group }));
  }, token);
}

/// Close every terminal the pane mounts, on both sides, so the shared server
/// carries no session of this check into the next one. Closing a side's last
/// tab leaves that side showing with nothing to close, and a close there turns
/// the pane over and closes nothing, so the helper turns it over itself, under
/// the flip observer, before closing on the other side. The server's roster,
/// not the page, says when the window owns no session: a terminal left behind
/// stays a member of its group for every later window.
export async function closeEveryTerminal(page, label, token) {
  let state = await readPaneStrip(page);
  let guard = 0;
  while (state.terminals > 0) {
    if (++guard > 12) throw new Error(`${label}: still ${state.terminals} terminals after ${guard} steps`);
    if (state.tabs.length === 0) {
      const paneId = await page.$eval(".pane", (pane) => pane.getAttribute("data-pane-id"));
      const flip = await armFlip(page, paneFlip(paneId));
      await dispatchCommand(page, "app.pane.flip");
      await flip.settled(`${label} (turn ${guard})`);
      await flip.assertSettled(`${label} (turn ${guard})`);
      state = await readPaneStrip(page);
      continue;
    }
    state = await closeActiveTerminal(page, `${label} (close ${guard})`);
  }
  const deadline = Date.now() + 10_000;
  let left = await windowSessions(page, token);
  while (left.length > 0) {
    if (Date.now() > deadline) {
      throw new Error(`${label}: the pane mounts no terminal but the server still lists the window's sessions ${JSON.stringify(left)}`);
    }
    await sleep(200);
    left = await windowSessions(page, token);
  }
  return state;
}
