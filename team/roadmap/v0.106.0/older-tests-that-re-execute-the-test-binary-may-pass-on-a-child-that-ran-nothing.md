# Older tests that re-execute the test binary may pass on a child that ran nothing

Status: raised by the review seat on 2026-10-13 (`reviews/review-Review106-sockfb-notice-range-1.md`, its N5, in the round's bus); written down the same day by the lead as a row of its own; a count at source by the review seat, the parents not read one by one; no owner yet; not ordered in the v0.106.0 round

## What was seen

A test that re-executes its own test binary to run one case in a child process passes on the child's exit status alone unless it also checks that the child ran the case: a filter that matches no test exits 0 with `0 passed`. This round's three new parents require `test result: ok. 1 passed` and, by the review's finding on the host-release follow-up, are being made to require that the test was the caller's own. Outside those ranges, nine older parents in `chan-server` and `chan-library` re-execute the test binary, and five of their files hold no `passed` text at all (`lib.rs` twice, `extensions.rs`, `extract.rs`). They were not read one by one: some may require a marker of their own.

Not established: that any of the nine is vacuous.

## Desired contract

Every test that hands its body to a re-executed child fails when that child ran no test or another test.

## What to do

Read the nine parents and say, for each, what it requires of its child. Where one passes on the status alone, give it the guard the three new parents carry and show it red on a name no test has and on a sibling's name.

## Boundaries

Test code only. The helper of the host-release tests is the shape to reuse.

## Acceptance

1. A table of the nine parents with what each requires of its child, each row read at source.
2. Each parent found to pass on the status alone carries the guard, shown red on both constructed names.
