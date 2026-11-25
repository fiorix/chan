# The graph walks a workspace over the listing cap three times per load and shows no folder layer

Status: accepted for v0.133.0 by the owner on 2026-11-19, as the second half of a split; the first half is [the v0.132.0 row](../done/links-to-files-in-a-workspace-over-the-listing-cap-draw-as-missing-in-the-graph.md). Not started. Moved to v0.134.0 by the owner on 2026-11-20 ("the carry items and the current items in v0.133 move to v0.134 roadmap"). Moved to v0.135.0 by the owner on 2026-11-23 ("all other roadmap items will move to next version").

Record: in a workspace over the 500,000-entry listing cap, every `/api/graph` load walks the whole tree three times (`workspace_disk_files`, `workspace_disk_dirs`, and `merge_unified_tree_layer`'s `list_tree_filtered_unified`, `crates/chan-server/src/routes/graph.rs`), each hitting the cap and thrown away, on every graph refresh; the shared graph then holds no folder nodes, no `contains` edges and no root, and folders carry no file counts. The graph tab still draws folders from its own fs-graph spine.

## Desired contract

1. One walk per load, shared by the three consumers.
2. When that walk is over the cap, a scoped walk of directories only (about 46,000 on `chan-dev`) feeds the folder layer and the directory set, so folders, `contains` edges, the root and folder counts come back.
3. The cap's memory bound holds.
4. The v0.132.0 row's per-target lookup stays for files, which the directory walk does not list; its folder branch and its ancestor checks then read the directory set instead of statting.

## Acceptance

1. Route tests with the cap lowered: one walk per load (counted), the folder layer present over the cap, counts right.
2. An end-to-end reading on a generated tree over the cap: a graph load's time and the folder layer.

## Built, 2026-11-25: one walk per load, folders over the cap, merged at `643b4cac9`

A graph load walks the workspace once; the link resolver's file and directory sets and the folder layer share that listing. Over the 500,000-entry listing cap a directories-only walk, bounded at the same cap, brings back the root, every folder in scope and their `contains` edges, and each file node the graph already holds is joined to its folder; the per-target lookup stays for files and reads the directory set for folders and ancestors. The answer gains a `tree` field: `"folders"` over the listing cap (every folder, not every file), `"depth"` when the directories are over their bound too (the depth-bounded filesystem layer alone, as before); a stream sends it in a second `meta` after the walk. Memory: one cap of walked paths at a time; an over-cap answer can hold two caps' worth of nodes and edges (folders and held files).

Read: route tests with the cap lowered, red at the base (three walks, missing folders) and green at the tip, mutants per guard, and the reviewers' differential of 130 answers (byte-identical where unchanged); an end-to-end reading on a generated tree of 522,103 entries (41,863 directories) in an isolated guest, five loads each, debug build: over the cap the base loads in about 12 s with 801 of 41,864 folders and the tip in about 16 s with all 41,864; under the cap (482,103 entries) the base takes about 38 s and the tip about 18 s. The Rust gate on the merge commit. Correction to the record above: over the cap the filesystem layer gave the root and the folders down to depth 6; what was lost were the folders below, with their edges, and folder counts are 0 in every answer. Not read: a release build, macOS and Windows, a case-folding volume. Open: the graph tab still decides a double-clicked folder's level read by whether it has a child node, which over the cap now holds for every folder (a web follow-up reads the new field); the stream doc's ordering sentence and three test pins (a follow-up); a faster over-cap walk (a directories-only walk in chan-workspace) is a candidate row.


## The follow-ups and the graph tab, 2026-11-25

Merged at `d07bbb907`: the stream doc states the order of the answer's events, a comment names the scoped folder walk, and three pins hold the tree mark's place in the stream and its scope. Merged at `f99d1ca48`: the graph tab keeps the answer's `tree` mark, from the stream's `meta` as it arrives, and decides by it: over the cap a double-clicked folder's level is read although the shared graph holds a child of it, and a failed level read is no longer counted as covered by the shared graph. Read: unit and mounted tests red at their first commit and green at the tip, a review's mutants, and the web gate on the merge commit. Open, in a follow-up: over the cap a folder asked for while its parent is closed, a re-shown tab drawing its kept part, and a folder opened under the cap when a reload returns over it still skip their level read; the `"depth"` value has no test of its own. Not read: the graph tab over the cap in a browser, WebKitGTK.
