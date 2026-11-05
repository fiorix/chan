# A right-click on the pane strip's empty stretch leaves focus on the body

Status: raised at the v0.124.0 close from the Escape fix for the terminal's menu, which read the other menus with its browser check's method; needs a reading before a fix; not started.

## What was seen

Reported by the subagent that fixed [escape-does-not-close-a-terminals-right-click-menu](../done/escape-does-not-close-a-terminals-right-click-menu.md): after a right-click on the pane strip's empty stretch, which since v0.124.0 opens the pane's menu in place of the browser's ([the-pane-and-terminal-menus-offer-no-way-to-the-command-launcher](../done/the-pane-and-terminal-menus-offer-no-way-to-the-command-launcher.md)), the document's focus is on the body rather than on the tab that held it. Not read further: whether keys typed after the menu closes reach the active terminal, and whether the strip's own tabs, a side with no tab and the Commands row behave the same.

## Desired contract

1. Opening and closing the pane's menu from the strip's stretch leaves the keyboard where it was before the right-click, as the terminal's own menu does; Commands keeps handing focus back to what the menu opened over.
2. A right-click that opens no menu moves no focus.

## Acceptance

1. The reading first: in a browser check, right-click the strip's stretch over a focused terminal, close the menu by Escape and by a click outside it, and type a marker read back from the PTY, on both engines.
2. Then a mounted test and that check red before the fix and green after.
