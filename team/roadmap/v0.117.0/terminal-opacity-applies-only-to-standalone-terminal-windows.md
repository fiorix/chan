# Terminal opacity applies only to standalone terminal windows

Status: raised by the owner on 2026-10-30, after the v0.116.0 tag, with the decision made in the same words; accepted for v0.117.0; not started.

## What was asked

The owner, reading the shipped v0.116.0 on the macOS desktop: the transparency setting does nothing for terminal tabs in workspace windows and for devserver terminals. Asked whether that is a bug, a matter of previously minted windows or a gap in the design, and told it is the design's scope, the owner ruled: "i want all terminal tabs, local or remote, to use the setting of the chan-desktop, because the windows are made by and controlled by chan-desktop; this shouldn't be a devserver feature, but the devserver terminal windows should still be transparent.. and so does the control terminals, and terminal tabs in workspace windows". And, to be crystal clear, in the owner's words: "i only want terminal tabs to be see-through, not all windows".

## Evidence

Read at `f46a812dc` (the v0.116.0 GA commit).

- `desktop/src-tauri/src/serve.rs`, `builds_transparent`: a window is built transparent and its URL carries `transparent=1` only for a local standalone terminal window (`library_id == "local"` and `kind == Some("terminal")`) and the default-terminal window (`terminal-exec`). Workspace windows (kind `None`), devserver windows (a `lib-<hex>` library) and control terminals (kind `control`) are built opaque. The flag is appended only when the window is not a connecting window (`connecting.is_none()`), and a devserver window starts on the connecting page and is navigated in place later (`retarget_watched_remote_window`), so the flag has to ride the retarget target as well as the build.
- The page paints see-through only in a window whose URL carries the flag (`windowIsTransparent` in `web/packages/workspace-app/src/terminal/backgroundOpacity.ts`): a see-through page in an opaque native window shows the window's own background, not the desktop.
- The value the page paints with is its tenant's preference: `currentPreferences()?.terminal?.background_opacity` in `App.svelte` and `TerminalTab.svelte`. In a devserver window that tenant is the devserver, so the slider in Settings > Terminal (`TerminalSection.svelte`, `commit` to the tenant's `PATCH /api/config`) writes the devserver's `server.toml`, and a devserver with the default 100 would paint a transparent window opaque whatever the desktop's own setting says.
- The desktop already pushes events to its pages (`app.emit` for the serves, the devserver control and the update prompt) and the pages reach the desktop through `tauriInvoke` (`web/packages/workspace-app/src/api/desktop.ts`); the desktop's embedded server runs one config watch for every local tenant (`crates/chan-server/src/config_watch.rs`), so a change of the desktop's `server.toml` is already an event inside the desktop process.
- The v0.116.0 item ([a-local-terminal-window-cannot-show-the-desktop-behind-it](../done/a-local-terminal-window-cannot-show-the-desktop-behind-it.md)) scoped the feature to terminal-only windows; the config reference and the Settings hint say so.

## Desired contract

- Only terminal tabs are see-through. Below 100 the body of a terminal pane shows the desktop behind the window; every other surface of every window, the editor, graph, dashboard and file browser panes, the tab strips, the dock, the panels, the status bar, the overlays, the launcher and the connecting page, paints as it paints today, in every window kind. Nothing but a terminal body ever reads through, and at 100 every pixel of every window reads as it does in v0.116.0.
- `terminal.background_opacity` is chan-desktop's setting: the value in the desktop's own `server.toml` governs every terminal tab the desktop shows, in standalone terminal windows, the default-terminal window, workspace windows, devserver windows and control terminals alike. A devserver's own `terminal.background_opacity` plays no part in a desktop window; a browser tab stays opaque, as it has no desktop behind it.
- The native window is the means, not the effect: a window's transparency is fixed when it is built, so every window chan-desktop builds is built transparent and carries `transparent=1`, on the connecting page and on the navigated target alike, which is what lets a terminal tab in it read through and a later change of the setting apply live without reopening. The flag changes nothing the page paints outside a terminal body.
- In a desktop window the page takes the value from the desktop, not from its tenant's preferences: it asks the host once at load and follows a desktop event for every later change. The Settings slider in a desktop window, whatever tenant the window shows, writes the desktop's setting through the host; in a browser tab the row says the setting applies in chan-desktop and writes nothing the tab would paint.
- The backdrop mask with a hole behind each terminal pane card already keeps the pane layer opaque around terminals; every other surface that relies on the body background is audited and given its own, so the first bullet holds in a workspace window, a devserver window and a control terminal, not only in a terminal-only window.

## What to do

1. `desktop/src-tauri/src/serve.rs`: build every window transparent and drop `builds_transparent`; append the flag to the connecting URL and to the retarget target; on macOS keep the title bar layer for every window.
2. Desktop host: a Tauri command that answers the desktop's `terminal.background_opacity` (read from its `server.toml` through the embedded server's config) and one that writes it (the preferences route of the embedded local tenant, so the clamp and the config watch apply); an event the desktop emits to every window when the value changes, fed by the local config watch.
3. Page (`backgroundOpacity.ts`, `App.svelte`, `TerminalTab.svelte`, `TerminalSection.svelte`): in a desktop window the painted value comes from the host and its event, the slider reads and writes through the host; the tenant preference is used only to show the value in a browser tab's Settings with the note. Audit every surface of the workspace app that relies on the body background under `data-terminal-see-through` and give it its own background.
4. Docs: `docs/config-reference.md` (the key is chan-desktop's; a devserver's value has no effect on windows), the Settings hint, `desktop/design.md`, `crates/chan-server/design.md` if the key's row says otherwise.

## Boundaries

`desktop/src-tauri/src/serve.rs`, `main.rs` (the commands and the event), `desktop/src-tauri/capabilities/*.json` and `permissions/app.toml` for the new commands on every window kind; the workspace app files above and the surfaces the audit names; the docs above. Not changed: the handoff protocol, the devserver's config schema, the browser tab's behaviour.

Decisions the build makes: whether a devserver window keeps the `transparent=1` flag through a reconnect (the retarget path) or re-reads it from the host at load; whether the control terminal, which is a `control` kind on a devserver tenant, reads the flag from its URL or from the host.

## Acceptance

1. Unit: the build rule marks every window kind transparent; the connecting URL and the retarget target carry the flag; the host command answers the desktop's value and the event fires on a change of the desktop's `server.toml`; the page paints with the host's value over a tenant preference of 100, and the slider's write reaches the host.
2. By eye on macOS and by pixel in the Linux rig: in a workspace window a terminal tab is see-through at 80 while an editor pane beside it, the tab strips, the dock, the panels and the status bar read the same pixels as at 100; a devserver window's terminal is see-through at the desktop's 80 while the devserver's own key reads 100, and follows the desktop's slider live; a control terminal is see-through; a browser tab of the same devserver is opaque; at 100 a capture of every window kind equals a capture of the v0.116.0 build, so the native flag alone changes nothing visible.
3. `make web-check`, clippy with warnings denied for chan-desktop, and the browser checks that touch terminal appearance (105) green.
