// The launcher's reactive view of the library: the workspace registry, the
// devserver registry, and the live window feed. Mutations go through the
// backend and re-list the affected registry so the UI matches the server of
// record; the window feed updates from the watch subscription.

import { backend } from "../api/backend";
import type {
  DevserverEntry,
  DevserverInput,
  GatewayEntry,
  GatewayInput,
  WindowRecord,
  WorkspaceEntry,
} from "../api/library";
import { selfManagedWindows } from "./capabilities";
import { pushLocalError } from "./notices.svelte";
import { beginPending, clearPending, dsKey, reconcile, servedKey, wsKey } from "./pending.svelte";
import { closeWindowRecord, reconcileWindows } from "./windowManager.svelte";

interface LibraryState {
  workspaces: WorkspaceEntry[];
  devservers: DevserverEntry[];
  gateways: GatewayEntry[];
  windows: WindowRecord[];
  // Per-tenant leadership from the watch feed: prefix -> leader window_id. Empty
  // (leaderless) when the tenant has no live leader. Correlated against this
  // launcher's window handles to gate leader-only create controls.
  leaders: Record<string, string>;
  loading: boolean;
  error: string | null;
}

export const library = $state<LibraryState>({
  workspaces: [],
  devservers: [],
  gateways: [],
  windows: [],
  leaders: {},
  loading: false,
  error: null,
});

let unwatch: (() => void) | null = null;
let removeVisibilityResync: (() => void) | null = null;
let workspacePoll: ReturnType<typeof setInterval> | null = null;
const WORKSPACE_POLL_MS = 2000;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Surface a failed action as a corner notice bubble. Components catch their
 * action rejections and route them here; the throwing actions stay uniform
 * (so bulk loops can count per-item failures). `library.error` keeps the last
 * error as state for callers that inspect it. */
export function reportError(e: unknown): void {
  library.error = errorText(e);
  pushLocalError(errorText(e));
}

export function clearError(): void {
  library.error = null;
}

// Build the per-row status map the pending bridge reconciles against (the same
// keys the action handlers + the spinner UI use), then drop any bridge marker
// whose row's status has moved off its pre-click state (the backend transition
// landed), is gone, or has backstopped. Called after every registry refresh +
// on loadLibrary, so once the backend `status` arrives it drives the spinner.
// A devserver waiting on a browser sign-in reports the synthetic
// "pending_signin" state: its wire status stays `disconnected` (waiting is a
// row state, not a connection state), but the bridge must read the hand-off
// as a state move so the click marker clears the moment the waiting row
// appears instead of spinning out its backstop.
function reconcilePending(): void {
  const current: Record<string, string> = {};
  for (const w of library.workspaces) {
    const key = w.devserver_id === null ? wsKey(w.workspace_id) : servedKey(w.devserver_id, w.prefix);
    current[key] = w.status;
  }
  for (const d of library.devservers) {
    current[dsKey(d.id)] = d.pending_signin ? "pending_signin" : d.status;
  }
  reconcile(current);
}

function ensureWindowFeed(): void {
  if (unwatch) return;
  try {
    unwatch = backend.watchWindows((set) => {
      library.windows = set.windows;
      library.leaders = set.leaders ?? {};
      // On a self-managed surface, reconcile the window.open handle map against
      // the feed (close handles for discarded records, flag orphans). Inert on
      // desktop (bridge-driven, no browser-origin records) and in the demo.
      if (selfManagedWindows) reconcileWindows(set);
      // The feed also fires on workspace mount/unmount (chan open / on / off),
      // on a devserver connect/disconnect (its windows enter/leave + its
      // served-workspace rows merge in/out, and its `connected` flag flips),
      // and on every gateway mutation (the desktop signals the library change
      // on add/remove/connect/cascade/roster diff), so re-fetch all three
      // registries to reflect the new state live.
      void refreshWorkspacesLive();
      void refreshDevserversLive();
      void refreshGatewaysLive();
    });
  } catch {
    // The window feed is best-effort: a host without WebSocket or a failed
    // connection must not break loading the registries.
  }
  installVisibilityResync();
  startWorkspacePolling();
}

/** Load both registries and subscribe to the window feed (idempotent watch). */
export async function loadLibrary(): Promise<void> {
  library.loading = true;
  library.error = null;
  // Start the window feed before registry restoration. Local terminal creation
  // uses the window API and should remain responsive while workspace listing is
  // slow or rebuilding.
  ensureWindowFeed();
  try {
    const [workspaces, devservers, gateways] = await Promise.all([
      backend.listWorkspaces(),
      backend.listDevservers(),
      backend.listGateways(),
    ]);
    library.workspaces = workspaces;
    library.devservers = devservers;
    library.gateways = gateways;
    // On mount/reload: clear any persisted marker the real state already
    // satisfies (the op finished while we were away), so the spinner picks up
    // the latest state and only survives for rows still genuinely in-flight.
    reconcilePending();
  } catch (e) {
    reportError(e);
  } finally {
    library.loading = false;
  }
}

export function stopWatching(): void {
  unwatch?.();
  unwatch = null;
  removeVisibilityResync?.();
  removeVisibilityResync = null;
  stopWorkspacePolling();
}

/** Re-read the authoritative registries (best-effort, coalesced). The launcher
 * runs this when it regains visibility/focus so a change missed while the window
 * was hidden (the desktop hides, not destroys, the launcher) or the feed socket
 * blipped is corrected with no user action -- the client-side resync of the world
 * the redesign calls for, with no new server endpoint. */
export function resync(): void {
  void refreshWorkspacesLive();
  void refreshDevserversLive();
  void refreshGatewaysLive();
}

// Resync whenever the launcher becomes visible / focused again. The window feed's
// reconnect already heals a dropped socket; this additionally covers a frame
// missed while the socket was alive and the time the launcher spent hidden.
function installVisibilityResync(): void {
  if (removeVisibilityResync || typeof document === "undefined") return;
  const onVisible = (): void => {
    if (document.visibilityState === "visible") resync();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", resync);
  removeVisibilityResync = () => {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", resync);
  };
}

function startWorkspacePolling(): void {
  if (workspacePoll !== null || typeof document === "undefined") return;
  workspacePoll = setInterval(() => {
    if (document.visibilityState === "visible") void refreshWorkspacesLive();
  }, WORKSPACE_POLL_MS);
  (workspacePoll as { unref?: () => void }).unref?.();
}

function stopWorkspacePolling(): void {
  if (workspacePoll === null) return;
  clearInterval(workspacePoll);
  workspacePoll = null;
}

async function refreshWorkspaces(): Promise<void> {
  library.workspaces = await backend.listWorkspaces();
  reconcilePending();
}

// The live re-fetch the window-watch feed drives. The feed pushes a full
// snapshot on every window change, so bursts are coalesced: while a re-fetch
// is in flight, a later push just flags one more run, and the in-flight call
// re-runs once when it lands. No timer, so nothing leaks between tests, and a
// transient list error is swallowed -- the next push (or a manual reload) heals.
let liveRefreshing = false;
let liveRefreshPending = false;

async function refreshWorkspacesLive(): Promise<void> {
  if (liveRefreshing) {
    liveRefreshPending = true;
    return;
  }
  liveRefreshing = true;
  try {
    do {
      liveRefreshPending = false;
      library.workspaces = await backend.listWorkspaces();
    } while (liveRefreshPending);
    reconcilePending();
  } catch {
    // Best-effort: a failed live re-fetch must not tear down the feed.
  } finally {
    liveRefreshing = false;
  }
}

async function refreshDevservers(): Promise<void> {
  library.devservers = await backend.listDevservers();
  reconcilePending();
}

// The live devserver re-fetch the window-watch feed drives, mirroring
// refreshWorkspacesLive: a connect/disconnect flips `connected` (Connect vs
// Disconnect) and changes which devservers' workspaces merge into the feed.
// Coalesced + best-effort for the same reasons (no leaked timer; a transient
// list error heals on the next push).
let liveDevserversRefreshing = false;
let liveDevserversRefreshPending = false;

async function refreshDevserversLive(): Promise<void> {
  if (liveDevserversRefreshing) {
    liveDevserversRefreshPending = true;
    return;
  }
  liveDevserversRefreshing = true;
  try {
    do {
      liveDevserversRefreshPending = false;
      library.devservers = await backend.listDevservers();
    } while (liveDevserversRefreshPending);
    reconcilePending();
  } catch {
    // Best-effort: a failed live re-fetch must not tear down the feed.
  } finally {
    liveDevserversRefreshing = false;
  }
}

async function refreshGateways(): Promise<void> {
  library.gateways = await backend.listGateways();
}

// The live gateway re-fetch the window-watch feed drives, mirroring
// refreshWorkspacesLive/refreshDevserversLive: the desktop signals the library
// change on every gateway mutation (add/remove/connect/cascade/roster diff).
// Coalesced + best-effort for the same reasons.
let liveGatewaysRefreshing = false;
let liveGatewaysRefreshPending = false;

export async function refreshGatewaysLive(): Promise<void> {
  if (liveGatewaysRefreshing) {
    liveGatewaysRefreshPending = true;
    return;
  }
  liveGatewaysRefreshing = true;
  try {
    do {
      liveGatewaysRefreshPending = false;
      library.gateways = await backend.listGateways();
    } while (liveGatewaysRefreshPending);
  } catch {
    // Best-effort: a failed live re-fetch must not tear down the feed.
  } finally {
    liveGatewaysRefreshing = false;
  }
}

export async function addLocalWorkspace(path: string, label?: string): Promise<void> {
  await backend.addLocalWorkspace(path, label);
  await refreshWorkspaces();
}

export async function toggleWorkspace(id: string, on: boolean, force?: boolean): Promise<void> {
  const key = wsKey(id);
  beginPending(key, on ? "on" : "off");
  try {
    await backend.setWorkspaceOn(id, on, force);
  } catch (e) {
    clearPending(key); // stop the spinner; the error surfaces / the confirm opens
    throw e;
  }
  await refreshWorkspaces(); // reconcile clears the marker once on/off has landed
}

export async function removeWorkspace(id: string): Promise<void> {
  await backend.removeWorkspace(id);
  await refreshWorkspaces();
}

/** Open the desktop's native folder picker for the New-Workspace Folder field;
 * returns the chosen absolute path, or null on cancel / a non-desktop surface.
 * Throws on a real error so the dialog can surface it. */
export async function pickFolder(): Promise<string | null> {
  return (await backend.pickFolder()) ?? null;
}

/** Add (no id) or edit (id) a devserver; an empty `token` on edit is unchanged unless cleared. */
export async function saveDevserver(input: DevserverInput, id?: string): Promise<void> {
  if (id) await backend.updateDevserver(id, input);
  else await backend.addDevserver(input);
  await refreshDevservers();
}

export async function removeDevserver(id: string): Promise<void> {
  await backend.removeDevserver(id);
  await refreshDevservers();
}

// The devserver bridge actions are desktop actions: a surface with no desktop
// bridge answers 409. They throw on failure (uniform with the workspace actions,
// so the bulk loop can count per-item failures); the per-row callers catch and
// route the error to the banner via reportError. Connect/disconnect re-list the
// devserver registry so the acting client's Connect/Disconnect flips at once
// (the watch push keeps it live for out-of-band changes); the window-minting
// actions (terminal / open) rely on the watch push alone.

/** Connect a devserver: the desktop runs its connect command and dials the URL.
 * Its windows + served workspaces then appear in the feed via the watch push. */
export async function connectDevserver(id: string): Promise<void> {
  const key = dsKey(id);
  beginPending(key, "connected");
  try {
    await backend.connectDevserver(id);
  } catch (e) {
    clearPending(key);
    throw e;
  }
  await refreshDevservers(); // reconcile clears the marker once connected
}

/** Grant a shared row native access, re-read the authoritative projection, then
 * connect. The ordering is security-sensitive: no pending/connect transition
 * begins until PUT succeeded and the row confirms consent persisted. */
export async function grantNativeTrustAndConnect(id: string): Promise<void> {
  await backend.grantDevserverNativeTrust(id);
  await refreshDevservers();
  const row = library.devservers.find((devserver) => devserver.id === id);
  if (!row || row.native_trust_required) {
    throw new Error("native trust did not persist for this devserver");
  }
  await connectDevserver(id);
}

/** Revoke a shared row's native access. DELETE waits for desktop teardown; the
 * re-list then restores the trust-required state and removes live content. */
export async function revokeDevserverNativeTrust(id: string): Promise<void> {
  await backend.revokeDevserverNativeTrust(id);
  await refreshDevservers();
}

/** Disconnect a devserver: its windows + served-workspace rows leave the feed;
 * the registry entry stays so Connect can redial. */
export async function disconnectDevserver(id: string): Promise<void> {
  const key = dsKey(id);
  beginPending(key, "disconnected");
  try {
    await backend.disconnectDevserver(id);
  } catch (e) {
    clearPending(key);
    throw e;
  }
  await refreshDevservers(); // reconcile clears the marker once disconnected
}

// The gateway actions mirror the devserver ones: uniform throws (bulk loops
// count per-item failures; per-row callers route errors to reportError), and
// an explicit re-list after each op so the acting client flips at once -- the
// watch push keeps it live for desktop-driven changes (sign-in landing,
// roster diffs, cascades).

/** Register a gateway by URL. Save just adds; the first Connect discovers,
 * signs in, and starts the roster poll. */
export async function addGateway(input: GatewayInput): Promise<void> {
  await backend.addGateway(input);
  await refreshGateways();
}

/** Rename a gateway (label only; the URL is identity and stays fixed --
 * remove + re-add changes the origin). The re-list also refreshes the
 * Computers rows' "via <gateway>" text, which derives from this registry. */
export async function updateGateway(id: string, input: GatewayInput): Promise<void> {
  await backend.updateGateway(id, input);
  await refreshGateways();
}

/** Remove a gateway: the desktop cascades its live connections and its
 * synthesized rows leave the feed. */
export async function removeGateway(id: string): Promise<void> {
  await backend.removeGateway(id);
  await refreshGateways();
}

/** Connect a gateway (desktop action, 409 with no bridge): discovery, the
 * account sign-in when needed, then the roster poll. */
export async function connectGateway(id: string): Promise<void> {
  await backend.connectGateway(id);
  await refreshGateways();
}

/** Disconnect a gateway (desktop action, 409 with no bridge): stops the poll
 * and cascades its roster devservers' connections. */
export async function disconnectGateway(id: string): Promise<void> {
  await backend.disconnectGateway(id);
  await refreshGateways();
}

/** Open a terminal window on a connected devserver. The window feed updates
 * through the watch subscription, so nothing to refresh here. */
export async function openDevserverTerminal(id: string): Promise<void> {
  await backend.openDevserverTerminal(id);
}

/** Open a standalone Files window on a connected devserver. The window feed
 * updates through the watch subscription, so nothing to refresh here. */
/** Open a window onto a connected devserver's served workspace by its remote
 * path. The window feed updates through the watch subscription. */
export async function openDevserverWorkspace(id: string, path: string): Promise<void> {
  await backend.openDevserverWorkspace(id, path);
}

/** Turn a connected devserver's served workspace on/off by its mounted prefix.
 * The merged workspace rows refresh through the watch push (the desktop bridges
 * its workspace-cache change into the library change-signal). An unforced off of
 * a workspace with live terminals throws an `ApiError` the caller maps to a
 * confirm dialog (see `liveTerminalsCount`); `force` retries past it. */
export async function setDevserverWorkspaceOn(
  id: string,
  prefix: string,
  on: boolean,
  force?: boolean,
): Promise<void> {
  const key = servedKey(id, prefix);
  beginPending(key, on ? "on" : "off");
  try {
    await backend.setDevserverWorkspaceOn(id, prefix, on, force);
  } catch (e) {
    clearPending(key); // stop the spinner; a 409 live-terminal opens the confirm
    throw e;
  }
  // Re-list now rather than wait on the watch push alone: a dropped feed would
  // otherwise strand the served row's marker until the 10s backstop. reconcile
  // clears it once the served row flips; the watch push keeps it live thereafter.
  await refreshWorkspaces();
}

/** Forget (unmount + drop) a connected devserver's served workspace by prefix. */
export async function forgetDevserverWorkspace(
  id: string,
  prefix: string,
  force?: boolean,
): Promise<void> {
  await backend.forgetDevserverWorkspace(id, prefix, force);
}

/** Mint a new terminal window of the local library. The window feed updates
 * itself through the watch subscription, so there is nothing to refresh here. */
export async function openTerminal(): Promise<void> {
  await backend.createWindow("terminal");
}

/** Open a window onto an on workspace: mint a workspace window of the local
 * library (the desktop embed focuses an existing one for the same path). The
 * window feed updates through the watch subscription, so nothing to refresh. */
export async function openWorkspaceWindow(path: string): Promise<void> {
  await backend.createWindow("workspace", { workspacePath: path });
}

/** Toggle a window's visibility (the feed's SHOW/HIDE Eye): hide it if it is
 * visible, otherwise open (un-hide/focus) it. Keyed on the server-persisted
 * `hidden`, not socket liveness -- the toggle stays a bridge op
 * (`hideWindow`/`openWindow`); the desktop persists `hidden` at the bury/unbury
 * chokepoint, so the row moves between Open/Hidden on the feed round-trip. No
 * optimistic flip here -- the feed reflects the live state after the watch push. */
export async function toggleWindow(w: WindowRecord): Promise<void> {
  if (w.hidden) await backend.openWindow(w.window_id);
  else await backend.hideWindow(w.window_id);
}

/** Focus a window (the feed's FOCUS action): openWindow focuses a live window
 * and un-hides + focuses a buried one (it is the only un-hide op), matching the
 * desired focus behavior either way. The feed updates through the watch push, so
 * there is nothing to refresh here. */
export async function focusWindow(w: WindowRecord): Promise<void> {
  await backend.openWindow(w.window_id);
}

/** Persist the optional user caption shown after a non-control window's
 * generated label. The watch feed supplies the canonical trimmed value. */
export async function saveWindowLabel(
  w: WindowRecord,
  label: string,
  actingWindowId?: string,
): Promise<void> {
  await backend.setWindowLabel(w.window_id, label, actingWindowId);
}

/** Permanently close one window from the Computers command launcher. Desktop
 * surfaces retain the native live-terminal confirmation; self-managed surfaces
 * discard through the leader-gated web operation. */
export async function closeWindow(w: WindowRecord, actingWindowId?: string): Promise<void> {
  if (selfManagedWindows) {
    await closeWindowRecord(w, { actingWindowId });
    return;
  }
  await backend.closeWindow(w.window_id);
}
