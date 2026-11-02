// The desktop red-dot close-confirm state. When the OS close button is pressed
// on a live workspace/terminal window, the host prevents the close and evals an
// `app.window.confirmClose` into the webview; the SPA opens a 3-way Hide / Close
// / Cancel overlay off this state. A promise-returning module mirroring
// `draftCloseState` / `resolveDraftClose`: the overlay's buttons resolve the
// choice, and a second open resolves the prior prompt as a cancel (the window
// stayed open, so the earlier ask is moot). The asks the prompt's Hide and
// Close make of the desktop live here too: every other way the page hides or
// closes its window makes the same ask, and each first writes the tabs'
// unsaved input to the recovery buffer. The desktop refuses to hide or close
// chan's last shown window while terminals would end with it; the prompt then
// stays up and shows why.

import {
  closeWindowRefusal,
  hideWindowFromCloseConfirm,
  isTauriDesktop,
  requestCloseWindow,
} from "../api/desktop";
import { setTransientStatus } from "./store.svelte";
import { flushEditsToRecovery } from "./tabs.svelte";

export type CloseConfirmChoice = "hide" | "close" | "cancel";

export const closeConfirmState = $state<{
  open: boolean;
  resolve: ((choice: CloseConfirmChoice) => void) | null;
  /// Why the desktop refused the choice just made, shown on the prompt
  /// until it closes; `null` while nothing was refused.
  refusal: string | null;
}>({
  open: false,
  resolve: null,
  refusal: null,
});

/// Open the close-confirm overlay and resolve when the user picks Hide / Close /
/// Cancel. A pending prompt from an earlier red-dot resolves as "cancel" first
/// so it never leaks its resolver (the window is still open, so cancel is the
/// truthful outcome for the superseded ask).
export function uiCloseConfirm(): Promise<CloseConfirmChoice> {
  return new Promise((resolve) => {
    closeConfirmState.resolve?.("cancel");
    closeConfirmState.resolve = resolve;
    closeConfirmState.refusal = null;
    closeConfirmState.open = true;
  });
}

/// Close the overlay and resolve the pending prompt with the chosen action.
/// Idempotent: a second call with no pending resolver is a no-op.
export function resolveCloseConfirm(choice: CloseConfirmChoice): void {
  const r = closeConfirmState.resolve;
  closeConfirmState.resolve = null;
  closeConfirmState.open = false;
  closeConfirmState.refusal = null;
  r?.(choice);
}

/// Cancel any pending close prompt when its window changes connection state.
/// Idempotent so both disconnect and reconnect transitions can call it.
export function cancelCloseConfirmForConnectionChange(): void {
  resolveCloseConfirm("cancel");
}

/// Write every tab's unsaved input to its recovery buffer, then ask the
/// desktop to bury this window. The prompt's Hide, the hide chord, the host's
/// hide command and the command deck's row all hide through here. The bury
/// closes a workspace window's webview, and the page cannot count on an
/// unload event then; a control terminal's window is hidden in place, where
/// the write costs nothing. Off the desktop only the write happens. Resolves
/// with why the desktop kept the window shown, which also goes to the status
/// bar so a hide from the chord or the command deck reads it, or with `null`.
export async function flushAndHideWindow(): Promise<string | null> {
  flushEditsToRecovery();
  const refusal = await hideWindowFromCloseConfirm();
  if (refusal) setTransientStatus(refusal);
  return refusal;
}

/// Write every tab's unsaved input to its recovery buffer, then ask the
/// desktop to close this window. The close-window command, the red dot's
/// ways to close and the command deck's row all close through here. With
/// `discard` the close also discards the window's session, which reaps its
/// terminals, and the desktop is asked first whether it refuses the close:
/// it does for chan's last shown window while terminals would end with
/// chan. A refusal discards and closes nothing, goes to the status bar and
/// is what this resolves with; `stillWanted` answering false once the
/// desktop has answered (a prompt cancelled meanwhile) also leaves the
/// window as it is. The discard waits for the answer because it cannot be
/// taken back. Without `discard` the caller has discarded already and the
/// close is not asked about: the red dot on a window with no tab or while
/// reconnecting. A window whose last tab has closed closes through
/// `closeEmptiedWindow` instead, each tab's own close having committed its
/// input or, under force, dropped it.
export async function flushAndCloseWindow(options?: {
  /// The caller's discard of the window's session (`discardWindowSession`
  /// with its options), run only once the desktop has not refused.
  discard: () => void;
  stillWanted?: () => boolean;
}): Promise<string | null> {
  flushEditsToRecovery();
  if (options) {
    const refusal = await closeWindowRefusal();
    if (options.stillWanted && !options.stillWanted()) return null;
    if (refusal) {
      setTransientStatus(refusal);
      return refusal;
    }
    options.discard();
  }
  if (isTauriDesktop()) void requestCloseWindow();
  return null;
}
