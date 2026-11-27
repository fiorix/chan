# The half-scale wake fix is unread on macOS

Status: carried for v0.133.0 by the lead on 2026-11-19 under the owner's "move them and cut"; not started. Moved to v0.134.0 by the owner on 2026-11-20 ("the carry items and the current items in v0.133 move to v0.134 roadmap"). Moved to v0.135.0 by the owner on 2026-11-23 ("all other roadmap items will move to next version"). Moved to v0.136.0 at the v0.135.0 GA on 2026-11-27, not built in v0.135.0.

Record: [the half-scale wake row](../done/terminals-come-back-at-half-scale-in-their-old-grid-after-a-sleep-on-macos.md) shipped in v0.132.0 on check 296 in a guest's Chrome at a device scale of 2 and on its unit and mounted tests. Its readings on the owner's Mac, where the fault was seen, and in Chan Desktop under WebKitGTK at a device scale of 2 were not made: the WebKitGTK driver's job (J121 in `dev/v0132-team/ops/queue.md` in the development tree) was held at the round's pause on 2026-11-18 and not rerun.

## What is there now

- The fix: `web/packages/ghostty-web-ng/lib/renderer.ts` sets the canvas transform absolutely at the start of every frame and in `resize()`, so a reset drawing state at an unchanged size heals at the next repaint.
- The mechanism was read from the owner's screenshot (each cell drawn at one device pixel per CSS pixel at a ratio of 2, the grid kept) and from the code. What resets the canvas in WKWebView across a sleep is not established.
- The done row's reading procedure (three inspector lines for an affected window) and the WebKitGTK driver `scripts/e2e/desktop-observations/scale2-repaint.sh`.

## Desired contract

1. On the owner's Mac, on a build carrying the fix, no terminal comes back at half scale after a sleep; or the done row's reading procedure, run at the next occurrence before a reload, names another cause, which then gets a row of its own.
2. In Chan Desktop under WebKitGTK at a device scale of 2, a ghostty terminal whose canvas drawing state was reset while hidden repaints at full scale on its next frame, with no grid change and no size sent.

## Acceptance

1. The done row's acceptance 6 on the owner's Mac: a week of daily use with no terminal at half scale after a sleep, or three provoked runs each ending at full scale with no reload; or the reading of contract 1 recorded with its console output.
2. The done row's acceptance 5: `scale2-repaint.sh` in the desktop guest at a device scale of 2, red at the base and green at the tip, or a record that the guest cannot run at that scale.
3. The done row's status line and this row's closing section say what was read.
