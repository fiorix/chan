// Shape of the frontend-only demo's workspace snapshot and the default
// workspace metadata the mock serves.
//
// The snapshot is a flat list of files produced at build time by
// scripts/snapshot-workspace.mjs (a git repo -> JSON). Every chan-specific
// derivation (tree listing, graph, headings, search) is computed on demand
// from this list by the mock store, so this file only describes the raw data
// plus the workspace/preferences defaults.

import type { Preferences, ReportFileStats, WorkspaceInfo } from "../api/types";

/// One file from the snapshot. Directories are implicit: the store derives
/// them from the file paths, so the snapshot never lists a directory.
export type MockFileEntry = {
  /// Workspace-relative POSIX path.
  path: string;
  /// File-kind discriminator matching TreeEntry.kind. `document` for
  /// markdown, `text` for other editable text, `media` for images, `binary`
  /// for opaque files. Absent is treated as `text`.
  kind?: "document" | "contact" | "text" | "media" | "binary";
  size: number;
  mtime: number | null;
  /// Capped UTF-8 content. Absent for media/binary and for over-cap files
  /// (the tree still shows them; opening yields empty/placeholder content).
  content?: string;
  /// True when `content` was truncated at snapshot time.
  truncated?: boolean;
};

export type MockWorkspaceData = {
  metadata: {
    workspaceRoot: string;
    label: string;
    generatedAt: number;
    sourceRepo?: string;
    fileCount: number;
    textCount: number;
    [key: string]: unknown;
  };
  files: MockFileEntry[];
  /// chan-reports per-file stats (language, SLOC, comments, blanks,
  /// complexity), precomputed by the snapshot script. The mock rolls these up
  /// per language + totals + COCOMO on demand. Absent in older snapshots.
  reports?: { files: ReportFileStats[] };
};

/// Preferences the demo boots with. Every required field is present so the
/// editor renders without a follow-up config fetch. Terminal + search fields
/// are round-tripped but inert in the demo.
export const DEMO_PREFERENCES: Preferences = {
  editor_theme: "github",
  attachments_dir: "attachments",
  theme: "dark",
  pane_widths: { inspector: 320, graph: 360, browser: 280, search: 360, outline: 240 },
  browser_side_panes: { left: false, right: false },
  line_spacing: "standard",
  date_format: "iso",
  strip_trailing_whitespace_on_save: false,
  search_aggression: "balanced",
  terminal: {
    idle_timeout_secs: 900,
    session_cap: 20,
    ring_bytes: 1_048_576,
    scrollback_mb: 50,
    default_term: "xterm-256color",
    font: "os-default",
    mcp_env: false,
    mouse_capture: true,
  },
  bubble_overlay_mode: "stack",
  empty_pane_carousel_cycling: true,
  page_width_ratio: 1,
  overlay_maximized: false,
  cs_dismissed: true,
};

/// Build the WorkspaceInfo the demo serves from GET /api/workspace.
export function demoWorkspaceInfo(
  data: MockWorkspaceData,
  preferences: Preferences = DEMO_PREFERENCES,
): WorkspaceInfo {
  return {
    root: data.metadata.workspaceRoot,
    label: data.metadata.label,
    metadata_key: "demo",
    drafts_dir: ".Drafts",
    preferences,
    warnings: [],
  };
}
