# A client that goes silent mid-upload is answered 503 with an error line when the stall bound ends it

Status: raised on 2026-10-16 by the lead from the review seat's read of the check 62 item's design; read at source by the lead; written down with the repair's shape; built by the runtime seat after its lane's items; owner the runtime seat.

## What was seen

Read at source at `0f0b7fb33`, not constructed. The transfer lane parks a job until channel readiness, cancellation or its no-progress bound (`crates/chan-server/src/bulk_transfer.rs`, the parking loop; the bound is `transfer.stall_timeout_secs`, 300 s by default). A client that stops sending mid-body and keeps the connection open reaches that bound: the job is ended as "transfer stalled without channel progress", which the lane reports as `BulkOutcome::Cancelled`. The upload handler (`routes/files.rs`, the outcome match) answers every `Cancelled` as 503 "upload did not complete", since a cancellation, a lane shutdown and a panicked job are reported identically there and cannot be told apart; the `TraceLayer` then logs the 5xx at ERROR. So a client's silence ends in a server-error status and an error line, as a client's abort did before the check 62 item, which answers the abort 400 `upload_incomplete` at INFO and leaves this arm as it was.

The raw-body text writes (`PUT /api/fs/{path}` and the two other consumers of `consume_request_body`, `files.rs` 2302, 2336 and 2514) do not reach that bound at all: their consumer waits on a bare `blocking_recv` with no cancel, where the lanes' `consume_transfer_body` waits under the stall bound. So a text save whose client stops sending without closing leaves the feed awaiting the body and the consumer parked without bound; no body-timeout layer is on the routers and nothing sets TCP keepalive, so a peer that vanished (a sleeping laptop, a lost network) leaves the connection open; each such request holds a blocking-pool thread, and `write_streamed_text`'s closure owns an `Arc<Workspace>`, so a workspace reset or a metadata import answers Busy at its count wait while the PUT is held, and neither ends. The downloads take the tenant's `stall_signal()`; the raw writes do not. Read by the review seat, not constructed.

Not established: that any user has met either (a client holding a connection open with no body progress for the bound; a text save whose client vanished); a constructed run (a body paused past a shortened bound) is the acceptance's first step.

## Desired contract

A transfer ended by the client's own silence at the stall bound is not a server error: the server answers it with a status that says the request timed out (408) and logs it below ERROR; a lane shutdown and a panicked job keep their 503 and their error line, told apart from the stall at the point that knows the difference. A raw-body text write whose client goes silent ends at the same bound and takes the same answer, and holds no thread or workspace past it.

## What to do

Give the stall its own outcome where the parking loop ends the job (a variant beside `Cancelled`, or a reason carried by it), and map it in the upload lanes to 408 with one INFO line, the way the check 62 item maps the typed incomplete-body error through `err_from`; keep `Cancelled` for the shutdown and the panic with their 503. Make the raw-body consumer wait under the tenant's `stall_signal()` as the lanes' consumer and the downloads do, so a silent text write ends at the same bound with the same outcome and answer, releasing its thread and its workspace. The lane's stall policy, its bound and the slot's release are not changed.

## Boundaries

The stall bound and its configuration are not changed; the lane's cancellation for shutdown and panic keeps its answer; the check 62 item's answer for an aborted body is reused, not redefined.

## Acceptance

1. Red first: an upload whose body pauses past a shortened stall bound (the test support's `with_stall_timeout`) answers 503 with an ERROR line at the tip; with the repair it answers 408 with one INFO line and no ERROR line, through the crate's router with the `TraceLayer` (one mutant: the stall mapped back to `Cancelled`, red).
2. A raw text write whose body pauses past the shortened bound, at the tip, holds its blocking thread and its workspace past the bound (a reset answering Busy meanwhile, read by the count); with the repair it answers 408 with one INFO line at the bound and the reset proceeds (one mutant: the consumer's wait unbounded, red).
3. A lane shutdown during an upload still answers 503 with its error line (the control, green at the tip and with the repair).
4. The whole `chan-server` suite green at two threads at the landed tip; check 62's log assertion (no 5xx line) holds across its run with a stalled client added to its legs, Hygiene107's edit on the landed tip.
