import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchWindows, goto, killChild, mask, poll, spawnDevserver } from "../lib/launcher-devserver.mjs";

const GRID = '[role="table"][aria-label="Keyboard shortcuts"]';
const PEER = { id: "app.transfers.show", title: "Show transfers", slot: "web", key: "J", chord: "Mod+Alt+Shift+J" };
const LOCAL = { id: "app.open.path", title: "Open...", slot: "linux", key: "K", chord: "Mod+Alt+Shift+K" };
const SLOTS = ["web", "macos", "linux", "windows"];
const WAIT = 30_000;

async function request(origin, path, token, method = "GET", body) {
  const response = await fetch(new URL(path, origin), {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(WAIT),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${mask(JSON.stringify(value))}`);
  return value;
}

async function restoreShortcuts(origin, configRecord, shortcuts) {
  const path = `${configRecord.prefix}/api/config`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await request(origin, path, configRecord.token);
    const response = await fetch(new URL(path, origin), {
      method: "PATCH",
      headers: { Authorization: `Bearer ${configRecord.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expected_revision: current.revision, preferences: { shortcuts } }),
      signal: AbortSignal.timeout(WAIT),
    });
    if (response.status === 409) continue;
    assert.ok(response.ok, `cleanup PATCH config -> ${response.status}`);
    const restored = await request(origin, path, configRecord.token);
    assert.deepEqual(restored.preferences.shortcuts ?? {}, shortcuts, "cleanup restored the original shortcut table");
    return;
  }
  throw new Error("cleanup shortcut restoration exhausted revision retries");
}

// The missed-frame arm leaves the native socket open. The reconnect arms
// close it and refuse actual native redials at an unserved path until released.
// Neither intervention changes application state or fabricates watch frames.
async function observe(page) {
  const traffic = { reads: [], writes: [], errors: [], pending: 0 };
  const started = new WeakMap();
  const pending = new Set();
  const tracked = (url) => /\/api\/(config|workspace)$/.test(new URL(url).pathname);
  page.on("request", (req) => {
    if (!tracked(req.url())) return;
    started.set(req, Date.now());
    pending.add(req);
    traffic.pending = pending.size;
  });
  page.on("requestfailed", (req) => {
    if (!pending.delete(req)) return;
    traffic.pending = pending.size;
    traffic.errors.push(`${req.method()} ${new URL(req.url()).pathname}: ${mask(req.failure()?.errorText ?? "request failed")}`);
  });
  page.on("pageerror", (error) => traffic.errors.push(mask(error.message)));
  page.on("response", (response) => {
    const req = response.request();
    const path = new URL(response.url()).pathname;
    if (!tracked(response.url())) return;
    void (async () => {
      const value = await response.json();
      const record = { at: started.get(req), path, status: response.status(), shortcuts: value.preferences?.shortcuts ?? {} };
      if (req.method() === "GET") traffic.reads.push(record);
      if (req.method() === "PATCH") traffic.writes.push(record);
    })().catch((error) => traffic.errors.push(mask(error.message))).finally(() => {
      pending.delete(req);
      traffic.pending = pending.size;
    });
  });
  await page.evaluateOnNewDocument(() => {
    const NativeSocket = window.WebSocket;
    const probe = window.__shortcut267 = { sockets: [], keys: [], dropConfig: false, blockWatch: false };
    document.addEventListener("keydown", (event) => {
      if (!event.target?.matches?.("button.capture")) return;
      probe.keys.push({ key: event.key, code: event.code, trusted: event.isTrusted,
        ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey });
    }, true);
    window.WebSocket = new Proxy(NativeSocket, {
      construct(target, args) {
        const url = new URL(String(args[0]), location.href);
        if (!url.pathname.endsWith("/ws") || url.pathname.includes("/api/")) return Reflect.construct(target, args);
        const blocked = probe.blockWatch;
        if (blocked) {
          url.pathname = "/__smoke_267_refused_watch__";
          args = [url.href, ...args.slice(1)];
        }
        const socket = Reflect.construct(target, args);
        const record = { id: probe.sockets.length + 1, socket, blocked, createdAt: Date.now(), openedAt: null, closedAt: null, frames: [] };
        probe.sockets.push(record);
        socket.addEventListener("open", () => { record.openedAt = Date.now(); });
        socket.addEventListener("close", () => { record.closedAt = Date.now(); });
        socket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          let frame;
          try { frame = JSON.parse(event.data); } catch { return; }
          const dropped = frame.kind === "config_changed" && probe.dropConfig;
          record.frames.push({ kind: frame.kind, at: Date.now(), dropped });
          if (dropped) event.stopImmediatePropagation();
        });
        return socket;
      },
    });
  });
  return traffic;
}

async function settleTraffic(window) {
  await poll("preference response recording drained", () => window.traffic.pending === 0);
  assert.deepEqual(window.traffic.errors, [], "instrument: preference traffic and page handlers completed without errors");
}

// A real config write provides the same startup barrier on the old and new
// clients: its watch frame must cause a completed preference read before the
// disconnection. Otherwise a pending startup refresh could consume the edit.
async function settleStartup(origin, windows, original) {
  const at = Date.now();
  for (const window of windows) await restoreShortcuts(origin, window.record, original);
  const receipts = [];
  for (const window of windows) {
    await window.page.waitForFunction((after) => window.__shortcut267.sockets.some((record) =>
      record.frames.some((frame) => frame.at >= after && frame.kind === "config_changed" && !frame.dropped)),
    { timeout: WAIT }, at);
    const probe = await snapshotProbe(window.page);
    const frame = probe.sockets.flatMap((record) => record.frames)
      .filter((frame) => frame.at >= at && frame.kind === "config_changed").at(-1);
    const path = new URL(`${window.record.prefix}/api/${window.kind === "terminal" ? "config" : "workspace"}`, origin).pathname;
    const read = await poll("startup watch refresh completed", () => window.traffic.reads.find((record) =>
      record.at >= frame.at && record.path === path && record.status === 200));
    assert.deepEqual(read.shortcuts, original, "instrument: startup refresh saw the original table");
    await settleTraffic(window);
    receipts.push({ window: window.record.window_id, frame, read });
  }
  return receipts;
}

async function snapshotProbe(page) {
  return page.evaluate(() => ({
    keys: window.__shortcut267.keys,
    sockets: window.__shortcut267.sockets.map(({ socket, ...record }) => ({ ...record, readyState: socket.readyState })),
  }));
}

async function showSettings(page) {
  await page.bringToFront();
  if (!await page.$('[aria-label="Settings sections"]')) {
    await page.keyboard.down("Control");
    try { await page.keyboard.press("Comma"); } finally { await page.keyboard.up("Control"); }
  }
  await page.waitForSelector('[aria-label="Settings sections"]', { timeout: WAIT });
  const tab = await page.evaluateHandle(() => [...document.querySelectorAll('[aria-label="Settings sections"] button')]
    .find((button) => button.textContent.trim() === "Keyboard Shortcuts"));
  assert.ok(tab.asElement(), "setup: Settings has a Keyboard Shortcuts section");
  try { await tab.asElement().click(); } finally { await tab.dispose(); }
  await page.waitForSelector(GRID, { timeout: WAIT });
}

async function cell(page, binding) {
  return page.evaluate(({ title, column, grid }) => {
    const row = [...document.querySelectorAll(`${grid} .row`)]
      .find((node) => node.querySelector(".col-cmd")?.textContent.trim() === title);
    const cell = row?.querySelectorAll(".cell")[column];
    return cell ? { text: cell.querySelector(".chord-btn")?.textContent.trim() ?? null, override: !!cell.querySelector(".reset") } : null;
  }, { title: binding.title, column: SLOTS.indexOf(binding.slot), grid: GRID });
}

async function assign(page, binding, traffic) {
  await page.bringToFront();
  const button = await page.evaluateHandle(({ title, column, grid }) => {
    const row = [...document.querySelectorAll(`${grid} .row`)]
      .find((node) => node.querySelector(".col-cmd")?.textContent.trim() === title);
    return row?.querySelectorAll(".cell")[column]?.querySelector("button.chord-btn");
  }, { title: binding.title, column: SLOTS.indexOf(binding.slot), grid: GRID });
  assert.ok(button.asElement(), `setup: editable ${binding.title}/${binding.slot} cell exists`);
  try { await button.asElement().click(); } finally { await button.dispose(); }
  await page.waitForSelector("button.capture", { timeout: WAIT });
  const writeCount = traffic.writes.length;
  const at = Date.now();
  await page.keyboard.down("Control");
  await page.keyboard.down("Alt");
  await page.keyboard.down("Shift");
  try { await page.keyboard.press(`Key${binding.key}`); } finally {
    await page.keyboard.up("Shift");
    await page.keyboard.up("Alt");
    await page.keyboard.up("Control");
  }
  const write = await poll(`UI saved ${binding.id}/${binding.slot}`, () =>
    traffic.writes.slice(writeCount).find((record) => record.at >= at && record.status === 200 &&
      record.shortcuts[binding.id]?.[binding.slot] === binding.chord));
  const probe = await snapshotProbe(page);
  assert.ok(probe.keys.some((event) => event.code === `Key${binding.key}` && event.trusted && event.ctrl && event.alt && event.shift),
    "instrument: assignment used trusted keyboard delivery to the capture button");
  const shown = await cell(page, binding);
  assert.ok(shown?.override, "UI assignment displays an override");
  return { write, shown };
}

async function openWindow(ctx, origin, token, workspace, kind, label, record) {
  record ??= await request(origin, "/api/library/windows", token, "POST", {
    kind, origin: "browser", ...(kind === "workspace" ? { workspace_path: workspace } : {}),
  });
  const page = await ctx.browser.newPage();
  try {
    await page.setViewport({ width: 1440, height: 1000 });
    const traffic = await observe(page);
    const url = new URL(`${record.prefix}/`, origin);
    for (const [key, value] of Object.entries({ w: record.window_id, t: record.token, lib: "local", h: `shortcut267-${label}` })) url.searchParams.set(key, value);
    if (kind === "terminal") url.searchParams.set("kind", "terminal");
    await goto(page, url.href);
    await page.waitForSelector(".pane", { timeout: WAIT });
    await page.waitForFunction(() => window.__shortcut267.sockets.some((socket) => socket.openedAt), { timeout: WAIT });
    await poll(`${label} registered with the devserver`, async () =>
      (await fetchWindows(origin, token)).find((row) => row.window_id === record.window_id && row.connected));
    await showSettings(page);
    assert.ok(await cell(page, PEER), "setup: peer command is in the rendered grid");
    assert.ok(await cell(page, LOCAL), "setup: local command is in the rendered grid");
    return { page, record, traffic, kind };
  } catch (error) {
    await page.close();
    throw error;
  }
}

async function runArm(ctx, origin, token, workspace, peerRecord, original, label, kind, reconnect) {
  const result = { label, kind, intervention: reconnect ? "native watcher close, refused native redials, automatic reconnect" : "config_changed delivery suppressed; native watcher remains open", stage: "setup", status: "running" };
  const windows = [];
  try {
    const reader = await openWindow(ctx, origin, token, workspace, kind, `${label}-reader`);
    windows.push(reader);
    const peer = await openWindow(ctx, origin, token, workspace, "workspace", `${label}-peer`, peerRecord);
    windows.push(peer);
    result.windows = { reader: reader.record.window_id, peer: peer.record.window_id };
    result.startup = await settleStartup(origin, windows, original);
    const staleCell = await cell(reader.page, PEER);
    result.stage = "intervention";
    const cut = await reader.page.evaluate((disconnect) => {
      const probe = window.__shortcut267;
      const live = probe.sockets.filter((record) => record.socket.readyState === WebSocket.OPEN);
      if (live.length !== 1) throw new Error(`expected one live watcher, found ${live.length}`);
      if (disconnect) {
        probe.blockWatch = true;
        live[0].socket.close();
      } else probe.dropConfig = true;
      return { id: live[0].id, at: Date.now() };
    }, reconnect);
    result.cut = cut;
    if (reconnect) {
      await reader.page.waitForFunction((id) => {
        const probe = window.__shortcut267;
        return probe.sockets.find((record) => record.id === id)?.closedAt &&
          probe.sockets.some((record) => record.blocked && record.closedAt && !record.openedAt);
      }, { timeout: WAIT }, cut.id);
      await poll("reader disconnected from the devserver", async () =>
        (await fetchWindows(origin, token)).find((row) => row.window_id === reader.record.window_id && !row.connected));
    }
    result.stage = "peer-ui-save";
    result.peerSave = await assign(peer.page, PEER, peer.traffic);
    const readConfig = () => request(origin, `${peerRecord.prefix}/api/config`, peerRecord.token);
    result.afterPeer = (await readConfig()).preferences.shortcuts ?? {};
    assert.equal(result.afterPeer[PEER.id]?.[PEER.slot], PEER.chord, "setup: peer assignment reached server config");
    result.stage = "intervention";
    if (reconnect) {
      const offline = await snapshotProbe(reader.page);
      assert.ok(offline.sockets.every((socket) => socket.readyState !== 1), "instrument: reader stayed disconnected throughout peer save");
      assert.ok(offline.sockets.filter((socket) => socket.id > cut.id).every((socket) => socket.blocked && !socket.openedAt),
        "instrument: no reconnect received the peer save");
      result.offline = offline;
      await reader.page.evaluate(() => { window.__shortcut267.blockWatch = false; });
      await reader.page.waitForFunction((id) => window.__shortcut267.sockets.some((record) => record.id > id && !record.blocked && record.openedAt),
        { timeout: 45_000 }, cut.id);
      const reconnected = (await snapshotProbe(reader.page)).sockets.find((socket) => socket.id > cut.id && !socket.blocked && socket.openedAt);
      result.reconnected = reconnected;
      result.stage = "contract-reconnect";
      const path = new URL(`${reader.record.prefix}/api/${kind === "terminal" ? "config" : "workspace"}`, origin).pathname;
      try {
        result.refresh = await poll("reconnect preference read", () => reader.traffic.reads.find((record) =>
          record.at >= reconnected.openedAt && record.path === path && record.status === 200 && record.shortcuts[PEER.id]?.[PEER.slot] === PEER.chord), 15_000);
      } catch (cause) {
        throw new Error(`PRODUCT_RECONNECT_REFRESH_MISSING: ${kind} did not fetch the missed shortcut after native watcher reconnect`, { cause });
      }
      await showSettings(reader.page);
      try {
        result.refreshedCell = await poll("reconnected grid shows peer binding", async () => {
          const shown = await cell(reader.page, PEER);
          return shown?.override && shown.text === result.peerSave.shown.text ? shown : null;
        }, 15_000);
      } catch (cause) {
        throw new Error(`PRODUCT_RECONNECT_GRID_STALE: ${kind} did not show the missed shortcut before its next edit`, { cause });
      }
    } else {
      await reader.page.waitForFunction((after) => window.__shortcut267.sockets.some((record) =>
        record.frames.some((frame) => frame.at >= after && frame.kind === "config_changed" && frame.dropped)),
      { timeout: WAIT }, cut.at);
      const probe = await snapshotProbe(reader.page);
      assert.equal(probe.sockets.length, 1, "instrument: missed-frame arm did not reconnect");
      assert.equal(probe.sockets[0].readyState, 1, "instrument: missed-frame watcher is still open");
      result.staleCell = await cell(reader.page, PEER);
      assert.deepEqual(result.staleCell, staleCell, "instrument: reader still displays its old peer binding");
      assert.notDeepEqual(result.staleCell, result.peerSave.shown, "instrument: the missed update left a visibly stale cell");
    }
    result.stage = "reader-ui-save";
    result.readerSave = await assign(reader.page, LOCAL, reader.traffic);
    result.afterReader = (await readConfig()).preferences.shortcuts ?? {};
    result.stage = "contract-merge";
    assert.deepEqual(result.afterReader, {
      ...original,
      [PEER.id]: { ...original[PEER.id], [PEER.slot]: PEER.chord },
      [LOCAL.id]: { ...original[LOCAL.id], [LOCAL.slot]: LOCAL.chord },
    }, `PRODUCT_SHORTCUT_MERGE_LOST_BINDING: ${label} must retain both windows' bindings in server config`);
    for (const window of windows) await settleTraffic(window);
    result.status = "passed";
    await ctx.shot(`shortcut267-${label}-passed`, reader.page);
  } catch (error) {
    result.status = "failed";
    result.error = mask(error.message);
    if (windows[0]) await ctx.shot(`shortcut267-${label}-failed`, windows[0].page).catch(() => {});
  } finally {
    result.evidence = [];
    for (const window of windows) {
      await settleTraffic(window).catch((error) => {
        (result.instrumentErrors ??= []).push(mask(error.message));
      });
      result.evidence.push({ window: window.record.window_id, traffic: window.traffic,
        probe: await snapshotProbe(window.page).catch((error) => ({ error: mask(error.message) })) });
      await window.page.close().catch((error) => {
        (result.cleanupErrors ??= []).push(mask(error.message));
      });
    }
    try { await restoreShortcuts(origin, peerRecord, original); } catch (error) {
      (result.cleanupErrors ??= []).push(mask(error.message));
    }
    if (result.cleanupErrors?.length || result.instrumentErrors?.length) result.status = "failed";
  }
  return result;
}

export default {
  name: "shortcut-merge",
  async run(ctx) {
    const fixture = mkdtempSync(join(tmpdir(), "chan-shortcut267-"));
    const home = join(fixture, "home");
    const workspace = join(fixture, "workspace");
    mkdirSync(home);
    mkdirSync(workspace);
    const evidence = { arms: [], cleanupErrors: [], status: "running" };
    const devserver = spawnDevserver(ctx.chanBin, home, ["--no-tunnel"]);
    try {
      const launchUrl = new URL(await devserver.url);
      const origin = launchUrl.origin;
      const token = launchUrl.searchParams.get("t");
      assert.ok(token, "setup: devserver supplied its management token");
      await request(origin, "/api/library/workspaces", token, "POST", { path: workspace });
      const peer = await request(origin, "/api/library/windows", token, "POST", {
        kind: "workspace", workspace_path: workspace, origin: "browser",
      });
      const original = (await request(origin, `${peer.prefix}/api/config`, peer.token)).preferences.shortcuts ?? {};
      for (const [label, kind, reconnect] of [
        ["missed-frame-writer", "workspace", false],
        ["workspace-reconnect", "workspace", true],
        ["standalone-reconnect", "terminal", true],
      ]) {
        evidence.arms.push(await runArm(ctx, origin, token, workspace, peer, original, label, kind, reconnect));
        if (evidence.arms.at(-1).cleanupErrors?.length) break;
      }
      evidence.status = evidence.arms.length === 3 && evidence.arms.every((arm) => arm.status === "passed") ? "passed" : "failed";
    } catch (error) {
      evidence.status = "failed";
      evidence.setupError = mask(error.message);
    } finally {
      try { await killChild(devserver.child); } catch (error) { evidence.cleanupErrors.push(mask(error.message)); }
      try { rmSync(fixture, { recursive: true, force: true }); } catch (error) { evidence.cleanupErrors.push(mask(error.message)); }
      if (evidence.cleanupErrors.length) evidence.status = "failed";
      writeFileSync(join(ctx.outDir, "shortcut267-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    }
    assert.equal(evidence.status, "passed", `shortcut-merge failed: ${JSON.stringify({
      setup: evidence.setupError, arms: evidence.arms.map(({ label, stage, status, error, instrumentErrors, cleanupErrors }) => ({ label, stage, status, error, instrumentErrors, cleanupErrors })),
      cleanup: evidence.cleanupErrors,
    })}`);
    return evidence;
  },
};
