# A download whose client stops reading ends after its 200 header with a classification nobody has read

Status: carried into v0.109.0 at the v0.108.0 GA on 2026-10-21, still raised for a decision.

Record before the release: raised at the v0.107.0 cut on 2026-10-17 by the lead from a finding outside that version's items, recorded in the round's decisions as the ledger's entry; written down with the repair's shape; owner by lane at the next version's launch.

## What was seen

A download answered 200 streams its body; a client that stops reading mid-body ends the stream with a body error after the header. Whether the server's trace layer logs that end at ERROR, as it logs a failed response, is not read (the runtime seat's note at the stall item's design, 2026-10-16).

## Desired contract

A client's own silence on a download it asked for is not a server error in the log; the line that records it says what the client did and what was sent.

## What to do

Read the classification at source and in a constructed run; if it is an ERROR line for a client's own silence, map it as the upload stall is mapped, below ERROR with the bytes sent.

## Acceptance

1. The reading, constructed: a download client that stops reading past the bound, the server log's line quoted.
2. A repair and its pin if the line is an ERROR for a client's silence.
