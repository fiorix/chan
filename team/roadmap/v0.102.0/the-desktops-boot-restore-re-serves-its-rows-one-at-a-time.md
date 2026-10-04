# The desktop's boot restore re-serves its rows one at a time

Status: raised for a decision on 2026-10-04 by the lead, from the reading that the owner's ruling on [a-hung-root-keeps-restored-tenants-at-503](a-hung-root-keeps-restored-tenants-at-503.md) asked for. Read in the code; not run. Ruled by the owner on 2026-10-04: accepted for a build in v0.102.0, a plan first. On 2026-10-04 the restore was built to admit four rows at once and the row moved to cut; a spinning restoring row is a cost.

## Owner ruling

On 2026-10-04 the owner accepted the row for a build in v0.102.0, a plan first: the desktop restores up to four rows at once in overlay order, each inside the open's existing bound, so one root that stops answering delays its own row and no other. The owner ruled on 2026-10-04 that the hung root's item is built for the devserver alone and that this is raised on its own.

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

## What shipped

Built on 2026-10-04 on the v0.102.0 integration branch and not on `main`, in a range the lead accepted on its report, its status files (every red at its own assertion at a committed sha, fourteen mutations restored by hash, the series in parallel and on one CPU with no red, the own gate green at the tip) and an independent review of its whole diff, which found nothing above medium, its two mediums repaired in the next range. This record was written that day from those.

The desktop's launch admits up to four of the rows left on at once, in their order, through a capped set of attempts that fills a free slot as soon as any attempt settles, and removes a row from the pending set only when its own attempt finishes; the per-root open bound of 60 seconds stays and there is no restore-wide bound (`BOOT_RESTORE_CONCURRENCY` and the restore loop in `desktop/src-tauri/src/main.rs`). Pinned red first: with two rows of which the first does not answer, the second is served before the first's bound ends; four held rows are admitted together and a fifth waits for a slot; a quit during a held restore and a row turned off while queued keep their rules. Five mutations restored by hash, and the stall tests at twenty runs in parallel and on one CPU with no red. `desktop/design.md` says what a launch does with a root that does not answer. Two rows that resolve to one workspace both enter the host's open, where its per-root lock hands the later one the existing mount, read in the code and not asserted live.

What the record of this item got wrong, read in the code: the loop was not serial to keep concurrent opens off the shared embedded host, since host mounts have taken a per-root lock since the v0.101.0 fix rounds; and the bound per root the plan asked for already existed as the open's 60-second bound. Cost, the lead's ruling: the launcher reads a queued row as off until its attempt starts; a row that spins while queued is a separate item if the owner wants it.
