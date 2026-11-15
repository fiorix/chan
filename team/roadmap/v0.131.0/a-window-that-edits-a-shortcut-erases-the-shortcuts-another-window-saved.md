# A window that edits a shortcut erases the shortcuts another window saved

Status: accepted for v0.131.0 by the owner on 2026-11-14 (`dev/v0131/decisions.md`, point 11: "as you recommend"); implementation in progress, with the committed gate, guest proof and review pending.

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

Seven isolated faults each fail at the intended assertion: discarding the server table, discarding sibling platform slots, skipping a reset, retaining an empty command, reusing the first merge after a revision conflict, and omitting the reconnect refresh for either window kind. Each `mutant-*.log` has its exit status, isolated patch and original/mutated/restored SHA256 record beside it. All source bytes were restored and the regression's eight cases pass again (`restored.log`). The committed frontend gate, the guest two-window reading and review remain pending; this is not a closing verdict.

## Timer cleanup, 2026-11-15

The startup preference read exposed two timer-lifecycle failures: the warning test switched to fake timers while a real startup refresh was pending, and demo teardown cancelled that pending timer without clearing its stored handle. `stopWorkspaceRefresh` now cancels and clears the handle in store teardown and before demo teardown releases tracked timers. The warning test observes the real-clock refresh with a bounded condition wait, retaining its request-count and warning-composition assertions. Startup/reconnect refresh and standalone preference routing remain in place.

The four diagnostic runs in `dev/v0131-team/evidence/Ops131/J139/` each exit 1 at the intended assertion: the full warning file and its isolated refresh case see zero requests instead of one; normal and rejected demo settlement leave the next fixture unable to refresh; store teardown allows its pending read to fire. Source hashes match before and after, and none fails from a timeout, import or worker-start error. With the cleanup and clock repair, all five demo teardown tests and all 27 warning tests pass (`dev/v0131-team/evidence/Edit131/keysmerge/timer-lifecycle/green-teardown.log` and `green-warnings.log`, with status files). The committed gate and guest proof still determine the row's closing verdict.

Five isolated mutations each exit 1 at the intended assertion: omitting timer cancellation permits a late read; retaining its handle prevents rearming; omitting demo cleanup blocks the next fixture; omitting store cleanup permits a late read; and restoring the clock switch leaves the warning refresh unseen. After restoring and hashing the sources, separate runs pass all five teardown tests, 27 warning tests and eight shortcut-writer tests. Commands, exit statuses, assertion logs, isolated diffs and source hashes are under `dev/v0131-team/evidence/Edit131/keysmerge/timer-lifecycle/mutations/`, covered by its `SHA256SUMS`.
