# The pins of a case-only rename run in no gate

Status: raised for a decision on 2026-09-30 and held under v0.102.0, since the owner closed v0.101.0's intake on 2026-09-29; the owner has not ruled on this item. Found by a reading of the integration gate's log and of the build files on 2026-09-29 (`dev/v0101-team/machine-move/lead38-recon-4-build-deps.md` in the development tree, "Gate residual 3: casefold fixtures" and T6), which says that recurring coverage is new scope that needs a row. The log and the files were read; no test was run for the reading.

## What was seen

Lines as that reading gives them, at `4c4ada0a1`.

Four tests pin what [a-case-only-rename-leaves-a-phantom-row](../v0.101.0/a-case-only-rename-leaves-a-phantom-row.md) fixed: `a_case_only_rename_leaves_one_served_row` (`crates/chan-server/src/indexer.rs:2478`), `a_case_only_rename_through_lone_events_leaves_the_listed_name` (`crates/chan-workspace/src/indexer.rs:733`), and `reconcile_forgets_a_spelling_its_directory_no_longer_lists` and `reconcile_forgets_rows_under_a_directory_spelling_no_longer_listed` (`crates/chan-workspace/src/workspace.rs:11638`, `:11687`). Each needs a directory that folds case, named by `CHAN_CASEFOLD_TEST_DIR`. Without one each prints `skipped, CHAN_CASEFOLD_TEST_DIR names no case-folding directory`, returns early and is counted as passed: the integration gate's log has the four lines, so four of its passes asserted nothing. Nothing sets the variable: it is in those Rust files and nowhere in `Makefile`, `.github/`, `scripts/`, `docs/` or `.agents/`. The skip is by design, since that item says that the tests run on a casefold tmpfs in a container and not in the Linux gate.

Every recorded run that set the directory is in the fix lane's own evidence, the last at that lane's commit `8f344a566`, which is not an object in this repository, with three chan-workspace tests and one chan-server test passing on a tmpfs mounted with `casefold=utf8-12.1.0`; its date is not established. Since `e56c79d00` of 2026-09-25, a commit of the fix on `main`, thirteen commits touched the three files that the tests exercise, twelve on `main` and one test commit on the integration branch. The reading infers that none of them has been exercised on a case-folding directory, so a regression of a case-only rename, which a user on the default volume of macOS or of Windows would meet, would pass every gate and every CI job.

One run of the four tests on a case-folding directory before rc0 is the team's work under the landed item's own text and needs no decision. This item is the coverage that recurs.

Not established: whether the machine the team works on has a case-folding mount; and whether the macOS runner's volume folds case, which the reading names as the cheap place for recurring coverage and did not establish.

## Desired contract

The pins of a case-only rename run on a case-folding directory in a gate or a CI job that runs at every landing, and a run that skips them says so in its verdict.

## What to do

Decide whether recurring coverage is wanted, and where. The reading names one place and did not establish it: the macOS CI job pointing the variable at a temporary directory on the runner's volume.

## Boundaries

The four tests and the variable they read, `Makefile` and `.github/`, by the reading's citations. The fix itself is landed, in [a-case-only-rename-leaves-a-phantom-row](../v0.101.0/a-case-only-rename-leaves-a-phantom-row.md).

## Acceptance

1. The owner's decision is recorded: recurring coverage in a named gate or job, or the one run before each release with the reason.
2. If it is built: a gate or a CI job sets the variable to a directory that folds case and the four tests assert there, shown by a run whose log has no skip line for them.
