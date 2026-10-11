# A terminal moved to another window can come back into its source window

Status: raised for v0.106.0 at the v0.105.0 GA on 2026-10-11, from the osc7501 round's record (check 150's one red at `729736e51`); written down, not designed, not accepted for build.

## What was seen

Two pages viewed one window. The second page saved the shared layout and closed; its `session_changed` reached the first page 160 ms before that page dragged a terminal tab into another window. The drag's end closed the moving tab as moving out, and 380 ms after the drop the first page opened a new tab on the moved session, so the session was attached in two windows. The record is `dev/osc7501-team/evidence/Web7501/task9/guest-results/full-combined/150-program-attach.timeline.json` in the chan-dev archive of the round, and the mechanism, read in `web/packages/workspace-app/src/state/store.svelte.ts` at `6a0e16b16`: `onSessionChangedFrame` armed the 250 ms sync refetch; the move's close armed the page's own save; `applyRemoteSessionBlob` flushed that save and re-armed the refetch, but `commitSessionSave` starts its `api.putSession` without awaiting it, so the re-armed fetch read the co-viewer's older blob before the page's PUT landed, and `reconcileLayout` in `state/tabs.svelte.ts` restored the moved terminal as a remote terminal with no live match. Once in 22 runs of the check; the check now waits for the co-viewer's save to settle before the move and does not reach the race.

Seen again at the candidate `78f787b4d` on the front tab before any move (the lead's pack, check 150 red once): 305 ms after the tab's socket opened, a `session_changed` of the window was followed by the socket's close, and the co-viewer's later blob re-created the tab under a new id, so the cleanup's close by the original id found no tab; the same shape as check 157's vanished tab at `a09396ef0`. So the race reaches a tab just created as well as one just moved.

Not established: whether the same window of time exists for a tab closed rather than moved, and what a user sees after it (the moved terminal in both windows until one is closed).

## Desired contract

A page's own flushed save is observed by its own refetch: the refetch that follows a flush reads the blob the flush wrote, or a later one, never an older co-viewer's.

## What to do

Make `applyRemoteSessionBlob` await the flushed PUT before it re-arms the refetch, or carry the flushed payload's hash so a fetched blob older than it is discarded; pin it with a store-level test that orders the co-viewer's write, the local flush and the refetch as the record did, red first on its own assertion.

## Boundaries

`web/packages/workspace-app/src/state/store.svelte.ts` (the co-view sync section) and its tests; `state/tabs.svelte.ts` only if the reconcile must learn to refuse a terminal marked moving out. Not changed: the cross-window move itself and check 150's settle wait, which stays as the check's own guard.

## Acceptance

1. A store-level test that reproduces the record's order (co-viewer save, local move-out close, flush, refetch) fails before the change on the re-created terminal and passes after.
2. Check 150 with its settle wait removed in a guest-only run passes in a loop of twenty runs, each engine, with no terminal re-created in the source window; the settle wait is kept in the committed check.
3. The decision on a closed (not moved) tab recorded here, measured or stated unmeasured.
