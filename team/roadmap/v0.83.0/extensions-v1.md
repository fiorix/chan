# Extensions v1: TOML-declared subprocess behind an iframe tab

Status: VALIDATED in the `extensions-v1` worktree. The release number is intentionally unpinned; the acceptance target is a working extension tab across standalone, desktop, devserver, and tunnel serving modes.

## What

The deliberately minimal first cut of extensions. A hand-written TOML file dropped into `~/.chan/extensions/` declares one extension: a display name for the command launcher, a binary, and its arguments. At server start chan reads these files and spawns each binary as a subprocess, expecting it to print a loopback URL plus bearer token on stdout. Chan keeps that endpoint private and reverse-proxies it through the current workspace tenant. Running the launcher entry opens a tab holding an iframe pointed at the capability-scoped proxy path. The extension owns its own state, reload behavior, and UI; chan owns discovery, the process lifetime, the HTTP boundary, and the tab.

Extensions are user-supplied local binaries, not a marketplace: no installer, no resolver, no remote fetch, no extension runtime shipped in the chan binary. That is what keeps the single-static-binary story intact.

## Ruled v1 contract

- One regular `~/.chan/extensions/<id>.toml` file declares one extension. The lowercase file-stem ID matches `[a-z0-9][a-z0-9_-]{0,63}` and is the stable command/tab identity; display-name collisions are harmless.
- The schema is `name: String`, `command: String`, and optional `args: String[]`. Unknown fields and malformed or oversized files warn and disappear without failing boot.
- Discovery is eager and process-wide. Standalone serve, devserver, and chan-desktop each own one runtime shared by all their workspace tenants. Valid declarations start concurrently.
- The child prints `CHAN_EXTENSION_V1={"url":"...","token":"..."}` within five seconds and 32 bounded stdout lines. Chan accepts only plain HTTP on exact `127.0.0.1` or `localhost`, rejects an existing `t` query parameter, and keeps both values process-private.
- Successful children live for the Chan process. Unix children get a dedicated process group; shutdown sends TERM, waits two seconds, then sends KILL and reaps. A crash is dead-until-Chan-restart with no respawn in v1.
- Each ready extension gets a random 256-bit path capability. `GET /api/extensions` returns only `id`, `name`, and the tenant-relative `entry_path`, with `private, no-store`; terminal-only windows do not fetch it. `/_chan/extensions/<id>/<capability>/*` reverse-proxies HTTP to the subprocess and adds its bearer only on that private upstream leg.
- The proxy is mounted inside every workspace tenant, including gateway-tunnel tenants. Browser, chan-desktop, standalone, and devserver clients therefore load the SPA and every extension through one IP and port. A wrong capability is `404`; Chan/gateway credentials and upstream cookies are not forwarded.
- Dynamic Apps commands use `extension.<id>`. Invoking one opens a keep-alive `extension` tab whose iframe uses the catalog path plus the active tenant prefix. The sandbox permits forms and scripts but omits `allow-same-origin`, leaving extension code unable to read the parent DOM or Chan APIs. Session/hash/cross-window state persists only the extension ID and title, never the capability, upstream address, or token.
- The gateway retains `frame-ancestors 'none'` for ordinary credentialed content and uses `frame-ancestors 'self'` only for `/_chan/extensions/`. The desktop CSP needs no extra loopback frame source because extension frames stay on Chan's existing origin. The iframe sends no referrer.
- A focused extension relays only the shell chord descriptors Chan advertises through `chan:extension-host-keymap:v1`; matching real keydowns return through `chan:extension-keydown:v1`. Chan accepts a relay only from that tab's exact `contentWindow`.
- There is no `cs` opener in v1.

Chan ships no extension declarations or binaries. The in-tree `chan-server` example `echo-extension` is test source only and is built explicitly as the acceptance fixture: it binds an ephemeral loopback port, mints its own random token, performs the marker handshake, renders one text input whose output echoes every input event, and implements the keyboard relay contract.

## What is already known (grounding, verified 2026-07-29)

Discovery and config:

- All chan-home reads go through the single authority `chan_workspace::paths::config_dir()` (`crates/chan-workspace/src/paths.rs:34`, `CHAN_HOME` override at `:57`); `CHAN_HOME` isolation is a tested invariant (`crates/chan/tests/revtunnel_e2e.rs:94`), so `extensions/` must route through it. `~/.chan/devserver/terminals/` (`crates/chan-server/src/devserver.rs:212`) is the precedent for scanning a directory under the chan home.
- `submit_config.rs` is the template for the whole config shape: opt-in hand-edited TOML, loaded at boot, malformed = warn and ignore, never fail boot (`crates/chan-server/src/submit_config.rs:63-71`; the uniform policy also at `lib.rs:501-503`). `load_toml`/`save_toml` helpers at `crates/chan-server/src/store.rs:16,27`. `docs/config-reference.md` must gain the schema in the same commit.

Spawn and supervision (the genuinely new machinery):

- `build_app` runs per tenant and a devserver host mounts N tenants, so the spawn must be a process-global one-shot, living in `serve()` (`crates/chan-server/src/lib.rs:1347`, model: the `config_watch` handle held for the server's lifetime at `:1380`) and `run_devserver` (`devserver.rs:1545`), not in `build_app`.
- Reading a URL+token off a child's stdout is shipped prior art: `DEVSERVER_TOKEN_MARKER = "CHAN_DEVSERVER_TOKEN="` (`devserver.rs:234`) and the desktop's marker-delimited stdout scrape with timeout and kill-on-timeout (`desktop/src-tauri/src/main.rs:4735`).
- Nothing in chan-server supervises a non-PTY OS process today: PTYs go through `portable_pty` (`crates/chan-library/src/terminal_sessions.rs:1017`) and `TenantTaskOwner` owns tokio tasks, not processes (`crates/chan-library/src/tenant.rs:148`). Extension children need their own kill-on-shutdown path plus orphan handling on hard exit.

Launcher and tab:

- The SPA learns the extension list via a small read-only endpoint beside `GET /api/build-info` (`crates/chan-server/src/routes/build_info.rs:24`, open router at `lib.rs:1511+`).
- The command registry has no dynamic registration today; every module registers statically at import (`state/commands/install.ts:5-17`). `allCommands()` dedupes and tolerates late registration (`state/commands.ts:106-113`), so a post-fetch `registerCommands` of `extension.<name>` rows under the `Apps` category is the one seam to add. Spawn-row shape: `state/commands/core.ts:63-72`.
- A new tab kind touches the union (`state/tabs.svelte.ts:612`), `cloneTab` (`:3387-3480`), the spawn helpers, and a keep-alive `{#each}` block in `Pane.svelte` (an unmounted iframe reloads the extension page, so keep-alive like terminals at `:1553`). `DashboardTab.svelte` is the simplest per-kind surface to model on. The only iframe in the SPA today is the markdown embed path, https-only, two-host allowlist (`api/embed.ts:38,58`).

## Resolved constraints

- A direct loopback iframe would require a second forwarded port, fail through the one-port devserver/gateway tunnel, and force a broad Tauri `frame-src` widening. The tenant-scoped reverse proxy removes all three failures.
- Same network origin must not mean same browser authority. Omitting `allow-same-origin` gives the iframe an opaque origin; the capability path authenticates relative assets/API requests without exposing the extension bearer or Chan bearer.
- Gateway amendment A22 still denies framing for every ordinary credentialed tenant response. Only the unguessable extension proxy namespace receives the narrow same-origin framing exception.
- Keyboard events cannot cross browsing contexts. The versioned keymap/keydown relay is deliberately limited to shell chords and grants no workspace API, native capability, or arbitrary message bus.
- Terminal-only windows gate commands through the `TERMINAL_ONLY_COMMANDS` allowlist (`state/windowMode.ts:14`); extension rows stay out of it.

## Shortcuts

No shortcut field in the TOML. Each extension registers a stable command id (`extension.<id>`), and the existing keymap-override layer makes that command chord-assignable through the rebind UI. Dynamic IDs never enter `SHORTCUTS`, preserving the CLI keybindings-table generator. While an extension iframe owns focus, Chan sends the currently resolved App/Tabs/Panes chords plus user overrides to the child; a cooperating extension prevents and relays only matches. The browser smoke pins `Ctrl+Alt+K` and browser-reserved `Ctrl+Shift+T` from the echo input.

## Rough size

Moderate, with most weight in the backend: TOML discovery, subprocess supervision, and the streaming capability proxy. Launcher registration and the tab kind are mechanical; the keyboard relay and gateway framing exception are small but security-sensitive. No desktop CSP widening remains.

## Explicitly deferred

- Marketplace, installation, dependency resolution, remote fetch, and a Chan-owned extension SDK/runtime.
- Lazy spawn, automatic respawn/backoff, live config reload, and health UI.
- Extension access to workspace APIs, native desktop capabilities, cross-extension messaging, or a privileged host bridge.
- A `cs open_extension` command and TOML-declared shortcut field.

## Acceptance gate

- Build both embedded SPAs fresh before compiling Rust, then build `chan` and `echo-extension` from the same worktree.
- Start against an empty throwaway workspace and isolated `CHAN_HOME` containing only `echo.toml`.
- Prove the catalog reports `echo` without an upstream address/token, a wrong proxy capability receives `404`, the entry document uses Chan's exact origin and port, the Apps command opens the opaque iframe tab, typed text echoes in the real browser DOM, shell shortcuts work from the focused input, tab switching does not reload the frame, and server shutdown reaps the child process group.
- Run Rust formatting/check/tests, Svelte type-check/Vitest/production build, and the native desktop compile path. Record environmental blockers rather than treating an unrun check as green.

## Validation evidence

Validated 2026-08-01 with the in-tree browser smoke check `122-extension-echo.mjs` against a freshly built `chan` and `echo-extension`. The isolated run discovered `echo`, proved the catalog leaked neither subprocess port nor token, rejected a wrong path capability with `404`, loaded the iframe through Chan's exact origin and port, echoed `hello extensions`, opened Commands with `Ctrl+Alt+K` and a terminal with `Ctrl+Shift+T` while the extension input held focus, preserved the frame across tab switches, and verified shutdown reaped the extension PID. The run completed `ALL GREEN`.

The final focused gate passed on 2026-08-01: `cargo clippy -p chan-server --all-targets -- -D warnings`; 13 matching `chan-server` tests; the gateway's focused framing-policy test; Svelte diagnostics with 0 errors and 0 warnings; 5 focused Vitest assertions; and `cargo check -p chan-desktop`. A fresh production web build plus the browser smoke above exercised the shipped bundle. The earlier full-worktree pre-push run predates the proxy correction, so the repository-wide pre-push gate still belongs immediately before merge rather than being inherited by assertion.
