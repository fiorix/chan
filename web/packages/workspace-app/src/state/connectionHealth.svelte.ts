// The window's connection: the outage of its watcher socket, which the
// reconnecting cover and the close prompt read, and whether the watcher is
// open. The watcher reports its pings and pongs to `watchConnectionProbe`, and
// an outage ends at a later socket's first pong.
//
// The store hands `watchConnectionProbe` to the watcher it opens and reports each
// status change through `setConnectionWatchStatus`; components read `connectionHealth`.

import { windowLibraryId, type WsStatus } from "../api/client";
import { isTauriDesktop } from "../api/desktop";
import { createConnectionProbe, type ConnectionProbe } from "../api/connectionProbe";
import { WS_READ_DEADLINE_MS, type WatchDrop } from "../api/transport";

export const connectionHealth = $state<{
  /// The first loss of an open watcher, held through failed redials until a pong.
  outage: { startedAt: number; coverAt: number } | null;
  /// Changes at the start and end of each outage, not on redial status flips.
  outageEpoch: number;
  /// A socket can be open during an outage, before its first pong.
  watcherOpen: boolean;
}>({
  outage: null,
  outageEpoch: 0,
  watcherOpen: false,
});

/// The probe the window's watcher reports its pings and pongs to.
function makeWatchConnectionProbe(): ConnectionProbe {
  return createConnectionProbe({ onAnswer: endOutageAtReply });
}

export let watchConnectionProbe: ConnectionProbe = makeWatchConnectionProbe();

/// The watcher's status changed.
export function setConnectionWatchStatus(status: WsStatus, drop?: WatchDrop): void {
  const wasOpen = connectionHealth.watcherOpen;
  connectionHealth.watcherOpen = status === "open";
  if (wasOpen && !connectionHealth.watcherOpen && connectionHealth.outage === null) {
    const startedAt = Date.now();
    const deadline = drop?.reason === "deadline" && drop.lastFrameAt !== null
      ? drop.lastFrameAt + WS_READ_DEADLINE_MS
      : startedAt;
    connectionHealth.outage = {
      startedAt,
      coverAt: deadline,
    };
    connectionHealth.outageEpoch += 1;
  }
  endOutageAtReply();
}

/// An outage ends at a reply on an open socket, not at the socket's open.
function endOutageAtReply(): void {
  if (connectionHealth.watcherOpen && watchConnectionProbe.answered && connectionHealth.outage !== null) {
    connectionHealth.outage = null;
    connectionHealth.outageEpoch += 1;
  }
}

/// Whether this window reaches its server over a network. The desktop stamps
/// each window with its library, so there the library decides; a browser page
/// has only its host to go by.
export function connectionIsRemote(): boolean {
  if (typeof window === "undefined") return false;
  if (isTauriDesktop()) return windowLibraryId() !== "local";
  return !isLoopbackHost(window.location.hostname);
}

/// Whether a URL's hostname names this machine.
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

/// Put the module back to its state at load.
export function resetConnectionHealthForTests(): void {
  watchConnectionProbe = makeWatchConnectionProbe();
  connectionHealth.outage = null;
  connectionHealth.outageEpoch = 0;
  connectionHealth.watcherOpen = false;
}
