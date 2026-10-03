# An open dispatched before a removal can recreate the removed workspace's metadata directories

Status: raised for a decision on 2026-10-03 by the builder of the open's barrier in [a-hung-root-takes-a-thread-per-expired-caller](a-hung-root-takes-a-thread-per-expired-caller.md), as what that barrier leaves; the owner has not ruled on it. Read in the code on the v0.102.0 integration branch; not run.

## What was seen

An open reads its root's registry row and only later takes the workspace's writer lock, with a call on the root's filesystem between the two (`Library::open_workspace`, `crates/chan-workspace/src/library.rs:353`). The barrier built in v0.102.0 keeps an open from starting while a registry write of its root is outstanding. It does not cover a write that starts after the open was dispatched. A registration then only writes the row again, which is harmless. A removal can start only once the open's caller has left, since a live caller holds the root's lock, so that open's result is discarded; but it can still create the metadata directories of the key the removal has just wiped, and nothing lists them. The library has a sweep that would delete them (`sweep_orphans`, `library.rs:671`), which no code under `crates/` calls outside a test.

## Desired contract

Not written yet. The choice is whether the core refuses an open whose row is gone by the time it holds the writer lock, or the leftover directories stay a written cost.

## What to do

Rule one of two. `Library::open_workspace` reads its row again by metadata key once it holds the writer lock and answers `WorkspaceNotRegistered` when the row is gone: exact, since the unregister holds that lock across its registry update, and a change of the core's contract for every caller, the CLI included. Or the cost stays written in `crates/chan-library/design.md`, where the barrier's rule is.

## Boundaries

`crates/chan-workspace/src/library.rs` (`open_workspace`) and its tests; `crates/chan-workspace/design.md`.

## Acceptance

1. The ruling is recorded.
2. If it is built: an open that read its row before a removal of that row finished answers that the workspace is not registered and creates nothing under the removed key; pinned red first with a seam between the row's read and the writer lock.
