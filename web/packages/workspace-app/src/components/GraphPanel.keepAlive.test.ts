// @vitest-environment jsdom
//
// Graph tabs stay mounted while hidden, and draw one graph between them: the
// window's shared one. A Pane is mounted with two graph tabs over a fixed
// graph and GraphCanvas replaced by a stand-in; the assertions read the
// panels' DOM, the requests made and the props each panel hands its canvas.

import { mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./GraphCanvas.svelte", async () =>
  (await import("../__tests__/graphPanel")).canvasProbeModule(),
);
vi.mock("../api/client", async (importOriginal) =>
  (await import("../__tests__/graphPanel")).graphApiModule(
    await importOriginal<typeof import("../api/client")>(),
  ),
);

import Pane from "./Pane.svelte";
// Build-time contract: a hidden graph tab keeps its size (visibility, not display: none); vitest drops component CSS.
import graphPanelSource from "./GraphPanel.svelte?raw";
import {
  canvas,
  type CanvasProps,
  fsg,
  g,
  GRAPH_PANE,
  graphServer,
  graphTab,
  installGraphDom,
  resetGraphServer,
  settle,
} from "../__tests__/graphPanel";
import { graphData, invalidateGraph, noteGraphChanged, refreshGraph } from "../state/graphData.svelte";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { failOnOwnershipWarnings } from "../__tests__/svelteWarnings";
import { graphReloadSignal } from "../state/store.svelte";
import { closeTabMenu, openTabMenu } from "../state/tabMenu.svelte";
import { layout, reorderTab, type GraphTab, type LeafNode } from "../state/tabs.svelte";

installGraphDom();

let timers: TimerTrack;
const mounted: Array<Record<string, unknown>> = [];

beforeEach(() => {
  timers = trackTimers();
  resetGraphServer();
  invalidateGraph();
  graphServer.view = {
    nodes: [g.dir(""), g.dir("notes"), g.file("notes/a.md")],
    edges: [g.edge("", "directory:notes", "contains"), g.edge("directory:notes", "notes/a.md", "contains")],
  };
});

afterEach(async () => {
  closeTabMenu();
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
  await settle(2);
  timers.release();
});

// A panel in a pane writes no state its pane owns.
failOnOwnershipWarnings();

/// A pane with graph tabs one and two, one active.
async function renderPane(): Promise<{ pane: LeafNode; panels: () => HTMLElement[] }> {
  layout.nodes = {
    [GRAPH_PANE]: {
      kind: "leaf",
      id: GRAPH_PANE,
      tabs: [
        graphTab({ id: "one" }),
        graphTab({ id: "two", pendingSelectId: "notes" }),
      ],
      activeTabId: "one",
    },
  };
  layout.rootId = GRAPH_PANE;
  layout.activePaneId = GRAPH_PANE;
  const pane = layout.nodes[GRAPH_PANE] as LeafNode;
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(Pane, { target, props: { pane } }) as Record<string, unknown>);
  await settle();
  return { pane, panels: () => [...target.querySelectorAll<HTMLElement>(".graph-tab")] };
}

/// A pane with graph tabs one and two, two active with `expanded` open.
async function renderPaneOnTwo(expanded: Record<string, boolean> = { "": true }): Promise<LeafNode> {
  layout.nodes = {
    [GRAPH_PANE]: {
      kind: "leaf",
      id: GRAPH_PANE,
      tabs: [graphTab({ id: "one" }), graphTab({ id: "two", expanded })],
      activeTabId: "two",
    },
  };
  layout.rootId = GRAPH_PANE;
  layout.activePaneId = GRAPH_PANE;
  const pane = layout.nodes[GRAPH_PANE] as LeafNode;
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(Pane, { target, props: { pane } }) as Record<string, unknown>);
  await settle();
  return pane;
}

const levelReads = (path: string): number => graphServer.fsGraphCalls.filter((call) => call.path === path).length;

/// A change that names no path, which fetches a shown tab's spine whole.
async function changeNamingNoPath(): Promise<void> {
  graphReloadSignal.paths = [];
  graphReloadSignal.nonce += 1;
  await new Promise((r) => setTimeout(r, 400));
  await settle();
}

/// `a` holds `a/x.md` and the empty `a/b`, in an answer of the whole tree
/// and on disk.
function serveWholeTree(): void {
  graphServer.view = {
    nodes: [g.dir(""), g.dir("a"), g.dir("a/b"), g.file("a/x.md")],
    edges: [
      g.edge("", "directory:a", "contains"),
      g.edge("directory:a", "directory:a/b", "contains"),
      g.edge("directory:a", "a/x.md", "contains"),
    ],
  };
  graphServer.fs = {
    nodes: [fsg.dir(""), fsg.dir("a"), fsg.dir("a/b"), fsg.file("a/x.md")],
    edges: [fsg.contains("", "a"), fsg.contains("a", "a/b"), fsg.contains("a", "a/x.md")],
  };
}

/// With tab two's whole spine fetch held in flight, `a` is opened there
/// over the answer of the whole tree and an answer over the listing cap is
/// taken. Resolves to the fetch's release.
async function openDuringWholeFetchOverCap(two: CanvasProps, tab: GraphTab): Promise<() => void> {
  let release!: () => void;
  graphServer.fsGate = new Promise<void>((resolve) => (release = resolve));
  const releaseSpine = (): void => {
    graphServer.fsGate = null;
    release();
  };
  await changeNamingNoPath();
  expect(levelReads(""), "the whole fetch is in flight").toBe(2);
  two.onSelect("directory:a");
  await settle(2);
  two.onSetAsScope();
  await settle();
  expect(tab.expanded.a).toBe(true);
  graphServer.view = {
    nodes: [g.dir(""), g.dir("a"), g.dir("a/b")],
    edges: [g.edge("", "directory:a", "contains"), g.edge("directory:a", "directory:a/b", "contains")],
  };
  graphServer.tree = "folders";
  await refreshGraph();
  await settle();
  expect(graphData.tree).toBe("folders");
  expect(levelReads("a"), "taken while the fetch is in flight").toBe(0);
  return releaseSpine;
}

describe("graph tabs in a pane", () => {
  test("stay mounted; only the active one is shown", async () => {
    const { pane, panels } = await renderPane();
    const [one, two] = panels();
    expect(panels()).toHaveLength(2);
    expect(one!.classList.contains("active")).toBe(true);
    expect(one!.getAttribute("aria-hidden")).toBe("false");
    expect(two!.classList.contains("active")).toBe(false);
    expect(two!.getAttribute("aria-hidden")).toBe("true");
    expect(two!.getAttribute("role")).toBe("tabpanel");

    pane.activeTabId = "two";
    await settle();
    expect(panels()[0], "the same element, not a remount").toBe(one);
    expect(two!.classList.contains("active")).toBe(true);
    expect(one!.getAttribute("aria-hidden")).toBe("true");
  });

  test("reordering after a switch moves each graph panel with its tab", async () => {
    const { pane, panels } = await renderPane();
    const [one, two] = panels();
    expect(panels()).toHaveLength(2);

    pane.activeTabId = "two";
    await settle();
    expect(panels()[0], "the first panel survives the switch").toBe(one);

    reorderTab(GRAPH_PANE, "one", 1);
    await settle();
    expect(pane.tabs.map((tab) => tab.id)).toEqual(["two", "one"]);
    expect(panels()[0], "the second tab brings its panel forward").toBe(two);
    expect(panels()[1], "the first tab keeps its panel after moving").toBe(one);
  });

  test("a hidden tab asks for its spine when first shown, not before, and for no second graph", async () => {
    const { pane } = await renderPane();
    const spines = () => graphServer.fsGraphCalls.length;
    expect(graphServer.graphStreamCalls, "the window's graph, asked for once").toBe(1);
    expect(spines(), "only the shown tab's spine").toBe(1);
    expect(canvas.all[1]!.nodes, "the hidden tab draws nothing yet").toHaveLength(0);

    pane.activeTabId = "two";
    await settle();
    expect(graphServer.graphStreamCalls, "the second tab draws the graph the window has").toBe(1);
    expect(spines()).toBe(2);

    pane.activeTabId = "one";
    await settle();
    expect(graphServer.graphStreamCalls).toBe(1);
    expect(spines(), "coming back needs no reload").toBe(2);
  });

  test("two tabs draw one copy of the graph", async () => {
    // A spine that holds nothing the graph lacks adds nothing of its own.
    graphServer.fs = {
      nodes: [fsg.dir(""), fsg.dir("notes")],
      edges: [fsg.contains("", "notes")],
    };
    const { pane } = await renderPane();
    pane.activeTabId = "two";
    await settle();
    const [one, two] = canvas.all;

    expect(one!.nodes.map((n) => n.id)).toEqual(["", "directory:notes", "notes/a.md"]);
    expect(two!.nodes, "the same array of the same nodes").toBe(one!.nodes);
    expect(two!.edges).toBe(one!.edges);
  });

  test("a tab whose spine holds more draws it over the same shared nodes", async () => {
    // docs/ is on disk and not in the graph the index answered.
    graphServer.fs = {
      nodes: [fsg.dir(""), fsg.dir("notes"), fsg.dir("docs")],
      edges: [fsg.contains("", "notes"), fsg.contains("", "docs")],
    };
    const { pane } = await renderPane();
    pane.activeTabId = "two";
    await settle();
    const [one, two] = canvas.all;

    expect(two!.nodes.map((n) => n.id)).toEqual(["", "directory:notes", "notes/a.md", "directory:docs"]);
    for (const id of ["", "directory:notes", "notes/a.md"]) {
      const find = (c: typeof one) => c!.nodes.find((n) => n.id === id);
      expect(find(two), `${id || "the root"} is one object in both tabs`).toBe(find(one));
    }
  });

  test("an edit reloads the graph once for the window; a hidden tab takes it when shown", async () => {
    const { pane } = await renderPane();
    pane.activeTabId = "two";
    await settle();
    pane.activeTabId = "one";
    await settle();
    const [one, two] = canvas.all;
    const streams = graphServer.graphStreamCalls;
    const spines = graphServer.fsGraphCalls.length;
    const ids = (c: typeof one) => c!.nodes.map((n) => n.id);

    // A file at the root, whose level every tab's spine holds.
    graphServer.view = {
      nodes: [...graphServer.view.nodes, g.file("new.md")],
      edges: [...graphServer.view.edges, g.edge("", "new.md", "contains")],
    };
    // The store's two cues for a change: the shared graph's quiet window,
    // and the signal the graph tabs take.
    noteGraphChanged(() => true);
    graphReloadSignal.paths = ["new.md"];
    graphReloadSignal.nonce += 1;
    await settle();
    await new Promise((r) => setTimeout(r, 300));
    await settle();
    expect(graphServer.graphStreamCalls - streams, "one stream, whatever the tabs").toBe(1);
    expect(graphServer.fsGraphCalls.length - spines, "the shown tab's spine; the hidden one waits").toBe(1);
    expect(ids(one)).toContain("new.md");
    expect(ids(two), "the hidden tab keeps what it drew").not.toContain("new.md");

    pane.activeTabId = "two";
    await settle();
    expect(graphServer.graphStreamCalls - streams, "showing it asks for no graph").toBe(1);
    expect(graphServer.fsGraphCalls.length - spines, "and for its own spine").toBe(2);
    expect(graphServer.fsGraphCalls.at(-1), "the level the change touched").toMatchObject({ path: "", depth: 1 });
    expect(ids(two)).toContain("new.md");
    expect(two!.nodes, "the window's one copy again").toBe(one!.nodes);
  });

  test("a tab hidden before its change's burst ends takes the change when shown", async () => {
    const { pane } = await renderPane();
    const [one] = canvas.all;
    const ids = () => one!.nodes.map((n) => n.id);
    graphServer.fs = { nodes: [fsg.dir(""), fsg.file("new.md")], edges: [fsg.contains("", "new.md")] };
    graphServer.view = { nodes: [g.dir("")], edges: [] };
    noteGraphChanged(() => true);
    graphReloadSignal.paths = ["new.md"];
    graphReloadSignal.nonce += 1;
    await settle(2);

    // Switched away inside the tab's 250 ms wait for the burst to end.
    pane.activeTabId = "two";
    await settle();
    await new Promise((r) => setTimeout(r, 300));
    await settle();
    const spines = graphServer.fsGraphCalls.length;
    expect(ids(), "a hidden tab reads nothing").not.toContain("new.md");

    pane.activeTabId = "one";
    await settle();
    expect(graphServer.fsGraphCalls.slice(spines), "the level the change touched").toEqual([
      { path: "", depth: 1, cursor: undefined },
    ]);
    expect(ids()).toContain("new.md");
  });

  test("a tab hidden while its first spine is read takes a change made meanwhile when shown", async () => {
    let release!: () => void;
    graphServer.fsGate = new Promise<void>((r) => (release = r));
    const { pane } = await renderPane();
    const [one] = canvas.all;
    graphServer.fs = { nodes: [fsg.dir(""), fsg.file("new.md")], edges: [fsg.contains("", "new.md")] };
    graphReloadSignal.paths = ["new.md"];
    graphReloadSignal.nonce += 1;
    await settle();
    await new Promise((r) => setTimeout(r, 300));
    // Hidden before its read lands; the tab shown instead reads its own.
    pane.activeTabId = "two";
    await settle();
    expect(graphServer.fsGraphCalls.map((c) => c.path), "one read each, both held").toEqual(["", ""]);
    release();
    await settle();
    await new Promise((r) => setTimeout(r, 300));
    await settle();
    expect(graphServer.fsGraphCalls.map((c) => c.path), "the hidden tab reads nothing more").toEqual(["", ""]);

    pane.activeTabId = "one";
    await settle();
    expect(graphServer.fsGraphCalls.map((c) => c.path), "shown, it takes the change").toEqual(["", "", ""]);
    expect(one!.nodes.map((n) => n.id)).toContain("new.md");
  });

  test("a hidden tab lets go of the graph once the window's has moved on, and keeps what it draws", async () => {
    // Tab two has the root's level drawn and `notes` selected; `notes` is
    // closed, so what it draws leaves out the files below it.
    graphServer.view = {
      nodes: [...graphServer.view.nodes, g.file("notes/b.md"), g.tag("t")],
      edges: [
        ...graphServer.view.edges,
        g.edge("directory:notes", "notes/b.md", "contains"),
        g.edge("notes/a.md", "#t", "tag"),
      ],
    };
    const { pane } = await renderPane();
    pane.activeTabId = "two";
    await settle();
    pane.activeTabId = "one";
    await settle();
    const [one, two] = canvas.all;
    const first = two!.nodes;
    const drawn = [...two!.visibleNodeIds].sort();
    expect(first, "hidden under the graph it took: the window's own arrays").toBe(one!.nodes);
    expect(drawn).toEqual(["", "directory:notes"]);

    graphServer.view = {
      nodes: [...graphServer.view.nodes, g.file("notes/new.md")],
      edges: [...graphServer.view.edges, g.edge("directory:notes", "notes/new.md", "contains")],
    };
    noteGraphChanged(() => true);
    await new Promise((r) => setTimeout(r, 300));
    await settle();
    expect(one!.nodes.map((n) => n.id)).toContain("notes/new.md");
    expect(two!.nodes, "the view it took is let go").not.toBe(first);
    expect(two!.nodes.map((n) => n.id), "the part it draws from, and no more").toEqual(["", "directory:notes"]);
    expect([...two!.visibleNodeIds].sort(), "and it draws what it drew").toEqual(drawn);

    pane.activeTabId = "two";
    await settle();
    expect(two!.nodes, "shown again, it draws the window's graph").toBe(one!.nodes);
    expect([...two!.visibleNodeIds].sort()).toEqual(drawn);
  });

  test("a double-click in a tab shown again over its kept part reads a level an answer over the listing cap leaves out", async () => {
    // Over the cap: every folder, and of the files the note and the file it
    // links to; `a/x.md` is on disk only.
    graphServer.view = {
      nodes: [g.dir(""), g.dir("a"), g.dir("a/b"), g.dir("notes"), g.file("notes/n.md"), g.file("a/b/c.md")],
      edges: [
        g.edge("", "directory:a", "contains"),
        g.edge("directory:a", "directory:a/b", "contains"),
        g.edge("directory:a/b", "a/b/c.md", "contains"),
        g.edge("", "directory:notes", "contains"),
        g.edge("directory:notes", "notes/n.md", "contains"),
        g.edge("notes/n.md", "a/b/c.md", "link"),
      ],
    };
    graphServer.fs = {
      nodes: [fsg.dir(""), fsg.dir("a"), fsg.dir("a/b"), fsg.dir("notes"), fsg.file("a/x.md"), fsg.file("a/b/c.md"), fsg.file("notes/n.md")],
      edges: [
        fsg.contains("", "a"),
        fsg.contains("a", "a/b"),
        fsg.contains("a", "a/x.md"),
        fsg.contains("a/b", "a/b/c.md"),
        fsg.contains("", "notes"),
        fsg.contains("notes", "notes/n.md"),
      ],
    };
    graphServer.tree = "folders";
    layout.nodes = {
      [GRAPH_PANE]: {
        kind: "leaf",
        id: GRAPH_PANE,
        tabs: [graphTab({ id: "one" }), graphTab({ id: "two", expanded: { "": true, notes: true } })],
        activeTabId: "two",
      },
    };
    layout.rootId = GRAPH_PANE;
    layout.activePaneId = GRAPH_PANE;
    const pane = layout.nodes[GRAPH_PANE] as LeafNode;
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(Pane, { target, props: { pane } }) as Record<string, unknown>);
    await settle();
    const [, two] = canvas.all;
    const tab = pane.tabs[1] as GraphTab;
    // The note's link shows `a/b` and its file under the closed `a`.
    two!.onSelect("notes/n.md");
    await settle(2);
    expect([...two!.visibleNodeIds]).toEqual(expect.arrayContaining(["directory:a", "directory:a/b", "a/b/c.md"]));

    // Hidden, then the window's graph is dropped and fetched again by the
    // shown tab, held before its first event.
    pane.activeTabId = "one";
    await settle();
    let release!: () => void;
    graphServer.streamGate = new Promise<void>((resolve) => (release = resolve));
    invalidateGraph();
    await settle();
    expect(graphServer.graphStreamCalls).toBe(2);

    pane.activeTabId = "two";
    await settle();
    expect(two!.nodes.map((n) => n.id), "shown again over the part it kept").toContain("directory:a/b");
    const reads = (path: string) => graphServer.fsGraphCalls.filter((call) => call.path === path).length;
    two!.onSelect("directory:a");
    await settle(2);
    two!.onSetAsScope();
    await settle();
    expect(tab.expanded.a).toBe(true);
    expect(reads("a"), "the kept part's mark decides").toBe(1);

    release();
    await settle();
    expect(reads("a")).toBe(1);
    expect([...two!.visibleNodeIds]).toContain("a/x.md");
  });

  test("a whole spine fetch that lands while its tab is hidden reads a folder opened during it once the tab is shown, not before", async () => {
    // An answer of the whole tree: `a` holds `a/x.md` and the empty `a/b`.
    graphServer.view = {
      nodes: [g.dir(""), g.dir("a"), g.dir("a/b"), g.file("a/x.md")],
      edges: [
        g.edge("", "directory:a", "contains"),
        g.edge("directory:a", "directory:a/b", "contains"),
        g.edge("directory:a", "a/x.md", "contains"),
      ],
    };
    graphServer.fs = {
      nodes: [fsg.dir(""), fsg.dir("a"), fsg.dir("a/b"), fsg.file("a/x.md")],
      edges: [fsg.contains("", "a"), fsg.contains("a", "a/b"), fsg.contains("a", "a/x.md")],
    };
    const pane = await renderPaneOnTwo();
    const [, two] = canvas.all;
    const tab = pane.tabs[1] as GraphTab;
    let release!: () => void;
    graphServer.fsGate = new Promise<void>((resolve) => (release = resolve));
    try {
      // A change that names no path fetches the spine whole, held at the
      // root, its list of levels taken before `a` opens.
      graphReloadSignal.paths = [];
      graphReloadSignal.nonce += 1;
      await new Promise((r) => setTimeout(r, 400));
      await settle();
      expect(levelReads(""), "the whole fetch is in flight").toBe(2);
      two!.onSelect("directory:a");
      await settle(2);
      two!.onSetAsScope();
      await settle();
      expect(tab.expanded.a).toBe(true);
      expect(levelReads("a"), "the whole tree holds the level").toBe(0);

      graphServer.view = {
        nodes: [g.dir(""), g.dir("a"), g.dir("a/b")],
        edges: [g.edge("", "directory:a", "contains"), g.edge("directory:a", "directory:a/b", "contains")],
      };
      graphServer.tree = "folders";
      await refreshGraph();
      await settle();
      expect(graphData.tree).toBe("folders");
      expect(levelReads("a"), "taken while the fetch is in flight").toBe(0);

      pane.activeTabId = "one";
      await settle();
    } finally {
      graphServer.fsGate = null;
      release();
    }
    await settle(20);
    const hidden = levelReads("a");

    pane.activeTabId = "two";
    await settle(20);
    expect({ hidden, shown: levelReads("a"), drawsFile: [...two!.visibleNodeIds].includes("a/x.md") }).toEqual({
      hidden: 0,
      shown: 1,
      drawsFile: true,
    });
  });

  test("a tab shown again with a whole fetch to take reads the folders a hidden landing left once, in that fetch", async () => {
    serveWholeTree();
    const pane = await renderPaneOnTwo();
    const [, two] = canvas.all;
    const releaseSpine = await openDuringWholeFetchOverCap(two!, pane.tabs[1] as GraphTab);
    pane.activeTabId = "one";
    await settle();
    releaseSpine();
    await settle(20);
    expect(levelReads("a"), "nothing read while hidden").toBe(0);

    // A change that names no path while hidden: shown, the tab fetches its
    // spine whole, which reads `a`.
    await changeNamingNoPath();
    pane.activeTabId = "two";
    await settle(20);
    expect(levelReads("a"), "read once, by that fetch").toBe(1);
    expect([...two!.visibleNodeIds]).toContain("a/x.md");
  });

  test("a tab shown again after a hidden landing leaves a folder whose read failed to its retry", async () => {
    // Over the listing cap: the folders, and none of their files.
    graphServer.view = { nodes: [g.dir(""), g.dir("bad")], edges: [g.edge("", "directory:bad", "contains")] };
    graphServer.fs = { nodes: [fsg.dir(""), fsg.dir("bad"), fsg.file("bad/z.md")], edges: [fsg.contains("", "bad"), fsg.contains("bad", "bad/z.md")] };
    graphServer.tree = "folders";
    graphServer.fsFail = (path) => (path === "bad" ? new TypeError("Failed to fetch") : null);
    const pane = await renderPaneOnTwo({ "": true, bad: true });
    await settle(20);
    expect(levelReads("bad"), "its read and one retry").toBe(2);

    let release!: () => void;
    graphServer.fsGate = new Promise<void>((resolve) => (release = resolve));
    try {
      await changeNamingNoPath();
      pane.activeTabId = "one";
      await settle();
    } finally {
      graphServer.fsGate = null;
      release();
    }
    await settle(20);
    expect(levelReads("bad"), "the whole fetch's read, which fails while hidden").toBe(3);

    pane.activeTabId = "two";
    await settle(20);
    expect(levelReads("bad"), "shown, only its retry reads it").toBe(4);
  });

  test("a whole fetch that lands in a tab shown over its kept part reads a folder opened during it by that part's mark", async () => {
    serveWholeTree();
    const pane = await renderPaneOnTwo();
    const [, two] = canvas.all;
    const releaseSpine = await openDuringWholeFetchOverCap(two!, pane.tabs[1] as GraphTab);
    let releaseStream!: () => void;
    try {
      // Hidden, then the window's graph is dropped and fetched again by the
      // shown tab, held before its first event: tab two keeps its part.
      pane.activeTabId = "one";
      await settle();
      graphServer.streamGate = new Promise<void>((resolve) => (releaseStream = resolve));
      invalidateGraph();
      await settle();
      pane.activeTabId = "two";
      await settle();
      expect(graphData.partial, "the window's graph is still being fetched").toBe(true);

      releaseSpine();
      await settle(20);
      expect(levelReads("a"), "the kept part's mark decides").toBe(1);
    } finally {
      releaseSpine();
      releaseStream?.();
    }
    await settle(20);
    expect(levelReads("a")).toBe(1);
    expect([...two!.visibleNodeIds], "drawn once the window's graph is taken").toContain("a/x.md");
  });

  test("a canvas opens the first time its tab is shown and pauses while hidden", async () => {
    const { pane } = await renderPane();
    const [one, two] = canvas.all;
    expect(one!.open).toBe(true);
    expect(one!.paused).toBe(false);
    expect(two!.open, "never shown yet").toBe(false);
    expect(two!.paused).toBe(true);

    pane.activeTabId = "two";
    await settle();
    pane.activeTabId = "one";
    await settle();
    expect(two!.open, "stays open once shown").toBe(true);
    expect(two!.paused).toBe(true);
  });

  test("Close tab in a tab's menu closes that tab, not the active one", async () => {
    const { pane } = await renderPane();
    openTabMenu("two", { left: 10, top: 10, right: 10, bottom: 10 });
    await settle(2);

    const close = [...document.body.querySelectorAll<HTMLButtonElement>(".tab-menu-bubble button.mbtn")].find(
      (b) => b.querySelector(".mbtn-label")?.textContent === "Close tab",
    );
    close!.click();
    await settle();
    expect(pane.tabs.map((t) => t.id)).toEqual(["one"]);
  });

  test("hide a graph without dropping its layout", () => {
    // Build-time contract: a hidden graph keeps its size (visibility, not
    // display: none) so its canvas does not re-fit on every tab switch.
    // vitest drops component CSS, so the stylesheet is read as text.
    const css = graphPanelSource.slice(graphPanelSource.indexOf("<style>"));
    const rule = (selector: string) => css.slice(css.indexOf(`\n  ${selector} {`), css.indexOf("}", css.indexOf(`\n  ${selector} {`)));
    expect(rule(".graph-tab")).toContain("visibility: hidden;");
    expect(rule(".graph-tab")).toContain("position: absolute;");
    expect(rule(".graph-tab")).not.toContain("display: none");
    expect(rule(".graph-tab.active")).toContain("visibility: visible;");
  });
});
