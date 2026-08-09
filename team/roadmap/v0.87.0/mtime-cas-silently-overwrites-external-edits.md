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
exists one layer up. `DiskEchoRing` is the established answer to "mtime cannot be
trusted", so the shape is giving the CAS a backstop for the case where the mtime matches:
re-read before the rename when the timestamps are equal, rather than trusting equality.

Compare **bytes**, not a hash. `disk_echo::content_hash` is FNV-1a, which is right for an
echo-ring heuristic and wrong here: on a data-loss guard a hash collision is a silent
overwrite, which is the exact failure being fixed. The caller already holds the bytes it
last saw, so comparing them removes the collision question rather than bounding it, needs
no hash algorithm shared across crates, and is cheaper than hashing.

The cost of the extra read on the hot flush path is the thing to weigh, and is why this
wants a design pass rather than a patch.

## Provenance

Surfaced by `scene-conflict-test-is-load-sensitive`, whose contract says "a race reachable
by the test is presumed reachable by production until shown otherwise". That lane's own
defect was test sequencing; this is what the same mechanism does outside the tests, and it
is the reason that presumption is worded the way it is.

## Implemented 2026-08-09 (`69a4a651`)

`write_text_if_unchanged` takes the bytes the caller last observed and verifies a matching mtime against the file instead of trusting it. Bytes are compared rather than hashed, so there is no collision question on a guard whose failure mode is the silent overwrite it exists to prevent. A disk that cannot be read to check is a conflict, not a write: a write that cannot be shown to be safe is refused rather than risked. Callers holding no belief about the disk pass `None` and keep the mtime-only contract, which is what `routes/drafts.rs`, `chan-llm`'s write tool, and the internal link rewrite do, since a client-supplied token comes with no claim about content.

Only a baseline that is the file byte for byte can answer the question, and neither session's baseline is that by default: a scene baseline is a re-serialised scene and a document baseline is newline normalised. `DurableBaseline` therefore carries `verbatim`, set where the bytes are known to match and false where they are a canonical rendering, a restored recovery record, or anything else unproven. The flush offers its baseline only when it is verbatim and its token still agrees with the session's. Keep-mine resolution drops the claim on purpose: overwriting whatever the disk holds is the whole point of that button, so it runs on the token alone.

The read half is the same collision seen from the other side. The scene reconcile's flush-echo guard settled an event as chan's own echo on a matching token alone, so a hand edit inside that window was swallowed. The guard now moves after the disk read and requires the bytes to be the ones the session last wrote, which costs the read that path was about to make anyway.

### Cost

Release build, tmpfs, warm cache, per operation. tmpfs is the worst case for the *ratio*, not the typical one: there is no fsync for the read to amortise against, so on real storage the write it is measured against is far more expensive and the same read costs proportionally less.

```
size     CAS write   verify read+compare   overhead
4 KiB     76.6 us      5.7 us               7.4%
64 KiB    95.7 us     17.0 us              17.8%
1 MiB    488.7 us    240.6 us              49.2%
```

Bounded above by the semantic text budget, which refuses anything larger with `WriteTooLarge { limit: 2097152 }`, so the worst case is roughly half a millisecond on a path already doing a durable write. Scenes and markdown documents in practice are the 4 KiB row.

A recency gate that skips the read when the token is older than the timestamp window was considered and rejected. A safe window has to be an upper bound on filesystem granularity, and this function's own documentation notes mounts that report only seconds; guessing that bound wrong reopens the hole **silently**. Trading a detectable 240us for an undetectable data-loss window is the wrong direction, and it is written down here because the percentage above will tempt the next reader toward exactly that.

### Validation

`chan-server` 1066 tests and `chan-workspace` 657 tests green. Under the 1-CPU cgroup rig that amplifies the collision (`sdme set --cpus 1`, verified from the host at `machine.slice/sdme@chan-v087-scene.service` as `cpu.max: 100000 100000`, `--test-threads=32`): `scene_sessions` 0 red in 20 runs and the `write_text_if_unchanged` tests 0 red in 20 runs. Twelve full-suite runs under the same cap red only in the load-sensitive tests this round has been registering separately, none of them on this change's surfaces.

Four mutation probes, each recorded with what it fails:

- Backstop disabled (`disk_still_holds` always true): fails exactly the three tests that claim it, `write_text_if_unchanged_conflicts_when_an_external_edit_kept_the_mtime`, `write_text_if_unchanged_conflicts_when_the_disk_cannot_be_verified`, and `flush_refuses_to_overwrite_an_edit_that_kept_the_mtime`.
- An unverifiable disk permitted (`is_ok_and` relaxed to `map_or(true, ..)`): fails exactly `write_text_if_unchanged_conflicts_when_the_disk_cannot_be_verified`.
- The echo guard trusting the token alone: fails exactly `external_edit_that_kept_the_mtime_still_fans`.
- A canonical baseline treated as verbatim: 11 failures across both session suites, including `first_edit_after_crlf_seed_flushes_lf_to_disk`. The `verbatim` distinction is load-bearing, not decoration.

### What this does not close

Four limitations, all narrow and all deliberate. The fix makes the CAS verifiable where a caller can vouch for the disk; it does not make the timestamp trustworthy.

1. **Echo drift.** When `baseline.mtime_ns` and `flushed_mtime_ns` disagree, which the reconcile's echo branch causes by adopting a fresh token without moving the baseline, no expectation is offered and **the data-loss window is open exactly as it was before this change**. Supplying the stale baseline there would manufacture a false conflict on every echo, which is worse; this is the correct trade rather than an oversight.
2. **A session that has not flushed since seeding.** Its baseline is a canonical rendering, so `verbatim` is false and the window is open until its first flush. A scene file already in canonical form, or a document already LF, is verbatim from the seed and covered immediately.
3. **Callers with no belief.** `drafts.rs`, `chan-llm`, and the internal link rewrite pass `None` and remain mtime-only. A client-supplied `If-Unmodified-Since`-style token carries no content claim, so there is nothing to verify against; giving those paths the same guarantee needs an API that carries the caller's view of the disk.
4. **The check-to-rename race is unchanged.** A writer landing between the verification and the rename still wins, as the function's documentation already says. The window is one read wider than before and the same watcher event still surfaces the foreign change.
