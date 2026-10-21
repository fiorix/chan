// A generic single-confirm dialog the launcher routes destructive/irreversible
// actions through (WKWebView blocks native window.confirm). One request is open
// at a time: `requestConfirm` stores the message + the action to run on Confirm;
// `ConfirmDialog.svelte` renders the in-SPA Modal while open. Confirm awaits the
// stored action (the `busy` flag disables the buttons meanwhile) then closes;
// Cancel closes without running it.

interface ConfirmState {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  busy: boolean;
  opener: HTMLElement | null;
}

export const confirm = $state<ConfirmState>({
  open: false,
  title: "Confirm",
  message: "",
  confirmLabel: "Confirm",
  busy: false,
  opener: null,
});

// The action to run on Confirm, captured per request. May be async; its
// rejection propagates to the caller of resolveConfirm (so the trigger site can
// surface a retry failure in the error banner).
let onConfirm: (() => void | Promise<void>) | null = null;

export interface ConfirmRequest {
  title?: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
}

export function requestConfirm(req: ConfirmRequest): void {
  confirm.title = req.title ?? "Confirm";
  confirm.message = req.message;
  confirm.confirmLabel = req.confirmLabel ?? "Confirm";
  confirm.busy = false;
  onConfirm = req.onConfirm;
  confirm.opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement : null;
  confirm.open = true;
}

/** Run the stored action, then close. Re-entrancy-guarded by `busy`. The action's
 * rejection propagates so the trigger site can route it to the error banner. */
export async function resolveConfirm(): Promise<void> {
  if (confirm.busy) return;
  const action = onConfirm;
  confirm.busy = true;
  try {
    await action?.();
  } finally {
    close();
  }
}

export function cancelConfirm(): void {
  close();
}

function close(): void {
  confirm.open = false;
  confirm.opener = null;
  confirm.busy = false;
  onConfirm = null;
}
