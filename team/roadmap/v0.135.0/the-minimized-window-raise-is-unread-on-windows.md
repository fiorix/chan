# The minimized-window raise is unread on Windows

Status: moved to v0.133.0 by the owner on 2026-11-19 ("move them and cut"); read in part on the Windows VM: with another chan window in front, `cs window open` restored and raised the minimized window (jobs J124 and J126); with another application in front, 20 of 20 (J134), each cycle also putting that application into menu mode (`SC_KEYMENU`); whether the row closes on the raise is the owner's call. Moved to v0.134.0 by the owner on 2026-11-20 ("the carry items and the current items in v0.133 move to v0.134 roadmap"). Moved to v0.135.0 by the owner on 2026-11-23 ("all other roadmap items will move to next version").

Record before the move: carried from v0.131.0 on 2026-11-17 under the owner's release-first ruling ("if things get more complicated we move to next version"); not started.

Record: [the minimized-window row](../done/a-minimized-window-stays-minimized-when-cs-window-open-a-window-lists-focus-or-about-brings-it-back.md) shipped in v0.131.0 on its tests and its readings in a Linux desktop guest (acceptances 1 and 2). Its acceptance 3 on the Windows test VM did not run: the reading on the release candidate stopped twice in its test kit before any `cs window open` cycle (`dev/v0131-team/evidence/Ops131/winvm131/10b-unbury/`, `10c-unbury/`).

## What is there now

The kit (sealed as `dev/v0131-team/evidence/Desk131/unbury-windows69/`, resealed with one fix as `dev/v0131-team/evidence/Ops131/unbury-windows69-r2/`) starts the installed desktop on a fresh private library, finds a connected terminal window, minimizes it and asks `cs window open` to bring it back, ten times. Found when it ran on the candidate `a8045711f`: first, Windows PowerShell 5.1 passed an empty string for `$null` to `File.Replace`'s backup path, which the second write of a record refused (fixed in r2 with `[NullString]::Value`); then the kit's discovery found "no connected boot terminal with a unique native window", since the desktop on a fresh library opened a workspace window (`WINGEO resolve label=local::w-...` in its log), and no cycle ran.

## Desired contract

1. The kit's discovery finds the window the desktop opens on a fresh library, or opens a terminal window itself through a documented path, before its cycles.
2. Acceptance 3 of the minimized-window row reads as written: on the Windows test VM, `cs window open` on a minimized window, ten runs, the window restored and in front.

## Acceptance

1. The kit's discovery and its classifier controls shown able to fail, then the reading on the Windows test VM at the integration tip: ten of ten restored and in front, or the product red with its records.
2. The minimized-window row's status line in `done/` and this row's closing section say what was read.
