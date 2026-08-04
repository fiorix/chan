// The desktop red-dot close-confirm state. When the OS close button is pressed
// on a live workspace/terminal window, the host prevents the close and evals an
// `app.window.confirmClose` into the webview; the SPA opens a 3-way Hide / Close
// / Cancel overlay off this state. A promise-returning module mirroring
// `draftCloseState` / `resolveDraftClose`: the overlay's buttons resolve the
// choice, and a second open resolves the prior prompt as a cancel (the window
// stayed open, so the earlier ask is moot).

export type CloseConfirmChoice = "hide" | "close" | "cancel";

export const closeConfirmState = $state<{
  open: boolean;
  resolve: ((choice: CloseConfirmChoice) => void) | null;
}>({
  open: false,
  resolve: null,
});

/// Open the close-confirm overlay and resolve when the user picks Hide / Close /
/// Cancel. A pending prompt from an earlier red-dot resolves as "cancel" first
/// so it never leaks its resolver (the window is still open, so cancel is the
/// truthful outcome for the superseded ask).
export function uiCloseConfirm(): Promise<CloseConfirmChoice> {
  return new Promise((resolve) => {
    closeConfirmState.resolve?.("cancel");
    closeConfirmState.resolve = resolve;
    closeConfirmState.open = true;
  });
}

/// Close the overlay and resolve the pending prompt with the chosen action.
/// Idempotent: a second call with no pending resolver is a no-op.
export function resolveCloseConfirm(choice: CloseConfirmChoice): void {
  const r = closeConfirmState.resolve;
  closeConfirmState.resolve = null;
  closeConfirmState.open = false;
  r?.(choice);
}

/// Cancel any pending close prompt when its window changes connection state.
/// Idempotent so both disconnect and reconnect transitions can call it.
export function cancelCloseConfirmForConnectionChange(): void {
  resolveCloseConfirm("cancel");
}
