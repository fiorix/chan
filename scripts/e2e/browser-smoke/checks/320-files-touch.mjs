// The file browser on a touch screen, driven by real touch input. While
// Details is closed a tap opens a file and enters a folder, and the second tap
// of a double tap opens nothing on the row that lands under the finger. With
// Details open a tap shows the row there, and in Select multiple it toggles.
// A touch row is 44px tall and ends in a button that opens its menu. A mouse
// keeps select and double click and sees no button. In landscape behind a
// notch, the window, its tab bar, an overlay, a row's menu and the status pill
// stay inside the safe areas.
//
// Each leg runs in its own window and is judged alone, so a failure names
// every behaviour that is missing rather than the first.

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { navigateFiles, readFiles, showFiles, waitFileRow } from "../lib/files.mjs";

const DIR = "00touch320";
const FILES = ["alpha.md", "beta.md", ...Array.from({ length: 8 }, (_, i) => `c0${i}.md`)];
const PHONE = { width: 390, height: 844, hasTouch: true, isMobile: true };
const LANDSCAPE = { width: 844, height: 390, hasTouch: true, isMobile: true };
const DESKTOP = { width: 1200, height: 800 };
const INSETS = { top: 47, left: 59, bottom: 21, right: 59 };
const DETAILS = 'button[aria-label="Details"][aria-pressed]';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function command(page, name) {
  return page.evaluate((name) => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name } })), name);
}

// A Files tab's title names its selection, so it can end in a file's name too.
function openFileTabs(page) {
  return page.$$eval('[role="tablist"] .tab', (tabs) => tabs.map((tab) => tab.title)
    .filter((title) => title.endsWith(".md") && !title.startsWith("File Browser")));
}

async function selectMultiple(page) {
  await page.click(".browser-toolbar .hamburger-trigger");
  await page.waitForSelector(".hamburger-menu", { visible: true, timeout: 5_000 });
  const handle = await page.evaluateHandle(() => [...document.querySelectorAll('.hamburger-menu [role="menuitemcheckbox"]')]
    .find((item) => item.textContent.includes("Select multiple")));
  const item = handle.asElement();
  assert.ok(item, "the file browser's menu has Select multiple");
  await item.click();
  await page.waitForSelector(".selection-mode", { timeout: 5_000 });
}

async function waitOpen(page, name) {
  await page.waitForFunction((title) => [...document.querySelectorAll('[role="tablist"] .tab')].some((tab) =>
    tab.title === title && tab.querySelector('[role="tab"]')?.getAttribute("aria-selected") === "true"),
  { timeout: 10_000 }, `${DIR}/${name}`);
}

async function waitDirectory(page, directory) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const state = await readFiles(page);
    if (state.directory === directory && state.rows.length) return state;
    if (Date.now() > deadline) throw new Error(`the listing stayed on ${JSON.stringify(state.directory)}`);
    await sleep(100);
  }
}

async function namePoint(page, name) {
  const row = await waitFileRow(page, name);
  const label = await row.$(".name");
  await label.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const box = await label.boundingBox();
  await label.dispose();
  await row.dispose();
  return { x: box.x + Math.min(box.width / 2, 40), y: box.y + box.height / 2 };
}

async function tapRow(page, name) {
  const { x, y } = await namePoint(page, name);
  await page.touchscreen.tap(x, y);
}

async function selectedNames(page) {
  return (await readFiles(page)).rows.filter((row) => row.selected).map((row) => row.name);
}

async function showDetails(page, open) {
  await page.waitForSelector(DETAILS, { timeout: 10_000 });
  const pressed = await page.$eval(DETAILS, (el) => el.getAttribute("aria-pressed") === "true");
  if (pressed !== open) await page.click(DETAILS);
  await page.waitForFunction((selector, open) => document.querySelector(selector)?.getAttribute("aria-pressed") === String(open),
    { timeout: 5_000 }, DETAILS, open);
}

function within(rect, width, height, label) {
  assert.ok(rect, `${label} is on the page`);
  const inside = rect.left >= INSETS.left - 0.5 && rect.right <= width - INSETS.right + 0.5 &&
    rect.top >= INSETS.top - 0.5 && rect.bottom <= height - INSETS.bottom + 0.5;
  assert.ok(inside, `${label} stays inside the safe areas: ${JSON.stringify(rect)}`);
}

function rectOf(page, selector) {
  return page.evaluate((selector) => {
    const rect = document.querySelector(selector)?.getBoundingClientRect();
    return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null;
  }, selector);
}

async function emulateInsets(page) {
  const cdp = await page.createCDPSession();
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: INSETS });
  return cdp;
}

// Puppeteer's own evaluate grants a user gesture, which turns `chan shell
// upload` into a file chooser, so the pill's leg reads with none.
async function quietRead(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", { expression: `JSON.stringify(${expression})`, returnByValue: true, userGesture: false });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return JSON.parse(response.result.value);
}

async function quietWait(cdp, expression, label) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await quietRead(cdp, expression);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`waiting for ${label}`);
    await sleep(100);
  }
}

const LEGS = [
  {
    label: "tap-opens-file",
    viewport: PHONE,
    async run(page) {
      await tapRow(page, "alpha.md");
      await waitOpen(page, "alpha.md");
    },
  },
  {
    label: "tap-on-row-background-opens-file",
    viewport: PHONE,
    async run(page) {
      const row = await waitFileRow(page, "beta.md");
      const size = await row.$(".entry-size");
      const box = await size.boundingBox();
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await waitOpen(page, "beta.md");
    },
  },
  {
    label: "tap-enters-folder",
    viewport: PHONE,
    directory: "",
    async run(page) {
      await tapRow(page, DIR);
      await waitDirectory(page, DIR);
    },
  },
  {
    label: "double-tap-opens-nothing",
    viewport: PHONE,
    directory: "",
    async run(page) {
      const { x, y } = await namePoint(page, DIR);
      await page.touchscreen.tap(x, y);
      await page.touchscreen.tap(x, y);
      await waitDirectory(page, DIR);
      await sleep(700);
      const under = await page.evaluate((x, y) => document.elementFromPoint(x, y)?.closest('[role="option"]')?.title ?? null, x, y);
      assert.ok(under?.includes(`${DIR}/`), `a row of the folder lies under the finger: ${under}`);
      assert.deepEqual(await openFileTabs(page), [], "the second tap opened nothing");
    },
  },
  {
    label: "details-open-shows-row",
    viewport: PHONE,
    async run(page) {
      await showDetails(page, true);
      await tapRow(page, "beta.md");
      await page.waitForFunction(() => document.querySelector('aside[aria-label="Details"]')?.textContent.includes("beta.md"),
        { timeout: 5_000 });
      await sleep(300);
      assert.deepEqual(await selectedNames(page), ["beta.md"]);
      assert.deepEqual(await openFileTabs(page), [], "a tap with Details open opened nothing");
    },
  },
  {
    label: "select-multiple-toggles",
    viewport: PHONE,
    async run(page) {
      await selectMultiple(page);
      await tapRow(page, "alpha.md");
      await sleep(450);
      await tapRow(page, "beta.md");
      await sleep(300);
      assert.deepEqual((await selectedNames(page)).sort(), ["alpha.md", "beta.md"]);
      assert.deepEqual(await openFileTabs(page), [], "a tap in Select multiple opened nothing");
    },
  },
  {
    label: "touch-row-menu",
    viewport: PHONE,
    async run(page) {
      const row = await waitFileRow(page, "beta.md");
      const height = await row.evaluate((el) => el.getBoundingClientRect().height);
      assert.ok(height >= 44, `a touch row is at least 44px tall: ${height}`);
      const button = await row.$(".row-menu");
      assert.ok(button, "the row has a menu button");
      const box = await button.boundingBox();
      assert.ok(box && box.width >= 44, `the menu button is a finger wide: ${JSON.stringify(box)}`);
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForSelector('.ctx[role="menu"]', { visible: true, timeout: 5_000 });
      assert.deepEqual(await openFileTabs(page), [], "the button opened the menu and not the file");
    },
  },
  {
    label: "mouse-selects-then-double-click",
    viewport: DESKTOP,
    async run(page) {
      await showDetails(page, false);
      const row = await waitFileRow(page, "alpha.md");
      const shape = await row.evaluate((el) => ({
        height: el.getBoundingClientRect().height,
        button: getComputedStyle(el.querySelector(".row-menu") ?? document.body).display,
        hasButton: Boolean(el.querySelector(".row-menu")),
      }));
      assert.ok(shape.height < 44, `a mouse row keeps its height: ${shape.height}`);
      if (shape.hasButton) assert.equal(shape.button, "none", "a mouse sees no menu button");
      await row.click();
      await sleep(500);
      assert.deepEqual(await selectedNames(page), ["alpha.md"]);
      assert.deepEqual(await openFileTabs(page), [], "a mouse click opened nothing");
      await row.click({ count: 2 });
      await waitOpen(page, "alpha.md");
    },
  },
  {
    label: "landscape-safe-areas",
    viewport: LANDSCAPE,
    files: false,
    async prepare(page) {
      await page.evaluateOnNewDocument(() => localStorage.setItem("chan.windowTabBar", "1"));
      await emulateInsets(page);
    },
    async run(page) {
      const { width, height } = LANDSCAPE;
      const applied = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.cssText = "position:fixed;padding-left:env(safe-area-inset-left,0px);padding-top:env(safe-area-inset-top,0px)";
        document.body.append(probe);
        const style = getComputedStyle(probe);
        const read = { left: style.paddingLeft, top: style.paddingTop };
        probe.remove();
        return read;
      });
      assert.deepEqual(applied, { left: `${INSETS.left}px`, top: `${INSETS.top}px` }, "the emulated insets reach the page");
      await page.waitForSelector(".app > .window-tab-bar", { timeout: 10_000 });
      within(await rectOf(page, ".app"), width, height, "the window");
      within(await rectOf(page, ".app > .window-tab-bar"), width, height, "the window tab bar");
      await command(page, "app.settings.open");
      await page.waitForSelector(".overlay .panel", { visible: true, timeout: 10_000 });
      await page.waitForFunction(() => document.querySelector(".overlay .panel")?.getAnimations().every((a) => a.playState !== "running"),
        { timeout: 5_000 });
      within(await rectOf(page, ".overlay .panel"), width, height, "an overlay");
    },
  },
  {
    label: "landscape-row-menu",
    viewport: LANDSCAPE,
    prepare: emulateInsets,
    async run(page) {
      const { width, height } = LANDSCAPE;
      const row = await waitFileRow(page, "c07.md");
      const button = await row.$(".row-menu");
      assert.ok(button, "the row has a menu button");
      await button.evaluate((el) => el.scrollIntoView({ block: "center" }));
      const box = await button.boundingBox();
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForSelector('.ctx[role="menu"]', { visible: true, timeout: 5_000 });
      await page.waitForFunction(() => document.querySelector(".ctx")?.getAnimations().every((a) => a.playState !== "running"),
        { timeout: 5_000 });
      await sleep(100);
      within(await rectOf(page, ".ctx"), width, height, "the row's menu");
    },
  },
  {
    label: "landscape-status-pill",
    viewport: LANDSCAPE,
    files: false,
    control: true,
    prepare: emulateInsets,
    async run(page, ctx) {
      const { width, height } = LANDSCAPE;
      const windowId = "files-touch-320-landscape-status-pill";
      await ctx.waitWindowLive(windowId);
      const cdp = await page.createCDPSession();
      await quietWait(cdp, "navigator.userActivation.isActive === false", "user activation to lapse");
      const env = { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId };
      await ctx.exec(ctx.chanBin, ["shell", "upload", DIR], { cwd: ctx.workspaceDir, env, timeout: 60_000 });
      await quietWait(cdp, "Boolean(document.querySelector('[data-app-status-pill]'))", "the status pill");
      const rect = await quietRead(cdp, `(() => {
        const box = document.querySelector('[data-app-status-pill]').getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      })()`);
      within(rect, width, height, "the status pill");
    },
  },
];

// The path field can close under the press while a new tab settles its focus.
// This is a leg's setup, so it tries again rather than fail the behaviour.
async function enterDirectory(page, directory) {
  page.setDefaultTimeout(5_000);
  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await sleep(300);
        return await navigateFiles(page, directory);
      } catch (error) {
        if (attempt === 3) throw error;
      }
    }
  } finally {
    page.setDefaultTimeout(30_000);
  }
}

async function runLeg(ctx, leg) {
  if (leg.control && !ctx.controlSocket) {
    console.log(`[smoke]   ${leg.label}: SKIPPED: it needs the server's control socket`);
    return null;
  }
  const page = await ctx.browser.newPage();
  try {
    await page.setViewport(leg.viewport);
    await leg.prepare?.(page);
    const url = new URL(ctx.serverUrl);
    url.searchParams.set("w", `files-touch-320-${leg.label}`);
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".pane", { timeout: 30_000 });
    if (leg.files !== false) {
      await showFiles(page);
      const directory = leg.directory ?? DIR;
      if (directory) await enterDirectory(page, directory);
    }
    await leg.run(page, ctx);
    console.log(`[smoke]   ${leg.label}: ok`);
    return null;
  } catch (error) {
    console.log(`[smoke]   ${leg.label}: FAILED: ${error.message}`);
    await ctx.shot(`320-${leg.label}`, page).catch(() => {});
    return `${leg.label}: ${error.message}`;
  } finally {
    await page.close().catch(() => {});
  }
}

export default {
  name: "files-touch",
  async run(ctx) {
    const dir = join(ctx.workspaceDir, DIR);
    mkdirSync(dir, { recursive: true });
    for (const name of FILES) writeFileSync(join(dir, name), `# ${name}\n`);
    try {
      const failed = [];
      for (const leg of LEGS) {
        const failure = await runLeg(ctx, leg);
        if (failure) failed.push(failure);
      }
      assert.deepEqual(failed, [], `${failed.length} of ${LEGS.length} legs failed`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
