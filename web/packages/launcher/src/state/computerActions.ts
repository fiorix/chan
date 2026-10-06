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
  openDevserverTerminal,
  openDevserverWorkspace,
  openTerminal,
  openWorkspaceWindow,
  reportError,
  setDevserverWorkspaceOn,
  toggleWindow,
  toggleWorkspace,
  windowLiveTerminalCount,
} from "./library.svelte";
import { requestConfirm } from "./confirm.svelte";
import { hasDesktopBridge, selfManagedWindows } from "./capabilities";
import { actingFor, canActOnTenant } from "./leadership.svelte";
import {
  mintWindow,
  openWindowRecord,
  toggleWindowVisibility,
} from "./windowManager.svelte";

const NATIVE_TRUST_MESSAGE =
  "This shared devserver controls the web content in its Chan windows. Native access can read and write your clipboard, read files you select, save downloads, control Chan windows, and open links in your system browser. Grant access only if you trust its owner.";

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

/** Bring an addressable window to the foreground. Native `openWindow` focuses
 * a visible window and un-hides a buried one; a browser may focus only a
 * browser-origin record through its named popup. */
export async function focusComputerWindow(window: WindowRecord): Promise<void> {
  if (hasDesktopBridge) {
    await focusWindow(window);
    return;
  }
  if (window.origin !== "browser") {
    throw new Error("Native focus is unavailable in this browser. Use Open in this browser.");
  }
  if (!(await openWindowRecord(window))) return;
  if (window.hidden) {
    await toggleWindowVisibility(window, actingFor(window.prefix));
  }
}

/** Explicitly acquire a browser page for a record without changing its visibility. */
export async function openComputerWindow(window: WindowRecord): Promise<void> {
  if (hasDesktopBridge) {
    await focusWindow(window);
    return;
  }
  await openWindowRecord(window);
}

export async function setWindowShown(window: WindowRecord, shown: boolean): Promise<void> {
  if (hasDesktopBridge) {
    if (!!window.hidden === !shown) return;
    await toggleWindow(window);
    return;
  }
  // chan-desktop owns a native record's window and opens it again once it is
  // shown, so a browser acquires only a browser record's window here.
  const repair = shown && window.origin === "browser" && !window.connected;
  if (repair && !(await openWindowRecord(window, { focus: false }))) return;
  if (!!window.hidden === !shown) return;
  await toggleWindowVisibility(window, actingFor(window.prefix));
}

export async function closeComputerWindow(window: WindowRecord): Promise<void> {
  await closeWindow(window, actingFor(window.prefix));
}

export async function liveTerminalCountForWindow(window: WindowRecord): Promise<number | null> {
  return windowLiveTerminalCount(window);
}
