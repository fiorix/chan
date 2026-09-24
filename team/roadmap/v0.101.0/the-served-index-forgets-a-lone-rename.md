# The served index forgets the destination of a lone rename

Status: raised during v0.101.0 on 2026-09-24 from the independent review of `v0101/workspace-search-index` (a source reading against `main` at `09f1b6aea`, confirmed by the lane on a Linux-runnable test of the classification arm), accepted by the owner the same day, and landed with that lane's second round. Not reproduced on macOS: no host here runs FSEvents.

## What was seen

chan-server's own indexer classified a file `Renamed` event whose only path sat in the source slot as a delete (`classify_watch_event`, `crates/chan-server/src/indexer.rs`), and `apply_watch_change` forgot that path without a stat. FSEvents reports a rename's destination in that slot, so on macOS `mv a.md b.md` forgot both `a.md` and `b.md` from the served index, and an editor's atomic save (a temporary file renamed over `a.md`) forgot `a.md`, until a reconcile. The watcher's design text says consumers must stat that slot, and the report path did. Directory renames were unaffected because they rebuild.

## Desired contract

A rename event that names one path is a change to that path: one that exists is indexed, one that is gone is forgotten. The served index and the graph indexer answer the same way.

## What shipped

`classify_watch_event` queues the source slot of a file `Renamed` as a delete only when the rename is paired; a lone path is queued as a change and the existing stat in `apply_watch_change` decides: a regular file is indexed, a missing path is forgotten through the missing arm. Two tests pin it, `mv a.md b.md` as two lone events and an atomic save over `a.md`. Directory renames keep their rebuild.

## Boundaries

`crates/chan-server/src/indexer.rs`. The case-only rename on a case-insensitive volume is a separate item.
