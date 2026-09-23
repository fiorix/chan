# A dropped indexer strands the recovery slot it claimed

Status: shipped in [v0.100.0](../../release/release-v0.100.0.md): A coordinator that goes away mid-pass requeues its recovery claim, and a recovery action that keeps failing waits a cooldown between attempts.

## What was seen

`Drop for Indexer` aborts the coordinator task (`crates/chan-server/src/indexer.rs`) while a `spawn_blocking` closure that has already started runs to completion, so a pass the coordinator claimed is never finished and the workspace's recovery slot stays claimed; a later coordinator on the same workspace then waits on it. In the same loop, a pass that ends `ActionFailed` sets an error status and falls through to the loop's end condition, where only a `FullRebuild` has taken the cooldown (`next_start_at`), so a persistently failing `Reconcile` or `Replay` retries with no spacing. Only the refresh-driven retries were bounded during v0.99.0 (`MAX_REPORT_REFRESH_ATTEMPTS`).

## Desired contract

A coordinator that goes away releases the pass it claimed, so the next coordinator over that workspace can make progress; and a recovery action that keeps failing is spaced and bounded the way a rebuild is.

## Boundaries

`crates/chan-server/src/indexer.rs` (`Drop for Indexer`, `spawn_coordinator` and its pass loop) and `crates/chan-workspace/src/workspace.rs` (the recovery slot, `finish_recovery`, `RecoveryPlan::derive`).

## Acceptance

1. A test drops an `Indexer` mid-pass and shows a later coordinator claiming and completing a pass on the same workspace, red before the change.
2. A persistently failing `Reconcile` is shown to be spaced, with the spacing asserted rather than timed loosely.
3. The rebuild cooldown and the bounded report-refresh retries keep their current behaviour, pinned.
4. The status a workspace publishes while a pass keeps failing is stated in the documents.
