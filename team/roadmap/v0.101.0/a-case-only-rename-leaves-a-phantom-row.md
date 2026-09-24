# A case-only rename leaves a phantom row on a case-insensitive volume

Status: raised during v0.101.0 on 2026-09-24; not accepted. From the independent review of `v0101/workspace-search-index` (its low finding 1) and that lane's second-round report, which reproduced it on a Linux tmpfs mounted with casefold inside the build container (`dev/v0101-tasks/evidence/wsix/fix2-probe-casefold-graph-indexer-579fa7b-2.log` and `fix2-probe-casefold-served-fab8485.log` in the development tree). A two-step rename reaches the state APFS reaches in one.

## What was seen

On a case-insensitive volume `mv Note.md note.md` arrives at both indexers as two lone `Renamed` events. Since the lone arms stat the path (`v0101/workspace-search-index`), `exists("Note.md")` and `exists("note.md")` are both true, both names are indexed, and the graph and the served index hold two rows for one file. Reconcile's deletion pass keeps a known path whose `symlink_metadata` succeeds, which it does under the old case, so the phantom survives reconcile; only a full rebuild or deleting the file clears it. Before the stat, both indexers forgot both names and the new name was missing until a reconcile. Reconcile has the same blind spot on its own: a case-only rename made while the server is down leaves the phantom at cold open.

## Desired contract

A case-only rename on a case-insensitive volume leaves one row, under the name the directory holds.

## What to do

Confirm a lone path's exact name against its parent directory's listing before indexing it, in both lone arms, and apply the same confirmation in reconcile's deletion pass so a known path whose stored spelling is no longer the directory's is forgotten. It can be tested on a casefold tmpfs in an sdme container (a root mount on a 6.13 or later kernel), not in the Linux gate; the report names the probe shape.

## Boundaries

`crates/chan-workspace/src/{indexer,workspace}.rs` and `crates/chan-server/src/indexer.rs`.
