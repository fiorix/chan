import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { launchServer, seedWorkspace, teardownServer } from "../lib/server.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LAUNCHER_SELECTOR = '[role="dialog"][aria-label="Command launcher"]';
const LAUNCHER_INPUT_SELECTOR = `${LAUNCHER_SELECTOR} input[role="combobox"]`;

async function waitForFile(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    await delay(25);
  }
  throw new Error(`file did not appear: ${path}`);
}

async function waitForProcessExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await delay(25);
  }
  throw new Error(`extension process ${pid} survived Chan shutdown`);
}

async function runLauncherCommand(page, title) {
  await page.bringToFront();
  await page.click(".pane .hamburger-trigger");
  await page.waitForSelector(".hamburger-menu", { visible: true });
  const opened = await page.evaluate(() => {
    const button = [...document.querySelectorAll(".hamburger-menu button")].find(
      (candidate) =>
        candidate.querySelector(".menu-row-label")?.textContent?.trim() === "Commands",
    );
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  });
  if (!opened) throw new Error("pane menu has no Commands row");
  const input = await page.waitForSelector(LAUNCHER_INPUT_SELECTOR, { visible: true });
  await input.click({ clickCount: 3 });
  await page.keyboard.type(title);
  await page.waitForFunction(
    (wanted) =>
      [...document.querySelectorAll('[role="option"] .deck-result-title')].some(
        (node) => node.textContent?.trim() === wanted,
      ),
    {},
    title,
  );
  await page.evaluate((wanted) => {
    const titleNode = [...document.querySelectorAll('[role="option"] .deck-result-title')].find(
      (node) => node.textContent?.trim() === wanted,
    );
    titleNode?.closest('[role="option"]')?.click();
  }, title);
}

async function pressChord(page, modifiers, code) {
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  await page.keyboard.press(code);
  for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
}

export default {
  name: "local extension echo tab",
  async run(ctx) {
    const extensionBin =
      process.env.CHAN_ECHO_EXTENSION_BIN ??
      join(ctx.repoRoot, "target", "debug", "examples", "echo-extension");
    if (!existsSync(extensionBin)) {
      throw new Error(`echo extension binary missing: ${extensionBin}`);
    }

    const workspaceDir = seedWorkspace();
    let server;
    let page;
    let extensionPid = null;
    try {
      server = launchServer(ctx.chanBin, workspaceDir, undefined, {
        prepareChanHome(chanHome) {
          const extensionDir = join(chanHome, "extensions");
          mkdirSync(extensionDir, { recursive: true });
          writeFileSync(
            join(extensionDir, "echo.toml"),
            `name = "Echo test"\ncommand = ${JSON.stringify(extensionBin)}\nargs = ["echo.pid"]\n`,
          );
        },
      });
      const serverUrl = await server.url;
      const pidFile = join(server.chanHome, "extensions", "echo.pid");
      extensionPid = Number.parseInt((await waitForFile(pidFile)).trim(), 10);
      if (!Number.isSafeInteger(extensionPid) || extensionPid <= 0) {
        throw new Error(`invalid extension pid: ${extensionPid}`);
      }
      process.kill(extensionPid, 0);

      const apiUrl = new URL("/api/extensions", serverUrl);
      apiUrl.searchParams.set("t", new URL(serverUrl).searchParams.get("t"));
      const catalogResponse = await fetch(apiUrl);
      if (!catalogResponse.ok) throw new Error(`extension catalog HTTP ${catalogResponse.status}`);
      if (catalogResponse.headers.get("cache-control") !== "private, no-store") {
        throw new Error("extension catalog is cacheable");
      }
      const catalog = await catalogResponse.json();
      if (catalog.length !== 1 || catalog[0]?.id !== "echo" || catalog[0]?.name !== "Echo test") {
        throw new Error("echo extension missing from local catalog");
      }

      const entry = new URL(catalog[0].entry_path, serverUrl);
      if (entry.origin !== new URL(serverUrl).origin) {
        throw new Error("extension entry escaped Chan's origin");
      }
      if (!entry.pathname.startsWith("/_chan/extensions/echo/")) {
        throw new Error(`unexpected extension proxy path: ${entry.pathname}`);
      }
      if (JSON.stringify(catalog).includes("127.0.0.1:") || JSON.stringify(catalog).includes("t=")) {
        throw new Error("extension upstream address or token leaked into the catalog");
      }
      const entryResponse = await fetch(entry);
      if (!entryResponse.ok) throw new Error(`extension proxy HTTP ${entryResponse.status}`);
      const framePolicies = entryResponse.headers.get("content-security-policy") ?? "";
      if (!framePolicies.includes("frame-ancestors 'self'")) {
        throw new Error("extension proxy response is not same-origin frame-scoped");
      }
      const badEntry = new URL(entry);
      const segments = badEntry.pathname.split("/");
      segments[4] = "0".repeat(64);
      badEntry.pathname = segments.join("/");
      if ((await fetch(badEntry)).status !== 404) {
        throw new Error("wrong extension proxy capability was accepted");
      }

      page = await ctx.browser.newPage();
      await page.setViewport({ width: 1400, height: 900 });
      await page.goto(serverUrl, { waitUntil: "networkidle2", timeout: 60_000 });
      await page.waitForSelector(".pane", { timeout: 30_000 });
      await runLauncherCommand(page, "Echo test");

      const iframeElement = await page.waitForSelector('iframe[title="Echo test"]', {
        visible: true,
        timeout: 10_000,
      });
      const frame = await iframeElement.contentFrame();
      if (!frame) throw new Error("extension iframe has no content frame");
      await frame.waitForSelector("#echo-input", { timeout: 10_000 });
      await frame.type("#echo-input", "hello extensions");
      const echoed = await frame.$eval("#echo-output", (node) => node.textContent);
      if (echoed !== "hello extensions") throw new Error(`unexpected echo output: ${echoed}`);

      // Cross-origin browsing-context key events do not bubble to Chan. The
      // v1 bridge must preserve shell shortcuts while the extension input owns
      // focus, including a browser-reserved chord that must be prevented in
      // the child before relaying.
      await frame.click("#echo-input");
      await pressChord(page, ["Control", "Alt"], "KeyK");
      await page.waitForSelector(LAUNCHER_INPUT_SELECTOR, { visible: true, timeout: 10_000 });
      await page.keyboard.press("Escape");
      await page.waitForSelector(LAUNCHER_SELECTOR, { hidden: true, timeout: 10_000 });

      await frame.click("#echo-input");
      await pressChord(page, ["Control", "Shift"], "KeyT");
      await page.waitForSelector(".terminal-tab.active", { timeout: 30_000 });
      const echoShortcutTab = await page.waitForSelector('[role="tab"][title="Echo test (echo)"]');
      await echoShortcutTab.click();
      const afterShortcut = await frame.$eval("#echo-output", (node) => node.textContent);
      if (afterShortcut !== "hello extensions") {
        throw new Error("extension iframe reloaded after host shortcut dispatch");
      }

      await runLauncherCommand(page, "New dashboard");
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('[role="tab"]')].some(
            (tab) => tab.getAttribute("title") === "Dashboard" && tab.getAttribute("aria-selected") === "true",
          ),
      );
      if ((await page.$$('iframe[title="Echo test"]')).length !== 1) {
        throw new Error("extension iframe unmounted while inactive");
      }
      const echoTab = await page.waitForSelector('[role="tab"][title="Echo test (echo)"]');
      await echoTab.click();
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('[role="tab"]')].some(
            (tab) =>
              tab.getAttribute("title") === "Echo test (echo)" &&
              tab.getAttribute("aria-selected") === "true",
          ),
      );
      const preserved = await frame.$eval("#echo-output", (node) => node.textContent);
      if (preserved !== "hello extensions") throw new Error("extension iframe reloaded on tab switch");
      await ctx.shot("echo", page);

      return {
        extensionId: "echo",
        extensionPid,
        echoed: preserved,
        keptAlive: true,
        samePortProxy: true,
        hostShortcuts: true,
      };
    } finally {
      if (page) await page.close().catch(() => {});
      if (server) {
        await teardownServer(ctx.chanBin, server.child, workspaceDir, server.chanHome);
      }
      if (extensionPid) await waitForProcessExit(extensionPid);
    }
  },
};
