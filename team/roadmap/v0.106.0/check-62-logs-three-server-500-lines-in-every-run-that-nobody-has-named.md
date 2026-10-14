# Check 62 logs three server 500 lines in every run that nobody has named

Status: raised by the review seat on 2026-10-14 from its read of the coalesced relist range (N5 of `reviews/review-Review106-relist-range-1.md` in the round's bus, after its F1 of the design read); written down the same day by the lead as a row of its own; owner the frontend seat, with the server's answer read by the runtime seat; not reached in the v0.106.0 round

## What was seen

Read in the logs of every run of browser check 62 on the round's bus, not at source. The server logs three `response failed classification=Status code: 500 Internal Server Error` lines (`tower_http::trace::on_failure`, at ERROR) in every run of `scripts/e2e/browser-smoke/checks/62-binary-transfer-streaming.mjs`, at the pre-landing tree `ea4b04f18`, at the first candidate and at the relist tip alike: one near 95 ms, logged between the upload's result and the check's `cancel-cleanup` step (the cancelled upload, 607 to 652), and two near 70 s, logged between `queue-visible` and `queue-drain-progress` (the queue legs, 745 to 840, whose third and fourth uploads are cancelled while queued). The lines name no route and no request, and the check passes with them, so they are the check's own: an aborted or cancelled upload that the server answers as a `500`. Nobody has read which handler answers so, or whether a client's abort should be a `500` at all. The cost already paid once: the round's lead and review read those three lines as the relist flood's damage ("two uploads failed with 500") until the pre-landing log showed the same three with the same latencies; a real `500` from a regression would sit among them unseen.

Not established: the route and the handler; the status the server should answer for an aborted multipart upload (`499`-like, `408`, or a clean `200` with the partial cleaned); whether other checks that cancel transfers log the same.

## Desired contract

A cancelled or aborted upload is not a server error: the server answers it with a status that says so and logs it below ERROR, and the check's log carries no `500` line, so that a `500` in a run means a defect.

## What to do

Read the server's upload route (`crates/chan-server/src/routes/files.rs`, the multipart upload and the transfer cancel) for what answers a client abort, and reproduce one cancelled upload against a test server with the log at its default level. Then the proposal to the review seat before code: the status and the log level for an abort, and whether the check asserts the absence of `500` lines once it holds.

## Boundaries

`crates/chan-server/src/routes/files.rs` (the upload's abort arm and its log line) with its tests, and the check's assertion. Not changed: the transfer protocol or the cancel's cleanup, which the check already proves.

## Acceptance

1. The handler and the status named, with one reproduced abort and its log line quoted.
2. The decision recorded here.
3. If a change: an abort answers the chosen status and logs below ERROR, pinned by a server test red first; check 62's log holds no `500` line in a green run.
