<script lang="ts">
  // Computers provider for the shared command deck. The shared component owns
  // interaction and motion; this adapter owns only live library targets and the
  // approved actions that operate on them.
  import CommandDeck from "@chan/web-shared/CommandDeck.svelte";
  import {
    rankDeckItems,
    type DeckItem,
    type DeckScope,
    type DeckScopeId,
  } from "@chan/web-shared/command-deck";
  import { Folder,
    AppWindow,
    Eye,
    EyeOff,
    Focus,
    Layers3,
    LogOut,
    Monitor,
    MonitorCog,
    Moon,
    Plug,
    Plus,
    Power,
    Server,
    SquareTerminal,
    Sun,
    Unplug,
    X,
  } from "lucide-svelte";
  import type { DevserverEntry, WindowRecord, WorkspaceEntry } from "../api/library";
  import { requestDesktopQuit } from "../api/desktop";
  import { basename, LOCAL_LIBRARY_ID, windowRowLabel } from "../lib/windowLabel";
  import { buildMachineTree } from "../lib/machineTree";
  import { library, clearError, disconnectDevserver } from "../state/library.svelte";
  import {
    canManageWindow,
    canOpenWorkspaceWindow,
    closeComputerWindow,
    connectComputer,
    focusComputerWindow,
    newTerminal,
    newWorkspaceWindow,
    setWindowShown,
    setWorkspacePower,
    newFilesWindow,
  } from "../state/computerActions";
  import {
    activeCommandLauncherDraft,
    clearCommandLauncherDraft,
    closeCommandLauncher,
    commandLauncher,
    persistCommandLauncherDraft,
    toggleCommandLauncher,
  } from "../state/commandLauncher.svelte";
  import { openNewDialog } from "../state/dialog.svelte";
  import { hasDesktopBridge, hostOs, readOnly,
    localFilesApp,
    selfManagedWindows,
  } from "../state/capabilities";
  import { dsKey, isPending, servedKey, wsKey } from "../state/pending.svelte";
  import { screen } from "../state/screen.svelte";
  import { themeState, toggleTheme } from "../state/theme.svelte";

  type CommandId =
    | "new-terminal"
    | "new-window"
    | "windows"
    | "connect"
    | "disconnect"
    | "turn-on"
    | "turn-off";
  type WindowActionId = "focus" | "hide" | "show" | "close";

  interface Entry extends DeckItem {
    /// The deck path this branch navigates to, absolute rather than a single
    /// step: the tree is three levels deep at `windows > <library>:<window>`.
    next?: string[];
    run?: () => void | Promise<void>;
  }

  let direction: "forward" | "back" | "still" = $state("still");
  const draft = $derived(activeCommandLauncherDraft());
  const mode = $derived((draft.path[0] as CommandId | undefined) ?? null);
  // A window key is library-qualified: window ids are unique only within the
  // library that minted them, and this deck aggregates several.
  const windowMode = $derived(mode === "windows" ? draft.path[1] ?? null : null);

  function windowKey(window: WindowRecord): string {
    return `${window.library_id}:${window.window_id}`;
  }

  const scopes: DeckScope[] = [{ id: "computers", label: "Computers", icon: MonitorCog }];

  function workspaceName(workspace: WorkspaceEntry): string {
    return workspace.label || basename(workspace.path) || workspace.path;
  }

  function devserverName(devserver: DevserverEntry): string {
    return devserver.label || `${devserver.host}:${devserver.port}`;
  }

  function machineNameForLibrary(libraryId: string): string {
    const devserver = library.devservers.find((row) => row.library_id === libraryId);
    return devserver ? devserverName(devserver) : "This machine";
  }

  function machineNameForWorkspace(workspace: WorkspaceEntry): string {
    if (!workspace.devserver_id) return "This machine";
    const devserver = library.devservers.find((row) => row.id === workspace.devserver_id);
    return devserver ? devserverName(devserver) : workspace.devserver_id;
  }

  function workspaceForWindow(window: WindowRecord): WorkspaceEntry | undefined {
    if (!window.workspace_path) return undefined;
    return library.workspaces.find(
      (workspace) =>
        workspace.path === window.workspace_path &&
        (workspace.library_id ?? LOCAL_LIBRARY_ID) === window.library_id,
    );
  }

  function windowContext(window: WindowRecord): string {
    const workspace = workspaceForWindow(window);
    if (window.kind === "workspace") {
      return workspace ? workspaceName(workspace) : basename(window.workspace_path ?? "") || "Workspace";
    }
    return window.control ? "Control terminal" : "Terminal";
  }

  /// The actions this particular window can take. Unlike the workspace app,
  /// Show here is a pure visibility flip that does not steal focus, so a
  /// hidden window keeps both it and Focus.
  function windowActions(window: WindowRecord): WindowActionId[] {
    if (!canManageWindow(window)) return [];
    return window.hidden ? ["focus", "show", "close"] : ["focus", "hide", "close"];
  }

  /// One row per window, each a branch into that window's own actions. The
  /// machine and open-versus-hidden ride the breadcrumb: the deck is a flat
  /// listbox with no section headers.
  function windowBranch(window: WindowRecord): Entry {
    const machine = machineNameForLibrary(window.library_id);
    const context = windowContext(window);
    const state = window.hidden ? "Hidden" : "Open";
    return {
      id: `computers:window:${windowKey(window)}`,
      title: windowRowLabel(window),
      breadcrumb: `Computers › Windows › ${machine} › ${state}`,
      searchText: [windowRowLabel(window), window.label ?? "", window.title, window.workspace_path ?? "", context, machine, window.kind, state, "window"].join(" "),
      scope: "computers",
      icon: window.kind === "terminal" ? SquareTerminal : AppWindow,
      kind: "branch",
      next: ["windows", windowKey(window)],
    };
  }

  function windowEntry(command: WindowActionId, window: WindowRecord): Entry {
    const machine = machineNameForLibrary(window.library_id);
    const context = windowContext(window);
    const verb = command === "focus" ? "Focus" : command === "hide" ? "Hide" : command === "show" ? "Show" : "Close";
    return {
      id: `computers:${command}:${window.library_id}:${window.window_id}`,
      title: verb,
      breadcrumb: `Computers › Windows › ${windowRowLabel(window)} › ${machine}`,
      searchText: [verb, windowRowLabel(window), window.label ?? "", window.title, window.workspace_path ?? "", context, machine, window.kind].join(" "),
      scope: "computers",
      icon: command === "focus" ? Focus : command === "hide" ? EyeOff : command === "show" ? Eye : X,
      awaitResult: true,
      dismissImmediatelyOnSuccess: command === "focus",
      confirm:
        command === "close"
          ? {
              title: `Close ${windowRowLabel(window)}?`,
              message: window.control
                ? "This stops the control terminal and its connection script."
                : "Open sessions in this window may stop.",
              actionLabel: "Close",
              danger: true,
            }
          : undefined,
      run:
        command === "focus"
          ? () => focusComputerWindow(window)
          : command === "hide"
            ? () => setWindowShown(window, false)
            : command === "show"
              ? () => setWindowShown(window, true)
              : () => closeComputerWindow(window),
    };
  }

  /// Every manageable window, in the order the Library screen shows them:
  /// local machine first, devservers by name, and within each the control
  /// terminal, then terminals, then workspace windows by ordinal.
  const orderedWindows = $derived.by<WindowRecord[]>(() => {
    const tree = buildMachineTree(library.devservers, library.workspaces, library.windows);
    const ordered = tree.machines.flatMap((machine) => [
      ...machine.control,
      ...machine.terminals,
      ...machine.workspaces.flatMap((workspace) => workspace.windows),
      ...machine.looseWindows,
    ]);
    return [...ordered, ...tree.orphans].filter(canManageWindow);
  });

  function workspacePending(workspace: WorkspaceEntry): boolean {
    return isPending(
      workspace.devserver_id
        ? servedKey(workspace.devserver_id, workspace.prefix)
        : wsKey(workspace.workspace_id),
    );
  }

  function workspaceTarget(
    command: "new-window" | "turn-on" | "turn-off",
    workspace: WorkspaceEntry,
  ): Entry {
    const name = workspaceName(workspace);
    const machine = machineNameForWorkspace(workspace);
    const verb = command === "new-window" ? "New window" : command === "turn-on" ? "Turn on" : "Turn off";
    return {
      id: `computers:${command}:${workspace.devserver_id ?? "local"}:${workspace.workspace_id}`,
      title: name,
      breadcrumb: `Computers › ${verb} › ${machine}`,
      searchText: `${name} ${workspace.label} ${workspace.path} ${machine} ${verb}`,
      scope: "computers",
      icon: command === "new-window" ? AppWindow : Power,
      awaitResult: true,
      dismissImmediatelyOnSuccess: command === "new-window",
      confirm:
        command === "turn-off"
          ? {
              title: `Turn off ${name}?`,
              message: "Running terminal sessions will require confirmation before they are stopped.",
              actionLabel: "Turn off",
              danger: true,
            }
          : undefined,
      run:
        command === "new-window"
          ? () => newWorkspaceWindow(workspace)
          : () => setWorkspacePower(workspace, command === "turn-on"),
    };
  }

  function targetEntries(path: readonly string[]): Entry[] {
    const [command, key] = path;
    switch (command) {
      case "new-terminal": {
        const local: Entry = {
          id: "computers:new-terminal:local",
          title: "This machine",
          breadcrumb: "Computers › New terminal › Local",
          searchText: `local this machine ${hostOs} shell terminal`,
          scope: "computers",
          icon: Monitor,
          awaitResult: true,
          dismissImmediatelyOnSuccess: true,
          run: () => newTerminal(),
        };
        const remote = hasDesktopBridge
          ? library.devservers
              .filter((devserver) => devserver.status === "connected")
              .map(
                (devserver): Entry => ({
                  id: `computers:new-terminal:${devserver.id}`,
                  title: devserverName(devserver),
                  breadcrumb: "Computers › New terminal › Remote",
                  searchText: `${devserverName(devserver)} ${devserver.host} ${devserver.port} ${devserver.os} terminal`,
                  scope: "computers",
                  icon: Server,
                  awaitResult: true,
                  dismissImmediatelyOnSuccess: true,
                  run: () => newTerminal(devserver),
                }),
              )
          : [];
        return [local, ...remote];
      }
      case "new-window":
        return library.workspaces
          .filter(
            (workspace) =>
              workspace.status === "running" &&
              !workspacePending(workspace) &&
              canOpenWorkspaceWindow(workspace),
          )
          .map((workspace) => workspaceTarget(command, workspace));
      case "windows": {
        if (key === undefined) return orderedWindows.map(windowBranch);
        const window = orderedWindows.find((candidate) => windowKey(candidate) === key);
        if (!window) return [];
        return windowActions(window).map((action) => windowEntry(action, window));
      }
      case "connect":
        return library.devservers
          .filter((devserver) => {
            const controlOpen =
              !!devserver.library_id &&
              library.windows.some(
                (window) => window.control && window.library_id === devserver.library_id,
              );
            return devserver.status === "disconnected" && !controlOpen && !isPending(dsKey(devserver.id));
          })
          .map(
            (devserver): Entry => ({
              id: `computers:connect:${devserver.id}`,
              title: devserverName(devserver),
              breadcrumb: "Computers › Connect",
              searchText: `${devserverName(devserver)} ${devserver.host} ${devserver.port} connect reconnect`,
              scope: "computers",
              icon: Plug,
              awaitResult: true,
              dismissImmediatelyOnSuccess: true,
              run: () => connectComputer(devserver),
            }),
          );
      case "disconnect":
        return library.devservers
          .filter(
            (devserver) =>
              (devserver.status === "connected" || devserver.status === "unreachable") &&
              !isPending(dsKey(devserver.id)),
          )
          .map(
            (devserver): Entry => ({
              id: `computers:disconnect:${devserver.id}`,
              title: devserverName(devserver),
              breadcrumb: "Computers › Disconnect",
              searchText: `${devserverName(devserver)} ${devserver.host} ${devserver.port} disconnect`,
              scope: "computers",
              icon: Unplug,
              awaitResult: true,
              confirm: {
                title: `Disconnect ${devserverName(devserver)}?`,
                message: "Its Chan windows will close locally. The remote computer keeps running.",
                actionLabel: "Disconnect",
                danger: true,
              },
              run: () => disconnectDevserver(devserver.id),
            }),
          );
      case "turn-on":
        return library.workspaces
          .filter(
            (workspace) =>
              !workspace.on && workspace.status !== "locked" && !workspacePending(workspace),
          )
          .map((workspace) => workspaceTarget(command, workspace));
      case "turn-off":
        return library.workspaces
          .filter(
            (workspace) =>
              workspace.on && workspace.status !== "locked" && !workspacePending(workspace),
          )
          .map((workspace) => workspaceTarget(command, workspace));
      default:
        return [];
    }
  }

  function commandEntry(
    id: CommandId,
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

  const rootEntries = $derived.by<Entry[]>(() => {
    const entries: Entry[] = [
      commandEntry("new-terminal", "New terminal", "Choose a computer", SquareTerminal, "shell"),
      ...(localFilesApp && selfManagedWindows
        ? [
            {
              id: "computers:new-files:local",
              title: "New files window",
              breadcrumb: "Computers › New files window",
              searchText: "files browser editor local this machine",
              scope: "computers" as const,
              icon: Folder,
              awaitResult: true,
              dismissImmediatelyOnSuccess: true,
              run: () => newFilesWindow(),
            } satisfies Entry,
          ]
        : []),
      commandEntry("new-window", "New window", "Choose a workspace", AppWindow, "workspace"),
      // One target-first branch instead of a Focus/Hide/Show/Close quartet
      // that listed the same roster four times over.
      commandEntry(
        "windows",
        "Windows",
        "Choose a window",
        Layers3,
        "focus show hide close activate foreground open bury unhide remove quit control terminal",
      ),
    ];
    if (hasDesktopBridge) {
      const degraded = library.devservers.some(
        (devserver) => devserver.status === "unreachable" || devserver.status === "disconnected",
      );
      const connection = [
        commandEntry("connect", "Reconnect", "Choose a devserver", Plug, "connect connection"),
        commandEntry("disconnect", "Disconnect", "Choose a devserver", Unplug),
      ];
      // A degraded connection leads; otherwise the pair sits after the spawn
      // and window branches, which is index 3 now that the four window verbs
      // have collapsed into one.
      entries.splice(degraded ? 0 : 3, 0, ...connection);
    }
    entries.push(
      commandEntry("turn-on", "Turn on", "Choose a workspace", Power, "start"),
      commandEntry("turn-off", "Turn off", "Choose a workspace", Power, "stop"),
    );
    if (hasDesktopBridge) {
      entries.push(
        {
          id: "computers:theme",
          title: themeState.theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
          breadcrumb: "Computers › Chan Desktop",
          searchText: "theme appearance light dark switch toggle",
          scope: "computers",
          icon: themeState.theme === "dark" ? Sun : Moon,
          run: toggleTheme,
        },
        {
          id: "computers:quit",
          title: "Quit",
          breadcrumb: "Computers › Chan Desktop",
          searchText: "quit exit app desktop",
          scope: "computers",
          icon: LogOut,
          awaitResult: false,
          confirm: {
            title: "Quit Chan Desktop?",
            message: "Local workspaces and terminal sessions will stop.",
            actionLabel: "Quit",
            danger: true,
          },
          run: requestDesktopQuit,
        },
        {
          id: "computers:new-devserver",
          title: "New devserver",
          breadcrumb: "Computers › Add a computer",
          searchText: "new add devserver computer server",
          scope: "computers",
          icon: Plus,
          run: () => openNewDialog("devserver"),
        },
      );
    }
    return entries;
  });

  const deepEntries = $derived.by<Entry[]>(() => {
    const leaves = ([
      "new-terminal",
      "new-window",
      "windows",
      "connect",
      "disconnect",
      "turn-on",
      "turn-off",
    ] as const).flatMap((command) => targetEntries([command]));
    // Keep the branches in typed search as well as their leaves. This lets a
    // terse verb such as `close` jump into that submenu, while a compound
    // query such as `close release checks` can address the final target. The
    // window rows are branches now, so their actions have to be flattened too
    // or a verb query would only ever descend.
    const windowLeaves = orderedWindows.flatMap((window) =>
      windowActions(window).map((action) => windowEntry(action, window)),
    );
    return [...rootEntries, ...leaves, ...windowLeaves];
  });

  const computerEntries = $derived(
    draft.path.length ? targetEntries(draft.path) : draft.query.trim() ? deepEntries : rootEntries,
  );
  // This deck is always inside the Computers scope, so it never shows the
  // teaser form: truncating the root to five rows hid `Close`, the sixth
  // owner entry. The deck body scrolls and follows the selection.
  const visibleEntries = $derived(rankDeckItems(computerEntries, draft.query) as Entry[]);
  const modeTitle = $derived.by(() => {
    if (!mode) return "Computers";
    if (windowMode) {
      const window = orderedWindows.find((candidate) => windowKey(candidate) === windowMode);
      if (window) return windowRowLabel(window);
    }
    return rootEntries.find((entry) => entry.next?.[0] === mode)?.title ?? "Computers";
  });
  const placeholder = $derived(
    draft.scope ? scopes.find((scope) => scope.id === draft.scope)?.label ?? modeTitle : modeTitle,
  );

  $effect(() => {
    JSON.stringify(draft);
    persistCommandLauncherDraft();
  });

  // The window feed is pushed, so a window can close from anywhere while its
  // own actions are on screen. Fall back to the list rather than leaving an
  // empty body behind.
  $effect(() => {
    if (!draft.visible || !windowMode) return;
    if (orderedWindows.some((window) => windowKey(window) === windowMode)) return;
    direction = "back";
    draft.path = ["windows"];
    draft.selectedId = null;
    draft.operation = null;
  });

  function closeDeck(): void {
    closeCommandLauncher();
  }

  function clearDeck(): void {
    clearCommandLauncherDraft();
  }

  function back(): void {
    if (draft.operation) {
      draft.operation = null;
    } else if (draft.path.length) {
      direction = "back";
      draft.path = draft.path.slice(0, -1);
    } else if (draft.scope) {
      draft.scope = null;
    } else {
      draft.selectedId = null;
    }
  }

  async function choose(item: DeckItem): Promise<void> {
    const entry = visibleEntries.find((candidate) => candidate.id === item.id);
    if (!entry) throw new Error("That command is no longer available");
    if (entry.next) {
      direction = "forward";
      draft.path = entry.next;
      draft.selectedId = null;
      return;
    }
    clearError();
    await entry.run?.();
    if (!entry.awaitResult) {
      closeDeck();
      clearDeck();
    }
  }

  function succeeded(): void {
    closeDeck();
    clearDeck();
  }

  function onScope(scope: DeckScopeId): void {
    direction = "still";
    draft.scope = scope;
    draft.path = [];
    draft.selectedId = null;
  }

  function clearScope(): void {
    direction = "back";
    draft.scope = null;
    draft.path = [];
    draft.selectedId = null;
  }

  function onWindowKey(event: KeyboardEvent): void {
    const macDesktop = hasDesktopBridge && hostOs === "macos";
    const contextual =
      event.code === "KeyK" &&
      (macDesktop
        ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
        : event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey);
    const computers =
      hasDesktopBridge &&
      event.code === "KeyK" &&
      (hostOs === "macos"
        ? event.metaKey && !event.ctrlKey && !event.altKey && event.shiftKey
        : event.ctrlKey && event.altKey && !event.metaKey && event.shiftKey);
    if ((contextual || computers) && !readOnly && screen.current === "computers") {
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleCommandLauncher(computers ? "computers" : "contextual");
    }
  }
</script>

<svelte:window onkeydown={onWindowKey} />

<CommandDeck
  open={draft.visible}
  bind:draft={commandLauncher.drafts[commandLauncher.entryMode]}
  items={visibleEntries}
  {scopes}
  {placeholder}
  bodyKey={`${draft.path.join("/")}:${draft.scope ?? "all"}`}
  {direction}
  onClose={closeDeck}
  onChoose={choose}
  onBack={back}
  {onScope}
  onClearScope={clearScope}
  onSuccess={succeeded}
/>
