# A workspace whose folder left the registry while a start was restoring it is registered and mounted again at the next start

Status: raised for a decision on 2026-10-05, before the v0.102.0 GA, and listed under v0.103.0 from the start: the owner asked that day that what leaves v0.102.0 be put in the next version's list to be checked, and this is the lead's proposal for that list. `raised | decide`: not accepted and not built; the owner has not ruled on it and did not take it into v0.102.0, which shipped on 2026-10-05.

Raised by the lead from the second cost that the repair of a superseded start left written in v0.102.0. It was first found by the independent review of the range that made a devserver's start write nothing to its saved state (`ec162cc84..ca179bba3`, that review's second medium finding), and it is written in `crates/chan-server/design.md`, in the unreleased changelog entry on a devserver start that a turn-off or a forget overtakes, and on [a-removal-does-not-hold-the-row-it-selected](a-removal-does-not-hold-the-row-it-selected.md). It is a reading, with nothing run. The functions named below were read again for this item at `22c1e8fc8`, the commit of the version's second release candidate, and nothing was run for it.

## Owner ruling

Not ruled. The owner ordered the repair of a superseded start on 2026-10-05 and was told in writing that day, with the state of the first release candidate, that two of its costs stay written, this one and [chan-serve-serves-alone-after-an-overtaken-start](chan-serve-serves-alone-after-an-overtaken-start.md), and was asked to say if either should be built before the GA. No answer is recorded.

## What was seen

Nothing was seen in a run or in use: no run and no report shows this state. What follows was read in the code.

A devserver keeps, beside the registry, an overlay of the workspaces it serves, with a row for each that says whether it is on. At a start it registers each overlay row whose path the registry lacks (`register_restore_rows`, `crates/chan-server/src/devserver.rs`) and restores the rows that are on. A start writes nothing to the overlay: `crates/chan-server/design.md` says it in those words, and an attempt the restore started writes no overlay row when it settles, by success, failure, stand-down, superseded settlement or drop.

So when a workspace's registry row is dropped while its restore attempt is pending, the attempt reads that no registry row goes by its root and is superseded, and it saves nothing: before its open an attempt saves only when a request began it, and after its open a superseded attempt saves nothing (`reconcile_attempt_intent` and `execute_mount_attempt`, same file). The workspace's on row stays in the overlay. If the devserver stops before a request saves, its next start finds a row whose path the registry lacks, registers the folder again and mounts it. The design names the case: such a row keeps its place, and the next start registers and mounts the workspace again unless a request saved in between. The changelog entry lists the requests that save: an add, a turn-on, a turn-off, a delete or a token rotation.

How the registry row comes to be dropped there, by the review: by a registry edit that does not pass through this devserver's host, applied by the registry's reload watcher while the attempt has not yet opened the workspace. A removal that passes through the host forgets the overlay rows itself and is not affected. By the same review the next start then rebuilds the state the removal wiped.

Against v0.101.0, by the same review, at that tag: there the stand-down's own save dropped the row, so this case did not come back. v0.101.0 has the same exposure for a workspace that was off or failed when it was removed that way with no save after, since its start also registers the rows the registry lacks. In the review's words the range widens a window and opens no new kind.

## Why it matters

A workspace someone removed comes back. The removal was made by another chan process while a devserver was starting; the devserver stopped before any request saved; at its next start the folder is registered, mounted and served again, and nothing tells the person who removed it. It is narrow, a removal that does not go through the devserver, inside the time a restore attempt is pending, with no saving request before the next stop, and by the review it loses no data.

## Desired contract

Not chosen: the owner's ruling decides whether anything is built. The lead proposes the smallest repair that the review and the plan of the superseded start's repair name: where a restore's attempt reads that no registry row goes by its root, the devserver forgets that root's overlay rows with the overlay's own forget (`WorkspaceOverlay::forget`, `crates/chan-library/src/workspace_persist.rs`), a write of those rows alone that leaves the row of a skipped registration in place, as the host's removal does for a removal it runs; in both branches of the attempt, before its open and after it. What the owner would accept with it, as the plan names it: it is a removal by path after a stale read, so it can drop the on row of a path that was added again in between, until the next save; it ends the contract that a start writes nothing to the overlay, with that contract's pins and the design's sentence; and it needs a red of its own. The plan called it a few lines and did not stage it, for those reasons. The other choice is to keep the cost as written: the design and the changelog entry say it.

## Boundaries

`execute_mount_attempt` in `crates/chan-server/src/devserver.rs`, for an attempt the restore started, with its tests and the pins of the contract it changes; the design's sentence and the changelog entry. Not `register_restore_rows`, not what a request's attempt saves, not the row of a registration the restore skipped, and not the host's removal.

## Acceptance

Left open until the owner rules.

1. The ruling is recorded: built, or kept as a written cost.
2. If it is built: a workspace whose registry row is removed through the library alone while its restore attempt is pending has no overlay row once that attempt settles, and a second start over the same home neither registers nor mounts it; pinned red first, as the review lays the red out: a prepared restore, the registry row removed through the library alone, the attempt run, the overlay read, and a second state over the same home that registers the row again today.
3. If it is built: the row of a registration the restore skipped still keeps its place, and the design says what a start now writes to the overlay.

## Not established

That the state occurs outside a reading: nothing was run, no test of it was searched for and there is no report from use. How often a registry edit from outside lands inside a pending restore attempt. Whether a start that a request began leaves the same row: the changelog entry's sentence reads wider than the design's, which speaks of the restore's attempt; at `22c1e8fc8` an attempt superseded after its open saves nothing whoever began it, and what the request itself had saved before it was not read. The path through the registry's reload watcher, what a removal wipes and what the next start rebuilds: the review's reading at `ca179bba3`, not read again. v0.101.0's side: the review's reading at that tag. Whether the forget could meet a path added again in practice, the plan's first reason against it: read by the plan at `b7373fda2`, with no test. The review's and the plan's line numbers are at their own commits; the functions were found by name at `22c1e8fc8`.
