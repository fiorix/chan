# A drawing's stroke still inside the canvas's debounce is lost when its tab loads again

Status: accepted for v0.101.0 by the owner on 2026-09-29; raised for a decision on 2026-09-29 by the report of the order on two closes and a drawing's last stroke ([two-closes-still-drop-a-drawings-last-stroke](two-closes-still-drop-a-drawings-last-stroke.md); `dev/v0101-team/reports/report-Frontend-31.md` in the development tree, "Leaning 8, raised and not built", with its table of routes), a range that has not landed, which read it at `75ba73028` and built nothing of it. Read again at `e2a7e608f`, where the canvas, the session and the routes hold it as the report reads it; not run. Older than the builds of 2026-09-29. It corrects the mechanism that a cost of [a-draft-closed-during-its-load-is-trashed](a-draft-closed-during-its-load-is-trashed.md) gave, which put the stroke in the buffer during the load.

## Owner ruling

Accepted on 2026-09-29 for v0.101.0, for two of its three routes. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. This item enters: a user's stroke is lost with no word, and the fix is a call before a guard. The shape, as ruled: the tab's pending flush runs before the guard of `refreshTabFromDisk` and before that of `forceReloadFromDisk`, each with its pin, red first. The third call, inside the missing-file check (`resolveMissingFileCheck`), is not made: that check is code of the Clients lane's that stays closed to this order. So the first and the third acceptance points are this build's, and the second is left open and is a cost: the missing-file check can still reload a tab over a stroke that waits. When it was raised the lead recommended accepting it for v0.101.0 for all three routes.

## What was seen

Lines at `e2a7e608f`, under `web/packages/workspace-app/src/`. A drawing's canvas serializes a change 200 ms after it (`scheduleSerialize`, `editor/ExcalidrawCanvas.svelte:402-405`). A load empties the tab's buffer and marks the tab loading as it starts (`loadTabContent`, `state/tabs.svelte.ts:3040-3052`). While the tab loads the canvas publishes nothing (`flushSerialize`, `editor/ExcalidrawCanvas.svelte:485-487`, fed `loaded` by its host, `components/FileEditorTab.svelte:1473`), and it has no session to push to, since a loading tab is not eligible for one (`isSceneSyncEligible`, `state/sceneSync.svelte.ts:122`; the host's effect, `components/FileEditorTab.svelte:404-417`). When the load ends, the content effect seeds the board from the loaded buffer (`editor/ExcalidrawCanvas.svelte:570-579`), and the seed replaces the board's elements (`seed`, `:441-445`). So a stroke still inside the debounce when a load starts reaches neither the buffer nor the authority, and the seed at the load's end takes it off the board. A flush run inside the load keeps nothing either, since the load has emptied the buffer.

Which routes lose it, at the tip:

- **A replace of the file,** by the browser's upload or the desktop's picker, refreshes each of the file's tabs only when the tab's buffer is its saved content (`refreshTabFromDisk`, `state/tabs.svelte.ts:8064-8069`; its callers, `state/store.svelte.ts:1771`, `:5723`). A stroke inside the debounce leaves the buffer clean, so the load runs and the stroke is lost with no word.
- **The missing-file check** reloads a tab whose buffer is its saved content the same way (`resolveMissingFileCheck`, `state/tabs.svelte.ts:7967-7992`, the load at `:7990-7992`).
- **Reload from disk** asks first only when the buffer differs from its saved content, the disk conflicted, or a live session holds state the disk lacks (`forceReloadFromDisk`, `:8116-8148`, the question at `:8120`). A live board's pending stroke is such state, since its version is past the one its session noted (`hasUnflushedState`, `state/sceneSync.svelte.ts:400-403`; `hasPendingLocal`, `editor/ExcalidrawCanvas.svelte:340-343`), so a live tab asks; a tab with no live session asks nothing and loads (`state/tabs.svelte.ts:8147`).
- **The tab menu's Reload, the changed-on-disk banner's Reload and the conflict dialog's Reload** ask nothing of any buffer (`reloadTabFromDisk`, `:8102-8106`, reached from `components/FileEditorTab.svelte:887-890` and `:1028`; `reloadConflictedTab`, `state/tabs.svelte.ts:5677-5694`), so the stroke goes with the rest of the buffer, by the user's choice.

The closes already run a tab's pending flush before they ask (`confirmCloseTabs`, `state/tabs.svelte.ts:2921`; the single close, `:3619`), through the flush the host registers for its canvas (`registerPendingEditFlush`, `:2665-2668`; `components/FileEditorTab.svelte:180`); none of the routes above does.

**Read again at `4c4ada0a1` on 2026-09-29:** none of the three guards runs the tab's pending flush before it reads whether the buffer is its saved content (`refreshTabFromDisk`, `web/packages/workspace-app/src/state/tabs.svelte.ts:8198-8203`; `resolveMissingFileCheck`, `:8080-8109`; `forceReloadFromDisk`, `:8250-8282`). Read, not run.

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

## What shipped

The build is on the integration branch and not on `main`, in ranges the lead accepted, with the combined gate green on Linux at the integration's tip. This record was written on 2026-10-02 from a reading of the code at that tip; what the acceptance of its range found beyond the code is in the round's records and was not read for it.

Two of the three routes are built, as the owner's ruling accepted the item: a refresh of a tab from disk, which a replace or an upload reaches, and Reload from disk each commit the waiting edits before their guard reads the buffer (`refreshTabFromDisk` and `forceReloadFromDisk`, `web/packages/workspace-app/src``/state/tabs.svelte.ts`). Pinned in `components/FileEditorTab.canvasEdits.test.ts`: a refresh leaves a waiting stroke in the drawing's buffer, and Reload from disk asks before it discards one. **Not built, by that ruling:** the missing-file check (`resolveMissingFileCheck`) still compares the buffer with the saved text and commits nothing first, so the item's second acceptance point is open, and `editor/design.md` says so; that route is [a-missing-file-check-commits-no-waiting-stroke](../v0.102.0/a-missing-file-check-commits-no-waiting-stroke.md), raised for a decision. The changelog has the entry for the two routes.
