// One divider move. A drag sets a split's share outright, and a Hybrid Nav
// resize key and a divider command step it; all three write the share
// through moveDivider, so a pane keeps the same share at either end however
// its divider got there, and the step and the split it lands on are one rule
// for the key in the mode's draft and the command on the live layout.

import { afterEach, describe, expect, test } from "vitest";

import { resetLayout } from "../__tests__/tabs";
import {
  cancelPaneMode,
  dividerSplit,
  enterPaneMode,
  layout,
  moveDivider,
  paneMode,
  paneModeResize,
  stepDivider,
  type LeafNode,
  type SplitNode,
} from "./tabs.svelte";

const leaf = (id: string): LeafNode => ({ kind: "leaf", id, tabs: [], activeTabId: null });

const split = (
  id: string,
  direction: SplitNode["direction"],
  a: string,
  b: string,
  ratio = 0.5,
): SplitNode => ({ kind: "split", id, direction, a, b, ratio });

/// A window split left and right, its right half split top and bottom, and
/// the bottom of that split left and right again:
///
///   left | top
///        | -------------
///        | inner | outer
function nested(active: string): void {
  layout.nodes = {
    left: leaf("left"),
    top: leaf("top"),
    inner: leaf("inner"),
    outer: leaf("outer"),
    bottom: split("bottom", "row", "inner", "outer"),
    column: split("column", "column", "top", "bottom"),
    row: split("row", "row", "left", "column"),
  };
  layout.rootId = "row";
  layout.activePaneId = active;
}

afterEach(() => {
  cancelPaneMode();
  resetLayout();
});

describe("moveDivider", () => {
  test("sets the share the left or top child takes", () => {
    const node = split("s", "row", "a", "b");

    moveDivider(node, 0.3);
    expect(node.ratio).toBe(0.3);
    moveDivider(node, 0.72);
    expect(node.ratio).toBe(0.72);
  });

  test("leaves each pane the share it keeps at either end", () => {
    const node = split("s", "row", "a", "b");

    moveDivider(node, 2);
    expect(node.ratio).toBe(0.95);
    moveDivider(node, 0.96);
    expect(node.ratio).toBe(0.95);
    moveDivider(node, -1);
    expect(node.ratio).toBe(0.05);
    moveDivider(node, 0.049);
    expect(node.ratio).toBe(0.05);
  });

  test("lets a tmux window's divider reach the edge, where tmux holds its own minimum", () => {
    const node = split("s", "column", "a", "b");

    moveDivider(node, 0.99, true);
    expect(node.ratio).toBe(0.99);
    moveDivider(node, 3, true);
    expect(node.ratio).toBe(1);
    moveDivider(node, -3, true);
    expect(node.ratio).toBe(0);
  });
});

describe("stepDivider", () => {
  test("moves the divider one step toward the right or the bottom, or back", () => {
    const node = split("s", "row", "a", "b");

    stepDivider(node, true);
    expect(node.ratio).toBeCloseTo(0.52, 10);
    stepDivider(node, false);
    stepDivider(node, false);
    expect(node.ratio).toBeCloseTo(0.48, 10);
  });

  test("stops where a drag past the edge stops", () => {
    for (const forward of [true, false]) {
      const stepped = split("stepped", "row", "a", "b");
      for (let step = 0; step < 40; step += 1) stepDivider(stepped, forward);
      const dragged = split("dragged", "row", "a", "b");
      moveDivider(dragged, forward ? 5 : -5);

      expect(stepped.ratio).toBe(dragged.ratio);
    }
  });

  test("steps a tmux window's divider past the share a plain pane keeps", () => {
    const node = split("s", "row", "a", "b", 0.95);

    stepDivider(node, true, true);
    expect(node.ratio).toBeCloseTo(0.97, 10);
    stepDivider(node, true);
    expect(node.ratio).toBe(0.95);
  });
});

describe("dividerSplit", () => {
  test("is the nearest split on the axis that holds the pane", () => {
    nested("inner");

    expect(dividerSplit(layout, "inner", "row")?.id).toBe("bottom");
    expect(dividerSplit(layout, "inner", "column")?.id).toBe("column");
    expect(dividerSplit(layout, "top", "row")?.id).toBe("row");
    expect(dividerSplit(layout, "top", "column")?.id).toBe("column");
    expect(dividerSplit(layout, "left", "row")?.id).toBe("row");
  });

  test("is none for a pane with no split on the axis", () => {
    nested("left");
    expect(dividerSplit(layout, "left", "column")).toBeNull();

    resetLayout();
    expect(dividerSplit(layout, layout.activePaneId, "row")).toBeNull();
    expect(dividerSplit(layout, layout.activePaneId, "column")).toBeNull();
  });

  test("reads the layout it is given, so Hybrid Nav's key steps the draft and leaves the live layout", () => {
    nested("inner");
    enterPaneMode();
    const draft = paneMode.draft!;

    paneModeResize("row", true);
    paneModeResize("column", false);

    expect(dividerSplit(draft, "inner", "row")?.ratio).toBeCloseTo(0.52, 10);
    expect(dividerSplit(draft, "inner", "column")?.ratio).toBeCloseTo(0.48, 10);
    expect((draft.nodes.row as SplitNode).ratio).toBe(0.5);
    expect(dividerSplit(layout, "inner", "row")?.ratio).toBe(0.5);
    expect(dividerSplit(layout, "inner", "column")?.ratio).toBe(0.5);
  });
});
