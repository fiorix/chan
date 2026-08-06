# `cs terminal list` does not show queue depth in its table

> Status: shipped in [v0.85.0](../../release/release-v0.85.0.md).

Status: REGISTERED for v0.85.0, grounded 2026-08-05.

## What

A poke sent with `cs terminal write` enters a per-session FIFO and is delivered when that session goes idle. Someone coordinating several agent sessions needs to know how much is still queued for each one, because a session with a deep queue has not seen the latest message yet and re-sending only makes its next turn noisier.

`cs terminal list --json` already answers this. The markdown table that `cs terminal list` prints by default does not, so the answer is only available to a caller who asks for JSON and reads it.

## Verified current state (2026-08-05)

Most of this is already implemented. Confirmed by reading the source and by querying a running server, not inferred:

- `TerminalSessionSummary::queue_depth` exists at `crates/chan-library/src/terminal_sessions.rs:483` and is populated at `:1955`.
- The control socket already emits `queue_depth` in the terminal-list JSON at `crates/chan-server/src/control_socket.rs:4005`.
- A focused test already covers the JSON field for a session with a pending queue: `term_list_reports_the_pending_queue_depth` at `crates/chan-server/src/control_socket.rs:5729`.
- `cs terminal list --json` against a live server returns `"queue_depth"` on every session.

The semantics are already the right ones. `msg_depth` at `crates/chan-library/src/terminal_sessions.rs:2634` counts tail entries, which is logical messages rather than internal entry cost, so a Gemini message that occupies two queue entries counts once. `crates/chan-shell/design.md:142` already documents that the SPA badge, `cs terminal list --json`, and a `cs terminal write` queue position all report that same number.

What is missing is the markdown column. `render_terminal_list_markdown` at `crates/chan-shell/src/cli.rs:2573` renders eleven columns, with the header literal at `:2593` and the row format at `:2600`, and none of them is queue depth. Its own unit tests pin that eleven-column header exactly, so they change with it.

## Contract

- `cs terminal list` includes a queue depth column in the markdown table, in the grouped output.
- `cs terminal list --json` includes the queue depth field. This already holds and must keep holding.
- The value counts writes enqueued for that session and not yet delivered: the per-session FIFO length as a count of queued writes, zero when the queue is empty. It reports queued writes, not the queue's internal capacity cost units.

## Acceptance

- Focused tests cover an empty queue, a session with pending queued writes, the JSON field, and the markdown column in the grouped table.
- Tests that already exist for a case are not duplicated. The JSON field with a pending queue is already covered; the implementer reports which of the four cases were genuinely new.

## Rough size

Small. The renderer and its tests in `crates/chan-shell/src/cli.rs`, plus the help text if it enumerates columns and one JSON test if empty-queue coverage is genuinely absent.
