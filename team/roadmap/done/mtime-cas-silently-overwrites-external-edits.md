# The mtime-only CAS silently overwrites an external edit written inside the timestamp window

Closed: shipped in [v0.87.0](../release/release-v0.87.0.md).

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

### Owner validation, 2026-08-09, both directions live

Superseding the PARTIAL note below, which is kept because its reasoning is why the second test was run at all.

**Convergence.** The owner opened a file and an external `>>` append landed from a shell outside chan. The line appeared in the editor within a second, no banner. An external edit reaches an open editor without inventing a conflict.

**Detection.** With the owner typing continuously so the autosave debounce kept resetting, an external write replaced the whole file while an unflushed edit was pending. **The conflict banner fired.** This is the direction a quiet session cannot evidence, and the reason the item was held: an inert guard and a correct one look identical from the outside until something forces the conflict.

**The autosave window is roughly 750 ms**, measured rather than assumed: the owner's last flush stamped `18:12:31.922` and the external replace landed at `18:12:32.671`. Two earlier attempts at the detection test failed to reach the conflict path at all because the flush beat the external write, turning each into another convergence test. Anyone reproducing this needs continuous typing, not a pause-then-signal.

Incidental, and it answers a standing worry rather than this item: across the session the debounce flushed sub-second and preserved every keystroke in order, with the file growing correctly throughout.

**A false alarm, recorded because the failure mode is instructive.** The first detection attempt appeared to show a flush destroying an external edit. It did not. The helper printing the pre-write disk state used `head -3`, so the content below line three was invisible, and a truncated view was read as deletion. The instrument was fixed to print the whole file before the retry. Three separate readings this session went wrong the same way, all of them mine: a bucket count that included prose, a stale-artifact theory that a rebuild disproved, and this. A partial view stated as a whole one is worth more suspicion than a result that merely looks bad.

### Owner validation, 2026-08-09, PARTIAL (superseded)

Run against merged `main` (`3ecc6e87`) on a standalone host server, after the owner asked whether the editor scenarios had been exercised at all. They had not: no lane journal in the round mentions `browser-smoke`, and `make pre-push` does not invoke it.

Six browser checks were run first. `50-editor-collab`, `55-external-edit-reopen`, `57-external-restore-converge`, `63-external-shrink-convergence`, and `64-conflict-banner-reload` all pass. `56-external-edit-matrix` fails on a navigation timeout that moves between steps and never on a content assertion; that is registered separately as [browser-smoke-is-unrunnable-and-rate-based](browser-smoke-is-unrunnable-and-rate-based.md) and is a harness defect, not this change. `56`'s own step output records `pill: false` on atomic save, closed-window reopen, and a dirty tab.

The owner then edited files in a live browser session and reported no spurious conflict banner at any point.

**What that does not establish, and why this section says PARTIAL.** A quiet session is consistent with both a correct guard and an inert one: had the CAS stopped detecting conflicts entirely, the same session would have looked identical. The spurious-banner direction is owner-verified. The **detection** direction is proven only by the unit tests, the four mutation probes above, and `64-conflict-banner-reload`, with no owner-observed instance of the banner firing when it should.

Two adversarial cases were offered and not yet run: an external write to a file the owner has open with no competing edit, which must converge without a banner; and an external write against unsaved owner edits, which must raise the banner and offer a working reload from disk. The second is the load-bearing one. Until it runs, this item's live evidence covers the false-positive direction only.

Not covered at all: a cloud-synced directory, where a genuine second writer now produces conflicts the previous mtime-only CAS would have silently overwritten.

### What this does not close

Four limitations, all narrow and all deliberate. The fix makes the CAS verifiable where a caller can vouch for the disk; it does not make the timestamp trustworthy.

1. **Echo drift.** When `baseline.mtime_ns` and `flushed_mtime_ns` disagree, which the reconcile's echo branch causes by adopting a fresh token without moving the baseline, no expectation is offered and **the data-loss window is open exactly as it was before this change**. Supplying the stale baseline there would manufacture a false conflict on every echo, which is worse; this is the correct trade rather than an oversight.
2. **A session that has not flushed since seeding.** Its baseline is a canonical rendering, so `verbatim` is false and the window is open until its first flush. A scene file already in canonical form, or a document already LF, is verbatim from the seed and covered immediately.
3. **Callers with no belief.** `drafts.rs`, `chan-llm`, and the internal link rewrite pass `None` and remain mtime-only. A client-supplied `If-Unmodified-Since`-style token carries no content claim, so there is nothing to verify against; giving those paths the same guarantee needs an API that carries the caller's view of the disk.
4. **The check-to-rename race is unchanged.** A writer landing between the verification and the rename still wins, as the function's documentation already says. The window is one read wider than before and the same watcher event still surfaces the foreign change.
