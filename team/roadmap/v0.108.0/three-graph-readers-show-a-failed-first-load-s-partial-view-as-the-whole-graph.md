# Three graph readers show a failed first load's partial view as the whole graph

Status: raised at the v0.107.0 cut on 2026-10-17 by the lead from a finding outside that version's items, recorded in the round's decisions as the ledger's entry; written down with the repair's shape; owner by lane at the next version's launch.

## What was seen

A first load of the shared graph that fails keeps what it streamed, marked partial, and a retry streams afresh. The state module and the inspectors' references branch on the error state first; three readers do not: the search panel's tag and mention rows and the workspace body's contacts read the partial view as the whole graph until a retry completes (the review seat's note at the graph refetch item's amend, 2026-10-16; the same at that item's parent).

## Desired contract

A reader of the shared graph shows a failed first load as a failure or as loading, never a partial graph as the whole.

## What to do

The three readers branch on the error state or the partial mark as the inspectors do, showing the error or the loading state instead of a partial graph.

## Acceptance

1. A pin per reader with a failed first load, red first.
2. The design text.
