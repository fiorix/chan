// The "closed / hidden by the leader" state for THIS window.
//
// The session leader can discard or hide a follower's window from the launcher.
// The server pushes a targeted window_command (window_discarded / window_hidden)
// to the affected window's /ws socket; store.svelte.ts routes it here. The SPA
// then shows a terminal SessionEndedOverlay so a torn-down window does not sit
// as a stale, silently-dead view. A native desktop window is reconciled away by
// the watcher instead and never reaches this path.

export type WindowEndedKind = "discarded" | "hidden";

export const windowLifecycle = $state<{ ended: WindowEndedKind | null }>({ ended: null });

/** This window was discarded by the leader (its record is gone server-side). */
export function markWindowDiscarded(): void {
  windowLifecycle.ended = "discarded";
}

/** This window was hidden by the leader (its record persists, hidden). A discard
 * is terminal, so never downgrade it to hidden. */
export function markWindowHidden(): void {
  if (windowLifecycle.ended === "discarded") return;
  windowLifecycle.ended = "hidden";
}

/** A shown record removes only the hidden cover; a discard stays terminal. */
export function clearWindowHidden(): void {
  if (windowLifecycle.ended === "hidden") windowLifecycle.ended = null;
}

/** Whether a leader-teardown overlay is showing. The instance-change auto-reload
 * reads this to avoid rebooting a torn-down window into an empty layout. */
export function isWindowEnded(): boolean {
  return windowLifecycle.ended !== null;
}

/** Test reset. */
export function __resetWindowLifecycle(): void {
  windowLifecycle.ended = null;
}
