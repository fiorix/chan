# An off that a close writes beside a removal's unregister outlives the registry's row

Status: accepted by the owner on 2026-09-29 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-29 by the report of the fix round of a hung root's close and removal ([a-hung-root-takes-a-thread-per-expired-caller](a-hung-root-takes-a-thread-per-expired-caller.md); `dev/v0101-team/reports/report-Runtime-38.md` in the development tree, "Residuals", the plain off's window), which the lead ruled a named residual and not built (`dev/v0101-team/followups/followup-Lead-Runtime-47.md`, its first ask); the round's plan named it first, with the shape that would close it (`dev/v0101-team/followups/followup-Runtime-Lead-27.md`, leaning 1). Read at `e07f3862f`; not run, and no seam of the tests can hold the window.

## Owner ruling

Accepted on 2026-09-29 for a later version. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. Under that rule this item goes to v0.102.0 with the three other residuals of a removal that is told to retry, [a-launcher-delete-leaves-a-devserver-record-on](a-launcher-delete-leaves-a-devserver-record-on.md), [a-forgets-tombstone-outlasts-its-answer](a-forgets-tombstone-outlasts-its-answer.md) and [chan-workspace-forget-ignores-the-hosts-answer](chan-workspace-forget-ignores-the-hosts-answer.md): each needs an earlier call on the root that has not let go, a rare trigger, and none touches a user's files. The repair of [a-removal-unregisters-by-the-name-it-is-given](../done/a-removal-unregisters-by-the-name-it-is-given.md), accepted for v0.101.0 the same day, fixes none of the four. This one also needs two threads to interleave in a window that no seam of the tests can hold. When it was raised the lead recommended accepting it for v0.101.0, since it can register again a workspace that its user removed. It is not part of v0.101.0.

## What was seen

Lines at `e07f3862f`, in `crates/chan-library/src/` where no other path is named. A removal's unregister runs on the blocking pool and runs to its end when its caller has gone, and in the same closure it forgets the workspace's overlay rows once the registry has answered (`remove_workspace_for_root`, `host.rs:3658-3689`); the caller's root lock goes with its future (`design.md:28`). A close by root of a root no runtime holds finds the registry row in memory and then records the off in the overlay, with no await between the two (`close_workspace_for_root_locked`, `host.rs:3463-3476`; `closing_row`, `:3510-3518`). So a close that runs beside an unregister whose caller has gone, and whose read of the row comes before the unregister drops it while its write of the off comes after the unregister's forget, leaves an off row for a workspace the registry no longer holds; the two run on two threads. A devserver's next save drops that row, since a save writes rows for registered workspaces only (`crates/chan-server/src/devserver.rs:1715-1736`), and a devserver's start before that save registers every overlay row the registry lacks (`register_restore_rows`, `devserver.rs:1948-1975`), so the workspace is registered again, off. `design.md:42` names it as the one write that outlives the unregister's forget.

## Desired contract

No off that a close records beside a removal outlives the registry's row of the removed workspace.

## What to do

As the plan proposes: the close's arm for a root no runtime holds writes the off, then reads the registry again and forgets what it wrote when the row is gone, so that whichever of the registry's drop and that read comes first, one of the two forgets runs after the write. The builder found no seam that holds the window between the two statements, so the pin is the plan's to shape.

## Boundaries

`crates/chan-library/src/host.rs` (`close_workspace_for_root_locked`) and its tests, and `crates/chan-library/design.md`.

## Acceptance

1. Once a removal's unregister has returned, no overlay row names the removed workspace, whatever close by root ran beside it; pinned where a seam can hold the order.
2. `crates/chan-library/design.md` says what is left, if anything.
