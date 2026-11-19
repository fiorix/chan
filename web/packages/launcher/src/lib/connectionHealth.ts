// A devserver's connection health in words and in a chart, for its card on
// the Computers screen. The desktop reads it from the pings it sends on the
// devserver's window feed and serves it on the devserver's row; this page
// counts waits and ages against its own clock, which is the desktop's.

import type { ConnectionHealth } from "../api/library";

/// The chart's floor: a spike is clipped at twice the median only once that
/// passes this, so a fast connection's jitter stays low. It is the desktop's
/// SLOW_RTT_MS (`desktop/src-tauri/src/connection_health.rs`), so a fast
/// connection's chart tops out at a reply slow enough to count toward slow.
/// It scales the drawing and decides no face, so the row does not carry it.
export const CONNECTION_CHART_FLOOR_MS = 400;

/// The chart and its marks use one view box so the component and path math agree.
export const CONNECTION_SPARKLINE_WIDTH = 180;
export const CONNECTION_SPARKLINE_HEIGHT = 48;
export const CONNECTION_SPARKLINE_EDGE = 3;
const CONNECTION_SPARKLINE_PAD = 4;
export const CONNECTION_SPARKLINE_BASELINE = CONNECTION_SPARKLINE_HEIGHT - CONNECTION_SPARKLINE_PAD;
export const CONNECTION_SPARKLINE_MISS_TOP = CONNECTION_SPARKLINE_BASELINE - 4;
export const CONNECTION_SPARKLINE_MISS_BOTTOM = CONNECTION_SPARKLINE_BASELINE + 2;

/// Latest is the last answered ping; median and worst use the answered set.
export type ConnectionFigures = { latest: number | null; median: number | null; worst: number | null };
/// Each path is one uninterrupted answered run; misses hold baseline x coordinates.
export type ConnectionSparkline = { paths: string[]; misses: number[] };

/// A reply time in words: milliseconds under a second, else seconds to a tenth.
export function formatConnectionMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/// How long the oldest unanswered ping has waited at `now`, 0 with none.
export function connectionWaitMs(health: ConnectionHealth, now: number): number {
  return health.wait_since === null ? 0 : Math.max(0, now - health.wait_since);
}

/// The words beside the mark, empty where the mark stands alone: healthy,
/// unknown, and a slow face the desktop read as recovering, which holds until
/// the next reading. Any other slow face reads the larger of its reply time
/// and its wait.
export function connectionFaceLabel(health: ConnectionHealth, now: number): string {
  const wait = connectionWaitMs(health, now);
  switch (health.face) {
    case "reconnecting":
      return "reconnecting";
    case "stalled":
      return `stalled ${Math.floor(wait / 1000)} s`;
    case "slow":
      return health.recovering ? "" : formatConnectionMs(Math.max(health.rtt_ms ?? 0, wait));
    default:
      return "";
  }
}

/// The face's name, for its title and its accessible name.
export function connectionFaceName(health: ConnectionHealth, now: number): string {
  switch (health.face) {
    case "healthy":
      return "Connection healthy";
    case "unknown":
      return "Connection status unknown";
    case "slow": {
      if (health.recovering) return "Connection recovering";
      const rtt = health.rtt_ms;
      return rtt !== null && rtt >= connectionWaitMs(health, now)
        ? `Connection slow, ${formatConnectionMs(rtt)}`
        : "Connection slow, waiting for a reply";
    }
    case "stalled":
      return "Connection stalled";
    case "reconnecting":
      return "Connection lost, reconnecting";
  }
}

/// Aggregate only answered pings, leaving a dash for every figure before one arrives.
export function connectionFigures(samples: readonly (number | null)[]): ConnectionFigures {
  const answered = samples.filter((rtt): rtt is number => rtt !== null);
  if (answered.length === 0) return { latest: null, median: null, worst: null };
  const sorted = [...answered].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
  return { latest: answered.at(-1)!, median, worst: sorted.at(-1)! };
}

/// The chart floor keeps fast-connection jitter low; the larger of that
/// floor and twice the median clips spikes without flattening normal reply
/// times.
export function connectionSparkline(samples: readonly (number | null)[], width = CONNECTION_SPARKLINE_WIDTH, height = CONNECTION_SPARKLINE_HEIGHT): ConnectionSparkline {
  const ceiling = Math.max(CONNECTION_CHART_FLOOR_MS, (connectionFigures(samples).median ?? 0) * 2);
  const x = (index: number) => Math.round(samples.length === 1
    ? width / 2
    : CONNECTION_SPARKLINE_EDGE + index * (width - 2 * CONNECTION_SPARKLINE_EDGE) / (samples.length - 1));
  const y = (rtt: number) => Math.round(height - CONNECTION_SPARKLINE_PAD - Math.min(rtt, ceiling) / ceiling * (height - 2 * CONNECTION_SPARKLINE_PAD));
  const paths: string[] = [];
  const misses: number[] = [];
  let run: string[] = [];
  const flush = () => {
    // An isolated answer needs a segment for SVG to paint its round cap.
    if (run.length === 1) run.push(run[0]!);
    if (run.length > 0) paths.push(`M ${run.join(" L ")}`);
    run = [];
  };
  samples.forEach((rtt, index) => {
    if (rtt === null) {
      flush();
      misses.push(x(index));
    } else {
      run.push(`${x(index)} ${y(rtt)}`);
    }
  });
  flush();
  return { paths, misses };
}

/// Clamp a slightly future timestamp while this page's clock and the row's
/// refresh disagree by a moment.
function elapsed(at: number, now: number): string {
  const seconds = Math.floor(Math.max(0, now - at) / 1000);
  return seconds < 120 ? `${seconds} s` : `${Math.floor(seconds / 60)} min`;
}

/// Clock time of the last frame from the devserver, or a dash before any.
export function connectionContactTime(at: number | null): string {
  return at === null ? "-" : new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

/// How long the face has held, in words: stalled counts the oldest
/// unanswered ping's wait, slow and reconnecting count from the face's start.
export function connectionStateAge(health: ConnectionHealth, now: number): string {
  switch (health.face) {
    case "healthy": return "Connected";
    case "unknown": return "No reading yet";
    case "slow": return `Slow for ${elapsed(health.since, now)}`;
    case "stalled": return `No response for ${Math.floor(connectionWaitMs(health, now) / 1000)} s`;
    case "reconnecting": return `Reconnecting for ${elapsed(health.since, now)}`;
  }
}
