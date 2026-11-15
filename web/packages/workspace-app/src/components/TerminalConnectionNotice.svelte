<script lang="ts">
  import { APP_STATUS_PILL_SELECTOR, terminalNoticeTop } from "./terminalNoticePlacement";

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
  const defaultTop = $derived(findOpen ? 50 : 5);
  const shown = $derived(mode !== "none");
  let placedTop = $state<number | null>(null);
  let pill = $state<HTMLDivElement | null>(null);
  let requestMeasure: () => void = () => {};

  $effect(() => {
    if (!shown || !pill) {
      placedTop = null;
      return;
    }
    const currentPill: HTMLDivElement = pill;

    let frame = 0;
    let observedStatus: HTMLElement | null = null;
    let sizes: ResizeObserver | null = null;

    function measure(): void {
      const notice = currentPill.getBoundingClientRect();
      const currentTop = Number.parseFloat(currentPill.style.top) || 0;
      const top = defaultTop;
      const offset = top - currentTop;
      const defaultBox = {
        left: notice.left,
        right: notice.right,
        top: notice.top + offset,
        bottom: notice.bottom + offset,
      };
      const status = document.querySelector<HTMLElement>(APP_STATUS_PILL_SELECTOR);
      if (status !== observedStatus) {
        if (observedStatus) sizes?.unobserve(observedStatus);
        if (status) sizes?.observe(status);
        observedStatus = status;
      }
      placedTop = terminalNoticeTop(defaultBox, status?.getBoundingClientRect() ?? null, top);
    }

    function schedule(): void {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    }

    // Child and style changes outside the terminal can move a pane without resizing it.
    // A ResizeObserver on both pills covers text width changes, so terminal pixels need no watch.
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        const main = target?.closest(".terminal-main");
        return !main || target === main;
      })) schedule();
    });
    mutations.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    sizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    sizes?.observe(currentPill);
    if (currentPill.parentElement) sizes?.observe(currentPill.parentElement);
    window.addEventListener("resize", schedule);
    requestMeasure = measure;

    return () => {
      requestMeasure = () => {};
      if (frame) cancelAnimationFrame(frame);
      mutations.disconnect();
      sizes?.disconnect();
      window.removeEventListener("resize", schedule);
    };
  });

  $effect(() => {
    if (!shown || !pill) return;
    void defaultTop;
    void inspectorOpen;
    void inspectorWidth;
    requestMeasure();
  });
</script>

<span class="sr-only" role="status">{mode === "lost" ? lostSentence : mode === "stalled" ? "Terminal connection stalled. Waiting for the connection." : mode === "notice" ? "Reconnected. Input typed while disconnected may not have been sent." : ""}</span>
{#if mode !== "none"}
  <!-- The inspector box extends 12px past its width; 17px more leaves a 5px gap beside the pill. -->
  <div
    bind:this={pill}
    class="terminal-connection-pill"
    data-terminal-connection-pill
    aria-hidden="true"
    style:pointer-events="none"
    style:top={`${placedTop ?? defaultTop}px`}
    style:right={inspectorOpen ? `${inspectorWidth + 29}px` : "5px"}
    style:max-width={inspectorOpen ? `min(70%, 36rem, calc(100% - ${inspectorWidth + 34}px))` : "min(70%, 36rem)"}
  >
    {#if mode === "lost"}{lostSentence}{:else if mode === "stalled"}No response for {seconds} s. Waiting for the connection.{:else}Reconnected. Input typed while disconnected may not have been sent.{/if}
  </div>
{/if}

<style>
  .terminal-connection-pill {
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
