# A WireGuard resolution test times out on the macOS runner at a tagged release

Status: accepted for v0.136.0 by the owner on 2026-11-27, after the v0.135.0 tagged Release run went red on it; not started. [v0.128.0's record](../../release/release-v0.128.0.md) called for this row after the same failure and it was never written.

## What is there now

`chan-wireguard`'s `tunnel::resolution_tests::a_hung_lookup_keeps_a_live_session_past_reject_after_time` (`crates/chan-wireguard/src/tunnel_resolution_tests.rs`) holds real time through the resolver's timeout (`RESOLVE_TIMEOUT` plus one second of exchanges), then waits for a fresh handshake twice through `until()`, whose bound is the fixture's 10 s `WAIT`. On a loaded GitHub macOS runner one of those waits ran out (`Result::unwrap()` on `Elapsed(())` at the `until()` helper), and `make ci-macos` failed with 131 of 132 tests passed in that suite.

It failed `macOS validation` in two tagged Release runs and nowhere else on record: v0.128.0's first attempt and v0.135.0's (run 46001144439, attempt 1, 2026-11-27). Each time the same commit had passed the `release.yml` dry run and every `ci.yml` run, and a rerun of the failed job was green and published. While that job is red, nothing publishes: the GitHub Release, `/dl`, Pages and every downstream target wait behind it.

## Desired contract

1. The test proves the same thing (a hung lookup keeps a live session past `REJECT_AFTER_TIME`, records the lookup timeout, and starts no second lookup while the first is in flight) without its verdict depending on how much wall time a shared runner gives it.
2. The fix is in the test, or in a seam the test drives, not a wider bound alone: where the test must hold real time, its wait after that hold is bounded by progress it can observe, not by a fixed 10 s.

## Acceptance

1. A reading that shows which of the two `until()` waits ran out under load (for example the test under `stress` or CPU limits in a guest), and the fixed test green under the same load across repeated runs.
2. The protocol assertions unchanged; a mutation that starts a second lookup or drops the live session still fails it.
