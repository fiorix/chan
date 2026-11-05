// Where a drag over a pane's body lands: a band along each edge, where a tab
// from the same window splits the pane, and the centre, where a drop fills the
// pane as a drop past the end of its tab strip does.

import type { PaneDropEdge } from "./tabs.svelte";

export type PaneBodyDropZone = PaneDropEdge | "centre";

/// Each edge band is a quarter of the body's extent across it, at most
/// 120px. The quarter keeps an edge easy to hit on a small pane (a 240px-wide
/// pane splits within 60px of either side) and leaves the centre at least half
/// of each axis however small the pane; the cap keeps the centre most of a
/// large pane (a 1600px-wide pane fills everywhere but 120px at either side).
export const EDGE_BAND_FRACTION = 0.25;
export const EDGE_BAND_MAX_PX = 120;

/// The width of the band along an edge, for a body `extent` pixels across.
export function edgeBand(extent: number): number {
  return Math.min(extent * EDGE_BAND_FRACTION, EDGE_BAND_MAX_PX);
}

/// The zone under a point `x`, `y` pixels from the top-left corner of a body
/// `width` by `height`: the nearest edge whose band holds the point, else the
/// centre. In a corner both bands hold it and the nearer edge wins.
export function paneBodyDropZone(x: number, y: number, width: number, height: number): PaneBodyDropZone {
  const across = edgeBand(width);
  const down = edgeBand(height);
  const edges: Array<[PaneDropEdge, number, number]> = [
    ["left", x, across],
    ["right", width - x, across],
    ["top", y, down],
    ["bottom", height - y, down],
  ];
  let zone: PaneBodyDropZone = "centre";
  let nearest = Infinity;
  for (const [edge, distance, band] of edges) {
    if (distance < band && distance < nearest) {
      zone = edge;
      nearest = distance;
    }
  }
  return zone;
}
