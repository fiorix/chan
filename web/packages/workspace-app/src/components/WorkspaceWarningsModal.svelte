<script lang="ts">
  import {
    canDiscardWorkspaceWarning,
    closeWorkspaceWarningsDialog,
    copyWorkspaceWarningPath,
    discardWorkspaceWarning,
    dismissWorkspaceWarning,
    workspaceWarningKey,
    workspaceWarningLabel,
    workspaceWarningsDialog,
  } from "../state/store.svelte";
  import ModalShell from "./ModalShell.svelte";

  const warnings = $derived(workspaceWarningsDialog.warnings);

</script>

{#if workspaceWarningsDialog.open}
  <ModalShell labelledby="workspace-warnings-title" onClose={closeWorkspaceWarningsDialog} gap="0">
    <div class="workspace-warnings">
      <header class="modal-header">
        <h2 id="workspace-warnings-title">Workspace warnings</h2>
        <button
          type="button"
          class="icon-button"
          aria-label="Close workspace warnings"
          title="Close"
          onclick={closeWorkspaceWarningsDialog}
          disabled={workspaceWarningsDialog.busyKey !== null}
        >x</button>
      </header>

      <div class="modal-body">
        {#if warnings.length === 0}
          <p class="empty">No current workspace warnings.</p>
        {:else}
          <ul class="warning-list">
            {#each warnings as warning (workspaceWarningKey(warning))}
              {@const busy = workspaceWarningsDialog.busyKey === workspaceWarningKey(warning)}
              <li class="warning-item">
                <div class="warning-main">
                  <div class="warning-title">{workspaceWarningLabel(warning)}</div>
                  <div class="warning-meta">
                    <code>{warning.path}</code>
                    <span>{warning.kind}</span>
                  </div>
                </div>
                <div class="warning-actions">
                  <button
                    type="button"
                    onclick={() => void copyWorkspaceWarningPath(warning)}
                    disabled={workspaceWarningsDialog.busyKey !== null}
                  >Copy path</button>
                  <button
                    type="button"
                    onclick={() => dismissWorkspaceWarning(warning)}
                    disabled={workspaceWarningsDialog.busyKey !== null}
                  >Dismiss</button>
                  {#if canDiscardWorkspaceWarning(warning)}
                    <button
                      type="button"
                      class="danger"
                      onclick={() => void discardWorkspaceWarning(warning)}
                      disabled={workspaceWarningsDialog.busyKey !== null}
                    >{busy ? "Discarding..." : "Discard metadata"}</button>
                  {/if}
                </div>
              </li>
            {/each}
          </ul>
        {/if}

        {#if workspaceWarningsDialog.error}
          <p class="dialog-error" role="alert">{workspaceWarningsDialog.error}</p>
        {:else if workspaceWarningsDialog.notice}
          <p class="dialog-notice" role="status">{workspaceWarningsDialog.notice}</p>
        {/if}
      </div>

      <footer class="modal-footer">
        <button
          type="button"
          onclick={closeWorkspaceWarningsDialog}
          disabled={workspaceWarningsDialog.busyKey !== null}
        >OK</button>
      </footer>
    </div>
  </ModalShell>
{/if}

<style>
  .workspace-warnings {
    width: min(720px, 78vw);
    max-height: min(640px, 86vh);
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }
  .modal-header h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 650;
  }
  .icon-button {
    width: 28px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font: inherit;
    font-size: 20px;
    line-height: 1;
  }
  .icon-button:hover:not(:disabled) {
    border-color: var(--border);
    color: var(--text);
  }
  .modal-body {
    min-height: 0;
    overflow: auto;
    padding: 14px 16px;
  }
  .warning-list {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 0;
    padding: 0;
  }
  .warning-item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 12px;
    align-items: center;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-card);
  }
  .warning-main {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .warning-title {
    color: var(--warn-text);
    font-size: 14px;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
  .warning-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 12px;
    min-width: 0;
  }
  .warning-meta code {
    max-width: 42ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font: inherit;
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    color: var(--text-secondary);
  }
  .warning-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
  }
  .warning-actions button,
  .modal-footer button {
    border: 1px solid var(--btn-border);
    border-radius: 6px;
    background: var(--btn-bg);
    color: var(--text);
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    padding: 6px 10px;
  }
  .warning-actions button:hover:not(:disabled),
  .modal-footer button:hover:not(:disabled) {
    border-color: var(--btn-hover);
  }
  .warning-actions button:disabled,
  .modal-footer button:disabled,
  .icon-button:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .warning-actions .danger {
    border-color: color-mix(in srgb, var(--danger, #d33) 70%, var(--border));
    color: var(--danger, #d33);
  }
  .dialog-error,
  .dialog-notice,
  .empty {
    margin: 12px 0 0;
    font-size: 13px;
    line-height: 1.4;
  }
  .dialog-error {
    color: var(--warn-text);
  }
  .dialog-notice,
  .empty {
    color: var(--muted);
  }
  .modal-footer {
    display: flex;
    justify-content: flex-end;
    padding: 12px 16px 14px;
    border-top: 1px solid var(--border);
  }
  @media (max-width: 640px) {
    .workspace-warnings {
      width: auto;
      max-height: none;
    }
    .warning-item {
      grid-template-columns: 1fr;
    }
    .warning-actions {
      justify-content: flex-start;
    }
  }
</style>
