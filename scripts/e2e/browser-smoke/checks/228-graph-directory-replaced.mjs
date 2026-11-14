// A directory keeps its opened place when another directory takes its name,
// but its children must be read again. The selected directory's neighbours
// have canvas labels, so these reads observe the drawn graph, not the index.
// Index-apply notifications wait until after the assertion: their later file
// paths would otherwise repair a stale rename patch. Real graph requests wait
// for the index to catch up, so the shared overlay itself is current.

import assert from "node:assert/strict";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function readApi(ctx, route, query = {}) {
  const url = new URL(route, ctx.serverUrl);
  url.search = new URLSearchParams(query).toString();
  const token = new URL(ctx.serverUrl).searchParams.get("t");
  const response = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  assert.ok(response.ok, `${route}: ${response.status}`);
  return response.json();
}

// Preserve the canvas's own methods. A graph at rest paints nothing new;
// install before navigation and retain the labels of its last whole frame.
async function observePage(page) {
  await page.evaluateOnNewDocument(() => {
    const proto = CanvasRenderingContext2D.prototype;
    const clearRect = proto.clearRect;
    const fillText = proto.fillText;
    const frames = new WeakMap();
    proto.clearRect = function (...args) {
      if (this.canvas.closest(".graph-tab")) frames.set(this.canvas, []);
      return clearRect.apply(this, args);
    };
    proto.fillText = function (text, ...args) {
      frames.get(this.canvas)?.push(String(text));
      return fillText.call(this, text, ...args);
    };
    window.__smokeGraphLabels = frames;
    const NativeWebSocket = window.WebSocket;
    const held = [];
    const gate = {
      armed: false,
      snapshot: () => ({ armed: gate.armed, held: held.map(({ paths }) => paths) }),
      release: () => {
        gate.armed = false;
        for (const { socket, event } of held.splice(0)) socket.dispatchEvent(event);
      },
    };
    // This listener precedes the app's listener. Only actual graph_applied
    // MessageEvents wait; watcher, heartbeat and session traffic pass through.
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", (event) => {
          if (!gate.armed || typeof event.data !== "string") return;
          let frame;
          try { frame = JSON.parse(event.data); } catch { return; }
          if (frame.type !== "graph_applied") return;
          event.stopImmediatePropagation();
          held.push({ socket: this, event, paths: frame.paths });
        });
      }
    };
    window.__smokeGraphApplyGate = gate;
  });
}

async function readDrawn(page) {
  return page.evaluate(() => {
    const panel = document.querySelector(".graph-tab.active");
    const canvas = panel?.querySelector("canvas");
    const crumbs = [...(panel?.querySelectorAll(".scope-crumbs .crumb") ?? [])];
    return {
      labels: [...(window.__smokeGraphLabels?.get(canvas) ?? [])].sort(),
      selected: crumbs.at(-1)?.textContent?.trim() ?? "",
      status: panel?.querySelector(".statusbar .stat")?.textContent?.trim() ?? "",
      loading: Boolean(panel?.querySelector(".canvas > .stream-status, .canvas > .placeholder")),
      timeOrigin: performance.timeOrigin,
      applyGate: window.__smokeGraphApplyGate?.snapshot(),
    };
  });
}

async function waitDrawn(page, accept, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    const now = await readDrawn(page);
    if (!now.loading && accept(now) && last && JSON.stringify(now) === JSON.stringify(last)) return now;
    last = now;
    if (Date.now() > deadline) throw new Error(`${description}: ${JSON.stringify(last)}`);
    await delay(100);
  }
}

export default {
  name: "graph-directory-replaced",
  async run(ctx) {
    const run = Date.now().toString(36);
    const root = `graph-rename-${run}`;
    const releases = `${root}/releases`;
    const v1 = `${releases}/v1`;
    const v2 = `${releases}/v2`;
    const v3 = `${releases}/v3`;
    const oldPath = `${v2}/old.md`;
    const newPath = `${v2}/new.md`;
    const spare = `${root}/spare`;
    const windowId = `smoke-228-${run}`;
    const page = await ctx.browser.newPage();
    const cdp = await page.target().createCDPSession();
    const evidence = { root, windowId, requests: [], frames: [], errors: [], graphRequests: 0, graphCompleted: 0 };
    let renamed = false;
    let holdGraphRequests = false;
    const heldRequests = new Set();
    const refreshes = new WeakSet();
    const releaseRequests = async () => {
      holdGraphRequests = false;
      await Promise.all([...heldRequests].map((request) => request.continue()));
      heldRequests.clear();
    };
    const save = () => writeFileSync(join(ctx.outDir, "228-graph-directory-replaced.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    const captureLevels = async () => {
      const levels = {};
      for (const path of [root, releases, v2]) {
        levels[path] = await readApi(ctx, "/api/fs-graph", { scope: "directory", path, depth: "1" });
      }
      return levels;
    };
    page.on("pageerror", (error) => evidence.errors.push(error.message));
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.endsWith("/api/fs-graph")) {
        evidence.requests.push({ afterRename: renamed, path: url.searchParams.get("path") ?? "", at: Date.now() });
      }
      if (renamed && url.pathname.endsWith("/api/graph")) {
        evidence.graphRequests += 1;
        refreshes.add(request);
        if (holdGraphRequests) {
          heldRequests.add(request);
          return;
        }
      }
      void request.continue().catch((error) => evidence.errors.push(`request continuation: ${error.message}`));
    });
    page.on("requestfinished", (request) => {
      if (refreshes.has(request)) evidence.graphCompleted += 1;
    });
    cdp.on("Network.webSocketFrameReceived", ({ response }) => {
      try {
        const frame = JSON.parse(response.payloadData);
        if (frame.type === "watch" || frame.type === "fs") {
          const { kind, path, to } = frame.event ?? {};
          evidence.frames.push({ afterRename: renamed, type: frame.type, kind, path, to, at: Date.now() });
        } else if (frame.type === "graph_applied") {
          evidence.frames.push({ afterRename: renamed, type: frame.type, paths: frame.paths, at: Date.now() });
        }
      } catch { /* Other sockets need not carry JSON. */ }
    });
    try {
      for (const dir of [v1, v2, spare]) mkdirSync(join(ctx.workspaceDir, dir), { recursive: true });
      writeFileSync(join(ctx.workspaceDir, v1, "new.md"), "# new.md\n");
      writeFileSync(join(ctx.workspaceDir, oldPath), "# old.md\n");
      // This extra opened level keeps a small rename patch below a whole
      // fetch's cost, even if the watcher also names the releases directory.
      writeFileSync(join(ctx.workspaceDir, spare, "untouched.md"), "# Untouched\n");

      const deadline = Date.now() + 90_000;
      for (;;) {
        const graph = await readApi(ctx, "/api/graph");
        const old = graph.nodes?.find((node) => node.id === oldPath);
        const next = graph.nodes?.find((node) => node.id === `${v1}/new.md`);
        const status = await readApi(ctx, "/api/index/status");
        if (!graph.gated && old && next && status.state === "idle") {
          evidence.initialGraph = graph;
          evidence.oldLabels = [...new Set(["old.md", old.label])];
          evidence.newLabels = [...new Set(["new.md", next.label])];
          break;
        }
        if (Date.now() > deadline) throw new Error("the index did not hold both rename fixtures while idle");
        await delay(250);
      }
      evidence.initialLevels = await captureLevels();
      await observePage(page);
      await page.setRequestInterception(true);
      await cdp.send("Network.enable");
      await page.setViewport({ width: 1280, height: 800 });
      const url = new URL(ctx.serverUrl);
      url.searchParams.set("w", windowId);
      url.hash = "s=" + encodeURIComponent(JSON.stringify({
        k: "l", f: 1,
        t: [{ k: "g", gp: v2, gn: `directory:${v2}`, ge: [root, releases, v2, spare], a: 1 }],
      }));
      await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(".graph-tab.active canvas", { timeout: 30_000 });
      const shows = (read, labels) => labels.some((label) => read.labels.includes(label));
      evidence.before = await waitDrawn(page,
        (read) => read.selected === "v2" && shows(read, evidence.oldLabels) && !shows(read, evidence.newLabels),
        "the opened v2 did not draw old.md alone");
      await ctx.shot("228-before-rename", page);

      // Synchronous renames keep the two operations in one watcher burst.
      // No reload or graph command follows: the watch must patch this tab.
      await page.evaluate(() => { window.__smokeGraphApplyGate.armed = true; });
      holdGraphRequests = true;
      renamed = true;
      renameSync(join(ctx.workspaceDir, v2), join(ctx.workspaceDir, v3));
      renameSync(join(ctx.workspaceDir, v1), join(ctx.workspaceDir, v2));
      // Poll independently of the page's held requests. Release only real
      // requests to the real server once its graph contains the final tree.
      const indexedBy = Date.now() + 20_000;
      for (;;) {
        const graph = await readApi(ctx, "/api/graph");
        const ids = new Set(graph.nodes?.map((node) => node.id));
        const status = await readApi(ctx, "/api/index/status");
        if (!graph.gated && ids.has(newPath) && ids.has(`${v3}/old.md`) && !ids.has(oldPath) && status.state === "idle") {
          evidence.finalGraph = graph;
          break;
        }
        if (Date.now() > indexedBy) throw new Error("the index did not apply both renames before the graph request deadline");
        await delay(100);
      }
      evidence.delayedRequests = heldRequests.size;
      await releaseRequests();
      evidence.after = await waitDrawn(page,
        (read) => evidence.graphCompleted > 0 && read.applyGate?.armed && read.applyGate.held.length > 0
          && read.selected === "v2" && shows(read, evidence.newLabels) && !shows(read, evidence.oldLabels),
        "v2 must draw new.md and stop drawing old.md after replacement");
      assert.equal(evidence.after.timeOrigin, evidence.before.timeOrigin, "the page must not reload");
      assert.ok(evidence.after.applyGate.armed && evidence.after.applyGate.held.length > 0, "real index notifications must remain held during the assertion");
      assert.ok(evidence.graphCompleted > 0, "the page must receive the current shared graph");
      const patch = evidence.requests.filter((request) => request.afterRename);
      assert.ok(patch.some((request) => request.path === releases), "the watcher must refresh the renamed directories' parent");
      assert.ok(patch.some((request) => request.path === v2), "the held directory's children must be reread");
      assert.ok(patch.every((request) => request.path !== ""), "a whole-spine refresh must not mask the rename patch");
      evidence.finalLevels = await captureLevels();
      assert.ok(evidence.finalLevels[v2].nodes.some((node) => node.id === newPath));
      assert.ok(!evidence.finalLevels[v2].nodes.some((node) => node.id === oldPath));
      assert.deepEqual(evidence.errors, []);
      return { before: evidence.before, after: evidence.after, patch, frames: evidence.frames.filter((frame) => frame.afterRename) };
    } finally {
      evidence.lastDrawn = await readDrawn(page).catch((error) => ({ error: error.message }));
      if (renamed && !evidence.finalLevels) {
        evidence.finalLevels = await captureLevels().catch((error) => ({ error: error.message }));
      }
      await ctx.shot("228-after-rename", page).catch((error) => { evidence.screenshotError = error.message; });
      save();
      await releaseRequests().catch(() => {});
      await page.evaluate(() => window.__smokeGraphApplyGate?.release()).catch(() => {});
      await cdp.detach().catch(() => {});
      await page.close().catch(() => {});
      rmSync(join(ctx.workspaceDir, root), { recursive: true, force: true });
      const url = new URL("/api/session", ctx.serverUrl);
      url.search = new URLSearchParams({ w: windowId }).toString();
      const token = new URL(ctx.serverUrl).searchParams.get("t");
      await fetch(url, { method: "DELETE", headers: token ? { authorization: `Bearer ${token}` } : {} }).catch(() => {});
    }
  },
};
