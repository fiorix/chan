# Full-window covers hide the app without blocking it

Status: shipped in [v0.100.0](../../release/release-v0.100.0.md): Every full-window cover blocks keyboard chords, the Ctrl+D capture and host commands through one registration, and the screensaver lock is a real boundary for its window.

## What was seen

The app has one mechanism for "a full-window cover is up, stop driving the app behind it", and it has one member. `ui.disconnectBlocking` in `web/packages/workspace-app/src/state/store.svelte.ts` is written only by `DisconnectOverlay.svelte` and read by two keyboard guards in `App.svelte` (`onWindowKey` and `onCtrlDCapture`). The four other full-window covers set nothing: `SessionEndedOverlay`, `ScreensaverOverlay`, `MissingTokenOverlay` and `PreflightOverlay`.

So with the screen locked, Ctrl+D still closes the focused tab and Ctrl+Shift+T still spawns a focus-stealing terminal behind an opaque cover: a user can drive the app blind. The screensaver's own key handler never stops propagation, and `screensaver.locked` has no consumer outside the overlay and its state module. The host-command bridge `runCommand` does not gate commands on it, so a native menu item fires behind every cover, the reconnect one included. Its one read of the flag, in the window-close case, is a different use: while the reconnect overlay is up the desktop's close button discards the session without the Hide, Close or Cancel prompt, because there is nothing left to interact with.

Two neighbours belong to the same piece of work. A preflight poll that gives up while its snapshot is still locked leaves the cover up forever with nothing behind it to retry. And "Lock screen now" is offered in every standalone terminal and control window, where it can never fire: the command family is registered for any window while `loadScreensaverState()` runs, and its routes exist, only for a workspace window.

## Desired contract

Every full-window cover blocks app input for as long as it is mounted, through one registration that a new cover cannot forget: keyboard chords, the Ctrl+D capture and host commands all consult it. The Backquote escape hatch keeps working. A cover that gives up releases both the pixels and the block. A command is offered only in windows where it can run.

What the screensaver lock is meant to be is an owner ruling that shapes the rest: a real boundary (the host bridge and native menu gated, focus trapped) or a cosmetic cover that says so. The contract above is the floor either way. Owner ruling, 2026-09-20: a real boundary for this window. While the lock is up, host-bridge commands and native menu items are gated through the same registration, and focus is trapped in the PIN field. It locks this window's input and not the server: another window, or the bearer token, still reaches the sessions, and the text that documents the lock says so. That text is the Settings hint in `components/settings/workspace/ScreenLockControl.svelte`, where a user decides to rely on the lock; the overlay's own copy stays as it is. One gate in `runCommand` covers the native menu as well as the host bridge, because every native row reaches the SPA as a `chan:command` event (`eval_chan_command` in `desktop/src-tauri/src/main.rs`); Tauri's predefined items act on the window or the operating system and are outside the lock.

## Boundaries

`web/packages/workspace-app/src/state/store.svelte.ts` (the flag becomes a counted or keyed registration), `App.svelte` (`onWindowKey`, `onCtrlDCapture`, `runCommand`), the five overlay components, `state/windowMode.ts` and `state/commands/core.ts` for the lock command family, and the tests `components/ctrlDCloseTab.test.ts`, `components/screensaverThemes.test.ts`, `components/terminalOnlyTenantGates.test.ts`, plus a new cover-parity test. `App.svelte` and `store.svelte.ts` are one lane. One trap: the window-close fast path must stay keyed to the reconnect overlay alone. If it reads the generalized block, closing a window from behind the screensaver lock would discard its session with no prompt. This item lands before [shortcuts-ignore-the-keyboard-layout](shortcuts-ignore-the-keyboard-layout.md).

## Acceptance

1. For each full-window cover, mounting it registers the block and unmounting clears it; a test enumerates the covers so a sixth cannot skip it.
2. With any cover up, a synthetic Ctrl+D, Ctrl+Shift+T and a host `chan:command` event each change nothing: no tab closed, no terminal spawned. Backquote still passes.
3. A preflight that gives up drops its cover and its block, and the window is usable.
4. The lock command, and the six other `app.screensaver.*` commands that call the same per-workspace routes (`enable`, `disable`, `test`, `setPin`, `theme.plain`, `theme.matrix`), are absent from the command list of a standalone terminal and a control window, and present and working in a workspace window.
5. With the screensaver lock up, the desktop's close button still raises the Hide, Close or Cancel prompt; with the reconnect overlay up it still closes without one.
6. With the screensaver lock up, focus cannot leave the PIN field, a native menu command changes nothing until the PIN is accepted, and the text that documents the lock says it locks this window's input and not the server.
