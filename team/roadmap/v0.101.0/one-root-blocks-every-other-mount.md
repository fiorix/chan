# One root's release budget blocks every other mount, close and remove

Status: raised for v0.101.0 from the v0.99.0 fix loop's follow-ups, where the host-wide lock and the unowned handoff tasks were recorded and parked. A source reading against `main` at `d3de0180b`; not reproduced.

## What was seen

`register_lock` in `crates/chan-library/src/host.rs` is a single host-wide `tokio::sync::Mutex<()>`. The mount path takes it, the close-by-root body takes it, and the remove path takes it, so a mount, close or remove of one root waits for whatever the holder is doing for a different root: a release budget, a synchronous workspace open, or a filesystem call on a root that has stopped answering. A per-root lock is the fix the review named. The same lock is the mechanism behind the timed-out mount already on the v0.100.0 roadmap, where the wait that reaches the compensating close is a wait on this mutex.

Separately, the devserver and desktop handoff listeners in `crates/chan-server/src/handoff.rs` spawn each accepted connection's work with a bare `tokio::spawn` inside the accept loop, so the listener does not own those tasks and cannot wait for them or cancel them when it stops. Two further clauses from the same review, an over-cap handoff client seeing EPIPE rather than the error reply, and a tool body that is not cancelled at unmount, are reported and not re-verified here.

## Desired contract

Mounts, closes and removes of different roots do not serialize on one lock, so one unhealthy root cannot stall the library; and each handoff listener owns the per-connection tasks it spawns.

## Boundaries

`crates/chan-library/src/host.rs` (`register_lock` and the mount, close-by-root and remove paths that take it) and `crates/chan-server/src/handoff.rs` (both accept loops and their per-connection spawns).

## Acceptance

1. A test shows a mount of one root completing while another root's close is inside its release budget, red against today's code.
2. A test shows two different roots taking different locks, and the lock order is stated where the per-root lock is defined.
3. The handoff listeners hold their per-connection tasks in a join set, and a test shows a listener shutdown waiting for an in-flight connection instead of detaching it.
