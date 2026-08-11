# Chan Config Reference

Canonical schema for every persisted config in chan.

This doc tracks **what gets persisted, where, and who consumes it**. Per-field rows note serde defaults, the user-facing surface (CLI subcommand / Settings field / launcher panel), and any open findings.

When adding a new persisted field: extend the relevant section here in the same commit that lands the schema change so this reference stays in lockstep with the code.

## chan-server

### `~/.chan/server.toml` -- `ServerConfig`

Source: `crates/chan-server/src/config.rs`.

The CLI serializes these under the canonical `server.*` namespace, so terminal fields are `server.terminal.*`. `chan config get` and `chan config set` also accept `terminal.*` as a shorthand alias. The HTTP aggregate keeps its existing owner-relative `terminal.*` spelling. Every scalar row below is reachable through `chan config get/set`. The suffix list uses a JSON string array on CLI set, with at most 100 unique values matching `[A-Za-z0-9_]+`.

| Field | Type | Default | Reachability | Consumers |
|-------|------|---------|--------------|-----------|
| `attachments_dir` | `String` | `"attachments"` | `chan config get/set` + `PATCH /api/config` + Settings | Settings → File browser → attachments folder (pasting happens in the editor and uploading in the file browser; the field is filed under File browser); `/api/attachments` route + SPA upload UI |
| `search.aggression` | `SearchAggression` | `Balanced` | `chan config get/set` + `PATCH /api/config` + Settings | Settings → Search → search indexing profile; search route default mode |
| `terminal.idle_timeout_secs` | `u64` | `1800` (30 min) | `chan config get/set` + `PATCH /api/config` | terminal registry idle prune |
| `terminal.session_cap` | `usize` | `32` | `chan config get/set` + `PATCH /api/config` | terminal registry create-gate |
| `terminal.ring_bytes` | `usize` | `2 << 20` (2 MB) | `chan config get/set` + `PATCH /api/config` | terminal ring buffer alloc |
| `terminal.scrollback_mb` | `u32` | `10` (clamped `10..=50`) | `chan config get/set` + `PATCH /api/config` | SPA xterm.js scrollback line cap |
| `terminal.default_term` | `String` | `"xterm-256color"` | `chan config get/set` + `PATCH /api/config` | PTY spawn `TERM` env |
| `terminal.font` | `TerminalFontChoice` | `os-default` | `chan config get/set` + `PATCH /api/config` + Settings | xterm.js fontFamily chain; `source-code-pro` opts into the bundled font (download flow on non-embed builds) |
| `terminal.font_size` | `u32` | `14` (clamped `8..=32`) | `chan config get/set` + `PATCH /api/config` + Settings | captured when xterm.js or ghostty-web constructs a renderer; both backends and ghostty's xterm-compatible cell measurement use the same pixel size |
| `terminal.mcp_env` | `bool` | `false` | `chan config get/set` + `PATCH /api/config` + Settings | whether new non-team terminals export `CHAN_MCP_*`; per-request `?mcp_env=on` overrides, team spawns use the team config's own `mcp_env` |
| `terminal.mouse_capture` | `bool` | `true` | `chan config get/set` + `PATCH /api/config` + Settings | whether full-screen TUIs may capture the mouse; off strips the DECSET mouse-enable sequences in the SPA so click-drag selection keeps working (new terminals only) |
| `terminal.ghostty` | `bool` | `true` on Linux, `false` elsewhere | `chan config get/set` + `PATCH /api/config` + Settings | new terminals use the ghostty-web backend (Ghostty's WASM VT parser, ~420 KB fetched on first enable) instead of xterm.js; the Linux default is the grid, where xterm.js ships the DOM renderer and box drawing loses a scanline per cell (96.0% rule continuity, 95.2% block coverage) while ghostty measures 100% |
| `terminal.secret_masking` | `bool` | `false` | `chan config get/set` + `PATCH /api/config` | when enabled, xterm.js visually obscures secret-looking assignment values; the per-tab launcher/context-menu toggle is ephemeral and affects only the mounted tab |
| `terminal.secret_mask_suffixes` | `Vec<String>` | stock literal suffix list (max 100) | `chan config get/set` + `PATCH /api/config` | case-insensitive suffix matcher for terminal `NAME=value` output; CLI set accepts a JSON string array and rejects invalid or duplicate entries, while TOML load drops invalid entries with a warning and removes duplicates |

`GET /api/config` returns the editor and server preference aggregate with a revision. `PATCH /api/config` accepts one owner-specific partial preferences object plus `expected_revision`; stale revisions return `409 config_conflict` with the current aggregate.

### `~/.chan/extensions/<id>.toml` -- local extensions

Source: `crates/chan-server/src/extensions.rs`.

Each regular `.toml` file declares one local subprocess. The lowercase file stem is its stable extension ID and must match `[a-z0-9][a-z0-9_-]{0,63}`. Files are read in lexical order. Malformed files, unknown fields, invalid IDs, oversized configs, spawn failures, and failed handshakes warn and are ignored without failing Chan startup. Display-name collisions are allowed because command and tab identity use the file-stem ID.

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `name` | `String` | required | Launcher row and tab title, 1 to 128 characters after trimming |
| `command` | `String` | required | Executable to spawn; bare names use `PATH`, while `./name` resolves from the extension config directory |
| `args` | `String[]` | `[]` | Arguments passed verbatim after `command` |
| `capabilities` | `String[]` | `[]` | Explicit host grants: `session-context` and/or `presentation`; unknown values reject the declaration |

```toml
name = "Echo test"
command = "/absolute/path/to/chan/target/debug/examples/echo-extension"
args = []
capabilities = []
```

Chan discovers and starts extensions once per serving process, not once per workspace tenant. The subprocess inherits Chan's environment, starts with the config directory as its working directory, receives null stdin, and owns its stderr. It must print a newline-terminated handshake within five seconds and 32 bounded stdout lines:

```text
CHAN_EXTENSION_V1={"url":"http://127.0.0.1:49152/","token":"unguessable-secret","singleton":true,"commands":[{"id":"run","title":"Run"}]}
```

The URL must use plain HTTP on exact host `127.0.0.1` or `localhost`; IPv6, remote hosts, userinfo, port zero, HTTPS, and a pre-existing `t` query parameter are rejected. Chan keeps that upstream URL and token process-private. Each ready entry gets a random 256-bit path capability under `/_chan/extensions/<id>/<capability>/...`; the authenticated catalog gives the SPA only that tenant-relative path. Chan reverse-proxies the iframe, assets, and HTTP API calls through the workspace's existing IP and port, adding the extension token only on the private upstream leg. Standalone servers, chan-desktop, local devservers, SSH port forwards, and gateway tunnels therefore use the same one-port route. Persisted and cross-window tab state contains the extension ID and title only, never the capability, upstream address, or token.

The optional handshake fields are `singleton: bool` and a bounded static `commands` array. Each command declares a lowercase-hyphen local `id`, a title, and up to eight keywords. Chan retains the base `extension.<id>` Open command and registers declared commands as `extension.<id>.<command-id>` under Apps. They have no default chords but are assignable through the existing shortcut settings. Singleton commands focus or create one tab and queue delivery until that exact iframe sends `chan:extension-ready:v1`.

The iframe omits `allow-same-origin`, so extension scripts have an opaque browser origin even though their network requests share Chan's port. The proxy strips browser credential headers on the upstream leg (`Authorization`, cookies, `Origin`, `Referer`, forwarding headers, `X-Chan-*`) and upstream cookies on the response, adds no-store and no-referrer response policy, and permits the opaque iframe to call its own capability-scoped HTTP and WebSocket routes. Both proxied body directions carry a 60-second per-item idle timeout; there is no total request deadline and no body size cap. Off-origin `Location` headers targeting loopback (`127.0.0.1`, `localhost`, `[::1]`) are stripped rather than reflected to the browser; external targets pass through unchanged. Every upstream request receives an `X-Chan-Extension-Scope` equal to the server `instance_id` already disclosed by `/api/health` — a tenant discriminator, not a secret — after browser-provided `X-Chan-*` headers are stripped. Non-owner gateway-tunnel participants are read-only on the proxy routes: their POST/PUT/DELETE receive 403 via the shared `require_local_mutation` layer, while GETs (including WebSocket upgrades) pass. Extension HTML must use relative asset/API URLs; an origin-rooted `/asset.js` targets Chan's tenant root, not the extension capability path.

Browser key events inside an iframe do not bubble to Chan. An extension that wants shell shortcuts while focused implements the v1 keyboard relay used by the in-tree fixture: accept `chan:extension-host-keymap:v1` from `window.parent`, match only the supplied physical-key descriptors, call `preventDefault()` for a match, and post `chan:extension-keydown:v1` with `key`, `code`, the four modifier booleans, and `repeat`. Chan accepts every bridge message only from that tab's exact `contentWindow`.

The `session-context` grant sends reactive participant snapshots with opaque IDs, display names, Chan roles, statuses, and the receiving window ID. These labels are not authenticated extension identities. The `presentation` grant accepts enter, exit, and toggle requests and promotes the same iframe wrapper into the browser top layer without reparenting it, preserving its browsing context. Chan supplies Restore and Close controls and leaves Escape to the extension. No grant exposes workspace files, native APIs, or a general host message bus.

Successful children live until Chan shuts down. On Unix each child gets its own process group so descendants receive TERM and then KILL during shutdown. A child that exits is not respawned; restart Chan after fixing it. There is no marketplace, installer, remote fetch, lazy start, or `cs` opener in v1. Treat every file in this directory as an explicit local-code-execution grant.

Chan releases install no extension declarations or extension binaries. The in-tree `echo-extension` is test source only: no echo binary is built into or installed by the `chan` and `chan-desktop` release artifacts, and it is compiled only when a developer explicitly builds the example. To exercise the contract, run `cargo build -p chan-server --example echo-extension`, put its absolute binary path in a config like the example above, and restart Chan. Its launcher command appears under Apps as `Echo test` and opens the extension iframe tab.

### `~/.chan/submit.toml` -- agent submit templates

Source: `crates/chan-server/src/submit_config.rs` and `crates/chan-shell/src/submit.rs`.

Each optional agent table has one `template` string containing at most one `{}` placeholder for the normalized prompt body: trailing newlines are removed, then one newline is appended when the body is non-empty. An empty body stays chord-only. A template without `{}` is appended as a suffix after that same normalized body. Escapes include `\e`, `\xHH`, `\r`, `\n`, `\t`, `\0`, and `\\`. Resolution is `CHAN_SUBMIT_<AGENT>` environment variable, then this file, then the built-in default.

```toml
[claude]
template = '{}\e[27;9;13~'

[codex]
template = '\e[200~{}\e[201~\r'

[gemini]
template = '{}\r'

[kimi]
template = '\e[200~{}\e[201~\r'

[opencode]
template = '\e[200~{}\e[201~\r'
```

The environment equivalents are `CHAN_SUBMIT_CLAUDE`, `CHAN_SUBMIT_CODEX`, `CHAN_SUBMIT_GEMINI`, `CHAN_SUBMIT_KIMI`, and `CHAN_SUBMIT_OPENCODE`. Gemini alone splits its normalized body and submit chord into two ordered PTY writes; overriding its template does not change that write-splitting contract.

### `~/.chan/preferences.toml` -- `EditorPrefs`

Source: `crates/chan-server/src/preferences.rs`.

The CLI prefixes every serialized leaf below with `editor.`. Every scalar leaf is reachable through `chan config get/set`, including optional leaves when present; `none` clears `editor_font_size` and the five Hybrid surface overrides. `cs_dismissed` is readable but intentionally read-only, and `shortcuts` is the documented collection exception (read with the CLI; edit through Settings or `PATCH /api/config`).

| Field | Type | Reachability | Consumers |
|-------|------|--------------|-----------|
| `editor_theme` | `EditorTheme` | `chan config get/set` + `PATCH /api/config` | Settings → Editor → theme selector |
| `editor_font_size` | `Option<u32>` | `chan config get/set` + `PATCH /api/config` + Settings | optional absolute editor body size, clamped `10..=32`; unset uses the active theme, while `N` sets body/source to `Npx`/`(N - 2)px` |
| `terminal_colors.mode` | `TerminalColorMode` | `chan config get/set` + `PATCH /api/config` + Settings | `standard` uses the terminal surface's Inherit/Light/Dark choice; `custom` activates the complete custom payload |
| `terminal_colors.custom.background` | `String` | `chan config get/set` + `PATCH /api/config` + Settings | optional dormant custom payload; accepts `#rgb` or `#rrggbb` and persists lowercase `#rrggbb` |
| `terminal_colors.custom.foreground` | `String` | `chan config get/set` + `PATCH /api/config` + Settings | custom terminal foreground, validated with the complete object |
| `terminal_colors.custom.cursor` | `String` | `chan config get/set` + `PATCH /api/config` + Settings | custom terminal cursor, validated with the complete object |
| `terminal_colors.custom.contrast` | `TerminalContrast` | `chan config get/set` + `PATCH /api/config` + Settings | `auto`, `dark`, or `light`; auto chooses the existing ANSI palette and chrome from WCAG background luminance at the fixed `0.179` threshold |
| `theme` | `ThemeChoice` | `chan config get/set` + `PATCH /api/config` | Settings → Global |
| `pane_widths.inspector` | `u32` | `chan config get/set` + drag-resize | resize handle persistence |
| `pane_widths.graph` | `u32` | `chan config get/set` + drag-resize | same |
| `pane_widths.browser` | `u32` | `chan config get/set` + drag-resize | same |
| `pane_widths.search` | `u32` | `chan config get/set` + drag-resize | same |
| `pane_widths.outline` | `u32` | `chan config get/set` + drag-resize | same |
| `browser_side_panes.left` | `bool` | `chan config get/set` + FB toggle | left side-pane visibility |
| `browser_side_panes.right` | `bool` | `chan config get/set` + FB toggle | right side-pane visibility |
| `line_spacing` | `LineSpacing` | `chan config get/set` + Settings | editor line-height |
| `date_format` | `String` | `chan config get/set` + Settings | date rendering across SPA |
| `strip_trailing_whitespace_on_save` | `bool` | `chan config get/set` + Settings | editor save hook |
| `bubble_overlay_mode` | `BubbleOverlayMode` | `chan config get/set` + `PATCH /api/config` + Settings | Settings → Global → watcher bubbles radio; overlay rendering |
| `hybrid_surface_themes.editor` | `Option<SurfaceThemeChoice>` | `chan config get/set` + Settings | optional Hybrid Editor body-theme override (`light` or `dark`) |
| `hybrid_surface_themes.terminal` | `Option<SurfaceThemeChoice>` | `chan config get/set` + Settings | optional Terminal body-theme override |
| `hybrid_surface_themes.browser` | `Option<SurfaceThemeChoice>` | `chan config get/set` + Settings | optional File Browser body-theme override |
| `hybrid_surface_themes.graph` | `Option<SurfaceThemeChoice>` | `chan config get/set` + Settings | optional Graph body-theme override |
| `hybrid_surface_themes.dashboard` | `Option<SurfaceThemeChoice>` | `chan config get/set` + Settings | optional Dashboard body-theme override; legacy `infographics` deserializes to this canonical field |
| `graph_colors.mode` | `GraphColorMode` | `chan config get/set` + `PATCH /api/config` + Settings | `standard` renders the theme graph palette and keeps stored overrides dormant; `custom` applies the per-scheme palettes to the graph surface only |
| `graph_colors.dark.doc` | `String` | `chan config get/set` + `PATCH /api/config` + Settings | optional `--g-doc` override (markdown nodes); accepts `#rgb` or `#rrggbb` and persists lowercase `#rrggbb` |
| `graph_colors.dark.source` | `String` | `chan config get/set` + `PATCH /api/config` + Settings | optional `--g-source` override (source / config nodes) |
| `graph_colors.dark.binary` | `String` | `chan config get/set` + `PATCH /api/config` + Settings | optional `--g-binary` override (opaque-file nodes) |
| `graph_colors.dark.img` | `String` | `chan config get/set` + `PATCH /api/config` + Settings | optional `--g-img` override (media nodes) |
| `graph_colors.dark.folder` | `String` | `chan config get/set` + `PATCH /api/config` + Settings | optional `--g-folder` override (directory nodes) |
| `graph_colors.dark.tag` | `String` | `chan config get/set` + `PATCH /api/config` + Settings | optional `--g-tag` override (hashtag nodes) |
| `graph_colors.dark.language` | `String` | `chan config get/set` + `PATCH /api/config` + Settings | optional `--g-language` override (tokei language nodes) |
| `graph_colors.dark.contact` | `String` | `chan config get/set` + `PATCH /api/config` + Settings | optional `--g-contact` override; covers contact AND mention nodes together (one token, defaults to `--warn-text`) |
| `graph_colors.light.doc` | `String` | `chan config get/set` + `PATCH /api/config` + Settings | same eight optional overrides for the light scheme |
| `graph_colors.light.source` | `String` | `chan config get/set` + `PATCH /api/config` + Settings | same |
| `graph_colors.light.binary` | `String` | `chan config get/set` + `PATCH /api/config` + Settings | same |
| `graph_colors.light.img` | `String` | `chan config get/set` + `PATCH /api/config` + Settings | same |
| `graph_colors.light.folder` | `String` | `chan config get/set` + `PATCH /api/config` + Settings | same |
| `graph_colors.light.tag` | `String` | `chan config get/set` + `PATCH /api/config` + Settings | same |
| `graph_colors.light.language` | `String` | `chan config get/set` + `PATCH /api/config` + Settings | same |
| `graph_colors.light.contact` | `String` | `chan config get/set` + `PATCH /api/config` + Settings | same |
| `empty_pane_carousel_cycling` | `bool` | `chan config get/set` + Settings | empty-pane behavior |
| `page_width_ratio` | `f64` | `chan config get/set` + Settings | editor page-width cap, constrained to `0.25..=1.0` by the CLI |
| `overlay_maximized` | `bool` | `chan config get/set` + overlay control | global overlay-maximize preference |
| `cs_dismissed` | `bool` | `chan config get` (read-only) + cs-link prompt | whether the terminal alias offer was dismissed |
| `shortcuts` | `Map<command-id, {web?,macos?,linux?,windows?}>` | `chan config get` + `PATCH /api/config` | shortcut assignment; keymap override layer (opaque chord strings, sparse); CLI set refuses with the supported edit route |

`editor_font_size` is unset by default. The Settings `Use theme` action clears it, restoring the exact body and source sizes supplied by `editor_theme`. Inline and block code keep the theme's existing `em` ratios. The root override and the document/slide token paths update mounted editor surfaces without a reload.

`terminal_colors` defaults to `mode = "standard"` with no custom payload. First activation snapshots the currently resolved standard background, foreground, and cursor into one custom owner write with `contrast = "auto"`. Returning to standard mode retains that payload without changing `hybrid_surface_themes.terminal`; later custom activation reuses it. Invalid custom fields reject the whole object, so no partial colour update is persisted or broadcast.

`graph_colors` is sparse: an unconfigured library serializes no `[graph_colors]` table at all, and every hue inside a per-scheme palette is independently optional so overriding one hue does not take ownership of the rest. Overrides apply to the graph surface only (the canvas, legend and filter dots); the file tree, kind chips, inspector refs and every other surface keep the theme palette, because the override lands on the graph subtree and never on `:root`. The Settings control commits the whole composite per change, mirroring `terminal_colors`; an invalid hue rejects the whole object. A hand-edited `preferences.toml` carrying a non-hex value drops that one hue back to the theme default on load, per key, rather than painting a stale colour.

```toml
editor_font_size = 20

[terminal_colors]
mode = "custom"

[terminal_colors.custom]
background = "#1c1c1e"
foreground = "#ebebf0"
cursor = "#58a6ff"
contrast = "auto"
```

## chan-workspace

### `~/.chan/config.toml` -- `Registry` (`KnownWorkspace[]`)

Source: `crates/chan-workspace/src/registry.rs`.

Per-workspace entry persisted at registration time:

| Field | Type | Default | Reachability | Consumers |
|-------|------|---------|--------------|-----------|
| `root_path` | `PathBuf` | required | `chan workspace add <path>` | workspace enumeration / open |
| `metadata_key` | `String` | minted on add | (internal identity) | stable storage key under `~/.chan/workspaces/` |
| `created_at` | `DateTime<Utc>` | now() on add | (internal) | registry bookkeeping |
| `last_seen_at` | `DateTime<Utc>` | refreshed on open | `chan workspace ls --json` | recency sort |
| `canonical_path` | transient (`#[serde(skip)]`) | n/a | (internal cache) | symlink-stable comparison |

Workspaces have no persisted display name: the UI titles a workspace by its directory basename.

Global registry fields (not per-workspace), persisted in the same `~/.chan/config.toml`:

| Field | Type | Default | Reachability | Consumers |
|-------|------|---------|--------------|-----------|
| `index_excluded_dirs` | `Vec<String>` | dev-junk + build-output set | hand-edited TOML only | walk filter for index + graph rebuild + (Linux) watch registration |
| `drafts_dir` | `String` | `".Drafts"` | hand-edited TOML only | in-tree Drafts dir name for Cmd+N |

Both `index_excluded_dirs` and `drafts_dir` are hand-edited in the TOML and have no UI surface. The `index_excluded_dirs` default covers VCS dirs, dependency and build-output trees (`node_modules`, `target`, `dist`, `build`, `buck-out`, `.buckos`, `downloads`, `distfiles`, `prebuilt`, `vendor`, `prelude`, ...); names match by basename at any depth, case-insensitive, and on Linux excluded subtrees are not even registered with inotify. chan now honors `.gitignore` (nested, anchored, and negation patterns) as the base exclusion layer beneath `index_excluded_dirs`, unified in one `IndexScopePolicy` across walk, index, report, and the Linux watch registration. A config whose list matches the pre-v0.76.0 default exactly is upgraded to the current default on open; any customized list (including an empty one) is left alone. `drafts_dir` names a real hidden directory at the workspace root (default `.Drafts/`) that holds Cmd+N scratch work as `<name>/draft.md` plus companions. It is created lazily on the first Cmd+N, so an untouched workspace has no such directory. Because it lives in-tree it participates in search, graph, and watch through the normal machinery; add `.Drafts/` to a `.gitignore` to keep drafts out of SCM.

### `<state_dir>/index/<uuid>/config.toml` -- `IndexConfig`

Source: `crates/chan-workspace/src/index/config.rs`.

| Field | Type | Default | Reachability | Consumers |
|-------|------|---------|--------------|-----------|
| `schema_version` | `u32` | `SCHEMA_VERSION` const | (internal) | version-mismatch wipe gate |
| `model` | `String` | `BAAI/bge-small-en-v1.5` | `chan workspace index download-model --model` | embedder resolver |
| `chunking` | `Chunking` enum | `Headings` | (internal; no user surface yet) | indexer chunking strategy |
| `vectors_model` | `Option<String>` | `None` | (internal stamp) | mismatch-wipe trigger on `Index::open` |
| `vectors_dim` | `Option<u32>` | `None` | (internal stamp) | build-time defensive cross-check |
| `excluded_dirs` | `Vec<String>` | `[]` | `GET`/`PUT /api/index/excluded-dirs` | per-workspace additions to the global walk blocklist (exact basenames, any depth, case-insensitive) |

### `<state_dir>/workspaces/<metadata_key>/dashboard.toml` -- `DashboardConfig`

Source: `crates/chan-workspace/src/dashboard.rs`.

| Field | Type | Default | Reachability | Consumers |
|-------|------|---------|--------------|-----------|
| `semantic_enabled` | `bool` | `false` | `chan workspace index enable-semantic/disable-semantic --path <workspace>` + Settings | `Workspace::search` Hybrid default mode |
| `reports_enabled` | `bool` | `true` | `chan workspace reports enable/disable --path <workspace> [-y]` + `chan workspace add --reports` | `Workspace::report()` lazy init + `Workspace::boot()` |
| `screensaver_enabled` | `bool` | `false` | `PATCH /api/screensaver/state` + Settings | SPA screensaver overlay arming |
| `screensaver_timeout_secs` | `u32` | `300` | `PATCH /api/screensaver/state` | SPA client-side idle threshold |
| `screensaver_theme` | `ScreensaverTheme` | `plain` | `PATCH /api/screensaver/state` | overlay scene |
| `screensaver_pin_hash` | `Option<Vec<u8>>` | `None` | `POST /api/screensaver/pin` | overlay PIN gate; the wire only ever reports `pin_set: bool` |

### `.Drafts/team-{name}/config.toml` -- `TeamConfig`

Source: `crates/chan-workspace/src/teams.rs`.

| Field | Type | Default | Reachability | Consumers |
|-------|------|---------|--------------|-----------|
| `team_name` | `String` | required | `chan-server /api/teams/{name}/load + .../unload + GET .../loaded` | team identification |
| `host_name` | `String` | required | (set at create time) | UI rendering |
| `host_handle` | `String` | required | (set at create time) | @@-prefix policy |
| `tab_group` | `String` | team name | (set at create time) | terminal tab grouping for the team's members |
| `auto_prefix_at` | `bool` | `true` | (set at create time; future Settings) | bubble overlay @@-auto-prefix |
| `mcp_env` | `bool` | `false` | (set at create time) | whether team-spawned terminals export `CHAN_MCP_*` |
| `created_at` | `String` (ISO 8601) | required | (set at create time) | sort + display |
| `members[]` | `Vec<Member>` | empty | (future Settings) | team roster + position grid |

`Member`: `handle: String`, `command: String`, `env: BTreeMap<String, String>`, `is_lead: bool`, `position: Option<Position>`. The submit agent is derived from a case-insensitive whole-word `claude`, `codex`, `gemini`, `kimi`, or `opencode` in `command`; `env.CHAN_AGENT` overrides it and `none` / `shell` forces shell behavior.

`Position`: `row: u32`, `col: u32` (airplane-grid coordinate). Consumed by both team surfaces: the Team Work dialog carves its split layout from it, and `cs terminal team new|load` passes it through the `team_spawned` push so the SPA carves the same grid (`--tabs` opts out). Validation caps the derived grid at 9 panes.

## chan-desktop

### Desktop `Config`

Paths: `<config>/chan-desktop/config.json` on Linux and `<config>/Chan Desktop/config.json` elsewhere.

Source: `desktop/src-tauri/src/config.rs`.

| Field | Type | Default | Reachability | Consumers |
|-------|------|---------|--------------|-----------|
| `outbound[]` | `Vec<OutboundWorkspace>` | empty | Attach URL panel | explicit non-owned remote URL attachments |
| `outbound[].id` | `String` | generated UUID | Attach URL panel | row actions + outbound window restore key |
| `outbound[].url` | `String` | required | Attach URL panel | token-bearing HTTP(S) URL opened by desktop |
| `outbound[].label` | `String` | `""` | Attach URL panel | optional launcher/window label |
| `outbound[].added_at` | `u64` | current millis | Attach URL panel | diagnostics and future sorting |
| `tunnel.preferred_port` | `u16` | `0` (OS-assigned) | Tunnel listener UI | tunnel listen-bind hint |
| `tunnel.preferred_label` | `String` | `""` | Tunnel listener UI | bearer/label default |
| `tunnel.preferred_workspace` | `String` | `""` | Tunnel listener UI | workspace name default |
| `window_configs[]` | `Vec<WindowConfig>` | empty | (auto on window close) | LRU pop on window open; preserves panes/tabs + URL hash + zoom level |

`WindowConfig`: `key: String`, `window_label: String`, `url_hash: String`, `zoom_level: f64`, `saved_at: u64`.

## Layout pointers

* Per-user config dir: `~/.chan/` on desktop targets; co-located under the data dir on iOS / Android where the home dir isn't user-writable. Holds the global `config.toml` (workspace registry). The state and cache roots resolve to the same `~/.chan/`.
* `CHAN_HOME=/path/to/chan-home` replaces `~/.chan` for the whole process. The override is the chan home directory itself, not a parent. It carries the workspace registry, devserver config, per-workspace metadata, locks, tokens, and the desktop-installed `chan`/`cs` shims under `CHAN_HOME/.local/bin`.

Two Chan processes that share one chan home also share one workspace registry and one per-workspace writer lock. If `chan-desktop` is serving a registered workspace and a foreground `chan devserver` is started from the same `~/.chan`, the devserver launcher lists that workspace as locked rather than off. This is expected: the workspace is open in another Chan process and cannot be turned on by the devserver until the desktop releases it. Run the devserver with a separate `CHAN_HOME` when you want an independent library:

```sh
CHAN_HOME=/tmp/chan-devserver-home \
  ./target/debug/chan devserver --service=none --bind 127.0.0.1 --port 8787
```

Per-workspace metadata lives under `~/.chan/workspaces/<metadata_key>/`, where `metadata_key` is a readable slug of the canonical workspace path plus an 8-hex hash suffix:

* `sessions/` -- session blobs (window/pane layout).
* `index/` -- tantivy search-index segments + `config.toml` (`IndexConfig` above).
* `graph/` -- graph DB (sqlite) + sidecar markers (`rebuild.inprogress`, `rename_log.json`).
* `locks/` -- per-workspace index-writer lockfile.
* `tokens/` -- chan-server bearer token (mode 0600).
* `trash/` -- soft-deleted files (lazy GC).
* `report/report.jsonl` -- chan-report state (lazy, created on reports opt-in).

Drafts are NOT in this metadata tree. They live in-tree under the workspace root in the directory named by `Registry::drafts_dir` (default `.Drafts/`), holding regular drafts (`untitled-N/`) and team workspaces (`team-{name}/`).

See `crates/chan-workspace/src/paths.rs::WorkspacePaths` for the canonical computation.
