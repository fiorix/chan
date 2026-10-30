import { describe, expect, it } from "vitest";
import { foldWindowGrid } from "./tmuxWindowSize.svelte";
import type { TmuxLayoutNode } from "./tmuxStatus";

const pane = (session: string | null, w = 10, h = 10): TmuxLayoutNode => ({ kind: "pane", session, w, h });

describe("foldWindowGrid", () => {
  it("folds a row as widths plus a divider and the least height", () => {
    const tree: TmuxLayoutNode = { kind: "row", w: 1, h: 1, children: [pane("a"), pane("b")] };
    const grids: Record<string, { cols: number; rows: number }> = { a: { cols: 80, rows: 24 }, b: { cols: 70, rows: 20 } };
    expect(foldWindowGrid(tree, (s) => grids[s] ?? null)).toEqual({ cols: 151, rows: 20 });
  });

  it("folds a column as heights plus a divider and the least width", () => {
    const tree: TmuxLayoutNode = { kind: "column", w: 1, h: 1, children: [pane("a"), pane("b"), pane("c")] };
    const grids: Record<string, { cols: number; rows: number }> = {
      a: { cols: 80, rows: 10 },
      b: { cols: 78, rows: 12 },
      c: { cols: 90, rows: 7 },
    };
    expect(foldWindowGrid(tree, (s) => grids[s] ?? null)).toEqual({ cols: 78, rows: 31 });
  });

  it("nests, so a split inside a split counts its own divider", () => {
    const tree: TmuxLayoutNode = {
      kind: "column",
      w: 1,
      h: 1,
      children: [{ kind: "row", w: 1, h: 1, children: [pane("a"), pane("b")] }, pane("c")],
    };
    const grid = { cols: 60, rows: 15 };
    expect(foldWindowGrid(tree, () => grid)).toEqual({ cols: 60, rows: 31 });
  });

  it("waits while a pane has no session or no measured host", () => {
    const unmade: TmuxLayoutNode = { kind: "row", w: 1, h: 1, children: [pane("a"), pane(null)] };
    expect(foldWindowGrid(unmade, () => ({ cols: 80, rows: 24 }))).toBeNull();
    const unmeasured: TmuxLayoutNode = { kind: "row", w: 1, h: 1, children: [pane("a"), pane("b")] };
    expect(foldWindowGrid(unmeasured, (s) => (s === "a" ? { cols: 80, rows: 24 } : null))).toBeNull();
  });

  it("skips a child tmux gave no cells", () => {
    const tree: TmuxLayoutNode = { kind: "row", w: 1, h: 1, children: [pane("a"), pane("gone", 0, 0)] };
    expect(foldWindowGrid(tree, (s) => (s === "a" ? { cols: 80, rows: 24 } : null))).toEqual({ cols: 80, rows: 24 });
  });
});
