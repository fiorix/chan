# The unused-token test reads its counters before a wrongly started cut could run

Status: shipped in [v0.128.0](../../release/release-v0.128.0.md).

Record before the release: raised on 2026-11-10 by the review of v0.127.0's orphaned sign-in token fix before its GA; accepted for v0.128.0 by the owner the same day. Built on 2026-11-11 and merged into the release's integration branch; the section Built holds the evidence.

## What is there now

`DELETE /desktop/v1/token` (identity) revokes the presented desktop token. For a token something had presented (`GivenBack::Used`) the handler spawns the owner-wide cut (profile's reservation, the tunnel kill, the session drain) as a task that outlives the request; for one nothing presented (`GivenBack::Unused`) it cuts nothing (`gateway/crates/identity/src/http.rs`, the `give_back` match). The integration tests in `gateway/crates/identity/tests/desktop_authorize.rs` assert that an unused token cuts nothing by reading the cut's counters right after the 204. Because the cut runs in a spawned task, a change that spawned it for an unused token too would most likely still read `(0, 0, 0)` at that moment and pass. Nothing tests the answer of `ApiTokenService::give_back` directly (`GivenBack` appears only in `api_tokens.rs` and `http.rs`).

## Desired contract

1. A change that starts the cut for an unused token reds a test on every run.
2. `give_back` answers `Unused` for a fresh token and `Used` after a validation, pinned at the service.

## Boundaries

- Tests in the gateway workspace, which need `TEST_DATABASE_URL`; a seam in the handler only if a deterministic read needs one. No change to the route's behaviour.

## Acceptance

1. With the handler changed to spawn the cut on `Unused`, `cargo test --locked -p identity --test desktop_authorize` (the Cargo package is `identity`; `chan-gateway-identity` is the deb package) reds in ten runs of ten; restored, it is green.
2. The service test of `give_back` reds when its `last_used_at` condition is inverted.

## Built, 2026-11-11

The self-revoke integration tests run each request under a request-local tracing subscriber and wait for its last drop before reading the cut's counters (`with_cuts_settled` in `gateway/crates/identity/tests/desktop_authorize.rs`): the handler carries its subscriber into the detached cut with `with_current_subscriber`, so the drop follows both the request and every cut it spawned, even one not yet polled; no production seam, route change or dependency. A database-free test (`cut_observer_waits_for_detached_work`) proves the observer waits while a detached child is held and completes when it is released; the used-token positive control reads its counters through the same wrapper. Two service tests in `tests/tokens.rs` pin `give_back` at `ApiTokenService`: `Unused` for a fresh desktop token, `Used` after one validation. Identity's design document says how the tests observe the cut (`6235160c0`, merged as `ec6825c6c`). The mechanism depends on the cut inheriting the request's subscriber; a change to how the cut is spawned has to carry this test with it.

Checks, in a disposable PostgreSQL guest through the gateway test runner (`dev/v0128-team/evidence/Lead128/tokentest-trials/summary.md`): with the handler spawning the cut for an unused token too, `desktop_authorize` red ten of ten with `redeemed_pat_revokes_itself_and_keeps_its_row` (`(1, 1, 1)` for `(0, 0, 0)`) and `self_revoke_of_a_used_token_gets_the_owner_cut` (`1` for `0`) failing in every run; with the `last_used_at` condition inverted, `tokens` red ten of ten with both `give_back` tests failing with the answers reversed; restored, both targets green ten of ten (28 and 15 tests). The observer's own mutation (the wait dropped) red on the host. Gateway fmt, lint and the database-free tests green on the lane and at the merge.

Found beside the work, not changed here: `a_used_tokens_cut_outlives_a_request_dropped_after_the_give_back` (from v0.127.0) went red 4 times in 50 runs on the unmutated tree, each after its 10 s wait with `(0, 0, 0)`. The handler spawns the cut only after `give_back` resumes, so a request future dropped between the commit and the spawn loses the cut; the test drops its request when its own database read sees the revoke, which sometimes lands first. If the reading holds for a client that hangs up at that moment, production has the same window. Proposed to the owner as a row of its own; the test's expectation and the product's window are decided there.
