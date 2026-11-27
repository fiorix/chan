# The half-scale wake fix is unread on macOS

Status: carried for v0.133.0 by the lead on 2026-11-19 under the owner's "move them and cut"; not started. Moved to v0.134.0 by the owner on 2026-11-20 ("the carry items and the current items in v0.133 move to v0.134 roadmap"). Moved to v0.135.0 by the owner on 2026-11-23 ("all other roadmap items will move to next version"). Moved to v0.136.0 at the v0.135.0 GA on 2026-11-27, not built in v0.135.0. Its Mac reading is made by the owner's word of 2026-11-27, and its WebKitGTK reading was made in a desktop guest at a device scale of 2 the same day, red without the repair and green with it (the last two sections): read.

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

## Read on the owner's Mac by his word, 2026-11-27

Asked whether he had seen a terminal at half scale since the fix shipped in v0.132.0 on 2026-11-19, the owner answered on 2026-11-27: "the wakemac still pending? i thought we handled it; terminals been good so far". That is acceptance 1's first form, eight days of daily use with no terminal at half scale after a sleep, by his word and with no console reading. Contract 1 is met on that word. Still unread: acceptance 2, the WebKitGTK driver `scale2-repaint.sh` in a desktop guest at a device scale of 2, which the same day's ruling puts in the v0.136.0 round ("let's add these to the round"); and acceptance 3's lines.

## Read on WebKitGTK at a device scale of 2, 2026-11-27

Acceptance 2, read by `scripts/e2e/desktop-observations/scale2-repaint.sh` in Chan Desktop on WebKitGTK 2.52.6 in a desktop guest with `GDK_SCALE=2` (monitor scale 2.0, page ratio 2), with the driver's clear-background measure (`v0136/desk-drivers-3` at `ba9368b15`, merged as `1299c3262`). Earlier runs that day could not read: the driver's floor asked for an opaque canvas that Chan Desktop's transparent window never paints. The red leg is the tip with the repair's one line removed from `web/packages/ghostty-web-ng/lib/renderer.ts` (the `setTransform` at the start of the frame paint), the leg the lead chose over the historic base.

- Without the repair: after the window is minimized and activated, the page saw a blur, a hide, a focus and a return to visible, and the terminal repainted at a transform of 1 into the top-left quarter only (4801 painted samples there, 0 in the other three, against a baseline of 5914, 5955, 6331 and 5432 at a transform of 2). The driver read FAULT and the wrapper exited 1.
- With the repair: the same events, and the repaint at a transform of 2 matched its baseline in every quarter exactly (5914, 5955, 6331, 5454). The driver read HELD and the wrapper exited 0.

So the half-scale wake repair holds on WebKitGTK at a device scale of 2, and the fault it repairs is seen there without it. Contract 1 on the owner's Mac stands by his word above. Not read: WKWebView on the Mac by an instrument.
