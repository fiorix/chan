# The tag-scoped graph never refits its nodes

Status: raised on 2026-11-11 by the round's own checks and readings (the draft's origin is kept below); accepted for v0.128.0 by the owner the same day (survey 5). Not started.

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
