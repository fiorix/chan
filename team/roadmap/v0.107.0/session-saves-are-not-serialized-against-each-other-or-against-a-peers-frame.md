# Session saves are not serialized against each other or against a peer's frame

Status: carried into v0.107.0 at the v0.106.0 GA on 2026-10-15, still raised for a decision.

Record before the release: raised by the frontend seat on 2026-10-13 from its repair of the moved-terminal item ("Remaining paths" of `tasks/task-Frontend106-Lead106-25.md` in the round's bus); written down the same day by the lead as a row of its own, outside that item; owner the frontend seat; not reached in the v0.106.0 round

## What was seen

Read at source in `web/packages/workspace-app/src/state/store.svelte.ts`, not run. The moved-terminal item's repair makes `applyRemoteSessionBlob` await the flushed write before it re-arms the refetch. Three paths beside it remain: a failed flushed PUT stops the re-arm, so the removed terminal stays absent in this page, but the dedupe snapshot was advanced before the PUT, so an identical later save may not retry and a reload can read the old blob; a debounce PUT already in flight has no pending timer to flush, so a peer's frame arriving in that interval can still fetch without waiting for it; and two overlapping own PUTs can finish out of order, the older blob landing last.

## Desired contract

One window's session saves reach the server in the order they were made, a peer's frame never makes this window read back a blob older than a save of its own that is still in flight, and a save that failed is retried or reported, not forgotten behind a dedupe.

## What to do

Construct each path as a store test with the PUT held (the moved-terminal item's test file has the fixture): the failed save with the dedupe, a peer frame during an in-flight debounce save, two overlapping saves released in the reverse order; read the outcomes. Then design, to the review seat before code: one in-flight save at a time with the latest state coalesced behind it, the refetch awaiting any in-flight save, the dedupe snapshot advanced only on success.

## Boundaries

`web/packages/workspace-app/src/state/store.svelte.ts` (the session save and the remote blob's application), `state/sessionSync` and their tests. Not changed: the server's session route and its last-writer rule.

## Acceptance

1. The three constructed cases with their outcomes at the base.
2. The decision recorded here.
3. If a change: each case red first on its own assertion and green after; the moved-terminal item's cases still green.

## One case constructed by the review of the moved-terminal repair 2026-10-13

The review seat's read of that repair (`reviews/review-Review106-covret-range-1.md` in the round's bus, its finding C1) constructed and ran a fourth path at the repaired tip: a co-viewer's frame, the local removal, the flush with its PUT slow, and one more frame from the co-viewer while that PUT is in flight. The second frame arms a read of its own; after the flush no save is waiting, so 250 ms later the GET goes out with the PUT held, the older blob is applied and the removed terminal is back. The test's text is in the review's script (`evidence/Review106/covret-range-1.sh`), red at the tip on the presence assertion. And of the three paths above, the first is longer-lived since the repair: a failed flush used to be followed within 250 ms by the re-armed read, which replaced the unsent layout; now the page keeps a layout the dedupe records as sent until a co-viewer's frame or a different local change. One repair is named for the frame cases: remember the write in flight and have the read-back wait for it before its GET; not built, not run.

## A second case measured by the reading of the dropped-tab row 2026-10-13

The row `tablos` (a second page's load drops a just-added tab) was read and reproduced by the frontend seat at `710527543`: a second page of one window whose GET of the shared layout completes before the first page's PUT of a just-added tab saves its older layout over it (3 of 10 attempts), and a page reloaded in the same interval restores the lagging layout over its own reload snapshot and re-homes the tab on a new shell (5 of 10); the session is live in both. That row's record holds the lines and the counts. The repair it proposes, a versioned or conditional write of the shared layout and the reload snapshot's session ids taking priority while the layout lags, is this row's design, with the frame cases above, in the next version; by the review's read of that row's record (`reviews/review-Review106-tablos-record-1.md` in the round's bus) the design takes two clauses: a page reloaded before the tab's attach has returned has no id in any snapshot, so the snapshot's priority cannot cover every re-homing; and the co-view loss is one write, the page's early flush of its restored layout about 275 ms after its read, so the first candidate is a bootstrap that records its restored layout as already sent and withholds that flush, read first for the server's persisted-window mark that the write carries (`routes/sessions.rs` 160; `terminal_sessions.rs` 505, 2882).
