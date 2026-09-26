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
