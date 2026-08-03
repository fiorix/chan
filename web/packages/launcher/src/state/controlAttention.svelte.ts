// Devserver control terminals awaiting attention.
//
// When a connected devserver stops answering while its CONTROL terminal is still
// alive, the desktop emits `devserver-control-attention`. The launcher turns the
// devserver identity row's machine icon RED (the same icon is green while
// connected) and slow-flashes the control row's eye. Both clear when the desktop
// reports the connection restored, or when the user acts on the control row.
//
// Keyed by the devserver's LIBRARY id (the id the control window record carries)
// so the feed matches the flashing row directly. Desktop events carry the
// devserver id, resolved to its library id at mark time.

import { library } from "./library.svelte";

const CONTROL_WINDOW_PREFIX = "control-terminal-";
const PENDING_ATTENTION_MS = 30_000;

interface ControlAttentionState {
  // Library ids whose control terminal needs attention. A plain object so it is
  // deeply reactive under $state (a bare Set would need svelte/reactivity).
  libs: Record<string, true>;
  // Devserver ids that emitted before the launcher had enough registry/window
  // state to resolve their library id.
  pendingDevservers: Record<string, number>;
}

export const controlAttention = $state<ControlAttentionState>({
  libs: {},
  pendingDevservers: {},
});

function controlLibraryId(devserverId: string): string | null {
  // The desktop emits as soon as the control script exits; on a first connect
  // that can beat the devserver registry refresh that fills `library_id`.
  // The control row is already in the window feed under its real library id.
  const byControlWindow = library.windows.find(
    (w) => w.control && w.window_id === `${CONTROL_WINDOW_PREFIX}${devserverId}`,
  );
  if (byControlWindow) return byControlWindow.library_id;

  const ds = library.devservers.find((d) => d.id === devserverId);
  if (ds?.library_id) return ds.library_id;

  const direct = library.windows.find((w) => w.control && w.library_id === devserverId);
  return direct?.library_id ?? null;
}

/** Flag a devserver's control terminal for attention.
 * Resolves the devserver id to the library id the feed keys on, or queues it
 * briefly until the matching control-window row / devserver entry arrives. */
export function markControlAttention(devserverId: string): void {
  const libraryId = controlLibraryId(devserverId);
  if (libraryId) {
    controlAttention.libs[libraryId] = true;
    delete controlAttention.pendingDevservers[devserverId];
  } else {
    controlAttention.pendingDevservers[devserverId] = Date.now();
  }
}

/** Resolve any control-closed event that arrived before the launcher knew the
 * devserver's library id. Called from App's registry/window-feed reactive pass. */
export function resolvePendingControlAttention(): void {
  const now = Date.now();
  for (const [devserverId, ts] of Object.entries(controlAttention.pendingDevservers)) {
    if (now - ts > PENDING_ATTENTION_MS) {
      delete controlAttention.pendingDevservers[devserverId];
      continue;
    }
    const libraryId = controlLibraryId(devserverId);
    if (libraryId) {
      controlAttention.libs[libraryId] = true;
      delete controlAttention.pendingDevservers[devserverId];
    }
  }
}

/** Clear a library's control-attention (the user showed/focused the window, or
 * the devserver became responsive again). */
export function clearControlAttention(libraryId: string): void {
  if (libraryId in controlAttention.libs) delete controlAttention.libs[libraryId];
}

/** Clear attention by devserver id, resolving it to the current library id if
 * the launcher already knows it. */
export function clearControlAttentionForDevserver(devserverId: string): void {
  delete controlAttention.pendingDevservers[devserverId];
  const libraryId = controlLibraryId(devserverId);
  if (libraryId) clearControlAttention(libraryId);
}

/** Whether the control row of this library is awaiting attention. */
export function hasControlAttention(libraryId: string): boolean {
  return controlAttention.libs[libraryId] === true;
}

/** Drop attention flags whose library no longer owns a control window in the
 * feed. The feed is authoritative: while a control terminal is alive (a script
 * died and it sits at "process exited") its record is present, so its flag
 * survives (the identity icon stays red, the eye keeps flashing); once the
 * terminal is closed / reaped its record leaves the feed and the flag is
 * cleared here, so a torn-down or reconnected library does not leak a flag or
 * resurface a stale cue. Runs on the same reactive pass as
 * `resolvePendingControlAttention`. */
export function pruneControlAttention(): void {
  const live = new Set(library.windows.filter((w) => w.control).map((w) => w.library_id));
  for (const libraryId of Object.keys(controlAttention.libs)) {
    if (!live.has(libraryId)) delete controlAttention.libs[libraryId];
  }
}

/** Clear every attention flag (test reset; also a hard reset if ever needed). */
export function clearAllControlAttention(): void {
  controlAttention.libs = {};
  controlAttention.pendingDevservers = {};
}
