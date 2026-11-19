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
import { invalidateGraph } from "../state/graphData.svelte";
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
    const reads = drawnAtRead.slice(start).filter((read) => /^u\d+$/.test(read.path));
    expect(reads.length, "every opened folder is read, past the first batch").toBe(100);
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
