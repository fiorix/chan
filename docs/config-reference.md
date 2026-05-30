# Chan Config Reference

Canonical schema for every persisted config in chan, produced as
the deliverable of `systacean-28` (phase-8 config currency audit).

This doc tracks **what gets persisted, where, and who consumes
it**. Per-field rows note serde defaults, the user-facing
surface (CLI subcommand / Settings field / launcher panel),
and any open findings flagged by the audit.

When adding a new persisted field: extend the relevant section
here in the same commit that lands the schema change so this
reference stays in lockstep with the code.

## chan-server

### `~/.chan/server.toml` — `ServerConfig`

Source: `crates/chan-server/src/config.rs`.

| Field | Type | Default | Reachability | Consumers |
|-------|------|---------|--------------|-----------|
| `attachments_dir` | `String` | `"attachments"` | `PATCH /api/server/config` | `/api/attachments` route + SPA upload UI |
| `search.aggression` | `SearchAggression` | `Balanced` | `PATCH /api/server/config` | search route default mode |
| `terminal.idle_timeout_secs` | `u64` | `1800` (30 min) | `PATCH /api/server/config` | terminal registry idle prune |
| `terminal.session_cap` | `usize` | `32` | `PATCH /api/server/config` | terminal registry create-gate |
| `terminal.ring_bytes` | `usize` | `1 << 20` (1 MB) | `PATCH /api/server/config` | terminal ring buffer alloc |
| `terminal.scrollback_mb` | `u32` | `50` (clamped `10..=500`) | `PATCH /api/server/config` | SPA xterm.js scrollback line cap |
| `terminal.default_term` | `String` | `"xterm-256color"` | `PATCH /api/server/config` | PTY spawn `TERM` env |
| `team_work.inbox_depth` | `usize` | `10` (clamped `1..=100`) | `PATCH /api/server/config` + `chan config get/set` | retained Agent tasks per `(team, recipient)` inbox |

Legacy `[reports] enabled = ...` blocks in `server.toml` are ignored
on load and omitted on the next save. Per-workspace
`IndexConfig.reports_enabled` is the only reports toggle source.

### `~/.chan/preferences.toml` — `EditorPrefs`

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
| `empty_pane_carousel_cycling` | `bool` | Settings | empty-pane behavior |

## chan-workspace

### `~/.chan/config.toml` — `Registry` (`KnownWorkspace[]`)

Source: `crates/chan-workspace/src/registry.rs`.

Per-workspace entry persisted at registration time:

| Field | Type | Default | Reachability | Consumers |
|-------|------|---------|--------------|-----------|
| `path` | `PathBuf` | required | `chan add <path>` | workspace enumeration / open |
| `uuid` | `String` (16 hex) | minted on add | (internal identity) | per-workspace sidecar keying |
| `name` | `Option<String>` | basename | `chan add --name` / `chan rename` | window title + UI |
| `last_opened` | `DateTime<Utc>` | now() | `chan list` | recency sort |
| `canonical_path` | transient (`#[serde(skip)]`) | n/a | (internal cache) | symlink-stable comparison |

### `<state_dir>/index/<uuid>/config.toml` — `IndexConfig`

Source: `crates/chan-workspace/src/index/config.rs`.

| Field | Type | Default | Reachability | Consumers |
|-------|------|---------|--------------|-----------|
| `schema_version` | `u32` | `SCHEMA_VERSION` const | (internal) | version-mismatch wipe gate |
| `model` | `String` | `BAAI/bge-small-en-v1.5` | `chan index download-model --model` | embedder resolver |
| `chunking` | `Chunking` enum | `Headings` | (internal; no user surface yet) | indexer chunking strategy |
| `vectors_model` | `Option<String>` | `None` | (internal stamp) | mismatch-wipe trigger on `Index::open` |
| `vectors_dim` | `Option<u32>` | `None` | (internal stamp) | build-time defensive cross-check |
| `semantic_enabled` | `bool` | `false` | `chan index enable-semantic/disable-semantic --path <workspace>` + Settings (`fullstack-a-21`) | `Workspace::search` Hybrid default mode |
| `reports_enabled` | `bool` | `false` | `chan reports enable/disable --path <workspace> [-y]` + `chan add --reports` | `Workspace::report()` lazy init + `Workspace::boot()` |

### `Drafts/team-{name}/config.toml` — `TeamConfig`

Source: `crates/chan-workspace/src/teams.rs` (post-`systacean-30`).

| Field | Type | Default | Reachability | Consumers |
|-------|------|---------|--------------|-----------|
| `team_name` | `String` | required | `chan-server /api/teams/{name}/load + .../unload + GET .../loaded` (`systacean-31`) | team identification |
| `host_name` | `String` | required | (set at create time) | UI rendering |
| `host_handle` | `String` | required | (set at create time) | @@-prefix policy |
| `auto_prefix_at` | `bool` | `false` | legacy field; new saves force `false` | ignored for routing; canonical `@@Name` handles are required |
| `created_at` | `String` (ISO 8601) | required | (set at create time) | sort + display |
| `members[]` | `Vec<Member>` | empty | (future Settings) | team roster + position grid |

`Member`: `handle: String`, `command: String`, `env: BTreeMap<String, String>`, `is_lead: bool`, `position: Option<Position>`.
For Team Work bootstrap, `env` is rewritten with system-owned
`CHAN_TEAM_NAME` and canonical `CHAN_TAB_NAME`; these keys are not exposed as
custom member environment values in the dialog.

`Position`: `row: u32`, `col: u32` (airplane-grid coordinate).

## chan-desktop

### Desktop `Config`

Paths: `<config>/chan-desktop/config.json` on Linux and
`<config>/Chan Desktop/config.json` elsewhere.

Source: `desktop/src-tauri/src/config.rs`.

| Field | Type | Default | Reachability | Consumers |
|-------|------|---------|--------------|-----------|
| `workspaces` | `HashMap<String, WorkspaceSettings>` | empty | launcher feature panel cache | per-local-workspace desktop cache keyed by canonical path |
| `workspaces.{path}.features.bge` | `bool` | `false` | Launcher row expand panel | Mirror of chan-workspace's `IndexConfig.semantic_enabled`; refreshed on read through CLI when available |
| `workspaces.{path}.features.reports` | `bool` | `false` | Launcher row expand panel | Mirror of chan-workspace's `IndexConfig.reports_enabled`; refreshed on read through CLI when available |
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

## Open findings (systacean-28)

| # | Finding | Recommended action | Owner | Priority |
|---|---------|---------------------|-------|----------|
| 1 | `WorkspaceFeatures` mirror in chan-desktop config can drift when users bypass chan-desktop's UI for feature toggles (e.g. `chan index enable-semantic` from terminal). | Keep the current refresh-on-read path or replace the mirror with a direct chan-workspace config API. | chan-desktop + chan-workspace | Low (corner case for power users) |

The removed `ServerConfig.reports.enabled` finding is closed in
Track A. The SPA reports toggle now uses
`/api/index/reports/{state,enable,disable}`.

## Layout pointers

* Per-user config dir: `~/.chan/` (desktop) or `state_dir/` (iOS / Android).
* Per-user state dir: `XDG_DATA_HOME/chan/` (Linux) / `~/Library/Application Support/chan/` (macOS).
* Per-user cache dir: `XDG_CACHE_HOME/chan/` / `~/Library/Caches/chan/`.

Per-workspace subpaths key by `KnownWorkspace.uuid` (16 hex chars), assigned at registration:

* `state_dir/sessions/<uuid>/` — session blobs (window/pane layout).
* `state_dir/graph/<uuid>/` — graph DB + sidecar markers.
* `state_dir/locks/<uuid>/` — per-workspace index-writer lockfile.
* `state_dir/tokens/<uuid>/` — chan-server bearer token (mode 0600).
* `state_dir/trash/<uuid>/` — soft-deleted files (lazy GC).
* `state_dir/report/<uuid>/report.jsonl` — chan-report state (lazy on opt-in post-`systacean-27`).
* `state_dir/drafts/<uuid>/` — Drafts metadata (post-`systacean-24`). Contains regular drafts (`untitled-N/`) + team workspaces (`team-{name}/`).
* `cache_dir/index/<uuid>/` — tantivy search-index segments + `config.toml`.

See `crates/chan-workspace/src/paths.rs::WorkspacePaths` for the canonical computation.
