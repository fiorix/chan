# The desktop's boot restore re-serves its rows one at a time

Status: raised for a decision on 2026-10-04 by the lead, from the reading that the owner's ruling on [a-hung-root-keeps-restored-tenants-at-503](a-hung-root-keeps-restored-tenants-at-503.md) asked for; the owner has not ruled on it. Read in the code; not run.

## Owner ruling

Not ruled. The owner ruled on 2026-10-04 that the hung root's item is built for the devserver alone and that this is raised on its own.

## What was seen

At a launch the desktop re-serves the overlay's on rows one after another (`restore_on_workspaces`, `desktop/src-tauri/src/main.rs`), each open under the same sixty-second mount bound (`desktop/src-tauri/src/embedded.rs`). A root that does not answer holds every row queued behind it for up to sixty seconds. The loop is serial on purpose, so that concurrent opens cannot race the shared embedded host. The desktop has no tenant gate, no READY and no fd store: what it lacks is the cap on hung roots that the devserver got in v0.101.0, not the devserver's split.

## Desired contract

A root that does not answer at a launch does not hold the desktop's other workspaces back for its whole bound. Or the serial restore stays, written as a cost.

## What to do

If accepted: a plan first, as the devserver's item had, of what the desktop's restore may do concurrently against the shared embedded host, and then a bound per root that lets the loop go on.

## Boundaries

The devserver's restore is another item's. No change to the mount bound itself.

## Acceptance

1. With two on rows of which the first does not answer, the second is served before the first's bound ends; pinned red first.
2. The desktop's document says what a launch does with a root that does not answer.
