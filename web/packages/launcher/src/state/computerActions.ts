// Shared Computers actions. The machine cards and command launcher both call
// these wrappers so browser-vs-native window ownership, leader claims, native
// trust, and live-terminal confirmation cannot drift between entry points.

import type {
  DevserverEntry,
  GatewayEntry,
  TmuxWindowEntry,
  WindowRecord,
  WorkspaceEntry,
} from "../api/library";
import { liveTerminalsCount } from "../api/library";
import {
  closeWindow,
  connectDevserver,
  focusWindow,
  grantNativeTrustAndConnect,
  library,
  openDevserverTerminal,
  openDevserverWorkspace,
  openTerminal,
  openWorkspaceWindow,
  reportError,
  requestTmux,
  setDevserverWorkspaceOn,
  toggleWindow,
  toggleWorkspace,
  windowLiveTerminalCount,
} from "./library.svelte";
import { requestConfirm } from "./confirm.svelte";
import { hasDesktopBridge, selfManagedWindows } from "./capabilities";
import { showCard } from "./deck.svelte";
import { actingFor, canActOnTenant } from "./leadership.svelte";
import { showScreen } from "./screen.svelte";
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

/** Connect a devserver and open a terminal on it, for a caller that asked for
 * the terminal while the devserver was disconnected. A connect that handed
 * off to a browser sign-in resolves before the devserver is connected, and
 * its terminal waits for a later gesture. A devserver that asks for native
 * access first goes through `connectComputer`, whose dialog cannot be
 * chained. */
export async function connectAndOpenTerminal(devserver: DevserverEntry): Promise<void> {
  await connectDevserver(devserver.id);
  if (library.devservers.find((row) => row.id === devserver.id)?.pending_signin) return;
  await openDevserverTerminal(devserver.id);
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

async function mintWorkspaceWindow(workspace: WorkspaceEntry, startTerminal: boolean): Promise<void> {
  if (workspace.devserver_id) {
    await openDevserverWorkspace(workspace.devserver_id, workspace.path, startTerminal);
    return;
  }
  if (selfManagedWindows) {
    await mintWindow("workspace", {
      workspacePath: workspace.path,
      actingWindowId: actingFor(workspace.prefix),
      startTerminal,
    });
    return;
  }
  await openWorkspaceWindow(workspace.path, startTerminal);
}

export async function newWorkspaceWindow(workspace: WorkspaceEntry): Promise<void> {
  await mintWorkspaceWindow(workspace, false);
}

export async function newWorkspaceTerminalWindow(workspace: WorkspaceEntry): Promise<void> {
  await mintWorkspaceWindow(workspace, true);
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

/** Turn a workspace off for a caller that asks about live terminal sessions
 * on a surface of its own, where `setWorkspacePower` raises the dialog.
 * Unforced, it resolves null once the workspace is off, or with the count of
 * live terminal sessions the server refused over; forced, it stops them. */
export async function turnOffWorkspace(workspace: WorkspaceEntry, force = false): Promise<number | null> {
  try {
    await setWorkspaceOn(workspace, false, force);
    return null;
  } catch (error) {
    const count = liveTerminalsCount(error);
    if (force || count === null) throw error;
    return count;
  }
}

/** Turn a workspace on and open a window of it, for a caller that asked for
 * the window while the workspace was off. A browser opens the window after
 * the turn-on answers, outside the gesture's own task: one it blocks leaves
 * the minted record waiting for an Open. */
export async function turnOnAndOpenWorkspace(workspace: WorkspaceEntry): Promise<void> {
  await setWorkspaceOn(workspace, true);
  await mintWorkspaceWindow(workspace, false);
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

/** The live terminal sessions a workspace's windows own, read ahead of a turn
 * off. Null where a window's count is unknown: a devserver's feed carries
 * none, so a served workspace is not asked. Sessions no listed window owns
 * are not in the figure; the server's own count, which an unforced turn off
 * answers with, is the one that decides. */
export async function liveTerminalCountForWorkspace(
  workspace: WorkspaceEntry,
  windows: WindowRecord[],
): Promise<number | null> {
  if (workspace.devserver_id) return null;
  let total = 0;
  for (const count of await Promise.all(windows.map(liveTerminalCountForWindow))) {
    if (typeof count !== "number") return null;
    total += count;
  }
  return total;
}

/** Bring a machine's card to the front of the Computers screen and put the
 * keyboard on it. `key` is the card's key in the Computers deck. */
export function showComputerCard(key: string): void {
  showScreen("computers");
  showCard("computers", key, { focus: true });
}

/** Copy a gateway's WireGuard public key, the key its badge shows the first
 * characters of. */
export async function copyGatewayPublicKey(gateway: GatewayEntry): Promise<void> {
  if (!gateway.wireguard_public_key) throw new Error("This gateway has no WireGuard key");
  await navigator.clipboard.writeText(gateway.wireguard_public_key);
}

// The tmux connection card's actions. Each is one request to the connection
// through the library; the feed carries the outcome (a new row, the card
// leaving with its connection).

/** Ask a connection for a new tmux window; its chan window arrives through
 * the feed. The card's `t`, as a terminal is a machine's. */
export async function newTmuxWindow(connection: string): Promise<void> {
  await requestTmux(connection, { request: "new-window" });
}

/** Detach the connection: tmux keeps running, its chan windows close by
 * themselves and the control terminal returns to a plain terminal. The card's
 * `o` uses the same slot as a devserver's disconnect. */
export async function detachTmux(connection: string): Promise<void> {
  await requestTmux(connection, { request: "detach" });
}

/** Open a tmux window past the cap: the show action of a card row that has
 * no chan window yet. */
export async function openTmuxWindow(connection: string, window: TmuxWindowEntry): Promise<void> {
  await requestTmux(connection, { request: "open-window", window: window.id });
}
