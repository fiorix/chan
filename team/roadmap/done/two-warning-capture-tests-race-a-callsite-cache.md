# Two tests of chan-library that capture warnings fail now and then

Status: shipped in [v0.101.0](../../release/release-v0.101.0.md).

Record before the release: accepted for v0.101.0 by the owner on 2026-09-27; raised for a decision on 2026-09-27 by the independent review of the launcher handlers' second half (`dev/v0101-team/reviews/review-Runtime-11.md` in the development tree, its answer to question 6), after one of the tests failed once in the lane's suite run and passed on a rerun (`dev/v0101-team/reports/report-Runtime-20.md`); the review read the cause in tracing-core's source. The tests read again at `b1ef073ae`; not reproduced on demand.

## Owner ruling

Accepted on 2026-09-27 for v0.101.0, as the lead recommended. The owner accepted in one answer every recommendation the lead had put to them that day; for this item it was to accept it for this version, with no shape of the fix named.

## What was seen

The window registry's tests collect what the registry logs through `capture_logs`, which installs a subscriber of their own as the test thread's default with `tracing::subscriber::with_default` and records every event it sees (`crates/chan-library/src/windows.rs:931-968`). Two tests read the warning the registry logs for a row it cannot read: `an_unreadable_row_costs_only_that_row` expects one and `an_unreadable_row_is_named_by_id_or_by_index` two (`:1716-1741`, `:1746-1787`). Both warnings come from one `warn!` callsite (`:893-898`), which other tests of the same binary reach with no subscriber installed: `a_save_writes_an_unreadable_row_back` and `the_mint_treats_an_unreadable_rows_id_as_taken` open a store with such a row (`:1860-1897`, `:1901-1912`). In the lane's run the second capturing test failed with no warning captured, 0 where it expects 2, and the whole suite passed on a rerun of the same commit.

The review read the cause in tracing-core 0.1.36, the version the lock pins (`Cargo.lock:8127-8128`): while a scoped subscriber installed with `with_default` is the only dispatcher registered, a callsite registered for the first time takes its interest from the default of the thread that registers it, and a thread with no subscriber gives none, so the callsite is cached as never interesting, and its events are skipped on every thread until a later `with_default` rebuilds the cache. A test with no subscriber that reaches the `warn!` first while the other test's capture is installed therefore silences both of that test's warnings. That this caused the failed run is inferred: in it, one of the two tests with no subscriber finished on the line just before the failure. `an_unreadable_row_costs_only_that_row` has the same exposure.

The desktop's test capture already guards against this: it keeps a second dispatcher registered for as long as the capture lasts, so that a first registration asks every registered dispatcher, and rebuilds the interest cache after installing it (`desktop/src-tauri/src/devserver.rs:2576-2600`). Three helpers in chan-server capture with a scoped default as well (`crates/chan-server/src/devserver.rs:5494`, `crates/chan-server/src/extensions.rs:846`, `crates/chan-server/src/routes/team_config.rs:1321`); whether their callsites are exposed the same way was not read.

## Desired contract

A test that captures what its code logs sees every event the code logs, whatever else the test binary runs beside it.

## What to do

Give `capture_logs` the desktop helper's guard: a second dispatcher registered for the capture's lifetime and a rebuild of the interest cache once the capture is installed, or an equivalent, and read the three chan-server helpers for the same exposure. Red first, deterministically: register the `warn!` callsite from a thread with no subscriber while a capture is installed on another, and show the capture miss it.

## Boundaries

The test module of `crates/chan-library/src/windows.rs`, and the three chan-server helpers if they are exposed. No production change and no new dependency: chan-library's tests capture with a subscriber written in the test module.

## Acceptance

1. With the callsite first registered on another thread while a capture is installed, the capture sees both warnings, pinned by a test that forces that order.
2. The two capturing tests pass beside the tests that reach the callsite with no subscriber, in a loop of runs on one CPU.

## What shipped

Landed on 2026-09-28, in the test module of `crates/chan-library/src/windows.rs` alone, with no production change and no dependency; lines at `b39274a1a`. The builder's report is `dev/v0101-team/reports/report-Services-31.md` in the development tree, to the order `dev/v0101-team/tasks/task-Lead-Services-30.md`; the lead read the production diff of the range whole and verified it at the blob, not this test module's guard, and the range had no independent review (`dev/v0101-team/journals/journal-Lead.md`, the entry of 2026-09-28 12:03Z, "the three small fixes in and ready").

- **The guard.** `capture_logs` installs its subscriber as the thread's default, registers a second dispatcher that it holds for as long as the capture, and then rebuilds the interest cache, the desktop helper's guard (`windows.rs:964-978`, the comment on why at `:967-974`; the desktop's, `desktop/src-tauri/src/devserver.rs:2637-2638`). With two dispatchers registered, a callsite's first registration asks each of them for its interest rather than the default of the thread that registers it.
- **The three chan-server helpers read for the same exposure** were found not exposed and left as they are, by the report's reading of which tests reach their callsites with no subscriber: the devserver's (its warnings reached only under its capture), the extension runtime's (its one caller runs alone in a re-run of one test on a current-thread runtime) and the team config's (its one warning reached only under its capture). A later test that reaches one of those callsites with no capture would expose it (the report, "Which of the four helpers were exposed, and how I know").

Pinned: `a_capture_sees_a_callsite_another_thread_registered_first` re-runs the test binary on its half alone and requires the half to have run and passed (`windows.rs:1015-1032`); alone in that process, the half captures while a spawned thread with no subscriber reaches a `warn!` that only this pin logs, then reaches it on the capturing thread and expects the one line (`:983-1013`), so the pin arranges the first registration whatever else the binary runs. It was red first at the base, the capture seeing no line. In the report the mutation that removes the second dispatcher reds the pin alone, and the pin, its half and the four tests of an unreadable row, the two that capture and the two that reach the callsite with no subscriber (`:1781`, `:1811`, `:1925`, `:1966`), passed 200 runs as they are and 200 on one CPU, every run; the own gate was green.

**What no pin holds:** the rebuild of the interest cache. The mutation that removes it stays green, since in the pin's order the second dispatcher alone decides the interest; the rebuild covers a callsite registered between the capture's install and the second dispatcher's registration, an order no test forces, and it is kept because the ruling asked for the desktop helper's guard as it is (the report, "Mutations" and "Residuals"). The pin's half passes as an empty test in an ordinary run of the suite; the outer test's check that it ran is what makes a re-run that matched nothing fail.

No other item of this roadmap names the two capturing tests as failing now and then. The fix round of the relinked root's server half met one of them red once in its gate's run under a symlinked temp directory, before this landing, and green on its second run ([a-relinked-root-window-nests-outside-its-row](a-relinked-root-window-nests-outside-its-row.md); `dev/v0101-team/reports/report-Runtime-31.md`, "Own gate").
