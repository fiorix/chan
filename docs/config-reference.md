# chan configuration reference

Every persisted configuration file chan writes, where it lives, what each field means, and which surface sets it. The tables are the schema; the code they describe is named at the top of each section. A schema change updates the matching row in the same commit.

In the Reachability columns, CLI means `chan config get/set`, API means `PATCH /api/config`, and Settings means the Settings overlay in the workspace app. The surface column names the Settings section a field lives in, or says why it is not surfaced; the workspace app's settings inventory test reads those cells.

## chan-server

### `~/.chan/server.toml`: `ServerConfig`

Source: `crates/chan-server/src/config.rs`, with `TerminalConfig` in `crates/chan-library/src/config.rs`.

The CLI serializes these under the `server.*` namespace, so terminal fields are `server.terminal.*`; `chan config get` and `chan config set` also accept `terminal.*` as a shorthand. The HTTP aggregate keeps the owner-relative `terminal.*` spelling. `chan config set KEY none` clears an optional key. List fields take a JSON string array on CLI set.

| Field | Type | Default | Reachability | Surface and use |
|-------|------|---------|--------------|-----------------|
| `search.aggression` | `SearchAggression` | `Balanced` | CLI, API, Settings | Settings → Search → indexing profile; the search route's default mode |
| `terminal.idle_timeout_secs` | `u64` | `1800` | CLI, API | Not surfaced in Settings; idle prune of terminal sessions, zero selects the default |
| `terminal.session_cap` | `usize` | `32` | CLI, API | Not surfaced in Settings; the terminal registry's create gate |
| `terminal.ring_bytes` | `usize` | `2 << 20` | CLI, API | Not surfaced in Settings; the server-side scrollback ring per session |
| `terminal.scrollback_mb` | `u32` | `10`, clamped `10..=50` | CLI, API, Settings | Settings → Terminal → scrollback; the renderer's scrollback line cap |
| `terminal.default_term` | `String` | `xterm-256color` | CLI, API, Settings | Settings → Terminal → TERM; the `TERM` a PTY spawns with |
| `terminal.font` | `TerminalFontChoice` | `os-default` | CLI, API, Settings | Settings → Terminal → font; `source-code-pro` opts into the bundled font |
| `terminal.font_size` | `u32` | `14`, clamped `8..=32` | CLI, API, Settings | Settings → Terminal → font size; read when a terminal renderer is constructed |
| `terminal.background_opacity` | `u32` | `100`, clamped `80..=100` | CLI, API, Settings | Settings → Terminal → background opacity; below 100 chan-desktop paints every terminal tab at this alpha so the desktop shows through. The desktop's own `server.toml` decides for desktop windows and a change applies live; a browser tab stays opaque; Linux needs a compositing window manager |
| `terminal.mcp_env` | `bool` | `false` | CLI, API, Settings | Settings → Terminal → MCP discovery; whether new non-team terminals export `CHAN_MCP_*` (team spawns follow the team config's own `mcp_env`) |
| `terminal.mouse_capture` | `bool` | `true` | CLI, API, Settings | Settings → Terminal → mouse capture; off strips the mouse-enable sequences so drag selection keeps working in full-screen programs, for new terminals |
| `terminal.ghostty` | `bool` | `true` | CLI, API, Settings | Settings → Terminal → ghostty backend; `false` renders with xterm.js instead, new terminals at once and open ones when their window reloads |
| `terminal.secret_masking` | `Option<bool>` | unset | CLI, API, Settings | Settings → Terminal → secret masking; unset masks by window kind (on in a control terminal, off elsewhere), `true` or `false` is the user's choice everywhere. The per-tab toggle is ephemeral |
| `terminal.program_status` | `bool` | `true` | CLI, API, Settings | Settings → Terminal → Program status (OSC 7501); whether chan reads the reports programs write, keeps their records and marks its own waits; off clears live records |
| `terminal.tmux.enabled` | `bool` | `false` | CLI, API, Settings | Settings → Terminal → tmux control mode; whether a terminal honours the marker a `tmux -CC` client prints. A local tmux enters at once; any other foreground program raises a question first |
| `terminal.tmux.trust` | `Vec<String>` | empty | CLI, API | Not surfaced in Settings; foreground program names (`ssh`, `mosh`) that enter control mode without the question, matched against the PTY's foreground job |
| `terminal.profiles` | `Vec<TerminalProfile>` | empty | CLI get, API | Not surfaced in Settings: profiles are authored by hand (see below) and the pane's shell picker consumes the merged list |
| `terminal.default_profile` | `Option<String>` | unset | CLI, API | Not surfaced in Settings; id of the profile new terminals spawn with. Unset keeps the built-in resolution (`CHAN_SHELL`, then pwsh, powershell, cmd on Windows; `$SHELL` on Unix); an unknown id is ignored with a warning |
| `terminal.secret_mask_suffixes` | `Vec<String>` | stock list | CLI, API | Read-only display in Settings → Terminal; case-insensitive suffixes of `NAME=value` output whose values the terminal masks, launch-URL tokens included |
| `transfer.stall_timeout_secs` | `u64` | `300` | CLI | Not surfaced in Settings (file-only `[transfer]` table); the longest time without progress a file transfer tolerates, zero selects the default |
| `tunnel.max_live` | `usize` | `32` | CLI | Not surfaced in Settings (file-only `[tunnel]` table); live `cs tunnel` tunnels a devserver admits across every terminal, zero selects the default |

`attachments_dir` is a retired key: a value in the file has no effect, the next save drops it, and the CLI and the API reject it.

#### Authoring terminal profiles

On Windows the server discovers the installed shells (Windows PowerShell, PowerShell 7, cmd, Git BASH and every WSL distribution), so most Windows machines need no `[[terminal.profiles]]` at all; macOS and Linux discover nothing, so a declared entry there is the whole list. Entries override, hide, or add to the discovered list and match a discovered profile by `id`:

```toml
[terminal]
default_profile = "git-bash"          # id; unset keeps the built-in resolution

[[terminal.profiles]]                 # rename a discovered profile
id = "wsl:Ubuntu"
name = "Ubuntu 24.04"

[[terminal.profiles]]                 # hide one you never use
id = "cmd"
hidden = true

[[terminal.profiles]]                 # add a shell discovery does not find
id = "nushell"
name = "Nushell"
program = "C:\\Users\\me\\AppData\\Local\\Programs\\nu\\nu.exe"
kind = "posix"
```

`kind` is `powershell`, `cmd`, `posix`, or `wsl` and decides the argument convention; omitted, it is inferred from the program's file stem. `wsl` is its own kind because `-l` to `wsl.exe` lists distributions rather than starting a login shell. `args` replaces the discovered vector rather than appending, since appending could not express "spawn PowerShell without `-NoLogo`". An entry matching no discovered id and naming no `program` is dropped with a warning, as are malformed entries; a bad entry costs that profile, never the rest of the file.

`GET /api/config` returns the editor and server preference aggregate with a revision, and `PATCH /api/config` takes one owner-specific partial object plus the revision it was read at; a stale revision is refused with the current aggregate.

### `~/.chan/extensions/<id>.toml`: local extensions

Source: `crates/chan-server/src/extensions.rs`; the design and the authoring guide are in [extensions.md](extensions.md).

Each regular `.toml` file declares one local subprocess. The lowercase file stem is its stable extension id and must match `[a-z0-9][a-z0-9_-]{0,63}`. Files are read in lexical order. Malformed files, unknown fields, invalid ids, oversized files, spawn failures, and failed handshakes warn and are ignored without failing chan's startup. Display names may collide because command and tab identity use the id.

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `name` | `String` | required | Launcher row and tab title, 1 to 128 characters after trimming |
| `command` | `String` | required | Executable to spawn; a bare name resolves through the serving process's `PATH` (for a service-run devserver, the one its unit or plist records; see [the environment](extensions.md#the-environment)), and `./name` resolves from the extension config directory |
| `args` | `String[]` | `[]` | Arguments passed verbatim after `command` |
| `capabilities` | `String[]` | `[]` | Host grants: `session-context` and/or `presentation`; an unknown value rejects the declaration |

```toml
name = "Echo test"
command = "/absolute/path/to/chan/target/debug/examples/echo-extension"
args = []
capabilities = []
```

The subprocess starts with the config directory as its working directory, inherits chan's environment with no shell in between, gets null stdin, and owns its stderr. It must print a newline-terminated handshake within a few seconds and a bounded number of stdout lines:

```text
CHAN_EXTENSION_V1={"url":"http://127.0.0.1:49152/","token":"unguessable-secret","singleton":true,"commands":[{"id":"run","title":"Run"}]}
```

The URL must use plain HTTP on exactly `127.0.0.1` or `localhost`; IPv6, remote hosts, userinfo, port zero, HTTPS, and a pre-existing `t` query parameter are rejected. `singleton` and `commands` are optional; each command declares a lowercase-hyphen local `id`, a title, and a short list of keywords, and registers under Apps as `extension.<id>.<command-id>`.

Proxy hygiene, for reference: the proxy strips browser credential headers on the upstream leg (`Authorization`, cookies, `Origin`, `Referer`, forwarding headers, `X-Chan-*`) and upstream cookies on the response, adds a no-store and no-referrer response policy, stamps every upstream request with `X-Chan-Extension-Scope` equal to the serving instance id (a tenant discriminator, not a secret), applies a per-direction idle timeout to proxied bodies with no total deadline and no size cap, and strips `Location` headers that target loopback rather than reflecting them. Persisted and cross-window tab state carries the extension id and title only, never the capability path, the upstream address, or the token.

### `~/.chan/submit.toml`: agent submit templates

Source: `crates/chan-server/src/submit_config.rs` and `crates/chan-shell/src/submit.rs`.

Each optional agent table has one `template` string containing at most one `{}` placeholder for the normalized prompt body: trailing newlines are removed, then one newline is appended when the body is non-empty. An empty body stays chord-only. A template without `{}` is appended as a suffix after the normalized body. Escapes are `\e`, `\xHH`, `\r`, `\n`, `\t`, `\0`, and `\\`. Resolution order is the `CHAN_SUBMIT_<AGENT>` environment variable, then this file, then the built-in default.

```toml
[agy]
template = '\e[200~{}\e[201~\r'

[claude]
template = '{}\e[27;9;13~'

[codex]
template = '\e[200~{}\e[201~\r'

[gemini]
template = '{}\r'

[kimi]
template = '\e[200~{}\e[201~\r'

[muse]
template = '{}\r'

[opencode]
template = '\e[200~{}\e[201~\r'
```

The environment equivalents are `CHAN_SUBMIT_AGY`, `CHAN_SUBMIT_CLAUDE`, `CHAN_SUBMIT_CODEX`, `CHAN_SUBMIT_GEMINI`, `CHAN_SUBMIT_KIMI`, `CHAN_SUBMIT_MUSE`, and `CHAN_SUBMIT_OPENCODE`. gemini and muse split their normalized body and submit chord into two ordered PTY writes; overriding either template does not change that.

### `~/.chan/preferences.toml`: `EditorPrefs`

Source: `crates/chan-server/src/preferences.rs`.

The CLI prefixes every leaf below with `editor.`. Every scalar leaf is reachable through `chan config get/set`, optional leaves included; `none` clears `editor_font_size` and the five Hybrid surface overrides. `shortcuts` is the one collection the CLI only reads; edit it through Settings or `PATCH /api/config`.

| Field | Type | Reachability | Surface and use |
|-------|------|--------------|-----------------|
| `editor_theme` | `EditorTheme` | CLI, API | Settings → Editor → theme |
| `editor_font_size` | `Option<u32>` | CLI, API, Settings | Settings → Editor → font size; absolute editor body size, clamped `10..=32`; unset uses the active theme's sizes |
| `terminal_colors.mode` | `TerminalColorMode` | CLI, API, Settings | Settings → Terminal → custom terminal colours; `standard` follows the terminal surface's theme choice, `custom` activates the custom payload |
| `terminal_colors.custom.background` | `String` | CLI, API, Settings | Settings → Terminal → custom terminal colours; `#rgb` or `#rrggbb`, persisted as lowercase `#rrggbb` |
| `terminal_colors.custom.foreground` | `String` | CLI, API, Settings | Settings → Terminal → custom terminal colours; validated with the whole object |
| `terminal_colors.custom.cursor` | `String` | CLI, API, Settings | Settings → Terminal → custom terminal colours; validated with the whole object |
| `terminal_colors.custom.contrast` | `TerminalContrast` | CLI, API, Settings | Settings → Terminal → ANSI contrast; `auto`, `dark`, or `light`; auto picks the palette from the background's WCAG luminance |
| `theme` | `ThemeChoice` | CLI, API | Settings → Global → theme |
| `pane_widths.inspector` | `u32` | CLI, drag-resize | Not surfaced in Settings (drag-owned geometry); resize handle persistence |
| `pane_widths.graph` | `u32` | CLI, drag-resize | Not surfaced in Settings (drag-owned geometry); resize handle persistence |
| `pane_widths.browser` | `u32` | CLI, drag-resize | Not surfaced in Settings (drag-owned geometry); resize handle persistence |
| `pane_widths.search` | `u32` | CLI, drag-resize | Not surfaced in Settings (drag-owned geometry); resize handle persistence |
| `pane_widths.outline` | `u32` | CLI, drag-resize | Not surfaced in Settings (drag-owned geometry); resize handle persistence |
| `browser_side_panes.left` | `bool` | CLI, file browser toggle, Settings | Settings → File browser → side panes; left pane visibility |
| `browser_side_panes.right` | `bool` | CLI, file browser toggle, Settings | Settings → File browser → side panes; right pane visibility |
| `line_spacing` | `LineSpacing` | CLI, Settings | Settings → Editor → line spacing; editor line height |
| `date_format` | `String` | CLI, Settings | Settings → Editor → date format; date rendering across the app |
| `strip_trailing_whitespace_on_save` | `bool` | CLI, Settings | Settings → Editor → strip on save; editor save hook |
| `bubble_overlay_mode` | `BubbleOverlayMode` | CLI, API, Settings | Settings → Global → watcher bubbles; overlay rendering |
| `hybrid_surface_themes.editor` | `Option<SurfaceThemeChoice>` | CLI, Settings | Settings → Editor → body theme; optional `light` or `dark` override for the Hybrid theme |
| `hybrid_surface_themes.terminal` | `Option<SurfaceThemeChoice>` | CLI, Settings | Settings → Terminal → body theme; optional override |
| `hybrid_surface_themes.browser` | `Option<SurfaceThemeChoice>` | CLI, Settings | Settings → File browser → body theme; optional override |
| `hybrid_surface_themes.graph` | `Option<SurfaceThemeChoice>` | CLI, Settings | Settings → Graph → body theme; optional override |
| `hybrid_surface_themes.dashboard` | `Option<SurfaceThemeChoice>` | CLI, Settings | Settings → Dashboard → body theme; optional override; the on-disk spelling `infographics` loads as this field |
| `graph_colors.mode` | `GraphColorMode` | CLI, API, Settings | Settings → Graph → custom graph colours; `standard` keeps stored overrides dormant, `custom` applies the per-scheme palettes to the graph surface only |
| `graph_colors.dark.doc` | `String` | CLI, API, Settings | Settings → Graph → custom graph colours; optional `--g-doc` override (markdown nodes); `#rgb` or `#rrggbb`, persisted lowercase |
| `graph_colors.dark.source` | `String` | CLI, API, Settings | Settings → Graph → custom graph colours; optional `--g-source` override (source and config nodes) |
| `graph_colors.dark.binary` | `String` | CLI, API, Settings | Settings → Graph → custom graph colours; optional `--g-binary` override (opaque-file nodes) |
| `graph_colors.dark.img` | `String` | CLI, API, Settings | Settings → Graph → custom graph colours; optional `--g-img` override (media nodes) |
| `graph_colors.dark.folder` | `String` | CLI, API, Settings | Settings → Graph → custom graph colours; optional `--g-folder` override (directory nodes) |
| `graph_colors.dark.tag` | `String` | CLI, API, Settings | Settings → Graph → custom graph colours; optional `--g-tag` override (hashtag nodes) |
| `graph_colors.dark.language` | `String` | CLI, API, Settings | Settings → Graph → custom graph colours; optional `--g-language` override (language nodes) |
| `graph_colors.dark.contact` | `String` | CLI, API, Settings | Settings → Graph → custom graph colours; optional `--g-contact` override, covering contact and mention nodes together |
| `graph_colors.light.doc` | `String` | CLI, API, Settings | Settings → Graph → custom graph colours; the same eight optional overrides for the light scheme |
| `graph_colors.light.source` | `String` | CLI, API, Settings | Settings → Graph → custom graph colours; light-scheme override |
| `graph_colors.light.binary` | `String` | CLI, API, Settings | Settings → Graph → custom graph colours; light-scheme override |
| `graph_colors.light.img` | `String` | CLI, API, Settings | Settings → Graph → custom graph colours; light-scheme override |
| `graph_colors.light.folder` | `String` | CLI, API, Settings | Settings → Graph → custom graph colours; light-scheme override |
| `graph_colors.light.tag` | `String` | CLI, API, Settings | Settings → Graph → custom graph colours; light-scheme override |
| `graph_colors.light.language` | `String` | CLI, API, Settings | Settings → Graph → custom graph colours; light-scheme override |
| `graph_colors.light.contact` | `String` | CLI, API, Settings | Settings → Graph → custom graph colours; light-scheme override |
| `empty_pane_carousel_cycling` | `bool` | CLI, Settings | Settings → Global → empty-pane carousel |
| `page_width_ratio` | `f64` | CLI, Settings | Settings → Editor → page width; editor page-width cap, `0.25..=1.0` |
| `overlay_maximized` | `bool` | CLI, overlay control | Not surfaced as a Settings row (the overlay header's maximize button is its control); global overlay-maximize preference |
| `shortcuts` | `Map<command-id, {web?,macos?,linux?,windows?}>` | CLI get, API | Settings → Keyboard Shortcuts → assignment grid; sparse keymap override layer of opaque chord strings |

`editor_font_size` is unset by default; the Settings `Use theme` action clears it, restoring the body and source sizes the theme supplies.

`terminal_colors` defaults to `mode = "standard"` with no custom payload. First activation snapshots the resolved standard background, foreground, and cursor into one custom payload with `contrast = "auto"`; returning to standard keeps that payload for the next activation. Invalid custom fields reject the whole object, so no partial colour update is persisted or broadcast.

`graph_colors` is sparse: an unconfigured library serializes no `[graph_colors]` table, and every hue in a per-scheme palette is independently optional. Overrides apply to the graph surface only (canvas, legend and filter dots), never to `:root`. An invalid hue rejects the whole object through Settings; a hand-edited non-hex value falls back to the theme default for that one hue on load.

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

### `~/.chan/config.toml`: `Registry`

Source: `crates/chan-workspace/src/registry.rs`.

Per-workspace entry, persisted at registration time:

| Field | Type | Default | Reachability | Use |
|-------|------|---------|--------------|-----|
| `root_path` | `PathBuf` | required | `chan workspace add <path>` | the user-content boundary; enumeration and open |
| `metadata_key` | `String` | minted on add | internal | stable storage key under `~/.chan/workspaces/` |
| `created_at` | `DateTime<Utc>` | now on add | internal | registry bookkeeping |
| `last_seen_at` | `DateTime<Utc>` | refreshed on open | `chan workspace ls --json` | recency sort |
| `display_name` | `Option<String>` | unset | the launcher's Display name field at add time | a label the UI prefers over the `root_path` basename; omitted from the file when unset |
| `canonical_path` | transient | n/a | internal cache, never written | symlink-stable comparison |

Global fields in the same file:

| Field | Type | Default | Reachability | Use |
|-------|------|---------|--------------|-----|
| `index_excluded_dirs` | `Vec<String>` | VCS, dependency and build-output names | hand-edited TOML; shown read-only in Settings → This workspace → Excluded directories | walk filter for the index, the graph rebuild and (on Linux) the watch registration; matched by basename at any depth, case-insensitive |
| `transfer.max_bytes` | `u64` | 10 GiB, at most 100 GiB | hand-edited TOML | the bound on one file transfer; loaded once per library, so a running process keeps its value until restart |

`.git` and `.chan` are always skipped regardless of the list. `.gitignore` (nested, anchored and negation patterns) is the base exclusion layer beneath `index_excluded_dirs`, unified in one `IndexScopePolicy` across walk, index, report, and the Linux watch registration. A list that still equals the previous stock default is upgraded to the current default on open; any customized list, an empty one included, is left alone. The Settings control in the This workspace section edits the per-workspace `excluded_dirs` additions (`IndexConfig` below) and shows `index_excluded_dirs` as the read-only baseline.

Workspace drafts live in the per-workspace metadata sidecar under `Drafts/`, with discarded drafts under its sibling `drafts-trash/`; both are created lazily, and an in-root `.Drafts/` or `Drafts/` is ordinary user content. The standalone terminal window's draft store is per library: `~/.chan/Drafts` on a desktop host, `~/.chan/devserver/Drafts` on a devserver. `drafts_dir` is a retired key with the same handling as `attachments_dir` above.

### `<state_dir>/index/<uuid>/config.toml`: `IndexConfig`

Source: `crates/chan-workspace/src/index/config.rs`.

| Field | Type | Default | Reachability | Use |
|-------|------|---------|--------------|-----|
| `schema_version` | `u32` | `SCHEMA_VERSION` | internal | a mismatch wipes and rebuilds the index |
| `model` | `String` | `BAAI/bge-small-en-v1.5` | `chan workspace index download-model --model` | embedder selection |
| `chunking` | `Chunking` | `Headings` | internal | indexer chunking strategy |
| `vectors_model` | `Option<String>` | unset | internal stamp | mismatch wipe on `Index::open` |
| `vectors_dim` | `Option<u32>` | unset | internal stamp | build-time cross-check |
| `excluded_dirs` | `Vec<String>` | `[]` | `GET`/`PUT /api/index/excluded-dirs`, Settings | per-workspace additions to the global exclusion list (exact basenames, any depth, case-insensitive) |

### `<state_dir>/workspaces/<metadata_key>/dashboard.toml`: `DashboardConfig`

Source: `crates/chan-workspace/src/dashboard.rs`.

| Field | Type | Default | Reachability | Use |
|-------|------|---------|--------------|-----|
| `semantic_enabled` | `bool` | `false` | `chan workspace index enable-semantic/disable-semantic`, Settings | Hybrid search default mode |
| `reports_enabled` | `bool` | `true` | `chan workspace reports enable/disable`, `chan workspace add --reports` | code reports at boot and on demand |
| `screensaver_enabled` | `bool` | `false` | `PATCH /api/screensaver/state`, Settings | arms the screensaver overlay |
| `screensaver_timeout_secs` | `u32` | `300` | `PATCH /api/screensaver/state` | the client-side idle threshold |
| `screensaver_theme` | `ScreensaverTheme` | `plain` | `PATCH /api/screensaver/state` | the overlay scene |
| `screensaver_pin_hash` | `Option<Vec<u8>>` | unset | `POST /api/screensaver/pin` | the overlay PIN gate; the wire reports only whether a PIN is set |

### `<team dir>/config.toml`: `TeamConfig`

Source: `crates/chan-workspace/src/teams.rs`; validation in `crates/chan-server/src/routes/team_config.rs`.

| Field | Type | Default | Reachability | Use |
|-------|------|---------|--------------|-----|
| `team_name` | `String` | required | `cs terminal team new`, the Team Work dialog | team identification |
| `host_name` | `String` | required | set at create time | UI rendering |
| `host_handle` | `String` | required | set at create time | the `@@` prefix policy |
| `tab_group` | `String` | team name | set at create time | the terminal tab group of the members |
| `auto_prefix_at` | `bool` | `true` | set at create time | bubble overlay `@@` auto-prefix |
| `mcp_env` | `bool` | `false` | set at create time, `--mcp-env` | whether team terminals export `CHAN_MCP_*` |
| `created_at` | `String` (ISO 8601) | stamped on write | set at create time | sort and display |
| `members[]` | `Vec<Member>` | empty | config | the roster, 1 to 9 members with exactly one lead |

`Member` is `handle`, `command`, `env` (a string map), `is_lead`, and an optional `position` of `row` and `col`. The submit agent is derived from a whole-word `agy`, `claude`, `codex`, `gemini`, `kimi`, `muse`, or `opencode` in `command`; `env.CHAN_AGENT` overrides it, and `none` or `shell` forces plain shell behaviour. Positions place members on a pane grid that both the Team Work dialog and `cs terminal team new|load` carve (`--tabs` stacks them instead); validation caps the grid at nine panes. The team directory and its conventions are in [.agents/orchestration/teams.md](../.agents/orchestration/teams.md).

## chan-desktop

### `~/.chan/desktop/config.json`: `Config`

Source: `desktop/src-tauri/src/config.rs`. `CHAN_HOME` moves it with the rest of the chan home.

| Field | Type | Default | Reachability | Use |
|-------|------|---------|--------------|-----|
| `client_session_name` | `String` | empty | hand-edited | the client session name native windows present, appended as `client_name` to their URLs; empty keeps automatic naming |
| `embedded_port` | `Option<u16>` | unset | written by the desktop on its first bind | preferred loopback port for the embedded local server; a port that cannot be bound falls back to an ephemeral one |
| `devservers[]` | `Vec<Devserver>` | empty | the launcher's Devserver form | connection recipes (URL, connect script, label, token) and per-devserver presentation state; per-workspace URLs and tokens are not persisted |
| `gateways[]` | `Vec<Gateway>` | empty | the launcher's Gateway form | gateway recipes and the native-trust records of shared devservers; rostered rows are volatile |
| `window_geometry[]` | `Vec<WindowGeometryRecord>` | empty | native window close and quit | per-label, per-monitor-signature OS window geometry, newest first |
| `local_color` | `Option<String>` | unset | the launcher's local colour route | the local library's pane highlight |
| `launcher_theme` | `Option<String>` | unset | the launcher's theme route | `dark`, `light`, or follow the OS when absent |

## Layout pointers

- The per-user chan home is `.chan` under the OS home on every platform, so `~/.chan/` in practice; where Unix resolves no home chan uses `/var/tmp/chan-<uid>`, and Windows falls back to `C:\ProgramData\chan`. It holds the global `config.toml` (the workspace registry); the state and cache roots resolve to the same directory.
- `CHAN_HOME=/path/to/chan-home` replaces `~/.chan` for the whole process. The override is the chan home itself, not a parent. It carries the registry, the devserver config, per-workspace metadata, locks, tokens, and the desktop-installed `chan` and `cs` shims under `CHAN_HOME/.local/bin`.

Two chan processes that share one chan home share one registry and one per-workspace writer lock. If chan-desktop is serving a registered workspace and a foreground `chan devserver run` starts from the same `~/.chan`, the devserver's launcher lists that workspace as locked rather than off: it is open in another chan process and cannot be turned on until the desktop releases it. Run the devserver with a separate `CHAN_HOME` when you want an independent library:

```sh
CHAN_HOME=/tmp/chan-devserver-home \
  ./target/debug/chan devserver run --service=none --bind 127.0.0.1 --port 8787
```

Per-workspace metadata lives under `~/.chan/workspaces/<metadata_key>/`, where `metadata_key` is a readable slug of the canonical workspace path plus a short hash suffix:

- `sessions/`: session blobs (window and pane layout).
- `Drafts/` and `drafts-trash/`: workspace drafts and discarded drafts, created lazily.
- `index/`: tantivy search-index segments plus `config.toml` (`IndexConfig` above).
- `graph/`: the graph database (sqlite) and its sidecar markers.
- `locks/`: the per-workspace index-writer lockfile.
- `tokens/`: the chan-server bearer token (mode 0600).
- `trash/`: soft-deleted files, garbage-collected lazily.
- `report/report.jsonl`: chan-report state, created on reports opt-in.

The standalone terminal window's draft store is per library and sits outside `workspaces/<metadata_key>/`; its path is given above. `crates/chan-workspace/src/paths.rs` (`WorkspacePaths`) is the canonical computation.
