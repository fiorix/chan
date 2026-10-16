# A failed vector orphan prune lets a rebuild commit BM25 deletions whose vector shards outlive them

Status: raised on 2026-10-16 by the lead from the review seat's read of the rebuild skip item's design and the runtime seat's reading at source; written down with the repair's shape; built by the runtime seat after its lane's items; owner the runtime seat.

## What was seen

Read at source at `0f0b7fb33` and constructed by the review seat at `63930d5bb` (`dev/v0107-team/evidence/Review107/orphpr-trigger-1/`). After its walk, `Index::build_all` (`crates/chan-workspace/src/index/facade.rs`, the cleanup after the files loop) prunes the vector shards of paths not in `visited` and, apart from that, deletes the BM25 documents of the paths a prior commit indexed that are not in `visited`, then commits. `prune_orphans` deletes every orphan it knows by name and keeps a shard's entry only when its unlink fails, warning instead of returning the error, so a shard that cannot be deleted (the embeddings directory at mode 500 in the construction) stays on disk and is served and reloaded on reopen, while the stale pass deletes and commits that path's document: the state `Index::forget` names and refuses by its order (vectors first, then BM25, with `?` between them), a semantic hit pointing at a path BM25, and the editor, consider gone. A failure of the directory's enumeration (mode 300 in the construction) does not reach the state: the orphans known in memory are deleted by name before the enumeration, so the shard and the document both go. The comment above the pass calls its errors non-fatal because the next reindex retries the cleanup, which is true of a shard left behind on its own and not of the ordering: until a later prune deletes the shard, it is an orphan with a hit and no document.

Not established: that any user has met it (it needs a shard's unlink to fail during a rebuild); the frequency of such a failure.

## Desired contract

A rebuild's orphan cleanup keeps `forget`'s order per path: a BM25 document is deleted only once its vector shard is gone, or was never there. When a shard cannot be deleted, the rebuild leaves that path's BM25 document in place and says so, and the next rebuild reclaims both together; a stale document whose path never had a shard (a BM25-only rebuild; a file with no chunks) still goes.

## What to do

In `build_all`'s cleanup, make the per-path rule the one: `prune_orphans` reports the paths whose shards it could not delete (the failed deletes, by name), and the BM25 stale-doc pass deletes every stale document except those paths', warning once per deferred path. A stale document whose path has no shard at all is deleted as today. The enumeration failure keeps its warning; a conservative skip of the pass on that failure is allowed but not required, since the state is not reached through it. Keep the rebuild's other writes and its commit as they are. A `cfg(test)` fault on a shard's unlink (as the rebuild skip item's fault seam does for the journal) is the pin's instrument.

## Boundaries

`Index::forget` and `forget_many` are not changed; the rebuild's policy for readable and unreadable files (the rebuild skip item's) is not changed; the BM25 `known_paths` enumeration failure keeps its own handling (the cleanup skipped with a warning).

## Acceptance

1. Red first, the per-shard fault: a warm index with one path removed from disk and that path's shard made undeletable, the enumeration succeeding: after the rebuild the path's BM25 document is gone while its shard remains (the state); with the repair the document remains with the shard and one warning names the deferred path; a following rebuild with the unlink succeeding removes both (one mutant: the stale pass run regardless, red). The enumeration fault is the control: the shard and the document both go, with the repair as before it.
2. A stale document whose path never had a shard goes in the same rebuild (a BM25-only index with one path removed), one mutant deferring every stale path, red; and the other paths' shards and documents go as today.
3. The whole `chan-workspace` suite green at two threads at the landed tip.

## The owner's word 2026-10-16

Asked at the cut through one survey that listed the thirteen rows not shipped and the seven findings outside any item, with the lead's recommendation on each, and offered each row's own question with its cost (this row's line: "orphpr, a failed orphan prune and a rebuild's BM25 deletions: carry"), the owner answered: "Take all fourteen recommendations as listed (Recommended)". The row moves to v0.108.0 at the GA commit with its record as it stands.
