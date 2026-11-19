// In-page confirm dialog state.
//
// `window.confirm()` is unreliable in Tauri/WebViews. Keeping this
// small state module separate lets shared state code request a modal
// without importing the main store and creating cycles.

type ConfirmState = {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive: boolean;
  resolve: ((value: boolean) => void) | null;
};

export const confirmState = $state<ConfirmState>({
  open: false,
  title: "",
  message: "",
  confirmLabel: "OK",
  cancelLabel: "Cancel",
  destructive: false,
  resolve: null,
});

// The element that held DOM focus before the modal opened. The modal
// parks focus on its default button, so restoring this on dismissal returns
// the caret to the invoking surface (terminal, editor) with no click.
let previouslyFocused: HTMLElement | null = null;

// Whether that element may take the keyboard back, as the keyboard's owner
// answers: it sets this when it loads (state/keyboardOwner.svelte.ts), so
// this module still imports nothing.
let mayRestore: (element: Element) => boolean = () => true;

/// Let the keyboard's owner answer whether a dismissal's restore may focus.
export function setConfirmRestoreGate(gate: (element: Element) => boolean): void {
  mayRestore = gate;
}

/// Show a confirm dialog. Resolves true on OK, false on Cancel / Esc /
/// outside-click. Pass `destructive: true` to default to Cancel and style
/// the OK button as a warning. Enter on a button activates it; elsewhere
/// in the panel it answers the default.
export function uiConfirm(opts: {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}): Promise<boolean> {
  // Capture the pre-modal focus target before the modal steals focus.
  // The `!open` guard makes a stacked confirm keep the ORIGINAL target:
  // the stacked open drops the prior confirm inline below (bypassing
  // resolveConfirm), so this capture must not overwrite the first one.
  if (!confirmState.open) {
    const active = document.activeElement;
    previouslyFocused =
      active instanceof HTMLElement && active !== document.body ? active : null;
  }
  return new Promise((resolve) => {
    // If a confirm is already open, drop the previous one as cancelled.
    confirmState.resolve?.(false);
    confirmState.title = opts.title;
    confirmState.message = opts.message ?? "";
    confirmState.confirmLabel = opts.confirmLabel ?? "OK";
    confirmState.cancelLabel = opts.cancelLabel ?? "Cancel";
    confirmState.destructive = opts.destructive ?? false;
    confirmState.resolve = resolve;
    confirmState.open = true;
  });
}

/// Called by the modal component on OK / Cancel.
export function resolveConfirm(value: boolean): void {
  const r = confirmState.resolve;
  confirmState.resolve = null;
  confirmState.open = false;
  // Restore focus to the pre-modal target before resolving, so any focus
  // work the awaiting caller runs (next-tab focus, restart rebuild) lands
  // after and wins. The isConnected guard skips targets the accept path
  // unmounts (tab close, terminal restart), which degrade to today's
  // behavior of focus falling to the body. A target the keyboard's owner
  // refuses (a survey over its terminal, an overlay, the Computers launcher)
  // is left alone, and the owner keeps the keyboard.
  const el = previouslyFocused;
  previouslyFocused = null;
  if (el?.isConnected && mayRestore(el)) el.focus({ preventScroll: true });
  r?.(value);
}
