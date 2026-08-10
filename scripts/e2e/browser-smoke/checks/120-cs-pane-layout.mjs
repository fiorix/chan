// End-to-end parity check for the cs pane layout contract.
//
// This check owns a separate browser window id so it can freely shape, close,
// persist, and reload panes without inheriting state from earlier checks. CLI
// mutations use only the public `chan shell` surface. UI parity uses the real
// Command Launcher rows, pane hamburger, and Hybrid Nav keyboard transaction.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WINDOW_ID = "cs-pane-layout-smoke";
const OFFLINE_WINDOW_ID = "cs-pane-layout-offline";
const TEAM_DIR = "cs-pane-layout-team";
const TEAM_GROUP = "cs-pane-layout-team";
const TEAM_HANDLES = ["@@LayoutLead", "@@LayoutHand"];
const LAUNCHER_SELECTOR = '[role="dialog"][aria-label="Command launcher"]';
const LAUNCHER_INPUT_SELECTOR = `${LAUNCHER_SELECTOR} input[role="combobox"]`;
const SELECTED_TITLE_SELECTOR = `${LAUNCHER_SELECTOR} [role="option"][aria-selected="true"] .deck-result-title`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rendered(value) {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return value == null ? "" : String(value);
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function pane(snapshot, paneId) {
  return snapshot.panes.find((entry) => entry.id === paneId) ?? null;
}

function sideTabs(snapshot, paneId, side) {
  return pane(snapshot, paneId)?.sides?.[side]?.tabs ?? [];
}

function tabOn(snapshot, paneId, side, predicate) {
  return sideTabs(snapshot, paneId, side).find(predicate) ?? null;
}

function paneContent(snapshot, paneId) {
  const entry = pane(snapshot, paneId);
  if (!entry) return null;
  const tabs = (side) =>
    (entry.sides?.[side]?.tabs ?? []).map((tab) => ({
      id: tab.id,
      kind: tab.kind,
      title: tab.title,
    }));
  return {
    activeSide: entry.activeSide,
    a: tabs("a"),
    b: tabs("b"),
  };
}

// Exact identity is useful within one mounted SPA to prove a refused command
// made no mutation. It is deliberately NOT the reload persistence oracle:
// pane/tab ids are runtime coordinates and may be regenerated on restore.
function exactLayoutSnapshot(snapshot) {
  return {
    windowId: snapshot.windowId,
    activePaneId: snapshot.activePaneId,
    panes: snapshot.panes
      .map((entry) => ({
        id: entry.id,
        activeSide: entry.activeSide,
        a: (entry.sides?.a?.tabs ?? []).map((tab) => ({
          id: tab.id,
          kind: tab.kind,
          title: tab.title,
        })),
        b: (entry.sides?.b?.tabs ?? []).map((tab) => ({
          id: tab.id,
          kind: tab.kind,
          title: tab.title,
        })),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

// Persistence is semantic. Order panes by their rendered position, normalize
// geometry to viewport-relative integers, and retain only the active semantic
// positions plus each side's ordered kind/title list. This proves the layout
// tree's visible shape and two-sided contents without requiring runtime ids to
// survive a reload.
async function semanticLayout(page, snapshot) {
  const geometry = await page.evaluate((paneIds) => {
    const scale = (value, total) =>
      Math.round((value / Math.max(1, total)) * 10_000);
    return paneIds.map((paneId) => {
      const element = document.querySelector(
        `.pane[data-pane-id="${paneId}"]`,
      );
      if (!(element instanceof HTMLElement)) return { paneId, missing: true };
      const rect = element.getBoundingClientRect();
      return {
        paneId,
        x: scale(rect.x, window.innerWidth),
        y: scale(rect.y, window.innerHeight),
        width: scale(rect.width, window.innerWidth),
        height: scale(rect.height, window.innerHeight),
      };
    });
  }, snapshot.panes.map((entry) => entry.id));
  const byId = new Map(geometry.map((entry) => [entry.paneId, entry]));
  const ordered = snapshot.panes
    .map((entry) => ({ entry, rect: byId.get(entry.id) }))
    .sort(
      (a, b) =>
        (a.rect?.y ?? Number.MAX_SAFE_INTEGER) -
          (b.rect?.y ?? Number.MAX_SAFE_INTEGER) ||
        (a.rect?.x ?? Number.MAX_SAFE_INTEGER) -
          (b.rect?.x ?? Number.MAX_SAFE_INTEGER),
    );
  const side = (entry, label) => {
    const state = entry.sides?.[label] ?? { activeTabId: null, tabs: [] };
    return {
      activeTabPosition: state.tabs.findIndex(
        (tab) => tab.id === state.activeTabId || tab.active === true,
      ),
      tabs: state.tabs.map((tab) => ({
        kind: tab.kind,
        // File-browser ordinals are generated for the mounted window and are
        // intentionally recomputed on restore. Keep the semantic oracle exact
        // for every user-significant title while ignoring that runtime suffix.
        title:
          tab.kind === "browser" && /^Files \d+$/.test(tab.title)
            ? "Files"
            : tab.title,
      })),
    };
  };
  return {
    activePanePosition: ordered.findIndex(
      ({ entry }) => entry.id === snapshot.activePaneId || entry.active === true,
    ),
    panes: ordered.map(({ entry, rect }) => ({
      geometry: rect
        ? {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          }
        : { missing: true },
      activeSide: entry.activeSide,
      a: side(entry, "a"),
      b: side(entry, "b"),
    })),
  };
}

function terminalRows(payload) {
  return Object.entries(payload.groups ?? {}).flatMap(([group, rows]) =>
    (Array.isArray(rows) ? rows : []).map((row) => ({ group, ...row })),
  );
}

async function cli(ctx, windowId, args, options = {}) {
  const env = {
    ...process.env,
    CHAN_CONTROL_SOCKET: ctx.controlSocket,
    CHAN_WINDOW_ID: windowId,
    CHAN_WORKSPACE_PATH: ctx.workspaceDir,
  };
  return ctx.exec(ctx.chanBin, ["shell", ...args], {
    cwd: ctx.workspaceDir,
    env,
    timeout: 120_000,
    ...options,
  });
}

async function cliFailure(ctx, windowId, args) {
  try {
    const result = await cli(ctx, windowId, args);
    throw new Error(
      `command unexpectedly succeeded: chan shell ${args.join(" ")}\n` +
        `${rendered(result.stdout)}${rendered(result.stderr)}`,
    );
  } catch (error) {
    if (error.message?.startsWith("command unexpectedly succeeded:")) throw error;
    return {
      stdout: rendered(error.stdout),
      stderr: rendered(error.stderr),
      message: rendered(error.message),
    };
  }
}

async function paneList(ctx, windowId) {
  const { stdout } = await cli(ctx, windowId, [
    "pane",
    "list",
    "--window",
    windowId,
    "--json",
  ]);
  return JSON.parse(rendered(stdout));
}

async function terminalList(ctx, windowId) {
  const { stdout } = await cli(ctx, windowId, ["terminal", "list", "--json"]);
  return JSON.parse(rendered(stdout));
}

async function pollValue(read, accept, label, timeoutMs = 15_000) {
  const started = Date.now();
  let last;
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await read();
      if (accept(last)) return last;
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  const suffix = lastError
    ? `; last error: ${lastError.message}`
    : `; last value: ${JSON.stringify(last)}`;
  throw new Error(`${label} did not settle within ${timeoutMs}ms${suffix}`);
}

async function maybePollValue(read, accept, timeoutMs = 3_000) {
  try {
    return await pollValue(read, accept, "optional observation", timeoutMs);
  } catch {
    return null;
  }
}

async function pollLayout(ctx, windowId, accept, label, timeoutMs) {
  return pollValue(
    () => paneList(ctx, windowId),
    accept,
    label,
    timeoutMs,
  );
}

async function pollTerminals(ctx, windowId, accept, label, timeoutMs) {
  return pollValue(
    () => terminalList(ctx, windowId),
    accept,
    label,
    timeoutMs,
  );
}

async function paneRect(page, paneId) {
  return page.$eval(`.pane[data-pane-id="${paneId}"]`, (element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
}

async function clickTab(page, paneId, title) {
  await page.waitForFunction(
    (id, wanted) => {
      const root = document.querySelector(`.pane[data-pane-id="${id}"]`);
      return [...(root?.querySelectorAll('[role="tab"]') ?? [])].some(
        (entry) =>
          entry.querySelector(".path")?.textContent?.trim() === wanted ||
          entry.textContent?.includes(wanted),
      );
    },
    { timeout: 10_000 },
    paneId,
    title,
  );
  const clicked = await page.evaluate(
    (id, wanted) => {
      const root = document.querySelector(`.pane[data-pane-id="${id}"]`);
      const target = [...(root?.querySelectorAll('[role="tab"]') ?? [])].find(
        (entry) =>
          entry.querySelector(".path")?.textContent?.trim() === wanted ||
          entry.textContent?.includes(wanted),
      );
      if (!(target instanceof HTMLElement)) return false;
      target.click();
      return true;
    },
    paneId,
    title,
  );
  if (!clicked) throw new Error(`could not click tab ${title} in pane ${paneId}`);
}

async function waitForFlipSettle(page, paneId) {
  await page.waitForFunction(
    (id) =>
      !document.querySelector(
        `.pane[data-pane-id="${id}"].sideFlipActive`,
      ),
    { timeout: 10_000 },
    paneId,
  );
}

async function selectedLauncherTitle(page) {
  return page.$eval(
    SELECTED_TITLE_SELECTOR,
    (entry) => entry.textContent?.replace(/\s+/g, " ").trim() ?? "",
  );
}

async function launcherRun(page, query, expectedTitle = query, confirm = false) {
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("chan:command", {
        detail: { name: "app.launcher.toggle" },
      }),
    );
  });
  await page.waitForSelector(LAUNCHER_INPUT_SELECTOR, { timeout: 10_000 });
  await page.$eval(LAUNCHER_INPUT_SELECTOR, (input) => {
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.type(LAUNCHER_INPUT_SELECTOR, query);
  await page.waitForFunction(
    (selector, title) => {
      const text = document.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim();
      return text === title || text?.startsWith(`${title} `);
    },
    { timeout: 10_000 },
    SELECTED_TITLE_SELECTOR,
    expectedTitle,
  );
  const selected = await selectedLauncherTitle(page);
  await page.keyboard.press("Enter");
  if (confirm) {
    await page.waitForSelector(`${LAUNCHER_SELECTOR} .deck-operation`, {
      timeout: 10_000,
    });
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
  }
  await page.waitForSelector(LAUNCHER_SELECTOR, { hidden: true, timeout: 10_000 });
  return selected;
}

async function hamburgerRun(page, paneId, title) {
  const root = `.pane[data-pane-id="${paneId}"]`;
  await page.click(`${root} .hamburger-trigger`);
  await page.waitForFunction(
    (id, wanted) =>
      document.querySelector(`.pane[data-pane-id="${id}"]`) &&
      [...document.querySelectorAll(".hamburger-menu button")].some(
        (button) =>
          button.getBoundingClientRect().width > 0 &&
          button.querySelector(".menu-row-label")?.textContent?.trim() === wanted,
      ),
    { timeout: 10_000 },
    paneId,
    title,
  );
  const clicked = await page.evaluate(
    (_id, wanted) => {
      const button = [
        ...document.querySelectorAll(".hamburger-menu button"),
      ].find(
        (entry) =>
          entry.getBoundingClientRect().width > 0 &&
          entry.querySelector(".menu-row-label")?.textContent?.trim() === wanted,
      );
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    },
    paneId,
    title,
  );
  if (!clicked) throw new Error(`pane ${paneId} hamburger has no ${title} row`);
}

async function closeTabsNamed(ctx, windowId, names) {
  const snapshot = await paneList(ctx, windowId);
  const targets = snapshot.panes.flatMap((entry) =>
    ["a", "b"].flatMap((side) =>
      (entry.sides?.[side]?.tabs ?? [])
        .filter((tab) => names.includes(tab.title))
        .map((tab) => ({ paneId: entry.id, tabId: tab.id })),
    ),
  );
  for (const target of targets) {
    await cli(ctx, windowId, [
      "pane",
      "close-tab",
      "--window",
      windowId,
      "--pane",
      target.paneId,
      "--tab",
      target.tabId,
      "--force",
    ]);
  }
}

export default {
  name: "cs-pane-layout",
  async run(ctx) {
    const failures = [];
    const check = (condition, message) => {
      if (!condition) failures.push(message);
    };

    const layoutFileA = "cs-layout-a.md";
    const layoutFileLauncher = "cs-layout-launcher.md";
    const layoutDir = "cs-layout-dir";
    writeFileSync(join(ctx.workspaceDir, layoutFileA), "# CLI side A\n");
    writeFileSync(join(ctx.workspaceDir, layoutFileLauncher), "# Launcher\n");
    mkdirSync(join(ctx.workspaceDir, layoutDir), { recursive: true });
    writeFileSync(join(ctx.workspaceDir, layoutDir, "inner.md"), "inner\n");

    const teamConfigPath = join(ctx.outDir, "cs-pane-layout-team.toml");
    writeFileSync(
      teamConfigPath,
      `team_name = "${TEAM_GROUP}"
host_name = "Smoke Host"
host_handle = "@@SmokeHost"
tab_group = "${TEAM_GROUP}"
created_at = "2026-07-23T00:00:00Z"

[[members]]
handle = "${TEAM_HANDLES[0]}"
command = ""
is_lead = true

[[members]]
handle = "${TEAM_HANDLES[1]}"
command = ""
is_lead = false
`,
    );

    const ownUrl = new URL(ctx.serverUrl);
    ownUrl.searchParams.set("w", WINDOW_ID);
    const page = await ctx.browser.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") {
        console.log(`[cs-pane-layout page:error] ${message.text()}`);
      }
    });

    try {
      const cdp = await page.createCDPSession();
      const terminalSocketUrls = [];
      cdp.on("Network.webSocketCreated", ({ url }) => {
        if (url.includes("/api/terminal/ws")) terminalSocketUrls.push(url);
      });
      await cdp.send("Network.enable");
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
      await page.goto(ownUrl.href, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForSelector(".pane", { timeout: 30_000 });
      await page.bringToFront();
      // The pane is mounted; the server does not necessarily know this window
      // yet, and every `cs pane` call below addresses it by id.
      await ctx.waitWindowLive(WINDOW_ID);

      let snapshot = await pollLayout(
        ctx,
        WINDOW_ID,
        (value) => value.windowId === WINDOW_ID && value.panes?.length === 1,
        "isolated cs pane window",
        20_000,
      );
      const leftId = snapshot.activePaneId;
      check(typeof leftId === "string" && leftId.length > 0, "initial pane has no id");
      check(
        snapshot.panes.every(
          (entry) =>
            entry.sides?.a &&
            Array.isArray(entry.sides.a.tabs) &&
            entry.sides?.b &&
            Array.isArray(entry.sides.b.tabs),
        ),
        "pane list must include explicit A and B snapshots, including empty sides",
      );

      const bare = JSON.parse(
        rendered(
          (
            await cli(ctx, WINDOW_ID, [
              "pane",
              "--window",
              WINDOW_ID,
              "--json",
            ])
          ).stdout,
        ),
      );
      check(sameJson(bare, snapshot), "bare `cs pane` must alias `cs pane list`");

      const initialHuman = rendered(
        (
          await cli(ctx, WINDOW_ID, [
            "pane",
            "list",
            "--window",
            WINDOW_ID,
          ])
        ).stdout,
      );
      check(
        initialHuman.includes("| A |") && initialHuman.includes("| B |"),
        "human pane list must render both A and B rows",
      );
      await ctx.shot("initial-two-sided-list", page);

      const badSide = await cliFailure(ctx, WINDOW_ID, [
        "open",
        layoutFileA,
        "--window",
        WINDOW_ID,
        "--side",
        "c",
      ]);
      check(
        /invalid value|possible values|side/i.test(badSide.stderr + badSide.message),
        "invalid --side must be a clap refusal",
      );

      const conflictingTarget = await cliFailure(ctx, WINDOW_ID, [
        "pane",
        "list",
        "--window",
        WINDOW_ID,
        "--tab-name",
        "not-a-tab",
      ]);
      check(
        /cannot be used with|conflict/i.test(
          conflictingTarget.stderr + conflictingTarget.message,
        ),
        "pane --window and --tab-name must conflict",
      );

      const scriptPlacement = await cliFailure(ctx, WINDOW_ID, [
        "terminal",
        "team",
        "new",
        `${TEAM_DIR}-invalid`,
        "--config",
        teamConfigPath,
        "--window",
        WINDOW_ID,
        "--pane",
        leftId,
        "--script",
      ]);
      check(
        /cannot be used with|conflict/i.test(
          scriptPlacement.stderr + scriptPlacement.message,
        ),
        "team --script must refuse placement flags",
      );

      const beforeOffline = exactLayoutSnapshot(snapshot);
      const offline = await cliFailure(ctx, WINDOW_ID, [
        "open",
        layoutFileA,
        "--window",
        OFFLINE_WINDOW_ID,
      ]);
      check(
        /not connected|no live|no window|offline/i.test(
          offline.stderr + offline.message,
        ),
        "an exact offline --window target must fail instead of using another receiver",
      );
      check(
        sameJson(beforeOffline, exactLayoutSnapshot(await paneList(ctx, WINDOW_ID))),
        "offline-window refusal mutated the connected window",
      );

      const invalidPaneNew = await cliFailure(ctx, WINDOW_ID, [
        "pane",
        "new",
        "right",
        "--window",
        WINDOW_ID,
        "--pane",
        "pane-does-not-exist",
      ]);
      check(
        /no such pane pane-does-not-exist/i.test(
          invalidPaneNew.stdout + invalidPaneNew.stderr + invalidPaneNew.message,
        ) &&
          !/missing `?paneId/i.test(
            invalidPaneNew.stdout + invalidPaneNew.stderr + invalidPaneNew.message,
          ),
        "pane new refusal must preserve the SPA reason instead of reporting a missing paneId",
      );

      const invalidPaneAck = await cli(ctx, WINDOW_ID, [
        "open",
        layoutFileA,
        "--window",
        WINDOW_ID,
        "--pane",
        "pane-does-not-exist",
        "--side",
        "b",
      ]);
      check(
        /queued/i.test(
          rendered(invalidPaneAck.stdout) + rendered(invalidPaneAck.stderr),
        ),
        "valid-window opener should acknowledge queueing before SPA placement",
      );
      await page.waitForFunction(
        () =>
          document
            .querySelector(".status-msg")
            ?.textContent?.includes("placement failed: no such pane"),
        { timeout: 10_000 },
      );
      await sleep(300);
      check(
        sameJson(beforeOffline, exactLayoutSnapshot(await paneList(ctx, WINDOW_ID))),
        "queued invalid-pane opener mutated the layout",
      );
      await ctx.shot("invalid-pane-no-mutation", page);

      const rightNew = await cli(ctx, WINDOW_ID, [
        "pane",
        "new",
        "right",
        "--window",
        WINDOW_ID,
        "--pane",
        leftId,
      ]);
      const rightId = rendered(rightNew.stdout).trim();
      snapshot = await pollLayout(
        ctx,
        WINDOW_ID,
        (value) =>
          value.panes.length === 2 &&
          value.panes.some((entry) => entry.id === rightId) &&
          value.activePaneId === rightId,
        "canonical pane new right",
      );
      const leftRect = await paneRect(page, leftId);
      const rightRect = await paneRect(page, rightId);
      check(rightRect.x > leftRect.x, "pane new right did not place a pane to the right");

      const bottomNew = await cli(ctx, WINDOW_ID, [
        "pane",
        "new",
        "bottom",
        "--window",
        WINDOW_ID,
        "--pane",
        rightId,
      ]);
      const bottomId = rendered(bottomNew.stdout).trim();
      await pollLayout(
        ctx,
        WINDOW_ID,
        (value) => value.panes.some((entry) => entry.id === bottomId),
        "canonical pane new bottom",
      );
      const bottomRect = await paneRect(page, bottomId);
      check(
        bottomRect.y > (await paneRect(page, rightId)).y,
        "pane new bottom did not place a pane below its target",
      );
      await cli(ctx, WINDOW_ID, [
        "pane",
        "close",
        bottomId,
        "--window",
        WINDOW_ID,
        "--force",
      ]);
      await pollLayout(
        ctx,
        WINDOW_ID,
        (value) => value.panes.length === 2 && !pane(value, bottomId),
        "canonical pane close",
      );

      const splitAlias = await cli(ctx, WINDOW_ID, [
        "pane",
        "split",
        "right",
        "--window",
        WINDOW_ID,
        "--pane",
        rightId,
      ]);
      const aliasPaneId = rendered(splitAlias.stdout).trim();
      await pollLayout(
        ctx,
        WINDOW_ID,
        (value) => value.panes.some((entry) => entry.id === aliasPaneId),
        "pane split compatibility alias",
      );
      await cli(ctx, WINDOW_ID, [
        "pane",
        "close-pane",
        "--window",
        WINDOW_ID,
        "--pane",
        aliasPaneId,
        "--force",
      ]);
      snapshot = await pollLayout(
        ctx,
        WINDOW_ID,
        (value) => value.panes.length === 2 && !pane(value, aliasPaneId),
        "pane close-pane compatibility alias",
      );

      const widthsBefore = {
        left: (await paneRect(page, leftId)).width,
        right: (await paneRect(page, rightId)).width,
      };
      await cli(ctx, WINDOW_ID, [
        "pane",
        "resize",
        "0.12",
        "--window",
        WINDOW_ID,
        "--pane",
        leftId,
      ]);
      const widthsResized = await pollValue(
        async () => ({
          left: (await paneRect(page, leftId)).width,
          right: (await paneRect(page, rightId)).width,
        }),
        (value) => value.left > widthsBefore.left + 20,
        "CLI pane resize geometry",
      );
      check(
        widthsResized.left > widthsBefore.left + 20 &&
          widthsResized.right < widthsBefore.right - 20,
        "pane resize did not grow its target split",
      );
      await cli(ctx, WINDOW_ID, [
        "pane",
        "equalize",
        "--window",
        WINDOW_ID,
        "--pane",
        leftId,
      ]);
      const widthsEqual = await pollValue(
        async () => ({
          left: (await paneRect(page, leftId)).width,
          right: (await paneRect(page, rightId)).width,
        }),
        (value) => Math.abs(value.left - value.right) < 6,
        "CLI pane equalize geometry",
      );
      check(
        Math.abs(widthsEqual.left - widthsEqual.right) < 6,
        "pane equalize did not restore an even split",
      );

      await cli(ctx, WINDOW_ID, [
        "pane",
        "focus",
        rightId,
        "--window",
        WINDOW_ID,
        "--side",
        "b",
      ]);
      snapshot = await paneList(ctx, WINDOW_ID);
      check(
        snapshot.activePaneId === rightId && pane(snapshot, rightId)?.activeSide === "b",
        "pane focus did not select the requested pane and side B",
      );

      await cli(ctx, WINDOW_ID, [
        "open",
        layoutFileA,
        "--window",
        WINDOW_ID,
        "--pane",
        leftId,
        "--side",
        "a",
      ]);
      await pollLayout(
        ctx,
        WINDOW_ID,
        (value) =>
          !!tabOn(
            value,
            leftId,
            "a",
            (tab) => tab.kind === "file" && tab.title === layoutFileA,
          ),
        "cs open file placement",
      );

      await cli(ctx, WINDOW_ID, [
        "open",
        layoutDir,
        "--window",
        WINDOW_ID,
        "--pane",
        leftId,
        "--side",
        "b",
      ]);
      await pollLayout(
        ctx,
        WINDOW_ID,
        (value) => !!tabOn(value, leftId, "b", (tab) => tab.kind === "browser"),
        "cs open directory placement",
      );

      await cli(ctx, WINDOW_ID, [
        "graph",
        ".",
        "--window",
        WINDOW_ID,
        "--pane",
        rightId,
        "--side",
        "a",
      ]);
      await pollLayout(
        ctx,
        WINDOW_ID,
        (value) => !!tabOn(value, rightId, "a", (tab) => tab.kind === "graph"),
        "cs graph placement",
      );

      await cli(ctx, WINDOW_ID, [
        "open",
        "chan://graph?s=workspace&m=s",
        "--window",
        WINDOW_ID,
        "--pane",
        rightId,
        "--side",
        "b",
      ]);
      await pollLayout(
        ctx,
        WINDOW_ID,
        (value) => !!tabOn(value, rightId, "b", (tab) => tab.kind === "graph"),
        "cs open graph-link placement",
      );

      await cli(ctx, WINDOW_ID, [
        "dashboard",
        "--carousel-index",
        "2",
        "--carousel-off",
        "--window",
        WINDOW_ID,
        "--pane",
        leftId,
        "--side",
        "b",
      ]);
      await pollLayout(
        ctx,
        WINDOW_ID,
        (value) => !!tabOn(value, leftId, "b", (tab) => tab.kind === "dashboard"),
        "cs dashboard placement",
      );

      const sideTerminal = "cs-side-terminal";
      await cli(ctx, WINDOW_ID, [
        "terminal",
        "new",
        "--tab-name",
        sideTerminal,
        "--tab-group",
        "cs-pane-layout",
        "--window",
        WINDOW_ID,
        "--pane",
        rightId,
        "--side",
        "b",
      ]);
      snapshot = await pollLayout(
        ctx,
        WINDOW_ID,
        (value) =>
          !!tabOn(
            value,
            rightId,
            "b",
            (tab) =>
              tab.kind === "terminal" &&
              tab.title === sideTerminal &&
              tab.live === true,
          ),
        "cs terminal new placement and live attach",
        25_000,
      );
      await ctx.shot("cli-destination-openers", page);

      let terminals = await pollTerminals(
        ctx,
        WINDOW_ID,
        (value) =>
          terminalRows(value).some(
            (row) =>
              row.name === sideTerminal &&
              row.window === WINDOW_ID &&
              row.pane === rightId,
          ),
        "terminal list attachment",
        20_000,
      );
      let terminalRow = terminalRows(terminals).find(
        (row) => row.name === sideTerminal,
      );
      check(
        terminalRow?.side === "b",
        `terminal list must report live side B (got ${JSON.stringify(terminalRow)})`,
      );
      const sideTerminalSocketCount = () =>
        terminalSocketUrls.filter((url) =>
          url.includes(`tab_name=${encodeURIComponent(sideTerminal)}`),
        ).length;
      const sideTerminalSocketsBeforeMove = sideTerminalSocketCount();
      check(
        sideTerminalSocketsBeforeMove === 1,
        `terminal should have one PTY socket before side movement, got ${sideTerminalSocketsBeforeMove}`,
      );
      const terminalHuman = rendered(
        (await cli(ctx, WINDOW_ID, ["terminal", "list"])).stdout,
      );
      check(
        /\|\s*side\s*\|/i.test(terminalHuman) &&
          new RegExp(`\\|\\s*${sideTerminal}\\s*\\|[^\\n]*\\|\\s*[Bb]\\s*\\|`).test(
            terminalHuman,
          ),
        "human terminal list must include a side column and B for the terminal",
      );

      await cli(ctx, WINDOW_ID, [
        "pane",
        "focus",
        rightId,
        "--window",
        WINDOW_ID,
        "--side",
        "b",
      ]);
      await clickTab(page, rightId, sideTerminal);
      check(
        (await launcherRun(page, "Send tab to side A")) === "Send tab to side A",
        "launcher did not select the Send tab to side A row",
      );
      snapshot = await pollLayout(
        ctx,
        WINDOW_ID,
        (value) =>
          !!tabOn(
            value,
            rightId,
            "a",
            (tab) => tab.kind === "terminal" && tab.title === sideTerminal,
          ),
        "launcher send terminal to side A",
      );
      const sideARegistry = await maybePollValue(
        () => terminalList(ctx, WINDOW_ID),
        (value) =>
          terminalRows(value).some(
            (row) => row.name === sideTerminal && row.side === "a",
          ),
      );
      check(!!sideARegistry, "live terminal placement did not update to side A");

      check(
        (await launcherRun(page, "Send tab to side B")) === "Send tab to side B",
        "launcher did not select the Send tab to side B row",
      );
      await pollLayout(
        ctx,
        WINDOW_ID,
        (value) =>
          !!tabOn(
            value,
            rightId,
            "b",
            (tab) => tab.kind === "terminal" && tab.title === sideTerminal,
          ),
        "launcher send terminal back to side B",
      );
      const sideBRegistry = await maybePollValue(
        () => terminalList(ctx, WINDOW_ID),
        (value) =>
          terminalRows(value).some(
            (row) => row.name === sideTerminal && row.side === "b",
          ),
      );
      check(!!sideBRegistry, "live terminal placement did not update back to side B");
      await sleep(300);
      check(
        sideTerminalSocketCount() === sideTerminalSocketsBeforeMove,
        "moving a live terminal between A and B reconnected its PTY socket",
      );

      await launcherRun(page, "Flip pane");
      await pollLayout(
        ctx,
        WINDOW_ID,
        (value) => pane(value, rightId)?.activeSide === "a",
        "launcher flip pane to A",
      );
      await waitForFlipSettle(page, rightId);
      await launcherRun(page, "Flip pane");
      await pollLayout(
        ctx,
        WINDOW_ID,
        (value) => pane(value, rightId)?.activeSide === "b",
        "launcher flip pane back to B",
      );
      await waitForFlipSettle(page, rightId);

      const beforeSwap = await paneList(ctx, WINDOW_ID);
      await cli(ctx, WINDOW_ID, [
        "pane",
        "swap",
        rightId,
        "--window",
        WINDOW_ID,
        "--pane",
        leftId,
      ]);
      const afterSwap = await paneList(ctx, WINDOW_ID);
      check(
        sameJson(paneContent(afterSwap, leftId), paneContent(beforeSwap, rightId)) &&
          sameJson(paneContent(afterSwap, rightId), paneContent(beforeSwap, leftId)),
        "pane swap must exchange complete two-sided contents",
      );
      check(
        afterSwap.activePaneId === rightId,
        "pane swap must move focus to the destination pane",
      );
      await cli(ctx, WINDOW_ID, [
        "pane",
        "swap",
        rightId,
        "--window",
        WINDOW_ID,
        "--pane",
        leftId,
      ]);

      await cli(ctx, WINDOW_ID, [
        "pane",
        "focus",
        leftId,
        "--window",
        WINDOW_ID,
        "--side",
        "a",
      ]);
      const beforeLauncherSplit = await paneList(ctx, WINDOW_ID);
      check(
        (await launcherRun(page, "Split right")) === "Split right",
        "launcher did not select Split right",
      );
      let launcherSplit = await pollLayout(
        ctx,
        WINDOW_ID,
        (value) => value.panes.length === beforeLauncherSplit.panes.length + 1,
        "launcher split right",
      );
      const launcherRightId = launcherSplit.panes.find(
        (entry) => !beforeLauncherSplit.panes.some((old) => old.id === entry.id),
      )?.id;
      if (!launcherRightId) throw new Error("launcher split right minted no pane id");

      const activeAfterRight = launcherSplit.activePaneId;
      await launcherRun(page, "Previous pane");
      const afterPrevious = await paneList(ctx, WINDOW_ID);
      check(
        afterPrevious.activePaneId !== activeAfterRight,
        "launcher Previous pane did not cycle focus",
      );
      await launcherRun(page, "Next pane");
      const afterNext = await paneList(ctx, WINDOW_ID);
      check(
        afterNext.activePaneId === activeAfterRight,
        "launcher Next pane did not restore the cycled focus",
      );

      check(
        (await launcherRun(page, "Split bottom")) === "Split bottom",
        "launcher did not select Split bottom",
      );
      launcherSplit = await pollLayout(
        ctx,
        WINDOW_ID,
        (value) => value.panes.length === beforeLauncherSplit.panes.length + 2,
        "launcher split bottom",
      );
      const launcherBottomId = launcherSplit.activePaneId;
      await launcherRun(page, "Close pane", "Close pane", true);
      await pollLayout(
        ctx,
        WINDOW_ID,
        (value) => value.panes.length === beforeLauncherSplit.panes.length + 1,
        "launcher close bottom pane",
      );
      check(
        !(await paneList(ctx, WINDOW_ID)).panes.some(
          (entry) => entry.id === launcherBottomId,
        ),
        "launcher Close pane left the active bottom pane behind",
      );
      await cli(ctx, WINDOW_ID, [
        "pane",
        "focus",
        launcherRightId,
        "--window",
        WINDOW_ID,
      ]);
      await launcherRun(page, "Close pane", "Close pane", true);
      await pollLayout(
        ctx,
        WINDOW_ID,
        (value) => value.panes.length === beforeLauncherSplit.panes.length,
        "launcher close right pane",
      );

      await cli(ctx, WINDOW_ID, [
        "pane",
        "focus",
        leftId,
        "--window",
        WINDOW_ID,
        "--side",
        "a",
      ]);
      await launcherRun(page, `Open ${layoutFileLauncher}`, "Open");
      await pollLayout(
        ctx,
        WINDOW_ID,
        (value) =>
          !!tabOn(
            value,
            leftId,
            "a",
            (tab) => tab.kind === "file" && tab.title === layoutFileLauncher,
          ),
        "launcher Open placement",
      );

      const launcherKinds = [
        ["New file browser", "browser"],
        ["New graph", "graph"],
        ["New dashboard", "dashboard"],
        ["New terminal", "terminal"],
      ];
      for (const [title, kind] of launcherKinds) {
        const countBefore = sideTabs(await paneList(ctx, WINDOW_ID), leftId, "a").filter(
          (tab) => tab.kind === kind,
        ).length;
        const selected = await launcherRun(page, title);
        check(selected === title, `launcher selected ${selected}, expected ${title}`);
        await pollLayout(
          ctx,
          WINDOW_ID,
          (value) =>
            sideTabs(value, leftId, "a").filter((tab) => tab.kind === kind).length >
            countBefore,
          `launcher ${title} placement`,
          kind === "terminal" ? 25_000 : 15_000,
        );
      }

      const tabsBeforeTeamDialog = sideTabs(
        await paneList(ctx, WINDOW_ID),
        leftId,
        "a",
      ).length;
      await launcherRun(page, "New team");
      await page.waitForSelector(".team-dialog", { timeout: 15_000 });
      check(
        sideTabs(await paneList(ctx, WINDOW_ID), leftId, "a").length ===
          tabsBeforeTeamDialog + 1,
        "launcher New team did not create its contextual lead terminal",
      );
      await page.click(".team-dialog-cancel");
      await page.waitForSelector(".team-dialog", { hidden: true, timeout: 15_000 });
      await pollLayout(
        ctx,
        WINDOW_ID,
        (value) => sideTabs(value, leftId, "a").length === tabsBeforeTeamDialog,
        "launcher New team cancellation cleanup",
        20_000,
      );
      await ctx.shot("launcher-contextual-openers", page);

      await cli(ctx, WINDOW_ID, [
        "pane",
        "focus",
        leftId,
        "--window",
        WINDOW_ID,
        "--side",
        "a",
      ]);
      await launcherRun(page, "Enter hybrid navigation");
      await page.waitForSelector(".app.pane-mode", { timeout: 10_000 });
      const hybridWidthBefore = (await paneRect(page, leftId)).width;
      await page.keyboard.press("]");
      const hybridWidthResized = await pollValue(
        async () => (await paneRect(page, leftId)).width,
        (value) => Math.abs(value - hybridWidthBefore) > 5,
        "Hybrid Nav resize geometry",
      );
      check(
        Math.abs(hybridWidthResized - hybridWidthBefore) > 5,
        "Hybrid Nav ] did not resize the horizontal split",
      );
      await page.keyboard.press("0");
      const hybridEqual = await pollValue(
        async () => ({
          left: (await paneRect(page, leftId)).width,
          right: (await paneRect(page, rightId)).width,
        }),
        (value) => Math.abs(value.left - value.right) < 6,
        "Hybrid Nav equalize geometry",
      );
      check(
        Math.abs(hybridEqual.left - hybridEqual.right) < 6,
        "Hybrid Nav 0 did not equalize the split",
      );
      await page.keyboard.press("Enter");
      await page.waitForSelector(".app.pane-mode", { hidden: true, timeout: 10_000 });
      await cli(ctx, WINDOW_ID, [
        "pane",
        "swap",
        rightId,
        "--window",
        WINDOW_ID,
        "--pane",
        leftId,
      ]);

      await cli(ctx, WINDOW_ID, [
        "pane",
        "focus",
        leftId,
        "--window",
        WINDOW_ID,
        "--side",
        "b",
      ]);
      const dashboardsBeforeHamburger = sideTabs(
        await paneList(ctx, WINDOW_ID),
        leftId,
        "b",
      ).filter((tab) => tab.kind === "dashboard").length;
      await hamburgerRun(page, leftId, "New dashboard");
      await pollLayout(
        ctx,
        WINDOW_ID,
        (value) =>
          sideTabs(value, leftId, "b").filter((tab) => tab.kind === "dashboard")
            .length > dashboardsBeforeHamburger,
        "pane hamburger contextual dashboard",
      );

      await cli(ctx, WINDOW_ID, [
        "terminal",
        "team",
        "new",
        TEAM_DIR,
        "--config",
        teamConfigPath,
        "--window",
        WINDOW_ID,
        "--pane",
        leftId,
        "--side",
        "b",
      ]);
      await pollLayout(
        ctx,
        WINDOW_ID,
        (value) =>
          TEAM_HANDLES.every(
            (handle) =>
              !!tabOn(
                value,
                leftId,
                "b",
                (tab) =>
                  tab.kind === "terminal" &&
                  tab.title === handle &&
                  tab.live === true,
              ),
          ),
        "terminal team new placement",
        30_000,
      );
      terminals = await pollTerminals(
        ctx,
        WINDOW_ID,
        (value) =>
          TEAM_HANDLES.every((handle) =>
            terminalRows(value).some(
              (row) =>
                row.group === TEAM_GROUP &&
                row.name === handle &&
                row.pane === leftId,
            ),
          ),
        "terminal team new registry",
        20_000,
      );
      for (const handle of TEAM_HANDLES) {
        const row = terminalRows(terminals).find(
          (entry) => entry.group === TEAM_GROUP && entry.name === handle,
        );
        check(row?.side === "b", `team new ${handle} must report side B`);
      }
      await cli(ctx, WINDOW_ID, [
        "terminal",
        "close",
        "--tab-group",
        TEAM_GROUP,
      ]);
      await pollTerminals(
        ctx,
        WINDOW_ID,
        (value) =>
          !terminalRows(value).some((row) => row.group === TEAM_GROUP),
        "terminal team new teardown",
        20_000,
      );
      await closeTabsNamed(ctx, WINDOW_ID, TEAM_HANDLES);

      await cli(ctx, WINDOW_ID, [
        "terminal",
        "team",
        "load",
        TEAM_DIR,
        "--window",
        WINDOW_ID,
        "--pane",
        rightId,
        "--side",
        "a",
      ]);
      await pollLayout(
        ctx,
        WINDOW_ID,
        (value) =>
          TEAM_HANDLES.every(
            (handle) =>
              !!tabOn(
                value,
                rightId,
                "a",
                (tab) =>
                  tab.kind === "terminal" &&
                  tab.title === handle &&
                  tab.live === true,
              ),
          ),
        "terminal team load placement",
        30_000,
      );
      terminals = await pollTerminals(
        ctx,
        WINDOW_ID,
        (value) =>
          TEAM_HANDLES.every((handle) =>
            terminalRows(value).some(
              (row) =>
                row.group === TEAM_GROUP &&
                row.name === handle &&
                row.pane === rightId,
            ),
          ),
        "terminal team load registry",
        20_000,
      );
      for (const handle of TEAM_HANDLES) {
        const row = terminalRows(terminals).find(
          (entry) => entry.group === TEAM_GROUP && entry.name === handle,
        );
        check(row?.side === "a", `team load ${handle} must report side A`);
      }
      await cli(ctx, WINDOW_ID, [
        "terminal",
        "close",
        "--tab-group",
        TEAM_GROUP,
      ]);
      await pollTerminals(
        ctx,
        WINDOW_ID,
        (value) =>
          !terminalRows(value).some((row) => row.group === TEAM_GROUP),
        "terminal team load teardown",
        20_000,
      );
      await closeTabsNamed(ctx, WINDOW_ID, TEAM_HANDLES);

      const hiddenNew = await cli(ctx, WINDOW_ID, [
        "pane",
        "new",
        "bottom",
        "--window",
        WINDOW_ID,
        "--pane",
        rightId,
      ]);
      const hiddenPaneId = rendered(hiddenNew.stdout).trim();
      const hiddenTerminal = "cs-hidden-side-terminal";
      await cli(ctx, WINDOW_ID, [
        "terminal",
        "new",
        "--tab-name",
        hiddenTerminal,
        "--tab-group",
        "cs-pane-layout",
        "--window",
        WINDOW_ID,
        "--pane",
        hiddenPaneId,
        "--side",
        "b",
      ]);
      await pollLayout(
        ctx,
        WINDOW_ID,
        (value) =>
          !!tabOn(
            value,
            hiddenPaneId,
            "b",
            (tab) =>
              tab.kind === "terminal" &&
              tab.title === hiddenTerminal &&
              tab.live === true,
          ),
        "hidden-side terminal attach",
        25_000,
      );
      await cli(ctx, WINDOW_ID, [
        "pane",
        "focus",
        hiddenPaneId,
        "--window",
        WINDOW_ID,
        "--side",
        "a",
      ]);
      const blockedClose = await cliFailure(ctx, WINDOW_ID, [
        "pane",
        "close",
        hiddenPaneId,
        "--window",
        WINDOW_ID,
        "--json",
      ]);
      let blockedPayload = null;
      try {
        blockedPayload = JSON.parse(blockedClose.stdout);
      } catch {}
      check(
        blockedPayload?.ok === false &&
          blockedPayload?.blocked?.some(
            (entry) =>
              entry.tab === hiddenTerminal && entry.reason === "live terminal",
          ),
        `hidden side B terminal did not block unforced close: ${blockedClose.stdout}`,
      );
      check(
        !!pane(await paneList(ctx, WINDOW_ID), hiddenPaneId),
        "blocked hidden-side close mutated the pane",
      );
      await cli(ctx, WINDOW_ID, [
        "pane",
        "close",
        hiddenPaneId,
        "--window",
        WINDOW_ID,
        "--force",
      ]);
      await pollLayout(
        ctx,
        WINDOW_ID,
        (value) => !pane(value, hiddenPaneId),
        "forced hidden-side pane close",
      );
      await ctx.shot("hidden-side-close-guard", page);

      const saveResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          response.url().includes("/api/session") &&
          response.ok(),
        { timeout: 15_000 },
      );
      await cli(ctx, WINDOW_ID, [
        "pane",
        "focus",
        leftId,
        "--window",
        WINDOW_ID,
        "--side",
        "a",
      ]);
      await saveResponse;
      await sleep(800);
      const persistedBefore = await semanticLayout(
        page,
        await paneList(ctx, WINDOW_ID),
      );
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(".pane", { timeout: 30_000 });
      const restored = await pollValue(
        async () => {
          const snapshot = await paneList(ctx, WINDOW_ID);
          return {
            snapshot,
            semantic: await semanticLayout(page, snapshot),
          };
        },
        (value) => sameJson(value.semantic, persistedBefore),
        "persisted pane layout after reload",
        30_000,
      );
      check(
        sameJson(restored.semantic, persistedBefore),
        "reload did not preserve spatial pane shape, sides, ordered tabs, and active positions",
      );
      await ctx.shot("persisted-after-reload", page);

      if (failures.length > 0) {
        throw new Error(
          `${failures.length} cs pane contract failure(s):\n- ${failures.join("\n- ")}`,
        );
      }

      return {
        windowId: WINDOW_ID,
        paneCount: restored.snapshot.panes.length,
        openerDestinations: [
          "open file",
          "open directory",
          "open graph link",
          "graph",
          "dashboard",
          "terminal new",
          "terminal team new",
          "terminal team load",
        ],
        launcherRows: [
          "Open",
          "New file browser",
          "New graph",
          "New dashboard",
          "New terminal",
          "New team",
          "Split right",
          "Split bottom",
          "Previous pane",
          "Next pane",
          "Flip pane",
          "Close pane",
          "Send tab to side A",
          "Send tab to side B",
          "Enter hybrid navigation",
        ],
      };
    } catch (error) {
      await ctx.shot("failure-own-window", page).catch(() => {});
      throw error;
    } finally {
      await page.close().catch(() => {});
      rmSync(join(ctx.workspaceDir, TEAM_DIR), { recursive: true, force: true });
    }
  },
};
