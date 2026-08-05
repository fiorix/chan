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

import { api, sessionWindowId } from "../api/client";
import { ApiError } from "../api/errors";
import type {
  DraftPromoteResponse,
  FileResponse,
  TerminalRosterEntry,
} from "../api/types";
import type { FindRange } from "../editor/find";
import {
  renderedCaretForSourceCaret,
  sourceCaretForRenderedCaret,
} from "../editor/caret_mapping";
import { stripTrailingWhitespaceText } from "../editor/tools";
import { parseSlidesSpec } from "../editor/slides";
import { uiConfirm } from "./confirm.svelte";
import { editorToolsPrefs } from "./editorTools.svelte";
import { classifyPath, isCsv, isEditableText, isExcalidraw, isJson } from "./fileTypes";
import { edgeSplitSpec, type PaneMouseSplitEdge } from "./paneMouseSplit";
import type { FileKind } from "./kinds";
import {
  createTerminalKeyboardProtocolState,
  resetTerminalKeyboardProtocolState,
  restoreKeyboardProtocolState,
  serializeKeyboardProtocolState,
  type SerializedKeyboardProtocolState,
  type TerminalKeyboardProtocolState,
} from "../terminal/keymap";
import type { SubmitAgent } from "../terminal/submitMode";
import { notify } from "./notify.svelte";
import { isRichPromptVisible, showRichPromptForTab } from "./richPrompt.svelte";
import {
  defaultTeamConfig,
  type TeamDialogConfig,
  type TeamDialogRequest,
} from "./teamDialog.svelte";
// `isDraftPath` comes from the side-effect-free `workspace.svelte`
// leaf module (NOT store.svelte), so importing it here doesn't trigger
// store's eager draft-promotion-sink registration. See the cycle note
// below.
import { isDraftPath } from "./workspace.svelte";
import {
  clearCaretsUnder,
  readCaret,
  recordCaret,
  rekeyCaret,
} from "./caretIndex";
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
///   - `canvas`: interactive Excalidraw whiteboard. `.excalidraw`
///     only; source mode exposes the raw scene JSON.
export type Mode = "wysiwyg" | "source" | "pretty" | "table" | "canvas";
export type EditorSelection = { from: number; to: number };
export type OpenFileOptions = {
  initialSelection?: EditorSelection;
  side?: PaneSide;
  /// Force the caret to document top, overriding any persisted/restored
  /// position. Set by explicit user-driven opens (File-Tree click, File
  /// Browser open, create, duplicate, `cs open`); omitted by implicit opens
  /// (search, wiki/mention links, backlink navigation) so they keep their
  /// jump target or last-known caret.
  landAtTop?: boolean;
};

/// Default mode for a freshly opened file. Excalidraw scenes land in
/// "canvas" (the interactive board); JSON tabs land in "pretty";
/// CSV/TSV tabs land in "table"; markdown-class tabs stay on
/// "wysiwyg"; everything else (other text formats) opens in source
/// mode because that's the only mode they have.
function defaultModeForPath(path: string, fileKind: FileKind): Mode {
  if (isExcalidraw(path)) return "canvas";
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
  if (mode === "canvas") return isExcalidraw(path);
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

export type SlidePreviewMode = "preview" | "play";
export type SlidePreviewTabState = {
  open: boolean;
  index: number;
  mode: SlidePreviewMode;
};

/// Connection state of a tab's live document session (see
/// state/docSync.svelte.ts):
///   - `connecting`: first socket dial in progress; classic autosave
///     stays active until `attached`.
///   - `attached`: the server authority owns the document; saves flush
///     through the session and the classic PUT path is suppressed.
///   - `reconnecting`: transient socket loss inside the grace window;
///     autosave stays suppressed so a blip cannot race the authority's
///     flush with a CAS PUT.
///   - `degraded`: reconnect grace exhausted; classic autosave+CAS has
///     resumed against the last authority-flushed mtime token.
///   - `off`: doc sync disabled, unsupported by the server, or the tab
///     is ineligible.
export type DocSyncStatus =
  | "connecting"
  | "attached"
  | "reconnecting"
  | "degraded"
  | "off";

/// Live doc-session presence mirrored onto a FileTab (`FileTab.doc`).
export type DocTabState = {
  state: DocSyncStatus;
  /// Number of distinct OTHER WINDOWS with a live cursor on the same
  /// path. Self-window attaches are excluded and a peer's split panes
  /// collapse to one: the badge counts people, not editor mounts.
  /// > 0 means a peer badge is warranted.
  peers: number;
};

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
  /// Version of the live doc/scene authority observed with the saved
  /// bytes. Required alongside the disk token for fallback PUTs while
  /// an attached authority still exists.
  authorityVersion?: number | null;
  /// The live authority has retained divergent disk state and requires
  /// explicit conflict resolution.
  diskConflicted?: boolean;
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
  /// Per-tab slides preview state. Stored on the tab so a reload can
  /// restore both "in preview" and the slide currently on screen.
  slidePreview?: SlidePreviewTabState;
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
  /// Live doc-session sync state for this tab, mirrored from
  /// state/docSync.svelte.ts while the tab is attached to the server's
  /// document authority. `state` drives save/autosave routing and the
  /// editor's degraded-mode affordances; `peers` (other live attaches
  /// on the same path) drives the tab-strip presence badge. Undefined
  /// when doc sync is off or the tab is ineligible. Ephemeral - never
  /// serialized into the URL hash / session.json.
  doc?: DocTabState;
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
  /// Transient imperative caret command. A mounted editor snapshots
  /// `initialCaret` once and latches, so re-opening a kept-alive tab can't
  /// move the caret through the prop. `openInPane` sets a fresh object here
  /// on an explicit open; the FileEditorTab effect drives the live editor to
  /// it via `resetCaret`. Kept separate from `caret` (the live position
  /// written on every keystroke) so the consuming effect does not re-fire
  /// while typing. Never serialized (see serializeTab's field allowlist).
  caretCommand?: { from: number; to: number };
  /// Whether the file was empty when its content last loaded. Drives the
  /// empty-file auto-discard on close: an editable file is deleted on close
  /// only when it is empty now AND (the buffer is dirty OR it opened empty),
  /// so a file that merely failed to load (non-empty on disk, shown blank) is
  /// never deleted. Set by loadTabContent; transient, never serialized.
  openedEmpty?: boolean;
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

export type TerminalMetadata = {
  name: string;
  group: string;
};

export type TerminalSessionMetadata = TerminalMetadata & {
  spawnName: string | null;
  spawnGroup: string | null;
};

export type TerminalTab = {
  kind: "terminal";
  id: string;
  title: string;
  createdAt: number;
  broadcastEnabled: boolean;
  broadcastTargetIds: string[];
  /// Immutable spawn provenance from the authoritative attach prelude.
  /// Absence means the server genuinely does not know the value or this tab
  /// has not received an attach prelude yet.
  terminalEnvTabName?: string;
  terminalEnvTabGroup?: string;
  terminalEnvNamePromptDismissed?: boolean;
  terminalEnvPromptDismissedFor?: string;
  /// One local name/group draft and at most one proposal awaiting a server
  /// acknowledgement. Neither value is authoritative and neither is persisted.
  terminalMetadataDraft?: TerminalMetadata;
  terminalMetadataPending?: TerminalMetadata;
  terminalMetadataError?: string;
  terminalSessionId?: string;
  /// Spawn-derived submit identity from the server's latest `session` frame.
  /// Transient and replaced, including with `undefined`, on every attach so a
  /// restart or old server cannot leave stale agent identity on the tab.
  submitAgent?: SubmitAgent;
  controlledTerminal?: boolean;
  lastAgentEchoSeq?: number;
  terminalActivity?: boolean;
  /// Refines terminalActivity. True while output is actively ARRIVING at
  /// this unfocused terminal (the unseen-output dot PULSES); flips false
  /// once output stops but is still unseen (the dot goes SOLID). Cleared
  /// with terminalActivity when the user sees it.
  terminalActivityPulsing?: boolean;
  /// MESSAGE depth of this session's server-side write queue (Rich Prompt
  /// messages + `cs terminal write` teammate pokes share one FIFO; a gemini
  /// text+chord pair counts once). Drives the tab-strip badge and the idle
  /// prompt label. 0 is stored as undefined (truthiness renders like
  /// terminalActivity); never persisted -- every (re)attach re-syncs it from
  /// the WS `session` frame.
  queueDepth?: number;
  /// The ONE in-flight Rich Prompt message (submit is a no-op while set).
  /// Lives on the TAB, not the bubble component, so hiding/showing the
  /// bubble mid-pending keeps the state machine running. phase: "sent"
  /// (frame out, no ack yet) -> "queued" (server ack; depth = the ack's
  /// 1-based position) -> "delivered" (last write hit the PTY) | "rejected"
  /// (queue full) | "failed" (WS close / ack timeout / session end). Cancel/
  /// recall adds two terminal phases the bubble consumes: "recalled" (the
  /// `prompt-cancelled` ack removed a still-queued message -- unlock + keep the
  /// draft text to edit + resubmit) | "drained" (the cancel raced a drain; the
  /// message already hit the PTY -- surface it, don't silently re-edit). The
  /// bubble's $effect consumes terminal phases and clears this field.
  pendingPrompt?: {
    id: string;
    phase: "sent" | "queued" | "delivered" | "rejected" | "failed" | "recalled" | "drained";
    depth?: number;
  };
  cwd?: string;
  seedInput?: string;
  /// Transient marker for a freshly-created unnamed terminal's provisional
  /// `Terminal-N` label. The registry settlement returned by the attach
  /// prelude is authoritative. Never persisted.
  pendingGlobalName?: boolean;
  /// Rich Prompt per-terminal draft path (`<draftsDir>/<name>/draft.md`) backing
  /// the bubble: the draft.md IS the prompt text and the folder holds pasted
  /// media. Created lazily on first open; discarded on terminal close.
  /// Persisted (SerTab.rpd) so a window reload rebinds + the close cleanup
  /// targets the right draft (no leak).
  richPromptDraftPath?: string;
  /// Rich Prompt composer caret (doc offsets in the draft). The bubble's
  /// editor pushes updates here on every selection change; the editor that
  /// mounts next reads it once on first content apply (same restore dance
  /// as `FileTab.caret`). Persisted (SerTab.rpc) so a reload or a
  /// cross-window restore reopens the composer with the caret where the
  /// user left it.
  richPromptCaret?: { from: number; to: number };
  /// Rich Prompt bubble height in px from the user's drag-resize; unset is
  /// the default auto height. Persisted (SerTab.rph) so a restored bubble
  /// reopens at the size the user left it.
  richPromptHeight?: number;
  /// Broadcast group label. A group is a plain string, not an allocated
  /// resource: it "exists" iff >=1 terminal references it, and is
  /// implicitly destroyed when the last member closes. Defaults to
  /// "default" (via `terminalTabGroup`); change requires a restart so the
  /// SPA group and the server's per-session `tab_group` (set at spawn from
  /// the same value) never diverge. Scopes the Cmd+Shift+I client
  /// broadcast: input fans out only to same-group terminals.
  group?: string;
  /// Keyboard-protocol negotiation state (xterm modifyOtherKeys / kitty
  /// flags) the running program announced. Lives on the TAB, not the
  /// TerminalTab component, so it survives a component remount: a remount
  /// on reattach to a long-lived PTY would otherwise reset it to zero,
  /// and a long-lived agent never re-announces its protocol after the
  /// reconnect, so modified-Enter (Shift+Enter -> newline) falls through
  /// to a plain submit. Reset only on a fresh spawn; kept across reattach.
  /// A compact snapshot is serialized to the session hash (`kp`) so the
  /// state ALSO survives a page reload reattaching to a long-lived agent
  /// whose original negotiation has scrolled out of the reattach replay
  /// ring (the heap is gone on a reload, so the in-memory copy cannot
  /// help; the replay would only re-establish a still-recent negotiation).
  keyboardProtocol?: TerminalKeyboardProtocolState;
  /// Set iff this is a Team Work LEAD terminal with the spawn-agents dialog
  /// open over it (Cmd+P, pre-Bootstrap). Holds the live config draft so a
  /// window reload reopens the dialog over the restored lead terminal with
  /// exactly what the user was editing. Seeded in `createTeamWorkLeadTerminal`,
  /// mirrored from the dialog on every edit, cleared on Bootstrap (the terminal
  /// becomes a committed lead), and gone with the tab on Cancel. Serialized as
  /// `SerTab.twk` in the per-window session payload ONLY (never the shareable
  /// URL hash) since a member's `env` can carry secrets.
  teamWorkPending?: TeamDialogConfig;
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

/// Dashboard tab - read-only surface hosting the shortcut table and
/// info panels. No per-tab state today; the placeholder fields keep the
/// discriminated union symmetric with the other tab kinds and let future
/// additions include view state without re-walking the persistence layer.
export type DashboardTab = {
  kind: "dashboard";
  id: string;
  title: string;
  /// Persisted carousel slide index so a reload restores the user to the
  /// slide they were last on. 0 is Workspace; 1 is Search (the Indexing
  /// graph); 2 is About - matching the `SLOTS` order in DashboardTab.svelte
  /// and the `slideIndex === 1` indexing-poll gate in EmptyPaneCarousel.
  /// The carousel's play/pause is server-persisted so the auto-rotate
  /// preference survives a reload independently.
  carouselSlide?: number;
  /// Slide indices the user switched off via the Dashboard tab's
  /// right-click menu. Disabled slots are skipped in auto-rotation and
  /// hidden from the pagination dots. Absent / empty means all slots are
  /// enabled (the default); at least one slot always stays enabled
  /// (enforced in `toggleDashboardSlot`).
  disabledSlots?: number[];
  /// Whether this tab's carousel auto-rotates. Absent / true = on (the
  /// default); `cs dashboard --carousel-off` creates the tab with this
  /// false. Distinct from the global `empty_pane_carousel_cycling`
  /// preference: a per-tab opt-out so one static dashboard does not stop
  /// every dashboard from rotating.
  autoRotate?: boolean;
};

/// Local extension surface. The authenticated entry URL deliberately does not
/// live on the tab: URL hashes and session blobs persist this object, while the
/// credential stays only in the process-fetched extension catalog.
export type ExtensionTab = {
  kind: "extension";
  id: string;
  title: string;
  extensionId: string;
};

/// Carousel slot count, shared by the on/off helpers below and the
/// restore-time clamp. The carousel template renders exactly these three
/// slides (About / Workspace / Search); keeping the count here lets the
/// helpers reason about "the last enabled slot" without importing the
/// component.
export const DASHBOARD_SLOT_COUNT = 3;

/// Whether slide `i` is currently shown for this Dashboard tab.
export function dashboardSlotEnabled(tab: DashboardTab, i: number): boolean {
  return !(tab.disabledSlots ?? []).includes(i);
}

/// Toggle slide `i` on/off. Refuses to disable the last enabled slot so
/// the carousel never goes blank. The disabled set is stored sorted and
/// cleared entirely when every slot is back on (pre-release: omit the
/// field rather than persist an empty array).
export function toggleDashboardSlot(tab: DashboardTab, i: number): void {
  const disabled = new Set(tab.disabledSlots ?? []);
  if (disabled.has(i)) {
    disabled.delete(i);
  } else {
    if (DASHBOARD_SLOT_COUNT - disabled.size <= 1) return;
    disabled.add(i);
  }
  const next = [...disabled].sort((a, b) => a - b);
  tab.disabledSlots = next.length > 0 ? next : undefined;
}

/// First enabled slide index. Falls back to 0, which the min-one-enabled
/// invariant makes unreachable.
export function firstEnabledSlot(tab: DashboardTab): number {
  for (let i = 0; i < DASHBOARD_SLOT_COUNT; i++) {
    if (dashboardSlotEnabled(tab, i)) return i;
  }
  return 0;
}

/// Next enabled slide index after `from`, wrapping. Used by the carousel
/// auto-rotate + arrow nav so they step over disabled slots.
export function nextEnabledSlot(tab: DashboardTab, from: number): number {
  for (let step = 1; step <= DASHBOARD_SLOT_COUNT; step++) {
    const cand = (from + step) % DASHBOARD_SLOT_COUNT;
    if (dashboardSlotEnabled(tab, cand)) return cand;
  }
  return from;
}

export type Tab =
  | FileTab
  | TerminalTab
  | GraphTab
  | BrowserTab
  | DashboardTab
  | ExtensionTab;

type ClosedTab = {
  paneId: string;
  side: PaneSide;
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
  if (t.kind === "extension") return t.title;
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
  if (t.kind === "extension") return `${t.title} (${t.extensionId})`;
  return t.path;
}

export function terminalTabName(t: TerminalTab): string {
  return t.title.trim() || "Terminal";
}

export const DEFAULT_TERMINAL_GROUP = "default";

/// The tab's broadcast group, normalized. An empty / unset group is
/// "default", so a brand-new terminal always belongs to a group and the
/// `"default"` string is never special-cased in code.
export function terminalTabGroup(t: TerminalTab): string {
  return t.group?.trim() || DEFAULT_TERMINAL_GROUP;
}

export function normalizeTerminalMetadata(
  name: string,
  group: string | null | undefined,
): TerminalMetadata {
  return {
    name: name.trim() || "Terminal",
    group: group?.trim() || DEFAULT_TERMINAL_GROUP,
  };
}

export function currentTerminalMetadata(tab: TerminalTab): TerminalMetadata {
  return {
    name: terminalTabName(tab),
    group: terminalTabGroup(tab),
  };
}

export function terminalMetadataDraft(tab: TerminalTab): TerminalMetadata {
  return tab.terminalMetadataDraft ?? currentTerminalMetadata(tab);
}

export function setTerminalMetadataDraft(
  tab: TerminalTab,
  name: string,
  group: string | null | undefined,
): void {
  tab.terminalMetadataDraft = { name, group: group ?? "" };
  tab.terminalMetadataError = undefined;
}

export function resetTerminalMetadataDraft(tab: TerminalTab): void {
  tab.terminalMetadataDraft = undefined;
  tab.terminalMetadataError = undefined;
}

/// Apply an authoritative broadcast group to the tab mirror. A blank value
/// normalizes to `default` so every local broadcast decision has a group.
export function setTerminalGroup(t: TerminalTab, group: string): void {
  t.group = group.trim() || DEFAULT_TERMINAL_GROUP;
}

/// Return the tab's keyboard-protocol state, lazily creating it on first
/// use. `fresh` (a brand-new spawn, no surviving session) forces a clean
/// slate; a reattach keeps whatever the program previously negotiated so
/// modified-Enter keeps working across a component remount. See the
/// `keyboardProtocol` field on `TerminalTab`.
export function ensureTerminalKeyboardProtocol(
  tab: TerminalTab,
  fresh: boolean,
): TerminalKeyboardProtocolState {
  if (!tab.keyboardProtocol) {
    tab.keyboardProtocol = createTerminalKeyboardProtocolState();
  } else if (fresh) {
    resetTerminalKeyboardProtocolState(tab.keyboardProtocol);
  }
  return tab.keyboardProtocol;
}

/// Walks `state.nodes` defensively because this runs from component teardown
/// too: `registerTerminalMetadataSink`'s unregister fires inside the Svelte
/// batch that a split commits, and Svelte serves a torn-down branch the
/// PRE-batch value of every source. A node added by the same batch (the new
/// pane and its split) therefore reads back as `undefined` while `ownKeys`
/// still lists it, so `Object.values` hands out holes. Skipping them observes
/// the layout as it was when the effect was alive, which is what the teardown
/// wants; throwing on the hole aborts the flush mid-render and wedges the
/// window.
function terminalTabsIn(state: LayoutState): TerminalTab[] {
  const out: TerminalTab[] = [];
  for (const node of Object.values(state.nodes)) {
    if (!node || node.kind !== "leaf") continue;
    for (const tab of allPaneTabs(node)) {
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

/// Replace a local creation placeholder with a server-provided proposal. The
/// terminal registry still settles the final name and the attach prelude
/// replaces this value. A failed fetch leaves the placeholder in place.
export async function applyGlobalTerminalName(tab: TerminalTab): Promise<void> {
  try {
    const name = (await api.terminalNextName()).trim();
    if (!name) return;
    // Mutate the LIVE tab from the layout, NOT the passed reference. A tab
    // object pushed into `$state` is only reactive through its Svelte proxy;
    // writing `tab.title` on the original (pre-push) object updates the data
    // but never re-renders the name. Re-find the proxy by id (this also
    // covers the tab being closed / moved out mid-fetch -> not found -> skip).
    const live = allTerminalTabs().find((t) => t.id === tab.id);
    if (!live) return;
    live.title = name;
  } catch {
    // Keep the local placeholder name; the global counter is a nicety, not a
    // correctness requirement.
  }
}

/// Each pane (Hybrid in user-facing copy) has two tab sides. Side A
/// keeps the historical `tabs` / `activeTabId` fields; side B uses
/// `bTabs` / `bActiveTabId`. `side` selects which tab strip and active
/// content the user is currently looking at.
export type HybridTheme = "dark" | "light";
export type PaneSide = "a" | "b";
export type TabDestination = {
  paneId?: string | null;
  side?: PaneSide | null;
};
export type ResolvedTabDestination = {
  paneId: string;
  side: PaneSide;
};

export type Pane = {
  id: string;
  tabs: Tab[];
  activeTabId: string | null;
  bTabs?: Tab[];
  bActiveTabId?: string | null;
  side?: PaneSide;
  /// Visible-side theme override (`undefined` = follow global).
  theme?: HybridTheme;
};

export function paneSide(p: Pane): PaneSide {
  return p.side === "b" ? "b" : "a";
}

export function oppositePaneSide(side: PaneSide): PaneSide {
  return side === "a" ? "b" : "a";
}

export function paneTabs(p: Pane, side: PaneSide = paneSide(p)): Tab[] {
  return side === "b" ? (p.bTabs ?? []) : p.tabs;
}

function mutablePaneTabs(p: Pane, side: PaneSide = paneSide(p)): Tab[] {
  if (side === "b") {
    if (!p.bTabs) p.bTabs = [];
    return p.bTabs;
  }
  return p.tabs;
}

export function paneActiveTabId(
  p: Pane,
  side: PaneSide = paneSide(p),
): string | null {
  return side === "b" ? (p.bActiveTabId ?? null) : p.activeTabId;
}

function setPaneActiveTabId(
  p: Pane,
  tabId: string | null,
  side: PaneSide = paneSide(p),
): void {
  if (side === "b") p.bActiveTabId = tabId;
  else p.activeTabId = tabId;
}

export function activeTabInPane(p: Pane, side: PaneSide = paneSide(p)): Tab | null {
  const activeId = paneActiveTabId(p, side);
  if (!activeId) return null;
  return paneTabs(p, side).find((tab) => tab.id === activeId) ?? null;
}

export function allPaneTabs(p: Pane): Tab[] {
  return [...p.tabs, ...(p.bTabs ?? [])];
}

type PaneTabOrderEntry = {
  side: PaneSide;
  tab: Tab;
};

/// Stable whole-Hybrid tab order: side A in strip order, then side B in strip
/// order. Tab rotation wraps across this combined list.
function paneTabOrder(p: Pane): PaneTabOrderEntry[] {
  return [
    ...paneTabs(p, "a").map((tab) => ({ side: "a" as const, tab })),
    ...paneTabs(p, "b").map((tab) => ({ side: "b" as const, tab })),
  ];
}

function paneHasAnyTabs(p: Pane): boolean {
  return p.tabs.length > 0 || (p.bTabs?.length ?? 0) > 0;
}

function findTabInPane(
  p: Pane,
  tabId: string,
  side?: PaneSide,
): { side: PaneSide; tabs: Tab[]; index: number; tab: Tab } | null {
  if (!side || side === "a") {
    const aIndex = p.tabs.findIndex((tab) => tab.id === tabId);
    if (aIndex >= 0) {
      return { side: "a", tabs: p.tabs, index: aIndex, tab: p.tabs[aIndex]! };
    }
  }
  if (!side || side === "b") {
    const bTabs = p.bTabs ?? [];
    const bIndex = bTabs.findIndex((tab) => tab.id === tabId);
    if (bIndex >= 0) {
      return { side: "b", tabs: bTabs, index: bIndex, tab: bTabs[bIndex]! };
    }
  }
  return null;
}

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

/// Resolve an optional tab destination against the live layout. An omitted
/// pane or side uses the current active context. An explicit pane that is not
/// a live leaf refuses instead of redirecting the tab to the active pane.
export function resolveTabDestination(
  destination: TabDestination = {},
): ResolvedTabDestination | null {
  const paneId = destination.paneId ?? layout.activePaneId;
  const node = layout.nodes[paneId];
  if (!node || node.kind !== "leaf") return null;
  return {
    paneId,
    side: destination.side ?? paneSide(node),
  };
}

/// Staged spawn intent for Hybrid Nav spawn keys. The intent queues
/// here so the pane-mode "Enter commit / Esc discard" contract holds
/// for every keystroke; `commitPaneMode()` materializes it as part of
/// the seal. A second staging overwrites the first; Esc clears it
/// without spawning.
export type PaneModeSpawnKind = "terminal" | "browser" | "graph" | "dashboard";
export type PaneModeSpawnIntent = {
  kind: PaneModeSpawnKind;
  ctx: SpawnContext;
};
export type PaneModeDraftEditorKind = "draft" | "diagram";
export interface PaneModeStagedDraftEditor {
  id: string;
  paneId: string;
  side: PaneSide;
  kind: PaneModeDraftEditorKind;
}

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
  stale: boolean;
  entryLayout: SerNode | null;
  pendingRemoteLayout: SerNode | null;
  /// Edge-split preview for the mouse transaction: the hovered target
  /// pane plus the edge zone the cursor sits in. Preview state only;
  /// the draft tree changes on mouseup, never on hover.
  mouseSplit: { paneId: string; edge: PaneMouseSplitEdge } | null;
  /// Queue of "new draft editor" intents staged during the current
  /// pane-mode session. Materialized on Enter (commit); discarded on
  /// Esc (cancel). Each entry pins the target paneId at press time so
  /// later focus changes don't redirect materialization.
  stagedDraftEditors: PaneModeStagedDraftEditor[];
}>({
  active: false,
  draft: null,
  spawnIntent: null,
  transactionMode: false,
  grabPaneId: null,
  hoverPaneId: null,
  stale: false,
  entryLayout: null,
  pendingRemoteLayout: null,
  mouseSplit: null,
  stagedDraftEditors: [],
});

type PaneModeSettledSink = (pendingRemoteLayout: SerNode | null) => void;
const paneModeSettledSinks = new Set<PaneModeSettledSink>();

/// Register work that must run only after Hybrid Nav's draft has either
/// committed or been discarded (entered, too: `enterPaneMode` also notifies,
/// since it replaces any prior draft). Returns the unregister function.
export function registerPaneModeSettledSink(
  sink: PaneModeSettledSink,
): () => void {
  paneModeSettledSinks.add(sink);
  return () => {
    paneModeSettledSinks.delete(sink);
  };
}

function notifyPaneModeSettled(pendingRemoteLayout: SerNode | null = null): void {
  for (const sink of paneModeSettledSinks) sink(pendingRemoteLayout);
}

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

/// Single-fire attention flash for the A/B side-toggle button. A close
/// shortcut on an empty visible side flips to the populated opposite side,
/// while the flash explains why the pane/window stays open.
export const paneSideToggleFlash = $state<{ versions: Record<string, number> }>({
  versions: {},
});

export function requestPaneSideToggleFlash(paneId: string): void {
  if (!paneId) return;
  paneSideToggleFlash.versions[paneId] =
    (paneSideToggleFlash.versions[paneId] ?? 0) + 1;
}

export function activeLayout(): LayoutState {
  return paneMode.active && paneMode.draft ? paneMode.draft : layout;
}

function pane(id: string): LeafNode {
  const n = layout.nodes[id];
  if (!n || n.kind !== "leaf") throw new Error(`not a pane: ${id}`);
  return n;
}

function leafPaneFrom(state: LayoutState, paneId: string): LeafNode | null {
  const n = state.nodes[paneId];
  return n && n.kind === "leaf" ? n : null;
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

function tabDropKey(paneId: string, tabId: string, side?: PaneSide): string {
  return `${paneId}:${side ?? "*"}:${tabId}`;
}

export function markLocalTabDrop(
  fromPaneId: string,
  tabId: string,
  side?: PaneSide,
): void {
  localTabDrops.add(tabDropKey(fromPaneId, tabId, side));
}

function consumeLocalTabDrop(paneId: string, tabId: string, side?: PaneSide): boolean {
  const exact = side ? tabDropKey(paneId, tabId, side) : null;
  if (exact && localTabDrops.delete(exact)) return true;
  return localTabDrops.delete(tabDropKey(paneId, tabId));
}

export function shouldCloseTabAfterDragEnd(
  paneId: string,
  tabId: string,
  dropEffect: string | undefined,
  side?: PaneSide,
): boolean {
  // A cross-window drop that a target accepted (dropEffect === "move") leaves
  // the source tab still in this pane: remove it so the visual matches the
  // cross-window result. This now ALSO applies to terminals: all standalone
  // terminal windows share one `/terminal` tenant (one PTY registry), so the
  // target window re-attached to this SAME live PTY by id - a true MOVE. The
  // source close is made PTY-preserving by the drag-end's `markTerminalMovingOut`
  // (the close-sink then skips the WS `close` frame), so the terminal leaves
  // here with its shell + history intact and reappears in the target with no
  // duplicate. If the source pane then becomes empty, the close-on-last-tab
  // watcher closes the window - correct (no empty terminal window).
  if (dropEffect !== "move") return false;
  const localDrop = consumeLocalTabDrop(paneId, tabId, side);
  const n = layout.nodes[paneId];
  if (!n || n.kind !== "leaf") return false;
  const tabs = side ? paneTabs(n, side) : allPaneTabs(n);
  const stillHere = tabs.some((t) => t.id === tabId);
  return stillHere && !localDrop;
}

export function canReopenClosedTab(): boolean {
  return recentlyClosedTabs.length > 0;
}

export function clearRecentlyClosedTabsForTest(): void {
  recentlyClosedTabs.length = 0;
  localTabDrops.clear();
}

function rememberClosedTab(paneId: string, side: PaneSide, tab: Tab): void {
  recentlyClosedTabs.push({ paneId, side, tab: cloneTab(tab) });
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
  // A closed draft's backing file is always gone after its close (the close
  // path discards, promotes, or already found it missing), so re-adding its
  // dead path would open a missing-file tab pointing at the just-deleted
  // draft. Mint a fresh draft and carry the closed buffer's content into it
  // instead, so a reopen restores the user's text.
  if (isDraftTab(entry.tab)) {
    void recoverClosedDraft(target.id, entry.side, entry.tab);
    return true;
  }
  const tab = tabForReopen(entry.tab);
  if (tabIdExists(tab.id)) {
    tab.id = id(tab.kind === "terminal" ? "term" : "tab");
  }
  const side = entry.side;
  mutablePaneTabs(target, side).push(tab);
  setPaneActiveTabId(target, tab.id, side);
  target.side = side;
  layout.activePaneId = target.id;
  return true;
}

/// Reopen a closed draft as a fresh draft. The original draft file no
/// longer exists (discarded or promoted during the close), so mint a new
/// draft of the same kind (markdown or diagram) and seed it with the
/// closed buffer's content when that content is more than the default
/// seed. Async: draft creation is a server round-trip, so reopenClosedTab
/// fires this and returns.
async function recoverClosedDraft(
  paneId: string,
  side: PaneSide,
  closed: FileTab,
): Promise<void> {
  try {
    const diagram = isExcalidraw(closed.path);
    const { path } = diagram
      ? await api.createDiagram()
      : await api.createDraft();
    const seed = diagram ? NEW_DIAGRAM_SEED : NEW_DRAFT_SEED;
    if (closed.content.trim().length > 0 && closed.content !== seed) {
      await api.write(path, closed.content);
    }
    // Lazy import to break the eager cyclic dependency with store.svelte
    // (see the import-site comment at the top of this module).
    const { noteDraftCreated } = await import("./store.svelte");
    await noteDraftCreated(path);
    const node = layout.nodes[paneId];
    const openPaneId = node && node.kind === "leaf" ? paneId : activePane().id;
    await openInPane(openPaneId, path, {
      side,
    });
  } catch (err) {
    console.warn("[chan] reopen closed draft failed", err);
    notify(`Reopen draft failed: ${(err as Error).message}`);
  }
}

function tabIdExists(tabId: string): boolean {
  return Object.values(layout.nodes).some(
    (node) => node.kind === "leaf" && allPaneTabs(node).some((tab) => tab.id === tabId),
  );
}

function tabForReopen(src: Tab): Tab {
  const tab = cloneTab(src);
  if (tab.kind === "terminal") {
    tab.terminalSessionId = undefined;
    tab.submitAgent = undefined;
    tab.controlledTerminal = undefined;
    tab.lastAgentEchoSeq = undefined;
    tab.terminalEnvTabName = undefined;
    tab.terminalEnvTabGroup = undefined;
    tab.terminalEnvNamePromptDismissed = undefined;
    tab.terminalEnvPromptDismissedFor = undefined;
    tab.terminalMetadataDraft = undefined;
    tab.terminalMetadataPending = undefined;
    tab.terminalMetadataError = undefined;
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
  // Canvas mode has no text host for the find bar to mount into; the
  // whiteboard owns its own search. Opening find would set invisible
  // state, so no-op (source mode of the same file still finds).
  if (found.tab.mode === "canvas") return;
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
  const t = activeTabInPane(p);
  if (!t || t.kind !== "file") return null;
  return t;
}

export function activeTerminalTab(): TerminalTab | null {
  const p = activePane();
  const t = activeTabInPane(p);
  if (!t || t.kind !== "terminal") return null;
  return t;
}

export function activeGraphTab(): GraphTab | null {
  const p = activePane();
  const t = activeTabInPane(p);
  if (!t || t.kind !== "graph") return null;
  return t;
}

export function activeBrowserTab(): BrowserTab | null {
  const p = activePane();
  const t = activeTabInPane(p);
  if (!t || t.kind !== "browser") return null;
  return t;
}

export function activeDashboardTab(): DashboardTab | null {
  const p = activePane();
  const t = activeTabInPane(p);
  if (!t || t.kind !== "dashboard") return null;
  return t;
}

/// Toggle broadcast SELECT-ALL / DESELECT-ALL for the active terminal.
/// Chord-driven (Cmd+Shift+I) equivalent of the per-tab "Select All" /
/// "Deselect All" button. No-op when the active tab isn't a terminal.
export function toggleActiveTerminalBroadcastSelectAll(): void {
  const tab = activeTerminalTab();
  if (tab) toggleTerminalGroupBroadcast(tab);
}

/// Select-all / deselect-all for a terminal's whole broadcast GROUP, spanning
/// every window of the tenant (not just the local layout). Local same-group
/// tabs flip directly (self via broadcastEnabled, others via targets);
/// same-group terminals in OTHER windows flip via the server, which routes a
/// `terminal_broadcast` command to their owning window. "All on" is computed
/// across both so one click consistently fills or clears the group. Backs the
/// menu button and the Cmd+Shift+I chord.
export function toggleTerminalGroupBroadcast(tab: TerminalTab): void {
  const group = terminalTabGroup(tab);
  const localTargets = allTerminalTabs().filter(
    (t) => terminalTabGroup(t) === group,
  );
  const crossMembers = crossWindowBroadcastMembers(tab);
  if (localTargets.length === 0 && crossMembers.length === 0) return;
  const selected = new Set(terminalBroadcastMemberIds(tab));
  const localAllOn = localTargets.every((t) =>
    t.id === tab.id ? tab.broadcastEnabled : selected.has(t.id),
  );
  const crossAllOn = crossMembers.every((m) => m.broadcast);
  const select = !(localAllOn && crossAllOn);
  for (const target of localTargets) {
    if (target.id === tab.id) {
      setTerminalBroadcastEnabled(tab, select);
    } else {
      setTerminalBroadcastTarget(tab, target.id, select);
    }
  }
  for (const member of crossMembers) {
    void api.setTerminalSessionBroadcast(member.id, select);
  }
}

/// Set a local terminal's broadcast toggle by its live session id. This is
/// the `terminal_broadcast` window-command entry point: another window's Select All /
/// per-row toggle reaches the owning window here, which flips the matching
/// tab so the normal `set-broadcast` sync + sign + fan run unchanged. No-op
/// when no local tab hosts that session.
export function setTerminalBroadcastBySession(sessionId: string, on: boolean): void {
  const tab = allTerminalTabs().find((t) => t.terminalSessionId === sessionId);
  if (tab) setTerminalBroadcastEnabled(tab, on);
}

/// Team Work lead-terminal factory. Spawns a fresh (normal) terminal in the
/// active pane and returns it. The Cmd+P flow uses the returned handle so the
/// Team dialog can delete the just-spawned terminal if the user cancels before
/// committing; the orchestrator delivers the lead's identity prompt through the
/// write queue (the lead is a normal terminal - no bubble).
export function createTeamWorkLeadTerminal(
  opts: OpenTerminalOptions = {},
): TerminalTab | null {
  const p = activePane();
  const tab = openTerminalInPane(p.id, opts);
  // Mark it as a pending Team Work lead carrying the dialog's initial config.
  // The dialog edits this draft in place (and a reload reopens the dialog from
  // it); see `TerminalTab.teamWorkPending`.
  if (tab) tab.teamWorkPending = defaultTeamConfig();
  return tab;
}

/// Locate the open Team Work spawn-agents dialog's lead terminal, if any: the
/// single terminal tab still flagged `teamWorkPending`. Returns the
/// `{leadTabId, leadPaneId}` the dialog reopens against, or null when no team
/// setup is in flight. Used on reload by `store.svelte.ts` to reopen the dialog
/// over the restored lead terminal (the tab ids regenerate on restore, so the
/// per-tab flag is the bridge back to the right pane + tab).
export function findTeamWorkPendingLead(): TeamDialogRequest | null {
  for (const node of Object.values(layout.nodes)) {
    if (node.kind !== "leaf") continue;
    for (const tab of allPaneTabs(node)) {
      if (tab.kind === "terminal" && tab.teamWorkPending) {
        return { leadTabId: tab.id, leadPaneId: node.id };
      }
    }
  }
  return null;
}

/// Read the live config draft for a Team Work lead terminal (the dialog seeds
/// its form from this on open / reload). Null when the request no longer maps
/// to a pending lead terminal.
export function teamWorkPendingConfig(
  req: TeamDialogRequest,
): TeamDialogConfig | null {
  return teamWorkLeadTab(req)?.teamWorkPending ?? null;
}

/// Mirror the dialog's live config draft onto its lead terminal so it rides the
/// session payload (`SerTab.twk`) and survives a reload. The dialog calls this
/// on every edit; the caller also schedules a session save.
export function setTeamWorkPendingConfig(
  req: TeamDialogRequest,
  config: TeamDialogConfig,
): void {
  const tab = teamWorkLeadTab(req);
  if (tab) tab.teamWorkPending = config;
}

/// Clear the pending-dialog flag once Team Work has bootstrapped: the lead
/// terminal becomes a committed lead and must no longer reopen the dialog on a
/// subsequent reload.
export function clearTeamWorkPending(req: TeamDialogRequest): void {
  const tab = teamWorkLeadTab(req);
  if (tab) tab.teamWorkPending = undefined;
}

/// Resolve a dialog request to its lead TerminalTab, or null if the pane/tab no
/// longer exists or isn't a terminal.
function teamWorkLeadTab(req: TeamDialogRequest): TerminalTab | null {
  const node = layout.nodes[req.leadPaneId];
  if (!node || node.kind !== "leaf") return null;
  const found = findTabInPane(node, req.leadTabId);
  return found?.tab.kind === "terminal" ? found.tab : null;
}

export type OpenTerminalOptions = {
  cwd?: string;
  seedInput?: string;
  title?: string;
  sessionId?: string;
  controlledTerminal?: boolean;
  group?: string;
  side?: PaneSide;
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
  const side = opts.side ?? paneSide(p);
  const tabs = mutablePaneTabs(p, side);
  const cwd = opts.cwd?.trim();
  const seedInput = opts.seedInput?.trim();
  const title = opts.title?.trim();
  const group = opts.group?.trim();
  const tab: TerminalTab = {
    kind: "terminal",
    id: id("term"),
    // This is a creation proposal only. The attach prelude replaces it with
    // the registry-settled name before it becomes authoritative UI state.
    title: title || nextTerminalTitle(),
    createdAt: Date.now(),
    broadcastEnabled: false,
    broadcastTargetIds: [],
    terminalSessionId: opts.sessionId?.trim() || undefined,
    controlledTerminal: opts.controlledTerminal || undefined,
    cwd: cwd || undefined,
    seedInput: seedInput || undefined,
    group: group && group !== DEFAULT_TERMINAL_GROUP ? group : undefined,
  };
  tabs.push(tab);
  setPaneActiveTabId(p, tab.id, side);
  p.side = side;
  layout.activePaneId = p.id;
  // Mark an unnamed creation label as provisional. The server registry
  // settles it atomically with creation and the attach prelude replaces it.
  if (!title) {
    tab.pendingGlobalName = true;
  }
  return tab;
}

/// Re-attach payload for a session-preserving cross-window terminal MOVE.
/// Carried in the cross-window drag (CROSS_TAB_MIME) and consumed by
/// `reattachTerminalInPane`. All standalone terminal windows share one
/// `/terminal` tenant (one PTY registry), so the target window can attach to
/// this SAME live PTY by `terminalSessionId` instead of spawning a fresh
/// shell. The target's fresh xterm is empty, so its attach always replays
/// the session's full ring (like a reload); only the echo-dedupe cursor
/// travels with the move.
export type TerminalMovePayload = {
  terminalSessionId: string;
  title?: string;
  /// The moved shell's real CHAN_TAB_NAME (the source tab's env-name snapshot),
  /// so the target can tell whether a conflict-forced `-N` rename leaves the
  /// env stale and must surface the restart warning.
  terminalEnvTabName?: string;
  lastAgentEchoSeq?: number;
  group?: string;
  cwd?: string;
};

/// Re-attach a MOVED terminal to its existing live PTY in the target window's
/// pane. Distinct from `openTerminalInPane({ sessionId })`: this preserves the
/// moved terminal's NAME verbatim (NO renumber - it's the same terminal, just
/// in a new window) and carries the echo-dedupe cursor so agent echo replay
/// stays suppressed. The source tab is removed WITHOUT killing
/// the PTY (see `closeTab`'s `keepSession`), so the net effect is the terminal
/// leaving the source and appearing here with the same shell + history and no
/// duplicate. The PTY lives in the shared registry, so the attach succeeds.
export function reattachTerminalInPane(
  paneId: string,
  payload: TerminalMovePayload,
): TerminalTab | null {
  const p = layout.nodes[paneId];
  if (!p || p.kind !== "leaf") return null;
  const side = paneSide(p);
  const tabs = mutablePaneTabs(p, side);
  const sessionId = payload.terminalSessionId?.trim();
  if (!sessionId) return null;
  const group = payload.group?.trim();
  const tab: TerminalTab = {
    kind: "terminal",
    id: id("term"),
    // Preserve the last rendered value until the authoritative attach prelude
    // returns the live pair for this existing session.
    title: payload.title?.trim() || "Terminal",
    createdAt: Date.now(),
    broadcastEnabled: false,
    broadcastTargetIds: [],
    terminalSessionId: sessionId,
    // Carry immutable environment provenance until the same session's attach
    // prelude refreshes it.
    terminalEnvTabName: payload.terminalEnvTabName,
    controlledTerminal: undefined,
    // Carry the echo-dedupe cursor so the re-attach (`connect()` sends
    // `sessionId` + `agentEchoSince`) keeps agent echoes suppressed. The
    // fresh xterm replays the full ring, same as a reload.
    lastAgentEchoSeq: payload.lastAgentEchoSeq,
    cwd: payload.cwd?.trim() || undefined,
    seedInput: undefined,
    group: group && group !== DEFAULT_TERMINAL_GROUP ? group : undefined,
  };
  tabs.push(tab);
  setPaneActiveTabId(p, tab.id, side);
  p.side = side;
  layout.activePaneId = p.id;
  // Pull keyboard focus to the just-dropped terminal: making it the active
  // tab isn't enough on its own (the terminal's focus effect only grabs the
  // xterm on a focus pulse), so fire the same pulse a chord-driven tab switch
  // uses.
  bumpTabFocusPulse();
  return tab;
}

export type OpenGraphOptions = Partial<
  Pick<GraphTab, "mode" | "scopeId" | "depth" | "pendingSelectId" | "title" | "filters">
> & {
  side?: PaneSide;
};

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
  const side = opts.side ?? paneSide(p);
  const tabs = mutablePaneTabs(p, side);
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
    filters: opts.filters ? { ...opts.filters } : { ...DEFAULT_GRAPH_FILTERS },
    inspectorOpen: false,
    // A semantic workspace graph (no lens) opens focused on the
    // workspace-root node (id "", the server's directory_node_id("")), so
    // focus-on-select spotlights the root neighbourhood and the inspector
    // opens on it through the same pending-selection path the lenses use.
    // Lens opens pass their own focal node, which the ?? preserves;
    // filesystem / language modes have no root focus.
    pendingSelectId:
      opts.pendingSelectId ??
      (scopeId === "workspace" && mode === "semantic" ? "" : null),
  };
  tabs.push(tab);
  setPaneActiveTabId(p, tab.id, side);
  p.side = side;
  layout.activePaneId = p.id;
  return tab;
}

export type OpenBrowserOptions = {
  select?: string | null;
  side?: PaneSide;
};

export function openBrowserInActivePane(opts: OpenBrowserOptions = {}): BrowserTab {
  return openBrowserInPane(layout.activePaneId, opts);
}

export function openBrowserInPane(
  paneId: string,
  opts: OpenBrowserOptions = {},
): BrowserTab {
  const p = pane(paneId);
  const side = opts.side ?? paneSide(p);
  const tabs = mutablePaneTabs(p, side);
  // No dedup. Each press spawns a new browser tab with its own current
  // dir and inspector state.
  const tab: BrowserTab = {
    kind: "browser",
    id: id("browser"),
    title: nextBrowserTitle(),
    inspectorOpen: defaultBrowserInspectorOpen(),
    ...(opts.select ? { selected: opts.select } : {}),
  };
  tabs.push(tab);
  setPaneActiveTabId(p, tab.id, side);
  p.side = side;
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
    for (const tab of allPaneTabs(node)) {
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
  if (scopeId.startsWith("mention:")) {
    const mention = scopeId.slice("mention:".length);
    return `mention=${mention.startsWith("@@") ? mention : `@@${mention}`}`;
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

type TerminalMetadataSink = (metadata: TerminalMetadata) => boolean;
const terminalMetadataSinks = new Map<string, TerminalMetadataSink>();

function terminalMetadataDivergenceKey(tab: TerminalTab): string | null {
  const stale = terminalStaleEnvironmentVariables(tab);
  if (stale.length === 0) return null;
  return JSON.stringify([
    terminalTabName(tab),
    terminalTabGroup(tab),
    tab.terminalEnvTabName,
    tab.terminalEnvTabGroup,
  ]);
}

function applyTerminalLiveMetadata(
  tab: TerminalTab,
  name: string,
  group: string | null | undefined,
): TerminalMetadata {
  const settled = normalizeTerminalMetadata(name, group);
  const current = currentTerminalMetadata(tab);
  const draft = tab.terminalMetadataDraft;
  const draftIsClean =
    !tab.terminalMetadataPending &&
    !tab.terminalMetadataError &&
    (!draft || (draft.name === current.name && draft.group === current.group));
  const changed = current.name !== settled.name || current.group !== settled.group;
  tab.title = settled.name;
  setTerminalGroup(tab, settled.group);
  if (draftIsClean) tab.terminalMetadataDraft = settled;
  if (changed) {
    tab.terminalEnvNamePromptDismissed = false;
    tab.terminalEnvPromptDismissedFor = undefined;
    paneModeMarkStaleForAuthoritativeMetadata();
  }
  return settled;
}

export function registerTerminalMetadataSink(
  sessionId: string,
  sink: TerminalMetadataSink,
): () => void {
  terminalMetadataSinks.set(sessionId, sink);
  return () => {
    if (terminalMetadataSinks.get(sessionId) !== sink) return;
    terminalMetadataSinks.delete(sessionId);
    failTerminalMetadataRename(
      sessionId,
      "Connection closed before the metadata update was confirmed.",
    );
  };
}

/// Submit one atomic name/group proposal through the mounted terminal socket.
/// The tab and roster stay authoritative until a `renamed` frame settles it.
export function proposeTerminalMetadata(
  tab: TerminalTab,
  name: string,
  group: string | null | undefined,
): boolean {
  if (tab.terminalMetadataPending) return false;
  const proposal = normalizeTerminalMetadata(name, group);
  tab.terminalMetadataDraft = { name, group: group ?? "" };
  tab.terminalMetadataError = undefined;

  const sessionId = tab.terminalSessionId;
  const sink = sessionId ? terminalMetadataSinks.get(sessionId) : undefined;
  if (!sessionId || !sink) {
    tab.terminalMetadataError = "Terminal is disconnected.";
    return false;
  }

  tab.terminalMetadataPending = proposal;
  let sent = false;
  try {
    sent = sink(proposal);
  } catch {
    sent = false;
  }
  if (!sent) {
    tab.terminalMetadataPending = undefined;
    tab.terminalMetadataError = "Terminal is disconnected.";
    return false;
  }
  return true;
}

export function renameTerminalTab(
  tab: TerminalTab,
  title: string,
  group = terminalMetadataDraft(tab).group,
): boolean {
  return proposeTerminalMetadata(tab, title, group);
}

/// Apply a successful `renamed` acknowledgement to every local copy of the
/// terminal session. The server's complete settled pair replaces the draft.
export function resolveTerminalMetadataRename(
  sessionId: string,
  name: string,
  group: string | null | undefined,
): void {
  const settled = normalizeTerminalMetadata(name, group);
  for (const tab of terminalTabsBySession(sessionId)) {
    applyTerminalLiveMetadata(tab, settled.name, settled.group);
    tab.terminalMetadataDraft = settled;
    tab.terminalMetadataPending = undefined;
    tab.terminalMetadataError = undefined;
  }
}

/// Resolve a nonfatal `rename_failed` frame. The authoritative pair remains
/// unchanged and the submitted draft stays available for correction.
export function failTerminalMetadataRename(sessionId: string, message: string): void {
  for (const tab of terminalTabsBySession(sessionId)) {
    if (!tab.terminalMetadataPending) continue;
    tab.terminalMetadataPending = undefined;
    tab.terminalMetadataError = message.trim() || "Terminal metadata update failed.";
  }
}

/// Apply the authoritative attach prelude. A reconnect cancels any unconfirmed
/// proposal and never resubmits it; the server snapshot wins in full.
export function applyTerminalSessionMetadata(
  tab: TerminalTab,
  metadata: TerminalSessionMetadata,
): void {
  const previousDivergence = terminalMetadataDivergenceKey(tab);
  const live = applyTerminalLiveMetadata(tab, metadata.name, metadata.group);
  tab.terminalEnvTabName = metadata.spawnName ?? undefined;
  tab.terminalEnvTabGroup = metadata.spawnGroup ?? undefined;
  tab.terminalMetadataDraft = live;
  tab.terminalMetadataPending = undefined;
  tab.terminalMetadataError = undefined;
  if (previousDivergence !== terminalMetadataDivergenceKey(tab)) {
    tab.terminalEnvNamePromptDismissed = false;
    tab.terminalEnvPromptDismissedFor = undefined;
  }
}

export type TerminalEnvironmentVariable = "$CHAN_TAB_NAME" | "$CHAN_TAB_GROUP";

export function terminalStaleEnvironmentVariables(
  tab: TerminalTab,
): TerminalEnvironmentVariable[] {
  if (!tab.terminalSessionId) return [];
  const stale: TerminalEnvironmentVariable[] = [];
  if (
    tab.terminalEnvTabName != null &&
    terminalTabName(tab) !== tab.terminalEnvTabName
  ) {
    stale.push("$CHAN_TAB_NAME");
  }
  if (
    tab.terminalEnvTabGroup != null &&
    terminalTabGroup(tab) !== (tab.terminalEnvTabGroup.trim() || DEFAULT_TERMINAL_GROUP)
  ) {
    stale.push("$CHAN_TAB_GROUP");
  }
  return stale;
}

export function terminalEnvTabNameStale(tab: TerminalTab): boolean {
  return terminalStaleEnvironmentVariables(tab).includes("$CHAN_TAB_NAME");
}

export function terminalEnvironmentPromptDismissed(tab: TerminalTab): boolean {
  const key = terminalMetadataDivergenceKey(tab);
  return key !== null && tab.terminalEnvPromptDismissedFor === key;
}

export function dismissTerminalEnvironmentPrompt(tab: TerminalTab): void {
  const key = terminalMetadataDivergenceKey(tab);
  if (!key) return;
  tab.terminalEnvPromptDismissedFor = key;
  tab.terminalEnvNamePromptDismissed = true;
}

export function markTerminalEnvironmentRestarted(tab: TerminalTab): void {
  tab.terminalEnvTabName = terminalTabName(tab);
  tab.terminalEnvTabGroup = terminalTabGroup(tab);
  tab.terminalEnvNamePromptDismissed = false;
  tab.terminalEnvPromptDismissedFor = undefined;
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
  // Broadcast is scoped to the source's group: only same-group terminals
  // are ever members. A single-member group has no targets (no-op).
  const group = terminalTabGroup(tab);
  const inGroup = new Set(
    allTerminalTabs()
      .filter((t) => terminalTabGroup(t) === group)
      .map((t) => t.id),
  );
  return [...terminalBroadcastGroupIds()].filter((id) => inGroup.has(id));
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

// --- Cross-window terminal roster ---
// `allTerminalTabs()` is this window's local layout only. The roster carries
// every live session across ALL windows of the tenant (all standalone
// terminal windows, or all windows of one workspace), so a window can see
// same-group terminals it does not host. Seeded from `api.terminalRoster()`
// on `/ws` (re)connect and refreshed by `terminal_roster` `/ws` frames.
let terminalRoster = $state<TerminalRosterEntry[]>([]);

/// Replace the roster wholesale (the server pushes full snapshots, so there
/// is no delta to reconcile). Called by the `/ws` `terminal_roster` handler
/// and the reconnect seed.
export function applyTerminalRoster(entries: TerminalRosterEntry[]): void {
  terminalRoster = entries;
  reconcileLocalMetadataFromRoster(entries);
}

/// Align every local copy with the server's atomic live name/group pair. A
/// component draft remains separate, so a roster update cannot be overwritten
/// merely by repainting the controls.
function reconcileLocalMetadataFromRoster(entries: TerminalRosterEntry[]): void {
  for (const entry of entries) {
    for (const tab of terminalTabsBySession(entry.id)) {
      applyTerminalLiveMetadata(
        tab,
        entry.tab_name ?? terminalTabName(tab),
        entry.tab_group,
      );
    }
  }
}

/// Same-group sessions in OTHER windows of this tenant. The broadcast menu
/// lists these read-only (cross-window broadcast is group-level by nature -
/// visible but not individually selectable) and the indicator counts the
/// ones that have opted in. Sessions with no `window_id` are skipped: they
/// cannot be attributed to a window, and this window's own sessions are
/// excluded (already shown as local tabs).
export function crossWindowBroadcastMembers(tab: TerminalTab): TerminalRosterEntry[] {
  const group = terminalTabGroup(tab);
  const myWindow = sessionWindowId();
  return terminalRoster.filter(
    (e) => e.tab_group === group && e.window_id != null && e.window_id !== myWindow,
  );
}

/// How many OTHER terminals this terminal's broadcast input reaches: local
/// same-window targets plus same-group cross-window members that have opted
/// in (broadcast on). Mirrors the server's cross-window fan gate, which only
/// delivers to members with their own broadcast toggle on. Drives the
/// broadcast indicator's count.
export function terminalBroadcastReachCount(tab: TerminalTab): number {
  const local = tab.broadcastTargetIds.length;
  const cross = crossWindowBroadcastMembers(tab).filter((e) => e.broadcast).length;
  return local + cross;
}

export function setTerminalSession(tab: TerminalTab, sessionId: string): void {
  const wasFresh = !tab.terminalSessionId || tab.terminalSessionId !== sessionId;
  tab.terminalSessionId = sessionId;
  if (wasFresh) {
    tab.submitAgent = undefined;
    tab.lastAgentEchoSeq = undefined;
    tab.terminalEnvTabName = undefined;
    tab.terminalEnvTabGroup = undefined;
    tab.terminalEnvNamePromptDismissed = false;
    tab.terminalEnvPromptDismissedFor = undefined;
    tab.terminalMetadataPending = undefined;
    tab.terminalMetadataError = undefined;
  }
}

export function setTerminalSubmitAgent(
  tab: TerminalTab,
  submitAgent: SubmitAgent | undefined,
): void {
  tab.submitAgent = submitAgent;
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

/// MESSAGE depth of this terminal's server-side write queue. 0 collapses to
/// undefined so badges/labels render on truthiness like terminalActivity.
export function setTerminalQueueDepth(tab: TerminalTab, depth: number): void {
  tab.queueDepth = depth > 0 ? depth : undefined;
}

/// Start tracking an in-flight Rich Prompt message: phase "sent" (the
/// `prompt` frame went out on an open socket; no ack yet).
export function beginPendingPrompt(tab: TerminalTab, id: string): void {
  tab.pendingPrompt = { id, phase: "sent" };
}

/// Resolve the in-flight prompt by id. Stale/foreign ids no-op: every
/// attached socket sees every `prompt-delivered`, so a second window (or a
/// reattach replay) must not flip a pending message it does not own.
export function resolvePendingPrompt(
  tab: TerminalTab,
  id: string,
  phase: "queued" | "delivered" | "rejected",
  depth?: number,
): void {
  const pending = tab.pendingPrompt;
  if (!pending || pending.id !== id) return;
  tab.pendingPrompt = { ...pending, phase, ...(depth !== undefined ? { depth } : {}) };
}

/// Resolve a `prompt-cancelled` ack (the recall round-trip). `removed:true`
/// means the still-queued message was pulled from the queue before it hit the
/// PTY → phase "recalled" (the bubble unlocks + keeps the draft text so the
/// user edits and resubmits with a fresh id, no double-delivery). `removed:
/// false` means it raced a drain and already delivered → phase "drained" (the
/// bubble surfaces "already sent" rather than letting the user silently
/// re-edit a delivered message). Stale/foreign ids no-op (same guard as
/// `resolvePendingPrompt` -- every attached socket sees acks it doesn't own).
export function resolvePromptCancelled(tab: TerminalTab, id: string, removed: boolean): void {
  const pending = tab.pendingPrompt;
  if (!pending || pending.id !== id) return;
  tab.pendingPrompt = { ...pending, phase: removed ? "recalled" : "drained" };
}

/// On (re)attach, re-prove a RESTORED pending Rich Prompt message against the
/// server's authoritative `queued_prompt_ids` (FIFO order) so a queued message
/// survives a window reload (GAP 2 / the reload contract). If the restored id
/// is still in the queue, re-lock + re-show it with its position (index + 1);
/// if it's gone (drained/delivered before the reload) clear it so the editor
/// unlocks. Only acts on a restored in-flight phase ("queued"/"sent"); a
/// terminal phase is left for the bubble's own resolution. Mutates outside any
/// `$derived` (caller is the WS `session`-frame handler).
export function reproveRestoredPrompt(tab: TerminalTab, queuedIds: string[]): void {
  const pending = tab.pendingPrompt;
  if (!pending) return;
  // Only re-prove a "queued" message (the persisted/acked state). A live "sent"
  // (just submitted, pre-ack) is the ack flow's to resolve -- a reattach session
  // frame must not race-clear it before its prompt-ack arrives.
  if (pending.phase !== "queued") return;
  const idx = queuedIds.indexOf(pending.id);
  if (idx >= 0) {
    tab.pendingPrompt = { ...pending, phase: "queued", depth: idx + 1 };
  } else {
    tab.pendingPrompt = undefined;
  }
}

/// Fail the in-flight prompt unconditionally (WS close / session end / ack
/// timeout -- paths with no message id in hand). The bubble unlocks, keeps
/// the text, and labels honestly: the message may still be queued
/// server-side, but this client can no longer observe its delivery.
export function failPendingPrompt(tab: TerminalTab): void {
  const pending = tab.pendingPrompt;
  if (!pending) return;
  tab.pendingPrompt = { ...pending, phase: "failed" };
}

export function clearTerminalSession(tab: TerminalTab): void {
  if (tab.terminalMetadataPending) {
    tab.terminalMetadataPending = undefined;
    tab.terminalMetadataError =
      "Connection closed before the metadata update was confirmed.";
  }
  tab.terminalSessionId = undefined;
  tab.submitAgent = undefined;
  tab.lastAgentEchoSeq = undefined;
  tab.terminalActivity = undefined;
  tab.terminalActivityPulsing = undefined;
  tab.terminalEnvTabName = undefined;
  tab.terminalEnvTabGroup = undefined;
  tab.terminalEnvNamePromptDismissed = false;
  tab.terminalEnvPromptDismissedFor = undefined;
}

export function allTerminalTabs(): TerminalTab[] {
  return terminalTabsIn(layout);
}

/// Find a TerminalTab by its chan-server session id. Used by the team
/// orchestrator to locate the tab and populate its team-work buffer.
/// Returns null when no matching tab is open; the orchestrator silently
/// skips the lead-prompt step in that case.
export function findTerminalBySession(sessionId: string): TerminalTab | null {
  return terminalTabsBySession(sessionId)[0] ?? null;
}

function terminalTabsBySession(sessionId: string): TerminalTab[] {
  if (!sessionId) return [];
  return allTerminalTabs().filter((tab) => tab.terminalSessionId === sessionId);
}

/// True when this window holds at least one tab of any kind. A window with no
/// tabs is a single empty leaf (the `serializeLayout` null case) or an all-empty
/// split; both serialize to nothing worth recording. The desktop red-dot close
/// uses this to close an empty window straight away (never recording it) versus
/// prompting Hide / Close / Cancel for a window with real tabs.
export function hasAnyTab(): boolean {
  return Object.values(layout.nodes).some(
    (node) => node.kind === "leaf" && paneHasAnyTabs(node),
  );
}

export function hasGraphTab(): boolean {
  return Object.values(layout.nodes).some(
    (node) => node.kind === "leaf" && allPaneTabs(node).some((tab) => tab.kind === "graph"),
  );
}

export function hasBrowserTab(): boolean {
  return Object.values(layout.nodes).some(
    (node) => node.kind === "leaf" && allPaneTabs(node).some((tab) => tab.kind === "browser"),
  );
}

type TerminalInputSink = (data: string) => void;
const terminalInputSinks = new Map<string, TerminalInputSink>();
type TerminalCloseSink = () => boolean | void | Promise<boolean | void>;
const terminalCloseSinks = new Map<string, TerminalCloseSink>();

/// Tab ids that are LEAVING this window via a session-preserving cross-window
/// move. When `closeTab` tears such a tab down, the terminal close-sink
/// (`closeTerminalForTab` in TerminalTab.svelte) consults this set and SKIPS
/// the WS `close` frame, so the PTY stays alive in the shared `/terminal`
/// registry for the target window to re-attach to. Window-local cleanup
/// (Rich Prompt draft, bubble entry) still runs - the tab really is gone from
/// THIS window. The set carries this state because the close-sink takes no args; it
/// is drained on consult (see `isTerminalMoving`) so a normal later close of a
/// re-created tab with a colliding id still kills its PTY.
const terminalsMovingOut = new Set<string>();

/// Mark a terminal tab as moving out (PTY kept alive) for the duration of the
/// drag-end close. Called by the source pane's drag-end before `closeTab`.
export function markTerminalMovingOut(tabId: string): void {
  terminalsMovingOut.add(tabId);
}

/// Whether `tabId` is leaving via a session-preserving move; consumes the
/// flag (one-shot) so it can't leak into a later real close. The terminal
/// close-sink calls this to decide whether to send the WS `close` frame.
export function isTerminalMoving(tabId: string): boolean {
  return terminalsMovingOut.delete(tabId);
}

/// Records whether the most recent terminal-tab close was a session-preserving
/// cross-window MOVE (vs a real close). `closeTab` sets it just before it
/// removes the tab -- so the empty-window discard guard, which fires reactively
/// right after, reads the LAST close's intent deterministically (set before the
/// mutation, no effect-vs-teardown ordering race). A non-move close clears it.
let lastTerminalCloseWasMoveOut = false;

/// One-shot read for the window-discard guard: was the close that just emptied
/// this window a terminal move-out? If so the source's discard must DELETE its
/// blob but NOT reap -- the moved PTY lives on, re-bound to the target window.
export function consumeLastCloseWasMoveOut(): boolean {
  const v = lastTerminalCloseWasMoveOut;
  lastTerminalCloseWasMoveOut = false;
  return v;
}

export function registerTerminalInputSink(tabId: string, sink: TerminalInputSink): () => void {
  terminalInputSinks.set(tabId, sink);
  return () => {
    if (terminalInputSinks.get(tabId) === sink) terminalInputSinks.delete(tabId);
  };
}

// Rich Prompt sender. Mirrors the input-sink registry but feeds the terminal
// WS `prompt` frame (NOT the raw `input` keystroke path): each TerminalTab
// registers a sink that enqueues into THIS session's server-side write queue,
// where it shares one FIFO with `cs terminal write` and auto-submits in order.
// Keeping it a separate registry lets the Rich Prompt bubble reach the active
// terminal without touching TerminalTab internals. The sink returns whether the
// frame actually went out (the WS was open) so callers can retry a freshly-
// spawned terminal whose socket has not connected yet (the team lead bootstrap).
type TerminalPromptSink = (data: string, agent?: string, id?: string) => boolean;
const terminalPromptSinks = new Map<string, TerminalPromptSink>();

export function registerTerminalPromptSink(
  tabId: string,
  sink: TerminalPromptSink,
): () => void {
  terminalPromptSinks.set(tabId, sink);
  return () => {
    if (terminalPromptSinks.get(tabId) === sink) terminalPromptSinks.delete(tabId);
  };
}

/// Send a prompt to a SPECIFIC terminal's write queue via its WS `prompt`
/// frame. Returns false when that terminal has no live prompt sink OR its WS
/// is not open yet (so the caller can retry). The team orchestrator uses this
/// to auto-deliver the lead's identity prompt to the freshly-spawned lead
/// terminal once its socket connects (the lead is a normal terminal now - no
/// bubble - so its identity arrives through the same queue as every prompt).
/// `id` tags the message for queue-visibility tracking (prompt-ack /
/// prompt-delivered frames). Omitted = legacy fire-and-forget -- the team
/// orchestrator's lead-identity prompt stays untagged on purpose.
export function sendPromptToTerminal(
  tabId: string,
  data: string,
  agent?: string,
  id?: string,
): boolean {
  const sink = terminalPromptSinks.get(tabId);
  if (!sink) return false;
  return sink(data, agent, id);
}

/// Cancel/recall sink: send a `cancel-prompt` frame on a SPECIFIC terminal's
/// WS so the server removes a still-queued message by its `prompt_id`. Mirrors
/// the prompt sink so RichPrompt can reach the terminal's socket without owning
/// it. Returns false when the terminal has no live sink / its WS is closed.
type TerminalCancelSink = (id: string) => boolean;
const terminalCancelSinks = new Map<string, TerminalCancelSink>();

export function registerTerminalCancelSink(
  tabId: string,
  sink: TerminalCancelSink,
): () => void {
  terminalCancelSinks.set(tabId, sink);
  return () => {
    if (terminalCancelSinks.get(tabId) === sink) terminalCancelSinks.delete(tabId);
  };
}

export function sendCancelToTerminal(tabId: string, id: string): boolean {
  const sink = terminalCancelSinks.get(tabId);
  if (!sink) return false;
  return sink(id);
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
  // `terminalBroadcastMemberIds` already scopes to the source's group;
  // the group re-check below is defensive (a member could change group
  // between resolution and fan-out, though group change requires restart).
  const targets = new Set(terminalBroadcastMemberIds(sourceTab));
  if (targets.size === 0) return;
  const group = terminalTabGroup(sourceTab);
  for (const tab of allTerminalTabs()) {
    if (tab.id === sourceTab.id || !targets.has(tab.id)) continue;
    if (terminalTabGroup(tab) !== group) continue;
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

function isDraftTab(t: Tab): t is FileTab {
  return t.kind === "file" && isDraftPath(t.path);
}

function draftDefaultTarget(
  info: { name: string; has_attachments: boolean },
  sourcePath: string,
): string {
  if (info.has_attachments) return info.name;
  // Keep the draft's own extension so a diagram promotes to
  // `<name>.excalidraw`, not a mis-extensioned `.md` holding scene JSON.
  // Default to `.md` when the primary file carries no extension.
  const dot = sourcePath.lastIndexOf(".");
  const slash = sourcePath.lastIndexOf("/");
  const ext = dot > slash ? sourcePath.slice(dot) : ".md";
  return `${info.name}${ext}`;
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
    const found = findTabInPane(node, tabId);
    return found?.tab.kind === "file" ? found.tab : undefined;
  };
  try {
    const start = live();
    if (start) {
      start.content = "";
      start.saved = "";
      start.savedMtime = null;
      start.savedMtimeNs = null;
      start.authorityVersion = null;
      start.diskConflicted = false;
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
        t.authorityVersion = meta.authority_version ?? null;
        t.diskConflicted = meta.disk_conflicted ?? false;
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
      t.openedEmpty = r.content.trim().length === 0;
      t.savedMtime = r.mtime ?? null;
      t.savedMtimeNs = r.mtime_ns ?? null;
      t.authorityVersion = r.authority_version ?? null;
      t.diskConflicted = r.disk_conflicted ?? false;
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

/// Peek whether `path` opens as text without downloading it whole. Reuses the
/// server's content gate (`read_text_with_stat`, shared with `cs open`): the
/// stream read emits its meta for a plaintext file -- we abort right after -- and
/// fails with a 415 for a binary one. "error" (a real read failure, e.g. a
/// missing file) lets the caller fall through to a normal open so the editor tab
/// surfaces the actual cause.
async function probeOpenableAsText(
  path: string,
): Promise<"openable" | "binary" | "error"> {
  const controller = new AbortController();
  try {
    await api.readStream(path, {
      signal: controller.signal,
      onMeta() {
        // The server accepted it as text; stop the download here -- the real
        // load re-reads it into the tab.
        controller.abort();
      },
    });
    return "openable"; // a small file finished before the abort landed
  } catch (e) {
    if (controller.signal.aborted) return "openable"; // aborted after meta = text
    if (e instanceof ApiError && e.status === 415) return "binary";
    return "error";
  }
}

/// Open a file in a specific pane. If already open there, just focus.
export async function openInPane(
  paneId: string,
  path: string,
  opts: OpenFileOptions = {},
): Promise<void> {
  const requestedDestination: TabDestination = { paneId, side: opts.side };
  if (!resolveTabDestination(requestedDestination)) return;
  // The extension may not be editable, but the file can still be plaintext (an
  // odd suffix, no extension). Peek the content and let the server's gate
  // decide -- matching `cs open`. Editable-by-extension files skip the peek.
  // A binary file is refused (it stays view-only in the browser/inspector); a
  // real read error falls through to a normal open so the tab shows the cause.
  if (!isEditableText(path) && (await probeOpenableAsText(path)) === "binary") {
    notify(`'${path}' is not a text file`);
    return;
  }
  const destination = resolveTabDestination(requestedDestination);
  if (!destination) return;
  const p = pane(destination.paneId);
  const side = destination.side;
  const tabs = mutablePaneTabs(p, side);
  const pendingReopen =
    pendingMissingFileReopenTabId === null
      ? undefined
      : tabs.find(
          (t): t is FileTab =>
            t.kind === "file" &&
            t.id === pendingMissingFileReopenTabId &&
            t.fileMissing !== null,
        );
  if (pendingReopen) {
    pendingMissingFileReopenTabId = null;
    const pathKind = classifyPath(path);
    // A non-extension-editable file that passed the content peek is source-like
    // (an odd suffix, not markdown), so it opens in source mode, not wysiwyg.
    pendingReopen.fileKind =
      pathKind === "document" || pathKind === "text" ? pathKind : "text";
    pendingReopen.path = path;
    pendingReopen.content = "";
    pendingReopen.saved = "";
    pendingReopen.savedMtime = null;
    pendingReopen.savedMtimeNs = null;
    pendingReopen.authorityVersion = null;
    pendingReopen.diskConflicted = false;
    pendingReopen.mode = defaultModeForPath(path, pendingReopen.fileKind);
    pendingReopen.loading = true;
    pendingReopen.error = null;
    pendingReopen.fileMissing = null;
    pendingReopen.repoRoot = null;
    pendingReopen.fsWritable = true;
    if (opts.landAtTop) issueCaretCommand(pendingReopen, 0, 0);
    else if (opts.initialSelection)
      pendingReopen.caret = { ...opts.initialSelection };
    setPaneActiveTabId(p, pendingReopen.id, side);
    p.side = side;
    layout.activePaneId = paneId;
    bumpTabFocusPulse();
    await loadTabContent(paneId, pendingReopen.id, path);
    return;
  }
  const existing = tabs.find(
    (t): t is FileTab => t.kind === "file" && t.path === path,
  );
  if (existing) {
    // The tab is kept alive and its editor has latched its mount-time caret,
    // so a reopen must re-drive the caret imperatively (an explicit open lands
    // at top; a search/link reopen jumps to its selection). A plain refocus
    // with no caret intent leaves the caret where the user left it.
    if (opts.landAtTop) issueCaretCommand(existing, 0, 0);
    else if (opts.initialSelection)
      issueCaretCommand(
        existing,
        opts.initialSelection.from,
        opts.initialSelection.to,
      );
    setPaneActiveTabId(p, existing.id, side);
    p.side = side;
    layout.activePaneId = paneId;
    bumpTabFocusPulse();
    return;
  }
  // Path-based classification picks the initial mode: markdown-class
  // files start in wysiwyg (the wisp of formatting they carry is
  // worth rendering); arbitrary source / config text starts in source
  // mode (wysiwyg would just render the raw bytes with no visible
  // benefit, plus the menu hides the toggle for text-kind tabs).
  const pathKind = classifyPath(path);
  // A non-extension-editable file that passed the content peek is source-like
  // (an odd suffix, not markdown), so it opens in source mode, not wysiwyg.
  const fileKind: FileKind =
    pathKind === "document" || pathKind === "text" ? pathKind : "text";
  const newTab: FileTab = {
    kind: "file",
    fileKind,
    id: id("tab"),
    path,
    content: "",
    saved: "",
    savedMtime: null,
    savedMtimeNs: null,
    authorityVersion: null,
    diskConflicted: false,
    mode: defaultModeForPath(path, fileKind),
    loading: true,
    error: null,
    fileMissing: null,
    inspectorOpen: false,
    outlineOpen: false,
    slidePreview: { open: false, index: 0, mode: "preview" },
    repoRoot: null,
    readMode: false,
    fsWritable: true,
    styleToolbarOpen: false,
    syntaxHighlight: true,
    highlightTrailingWhitespace: false,
    codeBlocksCollapsed: false,
  };
  // A brand-new tab mounts its editor fresh, so `initialCaret` (seeded from
  // `caret`) lands the position with no imperative command needed. landAtTop
  // forces top, overriding any restored position.
  if (opts.landAtTop) newTab.caret = { from: 0, to: 0 };
  else if (opts.initialSelection) newTab.caret = { ...opts.initialSelection };
  tabs.push(newTab);
  setPaneActiveTabId(p, newTab.id, side);
  p.side = side;
  layout.activePaneId = paneId;
  // Pull keyboard focus to the just-opened editor: making it the active tab
  // isn't enough on its own (the editor's focus effect only grabs the live
  // ref on a focus pulse, and the prior terminal's xterm keeps DOM focus).
  // This is the `cs open {path}` path too (handleWindowCommand -> openInPane).
  bumpTabFocusPulse();
  await loadTabContent(paneId, newTab.id, path);
  maybeAutoOpenSlidesOutline(paneId, newTab.id);
  restoreSavedCaretAfterLoad(paneId, newTab.id, path, opts);
}

/// A freshly opened slides file auto-opens the Outline once. Slide-ness is
/// only knowable after the content loads (a `chan:` frontmatter block with
/// `kind: slides`, parsed client-side), and the Outline is where the slide
/// Preview / Present controls live, so a first open surfaces them.
///
/// Re-fetch the live tab by id: `loadTabContent` mutates the $state proxy
/// stored by `p.tabs.push`, not the pre-push `newTab` reference, whose
/// `content` is still "" after the await. This fires only on a first open
/// through `openInPane`; session restore, reload-from-disk, duplication, and
/// refocus of an existing tab all bypass this spot, so a user who closes the
/// Outline (persisted as the `ol` bit) keeps it closed on the next reload.
function maybeAutoOpenSlidesOutline(paneId: string, tabId: string): void {
  const node = layout.nodes[paneId];
  if (!node || node.kind !== "leaf") return;
  const found = findTabInPane(node, tabId);
  const t = found?.tab.kind === "file" ? found.tab : undefined;
  if (!t || t.error || t.fileMissing || t.outlineOpen) return;
  if (parseSlidesSpec(t.content) === null) return;
  setTabOutlineOpen(t, true);
}

/// Once a fresh open finishes streaming, settle the caret and pull focus into
/// the editor:
///   - an explicit top-open (landAtTop, e.g. `cs open <file>`) issues a caret
///     command at the document start so the editor re-claims focus once the
///     content lands. An empty new file otherwise never grabs focus: the
///     editor's own caret-restore bails on a zero-length doc.
///   - an implicit open (a link / mention / reopen of a closed file) lands the
///     per-file SAVED caret, and only while the caret is still parked at top,
///     so it never overrides a caret the user moved while the file streamed in.
///   - an open-at-selection (initialSelection) set its caret at open time and
///     is skipped here.
/// Running AFTER the load lands on the FULL doc (the large-file park), never
/// clamped to a partial stream.
function restoreSavedCaretAfterLoad(
  paneId: string,
  tabId: string,
  path: string,
  opts: OpenFileOptions,
): void {
  if (opts.initialSelection) return;
  const node = layout.nodes[paneId];
  if (!node || node.kind !== "leaf") return;
  const found = findTabInPane(node, tabId);
  const t = found?.tab.kind === "file" ? found.tab : undefined;
  if (!t || t.error || t.fileMissing) return;
  // Explicit top-open: re-claim focus at the doc start regardless of any
  // saved caret (so this never consults readCaret).
  if (opts.landAtTop) {
    issueCaretCommand(t, 0, 0);
    return;
  }
  const saved = readCaret(path);
  if (!saved) return;
  if (t.caret && (t.caret.from !== 0 || t.caret.to !== 0)) return;
  issueCaretCommand(t, saved.from, saved.to);
}

export function openInActivePane(
  path: string,
  opts: OpenFileOptions = {},
): Promise<void> {
  return openInPane(layout.activePaneId, path, opts);
}

/// Open a wiki / markdown-link target, resolving an extension-less stem
/// to the real on-disk file before opening. A `[[note]]` pill (and a
/// `[[` picker pick) carries the raw stem `note`; the pill's kind probe
/// resolves it through `/api/resolve-link` (which tries `note.md` /
/// `note.txt` / `note`), so the pill renders as a valid link. But the
/// click previously handed that raw stem straight to `openInActivePane`,
/// and the file read route opens the path verbatim (no extension probe)
/// -- so it 404'd and the tab flashed a false "document not found" for a
/// file that's right there on disk. Resolve through the SAME probe here
/// so the click opens `note.md`. A failed resolve falls back to the raw
/// target so a genuinely broken link still lands on the missing-file
/// banner with the real cause rather than swallowing the click.
export async function openLinkTarget(
  target: string,
  opts: OpenFileOptions = {},
): Promise<void> {
  let path = target;
  try {
    const res = await api.resolveLink(target);
    // A link to a directory opens the file browser at that folder rather
    // than the text editor (which would reject it as "not a text file").
    if (res.is_dir) {
      openBrowserInActivePane({ select: res.path });
      return;
    }
    path = res.path;
  } catch {
    // Unresolvable (broken link / network): open the raw target so the
    // editor surfaces the missing file instead of silently no-op'ing.
  }
  await openInActivePane(path, opts);
}

/// Move the active pane's selection through side A's tabs followed by side
/// B's tabs. Previous wraps from side A's first tab to side B's last tab;
/// next wraps from side B's last tab to side A's first tab. A one-sided pane
/// therefore cycles within that side. If the visible side has no valid active
/// tab, next enters the first tab and previous enters the last tab in the
/// combined order.
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
  const side = paneSide(p);
  const tabs = paneTabOrder(p);
  const activeId = paneActiveTabId(p, side);
  if (tabs.length === 0) return;
  const idx = tabs.findIndex((entry) => entry.side === side && entry.tab.id === activeId);
  const target =
    idx < 0 ? tabs[tabs.length - 1]! : tabs[(idx - 1 + tabs.length) % tabs.length]!;
  setPaneActiveTabId(p, target.tab.id, target.side);
  p.side = target.side;
  bumpTabFocusPulse();
}

export function selectNextTabInActivePane(): void {
  const p = activePane();
  const side = paneSide(p);
  const tabs = paneTabOrder(p);
  const activeId = paneActiveTabId(p, side);
  if (tabs.length === 0) return;
  const idx = tabs.findIndex((entry) => entry.side === side && entry.tab.id === activeId);
  const target = idx < 0 ? tabs[0]! : tabs[(idx + 1) % tabs.length]!;
  setPaneActiveTabId(p, target.tab.id, target.side);
  p.side = target.side;
  bumpTabFocusPulse();
}

/// Select the Nth tab in the active pane (0-indexed). Silent no-op
/// when the index is out of range, matching the browser behavior of
/// Cmd+9 jumping to the last tab only when nine or more exist.
export function selectTabAtIndexInActivePane(index: number): void {
  const p = activePane();
  const side = paneSide(p);
  const tabs = paneTabs(p, side);
  if (index < 0 || index >= tabs.length) return;
  setPaneActiveTabId(p, tabs[index].id, side);
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
  const found = findTabInPane(p, tabId);
  if (!found) return;
  const { tabs, index: idx, tab, side } = found;
  // Capture move-out intent NOW, before the terminal close-sink below consumes
  // `terminalsMovingOut`. A cross-window MOVE marks the tab moving-out
  // (Pane.svelte drag-end) right before this call.
  const movingOut = tab.kind === "terminal" && terminalsMovingOut.has(tabId);
  if (isDraftTab(tab) && !opts?.force) {
    if (!(await handleDraftTabClose(tab))) return;
  } else if (
    !opts?.force &&
    shouldDiscardEmptyFileOnClose(tab) &&
    (await discardEmptyFileOnClose(tab))
  ) {
    // An empty editable file was auto-discarded; fall through to remove its
    // tab. Skipping confirmCloseTabs is deliberate: it autosaves dirty tabs,
    // which would write the empty buffer to disk before the close. The sync
    // predicate short-circuits non-files so their close timing is unchanged.
  } else if (!(await confirmCloseTabs([tab], opts))) {
    return;
  }
  if (tab.kind === "terminal") {
    if (!(await runTerminalCloseSink(tab))) return;
  }
  // Record the close's move-out intent for the empty-window discard guard. Set
  // unconditionally (false for a real close) so a prior move-out can't leak into
  // a later genuine discard, and set right before the splice so the reactive
  // empty-window `$effect` reads it deterministically.
  lastTerminalCloseWasMoveOut = movingOut;
  rememberClosedTab(paneId, side, tab);
  // Close releases the doc session NOW (no remount linger): any dirty
  // buffer was flushed through the save funnel above, and the immediate
  // detach asks the server for a prompt flush of anything residual.
  if (tab.kind === "file") releaseDocSessionForTab(tabId, true);
  tabs.splice(idx, 1);
  if (paneActiveTabId(p, side) === tabId) {
    setPaneActiveTabId(p, tabs[Math.max(0, idx - 1)]?.id ?? null, side);
  }
  // Do NOT auto-collapse an empty Hybrid pane. Closing the last tab
  // should leave the pane in place rendering the empty landing so the
  // Hybrid structure survives a transient empty state. Use the explicit
  // `closePane` action to dismiss the pane.
}

/// Remove a terminal tab whose session was EXPLICITLY closed server-side
/// (the user / another window / `cs terminal close` deleted it -- the
/// `closed{reason:"explicit"}` frame in TerminalTab.svelte). Unlike
/// `closeTab`, this skips the confirm prompt and the WS close sink: the
/// session is already gone, so there is nothing to confirm or to tell the
/// server. Drops the dead tab from its pane with the same active-tab /
/// empty-pane bookkeeping as `closeTab` (no pane auto-collapse, not added to
/// the reopen-closed list -- the session can't be reattached). Under Option A
/// a terminal-only window is ephemeral, so once the dead tab is gone the
/// debounced session save deletes the window's blob if no durable content
/// remains. No-op if the tab is no longer in the layout.
export function removeExplicitlyClosedTerminalTab(tabId: string): void {
  for (const node of Object.values(layout.nodes)) {
    if (node.kind !== "leaf") continue;
    const found = findTabInPane(node, tabId);
    if (!found) continue;
    found.tabs.splice(found.index, 1);
    if (paneActiveTabId(node, found.side) === tabId) {
      setPaneActiveTabId(
        node,
        found.tabs[Math.max(0, found.index - 1)]?.id ?? null,
        found.side,
      );
    }
    return;
  }
}

/// Server-side seed for a brand-new draft (see
/// `crates/chan-server/src/routes/drafts.rs::NEW_DRAFT_CONTENT`).
/// A draft whose buffer matches this string and is clean against disk
/// has not been edited since creation. Treat it as empty so the close
/// path skips the "Close Draft" modal for pristine drafts.
const NEW_DRAFT_SEED = "# Draft\n";

/// Server-side seed for a brand-new diagram (see
/// `crates/chan-server/src/routes/drafts.rs::NEW_DIAGRAM_CONTENT`). A
/// diagram whose buffer still matches this and is clean has not been
/// drawn on; discard it on close like a pristine markdown draft. Fires
/// only when the canvas leaves the buffer byte-identical to the seed on
/// mount; if it re-serializes to an equivalent-but-different form the
/// check simply does not match and the normal close path runs.
const NEW_DIAGRAM_SEED =
  '{"type":"excalidraw","version":2,"source":"chan","elements":[],"appState":{},"files":{}}';

async function handleDraftTabClose(tab: FileTab): Promise<boolean> {
  // A draft whose backing file vanished (the user moved or deleted it
  // on disk) has nothing to inspect, save, or discard. Close it like
  // any missing-file tab instead of 404-ing on inspectDraft and
  // trapping the tab open (no Cmd+W / Ctrl+D / X would dismiss it).
  if (tab.fileMissing) return true;
  try {
    const contentIsEmpty = tab.content.trim().length === 0;
    const isPristineSeed =
      !isDirty(tab) &&
      (tab.content === NEW_DRAFT_SEED || tab.content === NEW_DIAGRAM_SEED);
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
      target: draftDefaultTarget(info, tab.path),
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

/// Whether closing `tab` should auto-discard it as an empty editable file: it
/// is empty now AND either dirty (the user emptied it) or it opened empty, so
/// the close never autosaves an empty buffer to disk. A file that is mid-load,
/// failed to load, or is missing is excluded (it may be non-empty on disk and
/// merely shown blank). Synchronous so a terminal / non-empty file short-
/// circuits in the close branch BEFORE any await, preserving the same-tick
/// confirm-dialog timing the close path relies on.
function shouldDiscardEmptyFileOnClose(tab: Tab): tab is FileTab {
  return (
    tab.kind === "file" &&
    !tab.loading &&
    !tab.error &&
    !tab.fileMissing &&
    tab.content.trim().length === 0 &&
    (isDirty(tab) || tab.openedEmpty === true)
  );
}

/// Delete an empty editable file on close -- the generalization of the draft
/// empty-discard above -- silently (no confirm prompt, a brief toast). Deletes
/// via `api.remove` directly, not fileOps.remove (which prompts and recursively
/// closes path-matching tabs). Returns true when it discarded -- the caller
/// then skips confirmCloseTabs and removes the tab -- or false when the delete
/// failed, so the close falls back to a normal path and the tab is not trapped.
async function discardEmptyFileOnClose(tab: FileTab): Promise<boolean> {
  // Detach the doc session BEFORE the remove: a live session's detach
  // flush racing the delete could resurrect the file (the server's
  // reconciler stops the flush clock on Removed, but only if the detach
  // has landed by then).
  releaseDocSessionForTab(tab.id, true);
  try {
    await api.remove(tab.path);
  } catch {
    return false;
  }
  clearCaretsUnder(tab.path);
  const name = tab.path.split("/").pop() ?? tab.path;
  notify(`Discarded empty file ${name}`);
  return true;
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
          defaultValue: draftDefaultTarget(info, tab.path),
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
  const entries = Object.values(layout.nodes).flatMap((node) => {
    if (node.kind !== "leaf") return [];
    return [
      ...paneTabs(node, "a").map((tab) => ({
        paneId: node.id,
        side: "a" as const,
        tab,
      })),
      ...paneTabs(node, "b").map((tab) => ({
        paneId: node.id,
        side: "b" as const,
        tab,
      })),
    ];
  });
  if (!(await confirmCloseTabs(entries.map((entry) => entry.tab), opts))) return;
  for (const entry of entries) rememberClosedTab(entry.paneId, entry.side, entry.tab);
  for (const node of Object.values(layout.nodes)) {
    if (node.kind !== "leaf") continue;
    node.tabs.length = 0;
    node.activeTabId = null;
    if (node.bTabs) node.bTabs.length = 0;
    node.bActiveTabId = null;
    node.side = "a";
  }
}

export async function closeOtherTabsInPane(
  paneId: string,
  keepTabId: string,
  opts?: CloseTabsOptions,
): Promise<void> {
  const p = pane(paneId);
  const side = paneSide(p);
  const tabs = mutablePaneTabs(p, side);
  const closing = tabs.filter((t) => t.id !== keepTabId);
  if (closing.length === 0) return;
  if (!(await confirmCloseTabs(closing, opts))) return;
  const closeIds = new Set<string>();
  for (const tab of closing) {
    if (tab.kind === "terminal" && !(await runTerminalCloseSink(tab))) continue;
    rememberClosedTab(paneId, side, tab);
    closeIds.add(tab.id);
  }
  const next = tabs.filter((t) => t.id === keepTabId || !closeIds.has(t.id));
  if (side === "b") p.bTabs = next;
  else p.tabs = next;
  setPaneActiveTabId(p, next.find((t) => t.id === keepTabId)?.id ?? next[0]?.id ?? null, side);
}

export async function closeTabsInPane(
  paneId: string,
  opts?: CloseTabsOptions,
): Promise<boolean> {
  const p = pane(paneId);
  const side = paneSide(p);
  const tabs = mutablePaneTabs(p, side);
  const closing = [...tabs];
  if (!(await confirmCloseTabs(closing, opts))) return false;
  if (!(await runTerminalCloseSinks(closing))) return false;
  for (const tab of closing) {
    rememberClosedTab(paneId, side, tab);
  }
  if (side === "b") p.bTabs = [];
  else p.tabs = [];
  setPaneActiveTabId(p, null, side);
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
  const closing = [
    ...paneTabs(p, "a").map((tab) => ({ side: "a" as const, tab })),
    ...paneTabs(p, "b").map((tab) => ({ side: "b" as const, tab })),
  ];
  if (!(await confirmCloseTabs(closing.map((entry) => entry.tab), opts))) return false;
  if (!(await runTerminalCloseSinks(closing.map((entry) => entry.tab)))) return false;
  for (const entry of closing) rememberClosedTab(paneId, entry.side, entry.tab);
  p.tabs.length = 0;
  p.activeTabId = null;
  if (p.bTabs) p.bTabs.length = 0;
  p.bActiveTabId = null;
  p.side = "a";
  if (paneId !== layout.rootId) {
    collapseEmptyPane(paneId);
  }
  return true;
}

/// Reorder a tab within its pane. `toIndex` is the destination index
/// in the post-removal array (so e.g. moving tab 0 to index 2 in a
/// list of 4 tabs lands the tab as the new index 2).
export function reorderTab(
  paneId: string,
  tabId: string,
  toIndex: number,
  side: PaneSide = paneSide(pane(paneId)),
): void {
  const p = pane(paneId);
  const tabs = mutablePaneTabs(p, side);
  const from = tabs.findIndex((t) => t.id === tabId);
  if (from < 0) return;
  const clamped = Math.max(0, Math.min(toIndex, tabs.length - 1));
  if (from === clamped) return;
  // Snapshot the tab before splicing so the proxied entry doesn't get
  // re-wrapped in a way that confuses callers (see moveTab below).
  const src = tabs[from]!;
  const moved = cloneTab(src);
  tabs.splice(from, 1);
  tabs.splice(clamped, 0, moved);
  setPaneActiveTabId(p, moved.id, side);
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
      terminalEnvTabName: src.terminalEnvTabName,
      terminalEnvTabGroup: src.terminalEnvTabGroup,
      terminalEnvNamePromptDismissed: src.terminalEnvNamePromptDismissed,
      terminalEnvPromptDismissedFor: src.terminalEnvPromptDismissedFor,
      terminalMetadataDraft: src.terminalMetadataDraft
        ? { ...src.terminalMetadataDraft }
        : undefined,
      terminalMetadataPending: src.terminalMetadataPending
        ? { ...src.terminalMetadataPending }
        : undefined,
      terminalMetadataError: src.terminalMetadataError,
      terminalSessionId: src.terminalSessionId,
      controlledTerminal: src.controlledTerminal,
      lastAgentEchoSeq: src.lastAgentEchoSeq,
      cwd: src.cwd,
      seedInput: src.seedInput,
      pendingGlobalName: src.pendingGlobalName,
      group: src.group,
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
      // Carry the per-tab File Browser view state across a clone, the
      // same way the graph branch above carries its own. Without this a
      // split / move / reopen-closed (Cmd+Shift+T) drops the user's
      // expanded directories, selection, scroll, and workspace toggle --
      // the reopened tab snaps back to a collapsed root. Arrays are
      // copied (not aliased) so the clone and source don't share a
      // mutable reference.
      selected: src.selected,
      selectedPaths: src.selectedPaths ? [...src.selectedPaths] : undefined,
      showWorkspace: src.showWorkspace,
      expanded: src.expanded ? [...src.expanded] : undefined,
      scroll: src.scroll,
      inspectorWidth: src.inspectorWidth,
    };
  }
  if (src.kind === "dashboard") {
    return {
      kind: "dashboard",
      id: src.id,
      title: src.title,
      // Preserve the per-tab carousel cursor + slot on/off set across a
      // clone (split / move). Only emit them when set so a default
      // Dashboard tab clones to the same minimal shape as before.
      ...(typeof src.carouselSlide === "number"
        ? { carouselSlide: src.carouselSlide }
        : {}),
      ...(src.disabledSlots && src.disabledSlots.length > 0
        ? { disabledSlots: [...src.disabledSlots] }
        : {}),
      ...(src.autoRotate === false ? { autoRotate: false } : {}),
    };
  }
  if (src.kind === "extension") {
    return {
      kind: "extension",
      id: src.id,
      title: src.title,
      extensionId: src.extensionId,
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
    authorityVersion: src.authorityVersion ?? null,
    diskConflicted: src.diskConflicted ?? false,
    mode: src.mode,
    loading: src.loading,
    error: src.error,
    fileMissing: src.fileMissing ? { ...src.fileMissing } : null,
    inspectorOpen: src.inspectorOpen,
    outlineOpen: src.outlineOpen,
    ...(src.slidePreview
      ? { slidePreview: { ...src.slidePreview } }
      : {}),
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
    ...(src.bTabs ? { bTabs: src.bTabs.map((tab) => cloneTab(tab)) } : {}),
    ...(src.bActiveTabId !== undefined ? { bActiveTabId: src.bActiveTabId } : {}),
    ...(src.side ? { side: src.side } : {}),
    ...(src.theme ? { theme: src.theme } : {}),
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
  paneMode.stale = false;
  paneMode.entryLayout = serializeLayout({ terminalSessions: true });
  paneMode.pendingRemoteLayout = null;
  paneMode.mouseSplit = null;
  paneMode.stagedDraftEditors = [];
  notifyPaneModeSettled();
}

/// Mouse-driven Nav entry. `grabPaneId` is the pane the user started
/// dragging from (drag-with-payload), or null when entered via
/// double-click on the dead zone (standby until the user clicks and
/// drags inside any pane). Idempotent if already in transaction mode.
export function enterPaneModeTransaction(grabPaneId: string | null): void {
  if (paneMode.stale) return;
  if (!paneMode.active) {
    paneMode.draft = cloneLayoutState(layout);
    paneMode.active = true;
    paneMode.spawnIntent = null;
    paneMode.stale = false;
    paneMode.entryLayout = serializeLayout({ terminalSessions: true });
    paneMode.pendingRemoteLayout = null;
    paneMode.stagedDraftEditors = [];
  }
  paneMode.transactionMode = true;
  paneMode.grabPaneId = grabPaneId;
  paneMode.mouseSplit = null;
}

/// Set the current grab pane while in transaction mode. Used when the
/// user clicks and drags inside any pane after entering via double-click,
/// or re-grabs a different pane mid-transaction. A new or cleared grab
/// has no prior drop target: hover and any armed edge preview clear
/// atomically with it. No-op outside transaction mode.
export function paneModeSetGrab(paneId: string | null): void {
  if (!paneMode.transactionMode || paneMode.stale) return;
  paneMode.grabPaneId = paneId;
  paneMode.hoverPaneId = null;
  paneMode.mouseSplit = null;
}

/// Track the pane currently under the cursor while a grab is held.
/// Drives the drop-target highlight. No-op outside transaction mode.
export function paneModeSetHover(paneId: string | null): void {
  if (!paneMode.transactionMode || paneMode.stale) return;
  paneMode.hoverPaneId = paneId;
}

/// Arm or clear the edge-split preview while a grab hovers a target
/// pane. Preview state only: the draft tree stays untouched until
/// mouseup applies the move through `paneModeMoveGrabToEdge`. No-op
/// outside transaction mode.
export function paneModeSetMouseSplit(
  target: { paneId: string; edge: PaneMouseSplitEdge } | null,
): void {
  if (!paneMode.transactionMode || paneMode.stale) return;
  paneMode.mouseSplit = target;
}

export function commitPaneMode(): void {
  if (!paneMode.active || !paneMode.draft || paneMode.stale) return;
  // Apply any staged spawn intent into the draft before sealing so the
  // new tab lands as part of the same transaction. Callers that prime
  // side effects for a staged spawn (e.g. `revealAndSelect` for a
  // browser intent) should peek `paneMode.spawnIntent` before calling.
  if (paneMode.spawnIntent) {
    const { kind, ctx } = paneMode.spawnIntent;
    if (kind === "terminal") paneModeOpenTerminal(ctx);
    else if (kind === "browser") paneModeOpenBrowser(ctx);
    else if (kind === "graph") paneModeOpenGraph(ctx);
    else if (kind === "dashboard") paneModeOpenDashboard();
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
  paneMode.stale = false;
  paneMode.entryLayout = null;
  paneMode.pendingRemoteLayout = null;
  paneMode.mouseSplit = null;
  paneMode.stagedDraftEditors = [];
  notifyPaneModeSettled();
}

export function cancelPaneMode(): void {
  killStagedTerminalSessions();
  const pendingRemoteLayout = paneMode.pendingRemoteLayout;
  paneMode.active = false;
  paneMode.draft = null;
  paneMode.spawnIntent = null;
  paneMode.transactionMode = false;
  paneMode.grabPaneId = null;
  paneMode.hoverPaneId = null;
  paneMode.stale = false;
  paneMode.entryLayout = null;
  paneMode.pendingRemoteLayout = null;
  paneMode.mouseSplit = null;
  paneMode.stagedDraftEditors = [];
  notifyPaneModeSettled(pendingRemoteLayout);
}

/// Kill the PTYs of terminals that exist ONLY in the draft. Staged
/// panes RENDER, so a staged terminal's component mounts for real and
/// spawns a shell (in terminal-only windows every staged split gets
/// one automatically); just dropping the draft on Esc orphaned that
/// shell in the registry until idle-prune. Run each staged terminal's
/// registered close sink -- the same explicit-close path `closeTab`
/// uses (kills the session, discards the Rich Prompt draft) -- BEFORE
/// the draft stops rendering, while the components and their sinks are
/// still mounted. Committed tabs share ids with the live layout and
/// are never staged, so moves/clones are naturally excluded.
function killStagedTerminalSessions(): void {
  const draft = paneMode.draft;
  if (!paneMode.active || !draft) return;
  const staged = paneModeStagedTabIds();
  if (staged.size === 0) return;
  for (const node of Object.values(draft.nodes)) {
    if (node.kind !== "leaf") continue;
    for (const t of allPaneTabs(node)) {
      if (t.kind === "terminal" && staged.has(t.id)) {
        void runTerminalCloseSink(t);
      }
    }
  }
}

/// Stage a tab spawn for commit. Replaces any previously-staged intent;
/// pressing `1` then `2` results in the second intent alone. No-op
/// outside Pane Mode.
export function paneModeStageSpawn(
  kind: PaneModeSpawnKind,
  ctx: SpawnContext,
): void {
  if (!paneMode.active || paneMode.stale) return;
  paneMode.spawnIntent = { kind, ctx };
}

export function clearPaneModeSpawnIntent(): void {
  if (paneMode.stale) return;
  paneMode.spawnIntent = null;
}

type Direction = "left" | "right" | "up" | "down";

function draftLayout(): LayoutState | null {
  return paneMode.active && !paneMode.stale ? paneMode.draft : null;
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
  swapPaneContentsIn(draft, grabId, dropId);
}

/// Transaction-mode mouse drop on a target pane's edge zone: split the
/// target leaf in the draft and move the grabbed pane's whole content
/// into the new sibling. The emptied source leaf stays behind
/// uncollapsed; an empty Hybrid pane is a valid resting state and only
/// explicit close paths remove one. Focus follows the moved content so
/// chained drops read naturally.
export function paneModeMoveGrabToEdge(
  grabId: string,
  targetId: string,
  edge: PaneMouseSplitEdge,
): void {
  const draft = draftLayout();
  if (!draft) return;
  if (grabId === targetId) return;
  const grab = draft.nodes[grabId];
  const target = draft.nodes[targetId];
  if (!grab || grab.kind !== "leaf" || !target || target.kind !== "leaf") return;
  const newPane: LeafNode = {
    kind: "leaf",
    id: id("pane"),
    tabs: [],
    activeTabId: null,
  };
  movePaneContents(grab, newPane);
  const { direction, placement } = edgeSplitSpec(edge);
  insertSiblingPaneIn(draft, target.id, newPane, direction, placement);
  draft.activePaneId = newPane.id;
  // Grab, target, and the new sibling all changed size or content, so
  // all three wobble: the eye tracks where the content landed and what
  // gave up room for it.
  requestPaneWobble(grab.id);
  requestPaneWobble(target.id);
  requestPaneWobble(newPane.id);
}

/// Move every content field between two leaves, leaving the source
/// empty. The swap counterpart exchanges both directions; this one
/// clears the source for an edge-split move.
function movePaneContents(source: LeafNode, dest: LeafNode): void {
  dest.tabs = source.tabs;
  dest.activeTabId = source.activeTabId;
  dest.bTabs = source.bTabs;
  dest.bActiveTabId = source.bActiveTabId;
  dest.side = source.side;
  dest.theme = source.theme;
  source.tabs = [];
  source.activeTabId = null;
  source.bTabs = undefined;
  source.bActiveTabId = undefined;
  source.side = undefined;
  source.theme = undefined;
}

function swapPaneContentsIn(
  state: LayoutState,
  sourcePaneId: string,
  otherPaneId: string,
): boolean {
  if (sourcePaneId === otherPaneId) return false;
  const a = state.nodes[sourcePaneId];
  const b = state.nodes[otherPaneId];
  if (!a || a.kind !== "leaf" || !b || b.kind !== "leaf") return false;
  const aTabs = a.tabs;
  const aActive = a.activeTabId;
  const aBTabs = a.bTabs;
  const aBActive = a.bActiveTabId;
  const aSide = a.side;
  const aTheme = a.theme;
  a.tabs = b.tabs;
  a.activeTabId = b.activeTabId;
  a.bTabs = b.bTabs;
  a.bActiveTabId = b.bActiveTabId;
  a.side = b.side;
  a.theme = b.theme;
  b.tabs = aTabs;
  b.activeTabId = aActive;
  b.bTabs = aBTabs;
  b.bActiveTabId = aBActive;
  b.side = aSide;
  b.theme = aTheme;
  state.activePaneId = b.id;
  // Both panes had their content swapped, so both should
  // wobble so the user's eye tracks where their content
  // landed and which slot now holds whatever was displaced.
  requestPaneWobble(a.id);
  requestPaneWobble(b.id);
  return true;
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
  equalizePaneIn(draft, draft.activePaneId);
}

function equalizePaneIn(state: LayoutState, paneId: string): boolean {
  const node = state.nodes[paneId];
  if (!node || node.kind !== "leaf") return false;
  const split = parentOf(state, paneId);
  if (split) split.ratio = 0.5;
  return true;
}

/// Insert `newPane` next to `originalId` inside a layout state. Same
/// shape as the live-layout `insertSiblingPane` helper, but operates
/// on any LayoutState so it works for the Hybrid Nav draft.
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

/// Hybrid Nav `/` and `?` keybinds. Splits the focused pane in the
/// draft tree only; Enter seals the split and any tabs spawned during
/// the mode, Esc rolls everything back. Structural actions are
/// constrained to right + down.
/// Standalone terminal windows carry `?kind=terminal`. Read here directly
/// (rather than importing the store's `ui.terminalOnly`) to avoid a
/// tabs <-> store import cycle.
function isTerminalWindow(): boolean {
  try {
    return new URLSearchParams(location.search).get("kind") === "terminal";
  } catch {
    return false;
  }
}

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
  // Terminal-only windows never have an empty pane: a freshly-split pane gets
  // its own terminal so the new split is immediately usable.
  if (isTerminalWindow()) paneModeOpenTerminal();
}

/// Context for a Hybrid Nav spawn key. The in-mode spawn handlers
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

/// Hybrid Nav `t`. Spawn a new terminal tab inside the draft's focused
/// pane. The session WebSocket opens only when the tab mounts, so an
/// Esc rollback leaves no backend state behind.
export function paneModeOpenTerminal(ctx?: SpawnContext): void {
  const draft = draftLayout();
  if (!draft) return;
  const p = draft.nodes[draft.activePaneId];
  if (!p || p.kind !== "leaf") return;
  const side = paneSide(p);
  const tabs = mutablePaneTabs(p, side);
  const cwd = ctx?.dir?.trim();
  const tab: TerminalTab = {
    kind: "terminal",
    id: id("term"),
    title: nextTerminalTitle(draft),
    createdAt: Date.now(),
    broadcastEnabled: false,
    broadcastTargetIds: [],
    terminalSessionId: undefined,
    controlledTerminal: undefined,
    cwd: cwd || undefined,
    seedInput: undefined,
  };
  tabs.push(tab);
  setPaneActiveTabId(p, tab.id, side);
  p.side = side;
  // Number from the per-tenant counter (see applyGlobalTerminalName). A
  // pane-mode spawn never carries an explicit title, so every split-spawn is
  // server-numbered; the name resolves in `connect()` before the WS opens.
  tab.pendingGlobalName = true;
}

/// Hybrid Nav `o`. Spawn a fresh File Browser tab inside the draft's
/// focused pane. Every press is a new tab so the user can pile up
/// multiple browser views. When `ctx` carries a file or dir, the
/// inspector opens so the auto-selected node lands with its info pane
/// already visible.
export function paneModeOpenBrowser(ctx?: SpawnContext): void {
  const draft = draftLayout();
  if (!draft) return;
  const p = draft.nodes[draft.activePaneId];
  if (!p || p.kind !== "leaf") return;
  const side = paneSide(p);
  const tabs = mutablePaneTabs(p, side);
  const hasCtx = !!(ctx?.file || ctx?.dir);
  const tab: BrowserTab = {
    kind: "browser",
    id: id("browser"),
    title: "Files",
    inspectorOpen: hasCtx ? true : defaultBrowserInspectorOpen(),
  };
  tabs.push(tab);
  setPaneActiveTabId(p, tab.id, side);
  p.side = side;
}

/// Hybrid Nav `g` / `m`. Spawn a fresh Graph tab inside the draft's focused
/// pane. Same no-dedup semantic as `paneModeOpenBrowser`. When `ctx`
/// carries a file or dir, scope the new tab to that node and pre-select
/// it; GraphPanel pops the inspector on `pendingSelectId`.
export function paneModeOpenGraph(ctx?: SpawnContext): void {
  const draft = draftLayout();
  if (!draft) return;
  const p = draft.nodes[draft.activePaneId];
  if (!p || p.kind !== "leaf") return;
  const side = paneSide(p);
  const tabs = mutablePaneTabs(p, side);
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
  tabs.push(tab);
  setPaneActiveTabId(p, tab.id, side);
  p.side = side;
}

export function paneModeOpenDashboard(opts?: OpenDashboardOptions): void {
  const draft = draftLayout();
  if (!draft) return;
  const p = draft.nodes[draft.activePaneId];
  if (!p || p.kind !== "leaf") return;
  const side = paneSide(p);
  const tabs = mutablePaneTabs(p, side);
  const tab: DashboardTab = {
    kind: "dashboard",
    id: id("dashboard"),
    title: "Dashboard",
  };
  if (opts?.slide !== undefined) tab.carouselSlide = opts.slide;
  if (opts?.autoRotate !== undefined) tab.autoRotate = opts.autoRotate;
  tabs.push(tab);
  setPaneActiveTabId(p, tab.id, side);
  p.side = side;
}

/// Carousel slide index of the Search / Indexing graph. Matches the
/// `slideIndex === 1` indexing-poll gate in EmptyPaneCarousel and the
/// `SLOTS` order in DashboardTab.svelte (0 Workspace, 1 Search, 2 About).
export const DASHBOARD_SEARCH_SLIDE = 1;

/// Optional overrides applied to a freshly-spawned Dashboard tab: pre-select
/// a carousel slide and/or start with auto-rotation off. Shared by the
/// `cs dashboard` server command and the indexing-pill shortcut.
export interface OpenDashboardOptions {
  slide?: number;
  autoRotate?: boolean;
  side?: PaneSide;
}

/// Spawn a Dashboard tab inside the named pane (live layout). Mirrors
/// the shape of `openTerminalInPane` + `openBrowserInActivePane`:
/// append and flip active. No-op if the pane id doesn't resolve to a leaf.
export function openDashboardInPane(
  paneId: string,
  opts?: OpenDashboardOptions,
): void {
  const node = layout.nodes[paneId];
  if (!node || node.kind !== "leaf") return;
  const side = opts?.side ?? paneSide(node);
  const tabs = mutablePaneTabs(node, side);
  const tab: DashboardTab = {
    kind: "dashboard",
    id: id("dashboard"),
    title: "Dashboard",
  };
  if (opts?.slide !== undefined) tab.carouselSlide = opts.slide;
  if (opts?.autoRotate !== undefined) tab.autoRotate = opts.autoRotate;
  tabs.push(tab);
  setPaneActiveTabId(node, tab.id, side);
  node.side = side;
  layout.activePaneId = node.id;
}

export function openDashboardInActivePane(opts?: OpenDashboardOptions): void {
  openDashboardInPane(layout.activePaneId, opts);
}

/// Open a local extension inside the named pane. The caller passes only stable
/// public metadata; ExtensionTab.svelte resolves the tokened URL from the
/// in-memory catalog when it mounts.
export function openExtensionInPane(
  paneId: string,
  extensionId: string,
  title: string,
  side?: PaneSide,
): ExtensionTab | null {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(extensionId)) return null;
  const node = layout.nodes[paneId];
  if (!node || node.kind !== "leaf") return null;
  const targetSide = side ?? paneSide(node);
  const tab: ExtensionTab = {
    kind: "extension",
    id: id("extension"),
    title: title.trim() || extensionId,
    extensionId,
  };
  mutablePaneTabs(node, targetSide).push(tab);
  setPaneActiveTabId(node, tab.id, targetSide);
  node.side = targetSide;
  layout.activePaneId = node.id;
  return tab;
}

export function openExtensionInActivePane(
  extensionId: string,
  title: string,
): ExtensionTab | null {
  return openExtensionInPane(layout.activePaneId, extensionId, title);
}

/// Focus the existing singleton extension tab wherever it lives in this
/// window, or create it in the active pane. The extension catalog decides
/// singleton policy; persisted tabs remain credential-free either way.
export function openOrFocusExtension(
  extensionId: string,
  title: string,
  singleton: boolean,
): ExtensionTab | null {
  if (singleton) {
    for (const node of Object.values(layout.nodes)) {
      if (node.kind !== "leaf") continue;
      for (const side of ["a", "b"] as const) {
        const existing = paneTabs(node, side).find(
          (tab): tab is ExtensionTab =>
            tab.kind === "extension" && tab.extensionId === extensionId,
        );
        if (!existing) continue;
        setPaneActiveTabId(node, existing.id, side);
        node.side = side;
        layout.activePaneId = node.id;
        return existing;
      }
    }
  }
  return openExtensionInActivePane(extensionId, title);
}

/// Open a Dashboard tab focused on the Indexing (Search) slide with
/// auto-rotation paused. Target of clicking the indexing status pill: a user
/// watching the index build lands straight on the live graph, and it stays
/// there instead of rotating away.
export function openIndexingDashboard(): void {
  openDashboardInActivePane({
    slide: DASHBOARD_SEARCH_SLIDE,
    autoRotate: false,
  });
}

/// Stage a "new draft editor" intent onto the currently-focused pane.
/// Materialization is async (needs `api.createDraft()` to mint the
/// file), so the intent queues to commit-time. Multiple presses queue
/// multiple staged drafts, each targeting the pane focused at press
/// time. `paneModeMaterializeStagedDrafts()` is the commit-time
/// resolver.
export function paneModeStageDraftEditor(kind: PaneModeDraftEditorKind = "draft"): void {
  if (!paneMode.active || !paneMode.draft || paneMode.stale) return;
  const paneId = paneMode.draft.activePaneId;
  const node = leafPaneFrom(paneMode.draft, paneId);
  paneMode.stagedDraftEditors.push({
    id: id("staged-editor"),
    paneId,
    side: node ? paneSide(node) : "a",
    kind,
  });
}

export function paneModeStageDiagramEditor(): void {
  paneModeStageDraftEditor("diagram");
}

export function paneModeStagedDraftEditorsFor(
  paneId: string,
  side: PaneSide,
): PaneModeStagedDraftEditor[] {
  if (!paneMode.active) return [];
  return paneMode.stagedDraftEditors.filter(
    (intent) => intent.paneId === paneId && intent.side === side,
  );
}

export function paneModeRemoveStagedDraftEditor(id: string): void {
  if (!paneMode.active || paneMode.stale) return;
  const index = paneMode.stagedDraftEditors.findIndex((intent) => intent.id === id);
  if (index >= 0) paneMode.stagedDraftEditors.splice(index, 1);
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
      for (const t of allPaneTabs(node)) live.add(t.id);
    }
  }
  const staged = new Set<string>();
  for (const node of Object.values(paneMode.draft.nodes)) {
    if (node.kind === "leaf") {
      for (const t of allPaneTabs(node)) {
        if (!live.has(t.id)) staged.add(t.id);
      }
    }
  }
  return staged;
}

/// Move a tab from one pane to another. If `toIndex` is omitted the tab
/// is appended. Source pane collapses if it becomes empty.
export type MoveTabOptions = {
  fromSide?: PaneSide;
  toSide?: PaneSide;
};
export function moveTab(
  fromPaneId: string,
  tabId: string,
  toPaneId: string,
  toIndex?: number,
  opts: MoveTabOptions = {},
): void {
  const from = pane(fromPaneId);
  const to = pane(toPaneId);
  const found = findTabInPane(from, tabId, opts.fromSide);
  if (!found) return;
  const targetSide = opts.toSide ?? paneSide(to);
  if (fromPaneId === toPaneId && found.side === targetSide) {
    if (toIndex !== undefined) reorderTab(fromPaneId, tabId, toIndex, found.side);
    return;
  }
  const targetTabs = mutablePaneTabs(to, targetSide);
  // Pull a plain snapshot of the tab. The proxied element won't survive
  // splice + push cleanly across pane boundaries; copying its fields
  // sidesteps the question.
  const moved = cloneTab(found.tab);
  found.tabs.splice(found.index, 1);
  if (paneActiveTabId(from, found.side) === tabId) {
    setPaneActiveTabId(
      from,
      found.tabs[Math.max(0, found.index - 1)]?.id ?? null,
      found.side,
    );
  }
  if (toIndex === undefined || toIndex >= targetTabs.length) {
    targetTabs.push(moved);
  } else {
    targetTabs.splice(Math.max(0, toIndex), 0, moved);
  }
  setPaneActiveTabId(to, moved.id, targetSide);
  to.side = targetSide;
  layout.activePaneId = to.id;
  if (!paneHasAnyTabs(from) && layout.rootId !== from.id) {
    collapseEmptyPane(from.id);
  }
}

export function selectTabInPane(paneId: string, tabId: string): void {
  const current = activeLayout();
  const p = leafPaneFrom(current, paneId);
  if (!p) return;
  const found = findTabInPane(p, tabId);
  if (!found) return;
  p.side = found.side;
  setPaneActiveTabId(p, tabId, found.side);
  current.activePaneId = p.id;
  bumpTabFocusPulse();
}

export function moveActiveTabToSide(targetSide: PaneSide): boolean {
  const current = activeLayout();
  const p = activePane();
  const sourceSide = paneSide(p);
  if (sourceSide === targetSide) return false;
  const activeId = paneActiveTabId(p, sourceSide);
  if (!activeId) return false;
  const sourceTabs = mutablePaneTabs(p, sourceSide);
  const sourceIndex = sourceTabs.findIndex((tab) => tab.id === activeId);
  if (sourceIndex < 0) return false;
  const moved = cloneTab(sourceTabs[sourceIndex]!);
  sourceTabs.splice(sourceIndex, 1);
  setPaneActiveTabId(
    p,
    sourceTabs[Math.max(0, sourceIndex - 1)]?.id ?? null,
    sourceSide,
  );
  const targetTabs = mutablePaneTabs(p, targetSide);
  targetTabs.push(moved);
  setPaneActiveTabId(p, moved.id, targetSide);
  p.side = targetSide;
  current.activePaneId = p.id;
  bumpTabFocusPulse();
  return true;
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

  const found = findTabInPane(fromNode, tabId);
  if (!found) return;
  if (fromPaneId === targetPaneId && allPaneTabs(fromNode).length <= 1) return;

  const moved = cloneTab(found.tab);
  found.tabs.splice(found.index, 1);
  if (paneActiveTabId(fromNode, found.side) === tabId) {
    setPaneActiveTabId(
      fromNode,
      found.tabs[Math.max(0, found.index - 1)]?.id ?? null,
      found.side,
    );
  }
  if (!paneHasAnyTabs(fromNode) && fromNode.id !== targetNode.id && layout.rootId !== fromNode.id) {
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
  const paneId = splitPane(layout.activePaneId, direction, "after");
  // Terminal-only windows never have an empty pane: the new split pane (now
  // active) gets its own terminal.
  if (paneId && isTerminalWindow()) openTerminalInActivePane({});
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
): string | null {
  if (!canSplit()) return null;
  const original = layout.nodes[paneId];
  if (!original || original.kind !== "leaf") return null;
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
  return newPane.id;
}

function insertSiblingPane(
  originalId: string,
  newPane: LeafNode,
  direction: SplitNode["direction"],
  placement: "before" | "after",
): void {
  insertSiblingPaneIn(layout, originalId, newPane, direction, placement);
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
  current.activePaneId = paneId;
  if (previousActive !== paneId) requestPaneWobble(paneId);
}

export function focusPane(paneId: string, side?: PaneSide): boolean {
  const node = layout.nodes[paneId];
  if (!node || node.kind !== "leaf") return false;
  if (side) {
    node.side = side;
    const tabs = paneTabs(node, side);
    if (!paneActiveTabId(node, side) && tabs.length > 0) {
      setPaneActiveTabId(node, tabs[0]!.id, side);
    }
  }
  setActivePane(paneId);
  return true;
}

export function resizePane(paneId: string, delta: number): number | null {
  const node = layout.nodes[paneId];
  if (!node || node.kind !== "leaf") return null;
  const split = parentOf(layout, paneId);
  if (!split) return 0.5;
  const grow = split.a === paneId ? delta : -delta;
  split.ratio = Math.min(0.9, Math.max(0.1, split.ratio + grow));
  return split.ratio;
}

export function equalizePane(paneId: string): boolean {
  return equalizePaneIn(layout, paneId);
}

export function swapPanes(sourcePaneId: string, otherPaneId: string): boolean {
  return swapPaneContentsIn(layout, sourcePaneId, otherPaneId);
}

/// Flip the pane between its A and B tab sides.
export function flipHybrid(paneId: string): void {
  const node = activeLayout().nodes[paneId];
  if (!node || node.kind !== "leaf") return;
  const next = oppositePaneSide(paneSide(node));
  node.side = next;
  const tabs = paneTabs(node, next);
  if (!paneActiveTabId(node, next) && tabs.length > 0) {
    setPaneActiveTabId(node, tabs[0]!.id, next);
  }
}

export function setMode(tab: Tab, mode: Mode): void {
  if (tab.kind === "file") tab.mode = mode;
}

/// Flip the active pane's file tab between source and its rendered surface
/// (markdown → wysiwyg, JSON → pretty, CSV/TSV → table). Gated to files that
/// HAVE a rendered surface: plain text (.rs/.py/.toml/Makefile) has only source
/// mode, so the Mod+E chord is a NO-OP there instead of forcing an invalid
/// wysiwyg render. `defaultModeForPath` yields the rendered mode for renderable
/// files and "source" for source-only ones -- the same split FileEditorTab uses
/// for rendered/source mode controls (`hasRenderedMode` / `renderedModeForTab`).
/// Routed via the Mod+E chord and command launcher. Component-local mode buttons
/// call FileEditorTab's `doToggleMode`; both paths remap the caret across the
/// markdown source<->wysiwyg boundary (an image collapses to a single rendered
/// position, so the offset shifts) before flipping, so the caret lands on the
/// same logical spot. No-op when the active tab isn't a file tab.
export function toggleActiveFileTabMode(): void {
  const tab = activeFileTab();
  if (!tab) return;
  const rendered = defaultModeForPath(tab.path, tab.fileKind);
  if (rendered === "source") return;
  const next = tab.mode === "source" ? rendered : "source";
  // Caret remapping only applies to the markdown<->wysiwyg pair; pretty
  // (JSON) and table (CSV) reflow the text wholesale, so there is no
  // offset correspondence to preserve.
  if (tab.caret && rendered === "wysiwyg") {
    const mapped =
      next === "wysiwyg"
        ? renderedCaretForSourceCaret(tab.content, tab.caret)
        : sourceCaretForRenderedCaret(tab.content, tab.caret);
    setTabCaret(tab, mapped.from, mapped.to);
  }
  setMode(tab, next);
}

/// Tab-state mutators. These exist so child components (FileEditorTab
/// etc.) don't write tab.X = ... directly on a non-bindable prop - /// Svelte 5's ownership tracking warns about that pattern. Centralizing
/// the writes here also gives us one place to add side-effects
/// (persistence, telemetry) later.
export function setTabCaret(tab: FileTab, from: number, to: number): void {
  tab.caret = { from, to };
  // Persist the caret per file (debounced) so a later reopen lands here.
  // Skip while the file is still streaming: the editor parks at {0,0} during
  // load, and recording that would clobber the saved offset before the
  // post-load restore reads it back.
  if (!tab.loading) recordCaret(tab.path, from, to);
}
/// Imperatively command a mounted editor to (re)place its caret. A
/// kept-alive tab's editor snapshots `initialCaret` once and latches, so an
/// explicit reopen of an already-mounted tab can't move the caret through the
/// prop. Setting a fresh object here re-fires the FileEditorTab effect that
/// calls the editor's `resetCaret`, even when the position repeats. Sets
/// `caret` too so the position survives a later remount; the command itself is
/// transient and never serialized.
export function issueCaretCommand(tab: FileTab, from: number, to: number): void {
  tab.caret = { from, to };
  tab.caretCommand = { from, to };
}
/// Clear a consumed caret command so a later remount of the same kept-alive
/// tab does not replay it. The consuming FileEditorTab effect calls this once
/// it has driven the editor.
export function clearTabCaretCommand(tab: FileTab): void {
  tab.caretCommand = undefined;
}
/// Rich Prompt composer caret mirror. The bubble's editor pushes every
/// selection change here so the caret survives a bubble remount, a window
/// reload, and a cross-window restore (serialized as SerTab.rpc alongside
/// the draft path).
export function setRichPromptCaret(
  tab: TerminalTab,
  from: number,
  to: number,
): void {
  tab.richPromptCaret = { from, to };
}
/// Rich Prompt bubble height mirror, committed when a drag-resize ends.
export function setRichPromptHeight(tab: TerminalTab, height: number): void {
  tab.richPromptHeight = height;
}
export function setTabInspectorOpen(tab: FileTab, open: boolean): void {
  tab.inspectorOpen = open;
}
export function setTabOutlineOpen(tab: FileTab, open: boolean): void {
  tab.outlineOpen = open;
}
function clampSlidePreviewIndex(index: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.floor(index));
}
export function ensureTabSlidePreview(tab: FileTab): SlidePreviewTabState {
  return (tab.slidePreview ??= { open: false, index: 0, mode: "preview" });
}
export function setTabSlidePreviewOpen(tab: FileTab, open: boolean): void {
  ensureTabSlidePreview(tab).open = open;
}
export function setTabSlidePreviewIndex(tab: FileTab, index: number): void {
  ensureTabSlidePreview(tab).index = clampSlidePreviewIndex(index);
}
export function setTabSlidePreviewMode(
  tab: FileTab,
  mode: SlidePreviewMode,
): void {
  ensureTabSlidePreview(tab).mode = mode;
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

/// Conflict dialog state. Populated when a save returns 409 or 428
/// (an external edit landed, or a live authority requires explicit
/// preconditions). Mounted by
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
  currentAuthorityVersion: number | null;
  diskConflicted: boolean;
}>({
  open: false,
  tabId: null,
  path: "",
  currentMtime: null,
  currentMtimeNs: null,
  currentAuthorityVersion: null,
  diskConflicted: false,
});

export function dismissConflict(): void {
  conflictDialog.open = false;
  conflictDialog.tabId = null;
  conflictDialog.path = "";
  conflictDialog.currentMtime = null;
  conflictDialog.currentMtimeNs = null;
  conflictDialog.currentAuthorityVersion = null;
  conflictDialog.diskConflicted = false;
}

function findFileTabById(tabId: string): { paneId: string; tab: FileTab } | null {
  for (const [paneId, node] of Object.entries(layout.nodes)) {
    if (node.kind !== "leaf") continue;
    const found = findTabInPane(node, tabId);
    if (found?.tab.kind === "file") return { paneId, tab: found.tab };
  }
  return null;
}

function adoptConflictResolution(tab: FileTab, response: FileResponse): void {
  tab.content = response.content;
  tab.saved = response.content;
  tab.openedEmpty = response.content.trim().length === 0;
  tab.savedMtime = response.mtime ?? null;
  tab.savedMtimeNs = response.mtime_ns ?? null;
  tab.authorityVersion = response.authority_version ?? null;
  tab.diskConflicted = response.disk_conflicted ?? false;
  tab.repoRoot = response.repo_root ?? null;
  tab.fsWritable = response.writable ?? true;
  tab.error = null;
  tab.fileMissing = null;
  tab.externalChange = false;
  mirrorToSiblings(tab.path, response.content, tab.id);
  for (const hook of docFallbackSavedHooks) hook(tab.id);
}

/// Discard the in-memory buffer for the conflicted tab and re-fetch
/// from disk. The user picked Reload: their unsaved edits go away,
/// the disk version takes over.
export async function reloadConflictedTab(): Promise<void> {
  const tabId = conflictDialog.tabId;
  const diskConflicted = conflictDialog.diskConflicted;
  dismissConflict();
  if (!tabId) return;
  const found = findFileTabById(tabId);
  if (!found) return;
  if (diskConflicted) {
    const response = await api.resolveSessionConflict(found.tab.path, "reload");
    adoptConflictResolution(found.tab, response);
    return;
  }
  await loadTabContent(found.paneId, found.tab.id, found.tab.path);
}

/// Resolve a live-session conflict explicitly, or adopt the
/// server-reported on-disk mtime as the classic path's next CAS
/// token. Another external edit still re-prompts.
export async function overwriteConflictedTab(): Promise<void> {
  const tabId = conflictDialog.tabId;
  const currentMtime = conflictDialog.currentMtime;
  const currentMtimeNs = conflictDialog.currentMtimeNs;
  const currentAuthorityVersion = conflictDialog.currentAuthorityVersion;
  const diskConflicted = conflictDialog.diskConflicted;
  dismissConflict();
  if (!tabId) return;
  const found = findFileTabById(tabId);
  if (!found) return;
  if (diskConflicted) {
    const response = await api.resolveSessionConflict(found.tab.path, "overwrite");
    adoptConflictResolution(found.tab, response);
    return;
  }
  found.tab.savedMtime = currentMtime;
  found.tab.savedMtimeNs = currentMtimeNs;
  found.tab.authorityVersion = currentAuthorityVersion;
  found.tab.diskConflicted = diskConflicted;
  await performSave(found.tab);
}

// ---- live session integration (docSync / sceneSync .svelte.ts) ------------
// Each sync module registers these hooks at ITS module load; tabs never
// imports either (the import edge points sync module -> tabs), so the
// classic save path below runs unchanged when no module is present (unit
// tests that never import one, minimal bundles). The slots are arrays: a
// tab holds at most one live session KIND, so consumers iterate in
// registration order and the first non-classic answer wins.

/// Save-funnel delegate: "saved" consumed the save (every local edit is
/// confirmed and the authority flushed to disk); "degraded" and
/// "classic" fall through to the PUT path below.
export type DocSaveDelegate = (
  t: FileTab,
) => Promise<"saved" | "degraded" | "classic">;
const docSaveDelegates: DocSaveDelegate[] = [];
export function registerDocSaveDelegate(fn: DocSaveDelegate): void {
  docSaveDelegates.push(fn);
}

const docReleaseHooks: ((tabId: string, immediate: boolean) => void)[] = [];
export function registerDocReleaseHook(
  fn: (tabId: string, immediate: boolean) => void,
): void {
  docReleaseHooks.push(fn);
}

/// Query: is `tabId`'s live session degraded by a still-retrying CONNECTION
/// outage (dead server)? When true the classic autosave PUT is doomed and
/// its `tab.error` would unmount the editor, so the save path stays quiet
/// and leaves the buffer for the reattach diff-push.
const docSavePausedQueries: ((tabId: string) => boolean)[] = [];
export function registerDocSavePausedQuery(fn: (tabId: string) => boolean): void {
  docSavePausedQueries.push(fn);
}

/// Hook: a classic PUT for `tabId` just landed on disk. A session
/// degraded with its channel still up uses this to resync and take
/// ownership of saves back (single writer) instead of staying
/// degraded-classic forever; session modules ignore ids they do not
/// hold.
const docFallbackSavedHooks: ((tabId: string) => void)[] = [];
export function registerDocFallbackSavedHook(fn: (tabId: string) => void): void {
  docFallbackSavedHooks.push(fn);
}

/// Release a tab's live session, if any. Every registered hook runs (a
/// session module ignores tab ids it does not own). `immediate` skips the
/// remount linger: tab close, rename rekey, and file discard must detach
/// now (a detach also asks the server for a prompt flush).
export function releaseDocSessionForTab(tabId: string, immediate = false): void {
  for (const hook of docReleaseHooks) hook(tabId, immediate);
}

/// True while a live doc session owns this tab's saves: attached, or in
/// a window (first connect / reconnect grace) where a classic CAS PUT
/// could race the authority's own flush. Autosave, the sibling mirror,
/// and the external-change banner stay quiet in these states; `degraded`
/// and `off` read false so the classic path resumes.
export function isDocAttached(t: FileTab): boolean {
  const s = t.doc?.state;
  return s === "attached" || s === "connecting" || s === "reconnecting";
}

/// True when the classic autosave/PUT path must stay quiet: either the
/// authority owns saves (`isDocAttached`), or the session is degraded by
/// a still-retrying connection outage (dead server) where a PUT is doomed
/// and its `tab.error` would unmount the editor and lose the unconfirmed
/// buffer. Reads the mirrored `t.doc.state` (reactive) and, only for the
/// degraded case, the session query for the connection-outage nuance - a
/// degraded-but-reachable session (flush-timeout) and every permanent
/// stop read false, so the classic path (including error surfacing)
/// resumes exactly as before.
export function isDocSavePaused(t: FileTab): boolean {
  if (isDocAttached(t)) return true;
  if (t.doc?.state !== "degraded") return false;
  return docSavePausedQueries.some((q) => q(t.id));
}

/// Mirror mutator for docSync's status/peers writes. Called from socket
/// callbacks (never effects); deduped so keystroke-scale frame traffic
/// does not wake reactive consumers spuriously.
export function setTabDocState(t: FileTab, doc: DocTabState | null): void {
  if (doc === null) {
    if (t.doc !== undefined) t.doc = undefined;
    return;
  }
  if (t.doc && t.doc.state === doc.state && t.doc.peers === doc.peers) return;
  t.doc = doc;
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
  // A live session owns this tab's saves: confirmed edits are already
  // on the authority, so "save" means "flush to disk", never a PUT
  // (the ConflictModal is unreachable while attached). Delegates run in
  // registration order; "classic" means "not my session, ask the next
  // one". A flush failure degrades the owning session, stops its pump,
  // waits out any in-flight push, and falls through to the classic path
  // below with the freshest flush token stamped; a successful classic
  // save then heals the session back to attached via the fallback-saved
  // hook.
  if (isDocAttached(t)) {
    for (const delegate of docSaveDelegates) {
      const r = await delegate(t);
      if (r === "classic") continue;
      if (r === "saved") {
        t.error = null;
        return;
      }
      break;
    }
  }
  // Connection-outage suppression: the session is degraded by a still-
  // retrying dead-server drop, so a classic PUT would hit the same
  // unreachable server and its `tab.error` would swap the editor for the
  // error placeholder, unmounting the collab view and losing the buffer.
  // Stay quiet; the edits live in the buffer (and editorBuffer) for the
  // reattach diff-push. A reachable-but-degraded session (flush timeout)
  // reads false here and PUTs normally.
  if (isDocSavePaused(t)) return;
  // Excalidraw scenes are JSON too: gate them like .json so a
  // source-mode typo can't write a corrupt scene the canvas then
  // refuses to restore.
  if (isJson(t.path) || isExcalidraw(t.path)) {
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
  const authorityVersion = t.authorityVersion ?? null;
  try {
    const r = await api.write(
      path,
      content,
      expectedMtimeNs,
      expectedMtime,
      authorityVersion,
    );
    if (stripOnSave && content !== sourceContent && t.content === sourceContent) {
      t.content = content;
    }
    t.saved = content;
    t.savedMtime = r.mtime ?? null;
    t.savedMtimeNs = r.mtime_ns ?? null;
    t.authorityVersion = r.authority_version ?? null;
    t.diskConflicted = r.disk_conflicted ?? false;
    t.error = null;
    t.fileMissing = null;
    mirrorToSiblings(path, content, t.id);
    for (const hook of docFallbackSavedHooks) hook(t.id);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 409 || e.status === 428)) {
      const data = e.data as {
        current_mtime?: number | null;
        current_mtime_ns?: string | null;
        current_authority_version?: number | null;
        disk_conflicted?: boolean;
      } | null;
      conflictDialog.open = true;
      conflictDialog.tabId = t.id;
      conflictDialog.path = t.path;
      conflictDialog.currentMtime = data?.current_mtime ?? null;
      conflictDialog.currentMtimeNs = data?.current_mtime_ns ?? null;
      conflictDialog.currentAuthorityVersion =
        data?.current_authority_version ?? null;
      conflictDialog.diskConflicted = data?.disk_conflicted ?? false;
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
    const found = findTabInPane(node, tabId);
    const t = found?.tab.kind === "file" ? found.tab : undefined;
    if (!t) return;
    if (t.loading || t.content === t.saved) return;
    // Attached tabs save through the doc session, and a connection-outage
    // degraded tab suppresses the doomed PUT; the autosave effect already
    // skips both, this re-check covers a status flip in the debounce
    // window between schedule and fire.
    if (isDocSavePaused(t)) return;
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
    for (const sib of allPaneTabs(node)) {
      if (sib.kind !== "file") continue;
      if (sib.id === originId) continue;
      if (sib.path !== path) continue;
      // Honor an unsaved buffer in the sibling; don't clobber.
      if (sib.content !== sib.saved) continue;
      // Attached siblings get their sync as authority updates; a mirror
      // write here would fork them from their confirmed shadow.
      if (isDocAttached(sib)) continue;
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
    for (const t of allPaneTabs(node)) {
      if (t.kind === "file" && !t.loading && t.content !== t.saved) out.add(t.path);
    }
  }
  return out;
}

// ---- serialization for URL-based persistence -----------------------------

// Tree-shaped serialized form. We store the layout as a recursive
// shape without IDs; restore generates fresh IDs. Tabs carry just
// enough to reconstruct each variant.
//   k: compact tab-kind discriminator. Legacy "s" settings and "h" health
//      entries are dropped on restore; current kinds are reconstructed below.
//   p,m,o only meaningful for files
//   a: active tab in this pane (one per pane)
//   f: focused pane (one per layout)
export type SerTab = {
  k?: "f" | "b" | "s" | "g" | "h" | "t" | "d" | "x";
  p?: string;
  n?: string;
  m?: Mode;
  a?: 1;
  o?: 1;
  /// Outline pane (left-side) visibility. Default off, so we only
  /// emit `ol: 1` when the user has opted the outline in.
  ol?: 1;
  /// Slides preview open flag. Omitted when closed.
  spo?: 1;
  /// Slides preview slide index. Emitted when preview is open or
  /// the stored index is non-zero.
  sp?: number;
  /// Slides preview mode. Omitted for regular preview.
  spm?: "p";
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
  /// Terminal was created through the HTTP control channel; restart
  /// uses the server-side restart endpoint.
  tc?: 1;
  /// Last injected agent-event echo sequence the browser handled.
  /// Used only for replaying missed Team Work watcher dispatches.
  tae?: number;
  /// Terminal broadcast group. Emitted only when non-default so a
  /// reattach after reload keeps the terminal in its group (and the
  /// SPA group stays consistent with the server's per-session tab_group).
  tg?: string;
  /// Negotiated keyboard-protocol snapshot (modifyOtherKeys / kitty
  /// flags). Emitted only for a live session with non-default state so
  /// Shift+Enter -> newline survives a reload reattaching to a long-lived
  /// agent. See `TerminalTab.keyboardProtocol`.
  kp?: SerializedKeyboardProtocolState;
  /// Rich Prompt per-terminal draft path (<draftsDir>/<name>/draft.md). Persisted
  /// so a reload rebinds the per-terminal Rich Prompt draft + the close
  /// cleanup deletes the right draft folder. Per-window session payloads only.
  rpd?: string;
  /// Rich Prompt composer caret as `[from, to]`. Omitted at offset 0 (the
  /// fresh-composer default). Per-window session payloads only, like `rpd`
  /// (the caret indexes into the draft the same payload carries).
  rpc?: [number, number];
  /// Rich Prompt bubble drag-resized height in px. Omitted at the default
  /// auto height. Per-window session payloads only.
  rph?: number;
  /// Rich Prompt in-flight message (id + phase) so a queued message survives a
  /// window reload (GAP 2 / the reload contract): on reattach it is re-proved
  /// against the `session` frame's `queued_prompt_ids` (still queued → re-lock +
  /// re-show with position; drained → clear). Only the actionable in-flight
  /// phases ("sent"/"queued") are persisted. Per-window session payloads only.
  pp?: { id: string; ph: "sent" | "queued" };
  /// Rich Prompt bubble was visible -- reshow it on reload so a restored queued
  /// message is actionable without re-toggling Cmd+Shift+P. Session payloads only.
  rpv?: 1;
  /// Team Work spawn-agents dialog config draft for a pending LEAD terminal, so
  /// a reload reopens the dialog with exactly what the user was editing. Stored
  /// verbatim (the session blob isn't size-constrained like the URL hash).
  /// Per-window session payloads ONLY -- kept out of the shareable URL hash since
  /// a member's `env` can carry secrets. See `TerminalTab.teamWorkPending`.
  twk?: TeamDialogConfig;
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
  /// DashboardTab disabled slot indices. Omitted when empty (all slots
  /// enabled, the default).
  ds?: number[];
  /// DashboardTab auto-rotate flag. Omitted when true (the default);
  /// emitted as false when the tab opted out of auto-rotation.
  ar?: boolean;
  /// Stable extension id. The authenticated entry URL is intentionally never
  /// serialized; it is resolved from the process-local catalog after restore.
  xi?: string;
};
export type SerFocusColor = "o" | "g" | "p";
export type SerHybridTheme = "d" | "l";
export type SerLeaf = {
  k: "l";
  t: SerTab[];
  f?: 1;
  wc?: SerFocusColor;
  pc?: SerFocusColor;
  /// Per-pane Hybrid side state.
  /// `t`: side A tabs.
  /// `bt`: side B tabs.
  /// `ht`: per-Hybrid theme override.
  /// `sb`: `1` when side B is visible.
  /// `bm` / `hb`: legacy config-back hints, ignored on restore.
  ht?: SerHybridTheme;
  sb?: 1;
  bm?: 1;
  bt?: SerTab[];
  hb?: SerHybridTheme;
};
export type SerSplit = {
  k: "s";
  d: "r" | "c";
  a: SerNode;
  b: SerNode;
  r?: number;
  wc?: SerFocusColor;
};
export type SerNode = SerLeaf | SerSplit;

type PaneModeConflictFieldPartition = {
  readonly included: readonly string[];
  readonly excluded: readonly string[];
};

/// Closed declaration of the serialized fields that do and do not belong to
/// Hybrid Nav's conflict domain. The comparator validates runtime keys against
/// these partitions before reading the included fields, so an unclassified
/// future field fails closed instead of silently acquiring semantics.
export const paneModeConflictFieldSets = {
  node: {
    included: ["k", "d", "r", "a", "b", "t", "bt", "sb", "f"],
    excluded: ["wc", "pc", "ht", "bm", "hb"],
  },
  tabs: {
    f: {
      included: ["k", "a", "p"],
      excluded: ["m", "o", "ol", "spo", "sp", "spm", "s", "r", "c", "h", "iw", "ow"],
    },
    t: {
      included: ["k", "a", "n", "tg", "tsid"],
      excluded: ["tc", "tae", "kp", "rpd", "rpc", "rph", "pp", "rpv", "twk"],
    },
    s: { included: ["k", "a"], excluded: [] },
    h: { included: ["k", "a"], excluded: [] },
    g: {
      included: ["k", "a"],
      excluded: ["gm", "gs", "gd", "gi", "gf", "ge", "gp", "gn", "gnl", "iw"],
    },
    b: {
      included: ["k", "a"],
      excluded: ["bi", "bs", "bd", "be", "bsc", "iw"],
    },
    d: { included: ["k", "a"], excluded: ["cs", "ds", "ar"] },
    x: { included: ["k", "a", "xi"], excluded: ["n"] },
  },
} as const;

function paneModeFieldsAreClassified(
  value: object,
  partition: PaneModeConflictFieldPartition,
): boolean {
  const declared = new Set([...partition.included, ...partition.excluded]);
  return Object.keys(value).every((field) => declared.has(field));
}

function paneModeTabKind(tab: SerTab): NonNullable<SerTab["k"]> {
  return tab.k ?? "f";
}

function paneModeIncludedTabFieldEqual(
  field: string,
  kind: NonNullable<SerTab["k"]>,
  baseline: SerTab,
  incoming: SerTab,
): boolean {
  if (field === "k") return paneModeTabKind(baseline) === paneModeTabKind(incoming);
  if (field === "a") return (baseline.a === 1) === (incoming.a === 1);
  if (field === "p") return (baseline.p ?? "") === (incoming.p ?? "");
  if (field === "xi") {
    return (baseline.xi?.trim() ?? "") === (incoming.xi?.trim() ?? "");
  }
  if (field === "n" && kind === "t") {
    return (
      (baseline.n?.trim() || "Terminal") ===
      (incoming.n?.trim() || "Terminal")
    );
  }
  if (field === "tg" && kind === "t") {
    return (
      (baseline.tg?.trim() || DEFAULT_TERMINAL_GROUP) ===
      (incoming.tg?.trim() || DEFAULT_TERMINAL_GROUP)
    );
  }
  if (field === "tsid" && kind === "t") {
    // A just-attached terminal gains its settled id without becoming a new
    // inventory item. Once both sides have ids, identity changes are real.
    return !baseline.tsid || !incoming.tsid || baseline.tsid === incoming.tsid;
  }
  return false;
}

function paneModeTabsSemanticallyEqual(
  baseline: readonly SerTab[],
  incoming: readonly SerTab[],
): boolean {
  if (baseline.length !== incoming.length) return false;
  return baseline.every((left, index) => {
    const right = incoming[index]!;
    const kind = paneModeTabKind(left);
    if (kind !== paneModeTabKind(right)) return false;
    const partition = paneModeConflictFieldSets.tabs[kind];
    if (
      !paneModeFieldsAreClassified(left, partition) ||
      !paneModeFieldsAreClassified(right, partition)
    ) {
      return false;
    }
    return partition.included.every((field) =>
      paneModeIncludedTabFieldEqual(field, kind, left, right),
    );
  });
}

function paneModeNodesSemanticallyEqual(
  baseline: SerNode,
  incoming: SerNode,
): boolean {
  const partition = paneModeConflictFieldSets.node;
  if (
    !paneModeFieldsAreClassified(baseline, partition) ||
    !paneModeFieldsAreClassified(incoming, partition) ||
    baseline.k !== incoming.k
  ) {
    return false;
  }
  return partition.included.every((field) => {
    if (field === "k") return true;
    if (field === "d") {
      return baseline.k !== "s" || baseline.d === (incoming as SerSplit).d;
    }
    if (field === "r") {
      return (
        baseline.k !== "s" ||
        (baseline.r ?? 0.5) === ((incoming as SerSplit).r ?? 0.5)
      );
    }
    if (field === "a") {
      return (
        baseline.k !== "s" ||
        paneModeNodesSemanticallyEqual(baseline.a, (incoming as SerSplit).a)
      );
    }
    if (field === "b") {
      return (
        baseline.k !== "s" ||
        paneModeNodesSemanticallyEqual(baseline.b, (incoming as SerSplit).b)
      );
    }
    if (field === "t") {
      return (
        baseline.k !== "l" ||
        paneModeTabsSemanticallyEqual(baseline.t, (incoming as SerLeaf).t)
      );
    }
    if (field === "bt") {
      return (
        baseline.k !== "l" ||
        paneModeTabsSemanticallyEqual(
          baseline.bt ?? [],
          (incoming as SerLeaf).bt ?? [],
        )
      );
    }
    if (field === "sb") {
      return (
        baseline.k !== "l" ||
        (baseline.sb === 1) === ((incoming as SerLeaf).sb === 1)
      );
    }
    if (field === "f") {
      return (
        baseline.k !== "l" ||
        (baseline.f === 1) === ((incoming as SerLeaf).f === 1)
      );
    }
    return false;
  });
}

export function paneModeLayoutsSemanticallyEqual(
  baseline: SerNode | null,
  incoming: SerNode | null,
): boolean {
  if (!baseline || !incoming) return baseline === incoming;
  return paneModeNodesSemanticallyEqual(baseline, incoming);
}

function clonePaneModeRemoteLayout(layout: SerNode | null): SerNode | null {
  return layout ? (JSON.parse(JSON.stringify(layout)) as SerNode) : null;
}

/// Screen an authoritative remote layout against the fixed entry snapshot.
/// Once stale, every subsequent snapshot replaces the pending value, including
/// a snapshot that happens to resemble the original baseline.
export function paneModeDeferRemoteLayout(incoming: SerNode | null): boolean {
  if (!paneMode.active) return false;
  if (paneMode.stale) {
    paneMode.pendingRemoteLayout = clonePaneModeRemoteLayout(incoming);
    return true;
  }
  if (paneModeLayoutsSemanticallyEqual(paneMode.entryLayout, incoming)) {
    return false;
  }
  paneMode.stale = true;
  paneMode.pendingRemoteLayout = clonePaneModeRemoteLayout(incoming);
  return true;
}

/// Authoritative terminal metadata callers invoke this only after detecting
/// and applying a settled live-pair change. It never manufactures a pending
/// session snapshot.
export function paneModeMarkStaleForAuthoritativeMetadata(): void {
  if (!paneMode.active) return;
  paneMode.stale = true;
}

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

/// "Copy link to graph": the launcher serializes a graph tab to a
/// `chan://graph?...` URL that reproduces the view when opened from a
/// markdown file. A custom-scheme URL survives a paste into markdown
/// intact and is trivial to detect on a link click. Round-trips
/// scope / depth / mode / filters / selection via `parseGraphLink`.
export const GRAPH_LINK_PREFIX = "chan://graph?";

export function graphLinkFor(tab: GraphTab): string {
  const params = new URLSearchParams();
  params.set("s", tab.scopeId);
  if (tab.depth !== 1) params.set("d", String(tab.depth));
  params.set(
    "m",
    tab.mode === "filesystem" ? "f" : tab.mode === "language" ? "l" : "s",
  );
  params.set("f", encodeGraphTabFilters(tab.filters));
  if (tab.selectedNodeId) params.set("n", tab.selectedNodeId);
  return `${GRAPH_LINK_PREFIX}${params.toString()}`;
}

export type ParsedGraphLink = {
  mode: GraphTab["mode"];
  scopeId: string;
  depth: number;
  filters: GraphFilters;
  selectedNodeId: string | null;
};

/// Parse a `chan://graph?...` link back into the fields needed to open a
/// graph tab. Returns null when the string is not a graph link or has no
/// scope. Lenient on the rest: missing depth -> 1, missing mode ->
/// semantic, missing filters -> all-on (decodeGraphTabFilters default).
export function parseGraphLink(link: string): ParsedGraphLink | null {
  const trimmed = link.trim();
  if (!trimmed.startsWith(GRAPH_LINK_PREFIX)) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(trimmed.slice(GRAPH_LINK_PREFIX.length));
  } catch {
    return null;
  }
  const scopeId = params.get("s");
  if (!scopeId) return null;
  const depthRaw = params.get("d");
  const depth = depthRaw ? Number.parseInt(depthRaw, 10) : 1;
  const modeChar = params.get("m");
  return {
    mode:
      modeChar === "f"
        ? "filesystem"
        : modeChar === "l"
          ? "language"
          : "semantic",
    scopeId,
    depth: Number.isFinite(depth) && depth > 0 ? depth : 1,
    filters: decodeGraphTabFilters(params.get("f") ?? undefined),
    selectedNodeId: params.get("n"),
  };
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
      n: terminalTabName(t),
      ...(terminalTabGroup(t) !== DEFAULT_TERMINAL_GROUP
        ? { tg: terminalTabGroup(t) }
        : {}),
      ...(opts.terminalSessions && t.terminalSessionId
        ? {
            tsid: t.terminalSessionId,
            ...(t.controlledTerminal ? { tc: 1 as const } : {}),
            ...(typeof t.lastAgentEchoSeq === "number" &&
            Number.isFinite(t.lastAgentEchoSeq) &&
            t.lastAgentEchoSeq > 0
              ? { tae: Math.floor(t.lastAgentEchoSeq) }
              : {}),
            ...(() => {
              const kp = serializeKeyboardProtocolState(t.keyboardProtocol);
              return kp ? { kp } : {};
            })(),
          }
        : {}),
      ...(opts.terminalSessions && t.richPromptDraftPath
        ? { rpd: t.richPromptDraftPath }
        : {}),
      // Rich Prompt composer caret + drag-resized height. The caret is
      // skipped at offset 0 (the fresh-composer default) so terminal
      // payloads stay compact, mirroring the file-tab `c` field.
      ...(opts.terminalSessions &&
      t.richPromptCaret &&
      (t.richPromptCaret.from !== 0 || t.richPromptCaret.to !== 0)
        ? {
            rpc: [t.richPromptCaret.from, t.richPromptCaret.to] as [
              number,
              number,
            ],
          }
        : {}),
      ...(opts.terminalSessions && t.richPromptHeight && t.richPromptHeight > 0
        ? { rph: Math.round(t.richPromptHeight) }
        : {}),
      // Persist a QUEUED Rich Prompt message (id + phase) + bubble visibility
      // so it survives a reload (GAP 2). Only "queued" (acked + in the queue)
      // is persisted: "sent" is a sub-300ms pre-ack transient, and terminal
      // phases resolve before any save. On reattach it's re-proved against the
      // session frame's queued_prompt_ids (kept+positioned, or cleared).
      ...(opts.terminalSessions && t.pendingPrompt?.phase === "queued"
        ? { pp: { id: t.pendingPrompt.id, ph: "queued" as const } }
        : {}),
      ...(opts.terminalSessions && isRichPromptVisible(t.id) ? { rpv: 1 as const } : {}),
      // Pending Team Work dialog config: session payloads only (never the
      // shareable URL hash). Reopens the dialog with the user's in-progress
      // config on reload.
      ...(opts.terminalSessions && t.teamWorkPending ? { twk: t.teamWorkPending } : {}),
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
      // Persist the disabled slot set; omit when empty (all-on default).
      ...(t.disabledSlots && t.disabledSlots.length > 0
        ? { ds: t.disabledSlots }
        : {}),
      // Persist the auto-rotate opt-out; omit when on (the default).
      ...(t.autoRotate === false ? { ar: false } : {}),
      ...active,
    };
  }
  if (t.kind === "extension") {
    return {
      k: "x",
      xi: t.extensionId,
      n: t.title,
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
  const slidePreview = t.slidePreview;
  return {
    p: t.path,
    m: t.mode,
    ...active,
    ...(t.inspectorOpen ? { o: 1 as const } : {}),
    ...(t.outlineOpen ? { ol: 1 as const } : {}),
    ...(slidePreview?.open ? { spo: 1 as const } : {}),
    ...(slidePreview && (slidePreview.open || slidePreview.index > 0)
      ? { sp: clampSlidePreviewIndex(slidePreview.index) }
      : {}),
    ...(slidePreview?.open && slidePreview.mode === "play"
      ? { spm: "p" as const }
      : {}),
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
    const bTabs: SerTab[] = (n.bTabs ?? []).map((t) =>
      serializeTab(t, t.id === (n.bActiveTabId ?? null), opts),
    );
    const out: SerLeaf = {
      k: "l",
      t: tabs,
      ...(n.id === layout.activePaneId ? { f: 1 as const } : {}),
    };
    const ht = serializeHybridTheme(n.theme);
    if (ht) out.ht = ht;
    if (bTabs.length > 0) out.bt = bTabs;
    if (paneSide(n) === "b") out.sb = 1;
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
  if (
    serialized.k === "l" &&
    serialized.t.length === 0 &&
    (serialized.bt?.length ?? 0) === 0 &&
    !serialized.wc
  )
    return null;
  return serialized;
}

// ---- per-kind constructors for serialized tabs ---------------------------
//
// One place maps a SerTab onto a fresh live tab object, shared by
// `restoreLayout` (bootstrap restore) and `reconcileLayout` (live co-view
// creates). Caller-specific concerns stay with the callers: positional
// session grafts for terminals arrive via `savedTerm`, and the rpv
// bubble-reshow side effect, active markers, and content loads are the
// caller's job.

function restoreGraphTabFromSer(sertab: SerTab): GraphTab {
  const mode = restoreGraphMode(sertab.gm);
  const scopeId = sertab.gs || "workspace";
  // Prefer `gn` (persisted live selection) as the post-restore
  // seed so the user lands on the same focal node. The graph
  // load consumes `pendingSelectId` once; `selectedNodeId`
  // stays so the tab title remains selection-driven.
  const selectedNodeId = typeof sertab.gn === "string" ? sertab.gn : null;
  const selectedNodeLabel = typeof sertab.gnl === "string" ? sertab.gnl : null;
  return {
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
}

function restoreBrowserTabFromSer(sertab: SerTab): BrowserTab {
  return {
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
}

function restoreTerminalTabFromSer(
  sertab: SerTab,
  savedTerm?: SerTab,
): TerminalTab {
  const terminalSessionId = sertab.tsid ?? savedTerm?.tsid;
  const group = (sertab.tg ?? savedTerm?.tg)?.trim();
  // Restore the negotiated keyboard protocol for a reattaching
  // session so Shift+Enter -> newline survives a reload even when
  // the agent's original negotiation has scrolled out of replay.
  const kpSnapshot = terminalSessionId
    ? (sertab.kp ?? savedTerm?.kp)
    : undefined;
  // Restore an in-flight Rich Prompt message (GAP 2). It re-locks the
  // bubble on mount; the `session` frame's `queued_prompt_ids` then
  // re-proves it (still queued → keep + position; drained → clear) via
  // reproveRestoredPrompt.
  const pp = sertab.pp ?? savedTerm?.pp;
  // Restore a pending Team Work dialog config (#4 reload-survival). The
  // hash carries no `twk` (session-only), so a hash reload sources it
  // from the positional `savedTerm` graft, same as `tsid`. Presence
  // makes `findTeamWorkPendingLead` reopen the dialog post-restore.
  const twk = sertab.twk ?? savedTerm?.twk;
  // Rich Prompt composer caret + height (session-only, like `rpd`).
  const rpc = sertab.rpc ?? savedTerm?.rpc;
  const rph = sertab.rph ?? savedTerm?.rph;
  return {
    kind: "terminal",
    id: id("term"),
    title: sertab.n || "Terminal",
    createdAt: Date.now(),
    broadcastEnabled: false,
    broadcastTargetIds: [],
    terminalSessionId,
    controlledTerminal: sertab.tc === 1 || savedTerm?.tc === 1,
    group: group && group !== DEFAULT_TERMINAL_GROUP ? group : undefined,
    keyboardProtocol: kpSnapshot
      ? restoreKeyboardProtocolState(kpSnapshot)
      : undefined,
    lastAgentEchoSeq:
      terminalSessionId &&
      typeof (sertab.tae ?? savedTerm?.tae) === "number" &&
      Number.isFinite(sertab.tae ?? savedTerm?.tae)
        ? Math.max(0, Math.floor((sertab.tae ?? savedTerm?.tae)!))
        : undefined,
    richPromptDraftPath: (sertab.rpd ?? savedTerm?.rpd) || undefined,
    ...(Array.isArray(rpc) && rpc.length === 2
      ? { richPromptCaret: { from: rpc[0], to: rpc[1] } }
      : {}),
    ...(typeof rph === "number" && rph > 0
      ? { richPromptHeight: rph }
      : {}),
    ...(pp && (pp.ph === "sent" || pp.ph === "queued")
      ? { pendingPrompt: { id: pp.id, phase: pp.ph } }
      : {}),
    ...(twk ? { teamWorkPending: twk } : {}),
  };
}

function restoreDashboardTabFromSer(sertab: SerTab): DashboardTab {
  // Sanitize the disabled-slot set to in-range indices; ignore
  // it entirely if it would leave no slot enabled (malformed
  // hash) so the carousel can never restore blank.
  const rawDs = Array.isArray(sertab.ds)
    ? [...new Set(sertab.ds)]
        .filter(
          (n) =>
            Number.isInteger(n) && n >= 0 && n < DASHBOARD_SLOT_COUNT,
        )
        .sort((a, b) => a - b)
    : [];
  const disabledSlots =
    rawDs.length > 0 && rawDs.length < DASHBOARD_SLOT_COUNT
      ? rawDs
      : [];
  const tab: DashboardTab = {
    kind: "dashboard",
    id: id("dashboard"),
    title: "Dashboard",
    ...(disabledSlots.length > 0 ? { disabledSlots } : {}),
  };
  // Restore the carousel slide when the hash carries one, clamping
  // off a disabled slot to the first enabled one. Absence falls
  // back to the About slide (slot 0) unless that slot is disabled.
  if (typeof sertab.cs === "number" && sertab.cs > 0) {
    const want = Math.max(0, Math.floor(sertab.cs));
    tab.carouselSlide = dashboardSlotEnabled(tab, want)
      ? want
      : firstEnabledSlot(tab);
  } else if (!dashboardSlotEnabled(tab, 0)) {
    tab.carouselSlide = firstEnabledSlot(tab);
  }
  if (sertab.ar === false) tab.autoRotate = false;
  return tab;
}

function restoreExtensionTabFromSer(sertab: SerTab): ExtensionTab | null {
  const extensionId = sertab.xi?.trim() ?? "";
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(extensionId)) return null;
  return {
    kind: "extension",
    id: id("extension"),
    title: sertab.n?.trim() || extensionId,
    extensionId,
  };
}

function restoreFileTabFromSer(sertab: SerTab): FileTab {
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
  return {
    kind: "file",
    fileKind: restoredFileKind,
    id: id("tab"),
    path: restoredPath,
    content: "",
    saved: "",
    savedMtime: null,
    savedMtimeNs: null,
    authorityVersion: null,
    diskConflicted: false,
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
    slidePreview: {
      open: sertab.spo === 1,
      index: clampSlidePreviewIndex(
        typeof sertab.sp === "number" ? sertab.sp : 0,
      ),
      mode: sertab.spm === "p" ? "play" : "preview",
    },
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
      const p: LeafNode = {
        kind: "leaf",
        id: id("pane"),
        tabs: [],
        activeTabId: null,
      };
      const restoreTabsForSide = (
        side: PaneSide,
        serializedTabs: SerTab[],
        sessionTabs: SerTab[],
      ): void => {
        const savedTerms = sessionTabs.filter((t) => (t.k ?? "f") === "t");
        let termIndex = 0;
        const targetTabs = mutablePaneTabs(p, side);
        for (const sertab of serializedTabs) {
          const kind = sertab.k ?? "f";
          if (kind === "t") {
            const savedTerm = savedTerms[termIndex++];
            const tab = restoreTerminalTabFromSer(sertab, savedTerm);
            targetTabs.push(tab);
            if (sertab.a) setPaneActiveTabId(p, tab.id, side);
            // Reshow the bubble so the restored queued message is visible +
            // actionable without re-toggling Cmd+Shift+P (GAP 2).
            if (sertab.rpv ?? savedTerm?.rpv) showRichPromptForTab(tab.id);
            continue;
          }
          if (kind === "g" || kind === "b" || kind === "d" || kind === "x") {
            const tab =
              kind === "g"
                ? restoreGraphTabFromSer(sertab)
                : kind === "b"
                  ? restoreBrowserTabFromSer(sertab)
                  : kind === "d"
                    ? restoreDashboardTabFromSer(sertab)
                    : restoreExtensionTabFromSer(sertab);
            if (!tab) continue;
            targetTabs.push(tab);
            if (sertab.a) setPaneActiveTabId(p, tab.id, side);
            continue;
          }
          // Settings ("s") and health ("h") are overlays now; silently
          // drop saved entries from older sessions.
          if (kind !== "f") continue;
          const tab = restoreFileTabFromSer(sertab);
          targetTabs.push(tab);
          if (sertab.a) setPaneActiveTabId(p, tab.id, side);
          if (tab.path) {
            tabsToLoad.push({ paneId: p.id, tabId: tab.id, path: tab.path });
          }
        }
      };
      restoreTabsForSide("a", node.t, sessionLeaf?.t ?? []);
      restoreTabsForSide("b", node.bt ?? [], sessionLeaf?.bt ?? []);
      // If no tab was marked active but there are tabs, focus the first.
      if (!p.activeTabId && p.tabs.length > 0) p.activeTabId = p.tabs[0]!.id;
      if (!p.bActiveTabId && (p.bTabs?.length ?? 0) > 0) {
        p.bActiveTabId = p.bTabs![0]!.id;
      }
      if (node.ht) p.theme = node.ht === "d" ? "dark" : "light";
      p.side = node.sb ? "b" : "a";
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

/// Result of `reconcileLayout`. "applied": the remote snapshot was
/// structurally congruent with the live tree and its shared fields were
/// applied without keeping or refusing anything. "diverged": the live
/// tree deliberately kept state the remote does not carry (a dirty or
/// mid-save file tab the peer closed, a peer terminal without a session
/// id that cannot be attached, a pane-mode transaction in progress). The
/// caller keys echo suppression on this: applied -> pre-seed the
/// session-save dedupe snapshot so the trailing local save no-ops;
/// diverged -> leave it unseeded so the next local save pushes the kept
/// state back to the peer (self-healing). "deferred" means an active Pane
/// Mode transaction retained the conflicting snapshot for Escape and neither
/// reconciliation nor save-back may run yet.
export type ReconcileResult = "applied" | "diverged" | "deferred";

/// Non-destructive sibling of `restoreLayout` for live co-view sync:
/// apply a peer's persisted layout snapshot onto the LIVE tree without
/// remounting matched tabs, so unsaved editors and running xterms
/// survive.
///
/// Applied from remote: the pane tree (splits, directions, ratios), the
/// tab set per pane side, pane A/B side visibility, per-Hybrid theme
/// overrides, the window focus color, and terminal titles. Tabs are
/// matched TREE-WIDE by stable identity -- terminals by `tsid` (with an
/// ordinal fallback for structure-only blobs that omit session ids),
/// files by path + ordinal, graph/browser/dashboard by kind + ordinal, and
/// extensions by stable extension id + ordinal --
/// so a matched live tab OBJECT moves to its remote position, including
/// across panes (the keyed component salvage local drag-move relies on).
/// Remote tabs with no live match are created via the restore
/// constructors; a remote terminal without a `tsid` is skipped (a sync
/// never spawns a PTY; the peer's next save carries the id). Live tabs
/// absent from the remote are closed, EXCEPT dirty file tabs
/// (content !== saved) and tabs mid-save, which stay in their pane (or
/// park in the focused pane when theirs was rebuilt away).
///
/// Never applied from remote: active markers `a`, focus `f`, carets,
/// scroll, read mode. Each co-viewer keeps its own view; local active
/// tabs and pane focus survive whenever their objects do, falling back
/// to the remote markers only when the local target vanished.
export function reconcileLayout(remote: SerNode): ReconcileResult {
  if (paneModeDeferRemoteLayout(remote)) return "deferred";
  const ctx: ReconcileCtx = {
    diverged: false,
    remoteFocusPaneId: null,
    toLoad: [],
    parked: [],
    match: matchRemoteTabs(remote),
    materialized: new Map(),
  };
  layout.rootId = reconcileNode(remote, layout.rootId, ctx);
  // `wc` is stamped on the root node only; absence means the default
  // ("blue"), matching serializeLayout's omit-default rule.
  layout.focusColor = restoreFocusColor(remote.wc);
  // Focus overlay: local focus wins while its pane survives; when the
  // pane was rebuilt away, fall back to the remote focus marker, then
  // the first leaf.
  const focused = layout.nodes[layout.activePaneId];
  if (!focused || focused.kind !== "leaf") {
    layout.activePaneId = ctx.remoteFocusPaneId ?? firstLeafId(layout.rootId);
  }
  // Park protected tabs whose pane was rebuilt away in the focused pane
  // (their owner keeps them visible; the save-back returns them to the
  // peer).
  if (ctx.parked.length > 0) {
    const target = layout.nodes[layout.activePaneId];
    if (target?.kind === "leaf") {
      mutablePaneTabs(target).push(...ctx.parked);
      if (!paneActiveTabId(target)) {
        setPaneActiveTabId(target, ctx.parked[0]!.id);
      }
    }
  }
  // Load content for created file tabs; failures land in tab.error.
  for (const t of ctx.toLoad) {
    void loadTabContent(t.paneId, t.tabId, t.path);
  }
  return ctx.diverged ? "diverged" : "applied";
}

type ReconcileCtx = {
  diverged: boolean;
  remoteFocusPaneId: string | null;
  toLoad: { paneId: string; tabId: string; path: string }[];
  /// Protected tabs whose live pane did not survive a subtree rebuild.
  parked: Tab[];
  match: TabMatch;
  /// SerTab -> live tab for everything placed this apply (matched OR
  /// created); the per-side active fallback resolves remote `a` markers
  /// through it.
  materialized: Map<SerTab, Tab>;
};

type TabMatch = {
  byRemote: Map<SerTab, Tab>;
  consumed: Set<Tab>;
};

/// A tab the reconcile must never close: a dirty file tab (unsaved
/// content) or one with a write in flight.
function reconcileProtectedTab(t: Tab): boolean {
  return (
    t.kind === "file" &&
    (savingTabs.has(t.id) || (!t.loading && t.content !== t.saved))
  );
}

function liveLeavesInOrder(nodeId: string, out: LeafNode[] = []): LeafNode[] {
  const n = layout.nodes[nodeId];
  if (!n) return out;
  if (n.kind === "leaf") {
    out.push(n);
    return out;
  }
  liveLeavesInOrder(n.a, out);
  liveLeavesInOrder(n.b, out);
  return out;
}

/// Tree-wide identity matching between the remote snapshot's tabs and
/// the live tabs. Terminals match by `tsid` first (the PTY is the
/// identity); remaining remote terminals WITHOUT a tsid fall back to
/// ordinal order against unclaimed live terminals, so a peer's
/// transient structure-only blob (serialized before its terminals
/// reconnected) does not close every live terminal here. Files match by
/// path in ordinal order (dup paths pair up nth-to-nth); graph, browser,
/// and dashboard tabs by kind in ordinal order; extension tabs by extension
/// id in ordinal order. Tree-wide (not per-pane)
/// so a tab the peer moved across panes matches its live object and
/// moves instead of close-and-recreate.
function matchRemoteTabs(remote: SerNode): TabMatch {
  const remoteTabs = serializedLeaves(remote).flatMap((l) => [
    ...l.t,
    ...(l.bt ?? []),
  ]);
  const liveTabs = liveLeavesInOrder(layout.rootId).flatMap((l) => [
    ...l.tabs,
    ...(l.bTabs ?? []),
  ]);
  const byRemote = new Map<SerTab, Tab>();
  const consumed = new Set<Tab>();

  const byTsid = new Map<string, TerminalTab>();
  for (const t of liveTabs) {
    if (t.kind === "terminal" && t.terminalSessionId) {
      byTsid.set(t.terminalSessionId, t);
    }
  }
  for (const st of remoteTabs) {
    if ((st.k ?? "f") !== "t" || !st.tsid) continue;
    const hit = byTsid.get(st.tsid);
    if (hit && !consumed.has(hit)) {
      byRemote.set(st, hit);
      consumed.add(hit);
    }
  }

  const fileQueues = new Map<string, FileTab[]>();
  const kindQueues = new Map<string, Tab[]>();
  const termQueue: TerminalTab[] = [];
  for (const t of liveTabs) {
    if (consumed.has(t)) continue;
    if (t.kind === "file") {
      const q = fileQueues.get(t.path);
      if (q) q.push(t);
      else fileQueues.set(t.path, [t]);
    } else if (t.kind === "terminal") {
      termQueue.push(t);
    } else {
      const key =
        t.kind === "graph"
          ? "g"
          : t.kind === "browser"
            ? "b"
            : t.kind === "dashboard"
              ? "d"
              : `x:${t.extensionId}`;
      const q = kindQueues.get(key);
      if (q) q.push(t);
      else kindQueues.set(key, [t]);
    }
  }
  const take = <T extends Tab>(q: T[] | undefined): T | undefined => {
    const hit = q?.find((t) => !consumed.has(t));
    if (hit) consumed.add(hit);
    return hit;
  };
  for (const st of remoteTabs) {
    if (byRemote.has(st)) continue;
    const kind = st.k ?? "f";
    if (kind === "t") {
      // A remote tsid with no live counterpart creates a reattach tab
      // later; only tsid-less remote terminals match ordinally.
      if (st.tsid) continue;
      const hit = take(termQueue);
      if (hit) byRemote.set(st, hit);
      continue;
    }
    if (kind === "f") {
      const hit = take(fileQueues.get(st.p ?? ""));
      if (hit) byRemote.set(st, hit);
      continue;
    }
    if (kind === "g" || kind === "b" || kind === "d" || kind === "x") {
      const key = kind === "x" ? `x:${st.xi ?? ""}` : kind;
      const hit = take(kindQueues.get(key));
      if (hit) byRemote.set(st, hit);
    }
  }
  return { byRemote, consumed };
}

/// Walk the remote and live trees together. A live node of the same
/// shape (leaf, or split with the same direction) is kept in place, its
/// id and object identity intact; a shape mismatch rebuilds that subtree
/// from the remote, salvaging matched live tab objects into the new
/// panes and parking protected leftovers. Returns the (kept or new) node
/// id for the parent to reference.
function reconcileNode(
  remoteNode: SerNode,
  liveId: string | null,
  ctx: ReconcileCtx,
): string {
  const live = liveId ? layout.nodes[liveId] : undefined;
  if (remoteNode.k === "s") {
    const direction = remoteNode.d === "r" ? "row" : "column";
    if (live?.kind === "split" && live.direction === direction) {
      // Serialization omits `r` near the 50/50 default, so absence
      // means the peer's split sits at (or rounded to) even.
      live.ratio = typeof remoteNode.r === "number" ? remoteNode.r : 0.5;
      live.a = reconcileNode(remoteNode.a, live.a, ctx);
      live.b = reconcileNode(remoteNode.b, live.b, ctx);
      return live.id;
    }
    releaseSubtree(liveId, ctx);
    const split: SplitNode = {
      kind: "split",
      id: id("split"),
      direction,
      a: reconcileNode(remoteNode.a, null, ctx),
      b: reconcileNode(remoteNode.b, null, ctx),
      ratio: typeof remoteNode.r === "number" ? remoteNode.r : 0.5,
    };
    layout.nodes[split.id] = split;
    return split.id;
  }
  if (live?.kind === "leaf") {
    reconcileLeafTabs(remoteNode, live, ctx);
    applyLeafChrome(remoteNode, live);
    if (remoteNode.f) ctx.remoteFocusPaneId = live.id;
    return live.id;
  }
  releaseSubtree(liveId, ctx);
  const p: LeafNode = {
    kind: "leaf",
    id: id("pane"),
    tabs: [],
    activeTabId: null,
  };
  layout.nodes[p.id] = p;
  p.tabs = materializeSide(remoteNode.t, p.id, ctx);
  const bTabs = materializeSide(remoteNode.bt ?? [], p.id, ctx);
  if (bTabs.length > 0) p.bTabs = bTabs;
  // A rebuilt pane has no local view state to preserve: the remote
  // active markers (else the first tab) seed each side.
  p.activeTabId = remoteActiveTabId(remoteNode.t, p.tabs, ctx);
  if (p.bTabs && p.bTabs.length > 0) {
    p.bActiveTabId = remoteActiveTabId(remoteNode.bt ?? [], p.bTabs, ctx);
  }
  applyLeafChrome(remoteNode, p);
  if (remoteNode.f) ctx.remoteFocusPaneId = p.id;
  return p.id;
}

/// Drop a replaced live subtree from the node table, parking any
/// protected tabs the tree-wide match did not place elsewhere.
function releaseSubtree(nodeId: string | null, ctx: ReconcileCtx): void {
  if (!nodeId) return;
  const n = layout.nodes[nodeId];
  if (!n) return;
  if (n.kind === "leaf") {
    for (const t of allPaneTabs(n)) {
      if (!ctx.match.consumed.has(t) && reconcileProtectedTab(t)) {
        ctx.parked.push(t);
        ctx.diverged = true;
      }
    }
  } else {
    releaseSubtree(n.a, ctx);
    releaseSubtree(n.b, ctx);
  }
  delete layout.nodes[nodeId];
}

/// Rebuild a kept leaf's per-side tab lists in remote order, keeping the
/// local active tab whenever its object survived on that side.
function reconcileLeafTabs(
  remoteLeaf: SerLeaf,
  live: LeafNode,
  ctx: ReconcileCtx,
): void {
  const prevA = [...live.tabs];
  const prevB = [...(live.bTabs ?? [])];
  const priorActiveA = live.activeTabId;
  const priorActiveB = live.bActiveTabId ?? null;

  const nextA = materializeSide(remoteLeaf.t, live.id, ctx);
  const nextB = materializeSide(remoteLeaf.bt ?? [], live.id, ctx);
  // Protected tabs of THIS leaf the remote no longer carries stay on
  // their side, after the synced set.
  for (const t of prevA) {
    if (!ctx.match.consumed.has(t) && reconcileProtectedTab(t)) {
      nextA.push(t);
      ctx.diverged = true;
    }
  }
  for (const t of prevB) {
    if (!ctx.match.consumed.has(t) && reconcileProtectedTab(t)) {
      nextB.push(t);
      ctx.diverged = true;
    }
  }
  live.tabs = nextA;
  if (nextB.length > 0) live.bTabs = nextB;
  else if (live.bTabs) live.bTabs = [];

  live.activeTabId = overlayActiveTabId(
    priorActiveA,
    remoteLeaf.t,
    nextA,
    ctx,
  );
  live.bActiveTabId =
    nextB.length > 0
      ? overlayActiveTabId(priorActiveB, remoteLeaf.bt ?? [], nextB, ctx)
      : null;
}

/// Map one side's remote tab list onto live objects: matched tabs move
/// here (terminal titles ride along), unmatched ones are created via the
/// restore constructors. A remote terminal without a `tsid` is skipped --
/// a sync never spawns a PTY -- and flags divergence so the local
/// save-back keeps the peers converging. Legacy overlay kinds ("s"
/// settings, "h" health) drop silently, as on restore.
function materializeSide(
  sertabs: SerTab[],
  paneId: string,
  ctx: ReconcileCtx,
): Tab[] {
  const out: Tab[] = [];
  for (const sertab of sertabs) {
    const kind = sertab.k ?? "f";
    if (kind === "s" || kind === "h") continue;
    const matched = ctx.match.byRemote.get(sertab);
    if (matched) {
      // Terminal titles are shared structure (a rename should co-view);
      // every other per-tab field on a matched tab stays local.
      if (
        matched.kind === "terminal" &&
        typeof sertab.n === "string" &&
        sertab.n &&
        sertab.n !== matched.title
      ) {
        matched.title = sertab.n;
      }
      ctx.materialized.set(sertab, matched);
      out.push(matched);
      continue;
    }
    if (kind === "t") {
      if (!sertab.tsid) {
        ctx.diverged = true;
        continue;
      }
      const tab = restoreTerminalTabFromSer(sertab);
      ctx.materialized.set(sertab, tab);
      out.push(tab);
      continue;
    }
    const tab =
      kind === "g"
        ? restoreGraphTabFromSer(sertab)
        : kind === "b"
          ? restoreBrowserTabFromSer(sertab)
          : kind === "d"
            ? restoreDashboardTabFromSer(sertab)
            : kind === "x"
              ? restoreExtensionTabFromSer(sertab)
              : restoreFileTabFromSer(sertab);
    if (!tab) continue;
    ctx.materialized.set(sertab, tab);
    out.push(tab);
    if (tab.kind === "file" && tab.path) {
      ctx.toLoad.push({ paneId, tabId: tab.id, path: tab.path });
    }
  }
  return out;
}

/// Local active tab wins while it survives on this side; otherwise the
/// remote `a` marker (resolved through the materialized map), then the
/// first tab.
function overlayActiveTabId(
  priorActiveId: string | null,
  sertabs: SerTab[],
  next: Tab[],
  ctx: ReconcileCtx,
): string | null {
  if (priorActiveId && next.some((t) => t.id === priorActiveId)) {
    return priorActiveId;
  }
  return remoteActiveTabId(sertabs, next, ctx);
}

function remoteActiveTabId(
  sertabs: SerTab[],
  next: Tab[],
  ctx: ReconcileCtx,
): string | null {
  const marked = sertabs.find((st) => st.a);
  const mapped = marked ? ctx.materialized.get(marked) : undefined;
  if (mapped && next.some((t) => t.id === mapped.id)) return mapped.id;
  return next[0]?.id ?? null;
}

/// Pane chrome shared by kept and rebuilt leaves: theme override and A/B
/// side visibility. Absent `ht` means "follow global": clear the
/// override rather than keeping a stale local one.
function applyLeafChrome(remoteLeaf: SerLeaf, live: LeafNode): void {
  live.theme =
    remoteLeaf.ht === "d" ? "dark" : remoteLeaf.ht === "l" ? "light" : undefined;
  const side: PaneSide = remoteLeaf.sb ? "b" : "a";
  if (paneSide(live) !== side) {
    live.side = side;
    // Mirror flipHybrid: landing on a side that has tabs but no active
    // id seeds the first tab so the flip shows content.
    const tabs = paneTabs(live, side);
    if (!paneActiveTabId(live, side) && tabs.length > 0) {
      setPaneActiveTabId(live, tabs[0]!.id, side);
    }
  }
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

/// True when a serialized layout carries durable content -- at least one
/// non-terminal tab (a file/browser/graph/hybrid/dashboard surface).
/// Terminal tabs (`k:"t"`) are ephemeral: the PTY dies on restart and a
/// saved `tsid` only respawns a fresh shell, so a window whose tabs are ALL
/// terminals (or has none) is not worth persisting as a saved window. Used
/// by `serializeSession()` so a terminal-only window deletes its blob
/// instead of saving it.
export function layoutHasDurableContent(layout: SerNode | null): boolean {
  for (const leaf of serializedLeaves(layout)) {
    // Side A plus side B tabs.
    for (const tab of [...leaf.t, ...(leaf.bt ?? [])]) {
      if ((tab.k ?? "f") !== "t") return true;
    }
  }
  return false;
}

/// True when a serialized layout has at least one terminal tab carrying a
/// `tsid` -- i.e. a live server-side PTY to RE-ATTACH on reload. A terminal
/// without a tsid (not yet connected, or its session ended) has nothing to
/// reattach, so persisting a reload snapshot of it would only spawn a stray
/// fresh PTY when restored. Gates the all-terminal reload snapshot in
/// store.svelte.ts so a tsid-less terminal layout is never snapshotted.
export function layoutHasReattachableTerminal(layout: SerNode | null): boolean {
  for (const leaf of serializedLeaves(layout)) {
    for (const tab of [...leaf.t, ...(leaf.bt ?? [])]) {
      if ((tab.k ?? "f") === "t" && !!tab.tsid) return true;
    }
  }
  return false;
}

/// True when a serialized layout is worth persisting for its STRUCTURE alone,
/// even with no durable content and no reattachable PTY: a split (more than one
/// pane, so empty panes survive) or a terminal-only window. Restoring it
/// recreates the panes and spawns FRESH shells for the terminals -- the PTYs are
/// gone after a restart or a workspace off->on, and the layout is what we keep.
/// Gates the on-disk session save (store.svelte.ts) so a terminal-only or
/// empty-split window no longer restores blank. A single empty pane stays
/// unpersisted (it is just the default window).
export function layoutHasPersistableStructure(layout: SerNode | null): boolean {
  if (!layout) return false;
  const leaves = serializedLeaves(layout);
  if (leaves.length > 1) return true;
  for (const leaf of leaves) {
    for (const tab of [...leaf.t, ...(leaf.bt ?? [])]) {
      if ((tab.k ?? "f") === "t") return true;
    }
  }
  return false;
}

/// Copy terminal PTY session metadata from a per-window session layout
/// onto the live layout after a shareable URL-hash layout restore.
/// The hash deliberately omits `tsid`; this graft keeps reloads
/// from abandoning the server-side PTY while still keeping copied URLs
/// free of private terminal ids.
export function hydrateTerminalSessionsFromLayout(sessionLayout: SerNode | null): void {
  const sessionLeaves = serializedLeaves(sessionLayout);
  const livePaneIds = leafIdsInOrder(layout.rootId);
  for (let i = 0; i < livePaneIds.length; i++) {
    const live = layout.nodes[livePaneIds[i]!];
    const saved = sessionLeaves[i];
    if (!live || live.kind !== "leaf" || !saved) continue;
    const pairs: Array<[TerminalTab[], SerTab[]]> = [
      [
        live.tabs.filter((t): t is TerminalTab => t.kind === "terminal"),
        saved.t.filter((t) => (t.k ?? "f") === "t"),
      ],
      [
        (live.bTabs ?? []).filter((t): t is TerminalTab => t.kind === "terminal"),
        (saved.bt ?? []).filter((t) => (t.k ?? "f") === "t"),
      ],
    ];
    for (const [liveTerms, savedTerms] of pairs) {
      for (let j = 0; j < liveTerms.length; j++) {
        const savedTerm = savedTerms[j];
        if (!savedTerm) continue;
        if (savedTerm.tsid) {
          liveTerms[j]!.terminalSessionId = savedTerm.tsid;
          liveTerms[j]!.lastAgentEchoSeq =
            typeof savedTerm.tae === "number" && Number.isFinite(savedTerm.tae)
              ? Math.max(0, Math.floor(savedTerm.tae))
              : undefined;
        }
        if (savedTerm.rpd) liveTerms[j]!.richPromptDraftPath = savedTerm.rpd;
        if (savedTerm.rpc) {
          liveTerms[j]!.richPromptCaret = {
            from: savedTerm.rpc[0],
            to: savedTerm.rpc[1],
          };
        }
        if (savedTerm.rph) liveTerms[j]!.richPromptHeight = savedTerm.rph;
        if (savedTerm.twk) liveTerms[j]!.teamWorkPending = savedTerm.twk;
      }
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
  // An attached tab's authority owns the path lifecycle: the session's
  // `removed` frame routes into the missing-file machinery directly, so
  // a watcher-driven probe would double-fire and race the reconciler's
  // rename handling.
  const attached = findFileTabById(tabId);
  if (attached && isDocAttached(attached.tab)) return;
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
/// genuine missing-file detection. Requests exact-basename
/// candidates and drops the original path; only surfaces a
/// suggestion when there's a unique candidate. Ambiguous results leave
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
      .filter((candidate) => candidate !== path);
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
  if (node?.kind === "leaf") {
    const match = findTabInPane(node, tabId);
    if (match) {
      node.side = match.side;
      setPaneActiveTabId(node, tabId, match.side);
    }
  }
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
  if (!found) return;
  // Attached tabs merge external writes live through the authority's
  // reconciler; the banner is for the classic disk-mediated path only.
  if (isDocAttached(found.tab)) return;
  found.tab.externalChange = true;
}

/// Dismiss the "changed on disk" banner without reloading (the user
/// chose to keep editing). It re-raises on the next external write.
export function dismissExternalChange(tabId: string): void {
  const found = findFileTabById(tabId);
  if (found) found.tab.externalChange = false;
}

/// Adopt the live user-write bit carried on a watcher frame. chmod
/// does not touch mtime, so neither the doc-session reconciler nor the
/// banner path ever surfaces a permission flip: without this the
/// locked lamp and the editor's readOnly only ever re-sample on load.
export function applyFsWritable(tabId: string, writable: boolean): void {
  const found = findFileTabById(tabId);
  if (found) found.tab.fsWritable = writable;
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
    if (paneTabs(node).length === 0) continue;
    const active = activeTabInPane(node);
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
    for (const t of allPaneTabs(node)) {
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
  // Move the persisted caret(s) with the file/dir so a renamed file keeps its
  // remembered caret and does not orphan a stale entry.
  rekeyCaret(from, to);
  const dirPrefix = `${from}/`;
  const newDirPrefix = `${to}/`;
  for (const node of Object.values(layout.nodes)) {
    if (node.kind !== "leaf") continue;
    for (const t of allPaneTabs(node)) {
      if (t.kind !== "file") continue;
      if (t.path === from) {
        // The doc session is keyed to the old path server-side; detach
        // now and let the acquire effect re-attach under the new path.
        releaseDocSessionForTab(t.id, true);
        t.path = to;
      } else if (t.path.startsWith(dirPrefix)) {
        releaseDocSessionForTab(t.id, true);
        t.path = newDirPrefix + t.path.slice(dirPrefix.length);
      }
    }
  }
}
