# A quit can still hang on a standalone Files window's watch

Status: accepted for v0.101.0 by the owner on 2026-09-27; raised during v0.101.0 on 2026-09-27 by the independent review of [the-quit-drain-can-hang-on-a-recovery-pass](the-quit-drain-can-hang-on-a-recovery-pass.md), which found it older than that fix and outside its files. Read in code at `7504a5f9c` and not reproduced; that the calls named below block on a mount that stopped answering, and that the last reference to the watch manager drops inside the drain, are inferred.

## Owner ruling

Accepted on 2026-09-27 for v0.101.0 as the lead recommended. The services lane's.

On 2026-09-29 the owner confirmed as built the ruling that the lead had made on this item's shape and had put to the owner with no answer: a quit waits at most two seconds on a standalone Files window's watch worker. The owner accepted in one answer every recommendation the lead had put to them that day.

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

## What shipped

Landed on 2026-09-27, with the bound on the watch manager's join, the second of the two shapes What to do names. The independent review of the range found it sound and asked for no fix round (`dev/v0101-team/reviews/review-Services-10.md` in the development tree). Lines are cited at `b1ef073ae`, in `crates/chan-server/src/standalone_watch.rs` where no other file is named.

- **The bound.** When the last handle to the Files watch manager drops, its `Drop` queues a shutdown command for the worker and waits at most `WATCH_SHUTDOWN_TIMEOUT`, two seconds (`:41-42`), for the worker to signal that it has exited (`:114-129`). The worker drops that signal only after its state has dropped, on unwind too (`:85-93`). On any answer but a timeout the drop joins the thread, which by then has only its end to run (`:125-126`); on a timeout it logs a warning and drops the thread's handle, which leaves the thread running on its own (`:123-124`). So a drop that runs during the drain holds the thread it runs on, a runtime worker, for at most two seconds.
- **What a worker left behind keeps, and when it stops.** It keeps its state: the OS watcher with its registrations, the resolver, the scope registry and the mutation bus (`ActorState`, `:156-170`). It stops when it reaches the shutdown request queued behind its pending work, or when the process exits. It reads one command at a time and, after each, retries the scopes still pending once their two-second interval has passed (`RETRY_INTERVAL`, `:40`; `actor_loop`, `:172-208`; `retry_pending`, `:368-380`), and each attach is a call on the watched directory (`try_attach`, `:220-266`). So the attaches and detaches queued before the shutdown, and the retries due between them, each run to their end first, and a retry that succeeds once the mount answers again adds a registration. That is the review's first finding. The two design documents and the type's comment say instead that such a worker stops when "that call returns" (`crates/chan-library/design.md:34`, `desktop/design.md:184`, `:61-63`), which is inexact; their correction is owed, and no quit waits on the worker either way.
- **The seam.** An attach resolves its directory's canonical form through `chan_workspace::paths::canonicalize_normalized` (`:233`), whose `root_stall` stall point lets a test hold the attach (`crates/chan-workspace/src/paths.rs:426-433`); on Unix it answers as the call it replaced did, as the review read it.
- **The aborted tenant tasks needed no change.** After the five-second grace the task owner aborts every unfinished tenant task and awaits each (`crates/chan-library/src/tenant.rs:266-277`). An abort takes effect at the task's next yield, as the review read tokio's source, and the document and scene tasks make every call on the workspace root on the blocking pool (`spawn_blocking` in `crates/chan-server/src/doc_sessions/mod.rs:733`, `:1107`, `:1527`, `:1833`, `:1852`, `:1955`, `:2042`, and in `crates/chan-server/src/scene_sessions/mod.rs:570`, `:1297`, `:1593`, `:1611`, `:1689`, `:1734`), so each await ends at a yield rather than inside such a call. The review read every tenant task for this and found the rest working in memory, with the one exception below. Both design documents state it (`crates/chan-library/design.md:34`, `desktop/design.md:184`).

Pinned at two levels, each shown red before the fix by a mutation that joins the worker with no bound after the timeout (`dev/v0101-team/reports/report-Services-18.md` in the development tree):

- `drop_bounds_a_held_attach_and_joins_a_healthy_worker` (`:506-555`) holds a resolver inside the worker's attach, drops the manager on another thread and requires the drop to return within five seconds while the attach is held, and the worker's state to be gone once it is released. Its healthy arm waits for a real subscription and requires the worker's state to be gone when the drop returns (`:557`).
- `host_drain_leaves_a_held_files_attach` (`crates/chan-server/src/devserver.rs:3493-3597`) mounts the real shared terminal tenant on a runtime with one worker, subscribes a Files scope, and holds its attach inside `try_attach` with the `root_stall` seam (`:3529`, `:3534-3542`). The host's drain, and the drop of the last owner of the tenant's state after it, must finish within fifteen seconds (`:3555-3567`, `:3587-3590`).

The lane's report ran both 200 times as they are and 200 on one CPU with no failure. What they do not show: the holds are test seams, not a mount that stopped answering; whether the OS removes a healthy worker's watch registrations was not measured; in each held arm two further checks cannot fail on their own, and the host pin's comment presents them as proof (`devserver.rs:3570-3572`), while the proof is the drain's completion signal, sent before the release (the review's third finding); and the warning names no directory (`:124`), so an operator cannot tell which mount held the worker (its second finding).

A residual outside this item's files, the review's fourth finding, read in code and not reproduced: the terminal pruner's minute tick runs on a runtime worker and reaps exited sessions (`crates/chan-library/src/terminal_sessions.rs:3320-3336`); a reaped standalone terminal fires the window reaper (`:3242-3250`), which removes its row from the window registry (`crates/chan-library/src/host.rs:1716-1728`), and that saves the registry inline (`remove_terminal` and `save_best_effort`, `crates/chan-library/src/windows.rs:565-579`, `:655-681`) to a file under the chan home (`windows.json`, `crates/chan-server/src/devserver.rs:2115`). With the chan home on a mount that stopped answering, a tick inside that save holds its worker past the abort, the owner's await after it does not end (`tenant.rs:272-276`), and the quit waits until the mount answers. The owner's contract is about a mounted root, so this is outside it unless the chan home shares the mount; it is raised for a decision as [the-terminal-pruner-saves-on-a-runtime-worker](../v0.102.0/the-terminal-pruner-saves-on-a-runtime-worker.md).
