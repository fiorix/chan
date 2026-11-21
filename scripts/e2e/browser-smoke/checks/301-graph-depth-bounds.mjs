// The graph's depth is bounded, so raising it keeps the page answering.
//
// On a server and workspace of its own (the tree is too large to leave in
// the suite's shared workspace), a generated tree holds:
//
//   wide/     10 folders of 280 folders of 8 notes, all indexed, so the
//             window's shared graph holds the whole of it: depth 2 draws
//             about 2,815 nodes, depth 3 about 25,200;
//   chain/    fourteen nested folders with a note at the bottom;
//   ignored/  listed in the root .gitignore, which keeps it out of the
//             index; the shared graph holds its notes all the same, since
//             its tree layer lists the tree from disk, while the tab's
//             spine holds a folder's level only once it reads it: heavy/
//             has 60 folders of 60 notes (a second level would draw about
//             3,660 nodes), many/ has 100 folders of 20 notes (about 2,110,
//             more folders than one read takes), and each has a deep/
//             folder with a note that gives its depth a second level.
//
// Once the index is idle, each leg opens a page whose graph tab has one
// directory selected and its first level open (and the deep/ folder, for
// the two ignored legs), opens the tab menu and drags its Depth slider from
// its start to its end with the pointer, as a person does, then waits for
// the graph to settle: QUIET_MS with no fs-graph request in flight and no
// change in the drawn count. Every leg's readings are recorded before
// anything is asserted, so a failing leg leaves the others read. Every leg
// first checks its own drag: the slider reads its end when the pointer is
// released, or the leg fails as a drag, not as the graph.
//
//   wide:  while the pointer is down the drawn count does not change; the
//          release stops at "2 [limit]", draws the second level's 2,800
//          folders and at most the budget, and the address's opened tree
//          holds wide/a0 but not wide/a0/b0; a frame probe's largest gap
//          from the press until the graph settles is within GAP_BOUND_MS,
//          over that step.
//   heavy: the graph already counts the second level past the budget, so
//          the release reads none of the 60 folders and stays at
//          "1 [limit]" with at most the budget drawn.
//   many:  the release reads all 100 folders, past the 64 one read takes,
//          and opens the second level with no further step: the 2,000
//          notes are drawn.
//   chain: the slider ends at 10 and a drag to its end opens ten levels.
//
// GAP_BOUND_MS: a page that answers input draws its next frame within the
// 100 ms response budget of the RAIL model; 250 ms leaves two and a half
// times that for a guest under the suite's load. The layout runs one
// d3-force tick a frame, at the canvas's forces about 13 ms over 3,000
// nodes and about 110 ms over 20,000 in Node's V8 on a desktop CPU, so a
// step held to the budget stays well inside the bound and an unbounded one
// over 25,000 nodes need not. A baseline arm reads the idle page first:
// when its own gaps already pass the bound, or it draws under 30 frames a
// second, the host cannot judge the bound, and the check skips once every
// other reading has passed.
//
// QUIET_MS: a raise reads its folders one request after another and
// draws a level once its last read lands, a frame or two later; 1,500 ms
// with neither a request nor a change in the drawn count is a raise that
// has ended, on a guest under the suite's load too.
//
// The pages ask for reduced motion. The tab menu otherwise pops in (from
// scale 0.92 over 260 ms) and grows by 1.5% under the pointer, so a box
// read while the menu opens puts the press beside the slider, where the
// drag moves nothing, or the release short of the slider's end. The drag
// reads the slider's box once it holds still across two frames, presses
// on the thumb where the slider's value puts it (the press point must hit
// the slider), and aims each step along the track where it stands then: a
// depth row's "[limit]" cue hides while a drafted value shows, the row
// narrows, and the slider moves under the pointer. The leg records the
// slider's value and left edge at each step and the events it saw.
//
// What each leg catches: wide, a depth applied at every value of a drag,
// and a release that opens past the budget or shows no "[limit]"; heavy, a
// raise that reads a level the graph already counts past the budget; many,
// a raise that stops after the first batch of folder reads; chain, a
// directory's depth past the server's walk. The result records the wide
// leg's largest frame gap and each leg's folder reads whether the check
// passes or not.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchServer, teardownServer } from "../lib/server.mjs";
import { maskTokens } from "../lib/token-mask.mjs";

const GAP_BOUND_MS = 250;
const QUIET_MS = 1500;
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

/// The active graph's drawn and total node counts once, for QUIET_MS,
/// `traffic` (the leg's fs-graph requests) has had none in flight and none
/// started or answered, and the counts have not changed; null when that
/// does not happen within the timeout.
async function settledAfterRelease(page, traffic, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let changedAt = Date.now();
  while (Date.now() < deadline) {
    const now = await drawnCounts(page).catch(() => null);
    if (!now || !last || now.drawn !== last.drawn || now.total !== last.total) changedAt = Date.now();
    last = now;
    if (now && traffic.inFlight === 0 && Date.now() - Math.max(changedAt, traffic.lastAt) >= QUIET_MS) return now;
    await sleep(100);
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

const SLIDER = ".tab-menu-bubble .depth-row input[type='range']";
/// Half the width of the range input's thumb (Chrome's default thumb).
const THUMB_HALF = 8;

/// The slider's box, value and bounds once its box reads the same across
/// two frames, so the menu has stopped moving; null when it does not hold
/// still within 5 s (a hang guard).
async function stillSlider(page) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const reads = await page.evaluate((selector) => new Promise((resolve) => {
      const read = () => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height, min: +el.min, max: +el.max, value: +el.value };
      };
      const first = read();
      requestAnimationFrame(() => requestAnimationFrame(() => resolve([first, read()])));
    }), SLIDER);
    if (reads[0] && JSON.stringify(reads[0]) === JSON.stringify(reads[1])) return reads[1];
    await sleep(50);
  }
  return null;
}

/// Press on the slider's thumb, move the pointer along the track to its
/// end in steps, read the drawn count at each step, and release. The press
/// point comes from the slider's value and its box once the box holds
/// still, and must hit the slider. Each step aims along the track where it
/// stands then: a row whose "[limit]" cue hides while a drafted value shows
/// narrows, and its slider moves under the pointer. Answers the drawn
/// counts, the slider's value and left edge at each step and as the pointer
/// is released, and what the slider itself saw.
async function dragToEnd(page) {
  const box = await stillSlider(page);
  if (!box) throw new Error("the depth slider's box did not hold still");
  const span = box.max - box.min || 1;
  const thumbAt = (value) => box.left + THUMB_HALF + ((value - box.min) / span) * (box.width - 2 * THUMB_HALF);
  const y = box.top + box.height / 2;
  const press = { x: thumbAt(box.value), y };
  const hit = await page.evaluate(({ x, y }, selector) => {
    const el = document.elementFromPoint(x, y);
    return { onSlider: el !== null && el === document.querySelector(selector), at: el ? `${el.tagName}.${el.className}` : null };
  }, press, SLIDER);
  if (!hit.onSlider) throw new Error(`the press point is not on the slider: ${JSON.stringify({ press, hit, box })}`);
  await page.evaluate((selector) => {
    const el = document.querySelector(selector);
    window.__sliderEvents = [];
    for (const type of ["pointerdown", "mousedown", "input", "change", "pointerup"]) {
      el.addEventListener(type, () => window.__sliderEvents.push(`${type}:${el.value}`));
    }
  }, SLIDER);
  const drawnWhileDown = [];
  const values = [];
  const lefts = [];
  const startFraction = (box.value - box.min) / span;
  await page.mouse.move(press.x, press.y);
  await page.mouse.down();
  const steps = 20;
  for (let step = 1; step <= steps; step += 1) {
    const now = await page.$eval(SLIDER, (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, width: r.width };
    });
    const fraction = startFraction + ((1 - startFraction) * step) / steps;
    const x = step === steps
      ? now.left + now.width - 1
      : now.left + THUMB_HALF + fraction * (now.width - 2 * THUMB_HALF);
    await page.mouse.move(x, y);
    await sleep(40);
    lefts.push(now.left);
    values.push(await page.$eval(SLIDER, (el) => el.value).catch(() => null));
    drawnWhileDown.push((await drawnCounts(page).catch(() => null))?.drawn ?? null);
  }
  const released = await page.$eval(SLIDER, (el) => el.value).catch(() => null);
  await page.mouse.up();
  const events = await page.evaluate(() => window.__sliderEvents ?? null).catch(() => null);
  return { drawnWhileDown, released, trace: { box, press, hit, values, lefts, events } };
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
        await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
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
          const traffic = { inFlight: 0, lastAt: Date.now() };
          const fsGraphPath = (request) => {
            const target = new URL(request.url());
            return target.pathname.endsWith("/api/fs-graph") ? (target.searchParams.get("path") ?? "") : null;
          };
          page.on("request", (request) => {
            const path = fsGraphPath(request);
            if (path === null) return;
            reads.push(path);
            traffic.inFlight += 1;
            traffic.lastAt = Date.now();
          });
          const answered = (request) => {
            if (fsGraphPath(request) === null) return;
            traffic.inFlight = Math.max(0, traffic.inFlight - 1);
            traffic.lastAt = Date.now();
          };
          page.on("requestfinished", answered);
          page.on("requestfailed", answered);
          if (probe) await startProbe(page);
          try {
            const drag = await dragToEnd(page);
            reading.drawnWhileDown = drag.drawnWhileDown;
            reading.released = drag.released;
            reading.drag = drag.trace;
            reading.after = await settledAfterRelease(page, traffic);
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
      for (const [name, reading] of Object.entries(record)) {
        expect(!reading.error, `${name}: ${reading.error}`);
        expect(
          reading.released === reading.slider?.max,
          `${name}: the drag released the slider at ${reading.released}, not at its end ${reading.slider?.max}`,
        );
      }
      const { wide, heavy, many, chain } = record;
      expect(
        wide.before && wide.drawnWhileDown?.every((drawn) => drawn === wide.before.drawn),
        "wide: the drawn graph changed while the pointer was down",
      );
      expect(wide.depth === "2 [limit]", `wide: the release reads "${wide.depth}", not "2 [limit]"`);
      expect(
        wide.after && wide.after.drawn >= WIDE.top * WIDE.middle && wide.after.drawn <= DRAWN_NODE_BUDGET,
        `wide: ${wide.after?.drawn} nodes drawn, not the second level's ${WIDE.top * WIDE.middle} folders within the budget`,
      );
      expect(
        wide.address?.includes("wide/a0") && !wide.address?.includes("wide/a0/b0"),
        "wide: the opened tree is not wide/a0 open and wide/a0/b0 closed",
      );
      expect(heavy.depth === "1 [limit]", `heavy: the release reads "${heavy.depth}", not "1 [limit]"`);
      expect(heavy.after && heavy.after.drawn <= DRAWN_NODE_BUDGET, `heavy: ${heavy.after?.drawn} nodes drawn`);
      expect(heavy.folderReads === 0, `heavy: ${heavy.folderReads} folders read of a level already past the budget`);
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
