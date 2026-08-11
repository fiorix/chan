# The 1-CPU reproduction rig has no checked-in form, so every timing item rebuilds it and none can say what the last one ran

Status: REGISTERED 2026-08-11, accepted by the owner as v0.89.0 scope. Drafted during the round and held rather than self-registered, because the round had already been widened once by ruling and the owner was unreachable at the time. The `watch-registration` item names this work and puts it out of its own scope, saying it "should be registered on its own or picked up by whichever timing item lands first"; this is the registration it asks for, and that item has since been repaired using exactly the uncaptured instrument described below.

## What

The instrument that reproduces load-sensitive test failures exists only as prose in [`.agents/playbook.md`](../../.agents/playbook.md) and, each round, as commands in a gitignored coordination tree that is deleted when the round closes. There is no script, no `Makefile` target and no committed record of what any previous round actually ran.

The consequence is not that the rig is hard to rebuild. It is that **results taken on it are not comparable across rounds**, and the items themselves say so. The v0.89.0 watch item's acceptance requires the rig be "inherited rather than reinvented" and states that a result taken any other way "is not comparable to one that was". That requirement cannot be verified against an instrument with no checked-in form.

## Evidence: the same rig has now been built at least three times

- v0.87.0's `load-sensitive-tests-keep-recurring-after-three-sweeps` established the 1-CPU reproducer and recorded it in a round tree that no longer exists.
- v0.88.0's timing lane rebuilt it for the `control-socket` and `terminal-restart-env` repairs, measuring 3 red in 30 and 5 of 8 cluster-red on calibrated arms.
- v0.89.0's @@Gate rebuilt it again for the watch item: a container from `chan-ann-ubuntu` with `--storage btrfs --disk 40G --cpus 1`, source bind-mounted read-only, `cargo test -p chan-workspace filtered_registration -- --test-threads=32`, cap verified from the host at `/sys/fs/cgroup/machine.slice/sdme@<container>.service/cpu.max`.
- The same round's indexer item needs it a fourth time and its acceptance points at the same playbook line.

Each reconstruction is a day or so of work that produces an instrument nobody can later audit.

## The property that must be enforced rather than documented

**Reading the cap from inside the container reports `max 100000` and misleads.** The playbook says so and every lane that has used the rig has had to know it out of band. @@Gate's v0.89.0 run confirmed it again: the host read `100000 100000` while the container read `max 100000`.

A rig that silently runs uncapped is worse than no rig, because it produces a green series that certifies nothing. The project has already measured exactly this failure: **400 consecutive isolated runs were green on known-broken code.** A green series from an uncapped rig is indistinguishable from that, and it is the shape that retires a real defect as fixed.

So the rig must verify its own cap from the host and **fail loudly when it cannot**, rather than documenting that the operator should check. This is the same standing rule the round applies elsewhere: a check that cannot run its case must fail or say it skipped, and must never return the success value.

## Contract

- The rig is a checked-in script with a named entry point, taking the test selector, the run count and the thread count.
- It verifies the CPU cap from the host cgroup and refuses to run, or reports `SKIPPED` with the reason, when it cannot confirm the cap. It never runs uncapped and reports a rate.
- It emits a **rate** with its denominator, not a verdict. "3 red / 20" is a decision; "it failed once" is an anecdote.
- It records the instrument alongside the result: container name, backend, cap as read from the host, thread count, and the revision under test, so a later round can compare rather than guess.
- It is a diagnostic instrument, not a gate step.

## Boundaries

- **Not part of `make pre-push`.** It is slow by construction, needs root and a container, and a gate step that takes tens of minutes gets disabled rather than fixed. It joins the `scripts/e2e/` family of judgment-run suites.
- **It changes no test.** Repairs belong to the timing items that use it.
- It does not attempt to classify timing sites. That is the indexer item's separate work.
- It does not need to support macOS or Windows. The rig is a Linux cgroup instrument.

## Acceptance

- The rig reproduces a known-red at a stated rate on a known-broken revision, and the same selector on the repaired revision at a stated rate, with N stated for both. The watch item's 14/20 and 19/20 against 0/20 are available as the calibration case.
- **The rig is shown failing closed when the cap is absent.** Run it against an uncapped container and confirm it refuses or reports skipped, rather than running and returning a green series. This is the acceptance line the whole draft exists for; a rig that cannot demonstrate this has reintroduced the 400-green-runs trap with a script attached.
- A second operator reproduces a recorded result from the checked-in form alone, without asking the first operator what they ran. That is the actual deliverable, and nothing else tests it.
- `.agents/playbook.md`'s prose points at the script rather than describing the commands, so the two cannot drift.

## Rough size

Small to medium. The commands are known and have been written three times; the work is making the cap verification fail closed, choosing the record format for the result, and proving the refusal path. The risk is scope creep into a general test-harness abstraction, which is not wanted: this wraps one known invocation shape.

## Costed by the lane that built it, 2026-08-11

Registered with a cost estimate rather than without one, because the estimate is what the acceptance decision turned on. It comes from the lane that built and ran this rig during this round, which is the only party in a position to say what capturing it costs.

**About half a day, and roughly 100 lines plus validation and mutation tests.**

The warm numbers are cheap: about 38 seconds for an N=20 watch series, and 34 to 35 seconds per full `chan-server` lib-suite run, which is roughly 12 minutes for N=20. **The cold numbers are the argument**: 9m24s for a clean clippy and 18m43s for a first clean test build. That cold cost is what every timing item pays again, from scratch, because the rig has no checked-in form, and it is paid by a different person each time with no way to confirm they reproduced the same instrument.

The second-operator acceptance cell below adds coordination cost rather than implementation complexity.

That this round's watch repair was measured on a rig built for the third or fourth time, and that its before-and-after rates are only comparable because one person held both ends of it, is the concrete case for capturing it.

## Ownership

`scripts/` is @@Tooling's surface and that lane is drained, so this is assignable on acceptance. The rig itself was built and exercised by the @@Gate lane, whose measurements are the worked example any implementation should be able to reproduce.
