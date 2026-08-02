// Dispatch for the desktop's devserver control attention events.
//
// A connected devserver can become temporarily unreachable while its CONTROL
// terminal is still alive. The desktop emits attention/restored events carrying
// the devserver id; the launcher turns the devserver identity row's
// machine icon red (and flashes the control row's eye), or restores them.
// Desktop-only: the driving event never fires in a plain browser.

import {
  clearControlAttentionForDevserver,
  markControlAttention,
} from "./controlAttention.svelte";

/** Pull the devserver id out of a desktop event payload. The desktop emits the
 * bare String id (Tauri serializes it as a JSON string); an `{ id }` object is
 * also tolerated. Returns null for an unrecognized payload. */
export function controlEventId(payload: unknown): string | null {
  if (typeof payload === "string") return payload || null;
  if (payload && typeof payload === "object") {
    const id = (payload as { id?: unknown }).id;
    if (typeof id === "string") return id || null;
  }
  return null;
}

/** Dispatch a raw `devserver-control-attention` payload: flash the control row's
 * eye for attention. */
export function onControlAttentionEvent(payload: unknown): void {
  const id = controlEventId(payload);
  if (id) markControlAttention(id);
}

/** Dispatch a raw `devserver-control-restored` payload: clear the control row's
 * attention flash. */
export function onControlRestoredEvent(payload: unknown): void {
  const id = controlEventId(payload);
  if (id) clearControlAttentionForDevserver(id);
}
