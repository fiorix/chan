# A mounted root that hangs, rather than errors, reads running for as long as it hangs

Status: accepted for v0.101.0 by the owner on 2026-09-26; raised during v0.101.0 on 2026-09-26 from the independent review of the root locks lane (`dev/v0101-tasks/reviews/review-rlock-2.md`, finding 6), which the lane's report discloses and names as a small follow-up (`dev/v0101-tasks/report-rlock-2.md`, part B, what is left, 3). It follows from [one-root-blocks-every-other-mount](one-root-blocks-every-other-mount.md). A source reading against the root locks lane at `3746c268f`, which had not landed on the integration branch when this was raised, so every line cited is as it is at that sha; read in code, not reproduced.

## Owner ruling

Accepted on 2026-09-26 on the owner's word that nothing is deferred, in the services lane's hung-root orders with [the-writer-lock-probe-waits-on-a-hung-root](the-writer-lock-probe-waits-on-a-hung-root.md). The lead's ruling on when a check is overdue: after two consecutive missed budgets, about thirty seconds, so a root that is only slow is not flagged on one miss.

## What was seen

The root health probe checks every mounted root at once, each on a thread of its own, and a tick waits at most two seconds for the answers (`WorkspaceHost::probe_mounted_roots`, `crates/chan-library/src/host.rs:3674-3714`; `ROOT_HEALTH_PROBE_BUDGET`, `:52`). A check that has not answered keeps its thread and its workspace, and later ticks join it instead of starting another (`start_root_probe`, `:3719-3723`). A tick whose check is still running skips that root (`:3701-3705`), and the comment there says the root "keeps whatever the last check that did answer published". Both embedders drive the probe every 15 s (`ROOT_HEALTH_PROBE_INTERVAL`, `crates/chan-server/src/devserver.rs:307`, `:327-347`; the desktop at `desktop/src-tauri/src/embedded.rs:212`).

So a root whose filesystem fails with an error reads `unavailable` within a tick, which is what [a-replaced-root-still-reads-running-on-the-desktop](../done/a-replaced-root-still-reads-running-on-the-desktop.md) delivered, but a root whose filesystem stops answering keeps the state last published, and `workspace_status_by_key` reads a mounted root with no `Unavailable` state as `running` (`:3507-3517`). If C is mounted and its NFS server hangs, the launcher and devserver lists show C `running` for as long as it hangs, while every read through its tenant hangs. `crates/chan-library/design.md:40` describes the current behaviour.

## Desired contract

A mounted root whose health check has not answered within the probe budget reads `unavailable` with a reason that says the root is not answering, and reads `running` again once a check answers healthy.

## What to do

The review suggests publishing "not answering" for an overdue check. In the tick's unanswered arm, record `MountState::Unavailable` with that reason, the state the launcher already renders, so the wire does not change; the answered path already clears it when the root is healthy (`reconcile_root_health`, `host.rs:3762-3771`). The decision is when a check counts as overdue: at the first missed budget, which can flag a root that is only slow, or after a number of ticks. Red first: stall a mounted root with the `paths::root_stall` seam, which also holds health revalidations (`crates/chan-workspace/src/paths.rs:491-495`), run two ticks and show the row read `unavailable`; today it reads `running`. Then update `design.md:40`.

## Boundaries

`crates/chan-library/src/host.rs` (`probe_mounted_roots`, `reconcile_root_health`) and the health paragraph of `crates/chan-library/design.md`. The unbounded revalidation on the add and on path (`revalidate_mounted_root`, `host.rs:1328-1341`) belongs to [a-hung-root-takes-a-thread-per-expired-caller](a-hung-root-takes-a-thread-per-expired-caller.md).
