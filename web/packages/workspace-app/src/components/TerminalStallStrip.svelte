<script lang="ts">
  let { visible, waitMs }: { visible: boolean; waitMs: number } = $props();
  const seconds = $derived(Math.floor(waitMs / 1000));
</script>

<span class="sr-only" role="status">{visible ? "Terminal connection stalled. Waiting for the connection." : ""}</span>
{#if visible}
  <div class="terminal-stall-strip" data-terminal-stall-strip aria-hidden="true" style:pointer-events="none">No response for {seconds} s. Waiting for the connection.</div>
{/if}

<style>
  .terminal-stall-strip {
    position: absolute;
    inset: 0 0 auto;
    /* Above terminal pixels, below find, inspector and consent overlays. */
    z-index: 20;
    pointer-events: none;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-card);
    color: var(--text);
    font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-variant-numeric: tabular-nums;
    text-align: left;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
