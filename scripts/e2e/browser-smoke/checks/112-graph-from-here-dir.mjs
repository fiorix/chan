// "Graph from here" on a directory must come up showing that directory's
// files. Three legs, each reading the stat line of the tab it opened:
//
//   1. a directory with files among its immediate children, which must
//      render them;
//   2. the same scope reached instead by clicking the parent crumb in an
//      existing tab, which must render the same set, since one scope at one
//      depth over one workspace is one set however the tab arrived at it;
//   3. a directory whose files are one level below, which is the shape that
//      came up as folder bubbles with no file on screen while the payload
//      that tab had already fetched carried them.
//
// Two legs agreeing on a graph with no files in it would be a green check
// over the bug, so the floors are absolute as well as differential, and they
// are computed from the panel's own sources (the `/api/fs-graph` walk it
// seeds its spine from, and the `/api/graph` payload it renders) rather than
// restated from the fixture.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "from-here-dir";
const NESTED = `${DIR}/nested`;
// A directory whose immediate children are ALL directories: the shape that
// renders as folder bubbles with no file on screen when the graph opens one
// level deep, while its inspector counts the subtree's files.
const DEEP = "from-here-deep";
// Deliberately free of tags, @@mentions and links: meta-nodes pass the scope
// filter unconditionally, so keeping them out of the fixture keeps the
// node/edge arithmetic below about the filesystem spine alone.
const FILES = [
  [`${DIR}/alpha.md`, "# Alpha\n\nDirect child of the scope directory.\n"],
  [`${DIR}/beta.md`, "# Beta\n\nSecond direct child of the scope directory.\n"],
  [`${NESTED}/gamma.md`, "# Gamma\n\nOne level below the scope directory.\n"],
  [`${DEEP}/one/x.md`, "# X\n\nOnly reachable one level below the scope.\n"],
  [`${DEEP}/two/y.md`, "# Y\n\nAlso one level below the scope.\n"],
];

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

function seed(root) {
  mkdirSync(join(root, NESTED), { recursive: true });
  mkdirSync(join(root, DEEP, "one"), { recursive: true });
  mkdirSync(join(root, DEEP, "two"), { recursive: true });
  for (const [rel, body] of FILES) writeFileSync(join(root, rel), body);
}

/// What the scope directory's own subtree holds, read from the semantic
/// payload the panel itself loads: the directories one level down, and the
/// files at the shallowest level that has any. The floor the graph must
/// clear is expressed in these rather than in fixture constants, so the
/// check states the contract instead of restating the fixture.
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

async function dispatch(page, name) {
  await page.evaluate((command) => {
    window.dispatchEvent(
      new CustomEvent("chan:command", { detail: { name: command } }),
    );
  }, name);
}

/// The graph panel of the ACTIVE tab. Graph tabs stay MOUNTED while hidden
/// (the keep-alive load gating) and a hidden one still lays out, so a plain
/// `.graph-tab` query reads whichever copy the DOM lists first and a later
/// leg silently reports an earlier leg's numbers. `.active` is the panel's
/// own live/hidden flag, the same one `aria-hidden` mirrors.
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
      crumbs,
    };
  });
}

async function waitForLoadedGraph(page) {
  await page.waitForFunction(
    () => {
      const panel = document.querySelector(".graph-tab.active");
      if (!panel || !panel.querySelector("canvas")) return false;
      const stat = panel.querySelector(".statusbar .stat")?.textContent ?? "";
      const match = stat.match(/(\d+)\/(\d+) nodes/);
      return Boolean(match) && Number(match[2]) > 0;
    },
    { timeout: 60_000, polling: 250 },
  );
  // The spine seeds first and the semantic stream merges on top, so the
  // counts move for a moment after the first non-zero reading. Settle on two
  // identical samples rather than racing the merge.
  let last = null;
  for (let round = 0; round < 40; round += 1) {
    const now = await readVisibleStat(page);
    if (last && now && JSON.stringify(now) === JSON.stringify(last)) return now;
    last = now;
    await delay(250);
  }
  return last;
}

/// Bring a retained tab back to the front the way a click on it does.
async function activate(handle) {
  await handle.evaluate((tab) => {
    tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    tab.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  });
}

async function waitForRow(page, relPath) {
  try {
    await page.waitForFunction(
      (needle) =>
        [...document.querySelectorAll(".row.dir")].some((row) =>
          row.getAttribute("title")?.endsWith(`/${needle}`),
        ),
      { timeout: 30_000, polling: 250 },
      relPath,
    );
  } catch {
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll(".row.dir")].map((row) =>
        row.getAttribute("title"),
      ),
    );
    throw new Error(
      `file browser row not found: ${relPath}; rows=${JSON.stringify(rows)}`,
    );
  }
}

async function rowHandle(page, relPath) {
  const handle = await page.evaluateHandle(
    (needle) =>
      [...document.querySelectorAll(".row.dir")].find((row) =>
        row.getAttribute("title")?.endsWith(`/${needle}`),
      ) ?? null,
    relPath,
  );
  const element = handle.asElement();
  if (!element) throw new Error(`file browser row not clickable: ${relPath}`);
  return element;
}

/// Run the tree row's own "New Graph" entry -- the per-entry "Graph from
/// here" the roadmap item names, straight off the row context menu rather
/// than through a command id the host bridge does not carry.
async function graphFromRow(page, relPath) {
  await waitForRow(page, relPath);
  const row = await rowHandle(page, relPath);
  await row.click({ button: "right" });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("button")].some(
        (button) =>
          button.querySelector(".menu-row-label")?.textContent?.trim() ===
          "New Graph",
      ),
    { timeout: 15_000, polling: 100 },
  );
  const clicked = await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) =>
        candidate.querySelector(".menu-row-label")?.textContent?.trim() ===
        "New Graph",
    );
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  });
  if (!clicked) throw new Error(`row menu "New Graph" vanished: ${relPath}`);
}

/// Select a directory row in the File Browser tree. Clicking the name both
/// selects and toggles expansion, which is what the real gesture does.
async function selectDir(page, relPath) {
  await waitForRow(page, relPath);
  const clicked = await page.evaluate((needle) => {
    const row = [...document.querySelectorAll(".row.dir")].find((candidate) =>
      candidate.getAttribute("title")?.endsWith(`/${needle}`),
    );
    const name = row?.querySelector(".name");
    if (!(name instanceof HTMLElement)) return false;
    name.click();
    return true;
  }, relPath);
  if (!clicked) throw new Error(`file browser row not clickable: ${relPath}`);
  await delay(400);
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

    // The window rendered its tree before this check wrote the fixture, and
    // the File Browser's listing is what the row lookup below reads. Reload
    // rather than wait on a refresh the surface may not owe us.
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(".pane", { timeout: 30_000 });
    await dispatch(page, "app.files.toggle");
    await page.waitForSelector('[role="treeitem"]', { timeout: 20_000 });
    // Each leg spawns a graph tab over the File Browser, so hold the browser
    // tab itself to come back to rather than re-deriving it from tab titles.
    const browserTab = await page.evaluateHandle(() =>
      document.querySelector(".tab.active"),
    );

    // Leg 1: the surface under test. Expanding the fixture directory also
    // makes its nested child addressable for leg 2.
    await selectDir(page, DIR);
    await graphFromRow(page, DIR);
    const fromHere = await waitForLoadedGraph(page);
    if (!fromHere) throw new Error("from-here graph never reported a stat line");
    await ctx.shot("graph-from-here-dir");

    // Leg 2: the reference. Open the nested directory the same way, then walk
    // one crumb back up to the parent, which re-scopes THAT tab in place to
    // the scope leg 1 opened cold.
    await activate(browserTab);
    await selectDir(page, NESTED);
    await graphFromRow(page, NESTED);
    await waitForLoadedGraph(page);
    const rescoped = await page.evaluate((label) => {
      const panel = document.querySelector(".graph-tab.active");
      const crumb = [...(panel?.querySelectorAll(".scope-crumbs .crumb") ?? [])].find(
        (candidate) => candidate.textContent?.trim() === label,
      );
      if (!(crumb instanceof HTMLElement)) return false;
      crumb.click();
      return true;
    }, DIR);
    if (!rescoped) throw new Error(`breadcrumb hop not offered: ${DIR}`);
    const viaRescope = await waitForLoadedGraph(page);
    if (!viaRescope) throw new Error("re-scoped graph never reported a stat line");
    await ctx.shot("graph-from-here-dir-rescoped");

    // Leg 3: the directory that has no file among its immediate children.
    // Its files are in the payload this tab already fetched, so a graph that
    // renders only folder bubbles is withholding what it was asked for.
    await activate(browserTab);
    const deepShape = await subtreeShape(page, token, DEEP);
    if (!deepShape || deepShape.shallowestFileDepth < 2) {
      ctx.skip(`deep fixture not indexed yet: ${JSON.stringify(deepShape)}`);
    }
    await graphFromRow(page, DEEP);
    const deep = await waitForLoadedGraph(page);
    if (!deep) throw new Error("deep from-here graph never reported a stat line");
    await ctx.shot("graph-from-here-deep-dir");

    const evidence = { spine, fromHere, viaRescope, deepShape, deep };

    // Each reading came off the tab it names. A panel read is only worth as
    // much as this: hidden graph tabs stay mounted, so a leg that silently
    // reported an earlier leg's numbers would agree with itself perfectly.
    const scopeOf = (stat) => stat.crumbs[stat.crumbs.length - 1];
    for (const [label, stat, want] of [
      ["fromHere", fromHere, DIR],
      ["viaRescope", viaRescope, DIR],
      ["deep", deep, DEEP],
    ]) {
      if (scopeOf(stat) !== want) {
        throw new Error(
          `${label} read the wrong graph panel: scope ${scopeOf(stat)}, expected ${want}`,
        );
      }
    }

    // The scope directory, the workspace-root anchor, every child directory,
    // and the files at the shallowest level that holds any. Meta-nodes can
    // only add, so this is a floor.
    const deepMinNodes = deepShape.childDirs + deepShape.filesAtShallowest + 2;
    if (deep.visibleNodes < deepMinNodes) {
      throw new Error(
        `"Graph from here" on ${DEEP} came up without its files: ` +
          `${JSON.stringify(evidence)} (expected >= ${deepMinNodes} nodes)`,
      );
    }

    // Absolute: the scope directory's own files are on screen. One node per
    // direct file plus the directory and the workspace-root anchor; one
    // `contains` edge per direct file plus the directory's own spine edge.
    // Meta-nodes and language edges can only add, so these are floors.
    const minNodes = spine.directFiles + 2;
    const minEdges = spine.directFiles + 1;
    if (fromHere.visibleNodes < minNodes || fromHere.visibleEdges < minEdges) {
      throw new Error(
        `"Graph from here" on ${DIR} came up without its files: ` +
          `${JSON.stringify(evidence)} (expected >= ${minNodes} nodes, >= ${minEdges} edges)`,
      );
    }

    // Differential: one scope at one depth renders one set, however the tab
    // arrived at it.
    if (
      fromHere.visibleNodes !== viaRescope.visibleNodes ||
      fromHere.visibleEdges !== viaRescope.visibleEdges
    ) {
      throw new Error(
        `from-here and re-scoped graphs disagree at ${DIR}: ${JSON.stringify(evidence)}`,
      );
    }

    return evidence;
  },
};
