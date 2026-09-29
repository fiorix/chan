# A drawing's stroke still inside the canvas's debounce is lost when its tab loads again

Status: raised for a decision on 2026-09-29 by the report of the order on two closes and a drawing's last stroke ([two-closes-still-drop-a-drawings-last-stroke](two-closes-still-drop-a-drawings-last-stroke.md); `dev/v0101-team/reports/report-Frontend-31.md` in the development tree, "Leaning 8, raised and not built", with its table of routes), a range that has not landed, which read it at `75ba73028` and built nothing of it. Read again at `e2a7e608f`, where the canvas, the session and the routes hold it as the report reads it; not run. Older than the builds of 2026-09-29. It corrects the mechanism that a cost of [a-draft-closed-during-its-load-is-trashed](a-draft-closed-during-its-load-is-trashed.md) gave, which put the stroke in the buffer during the load. Recommendation, by the lead's rule for this landing: accept for v0.101.0, since a user's stroke is lost with no word by three routes.

## What was seen

Lines at `e2a7e608f`, under `web/packages/workspace-app/src/`. A drawing's canvas serializes a change 200 ms after it (`scheduleSerialize`, `editor/ExcalidrawCanvas.svelte:402-405`). A load empties the tab's buffer and marks the tab loading as it starts (`loadTabContent`, `state/tabs.svelte.ts:3040-3052`). While the tab loads the canvas publishes nothing (`flushSerialize`, `editor/ExcalidrawCanvas.svelte:485-487`, fed `loaded` by its host, `components/FileEditorTab.svelte:1473`), and it has no session to push to, since a loading tab is not eligible for one (`isSceneSyncEligible`, `state/sceneSync.svelte.ts:122`; the host's effect, `components/FileEditorTab.svelte:404-417`). When the load ends, the content effect seeds the board from the loaded buffer (`editor/ExcalidrawCanvas.svelte:570-579`), and the seed replaces the board's elements (`seed`, `:441-445`). So a stroke still inside the debounce when a load starts reaches neither the buffer nor the authority, and the seed at the load's end takes it off the board. A flush run inside the load keeps nothing either, since the load has emptied the buffer.

Which routes lose it, at the tip:

- **A replace of the file,** by the browser's upload or the desktop's picker, refreshes each of the file's tabs only when the tab's buffer is its saved content (`refreshTabFromDisk`, `state/tabs.svelte.ts:8064-8069`; its callers, `state/store.svelte.ts:1771`, `:5723`). A stroke inside the debounce leaves the buffer clean, so the load runs and the stroke is lost with no word.
- **The missing-file check** reloads a tab whose buffer is its saved content the same way (`resolveMissingFileCheck`, `state/tabs.svelte.ts:7967-7992`, the load at `:7990-7992`).
- **Reload from disk** asks first only when the buffer differs from its saved content, the disk conflicted, or a live session holds state the disk lacks (`forceReloadFromDisk`, `:8116-8148`, the question at `:8120`). A live board's pending stroke is such state, since its version is past the one its session noted (`hasUnflushedState`, `state/sceneSync.svelte.ts:400-403`; `hasPendingLocal`, `editor/ExcalidrawCanvas.svelte:340-343`), so a live tab asks; a tab with no live session asks nothing and loads (`state/tabs.svelte.ts:8147`).
- **The tab menu's Reload, the changed-on-disk banner's Reload and the conflict dialog's Reload** ask nothing of any buffer (`reloadTabFromDisk`, `:8102-8106`, reached from `components/FileEditorTab.svelte:887-890` and `:1028`; `reloadConflictedTab`, `state/tabs.svelte.ts:5677-5694`), so the stroke goes with the rest of the buffer, by the user's choice.

The closes already run a tab's pending flush before they ask (`confirmCloseTabs`, `state/tabs.svelte.ts:2921`; the single close, `:3619`), through the flush the host registers for its canvas (`registerPendingEditFlush`, `:2665-2668`; `components/FileEditorTab.svelte:180`); none of the routes above does.

## Desired contract

A stroke drawn on a board just before its tab loads again is in the buffer before a route decides whether the tab is clean: a route that keeps a dirty tab keeps it, and a route that asks about unsaved changes asks.

## What to do

As the report proposes: run the tab's pending-edit flush before the guard of `refreshTabFromDisk`, `resolveMissingFileCheck` and `forceReloadFromDisk`, three calls with a pin each, red first. The routes that reload with no question by the user's choice are unchanged.

## Boundaries

`web/packages/workspace-app/src/state/tabs.svelte.ts` (`refreshTabFromDisk`, `resolveMissingFileCheck`, `forceReloadFromDisk`) and their tests. The closes are [two-closes-still-drop-a-drawings-last-stroke](two-closes-still-drop-a-drawings-last-stroke.md)'s, and the canvas is unchanged.

## Acceptance

1. A replace or an upload over a drawing whose last stroke is inside the debounce leaves the tab alone, dirty and holding the stroke; pinned red first.
2. The missing-file check the same; pinned red first.
3. Reload from disk on a drawing with no live session asks before it discards such a stroke; pinned red first.
