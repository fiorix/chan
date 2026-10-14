# The watch tail refetches the graph on every frame while a browser or graph tab is open

Status: raised by the review seat on 2026-10-14 from its read of the coalesced relist range (N3 of `reviews/review-Review106-relist-range-1.md` in the round's bus, measured there); written down the same day by the lead as a row of its own, outside the relist row; owner the frontend seat; not reached in the v0.106.0 round

## What was seen

Read at source at `v0106/frontend-relist` `14e6ca158` and counted in check 163's runs. The watch tail's second reaction to every frame, older than the relist landing, drops the cached graph and, when a File Browser tab or a graph tab is open, refetches it at once (`web/packages/workspace-app/src/state/store.svelte.ts` 1200 to 1210: `invalidateGraph()` then `void ensureGraphLoaded()`, whose comment calls the fetch de-duped). Each filesystem event reaches a window as two frames, so an event with such a tab open costs the graph route a request per frame beyond the one in flight. Counted in browser check 163 (`163-file-browser-watch-refresh.mjs`), which opens a File Browser and creates, modifies and removes a few files: 76, 83 and 74 requests to `/api/graph` in five to seven seconds, at the relist tip and with the candidate's store alike (10 in the paired control, which the earlier check's state changed), beside 9 to 12 directory listings in the same runs. Under a churn like check 62's 256-file probe the graph would be fetched back to back for its whole length. The graph is the workspace's link index, a whole-workspace read on the server.

Not established: the graph route's cost per request on the server; the count under check 62's probe with a graph tab open; whether `ensureGraphLoaded`'s de-duplication holds a request in flight or only a loaded result.

## Desired contract

A burst of filesystem events costs a bounded number of graph fetches while a graph surface is open, and the graph a person sees is one fetched after the last event.

## What to do

Count first: check 163's `/api/graph` requests per created file at the base and the tip (the relist range's reader already counts routes), and a store test with N frames and an open browser tab. Then the proposal to the review seat before code: the same shape as the watch relists' coordinator (one fetch in flight, one queued, a short quiet window), or one invalidation per burst with the fetch left to the next view.

## Boundaries

`web/packages/workspace-app/src/state/store.svelte.ts` (the watch tail's graph reaction and `ensureGraphLoaded`) with its tests, and check 163's counts. Not changed: the graph route.

## Acceptance

1. The count per frame at the base, in a test and in check 163.
2. The decision recorded here.
3. If a change: N frames with a graph surface open cost a bounded number of fetches, the last one after the last frame, pinned red first; one mutant per guard.
