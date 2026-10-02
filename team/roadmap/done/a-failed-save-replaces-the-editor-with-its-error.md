# A save that fails replaces the file tab's editor with its message

Status: shipped in [v0.101.0](../../release/release-v0.101.0.md).

Record before the release: accepted for v0.101.0 by the owner on 2026-09-29; raised for a decision on 2026-09-28 by the plan for the drawing's refused save (`dev/v0101-team/followups/followup-Frontend-Lead-13.md` in the development tree, section 1's table of the tab's error and section 5), which the lead's answer keeps out of that order and raises as one item (`dev/v0101-team/followups/followup-Lead-Frontend-16.md`, ruling 3). Read in code at `7957bccef` and not run.

## Owner ruling

Accepted on 2026-09-29 for v0.101.0. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. This item enters: a save that fails takes the editor and the sight of the unsaved text away, which leaves its user a reload that drops the text, and what is left of the fix is one line for each of five writers. The live sessions' two writers are built (the reading of 2026-09-29 below), so the second acceptance point is met on the integration branch and the first is what is left; what a close says when its save threw is decided in the order.

## What was seen

A file tab shows its `error` in place of its editor, its board, its tree and its table, in every mode, under a red line on its toolbar (`web/packages/workspace-app/src/components/FileEditorTab.svelte:1280-1284`, `:1320-1321`). Beside a load that failed, which has nothing to show, these set it when a save did not happen:

- a save that threw at a close (`confirmCloseTabs`, `src/state/tabs.svelte.ts:2890`), which also refuses the close;
- a save that threw at the autosave (`:5905`);
- a save that threw at a move to another window (`:6905`), which leaves the tab in this window;
- a draft's close flow or its save that threw (`:3690`, `:3797`), the draft's inspect, discard and promote calls among what can throw there;
- a live document session's or scene session's report that the server's write failed (`src/state/docSync.svelte.ts:1141`; `src/state/sceneSync.svelte.ts:831`).

In each, the text the user was typing leaves the screen and cannot be edited until a load or a later write clears the error (the plan's table, read at `eb732d774`, whose writers hold at `7957bccef` at the lines above). What the user loses is the editor and the sight of the buffer while the server does not answer, and any close; a failed write over the network is the likely cause (inferred). [a-drawing-that-does-not-parse-loses-its-editor](a-drawing-that-does-not-parse-loses-its-editor.md) covers a refused save alone: its order, in hand and not landed, gives a drawing's refusal a field of its own and leaves these writers as they are, by the lead's ruling.

On 2026-09-28 that order landed with two fields where its plan had one: `saveError`, the reason a save did not write, which the file tab shows beside the editor only while the tab is dirty, and `refusedUnwritten`, which keeps the tab off a live session until a write of its text lands (`web/packages/workspace-app/src/state/tabs.svelte.ts:260-275`; `src/components/FileEditorTab.svelte:362`, `:1288-1291`; `src/state/sceneSync.svelte.ts:120`; `src/state/docSync.svelte.ts:161`). The writers above still set `error`, at `tabs.svelte.ts:2923`, `:3757`, `:3864`, `:5991` and `:6991`, `docSync.svelte.ts:1144` and `sceneSync.svelte.ts:834` at `b39274a1a`, and a tab's `error` still takes the editor's place (`FileEditorTab.svelte:1328-1329`). A writer moved to the reason would also decide whether it sets the hold.

**Read again at `4c4ada0a1` on 2026-09-29,** on the integration branch, under `web/packages/workspace-app/src/`; read, not run. The live sessions' two writers no longer set `error`: a fix built under [the-frontend-review-remainder-has-no-owner](../v0.102.0/the-frontend-review-remainder-has-no-owner.md) moved them to `saveError`, which keeps the editor (`aeab54680`, pinned by `1d38b20a6`; `state/docSync.svelte.ts:1169`, `state/sceneSync.svelte.ts:1059`; `CHANGELOG.md:105`). Five writers in `state/tabs.svelte.ts` still set `error` when a save throws: at a close (`:2980`), in a draft's close and save flows (`:3844`, `:3951`), at the autosave (`:6130`) and at a move to another window (`:7130`); the file tab still shows `error` in place of the editor (`components/FileEditorTab.svelte:1284-1286`, `:1328-1329`).

## Desired contract

A save that fails keeps the editor with the buffer as typed and says, beside the editor, that the file was not saved and why; the tab's `error`, which replaces the editor, is set only when there is nothing to show.

## What to do

Move each writer above to the field that the drawing's refused save gives a save that did not happen, one line each, as that plan proposes (`followup-Frontend-Lead-13.md`, section 5), with the clears that field has; and decide what a close says when its save threw. Red first, mounted: a tab whose autosave's write fails keeps its editor and says that it was not saved.

## Boundaries

`web/packages/workspace-app/src/state/tabs.svelte.ts` (the save writers), `src/state/docSync.svelte.ts` and `src/state/sceneSync.svelte.ts` (their reports of a failed write), `src/components/FileEditorTab.svelte`, and their tests; after the drawing's refused save has landed, on its field.

## Acceptance

1. A save that throws at a close, at the autosave, at a move or in a draft's flow keeps the editor and says that the file was not saved, pinned for each.
2. A live session's report of a failed write keeps the editor, pinned.
3. A load that fails still shows its error in place of the editor.

## What shipped

The build is on the integration branch and not on `main`, in ranges the lead accepted, with the combined gate green on Linux at the integration's tip. This record was written on 2026-10-02 from a reading of the code at that tip; what the acceptance of its range found beyond the code is in the round's records and was not read for it.

The five writers that were left set a save error of their own and no longer the tab's load error, so the editor stays mounted with what was typed and says that the save failed and why (`classicSaveFailure` and its callers in `state/tabs.svelte.ts`, the notice in `components/FileEditorTab.svelte`, under `web/packages/workspace-app/src`); a close of such a tab asks whether to close without saving, and a draft's or a move's failure is notified once. Pinned at the store for the close, the move and the draft's save, and mounted for a rejected text autosave and a rejected drawing autosave; a failed load still replaces the editor, pinned. A live document or drawing whose push is not answered keeps its editor too, by an earlier range. `performSaveOnce` still writes the load error "file is still loading" for a tab that is loading, which is none of the five. The changelog has both entries.
