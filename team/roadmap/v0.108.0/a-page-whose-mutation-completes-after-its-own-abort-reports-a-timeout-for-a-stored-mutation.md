# A page whose mutation completes after its own abort reports a timeout for a stored mutation

Status: raised at the v0.107.0 cut on 2026-10-17 by the lead from a finding outside that version's items, recorded in the round's decisions as the ledger's entry; written down with the repair's shape; owner by lane at the next version's launch.

## What was seen

The page aborts a mutation request after 10 s and reports a timeout to its user. The server's worker that stores the mutation keeps running past the abort and, from v0.107.0, announces the stored mutation from the worker, so the mutation lands and its frame reaches the page while the page's report says it timed out (the runtime seat's reading of the server at the announcement item's design, 2026-10-16; not read on the page).

## Desired contract

A page never tells its user a mutation timed out when the server stored and announced it; the report says what is known at the abort and the list shows the stored result when its frame arrives.

## What to do

The page treats a frame that names its own aborted request's target, arriving after the abort, as that request's answer; or its timeout report says the mutation may have completed and the list is refreshed.

## Acceptance

1. A page reading in a browser: a mutation held past 10 s with the server's hold seam, the report observed, then the frame's arrival and what the page shows.
2. A store-level pin for the chosen shape, red first.
3. The design text.
