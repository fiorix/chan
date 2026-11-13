# One timed-out directory read fails a graph tab's first load

Status: accepted for v0.131.0 by the owner on 2026-11-13; not started.

Record: found by the second independent review of v0.129.0's graph fixes on 2026-11-13, from reading and the builder's diagnostic run on a kernel-sized tree, the same at the base (`dev/v0129/reviews/review-graphfix-2.md`, finding 4; run `dev/v0129/evidence/graphfix/r3-diag-wide/out.json`). Left open in the shipped [graph row](../done/the-graph-tab-draws-a-different-graph-for-each-way-it-is-opened.md) ("Open") and in `dev/v0129/row-notes.md`, "Graph work: follow-ups from the second review". At v0.130.0's planning the owner placed the later group of rows, this one among them, in v0.131.0: "yes v0.131" (`dev/v0130/status.md`).

## What is there now

Read at `342dbe791`, in `web/packages/workspace-app/src/components/GraphPanel.svelte` unless named:

- A graph tab's first load reads its spine: the root and every opened directory whose ancestors are open, one `/api/fs-graph` level a request, four ahead (`loadSpine`, 1335-1391; `openedSpineDirs`, 1395-1400). A level answering 404 or 400 counts as a directory gone (`fetchSpineLevel`, 1492-1521); any other failure, a request timeout among them, leaves the loop, and `spineFailed` (1402-1411) sets `spineError`. Every request has a 10 s limit (`REQUEST_TIMEOUT_MS`, `web/packages/workspace-app/src/api/transport.ts:517`).
- `spineError` is the tab's `error` (453): the canvas is drawn at 40 percent opacity (`.cy.dim`, 2139 and 2468-2470) with the error text across it (2129-2130).
- The levels read before the failure are not kept as a base to patch: the next change is a whole fetch again (`takeSpineChanges`, 1874-1891), which on the same tree can time out again, and a directory opened meanwhile waits for it (231). Until then, or `Reload graph`, the dim and the text stay.
- On the Linux 6.12 tree with hundreds of directories opened, a restore made 304 to 481 level requests of more than 639 levels needed and failed at 35.4 s on `request timed out after 10000 ms: GET /api/fs-graph?scope=directory&path=security%2Fbpf...`, 2.7 s after the shared graph had landed; the base made 145 to 161 and failed the same way, with the same 18,227 nodes drawn. Why a level read passes 10 s is not established; the review's likeliest reading is the main thread busy with the shared graph's last events while the request's timer runs, with the browser's six connections per host (four level reads and the stream) the other candidate.

## Desired contract

1. A directory level that fails for a reason other than being gone (a timeout, a dropped connection) does not fail the tab's load: the levels read stay drawn and stay the base later changes patch, the graph is not dimmed, and no error shows while the shared graph covers that directory.
2. Such a level is read again once, after the shared graph is whole. If it fails again and the shared graph does not cover it, the tab says which directory it could not read, without dimming what it draws.
3. A failure of the root's own level is reported as it is now, a missing workspace root included.

## Boundaries

- The spine load in `GraphPanel.svelte` (`loadSpine`, `fetchSpineLevel`, `spineFailed`) and how the tab shows a spine error. The 10 s request limit is unchanged.
- Not here: why a level read passes 10 s on that tree; the shared graph's per-event publish ([its row](the-window-stalls-for-seconds-while-a-large-workspaces-graph-streams-in.md)), which the review names as a likely cause, may make the timeout rarer but leaves this contract as it is.

## Acceptance

1. Workspace app tests over the graph panel with the fs-graph stub (`web/packages/workspace-app/src/__tests__/graphPanel.ts`): one opened directory's level rejects with a request timeout; the tab draws the other levels, is not dimmed and shows no error once the shared graph covers that directory; the level is asked for once more; a later change is a patch, not a whole fetch. Red on the code without the change.
2. In a guest, the builder's kernel-tree restore (`dev/v0129/evidence/graphfix/r3-diag-wide/`, hundreds of directories opened), five restores on the code without the change and five with it: the error text over a dimmed graph recorded where it shows, none with the change, and the count of levels that timed out recorded.
