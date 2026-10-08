# Tests that fail off the gate's path

Status: accepted for v0.104.0 by the owner's word of 2026-10-08; each test's cause is established before a choice between the test and the code, a test's own race is repaired in the test, and a product race is reported.

## What was seen

Four tests fail when run off the path the gate takes, each recorded in the v0.103.0 report or read on 2026-10-08. First, `web/packages/workspace-app/src/state/transfers.test.ts`, "pagehide freezes a pending progress write until pageshow permits persistence": fails on the host at line 213 (`setItem` called 0 times), reproduced on 2026-10-08 on the `chan-anim` tree, whose `src/state/` is identical to `main`; the host runs Node v26.7.0 and the repository pins 22; the v0.103.0 gates ran the web suites green in guests. The test spies on `Storage.prototype.setItem`; `web/packages/workspace-app/vitest.setup.ts` installs its own `MemoryStorage` whenever Node's built-in `localStorage` accessor yields no usable Storage (Node 24 and later), and that class is not `Storage.prototype`, so the spy sees no write there. That is a reading of the source, not a run under both Node versions. Second, `routes::terminal::tests::session_replay_bytes_after_restart_excludes_reset_and_modes` (`crates/chan-server/src/routes/terminal.rs` line 4647): failed once in the whole `chan-server` suite under 16 test threads on a 2-CPU quota, a stray `resize` frame from the first attach's 50 ms redraw wobble landing before the test's restart; ten of ten green at base and candidate under the module's tests at four threads; the race is the test's own, read at source in v0103. Third, two drawing-board helper waits in the web suite (`DashboardTab`, `paneKeepAliveMount`) and a one-second wait in `src/__tests__/excalidraw.ts` (its `vi.waitFor` at lines 56 and 80), each failing once per whole `make web-check` run under whole-suite load, a different one each time, and green alone. Fourth, `extensions::tests::a_closed_stdout_is_logged_with_its_cause_and_exit_status` (`crates/chan-server/src/extensions.rs` line 1262) cannot run under `RUST_TEST_THREADS=1`: it re-runs the test binary with the parent's environment, and a one-thread harness prints `test <name> ...` without a newline before the test runs, so the child's catalog line does not start a line; it passes at four threads.

## Desired contract

Each test passes on the gate's path and off it, or the item records why a path is out of the test's reach: the transfers test holds on Node 22 and on Node 26 (or the shim is changed so a spy on the installed Storage is what the test uses); the terminal restart test owns its order and does not sleep; the three web waits do not fail under whole-suite load at the guest's size, or the load dependence is recorded with a count that carries the load; the extensions test runs or refuses with a clear message under one thread.

## What to do

For the transfers test, establish the cause under both Node versions in a guest (the pin and 26) before choosing between the test and the shim: the repair is in the test if it spies on the wrong object, in the shim if the shim should install a `Storage`-derived store. For the terminal restart test, repair the test's own race in the test: wait for the frame the race drops, not for time. For the three web waits, read them at source, run the whole suite at the guest's size enough times to count, and repair a wait that can own its order; a wait that cannot is recorded with its count under load. For the extensions test, make the child's catalog line start a line, or have the test refuse under one thread with its reason. A product race found on the way is reported to the lead, not papered over.

## Boundaries

The four test files and `vitest.setup.ts`; no product change without a reported product race and a decision.

## Acceptance

1. `transfers.test.ts` green under Node 22 and Node 26 in a guest, with the cause written and the run logs.
2. The terminal restart test green twenty of twenty in the whole `chan-server` suite at 16 test threads on a 2-CPU quota, and its repair read as owning the order.
3. The three web waits: a count of whole `make web-check` runs at the guest's size before and after, with each failure named, or the recorded load dependence.
4. The extensions test under `RUST_TEST_THREADS=1`: passes, or refuses with its reason; the four-thread run unchanged.
5. The owning guest's fmt, clippy and whole crate suite for the Rust changes, and `make web-check` for the web changes, green at each commit.
