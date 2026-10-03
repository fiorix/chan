# An inspector effect refetches a failing graph stream without bound

Status: shipped in [v0.101.0](../../release/release-v0.101.0.md).

Record before the release: ratified for v0.101.0 by the owner on 2026-09-29, after it had landed; raised during v0.101.0 on 2026-09-26 by the independent review of the graph lens dedup order (`dev/v0101-team/reviews/review-Frontend-8.md`, finding 1, in the development tree), which corrected the lane's own reading; pre-existing at `main` `ef33cb0f3`, read in code and reproduced only as the OOM it caused in that order's test run. It was not put to the owner when it was raised, since it landed with its fix.

## What was seen

Three inspector bodies call `ensureGraphLoaded()` from a Svelte `$effect` (`web/packages/workspace-app/src/components/FileInfoBody.svelte`, `TagInfoBody.svelte`, `WorkspaceInfoBody.svelte`). `ensureGraphLoaded` reads `graphData.view` and `graphData.error` synchronously, so the effect tracks both, and it writes both inside each attempt. A graph stream that fails every time (an `error` event, or a body that ends before `done`) sets `graphData.error`, the effect re-runs, and a new stream starts: back-to-back `/api/graph?stream=1` requests for as long as a file, tag or workspace inspector shows. Every lap crosses an `await`, so Svelte's depth guard never fires. `FileInfoBody` pays more: its graph call sits inside the backlinks effect, so each re-run, and on the success path each per-batch publish and each watcher-driven reload, aborts and re-issues the file's backlinks request and resets its section. In a test run the same loop, driven by a stub that threw on every call, exhausted the heap.

## Desired contract

A graph load an inspector triggers does not re-trigger itself: a failing stream is retried by a later mount or an explicit reload, not by its own error, and a file's backlinks request is restarted only when the file changes.

## What shipped

Landed on 2026-09-26: the three calls run untracked, the graph load left the backlinks effect, pinned by a failing stub that counts one stream start and a three-batch stub that counts one backlinks request.

## Boundaries

The three inspector bodies and their tests; `state/graphData.svelte.ts`'s retry rule is unchanged.
