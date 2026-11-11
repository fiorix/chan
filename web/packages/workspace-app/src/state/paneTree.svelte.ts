// The pane tree overlay's open state and model, and the layout geometry the
// window tab bar's tree button draws.
//
// The overlay lists every pane of this window in reading order, each pane's
// A and B sides and the tabs on each, so any tab is one pick away however the
// window is split. It reads the live layout, never Hybrid Nav's draft: it
// cannot open while Hybrid Nav is up, and the program status marks live on
// the live tabs.

import { builtInChordSuperseded, commandIdForChord } from "./keymapOverrides.svelte";
import { programVisual } from "./programStatus";
import { terminalProgramText } from "./terminalProgram";
import {
  chordsEqual,
  currentOS,
  currentPlatform,
  eventMatchesShortcut,
  osChord,
  resolveEventChord,
  SHORTCUTS,
} from "./shortcuts";
import { appInputBlocked, modalDialogOpen, ui } from "./store.svelte";
import {
  allPaneTabs,
  layout,
  paneActiveTabId,
  paneMode,
  paneSide,
  paneTabs,
  selectTabInPane,
  setActivePane,
  setTerminalActivity,
  tabLabelInPane,
  type BrowserLabelCtx,
  type LayoutState,
  type LeafNode,
  type PaneSide,
  type Tab,
} from "./tabs.svelte";

/// The command id the launcher row, the chord and the `chan:command` bus
/// share, so the launcher shows the chord through `chordFor`.
export const PANE_TREE_COMMAND_ID = "app.pane.tree";

/// The attribute the control that opens the overlay carries (the window tab
/// bar's tree button). The overlay hangs its dropdown under that element and
/// falls back to the window's top-left corner when no such element is shown.
export const PANE_TREE_ANCHOR_ATTR = "data-pane-tree-anchor";

export const paneTree = $state<{ open: boolean }>({ open: false });

/// Whether the overlay may open now. Hybrid Nav owns the keyboard and shows a
/// staged layout the overlay does not draw; the control terminal is one PTY
/// with no strip and nothing to navigate; a full-window cover or a modal
/// dialog keeps everything under it inert.
export function paneTreeMayOpen(): boolean {
  return !paneMode.active && !ui.terminalControl && !appInputBlocked() && !modalDialogOpen();
}

export function openPaneTree(): void {
  if (!paneTreeMayOpen()) return;
  paneTree.open = true;
}

export function closePaneTree(): void {
  paneTree.open = false;
}

export function togglePaneTree(): void {
  if (paneTree.open) closePaneTree();
  else openPaneTree();
}

/// A pane's rectangle as fractions (0..1) of the window's pane area.
export type PaneRect = { x: number; y: number; w: number; h: number };

/// Each pane's rectangle, keyed by pane id, from the split directions and
/// ratios. A row split lays its children side by side with `a` on the left;
/// a column split stacks them with `a` on top.
export function paneRects(state: LayoutState): Record<string, PaneRect> {
  const out: Record<string, PaneRect> = {};
  const walk = (id: string, r: PaneRect): void => {
    const node = state.nodes[id];
    if (!node) return;
    if (node.kind === "leaf") {
      out[id] = r;
      return;
    }
    const ratio = Math.min(1, Math.max(0, node.ratio));
    if (node.direction === "row") {
      walk(node.a, { x: r.x, y: r.y, w: r.w * ratio, h: r.h });
      walk(node.b, { x: r.x + r.w * ratio, y: r.y, w: r.w * (1 - ratio), h: r.h });
    } else {
      walk(node.a, { x: r.x, y: r.y, w: r.w, h: r.h * ratio });
      walk(node.b, { x: r.x, y: r.y + r.h * ratio, w: r.w, h: r.h * (1 - ratio) });
    }
  };
  walk(state.rootId, { x: 0, y: 0, w: 1, h: 1 });
  return out;
}

/// The pane ids in reading order: depth first over the split tree, `a`
/// before `b`, so left before right and top before bottom.
export function paneOrder(state: LayoutState): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string): void => {
    // A malformed tree that reaches a node twice is walked once.
    if (seen.has(id)) return;
    seen.add(id);
    const node = state.nodes[id];
    if (!node) return;
    if (node.kind === "leaf") {
      out.push(id);
      return;
    }
    walk(node.a);
    walk(node.b);
  };
  walk(state.rootId);
  return out;
}

/// A program status mark as the tab strip draws it (OSC 7501).
export type ProgramMark = "working" | "done" | "blocked" | "error";

/// The mark the strip shows on `tab`: its attention record's state (blocked,
/// or an unseen done or error), else working while any record works, else
/// none. Only terminals carry program status.
export function tabProgramMark(tab: Tab): ProgramMark | null {
  if (tab.kind !== "terminal" || !tab.programStatus) return null;
  const visual = programVisual(tab.programStatus);
  const state = visual.attention?.state;
  if (state === "blocked" || state === "done" || state === "error") return state;
  return visual.working ? "working" : null;
}

const MARK_URGENCY: Record<ProgramMark, number> = { error: 4, blocked: 3, done: 2, working: 1 };

/// The most urgent of `marks`: error, then blocked, then done, then working.
export function mostUrgentMark(marks: Iterable<ProgramMark | null>): ProgramMark | null {
  let best: ProgramMark | null = null;
  for (const mark of marks) {
    if (mark && (!best || MARK_URGENCY[mark] > MARK_URGENCY[best])) best = mark;
  }
  return best;
}

/// The most urgent program status mark among the tabs the window tab bar
/// does not show (every tab outside the active pane's visible side), or null.
export function hiddenTabStatus(state: LayoutState = layout): ProgramMark | null {
  const marks: (ProgramMark | null)[] = [];
  for (const id of paneOrder(state)) {
    const node = state.nodes[id];
    if (node?.kind !== "leaf") continue;
    const shown = node.id === state.activePaneId ? paneSide(node) : null;
    for (const side of ["a", "b"] as const) {
      if (side === shown) continue;
      for (const tab of paneTabs(node, side)) marks.push(tabProgramMark(tab));
    }
  }
  return mostUrgentMark(marks);
}

/// The kind a tab row names, in the words the design uses for tab kinds.
export function tabKindLabel(tab: Tab): string {
  switch (tab.kind) {
    case "file":
      return "Editor";
    case "terminal":
      return "Terminal";
    case "graph":
      return "Graph";
    case "browser":
      return "File browser";
    case "dashboard":
      return "Dashboard";
    case "extension":
      return "Extension";
  }
}

/// One tab row of the overlay.
export type PaneTreeTab = {
  paneId: string;
  side: PaneSide;
  tab: Tab;
  /// The title the pane's strip shows for this tab.
  title: string;
  /// What runs in the terminal, shown beside the title: the program's own
  /// title, else its foreground command. Null for other kinds, for a reading
  /// that holds neither, and for a tmux pane, which tmux names itself.
  program: string | null;
  /// The tab is its side's active tab.
  active: boolean;
  /// The tab is the one the window shows focused: the active tab of the
  /// active pane's visible side.
  current: boolean;
};

export type PaneTreeSide = {
  side: PaneSide;
  /// The side the pane shows.
  visible: boolean;
  /// The side's tabs, narrowed by the filter.
  tabs: PaneTreeTab[];
  /// How many tabs the side holds before the filter, so an empty side reads
  /// as empty and a narrowed one does not.
  total: number;
};

export type PaneTreePane = {
  id: string;
  /// 1-based position in reading order.
  number: number;
  rect: PaneRect;
  /// The window's active pane.
  active: boolean;
  /// The title of the tab the pane shows, or "Empty pane".
  label: string;
  sides: PaneTreeSide[];
};

export type PaneTreeOptions = {
  /// Narrows tabs by title. Every whitespace-separated term must appear in
  /// the title, case-insensitively; an empty query keeps every tab.
  query?: string;
  /// Whether panes have A and B sides. A tmux window's do not, and lists
  /// only the side each pane shows.
  sides?: boolean;
  /// The label context the strip gives a tab, for a file browser's title.
  labelCtx?: (tab: Tab) => BrowserLabelCtx | undefined;
};

/// A row's `program` reading for `tab`.
export function tabProgramReading(tab: Tab): string | null {
  if (tab.kind !== "terminal" || tab.tmuxPane) return null;
  return terminalProgramText(tab.terminalProgram);
}

function queryTerms(query: string | undefined): string[] {
  return (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

function titleMatches(title: string, terms: string[]): boolean {
  const lower = title.toLowerCase();
  return terms.every((term) => lower.includes(term));
}

/// The pane's tabs on `side`, without a tab id the pane already listed. The
/// strip keys its tabs by id and draws the first copy of a repeated one, so
/// the overlay lists what the strip draws.
function uniqueSideTabs(pane: LeafNode, side: PaneSide, seen: Set<string>): Tab[] {
  return paneTabs(pane, side).filter((tab) => {
    if (seen.has(tab.id)) return false;
    seen.add(tab.id);
    return true;
  });
}

/// The overlay's content: every pane in reading order with its sides and
/// their tabs. With a query, a side keeps only the tabs whose title matches,
/// and a side or pane left with none is dropped, so every match keeps its
/// pane and side headers and nothing else shows.
export function paneTreeModel(state: LayoutState, options: PaneTreeOptions = {}): PaneTreePane[] {
  const terms = queryTerms(options.query);
  const withSides = options.sides ?? true;
  const rects = paneRects(state);
  const out: PaneTreePane[] = [];
  paneOrder(state).forEach((paneId, index) => {
    const pane = state.nodes[paneId];
    if (!pane || pane.kind !== "leaf") return;
    const visibleSide = paneSide(pane);
    const activePane = paneId === state.activePaneId;
    const seen = new Set<string>();
    const listed: PaneSide[] = withSides ? ["a", "b"] : [visibleSide];
    const sideTabs = new Map(listed.map((side) => [side, uniqueSideTabs(pane, side, seen)]));
    const sides: PaneTreeSide[] = [];
    for (const side of listed) {
      const tabs = sideTabs.get(side) ?? [];
      const activeId = paneActiveTabId(pane, side);
      const rows = tabs
        .map((tab): PaneTreeTab => {
          const active = tab.id === activeId;
          return {
            paneId,
            side,
            tab,
            title: tabLabelInPane(tab, tabs, options.labelCtx?.(tab)),
            program: tabProgramReading(tab),
            active,
            current: active && activePane && side === visibleSide,
          };
        })
        .filter((row) => titleMatches(row.title, terms));
      if (terms.length && rows.length === 0) continue;
      sides.push({ side, visible: side === visibleSide, tabs: rows, total: tabs.length });
    }
    if (terms.length && sides.length === 0) return;
    const shownTabs = sideTabs.get(visibleSide) ?? [];
    const shown = shownTabs.find((tab) => tab.id === paneActiveTabId(pane, visibleSide));
    out.push({
      id: paneId,
      number: index + 1,
      rect: rects[paneId] ?? { x: 0, y: 0, w: 1, h: 1 },
      active: activePane,
      label: shown ? tabLabelInPane(shown, shownTabs, options.labelCtx?.(shown)) : "Empty pane",
      sides,
    });
  });
  return out;
}

/// The tab rows in the order the overlay lists them, which is the order the
/// arrow keys walk.
export function paneTreeRows(panes: readonly PaneTreePane[]): PaneTreeTab[] {
  return panes.flatMap((pane) => pane.sides.flatMap((side) => side.tabs));
}

/// Make `tabId` the tab the window shows, as a press on it in its pane's strip
/// does: its pane becomes the active pane, its side the visible side, the tab
/// its side's active tab, and its surface takes the keyboard through the
/// focus pulse. A terminal's unread-output dot clears as a strip press clears
/// it. Closes the overlay. False when the pane or the tab is gone.
export function activatePaneTreeTab(paneId: string, tabId: string): boolean {
  if (paneMode.active) return false;
  const node = layout.nodes[paneId];
  if (!node || node.kind !== "leaf") return false;
  const tab = allPaneTabs(node).find((candidate) => candidate.id === tabId);
  if (!tab) return false;
  closePaneTree();
  // setActivePane gives a pane switch its wobble cue; selectTabInPane turns
  // the pane to the tab's side, selects it and sends the focus pulse.
  setActivePane(paneId);
  selectTabInPane(paneId, tabId);
  if (tab.kind === "terminal") setTerminalActivity(tab, false);
  return true;
}

/// Whether `e` is the overlay's built-in chord on this client. A user
/// assignment, whether it moves this command or gives the chord to another,
/// is dispatched by the app's override path instead, so a keystroke never
/// fires twice.
export function isBuiltInPaneTreeChord(e: KeyboardEvent): boolean {
  const entry = SHORTCUTS.find((s) => s.id === PANE_TREE_COMMAND_ID);
  if (!entry || builtInChordSuperseded(PANE_TREE_COMMAND_ID)) return false;
  const builtin = osChord(entry, currentPlatform(), currentOS());
  const chord = resolveEventChord(e);
  if (!builtin || !chord || !chordsEqual(chord, builtin)) return false;
  return commandIdForChord(chord) === undefined;
}

/// Whether `e` is the overlay's chord as this client resolves it, a user
/// assignment included. The open overlay owns the keyboard, so it answers
/// either form itself and closes.
export function isPaneTreeChord(e: KeyboardEvent): boolean {
  return eventMatchesShortcut(e, PANE_TREE_COMMAND_ID);
}
