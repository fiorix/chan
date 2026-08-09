# The mtime-only CAS silently overwrites an external edit written inside the timestamp window

Status: REGISTERED 2026-08-09 during the v0.87.0 delivery round, from the
`scene-conflict-test-is-load-sensitive` investigation. Not implemented; registered rather
than fixed because the round's scope was locked at three items. **This is a data-loss
path, not a test defect** -- it is registered at a different severity from the item that
surfaced it.

## What

`Workspace::write_text_if_unchanged` (`crates/chan-workspace/src/workspace.rs:1771-1798`)
is the compare-and-swap that protects a user's on-disk file from being clobbered by a
session flush. Its entire conflict test is mtime equality:

```rust
let conflict = match (expected_mtime_ns, exists) {
    (None, false) => false,
    (Some(m), true) => current != Some(m),
    _ => true,
};
```

A filesystem timestamp does not advance on every write. When an external editor writes
inside the same non-advancing timestamp window as the token chan captured, `current ==
Some(m)`, the CAS reports no conflict, and the flush proceeds to
`write_atomic_stream` -- **silently overwriting the external edit**.

The same equality is the other half of the reconciler's flush-echo guard
(`crates/chan-server/src/scene_sessions/mod.rs:1698`), where the same collision makes chan
read a genuine hand edit as its own flush echo and fan nothing. So one root cause produces
both failure directions: the external edit is destroyed on write, or ignored on read.

The function's own docstring states the intent this violates
(`workspace.rs:1755-1770`):

> `None` + existing file: `WriteConflict`. The caller did not know a file was there;
> treating that as a silent overwrite would be the bug we're trying to prevent.

It also names a *different*, narrower residual race (another writer landing between the
check and the rename) and calls its window small. The timestamp-granularity case is
neither that race nor covered by that reasoning.

### The dependent site was not silent. It was confidently wrong.

The docstring on `write_text_if_unchanged` (`workspace.rs:1740-1756`) already names this
exact failure:

> Two saves landing within the same wall-clock second produce identical second-resolution
> mtimes; an editor saving on top of an autosave from a tool a few hundred ms earlier would
> **silently win**.

It then asserts the fix — "Ns resolution catches that" — and dismisses the remainder: on
filesystems carrying only seconds, "the check **degrades gracefully**".

Both of those are wrong, and the error is one conflation: **a nanosecond mtime *field* is not
a nanosecond clock**. Kernel timestamp granularity is typically the timer tick, so two writes
milliseconds apart share an mtime on ext4 with ns fields — measured at 29-66 collisions per
5000 write/stat pairs on the development host, rising under CPU pressure. And the
coarse-mtime case does not degrade gracefully; it is the case where the silent overwrite the
first paragraph describes is close to guaranteed.

That is why three engineers worked around this collision without anyone joining it up: the
site that depended on the assumption carried a comment saying the problem was already
solved. An absent note invites a question; a confident wrong one closes it.

The codebase already contains the counter-argument. `crates/chan-server/src/doc_sessions/mod.rs:25-30`:

> Because a filesystem's mtime and read-after-write cannot be trusted to identify our own
> flush echoes (network FUSE mounts re-stamp mtime and serve stale/empty reads), the
> reconciler also checks disk content against the session's [`DiskEchoRing`] and defers
> suspicious fold-ins until a second observation corroborates them.

So the project already concluded mtime is untrustworthy and built a content-hash backstop
(`DiskEchoRing`, `disk_echo::content_hash`) for the reconcile path. The CAS never got one.

## Evidence, 2026-08-09

Measured by the `scene-conflict-test-is-load-sensitive` lane, writing and stat-ing only,
counting how often two consecutive writes shared an mtime:

```
uncapped, idle, 3 runs of 5000 write/stat/write/stat:  29/5000, 12/5000, 37/5000
under a 1-CPU cgroup cap:                              66/5000
```

So roughly 0.2%-1.3% of back-to-back writes collide, and CPU pressure amplifies it. That
is the raw collision rate of the underlying primitive, not the rate at which a user loses
an edit: a real loss additionally needs an external editor's write to land inside that
same window. The rate at which that happens in practice is unmeasured and should be
established as part of picking a fix -- but the primitive is demonstrably not the
never-collides value the CAS assumes.

The collision was observed indirectly through
`scene_sessions::tests::flush_cas_conflict_enters_conflicted_after_corroboration`, whose
instrumented capture showed the token and the post-write mtime byte-identical:

```
token=Some(1786267823179111267)
after_write=Some(1786267823179111267)   equal=true
flushed_after=Some(1786267823180526355) state=Clean
```

## Contract

- A session flush does not overwrite an external edit it never observed, regardless of
  whether the filesystem timestamp advanced between the two writes.
- A genuine external edit is not misread as chan's own flush echo for the same reason.
- The fix does not depend on the filesystem clock advancing, and does not paper over it
  with a sleep or a retry budget.

## Acceptance

- A test stages an external write whose mtime is forced equal to the captured token, and
  the CAS still reports a conflict rather than overwriting.
- The same construction on the flush-echo path fans the external edit rather than
  swallowing it.
- The repaired behaviour holds under the 1-CPU cgroup rig that amplifies the collision,
  not only on an idle host.

## Rough size

Medium, and mostly a design question rather than a typing one: the mechanism already
exists one layer up. `DiskEchoRing` plus `disk_echo::content_hash` is the established
answer to "mtime cannot be trusted", so the likely shape is giving the CAS a content-hash
backstop for the case where the mtime matches -- read-and-hash before the rename when the
timestamps are equal, rather than trusting equality. The cost of that extra read on the
hot flush path is the thing to weigh, and is why this wants a design pass rather than a
patch.

## Provenance

Surfaced by `scene-conflict-test-is-load-sensitive`, whose contract says "a race reachable
by the test is presumed reachable by production until shown otherwise". That lane's own
defect was test sequencing; this is what the same mechanism does outside the tests, and it
is the reason that presumption is worded the way it is.
