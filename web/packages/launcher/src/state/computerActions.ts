// Computers action adapter for the inline command launcher. It delegates to the
// same state/backend owners as the machine cards, preserving browser-vs-native
// ownership, leader claims, native trust, and live-terminal confirmation.

import type { DevserverEntry, WindowRecord, WorkspaceEntry } from "../api/library";
import { liveTerminalsCount } from "../api/library";
import {
  connectDevserver,
  focusWindow,
  grantNativeTrustAndConnect,
  openDevserverTerminal,
  openDevserverWorkspace,
  openTerminal,
  openWorkspaceWindow,
  reportError,
  setDevserverWorkspaceOn,
  toggleWindow,
  toggleWorkspace,
} from "./library.svelte";
import { requestConfirm } from "./confirm.svelte";
import { hasDesktopBridge, selfManagedWindows } from "./capabilities";
import { canActOnTenant, ownsTenantLeader, tenantLeader } from "./leadership.svelte";
import { mintWindow, openWindowRecord, toggleWindowVisibility } from "./windowManager.svelte";

const NATIVE_TRUST_MESSAGE =
  "This shared devserver controls the web content in its Chan windows. Native access can read and write your clipboard, read files you select, save downloads, control Chan windows, and open links in your system browser. Grant access only if you trust its owner.";

export function actingFor(prefix: string): string | undefined {
  return ownsTenantLeader(prefix) ? (tenantLeader(prefix) ?? undefined) : undefined;
}

async function runAndReport(action: Promise<void>): Promise<void> {
  try {
    await action;
  } catch (error) {
    reportError(error);
  }
}

export async function connectComputer(devserver: DevserverEntry): Promise<void> {
  if (!devserver.native_trust_required) {
    await connectDevserver(devserver.id);
    return;
  }
  requestConfirm({
    title: "Grant native access?",
    message: NATIVE_TRUST_MESSAGE,
    confirmLabel: "Grant native access",
    onConfirm: () => runAndReport(grantNativeTrustAndConnect(devserver.id)),
  });
}

export async function newTerminal(devserver?: DevserverEntry): Promise<void> {
  if (devserver) {
    await openDevserverTerminal(devserver.id);
    return;
  }
  if (selfManagedWindows) {
    await mintWindow("terminal");
    return;
  }
  await openTerminal();
}

export async function newWorkspaceWindow(workspace: WorkspaceEntry): Promise<void> {
  if (workspace.devserver_id) {
    await openDevserverWorkspace(workspace.devserver_id, workspace.path);
    return;
  }
  if (selfManagedWindows) {
    await mintWindow("workspace", {
      workspacePath: workspace.path,
      actingWindowId: actingFor(workspace.prefix),
    });
    return;
  }
  await openWorkspaceWindow(workspace.path);
}

export function canOpenWorkspaceWindow(workspace: WorkspaceEntry): boolean {
  return !selfManagedWindows || canActOnTenant(workspace.prefix);
}

async function setWorkspaceOn(workspace: WorkspaceEntry, on: boolean, force = false): Promise<void> {
  if (workspace.devserver_id) {
    await setDevserverWorkspaceOn(workspace.devserver_id, workspace.prefix, on, force);
    return;
  }
  await toggleWorkspace(workspace.workspace_id, on, force);
}

export async function setWorkspacePower(workspace: WorkspaceEntry, on: boolean): Promise<void> {
  if (on) {
    await setWorkspaceOn(workspace, true);
    return;
  }
  try {
    await setWorkspaceOn(workspace, false);
  } catch (error) {
    const count = liveTerminalsCount(error);
    if (count === null) throw error;
    requestConfirm({
      title: "Turn off workspace?",
      message: `${count} live terminal session${count === 1 ? "" : "s"} ${
        count === 1 ? "is" : "are"
      } still running. Turn off anyway?`,
      confirmLabel: "Turn off",
      onConfirm: () => runAndReport(setWorkspaceOn(workspace, false, true)),
    });
  }
}

export function canManageWindow(window: WindowRecord): boolean {
  return hasDesktopBridge || (selfManagedWindows && canActOnTenant(window.prefix));
}

/** Bring a window to the foreground on either owning SPA surface. */
export async function focusComputerWindow(window: WindowRecord): Promise<void> {
  if (hasDesktopBridge) {
    await focusWindow(window);
    return;
  }
  openWindowRecord(window);
  if (window.hidden) {
    await toggleWindowVisibility(window, actingFor(window.prefix));
  }
}

export async function setWindowShown(window: WindowRecord, shown: boolean): Promise<void> {
  if (!!window.hidden === !shown) return;
  if (hasDesktopBridge) {
    await toggleWindow(window);
    return;
  }
  await toggleWindowVisibility(window, actingFor(window.prefix));
}
