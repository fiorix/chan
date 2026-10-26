<script lang="ts">
  // The New-workspace / devserver / gateway dialog. `dialog.choice` (set by
  // the entry point that opened it) drives the body: a local directory, a
  // devserver, or a gateway. There is no in-dialog chooser. The devserver and
  // gateway bodies double as edit forms, prefilled from the registry entry;
  // one form does Add (POST) and Save changes (PUT). The component mounts
  // fresh each time the dialog opens, so its fields seed from the edit target
  // and need no manual reset. The devserver and gateway bodies are the shared
  // DevserverForm and GatewayForm, which the decks' Add cards render too.
  import Modal from "./Modal.svelte";
  import DevserverForm from "./DevserverForm.svelte";
  import GatewayForm from "./GatewayForm.svelte";
  import { SquareTerminal } from "@lucide/svelte";
  import { closeDialog, dialog } from "../state/dialog.svelte";
  import { addLocalWorkspace, pickFolder } from "../state/library.svelte";
  import { hasDesktopBridge, readOnly } from "../state/capabilities";

  const editing = dialog.editing;
  // The gateway body doubles as the rename form, prefilled from the entry.
  // Rename only: the URL is the gateway's identity, so its field renders
  // disabled (remove + re-add changes the origin).
  const editingGateway = dialog.editingGateway;
  // A devserver with a live connection (connecting or connected) can't be edited
  // (the backend rejects the write), so the form opens read-only: inputs
  // disabled, no Save -- disconnect first to edit. Captured at open (the dialog
  // mounts fresh each time).
  const readOnlyEdit = editing != null && editing.status !== "disconnected";

  let error = $state<string | null>(null);
  let submitting = $state(false);

  // Local-directory form. In a plain browser this is a path text input; the
  // desktop embed swaps in a native folder picker (both POST the same path).
  let localPath = $state("");
  // Optional display name for the local workspace; empty keeps the folder name.
  let localLabel = $state("");
  // The folder name the label defaults to, shown as the field's placeholder.
  const localBasename = $derived(
    localPath
      .trim()
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "",
  );

  const showLocal = $derived(dialog.choice === "local" && !editing);
  const showGateway = $derived(dialog.choice === "gateway" && !editing);
  const title = $derived(
    editing
      ? readOnlyEdit
        ? "Devserver"
        : "Edit devserver"
      : showLocal
        ? "New workspace"
        : showGateway
          ? editingGateway
            ? "Edit gateway"
            : "Add gateway"
          : "Add devserver",
  );

  function msg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  function onFieldKey(e: KeyboardEvent, submit: () => void): void {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  }

  // Browse… opens the desktop's native folder picker and fills the path. A
  // desktop action, so it is offered only on the mutable (desktop) surface
  // (same gate as the devserver Connect button); the text input stays the
  // fallback, and the only path in a plain browser where the route 409s.
  async function browse(): Promise<void> {
    error = null;
    try {
      const picked = await pickFolder();
      if (picked) localPath = picked;
    } catch (e) {
      error = msg(e);
    }
  }

  async function submitLocal(): Promise<void> {
    const path = localPath.trim();
    if (!path) {
      error = "A folder path is required.";
      return;
    }
    submitting = true;
    try {
      await addLocalWorkspace(path, localLabel.trim() || undefined);
      closeDialog();
    } catch (e) {
      error = msg(e);
    } finally {
      submitting = false;
    }
  }
</script>

<Modal {title} onclose={closeDialog} initialFocus={dialog.initialFocus} returnFocus={dialog.opener}>
  {#if showLocal}
    <p class="intro">Add a folder on this machine as a workspace.</p>
    <label class="field">
      Folder path
      <div class="path-row">
        <input
          type="text"
          class="mono"
          bind:value={localPath}
          placeholder="/Users/you/notes"
          autocomplete="off"
          spellcheck="false"
          onkeydown={(e) => onFieldKey(e, submitLocal)} />
        {#if !readOnly && hasDesktopBridge}
          <button class="btn" type="button" onclick={browse}>Browse…</button>
        {/if}
      </div>
    </label>
    <label class="field">
      Display name <span class="muted">(optional)</span>
      <input
        type="text"
        bind:value={localLabel}
        placeholder={localBasename || "Defaults to the folder name"}
        autocomplete="off"
        spellcheck="false"
        onkeydown={(e) => onFieldKey(e, submitLocal)} />
    </label>
    <div class="tip">
      <SquareTerminal size={16} />
      <span>
        Tip: you can also run <code>chan open &lt;path&gt;</code> in any terminal to add a
        workspace, or <code>chan workspace serve &lt;path&gt; --on &lt;devserver&gt;</code> to add
        one on a connected devserver.
      </span>
    </div>
  {:else if showGateway}
    <GatewayForm editing={editingGateway} onsaved={closeDialog} ondismiss={closeDialog} />
  {:else}
    <DevserverForm editing={editing} onsaved={closeDialog} ondismiss={closeDialog} />
  {/if}

  {#if showLocal && error}
    <div class="error" role="alert">{error}</div>
  {/if}

  {#if showLocal}
    <div class="dialog-footer">
      <button class="btn primary" type="button" disabled={submitting} onclick={submitLocal}>
        Create workspace
      </button>
    </div>
  {/if}
</Modal>

<style>
  .intro {
    margin: 0 0 1rem;
    color: var(--text-secondary);
    font-size: 0.9rem;
    line-height: 1.45;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin-bottom: 0.85rem;
    font-size: 0.85rem;
    color: var(--text-secondary);
  }

  .field input {
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--bg);
    color: var(--text);
    font-size: 0.9rem;
    font-family: inherit;
  }

  /* A path or URL reads as literal text the user pastes from a shell. */
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace !important;
  }

  /* The folder field pairs its text input with a Browse… button (the native
     folder picker on the desktop surface). The input takes the remaining width;
     the button keeps its size. */
  .path-row {
    display: flex;
    gap: 0.5rem;
    align-items: stretch;
  }

  .path-row input {
    flex: 1;
    min-width: 0;
  }

  .path-row .btn {
    flex-shrink: 0;
    white-space: nowrap;
  }

  .field input:focus {
    outline: none;
    border-color: var(--brand);
  }

  .muted {
    color: var(--text-secondary);
    font-weight: 400;
    opacity: 0.8;
  }

  /* The command-line tip box: a terminal-iconed hint that the same thing can be
     done from a shell (chan open). */
  .tip {
    display: flex;
    gap: 0.6rem;
    align-items: flex-start;
    margin: 0.25rem 0 0;
    padding: 0.65rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: color-mix(in srgb, var(--text-secondary) 8%, transparent);
    color: var(--text-secondary);
    font-size: 0.82rem;
    line-height: 1.5;
  }

  .tip :global(svg) {
    flex-shrink: 0;
    margin-top: 0.1rem;
  }

  .tip code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--accent);
  }

  .error {
    margin: 0.5rem 0 0;
    padding: 0.5rem 0.65rem;
    border-radius: 7px;
    background: color-mix(in srgb, var(--danger) 16%, transparent);
    color: var(--danger);
    font-size: 0.85rem;
  }

  /* The action row keeps a clear top margin so the submit button never overlaps
     the last field. */
  .dialog-footer {
    display: flex;
    justify-content: flex-end;
    margin-top: 1.5rem;
  }
</style>
