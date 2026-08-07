# Three ceiling refinements the v0.85.0 transfer work leaves open

Status: REGISTERED for v0.86.0, deferred from v0.85.0 on 2026-08-06 with the large-transfer capability otherwise delivered.

## What

The v0.85.0 large-transfer work raises the write ceiling and admits transfer routes to a bounded lane. Three refinements of that ceiling were deliberately deferred rather than dropped. Each is stated here in behavioral terms, because a label like "cap accounting" hides which of them actually protects the machine and which does not.

## The three gaps, exactly

**1. Ranged reads are not charged against the ceiling, and whether that is permissive or conservative is UNSETTLED.** The requirement is that a ranged request be charged by transferred length rather than source size. On this branch there is no cap check on the Range path at all, and the effective cap is currently consulted in registry configuration rather than enforced on read paths. Whether the resulting gap lets a caller exceed the ceiling or merely leaves a read uncharged depends on how the ceiling comes to apply to reads versus writes, which this release does not settle: the item's own framing is a WRITE ceiling, and Range is a read path. Whoever implements the ceiling slice is in that code and settles this classification with it. It is deliberately not classified here.

**2. An archive of a tree larger than the ceiling streams to completion.** It is bounded by lane admission and by concurrency, so it cannot exhaust the process, but it is NOT bounded by `max_bytes`. This is a known permissive gap, not a conservative fallback: a caller who archives a tree above the ceiling gets the whole archive. Single-file transfers are bounded by the ceiling; archives are the exception. It has been unreachable in practice only because the 50 MiB wall made such trees untestable, and raising the ceiling is what makes it reachable.

**3. `doc_sessions/recovery.rs` validates against the old constant.** If the ceiling rises and recovery is not plumbed with it, recovery keeps the SMALLER budget. This one is conservative and was reasoned on its own rather than by grouping: recovery may refuse a document the transfer paths would accept, and cannot accept one they would refuse.

## Re-verified 2026-08-07, with one gap overtaken by a ruling

**Gap 1 holds, and its classification is closer to decided than the text above suggests.** The Range path still has no ceiling check: `binary_plan_sync` (`routes/files.rs:1141`) resolves the range and reads through `read_bytes_bounded_slice` (`workspace.rs:1545`), which clamps against the file's own size only, and `stream_planned_workspace_download_tracked` (`routes/files.rs:497`) takes no ceiling argument. But the clause above saying the cap is "consulted in registry configuration rather than enforced on read paths" is stale: the terminal download arm now enforces it (`routes/transfer.rs:352` into `terminal_download_plan`'s refusal at `:508-510`), and that arm accepts no Range header at all. The Range path is therefore exclusively the workspace download arm, which the section below already rules deliberately unbounded on read. Settling gap 1 means either extending that ruling to charging (a read outside a write ceiling's scope) or overturning it, not discovering it.

**Gap 2 holds and is wider than written.** Both archive arms are unbounded: the terminal arm carries an in-source acknowledgement at `routes/transfer.rs:491-500` that an archive has no size until built, and the workspace arm builds through the same unbounded `build_tar_into` (`routes/files.rs:547-566`). The sentence "single-file transfers are bounded by the ceiling; archives are the exception" is true only on the terminal tenant; on the workspace arm single-file reads are also unbounded, so the archive is not an exception there. And the acceptance below is not executable as written: `build_tar_into` streams through `TarChannelWriter` straight into the response channel, so there is no temporary file and no partial artifact to forbid. Cumulative accounting can refuse before the first byte or error the body mid-stream; bytes already sent cannot be unsent. The acceptance must be restated in those terms.

**Gap 3 is overtaken and should be struck rather than implemented.** Three hours after this item was written, the transfer-ceiling change landed a source ruling in `recovery.rs:17-25` that the recovery limit deliberately does not track the workspace transfer ceiling, because pointing it at a configurable ceiling would turn a corrupt or hostile record into a multi-gigabyte allocation at file open; it says plainly "Do not unify the two constants." Recovery also already consumes a plumbed budget, `record.authority.write_budget.min(RECOVERY_RECORD_LIMIT)` (`recovery.rs:271`) sourced from `semantic_write_budget` (`doc_sessions/mod.rs:488`), and recovery is a text path governed by `TEXT_WRITE_LIMIT`, not by `transfer_max_bytes`, which governs `AtomicWriteKind::Bytes` only (`workspace.rs:1500`, `:4341`). The round's work on this gap is to confirm the ruling and remove the gap from the contract, not to plumb the ceiling.

## Ruling 2026-08-07: the item's substance is gap 2

The owner accepted the narrowing, which resolves two of the three gaps by ruling rather than by code:

- **Gap 1 is closed by extending the workspace-arm read ruling.** The Range path exists only on the workspace download arm, which this item already rules deliberately unbounded on read because refusing a user their own file protects nothing worth that cost. Charging ranged reads against a write ceiling is outside that ceiling's scope; an uncharged ranged read is the ruling, not a defect. The first contract bullet below is overridden accordingly.
- **Gap 3 is struck.** The `recovery.rs` ruling that landed after this item was written is confirmed correct: recovery is a text path with its own plumbed budget, and unifying its limit with a configurable transfer ceiling would convert a hostile record into an arbitrary allocation at open. The third contract bullet below is overridden; no code changes.
- **Gap 2 is the work**, on both arms, with the acceptance restated in streamable terms: cumulative accounting refuses before the first byte when the plan can already see the bound is exceeded, and otherwise errors the response body at the bound mid-stream; bytes already sent cannot be unsent and no temporary file exists to clean. The red-proof (remove the accounting, observe the archive complete) stands.

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

## The terminal download bound was ruled and delivered, and it did not settle shrink detection

This section recorded an open product decision: whether to bound the terminal download. It is answered. The ceiling bounds it, with a clear error at the cap, and v0.85.0 implements that on the terminal tenant.

The delivered behavior is narrower than "the growing-file contract is replaced", and the difference is worth holding because the shorter wording invites the wider reading:

- Growth **above** the ceiling now fails. That is what was decided.
- Growth **below** the ceiling still streams, unchanged.
- Shrink is still not an error, because nothing is promised.

The response still declares no `Content-Length`, and the assertion pinning that is kept with its message rewritten to state the post-ruling contract. A ceiling is a maximum rather than a count, so the byte total is still unknown when headers are chosen; declaring the size seen at open would reintroduce exactly the truncation the constraint below warns about. The assertion is identified by its subject rather than by a line number, because this section has already outlived one such citation.

**Shrink detection is NOT settled by that ruling and stays open for the owner.** The original framing here was shrink detection against live growth, which is a different axis from a configured ceiling. Bounding by `max_bytes` needs no open-time length, so it buys no shrink detection and costs no growth below the ceiling; the two questions only looked like one because a length-seeded reader would have answered both at once. Whether a path that promises no length should nevertheless detect a short read is still a product decision on its merits.

**The workspace download arm stays deliberately unbounded on read.** It declares a `Content-Length` from the file's own open-time size and consults no ceiling, and the ruling's literal wording reaches it. It is excluded on purpose: bounding it would refuse a user a file already sitting in their own workspace, which fails toward "you cannot get your data" rather than fail-safe. A write ceiling stops chan consuming unbounded disk; a read ceiling on a user's own file protects nothing that is worth that cost. Gap 1 above covers the Range accounting question on that same path, so the two are related but not the same decision.

**Constraint on any future implementation.** A bound must either preserve the growing-file contract or replace it knowingly, and must not arrive as a side effect of seeding a reader with a length. That is how it nearly arrived the first time: the reader change that detects a shrink is the same change that stops serving a file that grows, and only one of those two effects is usually the one being asked for. If the contract is replaced, the no-length assertion and its message are updated in the same change, so the record states the new choice rather than losing the old one. The v0.85.0 bound was implemented under this constraint and satisfies it: it bounds without declaring, and the assertion's message was rewritten in the same commit.

## Two further residuals from the same round, recorded rather than assumed

**Copy-batch cancellation granularity.** The copy batch checks cancellation per source entry rather than per transferred byte. `Workspace::copy` owns the per-file work and takes no cancellation signal, so a single very large file still holds its lane slot until that file finishes, rather than releasing within a chunk the way every other admitted path does. Threading a signal into it changes `write_atomic_stream`'s signature across many callers and reaches `fs_ops.rs`, whose durability behaviour v0.85.0 deliberately froze, which is why it was not done then. The bound is still enforced and the slot is still released; only the latency of release is coarser on that one path.

**The composed responsiveness drive.** v0.85.0 proves that bulk work never draws from the pool interactive work runs on, in two pinned halves: a saturated-lane test requiring a blocking probe to still run on a pool far smaller than the lane's capacity, and existing source assertions that editor saves and terminal spawns reach the pool through `spawn_blocking`. The two are composed by an architectural argument rather than by a single end-to-end drive of the real editor-save and terminal-spawn routes under a saturated lane.

That composed drive was not done because it needs an `AppState` on an isolated tenant, and the shared test-state helper uses the process-wide lane. It would re-prove the same property through a longer path. It is registered here so that a later decision to want it is a decision, not the discovery of a silent assumption.

**Module-scope compile-time proof for the transport invariants.** `chan-tunnel-server` asserts two arithmetic relationships between transport constants in `const` blocks, so a violation is a compile error rather than a test failure. The two are the yamux connection window against streams times the default stream credit, and the h2 connection window above the stream window. Those blocks sit inside the crate's `#[cfg(test)]` module, so the proof happens when the crate's test targets are built, not when the library is built for a consumer.

The stronger form is `const _: () = assert!(..)` at module scope, outside `cfg(test)`: built on every target, and sited next to the production constructor whose precondition it protects rather than in a test module. It was deliberately not taken in v0.85.0. The current form is evaluated by every gate and CI run, since both build `--all-targets`; the residual exposure is a release build that never compiles tests, against constants that are literals and could only change by deliberate edit. Taking it also empties `transport_constants_hold_their_arithmetic_invariants`, which is a named anchor in the v0.85.0 evidence map, so the change must delete the test and update the evidence line in the same commit rather than leave a citation pointing at nothing.
