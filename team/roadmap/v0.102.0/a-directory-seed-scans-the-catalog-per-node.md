# A search with directory nodes scans the whole catalog once for each of them

Status: raised for a decision on 2026-10-03 by the builder of [a-workspace-search-stops-only-between-seeds](a-workspace-search-stops-only-between-seeds.md), from the measurement that item asked for; the owner has not ruled on it. Measured in a release build on a generated workspace; read in the code on the v0.102.0 integration branch.

## What was seen

After its last seed a workspace search computes the relationships among the nodes it kept (`retain_induced_relationships`, `crates/chan-workspace/src/workspace_search.rs:1964`). For each directory node that pass lists the directory's direct children by walking every entry of the catalog (`direct_directory_children`, `:2309`, called from `in_memory_relationships`, `:2271`). So its cost is the number of directory nodes times the size of the tree.

Measured on a generated workspace of 200,000 notes in 2,000 directories, with the node budget's 1,000 nodes all directories: 4.84 seconds for that pass alone, 202 million comparisons, in a search of 6.8 seconds. At 20,000 notes it took 91 milliseconds. The pass reads the search's cancel flag before it starts and not inside, so a search cancelled after it started still holds its workspace for that long.

## Desired contract

Not written yet. A search's last pass should cost what its nodes and their relationships cost, not the size of the tree for each directory among them.

## What to do

Rule whether it is built in this version. The builder's suggestion is an index of children by directory, built once: in the catalog, where every search and the catalog's other readers would share it and pay its memory, or inside the pass, where one search builds it and drops it. Measure again after either.

## Boundaries

`crates/chan-workspace/src/workspace_search.rs` and its tests; the catalog's type if the index lives there.

## Acceptance

1. The ruling is recorded.
2. If it is built: the pass over 1,000 directory nodes of the 200,000-note workspace is measured again and recorded here, and a search's results are unchanged, pinned by the existing search tests and one that compares the relationships of a directory seed before and after.
