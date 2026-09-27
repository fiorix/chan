# A draft closed before its content arrives is discarded to the trash

Status: raised for a decision on 2026-09-27 by the independent review of the fix that keeps a drawing on disk from becoming a scene nobody drew ([the-frontend-review-remainder-has-no-owner](the-frontend-review-remainder-has-no-owner.md); `dev/v0101-team/reviews/review-Frontend-12.md` in the development tree, finding 3), which read the code at `20f3e3e7c` and did not trace the standalone window's discard; read again in code at `dcc5670e0`, where it holds, and not run. Recommendation: accept for v0.101.0.

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
