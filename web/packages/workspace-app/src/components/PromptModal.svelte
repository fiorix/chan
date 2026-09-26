<script lang="ts">
  // In-page replacement for window.prompt that works in WKWebView (Tauri),
  // which doesn't implement native JS dialogs. Driven by `promptState`
  // in the store: callers get a Promise<string | null> via uiPrompt().

  import { promptState, resolvePrompt } from "../state/store.svelte";
  import ModalShell from "./ModalShell.svelte";

  let value = $state("");
  let inputEl: HTMLInputElement | undefined = $state();

  // Sync the local value whenever a new prompt opens.
  $effect(() => {
    if (promptState.open) {
      value = promptState.defaultValue;
      // Focus + select-all on the next tick so the user can overtype.
      queueMicrotask(() => {
        inputEl?.focus();
        inputEl?.select();
      });
    }
  });

  function ok(): void {
    resolvePrompt(value);
  }
  function cancel(): void {
    resolvePrompt(null);
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      ok();
    }
  }
</script>

{#if promptState.open}
  <ModalShell labelledby="prompt-title" onClose={cancel} minWidth="340px">
    <div id="prompt-title" class="title">{promptState.title}</div>
    <input
      bind:this={inputEl}
      bind:value
      onkeydown={onKey}
      spellcheck="false"
      autocomplete="off"
    />
    <div class="actions">
      <button class="cancel" onclick={cancel}>Cancel</button>
      <button class="ok" onclick={ok}>OK</button>
    </div>
  </ModalShell>
{/if}

<style>
  .title {
    font-size: 15px;
    color: var(--text-secondary);
  }
  input {
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.4rem 0.5rem;
    font: inherit;
    outline: none;
  }
  input:focus { border-color: var(--link); }
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
</style>
