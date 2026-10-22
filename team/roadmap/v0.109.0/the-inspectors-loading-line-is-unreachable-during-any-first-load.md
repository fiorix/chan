# The inspectors' loading line is unreachable during any first load

Status: built on 2026-10-22 on the seat's branch; the section Built 2026-10-22 holds the evidence; it closes at the GA as shipped.

Record before the release: raised at the v0.107.0 cut on 2026-10-17 by the lead from a finding outside that version's items, recorded in the round's decisions as the ledger's entry; written down with the repair's shape; owner by lane at the next version's launch.

## What was seen

The file and tag inspector bodies show their loading line only when no view is cached and a load is out; a first load streams batches into the view from its first batch, so the line shows for the time before the first batch only and reads as unreachable in the tests that drive a first load (the review seat's note at the graph refetch item's amend, 2026-10-16; the same at that item's parent).

## Desired contract

The inspectors' loading state is shown for the time the design names, or is not offered; its condition is reachable in the tests that drive a first load.

## What to do

Decide what the inspectors show during a first load (the line until the stream completes, or nothing) and make the condition say it; or remove the line.

## Acceptance

1. A pin for the chosen behaviour, red first.
2. The design text.

## Lead's rulings 2026-10-22

On the frontend seat's design, 00:38Z: "grfldg takes (a) (what a person sees today is false, so the loading line is correctness and is not put to Alex); grfprt as recommended (the search panel quiet, the contacts with the loading and error lines); two commits, grfldg first, both after grfapl's page half through `graphData.svelte.ts`."

On the review seat's read of the design, 00:45Z:

- G1. "The graph panel's tag and mention inspector holds its own scoped list (`documentsOverride`) and must not go blank for a shared first load: the loading branch in `TagInfoBody.svelte` (and `FileInfoBody.svelte` where an override can reach it) applies only when the body reads the shared view, `!documentsOverride && graphData.loading && graphData.partial`; a pin (an override with the shared stream held shows the override's documents) and a mutant (the `!documentsOverride` dropped). The error branch, which has the same shape today (a shared error over a valid override), goes under the same guard in this item: one guard, both branches, recorded in the row. grfldg's design sentence says the graph panel's inspector shows the panel's own list."
- G2. "`invalidateGraph` clears `partial`, pinned at the store level (`invalidateGraph()` during a first load leaves `graphData.partial` false) with its mutant."
- G4. "Every test file that resets `graphData` by hand (`FileInfoBody.svelte.test.ts` 181, `WorkspaceInfoBody.test.ts` 121 and 130, `fileInfoBodyDuplicateEdges.test.ts` 106, `graphDataDuplicateTargets.test.ts` 32, `EmptyPaneCarousel.slides.test.ts` 49) also resets `partial`, or resets through `invalidateGraph()`; the touched files run once with `--sequence.shuffle` and the log is named in the row."
- Counts: "grfldg: four pins, five mutants".

## Built 2026-10-22

The decision is (a), the lead's word above: the inspectors say their references are loading until a first load completes. The shared graph store publishes the view's first-load mark as `graphData.partial` (`web/packages/workspace-app/src/state/graphData.svelte.ts`): true from a first load's start, where it publishes an empty view in the same run as `loading`, until a stream completes; a failed first load keeps it, and `invalidateGraph` clears it with the view it drops (G2). The file inspector (`components/FileInfoBody.svelte`) shows "loading references..." while a load is out over a partial view, and the tag and mention inspector (`components/TagInfoBody.svelte`) does the same instead of "no documents reference this"; each shows the complete list once the stream completes, and a failed first load shows its error. The tag inspector's loading and error lines apply only when it reads the shared view (`readsShared`): the graph panel hands it its own scoped list, which stands whatever the shared load is doing (G1, one guard over both branches); the file inspector takes no such list. The workspace app's design text (`src/design.md`, the shared graph through a burst of filesystem events) says so. The five test files that reset `graphData` by hand, at six sites, reset `partial` too (G4).

Acceptance 1, the pins, in the frontend seat's guest (logs under `dev/v0109-team/evidence/Frontend109/grfldg/build/`): the file inspector, with the first load held after its first batch, shows the line and no contact, then the contact once the stream completes (`components/FileInfoBody.svelte.test.ts`); the tag inspector, held the same way, shows the line and not "no documents reference this", then the document (`components/TagInfoBody.test.ts`); with the graph panel's own list it shows that list while the shared load streams, and over the shared load's error; at the store, the first batch is partial, an invalidation leaves `partial` false with the view dropped, and a completed stream is whole (`state/graphData.stream.test.ts`). With the three product modules as they are at the parent `2857659cd` (`redgreen-1`), four fail on their own assertions: both line pins (the parent shows no line: the file inspector lists the references streamed so far, none yet, and the tag inspector says "no documents reference this"), the list over a shared error (the parent shows "references unavailable: stream down"), and the store pin, on the field the parent does not publish; the list during the shared stream passes there, since the parent's line is unreachable. Seven mutants, one per guard, each fail a pin: each inspector's condition back to no view and a load out, `partial` not set at a first load's start, not cleared at completion (red on the store pin alone, since a completed load is not loading either way), not cleared by an invalidation, and `readsShared` dropped from the loading and from the error branch. The touched test files pass once in a shuffled order (`shuffle-1`, seed 1792673967005, 77 tests).

Acceptance 2, the design text above. `make web-check` at `805497dd3`, this commit without this section (`gate-1.log`, rc 0, 14 minutes): svelte-check clean in every package, web-shared's 218 tests, the launcher's 624, the workspace app's 7556 in 592 files and the profile's 20, both production builds, the web lock unchanged and the checkout clean after. Browser checks 111, 112 and 163, which open the graph and its inspectors, pass at the commit and at the parent (`graph-tip-1`, `graph-parent-1`); no check reads the inspectors' loading, error or empty lines.
