// Optimistic BRIDGE for the mutating registry actions (workspace on/off, served
// devserver-workspace on/off, devserver connect/disconnect). The AUTHORITATIVE
// spinner state is the backend lifecycle `status` each row now carries
// (`starting` / `connecting`); this store only bridges the brief gap between a
// click and the first refetch that lands that status, so a click gives instant
// button feedback before the backend's transition arrives.
//
// A reactive map of markers keyed per item, each recording the desired
// end-state (`target`) + a start timestamp (`ts`). A marker lives only until the
// next reconcile sees the row's status move off its pre-click state (the backend
// has begun the transition, so `status` takes over) -- or a short backstop
// elapses. It is in-memory only: a boot-restore re-mount reports `status:
// starting` straight from the backend, so the spinner appears with no persisted
// marker and no timer driving it.

/** Desired end-state a marker waits for. Workspaces use on/off; devservers use
 * connected/disconnected. */
export type PendingTarget = "on" | "off" | "connected" | "disconnected";

// The settled statuses a row can sit at BEFORE each target's transition. The
// bridge is held only while the row is still at one of them; once `status`
// moves off them (to the transitional `starting`/`connecting`, the target, or
// `error`), the backend `status` drives the spinner and the bridge is dropped.
// An off starts from either mounted status: a workspace whose root stopped
// being usable is still mounted, and its Turn off must bridge the click the
// same way a healthy row's does.
const FROM_OF: Record<PendingTarget, readonly string[]> = {
  on: ["stopped"],
  off: ["running", "unavailable"],
  connected: ["disconnected"],
  disconnected: ["connected"],
};

interface PendingEntry {
  target: PendingTarget;
  /** Epoch ms when the op began -- drives the backstop. */
  ts: number;
}

interface PendingState {
  /** Active markers keyed by `ws:{id}` / `served:{devserverId}:{prefix}` /
   * `ds:{id}`. A plain object -- deeply reactive under $state. */
  markers: Record<string, PendingEntry>;
}

// Backstop only: clear a marker the backend never moved (no transition arrived)
// so the bridge can't spin forever. Normal clearing is status-driven via
// reconcile, well before this; it is far shorter than a spinner timeout because
// it is not the spinner source.
const BRIDGE_TIMEOUT_MS = 10_000;

export const pending = $state<PendingState>({ markers: {} });

export const wsKey = (id: string): string => `ws:${id}`;
export const servedKey = (devserverId: string, prefix: string): string =>
  `served:${devserverId}:${prefix}`;
export const dsKey = (id: string): string => `ds:${id}`;

/** Whether the row keyed by `key` is mid-bridge (a click whose backend status
 * has not landed yet). Treats a backstopped marker as not-pending even before
 * reconcile deletes it, so a stale marker never spins. */
export function isPending(key: string): boolean {
  const e = pending.markers[key];
  if (!e) return false;
  return Date.now() - e.ts <= BRIDGE_TIMEOUT_MS;
}

/** Open the bridge on an action click: record target + start time, start the
 * spinner. Overwrites any prior marker for the same row. */
export function beginPending(key: string, target: PendingTarget): void {
  pending.markers[key] = { target, ts: Date.now() };
}

/** Clear a marker (on an action reject, before the refetch): stop the spinner. */
export function clearPending(key: string): void {
  if (key in pending.markers) {
    delete pending.markers[key];
  }
}

/** Clear every marker (test reset; also a hard reset if ever needed). */
export function clearAllPending(): void {
  pending.markers = {};
}

/** Reconcile bridge markers against the latest real state. `current` maps the
 * same keys to each row's live `status` string. A marker is dropped once its
 * row's status has moved off the pre-click state (the backend transition has
 * begun, so `status` drives the spinner), the row is gone, or the backstop has
 * elapsed; otherwise the bridge holds. Called after every registry refresh /
 * feed push and on loadLibrary (mount/reload). */
export function reconcile(current: Record<string, string>): void {
  const now = Date.now();
  for (const key of Object.keys(pending.markers)) {
    const entry = pending.markers[key]!;
    const cur = current[key];
    const held = cur !== undefined && FROM_OF[entry.target].includes(cur);
    if (!held || now - entry.ts > BRIDGE_TIMEOUT_MS) {
      delete pending.markers[key];
    }
  }
}
