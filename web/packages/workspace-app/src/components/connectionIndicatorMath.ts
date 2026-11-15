import { CONNECTION_SLOW_RTT_MS, type ConnectionSample } from "../api/connectionProbe";
import type { ConnectionState } from "../state/connectionHealth.svelte";

/// The two placements share visibility: a remote tab bar keeps its quiet glyph,
/// while either placement surfaces an unhealthy connection on any window.
export type ConnectionIndicatorPlacement = "tab-bar" | "status";

/// The tab-bar reserves a stable width within each labeled connection state.
export const CONNECTION_INDICATOR_SLOW_LABEL_CH = 7;
export const CONNECTION_INDICATOR_STALLED_DOWN_LABEL_CH = 12;

/// Recovering `slow` keeps its slot so jitter cannot resize the tab strip.
export function connectionIndicatorLabelCh(state: ConnectionState): number {
  return state === "slow" ? CONNECTION_INDICATOR_SLOW_LABEL_CH
    : state === "stalled" || state === "down" ? CONNECTION_INDICATOR_STALLED_DOWN_LABEL_CH
    : 0;
}

/// Whether the indicator occupies space in its parent.
export function connectionIndicatorShown(placement: ConnectionIndicatorPlacement, state: ConnectionState, remote: boolean): boolean {
  return state === "slow" || state === "stalled" || state === "down" || (placement === "tab-bar" && remote);
}

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

/// Aggregate only answered pings, leaving a dash for every figure before one arrives.
export function connectionFigures(samples: readonly ConnectionSample[]): ConnectionFigures {
  const answered = samples.flatMap((sample) => sample.rttMs === null ? [] : [sample.rttMs]);
  if (answered.length === 0) return { latest: null, median: null, worst: null };
  const sorted = [...answered].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
  return { latest: answered.at(-1)!, median, worst: sorted.at(-1)! };
}

/// The slow-threshold floor keeps fast-connection jitter low; the larger of that
/// floor and twice the median clips spikes without flattening normal RTTs.
export function connectionSparkline(samples: readonly ConnectionSample[], width = CONNECTION_SPARKLINE_WIDTH, height = CONNECTION_SPARKLINE_HEIGHT): ConnectionSparkline {
  const ceiling = Math.max(CONNECTION_SLOW_RTT_MS, (connectionFigures(samples).median ?? 0) * 2);
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
  samples.forEach((sample, index) => {
    if (sample.rttMs === null) {
      flush();
      misses.push(x(index));
    } else {
      run.push(`${x(index)} ${y(sample.rttMs)}`);
    }
  });
  flush();
  return { paths, misses };
}

/// Clamp a slightly future timestamp while the one-second display clock lags
/// the connection state's quarter-second updates.
function elapsed(at: number, now: number): string {
  const seconds = Math.floor(Math.max(0, now - at) / 1000);
  return seconds < 120 ? `${seconds} s` : `${Math.floor(seconds / 60)} min`;
}

/// Clock time of the last inbound frame, or a dash before any frame arrives.
export function connectionContactTime(at: number | null): string {
  return at === null ? "-" : new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

/// The current state in words: stalled counts the oldest unanswered ping's
/// wait, while slow and down count from the state change.
export function connectionStateAge(state: ConnectionState, since: number, now: number, waitMs: number): string {
  const age = elapsed(since, now);
  switch (state) {
    case "ok": return "Connected";
    case "unknown": return "No reading yet";
    case "slow": return `Slow for ${age}`;
    case "stalled": return `No response for ${Math.floor(waitMs / 1000)} s`;
    case "down": return `Reconnecting for ${age}`;
  }
}
