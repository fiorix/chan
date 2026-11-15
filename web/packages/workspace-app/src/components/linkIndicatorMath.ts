import { LINK_SLOW_RTT_MS, type LinkSample } from "../api/linkProbe";
import type { LinkState } from "../state/linkHealth.svelte";

/// The two placements share visibility: a remote tab bar keeps its quiet glyph,
/// while either placement surfaces an unhealthy link on any window.
export type LinkIndicatorPlacement = "tab-bar" | "status";

/// The tab-bar label reserves enough character width for "reconnecting".
export const LINK_INDICATOR_LABEL_CH = 13;

/// Whether the indicator occupies space in its parent.
export function linkIndicatorShown(placement: LinkIndicatorPlacement, state: LinkState, remote: boolean): boolean {
  return state === "slow" || state === "stalled" || state === "down" || (placement === "tab-bar" && remote);
}

/// The chart and its marks use one view box so the component and path math agree.
export const LINK_SPARKLINE_WIDTH = 180;
export const LINK_SPARKLINE_HEIGHT = 48;
export const LINK_SPARKLINE_EDGE = 3;
const LINK_SPARKLINE_PAD = 4;
export const LINK_SPARKLINE_BASELINE = LINK_SPARKLINE_HEIGHT - LINK_SPARKLINE_PAD;
export const LINK_SPARKLINE_MISS_TOP = LINK_SPARKLINE_BASELINE - 4;
export const LINK_SPARKLINE_MISS_BOTTOM = LINK_SPARKLINE_BASELINE + 2;

/// Latest is the last answered ping; median and worst use the answered set.
export type LinkFigures = { latest: number | null; median: number | null; worst: number | null };
/// Each path is one uninterrupted answered run; misses hold baseline x coordinates.
export type LinkSparkline = { paths: string[]; misses: number[] };

/// Aggregate only answered pings, leaving a dash for every figure before one arrives.
export function linkFigures(samples: readonly LinkSample[]): LinkFigures {
  const answered = samples.flatMap((sample) => sample.rttMs === null ? [] : [sample.rttMs]);
  if (answered.length === 0) return { latest: null, median: null, worst: null };
  const sorted = [...answered].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
  return { latest: answered.at(-1)!, median, worst: sorted.at(-1)! };
}

/// The slow-threshold floor keeps fast-link jitter low; the larger of that
/// floor and twice the median clips spikes without flattening normal RTTs.
export function linkSparkline(samples: readonly LinkSample[], width = LINK_SPARKLINE_WIDTH, height = LINK_SPARKLINE_HEIGHT): LinkSparkline {
  const ceiling = Math.max(LINK_SLOW_RTT_MS, (linkFigures(samples).median ?? 0) * 2);
  const x = (index: number) => Math.round(samples.length === 1
    ? width / 2
    : LINK_SPARKLINE_EDGE + index * (width - 2 * LINK_SPARKLINE_EDGE) / (samples.length - 1));
  const y = (rtt: number) => Math.round(height - LINK_SPARKLINE_PAD - Math.min(rtt, ceiling) / ceiling * (height - 2 * LINK_SPARKLINE_PAD));
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
/// the link state's quarter-second updates.
function elapsed(at: number, now: number): string {
  const seconds = Math.floor(Math.max(0, now - at) / 1000);
  return seconds < 120 ? `${seconds} s` : `${Math.floor(seconds / 60)} min`;
}

/// Age of the last inbound frame, or a dash before any frame arrives.
export function linkAge(at: number | null, now: number): string {
  return at === null ? "-" : `${elapsed(at, now)} ago`;
}

/// The current state in words: stalled counts the oldest unanswered ping's
/// wait, while slow and down count from the state change.
export function linkStateAge(state: LinkState, since: number, now: number, waitMs: number): string {
  const age = elapsed(since, now);
  switch (state) {
    case "ok": return "Connected";
    case "unknown": return "No reading yet";
    case "slow": return `Slow for ${age}`;
    case "stalled": return `No response for ${Math.floor(waitMs / 1000)} s`;
    case "down": return `Reconnecting for ${age}`;
  }
}
