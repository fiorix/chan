<script lang="ts">
  // In-page confirm dialog. Same WKWebView story as PromptModal:
  // window.confirm is unreliable in Tauri, so we workspace a small modal
  // off confirmState in shared state.

  import { confirmState, resolveConfirm } from "../state/confirm.svelte";
  import ModalShell from "./ModalShell.svelte";

  let okEl: HTMLButtonElement | undefined = $state();

  // Focus the OK button when the dialog opens so Enter confirms and
  // Esc cancels without an extra click.
  $effect(() => {
    if (confirmState.open) {
      queueMicrotask(() => okEl?.focus());
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
      ok();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  }
</script>

{#if confirmState.open}
  <ModalShell onClose={cancel} onKeydown={onKey} minWidth="360px">
    <div class="title">{confirmState.title}</div>
    {#if confirmState.message}
      <div class="message">{confirmState.message}</div>
    {/if}
    <div class="actions">
      <button class="cancel" onclick={cancel}>{confirmState.cancelLabel}</button>
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
