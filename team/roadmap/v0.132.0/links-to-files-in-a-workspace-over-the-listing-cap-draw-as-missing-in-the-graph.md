# Links to files in a workspace over the listing cap drop out of the graph

Status: accepted for v0.132.0 by the owner on 2026-11-19, as the quick half of a split ("we can push to next version ... unless there is a quick-dirty solution we could split into 2 items - now and next version"); the rest is [the v0.133.0 row](../v0.133.0/the-graph-walks-a-workspace-over-the-listing-cap-three-times-per-load-and-shows-no-folder-layer.md). Not started.

Record: after [the listing cap row](a-workspace-over-the-listing-cap-locks-its-windows-and-a-deep-graph-freezes-the-page.md), a workspace over the 500,000-entry listing cap (the owner's `chan-dev`) opens and indexes, but `/api/graph` still builds its file and directory sets from whole-tree walks that hit the cap and fall back to empty sets (`crates/chan-server/src/routes/graph.rs`, `workspace_disk_files` and `workspace_disk_dirs`, around 579-612). Every link from a note to an existing non-Markdown file or image then resolves to nothing and is dropped, with no node or edge, like a link to a missing path; a folder link draws no edge over or under the cap, since the route drops folder link edges whether or not it knows the folder. `chan-dev`'s notes link to evidence files constantly. The reading: `dev/v0132-team/reports/investigation-preflight-listing-cap-1.md` and the listing cap builder's item 7 in the development tree.

## Desired contract

1. When the whole-tree file or directory walk is over the cap, the graph resolves each link target by looking at that one path on disk (inside the workspace, the same scope rules as the walk), so a link to an existing file or image keeps its node and edge, and a folder target is known as a folder rather than a ghost.
2. Under the cap, nothing changes: the sets are used as today.

## Boundaries

- `routes/graph.rs` and its tests, plus the test-only listing hook in chan-workspace. The walks, the cap, the folder layer and the number of walks per load are the v0.133.0 row's.
- The lookup follows the walk's scope (excluded directories, `.gitignore`, real directories only on the way down, no escape outside the workspace). It differs from the walk in two places, both stated in the code: a case-folding volume, where a wrong-case spelling finds the file, and a mount point inside the root, below which the walk does not descend.

## Acceptance

1. A route test with the walk's cap lowered (a new `lower_tree_walk` hook, since `lower` bounds only the rebuild's listing): links to an existing file and image resolve, and links to a missing path, a path outside the root or a path out of scope stay dropped, red at the base; the lookup, read directly, finds an existing folder.
2. A note: the cost (one lstat per distinct link target and one per distinct directory above them, only when over the cap) stated in the code.
