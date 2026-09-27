# A spawned child holds a duplicate of a workspace lock until it execs

Status: raised during v0.101.0 on 2026-09-26 by the services lane's hung-root order (`dev/v0101-team/reports/report-Services-4.md`, "Loops", in the development tree), whose gate loops found the existing lock tests racing 25 times in 2000 runs, and confirmed by the independent review of that order (`reviews/review-Services-4.md`, finding 3), which traced the paths. A source reading against `main` at `cdd266b09`.

## Owner ruling

Accepted on 2026-09-26 as the lead recommended: the lock descriptor is opened close-on-exec and the spawn is kept from duplicating it, with the flake measured on the one-CPU rig before and after; the services lane owns the lock side and coordinates the spawn change with the runtime lane. It also retires the lock tests' measured flake (20 of 2000 at landing 17).

On 2026-09-27 the owner accepted, as the lead recommended, a revision of the mechanism: the probe unlocks once it has succeeded, and no spawn changes. A code map of the lane's next orders (`dev/v0101-team/int24-docs/codemaps/services-next.md` in the development tree, headline 2 and its section on this item, read at `4139f8656`, nothing run) read that neither mechanism the ruling named closes the window between a fork and its exec. The lock file is opened through the standard library's `OpenOptions` (`open_lock_file`, `crates/chan-workspace/src/lock.rs:427-444`), which on Unix opens with close-on-exec already, as the map reads the standard library, and close-on-exec acts only at the exec; the openpty serialization the ruling offered to reuse exists only on FreeBSD and never covers the fork, as the map read it. A flock belongs to the open file description, so an unlock through the probe's own descriptor also releases the copy a fork inherited, which is what the admission lock's drop already does and says (`AdmissionLock`, `lock.rs:43-49`). The probes that release by closing are `is_free` (`:317-330`), `probe_foreign_holder` through `classify_lock_attempt` (`:376-386`, `:391-425`), and a third of the same shape this item did not name, `daemon_lock_held` (`crates/chan-workspace/src/daemon_lock.rs:202-212`); each takes the lock and lets its file drop. That an unlock after a successful probe closes the window is the map's inference. The lead read what the map had not: fs4's `unlock` on Unix is `flock` with the unlock operation (fs4 0.9.1, `src/unix.rs:24-26`). Nothing was run.

## What was seen

A child spawned by the process (a terminal, a probe helper) holds a duplicate of every descriptor the process has open from the fork until it execs, the workspace lock file included. `flock` belongs to the open file description, so the parent's close does not release the lock while that duplicate lives, and a probe, an `acquire` or the reopen handoff's `is_free` that runs in that window reads the lock as held by nobody it can name. In the test suite the window is a few milliseconds and shows as a one-in-eighty flake at `lock.rs:763` and `:775`; in production the same shape needs a terminal spawn beside a lock close, which is plausible and unmeasured. This is the descriptor-inheritance class the desktop liveness probe met in v0.93.0 (`team/roadmap/done/the-desktop-liveness-probe-test-is-load-sensitive-and-unexplained.md`), where the fix was structural.

Only the two paths that release a lock by closing its descriptor are exposed: `is_free` (`crates/chan-workspace/src/lock.rs:317-329`) and `probe_foreign_holder` when the lock was free (`:374-380`); `WorkspaceLock::drop` unlocks explicitly, so a mounted workspace's own lock is immune. Terminal spawns go through portable-pty's `pre_exec` fork path on Linux and macOS, so the child holds every descriptor until its close-on-exec sweep. Two production paths meet it: the tenant close's release verifier (`wait_for_workspace_release`, `host.rs:4287-4302`, polling `is_free`), after which an immediate reopen meets contention with a cleared record and `try_steal` refuses, so the on fails as locked by another process; and every list poll's probe of a stopped row, whose momentary hold makes a second chan process acquiring that root read `WorkspaceLocked` with no holder record, even without a fork.

## Desired contract

A lock the process closes is free at once for every other reader, whatever the process is spawning at that moment.

## What to do

Establish the window with the one-CPU rig (`scripts/e2e/one-cpu-test-series.sh`) on the lock tests, then close it as the owner's revised ruling says: each probe that takes the lock only to test it, `is_free`, `probe_foreign_holder` and `daemon_lock_held`, unlocks through its own descriptor once its attempt has succeeded, before its file drops, as the admission lock's drop does; no spawn changes. Measure the flake before and after. This paragraph was brought to the revised ruling on 2026-09-27: it named close-on-exec and a spawn kept from duplicating the descriptor.

## Boundaries

`crates/chan-workspace/src/lock.rs` and `crates/chan-workspace/src/daemon_lock.rs`; the lock tests themselves. No spawn changes. This section was brought to the revised ruling on 2026-09-27: it named the spawn in `crates/chan-library/src/terminal_sessions.rs`.
