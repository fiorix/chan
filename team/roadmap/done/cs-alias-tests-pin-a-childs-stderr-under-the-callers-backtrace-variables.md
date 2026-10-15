# cs alias tests pin a child's stderr under the caller's backtrace variables

Status: shipped in [v0.106.0](../../release/release-v0.106.0.md).

Record before the release: raised by the lead on 2026-10-14 from the rc0 dry runs (the `release.yml` run 38548292109's two validation jobs and the `ci.yml` run 38548294534's Linux and macOS jobs, red on the same ten tests by their failed-step logs) and proved in the integration guest the same day; written down the same day as a row of its own; owner the runtime seat; a test defect of the two control-socket items' tests (`sockln`, `sockfb`), the product unchanged.

## What was seen

Ten of the twenty-one integration tests in `crates/chan/tests/cs_alias.rs` fail in GitHub's jobs and pass in every guest gate of the round: `cs_bind_report_preserves_missing_window_precedence`, `cs_bind_report_preserves_outside_caller_precedence`, `cs_bind_report_quotes_controls_and_edited_text`, `cs_explicit_destination_reads_the_bind_report`, `cs_socket_only_action_reads_the_bind_report`, `cs_socket_only_action_reads_the_chan_marker`, `cs_tab_destination_reads_the_chan_marker`, `cs_unusable_bind_reports_keep_the_generic_sentence`, `cs_window_action_reads_the_bind_report` and `cs_window_action_reads_the_chan_marker`. Each runs the `cs` symlink as a child outside a usable chan terminal and asserts that its whole stderr equals one `Error: ...` line (`assert_socket_error`, line 337, written on 2026-10-13 in `211f8dcef` for the fallback-directory item's seven bind-report tests, and `assert_chan_terminal_missing_socket`, line 73, written the same day in `91cb4eeb4` for the over-long-path item's three `cs_*_reads_the_chan_marker` tests). In the jobs the stderr carries that line followed by a blank line and `Stack backtrace:` with anyhow's frames. The jobs' `cargo test --all-targets` step is fail-fast, so it ended at `cs_alias`, the `chan` crate's third test binary after the library's and the binary's unit tests; on Linux the rest of the suite is covered by the round's guest gates, and on macOS the rest of this version's suite has not run in the round, which had no `ci.yml` run before rc0.

Read at source: `actions-rust-lang/setup-rust-toolchain@v1` writes `RUST_BACKTRACE=short` into the job environment when it is unset, and every later step of the validation jobs shows it (the failed-step logs of all four red jobs show `RUST_BACKTRACE: short` in the step's environment, and the two validation jobs' full logs, saved beside them, show the action writing it); the tests' `command()` helper runs the child with `env_clear().envs(child_env::scrubbed_process_env())`, and the scrubbed environment removes the `CHAN_*` namespace alone (`crates/chan/src/test_env/child_env.rs`), so the parent's `RUST_BACKTRACE` reaches the child; `cs` returns its errors through anyhow, whose report renders the captured backtrace after the message whenever `RUST_BACKTRACE` or `RUST_LIB_BACKTRACE` enables capture, which is the designed behaviour of every `cs` error. Proved in the integration guest at the rc0 commit `e7dbeeb57`: `cargo test -p chan --test cs_alias` with `RUST_BACKTRACE=short` in the test process's environment ends `11 passed; 10 failed` with the same ten names, and without the variable `21 passed` (`evidence/Lead106/int/cs-alias-backtrace-control/` in the round's bus). No guest gate of the round sets the variable, and the round had no GitHub run before rc0 by its Brief, so every candidate gate passed these tests with a one-line stderr. The `make ci-windows` job of the same `ci.yml` run passed.

Established by the repair's audit and the review's scan beside a positive control: no other test under `crates/chan/tests/` compares a child's whole stderr with `assert_eq!`; `serve_devserver_refusal.rs` compares its child's last line and pins `RUST_LIB_BACKTRACE=0`.

## Desired contract

A test that pins a child's exact stderr pins the child's environment that shapes it, so the test's verdict is the same in a guest, on a workstation and in a GitHub job.

## What to do

In the `command()` helper of `crates/chan/tests/cs_alias.rs`, remove `RUST_BACKTRACE` and `RUST_LIB_BACKTRACE` from the child's environment after the scrubbed environment is applied, with one line saying why. Red first: the ten tests at the base with `RUST_BACKTRACE=short` in the test process's environment; then green at the tip with the variable, without it and with `RUST_LIB_BACKTRACE` alone; then the crate's whole suite under the variable.

## Boundaries

The one helper only; `child_env::scrubbed_process_env` keeps its one concern (the `CHAN_*` namespace) and the product is not touched. A test that wants the backtrace in a child's stderr sets the variable itself.

## Acceptance

1. At the base, `cargo test -p chan --test cs_alias` under `RUST_BACKTRACE=short` fails the ten named tests at the two assert sites with the backtrace in `left`; at the tip the same command passes all twenty-one, as does the run without the variable.
2. `cargo fmt --check`, `cargo clippy -p chan --all-targets -- -D warnings` and the whole `chan` crate suite green at the tip under `RUST_BACKTRACE=short`.
3. The next GitHub run of `make ci-linux` and `make ci-macos` on a commit holding the repair passes its whole test step on both platforms, that run being the round's first full macOS test run of this version.

## Built, reviewed and landed 2026-10-14

The runtime seat's repair on its branch (`a888daf0b` over `693c482e3`, `test(shell): pin backtrace settings in alias test children`): one hunk in the `command()` helper, which now removes `RUST_BACKTRACE` and `RUST_LIB_BACKTRACE` after the scrubbed environment, with one comment; nothing else in the file or the product. In its guest at two CPUs and 6 GiB, bounded: the base under `RUST_BACKTRACE=short` rc 101, 11 passed and the ten named tests failed at the two assert sites with the backtrace in `left`; at the tip 21 passed under the variable, with neither variable and with `RUST_LIB_BACKTRACE=1` alone; `cargo fmt --check` and `cargo clippy -p chan --all-targets -- -D warnings` clean; the whole `chan` crate under the variable 423 passed, 0 failed, the one owner-run tunnel test ignored as always. Its audit of `crates/chan/tests/`: no other whole-stderr `assert_eq!` on a child; `serve_devserver_refusal.rs` compares its child's last line and pins `RUST_LIB_BACKTRACE=0`. Records: `tasks/task-Runtime106-Lead106-37.md`, `evidence/Runtime106/csbt-35/` and `reports/csbt-35-stderr-audit-Runtime106.md` in the round's bus.

The review seat accepted the range (`reviews/review-Review106-csbt-range-1.md`) with four arms of its own at the second candidate's checkout, the base file under and without the variable and the tip's file under `RUST_BACKTRACE=short` and under `full` with `RUST_LIB_BACKTRACE=1` (red at the base under the variable with the ten names, green otherwise; the runtime seat's arms cover the tip without the variables), and read that every `cs` child in the file goes through the helper (one `Command::new`; the async test's conversion keeps the environment) and that its scan beside the positive control finds no other such assertion. Its one fact for the record: the jobs' test step is fail-fast and ended at this binary, the crate's third, so the macOS remainder of this version's suite has not run in the round; the next GitHub run on a commit holding the repair is that run.

Landed on the integration branch as `bbe17ffe1` by the rehearsed pick (patch-id equal, the landed tree equal to the rehearsal's) and gated in the integration guest at that commit: `cargo fmt --check` rc 0, `cargo clippy --locked -p chan --all-targets -- -D warnings` rc 0, `cs_alias` alone under `RUST_BACKTRACE=short` 21 passed, the whole `chan` crate under the variable with `--no-fail-fast` 13 binaries, 423 passed, 0 failed, 1 ignored, the checkout clean before and after, 11:22:59Z to 11:27:30Z (`evidence/Lead106/int/gate-csbt/` in the round's bus). The product is unchanged, so the rc0 artifacts stand; acceptance 3 waits for the next GitHub run, on rc1 or the GA branch by the owner's word.

## Acceptance 3 met 2026-10-15

The `ci.yml` run 38632918671 on `backup/v0.106/wip` at `671e49126` (21:24Z) passed its whole test step on Linux and on macOS (macOS: 44 binaries, 5,310 passed, 0 failed), the macOS step no longer stopping at the two fixtures the csmac row repaired (`evidence/Lead106/rc/ci-backup-runs/` in the round's bus).
