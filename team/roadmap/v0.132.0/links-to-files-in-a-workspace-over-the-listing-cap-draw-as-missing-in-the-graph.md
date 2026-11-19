# Links to files in a workspace over the listing cap draw as missing in the graph

Status: accepted for v0.132.0 by the owner on 2026-11-19, as the quick half of a split ("we can push to next version ... unless there is a quick-dirty solution we could split into 2 items - now and next version"); the rest is [the v0.133.0 row](../v0.133.0/the-graph-walks-a-workspace-over-the-listing-cap-three-times-per-load-and-shows-no-folder-layer.md). Not started.

Record: after [the listing cap row](a-workspace-over-the-listing-cap-locks-its-windows-and-a-deep-graph-freezes-the-page.md), a workspace over the 500,000-entry listing cap (the owner's `chan-dev`) opens and indexes, but `/api/graph` still builds its file and directory sets from whole-tree walks that hit the cap and fall back to empty sets (`crates/chan-server/src/routes/graph.rs`, `workspace_disk_files` and `workspace_disk_dirs`, around 579-612). Every link from a note to an existing non-Markdown file or to a folder then draws as a missing ghost; `chan-dev`'s notes link to evidence files constantly. The reading: `dev/v0132-team/reports/investigation-preflight-listing-cap-1.md` and the listing cap builder's item 7 in the development tree.

## Desired contract

1. When the whole-tree file or directory walk is over the cap, the graph resolves each link target by looking at that one path on disk (inside the workspace, the same scope rules as the walk), so a link to an existing file or folder is not drawn as missing.
2. Under the cap, nothing changes: the sets are used as today.

## Boundaries

- `routes/graph.rs` only, and its tests. The walks, the cap, the folder layer and the number of walks per load are the v0.133.0 row's.
- The stat follows the walk's scope (excluded directories, `.gitignore`, no escape outside the workspace).

## Acceptance

1. A route test with the cap lowered (the existing test seam) where the walk overflows: a link to an existing file and to an existing folder resolve; a link to a missing path is still a ghost. Red at the base.
2. A note: the cost (one stat per link target, only when over the cap) stated in the code.
