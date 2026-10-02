# One close reason covers a PTY parked for restore and a PTY that was killed

Status: shipped in [v0.101.0](../../release/release-v0.101.0.md).

Record before the release: accepted for v0.101.0 by the owner on 2026-09-26; raised during v0.101.0 on 2026-09-26 by the terminal tab order of team v0101 (`dev/v0101-team/reports/report-Clients-1.md`, section "What the items and the order got wrong or left out", in the development tree), while fixing [a-graceful-restarts-session-save-drops-the-terminals-session-id](a-graceful-restarts-session-save-drops-the-terminals-session-id.md). The independent review of that order (`dev/v0101-team/reviews/review-Clients-1.md`, finding 1) named the paths that deliver the frame, which the report had wrong. A source reading against `main` at `1566b06d0`; not observed in a browser.

## Owner ruling

Accepted on 2026-09-26 as the lead recommended: a second close reason names the killed case, sent where each path closes its sockets, and the SPA's `CloseReason` and the terminal tab's shutdown arm keep the session id only on the park reason; red first on the wire and mounted. The item's separate question is settled the same day: a reattach that falls back to a fresh shell carries the tab's profile and cwd, so the fallback is correct on every path. The server half is the runtime lane's after its prelude order, the SPA half the clients lane's after the pane-split order.

## What was seen

Two server paths deliver `closed{shutdown}` to an attached terminal socket. The fd-store detach before a restart (`detach_for_fdstore_restart`, `crates/chan-library/src/terminal_sessions.rs:4948-4952`) broadcasts it without a kill: the PTY is parked and the next process restores it. The terminal drain that `chan devserver stop` and `chan devserver restart --force` call first (`crates/chan/src/lib.rs:5556`, `:5448`; `handle_terminal_sessions_drain`, `crates/chan-server/src/devserver.rs:2841`; `close_all(CloseReason::Shutdown)` at `crates/chan-library/src/host.rs:1855`) and `close_terminal_tenant` (`host.rs:3308`) send the same frame while the process still serves, and `Session::close` kills the PTY. The pruner's `close_all` (`terminal_sessions.rs:3067`) and the registry's drop send no frame a tab can read: the socket loop's shutdown arm closes with 1001 first (`crates/chan-server/src/routes/terminal.rs:854-862`), and the drop runs after every socket task has gone. The SPA cannot tell a park from a kill. Keeping the terminal's session id on `closed{shutdown}`, which the reload needs to reattach a parked PTY, makes a reload after a kill attach an id the new process lacks; the attach route then creates a fresh shell from the query, which on a reattach carries no cwd, command or profile, so the tab comes back on the default profile where a tab saved without its id would have passed its profile, and the key protocol the tab restored beside its id is not reset for the new session (the new-id branch resets mouse modes and the alt screen only), so Shift+Enter in that plain shell sends a modified-key escape. Before the fix the outcome depended on which session save won the stop; after it the reload after a drain always attaches the dead id. Between a stop and the reload, the kept id also reads as a live shell to the restart confirmation and to `cs pane close`, which then warn about killing a shell that is already dead.

## Desired contract

The server names a shutdown that parks the PTY apart from one that ends it, and a terminal tab keeps its session id only when a restore is coming.

## What to do

A second close reason for the killed case (or the park case), sent where each path closes its sockets, with the SPA's `CloseReason` type and the shutdown arm of `TerminalTab.svelte` keeping the id only on the park reason. Red first: a chan-server test that drives the drain endpoint and asserts the reason on the wire; a mounted test that the SPA clears the id on it and keeps it on the park. Decide separately whether a reattach that falls back to a fresh shell should carry the tab's profile and cwd, which would make the fallback correct on every path.

## Boundaries

`crates/chan-library/src/terminal_sessions.rs` and `host.rs` (the detach, the drain and the tenant close, and `CloseReason`), the wire type in `crates/chan-server/src/routes/terminal.rs`, and the `closed` arm and `CloseReason` type in `web/packages/workspace-app/src/components/TerminalTab.svelte`. The fd-store park and restore are [a-restart-replays-only-the-manifest-tail](a-restart-replays-only-the-manifest-tail.md).

## What shipped

The build is on the integration branch and not on `main`: seven commits, nine files, accepted on 2026-10-01, both halves in one range by a ruling of the lead's, since the two share one wire word, and the lead read the production diffs of both whole. The range opens with a cleanup the review of the restored terminal's close had found, the manifest writer's unused identity lookup ([a-restored-terminals-close-signals-a-bare-pid](a-restored-terminals-close-signals-a-bare-pid.md)). Lines at the integration branch's tip.

- **The server names the park.** `CloseReason` gains `Parked`, `parked` on the wire (`crates/chan-library/src/terminal_sessions.rs:1227`, `:1238`), which the fd-store detach before a restart broadcasts in place of `shutdown` (`:5591`); the drain that `chan devserver stop` and `restart --force` call and the tenant teardown keep `shutdown`, which still means the PTY is gone, and every other reason is unchanged.
- **The tab keeps its id only when a restore is coming.** The SPA's `CloseReason` type carries `parked` (`web/packages/workspace-app/src/components/TerminalTab.svelte:283`), and the `closed` arm clears the session id on every reason but `parked`, an unknown one included, so a reload after a drain no longer attaches a dead id and comes back with the tab's saved profile (`:1672`); the arm's comment says so.
- **The words.** `crates/chan-library/design.md` says what each close reason means across a restart, and the changelog's entry under Fixed says that a reload after a devserver stop starts terminals with their saved profiles and that only a terminal parked for restoration keeps its id.

Pinned red first: a chan-server test on the drain endpoint's wire reason beside its endpoint fixture, the detach's reason through the real socket route, and a mounted pin of the tab keeping the id on `parked` and clearing it on `shutdown`; a server mutation that sends the park as `shutdown` reds the park pin alone, and the SPA's mutation its own; both suites, the web check and both gates green at the tip, by the lane's report. The reattach fallback carrying the tab's profile and cwd, the separate question above, was settled by the owner on 2026-09-26 and is not this range's: at this build a reattach that falls back to a fresh shell still carries no profile or cwd. Residual: no browser reload after a real `chan devserver stop` was driven.
