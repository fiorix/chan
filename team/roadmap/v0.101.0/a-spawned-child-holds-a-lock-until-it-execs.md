# A spawned child holds a duplicate of a workspace lock until it execs

Status: raised during v0.101.0 on 2026-09-26 by the services lane's hung-root order (`dev/v0101-team/reports/report-Services-4.md`, "Loops", in the development tree), whose gate loops found the existing lock tests racing 25 times in 2000 runs, and confirmed by the independent review of that order (`reviews/review-Services-4.md`, finding 3), which traced the paths. A source reading against `main` at `cdd266b09`.

## What was seen

A child spawned by the process (a terminal, a probe helper) holds a duplicate of every descriptor the process has open from the fork until it execs, the workspace lock file included. `flock` belongs to the open file description, so the parent's close does not release the lock while that duplicate lives, and a probe, an `acquire` or the reopen handoff's `is_free` that runs in that window reads the lock as held by nobody it can name. In the test suite the window is a few milliseconds and shows as a one-in-eighty flake at `lock.rs:763` and `:775`; in production the same shape needs a terminal spawn beside a lock close, which is plausible and unmeasured. This is the descriptor-inheritance class the desktop liveness probe met in v0.93.0 (`team/roadmap/done/the-desktop-liveness-probe-test-is-load-sensitive-and-unexplained.md`), where the fix was structural.

Only the two paths that release a lock by closing its descriptor are exposed: `is_free` (`crates/chan-workspace/src/lock.rs:317-329`) and `probe_foreign_holder` when the lock was free (`:374-380`); `WorkspaceLock::drop` unlocks explicitly, so a mounted workspace's own lock is immune. Terminal spawns go through portable-pty's `pre_exec` fork path on Linux and macOS, so the child holds every descriptor until its close-on-exec sweep. Two production paths meet it: the tenant close's release verifier (`wait_for_workspace_release`, `host.rs:4287-4302`, polling `is_free`), after which an immediate reopen meets contention with a cleared record and `try_steal` refuses, so the on fails as locked by another process; and every list poll's probe of a stopped row, whose momentary hold makes a second chan process acquiring that root read `WorkspaceLocked` with no holder record, even without a fork.

## Desired contract

A lock the process closes is free at once for every other reader, whatever the process is spawning at that moment.

## What to do

Establish the window with the one-CPU rig (`scripts/e2e/one-cpu-test-series.sh`) on the lock tests, then close it the way the liveness probe was closed: open the lock descriptor with close-on-exec and keep the spawn from duplicating it (a `pre_exec` closing it, or the spawn taking the fork under the same serialization the openpty allocation already takes), with the flake measured before and after.

## Boundaries

`crates/chan-workspace/src/lock.rs` and the spawn in `crates/chan-library/src/terminal_sessions.rs`; the lock tests themselves.
