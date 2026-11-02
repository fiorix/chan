# Cmd+` does not switch chan windows on macOS

Status: carried into v0.121.0 at the v0.120.0 GA. The row it came from ([Hybrid Nav's stage keys miss their mnemonics, and Cmd+` does not switch chan windows on macOS](../done/hybrid-nav-stage-keys-miss-their-mnemonics-and-cmd-backquote-does-not-switch-chan-windows-on-macos.md)) shipped its stage letters in v0.120.0 (`4dfcdb2c3`); this half waited for the owner's macOS reading, which had not arrived by the cut.

## What was asked

On chan-desktop for macOS, Cmd+` cycles through chan's open windows (the launcher, workspace windows and terminal windows) as it does in other Mac apps, from any focus inside them: a terminal of either backend, an editor, a list, a raised cover.

## What is there now

Nothing found by reading blocks Cmd+` in the page: the window key handler lets it through on purpose even behind a cover (`App.svelte`, "Let cmd+` through to the native window cycler") and binds only Ctrl+`, which flips the pane. A fix needs the reading first: in chan-desktop with two windows open, press Cmd+` with the focus on the launcher, in a workspace window outside any terminal, in an xterm.js terminal, in a ghostty terminal and behind a raised cover, and record which of them cycle (the v0.120.0 round's check `dev/v0120-team/mac/check-1-navkeys.md`, archived with that round).

## Next

The owner's reading, then a decision: a fix in the key handling of whichever focus swallows the chord, or a WebView-level binding if none of them delivers it to the page.

## Closing

Read on the base on 2026-11-02 and closed with no code change. On the owner's Mac (macOS 27.0.1, the ABC layout, "Move focus to next window" at the system default: entry 27 is absent from `com.apple.symbolichotkeys`), the installed chan-desktop 0.120.1 (build `git-bd6e46a0dce0`, the base's code) ran as an instance isolated beside the owner's running one, with its own `CHAN_HOME` and `XDG_RUNTIME_DIR` and a throwaway workspace. Cmd+` was pressed twice from each focus this item names and one more: the launcher on its Computers screen, a workspace window outside any terminal, a ghostty terminal, an xterm.js terminal, behind the command list and behind a "Close tab?" confirm. The owner's reading: "they rotate focus correctly". Every focus cycles, so neither the page nor the desktop holds the chord on this build, and no fix is called for.

Not established: the reading covers the focuses together, so the window order after each press was not recorded. Only a fresh instance was read; the owner's own long-running windows, where the original report came from, were not. If Cmd+` fails there again, the state those windows carry is the next thing to read; the dndloss item found a window's hidden launcher webview taking that window's drags after a launcher toggle. The Window menu was not read, since no focus failed.
