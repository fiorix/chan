# A keychain failure freezes a connected gateway's roster without a trace

Status: raised during v0.101.0 on 2026-09-25 by the reading lane over the side-effect and error-handling lows (review line 6232 of the development ledger `dev/rust-review-lows.md`); not accepted. A source reading against `main` at `f063ddd45`.

## What was seen

The roster poll in `spawn_roster_poll` re-reads the gateway PAT on every tick. It answers both `Ok(None)` and any `Err` from `auth::load_gateway_pat` with a bare `continue` (`desktop/src-tauri/src/gateway.rs:1103-1110`). `load_gateway_pat` returns `Err` for any keyring error other than NoEntry and for a stored PAT that does not decode (`desktop/src-tauri/src/auth.rs:340-346`). Such a tick never reaches `apply_roster_fetch`, the only place that records `last_error`, counts consecutive failures and moves the runtime to Unreachable (`gateway.rs:386-395`). While the keychain keeps failing (a locked Secret Service collection, for example), the launcher shows the gateway as Connected with its last roster and no error, and nothing is logged.

## What to do

Route a PAT load `Err` in the poll loop into the same failure path as an upstream failure, with a warn log, so the runtime records `last_error` and reaches Unreachable after `ROSTER_UNREACHABLE_FAILURES` ticks. Decide separately whether `Ok(None)` while Connected should cascade like a 401. Red first: factor one poll tick so a test can run it with `auth::fail_gateway_pat_load_for_test` against a Connected runtime and assert that `last_error` is set and Unreachable is reached after the threshold.

## Boundaries

Leave the connect path alone: `connect_gateway`'s load-failure handling and the tests that pin it (`gateway_pat_load_failure_preserves_connected_and_pending_runtimes`, `gateway.rs:2045`) stay as they are. Moving the synchronous keyring calls off the async runtime is a separate ledger row (review 6337).
