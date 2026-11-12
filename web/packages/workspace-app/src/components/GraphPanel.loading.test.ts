// @vitest-environment jsdom
//
// What a graph tab asks the server for and when, and what it shows while the
// workspace index is not ready. The tab draws the window's shared graph
// (`state/graphData`) over a filesystem spine of its own. GraphPanel is
// mounted over a fixed graph; the assertions count the requests the api stub
// served and read the panel's status bar, placeholder and the node set it
// hands the canvas.

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
import { ApiError } from "../api/errors";
import {
  canvas,
  fsg,
  g,
  GRAPH_PANE,
  graphServer,
  graphTab,
  installGraphDom,
  mountGraphPanel,
  resetGraphServer,
  settle,
  unmountGraphPanels,
  visibleIds,
} from "../__tests__/graphPanel";
import { invalidateGraph, noteGraphChanged, reloadGraph } from "../state/graphData.svelte";
import { trackTimers, type TimerTrack } from "../demo/timers";
import type { IndexStatus } from "../api/types";
import { fbTreeInstance, graphReloadSignal, indexStatus } from "../state/store.svelte";
import {
  activePane,
  graphTabLabel,
  layout,
  restoreLayout,
  type GraphTab,
  type LeafNode,
} from "../state/tabs.svelte";

installGraphDom();

const A = "notes/a.md";
const GONE = "notes/gone.md";
const NOTES = "directory:notes";

function serveGraph(): void {
  graphServer.view = {
    nodes: [
      g.dir(""),
      g.dir("notes"),
      g.file(A),
      g.file(GONE, { missing: true }),
      g.tag("t"),
    ],
    edges: [
      g.edge("", NOTES, "contains"),
      g.edge(NOTES, A, "contains"),
      g.edge(NOTES, GONE, "contains"),
      g.edge(A, "#t", "tag"),
      g.edge(A, GONE, "link"),
    ],
  };
  graphServer.fs = {
    nodes: [fsg.dir(""), fsg.dir("notes"), fsg.dir("src"), fsg.dir("docs"), fsg.file(A)],
    edges: [
      fsg.contains("", "notes"),
      fsg.contains("", "src"),
      fsg.contains("", "docs"),
      fsg.contains("notes", A),
    ],
  };
}

let timers: TimerTrack;

beforeEach(() => {
  timers = trackTimers();
  resetGraphServer();
  invalidateGraph();
  serveGraph();
  indexStatus.value = null;
});

afterEach(() => {
  unmountGraphPanels();
  indexStatus.value = null;
  timers.release();
});

/// Every graph request made so far: the window's stream and the tab's spine.
function loads(): number {
  return graphServer.graphStreamCalls + graphServer.fsGraphCalls.length;
}

function reloadCommand(): void {
  window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.graph.reload" } }));
}

function setIndex(state: IndexStatus["state"] | null): void {
  indexStatus.value = state === null ? null : ({ state } as IndexStatus);
}

describe("app.graph.reload", () => {
  test("reloads the active graph tab once", async () => {
    await mountGraphPanel(GraphPanel, layout, graphTab());
    const before = graphServer.graphStreamCalls;

    reloadCommand();
    await settle();
    expect(graphServer.graphStreamCalls).toBe(before + 1);
  });

  test("leaves a graph tab that is not the active one alone", async () => {
    await mountGraphPanel(GraphPanel, layout, graphTab());
    const pane = layout.nodes[GRAPH_PANE] as LeafNode;
    pane.tabs.push(graphTab({ id: "graph-2" }));
    pane.activeTabId = "graph-2";
    await settle(2);
    const before = graphServer.graphStreamCalls;

    reloadCommand();
    await settle();
    expect(graphServer.graphStreamCalls).toBe(before);
  });

  test("stops listening once the panel unmounts", async () => {
    await mountGraphPanel(GraphPanel, layout, graphTab());
    unmountGraphPanels();
    const before = graphServer.graphStreamCalls;

    reloadCommand();
    await settle();
    expect(graphServer.graphStreamCalls).toBe(before);
  });
});

describe("what reloads the graph", () => {
  test("a selection or a depth change does not: both choose from what is loaded", async () => {
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab());
    // The first load is one spine request and one stream. The inspector a
    // selection opens reads the window's shared graph, the one the tab draws.
    const before = loads();
    expect(before, "the first load").toBe(2);

    canvas.props!.onSelect("#t");
    await settle();
    tab.depth = 2;
    await settle();
    canvas.props!.onSelect("directory:notes");
    await settle();
    expect(loads()).toBe(before);
  });

  test("an inspector, filter or expansion change does not", async () => {
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab());
    const before = loads();

    tab.inspectorOpen = true;
    tab.filters.tag = false;
    tab.expanded = { "": true, notes: true };
    await settle();
    expect(loads()).toBe(before);
  });

  test("a reload keeps the drawn graph until the new one arrives", async () => {
    await mountGraphPanel(GraphPanel, layout, graphTab({ pendingSelectId: "notes" }));
    const drawn = canvas.props!.nodes.length;
    expect(drawn).toBeGreaterThan(0);
    let release!: () => void;
    graphServer.fsGate = new Promise<void>((r) => (release = r));

    reloadCommand();
    await settle();
    expect(canvas.props!.nodes.length, "no blank frame while the reload is in flight").toBe(drawn);
    release();
    await settle();
    expect(canvas.props!.nodes.length).toBe(drawn);
  });

  test("a reload draws the new graph once it has arrived whole, not as it streams", async () => {
    await mountGraphPanel(GraphPanel, layout, graphTab());
    const ids = () => canvas.props!.nodes.map((n) => n.id);
    expect(ids()).toContain("#t");
    // The next answer has one tag for another.
    graphServer.view = {
      nodes: [...graphServer.view.nodes.filter((n) => n.id !== "#t"), g.tag("u")],
      edges: [...graphServer.view.edges.filter((e) => e.target !== "#t"), g.edge(A, "#u", "tag")],
    };
    let release!: () => void;
    graphServer.streamGate = new Promise<void>((r) => (release = r));

    // The window drops its graph and streams it afresh, as it does when the
    // index becomes ready.
    const reload = reloadGraph();
    await settle();
    expect(ids(), "the drawn graph stays while its successor is in flight").toContain("#t");
    release();
    await reload;
    await settle();
    expect(ids()).toContain("#u");
    expect(ids()).not.toContain("#t");
  });
});

describe("the filesystem spine under the semantic graph", () => {
  test("is fetched before the semantic stream and paged to the end", async () => {
    graphServer.fsPageSize = 2;
    await mountGraphPanel(GraphPanel, layout, graphTab());

    const seeds = graphServer.fsGraphCalls.filter((c) => c.depth === 1 && c.path === "");
    expect(seeds.map((c) => c.cursor), "two pages of two").toEqual([undefined, "2"]);
    expect(graphServer.graphStreamCalls).toBe(1);
  });

  test("is drawn alone until the shared graph's first batch", async () => {
    let release!: () => void;
    graphServer.streamGate = new Promise<void>((r) => (release = r));
    const { target } = await mountGraphPanel(GraphPanel, layout, graphTab());

    const ids = () => canvas.props!.nodes.map((n) => n.id).sort();
    expect(ids(), "the tree from disk, one level").toEqual(["", "directory:docs", "directory:notes", "directory:src"]);
    expect(target.querySelector(".canvas .stream-status"), "still loading").not.toBeNull();
    release();
    await settle();
    expect(ids()).toEqual(expect.arrayContaining(["#t", GONE, "directory:src"]));
    expect(target.querySelector(".canvas .stream-status")).toBeNull();
  });

  test("seeds directories under the semantic ids, the root as the empty id", async () => {
    // src and docs exist only on disk: the semantic graph has no node for them.
    await mountGraphPanel(
      GraphPanel,
      layout,
      graphTab({ expanded: { "": true } }),
    );
    const ids = canvas.props!.nodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(["", "directory:src", "directory:docs"]));
    expect(ids).not.toContain("src");
    expect(ids.filter((id) => id === ""), "one root").toHaveLength(1);
    expect(visibleIds()).toEqual(expect.arrayContaining(["directory:src", "directory:docs"]));
  });
});

describe("while the workspace index is not ready", () => {
  test("the status bar says so, and names a recovery as such", async () => {
    const { target } = await mountGraphPanel(GraphPanel, layout, graphTab());
    const cue = () => target.querySelector(".statusbar .indexing")?.textContent;
    expect(cue()).toBeUndefined();

    setIndex("building");
    await settle(2);
    expect(cue()).toBe("indexing…");
    setIndex("recovering");
    await settle(2);
    expect(cue()).toBe("workspace recovering…");
  });

  test("an empty graph explains why", async () => {
    // The graph draws the tree from disk before the index answers, so it is
    // empty only over a workspace with nothing in it.
    graphServer.view = { nodes: [], edges: [] };
    graphServer.fs = { nodes: [], edges: [] };
    const { target } = await mountGraphPanel(GraphPanel, layout, graphTab());
    const placeholder = () => target.querySelector(".canvas .placeholder")?.textContent?.trim();

    expect(placeholder()).toBe("data being indexed, hang tight...");
    setIndex("building");
    await settle(2);
    expect(placeholder()).toBe("graph temporarily unavailable while indexing the workspace");
    setIndex("recovering");
    await settle(2);
    expect(placeholder()).toBe("graph unavailable while the workspace recovers");
  });

  test("dead-end files stay out of the graph until it is ready", async () => {
    await mountGraphPanel(GraphPanel, layout, graphTab({ pendingSelectId: "notes/a.md" }));
    expect(visibleIds()).toContain(GONE);

    setIndex("building");
    await settle(2);
    expect(visibleIds()).not.toContain(GONE);
    expect(canvas.props!.visibleEdges.some((e) => e.target === GONE)).toBe(false);
  });

  test("the tab asks for nothing when indexing finishes, and draws the graph the window reloads", async () => {
    setIndex("building");
    await mountGraphPanel(GraphPanel, layout, graphTab());
    const before = loads();

    setIndex("idle");
    await settle();
    expect(loads(), "the window's index poll reloads the shared graph, not the tab").toBe(before);

    graphServer.view = {
      nodes: [...graphServer.view.nodes, g.tag("late")],
      edges: [...graphServer.view.edges, g.edge(A, "#late", "tag")],
    };
    // What the poll does on the way to idle.
    await reloadGraph();
    await settle();
    expect(graphServer.graphStreamCalls).toBe(2);
    expect(canvas.props!.nodes.map((n) => n.id)).toContain("#late");
  });
});

// While a full rebuild holds the index, the route answers the empty graph
// marked gated, and the window fetches the graph again once the index poll
// reads idle. A tag, a mention or a language is known only to the index, so
// a selection of one waits for that graph; a file or a directory resolves
// from the spine meanwhile.
describe("a selection the index has to answer, while the graph is gated", () => {
  function serveGated(): void {
    graphServer.gated = true;
    graphServer.view = { nodes: [], edges: [] };
  }

  async function indexReady(): Promise<void> {
    graphServer.gated = false;
    serveGraph();
    // What the index poll does on the way to idle.
    await reloadGraph();
    await settle();
  }

  test("an opener's tag waits, and is selected once the index answers", async () => {
    serveGated();
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ pendingSelectId: "#t" }));
    expect(canvas.props!.nodes.map((n) => n.id), "the spine is drawn").toContain(NOTES);
    expect(canvas.props!.selectedId).toBeNull();
    expect(tab.pendingSelectId, "still waiting").toBe("#t");

    await indexReady();
    expect(canvas.props!.selectedId).toBe("#t");
    expect(tab.pendingSelectId).toBeNull();
    expect(visibleIds(), "the note that carries it").toContain(A);
  });

  test("a restored tab titled after its tag has the tag selected once the index answers", async () => {
    serveGated();
    await restoreLayout({ k: "l", t: [{ k: "g", gn: "#t", gnl: "#t", gf: "" }] });
    const restored = activePane().tabs[0] as GraphTab;
    const { tab } = await mountGraphPanel(GraphPanel, layout, restored);
    expect(graphTabLabel(tab)).toBe("path=#t");

    await indexReady();
    expect(canvas.props!.selectedId).toBe("#t");
    expect(tab.selectedNodeId).toBe("#t");
    expect(graphTabLabel(tab)).toBe("path=#t");
  });

  test("a directory resolves from the spine meanwhile", async () => {
    serveGated();
    await mountGraphPanel(GraphPanel, layout, graphTab({ pendingSelectId: "notes" }));
    expect(canvas.props!.selectedId).toBe(NOTES);
  });
});

describe("when the workspace root is gone", () => {
  test("the tab draws nothing and says why, though the window still holds a graph", async () => {
    const { target } = await mountGraphPanel(GraphPanel, layout, graphTab({ pendingSelectId: A }));
    expect(canvas.props!.nodes.length).toBeGreaterThan(0);
    expect(canvas.props!.selectedId).toBe(A);
    const words = "workspace root does not exist: /ws";
    const gone = () => new ApiError(404, words, { error: words, code: "workspace_root_missing" });
    vi.mocked(api.fsGraph).mockRejectedValueOnce(gone());
    vi.mocked(api.graphStream).mockRejectedValueOnce(gone());

    reloadCommand();
    await settle();
    expect(canvas.props!.nodes, "nothing of the graph the index still holds").toHaveLength(0);
    expect(canvas.props!.selectedId).toBeNull();
    expect(target.querySelector(".canvas .placeholder.error")?.textContent).toBe(words);
    expect(target.querySelector(".statusbar .stat")?.textContent?.trim()).toMatch(/^0\/0 nodes/);

    // The root is back: the next reload draws the graph again.
    reloadCommand();
    await settle();
    expect(canvas.props!.nodes.length).toBeGreaterThan(0);
    expect(target.querySelector(".canvas .placeholder.error")).toBeNull();
  });
});

describe("watching the directories it shows", () => {
  test("subscribes to them, follows what it shows, and lets them go on unmount", async () => {
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab());
    const id = `graph-tab-${tab.id}`;
    const watched = () => Object.keys(fbTreeInstance(id)?.subscribedDirs ?? {}).filter(Boolean).sort();
    // Every directory the loaded graph holds a file of, opened or not: a
    // save in any of them changes what a selection can reveal.
    expect(watched()).toEqual(["notes"]);

    unmountGraphPanels();
    expect(fbTreeInstance(id)).toBeNull();
  });

  test("a change anywhere in the workspace costs one stream and one spine request, whatever is selected", async () => {
    await mountGraphPanel(GraphPanel, layout, graphTab({ pendingSelectId: "notes" }));
    graphServer.view = {
      nodes: [...graphServer.view.nodes, g.dir("src"), g.file("src/other.rs")],
      edges: [
        ...graphServer.view.edges,
        g.edge("", "directory:src", "contains"),
        g.edge("directory:src", "src/other.rs", "contains"),
      ],
    };
    // Both reloads are debounced; run every timer a change schedules, however
    // long its delay.
    vi.useFakeTimers();
    try {
      const streams = graphServer.graphStreamCalls;
      const spines = graphServer.fsGraphCalls.length;
      // The store's two cues for a change: the shared graph's quiet window,
      // and the signal the graph tabs take.
      noteGraphChanged(() => true);
      graphReloadSignal.paths = ["src/other.rs"];
      graphReloadSignal.nonce += 1;
      await vi.runAllTimersAsync();
      expect(graphServer.graphStreamCalls - streams, "the window's graph, once").toBe(1);
      expect(graphServer.fsGraphCalls.length - spines, "the tab's spine, once").toBe(1);
      expect(canvas.props!.nodes.map((n) => n.id)).toContain("src/other.rs");
    } finally {
      vi.useRealTimers();
    }
  });
});
