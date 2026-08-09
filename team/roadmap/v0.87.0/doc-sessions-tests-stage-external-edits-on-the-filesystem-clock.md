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

## The likely fix direction is already being built elsewhere

Amended 2026-08-09. [mtime-cas-silently-overwrites-external-edits](mtime-cas-silently-overwrites-external-edits.md)
gives `write_text_if_unchanged` a content baseline alongside the mtime token, and wires it
through `doc_sessions`' own `FlushJob` (`doc_sessions/mod.rs:~1812`). That changes what
these tests are staging *against*.

The clearest case is `same_bytes_rewrite_refreshes_the_retained_token`
(`doc_sessions/mod.rs:2914`), whose 20 ms sleep exists so an external re-save of **identical
bytes** lands a different mtime, so the test can assert the retained side adopted the fresh
token. Once the CAS keys on content as well as mtime, a same-bytes rewrite is a no-op and
there may be no stale token left to refresh — so the sleep is not a timing wait to
virtualise, it is scaffolding for a mechanism that is being replaced.

Read this item against the landed CAS work before starting. Three outcomes are live for each
affected test: the wait becomes unnecessary because mtime is no longer the key, the test
keeps its shape but its assertion changes meaning, or the test is rewritten by the CAS
change. Repairing a timing wait whose subject is being replaced underneath it is how a sweep
silently reverts someone else's fix.

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
[mtime-cas-silently-overwrites-external-edits](mtime-cas-silently-overwrites-external-edits.md),
which is the production-side consequence of the same untrustworthy primitive.
