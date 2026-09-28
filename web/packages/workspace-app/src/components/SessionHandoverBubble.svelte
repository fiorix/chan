<!-- Handover-request notification for `cs session handover`.

     The leader's window gets a `handover_prompt` window command when a follower
     asks to take leadership; this corner card (the downloads-notification shell)
     shows who is asking, with Accept / Reject. Like the survey overlay, EVERY
     exit (Accept, Reject, Escape, close) is a real reply that POSTs to
     /api/session/handover/reply and unblocks the requester's blocked CLI, so a
     stray close can never hang it. Not persisted: a reload resolves the request
     server-side as a timeout. Mounted once at the App root. -->
<script lang="ts">
  import { sessionState, acceptHandover, rejectHandover } from "../state/session.svelte";
  import { createCardFocus } from "./cardFocus";

  const active = $derived(sessionState.handover);

  // Steal focus to the card on appear so Enter / Escape land here, not in the
  // terminal or editor underneath, and give it back when the card goes. Keyed
  // on requestId so a replacing request re-focuses.
  let card = $state<HTMLDivElement | null>(null);
  const focus = createCardFocus();
  $effect(() => {
    if (active?.requestId && card) focus.take(card);
    else if (!active) focus.release();
  });

  // Enter accepts, Escape rejects. Scoped to the focused card (not the window)
  // so a focused terminal does not swallow the key into its PTY and a handled
  // Escape does not bubble out to close other overlays.
  function onKeydown(e: KeyboardEvent): void {
    if (!active || active.busy) return;
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      void acceptHandover();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      void rejectHandover();
    }
  }
</script>

{#if active}
  <div class="handover-bubble" role="dialog" aria-label="Handover request">
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="hb-card" tabindex="-1" bind:this={card} onkeydown={onKeydown}>
      <div class="hb-head">
        <span class="hb-title">Handover request</span>
        <button
          class="hb-close"
          type="button"
          aria-label="Reject handover"
          disabled={active.busy}
          onclick={() => rejectHandover()}>×</button
        >
      </div>
      <p class="hb-body">
        <strong>{active.fromName ?? active.fromWindowId}</strong> wants to become the
        session leader.
      </p>
      <div class="hb-actions">
        <button
          class="hb-action hb-accept"
          type="button"
          disabled={active.busy}
          onclick={() => acceptHandover()}>Accept</button
        >
        <button
          class="hb-action"
          type="button"
          disabled={active.busy}
          onclick={() => rejectHandover()}>Reject</button
        >
      </div>
    </div>
  </div>
{/if}

<style>
  .handover-bubble {
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
  .hb-card {
    outline: none;
  }
  .hb-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.4rem 0.6rem;
    border-bottom: 1px solid var(--border);
  }
  .hb-title {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text);
  }
  .hb-close {
    border: none;
    background: none;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    padding: 0 0.2rem;
  }
  .hb-close:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .hb-body {
    margin: 0;
    padding: 0.6rem;
    font-size: 0.8rem;
    line-height: 1.4;
    color: var(--text-secondary);
  }
  .hb-body strong {
    color: var(--text);
  }
  .hb-actions {
    display: flex;
    gap: 0.5rem;
    padding: 0 0.6rem 0.6rem;
  }
  .hb-action {
    flex: 1 1 auto;
    border: 1px solid var(--btn-border);
    border-radius: 6px;
    background: var(--btn-bg);
    color: var(--text-secondary);
    font-size: 0.78rem;
    padding: 0.3rem 0.5rem;
    cursor: pointer;
  }
  .hb-action:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--brand);
  }
  .hb-action:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .hb-accept {
    border-color: var(--accent);
    color: var(--text);
  }
</style>
