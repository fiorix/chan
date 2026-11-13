// The sides of a pane that are edges of the window: every side of a lone
// pane, the outer sides of a split's panes, and never the side a docked file
// browser holds.

import { describe, expect, test } from "vitest";

import { windowEdges, type PaneEdges } from "./paneEdges";
import type { LayoutState, Node } from "./tabs.svelte";

const UNDOCKED = { left: false, right: false };

function leaf(id: string): Node {
  return { kind: "leaf", id, tabs: [], activeTabId: null } as unknown as Node;
}

function split(id: string, direction: "row" | "column", a: string, b: string): Node {
  return { kind: "split", id, direction, ratio: 0.5, a, b };
}

function layoutOf(rootId: string, nodes: Node[]): LayoutState {
  return {
    rootId,
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    activePaneId: rootId,
    focusColor: "blue",
  };
}

function sides(edges: PaneEdges): string {
  return (["top", "right", "bottom", "left"] as const).filter((side) => edges[side]).join(" ");
}

describe("windowEdges", () => {
  test("a lone pane touches every edge", () => {
    const state = layoutOf("only", [leaf("only")]);
    expect(sides(windowEdges(state, "only", UNDOCKED))).toBe("top right bottom left");
  });

  test("a row split keeps the outer sides and drops the shared one", () => {
    const state = layoutOf("root", [split("root", "row", "l", "r"), leaf("l"), leaf("r")]);
    expect(sides(windowEdges(state, "l", UNDOCKED))).toBe("top bottom left");
    expect(sides(windowEdges(state, "r", UNDOCKED))).toBe("top right bottom");
  });

  test("a column split keeps the outer sides and drops the shared one", () => {
    const state = layoutOf("root", [split("root", "column", "t", "b"), leaf("t"), leaf("b")]);
    expect(sides(windowEdges(state, "t", UNDOCKED))).toBe("top right left");
    expect(sides(windowEdges(state, "b", UNDOCKED))).toBe("right bottom left");
  });

  test("a nested split narrows the inner panes side by side", () => {
    // Left pane full height; the right half stacks two panes, and the lower
    // of those splits again into a left and a right pane.
    const state = layoutOf("root", [
      split("root", "row", "l", "stack"),
      leaf("l"),
      split("stack", "column", "rt", "low"),
      leaf("rt"),
      split("low", "row", "rbl", "rbr"),
      leaf("rbl"),
      leaf("rbr"),
    ]);
    expect(sides(windowEdges(state, "l", UNDOCKED))).toBe("top bottom left");
    expect(sides(windowEdges(state, "rt", UNDOCKED))).toBe("top right");
    expect(sides(windowEdges(state, "rbl", UNDOCKED))).toBe("bottom");
    expect(sides(windowEdges(state, "rbr", UNDOCKED))).toBe("right bottom");
  });

  test("a docked file browser takes its side from every pane", () => {
    const state = layoutOf("root", [split("root", "row", "l", "r"), leaf("l"), leaf("r")]);
    expect(sides(windowEdges(state, "l", { left: true, right: false }))).toBe("top bottom");
    expect(sides(windowEdges(state, "r", { left: false, right: true }))).toBe("top bottom");
    const lone = layoutOf("only", [leaf("only")]);
    expect(sides(windowEdges(lone, "only", { left: true, right: true }))).toBe("top bottom");
  });

  test("a pane the layout does not hold has no edge", () => {
    const state = layoutOf("only", [leaf("only")]);
    expect(sides(windowEdges(state, "gone", UNDOCKED))).toBe("");
  });
});
