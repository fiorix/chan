// The Computers tree of the command deck: machines, their workspaces and
// windows, tmux connections and gateways, as rows a deck host hands to
// CommandDeck. Everything here is a pure function of a neutral model, so the
// Computers screen, which holds the whole library, and a window, which holds
// one machine's snapshot, list the same objects in the same words.
//
// A host adapts its own state to `ComputersModel`, says what it may do in
// `ComputersMay`, and carries actions out through `ComputersBridge`. The tree
// decides which action each object offers, what it is called, why it cannot
// run, and what it asks before it does.
//
// The tree is object-first. Enter on a window runs the first action its host
// offers, Enter on a workspace opens a new window of it, and Enter on a
// machine or a gateway opens its page. Every object has a page of its actions
// and of the objects under it, which Right opens on a row Enter would run.

import type { ComputersConfirmBridge, ComputersConfirmations } from "./computersConfirm";
import type { DeckConfirm, DeckIcon, DeckItem, DeckScope } from "./model";

export {
  createComputersConfirmations,
  type ComputersConfirmations,
} from "./computersConfirm";

// ---- The model -----------------------------------------------------------

export type WindowActionId = "focus" | "show" | "hide" | "open" | "close";

export interface ComputersWindow {
  /** Unique among the model's windows; what the bridge is handed back. */
  key: string;
  name: string;
  kind: "terminal" | "workspace";
  /** What the window shows beyond its name: its workspace. */
  context?: string;
  /** Text a query matches and no row shows, such as a name privacy conceals. */
  search?: string;
  hidden?: boolean;
  /** A control terminal: closing it stops its connection script, whatever
   * runs in it, so its confirmation names no count. */
  control?: boolean;
  /** The window this deck's page sits in. */
  current?: boolean;
  /** Why the window asks for attention, when it does. */
  attention?: string;
  /** The actions this host offers on the window, in its order. Enter runs the
   * first; which of them a host can carry out depends on who owns the
   * window, which each host reads its own way. */
  actions: WindowActionId[];
  /** Why none of them may run, in the card's words. */
  blocked?: string;
}

/** How a workspace's mount reads on a control surface: nothing mounted, an
 * operation in flight, serving, held by another process, mounted over an
 * unusable root, failed, or not known. */
export type ComputersWorkspaceCondition =
  | "idle"
  | "busy"
  | "ready"
  | "foreign"
  | "degraded"
  | "failed"
  | "unknown";

export interface ComputersWorkspace {
  key: string;
  name: string;
  search?: string;
  /** The desired state; `condition` is the observed one. */
  on: boolean;
  condition: ComputersWorkspaceCondition;
  /** An action this page started has not landed yet. */
  busy?: boolean;
  /** Another session's leader manages the workspace's windows. */
  leaderHeld?: boolean;
  /** The host's reason behind a degraded, failed or unknown condition. */
  reason?: string;
  /** The machine named beside the workspace when it is not the one that
   * lists it: two rows of one library name the row that holds its windows. */
  machine?: string;
  windows: ComputersWindow[];
}

export type ComputersConnection = "connected" | "connecting" | "unreachable" | "disconnected";

export interface ComputersMachine {
  key: string;
  kind: "local" | "devserver" | "tmux";
  name: string;
  /** A second line for the machine's own row: its address or its session. */
  detail?: string;
  search?: string;
  /** A devserver's connection. Absent on this machine and on a tmux
   * connection, which exist only while they can be reached. */
  connection?: ComputersConnection;
  /** The connection dropped out from under the machine, whatever its record
   * says: it reads as lost. */
  lost?: boolean;
  /** A connect or disconnect is in flight. */
  busy?: boolean;
  /** A disconnected devserver still owns its control terminal, which refuses
   * a reconnect until it is closed. */
  controlOpen?: boolean;
  /** A connect is waiting on a sign-in outside this page. */
  signIn?: boolean;
  /** Connecting asks for consent first, so nothing can be chained after it. */
  trustRequired?: boolean;
  /** The machine has a config form. */
  editable?: boolean;
  /** The machine holds native access that can be revoked. */
  revocable?: boolean;
  /** A tmux connection whose record has arrived, so it can be asked. */
  attached?: boolean;
  workspaces: ComputersWorkspace[];
  /** The machine's windows outside its workspaces: control terminals,
   * terminals, and windows no workspace row claims. */
  windows: ComputersWindow[];
}

export interface ComputersGateway {
  key: string;
  name: string;
  detail?: string;
  search?: string;
  connection: ComputersConnection;
  /** A WireGuard public key exists to copy. */
  publicKey?: boolean;
}

/** What the host may do. A capability left out is never offered, so a window
 * that may only open windows and terminals states those and nothing else. */
export interface ComputersMay {
  /** A new terminal window on this machine. */
  terminal?: boolean;
  /** A new terminal window on a connected devserver. */
  remoteTerminal?: boolean;
  /** A new window of a workspace. */
  window?: boolean;
  /** A new window of a workspace that starts with a terminal. */
  terminalWindow?: boolean;
  /** Turning a workspace on and off. */
  power?: boolean;
  /** Connecting and disconnecting devservers and gateways. */
  connect?: boolean;
  /** Asking a tmux connection for a window or a detach. */
  tmux?: boolean;
  newWorkspace?: boolean;
  addDevserver?: boolean;
  /** The host holds a gateway registry. */
  gateways?: boolean;
  addGateway?: boolean;
  renameGateway?: boolean;
  /** The host can bring a machine's card to the front of its screen. */
  showCard?: boolean;
}

/** The app that hosts the Computers screen, where one has commands of its
 * own. */
export interface ComputersDesktop {
  theme: "dark" | "light";
  selecting: boolean;
}

export interface ComputersModel {
  machines: ComputersMachine[];
  /** Windows whose machine the host has not placed yet. */
  unplaced?: ComputersWindow[];
  gateways?: ComputersGateway[];
  /** Window keys, most recently used first. */
  recent?: string[];
  may: ComputersMay;
  desktop?: ComputersDesktop;
}

// ---- The bridge ----------------------------------------------------------

export type WorkspaceActionId =
  | "new-window"
  | "new-terminal-window"
  | "turn-on"
  | "turn-on-and-open";

export type MachineActionId =
  | "new-terminal"
  | "new-workspace"
  | "connect"
  | "connect-and-open"
  | "disconnect"
  | "edit-config"
  | "revoke-native-access"
  | "new-tmux-window"
  | "detach"
  | "show-card";

export type GatewayActionId = "connect" | "disconnect" | "rename" | "copy-wireguard-key";

export type AppActionId = "new-workspace" | "add-devserver" | "add-gateway" | "theme" | "select" | "quit";

export type ComputersCommand =
  | { target: "window"; key: string; action: WindowActionId }
  | { target: "workspace"; key: string; action: WorkspaceActionId }
  | { target: "machine"; key: string; action: MachineActionId }
  | { target: "gateway"; key: string; action: GatewayActionId }
  | { target: "app"; action: AppActionId };

/** How the tree reaches the host. A host is handed back only the keys of its
 * own model and only the actions its `ComputersMay` and its windows' action
 * lists allow. */
export interface ComputersBridge {
  /** Carry one action out. A rejection reaches the deck's card in the host's
   * own sentence. */
  run(command: ComputersCommand): void | Promise<void>;
  liveTerminals: ComputersConfirmBridge["liveTerminals"];
  turnOff: ComputersConfirmBridge["turnOff"];
}

/** The confirmation half of a bridge, for `createComputersConfirmations`. */
export function computersConfirmBridge(bridge: ComputersBridge): ComputersConfirmBridge {
  return {
    liveTerminals: (target, key) => bridge.liveTerminals(target, key),
    turnOff: (key, force) => bridge.turnOff(key, force),
    closeWindow: async (key) => {
      await bridge.run({ target: "window", key, action: "close" });
    },
  };
}

// ---- What a host supplies to build rows -----------------------------------

export type ComputersIconName =
  | "windows"
  | "window"
  | "terminal"
  | "workspace"
  | "computers"
  | "local"
  | "devserver"
  | "tmux"
  | "gateway"
  | "focus"
  | "show"
  | "hide"
  | "open"
  | "close"
  | "power"
  | "connect"
  | "disconnect"
  | "edit"
  | "revoke"
  | "card"
  | "copy"
  | "add"
  | "light"
  | "dark"
  | "select"
  | "quit";

/** The type filters of the Computers screen's rail. */
export type ComputersFilter = "windows" | "workspaces" | "machines" | "gateways";

/** The scope id each type of row carries. The Computers screen gives every
 * type its own, which is its rail; a deck with one Computers scope names that
 * scope four times. */
export type ComputersScopeIds = Record<ComputersFilter, string>;

export const COMPUTERS_TYPE_SCOPES: ComputersScopeIds = {
  windows: "windows",
  workspaces: "workspaces",
  machines: "computers",
  gateways: "gateways",
};

export interface ComputersContext {
  bridge: ComputersBridge;
  confirmations: ComputersConfirmations;
  icons: Partial<Record<ComputersIconName, DeckIcon>>;
  scopes?: ComputersScopeIds;
  /** What a new terminal window of a machine is called. The Computers screen
   * says `New terminal`, as its cards do; a deck that also opens terminal
   * tabs gives the window its own title. */
  terminalTitle?: string;
}

export interface ComputersView {
  /** The pages entered, outermost first, as the refs rows carry in `next` and
   * `page`. */
  path: readonly string[];
  filter: ComputersFilter | null;
  query: string;
}

export interface ComputersEntry extends DeckItem {
  /** The page Enter opens, on a branch. */
  next?: string[];
  /** The page Right opens, on a row Enter runs. */
  page?: string[];
  run?: () => void | DeckConfirm | Promise<void | DeckConfirm>;
}

export interface ComputersDeck {
  entries: ComputersEntry[];
  /** The part of the view's path that still names objects. A host whose path
   * is longer has a page open on something that left the model. */
  path: string[];
  /** The names of the pages in `path`. */
  crumbs: string[];
  /** What the list is: the page's object, the filter, or Computers. */
  title: string;
}

// ---- Words ----------------------------------------------------------------

/** Why a row cannot run, in the words its card uses. */
export const COMPUTERS_REASONS = {
  working: "Working…",
  leader: "The session leader manages this workspace's windows",
  foreign: "Workspace is open in another Chan process",
  lockUnknown: "Could not read this workspace's lock state",
  unavailable: "Workspace unavailable",
  controlOpen: "Close the control terminal to reconnect",
} as const;

export const COMPUTERS_SECTIONS = {
  attention: "Needs attention",
  recent: "Recent windows",
  machines: "Computers",
  gateways: "Gateways",
  workspaces: "Workspaces",
  windows: "Windows",
  create: "New",
  desktop: "Chan Desktop",
  actions: "Actions",
  unplaced: "Connecting",
} as const;

const FILTER_LABEL: Record<ComputersFilter, string> = {
  windows: COMPUTERS_SECTIONS.windows,
  workspaces: COMPUTERS_SECTIONS.workspaces,
  machines: COMPUTERS_SECTIONS.machines,
  gateways: COMPUTERS_SECTIONS.gateways,
};

const WINDOW_WORDS: Record<WindowActionId, { label: string; verb: string }> = {
  focus: { label: "Focus window", verb: "Focus" },
  show: { label: "Show window", verb: "Show" },
  hide: { label: "Hide window", verb: "Hide" },
  open: { label: "Open window", verb: "Open" },
  close: { label: "Close window", verb: "Close" },
};

const RECENT_WINDOWS = 5;

/** A workspace's state for the row's right column: the desired state, and the
 * observed one when the two disagree, or the condition that rules actions
 * out. */
export function workspaceStateWord(workspace: Pick<ComputersWorkspace, "on" | "condition">): string {
  const { on, condition } = workspace;
  if (condition === "unknown") return "unknown";
  if (condition === "foreign") return "locked";
  if (condition === "degraded") return "degraded";
  const desired = on ? "on" : "off";
  const observed = on
    ? condition === "idle" ? "stopped" : condition === "failed" ? "failed" : null
    : condition === "ready" ? "running" : null;
  return observed ? `${desired}, ${observed}` : desired;
}

/** A devserver's connection for the row's right column. */
export function connectionWord(
  machine: Pick<ComputersMachine, "connection" | "lost" | "busy">,
): string | undefined {
  if (!machine.connection) return undefined;
  if (machine.lost || machine.connection === "unreachable") return "connection lost";
  if (machine.connection === "connected") return "connected";
  if (machine.busy || machine.connection === "connecting") return "connecting";
  return "disconnected";
}

// ---- Rows -----------------------------------------------------------------

type RefKind = "machine" | "workspace" | "window" | "gateway";

function ref(kind: RefKind, key: string): string {
  return `${kind}:${key}`;
}

function joined(...parts: (string | false | null | undefined)[]): string | undefined {
  return parts.filter(Boolean).join(" · ") || undefined;
}

/** One action of one object, before it is laid out as a row. */
interface Act {
  id: string;
  /** The title on the object's own page. */
  label: string;
  /** The title in a list of many objects: verb, then object. */
  phrase: string;
  icon: ComputersIconName;
  value?: string;
  keywords?: string;
  danger?: boolean;
  /** Why it cannot run. */
  disabled?: string;
  /** Leaves at once on success: the action moves focus to another window. */
  quick?: boolean;
  /** Leaves as it starts: the action opens a dialog or a screen. */
  detached?: boolean;
  /** The root's New section already lists this action. */
  twin?: boolean;
  confirm?: DeckItem["confirm"];
  run: NonNullable<ComputersEntry["run"]>;
}

interface Builder {
  model: ComputersModel;
  ctx: ComputersContext;
  scopes: ComputersScopeIds;
  /** The path rows of the current list extend to reach a page. */
  base: readonly string[];
}

interface Layout {
  section?: string;
  subtitle?: string;
  breadcrumb: string;
  scope: string;
  search?: string;
}

function searchText(title: string, layout: Layout, extra?: string): string {
  return [title, layout.subtitle, layout.breadcrumb, layout.search, extra].filter(Boolean).join(" ");
}

function actEntry(b: Builder, act: Act, key: string, title: string, layout: Layout): ComputersEntry {
  return {
    id: `computers:${act.id}:${key}`,
    title,
    breadcrumb: layout.breadcrumb,
    searchText: searchText(title, layout, `${act.label} ${act.keywords ?? ""}`),
    scope: layout.scope,
    icon: b.ctx.icons[act.icon],
    section: layout.section,
    subtitle: act.disabled ?? layout.subtitle,
    value: act.value,
    danger: act.danger,
    disabled: act.disabled !== undefined || undefined,
    awaitResult: !act.detached,
    dismissImmediatelyOnSuccess: act.quick,
    confirm: act.disabled === undefined ? act.confirm : undefined,
    run: act.run,
  };
}

/** An object's row. It runs `primary` on Enter and opens its page on Right
 * when it has one to run; it opens its page on Enter otherwise; and it is
 * disabled when nothing under it may run, with the reason where there is
 * one. */
function objectEntry(
  b: Builder,
  kind: RefKind,
  key: string,
  title: string,
  icon: ComputersIconName,
  layout: Layout,
  options: { primary?: Act; value?: string; inert?: boolean; reason?: string; keywords?: string } = {},
): ComputersEntry {
  const page = [...b.base, ref(kind, key)];
  const row: ComputersEntry = {
    id: `computers:${kind}:${key}`,
    title,
    breadcrumb: layout.breadcrumb,
    searchText: searchText(title, layout, options.keywords),
    scope: layout.scope,
    icon: b.ctx.icons[icon],
    section: layout.section,
    subtitle: options.reason ?? layout.subtitle,
    value: options.value,
  };
  if (options.inert) return { ...row, disabled: true };
  const primary = options.primary;
  if (!primary || primary.disabled !== undefined) return { ...row, kind: "branch", next: page };
  return {
    ...row,
    expandable: true,
    page,
    awaitResult: !primary.detached,
    dismissImmediatelyOnSuccess: primary.quick,
    confirm: primary.confirm,
    run: primary.run,
  };
}

// ---- Windows ----------------------------------------------------------------

interface PlacedWindow {
  window: ComputersWindow;
  /** The name of the machine that lists it. */
  machine: string;
}

function windowActs(b: Builder, window: ComputersWindow): Act[] {
  if (window.blocked !== undefined) return [];
  return window.actions.map((action): Act => {
    const words = WINDOW_WORDS[action];
    const act: Act = {
      id: action,
      label: words.label,
      phrase: `${words.verb} ${window.name}`,
      icon: action,
      quick: action === "focus" || action === "open",
      run: () => b.ctx.bridge.run({ target: "window", key: window.key, action }),
    };
    if (action !== "close") return act;
    if (window.control) {
      return {
        ...act,
        danger: true,
        confirm: {
          title: `Close ${window.name}?`,
          message: "This stops the control terminal and its connection script.",
          actionLabel: "Close",
          danger: true,
        },
      };
    }
    return { ...act, danger: true, ...b.ctx.confirmations.closeWindow(window) };
  });
}

function windowLayout(b: Builder, placed: PlacedWindow, section?: string): Layout {
  const { window, machine } = placed;
  return {
    section,
    subtitle: joined(window.context, machine, window.current && "This window"),
    breadcrumb: `${COMPUTERS_SECTIONS.windows} › ${machine}`,
    scope: b.scopes.windows,
    search: window.search,
  };
}

function windowEntry(b: Builder, placed: PlacedWindow, section?: string, note?: string): ComputersEntry {
  const { window } = placed;
  const layout = windowLayout(b, placed, section);
  if (note) layout.subtitle = joined(note, layout.subtitle);
  const acts = windowActs(b, window);
  // Close is never what Enter runs on a window's own row.
  const primary = acts[0]?.id === "close" ? undefined : acts[0];
  return objectEntry(b, "window", window.key, window.name, window.kind === "terminal" ? "terminal" : "window", layout, {
    primary,
    value: window.hidden ? "hidden" : undefined,
    inert: acts.length === 0,
    reason: window.blocked,
    keywords: "window",
  });
}

/** An object's actions as rows: under its own page they carry the card's
 * label, and in a list of many objects the phrase that names the object. */
function windowActEntries(b: Builder, placed: PlacedWindow, own: boolean, section?: string): ComputersEntry[] {
  const layout = windowLayout(b, placed, section);
  return windowActs(b, placed.window).map((act) =>
    actEntry(b, act, placed.window.key, own ? act.label : act.phrase, layout),
  );
}

// ---- Workspaces -------------------------------------------------------------

interface PlacedWorkspace {
  workspace: ComputersWorkspace;
  machine: string;
}

function placeWorkspaces(machine: ComputersMachine): PlacedWorkspace[] {
  return machine.workspaces.map((workspace) => ({
    workspace,
    machine: workspace.machine ?? machine.name,
  }));
}

function workspaceWindows(placed: PlacedWorkspace): PlacedWindow[] {
  return placed.workspace.windows.map((window) => ({ window, machine: placed.machine }));
}

function workspaceActs(b: Builder, workspace: ComputersWorkspace): Act[] {
  const { may } = b.model;
  const { key, name, condition } = workspace;
  const run = (action: WorkspaceActionId) => () =>
    b.ctx.bridge.run({ target: "workspace", key, action });
  const working = workspace.busy || condition === "busy" ? COMPUTERS_REASONS.working : undefined;
  const lock =
    condition === "unknown"
      ? COMPUTERS_REASONS.lockUnknown
      : condition === "foreign"
        ? COMPUTERS_REASONS.foreign
        : undefined;
  const acts: Act[] = [];

  if (may.window) {
    const off = condition === "idle";
    const blocked = workspace.leaderHeld
      ? COMPUTERS_REASONS.leader
      : lock ??
        working ??
        (condition === "degraded" || condition === "failed"
          ? workspace.reason ?? COMPUTERS_REASONS.unavailable
          : undefined);
    if (off && blocked === undefined) {
      // A workspace that is off has no window to open. Where the host can
      // turn it on, the row does both; where it cannot, it offers nothing.
      if (may.power) {
        acts.push({
          id: "turn-on-and-open",
          label: "Turn on and open",
          phrase: `Turn on and open ${name}`,
          icon: "window",
          keywords: "new window",
          quick: true,
          run: run("turn-on-and-open"),
        });
      }
    } else {
      acts.push({
        id: "new-window",
        label: "New window",
        phrase: `New window of ${name}`,
        icon: "window",
        disabled: blocked,
        quick: true,
        run: run("new-window"),
      });
      if (may.terminalWindow && !off) {
        acts.push({
          id: "new-terminal-window",
          label: "New terminal window",
          phrase: `New terminal window of ${name}`,
          icon: "terminal",
          disabled: blocked,
          quick: true,
          run: run("new-terminal-window"),
        });
      }
    }
  }

  if (may.power) {
    const state = workspaceStateWord(workspace);
    const contradicts = state !== "on" && state !== "off" ? state : undefined;
    const blocked = lock ?? working;
    if (workspace.on) {
      acts.push({
        id: "turn-off",
        label: "Turn off",
        phrase: `Turn off ${name}`,
        icon: "power",
        value: contradicts,
        danger: true,
        disabled: blocked,
        ...b.ctx.confirmations.turnOffWorkspace(workspace),
      });
    } else {
      acts.push({
        id: "turn-on",
        label: "Turn on",
        phrase: `Turn on ${name}`,
        icon: "power",
        value: contradicts,
        disabled: blocked,
        run: run("turn-on"),
      });
    }
  }
  return acts;
}

function workspaceLayout(b: Builder, placed: PlacedWorkspace, section?: string): Layout {
  return {
    section,
    subtitle: placed.machine,
    breadcrumb: `${COMPUTERS_SECTIONS.workspaces} › ${placed.machine}`,
    scope: b.scopes.workspaces,
    search: placed.workspace.search,
  };
}

function workspaceEntry(b: Builder, placed: PlacedWorkspace, section?: string, note?: string): ComputersEntry {
  const { workspace } = placed;
  const layout = workspaceLayout(b, placed, section);
  if (note) layout.subtitle = joined(note, layout.subtitle);
  const acts = workspaceActs(b, workspace);
  const opens = acts[0]?.id === "new-window" || acts[0]?.id === "turn-on-and-open";
  return objectEntry(b, "workspace", workspace.key, workspace.name, "workspace", layout, {
    primary: opens ? acts[0] : undefined,
    value: workspaceStateWord(workspace),
    keywords: "workspace",
  });
}

function workspaceActEntries(b: Builder, placed: PlacedWorkspace, own: boolean, section?: string): ComputersEntry[] {
  const layout = workspaceLayout(b, placed, section);
  return workspaceActs(b, placed.workspace).map((act) =>
    actEntry(b, act, placed.workspace.key, own ? act.label : act.phrase, layout),
  );
}

// ---- Machines ---------------------------------------------------------------

function machineWindows(machine: ComputersMachine): PlacedWindow[] {
  return [
    ...machine.windows,
    ...machine.workspaces.flatMap((workspace) => workspace.windows),
  ].map((window) => ({ window, machine: machine.name }));
}

function machineActs(b: Builder, machine: ComputersMachine): Act[] {
  const { may } = b.model;
  const { key, name } = machine;
  const run = (action: MachineActionId) => () =>
    b.ctx.bridge.run({ target: "machine", key, action });
  const terminal = b.ctx.terminalTitle ?? "New terminal";
  const acts: Act[] = [];

  if (machine.kind === "local") {
    if (may.terminal) {
      acts.push({
        id: "new-terminal",
        label: terminal,
        phrase: `${terminal} on ${name}`,
        icon: "terminal",
        keywords: "shell",
        quick: true,
        twin: true,
        run: run("new-terminal"),
      });
    }
    if (may.newWorkspace) {
      acts.push({
        id: "new-workspace",
        label: "New workspace",
        phrase: `New workspace on ${name}`,
        icon: "add",
        detached: true,
        twin: true,
        run: run("new-workspace"),
      });
    }
  }

  if (machine.kind === "devserver") {
    const working =
      machine.busy || machine.connection === "connecting" ? COMPUTERS_REASONS.working : undefined;
    const held = machine.connection === "connected" || machine.connection === "unreachable";
    if (may.remoteTerminal && machine.connection === "connected") {
      acts.push({
        id: "new-terminal",
        label: terminal,
        phrase: `${terminal} on ${name}`,
        icon: "terminal",
        keywords: "shell",
        quick: true,
        run: run("new-terminal"),
      });
    }
    if (may.connect && held) {
      // A connection that stopped answering still holds its record, so it is
      // disconnected before it can be connected again.
      acts.push({
        id: "disconnect",
        label: "Disconnect",
        phrase: `Disconnect ${name}`,
        icon: "disconnect",
        danger: true,
        disabled: working,
        confirm: {
          title: `Disconnect ${name}?`,
          message: "Its Chan windows will close locally. The remote computer keeps running.",
          actionLabel: "Disconnect",
          danger: true,
        },
        run: run("disconnect"),
      });
    }
    if (may.connect && !held) {
      const blocked = working ?? (machine.controlOpen ? COMPUTERS_REASONS.controlOpen : undefined);
      acts.push({
        id: "connect",
        label: "Connect",
        phrase: `Connect ${name}`,
        icon: "connect",
        value: machine.signIn ? "waiting for sign-in" : undefined,
        keywords: "reconnect",
        disabled: blocked,
        quick: true,
        run: run("connect"),
      });
      // A terminal needs the connection first. The row does both where the
      // connect can finish by itself.
      if (may.remoteTerminal && blocked === undefined && !machine.trustRequired && !machine.signIn) {
        acts.push({
          id: "connect-and-open",
          label: "Connect and open",
          phrase: `Connect and open ${name}`,
          icon: "terminal",
          keywords: `${terminal} shell`,
          quick: true,
          run: run("connect-and-open"),
        });
      }
    }
    if (machine.editable) {
      acts.push({
        id: "edit-config",
        label: "Edit config",
        phrase: `Edit config for ${name}`,
        icon: "edit",
        detached: true,
        run: run("edit-config"),
      });
    }
    if (machine.revocable) {
      acts.push({
        id: "revoke-native-access",
        label: "Revoke native access",
        phrase: `Revoke native access for ${name}`,
        icon: "revoke",
        danger: true,
        confirm: {
          title: `Revoke native access for ${name}?`,
          message: "Its Chan windows will close. Quit Chan Desktop to purge the runtime ACL.",
          actionLabel: "Revoke",
          danger: true,
        },
        run: run("revoke-native-access"),
      });
    }
  }

  if (machine.kind === "tmux" && may.tmux && machine.attached) {
    acts.push(
      {
        id: "new-tmux-window",
        label: "New tmux window",
        phrase: `New tmux window in ${name}`,
        icon: "terminal",
        run: run("new-tmux-window"),
      },
      {
        id: "detach",
        label: "Detach",
        phrase: `Detach ${name}`,
        icon: "disconnect",
        run: run("detach"),
      },
    );
  }

  if (may.showCard) {
    acts.push({
      id: "show-card",
      label: "Show on Computers screen",
      phrase: `Show ${name} on Computers screen`,
      icon: "card",
      detached: true,
      run: run("show-card"),
    });
  }
  return acts;
}

function machineIcon(machine: ComputersMachine): ComputersIconName {
  return machine.kind === "local" ? "local" : machine.kind;
}

function machineLayout(b: Builder, machine: ComputersMachine, section?: string): Layout {
  return {
    section,
    subtitle: machine.detail,
    breadcrumb: COMPUTERS_SECTIONS.machines,
    scope: b.scopes.machines,
    search: machine.search,
  };
}

function machineEntry(b: Builder, machine: ComputersMachine, section?: string): ComputersEntry {
  return objectEntry(b, "machine", machine.key, machine.name, machineIcon(machine), machineLayout(b, machine, section), {
    value: connectionWord(machine),
    keywords: "computer machine",
  });
}

function machineActEntries(b: Builder, machine: ComputersMachine, own: boolean, section?: string): ComputersEntry[] {
  const layout = machineLayout(b, machine, section);
  return machineActs(b, machine)
    .filter((act) => own || !act.twin)
    .map((act) => actEntry(b, act, machine.key, own ? act.label : act.phrase, layout));
}

function needsAttention(machine: ComputersMachine): boolean {
  return (
    machine.lost === true ||
    machine.connection === "unreachable" ||
    machine.connection === "disconnected"
  );
}

// ---- Gateways ---------------------------------------------------------------

function gatewayActs(b: Builder, gateway: ComputersGateway): Act[] {
  const { may } = b.model;
  const { key, name } = gateway;
  const run = (action: GatewayActionId) => () =>
    b.ctx.bridge.run({ target: "gateway", key, action });
  const acts: Act[] = [];
  if (may.connect) {
    if (gateway.connection === "disconnected") {
      acts.push({
        id: "gateway-connect",
        label: "Connect",
        phrase: `Connect gateway ${name}`,
        icon: "connect",
        run: run("connect"),
      });
    } else if (gateway.connection === "connecting") {
      acts.push({
        id: "gateway-disconnect",
        label: "Cancel connection",
        phrase: `Cancel connection to ${name}`,
        icon: "disconnect",
        keywords: "disconnect",
        run: run("disconnect"),
      });
    } else {
      acts.push({
        id: "gateway-disconnect",
        label: "Disconnect",
        phrase: `Disconnect gateway ${name}`,
        icon: "disconnect",
        danger: true,
        confirm: {
          title: `Disconnect ${name}?`,
          message: "Its devservers' Chan windows will close locally. The remote computers keep running.",
          actionLabel: "Disconnect",
          danger: true,
        },
        run: run("disconnect"),
      });
    }
  }
  if (may.renameGateway) {
    acts.push({
      id: "gateway-rename",
      label: "Rename",
      phrase: `Rename gateway ${name}`,
      icon: "edit",
      detached: true,
      run: run("rename"),
    });
  }
  if (gateway.publicKey) {
    acts.push({
      id: "gateway-copy-key",
      label: "Copy WireGuard public key",
      phrase: `Copy the WireGuard public key of ${name}`,
      icon: "copy",
      run: run("copy-wireguard-key"),
    });
  }
  return acts;
}

function gatewayLayout(b: Builder, gateway: ComputersGateway, section?: string): Layout {
  return {
    section,
    subtitle: gateway.detail,
    breadcrumb: COMPUTERS_SECTIONS.gateways,
    scope: b.scopes.gateways,
    search: gateway.search,
  };
}

function gatewayEntry(b: Builder, gateway: ComputersGateway, section?: string): ComputersEntry {
  return objectEntry(b, "gateway", gateway.key, gateway.name, "gateway", gatewayLayout(b, gateway, section), {
    value: connectionWord(gateway),
    keywords: "gateway",
  });
}

function gatewayActEntries(b: Builder, gateway: ComputersGateway, own: boolean, section?: string): ComputersEntry[] {
  const layout = gatewayLayout(b, gateway, section);
  return gatewayActs(b, gateway).map((act) =>
    actEntry(b, act, gateway.key, own ? act.label : act.phrase, layout),
  );
}

// ---- New and the app --------------------------------------------------------

interface Created {
  entry: ComputersEntry;
  /** The type filter the row also closes. */
  filter: ComputersFilter;
}

function createEntries(b: Builder, section?: string): Created[] {
  const { may } = b.model;
  const layout = (filter: ComputersFilter): Layout => ({
    section,
    breadcrumb: COMPUTERS_SECTIONS.create,
    scope: b.scopes[filter],
  });
  const app = (
    action: AppActionId,
    title: string,
    filter: ComputersFilter,
    keywords: string,
  ): Created => {
    const place = layout(filter);
    return {
      filter,
      entry: {
        id: `computers:${action}`,
        title,
        breadcrumb: place.breadcrumb,
        searchText: searchText(title, place, keywords),
        scope: place.scope,
        icon: b.ctx.icons.add,
        section,
        awaitResult: false,
        run: () => b.ctx.bridge.run({ target: "app", action }),
      },
    };
  };
  const rows: Created[] = [];
  const local = b.model.machines.find((machine) => machine.kind === "local");
  if (may.terminal && local) {
    const title = b.ctx.terminalTitle ?? "New terminal";
    const place = layout("windows");
    rows.push({
      filter: "windows",
      entry: {
        id: "computers:new-terminal",
        title,
        breadcrumb: place.breadcrumb,
        searchText: searchText(title, place, `shell ${local.name} ${local.search ?? ""}`),
        scope: place.scope,
        icon: b.ctx.icons.terminal,
        section,
        awaitResult: true,
        dismissImmediatelyOnSuccess: true,
        run: () => b.ctx.bridge.run({ target: "machine", key: local.key, action: "new-terminal" }),
      },
    });
  }
  if (may.newWorkspace) rows.push(app("new-workspace", "New workspace", "workspaces", "add folder"));
  if (may.addDevserver) rows.push(app("add-devserver", "Add devserver", "machines", "new computer server"));
  if (may.addGateway) rows.push(app("add-gateway", "Add gateway", "gateways", "new"));
  return rows;
}

function desktopEntries(b: Builder, section?: string): ComputersEntry[] {
  const desktop = b.model.desktop;
  if (!desktop) return [];
  const place: Layout = {
    section,
    breadcrumb: COMPUTERS_SECTIONS.desktop,
    scope: b.scopes.machines,
  };
  const next = desktop.theme === "dark" ? "light" : "dark";
  const theme = `Switch to ${next} theme`;
  return [
    {
      id: "computers:theme",
      title: theme,
      breadcrumb: place.breadcrumb,
      searchText: searchText(theme, place, "appearance toggle"),
      scope: place.scope,
      icon: b.ctx.icons[next],
      section,
      awaitResult: false,
      run: () => b.ctx.bridge.run({ target: "app", action: "theme" }),
    },
    {
      id: "computers:select",
      title: "Select",
      breadcrumb: place.breadcrumb,
      searchText: searchText("Select", place, "select mode bulk turn on turn off remove"),
      scope: place.scope,
      icon: b.ctx.icons.select,
      section,
      kind: "toggle",
      value: desktop.selecting ? "on" : "off",
      awaitResult: false,
      run: () => b.ctx.bridge.run({ target: "app", action: "select" }),
    },
    {
      id: "computers:quit",
      title: "Quit",
      breadcrumb: place.breadcrumb,
      searchText: searchText("Quit", place, "exit app desktop"),
      scope: place.scope,
      icon: b.ctx.icons.quit,
      section,
      danger: true,
      awaitResult: false,
      confirm: {
        title: "Quit Chan Desktop?",
        message: "Local workspaces and terminal sessions will stop.",
        actionLabel: "Quit",
        danger: true,
      },
      run: () => b.ctx.bridge.run({ target: "app", action: "quit" }),
    },
  ];
}

// ---- Lists ------------------------------------------------------------------

function everyWindow(model: ComputersModel): PlacedWindow[] {
  return [
    ...model.machines.flatMap(machineWindows),
    ...(model.unplaced ?? []).map((window) => ({ window, machine: COMPUTERS_SECTIONS.unplaced })),
  ];
}

function everyWorkspace(model: ComputersModel): PlacedWorkspace[] {
  return model.machines.flatMap(placeWorkspaces);
}

/** Append rows, leaving out any whose object an earlier section listed, so
 * a list shows each object once. */
function appendOnce(rows: ComputersEntry[], more: ComputersEntry[]): void {
  const listed = new Set(rows.map((row) => row.id));
  for (const row of more) {
    if (listed.has(row.id)) continue;
    listed.add(row.id);
    rows.push(row);
  }
}

function attentionEntries(b: Builder): ComputersEntry[] {
  const section = COMPUTERS_SECTIONS.attention;
  return [
    ...b.model.machines.filter(needsAttention).map((machine) => machineEntry(b, machine, section)),
    ...everyWorkspace(b.model)
      .filter(({ workspace }) => workspace.condition === "degraded" || workspace.condition === "failed")
      .map((placed) => workspaceEntry(b, placed, section, placed.workspace.reason)),
    ...everyWindow(b.model)
      .filter(({ window }) => window.attention !== undefined)
      .map((placed) => windowEntry(b, placed, section, placed.window.attention)),
  ];
}

function recentEntries(b: Builder): ComputersEntry[] {
  const windows = new Map(everyWindow(b.model).map((placed) => [placed.window.key, placed]));
  return (b.model.recent ?? [])
    .map((key) => windows.get(key))
    .filter((placed): placed is PlacedWindow => placed !== undefined)
    .slice(0, RECENT_WINDOWS)
    .map((placed) => windowEntry(b, placed, COMPUTERS_SECTIONS.recent));
}

function rootEntries(b: Builder): ComputersEntry[] {
  const { model } = b;
  const rows: ComputersEntry[] = [];
  appendOnce(rows, attentionEntries(b));
  appendOnce(rows, recentEntries(b));
  if (model.machines.length === 1) {
    // One machine is no choice, so its workspaces and windows stand where the
    // machines would.
    appendOnce(rows, everyWorkspace(model).map((placed) => workspaceEntry(b, placed, COMPUTERS_SECTIONS.workspaces)));
    appendOnce(rows, everyWindow(model).map((placed) => windowEntry(b, placed, COMPUTERS_SECTIONS.windows)));
  } else {
    appendOnce(rows, model.machines.map((machine) => machineEntry(b, machine, COMPUTERS_SECTIONS.machines)));
  }
  if (model.may.gateways) {
    appendOnce(rows, (model.gateways ?? []).map((gateway) => gatewayEntry(b, gateway, COMPUTERS_SECTIONS.gateways)));
  }
  appendOnce(rows, createEntries(b, COMPUTERS_SECTIONS.create).map((created) => created.entry));
  appendOnce(rows, desktopEntries(b, COMPUTERS_SECTIONS.desktop));
  return rows;
}

function filterEntries(b: Builder, filter: ComputersFilter): ComputersEntry[] {
  const { model } = b;
  const rows: ComputersEntry[] = [];
  if (filter === "windows") {
    for (const machine of model.machines) {
      rows.push(...machineWindows(machine).map((placed) => windowEntry(b, placed, machine.name)));
    }
    rows.push(
      ...(model.unplaced ?? []).map((window) =>
        windowEntry(b, { window, machine: COMPUTERS_SECTIONS.unplaced }, COMPUTERS_SECTIONS.unplaced),
      ),
    );
  } else if (filter === "workspaces") {
    for (const machine of model.machines) {
      rows.push(...placeWorkspaces(machine).map((placed) => workspaceEntry(b, placed, machine.name)));
    }
  } else if (filter === "machines") {
    rows.push(...model.machines.map((machine) => machineEntry(b, machine, COMPUTERS_SECTIONS.machines)));
  } else {
    rows.push(...(model.gateways ?? []).map((gateway) => gatewayEntry(b, gateway, COMPUTERS_SECTIONS.gateways)));
  }
  rows.push(
    ...createEntries(b, COMPUTERS_SECTIONS.create)
      .filter((created) => created.filter === filter)
      .map((created) => created.entry),
  );
  return rows;
}

/** Every object and every action, each row titled so it reads alone: what a
 * typed query ranks. */
function searchEntries(b: Builder, filter: ComputersFilter | null): ComputersEntry[] {
  const { model } = b;
  const all = filter === null;
  const rows: ComputersEntry[] = [];
  if (all || filter === "windows") {
    for (const placed of everyWindow(model)) {
      rows.push(windowEntry(b, placed), ...windowActEntries(b, placed, false));
    }
  }
  if (all || filter === "workspaces") {
    for (const placed of everyWorkspace(model)) {
      rows.push(workspaceEntry(b, placed), ...workspaceActEntries(b, placed, false));
    }
  }
  if (all || filter === "machines") {
    for (const machine of model.machines) {
      rows.push(machineEntry(b, machine), ...machineActEntries(b, machine, false));
    }
  }
  if ((all || filter === "gateways") && model.may.gateways) {
    for (const gateway of model.gateways ?? []) {
      rows.push(gatewayEntry(b, gateway), ...gatewayActEntries(b, gateway, false));
    }
  }
  rows.push(
    ...createEntries(b)
      .filter((created) => all || created.filter === filter)
      .map((created) => created.entry),
  );
  if (all) rows.push(...desktopEntries(b));
  return rows;
}

// ---- Pages --------------------------------------------------------------------

type Page =
  | { kind: "machine"; machine: ComputersMachine }
  | { kind: "workspace"; placed: PlacedWorkspace }
  | { kind: "window"; placed: PlacedWindow }
  | { kind: "gateway"; gateway: ComputersGateway };

function findPage(model: ComputersModel, part: string): Page | null {
  const at = part.indexOf(":");
  const kind = part.slice(0, at);
  const key = part.slice(at + 1);
  if (kind === "machine") {
    const machine = model.machines.find((candidate) => candidate.key === key);
    return machine ? { kind, machine } : null;
  }
  if (kind === "workspace") {
    const placed = everyWorkspace(model).find((candidate) => candidate.workspace.key === key);
    return placed ? { kind, placed } : null;
  }
  if (kind === "window") {
    const placed = everyWindow(model).find((candidate) => candidate.window.key === key);
    return placed ? { kind, placed } : null;
  }
  if (kind === "gateway") {
    const gateway = (model.gateways ?? []).find((candidate) => candidate.key === key);
    return gateway ? { kind, gateway } : null;
  }
  return null;
}

function pageName(page: Page): string {
  switch (page.kind) {
    case "machine":
      return page.machine.name;
    case "workspace":
      return page.placed.workspace.name;
    case "window":
      return page.placed.window.name;
    case "gateway":
      return page.gateway.name;
  }
}

/** A page's rows. Browsing, they are the object's actions and the objects
 * under it, in sections; searched, they are everything under the object,
 * each row titled to read alone. */
function pageEntries(b: Builder, page: Page, searching: boolean): ComputersEntry[] {
  const section = (name: string): string | undefined => (searching ? undefined : name);
  switch (page.kind) {
    case "machine": {
      const { machine } = page;
      const workspaces = placeWorkspaces(machine);
      const windows = machineWindows(machine);
      return [
        ...machineActEntries(b, machine, true, section(COMPUTERS_SECTIONS.actions)),
        ...workspaces.flatMap((placed) => [
          workspaceEntry(b, placed, section(COMPUTERS_SECTIONS.workspaces)),
          ...(searching ? workspaceActEntries(b, placed, false) : []),
        ]),
        ...windows.flatMap((placed) => [
          windowEntry(b, placed, section(COMPUTERS_SECTIONS.windows)),
          ...(searching ? windowActEntries(b, placed, false) : []),
        ]),
      ];
    }
    case "workspace": {
      const { placed } = page;
      return [
        ...workspaceActEntries(b, placed, true, section(COMPUTERS_SECTIONS.actions)),
        ...workspaceWindows(placed).flatMap((window) => [
          windowEntry(b, window, section(COMPUTERS_SECTIONS.windows)),
          ...(searching ? windowActEntries(b, window, false) : []),
        ]),
      ];
    }
    case "window":
      return windowActEntries(b, page.placed, true, section(COMPUTERS_SECTIONS.actions));
    case "gateway":
      return gatewayActEntries(b, page.gateway, true, section(COMPUTERS_SECTIONS.actions));
  }
}

// ---- The deck -----------------------------------------------------------------

/** The rows of the Computers tree for one view of one model. A typed query
 * gets every candidate, unranked and without sections: the host ranks them. */
export function computersDeck(model: ComputersModel, view: ComputersView, ctx: ComputersContext): ComputersDeck {
  const scopes = ctx.scopes ?? COMPUTERS_TYPE_SCOPES;
  const pages: Page[] = [];
  for (const part of view.path) {
    const page = findPage(model, part);
    if (!page) break;
    pages.push(page);
  }
  const path = view.path.slice(0, pages.length);
  const b: Builder = { model, ctx, scopes, base: path };
  const searching = view.query.trim() !== "";
  const page = pages.at(-1);
  const crumbs = pages.map(pageName);
  if (page) {
    return { entries: pageEntries(b, page, searching), path, crumbs, title: pageName(page) };
  }
  const filter = view.filter === "gateways" && !model.may.gateways ? null : view.filter;
  const entries = searching
    ? searchEntries(b, filter)
    : filter
      ? filterEntries(b, filter)
      : rootEntries(b);
  return { entries, path, crumbs, title: filter ? FILTER_LABEL[filter] : COMPUTERS_SECTIONS.machines };
}

/** The rail of a deck that lists Computers alone: one orb per type of object
 * the host holds. */
export function computersScopes(
  model: ComputersModel,
  icons: ComputersContext["icons"],
  scopes: ComputersScopeIds = COMPUTERS_TYPE_SCOPES,
): DeckScope[] {
  const filters: ComputersFilter[] = ["windows", "workspaces", "machines"];
  if (model.may.gateways) filters.push("gateways");
  const icon: Record<ComputersFilter, ComputersIconName> = {
    windows: "windows",
    workspaces: "workspace",
    machines: "computers",
    gateways: "gateway",
  };
  return filters.map((filter) => ({
    id: scopes[filter],
    label: FILTER_LABEL[filter],
    icon: icons[icon[filter]],
  }));
}

/** The filter a scope id names, or null for none of them. */
export function computersFilter(
  scope: string | null,
  scopes: ComputersScopeIds = COMPUTERS_TYPE_SCOPES,
): ComputersFilter | null {
  const filters: ComputersFilter[] = ["windows", "workspaces", "machines", "gateways"];
  return filters.find((filter) => scopes[filter] === scope) ?? null;
}
