// Where each terminal tab is drawn: the pane that holds it, the side it is
// on, and whether it is the active and focused body, as the pane shows it.

import { afterEach, describe, expect, test, vi } from "vitest";

import { fileTab, terminalTab } from "../__tests__/tabs";
import type { LayoutState, LeafNode, Tab } from "./tabs.svelte";
import { terminalPlacements } from "./terminalDock.svelte";

afterEach(() => {
  vi.restoreAllMocks();
});

function leaf(id: string, tabs: Tab[], extra: Partial<LeafNode> = {}): LeafNode {
  return { kind: "leaf", id, tabs, activeTabId: tabs[0]?.id ?? null, ...extra };
}

/// Two panes side by side, `left` active.
function twoPanes(left: LeafNode, right: LeafNode): LayoutState {
  return {
    rootId: "split",
    nodes: {
      split: { kind: "split", id: "split", direction: "row", a: left.id, b: right.id, ratio: 0.5 },
      [left.id]: left,
      [right.id]: right,
    },
    activePaneId: left.id,
    focusColor: "blue",
  } as LayoutState;
}

function placed(view: LayoutState, navigating = false) {
  return terminalPlacements(view, navigating).map(({ tab, paneId, side, active, focused }) => ({
    id: tab.id,
    paneId,
    side,
    active,
    focused,
  }));
}

describe("terminalPlacements", () => {
  test("places each terminal in its pane, active on its pane's visible side and focused in the active pane", () => {
    const view = twoPanes(
      leaf("left", [terminalTab({ id: "t1" }), terminalTab({ id: "t2" })]),
      leaf("right", [fileTab({ id: "f1", path: "README.md" }), terminalTab({ id: "t3" })], {
        activeTabId: "t3",
        bTabs: [terminalTab({ id: "t4" })],
        bActiveTabId: "t4",
      }),
    );

    expect(placed(view)).toEqual([
      { id: "t1", paneId: "left", side: "a", active: true, focused: true },
      { id: "t2", paneId: "left", side: "a", active: false, focused: false },
      { id: "t3", paneId: "right", side: "a", active: true, focused: false },
      { id: "t4", paneId: "right", side: "b", active: false, focused: false },
    ]);
  });

  test("a pane showing its B side makes that side's terminal the active one", () => {
    const view = twoPanes(
      leaf("left", [terminalTab({ id: "t1" })], {
        side: "b",
        bTabs: [terminalTab({ id: "t2" })],
        bActiveTabId: "t2",
      }),
      leaf("right", []),
    );

    expect(placed(view).map(({ id, side, active, focused }) => ({ id, side, active, focused }))).toEqual([
      { id: "t1", side: "a", active: false, focused: false },
      { id: "t2", side: "b", active: true, focused: true },
    ]);
  });

  test("no terminal is active while Hybrid Nav is on", () => {
    const view = twoPanes(leaf("left", [terminalTab({ id: "t1" })]), leaf("right", []));

    expect(placed(view, true)).toEqual([
      { id: "t1", paneId: "left", side: "a", active: false, focused: false },
    ]);
  });

  test("a tab id two panes list is drawn once, in the first, and the console says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const view = twoPanes(
      leaf("left", [terminalTab({ id: "dup" })]),
      leaf("right", [terminalTab({ id: "dup" })]),
    );

    expect(placed(view).map(({ id, paneId }) => ({ id, paneId }))).toEqual([{ id: "dup", paneId: "left" }]);
    expect(warn).toHaveBeenCalledWith("[chan] panes left and right both list tab dup; drawing the first copy");
  });
});
