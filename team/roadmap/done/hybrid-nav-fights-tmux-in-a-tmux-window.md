# Hybrid Nav fights tmux in a tmux window

Status: shipped in [v0.123.0](../../release/release-v0.123.0.md).

Record before the release: found and built on 2026-11-03 on the owner's local branch `hybrid-nav-tmux` (base `762f95240`), rebased onto `main` for v0.123.0 by the owner's release order of the same day; landed, closes at the GA.

## What was there

Hybrid Nav treated a `tmux -CC` window as a chan layout and fought tmux:

- A split (`/`, `?`) staged a local shell. Its first session frame renamed the staged terminal and marked the transaction stale ("Layout changed. Esc to discard.").
- Every `tmux_layout` went through the peer-conflict screen, where tmux's tabs (no name, no active marker) never match the entry layout, so any layout tmux sent read as a conflict.
- A browser resize during the mode asked tmux for the old grid, since terminals measure nothing while the draft shows, and nothing asked again afterwards.
- A divider drag sent its `resize-pane` on release even while Hybrid Nav was up, so it reached tmux before Enter, Escape could not undo it, and it started a drag hold on the window size beside the mode's own.
- The A/B flip, send-to-side and Hybrid Nav's `Tab` acted on panes that are tmux's panes, which have no sides.

## Desired contract

1. In a tmux window, Hybrid Nav stages what tmux will be asked for. A split adds an empty "New tmux pane" to the draft and starts no local shell; a staged pane takes no further split or divider move. A divider move, by key or by a drag, previews in the draft and sends nothing.
2. Enter sends the `resize-pane` requests, then the splits in the order staged, one at a time; the live tree stays tmux's and its next layout shows the result. Escape sends nothing.
3. tmux layouts, peer session blobs and terminal renames apply to the live tree at once and never mark the transaction stale.
4. The tmux window-size ask is held while Hybrid Nav is up and follows when it ends.
5. A tmux window's panes have no A/B sides: the flip, send-to-side, tile swaps and tab staging are refused there, and the launcher and the cheatsheet do not offer them.
6. Outside Hybrid Nav, and in windows that show no tmux pane, nothing changes.

## Closing

Two commits on the release branch, rebased from the owner's branch:

- `8caa04691` (from `1d38956e2`), fix(terminal): stage Hybrid Nav splits and resizes for tmux windows. `enterPaneMode` sets `paneMode.tmux` when the window shows a tmux pane; splits and divider moves record what tmux is asked for; `tmuxPaneModeRequests` (`state/tmuxResize.ts`) builds the calls the commit sends through `sendTmuxCalls` in `App.svelte`; remote changes apply to the live tree at once; `flipHybrid` and `moveActiveTabToSide` refuse in a tmux window and the launcher hides the flip and send-to-side commands.
- `26c46dc93` (from `13bd63cc8`), fix(terminal): stage a tmux divider drag during Hybrid Nav. During the mode a drag in a tmux window goes through the transaction like a keyboard divider move: it previews, sends nothing and starts no drag hold, and its release records the split through `noteTmuxResize`, so Enter sends it and Escape drops it. A press on a divider whose split the live tree lacks (a staged split, or one tmux's layout replaced during the transaction) is refused.

Verification recorded in the commits, in an sdme guest on the old base: new browser check `198-hybrid-nav-tmux` drives Hybrid Nav over a real `tmux -CC` window, red at the base (stale on the first split, a local shell started; a drag reached tmux before Enter, 87 cells became 63) and green with the change; checks 15, 99, 123 and 195 pass beside it; new `App.paneMode.test.ts` tests ("in a tmux window"), and 13 mutations each removing one part of the first commit turn them red. The workspace design and the manual's tmux section say what Hybrid Nav does in a tmux window.
