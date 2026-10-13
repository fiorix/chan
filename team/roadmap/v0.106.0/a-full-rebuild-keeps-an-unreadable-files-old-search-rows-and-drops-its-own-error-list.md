# A full rebuild keeps an unreadable file's old search rows and drops its own error list

Status: raised on 2026-10-13 from the runtime seat's design note for the unreadable-file lock in the v0.106.0 round (`reports/design-Runtime106-idxlock.md` and its followup 47 in the round's bus); read at source by the seat and by the lead, not constructed, not run; written down, not designed, not accepted for build.

## What was seen

By source, at the round's integration branch (`4aed59d16`), two things about a full index rebuild that meets a file of the user's it cannot read or decode:

- **Old search rows survive.** On a fresh graph pass the file is left out and the graph is swapped without it (`crates/chan-workspace/src/workspace.rs` 3380 to 3383 and 3407). In the search index a failed read records an error and moves on without touching the file's rows (`index/facade.rs` 640 to 645); the cleanup after the walk deletes only paths that were not walked, and counts every walked name as visited (780 to 800); and a file's earlier chunks are deleted only on the way into a successful write (`index/bm25.rs` 152 to 161). So a file that was indexed, then became unreadable, and is still present keeps its earlier chunks and vectors through a warm rebuild: search can return text of a file that can no longer be read, while the graph no longer holds it. The watcher's per-file path forgets both (`workspace.rs` 3839 to 3844 and 4068 to 4080), so the two paths disagree.
- **The rebuild's error list is dropped.** `BuildSummary.errors` holds source read errors (`index/facade.rs` 643), BM25 write failures (647 to 649) and vector or embedding failures (660 to 665, 716 to 724) in one list, and the server maps a successful summary away (`crates/chan-server/src/indexer.rs` 785 to 787). Some failures do propagate, the graph's and the final BM25 commit's (`facade.rs` 810) among them. Nobody is told which files a rebuild could not index, and a caller cannot tell a user's unreadable file from a failed write of the index's own.

Not established: either case constructed or run; a rebuild that resumes staged graph work, which the fresh-pass reading does not cover; how often a warm rebuild meets such a file.

## Desired contract

A file the rebuild could not read leaves no stale row behind, as the watcher's path leaves none; and the rebuild says which files it skipped, apart from failures of the index's own state.

## What to do

Construct the warm case first: index a file, make it unreadable, rebuild, search for its old text. If it holds, forget a walked file whose read failed, as the per-file path does, and keep the two kinds of error apart in the summary so the server can log the skipped files by name. Design before code: the rebuild's failure policy is shared by every caller of the facade.

## Boundaries

`crates/chan-workspace/src/index/facade.rs`, `index/bm25.rs`, and `crates/chan-server/src/indexer.rs` where the summary is received. Not changed here: the watcher's per-file apply, which is the unreadable-file lock's item.

## Acceptance

1. The warm case constructed, with its expected values written first, and what search returns before and after the rebuild.
2. After a repair, a rebuild leaves no search row for a file it could not read, pinned, with a readable neighbour as the positive control.
3. The skipped files are named in the server's log, and a failure of the index's own state is not reported as one of them.
