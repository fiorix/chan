<!-- The corner card a request notification shows (a `cs paste` read, a session
     handover): a title with a close button, the owner's body text, and a
     confirm and a cancel button. Its owner stays mounted while requests come
     and go and passes `requestId` as null between them; the card then renders
     nothing. While `busy` an answer is on its way and the three buttons and
     both keys are off. -->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { createCardFocus } from "./cardFocus";

  let {
    label,
    title,
    closeLabel,
    confirmLabel,
    cancelLabel,
    busy,
    requestId,
    manageFocus = true,
    onConfirm,
    onCancel,
    children,
  }: {
    // The dialog's accessible name.
    label: string;
    title: string;
    // The close button's accessible name; closing cancels.
    closeLabel: string;
    confirmLabel: string;
    cancelLabel: string;
    busy: boolean;
    requestId: string | null;
    manageFocus?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
    children: Snippet;
  } = $props();

  // Steal focus to the card on appear so Enter / Escape land here, not in the
  // terminal or editor underneath, and give it back when the card goes. Keyed
  // on requestId so a replacing request re-focuses.
  let card = $state<HTMLDivElement | null>(null);
  const focus = createCardFocus();
  $effect(() => {
    if (!manageFocus) return;
    if (requestId && card) focus.take(card);
    else if (requestId === null) focus.release();
  });

  // Enter confirms, Escape cancels. Scoped to the focused card (not the window)
  // so a focused terminal does not swallow the key into its PTY and a handled
  // Escape does not bubble out to close other overlays. A keydown carries
  // user activation just like a click, so a confirm that needs a gesture (the
  // paste's clipboard read) stays gesture-bound.
  function onKeydown(e: KeyboardEvent): void {
    if (requestId === null || busy) return;
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      onConfirm();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  }
</script>

{#if requestId !== null}
  <div class="request-card" role="dialog" aria-label={label}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="rc-card" tabindex="-1" bind:this={card} onkeydown={onKeydown}>
      <div class="rc-head">
        <span class="rc-title">{title}</span>
        <button
          class="rc-close"
          type="button"
          aria-label={closeLabel}
          disabled={busy}
          onclick={() => onCancel()}>×</button
        >
      </div>
      <p class="rc-body">{@render children()}</p>
      <div class="rc-actions">
        <button
          class="rc-action rc-confirm"
          type="button"
          disabled={busy}
          onclick={() => onConfirm()}>{confirmLabel}</button
        >
        <button
          class="rc-action"
          type="button"
          disabled={busy}
          onclick={() => onCancel()}>{cancelLabel}</button
        >
      </div>
    </div>
  </div>
{/if}

<style>
  .request-card {
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
  .rc-card {
    outline: none;
  }
  .request-card:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .rc-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.4rem 0.6rem;
    border-bottom: 1px solid var(--border);
  }
  .rc-title {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text);
  }
  .rc-close {
    border: none;
    background: none;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    padding: 0 0.2rem;
  }
  .rc-close:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .rc-body {
    margin: 0;
    padding: 0.6rem;
    font-size: 0.8rem;
    line-height: 1.4;
    color: var(--text-secondary);
  }
  /* The body's markup is the owner's, so its emphasis carries the owner's
     scope and not this component's. */
  .rc-body :global(strong) {
    color: var(--text);
  }
  .rc-actions {
    display: flex;
    gap: 0.5rem;
    padding: 0 0.6rem 0.6rem;
  }
  .rc-action {
    flex: 1 1 auto;
    border: 1px solid var(--btn-border);
    border-radius: 6px;
    background: var(--btn-bg);
    color: var(--text-secondary);
    font-size: 0.78rem;
    padding: 0.3rem 0.5rem;
    cursor: pointer;
  }
  .rc-action:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--brand);
  }
  .rc-action:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .rc-confirm {
    border-color: var(--accent);
    color: var(--text);
  }
</style>
