// The graph's depth is bounded, so raising it keeps the page answering.
//
// On a server and workspace of its own (the tree is too large to leave in
// the suite's shared workspace), a generated tree holds two directories:
// `chain/`, fourteen levels of nested directories with a note at the
// bottom, and `wide/`, ten folders of forty folders of fifty notes (20,410
// files and folders). Once the index is idle, a page opens a graph tab with
// a directory selected and its first level open, and drags the tab menu's
// Depth slider from its start to its end with the pointer, as a person does.
//
// On `wide`: while the pointer is down the graph draws nothing new (the
// slider applies on release); on release the depth stops at 2, the deepest
// level that draws no more than the drawn-node budget, the control reads
// "2 [limit]" and the address's opened tree holds `wide/a0` but not
// `wide/a0/b0`; the drag's folder reads stay within the per-step bound; and
// a frame probe's largest gap from the press until the graph settles stays
// under GAP_BOUND_MS. On `chain`: the slider ends at 10 and a drag to its
// end opens ten levels, not fourteen.
//
// GAP_BOUND_MS: a page that answers input draws its next frame within the
// 100 ms response budget of the RAIL model; 250 ms leaves two and a half
// times that for a guest under the suite's load, and stays under the roughly
// 375 ms a frame took over a 3,519-node graph, the largest graph with a
// frame-cost reading. A baseline arm reads the idle page first: when its own
// gaps already pass the bound, or it draws under 30 frames a second, the
// host cannot judge the bound and the check skips rather than fails.
//
// The first run at the change must PASS with the drag arm's largest gap and
// folder read count recorded. At e262cf2df (every intermediate value applied,
// no cap, no budget, no read bound) it must fail: the drawn count grows while
// the pointer is down, the depth reaches 3 with no "[limit]", and `chain`'s
// slider ends at 15; the frame gap and the folder reads are read and
// recorded either way, so the first base run also shows whether a drag over
// 20,000 nodes crosses the gap bound.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchServer, teardownServer } from "../lib/server.mjs";
import { maskTokens } from "../lib/token-mask.mjs";

const GAP_BOUND_MS = 250;
/// The baseline's frame rate under which the host is too loaded to judge.
const MIN_BASELINE_FPS = 30;
/// The workspace app's GRAPH_DRAWN_NODE_BUDGET and the folders one step reads.
const DRAWN_NODE_BUDGET = 3000;
const READS_PER_STEP = 64;
/// FS_GRAPH_DEPTH_MAX, the server's walk.
const DEPTH_MAX = 10;
const CHAIN_LEVELS = 14;
const WIDE = { top: 10, middle: 40, notes: 50 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function generate(root) {
  let dir = join(root, "chain");
  for (let level = 0; level < CHAIN_LEVELS; level += 1) dir = join(dir, `l${level}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "leaf.md"), "# Leaf\n");
  for (let a = 0; a < WIDE.top; a += 1) {
    for (let b = 0; b < WIDE.middle; b += 1) {
      const folder = join(root, "wide", `a${a}`, `b${b}`);
      mkdirSync(folder, { recursive: true });
      for (let n = 0; n < WIDE.notes; n += 1) writeFileSync(join(folder, `n${n}.md`), `# ${a}-${b}-${n}\n`);
    }
  }
  return 1 + WIDE.top * WIDE.middle * WIDE.notes;
}

async function authed(origin, token, path) {
  const response = await fetch(new URL(path, origin), { headers: { authorization: `Bearer ${token}` } });
  assert.ok(response.ok, `GET ${path}: ${response.status}`);
  return response.json();
}

async function awaitIndexed(origin, token, notes) {
  const deadline = Date.now() + 600_000;
  let status = null;
  while (Date.now() < deadline) {
    status = await authed(origin, token, "/api/index/status").catch(() => null);
    if (status?.state === "idle" && status.readiness?.state === "ready" && status.indexed_docs >= notes) return;
    await sleep(1000);
  }
  throw new Error(`the index never held the ${notes} notes: ${JSON.stringify(status)}`);
}

/// The active graph's drawn and total node counts once two samples 250 ms
/// apart agree with no load in flight.
async function settledGraph(page, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const now = await page.evaluate(() => {
      const panel = document.querySelector(".graph-tab.active");
      if (!panel || panel.querySelector(".canvas > .stream-status, .canvas > .placeholder")) return null;
      const match = (panel.querySelector(".statusbar .stat")?.textContent ?? "").match(/(\d+)\/(\d+) nodes/);
      return match && Number(match[2]) > 0 ? { drawn: Number(match[1]), total: Number(match[2]) } : null;
    });
    if (now && last && now.drawn === last.drawn && now.total === last.total) return now;
    last = now;
    await sleep(250);
  }
  throw new Error(`the graph did not settle: ${JSON.stringify(last)}`);
}

function drawnNow(page) {
  return page.evaluate(() => {
    const text = document.querySelector(".graph-tab.active .statusbar .stat")?.textContent ?? "";
    const match = text.match(/(\d+)\/(\d+) nodes/);
    return match ? Number(match[1]) : null;
  });
}

/// The opened directories the page's address holds for its graph tab.
function addressTree(page) {
  return page.evaluate(() => {
    const layout = JSON.parse(new URLSearchParams(location.hash.slice(1)).get("s") ?? "null");
    const find = (node) => {
      if (!node) return null;
      if (node.k === "s") return find(node.a) ?? find(node.b);
      return [...(node.t ?? []), ...(node.bt ?? [])].find((tab) => tab.k === "g") ?? null;
    };
    return find(layout)?.ge ?? [];
  });
}

async function addressHolds(page, accept, what) {
  const deadline = Date.now() + 15_000;
  let tree = [];
  while (Date.now() < deadline) {
    tree = await addressTree(page);
    if (accept(tree)) return tree;
    await sleep(250);
  }
  throw new Error(`the address never held ${what}: ${JSON.stringify(tree)}`);
}

async function openDepthRow(page) {
  const tab = await page.$(".graph-tab.active");
  assert.ok(tab, "no active graph tab");
  await tab.click({ button: "right" });
  await page.waitForSelector(".tab-menu-bubble .depth-row input[type='range']", { visible: true, timeout: 10_000 });
  return page.evaluate(() => {
    const row = document.querySelector(".tab-menu-bubble .depth-row");
    const slider = row.querySelector("input[type='range']");
    return { min: slider.min, max: slider.max, value: slider.value };
  });
}

function depthText(page) {
  return page.evaluate(() =>
    (document.querySelector(".tab-menu-bubble .depth-value")?.textContent ?? "").replace(/\s+/g, " ").trim(),
  );
}

function startProbe(page) {
  return page.evaluate(() => {
    const probe = { stamps: [], running: true };
    window.__depthProbe = probe;
    const frame = (now) => {
      probe.stamps.push(now);
      if (probe.running) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

/// Stop the probe and read the frames it saw and the largest gap between
/// two of them.
async function takeProbe(page) {
  return page.evaluate(() => {
    const probe = window.__depthProbe;
    probe.running = false;
    const stamps = probe.stamps;
    let gap = 0;
    for (let i = 1; i < stamps.length; i += 1) gap = Math.max(gap, stamps[i] - stamps[i - 1]);
    const span = stamps.length > 1 ? stamps.at(-1) - stamps[0] : 0;
    return { frames: stamps.length, spanMs: Math.round(span), maxGapMs: Math.round(gap) };
  });
}

/// Press on the slider's start, move the pointer to its end in steps, read
/// the drawn count at each step, and release.
async function dragToEnd(page) {
  const box = await page.$eval(".tab-menu-bubble .depth-row input[type='range']", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top + r.height / 2, width: r.width };
  });
  // The pointer stays on the track, from its first pixel to its last, so
  // the press and the release both land on the slider.
  const drawnWhileDown = [];
  await page.mouse.move(box.x + 1, box.y);
  await page.mouse.down();
  const steps = 20;
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(box.x + 1 + ((box.width - 2) * step) / steps, box.y);
    await sleep(40);
    drawnWhileDown.push(await drawnNow(page));
  }
  await page.mouse.up();
  return drawnWhileDown;
}

function graphUrl(origin, token, windowId, dir) {
  const url = new URL(origin);
  url.searchParams.set("t", token);
  url.searchParams.set("w", windowId);
  const tab = { k: "g", gp: dir, gn: `directory:${dir}`, ge: [dir], a: 1 };
  url.hash = "s=" + encodeURIComponent(JSON.stringify({ k: "l", f: 1, t: [tab] }));
  return url.href;
}

export default {
  name: "graph-depth-bounds",
  async run(ctx) {
    const workspaceDir = mkdtempSync(join(tmpdir(), "chan-smoke-depth-"));
    const notes = generate(workspaceDir);
    const lines = [];
    const server = launchServer(ctx.chanBin, workspaceDir, (line) => lines.push(maskTokens(line)));
    const pages = [];
    const record = {};
    try {
      const url = new URL(await server.url);
      const token = url.searchParams.get("t") ?? "";
      await awaitIndexed(url.origin, token, notes);
      const open = async (dir) => {
        const page = await ctx.browser.newPage();
        pages.push(page);
        await page.setViewport({ width: 1280, height: 800 });
        const windowId = `smoke-301-${dir}-${Date.now().toString(36)}`;
        await page.goto(graphUrl(url.origin, token, windowId, dir), { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForSelector(".graph-tab.active canvas", { timeout: 60_000 });
        await settledGraph(page);
        return page;
      };

      // ---- wide: release, the budget, the reads, the frames -------------
      const wide = await open("wide");
      const before = await settledGraph(wide);
      const slider = await openDepthRow(wide);
      record.wideSlider = slider;
      assert.deepEqual([slider.min, slider.value, slider.max], ["0", "1", "3"], "wide/ opens one level of three");

      await startProbe(wide);
      await sleep(2000);
      const baseline = await takeProbe(wide);
      record.baseline = baseline;
      const baselineFps = baseline.spanMs > 0 ? (1000 * (baseline.frames - 1)) / baseline.spanMs : 0;
      if (baseline.maxGapMs > GAP_BOUND_MS || baselineFps < MIN_BASELINE_FPS) {
        ctx.skip(`the idle page cannot judge a ${GAP_BOUND_MS} ms frame bound: ${JSON.stringify(baseline)}`);
      }

      const reads = [];
      const onRequest = (request) => {
        const target = new URL(request.url());
        if (target.pathname.endsWith("/api/fs-graph")) reads.push(target.searchParams.get("path") ?? "");
      };
      wide.on("request", onRequest);
      await startProbe(wide);
      const drawnWhileDown = await dragToEnd(wide);
      const after = await settledGraph(wide);
      await sleep(1000);
      const dragged = await takeProbe(wide);
      wide.off("request", onRequest);
      const folders = new Set(reads);
      Object.assign(record, { before, drawnWhileDown, after, dragged, folderReads: folders.size, requests: reads.length });
      await ctx.shot("wide-released", wide);

      assert.ok(
        drawnWhileDown.every((drawn) => drawn === before.drawn),
        `the drawn graph changed while the pointer was down: ${JSON.stringify({ before: before.drawn, drawnWhileDown })}`,
      );
      assert.equal(await depthText(wide), "2 [limit]", "the depth stops at the budget and says so");
      assert.ok(after.drawn <= DRAWN_NODE_BUDGET, `the released depth drew ${after.drawn} nodes`);
      await addressHolds(
        wide,
        (tree) => tree.includes("wide/a0") && !tree.includes("wide/a0/b0"),
        "wide/a0 opened and wide/a0/b0 closed",
      );
      assert.ok(folders.size <= READS_PER_STEP + 1, `one step read ${folders.size} folders`);
      assert.ok(
        dragged.frames * 100 >= dragged.spanMs,
        `the probe saw too few frames to judge: ${JSON.stringify(dragged)}`,
      );
      assert.ok(
        dragged.maxGapMs <= GAP_BOUND_MS,
        `a frame gap passed ${GAP_BOUND_MS} ms while the depth changed: ${JSON.stringify(dragged)}`,
      );

      // ---- chain: the server's walk bounds a directory's depth -----------
      const chain = await open("chain");
      const chainSlider = await openDepthRow(chain);
      record.chainSlider = chainSlider;
      assert.equal(chainSlider.max, String(DEPTH_MAX), `a ${CHAIN_LEVELS + 1}-level directory's depth ends at ${DEPTH_MAX}`);
      await dragToEnd(chain);
      await settledGraph(chain);
      await ctx.shot("chain-released", chain);
      const levels = (count) => ["chain", ...Array.from({ length: count }, (_, i) => `l${i}`)].join("/");
      await addressHolds(
        chain,
        (tree) => tree.includes(levels(DEPTH_MAX - 1)) && !tree.includes(levels(DEPTH_MAX)),
        `${DEPTH_MAX} levels opened below chain/ and no more`,
      );
      return record;
    } catch (error) {
      // The readings go into the results either way.
      if (!error.smokeSkip) error.smokeDetails = record;
      throw error;
    } finally {
      for (const page of pages) await page.close().catch(() => {});
      await teardownServer(ctx.chanBin, server.child, workspaceDir, server.chanHome);
      record.serverLines = lines.length;
    }
  },
};
