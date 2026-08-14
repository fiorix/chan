// Shared Computers actions. The machine cards and command launcher both call
// these wrappers so browser-vs-native window ownership, leader claims, native
// trust, and live-terminal confirmation cannot drift between entry points.

import type { DevserverEntry, WindowRecord, WorkspaceEntry } from "../api/library";
import { liveTerminalsCount } from "../api/library";
import {
  closeWindow,
  connectDevserver,
  focusWindow,
  grantNativeTrustAndConnect,
  openDevserverFilesWindow,
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
import {
  mintWindow,
  openWindowRecord,
  toggleWindowVisibility,
} from "./windowManager.svelte";

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

/** Open a standalone Files window. On a connected devserver the desktop mints
 * it in that machine's own library and its watcher opens the native window; on
 * the LOCAL machine (the serving host) it is a browser-origin mint of a
 * terminal-kind record carrying the files app. Callers gate the affordance on
 * the capability the target machine advertises: the host meta locally, the
 * devserver's own report remotely. */
export async function newFilesWindow(devserver?: DevserverEntry): Promise<void> {
  if (devserver) {
    await openDevserverFilesWindow(devserver.id);
    return;
  }
  await mintWindow("terminal", { app: "files" });
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

/** Bring a window to the foreground on either owning surface. Native
 * `openWindow` focuses a visible window and un-hides a buried one. A
 * self-managed launcher must synchronously open/focus its named browser window
 * (to preserve the click's popup permission), then clear persisted hidden state. */
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

export async function closeComputerWindow(window: WindowRecord): Promise<void> {
  await closeWindow(window, actingFor(window.prefix));
}
