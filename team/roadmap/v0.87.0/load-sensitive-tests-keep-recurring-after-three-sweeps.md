# Load-sensitive tests keep recurring because no sweep was ever exhaustive

Status: ACCEPTED 2026-08-09 into the v0.87.0 round on the owner's call, raised by @@Lead after the round turned up three load-sensitive tests it was not looking for. The class has been addressed three times before and has recurred every time.

## What

This round was chartered to fix one flaky test. It found three, none of them related to each other by surface:

- `scene_sessions::tests::flush_cas_conflict_enters_conflicted_after_corroboration`, the chartered one ([scene-conflict-test-is-load-sensitive](scene-conflict-test-is-load-sensitive.md)).
- `routes::terminal::api_restart_terminal_updates_chan_tab_name_env` ([terminal-restart-env-test-is-load-sensitive](terminal-restart-env-test-is-load-sensitive.md)).
- the `control_socket` takeover test racing a hardcoded 25ms sleep against its retry budget ([control-socket-takeover-test-races-a-fixed-sleep](control-socket-takeover-test-races-a-fixed-sleep.md)).

Three in one round, found incidentally, is a population being sampled rather than three coincidences.

**Amended later the same day: the count is five, and two of them are outside this item's boundary.** After this item was accepted, a lane running the reproduction rig against `main` turned up two more, in two further crates:

- `chan-workspace::watch::tests::filtered_registration::policy_change_during_retry_resets_stale_registrations` (crate `chan-workspace`).
- `chan::tests::workspace_search_retries_over_the_exact_tenant_when_direct_open_loses_the_lock`, `crates/chan/src/lib.rs:8796` (crate `chan`).

Both were found on a tree containing no lane changes, so both are pre-existing. Neither is in `crates/chan-server`, so neither falls inside the Boundaries below. That does not widen this item on its own -- the boundary is the owner's call -- but it is the evidence that decides it: the sampling that produced three from one crate produced two more the moment it was pointed anywhere else. The "other crates carry the same risk" line below is no longer a prediction.

**Amended again at lane close: the count is nine.** The scene lane's rig, run while gating, surfaced four more — three of them a cluster:

- `routes::terminal::tests::api_restart_terminal_respawns_same_session_command` (`terminal.rs:2372`)
- `routes::terminal::tests::api_create_terminal_spawns_command_and_returns_session` (`terminal.rs:2283`)
- `handoff::tests::desktop_liveness_probe_bounds_missing_and_stale_sockets` — **this one blocks a clean `cargo test --all-targets`**, measured at 3 red in 15 full-binary runs on unmodified `main` (and 2 in 15 with the scene fix applied, so it is pre-existing by measurement rather than assumption)
- plus confirmation of `chan::tests::workspace_search_retries_...`, independently

Three `routes::terminal` tests failing under the same pressure is a **cluster, not three flakes**: one shared cause in the terminal test harness is likelier than three independent races, and they are tracked as one item ([terminal-restart-env-test-is-load-sensitive](terminal-restart-env-test-is-load-sensitive.md)) rather than three siblings.

## The full inventory, enumerated so the count is checkable rather than asserted

Nine distinct tests, across five crates, all surfaced incidentally by a round chartered to fix one:

1. `scene_sessions::tests::flush_cas_conflict_enters_conflicted_after_corroboration` — the chartered one; **fixed this round**, and its mechanism turned out to be a production data-loss path ([mtime-cas-silently-overwrites-external-edits](mtime-cas-silently-overwrites-external-edits.md))
2. `routes::terminal::tests::api_restart_terminal_updates_chan_tab_name_env`
3. `routes::terminal::tests::api_restart_terminal_respawns_same_session_command`
4. `routes::terminal::tests::api_create_terminal_spawns_command_and_returns_session`
5. `control_socket::tests::stable_bind_absorbs_a_transient_lock_holder` — the only one with a mechanism named from source (a 25 ms sleep raced against a retry budget)
6. `chan-workspace::watch::tests::filtered_registration::policy_change_during_retry_resets_stale_registrations`
7. `chan::tests::workspace_search_retries_over_the_exact_tenant_when_direct_open_loses_the_lock` — the **deterministic** one, 3/3 under the rig
8. `handoff::tests::desktop_liveness_probe_bounds_missing_and_stale_sockets` — 3 red in 15 on unmodified `main`
9. `terminal_sessions::tests::backend_preference_flip_applies_to_direct_create_and_restart_only` (chan-library)

Items 2-4 are one cluster; 6, 7 and 9 fall outside this item's chan-server boundary.

**The rotating cast is itself the finding.** The suite reds somewhere *different* on almost every full run: three separate lanes gating the same tree drew three different reds. That is not one flaky test to route around — it is a population dense enough that **any single `cargo test --all-targets` run is unlikely to be green**, which is a fact about the project's gate rather than about any change under it.

## Three hand-applied workarounds, three surfaces, three releases, one unnamed mechanism

The strongest single argument that this class needs a sweep rather than a fourth round of point fixes. All three work around the same mtime collision, and none of them named it:

- `crates/chan-workspace/src/workspace.rs:7221` — `write_text_if_unchanged_detects_subsecond_conflict` spins in a tight loop until the mtime advances, capped at 200 ms, with a comment explaining why.
- `crates/chan-server/src/doc_sessions/mod.rs:2914` — a bare `std::thread::sleep(Duration::from_millis(20))` to force the token to move.
- v0.82.0 (`done/parallel-suite-flake-hygiene.md`) — `restamped_disk_adopt_...` clears `flushed_mtime_ns` so it cannot take the equal-mtime short circuit.

Three independent engineers hit one mechanism, each worked around it locally, and none registered it. The mechanism was finally named in this round, and it was a data-loss path the whole time.

## Independent corroboration, and a method warning for the sweep

**A fifth worktree, an operator not looking.** `flush_cas_conflict_enters_conflicted_after_corroboration`
was drawn red on a full run and green in isolation from a fifth worktree, on a branch touching
zero lines under `scene_sessions/`, during unrelated work. Together with the fourth-worktree
sighting, that is the rotating-cast claim holding up outside the lane that discovered it and
outside anyone hunting for it.

**Check the assertion, not the message about the assertion.** While gating an unrelated
change, a mutation probe that reverted that change's core decision left **both**
`control_socket` ack-wording tests green: they pin the message text, not the decision. Only
the delivered-PTY-bytes assertions caught it. So when this sweep decides whether a repaired
test is load-bearing, confirm the assertion touches the **behaviour** rather than a string
describing the behaviour. That is the 20-isolated-runs finding one level down: a test can be
perfectly deterministic and still certify nothing.

**On attributing a red to "an untouched crate".** `terminal_sessions::tests::backend_preference_flip_...`
(item 9) was registered from a run on unmodified `main`. At the time of the round's gate,
`crates/chan-library/` was untouched by the merged diff — but `submit-cannot-override-a-wrong-derivation`
later merged into the same module, so the short form stops being true. The attribution rests on
the record instead: the test was registered before that branch existed, and that change touches
submit encoding in the enqueue path rather than backend selection. Attribute by provenance and
mechanism, not by "nothing in this crate moved", which decays.

## The acceptance bar this class has been using does not work

The single most useful methodological result of the round, and it invalidates how this class has been certified before.

`scene-conflict-test-is-load-sensitive` asked for **20 consecutive isolated runs** as acceptance. The delivering lane measured what that bar actually proves:

> 400 consecutive isolated runs of each test are green on the **unfixed** code. The signal only exists in the parallel runs.

So the bar does not merely under-detect, it **certifies broken code with confidence, twenty times over** — and it is why that item's original 20-of-20 evidence looked reassuring and pointed away from the mechanism. An acceptance criterion that produces confident green on a known-broken tree is worse than none, because it manufactures the false confidence the next round inherits.

Anyone writing acceptance for a load-sensitive defect after this should be required to state **why their bar would have caught this one**. Isolated-run counts do not qualify. What discriminated here was parallel execution under a deliberate CPU cap, plus a mutation probe on the fix itself: reverting `advance_mtime` returned 3 red in 60, proving the repair load-bearing rather than coincidental.

**The most useful artifact this round produced for whoever does the audit is the deterministic reproducer.** It reproduces deterministically: 3 of 3 at `main` under `sdme set --cpus 1` with `--test-threads=32`, in under three seconds of test time per iteration. Every other instance here is a sighting; that one is an instrument. Start with it, because a reliable reproducer is what makes any of this fixable, and it is the difference between reading 47 sites and testing them.

A note on the rig, paid for once already: read the cap from the **host** at `/sys/fs/cgroup/machine.slice/sdme@<container>.service/cpu.max`. Reading `/sys/fs/cgroup/cpu.max` from inside the container reports `max 100000` and will tell you the cap is not applied when it is.

The project has already addressed this class three times: `done/wall-clock-test-flakiness.md`, `done/timing-test-virtual-clock.md` (which produced the standing ruling, virtual clocks over grace windows), and `done/parallel-suite-flake-hygiene.md` (v0.82.0).

## The evidence that the last sweep was not exhaustive

`done/parallel-suite-flake-hygiene.md:41` records, as an open follow-up:

> `crates/chan-server/src/devserver.rs:6041` is the remaining chan-server sleep-then-assert site and needs the same injected-instant treatment in its owning surface.

"The remaining" is a completeness claim. It is wrong, or it was narrower than it reads: `control_socket.rs` carries another one, found this round by a lane that was not looking for it. A grep for `sleep(Duration::from_` and `thread::sleep` across `crates/chan-server/src/` returns 31 call sites in 11 files, including `routes/terminal.rs`, `control_socket.rs`, and `doc_sessions/mod.rs`.

That count is a starting population, not a defect count. Many of those sites are production backoff and shutdown paths that legitimately sleep. Classifying them is the work; assuming them is the error the previous sweep made.

**Amended 2026-08-09: that grep is itself falsifiable, and the audit lane falsified it before classifying anything.** The pattern requires a bare `Duration::from_` immediately inside `sleep(`, so it cannot see a fully-qualified `sleep(std::time::Duration::from_millis(50))`, a named const or binding (`sleep(FLUSH_TICK)`, `sleep(grace)`), or `sleep_until`. The real population is:

```
git grep -nE -e '\bsleep(_until)?[[:space:]]*\(' \
    --and --not -e '///' --and --not -e 'Command::new' --and --not -e '"sleep' \
    -- 'crates/chan-server/src/*.rs'
```

**47 call sites in 18 files**, against `b9809f31`. Both numbers reproduce exactly; 16 real call sites are invisible to the original.

The consequential miss is `crates/chan-server/src/devserver.rs`, which scores **zero** under the original grep and has two real sites (`:5637`, `:5939`). Acceptance named `devserver.rs` explicitly while the population definition could not see it, so this item could have closed green with the one site it names by name never classified. That is the same failure this item was written to stop, one level up: not a false completeness claim in prose, but **a population definition that cannot see the site its own acceptance names**.

The site is still unrepaired. In this tree it is `wait_child_dead`, `devserver.rs:5627-5639` — a real-clock 10 s deadline loop polling `child.try_wait()` with `assert!(Instant::now() < deadline)` and a 50 ms sleep. Exactly the sleep-then-assert shape the v0.82.0 follow-up described.

Both greps are recorded here deliberately. The 31 is the worked example of why this item's contract forbids a completeness claim a grep can falsify — produced by the audit this item chartered, before it classified a single site.

## Why a fourth round of point fixes is the wrong instrument

Each prior pass fixed the sites it had in hand and left a completeness claim behind it that the next round falsified. Fixing these three the same way produces the same outcome, and the next round finds the fourth, fifth, and sixth. The class also has a standing ruling already, so the question is not what the right construction is; it is which sites have not had it applied.

There is a second reason, specific to this round. `scene-conflict-test-is-load-sensitive` was filed as a test defect and turned out to be a production data-loss path ([mtime-cas-silently-overwrites-external-edits](mtime-cas-silently-overwrites-external-edits.md)). A load-sensitive test is not reliably a test problem. Triaging the population tells us how many of these are hiding a real defect, which no point fix will.

## This item is two disjoint workstreams, not one

Amended 2026-08-09 by the audit lane, before it classified a site. The two halves of this
item's acceptance are **not** the same work, and conflating them would ship the exact false
completeness claim the item exists to prevent:

> This audit classifies sleep call sites. It is not a search for load-sensitive tests, and
> it did not find the ones this round is repairing: 2 of the 3 were found by running the
> suite under CPU pressure, not by reading code. A site being classified here says nothing
> about whether its test is load-sensitive, and a test being load-sensitive does not imply
> a site here.

The evidence is the whole inventory, not a sample. Of the **nine** load-sensitive tests enumerated below, **exactly one** is in the sleep population — `stable_bind_absorbs_a_transient_lock_holder`, which is also the only one with a mechanism named from source. The other eight carry no sleep to find.

`handoff.rs` makes the point inside a single file: it contributes **six** sites to the sleep population, every one production-legitimate, its test module starts at line 1390, and the load-sensitive test it handed this round (`desktop_liveness_probe_bounds_missing_and_stale_sockets`, 3 red in 15 on unmodified `main`) contains no sleep at all. One file, six audit sites and one flaky test, with no overlap between them.

The three originally sampled:

| named test | file | sleep calls in fn | in population? |
| --- | --- | --- | --- |
| `stable_bind_absorbs_a_transient_lock_holder` | `control_socket.rs:4922-4952` | 1 | **yes** |
| `api_restart_terminal_updates_chan_tab_name_env` | `routes/terminal.rs:2392-2435` | 0 | **no** |
| `flush_cas_conflict_enters_conflicted_after_corroboration` | `scene_sessions/mod.rs:3312-3363` | 0 | **no** |

Neither absentee contains `sleep`, `timeout`, `Instant::now`, `elapsed()`, or `yield_now`.
`api_restart_terminal_...` has no timing construct at all — its only "sleep" is the string
`sleep 1` inside a shell command handed to a spawned terminal, correctly excluded as a
string literal because it is shell, not Rust.

So the two tests this round was chartered to fix are load-sensitive through mechanisms that
carry **no timing keyword to grep for**. The instrument that found them was the suite run
under a 1-CPU cgroup cap with `--test-threads=32`, not a code read. Institutionalising that
instrument is a v0.88.0 argument and deliberately not attempted here.

**Workstream 1** classifies the 47 sleep sites. **Workstream 2** repairs the three named
tests. They overlap in exactly one site, `control_socket.rs:4940`. Neither completing
implies anything about the other.

## Method, including what was discarded

The split between production and test sites uses a **brace-depth scanner** that resolves
each site's real enclosing `#[cfg(test)]` scope, with its verdicts hand-verified.

A line-order heuristic — "is the site after a `#[cfg(test)]` line?" — was tried first and
**discarded as wrong**. `control_socket.rs` declares `#[cfg(test)] mod tenant_gate_tests`
at line 471 and then continues with thousands of lines of production code, so every
production sleep below it read as test. That heuristic misclassified eight production
backoff paths (`control_socket.rs:777`, `:800`, `:2133`, `:3446`; `indexer.rs:392`, `:397`,
`:413`, `:561`) as tests to repair — including a file-lock `try_lock` retry loop and the
rebuild coordinator's backoff. A sweep that damages production paths in the name of test
hygiene is worse than the disease. Recorded because the next auditor will reach for the
same shortcut.

## Contract

- Every timing-dependent site in `crates/chan-server` is classified, and the classification is recorded so the next round inherits a list rather than a completeness claim.
- A site that stays is justified in place: production sleeps say why they sleep, and test waits that cannot use a virtual clock say what bounds them.
- No completeness claim is written that a grep can falsify. Where the audit's coverage is bounded, the bound is stated with what it excludes.
- A site whose flakiness is hiding a production defect is registered as its own item at its own severity, following the scene precedent, rather than being repaired as a test.

## Acceptance

- A recorded classification of all **47** current sleep call sites in `crates/chan-server/src/` (see the amended population above), each marked production-legitimate, test-repaired, defect-registered, or **test-bounded-and-kept**. Both greps and the reason they differ are written into the item so either can be re-run.
- The fourth bucket, `test-bounded-and-kept`, is for a test wait on a real external thing that no paused clock can advance — a child process exiting, a real socket. Each member states what bounds it. This is continuity, not an escape hatch: `done/timing-test-virtual-clock.md:15` already made the same call, leaving `crates/chan/tests/devserver_resilience.rs` alone because "process-level budgets cannot virtualize because they wait on real child processes". `wait_child_dead` is the textbook member.
- The audit's coverage bound is stated with what it excludes. The method is lexical and line-based, so it does not see timing sites with no `sleep` at all (`tokio::time::timeout`, `interval()`, bare `Instant::now()` + `elapsed()` assertions), a `sleep(` split across lines, or a sleep reached through a test helper. `devserver.rs:5637` is in the population only because its loop happens to contain a sleep; the same deadline loop written without one would be invisible to both greps.
- The three named tests repaired under the `timing-test-virtual-clock` ruling, each proven able to go red **under the reproduction rig** — `sdme set --cpus 1` with `--test-threads=32`, cap verified from the host — with the red counted over N runs and the ratio stated, not asserted from a single observation. A mutate-run-observe probe in a quiet container is disqualified by this item's own acceptance-bar finding: a quiet container certifies broken code.
- The v0.82.0 open follow-up recorded as `devserver.rs:6041` is resolved or explicitly re-deferred with a reason. In this tree it is `devserver.rs:5627-5639` (`wait_child_dead`); the line number moved, the site did not.
- The audit re-runs clean at the end: **the widened grep above** — not the original 31-site one — returns no unclassified site. Naming it matters: read against the original, this line is satisfiable while `devserver.rs` stays unclassified, which is the exact defect the amended population section exists to fix.
- Any production defect the triage exposes is registered, not silently fixed inside this item.

## Boundaries

This is `crates/chan-server` only. The other crates carry the same risk and are not in this item's scope; if the audit's method proves out, extending it is a v0.88.0 item, and that decision belongs to whoever reads this list.

The audit runs against the merged state after the four delivery lanes land, not beside them. Three of the four hold files in this crate, and an audit that rewrites test sites under a live lane is how two lanes end up editing the same file.

## Rough size

Medium, and mostly triage rather than repair. The construction is already ruled; the work is reading all 47 sites and deciding, plus repairing the subset that needs it. The tail risk is that triage exposes further production defects, which is the point of doing it rather than an argument against.
