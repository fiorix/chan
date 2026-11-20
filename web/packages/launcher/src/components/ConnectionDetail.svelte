<script lang="ts">
  // A connected devserver's connection detail on its card in front: the last
  // 60 finished pings with a red mark at each miss, then one line of the
  // latest, median and worst reply times and the last contact to the second,
  // as Since. The face beside the name says the state, counting where it
  // counts, so the detail does not repeat it. In privacy mode it is concealed
  // behind the devserver's one connection reveal, the one beside its face.
  //
  // The line scrolls: the desktop pings every 3 s while it has the focus, and
  // between two samples the reading slides left a step, the newest coming in
  // past the right edge, so a sample's arrival moves nothing already drawn.
  // The paths are drawn at rest, the newest at the right edge; one transform
  // holds them `lag` steps to the right of rest, and a frame loop closes the
  // lag while there is one. The row dates no sample, so an arrival is what a
  // re-list adds to the history (`connectionSampleShift`); the line stops at
  // the newest sample and waits there for the next one. Reduced motion, a
  // concealed detail and a history begun afresh draw at rest.
  import { untrack } from "svelte";
  import { isConcealed } from "@chan/web-shared/privacy";
  import type { ConnectionHealth } from "../api/library";
  import {
    CONNECTION_CHART_HEIGHT_PX,
    CONNECTION_SPARKLINE_BASELINE,
    CONNECTION_SPARKLINE_EDGE,
    CONNECTION_SPARKLINE_HEIGHT,
    CONNECTION_SPARKLINE_MISS_BOTTOM,
    CONNECTION_SPARKLINE_MISS_TOP,
    connectionContactTime,
    connectionFigures,
    connectionSampleShift,
    connectionScrollLag,
    connectionSparkline,
    connectionSparklineStep,
    connectionSparklineWidth,
    formatConnectionMs,
  } from "../lib/connectionHealth";

  let { health, field }: { health: ConnectionHealth; field: string } = $props();

  const concealed = $derived(isConcealed(field));
  const figures = $derived(connectionFigures(health.samples));
  // The chart fills the detail's width at a fixed height, so it is drawn
  // for the width the detail has: measured at mount and on every resize the
  // ResizeObserver reports.
  let box: HTMLDivElement | undefined = $state();
  let boxWidth = $state(0);
  $effect(() => {
    const el = box;
    if (!el) return;
    const measure = (): void => {
      boxWidth = el.clientWidth;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  });
  const chartWidth = $derived(connectionSparklineWidth(boxWidth));
  const sparkline = $derived(connectionSparkline(health.samples, chartWidth));
  const step = $derived(connectionSparklineStep(chartWidth));
  const fmt = (ms: number | null) => ms === null ? "-" : formatConnectionMs(ms);

  // A frame that comes later than this, after a stall of the page, moves
  // the line no further than this would: the line slows for a moment
  // rather than jump.
  const LONGEST_FRAME_MS = 250;

  // Steps the line is drawn behind the newest sample.
  let lag = $state(0);
  // The history as the chart last drew it.
  let drawn: readonly (number | null)[] | null = null;
  // Before the DOM takes a new history, so the line drawn at rest for it and
  // the lag that holds it where it was land in the same frame. Reduced
  // motion is read at each arrival.
  $effect.pre(() => {
    const samples = health.samples;
    const added = drawn && connectionSampleShift(drawn, samples);
    drawn = samples;
    lag = added == null || concealed || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ? 0
      : untrack(() => lag) + added;
  });

  // The frame loop runs while there is a lag. The engine runs no frames for
  // a hidden page, and the first frame after one counts as a late frame.
  const moving = $derived(lag > 0);
  $effect(() => {
    if (!moving) return;
    let last: number | undefined;
    let frame = requestAnimationFrame(function tick(at) {
      lag = connectionScrollLag(lag, Math.min(at - (last ?? at), LONGEST_FRAME_MS));
      last = at;
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  });
  const offset = $derived(Math.round(lag * step * 100) / 100);
</script>

<div class="connection-detail" bind:this={box} data-face={health.face} role="group" aria-label="Connection details">
  {#if concealed}
    <span class="redacted" aria-label="connection details hidden">Hidden</span>
  {:else}
    <svg class="sparkline" viewBox={`0 0 ${chartWidth} ${CONNECTION_SPARKLINE_HEIGHT}`} style:height={`${CONNECTION_CHART_HEIGHT_PX}px`} role="img" aria-label="Recent reply times and missed pings">
      <path class="baseline" d={`M ${CONNECTION_SPARKLINE_EDGE} ${CONNECTION_SPARKLINE_BASELINE} L ${chartWidth - CONNECTION_SPARKLINE_EDGE} ${CONNECTION_SPARKLINE_BASELINE}`} />
      <!-- The reading's window: the baseline's extent and a unit past each
           end, so a point at rest at either end keeps its round cap, and a
           line coming in or leaving is cut there. Its view box is its own
           place in the chart, so it draws in the chart's units. -->
      <svg class="trace" x={CONNECTION_SPARKLINE_EDGE - 1} width={chartWidth - 2 * CONNECTION_SPARKLINE_EDGE + 2} height={CONNECTION_SPARKLINE_HEIGHT} viewBox={`${CONNECTION_SPARKLINE_EDGE - 1} 0 ${chartWidth - 2 * CONNECTION_SPARKLINE_EDGE + 2} ${CONNECTION_SPARKLINE_HEIGHT}`}>
        <g transform={`translate(${offset} 0)`}>
          {#each sparkline.paths as path}<path class="reading" d={path} />{/each}
          {#each sparkline.misses as x}<path class="miss" d={`M ${x} ${CONNECTION_SPARKLINE_MISS_TOP} L ${x} ${CONNECTION_SPARKLINE_MISS_BOTTOM}`} />{/each}
        </g>
      </svg>
    </svg>
    <div class="figures">
      <span>Latest <strong>{fmt(figures.latest)}</strong></span>
      <span>Median <strong>{fmt(figures.median)}</strong></span>
      <span>Worst <strong>{fmt(figures.worst)}</strong></span>
      <span>Since <strong>{connectionContactTime(health.last_contact)}</strong></span>
    </div>
  {/if}
</div>

<style>
  .connection-detail {
    box-sizing: border-box;
    width: 100%;
    color: var(--text-secondary);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .sparkline { display: block; width: 100%; margin: 6px 0; }
  .trace { overflow: hidden; }
  .baseline { fill: none; stroke: var(--border); stroke-width: 1; }
  .reading { fill: none; stroke: var(--text-secondary); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .miss { fill: none; stroke: var(--danger); stroke-width: 2; stroke-linecap: round; }
  /* One line of figures; a card too narrow for the four wraps it between
     figures, never inside one, so Since goes first to the next line. */
  .figures { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 8px; white-space: nowrap; }
  .figures strong { color: var(--text); font-weight: 600; }
  .redacted { display: inline-block; width: 8em; border-radius: 4px; color: transparent; user-select: none; background: repeating-linear-gradient(135deg, var(--text-secondary, #888) 0 2px, transparent 2px 4px); opacity: 0.55; }
</style>
