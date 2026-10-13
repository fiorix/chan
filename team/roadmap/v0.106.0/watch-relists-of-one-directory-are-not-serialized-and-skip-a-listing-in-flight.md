# Watch relists of one directory are not serialized and skip a listing in flight

Status: raised by the review seat on 2026-10-13 from its read of the file tree root rows design (A2 and A3 of `reviews/review-Review106-fbroot-design-1.md` in the round's bus); written down the same day by the lead as a row of its own, outside that item; owner the frontend seat; not reached in the v0.106.0 round

## What was seen

Read at source at `v0106/frontend` `31513a64f`, not run. A watch event relists a directory once per frame, and one change is several frames: the core watcher does not debounce and says a save is a burst of events (`crates/chan-workspace/src/watch.rs` 23 to 29), and each event reaches a subscribed window twice, as the global `watch` frame and as the scoped `fs` frame (`crates/chan-server/src/bus.rs` 94 to 111 and 338 to 383), both through the same tail of `onWatchEvent` (`web/packages/workspace-app/src/state/store.svelte.ts` 1162 to 1188). Each listing is a directory read, a contacts scan and content sniffs on the server (`crates/chan-server/src/routes/files.rs` 196 to 231). Two listings of one directory can land in either order, and one served before the last change that lands last leaves a row missing until a later event there; `relistTreeDir`'s own comment names that hazard for the direct operations (3056 to 3062).

Separately, a directory whose first listing is in flight is in `tree.loadingDirs` and not yet in `tree.loadedDirs` (2899), so an event for it is skipped; if that listing was served before the change, the row is missing until a later event in that directory. The trigger is a file created during the round trip of a directory's expansion, or during the reload that follows every full tree refresh (each socket reopening and each lag cue resets the loaded set, and the tree then reloads every expanded directory).

The product has both today wherever an event is in scope, which with nothing selected is everywhere; the root rows change makes the per-frame relist the watch path's only route. Not established: any of the counts, in a run; an observed missing row from either cause.

## Desired contract

A burst of events in one directory costs a bounded number of listings, and the listing that decides the directory's rows is one asked for after the last event; an event that arrives while a directory's first listing is in flight is not lost.

## What to do

Construct both cases in the store's watch-frame tests first: N frames while one listing is held, and a frame while a first listing is held. Then the review's proposal, to the review seat before code: per directory, at most one watch relist in flight and at most one queued behind it, the shape `reconcileWorkspaceRootAvailability` already has for the root (963 to 988); an event for a loading parent waits for that listing and relists once.

## Boundaries

`web/packages/workspace-app/src/state/store.svelte.ts` (the watch tail and the relist helpers) with `store.watchFrames.test.ts`. Not changed: the server's watcher and its frames, and the rule that decides which parents relist.

## Acceptance

1. Each case constructed, red on its own assertion or shown not reachable with the reason.
2. The decision recorded here.
3. If a change: N frames while one listing is held give exactly two listing calls and the last file's row; a frame during a first listing gives a second listing and the row; one mutant per guard.
