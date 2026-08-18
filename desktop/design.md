# chan-desktop design

This document is the source of truth for what chan-desktop is and is not. It is intentionally light on Rust / Tauri specifics and heavy on business logic. When the implementation drifts from this doc, fix one of the two.

## 1. Purpose

chan-desktop is the native desktop shell for chan. For normal local workspaces it embeds chan-server in the desktop process and serves the same Svelte editor on a loopback HTTP port. It links `chan-workspace` and `chan-server` directly, and registry mutations run in-process against the embedded `chan-workspace` `Library`. The same binary also IS the `chan` / `cs` command line: invoked through a `chan` or `cs` name (argv0, or `$ARGV0` inside an AppImage) it dispatches the CLI before any GUI init, and on boot it owns the `~/.local/bin/{chan,cs}` shims (section 7) -- so a desktop install ships the CLI *with* the app, nothing extra to download. The desktop app exists so that:

- a non-CLI user can install one signed bundle and open a folder through a familiar OS dialog instead of a terminal,
- multiple workspaces can be supervised at once, with one launcher window acting as the inventory and on/off control,
- local embedded workspaces and explicit remote attachments share the same editor window model.

Non-goals:

- chan-desktop is not a second editor. The editor is the web app served by chan-server. The desktop manages workspaces and opens the editor in Tauri webview windows.
- chan-desktop is not a general web browser. Workspace windows are dedicated Tauri webviews pointed at local or attached chan URLs.

## 2. Mental model

One desktop process hosts many running local workspaces:

```mermaid
flowchart TD
    User["User"] --> Launcher
    subgraph Desktop["chan-desktop (one supervisor process)"]
        Launcher["Launcher window (inventory + on/off)"]
        Host["WorkspaceHost (embedded chan-server)"]
        Listener["Single 127.0.0.1:PORT listener (HTTP + WS)"]
        Launcher -->|"toggle On"| Host
        Host --> Listener
    end
    Listener --> WS1["Tenant /workspace-a1b2c3d4e5f60718 (AppState, watcher, indexer, token)"]
    Listener --> WS2["Tenant /workspace-9f8e7d6c5b4a3921 (AppState, watcher, indexer, token)"]
    WS1 -->|"http://127.0.0.1:PORT/workspace-a1b2c3d4e5f60718/?t=TOKEN"| View1["Tauri webview window"]
    WS2 -->|"http://127.0.0.1:PORT/workspace-9f8e7d6c5b4a3921/?t=TOKEN"| View2["Tauri webview window"]
```

*One supervisor embeds a WorkspaceHost that serves many local workspaces on a single 127.0.0.1 listener under per-path-hash prefixes, each opened in a Tauri webview via a tokened URL.*

There are four workspace attachment modes:

- **Local embedded**: a local registry entry opened by chan-desktop. The desktop mounts the workspace into its embedded `WorkspaceHost` and owns the runtime.
- **Devserver**: a headless `chan devserver` the desktop dials by URL (often over an `ssh -L` forward). The devserver owns the per-workspace runtimes and tokens; the desktop persists only the connection recipe and owns the windows.
- **Gateway roster**: an account-level gateway connection whose authenticated devserver roster the desktop projects into the launcher (section 6.7).
- **Outbound URL**: an already-running chan server opened by URL. A backend-only path (config, commands, connecting screen) with no launcher surface.

There is no fallback serve mode. A terminal `chan open <path>` hands the workspace to a running desktop over the CLI handoff socket instead of racing it for the workspace lock.

## 3. Workspace lifecycle

```mermaid
stateDiagram-v2
    [*] --> Off : CLI chan workspace add registers, On=off
    [*] --> Serving : Desktop New add registers + auto-start

    Off : Registered, Off
    Serving : Serving, mounted in WorkspaceHost

    Off --> Serving : Toggle On
    Serving --> Off : Toggle Off, unmount + destroy windows
    Serving --> Serving : Open, mint another webview, capped

    Off --> [*] : Forget, unregister, fs untouched
    Serving --> [*] : Forget, stop + unregister, fs untouched

    note right of Serving
        Isolated AppState, watcher, indexer,
        terminal registry, MCP bridge, token.
        Emits serves-changed, opens workspace webview.
    end note
```

*Local-workspace lifecycle: desktop New auto-starts while CLI `chan workspace add` stays Off; Toggle On mounts an isolated runtime, Toggle Off unmounts and destroys windows, Forget unregisters and leaves the filesystem untouched.*

### 3.0 Source of truth

The `chan` registry at `~/.chan/config.toml` is the single source of truth for the set of known workspaces. Desktop-driven mutations (add, remove) run in-process against the embedded host's shared `chan_workspace::Library` -- the same code path the CLI uses, without spawning it. Routing everything through the one shared `Library` is what keeps a freshly-added workspace openable immediately: mutating only the on-disk registry would leave the host's in-memory snapshot stale.

The desktop owns a small config of its own at `~/.chan/desktop/config.json` -- the same `~/.chan` home as the CLI registry, not a separate OS app-data directory. It holds desktop-only state: outbound URL attachments, devserver and gateway connection recipes, exact shared-devserver native-trust records `(gateway id, owner user id (UUID), full devserver id)` -- the username rides along for config legibility only and never authorizes -- and the closed-window restore stack (section 6.3). Gateway rosters remain volatile and authenticated; persisted trust cannot manufacture a row that is absent from the current roster. The On column is derived live from the in-memory map of active local runtimes; the on-set persists to the library-owned overlay at `~/.chan/workspaces.json` (`{path, on}` rows, shared with the devserver) on every toggle and on clean shutdown, so a restart re-serves the workspaces the user left running (the section 3.2 boot matrix). Accepted trade-off: a crash with an entry persisted re-serves it next boot; a re-serve failure there surfaces a notice and is left off (it drops from the set on the next clean shutdown).

A filesystem watcher (`notify` + debounce) runs over `~/.chan/` for the lifetime of the process and emits a `registry-changed` Tauri event when the registry file itself changes (events are filtered to that file: `preferences.toml` churn from pane drags must not storm the launcher). On a registry change it also reloads the embedded library registry and signals the library change feed, so the launcher's `/api/library` watch re-renders. Concrete consequence: if the user runs `chan workspace add ~/notes` from a terminal, the row appears in the desktop window without any explicit refresh.

### 3.1 The launcher

The launcher (Tauri label `main`, title "Chan Desktop") is a singleton: it is never multiplied, its close button hides rather than destroys it, and reopening is instant. It renders collapsible machine cards: one local card plus one card per devserver, with gateway-rostered devservers listed beside the persisted rows. Each card lists its workspaces as expandable rows carrying an on/off toggle (a connection dot for remote rows), an Open action, and select-mode checkboxes for bulk actions; gateways are managed on their own launcher screen.

A local workspace can be named when it is added (the label rides the library add route); the watcher reflects registry changes made from a terminal.

### 3.2 First launch and the [New] modal

A workspace is opt-in: chan-desktop never creates one on your behalf. There is no default workspace, no `~/Documents/Chan`, and no embedded manual seeded anywhere. Boot opens the launcher, mounts the shared `/terminal` tenant, and then follows the matrix:

- **Fresh library** (empty registry, first-open marker unset) -- the library's first-open rule mints one boot terminal, the workspace-less `kind=terminal` window of section 6.5, and persists the marker. With the marker set, an emptied registry never re-mints: a user who closes their only terminal reopens to none.
- **Workspaces were on at the last clean shutdown** (the `~/.chan/workspaces.json` overlay, section 3.0) -- each is re-served without minting new windows; the window watcher restores that workspace's persisted window records at their stable window ids (hidden stays hidden). A workspace that fails to re-serve surfaces a system notice and is left off.

The user creates or opens a workspace only when they want one, through the [New] dialog. Context-anchored entry points open it pre-set to one of three forms -- Local directory, Devserver, or Gateway -- with no in-dialog chooser:

- **Local directory**: native folder picker (a plain path input in a browser) plus an optional name, POSTed to the library add route (`POST /api/library/workspaces`), which registers the folder and immediately starts + opens it. There is deliberately NO desktop-side pre-flight scan or feature toggle here: chan's SPA owns first-boot readiness through its preflight overlay and the optional Semantic / Reports layers post-boot. A desktop scan dialog would duplicate and race the SPA boot surface.
- **Devserver**: an Address field (bare `host:port` or a full URL) plus optional label, connect script, and token; the control terminal runs the script and the desktop dials out.
- **Gateway**: identity origin URL plus optional label; sign-in runs at connect (section 6.7).

The auto-start on add is specific to the desktop UI: the user's intent there is "make this workspace usable now". `chan workspace add` from a terminal only registers; the desktop shows the new row with On = off.

### 3.3 Toggle On (serve)

Toggling On opens the workspace through the embedded chan-server `WorkspaceHost`. The desktop owns one loopback listener for the whole process and mounts each workspace under a distinct path prefix (derived from the hash of the canonical path). Each mounted workspace gets isolated AppState, watcher, indexer, terminal registry, MCP bridge, control socket, and token state.

Embedded local serving keeps chan-server's bearer token gate enabled. The desktop webview receives the token-bearing URL and the SPA stores the token in sessionStorage.

The local runtime:

- stores the URL in `AppState.serves` in memory only,
- emits a `serves-changed` Tauri event so the row re-renders with the Open button enabled,
- opens one workspace webview automatically, with additional Open clicks opening more windows for the same runtime (capped per workspace),
- closes all of the workspace's windows when the runtime is toggled off.

A workspace already open in another chan process (a standalone `chan open`, or a second desktop) surfaces as a clear "open in another chan process" error and the toggle reverts; a quick off-then-on retries briefly so the previous handle can release its lock.

### 3.4 Toggle Off (stop)

Toggle Off closes the mounted workspace in WorkspaceHost and destroys its workspace windows. App exit runs the same stop path for every active local runtime.

### 3.5 Forget (remove)

Stops the serve (if running), then unregisters the workspace through `chan-workspace` in-process. The filesystem is untouched. The watcher fires and the row disappears. For a devserver's served workspace, Forget unmounts it on the devserver and drops the row. There is no "delete workspace" action in the desktop UI.

### 3.6 External changes

Anything that mutates `~/.chan/config.toml` shows up in the UI: `chan workspace add` / `chan workspace rm` from a terminal, a second chan-desktop process, or hand-editing the TOML.

For an external `chan open` the registry only records that the workspace exists, not that a serve is running: the local On toggle stays off and no URL appears. The desktop does not adopt that server; outbound URL attach is a backend-only path with no launcher surface (section 11.1).

## 4. Validation

The desktop avoids inventing durable validation rules. It defers to chan-workspace where that surface already owns a contract, so anything the desktop accepts is also accepted by every other chan surface.

- **Workspace name**: not validated by the desktop at all. Names are written at add time through the library add route; chan-server enforces `chan_tunnel_proto::is_valid_workspace_name`.
- **Path**: canonicalised via `std::fs::canonicalize` before being registered or opened, so the registry key the desktop uses matches what the user sees. When canonicalisation fails (broken symlink, asleep network mount), the literal path is used.

## 5. Self-contained runtime

chan-desktop is self-contained. It links `chan-workspace` and `chan-server` directly and embeds the web bundle at build time. On macOS and Linux no `chan` binary is shipped in the app bundle, and none is required at runtime; the Windows NSIS installer carries a separate signed `chan.exe` CLI as a resource.

Local workspaces open through the embedded chan-server `WorkspaceHost`, which owns a single `chan_workspace::Library`. Every registry mutation runs in-process against that `Library`.

The embedded server also owns one process-wide local extension runtime shared by every mounted workspace. It starts declarations once when the server starts and shuts their process groups down after hosted tenants drain. Extension HTTP is reverse-proxied under each workspace tenant, so webviews remain on the embedded server's existing origin and no loopback-any-port frame source is required. Note the configured Tauri CSP governs only the custom protocol: workspace windows load the SPA via `WebviewUrl::External` over `http://127.0.0.1`, so no CSP applies to those windows today; `'self'` was added to the configured `frame-src` purely as insurance against a future switch to the asset protocol.

The macOS artifact is a single codesigned and notarised app; Windows signs the desktop exe, the bundled CLI, and the installer. External `chan open` processes are supported as explicit remote attachments (section 11), not as a local serving dependency.

## 6. Window model

### 6.1 Window kinds

Every window is a Tauri webview with a label prefix that encodes its kind, and Tauri capabilities are granted by label glob:

- `main` -- the singleton launcher (section 3.1). The `main-*` glob is also covered by the launcher capability so any launcher-class window inherits the same permission set.
- `local::<window_id>` -- watcher-opened local workspace windows, labeled by the library-minted window record. The workspace's embedded route prefix stays `workspace-<hash>` (hash of the canonical path), which capability globs and teardown matching key on.
- `lib-<hex>::<window_id>` -- watcher-opened devserver windows, the same composite `{library_id}::{window_id}` label scheme with the SPA served by the remote devserver.
- `control-terminal-<devserver id>` -- the embedded terminal-only window that runs a devserver's connect script.
- `outbound-<hash>-<seq>` -- remote workspace windows, hashed from the attachment identity, namespaced apart from local labels; the per-process `seq` makes every label unique so multi-window works.
- `terminal-win-<seq>` -- standalone terminal windows (section 6.5).
- `about` -- the bundled About window: singleton, same content on every platform (mirrors the SPA Dashboard About slide), and the target the macOS system About item is redirected to.

All embedded-SPA windows load the SPA with a `?w=` session key -- the bare `window_id` for watcher-opened windows (decoupled from the OS-window label), the label for outbound windows -- so per-window session state (`session.json` panes/tabs) is keyed by the window, and get a " Window N" title suffix where N is the lowest free number among live windows sharing a base title, so the OS window switcher disambiguates.

Capability grants are origin-aware as well as label-globbed: a capability reaches remotely-served content only when its `remote.urls` covers the loading origin, and every chan window is remotely served (the embedded server is loopback HTTP). Broad capabilities are loopback-scoped. The loopback-served launcher (`main`, `main-*`) gets the event-listen and update-restart grants (launcher-events.json, launcher-update.json). Gateway-backed `lib-*` windows have no static or wildcard capability. After an authenticated entry response passes the full identity, exact-child namespace, scheme/port, same-origin entry URL, and refresh-origin checks, the desktop mints one runtime capability for that canonical exact origin. The grant carries the workspace-window command set (which includes `open_reverse_tunnel`, so `cs tunnel` reaches gateway-served `lib-*` windows) plus the native transfer commands, fullscreen, webview zoom, and opener. Official and custom gateways use this same entry-derived path. Each transfer command has its own permission entry, and the static local-transfer capability covers locally served and loopback-devserver window classes; gateway-served `lib-*` content is excluded by its loopback-only remote scope. `read_dropped_paths` is the standing exception on every origin: the macOS drag pasteboard is system-wide, so local-drop.json grants it only to locally-supervised window kinds, never to `lib-*` or `outbound-*`. `outbound-*` webviews (arbitrary remote URLs) match no remote pattern and get no IPC at all on their remote content. Runtime Tauri grants are additive: revocation closes managed windows and blocks reconnect immediately, while purging an already-minted origin from the process authority requires quitting and restarting Chan Desktop. serve.rs's origin-aware ACL tests pin the SPA invoke vocabulary and prove that no static or runtime grant contains a gateway wildcard.

### 6.2 Menus and the chord bridge

Workspace webviews get a native key bridge injected before any page script. It translates VS Code-style chords into the `chan:command` window event the SPA listens for, claiming each chord in capture phase so the SPA keymap cannot drift out from under it. The policy: chords whose actions are reachable through Hybrid Nav (Cmd+.) stay unbound, and the command-launcher chords stay page-owned because the SPA's inline command deck binds them identically on every surface; direct chords exist where Hybrid Nav is no substitute (tab close/reopen/jump/nav, find on page, search, splits, and the context-aware spawn family Cmd+T / Cmd+O / Cmd+P / Cmd+Shift+M). Cmd+R (reload) and Cmd+Opt+I (DevTools) bypass the SPA event bus and invoke Tauri IPC directly so a frozen SPA cannot lock the dev affordances away. Zoom chords (Cmd+= / Cmd+- / Cmd+0) ride the same IPC path; the level persists per window (section 6.3). Linux/Windows variants avoid stealing terminal chords (plain Ctrl+W / Ctrl+R reach the shell; tab close is Ctrl+Shift+W, window close Ctrl+Alt+W, reload Ctrl+Shift+R).

The native menus route by the focused window's kind:

- File > New Terminal (Cmd+T): SPA window focused -> dispatch `app.terminal.toggle`; launcher or nothing focused -> open a standalone terminal window.
- File > Close Window (Cmd+W on macOS, Ctrl+Alt+W off macOS): SPA window focused -> `app.tab.close` on macOS, `app.window.close` off macOS (the connecting screen is the exception: the chord cancels and really closes); other windows close natively.
- Window > New Window (Cmd+Shift+N): opens another window of the workspace owning the focused window (unburying the family's most recent hidden window first). A focused standalone terminal opens another terminal window; the launcher (or nothing) focused opens a standalone terminal. Plain Cmd+N is deliberately left to the SPA's New Draft.
- Window > Computers: shows the launcher.

Quitting prompts for confirmation once (running terminals and workspace runtimes die with the process); a confirmed quit tears down every runtime and listener.

### 6.3 Bury-on-close and window restore

```mermaid
stateDiagram-v2
    [*] --> Live: open restores record or pops LRU entry
    Live: Live SPA window, terminals and layout warm
    Buried: Buried hidden window, record kept
    Destroyed: Destroyed, gone

    Live --> CloseGate: OS close button
    state CloseGate <<choice>>
    CloseGate --> Prompt: live SPA window
    CloseGate --> Destroyed: empty terminal, connecting screen, connecting control terminal
    Prompt: Hide / Close / Cancel overlay
    Prompt --> Buried: Hide, persist hidden
    Prompt --> Destroyed: Close
    Prompt --> Live: Cancel
    Live --> Destroyed: programmatic close cascade

    Buried --> Live: unbury via Window menu or Cmd+Shift+N
    Buried --> [*]: app quit, records survive restart
    Destroyed --> [*]
```

*OS close prompts Hide / Close / Cancel on a live SPA window; Hide buries with a persisted record, Close destroys; empty terminals, connecting screens, connecting control terminals, and programmatic closes destroy outright; the next open restores the persisted record (watcher windows) or pops a compatible LRU entry (outbound windows).*

The OS close button on a live SPA window holds the close and evals a confirm into the webview: the SPA shows a Hide / Close / Cancel overlay. Hide *buries* the window -- live terminals and layout stay warm -- and Close destroys it. Buried windows are listed in the Window menu and unburied from there or by Cmd+Shift+N on their family. Three cases really close with no prompt: a standalone terminal window with no live shells, a window still on the connecting screen (burying it would leave an unkillable hidden retry loop), and a control terminal still connecting. Programmatic closes (the SPA's empty-window cascade, workspace-off teardown) destroy outright and never bury.

Bury and restore route by window class. `local::` and `lib-` windows bury through their library's window watcher: the window record persists `hidden`, the reconcile closes the native window, and the next open (or relaunch) restores the record at its stable `window_id` so `?w=` re-hydrates the panes/tabs from `session.json`. Outbound windows bury in place and capture a restore snapshot -- window label, URL hash, zoom level -- onto a small LRU stack in the desktop config, keyed by attachment identity; the next open pops a compatible entry, reuses the label, re-applies the URL hash (overlay state: file-browser path, search query, graph scope), and restores the zoom. OS window geometry restores for every window class from a per-window, per-monitor-signature LRU in the desktop config. Both stores survive restarts, so "the window I had open" comes back across a quit, and LRU entries whose label is still alive are skipped rather than popped (a buried window must keep its entry for the quit-while-buried case).

### 6.4 The connecting screen (outbound)

Outbound windows do not load the remote URL directly: a down remote would paint a blank white webview (WKWebView never finishes navigating). They load a bundled connecting/retry page instead, which shows the attempt log, probes the remote through the `probe_url` IPC (any HTTP response counts as up; only transport failures retry), and on success navigates the same window to the fully-assembled target URL -- `?w=` and restored hash included -- so it becomes a normal workspace window in place. The page cannot probe the remote itself: the strict CSP blocks cross-origin fetches, and Rust owns the per-attempt timeout. Cmd/Ctrl+W and the close button on the connecting screen cancel and really close.

### 6.5 Standalone terminal windows

Standalone terminal windows host the SPA in terminal-only mode (`kind=terminal`: no workspace fetch, terminal panes only). All of them load the ONE shared `/terminal` tenant of the embedded server, mounted on first use and never torn down per window: PTYs live in a single registry, so a terminal tab moved between windows keeps its live PTY, and orphaned PTYs idle-prune. There is no registry entry and no On-toggle lifecycle. Sessions inherit chan-server's terminal contract, including the `cs` control socket, so `cs` works inside a desktop terminal exactly as under a standalone `chan open`. The close button buries the window while shells are live and really closes it when none are left.

### 6.6 Remote windows

Remote-backed connections (outbound attachments) own their window state server-side. The desktop polls each connection's `GET /api/windows` and lists the reopenable rows (`saved` but not `connected`) in the Window menu; choosing one builds a webview with that exact label so the remote re-hydrates that window's session. The poll refreshes when remote-backed windows open or close.

### 6.7 Gateway roster devservers

A gateway is signed in once at the account level. Its authenticated roster is projected into the launcher as volatile devserver rows keyed by `(gateway id, owner, full devserver id)`. Owned rows may connect directly. Shared rows render a native-access warning and cannot connect until the user persists trust for that devserver's exact gateway identity `(gateway id, owner user id (UUID), full devserver id)`. The launcher orders the consent operation strictly: `PUT native-trust`, authoritative re-list, then ordinary connect. Revocation uses `DELETE native-trust`; the response waits for the connection and its managed windows to be torn down. The gateway side of this lifecycle (discovery, sign-in, roster, entry, and the data path) is designed in [`gateway/design.md`](../gateway/design.md).

The desktop enforces the same rule behind the UI. It refuses an absent roster row or an untrusted shared row before requesting an entry, serializes trust changes and connects per row, and rechecks a policy generation before registration and watcher startup. Roster removal prunes trust and tears the row down. An owned-to-shared role flip tears down unless exact trust already exists. This prevents an in-flight connect from surviving a removal, revocation, or policy downgrade.

For an allowed row, the desktop asks the gateway entry endpoint for that explicit owner and full id. It validates the response before making any request to `entry_exchange_url`, pins the first exact proxy origin for refreshes, and mints the exact-origin Tauri capability before starting the window watcher. Entry or capability-mint failure is fatal only to that row connection; the account gateway and roster poll remain live.

## 7. Power users and the CLI tool

Non-goal: chan-desktop installation should be "drag Chan.app to /Applications". No installer, no scripts.

chan-desktop is also the `chan` / `cs` command line: on boot it owns `~/.local/bin/{chan,cs}` shims that resolve to the running desktop binary, so a desktop install gives you `chan open` and the shell-first workflows with nothing extra to download. A standalone `chan` (the `chan.app/install.sh` installer or a release tarball) is still available and independent; the two share the same `~/.chan` registry, so a workspace added by one shows up in the other.

The shims are installed on boot per package kind: a macOS `.app` or Linux deb/rpm gets real symlinks to the installed binary; a Linux AppImage gets tiny `exec -a` wrapper scripts, because `current_exe()` inside an AppImage is the ephemeral mount. Both names resolve to the same binary, and the argv[0] stem dispatch (`chan_shell::invoked_arg0`, which prefers `$ARGV0` over `argv[0]` so an AppImage that lost argv[0] to `AppRun` still reaches the inner CLI instead of the GUI) selects the CLI / control-client / GUI path. Best-effort, idempotent, and self-healing: a shim we wrote is re-pointed or rewritten on the next launch when it goes stale (the binary moved, the AppImage updated), and a `chan` / `cs` the user installed themselves is never clobbered.

## 8. Distribution

The download entry point is https://chan.app/install. Desktop artifacts are built by the release workflow; the branch dry-run lane exercises the same artifact matrix:

- macOS arm64: notarised DMG containing `Chan.app`. Drag to /Applications. Signed and notarised in CI with the Developer ID identity imported from secrets.
- Linux: `.AppImage` plus distro packages (`.deb`, `.rpm`), unsigned.
- Windows x64: signed NSIS installer built from `tauri.windows.conf.json`, which bundles the signed `chan.exe` CLI as a resource, plus a signed CLI zip (`chan-x86_64-pc-windows-msvc.zip`). Signing runs through the SSL.com CodeSignTool lane in CI.

Cargo install (`cargo install chan-desktop`) builds the self-contained desktop from source, for contributors and packagers rather than end users. The README points end users at chan.app.

### 8.1 Linux AppImage GUI stack

The AppImage bundles its own GUI stack (libgtk-3, libwebkit2gtk-4.1) and the GL/EGL/gbm libraries `linuxdeploy-plugin-gtk` pulls in, built on the Ubuntu CI runner. On a host whose Mesa is newer than the bundle (rolling distros such as CachyOS / Arch on an AMD radeonsi iGPU), the bundled libgtk cannot create an EGL display against the host Mesa and the webview aborts at creation with `EGL_BAD_PARAMETER`. No single bundled GTK/Mesa works across every distro indefinitely; the host's GTK and Mesa are always built against each other.

The Linux GUI-stack bootstrap runs before webview creation. It prefers the host GUI stack, falling back to the bundle:

- It runs only inside an AppImage (keyed on `cs_install::appimage_path()`) and is a no-op on macOS / Windows / `.deb` / `.rpm` / `cargo run`.
- Presence gate: only when BOTH `libgtk-3.so.0` AND `libwebkit2gtk-4.1.so.0` resolve in the host `ldconfig -p` cache does it shadow the bundle (a partial shadow is worse than either stack alone).
- It discovers the host lib dir from `ldconfig -p` (correct on Arch `/usr/lib`, Fedora `/usr/lib64`, Debian/Ubuntu multiarch, x86_64 and arm64), prepends it to `LD_LIBRARY_PATH`, and re-execs the binary once. A re-exec is required because `libgtk` / `libEGL` are already loaded by the time `main()` runs, so rewriting the loader path only takes effect in a fresh process. The GTK module env the AppImage `AppRun` exported is inherited across the exec, so only the library path is rewritten.
- A `CHAN_LINUX_SYSTEM_GUI_APPLIED=1` marker set across the re-exec guards against a loop.
- Independent layer: under an AppImage it defaults `WEBKIT_DISABLE_DMABUF_RENDERER=1` only when the NVIDIA proprietary driver is present (`/proc/driver/nvidia/version` or `/sys/module/nvidia/version`), and never clobbers a value the user already set. dma-buf is how WebKit hands GPU buffers to the compositor, so disabling it drops the whole webview onto the legacy WPE/X11 path: measured on an AMD host, the WebGL layer then paints nothing at all while context creation still succeeds, which costs xterm.js its WebGL renderer and the terminal grid its box drawing. The fault being worked around is the NVIDIA driver's, upstream declined to detect it (WebKit bug 262607, WONTFIX), and Tauri's own guidance is that an unconditional override "disables a faster path for everyone, including users on working setups".

The `CHAN_LINUX_SYSTEM_GUI` env knob selects the policy:

- `auto` (default): prefer the host stack when present, else the bundle.
- `system`: force the host stack; exit with an error if it is unavailable.
- `bundled`: keep the bundle-first behavior, for debugging.

The `CHAN_LINUX_DMABUF` env knob selects the dma-buf policy independently:

- `auto` (default): disable dma-buf only for the NVIDIA proprietary driver.
- `on`: never disable it, whatever the driver. This is the knob for an NVIDIA user who wants to try xterm.js's WebGL renderer, and it is the only way to ask for the accelerated path: WebKit reads `WEBKIT_DISABLE_DMABUF_RENDERER` by PRESENCE rather than value, so setting it to `0` disables dma-buf exactly as `1` does (measured), and the variable can therefore only ever turn the fast path off.
- `off`: always disable it, the pre-detection behavior, for a host that needs the workaround without the NVIDIA driver loaded.

The terminal renderer follows the same dma-buf decision. After the Linux bootstrap applies the policy, chan-desktop appends `chan-renderer=webgl|dom` to every native workspace URL, including remote devserver URLs. The serving tenant stamps that value into the SPA shell as `<meta name="chan-webgl-renderer" content="1|0">`, and xterm.js uses WebGL only when the native signal permits it. A desktop shell without a valid signal stays on DOM; a browser keeps WebGL because the signal describes the native WebKit process, not the serving host. `chan:terminal-webgl` in localStorage (`"1"` on, `"0"` off) overrides the carried result for diagnostic pixel readings. On an NVIDIA host, `CHAN_LINUX_DMABUF=on` keeps dma-buf active and therefore carries `webgl`; `off` and the auto-detected proprietary driver carry `dom`.

## 9. Self-upgrade

chan-desktop updates itself through `tauri-plugin-updater`, gated by the `updater:*` capabilities. Self-update is macOS-only: only macOS has a signed updater payload and feed, so the Linux AppImage and the Windows NSIS install do not self-update (the on-launch check is a no-op there, and a hand `chan upgrade` answers a clear not-supported error). On macOS a fire-and-forget check runs once per launcher process launch.

- Update bundles are verified with a minisign signature. The production public key is embedded in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`; the matching private key lives outside the repo in the release owner's secret store.
- The client probes a single static manifest at `https://chan.app/dl/desktop/latest.json`, generated at release time and deployed to GitHub Pages with the rest of chan.app; there is no dynamic `/dl` server. The manifest carries a top-level `version` plus a `platforms` map keyed by `{os}-{arch}` (e.g. `darwin-aarch64`); Tauri picks the running target's entry and compares `version`.
- One executable to upgrade. The desktop binary IS `chan` (section 1), so there is no second CLI to update -- the `~/.local/bin/{chan,cs}` shims point at the one binary. `chan upgrade` from the desktop-dispatched binary (`Personality::Desktop`) does NOT replace a tarball: it delegates over the well-known handoff socket to the running desktop, which drives this same `tauri-plugin-updater` (check -> download -> install -> `restart()`) on macOS; elsewhere the desktop answers the handoff with the not-supported error. If no desktop is running the CLI launches one first; after a successful install the desktop re-affirms the shims (so they keep pointing at the upgraded binary). `chan upgrade --check` reports availability synchronously without installing. The standalone `chan` (install.sh) is the only path that still self-upgrades by replacing its CLI tarball in place.

Key rotation and updater-payload signing/verification are documented in `.agents/desktop.md` ("Auto-upgrade signing") and the [`updater-bridge.md`](./updater-bridge.md) runbook.

## 10. Settings and developer controls

chan owns the Settings overlay per workspace. The Settings chord is handled in the SPA so user keymap assignments can replace it; pane side flip is a separate `app.pane.flip` command.

Maintainer controls stay native:

- Cmd+R (macOS) / Ctrl+Shift+R (Linux/Windows) reloads the focused workspace webview.
- Cmd+Opt+I / Ctrl+Alt+I opens webview DevTools (enabled in release builds via the `devtools` Cargo feature).
- `CHAN_LINUX_SYSTEM_GUI` (`auto` | `system` | `bundled`) selects the Linux AppImage GUI-stack policy; see 8.1.
- `CHAN_LINUX_DMABUF` (`auto` | `on` | `off`) selects the dma-buf policy; see 8.1.

Future global settings additions are deferred until they have concrete demand. Tunnel publishing belongs in the workspace attachment surface rather than a generic app settings page.

## 11. Remote workspaces

Remote workspaces are explicit attachments. They are not a fallback for failed embedded local serving.

### 11.1 Outbound URL attach

Outbound attach means the server already exists and chan-desktop opens it by URL.

The path is backend-only (the persisted config attachment plus the connecting screen, section 6.4); no launcher form collects the URL. An attached URL opens in a workspace webview and the desktop does not try to start, stop, reclaim, or inspect the server process. This works whether the URL points at another machine or at `127.0.0.1` on the same machine.

## 12. Native file integrations

- **Download**: the SPA gives a same-origin, tokenized file URL to a narrowly granted native command. Rust revalidates the invoking origin and workspace prefix, forwards the webview's authentication cookies, refuses redirects, and streams the response into a same-directory temporary file in Downloads before an atomic rename. Network bytes never cross webview IPC. The SPA polls only a bounded progress record at 10 Hz and cancellation removes the temporary file.
- **Upload / replace**: the native file picker and selected paths remain in Rust. Each regular, non-symlink file is streamed as a multipart body in 64 KiB chunks after the workspace-relative destination, invoking origin, cookies, and CSRF mirror are revalidated. The webview receives only final relative paths and progress snapshots, never file paths or file bytes.
- **Generated downloads**: bytes already produced by the SPA, such as a rendered PDF, cross IPC through an explicit 64 KiB chunk sink and use the same temp-file/atomic-rename commit discipline.
- **Scheduling**: each window runs at most two downloads and one upload. Extra transfers remain visible in a FIFO queue; queued and active operations are cancellable, and page teardown cancels both.
- **Export to PDF**: the SPA renders the PDF itself (the `pdf_export` engine: paginated A4 composition, each page rasterized and embedded through pdf-lib) on every surface. On desktop the bytes cross IPC through the generated-download sink into Downloads; in a browser they save as a normal download.
- **Reverse tunnel** (`open_reverse_tunnel`): the SPA only forwards the `tunnel_open` window command; the native side owns everything sensitive. `revtunnel.rs` validates the payload (UDP refused), resolves the devserver endpoint and credentials from the invoking window's OWN connection record -- never from the payload -- binds the requested desktop port (loopback default; a non-loopback bind logs a warning), and reports Ready/Failed back over the tunnel control WebSocket. A replayed trigger for the same tunnel id replaces the listener (newer wins, older stopped and awaited); ended tunnels stay in the process-local map as inert handles until exit.
