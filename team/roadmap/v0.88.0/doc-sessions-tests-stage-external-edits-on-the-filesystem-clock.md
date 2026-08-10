# doc_sessions tests stage external edits on the filesystem clock, with one sleep already hand-rolled

Status: REGISTERED 2026-08-09 during the v0.87.0 delivery round, from the
`scene-conflict-test-is-load-sensitive` investigation. Not implemented; out of that
round's locked scope and a different surface from the lane that found it.

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

## Provenance

Found by the `scene-conflict-test-is-load-sensitive` lane while establishing that its own
failure was test sequencing rather than a defect in the conflict machinery. Related:
[mtime-cas-silently-overwrites-external-edits](../done/mtime-cas-silently-overwrites-external-edits.md),
which is the production-side consequence of the same untrustworthy primitive.
