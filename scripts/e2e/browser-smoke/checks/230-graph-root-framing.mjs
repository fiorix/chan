// A workspace whose root holds about 110 entries still frames its graph:
// the fit gives the room under the root's seat to what lies under it, so
// the seat rises and every counted node and draft stays inside the canvas,
// with one disc on the seat the fit chose. Red at the base, where the ring
// of root children wraps under the root and past the bottom edge.
//
// Engine: headless Chrome through puppeteer-core; it says nothing about WebKit.
//
// The check writes 110 tag-free files at the workspace's root, waits until
// the server's graph holds them with the index idle, opens a workspace
// graph tab, and reads its discs once they hold: rootedFailures must be
// empty, and the status line must count at least the seeded files, so an
// empty graph cannot pass. The seat the assertion checks is the one the
// page published on the canvas, not a recomputed copy of the rule. The
// fixtures are removed at the end, so later checks meet the workspace as
// found.

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitFor } from "../lib/drafts.mjs";
import { draftDiscs, rootedFailures, steadyGraphDiscs, traceGraphDiscs, untraceGraphDiscs } from "../lib/graph-discs.mjs";

const RUN = Date.now().toString(36);
const COUNT = 110;
const PREFIX = `g230-rootfan-${RUN}-`;
const names = Array.from({ length: COUNT }, (_, i) => `${PREFIX}${String(i).padStart(3, "0")}.md`);

const command = (page, name) =>
  page.evaluate((id) => window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: id } })), name);

function seed(root) {
  for (const name of names) writeFileSync(join(root, name), `Root fan file ${name}.\n\nPlain prose, no tags, mentions or links.\n`);
}

function unseed(root) {
  for (const name of names) rmSync(join(root, name), { force: true });
}

/// The server's graph holding the seeded files with the index idle: the
/// same shape the Graph tab seeds its spine from, read until it holds the
/// seed and stays still across two reads.
async function waitSeededGraph(page, token) {
  const read = () =>
    page.evaluate(async ({ bearer, want }) => {
      const headers = bearer ? { authorization: `Bearer ${bearer}` } : {};
      const status = await (await fetch("/api/index/status", { headers })).json();
      const graph = await (await fetch("/api/graph", { headers })).json();
      if (status.state !== "idle" || graph.gated) return null;
      const ids = graph.nodes.map((node) => node.id);
      if (!want.every((name) => ids.includes(name))) return null;
      return ids.length;
    }, { bearer: token, want: names });
  const found = await waitFor(`the server graph holding ${COUNT} seeded root files`, 120_000, async () => {
    const n = await read();
    return typeof n === "number" ? n : null;
  });
  return found;
}

export default {
  name: "graph-root-framing",
  async run(ctx) {
    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    seed(ctx.workspaceDir);
    const page = await ctx.browser.newPage();
    const result = { browser: await ctx.browser.browser().version(), seeded: COUNT };
    let primary = null;
    try {
      await page.setViewport({ width: 1280, height: 800 });
      await page.bringToFront();
      const url = new URL(ctx.serverUrl);
      url.searchParams.set("w", `graph-230-${RUN}`);
      await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(".pane", { timeout: 30_000 });
      result.graphNodes = await waitSeededGraph(page, token);
      await traceGraphDiscs(page, ".graph-tab");
      await command(page, "app.graph.toggle");
      await page.waitForSelector(".graph-tab canvas", { timeout: 30_000 });
      const graph = await page.waitForFunction(() => {
        const host = document.querySelector(".graph-tab");
        const canvas = host?.querySelector("canvas");
        const stat = host?.querySelector(".statusbar .stat")?.textContent ?? "";
        const match = stat.match(/(\d+)\/(\d+) nodes\s+·\s+(\d+)\/(\d+) edges/);
        if (!canvas || !match || Number(match[1]) === 0) return false;
        return {
          width: canvas.width,
          height: canvas.height,
          visibleNodes: Number(match[1]),
          totalNodes: Number(match[2]),
          visibleEdges: Number(match[3]),
          totalEdges: Number(match[4]),
        };
      }, { timeout: 60_000, polling: 250 }).then((handle) => handle.jsonValue());
      if (graph.width === 0 || graph.height === 0) throw new Error(`the root-fan graph's canvas has no extent: ${graph.width}x${graph.height}`);
      if (await page.$(".graph-tab .placeholder.error")) throw new Error("the root-fan graph drew its error placeholder");
      const framed = await steadyGraphDiscs(page, ".graph-tab", { gap: 600, timeoutMs: 60_000 });
      await ctx.shot("230-rootfan-graph", page);
      result.graph = graph;
      result.framed = framed;
      if (typeof framed.counted !== "number" || framed.counted < COUNT) {
        throw new Error(`the root-fan graph counts ${framed.counted} nodes, fewer than the ${COUNT} seeded files`);
      }
      const drafts = await draftDiscs(page, token);
      const failures = rootedFailures(framed, framed.counted, drafts);
      if (failures.length) throw new Error(`the root-fan graph is not framed from its root: ${failures.join("; ")}; ${JSON.stringify(framed)}`);
      result.drafts = drafts;
      console.log(`[smoke]   root-fan graph framed: ${framed.count} discs for ${framed.counted} counted nodes and ${drafts} drafts; seat ${JSON.stringify(framed.seat)}; room ${JSON.stringify(framed.room)}`);
      return result;
    } catch (error) {
      primary = error;
      await ctx.shot("230-failure", page).catch(() => {});
      throw error;
    } finally {
      try {
        await untraceGraphDiscs(page).catch(() => {});
        await command(page, "app.tab.close").catch(() => {});
        await page.close().catch(() => {});
      } catch (error) {
        if (primary) console.log(`[smoke]   cleanup also failed: ${error?.message ?? error}`);
        else throw error;
      } finally {
        unseed(ctx.workspaceDir);
      }
    }
  },
};
