<script lang="ts">
  // Computers provider for the shared command deck. The shared component owns
  // interaction and motion; this adapter owns only live library targets and the
  // approved actions that operate on them.
  import CommandDeck from "@chan/web-shared/CommandDeck.svelte";
  import {
    rankDeckItems,
    type DeckConfirm,
    type DeckItem,
    type DeckScope,
    type DeckScopeId,
  } from "@chan/web-shared/command-deck";
  import {
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
  import { unactionable, workspaceCondition } from "../api/library";
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
    liveTerminalCountForWindow,
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
    run?: () => void | DeckConfirm | Promise<void | DeckConfirm>;
  }

  let direction: "forward" | "back" | "still" = $state("still");
  const draft = $derived(activeCommandLauncherDraft());
  const mode = $derived((draft.path[0] as CommandId | undefined) ?? null);
  // A window key is library-qualified: window ids are unique only within the
  // library that minted them, and this deck aggregates several.
  const windowMode = $derived(mode === "windows" ? draft.path[1] ?? null : null);
  // The count a Close card was painted with, and the reading that owns that
  // card, both keyed by (entry mode, library, window). A reading that a later
  // one has overtaken keeps its hands off both.
  const confirmedCloseCounts = new Map<string, unknown>();
  const closePreparationVersions = new Map<string, number>();

  function windowKey(window: WindowRecord): string {
    return `${window.library_id}:${window.window_id}`;
  }

  function closeConfirmationKey(window: WindowRecord): string {
    return `${commandLauncher.entryMode}:${windowKey(window)}`;
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

  function closeMessage(count: unknown): string {
    if (typeof count !== "number") return "Open sessions in this window may stop.";
    if (count === 0) return "This window will close.";
    return `${count} terminal session${count === 1 ? "" : "s"} in this window will stop.`;
  }

  function informedCloseConfirmation(window: WindowRecord, count: unknown): DeckConfirm {
    return {
      title: `Close ${windowRowLabel(window)}?`,
      message: closeMessage(count),
      actionLabel: "Close",
      danger: true,
    };
  }

  /// Claim the next reading slot for a window's Close card. Every count read
  /// takes one before it asks, so the reading that answers last is the only one
  /// still entitled to describe the card.
  function nextCloseReading(key: string): number {
    const version = (closePreparationVersions.get(key) ?? 0) + 1;
    closePreparationVersions.set(key, version);
    return version;
  }

  function closeReadingIsCurrent(key: string, version: number): boolean {
    return closePreparationVersions.get(key) === version;
  }

  async function readCloseCount(window: WindowRecord): Promise<unknown> {
    try {
      return await liveTerminalCountForWindow(window);
    } catch {
      return null;
    }
  }

  function closeConfirmation(
    window: WindowRecord,
  ): DeckConfirm | (() => Promise<DeckConfirm>) {
    if (window.control) {
      return {
        ...informedCloseConfirmation(window, null),
        message: "This stops the control terminal and its connection script.",
      };
    }
    return async () => {
      const key = closeConfirmationKey(window);
      const version = nextCloseReading(key);
      const count = await readCloseCount(window);
      if (closeReadingIsCurrent(key, version)) {
        confirmedCloseCounts.set(key, count);
      }
      return informedCloseConfirmation(window, count);
    };
  }

  /// Close reads the count again and stops to confirm a second time when it
  /// moved, so the window goes only on a number the user has just seen. The
  /// reading is slotted like the preparation's: one overtaken by a newer read
  /// describes a card that is no longer on screen, so it asks again rather than
  /// closing on what it found.
  async function closeAfterFreshConfirmation(window: WindowRecord): Promise<void | DeckConfirm> {
    const key = closeConfirmationKey(window);
    const version = nextCloseReading(key);
    const recorded = confirmedCloseCounts.get(key);
    const hadRecorded = confirmedCloseCounts.has(key);
    const fresh = await readCloseCount(window);
    if (!closeReadingIsCurrent(key, version)) {
      return informedCloseConfirmation(window, fresh);
    }
    if (!hadRecorded || fresh !== recorded) {
      confirmedCloseCounts.set(key, fresh);
      return informedCloseConfirmation(window, fresh);
    }
    confirmedCloseCounts.delete(key);
    await closeComputerWindow(window);
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
          ? closeConfirmation(window)
          : undefined,
      run:
        command === "focus"
          ? () => focusComputerWindow(window)
          : command === "hide"
            ? () => setWindowShown(window, false)
            : command === "show"
              ? () => setWindowShown(window, true)
              : window.control
                ? () => closeComputerWindow(window)
                : () => closeAfterFreshConfirmation(window),
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
              workspaceCondition(workspace.status) === "ready" &&
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
              !workspace.on &&
              !unactionable(workspace.status) &&
              !workspacePending(workspace),
          )
          .map((workspace) => workspaceTarget(command, workspace));
      // A degraded mount is on, so it lands here and nowhere else: turning it
      // off is the one action that clears the state.
      case "turn-off":
        return library.workspaces
          .filter(
            (workspace) =>
              workspace.on &&
              !unactionable(workspace.status) &&
              !workspacePending(workspace),
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

  // Close records are per window and this deck stays mounted for the life of
  // the app, so a window that leaves the roster takes its records with it.
  $effect(() => {
    const live = new Set(orderedWindows.map(windowKey));
    const gone = (key: string): boolean => !live.has(key.slice(key.indexOf(":") + 1));
    for (const key of [...confirmedCloseCounts.keys()]) {
      if (gone(key)) confirmedCloseCounts.delete(key);
    }
    for (const key of [...closePreparationVersions.keys()]) {
      if (gone(key)) closePreparationVersions.delete(key);
    }
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

  async function choose(item: DeckItem): Promise<void | DeckConfirm> {
    const entry = visibleEntries.find((candidate) => candidate.id === item.id);
    if (!entry) throw new Error("That command is no longer available");
    if (entry.next) {
      direction = "forward";
      draft.path = entry.next;
      draft.selectedId = null;
      return;
    }
    clearError();
    const result = await entry.run?.();
    if (!entry.awaitResult) {
      closeDeck();
      clearDeck();
    }
    return result;
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

<!-- Without this boundary a render throw inside the deck takes the whole
     command surface down with no way back short of a reload. The boundary
     keeps the failure inside the deck: the launcher behind it stays usable,
     and the deck's place says what happened and offers a retry, which
     re-renders it against whatever the library holds now.

     It catches a throw from rendering the deck, not one raised while this
     component computes the props it passes down. -->
<svelte:boundary>
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

  {#snippet failed(error, reset)}
    {#if draft.visible}
      <div class="deck-failed" role="alert">
        <p class="deck-failed-title">The command deck could not be drawn.</p>
        <p class="deck-failed-detail">
          {error instanceof Error ? error.message : String(error)}
        </p>
        <div class="deck-failed-actions">
          <button onclick={() => reset()}>Try again</button>
          <button onclick={closeDeck}>Close</button>
        </div>
      </div>
    {/if}
  {/snippet}
</svelte:boundary>

<style>
  /* Sits where the deck would be, so a failure reads as the deck's own rather
     than as the launcher having lost it. */
  .deck-failed {
    position: fixed;
    top: 12vh;
    left: 50%;
    transform: translateX(-50%);
    z-index: 60;
    width: min(32rem, calc(100vw - 2rem));
    padding: 1rem 1.15rem;
    border-radius: 10px;
    background: var(--bg-card);
    border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--border));
    color: var(--text);
  }

  .deck-failed-title {
    margin: 0 0 0.35rem;
    font-weight: 600;
  }

  .deck-failed-detail {
    margin: 0 0 0.75rem;
    color: var(--text-secondary);
    font-size: 0.85rem;
    overflow-wrap: anywhere;
  }

  .deck-failed-actions {
    display: flex;
    gap: 0.5rem;
  }
</style>
