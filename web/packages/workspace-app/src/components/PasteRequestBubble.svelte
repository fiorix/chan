<!-- Paste-request notification for `cs paste`.

     When a `clipboard_read` window command's immediate read is still pending
     past the threshold (a browser paste-permission prompt nobody clicked),
     this corner card (the SessionHandoverBubble shell) says what the CLI is
     waiting for. [Paste] runs ONE clipboard access inside the click's user
     activation; [Cancel] (also Escape / close) answers the blocked CLI
     immediately with an error instead of leaving it to the 30s timeout. The
     card dismisses when its request's reply lands (whichever path answered
     first; the window bus is once-only, later replies 404 harmlessly). Not
     persisted: a reload leaves the CLI to the server-side timeout. Mounted
     once at the App root. -->
<script lang="ts">
  import {
    pasteRequestState,
    confirmPasteCard,
    cancelPasteCard,
  } from "../state/pasteRequest.svelte";
  import { createCardFocus } from "./cardFocus";

  const active = $derived(pasteRequestState.card);

  // Steal focus to the card on appear so Enter / Escape land here, not in the
  // terminal or editor underneath, and give it back when the card goes. Keyed
  // on requestId so a replacing request re-focuses.
  let card = $state<HTMLDivElement | null>(null);
  const focus = createCardFocus();
  $effect(() => {
    if (active?.requestId && card) focus.take(card);
    else if (!active) focus.release();
  });

  // Enter pastes, Escape cancels. Scoped to the focused card (not the window)
  // so a focused terminal does not swallow the key into its PTY and a handled
  // Escape does not bubble out to close other overlays. A keydown carries
  // user activation just like a click, so the paste read stays gesture-bound.
  function onKeydown(e: KeyboardEvent): void {
    if (!active || active.busy) return;
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      void confirmPasteCard();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      void cancelPasteCard();
    }
  }
</script>

{#if active}
  <div class="paste-bubble" role="dialog" aria-label="Paste request">
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="pb-card" tabindex="-1" bind:this={card} onkeydown={onKeydown}>
      <div class="pb-head">
        <span class="pb-title">cs paste</span>
        <button
          class="pb-close"
          type="button"
          aria-label="Cancel paste"
          disabled={active.busy}
          onclick={() => cancelPasteCard()}>×</button
        >
      </div>
      <p class="pb-body">
        <strong>cs paste</strong> is waiting for this window's clipboard.
      </p>
      <div class="pb-actions">
        <button
          class="pb-action pb-paste"
          type="button"
          disabled={active.busy}
          onclick={() => confirmPasteCard()}>Paste</button
        >
        <button
          class="pb-action"
          type="button"
          disabled={active.busy}
          onclick={() => cancelPasteCard()}>Cancel</button
        >
      </div>
    </div>
  </div>
{/if}

<style>
  .paste-bubble {
    position: fixed;
    bottom: 2rem;
    right: 0.6rem;
    z-index: 41;
    width: 22rem;
    max-width: calc(100vw - 1.2rem);
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 9px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.28);
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .pb-card {
    outline: none;
  }
  .pb-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.4rem 0.6rem;
    border-bottom: 1px solid var(--border);
  }
  .pb-title {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text);
  }
  .pb-close {
    border: none;
    background: none;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    padding: 0 0.2rem;
  }
  .pb-close:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .pb-body {
    margin: 0;
    padding: 0.6rem;
    font-size: 0.8rem;
    line-height: 1.4;
    color: var(--text-secondary);
  }
  .pb-body strong {
    color: var(--text);
  }
  .pb-actions {
    display: flex;
    gap: 0.5rem;
    padding: 0 0.6rem 0.6rem;
  }
  .pb-action {
    flex: 1 1 auto;
    border: 1px solid var(--btn-border);
    border-radius: 6px;
    background: var(--btn-bg);
    color: var(--text-secondary);
    font-size: 0.78rem;
    padding: 0.3rem 0.5rem;
    cursor: pointer;
  }
  .pb-action:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--brand);
  }
  .pb-action:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .pb-paste {
    border-color: var(--accent);
    color: var(--text);
  }
</style>
