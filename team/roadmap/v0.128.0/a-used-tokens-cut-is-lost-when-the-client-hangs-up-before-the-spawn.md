# A used token's cut is lost when the client hangs up between the commit and the spawn

Status: raised on 2026-11-11 by the round's own checks and readings (the draft's origin is kept below); accepted for v0.128.0 by the owner the same day (survey 5). Not started.

Origin: proposed by the lead on 2026-11-11 from the tokentest row's guest trials; not accepted. Found by reading the handler and a flaky test, not yet reproduced against a client that hangs up.

## What is there now

`DELETE /desktop/v1/token` (identity, `gateway/crates/identity/src/http.rs`, the handler around line 1366) revokes the presented desktop token with `give_back(...).await?` and then, for a token something had presented (`GivenBack::Used`), spawns the owner-wide cut (profile's reservation, the tunnel kill, the session drain) as a detached task. The design says the cut runs detached so that a desktop that hangs up or times out cannot cancel it. That holds once the task is spawned, and the spawn comes after the await resumes: when the client's connection closes after the database has committed the revoke but before the handler future is polled again, the server drops the handler future and the cut is never spawned. The token then authenticates nothing, a tunnel on it ends at its next lease refresh, and a proxy session the first cut missed runs to its lifetime, which is the loss the design describes for a failed reservation.

The window shows in `a_used_tokens_cut_outlives_a_request_dropped_after_the_give_back` (`gateway/crates/identity/tests/desktop_authorize.rs`, from `e823c8ab5`): the test drops the request as soon as its own database read sees the token revoked, which sometimes lands before the handler is polled again; over 50 runs in a disposable PostgreSQL guest on 2026-11-11 it failed 4 times (`(0, 0, 0)` for `(1, 1, 1)`, each after the 10 s wait; `dev/v0128-team/evidence/Lead128/tokentest-trials/summary.md`).

## Desired contract

1. A used token's cut is started by the same step that commits its revoke, so no client behaviour between the commit and the cut can lose it: the commit and the spawn happen in a task the request only awaits, or the cut is enqueued durably before the route answers.
2. The dropped-request test waits for the cut's start, not for the commit, and goes red every run on the code before the fix.

## Boundaries

- The identity route and its test; profile's reservation and the first cut are unchanged.

## Acceptance

1. The test red ten of ten on the code before the fix (with a hook that drops the request right after the commit) and green ten of ten after, through the PostgreSQL guest runner.
2. The identity design's sentence on the cut says when it is started.
