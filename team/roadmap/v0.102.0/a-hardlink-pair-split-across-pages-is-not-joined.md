# A hardlink pair split across two pages of the filesystem graph is not joined

Status: raised for a decision on 2026-10-03 by the builder of the open rows of [the-frontend-review-remainder-has-no-owner](the-frontend-review-remainder-has-no-owner.md), from its row on the graph's hardlink chip; the owner had not ruled on it then. Read in the code on the v0.102.0 integration branch; not reproduced. Ruled on 2026-10-03: see Owner ruling.

## Owner ruling

On 2026-10-03 the owner ruled, as the lead recommended: accepted for a build. A node with more than one link carries an opaque group value, and the page joins the nodes that share one.

## What was seen

The graph page loads a directory's filesystem graph in pages until the server says it is done. The paged walk emits hardlink edges from the inodes seen inside one batch, so two paths of one inode that fall in different batches get no edge; the route's own comment says so and calls it the one content caveat of paged mode (`build_fs_graph_paged`, `crates/chan-server/src/routes/fs_graph.rs:464-468`). The unpaged walk joins every pair (`build_fs_graph`, `:429`).

The page cannot join them itself: a node carries `link_count` and no inode. Its hardlink chip counts the distinct nodes that a delivered hardlink edge touches (`web/packages/workspace-app/src/components/GraphPanel.svelte:1408-1415`), and the filter beside it hides exactly those edges, so the chip agrees with what the canvas draws and both miss the split pairs. Counting nodes with `link_count` above one instead would count files linked to something outside the scope, which the filter can neither hide nor show.

How often a real directory splits a pair depends on the batch size and the walk's order; it was not measured.

## Desired contract

Not written yet. The choice is whether a paged load owes the same edges as the unpaged one, and who pays for it.

## What to do

Rule one of three. The server joins: the cursor carries what a later batch needs to name an earlier path of the same inode, or a last batch emits the pairs the earlier ones split, at the cost of state that grows with the number of multiply-linked files. The page joins: a node whose `link_count` is above one carries an opaque group value derived from its inode, and the page draws an edge between nodes that share one, at the cost of a new wire field. Or the caveat stays as the written cost it is, and the chip's count is described as a lower bound.

## Boundaries

`crates/chan-server/src/routes/fs_graph.rs` and its tests; for the second shape also `web/packages/workspace-app/src/components/GraphPanel.svelte` and the graph's API types.

## Acceptance

1. The ruling is recorded.
2. If it changes the walk: two hardlinked paths that fall in different batches of a paged load are joined by one hardlink edge, pinned red first with a batch size that splits them; the unpaged walk's output is unchanged.

## What shipped

Built on 2026-10-03 on the v0.102.0 integration branch and not on `main`, in a range the lead accepted on its report, its status files, an independent review of its whole diff and the lead's own reading of what that review questioned. This record was written that day from those.

The server's half is built, and the row stays open for the page's. A node of a paged directory walk whose link count is above one carries `link_group` beside `link_count` (`link_group_of`, `crates/chan-server/src/routes/fs_graph.rs`): 16 hexadecimal digits of a keyed hash of the file's device and inode, under a key drawn once in the server process and never logged. Only a regular file counts more than one link, so the group is on files alone, the set the walk joins by an edge. The unpaged walk's output, a file-scope answer and the paged walk's own edges are unchanged; pinned red first with a batch size that splits a pair. Acceptance 2 is met in the ruling's shape and not as it is written: the two nodes of a split pair carry one group, and the server adds no edge. Left: the page does not join by the group yet, which is ordered. The costs, as ruled: a load that spans a server restart reads two keys and does not join a pair split across it, and two files that are not linked share a group with a chance of 2^-64 a pair.

The page's half was built later that day, in a range the lead accepted on its report, its status files and its own reading of the range's code; no browser was driven. The nodes of one load that share a `link_group` are joined as a delivered hardlink edge joins them, by one function (`joinFsHardlinks`, `web/packages/workspace-app/src/components/GraphPanel.svelte`) that feeds the chip's count, the canvas and the chip's filter together, so the three cannot disagree. It joins over everything the load holds, which is wider than the two pages the item names: a pair split by a batch boundary and a pair whose paths came with two directory expansions are the same case. A pair delivered both as an edge and as a group draws one edge, whichever way round the edge names its ends. The semantic graph's spine reads the same paged route and split pairs the same way; by the lead's ruling on the builder's reading it joins its pages with the same function. Pinned red first in both modes on the canvas's own edges. Its cost: a group of many paths is joined pair by pair, as the unpaged walk joins it, so the edges grow with the square of the group's size.
