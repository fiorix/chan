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

## The nine parents read, three guards built, reviewed and landed; one note ordered 2026-10-13

Acceptance 1 (the runtime seat, `dev/v0106-team/tasks/task-Runtime106-Lead106-32.md` in the round's bus and the reading before it): of the nine parents that re-execute the test binary, three accepted a child on its exit status and its own "1 passed" summary alone, so a selector naming a passing sibling, or a child that ran nothing of its caller, passed them: the standalone release's wait support (`host_release_test_support.rs`), the control socket diagnostics (`control_socket_diagnostics_tests.rs`) and the inherited control socket report (`control_socket_env_tests.rs` in the library). Acceptance 2: each of the three now takes its own libtest thread name before its first await and, after the status and one-passed guards, requires a whole stdout line `test <caller> ... ok`; built by the runtime seat as `767677021` on the integration branch (37 lines, three test files, no product source), shown red on both constructed names in each parent (the selector naming a passing sibling fails at the new assertion; a nonexistent name still fails first at the older one-test guard), and a control with the standalone release's timeout removed red at its own assertion. Beside it, `f1de403b4` corrects one paragraph in each of the server's and the shell's design documents: a bound endpoint supplies only `CHAN_CONTROL_SOCKET` when its path is UTF-8, and a non-UTF-8 bound path or an absent endpoint supplies neither variable, which is `ControlSocketEnv::add_to_spawn_env` arm for arm; the sentence that recorded which platforms a round had run is removed.

The review seat's read (`reviews/review-Review106-reexec-guard-1.md`): it can land. The guard red with one change each in the three parents (status 101 at the new assertion and nowhere earlier), green with `--test-threads=1` on the parent's command line, with `RUST_TEST_THREADS=1` exported and under `taskset -c 0`, since the caller's thread carries the test's name in every way of running the suite it tried; the five files blob-equal on the integration branch. One note: two of the three children start with `--exact <name> --nocapture` and the parent's environment, where the third also passes `--test-threads=2`; a libtest that runs serially prints the result line in two halves around the test, so a child that writes one line to stdout splits it and the guard reads a passing child as one that did not run its caller (constructed with one `println!` under `RUST_TEST_THREADS=1`). Ruled by the lead: `--test-threads=2` in those two argument lists, one test-only commit by the runtime seat, no new row. Not established: the mechanism on Windows and macOS (libtest's thread naming and line format there); the six parents found to hold their child already were read, not changed.
