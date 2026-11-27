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
//
// Every case ends within CASE_MS and runs no loop of microtasks. The
// selection's rule waits on reads it asks for, and a rule that asks again for
// a folder it already asked for loops on microtasks alone, which no timer
// interrupts: the worker would hang with no case named.
// `yieldRunawayMicrotasks` makes such a loop yield and counts it, and every
// wait of a case reads the count and the clock.

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

import GraphPanel from "./GraphPanel.svelte";
import type { GraphTreeCoverage } from "../api/client";
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
  settle as settleTurns,
  unmountGraphPanels,
} from "../__tests__/graphPanel";
import { yieldRunawayMicrotasks, type MicrotaskYield } from "../__tests__/microtaskYield";
import { directoryNodeId } from "../graph/canvasNodes";
import { graphData, invalidateGraph, refreshGraph } from "../state/graphData.svelte";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { graphReloadSignal } from "../state/store.svelte";
import { parentDir } from "../state/format";
import { closeTabMenu } from "../state/tabMenu.svelte";
import { layout, type GraphTab, type LeafNode } from "../state/tabs.svelte";

installGraphDom();

const CASE_MS = 10_000;
let deadline = Infinity;
let microtasks: MicrotaskYield;

/// The fixture's settle, a turn at a time, failing the case once a loop of
/// microtasks has run or the case has run past its bound.
async function settle(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await settleTurns(1);
    if (microtasks.yielded > 0) throw new Error("a loop of microtasks ran with no timer turn");
    if (performance.now() > deadline) throw new Error(`the case did not finish within its ${CASE_MS} ms bound`);
  }
}

let timers: TimerTrack;
beforeEach(() => {
  microtasks = yieldRunawayMicrotasks();
  timers = trackTimers();
  resetGraphServer();
  invalidateGraph();
  deadline = performance.now() + CASE_MS;
});
afterEach(() => {
  closeTabMenu();
  unmountGraphPanels();
  for (const app of shownPanels.splice(0)) unmount(app);
  timers.release();
  const yielded = microtasks.yielded;
  microtasks.release();
  // A loop that began after the case's last wait.
  expect(yielded, "a loop of microtasks ran with no timer turn").toBe(0);
});

const DIRS = ["", "a", "a/b", "a/b/c"];
const FILES = ["top.md", "a/x.rs", "a/b/c/y.rs"];

/// The tree on disk: folders a, a/b and a/b/c, with top.md at the root,
/// a/x.rs and a/b/c/y.rs, and the folders and files `more` names. Under an
/// answer of the whole tree the shared graph holds all of it; over the listing
/// cap it holds every folder and none of the files, with the tag, mention and
/// language nodes either way.
function serve(tree: GraphTreeCoverage | null, more: { dirs?: string[]; files?: string[] } = {}): void {
  const dirs = [...DIRS, ...(more.dirs ?? [])];
  const onDisk = [...FILES, ...(more.files ?? [])];
  const files = tree === null ? onDisk : [];
  graphServer.view = {
    nodes: [
      ...dirs.map((dir) => g.dir(dir)),
      ...files.map((file) => g.file(file)),
      g.tag("t"),
      g.mention("alice"),
      g.language("rust"),
    ],
    edges: [
      ...dirs.filter(Boolean).map((dir) => g.edge(directoryNodeId(parentDir(dir)), directoryNodeId(dir), "contains")),
      ...files.map((file) => g.edge(directoryNodeId(parentDir(file)), file, "contains")),
    ],
  };
  graphServer.fs = {
    nodes: [...dirs.map((dir) => fsg.dir(dir)), ...onDisk.map((file) => fsg.file(file))],
    edges: [...dirs.filter(Boolean), ...onDisk].map((path) => fsg.contains(parentDir(path), path)),
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

const shownPanels: Array<Record<string, unknown>> = [];

/// A graph tab as its opener makes it, mounted shown, with `show` to hide and
/// show it as its pane does when another of its tabs is chosen.
async function openShowable(over: Partial<GraphTab>): Promise<{ tab: GraphTab; show: (shown: boolean) => void }> {
  const made = openerTab(over);
  layout.nodes = { [GRAPH_PANE]: { kind: "leaf", id: GRAPH_PANE, tabs: [made], activeTabId: made.id } };
  layout.rootId = GRAPH_PANE;
  layout.activePaneId = GRAPH_PANE;
  const pane = layout.nodes[GRAPH_PANE] as LeafNode;
  const tab = pane.tabs[0] as GraphTab;
  const target = document.createElement("div");
  document.body.append(target);
  shownPanels.push(
    mount(GraphPanel, {
      target,
      props: {
        tab,
        get active() {
          return pane.activeTabId === made.id;
        },
      },
    }) as Record<string, unknown>,
  );
  await settle();
  return { tab, show: (shown) => (pane.activeTabId = shown ? made.id : "another-tab") };
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

  // A restored tab with the folder q opened, whose read always fails. The
  // whole fetch fails it and its retry fails it again; the chain's read
  // leaves it to that retry rather than reading it once more, which would
  // fail into a whole fetch of its own.
  test("the chain's read leaves an opened folder whose read failed to its retry", async () => {
    serve(tree, { dirs: ["q"] });
    graphServer.fsFail = (path) => (path === "q" ? new ApiError(500, "boom", { error: "boom" }) : null);
    const { tab } = await mountGraphPanel(
      GraphPanel,
      layout,
      openerTab({ pendingSelectId: "a/x.rs", selectedNodeId: "a/x.rs", expanded: { "": true, q: true } }),
    );
    await settle(30);
    expect(state(tab)).toEqual({ selected: "a/x.rs", pending: null, opened: ["", "a", "q"] });
    expect({ root: levelReads(""), q: levelReads("q"), a: levelReads("a") }).toEqual({ root: 1, q: 2, a: 1 });
  });

  // The first spine is in while the window's answer is held. A change that
  // names no path fetches the spine whole again, which fails at the root, and
  // then the answer completes over a spine in error: there is no spine to
  // read the chain into, and asking would only begin another whole fetch.
  test("over a spine in error the selection is dropped and no read is begun for its chain", async () => {
    serve(tree);
    let releaseStream!: () => void;
    graphServer.streamGate = new Promise<void>((resolve) => (releaseStream = resolve));
    graphServer.fsFail = (path) =>
      path === "" && levelReads("") === 2 ? new ApiError(500, "boom", { error: "boom" }) : null;
    const tab = await open("a/x.rs");
    expect(graphData.loading, "the answer is held").toBe(true);
    graphReloadSignal.paths = [];
    graphReloadSignal.nonce += 1;
    await new Promise((resolve) => setTimeout(resolve, 400));
    await settle(30);
    expect(levelReads(""), "the reload failed at the root").toBe(2);
    graphServer.streamGate = null;
    releaseStream();
    await settle(30);
    expect(graphData.tree, "the answer is in").toBe(tree);
    expect(state(tab)).toEqual({ selected: null, pending: null, opened: [""] });
    await settle(30);
    expect({ root: levelReads(""), a: levelReads("a") }).toEqual({ root: 2, a: 0 });
  });

  // A restored tab whose folder a is closed with 130 folders opened below it
  // that sort ahead of a/zz, the file's folder. A step of the level reads
  // takes at most 64 folders, parents first: opening the chain reads a and 63
  // of them, the next step 64 more and not a/zz, the one after the last three
  // and a/zz.
  const SIBLINGS = Array.from({ length: 130 }, (_, i) => `a/f${String(i).padStart(3, "0")}`);

  async function openPastSiblings(select: string): Promise<GraphTab> {
    serve(tree, { dirs: [...SIBLINGS, "a/zz"], files: ["a/zz/x.rs"] });
    const expanded = Object.fromEntries(["", ...SIBLINGS].map((dir) => [dir, true]));
    const { tab } = await mountGraphPanel(
      GraphPanel,
      layout,
      openerTab({ pendingSelectId: select, selectedNodeId: select, expanded }),
    );
    await settle(30);
    return tab;
  }

  test("a chain folder a step of the level reads left out is asked at the next step, and the file is selected", async () => {
    const tab = await openPastSiblings("a/zz/x.rs");
    expect(state(tab).selected).toBe("a/zz/x.rs");
    expect(state(tab).pending).toBeNull();
    expect(tab.expanded["a/zz"]).toBe(true);
    expect(levelReads("a/zz"), "the file's folder").toBe(1);
    expect(reads().length, "the root, a, the 130 folders below it and a/zz, each once").toBe(133);
    expect(new Set(reads()).size).toBe(133);
  });

  test("a chain folder a step left out is dropped only once a step that took it settles without the file", async () => {
    const tab = await openPastSiblings("a/zz/gone.rs");
    expect(state(tab).selected).toBeNull();
    expect(state(tab).pending).toBeNull();
    expect(levelReads("a/zz"), "the file's folder").toBe(1);
    expect(reads().length).toBe(133);
    await settle(30);
    expect(reads().length, "nothing more is read").toBe(133);
  });

  // A tab shown long enough to take the window's answer and to begin its
  // first whole fetch, and hidden while that fetch is in flight: the fetch
  // lands in the hidden tab, whose graph is then whole.
  test("a hidden tab keeps the selection pending and reads nothing for it until it is shown", async () => {
    serve(tree);
    let release!: () => void;
    graphServer.fsGate = new Promise<void>((resolve) => (release = resolve));
    const { tab, show } = await openShowable({ pendingSelectId: "a/x.rs" });
    await settle(30);
    expect(graphData.tree, "the answer is in").toBe(tree);
    show(false);
    await settle();
    graphServer.fsGate = null;
    release();
    await settle(30);
    expect(state(tab), "hidden").toEqual({ selected: null, pending: "a/x.rs", opened: [""] });
    expect(reads(), "hidden").toEqual([""]);
    show(true);
    await settle(30);
    expect(state(tab)).toEqual({ selected: "a/x.rs", pending: null, opened: ["", "a"] });
    expect(reads()).toEqual(["", "a"]);
  });
});
