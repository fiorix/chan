// The verdicts of connection-chart-native.mjs, apart from the desktop so
// connection-chart-verdict.test.mjs can read them against made traces.
//
// A trace is what the page sampler recorded every 50 ms: `t` in ms from its
// start, `sig` a hash of the chart's drawn paths (it changes when, and only
// when, the history the chart draws changes: an arrival), and `marker` the
// on-screen x of the leftmost point of the marked reading, or null while
// there is none.

/// A step of the trace this far left or more is a move, not rounding.
const MOVE_PX = 0.5;
/// The jump at an arrival the contract allows.
const ARRIVAL_JUMP_PX = 1;
/// An interval between arrivals this long or more must show the line moving.
const LONG_INTERVAL_MS = 1_500;
/// How far the line must move left over such an interval: a step at the
/// chart's narrowest is several pixels, and the line moves at least half a
/// step in 1.5 s.
const INTERVAL_MOVE_PX = 2;
/// How many readings inside one ping interval the motion verdict rests on.
const MIN_INTERVAL_SAMPLES = 8;

const line = (name, expected, actual, pass) => ({ name, expected, actual, pass });
const px = (value) => Math.round(value * 100) / 100;

/// Split the trace at each change of `sig`: the arrivals, as the index of
/// the first reading after each, and the intervals between them.
export function arrivals(trace) {
  const at = [];
  for (let i = 1; i < trace.length; i++) if (trace[i].sig !== trace[i - 1].sig) at.push(i);
  const intervals = [];
  for (let k = 0; k + 1 < at.length; k++) intervals.push(trace.slice(at[k], at[k + 1]));
  return { at, intervals };
}

/// The motion verdict, or with `reduced` the reduced-motion one. Answers
/// `{ setup, lines }`: `setup` is false when the trace cannot carry a verdict
/// (too few readings in an interval, no arrival with the marker on both
/// sides), and `lines` holds one assertion each.
export function judgeMotion(trace, reduced) {
  const { at, intervals } = arrivals(trace);
  const marked = intervals.filter((span) => span.length > 0 && span.every((r) => r.marker !== null));
  const crossings = at.filter((i) => trace[i - 1].marker !== null && trace[i].marker !== null)
    .map((i) => ({ t: trace[i].t, before: trace[i - 1].marker, after: trace[i].marker }));
  const densest = marked.reduce((most, span) => Math.max(most, span.length), 0);
  const lines = [
    line("readings inside one ping interval", `>= ${MIN_INTERVAL_SAMPLES}`, densest, densest >= MIN_INTERVAL_SAMPLES),
    line("arrivals with the marked reading drawn on both sides", ">= 1", crossings.length, crossings.length >= 1),
  ];
  if (!lines.every((l) => l.pass)) return { setup: false, lines };

  const long = marked.filter((span) => span.at(-1).t - span[0].t >= LONG_INTERVAL_MS);
  const moved = long.map((span) => px(span[0].marker - span.at(-1).marker));
  let rightward = 0;
  for (let i = 1; i < trace.length; i++) {
    if (trace[i].marker !== null && trace[i - 1].marker !== null) {
      rightward = Math.max(rightward, trace[i].marker - trace[i - 1].marker);
    }
  }
  const jumps = crossings.map((c) => px(c.before - c.after));
  const biggest = jumps.reduce((most, jump) => Math.max(most, Math.abs(jump)), 0);
  if (reduced) {
    const drift = marked.map((span) => px(span.reduce((most, r) => Math.max(most, Math.abs(r.marker - span[0].marker)), 0)));
    lines.push(
      line("the line holds between arrivals", `every interval drifts <= ${MOVE_PX} px`, drift, drift.every((d) => d <= MOVE_PX)),
      line("the line steps left at an arrival", `every jump >= ${INTERVAL_MOVE_PX} px`, jumps, jumps.every((j) => j >= INTERVAL_MOVE_PX)),
    );
  } else {
    lines.push(
      line("the line moves left between arrivals", `each interval of ${LONG_INTERVAL_MS} ms or more >= ${INTERVAL_MOVE_PX} px`,
        moved, moved.length > 0 && moved.every((m) => m >= INTERVAL_MOVE_PX)),
      line("the line never moves right", `<= ${MOVE_PX} px`, px(rightward), rightward <= MOVE_PX),
      line("an arrival makes no jump", `|jump| <= ${ARRIVAL_JUMP_PX} px`, jumps, biggest <= ARRIVAL_JUMP_PX),
    );
  }
  return { setup: true, lines };
}

/// The inset verdict from the boxes the page read: the chart's drawn extent
/// (the baseline's ends) inside the card.
export function judgeInset(boxes) {
  const left = px(boxes.baseline.left - boxes.card.left);
  const right = px(boxes.card.right - boxes.baseline.right);
  return [line("the chart's insets inside the card are equal", "|left - right| <= 1 px",
    { left, right, health: boxes.health, card: boxes.card, baseline: boxes.baseline }, Math.abs(left - right) <= 1)];
}
