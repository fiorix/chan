# Graph render cost on a large workspace

Status: SHIPPED in [v0.84.1](../../release/release-v0.84.1.md). A selection click no longer pins or
re-heats the simulation, a settled graph paints nothing, and the selection-derived paint inputs are
memoised with the viewport culled. On a 3519-node, 12279-edge workspace: idle paints 196 to 0, paints
from one click 412 to 1, and layout motion after that click 6606 ms to 0 ms. Owner validated
2026-08-05 in a real browser. Settling after a deliberate drag stays open (see Open).

## What

On a workspace large enough to fill the graph, selecting a node left the nodes around it visibly shaking for several seconds, and the whole graph viewport felt slow while nothing was happening. Both were avoidable: one was a simulation re-heat that a plain click had no reason to trigger, the other a repaint that ran whether or not anything had changed.

The contract is that a selection is a presentation change. Clicking a node must not perturb the layout, and a graph whose layout has settled must not consume frame budget until something actually changes. Dragging a node still re-heats the cluster, because there the user is moving the layout on purpose.

## Verified current state (2026-08-05)

Measured against a workspace of 2840 files in 382 directories, rendering 3519 nodes and 12279 edges with the depth slider at its ceiling of 10.

- `onMouseDown` could not distinguish a click from a drag. Any press on a node pinned it and called `sim.alphaTarget(0.3).restart()`, and `onMouseUp` returned the target to 0 (`web/packages/workspace-app/src/components/GraphCanvas.svelte:1235-1255` before this change).
- d3-force 2.1.1 advances alpha as `alpha += (alphaTarget - alpha) * alphaDecay` with `alphaDecay = 1 - alphaMin^(1/300)`, so approximately 0.0228, and stops its own timer once alpha falls below `alphaMin` of 0.001 (`web/node_modules/d3-force/src/simulation.js:16-36`). A 150ms press therefore raises alpha to roughly 0.05 and needs about 170 further ticks to settle, each rebuilding the charge and collide quadtrees over every node.
- `loop()` called `paint()` on every animation frame with no condition beyond the keep-alive `paused` gate, so a settled graph redrew an identical frame continuously.
- `paint()` rebuilt its selection-derived inputs per frame: `containmentSpine` allocated two sets, the lit overlay ran `visibleEdgeRefs.filter(...)` across the whole edge list, and each of the two `drawEdgeSet` passes bucketed every edge into a fresh record plus a map. All of it got more expensive precisely when a node was selected.
- No viewport culling existed. Every node and edge was submitted regardless of the pan and zoom transform.
- Baseline behaviour, measured through the rendered canvas by counting `clearRect` and `arc` calls on the graph context and comparing drawn node centres between frames: 196 paints in three idle seconds with no pixel changing, 412 paints in the six seconds after one click, and 6606ms of continued layout motion from that click. At this size a frame costs roughly 375ms, so the idle graph ran at under 3fps.

## Contract

### Selection

- A press on a node that does not move past the drag threshold selects and nothing more. The simulation is neither pinned nor re-heated.
- A press that moves past the threshold pins the node and re-heats exactly as before, and releasing it returns the alpha target to 0 so the cluster settles.
- The threshold agrees with the one `onMouseUp` already used to separate a tap from a drag, so the two can never disagree.

### Repainting

- A frame is painted when a discrete change has been announced, when the simulation is above `alphaMin`, when a fit ease is in flight, or when an indexing pulse is animating.
- Every state the paint pass reads announces itself: theme, canvas resize, icon decode, hover, pan, zoom, drag, fit, working-set rebuild, keep-alive resume, and selection.
- A settled graph with an idle pointer paints nothing.

### Cost

- Selection-derived inputs are rebuilt only when the selection or the working set changes, never per frame. They depend on graph structure, not on node positions, so they stay valid across a running simulation.
- Nodes and edges fully outside the viewport are skipped. Labelled nodes are exempt, because a label is drawn centred above its disc and can extend well past it.
- Paged loading and unloading of nodes is unchanged. Batches continue to arrive incrementally and re-warm the layout.

## Implementation shape

All of it is contained in `web/packages/workspace-app/src/components/GraphCanvas.svelte`. `graph/force.ts` is untouched, so the layout looks the same.

- `dragActive` plus `activateDrag` defer pinning and re-heating to the first qualifying move.
- `dirty` and `markDirty()` gate `paint()` inside the existing animation loop; the loop itself keeps running and stays cheap.
- `bucketEdges` and `selectionPaint` memoise the spine, the incident and spine edge set, and the per-kind edge buckets against a `workingSetRev` counter and the current selection.
- The paint pass computes world-space viewport bounds once and rejects nodes and edges outside them.

## Acceptance

- A click on a node in the densest region of a 3519-node graph produces no layout motion, and the graph paints nothing while idle.
- Dragging a node still moves the layout and re-heats, and releasing it returns the graph to quiet.
- The full `workspace-app` suite passes, including the source-pinning tests that describe the focus emphasis structure.
- Browser smoke `110-graph-lens`, `98-workspace-root-loss` at maximum graph depth, `99-tab-rotation-pane-flip`, and `101-table-click` pass.

Measured after the change, against the same workspace and the same gestures: idle paints 196 to 0 over three seconds, paints from one click 412 to 1, and layout motion after that click 6606ms to 0ms.

## Open

- Settling after a deliberate drag still takes tens of seconds at this size, because d3-force's alpha schedule is a fixed tick count and this change does not touch it. Bounding the charge force's range and scaling `alphaDecay` with node count are the levers, and both alter how the layout looks, so they belong to a separate decision rather than to this performance pass.
- Owner validation on a real workspace in a real browser is DONE (2026-08-05). The measured evidence above comes from headless Chrome driving the real UI; the owner confirmed selection and drag behaviour live.
