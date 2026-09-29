# A lock probe's own hold can refuse a concurrent acquire, and the daemon lock's publication still releases by a close

Status: accepted by the owner on 2026-09-29 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-28 from the work that made a lock probe unlock before it closes ([a-spawned-child-holds-a-lock-until-it-execs](../v0.101.0/a-spawned-child-holds-a-lock-until-it-execs.md)): its builder's reading of the callers and the residual it names (`dev/v0101-team/reports/report-Services-30.md` in the development tree, "Source reading, words and residuals"; `dev/v0101-team/evidence/Services/s28-caller-reading.md`), whose order named the first as not its own and to be raised (`dev/v0101-team/tasks/task-Lead-Services-24.md`, "Boundaries"). Read at `7957bccef` and not run: the landing's measurement ran the lock's own tests and none of these callers. One item for what the explicit unlock does not cover.

## Owner ruling

Accepted on 2026-09-29 for a later version. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. Under that rule this item goes to v0.102.0: the fault is a wrong state that needs two processes to overlap inside a probe's hold, a rare trigger, and the refusal it causes can be retried. When it was raised the lead recommended a later version. It is not part of v0.101.0.

## What was seen

**A probe's own hold.** A probe takes a free writer lock for a moment and publishes no record (`is_free`, `crates/chan-workspace/src/lock.rs:359-375`; `probe_foreign_holder`, `:421-472`; `crates/chan-workspace/design.md:552`). An acquire that meets it in that moment finds the lock contended with no record to read, which it cannot tell from a live holder, and refuses with `WorkspaceLocked` (`WorkspaceLock::acquire`, `lock.rs:217-229`; `try_steal`, `:236-272`). Probes run often: the status of a row that is not mounted (`crates/chan-library/src/host.rs:3889-3892`), a close's wait for the release, every 2 ms for up to five seconds (`wait_for_workspace_release`, `host.rs:4621-4641`), and the CLI's wait after a close, every 20 ms for up to five seconds (`wait_for_lock_release`, `crates/chan/src/lib.rs:2797-2809`). What the acquirer's caller then does:

- the host's open, which the devserver's mount, the launcher's add and on and the desktop's open all go through, answers a first `WorkspaceLocked` at once, since it retries that answer only once an in-process `WorkspaceAlreadyOpen` has started its release budget (`open_registered_workspace_inner`, `host.rs:1389-1395`);
- the standalone `chan serve` answers it at once, with the sentence that another process holds the workspace (`crates/chan/src/lib.rs:4013-4022`);
- the desktop's embedded open tries eight times, 150 ms apart (`desktop/src-tauri/src/embedded.rs:307-322`).

So a `chan serve`, or a mount, of a root that another chan process is probing can refuse for a moment's overlap as held by another process (inferred; not measured).

**The daemon lock's publication.** `DaemonLock::acquire` takes its lock on a plain file and, when writing its record fails, returns the error and drops the file, so the lock is released by the file's close, on the first path and after a steal (`crates/chan-workspace/src/daemon_lock.rs:95-102`, `:133-141`), while its drop on a clean exit unlocks explicitly (`:161-176`). A fork's duplicate of that descriptor then keeps the daemon lock held until its child execs: the mechanism the landing removed from the probes and the writer lock (read; not pinned).

## Desired contract

A probe's momentary hold is not taken by an acquire for another holder, and every lock this crate takes is released by an unlock.

## What to do

A later version, by the recommendation. As suggestions: the acquirers that answer `WorkspaceLocked` at once retry a contention that has no record within a short bound, as the desktop's does; or a probe tests the lock without taking it where the platform allows it; and the daemon lock's publication holds its lock through the crate's guard (`FileLock`, `lock.rs:41-61`). Red first: an acquire beside a probe that a seam holds in its hold, answered without `WorkspaceLocked`; and a daemon acquire whose record's write fails, with a duplicate of its file kept, followed by an acquire that succeeds.

## Boundaries

`crates/chan-workspace/src/lock.rs` and `daemon_lock.rs`, and the acquirers' retries in `crates/chan-library/src/host.rs` and `crates/chan/src/lib.rs` if the retry belongs there, with their tests.

## Acceptance

1. An acquire that meets a probe's hold does not answer `WorkspaceLocked`, pinned red first for each caller that answers it at once today.
2. A daemon acquire whose record's write fails releases its lock by an unlock, pinned with a duplicated descriptor.
