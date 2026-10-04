<script lang="ts">
  // The card a render boundary draws in place of what it could not draw: what
  // failed, why, what still works, and the ways out. It sits where the failed
  // body would be, so a failure reads as that pane's own rather than as the
  // window having lost it.
  import { errorText } from "../api/errors";

  let {
    title,
    error,
    hint,
    onRetry,
    closeLabel,
    onClose,
  }: {
    title: string;
    error: unknown;
    hint: string;
    onRetry: () => void;
    /// Names the tab the close button closes; no close button without it.
    closeLabel?: string;
    onClose?: () => void;
  } = $props();
</script>

<div class="pane-failed" role="alert">
  <p class="pane-failed-title">{title}</p>
  <p class="pane-failed-detail">
    {errorText(error)}
  </p>
  <p class="pane-failed-hint">{hint}</p>
  <div class="pane-failed-actions">
    <button onclick={() => onRetry()}>Try again</button>
    {#if closeLabel !== undefined && onClose}
      <button onclick={() => onClose()}>Close {closeLabel}</button>
    {/if}
  </div>
</div>

<style>
  .pane-failed {
    margin: auto;
    max-width: min(32rem, calc(100% - 2rem));
    padding: 1rem 1.15rem;
    border-radius: 10px;
    background: var(--bg-card);
    border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--border));
    color: var(--text);
  }

  .pane-failed-title {
    margin: 0 0 0.35rem;
    font-weight: 600;
  }

  .pane-failed-detail {
    margin: 0 0 0.5rem;
    color: var(--text-secondary);
    font-size: 0.85rem;
    overflow-wrap: anywhere;
  }

  .pane-failed-hint {
    margin: 0 0 0.75rem;
    color: var(--text-secondary);
    font-size: 0.8rem;
  }

  .pane-failed-actions {
    display: flex;
    gap: 0.5rem;
  }
</style>
