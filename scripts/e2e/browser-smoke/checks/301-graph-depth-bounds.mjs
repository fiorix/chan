// The graph's depth is bounded, so raising it keeps the page answering.
//
// On a server and workspace of its own (the tree is too large to leave in
// the suite's shared workspace), a generated tree holds:
//
//   wide/     10 folders of 280 folders of 8 notes, all indexed, so the
//             window's shared graph holds the whole of it: depth 2 draws
//             about 2,815 nodes, depth 3 about 25,200;
//   chain/    fourteen nested folders with a note at the bottom;
//   ignored/  listed in the root .gitignore, so the index and the shared
//             graph hold none of it and the tab reads it from disk:
//             heavy/ has 60 folders of 60 notes (a second level would draw
//             about 3,660 nodes), many/ has 100 folders of 20 notes (about
//             2,110, more folders than one read takes), and each has a
//             deep/ folder with a note that gives its depth a second level.
//
// Once the index is idle, each leg opens a page whose graph tab has one
// directory selected and its first level open (and the deep/ folder, for
// the two ignored legs), opens the tab menu and drags its Depth slider from
// its start to its end with the pointer, as a person does, then waits for
// the graph to settle. Every leg's readings are recorded before anything is
// asserted, so a failing leg leaves the others read.
//
//   wide:  while the pointer is down the drawn count does not change; the
//          release stops at "2 [limit]", draws at most the budget, and the
//          address's opened tree holds wide/a0 but not wide/a0/b0; a frame
//          probe's largest gap from the press until the graph settles is
//          within GAP_BOUND_MS, over a step that brings in about 2,800 nodes.
//   heavy: the release reads the 60 folders' children before it opens a
//          level, finds the second level past the budget, and stays at
//          "1 [limit]" with at most the budget drawn.
//   many:  the release reads all 100 folders, past the 64 one read takes,
//          and opens the second level with no further step: the 2,000
//          notes are drawn.
//   chain: the slider ends at 10 and a drag to its end opens ten levels.
//
// GAP_BOUND_MS: a page that answers input draws its next frame within the
// 100 ms response budget of the RAIL model; 250 ms leaves two and a half
// times that for a guest under the suite's load. The layout runs one
// d3-force tick a frame, about 12 ms over 3,000 nodes and about 160 ms over
// 20,000 in V8 on a desktop CPU, so a step held to the budget stays well
// inside the bound and an unbounded one over 25,000 nodes need not. A
// baseline arm reads the idle page first: when its own gaps already pass
// the bound, or it draws under 30 frames a second, the host cannot judge
// the bound, and the check skips once every other reading has passed.
//
// The first run at the change must pass, recording the wide leg's largest
// gap and each leg's folder reads. At e262cf2df it must fail: on wide the
// drawn count changes while the pointer is down and the depth reaches 3 with
// no "[limit]"; on heavy the second level opens and draws past the budget
// with no "[limit]"; chain's slider ends at 15. The many leg passes there
// (its old raise read every opened folder at once) and fails at the range's
// earlier tip, whose raise read 64 and stopped. The wide leg's gap is
// recorded at every commit; the first base run shows whether a drag over
// 25,000 nodes crosses the bound.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchServer, teardownServer } from "../lib/server.mjs";
import { maskTokens } from "../lib/token-mask.mjs";

const GAP_BOUND_MS = 250;
/// The baseline's frame rate under which the host is too loaded to judge.
const MIN_BASELINE_FPS = 30;
/// The workspace app's GRAPH_DRAWN_NODE_BUDGET.
const DRAWN_NODE_BUDGET = 3000;
/// FS_GRAPH_DEPTH_MAX, the server's walk.
const DEPTH_MAX = 10;
const CHAIN_LEVELS = 14;
const WIDE = { top: 10, middle: 280, notes: 8 };
const HEAVY = { folders: 60, notes: 60 };
const MANY = { folders: 100, notes: 20 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function note(path, text) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `# ${text}\n`);
}

/// Writes the tree and answers how many notes the index holds of it.
function generate(root) {
  writeFileSync(join(root, ".gitignore"), "ignored/\n");
  let dir = join(root, "chain");
  for (let level = 0; level < CHAIN_LEVELS; level += 1) dir = join(dir, `l${level}`);
  note(join(dir, "leaf.md"), "leaf");
  for (let a = 0; a < WIDE.top; a += 1) {
    for (let b = 0; b < WIDE.middle; b += 1) {
      for (let n = 0; n < WIDE.notes; n += 1) note(join(root, "wide", `a${a}`, `b${b}`, `n${n}.md`), `${a}-${b}-${n}`);
    }
  }
  for (const [name, shape] of [["heavy", HEAVY], ["many", MANY]]) {
    for (let f = 0; f < shape.folders; f += 1) {
      for (let n = 0; n < shape.notes; n += 1) note(join(root, "ignored", name, `u${f}`, `n${n}.md`), `${name}-${f}-${n}`);
    }
    note(join(root, "ignored", name, "deep", "x.md"), `${name} deep`);
  }
  return 1 + WIDE.top * WIDE.middle * WIDE.notes;
}

async function authed(origin, token, path) {
  const response = await fetch(new URL(path, origin), { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`GET ${path}: ${response.status}`);
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
/// apart agree with no load in flight; null when it does not settle.
async function settledGraph(page, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const now = await drawnCounts(page).catch(() => null);
    if (now && last && now.drawn === last.drawn && now.total === last.total) return now;
    last = now;
    await sleep(250);
  }
  return null;
}

function drawnCounts(page) {
  return page.evaluate(() => {
    const panel = document.querySelector(".graph-tab.active");
    if (!panel || panel.querySelector(".canvas > .stream-status, .canvas > .placeholder")) return null;
    const match = (panel.querySelector(".statusbar .stat")?.textContent ?? "").match(/(\d+)\/(\d+) nodes/);
    return match && Number(match[2]) > 0 ? { drawn: Number(match[1]), total: Number(match[2]) } : null;
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

/// The address's opened tree once two reads 500 ms apart agree (the address
/// is written a moment after the tree changes), or as it stands after 15 s.
async function addressSettled(page) {
  const deadline = Date.now() + 15_000;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(500);
    const tree = await addressTree(page).catch(() => []);
    if (last !== null && JSON.stringify(tree) === JSON.stringify(last)) return tree;
    last = tree;
  }
  return last ?? [];
}

async function openDepthRow(page) {
  const tab = await page.$(".graph-tab.active");
  if (!tab) throw new Error("no active graph tab");
  await tab.click({ button: "right" });
  await page.waitForSelector(".tab-menu-bubble .depth-row input[type='range']", { visible: true, timeout: 10_000 });
  return page.evaluate(() => {
    const slider = document.querySelector(".tab-menu-bubble .depth-row input[type='range']");
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
function takeProbe(page) {
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
/// the drawn count at each step, and release. The pointer stays on the
/// track, from its first pixel to its last, so the press and the release
/// both land on the slider.
async function dragToEnd(page) {
  const box = await page.$eval(".tab-menu-bubble .depth-row input[type='range']", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top + r.height / 2, width: r.width };
  });
  const drawnWhileDown = [];
  await page.mouse.move(box.x + 1, box.y);
  await page.mouse.down();
  const steps = 20;
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(box.x + 1 + ((box.width - 2) * step) / steps, box.y);
    await sleep(40);
    drawnWhileDown.push((await drawnCounts(page).catch(() => null))?.drawn ?? null);
  }
  await page.mouse.up();
  return drawnWhileDown;
}

function graphUrl(origin, token, windowId, dir, opened) {
  const url = new URL(origin);
  url.searchParams.set("t", token);
  url.searchParams.set("w", windowId);
  const tab = { k: "g", gp: dir, gn: `directory:${dir}`, ge: opened, a: 1 };
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
      const open = async (dir, opened = [dir]) => {
        const page = await ctx.browser.newPage();
        pages.push(page);
        await page.setViewport({ width: 1280, height: 800 });
        const windowId = `smoke-301-${dir.replaceAll("/", "-")}-${Date.now().toString(36)}`;
        await page.goto(graphUrl(url.origin, token, windowId, dir, opened), { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForSelector(".graph-tab.active canvas", { timeout: 60_000 });
        return page;
      };
      /// Opens a leg's page, drags its slider to the end and records what
      /// it reads; an error ends the leg and is recorded with it.
      const leg = async (name, dir, opened, probe) => {
        const reading = {};
        record[name] = reading;
        let page;
        try {
          page = await open(dir, opened);
          reading.before = await settledGraph(page);
          reading.slider = await openDepthRow(page);
          if (probe) {
            await startProbe(page);
            await sleep(2000);
            reading.baseline = await takeProbe(page);
          }
          const reads = [];
          page.on("request", (request) => {
            const target = new URL(request.url());
            if (target.pathname.endsWith("/api/fs-graph")) reads.push(target.searchParams.get("path") ?? "");
          });
          if (probe) await startProbe(page);
          try {
            reading.drawnWhileDown = await dragToEnd(page);
            reading.after = await settledGraph(page);
            await sleep(1000);
          } finally {
            if (probe) reading.dragged = await takeProbe(page).catch((error) => ({ error: error.message }));
          }
          reading.depth = await depthText(page);
          reading.folderReads = [...new Set(reads)].filter((path) => path !== "" && path.startsWith(`${dir}/`)).length;
          reading.address = await addressSettled(page);
          await ctx.shot(`${name}-released`, page).catch(() => {});
        } catch (error) {
          reading.error = error.message;
        }
      };

      await leg("wide", "wide", ["wide"], true);
      await leg("heavy", "ignored/heavy", ["ignored", "ignored/heavy", "ignored/heavy/deep"], false);
      await leg("many", "ignored/many", ["ignored", "ignored/many", "ignored/many/deep"], false);
      await leg("chain", "chain", ["chain"], false);

      // ---- the verdict, over every reading ------------------------------
      const failures = [];
      const expect = (ok, what) => {
        if (!ok) failures.push(what);
      };
      for (const [name, reading] of Object.entries(record)) expect(!reading.error, `${name}: ${reading.error}`);
      const { wide, heavy, many, chain } = record;
      expect(
        wide.before && wide.drawnWhileDown?.every((drawn) => drawn === wide.before.drawn),
        "wide: the drawn graph changed while the pointer was down",
      );
      expect(wide.depth === "2 [limit]", `wide: the release reads "${wide.depth}", not "2 [limit]"`);
      expect(wide.after && wide.after.drawn <= DRAWN_NODE_BUDGET, `wide: ${wide.after?.drawn} nodes drawn`);
      expect(
        wide.address?.includes("wide/a0") && !wide.address?.includes("wide/a0/b0"),
        "wide: the opened tree is not wide/a0 open and wide/a0/b0 closed",
      );
      expect(heavy.depth === "1 [limit]", `heavy: the release reads "${heavy.depth}", not "1 [limit]"`);
      expect(heavy.after && heavy.after.drawn <= DRAWN_NODE_BUDGET, `heavy: ${heavy.after?.drawn} nodes drawn`);
      expect(heavy.folderReads === HEAVY.folders, `heavy: ${heavy.folderReads} folders read, not its ${HEAVY.folders}`);
      expect(!heavy.address?.includes("ignored/heavy/u0"), "heavy: the level past the budget opened");
      expect(many.address?.includes(`ignored/many/u${MANY.folders - 1}`), "many: the folders past the first read did not open");
      expect(
        many.after && many.after.drawn >= MANY.folders * MANY.notes,
        `many: ${many.after?.drawn} nodes drawn, under the ${MANY.folders * MANY.notes} notes`,
      );
      expect(chain.slider?.max === String(DEPTH_MAX), `chain: the slider ends at ${chain.slider?.max}`);
      const level = (count) => ["chain", ...Array.from({ length: count }, (_, i) => `l${i}`)].join("/");
      expect(
        chain.address?.includes(level(DEPTH_MAX - 1)) && !chain.address?.includes(level(DEPTH_MAX)),
        `chain: not ${DEPTH_MAX} levels opened`,
      );

      const baseline = wide.baseline;
      const baselineFps = baseline?.spanMs > 0 ? (1000 * (baseline.frames - 1)) / baseline.spanMs : 0;
      const judgeable = baseline && baseline.maxGapMs <= GAP_BOUND_MS && baselineFps >= MIN_BASELINE_FPS;
      record.frameBound = judgeable ? "judged" : "unjudged";
      if (judgeable) {
        const dragged = wide.dragged;
        expect(dragged && !dragged.error && dragged.frames * 100 >= dragged.spanMs, `wide: too few frames to judge: ${JSON.stringify(dragged)}`);
        expect(dragged && dragged.maxGapMs <= GAP_BOUND_MS, `wide: a frame gap passed ${GAP_BOUND_MS} ms: ${JSON.stringify(dragged)}`);
      }
      if (failures.length > 0) {
        const error = new Error(failures.join("; "));
        error.smokeDetails = record;
        throw error;
      }
      if (!judgeable) ctx.skip(`every reading passed, but the idle page cannot judge a ${GAP_BOUND_MS} ms frame bound: ${JSON.stringify(baseline)}`);
      return record;
    } catch (error) {
      if (!error.smokeSkip && !error.smokeDetails) error.smokeDetails = record;
      throw error;
    } finally {
      for (const page of pages) await page.close().catch(() => {});
      await teardownServer(ctx.chanBin, server.child, workspaceDir, server.chanHome);
      record.serverLines = lines.length;
    }
  },
};
