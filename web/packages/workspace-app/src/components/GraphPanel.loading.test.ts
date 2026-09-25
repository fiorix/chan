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
// Build-time contract: the indexing cue stops pulsing under prefers-reduced-motion; vitest drops component CSS.
import graphPanelSource from "./GraphPanel.svelte?raw";
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
  return (
    graphServer.graphStreamCalls + graphServer.languageGraphCalls + graphServer.fsGraphCalls.length
  );
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
  test("a scope, depth or mode change does", async () => {
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab());
    for (const change of [
      () => (tab.scopeId = "dir:notes"),
      () => (tab.depth = 2),
      () => (tab.mode = "language"),
    ]) {
      const before = loads();
      change();
      await settle();
      expect(loads(), change.toString()).toBeGreaterThan(before);
    }
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
    await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId: "dir:notes" }));
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
    await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId: "workspace" }));

    const seeds = graphServer.fsGraphCalls.filter((c) => c.depth === 1 && c.path === "");
    expect(seeds.map((c) => c.cursor), "two pages of two").toEqual([undefined, "2"]);
    expect(graphServer.graphStreamCalls).toBe(1);
  });

  test("seeds directories under the semantic ids, the root as the empty id", async () => {
    // src and docs exist only on disk: the semantic graph has no node for them.
    await mountGraphPanel(
      GraphPanel,
      layout,
      graphTab({ scopeId: "workspace", expanded: { "": true } }),
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
    graphServer.view = { nodes: [], edges: [] };
    const { target } = await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId: "tag:#t" }));
    const placeholder = () => target.querySelector(".canvas .placeholder")?.textContent?.trim();

    expect(placeholder()).toBe("data being indexed, hang tight...");
    setIndex("building");
    await settle(2);
    expect(placeholder()).toBe("graph temporarily unavailable while indexing the workspace");
    setIndex("recovering");
    await settle(2);
    expect(placeholder()).toBe("graph unavailable while the workspace recovers");
  });

  test("an empty filesystem graph does not blame the index", async () => {
    graphServer.fs = { nodes: [], edges: [] };
    setIndex("building");
    const { target } = await mountGraphPanel(
      GraphPanel,
      layout,
      graphTab({ scopeId: "file:nowhere.md", mode: "filesystem" }),
    );
    expect(target.querySelector(".canvas .placeholder")?.textContent?.trim()).toBe(
      "no filesystem graph nodes for this scope",
    );
  });

  test("dead-end files stay out of the graph until it is ready", async () => {
    await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId: "file:notes/a.md" }));
    expect(visibleIds()).toContain(GONE);

    setIndex("building");
    await settle(2);
    expect(visibleIds()).not.toContain(GONE);
    expect(canvas.props!.visibleEdges.some((e) => e.target === GONE)).toBe(false);
  });

  test("the graph reloads once when indexing finishes, in the semantic graph only", async () => {
    setIndex("building");
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab());
    const before = graphServer.graphStreamCalls;

    setIndex("idle");
    await settle();
    expect(graphServer.graphStreamCalls).toBe(before + 1);
    setIndex("idle");
    await settle();
    expect(graphServer.graphStreamCalls, "not again without a new build").toBe(before + 1);

    tab.mode = "filesystem";
    await settle();
    const fsBefore = loads();
    setIndex("building");
    await settle(2);
    setIndex("idle");
    await settle();
    expect(loads(), "the filesystem graph does not use the index").toBe(fsBefore);
  });

  test("the indexing cue stops pulsing for a reduced-motion user", () => {
    // Build-time contract: the reduced-motion override for the cue's pulse.
    // vitest drops component CSS, so the stylesheet is read as text.
    const css = graphPanelSource.slice(graphPanelSource.indexOf("<style>"));
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.indexing \{\s*animation: none;/,
    );
  });
});

describe("watching the directories it shows", () => {
  test("subscribes to them, follows what it shows, and lets them go on unmount", async () => {
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId: "dir:notes" }));
    const id = `graph-tab-${tab.id}`;
    const watched = () => Object.keys(fbTreeInstance(id)?.subscribedDirs ?? {}).filter(Boolean).sort();
    expect(watched()).toEqual(["notes"]);

    tab.scopeId = "workspace";
    tab.mode = "filesystem";
    await settle();
    expect(watched(), "the filesystem graph of the workspace shows src and docs too").toEqual([
      "docs",
      "notes",
      "src",
    ]);

    unmountGraphPanels();
    expect(fbTreeInstance(id)).toBeNull();
  });

  test("a change inside the scope reloads it; one outside does not", async () => {
    await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId: "dir:notes" }));
    const change = async (paths: string[]) => {
      graphReloadSignal.paths = paths;
      graphReloadSignal.nonce += 1;
      await settle();
      await new Promise((r) => setTimeout(r, 300));
      await settle();
    };

    const before = graphServer.graphStreamCalls;
    await change(["src/other.rs"]);
    expect(graphServer.graphStreamCalls, "src is not in dir:notes").toBe(before);
    await change(["notes/new.md"]);
    expect(graphServer.graphStreamCalls).toBe(before + 1);
  });
});
