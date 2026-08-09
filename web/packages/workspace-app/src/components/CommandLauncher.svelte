<script lang="ts">
  // Context provider for the shared command deck. Commands remain owned by the
  // workspace app and execute through their existing run thunks; the shared deck
  // owns presentation, keyboard zones, motion, and persisted draft semantics.
  import CommandDeck from "@chan/web-shared/CommandDeck.svelte";
  import {
    fuzzyDeckScore,
    rankDeckItems,
    type DeckItem,
    type DeckScope,
    type DeckScopeId,
  } from "@chan/web-shared/command-deck";
  import { windowDisplayName } from "@chan/web-shared/window-label";
  import {
    AppWindow,
    BarChart2,
    Command as CommandIcon,
    Eye,
    EyeOff,
    FilePlus,
    FileText,
    Focus,
    Folder,
    Layers3,
    MonitorCog,
    Network,
    PanelTop,
    PanelsTopLeft,
    Search as SearchIcon,
    Settings2,
    Shapes,
    SquareStack,
    Terminal,
    X,
  } from "lucide-svelte";
  import {
    clearLauncherDraft,
    closeCommandLauncher,
    launcherDraft,
    launcherReturnFocus,
    persistLauncherDraft,
  } from "../state/store.svelte";
  import {
    availableCommands,
    commandContext,
    type Command,
    type CommandCategory,
    type CommandSurface,
  } from "../state/commands";
  import { chordFor } from "../state/shortcuts";
  import { sessionWindowId } from "../api/client";
  import { ApiError } from "../api/errors";
  import {
    loadScopedLibrarySnapshot,
    runScopedLibraryAction,
    type ScopedLibrarySnapshot,
    type ScopedLibraryWindow,
    type ScopedLibraryWorkspace,
  } from "../api/libraryCommand";
  import {
    buryLibraryWindow,
    createLibraryWindow,
    focusLibraryWindow,
    type CreateLibraryWindowAction,
    type LibraryWindowBridge,
  } from "../api/libraryWindows";
  import "../state/commands/install";

  type ComputerCommandId = "new-terminal" | "new-window" | "windows";
  type WindowActionId = "focus" | "hide" | "show" | "close";

  interface Entry extends DeckItem {
    /// The deck path this branch navigates to, absolute rather than a single
    /// step: the Computers tree is three levels deep at `windows > <id>`.
    next?: string[];
    run?: () => void | Promise<void>;
    command?: Command;
    arg?: string;
  }

  interface ContextEntry extends Entry {
    commandKey: string;
    command: Command;
    arg?: string;
  }

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
    Dashboard: BarChart2,
    Graph: Network,
  };
  const namedIcons: Record<string, IconComponent> = {
    command: CommandIcon,
    dashboard: BarChart2,
    file: FileText,
    folder: Folder,
    graph: Network,
    panes: Shapes,
    search: SearchIcon,
    settings: Settings2,
    tabs: FilePlus,
    terminal: Terminal,
  };

  let direction: "forward" | "back" | "still" = $state("still");
  let wasOpen = false;
  let ranCommand = false;
  let restoreTarget: HTMLElement | null = null;
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

  const ctx = $derived(commandContext());
  // A non-empty path means the deck is inside a Computers branch. `windows`
  // carries a second element, the window whose own actions are being shown.
  const computerMode = $derived((launcherDraft.path[0] as ComputerCommandId | undefined) ?? null);
  const windowMode = $derived(computerMode === "windows" ? launcherDraft.path[1] ?? null : null);
  const scopes = $derived.by<DeckScope[]>(() => [
    { id: "tab", label: "Tab", icon: PanelTop },
    { id: "pane", label: "Pane", icon: PanelsTopLeft },
    { id: "window", label: "Window", icon: Layers3 },
    {
      id: "computers",
      label: "Computers",
      icon: MonitorCog,
      available: scopedLibrary !== null || scopedLibraryLoading,
    },
  ]);

  function surfaceCategory(surface: CommandSurface | null): CommandCategory | null {
    switch (surface) {
      case "file":
        return "Editor";
      case "browser":
        return "File Browser";
      case "terminal":
        return "Terminal";
      case "dashboard":
        return "Dashboard";
      case "graph":
        return "Graph";
      default:
        // No active tab, or an extension tab: extension entries all register
        // under Apps, so ownsExtensionCommand picks those out by id instead.
        return null;
    }
  }

  /// The tab-specific options of an extension tab are the commands that
  /// extension declares (`extension.<id>.<cmd>`). The bare `extension.<id>`
  /// entry opens or focuses the app, a spawn action like the rest of Apps, so
  /// it stays with the window alongside every other extension's entry.
  function ownsExtensionCommand(command: Command): boolean {
    const active = ctx.activeExtensionId;
    return active !== null && command.id.startsWith(`extension.${active}.`);
  }

  function scopeFor(command: Command): DeckScopeId {
    if (command.category === "Tabs") return "tab";
    if (command.category === "Panes") return "pane";
    if (ctx.activeSurface === "extension") return ownsExtensionCommand(command) ? "tab" : "window";
    return command.category === surfaceCategory(ctx.activeSurface) ? "tab" : "window";
  }

  function iconFor(command: Command): IconComponent {
    return command.icon ? namedIcons[command.icon] ?? categoryIcons[command.category] : categoryIcons[command.category];
  }

  function commandKey(command: Command): string {
    return `${command.id}\u001f${command.category}\u001f${command.title}`;
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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
        scopedLibraryError = errorMessage(error);
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

  function breadcrumbFor(command: Command, scope: DeckScopeId): string {
    const lead = scope === "tab" ? "Tab" : scope === "pane" ? "Pane" : "Window";
    return `${lead} › ${command.category}`;
  }

  function itemFor(command: Command, arg?: string): ContextEntry {
    const scope = scopeFor(command);
    const key = commandKey(command);
    return {
      id: `context:${key}${arg === undefined ? "" : `\u001f${arg}`}`,
      commandKey: key,
      command,
      arg,
      title: arg === undefined ? command.title : `${command.title} ${arg}`,
      breadcrumb: breadcrumbFor(command, scope),
      searchText: [command.title, ...(command.keywords ?? []), command.category, arg ?? ""].join(" "),
      scope,
      icon: iconFor(command),
      shortcut: chordFor(command.id),
      confirm: command.confirm,
    };
  }

  function compareText(a: string, b: string): number {
    return a.localeCompare(b, undefined, { sensitivity: "base" }) || a.localeCompare(b);
  }

  /// Inside Tab, the active application's own commands lead and the generic
  /// Tabs commands follow: `Tabs` sorts before `Terminal` or `Editor`
  /// alphabetically, which would otherwise bury the surface's actions.
  function tabCategoryRank(entry: ContextEntry): number {
    if (entry.scope !== "tab") return 0;
    return entry.command.category === "Tabs" ? 1 : 0;
  }

  function contextualOrder(a: ContextEntry, b: ContextEntry): number {
    const weight: Record<DeckScopeId, number> = { tab: 0, pane: 1, window: 2, computers: 3 };
    return (
      weight[a.scope] - weight[b.scope] ||
      tabCategoryRank(a) - tabCategoryRank(b) ||
      compareText(a.command.category, b.command.category) ||
      compareText(a.title, b.title) ||
      compareText(a.id, b.id)
    );
  }

  const contextualEntries = $derived.by<ContextEntry[]>(() => {
    const commands = availableCommands(ctx);
    const raw = launcherDraft.query.trim();
    const base = commands.map((command) => itemFor(command));
    if (!raw) return base.sort(contextualOrder);

    // Deep argument search: `Open notes/x.md` scores `Open` against an
    // acceptsArg command and keeps the remainder verbatim for execution.
    const split = /^(\S+)\s+(.+)$/.exec(raw);
    if (!split) return base;
    const head = split[1];
    const arg = split[2];
    const withArguments = commands
      .filter(
        (command) =>
          command.acceptsArg &&
          fuzzyDeckScore(head, `${command.title} ${(command.keywords ?? []).join(" ")}`) !== null,
      )
      .map((command) => itemFor(command, arg));
    return [...withArguments, ...base];
  });

  function scopedWindowTitle(window: ScopedLibraryWindow): string {
    return windowDisplayName(window);
  }

  function scopedWindowContext(window: ScopedLibraryWindow): string {
    if (window.control) return "Control terminal";
    if (window.kind === "terminal") return "Terminal";
    return window.workspace_path?.split("/").filter(Boolean).at(-1) ?? "Workspace";
  }

  // The deck keeps the capability lifecycle and the snapshot; how a window is
  // created, raised, or buried differs between a browser and chan-desktop and
  // lives in the api module, where it can be driven without the deck UI.
  const libraryWindowBridge: LibraryWindowBridge = {
    runAction: runScopedLibraryAction,
    refresh: refreshScopedLibrary,
    currentWindowId: sessionWindowId,
  };

  function focusScopedWindow(window: ScopedLibraryWindow): Promise<void> {
    return focusLibraryWindow(libraryWindowBridge, window);
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
  /// actions. Open versus hidden rides the breadcrumb because the deck is a
  /// flat listbox with no section headers.
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

  /// The actions this particular window can take. Focus and Show both route
  /// through focusLibraryWindow, which unhides and raises in one step, so a
  /// window offers one of the two and never both. Hide and Close are the
  /// owner-only mutations, and the capability route refuses either on a
  /// control terminal, so neither is offered there.
  function scopedWindowActions(window: ScopedLibraryWindow, owner: boolean): WindowActionId[] {
    const manageable = owner && window.can_act && !window.control;
    const actions: WindowActionId[] = [window.hidden ? "show" : "focus"];
    if (manageable && !window.hidden) actions.push("hide");
    if (manageable) actions.push("close");
    return actions;
  }

  function scopedWindowEntry(command: WindowActionId, window: ScopedLibraryWindow): Entry {
    const verb = command === "focus" ? "Focus" : command === "hide" ? "Hide" : command === "show" ? "Show" : "Close";
    const title = scopedWindowTitle(window);
    const context = scopedWindowContext(window);
    return {
      id: `computers:${command}:${window.window_id}`,
      title: verb,
      breadcrumb: `Computers › Windows › ${title}`,
      searchText: [verb, title, window.title, window.label, window.workspace_path ?? "", context].join(" "),
      scope: "computers",
      icon: command === "focus" ? Focus : command === "hide" ? EyeOff : command === "show" ? Eye : X,
      awaitResult: true,
      dismissImmediatelyOnSuccess: command === "focus" || command === "show",
      confirm:
        command === "close"
          ? {
              title: `Close ${title}?`,
              message: "Open sessions in this window may stop.",
              actionLabel: "Close",
              danger: true,
            }
          : undefined,
      run:
        command === "focus" || command === "show"
          ? () => focusScopedWindow(window)
          : () => buryScopedWindow(window, command === "close"),
    };
  }

  function scopedWorkspaceEntry(workspace: ScopedLibraryWorkspace): Entry {
    const name = workspace.label || workspace.path.split("/").filter(Boolean).at(-1) || workspace.path;
    return {
      id: `computers:new-window:${workspace.workspace_id}`,
      title: name,
      breadcrumb: "Computers › New window › This library",
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
    const owner = snapshot.role === "owner";
    const [branch, windowId] = path;
    switch (branch) {
      case "new-terminal":
        return owner
          ? [
              {
                id: "computers:new-terminal:this-library",
                title: "This library",
                breadcrumb: "Computers › New terminal",
                searchText: "this computer library shell terminal",
                scope: "computers",
                icon: Terminal,
                awaitResult: true,
                dismissImmediatelyOnSuccess: true,
                run: () => createScopedWindow({ action: "new_terminal" }),
              },
            ]
          : [];
      case "new-window":
        return owner
          ? snapshot.workspaces
              .filter((workspace) => workspace.can_act && workspace.status === "running")
              .map(scopedWorkspaceEntry)
          : [];
      case "windows": {
        // The roster order is the server's: this window first, then terminals
        // before workspaces, then ordinal.
        if (windowId === undefined) return snapshot.windows.map(scopedWindowBranch);
        const window = snapshot.windows.find((candidate) => candidate.window_id === windowId);
        if (!window) return [];
        return scopedWindowActions(window, owner).map((action) => scopedWindowEntry(action, window));
      }
      default:
        return [];
    }
  }

  const computerRootEntries = $derived.by<Entry[]>(() => {
    if (!scopedLibrary) {
      return [
        {
          id: "computers:status",
          title: scopedLibraryLoading ? "Connecting to this computer…" : "Computers unavailable",
          breadcrumb: scopedLibraryError
            ? "This window was not granted library access"
            : "Waiting for this window's library",
          searchText: "computers library unavailable connecting",
          scope: "computers",
          icon: MonitorCog,
          disabled: true,
        },
      ];
    }
    const owner = scopedLibrary.role === "owner";
    const entries: Entry[] = [];
    if (owner) {
      entries.push(
        computerCommandEntry("new-terminal", "New terminal", "This library", Terminal, "shell"),
        computerCommandEntry("new-window", "New window", "Choose a workspace", AppWindow, "workspace"),
      );
    }
    // One target-first branch instead of a Focus/Hide/Show/Close quartet that
    // showed the same roster four times. Every role gets it: a grantee's
    // windows still offer Focus, which is what the old Focus branch gave them.
    entries.push(
      computerCommandEntry(
        "windows",
        "Windows",
        "Choose a window",
        Layers3,
        "focus show hide close open activate control terminal",
      ),
    );
    return entries;
  });

  // Typed search crosses every level, so it carries the window rows AND each
  // window's actions: `focus deploy shell` must still act in one Enter rather
  // than only descending into that window.
  const computerDeepEntries = $derived.by<Entry[]>(() => {
    const snapshot = scopedLibrary;
    if (!snapshot) return [];
    const owner = snapshot.role === "owner";
    return [
      ...computerTargetEntries(["new-terminal"]),
      ...computerTargetEntries(["new-window"]),
      ...computerTargetEntries(["windows"]),
      ...snapshot.windows.flatMap((window) =>
        scopedWindowActions(window, owner).map((action) => scopedWindowEntry(action, window)),
      ),
    ];
  });

  const computerEntries = $derived(
    launcherDraft.path.length
      ? computerTargetEntries(launcherDraft.path)
      : launcherDraft.query.trim()
        ? [...computerRootEntries, ...computerDeepEntries]
        : computerRootEntries,
  );

  const rawEntries = $derived.by<Entry[]>(() => {
    if (computerMode || launcherDraft.scope === "computers") return computerEntries;
    if (launcherDraft.scope) {
      return contextualEntries.filter((entry) => entry.scope === launcherDraft.scope);
    }
    // Typed search crosses menu levels and includes this invoking library's
    // leaves. An empty contextual deck remains focused and uncluttered; the
    // always-visible Computers orb is one arrow away.
    return launcherDraft.query.trim()
      ? [...contextualEntries, ...computerDeepEntries]
      : contextualEntries;
  });

  // Only the root deck is a teaser. Picking a scope orb or stepping into a
  // Computers branch is an explicit "show me everything here", so those views
  // list in full; the deck body already scrolls and follows the selection.
  const visibleEntries = $derived.by<Entry[]>(() => {
    const ranked = rankDeckItems(rawEntries, launcherDraft.query) as Entry[];
    if (launcherDraft.scope || computerMode) return ranked;
    return ranked.slice(0, launcherDraft.query.trim() ? 9 : 5);
  });

  const placeholder = $derived(
    launcherDraft.scope
      ? scopes.find((scope) => scope.id === launcherDraft.scope)?.label ?? "Search"
      : computerMode
        ? computerRootEntries.find((entry) => entry.next?.[0] === computerMode)?.title ?? "Computers"
        : "Search",
  );

  $effect(() => {
    const open = launcherDraft.visible;
    if (open && !wasOpen) {
      restoreTarget = launcherReturnFocus();
      ranCommand = false;
    } else if (!open && wasOpen) {
      if (!ranCommand && restoreTarget && document.contains(restoreTarget)) {
        restoreTarget.focus();
      }
      restoreTarget = null;
    }
    wasOpen = open;
  });

  $effect(() => {
    JSON.stringify(launcherDraft);
    persistLauncherDraft();
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
  // is lost, which leaves an unselected submenu blank.
  $effect(() => {
    if (!launcherDraft.visible || !scopedLibrarySettled || !windowMode) return;
    if (scopedLibrary?.windows.some((window) => window.window_id === windowMode)) return;
    launcherDraft.path = ["windows"];
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
    } else if (launcherDraft.scope) {
      direction = "back";
      launcherDraft.scope = null;
    } else {
      launcherDraft.selectedId = null;
    }
  }

  async function choose(item: DeckItem): Promise<void> {
    const entry = visibleEntries.find((candidate) => candidate.id === item.id);
    if (!entry) return;
    if (entry.next) {
      direction = "forward";
      launcherDraft.path = entry.next;
      launcherDraft.selectedId = null;
      return;
    }
    if (!entry.command) {
      await entry.run?.();
      return;
    }
    // Close first so a command-owned overlay/focus target lands on top. A
    // confirmed successful dispatch clears this draft; plain hiding does not.
    ranCommand = true;
    closeCommandLauncher();
    clearLauncherDraft();
    await entry.command.run(entry.arg);
  }

  function succeeded(): void {
    ranCommand = true;
    closeCommandLauncher();
    clearLauncherDraft();
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
  {placeholder}
  bodyKey={`${launcherDraft.path.join("/")}:${launcherDraft.scope ?? "all"}:${ctx.activeSide ?? "none"}:${ctx.activeTabId ?? "none"}`}
  {direction}
  onClose={closeCommandLauncher}
  onChoose={choose}
  onBack={back}
  {onScope}
  onClearScope={clearScope}
  onSuccess={succeeded}
/>
