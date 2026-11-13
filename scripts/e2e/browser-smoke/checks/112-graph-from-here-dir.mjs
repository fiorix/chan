// "Graph from here" on a directory opens the graph with that directory
// selected and opened, so its files show. There is one graph, rooted at the
// workspace, and it draws the root's own level whatever is selected; a count
// of what is on screen says nothing by itself about the directory. Each leg
// therefore reads the tab's stat line with the directory opened and again
// with it closed, and what the directory brought is the difference.
//
//   1. a directory with files among its immediate children, which must
//      bring them;
//   2. the same state reached another way: "Graph from here" on its nested
//      directory, a click on the parent's breadcrumb, which selects the
//      parent and changes nothing drawn, then the depth lowered to one
//      level. One selection at one depth over one tree is one set however
//      the tab arrived at it;
//   3. a directory whose files are one level below, which is the shape that
//      came up as folder bubbles with no file on screen while the payload
//      that tab had already fetched carried them.
//
// The depth is the selected directory's: the levels opened below it, 0 when
// it is closed. The check lowers it with the "Graph depth: decrease" command.
//
// Two legs agreeing on a graph with no files in it would be a green check
// over the bug, so the floors are absolute as well as differential, and they
// are computed from the server's own answers (the `/api/fs-graph` walk the
// panel seeds its spine from, and `/api/graph`) rather than restated from
// the fixture.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileRow, navigateFiles, showFiles, waitFileRow } from "../lib/files.mjs";

const DIR = "from-here-dir";
const NESTED = `${DIR}/nested`;
// A directory whose immediate children are ALL directories: the shape that
// renders as folder bubbles with no file on screen when the graph opens one
// level deep, while its inspector counts the subtree's files.
const DEEP = "from-here-deep";
// Deliberately free of tags, @@mentions and links: a tag or a mention is
// drawn once a file that carries it is, so keeping them out of the fixture
// keeps the node/edge arithmetic below about the filesystem spine alone.
const FILES = [
  [`${DIR}/alpha.md`, "# Alpha\n\nDirect child of the directory.\n"],
  [`${DIR}/beta.md`, "# Beta\n\nSecond direct child of the directory.\n"],
  [`${NESTED}/gamma.md`, "# Gamma\n\nOne level below the directory.\n"],
  [`${DEEP}/one/x.md`, "# X\n\nOnly reachable one level below the directory.\n"],
  [`${DEEP}/two/y.md`, "# Y\n\nAlso one level below the directory.\n"],
];

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

function seed(root) {
  mkdirSync(join(root, NESTED), { recursive: true });
  mkdirSync(join(root, DEEP, "one"), { recursive: true });
  mkdirSync(join(root, DEEP, "two"), { recursive: true });
  for (const [rel, body] of FILES) writeFileSync(join(root, rel), body);
}

/// What a directory's own subtree holds, read from the server's graph of it:
/// the directories one level down, and the files at the shallowest level
/// that has any. The floor the graph must clear is expressed in these rather
/// than in fixture constants, so the check states the contract instead of
/// restating the fixture.
function subtreeShape(page, token, dir) {
  return page.evaluate(
    async ({ bearer, root }) => {
      const response = await fetch(
        `/api/graph?scope=directory&path=${encodeURIComponent(root)}&depth=1`,
        { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} },
      );
      if (!response.ok) return null;
      const graph = await response.json();
      const prefix = `${root}/`;
      const depthOf = (path) =>
        path.startsWith(prefix) ? path.slice(prefix.length).split("/").length : 0;
      const files = (graph.nodes ?? []).filter(
        (node) =>
          (node.kind === "file" || node.kind === "media") &&
          typeof node.path === "string" &&
          depthOf(node.path) >= 1,
      );
      const dirs = (graph.nodes ?? []).filter(
        (node) =>
          (node.kind === "directory" || node.kind === "folder") &&
          typeof node.path === "string" &&
          depthOf(node.path) === 1,
      );
      const shallowest = files.reduce(
        (best, node) => (best === 0 ? depthOf(node.path) : Math.min(best, depthOf(node.path))),
        0,
      );
      return {
        childDirs: dirs.length,
        shallowestFileDepth: shallowest,
        filesAtShallowest: files.filter((n) => depthOf(n.path) === shallowest).length,
      };
    },
    { bearer: token, root: dir },
  );
}

/// The graph panel of the ACTIVE tab. Graph tabs stay MOUNTED while hidden
/// (the keep-alive load gating) and a hidden one still lays out, so a plain
/// `.graph-tab` query reads whichever copy the DOM lists first and a later
/// leg silently reports an earlier leg's numbers. `.active` is the panel's
/// own live/hidden flag, the same one `aria-hidden` mirrors. `selected` is
/// the last step of the breadcrumb over Details: the selected directory.
function readVisibleStat(page) {
  return page.evaluate(() => {
    const panel = document.querySelector(".graph-tab.active");
    if (!panel) return null;
    const stat = panel.querySelector(".statusbar .stat")?.textContent ?? "";
    const match = stat.match(/(\d+)\/(\d+) nodes\s+·\s+(\d+)\/(\d+) edges/);
    if (!match) return null;
    const crumbs = [...panel.querySelectorAll(".scope-crumbs .crumb")].map(
      (crumb) => crumb.textContent?.trim() ?? "",
    );
    return {
      visibleNodes: Number(match[1]),
      totalNodes: Number(match[2]),
      visibleEdges: Number(match[3]),
      totalEdges: Number(match[4]),
      selected: crumbs[crumbs.length - 1] ?? "",
    };
  });
}

/// The stat line once it holds: two identical samples, 250 ms apart.
async function settledStat(page) {
  let last = null;
  for (let round = 0; round < 40; round += 1) {
    const now = await readVisibleStat(page);
    if (last && now && JSON.stringify(now) === JSON.stringify(last)) return now;
    last = now;
    await delay(250);
  }
  return last;
}

/// The active graph tab once its load is over and the directory named
/// `selected` is the selection. The selection resolves as soon as the spine
/// brings its node, and a tab opened on a directory opens it down to its
/// files only when the load ends, so a reading taken while the graph still
/// streams is not the graph the tab comes up with.
async function waitForLoadedGraph(page, selected) {
  await page.waitForFunction(
    (name) => {
      const panel = document.querySelector(".graph-tab.active");
      if (!panel || !panel.querySelector("canvas")) return false;
      if (panel.querySelector(".canvas > .stream-status, .canvas > .placeholder")) return false;
      const stat = panel.querySelector(".statusbar .stat")?.textContent ?? "";
      const match = stat.match(/(\d+)\/(\d+) nodes/);
      if (!match || Number(match[2]) === 0) return false;
      const crumbs = [...panel.querySelectorAll(".scope-crumbs .crumb")];
      return crumbs[crumbs.length - 1]?.textContent?.trim() === name;
    },
    { timeout: 60_000, polling: 250 },
    posix.basename(selected),
  );
  return settledStat(page);
}

/// Lower the selected directory's depth one step and read the stat line.
async function lowerDepth(page) {
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.graph.depth.decrease" } })),
  );
  await delay(300);
  return settledStat(page);
}

/// Wait until the server's graph holds still: the same node and edge ids in
/// reads 500 ms apart for three seconds, with the index idle throughout. The
/// graph route answers from the index, which takes a change some time after
/// the file system reports it.
async function waitGraphSettled(page, token) {
  const read = () =>
    page.evaluate(async (bearer) => {
      const headers = bearer ? { authorization: `Bearer ${bearer}` } : {};
      const status = await (await fetch("/api/index/status", { headers })).json();
      const graph = await (await fetch("/api/graph", { headers })).json();
      if (status.state !== "idle" || graph.gated) return null;
      const nodes = graph.nodes.map((node) => node.id).sort();
      const edges = graph.edges.map((edge) => `${edge.source}>${edge.target}:${edge.kind}`).sort();
      return JSON.stringify([nodes, edges]);
    }, token);
  const deadline = Date.now() + 90_000;
  let last = await read();
  let since = Date.now();
  for (;;) {
    await delay(500);
    const now = await read();
    if (now === null || now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= 3_000) {
      return;
    }
    if (Date.now() > deadline) throw new Error("the server's graph did not hold still within 90 s");
  }
}

/// Navigate to a directory's parent so its own context menu opens the graph on it.
async function graphFromRow(page, scope, relPath) {
  await showFiles(page, scope);
  const parent = posix.dirname(relPath);
  await navigateFiles(page, parent === "." ? "" : parent, scope);
  const name = posix.basename(relPath);
  await waitFileRow(page, name, true, { timeout: 30_000, scope });
  const row = await fileRow(page, name, scope);
  if (!row) throw new Error(`directory row disappeared: ${relPath}`);
  await row.click({ button: "right" });
  await page.waitForSelector('[role="menu"][aria-label="File actions"]', { visible: true, timeout: 15_000 });
  const clicked = await page.evaluate(() => {
    const button = [...document.querySelectorAll('[role="menu"][aria-label="File actions"] [role="menuitem"]')].find(
      (candidate) => candidate.querySelector(".menu-row-label")?.textContent?.trim() === "New Graph",
    );
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  });
  if (!clicked) throw new Error(`row menu "New Graph" vanished: ${relPath}`);
}

export default {
  name: "graph-from-here-dir",
  async run(ctx) {
    const { page } = ctx;
    await page.bringToFront();
    seed(ctx.workspaceDir);

    const token = new URL(ctx.serverUrl).searchParams.get("t") ?? "";
    await page.waitForFunction(
      async (bearer) => {
        const response = await fetch("/api/index/status", {
          headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
        });
        if (!response.ok) return false;
        const status = await response.json();
        return status.state === "idle" && status.readiness?.state === "ready";
      },
      { timeout: 90_000, polling: 250 },
      token,
    );

    // The panel's own spine source, so "what counts as a direct child" is
    // the walker's answer rather than this check's restatement of it.
    const spine = await page.evaluate(
      async ({ bearer, dir }) => {
        const response = await fetch(
          `/api/fs-graph?scope=directory&path=${encodeURIComponent(dir)}&depth=1`,
          { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} },
        );
        if (!response.ok) return null;
        const graph = await response.json();
        const prefix = `${dir}/`;
        const direct = graph.nodes.filter(
          (node) =>
            node.kind === "file" &&
            typeof node.path === "string" &&
            node.path.startsWith(prefix) &&
            !node.path.slice(prefix.length).includes("/"),
        );
        return { directFiles: direct.length, paths: direct.map((n) => n.path) };
      },
      { bearer: token, dir: DIR },
    );
    if (!spine) throw new Error("fs-graph spine request failed");
    if (spine.directFiles < 2) {
      ctx.skip(`fixture directory not indexed yet: ${JSON.stringify(spine)}`);
    }

    // The legs compare readings taken at different times, so they start once
    // the server's graph has taken every change made before this check (a
    // check before it may have removed its fixtures as it ended), and the
    // page reloads onto that graph. Reloading after seeding also makes the
    // first directory listing include the fixtures.
    await waitGraphSettled(page, token);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".pane", { timeout: 30_000 });
    const paneId = await page.evaluate(() =>
      (document.querySelector(".pane.focused") ?? document.querySelector(".pane"))
        ?.getAttribute("data-pane-id"),
    );
    if (!paneId) throw new Error("active pane has no id before opening a file browser");
    const paneSelector = `.pane[data-pane-id="${paneId}"]`;
    await showFiles(page, paneSelector);

    // Leg 1: the row's own graph action, then the directory closed.
    await graphFromRow(page, paneSelector, DIR);
    const fromHere = await waitForLoadedGraph(page, DIR);
    if (!fromHere) throw new Error("from-here graph never reported a stat line");
    await ctx.shot("graph-from-here-dir");
    const closed = await lowerDepth(page);
    if (!closed) throw new Error("the closed directory's graph never reported a stat line");

    // Leg 2: the reference. Open the nested directory the same way, select
    // the parent from the breadcrumb, then close the nested directory by
    // lowering the parent's depth to one level: the state leg 1 opened cold.
    await graphFromRow(page, paneSelector, NESTED);
    const nested = await waitForLoadedGraph(page, NESTED);
    if (!nested) throw new Error("the nested directory's graph never reported a stat line");
    const hopped = await page.evaluate((label) => {
      const panel = document.querySelector(".graph-tab.active");
      const crumb = [...(panel?.querySelectorAll(".scope-crumbs .crumb") ?? [])].find(
        (candidate) => candidate.textContent?.trim() === label,
      );
      if (!(crumb instanceof HTMLElement)) return false;
      crumb.click();
      return true;
    }, DIR);
    if (!hopped) throw new Error(`breadcrumb step not offered: ${DIR}`);
    const viaCrumb = await waitForLoadedGraph(page, DIR);
    if (!viaCrumb) throw new Error("the graph never reported a stat line after the breadcrumb step");
    await ctx.shot("graph-from-here-dir-crumb");
    const lowered = await lowerDepth(page);
    if (!lowered) throw new Error("the graph never reported a stat line after the depth was lowered");
    await ctx.shot("graph-from-here-dir-lowered");

    // Leg 3: the directory that has no file among its immediate children.
    // Its files are in the payload this tab already fetched, so a graph that
    // renders only folder bubbles is withholding what it was asked for.
    const deepShape = await subtreeShape(page, token, DEEP);
    if (!deepShape || deepShape.shallowestFileDepth < 2) {
      ctx.skip(`deep fixture not indexed yet: ${JSON.stringify(deepShape)}`);
    }
    await graphFromRow(page, paneSelector, DEEP);
    const deep = await waitForLoadedGraph(page, DEEP);
    if (!deep) throw new Error("deep from-here graph never reported a stat line");
    await ctx.shot("graph-from-here-deep-dir");
    // One step per level it opened, down to closed.
    let deepClosed = deep;
    for (let level = 0; level < deepShape.shallowestFileDepth; level += 1) {
      deepClosed = await lowerDepth(page);
      if (!deepClosed) throw new Error("the closed deep directory's graph never reported a stat line");
    }

    const evidence = { spine, fromHere, closed, nested, viaCrumb, lowered, deepShape, deep, deepClosed };

    // Each reading came off the tab it names. A panel read is only worth as
    // much as this: hidden graph tabs stay mounted, so a leg that silently
    // reported an earlier leg's numbers would agree with itself perfectly.
    for (const [label, stat, want] of [
      ["fromHere", fromHere, DIR],
      ["closed", closed, DIR],
      ["nested", nested, NESTED],
      ["viaCrumb", viaCrumb, DIR],
      ["lowered", lowered, DIR],
      ["deep", deep, DEEP],
      ["deepClosed", deepClosed, DEEP],
    ]) {
      if (stat.selected !== posix.basename(want)) {
        throw new Error(
          `${label} read the wrong graph panel: ${stat.selected} selected, expected ${want}`,
        );
      }
    }

    // Opened down to its files, the deep directory brings every child
    // directory and the files at the shallowest level that holds any.
    // Meta-nodes can only add, so this is a floor.
    const deepBrought = deep.visibleNodes - deepClosed.visibleNodes;
    const deepMinBrought = deepShape.childDirs + deepShape.filesAtShallowest;
    if (deepBrought < deepMinBrought) {
      throw new Error(
        `"Graph from here" on ${DEEP} came up without its files: ` +
          `${JSON.stringify(evidence)} (expected >= ${deepMinBrought} nodes more than closed)`,
      );
    }

    // Absolute: the directory's own files are on screen. Opened, it brings
    // one node and one `contains` edge per direct file. Its child
    // directories, meta-nodes and language edges can only add, so these are
    // floors.
    const broughtNodes = fromHere.visibleNodes - closed.visibleNodes;
    const broughtEdges = fromHere.visibleEdges - closed.visibleEdges;
    if (broughtNodes < spine.directFiles || broughtEdges < spine.directFiles) {
      throw new Error(
        `"Graph from here" on ${DIR} came up without its files: ` +
          `${JSON.stringify(evidence)} (expected >= ${spine.directFiles} nodes and edges more than closed)`,
      );
    }

    // A breadcrumb step selects its directory and draws nothing more or less.
    if (
      viaCrumb.visibleNodes !== nested.visibleNodes ||
      viaCrumb.visibleEdges !== nested.visibleEdges
    ) {
      throw new Error(
        `selecting ${DIR} from the breadcrumb changed what is drawn: ${JSON.stringify(evidence)}`,
      );
    }

    // Differential: one selection at one depth renders one set, however the
    // tab arrived at it.
    if (
      fromHere.visibleNodes !== lowered.visibleNodes ||
      fromHere.visibleEdges !== lowered.visibleEdges
    ) {
      throw new Error(
        `from-here and breadcrumb-then-depth graphs disagree at ${DIR}: ${JSON.stringify(evidence)}`,
      );
    }

    return evidence;
  },
};
