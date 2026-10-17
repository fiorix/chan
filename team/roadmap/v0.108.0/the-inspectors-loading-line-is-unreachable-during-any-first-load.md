# The inspectors' loading line is unreachable during any first load

Status: raised at the v0.107.0 cut on 2026-10-17 by the lead from a finding outside that version's items, recorded in the round's decisions as the ledger's entry; written down with the repair's shape; owner by lane at the next version's launch.

## What was seen

The file and tag inspector bodies show their loading line only when no view is cached and a load is out; a first load streams batches into the view from its first batch, so the line shows for the time before the first batch only and reads as unreachable in the tests that drive a first load (the review seat's note at the graph refetch item's amend, 2026-10-16; the same at that item's parent).

## Desired contract

The inspectors' loading state is shown for the time the design names, or is not offered; its condition is reachable in the tests that drive a first load.

## What to do

Decide what the inspectors show during a first load (the line until the stream completes, or nothing) and make the condition say it; or remove the line.

## Acceptance

1. A pin for the chosen behaviour, red first.
2. The design text.
