# A terminal restart-env test goes red under CPU starvation

Status: REGISTERED 2026-08-09 during the v0.87.0 delivery round, observed incidentally by
the `scene-conflict-test-is-load-sensitive` lane. **IMPLEMENTED 2026-08-10**: one shared
harness defect, reproduced at 40% and repaired to 0% over 30 runs each under a 1-CPU
cgroup rig. See "Implemented" below.

> **Reconciling this item against itself.** Everything above "Implemented" was written
> when the mechanism was unknown, and several of its statements are now false. They are
> kept rather than edited, because the reasoning that produced them was sound and the
> corrections are the useful part -- the same discipline this item's sibling
> `doc-sessions-tests-stage-external-edits-on-the-filesystem-clock` applies to its own
> falsified prediction. Read the later sections as authoritative where they conflict:
>
> - *"Not implemented, and not investigated"* / *"The mechanism is unknown; nobody has
>   looked"* / *"the mechanism is still genuinely unknown"* -- superseded. The mechanism is
>   named, demonstrated, and its repair measured.
> - *"Rough size: Unknown until someone reproduces it"* -- resolved. One helper function in
>   the test harness, plus its two call sites.
> - *"if the investigation shows three genuinely different mechanisms, split then"* --
>   resolved the other way. It is **one** mechanism, and the item stays whole.
> - What survived intact and deserves saying: this item's guess that *"one shared cause in
>   the terminal test harness is likelier than three independent races"*, and its
>   instruction to investigate the shared harness rather than three assertions, were both
>   correct and were what made the investigation short.

## What

`routes::terminal::tests::api_restart_terminal_updates_chan_tab_name_env`
(`crates/chan-server/src/routes/terminal.rs:2428`) went red once in 3 full-suite runs
while the suite ran under a deliberate 1-CPU cgroup cap with `--test-threads=32`.

That is a second load-sensitive test in the same suite as the one v0.87.0's
`scene-conflict-test-is-load-sensitive` item was opened for, on a different surface and
with no established relationship to it. The mechanism is unknown; nobody has looked. It
should not be assumed to share the mtime-collision cause of the item that found it, and
merging the two without evidence would repeat the mistake that item's own text warns
against.

The round's standing bar is why this is registered rather than shrugged off: a red that
fires on a run that ships trains the operator to discard the next genuine red.

## Contract

- The test passes deterministically under parallel execution on a starved host, or the
  behaviour it asserts is covered by a test that does.
- The fix names the mechanism -- test sequencing versus a real race in the restart path --
  rather than making the red go away. A race reachable by the test is presumed reachable
  by production until shown otherwise.

## Acceptance

- Reproduce at will under the same 1-CPU cgroup rig that surfaced it, then show the fix
  removes it under the same pressure.
- Consecutive full parallel suite runs under that rig, green.
- The repaired assertion is proven able to go red once, then restored.

## Rough size

Unknown until someone reproduces it. The reproduction rig is already established and cheap
(`sdme set --cpus 1` on the build container plus `--test-threads=32`), so the first step is
short even if the mechanism is not.

## It is three tests, not one: treat it as a cluster

Amended 2026-08-09 at lane close. The scene lane's rig surfaced two more `routes::terminal`
tests failing under the same pressure:

- `api_restart_terminal_updates_chan_tab_name_env` (`terminal.rs:2428`) — the original
- `api_restart_terminal_respawns_same_session_command` (`terminal.rs:2372`)
- `api_create_terminal_spawns_command_and_returns_session` (`terminal.rs:2283`)

Three tests in one module failing under the same conditions is a cluster, and **one shared
cause in the terminal test harness is likelier than three independent races**. They are kept
as one item on that reading rather than split into siblings; if the investigation shows
three genuinely different mechanisms, split then, with the evidence.

Investigate the shared harness first. All three spawn a real terminal, so the common
suspects are the spawn path, the readiness wait, and whatever sequencing the tests share
around a live PTY — not three separate assertions each racing something of their own.

## The chan-server sleep sweep does not reach this

Established 2026-08-09 by the audit lane of
[load-sensitive-tests-keep-recurring-after-three-sweeps](../done/load-sensitive-tests-keep-recurring-after-three-sweeps.md):
`api_restart_terminal_updates_chan_tab_name_env` (`routes/terminal.rs:2392-2435`) contains
**no timing construct at all** — no `sleep`, `timeout`, `Instant::now`, `elapsed()`, or
`yield_now`. Its only "sleep" is the string `sleep 1` in a shell command handed to a
spawned terminal, which is shell rather than Rust.

So this test is **not** in that sweep's population, and the sweep completing says nothing
about it. Do not close this item by adjacency when that one lands. The two sites the sweep
does hold in `routes/terminal.rs` are different functions.

Whatever makes this test load-sensitive is not a sleep, which also means the mechanism is
still genuinely unknown — reading the function for a timing keyword will not find it. The
instrument that surfaced it was the suite under a 1-CPU cgroup cap with
`--test-threads=32`; start there.

## Prior art

This failure class has been worked three times already:
[wall-clock-test-flakiness](../done/wall-clock-test-flakiness.md),
[timing-test-virtual-clock](../done/timing-test-virtual-clock.md) (the ruling: virtual
clocks over grace windows), and
[parallel-suite-flake-hygiene](../done/parallel-suite-flake-hygiene.md) in v0.82.0. None
of them covers this test. Read the ruling before choosing a repair, so this does not
become a fourth independent answer to the same question.

## Provenance

Observed by the `scene-conflict-test-is-load-sensitive` lane, which flagged it explicitly
as outside its surface and unexamined rather than folding it into its own findings.

## Implemented 2026-08-10: one harness defect, not three test bugs

The mechanism is **test sequencing in the shared terminal-test harness**, exactly where
this item said to look. It is not three races, not a sleep, not a budget, and
`PROBE_BUDGET` is not involved.

### The mechanism

> **Resolving the references below.** They anchor on **unique content** -- symbol names and
> distinctive strings -- rather than line positions, because a `file:line` fails **open**:
> it silently resolves to whatever now occupies that line and reads as correct, where a
> dead sha fails closed and announces itself. Line numbers that do appear are measured
> evidence (recorded panic sites), tagged with the commit they were true at. This item's
> own earlier sections cite `terminal.rs:2428` for a test whose assertion this round
> recorded panicking at `:2405`, which is the failure mode in miniature.

An attach delivers output in **two halves**. `Session::attach` in
`chan-library/src/terminal_sessions.rs` does:

```rust
let rx = self.output_tx.subscribe();                    // only what follows
let (replay, missed_bytes) = self.ring.lock()...
        .snapshot_since(since);                         // everything already printed
```

`rx` is subscribed **at attach time**, so anything the PTY printed before that instant
exists only in `replay`.

The test harness read one half. `collect_until` (`routes/terminal.rs`) drained
`session.rx` and never touched `session.replay`. So when the spawned shell wins the race
against the test's attach -- which is what a 1-CPU cap with `--test-threads=32` makes
likely -- the assertion sees **nothing at all**.

Production honours both halves: `send_attach_prelude` (`routes/terminal.rs`) sends
`session.replay` to the websocket client before streaming live events. So a real client
receives pre-attach output and the test collector did not. **The race is in the test, not
in the restart path**, which is the distinction this item's Contract demands, and it is
shown rather than asserted.

### Why exactly these three tests

Two ways to get an `AttachHandle` in this module, and only one is exposed:

- `TestTerminal::spawn` takes the handle `Registry::create` returns **at creation**, so
  the subscription precedes any output. Immune by construction.
- A separate `attach(id, Some(0))` after the route created the session is a **second,
  later** subscription. Exposed -- if the test then reads PTY bytes.

All seven `attach(..., Some(0))` sites were enumerated. Two belong to
`session_frame_omits_unknown_agent_and_resyncs_restarted_identity`, which reads session
metadata and never calls `collect_until`; it is not exposed and does not fail. The other
five belong to **exactly the three tests in this cluster**. The mechanism predicts this
set and no larger one.

### The evidence: one signature, three tests, predicted before observed

Each cluster member caught red under the rig, at a **different assertion in a different
test**, with the identical fingerprint:

```
test                                                  line   message
api_create_terminal_spawns_command_and_returns_...    2283   missing output: ""
api_restart_terminal_respawns_same_session_command    2372   missing first output: ""
api_restart_terminal_updates_chan_tab_name_env        2405   missing first tab name: ""
```

**The collector's buffer is not short, it is empty.** That is the discriminating fact. A
generic "flaky under load" story predicts whatever the shell managed to emit -- truncated
output, interleaving, a partial prompt, output from the wrong incarnation. It does not
predict `""` three times out of three. The attach-replay mechanism predicts `""` and
nothing else.

**Prediction order.** The mechanism was derived from source reading and written up in
`dev/v088-team/tasks/task-Timing-Lead-1.md` **before the build container existed**,
including the specific claim that `api_create_terminal_spawns_command_and_returns_session`
would be the most exposed of the three because its bare `printf` leaves no trailing
`sleep`. All three observations came afterwards. A mechanism that predicted a signature
and then observed it three times is a different class of claim from one fitted to
observations after the fact.

### The repair

One helper in `routes/terminal.rs`, used by `collect_until` and `collect_until_idle`:

```rust
fn take_replay(session: &mut AttachHandle) -> String {
    let replay = std::mem::take(&mut session.replay);
    String::from_utf8_lossy(&replay.concat()).into_owned()
}
```

**Taken, not copied**: `collect_marker_window` reuses a handle an earlier
`collect_until_idle` already drained, so a copying prime would re-deliver bytes a previous
collector had already returned. `mem::take` makes replay the once-only source an attach
actually provides.

No sleep, no budget, no retry, no virtual clock. `PROBE_BUDGET` is unchanged at 30s.

### `PROBE_BUDGET` is not the mechanism

Recorded because it is the first thing the next reader will suspect. It is 30s
(`routes/terminal.rs`), generous, and untouched by this repair. The failures were not
budget expiries: `collect_until` returned early with an empty buffer, and for the
`printf`-only test the broadcast senders drop when the shell exits, which returned `""`
immediately rather than after 30s.

### Method notes worth carrying

- **Record the signature, not the count.** A run that records "1 failed" cannot
  distinguish this defect from a starvation timeout or an environmental fault. Keeping the
  full transcript per red run is what made the three-of-three provable and what separated
  this cluster from unrelated contamination in the same sweep.
- **Classify per failure, not per run.** Four runs in the baseline sweep carried an
  unrelated environmental fault, and **all four also carried genuine cluster reds**.
  Excluding contaminated runs wholesale -- the obvious method -- would have discarded real
  data and understated the rate. Exclude the failures by signature; keep every run in the
  denominator.
- **A limit read from a file is not a limit demonstrated.** See Reproduction.
- **A verification has a shelf life, and a scope.** See Reproduction.

## Reproduction and validation

Rig, identical on both sides: `sdme` container capped with `--cpus 1`, the chan-server lib
suite oversubscribed to `--test-threads=32`, host loadavg sampled per run, failures
classified per-signature.

**Measured at `e239c770`**, both arms: baseline unmodified, post-fix with this repair
applied. The comparison is internally valid -- one compiled graph, differing only by the
repair.

> **This rate is qualified, pending re-measurement on the shipped tree.** The branch was
> rebased onto `b6dd9f22` before merge, and the transfer check over `chan-server`'s
> ten-crate compiled graph **failed to transfer**: `routes/preflight.rs` and
> `chan-workspace/src/watch.rs` both changed **outside `#[cfg(test)]`**, so production code
> in this crate's own test binary moved between the measurement and the merge. My four
> surfaces are byte-identical across that move, but that is the wrong scope -- a
> load-sensitive rate depends on everything the binary compiles, not on the files the lane
> edited.
>
> So two claims, separated deliberately:
>
> - **The repair causes the change** -- established. 12/30 against 0/30 on one graph.
> - **The repair holds on the tree we ship** -- a confirmation sweep at `b6dd9f22` is
>   running; this section will record its result either way. Until it lands, do not read
>   the 0/30 as measured on shipped code.
>
> The distinction that forced this: *"my files did not change"* and *"what I compile did
> not change"* are different claims, and for any crate with dependencies the second is the
> one a rate depends on. Deriving the graph mechanically
> (`cargo tree --edges normal,dev,build`, dev edges included because `cargo test` compiles
> exactly those) turned a four-file check into a ten-crate one and is what caught this.

```
                                  BASELINE      POST-FIX
runs                                    30            30
runs with a cluster red             12 (40%)       0 (0%)
```

`P(0 in 30 | the rate were still 40%) = 0.6^30 = 2.2e-7`.

### The cap is verified twice, because a file is not a demonstration

`sdme set --cpus 1` on a **running** container prints `restart for limits to take effect`
while the host cgroup **immediately reads the correct `100000 100000`**. So the host file
-- the authority this project's own instructions name, correctly, over the container's
lying `max 100000` -- reads capped while the limit is unenforced. Following the written
instruction exactly would have produced a rate measured at 8 CPUs and reported as a 1-CPU
rate.

Enforcement is therefore also demonstrated behaviourally, by a self-calibrating ratio that
needs no absolute reference: run one busy loop, then four in parallel, and compare wall
time. ~100% means unenforced, ~400% means a real 1-CPU cap.

```
baseline sweep    one 8754ms   four 42413ms   ratio 484%
post-fix sweep    one 9756ms   four 42989ms   ratio 440%
```

### Host loadavg does not predict this failure, and barely means anything here

Measured, not assumed:

```
loadavg when a cluster red fired   min 17.8  med 47.9  max 66.8
loadavg when none fired            min 23.7  med 42.6  max 68.4
```

Overlapping ranges, near-identical medians. Within 17.8-68.4, host load does not predict
whether the cluster fires -- which corroborates this class's standing claim that the
amplifier is **parallel oversubscription rather than CPU scarcity**.

A round-wide measurement makes the number weaker still: freezing ten containers moved
loadavg only 22.3 -> 20.9 while CPU idle went 3% -> 81% and runnable dropped 21 -> 1. A
cgroup-throttled thread stays runnable, so loadavg counts threads that cannot consume CPU.
**Treat every loadavg figure in this round as an upper bound on contention, not a measure
of it.**

### Ruling out the quieter-box explanation

Post-fix mean loadavg was *lower* (39.3 vs 45.2), so the obvious objection is that the box
calmed down rather than the bug being fixed. Tested against the baseline's own data:

```
lowest baseline load at which the cluster EVER fired      17.79
post-fix runs at load >= 17.79                            29 of 30   cluster-red: 0
post-fix runs at load >= the baseline RED median (47.9)    6         cluster-red: 0
post-fix runs above the baseline MAXIMUM load (68.41)      1         cluster-red: 0
```

And measured directly rather than through loadavg: comparing like with like -- baseline
runs where the cluster did *not* fire against post-fix runs -- median duration is 74.7s vs
71.0s, about **5%**. Most of the raw 84.8s -> 71.0s gap is the repair itself, since a
failing test burns its budget before failing. The spinner ratio puts the effective-CPU
difference at about **9%** (484% -> 440%).

Baseline reds occurred across loads 17.8-66.8 and durations 68.8-146.2s and fired
throughout that whole range. A 5-9% environmental shift does not take a 40% rate to zero.

### Discrimination: proven able to go red, then restored

Mutations were **pre-registered with their expected messages before being run**, so a
surprising result could not be reinterpreted as a pass afterwards.

- **The repair is load-bearing.** The baseline sweep *is* the fix-reverted state under the
  identical rig: 12/30 against 0/30.
- **`api_restart_terminal` made to ignore the name override**: red, at
  `missing restarted tab name: "<CHAN_TAB_NAME=@@First>\r\n"`. Note the buffer is
  **populated**, not empty: after the repair a genuine defect reports the wrong value,
  where before the repair it reported `""`.

  **The repair moved these three tests from detecting a fault to diagnosing one.** For the
  whole of this defect's life they could report only "nothing arrived" -- which is why the
  empty-string fingerprint was such good evidence, and equally why any *real* regression in
  the restart path would have been undiagnosable from their output.
- Restored afterwards; all three cluster tests pass.
