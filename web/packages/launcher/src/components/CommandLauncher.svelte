<script lang="ts">
  // Computers provider for the shared command deck. The shared component owns
  // interaction and motion; this adapter owns only live library targets and the
  // approved actions that operate on them.
  import { onMount } from "svelte";
  import CommandDeck from "@chan/web-shared/CommandDeck.svelte";
  import {
    createDeckDraft,
    fuzzyDeckScore,
    parseDeckDraft,
    rankDeckItems,
    type DeckItem,
    type DeckScope,
    type DeckScopeId,
  } from "@chan/web-shared/command-deck";
  import {
    AppWindow,
    Command,
    Eye,
    EyeOff,
    Focus,
    Layers3,
    LogOut,
    Monitor,
    MonitorCog,
    PanelTop,
    PanelsTopLeft,
    Plug,
    Plus,
    Power,
    Server,
    SquareTerminal,
    Unplug,
    X,
  } from "lucide-svelte";
  import type { DevserverEntry, WindowRecord, WorkspaceEntry } from "../api/library";
  import {
    executeNativeCommandLauncherItem,
    hideNativeCommandLauncher,
    nativeCommandLauncherSnapshot,
    onTauriEvent,
    openNativeCommandLauncher,
    saveNativeCommandLauncherDraft,
    type NativeLauncherCommandDescriptor,
    type NativeLauncherContext,
    type NativeLauncherSnapshot,
    requestDesktopQuit,
  } from "../api/desktop";
  import { basename, LOCAL_LIBRARY_ID, windowRowLabel } from "../lib/windowLabel";
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
  import { hasDesktopBridge, hostOs, readOnly } from "../state/capabilities";
  import { dsKey, isPending, servedKey, wsKey } from "../state/pending.svelte";
  import { screen } from "../state/screen.svelte";

  type CommandId =
    | "new-terminal"
    | "new-window"
    | "focus"
    | "hide"
    | "show"
    | "close"
    | "connect"
    | "disconnect"
    | "turn-on"
    | "turn-off";

  interface Entry extends DeckItem {
    next?: CommandId;
    run?: () => void | Promise<void>;
    sourceCommandId?: string;
    arg?: string;
  }

  let { nativeOverlay = false }: { nativeOverlay?: boolean } = $props();

  let direction: "forward" | "back" | "still" = $state("still");
  let nativeContext: NativeLauncherContext | null = $state(null);
  let nativeSourceAlive = $state(true);
  let nativeRevision = 0;
  let nativeReady = $state(false);
  let lastNativeDraft = "";
  const draft = $derived(activeCommandLauncherDraft());
  const mode = $derived((draft.path[0] as CommandId | undefined) ?? null);

  const scopes = $derived.by<DeckScope[]>(() => {
    const available = new Set(nativeContext?.commands.map((command) => command.scope) ?? []);
    return [
      { id: "tab", label: "Tab", icon: PanelTop, available: nativeOverlay && available.has("tab") },
      { id: "pane", label: "Pane", icon: PanelsTopLeft, available: nativeOverlay && available.has("pane") },
      { id: "window", label: "Window", icon: Layers3, available: nativeOverlay && available.has("window") },
      { id: "computers", label: "Computers", icon: MonitorCog },
    ];
  });

  function applyNativeTheme(context: NativeLauncherContext | null): void {
    if (!context) return;
    document.documentElement.setAttribute("data-theme", context.theme);
    if (context.accent) {
      document.documentElement.style.setProperty("--pane-highlight-color", context.accent);
      document.documentElement.style.setProperty("--deck-accent", context.accent);
    } else {
      document.documentElement.style.removeProperty("--pane-highlight-color");
      document.documentElement.style.removeProperty("--deck-accent");
    }
  }

  function applyNativeSnapshot(snapshot: NativeLauncherSnapshot): void {
    nativeContext = snapshot.context;
    nativeSourceAlive = snapshot.sourceAlive;
    applyNativeTheme(snapshot.context);
    if (snapshot.draftRevision >= nativeRevision) {
      const parsed = parseDeckDraft(snapshot.draft, createDeckDraft(snapshot.entryMode));
      commandLauncher.entryMode = snapshot.entryMode;
      commandLauncher.drafts[snapshot.entryMode] = parsed;
      nativeRevision = snapshot.draftRevision;
      lastNativeDraft = JSON.stringify(parsed);
    }
    nativeReady = true;
  }

  onMount(() => {
    if (!nativeOverlay) return;
    let unlisten: (() => void) | null = null;
    void onTauriEvent<NativeLauncherSnapshot>(
      "command-launcher-updated",
      applyNativeSnapshot,
    ).then((stop) => {
      unlisten = stop;
    });
    void nativeCommandLauncherSnapshot().then(applyNativeSnapshot);
    return () => unlisten?.();
  });

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

  function windowEntry(
    command: "focus" | "hide" | "show" | "close",
    window: WindowRecord,
  ): Entry {
    const machine = machineNameForLibrary(window.library_id);
    const workspace = workspaceForWindow(window);
    const context =
      window.kind === "workspace"
        ? workspace
          ? workspaceName(workspace)
          : basename(window.workspace_path ?? "") || "Workspace"
        : window.control
          ? "Control terminal"
          : "Terminal";
    const verb = command === "focus" ? "Focus" : command === "hide" ? "Hide" : command === "show" ? "Show" : "Close";
    return {
      id: `computers:${command}:${window.library_id}:${window.window_id}`,
      title: windowRowLabel(window),
      breadcrumb: `Computers › ${verb} › ${context} › ${machine}`,
      searchText: [windowRowLabel(window), window.label ?? "", window.title, window.workspace_path ?? "", context, machine, window.kind, verb].join(" "),
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

  function targetEntries(command: CommandId): Entry[] {
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
      case "focus":
        return library.windows.filter(canManageWindow).map((window) => windowEntry(command, window));
      case "hide":
        return library.windows
          .filter((window) => !window.hidden && canManageWindow(window))
          .map((window) => windowEntry(command, window));
      case "show":
        return library.windows
          .filter((window) => !!window.hidden && canManageWindow(window))
          .map((window) => windowEntry(command, window));
      case "close":
        return library.windows.filter(canManageWindow).map((window) => windowEntry(command, window));
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
      next: id,
    };
  }

  function sourceIcon(command: NativeLauncherCommandDescriptor): Entry["icon"] {
    switch (command.icon) {
      case "terminal":
        return SquareTerminal;
      case "folder":
      case "file":
        return AppWindow;
      case "tabs":
        return PanelTop;
      case "panes":
        return PanelsTopLeft;
      case "settings":
        return MonitorCog;
      default:
        return Command;
    }
  }

  function sourceBreadcrumb(command: NativeLauncherCommandDescriptor): string {
    const scope = command.scope === "tab" ? "Tab" : command.scope === "pane" ? "Pane" : "Window";
    return `${scope} › ${command.category}`;
  }

  function sourceEntry(command: NativeLauncherCommandDescriptor, arg?: string): Entry {
    const itemId = `context:${command.id}${arg === undefined ? "" : ":argument"}`;
    return {
      id: itemId,
      title: arg === undefined ? command.title : `${command.title} ${arg}`,
      breadcrumb: sourceBreadcrumb(command),
      searchText: [command.title, command.category, ...command.keywords, arg ?? ""].join(" "),
      scope: command.scope,
      icon: sourceIcon(command),
      shortcut: command.shortcut,
      confirm: command.confirm,
      awaitResult: true,
      dismissImmediatelyOnSuccess: true,
      disabled: !nativeSourceAlive,
      sourceCommandId: command.id,
      arg,
      run: () => executeNativeCommandLauncherItem(command.id, arg, itemId),
    };
  }

  const sourceEntries = $derived.by<Entry[]>(() => {
    const commands = nativeContext?.commands ?? [];
    const base = commands.map((command) => sourceEntry(command));
    const split = /^(\S+)\s+(.+)$/.exec(draft.query.trim());
    if (!split) return base;
    const head = split[1];
    const arg = split[2];
    const withArguments = commands
      .filter(
        (command) =>
          command.acceptsArg &&
          fuzzyDeckScore(head, `${command.title} ${command.keywords.join(" ")}`) !== null,
      )
      .map((command) => sourceEntry(command, arg));
    return [...withArguments, ...base];
  });

  const rootEntries = $derived.by<Entry[]>(() => {
    const entries: Entry[] = [
      commandEntry("new-terminal", "New terminal", "Choose a computer", SquareTerminal, "shell"),
      commandEntry("new-window", "New window", "Choose a workspace", AppWindow, "workspace"),
      commandEntry("focus", "Focus", "Choose a window", Focus, "activate foreground open control terminal"),
      commandEntry("hide", "Hide", "Choose a visible window", EyeOff, "bury"),
      commandEntry("show", "Show", "Choose a hidden window", Eye, "unhide"),
      commandEntry("close", "Close", "Choose a window", X, "remove quit window"),
    ];
    if (hasDesktopBridge) {
      const degraded = library.devservers.some(
        (devserver) => devserver.status === "unreachable" || devserver.status === "disconnected",
      );
      const connection = [
        commandEntry("connect", "Reconnect", "Choose a devserver", Plug, "connect connection"),
        commandEntry("disconnect", "Disconnect", "Choose a devserver", Unplug),
      ];
      entries.splice(degraded ? 0 : 4, 0, ...connection);
    }
    entries.push(
      commandEntry("turn-on", "Turn on", "Choose a workspace", Power, "start"),
      commandEntry("turn-off", "Turn off", "Choose a workspace", Power, "stop"),
    );
    if (hasDesktopBridge) {
      entries.push(
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
      "focus",
      "hide",
      "show",
      "close",
      "connect",
      "disconnect",
      "turn-on",
      "turn-off",
    ] as const).flatMap(targetEntries);
    // Keep the branches in typed search as well as their leaves. This lets a
    // terse verb such as `close` jump into that submenu, while a compound
    // query such as `close release checks` can address the final target.
    return [...rootEntries, ...leaves];
  });

  const computerEntries = $derived(
    mode ? targetEntries(mode) : draft.query.trim() ? deepEntries : rootEntries,
  );
  const rawEntries = $derived.by<Entry[]>(() => {
    if (!nativeOverlay) return computerEntries;
    if (draft.scope === "computers" || commandLauncher.entryMode === "computers") {
      return computerEntries;
    }
    if (draft.scope) {
      return sourceEntries.filter((entry) => entry.scope === draft.scope);
    }
    if (draft.query.trim()) return [...sourceEntries, ...deepEntries];
    // The source supplies contextual order (focused tab, pane, then window).
    // Computers remains one arrow-key away in the always-visible scope rail.
    return sourceEntries.length ? [...sourceEntries, ...rootEntries] : rootEntries;
  });
  const visibleEntries = $derived(
    rankDeckItems(rawEntries, draft.query).slice(0, draft.query.trim() ? 9 : 5) as Entry[],
  );
  const modeTitle = $derived(
    mode ? rootEntries.find((entry) => entry.next === mode)?.title ?? "Computers" : "Computers",
  );
  const placeholder = $derived(
    draft.scope
      ? scopes.find((scope) => scope.id === draft.scope)?.label ?? modeTitle
      : nativeOverlay && commandLauncher.entryMode === "contextual"
        ? "Search"
        : modeTitle,
  );

  $effect(() => {
    const serialized = JSON.stringify(draft);
    if (nativeOverlay) {
      if (!nativeReady || serialized === lastNativeDraft) return;
      lastNativeDraft = serialized;
      nativeRevision += 1;
      void saveNativeCommandLauncherDraft(nativeRevision, JSON.parse(serialized));
    } else {
      persistCommandLauncherDraft();
    }
  });

  function closeDeck(): void {
    if (nativeOverlay) {
      draft.visible = false;
      void hideNativeCommandLauncher();
    } else {
      closeCommandLauncher();
    }
  }

  function clearDeck(): void {
    if (!nativeOverlay) {
      clearCommandLauncherDraft();
      return;
    }
    const replacement = createDeckDraft(commandLauncher.entryMode);
    replacement.visible = draft.visible;
    commandLauncher.drafts[commandLauncher.entryMode] = replacement;
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
      draft.path = [entry.next];
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
    if (nativeOverlay) return;
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
      if (hasDesktopBridge) {
        void openNativeCommandLauncher(computers ? "computers" : "contextual");
      } else {
        toggleCommandLauncher(computers ? "computers" : "contextual");
      }
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
