# Hybrid Nav mouse split affordances

Status: IMPLEMENTED for v0.85.0; automated evidence complete, owner runtime validation pending.

## What

Dragging a pane with the mouse enters Hybrid Nav, so while the mouse is the input, hovering across the screen should suggest horizontal and vertical pane splits, most valuably when only one pane is open; multi-pane needs a rule for the minimum resulting pane size below which no split is offered.

The implementation preserves the center drop's existing pane-content swap and makes the minimum-size rule explicit.

## Implemented contract

- A target pane divides into 25 percent left, right, top, and bottom edge zones plus a center. Exact quarter boundaries belong to the center, corners resolve to the nearer edge with a deterministic horizontal tie break, and a degenerate rect classifies as center.
- An allowed edge previews the half that receives the grabbed pane's content. Mouseup stages a 50/50 split in the Hybrid Nav draft, moves both populated sides, the visible side, and the pane theme into the new leaf, and leaves the source leaf present and empty.
- A pane splits against its own edge, so a single-pane window can split by mouse. A center drop on the grabbed pane releases the grab; a center drop on any other pane keeps the existing swap.
- An edge is refused, not downgraded to a swap, when either resulting pane would fall below 240 by 160 pixels. The gate measures the panes that would result, so it subtracts the 12 pixels of chrome a nested split costs on the main axis before halving: a row edge needs 492 pixels of width, a column edge 332 pixels of height. That chrome is the 4 pixel divider plus the 4 pixel pane margins, net of the margins the replaced pane gives back.
- Mouseup revalidates the target bounds, so an edge armed before the pane shrank cannot still land.
- Hover and mouseup never mutate the live layout. Enter commits the draft once, Escape restores the byte-equivalent live layout, and keyboard splits retain their transaction behavior.
- Every grab change clears the prior hover and edge preview atomically, and a draft going stale clears grab, hover, and preview together, so no cue stays painted over a transaction that can no longer commit.

## Implementation evidence

- Edge classification, minimum pane sizes, commit and cancel behavior, and mouse interaction each carry dedicated coverage. Five of the mouse tests mount the real pane and dispatch real mousedown, mousemove, and mouseup sequences through the production handlers rather than calling state functions directly.
- The minimum-size gate is pinned to the stylesheet values it derives from, so changing the pane margin or the split divider width fails the gate rather than silently moving the real minimum.
- Committing a mouse edge split re-parents a leaf and introduces new layout nodes in one batch, which is the shape that can hand a tearing-down terminal a hole in the layout map. A test drives a real edge split, commits it, and walks the layout from a terminal teardown, requiring the walk to skip the holed branch and still reach a surviving copy of the session.

## Boundaries

- No staged destructive action and no compatibility path.
- No file-tree tab drag, xterm, Ghostty, or keyboard Hybrid Nav behavior changes.
- No persisted layout schema and no minimum-size setting.
- The automated coverage runs under jsdom, which computes no layout. It proves the geometry arithmetic, the state transitions, draft versus live authority, the resulting node graph, and handler wiring. It does not prove measured pane size, where the preview overlay paints, or freedom from runtime reactivity errors on the committed-layout render path. Those remain owner validation on real hardware.
