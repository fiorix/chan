# The multipart text fields wait without a bound on the async task

Status: raised at the v0.107.0 cut on 2026-10-17 by the lead from a finding outside that version's items, recorded in the round's decisions as the ledger's entry; written down with the repair's shape; owner by lane at the next version's launch.

## What was seen

A multipart upload's text fields are read on the async task before the file part, with no bound; a client that sends a field's start and goes silent holds the task, not a blocking-pool thread, for as long as the connection lives (the runtime seat's note at the stall item's design, 2026-10-16). Not established: what else the held task holds, and whether the connection's own idle bound ends it.

## Desired contract

A multipart upload whose client goes silent in its text fields is ended at the same bound as one silent in its file part, holding nothing past it.

## What to do

Read what the held task holds and what ends it; bound the field read by the tenant's stall signal as the lanes' consumer is, if the reading shows a hold past the connection's bound.

## Acceptance

1. The reading at source and constructed, with what the hold costs.
2. A repair and its pin if the hold is unbounded.
