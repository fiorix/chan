// @vitest-environment jsdom

import { afterEach, describe, expect, test } from "vitest";
import {
  classifyMouseSplitZone,
  edgeSplitAllowed,
  edgeSplitSpec,
  MIN_SPLIT_PANE_HEIGHT,
  MIN_SPLIT_PANE_WIDTH,
  type PaneMouseSplitEdge,
} from "./paneMouseSplit";
import {
  allPaneTabs,
  cancelPaneMode,
  commitPaneMode,
  enterPaneModeTransaction,
  layout,
  paneMode,
  paneModeMoveGrabToEdge,
  paneModeSetGrab,
  paneModeSetHover,
  paneModeSetMouseSplit,
  paneModeSplit,
  paneModeSwapWith,
  serializeLayout,
  splitPane,
  type LeafNode,
  type SplitNode,
  type TerminalTab,
} from "./tabs.svelte";

// Hybrid Nav mouse split affordances. The geometry half pins the pure
// zone classifier and the minimum-size gate; the transaction half pins
// draft-only staging: hover never mutates, mouseup moves the grabbed
// content into the target's new edge split and leaves the source leaf
// empty, Enter seals, Esc restores the byte-equivalent live layout.

function termTab(id: string): TerminalTab {
  return {
    kind: "terminal",
    id,
    title: id,
    createdAt: 1,
    broadcastEnabled: false,
    broadcastTargetIds: [],
  };
}

/// Live two-pane row split: left holds `term-left`, right holds
/// `term-right`. Returns the two leaves.
function twoPaneLayout(): { left: LeafNode; right: LeafNode } {
  const left: LeafNode = {
    kind: "leaf",
    id: "pane-left",
    tabs: [termTab("term-left")],
    activeTabId: "term-left",
  };
  layout.rootId = left.id;
  layout.activePaneId = left.id;
  layout.nodes = { [left.id]: left };
  layout.focusColor = "blue";
  splitPane(left.id, "row", "after");
  const root = layout.nodes[layout.rootId];
  if (root?.kind !== "split") throw new Error("expected split");
  const right = layout.nodes[root.b];
  if (right?.kind !== "leaf") throw new Error("expected leaf");
  right.tabs.push(termTab("term-right"));
  right.activeTabId = "term-right";
  layout.activePaneId = left.id;
  return { left, right };
}

function draftLeaf(paneId: string): LeafNode {
  const node = paneMode.draft?.nodes[paneId];
  if (!node || node.kind !== "leaf") throw new Error(`expected draft leaf: ${paneId}`);
  return node;
}

/// The split node directly parenting `childId` inside the draft.
function draftParentSplit(childId: string): SplitNode {
  const parent = Object.values(paneMode.draft?.nodes ?? {}).find(
    (n): n is SplitNode =>
      n.kind === "split" && (n.a === childId || n.b === childId),
  );
  if (!parent) throw new Error(`expected draft parent split for: ${childId}`);
  return parent;
}

afterEach(() => {
  cancelPaneMode();
  const solo: LeafNode = {
    kind: "leaf",
    id: "pane-solo",
    tabs: [],
    activeTabId: null,
  };
  layout.rootId = solo.id;
  layout.activePaneId = solo.id;
  layout.nodes = { [solo.id]: solo };
});

describe("classifyMouseSplitZone", () => {
  test("edge zones span the outer 25 percent of each axis", () => {
    expect(classifyMouseSplitZone(0, 200, 400, 400)).toBe("left");
    expect(classifyMouseSplitZone(99.9, 200, 400, 400)).toBe("left");
    expect(classifyMouseSplitZone(300.1, 200, 400, 400)).toBe("right");
    expect(classifyMouseSplitZone(400, 200, 400, 400)).toBe("right");
    expect(classifyMouseSplitZone(200, 0, 400, 400)).toBe("top");
    expect(classifyMouseSplitZone(200, 99.9, 400, 400)).toBe("top");
    expect(classifyMouseSplitZone(200, 300.1, 400, 400)).toBe("bottom");
    expect(classifyMouseSplitZone(200, 400, 400, 400)).toBe("bottom");
  });

  test("the exact quarter lines belong to the center", () => {
    expect(classifyMouseSplitZone(100, 200, 400, 400)).toBe("center");
    expect(classifyMouseSplitZone(300, 200, 400, 400)).toBe("center");
    expect(classifyMouseSplitZone(200, 100, 400, 400)).toBe("center");
    expect(classifyMouseSplitZone(200, 300, 400, 400)).toBe("center");
    expect(classifyMouseSplitZone(200, 200, 400, 400)).toBe("center");
  });

  test("corners resolve to the nearer edge, ties break horizontally", () => {
    expect(classifyMouseSplitZone(40, 20, 400, 400)).toBe("top");
    expect(classifyMouseSplitZone(20, 40, 400, 400)).toBe("left");
    expect(classifyMouseSplitZone(40, 40, 400, 400)).toBe("left");
    expect(classifyMouseSplitZone(380, 390, 400, 400)).toBe("bottom");
    expect(classifyMouseSplitZone(390, 380, 400, 400)).toBe("right");
  });

  test("fractions, not pixels: the same ratio classifies identically at any size", () => {
    expect(classifyMouseSplitZone(26, 500, 100, 1000)).toBe("center");
    expect(classifyMouseSplitZone(24, 500, 100, 1000)).toBe("left");
    expect(classifyMouseSplitZone(500, 4, 1000, 100)).toBe("top");
  });

  test("degenerate rects classify as center", () => {
    expect(classifyMouseSplitZone(0, 0, 0, 0)).toBe("center");
    expect(classifyMouseSplitZone(10, 10, -5, 100)).toBe("center");
  });
});

describe("edgeSplitSpec", () => {
  test("each edge maps to its canonical split orientation and placement", () => {
    expect(edgeSplitSpec("left")).toEqual({ direction: "row", placement: "before" });
    expect(edgeSplitSpec("right")).toEqual({ direction: "row", placement: "after" });
    expect(edgeSplitSpec("top")).toEqual({ direction: "column", placement: "before" });
    expect(edgeSplitSpec("bottom")).toEqual({ direction: "column", placement: "after" });
  });
});

describe("edgeSplitAllowed", () => {
  test("the minimum pane size is 240 by 160", () => {
    expect(MIN_SPLIT_PANE_WIDTH).toBe(240);
    expect(MIN_SPLIT_PANE_HEIGHT).toBe(160);
  });

  test("horizontal edges halve the width: exact acceptance, one pixel under refuses", () => {
    expect(edgeSplitAllowed("left", 480, 160)).toBe(true);
    expect(edgeSplitAllowed("right", 480, 160)).toBe(true);
    expect(edgeSplitAllowed("left", 479, 160)).toBe(false);
    expect(edgeSplitAllowed("left", 480, 159)).toBe(false);
  });

  test("vertical edges halve the height: exact acceptance, one pixel under refuses", () => {
    expect(edgeSplitAllowed("top", 240, 320)).toBe(true);
    expect(edgeSplitAllowed("bottom", 240, 320)).toBe(true);
    expect(edgeSplitAllowed("top", 239, 320)).toBe(false);
    expect(edgeSplitAllowed("top", 240, 319)).toBe(false);
  });
});

describe("paneMode mouse split transaction", () => {
  test("hover arms preview state only; neither draft nor live layout changes", () => {
    const { left, right } = twoPaneLayout();
    enterPaneModeTransaction(left.id);
    const draftIdsBefore = Object.keys(paneMode.draft?.nodes ?? {}).sort();
    const liveBefore = JSON.stringify(serializeLayout({ terminalSessions: true }));

    paneModeSetGrab(left.id);
    paneModeSetHover(right.id);
    paneModeSetMouseSplit({ paneId: right.id, edge: "left" });

    expect(paneMode.mouseSplit).toEqual({ paneId: right.id, edge: "left" });
    expect(Object.keys(paneMode.draft?.nodes ?? {}).sort()).toEqual(draftIdsBefore);
    expect(JSON.stringify(serializeLayout({ terminalSessions: true }))).toBe(liveBefore);
  });

  test("edge drop splits the target, moves the grabbed content, and leaves an empty source leaf", () => {
    const { left, right } = twoPaneLayout();
    enterPaneModeTransaction(left.id);
    paneModeMoveGrabToEdge(left.id, right.id, "left");

    const draft = paneMode.draft;
    expect(draft).not.toBeNull();
    // Live had 3 nodes (root split + 2 leaves); the draft gains a split
    // and a leaf.
    expect(Object.keys(draft!.nodes)).toHaveLength(5);

    const parent = draftParentSplit(right.id);
    expect(parent.direction).toBe("row");
    expect(parent.b).toBe(right.id);
    const moved = draftLeaf(parent.a);
    expect(moved.tabs.map((t) => t.id)).toEqual(["term-left"]);
    expect(moved.activeTabId).toBe("term-left");
    expect(draft!.activePaneId).toBe(moved.id);

    // The sole-tab source stays behind as an empty leaf, uncollapsed.
    const source = draftLeaf(left.id);
    expect(allPaneTabs(source)).toHaveLength(0);
    expect(source.activeTabId).toBeNull();

    // The live layout is untouched until Enter seals the draft.
    expect(Object.keys(layout.nodes)).toHaveLength(3);
    const liveLeft = layout.nodes[left.id];
    expect(liveLeft?.kind === "leaf" && liveLeft.tabs[0]?.id).toBe("term-left");
  });

  test("each edge lands the moved content on its canonical side of the new split", () => {
    const cases: Array<{
      edge: PaneMouseSplitEdge;
      direction: "row" | "column";
      placement: "before" | "after";
    }> = [
      { edge: "left", direction: "row", placement: "before" },
      { edge: "right", direction: "row", placement: "after" },
      { edge: "top", direction: "column", placement: "before" },
      { edge: "bottom", direction: "column", placement: "after" },
    ];
    for (const { edge, direction, placement } of cases) {
      const { left, right } = twoPaneLayout();
      enterPaneModeTransaction(left.id);
      paneModeMoveGrabToEdge(left.id, right.id, edge);
      const parent = draftParentSplit(right.id);
      expect(parent.direction).toBe(direction);
      const movedId = placement === "before" ? parent.a : parent.b;
      const keptId = placement === "before" ? parent.b : parent.a;
      expect(keptId).toBe(right.id);
      const moved = draftLeaf(movedId);
      expect(moved.tabs.map((t) => t.id)).toEqual(["term-left"]);
      cancelPaneMode();
    }
  });

  test("moving a pane with both sides populated carries both tab lists", () => {
    const { left, right } = twoPaneLayout();
    left.bTabs = [termTab("term-left-b")];
    left.bActiveTabId = "term-left-b";
    enterPaneModeTransaction(left.id);
    paneModeMoveGrabToEdge(left.id, right.id, "right");

    const parent = draftParentSplit(right.id);
    const moved = draftLeaf(parent.b);
    expect(moved.tabs.map((t) => t.id)).toEqual(["term-left"]);
    expect(moved.bTabs?.map((t) => t.id)).toEqual(["term-left-b"]);
    const source = draftLeaf(left.id);
    expect(allPaneTabs(source)).toHaveLength(0);
    expect(source.bTabs).toBeUndefined();
  });

  test("Enter seals the staged split into the live layout exactly once", () => {
    const { left, right } = twoPaneLayout();
    enterPaneModeTransaction(left.id);
    paneModeMoveGrabToEdge(left.id, right.id, "right");
    commitPaneMode();

    expect(paneMode.active).toBe(false);
    expect(paneMode.mouseSplit).toBeNull();
    expect(Object.keys(layout.nodes)).toHaveLength(5);
    const liveLeft = layout.nodes[left.id];
    expect(liveLeft?.kind === "leaf" && allPaneTabs(liveLeft)).toHaveLength(0);
    const parent = Object.values(layout.nodes).find(
      (n): n is SplitNode =>
        n.kind === "split" && (n.a === right.id || n.b === right.id),
    );
    expect(parent?.kind).toBe("split");
    const moved = layout.nodes[parent!.b];
    expect(moved?.kind === "leaf" && moved.tabs[0]?.id).toBe("term-left");

    // A second Enter is a no-op: nothing re-seals.
    commitPaneMode();
    expect(Object.keys(layout.nodes)).toHaveLength(5);
  });

  test("Escape discards the draft and restores the byte-equivalent live layout", () => {
    const { left, right } = twoPaneLayout();
    const before = JSON.stringify(serializeLayout({ terminalSessions: true }));
    enterPaneModeTransaction(left.id);
    paneModeSetGrab(left.id);
    paneModeSetHover(right.id);
    paneModeSetMouseSplit({ paneId: right.id, edge: "bottom" });
    paneModeMoveGrabToEdge(left.id, right.id, "bottom");
    cancelPaneMode();

    expect(JSON.stringify(serializeLayout({ terminalSessions: true }))).toBe(before);
    expect(paneMode.mouseSplit).toBeNull();
    expect(paneMode.grabPaneId).toBeNull();
    expect(paneMode.hoverPaneId).toBeNull();
  });

  test("a center drop keeps the existing swap semantics", () => {
    const { left, right } = twoPaneLayout();
    enterPaneModeTransaction(left.id);
    paneModeSwapWith(left.id, right.id);

    // Swap exchanges content without growing the tree.
    expect(Object.keys(paneMode.draft?.nodes ?? {})).toHaveLength(3);
    expect(draftLeaf(left.id).tabs[0]?.id).toBe("term-right");
    expect(draftLeaf(right.id).tabs[0]?.id).toBe("term-left");
  });

  test("keyboard splits still stage into the draft during a mouse transaction", () => {
    const { left } = twoPaneLayout();
    enterPaneModeTransaction(left.id);
    paneModeSplit("column");

    const draft = paneMode.draft;
    expect(Object.keys(draft?.nodes ?? {})).toHaveLength(5);
    expect(Object.keys(layout.nodes)).toHaveLength(3);
    const parent = draftParentSplit(left.id);
    expect(parent.direction).toBe("column");
  });

  test("preview and move are refused while the transaction is stale", () => {
    const { left, right } = twoPaneLayout();
    enterPaneModeTransaction(left.id);
    paneMode.stale = true;
    paneModeSetMouseSplit({ paneId: right.id, edge: "left" });
    expect(paneMode.mouseSplit).toBeNull();
    paneModeMoveGrabToEdge(left.id, right.id, "left");
    expect(Object.keys(paneMode.draft?.nodes ?? {})).toHaveLength(3);
    paneMode.stale = false;
  });

  test("a new or cleared grab drops the armed edge preview and hover", () => {
    const { left, right } = twoPaneLayout();
    enterPaneModeTransaction(left.id);
    paneModeSetHover(right.id);
    paneModeSetMouseSplit({ paneId: right.id, edge: "left" });

    // Re-grabbing the preview target must not inherit its target state.
    paneModeSetGrab(right.id);
    expect(paneMode.grabPaneId).toBe(right.id);
    expect(paneMode.hoverPaneId).toBeNull();
    expect(paneMode.mouseSplit).toBeNull();

    // Clearing the grab outright does the same.
    paneModeSetHover(right.id);
    paneModeSetMouseSplit({ paneId: right.id, edge: "top" });
    paneModeSetGrab(null);
    expect(paneMode.grabPaneId).toBeNull();
    expect(paneMode.hoverPaneId).toBeNull();
    expect(paneMode.mouseSplit).toBeNull();

    // Neither tree changed shape through any of it.
    expect(Object.keys(paneMode.draft?.nodes ?? {})).toHaveLength(3);
    expect(Object.keys(layout.nodes)).toHaveLength(3);
  });
});
