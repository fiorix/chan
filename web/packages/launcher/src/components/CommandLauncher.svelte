<script lang="ts">
  // Aggregate Computers provider for the shared inline deck. This SPA already
  // owns the full local plus connected-devserver library, so commands call the
  // same state/backend owners as its machine cards and never cross a webview seam.
  import CommandDeck from "@chan/web-shared/CommandDeck.svelte";
  import {
    rankDeckItems,
    type DeckItem,
    type DeckScope,
    type DeckScopeId,
  } from "@chan/web-shared/command-deck";
  import {
    AppWindow,
    Eye,
    EyeOff,
    Focus,
    Monitor,
    MonitorCog,
    Plug,
    Power,
    Server,
    SquareTerminal,
    Unplug,
  } from "lucide-svelte";
  import type { WindowRecord, WorkspaceEntry } from "../api/library";
  import { basename, LOCAL_LIBRARY_ID, windowRowLabel } from "../lib/windowLabel";
  import { hasDesktopBridge, hostOs, readOnly } from "../state/capabilities";
  import {
    canManageWindow,
    canOpenWorkspaceWindow,
    connectComputer,
    focusComputerWindow,
    newTerminal,
    newWorkspaceWindow,
    setWindowShown,
    setWorkspacePower,
  } from "../state/computerActions";
  import {
    clearCommandLauncherDraft,
    closeCommandLauncher,
    commandLauncher,
    persistCommandLauncherDraft,
    toggleCommandLauncher,
  } from "../state/commandLauncher.svelte";
  import { clearError, disconnectDevserver, library } from "../state/library.svelte";
  import { dsKey, isPending, servedKey, wsKey } from "../state/pending.svelte";
  import { screen } from "../state/screen.svelte";

  type CommandId =
    | "new-terminal"
    | "new-window"
    | "focus"
    | "hide"
    | "show"
    | "connect"
    | "disconnect"
    | "turn-on"
    | "turn-off";

  interface Entry extends DeckItem {
    next?: CommandId;
    run?: () => void | Promise<void>;
  }

  let direction: "forward" | "back" | "still" = $state("still");
  const scopes: DeckScope[] = [{ id: "computers", label: "Computers", icon: MonitorCog }];
  const mode = $derived((commandLauncher.draft.path[0] as CommandId | undefined) ?? null);

  function workspaceName(workspace: WorkspaceEntry): string {
    return workspace.label || basename(workspace.path) || workspace.path;
  }

  function devserverName(devserver: (typeof library.devservers)[number]): string {
    return devserver.label || `${devserver.host}:${devserver.port}`;
  }

  function machineNameForLibrary(libraryId: string): string {
    if (libraryId === LOCAL_LIBRARY_ID) return "This machine";
    const devserver = library.devservers.find((row) => row.library_id === libraryId);
    return devserver ? devserverName(devserver) : libraryId;
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

  function windowEntry(command: "focus" | "hide" | "show", window: WindowRecord): Entry {
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
    const verb = command === "focus" ? "Focus" : command === "hide" ? "Hide" : "Show";
    return {
      id: `computers:${command}:${window.library_id}:${window.window_id}`,
      title: windowRowLabel(window),
      breadcrumb: `Computers › ${verb} › ${context} › ${machine}`,
      searchText: [
        windowRowLabel(window),
        window.title,
        window.workspace_path ?? "",
        context,
        machine,
        window.kind,
        verb,
      ].join(" "),
      scope: "computers",
      icon: command === "focus" ? Focus : command === "hide" ? EyeOff : Eye,
      awaitResult: true,
      dismissImmediatelyOnSuccess: command === "focus",
      run:
        command === "focus"
          ? () => focusComputerWindow(window)
          : () => setWindowShown(window, command === "show"),
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
    const verb =
      command === "new-window" ? "New window" : command === "turn-on" ? "Turn on" : "Turn off";
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
      case "connect":
        return library.devservers
          .filter((devserver) => {
            const controlOpen =
              !!devserver.library_id &&
              library.windows.some(
                (window) => window.control && window.library_id === devserver.library_id,
              );
            return (
              devserver.status === "disconnected" &&
              !controlOpen &&
              !isPending(dsKey(devserver.id))
            );
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

  const rootEntries = $derived.by<Entry[]>(() => {
    const entries: Entry[] = [
      commandEntry("new-terminal", "New terminal", "Choose a computer", SquareTerminal, "shell"),
      commandEntry("new-window", "New window", "Choose a workspace", AppWindow, "workspace"),
      commandEntry("focus", "Focus", "Choose a window", Focus, "activate foreground open"),
      commandEntry("hide", "Hide", "Choose a visible window", EyeOff, "bury"),
      commandEntry("show", "Show", "Choose a hidden window", Eye, "unhide"),
    ];
    if (hasDesktopBridge) {
      entries.splice(
        3,
        0,
        commandEntry("connect", "Reconnect", "Choose a devserver", Plug, "connect connection"),
        commandEntry("disconnect", "Disconnect", "Choose a devserver", Unplug),
      );
    }
    entries.push(
      commandEntry("turn-on", "Turn on", "Choose a workspace", Power, "start"),
      commandEntry("turn-off", "Turn off", "Choose a workspace", Power, "stop"),
    );
    return entries;
  });

  const deepEntries = $derived.by<Entry[]>(() => {
    const leaves = ([
      "new-terminal",
      "new-window",
      "focus",
      "hide",
      "show",
      "connect",
      "disconnect",
      "turn-on",
      "turn-off",
    ] as const).flatMap(targetEntries);
    return [...rootEntries, ...leaves];
  });

  const rawEntries = $derived(
    mode
      ? targetEntries(mode)
      : commandLauncher.draft.query.trim()
        ? deepEntries
        : rootEntries,
  );
  const visibleEntries = $derived(
    rankDeckItems(rawEntries, commandLauncher.draft.query).slice(
      0,
      commandLauncher.draft.query.trim() ? 9 : 5,
    ) as Entry[],
  );
  const placeholder = $derived(
    mode ? rootEntries.find((entry) => entry.next === mode)?.title ?? "Computers" : "Computers",
  );

  $effect(() => {
    JSON.stringify(commandLauncher.draft);
    persistCommandLauncherDraft();
  });

  function back(): void {
    if (commandLauncher.draft.operation) {
      commandLauncher.draft.operation = null;
    } else if (commandLauncher.draft.path.length) {
      direction = "back";
      commandLauncher.draft.path = commandLauncher.draft.path.slice(0, -1);
    } else {
      commandLauncher.draft.selectedId = null;
    }
  }

  async function choose(item: DeckItem): Promise<void> {
    const entry = visibleEntries.find((candidate) => candidate.id === item.id);
    if (!entry) throw new Error("That command is no longer available");
    if (entry.next) {
      direction = "forward";
      commandLauncher.draft.path = [entry.next];
      commandLauncher.draft.selectedId = null;
      return;
    }
    clearError();
    await entry.run?.();
    if (!entry.awaitResult) {
      closeCommandLauncher();
      clearCommandLauncherDraft();
    }
  }

  function succeeded(): void {
    closeCommandLauncher();
    clearCommandLauncherDraft();
  }

  function onScope(scope: DeckScopeId): void {
    direction = "still";
    commandLauncher.draft.scope = scope;
    commandLauncher.draft.path = [];
    commandLauncher.draft.selectedId = null;
  }

  function clearScope(): void {
    direction = "back";
    commandLauncher.draft.scope = "computers";
    commandLauncher.draft.path = [];
    commandLauncher.draft.selectedId = null;
  }

  function onWindowKey(event: KeyboardEvent): void {
    const macDesktop = hasDesktopBridge && hostOs === "macos";
    const matches =
      event.code === "KeyK" &&
      (macDesktop
        ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
        : event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey);
    if (!matches || readOnly || screen.current !== "computers") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    toggleCommandLauncher();
  }
</script>

<svelte:window onkeydown={onWindowKey} />

<CommandDeck
  open={commandLauncher.draft.visible}
  bind:draft={commandLauncher.draft}
  items={visibleEntries}
  {scopes}
  {placeholder}
  bodyKey={mode ?? "root"}
  {direction}
  onClose={closeCommandLauncher}
  onChoose={choose}
  onBack={back}
  {onScope}
  onClearScope={clearScope}
  onSuccess={succeeded}
/>
