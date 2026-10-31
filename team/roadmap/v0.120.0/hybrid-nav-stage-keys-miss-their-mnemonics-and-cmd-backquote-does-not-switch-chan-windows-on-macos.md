# Hybrid Nav's stage keys miss their mnemonics, and Cmd+` does not switch chan windows on macOS

Status: raised and accepted for v0.120.0 by the owner on 2026-10-31, during the v0.119.0 cut ("another roadmap item"), with the naming question decided by the owner the same day (the section Decisions); not started.

## What was asked

The owner's words, 2026-10-31: "the hybrid nav, change file browser stage key from 'o' to 'f', diagram from 'i' to 'e' because excalidraw; maybe rename to 'Stage Excalidraw'; and allow the cmd+` on the mac so that we can switch windows across the app; not sure why we block this one". Then, the same day: "we have another window with the same blocked cmd+`, the windows from when a devserver initiated via a script and control terminal and the connection drops.. all terminals and workspaces show a 'reconnecting' window which iirc does not allow cmd+` either; pls add as part of the roadmap item for the analysis".

## What is there now

Read at `e721c63bf`, the v0.119.0 GA commit:

- Hybrid Nav's key handler (`handlePaneModeKey` in `web/packages/workspace-app/src/App.svelte`) stages a File Browser on `o` (with the files capability) and a diagram on `i` (with the drafts capability), beside `t` Terminal, `g` Graph, `b` Dashboard and `n` New Draft. The cheatsheet (`components/PaneModeHelp.svelte`) lists them as Stage File Browser and Stage Diagram, and its tests pin the rows. A staged diagram is a draft of kind `diagram`, the Excalidraw editor, which the command list offers as "New diagram" with the keyword `excalidraw`.
- `f` and `e` are free in Hybrid Nav: the handler takes `t o g b n i`, `w a s d`, `h`, `0`, `[ ] - = / ? < >`, the arrows, Tab, Enter and Escape.
- No manual page lists the stage letters; the cheatsheet is where users read them.
- Nothing found by reading blocks Cmd+` in the page: the window key handler lets it through on purpose even behind a cover (`App.svelte`, "Let cmd+` through to the native window cycler") and binds only Ctrl+`, which flips the pane; chan-desktop's key bridge stays out of Backquote, and a test asserts it (`desktop/src-tauri/src/serve.rs`); the ghostty key listener leaves an unclaimed Command chord to the browser without preventing its default. The macOS menubar is Tauri's default menu with chan's items added; its Window submenu has no item bound to Cmd+`. Where the chord is lost is not established.
- A window whose server connection drops shows one of two reconnect surfaces, and neither blocks Cmd+` by reading either: the workspace app's disconnect cover (`components/DisconnectOverlay.svelte`), behind which the window key handler's blocked-input path lets Cmd+` out on purpose ("so the user can leave a disconnected window for another"), and chan-desktop's bundled connecting screen (`desktop/src/connecting.html`), which a devserver's window opens through while its server may be down (`open_watched_remote_window`), whose only keydown handler takes Cmd+W, Ctrl+W and Ctrl+D. Whether a dropped connection moves an open window to the connecting screen or leaves it on the disconnect cover is not established by reading. The owner recalls Cmd+` not working on the reconnecting windows of a devserver started by a connect script with a control terminal, after its connection drops.

## Desired contract

1. In Hybrid Nav, `f` stages a File Browser and `e` stages an Excalidraw diagram, with the capabilities they need today; `o` and `i` no longer stage anything. The cheatsheet shows the new letters, and its Stage Diagram row reads Stage Excalidraw; the command list keeps "New diagram", which the keyword `excalidraw` already finds.
2. On chan-desktop for macOS, Cmd+` cycles through chan's open windows (the launcher, workspace windows and terminal windows) as it does in other Mac apps, from any focus inside them: a terminal of either backend, an editor, a list, a raised cover, and a window showing either reconnect surface.

## Decisions

The owner's words of 2026-10-31 on the lead's recommendation to rename the cheatsheet row Stage Diagram to Stage Excalidraw and keep the command list's "New diagram": "sure follow the recommendation".

## Open decisions

- Cmd+` needs a reading on macOS before a fix: in chan-desktop with two windows open, press Cmd+` with the focus on the launcher, in a workspace window outside any terminal, in an xterm.js terminal, in a ghostty terminal and behind a raised cover, and record which cycle; then start a devserver from a connect script with a control terminal, open its terminal and workspace windows, drop the connection, and press Cmd+` on a window showing the disconnect cover and on one showing the connecting screen, if any does. Which surface each reconnecting window shows is part of the reading. The candidates the reading separates: the webview's handling of a Command key equivalent the page did not take (wry and WKWebView), the default menu having no window-cycling item, or a page handler not found by reading.

## Acceptance

1. Hybrid Nav tests pin `f` and `e` staging a File Browser and a diagram, and `o` and `i` staging nothing; the cheatsheet tests pin the rows and their labels, Stage Excalidraw among them.
2. On macOS, with the launcher and two workspace windows open, Cmd+` from each of the focuses listed above moves to the next chan window, and so it does from a dropped devserver's reconnecting terminal and workspace windows on both reconnect surfaces; the reading before the fix and the one after are recorded here.
