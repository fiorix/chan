// A real workspace response read before a launcher preference write must
// not undo that write when delivered afterward. The fetch observer delays
// the original Response; it never substitutes a fixture or edits its body.
// Later responses stay held during the reading so they cannot hide a flip.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { selectFile } from "../lib/files.mjs";
import { request } from "../lib/drafts.mjs";
import { maskTokens } from "../lib/token-mask.mjs";

const LAUNCHER = '[role="dialog"][aria-label="Command launcher"]';
const INPUT = `${LAUNCHER} input[role="combobox"]`;
const DOCK = 'aside[aria-label="left file browser"]';
const KEY = "__preferenceRefresh268";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const errorText = (error) => maskTokens(error?.stack ?? String(error));

async function until(label, probe, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await probe();
    if (value) return value;
    await sleep(25);
  } while (Date.now() < deadline);
  throw new Error(`${label}: not reached within ${timeout} ms`);
}

async function selectCommand(page, title) {
  await page.keyboard.down("Control");
  await page.keyboard.down("Alt");
  try { await page.keyboard.press("KeyK"); }
  finally {
    await page.keyboard.up("Alt");
    await page.keyboard.up("Control");
  }
  await page.waitForSelector(INPUT, { visible: true });
  await page.waitForFunction((selector) => {
    const input = document.querySelector(selector);
    return input === document.activeElement && input.selectionStart === 0 && input.selectionEnd === input.value.length;
  }, {}, INPUT);
  await page.type(INPUT, title);
  await page.waitForFunction((selector, wanted) =>
    document.querySelector(`${selector} [role="option"][aria-selected="true"] .deck-result-title`)?.textContent?.trim() === wanted,
  {}, LAUNCHER, title);
}

async function runCommand(page, title, toggle = false) {
  await selectCommand(page, title);
  await page.keyboard.press("Enter");
  if (toggle) await page.keyboard.press("Escape");
  await page.waitForSelector(LAUNCHER, { hidden: true });
}

async function config(ctx, path) {
  const response = await request(ctx, path);
  assert.equal(response.status, 200, `GET ${path}`);
  assert.ok(response.json?.preferences?.browser_side_panes, "config has dock preferences");
  return response.json;
}

async function installKeyObserver(page) {
  return page.evaluateOnNewDocument(({ key, launcher }) => {
    const state = window[key] = { commands: [] };
    const element = (node) => node instanceof Element ? {
      tag: node.tagName, id: node.id, role: node.getAttribute("role"),
    } : null;
    const keys = (event) => {
      if (event.key !== "Enter") return;
      const title = document.querySelector(`${launcher} [role="option"][aria-selected="true"] .deck-result-title`)?.textContent?.trim();
      if (title) state.commands.push({
        at: performance.now(), eventTimeStamp: event.timeStamp, key: event.key,
        title, trusted: event.isTrusted, target: element(event.target),
        activeElement: element(document.activeElement), targetFocused: event.target === document.activeElement,
      });
    };
    // The command handler consumes Enter at window capture; observe before
    // application scripts register it, while its selected title still exists.
    window.addEventListener("keydown", keys, true);
    state.stopKeys = () => window.removeEventListener("keydown", keys, true);
  }, { key: KEY, launcher: LAUNCHER });
}

async function installObserver(page) {
  await page.evaluate(({ key, dock }) => {
    const originalFetch = window.fetch;
    const state = window[key];
    if (!state?.stopKeys) throw new Error("pre-navigation keyboard observer missing");
    Object.assign(state, {
      armed: false, rows: [], marks: {}, readings: [], removals: [],
      observing: false, lastTraffic: performance.now(), pending: 0,
    });
    const releases = new Map();
    const mark = () => performance.now();
    const read = (why) => state.readings.push({ at: mark(), why, visible: Boolean(document.querySelector(dock)?.checkVisibility()) });
    const mutations = new MutationObserver((records) => {
      if (!state.observing) return;
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && (node.matches(dock) || node.querySelector(dock))) {
            state.removals.push({ at: mark(), tag: node.tagName });
          }
        }
      }
      read("mutation");
    });
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class", "hidden"] });
    window.fetch = async function (input, init) {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method !== "GET" || !url.pathname.endsWith("/api/workspace")) return originalFetch.call(this, input, init);
      const held = state.armed;
      const row = { id: state.rows.length, method, path: url.pathname, startedAt: mark(), held };
      state.rows.push(row);
      state.pending++;
      state.lastTraffic = mark();
      try {
        const response = await originalFetch.call(this, input, init);
        row.status = response.status;
        row.responsePath = new URL(response.url).pathname;
        row.contentType = response.headers.get("content-type");
        row.arrivedAt = mark();
        row.body = await response.clone().text();
        row.capturedAt = mark();
        const text = response.text.bind(response);
        response.text = async () => {
          const value = await text();
          row.consumedAt = mark();
          row.consumedUnchanged = value === row.body;
          return value;
        };
        if (held && state.armed) {
          await new Promise((resolve) => {
            const timer = setTimeout(() => {
              row.holdExpired = true;
              releases.get(row.id)?.();
            }, 6_000);
            releases.set(row.id, () => {
              clearTimeout(timer);
              releases.delete(row.id);
              row.releasedAt = mark();
              resolve();
            });
          });
        }
        row.deliveredAt = mark();
        return response;
      } catch (error) {
        row.error = String(error);
        throw error;
      } finally {
        state.pending--;
        state.lastTraffic = mark();
      }
    };
    state.release = (id) => releases.get(id)?.();
    state.observe = () => { state.observing = true; read("before-release"); };
    state.sample = () => read("sample");
    state.stop = () => {
      state.armed = false;
      for (const release of [...releases.values()]) release();
      window.fetch = originalFetch;
      mutations.disconnect();
    };
  }, { key: KEY, dock: DOCK });
}

export default {
  name: "preference-refresh",
  async run(ctx) {
    const prefix = `preference-refresh-${Date.now()}`;
    const fixture = join(ctx.workspaceDir, prefix);
    const copied = join(fixture, "destination", "source.txt");
    const seed = `preference refresh ${prefix}\n`;
    const result = { browser: await ctx.browser.browser().version(), intervention: "delay original GET /api/workspace Response; no body replacement", cleanupErrors: [] };
    const page = await ctx.browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(errorText(error)));
    let configPath;
    let originalDocks;
    let primary;
    let keyObserver;
    try {
      page.setDefaultTimeout(10_000);
      await page.setViewport({ width: 1280, height: 800 });
      const url = new URL(ctx.serverUrl);
      url.searchParams.set("w", prefix);
      keyObserver = await installKeyObserver(page);
      await page.goto(url.href, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".pane");
      configPath = await page.evaluate(() => `${document.querySelector('meta[name="chan-prefix"]')?.getAttribute("content") ?? ""}/api/config`);
      originalDocks = { ...(await config(ctx, configPath)).preferences.browser_side_panes };
      await page.waitForSelector(DOCK, originalDocks.left ? { visible: true } : { hidden: true });
      await installObserver(page);
      if (await page.$(DOCK)) await runCommand(page, "Left file browser dock", true);
      await page.waitForSelector(DOCK, { hidden: true });
      await until("server left dock off", async () => !(await config(ctx, configPath)).preferences.browser_side_panes.left);
      mkdirSync(join(fixture, "sources"), { recursive: true });
      mkdirSync(join(fixture, "destination"));
      writeFileSync(join(fixture, "sources", "source.txt"), seed);
      writeFileSync(join(fixture, "destination", "anchor.txt"), "paste destination\n");
      const source = await selectFile(page, `${prefix}/sources/source.txt`);
      await source.dispose();
      await runCommand(page, "Copy");
      const anchor = await selectFile(page, `${prefix}/destination/anchor.txt`);
      await anchor.dispose();
      // Let setup's preference and filesystem refreshes finish before the
      // Paste Enter boundary that arms this reading's response hold.
      await page.waitForFunction((key) => {
        const state = window[key];
        return !state.pending && performance.now() - state.lastTraffic >= 500;
      }, {}, KEY);
      await selectCommand(page, "Paste");
      await page.evaluate((key) => {
        window[key].armed = true;
        window[key].marks.paste = performance.now();
      }, KEY);
      await page.keyboard.press("Enter");
      await page.waitForSelector(LAUNCHER, { hidden: true });
      await selectCommand(page, "Left file browser dock");
      const staleId = await until("real pre-toggle workspace response", () => page.evaluate((key) => {
        const state = window[key];
        const row = state.rows.find((entry) => entry.held && entry.body && entry.startedAt >= state.marks.paste);
        return row ? { id: row.id } : null;
      }, KEY));
      assert.ok(existsSync(copied), "Paste created the destination file before the toggle");
      assert.equal(readFileSync(copied, "utf8"), seed, "Paste copied the source bytes");
      result.staleId = staleId.id;
      const stale = await page.evaluate((key, id) => window[key].rows[id], KEY, staleId.id);
      assert.equal(stale.status, 200, "captured workspace response status");
      assert.equal(JSON.parse(stale.body).preferences.browser_side_panes.left, false, "captured response predates the local toggle");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Escape");
      await page.waitForSelector(LAUNCHER, { hidden: true });
      await page.waitForSelector(DOCK, { visible: true });
      result.serverBeforeRelease = await until("launcher write persisted", async () => {
        const value = await config(ctx, configPath);
        return value.preferences.browser_side_panes.left ? { revision: value.revision, docks: value.preferences.browser_side_panes } : null;
      });
      await page.evaluate((key, id) => {
        window[key].observe();
        window[key].release(id);
      }, KEY, staleId.id);
      await page.waitForFunction((key, id) => window[key].rows[id].consumedAt !== undefined, {}, KEY, staleId.id);
      // Consumption is recorded by the original Response.text(), which the
      // app's transport awaits. The observation spans its continuation and
      // at least 500 ms afterward, including any short unmount/remount.
      await page.evaluate(async (key) => {
        const state = window[key];
        const start = performance.now();
        do {
          state.sample();
          await new Promise((resolve) => setTimeout(resolve, 25));
        } while (performance.now() - start < 500);
        state.sample();
        state.marks.observationEnded = performance.now();
      }, KEY);
      const server = await config(ctx, configPath);
      result.serverAfterObservation = { revision: server.revision, docks: server.preferences.browser_side_panes };
      const observed = await page.evaluate((key) => {
        const { rows, commands, marks, readings, removals } = window[key];
        return { rows, commands, marks, readings, removals };
      }, KEY);
      const delivered = observed.rows[staleId.id];
      const paste = observed.commands.find((command) => command.title === "Paste" && command.at >= observed.marks.paste);
      const toggle = observed.commands.find((command) => command.title === "Left file browser dock" && command.at > paste?.at);
      assert.ok(paste?.trusted && toggle?.trusted, "Paste and dock toggle used trusted launcher Enter events");
      result.pasteToToggleMs = toggle.at - paste.at;
      result.captureToToggleMs = toggle.at - delivered.capturedAt;
      assert.ok(delivered.capturedAt < toggle.at && delivered.releasedAt > toggle.at, "real old response crossed the local write");
      assert.ok(delivered.consumedUnchanged && !delivered.holdExpired, "app consumed the released original response unchanged, before hold timeout");
      assert.ok(observed.marks.observationEnded - delivered.consumedAt >= 500, "read the dock for at least 500 ms after consumption");
      assert.ok(observed.rows.every((row) => !row.held || row.id === staleId.id || row.deliveredAt === undefined), "later held responses did not conceal a reversal");
      assert.equal(server.preferences.browser_side_panes.left, true, "server still has the user's dock preference");
      await ctx.shot("268-after-stale-response", page);
      assert.equal(observed.removals.length, 0, "PRODUCT_STALE_PREFERENCE_REFRESH: left dock was removed after the old workspace response");
      assert.ok(observed.readings.length > 1 && observed.readings.every((reading) => reading.visible), "PRODUCT_STALE_PREFERENCE_REFRESH: left dock reversed within the 500 ms reading");
      assert.deepEqual(pageErrors, [], "page errors");
      return result;
    } catch (error) {
      primary = error;
      result.error = errorText(error);
      try { await ctx.shot("268-failure", page); }
      catch (shotError) { result.cleanupErrors.push(errorText(shotError)); }
      throw error;
    } finally {
      const cleanup = async (label, action) => {
        try { await action(); }
        catch (error) { result.cleanupErrors.push(`${label}: ${errorText(error)}`); }
      };
      await cleanup("release responses and restore fetch", () => page.evaluate((key) => window[key]?.stop?.(), KEY));
      await cleanup("remove keyboard observer", () => page.evaluate((key) => window[key]?.stopKeys?.(), KEY));
      if (keyObserver) await cleanup("remove keyboard initialization script", () => page.removeScriptToEvaluateOnNewDocument(keyObserver.identifier));
      await cleanup("capture observations", async () => {
        result.observations = await page.evaluate((key) => {
          if (!window[key]) return null;
          const { rows, commands, marks, readings, removals } = window[key];
          return { rows, commands, marks, readings, removals };
        }, KEY);
        for (const row of result.observations?.rows ?? []) {
          if (row.body === undefined) continue;
          row.bodySha256 = sha256(row.body);
          row.bodyFile = `268-workspace-${row.id}.json`;
          const body = maskTokens(row.body);
          row.savedBodySha256 = sha256(body);
          writeFileSync(join(ctx.outDir, row.bodyFile), body);
          delete row.body;
        }
      });
      await cleanup("close page", () => page.close());
      if (originalDocks) await cleanup("restore dock preferences", async () => {
        const current = await config(ctx, configPath);
        const restored = await request(ctx, configPath, {
          method: "PATCH", headers: { "content-type": "application/json" },
          body: JSON.stringify({ expected_revision: current.revision, preferences: { browser_side_panes: originalDocks } }),
        });
        assert.equal(restored.status, 200, "restore preferences PATCH");
        assert.deepEqual((await config(ctx, configPath)).preferences.browser_side_panes, originalDocks);
      });
      await cleanup("remove workspace fixture", () => rmSync(fixture, { recursive: true, force: true }));
      result.pageErrors = pageErrors;
      writeFileSync(join(ctx.outDir, "268-preference-refresh.observations.json"), maskTokens(JSON.stringify(result, null, 2)));
      if (result.cleanupErrors.length) {
        if (primary instanceof Error) primary.smokeDetails = result;
        else throw new Error(`check cleanup failed: ${result.cleanupErrors.join("; ")}`);
      }
    }
  },
};
