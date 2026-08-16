# The desktop liveness probe test is load-sensitive, and nobody has a mechanism for it

Status: ACCEPTED 2026-08-16 for v0.92.0. Carried out of `done/load-sensitive-tests-keep-recurring-after-three-sweeps`, which closed while this member was still red.

## What

`handoff::tests::desktop_liveness_probe_bounds_missing_and_stale_sockets` fails intermittently under a full-binary test run. Measured at **3 red in 15** full-binary runs on unmodified `main`, and 2 in 15 with an unrelated fix applied, so it is pre-existing by measurement rather than by assumption. It blocks a clean `cargo test --all-targets`, and it cost the v0.91.0 release a gate cycle on 2026-08-16.

## What the failure actually is

The failing assertion is `assert!(!stale_result)`: the probe reported a socket **live** when nothing was listening on it. The test binds a `UnixListener`, drops it, and expects `desktop_is_live_at` to say not-live.

`desktop_is_live_at` returns live only for `Ok(Ok(_))` -- a connect that succeeded inside a 250ms timeout. So the failure means a connect to a closed Unix socket **succeeded**, which should be `ECONNREFUSED` deterministically.

## Two things this rules out

- **It is not the timeout being too short.** Live requires the connect to succeed, so lengthening the window can only raise the failure rate. A deadline bump would look like a fix and quietly make it worse.
- **It is not a sleep.** The earlier sweep noted this test "contains no sleep at all", in a file that contributes six production-legitimate sleep sites elsewhere. There is no timing construct in it to tune.

12 consecutive full-binary runs on a quiet box were green on 2026-08-16, which certifies nothing: the playbook already records that 400 consecutive isolated runs were green on known-broken code.

## Why it is worth an item rather than an ignore

Its sibling in the same population, `close_forces_and_reaps_hup_immune_child`, looked equally environmental and turned out to have a real, findable cause: `wait_for_output` checked each event on its own while `try_recv` consumed it, so a marker split across two PTY reads had both halves discarded and could never match. Fixed in v0.91.0 by accumulating rather than by widening a bound. That is evidence this population is not uniformly "just load", and that a mechanism is worth looking for before a bound is touched.

Marking it `#[ignore]` is the wrong close: a green that means nothing is worse than a red that costs a re-gate.

## First task

Reproduce under the instrument the playbook mandates -- `scripts/e2e/one-cpu-test-series.sh`, which fails closed unless the host cgroup proves the one-CPU cap and reports a red-run rate -- and get a mechanism before changing the test. Candidates worth eliminating first: whether anything else in the binary can bind the same path, and whether the probe can observe a connect that the kernel later refuses.

## Acceptance

A measured red-run rate of zero under the same instrument that measured 3 in 15, with the cause stated. Not a green series.
