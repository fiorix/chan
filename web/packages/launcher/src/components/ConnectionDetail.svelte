<script lang="ts">
  // A connected devserver's connection detail on its card in front: the last
  // 60 finished pings with a red mark at each miss, then one line of the
  // latest, median and worst reply times and the last contact to the second,
  // as Since. The face beside the name says the state, counting where it
  // counts, so the detail does not repeat it. In privacy mode it is concealed
  // behind the devserver's one connection reveal, the one beside its face.
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
    connectionSparkline,
    connectionSparklineWidth,
    formatConnectionMs,
  } from "../lib/connectionHealth";

  let { health, field }: { health: ConnectionHealth; field: string } = $props();

  const concealed = $derived(isConcealed(field));
  const figures = $derived(connectionFigures(health.samples));
  // The chart fills the detail's width at a fixed height, so it is drawn
  // for the width the detail has: measured at mount and on every resize,
  // which a ResizeObserver reports for the card and, without one, the
  // window's resize stands in for.
  let box: HTMLDivElement | undefined = $state();
  let boxWidth = $state(0);
  $effect(() => {
    const el = box;
    if (!el) return;
    const measure = (): void => {
      boxWidth = el.clientWidth;
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  });
  const chartWidth = $derived(connectionSparklineWidth(boxWidth));
  const sparkline = $derived(connectionSparkline(health.samples, chartWidth));
  const fmt = (ms: number | null) => ms === null ? "-" : formatConnectionMs(ms);
</script>

<div class="connection-detail" bind:this={box} data-face={health.face} role="group" aria-label="Connection details">
  {#if concealed}
    <span class="redacted" aria-label="connection details hidden">Hidden</span>
  {:else}
    <svg class="sparkline" viewBox={`0 0 ${chartWidth} ${CONNECTION_SPARKLINE_HEIGHT}`} style:height={`${CONNECTION_CHART_HEIGHT_PX}px`} role="img" aria-label="Recent reply times and missed pings">
      <path class="baseline" d={`M ${CONNECTION_SPARKLINE_EDGE} ${CONNECTION_SPARKLINE_BASELINE} L ${chartWidth - CONNECTION_SPARKLINE_EDGE} ${CONNECTION_SPARKLINE_BASELINE}`} />
      {#each sparkline.paths as path}<path class="reading" d={path} />{/each}
      {#each sparkline.misses as x}<path class="miss" d={`M ${x} ${CONNECTION_SPARKLINE_MISS_TOP} L ${x} ${CONNECTION_SPARKLINE_MISS_BOTTOM}`} />{/each}
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
  .baseline { fill: none; stroke: var(--border); stroke-width: 1; }
  .reading { fill: none; stroke: var(--text-secondary); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .miss { fill: none; stroke: var(--danger); stroke-width: 2; stroke-linecap: round; }
  /* One line of figures; a card too narrow for the four wraps it between
     figures, never inside one, so Since goes first to the next line. */
  .figures { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 8px; white-space: nowrap; }
  .figures strong { color: var(--text); font-weight: 600; }
  .redacted { display: inline-block; width: 8em; border-radius: 4px; color: transparent; user-select: none; background: repeating-linear-gradient(135deg, var(--text-secondary, #888) 0 2px, transparent 2px 4px); opacity: 0.55; }
</style>
