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
