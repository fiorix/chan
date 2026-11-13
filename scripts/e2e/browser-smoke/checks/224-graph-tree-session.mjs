// A graph tab's opened tree is part of its window's saved session, so a
// window opened again from its session draws the tree the user left, as a
// reloaded page does from its own address.
//
// In a window of its own, once the server's graph holds the fixture, a graph
// tab opens on a directory, selected and opened. The check waits for the
// window's saved session to hold that selection, then raises the selected
// directory's depth with the "Graph depth: increase" command, which opens the
// directories below it and selects nothing new, and reads the saved session
// again until it holds them. That read comes before the page closes on
// purpose: the desktop hides a window, and quits, with no page code running,
// so the session as saved by then is what comes back. The page then closes
// and a new one opens the window by its id alone, with no address state, and
// must draw the same tree: the same directory selected, the same directories
// opened, the same count of nodes drawn.

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RUN = Date.now().toString(36);
const DIR = `graph-tree-${RUN}`;
const DEEPEST = `${DIR}/one/deeper/b.md`;
const FILES = [`${DIR}/top.md`, `${DIR}/one/a.md`, DEEPEST, `${DIR}/two/c.md`];
/// Longer than the session save's debounce and its write, on a loaded host.
const SAVED_WITHIN_MS = 10_000;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

function windowUrl(ctx, windowId, layout) {
  const url = new URL(ctx.serverUrl);
  url.searchParams.set("w", windowId);
  if (layout) url.hash = "s=" + encodeURIComponent(JSON.stringify(layout));
  return url.href;
}

/// The graph tab of the window's saved session, or null.
async function savedGraphTab(ctx, windowId) {
  const url = new URL("/api/session", ctx.serverUrl);
  url.search = "";
  url.searchParams.set("w", windowId);
  const token = new URL(ctx.serverUrl).searchParams.get("t");
  const response = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (response.status === 204) return null;
  assert.ok(response.ok, `GET /api/session: ${response.status}`);
  const find = (node) => {
    if (!node) return null;
    if (node.k === "s") return find(node.a) ?? find(node.b);
    return [...(node.t ?? []), ...(node.bt ?? [])].find((tab) => tab.k === "g") ?? null;
  };
  return find((await response.json()).layout);
}

async function savedWith(ctx, windowId, accept, what) {
  const start = Date.now();
  let tab = null;
  for (;;) {
    tab = await savedGraphTab(ctx, windowId);
    if (tab && accept(tab)) return tab;
    if (Date.now() - start > SAVED_WITHIN_MS) {
      throw new Error(`the saved session did not hold ${what} within ${SAVED_WITHIN_MS} ms: ${JSON.stringify(tab)}`);
    }
    await delay(200);
  }
}

/// The active graph tab's status line and selection, once both hold: two
/// equal samples 250 ms apart, with no load in flight.
async function settledGraph(page) {
  let last = null;
  for (let round = 0; round < 120; round += 1) {
    const now = await page.evaluate(() => {
      const panel = document.querySelector(".graph-tab.active");
      if (!panel || panel.querySelector(".canvas > .stream-status, .canvas > .placeholder")) return null;
      const match = (panel.querySelector(".statusbar .stat")?.textContent ?? "").match(/(\d+)\/(\d+) nodes/);
      if (!match || Number(match[2]) === 0) return null;
      const crumbs = [...panel.querySelectorAll(".scope-crumbs .crumb")].map((c) => c.textContent?.trim() ?? "");
      return { visibleNodes: Number(match[1]), selected: crumbs.at(-1) ?? "" };
    });
    if (now && last && JSON.stringify(now) === JSON.stringify(last)) return now;
    last = now;
    await delay(250);
  }
  throw new Error(`the graph did not settle: ${JSON.stringify(last)}`);
}

/// The opened directories the page's own address holds for its graph tab.
function addressTree(page) {
  return page.evaluate(() => {
    const layout = JSON.parse(new URLSearchParams(location.hash.slice(1)).get("s") ?? "null");
    const find = (node) => {
      if (!node) return null;
      if (node.k === "s") return find(node.a) ?? find(node.b);
      return [...(node.t ?? []), ...(node.bt ?? [])].find((tab) => tab.k === "g") ?? null;
    };
    return find(layout)?.ge ?? null;
  });
}

export default {
  name: "graph-tree-session",
  async run(ctx) {
    for (const rel of FILES) {
      mkdirSync(join(ctx.workspaceDir, rel, ".."), { recursive: true });
      writeFileSync(join(ctx.workspaceDir, rel), `# ${rel}\n`);
    }
    const windowId = `smoke-224-${RUN}`;
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    const pages = [];
    const errors = [];
    const open = async (href) => {
      const page = await ctx.browser.newPage();
      pages.push(page);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(".graph-tab canvas", { timeout: 30_000 });
      return page;
    };
    try {
      // The depth a directory can open to is read from the graph the page
      // loads, so the page opens once the server's graph holds the deepest
      // fixture file.
      const start = Date.now();
      for (;;) {
        const url = new URL("/api/graph", ctx.serverUrl);
        url.search = "";
        const response = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} }).catch(() => null);
        const graph = response?.ok ? await response.json() : null;
        if (!graph?.gated && graph?.nodes?.some((node) => node.id === DEEPEST)) break;
        if (Date.now() - start > 90_000) throw new Error(`the server's graph never held ${DEEPEST}`);
        await delay(250);
      }
      const first = await open(windowUrl(ctx, windowId, { k: "l", f: 1, t: [{ k: "g", gp: DIR, ge: [DIR], a: 1 }] }));
      const opened = await settledGraph(first);
      assert.equal(opened.selected, DIR, "the tab opens on its directory");
      await savedWith(ctx, windowId, (tab) => tab.gn === `directory:${DIR}`, "the selection");

      await first.evaluate(() =>
        window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.graph.depth.increase" } })),
      );
      // The page draws the deeper tree first, so a session without it is the
      // session's failure, not the command's.
      const deeper = await settledGraph(first);
      assert.ok(deeper.visibleNodes > opened.visibleNodes, `raising the depth draws more: ${JSON.stringify({ opened, deeper })}`);
      const saved = await savedWith(ctx, windowId, (tab) => (tab.ge ?? []).includes(`${DIR}/one`), `${DIR}/one opened`);
      await ctx.shot("224-before-close", first);
      await first.close();

      const again = await open(windowUrl(ctx, windowId));
      const restored = await settledGraph(again);
      const tree = await addressTree(again);
      await ctx.shot("224-reopened", again);
      const evidence = { opened, saved: saved.ge, deeper, restored, tree };
      assert.equal(restored.selected, DIR, `the window comes back on its directory: ${JSON.stringify(evidence)}`);
      assert.ok(tree?.includes(`${DIR}/one`), `the window comes back with ${DIR}/one opened: ${JSON.stringify(evidence)}`);
      assert.equal(restored.visibleNodes, deeper.visibleNodes, `the window draws the tree it was closed on: ${JSON.stringify(evidence)}`);
      assert.deepEqual(errors, []);
      return evidence;
    } finally {
      for (const page of pages) await page.close().catch(() => {});
      // The runner keeps one server and one workspace for every check: the
      // fixture and the saved window go with this one.
      rmSync(join(ctx.workspaceDir, DIR), { recursive: true, force: true });
      const url = new URL("/api/session", ctx.serverUrl);
      url.search = "";
      url.searchParams.set("w", windowId);
      await fetch(url, { method: "DELETE", headers: token ? { authorization: `Bearer ${token}` } : {} }).catch(() => {});
    }
  },
};
