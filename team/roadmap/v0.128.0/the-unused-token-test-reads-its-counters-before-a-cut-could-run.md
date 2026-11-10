# The unused-token test reads its counters before a wrongly started cut could run

Status: raised on 2026-11-10 by the review of v0.127.0's orphaned sign-in token fix before its GA; accepted for v0.128.0 by the owner the same day. Not started.

## What is there now

`DELETE /desktop/v1/token` (identity) revokes the presented desktop token. For a token something had presented (`GivenBack::Used`) the handler spawns the owner-wide cut (profile's reservation, the tunnel kill, the session drain) as a task that outlives the request; for one nothing presented (`GivenBack::Unused`) it cuts nothing (`gateway/crates/identity/src/http.rs`, the `give_back` match). The integration tests in `gateway/crates/identity/tests/desktop_authorize.rs` assert that an unused token cuts nothing by reading the cut's counters right after the 204. Because the cut runs in a spawned task, a change that spawned it for an unused token too would most likely still read `(0, 0, 0)` at that moment and pass. Nothing tests the answer of `ApiTokenService::give_back` directly (`GivenBack` appears only in `api_tokens.rs` and `http.rs`).

## Desired contract

1. A change that starts the cut for an unused token reds a test on every run.
2. `give_back` answers `Unused` for a fresh token and `Used` after a validation, pinned at the service.

## Boundaries

- Tests in the gateway workspace, which need `TEST_DATABASE_URL`; a seam in the handler only if a deterministic read needs one. No change to the route's behaviour.

## Acceptance

1. With the handler changed to spawn the cut on `Unused`, `cargo test --locked -p chan-gateway-identity --test desktop_authorize` reds in ten runs of ten; restored, it is green.
2. The service test of `give_back` reds when its `last_used_at` condition is inverted.
