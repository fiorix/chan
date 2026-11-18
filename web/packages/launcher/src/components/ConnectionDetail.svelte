<script lang="ts">
  // A connected devserver's connection detail on its card in front: how long
  // the face has held, the last 60 finished pings with the misses as gaps,
  // the latest, median and worst reply times, and the last contact to the
  // second. In privacy mode it is concealed behind the devserver's one
  // connection reveal, the one beside its face.
  import { isConcealed } from "@chan/web-shared/privacy";
  import type { ConnectionHealth } from "../api/library";
  import {
    CONNECTION_SPARKLINE_BASELINE,
    CONNECTION_SPARKLINE_EDGE,
    CONNECTION_SPARKLINE_HEIGHT,
    CONNECTION_SPARKLINE_MISS_BOTTOM,
    CONNECTION_SPARKLINE_MISS_TOP,
    CONNECTION_SPARKLINE_WIDTH,
    connectionContactTime,
    connectionFigures,
    connectionSparkline,
    connectionStateAge,
    formatConnectionMs,
  } from "../lib/connectionHealth";

  let { health, now, field }: { health: ConnectionHealth; now: number; field: string } = $props();

  const concealed = $derived(isConcealed(field));
  const figures = $derived(connectionFigures(health.samples));
  const sparkline = $derived(connectionSparkline(health.samples));
  const fmt = (ms: number | null) => ms === null ? "-" : formatConnectionMs(ms);
</script>

<div class="connection-detail" data-face={health.face} role="group" aria-label="Connection details">
  {#if concealed}
    <span class="redacted" aria-label="connection details hidden">Hidden</span>
  {:else}
    <div class="state-age">{connectionStateAge(health, now)}</div>
    <svg class="sparkline" viewBox={`0 0 ${CONNECTION_SPARKLINE_WIDTH} ${CONNECTION_SPARKLINE_HEIGHT}`} role="img" aria-label="Recent reply times and missed pings">
      <path class="baseline" d={`M ${CONNECTION_SPARKLINE_EDGE} ${CONNECTION_SPARKLINE_BASELINE} L ${CONNECTION_SPARKLINE_WIDTH - CONNECTION_SPARKLINE_EDGE} ${CONNECTION_SPARKLINE_BASELINE}`} />
      {#each sparkline.paths as path}<path class="reading" d={path} />{/each}
      {#each sparkline.misses as x}<path class="miss" d={`M ${x} ${CONNECTION_SPARKLINE_MISS_TOP} L ${x} ${CONNECTION_SPARKLINE_MISS_BOTTOM}`} />{/each}
    </svg>
    <div class="figures">
      <span>Latest <strong>{fmt(figures.latest)}</strong></span>
      <span>Median <strong>{fmt(figures.median)}</strong></span>
      <span>Worst <strong>{fmt(figures.worst)}</strong></span>
    </div>
    <div class="contact">Last contact <strong>{connectionContactTime(health.last_contact)}</strong></div>
  {/if}
</div>

<style>
  .connection-detail {
    box-sizing: border-box;
    width: 100%;
    max-width: 260px;
    color: var(--text-secondary);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .state-age { color: var(--text); font-weight: 600; }
  .sparkline { display: block; width: 100%; height: auto; margin: 6px 0; }
  .baseline { fill: none; stroke: var(--border); stroke-width: 1; }
  .reading { fill: none; stroke: var(--text-secondary); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .miss { fill: none; stroke: var(--danger); stroke-width: 2; stroke-linecap: round; }
  .figures { display: flex; justify-content: space-between; gap: 8px; white-space: nowrap; }
  .figures strong, .contact strong { color: var(--text); font-weight: 600; }
  .contact { margin-top: 4px; }
  .redacted { display: inline-block; width: 8em; border-radius: 4px; color: transparent; user-select: none; background: repeating-linear-gradient(135deg, var(--text-secondary, #888) 0 2px, transparent 2px 4px); opacity: 0.55; }
</style>
