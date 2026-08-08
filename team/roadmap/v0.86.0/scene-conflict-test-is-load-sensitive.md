# A scene_sessions conflict test fails under host load

Status: REGISTERED 2026-08-08 from a full-gate observation during v0.86.0 preparation; scheduling within the round is the owner's call.

## What

`scene_sessions::tests::flush_cas_conflict_enters_conflicted_after_corroboration` in `chan-server` failed once during a full `cargo test --all-targets` run, panicking at `crates/chan-server/src/scene_sessions/mod.rs:3333` with `deferred fold-in is not a settled flush`. The run shared the host with four active build lanes.

## Evidence, 2026-08-08

- The failing run: 1046 passed, 1 failed, under concurrent lane builds.
- 20 of 20 isolated runs of the single test passed on the same tree.
- 5 of 5 full parallel `chan-server` lib runs passed once the host quieted.
- The full gate re-run on the quiet host was green end to end.

So the trigger is load, the mechanism is unestablished, and the test guards the doc-session/scene conflict machinery introduced in this release window (`bfec3b12`), which has not yet shipped. This is the same defect class the editor-widget item names: a red that fires on a run that ships trains the operator to discard the next genuine red.

The known prior scene flake (a 1-in-50 SIGABRT from an adopt race with a destructor double-panic) is a different mechanism and a different failure shape; do not merge the two without evidence.

## Contract

- The test passes deterministically under parallel execution on a loaded host, or the behaviour it asserts is covered by a test that does.
- The fix names the mechanism: whether the race is in the test's own sequencing or in the conflict machinery's settling logic. A race reachable by the test is presumed reachable by production until shown otherwise.
- Whatever replaces the assertion still fails when a CAS conflict does not enter the conflicted state after corroboration.

## Acceptance

- The named mechanism is demonstrated, not inferred: reproduce the failure at will (for example under deliberate CPU contention or a paused-clock schedule), then show the fix removes it under the same pressure.
- 20 consecutive isolated runs and 5 consecutive full parallel `chan-server` suite runs on a loaded host, green.
- Per the gate discipline, the repaired test is proven able to go red once, then restored.

## Rough size

Small to medium, mostly investigation; the fix is likely small once the race is named, and the class ruling from the timing-test work (virtual clocks over grace windows) may apply directly.
