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
import { openedForPath } from "../graph/selectionView";
import { draftClientPath } from "../api/fileIdentity";
import { trackTimers, type TimerTrack } from "../demo/timers";
import type { FsGraphNode, IndexStatus } from "../api/types";
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

  test("reads the root's level and each opened directory's, parents first, and nothing else", async () => {
    // Two branches, one opened three levels down; a sibling at each level
    // the tab does not open.
    graphServer.view = { nodes: [], edges: [] };
    const dirs = ["a", "a/b", "a/b/c", "a/side", "z", "z/y"];
    graphServer.fs = {
      nodes: [fsg.dir(""), ...dirs.map(fsg.dir), ...dirs.map((d) => fsg.file(`${d}/f.md`))],
      edges: [
        ...dirs.map((d) => fsg.contains(d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "", d)),
        ...dirs.map((d) => fsg.contains(d, `${d}/f.md`)),
      ],
    };
    await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { ...openedForPath("a/b/c"), "z/y": true } }));

    expect(graphServer.fsGraphCalls).toEqual([
      { path: "", depth: 1, cursor: undefined },
      { path: "a", depth: 1, cursor: undefined },
      { path: "a/b", depth: 1, cursor: undefined },
      { path: "a/b/c", depth: 1, cursor: undefined },
    ]);
    expect(visibleIds(), "the opened tree").toEqual(
      expect.arrayContaining(["a/f.md", "a/b/f.md", "a/b/c/f.md", "directory:a/side", "directory:z"]),
    );
    expect(visibleIds(), "z/ is closed, so z/y is not drawn and not read").not.toContain("directory:z/y");
  });

  test("a change made while the first spine is read is patched once it lands", async () => {
    let release!: () => void;
    graphServer.fsGate = new Promise<void>((r) => (release = r));
    await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: openedForPath("notes") }));
    expect(graphServer.fsGraphCalls.map((c) => c.path), "the first reads are held").toEqual(["", "notes"]);

    graphServer.fs = {
      nodes: [...graphServer.fs.nodes, fsg.file("notes/late.md")],
      edges: [...graphServer.fs.edges, fsg.contains("notes", "notes/late.md")],
    };
    vi.useFakeTimers();
    try {
      graphReloadSignal.paths = ["notes/late.md"];
      graphReloadSignal.nonce += 1;
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
    release();
    await settle();
    expect(graphServer.fsGraphCalls.map((c) => c.path), "read once, then the change's directory").toEqual([
      "",
      "notes",
      "notes",
    ]);
    expect(canvas.props!.nodes.map((n) => n.id)).toContain("notes/late.md");
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

  test("a change costs one stream, and the spine reads again only the directory it touched", async () => {
    await mountGraphPanel(GraphPanel, layout, graphTab({ pendingSelectId: "notes", expanded: openedForPath("notes") }));
    graphServer.view = {
      nodes: [...graphServer.view.nodes, g.file("notes/other.md")],
      edges: [...graphServer.view.edges, g.edge(NOTES, "notes/other.md", "contains")],
    };
    graphServer.fs = {
      nodes: [...graphServer.fs.nodes, fsg.file("notes/other.md")],
      edges: [...graphServer.fs.edges, fsg.contains("notes", "notes/other.md")],
    };
    const { streams, spines } = await change(["notes/other.md"]);
    expect(streams, "the window's graph, once").toBe(1);
    expect(spines, "notes/, one level").toEqual([{ path: "notes", depth: 1, cursor: undefined }]);
    expect(canvas.props!.nodes.map((n) => n.id)).toContain("notes/other.md");
  });

  test("a change below a directory the spine does not hold reads none of it", async () => {
    await mountGraphPanel(GraphPanel, layout, graphTab());
    graphServer.view = {
      nodes: [...graphServer.view.nodes, g.dir("src"), g.file("src/other.rs")],
      edges: [
        ...graphServer.view.edges,
        g.edge("", "directory:src", "contains"),
        g.edge("directory:src", "src/other.rs", "contains"),
      ],
    };
    const { streams, spines } = await change(["src/other.rs"]);
    expect(streams).toBe(1);
    expect(spines, "src/ is closed and its files come with the window's graph").toEqual([]);
    expect(canvas.props!.nodes.map((n) => n.id)).toContain("src/other.rs");
  });

  test("a save six levels down reads that directory again, not the tree", async () => {
    // A tree with siblings at every level, and the directory six levels down
    // opened with every directory above it.
    const DIR = "a/b/c/d/e/f";
    const dirs = DIR.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"));
    const siblings = dirs.map((d) => `${d}-sibling`);
    graphServer.view = { nodes: [], edges: [] };
    graphServer.fs = {
      nodes: [
        fsg.dir(""),
        ...[...dirs, ...siblings].map(fsg.dir),
        ...[...dirs, ...siblings].map((d) => fsg.file(`${d}/file.md`)),
      ],
      edges: [
        ...[...dirs, ...siblings].map((d) => fsg.contains(d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "", d)),
        ...[...dirs, ...siblings].map((d) => fsg.contains(d, `${d}/file.md`)),
      ],
    };
    graphServer.fsPageSize = 4;
    await mountGraphPanel(GraphPanel, layout, graphTab({ pendingSelectId: DIR, expanded: openedForPath(DIR) }));
    expect(visibleIds()).toContain(`${DIR}/file.md`);

    graphServer.fs = {
      nodes: [...graphServer.fs.nodes, fsg.file(`${DIR}/saved.md`)],
      edges: [...graphServer.fs.edges, fsg.contains(DIR, `${DIR}/saved.md`)],
    };
    const { spines } = await change([`${DIR}/saved.md`]);
    expect(spines, "one level of the directory saved in").toEqual([{ path: DIR, depth: 1, cursor: undefined }]);
    expect(visibleIds()).toContain(`${DIR}/saved.md`);
    expect(visibleIds(), "what it held elsewhere stays").toContain("a/file.md");
  });

  test("a file deleted from an opened directory leaves the graph, and a directory takes what was below it", async () => {
    graphServer.view = { nodes: [], edges: [] };
    graphServer.fs = {
      nodes: [
        fsg.dir(""),
        fsg.dir("notes"),
        fsg.file(A),
        fsg.file("notes/old.md"),
        fsg.dir("notes/sub"),
        fsg.file("notes/sub/s.md"),
      ],
      edges: [
        fsg.contains("", "notes"),
        fsg.contains("notes", A),
        fsg.contains("notes", "notes/old.md"),
        fsg.contains("notes", "notes/sub"),
        fsg.contains("notes/sub", "notes/sub/s.md"),
      ],
    };
    await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: openedForPath("notes/sub") }));
    expect(visibleIds()).toEqual(expect.arrayContaining([A, "notes/old.md", "directory:notes/sub", "notes/sub/s.md"]));

    graphServer.fs = {
      nodes: [fsg.dir(""), fsg.dir("notes"), fsg.file(A)],
      edges: [fsg.contains("", "notes"), fsg.contains("notes", A)],
    };
    const { spines } = await change(["notes/old.md", "notes/sub"]);
    expect(spines.map((c) => c.path)).toEqual(["notes"]);
    const ids = canvas.props!.nodes.map((n) => n.id);
    expect(ids).toContain(A);
    expect(ids).not.toContain("notes/old.md");
    expect(ids).not.toContain("directory:notes/sub");
    expect(ids, "under the directory that went").not.toContain("notes/sub/s.md");
  });

  test("git's own files and a new draft's path read nothing of the spine", async () => {
    await mountGraphPanel(GraphPanel, layout, graphTab({ pendingSelectId: "notes", expanded: openedForPath("notes") }));
    const draft = draftClientPath({ path: "untitled/draft.md", draft_id: "draft-1" });
    const { spines } = await change([".git/index", ".git/HEAD", ".hg/dirstate", ".chan/workspace.toml", draft]);
    expect(spines).toEqual([]);
    expect(canvas.props!.nodes.map((n) => n.id)).not.toContain("directory:.git");
  });

  test("a directory the spine does not hold is not read, unless the same change brings it", async () => {
    graphServer.fs = {
      nodes: [...graphServer.fs.nodes, fsg.dir("notes/deep"), fsg.dir("notes/fresh"), fsg.file("notes/fresh/x.md")],
      edges: [
        ...graphServer.fs.edges,
        fsg.contains("notes", "notes/deep"),
        fsg.contains("notes", "notes/fresh"),
        fsg.contains("notes/fresh", "notes/fresh/x.md"),
      ],
    };
    // notes/fresh is opened, but it was not there when the tab read the tree.
    graphServer.fs.nodes = graphServer.fs.nodes.filter((n) => !n.path.startsWith("notes/fresh"));
    await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { ...openedForPath("notes"), "notes/fresh": true } }));
    graphServer.fs = {
      nodes: [...graphServer.fs.nodes, fsg.dir("notes/fresh"), fsg.file("notes/fresh/x.md")],
      edges: graphServer.fs.edges,
    };
    const { spines } = await change(["notes/fresh", "notes/fresh/x.md", "notes/nowhere/y.md"]);
    expect(spines.map((c) => c.path), "notes/nowhere is no directory the spine holds").toEqual(["notes", "notes/fresh"]);
    expect(visibleIds()).toContain("notes/fresh/x.md");
  });

  test("a directory gone from disk takes what the spine held below it", async () => {
    graphServer.view = { nodes: [], edges: [] };
    graphServer.fs = {
      nodes: [fsg.dir(""), fsg.dir("notes"), fsg.dir("notes/sub"), fsg.file("notes/sub/s.md")],
      edges: [fsg.contains("", "notes"), fsg.contains("notes", "notes/sub"), fsg.contains("notes/sub", "notes/sub/s.md")],
    };
    await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: openedForPath("notes/sub") }));
    expect(canvas.props!.nodes.map((n) => n.id)).toContain("notes/sub/s.md");

    // The change names the file alone: its directory answers 404.
    graphServer.fs = { nodes: [fsg.dir(""), fsg.dir("notes")], edges: [fsg.contains("", "notes")] };
    const { spines } = await change(["notes/sub/s.md"]);
    expect(spines.map((c) => c.path)).toEqual(["notes/sub"]);
    expect(canvas.props!.nodes.map((n) => n.id)).not.toContain("notes/sub/s.md");
  });

  test("a file where an opened directory was takes what the spine held below it", async () => {
    graphServer.view = { nodes: [], edges: [] };
    graphServer.fs = {
      nodes: [fsg.dir(""), fsg.dir("notes"), fsg.dir("notes/sub"), fsg.file("notes/sub/s.md")],
      edges: [fsg.contains("", "notes"), fsg.contains("notes", "notes/sub"), fsg.contains("notes/sub", "notes/sub/s.md")],
    };
    await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: openedForPath("notes/sub") }));

    graphServer.fs = {
      nodes: [fsg.dir(""), fsg.dir("notes"), fsg.file("notes/sub")],
      edges: [fsg.contains("", "notes"), fsg.contains("notes", "notes/sub")],
    };
    await change(["notes/sub/s.md", "notes/sub"]);
    const ids = canvas.props!.nodes.map((n) => n.id);
    expect(ids).not.toContain("notes/sub/s.md");
    expect(ids, "the file, under its bare path").toContain("notes/sub");
    expect(ids).not.toContain("directory:notes/sub");
  });

  /// The canvas's edges as `source>target:kind`, broken ones marked.
  function drawnEdges(): string[] {
    return (canvas.props!.edges as Array<{ source: string; target: string; kind: string; broken?: boolean }>).map(
      (e) => `${e.source}>${e.target}:${e.kind}${e.broken ? " broken" : ""}`,
    );
  }

  test("a patch keeps the edges below an opened subdirectory it reads again", async () => {
    graphServer.view = { nodes: [], edges: [] };
    graphServer.fs = {
      nodes: [fsg.dir(""), fsg.dir("notes"), fsg.dir("notes/sub"), fsg.file("notes/sub/s.md")],
      edges: [fsg.contains("", "notes"), fsg.contains("notes", "notes/sub"), fsg.contains("notes/sub", "notes/sub/s.md")],
    };
    await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: openedForPath("notes/sub") }));
    graphServer.fs = {
      nodes: [...graphServer.fs.nodes, fsg.file("notes/new.md")],
      edges: [...graphServer.fs.edges, fsg.contains("notes", "notes/new.md")],
    };
    const { spines } = await change(["notes/new.md"]);
    expect(spines.map((c) => c.path)).toEqual(["notes"]);
    expect(drawnEdges()).toEqual(
      expect.arrayContaining([
        "directory:notes>notes/new.md:contains",
        "directory:notes/sub>notes/sub/s.md:contains",
      ]),
    );
  });

  test("a change at the root keeps the edges of every top-level directory", async () => {
    graphServer.view = { nodes: [], edges: [] };
    graphServer.fs = {
      nodes: [fsg.dir(""), fsg.dir("notes"), fsg.dir("src"), fsg.file(A), fsg.file("src/main.rs")],
      edges: [fsg.contains("", "notes"), fsg.contains("", "src"), fsg.contains("notes", A), fsg.contains("src", "src/main.rs")],
    };
    await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { ...openedForPath("notes"), src: true } }));
    graphServer.fs = {
      nodes: [...graphServer.fs.nodes, fsg.file("top.md")],
      edges: [...graphServer.fs.edges, fsg.contains("", "top.md")],
    };
    const { spines } = await change(["top.md"]);
    expect(spines.map((c) => c.path)).toEqual([""]);
    expect(drawnEdges()).toEqual(
      expect.arrayContaining([">top.md:contains", `${NOTES}>${A}:contains`, "directory:src>src/main.rs:contains"]),
    );
    expect(visibleIds()).toEqual(expect.arrayContaining([A, "src/main.rs", "top.md"]));
  });

  test("a symlink into a directory a patch reads is read again with its own", async () => {
    graphServer.view = { nodes: [], edges: [] };
    const target = fsg.file("notes/x.md");
    const link = { ...fsg.file("links/l.md"), kind: "symlink" as const, target: "../notes/x.md" };
    const fsTree = (x: FsGraphNode) => ({
      nodes: [fsg.dir(""), fsg.dir("notes"), fsg.dir("links"), x, link],
      edges: [
        fsg.contains("", "notes"),
        fsg.contains("", "links"),
        fsg.contains("notes", "notes/x.md"),
        fsg.contains("links", "links/l.md"),
        { source: "links/l.md", target: "notes/x.md", kind: "symlink" as const },
      ],
    });
    graphServer.fs = fsTree(target);
    await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: { ...openedForPath("notes"), links: true } }));
    expect(drawnEdges()).toContain("links/l.md>notes/x.md:symlink");

    // The target goes; the route answers the link's target as a broken ghost.
    graphServer.fs = fsTree({ ...target, kind: "ghost", broken: true });
    graphServer.fs.edges = graphServer.fs.edges.filter((e) => e.target !== "notes/x.md" || e.kind === "symlink");
    const { spines } = await change(["notes/x.md"]);
    expect(spines.map((c) => c.path)).toEqual(["links", "notes"]);
    expect(drawnEdges()).toContain("links/l.md>notes/x.md:symlink broken");
  });

  test("two changes signalled before the tab looks are a change whose paths are not known", async () => {
    await mountGraphPanel(GraphPanel, layout, graphTab({ expanded: openedForPath("notes") }));
    vi.useFakeTimers();
    try {
      const spines = graphServer.fsGraphCalls.length;
      graphReloadSignal.paths = ["src/one.rs"];
      graphReloadSignal.nonce += 1;
      graphReloadSignal.paths = ["notes/two.md"];
      graphReloadSignal.nonce += 1;
      await vi.runAllTimersAsync();
      const read = graphServer.fsGraphCalls.slice(spines).map((c) => c.path);
      expect(read, "the spine is read whole, from the root").toContain("");
    } finally {
      vi.useRealTimers();
    }
  });

  test("a change that names no path fetches the spine whole", async () => {
    await mountGraphPanel(GraphPanel, layout, graphTab());
    const { spines } = await change([]);
    expect(spines).toEqual([{ path: "", depth: 1, cursor: undefined }]);
  });
});

/// A change at `paths`, as the store signals it, with every timer it
/// schedules run however long its delay: the shared graph's quiet window and
/// the tab's own. Answers the streams and the spine requests it cost.
async function change(paths: string[]): Promise<{
  streams: number;
  spines: Array<{ path: string; depth: number; cursor?: string }>;
}> {
  vi.useFakeTimers();
  try {
    const streams = graphServer.graphStreamCalls;
    const spines = graphServer.fsGraphCalls.length;
    noteGraphChanged(() => true);
    graphReloadSignal.paths = paths;
    graphReloadSignal.nonce += 1;
    await vi.runAllTimersAsync();
    return {
      streams: graphServer.graphStreamCalls - streams,
      spines: graphServer.fsGraphCalls.slice(spines),
    };
  } finally {
    vi.useRealTimers();
  }
}
