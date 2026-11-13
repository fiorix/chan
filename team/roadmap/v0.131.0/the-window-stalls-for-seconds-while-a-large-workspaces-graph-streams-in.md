# The window stalls for seconds while a large workspace's graph streams in

Status: accepted for v0.131.0 by the owner on 2026-11-13; not started.

Record: measured on 2026-11-12 by v0.129.0's graph fix rounds: on the Linux 6.12 tree, after a branch switch to `v6.12`, the longest main-thread task was 3,123 ms (`dev/v0129/evidence/graphfix/r3-checkout-after/run.log`, line 4). The second independent review traced it by reading, with no profile, to the shared graph's reload (`dev/v0129/reviews/review-graphfix-2.md`, "The 3.1 s main-thread task, by reading"). Left open in the shipped [graph row](../done/the-graph-tab-draws-a-different-graph-for-each-way-it-is-opened.md) ("Open") and in `dev/v0129/row-notes.md`, "Graph work: follow-ups from the second review". At v0.130.0's planning the owner placed the later group of rows, this one among them, in v0.131.0: "yes v0.131" (`dev/v0130/status.md`).

## What is there now

Read at `342dbe791`, in `web/packages/workspace-app/src/`:

- The shared graph streams `/api/graph?stream=1` as NDJSON events (`api.graphStream`, `api/client.ts:1405-1456`). On every `nodes` or `edges` event it builds the whole view so far, copying both of its maps into new arrays (`view()`, 1417-1420), and passes it on. A first load (`loadGraph`, `state/graphData.svelte.ts:78`: no view held, or a partial one) publishes each of those views, copying both arrays again (`publishGraphView`, 55-60). A refresh ignores them and publishes the completed view once.
- The reload at the end of an index rebuild drops the view first (`reloadGraph`, `graphData.svelte.ts:217`, from `state/store.svelte.ts:6175`), so after a branch switch on a large tree it streams as a first load. A shown graph tab that draws no whole graph takes every partial view (`components/GraphPanel.svelte:1700-1713`) and derives what it draws from each. `readNdjsonStream` (`api/client.ts:679-720`) handles the chunks already received without yielding to the browser between events.
- On the kernel tree the stream has 1,402 events; the review's plain-Node model put the per-event copies alone at 0.74 s per stream. Measured after the switch: 92,189 nodes and 173,526 edges, 24.1 s of main-thread tasks, the longest 3,123 ms. The comparable run before v0.129.0's graph fixes had a longest task of 558 ms under fewer than half the watch frames (37k against 82k), so the review could not pin the rise on those fixes. The per-event publish is the review's likeliest cause; nothing has traced it.

## Desired contract

1. While the shared graph streams, its view is built and published at most once per frame, and once when the stream completes, whatever the number of events; no event copies the whole graph received so far.
2. A refresh, which publishes only the completed view, builds no view per event.
3. What is drawn when the stream completes is the same graph as now.

## Boundaries

- `api.graphStream` (`api/client.ts`), `loadGraph` and `publishGraphView` (`state/graphData.svelte.ts`), and a graph tab's taking of a streaming view. The server's stream may change as well (frames already queued sent under one gzip flush, as the review proposes); the contract does not depend on it.
- Not here: the spine's level timeout ([its row](one-timed-out-directory-read-fails-a-graph-tabs-first-load.md)), which this may make rarer; the canvas's own layout cost.

## Acceptance

1. First, a profile: the branch-switch reading on the kernel tree in a guest, in a release build (`dev/v0129/evidence/graphfix/scripts/checkout-burst.mjs`), with a performance trace, on the code without the change, naming what the longest task runs. If it is not the stream's handling, the row goes back to the owner rewritten from the trace before anything is built.
2. Workspace app tests: a graph stream of many `nodes` and `edges` events delivered in one chunk publishes at most one view per frame and the whole view at the end; a refresh builds no view per event. Red on the code without the change, which publishes one view per event.
3. The reading of step 1, five runs without the change and five with it on the same ref pair: the longest main-thread task and the total task time recorded, the longest task with the change below the lowest without it.
