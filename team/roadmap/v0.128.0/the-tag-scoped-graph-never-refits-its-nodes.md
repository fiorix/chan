# The tag-scoped graph never refits its nodes

Status: raised on 2026-11-11 by the round's own checks and readings (the draft's origin is kept below); accepted for v0.128.0 by the owner the same day (survey 5). Landed on 2026-11-11.

Origin: drafted on 2026-11-11 from the v0.128.0 basic-flows browser checks (218 and 110), for the owner to accept, move or drop. Not started.

## What is there now

Opening a tag hit from Search (or a `#tag` query) opens the graph tab scoped to that tag (`tag=#graph-smoke`). In every run of checks 110 and 218 on headless Chrome 156, the lens draws its nodes in the left half and at the bottom edge of the canvas, with one of the four nodes its status line counts (`4/38 nodes`) below the visible area. A probe that read the painted box at 0, 1.5, 4.5 and 10.5 s after the status line first counted nodes found it at `[28,160]-[534,724]` of a 986x726 canvas from 1.5 s on, unchanged: the lens settles once and never refits to the canvas. Screenshots: `dev/v0128-team/evidence/Term128/basicflows-2/out-218-green/search-opens-hit-218-tag-graph.png` and `out-probes/probe-tag-lens-settle-917-at-*.png`.

This is the framing family the v0.127.0 and v0.128.0 Dashboard slide rows fixed for the empty-pane carousel (`GraphCanvas.svelte` gained `focalAnchor` and a refit on resize there); the graph tab's tag lens does not use that path.

## Desired contract

1. A tag-scoped graph fits its visible nodes inside the canvas once the layout settles, centered, with every counted node visible.
2. A resize of the tab refits it, as the Dashboard slides do.

## Boundaries

- The graph tab's lens framing; the layout algorithm and the Dashboard slides are unchanged.

## Acceptance

1. A unit test of the refit (the painted extent inside the canvas after settle) and a browser check reading the painted box, as probe 917 did, green at the tip and red on the current framing.
2. Check 110 and 218's screenshots show the nodes centered.

## Built, 2026-11-11

The tag, mention, contact and language lenses frame what they show in the middle of the canvas. The graph tab handed its canvas no framing, so every scope took the default "bottom" anchor, which seats the pinned node near the canvas's bottom edge; a lens pins its own node and its walk splays nodes around it in every direction, the directory spine below it. Those four lenses now pass `focalAnchor="bounds"`, the Dashboard Search slide's framing: the drawn box sits in the middle with equal room on both axes, follows the layout while it moves and fits again when the canvas changes size (contracts 1 and 2). The layout is unchanged, and the workspace, directory and file scopes keep "bottom" (ruled 2026-11-11: the sibling lenses had the same defect for the same reason).

Fixed as 154f80b50 and 514551885, merged as 4be97e69a. Tests: `components/GraphPanel.lensFraming.test.ts` (the painted discs inside and centered once the layout rests and after a resize; at the base a node 133 px below the canvas) and the per-scope cases in `GraphPanel.lens.test.ts`. Checks 110 (the tag lens, then a resize) and 218 (a tag hit and a mention hit from Search) read the node discs the canvas paints (`scripts/e2e/browser-smoke/lib/graph-discs.mjs`): as many as the status line counts, every one inside, centered within 3 px. At the base they fail with a node 4.6 px (110) and 166 px (218) below the canvas; at the tip both pass ten runs alone each. The contact and language lenses are covered by the unit test, not a browser check.
