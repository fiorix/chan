# A `.gitignore` write strands the workspace in `recovering` with no worker assigned

Closed: shipped in [v0.87.0](../release/release-v0.87.0.md).

Status: DIAGNOSED 2026-08-09 against the owner's live devserver during the v0.87.0 round, from a stuck workspace rather than a test. ACCEPTED into the round the same day on the owner's call, after the root cause was re-verified against the tree host-side. The live workspace was recovered in place without restarting the devserver; the defect is unfixed.

## What

Editing `.gitignore` in a served workspace can park it in `recovering` permanently. The boot overlay then locks on `Build search index` and never dismisses, and the status bar reads `workspace recovering` forever. Only an out-of-band `POST /api/index/rebuild`, or a devserver restart, clears it.

`Workspace::refresh_repository_scope` (`crates/chan-workspace/src/workspace.rs:3479-3489`) runs from the watcher fan-out on any `.gitignore` write: `ScopePolicyFanOut::on_event` (`workspace.rs:747-763`) matches the path and calls it. It calls `request_policy_recovery(RecoveryAction::Reconcile)`, which (`workspace.rs:1069-1079`) advances the generation, parks a pending `RecoveryPass`, and **notifies no driver**. The fan-out logs on `Err` and discards the `Ok`.

Nothing subsequently claims that pass. There are exactly three drains:

1. `run_open_recovery` (`workspace.rs:676-738`), the startup worker introduced by v0.76.0's `workspace-open-reconcile-off-mount-path`. It loops until `begin_recovery()` returns `None`, then exits. By the time a `.gitignore` is edited it is long gone. It also `return`s permanently on the first failed pass (`workspace.rs:727-736`), leaving the pass requeued with nothing left running, a second independent route into the same terminal state.
2. `spawn_coordinator` (`crates/chan-server/src/indexer.rs:363-525`), v0.76.0's rebuild generation coordinator. It only wakes on its rebuild mpsc channel, which `request_policy_recovery` never sends to. Worse, had it woken, `indexer.rs:400-409` refuses any non-`FullRebuild` pass outright and flips the indexer to `IndexStatus::Error`. It cannot execute a `Reconcile` at all.
3. `recovery_execution` (`workspace.rs:1124-1152`), reached only from inside a direct `reindex` / `reconcile` / `replay` call.

So a `Reconcile` requested after startup by the policy path is orphaned by construction.

**The omission is provable against its own sibling, not inferred.** `set_excluded_dirs` (`workspace.rs:3454-3477`) uses the same `request_policy_recovery(Reconcile)` and carries the comment "the caller triggers the recovery off its async executor", and its caller does exactly that, at `crates/chan-server/src/routes/excluded_dirs.rs:114-116`:

```rust
if let Ok(indexer) = state.try_indexer() {
    indexer.request_rebuild();
}
```

`refresh_repository_scope` has no such follow-up. Same primitive, one path wired, one path not. This is the seam between two items that shipped in the same release: v0.76.0's `devserver-rebuild-storm-and-livelock` added both the generation coordinator and `.gitignore` honoring, and the `.gitignore` path never got the coordinator call that the excluded-dirs path got.

The user-visible half is `index_step` (`crates/chan-server/src/routes/preflight.rs:158`), whose `_ if !readiness.is_ready()` arm precedes every healthy status arm, so the step reports `pending`, then `phase: running`, then `locked: true`. `web/packages/workspace-app/src/components/AppStatusBar.svelte:153-154` is the `workspace recovering` string.

## Why this matters more than the frequency suggests

The trigger is a file people edit constantly, in the workspace they are working in. The incident that produced this diagnosis came from an ordinary `.gitignore` edit during unrelated housekeeping, not from anything exotic. The failure presents as a boot overlay that never dismisses, and the only escape is an out-of-band API call carrying a workspace token dug out of the devserver config. Nothing in the product surface offers that escape, so a user who hits this has no way out that does not involve restarting the devserver.

## Evidence, 2026-08-09

Live devserver, PID 1343, up 12h26m, workspace `/home/fiorix/dev/github/fiorix/chan`:

```json
"readiness": {"state":"recovering","generation":14,"completed_generation":12,
              "required_action":"reconcile",
              "active_generation":null,"pending_generation":14}
"indexer":   {"status":"idle","queue_depth":0,"indexed_docs":2973}
```

A reconcile pending for generation 14, nothing active, indexer idle, queue empty, stable indefinitely. `GET /api/preflight` reported `phase: running`, `locked: true`, index step `pending`. Generation 12 to 14 is two policy bumps; the checkout's `.gitignore` is modified with mtime 08:37 that morning, and `request_policy_recovery` advances the generation on every call while coalescing the pending pass, producing exactly the observed 14/14/12.

The server was never deadlocked: it answered HTTP in under a millisecond throughout, having burned 9m03s of CPU in 12h26m with all 52 threads parked on futexes.

**Environment ruled out.** No process on the host in `D` state, no hung mount, and nothing under the workspace root bind-mounted into any container; the four live `systemd-nspawn` machines bind the `chan-v087-*` worktrees, not `chan`. Load average 22.26 on 8 cores from container `rustc`/`cc1` was real but incidental. An idle futex-parked process is not a starved one.

**Recovery applied**, without restarting the devserver:

```bash
curl -X POST -H "Authorization: Bearer <workspace-token>" \
  http://127.0.0.1:37897/<prefix>/api/index/rebuild
```

`request_recovery(FullRebuild)` (`workspace.rs:1051-1063`) coalesces into the existing pending pass and raises its action to the max of the two, the ordering being `Replay < Reconcile < FullRebuild` (`workspace.rs:328-332`), and `request_rebuild` (`indexer.rs:314`) then pushes that generation onto the coordinator channel, giving the coordinator a pass it is willing to claim. Verified after: `readiness.state: ready` at generation 14, `preflight.phase: ready`, `locked: false`, index step `done`, and `GET /api/search/content` returning real BM25 hits. Workspace tokens come from `GET /api/devserver/workspaces` with the management token in `~/.chan/devserver/config.json`.

## Contract

- A scope-policy generation bump requested by the watcher converges on its own, with no user action and no second process.
- A workspace never presents a locked boot overlay for a recovery pass that has no worker assigned to it.
- Recovery state that cannot progress is distinguishable from recovery in progress.

## Acceptance

- Writing `.gitignore` in a served workspace returns readiness to `ready` without an external `/api/index/rebuild`, demonstrated live rather than by reading.
- A test asserts a pending pass with `active: None` is either claimed or reported, and fails if that state can persist indefinitely.
- The coordinator's non-`FullRebuild` branch (`indexer.rs:400-409`) either executes the pass or is unreachable by construction; today it is reachable and terminal.
- The startup worker's bail-on-failure path (`workspace.rs:727-736`) cannot leave a pending pass with nothing running.
- The preflight arm ordering that makes a stalled recovery indistinguishable from a running one (`routes/preflight.rs:158`) is resolved here rather than left to the observability item; a stall the operator cannot see is half the defect.
- Per the gate discipline, each new test is proven able to go red once, then restored.

## Rough size

Small if scoped to the wiring: give `refresh_repository_scope` the same coordinator poke `excluded_dirs.rs:114-116` already makes, which the existing sibling proves is the intended shape. Medium if the round wants the class closed rather than the instance, which means the coordinator learning to execute `Reconcile` instead of erroring on it, and a supervisor that cannot leave a pending pass unowned. The instance fix leaves both other routes into the same terminal state open, so closing only the instance should be a deliberate choice.

## Adjacent, registered separately

Both were surfaced by this diagnosis and are their own items now. Neither is in this round's scope.

- [one-stalled-workspace-may-block-the-others](one-stalled-workspace-may-block-the-others.md): with this workspace stuck, the others could not be toggled off from the UI. Registered as an unverified lead with no reproduction attempted, and it stays that way until someone reproduces it.
- [chan-ps-cannot-answer-what-a-workspace-is-doing](chan-ps-cannot-answer-what-a-workspace-is-doing.md): every fact needed to diagnose this was already computed and already served, and `chan ps` surfaces none of it.

## Implemented 2026-08-09 (`53f8b5e6`)

The class, not the instance. Copying the coordinator poke that `excluded_dirs.rs:114-116`
already makes would have fixed `.gitignore` and left the poke as something each future
caller has to remember, which is exactly how `refresh_repository_scope` and
`set_excluded_dirs` came to differ while sharing a primitive. Instead the announcement is
structural: `Workspace` carries a `RecoveryDriver` that the executor installs, and every
path that parks a pass announces it, `request_recovery` and `request_policy_recovery` and
the requeue branch of `finish_recovery` alike. Installing a driver also announces a pass
already pending, which is what closes the two routes the item lists beyond the reported
one: the window between `Workspace::open` and `Indexer::spawn`, and `run_open_recovery`
returning for good on a failed pass with that pass requeued behind it.

The coordinator executes `Reconcile` and `Replay` rather than refusing them into
`IndexStatus::Error`. For a served workspace it is the only claimant there is, so its
refusal was terminal for that generation rather than a deferral. Only `FullRebuild` rides
the 30 s storm cooldown or stamps `Building`; a reconcile is bounded work that reports no
per-file progress, and delaying it holds the workspace in `recovering` for no gain.

Preflight tests whether a pass has a claimant ahead of testing readiness. A stalled
recovery and a running one are both `!is_ready()`, and asking readiness first is precisely
what made them indistinguishable. An unowned pass now reports `needs_decision` carrying
the rebuild that clears it, performed by a new `index` arm on
`POST /api/preflight/decision`. `PreflightOverlay.svelte:299-311` already renders any
step's decision generically and posts `decide(step.id, choice.id)`, so this needed no
frontend change.

**Why this satisfies "never presents a locked boot overlay for a recovery pass that has no
worker assigned to it"**, rather than merely softening it: after the change every parked
pass is announced to a driver, and `Indexer::spawn` installs one before the server can
serve a single poll. On a served workspace the antecedent cannot occur, so the line holds
structurally rather than by mitigation. The decision card is the guard for the case the
invariant does not cover (a workspace opened with no indexer at all), and it is
deliberately unreachable on a served workspace. The separate question of whether a pass
that *does* have a worker should lock the workspace at all is registered as
[the-boot-overlay-locks-the-workspace-behind-its-own-index-rebuild](the-boot-overlay-locks-the-workspace-behind-its-own-index-rebuild.md);
it is a product decision about whether indexing blocks entry, and this item's contract does
not reach it.

One behavior change beyond the defect: the phase derivation now ranks `needs_decision`
ahead of unready readiness. A recovering workspace with a missing embedding model reports
`needs_decision` where it previously reported `running`. The overlay locks either way.
Without the reorder the stall step would be computed and then buried.

### Live proof, both arms

Run on the same script, workspace shape, host and session, with the commit as the only
variable. Host condition: box otherwise idle, load average 2.6 to 6, the other three lanes
merged and quiet, and the lead deliberately holding a gate pre-warm so the measurement
carried no foreign load.

A devserver over a throwaway two-file workspace, settled to `ready`, then one `.gitignore`
write and nothing else. No `/api/index/rebuild` in either arm.

On `main` at `b9809f31`, held for the full 60 s sample window:

```json
"readiness": {"state":"recovering","generation":3,"completed_generation":1,
              "required_action":"reconcile",
              "active_generation":null,"pending_generation":3}
"indexer":   {"status":"idle","queue_depth":0}
```

with `phase: running`, `locked: true`, index step `pending`. That is the diagnosis
reproduced from scratch: the same fingerprint as the owner's devserver at generation 14 /
completed 12 / `reconcile` / active null / pending 14 / indexer idle / queue 0, two policy
bumps and all.

On `53f8b5e6`, same trigger: generation advanced 1 to 3 and readiness returned to
`state: ready` at generation 3, `phase: ready`, `locked: false`, index step `done`.

The success criterion is the acceptance line, `generation advanced AND readiness returned
to ready`. An earlier version of the harness also required *sighting* the transient
`recovering` state and scored a working fix `INCONCLUSIVE`, because a reconcile over two
files finishes between polls; the generation advance is the guard against a vacuous pass,
not the sighting. The red arm did observe `recovering` directly, which confirms the
criterion can see the stall it is asked to detect.

### Tests

13 new, and the previously existing preflight test that asserted a driverless pending pass
reports `Phase::Running` was rewritten, because it pinned exactly the state this item calls
the defect.

- `indexer.rs`: the end-to-end `.gitignore` convergence with a real watcher and a real
  `Indexer::spawn`; the coordinator running a `Reconcile` and a `Replay` without faulting;
  a pass parked before the indexer exists being claimed when it spawns.
- `workspace.rs`: the three announcement paths (park, requeue, install-time), completion
  deliberately not announcing, and `recovery_is_unowned` across all four states.
- `preflight.rs`: recovery with a claimant versus a stall, distinguished under identical
  readiness and identical index status; installing a claimant clearing the stall report; an
  index error outranking a stall.

### Mutation probes

Seven probes, 20 assertions: 13 expect-red and 7 controls that had to stay green. Every
probe bit, and every expect-red assertion failed the test that claims it:

| Probe | Reverted | Went red |
| --- | --- | --- |
| P1 | policy-park does not announce | park test, `.gitignore` end-to-end |
| P2 | requeue does not announce | requeue test |
| P3 | install does not announce | install test, indexer-spawn test |
| P4 | coordinator refuses non-rebuild | reconcile test, replay test |
| P5 | readiness outranks the stall | stall-report test, install-clears test |
| P6 | `unowned` ignores the driver | three tests across both crates |
| P7 | phase buries the decision | stall-report test |

The first run of P1 scored 19 of 20, and the deviation was a control chosen wrongly rather
than a defect: the control nominated asserts the driver was woken *twice*, once for the
park and once for the requeue, so it depends on the park announcement and correctly went
red. Re-run against `recovery_generation_signal_during_active_forces_follow_up`, which
exercises the same mutated function but asserts generation and pass state rather than
announcement, P1 is 3 of 3. That control is the sharper one: it shows the mutation is
narrow within the recovery machinery, not merely survivable by an unrelated crate.

The harness classifies `build-error` and `no-match` apart from red and green, and asserts
the runner reported `running 1 test` before believing a green. An earlier run of it scored
0 of 20 as `build-error` when the host disk filled; that is the instrument refusing to
score a build that never ran, rather than reporting the probes as failing to bite.

### Not proven, stated rather than implied

`recovery_is_unowned` has three terms. Two are covered directly. The third, "the startup
worker is still running", guards a window of microseconds between the worker being spawned
and it claiming its pass, and is held by construction rather than by a test: covering it
needs a timing-sensitive assertion, and this round registered three load-sensitive reds
already. The guard earns its place by keeping a boot-time poll that lands in that window
from rendering a false stall card, and on a served workspace the driver is installed before
the server answers at all.
