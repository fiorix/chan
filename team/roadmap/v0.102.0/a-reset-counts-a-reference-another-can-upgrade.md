# The reset and the import count their own reference down to one and take its drop for the lock's release

Status: accepted by the owner on 2026-09-29 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-28 by the lead, from the report of the repair of a test that waited on a reference and not on the lock ([a-test-waits-on-a-reference-and-not-on-the-lock](../v0.101.0/a-test-waits-on-a-reference-and-not-on-the-lock.md); `dev/v0101-team/reports/report-Runtime-37.md` in the development tree, "Step 3: the product's callers", its third bullet), whose builder read it at `f3006ec87` and marked it inferred and not reproduced. Read again at `d440ab656`; not run.

## Owner ruling

Accepted on 2026-09-29 for a later version. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. Under that rule this item goes to v0.102.0: the fault was inferred from the code and never reproduced, and it needs an upgrade on another thread inside a reset or an import, a rare trigger. A run that shows it comes first, as the lead recommended when the item was raised, as a small order for v0.101.0. It is not part of v0.101.0.

## What was seen

- **The reset route** takes the workspace's cell out under the cell's write guard, stops its indexer and its watcher, keeps one strong reference to the workspace aside and drops the cell (`perform_reset_with`, `crates/chan-server/src/routes/storage.rs:182-250`, the steps at `:191-210`). It polls that reference's count every 25 ms down to one within its drain deadline, and puts the cell back and answers busy when the count stays above one (`:211-223`). Then it closes the workspace's sessions, drops its reference and asks chan-workspace to reset (`:226`, `:229`, `:233`). The reset refuses a workspace that this process still holds and then takes the writer lock (`Library::reset_workspace_with`, `crates/chan-workspace/src/library.rs:408-435`, the refusal at `:417`, the lock at `:435`; `refuse_if_live`, `:355-365`).
- **The import route has the same shape** (`perform_metadata_import`, `crates/chan-server/src/routes/metadata.rs:201-263`, the count at `:234-241`, the close of the sessions and the drop at `:242-243`), and the import makes the same refusal and takes the same lock (`import_metadata_archive`, `crates/chan-workspace/src/metadata_archive.rs:388-389`).
- **Between the count and the drop, another thread can take a reference.** The cell's write guard holds the cell and not the workspace's weak references: the indexer's tasks keep one each and upgrade it to do their work (`crates/chan-server/src/indexer.rs:155`, `:333`, `:407`; upgraded at `:341`, `:427`, among others), and chan-workspace's own checks upgrade the live map's reference for a moment (`library.rs:325`, `:360`). The count is read at `storage.rs:215` and `metadata.rs:238`, and the route's reference is dropped after the sessions are closed (`storage.rs:226-229`; `metadata.rs:242-243`).

So an upgrade in that time makes the other thread the workspace's last owner, the workspace and its writer lock are dropped on that thread when it lets go, and the reset's or the import's own call meets the workspace as still open: the refusal answers `WorkspaceAlreadyOpen` while the other thread holds it, and the lock answers the same while its record still names this process (`crates/chan-workspace/src/lock.rs:227`, `:249-253`). Inferred by the builder, not reproduced. What the route does next is read here and not run: the reset reopens the workspace, trying twice, and the import once (`storage.rs:234-243`; `metadata.rs:253-259`), and when the reopen fails too the route returns its error with the cell's slot left empty, which it took at the start (`storage.rs:195`, `:240`; `metadata.rs:226`, `:261`); the import's own comment says a request then reads the workspace as missing (`metadata.rs:216-221`). How long another thread can hold its reference, and so whether the reopen can fail as well, was not read.

## Desired contract

The reset and the import ask for the writer lock only once the workspace is let go, whichever thread lets it go last; an upgrade on another thread in that time delays them within a bound or answers busy, and never fails them for their own workspace.

## What to do

Show it by a run first: a probe that holds an upgraded reference on another thread between the count and the drop, and lets it go a moment after, reds the reset and the import today. A suggestion beyond the record: after the drop, wait for the two facts that the host's teardown waits for before it answers, no strong reference left and the lock free, within a bound (`wait_for_workspace_release`, `crates/chan-library/src/host.rs:4760-4780`), and answer busy with the cell restored when the bound runs out. Red first at the probe's case.

## Boundaries

`crates/chan-server/src/routes/storage.rs` (`perform_reset_with`) and `crates/chan-server/src/routes/metadata.rs` (`perform_metadata_import`), with their tests. The lock, the refusal and the reset of chan-workspace are unchanged.

## Acceptance

1. A reset and an import beside a reference upgraded on another thread between the count and the drop complete or answer busy, pinned red first, 200 runs as they are and 200 on one CPU.
2. In that case neither route leaves the workspace's cell empty, pinned.
