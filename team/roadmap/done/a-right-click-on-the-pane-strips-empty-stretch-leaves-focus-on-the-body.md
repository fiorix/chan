# A right-click on the pane strip's empty stretch leaves focus on the body

Status: shipped in [v0.125.0](../../release/release-v0.125.0.md).

Record before the release: built for v0.125.0 and carried in its first release candidate `0.125.0-rc0` (`67fd26b38`); check 209 read green at the final tip in the release's guest.

## What was seen

Reported by the subagent that fixed [escape-does-not-close-a-terminals-right-click-menu](../done/escape-does-not-close-a-terminals-right-click-menu.md): after a right-click on the pane strip's empty stretch, which since v0.124.0 opens the pane's menu in place of the browser's ([the-pane-and-terminal-menus-offer-no-way-to-the-command-launcher](../done/the-pane-and-terminal-menus-offer-no-way-to-the-command-launcher.md)), the document's focus is on the body rather than on the tab that held it. Not read further: whether keys typed after the menu closes reach the active terminal, and whether the strip's own tabs, a side with no tab and the Commands row behave the same.

## Desired contract

1. Opening and closing the pane's menu from the strip's stretch leaves the keyboard where it was before the right-click, as the terminal's own menu does; Commands keeps handing focus back to what the menu opened over.
2. A right-click that opens no menu moves no focus.

## Acceptance

1. The reading first: in a browser check, right-click the strip's stretch over a focused terminal, close the menu by Escape and by a click outside it, and type a marker read back from the PTY, on both engines.
2. Then a mounted test and that check red before the fix and green after.

## Built

- Commits: `e63b8208d` shares the PTY recorder used by the browser checks; `c97262b60` adds check 209; `a0ab72f9d` keeps focus on the original surface through a right press on another pane's strip or on a parent-page body with no caret; `fix(workspace-app): focus pane surface from a left strip press` (this commit) focuses the active terminal, editor or welcome and asserts check 209's left and split arms.
- The stage 1 base reading had check 207 green and check 209 red twice: xterm and ghostty controls held terminal focus and delivered PTY marker `78`, but the strip menu's Escape and Commands paths opened over `BODY.`; the empty welcome menu paths also opened over `BODY.`. The initial left and other-pane stretch readings were observational and ended on `BODY.`. At the first fix tip, guest check 209 passed twice, and 206 and 207 passed (`checks-2.log`); both engines kept terminal focus and delivered `78` for the asserted terminal paths, and the empty pane kept welcome focus (`checks-2-readings.txt`). The still-observational left and other-pane stretch arms ended on `BODY.` at that tip, motivating the final assertions. The final check 209 guest reading remains pending.
- The owner's 2026-11-06 answers extend the no-focus-move rule to dashboard, extension and Hybrid Nav preview bodies where the parent page receives the right press and leaves the browser's menu in control; a right press on another pane's stretch opens that pane's menu while `paneContextOpener` remains the pre-click holder. A left press on the stretch focuses that pane's active surface, like a window title bar. Pointer events inside an extension iframe belong to its inner document and cannot be intercepted by the parent page.
- Mounted regressions were red first: four new right-press arms failed against the first fix tip, for another pane's stretch, dashboard and extension body gaps, and Hybrid Nav preview; four new left-press arms failed against `a0ab72f9d`, for terminal, source editor, welcome and another pane's terminal. The final mounted suite passes 13/13. Check 209 now asserts the left and split focus and PTY arms for both engines and the empty welcome's left-click arm; the lead owns its base and final guest readings.
- Gates by commit: `e63b8208d` passed `make e2e-check` and `make browser-smoke-lib-test`; `c97262b60` passed committed-state `make e2e-check`; `a0ab72f9d` passed committed-state `taskset -c 0-7 make web-check` (shared 243/243, launcher 763/763, workspace 8580/8580, profile 20/20, checks and builds clean); this commit's code passed the same committed-state web gate (243/243, 763/763, 8584/8584, 20/20, checks and builds clean), `make e2e-check` (189 files), and `make browser-smoke-lib-test` (64/64), before this record-only amendment.
