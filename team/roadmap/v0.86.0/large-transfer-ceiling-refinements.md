# Three ceiling refinements the v0.85.0 transfer work leaves open

Status: REGISTERED for v0.86.0, deferred from v0.85.0 on 2026-08-06 with the large-transfer capability otherwise delivered.

## What

The v0.85.0 large-transfer work raises the write ceiling and admits transfer routes to a bounded lane. Three refinements of that ceiling were deliberately deferred rather than dropped. Each is stated here in behavioral terms, because a label like "cap accounting" hides which of them actually protects the machine and which does not.

## The three gaps, exactly

**1. Ranged reads are not charged against the ceiling, and whether that is permissive or conservative is UNSETTLED.** The requirement is that a ranged request be charged by transferred length rather than source size. On this branch there is no cap check on the Range path at all, and the effective cap is currently consulted in registry configuration rather than enforced on read paths. Whether the resulting gap lets a caller exceed the ceiling or merely leaves a read uncharged depends on how the ceiling comes to apply to reads versus writes, which this release does not settle: the item's own framing is a WRITE ceiling, and Range is a read path. Whoever implements the ceiling slice is in that code and settles this classification with it. It is deliberately not classified here.

**2. An archive of a tree larger than the ceiling streams to completion.** It is bounded by lane admission and by concurrency, so it cannot exhaust the process, but it is NOT bounded by `max_bytes`. This is a known permissive gap, not a conservative fallback: a caller who archives a tree above the ceiling gets the whole archive. Single-file transfers are bounded by the ceiling; archives are the exception. It has been unreachable in practice only because the 50 MiB wall made such trees untestable, and raising the ceiling is what makes it reachable.

**3. `doc_sessions/recovery.rs` validates against the old constant.** If the ceiling rises and recovery is not plumbed with it, recovery keeps the SMALLER budget. This one is conservative and was reasoned on its own rather than by grouping: recovery may refuse a document the transfer paths would accept, and cannot accept one they would refuse.

## Contract

- A ranged request consumes ceiling budget equal to the bytes it actually transfers.
- An archive is bounded by the effective ceiling cumulatively as it streams, and refuses at the bound with the same shape any other over-ceiling write uses, leaving no partial artifact.
- Recovery consumes the same server-reported effective ceiling as every other write path, rather than a separately maintained constant.

## Acceptance

- The Range classification is settled first, by reading the path rather than by grouping it with the other two: state whether an uncharged ranged read lets a caller exceed the ceiling or simply leaves a read outside a write ceiling's scope. Then a ranged read of a small window from a large file consumes budget proportional to the window, proven by a test that fails against source-size charging.
- An archive of a tree above the ceiling refuses at the bound, and the refusal leaves no partial archive and no temporary file. Prove it can go red by removing the accounting and observing the archive complete.
- Recovery accepts and refuses at exactly the same threshold as a direct write of the same size, driven from one reported value rather than two constants that can drift.

## Rough size

Small to medium, and gap 2 is the one worth doing first: it is the one known case where current behaviour lets an operation exceed the ceiling rather than refusing conservatively. Gap 1's priority cannot be set until its classification is settled, which is the first task in its acceptance rather than an assumption in its favour.

## Related question, NOT a follow-up: whether to bound the terminal download

Recorded as an open product decision rather than as work, and rewritten after an earlier version of this section got it wrong.

The terminal download path deliberately declares no `Content-Length`. That is not an omission: `crates/chan-server/src/routes/transfer.rs:826` asserts the header is absent, with the message "a live file stream must not promise its open-time length". The path streams what it reads and ends.

So a file that shrinks mid-read produces fewer bytes and contradicts nothing, because nothing was promised. That is a different contract from the workspace download path, which does declare a length and where ending early genuinely breaks a promise. Only the second is a defect.

The reason this cannot be treated as a simple improvement is that a declared length and a read bound are the same change. Seeding the reader with the open-time size to detect a shrink simultaneously bounds it, which breaks a file that GROWS during the read. Growth currently works, deliberately, and the assertion above is the design stating which side of that trade it chose.

So the question is two-directional and product-level: is shrink detection worth losing live-growth streaming on a path that promises neither? It also requires changing a test whose message records the current choice, which is the signal that it is a decision rather than a fix.

It belongs to the owner on its merits, not absorbed into a transfer slice, and this entry exists so it is not mistaken for a queued refinement.

**Constraint on any future implementation.** Whatever is decided, a bound must either preserve the growing-file contract or replace it knowingly. It must not arrive as a side effect of seeding a reader with a length, which is how it nearly arrived here: the reader change that detects a shrink is the same change that stops serving a file that grows, and only one of those two effects is usually the one being asked for. If the contract is replaced, the assertion at `transfer.rs:826` and its message are updated in the same change, so the record states the new choice rather than losing the old one.

## Two further residuals from the same round, recorded rather than assumed

**Copy-batch cancellation granularity.** The copy batch checks cancellation per source entry rather than per transferred byte. `Workspace::copy` owns the per-file work and takes no cancellation signal, so a single very large file still holds its lane slot until that file finishes, rather than releasing within a chunk the way every other admitted path does. Threading a signal into it changes `write_atomic_stream`'s signature across many callers and reaches `fs_ops.rs`, whose durability behaviour v0.85.0 deliberately froze, which is why it was not done then. The bound is still enforced and the slot is still released; only the latency of release is coarser on that one path.

**The composed responsiveness drive.** v0.85.0 proves that bulk work never draws from the pool interactive work runs on, in two pinned halves: a saturated-lane test requiring a blocking probe to still run on a pool far smaller than the lane's capacity, and existing source assertions that editor saves and terminal spawns reach the pool through `spawn_blocking`. The two are composed by an architectural argument rather than by a single end-to-end drive of the real editor-save and terminal-spawn routes under a saturated lane.

That composed drive was not done because it needs an `AppState` on an isolated tenant, and the shared test-state helper uses the process-wide lane. It would re-prove the same property through a longer path. It is registered here so that a later decision to want it is a decision, not the discovery of a silent assumption.

**Module-scope compile-time proof for the transport invariants.** `chan-tunnel-server` asserts two arithmetic relationships between transport constants in `const` blocks, so a violation is a compile error rather than a test failure. The two are the yamux connection window against streams times the default stream credit, and the h2 connection window above the stream window. Those blocks sit inside the crate's `#[cfg(test)]` module, so the proof happens when the crate's test targets are built, not when the library is built for a consumer.

The stronger form is `const _: () = assert!(..)` at module scope, outside `cfg(test)`: built on every target, and sited next to the production constructor whose precondition it protects rather than in a test module. It was deliberately not taken in v0.85.0. The current form is evaluated by every gate and CI run, since both build `--all-targets`; the residual exposure is a release build that never compiles tests, against constants that are literals and could only change by deliberate edit. Taking it also empties `transport_constants_hold_their_arithmetic_invariants`, which is a named anchor in the v0.85.0 evidence map, so the change must delete the test and update the evidence line in the same commit rather than leave a citation pointing at nothing.
