// Pure, DOM-free grouping of the library feed into the machine-first tree the
// launcher renders: LOCAL, each devserver and each tmux control-mode connection
// as an equal top-level machine that owns its windows (control terminal first,
// then standalone terminals, then per-workspace windows nested in their
// workspace cards). No Svelte, no reactive state -- all inputs are passed in,
// so it is exhaustively unit-testable.
//
// Join keys (mirroring the wire):
//   machine -> windows:    WindowRecord.library_id  (local library id | DevserverEntry.library_id)
//   connection -> windows: WindowRecord.tmux.connection  (TmuxConnectionEntry.connection)
//   machine -> workspaces: WorkspaceEntry.devserver_id  (null for local)
//   workspace -> windows:  same library_id AND workspace_path === WorkspaceEntry.path
//
// Buckets are DISJOINT: every window lands in exactly one of control / terminals
// / a workspace card / loose / orphan, so no window_id repeats inside a keyed
// {#each} (a repeat throws Svelte each_key_duplicate and freezes the tree). A
// tmux row goes to its connection's node before any library lookup, so the
// library's own machine never lists it in those buckets. The one exception is
// a connection's control terminal, which its machine's node also carries in
// `tmuxControls`, a list of its own that no flattened view reads (see
// `TmuxControlRow`).

import type {
  DevserverEntry,
  TmuxConnectionEntry,
  TmuxWindowEntry,
  WindowRecord,
  WorkspaceEntry,
} from "../api/library";
import { LOCAL_LIBRARY_ID } from "./windowLabel";

/** Order windows within a machine: the connect control terminal pinned FIRST,
 * then standalone terminals before workspace windows, then by ordinal, and
 * finally by window id. The last key is what makes the order TOTAL: ordinals
 * are per-(kind, workspace), so two rows from different workspaces -- or from
 * different libraries in the orphan bucket -- can hold the same one, and
 * without a tiebreak their relative order would follow whatever order the feed
 * happened to arrive in. */
export function sortWindows(a: WindowRecord, b: WindowRecord): number {
  if (a.control !== b.control) return a.control ? -1 : 1;
  if (a.kind !== b.kind) return a.kind === "terminal" ? -1 : 1;
  if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
  return a.window_id.localeCompare(b.window_id);
}

/** Drop a duplicated window_id (defense against Svelte each_key_duplicate, which
 * freezes a keyed {#each} on a repeated key). Keeps the first occurrence; the
 * window_id is the library's stable reconciliation key, so this is global. */
export function dedupeWindows(windows: WindowRecord[]): WindowRecord[] {
  const seen = new Set<string>();
  const out: WindowRecord[] = [];
  for (const w of windows) {
    if (seen.has(w.window_id)) continue;
    seen.add(w.window_id);
    out.push(w);
  }
  return out;
}

function devserverName(ds: DevserverEntry): string {
  return ds.label || `${ds.host}:${ds.port}`;
}

/** Trailing-slash-tolerant path match (workspace_path vs a workspace root). */
function samePath(a: string | null, b: string): boolean {
  if (!a) return false;
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/** Devserver rows by name: the order in which the tree gives each library's
 * windows to the first row that names it. */
function byName(devservers: DevserverEntry[]): DevserverEntry[] {
  return [...devservers].sort((a, b) => devserverName(a).localeCompare(devserverName(b)));
}

/** The row whose card owns a library's windows. The local card claims its
 * library before any devserver row, then devservers claim in name order. */
export function devserverForLibrary(
  libraryId: string,
  devservers: DevserverEntry[],
  localLibraryId: string,
): DevserverEntry | null {
  if (libraryId === localLibraryId) return null;
  return byName(devservers).find((ds) => ds.library_id === libraryId) ?? null;
}

/** The name of the devserver whose terminal runs a connection: the first row
 * by name whose card holds the record's library. Null for a connection on
 * this machine, and while no row knows the devserver's library id yet. */
export function tmuxHost(
  entry: TmuxConnectionEntry | null,
  devservers: DevserverEntry[],
  localLibraryId: string,
): string | null {
  if (entry === null) return null;
  const host = devserverForLibrary(entry.library_id, devservers, localLibraryId);
  return host ? devserverName(host) : null;
}

/** A connection card's title says where the tmux server runs, so a local run
 * and a remote one read apart. The library that runs the terminal calls a
 * foreground of tmux itself local, so a local run is `on this machine` in
 * this machine's terminal and `on <devserver>` in a devserver's (`host`, as
 * `tmuxHost` reads it). A carrier's run is `from <command>` with the foreground
 * command the gate read (`ssh geekom`), or its program name when the OS let
 * no command line be read. A node whose record has not arrived carries the
 * bare command. */
export function tmuxCardTitle(entry: TmuxConnectionEntry | null, host: string | null): string {
  if (entry === null) return "tmux -CC";
  if (entry.origin.local) return `tmux -CC on ${host ?? "this machine"}`;
  return `tmux -CC from ${entry.origin.command || entry.origin.program}`;
}

/** A tmux window's machine in a list of every machine's windows (All windows,
 * the command launcher): the card's title and the tmux session, since two
 * connections on one machine share a title and only the card shows the
 * session. The title alone until tmux announces the session. */
export function tmuxWindowMachine(entry: TmuxConnectionEntry | null, host: string | null): string {
  const title = tmuxCardTitle(entry, host);
  const session = entry?.session?.name;
  return session ? `${title} (${session})` : title;
}

// ---- The machine tree (nested) ------------------------------------------

export interface WorkspaceNode {
  ws: WorkspaceEntry;
  windows: WindowRecord[];
  count: number;
}

export interface MachineNode {
  kind: "local" | "devserver" | "tmux";
  /** The devserver entry for a remote machine; null for LOCAL and a tmux node. */
  devserver: DevserverEntry | null;
  /** A tmux node's connection id (its control session's id); null otherwise. */
  connection: string | null;
  /** A tmux node's record; null while its rows arrived before the record. */
  tmux: TmuxConnectionEntry | null;
  /** The devserver whose terminal runs a tmux node's connection, by name;
   * null on this machine and for every other node. */
  tmuxHost: string | null;
  /** Host-local library id, or the devserver's library_id (null before first connect). */
  libraryId: string | null;
  control: WindowRecord[];
  /** Every window of the shared standalone terminal tenant, or a tmux node's
   * open windows. */
  terminals: WindowRecord[];
  workspaces: WorkspaceNode[];
  /** kind=workspace windows of this machine whose path matched no workspace card
   * (a transient race) -- rendered as loose rows so they never vanish. */
  looseWindows: WindowRecord[];
  /** A tmux node's windows past the cap, with no chan window yet: rows with
   * no record, shown hidden; show asks the connection to open them. */
  unopened: TmuxWindowEntry[];
  /** The control terminals of the tmux connections run in this machine's
   * terminals, in the connections' card order; empty on a tmux node. */
  tmuxControls: TmuxControlRow[];
}

/** A tmux connection's control terminal as the card of the machine whose
 * terminal ran `tmux -CC` lists it. Running it buries that terminal, and the
 * user looks for the terminal on the machine where they ran it, so
 * the control terminal is the one window two cards list: its connection's
 * card, which lists every window of the connection, and its machine's. The
 * connection's other windows stay on the connection's card alone. The
 * command launcher's window list reads the disjoint buckets and never this
 * list, so it lists the window once; All windows leaves it out
 * (`windowOverview`). */
export interface TmuxControlRow {
  window: WindowRecord;
  /** The connection's own node: its id is what the row's detach names, and
   * its title tells two connections on one machine apart. */
  node: MachineNode;
}

export interface MachineTree {
  machines: MachineNode[];
  /** Windows whose library_id matches no machine -- an unsynced control terminal
   * minted before its devserver's library id resolves -- kept in a fallback
   * block so a first-connect window never disappears. */
  orphans: WindowRecord[];
}

/** What a machine card is called: This machine, the devserver's name, or the
 * tmux connection's title. */
export function machineName(node: MachineNode): string {
  if (node.kind === "tmux") return tmuxCardTitle(node.tmux, node.tmuxHost);
  return node.devserver ? devserverName(node.devserver) : "This machine";
}

/** A machine as a row in a list of every machine's windows names it, ahead of
 * the row's workspace: `local` for this machine, the name the desktop's
 * window titles give it, so a row reads `local / chan` as the window's title
 * does; a devserver and a tmux connection by their card's name. The card
 * itself stays This machine. */
function windowMachineName(node: MachineNode): string {
  if (node.kind === "tmux") return tmuxWindowMachine(node.tmux, node.tmuxHost);
  return node.devserver ? devserverName(node.devserver) : "local";
}

/** The desktop overview keeps hidden, detached and not-yet-associated windows.
 * It leaves out a tmux connection's buried control terminal, which offers no
 * action of its own while the connection runs and which its connection's card
 * and its machine's card already list; once the connection ends the library
 * clears the mark and the overview lists it as a plain window. */
export function windowOverview(tree: MachineTree): { window: WindowRecord; machine: string }[] {
  return [
    ...tree.machines.flatMap((node) => {
      const machine = windowMachineName(node);
      return [...node.control, ...node.terminals, ...node.workspaces.flatMap((ws) => ws.windows), ...node.looseWindows]
        .filter((window) => window.tmux?.control !== true)
        .sort(sortWindows)
        .map((window) => ({ window, machine }));
    }),
    ...tree.orphans.map((window) => ({ window, machine: "Connecting" })),
  ];
}

function machineNode(
  kind: "local" | "devserver",
  devserver: DevserverEntry | null,
  libraryId: string | null,
  windowsByLibrary: Map<string, WindowRecord[]>,
  machineWorkspaces: WorkspaceEntry[],
): MachineNode {
  const windows = (libraryId ? windowsByLibrary.get(libraryId) : undefined) ?? [];
  const control = windows.filter((w) => w.control).sort(sortWindows);
  const terminals = windows.filter((w) => !w.control && w.kind === "terminal").sort(sortWindows);
  // Consume workspace windows as they are assigned so each lands in exactly one
  // card (or loose), keeping the buckets disjoint even if two cards shared a path.
  const remaining = new Map(
    windows.filter((w) => !w.control && w.kind === "workspace").map((w) => [w.window_id, w]),
  );
  const workspaces: WorkspaceNode[] = machineWorkspaces.map((ws) => {
    const wins: WindowRecord[] = [];
    for (const w of remaining.values()) {
      if (samePath(w.workspace_path ?? null, ws.path)) wins.push(w);
    }
    for (const w of wins) remaining.delete(w.window_id);
    wins.sort(sortWindows);
    return { ws, windows: wins, count: wins.length };
  });
  const looseWindows = [...remaining.values()].sort(sortWindows);
  return {
    kind,
    devserver,
    connection: null,
    tmux: null,
    tmuxHost: null,
    libraryId,
    control,
    terminals,
    workspaces,
    looseWindows,
    unopened: [],
    tmuxControls: [],
  };
}

/** A tmux connection's node: the row its mark names as the control terminal
 * pinned first, its open windows as terminals, and the tmux windows the record
 * lists with no chan window as unopened rows. It has no workspace cards. */
function tmuxNode(
  connection: string,
  entry: TmuxConnectionEntry | null,
  rows: WindowRecord[],
  devservers: DevserverEntry[],
  localLibraryId: string,
): MachineNode {
  const control = rows.filter((w) => w.tmux?.control === true).sort(sortWindows);
  const terminals = rows.filter((w) => w.tmux?.control !== true).sort(sortWindows);
  const unopened = entry?.windows.filter((tw) => !tw.chan_window) ?? [];
  return {
    kind: "tmux",
    devserver: null,
    connection,
    tmux: entry,
    tmuxHost: tmuxHost(entry, devservers, localLibraryId),
    libraryId: entry?.library_id ?? rows[0]?.library_id ?? null,
    control,
    terminals,
    workspaces: [],
    looseWindows: [],
    unopened,
    tmuxControls: [],
  };
}

/** The node of the machine whose terminal runs a connection's tmux client,
 * read from the record's library: This machine for the local library, or the
 * devserver card that holds the library's windows. A carrier's run (`ssh host
 * tmux -CC`) counts too, since its control terminal is that machine's terminal
 * wherever the tmux server runs. Null while the record has not arrived, and
 * while no card holds the record's library yet. */
function tmuxMachine(entry: TmuxConnectionEntry | null, machines: MachineNode[]): MachineNode | null {
  if (entry === null) return null;
  return machines.find((m) => m.kind !== "tmux" && m.libraryId === entry.library_id) ?? null;
}

/** The connections on this machine first, then the rest by title, then by id
 * so the order is total; a node still waiting for its record sorts last. */
function compareTmuxNodes(a: MachineNode, b: MachineNode): number {
  const rank = (n: MachineNode): number =>
    n.tmux === null ? 2 : n.tmux.origin.local && n.tmuxHost === null ? 0 : 1;
  return (
    rank(a) - rank(b) ||
    machineName(a).localeCompare(machineName(b)) ||
    (a.connection ?? "").localeCompare(b.connection ?? "")
  );
}

/** Total rows a machine card shows, summed across its disjoint buckets (control
 * + standalone terminals + per-workspace cards + loose, and a tmux node's
 * windows with no chan window yet) and the control terminals of the tmux
 * connections run in its terminals. Orphans belong to no machine and are
 * excluded. Drives the machine card's count badge. */
export function machineWindowCount(node: MachineNode): number {
  return (
    node.control.length +
    node.tmuxControls.length +
    node.terminals.length +
    node.workspaces.reduce((sum, w) => sum + w.count, 0) +
    node.looseWindows.length +
    node.unopened.length
  );
}

/** Build the machine-first tree: LOCAL first, then each devserver sorted by
 * name, then each tmux connection. Each machine owns its windows (control /
 * terminals / per-workspace) and its workspace cards; windows of an unknown
 * library land in `orphans`. */
export function buildMachineTree(
  devservers: DevserverEntry[],
  workspaces: WorkspaceEntry[],
  windows: WindowRecord[],
  tmuxConnections: TmuxConnectionEntry[] = [],
): MachineTree {
  const windowsByLibrary = new Map<string, WindowRecord[]>();
  // A tmux row belongs to its connection's card whatever library runs it, so
  // it never reaches the library's machine.
  const tmuxRows = new Map<string, WindowRecord[]>();
  for (const w of dedupeWindows(windows)) {
    const byKey = w.tmux ? tmuxRows : windowsByLibrary;
    const key = w.tmux ? w.tmux.connection : w.library_id;
    const arr = byKey.get(key) ?? [];
    arr.push(w);
    byKey.set(key, arr);
  }

  const machines: MachineNode[] = [];
  const localWorkspaces = workspaces.filter((w) => w.devserver_id === null);
  const localLibraryId =
    localWorkspaces.find((w) => w.library_id !== null)?.library_id ??
    // Headless-devserver first boot can have a persisted terminal before any
    // workspace rows exist. With no devserver registry on that surface, the
    // only window library is the host-local library.
    (devservers.length === 0 && windowsByLibrary.size === 1
      ? [...windowsByLibrary.keys()][0]
      : LOCAL_LIBRARY_ID);
  const claimed = new Set<string>([localLibraryId]);

  machines.push(
    machineNode(
      "local",
      null,
      localLibraryId,
      windowsByLibrary,
      localWorkspaces,
    ),
  );

  const sortedDevservers = byName(devservers);
  for (const ds of sortedDevservers) {
    // Two rows can resolve to one library: a directly registered devserver and
    // its gateway roster row, or a box registered twice. Every machine claiming
    // the id would otherwise be handed the same WindowRecord objects, and the
    // deck flattens machine windows into one keyed list, so the window would be
    // a duplicate key there. The first claimant keeps the windows; a later row
    // still renders as its own machine, with none.
    const alreadyClaimed = ds.library_id !== null && claimed.has(ds.library_id);
    if (ds.library_id) claimed.add(ds.library_id);
    machines.push(
      machineNode(
        "devserver",
        ds,
        alreadyClaimed ? null : ds.library_id,
        windowsByLibrary,
        workspaces.filter((w) => w.devserver_id === ds.id),
      ),
    );
  }

  // One node per connection record, keyed by the connection id (a repeated
  // record keeps its first copy, so the keyed deck never sees an id twice),
  // and one for rows whose record has not arrived, so no tmux row waits in
  // orphans.
  const tmuxNodes: MachineNode[] = [];
  const recorded = new Set<string>();
  for (const entry of tmuxConnections) {
    if (recorded.has(entry.connection)) continue;
    recorded.add(entry.connection);
    tmuxNodes.push(
      tmuxNode(entry.connection, entry, tmuxRows.get(entry.connection) ?? [], devservers, localLibraryId),
    );
  }
  for (const [connection, rows] of tmuxRows) {
    if (!recorded.has(connection)) tmuxNodes.push(tmuxNode(connection, null, rows, devservers, localLibraryId));
  }
  tmuxNodes.sort(compareTmuxNodes);
  // Each connection is one node and each control row one connection's (the
  // feed and the records are deduplicated above), so a machine's list holds
  // a control terminal once.
  for (const node of tmuxNodes) {
    const machine = tmuxMachine(node.tmux, machines);
    if (machine) machine.tmuxControls.push(...node.control.map((window) => ({ window, node })));
  }
  machines.push(...tmuxNodes);

  const orphans: WindowRecord[] = [];
  for (const [libraryId, ws] of windowsByLibrary.entries()) {
    if (!claimed.has(libraryId)) orphans.push(...ws);
  }
  orphans.sort(sortWindows);

  return { machines, orphans };
}
