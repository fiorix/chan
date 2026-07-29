# Extensions v1: TOML-declared subprocess behind an iframe tab

Status: REGISTERED for v0.81.0, grounded 2026-07-29, needs design rulings before spec.

## What

The deliberately minimal first cut of extensions. A hand-written TOML file dropped into `~/.chan/extensions/` declares one extension: a display name for the command launcher, a binary, and its arguments. At server start chan reads these files and spawns each binary as a subprocess, expecting it to print a URL plus bearer token on stdout; that endpoint is the extension's entrypoint. Running the launcher entry opens a tab holding an iframe pointed at the URL. The extension owns its own state, reload behavior, and UI; chan owns discovery, the process lifetime, and the tab.

Extensions are user-supplied local binaries, not a marketplace: no installer, no resolver, no remote fetch, no extension runtime shipped in the chan binary. That is what keeps the single-static-binary story intact.

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

## Constraints the design must respect

- Desktop CSP is the hardest blocker: `frame-src` in `desktop/src-tauri/tauri.conf.json:17` allowlists two https hosts and blocks loopback iframes outright. It needs a deliberate widening for loopback, kept mirrored with `embed.ts` per its own comment.
- Extensions are local-only by construction: the gateway proxy stamps `frame-ancestors 'none'` on credentialed tenant responses (`gateway/crates/devserver-proxy/src/proxy.rs:688-696`, standing amendment A22 in [distributed-proxy-control-plane-hardening](../done/distributed-proxy-control-plane-hardening.md)), and a remotely-served SPA cannot reach the user's loopback anyway. The launcher rows must hide on the tunnel path; `CommandContext` (`state/commands.ts:48`) carries no "tunneled" flag yet, so one gets added.
- The extension's URL+token is a second, independent trust domain on the same loopback; chan's own bearer story (`design.md:132`, `serve_config.rs:19-22`) neither covers nor protects it. Chan passes the endpoint to the iframe and otherwise stays out of the extension's auth.
- Terminal-only windows gate commands through the `TERMINAL_ONLY_COMMANDS` allowlist (`state/windowMode.ts:14`); extension rows stay out of it.

## Shortcuts: nearly free, so neither help nor skip

No shortcut field in the TOML. Each extension registers a stable command id (`extension.<name>`), and the existing keymap-override layer already makes any registered command chord-assignable through the rebind UI, persisted in `preferences.toml`, dispatched without any per-command wiring (`App.svelte:583-596`, `keymapAssign.ts:13`). The one rule: dynamic ids must never enter `SHORTCUTS` (`state/shortcuts.ts:81`) or the CLI keybindings-table generator breaks (`shortcuts.ts:6-10`).

## Rough size

Moderate, and the weight is all backend-new: the TOML loader is small, the subprocess supervisor is the new shape (spawn, stdout handshake with timeout, shutdown kill, restart policy), the endpoint + launcher registration is small, the tab kind is mechanical, the desktop CSP change is small but needs its own argument. The extension author experience (a trivial example extension in-tree) is the best acceptance vehicle.

## Open (rule before spec)

- Spawn policy: all at server start (the sketch) vs lazy on first launch; and the crash/restart policy either way (respawn with backoff vs dead-until-restart with a launcher row that says so).
- The stdout handshake wire shape (marker line vs JSON line), the handshake timeout, and what the launcher shows for an extension that never handshakes.
- One extension per file vs a table of extensions per file; whether `name` collisions across files are an error or last-wins.
- Whether the iframe gets the raw URL with the token in the query (extension's own choice of scheme) or chan defines the token-passing convention.
- Desktop `frame-src` widening scope: loopback-any-port vs only the ports chan learned from handshakes (tauri.conf.json is static, so port-scoped means a runtime CSP story).
- Whether `cs` gets an `open_extension` fire-and-forget opener like `open_dashboard` (`control_socket.rs:3564`) in v1 or later.
