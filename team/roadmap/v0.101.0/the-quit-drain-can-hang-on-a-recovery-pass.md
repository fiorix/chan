# The quit drain can hang on a mounted root's recovery pass

Status: accepted for v0.101.0 by the owner on 2026-09-26; raised during v0.101.0 on 2026-09-26 by an independent reading of the fix for [a-hung-root-stalls-desktop-close-and-quit](a-hung-root-stalls-desktop-close-and-quit.md) before it landed, read in code and not reproduced; a source reading against `main` at `ef33cb0f3` and that fix.

## Owner ruling

Accepted on 2026-09-26 as the lead recommended: a quit finishes within a stated bound whatever a mounted root's filesystem does; a recovery pass that does not stop within it is abandoned, not awaited; pinned with a stalled recovery pass.

## What was seen

The desktop's quit starts a drain that awaits every runtime's shutdown. A runtime's shutdown clears its workspace cell, which calls `Workspace::stop_open_recovery`, an unbounded `JoinHandle::join` run inline on a runtime worker. When a mounted root's open-time recovery pass (a full rebuild after a crash, for instance) is inside a call that hangs on that root, the drain never returns and the process never exits. It needs a recovery pass in flight on the hung root; the fix for [a-hung-root-stalls-desktop-close-and-quit](a-hung-root-stalls-desktop-close-and-quit.md) does not reach it.

## Desired contract

A quit finishes within a stated bound whatever a mounted root's filesystem does; a recovery pass that does not stop within it is abandoned, not awaited.

## What to do

Bound the join in `stop_open_recovery` (or run it off the drain's path) and pin with a stalled recovery pass under the `root_stall` seam. Small; chan-workspace and chan-server.

## Boundaries

`crates/chan-workspace/src/workspace.rs` (`stop_open_recovery`) and the shutdown path that calls it in `crates/chan-server/src/lib.rs`; tests.
