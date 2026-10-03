# A devserver forget's tombstone outlasts the answer the forget gives

Status: accepted by the owner on 2026-09-29 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-29 from the residuals of two ranges on a hung root's close and removal (`dev/v0101-team/reports/report-Runtime-34.md` and `dev/v0101-team/reports/report-Runtime-35.md` in the development tree, "Residuals", the forget's other errors and the stale completion), which the lead ruled raised and not built (`dev/v0101-team/followups/followup-Lead-Runtime-39.md`, ruling 3; `dev/v0101-team/followups/followup-Lead-Runtime-40.md`, leaning 4), and from the independent review of the second range (`dev/v0101-team/reviews/review-Runtime-20.md`, finding 4), which its fix round left at the lead's discretion (`dev/v0101-team/reports/report-Runtime-38.md`). Read at `e07f3862f`; not run.

## Owner ruling

Accepted on 2026-09-29 for a later version. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. Under that rule this item goes to v0.102.0 with the three other residuals of a removal that is told to retry, [a-late-off-row-outlives-a-removal](a-late-off-row-outlives-a-removal.md), [a-launcher-delete-leaves-a-devserver-record-on](a-launcher-delete-leaves-a-devserver-record-on.md) and [chan-workspace-forget-ignores-the-hosts-answer](chan-workspace-forget-ignores-the-hosts-answer.md): each needs an earlier call on the root that has not let go, a rare trigger, and none touches a user's files. The repair of [a-removal-unregisters-by-the-name-it-is-given](../done/a-removal-unregisters-by-the-name-it-is-given.md), accepted for v0.101.0 the same day, fixes none of the four. This one needs a forget of a starting record that the host refuses. When it was raised the lead recommended accepting it for v0.101.0, since a stale attempt can unregister the workspace after the forget has answered that its user must retry (`complete_success`, `crates/chan-server/src/devserver.rs:544-553`; `execute_mount_attempt`, `:1231-1236`). It is not part of v0.101.0.

## What was seen

Lines at `e07f3862f`, in `crates/chan-server/src/devserver.rs`.

- **A forget that the host refuses another way.** A forget of a starting record tombstones it and saves before it asks the host (`forget_workspace`, `:1522-1536`), and a tombstone writes no overlay row (`persisted`, `:587-590`). When the host answers any error but still releasing, the forget returns it (`:1549`) and the handler answers 500 with the error's sentence (`handle_forget`, `:3195`), with the record still a tombstone; the attempt behind it drops the tombstone at its next reconcile (`execute_mount_attempt`, `:1184-1191`; `:1290-1299`). The workspace stays registered with its overlay row gone, so a start leaves it off.
- **A stale attempt's own removal.** An attempt whose open finished after a forget tombstoned its record completes on the tombstone and runs a forced removal of its own, discarding what the host answers (`complete_success`, `:544-553`; `:1204-1210`, `:1231-1236`). Behind a forget that the host answered still releasing, that removal waits for the root's lock; if the call the forget met lets go first, it unregisters the workspace after its user was told to retry (the review's reading, each step read and the order inferred).

## Desired contract

After a devserver forget has answered, its record and the host hold what the answer said: a refusal leaves the workspace registered and its record as the host left it, and no removal runs on after it.

## What to do

As suggestions: every error of the host puts the tombstone back as the still-releasing arm does (`stand_down_refused_forget`, `:1604-1629`), and a stale attempt removes only while the record is still its forget's tombstone.

## Boundaries

`crates/chan-server/src/devserver.rs` (`forget_workspace`, `stand_down_refused_forget`, the attempt's completion) and its tests.

## Acceptance

1. A forget of a starting record whose host removal fails with an error other than still releasing leaves a record that a save writes and a start restores as the host holds it; pinned red first.
2. An attempt that completed on a tombstone behind a forget answered still releasing unregisters nothing; pinned red first.
