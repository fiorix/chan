# A file tab moved to another pane while it loads shows "loading" for good

Status: accepted for v0.100.0 by the owner on 2026-09-20, raised during the round by the shell lane and confirmed by the independent review of [a-tab-reorder-drops-live-tab-state](a-tab-reorder-drops-live-tab-state.md). Small, sequenced beside [a-terminal-moved-to-another-window-loses-its-tab-state](a-terminal-moved-to-another-window-loses-its-tab-state.md), with the same exit to v0.101.0. The lookup was re-read against `main` at `ad8ef6087`; the `finally` reading is the lane's and the reviewer's.

## What was seen

`loadTabContent` in `web/packages/workspace-app/src/state/tabs.svelte.ts` finds its tab through a `live()` helper that looks in the pane the load started in, by pane id and tab id. A reorder inside that pane keeps the lookup working, so the load carries on and writes its progress onto the moved tab. A move to another pane makes the lookup miss: the load aborts, which is right, and then its `finally` clears `loading` and `loadProgress` through the same lookup, which misses again. The tab in its new pane keeps `loading: true` and never shows its content.

## Desired contract

A load that stops, for any reason, leaves no tab claiming to be loading. A tab that moved while it was loading either finishes its load where it is now or starts one there; it never waits on a load nobody is running.

## Boundaries

`state/tabs.svelte.ts` (`loadTabContent` and its `live()` helper) and its tests. Resolving the tab by id across the layout, as the close path now does through `locateTab`, is the shape the file already has. No change to the fetch itself.

## Acceptance

1. A test starts a load, moves the tab to another pane before the first chunk, and asserts the tab ends with its content shown and `loading` false.
2. The same for a move to the other side of a split and for a Hybrid Nav commit during the load.
3. A load aborted because its tab was closed leaves nothing behind: no controller, no progress, no flag.
