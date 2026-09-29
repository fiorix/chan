# A draft reopened after a forced close comes back as a new draft, seeded with what its tab held

Status: accepted by the owner on 2026-09-29 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-28 by the report of the order that keeps a draft closed during its load (`dev/v0101-team/reports/report-Clients-33.md` in the development tree, "Found beside the order"), whose plan found both cases (`dev/v0101-team/followups/followup-Clients-Lead-13.md`, leaning 3); the lead ruled them raised and not built (`dev/v0101-team/followups/followup-Lead-Clients-22.md`, the eighth point it approves). Read at `a6834b1ee`; not run. The two closes of a pane's tabs in bulk take the same record, which the records do not name and which was read here. It is a row of its own and not what is left of [a-draft-closed-during-its-load-is-trashed](../v0.101.0/a-draft-closed-during-its-load-is-trashed.md): that item's contract is a close that discards a draft whose buffer is not the file, a forced close or a bulk close never takes the draft flow, and the second case below holds for a draft whatever its load did.

## Owner ruling

Accepted on 2026-09-29 for a later version. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. Under that rule this item goes to v0.102.0: the fault is a wrong state that loses nothing, since a forced close leaves the draft's file. When it was raised the lead recommended accepting it for v0.101.0: each forced route says whether the draft's file survived, and the reopen follows it. It is not part of v0.101.0.

## What was seen

Under `web/packages/workspace-app/src/`: a forced close skips the draft flow and records the closed draft as not kept (`closeTabOnce`, `state/tabs.svelte.ts:3620-3622`, the record at `:3654`), so the reopen mints a new draft for it (`reopenClosedTab`, `:1390-1393`) and writes the closed buffer into that draft when the buffer is more than the seed and the tab was not loading (`recoverClosedDraft`, `:1419-1446`, the condition at `:1430`). Three routes close a draft with force:

- **the move to another window,** which saves a dirty buffer first and leaves the draft's file to the window it moved to (`closeFileTabAfterMove`, `state/tabs.svelte.ts:7005-7026`);
- **a scripted close** of a tab, a pane or every pane (`applyPaneExec`, `state/store.svelte.ts:1440`, the closes at `:1531`, `:1541`, `:1554`);
- **the close of the tabs under a deleted path** (`state/store.svelte.ts:5640-5654`), whose file is gone.

A scripted pane close closes its tabs in bulk (`closePane`, `state/tabs.svelte.ts:3965-3985`), and so do a user's two commands that close a pane's tabs or the pane, forced or not (`app.pane.closeTabs` and `app.pane.kill`, `App.svelte:1379-1384`; `closeTabsInPane`, `state/tabs.svelte.ts:3945-3956`). A bulk close takes no draft flow either: one that is not forced saves a dirty file tab first and one that is forced does not (`confirmCloseTabs`, `:2907-2934`, the forced return at `:2911`, called at `:3952` and `:3971`), and each records its tabs as not kept (`dropTabsById`, `:3551-3555`), so a reopen of a draft it closed does the same. Read here at the tip; the records name the three forced routes alone.

**Corrected on 2026-09-28, read again at `d440ab656`, where no file of `web/` differs from the tip above but the file classifier and one sentence of the design document:** a bulk close that is not forced refuses a pane that holds a draft, with the notice "Close Drafts individually to save or discard them" (`confirmCloseTabs`, `state/tabs.svelte.ts:2911-2915`), and a user's two commands are not forced (`closeTabsInActivePane` and `killActivePane`, `App.svelte:1123-1134`, called at `:1380` and `:1383`; the one forced call, `:1161`, closes a pane that holds no tab, `:1135-1161`). So no bulk close of a user's closes a draft, and the bulk close that does is the scripted close of a pane or of every pane, which forces it (`applyPaneExec`, `state/store.svelte.ts:1534-1558`) after a check that stops it only for an unsaved file or a live terminal (`collectBlocks`, `:1564-1574`; `paneCloseBlock`, `:1367-1371`). One more thing follows from that route, which the drafter of that landing found beside it: it takes no draft flow, so a draft that is empty or holds only its seed, which a single close discards (`handleDraftTabClose`, `state/tabs.svelte.ts:3756-3759`), is left in the drafts when a script closes its pane. Where this item says "a bulk close" below, it is that scripted close.

Two things follow:

1. **A draft whose read failed after some bytes comes back as a new draft holding those bytes,** by any of these routes. A failed read keeps what had arrived as the buffer and ends the load (`loadTabContent`, `state/tabs.svelte.ts:3108-3117`, `:3119-3127`), so the closed copy is not loading, and the reopen writes the partial bytes into the new draft (`:1430-1432`).
2. **A draft whose file the forced close left in place comes back as a second draft beside it,** seeded with the buffer: the move, a scripted close and a bulk close leave the file, and the reopen mints all the same. Only the deleted path's file is really gone, so a fix has each route say whether the file survived (the report).

## Desired contract

A draft's reopen after a close that took no draft flow follows what the close did with its file: a new draft is minted only for a file that is gone, and seeded only from a buffer that was the file.

## What to do

A suggestion from the plan, widened here to the bulk closes: each route that takes no draft flow records on the closed entry whether the draft's file survived, the move, a scripted close and a bulk close that it did and the deleted path that it did not, and the reopen reads that fact as it reads a kept draft's, while the seed leaves out a buffer whose last read failed as it leaves out one whose load had not finished. Whether a reopen after a move opens the moved draft here too, where it would then be open in two windows, or opens nothing, is for the plan. Red first: a draft moved to another window and reopened here mints no draft, and a draft whose read failed after some bytes, closed by a script and reopened, writes nothing into a new draft.

## Boundaries

`web/packages/workspace-app/src/state/tabs.svelte.ts` (the record of a forced close, `dropTabsById`, `reopenClosedTab`, `recoverClosedDraft`, `closeFileTabAfterMove`), the forced closes of `state/store.svelte.ts` and the bulk closes of a pane, with their tests. A single close that is not forced is [a-draft-closed-during-its-load-is-trashed](../v0.101.0/a-draft-closed-during-its-load-is-trashed.md)'s.

## Acceptance

1. A draft whose file a forced or a bulk close left in place is not reopened as a second draft, pinned red first through the move, a scripted close and a bulk close.
2. A draft whose read failed after some bytes, closed with force and reopened, seeds no new draft with those bytes, pinned red first.
3. What a reopen does after each such route is stated in this item and pinned.
