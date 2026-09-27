# The quit drain can hang on a mounted root's recovery pass

Status: accepted for v0.101.0 by the owner on 2026-09-26; raised during v0.101.0 on 2026-09-26 by an independent reading of the fix for [a-hung-root-stalls-desktop-close-and-quit](a-hung-root-stalls-desktop-close-and-quit.md) before it landed, read in code and not reproduced; a source reading against `main` at `ef33cb0f3` and that fix.

## Owner ruling

Accepted on 2026-09-26 as the lead recommended: a quit finishes within a stated bound whatever a mounted root's filesystem does; a recovery pass that does not stop within it is abandoned, not awaited; pinned with a stalled recovery pass.

## What was seen

The desktop's quit starts a drain that awaits every runtime's shutdown. A runtime's shutdown clears its workspace cell, which calls `Workspace::stop_open_recovery`, an unbounded `JoinHandle::join` run inline on a runtime worker. When a mounted root's open-time recovery pass (a full rebuild after a crash, for instance) is inside a call that hangs on that root, the drain never returns and the process never exits. It needs a recovery pass in flight on the hung root; the fix for [a-hung-root-stalls-desktop-close-and-quit](a-hung-root-stalls-desktop-close-and-quit.md) does not reach it.

Read in code on 2026-09-27 at `3f60c072d`, not reproduced: a second join with no bound follows the first by one line, and it needs no recovery pass. The drain spawns each runtime's shutdown (`drain_tenants`, `crates/chan-library/src/host.rs:3480-3505`), and `HostedWorkspaceRuntime::shutdown` clears the tenant's cell inline (`host.rs:634`). That clear (`CellHandle::clear`, `crates/chan-server/src/lib.rs:1566-1584`) joins the recovery thread (`workspace.stop_open_recovery()`, `:1575`) and on the next line drops the watch handle (`:1576`), whose `Drop` stops and joins the watcher's supervisor thread (`crates/chan-workspace/src/watch.rs:1420-1423`, through `stop` and `join_supervisor` at `:1373-1392`). That thread stats the workspace root with `symlink_metadata` on every idle tick, at most 250 ms apart (`watch_supervisor_loop`, `watch.rs:687-693`; `WATCH_RETRY_INTERVAL` at `:314`; the root from `Workspace::watch`, `crates/chan-workspace/src/workspace.rs:4242`), and reads its stop command only between ticks (`:626`, `:675`). A supervisor inside that stat on a root that has stopped answering keeps the join waiting, and every workspace tenant has a watcher unless its registration failed (`lib.rs:697-707`), so a quit can wait on any mounted root that stops answering, recovery pass or not. The `root_stall` seam cannot hold that stat: its only stall points are in `crates/chan-workspace/src/paths.rs` (`:428`) and `rooted_fs.rs` (`:233`), so no test that holds a root with it can hold the watcher there.

## Desired contract

A quit finishes within a stated bound whatever a mounted root's filesystem does; a recovery pass that does not stop within it is abandoned, not awaited.

## What to do

Bound the join in `stop_open_recovery` (or run it off the drain's path) and pin with a stalled recovery pass under the `root_stall` seam. Small; chan-workspace and chan-server. The second join read on 2026-09-27 moves the bound to the host's drain: see Boundaries.

## Boundaries

The bound belongs on the host's drain, in `crates/chan-library/src/host.rs` (`drain_tenants`, and `HostedWorkspaceRuntime::shutdown`, which runs the cell's clear inline on a runtime worker), not in `stop_open_recovery`: the clear holds both joins, and a bound on the recovery thread's alone leaves the watcher's. Tests there and in the desktop's hung-root tests, with a seam in `crates/chan-workspace` only if the stalled recovery pass the ruling asks for cannot be held without one. `CellHandle::clear` in `crates/chan-server/src/lib.rs` and `stop_open_recovery` in `crates/chan-workspace/src/workspace.rs` are the joins the bound waits on, not the place for it.
