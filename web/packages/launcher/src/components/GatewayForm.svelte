<script lang="ts">
  import PrivateField from "@chan/web-shared/PrivateField.svelte";
  // The gateway form: add a gateway, or edit one when `editing` is set. Add
  // just adds (no probe -- the first Connect discovers and signs in). Edit
  // changes the label and the WireGuard file only: the URL is the gateway's
  // identity, so its field renders disabled (remove + re-add changes the
  // origin). The WireGuard file is a path the registry reads at save time, so
  // a bad file comes back as the server's 400 sentence and renders here
  // verbatim: it is written for the user and names the path, the line and the
  // key, never a value. The New/Edit dialog renders the form for an edit and
  // for the command deck's Add gateway, and the Gateways deck's Add gateway
  // card renders it on the card's back face. Each host mounts the form fresh,
  // so its fields seed from the edit target.
  //
  // On the desktop the form also generates the gateway's WireGuard key. The
  // key belongs to a saved row, so on a new gateway the action adds the row
  // first and the form then stays open as that row's form: it shows the
  // public key, which the gateway's consent page shows again at sign-in, the
  // URL is fixed, and the primary button reads Done and saves any later
  // edit to the label or the file. A sign-in that enrolls the key names the
  // row's client file while the form may still be open, so Done and Save
  // send the file field only when the user changed it, and otherwise the
  // row's file as the registry holds it then. The private key never reaches
  // the launcher. A gateway that enrolls no peers refuses with the desktop's
  // 400 sentence, rendered like a file refusal.
  import {
    addGateway,
    updateGateway,
    currentGateway,
    generateWireguardKey,
  } from "../state/library.svelte";
  import { hasDesktopBridge } from "../state/capabilities";
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
  let wireguard = $state(target?.wireguard ?? "");
  // The file field as the row last held it here: seeded, or saved by the
  // key action's add.
  let savedFile = target?.wireguard ?? "";
  let error = $state<string | null>(null);
  let submitting = $state(false);
  // The row this form writes: the edited gateway, or a new one once the key
  // action has added it.
  let savedId = $state<string | null>(target?.id ?? null);
  let publicKey = $state<string | null>(target?.wireguard_public_key ?? null);
  let copied = $state(false);

  function msg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  function onFieldKey(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  }

  /** The URL field as an http(s) URL, or null with the form's error set. */
  function enteredUrl(): string | null {
    const raw = url.trim();
    let parsed: URL | null = null;
    try {
      parsed = new URL(raw);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
      error = "Enter the gateway URL, like https://gateway.example.com";
      return null;
    }
    return raw;
  }

  /** The file a save of row `id` sends: the field when the user changed it,
   * else the row's file now, which a sign-in may have set meanwhile. */
  async function fileToSave(id: string, file: string | undefined): Promise<string | undefined> {
    if (wireguard.trim() !== savedFile.trim()) return file;
    const row = await currentGateway(id);
    return row ? (row.wireguard ?? undefined) : file;
  }

  async function submit(): Promise<void> {
    // Both optional fields are full-replace on the wire: a blank one rides as
    // absent, which the registry reads as "clear".
    const label = name.trim() || undefined;
    const file = wireguard.trim() || undefined;
    let save: () => Promise<string>;
    if (target) {
      // Edit: the URL field is disabled, so the stored origin rides back
      // unchanged (the registry re-checks it) and only the label and the
      // WireGuard file move.
      save = async () =>
        updateGateway(target.id, {
          url: target.url,
          label,
          wireguard: await fileToSave(target.id, file),
        });
    } else if (savedId) {
      // Done on a gateway the key action added: the URL is fixed now, and
      // the label and the file save as an edit would.
      const id = savedId;
      save = async () =>
        updateGateway(id, { url: url.trim(), label, wireguard: await fileToSave(id, file) });
    } else {
      const raw = enteredUrl();
      if (raw === null) return;
      save = () => addGateway({ url: raw, label, wireguard: file });
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

  async function generateKey(): Promise<void> {
    error = null;
    copied = false;
    submitting = true;
    try {
      let id = savedId;
      if (id === null) {
        const raw = enteredUrl();
        if (raw === null) return;
        id = await addGateway({
          url: raw,
          label: name.trim() || undefined,
          wireguard: wireguard.trim() || undefined,
        });
        savedId = id;
        savedFile = wireguard;
      }
      const entry = await generateWireguardKey(id);
      publicKey = entry.wireguard_public_key ?? null;
    } catch (e) {
      error = msg(e);
    } finally {
      submitting = false;
    }
  }

  async function copyKey(): Promise<void> {
    if (!publicKey) return;
    try {
      await navigator.clipboard.writeText(publicKey);
      copied = true;
    } catch (e) {
      error = `Copy failed (${msg(e)}); select the key and copy it.`;
    }
  }
</script>

<div class="gateway-form">
  {#if target}
    <p class="intro">
      Rename this gateway or set its WireGuard file. The URL is its identity; remove and re-add
      the gateway to change it.
    </p>
  {:else}
    <p class="intro">
      Add a gateway to reach your devservers and devservers shared with you. Connect signs in once
      for the whole account.
    </p>
  {/if}
  <label class="field">
    Gateway URL
    <PrivateField field={`gateway:${target?.id ?? savedId ?? "new"}:url`} label="gateway URL">
    <input
      type="text"
      class="mono"
      bind:value={url}
      placeholder="https://gateway.example.com"
      autocomplete="off"
      spellcheck="false"
      disabled={target != null || savedId != null}
      onkeydown={onFieldKey} />
    </PrivateField>
  </label>
  <label class="field">
    Name <span class="muted">(optional)</span>
    <PrivateField field={`gateway:${target?.id ?? savedId ?? "new"}:name`} label="gateway name">
    <input
      type="text"
      bind:value={name}
      placeholder="Defaults to the URL host"
      autocomplete="off"
      onkeydown={onFieldKey} />
    </PrivateField>
  </label>
  <label class="field">
    WireGuard file <span class="muted">(optional)</span>
    <PrivateField field={`gateway:${target?.id ?? savedId ?? "new"}:wireguard`} label="WireGuard path">
    <input
      type="text"
      class="mono"
      bind:value={wireguard}
      placeholder="~/.config/chan/gateway.conf"
      autocomplete="off"
      spellcheck="false"
      onkeydown={onFieldKey} />
    </PrivateField>
    <span class="field-hint">
      A wg-quick peer file, readable only by you (<code>chmod 600</code>). The gateway is then
      reached through an in-process WireGuard tunnel; the file takes effect as soon as it is
      saved, and changing the path restarts that gateway's tunnel. A generated WireGuard key
      fills this field at sign-in.
    </span>
  </label>

  {#if hasDesktopBridge}
    <div class="field wg-key">
      {#if publicKey}
        WireGuard public key
        <div class="key-row">
          <PrivateField field={`gateway:${target?.id ?? savedId}:key`} label="WireGuard public key"><input
            type="text"
            class="mono"
            readonly
            value={publicKey}
            aria-label="WireGuard public key"
            onfocus={(e) => e.currentTarget.select()} /></PrivateField>
          <button class="btn" type="button" onclick={copyKey}>{copied ? "Copied" : "Copy"}</button>
        </div>
      {/if}
      <button class="btn wg-generate" type="button" disabled={submitting} onclick={generateKey}>
        Generate WireGuard key
      </button>
      <span class="field-hint">
        {publicKey
          ? "Generating again replaces this key; the gateway enrolls the new one at the next sign-in."
          : "The desktop keeps the private key; the gateway enrolls the public key at sign-in."}
      </span>
    </div>
  {/if}

  {#if error}
    <div class="error" role="alert"><PrivateField field="gateway-form:error" label="error details">{error}</PrivateField></div>
  {/if}

  <div class="form-footer">
    {#if cancellable}
      <button class="btn" type="button" disabled={submitting} onclick={() => ondismiss?.()}>
        Cancel
      </button>
    {/if}
    <button class="btn primary" type="button" disabled={submitting} onclick={submit}>
      {target ? "Save changes" : savedId ? "Done" : "Add gateway"}
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

  /* The one-line rule under a field that the placeholder alone cannot carry. */
  .field-hint {
    font-size: 0.78rem;
    line-height: 1.45;
    color: var(--text-secondary);
    opacity: 0.85;
  }

  .key-row {
    display: flex;
    gap: 0.5rem;
  }

  .key-row input {
    flex: 1;
    min-width: 0;
  }

  .wg-generate {
    align-self: flex-start;
  }

  .field-hint code {
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
