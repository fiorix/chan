<script lang="ts">
  // The single global bulk-action bar, docked to the bottom of the window. It is
  // visible whenever the checkboxes are (select mode, or any row selected); it
  // reads the whole selection (a combined count across local workspaces, served
  // workspaces, and devservers) and its buttons drive the global ops -- Turn On /
  // Turn Off (per-kind under the hood) and an ordered cross-kind Remove behind an
  // inline confirm. Leaving select mode (the top-bar toggle) clears + hides it.
  // The single-row quick actions stay the per-item path.
  import {
    selection,
    selectedCount,
    checksVisible,
    bulkSetOnAll,
    requestBulkDelete,
    cancelBulkDelete,
    confirmBulkDelete,
  } from "../state/selection.svelte";
  import { Power, Trash } from "@lucide/svelte";

  const count = $derived(selectedCount());
  const visible = $derived(checksVisible());
  const confirming = $derived(selection.confirmingDelete);
</script>

{#if visible}
  <div class="bulk-bar" role="toolbar" aria-label="Bulk actions">
    <span class="bulk-count">
      {count > 0 ? `${count} selected` : "Select workspaces or servers"}
    </span>
    <div class="bulk-spacer"></div>
    {#if confirming}
      <span class="bulk-confirm">Remove {count}?</span>
      <button
        class="bulk-btn danger"
        type="button"
        disabled={selection.busy}
        onclick={confirmBulkDelete}>Confirm remove</button>
      <button class="bulk-btn" type="button" onclick={cancelBulkDelete}>Cancel</button>
    {:else}
      <button
        class="bulk-btn accent"
        type="button"
        disabled={selection.busy || count === 0}
        onclick={() => bulkSetOnAll(true)}>
        <Power size={15} />
        Turn on
      </button>
      <button
        class="bulk-btn"
        type="button"
        disabled={selection.busy || count === 0}
        onclick={() => bulkSetOnAll(false)}>
        <Power size={15} />
        Turn off
      </button>
      <button
        class="bulk-btn danger"
        type="button"
        disabled={selection.busy || count === 0}
        onclick={requestBulkDelete}>
        <Trash size={15} />
        Remove
      </button>
    {/if}
    {#if selection.note}<span class="bulk-note">{selection.note}</span>{/if}
  </div>
{/if}

<style>
  /* Docked to the bottom of the viewport, above the content; App adds a spacer
     in select mode so the last rows clear the bar. */
  .bulk-bar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 40;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.75rem 1.25rem;
    border-top: 1px solid var(--border);
    background: var(--bg-elev);
    box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.25);
    font-size: 0.85rem;
  }

  .bulk-spacer {
    flex: 1;
  }

  .bulk-count,
  .bulk-confirm {
    font-weight: 600;
    color: var(--text);
  }

  .bulk-note {
    color: var(--danger);
  }

  .bulk-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.8rem;
    border: 1px solid var(--btn-border);
    border-radius: 8px;
    background: var(--btn-bg);
    color: var(--text-secondary);
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
    transition:
      border-color 160ms ease,
      background 160ms ease,
      color 160ms ease;
  }

  .bulk-btn:hover:not(:disabled) {
    border-color: var(--brand);
    color: var(--text);
  }

  .bulk-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .bulk-btn.accent {
    border-color: color-mix(in srgb, var(--accent) 42%, transparent);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
  }

  .bulk-btn.danger {
    border-color: color-mix(in srgb, var(--danger) 40%, transparent);
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    color: var(--danger);
  }

  .bulk-btn.danger:hover:not(:disabled) {
    border-color: var(--danger);
    background: color-mix(in srgb, var(--danger) 20%, transparent);
    color: var(--danger);
  }

</style>
