# The desktop liveness probe test is load-sensitive, and nobody has a mechanism for it

Status: DEFERRED from v0.92.0 to v0.93.0 during roadmap close on 2026-08-18. No mechanism or repair landed in v0.92.0; the connect-only probe and the stale-socket assertion remain unchanged. Carried out of `done/load-sensitive-tests-keep-recurring-after-three-sweeps`, which closed while this member was still red.

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

## Round evidence, v0.93.0

The mechanism is fork-time descriptor inheritance. A Rust `UnixListener` is `SOCK_CLOEXEC`, but close-on-exec acts at exec rather than at fork, so a concurrent `Command::spawn` anywhere in the test binary leaves the forked child temporarily owning the listening file description. The connect the test expects to be refused succeeds honestly, because the socket is still alive. This was established outside the flaky test, with a standalone probe that holds a spawned child in `pre_exec` and `strace -ff` recording `connect(...)=0` while the child is held and `ECONNREFUSED` after `execve`.

That retires the item's open questions. The timeout is not the cause, because the connect genuinely succeeds; lengthening the deadline can only widen the interval in which a live-but-doomed socket is reachable; load sensitivity follows from contention widening the fork-to-exec window; and a green series on a quiet box reflects the window closing rather than the defect leaving.

The repair creates the stale socket in an exact-filtered self-exec of the test binary. The helper binds only after exec and exits before the probe, so the parent never owns the listener and a concurrent fork from the parent has nothing to inherit. This eliminates the race rather than narrowing it, and preserves what the test asserts: an existing socket node with nothing listening reports not-live, which is the real crash-residue case.

Acceptance, restated during the round because the original was unattainable. The instrument named in this item could only ever select `chan-workspace`, so the 3-in-15 rate it cites was never measured by it; the instrument is now package-parameterised. On a host-verified one-CPU cap, 15 runs of 1,145 chan-server tests at 32 threads with `nr_throttled_delta=5557`, the target passed **15 out of 15**, so this rig does not reproduce the recorded failure at that sample size and no natural before-and-after rate comparison exists.

The acceptance was therefore replaced with a deterministic one, which is stronger than the rate it replaces. Under a forced schedule, the old construction reported the dropped socket live in **20 of 20** runs and returned `ECONNREFUSED` in all 20 after the child exec'd. The repaired construction returned `ECONNREFUSED` in **20 of 20** while an unrelated child was held pre-exec, which is the adversarial condition rather than a quiet one. That is evidence by observation as well as by construction.

The mechanism reaches production and is bounded there. `handoff::start_listener` holds a `UnixListener` for process lifetime while the desktop spawns pty shells, extension commands and `xdg-open`, so a desktop dying inside a child's fork-to-exec window leaves its socket connectable. `desktop_is_live` returning true biases `decide_open_route`, but `try_handoff` independently requires a valid desktop response, so a child-held listener with no accept loop times out into `Outcome::NoDesktop` and the caller falls back. The cost is a wrong initial route and up to the three-second handoff timeout, never a false success. This is recorded as a candidate for a later version and was not changed here.

Two further load-sensitive tests were measured in the same population, on the same verified cap: `state::test_support::reset_contention_does_not_starve_single_worker_runtime` at 3 red in 15, and `routes::preferences::tests::broadcast_config_changed_refreshes_direct_terminal_spawns` at 1 in 15. These are the first measured rates recorded for this population and are candidates for a later version.

The repair adds a process spawn to a binary whose defect is that any fork can transiently inherit a listener, so it was checked for making the population worse. On an isolated revision carrying only this patch on top of the same control revision, and under comparable load (`nr_throttled_delta` 5787 against the control's 5557), the series measured 1 red in 15 against the control's 4 in 15. The sole red was the same contention test the control also failed, the target passed 15 out of 15, and `devserver_handoff::tests::stable_listener_reclaims_a_dead_owners_node` passed 15 out of 15, which agrees with the source reading that its reclaim path unlinks and rebinds before connecting and so cannot observe an inherited listener. At this sample size the difference between 1 and 4 supports no material worsening and is not evidence of an improvement.
