# The indexer sends an apply frame per file, so a burst's graph refresh follows the stream's pace

Status: raised for v0.109.0 on 2026-10-22 by the lead, from the frontend seat's loaded reading at the graph-refresh item's build; closes in the round.

## What was seen

The server's indexer bridge (`crates/chan-server/src/indexer.rs`) sends one `graph_applied` frame through the bus (`bus.rs`, `send_graph_applied`) per change the watcher worker applies, its one send site; a full index build sends none. The workspace app's shared graph refresh re-arms a 250 ms quiet window at each frame and fetches the graph when the window ends. The graph-refresh item's reading of an 81-file write: beside an idle host the frames arrive within the window and the burst costs two shared fetches and three graph tab loads; beside a compile load in the integration guest the gaps pass the window and the same write costs 56 shared fetches and 57 graph tab loads over 31.6 s against 9.6 s quiet. Browser check 163's own 81-file write streams about 85 frames at about 100 ms gaps over 10 to 13 s. A stream whose gaps stay under the window defers the shared refresh for its whole length (a large copy outside version control, minutes), and each frame resets every open window's timer.

## Desired contract

A burst of applied changes costs each window one shared graph fetch whatever the host's load, a single save keeps its refresh latency, and a long stream's refresh is bounded by a deferral the design states.

## What to do

A design first, read by the review seat before code, since the frame's producer changes: the bridge sends one `graph_applied` frame when the worker's due set drains, naming every path applied since its last frame; the frame's shape is unchanged for the page and its path list grows. The design names its producers (the 81-file write at check 163's pace and at the item's loaded pace, a large copy outside version control), states the deferral each gets and the bound for a stream that keeps the due set full, and names the pins (one frame per drain naming every applied path; a single save's frame unchanged). Before landing, the fetch count and the deferral are measured with the graph-refresh item's reading driver at the check's pace and under the compile load the item's reading used.

## Boundaries

`crates/chan-server/src/indexer.rs` at the apply path, `bus.rs` and their tests; the chan-server design text at the frame's entry. Not changed: the page's quiet window and its handler, the graph routes, the watch frames.

## Acceptance

1. The design names its producers, the deferral and its bound, read by the review seat before code.
2. The pins red first at the parent; the chan-server suite green at the commit, and chan-workspace's if the apply path there moves.
3. The 81-file write measured at the check's pace and under load at the commit: one shared fetch per window per burst, the deferral recorded here beside the base's counts; check 163 alone at the landing in the integration guest, beside the base.
