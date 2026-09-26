# A fresh session under an old tab id keeps the tab's key protocol

Status: landed in the terminal tab lane of team v0101 with [a-graceful-restarts-session-save-drops-the-terminals-session-id](a-graceful-restarts-session-save-drops-the-terminals-session-id.md), from the independent review of that lane's first order (`dev/v0101-team/reviews/review-Clients-1.md`, finding 1, in the development tree); raised and fixed during v0.101.0 on 2026-09-26. A source reading against `main` at `1566b06d0`; not observed in a browser.

## What was seen

A terminal tab restores its key protocol beside its session id from the saved layout. When a reattach to an id the server no longer has comes back as a fresh shell (a `session` frame whose id differs), the new-id branch resets the mouse modes and the alt screen but not the key protocol, and the fresh-spawn path's reset does not run because the tab had an id. A tab that had negotiated modified keys with an agent then sends a modified-key escape for Shift+Enter into a plain shell.

## Desired contract

A session frame that replaces the tab's session with a new id starts the tab from a clean key protocol, as a fresh spawn does.

## What shipped

The new-id branch resets the key protocol too, pinned by a mounted test that restores a tab with a key protocol and an id, answers the dial with a different id, and asserts the next Shift+Enter reaches the PTY as a plain key; a same-id resume keeps the protocol, pinned beside it.
