// The window's link health: one state for the whole window, read from the
// watcher socket's pongs (`api/linkProbe.ts`) and from the watcher's status.
//
// The store hands `watchLinkProbe` to the watcher it opens and reports each
// status change through `setLinkWatchStatus`; components read `linkHealth`.

import { windowLibraryId, type WsStatus } from "../api/client";
import { isTauriDesktop } from "../api/desktop";
import {
  LINK_OK_RTT_MS,
  createLinkProbe,
  type LinkProbe,
  type LinkProbeState,
  type LinkSample,
} from "../api/linkProbe";
import { WS_READ_DEADLINE_MS, type WatchDrop } from "../api/transport";

/// A window's link state: what the watcher's pongs say, or `down` from the
/// loss of an open watcher until a later socket answers a ping.
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
  /// waits after the page's first pong; 0 otherwise.
  waitMs: number;
  /// The last LINK_SAMPLE_CAP finished pings, oldest first. A sample with a
  /// `null` round-trip time is a ping that was never answered.
  samples: LinkSample[];
  /// When the last frame of any kind arrived, kept across sockets; `null`
  /// before the first.
  lastContactAt: number | null;
  /// The first loss of an open watcher, held through failed redials until a pong.
  outage: { startedAt: number; coverAt: number } | null;
  /// Changes at the start and end of each outage, not on redial status flips.
  outageEpoch: number;
  /// A socket can be open during an outage, before its first pong.
  watcherOpen: boolean;
}>({
  state: "unknown",
  since: Date.now(),
  rttMs: null,
  waitMs: 0,
  samples: [],
  lastContactAt: null,
  outage: null,
  outageEpoch: 0,
  watcherOpen: false,
});

let ticker: ReturnType<typeof setInterval> | null = null;

/// The probe the window's watcher reports its pings and pongs to.
function makeWatchLinkProbe(): LinkProbe {
  return createLinkProbe({
    rememberAnsweredAcrossSockets: true,
    onSample(sample) {
      linkHealth.samples.push(sample);
      if (linkHealth.samples.length > LINK_SAMPLE_CAP) linkHealth.samples.shift();
    },
    onChange: sync,
  });
}

export let watchLinkProbe: LinkProbe = makeWatchLinkProbe();

/// The watcher's status changed.
export function setLinkWatchStatus(status: WsStatus, drop?: WatchDrop): void {
  const wasOpen = linkHealth.watcherOpen;
  linkHealth.watcherOpen = status === "open";
  if (wasOpen && !linkHealth.watcherOpen && linkHealth.outage === null) {
    const startedAt = Date.now();
    const deadline = drop?.reason === "deadline" && drop.lastFrameAt !== null
      ? drop.lastFrameAt + WS_READ_DEADLINE_MS
      : startedAt;
    linkHealth.outage = {
      startedAt,
      coverAt: deadline,
    };
    linkHealth.outageEpoch += 1;
  }
  sync();
}

function sync(): void {
  const now = Date.now();
  const pingAt = watchLinkProbe.oldestPingAt;
  if (pingAt !== null && now - pingAt > WS_READ_DEADLINE_MS) {
    // A wall-clock jump beyond the 45 s ordinary read deadline is not a
    // useful wait. forgetTimings reports one change and re-enters sync once;
    // its cleared timing ends the recursion. On a hidden page whose pings
    // never return while other frames arrive, this reads ok again each 45 s
    // until the next ping becomes a second late.
    watchLinkProbe.forgetTimings();
    return;
  }
  if (linkHealth.watcherOpen && watchLinkProbe.answered && linkHealth.outage !== null) {
    linkHealth.outage = null;
    linkHealth.outageEpoch += 1;
  }
  const next: LinkState = linkHealth.outage !== null ? "down" : watchLinkProbe.classify();
  if (next !== linkHealth.state) {
    linkHealth.state = next;
    linkHealth.since = now;
  }
  const rtt = watchLinkProbe.rttMs;
  if (rtt !== null) linkHealth.rttMs = rtt;
  const contact = watchLinkProbe.lastFrameAt;
  if (contact !== null) linkHealth.lastContactAt = contact;
  // The page's first socket stays `unknown` before its first pong, so only
  // pings after the page has an answer have a wait worth counting.
  const countedPingAt = watchLinkProbe.everAnswered ? watchLinkProbe.oldestPingAt : null;
  linkHealth.waitMs = countedPingAt === null ? 0 : Math.max(0, now - countedPingAt);
  // While a ping waits, time alone moves the state to `slow` and `stalled`,
  // with no socket event to report it; the ticker runs for exactly that long.
  if (countedPingAt !== null && ticker === null) {
    ticker = setInterval(sync, LINK_TICK_MS);
  } else if (countedPingAt === null && ticker !== null) {
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
/// is named by its round-trip time or pending wait only while either is at or above
/// the recovery threshold; a `stalled` one by that wait, in whole seconds.
export function linkLabel(state: LinkState, rttMs: number | null, waitMs: number): string {
  switch (state) {
    case "down":
      return "reconnecting";
    case "stalled":
      return `stalled ${Math.floor(waitMs / 1000)} s`;
    case "slow": {
      const ms = Math.max(rttMs ?? 0, waitMs);
      return ms < LINK_OK_RTT_MS
        ? ""
        : formatLinkMs(ms);
    }
    default:
      return "";
  }
}

/// Put the module back to its state at load. The ticker is stopped here and
/// not left to the probe's reset, so a test that finds it running wrongly
/// does not hand its handle to the next one.
export function resetLinkHealthForTests(): void {
  if (ticker !== null) clearInterval(ticker);
  ticker = null;
  watchLinkProbe = makeWatchLinkProbe();
  linkHealth.state = "unknown";
  linkHealth.since = Date.now();
  linkHealth.rttMs = null;
  linkHealth.waitMs = 0;
  linkHealth.samples = [];
  linkHealth.lastContactAt = null;
  linkHealth.outage = null;
  linkHealth.outageEpoch = 0;
  linkHealth.watcherOpen = false;
}
