# The move-out spare covers the whole window

Status: raised during v0.100.0 on 2026-09-23; not accepted. From the Lead follow-ups ledger (2026-09-23 09:54Z, review of the tab-move fix) and the release report. A source reading against `main` at `6237c2677`.

## What was seen

The tab-move fix spares moved sessions per window: `Registry::unpersist_window` (`crates/chan-library/src/terminal_sessions.rs:2289`) records every session still bound to the emptied window in `moved_out` (`:268`), and `forget_window` (`:2246`) spares them all. A detached session that was still bound to the source when the move happened, which the close used to reap at once, now lives until the orphan idle timeout.

## What to do

Carry the moved session's id on the `moved=1` DELETE and spare only that id, with a test that holds a second, detached session in the source window and shows it reaped at the close.
