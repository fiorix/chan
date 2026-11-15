<script lang="ts">
  let {
    stalled,
    lost,
    notice,
    waitMs,
    findOpen,
    inspectorOpen,
    inspectorWidth,
  }: {
    stalled: boolean;
    lost: boolean;
    notice: boolean;
    waitMs: number;
    findOpen: boolean;
    inspectorOpen: boolean;
    inspectorWidth: number;
  } = $props();
  const seconds = $derived(Math.floor(waitMs / 1000));
  const mode = $derived(lost ? "lost" : stalled ? "stalled" : notice ? "notice" : "none");
  const lostSentence = "Connection lost. Typing is not being sent until it reconnects.";
</script>

<span class="sr-only" role="status">{mode === "lost" ? lostSentence : mode === "stalled" ? "Terminal connection stalled. Waiting for the connection." : mode === "notice" ? "Reconnected. Input typed while disconnected may not have been sent." : ""}</span>
{#if mode !== "none"}
  <!-- The inspector box extends 12px past its width; 17px more leaves a 5px gap beside the pill. -->
  <div
    class="terminal-link-pill"
    data-terminal-link-pill
    aria-hidden="true"
    style:pointer-events="none"
    style:top={findOpen ? "50px" : "5px"}
    style:right={inspectorOpen ? `${inspectorWidth + 29}px` : "5px"}
    style:max-width={inspectorOpen ? `min(70%, 36rem, calc(100% - ${inspectorWidth + 34}px))` : "min(70%, 36rem)"}
  >
    {#if mode === "lost"}{lostSentence}{:else if mode === "stalled"}No response for {seconds} s. Waiting for the connection.{:else}Reconnected. Input typed while disconnected may not have been sent.{/if}
  </div>
{/if}

<style>
  .terminal-link-pill {
    position: absolute;
    top: 5px;
    right: 5px;
    /* Above terminal pixels, below find, inspector and consent overlays. */
    z-index: 20;
    width: max-content;
    max-width: min(70%, 36rem);
    box-sizing: border-box;
    pointer-events: none;
    padding: 5px 9px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-card);
    color: var(--text);
    font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-variant-numeric: tabular-nums;
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
