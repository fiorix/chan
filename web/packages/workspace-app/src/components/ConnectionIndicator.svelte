<script lang="ts">
  // One window-level connection control serves the title band and the
  // ambient status pill; the parent chooses its placement.
  import { formatConnectionMs, connectionHealth, connectionIsRemote, connectionLabel } from "../state/connectionHealth.svelte";
  import {
    CONNECTION_SPARKLINE_BASELINE,
    CONNECTION_SPARKLINE_EDGE,
    CONNECTION_SPARKLINE_HEIGHT,
    CONNECTION_SPARKLINE_MISS_BOTTOM,
    CONNECTION_SPARKLINE_MISS_TOP,
    CONNECTION_SPARKLINE_WIDTH,
    connectionContactTime,
    connectionFigures,
    connectionIndicatorShown,
    connectionSparkline,
    connectionStateAge,
    type ConnectionIndicatorPlacement,
    connectionIndicatorLabelCh,
  } from "./connectionIndicatorMath";
  import { clampMenu, triggerMenuX } from "./menuClamp";
  import { menuEscape } from "./menuEscape";
  import { portal } from "./portal";
  import { appInputBlocked } from "../state/store.svelte";

  let { placement }: { placement: ConnectionIndicatorPlacement } = $props();

  // The window's transport identity is fixed for this component's lifetime.
  const remote = connectionIsRemote();
  const visible = $derived(connectionIndicatorShown(placement, connectionHealth.state, remote));
  const blocked = $derived(appInputBlocked());
  const label = $derived(connectionLabel(connectionHealth.state, connectionHealth.rttMs, connectionHealth.waitMs));
  const labelCh = $derived(connectionIndicatorLabelCh(connectionHealth.state));
  const name = $derived.by(() => {
    switch (connectionHealth.state) {
      case "ok": return "Connection healthy";
      case "unknown": return "Connection status unknown";
      case "slow": {
        if (!label) return "Connection recovering";
        const rtt = connectionHealth.rttMs;
        return rtt !== null && rtt >= connectionHealth.waitMs
          ? `Connection slow, ${formatConnectionMs(rtt)}`
          : "Connection slow, waiting for a reply";
      }
      case "stalled": return "Connection stalled";
      case "down": return "Connection lost, reconnecting";
    }
  });
  const figures = $derived(connectionFigures(connectionHealth.samples));
  const sparkline = $derived(connectionSparkline(connectionHealth.samples));
  const fmt = (ms: number | null) => ms === null ? "-" : formatConnectionMs(ms);
  const POPOVER_WIDTH = 240;
  const popoverId = $props.id();

  let open = $state(false);
  let now = $state(Date.now());
  let trigger: HTMLButtonElement | null = $state(null);
  let popover: HTMLDivElement | null = $state(null);
  let anchor = $state({ x: 0, y: 0 });
  const keys = menuEscape({
    open: () => open,
    // The details hold no field that needs Escape before the app sees it.
    inside: () => false,
    close: () => { open = false; },
  });

  // Pressing details should not take terminal or editor focus. An action avoids
  // Svelte's a11y_no_noninteractive_element_interactions warning on a group.
  function preserveFocus(node: HTMLElement): { destroy(): void } {
    const prevent = (event: MouseEvent) => event.preventDefault();
    node.addEventListener("mousedown", prevent);
    return { destroy: () => node.removeEventListener("mousedown", prevent) };
  }

  function toggle(): void {
    if (blocked) return;
    if (open) {
      open = false;
      return;
    }
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    anchor = { x: triggerMenuX(rect, POPOVER_WIDTH), y: rect.bottom + 6 };
    now = Date.now();
    open = true;
  }

  // A local connection can turn healthy while the bubble is open. Close it so a
  // later slow spell cannot restore a stale open state.
  $effect(() => {
    if (!visible || blocked) open = false;
  });

  $effect(() => {
    if (!open) return;
    const timer = setInterval(() => { now = Date.now(); }, 1000);
    const outside = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) return;
      if (trigger?.contains(event.target) || popover?.contains(event.target)) return;
      open = false;
    };
    // Capture sees drag-region presses and controls that stop the bubble phase.
    window.addEventListener("mousedown", outside, true);
    window.addEventListener("keydown", keys.capture, true);
    return () => {
      clearInterval(timer);
      window.removeEventListener("mousedown", outside, true);
      window.removeEventListener("keydown", keys.capture, true);
    };
  });
</script>

{#if visible}
  <button
    bind:this={trigger}
    class="connection-indicator"
    data-placement={placement}
    data-state={connectionHealth.state}
    type="button"
    aria-label={name}
    title={name}
    aria-controls={popoverId}
    aria-expanded={open}
    aria-disabled={blocked}
    style:--connection-indicator-label-width={placement === "tab-bar" && labelCh > 0 ? `${labelCh}ch` : undefined}
    onmousedown={(event) => event.preventDefault()}
    onclick={toggle}
  >
    <svg class="glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
      <path d="M2.5 11v2M6 8v5M9.5 5v8M13 2v11" />
    </svg>
    {#if label || (placement === "tab-bar" && connectionHealth.state === "slow")}<span class="label">{label}</span>{/if}
  </button>
{/if}

{#if visible && open}
  <div id={popoverId} class="connection-popover" bind:this={popover} role="group" aria-label="Connection details" style:width={`${POPOVER_WIDTH}px`} use:preserveFocus use:clampMenu={anchor} use:portal>
    <div class="state-age">{connectionStateAge(connectionHealth.state, connectionHealth.since, now, connectionHealth.waitMs)}</div>
    <svg class="sparkline" viewBox={`0 0 ${CONNECTION_SPARKLINE_WIDTH} ${CONNECTION_SPARKLINE_HEIGHT}`} role="img" aria-label="Recent round-trip times and missed pings">
      <path class="baseline" d={`M ${CONNECTION_SPARKLINE_EDGE} ${CONNECTION_SPARKLINE_BASELINE} L ${CONNECTION_SPARKLINE_WIDTH - CONNECTION_SPARKLINE_EDGE} ${CONNECTION_SPARKLINE_BASELINE}`} />
      {#each sparkline.paths as path}<path class="reading" d={path} />{/each}
      {#each sparkline.misses as x}<path class="miss" d={`M ${x} ${CONNECTION_SPARKLINE_MISS_TOP} L ${x} ${CONNECTION_SPARKLINE_MISS_BOTTOM}`} />{/each}
    </svg>
    <div class="figures">
      <span>Latest <strong>{fmt(figures.latest)}</strong></span>
      <span>Median <strong>{fmt(figures.median)}</strong></span>
      <span>Worst <strong>{fmt(figures.worst)}</strong></span>
    </div>
    <div class="contact">Last contact <strong>{connectionContactTime(connectionHealth.lastContactAt)}</strong></div>
  </div>
{/if}

<style>
  .connection-indicator {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: none;
    height: 24px;
    padding: 0 5px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    cursor: pointer;
  }
  .connection-indicator[aria-disabled="true"] { cursor: default; }
  .connection-indicator:not([aria-disabled="true"]):hover { background: var(--hover-bg); }
  .connection-indicator[data-placement="status"]:not([aria-disabled="true"]):hover { background: transparent; text-decoration: underline; text-underline-offset: 2px; }
  .connection-indicator:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
  .connection-indicator[data-state="unknown"] { opacity: 0.6; }
  .connection-indicator[data-state="slow"] { color: var(--warn-text); }
  .connection-indicator[data-state="stalled"], .connection-indicator[data-state="down"] { color: var(--danger-text); }
  .connection-indicator[data-placement="status"] { height: auto; padding: 0; }
  .connection-indicator[data-placement="tab-bar"] .label { display: inline-block; min-width: var(--connection-indicator-label-width); text-align: left; }
  .glyph { width: 16px; height: 16px; flex: none; }
  .connection-popover {
    position: fixed;
    /* Shares the menus' layer, above the status pill and below the reconnect cover. */
    z-index: 29000;
    box-sizing: border-box;
    max-width: calc(100vw - 16px);
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-card);
    color: var(--text);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .state-age { font-weight: 600; }
  .sparkline { display: block; width: 100%; height: auto; margin: 8px 0; }
  .baseline { fill: none; stroke: var(--border); stroke-width: 1; }
  .reading { fill: none; stroke: var(--text-secondary); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .miss { fill: none; stroke: var(--danger-text); stroke-width: 2; stroke-linecap: round; }
  .figures { display: flex; justify-content: space-between; gap: 5px; }
  .figures span { display: grid; gap: 3px; color: var(--text-secondary); }
  strong { color: var(--text); font-weight: 600; }
  .contact { display: flex; justify-content: space-between; margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border); color: var(--text-secondary); }
  @media (prefers-reduced-motion: no-preference) {
    .connection-indicator { transition: opacity 120ms ease; }
  }
</style>
