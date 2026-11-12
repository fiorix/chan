# A save that meets its file gone opens the external edit dialog

Status: shipped in [v0.128.0](../../release/release-v0.128.0.md).

Record before the release: raised on 2026-11-11 by the round's own checks and readings (the draft's origin is kept below); accepted for v0.128.0 by the owner the same day (survey 5). Landed on 2026-11-11.

Origin: drafted on 2026-11-11 from the reading of browser check 98 (workspace root loss) for the owner's decision; not accepted. The evidence is in `dev/v0128-team/evidence/Term128/basicflows-0/check-98-reading.md`. References are at `75134a65e`; paths under `web/packages/workspace-app/src/` unless said otherwise.

## What is there now

- The editor's save is a conditional write. A file tab that is not attached to a live document session saves through `performSaveOnce` (`state/tabs.svelte.ts` 6515), which writes the tab's text with the modification time it loaded (`api.write(path, content, expectedMtimeNs, ...)`, 6612 to 6616).
- The server answers such a write to a file that is gone, under a workspace root that still exists, with 409 `write_conflict` and a null `current_mtime_ns`: `write_streamed_text` (`crates/chan-server/src/routes/files.rs` 2426, the check at 2439 to 2442) stats the target, a missing file has no modification time, and `check_write_preconditions` (`crates/chan-server/src/self_writes.rs` 94, the comparison at 114 to 121) finds the expected time unmet. A write that arrives once the root itself is gone answers 404 and opens nothing.
- The editor turns every 409 `write_conflict` into the classic conflict prompt (`state/tabs.svelte.ts` 6650 to 6683, `showConflict` with kind `classic`), whatever the answer's `current_mtime_ns`. `components/ConflictModal.svelte` (41 to 63) titles it "External edit detected" and says "<path> changed on disk since you opened it. Saving now would clobber the external version.", with Cancel, Overwrite and Reload, Reload accented as the recommended choice.
- The watcher's removal of the file reaches the tab on its own: `scheduleMissingFileCheck` (8827) and `resolveMissingFileCheck` (8855) probe the path of a dirty tab, and a 404 marks it missing (`markTabFileMissing`, 8758, then `markFileMissing`, 6784), which shows "File moved or deleted" in the tab's toolbar (`components/FileEditorTab.svelte` 1473 to 1476) and keeps the buffer. Nothing on that path closes a conflict prompt for the tab: `dismissConflict` (6147) runs only on a successful save of the tab (6638), on Reload (6218), on Overwrite (6248), on the first-attach handover (6137) and from the prompt's own Cancel and backdrop.
- Reload on such a tab (`reloadConflictedTab`, 6214 to 6236) reloads it from disk: `loadTabContent` empties the buffer before it reads (`start.content = ""`, 3456), the read answers 404, and the tab is marked missing with an empty buffer. The edits are no longer in the tab; whether the browser's recovery store still holds a copy was not read.
- Overwrite (`overwriteConflictedTab`, 6241) adopts the answer's null modification time as the next token and saves again; the item reads whether that write recreates the file, which is not what the prompt says it does ("drops the external change").
- Observed: in check 98's mutation run M98 (the file unlinked and its save let through while the root still exists), the prompt stood over the tab, whose toolbar read "File moved or deleted", in 2 runs of 2 (`dev/v0128-team/evidence/Term128/basicflows-0/out-98-m98-quiet1/workspace-root-loss-root-loss-failure.png`). In 15 runs of the unrepaired check, every run whose save was answered while the deletion was under way got 409 and opened the prompt; every run answered after the root was gone got 404 and opened nothing.

Any save that meets a deletion of its file meets this: an autosave in flight or debounced while another program removes or moves the file (a branch switch, a `git rm`, a build step, an agent in a terminal), not only a lost workspace root.

## Desired contract

1. A save whose file is gone is not reported as an external edit. The editor says the file was deleted or moved, as the tab's missing state does, and the tab keeps every edit it held.
2. The choices offered for a file that is gone keep the edits: at least writing them back to the same path (recreating the file) and leaving the tab as it is. No choice that empties the tab is offered, and none is the default.
3. A conflict prompt never stands over a tab that has become "File moved or deleted": when the tab is marked missing while a prompt for it is open, the prompt closes or turns into the missing file's choices.
4. A save that meets an external edit of a file that still exists prompts as it does today.
5. Decided in this item: whether the client tells the case from the 409 answer's null `current_mtime_ns` (confirmed by a read) or the server answers a write to a missing target with a code of its own; the item records the choice and its reason, and either way the answer to a write whose file is gone names it as gone.

## Boundaries

- The classic save path of a file tab. A tab attached to a live document session routes removals through the session's `removed` frame (`scheduleMissingFileCheck` skips it) and is read in the item, not assumed; a draft whose lifetime ended is handled by `DraftGoneError` already and is out of scope.
- No change to how an external edit of an existing file is detected or prompted, nor to the write preconditions for an existing file.
- The recovery store, the missing-file state's own actions (Re-open, Find, Close) and the move suggestion stay as they are, except where contract 3 joins the prompt to them.

## Acceptance

1. Component tests, each red first at the base with its failing assertion read: a save answered 409 `write_conflict` with a null `current_mtime_ns` for a file that a read finds gone opens no "External edit detected" prompt and leaves the tab's buffer unchanged; a tab marked missing while a classic prompt for it is open leaves no prompt over it; the choice that writes the edits back recreates the file with the tab's text; an external edit of an existing file still opens the classic prompt.
2. A browser check that types into a document, holds its save with a devtools Fetch interception as check 98 does, removes the file, releases the save, and asserts no "External edit detected" prompt, the tab's missing state with the typed text still in the tab, and the file back with that text after the write-back choice; red at the base (the prompt opens), green on the fix, and one mutation per new guard shown red.
3. The manual's editor page (`web/packages/marketing/src/pages/manual/editor.html`), which says nothing of saves that meet a changed or missing file today, describes what the editor does when a file being edited is deleted, if the item's choices are visible to the user; the subsystem design document where the save's answer codes are described, if the server's answer changes.

## Built, 2026-11-11

A save that meets its file gone reads as the file gone. The server's answer is unchanged: a conditional write to a missing file under a live root is refused as `write_conflict` with `current_mtime: null` in its body, and the editor confirms such a refusal with a read of the path; a 404 marks the tab "File moved or deleted" with its buffer kept and no prompt (contract 1). A file that is back by the read, or a read that fails another way, opens the external-edit prompt as before (contract 4). Decided in this item (contract 5): the client tells the case apart, because the body already names the file as having no time on disk and the code is read by every client of the route.

Marking a tab missing closes an external-edit prompt standing over that tab (contract 3); a live session's first-attach choice is ended by the session itself. While a missing tab holds unsaved edits, its panel says they are still in the tab and offers Save here, Find and Close (contract 2, ruled 2026-11-11). Save here writes the buffer back with no precondition, recreating the file and any folder above it, and only while a read finds the path empty; otherwise it runs the ordinary save, which prompts. Re-open and Re-open there load another read over the buffer, so they are offered only to a tab with nothing unsaved. A user who wants the moved file opens it beside the tab (Find or Files) or saves here first. The in-place Re-open of a clean tab empties nothing it did not already. Close on a dirty missing tab asks "Close without saving?", naming the file as moved or deleted. A tab on a live document session learns of the removal from the session's `removed` frame, which marks it missing and releases the session, so the same panel applies.

Fixed as 827704853 and 8271bba3f, merged as 4be97e69a. Tests: `state/tabs.saveGone.test.ts`, `components/FileEditorTab.missingEdits.test.ts`; browser check 222 (the PUT path, the file and then its folder removed, Save here) and check 98 (the same refusal on its >2 MiB editor before the root goes), red at the base on the prompt and green ten runs alone each. The manual's editor page has a Saving section; the editor design document's save sequence has the branch.

Open: Save here cannot recreate a text file over 2 MiB, which the server's write budget refuses (413) once the file is gone; the tab keeps the edits behind its missing panel.
