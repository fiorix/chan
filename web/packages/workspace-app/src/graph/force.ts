// d3-force tuning for the chan graph.
//
// This is the single source of truth for the graph's physics. The
// production renderer (components/GraphCanvas.svelte) imports
// `DEFAULT_FORCE` as the default for its optional `force` prop, and the
// standalone graph-tuner playground (src/graph-tuner/) drives the same
// shape live via sliders. Dial values in here once and BOTH the live
// graph and the tuner pick them up. Tune in the playground, then paste
// the winning numbers back into `DEFAULT_FORCE`.
//
// `hierarchyYSpacing` + `hierarchyYStrength` drive the filesystem-spine
// forceY, and `parentXStrength` drives the parent-anchored forceX, so
// each file node sits above its directory and siblings cluster
// horizontally under the same parent. `metaLift` gives the nodes outside
// the tree (tag / mention / language) a band above the files they are
// linked to, so the whole graph grows upward from the workspace root.

export type GraphForce = {
  /// forceManyBody strength. Negative = repulsion between every pair of
  /// nodes; the more negative, the more the cluster spreads.
  chargeStrength: number;
  /// forceLink target distance for `link` (wiki/markdown reference)
  /// edges.
  linkDistance: number;
  /// forceLink target distance for the lighter attachment edges
  /// (tag / mention / contains / language / group).
  linkDistanceTag: number;
  /// forceLink strength (spring stiffness) applied to every edge.
  linkStrength: number;
  /// Extra padding added to each node's radius in forceCollide so discs
  /// keep a gap rather than touching.
  collidePad: number;
  /// Simulation velocity decay (friction). Higher = settles faster,
  /// less drift.
  velocityDecay: number;
  /// forceX(0) strength: the weak pull toward the horizontal center
  /// that keeps non-hierarchical nodes (tag / mention / language) from
  /// wandering off.
  centerStrength: number;
  /// Vertical gap between adjacent filesystem depth bands. Each
  /// hierarchical node targets `-depth * hierarchyYSpacing`, so the
  /// workspace root anchors the bottom and the spine grows upward.
  hierarchyYSpacing: number;
  /// forceY strength for hierarchical nodes (depth >= 0), pulling them
  /// onto their depth band.
  hierarchyYStrength: number;
  /// Custom parent-anchored forceX strength: pulls each hierarchical
  /// node toward its parent directory's X so siblings cluster.
  parentXStrength: number;
  /// Depth bands a tag, mention or language node sits above the deepest
  /// file it is linked to, held there with `hierarchyYStrength`. At 0
  /// these nodes take no band: they keep the weak `centerStrength` pull
  /// toward y = 0, the level of the workspace root.
  metaLift: number;
};

/// The live graph's tuning. Tweak here, not in the per-call layout
/// configs. Kept in sync with the tuner by construction: GraphCanvas
/// defaults its `force` prop to this object.
export const DEFAULT_FORCE: GraphForce = {
  chargeStrength: -90,
  linkDistance: 125,
  linkDistanceTag: 128,
  linkStrength: 1.12,
  collidePad: 8,
  velocityDecay: 0.55,
  centerStrength: 0.05,
  hierarchyYSpacing: 90,
  hierarchyYStrength: 0.45,
  parentXStrength: 0.18,
  metaLift: 1,
};
