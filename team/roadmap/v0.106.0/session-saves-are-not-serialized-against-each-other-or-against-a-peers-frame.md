# Session saves are not serialized against each other or against a peer's frame

Status: raised by the frontend seat on 2026-10-13 from its repair of the moved-terminal item ("Remaining paths" of `tasks/task-Frontend106-Lead106-25.md` in the round's bus); written down the same day by the lead as a row of its own, outside that item; owner the frontend seat; not reached in the v0.106.0 round

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
