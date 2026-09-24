// Gmail-style multi-select for the registry lists. ONE selection spans four
// kinds -- local workspaces, served (devserver-mounted) workspaces,
// devservers, and gateways (selected on the Gateways screen; flipping screens
// clears the selection) -- feeding ONE global bulk bar (rendered App-level
// above the lists). Bulk turn on/off loops the per-kind singular op (the ops
// are independent + idempotent, so no bulk endpoints are needed); bulk remove
// runs an ORDERED cross-kind delete (remove local -> forget served -> remove
// devservers -> remove gateways LAST, so a gateway's synthesized rows are
// gone before their source is). Served rows carry their owning `devserverId`
// so the delete is self-sufficient and immune to the live window-watch
// re-fetch dropping a row mid-bulk. Partial failures are counted and
// surfaced; the per-row quick actions stay the single-item path; remove is
// bulk-only (behind selection + a confirm).

import { unactionable, workspaceCondition, type WorkspaceEntry } from "../api/library";
import {
  connectDevserver,
  connectGateway,
  disconnectDevserver,
  disconnectGateway,
  forgetDevserverWorkspace,
  library,
  removeDevserver,
  removeGateway,
  removeWorkspace,
  setDevserverWorkspaceOn,
  toggleWorkspace,
} from "./library.svelte";

/** The four selectable registry kinds, all feeding the one global bulk bar. */
export type SelKind = "workspace" | "served" | "devserver" | "gateway";

/** A selected row, keyed by (kind, id, devserverId) so ids never collide across
 * kinds (a local workspace_id, a served prefix, and a devserver id), and two
 * devservers serving the same mount prefix stay distinct. A served row carries
 * `devserverId` = its owning devserver and `id` = the mount prefix, so the
 * ordered delete + bulk on/off route to the remote without re-deriving anything
 * from the (live-re-fetched) list. For the other kinds `devserverId` is unset. */
interface SelItem {
  kind: SelKind;
  id: string;
  devserverId?: string;
}

interface SelectionState {
  /** Gmail-style select mode: while on, the registry rows reveal their
   * checkboxes. Entered/left from the top-bar Select toggle; leaving clears the
   * selection so no stale check or highlight lingers. */
  selectMode: boolean;
  /** Selected rows across all kinds. A plain array -- deeply reactive under
   * $state (a bare Set would need svelte/reactivity's SvelteSet to track). */
  selected: SelItem[];
  /** A bulk action is running (disables the bar briefly). */
  busy: boolean;
  /** The single global bulk bar is awaiting its delete-confirm. */
  confirmingDelete: boolean;
  /** Last bulk-action outcome, surfaced briefly (e.g. partial failures). */
  note: string | null;
}

export const selection = $state<SelectionState>({
  selectMode: false,
  selected: [],
  busy: false,
  confirmingDelete: false,
  note: null,
});

/** Whether the rows reveal their selection checkboxes: in select mode, or
 * whenever something is already selected (so a live selection is never orphaned
 * behind hidden checks). Drives both the per-row checkbox gate and the bottom
 * bulk bar's visibility. */
export function checksVisible(): boolean {
  return selection.selectMode || selection.selected.length > 0;
}

/** Enter/leave select mode. Leaving clears the selection and any pending
 * delete-confirm so no stale check, highlight, or confirm survives the exit. */
export function setSelectMode(on: boolean): void {
  selection.selectMode = on;
  if (!on) {
    selection.selected = [];
    selection.confirmingDelete = false;
    selection.note = null;
  }
}

export function toggleSelectMode(): void {
  setSelectMode(!selection.selectMode);
}

function indexOf(kind: SelKind, id: string, devserverId?: string): number {
  return selection.selected.findIndex(
    (s) => s.kind === kind && s.id === id && s.devserverId === devserverId,
  );
}

export function isSelected(kind: SelKind, id: string, devserverId?: string): boolean {
  return indexOf(kind, id, devserverId) >= 0;
}

/** How many rows are selected: one kind's slice, or the whole selection (no arg
 * → the global bar's combined count). */
export function selectedCount(kind?: SelKind): number {
  return kind
    ? selection.selected.filter((s) => s.kind === kind).length
    : selection.selected.length;
}

export function toggleSelected(kind: SelKind, id: string, devserverId?: string): void {
  const i = indexOf(kind, id, devserverId);
  if (i >= 0) selection.selected.splice(i, 1);
  else selection.selected.push({ kind, id, devserverId });
  // Cancel a pending delete-confirm if the selection changed under it.
  selection.confirmingDelete = false;
  selection.note = null;
}

/** Clear one kind's selection, or every selection (no arg). A full clear also
 * leaves select mode, so it doubles as the exit path. */
export function clearSelection(kind?: SelKind): void {
  selection.selected = kind ? selection.selected.filter((s) => s.kind !== kind) : [];
  selection.confirmingDelete = false;
  selection.note = null;
  if (!kind) selection.selectMode = false;
}

/** Loop a singular op over a snapshot of selected items, counting per-item
 * failures (the ops throw uniformly across the library actions, so a per-item
 * catch keeps the loop going). Returns the items that FAILED; the caller decides
 * what stays selected. Iterating the snapshot (not the live list) keeps a bulk
 * run immune to the window-watch re-fetch mutating `library.*` mid-loop. */
async function runBulk(
  items: SelItem[],
  op: (item: SelItem) => Promise<void>,
): Promise<SelItem[]> {
  const failures: SelItem[] = [];
  for (const item of items) {
    try {
      await op(item);
    } catch {
      failures.push(item);
    }
  }
  return failures;
}

/** A row no lifecycle action may touch: another Chan process holds the mount,
 * or whether one does could not be read. The classifier owns which statuses
 * those are, so this answer moves with it instead of carrying its own copy of
 * the wire strings; a row the live re-fetch has already dropped is not held by
 * anyone here. */
function unactionableMount(row: WorkspaceEntry | undefined): boolean {
  return row !== undefined && unactionable(row.status);
}

function workspaceRow(item: SelItem): WorkspaceEntry | undefined {
  if (item.kind === "workspace") {
    return library.workspaces.find((w) => w.devserver_id === null && w.workspace_id === item.id);
  }
  if (item.kind === "served") {
    return library.workspaces.find((w) => w.devserver_id === item.devserverId && w.prefix === item.id);
  }
  return undefined;
}

function lockedWorkspace(item: SelItem): boolean {
  return unactionableMount(workspaceRow(item));
}

/** A skipped row whose lock could not be read. Nobody is known to hold it, so
 * the note counts it apart from the rows another process holds. */
function lockUnknownWorkspace(item: SelItem): boolean {
  const row = workspaceRow(item);
  return row !== undefined && workspaceCondition(row.status) === "unknown";
}

/** The skip counts are taken when the run starts, from the rows it left alone:
 * the live re-fetch can move a row's status while the run is in flight. */
function bulkNote(
  verb: string,
  total: number,
  failures: SelItem[],
  skippedLocked: number,
  skippedUnknown: number,
): string | null {
  const parts: string[] = [];
  if (failures.length > 0) parts.push(`${failures.length} of ${total} failed to ${verb}`);
  if (skippedLocked > 0) {
    parts.push(`${skippedLocked} locked workspace${skippedLocked === 1 ? "" : "s"} skipped`);
  }
  if (skippedUnknown > 0) {
    parts.push(
      `${skippedUnknown} workspace${skippedUnknown === 1 ? "" : "s"} with an unknown lock state skipped`,
    );
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

/** Bulk turn on/off across every selected kind: a local workspace toggles its
 * tenant, a served workspace toggles on its owning devserver, a devserver
 * connects/disconnects. Bulk-off stays a fail-safe -- an unforced off that 409s
 * (live terminals) just counts as a failure; never a per-item confirm, never a
 * force-kill. The single-row Off confirm is where that
 * path lives. */
export async function bulkSetOnAll(on: boolean): Promise<void> {
  if (selection.busy) return;
  const items = [...selection.selected];
  if (items.length === 0) return;
  selection.busy = true;
  selection.note = null;
  const skipped = items.filter(lockedWorkspace);
  const skippedUnknown = skipped.filter(lockUnknownWorkspace).length;
  const active = items.filter((item) => !lockedWorkspace(item));
  // Exhaustive per-kind dispatch (no catch-all arm): a new SelKind fails the
  // compile here instead of silently riding another kind's op.
  const failures = await runBulk(active, (item) => {
    switch (item.kind) {
      case "workspace":
        return toggleWorkspace(item.id, on);
      case "served":
        return setDevserverWorkspaceOn(item.devserverId!, item.id, on);
      case "devserver":
        return on ? connectDevserver(item.id) : disconnectDevserver(item.id);
      case "gateway":
        return on ? connectGateway(item.id) : disconnectGateway(item.id);
    }
  });
  selection.busy = false;
  const verb = on ? "turn on" : "turn off";
  selection.note = bulkNote(
    verb,
    items.length,
    failures,
    skipped.length - skippedUnknown,
    skippedUnknown,
  );
}

export function requestBulkDelete(): void {
  if (selection.selected.length > 0) selection.confirmingDelete = true;
}

export function cancelBulkDelete(): void {
  selection.confirmingDelete = false;
}

/** Ordered cross-kind bulk remove (the order is deliberate):
 *   1. Remove selected LOCAL workspaces.
 *   2. Forget every selected SERVED workspace while its devserver connection is
 *      still present.
 *   3. Remove selected DEVSERVERS -- `reg.remove`'s `on_remove` hook reaps the
 *      live connection + windows.
 *   4. Remove selected GATEWAYS LAST -- the desktop cascade tears down their
 *      roster devservers' connections, so any selected rows they own are
 *      handled before their source goes.
 * Succeeded rows drop from the selection; failures stay so the count reflects
 * what is left. */
export async function confirmBulkDelete(): Promise<void> {
  if (selection.busy) return;
  const served = selection.selected.filter((s) => s.kind === "served");
  const devservers = selection.selected.filter((s) => s.kind === "devserver");
  const locals = selection.selected.filter((s) => s.kind === "workspace");
  const gateways = selection.selected.filter((s) => s.kind === "gateway");
  const total = served.length + devservers.length + locals.length + gateways.length;
  if (total === 0) {
    selection.confirmingDelete = false;
    return;
  }
  selection.busy = true;
  selection.note = null;
  const skipped = selection.selected.filter(lockedWorkspace);
  const skippedUnknown = skipped.filter(lockUnknownWorkspace).length;
  const failures: SelItem[] = [];
  failures.push(...(await runBulk(locals.filter((s) => !lockedWorkspace(s)), (s) => removeWorkspace(s.id))));
  failures.push(
    ...(await runBulk(served.filter((s) => !lockedWorkspace(s)), (s) =>
      forgetDevserverWorkspace(s.devserverId!, s.id),
    )),
  );
  failures.push(...(await runBulk(devservers, (s) => removeDevserver(s.id))));
  failures.push(...(await runBulk(gateways, (s) => removeGateway(s.id))));
  selection.busy = false;
  selection.confirmingDelete = false;
  // Keep only the failures/skips selected (succeeded rows drop); surface the count.
  selection.selected = [...failures, ...skipped];
  selection.note = bulkNote(
    "remove",
    total,
    failures,
    skipped.length - skippedUnknown,
    skippedUnknown,
  );
}
