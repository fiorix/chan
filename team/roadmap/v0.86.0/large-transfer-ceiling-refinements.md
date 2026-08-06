# Three ceiling refinements the v0.85.0 transfer work leaves open

Status: REGISTERED for v0.86.0, deferred from v0.85.0 on 2026-08-06 with the large-transfer capability otherwise delivered.

## What

The v0.85.0 large-transfer work raises the write ceiling and admits transfer routes to a bounded lane. Three refinements of that ceiling were deliberately deferred rather than dropped. Each is stated here in behavioral terms, because a label like "cap accounting" hides which of them actually protects the machine and which does not.

## The three gaps, exactly

**1. A ranged request is charged by source size rather than transferred length.** A Range read consumes ceiling budget as though the whole file were transferred, so it over-charges rather than under-charges. Conservative, and no consumer exists: the v0.84.0 audit established that single-range serving exists in the server with no chan client issuing ranged retries.

**2. An archive of a tree larger than the ceiling streams to completion.** It is bounded by lane admission and by concurrency, so it cannot exhaust the process, but it is NOT bounded by `max_bytes`. This is the one gap of the three that does not fail safe, and it is stated plainly rather than softened: a caller who archives a tree above the ceiling gets the whole archive. It has been unreachable in practice only because the 50 MiB wall made such trees untestable, and raising the ceiling is what makes it reachable.

**3. `doc_sessions/recovery.rs` validates against the old constant.** If the ceiling rises and recovery is not plumbed with it, recovery keeps the SMALLER budget. Fails closed: a recovery that would exceed the old constant is refused rather than allowed.

## Contract

- A ranged request consumes ceiling budget equal to the bytes it actually transfers.
- An archive is bounded by the effective ceiling cumulatively as it streams, and refuses at the bound with the same shape any other over-ceiling write uses, leaving no partial artifact.
- Recovery consumes the same server-reported effective ceiling as every other write path, rather than a separately maintained constant.

## Acceptance

- A ranged read of a small window from a large file consumes budget proportional to the window, proven by a test that fails against source-size charging.
- An archive of a tree above the ceiling refuses at the bound, and the refusal leaves no partial archive and no temporary file. Prove it can go red by removing the accounting and observing the archive complete.
- Recovery accepts and refuses at exactly the same threshold as a direct write of the same size, driven from one reported value rather than two constants that can drift.

## Rough size

Small to medium, and gap 2 is the one worth doing first. It is the only one of the three where the current behaviour lets an operation exceed the ceiling rather than refusing conservatively.
