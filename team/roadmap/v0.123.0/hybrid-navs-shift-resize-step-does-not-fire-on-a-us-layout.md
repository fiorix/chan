# Hybrid Nav's Shift resize step does not fire on a US layout

Status: found on 2026-11-03 as a known gap of the tmux staging work on the owner's local branch `hybrid-nav-tmux` and built there, rebased onto `main` for v0.123.0 by the owner's release order of the same day; landed, closes at the GA.

## What was there

Shift scaled Hybrid Nav's `[` `]` `-` `=` divider step from 0.02 to 0.1, and the cheatsheet carried a label-only "Shift + [ ] - =" / "Larger nudge" row for it. On a US layout Shift turns those keys into `{` `}` `_` `+`, which Hybrid Nav does not bind, so the larger step never fired there. On a layout that types one of them with Shift (`=` is Shift+0 on a German one) that key always took the larger step while its pair did not.

## Desired contract

1. Hybrid Nav's divider keys move a divider by one step whatever the modifiers, on every layout.
2. The cheatsheet lists no larger step.

## Closing

`ef4cbab28` (from `28dd92eb9`), feat(workspace-app): drop Hybrid Nav's Shift resize step. The step is one constant, `PANE_MODE_RESIZE_STEP` beside the clamp in `paneModeResize`, which loses its amount argument. The cheatsheet row goes, and with it the label-only cap kind it alone used: every cap is a button with a key. Plain `[` `]` `-` `=` are unchanged, tmux clamping too.

Verification recorded in the commit: the resize test presses the grow key with Shift and expects one step, the cheatsheet's group list no longer has the row, and the label-only cap test goes.
