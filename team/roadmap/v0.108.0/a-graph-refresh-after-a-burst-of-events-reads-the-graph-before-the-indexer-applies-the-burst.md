# A graph refresh after a burst of events reads the graph before the indexer applies the burst

Status: carried into v0.108.0 at the v0.107.0 GA on 2026-10-17, still raised for a decision.

Record before the release: raised on 2026-10-16 by the lead from the review seat's read of the graph refetch item's design; read at source by the review seat and the lead; written down with the repair's shape; built by the runtime seat (the server's frame) and the frontend seat (the coordinator's end of burst) after their lanes' items; owner the runtime seat.

## What was seen

Read at source at `d1a17d97a`, not constructed. The watch bridge sends every filesystem event to the indexer's channel first, then as a `watch` frame to the sockets by the event's origin (`crates/chan-server/src/bus.rs`, `WatchBroadcast::on_event`): a change from outside chan without `source_w`; a window-noted create, removal or rename with it; a windowless note and a window-noted modification, which is a save made in chan's editor, with no frame at all. So after an in-app save no frame reaches any window, and the inspector's graph is not refreshed by a frame whatever the timing until another event comes; the indexer applies the save all the same. The indexer's worker wakes every 200 ms and applies a path only when its last event is at least the configured debounce old (`crates/chan-server/src/indexer.rs`: `spawn_watcher_loop`'s worker, its 200 ms tick, `collect_due` and `apply_pending_change`; `search_aggression.debounce()` in `crates/chan-workspace/src/index/facade.rs`: 1 s at the default, Balanced; 2 s Conservative; 250 ms Aggressive). `/api/graph` builds its view from the graph DB that apply writes, so a new note's node, its tags and its links appear only after it. The page's graph refresh after a burst of events, one fetch 250 ms after the last frame under the graph refetch item, starts 0.75 s to 1 s before the burst is indexed at the default; the fetch per frame at that item's base starts earlier than that. Nothing reloads the graph after the apply: the graph DB lives in the sidecar outside the root, so no frame follows; the per-file apply sets the index status to `reindexing` for the length of the apply, which the page's idle status poll (10 s) sees only when a poll falls inside it; and the `IndexFile` progress frames come from a rebuild, not a per-file apply (`web/packages/workspace-app/src/state/store.svelte.ts`, `pollIndexStatusOnce` and its transient states). The graph panel's own 250 ms reload has the same race.

Not established: that a person has seen a stale inspector after a save (the next event, or a transient status poll that catches a rebuild, reloads it); a constructed run (a note saved with a new tag, the inspector read 300 ms and 2 s after) is the acceptance's first step.

## Desired contract

The graph a surface shows after a burst of filesystem events includes the burst's changes as the index holds them: the page's refresh follows the index's apply of the burst as well as the burst's last frame.

## What to do

A server frame when the indexer applies a watcher change (the paths applied, after the graph DB write), sent to the subscribed sockets; the page's graph coordinator takes that frame as one more event of its quiet window, with the same re-arm and the same stall bound, since at the window's end the page cannot know whether an apply will follow (a path outside the indexable gate is ignored, a VCS burst becomes a rebuild, and a burst's paths fall due on different ticks). A burst the index applies costs a fetch at the quiet window's end after its frames and one after its apply frames; a burst it does not apply costs one; an apply frame with no burst before it, an in-app save, costs one. The server part is the runtime lane's, the page's part the frontend lane's; the coordinator's quiet window, its stall bound and its pins from the graph refetch item stay.

## Boundaries

`crates/chan-server/src/indexer.rs` (the worker's apply; the frame sent after `apply_pending_change` returns), the bus and the frame types under `crates/chan-server/src/`, `web/packages/workspace-app/src/state/graphData.svelte.ts` and its tests, the design texts. Not changed: the debounce and its preference, the graph route, the index status poll.

## Acceptance

1. A constructed run in two arms, a write from outside chan and a save in chan's editor: a note given a new tag; the inspector's references show the tag within the debounce plus one apply, with no further event; red first at the base in both arms, the tag absent until the next event.
2. A server test: an apply of a watcher change sends one frame naming it, after the graph DB write; none for an apply that changes nothing.
3. A page test: the coordinator fetches once after a burst's frames and once after its apply frames; once for a burst with no apply; and once for an apply frame alone.

## The owner's word 2026-10-16

Asked at the cut through one survey that listed the thirteen rows not shipped and the seven findings outside any item, with the lead's recommendation on each, and offered each row's own question with its cost (this row's line: "grfapl, the graph refresh before the index apply: carry with its shape written"), the owner answered: "Take all fourteen recommendations as listed (Recommended)". The row moves to v0.108.0 at the GA commit with its record as it stands.
