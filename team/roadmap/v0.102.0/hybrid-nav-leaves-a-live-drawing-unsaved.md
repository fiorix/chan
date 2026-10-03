# A Hybrid Nav commit leaves a live drawing that a peer edited reading unsaved

Status: accepted by the owner on 2026-09-29 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-29 by the independent review of the live drawing's first range, which landed that day with [a-live-drawing-gains-appstate-keys-with-no-edit](../done/a-live-drawing-gains-appstate-keys-with-no-edit.md) (`dev/v0101-team/reviews/review-Frontend-15.md` in the development tree, its finding 4, with the lead's notes, which raise it at the landing and give no recommendation). The review inferred it from the tab store's code and its own comments and did not trace how Hybrid Nav renders its draft; read again at `e2a7e608f`, where it holds by the code, and not run. New with that build's saved mark, which a drawing that a peer edited did not have before it: then such a drawing read unsaved in every case.

## Owner ruling

Accepted on 2026-09-29 for a later version. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. Under that rule this item goes to v0.102.0: nothing is lost or written; the tab reads unsaved, and a close of it is refused with no word, until the next mirror or push-ok moves the mark. When it was raised the lead recommended a later version for the same reason. It is not part of v0.101.0.

## What was seen

Lines at `e2a7e608f`, under `web/packages/workspace-app/src/`. While Hybrid Nav is up the app renders the draft's tabs, and a holder that resolves a tab through `liveFileTabById` writes to the live tree, which the commit replaces with the draft (the store's comments, `state/tabs.svelte.ts:4303-4307`, `:5646-5650`). A live drawing's canvas writes its mirror into the tab its host renders (`components/FileEditorTab.svelte:1470`; `setTabContent`, `state/tabs.svelte.ts:5488-5495`), which during the mode is the draft's. Its session resolves its tab through the live tree (the `tab` getter, `state/sceneSync.svelte.ts:298-300`), so when the canvas reports a mirror of a peer's edit, the session sets the live tab's `saved` to the live tab's `content` (`bufferMirrored`, `:510-520`; `confirmSaved`, `:962-970`), which is still the text from before the mode.

At the commit, `carryLiveAuthorityState` copies `saved` from the live tab to the draft's tab when the live buffer has not moved since the mode was entered (`state/tabs.svelte.ts:4395-4436`, the test at `:4417`, the fields at `:4352-4357`). So the committed tab holds the peer's element in `content` and the older text in `saved`, and reads unsaved (`isDirty`, `:5574-5578`). When the mode settles the sessions apply their status again and not the saved mark (`resyncMirror`, `state/sceneSync.svelte.ts:580-582`, run at `:1124-1126`). A close then saves the tab; the session's save answers that it saved with nothing to write, which leaves `saved` as it is (`performSaveOnce`, `state/tabs.svelte.ts:5885-5893`), and the close refuses a tab still dirty with no reason, saying nothing (`confirmCloseTabs`, `:2934-2939`). The mark moves at the next mirror of the canvas or the next push-ok of this window's own push (`state/sceneSync.svelte.ts:774-781`).

The review's steps, not run: in window A enter Hybrid Nav; in window B draw on the same drawing; in A commit; read A's unsaved mark and close A's tab.

## Desired contract

A live drawing whose buffer holds nothing of this window's that the authority has not acknowledged reads saved after a Hybrid Nav commit, as it does outside the mode, and a change of this window's still reads unsaved.

## What to do

As suggestions: let the saved mark follow the tab the canvas mirrors into, or have the commit carry the mark of a live drawing whose session confirmed its mirror during the mode, or apply the mark again when the mode settles as the status is. Red first: a test that enters the mode, mirrors a peer's element through the canvas into the draft's tab with the session attached, commits, and asserts the tab clean; today it is dirty.

## Boundaries

`web/packages/workspace-app/src/state/sceneSync.svelte.ts` (`bufferMirrored`, `confirmSaved`, `resyncMirror`) or `src/state/tabs.svelte.ts` (`carryLiveAuthorityState`), with their tests. What the commit carries for other fields is unchanged.

## Acceptance

1. After a Hybrid Nav commit over a peer's edit mirrored during the mode, the live drawing reads saved and its close closes it; pinned red first.
2. A stroke of this window's not yet acknowledged still reads unsaved after the commit; pinned.
