// API types: the JSON shapes returned by chan-server's HTTP handlers.
// Keep in lockstep with crates/chan-server/src/routes.

export type WorkspaceInfo = {
  root: string;
  /// Path-derived display label from the server. This is not
  /// persisted user metadata; full root remains authoritative.
  label: string | null;
  metadata_key: string | null;
  /// Configured Drafts directory: a real in-workspace relpath
  /// (default `.Drafts`) named by a global backend config. Surfaced
  /// READ-ONLY; the SPA keys all draft-path logic off this value
  /// (see `draftsDir()` / `isDraftPath()` in state/workspace.svelte).
  /// Not user-editable from the SPA. Snake_case on the wire to match
  /// the rest of WorkspaceInfo (e.g. `metadata_key`).
  drafts_dir: string;
  /// Mirror of GlobalConfig.preferences. Per-workspace overrides
  /// were removed; settings are always per-device-global. Carried
  /// here so a single `/api/workspace` round-trip is enough to
  /// render the editor with the right fonts without a follow-up
  /// `/api/config` fetch.
  preferences: Preferences;
  /// Non-fatal boot warnings, currently used for broken draft
  /// workspaces under metadata.
  warnings: WorkspaceWarning[];
};

export type WorkspaceWarning = {
  kind: string;
  path: string;
  message: string;
};

export type MetadataExportDownload = {
  blob: Blob;
  filename: string;
  files: number | null;
  bytes: number | null;
};

export type MetadataImportReport = {
  manifest: MetadataManifest;
  imported_subtrees: string[];
  files: number;
  bytes: number;
  rescanned: boolean;
};

export type MetadataManifest = {
  archive_format_version: number;
  chan_version: string;
  created_at: string;
  source_root: string;
  source_metadata_key: string;
  metadata_schema: {
    path_key_scheme: string;
    index_schema_version: number;
    graph_user_version?: number | null;
    vector_shard_format_version?: number | null;
    report_schema_version?: number | null;
  };
  scm?: {
    remotes: string[];
    head?: string | null;
  } | null;
  included_subtrees: string[];
  excluded_subtrees: string[];
};

/// Global per-user config. Lives at `paths::global_config_path()`
/// on the server side and applies to every workspace (no per-
/// workspace override anymore; settings are always device-global).
export type GlobalConfig = {
  revision: number;
  preferences: Preferences;
  /// Known workspaces the user has opened on this machine. Updated
  /// by the server on every spawn (touch existing or append).
  /// Sorted most-recent first.
  workspaces?: KnownWorkspace[];
};

export type PreferencesPatch = Partial<Omit<Preferences, "transfer_max_bytes">>;

export type ConfigPatchRequest = {
  expected_revision: number;
  preferences: PreferencesPatch;
};

export type ConfigConflict = {
  error: "config_conflict";
  current: GlobalConfig;
};

export type KnownWorkspace = {
  path: string;
  metadata_key: string;
  /// RFC3339 timestamp.
  last_seen_at: string;
};

/// Editor theme. Workspaces the markdown renderer + source view
/// typography and chrome. Light/dark variants are selected from
/// the active ThemeChoice; density from LineSpacing. App chrome
/// (toolbar, panes, status bar) is not affected.
export type EditorTheme = "github" | "google_docs" | "word";

export type ThemeChoice = "system" | "light" | "dark";
export type SurfaceThemeChoice = "light" | "dark";
export type HybridSurfaceKind =
  | "editor"
  | "terminal"
  | "browser"
  | "graph"
  | "dashboard";
export type HybridSurfaceThemes = Partial<Record<HybridSurfaceKind, SurfaceThemeChoice>>;

export type PaneWidths = {
  inspector: number;
  graph: number;
  browser: number;
  search: number;
  /// Width of the left-side outline pane in the file editor tab.
  /// Optional on the wire so older servers (no `outline` field in
  /// PaneWidths) still parse cleanly; the client fills the default.
  outline?: number;
};

export type BrowserSidePanes = {
  left: boolean;
  right: boolean;
};

/// Vertical density for paragraphs and lists in the editor.
/// `standard` is the default; `compact` is denser. `tight` is a
/// legacy read alias accepted from older persisted configs.
export type LineSpacing = "standard" | "compact" | "tight";

export type SearchAggression = "conservative" | "balanced" | "aggressive";

export type TerminalPreferences = {
  idle_timeout_secs: number;
  session_cap: number;
  ring_bytes: number;
  /// Per-terminal scrollback budget in MB. Consumed at xterm.js
  /// construction time; spawn-time only (existing terminals keep
  /// their current scrollback until the session restarts). Server
  /// clamps to [10, 50]; default 10.
  scrollback_mb?: number;
  /// Default TERM env var on the spawned PTY. Optional on the wire
  /// so older servers (no field) deserialize cleanly; the SPA
  /// treats `undefined` as the default `xterm-256color`.
  default_term?: string;
  /// Terminal-font preference. Optional on the wire so older
  /// servers (no field) deserialize as the default `os-default`
  /// (per-OS native mono). `source-code-pro` opts into the bundled Source
  /// Code Pro face, which the SPA loads before constructing the renderer.
  font?: TerminalFontChoice;
  /// Terminal renderer font size in pixels. Captured when a renderer is
  /// constructed; mounted renderers keep their current value. Optional for
  /// older servers; absent means 14.
  font_size?: number;
  /// Whether newly-spawned terminals get the chan MCP discovery env
  /// vars (`CHAN_MCP_*`) so external agent CLIs can find the chan MCP
  /// server. Off by default (a stray env descriptor breaks some
  /// agents). Spawn-time only; the per-request `?mcp_env=on|off`
  /// query still overrides it for CLI / team spawns.
  mcp_env?: boolean;
  /// Whether full-screen TUIs may capture the mouse. On by default;
  /// when off the SPA strips the mouse-enable escape sequences so
  /// click-drag keeps selecting text over such programs. Optional on
  /// the wire so older servers (no field) deserialize cleanly; the
  /// SPA treats `undefined` as true. Applies to newly opened
  /// terminals.
  mouse_capture?: boolean;
  /// Whether newly opened terminals use the ghostty-web backend
  /// (Ghostty's WASM VT parser) instead of xterm.js. Off by default
  /// (xterm.js stays the default path). Optional on the wire so
  /// older servers (no field) deserialize cleanly; the SPA treats
  /// `undefined` as false. Applies to newly opened terminals.
  ghostty?: boolean;
  /// Whether xterm.js terminals visually obscure values whose assignment
  /// names end in a configured secret suffix. Optional for older servers;
  /// absent means disabled. Per-tab toggles do not persist this field.
  secret_masking?: boolean;
  /// Literal, case-insensitive assignment-name suffixes for visual masking.
  /// The server validates `[A-Za-z0-9_]+` entries and caps the list at 100.
  secret_mask_suffixes?: string[];
  /// User-declared terminal profiles, layered over the shells the server
  /// discovered on its own machine. An entry whose `id` matches a discovered
  /// profile overrides its fields or hides it; a new `id` adds a shell. The
  /// server drops malformed entries, dedupes by `id`, and caps the list at 50.
  /// Optional on the wire so older servers (no field) deserialize cleanly;
  /// absent means no customization, not "no profiles".
  profiles?: TerminalProfile[];
  /// Id of the profile new terminals spawn with. Optional; absent means the
  /// server's built-in resolution (`CHAN_SHELL` -> pwsh -> powershell -> cmd on
  /// Windows, `$SHELL` on unix). An id naming nothing is ignored server-side.
  default_profile?: string;
};

/// A user-declared terminal profile. Only `id` is required: the common case is
/// a small override of something already discovered. A wholly new profile needs
/// `program`; one that matches no discovered id and names no program is dropped
/// by the server, since there would be nothing to spawn.
export type TerminalProfile = {
  id: string;
  name?: string;
  program?: string;
  /// Interactive arguments. Replaces the discovered vector wholesale rather
  /// than appending -- appending could not express "drop `-NoLogo`".
  args?: string[];
  kind?: ShellKind;
  /// Hide a discovered profile without deleting the entry, so the hiding
  /// survives the server rediscovering that shell on its next boot.
  hidden?: boolean;
};

/// Argument convention for a shell. `wsl` exists separately because `-l` to
/// `wsl.exe` means "list distributions", not "login shell".
export type ShellKind = "powershell" | "cmd" | "posix" | "wsl";

export type TerminalFontChoice = "os-default" | "source-code-pro";

export type TerminalContrast = "auto" | "dark" | "light";

export type TerminalCustomColors = {
  background: string;
  foreground: string;
  cursor: string;
  contrast: TerminalContrast;
};

export type TerminalColorPrefs = {
  mode: "standard" | "custom";
  custom?: TerminalCustomColors;
};

/// One colour scheme's custom graph node overrides. Every hue is
/// optional; an absent slot keeps the theme palette value. Keys mirror
/// the eight settable node-kind tokens (`--g-doc` ... `--g-language`,
/// `--g-contact`). `contact` covers contact AND mention nodes together:
/// both share the one `--g-contact` token by design.
export type GraphPalette = {
  doc?: string;
  source?: string;
  binary?: string;
  img?: string;
  folder?: string;
  tag?: string;
  language?: string;
  contact?: string;
};

/// Custom graph node palettes, one per colour scheme. Mirrors the
/// terminal_colors shape: `standard` renders the theme palette and
/// leaves stored overrides dormant; `custom` applies them to the graph
/// surface only (never the app-wide `:root`).
export type GraphColorPrefs = {
  mode: "standard" | "custom";
  dark?: GraphPalette;
  light?: GraphPalette;
};

export type BubbleOverlayMode = "stack" | "tray";

export type TerminalSpawnRequest = {
  name: string;
  command: string;
  env?: Record<string, string>;
  /// Broadcast group the new session joins ($CHAN_TAB_GROUP + the
  /// registry tab_group). Used by the Team Work bootstrap so every team
  /// terminal joins the team's group.
  group?: string;
  orchestrator_session?: string;
  /// Owning window for the new session. Team-dialog terminals are created
  /// through this POST then merely attached over /ws (attach does not
  /// rebind window_id), so without binding it here they keep window_id =
  /// None and `cs terminal survey` cannot resolve them by window. The Team
  /// Work bootstrap passes the dialog window's sessionWindowId().
  window_id?: string;
  /// Shell profile for the new session. Absent uses the server's configured
  /// default profile, then its built-in shell resolution.
  profile?: string;
};

export type TerminalSpawnResponse = {
  session: string;
  tab_label: string;
};

/// One live terminal session in the cross-window roster (the server's
/// `RosterEntry`). The SPA reads these to render broadcast targets +
/// indicators for terminals in OTHER windows of the same tenant, which its
/// local layout cannot see. Seeded via `api.terminalRoster()` and refreshed
/// by `terminal_roster` frames over `/ws`. `tab_group` is always resolved
/// (never empty; "default" when unset) to match `terminalTabGroup`.
export type TerminalRosterEntry = {
  id: string;
  tab_name: string | null;
  tab_group: string;
  window_id: string | null;
  broadcast: boolean;
};

export type TerminalRestartRequest = {
  name?: string;
  /// Broadcast group for the respawned shell. Sets `$CHAN_TAB_GROUP`
  /// and the registry's per-session `tab_group`. Defaults to "default".
  group?: string;
  window_id?: string;
  /// Optional command override for the restarted PTY. When set,
  /// the new shell runs this command instead of the original
  /// spawn command. Used by the team-bootstrap orchestrator to
  /// flip the host's terminal into the lead's session.
  command?: string;
  /// Optional env override for the restarted PTY. Entries are
  /// merged into the restart options' env so per-member env
  /// (e.g. CHAN_TAB_NAME = lead handle) lands before respawn.
  env?: Record<string, string>;
  /// Switch the tab to a different shell profile. Absent restarts on the
  /// profile the session was spawned with -- restart means "same shell again".
  profile?: string;
};

/// One selectable shell from `GET /api/terminal/shells`.
export type ShellProfileView = {
  id: string;
  name: string;
  /// Absolute path to the executable, for a tooltip or to disambiguate two
  /// installs of the same shell.
  program: string;
  kind: ShellKind;
  source: "discovered" | "user";
};

/// `GET /api/terminal/shells`. Mounted on both the full and the slim
/// terminal-only router, so a terminal-only window can populate its picker.
export type TerminalShellsResponse = {
  profiles: ShellProfileView[];
  /// Echoed back only when the configured default resolves to a listed
  /// profile, so the picker shows what will actually happen rather than what
  /// the config file wishes for.
  default_profile: string | null;
};

export type Preferences = {
  editor_theme: EditorTheme;
  /// Optional absolute editor body size in pixels. Unset leaves typography to
  /// the active editor theme.
  editor_font_size?: number | null;
  /// Atomic terminal colour mode and its dormant custom payload.
  terminal_colors?: TerminalColorPrefs;
  /// Where image uploads land (relative to workspace root). Default
  /// `attachments/`. Included in the aggregate read and updated only
  /// when a partial patch names this server-owned field.
  attachments_dir: string;
  /// Editor theme. Lives server-side so changes propagate to every
  /// open window over the WS config_changed event.
  theme: ThemeChoice;
  /// Optional body-theme overrides for Hybrid element families.
  /// Missing entries inherit the global `theme` above.
  hybrid_surface_themes?: HybridSurfaceThemes;
  /// Custom graph node palettes, per colour scheme. Optional on the
  /// wire: absent means standard mode with no overrides (the theme
  /// palette renders). Applies to the graph surface only.
  graph_colors?: GraphColorPrefs;
  /// Sidebar widths shared across all panes (file editor inspector,
  /// graph details, file browser). Per-machine.
  pane_widths: PaneWidths;
  /// Docked file-browser panes attached outside the workspace.
  browser_side_panes: BrowserSidePanes;
  /// Editor density for paragraphs and lists.
  line_spacing: LineSpacing;
  /// Default format used by @date / @today and as the initial
  /// selection in the calendar picker's format dropdown.
  /// Format ids are defined in `web/packages/workspace-app/src/editor/dateFormats.ts`.
  date_format: string;
  /// When true, saves strip trailing spaces and tabs before writing
  /// text buffers to disk.
  strip_trailing_whitespace_on_save: boolean;
  /// Search indexer resource profile. Surfaced in Settings ->
  /// Search; also included in /api/config so CLI/server
  /// config changes remain visible to clients.
  search_aggression: SearchAggression;
  /// Effective transfer ceiling reported by the server. Read-only and absent
  /// from PreferencesPatch. Optional for older and offline response fixtures;
  /// clients do not derive or default this policy.
  transfer_max_bytes?: number;
  /// Terminal PTY session retention settings. Surfaced in Settings
  /// -> Terminal; replaced as one server-owned composite when patched.
  terminal: TerminalPreferences;
  /// Watcher bubbles display mode: show all inline, or collapse
  /// to a count tray until expanded.
  bubble_overlay_mode: BubbleOverlayMode;
  /// Auto-rotate the empty-pane carousel. Optional on the wire so
  /// older servers that don't ship the field don't trip the type
  /// contract; the UI treats `undefined` as the default-true.
  empty_pane_carousel_cycling?: boolean;
  /// Editor page-width cap as a ratio of the window width, in (0, 1];
  /// 1.0 means no cap. Optional on the wire so older servers that omit
  /// it don't trip the contract; the UI clamps to its slider bounds
  /// [0.25, 1.0] on read and falls back to its default when absent.
  page_width_ratio?: number;
  /// Global overlay-maximize toggle for the overlay surfaces (search /
  /// file browser). Optional on the wire; absent is treated as off.
  overlay_maximized?: boolean;
  /// Whether the `cs` terminal-alias offer card has been dismissed.
  /// Optional on the wire; absent is treated as not-dismissed, so the
  /// offer shows until the user dismisses it.
  cs_dismissed?: boolean;
  /// Per-command keyboard shortcut overrides, keyed by Command id, each
  /// holding an optional chord per client slot. Sparse: absent slots fall
  /// back to the built-in chord. Consumed by the keymap override layer
  /// (state/keymapOverrides.svelte). Optional on the wire; absent is an
  /// empty table.
  shortcuts?: ShortcutOverrides;
};

/// A single command's per-OS chord overrides. `web` is the browser set;
/// the rest are the chan-desktop native sets. All optional; an empty
/// string is a reserved "cleared" marker, treated as absent today.
export type ShortcutOverride = {
  web?: string;
  macos?: string;
  linux?: string;
  windows?: string;
};

/// The shortcut override table: command id -> per-OS chords.
export type ShortcutOverrides = Record<string, ShortcutOverride>;

export type TreeEntry = {
  path: string;
  is_dir: boolean;
  mtime: number | null;
  size: number;
  path_class?: PathClass;
  /// File-kind discriminator from the server. Present for every
  /// regular file; absent on directory entries (frontends key off
  /// `is_dir` for those). Values mirror the unified taxonomy in
  /// `web/packages/workspace-app/src/state/kinds.ts`:
  ///   - `document`: markdown-class (.md / .txt) without contact
  ///     frontmatter.
  ///   - `contact`: markdown-class with `chan.kind: contact`
  ///     frontmatter.
  ///   - `text`: any other text file (.py, .json, Makefile, ...)
  ///     the editor can round-trip through a UTF-8 buffer.
  ///   - `media`: images and PDFs.
  ///   - `binary`: archives, audio/video, and everything else opaque
  ///     to the editor.
  ///   - `pending`: unknown extension, content not yet sniffed.
  ///     Per-directory listings resolve this server-side to `text`
  ///     or `binary`; only the recursive whole-tree listing leaves
  ///     it pending (its consumer reads media kinds only).
  kind?: "document" | "contact" | "text" | "media" | "binary" | "pending";
};

/// Per-workspace directory blocklist view. The index +
/// graph walk skips `effective = union(defaults, workspace)`. `defaults`
/// is the global machine-wide baseline (read-only here); `workspace` is
/// this workspace's own editable additions. Backed by
/// `crates/chan-server/src/routes/excluded_dirs.rs`.
export type ExcludedDirsView = {
  defaults: string[];
  workspace: string[];
  effective: string[];
};

export type PathKind =
  | "directory"
  | "symlink"
  | "regular_file"
  | "fifo"
  | "socket"
  | "block_device"
  | "char_device"
  | "other";

export type PathPermission = "read_write" | "read_only";

export type PathClass = {
  kind: PathKind;
  permission: PathPermission;
  link_count: number;
  target?: string | null;
  target_escapes_workspace?: boolean;
};

/// Response from POST /api/move. The rename itself always succeeds
/// when `renamed` is non-empty; per-source rewrite failures land in
/// `conflicts` and do not abort the move.
export type MoveResponse = {
  /// (old_path, new_path) for every file the rename moved. Single
  /// entry for a file rename; one per descendant file for a directory.
  renamed: Array<[string, string]>;
  /// Source files whose contents were rewritten to point at the new
  /// locations. Workspace-rooted POSIX paths (post-rename).
  rewritten: string[];
  /// Source files where the rewrite was abandoned because the file
  /// changed between read and CAS-write. The on-disk rename stands.
  conflicts: string[];
};

/// FB clipboard + multi-drag multi-entry move/copy (POST /api/fs/transfer).
export type TransferOp = "move" | "copy";

export type TransferResponse = {
  /// Per-source final destination (after collision suffixing), in
  /// request order.
  moved: Array<{ from: string; to: string }>;
  /// Sources skipped (no-op move into the same parent, or escaped workspace).
  skipped: string[];
  /// Link-rewrite CAS conflicts accumulated across moved entries.
  conflicts: string[];
};

export type DraftInspectResponse = {
  path: string;
  name: string;
  file_count: number;
  dir_count: number;
  total_size: number;
  has_attachments: boolean;
};

export type DraftPromoteResponse = {
  path: string;
  name: string;
  mode: "file" | "directory_created" | "directory_merged";
};

export type FileResponse = {
  path: string;
  content: string;
  mtime: number | null;
  mtime_ns?: string | null;
  /// Live document/scene authority version. Null when the file is
  /// served directly from disk without an attached authority.
  authority_version?: number | null;
  /// True when the live authority retained divergent disk state and
  /// requires explicit conflict resolution.
  disk_conflicted?: boolean;
  path_class?: PathClass;
  /// Path of the enclosing git repo, relative to the workspace root.
  /// Absent when the file is not inside a git repo (or when the
  /// repo coincides with the workspace root). Workspaces the per-file
  /// scope indicator in the overlay picker.
  repo_root?: string | null;
  /// Filesystem-level writability: true when the underlying file
  /// has user-write bits set on disk, false otherwise. Workspaces the
  /// per-tab read-only lock that overrides the user's lamp toggle.
  /// Optional for forward-compat with older servers; absent =
  /// treat as writable to match prior behavior.
  writable?: boolean;
};

export type FileWriteResponse = {
  mtime: number | null;
  mtime_ns?: string | null;
  authority_version?: number | null;
  disk_conflicted?: boolean;
};

export type SearchHit = TreeEntry;

export type LinkTarget = {
  /// "File" = matched by basename / title; "Heading" = a heading inside
  /// a file (both from /api/link-targets). "Path" = matched by full
  /// workspace path so `[[dir/sub` style queries complete to paths;
  /// these are synthesized CLIENT-SIDE in the wiki bubble off the
  /// existing /api/files tree listing (the backend link-targets route is
  /// unchanged) and merged in as additive candidates. A "Path" row
  /// carries `path` (+ optional `mtime`); the heading fields are null.
  kind: "File" | "Heading" | "Path";
  path: string;
  title?: string | null;
  heading?: string | null;
  anchor?: string | null;
  level?: number | null;
  mtime?: number | null;
};

export type LinkEdge = {
  source: string;
  target: string;
  resolved: string | null;
  wiki: boolean;
};

/// Graph edge as returned by /api/backlinks/{path}. Mirrors
/// chan-workspace's graph::Edge: `kind` is "link" / "mention" / "tag";
/// `anchor` is the heading slug or block id (with leading `^`)
/// when the link points inside a file, else null.
export type GraphEdge = {
  src: string;
  dst: string;
  kind: "link" | "mention" | "tag";
  anchor: string | null;
};

export type GraphSnapshot = {
  edges: LinkEdge[];
  broken: LinkEdge[];
  file_count: number;
};

/// Typed nodes returned by GET /api/graph. The discriminated union
/// matches `chan-workspace::graph::GraphNode`; `path` is only present
/// on file nodes (clicking them opens the file in the active pane).
export type GraphViewNode =
  | {
      kind: "file";
      id: string;
      label: string;
      path: string;
      path_class?: PathClass | null;
      /// `chan.kind` discriminator from the indexer. "contact" for
      /// notes flagged with `chan.kind: contact` frontmatter; absent
      /// for regular markdown so the canvas falls back to the doc
      /// shape. Image files keep `node_kind` absent and are routed via
      /// the frontend's classifyFile extension check instead.
      node_kind?: "contact";
      /// True for an indexed file that has since vanished from disk (a
      /// stale-index signal); rendered muted. Unresolved link targets are
      /// NOT ghost nodes: the backend drops them (node and edge), so this
      /// is no longer set for a broken link.
      missing?: boolean;
    }
  | {
      kind: "media";
      id: string;
      label: string;
      path: string;
      path_class?: PathClass | null;
      missing?: boolean;
    }
  | { kind: "tag"; id: string; label: string }
  | { kind: "mention"; id: string; label: string }
  | {
      kind: "language";
      id: string;
      label: string;
      language: string;
      files: number;
      code: number;
    }
  | {
      kind: "folder";
      id: string;
      label: string;
      path: string;
      path_class?: PathClass | null;
      files: number;
      code: number;
      /// Per-directory indexing status used by the Dashboard
      /// indexing slide to colour the spine read-only. Undefined
      /// for the normal graph view; the main graph leaves folder
      /// fills on the standard `--g-folder` palette.
      indexState?: "pending" | "indexed" | "indexing";
    }
  | {
      kind: "directory";
      id: string;
      label: string;
      path: string;
      files: number;
      code: number;
    }
  | { kind: "date"; id: string; label: string };

export type GraphViewEdgeKind =
  | "link"
  | "tag"
  | "mention"
  | "contains"
  | "language"
  | "date";

export type GraphViewEdge = {
  source: string;
  target: string;
  kind: GraphViewEdgeKind;
  /// Only meaningful for `link` edges; missing/false for the others.
  broken?: boolean;
  rank?: number;
  files?: number;
  code?: number;
};

export type GraphView = {
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
};

export type LanguageGraphEdge = GraphViewEdge & {
  kind: "language";
  rank: number;
  files: number;
  code: number;
};

export type LanguageGraphDetailDirectory = {
  path: string;
  label: string;
  rank: number;
  files: number;
  code: number;
};

/// Inspector detail for one language: the complete ranked directory
/// list (no graph-depth cutoff) plus the COCOMO summary chan-report
/// computed for the language's file set. Present on the response only
/// when the request passed `?language=`.
export type LanguageGraphDetail = {
  language: string;
  files: number;
  code: number;
  cocomo: ReportCocomoSummary;
  directories: LanguageGraphDetailDirectory[];
};

export type LanguageGraphResponse = {
  max_depth: number;
  nodes: Array<Extract<GraphViewNode, { kind: "language" | "folder" | "directory" }>>;
  edges: LanguageGraphEdge[];
  detail?: LanguageGraphDetail;
};

export type FsGraphScope = "file" | "directory";
export type FsGraphNodeKind = "directory" | "file" | "symlink" | "ghost";
export type FsGraphEdgeKind = "contains" | "symlink" | "hardlink";

export type FsGraphNode = {
  id: string;
  kind: FsGraphNodeKind;
  name: string;
  path: string;
  size: number;
  path_class?: PathClass | null;
  permission?: PathPermission | null;
  link_count?: number;
  mtime?: number | null;
  target?: string | null;
  outside?: boolean;
  broken?: boolean;
  target_escapes_workspace?: boolean;
};

export type FsGraphEdge = {
  source: string;
  target: string;
  kind: FsGraphEdgeKind;
};

export type FsGraphResponse = {
  root: string;
  scope: FsGraphScope;
  path: string;
  depth: number;
  nodes: FsGraphNode[];
  edges: FsGraphEdge[];
  truncated: boolean;
  /// Cursor-paged delivery (a request carrying `limit` or `cursor`):
  /// `cursor` is the opaque continuation token for the next batch, null
  /// on the final batch; `done` is true on the final batch. Absent on a
  /// whole-scope (non-paged) response, which returns everything at once.
  cursor?: string | null;
  done?: boolean;
};

// New-workspace pre-flight (GET /api/preflight). chan-server derives the
// snapshot from live state on every poll; the SPA renders it on a locked
// surface until `phase === "ready"`.
//
// There is deliberately no `"running"`: the boot waits on a user decision or a
// failure and on nothing else. An index or recovery pass in flight is reported
// through `readiness` and the `index` step, never by holding the overlay --
// reading, editing and the terminal need no index, only search does.
export type PreflightPhase = "needs_decision" | "ready" | "failed";
export type PreflightStepState = "pending" | "done" | "needs_decision" | "failed";

export type PreflightDecisionChoice = { id: string; label: string };
export type PreflightDecision = {
  prompt: string;
  choices: PreflightDecisionChoice[];
};
export type PreflightStep = {
  id: string;
  label: string;
  state: PreflightStepState;
  /// Present when the step blocks on a user choice (`needs_decision`).
  decision?: PreflightDecision;
};
export type PreflightError = { step: string; message: string };
// The `cs` terminal-alias offer rides on the snapshot but never feeds the
// lock gate; present only when `cs` is missing from the host's PATH.
export type CsLink = {
  /// Absolute path where the `cs` link would be created: a sibling of the
  /// running binary. The server re-derives this on create; the client never
  /// picks it.
  target: string;
  /// What the link resolves to: the running chan / chan-desktop binary.
  /// Shown in the manual `ln -s` hint.
  points_to: string;
  /// True when the SPA may offer one-click Create (the dir is writable and
  /// on PATH). False -> show the manual hint + `note` instead.
  can_create: boolean;
  /// Why auto-create is unavailable, when `can_create` is false.
  note?: string | null;
};
// Post-open workspace facts for the first-run onboarding nudge. Rides on
// the pre-flight snapshot, present only once the workspace is ready; never
// feeds the lock gate.
export type WorkspaceSummary = {
  /// BM25-indexed chunk count; a coarse "there is content here" signal, not a
  /// file count.
  indexed_docs: number;
  /// Detected source-control kind ("git" | "hg" | "svn"), or null.
  scm?: string | null;
  /// Current optional-layer state, so the nudge renders the truth.
  semantic_enabled: boolean;
  reports_enabled: boolean;
};
export type PreflightSnapshot = {
  phase: PreflightPhase;
  /// True until `phase === "ready"`. The single signal the locked surface
  /// keys on: while true it shows with no close affordance and ignores ESC.
  locked: boolean;
  /// Whether the workspace has SETTLED, which is no longer the same question as
  /// `locked`. The boot unlocks while a recovery or index pass is still in
  /// flight, so this is what says "the index is still rebuilding, so search is
  /// paused and the onboarding summary has not arrived yet". The server has
  /// always sent it; it was simply never modelled here.
  readiness: WorkspaceReadiness;
  steps: PreflightStep[];
  error?: PreflightError | null;
  /// Non-blocking `cs` alias offer; rendered as a dismissible card, never
  /// part of the lock.
  cs_link?: CsLink | null;
  /// The per-library `cs` dismissal pref, surfaced on the snapshot so the
  /// card can gate at pre-flight time, before the workspace preferences
  /// finish loading. Always present; defaults false.
  cs_dismissed: boolean;
  /// Post-open workspace facts for the onboarding nudge; present once ready.
  summary?: WorkspaceSummary | null;
};
export type PreflightDecisionRequest = { step: string; choice: string };
// POST /api/preflight/cs-link result.
export type CsLinkResult = {
  /// True when `cs` now resolves on PATH after the call.
  resolved: boolean;
  /// The path created (empty when nothing was created).
  target: string;
  /// User-facing outcome line.
  message: string;
};

// ---------------------------------------------------------------------------
// /ws message-type catalog.
//
// The watcher socket carries both directions. Server -> client frames are a
// tagged union on `type`; client -> server frames are the scope sub/unsub
// path. The legacy global `watch` frame stays for the editor's open-document
// external-edit toast (a single-file concern); the scoped `fs` frame serves
// the per-directory File Browser / Graph tree (two frames, two consumers).
// Server-side serialization in chan-server must stay in lockstep with these
// shapes; both sides pin them with a test.
// ---------------------------------------------------------------------------

/// A single filesystem change as chan-workspace's watcher serializes
/// it on the wire. Capitalized kinds plus the rename destination `to`,
/// matching the verbatim `chan_workspace::WatchEvent` serialization the
/// store dispatcher reads (it branches on `"Removed"` / `"Renamed"`).
/// Distinct from the older, narrower `WatchEvent` type below (lowercase
/// kinds, no rename destination); new code should use `WatchEventWire`.
/// Response of `GET /api/fs/context`, the standalone window's boot payload: the
/// filesystem root the wire paths are relative to, the wire-relative
/// canonical home directory the browser starts in, and the path grammar.
/// Replaces `/api/workspace` on the standalone Files tenant.
export type FsContext = {
  protocol: number;
  root: string;
  home: string;
  path_style: "posix";
};

export type WatchEventWire = {
  kind: "Created" | "Modified" | "Removed" | "Renamed" | "ProviderError";
  path: string | null;
  to?: string | null;
  is_dir?: boolean;
};

/// Workspace-relative POSIX directory path used as a watcher scope key. The
/// empty string is the workspace root (always implicitly watched). Mirrors the
/// server-side `ScopeRegistry` keyspace.
export type WatchScopeDir = string;

/// Server -> client: the legacy global filesystem frame. Fans out to every
/// connected socket regardless of scope. Kept for the editor external-edit
/// toast; the tree should prefer the scoped `fs` frame.
///
/// `writable` is the live user-write bit on the event path, stat'ed by the
/// server at broadcast time. Present only when the path exists (absent on
/// removals and stat failures). chmod does not touch mtime, so this bit is
/// the only channel that lets open tabs track OS-level read-only state.
export type WsWatchFrame = {
  type: "watch";
  event: WatchEventWire;
  writable?: boolean;
};

/// Server -> client: a scoped filesystem frame, delivered only to sockets
/// subscribed to `dir`. Carries the originating directory so a client that
/// subscribed to several dirs can route the event to the right pane / node.
///
/// `source_w` names the window whose own mutation the standalone Files
/// tenant is echoing deterministically: that window relists but skips the
/// external-change marking on its clean buffers; every other receiver (and
/// every frame without the field, including all workspace-tenant frames)
/// treats the event as external.
export type WsFsFrame = {
  type: "fs";
  dir: WatchScopeDir;
  event: WatchEventWire;
  source_w?: string;
};

/// Server -> client: a scope needs one authoritative one-level relist. The
/// standalone Files watch manager emits these when a directory's OS watch
/// attaches (`subscribed`, closing the initial-list race), fails
/// (`watch_error`, retried server-side), loses events (`overflow`), or when
/// the watched directory itself was removed or replaced
/// (`directory_replaced`). The reason vocabulary is fixed; raw provider
/// messages never ride this frame.
export type WsFsResetFrame = {
  type: "fs_reset";
  dir: WatchScopeDir;
  reason: "subscribed" | "watch_error" | "overflow" | "directory_replaced";
};

/// Client -> server: subscribe / unsubscribe this socket to a directory
/// scope. `dir: ""` is the workspace root (idempotent no-op refcount the server
/// accepts). The server routes these to its `ScopeRegistry` against this
/// socket's subscriber id; a socket close implicitly unsubscribes all.
export type WsSubFrame = { type: "sub"; dir: WatchScopeDir };
export type WsUnsubFrame = { type: "unsub"; dir: WatchScopeDir };
/// Per-window active-transfer signal: `active` = count of in-flight cs
/// upload/download transfers in this window. Emitted on every start/end and
/// once on each (re)connect; the server tracks it per-`/ws`-socket so the
/// desktop close guard can prompt before closing a window mid-transfer.
export type WsTransfersFrame = { type: "transfers"; active: number };
/// Server -> client: server-authoritative admission state for ONE transfer,
/// routed to a single window. Distinct from `WsTransfersFrame` despite the
/// similar name: that one travels client -> server and reports a window's own
/// in-flight count for the desktop close guard, while this one carries the
/// server's admission decision. They must not be merged.
///
/// `position` is a 1-based rank among the WAITING transfers of the same tenant
/// (one workspace, or one standalone terminal), never a global queue depth.
/// Global dequeue order is FIFO across tenants, so a tenant-local `position: 1`
/// means "next among mine", not "next to run on this server". The frame
/// deliberately carries no other tenant's identifier, no cross-tenant count,
/// and no total queue length, because those would disclose that another tenant
/// exists and how busy it is. It also carries no path, filename, or content, so
/// a receiver cannot label a transfer from the frame alone and must key into
/// its own record by `transfer_id`.
///
/// `position` is ABSENT, not zero and not null, when `state` is `"active"`.
/// Every string here is validated at runtime rather than by the compiler, so
/// the literals are pinned on both sides.
export type WsTransferQueueFrame = {
  type: "transfer_queue";
  window_id: string;
  transfer_id: string;
  state: "waiting" | "active";
  position?: number;
};

/// Watcher heartbeat: a bare `{ type: "ping" }`. The server echoes
/// `{ type: "pong" }` on the same socket, which the transport's read-deadline
/// treats as liveness. Kept below the gateway proxy's per-direction idle cut so
/// a live but quiet window is not torn down. Pins the Rust `ClientFrame::Ping`
/// half in `crates/chan-server/src/routes/ws.rs`. NOT a member of
/// `WsClientFrame`: it rides its own transport path (a raw `ws.send`), and the
/// scope-control union's consumers narrow on the presence of `dir`.
export type WsPingFrame = { type: "ping" };

/// The client -> server frame union. Other server -> client frames
/// (`progress`, `window_command`, `config_changed`, ...) are handled
/// structurally in the store dispatcher and are intentionally not enumerated
/// here; this union is only the outbound scope-control path the transport
/// stub serializes.
export type WsClientFrame = WsSubFrame | WsUnsubFrame | WsTransfersFrame;

export type InspectorKind =
  | "workspace"
  | "directory"
  | "markdown"
  | "text"
  | "media"
  | "binary"
  | "special";

export type InspectorReportSummary = {
  totals: ReportTotals;
  by_language: ReportLanguageStats[];
};

export type InspectorSubtree = {
  files: number;
  directories: number;
  bytes: number;
  file_kinds: Record<string, number>;
};

export type InspectorPayload = {
  path: string;
  kind: InspectorKind;
  is_dir: boolean;
  size: number;
  mtime: number | null;
  path_class: PathClass;
  /// Absolute on-disk path, present ONLY for Drafts (which live outside the
  /// workspace root, so the SPA can't derive it). Used to seed the draft
  /// "Terminal from here". Absent for in-root paths.
  abs_path?: string | null;
  frontmatter_kind: string | null;
  report_file?: ReportFileStats | null;
  report_summary?: InspectorReportSummary | null;
  subtree?: InspectorSubtree | null;
};

export type WatchEvent =
  | { kind: "created"; path: string }
  | { kind: "modified"; path: string }
  | { kind: "deleted"; path: string };

/// One heading row from GET /api/headings/{path}. Mirrors
/// chan-workspace's graph::HeadingRow: `anchor` is the slug used in
/// `[link](file.md#anchor)` markdown URLs.
export type HeadingRow = {
  level: number;
  text: string;
  anchor: string;
  ord: number;
};

/// Workspace recovery projection carried by readiness-aware API responses.
/// Only `state` decides ready versus recovering. Generation/action fields are
/// optional progress detail and must never gate the UI.
export type WorkspaceReadiness =
  | {
      state: "ready";
      generation?: number;
    }
  | {
      state: "recovering";
      generation?: number;
      completed_generation?: number;
      required_action?: "replay" | "reconcile" | "full_rebuild" | null;
      active_generation?: number | null;
      pending_generation?: number | null;
    };

/// Indexer portion of GET /api/index/status. The server keeps this union
/// flattened and carries workspace recovery in a sibling `readiness` field.
export type IndexerStatus =
  | {
      state: "idle";
      indexed_docs: number;
      indexed_vectors: number;
      model: string;
      /// Background embedding progress, per the IDX wire-shape contract
      /// (idx-wire-shape.md). A `{done,total}` object (done <= total)
      /// while embeddings are still generating after the index reached
      /// BM25-ready - preflight unlocks on idle regardless - and `null`
      /// (the backend emits an explicit null) or absent once settled. The
      /// status bar renders it as a passive "embedding done/total" chip,
      /// never the active reindexing pill. `file` is the workspace-relative
      /// path currently being drained (absent between batch flushes); the
      /// indexing spine uses it to pulse one directory at a time.
      embedding?: { done: number; total: number; file?: string | null } | null;
    }
  | { state: "building"; current: number; total: number; file: string }
  | { state: "reindexing"; file: string }
  | { state: "error"; message: string };

/// Client-facing index status. During workspace recovery the client projects
/// the nested readiness tag into an explicit state so every existing SPA
/// consumer sees transient recovery rather than a settled empty index.
export type IndexStatus =
  | IndexerStatus
  | {
      state: "recovering";
      readiness: Extract<WorkspaceReadiness, { state: "recovering" }>;
      embedding?: null;
    };

export type IndexingDirectoryState = "indexed" | "indexing" | "pending";

export type IndexingStateNode = {
  path: string;
  state: IndexingDirectoryState;
  children_count: number;
};

export type IndexingStateResponse = {
  root: string;
  nodes: IndexingStateNode[];
};

export type HealthIndexerStatus = "idle" | "settling" | "rebuilding" | "error";

export type HealthResponse = {
  /// Random id minted when the server tenant was built. Changes when
  /// the process behind this window restarts; the store compares it
  /// across /ws reconnects and reloads the window on a change.
  instance?: string | null;
  indexer?: {
    status: HealthIndexerStatus;
    queue_depth: number;
    last_event_at?: string | null;
    last_settled_at?: string | null;
    coalesced_rebuild?: boolean;
  } | null;
};

/// Hybrid / BM25 / semantic content search hit.
export type ContentHit = {
  path: string;
  chunk_id: string;
  heading: string;
  start_line: number;
  snippet: string;
  score: number;
};

export type ContentSearchResponse = {
  ready: boolean;
  readiness: WorkspaceReadiness;
  mode: "hybrid" | "bm25" | "semantic";
  hits: ContentHit[];
};

/// Compile-time identity of the running chan binary. Powers the
/// Settings "About" footer so users can tell at a glance which
/// version they're on and whether semantic search is available.
export type BuildInfo = {
  version: string;
  features: {
    embeddings: boolean;
  };
};

/// One process-ready local extension. `entry_path` is a capability-scoped path
/// under the current workspace tenant; callers must never persist or log it.
export type ExtensionInfo = {
  id: string;
  name: string;
  entry_path: string;
  capabilities?: ("session-context" | "presentation")[];
  singleton?: boolean;
  commands?: ExtensionCommandInfo[];
};

export type ExtensionCommandInfo = {
  id: string;
  title: string;
  keywords?: string[];
};

/// Semantic-search state surface. Consumed by the Settings UI to
/// render the opt-in toggle and status row. `mode` is derived
/// server-side as `"hybrid"` iff `semantic_enabled AND
/// model_present`; the flag-on-but-model-deleted case falls back
/// to `"bm25"`. `model_size_bytes` is null pre-download (the
/// resolver only knows the size after the bundle lands on disk).
export type SemanticState = {
  mode: "bm25" | "hybrid";
  model_present: boolean;
  model_name: string;
  model_path: string;
  model_size_bytes: number | null;
  semantic_enabled: boolean;
};

export type SemanticModelEntry = {
  id: string;
  label: string;
  dim: number;
  size_label: string;
  note: string;
  default: boolean;
  downloaded: boolean;
  current: boolean;
};

export type SemanticModelRegistry = {
  current_model: string;
  models: SemanticModelEntry[];
};

/// Workspace reset modes, in increasing destructiveness. See
/// `crates/chan-server/src/routes/storage.rs` for the per-mode contract.
export type ResetMode = "workspace" | "everything";

export type ResetResponse = {
  removed_entries: number;
};

/// chan-report shapes. Mirror `crates/chan-report/src/summary.rs`
/// and the server's `routes::report::PrefixReport`. The file
/// inspector renders the per-file row; the directory inspector renders
/// the prefix roll-up (totals + by_language + COCOMO).

export type ReportFileStats = {
  path: string;
  language: string;
  code: number;
  comments: number;
  blanks: number;
  complexity: number;
  bytes: number;
  mtime?: string | null;
};

export type ReportLanguageStats = {
  name: string;
  files: number;
  bytes?: number;
  code: number;
  comments: number;
  blanks: number;
  complexity: number;
};

export type ReportTotals = {
  files: number;
  bytes?: number;
  code: number;
  comments: number;
  blanks: number;
  complexity: number;
};

export type ReportCocomoSummary = {
  model: string;
  effort_person_months: number;
  schedule_months: number;
  developers: number;
  estimated_cost_usd: number;
};

export type ReportPrefix = {
  totals: ReportTotals;
  by_language: ReportLanguageStats[];
  cocomo: ReportCocomoSummary;
};
