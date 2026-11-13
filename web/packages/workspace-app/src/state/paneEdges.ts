// Which sides of a pane lie on the window's edge.
//
// A pane keeps a margin, rounded corners and a terminal inset on the sides it
// shares with another pane, and gives all three up on a side that is the
// window's own edge, where they would only take room from the content.

import type { LayoutState } from "./tabs.svelte";

export type PaneEdges = { top: boolean; right: boolean; bottom: boolean; left: boolean };

/// The sides of the pane tree's box that another surface holds: a docked
/// file browser sits between the panes and the window's edge on its side.
export type DockedSides = { left: boolean; right: boolean };

const NO_EDGES: PaneEdges = { top: false, right: false, bottom: false, left: false };

/// The sides of pane `paneId` that are edges of the window, read from the
/// split tree alone so a divider drag changes nothing here. A row split lays
/// its children side by side with `a` on the left; a column split stacks them
/// with `a` on top. No side is an edge for a pane the layout does not hold.
export function windowEdges(state: LayoutState, paneId: string, docked: DockedSides): PaneEdges {
  const walk = (id: string, edges: PaneEdges): PaneEdges | null => {
    const node = state.nodes[id];
    if (!node) return null;
    if (node.kind === "leaf") return id === paneId ? edges : null;
    const row = node.direction === "row";
    return (
      walk(node.a, row ? { ...edges, right: false } : { ...edges, bottom: false }) ??
      walk(node.b, row ? { ...edges, left: false } : { ...edges, top: false })
    );
  };
  return (
    walk(state.rootId, { top: true, right: !docked.right, bottom: true, left: !docked.left }) ??
    NO_EDGES
  );
}
