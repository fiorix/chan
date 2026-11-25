// The screen lock holds the keyboard while it shows and hands it back when it
// lifts. The check page serves its own screen lock state (a PIN set, the
// inactivity timer off until a leg arms it) and answers each PIN check as
// the leg wants, so the workspace's own settings stay as they are; it also
// captures its watcher socket. Legs:
//   1. a focused Ghostty terminal under the lock: a typed key reaches
//      the PTY after unlock, and none of the wake key, the PIN or Enter does;
//   2. a reconnect cover arriving under the lock leaves the PIN field the
//      keyboard: a digit typed then lands in it;
//   3. the Team dialog under the lock (the inactivity timer brings it up
//      over the dialog): Escape, Tab and Enter on the lock leave the dialog
//      open and its lead terminal alive, and after unlock the dialog holds
//      the keyboard again;
//   4. a prompt dialog under the lock: Tab and Enter on the lock reach
//      nothing under it, the terminal it would rename keeps its name, and
//      after unlock the prompt holds the keyboard again.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeEveryTerminal, dispatchCommand, selectLauncherCommand } from "../lib/pane-strip.mjs";
import { openAttachedTerminal } from "../lib/terminal-attach.mjs";
import { keyboardAt } from "../lib/keyboard-owners.mjs";
import { LOCK, PROMPT, TEAM, checkWindowId, inputValue, keyboardSurface, settle, until } from "../lib/keyboard-layers.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const PIN = ".screensaver-pin";
const TIMER_SECS = 3;

export default {
  name: "screen-lock-keyboard",
  async run(ctx) {
    if (!ctx.controlSocket) ctx.skip("control socket not found for the server pid");
    const { page } = ctx;
    // The served lock state and the answer to the next PIN check.
    const lock = { enabled: false, timeout_secs: 300, accept: false, verifications: 0 };
    const served = () => ({ enabled: lock.enabled, timeout_secs: lock.timeout_secs, theme: "plain", pin_set: true });
    await page.setRequestInterception(true);
    page.on("request", async (request) => {
      const path = new URL(request.url()).pathname;
      if (path === "/api/screensaver/verify") {
        lock.verifications += 1;
        await request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ verified: lock.accept }) });
      } else if (path === "/api/screensaver/state") {
        await request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(served()) });
      } else {
        await request.continue();
      }
    });
    await page.evaluateOnNewDocument(() => {
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(...args) {
          super(...args);
          if (new URL(args[0], location.href).pathname === "/ws") {
            this.addEventListener("open", () => { window.__watch305 = this; });
          }
        }
      };
    });
    const load = async () => {
      await page.goto(page.url(), { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(".pane", { timeout: 30_000 });
      await page.waitForFunction(() => Boolean(window.__watch305)
        && performance.getEntriesByType("resource").some((e) => e.name.includes("/api/screensaver/state") && e.responseEnd > 0),
      { timeout: 30_000 });
      await settle(page);
    };
    await load();
    await page.bringToFront();
    const windowId = await checkWindowId(page);
    assert.ok(windowId, "the check page has a window id");
    await ctx.waitWindowLive(windowId);
    const cs = (args) => ctx.exec(ctx.chanBin, ["shell", "terminal", ...args], {
      cwd: ctx.workspaceDir,
      env: { ...process.env, CHAN_CONTROL_SOCKET: ctx.controlSocket, CHAN_WINDOW_ID: windowId },
      timeout: 90_000,
    });
    const terminalNames = async () => {
      const listed = await cs(["list", "--json"]);
      return Object.values(JSON.parse(listed.stdout).groups ?? {}).flat().map((row) => row.name);
    };
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const backend = "ghostty";
    const directory = mkdtempSync(join(ctx.workspaceDir, ".screenlock-305-"));
    // Wake the lock's card with a key and wait for its PIN field to hold the keyboard.
    const wake = async (label) => {
      await page.waitForSelector(LOCK, { timeout: 15_000 });
      await page.keyboard.press("a");
      await page.waitForSelector(PIN, { visible: true, timeout: 10_000 });
      await until(`${label}: the PIN field holds the keyboard`,
        () => page.evaluate((pin) => document.activeElement === document.querySelector(pin), PIN), Boolean, 5000);
    };
    // Type the PIN, have it accepted, and wait for the lock to lift.
    const unlock = async (label) => {
      await page.focus(PIN);
      await page.type(PIN, "2468");
      lock.accept = true;
      await page.keyboard.press("Enter");
      await until(`${label}: the lock lifts`, async () => Boolean(await page.$(LOCK)), (up) => !up, 10_000);
      lock.accept = false;
      await settle(page);
    };
    const lockNow = async () => {
      await dispatchCommand(page, "app.screensaver.lock");
      await page.waitForSelector(LOCK, { timeout: 10_000 });
    };
    // Arm the inactivity timer: serve it on, and run "Test screen lock",
    // which rereads the state and locks at once; the unlock starts the timer.
    const armTimer = async (label) => {
      lock.enabled = true;
      lock.timeout_secs = TIMER_SECS;
      await selectLauncherCommand(page, "Test screen lock");
      await page.keyboard.press("Enter");
      await wake(`${label} test lock`);
      await unlock(`${label} test lock`);
    };
    const underLock = async () => ({
      lock: Boolean(await page.$(LOCK)),
      keyboard: await keyboardSurface(page),
      pinFocused: await page.evaluate((pin) => document.activeElement === document.querySelector(pin), PIN),
    });
    const result = { backend, legs: {}, cleanupErrors: [] };
    const failures = [];
    const leg = async (name, fn) => {
      const record = { passed: false };
      result.legs[name] = record;
      try {
        await fn(record);
        record.passed = true;
      } catch (error) {
        record.failure = String(error.message ?? error);
        failures.push(`${name}: ${record.failure}`);
        await ctx.shot(`305-${name}-failure`).catch(() => {});
      } finally {
        if (await page.$(LOCK)) {
          await page.keyboard.press("a").catch(() => {});
          await page.waitForSelector(PIN, { visible: true, timeout: 5000 }).catch(() => {});
          await unlock(`${name} cleanup`).catch((error) => result.cleanupErrors.push(`${name} unlock: ${error.message}`));
        }
      }
    };
    try {
      await leg(`terminal-${backend}`, async (r) => {
        const name = `Lock305-${backend}`;
        const recorder = join(directory, `${backend}.bytes`);
        const row = await openAttachedTerminal(ctx, page, cs, windowId, name,
          ["--command", `stty raw -echo && exec dd bs=1 status=none of=${shellQuote(recorder)}`]);
        await until("precondition: the recorder started", () => existsSync(recorder), Boolean);
        const terminal = `.pane[data-pane-id="${row.pane}"] .terminal-tab.active[data-terminal-tab-id="${row.tab}"]`;
        await page.click(`${terminal} .terminal-host`);
        r.before = await until("precondition: the terminal holds the keyboard", () => keyboardAt(page),
          (at) => at === `terminal:${row.tab}`, 5000);
        const offset = readFileSync(recorder).length;
        await lockNow();
        await wake("terminal lock");
        await unlock("terminal lock");
        r.afterUnlock = await until("the keyboard returns to the terminal", () => keyboardAt(page),
          (at) => at === `terminal:${row.tab}`, 5000).catch(async () => `not returned: ${await keyboardAt(page)}`);
        await page.keyboard.press("Z");
        const deadline = Date.now() + 5000;
        let bytes = [];
        do {
          bytes = [...readFileSync(recorder).subarray(offset)].map((b) => b.toString(16).padStart(2, "0"));
          if (bytes.includes("5a")) break;
          await sleep(100);
        } while (Date.now() < deadline);
        r.bytesSinceLock = bytes;
        await ctx.shot(`305-terminal-${backend}-after-unlock`);
        assert.equal(r.afterUnlock, `terminal:${row.tab}`, "the keyboard returns to the terminal after unlock");
        assert.deepEqual(bytes, ["5a"], "after unlock a typed Z reaches the PTY, and nothing typed under the lock did");
        await closeEveryTerminal(page, `${backend} terminal`, token);
      });
      const plain = await openAttachedTerminal(ctx, page, cs, windowId, "Plain305");
      await page.click(`.pane[data-pane-id="${plain.pane}"] .terminal-tab.active .terminal-host`);

      await leg("reconnectUnderLock", async (r) => {
        await lockNow();
        await wake("reconnect lock");
        const cdp = await page.createCDPSession();
        try {
          await cdp.send("Network.enable");
          await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
          await page.evaluate(() => window.__watch305.close());
          await page.waitForSelector('[data-cover="reconnect"]', { timeout: 15_000 });
          await sleep(1500);
          r.underLock = await underLock();
          await page.keyboard.type("7");
          r.underLock.pinValue = await inputValue(page, PIN);
          await ctx.shot("305-reconnect-under-lock");
        } finally {
          await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
          await cdp.detach().catch(() => {});
        }
        await until("the reconnect cover lifts once back online", async () => Boolean(await page.$('[data-cover="reconnect"]')),
          (up) => !up, 30_000).catch((error) => result.cleanupErrors.push(`reconnect: ${error.message}`));
        r.backOnline = await underLock();
        assert.ok(r.underLock.lock && r.underLock.pinFocused && String(r.underLock.pinValue).endsWith("7"),
          `the PIN field keeps the keyboard and takes a digit when the reconnect cover arrives under the lock: ${JSON.stringify(r.underLock)}`);
      });

      await leg("teamUnderLock", async (r) => {
        const namesBeforeTeam = await terminalNames();
        await armTimer("team");
        await dispatchCommand(page, "app.terminal.teamWork");
        await page.waitForSelector(TEAM, { visible: true, timeout: 15_000 });
        r.terminalsBefore = await until("precondition: the dialog's lead terminal is listed", terminalNames,
          (names) => names.length > namesBeforeTeam.length, 10_000);
        await page.waitForSelector(LOCK, { timeout: (TIMER_SECS + 10) * 1000 });
        await wake("team lock");
        r.keys = [];
        for (const key of ["Escape", "Tab", "Enter"]) {
          await page.keyboard.press(key);
          await settle(page);
          r.keys.push({ key, team: Boolean(await page.$(TEAM)), ...(await underLock()) });
        }
        r.terminalsUnderLock = await terminalNames();
        await ctx.shot("305-team-under-lock");
        await unlock("team lock");
        r.afterUnlock = { team: Boolean(await page.$(TEAM)), keyboard: await keyboardSurface(page) };
        lock.enabled = false;
        if (await page.$(TEAM)) await page.click(".team-dialog-close");
        assert.ok(r.keys.every((k) => k.team && k.lock),
          `Escape, Tab and Enter on the lock leave the Team dialog open under it: ${JSON.stringify(r.keys)}`);
        assert.deepEqual(r.terminalsUnderLock, r.terminalsBefore, "the dialog's lead terminal lives");
        assert.ok(r.afterUnlock.team && r.afterUnlock.keyboard === "team",
          `after unlock the Team dialog holds the keyboard again: ${JSON.stringify(r.afterUnlock)}`);
      });

      await leg("promptUnderLock", async (r) => {
        await load();
        await armTimer("prompt");
        await page.click(`.pane .terminal-tab.active .terminal-host`).catch(() => {});
        await selectLauncherCommand(page, "Rename terminal");
        await page.keyboard.press("Enter");
        await page.waitForSelector(PROMPT, { visible: true, timeout: 10_000 });
        const field = `${PROMPT} input`;
        await page.click(field, { clickCount: 3 });
        await page.keyboard.type("Renamed305");
        r.fieldBefore = await inputValue(page, field);
        r.namesBefore = await terminalNames();
        await page.waitForSelector(LOCK, { timeout: (TIMER_SECS + 10) * 1000 });
        await wake("prompt lock");
        r.keys = [];
        for (const key of ["Tab", "Tab", "Enter"]) {
          await page.keyboard.press(key);
          await settle(page);
          r.keys.push({ key, prompt: Boolean(await page.$(PROMPT)), field: await inputValue(page, field), ...(await underLock()) });
        }
        r.namesUnderLock = await terminalNames();
        await ctx.shot("305-prompt-under-lock");
        await unlock("prompt lock");
        r.afterUnlock = { prompt: Boolean(await page.$(PROMPT)), keyboard: await keyboardSurface(page) };
        lock.enabled = false;
        if (await page.$(PROMPT)) await page.keyboard.press("Escape");
        assert.ok(r.keys.every((k) => k.lock && k.keyboard === "screen-lock" && k.prompt && k.field === r.fieldBefore),
          `Tab and Enter on the lock reach nothing under it: ${JSON.stringify(r.keys)}`);
        assert.deepEqual(r.namesUnderLock, r.namesBefore, "the terminal the prompt would rename keeps its name");
        assert.ok(r.afterUnlock.prompt && r.afterUnlock.keyboard === "prompt",
          `after unlock the prompt holds the keyboard again: ${JSON.stringify(r.afterUnlock)}`);
      });
    } catch (error) {
      result.failure = String(error.message ?? error);
      failures.push(result.failure);
      await ctx.shot("305-failure").catch(() => {});
    } finally {
      lock.enabled = false;
      lock.accept = false;
      result.verifications = lock.verifications;
      await load().catch((error) => result.cleanupErrors.push(`reload: ${error.message}`));
      await closeEveryTerminal(page, "305 cleanup", token).catch((error) => result.cleanupErrors.push(`terminals: ${error.message}`));
      rmSync(directory, { recursive: true, force: true });
      for (const error of result.cleanupErrors) failures.push(`cleanup: ${error}`);
      writeFileSync(join(ctx.outDir, "305-screen-lock.json"), `${JSON.stringify(result, null, 2)}\n`);
    }
    if (failures.length) throw new Error(failures.join("\n"));
  },
};
