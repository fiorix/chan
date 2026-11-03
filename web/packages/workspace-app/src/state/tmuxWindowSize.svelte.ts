/// The grid a chan window offers its tmux window. tmux owns a tmux window's
/// geometry: the page folds each pane's host grid (the cells its box can
/// show) over tmux's layout and asks tmux for that window size; tmux lays
/// its panes out inside it and each pane session learns its size from the
/// layout, which the pane's renderer adopts. The ask follows the pane tree's
/// area alone, the box around the tree that `App.svelte` watches: the fold
/// moves with every divider, so a fold change inside an unchanged box (the
/// layout tmux answers with, a drag's preview, the hosts settling after the
/// last ask) asks nothing, and a divider drag holds the ask from its press
/// until the layout answering its release, so the two never correct each
/// other.

import { untrack } from "svelte";
import { paneMode, tmuxPaneTabs } from "./tabs.svelte";
import type { TmuxLayoutNode } from "./tmux";

export type TerminalGrid = { cols: number; rows: number };
export type PixelBox = { width: number; height: number };

/// How long a released drag's request waits for tmux's layout before the
/// window size is free again: a request tmux refuses, or a layout lost with
/// its connection, answers with nothing.
export const TMUX_DRAG_ANSWER_MS = 1000;

let layoutTree = $state<TmuxLayoutNode | null>(null);
let paneArea = $state.raw<PixelBox | null>(null);
/// `pressed` from a divider's press to its release, `answering` from a
/// release that sent a request until the layout answering it.
let drag = $state<"none" | "pressed" | "answering">("none");
let answerTimer: ReturnType<typeof setTimeout> | null = null;

/// Keep the tree the connection last sent this window, for the window grid;
/// it answers a drag's request when one is out.
export function setTmuxLayout(node: TmuxLayoutNode | null): void {
  layoutTree = node;
  if (untrack(() => drag) === "answering") endTmuxDrag(false);
}

export function tmuxLayout(): TmuxLayoutNode | null {
  return layoutTree;
}

/// The box of the element holding the tmux window's pane tree, as its
/// observer last read it. The setter runs inside the effect that observes,
/// so it reads what it keeps untracked: an effect that depended on the state
/// it writes would run itself again at each write.
export function setTmuxPaneArea(box: PixelBox | null): void {
  const next = box ? { width: box.width, height: box.height } : null;
  const current = untrack(() => paneArea);
  if (next === current || (next && current && next.width === current.width && next.height === current.height)) return;
  paneArea = next;
}

export function tmuxPaneArea(): PixelBox | null {
  return paneArea;
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

/// A divider's press: hold the window size until the drag's end says for how
/// long.
export function startTmuxDrag(): void {
  clearAnswerTimer();
  drag = "pressed";
}

/// A divider's release, or its request's failure: free the window size, or
/// when `awaitingLayout`, hold it for the layout tmux answers the request
/// with, and no longer than `TMUX_DRAG_ANSWER_MS`.
export function endTmuxDrag(awaitingLayout: boolean): void {
  clearAnswerTimer();
  if (!awaitingLayout) {
    drag = "none";
    return;
  }
  drag = "answering";
  answerTimer = setTimeout(() => {
    answerTimer = null;
    if (drag === "answering") drag = "none";
  }, TMUX_DRAG_ANSWER_MS);
}

/// Whether the window size waits: through a divider drag until its answer,
/// and while Hybrid Nav is up, since its terminals measure nothing while the
/// draft shows; they measure again as it ends, and the ask follows.
export function tmuxWindowSizeHeld(): boolean {
  return drag !== "none" || paneMode.active;
}

function clearAnswerTimer(): void {
  if (answerTimer === null) return;
  clearTimeout(answerTimer);
  answerTimer = null;
}
