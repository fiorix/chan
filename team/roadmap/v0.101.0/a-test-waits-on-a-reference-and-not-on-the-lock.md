# A test of the host waits on a reference and not on the lock's release

Status: raised for a decision on 2026-09-28 by the lead, from main CI's run on the landing before this one: `make ci-linux` failed once on one test of chan-library, in the step that runs the suites under a linked temp directory, after the same job's first run of the suite had passed it (`dev/v0101-team/evidence/int/ci-36470112883/README.md` in the development tree, with the log's excerpt). Read at `a6834b1ee`; not reproduced. The job was run again once. Older than that landing: the test came with `5476a1411` on 2026-09-27 and was green in every run of main CI until this one. Recommendation, the lead's: accept for v0.101.0 with the fix round of a hung root's close and removal, which is ordered on the lane that holds the file.

## What was seen

- **The failure.** `host::tests::a_retry_answers_beside_an_abandoned_open_that_holds_the_workspace` panicked at its last call: the removal that must complete once the abandoned open has let go answered `WorkspaceAlreadyOpen` (`crates/chan-library/src/host.rs:6873-6877`).
- **What the test waits on.** Before that call it polls, each millisecond and for at most ten seconds, until the weak reference to the abandoned open's workspace no longer upgrades (`host.rs:6866-6872`).
- **What that does not tell.** A weak reference stops upgrading when the last strong reference is gone, which is before the value's fields are dropped (the standard library's rule for `Arc`). The workspace holds its writer lock as a field (`_lock`, `crates/chan-workspace/src/workspace.rs:865`), and the lock's drop removes its sidecar and truncates its record before its file closes and the lock is released (`crates/chan-workspace/src/lock.rs:308-322`).

So the wait can end while the workspace is still being dropped on the thread of the abandoned open, and a removal that arrives in that time meets the lock. Inferred from the code read; how long that time is on a hosted runner was not measured.

## Desired contract

A test that needs a workspace's lock to be free waits on the lock's release, or asks as a caller does that is told to retry; no test of the host takes a reference's end for the lock's.

## What to do

Confirm the reading by a run (the test looped as it is and pinned to one CPU, under a linked temp directory, and once with a delay put into the lock's drop in a probe). Make the test wait on a fact that holds only once the lock is free, without a sleep that guesses. List every other test of the file that waits on a weak reference before it asks for the lock, and repair each. If the product has a caller that takes a reference's end for the lock's, say so and raise it.

## Boundaries

`crates/chan-library/src/host.rs`, its tests. The lock's drop in `crates/chan-workspace` is unchanged.

## Acceptance

1. The test passes 200 runs as it is and 200 pinned to one CPU, under a linked temp directory, with a delay in the lock's drop that the probe adds.
2. Every test of the file with the same wait is listed and repaired.
