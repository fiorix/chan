# The launcher chord does nothing over a reconnecting window

Status: raised by the owner on 2026-11-08 with a screenshot and placed in v0.126.0; built on `fix/launcher-from-reconnecting-window` (`567312fbf`, `9c6d44c27`) and read on the owner's Mac the same day, awaiting review.

## What was seen

On macOS, a devserver terminal window whose connection dropped (titled "lima-default Terminal Window 1" behind the devserver arrow) shows the reconnect overlay: a spinner, "reconnecting to the chan server", the fourth attempt at two seconds, Reconnect and Abandon. Cmd+P, View > Toggle Launcher, does nothing there. The owner expects the Computers screen to open from any window, a reconnecting one included, so the user can go elsewhere without abandoning it.

## Cause

Read at `fa08475b3`. The overlay raises the `reconnect` cover (`web/packages/workspace-app/src/components/DisconnectOverlay.svelte:95`). While any cover is up, the window key handler (`App.svelte:824-836`, a document keydown listener, `App.svelte:1439`) cancels every key aimed at the app with `preventDefault`, letting through only Cmd+` and the cover's own fields and buttons. Cmd+P is not the page's: it is the macOS menubar's accelerator (`desktop/src-tauri/src/main.rs:6135-6137`), and WKWebView offers a Command chord to the focused page before AppKit matches the menubar, resending it only when the page left the default (wry hands a window's own webview to WKWebView's `performKeyEquivalent:`; release v0.79.1 recorded the same mechanism for ghostty's `preventDefault`). The cancelled keydown therefore never reaches Toggle Launcher. The comment at `main.rs:6133-6134` stated the opposite order. The desktop side is not involved: a `lib-*` window can host the launcher (`can_host_panel`), and off macOS the key bridge claims Ctrl+Shift+P on the window's capture phase (`key_bridge.js:286`), before the page's listener, so the chord already worked there behind a cover.

The same cancel holds Quit (Cmd+Q), Hide, Hide Others, Minimize and New Window behind any cover on macOS. And while the launcher shows over a window, a connection drop made the overlay focus Reconnect (`DisconnectOverlay.svelte:134`), which takes the keyboard back from the launcher.

## Desired contract

1. Behind any full-window cover on chan-desktop for macOS, the menubar's window-level chords (Toggle Launcher, New Window, Quit, Hide, Hide Others, Minimize) keep their default and reach no app handler; every other key stays cancelled.
2. A browser tab and the other desktop platforms keep cancelling what reaches the page; off macOS the key bridge keeps the launcher chord.
3. Opening and closing the launcher over the reconnect overlay leaves its card focused and working, and the overlay never takes the keyboard from a launcher shown over the window.

## Boundaries

`App.svelte`'s cover branch, a new `state/menubarChords.ts`, `DisconnectOverlay.svelte`'s focus handling, their tests, the corrected comments in `main.rs`, and the two design docs. Not changed: what a cover blocks otherwise, the key bridge, the launcher panel.

## Acceptance

1. Unit tests: each cover passes Cmd+P with its default and stops it; each listed chord passes; Cmd+K, Cmd+Shift+P, Cmd+T, Cmd+W, Cmd+A and Ctrl+P stay cancelled and Ctrl+D closes no tab; a browser cancels Cmd+P; the real key bridge toggles the launcher off macOS behind the cover; the overlay keeps or regains its focus across a launcher show and hide. Red on the base, green on the fix.
2. A real-browser run against a `chan serve --standalone` that is then killed: Cmd+P invokes the toggle on the fix and not on the base.
3. The owner's macOS run with `dev/reconnect-launcher/run-desktop.sh`: Cmd+P over a reconnecting devserver window shows the Computers screen, Cmd+P again brings the card back, and Enter on Reconnect still works.

## Build findings

- Vitest on the base (`fa08475b3` sources of `App.svelte` and `DisconnectOverlay.svelte`, new tests): 15 of 62 failed, every pass-through case and three focus cases; all 62 pass on the fix.
- Headless Chrome 126 with the real `key_bridge.js` as an init script, a stubbed invoke and a model of the menubar's resend (an uncancelled Cmd+P invokes `toggle_launcher_panel`), the server killed to raise the overlay. Base: Cmd+P cancelled, 0 toggles; the overlay focused Reconnect while the launcher was marked shown. Fix: Cmd+P not cancelled, 1 toggle; Cmd+K cancelled with no deck; Reconnect focused before and after a launcher round trip, Enter reconnects, Tab reaches Abandon; a drop while the launcher shows leaves focus alone until the launcher hides, then Reconnect. Linux: Ctrl+Shift+P toggled on both, plain Ctrl+P cancelled.
- Read on the owner's Mac on 2026-11-08 with the branch's debug build (`git-18505c9ce8e3`), an isolated desktop and a throwaway devserver: with the devserver stopped and the window showing the reconnecting card, Cmd+P opened the Computers screen; the owner reported it works.
