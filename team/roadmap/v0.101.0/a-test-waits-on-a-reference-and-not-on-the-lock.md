# A test of the host waits on a reference and not on the lock's release

Status: raised for a decision on 2026-09-28 by the lead, from main CI's run on the landing before this one: `make ci-linux` failed once on one test of chan-library, in the step that runs the suites under a linked temp directory, after the same job's first run of the suite had passed it (`dev/v0101-team/evidence/int/ci-36470112883/README.md` in the development tree, with the log's excerpt). Read at `a6834b1ee`; not reproduced. The job was run again once. Older than that landing: the test came with `5476a1411` on 2026-09-27 and was green in every run of main CI until this one. Recommendation, the lead's: accept for v0.101.0 with the fix round of a hung root's close and removal, which is ordered on the lane that holds the file. The owner has not ruled on it. The job was red again on its second run the same day, so the lead ordered the repair as an order of its own from `main`, to land alone and first, and it landed on 2026-09-28 (below).

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

## What shipped

Landed on 2026-09-28, the first pick of its landing; lines at `d440ab656`. The builder's report is `dev/v0101-team/reports/report-Runtime-37.md` in the development tree, to the order `dev/v0101-team/tasks/task-Lead-Runtime-35.md` and the ruling on the builder's question (`dev/v0101-team/followups/followup-Lead-Runtime-45.md`); the lead read the diff whole and verified it at the blob, with no independent review, since it changes a test module alone (`dev/v0101-team/journals/journal-Lead.md`, the entries of 2026-09-28 21:24Z and 21:35Z). No product line changed and the changelog has no entry: a user sees nothing of it.

- **The reading is confirmed by a run.** As the tests were, one run of `a_retry_answers_beside_an_abandoned_open_that_holds_the_workspace` in 400 failed with main CI's panic and message, and none of its sibling's; with a delay of 50 ms put at the start of the writer lock's drop, in a probe that was never committed, 795 runs of the two tests in 800 failed, each with `WorkspaceAlreadyOpen` at the test's own last removal (the report, "Step 1"). That puts the race before the drop's body: while the lock's record still names this process a removal answers `WorkspaceAlreadyOpen` (`WorkspaceLock::acquire` and `try_steal`, `crates/chan-workspace/src/lock.rs:227`, `:249-253`), and the drop removes the sidecar and truncates the record before the lock's file unlocks (`lock.rs:308-322`, the unlock at `:55-60`).
- **What the two tests wait on.** After the abandoned open's caller is gone and the removal or the retry beside it has answered, each test calls the product's own wait with the weak reference, the lock directory the registry names for the root and a deadline ten seconds away, and then asserts that the lock is free before it removes the workspace (`a_removal_answers_while_an_abandoned_open_owns_the_writer_lock`, `crates/chan-library/src/host.rs:6770-6782`; `a_retry_answers_beside_an_abandoned_open_that_holds_the_workspace`, `:6872-6884`). The wait polls every 2 ms until no strong reference is left and the lock is free (`wait_for_workspace_release`, `host.rs:4760-4780`, the loop at `:4773-4779`), the two facts a close's teardown waits for (`shutdown_with_budget`, `:647-651`); at its deadline it logs and returns (`:4774-4777`), so the assertion after it is what fails a missed deadline at the wait and not at the removal.
- **Only two waits were the fault.** The order counted four from a search; the other two, in `crates/chan-server/src/devserver.rs`, wait for the standalone Files tenant's watch manager and mutation worker to go, the lifetimes their test pins, in a tenant that takes no lock, and the lead ruled them unchanged (`dev/v0101-team/followups/followup-Runtime-Lead-26.md`; `followup-Lead-Runtime-45.md`, ruling 1). The other reads of a weak reference in `host.rs`'s tests are assertions or a fixture's wait with no lock asked for after it (`followup-Runtime-Lead-26.md`, at `f3006ec87`).

Shown, in the report: with the delay, each test green 200 runs as it is and 200 on one CPU under a linked temp directory, and the same without it; the devserver's test green 400 runs under the delay, the control that the delay does not reach it; a mutation that puts the old wait back reds the test it is in and no other, and one that takes the lock's half out of the product's wait reds both at the new assertion. The own gate was green, the suites under a linked temp directory and the Windows-target clippy among its steps.

**The product's callers,** read by the builder and not changed (the report, "Step 3"): `wait_for_workspace_release` has one caller, the teardown, which waits for both facts. No caller in chan-library or chan-server takes a reference's end alone for the lock's release, by a search whose pattern the report records with what it cannot find. Three places drop what they expect to be the last reference on their own thread with no wait: the abandoned open, whose next caller retries within the release budget, and the reset and the import routes, which is raised as [a-reset-counts-a-reference-another-can-upgrade](a-reset-counts-a-reference-another-can-upgrade.md).

**Not shown:** what makes a hosted runner likelier to lose the race than this box, where the rate as the tests were was one in 400 against two runs in three of main CI (the report, "Residuals").
