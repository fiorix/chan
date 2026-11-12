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
// A type of object has a page too, the list its filter gives, so a list that
// holds other things beside the tree can lead into it in one row per type.

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
  /** The host is a window of an app whose own screen lists every computer,
   * and can show that screen. Its tree then ends with the way there. */
  allComputers?: boolean;
}

/** The themes a Computers screen switches between. */
export type ComputersTheme = "light" | "dark";

/** Chan Desktop, where it is the app that hosts the Computers screen: it has
 * commands of its own. */
export interface ComputersDesktop {
  theme: ComputersTheme;
}

export interface ComputersModel {
  machines: ComputersMachine[];
  /** Windows whose machine the host has not placed yet. */
  unplaced?: ComputersWindow[];
  gateways?: ComputersGateway[];
  /** Window keys, most recently used first. */
  recent?: string[];
  may: ComputersMay;
  /** Whether the screen's Select mode is on, where the screen has one. */
  selecting?: boolean;
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
  | "connect"
  | "connect-and-open"
  | "disconnect"
  | "edit-config"
  | "revoke-native-access"
  | "new-tmux-window"
  | "detach"
  | "show-card";

export type GatewayActionId = "connect" | "disconnect" | "rename" | "copy-wireguard-key";

export type AppActionId =
  | "new-workspace"
  | "add-devserver"
  | "add-gateway"
  | "select"
  | "quit"
  | "all-computers";

export type ComputersCommand =
  | { target: "window"; key: string; action: WindowActionId }
  | { target: "workspace"; key: string; action: WorkspaceActionId }
  | { target: "machine"; key: string; action: MachineActionId }
  | { target: "gateway"; key: string; action: GatewayActionId }
  | { target: "app"; action: AppActionId }
  | { target: "app"; action: "theme"; theme: ComputersTheme };

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
  /** The row ends a ranked list whatever was typed: it leads out of the
   * model, to where what a query names may be. */
  pinned?: boolean;
  /** The row changes a state its own list shows, so the deck stays open on
   * it. */
  stays?: boolean;
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
  off: "Turn the workspace on from the Computers screen",
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
  screen: "Computers screen",
  actions: "Actions",
  unplaced: "Connecting",
} as const;

const FILTER_LABEL: Record<ComputersFilter, string> = {
  windows: COMPUTERS_SECTIONS.windows,
  workspaces: COMPUTERS_SECTIONS.workspaces,
  machines: COMPUTERS_SECTIONS.machines,
  gateways: COMPUTERS_SECTIONS.gateways,
};

// `label` and `verb` are the cards' words. `keywords` are other words a
// query may use for the action; no row shows them.
const WINDOW_WORDS: Record<WindowActionId, { label: string; verb: string; keywords: string }> = {
  focus: { label: "Focus window", verb: "Focus", keywords: "activate foreground" },
  show: { label: "Show window", verb: "Show", keywords: "unhide" },
  hide: { label: "Hide window", verb: "Hide", keywords: "bury" },
  open: { label: "Open window", verb: "Open", keywords: "in this browser" },
  close: { label: "Close window", verb: "Close", keywords: "remove" },
};

const FILTERS: readonly ComputersFilter[] = ["windows", "workspaces", "machines", "gateways"];

const FILTER_ICON: Record<ComputersFilter, ComputersIconName> = {
  windows: "windows",
  workspaces: "workspace",
  machines: "computers",
  gateways: "gateway",
};

// The words the window's Settings uses for the same themes, in its order.
const THEME_WORDS: Record<ComputersTheme, string> = { light: "Light", dark: "Dark" };
const THEMES: readonly ComputersTheme[] = ["light", "dark"];
const THEME_TITLE = "Theme";

// Path parts that name a page with no object behind it: every object of one
// type, and the themes.
const TYPE_PAGE = "type";
const THEME_PAGE = "app:theme";

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

function ref(kind: RefKind | typeof TYPE_PAGE, key: string): string {
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
  /** The row states an on/off state in its value. */
  toggle?: boolean;
  confirm?: DeckItem["confirm"];
  run: NonNullable<ComputersEntry["run"]>;
}

interface Builder {
  model: ComputersModel;
  ctx: ComputersContext;
  scopes: ComputersScopeIds;
  /** The path rows of the current list extend to reach a page. */
  base: readonly string[];
  /** The machine the whole list belongs to, which its rows do not repeat:
   * the only machine there is, the one a page is under, or the one a section
   * is named for. */
  quiet?: string;
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

/** An action's row. `key` names the object it acts on; an action of the host
 * itself has none. */
function actEntry(
  b: Builder,
  act: Act,
  key: string | undefined,
  title: string,
  layout: Layout,
): ComputersEntry {
  return {
    id: key === undefined ? `computers:${act.id}` : `computers:${act.id}:${key}`,
    title,
    breadcrumb: layout.breadcrumb,
    searchText: searchText(title, layout, `${act.label} ${act.keywords ?? ""}`),
    scope: layout.scope,
    icon: b.ctx.icons[act.icon],
    section: layout.section,
    subtitle: act.disabled ?? layout.subtitle,
    kind: act.toggle ? "toggle" : undefined,
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
      keywords: words.keywords,
      // A window that is shown comes to the front on most hosts, as one that
      // is focused or opened does.
      quick: action === "focus" || action === "show" || action === "open",
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

/** The type of a row and the machine it is on, for a list where rows of
 * every type and machine interleave. */
function typePath(b: Builder, type: string, machine: string): string {
  return machine === b.quiet ? type : `${type} › ${machine}`;
}

function windowLayout(b: Builder, placed: PlacedWindow, section?: string): Layout {
  const { window, machine } = placed;
  return {
    section,
    subtitle: joined(window.context, machine !== b.quiet && machine, window.current && "This window"),
    breadcrumb: typePath(b, COMPUTERS_SECTIONS.windows, machine),
    scope: b.scopes.windows,
    search: `${window.search ?? ""} ${machine}`,
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

/** Where an object's action rows sit. On the object's own page its name is
 * above them already, so they carry no second line of their own. */
function actLayout(layout: Layout, own: boolean): Layout {
  return own ? { ...layout, subtitle: undefined } : layout;
}

/** An object's actions as rows: under its own page they carry the card's
 * label, and in a list of many objects the phrase that names the object. */
function windowActEntries(b: Builder, placed: PlacedWindow, own: boolean, section?: string): ComputersEntry[] {
  const layout = actLayout(windowLayout(b, placed, section), own);
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

function withoutContext(placed: PlacedWindow): PlacedWindow {
  return { ...placed, window: { ...placed.window, context: undefined } };
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
  const { workspace, machine } = placed;
  return {
    section,
    subtitle: machine === b.quiet ? undefined : machine,
    breadcrumb: typePath(b, COMPUTERS_SECTIONS.workspaces, machine),
    scope: b.scopes.workspaces,
    search: `${workspace.search ?? ""} ${machine}`,
  };
}

function workspaceEntry(b: Builder, placed: PlacedWorkspace, section?: string, note?: string): ComputersEntry {
  const { workspace } = placed;
  const layout = workspaceLayout(b, placed, section);
  if (note) layout.subtitle = joined(note, layout.subtitle);
  const acts = workspaceActs(b, workspace);
  const opens = acts[0]?.id === "new-window" || acts[0]?.id === "turn-on-and-open";
  // A host that may not turn a workspace on offers nothing on one that is
  // off, and its page would be empty.
  const inert = acts.length === 0 && workspace.windows.length === 0;
  return objectEntry(b, "workspace", workspace.key, workspace.name, "workspace", layout, {
    primary: opens ? acts[0] : undefined,
    value: workspaceStateWord(workspace),
    inert,
    reason: inert ? COMPUTERS_REASONS.off : undefined,
    keywords: "workspace",
  });
}

function workspaceActEntries(b: Builder, placed: PlacedWorkspace, own: boolean, section?: string): ComputersEntry[] {
  const layout = actLayout(workspaceLayout(b, placed, section), own);
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
    if (may.newWorkspace) acts.push({ ...appAct(b, "new-workspace", "New workspace", "add folder"), twin: true });
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
  const layout = actLayout(machineLayout(b, machine, section), own);
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
  const layout = actLayout(gatewayLayout(b, gateway, section), own);
  return gatewayActs(b, gateway).map((act) =>
    actEntry(b, act, gateway.key, own ? act.label : act.phrase, layout),
  );
}

// ---- New and the app --------------------------------------------------------

/** An action of the host itself, which opens a form or changes the app. */
function appAct(b: Builder, action: AppActionId, label: string, keywords: string): Act {
  return {
    id: action,
    label,
    phrase: label,
    icon: "add",
    keywords,
    detached: true,
    run: () => b.ctx.bridge.run({ target: "app", action }),
  };
}

/** The new terminal a list of every machine offers: this machine's. A
 * devserver's is on its own page. */
function localTerminalAct(b: Builder): Act | undefined {
  const local = b.model.machines.find((machine) => machine.kind === "local");
  const terminal = local && machineActs(b, local).find((act) => act.id === "new-terminal");
  return local && terminal
    ? { ...terminal, keywords: `shell ${local.name} ${local.search ?? ""}` }
    : undefined;
}

interface Created {
  entry: ComputersEntry;
  /** The type filter the row also closes. */
  filter: ComputersFilter;
}

function createEntries(b: Builder, section?: string): Created[] {
  const { may } = b.model;
  const rows: Created[] = [];
  const add = (filter: ComputersFilter, act: Act): void => {
    const layout = { section, breadcrumb: COMPUTERS_SECTIONS.create, scope: b.scopes[filter] };
    rows.push({ filter, entry: actEntry(b, act, undefined, act.label, layout) });
  };
  const terminal = localTerminalAct(b);
  if (terminal) add("windows", terminal);
  if (may.newWorkspace) add("workspaces", appAct(b, "new-workspace", "New workspace", "add folder"));
  if (may.addDevserver) add("machines", appAct(b, "add-devserver", "Add devserver", "new computer server"));
  if (may.addGateway) add("gateways", appAct(b, "add-gateway", "Add gateway", "new"));
  return rows;
}

/** The themes as rows, the current one checked. Choosing one keeps the deck
 * open on the list. A `leaf` is titled to read alone in a ranked list. */
function themeOptionEntries(b: Builder, desktop: ComputersDesktop, leaf: boolean): ComputersEntry[] {
  return THEMES.map((theme) => {
    const word = THEME_WORDS[theme];
    return {
      id: `computers:theme:${theme}`,
      title: leaf ? `${THEME_TITLE}: ${word}` : word,
      breadcrumb: leaf
        ? COMPUTERS_SECTIONS.desktop
        : `${COMPUTERS_SECTIONS.desktop} › ${THEME_TITLE}`,
      searchText: `${THEME_TITLE} ${word} appearance switch to ${theme} theme`,
      scope: b.scopes.machines,
      icon: b.ctx.icons[theme],
      checked: theme === desktop.theme,
      stays: true,
      run: () => b.ctx.bridge.run({ target: "app", action: "theme", theme }),
    };
  });
}

/** What the screen itself offers beside its objects: its Select mode, and on
 * Chan Desktop the app's theme and Quit. */
function screenEntries(b: Builder, sectioned: boolean): ComputersEntry[] {
  const { desktop, selecting } = b.model;
  const name = desktop ? COMPUTERS_SECTIONS.desktop : COMPUTERS_SECTIONS.screen;
  const layout: Layout = {
    section: sectioned ? name : undefined,
    breadcrumb: name,
    scope: b.scopes.machines,
  };
  const rows: ComputersEntry[] = [];
  if (desktop) {
    rows.push({
      id: "computers:theme",
      title: THEME_TITLE,
      breadcrumb: layout.breadcrumb,
      searchText: searchText(THEME_TITLE, layout, "appearance light dark switch"),
      scope: layout.scope,
      icon: b.ctx.icons[desktop.theme],
      section: layout.section,
      kind: "choice",
      value: THEME_WORDS[desktop.theme],
      next: [...b.base, THEME_PAGE],
    });
  }
  if (selecting !== undefined) {
    const select: Act = {
      ...appAct(b, "select", "Select", "select mode bulk turn on turn off remove"),
      icon: "select",
      toggle: true,
      value: selecting ? "on" : "off",
    };
    rows.push(actEntry(b, select, undefined, select.label, layout));
  }
  if (desktop) {
    const quit: Act = {
      ...appAct(b, "quit", "Quit", "exit app desktop"),
      icon: "quit",
      danger: true,
      confirm: {
        title: "Quit Chan Desktop?",
        message: "Local workspaces and terminal sessions will stop.",
        actionLabel: "Quit",
        danger: true,
      },
    };
    rows.push(actEntry(b, quit, undefined, quit.label, layout));
  }
  return rows;
}

/** A type of object as one row, which opens the type's page. */
function typeEntry(b: Builder, filter: ComputersFilter, section?: string): ComputersEntry {
  const title = FILTER_LABEL[filter];
  return {
    id: `computers:${TYPE_PAGE}:${filter}`,
    title,
    breadcrumb: COMPUTERS_SECTIONS.machines,
    searchText: title,
    scope: b.scopes[filter],
    icon: b.ctx.icons[FILTER_ICON[filter]],
    section,
    kind: "branch",
    next: [...b.base, ref(TYPE_PAGE, filter)],
  };
}

/** The way from a tree that holds one machine to the screen that holds every
 * one. */
function allComputersEntries(b: Builder, section?: string): ComputersEntry[] {
  if (!b.model.may.allComputers) return [];
  const act: Act = {
    ...appAct(b, "all-computers", "All computers...", "every machine devserver gateway screen"),
    icon: "computers",
  };
  const layout = { section, breadcrumb: COMPUTERS_SECTIONS.desktop, scope: b.scopes.machines };
  return [{ ...actEntry(b, act, undefined, act.label, layout), pinned: true }];
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
  appendOnce(rows, screenEntries(b, true));
  appendOnce(rows, allComputersEntries(b, COMPUTERS_SECTIONS.desktop));
  return rows;
}

function filterEntries(b: Builder, filter: ComputersFilter): ComputersEntry[] {
  const { model } = b;
  const rows: ComputersEntry[] = [];
  // A section named for a machine says where its rows are.
  const under = (machine: ComputersMachine): Builder => ({ ...b, quiet: machine.name });
  if (filter === "windows") {
    for (const machine of model.machines) {
      rows.push(...machineWindows(machine).map((placed) => windowEntry(under(machine), placed, machine.name)));
    }
    const waiting = COMPUTERS_SECTIONS.unplaced;
    rows.push(
      ...(model.unplaced ?? []).map((window) =>
        windowEntry({ ...b, quiet: waiting }, { window, machine: waiting }, waiting),
      ),
    );
  } else if (filter === "workspaces") {
    for (const machine of model.machines) {
      rows.push(...placeWorkspaces(machine).map((placed) => workspaceEntry(under(machine), placed, machine.name)));
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
  if (all) {
    rows.push(...screenEntries(b, false));
    // A theme is one step away by its own name.
    if (model.desktop) rows.push(...themeOptionEntries(b, model.desktop, true));
    rows.push(...allComputersEntries(b));
  }
  return rows;
}

// ---- Pages --------------------------------------------------------------------

type Page =
  | { kind: "machine"; machine: ComputersMachine }
  | { kind: "workspace"; placed: PlacedWorkspace }
  | { kind: "window"; placed: PlacedWindow }
  | { kind: "gateway"; gateway: ComputersGateway }
  | { kind: "type"; filter: ComputersFilter }
  | { kind: "theme"; desktop: ComputersDesktop };

function findPage(model: ComputersModel, part: string): Page | null {
  if (part === THEME_PAGE) return model.desktop ? { kind: "theme", desktop: model.desktop } : null;
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
  if (kind === TYPE_PAGE) {
    const filter = FILTERS.find((candidate) => candidate === key);
    return filter && (filter !== "gateways" || model.may.gateways) ? { kind, filter } : null;
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
    case "type":
      return FILTER_LABEL[page.filter];
    case "theme":
      return THEME_TITLE;
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
        // Under their workspace's name, its windows do not repeat it.
        ...workspaceWindows(placed).map(withoutContext).flatMap((window) => [
          windowEntry(b, window, section(COMPUTERS_SECTIONS.windows)),
          ...(searching ? windowActEntries(b, window, false) : []),
        ]),
      ];
    }
    case "window":
      return windowActEntries(b, page.placed, true, section(COMPUTERS_SECTIONS.actions));
    case "gateway":
      return gatewayActEntries(b, page.gateway, true, section(COMPUTERS_SECTIONS.actions));
    case "type":
      return searching ? searchEntries(b, page.filter) : filterEntries(b, page.filter);
    case "theme":
      return themeOptionEntries(b, page.desktop, false);
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
  const page = pages.at(-1);
  const quiet =
    page?.kind === "machine"
      ? page.machine.name
      : page?.kind === "workspace"
        ? page.placed.machine
        : model.machines.length === 1
          ? model.machines[0].name
          : undefined;
  const b: Builder = { model, ctx, scopes, base: path, quiet };
  const searching = view.query.trim() !== "";
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

/** The ways into the tree, for a list that holds other things beside it and
 * has no room for the tree itself: a new terminal on this machine, which is
 * one step, then one row per type of object the model holds, which opens
 * that type's page. Each row carries the one heading they share. */
export function computersEntryPoints(model: ComputersModel, ctx: ComputersContext): ComputersEntry[] {
  const section = COMPUTERS_SECTIONS.machines;
  const b: Builder = { model, ctx, scopes: ctx.scopes ?? COMPUTERS_TYPE_SCOPES, base: [] };
  const rows: ComputersEntry[] = [];
  const terminal = localTerminalAct(b);
  if (terminal) {
    rows.push(
      actEntry(b, terminal, undefined, terminal.label, {
        section,
        breadcrumb: section,
        scope: b.scopes.windows,
      }),
    );
  }
  if (everyWorkspace(model).length > 0) rows.push(typeEntry(b, "workspaces", section));
  if (everyWindow(model).length > 0) rows.push(typeEntry(b, "windows", section));
  return rows;
}

/** The rail of a deck that lists Computers alone: one orb per type of object
 * the host holds. */
export function computersScopes(
  model: ComputersModel,
  icons: ComputersContext["icons"],
  scopes: ComputersScopeIds = COMPUTERS_TYPE_SCOPES,
): DeckScope[] {
  return FILTERS.filter((filter) => filter !== "gateways" || model.may.gateways).map((filter) => ({
    id: scopes[filter],
    label: FILTER_LABEL[filter],
    icon: icons[FILTER_ICON[filter]],
  }));
}

/** The filter a scope id names, or null for none of them. */
export function computersFilter(
  scope: string | null,
  scopes: ComputersScopeIds = COMPUTERS_TYPE_SCOPES,
): ComputersFilter | null {
  return FILTERS.find((filter) => scopes[filter] === scope) ?? null;
}
