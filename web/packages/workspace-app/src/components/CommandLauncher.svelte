<script lang="ts">
  // Context provider for the shared command deck. Commands remain owned by the
  // workspace app and execute through their existing run thunks; the shared deck
  // owns presentation, keyboard zones, motion, and persisted draft semantics.
  import CommandDeck from "@chan/web-shared/CommandDeck.svelte";
  import {
    clearClonedSessionDeckDrafts,
    fuzzyDeckScore,
    rankDeckItems,
    type DeckItem,
    type DeckScope,
    type DeckScopeId,
  } from "@chan/web-shared/command-deck";
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
  import { blockedWindowMessage, isTauriDesktop } from "../api/desktop";
  import { sessionWindowId } from "../api/client";
  import { ApiError } from "../api/errors";
  import {
    loadScopedLibrarySnapshot,
    runScopedLibraryAction,
    type ScopedLibrarySnapshot,
    type ScopedLibraryWindow,
    type ScopedLibraryWorkspace,
  } from "../api/libraryCommand";
  import "../state/commands/install";

  type ComputerCommandId = "new-terminal" | "new-window" | "focus" | "hide" | "show" | "close";

  interface Entry extends DeckItem {
    next?: ComputerCommandId;
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
  const computerMode = $derived((launcherDraft.path[0] as ComputerCommandId | undefined) ?? null);
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
      case "extension":
        return "Apps";
      default:
        return null;
    }
  }

  function scopeFor(command: Command): DeckScopeId {
    const active = surfaceCategory(ctx.activeSurface);
    if (command.category === active || command.category === "Tabs") return "tab";
    if (command.category === "Panes") return "pane";
    return "window";
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

  function contextualOrder(a: ContextEntry, b: ContextEntry): number {
    const weight: Record<DeckScopeId, number> = { tab: 0, pane: 1, window: 2, computers: 3 };
    return (
      weight[a.scope] - weight[b.scope] ||
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
    return window.label ? `${window.title} — ${window.label}` : window.title;
  }

  function scopedWindowContext(window: ScopedLibraryWindow): string {
    if (window.control) return "Control terminal";
    if (window.kind === "terminal") return "Terminal";
    return window.workspace_path?.split("/").filter(Boolean).at(-1) ?? "Workspace";
  }

  function popupFor(window: ScopedLibraryWindow): Window {
    if (window.window_id === sessionWindowId()) return globalThis.window;
    const popup = globalThis.window.open("", window.window_id);
    if (!popup)
      throw new Error(blockedWindowMessage("The browser blocked the Chan window"));
    return popup;
  }

  function popupNeedsNavigation(popup: Window): boolean {
    try {
      return popup.location.href === "about:blank" || popup.location.href === "";
    } catch {
      return true;
    }
  }

  async function focusScopedWindow(window: ScopedLibraryWindow): Promise<void> {
    // chan-desktop has no popups: `window.open` returns null in every chan
    // webview, so the browser's open-and-navigate dance cannot run here. A
    // devserver window record already has its native window, opened and
    // labelled by the desktop's window watcher, so un-burying is the only
    // action this surface owns. Raising an already-visible native window needs
    // a surface neither the scoped library nor the desktop exposes yet.
    if (isTauriDesktop()) {
      if (window.hidden && window.can_act) {
        await runScopedLibraryAction({
          action: "set_window_visibility",
          window_id: window.window_id,
          hidden: false,
        });
      }
      await refreshScopedLibrary();
      return;
    }
    const popup = popupFor(window);
    if (window.hidden && window.can_act) {
      await runScopedLibraryAction({
        action: "set_window_visibility",
        window_id: window.window_id,
        hidden: false,
      });
    }
    if (popup !== globalThis.window && popupNeedsNavigation(popup)) {
      popup.location.href = window.launch_path;
    }
    popup.focus();
    await refreshScopedLibrary();
  }

  async function createScopedWindow(
    action:
      | { action: "new_terminal" }
      | { action: "new_workspace_window"; workspace_id: string },
  ): Promise<void> {
    // chan-desktop opens the native window itself: the action creates the
    // devserver window record, and the window watcher reconciles it into a
    // native window carrying the `<library_id>::<window_id>` label the runtime
    // capability is scoped to. Opening a popup here cannot participate in that
    // -- the label is not knowable until the record exists -- and `window.open`
    // returns null in chan webviews regardless.
    if (isTauriDesktop()) {
      const result = await runScopedLibraryAction(action);
      if (!result?.window) throw new Error("Chan did not return the new window");
      await refreshScopedLibrary();
      return;
    }
    // Must happen before the first await so keyboard activation retains the
    // browser's popup grant.
    const popup = globalThis.window.open("", "_blank");
    if (!popup)
      throw new Error(
        blockedWindowMessage("The browser blocked the new Chan window"),
      );
    clearClonedSessionDeckDrafts(popup);
    try {
      const result = await runScopedLibraryAction(action);
      if (!result?.window) throw new Error("Chan did not return the new window");
      popup.name = result.window.window_id;
      popup.location.href = result.window.launch_path;
      popup.focus();
      await refreshScopedLibrary();
    } catch (error) {
      popup.close();
      throw error;
    }
  }

  async function buryScopedWindow(window: ScopedLibraryWindow, close: boolean): Promise<void> {
    // Acquiring the named context is also synchronous for keyboard popup rules.
    // If no such window exists the browser creates a blank one, which is closed
    // after the server mutation.
    const popup = popupFor(window);
    await runScopedLibraryAction(
      close
        ? { action: "close_window", window_id: window.window_id }
        : { action: "set_window_visibility", window_id: window.window_id, hidden: true },
    );
    popup.close();
    if (popup !== globalThis.window) await refreshScopedLibrary();
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
      next: id,
    };
  }

  function scopedWindowEntry(
    command: "focus" | "hide" | "show" | "close",
    window: ScopedLibraryWindow,
  ): Entry {
    const verb = command === "focus" ? "Focus" : command === "hide" ? "Hide" : command === "show" ? "Show" : "Close";
    const title = scopedWindowTitle(window);
    const context = scopedWindowContext(window);
    return {
      id: `computers:${command}:${window.window_id}`,
      title,
      breadcrumb: `Computers › ${verb} › ${context}`,
      searchText: [title, window.title, window.label, window.workspace_path ?? "", context, verb].join(" "),
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

  function computerTargetEntries(command: ComputerCommandId): Entry[] {
    const snapshot = scopedLibrary;
    if (!snapshot) return [];
    const owner = snapshot.role === "owner";
    switch (command) {
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
      case "focus":
        return snapshot.windows.map((window) => scopedWindowEntry(command, window));
      case "hide":
        return owner
          ? snapshot.windows
              .filter((window) => window.can_act && !window.control && !window.hidden)
              .map((window) => scopedWindowEntry(command, window))
          : [];
      case "show":
        return owner
          ? snapshot.windows
              .filter((window) => window.can_act && !window.control && window.hidden)
              .map((window) => scopedWindowEntry(command, window))
          : [];
      case "close":
        return owner
          ? snapshot.windows
              .filter((window) => window.can_act && !window.control)
              .map((window) => scopedWindowEntry(command, window))
          : [];
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
    entries.push(computerCommandEntry("focus", "Focus", "Choose a window", Focus, "open activate control terminal"));
    if (owner) {
      entries.push(
        computerCommandEntry("hide", "Hide", "Choose a visible window", EyeOff, "bury"),
        computerCommandEntry("show", "Show", "Choose a hidden window", Eye, "unhide"),
        computerCommandEntry("close", "Close", "Choose a window", X, "remove quit"),
      );
    }
    return entries;
  });

  const computerDeepEntries = $derived.by<Entry[]>(() =>
    (["new-terminal", "new-window", "focus", "hide", "show", "close"] as const).flatMap(
      computerTargetEntries,
    ),
  );

  const computerEntries = $derived(
    computerMode
      ? computerTargetEntries(computerMode)
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

  const visibleEntries = $derived(
    rankDeckItems(rawEntries, launcherDraft.query).slice(0, launcherDraft.query.trim() ? 9 : 5) as Entry[],
  );

  const placeholder = $derived(
    launcherDraft.scope
      ? scopes.find((scope) => scope.id === launcherDraft.scope)?.label ?? "Search"
      : computerMode
        ? computerRootEntries.find((entry) => entry.next === computerMode)?.title ?? "Computers"
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
    launcherDraft.contextChanged = true;
    if (contextNoticeTimer) clearTimeout(contextNoticeTimer);
    contextNoticeTimer = setTimeout(() => {
      launcherDraft.contextChanged = false;
      persistLauncherDraft();
    }, 2400);
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
      launcherDraft.path = [entry.next];
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
