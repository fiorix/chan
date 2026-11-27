// @vitest-environment jsdom
//
// A graph tab opened on a file over the listing cap. An answer marked over
// the cap holds every folder but, of the files, only those the graph holds
// otherwise, so the file a tab is opened on can be missing from it. The tab
// then opens the folders down to the file, reads their levels from disk and
// selects the file once its own level holds it. GraphPanel is mounted on the
// real tab model with the api served from a fixed tree; the assertions read
// the selection the canvas is handed, the tab's pending selection and opened
// folders, and the level reads the api saw.

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
import type { GraphTreeCoverage } from "../api/client";
import { ApiError } from "../api/errors";
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
} from "../__tests__/graphPanel";
import { directoryNodeId } from "../graph/canvasNodes";
import { graphData, invalidateGraph, refreshGraph } from "../state/graphData.svelte";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { graphReloadSignal } from "../state/store.svelte";
import { parentDir } from "../state/format";
import { closeTabMenu } from "../state/tabMenu.svelte";
import { layout, type GraphTab } from "../state/tabs.svelte";

installGraphDom();

let timers: TimerTrack;
beforeEach(() => {
  timers = trackTimers();
  resetGraphServer();
  invalidateGraph();
});
afterEach(() => {
  closeTabMenu();
  unmountGraphPanels();
  timers.release();
});

const DIRS = ["", "a", "a/b", "a/b/c"];
const FILES = ["top.md", "a/x.rs", "a/b/c/y.rs"];

/// The tree on disk: folders a, a/b and a/b/c, with top.md at the root,
/// a/x.rs and a/b/c/y.rs. Under an answer of the whole tree the shared graph
/// holds all of it; over the listing cap it holds every folder and none of
/// the three files, with the tag, mention and language nodes either way.
function serve(tree: GraphTreeCoverage | null): void {
  const files = tree === null ? FILES : [];
  graphServer.view = {
    nodes: [
      ...DIRS.map((dir) => g.dir(dir)),
      ...files.map((file) => g.file(file)),
      g.tag("t"),
      g.mention("alice"),
      g.language("rust"),
    ],
    edges: [
      ...DIRS.filter(Boolean).map((dir) => g.edge(directoryNodeId(parentDir(dir)), directoryNodeId(dir), "contains")),
      ...files.map((file) => g.edge(directoryNodeId(parentDir(file)), file, "contains")),
    ],
  };
  graphServer.fs = {
    nodes: [...DIRS.map((dir) => fsg.dir(dir)), ...FILES.map((file) => fsg.file(file))],
    edges: [...DIRS.filter(Boolean), ...FILES].map((path) => fsg.contains(parentDir(path), path)),
  };
  graphServer.tree = tree;
}

const reads = (): string[] => graphServer.fsGraphCalls.map((call) => call.path);
const levelReads = (path: string): number => reads().filter((read) => read === path).length;

/// The tab's selection, the pending one and the folders it has opened.
function state(tab: GraphTab): { selected: string | null; pending: string | null; opened: string[] } {
  return {
    selected: canvas.props!.selectedId,
    pending: tab.pendingSelectId,
    opened: Object.keys(tab.expanded).filter((dir) => tab.expanded[dir]).sort(),
  };
}

/// A graph tab as its opener makes it, which always opens the root.
function openerTab(over: Partial<GraphTab>): GraphTab {
  return graphTab({ expanded: { "": true }, ...over });
}

async function open(select: string): Promise<GraphTab> {
  const { tab } = await mountGraphPanel(GraphPanel, layout, openerTab({ pendingSelectId: select }));
  await settle(30);
  return tab;
}

describe("under an answer of the whole tree", () => {
  test("a tab opened on a file selects it from the shared graph and reads only the root's level", async () => {
    serve(null);
    const tab = await open("a/x.rs");
    expect(graphData.tree).toBeNull();
    expect(graphData.partial).toBe(false);
    expect(state(tab)).toEqual({ selected: "a/x.rs", pending: null, opened: [""] });
    expect(reads()).toEqual([""]);
  });

  test("a tab opened on a file the tree does not hold drops it and opens nothing", async () => {
    serve(null);
    const tab = await open("a/gone.rs");
    expect(state(tab)).toEqual({ selected: null, pending: null, opened: [""] });
    expect(reads()).toEqual([""]);
  });
});

describe.each(["folders", "depth"] as const)("over the listing cap (%s)", (tree) => {
  // The root's level is the tab's first fetch. The folder chain is read by
  // one patch, a level per folder, parents first, and the file's own level is
  // the last of them; nothing is read twice and no whole fetch follows.
  test("a tab opened on a file the answer does not hold opens its folder, reads its level and selects it", async () => {
    serve(tree);
    const tab = await open("a/x.rs");
    expect(graphData.tree).toBe(tree);
    expect(graphData.partial).toBe(false);
    expect(state(tab)).toEqual({ selected: "a/x.rs", pending: null, opened: ["", "a"] });
    expect(reads()).toEqual(["", "a"]);
  });

  test("a file three folders down has its whole chain read, shallowest first", async () => {
    serve(tree);
    const tab = await open("a/b/c/y.rs");
    expect(state(tab)).toEqual({ selected: "a/b/c/y.rs", pending: null, opened: ["", "a", "a/b", "a/b/c"] });
    expect(reads()).toEqual(["", "a", "a/b", "a/b/c"]);
  });

  test("a file at the root is selected from the root's level", async () => {
    serve(tree);
    const tab = await open("top.md");
    expect(state(tab)).toEqual({ selected: "top.md", pending: null, opened: [""] });
    expect(reads()).toEqual([""]);
  });

  test("a file its own level does not hold waits for that level and is dropped once it is read", async () => {
    serve(tree);
    let release!: () => void;
    graphServer.onFsGraph = (request) => {
      if (request.path === "a" && graphServer.fsGate === null) {
        graphServer.fsGate = new Promise<void>((resolve) => (release = resolve));
      }
    };
    const tab = await open("a/gone.rs");
    expect(state(tab), "waiting on the folder's level").toEqual({ selected: null, pending: "a/gone.rs", opened: ["", "a"] });
    graphServer.fsGate = null;
    release();
    await settle(30);
    expect(state(tab)).toEqual({ selected: null, pending: null, opened: ["", "a"] });
    await settle(30);
    expect(reads(), "the level was read once").toEqual(["", "a"]);
  });

  test.each([
    ["a folder of the chain that is not on disk", "zz/x.rs"],
    ["a folder below one that is not on disk", "zz/b/x.rs"],
    ["a file at the root that is not on disk", "zz.rs"],
    ["a file under a folder that is a file", "top.md/x.rs"],
  ])("%s: the root's level shows it, and the selection is dropped with nothing more read", async (_label, select) => {
    serve(tree);
    const tab = await open(select);
    expect(state(tab)).toEqual({ selected: null, pending: null, opened: [""] });
    expect(reads()).toEqual([""]);
  });

  test("a folder of the chain gone by the time its level is read drops the selection after that read", async () => {
    serve(tree);
    graphServer.fsFail = (path) => (path === "a" ? new ApiError(404, "no such path: a", { error: "no such path: a" }) : null);
    const tab = await open("a/x.rs");
    expect(state(tab)).toEqual({ selected: null, pending: null, opened: ["", "a"] });
    await settle(30);
    expect(reads(), "read once").toEqual(["", "a"]);
  });

  test("a folder of the chain whose read keeps failing is retried once, then the selection is dropped", async () => {
    serve(tree);
    graphServer.fsFail = (path) => (path === "a" ? new ApiError(500, "boom", { error: "boom" }) : null);
    const tab = await open("a/x.rs");
    await settle(30);
    expect(state(tab)).toEqual({ selected: null, pending: null, opened: ["", "a"] });
    // The failed patch hands the level to a whole fetch, whose own failure is
    // retried once once the graph is whole.
    expect({ root: levelReads(""), a: levelReads("a") }).toEqual({ root: 2, a: 3 });
    await settle(30);
    expect({ root: levelReads(""), a: levelReads("a") }, "nothing reads it again").toEqual({ root: 2, a: 3 });
  });

  test("a folder of the chain whose read fails until its retry is selected from once the retry reads it", async () => {
    serve(tree);
    let failures = 2;
    graphServer.fsFail = (path) => (path === "a" && failures-- > 0 ? new ApiError(500, "boom", { error: "boom" }) : null);
    const tab = await open("a/x.rs");
    expect(state(tab)).toEqual({ selected: "a/x.rs", pending: null, opened: ["", "a"] });
    expect(reads()).toEqual(["", "a", "", "a", "a"]);
  });

  test("a folder of the chain whose first read fails is read by the whole fetch that takes it over", async () => {
    serve(tree);
    let failures = 1;
    graphServer.fsFail = (path) => (path === "a" && failures-- > 0 ? new ApiError(500, "boom", { error: "boom" }) : null);
    const tab = await open("a/x.rs");
    expect(state(tab)).toEqual({ selected: "a/x.rs", pending: null, opened: ["", "a"] });
    expect(reads()).toEqual(["", "a", "", "a"]);
  });

  // The window's graph answered again while a level is read: the tab takes
  // the new answer, whole, before the read lands.
  test("a refresh of the window's graph while the chain's level is read keeps the selection waiting for that read", async () => {
    serve(tree);
    let release!: () => void;
    graphServer.onFsGraph = (request) => {
      if (request.path === "a" && graphServer.fsGate === null) {
        graphServer.fsGate = new Promise<void>((resolve) => (release = resolve));
      }
    };
    const tab = await open("a/x.rs");
    const asked = graphServer.graphStreamCalls;
    await refreshGraph();
    await settle(30);
    expect(graphServer.graphStreamCalls, "the window's graph answered again").toBe(asked + 1);
    expect(state(tab)).toEqual({ selected: null, pending: "a/x.rs", opened: ["", "a"] });
    graphServer.fsGate = null;
    release();
    await settle(30);
    expect(state(tab)).toEqual({ selected: "a/x.rs", pending: null, opened: ["", "a"] });
    expect(reads()).toEqual(["", "a"]);
  });

  // A folder opened below a closed one is read with the chain once the chain
  // opens it, in the same patch, after the chain's own level.
  test("a file its level holds waits to be drawn while the same read goes on below it", async () => {
    serve(tree);
    let release!: () => void;
    graphServer.onFsGraph = (request) => {
      if (request.path === "a/b" && graphServer.fsGate === null) {
        graphServer.fsGate = new Promise<void>((resolve) => (release = resolve));
      }
    };
    const { tab } = await mountGraphPanel(
      GraphPanel,
      layout,
      openerTab({ pendingSelectId: "a/x.rs", selectedNodeId: "a/x.rs", expanded: { "": true, "a/b": true } }),
    );
    await settle(30);
    expect(reads(), "the folder's level is read, the one below it held").toEqual(["", "a", "a/b"]);
    await refreshGraph();
    await settle(30);
    expect(state(tab)).toEqual({ selected: null, pending: "a/x.rs", opened: ["", "a", "a/b"] });
    graphServer.fsGate = null;
    release();
    await settle(30);
    expect(state(tab)).toEqual({ selected: "a/x.rs", pending: null, opened: ["", "a", "a/b"] });
    expect(reads()).toEqual(["", "a", "a/b"]);
  });

  test.each([
    ["a tag", "#t"],
    ["a mention", "@@alice"],
    ["a language", "language:rust"],
  ])("%s the answer holds is selected with nothing read", async (_label, select) => {
    serve(tree);
    const tab = await open(select);
    expect(state(tab)).toEqual({ selected: select, pending: null, opened: [""] });
    expect(reads()).toEqual([""]);
  });

  test.each([
    ["a tag", "#gone"],
    ["a nested tag", "#t/gone"],
    ["a mention", "@@bob"],
    ["a language", "language:cobol"],
  ])("%s the answer does not hold is dropped with nothing read", async (_label, select) => {
    serve(tree);
    const tab = await open(select);
    expect(state(tab)).toEqual({ selected: null, pending: null, opened: [""] });
    expect(reads()).toEqual([""]);
  });

  // A restored tab carries its selection in `selectedNodeId` beside the
  // pending one; a tab moved to another pane carries only `selectedNodeId`,
  // which its new panel hands to the pending path.
  test.each([
    ["restored", { pendingSelectId: "a/x.rs", selectedNodeId: "a/x.rs" }],
    ["moved", { pendingSelectId: null, selectedNodeId: "a/x.rs" }],
  ] as const)("a %s tab's selection of a file the answer does not hold is read for the same way", async (_label, over) => {
    serve(tree);
    const { tab } = await mountGraphPanel(GraphPanel, layout, openerTab(over));
    await settle(30);
    expect(state(tab)).toEqual({ selected: "a/x.rs", pending: null, opened: ["", "a"] });
    expect(tab.selectedNodeId).toBe("a/x.rs");
    expect(reads()).toEqual(["", "a"]);
  });

  test("the answer taken while the first whole fetch is in flight has the chain read after its landing", async () => {
    serve(tree);
    let release!: () => void;
    graphServer.fsGate = new Promise<void>((resolve) => (release = resolve));
    const { tab } = await mountGraphPanel(GraphPanel, layout, openerTab({ pendingSelectId: "a/x.rs" }));
    await settle(30);
    expect(graphData.tree, "the answer is in").toBe(tree);
    expect(state(tab), "waiting on the spine").toEqual({ selected: null, pending: "a/x.rs", opened: [""] });
    expect(reads()).toEqual([""]);
    graphServer.fsGate = null;
    release();
    await settle(30);
    expect(state(tab)).toEqual({ selected: "a/x.rs", pending: null, opened: ["", "a"] });
    expect(reads()).toEqual(["", "a"]);
  });

  test("a whole fetch begun while the chain's level is read reads the chain at its landing, and none other begins", async () => {
    serve(tree);
    let release!: () => void;
    graphServer.onFsGraph = (request) => {
      if (request.path === "a" && graphServer.fsGate === null && levelReads("a") === 1) {
        graphServer.fsGate = new Promise<void>((resolve) => (release = resolve));
      }
    };
    const tab = await open("a/x.rs");
    expect(state(tab), "the level's read is held").toEqual({ selected: null, pending: "a/x.rs", opened: ["", "a"] });
    graphReloadSignal.paths = [];
    graphReloadSignal.nonce += 1;
    await new Promise((resolve) => setTimeout(resolve, 400));
    await settle();
    expect(levelReads(""), "the change's whole fetch is in flight").toBe(2);
    graphServer.fsGate = null;
    release();
    await settle(30);
    expect(state(tab)).toEqual({ selected: "a/x.rs", pending: null, opened: ["", "a"] });
    expect(reads(), "the patch's read is superseded; the landing reads the chain").toEqual(["", "a", "", "a"]);
  });
});
