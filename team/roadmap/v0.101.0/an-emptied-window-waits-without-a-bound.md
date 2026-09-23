# An emptied window waits for its move-out without a bound

Status: raised during v0.100.0 on 2026-09-23; not accepted. From the Lead follow-ups ledger (2026-09-23 09:54Z, review of the tab-move fix) and the release report. A source reading against `main` at `6237c2677`.

## What was seen

`closeEmptiedWindow` (`web/packages/workspace-app/src/state/store.svelte.ts:3459`) awaits the move-out DELETE before it asks the host to close (`:3461`), with no time bound. A local request that hangs holds an empty window open until the request fails; the user can still close it, and that close reaps.

## What to do

Bound the wait (a few seconds) and close anyway when it expires, with a test on a DELETE that never settles.
