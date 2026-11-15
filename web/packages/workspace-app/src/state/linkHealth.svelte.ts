// The window's link health: one state for the whole window, read from the
// watcher socket's pongs (`api/linkProbe.ts`) and from the watcher's status.
//
// The store hands `watchLinkProbe` to the watcher it opens and reports each
// status change through `setLinkWatchStatus`; components read `linkHealth`.

import { windowLibraryId, type WsStatus } from "../api/client";
import { isTauriDesktop } from "../api/desktop";
import {
  createLinkProbe,
  type LinkProbe,
  type LinkProbeState,
  type LinkSample,
} from "../api/linkProbe";

/// A window's link state: what the watcher's pongs say, or `down` while the
/// watcher is not open after having been open, which is when the reconnecting
/// cover shows.
export type LinkState = LinkProbeState | "down";

/// How many finished pings the window keeps: three minutes of the watcher's
/// fast cadence, enough to show a bad spell and the recovery after it.
export const LINK_SAMPLE_CAP = 60;

/// How often the state is read again while a ping waits. Fine enough that a
/// change driven by time lands within a quarter second of its threshold and
/// a counted wait never skips a second.
const LINK_TICK_MS = 250;

export const linkHealth = $state<{
  state: LinkState;
  /// When `state` took its current value.
  since: number;
  /// The latest round-trip time, kept across sockets; `null` before the first.
  rttMs: number | null;
  /// How long the oldest unanswered ping has waited, refreshed while one
  /// waits on a socket that has answered before; 0 otherwise.
  waitMs: number;
  /// The last LINK_SAMPLE_CAP finished pings, oldest first. A sample with a
  /// `null` round-trip time is a ping that was never answered.
  samples: LinkSample[];
  /// When the last frame of any kind arrived, kept across sockets; `null`
  /// before the first.
  lastContactAt: number | null;
}>({
  state: "unknown",
  since: Date.now(),
  rttMs: null,
  waitMs: 0,
  samples: [],
  lastContactAt: null,
});

let watchOpen = false;
/// `down` needs an earlier open: a page still dialing for the first time has
/// lost nothing.
let watchOpenedBefore = false;
let ticker: ReturnType<typeof setInterval> | null = null;

/// The probe the window's watcher reports its pings and pongs to.
export const watchLinkProbe: LinkProbe = createLinkProbe({
  onSample(sample) {
    linkHealth.samples.push(sample);
    if (linkHealth.samples.length > LINK_SAMPLE_CAP) linkHealth.samples.shift();
  },
  onChange: sync,
});

/// The watcher's status changed.
export function setLinkWatchStatus(status: WsStatus): void {
  watchOpen = status === "open";
  if (watchOpen) watchOpenedBefore = true;
  sync();
}

function sync(): void {
  const now = Date.now();
  const next: LinkState =
    watchOpenedBefore && !watchOpen ? "down" : watchLinkProbe.classify();
  if (next !== linkHealth.state) {
    linkHealth.state = next;
    linkHealth.since = now;
  }
  const rtt = watchLinkProbe.rttMs;
  if (rtt !== null) linkHealth.rttMs = rtt;
  const contact = watchLinkProbe.lastFrameAt;
  if (contact !== null) linkHealth.lastContactAt = contact;
  // A socket that has never answered stays `unknown` however long its pings
  // wait, so only an answered one has a wait worth counting.
  const pingAt = watchLinkProbe.answered ? watchLinkProbe.oldestPingAt : null;
  linkHealth.waitMs = pingAt === null ? 0 : Math.max(0, now - pingAt);
  // While a ping waits, time alone moves the state to `slow` and `stalled`,
  // with no socket event to report it; the ticker runs for exactly that long.
  if (pingAt !== null && ticker === null) {
    ticker = setInterval(sync, LINK_TICK_MS);
  } else if (pingAt === null && ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
}

/// Whether this window reaches its server over a network. The desktop stamps
/// each window with its library, so there the library decides; a browser page
/// has only its host to go by.
export function linkIsRemote(): boolean {
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

/// A link duration in words: "850 ms", "2.4 s".
export function formatLinkMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/// A link state in words, empty for the states that need none. A `slow` link
/// is named by its round-trip time, which is at least as long as the ping now
/// waiting has waited; a `stalled` one by that wait, in whole seconds.
export function linkLabel(state: LinkState, rttMs: number | null, waitMs: number): string {
  switch (state) {
    case "down":
      return "reconnecting";
    case "stalled":
      return `stalled ${Math.floor(waitMs / 1000)} s`;
    case "slow":
      return formatLinkMs(Math.max(rttMs ?? 0, waitMs));
    default:
      return "";
  }
}

/// Put the module back to its state at load. The ticker is stopped here and
/// not left to the probe's reset, so a test that finds it running wrongly
/// does not hand its handle to the next one.
export function resetLinkHealthForTests(): void {
  watchOpen = false;
  watchOpenedBefore = false;
  watchLinkProbe.reset();
  if (ticker !== null) clearInterval(ticker);
  ticker = null;
  linkHealth.state = "unknown";
  linkHealth.since = Date.now();
  linkHealth.rttMs = null;
  linkHealth.waitMs = 0;
  linkHealth.samples = [];
  linkHealth.lastContactAt = null;
}
