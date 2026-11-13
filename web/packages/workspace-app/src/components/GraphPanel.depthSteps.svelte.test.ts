// @vitest-environment jsdom
//
// The value the launcher's Increase depth and Decrease depth show on a graph
// tab. The depth is the selected node's and only the panel can work it out,
// so the two rows read it from the panel of the active graph tab, and only
// while a row is listed: a shown graph whose menu is closed and whose steps
// nobody lists works out no depth at all. GraphPanel is mounted over a fixed
// graph, the three functions the depth is worked out with are counted, and a
// listed row is an effect that reads the command's state the way the
// launcher's derived rows do. The last group mounts the panel under the Pane
// that mounts it in the app, where a tab is copied on a reorder and its
// panel is replaced on a move, and where a write to state the pane owns
// warns.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const worked = vi.hoisted(() => ({ cap: 0, opened: 0, dir: 0 }));

vi.mock("../graph/selectionView", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../graph/selectionView")>();
  return {
    ...actual,
    selectionDepthCap: (...args: Parameters<typeof actual.selectionDepthCap>) => {
      worked.cap += 1;
      return actual.selectionDepthCap(...args);
    },
    openedDepth: (...args: Parameters<typeof actual.openedDepth>) => {
      worked.opened += 1;
      return actual.openedDepth(...args);
    },
    selectedDirectory: (...args: Parameters<typeof actual.selectedDirectory>) => {
      worked.dir += 1;
      return actual.selectedDirectory(...args);
    },
  };
});
vi.mock("./GraphCanvas.svelte", async () =>
  (await import("../__tests__/graphPanel")).canvasProbeModule(),
);
vi.mock("../api/client", async (importOriginal) =>
  (await import("../__tests__/graphPanel")).graphApiModule(
    await importOriginal<typeof import("../api/client")>(),
  ),
);

import GraphPanel from "./GraphPanel.svelte";
import Pane from "./Pane.svelte";
import {
  GRAPH_PANE,
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
import { failOnOwnershipWarnings } from "../__tests__/svelteWarnings";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { commandById, commandContext } from "../state/commands";
import { invalidateGraph, refreshGraph } from "../state/graphData.svelte";
import { closeTabMenu, openTabMenu } from "../state/tabMenu.svelte";
import {
  activeGraphTab,
  graphShownDepth,
  layout,
  moveTab,
  registerGraphDepthReader,
  reorderTab,
  type GraphTab,
  type LeafNode,
} from "../state/tabs.svelte";

installGraphDom();

const INCREASE = "app.graph.depth.increase";
const DECREASE = "app.graph.depth.decrease";
const A = "notes/a.md";
const NOTES = "directory:notes";

let timers: TimerTrack;
const stops: Array<() => void> = [];

beforeEach(() => {
  timers = trackTimers();
  resetGraphServer();
  invalidateGraph();
  // notes/a.md links to notes/deep/d.md, which links to notes/deep/e.md: two
  // hops of references from a.md, and three levels of tree below the root.
  graphServer.view = {
    nodes: [
      g.dir(""),
      g.dir("notes"),
      g.dir("notes/deep"),
      g.file("notes/a.md"),
      g.file("notes/deep/d.md"),
      g.file("notes/deep/e.md"),
    ],
    edges: [
      g.edge("", NOTES, "contains"),
      g.edge(NOTES, "directory:notes/deep", "contains"),
      g.edge(NOTES, A, "contains"),
      g.edge("directory:notes/deep", "notes/deep/d.md", "contains"),
      g.edge("directory:notes/deep", "notes/deep/e.md", "contains"),
      g.edge(A, "notes/deep/d.md", "link"),
      g.edge("notes/deep/d.md", "notes/deep/e.md", "link"),
    ],
  };
  graphServer.fs = {
    nodes: [
      fsg.dir(""),
      fsg.dir("notes"),
      fsg.dir("notes/deep"),
      fsg.file("notes/a.md"),
      fsg.file("notes/deep/d.md"),
      fsg.file("notes/deep/e.md"),
    ],
    edges: [
      fsg.contains("", "notes"),
      fsg.contains("notes", "notes/deep"),
      fsg.contains("notes", "notes/a.md"),
      fsg.contains("notes/deep", "notes/deep/d.md"),
      fsg.contains("notes/deep", "notes/deep/e.md"),
    ],
  };
  worked.cap = 0;
  worked.opened = 0;
  worked.dir = 0;
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  closeTabMenu();
  unmountGraphPanels();
  timers.release();
});

failOnOwnershipWarnings();

function run(id: string): void {
  commandById(id)!.run();
}

/// The value a depth step reports when asked once.
function shown(id: string): string | null {
  return commandById(id)!.state!(commandContext()) as string | null;
}

/// A step kept listed, as the launcher's derived rows keep it: an effect that
/// reads the command's state. Returns the values the row has shown, each
/// change in turn; nothing here asks again, so a new value is one the read
/// was told of.
function listed(id: string): Array<string | null> {
  const values: Array<string | null> = [];
  stops.push(
    $effect.root(() => {
      $effect(() => {
        const value = shown(id);
        if (values.length === 0 || values.at(-1) !== value) values.push(value);
      });
    }),
  );
  flushSync();
  return values;
}

/// What the depth slider of the tab's menu shows. Opening the menu works the
/// depth out, as it always has.
async function sliderValue(tab: GraphTab): Promise<string> {
  openTabMenu(tab.id, { left: 10, top: 10, right: 10, bottom: 10 });
  await settle(2);
  const value = document.body.querySelector<HTMLInputElement>(".depth-row input[type='range']")!.value;
  closeTabMenu();
  await settle(2);
  return value;
}

/// One more file in the workspace: a new shared graph for every tab.
async function changeGraph(name: string): Promise<void> {
  graphServer.view = {
    nodes: [...graphServer.view.nodes, g.file(`notes/${name}.md`)],
    edges: [...graphServer.view.edges, g.edge(NOTES, `notes/${name}.md`, "contains")],
  };
  await refreshGraph();
  await settle(2);
}

describe("the value of a depth step", () => {
  test("is the slider's: levels below the root, below a selected directory, hops from a file", async () => {
    const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab());
    expect(await sliderValue(tab), "nothing selected reads as the root, one level opened").toBe("1");
    expect([shown(INCREASE), shown(DECREASE)]).toEqual(["1", "1"]);

    canvas.props!.onSelect(NOTES);
    await settle(2);
    expect(await sliderValue(tab), "notes is closed").toBe("0");
    expect([shown(INCREASE), shown(DECREASE)]).toEqual(["0", "0"]);

    run(INCREASE);
    await settle(2);
    expect(tab.depth, "a directory's step opens the tree and leaves the tab's hops alone").toBe(1);
    expect(await sliderValue(tab)).toBe("1");
    expect(shown(INCREASE)).toBe("1");

    canvas.props!.onSelect(A);
    await settle(2);
    run(INCREASE);
    await settle(2);
    expect(await sliderValue(tab), "a.md's references run two hops").toBe("2");
    expect([shown(INCREASE), shown(DECREASE)]).toEqual(["2", "2"]);
  });

  test("follows a step while the row stays listed", async () => {
    await mountGraphPanel(GraphPanel, layout, graphTab());
    const row = listed(INCREASE);
    expect(row).toEqual(["1"]);

    run(INCREASE);
    await settle(2);
    expect(row).toEqual(["1", "2"]);

    run(DECREASE);
    await settle(2);
    expect(row).toEqual(["1", "2", "1"]);
  });

  test("follows the selection while the row stays listed", async () => {
    await mountGraphPanel(GraphPanel, layout, graphTab());
    const row = listed(DECREASE);

    canvas.props!.onSelect(NOTES);
    await settle(2);
    expect(row).toEqual(["1", "0"]);
  });

  test("reaches a row listed before its panel was mounted", async () => {
    const tab = graphTab();
    layout.nodes = { [GRAPH_PANE]: { kind: "leaf", id: GRAPH_PANE, tabs: [tab], activeTabId: tab.id } };
    layout.rootId = GRAPH_PANE;
    layout.activePaneId = GRAPH_PANE;
    const live = (layout.nodes[GRAPH_PANE] as LeafNode).tabs[0] as GraphTab;
    const row = listed(INCREASE);
    expect(row, "no panel yet").toEqual([null]);

    const target = document.createElement("div");
    document.body.append(target);
    const panel = mount(GraphPanel, { target, props: { tab: live, active: true } });
    stops.push(() => void unmount(panel));
    await settle();

    expect(row.at(-1)).toBe("1");
  });
});

describe("a graph that reports no depth", () => {
  test("a tab mounted hidden reports none and works none out", async () => {
    await mountGraphPanel(GraphPanel, layout, graphTab(), { active: false });
    const row = listed(INCREASE);
    await settle(4);

    expect(row).toEqual([null]);
    expect(shown(DECREASE)).toBeNull();
    expect(worked).toEqual({ cap: 0, opened: 0, dir: 0 });
  });

  test("a tab no panel is mounted on reports none", async () => {
    await mountGraphPanel(GraphPanel, layout, graphTab());
    const pane = layout.nodes[GRAPH_PANE] as LeafNode;
    pane.tabs.push(graphTab({ id: "graph-2" }));
    pane.activeTabId = "graph-2";

    expect([shown(INCREASE), shown(DECREASE)]).toEqual([null, null]);
  });

  test("a tab whose panel is destroyed reports none from then on", async () => {
    await mountGraphPanel(GraphPanel, layout, graphTab());
    const row = listed(INCREASE);
    expect(row).toEqual(["1"]);

    // The panel goes and the layout still holds its tab, as it does for the
    // moment between a pane dropping a panel and the tab leaving the layout.
    unmountGraphPanels();
    await settle(2);

    expect(row, "the listed row was told").toEqual(["1", null]);
    expect(shown(INCREASE)).toBeNull();
  });
});

describe("the record of readers", () => {
  test("the removal of a replaced reader leaves its successor's", () => {
    const tab = graphTab({ id: "replaced" });
    const forgetFirst = registerGraphDepthReader(tab.id, () => 4);
    const forgetSecond = registerGraphDepthReader(tab.id, () => 7);

    forgetFirst();
    expect(graphShownDepth(tab), "a panel torn down after its successor mounted").toBe(7);

    forgetSecond();
    expect(graphShownDepth(tab)).toBeNull();
  });
});

describe("what a shown graph works out for the steps", () => {
  test("nothing while no step is listed and its menu is closed", async () => {
    await mountGraphPanel(GraphPanel, layout, graphTab());
    await settle(6);
    canvas.props!.onSelect(A);
    await settle(2);
    canvas.props!.onSelect(NOTES);
    await settle(2);
    for (let i = 0; i < 5; i += 1) await changeGraph(`new${i}`);

    expect(worked).toEqual({ cap: 0, opened: 0, dir: 0 });
  });

  test("the depth while a step is listed, and nothing again once none is", async () => {
    await mountGraphPanel(GraphPanel, layout, graphTab());
    const row = listed(INCREASE);
    expect(row).toEqual(["1"]);
    expect(worked.opened, "the listed row had the depth worked out").toBeGreaterThan(0);

    for (const stop of stops.splice(0)) stop();
    flushSync();
    worked.cap = 0;
    worked.opened = 0;
    worked.dir = 0;
    canvas.props!.onSelect(A);
    await settle(2);
    for (let i = 0; i < 3; i += 1) await changeGraph(`later${i}`);

    expect(worked).toEqual({ cap: 0, opened: 0, dir: 0 });
    expect(row, "a row no longer listed reads nothing more").toEqual(["1"]);
  });
});

describe("the steps under the pane that mounts the panel", () => {
  /// Two panes side by side, each mounted as the app mounts it: `tab` and a
  /// second graph tab in the first, shown and focused, and one in the second.
  async function twoPanes(tab: GraphTab): Promise<{ first: LeafNode; second: LeafNode }> {
    layout.nodes = {
      root: { kind: "split", id: "root", direction: "row", a: "first", b: "second", ratio: 0.5 },
      first: { kind: "leaf", id: "first", tabs: [tab, graphTab({ id: "stays" })], activeTabId: tab.id },
      second: { kind: "leaf", id: "second", tabs: [graphTab({ id: "host" })], activeTabId: "host" },
    } as typeof layout.nodes;
    layout.rootId = "root";
    layout.activePaneId = "first";
    const first = layout.nodes.first as LeafNode;
    const second = layout.nodes.second as LeafNode;
    for (const pane of [first, second]) {
      const target = document.createElement("div");
      document.body.append(target);
      const app = mount(Pane, { target, props: { pane } });
      stops.push(() => void unmount(app));
    }
    await settle();
    return { first, second };
  }

  test("a reorder copies the tab and the value stays, and the next step lands on the copy", async () => {
    const { first } = await twoPanes(graphTab({ id: "moves" }));
    run(INCREASE);
    await settle(4);
    expect(shown(INCREASE)).toBe("2");

    reorderTab("first", "moves", 1);
    await settle(4);
    expect(first.tabs.map((tab) => tab.id)).toEqual(["stays", "moves"]);
    expect(activeGraphTab()?.id).toBe("moves");
    expect(shown(INCREASE)).toBe("2");

    run(DECREASE);
    await settle(4);
    expect(shown(INCREASE)).toBe("1");
  });

  test("a move to another pane hands the value to the panel mounted there", async () => {
    await twoPanes(graphTab({ id: "moves" }));
    const row = listed(INCREASE);
    run(INCREASE);
    await settle(4);
    expect(row).toEqual(["1", "2"]);

    moveTab("first", "moves", "second");
    await settle();
    expect(layout.activePaneId).toBe("second");
    expect(activeGraphTab()?.id).toBe("moves");
    expect(shown(INCREASE), "the tree the tab carried is opened two levels there too").toBe("2");

    run(DECREASE);
    await settle(4);
    expect(row.at(-1), "the listed row follows the panel in the other pane").toBe("1");
  });

  test("a tab switch reads the tab now shown, and Select workspace and a step warn of no foreign write", async () => {
    const { first } = await twoPanes(graphTab({ id: "moves" }));
    run(INCREASE);
    await settle(4);
    const row = listed(INCREASE);
    expect(row).toEqual(["2"]);

    first.activeTabId = "stays";
    await settle(6);
    expect(activeGraphTab()?.id).toBe("stays");
    expect(row, "the other tab's tree is opened one level").toEqual(["2", "1"]);

    run("app.graph.scopeDetails");
    await settle(2);
    run(INCREASE);
    await settle(4);
    expect(row).toEqual(["2", "1", "2"]);
  });
});
