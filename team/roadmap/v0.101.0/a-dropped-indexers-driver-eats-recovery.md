# A dropped indexer's driver swallows a recovery wake

Status: accepted for v0.101.0 by the owner on 2026-09-24; raised during v0.100.0 on 2026-09-23. From the Lead follow-ups ledger (2026-09-22 22:03Z, SecondWorker order 2 report, by reading); pre-existing and described in the driver's own comment. A source reading against `main` at `6237c2677`.

## What was seen

`Indexer::spawn` installs a `CoordinatorDriver` on the workspace (`crates/chan-server/src/indexer.rs:242`); its `wake` sends on an unbounded channel and discards the result (`:337-345`). Dropping the indexer leaves that driver installed, so a requeued recovery pass wakes a sender whose receiver is gone and the wake is lost. `Workspace::recovery_is_unowned` (`crates/chan-workspace/src/workspace.rs:1297`) still reads false while the stale driver is installed (`set_recovery_driver`, `:1286`), so nothing else claims the pass.

## What to do

Establish whether a workspace can outlive every indexer that served it. If it can, clear the driver when its indexer drops (or make a failed send mark recovery unowned), with a test that drops the indexer, requeues a pass and shows it claimed.
