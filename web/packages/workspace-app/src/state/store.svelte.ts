// Global app state, written with Svelte 5 runes ($state).
// One module-level singleton per concern; components import them directly.

import type {
  Preferences,
  WorkspaceInfo,
  WorkspaceWarning,
  HybridSurfaceKind,
  HybridSurfaceThemes,
  IndexStatus,
  SurfaceThemeChoice,
  TerminalRosterEntry,
  TreeEntry,
} from "../api/types";
import {
  createDeckDraft,
  loadSessionDeckDraft,
  saveSessionDeckDraft,
  type DeckDraft,
} from "@chan/web-shared/command-deck";
import {
  ApiError,
  api,
  authToken,
  clientNonce,
  openWatchSocket,
  sessionPath,
  sessionWindowId,
  type SurveySpec,
  type WatchSubscription,
  type WsStatus,
} from "../api/client";
import { isWorkspaceRootMissingError } from "../api/errors";
import {
  closeSurveyFromRemote,
  showSurvey,
  type SurveyCloseReason,
} from "./survey.svelte";
import { applySessionRoster, isFollower, showHandover, type SessionParticipant } from "./session.svelte";
import { docSyncRosterChanged } from "./docSync.svelte";
import { sceneSyncRosterChanged } from "./sceneSync.svelte";
import { isWindowEnded, markWindowDiscarded, markWindowHidden } from "./windowLifecycle.svelte";
import {
  activeLayout,
  activeTabInPane,
  allPaneTabs,
  closePane,
  closeTab,
  hasBrowserTab,
  cancelMissingFileCheck,
  hasGraphTab,
  layout,
  markTabFileMissing,
  openBrowserInActivePane,
  openBrowserInPane,
  scheduleMissingFileCheck,
  openGraphInActivePane,
  openGraphInPane,
  parseGraphLink,
  paneActiveTabId,
  paneSide,
  paneTabs,
  openInActivePane,
  openInPane,
  openTerminalInPane,
  openTerminalInActivePane,
  openDashboardInPane,
  equalizePane,
  focusPane,
  layoutHasDurableContent,
  layoutHasPersistableStructure,
  layoutHasReattachableTerminal,
  paneMode,
  paneModeDeferRemoteLayout,
  reconcileLayout,
  registerPaneModeSettledSink,
  registerDraftPromotionSink,
  resizePane,
  resolveTabDestination,
  restoreLayout,
  serializeLayout,
  selectTabInPane,
  splitPane,
  swapPanes,
  type BrowserTab,
  type LeafNode,
  type OpenGraphOptions,
  type PaneSide,
  type ResolvedTabDestination,
  type SerNode,
  type SpawnContext,
  type Tab,
} from "./tabs.svelte";
import { isEditableText } from "./fileTypes";
import { openMediaViewer } from "./mediaOpen";
import {
  activeTransferCount,
  applyTransferQueueFrame,
  beginTransfer,
  cancelTransfer,
  failTransfer,
  finishTransfer,
  restoreTransfers,
  setTransferProgress,
  setTransferSignalSink,
  waitForTransferSlot,
} from "./transfers.svelte";
import {
  isTauriDesktop,
  openReverseTunnel,
  runDesktopDownload,
  runDesktopUpload,
} from "../api/desktop";
import {
  base64ToBytes,
  hintClipboardError,
  writeClipboardPayload,
} from "../api/clipboard";
import { respondClipboardRead, warnUnlessStaleReply } from "./pasteRequest.svelte";
import {
  appendDefaultMd,
  preserveExtension,
  proposeDefaultFilename,
} from "./pathValidate";
import { setNotifyHandler } from "./notify.svelte";
import { defaultScopeId } from "./scope.svelte";
import {
  allTerminalTabs,
  applyFsWritable,
  applyTerminalRoster,
  clearTabError,
  findTeamWorkPendingLead,
  flagExternalChange,
  refreshTabFromDisk,
  rekeyTabsForRename,
  setTerminalBroadcastBySession,
  tabsForPath,
} from "./tabs.svelte";
import { openTeamDialog, teamDialogState } from "./teamDialog.svelte";
import { graphData, invalidateGraph, ensureGraphLoaded } from "./graphData.svelte";
import { chanFetch, handleDemoDownload, withTokenQuery } from "../api/transport";
import { uiConfirm } from "./confirm.svelte";
import { applyEditorToolPreferences } from "./editorTools.svelte";
import { updateGlobalConfigSerial } from "./configWrite";
import {
  hydrateOverrides,
  registerOverridePersist,
} from "./keymapOverrides.svelte";
import { hydratePageWidthFromPrefs } from "./pageWidth.svelte";
import { fbWatchResyncAll } from "./fbWatch.svelte";
// `workspace` + the draft-path helpers live in a side-effect-free leaf
// module so `tabs.svelte.ts` can read `draftsDir()` without dragging in
// store's eager draft-promotion-sink registration (init-order cycle).
// Re-export `workspace` here so existing `from "./store.svelte"`
// importers keep working unchanged.
export {
  workspace,
  draftsDir,
  isDraftPath,
} from "./workspace.svelte";
import { workspace, draftsDir, isDraftPath } from "./workspace.svelte";
import { clearCaretsUnder } from "./caretIndex";

/// Display name for the active workspace. The server computes this from
/// the path; it is not user-managed registry metadata.
export function workspaceDisplayName(): string {
  const info = workspace.info;
  if (!info) return "";
  const label = info.label?.trim();
  if (label) return label;
  const root = info.root ?? "";
  if (!root) return "";
  const stripped = root.replace(/[/\\]+$/, "");
  if (!stripped) return "";
  const slash = Math.max(stripped.lastIndexOf("/"), stripped.lastIndexOf("\\"));
  return slash < 0 ? stripped : stripped.slice(slash + 1);
}

export const tree = $state<{
  entries: TreeEntry[];
  loading: boolean;
  error: string | null;
  rootUnavailable: boolean;
  loadedDirs: Record<string, true>;
  loadingDirs: Record<string, true>;
  dirErrors: Record<string, string>;
}>({
  entries: [],
  loading: true,
  error: null,
  rootUnavailable: false,
  loadedDirs: {},
  loadingDirs: {},
  dirErrors: {},
});

/**
 * Theme model.
 *
 *   - `themeChoice` is what the user picked: "system" follows the OS
 *     prefers-color-scheme media query live, "light" / "dark" lock
 *     the editor to that mode regardless of OS.
 *   - `theme` is the resolved value applied to the DOM (always one of
 *     "light" | "dark"). Components read this for variant styling.
 *
 * Persisted in the global config (`~/.chan/config.toml`), not in
 * localStorage. PATCH /api/config emits a `config_changed` WS event
 * so a flip in one window propagates to every other open window
 * live; that channel also survives WebView storage wipes.
 */
export type ThemeChoice = "system" | "light" | "dark";

function systemTheme(): "light" | "dark" {
  if (typeof window !== "undefined" && window.matchMedia) {
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
    if (window.matchMedia("(prefers-color-scheme: light)").matches) return "light";
    // Neither query matches: the OS appearance is undeterminable (e.g.
    // headless linux with no desktop colour-scheme signal). Default to
    // dark, same as when matchMedia itself is unavailable.
    return "dark";
  }
  return "dark";
}

/** Test seam: resolve the OS system theme from the current `matchMedia`.
 *  Lets the headless-fallback regression test stub `matchMedia` and assert
 *  the resolution without driving the persisted-choice path. */
export function __testSystemTheme(): "light" | "dark" {
  return systemTheme();
}

function effectiveTheme(choice: ThemeChoice): "light" | "dark" {
  return choice === "system" ? systemTheme() : choice;
}

export const ui = $state<{
  status: string | null;
  /// Notification kind workspaces the auto-dismiss policy. Transient
  /// statuses (action confirmations: "Copied path", "Saved", short
  /// notify() pings) clear themselves after a short window;
  /// persistent statuses (in-flight ops: "Moving...", errors) stay
  /// until overwritten or explicitly cleared. A bare `ui.status = ...`
  /// write leaves `statusKind` null: the pill then has no dismiss
  /// control and never auto-clears, so a caller that wants a dismissable
  /// pill sets `statusKind = "persistent"` alongside the write. Transient
  /// writes go through `setTransientStatus` (or `notify()` which routes
  /// through that helper).
  statusKind: "transient" | "persistent" | null;
  statusAction: { kind: "workspace-warnings"; label: string } | null;
  /// Used to nudge tabs to reload on external changes.
  lastWatch: number;
  ws: WsStatus;
  /// Reconnect attempt count from the watcher transport: 0 while open or on
  /// the first connect, then 1, 2, ... on each reconnect. Drives the "attempt
  /// N" counter the DisconnectOverlay shows, matching the desktop connecting
  /// screen.
  wsAttempt: number;
  /// User's pick. Mirrored from the global config; written through
  /// `setThemeChoice`.
  themeChoice: ThemeChoice;
  /// Resolved value applied to `document.documentElement[data-theme]`.
  theme: "light" | "dark";
  /// Set when the SPA shell loaded but bootstrap's first API call
  /// returned 401 and there was no token in the URL or sessionStorage.
  /// Workspaces `MissingTokenOverlay`. Users land here when they copy the
  /// loopback URL out of the address bar but lose the `?t=...` token
  /// the server prints at launch.
  authMissing: boolean;
  /// True while the DisconnectOverlay is actively blocking the UI (the
  /// watcher dropped after having been open, past the startup grace). The
  /// overlay greys out the app, but global keyboard shortcuts are
  /// document-level and fire regardless of focus, so App.svelte's key
  /// handlers consult this to suppress pane/tab shortcuts (e.g. Ctrl+D
  /// closing a tab) behind the overlay. Owned by DisconnectOverlay, which
  /// mirrors its `visible` here.
  disconnectBlocking: boolean;
  /// True when the window loaded in terminal-only mode (`?kind=terminal`):
  /// a workspace-less standalone terminal window backed by a slim server
  /// tenant. There is no workspace, no file tree, no editor / graph /
  /// file-browser / dashboard surfaces, no rich prompt, no team work.
  /// Set once at bootstrap and never flipped. Surfaces gate their
  /// workspace-only affordances off this flag (Hybrid staging spawns,
  /// rich prompt, team work, and commands that open workspace-backed
  /// surfaces). In this mode `app.terminal.toggle` (Cmd+T) adds a
  /// terminal tab to the focused pane.
  terminalOnly: boolean;
  /// Terminal-only windows close when their last terminal tab is closed (they
  /// never sit empty). Set true by `bootstrapTerminalOnly` AFTER the first
  /// terminal exists, so the transient empty layout during boot can't trip the
  /// close-on-last-tab watcher in App.svelte. Always false in workspace mode.
  terminalArmed: boolean;
  /// The control-terminal sub-mode (`kind=control`): a singleton terminal-only
  /// window running a devserver's connect script. Stricter than `terminalOnly`
  /// -- the tab strip / pane chrome are hidden and Cmd+T / pane splits are
  /// disabled so it stays one PTY. Set once at bootstrap from the URL, never
  /// flipped. Implies `terminalOnly`.
  terminalControl: boolean;
}>({
  status: null,
  statusKind: null,
  statusAction: null,
  lastWatch: 0,
  ws: "connecting",
  wsAttempt: 0,
  themeChoice: "system",
  theme: effectiveTheme("system"),
  authMissing: false,
  disconnectBlocking: false,
  terminalOnly: isTerminalOnlyWindow(),
  terminalArmed: false,
  terminalControl: isControlTerminalWindow(),
});

/// The window-kind URL marker. The `?kind=` query param (set by the desktop
/// shell when it opens a standalone terminal window) is the ONLY signal; there
/// is no server bootstrap marker. Read once at module load so the flag is
/// stable before any component mounts. Guarded for non-browser (test) contexts
/// where `location` may be undefined.
function windowKind(): string | null {
  try {
    return new URLSearchParams(location.search).get("kind");
  } catch {
    return null;
  }
}

/// Detect terminal-only mode from the window URL. Both `kind=terminal` (a
/// regular standalone terminal) and `kind=control` (the singleton control
/// terminal that runs a devserver's connect script) boot terminal-only: no
/// workspace fetch, terminal panes only.
export function isTerminalOnlyWindow(): boolean {
  const kind = windowKind();
  return kind === "terminal" || kind === "control";
}

/// The control terminal is a stricter sub-mode of terminal-only (`kind=control`,
/// set by the shell's `spawn_control_terminal_window`): a singleton that hosts
/// exactly one PTY (the connect script), hides the tab strip / pane chrome, and
/// disables Cmd+T + pane splits so it can never replicate into Terminal 1/2/3.
export function isControlTerminalWindow(): boolean {
  return windowKind() === "control";
}

export const HYBRID_SURFACE_KINDS: readonly HybridSurfaceKind[] = [
  "editor",
  "terminal",
  "browser",
  "graph",
  "dashboard",
];

export const workspaceWarningsDialog = $state<{
  open: boolean;
  warnings: WorkspaceWarning[];
  busyKey: string | null;
  error: string | null;
  notice: string | null;
}>({
  open: false,
  warnings: [],
  busyKey: null,
  error: null,
  notice: null,
});

export const hybridSurfaceThemes = $state<HybridSurfaceThemes>({});

function normalizeHybridSurfaceThemes(
  raw: HybridSurfaceThemes | null | undefined,
): HybridSurfaceThemes {
  const next: HybridSurfaceThemes = {};
  for (const kind of HYBRID_SURFACE_KINDS) {
    const value = raw?.[kind];
    if (value === "light" || value === "dark") next[kind] = value;
  }
  return next;
}

function applyHybridSurfaceThemes(raw: HybridSurfaceThemes | null | undefined): void {
  const next = normalizeHybridSurfaceThemes(raw);
  for (const kind of HYBRID_SURFACE_KINDS) {
    const value = next[kind];
    if (value) hybridSurfaceThemes[kind] = value;
    else delete hybridSurfaceThemes[kind];
  }
}

function hybridSurfaceThemesSnapshot(): HybridSurfaceThemes {
  return normalizeHybridSurfaceThemes(hybridSurfaceThemes);
}

export function surfaceThemeOverride(
  kind: HybridSurfaceKind,
): SurfaceThemeChoice | undefined {
  return hybridSurfaceThemes[kind];
}

export function effectiveHybridSurfaceTheme(kind: HybridSurfaceKind): SurfaceThemeChoice {
  return hybridSurfaceThemes[kind] ?? ui.theme;
}

export function setHybridSurfaceTheme(
  kind: HybridSurfaceKind,
  choice: SurfaceThemeChoice,
): void {
  hybridSurfaceThemes[kind] = choice;
  void persistHybridSurfaceThemes();
}

/// Drop a surface's body-theme override so it falls back to the global
/// `theme`. The settings surface's per-surface control offers this as
/// "Inherit".
export function clearHybridSurfaceTheme(kind: HybridSurfaceKind): void {
  delete hybridSurfaceThemes[kind];
  void persistHybridSurfaceThemes();
}

// updateGlobalConfigSerial lives in ./configWrite (a leaf module with no store
// dependency) so editorTools.svelte.ts can share the SAME write chain without
// an import cycle -- store imports editorTools, so editorTools must not import
// store back. Re-exported here so existing call sites keep importing it from
// the store barrel.
export { updateGlobalConfigSerial };

function persistHybridSurfaceThemes(): Promise<void> {
  const next = hybridSurfaceThemesSnapshot();
  return updateGlobalConfigSerial(() => ({ hybrid_surface_themes: next }));
}

// Route the keymap override layer's writes through the shared config helper:
// every shortcut assign/clear replaces the composite override table at
// `preferences.shortcuts`. The server broadcasts config_changed,
// so applyServerPreferences re-hydrates every other window.
registerOverridePersist((shortcuts) => {
  void updateGlobalConfigSerial(() => ({ shortcuts }));
});

const TRANSIENT_STATUS_DEFAULT_MS = 3000;
let transientStatusTimer: ReturnType<typeof setTimeout> | null = null;

/// Set an auto-dismissing status pill. Used for action
/// confirmations (Copied, Saved, etc.) - anything where the user
/// doesn't need to dismiss it manually. Re-entry cancels the
/// prior timer so the latest message wins.
export function setTransientStatus(
  msg: string,
  ms: number = TRANSIENT_STATUS_DEFAULT_MS,
): void {
  if (transientStatusTimer !== null) {
    clearTimeout(transientStatusTimer);
    transientStatusTimer = null;
  }
  ui.status = msg;
  ui.statusKind = "transient";
  ui.statusAction = null;
  transientStatusTimer = setTimeout(() => {
    transientStatusTimer = null;
    // Only clear if the message hasn't been overwritten by a newer
    // status during the window. A direct `ui.status = ...`
    // (persistent) write stomps our transient mid-flight and we
    // leave it alone.
    if (ui.status === msg && ui.statusKind === "transient") {
      ui.status = null;
      ui.statusKind = null;
      ui.statusAction = null;
    }
  }, ms);
}

/// Explicitly clear the status pill. This is the "explicitly cleared" half
/// of the persistent-status contract: the one-shot error setters
/// (create / rename / upload / paste / copy / delete failures) have no
/// lifecycle owner, so without an explicit clear a persistent error sits
/// forever, even behind the collapse chevron. Clearing is safe for every
/// kind: a "Moving..." progress status re-clears when the move settles, and
/// a workspace-warnings status re-asserts itself on the next info pass.
export function dismissStatus(): void {
  if (transientStatusTimer !== null) {
    clearTimeout(transientStatusTimer);
    transientStatusTimer = null;
  }
  ui.status = null;
  ui.statusKind = null;
  ui.statusAction = null;
}

// Route leaf-module notify() calls through the transient writer
// so short action-confirmation pings auto-dismiss instead of
// piling up on the status bar.
setNotifyHandler((msg) => {
  setTransientStatus(msg);
});

const dismissedWorkspaceWarningKeys = new Set<string>();

function workspaceWarningKey(warning: WorkspaceWarning): string {
  return `${warning.kind}\u0000${warning.path}\u0000${warning.message}`;
}

function activeWorkspaceWarnings(info: WorkspaceInfo): WorkspaceWarning[] {
  return (info.warnings ?? []).filter(
    (warning) => !dismissedWorkspaceWarningKeys.has(workspaceWarningKey(warning)),
  );
}

function workspaceWarningStatusLabel(warnings: WorkspaceWarning[]): string {
  if (warnings.length === 1) return workspaceWarningLabel(warnings[0]!);
  return `${warnings.length} workspace warnings found`;
}

export function workspaceWarningLabel(warning: WorkspaceWarning): string {
  // Only `broken_draft` is a known warning kind today; the backend
  // does not emit any other kinds.
  const prefix =
    warning.kind === "broken_draft" ? "Broken draft" : "Workspace warning";
  return `${prefix} ${warning.path}: ${warning.message}`;
}

export function canDiscardWorkspaceWarning(warning: WorkspaceWarning): boolean {
  if (warning.kind !== "broken_draft") {
    return false;
  }
  // A discardable broken draft is a direct child of the drafts dir
  // (e.g. `.Drafts/untitled-1`), not the dir itself or a deeper path.
  const prefix = `${draftsDir()}/`;
  if (!warning.path.startsWith(prefix)) return false;
  const rest = warning.path.slice(prefix.length);
  return rest.length > 0 && !rest.includes("/");
}

function surfaceWorkspaceWarnings(info: WorkspaceInfo): void {
  const warnings = activeWorkspaceWarnings(info);
  workspaceWarningsDialog.warnings = warnings;
  if (warnings.length === 0) {
    if (
      ui.statusAction?.kind === "workspace-warnings" &&
      ui.statusAction.label === ui.status
    ) {
      ui.status = null;
      ui.statusKind = null;
    }
    ui.statusAction = null;
    if (workspaceWarningsDialog.open) {
      workspaceWarningsDialog.open = false;
    }
    return;
  }
  const label = workspaceWarningStatusLabel(warnings);
  ui.status = label;
  ui.statusKind = "persistent";
  ui.statusAction = { kind: "workspace-warnings", label };
}

export function openWorkspaceWarningsDialog(): void {
  workspaceWarningsDialog.error = null;
  workspaceWarningsDialog.notice = null;
  workspaceWarningsDialog.open = true;
}

export function closeWorkspaceWarningsDialog(): void {
  if (workspaceWarningsDialog.busyKey !== null) return;
  workspaceWarningsDialog.open = false;
}

/// Shared clipboard helper. Writes `text` via the Clipboard API and
/// reports the result through the standard callbacks; callers wire it
/// to either the workspace-warnings dialog state (legacy caller) or
/// the global transient status pill (everyone else). Keeping the
/// Clipboard-API plumbing in one place means the editor's right-click
/// "Copy path", the warnings dialog, and the inspector's COPY button
/// all share the same fallback + error shape.
export async function copyTextToClipboard(
  text: string,
  opts: {
    onSuccess?: () => void;
    onError?: (msg: string) => void;
  } = {},
): Promise<void> {
  try {
    if (!navigator.clipboard) {
      throw new Error("Clipboard unavailable");
    }
    await navigator.clipboard.writeText(text);
    opts.onSuccess?.();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to copy to clipboard";
    opts.onError?.(msg);
  }
}

export async function copyWorkspaceWarningPath(warning: WorkspaceWarning): Promise<void> {
  await copyTextToClipboard(warning.path, {
    onSuccess: () => {
      workspaceWarningsDialog.error = null;
      workspaceWarningsDialog.notice = "Copied path";
    },
    onError: (msg) => {
      workspaceWarningsDialog.notice = null;
      workspaceWarningsDialog.error = msg;
    },
  });
}

export function dismissWorkspaceWarning(warning: WorkspaceWarning): void {
  dismissedWorkspaceWarningKeys.add(workspaceWarningKey(warning));
  workspaceWarningsDialog.error = null;
  workspaceWarningsDialog.notice = "Dismissed for this session";
  if (workspace.info) {
    surfaceWorkspaceWarnings(workspace.info);
  }
}

export async function discardWorkspaceWarning(warning: WorkspaceWarning): Promise<void> {
  if (!canDiscardWorkspaceWarning(warning)) return;
  const confirmed = await uiConfirm({
    title: "Discard broken draft?",
    message: `Move ${warning.path} to trash?`,
    confirmLabel: "Discard",
    destructive: true,
  });
  if (!confirmed) return;

  const key = workspaceWarningKey(warning);
  workspaceWarningsDialog.busyKey = key;
  workspaceWarningsDialog.error = null;
  workspaceWarningsDialog.notice = null;
  try {
    await api.discardDraft(warning.path);
    const info = await api.workspace();
    workspace.info = info;
    applyServerPreferences();
    surfaceWorkspaceWarnings(info);
    if (workspaceWarningsDialog.warnings.length === 0) {
      setTransientStatus(`Discarded ${warning.path}`);
    } else {
      workspaceWarningsDialog.notice = `Discarded ${warning.path}`;
    }
  } catch (e) {
    workspaceWarningsDialog.error =
      e instanceof Error ? e.message : `Failed to discard ${warning.path}`;
  } finally {
    workspaceWarningsDialog.busyKey = null;
  }
}

/** Apply the resolved theme to the DOM. Idempotent; safe to call
 *  before mount (used as the App's first-paint sync). */
function applyResolvedTheme(): void {
  document.documentElement.setAttribute("data-theme", ui.theme);
}

/** Reflect a server-sourced choice locally. No write-back; used by
 *  the boot path and the config_changed WS handler. */
function setThemeLocal(choice: ThemeChoice): void {
  ui.themeChoice = choice;
  ui.theme = effectiveTheme(choice);
  applyResolvedTheme();
}

/** Pick a theme. Optimistic local apply, then PATCH the global config
 *  so every other open window picks up the change over the WS
 *  `config_changed` event. */
export function setThemeChoice(choice: ThemeChoice): void {
  setThemeLocal(choice);
  void persistThemeChoice(choice);
}

/** Apply the launcher's local-theme choice to a standalone terminal window.
 *  `"dark"` / `"light"` lock that mode; `null` restores OS-follow. Reuses
 *  `setThemeLocal` (no write-back), driven by the `local-theme` watch. Only
 *  terminal-only windows subscribe; workspace windows keep the config theme. */
export function applyLocalTheme(theme: string | null): void {
  setThemeLocal(theme === "dark" || theme === "light" ? theme : "system");
}

function persistThemeChoice(choice: ThemeChoice): Promise<void> {
  // Serialized with every other config write (shared chain) so a rapid
  // theme flip can't clobber, or be clobbered by, a parallel config write.
  // Skips the PATCH when the value already matches.
  return updateGlobalConfigSerial((prefs) =>
    prefs.theme === choice ? null : { theme: choice },
  );
}

/** First-paint DOM sync, before any component mounts. The actual
 *  theme value comes in via the bootstrap `/api/workspace` fetch. */
export function applyInitialTheme(): void {
  applyResolvedTheme();
}

/// Preferences for a window that has no workspace to carry them. A
/// terminal-only window is served by the slim tenant, which mounts no
/// `/api/workspace`, so its settings arrive from `/api/config` instead.
/// The payload is the same `Preferences` either way: the server builds
/// one `PreferencesView` for both routes.
const standalonePreferences = $state<{ current: Preferences | null }>({
  current: null,
});

/// The effective global preferences for this window, whichever kind it is.
/// Read this rather than `workspace.info?.preferences` from any surface a
/// terminal-only window also renders, or that surface silently falls back
/// to its defaults in a standalone terminal.
export function currentPreferences(): Preferences | null {
  return workspace.info?.preferences ?? standalonePreferences.current;
}

export function __testSetStandalonePreferences(prefs: Preferences | null): void {
  standalonePreferences.current = prefs;
}

/// Load the global preferences for a workspace-less window from /api/config.
/// Best-effort: a window that cannot read its settings still runs its
/// terminal on defaults, which is what it did before it asked at all.
/// Deliberately does NOT run `applyServerPreferences`. That mirror is for a
/// workspace window: it would switch the docked file browsers back on from the
/// persisted value, and this window has just forced them off because the slim
/// tenant serves no `/api/files`, and it would fight the launcher's
/// `local-theme` choice that a standalone terminal follows instead of the
/// config theme. The terminal reads what it needs through `currentPreferences`.
async function refreshStandalonePreferences(): Promise<void> {
  try {
    standalonePreferences.current = (await api.config()).preferences;
  } catch {
    // Left as-is rather than cleared: a failed refresh should not throw away
    // preferences that are already applied and still correct.
  }
}

/** Mirror server preferences (theme, pane widths) into local state.
 *  Called on boot once `workspace.info` is set, and again on every
 *  `config_changed` WS event. */
export function applyServerPreferences(): void {
  const prefs = workspace.info?.preferences;
  if (!prefs) return;
  if (prefs.theme && prefs.theme !== ui.themeChoice) {
    setThemeLocal(prefs.theme);
  }
  applyHybridSurfaceThemes(prefs.hybrid_surface_themes);
  if (prefs.pane_widths) {
    paneWidths.inspector = prefs.pane_widths.inspector;
    paneWidths.graph = prefs.pane_widths.graph;
    paneWidths.browser = prefs.pane_widths.browser;
    // Server hands back PaneWidths.search via #[serde(default)], so
    // older preferences.toml without the field still arrives with a
    // valid number rather than `undefined`.
    paneWidths.search = prefs.pane_widths.search ?? DEFAULT_PANE_WIDTHS.search;
    // Older servers don't ship `outline`; fall back to the default
    // so the file-editor outline pane has a sane width on first use.
    paneWidths.outline = prefs.pane_widths.outline ?? DEFAULT_PANE_WIDTHS.outline;
  }
  if (prefs.browser_side_panes) {
    browserSidePanes.left = prefs.browser_side_panes.left;
    browserSidePanes.right = prefs.browser_side_panes.right;
  }
  applyEditorToolPreferences(prefs);
  hydratePageWidthFromPrefs(prefs.page_width_ratio, prefs.overlay_maximized);
  // Load the keymap overrides so chordFor + the dispatch resolve the user's
  // assignments; re-runs on every config_changed for cross-window refresh.
  hydrateOverrides(prefs.shortcuts);
}

/** Subscribe to OS-level color-scheme changes. While the user is in
 *  "system" mode, OS toggles flip the editor live; for explicit
 *  "light"/"dark" the listener is a no-op. */
export function watchSystemTheme(): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    if (ui.themeChoice !== "system") return;
    ui.theme = systemTheme();
    applyResolvedTheme();
  };
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}

/// The live watcher socket handle. Callable as the disposer (the
/// existing reconnect/teardown call sites use `unwatch()`); the
/// `subscribeDir` / `unsubscribeDir` methods are the per-directory
/// scope-subscription path the File Browser and Graph surfaces use.
/// `watchSubscription()` exposes it to those surfaces
/// without re-opening a second socket.
let unwatch: WatchSubscription | null = null;

// Push the per-window active-transfer count to the server over the window `/ws`
// whenever the transfer model's count changes. The sink reads the live
// `unwatch` each call, so it always targets the current (reconnecting) socket;
// `onWatchReady` re-announces the count on every (re)connect.
setTransferSignalSink((active) => unwatch?.reportTransfers(active));

/// Accessor for the live watcher subscription so File Browser / Graph
/// instances can push `sub` / `unsub` frames for the directories they
/// have expanded. Returns null before bootstrap opens the socket and
/// after teardown. The per-instance subscription bookkeeping (refcount
/// across instances) lives client-side in the FB instance registry
/// (`fbTreeInstances`) and is mirrored to the server, which keeps its
/// own per-socket refcount.
export function watchSubscription(): WatchSubscription | null {
  return unwatch;
}

/// Paths currently mid-rename. The watcher fires "Renamed" events
/// while `api.move` is still awaiting, which races with our own
/// `rekeyTabsForRename` call: `tabsForPath(oldPath)` still matches
/// (tabs haven't been rekeyed yet), the resulting `refreshTabFromDisk`
/// tries to load the now-gone old path and stamps a stale "io error:
/// No such file" onto the tab. Adding both endpoints to this Set
/// before `api.move` and clearing them after the rekey lets the
/// watcher handler skip the refresh for paths it would have raced.
const movingPaths = new Set<string>();

function markOpenFileTabsMissing(): void {
  for (const node of Object.values(layout.nodes)) {
    if (node.kind !== "leaf") continue;
    for (const tab of allPaneTabs(node)) {
      if (tab.kind === "file" && !tab.fileMissing) {
        // markTabFileMissing retains both `content` and `saved`; a dirty
        // editor therefore remains recoverable while its backing path is gone.
        markTabFileMissing(tab.id);
      }
    }
  }
}

async function reconcileWorkspaceRootAvailability(): Promise<void> {
  try {
    await refreshTree();
  } catch (error) {
    if (isWorkspaceRootMissingError(error)) {
      markOpenFileTabsMissing();
    }
    // The File Browser owns the persistent error state. Watch delivery is
    // best-effort and must not create an unhandled rejection for either a
    // terminal root loss or a transient provider failure.
  }
}

/// Watcher event handler. Extracted so reconnectWatcher() can reuse
/// the exact same callbacks as bootstrap().
export function onWatchEvent(e: unknown): void {
  ui.lastWatch = Date.now();
  // The /ws stream carries multiple frame types under different
  // `type` discriminators (see chan-server/src/bus.rs). Watch
  // events fall through to the legacy path below; progress events
  // route to the indexer-status sink so the bottom-left status pill
  // animates live as `Workspace::reindex_with` walks the workspace.
  const frameType = (e as { type?: string } | null)?.type;
  if (frameType === "window_command") {
    void handleWindowCommand(e);
    return;
  }
  if (frameType === "progress") {
    applyProgressEvent(
      (e as { event?: ProgressFrame } | null)?.event ?? null,
    );
    return;
  }
  if (frameType === "transfer_queue") {
    // Server-authoritative admission state for one of THIS window's transfers.
    // Routing is server-side by window id, so the frame is not re-checked here;
    // it is matched to a local record by transfer id alone, and an id we do not
    // know is dropped.
    applyTransferQueueFrame(
      e as { transfer_id: string; state: "waiting" | "active"; position?: number },
    );
    return;
  }
  if (frameType === "terminal_roster") {
    // Cross-window terminal roster snapshot. Full snapshot, so
    // apply wholesale; feeds the broadcast menu + indicator for terminals
    // in other windows of this tenant.
    applyTerminalRoster(
      (e as { sessions?: TerminalRosterEntry[] } | null)?.sessions ?? [],
    );
    return;
  }
  if (frameType === "session_roster") {
    // Leader/followers snapshot for this tenant. Full snapshot, applied
    // wholesale; drives the handover overlay's leader/self awareness.
    applySessionRoster(
      (e as { participants?: SessionParticipant[]; leader?: string | null } | null) ?? {},
    );
    // Peer caret name flags resolve through this roster; restamp any
    // bound editors so a rename swaps flag text without flashing it.
    docSyncRosterChanged();
    // Scene collaborator labels resolve through the same roster.
    sceneSyncRosterChanged();
    return;
  }
  const kind = (e as { kind?: string } | null)?.kind;
  if (kind === "config_changed") {
    // A sibling window flipped a setting (theme, fonts,
    // pane widths). Re-fetch and reflect.
    scheduleWorkspaceRefresh();
    return;
  }
  if (kind === "session_changed") {
    // A co-viewer of this `?w=` wrote the shared session blob. Filter +
    // refetch + reconcile live in the session-sync section below.
    onSessionChangedFrame(
      e as { w?: string; client?: string; deleted?: boolean },
    );
    return;
  }
  // Filesystem event from chan-server's WatchBroadcast. Server-side
  // dedupe already drops echoes of our own writes (1500 ms window),
  // so anything that lands here is an actual external edit.
  //
  // Two reactions:
  //   1. Refresh the tree + workspace payload (file set / preferences
  //      may have changed).
  //   2. Flag the external change on any open tab pointing at the
  //      changed path (the dismissable "changed on disk" banner).
  //      The buffer is never silently reloaded: that would replace
  //      the doc and snap the caret mid-edit, and the next save's CAS
  //      check surfaces real conflicts via ConflictModal anyway.
  // Scope the FB tree refresh to the path that changed instead of
  // re-fetching the root listing on every event. Each FB instance
  // contributes a scope (from its selection); we touch the tree
  // only when an event lands inside at least one active scope,
  // and we touch only the affected dir.
  const innerForScope = (e as { event?: { kind?: string; path?: string; to?: string } } | null)
    ?.event;
  const providerLost = innerForScope?.kind === "ProviderError";
  const rootRemoved =
    innerForScope?.kind === "Removed" &&
    innerForScope.path === "" &&
    (innerForScope as { is_dir?: unknown }).is_dir === true;
  const watchedPaths = providerLost
    ? []
    : [innerForScope?.path, innerForScope?.to].filter(
        (p): p is string => typeof p === "string" && p.length > 0,
      );
  if (rootRemoved || providerLost) {
    void reconcileWorkspaceRootAvailability();
  }
  const scopes = activeFbScopes();
  const inScope = watchedPaths.some((p) => pathInAnyScope(p, scopes));
  if (inScope) {
    for (const p of watchedPaths) {
      void refreshTreeForPath(p);
    }
  }
  scheduleWorkspaceRefresh();
  // Tags / wiki-links / mentions may have changed. Invalidate the
  // cached graph so the next inspector view sees fresh data, and if
  // an overlay is currently open re-fetch eagerly so the user sees
  // updates without re-clicking. The fetch is idempotent and
  // de-duped via `ensureGraphLoaded`.
  invalidateGraph();
  if (hasBrowserTab() || hasGraphTab()) {
    void ensureGraphLoaded();
  }
  if (hasGraphTab()) {
    // Carry the touched path(s) so each open graph reloads only when the
    // change is in ITS scope (GraphPanel path-filters the signal). An
    // empty set means the event carried no path -> reload to stay safe.
    graphReloadSignal.paths = watchedPaths;
    graphReloadSignal.nonce += 1;
  }
  const inner = (e as { event?: { kind?: string; path?: string; to?: string } } | null)?.event;
  const paths = [inner?.path, inner?.to].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  // The server stats the live user-write bit onto every watch frame:
  // chmod flips no mtime, so the reconciler and the banner path both
  // ignore it, and this is the only channel that keeps fsWritable (the
  // locked lamp, the editor's readOnly) in step with OS permissions.
  const frameWritable = (e as { writable?: unknown } | null)?.writable;
  for (const p of paths) {
    // Skip watcher echoes for paths we're actively renaming: the
    // tab still holds the old path during the move's `await`, and a
    // refresh would read a vanished file and stamp a stale error.
    if (movingPaths.has(p)) continue;
    for (const { tabId } of tabsForPath(p)) {
      if (typeof frameWritable === "boolean") applyFsWritable(tabId, frameWritable);
      if (
        (inner?.kind === "Removed" || inner?.kind === "Renamed") &&
        p === inner.path
      ) {
        // Atomic-write patterns (temp + rename) make the file
        // vanish for a few ms before reappearing under the same
        // name; chan-server's self-write dedupe usually suppresses
        // the echo but races leak through, and external editors
        // skip the dedupe entirely. Debounce the missing check so
        // the panel doesn't flash for files that come right back.
        scheduleMissingFileCheck(tabId, p);
        continue;
      }
      // A Created / Modified frame after a missing-check was
      // scheduled means the file is back; cancel the pending check.
      // Do NOT silently reload the open doc: that replaces the buffer
      // and snaps the caret to line 1, col 1 mid-edit. Flag the
      // external change so the editor shows the dismissable "changed on
      // disk" banner instead.
      cancelMissingFileCheck(tabId);
      flagExternalChange(tabId);
    }
  }
}

type WindowCommandDestination = {
  pane_id?: string | null;
  side?: PaneSide | null;
};

type DestinationWindowCommand = {
  destination?: WindowCommandDestination | null;
};

type WindowCommandFrame =
  | ({
      type: "window_command";
      window_id: string;
      command: "open_file";
      path: string;
    } & DestinationWindowCommand)
  | ({
      type: "window_command";
      window_id: string;
      command: "open_browser";
      path: string;
      select?: string | null;
      enter?: boolean | null;
    } & DestinationWindowCommand)
  | ({
      type: "window_command";
      window_id: string;
      command: "open_graph";
      path?: string | null;
      is_dir?: boolean | null;
    } & DestinationWindowCommand)
  | ({
      type: "window_command";
      window_id: string;
      command: "open_graph_link";
      link: string;
    } & DestinationWindowCommand)
  | ({
      type: "window_command";
      window_id: string;
      command: "open_term_new";
      cwd?: string | null;
      tab_name?: string | null;
      tab_group?: string | null;
    } & DestinationWindowCommand)
  | ({
      type: "window_command";
      window_id: string;
      command: "open_dashboard";
      carousel_index?: number | null;
      carousel_off?: boolean;
    } & DestinationWindowCommand)
  | {
      type: "window_command";
      window_id: string;
      command: "upload";
      // Workspace-relative target directory ("" = workspace root).
      path: string;
    }
  | {
      type: "window_command";
      window_id: string;
      command: "download";
      // Workspace-relative file/dir path ("" = workspace root).
      path: string;
      // Server-resolved (the SPA names the download / a dir downloads as a zip).
      is_dir: boolean;
    }
  | {
      type: "window_command";
      window_id: string;
      // `cs tunnel`: forwarded to the native host, which resolves the
      // devserver to dial from this window's own connection record.
      command: "tunnel_open";
      tunnel_id: string;
      proto: string;
      bind_addr: string;
      desktop_port: number;
      devserver_port: number;
    }
  | {
      type: "window_command";
      window_id: string;
      command: "open_survey";
      survey: SurveySpec;
      // The target terminal's name (the survey's `--tab-name`), camelCase
      // per the survey contract. Present => attach to that
      // terminal only; absent/null => the window-wide fallback.
      tabName?: string | null;
    }
  | {
      type: "window_command";
      window_id: string;
      command: "close_survey";
      surveyId: string;
      reason: SurveyCloseReason;
      // Present for tab-targeted surveys. Omitted for tab-group surveys, which
      // render as the window-wide slot in each targeted window.
      tabName?: string | null;
    }
  | {
      type: "window_command";
      window_id: string;
      command: "pane_query";
      request_id: string;
    }
  | {
      type: "window_command";
      window_id: string;
      command: "pane_exec";
      request_id: string;
      op: PaneExecOp;
    }
  | ({
      type: "window_command";
      window_id: string;
      command: "team_spawned";
      group: string;
      members: { tab_name: string; session_id: string }[];
    } & DestinationWindowCommand)
  | {
      type: "window_command";
      window_id: string;
      command: "terminal_broadcast";
      session_id: string;
      on: boolean;
    }
  | {
      type: "window_command";
      window_id: string;
      command: "handover_prompt";
      request_id: string;
      from_window_id: string;
      from_name?: string | null;
    }
  | {
      type: "window_command";
      window_id: string;
      command: "clipboard_write";
      request_id: string;
      // The clipboard MIME (text/plain;charset=utf-8, text/html, image/png).
      mime: string;
      // base64 of the raw bytes to write.
      data_b64: string;
    }
  | {
      type: "window_command";
      window_id: string;
      command: "clipboard_read";
      request_id: string;
      // Which representation to emit: auto (image-first) | text | html | image.
      prefer: "auto" | "text" | "html" | "image";
    }
  | {
      type: "window_command";
      window_id: string;
      // `cs export` (Contract B): render `path` with the exporter for
      // `format`, upload to `out`, reply via /api/window/reply with `id`.
      command: "export-job";
      id: string;
      path: string;
      format: string;
      out: string;
    }
  // The session leader discarded / hid this window from the launcher; the
  // server targets the affected window's own socket. No payload.
  | { type: "window_command"; window_id: string; command: "window_discarded" }
  | { type: "window_command"; window_id: string; command: "window_hidden" };

function resolveWindowCommandDestination(
  frame: DestinationWindowCommand,
): ResolvedTabDestination | null {
  const raw = (frame as { destination?: unknown }).destination;
  if (
    raw !== undefined &&
    raw !== null &&
    (typeof raw !== "object" || Array.isArray(raw))
  ) {
    setTransientStatus("placement failed: invalid destination");
    return null;
  }
  const destination = raw as WindowCommandDestination | null | undefined;
  const paneId = destination?.pane_id;
  if (paneId !== undefined && paneId !== null && (typeof paneId !== "string" || !paneId)) {
    setTransientStatus("placement failed: invalid pane");
    return null;
  }
  const side = destination?.side;
  if (side !== undefined && side !== null && side !== "a" && side !== "b") {
    setTransientStatus("placement failed: side must be a or b");
    return null;
  }
  const resolved = resolveTabDestination({
    paneId: paneId ?? undefined,
    side: side ?? undefined,
  });
  if (!resolved) {
    const requestedPane = paneId ?? layout.activePaneId;
    setTransientStatus(`placement failed: no such pane ${requestedPane}`);
  }
  return resolved;
}

/// A tab's display title for `cs pane`: a file tab's basename, else its
/// explicit `title`.
function paneTabTitle(tab: Tab): string {
  return tab.kind === "file" ? (tab.path.split("/").pop() ?? tab.path) : tab.title;
}

/// The close-blocker for a tab, or null when it closes freely. A non-null
/// reason means `cs pane close*` needs `--force`: an unsaved file or a live
/// terminal. Mirrors the query's `dirty` / `live` flags from public fields.
/// For a tab attached to a live doc session, `content !== saved` means
/// "local edits the authority has not confirmed yet" (tab.saved tracks the
/// confirmed shadow), which is exactly what should block an unforced close.
function paneCloseBlock(tab: Tab): string | null {
  if (tab.kind === "file" && tab.content !== tab.saved) return "unsaved changes";
  if (tab.kind === "terminal" && tab.terminalSessionId) return "live terminal";
  return null;
}

/// Build a `cs pane` snapshot of one tab: its kind + title, whether it is
/// the pane's active tab, and the close-blocker flags the CLI surfaces
/// (`dirty` for an unsaved file, `live` for a running terminal).
function paneQueryTab(
  tab: Tab,
  activeTabId: string | null,
): { id: string; kind: string; title: string; active: boolean; dirty?: boolean; live?: boolean } {
  const snap: {
    id: string;
    kind: string;
    title: string;
    active: boolean;
    dirty?: boolean;
    live?: boolean;
  } = {
    id: tab.id,
    kind: tab.kind,
    title: paneTabTitle(tab),
    active: tab.id === activeTabId,
  };
  // For attached tabs `saved` is the doc session's confirmed shadow, so
  // `dirty` reads as "unconfirmed local edits" (sub-second transient);
  // for classic tabs it stays "unsaved against disk".
  if (tab.kind === "file") snap.dirty = tab.content !== tab.saved;
  if (tab.kind === "terminal") snap.live = !!tab.terminalSessionId;
  return snap;
}

/// All leaf (real, non-split) panes in the live layout.
function paneLeaves(): LeafNode[] {
  return Object.values(layout.nodes).filter((n): n is LeafNode => n.kind === "leaf");
}

/// Resolve a `cs pane` op's target pane: `paneId` when given, else the
/// active pane. Null when it does not resolve to a leaf pane.
function paneByIdOrActive(paneId: string | null | undefined): LeafNode | null {
  const id = paneId ?? layout.activePaneId;
  const node = layout.nodes[id];
  return node && node.kind === "leaf" ? node : null;
}

/// The `op` payload of a `pane_exec` window_command (internally tagged on
/// `kind`, mirroring the wire `PaneOp`).
type PaneExecOp =
  | { kind: "focus"; pane_id: string; side?: PaneSide | null }
  | { kind: "split"; pane_id?: string | null; dir: "right" | "bottom" }
  | { kind: "resize"; pane_id?: string | null; delta: number }
  | { kind: "equalize"; pane_id?: string | null }
  | { kind: "swap"; pane_id?: string | null; other_pane_id: string }
  | { kind: "close_tab"; pane_id?: string | null; tab_id?: string | null; force?: boolean }
  | { kind: "close_pane"; pane_id?: string | null; force?: boolean }
  | { kind: "close_all"; force?: boolean };

type PaneExecResult = {
  ok: boolean;
  summary: string;
  blocked: { tab: string; reason: string }[];
  paneId?: string;
  activeSide?: PaneSide;
};

/// Apply a `cs pane` exec op to the live `layout` and return the result the
/// CLI prints. Focus / split / resize mutate the layout directly; close ops
/// pre-check the dirty/live blocker on PUBLIC fields and, without `force`,
/// report the blocked tabs instead of closing (no UI dialog, since this is
/// a scripted command). With `force`, `closeTab`/`closePane` run with
/// `{ force: true }` so the SPA's own confirm is bypassed.
async function applyPaneExec(op: PaneExecOp): Promise<PaneExecResult> {
  const blocked: { tab: string; reason: string }[] = [];
  switch (op.kind) {
    case "focus": {
      const p = paneByIdOrActive(op.pane_id);
      if (!p) return { ok: false, summary: `no such pane ${op.pane_id}`, blocked };
      focusPane(p.id, op.side ?? undefined);
      return {
        ok: true,
        summary: `focused pane ${p.id}`,
        blocked,
        paneId: p.id,
        activeSide: paneSide(p),
      };
    }
    case "split": {
      const p = paneByIdOrActive(op.pane_id);
      if (!p)
        return { ok: false, summary: `no such pane ${op.pane_id ?? layout.activePaneId}`, blocked };
      const paneId = splitPane(
        p.id,
        op.dir === "right" ? "row" : "column",
        "after",
      );
      if (!paneId) return { ok: false, summary: "split limit reached", blocked };
      if (ui.terminalOnly) openTerminalInPane(paneId);
      return {
        ok: true,
        summary: `split pane ${p.id} ${op.dir}`,
        blocked,
        paneId,
        activeSide: "a",
      };
    }
    case "resize": {
      const p = paneByIdOrActive(op.pane_id);
      if (!p)
        return { ok: false, summary: `no such pane ${op.pane_id ?? layout.activePaneId}`, blocked };
      const ratio = resizePane(p.id, op.delta);
      if (ratio === null)
        return { ok: false, summary: `no such pane ${p.id}`, blocked };
      if (layout.rootId === p.id)
        return { ok: true, summary: "single pane, nothing to resize", blocked };
      return { ok: true, summary: `resized pane ${p.id} (ratio ${ratio.toFixed(2)})`, blocked };
    }
    case "equalize": {
      const p = paneByIdOrActive(op.pane_id);
      if (!p)
        return { ok: false, summary: `no such pane ${op.pane_id ?? layout.activePaneId}`, blocked };
      equalizePane(p.id);
      return {
        ok: true,
        summary: layout.rootId === p.id
          ? "single pane, nothing to equalize"
          : `equalized pane ${p.id}`,
        blocked,
      };
    }
    case "swap": {
      const source = paneByIdOrActive(op.pane_id);
      if (!source)
        return { ok: false, summary: `no such pane ${op.pane_id ?? layout.activePaneId}`, blocked };
      const other = paneByIdOrActive(op.other_pane_id);
      if (!other)
        return { ok: false, summary: `no such pane ${op.other_pane_id}`, blocked };
      if (!swapPanes(source.id, other.id)) {
        return { ok: false, summary: "source and destination panes must differ", blocked };
      }
      return {
        ok: true,
        summary: `swapped panes ${source.id} and ${other.id}`,
        blocked,
        paneId: other.id,
        activeSide: paneSide(other),
      };
    }
    case "close_tab": {
      const p = paneByIdOrActive(op.pane_id);
      if (!p)
        return { ok: false, summary: `no such pane ${op.pane_id ?? layout.activePaneId}`, blocked };
      const tabId = op.tab_id ?? paneActiveTabId(p);
      const tab = tabId ? allPaneTabs(p).find((t) => t.id === tabId) : undefined;
      if (!tab) return { ok: false, summary: "no tab to close", blocked };
      const reason = paneCloseBlock(tab);
      if (reason && !op.force) {
        blocked.push({ tab: paneTabTitle(tab), reason });
        return { ok: false, summary: "blocked 1 tab", blocked };
      }
      await closeTab(p.id, tab.id, { force: true });
      return { ok: true, summary: "closed 1 tab", blocked };
    }
    case "close_pane": {
      const p = paneByIdOrActive(op.pane_id);
      if (!p)
        return { ok: false, summary: `no such pane ${op.pane_id ?? layout.activePaneId}`, blocked };
      collectBlocks(allPaneTabs(p), op.force, blocked);
      if (blocked.length)
        return { ok: false, summary: `blocked ${blocked.length} tab(s)`, blocked };
      await closePane(p.id, { force: true });
      return { ok: true, summary: `closed pane ${p.id}`, blocked };
    }
    case "close_all": {
      const panes = paneLeaves();
      for (const p of panes) collectBlocks(allPaneTabs(p), op.force, blocked);
      if (blocked.length)
        return { ok: false, summary: `blocked ${blocked.length} tab(s)`, blocked };
      let closed = 0;
      for (const id of panes.map((p) => p.id)) {
        const node = layout.nodes[id];
        if (node && node.kind === "leaf") {
          closed += allPaneTabs(node).length;
          await closePane(id, { force: true });
        }
      }
      return { ok: true, summary: `closed ${closed} tab(s)`, blocked };
    }
  }
}

/// Append each blocked tab in `tabs` (a dirty/live tab without `force`) to
/// `blocked`. A no-op when `force` is set.
function collectBlocks(
  tabs: Tab[],
  force: boolean | undefined,
  blocked: { tab: string; reason: string }[],
): void {
  if (force) return;
  for (const tab of tabs) {
    const reason = paneCloseBlock(tab);
    if (reason) blocked.push({ tab: paneTabTitle(tab), reason });
  }
}

/// Answer a `cs pane <exec>` request: apply the op to the live layout and
/// POST the result to `/api/window/reply`, unblocking the waiting CLI. A
/// thrown error is reported as a failed result rather than dropped, so the
/// CLI always gets a reply (or times out).
async function respondPaneExec(requestId: string, op: PaneExecOp): Promise<void> {
  let result: PaneExecResult;
  try {
    result = await applyPaneExec(op);
  } catch (e) {
    result = {
      ok: false,
      summary: `error: ${e instanceof Error ? e.message : String(e)}`,
      blocked: [],
    };
  }
  if (result.ok) scheduleSessionSave();
  try {
    await api.windowReply({ requestId, payload: result });
  } catch {
    // Stale/timed-out request id -> the route 404s; nothing to do.
  }
}

/// Answer a `cs pane` layout query: serialize the live `layout` (every leaf
/// pane, its tabs, which pane/tab is selected) and POST it to
/// `/api/window/reply`, which unblocks the waiting CLI. Read-only - no tab
/// or pane mutation, so no session save. The CLI may have already timed out
/// (5s) or disconnected, in which case the reply route 404s the stale id;
/// there is nothing to surface in the UI for a query, so swallow it.
async function respondPaneQuery(requestId: string): Promise<void> {
  const panes = Object.values(layout.nodes)
    .filter((n): n is LeafNode => n.kind === "leaf")
    .map((pane) => {
      const sideSnapshot = (side: PaneSide) => {
        const activeTabId = paneActiveTabId(pane, side);
        return {
          activeTabId,
          tabs: paneTabs(pane, side).map((tab) => paneQueryTab(tab, activeTabId)),
        };
      };
      return {
        id: pane.id,
        active: pane.id === layout.activePaneId,
        activeSide: paneSide(pane),
        sides: {
          a: sideSnapshot("a"),
          b: sideSnapshot("b"),
        },
      };
    });
  try {
    await api.windowReply({
      requestId,
      payload: {
        windowId: sessionWindowId(),
        activePaneId: layout.activePaneId,
        panes,
      },
    });
  } catch {
    // Stale/timed-out request id -> the route 404s; nothing to do.
  }
}

/// Answer a `cs copy`: write the pushed bytes onto the clipboard and POST an
/// `{ ok }` / `{ error }` ack to `/api/window/reply`, unblocking the waiting
/// CLI. A browser clipboard write can fail on a missing user gesture or
/// permission, so the error is reported (not swallowed) and the CLI exits
/// non-zero. Transient, no session save.
async function respondClipboardWrite(
  requestId: string,
  mime: string,
  dataB64: string,
): Promise<void> {
  let payload: { ok: true } | { ok: false; error: string };
  try {
    await writeClipboardPayload(mime, base64ToBytes(dataB64));
    payload = { ok: true };
  } catch (e) {
    payload = { ok: false, error: hintClipboardError(e) };
  }
  try {
    await api.windowReply({ requestId, payload });
  } catch (e) {
    warnUnlessStaleReply(e);
  }
}

/// Resolve a survey's target `tabName` (a terminal's `--tab-name`) to the SPA
/// tab id its per-terminal overlay renders on, or null when no terminal matches
/// (the survey then uses the window-wide fallback). The display title is the
/// server-settled live name used by every by-name operation.
function terminalSlotForName(name: string): string | null {
  const t = allTerminalTabs().find((tab) => tab.title === name);
  return t?.id ?? null;
}

function isSurveyCloseReason(value: unknown): value is SurveyCloseReason {
  return (
    value === "cancelled" ||
    value === "timed_out" ||
    value === "answered_elsewhere"
  );
}

/// Raise a file picker and upload the chosen files into `destDir`, the
/// programmatic twin of the Inspector pill's hidden `<input type=file>`: a `cs
/// upload` has no DOM input to click, so synthesize one and hand the picked
/// files to the SAME `fileOps.uploadFilesTo` the pill uses (shared
/// transfer-progress indicator). The input is detached after a pick OR a
/// cancel; an empty selection is a no-op.
///
/// On chan-desktop the synthesized input is useless: WKWebView silently drops a
/// programmatic file-input `.click()` made outside a user gesture. Rust opens
/// the native picker and streams the chosen paths directly to the upload API;
/// paths and bytes never cross webview IPC.
export function raiseUploadPicker(destDir: string): void {
  if (isTauriDesktop()) {
    void raiseDesktopUploadPicker(destDir);
    return;
  }
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.style.display = "none";
  input.addEventListener(
    "change",
    () => {
      const files = input.files;
      input.remove();
      if (files && files.length > 0) void fileOps.uploadFilesTo(destDir, files);
    },
    { once: true },
  );
  // Reclaim the detached input when the picker is dismissed without a pick
  // (the `change` event never fires on cancel).
  input.addEventListener("cancel", () => input.remove(), { once: true });
  document.body.appendChild(input);
  input.click();
}

export function raiseReplacePicker(targetPath: string): void {
  if (isTauriDesktop()) {
    void raiseDesktopReplacePicker(targetPath);
    return;
  }
  const input = document.createElement("input");
  input.type = "file";
  input.style.display = "none";
  input.addEventListener(
    "change",
    () => {
      const file = input.files?.[0];
      input.remove();
      if (file) void fileOps.replaceFileAt(targetPath, file);
    },
    { once: true },
  );
  input.addEventListener("cancel", () => input.remove(), { once: true });
  document.body.appendChild(input);
  input.click();
}

async function raiseDesktopUploadPicker(destDir: string): Promise<void> {
  try {
    const uploaded = await runDesktopUpload(
      { dir: destDir, multiple: true },
      destDir ? `Upload to ${destDir}` : "Upload files",
    );
    if (uploaded.length === 0) return;
    for (const file of uploaded) await refreshTreeForPath(file.path);
    revealAndSelect(uploaded[uploaded.length - 1]!.path);
    setTransientStatus(
      uploaded.length === 1
        ? `Uploaded '${uploaded[0]!.path}'`
        : `Uploaded ${uploaded.length} files`,
    );
  } catch (err) {
    ui.status = `upload failed: ${err instanceof Error ? err.message : String(err)}`;
    ui.statusKind = "persistent";
  }
}

async function raiseDesktopReplacePicker(targetPath: string): Promise<void> {
  try {
    const uploaded = await runDesktopUpload(
      { path: targetPath, multiple: false },
      targetPath.split("/").pop() || targetPath,
    );
    if (uploaded.length === 0) return;
    await refreshTreeForPath(targetPath);
    for (const tab of tabsForPath(targetPath)) {
      await refreshTabFromDisk(tab.tabId);
    }
    revealAndSelect(targetPath);
    setTransientStatus(`Replaced '${targetPath}'`);
  } catch (err) {
    ui.status = `upload failed: ${err instanceof Error ? err.message : String(err)}`;
    ui.statusKind = "persistent";
  }
}

async function handleWindowCommand(raw: unknown): Promise<void> {
  const frame = raw as Partial<WindowCommandFrame> | null;
  if (!frame || frame.window_id !== sessionWindowId()) return;
  if (frame.command === "window_discarded") {
    // The leader discarded this window's record (gone server-side). A native
    // desktop window is torn down by the watcher, so this overlay is web-only.
    // Stop persisting locally (no redundant DELETE) and raise the terminal
    // "closed by the leader" overlay; there is nothing to reconnect to.
    if (isTauriDesktop()) return;
    discardWindowSessionLocal();
    markWindowDiscarded();
    return;
  }
  if (frame.command === "window_hidden") {
    // The leader hid this window (its record persists, hidden). Raise the
    // "hidden by the leader" overlay; web-only for the same reason.
    if (isTauriDesktop()) return;
    markWindowHidden();
    return;
  }
  if (frame.command === "open_file" && typeof frame.path === "string") {
    const destination = resolveWindowCommandDestination(frame);
    if (!destination) return;
    // `cs open {path}` is an explicit CLI open: land at document top.
    await openInPane(destination.paneId, frame.path, {
      landAtTop: true,
      side: destination.side,
    });
    setTransientStatus(`opened ${frame.path}`);
    return;
  }
  if (frame.command === "open_browser" && typeof frame.path === "string") {
    const destination = resolveWindowCommandDestination(frame);
    if (!destination) return;
    if (frame.enter === true) {
      revealPathInBrowser(frame.path, {
        enter: true,
        inspectorOpen: true,
        destination,
      });
    } else {
      const selected = typeof frame.select === "string" ? frame.select : frame.path;
      revealPathInBrowser(selected, {
        inspectorOpen: true,
        destination,
      });
      if (typeof frame.select === "string") openMediaViewer(frame.select);
    }
    setTransientStatus(
      frame.select ? `selected ${frame.select}` : `opened ${frame.path || "/"}`,
    );
    scheduleSessionSave();
    return;
  }
  if (frame.command === "open_graph") {
    const destination = resolveWindowCommandDestination(frame);
    if (!destination) return;
    if (typeof frame.path === "string" && frame.path) {
      if (frame.is_dir) openGraphForDirectory(frame.path, destination);
      else openGraphForFile(frame.path, destination);
      setTransientStatus(`graph: ${frame.path}`);
    } else {
      openGraphForWorkspace(destination);
      setTransientStatus("opened graph");
    }
    scheduleSessionSave();
    return;
  }
  if (frame.command === "open_graph_link" && typeof frame.link === "string") {
    const destination = resolveWindowCommandDestination(frame);
    if (!destination) return;
    if (openGraphFromLink(frame.link, destination)) {
      setTransientStatus("opened graph link");
    } else {
      setTransientStatus("could not open graph link");
    }
    return;
  }
  if (frame.command === "open_term_new") {
    const destination = resolveWindowCommandDestination(frame);
    if (!destination) return;
    openTerminalInPane(destination.paneId, {
      cwd: typeof frame.cwd === "string" ? frame.cwd : undefined,
      title: typeof frame.tab_name === "string" ? frame.tab_name : undefined,
      group: typeof frame.tab_group === "string" ? frame.tab_group : undefined,
      side: destination.side,
    });
    setTransientStatus("opened terminal");
    scheduleSessionSave();
    return;
  }
  if (frame.command === "open_dashboard") {
    const destination = resolveWindowCommandDestination(frame);
    if (!destination) return;
    // Apply the server's carousel_index and/or carousel_off to the freshly
    // spawned dashboard tab. carouselSlide + autoRotate are stable
    // DashboardTab fields; --carousel-off maps to autoRotate=false.
    const slide =
      typeof frame.carousel_index === "number" && frame.carousel_index >= 0
        ? Math.floor(frame.carousel_index)
        : undefined;
    openDashboardInPane(destination.paneId, {
      slide,
      autoRotate: frame.carousel_off === true ? false : undefined,
      side: destination.side,
    });
    setTransientStatus("opened dashboard");
    scheduleSessionSave();
    return;
  }
  if (frame.command === "upload" && typeof frame.path === "string") {
    // `cs upload`: raise the SAME upload UI the Inspector pill uses -- open a
    // file picker, then hand the picked files to fileOps.uploadFilesTo (which
    // drives the shared transfer-progress indicator). Reuse, not a parallel path.
    raiseUploadPicker(frame.path);
    setTransientStatus(`upload to ${frame.path || "/"}`);
    return;
  }
  if (frame.command === "download" && typeof frame.path === "string") {
    // `cs download`: reuse the Inspector's download-with-progress action.
    fileOps.downloadPathWithProgress(frame.path, frame.is_dir === true);
    setTransientStatus(`downloading ${frame.path || "/"}`);
    return;
  }
  if (
    frame.command === "tunnel_open" &&
    typeof frame.tunnel_id === "string" &&
    typeof frame.proto === "string" &&
    typeof frame.bind_addr === "string" &&
    typeof frame.desktop_port === "number" &&
    typeof frame.devserver_port === "number"
  ) {
    // `cs tunnel`: only a native desktop can bind the listener and answer the
    // devserver over its own control socket. A browser tab has no way to
    // answer, so say so visibly instead of letting the blocked CLI time out
    // in silence.
    if (!isTauriDesktop()) {
      setTransientStatus("cs tunnel needs this window open in chan-desktop");
      return;
    }
    try {
      await openReverseTunnel({
        tunnel_id: frame.tunnel_id,
        proto: frame.proto,
        bind_addr: frame.bind_addr,
        desktop_port: frame.desktop_port,
        devserver_port: frame.devserver_port,
      });
    } catch (err) {
      // The desktop refused (udp, gateway attach, no live connection) or the
      // ACL denied. Bind failures are reported to the devserver by the native
      // side; everything else only surfaces here.
      console.warn("openReverseTunnel: open_reverse_tunnel IPC failed", err);
      setTransientStatus(
        `tunnel failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }
  if (frame.command === "open_survey" && frame.survey) {
    // `cs terminal survey` raised a survey on this window. When the frame
    // names a target terminal (`tabName`, the survey's --tab-name), attach the
    // survey to THAT terminal only; otherwise (a --tab-group broadcast, an
    // unmatched name, or a frame without tabName) fall back
    // to the window-wide overlay. Resolve the name to
    // the SPA tab id (the slot the per-terminal overlay renders on). The reply
    // round-trip (POST /api/survey/reply) unblocks the waiting CLI. No session
    // save: a survey is transient, not layout.
    const slot = frame.tabName ? terminalSlotForName(frame.tabName) : null;
    showSurvey(frame.survey, slot);
    return;
  }
  if (
    frame.command === "close_survey" &&
    typeof frame.surveyId === "string" &&
    isSurveyCloseReason(frame.reason)
  ) {
    // The server-side survey request is gone: another window answered first,
    // the timeout elapsed, or the control side cancelled. Close only the
    // matching survey overlay. A tabName keeps tab-targeted surveys per-terminal;
    // group surveys omit it and close the window-wide slot. A visible Rich
    // Prompt composer is an independent overlay, not the survey's reply surface,
    // so it is left untouched.
    const slotHint = frame.tabName ? terminalSlotForName(frame.tabName) : undefined;
    closeSurveyFromRemote(frame.surveyId, slotHint ?? undefined);
    return;
  }
  if (
    frame.command === "handover_prompt" &&
    typeof frame.request_id === "string" &&
    typeof frame.from_window_id === "string"
  ) {
    // `cs session handover`: a follower asked to take leadership and this
    // window is the leader. Raise the handover prompt; accept/reject POSTs the
    // reply that unblocks the requester. Transient, no session save.
    showHandover({
      requestId: frame.request_id,
      fromWindowId: frame.from_window_id,
      fromName: typeof frame.from_name === "string" ? frame.from_name : null,
    });
    return;
  }
  if (frame.command === "pane_query" && typeof frame.request_id === "string") {
    // `cs pane` asked this window for its tab/pane layout; serialize it and
    // POST it back to unblock the waiting CLI. Read-only, no session save.
    await respondPaneQuery(frame.request_id);
    return;
  }
  if (frame.command === "pane_exec" && typeof frame.request_id === "string" && frame.op) {
    // `cs pane <exec>` asked this window to mutate its layout; apply the op
    // and POST the result back to unblock the waiting CLI.
    await respondPaneExec(frame.request_id, frame.op);
    return;
  }
  if (frame.command === "team_spawned" && Array.isArray(frame.members)) {
    // A CLI `cs terminal team new|load` spawned a team in this window;
    // surface each member by opening a terminal tab attached to its live
    // session.
    const destination = resolveWindowCommandDestination(frame);
    if (!destination) return;
    surfaceTeamSpawn(
      typeof frame.group === "string" ? frame.group : "",
      frame.members,
      destination,
    );
    return;
  }
  if (
    frame.command === "terminal_broadcast" &&
    typeof frame.session_id === "string" &&
    typeof frame.on === "boolean"
  ) {
    // Another window's broadcast menu toggled one of THIS window's terminals
    // (group-wide Select All / per-row). Flip the local tab so the existing
    // `set-broadcast` sync + sign + fan all run unchanged.
    setTerminalBroadcastBySession(frame.session_id, frame.on);
    return;
  }
  if (
    frame.command === "clipboard_write" &&
    typeof frame.request_id === "string" &&
    typeof frame.mime === "string" &&
    typeof frame.data_b64 === "string"
  ) {
    // `cs copy` pushed bytes to write onto this window's clipboard; write them
    // and POST the ack back to unblock the CLI.
    await respondClipboardWrite(frame.request_id, frame.mime, frame.data_b64);
    return;
  }
  if (
    frame.command === "clipboard_read" &&
    typeof frame.request_id === "string" &&
    typeof frame.prefer === "string"
  ) {
    // `cs paste` asked this window for its clipboard; read it and POST the
    // bytes back to unblock the CLI.
    await respondClipboardRead(frame.request_id, frame.prefer);
    return;
  }
  if (
    frame.command === "export-job" &&
    typeof frame.id === "string" &&
    typeof frame.path === "string" &&
    typeof frame.format === "string" &&
    typeof frame.out === "string"
  ) {
    // `cs export` pushed a render job to this window; the export engine
    // (dynamic import: pdf machinery loads only when a job arrives) does
    // render -> upload -> reply.
    const { respondExportJob } = await import("../editor/pdf_export");
    await respondExportJob(
      { id: frame.id, path: frame.path, format: frame.format, out: frame.out },
      effectiveHybridSurfaceTheme("editor") === "dark" ? "dark" : "light",
    );
    return;
  }
}

/// Surface a CLI-spawned team. The server already started each PTY; open
/// a terminal tab ATTACHED to each live `session_id` (not a fresh session),
/// grouped under the team's group, so a `cs terminal team new|load` from the
/// CLI shows up in this window instead of only on the next attach. The new
/// tabs stack in the active pane.
function surfaceTeamSpawn(
  group: string,
  members: { tab_name: string; session_id: string }[],
  destination: ResolvedTabDestination,
): void {
  let opened = 0;
  for (const m of members) {
    if (!m || typeof m.session_id !== "string" || !m.session_id) continue;
    openTerminalInPane(destination.paneId, {
      sessionId: m.session_id,
      title: typeof m.tab_name === "string" && m.tab_name ? m.tab_name : undefined,
      group: group || undefined,
      side: destination.side,
    });
    opened += 1;
  }
  if (opened > 0) {
    setTransientStatus(`team: opened ${opened} terminal(s)`);
    scheduleSessionSave();
  }
}

function onWatchStatus(status: WsStatus, attempt: number): void {
  ui.ws = status;
  ui.wsAttempt = attempt;
}

/// Fires on every (re)connect of the watcher socket. The server's
/// scope registry is per-socket, so a fresh socket has no
/// subscriptions; replay every live File Browser / Graph instance's
/// desired scopes so the tree keeps receiving scoped `fs` frames after
/// a transient disconnect. The reference into `fbWatch` is resolved at
/// call time (both modules are loaded by then), so the static circular
/// import between store and fbWatch is benign.
function onWatchReady(): void {
  // Re-announce this window's active-transfer count: the server registry is
  // per-socket and a fresh socket starts at zero, so a reconnect mid-transfer
  // must re-assert the count or the close guard would think the window is idle.
  unwatch?.reportTransfers(activeTransferCount());
  fbWatchResyncAll();
  // Seed the cross-window terminal roster on every (re)connect. Live updates
  // ride `terminal_roster` `/ws` frames; this closes the window where a
  // reconnecting client would miss the last push until the next change.
  void seedTerminalRoster();
  // A reconnect may mean the server PROCESS was restarted (a remote
  // `chan devserver` bounced); detect that and reload rather than go stale.
  void checkServerInstance();
}

/// The server instance id seen on the first watch-socket connect.
/// `null` until the first successful health read.
let serverInstance: string | null = null;

/// Reload the window when the server process behind it changed.
///
/// Every watch-socket (re)connect reads `/api/health`'s `instance` (a
/// random id minted at tenant build). Same id = a transient network
/// blip; nothing to do. Different id = the process restarted: its PTYs
/// and in-memory state are gone, and without a reload the window sits
/// on a stale view with stuck terminals until a manual Cmd+R -- the
/// reload is that Cmd+R, automated. Reported against outbound remotes
/// (^C + re-run of `chan devserver`); health answers on every tenant
/// (terminal-only included), so the check applies everywhere.
/// Best-effort: a transient read failure skips until the next
/// reconnect.
async function checkServerInstance(): Promise<void> {
  try {
    const instance = (await api.health()).instance?.trim();
    if (!instance) return;
    if (serverInstance === null) {
      serverInstance = instance;
      return;
    }
    if (serverInstance !== instance) {
      // A window torn down by the leader shows a terminal overlay; reloading it
      // would reboot the discarded window into an empty layout behind the overlay.
      if (isWindowEnded()) return;
      window.location.reload();
    }
  } catch {
    // No health answer (workspace-less tenant or transient failure):
    // try again on the next reconnect.
  }
}

/// Fetch the current roster snapshot and apply it. Best-effort: a missing
/// route (older server) or transient error leaves broadcast targets as
/// local-only until the next push.
async function seedTerminalRoster(): Promise<void> {
  try {
    applyTerminalRoster(await api.terminalRoster());
  } catch {
    // Local-only broadcast targets until the next `terminal_roster` push.
  }
}

/// Tear down the existing watch subscription and start a new one.
/// Used by the disconnect overlay's manual retry button to skip the
/// reconnect backoff. Idempotent: a no-op if nothing is connected.
export function reconnectWatcher(): void {
  if (unwatch) {
    unwatch();
    unwatch = null;
  }
  unwatch = openWatchSocket(onWatchEvent, onWatchStatus, onWatchReady);
}

/// True when a bootstrap failure is transient and worth retrying:
/// the loopback server is briefly unreachable rather than returning
/// a real error. A `fetch` to a refused/dropped socket throws a bare
/// `TypeError` (not an `ApiError`); our transport maps a timeout to
/// `ApiError(0)`; a server still spinning up its routes can answer
/// 502/503/504. A 401 (missing token) or any other 4xx is NOT
/// transient and must surface immediately (the 401 path workspaces the
/// missing-token overlay). This matters on chan-desktop: WKWebView
/// can recycle a workspace window's web-content process under memory or
/// file-descriptor pressure, which reloads the SPA; if that reload
/// races the embedded server recovering, a single-shot bootstrap
/// sticks on "loading..." forever. A short bounded retry lets the
/// reloaded window heal itself instead.
function isTransientBootstrapError(e: unknown): boolean {
  if (e instanceof ApiError) {
    return e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504;
  }
  // A connection-refused / dropped-socket fetch rejects with a
  // TypeError; treat any non-ApiError throwable as transient.
  return e instanceof Error;
}

/// Initial `api.workspace()` with a short bounded retry on transient
/// loopback failures. Caps at 5 attempts with linear backoff (250ms
/// step, ~3.75s total) so a wedged-but-recovering server heals the
/// window without an indefinite spinner, while a genuine error
/// (401, 404, malformed workspace) still throws out to the bootstrap
/// catch on the first non-transient response.
async function workspaceWithRetry(): ReturnType<typeof api.workspace> {
  const maxAttempts = 5;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await api.workspace();
    } catch (e) {
      if (attempt >= maxAttempts || !isTransientBootstrapError(e)) throw e;
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
}

/// Terminal-only bootstrap. Runs when the window loaded with
/// `?kind=terminal`: the server tenant is workspace-less and serves only
/// the terminal/session/build-info routes (no `/api/workspace`,
/// `/api/files`, `/api/config`, ...), so we MUST NOT hit any
/// workspace-content endpoint or the SPA would 404 itself into an error.
///
/// We still restore the persisted window layout (`/api/session`, keyed by
/// the desktop window label) so panes/tabs of terminals come back, and we
/// still open the watcher socket (`/ws`) for the broadcast / pane bus that
/// terminals use. A local standalone terminal follows the launcher's
/// light/dark choice via the `local-theme` watch (App.svelte subscribes only
/// in terminal-only windows), falling back to the OS media query wired by
/// `watchSystemTheme()` when the launcher has set none (or on a devserver /
/// remote terminal, whose host installs no theme store).
async function bootstrapTerminalOnly(): Promise<void> {
  ui.terminalOnly = true;
  // Force the docked file browsers off: a user may have toggled one on,
  // and it would fetch `/api/files`, which the terminal tenant does not serve.
  browserSidePanes.left = false;
  browserSidePanes.right = false;
  // Settings still apply here: the terminal this window renders reads the same
  // preferences a workspace window's terminal does. The slim tenant serves
  // them from /api/config, since it mounts no /api/workspace. Failure is
  // non-fatal; the terminal falls back to its defaults rather than the window
  // refusing to boot over a settings fetch.
  await refreshStandalonePreferences();
  bootstrapHydrated = false;
  try {
    // The fresh-window marker and the layout hash both apply here: a
    // standalone terminal window may be opened fresh (empty pane) or
    // restored from its label-scoped session blob.
    const fresh = readAndConsumeFreshFlag();
    const fromHash = fresh ? null : readLayoutHash();
    try {
      const remote = fresh ? null : await api.getSession();
      // A standalone terminal window is all-terminal by definition, so its
      // reattach layout lives in the sessionStorage reload snapshot (no on-disk
      // blob); fall back to it so Cmd+R re-attaches the surviving PTYs.
      const reloadLayout = fresh ? null : readLayoutReloadSnapshot();
      if (fromHash) {
        const sessionLayout = remote
          ? isLegacyLayoutPayload(remote)
            ? remote
            : ((remote as SessionPayload).layout ?? null)
          : reloadLayout;
        await restoreLayout(fromHash, sessionLayout);
      } else if (remote) {
        if (isLegacyLayoutPayload(remote)) {
          await restoreLayout(remote);
        } else {
          await restoreSession(remote as SessionPayload);
        }
      } else if (reloadLayout) {
        await restoreLayout(reloadLayout);
      }
    } catch (e) {
      ui.status = `restore failed: ${(e as Error).message}`;
    }
  } finally {
    bootstrapHydrated = true;
  }
  // Watcher socket drives the broadcast / pane event bus terminals rely on.
  // No FB scope resync (no file browser exists in terminal mode); the
  // onWatchReady resync is a no-op when there are no browser instances.
  if (!unwatch) {
    unwatch = openWatchSocket(onWatchEvent, onWatchStatus, onWatchReady);
  }
  // No index-status poller (no `/api/index/status` route in this tenant).

  // A terminal-only window always holds at least one terminal: if nothing was
  // restored (a fresh window), open the first tab so an empty pane never
  // shows. A Cmd+R reload restores the saved layout instead and re-attaches to
  // the surviving server-side PTYs, so this only fires on a genuinely fresh
  // window.
  if (allTerminalTabs().length === 0) {
    openTerminalInActivePane({});
  }
  // Arm the close-on-last-tab watcher (App.svelte) only AFTER the first
  // terminal exists, so the transient empty boot layout can't close the window.
  ui.terminalArmed = true;
}

export async function bootstrap(): Promise<void> {
  if (ui.terminalOnly || isTerminalOnlyWindow()) {
    await bootstrapTerminalOnly();
    return;
  }
  try {
    const info = await workspaceWithRetry();
    workspace.info = info;
    applyServerPreferences();
    surfaceWorkspaceWarnings(info);
    await refreshTree();
    // Restore prior layout, in priority order:
    //   1. URL hash: explicit ad-hoc state (copy-paste a URL).
    //   2. .chan/session.json on the server: persisted via
    //      api.putSession so the same panes/tabs come back next
    //      launch.
    //   3. Empty layout: App.svelte auto-opens the file browser
    //      overlay so the user has somewhere to start.
    // Must happen before the watcher starts so we don't fire spurious
    // refreshes mid-restore. Errors are non-fatal.
    //
    // The desktop app's "New Window" menu action passes `?fresh=1`
    // so a brand-new window starts with an empty pane (and the
    // browser overlay) instead of inheriting the shared session.json.
    // The marker is consumed here and stripped from the URL so
    // reload after the fresh open behaves normally.
    const fresh = readAndConsumeFreshFlag();
    const fromHash = fresh ? null : readLayoutHash();
    bootstrapHydrated = false;
    try {
      const remote = fresh ? null : await api.getSession();
      // All-terminal windows write no on-disk blob (not durable saved windows),
      // so their reattach layout (with tsids + rich-prompt pp/rpv) lives in the
      // sessionStorage reload snapshot. Fall back to it when the server blob is
      // absent so Cmd+R re-attaches the surviving PTYs instead of spawning fresh.
      const reloadLayout = fresh ? null : readLayoutReloadSnapshot();
      if (fromHash) {
        // URL hash wins on layout (copy-pasted links must reproduce
        // tabs verbatim), but personal UI prefs like tree expansion
        // still come from session.json. The hash deliberately doesn't
        // carry these so a shared link doesn't leak the recipient's
        // directory state into the sender's session. The tsid graft sources
        // from the server blob, or the sessionStorage snapshot when absent.
        const sessionLayout = remote
          ? isLegacyLayoutPayload(remote)
            ? remote
            : ((remote as SessionPayload).layout ?? null)
          : reloadLayout;
        await restoreLayout(fromHash, sessionLayout);
        if (remote && !isLegacyLayoutPayload(remote)) {
          applySessionSidecars(remote as SessionPayload);
        }
      } else if (remote) {
        // Session payload may be the new wrapped shape OR a
        // legacy plain-layout body left over from a pre-update
        // file. Both paths restore correctly.
        if (isLegacyLayoutPayload(remote)) {
          await restoreLayout(remote);
        } else {
          await restoreSession(remote as SessionPayload);
        }
      } else if (reloadLayout) {
        // No hash and no server blob, but an all-terminal reload snapshot
        // exists: restore the layout (its tsids reattach the live PTYs).
        await restoreLayout(reloadLayout);
      }
      if (!fresh) applyTreeExpandedReloadSnapshot();
      // Restore the transfer bubble: terminal rows as-is; an in-flight transfer
      // (its XHR died with the reload) becomes "interrupted", with a Retry that
      // re-runs a download from its source (uploads cannot retry -- the File is
      // gone). Fresh windows start with no transfers.
      if (!fresh) {
        restoreTransfers(
          (source) => () => fileOps.downloadPathWithProgress(source.path, source.isDir),
        );
      }
      // Per-overlay state from the hash lands on top of any
      // session-restored knobs so a shared URL always wins. Skipped
      // in fresh windows so the New-Window menu starts truly clean.
      if (!fresh) applyOverlaysFromHash();
    } catch (e) {
      ui.status = `restore failed: ${(e as Error).message}`;
    } finally {
      bootstrapHydrated = true;
    }
    // Reopen the Team Work spawn-agents dialog if the restored layout carried a
    // pending lead terminal (#4 reload-survival). The tab ids regenerated on
    // restore, so we relocate the lead by its `teamWorkPending` flag; the dialog
    // reseeds its form from that tab's config draft. Skipped in fresh windows
    // (no restore ran). `twk` is session-only, so a shared URL never reopens it.
    if (!fresh) {
      const pendingLead = findTeamWorkPendingLead();
      if (pendingLead) openTeamDialog(pendingLead);
    }
    if (!unwatch) {
      unwatch = openWatchSocket(onWatchEvent, onWatchStatus, onWatchReady);
    }
    startIndexStatusPoller();
  } catch (e) {
    // Friendly path for the common "copied the URL without the token"
    // case: the SPA shell is static and loads fine, but the first
    // /api call comes back 401. Surface the missing-token overlay
    // instead of a terse status-bar message buried in the corner.
    if (e instanceof ApiError && e.status === 401 && authToken() === null) {
      ui.authMissing = true;
      return;
    }
    ui.status = `bootstrap failed: ${(e as Error).message}`;
  }
}

export async function refreshTree(): Promise<void> {
  tree.loading = true;
  tree.error = null;
  try {
    const entries = await api.list("");
    tree.entries = sortTreeEntries(entries);
    tree.rootUnavailable = false;
    tree.loadedDirs = { "": true };
    tree.loadingDirs = {};
    tree.dirErrors = {};
    seedTreeExpansionIfFresh();
  } catch (e) {
    tree.error = (e as Error).message;
    if (isWorkspaceRootMissingError(e)) {
      // A capability directory can read as empty after its path is unlinked.
      // The server distinguishes that case; clear every cached row here so a
      // new File Browser cannot display stale files or "No files".
      tree.entries = [];
      tree.rootUnavailable = true;
      tree.loadedDirs = { "": true };
      tree.loadingDirs = {};
      tree.dirErrors = {};
    }
    throw e;
  } finally {
    tree.loading = false;
  }
}

export async function loadTreeDir(dir: string): Promise<void> {
  if (tree.loadedDirs[dir] || tree.loadingDirs[dir]) return;
  tree.loadingDirs = { ...tree.loadingDirs, [dir]: true };
  const { [dir]: _oldError, ...restErrors } = tree.dirErrors;
  tree.dirErrors = restErrors;
  try {
    const entries = await api.list(dir);
    tree.entries = sortTreeEntries(mergeDirEntries(tree.entries, dir, entries));
    tree.loadedDirs = { ...tree.loadedDirs, [dir]: true };
  } catch (e) {
    tree.dirErrors = { ...tree.dirErrors, [dir]: (e as Error).message };
    throw e;
  } finally {
    const { [dir]: _done, ...rest } = tree.loadingDirs;
    tree.loadingDirs = rest;
  }
}

export function clearTreeLoadingForPath(path: string): void {
  const { [path]: _done, ...rest } = tree.loadingDirs;
  tree.loadingDirs = rest;
  if (Object.keys(rest).length === 0) tree.loading = false;
}

function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
}

function mergeDirEntries(
  current: TreeEntry[],
  dir: string,
  entries: TreeEntry[],
): TreeEntry[] {
  const prefix = dir ? `${dir}/` : "";
  const next = current.filter((e) => {
    if (dir && e.path === dir) return true;
    if (!e.path.startsWith(prefix)) return true;
    const rest = e.path.slice(prefix.length);
    return rest.includes("/");
  });
  const byPath = new Map(next.map((e) => [e.path, e]));
  for (const e of entries) byPath.set(e.path, e);
  return [...byPath.values()];
}

// ---- FB watcher scope -------------------------------------------------------
//
// The chan-server WS stream is single-channel and unscoped (every
// fs event for the workspace arrives at every connected SPA). We narrow
// the FB's reaction to events that land inside its current scope so
// unrelated workspace activity stops shaking the tree when the user
// is only looking at a specific directory.
//
// "Scope" is derived from the FB instance's selection:
//   * no selection (workspace root)   → "" (watch everything)
//   * selection is a directory    → that directory
//   * selection is a file         → its parent directory
//
// One FB overlay + N per-pane browser tabs contribute their scopes
// to the union. An event refreshes the tree iff at least one
// scope contains its path. Per-FB rerender isolation is bounded by
// the shared `tree.entries` state; the win is "no flicker when
// the FB scope and the event path don't intersect".

function fbScopeForSelection(selected: string | null | undefined): string {
  if (!selected) return "";
  const entry = tree.entries.find((e) => e.path === selected);
  if (entry?.is_dir) return selected;
  const slash = selected.lastIndexOf("/");
  return slash > 0 ? selected.slice(0, slash) : "";
}

/// Snapshot every open FB's current scope: the dock side panes plus
/// every browser-kind tab in any pane. Closed tabs drop out of the
/// snapshot naturally; no per-tab subscribe/unsubscribe state to leak.
export function activeFbScopes(): string[] {
  const scopes: string[] = [];
  if (browserSidePanes.left || browserSidePanes.right) {
    scopes.push(fbScopeForSelection(browserSelection.path));
  }
  for (const node of Object.values(layout.nodes)) {
    if (node.kind !== "leaf") continue;
    for (const tab of allPaneTabs(node)) {
      if (tab.kind === "browser") {
        scopes.push(fbScopeForSelection(tab.selected));
      }
    }
  }
  return scopes;
}

export function pathInAnyScope(path: string, scopes: string[]): boolean {
  for (const s of scopes) {
    if (s === "" || path === s || path.startsWith(`${s}/`)) return true;
  }
  return false;
}

/// Re-fetch the listing for the parent dir of `path` and merge it
/// into `tree.entries`. No-op when the parent dir isn't currently
/// loaded (nothing visible would change). Use `refreshTree` when
/// a full root re-fetch is needed.
export async function refreshTreeForPath(path: string): Promise<void> {
  if (isDraftPath(path)) return;
  const parent = nearestLoadedParentDir(path);
  if (parent === null) return;
  try {
    const entries = await api.list(parent);
    tree.entries = sortTreeEntries(mergeDirEntries(tree.entries, parent, entries));
  } catch {
    // Best-effort: a transient list error doesn't surface as toast;
    // the user retries on next interaction.
  }
}

function treeAncestorDirs(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const dirs: string[] = [];
  let acc = "";
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc ? `${acc}/${parts[i]}` : parts[i]!;
    dirs.push(acc);
  }
  return dirs;
}

/// Surface a freshly created draft in the file tree. Re-lists every
/// currently-loaded ancestor dir of `path` (root included) and merges the
/// result, so the drafts dir (and any visible draft subdir) appears without
/// a reload. Unlike `refreshTreeForPath`, this does NOT bail on draft paths:
/// creating a draft is exactly when the drafts dir first becomes a real
/// tree entry. Draft EDITS still skip the tree via the watcher path's
/// `refreshTreeForPath` draft-bail, so autosave doesn't shake it.
async function surfaceDraftInTree(path: string): Promise<void> {
  for (const dir of ["", ...treeAncestorDirs(path)]) {
    if (!tree.loadedDirs[dir]) continue;
    try {
      const entries = await api.list(dir);
      tree.entries = sortTreeEntries(mergeDirEntries(tree.entries, dir, entries));
    } catch {
      // Best effort; a transient list error self-heals on the next event.
    }
  }
}

export async function handleDraftPromoted(path: string): Promise<void> {
  if (isDraftPath(path)) return;
  await refreshTreeForPath(path);
  for (const dir of treeAncestorDirs(path)) {
    try {
      await loadTreeDir(dir);
    } catch {
      // Best effort; the explicit parent refresh below will retry
      // the visible directory if it is already loaded.
    }
  }
  await refreshTreeForPath(path);
  revealAndSelect(path);
  scheduleWorkspaceRefresh();
  invalidateGraph();
  if (hasBrowserTab() || hasGraphTab()) {
    void ensureGraphLoaded();
  }
  if (hasGraphTab()) {
    // A promoted draft becomes a real file at `path`; reload any graph
    // whose scope covers it (GraphPanel path-filters the signal).
    graphReloadSignal.paths = [path];
    graphReloadSignal.nonce += 1;
  }
}

registerDraftPromotionSink((path) => {
  void handleDraftPromoted(path);
});

// File-Browser operations (rename/move/delete/create) are blocked on
// draft paths on purpose: drafts are saved or discarded from editor
// tabs, not the tree. Keyed off `draftsDir()` via the shared helper.
function fileBrowserDraftsPathReason(path: string): string | null {
  if (!isDraftPath(path)) return null;
  return "Drafts are saved or discarded from editor tabs";
}

function parentDir(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : "";
}

function nearestLoadedParentDir(path: string): string | null {
  let dir = parentDir(path);
  for (;;) {
    if (tree.loadedDirs[dir]) return dir;
    if (dir === "") return null;
    dir = parentDir(dir);
  }
}

export async function noteDraftCreated(path: string): Promise<void> {
  await surfaceDraftInTree(path);
  scheduleWorkspaceRefresh();
  invalidateGraph();
  if (hasBrowserTab() || hasGraphTab()) {
    void ensureGraphLoaded();
  }
  if (hasGraphTab()) {
    // New draft at `path`; reload any graph whose scope covers it
    // (GraphPanel path-filters the signal).
    graphReloadSignal.paths = [path];
    graphReloadSignal.nonce += 1;
  }
}

export async function refreshWorkspace(): Promise<void> {
  const info = await api.workspace();
  workspace.info = info;
  applyServerPreferences();
  surfaceWorkspaceWarnings(info);
}

/// Debounced refresh of the workspace payload (preferences + name).
/// The watcher fires a burst of events on file save; we don't want
/// to hammer the server with one /api/workspace call per event.
let workspaceRefreshTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleWorkspaceRefresh(): void {
  // A terminal-only window has no workspace payload to refresh, and asking
  // the slim tenant for one is a guaranteed 404. Its settings still change,
  // though, and a `config_changed` frame arrives here, so refresh the same
  // preferences from the route that tenant does serve. Undebounced: this
  // path is driven by settings writes, not by a watcher-event burst.
  if (ui.terminalOnly) {
    void refreshStandalonePreferences();
    return;
  }
  if (workspaceRefreshTimer) return;
  workspaceRefreshTimer = setTimeout(() => {
    workspaceRefreshTimer = null;
    // Best-effort background refresh fired from a watcher-event burst: swallow
    // a transient failure (the next event reschedules) so a rejected
    // api.workspace() never escapes as an unhandled promise rejection.
    refreshWorkspace().catch(() => {});
  }, 250);
}

// ---- URL hash bridge for layout + UI persistence ------------------------
//
// Every visible surface round-trips through the URL hash so a
// copy-paste of the address bar reproduces the same screen on
// another browser: pane / tab tree under `s`, plus a per-overlay
// key (`files`, `search`, `graph`, `settings`). Presence of an
// overlay key = that overlay is open; its value carries the scoped
// state (selected entry, query, scope+depth+filters). Settings has
// no per-overlay state so its value is just `1`.

const HASH_LAYOUT = "s";
const HASH_SIDEBAR = "c"; // "1" if collapsed, absent if expanded
const HASH_SEARCH = "search";
// The `settings`, `files`, `graph`, and `search_scope` overlay hash
// keys are no longer active. Settings is an overlay without hash state;
// graph and browser surfaces are first-class tabs that persist via the
// layout `s` key; search is workspace-wide with no scope. Old bookmarks
// with these keys degrade gracefully: they are
// not in HASH_KEYS so dropUnknownHashKeys strips them on the next write.
const HASH_KEYS = new Set([
  HASH_LAYOUT,
  HASH_SEARCH,
]);

function hashParams(): URLSearchParams {
  const h = window.location.hash;
  return new URLSearchParams(h.startsWith("#") ? h.slice(1) : h);
}

function dropUnknownHashKeys(params: URLSearchParams): void {
  for (const key of [...params.keys()]) {
    if (!HASH_KEYS.has(key)) params.delete(key);
  }
}

/// Read the `?fresh=1` URL marker (set by the desktop app's New
/// Window menu) and strip it from the address bar so a subsequent
/// reload behaves like a normal workspace load. Returns true when
/// the flag was present.
function readAndConsumeFreshFlag(): boolean {
  const url = new URL(window.location.href);
  const fresh = url.searchParams.get("fresh") === "1";
  if (fresh) {
    url.searchParams.delete("fresh");
    window.history.replaceState({}, "", url.toString());
  }
  return fresh;
}

/// Parse the layout encoding from `location.hash` (if any). Tolerant of
/// missing/malformed input.
function readLayoutHash(): ReturnType<typeof serializeLayout> {
  const raw = hashParams().get(HASH_LAYOUT);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/// Split `<flag>:<rest>` where flag is a single `0`/`1` for an
/// inspector-open bit. Returns `[bit, rest]`; if no leading flag
/// is present the bit comes back as null and the original string
/// is returned as the rest (legacy hash format).
function splitInspectorBit(raw: string): [boolean | null, string] {
  if (raw.length >= 2 && raw[1] === ":" && (raw[0] === "0" || raw[0] === "1")) {
    return [raw[0] === "1", raw.slice(2)];
  }
  return [null, raw];
}

/// Apply overlay state encoded in `location.hash`. Called from
/// bootstrap after the layout (and session payload, where
/// applicable) has been restored, so the per-overlay knobs land
/// on top of any session-persisted defaults. Each key is optional;
/// missing means "overlay stays closed".
function applyOverlaysFromHash(): void {
  const params = hashParams();
  // Graph and browser surfaces are first-class tabs restored via the
  // layout `s` key; only search reads its hash key here. Old `files=`
  // and `graph=` bookmarks are ignored and stripped on next write.
  if (params.has(HASH_SEARCH)) {
    // Encoding: `<inspectorBit>:<query>`. Both fields optional.
    const [ins, query] = splitInspectorBit(params.get(HASH_SEARCH) ?? "");
    if (ins !== null) searchPanel.inspectorOpen = ins;
    searchPanel.query = query;
    searchPanel.open = true;
  }
}

/// Trailing-debounce window for the hash write. Lighter than the
/// session save (it never touches disk) but long enough to collapse a
/// burst of layout mutations into one `history.replaceState`.
const HASH_DEBOUNCE_MS = 150;
let hashDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/// Write the current layout + overlay state to `location.hash` via
/// `history.replaceState` (so reloads are silent and the browser
/// back/forward stack stays clean). Empty values strip their key
/// entirely so a hash never grows orphans.
///
/// Synchronous + idempotent. This is the FLUSH path: the
/// pagehide/beforeunload handler calls it (via `persistLayoutToHash`)
/// expecting the write to land before the page tears down, so a
/// reload restores the exact caret. Hot reactive callers should use
/// `schedulePersistStateToHash` instead. A pending debounced write is
/// cancelled here so an explicit flush always supersedes a queued one.
export function persistStateToHash(): void {
  if (hashDebounceTimer) {
    clearTimeout(hashDebounceTimer);
    hashDebounceTimer = null;
  }
  const ser = serializeLayout();
  const url = new URL(window.location.href);
  const params = hashParams();
  // Canonicalize stale/shared links as we write our state back.
  // Unknown keys from old builds and legacy experiments are ignored
  // on restore and should not survive forever once the current app
  // has touched the URL.
  dropUnknownHashKeys(params);
  if (!ser) {
    params.delete(HASH_LAYOUT);
  } else {
    params.set(HASH_LAYOUT, JSON.stringify(ser));
  }
  // Drop the legacy sidebar-collapsed key from any pre-existing
  // saved URL hash so it doesn't sit there forever.
  params.delete(HASH_SIDEBAR);
  // ---- overlay keys: presence = open ------------------------
  // Only search is an overlay surface; graph and browser tabs persist via
  // the layout `s` key above.
  if (searchPanel.open) {
    const ins = searchPanel.inspectorOpen ? "1" : "0";
    params.set(HASH_SEARCH, `${ins}:${searchPanel.query ?? ""}`);
  } else {
    params.delete(HASH_SEARCH);
  }
  const next = params.toString();
  url.hash = next ? `#${next}` : "";
  const href = url.toString();
  // Dedup: a replaceState that wouldn't change the URL still counts
  // toward WebKit's >100-calls / 10s throttle (the SecurityError that
  // hangs the file browser on "Loading"), so skip the no-op. The
  // file-browser expansion effect re-runs on every `fbTreeInstances`
  // registry churn and recomputes the same hash each time; this
  // collapses that storm to zero writes.
  if (href === window.location.href) return;
  history.replaceState(null, "", href);
}

/// Back-compat alias used elsewhere in the tree, including the
/// synchronous pagehide/beforeunload flush, which relies on this
/// writing immediately.
export const persistLayoutToHash = persistStateToHash;

/// Debounced entry for the hot reactive callers (the file-browser
/// expansion effect, App's layout-walking effects). Coalesces a burst
/// of layout mutations into a single trailing write so the burst can't
/// trip the `history.replaceState` SecurityError. The final state is
/// still captured on exit because the pagehide handler flushes
/// synchronously via `persistLayoutToHash`.
export function schedulePersistStateToHash(): void {
  if (hashDebounceTimer) clearTimeout(hashDebounceTimer);
  hashDebounceTimer = setTimeout(() => {
    hashDebounceTimer = null;
    persistStateToHash();
  }, HASH_DEBOUNCE_MS);
}

/// Test hook for URL-hash overlay restore. The public bootstrap path
/// mixes hash, remote session, auth, and websocket startup; keeping
/// this narrow lets regression tests cover hash parsing without
/// faking the whole app lifecycle.
export const __testApplyOverlaysFromHash = applyOverlaysFromHash;

// ---- session persistence (per-window, server-side) ---------------------
//
// PUT/GET hit `<state>/sessions/<workspace-key>/<window-id>.json`. The
// payload is the layout shape from `serializeLayout()` plus a
// `treeExpanded` map (file browser directory state) and an `overlays`
// block (legacy settings/search plus graph scope). Debounced more
// than the URL-hash write since this hits the disk.
const SESSION_DEBOUNCE_MS = 750;
let sessionTimer: ReturnType<typeof setTimeout> | null = null;
let lastSessionSnapshot: string | null = null;
let bootstrapHydrated = true;
// Explicit window-discard intent. Once a window is discarded (^W/^D to empty,
// the close-window action when a devserver is not connected, or an empty
// window), its saved blob is deleted and never re-written, so the window
// disappears from `cs window list` and the server reaps its terminal sessions
// (it keys the reap on the window label, which is both the WS `window_id` and
// the blob `?w=` key). Distinct from a BURY, which keeps the blob so the
// window can be re-surfaced.
let sessionDiscarded = false;

/// Wrapped session payload. Forward-compat: missing fields fall
/// back to defaults on restore so adding a new overlay type later
/// doesn't invalidate old session.json files.
type SessionPayload = {
  /// Pane / tab tree (output of `serializeLayout()`).
  layout?: ReturnType<typeof serializeLayout>;
  /// File browser tree-expansion map.
  treeExpanded?: Record<string, boolean>;
  /// Per-overlay context. The `open` flag was intentionally
  /// dropped (overlays always start closed on launch); older
  /// session bodies may still include it and are silently
  /// ignored on read.
  overlays?: {
    graph?: {
      open?: boolean;
      scopeId?: string;
      depth?: number;
      mode?: "semantic" | "filesystem" | "language";
    };
    /// Legacy fields from older session.json shapes; left here
    /// so a fresh schema doesn't reject them at read time.
    settings?: { open?: boolean };
    search?: { open?: boolean };
  };
  /// Legacy field from the deleted RecentsSheet bottom drawer.
  /// Read-but-ignore on restore so older session.json files load
  /// cleanly.
  mobileRecents?: string[];
};

function serializeSession(): SessionPayload | null {
  // An explicit window discard suppresses every save so the blob stays
  // deleted and the window leaves nothing in `cs window list`.
  if (sessionDiscarded) return null;
  const layout = serializeLayout({ terminalSessions: true });
  if (!layout) return null;
  // Durable (file / graph / browser) content OR a terminal carrying a live
  // server session to RE-ATTACH (a `tsid`): persist WITH the session ids, so a
  // close->reopen, or a chan-desktop disconnect->reconnect that re-creates the
  // WKWebView, re-attaches the live PTYs from the on-disk blob instead of
  // spawning fresh shells. (sessionStorage, the same-tab reattach channel, is
  // gone on a fresh load.) `treeExpanded` rides along only here, where there is
  // durable content to restore it into.
  //
  // An open Team Work spawn-agents dialog also forces the full session save: its
  // lead terminal may be the window's only tab and may not have connected (no
  // `tsid`) yet, which would otherwise fall to the structure-only branch below
  // and drop the dialog's `twk` config draft. Persisting the full session keeps
  // the dialog reload-survivable (#4).
  if (
    layoutHasDurableContent(layout) ||
    layoutHasReattachableTerminal(layout) ||
    teamDialogState.request !== null
  ) {
    const treeMap: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(treeExpanded.map)) {
      if (v) treeMap[k] = true;
    }
    return {
      layout,
      ...(Object.keys(treeMap).length > 0 ? { treeExpanded: treeMap } : {}),
    };
  }
  // No durable content and no live PTY -- a terminal-only or empty-split window
  // (e.g. after a restart, or a workspace off->on that killed its PTYs).
  // Persist the pane STRUCTURE so the layout survives, and recreate it with
  // FRESH shells: serialize WITHOUT session ids so restore spawns fresh PTYs
  // rather than chasing dead tsids. A truly empty single pane persists nothing.
  if (layoutHasPersistableStructure(layout)) {
    const structure = serializeLayout({ terminalSessions: false });
    if (structure) return { layout: structure };
  }
  return null;
}

async function restoreSession(p: SessionPayload): Promise<void> {
  // Apply tree-expansion + per-overlay context up front so the
  // layout restore below sees consistent state. Overlay `open`
  // flags are intentionally ignored on restore so a user who quit
  // the app with an overlay up doesn't get stuck behind it on the
  // next launch.
  applySessionSidecars(p);
  if (p.layout) {
    await restoreLayout(p.layout);
  }
}

/// Apply the non-layout slices of a session payload: file-browser
/// tree-expansion. Pulled out of `restoreSession` so the URL-hash
/// bootstrap path (which owns the layout but not the personal UI
/// prefs) can still load these from session.json. The hash is meant
/// to be shareable; directory open/closed state stays in session.json
/// regardless of where the layout came from. Graph + browser surfaces
/// are tabs persisted in the layout, not overlay-scope fields.
function applySessionSidecars(p: SessionPayload): void {
  if (p.treeExpanded && typeof p.treeExpanded === "object") {
    restoreTreeExpandedMap(p.treeExpanded);
    markTreeExpansionRestored();
  }
}

/// True when `value` looks like the legacy unwrapped layout shape
/// (a SerNode with `k`). Used to migrate old session.json bodies in
/// place without a migration step on the server.
function isLegacyLayoutPayload(value: unknown): value is ReturnType<typeof serializeLayout> {
  return (
    !!value &&
    typeof value === "object" &&
    "k" in (value as Record<string, unknown>)
  );
}

/// On the web a definite FOLLOWER window must not fire the layout-blob DELETE:
/// the session's persisted layout belongs to the leader, so a follower emptying
/// or unloading its view should not remove it. Uses isFollower (a leader exists
/// and it is not us), NOT !isLeader, so a solo or not-yet-seeded window still
/// deletes its own blob. Desktop windows always manage their own blob, so this
/// never suppresses on desktop.
function followerSuppressesSessionDelete(): boolean {
  return !isTauriDesktop() && isFollower();
}

export function scheduleSessionSave(): void {
  if (!bootstrapHydrated || sessionDiscarded) return;
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    sessionTimer = null;
    commitSessionSave();
  }, SESSION_DEBOUNCE_MS);
}

/// Serialize + persist the session now. The debounce body of
/// `scheduleSessionSave`, also fired early by the co-view sync path when
/// an inbound notify races a pending local save.
function commitSessionSave(): void {
  if (!bootstrapHydrated) return;
  const payload = serializeSession();
  // Keep the all-terminal reload-reattach snapshot current (incl. a changed
  // tsid) before the on-disk dedup short-circuits below.
  syncLayoutReloadSnapshot(payload);
  const next = payload ? JSON.stringify(payload) : "";
  if (next === lastSessionSnapshot) return;
  lastSessionSnapshot = next;
  if (!payload) {
    // Window emptied out (layout serialized to null): delete the blob
    // rather than writing an empty one, so this window stops appearing
    // as `saved` in `/api/windows` / `cs window list`. A web follower skips
    // this: the layout belongs to the leader.
    if (!followerSuppressesSessionDelete()) void api.deleteSession().catch(() => {});
  } else {
    void api.putSession(payload).catch(() => {});
  }
}

/// Fire a pending debounced session save immediately. No-op when nothing
/// is pending.
function flushPendingSessionSave(): void {
  if (!sessionTimer) return;
  clearTimeout(sessionTimer);
  sessionTimer = null;
  commitSessionSave();
}

// ---- live co-view session sync ------------------------------------------
//
// Two clients on one `?w=` share a session blob. After every successful
// blob write the server broadcasts `{"kind":"session_changed","w":...,
// "client":...}` on the tenant `/ws` bus (`"deleted":true` for a blob
// DELETE); the receiver refetches the blob and reconciles it onto the
// live tree via `reconcileLayout` (structure only; per-client view state
// never syncs). Frames echoing this window's own `client` nonce are
// dropped; a missing `client` means the writer sent no nonce and is
// treated as foreign.
const SESSION_SYNC_REFETCH_MS = 250;
let sessionSyncTimer: ReturnType<typeof setTimeout> | null = null;

function onSessionChangedFrame(frame: {
  w?: string;
  client?: string;
  deleted?: boolean;
}): void {
  // Pre-hydration frames: bootstrap fetches the freshest blob itself. A
  // discarded window is closing and must not resurrect state.
  if (!bootstrapHydrated || sessionDiscarded) return;
  if (frame.w !== sessionWindowId()) return;
  if (frame.client && frame.client === clientNonce()) return;
  if (frame.deleted) {
    // A peer deleted the blob (window discard, empty-out, or a
    // cross-window move-out). Seed the save dedupe with the CURRENT
    // serialization so a pending or trailing save of this same state
    // does not immediately re-persist the blob the peer removed (the
    // follower-resurrects-a-discarded-window quirk). Deliberately NOT a
    // hard stop: a genuinely new local mutation still saves (the user
    // is actively using this window), and the routine empty-window
    // DELETE both co-viewers fire at boot (an empty layout serializes
    // to null) can never latch the pair into a never-syncing state.
    const local = serializeSession();
    lastSessionSnapshot = local ? JSON.stringify(local) : "";
    return;
  }
  scheduleSessionSyncRefetch();
}

/// Burst-coalesced refetch, mirroring `scheduleWorkspaceRefresh`: the
/// first frame arms the timer, the rest of the burst rides it out.
function scheduleSessionSyncRefetch(): void {
  if (sessionSyncTimer) return;
  sessionSyncTimer = setTimeout(() => {
    sessionSyncTimer = null;
    // Best-effort: a transient fetch failure is repaired by the next
    // frame (every PUT notifies) or by the local save-back loop.
    void applyRemoteSessionBlob().catch(() => {});
  }, SESSION_SYNC_REFETCH_MS);
}

async function applyRemoteSessionBlob(): Promise<void> {
  if (!bootstrapHydrated || sessionDiscarded) return;
  // An inbound apply must never revert a local edit sitting in the save
  // debounce: flush the pending save FIRST (our PUT re-notifies the peer,
  // which reconciles toward it) and re-arm the refetch. The rescheduled
  // fetch then observes post-flush state: either our own blob (content
  // compare no-ops) or a genuinely newer peer write (applied; last
  // writer wins inside a debounce window).
  if (sessionTimer && !paneMode.active) {
    flushPendingSessionSave();
    scheduleSessionSyncRefetch();
    return;
  }
  const fetched = await api.getSession();
  if (!fetched) return;
  const payload: SessionPayload = isLegacyLayoutPayload(fetched)
    ? { layout: fetched }
    : (fetched as SessionPayload);
  const remoteLayout = payload.layout;
  if (!remoteLayout) return;
  // Screen before echo dedupe: once a transaction is stale, even a newer
  // snapshot that resembles its entry baseline must replace the pending one.
  if (paneModeDeferRemoteLayout(remoteLayout)) {
    // A reactive save armed before the conflict must not write the local
    // baseline back over the authoritative peer snapshot.
    if (sessionTimer) {
      clearTimeout(sessionTimer);
      sessionTimer = null;
    }
    return;
  }
  // An echo of a blob this window already carries needs no apply.
  if (JSON.stringify(fetched) === lastSessionSnapshot) return;
  applyRemoteSessionLayout(remoteLayout);
}

function applyRemoteSessionLayout(remoteLayout: SerNode): void {
  const result = reconcileLayout(remoteLayout);
  if (result === "applied") {
    // Pre-seed the save dedupe with OUR serialization of the just-applied
    // state so the trailing reactive save no-ops instead of echoing the
    // apply back to the peer.
    const local = serializeSession();
    lastSessionSnapshot = local ? JSON.stringify(local) : "";
  } else if (result === "diverged") {
    // The apply kept local-only state the remote no longer carries (a
    // dirty tab, an unattachable terminal). Push it back to the peer:
    // invalidate the dedupe snapshot and schedule the save. Leaving the
    // snapshot merely unseeded is not enough -- a keep whose net apply
    // changed nothing locally serializes identically to the last saved
    // snapshot, the reactive save dedupes to silence, and the peers sit
    // diverged until the next unrelated local mutation.
    lastSessionSnapshot = null;
    scheduleSessionSave();
  }
}

registerPaneModeSettledSink((pendingRemoteLayout) => {
  if (pendingRemoteLayout) applyRemoteSessionLayout(pendingRemoteLayout);
});

/// Discard this window's saved session: delete the blob NOW (by default the
/// server also reaps the window's live terminal sessions, keyed on the window
/// label) and stop any pending or future save from re-persisting it. The caller
/// closes the window afterward. Idempotent; fires a `keepalive` DELETE so the
/// reap survives an immediate window destroy/unload -- this is the explicit,
/// synchronous discard signal that replaces the old reliance on a `pagehide`
/// flush (which a hidden/buried WKWebView may never fire).
///
/// `reap: false` (a cross-window terminal MOVE that emptied this window): still
/// DELETE the blob so the window leaves `cs window list`, but mark it
/// (`&moved=1`) so the server does NOT reap -- the moved PTY lives on, re-bound
/// to the target window. Without this the source's synchronous DELETE can beat
/// the target's async re-attach and kill the just-moved terminal.
export function discardWindowSession(opts?: { reap?: boolean }): void {
  discardWindowSessionLocal();
  // sessionPath() always carries `?w=`, so `&moved=1` is always a valid append.
  const url = withTokenQuery(sessionPath()) + (opts?.reap === false ? "&moved=1" : "");
  try {
    void chanFetch(url, {
      method: "DELETE",
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* page is going away; nothing useful we can do */
  }
}

/// Local half of a window discard: stop this window from persisting or
/// resurrecting its session (clear the debounce, drop the reload snapshot, set
/// the discarded guard). No server call, so a follower whose record the leader
/// already removed tears down cleanly without a redundant DELETE.
export function discardWindowSessionLocal(): void {
  sessionDiscarded = true;
  if (sessionTimer) {
    clearTimeout(sessionTimer);
    sessionTimer = null;
  }
  // No Cmd+R resurrection from the sessionStorage reload snapshot either.
  writeLayoutReloadSnapshot(null);
  lastSessionSnapshot = "";
}

export function __testSetBootstrapHydrated(value: boolean): void {
  bootstrapHydrated = value;
}

export function __testResetSessionDiscarded(): void {
  sessionDiscarded = false;
}

export const __testApplyTreeExpandedReloadSnapshot = applyTreeExpandedReloadSnapshot;

export const __testIsTransientBootstrapError = isTransientBootstrapError;

/// Fire any pending session save synchronously via `fetch({ keepalive:
/// true })` so the request survives the page unload. Without this,
/// quick "expand directory; Cmd-R" cycles lose the toggle: the 750 ms
/// debounce hasn't elapsed, the page reloads, the in-flight payload
/// is discarded. Registered on `pagehide` (which also fires on bfcache
/// suspends, unlike `beforeunload`).
function flushSessionSaveOnExit(): void {
  if (!bootstrapHydrated) return;
  // A discarded window already deleted its blob synchronously; don't let the
  // exit flush re-write the blob or resurrect the reload snapshot.
  if (sessionDiscarded) return;
  if (sessionTimer) {
    clearTimeout(sessionTimer);
    sessionTimer = null;
  }
  const payload = serializeSession();
  // Persist the all-terminal reattach snapshot on exit too: a Cmd+R reload
  // reads it back; a real window close clears sessionStorage (no phantom).
  syncLayoutReloadSnapshot(payload);
  const next = payload ? JSON.stringify(payload) : "";
  if (next === lastSessionSnapshot) return;
  lastSessionSnapshot = next;
  const url = withTokenQuery(sessionPath());
  try {
    if (payload === null) {
      // Window emptied out: delete on exit so it doesn't linger as a
      // saved window. keepalive lets the request outlive the unload. A web
      // follower skips this: the layout belongs to the leader.
      if (!followerSuppressesSessionDelete()) {
        chanFetch(url, { method: "DELETE", keepalive: true }).catch(() => {});
      }
    } else {
      chanFetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: next,
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    /* page is going away; nothing useful we can do */
  }
}

/// Register the pagehide flush once. Idempotent so HMR re-evaluations
/// don't stack listeners.
let pagehideHooked = false;
export function installSessionFlushHook(): void {
  if (pagehideHooked || typeof window === "undefined") return;
  pagehideHooked = true;
  window.addEventListener("pagehide", flushSessionSaveOnExit);
}

export function teardown(): void {
  unwatch?.();
  unwatch = null;
  stopIndexStatusPoller();
}

// ---- search-index status poller -----------------------------------------

/// Latest snapshot of the indexer state. `null` until the first
/// poll completes (or if the endpoint is unreachable).
export const indexStatus = $state<{ value: IndexStatus | null }>({
  value: null,
});

/// Wire shape of a chan-workspace `ProgressEvent`, mirrored from
/// chan-workspace's `progress::ProgressEvent`. Pinned here because the
/// frontend doesn't import a generated type; the chan-server WS
/// bus.rs renders the same shape and we read it verbatim.
type ProgressFrame = {
  stage:
    | "GraphRebuild"
    | "IndexFile"
    | "EmbedBatch"
    | "RenameRewrite"
    | "Import"
    | "Reset"
    | "ModelLoad"
    | "Heartbeat";
  current: number;
  total: number;
  label: string | null;
};

/// Apply a single progress event to the live indexer status pill.
/// Two stages workspace the Building animation:
///   - GraphRebuild: per-file walk during the graph pass.
///   - IndexFile: per-file step of the BM25 + dense build.
/// Other stages (EmbedBatch, Reset, ModelLoad, Heartbeat, Import,
/// RenameRewrite) don't override the indexer status today - they
/// live in their own surfaces (import wizard, etc.). The poller
/// continues to run; on the next idle tick it resets the pill to
/// the Idle counts.
function applyProgressEvent(ev: ProgressFrame | null): void {
  if (!ev) return;
  if (ev.stage === "GraphRebuild" || ev.stage === "IndexFile") {
    indexStatus.value = {
      state: "building",
      current: ev.current,
      total: ev.total,
      file: ev.label ?? "",
    };
  }
}

/// Long-running import progress surfaced in the bottom-left status
/// bar. Set by import wizards (currently just `ImportContactsModal`)
/// while a blocking request is in flight; cleared on completion.
/// Detail (counts, errors) stays in the modal's "done" step; the
/// bar's job is to be the always-visible ambient signal that
/// something is happening, even after the user has dismissed the
/// modal or moved to another overlay.
///
/// Same pattern is intended to host other long-running surfaces
/// once they want a global "in-flight" pill.
export const importStatus = $state<{ value: { label: string } | null }>({
  value: null,
});

/// Window-level contacts import wizard state. File Browser menus and the
/// command launcher both open the same modal with a chosen default
/// directory; the wizard owns the import flow once visible.
export const importContactsPanel = $state<{
  open: boolean;
  defaultDir: string;
}>({
  open: false,
  defaultDir: "Contacts",
});

export function openImportContacts(defaultDir = "Contacts"): void {
  importContactsPanel.defaultDir = defaultDir;
  importContactsPanel.open = true;
}

export function closeImportContacts(): void {
  importContactsPanel.open = false;
}

/// Open/closed state of the content-search command palette
/// (`SearchPanel.svelte`). Toggled by Cmd/Ctrl+K and by the
/// search button in the toolbar.
export const searchPanel = $state<{
  open: boolean;
  inspectorOpen: boolean;
  /// Live query bound to the SearchPanel input. Lifted out of the
  /// component so it round-trips through the URL hash: copy-paste of
  /// a chan URL with `search=foo` lands on the same query.
  query: string;
}>({
  open: false,
  inspectorOpen: false,
  query: "",
});

// ---- command launcher overlay ------------------------------------------
//
// The inline browser launcher keeps one per-tab draft in sessionStorage. The
// accessors preserve the long-standing `.open` / `.query` API used by the
// overlay stack while the shared deck receives the complete serializable draft.
// A reload recreates this module and restores visibility, query, scope, path,
// selection, and recoverable operation state. Closing the browser tab drops it.
const LAUNCHER_DRAFT_KEY = "chan.command-launcher.v1:contextual";
export const launcherDraft = $state<DeckDraft>(
  loadSessionDeckDraft(LAUNCHER_DRAFT_KEY, "contextual"),
);

export const launcherPanel: { open: boolean; query: string } = {
  get open(): boolean {
    return launcherDraft.visible;
  },
  set open(value: boolean) {
    launcherDraft.visible = value;
    persistLauncherDraft();
  },
  get query(): string {
    return launcherDraft.query;
  },
  set query(value: string) {
    launcherDraft.query = value;
    persistLauncherDraft();
  },
};

export function persistLauncherDraft(): void {
  saveSessionDeckDraft(LAUNCHER_DRAFT_KEY, launcherDraft);
}

export function clearLauncherDraft(): void {
  const visible = launcherDraft.visible;
  Object.assign(launcherDraft, createDeckDraft("contextual"));
  launcherDraft.visible = visible;
  persistLauncherDraft();
}

/// The element that held focus when the launcher last opened. Captured
/// here (not in the component) so a command whose flow OUTLIVES the
/// launcher - Open's path dialog, cancelled - can hand focus back to
/// where the user actually was, instead of to the long-dismissed
/// launcher input. Plain module state, deliberately non-reactive.
let launcherReturnFocusEl: HTMLElement | null = null;

/// Where focus should return after a launcher-initiated flow dismisses
/// without running anything. The component reads this for its own
/// dismissal restore; command dialog flows read it for theirs.
export function launcherReturnFocus(): HTMLElement | null {
  return launcherReturnFocusEl;
}

/// Open or resume this window's launcher draft. Idempotent when already open.
/// Captures the currently-focused element for launcherReturnFocus.
export function openCommandLauncher(): void {
  launcherReturnFocusEl =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  launcherPanel.open = true;
}

/// Close the launcher. Same effect as `closeOverlay("launcher")`, so a
/// direct close and the Escape/stack route agree.
export function closeCommandLauncher(): void {
  launcherPanel.open = false;
  syncOverlayStack();
}

/// Toggle the launcher. Bound to `app.launcher.toggle`; a second
/// press closes it, matching the search chord's toggle feel.
export function toggleCommandLauncher(): void {
  if (launcherPanel.open) closeCommandLauncher();
  else openCommandLauncher();
}

// ---- settings overlay --------------------------------------------------
//
// The configuration surface: a web form over the split-store
// PreferencesView, launcher-reachable through `app.settings.open`. Its
// `.open` flag is the single source of truth for "is it on screen", so
// the shared overlay stack tracks it exactly like the launcher and
// search palettes. The form re-reads on the `config_changed` WS event,
// so a change in one window reflects in every other.
export const settingsPanel = $state<{
  open: boolean;
}>({
  open: false,
});

/// Open the settings surface. Idempotent when already open.
export function openSettings(): void {
  settingsPanel.open = true;
}

/// Close the settings surface. Same effect as `closeOverlay("settings")`,
/// so a direct close and the Escape/stack route agree.
export function closeSettings(): void {
  settingsPanel.open = false;
}

/// Toggle the settings surface, for a bound chord or the native host
/// bridge; a second press closes it.
export function toggleSettings(): void {
  if (settingsPanel.open) closeSettings();
  else openSettings();
}

// ---- graph overlay -----------------------------------------------------
//
// Open + scope picker state, plus a `depth` knob for how far the
// file/group scopes expand into their neighbors in the link graph.

/** Edge-kind / node-kind chip toggles on the graph. `link`, `tag`,
 *  `mention` are edge-kind filters (their edges plus any node only
 *  reachable through filtered-out edges drop). `img` is a node
 *  filter that hides every file node classified as an image. Lifted
 *  out of GraphPanel so the URL hash can round-trip the exact
 *  filter set. */
export type GraphFilters = {
  link: boolean;
  tag: boolean;
  mention: boolean;
  language: boolean;
  img: boolean;
  /// Directory NODE filter, applicable to filesystem graph mode where
  /// directory nodes are emitted by the backend. Frontend-only toggle
  /// - hides directory nodes (and edges touching them) without
  /// changing the backend request. Per request.md, directories as
  /// nodes often crowd a whole-workspace graph; the toggle lets the
  /// user collapse them for a cleaner view.
  folder: boolean;
  /// FileBucket toggles. Markdown chip hides file nodes with
  /// `classifyFile === "doc"` (.md / .txt); source chip hides file
  /// nodes with `classifyFile === "source"` (any recognized code /
  /// config extension). Binary file nodes don't have their own chip
  /// (they ride the absence of a more specific classification and
  /// always render). Mirrors the SPA-side file-class
  /// classification scheme; consumes the same `classifyFile` helper.
  markdown: boolean;
  source: boolean;
};

export const DEFAULT_GRAPH_FILTERS: GraphFilters = {
  link: true,
  tag: true,
  mention: true,
  language: true,
  img: true,
  folder: true,
  markdown: true,
  source: true,
};

/// Incremented by watcher events while the graph overlay is open.
/// GraphPanel consumes this as a lightweight reload signal and
/// debounces the actual `/api/graph` request locally. `paths` carries
/// the workspace-relative path(s) the event touched so each GraphPanel
/// can gate its reload on whether the change is in ITS scope: editing a
/// file that is not in the open graph must NOT reload it (without the
/// gate, any change to any file in the workspace triggered a graph
/// reload). Empty `paths` means "unknown" -> reload to stay safe.
export const graphReloadSignal = $state<{ nonce: number; paths: string[] }>({
  nonce: 0,
  paths: [],
});

function openGraphAtDestination(
  opts: OpenGraphOptions,
  destination?: ResolvedTabDestination,
): void {
  if (destination) {
    openGraphInPane(destination.paneId, { ...opts, side: destination.side });
  } else {
    openGraphInActivePane(opts);
  }
}

/** Open the graph overlay, snapping the scope to the active file
 *  when applicable. Idempotent. */
export function openGraph(): void {
  const tab = openGraphInActivePane({
    mode: "semantic",
    scopeId: defaultScopeId(),
    pendingSelectId: null,
  });
  scheduleSessionSave();
}

/** Spawn a graph tab rooted at the focused surface's context.
 *  Mirrors `paneModeOpenGraph` (which targets the Hybrid Nav draft);
 *  this variant spawns in the live layout for top-level chords
 *  (`Cmd+Shift+M`, `chan:command app.graph.toggle`). Passing a
 *  `file:` or `dir:` scope lands the new graph already scoped and
 *  the breadcrumb above the inspector body renders the ancestor
 *  chain. Falls back to workspace scope when no context is
 *  available. */
export function openGraphWithContext(ctx: SpawnContext): void {
  const scopeId = ctx.file
    ? `file:${ctx.file}`
    : ctx.dir
      ? `dir:${ctx.dir}`
      : "workspace";
  const pendingSelectId = ctx.file ?? (ctx.dir || null);
  const tab = openGraphInActivePane({
    mode: "semantic",
    scopeId,
    depth: 1,
    pendingSelectId,
  });
  scheduleSessionSave();
}

/** Open the semantic graph for the whole workspace. Workspace scope renders
 *  the full graph, so the depth knob is reset to its neutral value. */
export function openGraphForWorkspace(
  destination?: ResolvedTabDestination,
): void {
  openGraphAtDestination({
    mode: "semantic",
    scopeId: "workspace",
    depth: 1,
    pendingSelectId: null,
  }, destination);
  scheduleSessionSave();
}

/** Open the graph overlay at workspace scope and pre-select the given
 *  node so its connections render in the inspector immediately.
 *  Used by tag/mention/date chips outside the graph (file browser
 *  inspector today; conceivably the editor margin later). Workspace
 *  scope guarantees the node is in the rendered set regardless of
 *  prior scope. */
export function openGraphAtNode(nodeId: string): void {
  const tab = openGraphInActivePane({
    mode: "semantic",
    scopeId: "workspace",
    depth: 1,
    pendingSelectId: nodeId,
  });
  // Stack on top of whatever overlay invoked us (typically the
  // file browser via a tag chip). OverlayShell's z-index follows
  // `overlayStack.ids`, so the graph paints above and Escape
  // pops just the graph - returning to the browser instead of
  // dismissing both at once.
  scheduleSessionSave();
}

/** Open the graph overlay scoped to a specific file and pre-select
 *  that file's node. The file tab menu's "Show in Graph" routes
 *  here so the resulting subgraph is the file's neighbourhood, not
 *  the entire workspace - matching the user's mental model that
 *  invoking the graph FROM a file means "show me what's around
 *  THIS file". */
export function openGraphForFile(
  path: string,
  destination?: ResolvedTabDestination,
): void {
  openGraphAtDestination({
    mode: "semantic",
    scopeId: `file:${path}`,
    depth: 1,
    pendingSelectId: path,
  }, destination);
  scheduleSessionSave();
}

export function openFsGraphForFile(path: string): void {
  // "Graph from here" on a file opens the parent directory's tree so
  // the focal file lives in a meaningful neighbourhood (its cohort)
  // rather than getting lost in the whole-workspace view. Files at the
  // workspace root fall back to workspace scope.
  const slash = path.lastIndexOf("/");
  const parent = slash > 0 ? path.slice(0, slash) : "";
  const tab = openGraphInActivePane({
    mode: "filesystem",
    scopeId: parent ? `dir:${parent}` : "workspace",
    depth: 1,
    pendingSelectId: path,
  });
  scheduleSessionSave();
}

/** Open the graph overlay scoped to a directory. Depth starts at 1:
 *  all files under the directory plus their immediate graph neighbours.
 *  GraphPanel resolves the rooted directory straight from the tab's
 *  `dir:<path>` scopeId (synthesizeScope); re-rooting is "graph from
 *  here" / file-browser navigation, not a pane-derived option list. */
export function openGraphForDirectory(
  path: string,
  destination?: ResolvedTabDestination,
): void {
  openGraphAtDestination({
    mode: "semantic",
    scopeId: `dir:${path}`,
    depth: 1,
    pendingSelectId: null,
  }, destination);
  scheduleSessionSave();
}

export function openFsGraphForDirectory(path: string): void {
  // "Graph from here" on a directory scopes to that subtree directly.
  // Empty path is the workspace root, so use the "workspace" alias instead of
  // a sentinel `dir:` scope.
  //
  // Open the directory graph in SEMANTIC mode, not the
  // directories-only filesystem mode. The semantic dir-scope graph
  // carries every layer (files with their link / backlink / hashtag /
  // contact / language edges plus the directory `contains` spine), and
  // GraphPanel supports directory expand/collapse + the
  // depth-slider in semantic mode, so "Graph from here" on a directory
  // (from the file browser, mirroring the in-graph re-scope) keeps the
  // rich graph instead of collapsing to a bare directory tree.
  const tab = openGraphInActivePane({
    mode: "semantic",
    scopeId: path ? `dir:${path}` : "workspace",
    depth: 1,
    pendingSelectId: path || null,
  });
  scheduleSessionSave();
}

export function scopeFsGraphFromHere(path: string, isDir: boolean): void {
  const tab = openGraphInActivePane({
    mode: "filesystem",
    scopeId: isDir ? `dir:${path}` : `file:${path}`,
    depth: 1,
    pendingSelectId: path,
  });
  scheduleSessionSave();
}

/** Open the graph overlay scoped to a tag, with the tag node itself
 *  pre-selected. The resulting subgraph is the tag's neighbourhood
 *  (every file referencing the tag, plus their depth-limited
 *  neighbours). Called from every "click a tag chip" surface:
 *  editor tag pills, FileInfoBody's tag list, search overlay tag
 *  hits, TagInfoBody's Open-in-Graph button. */
export function openGraphForTag(nodeId: string, _label: string): void {
  const tab = openGraphInActivePane({
    mode: "semantic",
    scopeId: `tag:${nodeId}`,
    depth: 1,
    pendingSelectId: nodeId,
  });
  scheduleSessionSave();
}

/** Open the graph overlay scoped to a `@@mention`, with the mention
 *  node itself pre-selected. Mirrors `openGraphForTag`: the resulting
 *  subgraph is the mention's neighbourhood (every file referencing the
 *  handle, plus their directory spine). Called from the surfaces that
 *  click a standalone `@@name`: the inspector's unresolved-mention
 *  pill, the editor mention click on a name with no contact file, and
 *  search mention hits. The `nodeId` is the `@@Name` graph node id. */
export function openGraphForMention(nodeId: string, _label: string): void {
  const tab = openGraphInActivePane({
    mode: "semantic",
    scopeId: `mention:${nodeId}`,
    depth: 1,
    pendingSelectId: nodeId,
  });
  scheduleSessionSave();
}

/** Open the graph scoped to a contact (a Contact-kind note or a
 *  workspace file referenced by a mention). The lens centers on
 *  the contact file with edges to every doc referencing it.
 *  Title formatting flows through `graphTitle()` via the
 *  `contact:` scopeId prefix. */
export function openGraphForContact(relPath: string): void {
  openGraphInActivePane({
    mode: "semantic",
    scopeId: `contact:${relPath}`,
    depth: 1,
    pendingSelectId: relPath,
  });
  scheduleSessionSave();
}

/** Open the graph scoped to a language. The language node is a
 *  bubble connected to every file of that language; depth does not
 *  apply to language lenses, so `depth: 0` matches the
 *  language-overview convention. */
export function openGraphForLanguage(language: string): void {
  openGraphInActivePane({
    mode: "semantic",
    scopeId: `language:${language}`,
    depth: 0,
    pendingSelectId: `language:${language}`,
  });
  scheduleSessionSave();
}

/** "Copy link to graph": open a graph tab from a
 *  `chan://graph?...` link (produced by the graph command). Returns true
 *  when the link parsed and a tab was opened so
 *  the editor's link-click handler can fall through to normal handling
 *  on a non-graph href. The serialized selection rides in as
 *  `pendingSelectId` so the re-opened graph lands on the same node. */
export function openGraphFromLink(
  link: string,
  destination?: ResolvedTabDestination,
): boolean {
  const parsed = parseGraphLink(link);
  if (!parsed) return false;
  openGraphAtDestination({
    mode: parsed.mode,
    scopeId: parsed.scopeId,
    depth: parsed.depth,
    filters: parsed.filters,
    pendingSelectId: parsed.selectedNodeId,
  }, destination);
  scheduleSessionSave();
  return true;
}

// ---- file browser overlay ----------------------------------------------
//
// The file browser is a window-level overlay (not a tab), so its
// open + inspector-open state lives here. One per window; the
// inspector toggle is window-scoped now (was per-tab when the
// browser was a tab kind) since there's only ever one instance.

/// On viewports >= this width the browser inspector defaults open.
/// Below it, the inspector starts closed so a phone-sized layout
/// gets the full screen for the tree. The user can always toggle.
const BROWSER_INSPECTOR_BREAKPOINT_PX = 768;

function defaultInspectorOpen(): boolean {
  if (typeof window === "undefined") return true;
  return window.innerWidth >= BROWSER_INSPECTOR_BREAKPOINT_PX;
}

export function openBrowser(): BrowserTab {
  const tab = focusExistingBrowserTab() ?? openBrowserInActivePane();
  scheduleSessionSave();
  return tab;
}

function focusExistingBrowserTab(): BrowserTab | null {
  for (const node of Object.values(layout.nodes)) {
    if (node.kind !== "leaf") continue;
    const tab = allPaneTabs(node).find(
      (candidate): candidate is BrowserTab => candidate.kind === "browser",
    );
    if (!tab) continue;
    selectTabInPane(node.id, tab.id);
    layout.activePaneId = node.id;
    return tab;
  }
  return null;
}

/// Reveal a path by OPENING a File Browser TAB: a tab in the active
/// pane, with the path selected and its ancestor chain expanded;
/// `enter` (a directory) also expands the directory ITSELF so the
/// browser opens AT it. The per-instance `tab.expanded` is what the new
/// tab renders; the `treeExpanded` singleton is also primed so a dock
/// instance landing on the same scope agrees.
///
/// Always opens a TAB. It never focuses/targets the docked File Browser,
/// because the docked pane is not a valid reveal target (a reveal from a
/// graph tab would produce no visible tab). Uses the same
/// `openBrowserInActivePane` primitive the File Browser's own "Open
/// in File Browser" uses.
export function revealPathInBrowser(
  path: string,
  opts: {
    enter?: boolean;
    inspectorOpen?: boolean;
    destination?: ResolvedTabDestination;
  } = {},
): BrowserTab {
  const parts = path.split("/").filter(Boolean);
  // Directory (`enter`): expand itself + ancestors. File: ancestors only
  // (select the file inside its already-expanded parent).
  const upto = opts.enter ? parts.length : parts.length - 1;
  const expanded: string[] = [];
  let acc = "";
  for (let i = 0; i < upto; i++) {
    acc = acc ? `${acc}/${parts[i]}` : parts[i];
    if (acc) expanded.push(acc);
  }
  const isRoot = path === "";
  const browserOpts = {
    ...(isRoot ? {} : { select: path }),
    ...(opts.destination ? { side: opts.destination.side } : {}),
  };
  const tab = opts.destination
    ? openBrowserInPane(opts.destination.paneId, browserOpts)
    : openBrowserInActivePane(browserOpts);
  tab.inspectorOpen = opts.inspectorOpen ?? true;
  tab.showWorkspace = isRoot;
  tab.expanded = expanded.length > 0 ? expanded : undefined;
  fbSelectSingle(isRoot ? null : path);
  browserSelection.showWorkspace = isRoot;
  const map = treeExpanded.map;
  map[""] = true;
  for (const e of expanded) map[e] = true;
  persistTreeExpanded();
  scheduleSessionSave();
  return tab;
}

/// Derive the spawn anchor from the focused tab. The returned shape
/// (parent dir + optional
/// file) is what `paneModeOpenTerminal/Browser/Graph` consume so a
/// new terminal lands on the source doc's parent directory and a
/// new Graph tab can pre-select the source node.
///
/// Reads from `activeLayout()` so it sees the draft mid-Pane Mode,
/// not the committed layout - once the user moves focus to a
/// freshly-split empty pane inside the same transaction, that
/// empty pane has no context and the fallback (workspace root) kicks
/// in.
///
/// The browser branch consults the module-level `browserSelection`
/// (shared across browser tabs by design); the graph branch parses
/// `scopeId` since per-tab graph selection lives inside
/// `GraphPanel.svelte` and isn't exposed at the layout level.
export function resolveSpawnContext(): SpawnContext {
  const snapshot = activeLayout();
  const node = snapshot.nodes[snapshot.activePaneId];
  if (!node || node.kind !== "leaf") return { dir: "" };
  const tab = activeTabInPane(node);
  if (!tab) return { dir: "" };
  switch (tab.kind) {
    case "terminal":
      return { dir: tab.cwd?.trim() ?? "" };
    case "file":
      return { dir: parentDirOf(tab.path), file: tab.path };
    case "browser":
      return resolveBrowserSpawnContext();
    case "graph":
      return resolveGraphSpawnContext(tab.scopeId);
    case "dashboard":
      // Dashboard carries no path context; spawn from here lands at
      // workspace root.
      return { dir: "" };
    case "extension":
      // Extensions are external surfaces and carry no workspace path
      // context. Spawn from the workspace root.
      return { dir: "" };
  }
}

function parentDirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : "";
}

function resolveBrowserSpawnContext(): SpawnContext {
  const sel = browserSelection.path;
  if (!sel) return { dir: "" };
  // We need is_dir to know whether the selection is a file or
  // directory. The tree snapshot is authoritative; missing entries
  // (e.g. a stale selection pointing at a moved path) fall back to
  // treating it as a file so we still get a useful parent dir.
  const entry = tree.entries.find((e) => e.path === sel);
  if (entry?.is_dir) return { dir: sel };
  return { dir: parentDirOf(sel), file: sel };
}

function resolveGraphSpawnContext(scopeId: string): SpawnContext {
  if (scopeId.startsWith("file:")) {
    const file = scopeId.slice("file:".length);
    return { dir: parentDirOf(file), file };
  }
  if (scopeId.startsWith("dir:")) {
    return { dir: scopeId.slice("dir:".length) };
  }
  // "workspace", "tag:...", and any future scope shapes have no useful
  // path anchor - fall back to workspace root.
  return { dir: "" };
}

// ---- overlay z-order stack ----------------------------------------------
//
// Window-level overlays can stack: opening a second overlay while another
// is up puts the newcomer on top; Escape pops only the topmost.
//
// `overlayStack.ids` is the active z-order (last = top). App.svelte owns
// a single $effect that watches each overlay's `.open` flag and diffs
// against the stack: closed ids drop out, newly-opened ids get appended
// (so the most-recently-opened sits on top). OverlayShell renders with
// `z-index = 25000 + depth * 10` so paint order matches the stack.
//
// Escape lives in App.svelte and only closes `topOverlay()`. The
// per-shell click-on-scrim closes that shell directly; since only
// the topmost overlay is visually accessible, the scrim target is
// naturally the same as the stack top.

export type OverlayId = "search" | "launcher" | "settings";

export const overlayStack = $state<{ ids: OverlayId[] }>({ ids: [] });

/// Index of `id` in the stack, or -1 when closed. Components pass the
/// index through to OverlayShell's z-index so newer overlays paint
/// above older ones.
export function overlayDepth(id: OverlayId): number {
  return overlayStack.ids.indexOf(id);
}

/// Id of the topmost open overlay, or `null` when nothing is up. Used
/// by the window-level Escape handler to close one overlay at a time.
export function topOverlay(): OverlayId | null {
  const n = overlayStack.ids.length;
  return n === 0 ? null : overlayStack.ids[n - 1];
}

/// Close one overlay by id. Mirrors the per-shell `close()` callbacks
/// and reconciles the stack before synchronous callers can observe it.
export function closeOverlay(id: OverlayId): void {
  switch (id) {
    case "search":
      searchPanel.open = false;
      break;
    case "launcher":
      launcherPanel.open = false;
      break;
    case "settings":
      settingsPanel.open = false;
      break;
  }
  syncOverlayStack();
}

/// Diff the overlay `.open` flags into `overlayStack.ids`:
/// remove ids whose overlay is closed, append ids that opened since
/// the last run. Append-only for newcomers means the most-recently
/// opened overlay always lands on top, which matches user intent
/// when they hit a chord to surface a new tool over the current one.
/// Called by close helpers at mutation time and from the App.svelte effect as
/// a backstop for direct `.open` writes.
export function syncOverlayStack(): void {
  const open = new Set<OverlayId>();
  if (searchPanel.open) open.add("search");
  if (launcherPanel.open) open.add("launcher");
  if (settingsPanel.open) open.add("settings");
  // Drop closed entries while preserving the existing relative
  // order of those that remain.
  const kept = overlayStack.ids.filter((id) => open.has(id));
  // Append any open id that wasn't already in the stack.
  for (const id of open) {
    if (!kept.includes(id)) kept.push(id);
  }
  // Mutate only when something changed; otherwise the assignment
  // would still trigger consumers of `overlayStack.ids` even for
  // no-op runs (the effect runs on every store mutation).
  if (
    kept.length !== overlayStack.ids.length ||
    kept.some((id, i) => id !== overlayStack.ids[i])
  ) {
    overlayStack.ids = kept;
  }
}

// ---- side-panel widths --------------------------------------------------
//
// Widths of the file editor inspector, graph details, and file
// browser panels. Per-machine global preferences (mirrored from
// the global config). The right comfortable width tracks screen
// real estate rather than content, so it stays out of session.json.
// Cross-window sync rides the `config_changed` WS event.

const PANE_WIDTH_MIN = 140;
const PANE_WIDTH_MAX = 600;
const DEFAULT_PANE_WIDTHS = {
  inspector: 220,
  graph: 260,
  browser: 240,
  search: 280,
  outline: 220,
};

export const paneWidths = $state<{
  inspector: number;
  graph: number;
  browser: number;
  search: number;
  outline: number;
}>({ ...DEFAULT_PANE_WIDTHS });

export const browserSidePanes = $state<{
  left: boolean;
  right: boolean;
}>({
  // No docked File Browser by default: a new workspace opens with
  // just the empty pane.
  // chan-server's `BrowserSidePanes::default()` matches this
  // shape, so a fresh preferences.toml lands here cleanly.
  left: false,
  right: false,
});

/// Currently inspected entry in the File Browser tab. Module-level
/// (shared across browser tabs); selection is ephemeral so the
/// minor cross-tab leakage is acceptable and avoids per-tab plumbing.
/// File Browser selection. `path` is the ACTIVE/cursor entry the
/// inspector + single-target actions key off (kept for zero churn to
/// those consumers); `paths` is the full multi-selection set (the FB
/// capabilities feature: shift/cmd-click, shift+arrows, cmd+A,
/// rubber-band). Invariants the helpers below maintain:
///   - `path` is always a member of `paths`, or both are empty/null.
///   - `anchor` is the range pivot for shift-extend; it tracks the last
///     plain/cmd click (the "from" of a future shift+click range).
/// A plain click sets `paths=[path]`, `anchor=path`. Selection is
/// per-FB-instance via snapshot/restore (FileBrowserSurface);
/// dock + overlay intentionally share this singleton (workspace-wide intent).
export const browserSelection = $state<{
  path: string | null;
  paths: string[];
  anchor: string | null;
  showWorkspace: boolean;
}>({
  path: null,
  paths: [],
  anchor: null,
  showWorkspace: false,
});

/// Set the selection to a single entry (a plain click / programmatic
/// reveal). Resets the multi-set and the range anchor to that entry so a
/// subsequent shift+click ranges from here. `null` clears the selection.
export function fbSelectSingle(path: string | null): void {
  browserSelection.path = path;
  browserSelection.paths = path ? [path] : [];
  browserSelection.anchor = path;
}

/// Toggle one entry in the multi-selection (cmd/ctrl+click). The toggled
/// entry becomes the active cursor + the new range anchor; removing the
/// active entry promotes the last remaining member (or null) to active.
export function fbToggle(path: string): void {
  const set = browserSelection.paths;
  const at = set.indexOf(path);
  if (at === -1) {
    browserSelection.paths = [...set, path];
    browserSelection.path = path;
    browserSelection.anchor = path;
  } else {
    const next = set.filter((p) => p !== path);
    browserSelection.paths = next;
    // Keep a coherent cursor: if we just deselected the active entry,
    // fall back to the last remaining member.
    if (browserSelection.path === path) {
      browserSelection.path = next.length ? next[next.length - 1] : null;
    }
    browserSelection.anchor = browserSelection.path;
  }
}

/// Select the inclusive range of `ordered` (the visible-row paths, in
/// display order) between the current anchor and `path` (shift+click /
/// shift+arrow). The anchor is preserved so successive shift gestures
/// pivot from the SAME origin (desktop range semantics); `path` becomes
/// the active cursor. Falls back to a single select if there is no anchor
/// or either endpoint is off the visible list.
export function fbSelectRange(path: string, ordered: string[]): void {
  const anchor = browserSelection.anchor ?? browserSelection.path;
  if (!anchor) {
    fbSelectSingle(path);
    return;
  }
  const a = ordered.indexOf(anchor);
  const b = ordered.indexOf(path);
  if (a === -1 || b === -1) {
    fbSelectSingle(path);
    return;
  }
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  browserSelection.paths = ordered.slice(lo, hi + 1);
  browserSelection.path = path;
  // Anchor stays put: shift again pivots from the original origin.
  browserSelection.anchor = anchor;
}

/// Replace the multi-selection with `paths` (rubber-band / select-all).
/// `active` becomes the cursor (defaults to the last entry); the anchor
/// is set to the first entry so a following shift gesture has an origin.
export function fbSelectSet(paths: string[], active?: string): void {
  browserSelection.paths = paths;
  browserSelection.path = active ?? (paths.length ? paths[paths.length - 1] : null);
  browserSelection.anchor = paths.length ? paths[0] : null;
}

/// Clear the whole selection (e.g. clicking empty tree space).
export function fbClearSelection(): void {
  browserSelection.path = null;
  browserSelection.paths = [];
  browserSelection.anchor = null;
}

/// File Browser clipboard (FB2). Module-level (NOT per-instance) so a
/// copy/cut in one File Browser can be pasted into another - the spec
/// explicitly allows cross-instance paste on the same workspace. `mode`
/// distinguishes copy (duplicate) from cut (move on paste). `paths` is
/// the snapshot of the selection at copy/cut time, so a later selection
/// change does not retarget a pending paste. A cut's source rows render
/// dimmed (\"marked for move\") until the paste lands or the clipboard is
/// replaced.
export const fbClipboard = $state<{
  mode: "copy" | "cut" | null;
  paths: string[];
}>({ mode: null, paths: [] });

/// Capture the current multi-selection into the clipboard as a copy or
/// a cut. A no-op when nothing is selected.
export function fbClipboardSet(mode: "copy" | "cut", paths: string[]): void {
  if (paths.length === 0) return;
  fbClipboard.mode = mode;
  fbClipboard.paths = [...paths];
}

/// Clear the clipboard (after a successful cut+paste, or on Escape).
export function fbClipboardClear(): void {
  fbClipboard.mode = null;
  fbClipboard.paths = [];
}

/// Paste the clipboard into `destDir` (workspace-rooted POSIX, "" = root).
/// copy duplicates; cut moves (and clears the clipboard on success so a
/// second paste does not move-from-a-now-empty source). Routes through
/// POST /api/fs/transfer, which resolves name collisions to a " copy"
/// suffix and emits watcher events so every FB instance + the Graph
/// refresh. Returns the destination paths the entries landed at.
export async function fbClipboardPaste(destDir: string): Promise<string[]> {
  const mode = fbClipboard.mode;
  const sources = [...fbClipboard.paths];
  if (!mode || sources.length === 0) return [];
  const op = mode === "cut" ? "move" : "copy";
  try {
    const resp = await api.fsTransfer(op, sources, destDir);
    // A cut is a one-shot move: clear so the source can't be re-moved.
    if (mode === "cut") fbClipboardClear();
    return resp.moved.map((m) => m.to);
  } catch (err) {
    ui.status = `paste failed: ${(err as Error).message}`;
    return [];
  }
}

let widthsPersistTimer: ReturnType<typeof setTimeout> | null = null;
const PANE_WIDTHS_DEBOUNCE_MS = 200;

/// Persist the current widths. Called by ResizeHandle's onChange on
/// every drag tick; debounced so a sweep across the screen lands as
/// one PATCH instead of dozens.
export function persistPaneWidths(): void {
  if (widthsPersistTimer) clearTimeout(widthsPersistTimer);
  widthsPersistTimer = setTimeout(() => {
    widthsPersistTimer = null;
    const snapshot = {
      inspector: clamp(paneWidths.inspector),
      graph: clamp(paneWidths.graph),
      browser: clamp(paneWidths.browser),
      search: clamp(paneWidths.search),
      outline: clamp(paneWidths.outline),
    };
    void updateGlobalConfigSerial((prefs) => {
      const cur = prefs.pane_widths;
      if (
        cur &&
        cur.inspector === snapshot.inspector &&
        cur.graph === snapshot.graph &&
        cur.browser === snapshot.browser &&
        cur.search === snapshot.search &&
        cur.outline === snapshot.outline
      ) {
        return null;
      }
      return { pane_widths: snapshot };
    });
  }, PANE_WIDTHS_DEBOUNCE_MS);
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_PANE_WIDTHS.inspector;
  return Math.max(PANE_WIDTH_MIN, Math.min(PANE_WIDTH_MAX, Math.round(n)));
}

/// Persist the chosen date format so the next `@today` / `@date`
/// expansion uses it as the default. Called by the date popover's
/// format-change callback (commit path).
export function persistDateFormat(formatId: string): void {
  void updateGlobalConfigSerial((prefs) =>
    prefs.date_format === formatId ? null : { date_format: formatId },
  ).then(() => {
    // Mirror the accepted value into workspace.info so the next macro
    // expansion does not need a fresh /api/workspace round-trip.
    if (workspace.info) {
      workspace.info = {
        ...workspace.info,
        preferences: {
          ...workspace.info.preferences,
          date_format: formatId,
        },
      };
    }
  });
}

export function setBrowserSidePane(side: "left" | "right", open: boolean): void {
  if (browserSidePanes[side] === open) return;
  browserSidePanes[side] = open;
  persistBrowserSidePanes();
}

export function toggleBrowserSidePane(side: "left" | "right"): void {
  setBrowserSidePane(side, !browserSidePanes[side]);
}

function persistBrowserSidePanes(): void {
  const snapshot = {
    left: browserSidePanes.left,
    right: browserSidePanes.right,
  };
  void updateGlobalConfigSerial((prefs) => {
    const cur = prefs.browser_side_panes;
    if (cur && cur.left === snapshot.left && cur.right === snapshot.right) {
      return null;
    }
    return { browser_side_panes: snapshot };
  });
}

/// Expanded-directory map for the file browser tree. Lifted out of
/// `FileTree.svelte` so the state survives tab switches (the
/// component unmounts every time the active tab changes). Shared
/// across all browser tabs in the window; per-window because two
/// windows on the same workspace may be navigating different directories.
///
/// Lives inside the per-window `session.json` payload (round-tripped
/// through `serializeLayout` / `restoreLayout`) so it survives
/// chan-app close + reopen without bloating the user's workspace
/// directory.
export const treeExpanded = $state<{ map: Record<string, boolean> }>({
  map: { "": true },
});

// ---------------------------------------------------------------------------
// Per-File-Browser-instance tree metadata.
//
// Expanding/collapsing in one instance must not affect others. The
// `treeExpanded` singleton above is window-shared; two simultaneously-visible
// File Browser instances (a dock pane plus another pane) fight over it. This
// registry is the keyed structure those instances own. Each File Browser
// instance gets its own `FbTreeInstance` keyed by a stable id; the instance
// owns its expand/collapse map, selection, scroll, and the set of directory
// scopes it has subscribed to over `/ws`. The `treeExpanded` singleton
// stays as a session-persistence mirror.
//
// Subscription refcounting: each instance records the dirs IT subscribed to
// in `subscribedDirs`. The client-side cross-instance refcount (so the second
// instance to expand a dir reuses the subscription and the last to collapse
// it unsubscribes) is derived from the union of all instances'
// `subscribedDirs`; the server keeps its own authoritative per-socket
// refcount in the `ScopeRegistry`. See `fbDirSubscriberCount`.

/// Per-instance File Browser / Graph tree metadata. Owned by exactly one
/// instance id; never shared. The workspace root (`""`) is always conceptually
/// expanded, so `expanded[""]` is kept true.
export interface FbTreeInstance {
  /// Workspace-relative dir path -> expanded. `""` (root) stays true.
  expanded: Record<string, boolean>;
  /// The instance's current selection (workspace-relative path) or null.
  selected: string | null;
  /// Whether the synthetic "workspace" row is selected (vs a real entry).
  showWorkspace: boolean;
  /// Last known scroll offset of the instance's tree viewport, in px.
  scrollTop: number;
  /// Directory scopes this instance has an active `/ws` subscription on.
  /// Used to derive the cross-instance refcount and to unsubscribe on
  /// dispose. Always contains `""` (the implicit root scope) once the
  /// instance is registered.
  subscribedDirs: Record<string, boolean>;
}

/// Registry of live File Browser / Graph tree instances, keyed by a stable
/// per-instance id (a pane id, tab id, or graph-panel id chosen by the
/// caller). `$state` so component effects react to instance create/dispose
/// and to per-instance metadata changes.
export const fbTreeInstances = $state<{ byId: Record<string, FbTreeInstance> }>({
  byId: {},
});

/// Get-or-create the metadata for a File Browser / Graph instance. Idempotent:
/// returns the existing record if the id is already registered, so a
/// component effect can call it on every (re)mount without clobbering state.
export function ensureFbTreeInstance(id: string): FbTreeInstance {
  const existing = fbTreeInstances.byId[id];
  if (existing) return existing;
  const created: FbTreeInstance = {
    expanded: { "": true },
    selected: null,
    showWorkspace: false,
    scrollTop: 0,
    subscribedDirs: { "": true },
  };
  fbTreeInstances.byId = { ...fbTreeInstances.byId, [id]: created };
  // Return the registry's proxied record, not the raw literal: `$state`
  // deep-proxies on assignment, so callers must mutate the proxy in the
  // map for reactivity (and for `fbDirSubscriberCount`) to see it.
  return fbTreeInstances.byId[id];
}

/// Read an instance's metadata without creating it. Null when the id is not
/// registered (e.g. before mount or after dispose).
export function fbTreeInstance(id: string): FbTreeInstance | null {
  return fbTreeInstances.byId[id] ?? null;
}

/// Dispose an instance: drop its record from the registry. Callers should
/// unsubscribe the instance's `subscribedDirs` from the watcher socket
/// BEFORE calling this (the File Browser does); this only forgets the
/// client-side metadata so a closed pane / collapsed graph stops counting
/// toward the cross-instance refcount.
export function disposeFbTreeInstance(id: string): void {
  if (!(id in fbTreeInstances.byId)) return;
  const { [id]: _gone, ...rest } = fbTreeInstances.byId;
  fbTreeInstances.byId = rest;
}

/// How many live instances currently subscribe to `dir`. This is the
/// client-side cross-instance refcount: the first instance to reach 1
/// triggers a `sub` frame, and the transition back to 0 triggers `unsub`
/// (the File Browser owns those transitions). The server keeps its own per-socket
/// refcount, so this is purely a client-side dedupe of redundant frames.
export function fbDirSubscriberCount(dir: string): number {
  let n = 0;
  for (const inst of Object.values(fbTreeInstances.byId)) {
    if (inst.subscribedDirs[dir]) n += 1;
  }
  return n;
}

export function restoreTreeExpandedMap(next: Record<string, boolean>): void {
  for (const k of Object.keys(treeExpanded.map)) {
    delete treeExpanded.map[k];
  }
  treeExpanded.map[""] = true;
  for (const [k, v] of Object.entries(next)) {
    if (v) treeExpanded.map[k] = true;
  }
  treeExpanded.map[""] = true;
}

type TreeExpandedReloadSnapshot = {
  map: Record<string, boolean>;
};

const TREE_EXPANDED_RELOAD_KEY = "chan.fileBrowser.treeExpanded";

function treeExpandedReloadKey(): string {
  const workspaceKey = workspace.info?.root ?? window.location.pathname;
  return `${TREE_EXPANDED_RELOAD_KEY}:${sessionWindowId()}:${workspaceKey}`;
}

function treeExpandedPayload(): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(treeExpanded.map)) {
    if (v) map[k] = true;
  }
  map[""] = true;
  return map;
}

function writeTreeExpandedReloadSnapshot(): void {
  if (typeof window === "undefined") return;
  const payload: TreeExpandedReloadSnapshot = { map: treeExpandedPayload() };
  try {
    window.sessionStorage.setItem(treeExpandedReloadKey(), JSON.stringify(payload));
  } catch {
    // Server-side session persistence remains the canonical path.
  }
}

function applyTreeExpandedReloadSnapshot(): boolean {
  if (typeof window === "undefined") return false;
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(treeExpandedReloadKey());
  } catch {
    return false;
  }
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as Partial<TreeExpandedReloadSnapshot>;
    if (!parsed.map || typeof parsed.map !== "object") return false;
    restoreTreeExpandedMap(parsed.map);
    markTreeExpansionRestored();
    return true;
  } catch {
    return false;
  }
}

// ---- all-terminal reload reattach snapshot --------------------------------
//
// An all-terminal window (its only tabs are terminals -- e.g. a terminal plus
// the file-browser dock, which is not a layout tab) is NOT a durable saved
// window: `serializeSession()` returns null so no on-disk session blob is
// written (that is what stops it lingering as a `cs window list` phantom after
// close -- step-5). But Cmd+R must still RE-ATTACH the surviving server-side
// PTYs, and the reload tsid graft (tabs.svelte.ts) sources tsids from the
// server session blob -- which is now absent. So we mirror the live layout
// (WITH tsids, plus the rich-prompt pp/rpv) into sessionStorage, which
// survives a reload but is cleared when the window/tab closes. Same channel as
// the treeExpanded reload snapshot above: reload reattaches, a real close
// leaves nothing behind (no phantom, no durable blob).
const LAYOUT_RELOAD_KEY = "chan.layout.reload";

/// Canonical per-window key. Deliberately NOT scoped by `workspace.info.root`:
/// that loads async (bootstrap awaits `/api/workspace`), so an early save while
/// `workspace.info` was still null wrote a SECOND key (`…:/`, the
/// `location.pathname` fallback) carrying a tsid-LESS terminal -- and a bootstrap
/// restore from that key spawned a stray PTY (no `session=`). `sessionWindowId()`
/// is stable from first paint and uniquely scopes the snapshot to this window
/// (a window only ever reloads its own single workspace), so one key covers
/// every save + the bootstrap read -- no path-normalization mismatch.
function layoutReloadKey(): string {
  return `${LAYOUT_RELOAD_KEY}:${sessionWindowId()}`;
}

function writeLayoutReloadSnapshot(layout: ReturnType<typeof serializeLayout>): void {
  if (typeof window === "undefined") return;
  try {
    if (layout) {
      window.sessionStorage.setItem(layoutReloadKey(), JSON.stringify(layout));
    } else {
      window.sessionStorage.removeItem(layoutReloadKey());
    }
  } catch {
    // sessionStorage unavailable: an all-terminal window degrades to a fresh
    // PTY on reload (durable windows are unaffected -- they use the on-disk blob).
  }
}

function readLayoutReloadSnapshot(): ReturnType<typeof serializeLayout> {
  if (typeof window === "undefined") return null;
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(layoutReloadKey());
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ReturnType<typeof serializeLayout>;
  } catch {
    return null;
  }
}

/// Keep the all-terminal reattach snapshot in sync with each session save.
/// Called from both save paths BEFORE their on-disk dedup so a tsid change
/// updates the snapshot even when the on-disk payload is unchanged.
///
/// The on-disk blob is the durable cross-load source (close→reopen, reconnect,
/// and a Cmd+R once it has been written), but its `keepalive` PUT can race a
/// fast reload's GET, so a reattachable-terminal layout is ALSO mirrored (with
/// tsids) into sessionStorage -- the same-tab reload reads that synchronously
/// and can never lose the surviving PTYs:
///   - layout WITH a reattachable tsid (terminal-only OR terminal+durable):
///     persist the snapshot, even when the blob is also PUT;
///   - durable window with NO terminal (payload non-null): the on-disk blob is
///     the sole source → clear;
///   - truly empty window (no layout): nothing to reattach → clear;
///   - all-terminal layout with NO reattachable tsid (an early save before the
///     terminal's session frame, or a session that ended): leave any prior good
///     snapshot intact -- never persist a tsid-less terminal (restoring it would
///     spawn a stray fresh PTY).
function syncLayoutReloadSnapshot(payload: SessionPayload | null): void {
  const layout = serializeLayout({ terminalSessions: true });
  if (layout && layoutHasReattachableTerminal(layout)) {
    writeLayoutReloadSnapshot(layout);
    return;
  }
  if (payload || !layout) {
    writeLayoutReloadSnapshot(null);
  }
}

export const __testReadLayoutReloadSnapshot = readLayoutReloadSnapshot;

/// Trigger a session save so the change reaches disk. Pane / tab
/// edits already call `scheduleSessionSave`; this thin wrapper keeps
/// the call site at the toggle point semantically clear.
export function persistTreeExpanded(): void {
  writeTreeExpandedReloadSnapshot();
  scheduleSessionSave();
}

// ---- per-instance reload persistence ----------------------------------------
//
// FileTree.svelte renders off the per-instance `expanded` map, so the
// global reload snapshot above no longer feeds it. Each surface gets its
// own sessionStorage snapshot keyed by workspace + instance id so a full
// browser reload restores that surface's expansion. The TAB variant's
// authoritative store is the layout tab's `expanded` field (round-tripped
// through the hash + session.json and re-seeded by FileBrowserSurface on
// mount); the DOCK / overlay variants have no layout home, so this
// snapshot is what survives their reload.

const FB_INSTANCE_RELOAD_KEY = "chan.fileBrowser.instanceExpanded";

function fbInstanceReloadKey(id: string): string {
  const workspaceKey = workspace.info?.root ?? window.location.pathname;
  return `${FB_INSTANCE_RELOAD_KEY}:${sessionWindowId()}:${workspaceKey}:${id}`;
}

function fbInstanceExpandedPayload(id: string): Record<string, boolean> {
  const inst = fbTreeInstance(id);
  const map: Record<string, boolean> = { "": true };
  if (inst) {
    for (const [k, v] of Object.entries(inst.expanded)) {
      if (v) map[k] = true;
    }
  }
  return map;
}

/// Persist one File Browser surface's expansion: write its reload
/// snapshot and schedule a session save. Called from FileTree on every
/// toggle. The tab variant additionally mirrors the map into its layout
/// tab via FileBrowserSurface's effects.
export function persistFbTreeInstanceExpansion(id: string): void {
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(
        fbInstanceReloadKey(id),
        JSON.stringify({ map: fbInstanceExpandedPayload(id) }),
      );
    } catch {
      // Best-effort only; the tab variant still restores from its layout.
    }
  }
  scheduleSessionSave();
}

/// Seed an instance's expansion from its reload snapshot if one exists.
/// Returns true when a snapshot was applied. The dock / overlay surfaces
/// call this on mount; the tab variant seeds from `tab.expanded` instead
/// (that path is authoritative and survives app restart, not just reload).
export function seedFbTreeInstanceFromReloadSnapshot(id: string): boolean {
  if (typeof window === "undefined") return false;
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(fbInstanceReloadKey(id));
  } catch {
    return false;
  }
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { map?: Record<string, boolean> };
    if (!parsed.map || typeof parsed.map !== "object") return false;
    const inst = ensureFbTreeInstance(id);
    for (const k of Object.keys(inst.expanded)) {
      if (k !== "") delete inst.expanded[k];
    }
    inst.expanded[""] = true;
    for (const [k, v] of Object.entries(parsed.map)) {
      if (v) inst.expanded[k] = true;
    }
    inst.expanded[""] = true;
    return true;
  } catch {
    return false;
  }
}

/// True once we've established the initial tree-expansion state for
/// this session (either from session.json or from the fresh-session
/// auto-expand seed). Skips the auto-expand on subsequent
/// `refreshTree` calls so a user who collapsed everything doesn't
/// have it re-expanded behind their back on the next watcher tick.
let treeExpansionSeeded = false;

/// Mark the expansion state as "owned" by the user (or the
/// session-restore path). Called by restoreSession when a
/// treeExpanded payload is present so the auto-seed doesn't
/// override it.
export function markTreeExpansionRestored(): void {
  treeExpansionSeeded = true;
}

/// First-paint default: keep only the workspace root expanded. A restored
/// session still wins through `markTreeExpansionRestored`; fresh
/// browser opens should not explode the whole tree.
function seedTreeExpansionIfFresh(): void {
  if (treeExpansionSeeded) return;
  treeExpansionSeeded = true;
  treeExpanded.map[""] = true;
}

/// Expand every directory in the current tree. Wired to the file
/// browser's expand-all header button. Mutates the existing map
/// proxy in place so consumers that captured `treeExpanded.map` at
/// mount time (FileTree.svelte) keep seeing the live state.
export function expandAllFolders(): void {
  treeExpanded.map[""] = true;
  for (const e of tree.entries) {
    if (e.is_dir) treeExpanded.map[e.path] = true;
  }
  treeExpansionSeeded = true;
  persistTreeExpanded();
}

/// Collapse every directory (top-level rows still render; their
/// children are hidden). Keeps the implicit root key alive so
/// FileTree's pre-order walk stays consistent. Mutates in place
/// for the same reason as `expandAllFolders`.
export function collapseAllFolders(): void {
  for (const k of Object.keys(treeExpanded.map)) {
    if (k !== "") delete treeExpanded.map[k];
  }
  treeExpanded.map[""] = true;
  treeExpansionSeeded = true;
  persistTreeExpanded();
}

/// Reveal a path in the file browser tree: expand every ancestor
/// directory so the row is visible, then set the browser selection to
/// it. FileTree's selection-change effect scrolls the row into
/// view. Called after a successful create / move so the user lands
/// next to whatever they just produced instead of having to hunt
/// for it. Walks the path segment-by-segment rather than the
/// entries list because the new entry may not be in the snapshot
/// yet (the tree refresh may still be in flight).
export function revealAndSelect(path: string): void {
  const parts = path.split("/");
  let acc = "";
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc ? `${acc}/${parts[i]}` : parts[i];
    treeExpanded.map[acc] = true;
  }
  treeExpanded.map[""] = true;
  // FileTree renders off per-instance maps now, so a reveal must reach
  // every live surface (the dock + the active tab) rather than only the
  // global singleton; the entry should appear wherever the user is
  // looking. Expand ancestors only (not the file itself).
  expandAncestorsInAllInstances(path, false);
  // Programmatic reveal is a single-select: reset the multi-set + anchor
  // so a later shift+click ranges from the revealed entry.
  fbSelectSingle(path);
  browserSelection.showWorkspace = false;
  // The expansion change counts as a user action - persist it so
  // the next launch keeps the new entry in view.
  persistTreeExpanded();
}

/// Enter a directory from an external window command. This expands the
/// target directory itself so lazy child loading reveals that directory's
/// contents, not just the parent chain that makes the directory row visible.
export function revealAndEnterDirectory(path: string): void {
  const parts = path.split("/").filter(Boolean);
  let acc = "";
  treeExpanded.map[""] = true;
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    treeExpanded.map[acc] = true;
  }
  // Reach every live surface (see revealAndSelect). Entering a directory
  // expands the directory ITSELF plus its ancestors.
  expandAncestorsInAllInstances(path, true);
  fbSelectSingle(path || null);
  browserSelection.showWorkspace = false;
  if (path) void loadTreeDir(path);
  persistTreeExpanded();
}

/// True when every directory in the current tree is expanded.
/// Feeds the expand/collapse affordance's glyph and title.
export function isFullyExpanded(): boolean {
  for (const e of tree.entries) {
    if (e.is_dir && !treeExpanded.map[e.path]) return false;
  }
  return true;
}

// ---- per-instance expansion helpers ------------------------------------------
//
// FileTree.svelte renders + toggles off the per-instance `expanded` map in
// `fbTreeInstances` so two visible File Browser surfaces (a dock side + a
// tab, or two split panes) keep independent expand/collapse state. These
// mirror the global `expandAllFolders` / `collapseAllFolders` /
// `isFullyExpanded` above but target one instance's map. The FB header
// menu calls them with the surface's own instance id.

/// Expand every directory in the current tree for one instance.
export function expandAllFoldersForInstance(id: string): void {
  const inst = ensureFbTreeInstance(id);
  inst.expanded[""] = true;
  for (const e of tree.entries) {
    if (e.is_dir) inst.expanded[e.path] = true;
  }
}

/// Collapse every directory for one instance (root stays expanded so
/// the pre-order walk in FileTree stays consistent).
export function collapseAllFoldersForInstance(id: string): void {
  const inst = ensureFbTreeInstance(id);
  for (const k of Object.keys(inst.expanded)) {
    if (k !== "") delete inst.expanded[k];
  }
  inst.expanded[""] = true;
}

/// True when every directory in the current tree is expanded for one
/// instance. Feeds the expand/collapse affordance for that surface.
export function isFullyExpandedForInstance(id: string): boolean {
  const inst = fbTreeInstance(id);
  if (!inst) return false;
  for (const e of tree.entries) {
    if (e.is_dir && !inst.expanded[e.path]) return false;
  }
  return true;
}

/// Expand the ancestor chain of `path` across EVERY live File Browser
/// instance. Programmatic reveals (after create / move / upload, or an
/// external open-browser command) must surface the new entry in whatever
/// surface is on screen; unlike a user toggle, a reveal is not scoped to
/// one instance. Always keeps each instance's root expanded.
function expandAncestorsInAllInstances(path: string, includeSelf: boolean): void {
  const parts = (includeSelf ? path.split("/").filter(Boolean) : path.split("/"));
  const upto = includeSelf ? parts.length : parts.length - 1;
  for (const inst of Object.values(fbTreeInstances.byId)) {
    inst.expanded[""] = true;
    let acc = "";
    for (let i = 0; i < upto; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      if (acc) inst.expanded[acc] = true;
    }
  }
}

/// Poll cadence: fast while the indexer is doing work or has errored,
/// slow when idle (so we still pick up CLI-driven `chan index` runs
/// in the background without hammering the server every second).
///
/// Single-file watcher reindexes are server-side visible for ~10ms
/// (`Reindexing` -> `Idle`). The transient cadence catches the
/// post-reindex idle within a fraction of a second so the pill clears
/// in real time; the full-build (multi-file) cadence stays slower
/// since those passes legitimately take seconds.
const FAST_POLL_MS = 1500;
const TRANSIENT_POLL_MS = 250;
const SLOW_POLL_MS = 10_000;

let indexPollTimer: ReturnType<typeof setTimeout> | null = null;

/// Kick off the polling loop. Idempotent: calling it twice keeps a
/// single chain alive.
export function startIndexStatusPoller(): void {
  if (indexPollTimer) return;
  void pollIndexStatusOnce();
}

export function stopIndexStatusPoller(): void {
  if (indexPollTimer) {
    clearTimeout(indexPollTimer);
    indexPollTimer = null;
  }
}

async function pollIndexStatusOnce(): Promise<void> {
  let nextDelay = SLOW_POLL_MS;
  try {
    const s = await api.indexStatus();
    indexStatus.value = s;
    // Idle → slow poll. Single-file Reindexing → transient cadence
    // so the post-reindex idle is caught within ~250ms (Bug 1).
    // Multi-file Building → fast cadence (the pass takes seconds
    // and per-tick UI churn isn't useful). Error → fast cadence so
    // an operator-visible recovery surfaces quickly.
    if (s.state === "idle") nextDelay = SLOW_POLL_MS;
    else if (s.state === "reindexing") nextDelay = TRANSIENT_POLL_MS;
    else nextDelay = FAST_POLL_MS;
  } catch {
    // Server unreachable or 503 (search disabled): slow-poll. Don't
    // surface as a status-bar error; the pill itself shows "n/a".
    indexStatus.value = null;
    nextDelay = SLOW_POLL_MS;
  } finally {
    indexPollTimer = setTimeout(() => void pollIndexStatusOnce(), nextDelay);
  }
}

// ---- in-page prompt -----------------------------------------------------
//
// `window.prompt()` is not implemented by macOS WKWebView; Tauri silently
// drops it. We replace the few prompt-driven flows (new file / directory /
// rename) with a small in-page modal driven by this state. Same code path
// works in regular browsers too, so there's only one prompt UX to design.

type PromptState = {
  open: boolean;
  title: string;
  defaultValue: string;
  resolve: ((value: string | null) => void) | null;
};

export const promptState = $state<PromptState>({
  open: false,
  title: "",
  defaultValue: "",
  resolve: null,
});

/// Show a single-input modal. Resolves with the user's text on OK or
/// `null` on Cancel / dismiss. Replaces `window.prompt`.
export function uiPrompt(
  title: string,
  defaultValue = "",
): Promise<string | null> {
  return new Promise((resolve) => {
    // If a prompt is already open, reject the previous one as cancelled.
    promptState.resolve?.(null);
    promptState.title = title;
    promptState.defaultValue = defaultValue;
    promptState.resolve = resolve;
    promptState.open = true;
  });
}

/// Called by the modal component on OK / Cancel.
export function resolvePrompt(value: string | null): void {
  const r = promptState.resolve;
  promptState.resolve = null;
  promptState.open = false;
  r?.(value);
}

// ---- in-page path prompt ------------------------------------------------
//
// Richer cousin of uiPrompt for typing relative paths: live directory
// autocomplete from the loaded tree, parent-creation hints, overwrite
// warnings, and client-side validation. Used by file create / move /
// rename. The plain uiPrompt stays around for label-only inputs.
//
// `kind` distinguishes the two entity classes the user can be naming:
// a file (default `.md` will be appended on submit if no extension) or
// a directory. The modal uses it to label the status row and to decide
// what the autocomplete should suggest.
//
// `mode` controls how an existing target at the typed path is treated:
//   - "create": existing target is a hard error (cannot overwrite via
//     create; the user should rename or pick a different name).
//   - "move":   existing target is a soft warning; the caller will
//     fire a separate uiConfirm before performing the destructive
//     action.

/// `"either"` lets the unified "New File or Directory" prompt accept
/// both shapes. The modal detects file-vs-dir from the path's trailing
/// slash: `foo/bar/` is a directory, `foo/bar` (or with an extension)
/// is a file. Callers resolve the returned path against the chosen kind
/// via `pathPromptKind()` below.
export type PathPromptKind = "file" | "folder" | "either";
/// `attach` is the watcher-dialog mode: the user picks a path to
/// attach a long-running watcher to,
/// which is neither "create the entity" nor "move into it". The
/// modal status row treats an existing directory as a normal
/// attach (no overwrite warning) and a missing path as "create
/// + attach" (silent backend create). Absolute paths outside the
/// workspace root are first-class - watcher event files are infra
/// traffic, not user content, so the workspace sandbox doesn't apply.
/// `open` is the command-launcher Open dialog: the target rides
/// `POST /api/open` (cs open semantics), so an existing file or
/// directory is the normal case (opens), a missing path is disclosed
/// as "creates and opens", a `chan://graph?...` link bypasses path
/// validation (parseGraphLink judges it instead), and NO extension is
/// ever auto-appended (extensionless files must reach the server's
/// content sniff verbatim).
export type PathPromptMode = "create" | "move" | "attach" | "open";

type PathPromptState = {
  open: boolean;
  title: string;
  defaultValue: string;
  kind: PathPromptKind;
  mode: PathPromptMode;
  /// Set on "move": the path being renamed. The modal hides this from
  /// the autocomplete (no point suggesting "move to itself") and the
  /// "overwrites" check ignores it (renaming `a` → `a` is a no-op,
  /// not an overwrite).
  sourcePath: string | null;
  /// Optional caller-supplied validator run against the effective
  /// (post-extension-resolution) path. Returns a human-readable
  /// reason when the path should be rejected, or null when it's
  /// fine. The modal surfaces the reason in the red status row and
  /// disables Submit, so the user fixes the input in-place instead
  /// of bouncing through a status-bar error after the dialog
  /// closes. Used today by createFile to enforce the .md/.txt
  /// editable-text gate up front.
  validate: ((effectivePath: string) => string | null) | null;
  allowAbsolute: boolean;
  /// Optional informational line rendered above the input. Unlike the
  /// caller `validate` (which can reject), this never gates submit; it
  /// just explains an intent the path alone can't convey. Used by the
  /// save-from-draft flow to tell the user the WHOLE draft directory is
  /// being saved as a directory (the `folder` Dir-only mode), since the
  /// path field only shows the destination, not "the entire workspace
  /// moves here".
  notice: string | null;
  resolve: ((value: string | null) => void) | null;
};

export const pathPromptState = $state<PathPromptState>({
  open: false,
  title: "",
  defaultValue: "",
  kind: "file",
  mode: "create",
  sourcePath: null,
  validate: null,
  allowAbsolute: false,
  notice: null,
  resolve: null,
});

export function uiPathPrompt(opts: {
  title: string;
  defaultValue?: string;
  kind: PathPromptKind;
  mode: PathPromptMode;
  sourcePath?: string | null;
  validate?: (effectivePath: string) => string | null;
  allowAbsolute?: boolean;
  notice?: string | null;
}): Promise<string | null> {
  return new Promise((resolve) => {
    pathPromptState.resolve?.(null);
    pathPromptState.title = opts.title;
    pathPromptState.defaultValue = opts.defaultValue ?? "";
    pathPromptState.kind = opts.kind;
    pathPromptState.mode = opts.mode;
    pathPromptState.sourcePath = opts.sourcePath ?? null;
    pathPromptState.validate = opts.validate ?? null;
    pathPromptState.allowAbsolute = opts.allowAbsolute ?? false;
    pathPromptState.notice = opts.notice ?? null;
    pathPromptState.resolve = resolve;
    pathPromptState.open = true;
  });
}

export function resolvePathPrompt(value: string | null): void {
  const r = pathPromptState.resolve;
  pathPromptState.resolve = null;
  pathPromptState.validate = null;
  pathPromptState.allowAbsolute = false;
  pathPromptState.notice = null;
  pathPromptState.open = false;
  r?.(value);
}

/// File CRUD helpers shared by the sidebar header and the tree's
/// context menu / hover actions. They wrap the raw API with prompts,
/// confirmations, and a tree refresh, plus opening the new file in the
/// active pane on create. Surfacing one set of behaviors via several
/// affordances keeps the actions consistent regardless of which entry
/// point the user reaches for.

// `appendDefaultMd` moved to ../state/pathValidate so PathPromptModal
// can preview the auto-extension live; we re-import below.

// `preserveExtension` moved to ../state/pathValidate so the
// PathPromptModal can preview the rename-with-preserved-extension
// inline. We re-import above; the call below is now a defensive
// idempotent layer (the modal already resolved the extension).

/// Perform a move from `path` -> `target`. Shared by rename (CLI-style
/// prompt) and drag-and-drop. No-ops if source == target. Prompts for
/// overwrite confirmation when the target is a file; existing
/// directories are rejected because chan-workspace will not replace them.
/// Refreshes the tree and re-keys open tabs so in-memory state follows
/// the rename without a refetch round-trip.
///
/// The server runs the rename + link-rewrite pass synchronously. For a
/// single-file rename with few backlinks this is sub-100ms; for a
/// directory rename touching dozens of inbound references it can take a
/// few hundred ms. We show a "Moving..." status indicator after a 200ms
/// delay so a fast rename doesn't flash an indicator, but a slow one
/// still tells the user the UI hasn't frozen.
const MOVING_STATUS_DELAY_MS = 200;
async function performMove(path: string, target: string): Promise<void> {
  if (target === path) return;
  const draftsReason =
    fileBrowserDraftsPathReason(path) ?? fileBrowserDraftsPathReason(target);
  if (draftsReason) {
    ui.status = `move failed: ${draftsReason}`;
    return;
  }
  const existing = tree.entries.find((e) => e.path === target);
  if (existing) {
    if (existing.is_dir) {
      ui.status = `rename failed: '${target}' is an existing directory`;
      return;
    }
    const confirmed = await uiConfirm({
      title: "Overwrite existing file?",
      message: `'${target}' already exists. The current file will be replaced.`,
      confirmLabel: "Overwrite",
      destructive: true,
    });
    if (!confirmed) return;
  }
  let movingTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    ui.status = "Moving...";
    movingTimer = null;
  }, MOVING_STATUS_DELAY_MS);
  // Mark both endpoints so the watcher handler ignores echoes of
  // this rename while the move is in flight (see `movingPaths`).
  movingPaths.add(path);
  movingPaths.add(target);
  try {
    const resp = await api.move(path, target);
    await refreshTree();
    rekeyTabsForRename(path, target);
    // Defensive: if a watcher event slipped through before the Set
    // was populated (or in any future code path that bypasses it),
    // clear any "file not found" error sitting on the moved tab so
    // the user doesn't keep staring at a stale message.
    for (const { tabId } of tabsForPath(target)) {
      clearTabError(tabId);
    }
    revealAndSelect(target);
    // Nudge open tabs to re-check their underlying file. Server-side
    // self_writes dedupe suppresses the watcher echo for our own
    // rewrites, so without this bump a tab pointing at a rewritten
    // source would keep its stale buffer until the next save (which
    // would then surface as a CAS conflict).
    if (resp.rewritten.length > 0) {
      ui.lastWatch = Date.now();
    }
    const linkBits: string[] = [];
    if (resp.rewritten.length > 0) {
      linkBits.push(
        `${resp.rewritten.length} link${resp.rewritten.length === 1 ? "" : "s"} updated`,
      );
    }
    if (resp.conflicts.length > 0) {
      linkBits.push(
        `${resp.conflicts.length} conflict${resp.conflicts.length === 1 ? "" : "s"}`,
      );
    }
    // Route the success message through the transient helper so
    // it auto-dismisses. Error path stays persistent so the user
    // notices failures.
    const moveMsg =
      linkBits.length > 0
        ? `Moved '${target}' (${linkBits.join(", ")})`
        : null;
    if (moveMsg) {
      setTransientStatus(moveMsg);
    } else {
      // No link updates worth surfacing - clear any prior
      // status so the user isn't left looking at "Moving...".
      ui.status = null;
    }
  } catch (e) {
    ui.status = `rename failed: ${(e as Error).message}`;
  } finally {
    if (movingTimer) clearTimeout(movingTimer);
    if (ui.status === "Moving...") ui.status = null;
    movingPaths.delete(path);
    movingPaths.delete(target);
  }
}

function uploadCancelledError(): Error {
  const err = new Error("upload cancelled");
  err.name = "AbortError";
  return err;
}

function uploadLeafName(name: string): string {
  return name.trim().split(/[\\/]/).pop()?.trim() ?? "";
}

function uploadTargetPath(dir: string, name: string): string {
  const leaf = uploadLeafName(name);
  return dir ? `${dir}/${leaf}` : leaf;
}

function downloadFilename(path: string, isDir: boolean): string {
  const name = path.split("/").filter(Boolean).pop() || "download";
  return isDir ? `${name}.tar` : name;
}

function uploadNameReason(name: string): string | null {
  const leaf = uploadLeafName(name);
  if (!leaf) return "file has no name";
  if (leaf === "." || leaf === "..") return "file name is not allowed";
  return null;
}

export const fileOps = {
  downloadPath(path: string, isDir: boolean): void {
    if (handleDemoDownload(path, isDir)) return;
    const link = document.createElement("a");
    link.href = api.downloadUrl(path);
    link.download = downloadFilename(path, isDir);
    link.rel = "noopener";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
  },
  /// Inspector Download action. In the browser the native download
  /// manager handles progress + the Downloads folder + reveal, so we
  /// keep the `<a download>` path. chan-desktop's webview has no such
  /// manager, so on desktop we route through `runDesktopDownload`
  /// (api/desktop.ts): Rust streams the authenticated response to the
  /// Downloads folder while the SPA polls bounded native progress,
  /// driving the transfer bubble (the single download surface).
  /// Fire-and-forget: the transfer model carries progress / error /
  /// savedPath so callers don't await.
  downloadPathWithProgress(path: string, isDir: boolean): void {
    if (handleDemoDownload(path, isDir)) return;
    if (isTauriDesktop()) {
      const url = new URL(
        api.downloadUrl(path),
        window.location.href,
      ).toString();
      // Pass the source so an interrupted download (window reload) can offer
      // Retry from the transfer bubble.
      void runDesktopDownload(url, downloadFilename(path, isDir), {
        path,
        isDir,
      }).catch(() => {});
      return;
    }
    this.downloadPath(path, isDir);
  },
  async replaceFileAt(targetPath: string, picked: File): Promise<void> {
    const draftsReason = fileBrowserDraftsPathReason(targetPath);
    if (draftsReason) {
      ui.status = `upload failed: ${draftsReason}`;
      ui.statusKind = "persistent";
      return;
    }
    const activeAbort = new AbortController();
    const cancel = (): void => activeAbort.abort();
    // The replace drives the transfer bubble (the single transfer surface)
    // the same way a new upload does; the bubble row is keyed to the file
    // being replaced.
    const xferId = beginTransfer({
      kind: "upload",
      filename: targetPath.split("/").pop() || targetPath,
      cancel,
    });
    try {
      if (!(await waitForTransferSlot(xferId))) return;
      await api.replaceFile(picked, targetPath, {
        signal: activeAbort.signal,
        transferId: xferId,
        onProgress: (progress) => {
          const loaded = Math.min(Math.max(progress.loaded, 0), picked.size);
          setTransferProgress(xferId, picked.size > 0 ? Math.min(1, loaded / picked.size) : 1);
        },
      });
      await refreshTreeForPath(targetPath);
      for (const tab of tabsForPath(targetPath)) {
        await refreshTabFromDisk(tab.tabId);
      }
      finishTransfer(xferId);
      revealAndSelect(targetPath);
      setTransientStatus(`Replaced '${targetPath}'`);
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        cancelTransfer(xferId);
        setTransientStatus("Upload cancelled");
      } else {
        failTransfer(xferId, (e as Error).message);
        ui.status = `upload failed: ${(e as Error).message}`;
        ui.statusKind = "persistent";
      }
    }
  },
  async uploadFilesTo(destDir: string, dropped: FileList | File[]): Promise<void> {
    const files = Array.from(dropped);
    if (files.length === 0) return;
    const seen = new Set<string>();
    for (const file of files) {
      const reason = uploadNameReason(file.name);
      if (reason) {
        ui.status = `upload failed: ${reason}`;
        ui.statusKind = "persistent";
        return;
      }
      const target = uploadTargetPath(destDir, file.name);
      const draftsReason = fileBrowserDraftsPathReason(target);
      if (draftsReason) {
        ui.status = `upload failed: ${draftsReason}`;
        ui.statusKind = "persistent";
        return;
      }
      if (seen.has(target) || tree.entries.some((entry) => entry.path === target)) {
        ui.status = `upload failed: '${target}' already exists`;
        ui.statusKind = "persistent";
        return;
      }
      seen.add(target);
    }

    let cancelRequested = false;
    let activeAbort: AbortController | null = null;
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    let completedBytes = 0;
    const cancel = (): void => {
      cancelRequested = true;
      activeAbort?.abort();
    };
    // The transfer bubble (the single transfer surface) carries one aggregate
    // row for this upload op.
    const transferLabel = files.length === 1 ? files[0]!.name : `${files.length} files`;
    const xferId = beginTransfer({ kind: "upload", filename: transferLabel, cancel });
    const reportProgress = (file: File, loaded: number): void => {
      const currentLoaded = Math.min(Math.max(loaded, 0), file.size);
      const frac =
        totalBytes > 0 ? Math.min(1, (completedBytes + currentLoaded) / totalBytes) : 1;
      setTransferProgress(xferId, frac);
    };

    const uploaded: string[] = [];
    try {
      if (!(await waitForTransferSlot(xferId))) return;
      for (let i = 0; i < files.length; i++) {
        if (cancelRequested) throw uploadCancelledError();
        const file = files[i]!;
        activeAbort = new AbortController();
        reportProgress(file, 0);
        const result = await api.uploadFile(file, destDir, {
          signal: activeAbort.signal,
          transferId: xferId,
          onProgress: (progress) => reportProgress(file, progress.loaded),
        });
        activeAbort = null;
        if (cancelRequested) throw uploadCancelledError();
        completedBytes += file.size;
        uploaded.push(result.path);
        await refreshTreeForPath(result.path);
      }
      finishTransfer(xferId);
      if (uploaded.length > 0) {
        revealAndSelect(uploaded[uploaded.length - 1]!);
        setTransientStatus(
          uploaded.length === 1
            ? `Uploaded '${uploaded[0]}'`
            : `Uploaded ${uploaded.length} files`,
        );
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        cancelTransfer(xferId);
        setTransientStatus("Upload cancelled");
      } else {
        failTransfer(xferId, (e as Error).message);
        ui.status = `upload failed: ${(e as Error).message}`;
        ui.statusKind = "persistent";
      }
    } finally {
      activeAbort = null;
    }
  },
  async createFile(parentPath: string): Promise<void> {
    // Start directly on a concrete editable target. The modal
    // selects only the stem, so typing replaces "untitled" while
    // Enter accepts the proposed Markdown file immediately.
    const defaultValue = proposeDefaultFilename(parentPath);
    const name = await uiPathPrompt({
      title: "new file (relative path; .md added if no extension)",
      defaultValue,
      kind: "file",
      mode: "create",
      // Enforce the editable-text gate inline. The modal calls this
      // against the effective path (post `.md` auto-append) so a
      // user who types `foo.foo` sees the rejection in the dialog
      // and can correct it, instead of submitting and getting a
      // status-bar error after the prompt closes.
      validate: (path) =>
        fileBrowserDraftsPathReason(path) ??
        (isEditableText(path)
          ? null
          : `'${path}' is not an editable text file`),
    });
    if (!name) return;
    // The modal already validated against `isEditableText`, but
    // appendDefaultMd is idempotent and the cost is trivial; keep it
    // here as a defensive backstop in case any caller bypasses the
    // modal validator in the future.
    const path = appendDefaultMd(name);
    try {
      await api.create(path, false, "");
      await refreshTree();
      await openInActivePane(path, { landAtTop: true });
    } catch (e) {
      ui.status = `create failed: ${(e as Error).message}`;
    }
  },
  async createDir(parentPath: string): Promise<void> {
    const defaultValue = parentPath ? `${parentPath}/` : "";
    const path = await uiPathPrompt({
      title: "new directory",
      defaultValue,
      kind: "folder",
      mode: "create",
      validate: fileBrowserDraftsPathReason,
    });
    if (!path) return;
    try {
      await api.create(path, true);
      await refreshTree();
      // Directory creation leaves the user inside the file browser
      // (unlike file creation, which jumps straight into an editor
      // tab), so reveal the new directory and select it. Expands every
      // ancestor along the way so a `a/b/new-directory` create lands
      // visible even if `a` and `b` were collapsed.
      revealAndSelect(path);
    } catch (e) {
      ui.status = `create failed: ${(e as Error).message}`;
    }
  },
  /// Unified "New File or Directory" dialog. Opens a single
  /// PathPromptModal with `kind: "either"`; the user types a path
  /// ending in `/` for a directory or without the trailing slash for a
  /// file. On submit, dispatches to the API + UI flow that matches the
  /// detected kind: directories get `revealAndSelect`'d; files get
  /// `.md` auto-appended + opened in the active pane. The dialog owns
  /// kind detection via `effectiveKind`; this caller re-detects on the
  /// resolved path so the dispatch matches what the modal validated.
  async createFileOrDir(parentPath: string): Promise<void> {
    const defaultValue = parentPath ? `${parentPath}/` : "";
    const next = await uiPathPrompt({
      title: "new file or directory (trailing / = directory)",
      defaultValue,
      kind: "either",
      mode: "create",
      // Mirror createFile's editable-text gate for the file branch so an
      // unknown extension (e.g. `foo.zzz`) is rejected inline instead of
      // round-tripping to a server 415 that then sticks in the status bar.
      // A directory target keeps its trailing slash and is always allowed.
      validate: (path) =>
        fileBrowserDraftsPathReason(path) ??
        (path.endsWith("/") || isEditableText(path)
          ? null
          : `'${path}' is not an editable text file`),
    });
    if (!next) return;
    const isDir = next.endsWith("/");
    if (isDir) {
      try {
        await api.create(next, true);
        await refreshTree();
        revealAndSelect(next);
      } catch (e) {
        ui.status = `create failed: ${(e as Error).message}`;
      }
      return;
    }
    // File branch: apply the same `.md` auto-append + editable-
    // text gate as `createFile` for consistency. The modal's
    // resolved value already includes the suffix (it was
    // validated there), so this is just an idempotent backstop.
    const path = appendDefaultMd(next);
    try {
      await api.create(path, false, "");
      await refreshTree();
      await openInActivePane(path, { landAtTop: true });
    } catch (e) {
      ui.status = `create failed: ${(e as Error).message}`;
    }
  },
  /// Rename or move a file / directory. `isDir` toggles the
  /// extension-preservation step: for files, if the user drops the
  /// existing extension during the prompt (typed `note` instead of
  /// `note.md`), put it back so the resulting path still routes
  /// through the editor's text gate. Directories don't have
  /// extensions so the input is taken verbatim.
  ///
  /// If the resolved target collides with an existing file, we
  /// stop for a uiConfirm before issuing the move. Existing directory
  /// targets are refused because chan-workspace will not replace them.
  /// The PathPrompt modal already shows a warning row, but the user
  /// might commit past it on Enter, so the confirm dialog is the
  /// second gate before any destructive overwrite.
  async rename(path: string, isDir = false): Promise<void> {
    const next = await uiPathPrompt({
      title: "new path",
      defaultValue: path,
      kind: isDir ? "folder" : "file",
      mode: "move",
      sourcePath: path,
    });
    if (!next || next === path) return;
    const target = isDir ? next : preserveExtension(path, next);
    await performMove(path, target);
  },
  /// Move a file or directory to a new path without prompting. Used
  /// by drag-and-drop in the file browser. Same file overwrite
  /// confirm and post-move bookkeeping as rename.
  async moveTo(from: string, to: string): Promise<void> {
    await performMove(from, to);
  },
  /// Inline-rename entry point for the FileEditorTab's header-band UX.
  /// Same `performMove` machinery (overwrite confirm, link rewrite, tab
  /// rekey, watcher suppression) as `rename` above; just bypasses the
  /// modal so the header band can drive the input directly. Preserves
  /// the source extension when `next` lacks one.
  async renameInPlace(path: string, next: string, isDir = false): Promise<void> {
    const trimmed = next.trim();
    if (!trimmed || trimmed === path) return;
    const target = isDir ? trimmed : preserveExtension(path, trimmed);
    await performMove(path, target);
  },
  /// Delete a file (or directory) from the workspace.
  ///
  /// Closes any open tabs pointing at the deleted path (or paths
  /// under it, for directory deletes).
  ///
  /// Prompts via uiConfirm with destructive styling. For directories
  /// the message includes the descendant count so the user sees the
  /// blast radius before confirming.
  async remove(path: string, isDir = false): Promise<void> {
    const name = path.split("/").pop() ?? path;
    let message: string;
    if (isDir) {
      const prefix = `${path}/`;
      const descendants = tree.entries.filter((e) =>
        e.path.startsWith(prefix),
      ).length;
      message =
        descendants === 0
          ? `Delete directory "${name}"?`
          : `Delete directory "${name}" and its ${descendants} item${descendants === 1 ? "" : "s"}?`;
    } else {
      message = `Delete "${name}"?`;
    }
    const ok = await uiConfirm({
      title: "Delete",
      message,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.remove(path);
      // Drop the persisted caret for the deleted file (and its descendants on
      // a directory delete) so a later file reusing the path never restores a
      // ghost position.
      clearCaretsUnder(path);
      await Promise.all([refreshTree(), refreshWorkspace()]);
      const underDeleted = (p: string) =>
        p === path || p.startsWith(`${path}/`);
      // Snapshot (paneId, tabId) pairs to close BEFORE mutating
      // layout, since closeTab may collapse the pane mid-iteration.
      const toClose: Array<[string, string]> = [];
      for (const node of Object.values(layout.nodes)) {
        if (node.kind !== "leaf") continue;
        for (const t of allPaneTabs(node)) {
          if (t.kind !== "file") continue;
          if (underDeleted(t.path)) {
            toClose.push([node.id, t.id]);
          }
        }
      }
      for (const [paneId, tabId] of toClose) {
        await closeTab(paneId, tabId, { force: true });
      }
    } catch (e) {
      ui.status = `delete failed: ${(e as Error).message}`;
    }
  },
  /// Duplicate a file in-place. Reads the source via the API so any
  /// unsaved buffer in the open tab is intentionally ignored - the
  /// duplicate mirrors what's on disk, not what's in the editor.
  /// Resolves the next free `name-copy.ext`, `name-copy-2.ext`, ...
  /// under the same directory, creates the file, refreshes the tree,
  /// and opens the new tab next to the source.
  async duplicateFile(path: string): Promise<void> {
    try {
      const src = await api.read(path);
      const target = nextDuplicateName(path);
      await api.create(target, false, src.content);
      await refreshTree();
      await openInActivePane(target, { landAtTop: true });
      revealAndSelect(target);
    } catch (e) {
      ui.status = `duplicate failed: ${(e as Error).message}`;
    }
  },
};

/// Compute the next available "name-copy{,-N}.ext" sibling for
/// `path`. Looks at the current tree to avoid collisions; the
/// server still owns the final word (a concurrent create elsewhere
/// could race), and the create call will surface that error.
function nextDuplicateName(path: string): string {
  const slash = path.lastIndexOf("/");
  const dir = slash < 0 ? "" : path.slice(0, slash + 1);
  const base = slash < 0 ? path : path.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  const has = (p: string): boolean => tree.entries.some((e) => e.path === p);
  let candidate = `${dir}${stem}-copy${ext}`;
  if (!has(candidate)) return candidate;
  for (let n = 2; n < 1000; n++) {
    candidate = `${dir}${stem}-copy-${n}${ext}`;
    if (!has(candidate)) return candidate;
  }
  // Fall through with a timestamp suffix to break the unlikely tie.
  return `${dir}${stem}-copy-${Date.now()}${ext}`;
}
