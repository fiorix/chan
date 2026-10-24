# A failed vector orphan prune lets a rebuild commit BM25 deletions whose vector shards outlive them

Status: shipped in [v0.109.0](../../release/release-v0.109.0.md).

Record before the release: built on 2026-10-21 on the seat's branch; the section Built 2026-10-21 holds the evidence; it closes at the GA as shipped.

Record before the build: carried into v0.109.0 at the v0.108.0 GA on 2026-10-21, still raised for a decision.

Record before the release: carried into v0.108.0 at the v0.107.0 GA on 2026-10-17, still raised for a decision.

Record before the release: raised on 2026-10-16 by the lead from the review seat's read of the rebuild skip item's design and the runtime seat's reading at source; written down with the repair's shape; built by the runtime seat after its lane's items; owner the runtime seat.

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

## Lead's rulings 2026-10-21

The lead's words: "the row's contract says 'when a shard cannot be deleted, the rebuild leaves that path's BM25 document in place and says so', with no qualification on whether the shard decoded, so the case you found is inside it. Take your recommendation: `prune_orphans` reports the failed shard file names together with any enumeration error, and a small result accessor matches a BM25 relative path to its hashed shard file name, so the stale-document pass defers that path too and warns once naming it; the public `Index` API, the walk policy, `forget`'s order and the commits are unchanged. Add the corrupted-shard fault pin (an undecodable shard whose unlink fails: the document stays and the warning names the path; with the unlink succeeding on the next rebuild both go), red first, with its own mutant (the accessor never matching, red)."

The lead's words of 2026-10-21 on the enumeration-failure residual: "When the embeddings directory cannot be enumerated, a stale path whose shard is on disk but not in memory is neither swept nor recorded, so its document is deleted in that pass while the file stays until a later sweep; the shard never loads, so no hit names the path. The contract's purpose is that no served hit outlives its document, and that holds. The residual is stated in the crate design and here, with no code."

## Built 2026-10-21

`prune_orphans` records failed hashed shard filenames and any enumeration error separately. The stale-document pass retains matching BM25 paths and warns once per deferred path. The filename sweep preserves the failed named shards without retrying their unlink, keeping their in-memory entries and disk files together. Undecodable shards use the same filename-to-relative-path match. The next rebuild reclaims both stores once the unlink succeeds; BM25-only stale paths and successful deletions continue to be reclaimed. `forget`, `forget_many`, the readable-file policy and the rebuild's commits keep their order. The crate design describes the cleanup contract.

Acceptance 1 and 2: five `orphan_cleanup` tests cover the named unlink failure and retry, its combination with an enumeration failure, the enumeration-only control, BM25-only cleanup, and the undecodable-shard failure and retry. They inspect committed BM25 paths and lexical hits, live vector paths, reloaded disk shards, semantic hits, and captured warnings. At the base with only test seams and pins, the named and combined cases failed on the intended BM25-retention assertion (`red.log`, exit 101, two controls passed); adding the undecodable-shard pin produced its intended document-retention failure (`red-disk.log`, exit 101, two controls passed). All five passed with the repair (`green.log`, exit 0).

Eight mutations failed on their intended assertions: unguarded stale deletion, deferral of every stale path, filename accessor mismatch, loss of failures on an enumeration error, loss of named failures, loss of disk-only failures, retrying a named failure in the filename sweep, and downgrading the deferral warning. The first seven are in `mutants.log`; that driver then stopped before running the eighth because its edit pattern matched five occurrences. The corrected warning-only driver rejected the eighth with exit 101, restored the source byte for byte, and exited 0 (`warning-mutant.log`). Each mutation has its patch, complete test log and actual status in the guest evidence export. The result reader passed constructed positive and negative controls before the mutation series.

Evidence root: `dev/v0109-team/evidence/Runtime109/orphpr/`; environment: `dev/v0109-team/reports/environment-Runtime109.md`. Acceptance 3: `cargo fmt --check` and `cargo clippy -p chan-workspace --all-targets -- -D warnings` exited 0 at this commit; `cargo test -p chan-workspace --all-targets -- --test-threads=2` exited 0 with 1,072 passed, 0 failed and 3 ignored at this commit. The same suite with `TMPDIR` through a symlink exited 0 with 1,072 passed, 0 failed and 3 ignored at this commit, and 1,067 passed, 0 failed and 3 ignored at the base. Logs: `dev/v0109-team/evidence/Runtime109/orphpr/final/gate/`. Commands run only as the guest's non-root build user with two cargo jobs and two test threads. Cgroup readings identify the runs as contended; no product timing claim is made.
