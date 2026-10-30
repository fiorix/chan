/// The grid a chan window offers its tmux window. tmux owns a tmux window's
/// geometry: the page folds each pane's host grid (the cells its box can
/// show) over tmux's layout and asks tmux for that window size, once per
/// change; tmux lays its panes out inside it and each pane session learns its
/// size from the layout, which the pane's renderer adopts.

import { tmuxPaneTabs } from "./tabs.svelte";
import type { TmuxLayoutNode } from "./tmuxStatus";

export type TerminalGrid = { cols: number; rows: number };

let layoutTree = $state<TmuxLayoutNode | null>(null);

/// Keep the tree the connection last sent this window, for the window grid.
export function setTmuxLayout(node: TmuxLayoutNode | null): void {
  layoutTree = node;
}

export function tmuxLayout(): TmuxLayoutNode | null {
  return layoutTree;
}

/// Fold the panes' host grids over tmux's layout: a row sums widths and takes
/// the least height, a column the reverse, each with one cell per divider as
/// tmux draws them. Null while a shown pane has no session yet or its host is
/// unmeasured, since a size short of a pane would cut it off.
export function foldWindowGrid(
  node: TmuxLayoutNode,
  hostGrid: (session: string) => TerminalGrid | null,
): TerminalGrid | null {
  if (node.kind === "pane") return node.session ? hostGrid(node.session) : null;
  const children = node.children.filter((child) => child.w > 0 && child.h > 0);
  if (children.length === 0) return null;
  const grids: TerminalGrid[] = [];
  for (const child of children) {
    const grid = foldWindowGrid(child, hostGrid);
    if (!grid) return null;
    grids.push(grid);
  }
  const dividers = grids.length - 1;
  if (node.kind === "row") {
    return {
      cols: grids.reduce((sum, grid) => sum + grid.cols, 0) + dividers,
      rows: Math.min(...grids.map((grid) => grid.rows)),
    };
  }
  return {
    cols: Math.min(...grids.map((grid) => grid.cols)),
    rows: grids.reduce((sum, grid) => sum + grid.rows, 0) + dividers,
  };
}

/// The window grid to ask tmux for now: the layout's fold over this window's
/// tmux pane tabs, or the lone pane's host grid before any layout arrived.
/// Null when nothing is measured yet.
export function tmuxWindowGrid(): TerminalGrid | null {
  const tabs = tmuxPaneTabs();
  if (tabs.length === 0) return null;
  const bySession = new Map(tabs.map((tab) => [tab.terminalSessionId!, tab]));
  const hostGrid = (session: string): TerminalGrid | null => bySession.get(session)?.tmuxHostGrid ?? null;
  const tree = layoutTree;
  if (tree) return foldWindowGrid(tree, hostGrid);
  return tabs.length === 1 ? (tabs[0]!.tmuxHostGrid ?? null) : null;
}
