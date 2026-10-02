# A forced pane close on a live board can push a waiting stroke that a forced tab close drops

Status: accepted by the owner on 2026-09-29 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-29 from the report of the fix round of the two closes that keep a drawing's last stroke ([two-closes-still-drop-a-drawings-last-stroke](../done/two-closes-still-drop-a-drawings-last-stroke.md); `dev/v0101-team/reports/report-Frontend-33.md` in the development tree, "Residuals", its first, and "What ruling 5 asked: shown first"), which no ruling took up. Read at `e07f3862f`; shown in a test fixture whose board stays mounted, and in the app it rests on the order in which Svelte tears the board down, which is inferred.

## Owner ruling

Accepted on 2026-09-29 for a later version. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. Under that rule this item goes to v0.102.0: nothing of the user's is lost: a forced pane close can hand the last stroke to the authority where a forced tab close does not. When it was raised the lead recommended a later version for the same reason. It is not part of v0.101.0.

## What was seen

Lines at `e07f3862f`, under `web/packages/workspace-app/src/`. The control client's three forced closes commit nothing before they close (`state/store.svelte.ts:1529`, `:1542`, `:1551`). A forced `cs pane close-tab` closes through the tab's close, which releases the tab's scene session at once (`closeTabOnce`, `state/tabs.svelte.ts:3694-3698`), so the canvas's flush at its teardown (`editor/ExcalidrawCanvas.svelte:593-594`) has no session to push to. A forced `cs pane close` and `cs pane close-all` close through the pane's close, which drops the tabs and releases no session itself (`closePane`, `state/tabs.svelte.ts:4004-4012`), so the session lingers for 250 ms (`SCENE_RELEASE_LINGER_MS`, `state/sceneSync.svelte.ts:65`, the timer at `:595`), and the teardown's flush can hand the waiting stroke to it. The fix round's first form of its pins saw the stroke pushed after the wait, and its pins now read the pushes when the arm answers (`components/FileEditorTab.canvasEdits.test.ts:1029`, `:1043`). `editor/design.md:88` says so.

## Desired contract

The control client's forced closes treat a live board's waiting stroke the same way, each dropping it or each saving it.

## What to do

As suggestions: release the pane's tabs' sessions at once in a forced pane close, as the tab's close does, or commit and push in all three; which of the two is the owner's to choose, since `--force` is the control client's word for closing without the unsaved-changes check.

## Boundaries

`web/packages/workspace-app/src/state/tabs.svelte.ts` (`closePane`) or `src/state/store.svelte.ts` (the forced arms), with their tests.

## Acceptance

1. On a live board, the three forced closes do the same with a waiting stroke, read after the session's linger has run out; pinned red first where they differ.
