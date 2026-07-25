# Move Workspace::open's inline reconcile off the calling thread

> Status: shipped in [v0.76.0](../../release/release-v0.76.0.md): Workspace::open's reconcile/rebuild now runs on a supervised, cancellable owned recovery worker off the mount path (non-blocking open); closing a workspace mid-recovery releases its flock promptly instead of holding it past teardown.

Status: REGISTERED for v0.76.0. Remainder (lever 5) of the devserver
rebuild-storm plan; levers 1-4 shipped in v0.76.0 (see
`done/` history once v0.76.0 closes, and
`../v0.76.0/devserver-rebuild-storm-and-livelock.md` for the incident
evidence until then).

## Problem

`Workspace::open` runs an inline `reconcile()` (a full stat walk) on
the calling thread, on the mount path
(`crates/chan-workspace/src/workspace.rs:496-512`, reconcile at
`:2984`). On a cold large tree this is minutes on an async worker
while the server is supposedly up. It is also the main gate for
chan-desktop startup on big repos: the desktop boot matrix already
backgrounds boot mounts, so the mount itself is what is slow.

## Direction

- Move the reconcile off the async path (dedicated blocking thread or
  deferred to the background indexer), so mount returns fast and
  graph/report consistency arrives through the background path.
- Preserve the current consistency contract: reconcile is what picks
  up files added/removed/rewritten offline (tests at
  workspace.rs:4766-5060 pin this); the async move must not turn
  boot-time staleness into silent misses.

## Acceptance

- `Workspace::open` on a cold large tree returns without the inline
  walk on the calling thread; offline changes still reach the graph
  and index through the background path (measured on a big fixture).
- The existing reconcile tests stay green; a new test pins the
  non-blocking open.
