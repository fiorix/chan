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

/// How many finished pings the desktop keeps in a reading's history:
/// CONNECTION_SAMPLE_CAP in chan-library (`devserver_registry.rs`).
export const CONNECTION_SAMPLE_CAP = 60;

/// One step of the chart is one ping, and it scrolls a step in this long:
/// the desktop's FOCUSED_CADENCE (`desktop/src-tauri/src/connection_health.rs`),
/// the pace it pings at while the Computers screen has the focus. An
/// unfocused desktop pings less often, and the line then rests at its newest
/// sample until the next comes.
export const CONNECTION_SCROLL_MS = 3_000;

/// The chart and its marks use one view box so the component and path math
/// agree: CONNECTION_SPARKLINE_HEIGHT units tall and, until the detail it
/// fills has been measured, CONNECTION_SPARKLINE_WIDTH units wide.
export const CONNECTION_SPARKLINE_WIDTH = 180;
export const CONNECTION_SPARKLINE_HEIGHT = 48;
/// The chart's height on the card, in CSS pixels. It draws at one scale in
/// both directions, so a wider card spreads its points further apart and
/// leaves its height and the weight of its strokes as they are.
export const CONNECTION_CHART_HEIGHT_PX = 69;
export const CONNECTION_SPARKLINE_EDGE = 3;
const CONNECTION_SPARKLINE_PAD = 4;
export const CONNECTION_SPARKLINE_BASELINE = CONNECTION_SPARKLINE_HEIGHT - CONNECTION_SPARKLINE_PAD;
export const CONNECTION_SPARKLINE_MISS_TOP = CONNECTION_SPARKLINE_BASELINE - 4;
export const CONNECTION_SPARKLINE_MISS_BOTTOM = CONNECTION_SPARKLINE_BASELINE + 2;

/// The chart's width in view-box units for a detail `boxWidth` CSS pixels
/// wide, at the chart's one scale, so its points span the detail's width;
/// CONNECTION_SPARKLINE_WIDTH before the detail has been measured.
export function connectionSparklineWidth(boxWidth: number): number {
  return boxWidth > 0
    ? boxWidth * CONNECTION_SPARKLINE_HEIGHT / CONNECTION_CHART_HEIGHT_PX
    : CONNECTION_SPARKLINE_WIDTH;
}

/// Latest is the last answered ping; median and worst use the answered set.
export type ConnectionFigures = { latest: number | null; median: number | null; worst: number | null };
/// Each path is one uninterrupted answered run; misses hold baseline x
/// coordinates. Both are drawn at rest, the newest sample at the right edge.
export type ConnectionSparkline = { paths: string[]; misses: number[] };

/// A reply time in words: milliseconds under a second, else seconds to a tenth.
export function formatConnectionMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/// How long the oldest unanswered ping has waited at `now`, 0 with no wait
/// served.
export function connectionWaitMs(health: ConnectionHealth, now: number): number {
  return health.wait_since === null ? 0 : Math.max(0, now - health.wait_since);
}

/// The words beside the mark, empty where the mark stands alone: healthy,
/// unknown, and a slow face the desktop read as recovering, which holds until
/// the next reading. Any other slow face reads the larger of its reply time
/// and its wait. Stalled counts the oldest unanswered ping's wait and
/// reconnecting counts from the face's start, whatever ping still waits.
export function connectionFaceLabel(health: ConnectionHealth, now: number): string {
  const wait = connectionWaitMs(health, now);
  switch (health.face) {
    case "reconnecting":
      return `reconnecting ${elapsed(health.since, now)}`;
    case "stalled":
      return `stalled ${Math.floor(wait / 1000)} s`;
    case "slow":
      return health.recovering ? "" : formatConnectionMs(Math.max(health.rtt_ms ?? 0, wait));
    default:
      return "";
  }
}

/// The face's name, for its title and its accessible name. A stalled or
/// reconnecting face's name carries the count its words show, since a
/// control that holds the face and is labelled for its own action reads the
/// name alone.
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
      return `Connection stalled for ${Math.floor(connectionWaitMs(health, now) / 1000)} s`;
    case "reconnecting":
      return `Connection lost, reconnecting for ${elapsed(health.since, now)}`;
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

/// The width in view-box units of one step, one ping, in a chart `width`
/// units wide. The steps are the same at every count of samples, so the line
/// can scroll: a full history fills the chart with its oldest point one step
/// past the left edge at rest, where it leaves while the newest comes in from
/// one step past the right; a shorter one occupies the right of the chart.
export function connectionSparklineStep(width: number): number {
  return (width - 2 * CONNECTION_SPARKLINE_EDGE) / (CONNECTION_SAMPLE_CAP - 2);
}

/// The chart floor keeps fast-connection jitter low; the larger of that
/// floor and twice the median clips spikes without flattening normal reply
/// times. The x coordinates keep two decimals: the line moves by fractions
/// of a step, and points rounded to whole units would shift under it when a
/// sample arrives.
export function connectionSparkline(samples: readonly (number | null)[], width = CONNECTION_SPARKLINE_WIDTH, height = CONNECTION_SPARKLINE_HEIGHT): ConnectionSparkline {
  const ceiling = Math.max(CONNECTION_CHART_FLOOR_MS, (connectionFigures(samples).median ?? 0) * 2);
  const step = connectionSparklineStep(width);
  const x = (index: number) => Math.round((width - CONNECTION_SPARKLINE_EDGE - (samples.length - 1 - index) * step) * 100) / 100;
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

/// How many samples `next` adds after `prev`: the fewest that leave `next`
/// starting with what it keeps of `prev`, as the desktop's history adds its
/// newest and, at its cap, drops its oldest. The row dates no sample, so this
/// is how the page learns that one arrived. A run of equal readings matches
/// at more than one count; the fewest draws the same line. Null when `next`
/// does not continue `prev`: a shorter history, begun afresh, or one whose
/// every sample is new, so nothing the chart drew stays to move.
export function connectionSampleShift(prev: readonly (number | null)[], next: readonly (number | null)[]): number | null {
  if (next.length < prev.length) return null;
  for (let added = next.length - prev.length; added < next.length; added++) {
    const kept = next.length - added;
    const from = prev.length - kept;
    let same = true;
    for (let i = 0; same && i < kept; i++) same = next[i] === prev[from + i];
    if (same) return added;
  }
  return null;
}

/// How many steps behind its newest sample the chart may draw before it
/// speeds up. The page sees a sample on its next 2 s re-list, so on a 3 s
/// cadence the samples it sees come 2 s and 4 s apart, and the line, moving a
/// step per 3 s, trails by up to one and a third steps without falling
/// further behind.
const CONNECTION_SCROLL_SLACK = 2;

/// The line's lag, in steps behind its newest sample, `elapsedMs` after it
/// was `lag`. It closes at one step per CONNECTION_SCROLL_MS and stops at
/// none, so it never draws past the newest sample. Beyond the slack, after
/// several samples arrive at once (the misses of a lost socket, a re-list
/// after the page was hidden), it closes at the steps beyond one per
/// CONNECTION_SCROLL_MS: an exponential approach to the slack, whose speed
/// meets the steady one there.
export function connectionScrollLag(lag: number, elapsedMs: number): number {
  let rest = elapsedMs;
  if (lag > CONNECTION_SCROLL_SLACK) {
    const over = lag - (CONNECTION_SCROLL_SLACK - 1);
    const toSlack = CONNECTION_SCROLL_MS * Math.log(over);
    if (rest < toSlack) return CONNECTION_SCROLL_SLACK - 1 + over * Math.exp(-rest / CONNECTION_SCROLL_MS);
    lag = CONNECTION_SCROLL_SLACK;
    rest -= toSlack;
  }
  return Math.max(0, lag - rest / CONNECTION_SCROLL_MS);
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
