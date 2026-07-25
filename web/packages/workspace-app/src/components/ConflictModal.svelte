<script lang="ts">
  // Three-button modal that surfaces a CAS conflict on save: the
  // user's buffer can't go to disk because the file changed under us
  // since the last read.
  //
  // Choices:
  //   Reload    -> explicitly resolve a live-session conflict in
  //                favor of disk, or refetch the classic disk version. Local
  //                edits are lost; the disk wins. Right answer when
  //                the user's edits are minor or duplicate.
  //   Overwrite -> explicitly resolve in favor of live authority, or
  //                push the classic buffer with the new disk-side mtime.
  //                The external edit is destroyed but
  //                the user keeps their work. Right answer when the
  //                external edit was an unintended autoreformat or a
  //                stale sibling tab catching up.
  //   Cancel    -> close the dialog. The tab stays dirty; the user
  //                can manually copy parts of either side around or
  //                pick Reload / Overwrite later.
  //
  // Three-way diff is deliberately outside this modal; a future
  // "show diff" button can extend the flow without changing the
  // conflict-resolution choices.

  import {
    conflictDialog,
    dismissConflict,
    reloadConflictedTab,
    overwriteConflictedTab,
  } from "../state/tabs.svelte";

  function onReload(): void {
    void reloadConflictedTab();
  }
  function onOverwrite(): void {
    void overwriteConflictedTab();
  }
</script>

{#if conflictDialog.open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="overlay" onclick={dismissConflict}>
    <div class="modal" onclick={(e) => e.stopPropagation()} role="dialog" tabindex="-1">
      <div class="title">External edit detected</div>
      <div class="body">
        <p>
          <code>{conflictDialog.path}</code> changed on disk since you opened it.
          Saving now would clobber the external version.
        </p>
        <p class="muted">
          Reload discards your unsaved edits. Overwrite keeps yours and
          drops the external change. Cancel leaves the dialog and the
          tab dirty.
        </p>
      </div>
      <div class="actions">
        <button class="cancel" onclick={dismissConflict}>Cancel</button>
        <button class="overwrite" onclick={onOverwrite}>Overwrite</button>
        <button class="reload" onclick={onReload}>Reload</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 26000;
  }
  .modal {
    background: var(--bg-elev);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
    padding: 1rem;
    min-width: 380px;
    max-width: 80vw;
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }
  .title {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-heading);
  }
  .body p { margin: 0 0 0.4rem; font-size: 14px; }
  .body code {
    background: var(--code-bg);
    padding: 1px 5px;
    border-radius: 3px;
    font-family: ui-monospace, monospace;
    font-size: 13px;
  }
  .body .muted { color: var(--text-secondary); font-size: 13px; }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.4rem;
  }
  .actions button {
    padding: 0.35rem 0.85rem;
    border-radius: 4px;
    border: 1px solid var(--btn-border);
    background: var(--btn-bg);
    color: var(--text);
    cursor: pointer;
    font: inherit;
  }
  .actions button:hover { border-color: var(--btn-hover); }
  /* Reload is the recommended path (disk wins); accent it like the
     OK button on PromptModal. Overwrite stays neutral so users have
     to deliberately pick the destructive option. */
  .actions .reload {
    background: var(--link);
    border-color: var(--link);
    color: #fff;
  }
</style>
