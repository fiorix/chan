<script lang="ts">
  // The devserver form: add a devserver, or edit one when `editing` is set. One
  // form does Add (POST) and Save changes (PUT). The New/Edit dialog renders it
  // for an edit and for the command deck's New devserver, and the carousel's
  // Add devserver card renders it on the card's back face. The Address field
  // takes a bare `host:port` or a full URL carrying a token (lib/devserverAddress).
  //
  // A devserver with a live connection (connecting or connected) can't be edited
  // (the backend rejects the write), so the form opens read-only: inputs
  // disabled, no Save -- disconnect first to edit. Captured at mount: each host
  // mounts the form fresh, so its fields seed from the edit target and need no
  // manual reset.
  import { SquareTerminal } from "@lucide/svelte";
  import { saveDevserver } from "../state/library.svelte";
  import { parseAddress, validPort } from "../lib/devserverAddress";
  import type { DevserverEntry } from "../api/library";

  interface Props {
    /** The devserver being edited; null adds a new one. */
    editing?: DevserverEntry | null;
    /** Called with the saved devserver's id once the registry holds it. */
    onsaved: (id: string) => void;
    /** Called when the read-only form is dismissed, and by a Cancel button,
     * which renders only when a host passes `cancellable`. */
    ondismiss?: () => void;
    cancellable?: boolean;
  }

  let { editing = null, onsaved, ondismiss, cancellable = false }: Props = $props();

  // svelte-ignore state_referenced_locally
  const target = editing;
  const readOnlyEdit = target != null && target.status !== "disconnected";

  // Address shows the stored `host:port` (the token is write-only and never
  // echoed); Name + Connect script + Auto-hide seed from the entry.
  let address = $state(target ? target.url || `${target.host}:${target.port}` : "");
  let name = $state(target?.label ?? "");
  let script = $state(target?.script ?? "");
  // Auto-hide the connect control terminal once the devserver connects.
  let autoHideControl = $state(target?.auto_hide_control ?? false);
  let error = $state<string | null>(null);
  let submitting = $state(false);

  function msg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  function onFieldKey(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  }

  async function submit(): Promise<void> {
    const parsed = parseAddress(address);
    if (!parsed || !parsed.host || !validPort(parsed.port)) {
      error = "Enter an address like 127.0.0.1:8787 or https://host:port?t=…";
      return;
    }
    submitting = true;
    try {
      const id = await saveDevserver(
        {
          url: parsed.url,
          host: parsed.host,
          port: parsed.port,
          label: name.trim() || undefined,
          script: script.trim() || undefined,
          // Write-only: an edit that leaves the Address as host:port carries no
          // token, so the stored one is kept; a full URL with ?t replaces it,
          // and an empty ?t= clears it.
          token: parsed.token || undefined,
          clear_token: parsed.token === "" || undefined,
          auto_hide_control: autoHideControl,
        },
        target?.id,
      );
      error = null;
      onsaved(id);
    } catch (e) {
      error = msg(e);
    } finally {
      submitting = false;
    }
  }
</script>

<div class="devserver-form">
  {#if readOnlyEdit}
    <p class="intro">
      This devserver has a live connection, so its settings are read-only. Disconnect it to edit.
    </p>
  {:else}
    <p class="intro">Connect a remote machine to run terminals &amp; workspaces.</p>
  {/if}
  <label class="field">
    Name <span class="muted">(optional)</span>
    <input
      type="text"
      bind:value={name}
      placeholder="dev2.example.net"
      autocomplete="off"
      disabled={readOnlyEdit}
      onkeydown={onFieldKey} />
  </label>
  <label class="field">
    Address
    <input
      type="text"
      class="mono"
      bind:value={address}
      placeholder="127.0.0.1:8787 or https://host:port?t=…"
      autocomplete="off"
      spellcheck="false"
      disabled={readOnlyEdit}
      onkeydown={onFieldKey} />
  </label>
  <label class="field">
    Connect script <span class="muted">(optional; runs in a control terminal)</span>
    <textarea
      rows="3"
      class="mono"
      bind:value={script}
      placeholder="ssh box -L 8787:localhost:8787 chan devserver join"
      autocomplete="off"
      spellcheck="false"
      disabled={readOnlyEdit}></textarea>
  </label>
  <label class="check-field">
    <input type="checkbox" bind:checked={autoHideControl} disabled={readOnlyEdit} />
    Auto-hide control terminal on success
  </label>
  <div class="tip">
    <SquareTerminal size={16} />
    <span>
      Tip: keep connection scripts in the foreground, e.g. <code>ssh -N</code>.
    </span>
  </div>

  {#if error}
    <div class="error" role="alert">{error}</div>
  {/if}

  <div class="form-footer">
    {#if readOnlyEdit}
      <!-- Connected: read-only, so the only action is to dismiss. -->
      <button class="btn primary" type="button" onclick={() => ondismiss?.()}>OK</button>
    {:else}
      {#if cancellable}
        <button class="btn" type="button" disabled={submitting} onclick={() => ondismiss?.()}>
          Cancel
        </button>
      {/if}
      <button class="btn primary" type="button" disabled={submitting} onclick={submit}>
        {target ? "Save changes" : "Add devserver"}
      </button>
    {/if}
  </div>
</div>

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

  /* Inline checkbox + label (the auto-hide control-terminal option). */
  .check-field {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.85rem;
    font-size: 0.85rem;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .field input,
  .field textarea {
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--bg);
    color: var(--text);
    font-size: 0.9rem;
    font-family: inherit;
  }

  /* Address + script read as literal text the user pastes from a shell. */
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace !important;
  }

  .field textarea {
    resize: vertical;
  }

  .field input:focus,
  .field textarea:focus {
    outline: none;
    border-color: var(--brand);
  }

  .muted {
    color: var(--text-secondary);
    font-weight: 400;
    opacity: 0.8;
  }

  /* The command-line tip box: a terminal-iconed hint about connect scripts. */
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
  .form-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.6rem;
    margin-top: 1.5rem;
  }
</style>
