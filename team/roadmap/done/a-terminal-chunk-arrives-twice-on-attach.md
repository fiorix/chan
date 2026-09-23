# A terminal output chunk can arrive twice on attach

Status: shipped in [v0.100.0](../../release/release-v0.100.0.md): Recording output and attaching take the ring under one lock, so a chunk that races an attach arrives once and a reconnect resumes from the true end of what was sent.

## What was seen

`record_output` pushes a chunk into the ring under the ring lock and broadcasts it afterwards (`crates/chan-library/src/terminal_sessions.rs`), while `Session::attach` subscribes `output_tx` first and only then snapshots the ring, reading `seq` outside the ring lock. A chunk pushed before the snapshot and broadcast after the subscribe is therefore in both `replay` and `rx`. `send_attach_prelude` (`crates/chan-server/src/routes/terminal.rs`) sends every replay chunk and the socket loop forwards every `rx` output with no dedupe, so the client renders it twice. The review's wider reading is that the SPA's resume cursor over-counts by the duplicated chunk, so a later reconnect can silently skip output.

## Desired contract

An output chunk reaches an attaching client exactly once, and the sequence number a client resumes from is the true end of what it has been sent.

## Boundaries

`crates/chan-library/src/terminal_sessions.rs` (`record_output`, `Session::attach`, the ring's `snapshot_since`/`end_seq`), `crates/chan-server/src/routes/terminal.rs` (`send_attach_prelude` and the socket loop), and the resume cursor in `web/packages/workspace-app`.

## Acceptance

1. A test that attaches while output is being produced asserts no chunk is delivered twice, and is red against today's code.
2. `seq` is read under the same lock as the snapshot, pinned by a test.
3. A reconnect after the raced attach loses no bytes, pinned end to end at the route level.
4. Alternate-screen attaches, which take no replay, are unchanged.
