# Indexer timing sites have no lexical signature, so the audit that classified them could not see the wait that fired

Closed: shipped in [v0.89.0](../../release/release-v0.89.0.md).


Status: REGISTERED 2026-08-11, carved out of the v0.88.0 draft `tests-encode-implicit-scheduling-assumptions`, which is not being accepted. The owner took this one finding into v0.89.0 scope and left the draft's project-wide rule, its sizing and its frontend half in `dev/`; the reasons are in the last section. One part of this item, the reopening of three sites a shipped item classified and kept, needs the owner's explicit ruling before a lane starts on it.

## What

[load-sensitive-tests-keep-recurring-after-three-sweeps](../done/load-sensitive-tests-keep-recurring-after-three-sweeps.md) classified 49 `sleep` call sites across 18 files in `crates/chan-server/src/` (`:231`), and stated its own coverage bound in its acceptance (`:199`): the method is lexical and line based, so it does not see "timing sites with no `sleep` at all (`tokio::time::timeout`, `interval()`, bare `Instant::now()` + `elapsed()` assertions)", a `sleep(` split across lines, or a sleep reached through a test helper.

The bound is stated accurately and it is larger than a footnote. Whether a wait can report a starved host as a defect has nothing to do with whether the token `sleep` appears inside it, so bounding the population by that token selects on a property unrelated to the failure being hunted. In `crates/chan-server/src/indexer.rs` alone the exclusion costs seven sites, and the wait that expired in this round's reds is one of them.

The closed item paid this price once already and recorded it. At `:301` it says of `routes::terminal::tests::api_restart_terminal_updates_chan_tab_name_env`, one of the three tests it was chartered to repair, "**not repaired**, and not reachable by this audit: it carries no sleep and is absent from the population". A method that cannot reach its own named subject is the finding rather than an edge case, and nothing in the classification generalises that sentence.

## The sites, counted at `f9c2878c`

`indexer.rs` holds 7 `tokio::time::timeout` call sites, all riding `CONVERGENCE_BUDGET` (`indexer.rs:1211`, 30 s, with the intent comment at `:1204-1210`): `:1255`, `:1299`, `:1774`, `:1790`, `:1854`, `:1876`, `:1885`. Five of the seven carry a 10 ms poll in their body, and those five sleeps (`:1261`, `:1304`, `:1779`, `:1796`, `:1891`) are exactly the five `indexer.rs` test rows in the closed classification. Two carry no sleep, so neither the wait nor anything about it entered the population. The ruling that created this family, [timing-test-virtual-clock](../done/timing-test-virtual-clock.md), describes "all five waits on the coordinator's rebuild pipeline across both recovery tests" at `:13`; the tree now has seven, the extra two being the `await_ready` helper at `:1255` and the gitignore convergence at `:1299`, the latter recorded in the classification as having arrived with the gitignore item. A population grows after it is written down, which is itself a reason to re-derive one rather than inherit it.

Bounded, and with no sleep in the body:

- `trigger_during_active_rebuild_forces_one_follow_up_generation` (`indexer.rs:1812`), first wait: `tokio::time::timeout(CONVERGENCE_BUDGET, started_rx.recv())` at `:1854`, `.unwrap()` at `:1856`. This is the site that fired, and it is the wait with the least work in front of it: one rebuild pass reporting that it started.
- The same test's second wait at `:1876`, `.expect("mid-rebuild generation was swallowed")` at `:1878`, also a bare `started_rx.recv()`.
- The same test's `assert!(released_at.elapsed() >= cooldown, ...)` at `:1881`, against `released_at = Instant::now()` at `:1870`. This is the third excluded category verbatim, a bare `Instant::now()` plus `elapsed()` assertion. It is a floor rather than a ceiling, so load can only make it more likely to pass; it is listed for population completeness, not as a starvation risk.

No timing construct of any kind, and each observed red under a 1-CPU cap:

- `idle_indexer_does_not_keep_workspace_handle_alive` (`indexer.rs:2136`): `assert_eq!(Arc::strong_count(&workspace), 1)` at `:2146`, immediately after the `super::Indexer::spawn(workspace.clone(), ...)` call at `:2139-2145`, and again at `:2149` after `drop(indexer)`. The count returns to 1 only once the spawned task has run far enough to downgrade its clone, and nothing in the test waits for that. It is a wait spelled as an equality assertion.
- `reconcile_idle_reads_live_stats_when_workspace_present` (`indexer.rs:2042`): a synchronous `#[test]` that calls `apply_watch_change` at `:2045` and then asserts `indexed_docs >= 1` from live stats at `:2068`, with no synchronisation between the write and the read.
- `spawning_the_indexer_claims_a_pass_parked_before_it` (`indexer.rs:1389`): `assert!(workspace.recovery_is_unowned(), ...)` at `:1396`. The test does have a bound, but it is reached through the `await_ready` helper (`indexer.rs:1254`), which is the fourth thing the audit says it cannot see, and the assertion that went red is not that bound.
- `rapid_modify_burst_indexes_latest_file_body` (`indexer.rs:2247`): the second `apply_watch_change` call at `:2260`, inside the `assert_eq!(..., ApplyOutcome::Indexed)` spanning `:2259-2262`, after five rewrites of the same file.

**Why each of the four constructless sites fails is unverified and must not be written as fact.** For `:2146` a missing happens-before follows from reading the test, and that is a reading rather than a measurement. For `:2068` a candidate is an asynchronous searcher reload on commit, which nobody has instrumented. For `:1396` and `:2260` there is no hypothesis at all; they are in the list because they went red on the rig and contain nothing a duration could be raised on. What is established by reading, and is all the argument needs, is that none of the four is repairable by changing a number.

## The reds, and where they landed relative to the population

Recorded in the v0.88.0 coordination tree, which is not part of the checkout, so the counts are restated here rather than linked.

| site | in the audited population | observed |
| --- | --- | --- |
| `indexer.rs:1856` | no, no sleep in the wait | runs 6 and 10 of a 30-run baseline sweep; twice more in 18 runs on a second rig |
| `indexer.rs:1895` | its poll `:1891` is, the bound is not | once, run 2 of a later post-fix sweep |
| `indexer.rs:2146` | no, no construct | once, run 20 of the same baseline sweep |
| `indexer.rs:2068` | no, no construct | once, same run |
| `indexer.rs:1396` | no, no construct | twice, second rig |
| `indexer.rs:2260` | no, no construct | once, second rig |

The baseline sweep ran `cargo test -p chan-server --lib -- --test-threads=32` under a 1-CPU cgroup cap verified from the host, at host loadavg 38 to 45. At least 3 of those 30 runs carried an indexer red; that lane tallied its own cluster per failure and did not tally the indexer surface, so 3 of 30 is a floor rather than a rate, and re-deriving the rate is part of this item's acceptance.

The second rig is the load-bearing one, because it is a different lane, a different worktree and a different operator, running 18 iterations whose only source modification was an unrelated preflight fixture. Its cap was measured from the host at `1.00 effective cores`, `nr_throttled 790`, `throttled_usec 426,212,368`, while `nproc` inside the container still reported 8. `indexer.rs:1856` fired in both of its red batches.

Two accuracy notes. Run 20 recorded test names rather than panic lines, so the assertion lines for `:2146` and `:2068` come from reading the tests; `idle_indexer_does_not_keep_workspace_handle_alive` has two `strong_count` assertions and which one fired is not recorded. And one further red, `retry_with_pending_runs_without_a_new_channel_signal`, was recorded by name only, with no line, so it is not in the table; its two waits are `:1774` and `:1790`.

The pattern the table shows is the item: of the six reds in it, five are at sites the classification structurally could not enumerate, and the sixth is at a bound whose only representative in the population is the 10 ms poll inside it.

## The `tokio::time::timeout` population, re-derived

`grep -rn "tokio::time::timeout" crates/chan-server/src/ | wc -l` returns **64** call sites at `f9c2878c`, in 15 files.

```
handoff.rs                                     16
devserver.rs                                   11
indexer.rs                                      7
control_socket.rs                               7
devserver_handoff.rs                            5
signal.rs, extensions.rs, bulk_transfer.rs      3 each
state.rs, routes/terminal.rs                    2 each
5 further files, 1 each                         5
                                              ---
                                               64
```

**None of the 64 is a member of the audited population.** All 49 classified rows name a sleep call site, and the intersection of the 49 classified `file:line` pairs with the 64 timeout `file:line` pairs is empty, checked mechanically against the tree at HEAD rather than by eye. Five of the seven `indexer.rs` budgets appear in the classification only obliquely, through the sleep polling inside them, which is how a justification comes to mention `CONVERGENCE_BUDGET` without the budget ever having been classified.

While checking that intersection: 40 of the 49 classified rows still land on a line containing `sleep` at HEAD; 9 do not. `indexer.rs` is not among the nine, and has had no commit since `b346b87f`, the commit the classification was derived at, so every `indexer.rs` comparison in this item is line for line rather than approximate. Seven of the nine are `control_socket.rs`, whose only change in that window is `8ed880c0`, 81 insertions against 6 deletions, which shifted its rows by 58 to 75 lines and removed one site outright: the 25 ms `std::thread::sleep` classified `test-repaired` at `control_socket.rs:4936` is present at `v0.87.0` and has no counterpart at HEAD. The other two are `doc_sessions/mod.rs:2948` and `routes/terminal.rs:2608`, the latter now landing on an argument of a `collect_until_idle` helper call. None of this is a defect in the closed item, which was correct when written. It is why this item cites a symbol beside every load-bearing line and asks the same of whatever replaces the classification.

## What this item reopens, and it must not start without a ruling

`done/load-sensitive-tests-keep-recurring-after-three-sweeps.md:266-268` classifies three `indexer.rs` sites as `test-bounded-and-kept`:

> | `indexer.rs:1779` | test-bounded-and-kept | poll inside `CONVERGENCE_BUDGET`; `done/timing-test-virtual-clock.md` already ruled this family |
> | `indexer.rs:1796` | test-bounded-and-kept | same |
> | `indexer.rs:1891` | test-bounded-and-kept | same; re-repairing would undo the prior ruling |

All three are live at HEAD and all three are the 10 ms `tokio::time::sleep(Duration::from_millis(10))` polls inside the `:1774`, `:1790` and `:1885` budgets. **This item reopens exactly those three sites**, and states it rather than routing around them.

The reason is narrow. The justification is a claim about the sleep, and it inherits the soundness of the bound the sleep polls inside. `indexer.rs:1891` polls inside the budget whose `.expect("follow-up generation did not complete")` at `:1895` is one of this round's reds, and the enclosing bound was never classified. The kept rows are not wrong about the sleeps. They are silent about whether the enclosing bound can report a starved host as a lost generation, and that silence is the population defect this item exists to name.

That silence also runs against the closed item's own general rule at `:225`, which holds that "a generous **named budget** on a real clock keeps every bit of discriminating power and still removes the load sensitivity". A named budget of 30 s expiring on the wait that only asks whether a pass has started is a counterexample to the second half of that sentence. Whether the rule falls or is qualified is not this item's call to make quietly.

**No lane touches `indexer.rs:1779`, `:1796` or `:1891` until the owner rules on the reopening**, because `:268` says in terms that re-repairing them undoes the prior ruling. Reopening a shipped classification is the owner's decision and this item asks for it explicitly rather than presenting it as a consequence.

### The ruling, 2026-08-11

**@@Alex ruled: reopen all three, evidence-led.** Surveyed and answered during the v0.89.0 round, and recorded here before any of the three sites was edited, which is what the acceptance line on the reopening requires.

"Evidence-led" is the operative qualifier, and it is narrower than a licence to rewrite the three. The reopening exists because the kept rows are *silent* about the enclosing budget, not because they are *wrong* about the polls: a site re-classified with its enclosing bound classified too, and kept, is a conforming outcome and should be reported as one. `CONVERGENCE_BUDGET`'s value is unchanged by this ruling, and any site that does change still owes the before-and-after ratio on the same rig with N stated.

## Contract

- A timing audit of `indexer.rs` states its population by the shape of the wait, not by a keyword. A wait that can report a starved host as a product defect is in the population whether or not any duration literal appears inside it.
- Each of the seven sites named above is classified into the four buckets the closed item established, with its justification written in place, and the classification records the reading that produced it.
- Every site citation carries a symbol name beside its line, so the classification survives the drift that has already moved nine of the closed item's own rows.
- Where a wall-clock bound is kept, the record says what instrument it was measured on, because a bound measured on a quiet box is a bound with an unknown false-positive rate on a contended one.
- The `indexer.rs` timeout count, its split into sleep-carrying and sleep-free bodies, and the crate-wide count of 64 are written down as re-runnable greps rather than as a completeness claim.

## Boundaries

- `crates/chan-server/src/indexer.rs` only. The other 57 `tokio::time::timeout` sites in the crate are counted here so the next round inherits a number instead of a guess, and they are out of scope.
- `CONVERGENCE_BUDGET`'s value does not change in this item. Raising 30 s to 60 s is the move this evidence argues against, and lowering it is not on the table either.
- The three `test-bounded-and-kept` sites stay untouched until the owner rules, per the section above. The item can be executed against the four constructless sites and the two sleep-free bounds without that ruling; it cannot be finished without it.
- Diagnosing the four constructless sites is in scope only as far as the classification needs. This item does not commit to repairing them, and it does not carry a mechanism claim for any of them.
- The vitest surface and the `routes::terminal` cluster from the source draft are not in this item.

## Acceptance

- The seven sites classified, each by symbol and line, each with a justification a re-reader can check against the code around it rather than against the wait itself.
- **The rig is the CPU-capped one from [`.agents/playbook.md:70`](../../../.agents/playbook.md)**: `sdme set --cpus 1` plus `--test-threads=32`, with the cap verified from the HOST cgroup and not from inside the container, which reports `max 100000` and misleads. Isolated-run counts certify nothing for this class: the playbook records 400 consecutive isolated runs green on known-broken code. The v0.89.0 watch-registration item inherits the same rig for the same reason, and a result from either that was taken any other way is not comparable to one that was.
- A red rate for `indexer.rs:1856` stated as a ratio over N runs on that rig, before any change. The round has runs 6 and 10 of 30 on one instrument and 2 of 18 on another; neither was collected as a rate for this test, so neither is one.
- If anything is changed, the same ratio after, on the same instrument, with N stated. A green series is not an argument on its own; the closed item at `:200` already requires the ratio rather than a single observation, and this item does not lower that bar.
- The reopening ruling recorded in this file, whichever way it goes, before `:1779`, `:1796` or `:1891` is edited.
- The re-derived counts written into the item: 7 timeout sites in `indexer.rs`, 5 with a sleep in the body and 2 without, 64 in the crate, 0 of the 64 in the audited population.

## What stays in dev/, and why

A project-wide rule for this class is not writable today. Two facts block it, and both hold at the current tree.

**1. No harness timeout exists to catch a true hang.** A wait that blocks on its signal with no bound of its own has no backstop anywhere in the tree. `Makefile:250` runs `RUSTFLAGS="-D warnings" $(CARGO) test --all-targets` inside the `pre-push` gate, which is what CI runs on Linux through `ci-linux` (`Makefile:287`); `Makefile:460` is plain `$(CARGO) test --workspace`; macOS runs `cargo test --all-targets` directly at `Makefile:293`. There is no `.config/` directory, no `nextest.toml` anywhere in the tree, no mention of `nextest` in `Makefile` or `.github/`, no `.cargo/config.toml` to install a test runner, and `timeout-minutes` appears **zero** times across `.github/workflows/`. Stock libtest has no per-test timeout. Removing a bound today therefore converts a bounded red into a job bounded only by GitHub's default job timeout of six hours. A replacement contract has to be decided before the rule can be written at all, and the candidates worth arguing are a harness-level per-test timeout, or reporting an expiry as inconclusive rather than as a failure, which `scripts/e2e/webview-flip-render.py` already does with its exit-2 convention.

**2. The `indexer.rs` arm is a classification, not a small scoped edit.** The budget count is seven: `:1885` and its follow-up loop are one wait, whose `.expect` is the `:1895` panic in the reds table above. Five of the seven are reachable through the sleeps they carry, and only `:1854` and `:1876`, the two budgets with no sleep in them, stand wholly outside the audited population. The work is a classification that has to overturn a closed ruling, not an edit to seven call sites.

The vitest `hookTimeout` finding, the `routes::terminal` cluster and the class-level argument stay in `dev/` until that contract exists. They are not wrong; they are unwritable as a rule, which is a different problem.

## Classified, recorded 2026-08-11: reopened, examined, and kept

Landed at `1ca1b289`. The `indexer.rs` half of that commit is **comments only**, verified mechanically rather than by reading: every changed line is a comment or blank, 18 added and 7 removed. No behaviour changed, and no after-rate is owed as a result, which is the direct consequence of the acceptance line above requiring a ratio only "if anything is changed".

All seven `tokio::time::timeout` sites classify `test-bounded-and-kept`, each by the real work its wait spans rather than by the wait itself: recovery work in `await_ready`; real OS notify and policy delivery at the gitignore convergence bound; an injected rebuild executed through real `spawn_blocking` at the first retry bound; real retry, cooldown, disk and index work at the retry convergence bound; a blocking graph-progress callback at the first bare `started_rx.recv`; pass-one completion plus a real cooldown before pass two's callback at the second; and pass two's blocking work at the final convergence loop.

**That is a conforming outcome, not a failure to change anything.** The owner's ruling was to reopen all three former `test-bounded-and-kept` sleeps evidence-led, and "evidence-led" was recorded as narrower than a licence to rewrite them: a site re-classified with its enclosing bound classified too, and kept, satisfies it. The three are kept together with their enclosing budgets. `CONVERGENCE_BUDGET` stays at 30 seconds, unchanged, and its source comment now records why paused Tokio time cannot substitute: the clock cannot advance notify delivery, `spawn_blocking`, disk, or index work.

Four further sites observed with no timeout construct are recorded as **synchronous invariants at current source rather than implicit waits**: recovery parking before indexer spawn, commit and reader reload in `apply_watch_change`, the downgrade before task creation with no strong workspace reference, and the commit and reload for each rapid-burst apply. Those readings sit beside their enclosing tests, where the next reader meets them.

The pre-edit baseline was 0/30 red for every named indexer target on the capped chan-server lib-suite instrument, including both timeout-owning tests and all four constructless sites. It is reported with its own defect stated: runs 1 to 16 were the surviving shared-tree series and runs 17 to 30 used a frozen clean `6ddd34cc` snapshot, and although `indexer.rs` was byte-identical and the cap and command were identical, unrelated shared work meant the two arms enumerated 1087 and 1083 tests. It is therefore an honest target rate and not a frozen-whole-tree benchmark.

### The blind spot confirmed a third time, from a lane that was not looking

This item's central claim is that the v0.88.0 audit could only see sites carrying a lexical `sleep`. A third independent confirmation arrived during the round: `hosted_terminal_registry_resolves_backend_on_each_spawn` red once in a full 1,083-test run in another lane, and neither that test nor its source file contains `sleep(`, so it cannot be enumerated by the audited population. Measured 0/30 red on the same instrument, so it is a population finding rather than a repair finding.

```citations
crates/chan-server/src/indexer.rs	tests::CONVERGENCE_BUDGET	1	Tokio clock cannot advance notify delivery,
crates/chan-server/src/indexer.rs	spawning_the_indexer_claims_a_pass_parked_before_it	1	The request parks synchronously
crates/chan-server/src/indexer.rs	rapid_modify_burst_indexes_latest_file_body	1	Each apply commits and reloads the index reader synchronously
```

## Rough size

Small in code, medium in evidence, and blocked at one point on a decision rather than on work. Classifying seven sites is a day of reading. The rate measurements are the cost: each ratio needs N runs of the chan-server lib suite under a 1-CPU cap, and the round's own numbers show the instrument produces a result roughly one run in ten, so a usable before-and-after is tens of runs on a contended host rather than a quick check. The reopening ruling gates the last third of it and nothing but the owner unblocks that.
