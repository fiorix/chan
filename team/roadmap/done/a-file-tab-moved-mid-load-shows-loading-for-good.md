# A file tab moved to another pane while it loads shows "loading" for good

Status: shipped in [v0.100.0](../../release/release-v0.100.0.md): A load that stops leaves no tab claiming to be loading, and a tab that moved mid-load finishes or restarts its load where it now is.

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
