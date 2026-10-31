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
// library's own machine never lists it.

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

/** A connection card's title says where the tmux server runs, so a local run
 * and a remote one read apart: `on this machine` when the foreground that
 * printed the marker was tmux itself, else `from <command>` with the
 * foreground command the gate read (`ssh geekom`), or its program name when
 * the OS let no command line be read. A node whose record has not arrived
 * carries the bare command. */
export function tmuxCardTitle(entry: TmuxConnectionEntry | null): string {
  if (entry === null) return "tmux -CC";
  if (entry.origin.local) return "tmux -CC on this machine";
  return `tmux -CC from ${entry.origin.command || entry.origin.program}`;
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
  if (node.kind === "tmux") return tmuxCardTitle(node.tmux);
  return node.devserver ? devserverName(node.devserver) : "This machine";
}

/** The desktop overview keeps hidden, detached and not-yet-associated windows. */
export function windowOverview(tree: MachineTree): { window: WindowRecord; machine: string }[] {
  return [
    ...tree.machines.flatMap((node) => {
      const machine = machineName(node);
      return [...node.control, ...node.terminals, ...node.workspaces.flatMap((ws) => ws.windows), ...node.looseWindows]
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
    libraryId,
    control,
    terminals,
    workspaces,
    looseWindows,
    unopened: [],
  };
}

/** A tmux connection's node: the row its mark names as the control terminal
 * pinned first, its open windows as terminals, and the tmux windows the record
 * lists with no chan window as unopened rows. It has no workspace cards. */
function tmuxNode(
  connection: string,
  entry: TmuxConnectionEntry | null,
  rows: WindowRecord[],
): MachineNode {
  const control = rows.filter((w) => w.tmux?.control === true).sort(sortWindows);
  const terminals = rows.filter((w) => w.tmux?.control !== true).sort(sortWindows);
  const unopened = entry?.windows.filter((tw) => !tw.chan_window) ?? [];
  return {
    kind: "tmux",
    devserver: null,
    connection,
    tmux: entry,
    libraryId: entry?.library_id ?? rows[0]?.library_id ?? null,
    control,
    terminals,
    workspaces: [],
    looseWindows: [],
    unopened,
  };
}

/** The local connection first, then the rest by title, then by id so the
 * order is total; a node still waiting for its record sorts last. */
function compareTmuxNodes(a: MachineNode, b: MachineNode): number {
  const rank = (n: MachineNode): number => (n.tmux === null ? 2 : n.tmux.origin.local ? 0 : 1);
  return (
    rank(a) - rank(b) ||
    tmuxCardTitle(a.tmux).localeCompare(tmuxCardTitle(b.tmux)) ||
    (a.connection ?? "").localeCompare(b.connection ?? "")
  );
}

/** Total rows a machine card shows, summed across its disjoint buckets (control
 * + standalone terminals + per-workspace cards + loose, and a tmux node's
 * windows with no chan window yet). Orphans belong to no machine and are
 * excluded. Drives the machine card's count badge. */
export function machineWindowCount(node: MachineNode): number {
  return (
    node.control.length +
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

  const sortedDevservers = [...devservers].sort((a, b) =>
    devserverName(a).localeCompare(devserverName(b)),
  );
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
    tmuxNodes.push(tmuxNode(entry.connection, entry, tmuxRows.get(entry.connection) ?? []));
  }
  for (const [connection, rows] of tmuxRows) {
    if (!recorded.has(connection)) tmuxNodes.push(tmuxNode(connection, null, rows));
  }
  tmuxNodes.sort(compareTmuxNodes);
  machines.push(...tmuxNodes);

  const orphans: WindowRecord[] = [];
  for (const [libraryId, ws] of windowsByLibrary.entries()) {
    if (!claimed.has(libraryId)) orphans.push(...ws);
  }
  orphans.sort(sortWindows);

  return { machines, orphans };
}
