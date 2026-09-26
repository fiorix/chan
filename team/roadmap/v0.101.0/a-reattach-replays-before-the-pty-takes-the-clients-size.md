# A reattach replays and redraws before the PTY takes the client's size

Status: accepted for v0.101.0 by the owner on 2026-09-26; raised the same day from the owner's own terminal after a pane split (`.Drafts/untitled-11/draft.md` in the owner's workspace, a code-path diagnosis with a screenshot; validated by the lead against `main` at `cdd266b09`). Not reproduced in a harness.

## Owner ruling

Accepted on 2026-09-26 as the lead recommended, folded into the runtime lane's attach prelude order (the one that gives the attach order and the resize a Rust test), since it changes the same prelude.

## What was seen

The terminal attach route receives the client's declared size but never applies it before the prelude: `send_attach_prelude` (`crates/chan-server/src/routes/terminal.rs:1104`) sends the session frame, the retained replay, the alt-screen prelude and the mode re-assert, then asks the foreground program to redraw (`:1141`) with the PTY still at whatever size its last client set; the client's resize frame is consumed only in the socket loop after the prelude (`:882`). A renderer that attaches at a different size from the previous one therefore gets a repaint at the old size and repairs it only after its own resize round trip, and a full-screen program redraws twice.

## Desired contract

On reattach the PTY takes the client's declared size before the replay and the redraw nudge, so the first repaint lands at the size the renderer has.

## What to do

Resize the session to the attach request's size (the library's `resize` exists at `crates/chan-library/src/terminal_sessions.rs:1370`) before the prelude when it differs from the PTY's current size; pin the order (resize, replay, prelude, redraw) in the chan-server test the attach prelude order gets. This repairs the current screen only: history recorded at another width stays as it was written, which is [a-pane-split-rebuilds-a-live-terminal-from-old-width-bytes](a-pane-split-rebuilds-a-live-terminal-from-old-width-bytes.md).

## Boundaries

`crates/chan-server/src/routes/terminal.rs` (the attach path and its test) and the resize seam in `crates/chan-library/src/terminal_sessions.rs`.

## What shipped

Landed on 2026-09-26. The attach route fits the PTY to the size the client declared before it sends the prelude, when that size differs from the size last requested of the PTY, so the program's first repaint after an attach is at the renderer's size; an attach that declares the PTY's own size resizes nothing. A re-attach after an in-place restart is fitted to the size its socket declared last. When two sockets fit, the later one sets the size the PTY ends at.

Only a declared size is applied, and the server cannot tell a measured grid from a default: a client that dials before its fitter has measured its host gets the PTY fitted to that default until its own Resize frame arrives. The workspace app's side of that is [a-pane-split-rebuilds-a-live-terminal-from-old-width-bytes](a-pane-split-rebuilds-a-live-terminal-from-old-width-bytes.md). After a devserver restart the comparison can read a recorded size that lags the PTY's, which is [an-adopted-sessions-recorded-size-can-lag-its-pty](an-adopted-sessions-recorded-size-can-lag-its-pty.md).
