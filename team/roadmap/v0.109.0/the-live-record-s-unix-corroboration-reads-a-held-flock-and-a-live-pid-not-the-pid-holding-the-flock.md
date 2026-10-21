# The live record's Unix corroboration reads a held flock and a live pid, not the pid holding the flock

Status: carried into v0.109.0 at the v0.108.0 GA on 2026-10-21, still raised for a decision.

Record before the release: raised at the v0.107.0 cut on 2026-10-17 by the lead from a finding outside that version's items, recorded in the round's decisions as the ledger's entry; written down with the repair's shape; owner by lane at the next version's launch.

## What was seen

On Unix, `live_record`'s corroboration of a devserver record reads two facts, that some process holds the record's flock and that the recorded pid is alive, and takes their conjunction as the recorded pid holding the flock. A pid reused by another process inside the window between the holder's exit and the record's read satisfies both facts while the holder is gone (the review seat's note at the restart item's design, 2026-10-16). Not established: that the window, of microseconds, is met in use. On Linux `/proc/locks` names a flock's holder by pid.

## Desired contract

A live record is corroborated by the pid that holds its lock where the platform can name it; elsewhere the record states what its two facts establish and what they do not.

## What to do

The corroboration reads which pid holds the flock where the platform can say (Linux: `/proc/locks` for the lock file's inode), and keeps the two-fact reading elsewhere with the design text saying so.

## Acceptance

1. A Linux reading through `/proc/locks` with a pin that constructs the reused-pid case (a holder exited, another process at its pid, the record read), red first.
2. The other platforms' two-fact reading stated in the design text with its window.
