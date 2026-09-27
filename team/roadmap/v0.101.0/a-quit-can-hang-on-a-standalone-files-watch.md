# A quit can still hang on a standalone Files window's watch

Status: accepted for v0.101.0 by the owner on 2026-09-27; raised during v0.101.0 on 2026-09-27 by the independent review of [the-quit-drain-can-hang-on-a-recovery-pass](the-quit-drain-can-hang-on-a-recovery-pass.md), which found it older than that fix and outside its files. Read in code at `7504a5f9c` and not reproduced; that the calls named below block on a mount that stopped answering, and that the last reference to the watch manager drops inside the drain, are inferred.

## Owner ruling

Accepted on 2026-09-27 for v0.101.0 as the lead recommended. The services lane's.

## What was seen

The quit drain now clears each workspace cell on a blocking thread and stops waiting for it at a deadline. What a hosted runtime drops on the runtime worker itself is outside that bound. `shutdown_with_budget` drops the keepalive on the worker (`crates/chan-library/src/host.rs:631-634`), and the runtime's remaining fields drop there when the function returns.

The shared terminal tenant's state holds the standalone Files state (`crates/chan-server/src/state.rs:203`), which owns a watch manager (`:216`) whose `Drop` sends its worker a shutdown command and then joins the worker's thread with no bound (`crates/chan-server/src/standalone_watch.rs:103-110`). That worker resolves and watches every directory a standalone Files window subscribes to: `try_attach` calls `std::fs::canonicalize` and the watcher's `watch` on the directory (`standalone_watch.rs:200-226`), and scopes that did not attach are retried every two seconds (`RETRY_INTERVAL`, `:40`, `:169-187`). The worker reads its shutdown command only between those calls.

So with a standalone Files window open on a directory of a mount that stopped answering, the worker can be inside one of those calls when the user quits; the drop of the terminal tenant's last state reference joins it on a runtime worker, the drain's `join_next` does not return, and the quit waits until the mount answers.

The review names a second wait of the same kind: after the five-second grace the tenant's task owner aborts its unfinished tasks and then awaits each with no bound (`crates/chan-library/src/tenant.rs:266-277`). Whether any tenant task can hold a worker in synchronous code past its abort was not read.

## Desired contract

A quit finishes within its stated bound whatever a mounted root's filesystem does, as the owner accepted for the recovery pass: no drop that runs during the drain joins a thread that can be waiting on a filesystem, and no wait of the drain is without a bound.

## What to do

Move the watch manager's join off the runtime worker and under the drain's deadline, as the cell's clear was moved, or give the join a bound of its own and leave the thread to the process's exit. Decide the same for the wait on aborted tasks once it is read. Pin it with a standalone Files scope held inside its attach while the host drains.

## Boundaries

`crates/chan-server/src/standalone_watch.rs`, `crates/chan-library/src/tenant.rs` and `crates/chan-library/src/host.rs` (the drain), with their tests. The workspace's own watcher and the recovery pass are unchanged.

## Acceptance

1. With a standalone Files scope held inside its attach, the host's drain returns within its bound, pinned by state and not by time alone.
2. A healthy quit still stops the watch worker and releases its registrations.
3. The design documents state what the drain waits for and what it leaves to the process's exit.
