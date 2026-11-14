// A directory keeps its opened place when another directory takes its name,
// but its children must be read again. The selected directory's neighbours
// have canvas labels, so these reads observe the drawn graph, not the index.
// File notifications wait until after the assertion: their paths would
// otherwise repair a stale directory-only patch. Directory rename events and
// HTTP responses pass unchanged; the shared graph refreshes after recovery.

import assert from "node:assert/strict";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function fetchApi(ctx, route, query = {}) {
  const url = new URL(route, ctx.serverUrl);
  url.search = new URLSearchParams(query).toString();
  const token = new URL(ctx.serverUrl).searchParams.get("t");
  const response = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  assert.ok(response.ok, `${route}: ${response.status}`);
  return response;
}

async function readApi(ctx, route, query = {}) {
  return (await fetchApi(ctx, route, query)).json();
}

function parseGraphStream(body) {
  const events = body.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === "meta"), "graph stream must include metadata");
  assert.equal(events.at(-1)?.type, "done", "graph stream must finish before its labels are read");
  assert.ok(!events.some((event) => event.type === "error"), "graph stream must not fail");
  // Semantic batches replace the initial filesystem labels for the same id.
  // Keep the last node exactly as the app's streamed graph does.
  const nodes = new Map();
  for (const event of events) {
    if (event.type === "nodes") {
      for (const node of event.nodes) nodes.set(node.id, node);
    }
  }
  return { events, nodes };
}

async function readGraphStream(ctx) {
  return parseGraphStream(await (await fetchApi(ctx, "/api/graph", { stream: "1" })).text());
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
      roots: [],
      passed: [],
      snapshot: () => ({ armed: gate.armed, held: held.map(({ frame }) => frame), passed: gate.passed }),
      release: () => {
        gate.armed = false;
        for (const { socket, event } of held.splice(0)) socket.dispatchEvent(event);
      },
    };
    // This listener precedes the app's listener. Retain the original events;
    // the app sees directory names first and their file notifications later.
    // Heartbeat, session and index-progress traffic pass through unchanged.
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", (event) => {
          if (!gate.armed || typeof event.data !== "string") return;
          let frame;
          try { frame = JSON.parse(event.data); } catch { return; }
          const watched = frame.type === "watch" || frame.type === "fs";
          const paths = [frame.event?.path, frame.event?.to].filter((path) => typeof path === "string");
          const descendant = watched && paths.some((path) => gate.roots.some((root) => path.startsWith(`${root}/`)));
          const summary = watched
            ? { type: frame.type, kind: frame.event?.kind, path: frame.event?.path, to: frame.event?.to }
            : { type: frame.type, paths: frame.paths };
          if (frame.type !== "graph_applied" && !descendant) {
            if (watched) gate.passed.push(summary);
            return;
          }
          event.stopImmediatePropagation();
          held.push({ socket: this, event, frame: summary });
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
    const oldTag = `#rename-old-${run}`;
    const newTag = `#rename-new-${run}`;
    const windowId = `smoke-228-${run}`;
    const page = await ctx.browser.newPage();
    const cdp = await page.target().createCDPSession();
    const evidence = { root, windowId, requests: [], frames: [], errors: [], pageGraphs: [], polls: {} };
    let renamed = false;
    const refreshes = new WeakSet();
    const responseReads = new Set();
    const indexed = (graph, path, tag) => graph.edges?.some((edge) => edge.source === path && edge.target === tag && edge.kind === "tag");
    const finalGraph = (graph) => {
      const ids = new Set(graph.nodes.map((node) => node.id));
      return !graph.gated && ids.has(newPath) && ids.has(`${v3}/old.md`) && !ids.has(oldPath)
        && indexed(graph, newPath, newTag) && indexed(graph, `${v3}/old.md`, oldTag);
    };
    const waitIndex = async (phase, accept) => {
      const deadline = Date.now() + 90_000;
      for (;;) {
        const status = await readApi(ctx, "/api/index/status");
        const health = await readApi(ctx, "/api/health");
        const graph = accept ? await readApi(ctx, "/api/graph") : null;
        // Keep the last actual answers even when a barrier times out.
        evidence.polls[phase] = { at: Date.now(), status, health, graph };
        const ready = status.state === "idle" && status.readiness?.state === "ready"
          && health.indexer?.status === "idle" && health.indexer.queue_depth === 0
          && !health.indexer.coalesced_rebuild;
        if (ready && (!accept || accept(graph))) return graph;
        if (Date.now() > deadline) throw new Error(`${phase}: the index did not become ready with the expected graph`);
        await delay(250);
      }
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
      if (renamed && url.pathname.endsWith("/api/graph")) refreshes.add(request);
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (!url.pathname.endsWith("/api/graph") || url.searchParams.get("stream") !== "1") return;
      const entry = { afterRename: refreshes.has(response.request()), at: Date.now() };
      evidence.pageGraphs.push(entry);
      const reading = (async () => {
        try {
          const stream = parseGraphStream(await response.text());
          entry.events = stream.events;
          entry.graph = { nodes: [...stream.nodes.values()], edges: stream.events.flatMap((event) => event.type === "edges" ? event.edges : []) };
          entry.graph.gated = stream.events.some((event) => event.type === "meta" && event.gated);
        } catch (error) {
          // The app may cancel an obsolete stream during a rebuild. Only a
          // later complete stream can satisfy the final barrier.
          entry.error = error.message;
        }
      })();
      responseReads.add(reading);
      void reading.finally(() => responseReads.delete(reading));
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
      await waitIndex("beforeFixture");
      for (const dir of [v1, v2, spare]) mkdirSync(join(ctx.workspaceDir, dir), { recursive: true });
      writeFileSync(join(ctx.workspaceDir, v1, "new.md"), `# new.md\n\n${newTag}\n`);
      writeFileSync(join(ctx.workspaceDir, oldPath), `# old.md\n\n${oldTag}\n`);
      // This extra opened level keeps a small rename patch below a whole
      // fetch's cost, even if the watcher also names the releases directory.
      writeFileSync(join(ctx.workspaceDir, spare, "untouched.md"), "# Untouched\n");

      // Filesystem nodes alone precede indexing. These tag edges prove the
      // index has parsed both fixture files at their initial paths.
      evidence.initialGraph = await waitIndex("fixtureIndexed", (graph) =>
        !graph.gated && indexed(graph, oldPath, oldTag) && indexed(graph, `${v1}/new.md`, newTag));
      const stream = await readGraphStream(ctx);
      evidence.initialStream = stream.events;
      const oldLabel = stream.nodes.get(oldPath)?.label;
      const newLabel = stream.nodes.get(`${v1}/new.md`)?.label;
      assert.ok(typeof oldLabel === "string" && oldLabel.length > 0, "old.md needs its streamed label");
      assert.ok(typeof newLabel === "string" && newLabel.length > 0, "new.md needs its streamed label");
      assert.notEqual(oldLabel, newLabel, "the rename fixtures must draw distinct labels");
      evidence.initialLevels = await captureLevels();
      const oldSpineLabel = evidence.initialLevels[v2].nodes.find((node) => node.id === oldPath)?.name;
      assert.ok(typeof oldSpineLabel === "string" && oldSpineLabel.length > 0, "old.md needs its spine label");
      // Once the shared graph drops a file, stale spine data can still draw
      // it under its filesystem name rather than its semantic label.
      evidence.oldLabels = [...new Set([oldLabel, oldSpineLabel])];
      evidence.newLabels = [newLabel];
      await observePage(page);
      await cdp.send("Network.enable");
      await page.setViewport({ width: 1280, height: 800 });
      const url = new URL(ctx.serverUrl);
      url.searchParams.set("w", windowId);
      url.hash = "s=" + encodeURIComponent(JSON.stringify({
        k: "l", f: 1,
        t: [{ k: "g", gp: v2, gn: `directory:${v2}`, gi: 1, ge: [root, releases, v2, spare], a: 1 }],
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
      await page.evaluate((roots) => {
        window.__smokeGraphApplyGate.roots = roots;
        window.__smokeGraphApplyGate.armed = true;
      }, [v1, v2, v3]);
      renamed = true;
      renameSync(join(ctx.workspaceDir, v2), join(ctx.workspaceDir, v3));
      renameSync(join(ctx.workspaceDir, v1), join(ctx.workspaceDir, v2));
      // Directory renames can queue a rebuild behind its cooldown. HTTP
      // remains live throughout; the app's readiness poll reloads the shared
      // graph normally when that rebuild finishes.
      evidence.finalGraph = await waitIndex("renamesIndexed", finalGraph);
      const pageHasFinalGraph = () => evidence.pageGraphs.some((entry) => entry.afterRename && entry.graph && finalGraph(entry.graph));
      evidence.after = await waitDrawn(page,
        (read) => pageHasFinalGraph() && read.applyGate?.armed && read.applyGate.held.length > 0
          && read.selected === "v2" && shows(read, evidence.newLabels) && !shows(read, evidence.oldLabels),
        "v2 must draw new.md and stop drawing old.md after replacement");
      assert.equal(evidence.after.timeOrigin, evidence.before.timeOrigin, "the page must not reload");
      assert.ok(evidence.after.applyGate.armed && evidence.after.applyGate.held.length > 0, "real index notifications must remain held during the assertion");
      assert.ok(pageHasFinalGraph(), "the page must receive the current shared graph");
      assert.ok(evidence.after.applyGate.held.some((frame) => frame.type === "graph_applied"), "real index notifications must be held");
      assert.ok(evidence.after.applyGate.held.some((frame) => frame.path === newPath), "the new file's real watch notification must be held");
      assert.ok(evidence.after.applyGate.passed.some((frame) => frame.path === v2 || frame.to === v2), "the directory's real rename notification must reach the app");
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
      await Promise.allSettled([...responseReads]);
      save();
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
