<script lang="ts">
  // Context provider for the shared command deck. The command catalog and the
  // settings index say what exists; state/commands/deck turns them into the
  // sectioned list, the typed results and the option lists, and this component
  // adds the scope rail, the icons, the Computers rows and the running of a
  // row. The shared deck owns presentation, the keyboard, motion and the
  // persisted draft.
  import CommandDeck from "@chan/web-shared/CommandDeck.svelte";
  import {
    rankDeckItems,
    type DeckConfirm,
    type DeckItem,
    type DeckScope,
    type DeckScopeId,
  } from "@chan/web-shared/command-deck";
  import { privateText } from "@chan/web-shared/privacy";
  import { windowDisplayName } from "@chan/web-shared/window-label";
  import {
    AppWindow,
    ChartNoAxesColumn,
    Command as CommandIcon,
    Eye,
    EyeOff,
    FilePlus,
    FileText,
    Focus,
    Folder,
    FolderRoot,
    Layers,
    MonitorCog,
    Network,
    PanelTop,
    PanelsTopLeft,
    Puzzle,
    Search as SearchIcon,
    Settings2,
    Shapes,
    SquareStack,
    Terminal,
    X,
  } from "@lucide/svelte";
  import { untrack } from "svelte";
  import {
    clearLauncherDraft,
    closeCommandLauncher,
    launcherDraft,
    openSettings,
    persistLauncherDraft,
  } from "../state/store.svelte";
  import {
    SURFACE_LABELS,
    allCommands,
    commandContext,
    type CommandCategory,
    type CommandSurface,
  } from "../state/commands";
  import {
    branchRows,
    browseRows,
    deckCrumbs,
    isCatalogPath,
    searchRows,
    type DeckRow,
    type DeckSource,
  } from "../state/commands/deck";
  import { noteCommandRun, recentCommandIds } from "../state/commands/recent.svelte";
  import { chordFor } from "../state/shortcuts";
  import {
    activePane,
    activeTabInPane,
    activeTerminalTab,
    bumpTabFocusPulse,
  } from "../state/tabs.svelte";
  import { refocusRefused } from "../state/focusGuard";
  import { sessionWindowId } from "../api/client";
  import { isTauriDesktop } from "../api/desktop";
  import { ApiError, errorText } from "../api/errors";
  import { notify } from "../state/notify.svelte";
  import {
    checkScopedWindowPage,
    loadScopedLibrarySnapshot,
    loadScopedWindowLiveTerminals,
    runScopedLibraryAction,
    type ScopedLibrarySnapshot,
    type ScopedLibraryWindow,
    type ScopedLibraryWorkspace,
  } from "../api/libraryCommand";
  import { scopedWorkspaceOpenable } from "../api/workspaceStatus";
  import {
    buryLibraryWindow,
    createLibraryWindow,
    focusLibraryWindow,
    openLibraryWindow,
    showLibraryWindow,
    type CreateLibraryWindowAction,
    type LibraryWindowBridge,
  } from "../api/libraryWindows";
  import { SETTINGS_SECTIONS } from "./settings/sections";
  import { settingsIndex } from "./settings/settingsIndex";
  import "../state/commands/install";

  type ComputerCommandId = "new-window" | "windows";
  type WindowActionId = "focus" | "hide" | "show" | "open" | "close";

  /// A deck row and what choosing it does. A catalog or settings row comes
  /// from the builders with `after` set; a Computers row is built here, and
  /// its run answers to the deck's own card: a confirmation to put, or a
  /// promise the deck awaits.
  type Entry = DeckRow;

  const COMPUTERS_SECTION = "Computers";

  type IconComponent = typeof SearchIcon;
  const categoryIcons: Record<CommandCategory, IconComponent> = {
    Global: CommandIcon,
    Workspace: Folder,
    Search: SearchIcon,
    Apps: FilePlus,
    Tabs: SquareStack,
    Panes: Shapes,
    Editor: FileText,
    "File Browser": Folder,
    Terminal,
    Dashboard: ChartNoAxesColumn,
    Graph: Network,
  };
  const namedIcons: Record<string, IconComponent> = {
    command: CommandIcon,
    dashboard: ChartNoAxesColumn,
    file: FileText,
    folder: Folder,
    graph: Network,
    panes: Shapes,
    search: SearchIcon,
    settings: Settings2,
    tabs: FilePlus,
    terminal: Terminal,
  };
  const surfaceIcons: Record<CommandSurface, IconComponent> = {
    file: FileText,
    terminal: Terminal,
    browser: Folder,
    graph: Network,
    dashboard: ChartNoAxesColumn,
    extension: Puzzle,
  };

  let direction: "forward" | "back" | "still" = $state("still");
  let contextNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  let scopedLibrary: ScopedLibrarySnapshot | null = $state(null);
  let scopedLibraryLoading = $state(false);
  let scopedLibrarySettled = $state(false);
  let scopedLibraryError: string | null = $state(null);
  let scopedLibraryLoad: Promise<void> | null = null;
  // Local assignable alias for Svelte's ownership contract. Both names point
  // at the same imported state proxy; CommandDeck mutates fields, never swaps
  // the draft object.
  let deckDraft = $state(launcherDraft);
  // The count a Close card was painted with, and the reading that owns that
  // card, both keyed by window. A reading a later one has overtaken keeps its
  // hands off both.
  const confirmedCloseCounts = new Map<string, unknown>();
  const closePreparationVersions = new Map<string, number>();

  // Bumped after a row that changes in place has run, so the rows are read
  // again when its state lives outside the reactive graph.
  let revision = $state(0);

  /// How long a row that changes in place keeps the deck waiting for its
  /// result. Within it a refusal lands on the deck's card. A write that
  /// takes longer, such as one that downloads a model first, settles on its
  /// own: it holds neither the deck nor the focus the deck hands back when
  /// it closes, and its refusal goes where the deck reports a run it no
  /// longer shows.
  const IN_PLACE_WAIT_MS = 400;

  const ctx = $derived(commandContext());
  // A path the catalog builders own is a choice's options or a Settings
  // section. Any other non-empty path is a Computers branch: `windows`
  // carries a second element, the window whose own actions are being shown.
  const catalogMode = $derived(isCatalogPath(launcherDraft.path));
  const computerMode = $derived(
    catalogMode ? null : ((launcherDraft.path[0] as ComputerCommandId | undefined) ?? null),
  );
  const windowMode = $derived(computerMode === "windows" ? launcherDraft.path[1] ?? null : null);

  /// The focused tab's app: what the App scope is named after. An extension
  /// tab carries its extension's display name as its title.
  const app = $derived.by<{ label: string; caption?: string; icon: IconComponent } | null>(() => {
    const surface = ctx.activeSurface;
    if (surface === null) return null;
    if (surface === "browser") {
      return { label: SURFACE_LABELS.browser, caption: "Files", icon: surfaceIcons.browser };
    }
    if (surface !== "extension") return { label: SURFACE_LABELS[surface], icon: surfaceIcons[surface] };
    let title: string | undefined;
    try {
      const tab = activeTabInPane(activePane());
      if (tab?.kind === "extension") title = tab.title;
    } catch {
      // activePane throws while the active node is not a leaf.
    }
    return { label: title || SURFACE_LABELS.extension, icon: surfaceIcons.extension };
  });

  const scopes = $derived.by<DeckScope[]>(() => [
    {
      id: "app",
      label: app?.label ?? "App",
      caption: app?.caption,
      icon: app?.icon ?? PanelTop,
      available: app !== null,
    },
    { id: "pane", label: "Pane", icon: PanelsTopLeft },
    { id: "window", label: "Window", icon: Layers },
    // A window with no workspace behind it has nothing to list there.
    ...(ctx.caps.workspace ? [{ id: "workspace", label: "Workspace", icon: FolderRoot }] : []),
    { id: "settings", label: "Settings", icon: Settings2 },
    {
      id: "computers",
      label: COMPUTERS_SECTION,
      icon: MonitorCog,
      // Enabled over a snapshot, and while the first request is unanswered,
      // so a window about to get its library reads Connecting. A route that
      // has failed with no snapshot to show leaves the orb disabled through
      // the requests that follow, each poll's among them.
      available: scopedLibrary !== null || (scopedLibraryLoading && scopedLibraryError === null),
    },
  ]);

  // The recent commands as they stood when the deck opened. A command run
  // while it stays open is remembered for the next opening, so the list
  // does not move under a row that changes in place.
  const recentAtOpen = $derived.by(() => {
    void launcherDraft.visible;
    return untrack(() => [...recentCommandIds()]);
  });

  /// The window as the catalog builders read it. Read inside each derived
  /// list, so the catalog and the settings index are as they stand now.
  function deckSource(): DeckSource {
    return {
      ctx,
      commands: allCommands(),
      app: app ? { label: app.label } : null,
      settings: settingsIndex(),
      sections: SETTINGS_SECTIONS,
      recent: recentAtOpen,
      chord: chordFor,
    };
  }

  /// A setting the deck cannot change in place is edited in the overlay.
  function openSettingsAt(section: string, field?: string): void {
    openSettings({ section, field });
  }

  function withIcon(row: DeckRow): Entry {
    if (row.icon) return row;
    const command = row.command;
    const icon = command
      ? ((command.icon ? namedIcons[command.icon] : undefined) ?? categoryIcons[command.category])
      : Settings2;
    return { ...row, icon };
  }

  function refreshScopedLibrary(): Promise<void> {
    if (scopedLibraryLoad) return scopedLibraryLoad;
    scopedLibraryLoading = true;
    scopedLibraryLoad = loadScopedLibrarySnapshot()
      .then((snapshot) => {
        scopedLibrary = snapshot;
        scopedLibraryError = null;
      })
      .catch((error) => {
        // A server without the scoped route simply leaves the fourth orb quiet.
        // Other failures stay recoverable: the next open/poll remints after the
        // source /ws reconnects.
        scopedLibraryError = errorText(error);
        if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
          scopedLibrary = null;
        }
      })
      .finally(() => {
        scopedLibraryLoading = false;
        scopedLibrarySettled = true;
        scopedLibraryLoad = null;
      });
    return scopedLibraryLoad;
  }

  // Capability minting waits until the deck is requested, avoiding startup
  // work and the ordinary race before this window's main /ws is live. While the
  // deck remains open, a light poll keeps window targets current without ever
  // granting access outside the invoking library.
  $effect(() => {
    if (!launcherDraft.visible) return;
    const first = setTimeout(() => void refreshScopedLibrary(), 0);
    const poll = setInterval(() => void refreshScopedLibrary(), 2500);
    return () => {
      clearTimeout(first);
      clearInterval(poll);
    };
  });

  /// Privacy mode names every window `Window` and every workspace
  /// `Workspace`, as the launcher's deck does: a row is a deck option, which
  /// cannot hold a reveal button.
  function scopedWindowTitle(window: ScopedLibraryWindow): string {
    return privateText(windowDisplayName(window), "Window");
  }

  /// A workspace row's name in the deck: its label, else its root's last
  /// component cut at `/` alone, so a Windows root with no label reads whole.
  function scopedWorkspaceName(workspace: ScopedLibraryWorkspace): string {
    return privateText(workspace.label || workspace.path.split("/").filter(Boolean).at(-1) || workspace.path, "Workspace");
  }

  /// A workspace window is named by the row that lists its workspace, as the
  /// launcher's deck names it. The snapshot holds one library's rows, so the
  /// record's path picks the row. A window whose workspace no row lists is
  /// named from its own path, cut at `/` alone: a `\` can be part of a Unix
  /// directory's name.
  function scopedWindowContext(window: ScopedLibraryWindow): string {
    if (window.control) return "Control terminal";
    if (window.kind === "terminal") return "Terminal";
    const workspace = scopedLibrary?.workspaces.find((row) => row.path === window.workspace_path);
    if (workspace) return scopedWorkspaceName(workspace);
    const name = window.workspace_path?.split("/").filter(Boolean).at(-1);
    return name ? privateText(name, "Workspace") : "Workspace";
  }

  // The deck keeps the capability lifecycle and the snapshot; how a window is
  // created, raised, or buried differs between a browser and chan-desktop and
  // lives in the api module, where it can be driven without the deck UI.
  const libraryWindowBridge: LibraryWindowBridge = {
    checkPage: checkScopedWindowPage,
    runAction: runScopedLibraryAction,
    refresh: refreshScopedLibrary,
    readSnapshot: loadScopedLibrarySnapshot,
    currentWindowId: sessionWindowId,
  };

  function focusScopedWindow(window: ScopedLibraryWindow): Promise<void> {
    return focusLibraryWindow(libraryWindowBridge, window);
  }

  function showScopedWindow(window: ScopedLibraryWindow): Promise<void> {
    return showLibraryWindow(libraryWindowBridge, window);
  }

  function openScopedWindow(window: ScopedLibraryWindow): Promise<void> {
    return openLibraryWindow(libraryWindowBridge, window);
  }

  function createScopedWindow(action: CreateLibraryWindowAction): Promise<void> {
    return createLibraryWindow(libraryWindowBridge, action);
  }

  function buryScopedWindow(window: ScopedLibraryWindow, close: boolean): Promise<void> {
    return buryLibraryWindow(libraryWindowBridge, window, close);
  }

  function computerCommandEntry(
    id: ComputerCommandId,
    title: string,
    description: string,
    icon: Entry["icon"],
    keywords = "",
  ): Entry {
    return {
      id: `computers:${id}`,
      title,
      breadcrumb: `Computers › ${description}`,
      searchText: `${title} ${description} ${keywords}`,
      scope: "computers",
      icon,
      kind: "branch",
      next: [id],
    };
  }

  /// One row per window that exists, each a branch into that window's own
  /// actions. Open versus hidden rides the breadcrumb.
  function scopedWindowBranch(window: ScopedLibraryWindow): Entry {
    const title = scopedWindowTitle(window);
    const context = scopedWindowContext(window);
    const state = window.hidden ? "Hidden" : "Open";
    const here = window.window_id === sessionWindowId() ? `${context} (this window)` : context;
    return {
      id: `computers:window:${window.window_id}`,
      title,
      breadcrumb: `Computers › Windows › ${state} › ${here}`,
      searchText: [title, window.title, window.label, window.workspace_path ?? "", context, state, "window"].join(" "),
      scope: "computers",
      icon: window.kind === "terminal" ? Terminal : AppWindow,
      kind: "branch",
      next: ["windows", window.window_id],
    };
  }

  /// A browser can focus its own popup. A native or unknown-origin record has
  /// only a visibility action and an explicit browser Open from this surface.
  ///
  /// A window this host's registry does not hold (`managed: false`) is offered
  /// only what can be carried out on it. Hide, Close and the un-hide behind
  /// Show act on that registry, so it is offered none of them. A visible one
  /// keeps Focus in chan-desktop, where the window watcher opens it under the
  /// label the native focus command targets. A browser is offered nothing: the
  /// launch route redirects to the record's own page, which this host may not
  /// serve.
  function scopedWindowActions(window: ScopedLibraryWindow): WindowActionId[] {
    if (window.managed === false) return !window.hidden && isTauriDesktop() ? ["focus"] : [];
    const manageable = !window.control;
    const browserOnly = !isTauriDesktop() && window.origin !== "browser";
    const actions: WindowActionId[] = browserOnly
      ? window.hidden ? ["show", "open"] : ["open"]
      : [window.hidden ? "show" : "focus"];
    if (manageable && !window.hidden) actions.push("hide");
    if (manageable) actions.push("close");
    return actions;
  }

  function scopedWindowEntry(command: WindowActionId, window: ScopedLibraryWindow): Entry {
    const verb = command === "focus" ? "Focus" : command === "hide" ? "Hide" : command === "show" ? "Show" : command === "open" ? "Open in this browser" : "Close";
    const title = scopedWindowTitle(window);
    const context = scopedWindowContext(window);
    return {
      id: `computers:${command}:${window.window_id}`,
      title: verb,
      breadcrumb: `Computers › Windows › ${title}`,
      searchText: [verb, title, window.title, window.label, window.workspace_path ?? "", context].join(" "),
      scope: "computers",
      icon: command === "focus" ? Focus : command === "hide" ? EyeOff : command === "show" ? Eye : command === "open" ? AppWindow : X,
      awaitResult: true,
      dismissImmediatelyOnSuccess: command === "focus" || command === "show" || command === "open",
      confirm: command === "close" ? closeConfirmation(window) : undefined,
      run:
        command === "focus"
          ? () => focusScopedWindow(window)
          : command === "show"
            ? () => showScopedWindow(window)
            : command === "open"
              ? () => openScopedWindow(window)
              : command === "hide"
                ? () => buryScopedWindow(window, false)
                : () => closeAfterFreshConfirmation(window),
    };
  }

  function closeMessage(count: unknown): string {
    if (typeof count !== "number") return "Open sessions in this window may stop.";
    if (count === 0) return "This window will close.";
    return `${count} terminal session${count === 1 ? "" : "s"} in this window will stop.`;
  }

  function informedCloseConfirmation(
    window: ScopedLibraryWindow,
    count: unknown,
  ): DeckConfirm {
    return {
      title: `Close ${scopedWindowTitle(window)}?`,
      message: closeMessage(count),
      actionLabel: "Close",
      danger: true,
    };
  }

  /// Claim the next reading slot for a window's Close card. Every count read
  /// takes one before it asks, so the reading that answers last is the only one
  /// still entitled to describe the card.
  function nextCloseReading(windowId: string): number {
    const version = (closePreparationVersions.get(windowId) ?? 0) + 1;
    closePreparationVersions.set(windowId, version);
    return version;
  }

  function closeReadingIsCurrent(windowId: string, version: number): boolean {
    return closePreparationVersions.get(windowId) === version;
  }

  /// The capability route answers the host-wide figure, the same one the
  /// launcher's Close card names. A failure leaves the generic warning rather
  /// than a number nobody can stand behind.
  async function readCloseCount(window: ScopedLibraryWindow): Promise<unknown> {
    try {
      return await loadScopedWindowLiveTerminals(window.window_id);
    } catch {
      return null;
    }
  }

  /// Raising the card reads the count, so the question names a number instead
  /// of warning in general terms.
  function closeConfirmation(window: ScopedLibraryWindow): () => Promise<DeckConfirm> {
    return async () => {
      const version = nextCloseReading(window.window_id);
      const count = await readCloseCount(window);
      if (closeReadingIsCurrent(window.window_id, version)) {
        confirmedCloseCounts.set(window.window_id, count);
      }
      return informedCloseConfirmation(window, count);
    };
  }

  /// Close reads the count again and stops to confirm a second time when it
  /// moved, so the window goes only on a number the user has just seen. The
  /// reading is slotted like the card's: one overtaken by a newer read
  /// describes a card that is no longer on screen, so it asks again rather than
  /// closing on what it found.
  async function closeAfterFreshConfirmation(
    window: ScopedLibraryWindow,
  ): Promise<void | DeckConfirm> {
    const version = nextCloseReading(window.window_id);
    const recorded = confirmedCloseCounts.get(window.window_id);
    const hadRecorded = confirmedCloseCounts.has(window.window_id);
    const fresh = await readCloseCount(window);
    if (!closeReadingIsCurrent(window.window_id, version)) {
      return informedCloseConfirmation(window, fresh);
    }
    if (!hadRecorded || fresh !== recorded) {
      confirmedCloseCounts.set(window.window_id, fresh);
      return informedCloseConfirmation(window, fresh);
    }
    confirmedCloseCounts.delete(window.window_id);
    await buryScopedWindow(window, true);
  }

  function scopedWorkspaceEntry(workspace: ScopedLibraryWorkspace): Entry {
    const name = scopedWorkspaceName(workspace);
    return {
      id: `computers:new-window:${workspace.workspace_id}`,
      title: name,
      breadcrumb: "Computers › New window › This machine",
      searchText: `${name} ${workspace.path} workspace new window`,
      scope: "computers",
      icon: AppWindow,
      awaitResult: true,
      dismissImmediatelyOnSuccess: true,
      run: () =>
        createScopedWindow({
          action: "new_workspace_window",
          workspace_id: workspace.workspace_id,
        }),
    };
  }

  function computerTargetEntries(path: readonly string[]): Entry[] {
    const snapshot = scopedLibrary;
    if (!snapshot) return [];
    const [branch, windowId] = path;
    switch (branch) {
      case "new-window":
        return snapshot.workspaces
          .filter((workspace) => scopedWorkspaceOpenable(workspace.status))
          .map(scopedWorkspaceEntry);
      case "windows": {
        // The roster order is the server's: this window first, then terminals
        // before workspaces, then ordinal.
        if (windowId === undefined) {
          return snapshot.windows
            .filter((window) => scopedWindowActions(window).length > 0)
            .map(scopedWindowBranch);
        }
        const window = snapshot.windows.find((candidate) => candidate.window_id === windowId);
        if (!window) return [];
        return scopedWindowActions(window).map((action) => scopedWindowEntry(action, window));
      }
      default:
        return [];
    }
  }

  /// A new terminal window on this machine. The capability names one library,
  /// so there is no machine to choose and the row runs at once.
  const newTerminalWindowEntry: Entry = {
    id: "computers:new-terminal",
    title: "New terminal window",
    breadcrumb: "Computers › This machine",
    searchText: "new terminal window this machine computer library shell",
    scope: "computers",
    icon: Terminal,
    awaitResult: true,
    dismissImmediatelyOnSuccess: true,
    run: () => createScopedWindow({ action: "new_terminal" }),
  };

  /// The Computers root over a snapshot: empty until one has arrived.
  const computerRootEntries = $derived.by<Entry[]>(() => {
    if (!scopedLibrary) return [];
    // One target-first Windows branch instead of a Focus/Hide/Show/Close
    // quartet that showed the same roster four times.
    return [
      newTerminalWindowEntry,
      computerCommandEntry("new-window", "New window", "Choose a workspace", AppWindow, "workspace"),
      computerCommandEntry(
        "windows",
        "Windows",
        "Choose a window",
        Layers,
        "focus show hide close open activate control terminal",
      ),
    ];
  });

  /// What the Computers scope shows in place of its root while no snapshot
  /// has arrived. Connecting only while the first request is unanswered, as
  /// the orb is enabled only then: a route that has failed reads unavailable
  /// through each request that follows.
  const computerStatusEntry = $derived<Entry>({
    id: "computers:status",
    title:
      scopedLibraryLoading && scopedLibraryError === null
        ? "Connecting to this computer\u2026"
        : "Computers unavailable",
    breadcrumb: scopedLibraryError
      ? "This window was not granted library access"
      : "Waiting for this window's library",
    searchText: "computers library unavailable connecting",
    scope: "computers",
    icon: MonitorCog,
    disabled: true,
  });

  // Typed search crosses every level, so it carries the window rows AND each
  // window's actions: `focus deploy shell` must still act in one Enter rather
  // than only descending into that window.
  const computerDeepEntries = $derived.by<Entry[]>(() => {
    const snapshot = scopedLibrary;
    if (!snapshot) return [];
    return [
      newTerminalWindowEntry,
      ...computerTargetEntries(["new-window"]),
      ...computerTargetEntries(["windows"]),
      ...snapshot.windows.flatMap((window) =>
        scopedWindowActions(window).map((action) => scopedWindowEntry(action, window)),
      ),
    ];
  });

  /// The Computers root as browsing lists it, under its heading. A typed
  /// query lists the same rows flat, with no heading.
  const computerSectionEntries = $derived(
    computerRootEntries.map((entry): Entry => ({ ...entry, section: COMPUTERS_SECTION })),
  );

  /// The Computers scope's own list: the root while browsing, and every
  /// level flattened under a typed query.
  function computerScopeEntries(query: string): Entry[] {
    if (!scopedLibrary) return [computerStatusEntry];
    if (!query) return computerSectionEntries;
    const branches = computerRootEntries.filter((entry) => entry.next !== undefined);
    return rankDeckItems([...branches, ...computerDeepEntries], query) as Entry[];
  }

  /// The rows of the branch the path names, when the catalog builders own
  /// it: null for a Computers path, and for a branch this window no longer
  /// offers.
  const catalogBranch = $derived.by<DeckRow[] | null>(() => {
    void revision;
    if (!launcherDraft.visible || !catalogMode) return null;
    return branchRows(deckSource(), launcherDraft.path, openSettingsAt);
  });

  const visibleEntries = $derived.by<Entry[]>(() => {
    void revision;
    if (!launcherDraft.visible) return [];
    const query = launcherDraft.query.trim();
    const scope = launcherDraft.scope;
    if (catalogMode) {
      return (rankDeckItems(catalogBranch ?? [], query) as DeckRow[]).map(withIcon);
    }
    if (computerMode) {
      return rankDeckItems(computerTargetEntries(launcherDraft.path), query) as Entry[];
    }
    if (scope === "computers") return computerScopeEntries(query);
    const source = deckSource();
    if (!query) {
      // Browsing ends with this machine's Computers rows; a scope shows its
      // own sections alone.
      const rows = browseRows(source, scope, openSettingsAt).map(withIcon);
      return scope === null ? [...rows, ...computerSectionEntries] : rows;
    }
    // Typed search crosses menu levels and includes this invoking library's
    // leaves.
    const leaves = scope === null ? computerDeepEntries : [];
    return searchRows(source, scope, query, openSettingsAt, leaves).map(withIcon);
  });

  /// Where the deck stands, for the chip beside the query.
  const crumbs = $derived.by<string[] | undefined>(() => {
    if (catalogMode || !computerMode) {
      return deckCrumbs(deckSource(), launcherDraft.scope, launcherDraft.path);
    }
    const branch = computerRootEntries.find((entry) => entry.next?.[0] === computerMode);
    const trail = [COMPUTERS_SECTION, branch?.title ?? COMPUTERS_SECTION];
    const window = windowMode
      ? scopedLibrary?.windows.find((candidate) => candidate.window_id === windowMode)
      : undefined;
    return window ? [...trail, scopedWindowTitle(window)] : trail;
  });

  const placeholder = $derived(crumbs?.at(-1) ?? "Search");

  $effect(() => {
    JSON.stringify(launcherDraft);
    persistLauncherDraft();
  });

  // Close records are per window and this deck stays mounted for the life of
  // the window, so a window that leaves the roster takes its records with it.
  // A snapshot that has not arrived says nothing about the roster, so it
  // forgets nothing.
  $effect(() => {
    const snapshot = scopedLibrary;
    if (!snapshot) return;
    const live = new Set(snapshot.windows.map((window) => window.window_id));
    for (const key of [...confirmedCloseCounts.keys()]) {
      if (!live.has(key)) confirmedCloseCounts.delete(key);
    }
    for (const key of [...closePreparationVersions.keys()]) {
      if (!live.has(key)) closePreparationVersions.delete(key);
    }
  });

  /// Say why the deck moved under the user, then clear the notice.
  function flashContextChanged(): void {
    launcherDraft.contextChanged = true;
    if (contextNoticeTimer) clearTimeout(contextNoticeTimer);
    contextNoticeTimer = setTimeout(() => {
      launcherDraft.contextChanged = false;
      persistLauncherDraft();
    }, 2400);
  }

  // The roster is polled while the deck is open, so a window can close from
  // somewhere else while its own actions are on screen. Fall back to the list
  // rather than an empty body; the recovery below only fires once a selection
  // is lost, which leaves an unselected submenu blank. A window that stays in
  // the roster and offers no action, as a restored draft can name, has no row
  // in the list either, so its path returns to the root.
  $effect(() => {
    if (!launcherDraft.visible || !scopedLibrarySettled || !windowMode) return;
    const window = scopedLibrary?.windows.find((candidate) => candidate.window_id === windowMode);
    if (window && scopedWindowActions(window).length > 0) return;
    launcherDraft.path = window ? [] : ["windows"];
    launcherDraft.selectedId = null;
    launcherDraft.operation = null;
    flashContextChanged();
  });

  // A restored draft can name a scope this window does not list: one a
  // window without a workspace leaves out, or an id no longer in use.
  $effect(() => {
    const scope = launcherDraft.scope;
    if (scope !== null && !scopes.some((candidate) => candidate.id === scope)) {
      launcherDraft.scope = null;
    }
  });

  // A choice or a Settings section can leave while its rows are on screen:
  // the tab it belongs to closes, or a reload restores a path whose command
  // is gone. Return to the root and say why briefly.
  $effect(() => {
    if (!launcherDraft.visible || !catalogMode || catalogBranch !== null) return;
    launcherDraft.path = [];
    launcherDraft.selectedId = null;
    launcherDraft.operation = null;
    flashContextChanged();
  });

  // A reloaded draft may reference a command that disappeared with its old tab
  // or pane. Fall to the same scope/root, preserve query, and say why briefly.
  $effect(() => {
    const selected = launcherDraft.selectedId;
    const waitingForLibrary =
      !scopedLibrarySettled &&
      (launcherDraft.scope === "computers" || launcherDraft.path.length > 0 || selected?.startsWith("computers:"));
    if (
      !launcherDraft.visible ||
      !selected ||
      waitingForLibrary ||
      visibleEntries.some((item) => item.id === selected)
    ) return;
    launcherDraft.selectedId = visibleEntries[0]?.id ?? null;
    launcherDraft.path = [];
    launcherDraft.operation = null;
    flashContextChanged();
  });

  function back(): void {
    if (launcherDraft.operation) {
      launcherDraft.operation = null;
    } else if (launcherDraft.path.length) {
      direction = "back";
      launcherDraft.path = launcherDraft.path.slice(0, -1);
      launcherDraft.selectedId = null;
    } else if (launcherDraft.scope) {
      direction = "back";
      launcherDraft.scope = null;
      launcherDraft.selectedId = null;
    } else {
      launcherDraft.selectedId = null;
    }
  }

  /// Run a toggle, an option or a stepped value: the deck stays on the row
  /// and reads its new state once the run settles.
  async function runInPlace(entry: Entry, item: DeckItem): Promise<void> {
    let waiting = true;
    const settled = (async () => {
      await entry.run?.();
    })().then(
      () => {
        revision += 1;
      },
      (error: unknown) => {
        revision += 1;
        if (waiting) throw error;
        commandFailed(item, error);
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, IN_PLACE_WAIT_MS);
    });
    try {
      await Promise.race([settled, bound]);
    } finally {
      waiting = false;
      clearTimeout(timer);
    }
  }

  async function choose(item: DeckItem): Promise<void | DeckConfirm> {
    const entry = visibleEntries.find((candidate) => candidate.id === item.id);
    if (!entry) return;
    if (entry.next) {
      direction = "forward";
      // The query found the row; what it opens is listed whole and in its
      // own order. A Computers branch keeps the query, which its rows match.
      if (isCatalogPath(entry.next)) launcherDraft.query = "";
      launcherDraft.path = entry.next;
      launcherDraft.selectedId = null;
      return;
    }
    if (entry.recent) noteCommandRun(entry.recent);
    if (entry.after === "stay") {
      await runInPlace(entry, item);
      return;
    }
    if (entry.after === "close") {
      // Close first so a command-owned overlay/focus target lands on top. A
      // confirmed successful dispatch clears this draft; plain hiding does not.
      closeCommandLauncher();
      clearLauncherDraft();
      await entry.run?.();
      return;
    }
    // A Computers row. A run that answers with a confirmation is asking the
    // deck to put that question instead of reporting success.
    return (await entry.run?.()) as void | DeckConfirm;
  }

  function succeeded(): void {
    closeCommandLauncher();
    clearLauncherDraft();
  }

  function commandFailed(item: DeckItem, error: unknown): void {
    notify(`${item.title}: ${errorText(error)}`);
  }

  function onScope(scope: DeckScopeId): void {
    direction = "still";
    launcherDraft.scope = scope;
    launcherDraft.path = [];
    launcherDraft.selectedId = null;
  }

  function clearScope(): void {
    direction = "back";
    launcherDraft.scope = null;
    launcherDraft.path = [];
    launcherDraft.selectedId = null;
  }
</script>

<CommandDeck
  open={launcherDraft.visible}
  bind:draft={deckDraft}
  items={visibleEntries}
  {scopes}
  {crumbs}
  {placeholder}
  bodyKey={`${launcherDraft.path.join("/")}:${launcherDraft.scope ?? "all"}:${ctx.activeSide ?? "none"}:${ctx.activeTabId ?? "none"}`}
  {direction}
  onClose={closeCommandLauncher}
  onChoose={choose}
  onError={commandFailed}
  onBack={back}
  {onScope}
  onClearScope={clearScope}
  onSuccess={succeeded}
  onFocusLost={bumpTabFocusPulse}
  mayTakeFocus={() => !refocusRefused(activeTerminalTab()?.id ?? null)}
/>
