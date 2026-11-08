# chan-desktop design

chan-desktop is the desktop edition of chan, a supercharged terminal emulator. It is a Tauri shell: it puts chan's windows on the desktop, embeds the server for local work, reaches devservers over a TCP tunnel or through a self-hosted gateway, and is the `chan` and `cs` command line at the same time. This document says what the shell is, where it sits, which flows run through it, and why it is built the way it is. The product framing is in [../design.md](../design.md); the launcher page it shows is designed in [../web/packages/launcher/design.md](../web/packages/launcher/design.md); the gateway side is in [../gateway/design.md](../gateway/design.md).

## Purpose and non-goals

The desktop exists for three reasons:

- One signed bundle gives a user native windows, an app icon, OS file dialogs and the system clipboard, with no terminal to start a server from and nothing else to download.
- One process supervises every local workspace, every standalone terminal and every connected devserver at once, so their windows sit side by side in the OS window switcher and share one launcher.
- A desktop install is also the CLI. Invoked as `chan` or `cs`, the same binary runs the command line before any GUI code, so `chan serve`, `cs` and the shell-first workflows come with the app.

Non-goals:

- It is not a second frontend. Every window shows the workspace app that chan-server serves; the desktop adds native windows, menus, dialogs, transfers and trust around that page.
- It is not a browser. A window loads the embedded server, a configured devserver, or a gateway origin the desktop has authenticated. There is no "open this URL" mode, and the desktop never attaches to an arbitrary `chan serve`.
- It bundles no runtime: no Node.js, no sidecar server, no separate `chan` binary on macOS or Linux. The Windows installer carries a console `chan.exe` only because a GUI-subsystem executable cannot be a usable shell command there.

## Mental model

```mermaid
flowchart TD
    User["User"] --> Launcher
    subgraph Desktop["chan-desktop (one supervisor process)"]
        Launcher["Launcher webview inside every window (inventory, on/off, connect)"]
        Host["WorkspaceHost (embedded chan-server)"]
        Listener["One 127.0.0.1 listener (HTTP + WS)"]
        Launcher -->|"toggle On"| Host
        Host --> Listener
    end
    Listener --> T["Tenant /terminal (standalone terminals)"]
    Listener --> WS1["Tenant /workspace-hash (watcher, index, terminals, token)"]
    Listener --> WS2["Tenant /workspace-hash (another workspace)"]
    T -->|"tokened URL, kind=terminal"| View0["Tauri webview window"]
    WS1 -->|"http://127.0.0.1:PORT/workspace-hash/?t=TOKEN"| View1["Tauri webview window"]
    WS2 -->|"tokened URL"| View2["Tauri webview window"]
```

*One supervisor embeds a WorkspaceHost, serves every local tenant on a single loopback listener under a path prefix, and opens each window as a Tauri webview on a tokened URL.*

One desktop process embeds a `WorkspaceHost` (owned by chan-library, re-exported by chan-server), which owns the single `chan_workspace::Library`. The host binds one loopback listener for the whole process, preferring the port saved in the desktop config so origin-keyed browser storage survives a restart. Each local workspace is a tenant under a prefix hashed from its root, with its own watcher, index, terminal registry, MCP bridge, control socket and bearer token. A shared `/terminal` tenant hosts standalone terminals. The launcher is served at the root of the same listener behind a per-launch launcher token. Every window is a Tauri webview opened on a URL that carries its tenant's token.

There are three attachment modes, and every window belongs to exactly one:

- **Local embedded**: a registry row the desktop mounts into its own host. The desktop owns the runtime.
- **Devserver**: a headless `chan devserver` the desktop dials by address, usually over an `ssh -L` forward. The devserver owns the runtimes, the tokens and the window records; the desktop persists only the connection recipe and owns the native windows.
- **Gateway roster**: an account-level gateway sign-in whose devserver roster the desktop projects into the launcher. Each rostered devserver is reached at an exact proxy origin the gateway names.

The dependency direction is one way. The desktop links chan-server (and through it chan-library and chan-workspace), the `chan` CLI crate as a library, `chan-shell` for the `cs` client and `chan-revtunnel` for the tunnel client; the two web bundles are rust-embed inputs. Nothing depends on the desktop, and it adds no API to the server: what it adds is native, reached by the page through Tauri commands.

## The CLI personality

The binary decides what it is from its invoked name before any GUI or runtime setup. `chan_shell::invoked_arg0` prefers `$ARGV0` over `argv[0]`, because wrappers rewrite the latter. A `cs` name runs the control client and exits; a `chan` name runs the whole CLI in-process with `Personality::Desktop` and exits. That personality changes two verbs: `chan upgrade` upgrades the desktop install rather than a CLI archive, and `chan serve` hands a workspace to a running desktop.

On boot the desktop owns `~/.local/bin/{chan,cs}`, with the shim shape following the package kind. A macOS `.app` or a Linux deb or rpm gets real symlinks to the installed binary. A Linux AppImage gets small `exec -a` wrapper scripts, because `current_exe()` inside an AppImage is the ephemeral mount path; the wrapper also records the caller's working directory, which the AppImage's own `AppRun` loses, so `chan serve .` resolves against the invoking shell. Windows writes `.cmd` wrappers and Git Bash shims under `%LOCALAPPDATA%\chan\bin` that run the bundled console `chan.exe` with `CHAN_DESKTOP_HANDOFF=1`, the marker that routes its `chan upgrade` to the desktop. Installation is best-effort and idempotent: a shim the desktop wrote is repaired when it goes stale, and a `chan` or `cs` the user installed themselves is never replaced. The module is `src-tauri/src/cs_install.rs`.

On Windows the desktop also appends `%LOCALAPPDATA%\chan\bin` to the user `Path`, keeping a trailing `;` after it when the value had one, and records the entry, the value's type and whether it created the value under the installer's key `HKCU\Software\chan\Chan`. The NSIS uninstaller undoes what the install and the desktop made that points at the install (`src-tauri/windows/installer-hooks.nsh`): every uninstall except the self-updater's `/UPDATE` run deletes the four shims that carry the desktop's marker, then `%LOCALAPPDATA%\chan\bin` and `%LOCALAPPDATA%\chan` when they are empty, drops every user `Path` entry that names the shim directory and joins the others back byte for byte, which gives back the value the desktop found, deletes a value that removal empties unless the record says it existed before, and deletes the installer's key. The user's state stays unless the user asks for it to go: a silent uninstall keeps `~\.chan` and the webview data under `app.chan.desktop`, and the uninstaller's "Delete the application data" choice removes both; `/PURGE` makes that choice for a scripted uninstall (`uninstall.exe /S /PURGE`), and since the template reads its passive switch `/P` as a prefix, it also skips the confirm page. That choice removes `%USERPROFILE%\.chan` and does not follow a `CHAN_HOME` set elsewhere, and neither path touches the gateway tokens the desktop keeps in Windows Credential Manager.

## The handoff socket

The desktop binds a well-known per-user endpoint at boot, a Unix socket or a Windows named pipe, and answers the CLI over it; a bind failure is not fatal, the CLI then serves on its own. The requests are the reasons a terminal needs a running desktop:

- `chan serve PATH` opens the workspace in the desktop instead of racing it for the writer lock, and `chan workspace forget` closes and unregisters it there.
- `chan upgrade` asks the desktop to drive its own updater.
- The `chan devserver` verbs list, connect, disconnect and forget the desktop's devserver rows, and open a window on one.
- `chan workspace serve|close|forget WS --on TARGET` act on a connected devserver's workspaces. `remote_workspace.rs` resolves `TARGET` to one registered row and `WS` to one of its workspaces, refusing over guessing, and a registered but disconnected row is refused with a pointer at `chan devserver connect`. Every remote operation rides the connection the desktop already holds, because dialing on the CLI's behalf would have to guess at the sign-in and trust prompts the launcher owns.
- A plain default-terminal launch is handed over so the running desktop opens the terminal.

The protocol and the listener live in chan-server's `handoff` module; the desktop supplies the handlers.

## Local workspace lifecycle

```mermaid
stateDiagram-v2
    [*] --> Off : CLI chan workspace add registers, On=off
    [*] --> Serving : Desktop New add registers + auto-start

    Off : Registered, Off
    Serving : Serving, mounted in WorkspaceHost

    Off --> Serving : Toggle On
    Serving --> Off : Toggle Off, unmount + destroy windows
    Serving --> Serving : Open, mint another window

    Off --> [*] : Forget, unregister, fs untouched
    Serving --> [*] : Forget, stop + unregister, fs untouched

    note right of Serving
        Isolated watcher, index, terminal registry,
        MCP bridge, control socket, token.
        The window watcher opens its windows.
    end note
```

*A desktop New auto-starts, a terminal `chan workspace add` only registers; On mounts an isolated runtime, Off unmounts and destroys the windows, Forget unregisters and leaves the filesystem alone.*

The chan registry at `~/.chan/config.toml` is the only source of truth for which workspaces exist. Every desktop-driven mutation runs in-process against the host's shared `Library`, on the same code path the CLI uses; routing everything through the one `Library` is what makes a freshly added workspace openable at once. A filesystem watcher over `~/.chan/` reloads the library and wakes the launcher feed when the registry file itself changes, filtered to that one file because `preferences.toml` churn from pane drags must not storm the launcher. A `chan workspace add` typed in a terminal therefore appears in the launcher without a refresh.

The desktop keeps a small config of its own at `~/.chan/desktop/config.json`, under the same chan home rather than an OS app-data directory. It holds only desktop state: connection recipes for devservers and gateways, native-trust records for shared gateway devservers, window geometry, the preferred loopback port and the launcher's appearance. It carries devserver bearer tokens, so it is written atomically with owner-only permissions. Per-workspace serve URLs are deliberately not persisted, because tokens rotate and a saved URL would decay.

The On column is read live from the host. The on set persists to the `workspaces.json` overlay the host shares with the devserver, so a restart re-serves what the user left running; a workspace that fails to re-serve surfaces a notice and is left off. Boot mounts the shared `/terminal` tenant, re-serves that set, and always ends with a window and never with a launcher on its own: a fresh library mints one standalone terminal and persists a first-open marker, after which an emptied library is never re-seeded, and a boot that opened nothing opens one standalone terminal. A workspace is opt-in; there is no default workspace and nothing is created on the user's behalf.

The New dialog has three forms, a local directory, a devserver and a gateway, each preselected by its entry point. Adding a local directory registers, starts and opens it through the library's add route, with no desktop-side pre-flight scan: the workspace app owns first-boot readiness through its own overlay, and a second dialog would race it. Auto-start on add is specific to the desktop, where the user's intent is "make this usable now"; `chan workspace add` from a terminal only registers.

Toggle On mounts the workspace through the host with chan-server's bearer gate kept on. A workspace held by another chan process surfaces as an "open in another chan process" message and the toggle reverts. Toggle Off unmounts and destroys the workspace's windows. Forget stops the workspace if it runs, unregisters it in-process and purges its window records; the filesystem is untouched, and there is no delete action in the desktop. Validation is deferred to chan-workspace wherever it already owns a contract, so anything the desktop accepts is accepted by every other chan surface.

## The launcher

The launcher is shown inside a window, never in a window of its own. Every window that hosts the workspace app can toggle it over its whole content area while keeping its own title bar. It is a second webview in the same native window, built with wry directly rather than through Tauri: on macOS a subview laid over the window's own webview, on Windows a child of the window, and on the GTK desktops (Linux and FreeBSD) a GTK overlay holding both webviews. It is built outside Tauri because Tauri's multi-webview windows need its `unstable` feature, which changes the webview kind of every window and stops a window with two webviews from resolving as a `WebviewWindow`. It loads the embedded loopback launcher with the launcher token. While it shows it owns the window's keyboard: the host page carries `data-launcher-shown` on its root and its terminal skips every refocus while the mark is set, and the desktop gives the launcher the keyboard again when the window regains focus and when the host page finishes a load, because a focus change in the host page (a reload that lost the mark, a tab opened from `cs`) makes the host's webview the first responder and would otherwise leave the launcher deaf until the next toggle. The module is `src-tauri/src/launcher_panel.rs`.

The toggle is View > Toggle Launcher: Cmd+P on macOS, where one global menubar routes it by the focused window, and Ctrl+Shift+P elsewhere, where a window wears a menubar only while its launcher shows and the key bridge carries the chord the rest of the time; plain Ctrl+P stays with a focused shell. The toggle is a horizontal carousel driven by `launcher_transition.js`: the host page slides right as the Computers page enters from the left, each webview animating its own page from a shared start time so the two move as one; reduced motion switches without the slide.

The launcher webview has no Tauri IPC and no Tauri capability. `launcher_ipc.js` gives the page the `invoke` and `listen` calls it makes, over wry's message channel. The desktop accepts a message only from the launcher's loopback origin, answers a fixed list of commands (quit, restart after an update, reload, toggle, zoom, and where the window wears no menubar the menubar items behind its chords), and forwards a fixed list of app events into every launcher; tests pin both lists against the launcher's source. A navigation off the loopback origin opens in the system browser instead.

What the launcher shows is the Computers screen, a deck of machine cards (this machine, each devserver, the gateway-rostered devservers, add a devserver), and the Gateways screen; its routes, decks and authority model are in the [launcher design](../web/packages/launcher/design.md).

## Window model

### Window kinds

Every window is a Tauri webview whose label prefix encodes its kind, and Tauri capabilities are granted by label glob:

- `local::<window_id>`: watcher-opened local workspace and standalone-terminal windows, labeled by the library's window record.
- `lib-<hex>::<window_id>`: watcher-opened devserver windows, the same composite label scheme with the page served by the remote devserver.
- `control-terminal-<devserver id>`: the terminal-only window that runs a devserver's connect script.
- `terminal-exec`: the one window of a default-terminal launch, in a process of its own.
- `about`: the bundled About window, a singleton the macOS system About item is redirected to.

The launcher is not a window kind: it has no label, no window record and no capability.

The desktop is a view of the library. Each connected library, the embedded one and every devserver, has a window watcher that reconciles the library's window records with the native surface: missing windows open, removed windows close, and hidden records and pending changes stay suppressed. The local feed is in-process from the host; a devserver's is its window list plus its watch socket; both drive the same reconcile. Every window-creation path mints a record first, so the watcher is the sole driver of native windows and a reconnect or relaunch cannot duplicate them. Windows are keyed by the record's id, so panes and tabs rehydrate per record, and titles follow the library's ordinal so the OS switcher and `cs window list` agree.

### Menus and the key bridge

Workspace windows get a native key bridge injected before any page script. It translates VS Code-style chords into the `chan:command` window event the page listens for, claiming each chord in the capture phase so the page's keymap cannot drift out from under it. Chords whose actions are reachable through the page's command deck stay page-owned; direct chords exist where a deck is no substitute, such as tab navigation, find, search and splits. Reload, DevTools and zoom invoke Tauri commands directly rather than going through the page's event bus, so a frozen page cannot lock the developer affordances away. Off macOS the bindings avoid terminal chords, and a focused terminal keeps the chords a shell needs.

The native menus route by the focused window's kind: New Terminal, Close Window, New Window and Open in Browser each ask the focused window's page or library, and fall back to a standalone terminal window from anywhere else; the Window menu lists hidden windows for restoring. A tmux window answers New Terminal and New Window by asking tmux, and the window tmux adds opens as a chan window through the watcher.

Quitting prompts once, because every terminal the process holds dies with it. Closing the last native window exits on every platform, and because that exit ends the hidden windows' shells too, the last shown window guard (`last_window.rs`) refuses to hide the last shown window while any terminal session of the library is alive, and refuses to close it while sessions other than its own are alive; the refusal says to show or open another window first.

### Close, hide and restore

```mermaid
stateDiagram-v2
    [*] --> Live: watcher opens library record
    Live: Live SPA window, terminals and layout warm
    Buried: Hidden window, record kept
    Destroyed: Destroyed, gone

    Live --> CloseGate: OS close button
    state CloseGate <<choice>>
    CloseGate --> Prompt: live SPA window
    CloseGate --> Buried: devserver window on its connecting screen
    CloseGate --> Destroyed: connecting control terminal
    Prompt: Hide / Close / Cancel overlay
    Prompt --> Buried: Hide, persist hidden
    Prompt --> Destroyed: Close
    Prompt --> Live: Cancel
    Live --> Destroyed: programmatic close cascade

    Buried --> Live: show from the Window menu or the launcher
    Buried --> [*]: app quit, records survive restart
    Destroyed --> [*]
```

*The OS close button on a live window asks Hide, Close or Cancel; Hide keeps the record and its server-side terminals, Close discards them; a devserver window still connecting hides without a prompt, a connecting control terminal closes outright, and the next open restores a hidden record.*

Hide keeps the window's library record and its server-side terminals and layout; the native window is destroyed and rebuilt at its stable id when shown again, so the page rehydrates its panes and tabs. A tmux window's prompt adds Detach, which ends the tmux connection and leaves tmux running. A connected control terminal hides in place so its live endpoint stays warm. Programmatic closes, the page's empty-window cascade and a workspace turned off, destroy outright.

Hidden-and-rebuilt windows need the desktop to remember their OS geometry, so it records a window's rectangle on every hide and reapplies it on rebuild, keyed by label under a monitor-signature LRU in its config. Geometry is handled in logical points, because on macOS a hidden window has no screen and a physical-pixel size would be converted through the wrong display's scale; points are the only unit that round-trips across mixed-DPI monitors.

### Tabs in the title bar

On macOS and Windows a window's page can draw its tab bar in the window's title bar (`src-tauri/src/titlebar_tabs.rs`). Whether pages do is the desktop's own preference, the `titlebar_tabs` field of its `config.json`, off by default and written from Settings, Global, Title bar tabs; like the terminal background opacity it covers every window the desktop builds, whatever tenant the window shows. `titlebar_tabs_preference` reads it, `set_titlebar_tabs_preference` stores it and emits `titlebar-tabs-preference` with `{ on }` to every window, and each window switches when it hears, without a reload.

The page decides and the desktop never turns the mode on for it: a page that wants the bar calls `set_titlebar_tabs` with the bar's height in CSS px. The answer, a `TitlebarChrome`, says in the page's CSS px how much room the window controls take at each end of the bar and where the traffic lights' vertical centre is, whether the page draws the window controls itself (`drawControls`), and whether the window is maximized (`maximized`); the page asks again with `titlebar_chrome` on every resize, which a fullscreen transition, a maximize, a restore and a zoom change all cause. On the GTK desktops both commands answer an inactive chrome and change nothing.

On macOS the title bar turns transparent over a full-size content view and hides its title, and the traffic lights stay where AppKit puts them; the chrome gives their room at the left and their vertical centre, converted from points through WebKit's page zoom, and in fullscreen both lengths are zero. The switch is made with AppKit calls rather than Tauri's `set_title_bar_style`: in tauri-runtime-wry that call's `Visible` arm leaves the full-size content view on, so it cannot give the normal title bar back, and every style mask change tao makes ends by making tao's own view the first responder, a view that is no longer in the window once wry installs the webview's parent as the content view. Setting the style mask directly keeps the keyboard with the page.

On Windows the window turns frameless and the page draws the window controls. The chrome's right inset is three caption buttons of 46 DIP, the width Windows 11 draws its own, converted through WebView2's zoom factor; the page fills it with minimize, maximize or restore (by `maximized`) and close at the bar's full height; the chrome's controls centre is half of a 32 DIP band, the height Windows 11 gives its caption buttons and title bar, so the bar is that tall at 100% and no taller than its own tab row when the page is zoomed in, and calls `titlebar_window_control` with `minimize`, `toggleMaximize` or `close`. The page draws the three in a fixed layer of their own over the bar's right inset, above every full-window overlay it shows, so an open overlay never hides a window's controls, and while they are drawn a full-height overlay panel starts below the band. `close` is a close request, the one the native close button and Alt+F4 make, so the Hide, Close and Cancel prompt and the rest of the close handling run as they do for those. tao keeps a frameless window's caption, sizing, minimize and maximize styles and only answers `WM_NCCALCSIZE` itself, so snapping and the minimize and maximize animations stay. With the undecorated shadow the client area keeps the resize frame at the left, right and bottom edges and one DIP at the top on Windows 11, where DWM goes on drawing the shadow, the border and the rounded corners, and tauri-runtime-wry lays a child window along the top edge for resizing there, since the webview covers it. A maximized frameless window fills its monitor's work area and leaves the taskbar in view. The style change keeps the window's frame where it is, so the content grows into the band the title bar held and gives it back when the mode ends. In fullscreen the page draws no controls and both insets are zero. The page's maximize button does not open the Windows 11 Snap Layouts flyout, which needs a native hit test answering `HTMAXBUTTON` over the button. While the window's Computers launcher shows, a window in the mode has no menubar (see below), so the chrome lists the launcher menubar's File, Edit and View by id and title (`menus`, empty everywhere else), the page draws them as menu buttons at the bar's left with the window's title after them, and a press calls `titlebar_menu_popup` with the menu's id and the point under the button's bottom-left corner, in CSS px. The desktop builds that menu with the menubar's own builder (`launcher_submenu` in `main.rs`), converts the point through WebView2's zoom factor, gives the launcher back the keyboard the press took into the page's webview, and pops the submenu up over the window with `popup_menu_at`. muda's `TrackPopupMenu` returns once the menu has closed, so the command answers then and the page holds the button pressed until it does; muda then sends the chosen item's event as a menubar click does, and tauri hands every menu event to the one app-wide listener, so each item runs what it runs from the menubar. The launcher holds the keyboard there, so no window reports the focus: the popup names its window for the menu event that follows it, and the key bridge's chords name theirs, so Close Window and Toggle Launcher act on that window, where from a menubar they act on the focused one. The Window menu is not drawn, since the Computers screen lists the windows. Inside a menu the keyboard is the native menu's; moving the pointer to a neighbouring button while a menu is open does not switch menus, and Alt and F10 do not reach them.

A window in the mode has a record keyed by its label, dropped when the window is destroyed. A page load from another origin than the page that turned the mode on gives the window its normal title bar back before the new page lays out, so a page that does not know this contract, such as the connecting screen, is never drawn under the window controls; a reload of the same origin keeps the mode, so the bar does not flash away and back, and a page of that origin that has not asked for the mode again three seconds after its load finished, which the workspace app always does as it boots, gets the normal title bar back then, so an API answer or an error page served from the same origin is not left under the window controls. While a window holds the mode, the hide-time geometry capture stores the content height a normal title bar would leave, so the window keeps its size across hide and restore: macOS records the normal title bar's height when the mode turns on, and Windows measures the window's top frame against the one `AdjustWindowRectExForDpi` gives a decorated window at the window's DPI, which also holds for a maximized window. The launcher panel sits below the band. While the window's launcher shows, the page hides its tab bar's contents (it reads the `data-launcher-shown` mark); every change of the launcher's visible set calls `titlebar_tabs::launcher_visibility_changed`, which on macOS sets AppKit's title visibility, so the title bar shows the window's title in AppKit's own place and look and follows every retitle. On Windows the frameless window has no title to show, so the desktop sends the page its title as the `titlebar-window-title` event, to that window only, when the launcher shows and on every retitle while it does (`titlebar_tabs::title_changed`, called by the window watcher's retitle), and the page draws it in the band. On Windows a window in the mode wears no launcher menubar: tao's frameless client area covers the whole frame and leaves a menubar no room to show, so the page's bar with the window controls and the menubar's menus stays in view above the launcher, and the launcher's key bridge, which carries the toggle, reload and zoom everywhere, there also carries the three chords only the menubar serves on the Computers screen: Ctrl+Shift+T (New Standalone Terminal), Ctrl+Alt+W (Close Window, which hides the launcher) and Ctrl+Q (Quit). The desktop sets `__chanLauncherMenuChords` in the launcher page on every menubar decision and after every launcher page load, the bridge claims the chords only while it is set and invokes the item each names by its menu id, and the desktop runs the item with the menubar's handler (`run_menu_item`) only for a window that wears no menubar, so a chord never runs twice and nothing changes where a menubar is attached. The bar's empty stretch carries `data-tauri-drag-region`, so a press there drags the window and a double-click zooms or maximizes it; Tauri's drag script invokes `start_dragging` and `internal_toggle_maximize`, which both the workspace capability and the exact-origin capability grant. The six app commands are in both the workspace-window and gateway-window permission sets and in `GATEWAY_WINDOW_COMMANDS`, so a gateway-served page advertises and reaches them too; a page treats Windows as supported only when the desktop advertises both `set_titlebar_tabs` and `titlebar_window_control`, so an older desktop never turns a window frameless without a way to drive it.

### The connecting screen

A devserver window does not load its remote URL directly: a down remote would paint a blank webview, since WKWebView never finishes the navigation. It loads a bundled local connecting page instead, which shows the attempt log, probes the remote through the `probe_url` command, and on success navigates the same window to the fully assembled tenant URL. Rust owns the probe because the local page's CSP blocks cross-origin fetches, and it sends the target origin's webview cookies so the probe can tell a registered gateway devserver that is not answering from a live one. For a failed probe, the fabric checks a mapped host name first, then a literal or OS-resolved address inside a running tunnel's AllowedIPs; the attempt row names that tunnel's state and missing-handshake reason, and the give-up summary ends with the last reason. Reload of a devserver window asks its watcher to retarget the existing native window the same way: a ready target navigates in place, a not-ready one keeps the current page and the watcher retries.

### Standalone terminal windows

Standalone terminal windows host the workspace app in terminal-only mode (`kind=terminal`): no workspace, terminal panes only. All of them load the one shared `/terminal` tenant, mounted on first use and never torn down per window, so PTYs live in one registry, a terminal tab moved between windows keeps its PTY, and orphans idle-prune. Sessions inherit chan-server's whole terminal contract, including the `cs` control socket, so `cs` works in a desktop terminal exactly as under `chan serve`.

Terminal background opacity is the desktop's own setting, the `terminal.background_opacity` key of the desktop's `server.toml`, and reaches every terminal tab of every window the desktop builds, whatever tenant the window shows. A window's transparency cannot change after it is built, so every window is built transparent and its URL says so; the page paints the tint and cuts a see-through hole only behind panes that show a terminal, so frames, tab strips and overlays stay as they are, and at full opacity every window reads as opaque. On macOS the title bar keeps an opaque layer of its own, because a transparent window would otherwise clear it.

Because every window is transparent, a webview that presents no frame shows the desktop below its title bar instead of a grey window. WebKit hides a webview's content until its web process commits a frame: the drawing area proxy's `hideContentUntilPendingUpdate` detaches the root layer and asks the web process for a drawing, and `RemoteLayerTreeDrawingAreaProxy::commitLayerTree` attaches the root layer again on the first main-frame layer tree commit that carries the answer (`Source/WebKit/UIProcess/RemoteLayerTree/RemoteLayerTreeDrawingAreaProxy.mm`). The web process sends the answer with the commit of its next rendering update (`RemoteLayerTreeDrawingArea::dispatchAfterEnsuringDrawing` in `Source/WebKit/WebProcess/WebPage/RemoteLayerTree/RemoteLayerTreeDrawingArea.mm`), and every rendering update that runs commits; a geometry change reaches that commit through the same `triggerRenderingUpdate` a scheduled update does, so it has no stronger path. On macOS a web process WebKit suspended resumes when its window comes back into view: after a display wake, and when an occluded window turns visible, which a display sleep and a tiling window manager's workspace switch both produce. The desktop observes the display and system wakes on the workspace notification center and every chan window's `NSWindowDidChangeOcclusionStateNotification`, and one second after the latest wake or turn to visible (a turn to occluded asks for nothing) it evaluates `src-tauri/src/wake_repaint.js` in every webview of every shown window, the launcher panel included. The script inserts an invisible, inert one-pixel fixed element and removes it two animation frames later, which schedules a rendering update and so a commit; nothing changes size, neither a window or webview frame nor a page box, so no terminal grid moves and no PTY is resized. No page reloads, since a reload drops the page's state. The module is `src-tauri/src/wake_repaint.rs`; its schedule is platform-independent and tested on every host, the script is tested under the workspace app's vitest, and the observers are macOS only.

### The default-terminal launch

chan-desktop is a terminal emulator for the xdg-terminal-exec contract: `chan-desktop [--dir=PATH] [--app-id=ID] [--title=TITLE] [--hold] [-e CMD ARGS... | -- CMD ARGS...]`. Any terminal flag opens one `terminal-exec` window in its own process and skips the whole launcher boot (no shims, library stores, handoff listener, window watcher, gateways or update check), so a launch beside a running chan-desktop leaves it alone; the command's exit code, the held window, the app id and the fixed title belong to the launching process. The exception is a launch that only runs the user's shell, a bare `chan-desktop` or one with `--dir` alone: that is first offered to a running desktop over the handoff socket, which opens a throwaway terminal window there, never saved, and the launching process exits; `CHAN_NO_DESKTOP_HANDOFF` opts out. The shared desktop entry carries the `X-TerminalArg*` keys that map xdg-terminal-exec's options onto these flags.

## Devserver connections

A devserver row stores an address, an optional label, an optional connect script and an optional token. Connecting runs the script in a control terminal, a standalone terminal window whose PTY runs the script so an interactive ssh session can prompt the user there. The token comes from one of three places: a token stored on the row wins once the script is running, so a tunnel script can be just `ssh -N`; otherwise a scripted connect scrapes the `CHAN_DEVSERVER_TOKEN=` line the devserver's `join` prints into the control terminal; a local devserver with neither reads the live token and port from its own config under the chan home. The desktop then probes the devserver's info route, records the connection, opens a standalone terminal on the devserver, tucks the control terminal away, and from then on polls the devserver's workspace list for the launcher and follows its window feed for native windows.

```mermaid
sequenceDiagram
  participant L as Launcher (Connect)
  participant D as chan-desktop
  participant C as control terminal
  participant S as devserver
  L->>D: connect request over the library API
  D->>C: open a control terminal and run the connect script
  C->>S: ssh -L ... chan devserver join (or any script)
  S-->>C: CHAN_DEVSERVER_TOKEN=... on stdout
  D->>D: token: stored on the row, scraped from the control terminal, or read from the local config
  D->>S: info probe, then the workspace list (bearer)
  D->>S: window list, then the watch socket
  S-->>D: window records
  D->>D: open lib-* windows through the connecting page
  D->>C: tuck the control terminal away
```

*A devserver connect: the script brings the tunnel up in a control terminal, the desktop acquires a token, confirms the devserver answers, and mirrors its window records as native windows.*

Each devserver workspace is its own tokened tenant. The devserver returns each tenant's prefix and token and the desktop assembles the tenant URL itself against the address it dialed, which keeps the desktop in control of the local tunnel port and spares the devserver knowing how it is reached.

The control script is the connection. A script that exits cleanly right after connecting is a daemonizing connect and its control terminal is reaped; one that exits later ends the connection; one that exits without a healthy connection closes the devserver's windows and keeps the control terminal so the user can read why. The window feed reconnects on its own after a drop and keeps the last window set, so windows reopen without a second connect; a devserver whose feed delivers nothing for consecutive rounds is marked unreachable on its card. Disconnecting tears down the native windows and leaves everything on the devserver running.

Reverse port forwarding (`cs tunnel`) rides the same connection. The page forwards only the `tunnel_open` window command; `revtunnel.rs` resolves the devserver, its endpoint and its credentials from the invoking window's own connection record, never from the payload, binds the requested desktop port and reports back over the tunnel's control socket.

## Gateway sign-in and the roster

A gateway is connected at the account level, once per gateway. Connect discovers the gateway, signs in once, and polls the account's devserver roster; the rostered devservers surface as synthesized rows in the launcher and vanish when the gateway disconnects. Sign-in runs in the user's own browser, where passkeys and autofill work: the desktop binds a loopback callback listener in-process, opens the gateway's authorize page with a state nonce and a PKCE challenge, and the gateway hands the browser back to the callback with a one-time code, never the token. The desktop redeems the code for a personal access token, which it stores in the OS keyring.

A sign-in also enrolls the row's WireGuard key when the row holds one and the gateway's fresh discovery offers enrollment (its `wireguard` entry, below): the authorize request carries the public key as `wireguard_public_key`, and the redeem answers, beside the token, what the gateway enrolled it with: the gateway's key and endpoint, the client's tunnel addresses, the prefixes the tunnel carries, an optional keepalive and the host map. The gateway's key and endpoint must equal the discovery entry the sign-in started from. A redeem whose peer differs, one that answers a sent key without parameters, parameters a client file cannot hold, and a key generated again while the browser was open each fail the sign-in and store nothing, the token included. Otherwise the desktop writes `<id>.conf` beside the key from the key file and the parameters, names it as the row's file with the enrolled key and the host map in one config save, adopts it in the running fabric, retiring the row's previous tunnel first since the file is rewritten in place, and only then stores the token, so no token is stored without its peer's client file; a failed store leaves the enrolled file, which the next sign-in enrolls again. The gateway is reached through the new tunnel at once. A stored token enrolls nothing, so a Connect of a row whose key is not the one its gateway enrolled last signs in through the browser again, saying so, and a start-up connect, which opens no browser, parks the row with `the WireGuard key is not enrolled yet; click Connect to sign in`. A row holding a key against a gateway that offers no enrollment connects without it, and a Connect click says so. A gateway that cannot enroll the key fails the sign-in with the reason `wireguard_enroll_failed`, read as `sign-in failed: the gateway could not enroll the WireGuard key`.

The roster's failure semantics are deliberate. An upstream failure keeps the last known roster and retries, and the gateway reads as unreachable only after consecutive misses; a degraded all-offline roster is never synthesized, because dropping rows on a flaky upstream would close every gateway window. Only an authentication refusal, or a stored token that is gone, runs the disconnect cascade and clears the token.

Rostered rows are keyed by gateway, owner and full devserver id. An owned row may connect directly. A shared row renders a native-access warning and cannot connect until the user persists trust for that exact identity, because a gateway-served page will receive the desktop's native commands. The launcher orders the consent strictly, trust first, an authoritative re-list, then the connect, and the desktop enforces the same rule behind it: it refuses an absent or untrusted row before requesting an entry, serializes trust changes and connects per row, and rechecks a per-row policy generation before it registers the connection, so an in-flight connect cannot survive a removal, a revocation or a role downgrade. For an allowed row the desktop asks the gateway's entry endpoint for that owner and devserver, pins the exact proxy origin it names, and mints the runtime capability before the window watcher starts; a failure there is fatal to that row only.

### The WireGuard fabric

A gateway row may name a wg-quick file (`wireguard`, set and cleared through the Gateways form and read at add and update time through chan-wireguard's `config::read_file`, so a bad file is refused with the reader's message, which names the path, the line and the key and never a value). At start, before any HTTP client or webview exists, the desktop binds one loopback HTTP CONNECT proxy, whether or not any gateway carries a file, and adopts every enabled gateway with a file: its in-process WireGuard tunnel starts and is routed in the proxy with the row's host map, without waiting for endpoint resolution or a handshake. The fabric, the proxy and a live registry of tunnels keyed by gateway id, lives in `AppState` for the process. Every leg to a gateway goes through that proxy: the HTTP clients (the roster, the redeem, the devserver polls and probes, native transfers) take it as a reqwest proxy with loopback destinations left direct, so the embedded server and a devserver on this machine never depend on it; the window feed does a manual CONNECT to the proxy and runs its TLS and WebSocket handshakes over the opened stream; and every webview, the launcher's included, takes it as its proxy. The proxy routes by destination, a target inside a tunnel's AllowedIPs through that tunnel and anything else directly, which is what keeps the local windows working: on Linux WebKitGTK sends loopback through the proxy too, where the proxy forwards plain HTTP, so every local window on Linux reaches the embedded server through the proxy whether or not a gateway exists. A name in a row's host map, which an enrollment fills (an exact name, or `*.` and a suffix matching every name below it), is carried through that row's tunnel to its mapped address with no lookup on the host, so a gateway's names need no DNS on this machine.

The proxy's address is the one thing decided once per process, because the webview proxy is: WebView2 takes it as a browser argument shared by every webview of the process. The tunnels behind it are live. For a routed request whose tunnel has a known endpoint and no session, the proxy lets its SYN start a handshake and waits 3 s; if no session appears, it refuses 502 and logs the handshake state. A tunnel with a live session retains the 30 s connect bound until its protocol timers mark it lost. A file set or changed through the Gateways form on an enabled row is adopted as the row is saved: the tunnel starts and is routed in the running proxy, and a row's previous tunnel is dropped only after the new one carries the next connections, so the badge reads the live status within one refresh and nothing restarts. A save that leaves the path alone restarts nothing, so a file edited in place is re-read by clearing and setting the field. A cleared file, a removed row and a user disconnect retire the row's tunnel and end the connections through it, so a disabled row runs no tunnel; a connect adopts the row's file again, which is also how a file refused earlier and fixed in place, or a config edited by hand while the desktop runs, comes up without a save. An unreadable or invalid file or invalid tunnel configuration disables that gateway alone: the row carries the reason as its `last_error` and refuses to connect until an adopt finds the file good; the app itself runs. A proxy bind failure disables every WireGuard gateway with that reason, since none can be reached without it, and the app runs without a proxy. Endpoint lookups run on the fabric's runtime in the background, one per tunnel at a time, on every handshake attempt. A failed or timed-out lookup never disables a tunnel: one that knows its endpoint keeps handshaking with it, and one that does not retries the lookup. The proxy stays bound throughout. A request for a gateway whose endpoint is not known yet waits, within the proxy's 30 s bound, for the next lookup to end; when that lookup fails, or times out after 10 s, the request is refused with 502 and an empty body like every proxy refusal, and the reason is in the Gateways state and in the log, where the tunnel logs a lookup failure at warn when it starts or changes. A timed-out lookup's OS call must finish before another lookup starts, and until it does such a request is refused at once. While visible, the launcher refreshes gateways with WireGuard files every two seconds, so DNS and handshake changes appear without a registry event. On Windows WebView2 sends loopback directly, by Chromium's implicit bypass, so the local windows there never enter the proxy. On macOS the webview proxy is set on the webview's data store (tauri's `macos-proxy` feature), whose Network.framework symbols exist from macOS 14; that is the bundle's minimum system version, so every macOS the app opens on takes the proxy, and the local windows load whichever way WKWebView routes loopback, directly or through the proxy's forwarding.

The Gateways projection reads each live tunnel's `wireguard_status` on every refresh: `connecting` before its first session, `up` while a session works, and `lost; no handshake for <age>` after the last session expires. A lookup failure appears with a live or lost state and names retrying; a timed-out lookup whose OS call is still running names `stalled, waiting for the system resolver`. A discovery transport failure through a configured tunnel with no session names the configured peer endpoint and distinguishes a tunnel that never handshook from one that lost its session; the former points to the file's `PublicKey` and the peer's client-key list, without printing any key value. A first endpoint lookup that has not completed reads `connecting`, without claiming a key problem. A failed start-up discovery is stored on the gateway row even before a runtime exists, including for a plain gateway; a new connect, disconnect, row removal, or successful save that sets, changes, or clears its WireGuard file clears that pre-runtime error. HTTP, decode and validation failures keep their own messages.

A gateway whose discovery document carries a `wireguard` entry (the ingress endpoint and its interface's public key, read with the wg-quick file's own grammars) enrolls a WireGuard key of the desktop's own. Generating one is a desktop bridge op behind `POST /api/library/gateways/{id}/wireguard-key`: the desktop discovers the gateway, generates an X25519 pair from 32 bytes of the OS's randomness, keeps the private half in `<chan home>/desktop/wireguard/<id>.key` (the directory 0700 and the file 0600 on Unix, written through the config's atomic write) and stores the public half on the row, which the launcher shows. A gateway without the entry is refused with `this gateway does not enroll WireGuard peers`, and nothing is written. Generating again replaces the key, and the row reads as not enrolled until a sign-in enrolls the new one. The private key never leaves its file: not the config, a log, the projection or a request. The row's enrollment fields describe the client file an enrollment wrote: clearing the row's file drops its host map and enrolled key and keeps the key, another file drops the host map, and removing the row deletes the key file and the client file beside it.

## Exact-origin trust and native IPC

Tauri grants a capability by window label and, for remotely served content, by loading origin. Every window that shows the workspace app is remotely served, from the embedded server over loopback or from a devserver; the bundled connecting page and the About window are the only local app pages. Every static capability that declares a remote scope lists exactly the two loopback origins, so a gateway-served `lib-*` window holds a static grant only while it shows the local connecting page. No static capability names a wildcard host, and none names the launcher.

A gateway window gets its grant at runtime: after the entry response passes the identity, namespace, scheme, port and same-origin checks, the desktop mints one capability for that canonical exact origin with the gateway command set, the workspace set without the connecting page's probe, plus the gateway CSRF token and the native transfer commands. Runtime grants are additive and there is no removal, so revocation closes the managed windows and blocks reconnect at once, while purging an already-minted origin from the process needs a restart. The macOS drag-pasteboard read is the standing exception on every origin: the pasteboard is system-wide and outlives the drag, so only locally served `local::*` windows may read it, never a devserver-served page that could harvest paths dragged around in other applications.

## Clipboard, dialogs and transfers

The clipboard is read and written natively through arboard rather than the webview's clipboard API, which pops WKWebView's DOM-paste button with no opt-out. Text, PNG images and HTML are supported, which is what the terminal's right-click paste and `cs copy` and `cs paste` ride. Confirm dialogs on macOS are a native `NSAlert` run modally, because the plugin's dialog never becomes the key window and Return never reaches its default button; elsewhere the plugin path is kept.

File transfers keep bytes out of the webview. A download hands Rust a same-origin API URL; Rust revalidates it against the invoking window, reuses the window's cookies, refuses redirects, streams into a temporary file in Downloads and renames only after a complete response, while the page polls a bounded progress record. An upload keeps the native picker and the chosen paths in Rust and streams each regular file as a multipart part; the page sees only relative destinations and progress. Bytes the page generated itself, such as a rendered PDF, cross IPC in explicit chunks into the same commit discipline.

## The terminal renderer and GPU signals

The Linux AppImage bundles its own GTK, WebKitGTK and GL stack, built on the CI runner. On a host whose Mesa is newer than the bundle, the bundled GTK cannot create an EGL display and the webview aborts at creation; a host's GTK and Mesa are always built against each other, so no single bundled stack works everywhere. Inside an AppImage, before the webview exists, the desktop prefers the host stack when both GTK and WebKitGTK resolve in the host's `ldconfig` cache: it prepends the host library directory to the loader path and re-executes itself once, because the libraries are already loaded by the time `main` runs. `CHAN_LINUX_SYSTEM_GUI` selects `auto`, `system` or `bundled`.

Independently, under an AppImage the desktop disables WebKit's dma-buf renderer only when the NVIDIA proprietary driver is present, and never overrides a value the user set. Disabling it drops the webview onto a path where the WebGL layer paints nothing, which costs the terminal its WebGL renderer, so it is not done unconditionally. `CHAN_LINUX_DMABUF` selects `auto`, `on` or `off`; `on` is the only way to ask for the accelerated path on NVIDIA, because WebKit reads the variable by presence rather than value.

The desktop tells the page what it decided. It appends `chan-renderer=webgl|dom` and `chan-gpu=1|0` to every native workspace URL, local and remote, and the serving tenant stamps them into the page as meta tags, so the terminal uses WebGL only when the native WebKit process permits it and the welcome animation stays on drawn 2D when there is no GPU.

## Self-update

The desktop updates itself through `tauri-plugin-updater`, driven from Rust; no page holds an updater grant. It applies where a signed payload and a feed exist: the macOS `.app`, the Linux AppImage and the Windows NSIS install. A Linux binary that is not an AppImage and a Windows binary that is not an install answer a clear not-supported error; a distro-packaged desktop never reaches the updater, because the CLI refuses on the `CHAN_PACKAGED` marker first; FreeBSD compiles the plugin out. Payloads are verified with a minisign signature against the public key in `tauri.conf.json`, and the client reads one static manifest at `https://chan.app/dl/desktop/latest.json`, generated at release time and served with the rest of the site. The manifest may carry `minimum_system_version`, a map from updater target (`darwin`) to the macOS floor the offered build was bundled with; the updater itself checks no such thing, so before a check is answered or an install starts the desktop compares that floor with the running macOS and refuses, naming both versions, rather than replace a working app with one LaunchServices will not open (`src/update_floor.rs`). A manifest without the entry installs as before.

On Linux the payload is the AppImage itself: the plugin resolves the running image from `$APPIMAGE`, writes the new bytes over that path with a backup, and relaunches it, so the wrapper shims stay valid. On Windows the payload is the NSIS installer, and the install is the process exit: the plugin launches the installer passively and exits, and the installer relaunches the app, so the desktop downloads first, drains its tenants, and hands the verified bytes over last.

Two drivers share one in-process gate so only one replaces the image at a time. A check runs once per launch in the background (`CHAN_UPDATE_CHECK=0` silences it, the same switch as the CLI's banner); on macOS and the AppImage it installs and then shows the launcher's update dialog, on Windows it stages the bytes and asks first. Key handling and the bridge release a key rotation needs are in [updater-bridge.md](./updater-bridge.md) and the [contributor guide](../.agents/desktop.md).

## Packaging

The desktop is self-contained: it links chan-server, chan-library and chan-workspace directly and embeds both web bundles at build time. Tauri's `frontendDist` is the small static shell of the About and connecting pages, not the workspace app, and the configured CSP governs only those local pages, since every workspace window loads over loopback HTTP as an external URL. Build and packaging go through `desktop/Makefile`, which the root Makefile's desktop targets delegate to; the crate is not published to crates.io.

- macOS: one codesigned and notarized `.app` in a DMG, arm64. Signing and notarization run in CI from secrets and locally from the keychain.
- Linux: the AppImage is the published desktop payload and the one the updater serves; the distro packages (deb, rpm, AUR, Nix) and the Homebrew cask come from the packaging tree, and the distro packages install the shared desktop entry with its terminal-emulator keys.
- Windows: a signed NSIS installer that carries the signed console `chan.exe` as a resource, plus a signed CLI zip. Signing runs through SSL.com eSigner in CI.

The practical build, signing, notarization and release steps are in the [contributor guide](../.agents/desktop.md).
