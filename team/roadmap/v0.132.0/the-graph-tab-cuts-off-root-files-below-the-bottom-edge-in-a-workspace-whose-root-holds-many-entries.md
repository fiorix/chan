# The Graph tab cuts off root files below the bottom edge in a workspace whose root holds many entries

Status: accepted for v0.132.0 by the owner on 2026-11-16, by survey ("Take all my recommendations (recommended)", answering `dev/v0131-team/reports/owner-candidates-6.md`); not started. The shape of the fix was the owner's choice at the row's start (contract 2); he chose room below the root on 2026-11-17 (below).

Record: found by browser check 218 in the whole browser suite during v0.131.0 and diagnosed by reading as behaviour older than v0.131.0, not load and not a frame read early (`dev/v0131-team/reports/diag-218-graph-framing.md`; `owner-candidates-6.md`, the graph section). The Graph tab's props to its canvas, the fit and the layout's forces are unchanged since `v0.130.0`: `git diff v0.130.0 f453b0b2e` changes comment lines only in `GraphCanvas.svelte` and nothing in `graph/force.ts`. A confirming reading is owed: check 218 run after a throwaway check that writes 110 extra files at the workspace's root, at `v0.130.0` and at `f453b0b2e`, with a run at `f453b0b2e` and no extra files as the control (J244, `dev/v0131-team/tasks/task-Lead131-Ops131-138.md`). Red at both revisions with similar room below the root, and green in the control, confirms it. Panning or zooming shows the nodes that are cut off; nothing is lost.

## What is there now

Read at `f453b0b2e`, by reading; not run. Paths are under `web/packages/workspace-app/src/`.

- The Graph tab has one root, the workspace's node (`components/GraphPanel.svelte:1314-1317`, `FOCAL_IDS = [""]`), which the canvas pins at the origin (`components/GraphCanvas.svelte:769-770`, `:781-785`). The tab passes no `focalAnchor` (`components/GraphPanel.svelte:2278-2291`), so the canvas takes its default, `"bottom"` (`components/GraphCanvas.svelte:80-92`, `:119`).
- The fit (`computeFitForNodes`, `components/GraphCanvas.svelte:1722-1782`) seats the root halfway across and 56 px above the canvas's bottom edge (`FOCAL_BOTTOM_MARGIN`, `:1764-1766`). It sizes the zoom so that the larger of the root's distances to the top and to the bottom of the nodes' box fits the room above the seat (`halfH` at `:1753`, `availHalfH` at `:1768-1770`, `k` at `:1773-1779`). Nothing holds what lies below the root to the 56 px under the seat, so a node farther below the root than that, at the fit's zoom, is drawn past the bottom edge.
- An untouched view fits again on every frame while the layout moves (`components/GraphCanvas.svelte:1433-1453`), so the cut is in the settled view.
- The layout (`buildSim`, `components/GraphCanvas.svelte:829-884`; `DEFAULT_FORCE`, `graph/force.ts:60-72`) springs each entry to its directory at 128 px (`linkDistanceTag`, the length of every edge that is not a link) with strength 1.12, under a charge of -90, and pulls depth 1 toward y = -90 with strength 0.45. With many direct entries at the root, the ring of root children wraps under the root. The diagnosis's replica of the layout and fit (d3-force 2.1.1 with the same forces, pinning, seeding and fit; a replica, not the product) put no node past the edge at 34 root entries, 94 to 112 px past at 108 and 103 to 137 px past at 135, a threshold of about 45 to 55 entries; 43 root entries with 100 nested files also went 54 to 63 px past.
- Check 218 asserts the tag-opened graph through `rootedFailures` (`scripts/e2e/browser-smoke/lib/graph-discs.mjs:144-164`, with the seat's 56 px at `:11-14`): once the layout settles, a disc for each counted node and draft, every disc inside the canvas, and one on the root's seat. Alone, with about 34 root entries, it passes with 18.9 to 29.8 px to spare below; in the whole suite, where earlier checks leave about 140 entries at the root, its lowest disc was 102.6 and 114.8 px past the bottom edge in two runs.
- The contract it breaks: [the Graph tab's row of v0.129.0](../done/the-graph-tab-draws-a-different-graph-for-each-way-it-is-opened.md) (contract 1: the root pinned at the bottom and the tree growing up from it) and [the tag-scoped graph's row](../done/the-tag-scoped-graph-never-refits-its-nodes.md) (contract 1: every counted node visible).

## Desired contract

1. Once the layout rests, the Graph tab's untouched view holds every counted node and the workspace's drafts inside the canvas, whatever the number of entries at the workspace's root or below it, with the workspace's node at the bottom of the tree, halfway across.
2. One of two shapes, which the owner picks at the row's start and the row records:
   - Room below the root: the fit gives the room under the root's seat to what lies under the root, so the seat rises when the layout puts nodes below the root; the layout is unchanged.
   - The tree growing up: the layout keeps depth 1 and deeper above the root, so nothing lies below it and the seat 56 px above the bottom edge holds; the fit is unchanged.
3. The view still follows the layout until it rests, a user's pan, zoom or drag still stops the automatic fit, and the Dashboard's Search slide keeps its own framing (`"bounds"`).

## Boundaries

- `computeFitForNodes` in `GraphCanvas.svelte` for the first shape, or the layout's forces in `buildSim` and `graph/force.ts` for the second; the seat that `rootedFailures` reads, if the first shape moves it; and their tests.
- Starts once the owed reading has landed in this row and the owner has chosen the shape.

## Acceptance

1. The owed reading, recorded here: check 218 after a seeded root, red at `v0.130.0` and at `f453b0b2e` with 110 extra entries, green with none.
2. A unit test of the chosen fit or layout over roots of 34, 60, 110 and 140 direct entries and one of 43 with 100 nested files: every node inside the canvas once the layout rests. Red at the base at 60 entries and above; going back to the base's fit or layout turns it red again.
3. A browser check that seeds the workspace's root with about 110 entries and opens the Graph tab: every counted node and draft inside the canvas and one disc on the root's seat; red at the base. Check 218 green alone and in the whole browser suite.
4. `web/packages/workspace-app/src/design.md` (the Graph tab's framing) and the manual's graph page say where the root sits and what lies below it.

## Reading, 2026-11-16

The owed reading ran in a guest (J244, `dev/v0131-team/evidence/Ops131/J244/run/heavy/verdict.txt`): check 218 after a throwaway check that seeded the workspace's root with 110 extra entries (33 to 143 at the root), on fresh trees. At `v0.130.0` it read red past the bottom edge twice, `room.below` -97.0 and -139.2 px with 149 nodes counted; at `f453b0b2e` red at -146.4 px with 149 counted, inside v0.130.0's own spread; with no extra entries at `f453b0b2e`, green at +15.9 px with 37 counted. The behaviour is older than v0.131.0, as the diagnosis read. The red at `f453b0b2e` also reported 148 discs painted for 149 counted, consistent with a node drawn wholly past the edge at the larger overshoot; the check and its helper's assertion are the same at both revisions. Acceptance 1 is met; the row now waits on the owner's choice of shape.

## The owner's choice of shape, 2026-11-17

Asked on 2026-11-17 with both shapes of contract 2 and a recommendation of the first (`dev/v0132/decisions.md`, point 1), the owner answered: "i take your recommendation for the graphroot fix, draft that as part of the team work as well". The shape is room below the root: the fit (`computeFitForNodes` in `components/GraphCanvas.svelte`) gives the room under the root's seat to what lies under the root, so the seat rises when the layout puts nodes below it, and `buildSim` and `graph/force.ts` are not touched. A workspace whose root has nothing under it looks as it does today, the root 56 px above the bottom edge. The seat that `rootedFailures` reads (`scripts/e2e/browser-smoke/lib/graph-discs.mjs`) follows the fit's seat. Contract 3 holds as written. With the reading recorded and the shape chosen, both start conditions in Boundaries hold.

## Built, 2026-11-17

Built on `v0132/graphroot` from `b73773a93`, merged as `071fe23ff`. `computeFitForNodes` alone changed: the seat stays 56 px above the bottom edge while what lies under the root fits in that room, and rises with a shrinking zoom when it needs more, so the whole set fits inside the canvas. The chosen seat is published on the canvas as `data-focal-seat`, which the check helper reads instead of assuming 56 px. The layout, its forces and the Dashboard Search slide's bounds branch are untouched.
Acceptance 1 holds by the recorded reading above. Acceptance 2 holds by unit tests over roots of 34, 60, 110 and 140 direct entries and one of 43 with 100 nested files, mounting the real canvas with the real layout and fit: red at the base from 60 entries up (-3.6, -26.8, -37.6 and -25.1 px past the bottom edge), green on all five at the tip, and red again with the base fit put back (byte-identical restores both ways). Drag and zoom keep the user's view, and the follow-until-rest and bounds framing stay pinned. Acceptance 3 holds by the new browser check 230 (about 110 root entries): red at the base (a node 117.7 px past the edge, no seat published, 146 nodes counted), green at the tip (all 146 inside, seat published), and by check 218 green alone and in a whole-suite run in an isolated guest (150 checks ran, 149 passed, 1 skipped: the pane-tree check whose vim leg found no vim in the guest, which reads nothing the graph range changed; 218 and 230 passed in that run). That suite ran at `bc3496c7d`; the tip `071fe23ff` differs from it in a code comment, a design paragraph and one test line only (3 files, 3 insertions, 2 deletions), product code unchanged. Acceptance 4 holds: `design.md` and the manual's graph page say where the root sits and what lies below it.
