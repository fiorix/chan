<script lang="ts">
  // Context provider for the shared command deck. The command catalog and the
  // settings index say what exists; state/commands/deck turns them into the
  // sectioned list, the typed results and the option lists. The Computers
  // rows are the shared Computers tree's, the one the Computers screen lists:
  // this component states this window's library snapshot as that tree's
  // model and carries its actions out through the library-window functions.
  // It adds the scope rail, the icons and the running of a row. The shared
  // deck owns presentation, the keyboard, motion and the persisted draft.
  import CommandDeck from "@chan/web-shared/CommandDeck.svelte";
  import {
    rankDeckItems,
    type DeckConfirm,
    type DeckItem,
    type DeckScope,
    type DeckScopeId,
  } from "@chan/web-shared/command-deck";
  import {
    computersConfirmBridge,
    computersDeck,
    computersEntryPoints,
    createComputersConfirmations,
    type ComputersBridge,
    type ComputersContext,
    type ComputersEntry,
    type ComputersModel,
    type ComputersWindow,
    type ComputersWorkspace,
    type ComputersWorkspaceCondition,
  } from "@chan/web-shared/computers-deck";
  import { privateText } from "@chan/web-shared/privacy";
  import { windowDisplayName } from "@chan/web-shared/window-label";
  import {
    AppWindow,
    ChartNoAxesColumn,
    Command as CommandIcon,
    ExternalLink,
    Eye,
    EyeOff,
    FilePlus,
    FileText,
    Focus,
    Folder,
    FolderRoot,
    Layers,
    Monitor,
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
    type ScopedWorkspaceStatus,
  } from "../api/libraryCommand";
  import {
    createLibraryWindow,
    libraryWindowActions,
    runLibraryWindowAction,
    type LibraryWindowBridge,
  } from "../api/libraryWindows";
  import { SETTINGS_SECTIONS } from "./settings/sections";
  import { settingsIndex } from "./settings/settingsIndex";
  import "../state/commands/install";

  let {
    allComputers,
  }: {
    /// Show the screen of this window's app that lists every computer, with
    /// the query typed here for it to search. Given where the app has such a
    /// screen: the Computers scope then ends with the row that opens it.
    allComputers?: (query: string) => void | Promise<void>;
  } = $props();

  /// A deck row and what choosing it does. A catalog or settings row comes
  /// from the builders with `after` set. A Computers row comes from the
  /// shared tree, and its run answers to the deck's own card: a confirmation
  /// to put, or a promise the deck awaits.
  type Entry = DeckRow;

  const COMPUTERS_SECTION = "Computers";
  /// Every type of Computers row sits in this deck's one Computers scope.
  const COMPUTERS_SCOPES = {
    windows: "computers",
    workspaces: "computers",
    machines: "computers",
    gateways: "computers",
  };

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
  // The server answered that it has no scoped route: no library stands
  // behind this window.
  let scopedLibraryAbsent = $state(false);
  let scopedLibraryLoad: Promise<void> | null = null;
  // Local assignable alias for Svelte's ownership contract. Both names point
  // at the same imported state proxy; CommandDeck mutates fields, never swaps
  // the draft object.
  let deckDraft = $state(launcherDraft);

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
  // section. Any other non-empty path names pages of the Computers tree,
  // outermost first: every workspace or every window, a workspace's, a
  // window's.
  const catalogMode = $derived(isCatalogPath(launcherDraft.path));
  const computerMode = $derived(!catalogMode && launcherDraft.path.length > 0);

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
    // A window with no library behind it has no computers to list, so the
    // rail leaves the scope out.
    ...(scopedLibraryAbsent
      ? []
      : [
          {
            id: "computers",
            label: COMPUTERS_SECTION,
            icon: MonitorCog,
            // Enabled over a snapshot, and while the first request is
            // unanswered, so a window about to get its library reads
            // Connecting. A route that has failed with no snapshot to show
            // leaves the orb disabled through the requests that follow, each
            // poll's among them.
            available: scopedLibrary !== null || (scopedLibraryLoading && scopedLibraryError === null),
          },
        ]),
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
        scopedLibraryAbsent = false;
      })
      .catch((error) => {
        // A server without the scoped route has no library behind this
        // window. Other failures stay recoverable: the next open/poll remints
        // after the source /ws reconnects.
        scopedLibraryError = errorText(error);
        if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
          scopedLibrary = null;
          scopedLibraryAbsent = true;
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
  function scopedWindowName(window: ScopedLibraryWindow): string {
    return privateText(windowDisplayName(window), "Window");
  }

  /// A workspace row's name in the deck: its label, else its root's last
  /// component cut at `/` alone, so a Windows root with no label reads whole.
  function scopedWorkspaceName(workspace: ScopedLibraryWorkspace): string {
    return privateText(workspace.label || workspace.path.split("/").filter(Boolean).at(-1) || workspace.path, "Workspace");
  }

  /// The workspace of a window no row lists, named from the window's own
  /// path, cut at `/` alone: a `\` can be part of a Unix directory's name.
  function unlistedWorkspaceName(window: ScopedLibraryWindow): string {
    const name = window.workspace_path?.split("/").filter(Boolean).at(-1);
    return name ? privateText(name, "Workspace") : "Workspace";
  }

  /// How a workspace's mount reads in the Computers tree. Total over the
  /// union, so a new status has to decide this rather than inherit an answer.
  function workspaceCondition(status: ScopedWorkspaceStatus): ComputersWorkspaceCondition {
    switch (status) {
      case "stopped":
        return "idle";
      case "starting":
      case "closing":
      case "removing":
        return "busy";
      case "running":
        return "ready";
      case "locked":
        return "foreign";
      case "unavailable":
        return "degraded";
      case "error":
        return "failed";
    }
  }

  /// This window's library as the Computers tree reads it: one machine, the
  /// workspaces the snapshot lists and the windows this surface can act on,
  /// each under the workspace row that lists its root. The capability names
  /// one library and grants a new window and a new terminal window, nothing
  /// else, so the model states those two and the tree offers no more. The
  /// records ride beside the model: the tree hands back keys.
  const library = $derived.by<{
    model: ComputersModel;
    windows: Map<string, ScopedLibraryWindow>;
  } | null>(() => {
    const snapshot = scopedLibrary;
    if (!snapshot) return null;
    const own = sessionWindowId();
    const windows = new Map<string, ScopedLibraryWindow>();
    // A window this surface can do nothing to has no row.
    const listed = snapshot.windows.filter((window) => libraryWindowActions(window).length > 0);

    function windowModel(window: ScopedLibraryWindow, context?: string): ComputersWindow {
      windows.set(window.window_id, window);
      return {
        key: window.window_id,
        name: scopedWindowName(window),
        kind: window.kind,
        context,
        // The names privacy mode conceals stay findable.
        search: [window.label, window.title, window.workspace_path ?? "", window.kind].join(" "),
        hidden: window.hidden,
        control: window.control,
        current: window.window_id === own,
        actions: libraryWindowActions(window),
      };
    }

    const workspaces = snapshot.workspaces.map((workspace): ComputersWorkspace => {
      const name = scopedWorkspaceName(workspace);
      return {
        key: workspace.workspace_id,
        name,
        search: `${workspace.label} ${workspace.path}`,
        on: workspace.on,
        condition: workspaceCondition(workspace.status),
        reason: workspace.error ? privateText(workspace.error, "Workspace unavailable") : undefined,
        // The first row that lists a root takes its windows, so no window
        // is listed twice.
        windows: listed
          .filter(
            (window) =>
              window.kind === "workspace" &&
              window.workspace_path === workspace.path &&
              !windows.has(window.window_id),
          )
          .map((window) => windowModel(window, name)),
      };
    });
    const loose = listed
      .filter((window) => !windows.has(window.window_id))
      .map((window) =>
        windowModel(window, window.kind === "workspace" ? unlistedWorkspaceName(window) : undefined),
      );

    return {
      model: {
        machines: [
          {
            key: "local",
            kind: "local",
            name: "This machine",
            search: "local computer library",
            workspaces,
            windows: loose,
          },
        ],
        may: { terminal: true, window: true, allComputers: allComputers !== undefined },
      },
      windows,
    };
  });

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

  function gone(what: string): Error {
    return new Error(`That ${what} is no longer available`);
  }

  /// Show the screen that lists every computer, with what was typed here for
  /// it to search. A query that found the row by the row's own words names
  /// nothing to look for there.
  function showAllComputers(): void | Promise<void> {
    const query = launcherDraft.query.trim();
    const row = computers?.entries.find((entry) => entry.pinned);
    const own = row !== undefined && query !== "" && rankDeckItems([row], query).length > 0;
    return allComputers?.(own ? "" : query);
  }

  // How the Computers tree reaches this window's library. Each action runs
  // before its first await as far as `window.open`, so a keyboard activation
  // keeps the browser's popup grant.
  const computersBridge: ComputersBridge = {
    run(command) {
      switch (command.target) {
        case "window": {
          const window = library?.windows.get(command.key);
          if (!window) throw gone("window");
          return runLibraryWindowAction(libraryWindowBridge, window, command.action);
        }
        case "workspace":
          if (command.action !== "new-window") break;
          return createLibraryWindow(libraryWindowBridge, {
            action: "new_workspace_window",
            workspace_id: command.key,
          });
        case "machine":
          if (command.action !== "new-terminal") break;
          return createLibraryWindow(libraryWindowBridge, { action: "new_terminal" });
        case "app":
          if (command.action !== "all-computers") break;
          return showAllComputers();
      }
      // The tree offers what the model says this window may do, which is
      // the actions above.
      throw gone("command");
    },
    // The capability route answers the host-wide figure for a window, the one
    // the Computers screen's Close card names, read when the card is raised.
    liveTerminals: (target, key) =>
      target === "window" ? loadScopedWindowLiveTerminals(key) : Promise.resolve(null),
    // This window may not turn a workspace off, so the tree never asks.
    turnOff: () => Promise.reject(gone("command")),
  };

  const computersContext: ComputersContext = {
    bridge: computersBridge,
    // The count a Close card was painted with lives here, for as long as
    // this launcher stays mounted.
    confirmations: createComputersConfirmations(computersConfirmBridge(computersBridge)),
    // Every icon a row of this window's model draws.
    icons: {
      windows: Layers,
      window: AppWindow,
      terminal: Terminal,
      workspace: Folder,
      computers: MonitorCog,
      local: Monitor,
      focus: Focus,
      show: Eye,
      hide: EyeOff,
      open: ExternalLink,
      close: X,
    },
    scopes: COMPUTERS_SCOPES,
    // `New terminal` is this deck's word for a terminal tab.
    terminalTitle: "New terminal window",
  };

  /// The Computers tree where the launcher stands: the page a Computers path
  /// names, or the tree's root. Null until a snapshot has arrived.
  const computers = $derived(
    library
      ? computersDeck(
          library.model,
          {
            path: computerMode ? launcherDraft.path : [],
            filter: null,
            query: launcherDraft.query,
          },
          computersContext,
        )
      : null,
  );

  /// The tree's rows as a typed query lists them: ranked, then the row the
  /// tree pins, which leads out of this library and so ends the list whatever
  /// was typed. An empty query keeps the tree's own order and sections.
  function computerRows(entries: readonly ComputersEntry[], query: string): Entry[] {
    if (!query) return [...entries];
    const ranked = rankDeckItems(entries.filter((entry) => !entry.pinned), query);
    return [...ranked, ...entries.filter((entry) => entry.pinned)];
  }

  /// The tree's rows as a list of every scope holds them. Each says it is a
  /// Computers row, as a command's row names its scope: the tree's own
  /// breadcrumb starts below that, at the type of object, and a type that
  /// only repeats the scope's name is left out.
  function amongScopes(entries: readonly ComputersEntry[]): Entry[] {
    return entries.map((entry) => ({
      ...entry,
      breadcrumb:
        entry.breadcrumb === COMPUTERS_SECTION
          ? COMPUTERS_SECTION
          : `${COMPUTERS_SECTION} › ${entry.breadcrumb}`,
    }));
  }

  /// What a list of every scope shows of this machine while it browses: the
  /// ways into the Computers tree, one row each, under the scope's name. The
  /// tree itself is the Computers scope's. Nothing until a snapshot arrives.
  const computerEntryPoints = $derived<Entry[]>(
    library ? computersEntryPoints(library.model, computersContext) : [],
  );

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
      return rankDeckItems(catalogBranch ?? [], query).map(withIcon);
    }
    if (computerMode || scope === "computers") {
      if (computers) return computerRows(computers.entries, query);
      return computerMode ? [] : [computerStatusEntry];
    }
    const source = deckSource();
    if (!query) {
      // Browsing every scope ends with the ways into this machine's tree.
      return [
        ...browseRows(source, scope, openSettingsAt).map(withIcon),
        ...(scope === null ? computerEntryPoints : []),
      ];
    }
    // Typed search crosses every level: this machine's objects and each of
    // their actions rank with the commands, so `focus deploy shell` acts in
    // one Enter.
    const machine = scope === null && computers ? amongScopes(computers.entries) : [];
    return searchRows(source, scope, query, openSettingsAt, machine).map(withIcon);
  });

  /// Where the deck stands, for the chip beside the query.
  const crumbs = $derived.by<string[] | undefined>(() => {
    if (!computerMode) {
      return deckCrumbs(deckSource(), launcherDraft.scope, launcherDraft.path);
    }
    return [COMPUTERS_SECTION, ...(computers?.crumbs ?? [])];
  });

  const placeholder = $derived(crumbs?.at(-1) ?? "Search");

  $effect(() => {
    JSON.stringify(launcherDraft);
    persistLauncherDraft();
  });

  // A Close card's count is kept per window and this launcher stays mounted
  // for the life of the window, so a window that leaves the roster takes its
  // count with it. A snapshot that has not arrived says nothing about the
  // roster, so it forgets nothing.
  $effect(() => {
    if (!library) return;
    computersContext.confirmations.retain(
      new Set(library.windows.keys()),
      new Set(library.model.machines.flatMap((machine) => machine.workspaces.map((row) => row.key))),
    );
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

  // The roster is polled while the launcher is open, so a window or a
  // workspace can leave from somewhere else while its page is on screen, and
  // a restored draft can name one this window does not list. Fall back to the
  // nearest page that still names an object, the root when none does, and
  // say why briefly. A draft restored before the first answer waits for it.
  $effect(() => {
    if (!launcherDraft.visible || !scopedLibrarySettled || !computerMode) return;
    const path = computers?.path ?? [];
    if (path.length === launcherDraft.path.length) return;
    direction = "back";
    launcherDraft.path = path;
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

  /// Open a branch or a page. The query found the row; what the row opens is
  /// listed whole and in its own order.
  function enter(path: string[]): void {
    direction = "forward";
    launcherDraft.query = "";
    launcherDraft.path = path;
    launcherDraft.selectedId = null;
  }

  /// Right on a row Enter would run: open the row's own page.
  function expand(item: DeckItem): void {
    const page = visibleEntries.find((candidate) => candidate.id === item.id)?.page;
    if (page) enter(page);
  }

  async function choose(item: DeckItem): Promise<void | DeckConfirm> {
    const entry = visibleEntries.find((candidate) => candidate.id === item.id);
    if (!entry) return;
    if (entry.next) {
      enter(entry.next);
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
    // A Computers row.
    if (!entry.awaitResult) {
      // What the row opens covers this window, so the launcher leaves as the
      // row starts. The row reads the query before the draft is cleared.
      const started = entry.run?.();
      closeCommandLauncher();
      clearLauncherDraft();
      await started;
      return;
    }
    // A run that answers with a confirmation is asking the deck to put that
    // question instead of reporting success.
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
  onExpand={expand}
  onError={commandFailed}
  onBack={back}
  {onScope}
  onClearScope={clearScope}
  onSuccess={succeeded}
  onFocusLost={bumpTabFocusPulse}
  mayTakeFocus={() => !refocusRefused(activeTerminalTab()?.id ?? null)}
/>
