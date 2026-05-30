// Tab + pane state.
//
// v1 layout: a binary split tree of panes. Each pane holds an ordered list
// of tabs and an active tab id. Splits can be horizontal or vertical and
// nested arbitrarily, but the UI exposes a small set of operations:
//   - openInActivePane(path)
//   - splitRight() / splitDown()
//   - moveTabTo(otherPaneId)
//   - closeTab()
//
// Drag-rearrange of tabs is deferred; for v1 the menu offers explicit
// actions instead.

import { api } from "../api/client";
import { ApiError } from "../api/errors";
import type { DraftPromoteResponse } from "../api/types";
import type { FindRange } from "../editor/find";
import { stripTrailingWhitespaceText } from "../editor/tools";
import { uiConfirm } from "./confirm.svelte";
import { editorToolsPrefs } from "./editorTools.svelte";
import { classifyPath, isCsv, isEditableText, isJson } from "./fileTypes";
import type { FileKind } from "./kinds";
import { notify } from "./notify.svelte";
// `uiPathPrompt` lives in store.svelte, which has a TOP-LEVEL side
// effect (`registerDraftPromotionSink(...)`) that calls back into THIS
// module. A static `import { uiPathPrompt } from "./store.svelte"`
// here would force store's module body to run during tabs' own
// module-eval (whenever a file imports tabs first), and store's eager
// sink registration would touch `draftPromotionSinks` before it is
// initialised -> a fatal init-order crash in every tabs-first test.
// So we import it LAZILY inside `saveDraftTabToWorkspace` (a dynamic
// import resolved at user-action time, long after both modules have
// finished initialising). This is the correct way to consume a
// cyclic dependency whose other side has an eager side effect.

let nextId = 1;
function id(prefix: string): string {
  return `${prefix}-${nextId++}`;
}

/// Render mode for a file tab.
///   - `wysiwyg`: markdown-class only. Live rendering of markdown
///     via the custom CodeMirror Wysiwyg extension.
///   - `source`: raw source text in a CodeMirror editor. Available
///     on every tab as the lowest-common-denominator surface.
///   - `pretty`: collapsible-tree renderer. JSON only today.
///   - `table`: tabular renderer with click-to-edit cells. CSV /
///     TSV only today.
export type Mode = "wysiwyg" | "source" | "pretty" | "table";
export type EditorSelection = { from: number; to: number };
export type OpenFileOptions = {
  initialSelection?: EditorSelection;
};

/// Default mode for a freshly opened file. JSON tabs land in
/// "pretty"; CSV/TSV tabs land in "table"; markdown-class tabs
/// stay on "wysiwyg"; everything else (other text formats) opens
/// in source mode because that's the only mode they have.
function defaultModeForPath(path: string, fileKind: FileKind): Mode {
  if (isJson(path)) return "pretty";
  if (isCsv(path)) return "table";
  return fileKind === "text" ? "source" : "wysiwyg";
}

/// Whether `mode` is a valid pair for the given path + file kind.
/// Workspaces the session-restore guard: a stale URL hash that pairs an
/// incompatible (path, mode) falls back to the default for that path.
function isModeValidForPath(
  mode: Mode,
  path: string,
  fileKind: FileKind,
): boolean {
  if (mode === "pretty") return isJson(path);
  if (mode === "table") return isCsv(path);
  if (mode === "wysiwyg") return fileKind !== "text";
  // source is valid on every tab.
  return mode === "source";
}

function validateRestoredMode(
  persisted: Mode | undefined,
  path: string,
  fileKind: FileKind,
): Mode {
  if (persisted && isModeValidForPath(persisted, path, fileKind)) {
    return persisted;
  }
  return defaultModeForPath(path, fileKind);
}

/// Per-tab find-on-page state. Lives only while the bar is open
/// (cleared on close); intentionally not serialized through
/// SerTab so a session restore doesn't re-open the bar with a
/// stale query.
export type FindState = {
  open: boolean;
  query: string;
  caseSensitive: boolean;
  matches: FindRange[];
  /// -1 when there are no matches; otherwise an index into
  /// `matches`. The active match gets the .find-match--current
  /// decoration; prev/next rotate this index modulo `matches.length`.
  currentIndex: number;
  /// True iff `matches.length` hit MAX_FIND_MATCHES on the last
  /// scan. The counter reads "10000+" instead of "N of M" when
  /// this is set so users know they're seeing a truncated count.
  truncated: boolean;
  /// Bumped every time app.find.open targets this tab. Lets an
  /// already-mounted FindBar re-focus its input instead of treating
  /// the command as a no-op.
  focusNonce: number;
};

export function makeFindState(): FindState {
  return {
    open: false,
    query: "",
    caseSensitive: false,
    matches: [],
    currentIndex: -1,
    truncated: false,
    focusNonce: 0,
  };
}

/// File-content tab: holds the editable buffer for any text-class
/// file (markdown documents, contact notes, and arbitrary source /
/// config text like .py, .json, .yaml).
export type FileTab = {
  kind: "file";
  /// File-kind discriminator inside the tab. Mirrors the wire kind
  /// in `TreeEntry.kind` and the unified taxonomy in `./kinds.ts`:
  ///   - `document`: markdown-class, wysiwyg + source available.
  ///   - `contact`: same as document with contact frontmatter; the
  ///     tab UX is identical, but downstream surfaces (inspector,
  ///     graph) treat it as a contact.
  ///   - `text`: any other editable text file. Source-mode only;
  ///     the wysiwyg toggle is hidden in the tab menu.
  /// Initialized from `classifyPath` on open (path-based; we don't
  /// have the wire kind in tabs.svelte without a circular import
  /// on store). Contact files therefore start out tagged as
  /// `document` and stay that way for the tab's lifetime; the
  /// inspector and tree continue to read the live wire kind so the
  /// "contact" identity surfaces everywhere it matters.
  fileKind: FileKind;
  id: string;
  path: string;
  /// In-memory buffer; flushed on save.
  content: string;
  /// Last persisted content (for dirty detection).
  saved: string;
  /// Mtime returned by the last successful read or save. The
  /// nanosecond form is the CAS token on subsequent saves so an
  /// external edit between reads is detected as a 409 conflict
  /// rather than silently overwriting the disk-side change.
  /// Null when the file didn't exist yet (saved-from-empty); the
  /// server treats Some(None) as "expecting a fresh file".
  savedMtime: number | null;
  savedMtimeNs?: string | null;
  mode: Mode;
  loading: boolean;
  loadProgress?: { loadedBytes: number; totalBytes: number | null };
  error: string | null;
  /// Structured recovery state for an open file whose backing path
  /// disappeared. Kept separate from `error` so the UI can offer
  /// Re-open / Find / Close instead of showing a raw OS error.
  fileMissing: FileMissingState | null;
  /// Whether the right-side inspector panel (file info: tags,
  /// backlinks, refs) is shown alongside the editor. Toggleable
  /// per tab; persisted in the URL hash.
  inspectorOpen: boolean;
  /// Whether the left-side outline pane is shown alongside the
  /// editor. Toggleable per tab; persisted in the URL hash.
  outlineOpen: boolean;
  /// Enclosing git repo, relative to the workspace root, for files that
  /// live inside one. Set on first load from FileResponse.repo_root;
  /// workspaces the per-file "git repo: <name>" scope option in the
  /// overlay picker. `null` for files outside any repo (or files
  /// whose repo coincides with the workspace itself).
  repoRoot: string | null;
  /// User-toggled "read mode" for this tab (the lamp in
  /// WikiStatusBar). Per-tab so multi-pane layouts can mix
  /// read/write without panes fighting over a global flag.
  /// Ephemeral; not serialized into the URL hash or session.json.
  readMode: boolean;
  /// Filesystem-level writability, sourced from the file response's
  /// `writable` field on each read. `false` forces the tab into
  /// read-only mode regardless of `readMode` and disables the lamp
  /// toggle so the user can't try to write a file the OS won't
  /// accept. The watcher refreshes this when permissions change.
  fsWritable: boolean;
  /// An external (non-self) write to this file's path landed on disk
  /// while the tab is open. The editor shows a dismissable "changed on
  /// disk" banner and does NOT auto-reload, so the caret never jumps to
  /// 1:1 mid-edit. Set by `flagExternalChange` from the watcher; cleared
  /// on reload (loadTabContent) or dismiss.
  /// Ephemeral - not serialized into the URL hash / session.json.
  externalChange?: boolean;
  /// Whether the floating style toolbar (top-left of the editor
  /// canvas) is mounted for this tab. The user's explicit show /
  /// hide preference from the tab menu (a layer above the hover-
  /// to-expand behavior). Defaults false so new tabs open with a
  /// clean canvas; users opt the toolbar in from the tab menu.
  /// Per-tab so a "reading" tab can keep the chrome hidden while an
  /// adjacent editing tab shows it.
  styleToolbarOpen: boolean;
  /// Per-tab find-on-page state. Undefined until the first
  /// app.find.open command lands on the tab so tabs that never
  /// use Find stay free of the extra object. Persists across the
  /// Wysiwyg <-> Source mode toggle (same backing text); cleared
  /// on tab close along with the tab itself.
  find?: FindState;
  /// User-toggled syntax highlighting in source mode. Default true.
  /// Only meaningful when the tab is in source mode (markdown's
  /// wysiwyg surface does its own syntax painting). For text-kind
  /// tabs whose extension has no registered CodeMirror language
  /// pack the toggle is still surfaced but is effectively a no-op.
  /// Per-tab so a "reading" tab can read code with plain text and
  /// an adjacent "editing" tab can keep syntax on.
  syntaxHighlight: boolean;
  /// Visualize trailing spaces and tabs in the mounted editor. Per-tab
  /// because it is an inspection aid, not a document property.
  highlightTrailingWhitespace: boolean;
  /// Whether the user last asked this tab to collapse fenced code
  /// blocks. The mounted editor performs the actual folds.
  codeBlocksCollapsed: boolean;
  /// Last known caret position (doc offsets), persisted across the
  /// Wysiwyg <-> Source mode toggle and across page reloads via
  /// the URL-hash session. The active editor pushes updates here
  /// on every selection change; the editor that mounts next reads
  /// it once on first content apply to restore the caret.
  caret?: { from: number; to: number };
  /// Per-tab inspector and outline widths so two file tabs side by
  /// side carry independent inspector/outline sizes. Fall back to
  /// `paneWidths.inspector` / `paneWidths.outline` when unset.
  inspectorWidth?: number;
  outlineWidth?: number;
};

export type FileMissingState = {
  path: string;
  fragment: string | null;
  /// Best guess at where the file moved to, populated by the
  /// missing-file suggest-reopen lookup. Set when a basename
  /// search returns a unique match at a different path; null
  /// when the lookup ran and found 0 or 2+ candidates (ambiguous
  /// - let the user use Find).
  suggestedPath?: string | null;
};

export type TerminalTab = {
  kind: "terminal";
  id: string;
  title: string;
  createdAt: number;
  broadcastEnabled: boolean;
  broadcastTargetIds: string[];
  mcpEnv?: boolean;
  sessionMcpEnv?: boolean;
  terminalEnvTabName?: string;
  terminalEnvNamePromptDismissed?: boolean;
  terminalSessionId?: string;
  controlledTerminal?: boolean;
  lastSeq?: number;
  terminalActivity?: boolean;
  /// Refines terminalActivity. True while output is actively ARRIVING at
  /// this unfocused terminal (the unseen-output dot PULSES); flips false
  /// once output stops but is still unseen (the dot goes SOLID). Cleared
  /// with terminalActivity when the user sees it.
  terminalActivityPulsing?: boolean;
  cwd?: string;
  seedInput?: string;
  teamWork?: TeamWorkState;
};

export type GraphFilters = {
  link: boolean;
  tag: boolean;
  mention: boolean;
  language: boolean;
  img: boolean;
  folder: boolean;
  /// FileBucket toggles - mirrors the `GraphFilters` shape in
  /// `state/store.svelte.ts`. Both files declare a local `GraphFilters`
  /// (one for the per-tab state here, one for the overlay state in
  /// store); they stay in lockstep when extended.
  markdown: boolean;
  source: boolean;
};

export type GraphTab = {
  kind: "graph";
  id: string;
  title: string;
  mode: "semantic" | "filesystem" | "language";
  scopeId: string;
  depth: number;
  /// Expanded directory set for the filesystem-mode spine (double-click a
  /// directory to reveal its next degree). Workspace-relative dir paths;
  /// the scope root ("") is always expanded. Serialized so the
  /// expand/collapse state survives a window reload (File Browser parity).
  expanded: Record<string, boolean>;
  filters: GraphFilters;
  inspectorOpen: boolean;
  pendingSelectId: string | null;
  /// Live selection state. `selectedNodeId` is the graph node id the
  /// user clicked (kept here, not just in `GraphPanel.svelte`'s component
  /// state, so the tab title can peek it from outside the panel).
  /// `selectedNodeLabel` is the human-readable label cached at click time
  /// so the tab strip can render the title before graph data finishes
  /// reloading on restore.
  selectedNodeId?: string | null;
  selectedNodeLabel?: string | null;
  /// Per-tab inspector width. Falls back to `paneWidths.graph` when unset.
  inspectorWidth?: number;
};

export type BrowserTab = {
  kind: "browser";
  id: string;
  title: string;
  inspectorOpen: boolean;
  /// Per-tab view state so two File Browser tabs in the same pane don't
  /// share selection / scroll / expansion via module-level singletons.
  /// Populated by `FileBrowserSurface.svelte` on tab activate and
  /// snapshot-back on deactivate.
  selected?: string | null;
  /// Multi-selection set (FB capabilities: shift/cmd-click, shift+arrows,
  /// cmd+A, rubber-band). Per-tab alongside `selected` (the active
  /// cursor) so selecting in one File Browser tab does not leak into
  /// another. Unset / empty means a single-entry (or no) selection.
  selectedPaths?: string[];
  showWorkspace?: boolean;
  expanded?: string[];
  scroll?: number;
  /// Per-tab inspector width so two FB tabs can carry different inspector
  /// sizes. Falls back to `paneWidths.browser` when unset.
  inspectorWidth?: number;
};

export type TeamWorkState = {
  buffer: string;
  heightPx?: number;
  open?: boolean;
  phase?: "active" | "broken" | "submitted" | "discarded";
  workspaceName?: string;
  draftPath?: string;
  workspacePath?: string;
  eventsPath?: string;
  processPath?: string;
  workspaceAbs?: string;
  eventsAbs?: string;
  submissionSequence?: number;
  workspaceBusy?: boolean;
  workspaceError?: string | null;
  mode?: "wysiwyg" | "source";
  styleToolbarOpen?: boolean;
  /// Bumped on every `openActiveTeamWork` call so the prompt component
  /// re-focuses its input even when `open` was already true. Mirrors the
  /// find-bar `focusNonce` pattern.
  focusNonce?: number;
  /// Collapse the prompt to a minimal-height bar (just enough room for
  /// the placeholder / first line + the control row) so the bubbles
  /// above gain vertical real estate. Sticks across close / re-open
  /// within the same session via the serialized payload. Default
  /// expanded (`undefined` reads as `false`).
  collapsed?: boolean;
  /// Actual rendered height (px) of the Team Work root, written by a
  /// ResizeObserver in the Team Work editor component. The terminal-host
  /// margin reactor reads this in preference to `heightPx` so the
  /// reserved space tracks both the expanded drag-resize AND the collapse
  /// transition (where the prompt shrinks to header-only and `heightPx`
  /// is stale). Not persisted to SerTab - repopulated on every mount.
  measuredHeightPx?: number;
  /// Actual rendered width (px) of the team-work root, written by the
  /// same ResizeObserver. Feeds the per-prompt page-width clamp on the
  /// composer-editor so the cap is computed relative to this prompt's
  /// painted width, not the pane's editor wrapper. Not persisted.
  measuredWidthPx?: number;
  /// Per-prompt page-width ratio in (0.25, 1.0]. `1.0` (or absent) reads
  /// as "no cap" - the composer fills the prompt's painted width. Set via
  /// the slider in the team-work context menu. Decouples the prompt's
  /// line width from the global `pageWidth.ratio` so narrowing the editor
  /// in one tile does not cascade onto a sibling tile's prompt.
  pageWidthRatio?: number;
  /// Per-prompt shell-vs-agent submit-mode toggle. `"shell"` (default;
  /// absent reads as shell) sends the buffer with a trailing `\n`.
  /// `"agent"` sends the xterm modifyOtherKeys Cmd+Enter chord
  /// (`\x1b[27;9;13~`) so the buffer submits inside an agent (Claude
  /// Code / codex / gemini) running in the terminal. Persisted on
  /// `SerTab.rpsm`; the server-side `dispatch_agent_event` path via
  /// `PUT /api/terminal/:session/submit-mode` also reads this toggle so
  /// survey-reply echoes pick the right trailing bytes.
  submitMode?: "shell" | "agent";
  /// Agent picker. `"none"` maps to shell submit-mode; named agents map
  /// to agent submit-mode while preserving which runtime was selected.
  agentTarget?: "none" | "claude" | "codex" | "gemini";
};

/// Dashboard tab - read-only surface hosting the shortcut table and
/// info panels. No per-tab state today; the placeholder fields keep the
/// discriminated union symmetric with the other tab kinds and let future
/// additions include view state without re-walking the persistence layer.
export type DashboardTab = {
  kind: "dashboard";
  id: string;
  title: string;
  /// Persisted carousel slide index so a reload restores the user to the
  /// slide they were last on. 0 is the About slide; 1 is Workspace; 2 is
  /// the Indexing graph. The carousel's play/pause is server-persisted so
  /// the auto-rotate preference survives a reload independently.
  carouselSlide?: number;
};

export type Tab =
  | FileTab
  | TerminalTab
  | GraphTab
  | BrowserTab
  | DashboardTab;

type ClosedTab = {
  paneId: string;
  tab: Tab;
};

/// Middle-elision for tab strip titles. Targets a 15-code-point cap as
/// `head[..]tail` (6 + 4 + 5). The bias toward the tail keeps extensions
/// visible for the common cases (`.md`, `.ts`, `.svelte`, `.json`).
///
/// Counts code points via `Array.from` so a surrogate pair never splits
/// in the middle (emoji, CJK supplementary, etc.). Strings <= 15 code
/// points render as-is; the dirty marker (filled circle) lives outside
/// the label string in the tab strip render so the rule applies cleanly
/// to the visible name only.
///
/// Callers that present the truncated label should keep the full
/// untruncated value in the surrounding `title="..."` HTML attribute
/// (typically via `tabTooltip()`) so hover reveals it.
export const TAB_TITLE_MAX_LENGTH = 15;
const TAB_TITLE_HEAD = 6;
const TAB_TITLE_TAIL = 5;
const TAB_TITLE_ELLIPSIS = "[..]";

export function truncateTabTitle(label: string): string {
  const chars = Array.from(label);
  if (chars.length <= TAB_TITLE_MAX_LENGTH) return label;
  const head = chars.slice(0, TAB_TITLE_HEAD).join("");
  const tail = chars.slice(-TAB_TITLE_TAIL).join("");
  return `${head}${TAB_TITLE_ELLIPSIS}${tail}`;
}

/// Title for a Graph tab. Selection wins over scope: when the user
/// has tapped a node, the tab strip reads as the node's label
/// (basename for files / dirs, `#tag` for tags, contact name, etc.).
/// No selection falls back to the scope-derived title cached on
/// `tab.title`. Even with a selection, the kind= prefix from
/// `graphTitle()` is kept so the tab strip identifies the lens
/// shape (path= / tag= / contact= / lang=). Titles without an `=`
/// (top-level Languages overview, bare strings) render the bare label.
export function graphTabLabel(t: GraphTab): string {
  const label = t.selectedNodeLabel?.trim();
  if (!label) return t.title;
  const equalsAt = t.title.indexOf("=");
  if (equalsAt <= 0) return label;
  return `${t.title.slice(0, equalsAt)}=${label}`;
}

/// Optional context for `browserTabLabel`. `workspaceName` is the
/// display name to render when the tab points at the workspace root
/// (no selection, or a file directly under root). `selectedIsDir`
/// disambiguates "the user clicked a directory row" vs "the user
/// clicked a file row" when the path string alone is ambiguous;
/// when omitted, a trailing slash on `selected` is the fallback
/// signal.
export type BrowserLabelCtx = {
  workspaceName?: string;
  selectedIsDir?: boolean;
};

/// Short display label for a tab - the file's basename so the tab
/// strip stays scannable even when paths are deeply nested. The
/// full path is reachable via `tabTooltip` for disambiguation.
export function tabLabel(t: Tab, ctx?: BrowserLabelCtx): string {
  if (t.kind === "terminal") return terminalTabName(t);
  if (t.kind === "graph") return graphTabLabel(t);
  if (t.kind === "browser") return browserTabLabel(t, ctx);
  if (t.kind === "dashboard") return t.title;
  const p = t.path;
  if (!p) return p;
  const slash = p.lastIndexOf("/");
  return slash < 0 ? p : p.slice(slash + 1);
}

/// Files tab title is always a directory. File selection shows the
/// parent dir; directory selection shows that dir; no selection or
/// selection at workspace root shows the workspace display name.
/// Trailing slash is always rendered so the tab strip is unambiguous.
/// `ctx.workspaceName` is the display name for the workspace root
/// case; when absent, falls back to the tab's own `title` (default
/// `Files`) so unit tests that don't wire workspace context still work.
export function browserTabLabel(t: BrowserTab, ctx?: BrowserLabelCtx): string {
  const workspaceName = ctx?.workspaceName?.trim();
  const rootName = workspaceName || t.title;
  const selected = t.selected?.trim();
  if (!selected) return `${rootName}/`;
  const trailing = selected.endsWith("/");
  const cleaned = selected.replace(/\/+$/, "");
  if (!cleaned) return `${rootName}/`;
  const isDir = ctx?.selectedIsDir ?? trailing;
  const lastSlash = cleaned.lastIndexOf("/");
  if (isDir) {
    const dirName = lastSlash < 0 ? cleaned : cleaned.slice(lastSlash + 1);
    return `${dirName}/`;
  }
  if (lastSlash < 0) return `${rootName}/`;
  const parent = cleaned.slice(0, lastSlash);
  const parentSlash = parent.lastIndexOf("/");
  const parentName = parentSlash < 0 ? parent : parent.slice(parentSlash + 1);
  return `${parentName}/`;
}

/// Pane-local display label. Most tabs keep the basename. Duplicate
/// basenames collapse the group's shared prefix/suffix directories
/// and show only the shortest divergent ancestor; deeper divergent
/// tails render as `x/[...]/foo.md` to preserve tab-strip width.
export function tabLabelInPane(
  t: Tab,
  siblings: Tab[],
  ctx?: BrowserLabelCtx,
): string {
  if (t.kind !== "file") return tabLabel(t, ctx);
  const base = tabLabel(t);
  const duplicates = siblings.filter(
    (candidate): candidate is FileTab =>
      candidate.kind === "file" && tabLabel(candidate) === base,
  );
  if (duplicates.length <= 1) return base;

  const dirsById = new Map(
    duplicates.map((d) => [d.id, d.path.split("/").slice(0, -1)]),
  );
  const dirGroups = [...dirsById.values()];
  const prefixLen = commonPrefixLength(dirGroups);
  const suffixLen = commonSuffixLength(
    dirGroups.map((dirs) => dirs.slice(prefixLen)),
  );
  const targetDirs = dirsById.get(t.id) ?? [];
  const end = suffixLen > 0 ? targetDirs.length - suffixLen : targetDirs.length;
  const unique = targetDirs.slice(prefixLen, end);
  if (unique.length === 0) return t.path;
  if (unique.length === 1) return `${unique[0]}/${base}`;
  return `${unique[0]}/[...]/${base}`;
}

function commonPrefixLength(groups: string[][]): number {
  if (groups.length === 0) return 0;
  const max = Math.min(...groups.map((g) => g.length));
  let i = 0;
  for (; i < max; i++) {
    const value = groups[0]![i];
    if (!groups.every((g) => g[i] === value)) break;
  }
  return i;
}

function commonSuffixLength(groups: string[][]): number {
  if (groups.length === 0) return 0;
  const max = Math.min(...groups.map((g) => g.length));
  let i = 0;
  for (; i < max; i++) {
    const value = groups[0]![groups[0]!.length - 1 - i];
    if (!groups.every((g) => g[g.length - 1 - i] === value)) break;
  }
  return i;
}

/// Full path for a tab. Used as the tab's title attribute so two
/// files with the same basename in different directories can still be
/// told apart on hover.
export function tabTooltip(t: Tab): string {
  if (t.kind === "terminal") return terminalTabName(t);
  if (t.kind === "graph") {
    // Surface selection + scope so hover disambiguates two Graph tabs
    // viewing the same scope with different focal nodes, or two with
    // the same selection under different scopes.
    if (t.selectedNodeId) {
      return `Graph: ${t.scopeId} - ${t.selectedNodeId}`;
    }
    return `Graph: ${t.scopeId}`;
  }
  if (t.kind === "browser") {
    // Surface the per-tab selection so hover disambiguates two Files
    // tabs whose basenames collide (e.g. `index.md` in different dirs).
    return t.selected ? `File Browser: ${t.selected}` : "File Browser";
  }
  if (t.kind === "dashboard") return t.title;
  return t.path;
}

export function terminalTabName(t: TerminalTab): string {
  return t.title.trim() || "Terminal";
}

function terminalTabsIn(state: LayoutState): TerminalTab[] {
  const out: TerminalTab[] = [];
  for (const node of Object.values(state.nodes)) {
    if (node.kind !== "leaf") continue;
    for (const tab of node.tabs) {
      if (tab.kind === "terminal") out.push(tab);
    }
  }
  return out;
}

function nextTerminalTitle(state: LayoutState = layout): string {
  let max = 0;
  for (const tab of terminalTabsIn(state)) {
    const title = terminalTabName(tab);
    const match = /^Terminal(?:-(\d+))?$/.exec(title);
    if (!match) continue;
    const n = match[1] ? Number(match[1]) : 1;
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `Terminal-${max + 1}`;
}

/// Each pane (Hybrid in user-facing copy) holds an optional back-side
/// slot. The back is a per-surface configuration view scoped to the
/// type of the currently-active front tab. `pane.tabs` /
/// `pane.activeTabId` always describe the FRONT side; `showingBack`
/// toggles which surface renders. Both sides share `pane.theme`.
export type HybridTheme = "dark" | "light";

export type HybridSide = {
  /// Marker type for "this pane has been flipped at least once."
  /// Empty body: `pane.theme` owns the single per-Hybrid theme.
  /// `pane.back !== undefined` discriminates Hybrid vs never-flipped
  /// for menu gating in `Pane.svelte`.
};

export type Pane = {
  id: string;
  tabs: Tab[];
  activeTabId: string | null;
  /// Visible-side theme override (`undefined` = follow global).
  theme?: HybridTheme;
  /// Hidden side. `undefined` for never-flipped panes; the first
  /// `flipHybrid()` call lazily materializes it so `pane.back !== undefined`
  /// gates the Hybrid menu entries.
  back?: HybridSide;
  /// User-visible flag for "this Hybrid is currently flipped to its
  /// back-side configuration view". Independent of whether `back`
  /// exists: a pane that has been flipped twice has
  /// `back !== undefined` but `showingBack === false` again.
  /// Defaults to false.
  showingBack?: boolean;
};

export type FocusColor = "blue" | "orange" | "green" | "pink";

export type Split = {
  id: string;
  kind: "split";
  direction: "row" | "column";
  /// children IDs from `nodes` map.
  a: string;
  b: string;
  /// Fraction of the split's main-axis length given to child `a`.
  /// Range (0..1); 0.5 is even. Updated live by the divider drag in
  /// Workspace.svelte and persisted in the URL hash.
  ratio: number;
};

export type LeafNode = Pane & { kind: "leaf" };
export type SplitNode = Split;
export type Node = LeafNode | SplitNode;

export const layout = $state<{
  rootId: string;
  nodes: Record<string, Node>;
  activePaneId: string;
  focusColor: FocusColor;
}>(
  (() => {
    const pane: LeafNode = {
      kind: "leaf",
      id: id("pane"),
      tabs: [],
      activeTabId: null,
    };
    return {
      rootId: pane.id,
      nodes: { [pane.id]: pane },
      activePaneId: pane.id,
      focusColor: "blue",
    };
  })(),
);

export type LayoutState = typeof layout;

/// Staged spawn intent for Pane Mode number keys. The intent queues
/// here so the pane-mode "Enter commit / Esc discard" contract holds
/// for every keystroke; `commitPaneMode()` materializes it as part of
/// the seal. A second staging overwrites the first; Esc clears it
/// without spawning.
export type PaneModeSpawnKind = "terminal" | "browser" | "graph";
export type PaneModeSpawnIntent = {
  kind: PaneModeSpawnKind;
  ctx: SpawnContext;
};

/// Mouse-driven variant of Hybrid Nav. Entered by drag-from-dead-zone
/// (sets `grabPaneId` to the originating pane) or by double-click on
/// the dead zone (`grabPaneId` stays null until the user clicks and
/// drags inside a pane). Mouse handlers in transaction mode operate on
/// the full pane body, not just the top bar. Enter / Esc / Cmd+. exit
/// through the same paths as keyboard Nav.
export const paneMode = $state<{
  active: boolean;
  draft: LayoutState | null;
  spawnIntent: PaneModeSpawnIntent | null;
  transactionMode: boolean;
  grabPaneId: string | null;
  hoverPaneId: string | null;
  /// Queue of "new draft editor" intents staged during the current
  /// pane-mode session. Materialized on Enter (commit); discarded on
  /// Esc (cancel). Each entry pins the target paneId at press time so
  /// later focus changes don't redirect materialization.
  stagedDraftEditors: { paneId: string }[];
}>({
  active: false,
  draft: null,
  spawnIntent: null,
  transactionMode: false,
  grabPaneId: null,
  hoverPaneId: null,
  stagedDraftEditors: [],
});

/// Single-fire wobble bus. Each pane's entry holds a monotonic
/// counter; bumping it on a structural event (split / close /
/// pane-move) lets the Pane component re-trigger its CSS
/// animation by toggling the wobble class. Counters never reset
/// because the consumer only cares about the change, not the
/// value.
export const paneWobble = $state<{ versions: Record<string, number> }>({
  versions: {},
});

export function requestPaneWobble(paneId: string): void {
  if (!paneId) return;
  paneWobble.versions[paneId] = (paneWobble.versions[paneId] ?? 0) + 1;
}

/// Separate event bus for the Hybrid pane flip animation. `paneWobble`
/// is the structural-change cue (split / close / swap gives a scale
/// bounce); `paneFlip` is the orientation-change cue (Hybrid flip
/// gives a Y-axis rotation). Two distinct visual signals for two
/// distinct kinds of state change. Same versioned-counter shape so
/// Pane.svelte's subscription pattern works identically for both.
export const paneFlip = $state<{ versions: Record<string, number> }>({
  versions: {},
});

export function requestPaneFlip(paneId: string): void {
  if (!paneId) return;
  paneFlip.versions[paneId] = (paneFlip.versions[paneId] ?? 0) + 1;
}

export function activeLayout(): LayoutState {
  return paneMode.active && paneMode.draft ? paneMode.draft : layout;
}

function pane(id: string): LeafNode {
  const n = layout.nodes[id];
  if (!n || n.kind !== "leaf") throw new Error(`not a pane: ${id}`);
  return n;
}

export function activePane(): LeafNode {
  const current = activeLayout();
  const n = current.nodes[current.activePaneId];
  if (!n || n.kind !== "leaf") throw new Error(`not a pane: ${current.activePaneId}`);
  return n;
}

const CLOSED_TAB_LIMIT = 20;
const recentlyClosedTabs = $state<ClosedTab[]>([]);
const localTabDrops = new Set<string>();

function tabDropKey(paneId: string, tabId: string): string {
  return `${paneId}:${tabId}`;
}

export function markLocalTabDrop(fromPaneId: string, tabId: string): void {
  localTabDrops.add(tabDropKey(fromPaneId, tabId));
}

export function shouldCloseTabAfterDragEnd(
  paneId: string,
  tabId: string,
  dropEffect: string | undefined,
): boolean {
  if (dropEffect !== "move") return false;
  const localDrop = localTabDrops.delete(tabDropKey(paneId, tabId));
  const n = layout.nodes[paneId];
  if (!n || n.kind !== "leaf") return false;
  const stillHere = n.tabs.some((t) => t.id === tabId);
  return stillHere && !localDrop;
}

export function canReopenClosedTab(): boolean {
  return recentlyClosedTabs.length > 0;
}

export function clearRecentlyClosedTabsForTest(): void {
  recentlyClosedTabs.length = 0;
  localTabDrops.clear();
}

function rememberClosedTab(paneId: string, tab: Tab): void {
  recentlyClosedTabs.push({ paneId, tab: cloneTab(tab) });
  if (recentlyClosedTabs.length > CLOSED_TAB_LIMIT) {
    recentlyClosedTabs.splice(0, recentlyClosedTabs.length - CLOSED_TAB_LIMIT);
  }
}

export function reopenClosedTab(): boolean {
  const entry = recentlyClosedTabs.pop();
  if (!entry) return false;
  const targetNode = layout.nodes[entry.paneId];
  const target =
    targetNode && targetNode.kind === "leaf" ? targetNode : activePane();
  const tab = tabForReopen(entry.tab);
  if (tabIdExists(tab.id)) {
    tab.id = id(tab.kind === "terminal" ? "term" : "tab");
  }
  target.tabs.push(tab);
  target.activeTabId = tab.id;
  layout.activePaneId = target.id;
  return true;
}

function tabIdExists(tabId: string): boolean {
  return Object.values(layout.nodes).some(
    (node) => node.kind === "leaf" && node.tabs.some((tab) => tab.id === tabId),
  );
}

function tabForReopen(src: Tab): Tab {
  const tab = cloneTab(src);
  if (tab.kind === "terminal") {
    tab.terminalSessionId = undefined;
    tab.controlledTerminal = undefined;
    tab.lastSeq = undefined;
    tab.sessionMcpEnv = undefined;
    tab.terminalEnvTabName = undefined;
    tab.terminalEnvNamePromptDismissed = undefined;
  }
  return tab;
}

/// Ensure the named tab has a FindState attached and open it.
/// Called by the chan:command "app.find.open" handler. Idempotent:
/// reopening a bar that's already open just refocuses the input
/// (FindBar's mount effect handles that side).
export function openFind(tabId: string): void {
  const found = findFileTabById(tabId);
  if (!found) return;
  if (!found.tab.find) found.tab.find = makeFindState();
  found.tab.find.open = true;
  found.tab.find.focusNonce += 1;
}

/// Close the find bar for the named tab. Leaves the query string
/// in place so reopening picks up where the user left off; the
/// matches array is cleared (FindBar's onDestroy already clears
/// the editor decorations).
export function closeFind(tabId: string): void {
  const found = findFileTabById(tabId);
  if (!found || !found.tab.find) return;
  found.tab.find.open = false;
  found.tab.find.matches = [];
  found.tab.find.currentIndex = -1;
  found.tab.find.truncated = false;
}

/// Active file tab of the focused pane, or null if the pane is
/// empty / its active tab isn't a file tab. Used by the host-
/// driven command bridge (App.svelte runCommand) so app.find.*
/// can target whichever tab the user is currently looking at
/// without each call site re-deriving the lookup.
export function activeFileTab(): FileTab | null {
  const p = activePane();
  if (!p.activeTabId) return null;
  const t = p.tabs.find((tab) => tab.id === p.activeTabId);
  if (!t || t.kind !== "file") return null;
  return t;
}

export function activeTerminalTab(): TerminalTab | null {
  const p = activePane();
  if (!p.activeTabId) return null;
  const t = p.tabs.find((tab) => tab.id === p.activeTabId);
  if (!t || t.kind !== "terminal") return null;
  return t;
}

/// Toggle broadcast SELECT-ALL / DESELECT-ALL for the active terminal.
/// Chord-driven equivalent of the per-tab "Select All" / "Deselect All"
/// button. Walks every terminal tab including self (self via
/// broadcastEnabled, others via broadcast targets) so the bulk action
/// matches the per-row UI. No-op when the active tab isn't a terminal.
export function toggleActiveTerminalBroadcastSelectAll(): void {
  const tab = activeTerminalTab();
  if (!tab) return;
  const targets = allTerminalTabs();
  if (targets.length === 0) return;
  const selected = new Set(terminalBroadcastMemberIds(tab));
  const allSelected = targets.every((t) =>
    t.id === tab.id ? tab.broadcastEnabled : selected.has(t.id),
  );
  const select = !allSelected;
  for (const target of targets) {
    if (target.id === tab.id) {
      setTerminalBroadcastEnabled(tab, select);
    } else {
      setTerminalBroadcastTarget(tab, target.id, select);
    }
  }
}

export function openActiveTeamWork(): void {
  const tab = activeTerminalTab();
  if (!tab) return;
  // The Team Work editor focuses inside `onMount`. Until Svelte flushes
  // the open-state update and the editor child mounts, whatever held
  // focus before (typically xterm's helper-textarea) is still the
  // keyboard target. A fast typer hits this race: the first keystroke
  // lands on xterm-helper-textarea, fires `term.onData -> sendUserInput`,
  // and goes to the PTY behind the user's back. Blurring up front parks
  // focus on `<body>` until the editor mounts, so the missed keystroke
  // goes nowhere visible instead of into the live shell.
  blurTerminalHelperTextarea();
  if (!tab.teamWork) {
    tab.teamWork = {
      buffer: "",
      heightPx: 320,
      open: true,
      mode: "wysiwyg",
      focusNonce: 1,
    };
  } else {
    tab.teamWork.open = true;
    tab.teamWork.mode ??= "wysiwyg";
    // Bump every call (including when already open) so the input
    // re-focuses even if the user had clicked away.
    tab.teamWork.focusNonce = (tab.teamWork.focusNonce ?? 0) + 1;
  }
}

/// Blur the active element when it is xterm's helper textarea. We
/// only blur known terminal-input surfaces so non-terminal flows
/// (e.g. an editor that calls this state module indirectly) keep
/// their focus. The class `xterm-helper-textarea` is the textarea
/// xterm.js inserts inside `.xterm-screen` to capture keystrokes
/// and IME composition; if the user clicks elsewhere on the xterm
/// element xterm reassigns focus there too. Both share the
/// `.xterm` ancestor.
function blurTerminalHelperTextarea(): void {
  if (typeof document === "undefined") return;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return;
  if (
    active.classList.contains("xterm-helper-textarea") ||
    active.closest(".xterm")
  ) {
    active.blur();
  }
}

/// Team Work lead-terminal factory. Creates a fresh terminal in the
/// active pane and opens the Team Work editor on it, returning the
/// created tab. The Cmd+P flow uses the returned handle so the Team
/// dialog can delete the just-spawned terminal if the user cancels
/// before committing.
export function createTeamWorkLeadTerminal(
  opts: OpenTerminalOptions = {},
): TerminalTab | null {
  const p = activePane();
  const tab = openTerminalInPane(p.id, opts);
  if (!tab) return null;
  openActiveTeamWork();
  return tab;
}

export type OpenTerminalOptions = {
  cwd?: string;
  seedInput?: string;
  title?: string;
  sessionId?: string;
  controlledTerminal?: boolean;
};

export function openTerminalInActivePane(opts: OpenTerminalOptions = {}): TerminalTab | null {
  return openTerminalInPane(activePane().id, opts);
}

export function openTerminalInPane(
  paneId: string,
  opts: OpenTerminalOptions = {},
): TerminalTab | null {
  const p = layout.nodes[paneId];
  if (!p || p.kind !== "leaf") return null;
  const cwd = opts.cwd?.trim();
  const seedInput = opts.seedInput?.trim();
  const title = opts.title?.trim();
  const tab: TerminalTab = {
    kind: "terminal",
    id: id("term"),
    title: title || nextTerminalTitle(),
    createdAt: Date.now(),
    broadcastEnabled: false,
    broadcastTargetIds: [],
    mcpEnv: true,
    sessionMcpEnv: undefined,
    terminalSessionId: opts.sessionId?.trim() || undefined,
    controlledTerminal: opts.controlledTerminal || undefined,
    lastSeq: undefined,
    cwd: cwd || undefined,
    seedInput: seedInput || undefined,
    teamWork: undefined,
  };
  p.tabs.push(tab);
  p.activeTabId = tab.id;
  layout.activePaneId = p.id;
  return tab;
}

export type OpenGraphOptions = Partial<
  Pick<GraphTab, "mode" | "scopeId" | "depth" | "pendingSelectId" | "title">
>;

const DEFAULT_GRAPH_FILTERS: GraphFilters = {
  link: true,
  tag: true,
  mention: true,
  language: true,
  img: true,
  folder: true,
  markdown: true,
  source: true,
};

export function openGraphInActivePane(opts: OpenGraphOptions = {}): GraphTab {
  return openGraphInPane(layout.activePaneId, opts);
}

export function openGraphInPane(paneId: string, opts: OpenGraphOptions = {}): GraphTab {
  const p = pane(paneId);
  const mode = opts.mode ?? "semantic";
  const scopeId = opts.scopeId ?? "workspace";
  // No dedup on spawn. Each invocation creates a fresh graph tab with
  // its own scope, filters, and pending selection so the user can
  // compare two views side-by-side. Callers that want "activate the
  // existing one" can find it on `pane.tabs` and set `activeTabId`.
  const tab: GraphTab = {
    kind: "graph",
    id: id("graph"),
    title: opts.title ?? graphTitle(mode, scopeId),
    mode,
    scopeId,
    depth: opts.depth ?? 1,
    expanded: { "": true },
    filters: { ...DEFAULT_GRAPH_FILTERS },
    inspectorOpen: false,
    pendingSelectId: opts.pendingSelectId ?? null,
  };
  p.tabs.push(tab);
  p.activeTabId = tab.id;
  layout.activePaneId = p.id;
  return tab;
}

export function openBrowserInActivePane(
  opts: { select?: string | null } = {},
): BrowserTab {
  const p = activePane();
  // No dedup. Each press spawns a new browser tab with its own current
  // dir and inspector state.
  const tab: BrowserTab = {
    kind: "browser",
    id: id("browser"),
    title: nextBrowserTitle(),
    inspectorOpen: defaultBrowserInspectorOpen(),
    ...(opts.select ? { selected: opts.select } : {}),
  };
  p.tabs.push(tab);
  p.activeTabId = tab.id;
  layout.activePaneId = p.id;
  return tab;
}

/// Mirrors `nextTerminalTitle`: walk every existing browser tab,
/// find the highest "Files" / "Files N" number, return next. The
/// title is what `browserTabLabel`'s fallback path uses when the
/// workspace context isn't wired (unit tests, edge surfaces) AND it
/// also matters when two unselected FB tabs sit side-by-side - /// numbering disambiguates them in the tab strip.
function nextBrowserTitle(): string {
  let max = 0;
  let hasUnnumbered = false;
  for (const node of Object.values(layout.nodes)) {
    if (node.kind !== "leaf") continue;
    for (const tab of node.tabs) {
      if (tab.kind !== "browser") continue;
      const match = /^Files(?: (\d+))?$/.exec(tab.title);
      if (!match) continue;
      if (match[1] === undefined) {
        hasUnnumbered = true;
      } else {
        const n = Number(match[1]);
        if (Number.isInteger(n) && n > max) max = n;
      }
    }
  }
  if (!hasUnnumbered) return "Files";
  return `Files ${Math.max(max + 1, 2)}`;
}

function defaultBrowserInspectorOpen(): boolean {
  if (typeof window === "undefined") return true;
  return window.innerWidth >= 768;
}

/// Title for a Graph tab. The tab name reads as the basename of
/// whatever the user scoped the graph to (file basename, dir name,
/// contact name, `#tag`) so the tab strip identifies the subject
/// directly. Every title carries a `kind=` prefix so the tab strip
/// also identifies the lens shape (`path=` / `tag=` / `contact=` /
/// `lang=`). `mode === "language"` is a top-level lens (not per-scope)
/// and keeps its dedicated `Languages` label.
export function graphTitle(mode: GraphTab["mode"], scopeId: string): string {
  if (mode === "language") return "Languages";
  if (scopeId === "workspace" || scopeId === "global") return "path=workspace";
  if (scopeId.startsWith("file:")) {
    const name = graphScopeBasename(scopeId.slice("file:".length));
    return name ? `path=${name}` : "path=workspace";
  }
  if (scopeId.startsWith("dir:")) {
    const name = graphScopeBasename(scopeId.slice("dir:".length));
    return name ? `path=${name}/` : "path=workspace";
  }
  if (scopeId.startsWith("tag:")) {
    const tag = scopeId.slice("tag:".length);
    return `tag=${tag.startsWith("#") ? tag : `#${tag}`}`;
  }
  if (scopeId.startsWith("contact:")) {
    const name = graphScopeBasename(scopeId.slice("contact:".length));
    return `contact=${name || scopeId.slice("contact:".length)}`;
  }
  if (scopeId.startsWith("language:")) {
    return `lang=${scopeId.slice("language:".length)}`;
  }
  if (scopeId.startsWith("git_repo:")) {
    return graphScopeBasename(scopeId.slice("git_repo:".length));
  }
  // Unknown prefix shape: peel anything before the first colon
  // so the user at least sees the payload.
  const colon = scopeId.indexOf(":");
  if (colon > 0) return scopeId.slice(colon + 1);
  return scopeId;
}

function graphScopeBasename(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

export function renameTerminalTab(tab: TerminalTab, title: string): void {
  tab.title = title;
  if (terminalEnvTabNameStale(tab)) tab.terminalEnvNamePromptDismissed = false;
}

export function terminalEnvTabNameStale(tab: TerminalTab): boolean {
  return Boolean(
    tab.terminalSessionId &&
      tab.terminalEnvTabName !== undefined &&
      terminalTabName(tab) !== tab.terminalEnvTabName,
  );
}

export function dismissTerminalEnvNamePrompt(tab: TerminalTab): void {
  tab.terminalEnvNamePromptDismissed = true;
}

export function markTerminalEnvNameRestarted(tab: TerminalTab): void {
  tab.terminalEnvTabName = terminalTabName(tab);
  tab.terminalEnvNamePromptDismissed = false;
}

export function setTerminalBroadcastEnabled(tab: TerminalTab, enabled: boolean): void {
  const members = terminalBroadcastGroupIds();
  if (enabled) {
    members.add(tab.id);
  } else {
    members.delete(tab.id);
  }
  applyTerminalBroadcastMembers(members);
}

export function toggleActiveTerminalBroadcast(): void {
  const tab = activeTerminalTab();
  if (!tab) return;
  setTerminalBroadcastEnabled(tab, !tab.broadcastEnabled);
}

export function setTerminalBroadcastTarget(
  tab: TerminalTab,
  targetId: string,
  enabled: boolean,
): void {
  void tab;
  const next = terminalBroadcastGroupIds();
  if (enabled) next.add(targetId);
  else next.delete(targetId);
  applyTerminalBroadcastMembers(next);
}

export function terminalBroadcastMemberIds(tab: TerminalTab): string[] {
  void tab;
  return [...terminalBroadcastGroupIds()];
}

export function removeTerminalFromBroadcastGroup(tab: TerminalTab, memberId: string): void {
  void tab;
  const next = terminalBroadcastGroupIds();
  next.delete(memberId);
  applyTerminalBroadcastMembers(next);
}

function terminalBroadcastGroupIds(): Set<string> {
  const validIds = new Set(allTerminalTabs().map((tab) => tab.id));
  const ids = new Set<string>();
  for (const tab of allTerminalTabs()) {
    if (tab.broadcastEnabled) ids.add(tab.id);
    for (const targetId of tab.broadcastTargetIds) ids.add(targetId);
  }
  return new Set([...ids].filter((id) => validIds.has(id)));
}

function applyTerminalBroadcastMembers(members: Set<string>): void {
  const next = new Set(members);
  for (const tab of allTerminalTabs()) {
    if (!next.has(tab.id)) {
      tab.broadcastEnabled = false;
      tab.broadcastTargetIds = [];
      continue;
    }
    tab.broadcastEnabled = true;
    tab.broadcastTargetIds = [...next].filter((id) => id !== tab.id);
  }
}

export function terminalMcpEnvEnabled(tab: TerminalTab): boolean {
  return tab.mcpEnv !== false;
}

export function setTerminalMcpEnv(tab: TerminalTab, enabled: boolean): void {
  tab.mcpEnv = enabled;
}

export function setTerminalSession(
  tab: TerminalTab,
  sessionId: string,
  lastSeq: number,
  sessionMcpEnv?: boolean,
): void {
  const wasFresh = !tab.terminalSessionId || tab.terminalSessionId !== sessionId;
  tab.terminalSessionId = sessionId;
  tab.lastSeq = Math.max(0, Math.floor(lastSeq));
  if (wasFresh) {
    tab.sessionMcpEnv = sessionMcpEnv ?? terminalMcpEnvEnabled(tab);
    tab.terminalEnvTabName = terminalTabName(tab);
    tab.terminalEnvNamePromptDismissed = false;
  }
}

export function advanceTerminalSeq(tab: TerminalTab, bytes: number): void {
  if (!tab.terminalSessionId || !Number.isFinite(bytes) || bytes <= 0) return;
  tab.lastSeq = Math.max(0, Math.floor(tab.lastSeq ?? 0)) + Math.floor(bytes);
}

export function setTerminalActivity(tab: TerminalTab, active: boolean): void {
  tab.terminalActivity = active || undefined;
  // Seeing the terminal (active=false) clears the pulse too: the dot is
  // gone entirely, not left mid-pulse.
  if (!active) tab.terminalActivityPulsing = undefined;
}

/// Drive the unseen-output dot's pulse. True while output is actively
/// arriving; false once it stops (the dot goes solid while unseen).
export function setTerminalActivityPulsing(tab: TerminalTab, pulsing: boolean): void {
  tab.terminalActivityPulsing = pulsing || undefined;
}

export function clearTerminalSession(tab: TerminalTab): void {
  tab.terminalSessionId = undefined;
  tab.lastSeq = undefined;
  tab.terminalActivity = undefined;
  tab.terminalActivityPulsing = undefined;
  tab.sessionMcpEnv = undefined;
  tab.terminalEnvTabName = undefined;
  tab.terminalEnvNamePromptDismissed = false;
}

export function allTerminalTabs(): TerminalTab[] {
  return terminalTabsIn(layout);
}

/// Find a TerminalTab by its chan-server session id. Used by the team
/// orchestrator to locate the tab and populate its team-work buffer.
/// Returns null when no matching tab is open; the orchestrator silently
/// skips the lead-prompt step in that case.
export function findTerminalBySession(sessionId: string): TerminalTab | null {
  if (!sessionId) return null;
  for (const tab of allTerminalTabs()) {
    if (tab.terminalSessionId === sessionId) return tab;
  }
  return null;
}

/// Prime the Team Work buffer on a terminal tab and flag it open.
/// Mirrors `openActiveTeamWork` but without the focus nonce kick:
/// the orchestrator seeds the text and the user focuses the prompt
/// themselves to commit.
export function primeTeamWork(tab: TerminalTab, text: string): void {
  if (!tab.teamWork) {
    tab.teamWork = {
      buffer: text,
      heightPx: 320,
      open: true,
      mode: "wysiwyg",
      focusNonce: 1,
    };
    return;
  }
  tab.teamWork.buffer = text;
  tab.teamWork.open = true;
  tab.teamWork.mode ??= "wysiwyg";
}

export function hasGraphTab(): boolean {
  return Object.values(layout.nodes).some(
    (node) => node.kind === "leaf" && node.tabs.some((tab) => tab.kind === "graph"),
  );
}

export function hasBrowserTab(): boolean {
  return Object.values(layout.nodes).some(
    (node) => node.kind === "leaf" && node.tabs.some((tab) => tab.kind === "browser"),
  );
}

type TerminalInputSink = (data: string) => void;
const terminalInputSinks = new Map<string, TerminalInputSink>();
type TerminalCloseSink = () => boolean | void | Promise<boolean | void>;
const terminalCloseSinks = new Map<string, TerminalCloseSink>();

export function registerTerminalInputSink(tabId: string, sink: TerminalInputSink): () => void {
  terminalInputSinks.set(tabId, sink);
  return () => {
    if (terminalInputSinks.get(tabId) === sink) terminalInputSinks.delete(tabId);
  };
}

export function registerTerminalCloseSink(tabId: string, sink: TerminalCloseSink): () => void {
  terminalCloseSinks.set(tabId, sink);
  return () => {
    if (terminalCloseSinks.get(tabId) === sink) terminalCloseSinks.delete(tabId);
  };
}

async function runTerminalCloseSink(tab: TerminalTab): Promise<boolean> {
  const sink = terminalCloseSinks.get(tab.id);
  if (!sink) return true;
  const result = await sink();
  return result !== false;
}

async function runTerminalCloseSinks(tabs: Tab[]): Promise<boolean> {
  for (const tab of tabs) {
    if (tab.kind === "terminal" && !(await runTerminalCloseSink(tab))) {
      return false;
    }
  }
  return true;
}

/// Broadcast input is deliberately window-scoped. The target ids in
/// `broadcastTargetIds` are resolved only through this JS window's
/// `layout` registry (`allTerminalTabs()`), even though terminal
/// session data is persisted per `w=<window-label>` and multiple
/// windows can share a chan-server. A sink whose id is not present
/// in the current layout is skipped silently; do not fan out by sink
/// id alone or via a server-side bus without preserving this boundary.
export function broadcastTerminalInput(sourceTab: TerminalTab, data: string): void {
  if (!sourceTab.broadcastEnabled) return;
  const targets = new Set(terminalBroadcastMemberIds(sourceTab));
  if (targets.size === 0) return;
  for (const tab of allTerminalTabs()) {
    if (tab.id === sourceTab.id || !targets.has(tab.id)) continue;
    terminalInputSinks.get(tab.id)?.(data);
  }
}

type CloseTabsOptions = {
  force?: boolean;
};

type DraftCloseDecision =
  | { action: "cancel" }
  | { action: "discard" }
  | { action: "save"; target: string };
type DraftPromotionSink = (path: string) => void | Promise<void>;

const draftPromotionSinks = new Set<DraftPromotionSink>();

export function registerDraftPromotionSink(
  sink: DraftPromotionSink,
): () => void {
  draftPromotionSinks.add(sink);
  return () => {
    draftPromotionSinks.delete(sink);
  };
}

function notifyDraftPromoted(path: string): void {
  for (const sink of draftPromotionSinks) {
    void sink(path);
  }
}

// The draft-CLOSE modal (close a draft tab: name a destination + Save,
// or Discard). This modal is the close path only; the explicit
// "Save to Workspace" action uses `saveDraftTabToWorkspace` via
// PathPromptModal instead.
export const draftCloseState = $state<{
  open: boolean;
  path: string;
  name: string;
  target: string;
  targetKind: "file" | "folder";
  hasAttachments: boolean;
  error: string | null;
  resolve: ((value: DraftCloseDecision) => void) | null;
}>({
  open: false,
  path: "",
  name: "",
  target: "",
  targetKind: "file",
  hasAttachments: false,
  error: null,
  resolve: null,
});

function uiDraftClose(opts: {
  path: string;
  name: string;
  target: string;
  targetKind: "file" | "folder";
  hasAttachments: boolean;
}): Promise<DraftCloseDecision> {
  return new Promise((resolve) => {
    draftCloseState.resolve?.({ action: "cancel" });
    draftCloseState.path = opts.path;
    draftCloseState.name = opts.name;
    draftCloseState.target = opts.target;
    draftCloseState.targetKind = opts.targetKind;
    draftCloseState.hasAttachments = opts.hasAttachments;
    draftCloseState.error = null;
    draftCloseState.resolve = resolve;
    draftCloseState.open = true;
  });
}

export function resolveDraftClose(action: "cancel" | "discard" | "save"): void {
  const r = draftCloseState.resolve;
  if (!r) return;
  const target = draftCloseState.target.trim();
  if (action === "save" && target.length === 0) {
    draftCloseState.error = "Choose a destination path";
    return;
  }
  draftCloseState.resolve = null;
  draftCloseState.open = false;
  draftCloseState.error = null;
  if (action === "save") {
    r({ action: "save", target });
  } else {
    r({ action });
  }
}

function isLiveTerminal(t: Tab): boolean {
  return t.kind === "terminal" && terminalInputSinks.has(t.id);
}

function isDraftPath(path: string): boolean {
  return path === "Drafts" || path.startsWith("Drafts/");
}

function isDraftTab(t: Tab): t is FileTab {
  return t.kind === "file" && isDraftPath(t.path);
}

function draftDefaultTarget(info: { name: string; has_attachments: boolean }): string {
  return info.has_attachments ? info.name : `${info.name}.md`;
}

function promotedEditorPath(promoted: DraftPromoteResponse): string {
  if (promoted.mode === "file") return promoted.path;
  const dir = promoted.path.replace(/\/+$/, "");
  return dir ? `${dir}/draft.md` : "draft.md";
}

async function reloadPromotedDraftTab(tab: FileTab, path: string): Promise<void> {
  const found = findFileTabById(tab.id);
  if (!found) return;
  const pathKind = classifyPath(path);
  found.tab.fileKind =
    pathKind === "document" || pathKind === "text" ? pathKind : "document";
  found.tab.path = path;
  found.tab.mode = defaultModeForPath(path, found.tab.fileKind);
  found.tab.loading = true;
  found.tab.error = null;
  found.tab.fileMissing = null;
  found.tab.repoRoot = null;
  found.tab.fsWritable = true;
  await loadTabContent(found.paneId, found.tab.id, path);
}

function closeRisk(t: Tab): "live-terminal" | null {
  if (isLiveTerminal(t)) return "live-terminal";
  return null;
}

async function confirmCloseTabs(
  tabs: Tab[],
  opts?: CloseTabsOptions,
): Promise<boolean> {
  if (opts?.force) return true;
  if (tabs.some(isDraftTab)) {
    notify("Close Drafts individually to save or discard them");
    return false;
  }
  for (const tab of tabs) {
    if (tab.kind !== "file") continue;
    if (!isDirty(tab)) continue;
    try {
      await performSave(tab);
    } catch (e) {
      tab.error = `save failed: ${(e as Error).message}`;
      return false;
    }
    if (isDirty(tab)) return false;
  }
  const risky = tabs.filter((t) => closeRisk(t) !== null);
  if (risky.length === 0) return true;
  const terminals = risky.filter((t) => closeRisk(t) === "live-terminal");
  const parts: string[] = [];
  if (terminals.length > 0) {
    const label =
      terminals.length === 1
        ? terminalTabName(terminals[0] as TerminalTab)
        : `${terminals.length} live terminals`;
    parts.push(`${label} is still running`);
  }
  return uiConfirm({
    title: "Close tab?",
    message: `${parts.join(" and ")}. Close anyway?`,
    confirmLabel: "Close",
    destructive: false,
  });
}

/// Fetch a file tab's content from disk and write it into the
/// (proxied) pane state. Resolves the proxied reference each time it
/// touches the tab: in Svelte 5, mutations through the original
/// object literal don't propagate to the array element.
const tabLoadVersions = new Map<string, number>();
const tabLoadControllers = new Map<string, AbortController>();

async function loadTabContent(
  paneId: string,
  tabId: string,
  path: string,
): Promise<void> {
  const loadVersion = (tabLoadVersions.get(tabId) ?? 0) + 1;
  tabLoadVersions.set(tabId, loadVersion);
  tabLoadControllers.get(tabId)?.abort();
  const controller = new AbortController();
  tabLoadControllers.set(tabId, controller);
  const live = (): FileTab | undefined => {
    if (tabLoadVersions.get(tabId) !== loadVersion) return undefined;
    const node = layout.nodes[paneId];
    if (!node || node.kind !== "leaf") return undefined;
    const t = node.tabs.find((tab) => tab.id === tabId);
    return t && t.kind === "file" ? t : undefined;
  };
  try {
    const start = live();
    if (start) {
      start.content = "";
      start.saved = "";
      start.savedMtime = null;
      start.savedMtimeNs = null;
      start.loading = true;
      start.loadProgress = { loadedBytes: 0, totalBytes: null };
      start.error = null;
      start.fileMissing = null;
    }
    const r = await api.readStream(path, {
      signal: controller.signal,
      onMeta(meta) {
        const t = live();
        if (!t) {
          controller.abort();
          return;
        }
        t.savedMtime = meta.mtime ?? null;
        t.savedMtimeNs = meta.mtime_ns ?? null;
        t.repoRoot = meta.repo_root ?? null;
        t.fsWritable = meta.writable ?? true;
        t.loadProgress = {
          loadedBytes: 0,
          totalBytes: meta.size ?? null,
        };
      },
      onChunk(chunk, progress) {
        const t = live();
        if (!t) {
          controller.abort();
          return;
        }
        t.content += chunk;
        t.loadProgress = progress;
      },
    });
    const t = live();
    if (t) {
      t.content = r.content;
      t.saved = r.content;
      t.savedMtime = r.mtime ?? null;
      t.savedMtimeNs = r.mtime_ns ?? null;
      t.repoRoot = r.repo_root ?? null;
      t.error = null;
      t.fileMissing = null;
      // Older servers omit `writable`; treat absent as writable so
      // the lamp behaves the way it did before this field existed.
      t.fsWritable = r.writable ?? true;
      // The buffer now matches disk; clear any pending external-change
      // banner (this load IS the reload the user opted into, or a
      // user-initiated replace).
      t.externalChange = false;
    }
  } catch (e) {
    if (controller.signal.aborted && tabLoadVersions.get(tabId) !== loadVersion) {
      return;
    }
    const t = live();
    if (t) {
      if (isMissingFileError(e)) {
        markFileMissing(t);
      } else {
        t.error = (e as Error).message;
        t.fileMissing = null;
        t.saved = t.content;
      }
    }
  } finally {
    if (tabLoadVersions.get(tabId) === loadVersion) {
      tabLoadControllers.delete(tabId);
      const t = live();
      if (t) {
        t.loading = false;
        t.loadProgress = undefined;
      }
    }
  }
}

/// Open a file in a specific pane. If already open there, just focus.
export async function openInPane(
  paneId: string,
  path: string,
  opts: OpenFileOptions = {},
): Promise<void> {
  if (!isEditableText(path)) {
    notify(`'${path}' is not an editable text file`);
    return;
  }
  const p = pane(paneId);
  const pendingReopen =
    pendingMissingFileReopenTabId === null
      ? undefined
      : p.tabs.find(
          (t): t is FileTab =>
            t.kind === "file" &&
            t.id === pendingMissingFileReopenTabId &&
            t.fileMissing !== null,
        );
  if (pendingReopen) {
    pendingMissingFileReopenTabId = null;
    const pathKind = classifyPath(path);
    pendingReopen.fileKind =
      pathKind === "document" || pathKind === "text" ? pathKind : "document";
    pendingReopen.path = path;
    pendingReopen.content = "";
    pendingReopen.saved = "";
    pendingReopen.savedMtime = null;
    pendingReopen.savedMtimeNs = null;
    pendingReopen.mode = defaultModeForPath(path, pendingReopen.fileKind);
    pendingReopen.loading = true;
    pendingReopen.error = null;
    pendingReopen.fileMissing = null;
    pendingReopen.repoRoot = null;
    pendingReopen.fsWritable = true;
    if (opts.initialSelection) pendingReopen.caret = { ...opts.initialSelection };
    p.activeTabId = pendingReopen.id;
    layout.activePaneId = paneId;
    await loadTabContent(paneId, pendingReopen.id, path);
    return;
  }
  const existing = p.tabs.find(
    (t): t is FileTab => t.kind === "file" && t.path === path,
  );
  if (existing) {
    if (opts.initialSelection) existing.caret = { ...opts.initialSelection };
    p.activeTabId = existing.id;
    layout.activePaneId = paneId;
    return;
  }
  // Path-based classification picks the initial mode: markdown-class
  // files start in wysiwyg (the wisp of formatting they carry is
  // worth rendering); arbitrary source / config text starts in source
  // mode (wysiwyg would just render the raw bytes with no visible
  // benefit, plus the menu hides the toggle for text-kind tabs).
  const pathKind = classifyPath(path);
  const fileKind: FileKind =
    pathKind === "document" || pathKind === "text" ? pathKind : "document";
  const newTab: FileTab = {
    kind: "file",
    fileKind,
    id: id("tab"),
    path,
    content: "",
    saved: "",
    savedMtime: null,
    savedMtimeNs: null,
    mode: defaultModeForPath(path, fileKind),
    loading: true,
    error: null,
    fileMissing: null,
    inspectorOpen: false,
    outlineOpen: false,
    repoRoot: null,
    readMode: false,
    fsWritable: true,
    styleToolbarOpen: false,
    syntaxHighlight: true,
    highlightTrailingWhitespace: false,
    codeBlocksCollapsed: false,
  };
  if (opts.initialSelection) newTab.caret = { ...opts.initialSelection };
  p.tabs.push(newTab);
  p.activeTabId = newTab.id;
  layout.activePaneId = paneId;
  await loadTabContent(paneId, newTab.id, path);
}

export function openInActivePane(
  path: string,
  opts: OpenFileOptions = {},
): Promise<void> {
  return openInPane(layout.activePaneId, path, opts);
}

/// Move the active pane's selection to the previous tab. Wraps from
/// the first tab back to the last (iTerm-style cycle), so repeated
/// presses keep rotating instead of dead-ending at the edges. No-op
/// when the pane is empty or the active tab is somehow not in the
/// tab list (shouldn't happen but keeps a bad state from crashing).
///
/// Chord-driven tab switches need to also move keyboard focus to the
/// new active surface; otherwise the next keystroke lands in the prior
/// tab. Mouse-click tab switch already works because terminal tabs have
/// a `$effect` that fires on the `focused` prop flip, but some tab
/// kinds don't have an equivalent path and the chord-fired switch
/// leaves the previously-focused contenteditable holding OS focus until
/// something explicitly takes it.
///
/// Mechanism: a global $state counter bumped here. Tab-kind components
/// subscribe via $effect; when the pulse increments AND the tab is
/// focused, the component re-runs its focus routine in a microtask.
export const tabFocusPulse = $state({ value: 0 });
export function bumpTabFocusPulse(): void {
  tabFocusPulse.value += 1;
  // Blur the currently-focused element after bumping. The chord keydown
  // was synchronously dispatched while the prior tab's input had DOM
  // focus; even if the active tab changes, the prior element retains
  // `document.activeElement` until something explicitly takes focus.
  // Blurring parks focus on `<body>` so the new tab's pulse-triggered
  // focus call can land cleanly without racing the contenteditable.
  // SSR-safe; skips `<body>` so we don't blur the default focus owner.
  if (typeof document === "undefined") return;
  const el = document.activeElement;
  if (el instanceof HTMLElement && el !== document.body) {
    el.blur();
  }
}

export function selectPrevTabInActivePane(): void {
  const p = activePane();
  if (p.tabs.length === 0 || p.activeTabId === null) return;
  const idx = p.tabs.findIndex((t) => t.id === p.activeTabId);
  if (idx < 0) return;
  const next = (idx - 1 + p.tabs.length) % p.tabs.length;
  p.activeTabId = p.tabs[next].id;
  bumpTabFocusPulse();
}

export function selectNextTabInActivePane(): void {
  const p = activePane();
  if (p.tabs.length === 0 || p.activeTabId === null) return;
  const idx = p.tabs.findIndex((t) => t.id === p.activeTabId);
  if (idx < 0) return;
  const next = (idx + 1) % p.tabs.length;
  p.activeTabId = p.tabs[next].id;
  bumpTabFocusPulse();
}

/// Select the Nth tab in the active pane (0-indexed). Silent no-op
/// when the index is out of range, matching the browser behavior of
/// Cmd+9 jumping to the last tab only when nine or more exist.
export function selectTabAtIndexInActivePane(index: number): void {
  const p = activePane();
  if (index < 0 || index >= p.tabs.length) return;
  p.activeTabId = p.tabs[index].id;
  bumpTabFocusPulse();
}

function leafIdsInOrder(
  nodeId: string,
  out: string[] = [],
  state: LayoutState = activeLayout(),
): string[] {
  const n = state.nodes[nodeId];
  if (!n) return out;
  if (n.kind === "leaf") {
    out.push(n.id);
    return out;
  }
  leafIdsInOrder(n.a, out, state);
  leafIdsInOrder(n.b, out, state);
  return out;
}

export function selectPrevPane(): void {
  const current = activeLayout();
  const panes = leafIdsInOrder(current.rootId, [], current);
  if (panes.length < 2) return;
  const idx = panes.indexOf(current.activePaneId);
  if (idx < 0) return;
  current.activePaneId = panes[(idx - 1 + panes.length) % panes.length]!;
}

export function selectNextPane(): void {
  const current = activeLayout();
  const panes = leafIdsInOrder(current.rootId, [], current);
  if (panes.length < 2) return;
  const idx = panes.indexOf(current.activePaneId);
  if (idx < 0) return;
  current.activePaneId = panes[(idx + 1) % panes.length]!;
}

export function focusColorForWindow(): FocusColor {
  return layout.focusColor ?? "blue";
}

export function setWindowFocusColor(color: FocusColor): void {
  layout.focusColor = color;
  if (paneMode.draft) paneMode.draft.focusColor = color;
}

export function closeTab(
  paneId: string,
  tabId: string,
  opts?: CloseTabsOptions,
): Promise<void> {
  return closeTabAsync(paneId, tabId, opts);
}

async function closeTabAsync(
  paneId: string,
  tabId: string,
  opts?: CloseTabsOptions,
): Promise<void> {
  const p = pane(paneId);
  const idx = p.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return;
  const tab = p.tabs[idx];
  if (isDraftTab(tab) && !opts?.force) {
    if (!(await handleDraftTabClose(tab))) return;
  } else if (!(await confirmCloseTabs([tab], opts))) {
    return;
  }
  if (tab.kind === "terminal") {
    if (!(await runTerminalCloseSink(tab))) return;
  }
  rememberClosedTab(paneId, tab);
  p.tabs.splice(idx, 1);
  if (p.activeTabId === tabId) {
    p.activeTabId = p.tabs[Math.max(0, idx - 1)]?.id ?? null;
  }
  // Flip is strictly for panes with >= 1 tab; closing the last tab
  // drops any flip so the pane lands on its empty front (welcome)
  // instead of a stuck back-config surface the chord cannot undo.
  if (p.tabs.length === 0) p.showingBack = false;
  // Do NOT auto-collapse an empty Hybrid pane. Closing the last tab
  // should leave the pane in place rendering the empty landing so the
  // Hybrid structure survives a transient empty state. Use the explicit
  // `closePane` action to dismiss the pane.
}

/// Server-side seed for a brand-new draft (see
/// `crates/chan-server/src/routes/drafts.rs::NEW_DRAFT_CONTENT`).
/// A draft whose buffer matches this string and is clean against disk
/// has not been edited since creation. Treat it as empty so the close
/// path skips the "Close Draft" modal for pristine drafts.
const NEW_DRAFT_SEED = "# Draft\n";

async function handleDraftTabClose(tab: FileTab): Promise<boolean> {
  try {
    const contentIsEmpty = tab.content.trim().length === 0;
    const isPristineSeed = !isDirty(tab) && tab.content === NEW_DRAFT_SEED;
    if (!contentIsEmpty && isDirty(tab)) {
      await performSave(tab);
      if (isDirty(tab)) return false;
    }
    const info = await api.inspectDraft(tab.path);
    if ((contentIsEmpty || isPristineSeed) && !info.has_attachments) {
      await api.discardDraft(tab.path);
      notify("Draft discarded");
      return true;
    }
    const decision = await uiDraftClose({
      path: tab.path,
      name: info.name,
      target: draftDefaultTarget(info),
      targetKind: info.has_attachments ? "folder" : "file",
      hasAttachments: info.has_attachments,
    });
    if (decision.action === "cancel") return false;
    if (decision.action === "discard") {
      await api.discardDraft(tab.path);
      notify("Draft discarded");
      return true;
    }
    if (isDirty(tab)) {
      await performSave(tab);
      if (isDirty(tab)) return false;
    }
    const promoted = await api.promoteDraft(tab.path, decision.target);
    notifyDraftPromoted(promoted.path);
    notify(`Draft saved to ${promoted.path}`);
    return true;
  } catch (e) {
    tab.error = `draft close failed: ${(e as Error).message}`;
    return false;
  }
}

export async function saveDraftTabToWorkspace(tab: FileTab): Promise<boolean> {
  if (!isDraftTab(tab)) return false;
  try {
    // Lazy import to break the eager cyclic dependency with
    // store.svelte (see the import-site comment at the top of this
    // module). Resolved at user-action time, never at module-eval.
    const { uiPathPrompt } = await import("./store.svelte");
    if (isDirty(tab)) {
      await performSave(tab);
      if (isDirty(tab)) return false;
    }
    const info = await api.inspectDraft(tab.path);
    // The draft Save reuses PathPromptModal (autocomplete, live status
    // row, pre-flight validation). The draft's shape decides the dialog
    // kind, detected server-side via `has_attachments`:
    //   - lone draft.md -> a FILE target (`.md` auto-append + the
    //     editable-text check).
    //   - a draft workspace (user pasted images / opened a terminal /
    //     wrote files in the draft dir) -> a DIRECTORY target (modal's
    //     `folder` Dir-only mode: no `.md` append, trailing `/` allowed)
    //     plus a notice explaining the whole directory is saved.
    const target = info.has_attachments
      ? await uiPathPrompt({
          title: "save draft to workspace (directory)",
          defaultValue: info.name ? `${info.name}/` : "",
          kind: "folder",
          mode: "create",
          notice:
            "This draft has attachments, so the whole draft directory " +
            "is saved as a directory at the path below.",
        })
      : await uiPathPrompt({
          title: "save draft to workspace (.md added if no extension)",
          defaultValue: draftDefaultTarget(info),
          kind: "file",
          mode: "create",
          // Same editable-text gate as `fileOps.createFile`: reject
          // non-editable targets in the dialog so the error surfaces
          // before the close instead of after.
          validate: (path) =>
            isEditableText(path)
              ? null
              : `'${path}' is not an editable text file (only .md and .txt)`,
        });
    if (target === null) return false;
    // The modal resolved and validated the path (`.md` append for the
    // file case, trailing-slash folder for the dir case). `promoteDraft`
    // takes it verbatim; the trailing slash on a directory target is
    // harmless.
    if (isDirty(tab)) {
      await performSave(tab);
      if (isDirty(tab)) return false;
    }
    const promoted = await api.promoteDraft(tab.path, target);
    notifyDraftPromoted(promoted.path);
    await reloadPromotedDraftTab(tab, promotedEditorPath(promoted));
    notify(`Draft saved to ${promoted.path}`);
    return true;
  } catch (e) {
    tab.error = `draft save failed: ${(e as Error).message}`;
    return false;
  }
}

/// Drop every tab in every pane. Pane structure is preserved; only the
/// tabs go. Used by mobile reset flows so the editor stops showing a
/// now-deleted file after the user wipes the workspace.
export async function closeAllTabs(opts?: CloseTabsOptions): Promise<void> {
  const entries = Object.values(layout.nodes).flatMap((node) =>
    node.kind === "leaf" ? node.tabs.map((tab) => ({ paneId: node.id, tab })) : [],
  );
  if (!(await confirmCloseTabs(entries.map((entry) => entry.tab), opts))) return;
  for (const entry of entries) rememberClosedTab(entry.paneId, entry.tab);
  for (const node of Object.values(layout.nodes)) {
    if (node.kind !== "leaf") continue;
    node.tabs.length = 0;
    node.activeTabId = null;
  }
}

export async function closeOtherTabsInPane(
  paneId: string,
  keepTabId: string,
  opts?: CloseTabsOptions,
): Promise<void> {
  const p = pane(paneId);
  const closing = p.tabs.filter((t) => t.id !== keepTabId);
  if (closing.length === 0) return;
  if (!(await confirmCloseTabs(closing, opts))) return;
  const closeIds = new Set<string>();
  for (const tab of closing) {
    if (tab.kind === "terminal" && !(await runTerminalCloseSink(tab))) continue;
    rememberClosedTab(paneId, tab);
    closeIds.add(tab.id);
  }
  p.tabs = p.tabs.filter((t) => t.id === keepTabId || !closeIds.has(t.id));
  p.activeTabId = p.tabs.find((t) => t.id === keepTabId)?.id ?? p.tabs[0]?.id ?? null;
}

export async function closeTabsInPane(
  paneId: string,
  opts?: CloseTabsOptions,
): Promise<boolean> {
  const p = pane(paneId);
  const closing = [...p.tabs];
  if (!(await confirmCloseTabs(closing, opts))) return false;
  if (!(await runTerminalCloseSinks(closing))) return false;
  for (const tab of closing) {
    rememberClosedTab(paneId, tab);
  }
  p.tabs = [];
  p.activeTabId = null;
  // Empty pane is never flipped.
  p.showingBack = false;
  return true;
}

/// "Close pane" button. Two cases:
///   - non-root: discard all tabs and collapse the pane (sibling takes
///     the parent split's place).
///   - root pane: there must always be at least one pane on screen, so
///     just clear the tabs (returns to the empty "no file open" state).
export async function closePane(
  paneId: string,
  opts?: CloseTabsOptions,
): Promise<boolean> {
  const p = pane(paneId);
  const closing = [...p.tabs];
  if (!(await confirmCloseTabs(closing, opts))) return false;
  if (!(await runTerminalCloseSinks(closing))) return false;
  for (const tab of closing) rememberClosedTab(paneId, tab);
  p.tabs.length = 0;
  p.activeTabId = null;
  if (paneId !== layout.rootId) {
    collapseEmptyPane(paneId);
  }
  return true;
}

/// Reorder a tab within its pane. `toIndex` is the destination index
/// in the post-removal array (so e.g. moving tab 0 to index 2 in a
/// list of 4 tabs lands the tab as the new index 2).
export function reorderTab(paneId: string, tabId: string, toIndex: number): void {
  const p = pane(paneId);
  const from = p.tabs.findIndex((t) => t.id === tabId);
  if (from < 0) return;
  const clamped = Math.max(0, Math.min(toIndex, p.tabs.length - 1));
  if (from === clamped) return;
  // Snapshot the tab before splicing so the proxied entry doesn't get
  // re-wrapped in a way that confuses callers (see moveTab below).
  const src = p.tabs[from]!;
  const moved = cloneTab(src);
  p.tabs.splice(from, 1);
  p.tabs.splice(clamped, 0, moved);
  p.activeTabId = moved.id;
}

/// Plain-data copy of a tab. The deep proxy that wraps `Tab` array
/// elements doesn't survive splice + insert cleanly across panes, so
/// we re-build a fresh object literal.
function cloneTab(src: Tab): Tab {
  if (src.kind === "terminal") {
    return {
      kind: "terminal",
      id: src.id,
      title: src.title,
      createdAt: src.createdAt,
      broadcastEnabled: src.broadcastEnabled,
      broadcastTargetIds: [...src.broadcastTargetIds],
      mcpEnv: src.mcpEnv,
      sessionMcpEnv: src.sessionMcpEnv,
      terminalEnvTabName: src.terminalEnvTabName,
      terminalEnvNamePromptDismissed: src.terminalEnvNamePromptDismissed,
      terminalSessionId: src.terminalSessionId,
      controlledTerminal: src.controlledTerminal,
      lastSeq: src.lastSeq,
      cwd: src.cwd,
      seedInput: src.seedInput,
      teamWork: src.teamWork ? { ...src.teamWork } : undefined,
    };
  }
  if (src.kind === "graph") {
    return {
      kind: "graph",
      id: src.id,
      title: src.title,
      mode: src.mode,
      scopeId: src.scopeId,
      depth: src.depth,
      expanded: { ...src.expanded },
      filters: { ...src.filters },
      inspectorOpen: src.inspectorOpen,
      pendingSelectId: src.pendingSelectId,
      selectedNodeId: src.selectedNodeId,
      selectedNodeLabel: src.selectedNodeLabel,
    };
  }
  if (src.kind === "browser") {
    return {
      kind: "browser",
      id: src.id,
      title: src.title,
      inspectorOpen: src.inspectorOpen,
    };
  }
  if (src.kind === "dashboard") {
    return {
      kind: "dashboard",
      id: src.id,
      title: src.title,
    };
  }
  return {
    kind: "file",
    fileKind: src.fileKind,
    id: src.id,
    path: src.path,
    content: src.content,
    saved: src.saved,
    savedMtime: src.savedMtime,
    savedMtimeNs: src.savedMtimeNs ?? null,
    mode: src.mode,
    loading: src.loading,
    error: src.error,
    fileMissing: src.fileMissing ? { ...src.fileMissing } : null,
    inspectorOpen: src.inspectorOpen,
    outlineOpen: src.outlineOpen,
    repoRoot: src.repoRoot,
    readMode: src.readMode,
    fsWritable: src.fsWritable,
    styleToolbarOpen: src.styleToolbarOpen,
    syntaxHighlight: src.syntaxHighlight,
    highlightTrailingWhitespace: src.highlightTrailingWhitespace,
    codeBlocksCollapsed: src.codeBlocksCollapsed,
    caret: src.caret ? { ...src.caret } : undefined,
    // Find state is per-tab UI state; drop it when the tab moves
    // panes so the destination opens fresh without a half-mounted
    // bar pointing at a now-defunct adapter.
  };
}

function cloneNode(src: Node): Node {
  if (src.kind === "split") {
    return {
      kind: "split",
      id: src.id,
      direction: src.direction,
      a: src.a,
      b: src.b,
      ratio: src.ratio,
    };
  }
  return {
    kind: "leaf",
    id: src.id,
    tabs: src.tabs.map((tab) => cloneTab(tab)),
    activeTabId: src.activeTabId,
    ...(src.theme ? { theme: src.theme } : {}),
    // HybridSide is an empty marker. Preserve "back has been
    // materialized" by cloning an empty object; pane.back !== undefined
    // still discriminates Hybrid vs never-flipped.
    ...(src.back ? { back: {} } : {}),
    ...(src.showingBack ? { showingBack: true } : {}),
  };
}

function cloneLayoutState(src: LayoutState): LayoutState {
  const nodes: Record<string, Node> = {};
  for (const [id, node] of Object.entries(src.nodes)) {
    nodes[id] = cloneNode(node);
  }
  return {
    rootId: src.rootId,
    nodes,
    activePaneId: src.activePaneId,
    focusColor: src.focusColor,
  } as LayoutState;
}

export function enterPaneMode(): void {
  if (paneMode.active) return;
  paneMode.draft = cloneLayoutState(layout);
  paneMode.active = true;
  paneMode.spawnIntent = null;
  paneMode.transactionMode = false;
  paneMode.grabPaneId = null;
  paneMode.hoverPaneId = null;
  paneMode.stagedDraftEditors = [];
}

/// Mouse-driven Nav entry. `grabPaneId` is the pane the user started
/// dragging from (drag-with-payload), or null when entered via
/// double-click on the dead zone (standby until the user clicks and
/// drags inside any pane). Idempotent if already in transaction mode.
export function enterPaneModeTransaction(grabPaneId: string | null): void {
  if (!paneMode.active) {
    paneMode.draft = cloneLayoutState(layout);
    paneMode.active = true;
    paneMode.spawnIntent = null;
  }
  paneMode.transactionMode = true;
  paneMode.grabPaneId = grabPaneId;
}

/// Set the current grab pane while in transaction mode. Used when the
/// user clicks and drags inside any pane after entering via double-click,
/// or re-grabs a different pane mid-transaction. No-op outside
/// transaction mode.
export function paneModeSetGrab(paneId: string | null): void {
  if (!paneMode.transactionMode) return;
  paneMode.grabPaneId = paneId;
}

/// Track the pane currently under the cursor while a grab is held.
/// Drives the drop-target highlight. No-op outside transaction mode.
export function paneModeSetHover(paneId: string | null): void {
  if (!paneMode.transactionMode) return;
  paneMode.hoverPaneId = paneId;
}

export function commitPaneMode(): void {
  if (!paneMode.active || !paneMode.draft) return;
  // Apply any staged spawn intent into the draft before sealing so the
  // new tab lands as part of the same transaction. Callers that prime
  // side effects for a staged spawn (e.g. `revealAndSelect` for a
  // browser intent) should peek `paneMode.spawnIntent` before calling.
  if (paneMode.spawnIntent) {
    const { kind, ctx } = paneMode.spawnIntent;
    if (kind === "terminal") paneModeOpenTerminal(ctx);
    else if (kind === "browser") paneModeOpenBrowser(ctx);
    else if (kind === "graph") paneModeOpenGraph(ctx);
  }
  const next = cloneLayoutState(paneMode.draft);
  layout.rootId = next.rootId;
  layout.nodes = next.nodes;
  layout.activePaneId = next.activePaneId;
  paneMode.active = false;
  paneMode.draft = null;
  paneMode.spawnIntent = null;
  paneMode.transactionMode = false;
  paneMode.grabPaneId = null;
  paneMode.hoverPaneId = null;
  paneMode.stagedDraftEditors = [];
}

export function cancelPaneMode(): void {
  paneMode.active = false;
  paneMode.draft = null;
  paneMode.spawnIntent = null;
  paneMode.transactionMode = false;
  paneMode.grabPaneId = null;
  paneMode.hoverPaneId = null;
  paneMode.stagedDraftEditors = [];
}

/// Stage a tab spawn for commit. Replaces any previously-staged intent;
/// pressing `1` then `2` results in the second intent alone. No-op
/// outside Pane Mode.
export function paneModeStageSpawn(
  kind: PaneModeSpawnKind,
  ctx: SpawnContext,
): void {
  if (!paneMode.active) return;
  paneMode.spawnIntent = { kind, ctx };
}

export function clearPaneModeSpawnIntent(): void {
  paneMode.spawnIntent = null;
}

type Direction = "left" | "right" | "up" | "down";

function draftLayout(): LayoutState | null {
  return paneMode.active ? paneMode.draft : null;
}

function parentOf(state: LayoutState, childId: string): SplitNode | null {
  for (const node of Object.values(state.nodes)) {
    if (node.kind === "split" && (node.a === childId || node.b === childId)) {
      return node;
    }
  }
  return null;
}

function containsLeaf(state: LayoutState, nodeId: string, leafId: string): boolean {
  const node = state.nodes[nodeId];
  if (!node) return false;
  if (node.kind === "leaf") return node.id === leafId;
  return containsLeaf(state, node.a, leafId) || containsLeaf(state, node.b, leafId);
}

function extremeLeaf(state: LayoutState, nodeId: string, direction: Direction): string | null {
  const node = state.nodes[nodeId];
  if (!node) return null;
  if (node.kind === "leaf") return node.id;
  if (direction === "left") return extremeLeaf(state, node.b, direction);
  if (direction === "right") return extremeLeaf(state, node.a, direction);
  if (direction === "up") return extremeLeaf(state, node.b, direction);
  return extremeLeaf(state, node.a, direction);
}

function neighbourLeaf(state: LayoutState, leafId: string, direction: Direction): string | null {
  const wantAxis: SplitNode["direction"] =
    direction === "left" || direction === "right" ? "row" : "column";
  let current = leafId;
  let parent = parentOf(state, current);
  while (parent) {
    const inA = containsLeaf(state, parent.a, leafId);
    if (parent.direction === wantAxis) {
      if ((direction === "left" || direction === "up") && !inA) {
        return extremeLeaf(state, parent.a, direction);
      }
      if ((direction === "right" || direction === "down") && inA) {
        return extremeLeaf(state, parent.b, direction);
      }
    }
    current = parent.id;
    parent = parentOf(state, current);
  }
  return null;
}

export function paneModeMoveFocus(direction: Direction): void {
  const draft = draftLayout();
  if (!draft) return;
  const next = neighbourLeaf(draft, draft.activePaneId, direction);
  if (next) draft.activePaneId = next;
}

export function paneModeSwap(direction: Direction): void {
  const draft = draftLayout();
  if (!draft) return;
  const nextId = neighbourLeaf(draft, draft.activePaneId, direction);
  if (!nextId) return;
  paneModeSwapWith(draft.activePaneId, nextId);
}

/// Swap two arbitrary panes' contents by id. The directional
/// `paneModeSwap` reduces to this once the neighbour resolves.
/// Transaction-mode mouse drag uses this directly: grab pane is
/// `grabId`, drop target is `dropId`. Focus moves to the destination
/// so subsequent swaps chain naturally.
export function paneModeSwapWith(grabId: string, dropId: string): void {
  const draft = draftLayout();
  if (!draft) return;
  if (grabId === dropId) return;
  const a = draft.nodes[grabId];
  const b = draft.nodes[dropId];
  if (!a || a.kind !== "leaf" || !b || b.kind !== "leaf") return;
  const aTabs = a.tabs;
  const aActive = a.activeTabId;
  a.tabs = b.tabs;
  a.activeTabId = b.activeTabId;
  b.tabs = aTabs;
  b.activeTabId = aActive;
  draft.activePaneId = b.id;
  // Both panes had their content swapped, so both should
  // wobble so the user's eye tracks where their content
  // landed and which slot now holds whatever was displaced.
  requestPaneWobble(a.id);
  requestPaneWobble(b.id);
}

function nearestAncestorSplit(
  state: LayoutState,
  leafId: string,
  axis: SplitNode["direction"],
): SplitNode | null {
  let current = leafId;
  let parent = parentOf(state, current);
  while (parent) {
    if (parent.direction === axis) return parent;
    current = parent.id;
    parent = parentOf(state, current);
  }
  return null;
}

/// Hybrid Nav resize. `positive=true` shifts the divider toward the
/// right (row axis) or the bottom (column axis); `positive=false`
/// shifts it toward the left / top. Bracket-direction equals
/// divider-direction, independent of which side of the split the
/// active pane sits on. `ratio` is A's share of the split (A is the
/// left / top child), so `positive` maps directly to the delta sign.
export function paneModeResize(
  axis: SplitNode["direction"],
  positive: boolean,
  amount: number,
): void {
  const draft = draftLayout();
  if (!draft) return;
  const split = nearestAncestorSplit(draft, draft.activePaneId, axis);
  if (!split) return;
  const delta = positive ? amount : -amount;
  split.ratio = Math.max(0.05, Math.min(0.95, split.ratio + delta));
}

export function paneModeEqualize(): void {
  const draft = draftLayout();
  if (!draft) return;
  const parent = parentOf(draft, draft.activePaneId);
  if (parent) parent.ratio = 0.5;
}

/// Insert `newPane` next to `originalId` inside a layout state. Same
/// shape as the live-layout `insertSiblingPane` helper, but operates
/// on any LayoutState so it works for the Cmd+K pane-mode draft.
function insertSiblingPaneIn(
  state: LayoutState,
  originalId: string,
  newPane: LeafNode,
  direction: SplitNode["direction"],
  placement: "before" | "after",
): void {
  const original = state.nodes[originalId];
  if (!original || original.kind !== "leaf") return;
  const entries = Object.values(state.nodes);
  const parent = entries.find(
    (n): n is SplitNode =>
      n.kind === "split" && (n.a === original.id || n.b === original.id),
  );
  const split: SplitNode = {
    kind: "split",
    id: id("split"),
    direction,
    a: placement === "before" ? newPane.id : original.id,
    b: placement === "before" ? original.id : newPane.id,
    ratio: 0.5,
  };
  state.nodes[newPane.id] = newPane;
  state.nodes[split.id] = split;
  if (parent) {
    if (parent.a === original.id) parent.a = split.id;
    else parent.b = split.id;
  } else {
    state.rootId = split.id;
  }
}

/// Cmd+K mode `/` and `\\` keybinds. Splits the focused pane in the
/// draft tree only; Enter seals the split and any tabs spawned during
/// the mode, Esc rolls everything back. Structural actions are
/// constrained to right + down.
export function paneModeSplit(direction: "row" | "column"): void {
  const draft = draftLayout();
  if (!draft) return;
  const original = draft.nodes[draft.activePaneId];
  if (!original || original.kind !== "leaf") return;
  const newPane: LeafNode = {
    kind: "leaf",
    id: id("pane"),
    tabs: [],
    activeTabId: null,
  };
  insertSiblingPaneIn(draft, original.id, newPane, direction, "after");
  draft.activePaneId = newPane.id;
}

/// Context for a Pane Mode spawn key. The Cmd+K 1/2/3/4 handlers
/// resolve the focused tab into this shape before calling the spawn
/// helpers, so a new terminal lands on the source file's parent
/// directory and a new Graph tab can scope to (and pre-select) the
/// source node.
///
/// `dir` is the directory the spawn anchors to (terminal cwd, new-file
/// parent, graph dir-scope, file-browser fallback). `""` means root.
///
/// `file` is the file the source tab points at, when applicable.
/// File-Browser and Graph spawns prefer it for "select this exact node";
/// terminal / new-file always fall back to `dir`.
export type SpawnContext = {
  dir: string;
  file?: string;
};

/// Cmd+K mode `1`. Spawn a new terminal tab inside the draft's focused
/// pane. The session WebSocket opens only when the tab mounts, so an
/// Esc rollback leaves no backend state behind.
export function paneModeOpenTerminal(ctx?: SpawnContext): void {
  const draft = draftLayout();
  if (!draft) return;
  const p = draft.nodes[draft.activePaneId];
  if (!p || p.kind !== "leaf") return;
  const cwd = ctx?.dir?.trim();
  const tab: TerminalTab = {
    kind: "terminal",
    id: id("term"),
    title: nextTerminalTitle(draft),
    createdAt: Date.now(),
    broadcastEnabled: false,
    broadcastTargetIds: [],
    mcpEnv: true,
    sessionMcpEnv: undefined,
    terminalSessionId: undefined,
    controlledTerminal: undefined,
    lastSeq: undefined,
    cwd: cwd || undefined,
    seedInput: undefined,
    teamWork: undefined,
  };
  p.tabs.push(tab);
  p.activeTabId = tab.id;
}

/// Cmd+K mode `2`. Spawn a fresh File Browser tab inside the draft's
/// focused pane. Every press is a new tab so the user can pile up
/// multiple browser views. When `ctx` carries a file or dir, the
/// inspector opens so the auto-selected node lands with its info pane
/// already visible.
export function paneModeOpenBrowser(ctx?: SpawnContext): void {
  const draft = draftLayout();
  if (!draft) return;
  const p = draft.nodes[draft.activePaneId];
  if (!p || p.kind !== "leaf") return;
  const hasCtx = !!(ctx?.file || ctx?.dir);
  const tab: BrowserTab = {
    kind: "browser",
    id: id("browser"),
    title: "Files",
    inspectorOpen: hasCtx ? true : defaultBrowserInspectorOpen(),
  };
  p.tabs.push(tab);
  p.activeTabId = tab.id;
}

/// Cmd+K mode `3`. Spawn a fresh Graph tab inside the draft's focused
/// pane. Same no-dedup semantic as `paneModeOpenBrowser`. When `ctx`
/// carries a file or dir, scope the new tab to that node and pre-select
/// it; GraphPanel pops the inspector on `pendingSelectId`.
export function paneModeOpenGraph(ctx?: SpawnContext): void {
  const draft = draftLayout();
  if (!draft) return;
  const p = draft.nodes[draft.activePaneId];
  if (!p || p.kind !== "leaf") return;
  const mode: GraphTab["mode"] = "semantic";
  let scopeId = "workspace";
  let pendingSelectId: string | null = null;
  if (ctx?.file) {
    scopeId = `file:${ctx.file}`;
    pendingSelectId = ctx.file;
  } else if (ctx?.dir) {
    scopeId = `dir:${ctx.dir}`;
    pendingSelectId = ctx.dir;
  }
  const tab: GraphTab = {
    kind: "graph",
    id: id("graph"),
    title: graphTitle(mode, scopeId),
    mode,
    scopeId,
    depth: 1,
    expanded: { "": true },
    filters: { ...DEFAULT_GRAPH_FILTERS },
    inspectorOpen: false,
    pendingSelectId,
  };
  p.tabs.push(tab);
  p.activeTabId = tab.id;
}

/// Spawn a Dashboard tab inside the named pane (live layout). Mirrors
/// the shape of `openTerminalInPane` + `openBrowserInActivePane`:
/// append and flip active. No-op if the pane id doesn't resolve to a leaf.
export function openDashboardInPane(paneId: string): void {
  const node = layout.nodes[paneId];
  if (!node || node.kind !== "leaf") return;
  const tab: DashboardTab = {
    kind: "dashboard",
    id: id("dashboard"),
    title: "Dashboard",
  };
  node.tabs.push(tab);
  node.activeTabId = tab.id;
}

export function openDashboardInActivePane(): void {
  openDashboardInPane(layout.activePaneId);
}

/// Cmd+K mode `P`. Spawn a fresh Team Work terminal inside the draft's
/// focused pane: a regular terminal tab with the Team Work overlay
/// armed open and focused on first mount.
export function paneModeOpenTeamWorkTerminal(ctx?: SpawnContext): void {
  const draft = draftLayout();
  if (!draft) return;
  const p = draft.nodes[draft.activePaneId];
  if (!p || p.kind !== "leaf") return;
  const cwd = ctx?.dir?.trim();
  const tab: TerminalTab = {
    kind: "terminal",
    id: id("term"),
    title: nextTerminalTitle(draft),
    createdAt: Date.now(),
    broadcastEnabled: false,
    broadcastTargetIds: [],
    mcpEnv: true,
    sessionMcpEnv: undefined,
    terminalSessionId: undefined,
    controlledTerminal: undefined,
    lastSeq: undefined,
    cwd: cwd || undefined,
    seedInput: undefined,
    teamWork: {
      buffer: "",
      heightPx: 320,
      open: true,
      mode: "wysiwyg",
      focusNonce: 1,
    },
  };
  p.tabs.push(tab);
  p.activeTabId = tab.id;
}

/// Stage a "new draft editor" intent onto the currently-focused pane.
/// Materialization is async (needs `api.createDraft()` to mint the
/// file), so the intent queues to commit-time. Multiple presses queue
/// multiple staged drafts, each targeting the pane focused at press
/// time. `paneModeMaterializeStagedDrafts()` is the commit-time
/// resolver.
export interface StagedDraftEditor {
  paneId: string;
}
export function paneModeStageDraftEditor(): void {
  if (!paneMode.active || !paneMode.draft) return;
  const paneId = paneMode.draft.activePaneId;
  paneMode.stagedDraftEditors.push({ paneId });
}

/// Return the set of tab ids that exist in the draft but not in the
/// live layout. Consumers (Pane.svelte's tab strip) render these as
/// dimmed "ghost rows" while pane mode is open. Derived fresh each
/// call; cheaper than a parallel index given the small tab count.
export function paneModeStagedTabIds(): Set<string> {
  if (!paneMode.active || !paneMode.draft) return new Set();
  const live = new Set<string>();
  for (const node of Object.values(layout.nodes)) {
    if (node.kind === "leaf") {
      for (const t of node.tabs) live.add(t.id);
    }
  }
  const staged = new Set<string>();
  for (const node of Object.values(paneMode.draft.nodes)) {
    if (node.kind === "leaf") {
      for (const t of node.tabs) {
        if (!live.has(t.id)) staged.add(t.id);
      }
    }
  }
  return staged;
}

/// Move a tab from one pane to another. If `toIndex` is omitted the tab
/// is appended. Source pane collapses if it becomes empty.
export function moveTab(
  fromPaneId: string,
  tabId: string,
  toPaneId: string,
  toIndex?: number,
): void {
  if (fromPaneId === toPaneId) {
    if (toIndex !== undefined) reorderTab(fromPaneId, tabId, toIndex);
    return;
  }
  const from = pane(fromPaneId);
  const to = pane(toPaneId);
  const idx = from.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return;
  // Pull a plain snapshot of the tab. The proxied element won't survive
  // splice + push cleanly across pane boundaries; copying its fields
  // sidesteps the question.
  const src = from.tabs[idx]!;
  const moved = cloneTab(src);
  from.tabs.splice(idx, 1);
  if (from.activeTabId === tabId) {
    from.activeTabId = from.tabs[Math.max(0, idx - 1)]?.id ?? null;
  }
  if (toIndex === undefined || toIndex >= to.tabs.length) {
    to.tabs.push(moved);
  } else {
    to.tabs.splice(Math.max(0, toIndex), 0, moved);
  }
  to.activeTabId = moved.id;
  layout.activePaneId = to.id;
  if (from.tabs.length === 0 && layout.rootId !== from.id) {
    collapseEmptyPane(from.id);
  }
}

export type PaneDropEdge = "left" | "right" | "top" | "bottom";

/// Detach a tab into a new sibling pane at the requested edge of the
/// target leaf. This is the body-drop counterpart to `moveTab`:
/// tab-bar drops merge tab lists, body-edge drops split the target
/// pane and make the moved tab the new sibling content.
export function detachTabToPaneEdge(
  fromPaneId: string,
  tabId: string,
  targetPaneId: string,
  edge: PaneDropEdge,
): void {
  const fromNode = layout.nodes[fromPaneId];
  const targetNode = layout.nodes[targetPaneId];
  if (!fromNode || fromNode.kind !== "leaf") return;
  if (!targetNode || targetNode.kind !== "leaf") return;

  const idx = fromNode.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return;
  if (fromPaneId === targetPaneId && fromNode.tabs.length <= 1) return;

  const moved = cloneTab(fromNode.tabs[idx]!);
  fromNode.tabs.splice(idx, 1);
  if (fromNode.activeTabId === tabId) {
    fromNode.activeTabId = fromNode.tabs[Math.max(0, idx - 1)]?.id ?? null;
  }
  if (fromNode.tabs.length === 0 && fromNode.id !== targetNode.id && layout.rootId !== fromNode.id) {
    collapseEmptyPane(fromNode.id);
  }

  const target = layout.nodes[targetPaneId];
  if (!target || target.kind !== "leaf") return;
  const newPane: LeafNode = {
    kind: "leaf",
    id: id("pane"),
    tabs: [moved],
    activeTabId: moved.id,
  };
  const direction: SplitNode["direction"] =
    edge === "left" || edge === "right" ? "row" : "column";
  const placement: "before" | "after" =
    edge === "left" || edge === "top" ? "before" : "after";
  insertSiblingPane(target.id, newPane, direction, placement);
  layout.activePaneId = newPane.id;
}

function collapseEmptyPane(emptyId: string): void {
  // Find the parent split.
  const entries = Object.values(layout.nodes);
  const parent = entries.find(
    (n): n is SplitNode => n.kind === "split" && (n.a === emptyId || n.b === emptyId),
  );
  if (!parent) return;
  const siblingId = parent.a === emptyId ? parent.b : parent.a;
  const grand = entries.find(
    (n): n is SplitNode => n.kind === "split" && (n.a === parent.id || n.b === parent.id),
  );
  if (grand) {
    if (grand.a === parent.id) grand.a = siblingId;
    else grand.b = siblingId;
  } else {
    // parent is root.
    layout.rootId = siblingId;
  }
  delete layout.nodes[parent.id];
  delete layout.nodes[emptyId];
  // If the active pane was the emptied one, fall back to the sibling.
  if (layout.activePaneId === emptyId) layout.activePaneId = firstLeafId(siblingId);
  // Wobble the leaf that just absorbed the freed space so the
  // user has a visual anchor on where their attention should
  // land. If the sibling was a split, wobble its first leaf;
  // the rest of the subtree just inherits the new dimensions
  // without wobble (cheaper, and the focal point is enough).
  const absorber = firstLeafId(siblingId);
  if (absorber) requestPaneWobble(absorber);
}


/// Splits are uncapped. Kept as a function (rather than removing
/// every call site) because Pane.svelte and `splitActive` both go
/// through it; if a future surface needs a cap, this is the choke
/// point.
export function canSplit(): boolean {
  return true;
}

export function splitActive(direction: "row" | "column"): void {
  splitPane(layout.activePaneId, direction, "after");
}

/// Materialize an R×C grid of panes starting from `startPaneId`.
/// Returns the pane IDs in row-major order (`cells[r * cols + c]`).
///
/// Strategy:
///   1. Build a top row of `cols` panes by splitting horizontally
///      from the starting pane `cols - 1` times. Each split adds a
///      pane to the RIGHT.
///   2. For each column-head, split vertically `rows - 1` times.
///      Each split adds a pane BELOW.
///
/// Side effect: `layout.activePaneId` ends on the bottom-right pane.
/// Callers that need focus on a specific pane restore it afterwards.
/// For `1×1` grids the helper short-circuits with `[startPaneId]`.
export function buildSplitGrid(
  startPaneId: string,
  rows: number,
  cols: number,
): string[] {
  if (rows <= 1 && cols <= 1) return [startPaneId];
  // Step 1: top row of column-heads.
  const columnHeads: string[] = [startPaneId];
  for (let c = 1; c < cols; c += 1) {
    splitPane(columnHeads[c - 1], "row", "after");
    columnHeads.push(layout.activePaneId);
  }
  // Step 2: build down each column to populate the rest of the
  // grid. `grid[r][c]` is the pane at row r, column c.
  const grid: string[][] = Array.from({ length: rows }, () =>
    Array<string>(cols).fill(""),
  );
  for (let c = 0; c < cols; c += 1) {
    grid[0][c] = columnHeads[c];
    for (let r = 1; r < rows; r += 1) {
      splitPane(grid[r - 1][c], "column", "after");
      grid[r][c] = layout.activePaneId;
    }
  }
  // Flatten row-major to match the dialog's slot ordering
  // (`TeamRealEstate.slots[i]` is cell i in row-major).
  const flat: string[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) flat.push(grid[r][c]);
  }
  return flat;
}

export function splitPane(
  paneId: string,
  direction: "row" | "column",
  placement: "before" | "after" = "after",
): void {
  if (!canSplit()) return;
  const original = pane(paneId);
  // New panes are born empty and must NOT inherit the original's flip.
  // A flipped state belongs strictly to a pane with >= 1 tab; copying
  // showingBack onto a 0-tab pane produces a stuck "flipped empty pane"
  // the chord cannot undo.
  const newPane: LeafNode = {
    kind: "leaf",
    id: id("pane"),
    tabs: [],
    activeTabId: null,
  };
  insertSiblingPane(original.id, newPane, direction, placement);
  layout.activePaneId = newPane.id;
  requestPaneWobble(original.id);
  requestPaneWobble(newPane.id);
}

function insertSiblingPane(
  originalId: string,
  newPane: LeafNode,
  direction: SplitNode["direction"],
  placement: "before" | "after",
): void {
  const original = pane(originalId);
  // Find parent of original so we can replace original with a new split.
  const entries = Object.values(layout.nodes);
  const parent = entries.find(
    (n): n is SplitNode => n.kind === "split" && (n.a === original.id || n.b === original.id),
  );
  const split: SplitNode = {
    kind: "split",
    id: id("split"),
    direction,
    a: placement === "before" ? newPane.id : original.id,
    b: placement === "before" ? original.id : newPane.id,
    ratio: 0.5,
  };
  layout.nodes[newPane.id] = newPane;
  layout.nodes[split.id] = split;
  if (parent) {
    if (parent.a === original.id) parent.a = split.id;
    else parent.b = split.id;
  } else {
    layout.rootId = split.id;
  }
}

export function setActivePane(paneId: string): void {
  const current = activeLayout();
  if (current.nodes[paneId]?.kind !== "leaf") return;
  // Single-shot wobble cue on keyboard / click pane-switch, mirroring
  // the bounce already fired by split / close / pane-move. Only fire
  // when the active pane actually CHANGES so re-clicks on the same
  // pane (already-focused) stay quiet; otherwise the wobble would
  // re-trigger on every mousedown that lands on the focused pane.
  const previousActive = current.activePaneId;
  // Focus changes must NOT touch any pane's `showingBack`. The flip is
  // a per-pane boolean owned solely by flipHybrid on the focused,
  // non-empty pane; each pane keeps its own state independently and
  // across reloads. Coupling this to focus causes moving focus to visibly
  // flip sibling tabs.
  current.activePaneId = paneId;
  if (previousActive !== paneId) requestPaneWobble(paneId);
}

/// Flip the pane between its front (content tabs) and its back
/// (per-surface configuration view). `pane.tabs` always stays the
/// front's tab list. `pane.theme` is the single per-Hybrid theme
/// value; this function only toggles `showingBack`.
export function flipHybrid(paneId: string): void {
  const node = activeLayout().nodes[paneId];
  if (!node || node.kind !== "leaf") return;
  // Empty pane has no surface to flip; guard so the chrome animation
  // does not fire on an empty pane.
  if (node.tabs.length === 0) return;
  if (!node.back) {
    // Lazy init: materialise an empty back marker so `pane.back !== undefined`
    // gates the hamburger Theme / Flip entries. `pane.theme` owns the
    // single per-Hybrid theme value.
    node.back = {};
  }
  node.showingBack = !node.showingBack;
  // Orientation-change cue (Y-axis rotation), distinct from the
  // structural wobble used for split / close / swap.
  requestPaneFlip(node.id);
}

export function setMode(tab: Tab, mode: Mode): void {
  if (tab.kind === "file") tab.mode = mode;
}

/// Flip the active pane's file tab between source and the rendered
/// surface. Routed via the Mod+E chord and the editor's right-click
/// "Show Source Code" entry. Caret remap lives inside
/// `FileEditorTab.svelte`'s `doToggleMode`; this helper does the basic
/// flip and lets the editor's internal effect handle position fidelity.
/// No-op when the active tab isn't a file tab.
export function toggleActiveFileTabMode(): void {
  const node = layout.nodes[layout.activePaneId];
  if (!node || node.kind !== "leaf") return;
  const tab = node.tabs.find((t) => t.id === node.activeTabId);
  if (!tab || tab.kind !== "file") return;
  tab.mode = tab.mode === "source" ? "wysiwyg" : "source";
}

/// Tab-state mutators. These exist so child components (FileEditorTab
/// etc.) don't write tab.X = ... directly on a non-bindable prop - /// Svelte 5's ownership tracking warns about that pattern. Centralizing
/// the writes here also gives us one place to add side-effects
/// (persistence, telemetry) later.
export function setTabCaret(tab: FileTab, from: number, to: number): void {
  tab.caret = { from, to };
}
export function setTabInspectorOpen(tab: FileTab, open: boolean): void {
  tab.inspectorOpen = open;
}
export function setTabOutlineOpen(tab: FileTab, open: boolean): void {
  tab.outlineOpen = open;
}
export function setTabStyleToolbarOpen(tab: FileTab, open: boolean): void {
  tab.styleToolbarOpen = open;
}
export function setTabSyntaxHighlight(tab: FileTab, on: boolean): void {
  tab.syntaxHighlight = on;
}
export function setTabHighlightTrailingWhitespace(tab: FileTab, on: boolean): void {
  tab.highlightTrailingWhitespace = on;
}
export function setTabCodeBlocksCollapsed(tab: FileTab, collapsed: boolean): void {
  tab.codeBlocksCollapsed = collapsed;
}

/// Whether a tab represents an unsaved buffer.
export function isDirty(t: Tab): boolean {
  if (t.kind !== "file") return false;
  if (t.loading) return false;
  return t.content !== t.saved;
}

// ---- autosave + CAS conflict prompt -------------------------------------

// Debounce window for idle autosave. Picked short enough that data loss
// from a crash is small, long enough that bursty typing doesn't
// hammer the disk + watcher.
const AUTOSAVE_DEBOUNCE_MS = 800;
const autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const savingTabs = new Set<string>();
const saveAgainAfterCurrent = new Set<string>();
let pendingMissingFileReopenTabId: string | null = null;

/// Conflict dialog state. Populated when a save returns 409 (an
/// external edit landed since we last read this tab). Mounted by
/// ConflictModal.svelte; closed via reloadConflictedTab,
/// overwriteConflictedTab, or dismissConflict.
export const conflictDialog = $state<{
  open: boolean;
  /// Tab the conflict is for. Null when the dialog is closed.
  tabId: string | null;
  /// Tab path for display in the dialog (the user shouldn't have to
  /// guess which tab triggered the prompt).
  path: string;
  /// Mtime currently on disk per the server's 409 body. Used as the
  /// next CAS token whether the user reloads (refetch with this
  /// token) or overwrites (write with this token; another conflict
  /// re-prompts if a third edit landed in the meantime).
  currentMtime: number | null;
  currentMtimeNs: string | null;
}>({ open: false, tabId: null, path: "", currentMtime: null, currentMtimeNs: null });

export function dismissConflict(): void {
  conflictDialog.open = false;
  conflictDialog.tabId = null;
  conflictDialog.path = "";
  conflictDialog.currentMtime = null;
  conflictDialog.currentMtimeNs = null;
}

function findFileTabById(tabId: string): { paneId: string; tab: FileTab } | null {
  for (const [paneId, node] of Object.entries(layout.nodes)) {
    if (node.kind !== "leaf") continue;
    const tab = node.tabs.find((t) => t.id === tabId);
    if (tab && tab.kind === "file") return { paneId, tab };
  }
  return null;
}

/// Discard the in-memory buffer for the conflicted tab and re-fetch
/// from disk. The user picked Reload: their unsaved edits go away,
/// the disk version takes over.
export async function reloadConflictedTab(): Promise<void> {
  const tabId = conflictDialog.tabId;
  dismissConflict();
  if (!tabId) return;
  const found = findFileTabById(tabId);
  if (!found) return;
  await loadTabContent(found.paneId, found.tab.id, found.tab.path);
}

/// Adopt the server-reported on-disk mtime as the new CAS token and
/// save the in-memory buffer. The CAS check matches, so the write
/// goes through (unless ANOTHER external edit landed since the 409
/// was issued, in which case we re-prompt).
export async function overwriteConflictedTab(): Promise<void> {
  const tabId = conflictDialog.tabId;
  const currentMtime = conflictDialog.currentMtime;
  const currentMtimeNs = conflictDialog.currentMtimeNs;
  dismissConflict();
  if (!tabId) return;
  const found = findFileTabById(tabId);
  if (!found) return;
  found.tab.savedMtime = currentMtime;
  found.tab.savedMtimeNs = currentMtimeNs;
  await performSave(found.tab);
}

/// Single source of truth for "send this tab's content to the
/// server". Both autosave and explicit saveTab funnel through here.
/// On 409, opens the conflict dialog and returns; the dialog's
/// Reload / Overwrite buttons workspace the recovery.
///
/// Format-specific pre-checks live here so the gate is uniform
/// across autosave and Cmd+S. Today only JSON is validated:
/// writing invalid JSON onto disk would surface as a parse error
/// the next time a tool / our own pretty viewer reads the file,
/// which is too late to recover the user's typo. Refusing the
/// write at the editor boundary keeps the file system honest.
async function performSave(t: FileTab): Promise<void> {
  if (savingTabs.has(t.id)) {
    saveAgainAfterCurrent.add(t.id);
    return;
  }
  savingTabs.add(t.id);
  try {
    do {
      saveAgainAfterCurrent.delete(t.id);
      await performSaveOnce(t);
    } while (saveAgainAfterCurrent.has(t.id) && t.content !== t.saved);
  } finally {
    savingTabs.delete(t.id);
    saveAgainAfterCurrent.delete(t.id);
  }
}

async function performSaveOnce(t: FileTab): Promise<void> {
  if (t.loading) {
    t.error = "file is still loading";
    return;
  }
  if (isJson(t.path)) {
    const reason = validateJsonBuffer(t.content);
    if (reason !== null) {
      t.error = `JSON parse error: ${reason}`;
      return;
    }
  }
  const path = t.path;
  const sourceContent = t.content;
  const stripOnSave = editorToolsPrefs.stripTrailingWhitespaceOnSave;
  const content = stripOnSave
    ? stripTrailingWhitespaceText(sourceContent)
    : sourceContent;
  const expectedMtimeNs = t.savedMtimeNs ?? null;
  const expectedMtime = t.savedMtime;
  try {
    const r = await api.write(path, content, expectedMtimeNs, expectedMtime);
    if (stripOnSave && content !== sourceContent && t.content === sourceContent) {
      t.content = content;
    }
    t.saved = content;
    t.savedMtime = r.mtime ?? null;
    t.savedMtimeNs = r.mtime_ns ?? null;
    t.error = null;
    t.fileMissing = null;
    mirrorToSiblings(path, content, t.id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      const data = e.data as {
        current_mtime?: number | null;
        current_mtime_ns?: string | null;
      } | null;
      conflictDialog.open = true;
      conflictDialog.tabId = t.id;
      conflictDialog.path = t.path;
      conflictDialog.currentMtime = data?.current_mtime ?? null;
      conflictDialog.currentMtimeNs = data?.current_mtime_ns ?? null;
      return;
    }
    throw e;
  }
}

/// Return null when `src` parses as JSON, otherwise the
/// JSON.parse error message. An empty / whitespace-only buffer is
/// accepted: a fresh `.json` file the user has not yet typed into
/// is allowed to round-trip empty.
function validateJsonBuffer(src: string): string | null {
  if (src.trim() === "") return null;
  try {
    JSON.parse(src);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/// Schedule (or reschedule) a save for `tab` in `pane`. Multiple
/// rapid calls coalesce: only the last one's timer fires.
export function scheduleAutosave(paneId: string, tabId: string): void {
  const existing = autosaveTimers.get(tabId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    autosaveTimers.delete(tabId);
    const node = layout.nodes[paneId];
    if (!node || node.kind !== "leaf") return;
    const t = node.tabs.find((tab) => tab.id === tabId);
    if (!t || t.kind !== "file") return;
    if (t.loading || t.content === t.saved) return;
    try {
      await performSave(t);
    } catch (e) {
      t.error = `autosave failed: ${(e as Error).message}`;
    }
  }, AUTOSAVE_DEBOUNCE_MS);
  autosaveTimers.set(tabId, timer);
}

/// After a save, sync the new content into every other tab pointing
/// at the same path so the duplicate views don't drift. Skip tabs
/// that have their own dirty buffer (they have local edits the
/// user hasn't saved yet, and overwriting would silently destroy
/// work). Those stay divergent and the user can resolve manually;
/// the dirty dot already signals the divergence.
function mirrorToSiblings(path: string, content: string, originId: string): void {
  for (const node of Object.values(layout.nodes)) {
    if (node.kind !== "leaf") continue;
    for (const sib of node.tabs) {
      if (sib.kind !== "file") continue;
      if (sib.id === originId) continue;
      if (sib.path !== path) continue;
      // Honor an unsaved buffer in the sibling; don't clobber.
      if (sib.content !== sib.saved) continue;
      sib.content = content;
      sib.saved = content;
      sib.error = null;
      sib.fileMissing = null;
    }
  }
}

export function isMissingFileError(e: unknown): boolean {
  if (e instanceof ApiError && e.status === 404) return true;
  const msg = String((e as Error | null)?.message ?? e).toLowerCase();
  return (
    msg.includes("no such file") ||
    msg.includes("not found") ||
    msg.includes("os error 2") ||
    msg.includes("enoent")
  );
}

function missingFragment(content: string): string | null {
  const normalized = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length >= 8);
  if (!normalized) return null;
  return normalized.length > 80 ? normalized.slice(0, 80) : normalized;
}

function markFileMissing(t: FileTab): void {
  t.error = null;
  t.loading = false;
  t.fileMissing = {
    path: t.path,
    fragment: missingFragment(t.content || t.saved),
  };
}

/// Set of paths with unsaved changes across all panes. Used by the
/// file tree to surface the same dirty indicator the per-tab UI shows.
export function dirtyPaths(): Set<string> {
  const out = new Set<string>();
  for (const node of Object.values(layout.nodes)) {
    if (node.kind !== "leaf") continue;
    for (const t of node.tabs) {
      if (t.kind === "file" && !t.loading && t.content !== t.saved) out.add(t.path);
    }
  }
  return out;
}

// ---- serialization for URL-based persistence -----------------------------

// Tree-shaped serialized form. We store the layout as a recursive
// shape without IDs; restore generates fresh IDs. Tabs carry just
// enough to reconstruct each variant.
//   k: "f" file tab (the only kind today; older sessions may carry
//      "b" browser, "s" settings, "g" graph, "h" health, all silently
//      dropped on restore since each became a window-level overlay).
//   p,m,o only meaningful for files
//   a: active tab in this pane (one per pane)
//   f: focused pane (one per layout)
type SerTab = {
  k?: "f" | "b" | "s" | "g" | "h" | "t" | "d";
  p?: string;
  n?: string;
  m?: Mode;
  a?: 1;
  o?: 1;
  /// Outline pane (left-side) visibility. Default off, so we only
  /// emit `ol: 1` when the user has opted the outline in.
  ol?: 1;
  /// Style toolbar visibility. Default is "hidden" for new tabs;
  /// we only emit `s: 1` when the user explicitly enabled it so
  /// the common case keeps the hash short. Restores without the
  /// field land on the default.
  s?: 1;
  /// User-toggled read mode. Default is write; we only emit
  /// `r: 1` when the user explicitly flipped a tab into read
  /// mode so the common case keeps the hash short. fsWritable
  /// is NOT persisted (it's a disk property; refreshed on first
  /// loadTabContent).
  r?: 1;
  /// Persisted caret as `[from, to]`. Omitted when at offset 0 so
  /// fresh tabs keep the hash short. The active editor mirrors
  /// `tab.caret` here on every selection change.
  c?: [number, number];
  /// Syntax-highlight toggle. Default is "on" so we only emit
  /// `h: 0` when the user has explicitly disabled highlighting
  /// for this tab. Restores without the field land on default-on.
  h?: 0;
  /// Terminal PTY session id. Only emitted in the per-window
  /// session payload, never in the shareable URL hash.
  tsid?: string;
  /// Active Team Work workspace identity. Only emitted in the
  /// per-window session payload, alongside `tsid`.
  rpn?: string;
  rpsq?: number;
  /// Terminal was created through the HTTP control channel; restart
  /// uses the server-side restart endpoint.
  tc?: 1;
  /// Legacy byte-sequence offset. Ignored on restore so a reload
  /// replays the full server ring into a fresh xterm buffer.
  tseq?: number;
  /// Desired MCP env injection for fresh terminal sessions. Default on.
  me?: 0;
  /// MCP env mode used by the persisted PTY session. Default on.
  sme?: 0;
  /// Team Work draft state. Only emitted in per-window session payloads,
  /// never in shareable URL hashes.
  rpb?: string;
  rph?: number;
  rpo?: 1;
  rpm?: "w" | "s";
  /// Team-work collapsed flag. `1` when the user collapsed the prompt
  /// to its minimal-height bar; absent otherwise.
  rpc?: 1;
  /// Per-prompt page-width ratio in (0.25, 1.0). Absence reads as
  /// "no cap" (decoupled from the global `pageWidth.ratio`).
  rppw?: number;
  /// Per-prompt shell-vs-agent submit-mode toggle. `"a"` means Agent;
  /// absent means Shell (default).
  rpsm?: "a";
  rpa?: "c" | "x" | "g";
  /// Graph tab state.
  gm?: "s" | "f" | "l";
  gs?: string;
  gd?: number;
  gi?: 1;
  gf?: string;
  /// Expanded directory paths for the filesystem spine (graph expand /
  /// collapse). Workspace-relative; the root ("") is always expanded and
  /// omitted. Absent when nothing beyond the root is open.
  ge?: string[];
  gp?: string;
  /// Persisted live selection: `gn` is the last-tapped graph node id,
  /// `gnl` is the cached human-readable label so the tab title renders
  /// before graph data finishes reloading.
  gn?: string;
  gnl?: string;
  /// Browser tab state.
  bi?: 1;
  /// Per-tab File Browser view state. Selection (`bs`), workspace-info-
  /// showing flag (`bd`), expanded directory paths (`be`), and scroll
  /// offset (`bsc`). All optional; absence means default state.
  bs?: string;
  bd?: 1;
  be?: string[];
  bsc?: number;
  /// Per-tab inspector / outline widths. `iw` covers BrowserTab +
  /// GraphTab + FileTab; `ow` is FileTab only (outline pane). Emitted
  /// only when set so single-tab hashes stay clean.
  iw?: number;
  ow?: number;
  /// DashboardTab carousel slide cursor. 0 (the About slide, the
  /// default) is omitted to keep the hash compact.
  cs?: number;
};
type SerFocusColor = "o" | "g" | "p";
type SerHybridTheme = "d" | "l";
type SerLeaf = {
  k: "l";
  t: SerTab[];
  f?: 1;
  wc?: SerFocusColor;
  pc?: SerFocusColor;
  /// Per-pane Hybrid back-side state. The back is a per-surface
  /// configuration view; `pane.theme` is the single per-Hybrid theme.
  /// Wire-compat: legacy `bt` and `hb` fields from older sessions are
  /// parsed and discarded on rehydrate; the front-side `ht` wins.
  /// `ht`: per-Hybrid theme override.
  /// `sb`: `1` when the pane is currently flipped to its back view.
  /// `bm`: `1` when the pane has been flipped at least once.
  ht?: SerHybridTheme;
  sb?: 1;
  bm?: 1;
  /// Legacy: back-side tabs and back-side theme override from older
  /// sessions. Ignored on rehydrate for wire compat.
  bt?: SerTab[];
  hb?: SerHybridTheme;
};
type SerSplit = {
  k: "s";
  d: "r" | "c";
  a: SerNode;
  b: SerNode;
  r?: number;
  wc?: SerFocusColor;
};
type SerNode = SerLeaf | SerSplit;

function serializeFocusColor(color: FocusColor | undefined): { wc?: SerFocusColor } {
  if (color === "orange") return { wc: "o" };
  if (color === "green") return { wc: "g" };
  if (color === "pink") return { wc: "p" };
  return {};
}

function restoreFocusColor(color: SerFocusColor | undefined): FocusColor {
  if (color === "o") return "orange";
  if (color === "g") return "green";
  if (color === "p") return "pink";
  return "blue";
}

/// Expanded directory paths for a graph tab, excluding the always-open
/// root. Used to serialize the filesystem-spine expand/collapse state.
function graphExpandedList(expanded: Record<string, boolean>): string[] {
  return Object.keys(expanded).filter((k) => k && expanded[k]);
}

/// Rebuild a graph tab's expanded set from its serialized path list. The
/// root ("") is always expanded.
function graphExpandedFromList(
  list: string[] | undefined,
): Record<string, boolean> {
  const map: Record<string, boolean> = { "": true };
  if (Array.isArray(list)) {
    for (const p of list) if (typeof p === "string" && p) map[p] = true;
  }
  return map;
}

function encodeGraphTabFilters(f: GraphFilters): string {
  // The leading `2` is a version sentinel so the decoder can tell a
  // legacy payload (no prefix; missing `d`/`s` default ON) from a
  // current payload (prefix present; missing `d`/`s` mean explicit OFF).
  return [
    "2",
    f.link ? "l" : "",
    f.tag ? "t" : "",
    f.mention ? "m" : "",
    f.language ? "a" : "",
    f.img ? "i" : "",
    f.folder ? "f" : "",
    f.markdown ? "d" : "",
    f.source ? "s" : "",
  ].join("");
}

function decodeGraphTabFilters(s: string | undefined): GraphFilters {
  const src = s ?? "2ltmaifds";
  // A leading `2` marks the current payload format. Without it the
  // payload is from an older session and `markdown` / `source` default
  // ON; with it, missing chars are explicit OFF.
  const isV2 = src.startsWith("2");
  return {
    link: src.includes("l"),
    tag: src.includes("t"),
    mention: src.includes("m"),
    language: src.includes("a"),
    img: src.includes("i"),
    folder: src.includes("f"),
    markdown: isV2 ? src.includes("d") : true,
    source: isV2 ? src.includes("s") : true,
  };
}

function restoreGraphMode(mode: SerTab["gm"]): GraphTab["mode"] {
  if (mode === "f") return "filesystem";
  if (mode === "l") return "language";
  return "semantic";
}

/// Walk the layout starting at `nodeId`, producing a serializable tree.
function serializeTab(
  t: Tab,
  isActive: boolean,
  opts: SerializeLayoutOptions,
): SerTab {
  const active = isActive ? { a: 1 as const } : {};
  if (t.kind === "terminal") {
    return {
      k: "t",
      n: t.title,
      ...(opts.terminalSessions && t.mcpEnv === false ? { me: 0 as const } : {}),
      ...(opts.terminalSessions && t.terminalSessionId
        ? {
            tsid: t.terminalSessionId,
            ...(t.sessionMcpEnv === false ? { sme: 0 as const } : {}),
            ...(t.controlledTerminal ? { tc: 1 as const } : {}),
          }
        : {}),
      ...(opts.terminalSessions && t.teamWork
        ? {
            rpb: t.teamWork.buffer,
            ...(t.teamWork.heightPx
              ? { rph: Math.max(1, Math.floor(t.teamWork.heightPx)) }
              : {}),
            ...(t.teamWork.open ? { rpo: 1 as const } : {}),
            ...(t.teamWork.mode === "source" ? { rpm: "s" as const } : {}),
            ...(t.teamWork.collapsed ? { rpc: 1 as const } : {}),
            ...(typeof t.teamWork.pageWidthRatio === "number" &&
            Number.isFinite(t.teamWork.pageWidthRatio) &&
            t.teamWork.pageWidthRatio > 0 &&
            t.teamWork.pageWidthRatio < 1
              ? { rppw: t.teamWork.pageWidthRatio }
              : {}),
            ...(t.teamWork.submitMode === "agent" ? { rpsm: "a" as const } : {}),
            ...(t.teamWork.agentTarget && t.teamWork.agentTarget !== "none"
              ? {
                  rpa:
                    t.teamWork.agentTarget === "codex"
                      ? "x"
                      : t.teamWork.agentTarget === "gemini"
                        ? "g"
                        : "c",
                }
              : {}),
            ...(t.teamWork.workspaceName ? { rpn: t.teamWork.workspaceName } : {}),
            ...(typeof t.teamWork.submissionSequence === "number" &&
            Number.isFinite(t.teamWork.submissionSequence)
              ? { rpsq: Math.max(0, Math.floor(t.teamWork.submissionSequence)) }
              : {}),
          }
        : {}),
      ...active,
    };
  }
  if (t.kind === "graph") {
    return {
      k: "g",
      gm: t.mode === "filesystem" ? "f" : t.mode === "language" ? "l" : "s",
      gs: t.scopeId,
      ...(t.depth !== 1 ? { gd: t.depth } : {}),
      ...(t.inspectorOpen ? { gi: 1 as const } : {}),
      gf: encodeGraphTabFilters(t.filters),
      ...(graphExpandedList(t.expanded).length
        ? { ge: graphExpandedList(t.expanded) }
        : {}),
      ...(t.pendingSelectId ? { gp: t.pendingSelectId } : {}),
      // Persist the live selection so reload restores both the selected
      // node and the selection-driven tab title before data reloads.
      ...(t.selectedNodeId ? { gn: t.selectedNodeId } : {}),
      ...(t.selectedNodeLabel ? { gnl: t.selectedNodeLabel } : {}),
      ...(t.inspectorWidth && t.inspectorWidth > 0
        ? { iw: Math.round(t.inspectorWidth) }
        : {}),
      ...active,
    };
  }
  if (t.kind === "browser") {
    const expanded = t.expanded?.filter((p) => p.length > 0) ?? [];
    return {
      k: "b",
      ...(t.inspectorOpen ? { bi: 1 as const } : {}),
      ...(t.selected ? { bs: t.selected } : {}),
      ...(t.showWorkspace ? { bd: 1 as const } : {}),
      ...(expanded.length > 0 ? { be: expanded } : {}),
      ...(t.scroll && t.scroll > 0 ? { bsc: Math.round(t.scroll) } : {}),
      ...(t.inspectorWidth && t.inspectorWidth > 0
        ? { iw: Math.round(t.inspectorWidth) }
        : {}),
      ...active,
    };
  }
  if (t.kind === "dashboard") {
    return {
      k: "d",
      // Persist the carousel slide so reload restores the user to the
      // slide they were on. Skip at default (0) to keep the hash short.
      ...(typeof t.carouselSlide === "number" && t.carouselSlide > 0
        ? { cs: t.carouselSlide }
        : {}),
      ...active,
    };
  }
  // Only file tabs left; omit `k:"f"` since `"f"` is the default.
  // Skip the caret field when it sits at the doc start. New tabs
  // (and never-focused restored tabs) have caret==undefined; only
  // emit it when the user has moved off offset 0.
  const c =
    t.caret && (t.caret.from !== 0 || t.caret.to !== 0)
      ? { c: [t.caret.from, t.caret.to] as [number, number] }
      : {};
  return {
    p: t.path,
    m: t.mode,
    ...active,
    ...(t.inspectorOpen ? { o: 1 as const } : {}),
    ...(t.outlineOpen ? { ol: 1 as const } : {}),
    ...(t.styleToolbarOpen ? { s: 1 as const } : {}),
    ...(t.readMode ? { r: 1 as const } : {}),
    ...(t.syntaxHighlight ? {} : { h: 0 as const }),
    ...(t.inspectorWidth && t.inspectorWidth > 0
      ? { iw: Math.round(t.inspectorWidth) }
      : {}),
    ...(t.outlineWidth && t.outlineWidth > 0
      ? { ow: Math.round(t.outlineWidth) }
      : {}),
    ...c,
  };
}

function serializeHybridTheme(
  theme: HybridTheme | undefined,
): SerHybridTheme | undefined {
  if (theme === "dark") return "d";
  if (theme === "light") return "l";
  return undefined;
}

function serializeNode(
  nodeId: string,
  opts: SerializeLayoutOptions,
): SerNode | null {
  const n = layout.nodes[nodeId];
  if (!n) return null;
  if (n.kind === "leaf") {
    const tabs: SerTab[] = n.tabs.map((t) =>
      serializeTab(t, t.id === n.activeTabId, opts),
    );
    const out: SerLeaf = {
      k: "l",
      t: tabs,
      ...(n.id === layout.activePaneId ? { f: 1 as const } : {}),
    };
    // Hybrid back-side state is inlined into SerLeaf so the URL hash
    // and per-window session both round-trip the flip-aware layout.
    // Never-flipped panes emit nothing extra. `bm` marks "has been
    // flipped at least once" so a Hybrid with no per-side theme still
    // serializes its Hybrid-ness.
    const ht = serializeHybridTheme(n.theme);
    if (ht) out.ht = ht;
    if (n.back !== undefined) out.bm = 1;
    if (n.showingBack) out.sb = 1;
    return out;
  }
  const a = serializeNode(n.a, opts);
  const b = serializeNode(n.b, opts);
  if (!a || !b) return null;
  // Only emit `r` if the split has been resized off the 50/50
  // default. Tiny rounding kindness so the URL hash stays short.
  const rRound = Math.round(n.ratio * 1000) / 1000;
  const rField = Math.abs(rRound - 0.5) > 0.001 ? { r: rRound } : {};
  return { k: "s", d: n.direction === "row" ? "r" : "c", a, b, ...rField };
}

/// Snapshot of the layout for persistence in the URL hash. Returns
/// `null` if the layout is uninteresting (a single empty pane), so we
/// don't litter the URL when there's nothing to save.
type SerializeLayoutOptions = {
  terminalSessions?: boolean;
};

export function serializeLayout(opts: SerializeLayoutOptions = {}): SerNode | null {
  const tree = serializeNode(layout.rootId, opts);
  if (!tree) return null;
  const serialized = {
    ...tree,
    ...serializeFocusColor(layout.focusColor),
  };
  if (serialized.k === "l" && serialized.t.length === 0 && !serialized.wc) return null;
  return serialized;
}

/// Replace the live layout with the deserialized tree, then kick off a
/// content load for every tab. The DOM updates as content arrives;
/// tabs initially appear in a "loading..." state.
export async function restoreLayout(
  s: SerNode,
  sessionLayout: SerNode | null = null,
): Promise<void> {
  // Clear current state.
  for (const k of Object.keys(layout.nodes)) delete layout.nodes[k];
  layout.focusColor = restoreFocusColor(s.wc ?? sessionLayout?.wc);

  let activePaneId: string | null = null;
  const tabsToLoad: { paneId: string; tabId: string; path: string }[] = [];
  const sessionLeaves = serializedLeaves(sessionLayout);
  let leafIndex = 0;

  function build(node: SerNode): string {
    if (node.k === "l") {
      const sessionLeaf = sessionLeaves[leafIndex++] ?? null;
      const savedTerms =
        sessionLeaf?.t.filter((t) => (t.k ?? "f") === "t") ?? [];
      let termIndex = 0;
      const p: LeafNode = {
        kind: "leaf",
        id: id("pane"),
        tabs: [],
        activeTabId: null,
      };
      for (const sertab of node.t) {
        const kind = sertab.k ?? "f";
        if (kind === "g") {
          const mode = restoreGraphMode(sertab.gm);
          const scopeId = sertab.gs || "workspace";
          // Prefer `gn` (persisted live selection) as the post-restore
          // seed so the user lands on the same focal node. The graph
          // load consumes `pendingSelectId` once; `selectedNodeId`
          // stays so the tab title remains selection-driven.
          const selectedNodeId =
            typeof sertab.gn === "string" ? sertab.gn : null;
          const selectedNodeLabel =
            typeof sertab.gnl === "string" ? sertab.gnl : null;
          const tab: GraphTab = {
            kind: "graph",
            id: id("graph"),
            title: graphTitle(mode, scopeId),
            mode,
            scopeId,
            depth: Number.isFinite(sertab.gd) ? Math.max(0, Number(sertab.gd)) : 1,
            expanded: graphExpandedFromList(sertab.ge),
            filters: decodeGraphTabFilters(sertab.gf),
            inspectorOpen: sertab.gi === 1,
            pendingSelectId: sertab.gp ?? selectedNodeId,
            selectedNodeId,
            selectedNodeLabel,
            ...(typeof sertab.iw === "number" && sertab.iw > 0
              ? { inspectorWidth: sertab.iw }
              : {}),
          };
          p.tabs.push(tab);
          if (sertab.a) p.activeTabId = tab.id;
          continue;
        }
        if (kind === "b") {
          const tab: BrowserTab = {
            kind: "browser",
            id: id("browser"),
            title: "Files",
            inspectorOpen: sertab.bi === 1,
            ...(typeof sertab.bs === "string" ? { selected: sertab.bs } : {}),
            ...(sertab.bd === 1 ? { showWorkspace: true } : {}),
            ...(Array.isArray(sertab.be) && sertab.be.length > 0
              ? { expanded: sertab.be.filter((p) => typeof p === "string") }
              : {}),
            ...(typeof sertab.bsc === "number" && sertab.bsc > 0
              ? { scroll: sertab.bsc }
              : {}),
            ...(typeof sertab.iw === "number" && sertab.iw > 0
              ? { inspectorWidth: sertab.iw }
              : {}),
          };
          p.tabs.push(tab);
          if (sertab.a) p.activeTabId = tab.id;
          continue;
        }
        // Settings ("s") and health ("h") are overlays now; silently
        // drop saved entries from older sessions.
        if (kind === "t") {
          const savedTerm = savedTerms[termIndex++];
          const terminalSessionId = sertab.tsid ?? savedTerm?.tsid;
          const mcpEnv =
            sertab.me === 0 ? false : savedTerm?.me === 0 ? false : true;
          const sessionMcpEnv =
            terminalSessionId && (sertab.sme === 0 || savedTerm?.sme === 0)
              ? false
              : terminalSessionId
                ? true
                : undefined;
          const teamWork = teamWorkFromSer(sertab, savedTerm);
          const tab: TerminalTab = {
            kind: "terminal",
            id: id("term"),
            title: sertab.n || "Terminal",
            createdAt: Date.now(),
            broadcastEnabled: false,
            broadcastTargetIds: [],
            mcpEnv,
            sessionMcpEnv,
            terminalSessionId,
            controlledTerminal: sertab.tc === 1 || savedTerm?.tc === 1,
            lastSeq: undefined,
            teamWork,
          };
          p.tabs.push(tab);
          if (sertab.a) p.activeTabId = tab.id;
          continue;
        }
        if (kind === "d") {
          const tab: DashboardTab = {
            kind: "dashboard",
            id: id("dashboard"),
            title: "Dashboard",
            // Restore the carousel slide when the hash carries one.
            // Absence falls back to the About slide (the default).
            ...(typeof sertab.cs === "number" && sertab.cs > 0
              ? { carouselSlide: Math.max(0, Math.floor(sertab.cs)) }
              : {}),
          };
          p.tabs.push(tab);
          if (sertab.a) p.activeTabId = tab.id;
          continue;
        }
        if (kind !== "f") continue;
        // Recompute fileKind from the path. Cheaper than persisting
        // it (the hash already carries the path) and keeps a session
        // restored after a chan upgrade aligned with the current
        // classifier instead of a stale snapshot.
        const restoredPath = sertab.p ?? "";
        const restoredPathKind = classifyPath(restoredPath);
        const restoredFileKind: FileKind =
          restoredPathKind === "document" || restoredPathKind === "text"
            ? restoredPathKind
            : "document";
        const tab: FileTab = {
          kind: "file",
          fileKind: restoredFileKind,
          id: id("tab"),
          path: restoredPath,
          content: "",
          saved: "",
          savedMtime: null,
          savedMtimeNs: null,
          // Trust the persisted mode when it is a valid pair for
          // this tab's path; otherwise fall back to the default.
          // Guards: a markdown-only "wysiwyg" mode persisted for a
          // .py file restores to source; a "pretty" persisted for a
          // non-JSON text file restores to source.
          mode: validateRestoredMode(sertab.m, restoredPath, restoredFileKind),
          loading: true,
          error: null,
          fileMissing: null,
          inspectorOpen: !!sertab.o,
          outlineOpen: !!sertab.ol,
          // repoRoot is filled in by loadTabContent on first read;
          // restored sessions start with null and get the real value
          // once the file fetches.
          repoRoot: null,
          // Restore the user-toggled read mode if it was persisted.
          // fsWritable is NOT carried in the session payload - it's
          // a disk property; the first loadTabContent refreshes it
          // (and an `!fsWritable` will dominate even if readMode is
          // false, so we don't need to fake it here).
          readMode: sertab.r === 1,
          fsWritable: true,
          // Absent means default-off; `s: 1` means the style toolbar is on.
          styleToolbarOpen: sertab.s === 1,
          // Default-on. `h: 0` in the hash means user disabled
          // highlight on this tab; any other value (absent / 1)
          // restores to default-on.
          syntaxHighlight: sertab.h !== 0,
          highlightTrailingWhitespace: false,
          codeBlocksCollapsed: false,
          // Restored caret rides through to the editor via tab.caret;
          // the editor lands it once content finishes loading.
          caret:
            Array.isArray(sertab.c) && sertab.c.length === 2
              ? { from: sertab.c[0], to: sertab.c[1] }
              : undefined,
          ...(typeof sertab.iw === "number" && sertab.iw > 0
            ? { inspectorWidth: sertab.iw }
            : {}),
          ...(typeof sertab.ow === "number" && sertab.ow > 0
            ? { outlineWidth: sertab.ow }
            : {}),
        };
        p.tabs.push(tab);
        if (sertab.a) p.activeTabId = tab.id;
        if (tab.path) {
          tabsToLoad.push({ paneId: p.id, tabId: tab.id, path: tab.path });
        }
      }
      // If no tab was marked active but there are tabs, focus the first.
      if (!p.activeTabId && p.tabs.length > 0) p.activeTabId = p.tabs[0]!.id;
      // The back is a configuration view, not a tab collection.
      // `bm` is the wire signal for "pane has been flipped at least
      // once." Legacy `bt` / `hb` are accepted but discarded; their
      // presence implies the pane was a Hybrid, so materialise the
      // empty back marker to keep `pane.back !== undefined` accurate.
      if (
        node.bm ||
        node.hb ||
        (node.bt && node.bt.length > 0)
      ) {
        p.back = {};
      }
      if (node.ht) p.theme = node.ht === "d" ? "dark" : "light";
      // The flip persists across reloads, but only for non-empty panes.
      // A stale `sb` on an empty pane is dropped defensively.
      if (node.sb && p.tabs.length > 0) p.showingBack = true;
      layout.nodes[p.id] = p;
      if (node.f) activePaneId = p.id;
      return p.id;
    }
    const split: SplitNode = {
      kind: "split",
      id: id("split"),
      direction: node.d === "r" ? "row" : "column",
      a: build(node.a),
      b: build(node.b),
      ratio: typeof node.r === "number" ? node.r : 0.5,
    };
    layout.nodes[split.id] = split;
    return split.id;
  }

  layout.rootId = build(s);
  layout.activePaneId = activePaneId ?? firstLeafId(layout.rootId);

  // Load all tab contents in parallel; failures land in tab.error.
  await Promise.all(
    tabsToLoad.map((t) => loadTabContent(t.paneId, t.tabId, t.path)),
  );
}

function serializedLeaves(node: SerNode | null, out: SerLeaf[] = []): SerLeaf[] {
  if (!node) return out;
  if (node.k === "l") {
    out.push(node);
    return out;
  }
  serializedLeaves(node.a, out);
  serializedLeaves(node.b, out);
  return out;
}

function teamWorkFromSer(
  tab: SerTab | undefined,
  fallback?: SerTab,
): TeamWorkState | undefined {
  const src =
    tab?.rpb !== undefined ||
    tab?.rph !== undefined ||
    tab?.rpo ||
    tab?.rpm ||
    tab?.rpc ||
    tab?.rppw !== undefined ||
    tab?.rpsm ||
    tab?.rpa ||
    tab?.rpn ||
    tab?.rpsq !== undefined
      ? tab
      : fallback;
  if (!src) return undefined;
  if (
    src.rpb === undefined &&
    src.rph === undefined &&
    !src.rpo &&
    !src.rpm &&
    !src.rpc &&
    src.rppw === undefined &&
    !src.rpsm &&
    !src.rpa &&
    !src.rpn &&
    src.rpsq === undefined
  ) {
    return undefined;
  }
  return {
    buffer: src.rpb ?? "",
    heightPx:
      typeof src.rph === "number" && Number.isFinite(src.rph)
        ? Math.max(1, Math.floor(src.rph))
        : undefined,
    open: src.rpo === 1,
    mode: src.rpm === "s" ? "source" : "wysiwyg",
    // Absence reads as expanded (the default); only emit when collapsed.
    ...(src.rpc === 1 ? { collapsed: true } : {}),
    // Per-prompt page-width ratio. Only emit when strictly inside (0, 1);
    // `1.0` means "no cap" and is omitted, matching serialize.
    ...(typeof src.rppw === "number" && Number.isFinite(src.rppw) && src.rppw > 0 && src.rppw < 1
      ? { pageWidthRatio: src.rppw }
      : {}),
    // Absence reads as Shell (the default); only emit for Agent.
    ...(src.rpsm === "a" ? { submitMode: "agent" as const } : {}),
    ...(src.rpa
      ? {
          agentTarget:
            src.rpa === "x"
              ? "codex" as const
              : src.rpa === "g"
                ? "gemini" as const
                : "claude" as const,
          submitMode: "agent" as const,
        }
      : {}),
    ...(src.rpn ? { workspaceName: src.rpn } : {}),
    ...(typeof src.rpsq === "number" && Number.isFinite(src.rpsq)
      ? { submissionSequence: Math.max(0, Math.floor(src.rpsq)) }
      : {}),
  };
}

/// Copy terminal PTY session metadata from a per-window session layout
/// onto the live layout after a shareable URL-hash layout restore.
/// The hash deliberately omits `tsid`/`tseq`; this graft keeps reloads
/// from abandoning the server-side PTY while still keeping copied URLs
/// free of private terminal ids.
export function hydrateTerminalSessionsFromLayout(sessionLayout: SerNode | null): void {
  const sessionLeaves = serializedLeaves(sessionLayout);
  const livePaneIds = leafIdsInOrder(layout.rootId);
  for (let i = 0; i < livePaneIds.length; i++) {
    const live = layout.nodes[livePaneIds[i]!];
    const saved = sessionLeaves[i];
    if (!live || live.kind !== "leaf" || !saved) continue;
    const liveTerms = live.tabs.filter((t): t is TerminalTab => t.kind === "terminal");
    const savedTerms = saved.t.filter((t) => (t.k ?? "f") === "t");
    for (let j = 0; j < liveTerms.length; j++) {
      const savedTerm = savedTerms[j];
      if (!savedTerm) continue;
      if (savedTerm.tsid) {
        liveTerms[j]!.terminalSessionId = savedTerm.tsid;
        liveTerms[j]!.mcpEnv = savedTerm.me === 0 ? false : true;
        liveTerms[j]!.sessionMcpEnv = savedTerm.sme === 0 ? false : true;
        liveTerms[j]!.lastSeq = undefined;
      }
      const teamWork = teamWorkFromSer(savedTerm);
      if (teamWork) liveTerms[j]!.teamWork = teamWork;
    }
  }
}

function firstLeafId(nodeId: string): string {
  const n = layout.nodes[nodeId];
  if (!n) return layout.rootId;
  if (n.kind === "leaf") return n.id;
  return firstLeafId(n.a);
}

export async function saveTab(t: Tab): Promise<void> {
  if (t.kind !== "file") return;
  await performSave(t);
}

/// Clear the transient error banner on a file tab. Used after a
/// rename completes so a watcher race that briefly set "no such
/// file" doesn't linger past the rekey. No-op if no tab matches.
export function clearTabError(tabId: string): void {
  const found = findFileTabById(tabId);
  if (!found) return;
  if (found.tab.error) found.tab.error = null;
  if (found.tab.fileMissing) found.tab.fileMissing = null;
}

export function markTabFileMissing(tabId: string): void {
  const found = findFileTabById(tabId);
  if (!found) return;
  markFileMissing(found.tab);
  void runSuggestReopenLookup(tabId, found.tab.path);
}

/// Debounced watcher-event reaction for "Removed" / "Renamed"
/// frames on an open file's path. Atomic-write patterns (temp +
/// rename) make the file vanish for a few milliseconds before
/// reappearing under the same name; chan's own self-write
/// dedupe usually suppresses the echo but races still leak
/// through, and external editors that don't go through
/// chan-server bypass the dedupe entirely. Delay the missing-
/// check long enough for the path to come back if it's going
/// to, then resolve via a path stat.
const pendingMissingChecks = new Map<string, ReturnType<typeof setTimeout>>();
const MISSING_CHECK_DEBOUNCE_MS = 150;

export function scheduleMissingFileCheck(tabId: string, path: string): void {
  const prior = pendingMissingChecks.get(tabId);
  if (prior !== undefined) clearTimeout(prior);
  const timer = setTimeout(() => {
    pendingMissingChecks.delete(tabId);
    void resolveMissingFileCheck(tabId, path);
  }, MISSING_CHECK_DEBOUNCE_MS);
  pendingMissingChecks.set(tabId, timer);
}

/// Cancel any pending missing-file check for `tabId`. Called
/// when a subsequent watcher frame (e.g. a "Created" that
/// follows a temp + rename "Removed") confirms the file is
/// back; the check would resolve the same way but cancelling
/// avoids the extra read.
export function cancelMissingFileCheck(tabId: string): void {
  const prior = pendingMissingChecks.get(tabId);
  if (prior === undefined) return;
  clearTimeout(prior);
  pendingMissingChecks.delete(tabId);
}

async function resolveMissingFileCheck(
  tabId: string,
  path: string,
): Promise<void> {
  const found = findFileTabById(tabId);
  if (!found) return;
  // Watcher event was for a stale path that the tab no longer
  // points at (rename rekey happened in between). Drop.
  if (found.tab.path !== path) return;
  const tab = found.tab;
  if (tab.content !== tab.saved) {
    // Buffer is dirty. Don't clobber the user's in-flight
    // typing; just probe existence and clear / set fileMissing.
    try {
      await api.read(path);
      tab.fileMissing = null;
      tab.error = null;
    } catch (e) {
      if (isMissingFileError(e)) markTabFileMissing(tabId);
      // Other errors (network etc.) leave the tab as-is.
    }
    return;
  }
  // Clean buffer - full reload is safe. loadTabContent fires
  // markFileMissing on a genuine 404 in its catch branch.
  await loadTabContent(found.paneId, tabId, path);
  if (tab.fileMissing) {
    void runSuggestReopenLookup(tabId, path);
  }
}

/// Best-effort "did the file just move?" lookup. Runs after a
/// genuine missing-file detection. Searches the workspace by
/// basename + filters to exact basename matches at a path
/// different from the original; only surfaces a suggestion
/// when there's a unique candidate. Ambiguous results leave
/// `suggestedPath` null so the user is steered to Find.
async function runSuggestReopenLookup(
  tabId: string,
  path: string,
): Promise<void> {
  const basename = path.split("/").pop();
  if (!basename) return;
  let candidates: string[] = [];
  try {
    const hits = await api.search(basename, 5);
    candidates = hits
      .map((h) => h.path)
      .filter((p) => p !== path && p.split("/").pop() === basename);
  } catch {
    // Search failure is non-blocking; missing-file UX is still
    // usable without the suggestion.
    return;
  }
  const found = findFileTabById(tabId);
  if (!found || !found.tab.fileMissing) return;
  if (found.tab.path !== path) return;
  found.tab.fileMissing.suggestedPath =
    candidates.length === 1 ? candidates[0] : null;
}

/// Try to reload the missing file at its ORIGINAL path. Used
/// by the missing-file panel's Re-open button. Returns true
/// when the load succeeded (the panel goes away in that
/// branch); false when the file is still gone (caller falls
/// through to FB navigation so the user can manually pick the
/// moved file).
export async function attemptInPlaceReopen(
  tabId: string,
): Promise<boolean> {
  const found = findFileTabById(tabId);
  if (!found) return false;
  const path = found.tab.path;
  found.tab.loading = true;
  await loadTabContent(found.paneId, tabId, path);
  const after = findFileTabById(tabId);
  return after !== null && after.tab.fileMissing === null;
}

export function beginMissingFileReopen(tabId: string): void {
  const found = findFileTabById(tabId);
  if (!found || found.tab.fileMissing === null) return;
  pendingMissingFileReopenTabId = tabId;
  const node = layout.nodes[found.paneId];
  if (node?.kind === "leaf") node.activeTabId = tabId;
  layout.activePaneId = found.paneId;
}

/// Refresh a non-dirty tab's content from disk. Used by user-initiated
/// flows that intend to adopt the new disk content (e.g. file replace).
/// If the buffer is dirty, it is left alone. Not used for watcher events;
/// watcher events must not silently reload an open doc (see `flagExternalChange`).
export async function refreshTabFromDisk(tabId: string): Promise<void> {
  const found = findFileTabById(tabId);
  if (!found) return;
  if (found.tab.content !== found.tab.saved) return;
  await loadTabContent(found.paneId, found.tab.id, found.tab.path);
}

/// A watcher event reported an external (non-self) write to this open
/// file's path. Do NOT reload: replacing the doc snaps the caret to
/// 1:1 while the user is typing. Raise the dismissable "changed on disk"
/// banner instead; the user opts into the reload, or their next save
/// hits the 409 conflict modal. Applies to clean and dirty buffers
/// (self-write dedupe already drops echoes of our own writes).
export function flagExternalChange(tabId: string): void {
  const found = findFileTabById(tabId);
  if (found) found.tab.externalChange = true;
}

/// Dismiss the "changed on disk" banner without reloading (the user
/// chose to keep editing). It re-raises on the next external write.
export function dismissExternalChange(tabId: string): void {
  const found = findFileTabById(tabId);
  if (found) found.tab.externalChange = false;
}

export async function reloadTabFromDisk(tabId: string): Promise<void> {
  const found = findFileTabById(tabId);
  if (!found) return;
  await loadTabContent(found.paneId, found.tab.id, found.tab.path);
}

/// Aggregate read-only state across the whole window: true iff
/// every leaf pane has at least one file tab AND every active
/// file tab is in read mode (either user-toggled `readMode` or
/// filesystem-locked via `!fsWritable`). Walks layout.nodes so
/// callers reading this from a $derived re-run when any of those
/// fields flip. Returns false when there are no open file tabs
/// at all (an empty workspace isn't conceptually "in read mode").
export function isWindowFullyReadOnly(): boolean {
  let sawFile = false;
  for (const node of Object.values(layout.nodes)) {
    if (node.kind !== "leaf") continue;
    if (node.tabs.length === 0) continue;
    const active = node.tabs.find((t) => t.id === node.activeTabId);
    if (!active || active.kind !== "file") continue;
    sawFile = true;
    if (!active.readMode && active.fsWritable) return false;
  }
  return sawFile;
}

/// Look up every open tab for `path`, regardless of pane. The
/// watcher subscriber uses this to fan an external-edit event out
/// to the (potentially multiple) tabs viewing the same file.
export function tabsForPath(path: string): { paneId: string; tabId: string }[] {
  const out: { paneId: string; tabId: string }[] = [];
  for (const [paneId, node] of Object.entries(layout.nodes)) {
    if (node.kind !== "leaf") continue;
    for (const t of node.tabs) {
      if (t.kind === "file" && t.path === path) {
        out.push({ paneId, tabId: t.id });
      }
    }
  }
  return out;
}

/// Rewrite tab paths in place after a rename/move. Handles both
/// the single-file rename (exact path match) and the directory
/// rename (every tab whose path starts with `from/`). Editor state
/// - buffer, cursor, dirty flag, savedMtime - is preserved so the
/// rename feels like a relabel rather than a close+reopen. The
/// server already moved the bytes atomically; mtime stays valid
/// for the moved file, so the next save's CAS check still works.
///
/// Tabs that were dirty stay dirty after the rename: the user's
/// unsaved buffer follows the file. If the new path doesn't accept
/// it (kind change, etc.) the next save surfaces the failure via
/// the existing error channel; we don't need to special-case here.
export function rekeyTabsForRename(from: string, to: string): void {
  const dirPrefix = `${from}/`;
  const newDirPrefix = `${to}/`;
  for (const node of Object.values(layout.nodes)) {
    if (node.kind !== "leaf") continue;
    for (const t of node.tabs) {
      if (t.kind !== "file") continue;
      if (t.path === from) {
        t.path = to;
      } else if (t.path.startsWith(dirPrefix)) {
        t.path = newDirPrefix + t.path.slice(dirPrefix.length);
      }
    }
  }
}
