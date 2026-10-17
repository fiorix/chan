# A control socket bound under a non-UTF-8 path leaves no socket, no report and no log line

Status: shipped in [v0.107.0](../../release/release-v0.107.0.md).

Record before the release: built on 2026-10-16 on the seat's branch; the section Bound endpoint warning 2026-10-16 holds the evidence; it closes at the GA as shipped.

Record before the release: raised by the review seat on 2026-10-13 in its read of the fallback socket notice's range (`reviews/review-Review106-sockfb-notice-range-1.md`, its N3, in the round's bus); written down the same day by the lead as a row of its own; read at source by the review seat and not constructed; no owner yet; not ordered in the v0.106.0 round

## What was seen

When a tenant's control socket binds at a path that is not valid UTF-8, the bind succeeds and the path cannot be exported: a terminal that server spawns gets neither `CHAN_CONTROL_SOCKET` nor `CHAN_CONTROL_SOCKET_ERROR`, as the pin `non_utf8_bound_path_has_no_failure_report` holds. `cs` in that terminal prints the generic sentence, which points to the server's start-up log, and the log holds no line about it, since the bind succeeded. The person has nothing to find. The case is older than the notice and pinned as it is.

Not established: that anyone has met it; a runtime directory under a non-UTF-8 path is unusual. Not constructed in a running server.

## Desired contract

A server that binds a control socket it cannot export says so once, where the generic sentence sends the reader.

## What to do

Read the bind path's export at source and construct the case in a guest, with a runtime directory whose name is not UTF-8. If it is as read, a warning at the bind that names the path lossily and the consequence would close it; the design goes to the review seat before code.

## Boundaries

The control socket's start-up path in `crates/chan-server/src/lib.rs` and the spawn environment in `crates/chan-library/src/terminal_sessions.rs`. Not changed: the owner rule, the path's length rule, the notice's sentences.

## Acceptance

1. The case constructed, with what the terminal holds, what `cs` prints and what the log holds.
2. If built: the log line pinned, red first.

## The pin's macOS arm 2026-10-14

`non_utf8_bound_path_has_no_failure_report` cannot construct its directory on macOS (`create_dir` is refused with `EILSEQ`), which the rc1 dry run's macOS job showed; the pin is now gated to Linux, so its coverage is Linux's alone; the repair and its platform statement are in [Two control-socket diagnostics tests assume a Linux filesystem](two-control-socket-diagnostics-tests-assume-a-linux-filesystem.md).

## Bound endpoint warning 2026-10-16

The Linux construction at d7492c5baaab98eda7dbe3655fc52fafcef01b1e established acceptance 1: an owner-only non-UTF-8 XDG_RUNTIME_DIR bound a reachable control socket, the server-spawned PTY received neither control variable, cs exited 1 with the generic start-up-log sentence, and the whole log had no control diagnostic. The UTF-8 control exported its socket and cs succeeded. Both servers stopped and their disposable roots were removed. The record is `dev/v0107-team/evidence/Runtime107/nonutf/`, with the construction and its reader controls both exit 0.

The successful control bind emits one WARN when its path cannot be exported, naming its Debug-form path with the invalid byte escaped and explaining the missing terminal control access. The bound handle, spawn environment and client sentences are unchanged. The server and shell design paragraphs describe the diagnostic. Review107's N1-N3 are folded: escaped bytes, a separate level assertion and the tighter message wording.

The extended Linux pin failed first on the unchanged server at the warning count, zero against one, with cargo exit 101. At the repair, all 10 control-socket diagnostic tests passed. Omitted, unconditional, duplicate and INFO-level warning mutants each compiled and failed once with cargo exit 101 at their intended count, UTF-8 absence or level assertion; the restored module passed all 10 tests again. Commands: `cargo test -p chan-server --lib control_socket_diagnostics_tests::non_utf8_bound_path_has_no_failure_report -- --exact --nocapture --test-threads=2` for the red, and `cargo test -p chan-server --lib control_socket_diagnostics_tests:: -- --nocapture --test-threads=2` for the green module; mutant commands and exact diffs are beside the logs. Evidence: `dev/v0107-team/evidence/Runtime107/nonutf-code/controls-evidence/`. The red driver's final display step exited 127 because rg was absent in the guest; its separate cargo status is 101, and its complete assertion was exported and read. That wrapper failure remains recorded in `red-driver.log` and `red-driver.status`.

The copied construction probe changes its output root and warning expectations, with its baseline and the diff retained. Its reader accepted both valid fixtures and rejected twelve corrupt observations, including a missing or second WARN, INFO instead of WARN and a WARN on the UTF-8 arm (exit 0; `nonutf-code/reader-controls.log`). The production-path construction at 037b8a6879caac47a8945b4f50f3355c105fa54c passed with the rebuilt binary identifying that commit: the non-UTF-8 arm had exactly one WARN with the escaped path and consequence, while the UTF-8 arm had none. Both sockets remained reachable; the non-UTF-8 terminal still had neither control variable and cs still printed the generic sentence. Both servers exited 0 and the disposable roots were removed. `nonutf-code/final-evidence/{nonutf-case,utf8-control}/` holds the complete logs and observations; `construction.log` and `construction.status` record exit 0. This establishes acceptance 1 at the repair, and the red-first pin establishes acceptance 2.

The committed own-gate at 037b8a6879caac47a8945b4f50f3355c105fa54c passed `cargo fmt --check`, `RUSTFLAGS=-Dwarnings cargo clippy -p chan-server --all-targets -- -D warnings`, and `CARGO_BUILD_JOBS=2 cargo test -p chan-server --all-targets -- --test-threads=2`: each exit 0, 2,256 unit tests passed and one existing child-probe test ignored; the echo-extension example target has no tests. The guest was clean before and after, with the same SHA. The final row/message update changes no source or design text. Commands, logs and statuses are in `nonutf-code/final-evidence/`, with the exact drivers alongside that directory and the environment in `dev/v0107-team/reports/environment-Runtime107.md`. These runs used 2 CPUs and 6 GiB in chan-v0107-runtime and recorded throttling and swap, with no OOM or OOM kill; they are contended checks, not timing readings. The chan-shell suite was not run for its design-only sentence. No macOS or Windows construction is claimed; the existing Linux-only fixture statement stands. The MCP sibling is a separate source reading for the lead and has no code change here.
