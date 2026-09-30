# A draft closed before its content arrives is discarded to the trash

Status: accepted for v0.101.0 by the owner on 2026-09-27; raised for a decision on 2026-09-27 by the independent review of the fix that keeps a drawing on disk from becoming a scene nobody drew ([the-frontend-review-remainder-has-no-owner](the-frontend-review-remainder-has-no-owner.md); `dev/v0101-team/reviews/review-Frontend-12.md` in the development tree, finding 3), which read the code at `20f3e3e7c` and did not trace the standalone window's discard; read again in code at `dcc5670e0`, where it holds, and not run.

## Owner ruling

Accepted on 2026-09-27 for v0.101.0, as the lead recommended. The owner accepted in one answer every recommendation the lead had put to them that day; for this item it was to accept it for this version, with no shape of the fix named.

On 2026-09-29 the owner confirmed as built the ruling of the lead's that had been put to the owner with no answer: a draft closed during its load, by a close that is not forced, is kept with no notice, and the reopen loads it again. The owner accepted in one answer every recommendation the lead had put to them that day.

## What was seen

A draft's single close hands the tab to the draft close with no check of its load (`closeTabOnce`, `web/packages/workspace-app/src/state/tabs.svelte.ts:3529-3530`). The draft close reads the buffer as empty when it holds nothing but whitespace (`handleDraftTabClose`, `:3638`), and an empty draft with no attachments is discarded with no dialog and the notice "Draft discarded" (`:3646-3650`).

A load empties the buffer as it starts (`loadTabContent`, `:2954`, with `loading` set at `:2960`), so a draft closed before its first chunk arrives reads as empty. A read that fails keeps what had arrived as the buffer and ends the load (`:3023-3025`, `:3033`), so a draft whose read failed before its first chunk reads as empty too; one whose read failed later holds partial bytes, reads as not empty and goes on to the close's dialog. Either way the draft on disk is not what the buffer shows.

In a workspace window the discard moves the draft to the trash (`discard_draft`, `crates/chan-workspace/src/workspace.rs:2302-2308`, reached through `api_discard_draft`, `crates/chan-server/src/routes/drafts.rs:293-306`), where it lists and can be restored until the trash expires it. The standalone window's discard (`api_standalone_discard_draft`, mounted at `crates/chan-server/src/lib.rs:1241-1243`) was not traced. Cmd+Shift+T after such a close mints a fresh draft, which receives nothing of a load that had not finished (`recoverClosedDraft`, `tabs.svelte.ts:1394`).

A file that is not a draft is protected from exactly this: the close's empty-file discard leaves out a tab that is loading, whose read failed, or whose file is missing (`shouldDiscardEmptyFileOnClose`, `:3686-3694`, the exclusions at `:3689-3691`).

## Desired contract

A draft whose load has not finished, or whose read failed, is never discarded as empty on its close: the draft on disk stays in the drafts, as a file that is not a draft stays on disk.

## What to do

Give the draft close the empty-file discard's exclusions: a draft tab that is loading or whose read failed closes without being inspected, saved or discarded, as one whose file is missing already does (`:3636`). The reopen assumes that a closed draft's file is gone and mints a fresh one (`reopenClosedTab`, `:1352-1360`), so decide what Cmd+Shift+T does after a close that kept the draft; opening the kept draft is the natural answer. Read the standalone window's draft close and discard, and give it the same rule if it discards. Red first: a state-level test that a draft closed before its first chunk sends no discard, which fails at the code as it is.

## Boundaries

`web/packages/workspace-app/src/state/tabs.svelte.ts` (`closeTabOnce`'s draft branch, `handleDraftTabClose`, and `reopenClosedTab` with `recoverClosedDraft`), with their tests. The server's draft routes are unchanged unless the standalone window's reading shows a server-side part.

## Acceptance

1. A draft closed before its first chunk arrives, and one whose read failed before any chunk, sends no discard and stays in the drafts; pinned red first by state-level tests.
2. Cmd+Shift+T after such a close opens a tab with the draft's content.
3. The standalone window's draft close is read, and its rule is stated in the item and pinned.
4. A reading on a display: on a slow link, a draft opened from the tree and closed with Cmd+W before its content shows is not in the trash.

## What shipped

Landed on 2026-09-28; lines at `a6834b1ee`, under `web/packages/workspace-app/src/` where no other path is named. The builder's report is `dev/v0101-team/reports/report-Clients-33.md` in the development tree, to the order `dev/v0101-team/tasks/task-Lead-Clients-28.md`, its plan (`dev/v0101-team/followups/followup-Clients-Lead-13.md`) and the rulings on it (`dev/v0101-team/followups/followup-Lead-Clients-22.md`); the lead read the production diff whole and verified it at the blob, with no independent review (`dev/v0101-team/journals/journal-Lead.md`, the entries of 2026-09-28 18:15Z and 18:53Z). The workspace app's design document says nothing of a draft's close and is not changed.

- **A single close that is not forced keeps a draft's file while its buffer is not the file.** `closeTabOnce` flushes a pending edit and then asks once, for a draft, whether the close keeps its file (`state/tabs.svelte.ts:3619-3622`): it does while the draft's load runs, or while its last read has failed and nothing was typed over what had arrived (`closeKeepsDraftFile`, `:3723-3732`). A kept draft is not inspected, saved or discarded, no notice is shown, and the close ends its read with the tab (`endTabLoad`, `:3004-3009`, called at `:3662`). So a draft closed before its first chunk, or after a read that failed before any chunk, sends no discard and stays in the drafts, and one whose read failed after some bytes closes with no dialog about bytes its tab never showed. A draft whose buffer is the file, or that holds typing, closes as it did: `handleDraftTabClose` saves a dirty buffer, discards an empty or pristine one with "Draft discarded" and asks about the rest (`:3734-3786`).
- **The load, and not the tab, says that a read failed.** The tab's `error` cannot say it: the draft close writes it when it fails (`:3783`), and so do failed saves, ten writers in all by the plan's count (`followup-Clients-Lead-13.md`, leaning 2). The load keeps the ids of the tabs whose last read failed for a reason other than a missing file (`tabLoadFailures`, `:2986-2989`): it adds one in that branch of a failed read (`:3112-3117`) and drops it when a load starts (`:3020`) and when the tab leaves the layout (`:3007`). A loading tab is never dirty (`isDirty`, `:5573-5578`), and every editor a draft opens in is read-only while it loads (`readOnly`, `components/FileEditorTab.svelte:353-355`; the builder's reading of each editor, `dev/v0101-team/evidence/Clients/cl18-editable-during-load.md`), so the first term needs no guard. A tab whose read failed takes typing only once a sibling's save has replaced its buffer, and the typing makes it dirty, so the ordinary close saves it (the predicate's doc, `:3727-3729`; the plan, leaning 1).
- **The closed entry says what the close did with the file, and the reopen follows it.** The entry records `keptDraft` (`ClosedTab`, `:707-714`), which `closeTabOnce` sets (`:3654`) and every other record leaves false (`rememberClosedTab`, `:1366-1376`; the bulk close, `dropTabsById`, `:3551-3555`). The reopen mints a new draft only for a draft that was not kept (`reopenClosedTab`, `:1384-1393`); a kept draft goes back by its path and starts a load of its own, since its buffer holds at most what had arrived (`:1394-1408`). `recoverClosedDraft` is not changed (`:1412-1446`).
- **A standalone window keeps such a draft as a workspace window does.** Its close is the same function, and its discard would move the draft into the library draft store's trash (`api_standalone_discard_draft`, `crates/chan-server/src/routes/standalone_drafts.rs:229-271`; `DraftStore::discard`, `crates/chan-workspace/src/draft_store.rs:194-201`), as a workspace window's moves it into the workspace's (`api_discard_draft`, `crates/chan-server/src/routes/drafts.rs:293`; `Workspace::discard_draft`, `crates/chan-workspace/src/workspace.rs:2361-2367`). No server code changed.
- **The words:** the changelog (`CHANGELOG.md:53` at the landing's tip).

Pinned in `state/tabs.draftClose.test.ts` and `state/miniDraftLifecycle.test.ts`, each red first at its own assertion in the report: a close before the first chunk, which sends no discard and no inspect and ends the read (`tabs.draftClose.test.ts:166`); a close after a read that failed before any chunk (`:183`); one after a read that failed after some bytes, with no dialog (`:194`); the reopen after the first, which loads the draft by its path and mints and writes nothing (`:216`), and after the second, which loads it again (`:239`); and a close before the first chunk in a standalone window (`miniDraftLifecycle.test.ts:127`). Three controls, green before and after: typing in a draft whose earlier close failed is saved by the next close (`tabs.draftClose.test.ts:261`), so is typing over a buffer that a sibling's save replaced after a failed read (`:281`), and a draft whose reload succeeded after a failed read closes as its file (`:307`). In the report nine mutations, one for each term of the predicate, each line of the set and each change of the reopen, red exactly their expected pins; the eight cases of the new file and the standalone case passed 200 runs each as they are and 200 on one CPU; and the own gate ran `make web-check` green at the range's tip, 5,700 tests.

**Rulings of the lead's, the owner's to overrule where no confirmation is written** (`followup-Lead-Clients-22.md`):

- **A kept close shows no notice** (Q2), as a file that is not a draft closes in the same state with none (the plan, leaning 1). Confirmed by the owner on 2026-09-29.
- **A test whose state the fix made unreachable is removed** (Q3): "a refused single close leaves the load running" (`state/fileTabMoveDuringLoad.test.ts:325` at `f3006ec87`) reached its refusal through the inspect of a draft that loads, which the close no longer calls, so a single close of a tab whose load runs can no longer be refused; the bulk close's refusal still pins that a refused close cancels nothing.

**The acceptance at the tip.** The first point is met (`tabs.draftClose.test.ts:166`, `:183`; `miniDraftLifecycle.test.ts:127`). The second is met in state: the reopen opens the draft's own path with a load of its own and ends holding the file's content (`tabs.draftClose.test.ts:216`, `:239`); the chord and the tab it shows are a display's. The third is met: the standalone window's close is the same function, its rule is stated above, and the standalone pin holds it. The fourth is a reading on a display, and is owed.

**Owed at the first release candidate, rc0, on a display:** the fourth point, and the second's chord and tab, by the five steps of the report's "What only a browser can show", on a devserver behind a slow link: a close while the draft loads, the reopen after it, a close after a read that failed and the reopen after that, and the first close again in a standalone Files window.

**The costs, as the report's residuals give them, each read at the tip:**

- **A kept close says nothing,** and the draft stays in the drafts listing: the kept path of `closeTabOnce` shows no notice (`:3620-3622`).
- **A draft whose read failed and whose file then vanished reopens into the missing-file state:** the reopen's load finds the file missing and marks the tab so (`loadTabContent`, `:3110-3111`), where the reopen before the fix minted a draft seeded with the bytes that had arrived.
- **A stroke drawn on a canvas in the 200 ms before a load starts is lost with or without the fix.** The canvas serializes a change 200 ms after it (`scheduleSerialize`, `editor/ExcalidrawCanvas.svelte:337-340`), so such a stroke can land in the buffer while the load runs, when the tab is never dirty (`isDirty`, `state/tabs.svelte.ts:5576`); the load's end replaces the buffer (`:3086`), and a kept close drops it with the tab. Read, not run; the canvas is the drawing lane's. **Corrected on 2026-09-29:** such a stroke does not reach the buffer while the load runs, since the canvas publishes nothing while its tab loads, a guard that was there at `a6834b1ee` too (`editor/ExcalidrawCanvas.svelte:417-419` there, `:485-487` at `e2a7e608f`); the seed at the load's end replaces the board's elements with the loaded buffer (`:570-579` and `:441-445` at `e2a7e608f`), and that is where the stroke is lost. The loss holds, and is raised for a decision as [a-stroke-in-the-debounce-is-lost-to-a-load](a-stroke-in-the-debounce-is-lost-to-a-load.md).
- **A draft whose read failed and whose buffer a sibling's save made the file closes kept, where its dialog could have run.** It errs toward keeping, and nothing is lost.

**What is left:** nothing of this item's contract. A draft that a forced close takes out of its pane, by a move to another window, a script or a deletion, never takes the draft flow, and what its reopen does is raised for a decision as [a-force-closed-draft-reopens-as-a-new-draft](../v0.102.0/a-force-closed-draft-reopens-as-a-new-draft.md).
