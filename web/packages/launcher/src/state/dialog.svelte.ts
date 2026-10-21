// The New-workspace / devserver / gateway dialog's open/choice/edit state.
// Context-anchored entry points open it pre-set to a choice: the LOCAL
// [new workspace] button opens "local", the bottom "Add devserver" button
// opens "devserver", the Gateways screen's "Add gateway" button opens
// "gateway". There is no in-dialog chooser. The devserver body doubles as the
// edit form, prefilled from `editing` (null = add a new one); the gateway
// body doubles as the rename form, prefilled from `editingGateway` (the URL
// is identity and renders fixed); local is add-only.

import type { DevserverEntry, GatewayEntry } from "../api/library";

export type DialogChoice = "local" | "devserver" | "gateway";

interface DialogState {
  open: boolean;
  choice: DialogChoice;
  editing: DevserverEntry | null;
  editingGateway: GatewayEntry | null;
  initialFocus: boolean;
  opener: HTMLElement | null;
}

export const dialog = $state<DialogState>({
  open: false,
  choice: "local",
  editing: null,
  editingGateway: null,
  initialFocus: true,
  opener: null,
});

export function openNewDialog(choice: DialogChoice = "local", options: { initialFocus?: boolean } = {}): void {
  dialog.choice = choice;
  dialog.editing = null;
  dialog.editingGateway = null;
  dialog.initialFocus = options.initialFocus !== false;
  dialog.opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement : null;
  dialog.open = true;
}

export function openEditDevserver(ds: DevserverEntry): void {
  dialog.choice = "devserver";
  dialog.editing = ds;
  dialog.editingGateway = null;
  dialog.initialFocus = true;
  dialog.opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement : null;
  dialog.open = true;
}

export function openEditGateway(gw: GatewayEntry): void {
  dialog.choice = "gateway";
  dialog.editing = null;
  dialog.editingGateway = gw;
  dialog.initialFocus = true;
  dialog.opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement : null;
  dialog.open = true;
}

export function closeDialog(): void {
  dialog.open = false;
  dialog.opener = null;
  dialog.editing = null;
  dialog.editingGateway = null;
  dialog.initialFocus = true;
}
