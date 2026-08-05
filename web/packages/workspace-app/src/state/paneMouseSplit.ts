/// Pure geometry for Hybrid Nav mouse split affordances. During a
/// mouse-driven transaction the hovered target pane divides into four
/// edge zones plus a center: the center keeps the pane-content swap,
/// an edge splits the target and moves the grabbed pane's content
/// into the new sibling. Kept free of layout state so the classifier
/// and the size gate stay table-testable.

export type PaneMouseSplitZone = "left" | "right" | "top" | "bottom" | "center";
export type PaneMouseSplitEdge = Exclude<PaneMouseSplitZone, "center">;

/// Edge zones span the outer quarter of each axis; the boundary line
/// itself belongs to the center.
export const MOUSE_SPLIT_EDGE_FRACTION = 0.25;

/// An edge split halves the target along one axis; both resulting
/// panes must stay at least this large or the edge target is refused.
export const MIN_SPLIT_PANE_WIDTH = 240;
export const MIN_SPLIT_PANE_HEIGHT = 160;

/// The target pane rectangle excludes its own 4 px margins. Replacing that
/// pane with a nested split reclaims those margins, then consumes a 4 px
/// divider and margins for two child panes. The net main-axis cost is 12 px.
const SPLIT_MAIN_AXIS_CHROME = 12;

/// Classify a point inside a pane rect into an edge zone or the
/// center. A corner falls in two zones and resolves to the nearer
/// edge; an exact tie resolves horizontally so the result never
/// depends on event order.
export function classifyMouseSplitZone(
  x: number,
  y: number,
  width: number,
  height: number,
): PaneMouseSplitZone {
  if (width <= 0 || height <= 0) return "center";
  const fx = x / width;
  const fy = y / height;
  const horizontal: PaneMouseSplitEdge | null =
    fx < MOUSE_SPLIT_EDGE_FRACTION
      ? "left"
      : fx > 1 - MOUSE_SPLIT_EDGE_FRACTION
        ? "right"
        : null;
  const vertical: PaneMouseSplitEdge | null =
    fy < MOUSE_SPLIT_EDGE_FRACTION
      ? "top"
      : fy > 1 - MOUSE_SPLIT_EDGE_FRACTION
        ? "bottom"
        : null;
  if (horizontal && vertical) {
    const hd = Math.min(fx, 1 - fx);
    const vd = Math.min(fy, 1 - fy);
    return hd <= vd ? horizontal : vertical;
  }
  return horizontal ?? vertical ?? "center";
}

/// Canonical split for an edge: left/top insert the new pane before
/// the target, right/bottom after; horizontal edges split along the
/// row axis, vertical edges along the column axis.
export function edgeSplitSpec(edge: PaneMouseSplitEdge): {
  direction: "row" | "column";
  placement: "before" | "after";
} {
  return {
    direction: edge === "left" || edge === "right" ? "row" : "column",
    placement: edge === "left" || edge === "top" ? "before" : "after",
  };
}

/// An edge split halves the target along one axis; refuse the edge
/// when either resulting pane would come out under the minimum size.
export function edgeSplitAllowed(
  edge: PaneMouseSplitEdge,
  width: number,
  height: number,
): boolean {
  if (edge === "left" || edge === "right") {
    return (
      (width - SPLIT_MAIN_AXIS_CHROME) / 2 >= MIN_SPLIT_PANE_WIDTH &&
      height >= MIN_SPLIT_PANE_HEIGHT
    );
  }
  return (
    (height - SPLIT_MAIN_AXIS_CHROME) / 2 >= MIN_SPLIT_PANE_HEIGHT &&
    width >= MIN_SPLIT_PANE_WIDTH
  );
}
