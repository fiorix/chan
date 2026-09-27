# Two tests of chan-library that capture warnings fail now and then

Status: raised for a decision on 2026-09-27 by the independent review of the launcher handlers' second half (`dev/v0101-team/reviews/review-Runtime-11.md` in the development tree, its answer to question 6), after one of the tests failed once in the lane's suite run and passed on a rerun (`dev/v0101-team/reports/report-Runtime-20.md`); the review read the cause in tracing-core's source. The tests read again at `b1ef073ae`; not reproduced on demand. Recommendation: accept for v0.101.0.

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
