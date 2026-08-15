// Pure, DOM-free grouping of the library feed into the machine-first tree the
// launcher renders: LOCAL plus each devserver as an equal top-level machine that
// owns its windows (control terminal first, then standalone terminals, then
// per-workspace windows nested in their workspace cards). No Svelte, no reactive
// state -- all inputs are passed in, so it is exhaustively unit-testable.
//
// Join keys (mirroring the wire):
//   machine -> windows:    WindowRecord.library_id  (local library id | DevserverEntry.library_id)
//   machine -> workspaces: WorkspaceEntry.devserver_id  (null for local)
//   workspace -> windows:  same library_id AND workspace_path === WorkspaceEntry.path
//
// Buckets are DISJOINT: every window lands in exactly one of control / terminals
// / a workspace card / loose / orphan, so no window_id repeats inside a keyed
// {#each} (a repeat throws Svelte each_key_duplicate and freezes the tree).

import type { DevserverEntry, WindowRecord, WorkspaceEntry } from "../api/library";
import { LOCAL_LIBRARY_ID } from "./windowLabel";

/** Order windows within a machine: the connect control terminal pinned FIRST,
 * then standalone terminals before workspace windows, then by ordinal. */
export function sortWindows(a: WindowRecord, b: WindowRecord): number {
  if (a.control !== b.control) return a.control ? -1 : 1;
  const rank = (w: WindowRecord): number => (w.kind === "terminal" ? 0 : 1);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  return a.ordinal - b.ordinal;
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

// ---- The machine tree (nested) ------------------------------------------

export interface WorkspaceNode {
  ws: WorkspaceEntry;
  windows: WindowRecord[];
  count: number;
}

export interface MachineNode {
  kind: "local" | "devserver";
  /** The devserver entry for a remote machine; null for LOCAL. */
  devserver: DevserverEntry | null;
  /** Host-local library id, or the devserver's library_id (null before first connect). */
  libraryId: string | null;
  control: WindowRecord[];
  /** Every window of the shared standalone terminal tenant. */
  terminals: WindowRecord[];
  workspaces: WorkspaceNode[];
  /** kind=workspace windows of this machine whose path matched no workspace card
   * (a transient race) -- rendered as loose rows so they never vanish. */
  looseWindows: WindowRecord[];
}

export interface MachineTree {
  machines: MachineNode[];
  /** Windows whose library_id matches no machine -- an unsynced control terminal
   * minted before its devserver's library id resolves -- kept in a fallback
   * block so a first-connect window never disappears. */
  orphans: WindowRecord[];
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
      if (samePath(w.workspace_path, ws.path)) wins.push(w);
    }
    for (const w of wins) remaining.delete(w.window_id);
    wins.sort(sortWindows);
    return { ws, windows: wins, count: wins.length };
  });
  const looseWindows = [...remaining.values()].sort(sortWindows);
  return { kind, devserver, libraryId, control, terminals, workspaces, looseWindows };
}

/** Total windows a machine owns, summed across its disjoint buckets (control +
 * standalone terminals + per-workspace cards + loose). Orphans belong to no
 * machine and are excluded. Drives the machine card's collapse count badge. */
export function machineWindowCount(node: MachineNode): number {
  return (
    node.control.length +
    node.terminals.length +
    node.workspaces.reduce((sum, w) => sum + w.count, 0) +
    node.looseWindows.length
  );
}

/** Build the machine-first tree: LOCAL first, then each devserver sorted by name.
 * Each machine owns its windows (control / terminals / per-workspace) and its
 * workspace cards; windows of an unknown library land in `orphans`. */
export function buildMachineTree(
  devservers: DevserverEntry[],
  workspaces: WorkspaceEntry[],
  windows: WindowRecord[],
): MachineTree {
  const windowsByLibrary = new Map<string, WindowRecord[]>();
  for (const w of dedupeWindows(windows)) {
    const arr = windowsByLibrary.get(w.library_id) ?? [];
    arr.push(w);
    windowsByLibrary.set(w.library_id, arr);
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
    if (ds.library_id) claimed.add(ds.library_id);
    machines.push(
      machineNode(
        "devserver",
        ds,
        ds.library_id,
        windowsByLibrary,
        workspaces.filter((w) => w.devserver_id === ds.id),
      ),
    );
  }

  const orphans: WindowRecord[] = [];
  for (const [libraryId, ws] of windowsByLibrary.entries()) {
    if (!claimed.has(libraryId)) orphans.push(...ws);
  }
  orphans.sort(sortWindows);

  return { machines, orphans };
}
