# The devserver restart's stop returns before the daemon releases its lock

Status: raised by the lead after the v0.106.0 GA on 2026-10-15 from the first `ci.yml` run on `0.106.0-ga` (38705953886), red once on `chan_service_start_status_join_restart_stop` in the chan crate's resilience suite on GitHub's Linux runner; written down, not designed, not accepted for build; owner the runtime seat.

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
