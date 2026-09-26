# One root's release budget blocks every other mount, close and remove

Status: landed on 2026-09-26 in its own lane, over three rounds each with an independent review; accepted for v0.101.0 by the owner on 2026-09-25; raised for v0.101.0 from the v0.99.0 fix loop's follow-ups, where the host-wide lock and the unowned handoff tasks were recorded and parked. A source reading against `main` at `d3de0180b`; not reproduced.

## Owner ruling

Accepted on 2026-09-25 with the owner's rule that no host-wide lock is held where it can be avoided: one root that is slow, unhealthy, mid-release or hung must not stall a mount, close, remove or listing of any other root. The first review found the host-level locks correct and the contract still unmet at the production entry points, through code the item's boundaries did not name, so the lane widened to those entry points.

## What was seen

`register_lock` in `crates/chan-library/src/host.rs` is a single host-wide `tokio::sync::Mutex<()>`. The mount path takes it, the close-by-root body takes it, and the remove path takes it, so a mount, close or remove of one root waits for whatever the holder is doing for a different root: a release budget, a synchronous workspace open, or a filesystem call on a root that has stopped answering. A per-root lock is the fix the review named. The same lock is the mechanism behind the timed-out mount already on the v0.100.0 roadmap, where the wait that reaches the compensating close is a wait on this mutex.

Separately, the devserver and desktop handoff listeners in `crates/chan-server/src/handoff.rs` spawn each accepted connection's work with a bare `tokio::spawn` inside the accept loop, so the listener does not own those tasks and cannot wait for them or cancel them when it stops. Two further clauses from the same review, an over-cap handoff client seeing EPIPE rather than the error reply, and a tool body that is not cancelled at unmount, are reported and not re-verified here.

## Desired contract

Mounts, closes and removes of different roots do not serialize on one lock, so one unhealthy root cannot stall the library; and each handoff listener owns the per-connection tasks it spawns.

## What shipped

- **Per-root locks.** `RootLocks` in `crates/chan-library/src/root_locks.rs` replaces the host-wide `register_lock`: one tokio mutex per canonical root, created on demand and pruned with its last holder (`KeyedLocks`), the key computed on the blocking pool before the lock is awaited. The stated lock order is at its definition. Two roots racing one prefix build at once and publication's single check-and-insert picks the winner.
- **Single-flight key hops.** `RootKeys` shares one in-flight canonicalization per spelled path, so any number of callers retrying against a hung root hold one blocking thread for the key hop. The later hops (the open, the revalidation, the registration) still take a thread per expired caller; that is [a-hung-root-takes-a-thread-per-expired-caller](a-hung-root-takes-a-thread-per-expired-caller.md).
- **The production entry points.** Devserver mount attempts lock per prefix (`mount_attempt_locks` in `crates/chan-server/src/devserver.rs`), check intent and settle by stored keys, and resolve and register a request's root off the runtime inside the mount bound. Registry lookups (`touch`, `find`, `remove`, load and reload in `crates/chan-workspace/src/registry.rs`) match outside the registry mutex, with a shared alias probe bounded at 2 s. Launcher and devserver ids, the lists, the window feed, a removal's window purge and startup restore work from stored keys; a relinked root, whose canonical path changed after registration, is found by the stored root its runtime opened at. Health checks run per root with a 2 s tick budget.
- **Handoff listeners.** Both listeners hold their accepted connections in a `JoinSet`. The devserver's registration listener stops accepting before the tenants shut down and drains in-flight replies for up to 30 s beside that shutdown (`stop_accepting` in `crates/chan-server/src/devserver_handoff.rs`); an over-cap client reads the refusal after its write fails with EPIPE at every client site (`reply_after_write` in `crates/chan-server/src/handoff.rs`).
- **Tests.** A root-stall seam (`root_stall` in `crates/chan-workspace/src/paths.rs`, compiled only for tests and the `test-hooks` feature) holds one root's filesystem calls, and tests at each entry point show another root answering beside it, each red against the code before the lane with the stalled call named. Every new race or hang test was looped 200 times, normally and pinned to one CPU.
- **Left open, raised as their own items:** [the-writer-lock-probe-waits-on-a-hung-root](the-writer-lock-probe-waits-on-a-hung-root.md), [a-hung-root-stalls-desktop-close-and-quit](a-hung-root-stalls-desktop-close-and-quit.md), [one-hung-root-holds-up-the-whole-restore](one-hung-root-holds-up-the-whole-restore.md), [a-hung-root-keeps-reading-running](a-hung-root-keeps-reading-running.md), [a-late-http-mount-escapes-the-shutdown-sweep](a-late-http-mount-escapes-the-shutdown-sweep.md), and the item's second clause, [a-started-mcp-tool-cannot-be-cancelled](a-started-mcp-tool-cannot-be-cancelled.md). The desktop's handoff listener handle is still leaked on exit, which drops its connections with the process.

## Boundaries

`crates/chan-library/src/host.rs` (`register_lock` and the mount, close-by-root and remove paths that take it) and `crates/chan-server/src/handoff.rs` (both accept loops and their per-connection spawns).

## Acceptance

1. A test shows a mount of one root completing while another root's close is inside its release budget, red against today's code.
2. A test shows two different roots taking different locks, and the lock order is stated where the per-root lock is defined.
3. The handoff listeners hold their per-connection tasks in a join set, and a test shows a listener shutdown waiting for an in-flight connection instead of detaching it.
