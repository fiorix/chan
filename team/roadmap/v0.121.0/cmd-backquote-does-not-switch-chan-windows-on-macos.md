# Cmd+` does not switch chan windows on macOS

Status: carried into v0.121.0 at the v0.120.0 GA. The row it came from ([Hybrid Nav's stage keys miss their mnemonics, and Cmd+` does not switch chan windows on macOS](../done/hybrid-nav-stage-keys-miss-their-mnemonics-and-cmd-backquote-does-not-switch-chan-windows-on-macos.md)) shipped its stage letters in v0.120.0 (`4dfcdb2c3`); this half waited for the owner's macOS reading, which had not arrived by the cut.

## What was asked

On chan-desktop for macOS, Cmd+` cycles through chan's open windows (the launcher, workspace windows and terminal windows) as it does in other Mac apps, from any focus inside them: a terminal of either backend, an editor, a list, a raised cover.

## What is there now

Nothing found by reading blocks Cmd+` in the page: the window key handler lets it through on purpose even behind a cover (`App.svelte`, "Let cmd+` through to the native window cycler") and binds only Ctrl+`, which flips the pane. A fix needs the reading first: in chan-desktop with two windows open, press Cmd+` with the focus on the launcher, in a workspace window outside any terminal, in an xterm.js terminal, in a ghostty terminal and behind a raised cover, and record which of them cycle (the v0.120.0 round's check `dev/v0120-team/mac/check-1-navkeys.md`, archived with that round).

## Next

The owner's reading, then a decision: a fix in the key handling of whichever focus swallows the chord, or a WebView-level binding if none of them delivers it to the page.
