// Toggle group broadcast over a group with a member in a window no page
// holds. A member's broadcast flag is flipped only by its window's page, which
// the server asks with a window command; a window no page holds (one the
// desktop's Hide put away, or one whose page was closed) never answers, so a
// group toggle that waited for that member to join could turn the group on
// but never off, and the menu would read Select All whatever it did.
//
// A second page opens a window of its own and a terminal in the check's group,
// its layout saved, and then closes: the session stays, in a window no page
// holds, as a terminal left behind by an earlier check would. The main window
// opens a terminal in the same group and toggles group broadcast twice. The
// first toggle must turn broadcast on with the menu reading Deselect All, the
// second must turn it off with the menu reading Select All again. The member
// must still be listed, in a window with no page, after both toggles, or the
// run proved nothing. Then the second page reopens its window: the member is
// live again and rejoins the group, so a toggle turns it on through its page
// and the next turns the group off, which proves the check sees a member in
// another window at all.
//
// The group is the check's own, so a toggle reaches no terminal another check
// left in a shared group. The check closes both terminals and leaves broadcast
// off.

import { dispatchCommand } from "../lib/pane-strip.mjs";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { readTerminalPrefs } from "../lib/terminal-prefs.mjs";

const RUN = Date.now().toString(36);
const GROUP = `Bcast208${RUN}`;
const HOME = `Home208${RUN}`;
const AWAY = `Away208${RUN}`;
const AWAY_WINDOW = `bcast-208-away-${RUN}`;
const MARKER = ".tab.active .broadcast-marker";
const MENU = ".terminal-tab-menu-bubble";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pageWindowId(page) {
  return page.evaluate(() =>
    new URL(location.href).searchParams.get("w")?.trim() ||
    sessionStorage.getItem("chan.session.window")?.trim() || "",
  );
}

/// A GET on the serving tenant's own routes, as the page's requests make it.
function getJson(page, token, path) {
  return page.evaluate(async (authToken, route) => {
    const prefix = document.querySelector('meta[name="chan-prefix"]')?.getAttribute("content") ?? "";
    const headers = authToken ? { authorization: `Bearer ${authToken}` } : {};
    const response = await fetch(`${prefix}${route}`, { headers });
    if (!response.ok) throw new Error(`GET ${route} -> ${response.status}`);
    return response.json();
  }, token, path);
}

/// The group's members as the server's roster lists them, by name.
async function groupMembers(page, token) {
  const { sessions = [] } = await getJson(page, token, "/api/terminals/roster");
  return Object.fromEntries(
    sessions
      .filter((session) => session.tab_group === GROUP)
      .map((session) => [session.tab_name, {
        window: session.window_id,
        live: session.window_live ?? null,
        broadcast: session.broadcast,
      }]),
  );
}

/// The window list's row for `id`: whether a page holds it, whether it saved.
async function windowRow(page, token, id) {
  const rows = await getJson(page, token, "/api/windows");
  const row = rows.find((candidate) => candidate.id === id);
  return row ? { connected: row.connected, saved: row.saved } : null;
}

async function poll(label, read, accept, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await read();
    if (accept(last)) return last;
    if (Date.now() > deadline) throw new Error(`${label}: not reached within ${timeoutMs}ms; last ${JSON.stringify(last)}`);
    await sleep(200);
  }
}

async function openWindow(ctx, windowId) {
  const url = new URL(ctx.serverUrl);
  url.searchParams.set("w", windowId);
  const page = await ctx.browser.newPage();
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(".pane", { timeout: 30_000 });
  await ctx.waitWindowLive(windowId);
  return page;
}

/// The saved layout of `windowId` names the terminal, so a reopened page
/// restores it and the session outlives a page with none attached.
async function waitSavedTerminal(page, token, windowId, name) {
  await poll(
    `${windowId}'s saved layout names ${name}`,
    async () => {
      const body = await getJson(page, token, `/api/session?w=${encodeURIComponent(windowId)}`).catch((error) => ({ error: error.message }));
      return { names: JSON.stringify(body?.layout ?? null).includes(name), error: body?.error ?? null };
    },
    (state) => state.names,
  );
}

/// What the main window shows of the group's broadcast: the active tab's
/// marker and its title, and the tab menu's Select All row, read with the
/// menu open and then closed again.
async function readBroadcast(page) {
  const marker = await page.$eval(MARKER, (node) => node.getAttribute("title")).catch(() => null);
  const strip = await page.$(".pane .tabs .tab.active .path");
  if (!strip) throw new Error("the main window has no active tab to open the menu from");
  const box = await strip.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  await page.waitForSelector(MENU, { visible: true, timeout: 10_000 });
  const menu = await page.evaluate((menuSelector) => ({
    label: [...document.querySelectorAll(`${menuSelector} .mbtn-label`)]
      .map((node) => node.textContent?.trim() ?? "")
      .find((text) => text === "Select All" || text === "Deselect All") ?? null,
    otherWindows: [...document.querySelectorAll(`${menuSelector} .broadcast-other-windows-label ~ .target-row .target-name`)]
      .map((node) => node.textContent?.trim() ?? ""),
  }), MENU);
  await page.keyboard.press("Escape");
  await page.waitForSelector(MENU, { hidden: true, timeout: 10_000 });
  return { marker, ...menu };
}

/// Toggle group broadcast in the main window and read what it then shows:
/// once the marker and the roster read as `expect` says, the menu until its
/// label does. A reading that never arrives is returned as it last stood, for
/// the caller to judge, after a bounded wait.
async function toggle(page, token, label, expect) {
  await page.bringToFront();
  await dispatchCommand(page, "app.terminal.broadcastToggle");
  const settled = async () => ({ marker: Boolean(await page.$(MARKER)), members: await groupMembers(page, token) });
  await poll(`${label}: the marker and the roster`, settled,
    (state) => state.marker === expect.on && expect.roster(state.members), 8_000).catch(() => {});
  const deadline = Date.now() + 4_000;
  let reading;
  for (;;) {
    reading = { label, ...(await readBroadcast(page)), members: await groupMembers(page, token) };
    if (reading.label === expect.label || Date.now() > deadline) return reading;
    await sleep(300);
  }
}

export default {
  name: "broadcast-windowless-member",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const homeWindow = await pageWindowId(page);
    if (!homeWindow) throw new Error("could not resolve the page's window id");
    const csIn = (windowId) => (args) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
      cwd: ctx.workspaceDir,
      env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId },
      timeout: 30_000,
    });
    const engine = (await readTerminalPrefs(page, token)).ghostty ? "ghostty" : "xterm";
    const details = { engine };
    const opened = [];
    let away = null;
    try {
      // A member in a window no page holds.
      away = await openWindow(ctx, AWAY_WINDOW);
      await openAttachedTerminal(ctx, away, csIn(AWAY_WINDOW), AWAY_WINDOW, AWAY, engine, ["--tab-group", GROUP]);
      opened.push(AWAY);
      await waitSavedTerminal(page, token, AWAY_WINDOW, AWAY);
      await away.close();
      away = null;
      details.windowless = await poll(
        "the away window keeps its terminal with no page",
        async () => ({ row: await windowRow(page, token, AWAY_WINDOW), members: await groupMembers(page, token) }),
        ({ row, members }) => row?.saved === true && row.connected === false && members[AWAY]?.window === AWAY_WINDOW,
      );

      // A member in the main window, the one the toggles run from.
      await openAttachedTerminal(ctx, page, csIn(homeWindow), homeWindow, HOME, engine, ["--tab-group", GROUP]);
      opened.push(HOME);
      await poll("the group lists both members", () => groupMembers(page, token),
        (members) => members[HOME]?.window === homeWindow && members[AWAY]?.window === AWAY_WINDOW);

      const first = await toggle(page, token, "first toggle",
        { on: true, label: "Deselect All", roster: (members) => members[HOME]?.broadcast === true });
      const second = await toggle(page, token, "second toggle",
        { on: false, label: "Select All", roster: (members) => members[HOME]?.broadcast === false });
      const still = { row: await windowRow(page, token, AWAY_WINDOW), members: await groupMembers(page, token) };
      details.windowlessToggles = { first, second, still };
      console.log(`[smoke]   windowless ${JSON.stringify(details.windowlessToggles)}`);
      await ctx.shot("208-after-two-toggles");
      const failures = [];
      if (!(still.row?.connected === false && still.members[AWAY]?.window === AWAY_WINDOW)) {
        failures.push(`the away member did not stay in a window with no page, so the toggles proved nothing: ${JSON.stringify(still)}`);
      }
      if (!first.marker) failures.push("the first toggle did not turn broadcast on");
      if (first.label !== "Deselect All") failures.push(`after the first toggle the menu reads ${JSON.stringify(first.label)}, not "Deselect All"`);
      if (second.marker) failures.push(`the second toggle left broadcast on (${second.marker}): the group cannot be cleared`);
      if (second.label !== "Select All") failures.push(`after the second toggle the menu reads ${JSON.stringify(second.label)}, not "Select All"`);
      if (failures.length > 0) throw new Error(`${failures.join("; ")}; ${JSON.stringify(details.windowlessToggles)}`);

      // The window comes back: its member rejoins the group with its own flag.
      away = await openWindow(ctx, AWAY_WINDOW);
      await poll("the away window holds its terminal again",
        async () => ({ row: await windowRow(page, token, AWAY_WINDOW), tabs: await away.$$eval(".tabs .tab .path", (nodes) => nodes.map((node) => node.textContent?.trim())) }),
        ({ row, tabs }) => row?.connected === true && tabs.includes(AWAY));
      const join = await toggle(page, token, "toggle with the window back", {
        on: true,
        label: "Deselect All",
        roster: (members) => members[HOME]?.broadcast === true && members[AWAY]?.broadcast === true,
      });
      const leave = await toggle(page, token, "toggle to clear it", {
        on: false,
        label: "Select All",
        roster: (members) => members[HOME]?.broadcast === false && members[AWAY]?.broadcast === false,
      });
      details.liveToggles = { join, leave };
      console.log(`[smoke]   live ${JSON.stringify(details.liveToggles)}`);
      const live = [];
      if (!(join.members[AWAY]?.broadcast === true && join.otherWindows.includes(AWAY))) {
        live.push(`with its window back the member did not rejoin: ${JSON.stringify(join)}`);
      }
      if (!join.marker || join.label !== "Deselect All") live.push(`the toggle with the window back shows ${JSON.stringify(join)}`);
      if (leave.marker || leave.label !== "Select All" || leave.members[AWAY]?.broadcast !== false) {
        live.push(`the toggle to clear the group shows ${JSON.stringify(leave)}`);
      }
      if (live.length > 0) throw new Error(live.join("; "));
      return details;
    } finally {
      // Broadcast off for the main window's member before the terminals go;
      // a closed terminal takes its flag with it either way.
      if (opened.includes(HOME) && (await page.$(MARKER).catch(() => null))) {
        await dispatchCommand(page, "app.terminal.broadcastToggle").catch(() => {});
        await page.waitForSelector(MARKER, { hidden: true, timeout: 5_000 }).catch(() => {});
      }
      for (const name of opened.reverse()) {
        await csIn(homeWindow)(["close", "--tab-name", name]).catch(() => {});
      }
      if (away) await away.close().catch(() => {});
    }
  },
};
