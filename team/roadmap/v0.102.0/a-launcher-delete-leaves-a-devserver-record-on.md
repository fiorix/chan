# A launcher delete on a devserver that the host answers still releasing leaves the devserver's record desired on

Status: accepted by the owner on 2026-09-29 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-29 by the independent review of a removal that is still releasing (`dev/v0101-team/reviews/review-Runtime-20.md` in the development tree, finding 1, older than that range, with the lead's notes), whose fix round built the devserver's forget and raised the launcher's delete, as the lead ruled (`dev/v0101-team/reports/report-Runtime-38.md`, "The second review's six findings", its first; `dev/v0101-team/followups/followup-Lead-Runtime-47.md`, "Ruled"). Read at `e07f3862f`; not run.

## Owner ruling

Accepted on 2026-09-29 for a later version. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. Under that rule this item goes to v0.102.0 with the three other residuals of a removal that is told to retry, [a-late-off-row-outlives-a-removal](a-late-off-row-outlives-a-removal.md), [a-forgets-tombstone-outlasts-its-answer](a-forgets-tombstone-outlasts-its-answer.md) and [chan-workspace-forget-ignores-the-hosts-answer](chan-workspace-forget-ignores-the-hosts-answer.md): each needs an earlier call on the root that has not let go, a rare trigger, and none touches a user's files. The repair of [a-removal-unregisters-by-the-name-it-is-given](../done/a-removal-unregisters-by-the-name-it-is-given.md), accepted for v0.101.0 the same day, fixes none of the four. This one's fix is a hook between the launcher's routes and the devserver's records, or a floor on the overlay's generation, each a change of a contract. When it was raised the lead recommended accepting it for v0.101.0, since a workspace whose user asked for its removal can be mounted again. It is not part of v0.101.0.

## What was seen

Lines at `e07f3862f`, in `crates/chan-server/src/` where no other path is named. A devserver serves the launcher's routes (`devserver.rs:2795-2811`), whose delete calls the host's removal and touches no devserver record (`handle_remove_workspace`, `routes/library.rs:2026-2053`); only the devserver's own forget turns its record off when the host answers that the workspace is still releasing (`forget_workspace`, `devserver.rs:1537-1547`; `stand_down_refused_forget`, `:1604-1629`).

- **At the unregister's own conflict,** a handle of the root this process still holds, the removal has forgotten the overlay rows before its unregister and forgets nothing after (`crates/chan-library/src/host.rs:3649-3652`, `:3703-3714`), so nothing in the overlay outranks a record left desired on. The devserver's next save writes the row of a failed or a starting record on (`devserver.rs:1715-1736`; `persisted`, `:587-596`), and a start prepares its mount (`prepare_restore_rows`, `:2043-2058`). A starting record's attempt mounts the workspace once the holder lets go, by the fix round's reading.
- **At the registry-write permit,** the refused removal's close writes a fresh off row at generation 1 behind the earlier removal's forget (`crates/chan-library/src/workspace_persist.rs:208-220`), which no record takes, since a record takes only a row newer than its own generation (`devserver.rs:565-568`), so the next save writes the record's row on over it (`workspace_persist.rs:151-153`) and a start before the held unregister returns mounts the workspace; once it returns, the registry drops the row and the save drops the record (`devserver.rs:1715-1719`).

The delete answers 503 with `Retry-After: 1` and `workspace is still releasing; retry` in both (`routes/library.rs:2049-2050`).

## Desired contract

A launcher delete on a devserver that the host answers still releasing leaves no devserver record desired on, as the devserver's own forget does.

## What to do

The fix round's two shapes, each more than one call: a hook through which the launcher's delete and off on a devserver tell the devserver's records, so that they reach the forget's turn-off, or a generation floor that the overlay keeps for a path it forgot.

## Boundaries

`crates/chan-server/src/routes/library.rs` (`handle_remove_workspace`) and the devserver's records and save in `crates/chan-server/src/devserver.rs`, or `crates/chan-library/src/workspace_persist.rs` for a floor, with their tests.

## Acceptance

1. A launcher delete on a devserver, refused at the unregister's own conflict, of a failed and of a starting record, then a save and a restore, mounts nothing; pinned red first.
2. The same refused at the registry-write permit, with a restore before the held unregister returns; pinned.

## What shipped

Built on 2026-10-03 on the v0.102.0 integration branch and not on `main`, in a range the lead accepted on its report, a reading of its diff and its own gate. This record was written that day from that reading.

The hook, as the lead ruled: the launcher's delete on a devserver is the devserver's forget. A surface supplies its own removal (`WorkspaceRemoval`, `crates/chan-server/src/routes/library.rs`), which `handle_remove_workspace` runs in place of the host's and answers the same way, so the 503 with `Retry-After: 1` is unchanged at both refusal points and a delete the host fails turns the record off as a forget's does. The overlay's format is unchanged. Pinned for a failed and for a starting record, at the unregister's own conflict and beside an abandoned unregister, red first. Left: the launcher's off still touches no devserver record; the same hook would serve it.
