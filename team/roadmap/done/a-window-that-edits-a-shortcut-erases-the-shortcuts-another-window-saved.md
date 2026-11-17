# A window that edits a shortcut erases the shortcuts another window saved

Status: shipped in [v0.131.0](../../release/release-v0.131.0.md): a shortcut assignment or reset changes the one binding it names over the server's current table, replayed through the revision check on a conflict, so the chords another window saved stay, and a workspace or standalone window refreshes its preferences each time its watch socket connects (`v0131/keysmerge` at `abfd23a39`, merged as `9e6b1bb4b`). Read by workspace-app tests over two windows' writers, red at the base, with mutations, and by check 267 in a guest's Chrome, red at the base on the lost binding and both reconnects and green at the tip. Recorded for a later release: two stale windows can save one chord for two commands, and a late refresh response can leave a window's grid stale until the next frame.

Record before the release: accepted for v0.131.0 by the owner on 2026-11-14 (`dev/v0131/decisions.md`, point 11: "as you recommend"); the implementation at `137915967` passed its committed gate and guest proof and was accepted by both reviewers; the review follow-ups at `abfd23a39` passed their committed gate and a confirm read; merged into `v0131/int` on 2026-11-15. Closed.

Record: a follow-up of v0.130.0 with no row (its release record, "Follow-ups", the standalone shortcuts; `dev/v0130/reports/termkeys-1-handback.md`): the override writer sends a window's whole table instead of merging over the server's copy, so a window behind another's write drops that window's rows. The decisions document for v0.131.0 checked it against the code and sorted it as a row of its own, as one that loses user data; the owner took that recommendation.

## What is there now

Read at `f7457becb`, by reading; not run.

- Every shortcut assign or clear in a window replaces the composite override table at `preferences.shortcuts` (`registerOverridePersist` in `web/packages/workspace-app/src/state/store.svelte.ts`, around line 641): the writer returns this window's whole table as the patch.
- The write goes through `updateWithRetry` (`web/packages/workspace-app/src/api/preferenceWrite.ts`), which reads the server's config, hands the mutation `current.preferences` and sends the result with the revision it read, replaying on a conflict. The override writer ignores the copy it is handed, so the revision check and the replay protect nothing: whatever the server held, this window's table wins.
- A window learns of another's write through `config_changed`. A window that missed one (a reconnect does not refresh preferences) holds an older table, and its next edit erases the other window's saved chords, in every slot. Since v0.130.0 standalone windows write shortcuts too, so a browser page's edit can drop a desktop window's chords.

## Desired contract

1. A shortcut edit changes the one binding it names over the server's current table; every other row the server holds, written by any window, stays.
2. A window that reconnects refreshes its preferences, so it shows and edits what the server holds.
3. A conflict is still replayed through the revision check, and the merge is what is replayed.

## Boundaries

- The override writer in `store.svelte.ts`, the preference write helper's use by it, and the reconnect path's preferences refresh in the workspace app; the standalone window's refresh the same way.
- Not here: the keymap's override model, the Settings page's layout, and other preference keys, which already merge.

## Acceptance

1. Workspace app tests: two windows' writers over one stub server, the second holding a stale table, each edits a different binding; the server ends with both. Red on today's code. A conflict replays the merge.
2. A test that a reconnect refreshes the preferences a window holds; red on today's code.
3. In a guest, two windows of one devserver, one disconnected while the other saves a chord, then an edit in the first: both chords are in the server's config afterwards.

## Implementation, 2026-11-14

An override assignment or reset sends its command id, platform slot and chord (null for a reset) to the preference writer. The writer merges that one binding over the table its revisioned read returns, rebuilding the merge after every conflict; the persisted table and the override resolver are unchanged. Each watch-socket connection schedules the existing preference refresh for its window kind, including the standalone tenant's config-only refresh.

The local regression runs two independent window module graphs over one revisioned HTTP stub. Eight cases fail on the base at the expected lost-binding or stale-preference assertions, then pass with the implementation: different commands and platform slots, reset preserving other rows, a conflict caused by the other real writer, queued assignment/reset, and preference refresh in workspace and standalone windows. Evidence is in `dev/v0131-team/evidence/Edit131/keysmerge/red.log` and `green.log` with their status files. The existing override seam's 22 tests, server reconnect's 10 tests and standalone shortcuts' 7 tests pass; workspace-app typecheck reports no errors or warnings (`seam.log`, `reconnect-neighbor.log`, `standalone-neighbor.log`, `typecheck.log` in the same directory).

Seven isolated faults each fail at the intended assertion: discarding the server table, discarding sibling platform slots, skipping a reset, retaining an empty command, reusing the first merge after a revision conflict, and omitting the reconnect refresh for either window kind. Each `mutant-*.log` has its exit status, isolated patch and original/mutated/restored SHA256 record beside it. All source bytes were restored and the regression's eight cases pass again (`restored.log`). The committed frontend gate and guest two-window reading are recorded below.

## Timer cleanup, 2026-11-15

The startup preference read exposed two timer-lifecycle failures: the warning test switched to fake timers while a real startup refresh was pending, and demo teardown cancelled that pending timer without clearing its stored handle. `stopWorkspaceRefresh` now cancels and clears the handle in store teardown and before demo teardown releases tracked timers. The warning test observes the real-clock refresh with a bounded condition wait, retaining its request-count and warning-composition assertions. Startup/reconnect refresh and standalone preference routing remain in place.

The four diagnostic runs in `dev/v0131-team/evidence/Ops131/J139/` each exit 1 at the intended assertion: the full warning file and its isolated refresh case see zero requests instead of one; normal and rejected demo settlement leave the next fixture unable to refresh; store teardown allows its pending read to fire. Source hashes match before and after, and none fails from a timeout, import or worker-start error. With the cleanup and clock repair, all five demo teardown tests and all 27 warning tests pass (`dev/v0131-team/evidence/Edit131/keysmerge/timer-lifecycle/green-teardown.log` and `green-warnings.log`, with status files). The committed gate and guest proof are recorded below.

Five isolated mutations each exit 1 at the intended assertion: omitting timer cancellation permits a late read; retaining its handle prevents rearming; omitting demo cleanup blocks the next fixture; omitting store cleanup permits a late read; and restoring the clock switch leaves the warning refresh unseen. After restoring and hashing the sources, separate runs pass all five teardown tests, 27 warning tests and eight shortcut-writer tests. Commands, exit statuses, assertion logs, isolated diffs and source hashes are under `dev/v0131-team/evidence/Edit131/keysmerge/timer-lifecycle/mutations/`, covered by its `SHA256SUMS`.

## Guest proof and review follow-ups, 2026-11-15

Job J130 ran the frozen check 267 at base `c75610a88` and tip `137915967`. The base exits 1 at all three intended assertions: `PRODUCT_SHORTCUT_MERGE_LOST_BINDING` after the reader's save leaves only its `app.open.path` binding, and `PRODUCT_RECONNECT_REFRESH_MISSING` after each workspace and standalone socket reconnects without a preference read. The tip's 267 run and its combined `10-,267` run both exit 0, with no skipped checks; the server retains both bindings and each reconnect fetches the missed peer binding before the reader's next edit. Raw assertions, request records, screenshots, provenance and status files are under `dev/v0131-team/evidence/Ops131/J130/`. The same committed tip passes `make web-check`, `make web-marketing-check` and `make e2e-check`. Both independent reviews accept that range (`dev/v0131-team/reviews/review-keysmerge-1a.md` and `review-keysmerge-1b.md`).

An assignment or stale reset that already equals the server's binding returns no patch, including when a conflict's current record contains the same assignment. The warning tests cancel the startup refresh after mounting and let any request already in flight settle before clearing request counts, so their filesystem event proves its own refresh and draft-only actions cannot inherit a startup request. Their filesystem-event wait has an explicit five-second bound. The review follow-ups still need their own committed gate and confirmatory review; the combined preference-read protections are tracked with the prefstale composition.

## Merged, 2026-11-15

The range `c75610a88..abfd23a39` was accepted by two Fable reviewers and a confirm read of the follow-ups (`dev/v0131-team/reviews/review-keysmerge-1a.md`, `-1b.md`, `-2.md`) and merged into `v0131/int`. The committed gate at `abfd23a39` (job J169: the focused suites, `make web-check` with svelte-check at 0 errors) was green before the merge. Recorded as follow-ups rather than built here: check 267's missed-frame arm should also drop filesystem frames, since one can refresh the reader and turn the base arm green by accident; out-of-order refresh responses can leave a window's grid stale until the next frame; and two stale windows can now save one chord for two commands, a candidate for a later release. The stale-read row ([a stale read reverts a preference](a-stale-workspace-read-reverts-a-preference-the-user-just-set.md)) merges after this one and carries the composition: its third contract's test, and the pending-write wait extended to standalone windows, where a reset clicked while a refresh lands is otherwise lost.
