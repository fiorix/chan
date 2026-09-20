<script lang="ts">
  // Terminal overlay shown when the session leader closes or hides THIS window
  // from the launcher. The window's record is gone (or hidden) server-side, so
  // there is nothing to reconnect to: unlike DisconnectOverlay this is a dead
  // end, not a live wait, and it stacks above the reconnect overlay. Web-only (a
  // native desktop window is torn down by the watcher and never reaches here).

  import { onDestroy } from "svelte";
  import { windowLifecycle } from "../state/windowLifecycle.svelte";
  import { setCoverBlocking } from "../state/store.svelte";

  let overlayEl: HTMLDivElement | null = $state(null);
  let closeBtn: HTMLButtonElement | null = $state(null);

  const ended = $derived(windowLifecycle.ended);

  // A cover hides the app but not its keyboard: the global handlers are
  // document-level and fire whatever has focus. Register the block for as
  // long as this surface is up, and release it on teardown so a stale one
  // cannot outlive the cover.
  $effect(() => {
    setCoverBlocking("session-ended", ended !== null);
  });
  onDestroy(() => setCoverBlocking("session-ended", false));

  const title = $derived(
    ended === "hidden" ? "hidden by the session leader" : "closed by the session leader",
  );
  const subline = $derived(
    ended === "hidden"
      ? "the leader hid this window; reopen it from the launcher"
      : "the leader closed this window; reopen it from the launcher",
  );

  // Steal focus so keystrokes don't leak to the dead buffer behind the backdrop.
  $effect(() => {
    if (!ended) return;
    (document.activeElement as HTMLElement | null)?.blur();
    queueMicrotask(() => (closeBtn ?? overlayEl)?.focus());
  });

  // Best-effort self-close. window.close() only acts on a script-opened window
  // (the launcher's window.open targets); a directly-navigated tab ignores it and
  // the user closes it themselves, so the overlay simply stays.
  function closeWindow(): void {
    try {
      window.close();
    } catch {
      /* not script-closable; the user closes the tab */
    }
  }

  function trapTab(e: KeyboardEvent): void {
    if (e.key !== "Tab") return;
    e.preventDefault();
    closeBtn?.focus();
  }
</script>

{#if ended}
  <div
    class="overlay"
    role="alertdialog"
    aria-modal="true"
    aria-live="assertive"
    aria-label={title}
    tabindex="-1"
    bind:this={overlayEl}
    onkeydown={trapTab}
  >
    <div class="card">
      <div class="title">{title}</div>
      <div class="subline">{subline}</div>
      <div class="actions">
        <button class="close" bind:this={closeBtn} onclick={closeWindow}> Close window </button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Model on DisconnectOverlay: full-viewport backdrop, centered card, but a
     terminal state (no spinner) stacked ABOVE the reconnect overlay (30000). */
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.62);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 30001;
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
  .close {
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 6px 14px;
    font: inherit;
    cursor: pointer;
  }
  .close:hover {
    border-color: var(--link);
    color: var(--link);
  }
</style>
