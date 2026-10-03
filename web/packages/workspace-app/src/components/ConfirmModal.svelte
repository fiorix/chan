<script lang="ts">
  // In-page confirm dialog. Same WKWebView story as PromptModal:
  // window.confirm is unreliable in Tauri, so we workspace a small modal
  // off confirmState in shared state.

  import { confirmState, resolveConfirm } from "../state/confirm.svelte";
  import ModalShell from "./ModalShell.svelte";

  let okEl: HTMLButtonElement | undefined = $state();
  let cancelEl: HTMLButtonElement | undefined = $state();

  // Each request focuses its default, including a replacement while open.
  // Destructive confirms default to Cancel; other confirms default to OK.
  $effect(() => {
    if (confirmState.open) {
      const request = confirmState.resolve;
      const destructive = confirmState.destructive;
      queueMicrotask(() => {
        if (confirmState.open && confirmState.resolve === request) {
          (destructive ? cancelEl : okEl)?.focus();
        }
      });
    }
  });

  function ok(): void {
    resolveConfirm(true);
  }
  function cancel(): void {
    resolveConfirm(false);
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.target instanceof HTMLButtonElement) e.target.click();
      else resolveConfirm(!confirmState.destructive);
    }
  }
</script>

{#if confirmState.open}
  <ModalShell labelledby="confirm-title" onClose={cancel} onKeydown={onKey} minWidth="360px">
    <div id="confirm-title" class="title">{confirmState.title}</div>
    {#if confirmState.message}
      <div class="message">{confirmState.message}</div>
    {/if}
    <div class="actions">
      <button bind:this={cancelEl} class="cancel" onclick={cancel}>{confirmState.cancelLabel}</button>
      <button
        bind:this={okEl}
        class="ok"
        class:destructive={confirmState.destructive}
        onclick={ok}
      >{confirmState.confirmLabel}</button>
    </div>
  </ModalShell>
{/if}

<style>
  .title {
    font-size: 15px;
    color: var(--text);
  }
  .message {
    font-size: 14px;
    color: var(--text-secondary);
    line-height: 1.45;
    white-space: pre-wrap;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.4rem;
  }
  .actions button {
    padding: 0.3rem 0.75rem;
    border-radius: 4px;
    border: 1px solid var(--btn-border);
    background: var(--btn-bg);
    color: var(--text);
    cursor: pointer;
    font: inherit;
  }
  .actions button:hover { border-color: var(--btn-hover); }
  .actions .ok {
    background: var(--link);
    border-color: var(--link);
    color: #fff;
  }
  .actions .ok.destructive {
    background: var(--danger, #d33);
    border-color: var(--danger, #d33);
  }
</style>
