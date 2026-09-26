# One close reason covers a PTY parked for restore and a PTY that was killed

Status: raised during v0.101.0 on 2026-09-26 by the terminal tab order of team v0101 (`dev/v0101-team/reports/report-Clients-1.md`, section "What the items and the order got wrong or left out", in the development tree), while fixing [a-graceful-restarts-session-save-drops-the-terminals-session-id](a-graceful-restarts-session-save-drops-the-terminals-session-id.md). A source reading against `main` at `1566b06d0`; not observed in a browser.

## What was seen

The server sends `closed{shutdown}` to an attached terminal socket on three paths in `crates/chan-library/src/terminal_sessions.rs`: the fd-store detach before a restart, where the PTY is parked and the next process restores it; `close_all(CloseReason::Shutdown)` from the pruner's shutdown; and the tenant `Drop`. The last two kill the PTY. The SPA cannot tell them apart. Keeping the terminal's session id on `closed{shutdown}`, which the reload needs to reattach a parked PTY, makes a reload after a kill attach an id the new process lacks; the attach route then creates a fresh shell from the query, which on a reattach carries no cwd, command or profile, so the tab comes back on the default profile where a tab saved without its id would have passed its profile. That is the crash path's outcome today; before the fix it depended on which session save won.

## Desired contract

The server names a shutdown that parks the PTY apart from one that ends it, and a terminal tab keeps its session id only when a restore is coming.

## What to do

A second close reason for the killed case (or the park case), sent where each path closes its sockets, with the SPA's `CloseReason` type and the shutdown arm of `TerminalTab.svelte` keeping the id only on the park reason. Red first: a chan-server test that drives the pruner's shutdown and asserts the reason on the wire; a mounted test that the SPA clears the id on it. Decide separately whether a reattach that falls back to a fresh shell should carry the tab's profile and cwd, which would make the fallback correct on every path.

## Boundaries

`crates/chan-library/src/terminal_sessions.rs` (the three close paths and `CloseReason`), the wire type in `crates/chan-server/src/routes/terminal.rs`, and the `closed` arm and `CloseReason` type in `web/packages/workspace-app/src/components/TerminalTab.svelte`. The fd-store park and restore are [a-restart-replays-only-the-manifest-tail](a-restart-replays-only-the-manifest-tail.md).
