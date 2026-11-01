// The window grid a tmux window asks for is the panes' host grids folded over
// tmux's layout. The pane tree's area is the ask's trigger, kept as a box and
// never a size. A divider drag holds the ask from the press to the release,
// and a release that sent a request holds it until tmux's layout answers, or
// for a bounded wait when no layout comes.

import { afterEach, describe, expect, test, vi } from "vitest";
import type { TmuxLayoutNode } from "./tmux";
import {
  endTmuxDrag,
  foldWindowGrid,
  setTmuxLayout,
  setTmuxPaneArea,
  startTmuxDrag,
  TMUX_DRAG_ANSWER_MS,
  tmuxPaneArea,
  tmuxWindowSizeHeld,
} from "./tmuxWindowSize.svelte";

const pane = (session: string | null, w = 10, h = 10): TmuxLayoutNode => ({ kind: "pane", session, w, h });

const TREE: TmuxLayoutNode = { kind: "row", w: 120, h: 40, children: [pane("a", 60, 40), pane("b", 59, 40)] };

afterEach(() => {
  setTmuxLayout(null);
  setTmuxPaneArea(null);
  endTmuxDrag(false);
  vi.useRealTimers();
});

describe("foldWindowGrid", () => {
  test("folds a row as widths plus a divider and the least height", () => {
    const tree: TmuxLayoutNode = { kind: "row", w: 1, h: 1, children: [pane("a"), pane("b")] };
    const grids: Record<string, { cols: number; rows: number }> = { a: { cols: 80, rows: 24 }, b: { cols: 70, rows: 20 } };
    expect(foldWindowGrid(tree, (s) => grids[s] ?? null)).toEqual({ cols: 151, rows: 20 });
  });

  test("folds a column as heights plus a divider and the least width", () => {
    const tree: TmuxLayoutNode = { kind: "column", w: 1, h: 1, children: [pane("a"), pane("b"), pane("c")] };
    const grids: Record<string, { cols: number; rows: number }> = {
      a: { cols: 80, rows: 10 },
      b: { cols: 78, rows: 12 },
      c: { cols: 90, rows: 7 },
    };
    expect(foldWindowGrid(tree, (s) => grids[s] ?? null)).toEqual({ cols: 78, rows: 31 });
  });

  test("nests, so a split inside a split counts its own divider", () => {
    const tree: TmuxLayoutNode = {
      kind: "column",
      w: 1,
      h: 1,
      children: [{ kind: "row", w: 1, h: 1, children: [pane("a"), pane("b")] }, pane("c")],
    };
    const grid = { cols: 60, rows: 15 };
    expect(foldWindowGrid(tree, () => grid)).toEqual({ cols: 60, rows: 31 });
  });

  test("waits while a pane has no session or no measured host", () => {
    const unmade: TmuxLayoutNode = { kind: "row", w: 1, h: 1, children: [pane("a"), pane(null)] };
    expect(foldWindowGrid(unmade, () => ({ cols: 80, rows: 24 }))).toBeNull();
    const unmeasured: TmuxLayoutNode = { kind: "row", w: 1, h: 1, children: [pane("a"), pane("b")] };
    expect(foldWindowGrid(unmeasured, (s) => (s === "a" ? { cols: 80, rows: 24 } : null))).toBeNull();
  });

  test("skips a child tmux gave no cells", () => {
    const tree: TmuxLayoutNode = { kind: "row", w: 1, h: 1, children: [pane("a"), pane("gone", 0, 0)] };
    expect(foldWindowGrid(tree, (s) => (s === "a" ? { cols: 80, rows: 24 } : null))).toEqual({ cols: 80, rows: 24 });
  });
});

describe("tmuxPaneArea", () => {
  test("keeps the last box and takes a repeat as no change", () => {
    expect(tmuxPaneArea()).toBeNull();
    setTmuxPaneArea({ width: 1400, height: 900 });
    const first = tmuxPaneArea();
    expect(first).toEqual({ width: 1400, height: 900 });
    setTmuxPaneArea({ width: 1400, height: 900 });
    expect(tmuxPaneArea()).toBe(first);
    setTmuxPaneArea({ width: 1000, height: 900 });
    expect(tmuxPaneArea()).toEqual({ width: 1000, height: 900 });
    setTmuxPaneArea(null);
    expect(tmuxPaneArea()).toBeNull();
  });
});

describe("the drag hold", () => {
  test("holds from the press to a release that sent nothing", () => {
    expect(tmuxWindowSizeHeld()).toBe(false);
    startTmuxDrag();
    expect(tmuxWindowSizeHeld()).toBe(true);
    setTmuxLayout(TREE);
    expect(tmuxWindowSizeHeld(), "a layout during the press answers no request").toBe(true);
    endTmuxDrag(false);
    expect(tmuxWindowSizeHeld()).toBe(false);
  });

  test("holds a release that sent a request until the layout answering it", () => {
    startTmuxDrag();
    endTmuxDrag(true);
    expect(tmuxWindowSizeHeld()).toBe(true);
    setTmuxLayout(TREE);
    expect(tmuxWindowSizeHeld()).toBe(false);
  });

  test("frees a request tmux never answers after the bounded wait", () => {
    vi.useFakeTimers();
    startTmuxDrag();
    endTmuxDrag(true);
    vi.advanceTimersByTime(TMUX_DRAG_ANSWER_MS - 1);
    expect(tmuxWindowSizeHeld()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tmuxWindowSizeHeld()).toBe(false);
  });

  test("a new press outlasts the wait of the release before it", () => {
    vi.useFakeTimers();
    startTmuxDrag();
    endTmuxDrag(true);
    startTmuxDrag();
    vi.advanceTimersByTime(TMUX_DRAG_ANSWER_MS);
    expect(tmuxWindowSizeHeld()).toBe(true);
    endTmuxDrag(false);
    expect(tmuxWindowSizeHeld()).toBe(false);
  });
});
