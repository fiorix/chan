# chan-desktop toggles the launcher inside every window

Status: raised for v0.111.0 on 2026-10-25; built, awaiting review.

## What was seen

At v0.110.0 (`3c9594ca5`) chan-desktop builds its launcher as a window of its own, apart from the windows the user works in. The need: the launcher is the inventory and on/off control for every machine, workspace and window, and it is reached by switching to a second OS window with its own place on screen, where it belongs in the window in use, one chord away.

Read at `3c9594ca5`; paths under `desktop/src-tauri/` unless named.

- `src/main.rs` builds one launcher window at boot: Tauri label `main`, title "Chan Desktop" (`LAUNCHER_WINDOW_TITLE`), 420 by 720 points by default with a 420 by 420 minimum, its size and position restored from the geometry LRU and recorded by `capture_launcher_geometry` in the `RunEvent::ExitRequested` and `RunEvent::Exit` arms.
- Its close button hides it. `show_window(app, "main")` brings it back from Window > Computers (`win-main`, in the macOS menubar and in the launcher's own bar off macOS), from a macOS Dock click with no visible window (`RunEvent::Reopen`), from an update ready to install (`notify_desktop_update_ready`), from a control terminal's close and the last SPA window's close (`close_window_with_page`), from a devserver's Abandon (`abandon_devserver_for_window`), and from New Window with nothing to copy (`open_new_window_for_label`, `mint_another_devserver_window`).
- The hidden launcher is a live window, so closing the last workspace or terminal window leaves the process running: Tauri requests an exit only when the last window is destroyed.
- The four launcher capabilities (`capabilities/default.json`, `launcher-control.json`, `launcher-events.json`, `launcher-update.json`) target `main` and `main-*`; the launcher's injected bridge (`src/launcher_reload_bridge.js`) claims the reload chord alone.

## Desired contract

There is no launcher window. Every window that shows the SPA (`local::<window_id>`, `lib-<hex>::<window_id>`, `control-terminal-<devserver id>`) toggles the launcher over its whole content area and keeps its own title bar. The launcher is a second webview inside the same native window, built with wry directly and outside Tauri's webview registry, so the window stays a single-webview Tauri window: on macOS a subview of the window's content view over the window's own webview, on Windows a child of the window over it, and on Linux it takes the window webview's place in the window's GTK box, on X11 and Wayland alike. It loads the embedded loopback launcher and, on macOS and Windows, is sized to the window's content area in logical points and re-fitted when the window resizes or changes scale. It is built on the first toggle, hidden on toggle-off so the next show is instant, and dropped with its window; a control terminal hidden in place drops its launcher. It takes focus when it shows and hands it back to the window's own webview when it hides. No launcher geometry is persisted. Tauri's own multi-webview windows are not used: they need Tauri's `unstable` feature, which changes the webview kind of every window and stops a window holding two webviews from resolving as a `WebviewWindow`.

- The toggle is View > Toggle Launcher: Cmd+P in the one macOS menubar, routed by the focused window (an SPA window toggles its launcher, the About window or nothing focused opens a standalone terminal). Ctrl+Shift+P toggles on every platform, from the window's key bridge through the `toggle_launcher_panel` Tauri command and from the launcher's own bridge, which hides it. Off macOS a window wears the launcher menubar (File, Edit, View > Toggle Launcher on Ctrl+Shift+P, Window) only while its launcher shows and is menu-less otherwise. Plain Ctrl+P stays a shell chord.
- While a window's launcher shows, File > Close Window hides the launcher instead of acting on the page behind it, and on macOS File > New Terminal in a workspace or devserver window hides the launcher as it toggles the terminal, so the terminal opens in sight.
- The toggle animates each page in its own webview: the window's panes gather toward the center, the launcher shows and fades up; the launcher fades down and hides, and the panes deal back out. `prefers-reduced-motion: reduce` drops the motion while the stage delays still run.
- Boot always yields one window: when no persisted native local window record that is shown is served once the on workspaces were re-served and the first-open rule ran, it opens one standalone terminal.
- Closing the last native window exits chan on every platform with the clean shutdown; buried windows restore hidden at the next boot. On macOS a Dock click or `open -a` with no visible window opens a standalone terminal.
- An update ready to install shows the launcher on the focused window, else the first visible one, and then broadcasts `desktop-update-ready`, which reaches every launcher. The gateway migration notice (`launcher-notice`) fires once, at the first launcher page load.
- New Window with nothing to copy opens a standalone terminal. `cs window` addresses Tauri windows only, and the launcher is not one.
- The launcher webview has no Tauri IPC. `src/launcher_ipc.js` gives it `__TAURI__.core.invoke` and `__TAURI__.event.listen` over wry's message channel. The desktop accepts a message only from the launcher's loopback origin, answers exactly `request_app_quit`, `restart_desktop_after_update`, `reload_window` and `toggle_launcher_panel` (`LauncherCommand`), and forwards exactly the six events the launcher listens to (`FORWARDED_EVENTS`). Navigation off the loopback origin and new-window requests open http(s) links in the system browser. DevTools are enabled on the launcher webview.
- No Tauri capability names the launcher: the four launcher capabilities and the `main-window` permission set are deleted, and `restart_desktop_after_update` is not a Tauri command. `toggle_launcher_panel` stays a Tauri command for the window key bridge, granted by `allow-toggle-launcher-panel` in the `workspace-window` and `gateway-window` sets.
- Gateway session cookies install on the preferred window, else any window.

## Boundaries

Changed: `src/launcher_panel.rs`, `src/launcher_ipc.js` and `src/launcher_transition.js` (new), `src/launcher_bridge.js` (the launcher's bridge, in place of `launcher_reload_bridge.js`), `src/key_bridge.js`, `src/main.rs`, `src/serve.rs`, `src/window_ops.rs`, `src/devserver.rs`, `src/runtime_capability.rs`, `permissions/app.toml`, `Cargo.toml` (`wry`, and `gtk` on Linux) with the workspace `Cargo.lock`, the four launcher capabilities (deleted), comments and the bridge layout test in `web/packages/workspace-app`, and the design documents. Not changed: the launcher SPA in `web/packages/launcher`, the launcher served in a browser at a devserver or gateway root, the library's first-open rule, the window watcher's records, and workspace window geometry.

## Acceptance

1. A launch with nothing to restore shows one standalone terminal and no launcher window.
2. On macOS, Cmd+P in a workspace window, a standalone terminal and a devserver control terminal shows the launcher over the window's content, under the window's own title bar, with the gather transition, and Cmd+P again hides it with focus back on the window's page; with the About window focused it opens a standalone terminal.
3. On every platform, Ctrl+Shift+P in an SPA window shows its launcher and Ctrl+Shift+P in the launcher hides it. On Linux and Windows the window wears the launcher menubar, with View > Toggle Launcher, only while its launcher shows, and plain Ctrl+P reaches a focused shell.
4. Resizing a window or changing its scale re-fits its shown launcher, and on Linux the launcher shows in place of the window's webview on X11 and on Wayland. Closing the window, or hiding a control terminal in place, drops its launcher.
5. Closing the last window exits the process on macOS, Linux and Windows; its hidden windows restore hidden at the next launch.
6. On macOS a Dock click with no visible window opens a standalone terminal.
7. An update ready to install shows the launcher, with its update dialog, on the focused window.
8. With a window's launcher showing, File > Close Window hides the launcher and leaves the window open.
9. With reduced motion requested, neither page animates.
10. The desktop tests pin the label routing, the content rect in points, the stage budgets against the transition script, the `.pane` and `#app` selectors against the two SPAs' sources, the launcher bridge's chords, the launcher IPC's commands against the launcher's invokes, the forwarded events against its subscriptions, and that the launcher is built with wry inside its window, never through a Tauri window builder.
