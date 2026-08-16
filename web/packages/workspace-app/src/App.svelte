<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import AppStatusBar from "./components/AppStatusBar.svelte";
  import TransferBubble from "./components/TransferBubble.svelte";
  import SessionHandoverBubble from "./components/SessionHandoverBubble.svelte";
  import PasteRequestBubble from "./components/PasteRequestBubble.svelte";
  import ConfirmModal from "./components/ConfirmModal.svelte";
  import ConflictModal from "./components/ConflictModal.svelte";
  import DisconnectOverlay from "./components/DisconnectOverlay.svelte";
  import SessionEndedOverlay from "./components/SessionEndedOverlay.svelte";
  import CloseConfirmOverlay from "./components/CloseConfirmOverlay.svelte";
  import { installWakeGapDetector } from "./wakeGap";
  import { uiCloseConfirm } from "./state/closeConfirm.svelte";
  import DraftCloseModal from "./components/DraftCloseModal.svelte";
  import WorkspaceWarningsModal from "./components/WorkspaceWarningsModal.svelte";
  import TeamDialog from "./components/TeamDialog.svelte";
  import { teamDialogState, openTeamDialog } from "./state/teamDialog.svelte";
  // Modal-visibility flags read by paneChordBlocked() so the pane-flip command
  // never flips a pane hidden behind a dialog. conflictDialog drives
  // ConflictModal; workspaceWarningsDialog drives WorkspaceWarningsModal.
  import { conflictDialog } from "./state/tabs.svelte";
  import { currentPreferences, workspaceWarningsDialog } from "./state/store.svelte";
  // Open-count of pane-LOCAL modals (MCP-env info) whose visibility
  // lives in component state App.svelte can't otherwise see.
  import { paneModalGuard } from "./state/paneModalGuard.svelte";
  import { installFileDropGuard } from "./state/fileDropGuard";
  import { toggleRichPromptForTab } from "./state/richPrompt.svelte";
  import FileBrowserSidePane from "./components/FileBrowserSidePane.svelte";
  import MissingTokenOverlay from "./components/MissingTokenOverlay.svelte";
  import PreflightOverlay from "./components/PreflightOverlay.svelte";
  import BubbleOverlay from "./components/BubbleOverlay.svelte";
  import PathPromptModal from "./components/PathPromptModal.svelte";
  import PaneModeHelp from "./components/PaneModeHelp.svelte";
  import PromptModal from "./components/PromptModal.svelte";
  import SearchPanel from "./components/SearchPanel.svelte";
  import CommandLauncher from "./components/CommandLauncher.svelte";
  import SettingsOverlay from "./components/SettingsOverlay.svelte";
  import ImportContactsModal from "./components/ImportContactsModal.svelte";
  import Workspace from "./components/Workspace.svelte";
  import {
    applyInitialTheme,
    bootstrap,
    installSessionFlushHook,
    browserSelection,
    browserSidePanes,
    closeOverlay,
    applyLocalTheme,
    discardWindowSession,
    workspace,
    fileOps,
    openGraph,
    openGraphWithContext,
    pathPromptState,
    noteDraftCreated,
    persistLayoutToHash,
    schedulePersistStateToHash,
    promptState,
    reconnectWatcher,
    refreshWorkspace,
    refreshTree,
    resolveSpawnContext,
    revealAndSelect,
    revealPathInBrowser,
    scheduleSessionSave,
    searchPanel,
    launcherPanel,
    settingsPanel,
    openSettings,
    importContactsPanel,
    closeImportContacts,
    toggleCommandLauncher,
    setTransientStatus,
    syncOverlayStack,
    toggleBrowserSidePane,
    topOverlay,
    tree,
    ui,
    watchSystemTheme,
  } from "./state/store.svelte";
  import { confirmState } from "./state/confirm.svelte";
  import { windowModeAllowsCommand } from "./state/windowMode";
  import { initWindowTitle } from "./state/windowTitle";
  import {
    activeTabInPane,
    activeFileTab,
    activePane,
    activeTerminalTab,
    allPaneTabs,
    hasAnyTab,
    closeFind,
    closePane,
    closeTab,
    closeTabsInPane,
    consumeLastCloseWasMoveOut,
    cancelPaneMode,
    commitPaneMode,
    draftCloseState,
    enterPaneMode,
    isWindowFullyReadOnly,
    layout,
    createTeamWorkLeadTerminal,
    defaultBrowserInspectorOpen,
    openBrowserInActivePane,
    toggleActiveTerminalBroadcastSelectAll,
    isDocSavePaused,
    openFind,
    openInActivePane,
    openDashboardInActivePane,
    openInPane,
    scheduleAutosave,
    flipHybrid,
    selectNextPane,
    selectNextTabInActivePane,
    selectPrevPane,
    selectPrevTabInActivePane,
    selectTabAtIndexInActivePane,
    setActivePane,
    openTerminalInActivePane,
    paneActiveTabId,
    paneMode,
    paneModeEqualize,
    paneModeMoveFocus,
    paneModeOpenBrowser,
    paneModeOpenDashboard,
    paneModeOpenGraph,
    paneModeOpenTerminal,
    paneModeResize,
    paneModeSplit,
    paneModeStageDiagramEditor,
    paneModeStageDraftEditor,
    paneModeSwap,
    paneTabs,
    requestPaneSideToggleFlash,
    resolveTabDestination,
    setWindowFocusColor,
    splitActive,
    toggleActiveFileTabMode,
    type PaneModeStagedDraftEditor,
  } from "./state/tabs.svelte";
  import { applyEditorTheme, DEFAULT_EDITOR_THEME } from "./state/editorTheme";
  import { flushPendingBufferWrites, pruneEditorBuffers } from "./state/editorBuffer";
  import { pruneTerminalSnapshots } from "./terminal/snapshotCache";
  import {
    hideWindowFromCloseConfirm,
    isTauriDesktop,
    reloadWindow,
    requestCloseWindow,
  } from "./api/desktop";
  import { activeTransferCount } from "./state/transfers.svelte";
  import { chordFromEvent, currentOS } from "./state/shortcuts";
  import {
    allCommands,
    commandContext,
    dispatchAllowsCommand,
  } from "./state/commands";
  import { windowCaps } from "./state/windowCaps";
  import { filesContext } from "./state/fileContext.svelte";
  import { loadExtensions } from "./state/extensions.svelte";
  import { createDiagramAndOpen } from "./state/commands/diagram";
  import { createSlidesAndOpen } from "./state/commands/slides";
  import {
    builtInChordSuperseded,
    commandIdForChord,
  } from "./state/keymapOverrides.svelte";
  import { api, openLocalColorWatch, openLocalThemeWatch } from "./api/client";
  import {
    applyInitialPageWidth,
    watchPageWidth,
  } from "./state/pageWidth.svelte";
  import {
    applyInitialPaneColor,
    applyLivePaneColor,
    seedInitialFocusColor,
    syncLiveFocusColorMenu,
  } from "./state/paneColor";
  import { installIdleTracker, setReadMode } from "./state/idle.svelte";
  import {
    installScreensaverTracker,
    loadScreensaverState,
    lockNow,
  } from "./state/screensaver.svelte";
  import ScreensaverOverlay from "./components/ScreensaverOverlay.svelte";

  // Keep the URL hash in sync with the current layout so reload (and
  // copy-paste of the URL) restores the same panes/tabs. We touch
  // every reactive bit of `layout` in the effect so Svelte tracks
  // mutations to nested arrays/strings: JSON.stringify in
  // serializeLayout() already does that, but the function is called
  // synchronously, and Svelte only tracks reads that happen *during*
  // the effect's run.
  const NEW_DRAFT_TITLE_SELECTION = {
    from: "# ".length,
    to: "# Draft".length,
  };
  let bootstrapped = $state(false);
  // `h` inside Hybrid Nav toggles a cheatsheet overlay listing every
  // in-mode binding. The flag lives in App.svelte because Hybrid Nav is
  // global (one transaction per Cmd+. press), no per-pane scoping needed.
  let paneModeHelpVisible = $state(false);

  // Every surface renders the deck inline, desktop included. The scope the
  // caller names is a starting hint only: the deck carries all four scopes,
  // so Computers is reached inside it rather than through a separate window.
  function showCommandLauncher(_mode: "contextual" | "computers" = "contextual"): void {
    toggleCommandLauncher();
  }
  $effect(() => {
    // Touch enough of the layout to trip reactivity on common
    // mutations (URL persistence) AND watch every file tab's content
    // for autosave.
    void layout.rootId;
    void layout.activePaneId;
    for (const node of Object.values(layout.nodes)) {
      if (node.kind !== "leaf") continue;
      void node.activeTabId;
      void node.bActiveTabId;
      void node.side;
      void node.tabs.length;
      void (node.bTabs?.length ?? 0);
      // The Hybrid visible side + per-Hybrid theme persist on the pane, not a
      // tab. Read them here so a bare side flip or theme change schedules the
      // save.
      void node.theme;
      for (const t of allPaneTabs(node)) {
        if (t.kind === "terminal") {
          void t.title;
          void t.broadcastEnabled;
          void t.broadcastTargetIds.length;
          continue;
        }
        if (t.kind !== "file") {
          if (t.kind === "graph") {
            void t.mode;
            void t.scopeId;
            void t.depth;
            void t.inspectorOpen;
            void t.pendingSelectId;
            void t.filters.link;
            void t.filters.tag;
            void t.filters.mention;
            void t.filters.language;
            void t.filters.img;
            void t.filters.folder;
          } else if (t.kind === "browser") {
            void t.inspectorOpen;
          } else {
            // Dashboard tab carries no reactivity-relevant state
            // (title is immutable, id is stable). Touch the id so
            // the effect still observes tab-list mutations cleanly.
            void t.id;
          }
          continue;
        }
        void t.path;
        void t.mode;
        // Reading t.content here makes the effect rerun on every
        // keystroke, which then debounces the actual save.
        void t.content;
        // Track caret so selection moves bump the URL hash too;
        // without this, the persisted layout never picks up the
        // updated offset and reloads land at doc start.
        void t.caret;
        void t.slidePreview?.open;
        void t.slidePreview?.index;
        void t.slidePreview?.mode;
        // Attached tabs save through the doc session, and a
        // connection-outage degraded tab suppresses the doomed PUT;
        // reading t.doc here re-arms autosave the moment a session
        // leaves those states (the status write re-runs this effect for
        // a dirty tab).
        if (bootstrapped && !t.loading && t.content !== t.saved && !isDocSavePaused(t)) {
          scheduleAutosave(node.id, t.id);
        }
      }
    }
    if (bootstrapped) {
      schedulePersistStateToHash();
      // Same payload, mirrored to the per-window session.json so
      // the layout restores on next launch. Heavier debounce than
      // the URL hash since it touches disk.
      scheduleSessionSave();
    }
  });

  // Mirror overlay open-state + per-overlay knobs into the URL hash
  // (for copy-paste portability) AND the session payload (for
  // close-and-quit restore). The hash captures every visible
  // surface so another browser opening the same URL lands on the
  // identical screen; the session also stores defaults for next
  // launch. Both helpers debounce internally.
  $effect(() => {
    if (!bootstrapped) return;
    void searchPanel.open;
    void searchPanel.query;
    void searchPanel.inspectorOpen;
    void browserSidePanes.left;
    void browserSidePanes.right;
    void browserSelection.path;
    // The graph + browser surfaces are tabs; their per-tab state
    // (scope/depth/filters/inspector) is tracked by the layout-walking
    // effect above, so this effect does not mirror overlay state.
    schedulePersistStateToHash();
    scheduleSessionSave();
  });

  // Push the active editor theme onto the document root whenever
  // the server-known workspace info changes. The CSS in editor/themes/*
  // keys typography + chrome off this attribute.
  $effect(() => {
    const theme = currentPreferences()?.editor_theme;
    applyEditorTheme(theme ?? DEFAULT_EDITOR_THEME);
  });

  // Single-writer bridge from per-tab read mode to the window-level
  // readMode flag (which workspaces the bottom pill's grey state and
  // the idle tracker's read-mode timing window). Computing this in
  // App.svelte means there's exactly one effect mutating the
  // signal regardless of how many panes are open, which avoids the
  // multi-pane fight that the previous per-FileEditorTab effect
  // produced (cleanup-then-set on every toggle, with sibling panes
  // racing to overwrite each other's value).
  $effect(() => {
    setReadMode(isWindowFullyReadOnly());
  });

  // Window-level overlay stack. Each overlay's `.open` flag is the
  // single source of truth for "is it on screen"; this effect mirrors
  // the set of currently-open overlays into `overlayStack.ids` so the
  // most-recently-opened paints on top and Escape can pop one overlay
  // at a time (handler below). Touching each flag explicitly is what
  // ties the effect to their reactivity; the helper doesn't read them
  // back through reactive paths.
  $effect(() => {
    void searchPanel.open;
    void launcherPanel.open;
    void settingsPanel.open;
    syncOverlayStack();
  });

  // Disposer for the per-library focus-colour watch (opened once per
  // window in the onMount below; closed on unmount).
  let disposeLocalColorWatch: (() => void) | null = null;
  onDestroy(() => disposeLocalColorWatch?.());
  // Only a local standalone terminal window follows the launcher's light/dark
  // choice (workspace windows keep the config theme). Closed on unmount.
  let disposeLocalThemeWatch: (() => void) | null = null;
  onDestroy(() => disposeLocalThemeWatch?.());

  onMount(async () => {
    // Apply persisted theme + default editor theme to the document
    // root immediately, before any component renders, to avoid a flash.
    applyInitialTheme();
    applyEditorTheme(DEFAULT_EDITOR_THEME);
    applyInitialPageWidth();
    // Per-window pane-highlight colour from the URL `?pane=<hex>` the desktop
    // mints. Sets `--pane-highlight-color` (consumed by the active-pane border
    // + focus halo in Pane.svelte) when the param is a valid hex; a no-op
    // otherwise, so the `data-focus-color` presets stay in effect.
    applyInitialPaneColor();
    // Title the browser tab the way the launcher names this window. Fire and
    // forget: it needs a library capability, and a window that cannot mint one
    // simply keeps the document's static title.
    void initWindowTitle();
    // Live per-library focus-colour broadcast. Subscribe ONCE PER
    // WINDOW (the var is per-document; <Pane> is per leaf node, so per-pane would
    // open redundant sockets) to this library's colour watch and recolour
    // `--pane-highlight-color` the instant ANY window of the library changes it --
    // replacing the v1 "other windows pick it up on next mint" behaviour. Pushes
    // the current colour on connect, so this also reconciles with `?pane=`.
    // Apply the var (border) AND sync the menu/`data-focus-color` so a live push
    // doesn't leave the checkmark + new split panes disagreeing with the border.
    // Disposed on unmount.
    //
    // Launcher-hosted surfaces only: the watch route lives on the root
    // launcher router, mounted by the desktop embedded host and the headless
    // devserver, the hosts every desktop window is served from. A standalone
    // `chan open` server never mounts it, so subscribing there just 404s the
    // handshake into the endless reconnect backoff. Same gating idea as the
    // sibling theme watch below (whose terminal-only windows are also
    // desktop-minted).
    if (isTauriDesktop()) {
      disposeLocalColorWatch = openLocalColorWatch((color) => {
        applyLivePaneColor(color);
        syncLiveFocusColorMenu(color, setWindowFocusColor);
      });
    }
    // A local standalone window follows the launcher's light/dark choice:
    // subscribe to the local-theme watch (push-on-connect seeds it, then live
    // on each toggle), applying `null` as OS-follow. Keyed on "no workspace"
    // rather than terminal-only, so a standalone window that also browses
    // files keeps following the launcher. Workspace windows never subscribe;
    // a devserver/remote terminal's host installs no theme store, so the
    // watch just reports null and the OS query stands.
    if (!windowCaps.workspace) {
      disposeLocalThemeWatch = openLocalThemeWatch((theme) => {
        applyLocalTheme(theme);
      });
    }
    // Match the focus-colour menu's checkmark to the library colour this
    // window opened with: if `?pane=` is one of the four preset hexes, select
    // that preset so `focusColorForWindow()` agrees with the colour shown. A
    // custom or absent colour leaves the menu at its default.
    seedInitialFocusColor(setWindowFocusColor);
    // While in "system" mode, follow OS-level theme changes live.
    // The listener stays alive for the whole app's lifetime.
    watchSystemTheme();
    // Cross-window sync of the page-width setting via the storage event.
    watchPageWidth();
    // Idle tracker: after 2.5s without scroll/click/keypress, the
    // floating pills fade. Any input flips them back on.
    installIdleTracker();
    // Screensaver inactivity tracker. Runs at a different cadence
    // (default 5 min, per-workspace configurable) with a wider event
    // set (keydown + scroll + pointer move) than the idle-pill tracker.
    // Listeners install unconditionally so a later /api/screensaver/state
    // load doesn't need a re-install pass; the lock fires only when
    // `enabled=true`.
    installScreensaverTracker();
    // Hook pagehide BEFORE bootstrap so a fast reload during the
    // initial load still flushes any in-flight session changes.
    installSessionFlushHook();
    await bootstrap();
    if (windowCaps.workspace) await loadExtensions();
    // The docked FB default lives in chan-server's
    // `BrowserSidePanes::default()`: a new preferences.toml ships with
    // both docks OFF (`left: false`), so a new workspace opens with just
    // the empty pane. SPA respects any user toggle; the load path reads
    // server preferences before this point. Empty pane stays empty; the
    // carousel + shortcut hints carry the empty-state UX.
    bootstrapped = true;
    // Fire-and-forget load of the per-workspace screensaver state.
    // Populates the singleton with the server-side enabled/timeout/
    // pin_set view. Failure is non-fatal (the singleton stays in its
    // default disarmed state). Terminal-only windows skip it: the slim
    // terminal tenant has no workspace to hold screensaver config and
    // mounts no /api/screensaver routes, so the tracker stays disarmed.
    if (windowCaps.workspace) {
      void loadScreensaverState();
    }
    // Resume hook after the tab (or the whole machine) was dormant. Browsers
    // throttle / suspend backgrounded tabs and the WebSocket reconnect can
    // stretch to seconds before the user returns; a manual nudge lands the
    // connection immediately. Debounced 300 ms so a quick tab-switch flicker
    // doesn't fire the reconnect twice.
    let resumeTimer: ReturnType<typeof setTimeout> | null = null;
    function scheduleResume(): void {
      if (resumeTimer) clearTimeout(resumeTimer);
      resumeTimer = setTimeout(() => {
        resumeTimer = null;
        reconnectWatcher();
        // The tree refresh hits /api/files and the workspace refresh
        // /api/workspace; a window gets each only where its tenant serves it,
        // so a terminals-only window takes the watcher reconnect alone.
        if (!windowCaps.files) return;
        void refreshTree();
        if (windowCaps.workspace) void refreshWorkspace();
      }, 300);
    }
    function onVisibility(): void {
      if (document.visibilityState !== "visible") return;
      scheduleResume();
    }
    document.addEventListener("visibilitychange", onVisibility);
    // macOS WKWebView holds the window "visible" + focused across a display /
    // system sleep, so visibilitychange never fires on wake. The shared
    // wall-clock detector catches that sleep off a late-firing coarse interval
    // and runs the same resume, so a post-sleep window is not left on a dead
    // watcher under a stale tree.
    installWakeGapDetector(scheduleResume);
  });

  /// Context-aware spawn helpers shared by all chord entry paths (top-level
  /// chords, Hybrid Nav, and `chan:command` events from chan-desktop).
  /// Each resolves the focused surface's context via `resolveSpawnContext`
  /// so all entry points (chord / Hybrid Nav / hamburger / right-click)
  /// behave identically.
  /// `profile` is the shell the picker chose; absent uses the server's default
  /// profile. It rides this path rather than opening a tab directly so a
  /// picked shell still gets the rootUnavailable guard, the resolved spawn
  /// cwd, and the session save that every other entry point gets.
  function spawnTerminalFromContext(profile?: string): void {
    if (tree.rootUnavailable) {
      setTransientStatus(
        `New terminal failed: ${tree.error ?? "workspace root does not exist"}`,
      );
      return;
    }
    const ctx = resolveSpawnContext();
    openTerminalInActivePane({ cwd: ctx.dir, profile });
    scheduleSessionSave();
  }
  function spawnBrowserFromContext(): void {
    // A window whose tenant serves no filesystem has no browser surface
    // (there is no /api/files to list); the spawn is a no-op.
    if (!windowCaps.files) return;
    const ctx = resolveSpawnContext();
    // With no context to open at, a workspace window lands on its root -- but
    // a standalone window's root is `/`, so it lands on the home directory
    // its tenant reported instead of the whole machine.
    const rootless = windowCaps.workspace ? null : (filesContext.current?.homeWire ?? null);
    const dir = ctx.dir || rootless;
    // A directory target is ENTERED, not merely highlighted. `revealAndSelect`
    // expands ancestors only, so a standalone window -- whose root is the whole
    // machine -- rendered `/` with the target collapsed somewhere below it, and
    // the user had to walk down to the directory they had just asked for. This
    // is the same defect the fresh-Files-window boot already fixed for itself;
    // the spawn path kept selecting. Opening at `$HOME` rather than `/` is the
    // visible half of it on a standalone terminal window.
    if (dir !== null && dir !== undefined && ctx.file === undefined) {
      revealPathInBrowser(dir, {
        enter: true,
        // Keep the pane's own default rather than forcing the inspector open:
        // this is a spawn, not a reveal-this-entry gesture.
        inspectorOpen: defaultBrowserInspectorOpen(),
      });
      scheduleSessionSave();
      return;
    }
    const select = ctx.file;
    // Prime the expanded-dirs map + browserSelection so the new
    // tab's tree opens with the context path visible.
    if (select) revealAndSelect(select);
    // Always spawn a new FB tab so this chord stays consistent with the
    // other spawn chords (Cmd+T = new terminal every press). The `select` arg threads the context
    // path into the tab's `selected` field directly so `restoreFromTab`'s
    // mount wipe doesn't clobber the prime.
    openBrowserInActivePane({ select });
    scheduleSessionSave();
  }
  /// Team Work entry: instantiates the Lead Terminal (fresh terminal with
  /// the markdown editor armed) then opens the Spawn-agents dialog over it.
  /// The dialog owns Cancel (deletes the lead tab) and Bootstrap. The
  /// pane-mode "P" key spawns a plain Team Work terminal without the dialog.
  function spawnTeamWorkFromContext(): void {
    // Team Work needs a workspace (the lead terminal arms the markdown
    // editor + drafts dir), so it is a workspace-window spawn only.
    if (!windowCaps.workspace) return;
    const ctx = resolveSpawnContext();
    const lead = createTeamWorkLeadTerminal({ cwd: ctx.dir });
    if (!lead) return;
    openTeamDialog({ leadTabId: lead.id, leadPaneId: activePane().id });
    scheduleSessionSave();
  }
  function spawnGraphFromContext(): void {
    // No graph surface without a workspace (no /api/graph route).
    if (!windowCaps.workspace) return;
    const ctx = resolveSpawnContext();
    openGraphWithContext(ctx);
  }

  /// App-level keyboard shortcuts. Layout follows VS Code where possible.
  ///
  /// Context-aware spawn chords (each resolves focused surface context):
  ///   Cmd+T          -> Terminal (native; Cmd+Alt+T on web Mac)
  ///   Cmd+O          -> File Browser (native; Cmd+Alt+O on web Mac)
  ///   Cmd+P          -> Team Work (native; Cmd+Alt+P on web Mac)
  ///   Cmd+Shift+M    -> Graph (native + web)
  ///   Mod+. t/o/p/m  -> universal aliases via Hybrid Nav
  ///
  /// Other app chords:
  ///   Cmd/Ctrl+,             -> Settings
  ///   Cmd+Shift+S            -> Search on macOS
  ///   Ctrl+Alt+S             -> Search on Linux / Windows
  ///   Cmd+. L                -> Lock screen
  ///   Alt+Shift+[ / ]        -> previous / next tab  (web fallback)
  ///   Ctrl+Alt+1..9          -> jump to tab N        (web fallback)
  ///   Ctrl+Alt+/             -> split pane right     (web fallback)
  ///   Ctrl+Alt+?             -> split pane bottom    (web fallback)
  ///
  /// Mac note: bare-Alt chords are off-limits for letters/digits because
  /// Option is a dead-key for special characters (Alt+G prints `c`, etc.).
  /// All letter/digit chords use Cmd/Ctrl-based combos or Ctrl+Alt.
  /// Alt+Shift+[/] is kept only because we match by `e.code` and
  /// preventDefault suppresses the typed glyph before it reaches the editor.
  ///
  /// Browser-reserved chord notes:
  ///   Cmd+P (browser print) -> preventDefault wins in Chrome/Safari/Firefox.
  ///   Cmd+W / Cmd+N / Cmd+Shift+[/] / Cmd+1..9 are OS-level reserved in
  ///   browsers; native binds the VS Code-shaped chords directly.
  ///
  /// True when a modal or search overlay owns the keyboard. The pane-flip
  /// command must bail here to avoid flipping a pane hidden behind a dialog.
  function paneChordBlocked(): boolean {
    return (
      topOverlay() !== null ||
      promptState.open ||
      pathPromptState.open ||
      confirmState.open ||
      draftCloseState.open ||
      // Anything else rendered OVER the pane owns the keyboard too: the
      // Team Work setup dialog, the file-conflict modal, and the
      // workspace-warnings modal. Each mirrors that modal's own render
      // condition so the guard tracks exactly when it's on screen.
      // Flipping behind any of these would toggle a pane the user can't
      // see.
      teamDialogState.request !== null ||
      conflictDialog.open ||
      workspaceWarningsDialog.open ||
      importContactsPanel.open ||
      // Pane-local modals (currently MCP-env info in a terminal pane)
      // register here while open since their visibility isn't an
      // app-root flag.
      paneModalGuard.openCount > 0
    );
  }

  function onWindowKey(e: KeyboardEvent): void {
    const meta = e.metaKey || e.ctrlKey;
    // While the disconnect overlay blocks the UI, swallow every global
    // shortcut: the backdrop stops clicks but not document-level keystrokes,
    // so without this a chord like Ctrl+D would still close a tab behind the
    // overlay. The overlay's own Retry button (a focused element) is
    // unaffected; there is nothing else to drive while the server is gone.
    if (ui.disconnectBlocking) {
      // Let cmd+` through to the native window cycler: the overlay must not trap
      // the macOS window-switch chord, so the user can leave a disconnected
      // window for another (mac-relevant only; a harmless no-op elsewhere).
      if (e.code === "Backquote") return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (paneMode.active) {
      e.preventDefault();
      e.stopPropagation();
      handlePaneModeKey(e);
      return;
    }
    // A user-assigned override chord fires its command ahead of the
    // built-in chords below. Only overrides match here (commandIdForChord
    // skips a chord equal to the command's own built-in, so the default
    // branch and this path never double-fire), and cmd.available re-applies
    // the same window-mode + surface gate the launcher shows.
    {
      const overrideChord = chordFromEvent(e);
      const commands = allCommands();
      const overrideId = overrideChord
        ? commandIdForChord(overrideChord, commands)
        : undefined;
      if (overrideId) {
        if (overrideId === "app.launcher.toggle") {
          e.preventDefault();
          showCommandLauncher("contextual");
          return;
        }
        if (overrideId === "app.launcher.computers" && isTauriDesktop()) {
          e.preventDefault();
          showCommandLauncher("computers");
          return;
        }
        const cmd = commands.find((c) => c.id === overrideId);
        if (cmd && cmd.available(commandContext())) {
          e.preventDefault();
          cmd.run();
          return;
        }
      }
    }
    const os = currentOS();
    const commandLauncherChord =
      isTauriDesktop() && os === "mac"
        ? e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "KeyK"
        : e.ctrlKey && !e.metaKey && e.altKey && !e.shiftKey && e.code === "KeyK";
    if (commandLauncherChord) {
      e.preventDefault();
      showCommandLauncher("contextual");
      return;
    }
    const settingsChord =
      os === "mac"
        ? e.metaKey &&
          !e.ctrlKey &&
          !e.altKey &&
          !e.shiftKey &&
          e.code === "Comma"
        : e.ctrlKey &&
          !e.metaKey &&
          !e.altKey &&
          !e.shiftKey &&
          e.code === "Comma";
    if (settingsChord && !builtInChordSuperseded("app.settings.open")) {
      e.preventDefault();
      openSettings();
      return;
    }
    const searchChord =
      os === "mac"
        ? e.metaKey && !e.ctrlKey && !e.altKey && e.shiftKey && e.code === "KeyS"
        : e.ctrlKey && !e.metaKey && e.altKey && !e.shiftKey && e.code === "KeyS";
    if (searchChord && !builtInChordSuperseded("app.search.toggle")) {
      // Swallow the chord either way (the browser's Save dialog must not
      // open), but route the toggle through runCommand: its window-mode gate
      // drops it in terminal-only/control windows, where the slim tenant
      // serves no search routes and the overlay would 404.
      e.preventDefault();
      runCommand("app.search.toggle", {});
      return;
    }
    // Cmd+. enters Hybrid Nav. Cmd+, / Ctrl+, opens Settings above so the
    // pane flip stays on its explicit command or user-assigned chord.
    // Cmd+. is not browser-reserved on macOS (Safari + Chrome both let JS
    // intercept it), so the same chord works on the web SPA and desktop shell.
    if (meta && !e.shiftKey && !e.altKey && e.code === "Period") {
      e.preventDefault();
      enterPaneMode();
      return;
    }
    if (
      e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.shiftKey &&
      e.code === "Backquote" &&
      !builtInChordSuperseded("app.pane.flip")
    ) {
      e.preventDefault();
      if (!paneChordBlocked()) flipHybrid(layout.activePaneId);
      return;
    }
    // Escape: pop just the topmost overlay so a stack of open
    // surfaces unwinds one at a time.
    if (e.key === "Escape" && !meta && !e.altKey && !e.shiftKey) {
      const top = topOverlay();
      if (top) {
        e.preventDefault();
        closeOverlay(top);
      return;
    }
  }

  function handlePaneModeKey(e: KeyboardEvent): void {
    if (paneMode.stale) {
      if (e.key === "Escape") {
        cancelPaneMode();
        paneModeHelpVisible = false;
      } else if (e.key === "h" || e.key === "H") {
        paneModeHelpVisible = !paneModeHelpVisible;
      }
      return;
    }
    const large = e.shiftKey ? 0.1 : 0.02;
    switch (e.key) {
      case "Enter": {
        // Prime browserSelection before commit when a browser spawn is staged
        // so the new tab's tree opens with the context path visible.
        // Peek the intent before commitPaneMode clears it.
        // revealAndSelect is a no-op for empty paths.
        const intent = paneMode.spawnIntent;
        if (intent && intent.kind === "browser") {
          if (intent.ctx.file) revealAndSelect(intent.ctx.file);
          else if (intent.ctx.dir) revealAndSelect(intent.ctx.dir);
        }
        const stagedEditors = paneMode.stagedDraftEditors.slice();
        commitPaneMode();
        scheduleSessionSave();
        paneModeHelpVisible = false;
        materializeStagedDraftEditors(stagedEditors);
        return;
      }
      case "Escape":
        // Discard staged additions. T / O / G / B additions live inside the
        // draft layout and disappear automatically when commitPaneMode does
        // not run. Esc bails before materializeStagedDraftEditors fires,
        // so no orphan drafts are created.
        cancelPaneMode();
        paneModeHelpVisible = false;
        return;
      case "Tab":
        if (paneMode.draft) flipHybrid(paneMode.draft.activePaneId);
        return;
      // Arrows navigate (move focus); WASD moves tiles (swap).
      // Intentionally asymmetric: arrow = focus, letter = move.
      case "ArrowUp":
        paneModeMoveFocus("up");
        return;
      case "ArrowLeft":
        paneModeMoveFocus("left");
        return;
      case "ArrowDown":
        paneModeMoveFocus("down");
        return;
      case "ArrowRight":
        paneModeMoveFocus("right");
        return;
      case "w":
      case "W":
        paneModeSwap("up");
        return;
      case "a":
      case "A":
        paneModeSwap("left");
        return;
      // `s` / `S` are in the WASD swap-tile group.
      case "s":
      case "S":
        paneModeSwap("down");
        return;
      case "d":
      case "D":
        paneModeSwap("right");
        return;
      case "[":
        paneModeResize("row", false, large);
        return;
      case "]":
        paneModeResize("row", true, large);
        return;
      case "-":
        paneModeResize("column", false, large);
        return;
      case "=":
        paneModeResize("column", true, large);
        return;
      case "0":
        paneModeEqualize();
        return;
      // Hybrid Nav `t` STAGES a new terminal into the draft layout instead of
      // committing immediately. Multiple presses stack; Enter materializes,
      // Esc discards.
      case "t":
      case "T":
        paneModeOpenTerminal(resolveSpawnContext());
        return;
      case "o":
      case "O":
        if (!windowCaps.files) return;
        paneModeOpenBrowser(resolveSpawnContext());
        return;
      case "g":
      case "G":
        if (!windowCaps.workspace) return;
        paneModeOpenGraph(resolveSpawnContext());
        return;
      case "b":
      case "B":
        if (!windowCaps.workspace) return;
        paneModeOpenDashboard();
        return;
      case "n":
      case "N":
        if (!windowCaps.workspace) return;
        paneModeStageDraftEditor();
        return;
      case "i":
      case "I":
        if (!windowCaps.workspace) return;
        paneModeStageDiagramEditor();
        return;
      // `h` toggles the Hybrid Nav help cheatsheet without committing the draft;
      // the user is still shaping their layout.
      case "h":
      case "H":
        paneModeHelpVisible = !paneModeHelpVisible;
        return;
      // `<` / `>` toggle the docked file browsers. Arrow direction is
      // intentionally opposite to the dock side:
      //   `<` (less-than) -> right dock toggle
      //   `>` (greater-than) -> left dock toggle
      // Same commit-then-act semantics as the other exit keys.
      case "<":
        // Docked file browsers: they need a filesystem to list.
        if (!windowCaps.files) return;
        commitPaneMode();
        scheduleSessionSave();
        toggleBrowserSidePane("right");
        return;
      case ">":
        if (!windowCaps.files) return;
        commitPaneMode();
        scheduleSessionSave();
        toggleBrowserSidePane("left");
        return;
      // Split right (`/`) and split bottom (`?` = Shift+/) mirror the
      // top-level Cmd+/ / Cmd+Shift+/ chords. New pane lands as the focus
      // so subsequent transaction edits target it. `?` avoids 1Password's
      // global Cmd+\ hotkey.
      case "/":
        paneModeSplit("row");
        return;
      case "?":
        paneModeSplit("column");
        return;
    }
  }
    // New terminal (registry app.terminal.toggle). On the web the chord is
    // the literal Ctrl+Shift+T on every OS; the desktop uses Cmd+T (mac) /
    // Ctrl+Shift+T (off-mac) through KEY_BRIDGE_JS -> the app.terminal.toggle
    // command. On a browser Ctrl+Shift+T is the reopen-tab chord, so we
    // preventDefault and browser clients rebind if the browser wins.
    if (e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && e.code === "KeyT") {
      e.preventDefault();
      spawnTerminalFromContext();
      return;
    }
    // `terminal.richPrompt` toggles the Rich Prompt bubble, PER-TERMINAL, on
    // the focused pane's active terminal only. No-op when the focused tab is
    // not a terminal. Cmd+Shift+P on macOS; Ctrl+Shift+P off macOS on both the
    // desktop webview and the browser (the Win/Super key is ruled out). On a
    // browser Ctrl+Shift+P is the private-window chord, so we preventDefault
    // and browser clients rebind. Keep in sync with osChord's RICH_PROMPT_ID
    // branch. Also on the terminal right-click row and the launcher entry.
    if (e.code === "KeyP") {
      const richPromptChord =
        currentOS() === "mac"
          ? e.metaKey && !e.ctrlKey && !e.altKey && e.shiftKey
          : e.ctrlKey && !e.metaKey && !e.altKey && e.shiftKey;
      if (richPromptChord) {
        e.preventDefault();
        // Rich Prompt is workspace-only.
        if (!windowCaps.workspace) return;
        const term = activeTerminalTab();
        if (term) toggleRichPromptForTab(term.id);
        return;
      }
    }
    // `app.terminal.broadcastToggle` flips broadcast select-all for the
    // focused pane's active terminal group. Cmd+Shift+I on the macOS
    // desktop only (the registry mints no off-mac or web default; those
    // surfaces bind through user overrides, which fire in the override
    // path above). Keep in sync with osChord's BROADCAST_TOGGLE_ID branch.
    if (e.code === "KeyI" && isTauriDesktop() && currentOS() === "mac") {
      const broadcastChord =
        e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        e.shiftKey &&
        !builtInChordSuperseded("app.terminal.broadcastToggle");
      if (broadcastChord) {
        e.preventDefault();
        toggleActiveTerminalBroadcastSelectAll();
        return;
      }
    }
    // Web-only pane nav: Cmd+[/] is browser back/forward so the web build
    // moves pane nav onto Alt+[/]. Desktop handles this via KEY_BRIDGE_JS
    // with stopImmediatePropagation before this handler runs. Match by
    // `e.code` to prevent Option-mangled glyphs; `!e.shiftKey` keeps
    // Alt+Shift+[/] (tab nav) separate.
    if (e.altKey && !e.shiftKey && !meta && e.code === "BracketLeft") {
      e.preventDefault();
      selectPrevPane();
      return;
    }
    if (e.altKey && !e.shiftKey && !meta && e.code === "BracketRight") {
      e.preventDefault();
      selectNextPane();
      return;
    }
    // Cmd+W is the macOS close-tab primary (registry app.tab.close). The
    // control terminal takes the same path as every other window kind:
    // app.tab.close reaches confirmCloseTabs, which prompts when the
    // connect script's PTY is live, and the terminal-only $effect closes
    // the window once the last tab is gone. Off-mac Ctrl+W is not
    // claimed here (off-mac tab close is Ctrl+Shift+W via the desktop
    // bridge; Ctrl+D is the alternate; the browser owns Ctrl+W), so it
    // falls through.
    if (meta && !e.altKey && !e.shiftKey && e.code === "KeyW") {
      if (e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        runCommand("app.tab.close", {});
        return;
      }
    }
    if (e.altKey && e.shiftKey && !meta) {
      // e.code is layout-and-modifier-independent, so this branch
      // matches even though Option mangles e.key into `«` / `»` on
      // a US Mac layout. preventDefault suppresses the typed
      // character before it reaches the focused editor.
      if (e.code === "BracketLeft") {
        e.preventDefault();
        selectPrevTabInActivePane();
        return;
      }
      if (e.code === "BracketRight") {
        e.preventDefault();
        selectNextTabInActivePane();
        return;
      }
    }
    // Ctrl+Alt+1..9 jump-to-tab. e.code === "Digit<N>" so the
    // comparison survives modifiers changing e.key to a glyph on
    // non-US layouts AND Option mangling it on Mac. metaKey
    // excluded so this is distinct from Cmd+1..9 (which the
    // browser owns for tab switching).
    if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey) {
      const m = e.code.match(/^Digit([1-9])$/);
      if (m) {
        e.preventDefault();
        selectTabAtIndexInActivePane(Number(m[1]) - 1);
        return;
      }
    }
    // Web split. Native uses Cmd+/ through KEY_BRIDGE_JS. On web, Ctrl+/ is
    // claimed by the terminal and editor comment-toggle, so this uses the
    // Ctrl+Alt fallback family and routes through the command guards.
    if (e.ctrlKey && e.altKey && !e.metaKey && e.code === "Slash") {
      e.preventDefault();
      runCommand(e.shiftKey ? "app.pane.splitDown" : "app.pane.splitRight", {});
      return;
    }
    // Window reload. macOS: Cmd+R. Linux/Windows: Ctrl+Shift+R, so plain
    // Ctrl+R falls through to a focused terminal's shell (reverse-search) -
    // claiming Ctrl+R here is exactly what the old `Mod+R` binding did and
    // what regressed reverse-search. Branch per-OS (the desktop bridge and
    // shouldEscapeTerminal apply the same Cmd-vs-Ctrl+Shift rule).
    // preventDefault suppresses the browser default (soft reload via
    // reloadWindow / the desktop IPC).
    const reloadChord =
      currentOS() === "mac"
        ? e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "KeyR"
        : e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && e.code === "KeyR";
    if (reloadChord) {
      e.preventDefault();
      void reloadWindow();
      return;
    }
    // Hide window (registry app.window.hide = native Mod+Shift+H): the
    // close-confirm overlay's Hide answer without the prompt -- bury this
    // window via the desktop IPC (sessions stay warm, the record persists
    // hidden and reopens from the launcher). Desktop-only: the IPC is an
    // explicit no-op in a plain browser, so no web chord is claimed.
    // Cmd+Shift+H on macOS, Ctrl+Shift+H on Linux / Windows.
    if (e.code === "KeyH" && isTauriDesktop()) {
      const hideChord =
        (currentOS() === "mac"
          ? e.metaKey && !e.ctrlKey && !e.altKey && e.shiftKey
          : e.ctrlKey && !e.metaKey && !e.altKey && e.shiftKey) &&
        !builtInChordSuperseded("app.window.hide");
      if (hideChord) {
        e.preventDefault();
        void hideWindowFromCloseConfirm();
        return;
      }
    }
    // Mod+E (Obsidian-style "Show Source Code") flips the active file tab
    // between source and rendered views. No-op when no file tab is active.
    // Split per-OS so Ctrl+E reaches it off macOS (registry
    // app.editor.toggleMode = Mod+E).
    const toggleModeChord =
      currentOS() === "mac"
        ? e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "KeyE"
        : e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === "KeyE";
    if (toggleModeChord) {
      e.preventDefault();
      toggleActiveFileTabMode();
      return;
    }
    // No `KeyI` branch here: the editor claims Cmd+I for italic
    // (Wysiwyg.svelte's CM6 keymap); outside the editor Cmd+I is inert.
    // Dashboard is reachable from the launcher and the pane hamburger.
  }

  async function createDraftAndOpen(): Promise<void> {
    try {
      const { path } = await api.createDraft();
      await noteDraftCreated(path);
      await openInActivePane(path, {
        initialSelection: NEW_DRAFT_TITLE_SELECTION,
      });
    } catch (err) {
      console.warn("[chan] createDraft failed", err);
      setTransientStatus(`New draft failed: ${(err as Error).message}`);
    }
  }

  /// Materialize every staged editor independently after the layout commits.
  /// `allSettled` consumes every result, so one failed request cannot cancel a
  /// sibling or roll back a file that was already created.
  function materializeStagedDraftEditors(
    queue: readonly PaneModeStagedDraftEditor[],
  ): void {
    const creations = queue.map(async (entry) => {
      try {
        const { path } =
          entry.kind === "diagram"
            ? await api.createDiagram()
            : await api.createDraft();
        try {
          await noteDraftCreated(path);
        } catch (err) {
          console.warn("[chan] staged editor workspace refresh failed", err);
        }
        const recorded = resolveTabDestination({
          paneId: entry.paneId,
          side: entry.side,
        });
        const destination = recorded ?? resolveTabDestination();
        if (!destination) throw new Error("no pane available for created file");
        await openInPane(destination.paneId, path, {
          side: destination.side,
          ...(entry.kind === "draft"
            ? { initialSelection: NEW_DRAFT_TITLE_SELECTION }
            : {}),
        });
        if (!recorded) {
          setTransientStatus("Target pane disappeared; opened here.");
        }
      } catch (err) {
        console.warn("[chan] paneMode stagedDraftEditor failed", err);
        const kind = entry.kind === "diagram" ? "diagram" : "draft";
        setTransientStatus(`New ${kind} failed: ${(err as Error).message}`);
        throw err;
      }
    });
    void Promise.allSettled(creations);
  }
  function leafPaneCount(): number {
    return Object.values(layout.nodes).filter((node) => node.kind === "leaf").length;
  }
  function closeTabsInActivePane(): void {
    const paneId = layout.activePaneId;
    void closeTabsInPane(paneId).then((closed) => {
      if (closed) scheduleSessionSave();
    });
  }
  function killActivePane(opts?: { force?: boolean }): void {
    const paneId = layout.activePaneId;
    void closePane(paneId, opts).then((closed) => {
      if (closed) scheduleSessionSave();
    });
  }
  function closeActiveEmptyPane(): boolean {
    const p = activePane();
    if (paneTabs(p).length !== 0) return false;
    if (allPaneTabs(p).length !== 0) {
      requestPaneSideToggleFlash(p.id);
      flipHybrid(p.id);
      return true;
    }
    // The last empty pane triggers window close on desktop, returning focus
    // to the workspace launcher. Web stays a no-op (Cmd+W falls through to
    // the browser). The launcher's CloseRequested hides rather than destroys,
    // so re-showing is instant.
    if (leafPaneCount() <= 1) {
      if (isTauriDesktop()) {
        // A user-initiated close of an empty window (Cmd+W / ^W / ^D) is an
        // intentional DISCARD: delete its blob synchronously before the host
        // destroys the window, so it never lingers in `cs window list`. Suppress
        // the reap if the window emptied via a terminal move-out (the moved PTY
        // must survive in the target window). (Restored-empty windows survive a
        // RESTART via the persisted record + the native-close bury, not by
        // blocking this explicit close.)
        discardWindowSession({ reap: !consumeLastCloseWasMoveOut() });
        void requestCloseWindow();
        return true;
      }
      return false;
    }
    killActivePane({ force: true });
    return true;
  }
  // Standalone windows never sit empty: when the last tab is closed (by any
  // path - tab close, Cmd+W, pane close), close the window. The rule is
  // "empty", not "no terminals left": a standalone window whose tenant serves
  // files may hold a browser or an editor after its shells are gone, and that
  // window is still showing the user something. Where the tenant serves no
  // files the two are the same thing, since terminals are the only tab kind
  // such a window can hold. `terminalArmed` is set by bootstrap only AFTER the
  // first tab exists, so the transient empty layout during boot can't trip
  // this. No-op in workspace mode and on the web (requestCloseWindow gates on
  // the desktop).
  //
  // Arming is the FIRST TAB of any kind -- terminal, file browser or editor --
  // rather than a line at the end of bootstrap. A `seed=0` window (minted by a
  // routed `cs open`) deliberately boots with no tab at all and waits for the
  // frame parked for it, so arming at boot would let it close itself, reaping
  // its own session blob, before its content ever arrived.
  $effect(() => {
    if (windowCaps.workspace || ui.terminalArmed) return;
    if (hasAnyTab()) ui.terminalArmed = true;
  });

  $effect(() => {
    if (windowCaps.workspace || !ui.terminalArmed) return;
    if (hasAnyTab()) return;
    // Last terminal closed (^W / ^D / Cmd+W): the window is empty, which is a
    // discard -- delete its blob before the host destroys the window so it
    // leaves nothing in `cs window list`. But if the window emptied because its
    // terminal MOVED to another window, suppress the reap: the moved PTY lives
    // on (re-bound to the target), and the source's synchronous DELETE could
    // otherwise beat the target's re-attach and kill it.
    if (isTauriDesktop()) {
      discardWindowSession({ reap: !consumeLastCloseWasMoveOut() });
      void requestCloseWindow();
    }
  });
  onMount(() => document.addEventListener("keydown", onWindowKey));
  // SPA-global file-drop guard: an OS file dropped outside an
  // intentional zone must never navigate the webview away from the
  // SPA (see state/fileDropGuard.ts). Installed for the App's whole
  // lifetime; in-page drags are untouched (Files-type gate).
  onMount(() => installFileDropGuard());
  onDestroy(() => document.removeEventListener("keydown", onWindowKey));

  /// Ctrl+D: close the focused non-terminal tab. Terminal tabs forward
  /// Ctrl+D to the shell as EOF; this handler stays out of that path.
  /// The listener fires at CAPTURE phase to pre-empt CodeMirror's
  /// `selectNextOccurrence` binding; bubble phase loses the race and
  /// leaves a stale multi-selection on every close.
  function onCtrlDCapture(e: KeyboardEvent): void {
    if (!e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (builtInChordSuperseded("app.tab.close")) return;
    // e.key is lowercase "d" or uppercase "D" depending on
    // caps-lock; e.code === "KeyD" is layout-agnostic and matches
    // both. The keystroke we care about is the literal Ctrl + the
    // physical D key, not a shifted variant or a Cmd-modified one.
    if (e.code !== "KeyD") return;
    // The disconnect overlay blocks the UI: swallow Ctrl+D entirely (capture
    // phase, so the terminal/editor behind the overlay never sees it) rather
    // than closing a tab the user can't act on.
    if (ui.disconnectBlocking) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // In-house modals + the Hybrid Nav dispatcher own their
    // own keyboard contexts; never close a tab from under them.
    if (promptState.open || pathPromptState.open || confirmState.open || draftCloseState.open) {
      return;
    }
    if (paneMode.active) return;
    const p = activePane();
    const active = activeTabInPane(p);
    if (!active) {
      if (closeActiveEmptyPane()) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    // Terminal: leave the event alone so xterm forwards Ctrl+D
    // (EOF) to the shell. The shell exit collapses the tab through
    // the existing terminal-session lifecycle.
    if (active.kind === "terminal") return;
    // Excalidraw canvas: leave Ctrl+D for the board (its duplicate
    // chord off macOS). Only in canvas mode; source mode of the same
    // file closes the tab like any other editor.
    if (active.kind === "file" && active.mode === "canvas") return;
    // Files / Graph / Doc tabs: pre-empt the default handler and
    // close the tab. stopPropagation prevents CodeMirror's
    // selectNextOccurrence from firing on the same keystroke.
    e.preventDefault();
    e.stopPropagation();
    void closeTab(p.id, active.id);
  }
  onMount(() => document.addEventListener("keydown", onCtrlDCapture, true));
  onDestroy(() => document.removeEventListener("keydown", onCtrlDCapture, true));

  /// Host-driven command bridge. Native wrappers dispatch a `chan:command`
  /// window event to trigger actions by stable string id without depending
  /// on any in-app key chord. Unknown ids are a no-op so hosts can ship
  /// ahead of chan adding the command.
  function runCommand(name: string, detail: Record<string, unknown>): void {
    const commandName = name === "app.settings.toggle" ? "app.pane.flip" : name;
    // Terminal-only and control windows drop the commands they can't run;
    // windowMode.ts is the single gate the command launcher's availability
    // reads too, so a hidden launcher row and a dropped dispatch never
    // disagree.
    if (
      !windowModeAllowsCommand(commandName, {
        terminalOnly: ui.terminalOnly,
        terminalControl: ui.terminalControl,
      })
    )
      return;
    // Every window that is more than terminals gates on the catalog's
    // requirement table instead of the terminal allow-list: ids beyond its
    // capabilities (and ids the catalog does not classify) drop before the
    // dispatch switch, the same filter the launcher's visibility applies.
    if (!ui.terminalOnly && !dispatchAllowsCommand(commandName, windowCaps))
      return;
    switch (commandName) {
      case "app.settings.open":
        openSettings();
        return;
      case "app.window.reload":
        void reloadWindow();
        return;
      case "app.pane.mode":
        enterPaneMode();
        return;
      case "app.pane.flip":
        if (paneChordBlocked()) return;
        flipHybrid(layout.activePaneId);
        return;
      // chan-desktop's KEY_BRIDGE_JS fires these ids on native Cmd+T /
      // Cmd+O / Cmd+P / Cmd+Shift+M. Same context-aware helpers as the web
      // chords so both platforms behave identically.
      case "app.files.toggle":
        spawnBrowserFromContext();
        return;
      case "app.search.toggle":
        searchPanel.open = !searchPanel.open;
        return;
      case "app.launcher.toggle":
        showCommandLauncher("contextual");
        return;
      case "app.launcher.computers":
        if (isTauriDesktop()) showCommandLauncher("computers");
        return;
      case "app.graph.toggle":
        spawnGraphFromContext();
        return;
      case "app.terminal.toggle":
        spawnTerminalFromContext(
          typeof detail.profile === "string" ? detail.profile : undefined,
        );
        return;
      case "app.terminal.teamWork":
        spawnTeamWorkFromContext();
        return;
      case "app.terminal.broadcastToggle":
        toggleActiveTerminalBroadcastSelectAll();
        return;
      case "terminal.richPrompt": {
        const term = activeTerminalTab();
        if (term) toggleRichPromptForTab(term.id);
        return;
      }
      // Route through createDraftAndOpen so the command launcher, pane
      // hamburger Apps row, Cmd+N chord, and desktop native menu all
      // converge on a single handler.
      case "app.draft.new":
        void createDraftAndOpen();
        return;
      // Chordless Apps spawns: the launcher catalog run()s these actions
      // directly, and the pane hamburger's Apps rows (plus any host
      // bridge) reach the same handlers through this dispatch.
      case "app.diagram.new":
        void createDiagramAndOpen();
        return;
      case "app.slides.new":
        void createSlidesAndOpen();
        return;
      // Plain Cmd+L is deliberately not claimed by App.svelte so the
      // browser location bar keeps working; lock is only via this command
      // or Hybrid Nav `L`.
      case "app.screensaver.lock":
        lockNow();
        return;
      // Open Dashboard in the active pane. Same command from the command
      // launcher, pane hamburger Apps row, and carousel slide-1 button.
      case "app.dashboard.open":
        openDashboardInActivePane();
        return;
      // Obsidian-style Mod+E "Show Source Code" toggle. Flips the active
      // file tab's mode between source and rendered surface. No-op when
      // no file tab is active.
      case "app.editor.toggleMode":
        toggleActiveFileTabMode();
        return;
      case "app.pane.next":
        selectNextPane();
        return;
      case "app.pane.prev":
        selectPrevPane();
        return;
      case "app.pane.closeTabs":
        closeTabsInActivePane();
        return;
      case "app.pane.kill":
        killActivePane();
        return;
      // Top-level split chords (desktop Cmd+/ right, Cmd+Shift+/ bottom via
      // KEY_BRIDGE_JS). row = split right, column = split bottom, matching
      // the Hybrid Nav `/` and `?` keybinds.
      case "app.pane.splitRight":
        splitActive("row");
        return;
      case "app.pane.splitDown":
        splitActive("column");
        return;
      case "app.tab.next":
        selectNextTabInActivePane();
        return;
      case "app.tab.prev":
        selectPrevTabInActivePane();
        return;
      case "app.tab.jump": {
        const i = Number(detail?.index);
        if (Number.isInteger(i) && i >= 0) selectTabAtIndexInActivePane(i);
        return;
      }
      case "app.tab.close": {
        const p = activePane();
        const activeTabId = paneActiveTabId(p);
        if (activeTabId) closeTab(p.id, activeTabId);
        else closeActiveEmptyPane();
        return;
      }
      // Explicit "close this window" (native Ctrl+Alt+W off-mac via
      // KEY_BRIDGE_JS, Cmd+Shift+W on macOS,
      // and the OS close button when a devserver is NOT connected). Discard
      // intent: delete this window's saved blob now -- the server reaps its
      // terminal sessions -- then ask the host to close the window. Distinct
      // from a bury (connected close button), which keeps the blob so the
      // window can be re-surfaced.
      case "app.window.close":
        if (closeActiveEmptyPane()) return;
        discardWindowSession();
        if (isTauriDesktop()) void requestCloseWindow();
        return;
      // The desktop OS red-dot on a LIVE window. The host prevented the close
      // and asked us. Two fast paths close straight away (no prompt): while the
      // reconnect overlay is up (ui.disconnectBlocking) there is nothing to keep
      // interacting with, and an empty window (no tabs) must never be recorded --
      // the discard cascade removes its row and DELETEs its session blob. Any
      // other window prompts Hide / Close / Cancel; the overlay owns the outcome.
      case "app.window.confirmClose":
        if (ui.disconnectBlocking || !hasAnyTab()) {
          discardWindowSession({ reap: true });
          if (isTauriDesktop()) void requestCloseWindow();
          return;
        }
        void uiCloseConfirm();
        return;
      // The "Hide window" command (launcher row / Mod+Shift+H / host bridge):
      // the close-confirm overlay's Hide answer without the prompt -- invoking
      // the command already expresses the intent the overlay asks for. The
      // bury IPC is an explicit no-op off desktop, where the launcher entry is
      // not offered.
      case "app.window.hide":
        void hideWindowFromCloseConfirm();
        return;
      // `app.save` is intentionally absent: autosave covers the write path.
      case "app.file.new":
        void fileOps.createFile("");
        return;
      case "app.find.open": {
        const t = activeFileTab();
        if (!t) return;
        openFind(t.id);
        return;
      }
      case "app.find.next": {
        const t = activeFileTab();
        if (!t?.find?.open) return;
        const n = t.find.matches.length;
        if (n === 0) return;
        const cur = t.find.currentIndex < 0 ? 0 : t.find.currentIndex;
        t.find.currentIndex = (cur + 1) % n;
        return;
      }
      case "app.find.prev": {
        const t = activeFileTab();
        if (!t?.find?.open) return;
        const n = t.find.matches.length;
        if (n === 0) return;
        const cur = t.find.currentIndex < 0 ? 0 : t.find.currentIndex;
        t.find.currentIndex = (cur - 1 + n) % n;
        return;
      }
      case "app.find.close": {
        const t = activeFileTab();
        if (!t) return;
        closeFind(t.id);
        return;
      }
    }
    // Extension commands register after the process catalog loads, so they
    // cannot have compile-time switch cases. Resolve them through the same
    // registry used by the launcher; this is also the path user-assigned
    // extension shortcuts and native command dispatch take.
    if (commandName.startsWith("extension.")) {
      const command = allCommands().find((candidate) => candidate.id === commandName);
      if (command?.available(commandContext())) command.run();
    }
  }
  function onChanCommand(e: Event): void {
    const detail = (e as CustomEvent).detail ?? {};
    if (typeof detail.name !== "string") return;
    runCommand(detail.name, detail);
  }
  onMount(() => window.addEventListener("chan:command", onChanCommand));
  onDestroy(() => window.removeEventListener("chan:command", onChanCommand));

  // Prune stale or over-cap editor-buffer entries from localStorage at app
  // load. editorBuffer self-prunes on quota-exceeded too, but an up-front
  // sweep keeps storage tidy for long-lived sessions.
  onMount(() => {
    pruneEditorBuffers();
    pruneTerminalSnapshots();
  });

  // Synchronously flush in-flight debounced editor-buffer writes before the
  // page tears down. window.location.reload() does NOT trigger Svelte
  // component cleanup, so the last ~500ms of edits would be lost without
  // this. `beforeunload` + `pagehide` both fire reliably; pagehide is the
  // mobile-safe variant, beforeunload covers desktop reloads.
  // Handlers are deliberately synchronous - async work in beforeunload is
  // unreliable, and a synchronous localStorage write is fine.
  function onUnloadFlushBuffers(): void {
    flushPendingBufferWrites();
    // The caret is only mirrored into the URL hash on layout changes, not
    // on every selection move. Flush the layout here (which serializes each
    // tab's caret as the `c` field) so a reload restores the exact caret
    // position. maybeRestoreCaret then re-asserts keyboard focus.
    persistLayoutToHash();
  }
  onMount(() => {
    window.addEventListener("beforeunload", onUnloadFlushBuffers);
    window.addEventListener("pagehide", onUnloadFlushBuffers);
  });
  onDestroy(() => {
    window.removeEventListener("beforeunload", onUnloadFlushBuffers);
    window.removeEventListener("pagehide", onUnloadFlushBuffers);
  });

  // Pure-browser close guard for in-flight transfers (the desktop has its own
  // CloseRequested hold/cancel prompt, so this is gated off on the desktop to
  // avoid a double prompt). The XHR dies on unload, so a standard-cancellable
  // beforeunload gives the user the chance to keep the page.
  function onBeforeUnloadTransfers(e: BeforeUnloadEvent): void {
    if (!isTauriDesktop() && activeTransferCount() > 0) {
      e.preventDefault();
      e.returnValue = "";
    }
  }
  onMount(() => window.addEventListener("beforeunload", onBeforeUnloadTransfers));
  onDestroy(() => window.removeEventListener("beforeunload", onBeforeUnloadTransfers));

  /// Pane-focus-click restore: when chan-desktop is unfocused and the user
  /// clicks back, the first click should also select the pane under the
  /// cursor (not stay on the previously-focused pane). Cmd+Tab keyboard
  /// refocus must NOT change pane selection (focus event without mousedown).
  ///
  /// Detection: track the last `window` focus event timestamp and listen for
  /// mousedown at the window level. If a mousedown fires within
  /// `FOCUS_CLICK_WINDOW_MS` of a focus event, walk the DOM to find the
  /// nearest `.pane[data-pane-id]` and call `setActivePane`. Clear the
  /// timestamp after the first matching mousedown.
  ///
  /// On macOS/Tauri the first mousedown after window-focus restore is sometimes
  /// consumed by the OS for the activation gesture and doesn't reach Pane.svelte's
  /// per-pane handler; this top-level catch covers that case.
  const FOCUS_CLICK_WINDOW_MS = 50;
  let focusRestoreAt = 0;
  function onWindowFocus(): void {
    focusRestoreAt = Date.now();
  }
  function onWindowMouseDown(e: MouseEvent): void {
    if (focusRestoreAt === 0) return;
    if (Date.now() - focusRestoreAt > FOCUS_CLICK_WINDOW_MS) {
      focusRestoreAt = 0;
      return;
    }
    focusRestoreAt = 0;
    const target = e.target;
    if (!(target instanceof Element)) return;
    const paneEl = target.closest<HTMLElement>(".pane[data-pane-id]");
    if (!paneEl) return;
    const paneId = paneEl.dataset.paneId;
    if (!paneId) return;
    setActivePane(paneId);
  }
  onMount(() => {
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("mousedown", onWindowMouseDown, true);
  });
  onDestroy(() => {
    window.removeEventListener("focus", onWindowFocus);
    window.removeEventListener("mousedown", onWindowMouseDown, true);
  });
</script>

<div class="app" class:pane-mode={paneMode.active}>
  <!-- The docked file browsers render wherever there is a filesystem to
       list: a workspace window's workspace, or a standalone window whose
       tenant serves one. Without either there is no /api/files, and the pane
       layout (terminal splits + Hybrid Nav) is the only surface. -->
  {#if windowCaps.files && browserSidePanes.left}
    <FileBrowserSidePane side="left" />
  {/if}
  <main>
    <Workspace />
  </main>
  {#if windowCaps.files && browserSidePanes.right}
    <FileBrowserSidePane side="right" />
  {/if}
</div>
<!-- Top-right ambient status bar: indexer state, import
     progress, transient ui.status messages. Window-level and
     lifted above every overlay so users keep visibility on
     long-running work no matter which panel they're in. -->
<AppStatusBar />
<!-- The file-transfer bubble (cs upload / cs download progress + cancel),
     opened from the status-bar transfers indicator. Mounted once, anchored to
     the window so it floats above the panes near the status bar. -->
<TransferBubble />
<!-- Handover-request notification (cs session handover): the leader's window
     shows who is asking to take over, with Accept / Reject. Mounted once,
     window-anchored like the transfer bubble. -->
<SessionHandoverBubble />
<!-- Paste-request card (cs paste): shows when a clipboard read is parked on
     a browser permission prompt, with Paste / Cancel. Mounted once,
     window-anchored like the transfer bubble. -->
<PasteRequestBubble />
<!-- Hybrid Nav (Cmd+.) cheatsheet, toggled with `h` while pane mode
     is active. Gated on the live `paneMode.active` so it auto-hides
     the moment the transaction commits / discards. -->
{#if paneMode.active && paneModeHelpVisible}
  <PaneModeHelp />
{/if}
<!-- Window-level overlays. Mounted once. -->
<PromptModal />
<PathPromptModal />
<ConfirmModal />
<DraftCloseModal />
<WorkspaceWarningsModal />
<SearchPanel />
<CommandLauncher />
<SettingsOverlay />
<ImportContactsModal
  open={importContactsPanel.open}
  defaultDir={importContactsPanel.defaultDir}
  onClose={closeImportContacts}
/>
<!-- CAS conflict prompt: surfaces when a save returns 409. Mounted
     once per window so any pane can trigger it; the dialog itself
     keys off `conflictDialog.tabId`. -->
<ConflictModal />
<!-- Team Work Spawn-agents dialog, mounted at App root so its
     `position: fixed` backdrop is never clipped by a pane's
     `overflow: hidden` stacking context. Renders only when a request
     is pending (set by the Cmd+P lead-terminal flow); the dialog
     closes itself on Bootstrap / Cancel / Escape / backdrop click and
     owns deleting the lead tab on Cancel. -->
{#if teamDialogState.request}
  <TeamDialog request={teamDialogState.request} />
{/if}
<!-- Disconnect overlay applies in every mode: any window is just
     as broken when the watcher dies, regardless of layout. -->
<DisconnectOverlay />
<!-- Terminal overlay when the session leader closes/hides this window; stacks
     above the reconnect overlay since the window is gone, not reconnecting. -->
<SessionEndedOverlay />
<!-- Desktop red-dot close prompt (Hide / Close / Cancel); stacks above the
     reconnect and session-ended overlays. Desktop-only by construction. -->
<CloseConfirmOverlay />
<!-- Missing-token overlay: surfaces when the user landed on the
     SPA shell without the launch token, so /api 401s and the app
     is unusable until they reopen the original URL. -->
<MissingTokenOverlay />
<!-- Preflight is workspace onboarding (index, model, cs link); terminal-only
     windows are served by the slim terminal tenant, which has no workspace
     and mounts no /api/preflight route. -->
{#if windowCaps.workspace}
  <PreflightOverlay />
{/if}
<!-- Survey overlay, WINDOW-WIDE FALLBACK: renders a survey raised by
     `cs terminal survey` with no resolvable target terminal (a --tab-group
     broadcast, an unmatched --tab-name, or a frame without
     tabName) as a centered modal. Per-terminal surveys render over their own
     terminal (TerminalTab mounts <BubbleOverlay tabId={tab.id} />); this
     App-root mount (default tabId=null) is the fallback slot. Renders nothing
     when the window-wide slot is empty. -->
<BubbleOverlay />
<!-- Screensaver cover. Mounts at App root so z-index sits above every
     chan overlay (screensaver-backdrop uses z=2000). Renders nothing
     while screensaver.locked === false; when locked it covers the SPA
     and accepts PIN entry. -->
<ScreensaverOverlay />

<style>
  /* Theme palette. Defaults to dark; [data-theme="light"] overrides.
     The neutrals mirror Apple's Notes / system grays so chan reads
     as "the markdown notes app" rather than "GitHub Dark with our
     stuff in it"; functional colors (link blue, accent green, warn
     amber, pane focus) are kept distinct. */
  /* Surface-scoped theme overrides re-apply the same token block at
     `[data-theme="..."]` so a Hybrid body theme pick cascades only
     through that surface subtree without touching the root. */
  :global(:root),
  :global([data-theme="dark"]) {
    --bg: #1c1c1e;
    --bg-card: #232325;
    --bg-elev: #2a2a2c;
    --border: #3a3a3c;
    /* Softened dark-mode text. Pure white #f5f5f7 on near-black
       #1c1c1e measures ~17:1 contrast, far above Apple's spec for
       primary label on system dark (which lands ~13:1). #ebebf0
       is Apple's "primary label" off-white; --text-heading dimmed
       a notch further so H1/H2 don't fight the body. Light mode
       is intentionally untouched. */
    --text: #ebebf0;
    --text-secondary: #8e8e93;
    --text-heading: #d8d8de;
    --link: #58a6ff;
    /* Code background needs a clear step away from --bg (#1c1c1e) so
       fenced blocks and inline `code` read as a slab; #232325 collided
       with --bg-card. Light-mode value (below) does the same against
       the white canvas. */
    --code-bg: #2a2a2c;
    --btn-bg: #2a2a2c;
    --btn-border: #3a3a3c;
    --btn-hover: #98989d;
    --accent: #3fb950;
    --warn-text: #e3b341;
    --danger-text: #f85149;
    /* "Unsaved buffer" color used by the dirty-dot in the file
       tree and tab strip. */
    --info-text: #4ade80;
    --hover-bg: rgba(255, 255, 255, 0.06);
    --selection-bg: rgba(56, 139, 253, 0.4);
    /* Subtle tint on the off-page area when the page-width cap is
       active. Sits below --hover-bg so the page itself still pops. */
    --page-shade: rgba(255, 255, 255, 0.025);
    /* Subtle alternating row tint for tree views (file browser).
       Sits well below --hover-bg in opacity so hover/selection still
       wins over zebra striping at the cascade level. */
    --zebra-bg: rgba(255, 255, 255, 0.025);
    /* Right-side inspector panel background. Distinct from --bg-card
       so the inspector visually separates from the editor canvas
       (especially in light mode where --bg-card is close to --bg). */
    --inspector-bg: #232325;
    /* Resize-handle bar color. Brighter than --border so the 4px bar
       between inspector and canvas is findable in light mode (where
       --border can blend with bg). */
    --separator: #4a4a4d;
    --separator-hover: #98989d;
    --tab-active-bg: #1c1c1e;
    --tab-inactive-bg: #232325;
    --smart-bg: rgba(88, 166, 255, 0.18);
    --pane-focus: #388bfd;
    --bubble-bg: #2a2a2c;
    --bubble-right-bg: rgba(88, 166, 255, 0.28);
    /* Graph palette: doc / image / tag share the chan brand warm-orange
       primary plus hue-separated pairs (purple for images, green for tags). */
    --g-doc: #ff8a3d;
    --g-img: #b07dff;
    --g-tag: #6cd07a;
    --chan-color-language: #ff4db8;
    --chan-color-code: var(--chan-color-language);
    --g-language: var(--chan-color-language);
    /* Graph node-type colour scheme: markdown / source / binary / media.
       --g-doc (above) -> orange for markdown (.md, .txt).
       --g-source (royalblue) -> code + config text files (.rs, .py, .ts, ...).
       --g-binary (dark grey) -> opaque files (archives, executables, fonts).
       --g-img (above) -> purple for media (image / pdf).
       --g-folder (medium grey) -> directory nodes; darker than binary so
         the two don't visually collapse. */
    --g-source: #4169e1;
    --g-binary: #5e5e62;
    --g-folder: #8e8e93;
    /* Contact + mention graph nodes read --g-contact, which defaults to
       the warning hue and is settable per colour scheme as part of the
       graph palette (editor.graph_colors.*). Surfaces outside the graph
       read it with a var(--g-contact, var(--warn-text)) fallback. */
    --g-contact: var(--warn-text);
    /* Drafts folder: distinct yellow tone. The configured Drafts dir
       (default .Drafts) is a real in-workspace directory; this tint
       marks its FB row + graph node as a category without dominating
       the panel. */
    --fb-drafts-fg: #e3b341;
    --fb-drafts-bg: rgba(227, 179, 65, 0.10);
    /* Inline editor pills (wiki link, image, tag, contact, date,
       broken). Hues track the canonical concept palette so the
       same item reads with the same color across the graph, the
       file tree, the info panel, and the editor: document ->
       orange, media -> purple, tag -> green, contact -> yellow,
       date/time -> grey, broken -> red. See web/packages/workspace-app/src/design.md
       for the full cross-surface table. Backgrounds are alpha
       tints of the foreground so each pill reads as a badge
       rather than a button. */
    --pill-wiki-fg: var(--text);
    --pill-wiki-bg: rgba(255, 138, 61, 0.18);
    --pill-wiki-bg-hover: rgba(255, 138, 61, 0.28);
    --pill-image-fg: var(--text);
    --pill-image-bg: rgba(176, 125, 255, 0.20);
    --pill-tag-fg: var(--text);
    --pill-tag-bg: rgba(108, 208, 122, 0.18);
    --pill-tag-bg-hover: rgba(108, 208, 122, 0.28);
    --pill-contact-fg: var(--text);
    --pill-contact-bg: rgba(227, 179, 65, 0.18);
    --pill-date-fg: var(--text);
    --pill-date-bg: rgba(152, 152, 157, 0.15);
    --pill-broken-fg: var(--text);
    --pill-broken-bg: rgba(255, 80, 75, 0.20);
    /* Floating-pane drop shadow. Dark mode reads against a
       near-black canvas, so the shadow is a subtle white-ish
       glow rather than a darker tone (which would disappear
       into the background). */
    --pane-shadow: 0 1px 6px rgba(255, 255, 255, 0.08);
  }
  :global([data-theme="light"]) {
    --bg: #ffffff;
    --bg-card: #f5f5f7;
    --bg-elev: #ffffff;
    --border: #d1d1d6;
    --text: #1c1c1e;
    --text-secondary: #6c6c70;
    --text-heading: #1c1c1e;
    --link: #0969da;
    --code-bg: #e8e8ec;
    --btn-bg: #f2f2f4;
    --btn-border: #d1d1d6;
    --btn-hover: #6c6c70;
    --accent: #1a7f37;
    --warn-text: #9a6700;
    --danger-text: #cf222e;
    --info-text: #16a34a;
    --hover-bg: rgba(0, 0, 0, 0.05);
    --selection-bg: rgba(9, 105, 218, 0.18);
    --page-shade: rgba(0, 0, 0, 0.035);
    --zebra-bg: rgba(0, 0, 0, 0.025);
    /* Light mode: pull the inspector several shades off white so the
       resize handle reads as a real boundary instead of a
       hairline at the same brightness as the editor canvas. */
    --inspector-bg: #ececef;
    --separator: #b0b0b6;
    --separator-hover: #6c6c70;
    --tab-active-bg: #ffffff;
    --tab-inactive-bg: #ececec;
    --smart-bg: rgba(80, 120, 200, 0.12);
    --pane-focus: #7aa6e0;
    --bubble-bg: #ececef;
    --bubble-right-bg: #cfe1fb;
    /* Light-mode graph palette: deeper, less saturated than dark
       mode so the same node hues stay legible against light bg
       without glaring. */
    --g-doc: #c25a1f;
    --g-img: #7a4cd8;
    --g-tag: #2f9444;
    --chan-color-language: #c71585;
    --chan-color-code: var(--chan-color-language);
    --g-language: var(--chan-color-language);
    /* Light-mode graph node colours: deeper hues balanced against the bright bg. */
    --g-source: #2851c4;
    --g-binary: #4e4e54;
    --g-folder: #6c6c70;
    /* Light-mode --g-contact: same zero-pixel default as dark mode. */
    --g-contact: var(--warn-text);
    /* Light-mode Drafts folder: deeper yellow for contrast against the bright bg. */
    --fb-drafts-fg: #9a6700;
    --fb-drafts-bg: rgba(154, 103, 0, 0.08);
    /* Light-mode pill palette. Same canonical mapping as dark
       (document orange, media purple, tag green, contact yellow,
       date grey, broken red), but deeper foreground hues and
       lower-alpha backgrounds so the pills still read as badges
       against the bright canvas. */
    --pill-wiki-fg: #c25a1f;
    --pill-wiki-bg: rgba(255, 138, 61, 0.14);
    --pill-wiki-bg-hover: rgba(255, 138, 61, 0.22);
    --pill-image-fg: #7a4cd8;
    --pill-image-bg: rgba(122, 76, 216, 0.10);
    --pill-tag-fg: #2f9444;
    --pill-tag-bg: rgba(47, 148, 68, 0.12);
    --pill-tag-bg-hover: rgba(47, 148, 68, 0.20);
    --pill-contact-fg: #9a6700;
    --pill-contact-bg: rgba(154, 103, 0, 0.10);
    --pill-date-fg: #6c6c70;
    --pill-date-bg: rgba(108, 108, 112, 0.10);
    --pill-broken-fg: #c93232;
    --pill-broken-bg: rgba(255, 59, 48, 0.12);
    /* Standard soft drop-shadow against the light canvas. */
    --pane-shadow: 0 1px 6px rgba(0, 0, 0, 0.14);
  }

  /* CM6's drawSelection paints the highlight into .cm-selectionLayer
     markers, and its base theme hard-codes light greys (#d7d4f0
     focused, #d9d9d9 unfocused) regardless of the app's color scheme -
     in dark mode that washed near-white text under a light lavender
     fill. Route the layer through --selection-bg so the selection
     follows the app palette (the dark value matches GitHub's
     accent-muted selection blue). Peer-collab selections use their own
     .cm-peer-sel classes and are unaffected. */
  :global(.cm-selectionBackground) {
    background: var(--selection-bg) !important;
  }

  :global(html), :global(body), :global(#app) {
    height: 100%; margin: 0; padding: 0;
  }
  :global(body) {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    /* Baseline; chrome / file tree / overlays inherit this where
       no explicit size is set. Component-level font-sizes are
       in the 12-16 px range; baseline 15 keeps the small ones
       readable on 4k panels at 100% scale. */
    font-size: 15px;
    color: var(--text);
    background: var(--bg);
    overflow: hidden;
  }
  :global(.md-bubble .md-bubble-status.md-bubble-status-empty) {
    border-top: 0;
    margin-top: 0;
    padding: 0;
  }
  :global(.md-bubble .md-bubble-empty-state) {
    padding: 7px 8px;
    color: var(--text-secondary, #888);
    gap: 2px;
  }
  :global(.md-bubble .md-bubble-empty-primary) {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text);
  }
  :global(.md-bubble .md-bubble-empty-secondary) {
    font-size: 12px;
  }
  :global(.md-bubble .md-bubble-spinner) {
    width: 10px;
    height: 10px;
    border: 2px solid var(--border, #ddd);
    border-top-color: var(--accent, #2563b8);
    border-radius: 999px;
    animation: md-bubble-spin 700ms linear infinite;
  }
  @keyframes md-bubble-spin {
    to { transform: rotate(360deg); }
  }
  .app {
    display: flex;
    height: 100vh;
    width: 100vw;
  }
  .app.pane-mode :global(.pane) {
    position: relative;
    transition: box-shadow 90ms ease;
  }
  .app.pane-mode :global(.pane.focused) {
    box-shadow:
      inset 0 0 0 2px var(--pane-active-focus),
      0 0 0 1px color-mix(in srgb, var(--pane-active-focus) 40%, transparent);
  }
  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    position: relative;
    /* Workspace backdrop sits one step off the pane background so
       the pane chrome (rounded corners + drop shadow) reads as a
       floating card. Without this contrast the shadow has nothing
       to fall onto and the rounded corners hug the same color on
       both sides. */
    background: var(--bg-card);
  }

</style>
