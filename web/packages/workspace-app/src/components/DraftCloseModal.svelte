<script lang="ts">
  import { draftCloseState, resolveDraftClose } from "../state/tabs.svelte";
  import { windowCaps } from "../state/windowCaps";

  // A standalone window has no workspace to save into; its promote
  // targets are paths on the machine's disk. Workspace copy stays
  // byte-identical through these derivations.
  const destinationNoun = windowCaps.workspace ? "workspace" : "disk";
  const destinationLabel = windowCaps.workspace ? "Workspace" : "Disk";

  let inputEl = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (!draftCloseState.open) return;
    queueMicrotask(() => {
      inputEl?.focus();
      inputEl?.select();
    });
  });

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      resolveDraftClose("cancel");
    }
  }
</script>

{#if draftCloseState.open}
  <div class="modal-backdrop" role="presentation" onclick={() => resolveDraftClose("cancel")}>
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="draft-close-title"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={onKeydown}
    >
      <header>
        <div id="draft-close-title" class="title">Close Draft</div>
        <div class="path">{draftCloseState.path}</div>
      </header>

      <p>
        {#if draftCloseState.hasAttachments}
          Save this draft workspace as a {destinationNoun} folder, or discard it.
        {:else}
          Save this draft as a {destinationNoun} file, or discard it.
        {/if}
      </p>

      <label>
        <span
          >{draftCloseState.targetKind === "folder"
            ? `${destinationLabel} folder`
            : `${destinationLabel} file`}</span
        >
        <input
          bind:this={inputEl}
          bind:value={draftCloseState.target}
          placeholder={draftCloseState.targetKind === "folder" ? "notes/new-draft" : "notes/draft.md"}
        />
      </label>

      {#if draftCloseState.error}
        <div class="error">{draftCloseState.error}</div>
      {/if}

      <footer>
        <button type="button" class="danger" onclick={() => resolveDraftClose("discard")}>
          Discard Draft
        </button>
        <div class="spacer"></div>
        <button type="button" onclick={() => resolveDraftClose("cancel")}>Cancel</button>
        <button type="button" class="primary" onclick={() => resolveDraftClose("save")}>
          Save to {destinationLabel}
        </button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: grid;
    place-items: center;
    padding: 18px;
    background: rgba(0, 0, 0, 0.38);
  }
  .modal {
    width: min(520px, 100%);
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--text);
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
    padding: 16px;
  }
  header {
    display: grid;
    gap: 4px;
    margin-bottom: 12px;
  }
  .title {
    font-size: 16px;
    font-weight: 650;
  }
  .path {
    min-width: 0;
    color: var(--text-secondary);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  p {
    margin: 0 0 14px;
    color: var(--text);
    line-height: 1.4;
  }
  label {
    display: grid;
    gap: 6px;
    font-size: 12px;
    color: var(--text-secondary);
  }
  input {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-elevated, var(--bg));
    color: var(--text);
    padding: 8px 10px;
    font: inherit;
  }
  input:focus {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .error {
    margin-top: 8px;
    color: var(--danger, #c0392b);
    font-size: 12px;
  }
  footer {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-top: 16px;
  }
  .spacer {
    flex: 1;
  }
  button {
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--button-bg, var(--bg));
    color: var(--text);
    padding: 7px 10px;
    font: inherit;
    cursor: pointer;
  }
  button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-contrast, #fff);
  }
  button.danger {
    color: var(--danger, #c0392b);
  }
</style>
