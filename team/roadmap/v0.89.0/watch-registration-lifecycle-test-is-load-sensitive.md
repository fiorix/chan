# Two watch-registration health assertions race the retry they injected, over one slot four tests clobber

Status: REGISTERED 2026-08-11, carried forward from the v0.88.0 round's draft `watch-registration-lifecycle-test-is-load-sensitive`, which recorded a single red observed during the scoped gate of [audit-the-workarounds-nobody-followed-up](../done/audit-the-workarounds-nobody-followed-up.md). The owner's ruling at acceptance widened it from the one failing assertion to three things: both `Degraded` assertions in `mod filtered_registration`, and the process-global injection slot they share with the rest of the module.

## What was observed

`chan_workspace::watch::tests::filtered_registration::watch_registration_lifecycle_recovers_and_joins` failed once under load:

```
assertion `left == right` failed
  left: Healthy
 right: Degraded
```

The assertion is `assert_eq!(initial.state, WatchHealthState::Degraded);` at `crates/chan-workspace/src/watch.rs:2167`, in `watch_registration_lifecycle_recovers_and_joins` (`watch.rs:2159`), inside `mod filtered_registration` (`watch.rs:1868`, gated `#[cfg(target_os = "linux")]` on the line above). The test injects one registration failure, starts a handle, and asserts the handle reports `Degraded`. Under load it read `Healthy`.

The draft carried this as `watch.rs:2157`. That was correct for the tree that produced the red and points at blank space between two tests today: `cc5b2f5b`, a comment-only commit, added exactly ten lines to the file and nothing else. This item therefore names the test and its enclosing module alongside every line number, and the same drift is why it is worth doing here.

## The rate is a floor, not an estimate

```
1 red / 12 full `cargo test -p chan-workspace` runs
  of which 8 were consecutive in a controlled loop, one container,
  no rebuild between them, immediately following the red
host load average 43.85 to 51.55, three peer build containers active
```

The crate was functionally identical throughout: the only later change was the comment commit above, and the crate was verified byte-identical across a rebase before two of the runs. The eight-run loop that followed the red was green throughout, and three further full-suite runs across two containers were green as well.

Twelve runs cannot distinguish 1-in-12 from 1-in-50, and every one of them ran under heavy but uncontrolled load from peer lanes rather than under a deliberate cap. It is stated as a rate rather than as an incident because a single failure is an anecdote and a rate is a decision. Attribution to the run's own change was ruled out at the time: that run carried a one-test change in `workspace::tests`, a different module, and a regression from it would fail deterministically rather than once in twelve.

## Two mechanisms produce this exact red, and the evidence cannot tell them apart

**The retry race.** `WatchHandle::start` (`watch.rs:994`) blocks on `initial_rx.recv()` (`watch.rs:1070`). Before releasing that handshake the supervisor registers roots (`watch.rs:342`), arms `retry_at` at `Instant::now() + WATCH_RETRY_INTERVAL` (`watch.rs:343`), and records the failure as `Degraded` through `record_registration_result` (called at `watch.rs:345`, state set at `watch.rs:499`), then sends (`watch.rs:346`). `WATCH_RETRY_INTERVAL` is 250ms (`watch.rs:297`). The injection is one-shot, decremented at `watch.rs:589`. So when the supervisor's timeout fires (`watch.rs:402`) the re-registration succeeds, `record_registration_result` sets `Healthy` (`watch.rs:488`), and a test thread descheduled past that 250ms deadline reads `Healthy` at 2167. That is the observed signature exactly. `registration_failures` is monotonic (`watch.rs:500`), which is consistent with the red naming only the state assertion and not the count asserted on the next line.

**The shared injection slot.** `INJECTED_REGISTRATION_FAILURE` (`watch.rs:551`) is one process-global `OnceLock<Mutex<Option<InjectedRegistrationFailure>>>`. `inject_registration_failures` overwrites it wholesale (`watch.rs:558`) and `clear_injected_registration_failure` nulls it (`watch.rs:570`). Five call sites in one lib-test binary write it, at `watch.rs:1976`, `2024`, `2053`, `2163` and `2187`, with clears at `1989`, `2037` and `2074`, spread across four `#[test]` functions that libtest runs in parallel by default. Nothing serializes them: there is no `serial_test` dependency, no `#[serial]` attribute, and nothing under `crates/`, `.github/` or `scripts/` pins `--test-threads`, the flag's only mention under `crates/` being a comment at `crates/chan-server/src/routes/preflight.rs:584`. It is named outside the code, in [`.agents/playbook.md`](../../../.agents/playbook.md) line 70 and in this item's own rig below, but as `--test-threads=32`, which oversubscribes the suite rather than serializing it. The `Mutex` serializes each individual access and nothing more; it is not held across the window between a test arming the slot and that test's supervisor reading it at `watch.rs:583`. A neighbour clearing or overwriting the slot inside that window leaves the injection disarmed, registration succeeds, and the assertion reads `Healthy` with no deschedule involved at all.

The two are indistinguishable from the red. Both put `left: Healthy` against `right: Degraded` on the same line. The draft named only the first and proposed anchoring on an observation rather than a sample, which repairs the race and leaves the slot exactly as it is. That is why the acceptance line below insisting the mechanism be named from source before a repair is chosen is load-bearing rather than procedural.

## The slot's other consequence: a clobber makes neighbours pass vacuously

A disarmed injection does not only redden the test that armed it. The consumer matches on path equality (`watch.rs:588`) and every test uses its own `TempDir`, so a stale injection from one test can never fire in the wrong place. The only cross-talk this global admits is disarming, and disarming turns a `Degraded` assertion red and a `Healthy` assertion green.

`gitignore_only_subtree_is_never_registered_or_dispatched` (`watch.rs:1971`) is the clearest case. It arms a failure on the gitignored `vendor/` directory (`watch.rs:1976`) and then asserts the handle is `Healthy` (`watch.rs:1990`) under the message `gitignored directory reached Linux registration`. The whole registration half of that test's claim is the injection: `Healthy` proves `vendor/` was never registered only because a registration would have hit the injected failure. If a neighbour cleared or overwrote the slot first, a `vendor/` that registered successfully also reads `Healthy`, so the test certifies nothing while staying green. Its dispatch half, the stray-event check at `watch.rs:2006`, does not depend on the injection and is unaffected. `unrelated_gitignore_negation_does_not_register_configured_subtree` (`watch.rs:2018`) has the same shape at `watch.rs:2038`, but carries a second, injection-independent check (`assert!(!handle.is_registered(&target))`, `watch.rs:2043`) that a clobber cannot silence.

So this site can fail in two directions and only one of them is visible. One is a red nobody can attribute; the other is a scope test that keeps passing after it has stopped testing anything.

## Why this is its own item

Not because it is new surface. It is not. `chan-workspace::watch::tests::filtered_registration::policy_change_during_retry_resets_stale_registrations` is already item 6 of the nine-item inventory in [load-sensitive-tests-keep-recurring-after-three-sweeps](../done/load-sensitive-tests-keep-recurring-after-three-sweeps.md) (line 42), surfaced there by a lane running the reproduction rig against a tree carrying no lane changes (line 19), and left unrepaired because that item's boundaries scope it to `crates/chan-server` only (line 207). That sibling sits in this same module and carries the same racing assertion, `assert_eq!(handle.health().state, WatchHealthState::Degraded)` at `watch.rs:2057`, after the same one-shot injection at `watch.rs:2053`.

What is true is that no **active** item owns this site. The closed inventory registered the sibling and deliberately put it out of scope, and the three timing repairs v0.88.0 actually shipped were all `chan-server`: a `collect_until` that never drained `replay`, and a control-socket sleep replaced by an observable release ([release-v0.88.0](../../release/release-v0.88.0.md)). `git log` on `crates/chan-workspace/src/watch.rs` shows the comment commit as the most recent touch and no test change at all.

It also belongs with the class rather than alone. The project has answered load-sensitive tests three times with three different answers, and [timing-test-virtual-clock](../done/timing-test-virtual-clock.md) is the ruling any repair here starts from rather than becoming a fourth. Its follow-up section records this crate hitting the process-global shape once already: bounded-reader tests asserting a process-global count whose "serializing mutex excluded only each other", so a neighbour's live producer read as this test's un-reaped one. The repair there was to key the global on the caller's own path, which is the same shape the injection slot needs.

## Contract

- Both `Degraded` assertions in `mod filtered_registration` assert the degradation they injected without depending on winning a race against the supervisor's own 250ms retry.
- A test's injected registration failure cannot be disarmed by another test in the same binary, so a `Healthy` assertion that rests on an injection cannot pass because the injection was gone.
- The repair does not consist of widening a wait. That is the answer this class keeps being given and keeps coming back from.

## Boundaries

- **In scope: `crates/chan-workspace/src/watch.rs`, and nothing else in the tree.** Inside it, `mod filtered_registration` (`watch.rs:1868`) in full, plus the injection machinery its tests share: the `InjectedRegistrationFailure` struct (`watch.rs:545`), the `INJECTED_REGISTRATION_FAILURE` slot (`watch.rs:551`), `inject_registration_failures` (`watch.rs:557`), `clear_injected_registration_failure` (`watch.rs:569`), and the consumer block inside `watch_registration` (`watch.rs:581-595`).
- **The sibling assertion site is in scope; the rest of the crate's timing sites are not.** `policy_change_during_retry_resets_stale_registrations` (`watch.rs:2047`) and its `Degraded` assertion at `watch.rs:2057` are this item's, which is what the acceptance line refusing a one-line repair means. Nothing else in `chan-workspace` is: not the bounded-reader sites [timing-test-virtual-clock](../done/timing-test-virtual-clock.md) already repaired, and not the other eight entries of the closed nine-item inventory, all of which sit outside this module.
- **Open, and it needs a ruling before the slot repair is chosen: whether the injection may become per-handle in production code.** The slot itself is `#[cfg(test)]` (`watch.rs:545`, `watch.rs:551`), but its consumer is not: the read at `watch.rs:583` sits in a `#[cfg(test)]` block inside `watch_registration` (`watch.rs:576`), which is compiled on every build. Making the injection per-handle therefore means carrying it from the supervisor's two registration calls (`watch.rs:342` and `watch.rs:464`) through `register_all_roots` (`watch.rs:599`), `register_available_roots` (`watch.rs:612`), both `register_root` definitions (`watch.rs:674` on Linux, `watch.rs:804` elsewhere) and `register_one` (`watch.rs:777`) down to the call at `watch.rs:788`: six production signatures, even if the parameter they carry stays cfg-gated. The code settles what that costs, not whether it is allowed, so the ruling is the owner's rather than this item's. The alternative needs no seam: the consumer already matches on path equality (`watch.rs:588`) and every test owns its own `TempDir`, so a slot keyed by path, armed and cleared per key rather than wholesale, changes `#[cfg(test)]` code only. Either way the discriminating experiment in the acceptance below asks for the per-handle form at least temporarily; the ruling is about whether it lands.

  **The ruling, 2026-08-11: @@Alex ruled for the path-keyed test-only slot.** The cfg-gated parameter does not go through the six production signatures. The per-handle form remains permitted as the temporary discriminating experiment this item's acceptance asks for, and does not land.
- **Out of scope: the rig script.** The rig has no checked-in form. It exists as prose in the playbook and, each round, in a gitignored tree that goes away with the round, so every timing item so far has paid to rebuild it and none of them can point at what the previous one actually ran. Committing it as a script under `scripts/` would end that. This item does not own that work: it should be registered on its own or picked up by whichever timing item lands first.

## Acceptance, which has to name its own evidence problem

An isolated-run count certifies nothing here. The project has already measured what that bar proves: 400 consecutive isolated runs were green on known-broken code, and the signal existed only under parallel execution ([`.agents/playbook.md`](../../../.agents/playbook.md) line 70, from the measurement at line 91 of the closed inventory). A green isolated series is not evidence, and neither is a green series under whatever ambient load a build host happens to carry.

- The mechanism is named from source before a repair is chosen. The discriminating experiment: run the module under the rig with the injecting tests forced apart, either onto separate binaries or with the injection made per-handle rather than process-global. If the red survives that, it is the 250ms retry race; if it vanishes, it was the slot.
- The rig is the playbook's, inherited rather than reinvented: `sdme set --cpus 1` plus `--test-threads=32`, with the cap read from the **host** at `/sys/fs/cgroup/machine.slice/sdme@<container>.service/cpu.max`. Reading it inside the container reports `max 100000` and misleads.
- Each repaired assertion is shown red once by construction and restored, at `watch.rs:2167` and at `watch.rs:2057`. One repair that leaves the other line alone does not close this.
- The vacuous direction is proven, not only the red one: with its injection removed, `gitignore_only_subtree_is_never_registered_or_dispatched` must fail rather than pass. Static reading says it passes today under that mutation, because a registration that succeeds and a registration that never happens both leave the state `Healthy`. That inference has not been run and the mutation is the test of it.

## Not established

- Which of the two mechanisms fired. Both are provable from source as possible; neither has been shown to be the one, and no repair should be chosen before that is settled.
- The true rate. One red in twelve is a floor measured under uncontrolled load, and no rate has been taken under the cap.
- Whether a clobber has ever actually happened. The window is provable from source; nothing here observed one, and the vacuous-pass consequence is therefore a demonstrated possibility rather than a demonstrated event.
- Any rate for the sibling at `watch.rs:2057`. The closed inventory records it as surfaced by the rig on an unmodified tree but attaches no count to it, unlike items 7 and 8 in that same list.

## Rough size

Small to medium. The assertion repair alone is genuinely small: `registration_failures` is already monotonic (`watch.rs:500`) and `WatchEvent::provider_error` is already dispatched to the test's own receiver (`watch.rs:506`), so an observation-anchored assertion needs no production seam. What pushes it past small is everything the acceptance above demands around it: discriminating the two mechanisms, taking a rate under the host-verified 1-CPU cap, showing each repaired assertion red by construction, and doing the work at `watch.rs:2057` and on the shared slot rather than at the one line that happened to go red.
