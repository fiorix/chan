# The Rich Prompt's Ctrl+Shift+P never fires on the Linux and Windows desktop

Status: landed on main at `a75b8ffe5` (2026-10-27).

## What was asked

Found while rewriting the manual's Computers screen pages on 2026-10-27; the owner's words: "could we use ctrl+shift+p for rich prompt, to match cmd+p on mac, and then ctrl+alt+p for rich prompt, although on mac it remains cmd+shift+p?", meaning Ctrl+Shift+P stays the launcher toggle and the Rich Prompt moves to Ctrl+Alt+P.

## Evidence

Read at `b0a1fbfd2`. On the Linux and Windows desktop `desktop/src-tauri/src/key_bridge.js` claims Ctrl+Shift+P for Toggle Launcher (`case 'KeyP'`) in window capture before the page sees it, while `web/packages/workspace-app/src/state/shortcuts.ts` and the manual's Terminal page gave the Rich Prompt the same chord off macOS, so it could not fire there.

## Desired contract

The Rich Prompt is Cmd+Shift+P on macOS and Ctrl+Alt+P on Windows, Linux and web, matching the Cmd+K / Ctrl+Alt+K command launcher pair. Ctrl+Shift+P stays the desktop's Toggle Launcher, the off-macOS twin of Cmd+P.

## What landed

`a75b8ffe5` changes `osChord`'s Rich Prompt branch, the registry note, App.svelte's chord matcher and the manual's Terminal page, with a test that Ctrl+Shift+P leaves the composer alone; that test and the Ctrl+Alt+P toggle test fail against the old matcher.

## Acceptance

- In Chan Desktop on Linux and Windows, Ctrl+Alt+P toggles the Rich Prompt on a focused terminal and Ctrl+Shift+P toggles the launcher; Settings > Keyboard Shortcuts and the terminal's right-click menu show Ctrl+Alt+P.
- The AltGr side of Ctrl+Alt+P on Windows is the measurement in [Ctrl+Alt chords may be refused as AltGr typing on Windows](ctrl-alt-chords-may-be-refused-as-altgr-typing-on-windows.md).
