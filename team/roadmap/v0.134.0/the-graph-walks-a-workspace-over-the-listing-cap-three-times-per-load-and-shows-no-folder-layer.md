# The graph walks a workspace over the listing cap three times per load and shows no folder layer

Status: accepted for v0.133.0 by the owner on 2026-11-19, as the second half of a split; the first half is [the v0.132.0 row](../done/links-to-files-in-a-workspace-over-the-listing-cap-draw-as-missing-in-the-graph.md). Not started. Moved to v0.134.0 by the owner on 2026-11-20 ("the carry items and the current items in v0.133 move to v0.134 roadmap").

Record: in a workspace over the 500,000-entry listing cap, every `/api/graph` load walks the whole tree three times (`workspace_disk_files`, `workspace_disk_dirs`, and `merge_unified_tree_layer`'s `list_tree_filtered_unified`, `crates/chan-server/src/routes/graph.rs`), each hitting the cap and thrown away, on every graph refresh; the shared graph then holds no folder nodes, no `contains` edges and no root, and folders carry no file counts. The graph tab still draws folders from its own fs-graph spine.

## Desired contract

1. One walk per load, shared by the three consumers.
2. When that walk is over the cap, a scoped walk of directories only (about 46,000 on `chan-dev`) feeds the folder layer and the directory set, so folders, `contains` edges, the root and folder counts come back.
3. The cap's memory bound holds.
4. The v0.132.0 row's per-target lookup stays for files, which the directory walk does not list; its folder branch and its ancestor checks then read the directory set instead of statting.

## Acceptance

1. Route tests with the cap lowered: one walk per load (counted), the folder layer present over the cap, counts right.
2. An end-to-end reading on a generated tree over the cap: a graph load's time and the folder layer.
