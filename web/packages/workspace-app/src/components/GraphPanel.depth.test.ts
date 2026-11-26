// @vitest-environment jsdom
//
// How deep a graph reaches: the depth slider in the tab menu, the expanded
// directory tree of the workspace and directory scopes, a double-click that
// expands a directory, and the depth a directory scope opens at. GraphPanel is
// mounted over a fixed graph; the assertions read the menu and the node set
// the panel hands the canvas.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./GraphCanvas.svelte", async () =>
  (await import("../__tests__/graphPanel")).canvasProbeModule(),
);
vi.mock("../api/client", async (importOriginal) =>
  (await import("../__tests__/graphPanel")).graphApiModule(
    await importOriginal<typeof import("../api/client")>(),
  ),
);

import GraphPanel from "./GraphPanel.svelte";
import { api } from "../api/client";
import {
  canvas,
  fsg,
  g,
  graphServer,
  graphTab,
  installGraphDom,
  mountGraphPanel,
  resetGraphServer,
  settle,
  unmountGraphPanels,
  visibleIds,
} from "../__tests__/graphPanel";
import { graphData, invalidateGraph, refreshGraph } from "../state/graphData.svelte";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { graphReloadSignal } from "../state/store.svelte";
import { closeTabMenu, openTabMenu } from "../state/tabMenu.svelte";
import { GRAPH_DRAWN_NODE_BUDGET, openedForPath } from "../graph/selectionView";
import { FS_GRAPH_DEPTH_MAX } from "../graph/depth";
import { layout, type GraphTab } from "../state/tabs.svelte";

installGraphDom();

const A = "notes/a.md";
const D = "notes/deep/d.md";
const MAIN = "src/main.rs";
const NOTES = "directory:notes";
const DEEP = "directory:notes/deep";
const SRC = "directory:src";

/// notes/a.md, notes/deep/d.md and src/main.rs, as both the semantic graph
/// and the filesystem graph.
function serveGraph(): void {
  graphServer.view = {
    nodes: [
      g.dir(""),
      g.dir("notes"),
      g.dir("notes/deep"),
      g.dir("src"),
      g.file("notes/a.md"),
      g.file("notes/deep/d.md"),
      g.file("src/main.rs"),
      g.tag("t"),
      g.language("rust"),
    ],
    edges: [
      g.edge(MAIN, "language:rust", "language"),
      g.edge("", NOTES, "contains"),
      g.edge("", SRC, "contains"),
      g.edge(NOTES, DEEP, "contains"),
      g.edge(NOTES, A, "contains"),
      g.edge(DEEP, D, "contains"),
      g.edge(SRC, MAIN, "contains"),
      g.edge(A, "#t", "tag"),
    ],
  };
  graphServer.fs = {
    nodes: [
      fsg.dir(""),
      fsg.dir("notes"),
      fsg.dir("notes/deep"),
      fsg.dir("src"),
      fsg.file("notes/a.md"),
      fsg.file("notes/deep/d.md"),
      fsg.file("src/main.rs"),
    ],
    edges: [
      fsg.contains("", "notes"),
      fsg.contains("", "src"),
      fsg.contains("notes", "notes/deep"),
      fsg.contains("notes", "notes/a.md"),
      fsg.contains("notes/deep", "notes/deep/d.md"),
      fsg.contains("src", "src/main.rs"),
    ],
  };
}

/// Leaves notes/deep/d.md as the only file under notes.
function dropNotesA(): void {
  graphServer.view.nodes = graphServer.view.nodes.filter((n) => n.id !== A);
  graphServer.view.edges = graphServer.view.edges.filter((e) => e.target !== A && e.source !== A);
  graphServer.fs.nodes = graphServer.fs.nodes.filter((n) => n.path !== "notes/a.md");
  graphServer.fs.edges = graphServer.fs.edges.filter((e) => e.target !== "notes/a.md");
}

let timers: TimerTrack;

beforeEach(() => {
  timers = trackTimers();
  resetGraphServer();
  invalidateGraph();
  serveGraph();
});

afterEach(() => {
  closeTabMenu();
  unmountGraphPanels();
  timers.release();
});

/// Move the depth slider to `value` and release it there, as a drag ends.
async function slideTo(slider: HTMLInputElement, value: number): Promise<void> {
  slider.value = String(value);
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  slider.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
}

/// Move the depth slider through `values` without releasing it.
async function dragThrough(slider: HTMLInputElement, values: number[]): Promise<void> {
  for (const value of values) {
    slider.value = String(value);
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(2);
  }
}

async function depthRow(tab: GraphTab): Promise<HTMLElement> {
  openTabMenu(tab.id, { left: 10, top: 10, right: 10, bottom: 10 });
  await settle(2);
  const row = document.body.querySelector<HTMLElement>(".tab-menu-bubble .depth-row");
  if (!row) throw new Error("no depth row");
  return row;
}

describe("the depth slider", () => {
  test("reaches the workspace's deepest level and is live", async () => {
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab());
    const row = await depthRow(tab);
    const slider = row.querySelector<HTMLInputElement>("input[type='range']")!;

    expect(slider.disabled).toBe(false);
    expect(slider.max, "notes/deep/d.md is three levels down").toBe("3");
    expect(row.classList.contains("shallow")).toBe(false);
    expect(row.querySelector(".depth-cue")).toBeNull();
  });

  test("on a language, which always shows one hop, is disabled and says so", async () => {
    const { tab } = await mountGraphPanel(
      GraphPanel,
      layout,
      graphTab({ pendingSelectId: "language:rust" }),
    );
    expect(canvas.props?.selectedId).toBe("language:rust");
    const row = await depthRow(tab);

    expect(row.classList.contains("shallow")).toBe(true);
    expect(row.getAttribute("title")).toContain("Nothing further");
    expect(row.querySelector<HTMLInputElement>("input[type='range']")!.disabled).toBe(true);
    expect(row.querySelector(".depth-value")?.textContent?.replace(/\s+/g, " ").trim()).toBe("1 [max]");
  });

  test("is the selected node's: levels below a directory, hops from a file", async () => {
    const { tab } = await mountGraphPanel(
      GraphPanel,
      layout,
      graphTab({ expanded: { "": true, notes: true } }),
    );
    const slider = (await depthRow(tab)).querySelector<HTMLInputElement>("input[type='range']")!;
    expect([slider.min, slider.value, slider.max], "nothing selected reads as the root").toEqual(["1", "1", "3"]);

    canvas.props!.onSelect(NOTES);
    await settle(2);
    expect([slider.min, slider.value, slider.max], "notes is opened one level of its two").toEqual(["0", "1", "2"]);

    canvas.props!.onSelect(SRC);
    await settle(2);
    expect([slider.min, slider.value, slider.max], "src is closed").toEqual(["0", "0", "1"]);

    canvas.props!.onSelect(A);
    await settle(2);
    expect([slider.min, slider.value], "a file's depth is hops, from one").toEqual(["1", "1"]);
  });
});

/// Under `top` ("" for the root): 10 folders, 20 under each and 20 notes
/// under each of those. From `top`, 11 nodes draw at depth 1, 211 at depth 2
/// and 4,211 at depth 3, past the drawn-node budget.
function serveWideTree(top: string): void {
  const view: { nodes: ReturnType<typeof g.dir>[]; edges: ReturnType<typeof g.edge>[] } = { nodes: [g.dir("")], edges: [] };
  const fs: { nodes: ReturnType<typeof fsg.dir>[]; edges: ReturnType<typeof fsg.contains>[] } = { nodes: [fsg.dir("")], edges: [] };
  const add = (parent: string, path: string, file: boolean): void => {
    view.nodes.push(file ? g.file(path) : g.dir(path));
    view.edges.push(g.edge(parent === "" ? "" : `directory:${parent}`, file ? path : `directory:${path}`, "contains"));
    fs.nodes.push(file ? fsg.file(path) : fsg.dir(path));
    fs.edges.push(fsg.contains(parent, path));
  };
  const under = (name: string): string => (top ? `${top}/${name}` : name);
  if (top) add("", top, false);
  for (let a = 0; a < 10; a += 1) {
    add(top, under(`a${a}`), false);
    for (let b = 0; b < 20; b += 1) {
      add(under(`a${a}`), under(`a${a}/b${b}`), false);
      for (let c = 0; c < 20; c += 1) add(under(`a${a}/b${b}`), under(`a${a}/b${b}/${c}.md`), true);
    }
  }
  expect(view.nodes.length).toBeGreaterThan(GRAPH_DRAWN_NODE_BUDGET);
  graphServer.view = view;
  graphServer.fs = fs;
}

describe("the depth's bounds", () => {
  test("a drag applies its value once, when it is released", async () => {
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    const row = await depthRow(tab);
    const slider = row.querySelector<HTMLInputElement>("input[type='range']")!;
    const reads = graphServer.fsGraphCalls.length;

    await dragThrough(slider, [2, 3, 2, 3]);
    expect(tab.expanded, "nothing opens while the drag is under way").toEqual({ "": true });
    expect(graphServer.fsGraphCalls.length, "nothing is read while the drag is under way").toBe(reads);
    expect(row.querySelector(".depth-value")?.textContent?.trim(), "the value follows the drag").toBe("3");

    slider.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(tab.expanded.notes).toBe(true);
    expect(tab.expanded["notes/deep"], "the released value, three levels").toBe(true);
    expect(visibleIds()).toEqual(expect.arrayContaining([D, MAIN]));
    expect(row.querySelector(".depth-value")?.textContent?.trim(), "a full depth that fits").toBe("3");
    expect(row.classList.contains("limited"), "no limit at a depth that fits").toBe(false);
  });

  test("a drag that ends with no change shows the depth again once the slider loses focus", async () => {
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    const row = await depthRow(tab);
    const slider = row.querySelector<HTMLInputElement>("input[type='range']")!;

    await dragThrough(slider, [3, 2]);
    expect(row.querySelector(".depth-value")?.textContent?.trim()).toBe("2");
    slider.dispatchEvent(new FocusEvent("blur"));
    await settle(2);
    expect(row.querySelector(".depth-value")?.textContent?.trim(), "the depth as it stands").toBe("1");
    expect(tab.expanded).toEqual({ "": true });
  });

  test("a new selection drops a drag's value", async () => {
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    const row = await depthRow(tab);
    const slider = row.querySelector<HTMLInputElement>("input[type='range']")!;

    await dragThrough(slider, [3]);
    canvas.props!.onSelect(SRC);
    await settle(2);
    expect(row.querySelector(".depth-value")?.textContent?.trim(), "src is closed").toBe("0");
  });

  test("a directory's depth goes no deeper than the server's walk", async () => {
    // A chain of 13 directories under the root with a note at the bottom.
    const chain = Array.from({ length: 13 }, (_, i) => Array.from({ length: i + 1 }, (_, j) => `l${j}`).join("/"));
    const leaf = `${chain.at(-1)}/leaf.md`;
    graphServer.view = {
      nodes: [g.dir(""), ...chain.map((path) => g.dir(path)), g.file(leaf)],
      edges: [
        ...chain.map((path, i) => g.edge(i === 0 ? "" : `directory:${chain[i - 1]}`, `directory:${path}`, "contains")),
        g.edge(`directory:${chain.at(-1)}`, leaf, "contains"),
      ],
    };
    graphServer.fs = {
      nodes: [fsg.dir(""), ...chain.map((path) => fsg.dir(path)), fsg.file(leaf)],
      edges: [
        ...chain.map((path, i) => fsg.contains(i === 0 ? "" : chain[i - 1], path)),
        fsg.contains(chain.at(-1)!, leaf),
      ],
    };
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    const slider = (await depthRow(tab)).querySelector<HTMLInputElement>("input[type='range']")!;

    expect(slider.max, "the note is 14 levels down").toBe(String(FS_GRAPH_DEPTH_MAX));
    await slideTo(slider, 14);
    expect(tab.expanded[chain[FS_GRAPH_DEPTH_MAX - 2]], "ten levels show").toBe(true);
    expect(tab.expanded[chain[FS_GRAPH_DEPTH_MAX - 1]], "the eleventh does not").toBeUndefined();
  });

  test("a raised depth stops at the deepest level the drawn-node budget fits, and says so", async () => {
    serveWideTree("");
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    let row = await depthRow(tab);
    const slider = row.querySelector<HTMLInputElement>("input[type='range']")!;
    expect(slider.max).toBe("3");

    await slideTo(slider, 3);
    expect(tab.expanded.a0, "the first level opens").toBe(true);
    expect(tab.expanded["a0/b0"], "the third would draw past the budget").toBeUndefined();
    expect(visibleIds().length).toBeLessThanOrEqual(GRAPH_DRAWN_NODE_BUDGET);
    row = document.body.querySelector<HTMLElement>(".tab-menu-bubble .depth-row")!;
    expect(row.querySelector(".depth-value")?.textContent?.replace(/\s+/g, " ").trim()).toBe("2 [limit]");
    expect(row.classList.contains("limited")).toBe(true);
    expect(row.getAttribute("title")).toContain("more than");

    await slideTo(slider, 1);
    expect(tab.expanded.a0, "a lowered depth applies").toBeUndefined();
    expect(row.querySelector(".depth-cue"), "one level below the limit is no limit").toBeNull();
  });

  test("a graph opened on a directory opens toward its files only as far as the budget fits", async () => {
    // The first notes under wide/ sit three levels down, past the budget.
    serveWideTree("wide");
    const { tab } = await mountGraphPanel(
      GraphPanel,
      layout,
      graphTab({ pendingSelectId: "wide", expanded: openedForPath("wide") }),
    );
    expect(canvas.props?.selectedId).toBe("directory:wide");
    expect(tab.expanded["wide/a0"], "the second level fits").toBe(true);
    expect(tab.expanded["wide/a0/b0"], "the level of its files does not").toBeUndefined();
    expect(visibleIds().length).toBeLessThanOrEqual(GRAPH_DRAWN_NODE_BUDGET);
  });

  test("a raise reads the folders it opens in bounded batches, then opens them all", async () => {
    // 100 folders under the root whose notes the shared graph does not hold,
    // and one chain two levels deep that gives the depth its second level.
    serveUnreadFolders(100, 1);
    const drawnAtRead: Array<{ path: string; nodes: number }> = [];
    graphServer.onFsGraph = (request) => drawnAtRead.push({ path: request.path, nodes: canvas.props?.nodes.length ?? 0 });
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    const slider = (await depthRow(tab)).querySelector<HTMLInputElement>("input[type='range']")!;
    const start = drawnAtRead.length;

    await slideTo(slider, 2);
    await settle(30);
    // The root's 101 folders: deep/ and the 100 u's.
    const reads = drawnAtRead.slice(start).filter((read) => /^(u\d+|deep)$/.test(read.path));
    expect(reads.length, "every folder of the level is read, past the first batch").toBe(101);
    const batches = [...new Set(reads.map((read) => read.nodes))];
    expect(batches.length, "the second batch is read once the first is drawn").toBe(2);
    expect(reads.filter((read) => read.nodes === batches[0]).length).toBe(64);
    expect(tab.expanded.u99, "the level opens once all of it is read").toBe(true);
    expect(visibleIds()).toContain("u99/n0.md");
  });

  test("a raise counts the notes it is about to read against the budget", async () => {
    // 60 folders of 60 notes the shared graph does not hold: a second level
    // would draw 3,663 nodes.
    serveUnreadFolders(60, 60);
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    let row = await depthRow(tab);
    const slider = row.querySelector<HTMLInputElement>("input[type='range']")!;
    expect(slider.max).toBe("2");

    await slideTo(slider, 2);
    await settle(30);
    expect(tab.expanded.u0, "the level that would pass the budget stays closed").toBeUndefined();
    expect(visibleIds().length).toBeLessThanOrEqual(GRAPH_DRAWN_NODE_BUDGET);
    row = document.body.querySelector<HTMLElement>(".tab-menu-bubble .depth-row")!;
    expect(row.querySelector(".depth-value")?.textContent?.replace(/\s+/g, " ").trim()).toBe("1 [limit]");
  });

  test("a raise over a level the shared graph already counts past the budget reads none of it", async () => {
    // As the server answers a gitignored folder: the shared graph's tree
    // layer holds its 60 folders of 60 notes, the spine none of their
    // levels, and the tab is restored on it with its deep/ folder open.
    const dirs = ["ignored", "ignored/heavy", "ignored/heavy/deep"];
    const files = ["ignored/heavy/deep/x.md"];
    for (let f = 0; f < 60; f += 1) {
      dirs.push(`ignored/heavy/u${f}`);
      for (let n = 0; n < 60; n += 1) files.push(`ignored/heavy/u${f}/n${n}.md`);
    }
    const parent = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));
    const dirId = (path: string): string => (path === "" ? "" : `directory:${path}`);
    graphServer.view = {
      nodes: [g.dir(""), ...dirs.map((path) => g.dir(path)), ...files.map((path) => g.file(path))],
      edges: [
        ...dirs.map((path) => g.edge(dirId(parent(path)), dirId(path), "contains")),
        ...files.map((path) => g.edge(dirId(parent(path)), path, "contains")),
      ],
    };
    graphServer.fs = {
      nodes: [fsg.dir(""), ...dirs.map((path) => fsg.dir(path)), ...files.map((path) => fsg.file(path))],
      edges: [...dirs, ...files].map((path) => fsg.contains(parent(path), path)),
    };
    const { tab } = await mountGraphPanel(
      GraphPanel,
      layout,
      graphTab({
        pendingSelectId: "directory:ignored/heavy",
        selectedNodeId: "directory:ignored/heavy",
        expanded: { ignored: true, "ignored/heavy": true, "ignored/heavy/deep": true },
      }),
    );
    let row = await depthRow(tab);
    const slider = row.querySelector<HTMLInputElement>("input[type='range']")!;
    expect(slider.max).toBe("2");
    const start = graphServer.fsGraphCalls.length;

    await slideTo(slider, 2);
    await settle(30);
    const reads = graphServer.fsGraphCalls.slice(start).filter((call) => call.path.startsWith("ignored/heavy/u"));
    expect(reads, "no folder of a level already past the budget is read").toEqual([]);
    expect(tab.expanded["ignored/heavy/u0"]).toBeUndefined();
    row = document.body.querySelector<HTMLElement>(".tab-menu-bubble .depth-row")!;
    expect(row.querySelector(".depth-value")?.textContent?.replace(/\s+/g, " ").trim()).toBe("1 [limit]");
  });

  test("a raise reads a level's folders before the level below them", async () => {
    // Five folders whose children are unread hold three folders each, whose
    // notes are unread too; a chain gives the depth its third level.
    const view = { nodes: [g.dir(""), g.dir("deep"), g.dir("deep/x"), g.file("deep/x/y.md")], edges: [
      g.edge("", "directory:deep", "contains"),
      g.edge("directory:deep", "directory:deep/x", "contains"),
      g.edge("directory:deep/x", "deep/x/y.md", "contains"),
    ] };
    const fs = { nodes: [fsg.dir(""), fsg.dir("deep"), fsg.dir("deep/x"), fsg.file("deep/x/y.md")], edges: [
      fsg.contains("", "deep"),
      fsg.contains("deep", "deep/x"),
      fsg.contains("deep/x", "deep/x/y.md"),
    ] };
    for (let f = 0; f < 5; f += 1) {
      view.nodes.push(g.dir(`f${f}`));
      view.edges.push(g.edge("", `directory:f${f}`, "contains"));
      fs.nodes.push(fsg.dir(`f${f}`));
      fs.edges.push(fsg.contains("", `f${f}`));
      for (let c = 0; c < 3; c += 1) {
        fs.nodes.push(fsg.dir(`f${f}/g${c}`), fsg.file(`f${f}/g${c}/n.md`));
        fs.edges.push(fsg.contains(`f${f}`, `f${f}/g${c}`), fsg.contains(`f${f}/g${c}`, `f${f}/g${c}/n.md`));
      }
    }
    graphServer.view = view;
    graphServer.fs = fs;
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    const slider = (await depthRow(tab)).querySelector<HTMLInputElement>("input[type='range']")!;
    const start = graphServer.fsGraphCalls.length;

    await slideTo(slider, 3);
    await settle(30);
    const order = graphServer.fsGraphCalls.slice(start).map((call) => call.path).filter((path) => /^f\d/.test(path));
    expect(order.slice(0, 5).every((path) => /^f\d$/.test(path)), `the first level first: ${order}`).toBe(true);
    expect(order.slice(5).every((path) => /^f\d\/g\d$/.test(path)), `then the second: ${order}`).toBe(true);
    expect(order.length).toBe(20);
    expect(tab.expanded["f4/g2"], "three levels open").toBe(true);
    expect(visibleIds()).toContain("f4/g2/n.md");
  });
});

describe("the drawn-node budget holds", () => {
  /// The tab's drawn count, its depth row's text, and whether u0 is open.
  async function reading(tab: GraphTab): Promise<{ drawn: number; depth: string; open: boolean }> {
    const row = await depthRow(tab);
    return {
      drawn: visibleIds().length,
      depth: row.querySelector(".depth-value")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      open: tab.expanded.u0 === true,
    };
  }

  /// What the canvas's status line says of a depth or a folder that did
  /// not open.
  function note(): string | null {
    return document.body.querySelector(".statusbar .depth-note")?.textContent?.trim() ?? null;
  }

  async function raiseRootTo2(tab: GraphTab): Promise<void> {
    const slider = (await depthRow(tab)).querySelector<HTMLInputElement>("input[type='range']")!;
    await slideTo(slider, 2);
    await settle(30);
  }

  async function reloadGraph(): Promise<void> {
    window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.graph.reload" } }));
    await settle(30);
  }

  test("a raise over folders the shared graph holds one note of reads them, and a burst of saves keeps the budget", async () => {
    // The shape of a workspace over the listing cap: the shared graph holds
    // one note of each folder, the disk holds 60.
    serveUnreadFolders(60, 60);
    for (let i = 0; i < 60; i += 1) {
      graphServer.view.nodes.push(g.file(`u${i}/n0.md`));
      graphServer.view.edges.push(g.edge(`directory:u${i}`, `u${i}/n0.md`, "contains"));
    }
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));

    await raiseRootTo2(tab);
    expect(await reading(tab)).toMatchObject({ depth: "1 [limit]", open: false });

    graphServer.fs.nodes.push(...Array.from({ length: 60 }, (_, i) => fsg.file(`u${i}/new.md`)));
    graphServer.fs.edges.push(...Array.from({ length: 60 }, (_, i) => fsg.contains(`u${i}`, `u${i}/new.md`)));
    graphReloadSignal.paths = Array.from({ length: 60 }, (_, i) => `u${i}/new.md`);
    graphReloadSignal.nonce += 1;
    await new Promise((r) => setTimeout(r, 400));
    await settle(30);
    const after = await reading(tab);
    expect(after.drawn, "drawn after the burst").toBeLessThanOrEqual(GRAPH_DRAWN_NODE_BUDGET);
    expect(after.open).toBe(false);
  });

  test("a raise whose reads fail stops below their level, and a reload keeps the budget", async () => {
    serveUnreadFolders(60, 60);
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    graphServer.fsFail = (path) => (/^u\d+$/.test(path) ? new Error("request timed out after 10000 ms") : null);

    await raiseRootTo2(tab);
    expect((await reading(tab)).open, "a level whose folders could not be read stays closed").toBe(false);
    expect(note(), "the canvas says why").toBe("u0 could not be read; the depth stops above it");

    graphServer.fsFail = null;
    await reloadGraph();
    const after = await reading(tab);
    expect(after.drawn, "drawn after the reload").toBeLessThanOrEqual(GRAPH_DRAWN_NODE_BUDGET);
    expect(after.open).toBe(false);
  });

  test("a raise after a whole fetch reads its folders again", async () => {
    serveUnreadFolders(60, 60);
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    await raiseRootTo2(tab);
    expect((await reading(tab)).depth).toBe("1 [limit]");

    await reloadGraph();
    await raiseRootTo2(tab);
    expect((await reading(tab)).open, "the same raise stops again").toBe(false);
    await reloadGraph();
    const after = await reading(tab);
    expect(after.drawn, "drawn after the next reload").toBeLessThanOrEqual(GRAPH_DRAWN_NODE_BUDGET);
    expect(after.open).toBe(false);
  });

  test("files that arrive in the open tree past the budget close it back", async () => {
    serveUnreadFolders(60, 10);
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    await raiseRootTo2(tab);
    expect((await reading(tab)).open, "60 folders of 10 notes fit").toBe(true);

    const arriving = Array.from({ length: 60 }, (_, i) => Array.from({ length: 50 }, (_, n) => `u${i}/more${n}.md`)).flat();
    graphServer.fs.nodes.push(...arriving.map((path) => fsg.file(path)));
    graphServer.fs.edges.push(...arriving.map((path) => fsg.contains(path.split("/")[0], path)));
    graphReloadSignal.paths = arriving;
    graphReloadSignal.nonce += 1;
    await new Promise((r) => setTimeout(r, 400));
    await settle(30);
    const after = await reading(tab);
    expect(after.drawn, "drawn once the files arrived").toBeLessThanOrEqual(GRAPH_DRAWN_NODE_BUDGET);
    expect(after).toMatchObject({ depth: "1 [limit]", open: false });
  });

  test("a double-click on a folder that holds more than fits is closed back", async () => {
    serveUnreadFolders(1, 3500);
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    canvas.props!.onSelect("directory:u0");
    await settle(2);
    canvas.props!.onSetAsScope();
    await settle(30);
    expect(visibleIds().length).toBeLessThanOrEqual(GRAPH_DRAWN_NODE_BUDGET);
    expect(tab.expanded.u0).toBeUndefined();
    expect(note(), "the canvas says why").toBe("opening u0 would draw more than 3,000 files and folders");
    expect((await depthRow(tab)).getAttribute("title")).toBe("Opening this folder would draw more than 3,000 files and folders");
  });

  test("a double-click on a folder whose children are drawn refuses past the budget", async () => {
    serveUnreadFolders(1, 3500);
    for (let n = 0; n < 3500; n += 1) {
      graphServer.view.nodes.push(g.file(`u0/n${n}.md`));
      graphServer.view.edges.push(g.edge("directory:u0", `u0/n${n}.md`, "contains"));
    }
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    const reads = graphServer.fsGraphCalls.length;
    canvas.props!.onSelect("directory:u0");
    await settle(2);
    const fit = canvas.props!.expansionFitRequest;
    canvas.props!.onSetAsScope();
    await settle(30);
    expect(visibleIds().length).toBeLessThanOrEqual(GRAPH_DRAWN_NODE_BUDGET);
    expect(tab.expanded.u0).toBeUndefined();
    expect(graphServer.fsGraphCalls.length, "refused up front, with no read").toBe(reads);
    expect(canvas.props!.expansionFitRequest, "and nothing opened to fit").toBe(fit);
    expect(note()).toBe("opening u0 would draw more than 3,000 files and folders");
  });

  test("a close names no folder the user did not select", async () => {
    serveUnreadFolders(2, 10);
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    for (const folder of ["u1", "u0"]) {
      canvas.props!.onSelect(`directory:${folder}`);
      await settle(2);
      canvas.props!.onSetAsScope();
      await settle(10);
    }
    canvas.props!.onSelect("directory:deep");
    await settle(2);
    const arriving = ["u0/one.md", ...Array.from({ length: 3000 }, (_, n) => `u1/more${n}.md`)];
    graphServer.fs.nodes.push(...arriving.map((path) => fsg.file(path)));
    graphServer.fs.edges.push(...arriving.map((path) => fsg.contains(path.split("/")[0], path)));
    graphReloadSignal.paths = arriving;
    graphReloadSignal.nonce += 1;
    await new Promise((r) => setTimeout(r, 400));
    await settle(30);
    expect(visibleIds().length).toBeLessThanOrEqual(GRAPH_DRAWN_NODE_BUDGET);
    expect(tab.expanded.u1, "the folder the files grew closes").toBeUndefined();
    expect(note(), "no note names a folder for a cause it did not have").toBeNull();
  });

  test("a close names the selected folder only when it would not fit alone", async () => {
    // u0 and u1 hold 10 notes each and are open; u0 is selected. One burst
    // adds a note to u0 and 3,000 to u1, and both close at their level.
    serveUnreadFolders(2, 10);
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    for (const folder of ["u1", "u0"]) {
      canvas.props!.onSelect(`directory:${folder}`);
      await settle(2);
      canvas.props!.onSetAsScope();
      await settle(10);
    }
    const arriving = ["u0/one.md", ...Array.from({ length: 3000 }, (_, n) => `u1/more${n}.md`)];
    graphServer.fs.nodes.push(...arriving.map((path) => fsg.file(path)));
    graphServer.fs.edges.push(...arriving.map((path) => fsg.contains(path.split("/")[0], path)));
    graphReloadSignal.paths = arriving;
    graphReloadSignal.nonce += 1;
    await new Promise((r) => setTimeout(r, 400));
    await settle(30);
    expect(tab.expanded.u0, "u0 closed with its level").toBeUndefined();
    expect(note(), "u0 alone fits, so no note says otherwise").toBeNull();
  });

  test("a graph opened on a folder past the budget says why it stays closed", async () => {
    serveUnreadFolders(1, 3500);
    for (let n = 0; n < 3500; n += 1) {
      graphServer.view.nodes.push(g.file(`u0/n${n}.md`));
      graphServer.view.edges.push(g.edge("directory:u0", `u0/n${n}.md`, "contains"));
    }
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ pendingSelectId: "u0", expanded: openedForPath("u0") }));
    await settle(30);
    expect(tab.expanded.u0).toBeUndefined();
    expect(note()).toBe("opening u0 would draw more than 3,000 files and folders");
  });

  test("files that arrive in a raised folder itself close its subfolders, not it", async () => {
    // p raised to its second level, 60 folders of 40 notes: 2,460 counted.
    const view = { nodes: [g.dir(""), g.dir("p")], edges: [g.edge("", "directory:p", "contains")] };
    const fs = { nodes: [fsg.dir(""), fsg.dir("p")], edges: [fsg.contains("", "p")] };
    const add = (parent: string, path: string, file: boolean): void => {
      view.nodes.push(file ? g.file(path) : g.dir(path));
      view.edges.push(g.edge(`directory:${parent}`, file ? path : `directory:${path}`, "contains"));
      fs.nodes.push(file ? fsg.file(path) : fsg.dir(path));
      fs.edges.push(fsg.contains(parent, path));
    };
    for (let i = 0; i < 60; i += 1) {
      add("p", `p/u${i}`, false);
      for (let n = 0; n < 40; n += 1) add(`p/u${i}`, `p/u${i}/n${n}.md`, true);
    }
    graphServer.view = view;
    graphServer.fs = fs;
    const { tab } = await mountGraphPanel(
      GraphPanel,
      layout,
      graphTab({ expanded: { "": true, p: true }, selectedNodeId: "directory:p", pendingSelectId: "directory:p" }),
    );
    await settle(10);
    const slider = (await depthRow(tab)).querySelector<HTMLInputElement>("input[type='range']")!;
    await slideTo(slider, 2);
    await settle(30);
    expect(tab.expanded["p/u0"], "p's second level fits").toBe(true);

    const arriving = Array.from({ length: 700 }, (_, n) => `p/new${n}.md`);
    graphServer.fs.nodes.push(...arriving.map((path) => fsg.file(path)));
    graphServer.fs.edges.push(...arriving.map((path) => fsg.contains("p", path)));
    graphReloadSignal.paths = arriving;
    graphReloadSignal.nonce += 1;
    await new Promise((r) => setTimeout(r, 400));
    await settle(30);
    expect(visibleIds().length).toBeLessThanOrEqual(GRAPH_DRAWN_NODE_BUDGET);
    expect(tab.expanded["p/u0"], "p's subfolders close").toBeUndefined();
    expect(tab.expanded.p, "p itself stays open").toBe(true);
    expect(visibleIds(), "with the files that arrived").toContain("p/new699.md");
  });

  test("a raise over a folder gone from disk stops below it, reading it once", async () => {
    // The shared graph lists u3; the disk no longer has it.
    serveUnreadFolders(10, 1);
    graphServer.fs.nodes = graphServer.fs.nodes.filter((n) => n.path !== "u3" && !n.path.startsWith("u3/"));
    graphServer.fs.edges = graphServer.fs.edges.filter((e) => e.target !== "u3" && !e.target.startsWith("u3/"));
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    let goneReads = 0;
    graphServer.onFsGraph = (request) => {
      if (request.path === "u3") goneReads += 1;
    };
    // A raise that read the gone folder again and again would never end;
    // past a few reads the fixture fails it, which ends the raise anyway.
    graphServer.fsFail = (path) => (path === "u3" && goneReads > 4 ? new Error("read again") : null);

    await raiseRootTo2(tab);
    expect(goneReads, "the gone folder is read once").toBe(1);
    expect(tab.expanded.u0, "the level stays closed").toBeUndefined();
    expect(note()).toBe("u3 could not be read; the depth stops above it");
  });

  test("a root that alone holds more than the budget still opens folders below it", async () => {
    // 3,100 files at the root, a folder of 10 and a folder of 3,500, all
    // held by the shared graph.
    const view = { nodes: [g.dir(""), g.dir("small"), g.dir("big")], edges: [
      g.edge("", "directory:small", "contains"), g.edge("", "directory:big", "contains"),
    ] };
    const fs = { nodes: [fsg.dir(""), fsg.dir("small"), fsg.dir("big")], edges: [fsg.contains("", "small"), fsg.contains("", "big")] };
    const add = (dir: string, path: string): void => {
      view.nodes.push(g.file(path));
      view.edges.push(g.edge(dir === "" ? "" : `directory:${dir}`, path, "contains"));
      fs.nodes.push(fsg.file(path));
      fs.edges.push(fsg.contains(dir, path));
    };
    for (let n = 0; n < 3100; n += 1) add("", `root${n}.md`);
    for (let n = 0; n < 10; n += 1) add("small", `small/n${n}.md`);
    for (let n = 0; n < 3500; n += 1) add("big", `big/n${n}.md`);
    graphServer.view = view;
    graphServer.fs = fs;
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));

    canvas.props!.onSelect("directory:small");
    await settle(2);
    canvas.props!.onSetAsScope();
    await settle(30);
    expect(tab.expanded.small, "the root's own level is not counted").toBe(true);
    expect(visibleIds()).toContain("small/n9.md");

    canvas.props!.onSelect("directory:big");
    await settle(2);
    canvas.props!.onSetAsScope();
    await settle(30);
    expect(tab.expanded.big, "3,500 below the root is past it").toBeUndefined();
    expect(note()).toBe("opening big would draw more than 3,000 files and folders");
    expect(tab.expanded.small, "the folder that fit stays").toBe(true);
  });

  test("double-clicks that add up past the budget stop at the one that would pass it", async () => {
    serveUnreadFolders(10, 400);
    for (let i = 0; i < 10; i += 1) {
      for (let n = 0; n < 400; n += 1) {
        graphServer.view.nodes.push(g.file(`u${i}/n${n}.md`));
        graphServer.view.edges.push(g.edge(`directory:u${i}`, `u${i}/n${n}.md`, "contains"));
      }
    }
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    for (let i = 0; i < 10; i += 1) {
      canvas.props!.onSelect(`directory:u${i}`);
      await settle(2);
      canvas.props!.onSetAsScope();
      await settle(10);
    }
    expect(visibleIds().length).toBeLessThanOrEqual(GRAPH_DRAWN_NODE_BUDGET);
    expect(Object.keys(tab.expanded).filter((dir) => dir.startsWith("u")).length, "seven folders of 400 fit").toBe(7);
    expect(note()).toBe("opening u9 would draw more than 3,000 files and folders");
  });

  test("files that arrive past the budget close the folders they grew, not a folder opened elsewhere", async () => {
    // p/ raised to its second level; q/r opened by hand.
    const view = { nodes: [g.dir(""), g.dir("p"), g.dir("q"), g.dir("q/r")], edges: [
      g.edge("", "directory:p", "contains"), g.edge("", "directory:q", "contains"), g.edge("directory:q", "directory:q/r", "contains"),
    ] };
    const fs = { nodes: [fsg.dir(""), fsg.dir("p"), fsg.dir("q"), fsg.dir("q/r")], edges: [
      fsg.contains("", "p"), fsg.contains("", "q"), fsg.contains("q", "q/r"),
    ] };
    const add = (parent: string, path: string, file: boolean): void => {
      fs.nodes.push(file ? fsg.file(path) : fsg.dir(path));
      fs.edges.push(fsg.contains(parent, path));
    };
    for (let i = 0; i < 60; i += 1) {
      add("p", `p/u${i}`, false);
      view.nodes.push(g.dir(`p/u${i}`));
      view.edges.push(g.edge("directory:p", `directory:p/u${i}`, "contains"));
      for (let n = 0; n < 10; n += 1) {
        add(`p/u${i}`, `p/u${i}/n${n}.md`, true);
        view.nodes.push(g.file(`p/u${i}/n${n}.md`));
        view.edges.push(g.edge(`directory:p/u${i}`, `p/u${i}/n${n}.md`, "contains"));
      }
    }
    for (let n = 0; n < 100; n += 1) add("q/r", `q/r/n${n}.md`, true);
    graphServer.view = view;
    graphServer.fs = fs;
    const { tab } = await mountGraphPanel(
      GraphPanel,
      layout,
      graphTab({ expanded: { "": true, p: true, q: true, "q/r": true }, selectedNodeId: "directory:p", pendingSelectId: "directory:p" }),
    );
    await settle(10);
    const slider = (await depthRow(tab)).querySelector<HTMLInputElement>("input[type='range']")!;
    await slideTo(slider, 2);
    await settle(30);
    expect(tab.expanded["p/u0"], "p's second level fits").toBe(true);

    const arriving = Array.from({ length: 60 }, (_, i) => Array.from({ length: 45 }, (_, n) => `p/u${i}/more${n}.md`)).flat();
    for (const path of arriving) add(path.split("/").slice(0, 2).join("/"), path, true);
    graphReloadSignal.paths = arriving;
    graphReloadSignal.nonce += 1;
    await new Promise((r) => setTimeout(r, 400));
    await settle(30);
    expect(visibleIds().length).toBeLessThanOrEqual(GRAPH_DRAWN_NODE_BUDGET);
    expect(tab.expanded["p/u0"], "the folders the files grew close").toBeUndefined();
    expect(tab.expanded["q/r"], "the folder opened elsewhere stays").toBe(true);
  });

  test("a restored tree the shared graph shows past the budget closes before its spine arrives", async () => {
    serveUnreadFolders(1, 3500);
    for (let n = 0; n < 3500; n += 1) {
      graphServer.view.nodes.push(g.file(`u0/n${n}.md`));
      graphServer.view.edges.push(g.edge("directory:u0", `u0/n${n}.md`, "contains"));
    }
    let release!: () => void;
    graphServer.fsGate = new Promise((resolve) => (release = resolve));
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true, u0: true } }));
    await settle(30);
    expect(visibleIds().length).toBeLessThanOrEqual(GRAPH_DRAWN_NODE_BUDGET);
    expect(tab.expanded.u0).toBeUndefined();
    release();
    await settle(10);
  });

  test("a raise whose batch a reload supersedes reads it again", async () => {
    serveUnreadFolders(60, 60);
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    let reloaded = false;
    const opened: boolean[] = [];
    graphServer.onFsGraph = (request) => {
      opened.push(tab.expanded.u0 === true);
      if (!reloaded && request.path === "u3") {
        reloaded = true;
        window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.graph.reload" } }));
      }
    };
    await raiseRootTo2(tab);
    await settle(30);
    expect(reloaded).toBe(true);
    expect(opened.some(Boolean), "the level never opened on a count it could not make").toBe(false);
    expect(await reading(tab)).toMatchObject({ depth: "1 [limit]", open: false });
  });

  test("a graph opened on a directory over unread folders stays within the budget", async () => {
    // p/ holds 60 folders; the shared graph holds one note of each, so the
    // first files sit two levels down, and the disk holds 60 of each.
    const view = { nodes: [g.dir(""), g.dir("p")], edges: [g.edge("", "directory:p", "contains")] };
    const fs = { nodes: [fsg.dir(""), fsg.dir("p")], edges: [fsg.contains("", "p")] };
    for (let i = 0; i < 60; i += 1) {
      view.nodes.push(g.dir(`p/u${i}`), g.file(`p/u${i}/n0.md`));
      view.edges.push(g.edge("directory:p", `directory:p/u${i}`, "contains"), g.edge(`directory:p/u${i}`, `p/u${i}/n0.md`, "contains"));
      fs.nodes.push(fsg.dir(`p/u${i}`));
      fs.edges.push(fsg.contains("p", `p/u${i}`));
      for (let n = 0; n < 60; n += 1) {
        fs.nodes.push(fsg.file(`p/u${i}/n${n}.md`));
        fs.edges.push(fsg.contains(`p/u${i}`, `p/u${i}/n${n}.md`));
      }
    }
    graphServer.view = view;
    graphServer.fs = fs;
    const { tab } = await mountGraphPanel(
      GraphPanel,
      layout,
      graphTab({ pendingSelectId: "p", expanded: openedForPath("p") }),
    );
    await settle(30);
    expect(tab.expanded["p/u0"], "the level of the files would pass the budget").toBeUndefined();
    expect(visibleIds().length).toBeLessThanOrEqual(GRAPH_DRAWN_NODE_BUDGET);
  });

  test("a depth lowered while a raise reads stays lowered", async () => {
    serveUnreadFolders(10, 2);
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    const slider = (await depthRow(tab)).querySelector<HTMLInputElement>("input[type='range']")!;
    let release!: () => void;
    graphServer.fsGate = new Promise((resolve) => (release = resolve));

    await slideTo(slider, 2);
    await slideTo(slider, 1);
    release();
    await settle(30);
    expect(tab.expanded.u0, "the raise ended with the lowering").toBeUndefined();
  });

  test("a raise a new selection ends reads no more of its batch", async () => {
    serveUnreadFolders(100, 1);
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    const slider = (await depthRow(tab)).querySelector<HTMLInputElement>("input[type='range']")!;
    let release!: () => void;
    graphServer.fsGate = new Promise((resolve) => (release = resolve));
    const start = graphServer.fsGraphCalls.length;

    await slideTo(slider, 2);
    canvas.props!.onSelect("directory:deep");
    await settle(2);
    release();
    await settle(30);
    const reads = graphServer.fsGraphCalls.slice(start).filter((call) => /^u\d+$/.test(call.path));
    expect(reads.length, "reads after the raise ended").toBeLessThanOrEqual(1);
    expect(tab.expanded.u0).toBeUndefined();
  });
});

/// Under the root: `count` folders `u0`... holding `notes` notes each on
/// disk, which the shared graph lists as empty folders, beside a chain
/// `deep/x` that gives the depth its second level.
function serveUnreadFolders(count: number, notes: number): void {
  const folders = Array.from({ length: count }, (_, i) => `u${i}`);
  graphServer.view = {
    nodes: [g.dir(""), g.dir("deep"), g.dir("deep/x"), ...folders.map((path) => g.dir(path))],
    edges: [
      g.edge("", "directory:deep", "contains"),
      g.edge("directory:deep", "directory:deep/x", "contains"),
      ...folders.map((path) => g.edge("", `directory:${path}`, "contains")),
    ],
  };
  const notesOf = (path: string): string[] => Array.from({ length: notes }, (_, n) => `${path}/n${n}.md`);
  graphServer.fs = {
    nodes: [fsg.dir(""), fsg.dir("deep"), fsg.dir("deep/x"), ...folders.flatMap((path) => [fsg.dir(path), ...notesOf(path).map((note) => fsg.file(note))])],
    edges: [
      fsg.contains("", "deep"),
      fsg.contains("deep", "deep/x"),
      ...folders.flatMap((path) => [fsg.contains("", path), ...notesOf(path).map((note) => fsg.contains(path, note))]),
    ],
  };
}

describe("the workspace tree", () => {
  test("shows a directory's files only while it and its ancestors are expanded", async () => {
    await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    let ids = visibleIds();
    expect(ids).toEqual(expect.arrayContaining(["", NOTES, SRC]));
    expect(ids).not.toContain(A);
    unmountGraphPanels();

    await mountGraphPanel(
      GraphPanel,
      layout,
      graphTab({ expanded: { "": true, notes: true } }),
    );
    ids = visibleIds();
    expect(ids).toEqual(expect.arrayContaining([A, DEEP]));
    expect(ids, "notes/deep is not expanded").not.toContain(D);
    expect(ids, "src is not expanded").not.toContain(MAIN);
  });

  test("a double-click on a selected directory expands it, asks the canvas to fit it, and collapses it again", async () => {
    const { tab } = await mountGraphPanel(
      GraphPanel,
      layout,
      graphTab({ expanded: { "": true } }),
    );
    canvas.props!.onSelect(NOTES);
    await settle(2);
    canvas.props!.onSetAsScope();
    await settle();

    expect(tab.expanded.notes).toBe(true);
    expect(visibleIds()).toContain(A);
    const fit = canvas.props!.expansionFitRequest;
    expect(fit?.ids, "the directory, its parent and what it revealed").toEqual(
      expect.arrayContaining([NOTES, "", A, DEEP]),
    );
    expect(fit?.ids).not.toContain(SRC);

    canvas.props!.onSetAsScope();
    await settle();
    expect(tab.expanded.notes).toBeUndefined();
    expect(visibleIds()).not.toContain(A);
  });

  test("the depth on a selected directory opens that many levels below it, and only there", async () => {
    const { tab } = await mountGraphPanel(
      GraphPanel,
      layout,
      graphTab({ expanded: { "": true, src: true } }),
    );
    canvas.props!.onSelect(NOTES);
    await settle(2);
    const slider = (await depthRow(tab)).querySelector<HTMLInputElement>("input[type='range']")!;
    const streams = graphServer.graphStreamCalls;

    await slideTo(slider, 2);
    expect(tab.expanded.notes).toBe(true);
    expect(tab.expanded["notes/deep"], "one level below the selection").toBe(true);
    expect(tab.expanded.src, "another branch stays as it was").toBe(true);
    expect(visibleIds()).toEqual(expect.arrayContaining([D, MAIN]));
    expect(slider.value).toBe("2");

    await slideTo(slider, 0);
    expect(tab.expanded.notes, "zero closes the directory").toBeUndefined();
    expect(tab.expanded["notes/deep"]).toBeUndefined();
    expect(visibleIds()).not.toContain(A);
    expect(visibleIds(), "the directory itself stays").toContain(NOTES);
    expect(graphServer.graphStreamCalls, "the tree was already loaded").toBe(streams);
  });

  /// Folder `a` holds `a/x.md` and subfolder `a/b`; the shared graph holds
  /// both folders and no file of `a`, as an answer over the listing cap does
  /// for a folder whose files the index does not hold.
  function serveFoldersWithoutFiles(): void {
    graphServer.view = {
      nodes: [g.dir(""), g.dir("a"), g.dir("a/b")],
      edges: [g.edge("", "directory:a", "contains"), g.edge("directory:a", "directory:a/b", "contains")],
    };
    graphServer.fs = {
      nodes: [fsg.dir(""), fsg.dir("a"), fsg.dir("a/b"), fsg.file("a/x.md")],
      edges: [fsg.contains("", "a"), fsg.contains("a", "a/b"), fsg.contains("a", "a/x.md")],
    };
  }

  test.each(["folders", "depth"] as const)("a double-click on a folder an answer over the listing cap (%s) holds without its files reads its level", async (tree) => {
    serveFoldersWithoutFiles();
    graphServer.tree = tree;
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    expect(graphServer.fsGraphCalls.map((call) => call.path)).not.toContain("a");

    canvas.props!.onSelect("directory:a");
    await settle(2);
    canvas.props!.onSetAsScope();
    await settle();
    expect(tab.expanded.a).toBe(true);
    expect(graphServer.fsGraphCalls.map((call) => call.path), "the subfolder does not prove the files are drawn").toContain("a");
    expect(visibleIds()).toEqual(expect.arrayContaining(["directory:a/b", "a/x.md"]));
  });

  test("a double-click on a folder an answer of the whole tree holds a child of reads nothing", async () => {
    serveFoldersWithoutFiles();
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    const reads = graphServer.fsGraphCalls.length;

    canvas.props!.onSelect("directory:a");
    await settle(2);
    canvas.props!.onSetAsScope();
    await settle();
    expect(tab.expanded.a).toBe(true);
    expect(graphServer.fsGraphCalls.length, "the shared graph holds the folder's level").toBe(reads);
    expect(visibleIds()).toContain("directory:a/b");
  });

  test("a double-click while a first load over the listing cap still streams reads the level", async () => {
    serveFoldersWithoutFiles();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    vi.mocked(api.graphStream).mockImplementationOnce(async (_scope, opts = {}) => {
      graphServer.graphStreamCalls += 1;
      await Promise.resolve();
      const meta = { type: "meta" as const, scope: "workspace" as const, path: "", depth: 6 };
      opts.onMeta?.(meta);
      opts.onView?.({ nodes: [], edges: [] });
      opts.onMeta?.({ ...meta, tree: "folders" });
      opts.onView?.({ nodes: [...graphServer.view.nodes], edges: [...graphServer.view.edges] });
      await finished;
      return graphServer.view;
    });
    try {
      const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
      expect(graphData.partial, "the load has not completed").toBe(true);
      expect(visibleIds(), "its partial view is drawn").toContain("directory:a");
      canvas.props!.onSelect("directory:a");
      await settle(2);
      canvas.props!.onSetAsScope();
      await settle();
      expect(tab.expanded.a).toBe(true);
      expect(graphServer.fsGraphCalls.filter((call) => call.path === "a"), "the partial view's mark decides").toHaveLength(1);
      expect(visibleIds()).toEqual(expect.arrayContaining(["directory:a/b", "a/x.md"]));
    } finally {
      finish();
    }
  });

  test("a tab over an answer over the listing cap decides by the mark it took while the window's graph reloads", async () => {
    serveFoldersWithoutFiles();
    graphServer.tree = "folders";
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    let release!: () => void;
    graphServer.streamGate = new Promise<void>((resolve) => (release = resolve));
    try {
      invalidateGraph();
      await settle();
      expect(graphServer.graphStreamCalls, "the shown tab asked again").toBe(2);
      expect(graphData.tree, "the reload has said nothing yet").toBeNull();
      expect(visibleIds(), "the tab still draws the answer it took").toContain("directory:a");
      canvas.props!.onSelect("directory:a");
      await settle(2);
      canvas.props!.onSetAsScope();
      await settle();
      expect(tab.expanded.a).toBe(true);
      expect(graphServer.fsGraphCalls.filter((call) => call.path === "a"), "the mark taken with the drawn view").toHaveLength(1);
    } finally {
      release();
    }
  });

  test("a folder opened over an answer of the whole tree is read once a refresh comes back over the listing cap", async () => {
    serveFoldersWithoutFiles();
    graphServer.view.nodes.push(g.file("a/x.md"));
    graphServer.view.edges.push(g.edge("directory:a", "a/x.md", "contains"));
    await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    canvas.props!.onSelect("directory:a");
    await settle(2);
    canvas.props!.onSetAsScope();
    await settle();
    expect(graphServer.fsGraphCalls.map((call) => call.path), "the whole tree holds the level").not.toContain("a");
    expect(visibleIds()).toContain("a/x.md");

    serveFoldersWithoutFiles();
    graphServer.tree = "folders";
    await refreshGraph();
    await settle();
    expect(graphData.tree).toBe("folders");
    expect(graphServer.fsGraphCalls.filter((call) => call.path === "a"), "the opened folder's level").toHaveLength(1);
    expect(visibleIds()).toEqual(expect.arrayContaining(["directory:a/b", "a/x.md"]));
  });

  /// Folders `a` and `a/b` with `a/x.md`, `a/b/c.md` and `a/b/y.md`, and
  /// `notes/n.md` linking to `a/b/c.md`. Marked, the answer holds every
  /// folder and of the files only the note and the file it links to.
  function serveLinkBelowClosedFolder(tree: "folders" | null): void {
    graphServer.view = {
      nodes: [
        g.dir(""), g.dir("a"), g.dir("a/b"), g.dir("notes"), g.file("notes/n.md"), g.file("a/b/c.md"),
        ...(tree === null ? [g.file("a/x.md"), g.file("a/b/y.md")] : []),
      ],
      edges: [
        g.edge("", "directory:a", "contains"),
        g.edge("directory:a", "directory:a/b", "contains"),
        g.edge("directory:a/b", "a/b/c.md", "contains"),
        g.edge("", "directory:notes", "contains"),
        g.edge("directory:notes", "notes/n.md", "contains"),
        g.edge("notes/n.md", "a/b/c.md", "link"),
        ...(tree === null
          ? [g.edge("directory:a", "a/x.md", "contains"), g.edge("directory:a/b", "a/b/y.md", "contains")]
          : []),
      ],
    };
    graphServer.fs = {
      nodes: [
        fsg.dir(""), fsg.dir("a"), fsg.dir("a/b"), fsg.dir("notes"),
        fsg.file("a/x.md"), fsg.file("a/b/c.md"), fsg.file("a/b/y.md"), fsg.file("notes/n.md"),
      ],
      edges: [
        fsg.contains("", "a"),
        fsg.contains("a", "a/b"),
        fsg.contains("a", "a/x.md"),
        fsg.contains("a/b", "a/b/c.md"),
        fsg.contains("a/b", "a/b/y.md"),
        fsg.contains("", "notes"),
        fsg.contains("notes", "notes/n.md"),
      ],
    };
    graphServer.tree = tree;
  }

  async function doubleClick(id: string): Promise<void> {
    canvas.props!.onSelect(id);
    await settle(2);
    canvas.props!.onSetAsScope();
    await settle();
  }

  /// The note's link shows `a/b` under the closed `a`; `a/b` is opened
  /// there, then `a`, then `a/b` is closed and opened again.
  async function openBelowClosedParent(): Promise<void> {
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true, notes: true } }));
    canvas.props!.onSelect("notes/n.md");
    await settle(2);
    expect(visibleIds()).toEqual(expect.arrayContaining(["directory:a", "directory:a/b", "a/b/c.md"]));
    await doubleClick("directory:a/b");
    expect(tab.expanded["a/b"]).toBe(true);
    expect(tab.expanded.a).toBeUndefined();
    await doubleClick("directory:a");
    expect(tab.expanded.a).toBe(true);
    await doubleClick("directory:a/b");
    expect(tab.expanded["a/b"]).toBeUndefined();
    await doubleClick("directory:a/b");
    expect(tab.expanded["a/b"]).toBe(true);
  }

  const levelReads = (path: string): number => graphServer.fsGraphCalls.filter((call) => call.path === path).length;
  const filesOfA = (): string[] => visibleIds().filter((id) => id.startsWith("a/"));

  test("a folder opened under its closed parent draws its files once the parent opens", async () => {
    serveLinkBelowClosedFolder(null);
    await openBelowClosedParent();
    expect(filesOfA()).toEqual(["a/b/c.md", "a/b/y.md", "a/x.md"]);
  });

  test("a folder opened under its closed parent over the listing cap is read once the parent opens", async () => {
    serveLinkBelowClosedFolder("folders");
    await openBelowClosedParent();
    expect({ a: levelReads("a"), "a/b": levelReads("a/b") }, "each opened level read once").toEqual({ a: 1, "a/b": 1 });
    expect(filesOfA()).toEqual(["a/b/c.md", "a/b/y.md", "a/x.md"]);
  });

  /// The note's link shows `a/b` under the closed `a`, and `a/b` is
  /// selected there; `opened` is the tab's opened set besides the root and
  /// `notes`. Resolves to the tab and its depth slider.
  async function selectBelowClosedParent(opened: Record<string, boolean>): Promise<{ tab: GraphTab; slider: HTMLInputElement }> {
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true, notes: true, ...opened } }));
    canvas.props!.onSelect("notes/n.md");
    await settle(2);
    expect(visibleIds()).toEqual(expect.arrayContaining(["directory:a", "directory:a/b", "a/b/c.md"]));
    canvas.props!.onSelect("directory:a/b");
    await settle(2);
    const slider = (await depthRow(tab)).querySelector<HTMLInputElement>("input[type='range']")!;
    return { tab, slider };
  }

  test.each([
    ["an answer of the whole tree", null, { a: 0, "a/b": 1 }],
    ["an answer over the listing cap", "folders", { a: 1, "a/b": 1 }],
  ] as const)("a depth raised on a folder under its closed parent draws the parent it opens, over %s", async (_answer, tree, reads) => {
    serveLinkBelowClosedFolder(tree);
    const { tab, slider } = await selectBelowClosedParent({});
    expect(slider.value, "a/b is closed").toBe("0");

    await slideTo(slider, 1);
    expect({ a: tab.expanded.a, "a/b": tab.expanded["a/b"] }, "the raise opens a/b and the folder above it").toEqual({ a: true, "a/b": true });
    expect({ a: levelReads("a"), "a/b": levelReads("a/b") }, "each opened level read at most once").toEqual(reads);
    expect(filesOfA()).toEqual(["a/b/c.md", "a/b/y.md", "a/x.md"]);
  });

  test.each([
    ["an answer of the whole tree", null, 0],
    ["an answer over the listing cap", "folders", 1],
  ] as const)("a depth lowered on a folder open under its closed parent draws the parent it opens, over %s", async (_answer, tree, reads) => {
    serveLinkBelowClosedFolder(tree);
    const { tab, slider } = await selectBelowClosedParent({ "a/b": true });
    expect(slider.value, "a/b is open").toBe("1");

    await slideTo(slider, 0);
    expect({ a: tab.expanded.a, "a/b": tab.expanded["a/b"] }, "the depth closes a/b and opens the folder above it").toEqual({ a: true, "a/b": undefined });
    expect(levelReads("a"), "the opened parent's level").toBe(reads);
    expect(filesOfA()).toEqual(["a/x.md"]);
  });

  test("a raise a new selection ends while it reads still reads the folder above that its first pass opened, over an answer over the listing cap", async () => {
    serveLinkBelowClosedFolder("folders");
    const { tab, slider } = await selectBelowClosedParent({});
    expect(slider.value, "a/b is closed").toBe("0");
    let release!: () => void;
    graphServer.fsGate = new Promise<void>((resolve) => (release = resolve));
    try {
      await slideTo(slider, 1);
      expect(tab.expanded.a, "the raise's first pass opens the folder above").toBe(true);
      canvas.props!.onSelect("notes/n.md");
      await settle();
    } finally {
      graphServer.fsGate = null;
      release();
    }
    await settle(20);
    expect(tab.expanded.a, "the folder above stays open").toBe(true);
    expect({ a: levelReads("a"), drawsX: visibleIds().includes("a/x.md") }).toEqual({ a: 1, drawsX: true });
  });

  test("a raise a new selection ends during a whole spine fetch leaves the folder above to that fetch's landing, over an answer over the listing cap", async () => {
    serveLinkBelowClosedFolder("folders");
    const { tab, slider } = await selectBelowClosedParent({});
    expect(slider.value, "a/b is closed").toBe("0");
    const release = await holdWholeFetch();
    try {
      expect(levelReads(""), "the whole fetch is in flight").toBe(2);
      await slideTo(slider, 1);
      expect(tab.expanded.a, "the raise's first pass opens the folder above").toBe(true);
      canvas.props!.onSelect("notes/n.md");
      await settle();
      expect(levelReads(""), "ending the raise starts no other fetch").toBe(2);
    } finally {
      release();
    }
    await settle(30);
    expect(tab.expanded.a, "the folder above stays open").toBe(true);
    expect({ root: levelReads(""), a: levelReads("a"), drawsX: visibleIds().includes("a/x.md") }).toEqual({ root: 2, a: 1, drawsX: true });
  });

  test("a raise a new selection ends leaves a folder whose read failed to its retry", async () => {
    serveLinkBelowClosedFolder("folders");
    graphServer.view.nodes.push(g.dir("bad"));
    graphServer.view.edges.push(g.edge("", "directory:bad", "contains"));
    graphServer.fs.nodes.push(fsg.dir("bad"), fsg.file("bad/z.md"));
    graphServer.fs.edges.push(fsg.contains("", "bad"), fsg.contains("bad", "bad/z.md"));
    graphServer.fsFail = (path) => (path === "bad" ? new TypeError("Failed to fetch") : null);
    const { tab, slider } = await selectBelowClosedParent({ bad: true });
    await settle(20);
    expect(levelReads("bad"), "its read and one retry").toBe(2);

    let release!: () => void;
    graphServer.fsGate = new Promise<void>((resolve) => (release = resolve));
    try {
      await slideTo(slider, 1);
      expect(tab.expanded.a).toBe(true);
      canvas.props!.onSelect("notes/n.md");
      await settle();
    } finally {
      graphServer.fsGate = null;
      release();
    }
    await settle(20);
    expect({ a: levelReads("a"), bad: levelReads("bad") }, "the selection reads the folder above and leaves bad").toEqual({ a: 1, bad: 2 });
  });

  test("a depth change leaves a folder whose read failed to its retry", async () => {
    graphServer.view = {
      nodes: [g.dir(""), g.dir("a"), g.dir("a/b"), g.dir("bad")],
      edges: [
        g.edge("", "directory:a", "contains"),
        g.edge("directory:a", "directory:a/b", "contains"),
        g.edge("", "directory:bad", "contains"),
      ],
    };
    graphServer.fs = {
      nodes: [fsg.dir(""), fsg.dir("a"), fsg.dir("a/b"), fsg.dir("bad"), fsg.file("a/x.md"), fsg.file("bad/z.md")],
      edges: [fsg.contains("", "a"), fsg.contains("a", "a/b"), fsg.contains("a", "a/x.md"), fsg.contains("", "bad"), fsg.contains("bad", "bad/z.md")],
    };
    graphServer.tree = "folders";
    graphServer.fsFail = (path) => (path === "bad" ? new TypeError("Failed to fetch") : null);
    const { tab, target } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true, a: true, bad: true } }));
    await settle(20);
    expect(levelReads("bad"), "its read and one retry").toBe(2);
    expect(target.querySelector(".spine-warning")?.textContent?.trim()).toBe("Could not read directory bad: Failed to fetch");

    canvas.props!.onSelect("directory:a");
    await settle(2);
    const slider = (await depthRow(tab)).querySelector<HTMLInputElement>("input[type='range']")!;
    expect(slider.value).toBe("1");
    await slideTo(slider, 0);
    expect(tab.expanded.a, "lowered").toBeUndefined();
    await slideTo(slider, 1);
    expect(tab.expanded.a, "raised").toBe(true);
    await settle(20);
    expect(levelReads("bad"), "neither depth change reads it").toBe(2);
  });

  test("a tab whose spine lands after an answer over the listing cap reads each opened folder once", async () => {
    serveFoldersWithoutFiles();
    graphServer.tree = "folders";
    let release!: () => void;
    graphServer.fsGate = new Promise<void>((resolve) => (release = resolve));
    await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true, a: true } }));
    expect(graphData.partial, "the answer is in").toBe(false);
    expect(graphData.tree).toBe("folders");
    release();
    await settle();
    expect({ root: levelReads(""), a: levelReads("a") }).toEqual({ root: 1, a: 1 });
    expect(visibleIds()).toContain("a/x.md");
  });

  test("a folder opened while the spine is fetched whole is read once that fetch lands under an answer over the listing cap", async () => {
    serveFoldersWithoutFiles();
    graphServer.view.nodes.push(g.file("a/x.md"));
    graphServer.view.edges.push(g.edge("directory:a", "a/x.md", "contains"));
    await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    expect(levelReads("")).toBe(1);

    // A change that names no path fetches the spine whole; it is held at
    // the root, its list of levels taken before `a` opens.
    let release!: () => void;
    graphServer.fsGate = new Promise<void>((resolve) => (release = resolve));
    try {
      graphReloadSignal.paths = [];
      graphReloadSignal.nonce += 1;
      await new Promise((r) => setTimeout(r, 400));
      await settle();
      expect(levelReads(""), "the whole fetch is in flight").toBe(2);
      await doubleClick("directory:a");
      expect(levelReads("a"), "the whole tree holds the level").toBe(0);

      graphServer.view = {
        nodes: [g.dir(""), g.dir("a"), g.dir("a/b")],
        edges: [g.edge("", "directory:a", "contains"), g.edge("directory:a", "directory:a/b", "contains")],
      };
      graphServer.tree = "folders";
      await refreshGraph();
      await settle();
      expect(graphData.tree).toBe("folders");
      expect({ root: levelReads(""), a: levelReads("a") }, "taken while the fetch is in flight, the answer starts no other").toEqual({ root: 2, a: 0 });
    } finally {
      release();
    }
    await settle(20);
    expect({ root: levelReads(""), a: levelReads("a") }).toEqual({ root: 2, a: 1 });
    expect(visibleIds()).toContain("a/x.md");
  });

  test("an answer over the listing cap taken over a spine whose root read failed reads nothing until the spine is fetched again", async () => {
    serveFoldersWithoutFiles();
    graphServer.view.nodes.push(g.file("a/x.md"));
    graphServer.view.edges.push(g.edge("directory:a", "a/x.md", "contains"));
    await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    await doubleClick("directory:a");
    expect(levelReads("a"), "the whole tree holds the level").toBe(0);

    // A change that names no path fetches the spine whole, and its root
    // read fails. The fetch asks for the levels it lists ahead of the
    // root's answer, `a` among them.
    const changeNamingNoPath = async (): Promise<void> => {
      graphReloadSignal.paths = [];
      graphReloadSignal.nonce += 1;
      await new Promise((r) => setTimeout(r, 400));
      await settle(20);
    };
    const reads = () => ({ root: levelReads(""), a: levelReads("a") });
    graphServer.fsFail = (path) => (path === "" ? new TypeError("Failed to fetch") : null);
    await changeNamingNoPath();
    const failed = reads();
    expect(failed.root, "the failed whole fetch").toBe(2);

    graphServer.view = {
      nodes: [g.dir(""), g.dir("a"), g.dir("a/b")],
      edges: [g.edge("", "directory:a", "contains"), g.edge("directory:a", "directory:a/b", "contains")],
    };
    graphServer.tree = "folders";
    await refreshGraph();
    await settle(20);
    expect(graphData.tree).toBe("folders");
    expect(reads(), "the answer leaves the failed spine to the next fetch").toEqual(failed);

    graphServer.fsFail = null;
    await changeNamingNoPath();
    expect(reads(), "the next whole fetch reads the root and the opened folder").toEqual({ root: failed.root + 1, a: failed.a + 1 });
    expect(visibleIds()).toContain("a/x.md");
  });

  test("taking an answer of the whole tree reads no opened folder", async () => {
    graphServer.view = {
      nodes: [g.dir(""), g.dir("a"), g.file("a/x.md")],
      edges: [g.edge("", "directory:a", "contains"), g.edge("directory:a", "a/x.md", "contains")],
    };
    graphServer.fs = {
      nodes: [fsg.dir(""), fsg.dir("a"), fsg.file("a/x.md")],
      edges: [fsg.contains("", "a"), fsg.contains("a", "a/x.md")],
    };
    await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    await doubleClick("directory:a");
    expect(levelReads("a"), "the whole tree holds the level").toBe(0);

    // `a/x.md` is deleted: the next answer of the whole tree holds `a` empty.
    graphServer.view = { nodes: [g.dir(""), g.dir("a")], edges: [g.edge("", "directory:a", "contains")] };
    graphServer.fs = { nodes: [fsg.dir(""), fsg.dir("a")], edges: [fsg.contains("", "a")] };
    await refreshGraph();
    await settle();
    expect(levelReads("a"), "nor does the next").toBe(0);
    expect(visibleIds()).toEqual(["", "directory:a"]);
  });

  test("an empty folder opened below a folder the spine never read is read once an answer over the listing cap is taken", async () => {
    // Under the cap: `a` holds `a/x.md` and the empty `a/b`.
    serveFoldersWithoutFiles();
    graphServer.view.nodes.push(g.file("a/x.md"));
    graphServer.view.edges.push(g.edge("directory:a", "a/x.md", "contains"));
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    await doubleClick("directory:a");
    await doubleClick("directory:a/b");
    expect({ a: tab.expanded.a, "a/b": tab.expanded["a/b"] }).toEqual({ a: true, "a/b": true });
    expect({ a: levelReads("a"), "a/b": levelReads("a/b") }, "the whole tree holds a's level, the spine no node of a/b").toEqual({ a: 0, "a/b": 0 });

    // `a/b/y.md` is written, and the next answer is over the cap.
    graphServer.fs.nodes.push(fsg.file("a/b/y.md"));
    graphServer.fs.edges.push(fsg.contains("a/b", "a/b/y.md"));
    graphReloadSignal.paths = ["a/b/y.md"];
    graphReloadSignal.nonce += 1;
    await new Promise((r) => setTimeout(r, 400));
    await settle();
    graphServer.view = {
      nodes: [g.dir(""), g.dir("a"), g.dir("a/b")],
      edges: [g.edge("", "directory:a", "contains"), g.edge("directory:a", "directory:a/b", "contains")],
    };
    graphServer.tree = "folders";
    await refreshGraph();
    await settle(20);
    expect(graphData.tree).toBe("folders");
    expect({ a: levelReads("a"), "a/b": levelReads("a/b") }, "each opened level read once").toEqual({ a: 1, "a/b": 1 });
    expect(filesOfA()).toEqual(["a/b/y.md", "a/x.md"]);

    await doubleClick("directory:a/b");
    await doubleClick("directory:a/b");
    expect(tab.expanded["a/b"], "closed and opened again").toBe(true);
    expect(levelReads("a/b"), "a level read stays read").toBe(1);
    expect(filesOfA()).toEqual(["a/b/y.md", "a/x.md"]);
  });

  test("a change in an opened folder the spine holds no node of reads nothing and draws nothing again", async () => {
    serveFoldersWithoutFiles();
    graphServer.view.nodes.push(g.file("a/x.md"));
    graphServer.view.edges.push(g.edge("directory:a", "a/x.md", "contains"));
    // A file only the spine holds, so the drawn nodes are a list of the
    // tab's own and a spine laid out again is a new one.
    graphServer.fs.nodes.push(fsg.file("r.txt"));
    graphServer.fs.edges.push(fsg.contains("", "r.txt"));
    await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    await doubleClick("directory:a");
    await doubleClick("directory:a/b");
    await settle();
    const calls = graphServer.fsGraphCalls.length;
    const drawn = canvas.props!.nodes;

    graphServer.fs.nodes.push(fsg.file("a/b/y.md"));
    graphServer.fs.edges.push(fsg.contains("a/b", "a/b/y.md"));
    graphReloadSignal.paths = ["a/b/y.md"];
    graphReloadSignal.nonce += 1;
    await new Promise((r) => setTimeout(r, 400));
    await settle();
    expect(graphServer.fsGraphCalls.length, "the patch skips a/b").toBe(calls);
    expect(canvas.props!.nodes, "a patch that read no level does not lay the spine out again").toBe(drawn);
  });

  /// A change in the workspace that names `paths`, once the watcher's
  /// debounce has passed.
  async function changeNames(paths: string[]): Promise<void> {
    graphReloadSignal.paths = paths;
    graphReloadSignal.nonce += 1;
    await new Promise((r) => setTimeout(r, 400));
    await settle();
  }

  /// A change that names no path, whose whole spine fetch is held in flight
  /// until the returned release is called.
  async function holdWholeFetch(): Promise<() => void> {
    let release!: () => void;
    graphServer.fsGate = new Promise<void>((resolve) => (release = resolve));
    graphReloadSignal.paths = [];
    graphReloadSignal.nonce += 1;
    await new Promise((r) => setTimeout(r, 400));
    await settle();
    return () => {
      graphServer.fsGate = null;
      release();
    };
  }

  /// `a` holds `a/x.md` and the empty `a/b`, in an answer of the whole tree
  /// and on disk.
  function serveWholeTree(): void {
    serveFoldersWithoutFiles();
    graphServer.view.nodes.push(g.file("a/x.md"));
    graphServer.view.edges.push(g.edge("directory:a", "a/x.md", "contains"));
  }

  test("an opened folder gone from disk costs a double-click during a whole spine fetch no other fetch", async () => {
    serveWholeTree();
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true, gone: true } }));
    expect({ root: levelReads(""), gone: levelReads("gone") }, "the first fetch reads the root and the gone folder").toEqual({ root: 1, gone: 1 });
    await doubleClick("directory:a");
    await doubleClick("directory:a");
    expect(tab.expanded.a).toBeUndefined();
    expect(levelReads("gone"), "an opening while the spine is idle reads nothing of it").toBe(1);

    const release = await holdWholeFetch();
    try {
      expect(levelReads(""), "the whole fetch is in flight").toBe(2);
      await doubleClick("directory:a");
      expect(tab.expanded.a).toBe(true);
      expect(levelReads(""), "the opening starts no other fetch").toBe(2);
    } finally {
      release();
    }
    await settle(20);
    expect({ root: levelReads(""), gone: levelReads("gone") }).toEqual({ root: 2, gone: 2 });
  });

  test("an empty folder opened under a folder the spine never read costs a double-click during a whole spine fetch no other fetch", async () => {
    serveWholeTree();
    graphServer.view.nodes.push(g.dir("c"), g.file("c/z.md"));
    graphServer.view.edges.push(g.edge("", "directory:c", "contains"), g.edge("directory:c", "c/z.md", "contains"));
    graphServer.fs.nodes.push(fsg.dir("c"), fsg.file("c/z.md"));
    graphServer.fs.edges.push(fsg.contains("", "c"), fsg.contains("c", "c/z.md"));
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    await doubleClick("directory:a");
    await doubleClick("directory:a/b");
    expect({ a: tab.expanded.a, "a/b": tab.expanded["a/b"] }).toEqual({ a: true, "a/b": true });
    expect({ a: levelReads("a"), "a/b": levelReads("a/b") }, "the whole tree holds a's level, the spine no node of a/b").toEqual({ a: 0, "a/b": 0 });

    // The whole fetch takes its list of levels now; `c`, whose files the
    // shared graph holds, opens during it.
    const release = await holdWholeFetch();
    try {
      expect(levelReads(""), "the whole fetch is in flight").toBe(2);
      await doubleClick("directory:c");
      expect(tab.expanded.c).toBe(true);
      expect(levelReads(""), "the opening starts no other fetch").toBe(2);
    } finally {
      release();
    }
    await settle(20);
    expect({ root: levelReads(""), c: levelReads("c") }).toEqual({ root: 2, c: 0 });
  });

  test("a folder opened under one whose read found it gone costs a double-click during a whole spine fetch no other fetch", async () => {
    serveWholeTree();
    graphServer.view.nodes.push(g.dir("p"));
    graphServer.view.edges.push(g.edge("", "directory:p", "contains"));
    graphServer.fs.nodes.push(fsg.dir("p"));
    graphServer.fs.edges.push(fsg.contains("", "p"));
    // `p/c` is open under the closed, empty `p`.
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true, "p/c": true } }));
    // `p` leaves the disk after the spine listed it, before a change says so.
    graphServer.fs.nodes = graphServer.fs.nodes.filter((n) => n.path !== "p");
    graphServer.fs.edges = graphServer.fs.edges.filter((e) => e.target !== "p");
    await doubleClick("directory:p");
    expect(tab.expanded.p).toBe(true);
    expect({ p: levelReads("p"), "p/c": levelReads("p/c") }, "p's read finds it gone, and p/c is not read under it").toEqual({ p: 1, "p/c": 0 });

    const release = await holdWholeFetch();
    try {
      expect(levelReads(""), "the whole fetch is in flight").toBe(2);
      await doubleClick("directory:a");
      expect(tab.expanded.a).toBe(true);
      expect(levelReads(""), "the opening starts no other fetch").toBe(2);
    } finally {
      release();
    }
    await settle(20);
    expect(levelReads("")).toBe(2);
  });

  test("a folder gone from disk under a folder a double-click opened and read costs a double-click during a whole spine fetch no other fetch", async () => {
    graphServer.view = {
      nodes: [g.dir(""), g.dir("p"), g.dir("p/g"), g.dir("a")],
      edges: [g.edge("", "directory:p", "contains"), g.edge("directory:p", "directory:p/g", "contains"), g.edge("", "directory:a", "contains")],
    };
    graphServer.fs = {
      nodes: [fsg.dir(""), fsg.dir("p"), fsg.dir("p/g"), fsg.file("p/g/z.md"), fsg.file("p/y.md"), fsg.dir("a"), fsg.file("a/x.md")],
      edges: [
        fsg.contains("", "p"), fsg.contains("p", "p/g"), fsg.contains("p/g", "p/g/z.md"), fsg.contains("p", "p/y.md"),
        fsg.contains("", "a"), fsg.contains("a", "a/x.md"),
      ],
    };
    graphServer.tree = "folders";
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    await doubleClick("directory:p");
    await doubleClick("directory:p/g");
    await doubleClick("directory:a");
    await settle(20);
    expect({ p: levelReads("p"), "p/g": levelReads("p/g"), a: levelReads("a") }).toEqual({ p: 1, "p/g": 1, a: 1 });
    // `p/g` leaves the disk and the change says so; it stays open.
    graphServer.fs.nodes = graphServer.fs.nodes.filter((n) => !n.path.startsWith("p/g"));
    graphServer.fs.edges = graphServer.fs.edges.filter((e) => !e.target.startsWith("p/g"));
    await changeNames(["p/g/z.md", "p/g"]);
    await settle(20);
    expect(tab.expanded["p/g"], "the opened set keeps the gone folder").toBe(true);

    const release = await holdWholeFetch();
    try {
      expect(levelReads(""), "the whole fetch is in flight").toBe(2);
      await doubleClick("directory:a");
      await doubleClick("directory:a");
      expect(tab.expanded.a).toBe(true);
      expect(levelReads(""), "the openings start no other fetch").toBe(2);
    } finally {
      release();
    }
    await settle(20);
    expect(levelReads("")).toBe(2);
  });

  /// `p`, `p/c` and `a` in the shared graph; on disk `p` holds `p/f.md` and
  /// `p/c`, which holds `p/c/y.md`, and `a` holds `a/x.md`.
  function serveParentAndChild(): void {
    graphServer.view = {
      nodes: [g.dir(""), g.dir("p"), g.dir("p/c"), g.dir("a")],
      edges: [g.edge("", "directory:p", "contains"), g.edge("directory:p", "directory:p/c", "contains"), g.edge("", "directory:a", "contains")],
    };
    graphServer.fs = {
      nodes: [fsg.dir(""), fsg.dir("p"), fsg.dir("p/c"), fsg.file("p/f.md"), fsg.file("p/c/y.md"), fsg.dir("a"), fsg.file("a/x.md")],
      edges: [
        fsg.contains("", "p"), fsg.contains("p", "p/c"), fsg.contains("p", "p/f.md"), fsg.contains("p/c", "p/c/y.md"),
        fsg.contains("", "a"), fsg.contains("a", "a/x.md"),
      ],
    };
    graphServer.tree = "folders";
  }

  test("an opening during a whole spine fetch begun while a patch read a folder's parent and not yet the folder starts no other fetch, over the listing cap", async () => {
    serveParentAndChild();
    // `p/c` is open under the closed `p`, and `a` is open.
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true, a: true, "p/c": true } }));
    expect(levelReads("a"), "the first fetch reads a").toBe(1);
    // The double-click on `p` asks `p` and `p/c` in one patch; once `p`'s
    // level lands, `p/c`'s read is held, and a whole fetch begins meanwhile.
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => (releaseChild = resolve));
    graphServer.onFsGraph = (request) => {
      if (request.path === "p/c") graphServer.fsGate = childGate;
    };
    let release: (() => void) | null = null;
    try {
      await doubleClick("directory:p");
      expect({ p: levelReads("p"), "p/c": levelReads("p/c") }, "the patch reads p and waits on p/c").toEqual({ p: 1, "p/c": 1 });
      graphServer.onFsGraph = null;
      release = await holdWholeFetch();
      expect(levelReads(""), "the whole fetch is in flight").toBe(2);
      await doubleClick("directory:a");
      await doubleClick("directory:a");
      expect(tab.expanded.a).toBe(true);
      expect(levelReads(""), "the openings start no other fetch").toBe(2);
    } finally {
      graphServer.onFsGraph = null;
      release?.();
      releaseChild();
      graphServer.fsGate = null;
    }
    await settle(20);
    expect({ root: levelReads(""), drawsY: visibleIds().includes("p/c/y.md") }).toEqual({ root: 2, drawsY: true });
  });

  test("a folder whose own read finds it gone after a patch of its parent costs a double-click during a whole spine fetch no other fetch, over the listing cap", async () => {
    serveParentAndChild();
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    await doubleClick("directory:p");
    await doubleClick("directory:p/c");
    await doubleClick("directory:a");
    await settle(20);
    expect({ p: levelReads("p"), "p/c": levelReads("p/c"), a: levelReads("a") }).toEqual({ p: 1, "p/c": 1, a: 1 });
    // A save in `p` patches it while the spine holds `p/c`'s level. `p/c`
    // then leaves the disk, and the first change to say so names only its
    // file: the patch reads `p/c` and finds it gone, while `p`'s level still
    // lists it.
    await changeNames(["p/f.md"]);
    graphServer.fs.nodes = graphServer.fs.nodes.filter((n) => !n.path.startsWith("p/c"));
    graphServer.fs.edges = graphServer.fs.edges.filter((e) => !e.target.startsWith("p/c"));
    await changeNames(["p/c/y.md"]);
    await settle(20);
    expect({ p: levelReads("p"), "p/c": levelReads("p/c") }).toEqual({ p: 2, "p/c": 2 });
    expect(tab.expanded["p/c"], "the opened set keeps the gone folder").toBe(true);

    const release = await holdWholeFetch();
    try {
      expect(levelReads(""), "the whole fetch is in flight").toBe(2);
      await doubleClick("directory:a");
      await doubleClick("directory:a");
      expect(tab.expanded.a).toBe(true);
      expect(levelReads(""), "the openings start no other fetch").toBe(2);
    } finally {
      release();
    }
    await settle(20);
    expect(levelReads("")).toBe(2);
  });

  test("a folder opened under one still being read over the listing cap is read once its parent's level lands", async () => {
    serveFoldersWithoutFiles();
    graphServer.fs.nodes.push(fsg.file("a/b/y.md"));
    graphServer.fs.edges.push(fsg.contains("a/b", "a/b/y.md"));
    graphServer.tree = "folders";
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    let release!: () => void;
    graphServer.fsGate = new Promise<void>((resolve) => (release = resolve));
    try {
      await doubleClick("directory:a");
      expect(levelReads("a"), "a's level is being read").toBe(1);
      await doubleClick("directory:a/b");
      expect({ a: tab.expanded.a, "a/b": tab.expanded["a/b"] }).toEqual({ a: true, "a/b": true });
    } finally {
      graphServer.fsGate = null;
      release();
    }
    await settle(20);
    expect({ a: levelReads("a"), "a/b": levelReads("a/b") }).toEqual({ a: 1, "a/b": 1 });
    expect(filesOfA()).toEqual(["a/b/y.md", "a/x.md"]);
  });

  test("a folder not on disk when its parent's level is read over the listing cap is read once it is there", async () => {
    serveFoldersWithoutFiles();
    graphServer.view = { nodes: [g.dir(""), g.dir("a")], edges: [g.edge("", "directory:a", "contains")] };
    graphServer.fs.nodes = graphServer.fs.nodes.filter((n) => n.path !== "a/b");
    graphServer.fs.edges = graphServer.fs.edges.filter((e) => e.target !== "a/b");
    graphServer.tree = "folders";
    // `a/b` is open under the closed `a`, and not on disk.
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true, "a/b": true } }));
    await doubleClick("directory:a");
    expect(tab.expanded.a).toBe(true);
    expect({ a: levelReads("a"), "a/b": levelReads("a/b") }, "a's level holds no a/b").toEqual({ a: 1, "a/b": 0 });

    // `a/b` is moved into place with its file, and the change names it
    // alone: the patch reads `a` again, which brings its node.
    graphServer.fs.nodes.push(fsg.dir("a/b"), fsg.file("a/b/y.md"));
    graphServer.fs.edges.push(fsg.contains("a", "a/b"), fsg.contains("a/b", "a/b/y.md"));
    graphReloadSignal.paths = ["a/b"];
    graphReloadSignal.nonce += 1;
    await new Promise((r) => setTimeout(r, 400));
    await settle();
    expect({ a: levelReads("a"), "a/b": levelReads("a/b") }).toEqual({ a: 2, "a/b": 0 });

    // The window's graph comes back over the cap, and taking it reads what
    // the opened set lacks.
    graphServer.view = {
      nodes: [g.dir(""), g.dir("a"), g.dir("a/b")],
      edges: [g.edge("", "directory:a", "contains"), g.edge("directory:a", "directory:a/b", "contains")],
    };
    await refreshGraph();
    await settle(20);
    expect({ a: levelReads("a"), "a/b": levelReads("a/b") }).toEqual({ a: 2, "a/b": 1 });
    expect(filesOfA()).toEqual(["a/b/y.md", "a/x.md"]);
  });

  test("a folder kept asked under a parent whose read found it gone is read once a later level of that parent brings it, over the listing cap", async () => {
    graphServer.view = {
      nodes: [g.dir(""), g.dir("p"), g.dir("p/c"), g.dir("a")],
      edges: [g.edge("", "directory:p", "contains"), g.edge("directory:p", "directory:p/c", "contains"), g.edge("", "directory:a", "contains")],
    };
    graphServer.fs = {
      nodes: [fsg.dir(""), fsg.dir("p"), fsg.dir("a"), fsg.file("a/x.md")],
      edges: [fsg.contains("", "p"), fsg.contains("", "a"), fsg.contains("a", "a/x.md")],
    };
    graphServer.tree = "folders";
    // `p/c` is open under the closed `p`, which leaves the disk after the
    // spine listed it, before a change says so.
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true, "p/c": true } }));
    graphServer.fs.nodes = graphServer.fs.nodes.filter((n) => n.path !== "p");
    graphServer.fs.edges = graphServer.fs.edges.filter((e) => e.target !== "p");
    await doubleClick("directory:p");
    await settle(20);
    expect(tab.expanded.p).toBe(true);
    expect({ p: levelReads("p"), "p/c": levelReads("p/c") }, "p's read finds it gone, and p/c is not read under it").toEqual({ p: 1, "p/c": 0 });

    // `p` comes back, then `p/c` is moved into it with its file, and that
    // change names `p/c` alone: the patch reads `p`, which brings its node.
    graphServer.fs.nodes.push(fsg.dir("p"));
    graphServer.fs.edges.push(fsg.contains("", "p"));
    await changeNames(["p"]);
    graphServer.fs.nodes.push(fsg.dir("p/c"), fsg.file("p/c/y.md"));
    graphServer.fs.edges.push(fsg.contains("p", "p/c"), fsg.contains("p/c", "p/c/y.md"));
    await changeNames(["p/c"]);
    await settle(20);
    expect({ p: levelReads("p"), "p/c": levelReads("p/c") }).toEqual({ p: 2, "p/c": 0 });

    // The next opening reads what the opened set lacks.
    await doubleClick("directory:a");
    await settle(20);
    expect({ "p/c": levelReads("p/c"), drawsY: visibleIds().includes("p/c/y.md") }).toEqual({ "p/c": 1, drawsY: true });
  });

  test("an opened folder asked again while its first read waits behind a patch of its parent is read once, over the listing cap", async () => {
    graphServer.view = {
      nodes: [g.dir(""), g.dir("p"), g.dir("p/c"), g.dir("a")],
      edges: [g.edge("", "directory:p", "contains"), g.edge("directory:p", "directory:p/c", "contains"), g.edge("", "directory:a", "contains")],
    };
    graphServer.fs = {
      nodes: [fsg.dir(""), fsg.dir("p"), fsg.dir("p/c"), fsg.file("p/f.md"), fsg.file("p/c/y.md"), fsg.dir("a"), fsg.file("a/x.md")],
      edges: [
        fsg.contains("", "p"), fsg.contains("p", "p/c"), fsg.contains("p", "p/f.md"), fsg.contains("p/c", "p/c/y.md"),
        fsg.contains("", "a"), fsg.contains("a", "a/x.md"),
      ],
    };
    graphServer.tree = "folders";
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true, p: true } }));
    expect({ p: levelReads("p"), "p/c": levelReads("p/c") }, "the first fetch reads p, which brings p/c's node").toEqual({ p: 1, "p/c": 0 });

    // A save in `p` patches it; its read is held while `p/c` opens, so the
    // opening's ask waits behind the patch.
    let releaseParent!: () => void;
    graphServer.fsGate = new Promise<void>((resolve) => (releaseParent = resolve));
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => (releaseChild = resolve));
    try {
      await changeNames(["p/f.md"]);
      expect(levelReads("p"), "the patch reads p").toBe(2);
      await doubleClick("directory:p/c");
      expect(tab.expanded["p/c"]).toBe(true);
      // The patch lands; the ask's read of `p/c` is then held, and an
      // opening asks for what the opened set lacks meanwhile.
      graphServer.onFsGraph = (request) => {
        if (request.path === "p/c") graphServer.fsGate = childGate;
      };
      releaseParent();
      await settle(20);
      expect(levelReads("p/c"), "the ask reads p/c").toBe(1);
      await doubleClick("directory:a");
      expect(tab.expanded.a).toBe(true);
    } finally {
      graphServer.onFsGraph = null;
      graphServer.fsGate = null;
      releaseParent();
      releaseChild();
    }
    await settle(20);
    expect({ "p/c": levelReads("p/c"), a: levelReads("a"), drawsY: visibleIds().includes("p/c/y.md") }).toEqual({
      "p/c": 1,
      a: 1,
      drawsY: true,
    });
  });

  /// Under an answer of the whole tree, `p` holds `p/f.md`, which the shared
  /// graph holds, and `p/e`, whose one entry `p/e/s.md` only the spine
  /// carries (a file the shared graph lacks stands in for a symlink). `p` is
  /// opened after the first fetch, so the spine holds no level of it; `p/e`
  /// is opened during a whole fetch, which brings its node.
  test("a folder opened during a whole spine fetch under an answer of the whole tree is read at the next opening, not at the landing", async () => {
    graphServer.view = {
      nodes: [g.dir(""), g.dir("p"), g.dir("p/e"), g.file("p/f.md"), g.dir("a"), g.file("a/x.md")],
      edges: [
        g.edge("", "directory:p", "contains"),
        g.edge("directory:p", "directory:p/e", "contains"),
        g.edge("directory:p", "p/f.md", "contains"),
        g.edge("", "directory:a", "contains"),
        g.edge("directory:a", "a/x.md", "contains"),
      ],
    };
    graphServer.fs = {
      nodes: [fsg.dir(""), fsg.dir("p"), fsg.dir("p/e"), fsg.file("p/f.md"), fsg.file("p/e/s.md"), fsg.dir("a"), fsg.file("a/x.md")],
      edges: [
        fsg.contains("", "p"),
        fsg.contains("p", "p/e"),
        fsg.contains("p", "p/f.md"),
        fsg.contains("p/e", "p/e/s.md"),
        fsg.contains("", "a"),
        fsg.contains("a", "a/x.md"),
      ],
    };
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    await doubleClick("directory:p");
    expect(tab.expanded.p).toBe(true);
    expect(levelReads("p"), "the whole tree holds p's level").toBe(0);
    const release = await holdWholeFetch();
    let during: { root: number; pe: number };
    try {
      expect(levelReads(""), "the whole fetch is in flight").toBe(2);
      await doubleClick("directory:p/e");
      expect(tab.expanded["p/e"]).toBe(true);
      during = { root: levelReads(""), pe: levelReads("p/e") };
    } finally {
      release();
    }
    await settle(20);
    const landed = { root: levelReads(""), p: levelReads("p"), pe: levelReads("p/e") };
    await doubleClick("directory:a");
    await settle(20);
    expect({ during, landed, next: levelReads("p/e"), drawsS: visibleIds().includes("p/e/s.md") }).toEqual({
      during: { root: 2, pe: 0 },
      landed: { root: 2, p: 1, pe: 0 },
      next: 1,
      drawsS: true,
    });
  });

  test("a folder read, then closed across a whole spine fetch, is read again when it opens again, over the listing cap", async () => {
    serveFoldersWithoutFiles();
    graphServer.tree = "folders";
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    await doubleClick("directory:a");
    await settle(20);
    expect({ a: levelReads("a"), drawsX: visibleIds().includes("a/x.md") }, "the first opening reads a").toEqual({ a: 1, drawsX: true });
    await doubleClick("directory:a");
    expect(tab.expanded.a).toBeUndefined();
    // A change that names no path fetches the spine whole while `a` is
    // closed, so the new spine holds no level of it.
    await changeNames([]);
    await settle(20);
    expect(levelReads(""), "the whole fetch read the root").toBe(2);

    await doubleClick("directory:a");
    await settle(20);
    expect(tab.expanded.a).toBe(true);
    expect({ a: levelReads("a"), drawsX: visibleIds().includes("a/x.md") }).toEqual({ a: 2, drawsX: true });
  });

  test("a folder read, closed, then opened again during a whole spine fetch is read once that fetch lands, over the listing cap", async () => {
    serveFoldersWithoutFiles();
    graphServer.tree = "folders";
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    await doubleClick("directory:a");
    await settle(20);
    expect({ a: levelReads("a"), drawsX: visibleIds().includes("a/x.md") }, "the first opening reads a").toEqual({ a: 1, drawsX: true });
    await doubleClick("directory:a");
    expect(tab.expanded.a).toBeUndefined();

    // The whole fetch takes its list of levels while `a` is closed, and `a`
    // opens again during it.
    const release = await holdWholeFetch();
    try {
      expect(levelReads(""), "the whole fetch is in flight").toBe(2);
      await doubleClick("directory:a");
      expect(tab.expanded.a).toBe(true);
      expect(levelReads(""), "the opening starts no other fetch").toBe(2);
    } finally {
      release();
    }
    await settle(20);
    expect({ root: levelReads(""), a: levelReads("a"), drawsX: visibleIds().includes("a/x.md") }).toEqual({ root: 2, a: 2, drawsX: true });
  });

  test("a whole fetch whose landing starts another leaves a folder opened during it to that one, under an answer over the listing cap", async () => {
    serveWholeTree();
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true } }));
    const release = await holdWholeFetch();
    try {
      expect(levelReads(""), "the whole fetch is in flight").toBe(2);
      await doubleClick("directory:a");
      expect(tab.expanded.a).toBe(true);
      expect(levelReads("a"), "the whole tree holds the level").toBe(0);

      serveFoldersWithoutFiles();
      graphServer.tree = "folders";
      await refreshGraph();
      await settle();
      expect(graphData.tree).toBe("folders");
      // A second change that names no path, which the fetch in flight
      // leaves to a whole fetch of its own once it lands.
      graphReloadSignal.paths = [];
      graphReloadSignal.nonce += 1;
      await new Promise((r) => setTimeout(r, 400));
      await settle();
      expect({ root: levelReads(""), a: levelReads("a") }).toEqual({ root: 2, a: 0 });
    } finally {
      release();
    }
    await settle(20);
    expect({ root: levelReads(""), a: levelReads("a") }, "the next fetch reads `a`, and no third one").toEqual({ root: 3, a: 1 });
    expect(filesOfA()).toEqual(["a/x.md"]);
  });

  /// `p` and `a` are open and read. A save in `p` patches it; while that
  /// read is held `p/c` opens, so its ask waits behind the patch. Once `p`'s
  /// level lands, `p/c`'s own read is held and a whole fetch begins, which
  /// lists `p/c`, since it is drawn.
  test("an opening during a whole spine fetch begun while an opened folder's ask waited behind its parent's change patch starts no other fetch, over the listing cap", async () => {
    serveParentAndChild();
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true, p: true, a: true } }));
    expect({ p: levelReads("p"), "p/c": levelReads("p/c"), a: levelReads("a") }, "the first fetch reads p and a").toEqual({ p: 1, "p/c": 0, a: 1 });
    let releaseParent!: () => void;
    graphServer.fsGate = new Promise<void>((resolve) => (releaseParent = resolve));
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => (releaseChild = resolve));
    let releaseFetch = (): void => {};
    let during = -1;
    try {
      await changeNames(["p/f.md"]);
      expect(levelReads("p"), "the change patch reads p").toBe(2);
      await doubleClick("directory:p/c");
      expect(tab.expanded["p/c"]).toBe(true);
      graphServer.onFsGraph = (request) => {
        if (request.path === "p/c") graphServer.fsGate = childGate;
      };
      releaseParent();
      await settle(20);
      expect(levelReads("p/c"), "the ask reads p/c, and that read is held").toBe(1);
      graphServer.onFsGraph = null;
      releaseFetch = await holdWholeFetch();
      expect(levelReads(""), "the whole fetch is in flight").toBe(2);
      await doubleClick("directory:a");
      await doubleClick("directory:a");
      expect(tab.expanded.a).toBe(true);
      during = levelReads("");
    } finally {
      releaseParent();
      releaseFetch();
      releaseChild();
    }
    await settle(20);
    expect({ during, root: levelReads(""), drawsY: visibleIds().includes("p/c/y.md") }).toEqual({ during: 2, root: 2, drawsY: true });
  });

  /// `b`'s read always fails, by a timeout rather than a 404. The first
  /// opening asks it; that patch's read fails and hands over to a whole
  /// fetch, which fails it again. A change in the root then patches the
  /// root's level, which changes nothing about `b`.
  test("a folder whose read keeps failing costs an opening after a change patch of its parent no whole spine fetch, over the listing cap", async () => {
    graphServer.view = {
      nodes: [g.dir(""), g.dir("a"), g.dir("b")],
      edges: [g.edge("", "directory:a", "contains"), g.edge("", "directory:b", "contains")],
    };
    graphServer.fs = {
      nodes: [fsg.dir(""), fsg.dir("a"), fsg.file("a/x.md"), fsg.dir("b"), fsg.file("b/y.md"), fsg.file("r.md")],
      edges: [fsg.contains("", "a"), fsg.contains("a", "a/x.md"), fsg.contains("", "b"), fsg.contains("b", "b/y.md"), fsg.contains("", "r.md")],
    };
    graphServer.tree = "folders";
    graphServer.fsFail = (path) => (path === "b" ? new Error("request timed out after 10000 ms") : null);
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true, a: true, b: true } }));
    await settle(20);
    await doubleClick("directory:a");
    await doubleClick("directory:a");
    await settle(20);
    expect(tab.expanded.a).toBe(true);
    const first = levelReads("");
    await changeNames(["r.md"]);
    await settle(20);
    const change = levelReads("");
    await doubleClick("directory:a");
    await doubleClick("directory:a");
    await settle(20);
    expect({ first, change: change - first, next: levelReads("") - change }).toEqual({ first: 2, change: 1, next: 0 });
  });

  /// `p/c` is open under the closed `p`, which leaves the disk; a
  /// double-click on `p` finds it gone, so `p/c` stays asked. `p` comes
  /// back, then `p/c` with its file, and the patch of `p` brings `p/c`'s
  /// node and forgets its ask. A whole fetch then begins, which lists `p/c`.
  test("an opening during a whole spine fetch after a parent's level forgot a folder's ask starts no other fetch, over the listing cap", async () => {
    graphServer.view = {
      nodes: [g.dir(""), g.dir("p"), g.dir("p/c"), g.dir("a")],
      edges: [g.edge("", "directory:p", "contains"), g.edge("directory:p", "directory:p/c", "contains"), g.edge("", "directory:a", "contains")],
    };
    graphServer.fs = {
      nodes: [fsg.dir(""), fsg.dir("p"), fsg.dir("a"), fsg.file("a/x.md")],
      edges: [fsg.contains("", "p"), fsg.contains("", "a"), fsg.contains("a", "a/x.md")],
    };
    graphServer.tree = "folders";
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true, "p/c": true, a: true } }));
    graphServer.fs.nodes = graphServer.fs.nodes.filter((n) => n.path !== "p");
    graphServer.fs.edges = graphServer.fs.edges.filter((e) => e.target !== "p");
    await doubleClick("directory:p");
    await settle(20);
    expect({ p: levelReads("p"), "p/c": levelReads("p/c"), a: levelReads("a") }, "p's read finds it gone").toEqual({ p: 1, "p/c": 0, a: 1 });
    graphServer.fs.nodes.push(fsg.dir("p"));
    graphServer.fs.edges.push(fsg.contains("", "p"));
    await changeNames(["p"]);
    graphServer.fs.nodes.push(fsg.dir("p/c"), fsg.file("p/c/y.md"));
    graphServer.fs.edges.push(fsg.contains("p", "p/c"), fsg.contains("p/c", "p/c/y.md"));
    await changeNames(["p/c"]);
    await settle(20);
    expect({ p: levelReads("p"), "p/c": levelReads("p/c") }).toEqual({ p: 2, "p/c": 0 });
    const release = await holdWholeFetch();
    let during = -1;
    try {
      expect(levelReads(""), "the whole fetch is in flight").toBe(3);
      await doubleClick("directory:a");
      await doubleClick("directory:a");
      expect(tab.expanded.a).toBe(true);
      during = levelReads("");
    } finally {
      release();
    }
    await settle(20);
    expect({ during, root: levelReads(""), drawsY: visibleIds().includes("p/c/y.md") }).toEqual({ during: 3, root: 3, drawsY: true });
  });

  /// Under an answer of the whole tree, `s` holds only `s/l.md`, which only
  /// the spine carries, so its opening reads it. `s` is closed, and opens
  /// again during a whole fetch F1 that did not list it, whose landing
  /// forgets its ask. A second whole fetch F2 then begins, which lists `s`.
  test("an opening during a whole spine fetch after a landing forgot a reopened folder's ask starts no other fetch, under an answer of the whole tree", async () => {
    graphServer.view = {
      nodes: [g.dir(""), g.dir("s"), g.dir("a"), g.file("a/x.md")],
      edges: [g.edge("", "directory:s", "contains"), g.edge("", "directory:a", "contains"), g.edge("directory:a", "a/x.md", "contains")],
    };
    graphServer.fs = {
      nodes: [fsg.dir(""), fsg.dir("s"), fsg.file("s/l.md"), fsg.dir("a"), fsg.file("a/x.md")],
      edges: [fsg.contains("", "s"), fsg.contains("s", "s/l.md"), fsg.contains("", "a"), fsg.contains("a", "a/x.md")],
    };
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true, a: true } }));
    await doubleClick("directory:s");
    await settle(20);
    expect({ s: levelReads("s"), drawsL: visibleIds().includes("s/l.md") }, "the opening reads s").toEqual({ s: 1, drawsL: true });
    await doubleClick("directory:s");
    expect(tab.expanded.s).toBeUndefined();
    const releaseF1 = await holdWholeFetch();
    let duringF1 = -1;
    try {
      expect(levelReads(""), "F1 is in flight").toBe(2);
      await doubleClick("directory:s");
      expect(tab.expanded.s).toBe(true);
      duringF1 = levelReads("");
    } finally {
      releaseF1();
    }
    await settle(20);
    const releaseF2 = await holdWholeFetch();
    let startF2 = -1;
    let duringF2 = -1;
    try {
      startF2 = levelReads("");
      await doubleClick("directory:a");
      await doubleClick("directory:a");
      expect(tab.expanded.a).toBe(true);
      duringF2 = levelReads("");
    } finally {
      releaseF2();
    }
    await settle(20);
    expect({ duringF1, startF2, duringF2, root: levelReads(""), drawsL: visibleIds().includes("s/l.md") }).toEqual({
      duringF1: 2,
      startF2: 3,
      duringF2: 3,
      root: 3,
      drawsL: true,
    });
  });

  /// `b`'s read always fails, so the spine never holds its level, and the
  /// whole fetch that the test holds lists it.
  test("an opening during a whole spine fetch with a folder drawn whose read failed starts no other fetch, over the listing cap", async () => {
    graphServer.view = {
      nodes: [g.dir(""), g.dir("a"), g.dir("b")],
      edges: [g.edge("", "directory:a", "contains"), g.edge("", "directory:b", "contains")],
    };
    graphServer.fs = {
      nodes: [fsg.dir(""), fsg.dir("a"), fsg.file("a/x.md"), fsg.dir("b"), fsg.file("b/y.md")],
      edges: [fsg.contains("", "a"), fsg.contains("a", "a/x.md"), fsg.contains("", "b"), fsg.contains("b", "b/y.md")],
    };
    graphServer.tree = "folders";
    graphServer.fsFail = (path) => (path === "b" ? new Error("request timed out after 10000 ms") : null);
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { "": true, a: true, b: true } }));
    await settle(20);
    const release = await holdWholeFetch();
    let start = -1;
    let during = -1;
    try {
      start = levelReads("");
      await doubleClick("directory:a");
      await doubleClick("directory:a");
      expect(tab.expanded.a).toBe(true);
      during = levelReads("");
    } finally {
      release();
    }
    await settle(20);
    expect({ start, during }).toEqual({ start: 2, during: 2 });
  });

  test("the depth reads a double-click on the selected directory", async () => {
    const { tab } = await mountGraphPanel(
      GraphPanel,
      layout,
      graphTab({ expanded: { "": true } }),
    );
    canvas.props!.onSelect(NOTES);
    await settle(2);
    const slider = (await depthRow(tab)).querySelector<HTMLInputElement>("input[type='range']")!;
    expect(slider.value).toBe("0");

    canvas.props!.onSetAsScope();
    await settle();
    expect(slider.value).toBe("1");
  });
});

describe("a graph opened on a directory", () => {
  /// The tab "Graph from here" on notes/ builds: that directory selected, by
  /// its path, and opened.
  const onNotes = (over: Partial<GraphTab> = {}): GraphTab =>
    graphTab({ pendingSelectId: "notes", expanded: openedForPath("notes"), ...over });

  test("opens down to its shallowest file", async () => {
    // Without notes/a.md the shallowest file under notes is two levels down.
    dropNotesA();
    const { tab } = await mountGraphPanel(GraphPanel, layout, onNotes());

    expect(canvas.props?.selectedId).toBe(NOTES);
    expect(tab.expanded["notes/deep"]).toBe(true);
    expect(visibleIds()).toContain(D);
  });

  test("stays one level deep when a file sits right under it", async () => {
    const { tab } = await mountGraphPanel(GraphPanel, layout, onNotes());
    expect(tab.expanded["notes/deep"]).toBeUndefined();
    expect(visibleIds()).toContain(A);
    expect(visibleIds()).not.toContain(D);
  });

  test("leaves the tree of a tab that already showed a selection as it is", async () => {
    // A restored or moved tab carries the selection it had.
    dropNotesA();
    const { tab } = await mountGraphPanel(GraphPanel, layout, onNotes({ selectedNodeId: NOTES }));
    expect(tab.expanded["notes/deep"]).toBeUndefined();
    expect(visibleIds()).not.toContain(D);
  });

  test("opens it down once: a depth lowered afterwards stays", async () => {
    dropNotesA();
    const { tab } = await mountGraphPanel(GraphPanel, layout, onNotes());
    expect(tab.expanded["notes/deep"]).toBe(true);
    const slider = (await depthRow(tab)).querySelector<HTMLInputElement>("input[type='range']")!;

    await slideTo(slider, 1);
    expect(tab.expanded["notes/deep"]).toBeUndefined();
    graphReloadSignal.paths = ["notes/deep/d.md"];
    graphReloadSignal.nonce += 1;
    await new Promise((r) => setTimeout(r, 300));
    await settle();
    expect(tab.expanded["notes/deep"], "a reload does not open it again").toBeUndefined();
  });
});

describe("the tab menu", () => {
  test("is the scope row, the depth slider, the filters, the tab's own rows and the launcher, each group behind a separator", async () => {
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab());
    openTabMenu(tab.id, { left: 10, top: 10, right: 10, bottom: 10 });
    await settle(2);
    const bubble = document.body.querySelector(".tab-menu-bubble")!;
    expect(bubble.parentElement, "portaled to the page body").toBe(document.body);
    const shape = [...bubble.querySelectorAll(".msep, .mbtn")].map((el) => {
      if (el.classList.contains("msep")) return "---";
      if (el.classList.contains("graph-scope-row")) return "scope";
      if (el.classList.contains("depth-row")) return "depth";
      if (el.classList.contains("filter-row")) return "filter";
      return el.querySelector(".mbtn-label")?.textContent?.trim() ?? "";
    });
    const collapsed = shape.filter((row, i) => !(row === "filter" && shape[i - 1] === "filter"));
    expect(collapsed).toEqual([
      "scope", "---", "depth", "---", "filter", "---", "Flip pane", "Close tab", "---", "Command launcher",
    ]);
    closeTabMenu();
  });
});
