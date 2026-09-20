# A client that stops reading parks a blocking-pool thread

Status: raised for v0.101.0 from the v0.99.0 fix loop's follow-ups, where the stall bound was given to the bulk transfer lane only and these sites were recorded and parked. A source reading against `main` at `d3de0180b`; not reproduced.

## What was seen

`standalone_stream_read_response` (`crates/chan-server/src/routes/standalone_fs.rs`) and `stream_report_file_response` (`crates/chan-server/src/routes/report.rs`) each spawn a blocking producer that pushes into an eight-slot channel with `blocking_send` and hands the receiver to the response stream. A client that stops reading fills those eight slots, the next `blocking_send` parks, and the pool thread stays parked for as long as the client holds the connection open. The bulk transfer lane has a configured stall bound for exactly this shape, exercised by `stalled_workspace_upload_preserves_target_without_a_sender` in `crates/chan-server/src/routes/files.rs`; neither of these bridges uses it. The file and graph routes are reported to have further sites of the same shape, not re-verified here.

Separately, chan-library's host bookkeeping still canonicalizes on the runtime thread. `canonical_key` (`crates/chan-library/src/host.rs`) calls `chan_workspace::paths::canonicalize_normalized`, which touches the filesystem, and the async `close_workspace_for_root_locked` and `remove_workspace_for_root` call it directly, so a slow or cloud-synced root stalls a tokio worker there. Only the open path was moved to the blocking pool.

## Desired contract

A streaming response whose client stops reading releases its pool thread within the same configured stall window the bulk lane uses, and a workspace key is never canonicalized on a runtime thread.

## Boundaries

`crates/chan-server/src/routes/standalone_fs.rs` and `crates/chan-server/src/routes/report.rs` (the two bridges), the equivalent sites in `crates/chan-server/src/routes/files.rs` and `crates/chan-server/src/routes/graph.rs`, the stall bound in `crates/chan-server/src/bulk_transfer.rs`, and `crates/chan-library/src/host.rs` (`canonical_key` and its async callers).

## Acceptance

1. A test whose client stops reading shows the producer released within the stall bound and the pool thread free, red against today's code.
2. The bound is the same configured value as the bulk lane, asserted rather than duplicated as a literal.
3. A test drives the async close and remove paths through the host's canonicalization probe hook and shows no canonicalization on the runtime thread, as the existing lookup test does for its own path.
