<script lang="ts">
  // The card a render boundary draws in place of what it could not draw: what
  // failed, why, what still works, and the ways out. It sits where the failed
  // body would be, so a failure reads as that pane's own rather than as the
  // window having lost it. Its text describes each action, so a user who
  // reaches one after the card appeared hears what it answers.
  import { errorText } from "../api/errors";

  let {
    title,
    error,
    hint,
    onRetry,
    retryLabel = "Try again",
    reloadLabel,
    onReload,
    closeLabel,
    onClose,
  }: {
    title: string;
    error: unknown;
    hint: string;
    /// No retry button without it.
    onRetry?: () => void;
    retryLabel?: string;
    /// The reload button's text; no reload button without it and `onReload`.
    reloadLabel?: string;
    onReload?: () => void;
    /// Names the tab the close button closes; no close button without it.
    closeLabel?: string;
    onClose?: () => void;
  } = $props();

  const id = $props.id();
  const describedBy = `${id}-title ${id}-detail ${id}-hint`;
  let retryButton: HTMLButtonElement | undefined = $state();

  /// Hand the keyboard to the retry button, the one way out safe to take it
  /// unasked: a typed-ahead Enter or Space on a reload or a close would act
  /// on the whole window or the tab. A card without one takes nothing.
  export function focusRetry(): void {
    retryButton?.focus();
  }
</script>

<div class="pane-failed" role="alert">
  <p class="pane-failed-title" id="{id}-title">{title}</p>
  <p class="pane-failed-detail" id="{id}-detail">
    {errorText(error)}
  </p>
  <p class="pane-failed-hint" id="{id}-hint">{hint}</p>
  <div class="pane-failed-actions">
    {#if onRetry}
      <button bind:this={retryButton} aria-describedby={describedBy} onclick={() => onRetry?.()}>{retryLabel}</button>
    {/if}
    {#if reloadLabel !== undefined && onReload}
      <button aria-describedby={describedBy} onclick={() => onReload?.()}>{reloadLabel}</button>
    {/if}
    {#if closeLabel !== undefined && onClose}
      <button aria-describedby={describedBy} onclick={() => onClose?.()}>Close {closeLabel}</button>
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

  /* Three ways out and a long tab name do not fit a narrow pane's card on
     one row. */
  .pane-failed-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
