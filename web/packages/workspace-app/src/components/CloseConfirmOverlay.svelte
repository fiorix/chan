<script lang="ts">
  // The desktop red-dot close prompt. When the OS close button is pressed on a
  // live workspace/terminal window, the host prevents the close and evals an
  // `app.window.confirmClose` into the webview; App.svelte opens this overlay
  // (unless the window is empty or reconnecting, which close straight away).
  //
  // Modelled on DisconnectOverlay's card, but this is a DECISION, not a live
  // wait: no spinner, three actions, and it stacks above both the reconnect
  // overlay (30000) and the session-ended overlay (30001) at 30002. A red-dot is
  // a destructive request, so Close carries the --danger accent, Escape and the
  // default focus land on Cancel, and there is NO Enter-to-Close default button.
  //
  // Desktop-only by construction: `requestCloseWindow` / the hide IPC are no-ops
  // off desktop and the host only evals confirmClose in chan-desktop, so a plain
  // browser never opens this overlay.

  import {
    cancelCloseConfirmForConnectionChange,
    closeConfirmState,
    resolveCloseConfirm,
  } from "../state/closeConfirm.svelte";
  import { discardWindowSession, ui } from "../state/store.svelte";
  import {
    isTauriDesktop,
    requestCloseWindow,
    hideWindowFromCloseConfirm,
  } from "../api/desktop";

  let overlayEl: HTMLDivElement | null = $state(null);
  let cancelBtn: HTMLButtonElement | null = $state(null);
  let hideBtn: HTMLButtonElement | null = $state(null);
  let closeBtn: HTMLButtonElement | null = $state(null);

  const open = $derived(closeConfirmState.open);

  // A connection transition invalidates the native close request that opened
  // this prompt. Cancel immediately on both drop and recovery, before another
  // native window can leave this decision occluded. A prompt opened after the
  // socket is already down is cancelled by the second condition as well.
  let previousWs = ui.ws;
  $effect(() => {
    const ws = ui.ws;
    const connectionChanged = ws !== previousWs;
    previousWs = ws;
    if (connectionChanged || (open && ws !== "open")) {
      cancelCloseConfirmForConnectionChange();
    }
  });

  // Hide: bury the window (sessions stay warm, reopenable from the Window menu).
  function hide(): void {
    void hideWindowFromCloseConfirm();
    resolveCloseConfirm("hide");
  }

  // Close: discard this window's session blob (the server reaps its terminals)
  // and ask the host to destroy the window, so it leaves no hidden/empty row.
  function close(): void {
    discardWindowSession({ reap: true });
    if (isTauriDesktop()) void requestCloseWindow();
    resolveCloseConfirm("close");
  }

  // Cancel: the window is already prevent_closed and stays visible; just drop
  // the overlay. Escape maps here too.
  function cancel(): void {
    resolveCloseConfirm("cancel");
  }

  // Steal focus onto Cancel when the overlay appears: the backdrop stops clicks
  // but keystrokes still flow to whatever was focused (a terminal / editor), so
  // park focus on the safe default and trap Tab over the three buttons below.
  $effect(() => {
    if (!open) return;
    (document.activeElement as HTMLElement | null)?.blur();
    queueMicrotask(() => (cancelBtn ?? overlayEl)?.focus());
  });

  // Escape cancels; Tab/Shift+Tab cycle the three buttons and never leak focus
  // to the blocked UI behind the backdrop.
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
      return;
    }
    if (e.key !== "Tab") return;
    e.preventDefault();
    const order = [hideBtn, closeBtn, cancelBtn].filter(
      (b): b is HTMLButtonElement => b !== null,
    );
    if (order.length === 0) {
      overlayEl?.focus();
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    const idx = order.findIndex((b) => b === active);
    const step = e.shiftKey ? -1 : 1;
    const next = order[(idx + step + order.length) % order.length] ?? order[0];
    next.focus();
  }
</script>

{#if open}
  <div
    class="overlay"
    role="alertdialog"
    aria-modal="true"
    aria-label="Close this window?"
    tabindex="-1"
    bind:this={overlayEl}
    onkeydown={onKeydown}
  >
    <div class="card">
      <div class="title">close this window?</div>
      <div class="subline">
        Hide it to keep its tabs and terminals warm, or close to discard
      </div>
      <div class="actions">
        <button class="hide" bind:this={hideBtn} onclick={hide}> Hide </button>
        <button class="close" bind:this={closeBtn} onclick={close}> Close </button>
        <button class="cancel" bind:this={cancelBtn} onclick={cancel}> Cancel </button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Model on DisconnectOverlay: full-viewport backdrop, centered card, but a
     DECISION (no spinner) stacked ABOVE the reconnect (30000) and session-ended
     (30001) overlays, below the 39000/40000 menu band. */
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.62);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 30002;
    backdrop-filter: blur(2px);
  }
  .card {
    background: var(--bg-elev);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 14px 44px rgba(0, 0, 0, 0.5);
    padding: 18px 22px;
    max-width: 420px;
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .title {
    font-size: 16px;
    font-weight: 600;
  }
  .subline {
    font-size: 14px;
    color: var(--text-secondary);
    line-height: 1.4;
  }
  .actions {
    display: flex;
    gap: 10px;
    justify-content: center;
    margin-top: 4px;
  }
  .hide,
  .close,
  .cancel {
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 6px 14px;
    font: inherit;
    cursor: pointer;
  }
  .hide:hover,
  .cancel:hover {
    border-color: var(--link);
    color: var(--link);
  }
  /* Close discards the window's tabs + terminals: the destructive accent, and
     never the default focus / Enter target. */
  .close:hover {
    border-color: var(--danger);
    color: var(--danger);
  }
</style>
