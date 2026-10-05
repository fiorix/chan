# An open's result that nobody received is dropped on a runtime worker, which joins its recovery

Status: shipped in [v0.102.0](../../release/release-v0.102.0.md).

Record before the release: accepted by the owner on 2026-09-29 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-28 from the independent reviews of the hung root's blocking calls (`dev/v0101-team/reviews/review-Services-15.md` in the development tree, question 2, and the lead's notes, "To raise at the next docs commit, from this review", its second sentence; `dev/v0101-team/reviews/review-Runtime-16.md`, finding F5a), and written in the design document (`crates/chan-library/design.md:32`). Older than that work. Read in code at `7957bccef`; where the runtime drops a task's result is the reviews' reading of tokio 1.52.2, which is outside this repository; nothing was run.

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

The repair was built later that day, in a range the lead accepted on its report, its status files and an independent review of its whole diff. `UnreceivedOpen` stops and joins the recovery in its own drop and then lets go of the workspace before the permit, so a release that the pool runs, refuses or drains unrun does the same thing on whichever thread drops it (`crates/chan-library/src/host.rs`); the hand-off contains the pool's panic when the system has no thread to give, which was reproduced. Pinned red first through a runtime that is stopping. The row stays open for what the review read in the refused path: tokio drops a refused task while it holds the blocking pool's own lock, so the join runs under that lock, every other blocking spawn of that runtime waits for it, and a process's exit can wait on the recovery, which a refused release did not do before this repair. The mechanism was read in the source of tokio 1.53.1 where the lock file pins 1.52.2, and the race was not run. Ordered: a second owner, so that the refusal is never the last drop. Two sentences still say that no runtime worker joins the recovery, which holds only while the runtime runs. The written cost: on a runtime that is shutting down, the thread that drops the result joins the recovery, as every drop did in v0.101.0.

The refused path was repaired later that day, in a range the lead accepted on its report, its status files and an independent review of its whole diff. The release has two owners: the task handed to the pool takes it, and the thread that drops the unreceived result lets go of its own after the spawn returns, so a runtime's refusal is never the release's last drop and the join runs on the dropping thread, outside the pool's lock (`OpenAnswer`'s drop, `crates/chan-library/src/host.rs`). Pinned red first (`a_refused_release_of_an_unreceived_open_leaves_the_blocking_pool_free`). The builder read the refusal in the pinned tokio's source; the review read it in a later version and marks it inferred for the pin. Left, as costs: one interleaving no test reaches, a process's exit wait that was not run, and two sentences on what a stopping runtime does with a queued task, which say more than the runtime promises and are ordered to be made exact.

The two sentences on what a stopping runtime does with a queued task were made exact later that day: it may run or drop the task, and either way the release is made outside the pool's lock (`crates/chan-library/src/host.rs`, `crates/chan-library/design.md`).
