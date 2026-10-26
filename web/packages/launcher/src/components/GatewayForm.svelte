<script lang="ts">
  // The gateway form: add a gateway, or rename one when `editing` is set. Add
  // just adds (no probe -- the first Connect discovers and signs in). Rename
  // changes the label only: the URL is the gateway's identity, so its field
  // renders disabled (remove + re-add changes the origin). The New/Edit dialog
  // renders it for a rename and for the command deck's Add gateway, and the
  // Gateways deck's Add gateway card renders it on the card's back face. Each
  // host mounts the form fresh, so its fields seed from the edit target.
  import { addGateway, updateGateway } from "../state/library.svelte";
  import type { GatewayEntry } from "../api/library";

  interface Props {
    /** The gateway being renamed; null adds a new one. */
    editing?: GatewayEntry | null;
    /** Called with the saved gateway's id once the registry holds it. */
    onsaved: (id: string) => void;
    /** Called by a Cancel button, which renders only when a host passes
     * `cancellable`. */
    ondismiss?: () => void;
    cancellable?: boolean;
  }

  let { editing = null, onsaved, ondismiss, cancellable = false }: Props = $props();

  // svelte-ignore state_referenced_locally
  const target = editing;

  let url = $state(target?.url ?? "");
  let name = $state(target?.label ?? "");
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
    let save: () => Promise<string>;
    if (target) {
      // Rename: the URL field is disabled, so the stored origin rides back
      // unchanged (the registry re-checks it) and only the label moves.
      save = () => updateGateway(target.id, { url: target.url, label: name.trim() || undefined });
    } else {
      const raw = url.trim();
      let parsed: URL | null = null;
      try {
        parsed = new URL(raw);
      } catch {
        parsed = null;
      }
      if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
        error = "Enter the gateway URL, like https://gateway.example.com";
        return;
      }
      save = () => addGateway({ url: raw, label: name.trim() || undefined });
    }
    submitting = true;
    try {
      const id = await save();
      error = null;
      onsaved(id);
    } catch (e) {
      error = msg(e);
    } finally {
      submitting = false;
    }
  }
</script>

<div class="gateway-form">
  {#if target}
    <p class="intro">
      Rename this gateway. The URL is its identity; remove and re-add the gateway to change it.
    </p>
  {:else}
    <p class="intro">
      Add a gateway to reach your devservers and devservers shared with you. Connect signs in once
      for the whole account.
    </p>
  {/if}
  <label class="field">
    Gateway URL
    <input
      type="text"
      class="mono"
      bind:value={url}
      placeholder="https://gateway.example.com"
      autocomplete="off"
      spellcheck="false"
      disabled={target != null}
      onkeydown={onFieldKey} />
  </label>
  <label class="field">
    Name <span class="muted">(optional)</span>
    <input
      type="text"
      bind:value={name}
      placeholder="Defaults to the URL host"
      autocomplete="off"
      onkeydown={onFieldKey} />
  </label>

  {#if error}
    <div class="error" role="alert">{error}</div>
  {/if}

  <div class="form-footer">
    {#if cancellable}
      <button class="btn" type="button" disabled={submitting} onclick={() => ondismiss?.()}>
        Cancel
      </button>
    {/if}
    <button class="btn primary" type="button" disabled={submitting} onclick={submit}>
      {target ? "Save changes" : "Add gateway"}
    </button>
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

  .field input {
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--bg);
    color: var(--text);
    font-size: 0.9rem;
    font-family: inherit;
  }

  /* The URL reads as literal text the user pastes. */
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace !important;
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
