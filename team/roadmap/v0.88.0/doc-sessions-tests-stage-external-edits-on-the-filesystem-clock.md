# doc_sessions tests stage external edits on the filesystem clock, with one sleep already hand-rolled

Status: REGISTERED 2026-08-09 during the v0.87.0 delivery round, from the
`scene-conflict-test-is-load-sensitive` investigation. **IMPLEMENTED 2026-08-10 as a
structural hazard, repaired on the strength of the sleep and the precedent, NOT
reproduced.** The hand-rolled 20ms sleep is gone and fourteen staging sites route through
the settled `scene_sessions` construction; the repaired assertion is proven able to go red
for the reason it claims to guard. **No `doc_sessions` test was observed failing from the
mtime collision in 60 rig runs**, which is what this item predicted of itself.

> **What this status does and does not claim.** Its sibling
> `terminal-restart-env-test-is-load-sensitive` carries a measured 40% -> 0% rate. **This
> item has no such number and must not be read as sharing one.** Two distinct claims:
>
> - *The repaired assertion discriminates* -- **proven.** Deterministic mutation: drop the
>   production retained-token refresh at `doc_sessions/mod.rs`, and
>   `same_bytes_rewrite_refreshes_the_retained_token` fails in 0.06s on the exact
>   assertion it guards.
> - *The staging helper is load-bearing* -- **not proven here.** It rests on the
>   `scene_sessions` lane's measurement (3 red in 60 with `advance_mtime` dropped) and on
>   the hand-rolled sleep being standing evidence that someone already hit this.
>
> A mutation probe that dropped `advance_mtime` was run and came back **green**, and the
> reason is instructive rather than reassuring: that probe removes protection against a
> *probabilistic* event -- two writes landing on the same filesystem nanosecond -- so a
> single run is the wrong instrument. The replacement probe's own output shows the clock
> advanced naturally by ~1ms on that run, so the hazard simply did not fire. This item's
> own text already warns of exactly this trap: 400 consecutive isolated runs went green on
> known-broken code.

## What

`scene_sessions` had two tests fail because they staged an external edit and assumed the
file's `mtime_ns` had moved, without establishing it. `doc_sessions` stages external edits
the same way, so it carries the same latent hazard: any of those tests can go red when the
filesystem timestamp does not advance between chan's write and the test's staged write.

One of them already works around it by hand. `crates/chan-server/src/doc_sessions/mod.rs:2914`
carries a bare

```rust
std::thread::sleep(Duration::from_millis(20))
```

to force the token to move. That is the hazard, diagnosed once and papered over in place
rather than removed -- and a fixed sleep is the shape the `timing-test-virtual-clock`
ruling exists to reject. It is also a silent 20ms tax on every run of that suite.

No `doc_sessions` test is known to have gone red from this. The hazard is structural: the
sleep is evidence someone already hit it, and the surrounding tests share the
construction without the workaround.

## Contract

- `doc_sessions` tests do not depend on the filesystem clock advancing between two writes.
- The hand-rolled sleep at `mod.rs:2914` is removed rather than replicated, and whatever
  replaces it is the same construction the `scene_sessions` fix settles on.

## Acceptance

- The `doc_sessions` suite passes under the 1-CPU cgroup rig that amplifies the mtime
  collision, repeatedly, not only on an idle host.
- No fixed sleep remains in the suite for timestamp-advance purposes.
- Each repaired assertion is proven able to go red for the reason it claims to guard.

## Rough size

Small, and it should follow rather than lead: the `scene_sessions` lane in v0.87.0 settles
the construction for staging an external edit without trusting the filesystem clock, and
this is that construction applied to a second module. Doing it before that lands would
mean inventing the pattern twice.

## A prediction that was made here, and falsified

**Amended 2026-08-09, then corrected the same day. Read the correction, not the prediction.**

When [mtime-cas-silently-overwrites-external-edits](../done/mtime-cas-silently-overwrites-external-edits.md)
was still being designed, this item was amended to say the CAS work looked like the actual
fix direction: that once the CAS keyed on content, a same-bytes rewrite would be a no-op,
`same_bytes_rewrite_refreshes_the_retained_token` would have no stale token left to refresh,
and its 20 ms sleep would be scaffolding for a replaced mechanism rather than a timing wait
to virtualise.

**That did not happen.** The landed CAS *verifies* the mtime against the bytes the caller
last saw rather than replacing it —
`workspace.rs:1898`: `(Some(m), true) => current != Some(m) || !self.disk_still_holds(rel, expected_disk)`.
The content check is an **additional** conflict trigger, not a substitute, so the mtime token
is still live on every path. `FlushJob` did gain `expected_disk`, and its own doc says "the
CAS verifies a matching mtime against these".

Confirmed empirically as well as structurally: the test survives the merge with its body and
its comment unchanged, so the 20 ms sleep is still load-bearing scaffolding and this item's
premise is untouched. It is not closed, or narrowed, by the CAS work.

The prediction is left on the record rather than deleted, because the reasoning that produced
it was sound at the time and the correction is the useful part: **a design that adds a check
alongside an untrusted value does not retire that value.** Anyone reading a "this is probably
fixed elsewhere" note on an item should check whether the elsewhere replaced the mechanism or
merely guarded it.

## Prior art

[parallel-suite-flake-hygiene](../done/parallel-suite-flake-hygiene.md) already did this
work for one test in v0.82.0: `restamped_disk_adopt_keeps_durable_bytes_and_settles_its_echo`
clears `flushed_mtime_ns` after its disk write so it "cannot take the equal-mtime short
circuit and does not depend on filesystem timestamp granularity". That is a worked example
of the construction this item needs, in this codebase, on an adjacent surface -- copy it
rather than reinventing. The same item's injected-instant seam for `DiskEchoRing` is the
model for removing the sleep.

## Implemented 2026-08-10

The line reference in "What" had **drifted**: the bare
`std::thread::sleep(Duration::from_millis(20))` was at `mod.rs:2948` at `e239c770`, not
`2914`, which is a string literal there. Recorded so the next reader does not conclude the
sleep was already gone.

`impl Fixture` gains `external_write` and `advance_mtime`, copied from
`scene_sessions/mod.rs` rather than reinvented, and **fourteen** staging sites route
through it. The sleep is deleted; no `thread::sleep` remains in the `doc_sessions` tests.

`advance_mtime` moves the mtime forward **relative to its current value**, so it does not
depend on the clock advancing at all -- which is why it replaces a sleep rather than
shortening one.

Three `workspace.write_text` calls are deliberately **left alone** (`mod.rs:2324`, `2350`,
`2410`): they are fixture seeding and helper setup, not external-edit staging, and
converting them would have been noise dressed as thoroughness.

Verified that the conversion did not break an intent: the whole `doc_sessions` suite passes
(196 tests including `control_socket`), and specifically
`reconcile_adopts_token_silently_on_equal_content`,
`reconcile_ignores_own_flush_echo` and `stale_prewrite_read_is_recognized_as_own_echo` --
the tests most likely to depend on a token *not* moving -- all pass.

### Three independent arrivals at one construction

This round's `chan-workspace` audit added `force_mtime_ns` to that crate's tests for the
same hazard, independently, while this repair was in flight.

```
scene_sessions/mod.rs        advance_mtime          v0.87.0
chan-workspace/workspace.rs  force_mtime_ns         v0.88.0, another lane
parallel-suite-flake-hygiene clears flushed_mtime   v0.82.0
```

Three lanes across three rounds reached **"stamp the timestamp rather than race for it"**
without coordinating. That is the direct answer to
[`timing-test-virtual-clock`](../done/timing-test-virtual-clock.md)'s warning that this
class had been answered three times with three *different* answers: here it has now been
answered the same way three times, which is a stronger argument for copying the
construction than for inventing a fourth.

## Provenance

Found by the `scene-conflict-test-is-load-sensitive` lane while establishing that its own
failure was test sequencing rather than a defect in the conflict machinery. Related:
[mtime-cas-silently-overwrites-external-edits](../done/mtime-cas-silently-overwrites-external-edits.md),
which is the production-side consequence of the same untrustworthy primitive.
