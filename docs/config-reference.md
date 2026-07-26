# Chan Config Reference

Canonical schema for every persisted config in chan.

This doc tracks **what gets persisted, where, and who consumes it**. Per-field rows note serde defaults, the user-facing surface (CLI subcommand / Settings field / launcher panel), and any open findings.

When adding a new persisted field: extend the relevant section here in the same commit that lands the schema change so this reference stays in lockstep with the code.

## chan-server

### `~/.chan/server.toml` -- `ServerConfig`

Source: `crates/chan-server/src/config.rs`.

| Field | Type | Default | Reachability | Consumers |
|-------|------|---------|--------------|-----------|
| `attachments_dir` | `String` | `"attachments"` | `PATCH /api/config` | `/api/attachments` route + SPA upload UI |
| `search.aggression` | `SearchAggression` | `Balanced` | `PATCH /api/config` | search route default mode |
| `terminal.idle_timeout_secs` | `u64` | `1800` (30 min) | `PATCH /api/config` | terminal registry idle prune |
| `terminal.session_cap` | `usize` | `32` | `PATCH /api/config` | terminal registry create-gate |
| `terminal.ring_bytes` | `usize` | `2 << 20` (2 MB) | `PATCH /api/config` | terminal ring buffer alloc |
| `terminal.scrollback_mb` | `u32` | `10` (clamped `10..=50`) | `PATCH /api/config` | SPA xterm.js scrollback line cap |
| `terminal.default_term` | `String` | `"xterm-256color"` | `PATCH /api/config` | PTY spawn `TERM` env |
| `terminal.font` | `TerminalFontChoice` | `os-default` | `PATCH /api/config` + Settings | xterm.js fontFamily chain; `source-code-pro` opts into the bundled font (download flow on non-embed builds) |
| `terminal.mcp_env` | `bool` | `false` | `PATCH /api/config` + Settings | whether new non-team terminals export `CHAN_MCP_*`; per-request `?mcp_env=on` overrides, team spawns use the team config's own `mcp_env` |
| `terminal.mouse_capture` | `bool` | `true` | `PATCH /api/config` + Settings | whether full-screen TUIs may capture the mouse; off strips the DECSET mouse-enable sequences in the SPA so click-drag selection keeps working (new terminals only) |
| `terminal.ghostty` | `bool` | `false` | `PATCH /api/config` + Settings | experimental: new terminals use the ghostty-web backend (Ghostty's WASM VT parser, ~420 KB fetched on first enable) instead of xterm.js |

`GET /api/config` returns the editor and server preference aggregate with a revision. `PATCH /api/config` accepts one owner-specific partial preferences object plus `expected_revision`; stale revisions return `409 config_conflict` with the current aggregate.

### `~/.chan/submit.toml` -- agent submit templates

Source: `crates/chan-server/src/submit_config.rs` and `crates/chan-shell/src/submit.rs`.

Each optional agent table has one `template` string containing at most one `{}` placeholder for the trailing-newline-trimmed prompt body. A template without `{}` is appended as a suffix. Escapes include `\e`, `\xHH`, `\r`, `\n`, `\t`, `\0`, and `\\`. Resolution is `CHAN_SUBMIT_<AGENT>` environment variable, then this file, then the built-in default.

```toml
[claude]
template = '{}\e[27;9;13~'

[codex]
template = '\e[200~{}\e[201~\r'

[gemini]
template = '{}\r'

[opencode]
template = '\e[200~{}\e[201~\r'
```

The environment equivalents are `CHAN_SUBMIT_CLAUDE`, `CHAN_SUBMIT_CODEX`, `CHAN_SUBMIT_GEMINI`, and `CHAN_SUBMIT_OPENCODE`. Gemini alone splits its resolved body and submit chord into two ordered PTY writes; overriding its template does not change that write-splitting contract.

### `~/.chan/preferences.toml` -- `EditorPrefs`

Source: `crates/chan-server/src/preferences.rs`.

| Field | Type | Reachability | Consumers |
|-------|------|--------------|-----------|
| `editor_theme` | `EditorTheme` | `PATCH /api/config` | Settings → Editor → theme selector |
| `theme` | `ThemeChoice` | `PATCH /api/config` | Settings → Appearance |
| `pane_widths.inspector` | `u32` | drag-resize | resize handle persistence |
| `pane_widths.graph` | `u32` | drag-resize | same |
| `pane_widths.browser` | `u32` | drag-resize | same |
| `pane_widths.search` | `u32` | drag-resize | same |
| `pane_widths.outline` | `u32` | drag-resize | same |
| `browser_side_panes.left` | `bool` | FB toggle | left side-pane visibility |
| `browser_side_panes.right` | `bool` | FB toggle | right side-pane visibility |
| `line_spacing` | `LineSpacing` | Settings | editor line-height |
| `date_format` | `String` | Settings | date rendering across SPA |
| `strip_trailing_whitespace_on_save` | `bool` | Settings | editor save hook |
| `bubble_overlay_mode` | `BubbleOverlayMode` | Bubble menu | overlay rendering |
| `hybrid_surface_themes` | `HybridSurfaceThemes` | Settings | per-surface Hybrid Nav theming |
| `empty_pane_carousel_cycling` | `bool` | Settings | empty-pane behavior |
| `shortcuts` | `Map<command-id, {web?,macos?,linux?,windows?}>` | `PATCH /api/config` | shortcut assignment; keymap override layer (opaque chord strings, sparse) |

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

`Member`: `handle: String`, `command: String`, `env: BTreeMap<String, String>`, `is_lead: bool`, `position: Option<Position>`. The submit agent is derived from a case-insensitive whole-word `claude`, `codex`, `gemini`, or `opencode` in `command`; `env.CHAN_AGENT` overrides it and `none` / `shell` forces shell behavior.

`Position`: `row: u32`, `col: u32` (airplane-grid coordinate).

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
