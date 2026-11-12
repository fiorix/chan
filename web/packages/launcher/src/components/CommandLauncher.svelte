<script lang="ts">
  import { untrack } from "svelte";
  import { privateText } from "@chan/web-shared/privacy";
  import { shortcutLetter } from "@chan/web-shared/keyboard";
  // The Computers screen's host of the shared command deck. The shared
  // component owns interaction and motion and the shared Computers tree owns
  // the rows, their words and their confirmations; this adapter states the
  // library as that tree's model, says what this surface may do, and carries
  // each action out through the wrappers the cards call.
  import CommandDeck from "@chan/web-shared/CommandDeck.svelte";
  import {
    rankDeckItems,
    type DeckConfirm,
    type DeckItem,
    type DeckScopeId,
  } from "@chan/web-shared/command-deck";
  import {
    computersConfirmBridge,
    computersDeck,
    computersFilter,
    computersScopes,
    createComputersConfirmations,
    type ComputersBridge,
    type ComputersCommand,
    type ComputersContext,
    type ComputersEntry,
    type ComputersGateway,
    type ComputersMachine,
    type ComputersModel,
    type ComputersWindow,
    type ComputersWorkspace,
    type WindowActionId,
  } from "@chan/web-shared/computers-deck";
  import {
    AppWindow,
    ArrowRightLeft,
    Columns3,
    Copy,
    ExternalLink,
    Eye,
    EyeOff,
    Focus,
    Folder,
    Layers,
    LogOut,
    Monitor,
    MonitorCog,
    Moon,
    PanelsTopLeft,
    Pencil,
    Plug,
    Plus,
    Power,
    Server,
    ShieldOff,
    SquareCheckBig,
    SquareTerminal,
    Sun,
    Unplug,
    X,
  } from "@lucide/svelte";
  import { workspaceCondition } from "../api/library";
  import type {
    DevserverEntry,
    GatewayEntry,
    TmuxWindowEntry,
    WindowRecord,
    WorkspaceEntry,
  } from "../api/library";
  import { isLauncherHost, requestDesktopQuit } from "../api/desktop";
  import { LOCAL_LIBRARY_ID, rootName, windowRowLabel } from "../lib/windowLabel";
  import {
    buildMachineTree,
    devserverForLibrary,
    tmuxWindowMachine,
    type MachineNode,
  } from "../lib/machineTree";
  import {
    library,
    clearError,
    reportError,
    connectGateway,
    disconnectDevserver,
    disconnectGateway,
    revokeDevserverNativeTrust,
  } from "../state/library.svelte";
  import {
    canManageWindow,
    canOpenWorkspaceWindow,
    closeComputerWindow,
    connectAndOpenTerminal,
    connectComputer,
    copyGatewayPublicKey,
    detachTmux,
    focusComputerWindow,
    liveTerminalCountForWindow,
    liveTerminalCountForWorkspace,
    newTerminal,
    newTmuxWindow,
    newWorkspaceTerminalWindow,
    newWorkspaceWindow,
    openComputerWindow,
    openTmuxWindow,
    setWindowShown,
    setWorkspacePower,
    showComputerCard,
    turnOffWorkspace,
    turnOnAndOpenWorkspace,
  } from "../state/computerActions";
  import {
    activeCommandLauncherDraft,
    clearCommandLauncherDraft,
    closeCommandLauncher,
    commandLauncher,
    noteRecentWindow,
    persistCommandLauncherDraft,
    recentWindows,
    toggleCommandLauncher,
  } from "../state/commandLauncher.svelte";
  import { clearControlAttention, hasControlAttention } from "../state/controlAttention.svelte";
  import { demoState } from "../state/demo.svelte";
  import { openEditDevserver, openEditGateway, openNewDialog } from "../state/dialog.svelte";
  import { hasDesktopBridge, hostOs, readOnly } from "../state/capabilities";
  import { dsKey, isPending, servedKey, wsKey } from "../state/pending.svelte";
  import { selection, toggleSelectMode } from "../state/selection.svelte";
  import { themeState, toggleTheme } from "../state/theme.svelte";
  import { hasWindowAttention } from "../state/windowAttention.svelte";

  let direction: "forward" | "back" | "still" = $state("still");
  const draft = $derived(activeCommandLauncherDraft());
  const machineTree = $derived(buildMachineTree(
    library.devservers,
    library.workspaces,
    library.windows,
    library.tmuxConnections,
  ));
  const localLibraryId = $derived(machineTree.machines[0]?.libraryId ?? LOCAL_LIBRARY_ID);

  // A window key is library-qualified: window ids are unique only within the
  // library that minted them, and this deck aggregates several.
  function windowKey(window: WindowRecord): string {
    return `${window.library_id}:${window.window_id}`;
  }

  function workspaceKey(workspace: WorkspaceEntry): string {
    return `${workspace.devserver_id ?? "local"}:${workspace.workspace_id}`;
  }

  function workspaceName(workspace: WorkspaceEntry): string {
    return privateText(workspace.label || rootName(workspace.path) || workspace.path, "Workspace");
  }

  function devserverName(devserver: DevserverEntry): string {
    return privateText(devserver.label || `${devserver.host}:${devserver.port}`, "Computer");
  }

  function hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  function gatewayName(gateway: GatewayEntry): string {
    return gateway.label || hostOf(gateway.url);
  }

  // A roster row's own gateway URL stands in while its gateway is between
  // registry refreshes.
  function owningGatewayName(devserver: DevserverEntry): string {
    const gateway = library.gateways.find((row) => row.id === devserver.gateway_id);
    return gateway ? gatewayName(gateway) : hostOf(devserver.gateway_url);
  }

  function machineNameForLibrary(libraryId: string): string {
    const devserver = devserverForLibrary(libraryId, library.devservers, localLibraryId);
    return devserver ? devserverName(devserver) : "This machine";
  }

  // A workspace is named by the card that holds its library's windows, so a
  // box registered twice names one machine on the workspace and its windows.
  function machineNameForWorkspace(workspace: WorkspaceEntry): string {
    if (!workspace.devserver_id) return "This machine";
    const devserver = library.devservers.find((row) => row.id === workspace.devserver_id);
    if (!devserver) return privateText(workspace.devserver_id, "Computer");
    return devserver.library_id
      ? machineNameForLibrary(devserver.library_id)
      : devserverName(devserver);
  }

  function workspaceForWindow(window: WindowRecord): WorkspaceEntry | undefined {
    if (!window.workspace_path) return undefined;
    return library.workspaces.find(
      (workspace) =>
        workspace.path === window.workspace_path &&
        (workspace.library_id ?? LOCAL_LIBRARY_ID) === window.library_id,
    );
  }

  function workspaceNameForWindow(window: WindowRecord): string {
    const workspace = workspaceForWindow(window);
    if (workspace) return workspaceName(workspace);
    return privateText(rootName(window.workspace_path ?? ""), "Workspace") || "Workspace";
  }

  /// Only a browser-origin row has a browser popup that Focus may address.
  /// Native and unknown rows offer visibility and explicit browser Open.
  function windowActions(window: WindowRecord): WindowActionId[] {
    if (!canManageWindow(window)) return [];
    if (!hasDesktopBridge && window.origin !== "browser") {
      return window.hidden ? ["show", "open", "close"] : ["open", "hide", "close"];
    }
    return window.hidden ? ["focus", "show", "close"] : ["focus", "hide", "close"];
  }

  function windowAttention(window: WindowRecord): string | undefined {
    if (window.control && hasControlAttention(window.library_id)) return "Control terminal needs attention";
    if (hasWindowAttention(window.window_id)) return "Not open here";
    return undefined;
  }

  // The records behind the model's keys. The tree hands a key back with each
  // action, and the wrappers take the record.
  interface Records {
    windows: Map<string, WindowRecord>;
    /** A tmux window with no chan window yet: its row's one action asks the
     * connection to open it. */
    unopened: Map<string, { connection: string; window: TmuxWindowEntry }>;
    workspaces: Map<string, { workspace: WorkspaceEntry; windows: WindowRecord[] }>;
    devservers: Map<string, DevserverEntry>;
    tmux: Map<string, string>;
    gateways: Map<string, GatewayEntry>;
  }

  const current = $derived.by<{ model: ComputersModel; records: Records }>(() => {
    const records: Records = {
      windows: new Map(),
      unopened: new Map(),
      workspaces: new Map(),
      devservers: new Map(),
      tmux: new Map(),
      gateways: new Map(),
    };

    function windowModel(window: WindowRecord): ComputersWindow {
      const key = windowKey(window);
      records.windows.set(key, window);
      return {
        key,
        name: privateText(windowRowLabel(window), "Window"),
        kind: window.kind,
        context: window.kind === "workspace" ? workspaceNameForWindow(window) : undefined,
        search: [window.label ?? "", window.title, window.workspace_path ?? "", window.kind].join(" "),
        hidden: !!window.hidden,
        control: window.control === true,
        current: isLauncherHost(window),
        attention: windowAttention(window),
        actions: windowActions(window),
        blocked: canManageWindow(window)
          ? undefined
          : "Only the tenant leader can show or hide this window",
      };
    }

    function unopenedModel(connection: string, window: TmuxWindowEntry): ComputersWindow {
      const key = `tmux:${connection}:${window.id}`;
      records.unopened.set(key, { connection, window });
      return {
        key,
        name: privateText(window.name || window.id, "Window"),
        kind: "terminal",
        context: `${window.id}, ${window.panes} pane${window.panes === 1 ? "" : "s"}`,
        search: `${window.name} tmux`,
        hidden: true,
        actions: ["show"],
      };
    }

    function workspaceModel(workspace: WorkspaceEntry, windows: WindowRecord[], machine: string): ComputersWorkspace {
      const key = workspaceKey(workspace);
      records.workspaces.set(key, { workspace, windows });
      const named = machineNameForWorkspace(workspace);
      return {
        key,
        name: workspaceName(workspace),
        search: `${workspace.label} ${workspace.path}`,
        on: workspace.on,
        condition: workspaceCondition(workspace.status),
        busy: isPending(
          workspace.devserver_id
            ? servedKey(workspace.devserver_id, workspace.prefix)
            : wsKey(workspace.workspace_id),
        ),
        leaderHeld: !canOpenWorkspaceWindow(workspace),
        reason: workspace.error ? privateText(workspace.error, "Workspace unavailable") : undefined,
        machine: named === machine ? undefined : named,
        windows: windows.map(windowModel),
      };
    }

    function machineModel(node: MachineNode): ComputersMachine {
      const loose = [...node.control, ...node.terminals, ...node.looseWindows];
      if (node.kind === "tmux") {
        const connection = node.connection!;
        const key = `tmux:${connection}`;
        records.tmux.set(key, connection);
        return {
          key,
          kind: "tmux",
          name: privateText(tmuxWindowMachine(node.tmux, node.tmuxHost), "tmux computer"),
          detail: node.tmux ? `tmux ${node.tmux.version}` : undefined,
          search: "tmux",
          attached: node.tmux !== null,
          workspaces: [],
          windows: [
            ...loose.map(windowModel),
            ...node.unopened.map((window) => unopenedModel(connection, window)),
          ],
        };
      }
      const devserver = node.devserver;
      if (!devserver) {
        return {
          key: "local",
          kind: "local",
          name: "This machine",
          search: `local ${hostOs}`,
          workspaces: node.workspaces.map((row) => workspaceModel(row.ws, row.windows, "This machine")),
          windows: loose.map(windowModel),
        };
      }
      records.devservers.set(devserver.id, devserver);
      const name = devserverName(devserver);
      const address = devserver.gateway_id
        ? `via ${owningGatewayName(devserver)}`
        : devserver.url || `${devserver.host}:${devserver.port}`;
      return {
        key: devserver.id,
        kind: "devserver",
        name,
        detail: privateText(address, "") || undefined,
        search: `${devserver.label} ${devserver.host} ${devserver.port} ${devserver.os}`,
        connection: devserver.status,
        lost:
          devserver.status === "unreachable" ||
          (!!devserver.library_id && hasControlAttention(devserver.library_id)),
        busy: devserver.status === "connecting" || isPending(dsKey(devserver.id)),
        // The connect refuses until the control terminal its dead script left
        // behind is closed.
        controlOpen:
          !!devserver.library_id &&
          library.windows.some((window) => window.control && window.library_id === devserver.library_id),
        signIn: devserver.pending_signin,
        trustRequired: devserver.native_trust_required,
        // A gateway's roster row is managed on the Gateways screen.
        editable: !devserver.gateway_id,
        revocable: hasDesktopBridge && !!devserver.gateway_id && devserver.shared && !devserver.native_trust_required,
        workspaces: node.workspaces.map((row) => workspaceModel(row.ws, row.windows, name)),
        windows: loose.map(windowModel),
      };
    }

    const gateways = hasDesktopBridge
      ? [...library.gateways]
          .sort((a, b) => gatewayName(a).localeCompare(gatewayName(b)))
          .map((gateway): ComputersGateway => {
            records.gateways.set(gateway.id, gateway);
            return {
              key: gateway.id,
              name: privateText(gatewayName(gateway), "Gateway"),
              detail: privateText(gateway.url, "") || undefined,
              search: `${gateway.label} ${gateway.url}`,
              connection: gateway.status,
              publicKey: !!gateway.wireguard_public_key,
            };
          })
      : [];

    const model: ComputersModel = {
      machines: machineTree.machines.map(machineModel),
      unplaced: machineTree.orphans.map(windowModel),
      gateways,
      recent: recentWindows.keys,
      // What this surface offers. The devserver page has no bridge to dial a
      // devserver or a gateway through, and the demo's hero keeps its New
      // workspace button for resetting the demo.
      may: {
        terminal: true,
        remoteTerminal: hasDesktopBridge,
        window: true,
        terminalWindow: true,
        power: true,
        connect: hasDesktopBridge,
        tmux: true,
        newWorkspace: !demoState.reset,
        addDevserver: hasDesktopBridge,
        gateways: hasDesktopBridge,
        addGateway: hasDesktopBridge,
        renameGateway: hasDesktopBridge,
        showCard: hasDesktopBridge,
      },
      desktop: hasDesktopBridge
        ? { theme: themeState.theme, selecting: selection.selectMode }
        : undefined,
    };
    return { model, records };
  });

  function gone(what: string): Error {
    return new Error(`That ${what} is no longer available`);
  }

  // A window this deck asked for arrives through the feed. One that does so
  // inside this bound is the deck's own and joins its recent windows.
  const ARRIVAL_MS = 10_000;
  let awaitingWindowUntil = 0;
  function expectWindow(): void {
    awaitingWindowUntil = Date.now() + ARRIVAL_MS;
  }

  async function runWindow(key: string, action: WindowActionId): Promise<void> {
    const unopened = current.records.unopened.get(key);
    if (unopened) {
      expectWindow();
      await openTmuxWindow(unopened.connection, unopened.window);
      return;
    }
    const window = current.records.windows.get(key);
    if (!window) throw gone("window");
    if (action === "close") {
      await closeComputerWindow(window);
      return;
    }
    if (action === "focus") await focusComputerWindow(window);
    else if (action === "open") await openComputerWindow(window);
    else await setWindowShown(window, action === "show");
    // Acting on a control terminal acknowledges its attention, as its row's
    // buttons do.
    if (window.control) clearControlAttention(window.library_id);
    if (action !== "hide") noteRecentWindow(key);
  }

  async function runCommand(command: ComputersCommand): Promise<void> {
    const { records } = current;
    switch (command.target) {
      case "window":
        return runWindow(command.key, command.action);
      case "workspace": {
        const workspace = records.workspaces.get(command.key)?.workspace;
        if (!workspace) throw gone("workspace");
        if (command.action === "turn-on") return setWorkspacePower(workspace, true);
        expectWindow();
        if (command.action === "new-window") return newWorkspaceWindow(workspace);
        if (command.action === "new-terminal-window") return newWorkspaceTerminalWindow(workspace);
        return turnOnAndOpenWorkspace(workspace);
      }
      case "machine": {
        if (command.action === "show-card") return showComputerCard(command.key);
        const connection = records.tmux.get(command.key);
        if (connection !== undefined) {
          if (command.action === "detach") return detachTmux(connection);
          expectWindow();
          return newTmuxWindow(connection);
        }
        if (command.key === "local") {
          expectWindow();
          return newTerminal();
        }
        const devserver = records.devservers.get(command.key);
        if (!devserver) throw gone("computer");
        switch (command.action) {
          case "new-terminal":
            expectWindow();
            return newTerminal(devserver);
          case "connect":
            return connectComputer(devserver);
          case "connect-and-open":
            expectWindow();
            return connectAndOpenTerminal(devserver);
          case "disconnect":
            return disconnectDevserver(devserver.id);
          case "edit-config":
            return openEditDevserver(devserver);
          case "revoke-native-access":
            return revokeDevserverNativeTrust(devserver.id);
          default:
            throw gone("command");
        }
      }
      case "gateway": {
        const gateway = records.gateways.get(command.key);
        if (!gateway) throw gone("gateway");
        if (command.action === "connect") return connectGateway(gateway.id);
        if (command.action === "disconnect") return disconnectGateway(gateway.id);
        if (command.action === "rename") return openEditGateway(gateway);
        return copyGatewayPublicKey(gateway);
      }
      case "app":
        switch (command.action) {
          case "new-workspace":
            return openNewDialog("local");
          case "add-devserver":
            return openNewDialog("devserver");
          case "add-gateway":
            return openNewDialog("gateway");
          case "theme":
            return toggleTheme();
          case "select":
            return toggleSelectMode();
          case "quit":
            return requestDesktopQuit();
        }
    }
  }

  const bridge: ComputersBridge = {
    run: runCommand,
    async liveTerminals(target, key) {
      if (target === "window") {
        const window = current.records.windows.get(key);
        return window ? liveTerminalCountForWindow(window) : null;
      }
      const row = current.records.workspaces.get(key);
      return row ? liveTerminalCountForWorkspace(row.workspace, row.windows) : null;
    },
    async turnOff(key, force) {
      const row = current.records.workspaces.get(key);
      if (!row) throw gone("workspace");
      return turnOffWorkspace(row.workspace, force);
    },
  };

  const context: ComputersContext = {
    bridge,
    // The counts a Close or a Turn off card was painted with live here, for
    // as long as this deck stays mounted.
    confirmations: createComputersConfirmations(computersConfirmBridge(bridge)),
    icons: {
      windows: Layers,
      window: AppWindow,
      terminal: SquareTerminal,
      workspace: Folder,
      computers: MonitorCog,
      local: Monitor,
      devserver: Server,
      tmux: Columns3,
      gateway: ArrowRightLeft,
      focus: Focus,
      show: Eye,
      hide: EyeOff,
      open: ExternalLink,
      close: X,
      power: Power,
      connect: Plug,
      disconnect: Unplug,
      edit: Pencil,
      revoke: ShieldOff,
      card: PanelsTopLeft,
      copy: Copy,
      add: Plus,
      light: Sun,
      dark: Moon,
      select: SquareCheckBig,
      quit: LogOut,
    },
  };

  // The rail is the type filter: this deck lists Computers and nothing else.
  const scopes = $derived(computersScopes(current.model, context.icons));
  const filter = $derived(computersFilter(draft.scope));
  const deck = $derived(
    computersDeck(current.model, { path: draft.path, filter, query: draft.query }, context),
  );
  const visibleEntries = $derived(
    draft.query.trim() ? (rankDeckItems(deck.entries, draft.query) as ComputersEntry[]) : deck.entries,
  );
  const crumbs = $derived.by(() => {
    if (!deck.crumbs.length) return undefined;
    const scope = scopes.find((candidate) => candidate.id === draft.scope);
    return scope ? [scope.label, ...deck.crumbs] : deck.crumbs;
  });

  $effect(() => {
    JSON.stringify(draft);
    persistCommandLauncherDraft();
  });

  // The feed is pushed, so an object can leave from anywhere while its page
  // is on screen. Fall back to the nearest page that still names one rather
  // than leaving an empty body behind. A restored draft waits for the
  // registries it names.
  $effect(() => {
    if (!draft.visible || library.loading) return;
    if (deck.path.length === draft.path.length) return;
    direction = "back";
    draft.path = deck.path;
    draft.selectedId = null;
    draft.operation = null;
  });

  // The cards' counts are per object and this deck stays mounted for the life
  // of the app, so an object that leaves the roster takes its records with it.
  $effect(() => {
    context.confirmations.retain(
      new Set(current.records.windows.keys()),
      new Set(current.records.workspaces.keys()),
    );
  });

  let knownWindows = new Set<string>();
  $effect(() => {
    const keys = library.windows.map(windowKey);
    const arrived = keys.find((key) => !knownWindows.has(key));
    knownWindows = new Set(keys);
    if (arrived === undefined || Date.now() >= awaitingWindowUntil) return;
    awaitingWindowUntil = 0;
    untrack(() => noteRecentWindow(arrived));
  });

  function closeDeck(): void {
    closeCommandLauncher();
  }

  /// A command that ran leaves the deck closed on a fresh draft that keeps
  /// the query that found it, which the next opening selects: Enter then
  /// repeats the command and typing replaces the query.
  function finish(): void {
    const { query } = draft;
    closeDeck();
    clearCommandLauncherDraft();
    activeCommandLauncherDraft().query = query;
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

  /// A page is a list of its own, so the query that found its object does not
  /// follow into it.
  function enter(path: string[]): void {
    direction = "forward";
    draft.path = path;
    draft.query = "";
    draft.selectedId = null;
  }

  async function choose(item: DeckItem): Promise<void | DeckConfirm> {
    const entry = visibleEntries.find((candidate) => candidate.id === item.id);
    if (!entry) throw new Error("That command is no longer available");
    if (entry.next) {
      enter(entry.next);
      return;
    }
    clearError();
    const result = await entry.run?.();
    if (!entry.awaitResult) finish();
    return result;
  }

  function expand(item: DeckItem): void {
    const page = visibleEntries.find((candidate) => candidate.id === item.id)?.page;
    if (page) enter(page);
  }

  function commandFailed(item: DeckItem, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    reportError(new Error(`${item.title}: ${message}`));
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
      shortcutLetter(event) === "K" &&
      (macDesktop
        ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
        : event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey);
    if (contextual && !readOnly) {
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleCommandLauncher();
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
    bind:draft={commandLauncher.draft}
    items={visibleEntries}
    {scopes}
    placeholder={deck.title}
    bodyKey={`${draft.path.join("/")}:${draft.scope ?? "all"}`}
    {direction}
    {crumbs}
    onClose={closeDeck}
    onChoose={choose}
    onExpand={expand}
    onError={commandFailed}
    onBack={back}
    {onScope}
    onClearScope={clearScope}
    onSuccess={finish}
  />

  {#snippet failed(error, reset)}
    {#if draft.visible}
      <div class="deck-failed" role="alert">
        <p class="deck-failed-title">The command deck could not be drawn.</p>
        <p class="deck-failed-detail">
          {privateText(error instanceof Error ? error.message : String(error), "Command failed")}
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
