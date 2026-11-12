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
import { trackTimers, type TimerTrack } from "../demo/timers";
import { graphReloadSignal } from "../state/store.svelte";
import { closeTabMenu, openTabMenu } from "../state/tabMenu.svelte";
import { openedForPath } from "../graph/selectionView";
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
  serveGraph();
});

afterEach(() => {
  closeTabMenu();
  unmountGraphPanels();
  timers.release();
});

/// Move the depth slider to `value`, as a drag ends on it.
async function slideTo(slider: HTMLInputElement, value: number): Promise<void> {
  slider.value = String(value);
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
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
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId: "workspace" }));
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
      graphTab({ scopeId: "workspace", expanded: { "": true, notes: true } }),
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

describe("the workspace tree", () => {
  test("shows a directory's files only while it and its ancestors are expanded", async () => {
    await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId: "workspace", expanded: { "": true } }));
    let ids = visibleIds();
    expect(ids).toEqual(expect.arrayContaining(["", NOTES, SRC]));
    expect(ids).not.toContain(A);
    unmountGraphPanels();

    await mountGraphPanel(
      GraphPanel,
      layout,
      graphTab({ scopeId: "workspace", expanded: { "": true, notes: true } }),
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
      graphTab({ scopeId: "workspace", expanded: { "": true } }),
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
      graphTab({ scopeId: "workspace", expanded: { "": true, src: true } }),
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
      graphTab({ scopeId: "workspace", expanded: { "": true } }),
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

describe("the filesystem graph", () => {
  test("shows what the expanded directories hold, and hides a collapsed one's", async () => {
    const { tab } = await mountGraphPanel(
      GraphPanel,
      layout,
      graphTab({ scopeId: "workspace", mode: "filesystem", expanded: { "": true, notes: true } }),
    );
    expect(visibleIds()).toEqual(expect.arrayContaining(["", "notes", "src", "notes/a.md", "notes/deep"]));
    expect(visibleIds()).not.toContain("src/main.rs");

    // Collapse notes with a double-click: its children stay loaded, and hidden.
    canvas.props!.onSelect("notes");
    await settle(2);
    canvas.props!.onSetAsScope();
    await settle();
    expect(tab.expanded.notes).toBeUndefined();
    expect(canvas.props!.nodes.some((n) => n.id === "notes/a.md"), "still loaded").toBe(true);
    expect(visibleIds()).not.toContain("notes/a.md");
    expect(visibleIds()).toContain("notes");
  });

  test("expanding a directory fetches its children and asks the canvas to fit them", async () => {
    const { tab } = await mountGraphPanel(
      GraphPanel,
      layout,
      graphTab({ scopeId: "workspace", mode: "filesystem", expanded: { "": true } }),
    );
    expect(canvas.props!.nodes.some((n) => n.id === "notes/a.md"), "not loaded yet").toBe(false);

    canvas.props!.onSelect("notes");
    await settle(2);
    canvas.props!.onSetAsScope();
    await settle();

    expect(tab.expanded.notes).toBe(true);
    expect(graphServer.fsGraphCalls.some((c) => c.path === "notes" && c.depth === 1)).toBe(true);
    expect(visibleIds()).toEqual(expect.arrayContaining(["notes/a.md", "notes/deep"]));
    expect(canvas.props!.expansionFitRequest?.ids).toEqual(
      expect.arrayContaining(["notes", "", "notes/a.md", "notes/deep"]),
    );
  });

  test("a file scope shows everything it loaded", async () => {
    await mountGraphPanel(
      GraphPanel,
      layout,
      graphTab({ scopeId: "file:notes/a.md", mode: "filesystem" }),
    );
    expect(visibleIds().length).toBe(canvas.props!.nodes.length);
  });
});

describe("the tab menu", () => {
  test("is the scope row, the depth slider, the filters and Close, each group behind a separator", async () => {
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId: "workspace" }));
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
    expect(collapsed).toEqual(["scope", "---", "depth", "---", "filter", "---", "Close"]);
    closeTabMenu();
  });
});
