// @vitest-environment jsdom
//
// A graph tab moved to another pane. Two Panes are mounted over a split with
// GraphCanvas replaced by a stand-in; a move mounts a new panel for the tab,
// and the assertions read the moved tab and the props that panel hands its
// canvas.

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
import {
  canvas,
  g,
  graphServer,
  graphTab,
  installGraphDom,
  resetGraphServer,
  settle,
  type CanvasProps,
} from "../__tests__/graphPanel";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { closeTabMenu } from "../state/tabMenu.svelte";
import { layout, moveTab, tabLabel, type GraphTab, type LeafNode } from "../state/tabs.svelte";

installGraphDom();

let timers: TimerTrack;
const mounted: Array<Record<string, unknown>> = [];

beforeEach(() => {
  timers = trackTimers();
  resetGraphServer();
  graphServer.view = {
    nodes: [
      g.dir(""),
      g.dir("notes"),
      g.file("notes/a.md"),
      g.file("notes/b.md"),
      g.file("notes/c.md"),
      g.mention("alice"),
      g.mention("bob"),
    ],
    edges: [
      g.edge("", "directory:notes", "contains"),
      g.edge("directory:notes", "notes/a.md", "contains"),
      g.edge("directory:notes", "notes/b.md", "contains"),
      g.edge("directory:notes", "notes/c.md", "contains"),
      g.edge("notes/a.md", "@@alice", "mention"),
      g.edge("notes/b.md", "@@alice", "mention"),
      g.edge("notes/c.md", "@@bob", "mention"),
    ],
  };
});

afterEach(async () => {
  closeTabMenu();
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
  await settle(2);
  timers.release();
});

/// Two panes side by side. `first` holds the tab under test beside a second
/// graph tab, so the move does not empty and collapse it; `second` holds a
/// graph tab of its own.
async function renderSplit(tab: GraphTab): Promise<{ first: LeafNode; second: LeafNode }> {
  layout.nodes = {
    root: { kind: "split", id: "root", direction: "row", a: "first", b: "second", ratio: 0.5 },
    first: {
      kind: "leaf",
      id: "first",
      tabs: [tab, graphTab({ id: "stays" })],
      activeTabId: tab.id,
    },
    second: {
      kind: "leaf",
      id: "second",
      tabs: [graphTab({ id: "host" })],
      activeTabId: "host",
    },
  } as typeof layout.nodes;
  layout.rootId = "root";
  layout.activePaneId = "first";
  const first = layout.nodes.first as LeafNode;
  const second = layout.nodes.second as LeafNode;
  for (const pane of [first, second]) {
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(Pane, { target, props: { pane } }) as Record<string, unknown>);
  }
  await settle();
  return { first, second };
}

/// Moves the tab under test into `second` and returns it with the canvas
/// props of the panel the move mounted for it.
async function moveAcross(second: LeafNode): Promise<{ tab: GraphTab; moved: CanvasProps }> {
  const canvasesBefore = canvas.all.length;
  moveTab("first", "lens", "second");
  await settle();
  expect(canvas.all.length - canvasesBefore, "the move mounts one new panel").toBe(1);
  const tab = second.tabs.find((t) => t.id === "lens") as GraphTab;
  expect(second.activeTabId).toBe("lens");
  return { tab, moved: canvas.all[canvas.all.length - 1]! };
}

describe("a graph tab moved to another pane", () => {
  // The tab a contact pill of the workspace's Details opens: the whole
  // workspace, with the mention selected.
  test("keeps the selection of a workspace graph opened at a node", async () => {
    const { first, second } = await renderSplit(
      graphTab({ id: "lens", title: "path=workspace", pendingSelectId: "@@alice" }),
    );
    const source = first.tabs[0] as GraphTab;
    expect(canvas.all[0]!.selectedId, "selected before the move").toBe("@@alice");
    expect(tabLabel(source)).toBe("path=@@alice");

    const { tab, moved } = await moveAcross(second);
    expect(moved.selectedId, "the new panel selects the tab's node").toBe("@@alice");
    expect(tab.selectedNodeId).toBe("@@alice");
    expect(tab.pendingSelectId, "resolved by the load, not left waiting").toBeNull();
    expect(tabLabel(tab)).toBe("path=@@alice");
    expect(tab.inspectorOpen).toBe(true);
  });

  test("keeps what the selection revealed, the tree it opened and its hops", async () => {
    const { first, second } = await renderSplit(
      graphTab({ id: "lens", title: "path=workspace", pendingSelectId: "@@alice", depth: 2 }),
    );
    const source = first.tabs[0] as GraphTab;
    source.expanded = { "": true, notes: true };
    await settle();
    const shown = [...canvas.all[0]!.visibleNodeIds].sort();
    expect(shown, "alice's notes, and c.md under the opened notes/").toEqual(
      ["", "@@alice", "@@bob", "directory:notes", "notes/a.md", "notes/b.md", "notes/c.md"].sort(),
    );

    const { tab, moved } = await moveAcross(second);
    expect(moved.selectedId).toBe("@@alice");
    expect(moved.focalIds).toEqual([""]);
    expect([...moved.visibleNodeIds].sort()).toEqual(shown);
    expect(tab.depth).toBe(2);
    expect(tab.expanded).toEqual({ "": true, notes: true });
  });

  test("keeps Details closed when it was closed", async () => {
    const { first, second } = await renderSplit(
      graphTab({ id: "lens", title: "path=workspace", pendingSelectId: "notes/a.md" }),
    );
    (first.tabs[0] as GraphTab).inspectorOpen = false;
    await settle();

    const { tab, moved } = await moveAcross(second);
    expect(moved.selectedId).toBe("notes/a.md");
    expect(tab.inspectorOpen, "resuming a selection does not open Details").toBe(false);
  });

  test("drops a selection whose node is gone, without waiting on it", async () => {
    const { first, second } = await renderSplit(
      graphTab({ id: "lens", title: "path=workspace", pendingSelectId: "@@bob" }),
    );
    expect((first.tabs[0] as GraphTab).selectedNodeId).toBe("@@bob");
    graphServer.view = {
      nodes: graphServer.view.nodes.filter((n) => n.id !== "@@bob"),
      edges: graphServer.view.edges.filter((e) => e.target !== "@@bob"),
    };

    const { tab, moved } = await moveAcross(second);
    expect(moved.selectedId).toBeNull();
    expect(tab.pendingSelectId).toBeNull();
  });
});
