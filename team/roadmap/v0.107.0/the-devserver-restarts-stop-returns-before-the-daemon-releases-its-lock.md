# The devserver restart's stop returns before the daemon releases its lock

Status: built on 2026-10-16 on the seat's branch; the section Lock-release completion holds the evidence; it closes at the GA as shipped.

## What is open

`restart_devserver_chan` (and `start --force`) runs `stop_live_daemon`, which signals the daemon and returns as soon as its record is gone, then `start_devserver_chan`, which reads the daemon lock once (`daemon_lock_held`) and, if it reads held, polls two seconds for a live record only, without reading the lock again, then refuses ("a self-managed daemon is starting but has not written its pidfile yet"). The daemon removes its record at the end of its shutdown inside its lock guard's drop (`crates/chan-workspace/src/daemon_lock.rs`: the drop removes `daemon.json` and then unlocks), so the refusal needs the lock held at one instant after the record is gone: the start's one read landing between the removal and the unlock (microseconds, stretched on a loaded runner), or another process's probe holding the lock at that instant (`daemon_lock_held` takes the lock to test it). Seen once, in the `make test-symlink-tmpdir` arm of that run; green seven times at the same commit on GitHub's runners and in the integration gate, and in every earlier run of the round. The record is in the v0.106.0 release report and the round's bus (`ga/runs/`).

## What to do

Make the stop's completion criterion the lock's release (within the stop's fifteen-second timeout), and make the start re-read the lock during its wait and proceed once it is free. Pin it with a test that holds the window after the record's removal and before the unlock (the `RELEASE_SEAM` under `cfg(test)` in `daemon_lock.rs`, reachable from that crate's unit tests, or a test-owned holder of the lock at the start's check), red on the current code at the refusal and green with the repair.

## Boundaries

The refusal message stays for a daemon that is genuinely starting; the stop's fifteen-second bound and the `--force` path keep their meaning.

## Acceptance

1. The pin red at the current code and green with the repair, with its mutation.
2. The resilience suite whole green in a capped guest and on GitHub's Linux runner, in both arms of `make ci-linux`.
3. The refusal message kept for a daemon that is genuinely starting.

## Lead's rulings 2026-10-16

Three rulings on the design, given by the lead as the item's decider and read by the review seat. One: a live record that appears while the lock stays held takes the existing-daemon path; the start's refusal is for a held lock with no live record through the bound. Two: a stop that meets a held lock with no record waits for the release within its bound without signalling, `--force` included, and ends in a bounded diagnostic that invents no pid. Three, refining two: a holder with no record is a daemon between its acquire and its publish, which writes its record within milliseconds and never releases, so the stop re-reads the record on each turn of its wait, signals once a live record the held lock corroborates, and goes on waiting for the release; with no record through the bound the diagnostic stands.

## Lock-release completion 2026-10-16

Built the start's combined lock/record wait and the shared stop wait in `crates/chan/src/devserver_daemon.rs`. Start probes every 50 ms within two seconds and proceeds when the lock is free, including on the final probe. Stop probes every 100 ms within fifteen seconds and completes on lock release. It rereads the live record and signals once when a corroborated identity appears; both stop entry points, restart and start with `--force` use that completion criterion. A holder without an identity through the bound receives the lock-path diagnostic and instructions to identify and stop the process. The unchanged starting-holder refusal's `--force` pointer leads to this diagnostic when that holder never publishes a live record.

Eight lifecycle tests use private homes and test-owned locks. The original start pin failed at the missing-pidfile refusal; both known-daemon stop entry points failed before their held-lock wait, the appearing-record stop returned without waiting, and the unknown-holder stop incorrectly returned success. Cargo exited 101 with five assertion failures and three passing guards. With the repair all eight passed. The first record-only stop mutant survived because the fixture released at its first wait point; the retained survivor led to a stronger fixture that keeps the lock through a second probe. The same mutant then failed both stop cases. Four other independent mutations fail their intended assertions: record-only start, removed starting-holder refusal, no signal for an appearing record, and a deadline check before the start's lock probe. Each mutation was restored; no surviving mutation remains. Logs, scripts, statuses and patches are under `dev/v0107-team/evidence/Runtime107/rstrace-code/`; the first survivor is retained with `first-` names.

The committed own-gate at `39af68cfd18ddc1f7d0a28d291cc289911996fea` passed all four commands, each exit 0: `cargo fmt --check`; `RUSTFLAGS=-Dwarnings cargo clippy -p chan --all-targets -- -D warnings`; `cargo test -p chan --all-targets -- --test-threads=2`; and `TMPDIR=<verified disk symlink> RUSTFLAGS=-Dwarnings cargo test -p chan --no-fail-fast -- --test-threads=2`. Both suite arms passed 432 tests, including all 37 resilience tests and `chan_service_start_status_join_restart_stop`; the existing owner-run two-GiB tunnel test was ignored in each. The symlink arm also ran the crate's empty doctest target. The first gate stopped at clippy's type-complexity warning on the test callback; a private type alias repaired it before the complete gate. No resilience failure occurred. Exact commands, full logs, statuses, the symlink's resolved path and the clean start/end SHA records are under `dev/v0107-team/evidence/Runtime107/rstrace-code/final-evidence/`; the driver is `gate2.sh` beside that directory. The final evidence amendment changes only this row and the commit message.

The runtime guest is `chan-v0107-runtime`, 2 CPUs / 6 GiB / 44 GiB, non-root `ubuntu`, with two cargo jobs and two test threads; `dev/v0107-team/reports/environment-Runtime107.md` records its setup. Host cgroup records show CPU throttling and the memory cap reached, with a lifetime swap peak of 1,711,927,296 bytes and no OOM: these are contended correctness runs, not product timing measurements. Acceptance 1 and 3 are covered by the lifecycle tests and mutations. Acceptance 2's local whole-suite arms passed; its GitHub Linux arms belong to the lead's `ci.yml` dispatch on the integrated commit.

Two costs remain explicit. The boolean lock probe treats an open or unexpected lock-test error as free, so stop may report completion while a daemon is still running; the child's own acquisition still refuses contention or an open error. On Unix, `live_record` corroborates that some process holds the flock and the recorded pid is alive, not that the recorded pid holds that flock: a dead daemon's reused pid, read while another holder has the lock for microseconds, can read live; that window predates this item and is not closed by it.
