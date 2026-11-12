// @vitest-environment jsdom
//
// When a graph tab loads and reloads, and what it shows while the workspace
// index is not ready. GraphPanel is mounted over a fixed graph; the assertions
// count the requests the api stub served and read the panel's status bar,
// placeholder and the node set it hands the canvas.

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
import { trackTimers, type TimerTrack } from "../demo/timers";
import type { IndexStatus } from "../api/types";
import { fbTreeInstance, graphReloadSignal, indexStatus } from "../state/store.svelte";
import { layout, type LeafNode } from "../state/tabs.svelte";

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
  serveGraph();
  indexStatus.value = null;
});

afterEach(() => {
  unmountGraphPanels();
  indexStatus.value = null;
  timers.release();
});

/// Every graph request the panel has made so far.
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
    // Each load of the panel fetches the spine once. The inspector a
    // selection opens reads the window's shared graph, a stream of its own.
    const spines = () => graphServer.fsGraphCalls.length;
    const before = spines();
    expect(before, "the first load").toBe(1);

    canvas.props!.onSelect("#t");
    await settle();
    tab.depth = 2;
    await settle();
    canvas.props!.onSelect("directory:notes");
    await settle();
    expect(spines()).toBe(before);
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
});

describe("the filesystem spine under the semantic graph", () => {
  test("is fetched before the semantic stream and paged to the end", async () => {
    graphServer.fsPageSize = 2;
    await mountGraphPanel(GraphPanel, layout, graphTab());

    const seeds = graphServer.fsGraphCalls.filter((c) => c.depth === 1 && c.path === "");
    expect(seeds.map((c) => c.cursor), "two pages of two").toEqual([undefined, "2"]);
    expect(graphServer.graphStreamCalls).toBe(1);
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

  test("the graph reloads once when indexing finishes", async () => {
    setIndex("building");
    await mountGraphPanel(GraphPanel, layout, graphTab());
    const before = graphServer.graphStreamCalls;

    setIndex("idle");
    await settle();
    expect(graphServer.graphStreamCalls).toBe(before + 1);
    setIndex("idle");
    await settle();
    expect(graphServer.graphStreamCalls, "not again without a new build").toBe(before + 1);
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

  test("a change anywhere in the workspace reloads the graph, whatever is selected", async () => {
    await mountGraphPanel(GraphPanel, layout, graphTab({ pendingSelectId: "notes" }));
    // The reload is debounced; run every timer a change schedules, however
    // long its delay.
    vi.useFakeTimers();
    try {
      const before = graphServer.graphStreamCalls;
      graphReloadSignal.paths = ["src/other.rs"];
      graphReloadSignal.nonce += 1;
      await vi.runAllTimersAsync();
      expect(graphServer.graphStreamCalls).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});
