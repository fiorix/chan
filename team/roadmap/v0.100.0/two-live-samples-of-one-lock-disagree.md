# A test compares two live samples of one lock probe, and they can disagree

Status: raised for v0.100.0 from the v0.99.0 fix loop's follow-ups. The test has failed once in a gate job and passed on the same code elsewhere; the mechanism is a source reading against `main` at `d3de0180b`.

## What was seen

`scoped_local_rows_match_the_workspaces_route` (`crates/chan-server/src/routes/library.rs`) asks the list route for its rows, then calls `scoped_local_workspaces` a second time and asserts the two serialize equal. Each row's status comes from a live lock probe that fails closed to `locked` when the lock file cannot be opened, so under descriptor pressure the two samples can disagree; the test failed once this way during v0.99.0 (exit 101 at `2726e9910`), the first failure in 84 filed logs, and passed on the same code elsewhere. The product side of the same probe is that a launcher row can read `locked` for one refresh under descriptor pressure, which fails in the safe direction but is not distinguishable from a real foreign lock.

## Desired contract

The equality test compares one recorded snapshot rather than two live samples, and the probe reports "cannot tell" apart from "locked" so a transient open failure does not label a row as held by another process.

## Boundaries

`crates/chan-server/src/routes/library.rs` (the test and `scoped_local_workspaces`), `crates/chan-library/src/host.rs` (`root_has_foreign_lock`), `crates/chan-workspace/src/lock.rs` (`is_locked_by_foreign_holder` and its fail-closed arm), and whatever row status the launcher draws from it.

## Acceptance

1. A `ulimit -n` sweep on the chan-server test binary reproduces the failure before the change and not after.
2. The test asserts against one snapshot and still guards that the fixture is a mixed-status list.
3. A probe that cannot open the lock file is distinguishable from a foreign lock at the row level, pinned by a test.
4. The launcher's rendering of the new state is decided and pinned, even if it renders as today.
