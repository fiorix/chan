# An open's result that nobody received is dropped on a runtime worker, which joins its recovery

Status: accepted by the owner on 2026-09-29 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-28 from the independent reviews of the hung root's blocking calls (`dev/v0101-team/reviews/review-Services-15.md` in the development tree, question 2, and the lead's notes, "To raise at the next docs commit, from this review", its second sentence; `dev/v0101-team/reviews/review-Runtime-16.md`, finding F5a), and written in the design document (`crates/chan-library/design.md:32`). Older than that work. Read in code at `7957bccef`; where the runtime drops a task's result is the reviews' reading of tokio 1.52.2, which is outside this repository; nothing was run.

## Owner ruling

Accepted on 2026-09-29 for a later version. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. Under that rule this item goes to v0.102.0: the fault is a wrong state, and it needs a root that stops answering and a caller that leaves inside a narrow gap, a rare trigger. When it was raised the lead recommended a later version. It is not part of v0.101.0.

## What was seen

A registered open runs `Library::open_workspace` on the blocking pool and hands its result back in an `OpenedWorkspace`, whose drop stops the workspace's open-time recovery and joins it (`OpenedWorkspace`, `crates/chan-library/src/host.rs:795-812`; `stop_open_recovery`, `crates/chan-workspace/src/workspace.rs:1246-1253`, joining at `:654-669`). The recovery worker reads its stop flag only between passes, and a reconcile or a replay of pending writes runs to its end (`run_open_recovery`, `workspace.rs:971-979`).

When the caller leaves after the blocking open has completed and before it has received the result, the result is dropped on the thread that drops the caller, a runtime worker in the servers (`design.md:32`, as the reviews read tokio). That worker then waits in the join for as long as the recovery's filesystem call takes, which on a root that stopped answering has no end, and the work that worker would run waits with it (inferred). A result that completes after its caller left is dropped on the blocking pool's thread instead (`design.md:32`).

It needs a caller that leaves in the gap between the open's completion and its receipt, and a root that stops answering inside a recovery pass (inferred). How long a worker blocks there is among what only a real hung mount can show (`review-Services-15.md`, "What only a run on a real hung mount can show").

## Desired contract

No runtime worker waits on a root's filesystem: an open's result that nobody received is disposed of off the runtime.

## What to do

A later version, by the recommendation. As suggestions: dispose of the open's result on the blocking pool whoever drops it, or stop its recovery there without joining it on a runtime thread. Red first, with the stall seam holding a recovery pass: a caller dropped between the open's completion and its receipt, and a runtime worker shown free.

## Boundaries

`crates/chan-library/src/host.rs` (`open_registered_workspace_inner` and `OpenedWorkspace`), with its tests and the sentence of `crates/chan-library/design.md:32`.

## Acceptance

1. An open's completed result that its caller did not receive is dropped with no runtime worker waiting on its recovery, pinned red first.
2. The design says where such a result is dropped.

## What shipped

Built on 2026-10-03 on the v0.102.0 integration branch and not on `main`, in a range the lead accepted on its report, its status files and an independent review of its whole diff. This record was written that day from those. Nothing here ran on a real hung mount.

A blocking open's result and the mount permit it carried are owned by one value until the caller receives both (`OpenAnswer`, `crates/chan-library/src/host.rs`). Dropped unreceived with a workspace in it, it hands the workspace to the blocking pool (`UnreceivedOpen`), where the open-time recovery is stopped and joined and the workspace is released before the permit, so no runtime worker waits on the root's filesystem. A runtime that is shutting down starts no blocking work, so there the dropping thread releases it. Pinned red first with the stall seam holding a recovery pass (`an_unreceived_open_result_leaves_the_runtime_worker_free`, `crates/chan-server/src/devserver.rs`), with the order of release still held by the existing pin. `crates/chan-library/design.md` says where such a result is released. Its cost: the release needs a blocking thread, so with the pool exhausted it waits in the pool's queue, holding the mount permit and the writer lock until a thread is free. The row stays open for one path, read in the code by an independent review and by the lead: when the runtime is shutting down and drops the release unrun, nothing stops the recovery, so the permit is released while the workspace's writer lock is still held, and the design's sentence on that path is not what the code does. The repair is ordered.
