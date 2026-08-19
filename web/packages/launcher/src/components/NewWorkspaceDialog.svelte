<script lang="ts">
  // The New-workspace / devserver / gateway dialog. `dialog.choice` (set by
  // the entry point that opened it) drives the body: a local directory, a
  // devserver, or a gateway. There is no in-dialog chooser. The devserver and
  // gateway bodies double as edit forms, prefilled from the registry entry;
  // one form does Add (POST) and Save changes (PUT). The component mounts
  // fresh each time the dialog opens, so its fields seed from the edit target
  // and need no manual reset.
  //
  // The devserver Address is one field accepting EITHER a bare `host:port` (the
  // local ssh-forward case) OR a full `http(s)://host:port?t=…` URL (the
  // gateway/devserver-proxy case carrying a fixed token; port optional). It is
  // parsed client-side into the host/port/token the bridge already stores -- no
  // wire change, no separate Token field. The token rides write-only: an edit
  // that leaves the Address as `host:port` keeps the stored token. On edit, a
  // full URL with an empty `?t=` explicitly clears it.
  import Modal from "./Modal.svelte";
  import { SquareTerminal } from "lucide-svelte";
  import { closeDialog, dialog } from "../state/dialog.svelte";
  import {
    addGateway,
    addLocalWorkspace,
    pickFolder,
    saveDevserver,
    updateGateway,
  } from "../state/library.svelte";
  import { readOnly } from "../state/capabilities";

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

  // Devserver form, seeded from the edit target. Address shows the stored
  // `host:port` (the token is write-only and never echoed); Name + Connect
  // script + Auto-hide seed from the entry.
  let address = $state(editing ? editing.url || `${editing.host}:${editing.port}` : "");
  let name = $state(editing?.label ?? "");
  let script = $state(editing?.script ?? "");
  // Auto-hide the connect control terminal once the devserver connects.
  let autoHideControl = $state(editing?.auto_hide_control ?? false);

  // Gateway form: URL + optional label. Add just adds (no probe -- the first
  // Connect discovers and signs in); the edit variant seeds from the entry.
  let gatewayUrl = $state(editingGateway?.url ?? "");
  let gatewayName = $state(editingGateway?.label ?? "");

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

  interface ParsedAddress {
    url: string;
    host: string;
    port: number | null;
    token?: string;
  }

  // Parse the polymorphic Address into host/port/token, mirroring what
  // `chan devserver register <url>` accepts so the form and the CLI stay consistent:
  //   - `http(s)://host:port?t=…`      → host + port (defaulted by scheme when
  //     absent) + the `t` query param (`?t=` clears on edit);
  //   - bare `host:port`               → host + port, no token.
  // Returns null only for blank input; an invalid port surfaces as `port: null`
  // for the caller to reject with a single message.
  function parseAddress(raw: string): ParsedAddress | null {
    const s = raw.trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) {
      try {
        const u = new URL(s);
        const host = u.hostname;
        const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
        const token = u.searchParams.get("t");
        u.searchParams.delete("t");
        u.hash = "";
        return {
          url: u.toString(),
          host,
          port: Number.isInteger(port) ? port : null,
          token: token ?? undefined,
        };
      } catch {
        return { url: "", host: "", port: null };
      }
    }
    const idx = s.lastIndexOf(":");
    if (idx <= 0 || idx === s.length - 1) {
      return { url: "", host: s, port: null };
    }
    const host = s.slice(0, idx).trim();
    const port = Number(s.slice(idx + 1).trim());
    // Reject a malformed host -- whitespace, or a leftover colon from a typo'd
    // double colon / scheme fragment. A bracketed [::1] IPv6 literal ends in "]",
    // not ":", so it survives.
    if (!host || /\s/.test(host) || host.endsWith(":")) {
      return { url: "", host: "", port: null };
    }
    return {
      url: Number.isInteger(port) ? `http://${host}:${port}` : "",
      host,
      port: Number.isInteger(port) ? port : null,
    };
  }

  function validPort(p: number | null): p is number {
    return p !== null && Number.isInteger(p) && p >= 1 && p <= 65535;
  }

  async function submitGateway(): Promise<void> {
    // Rename: the URL field is disabled, so the stored origin rides back
    // unchanged (the registry re-checks it) and only the label moves.
    if (editingGateway) {
      submitting = true;
      try {
        await updateGateway(editingGateway.id, {
          url: editingGateway.url,
          label: gatewayName.trim() || undefined,
        });
        closeDialog();
      } catch (e) {
        error = msg(e);
      } finally {
        submitting = false;
      }
      return;
    }
    const raw = gatewayUrl.trim();
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
    submitting = true;
    try {
      await addGateway({ url: raw, label: gatewayName.trim() || undefined });
      closeDialog();
    } catch (e) {
      error = msg(e);
    } finally {
      submitting = false;
    }
  }

  async function submitDevserver(): Promise<void> {
    const parsed = parseAddress(address);
    if (!parsed || !parsed.host || !validPort(parsed.port)) {
      error = "Enter an address like 127.0.0.1:8787 or https://host:port?t=…";
      return;
    }
    submitting = true;
    try {
      await saveDevserver(
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
        editing?.id,
      );
      closeDialog();
    } catch (e) {
      error = msg(e);
    } finally {
      submitting = false;
    }
  }
</script>

<Modal {title} onclose={closeDialog}>
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
        {#if !readOnly}
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
        Tip: you can also run <code>chan serve &lt;path&gt;</code> in any terminal to add a
        workspace.
      </span>
    </div>
  {:else if showGateway}
    {#if editingGateway}
      <p class="intro">
        Rename this gateway. The URL is its identity; remove and re-add the gateway to change it.
      </p>
    {:else}
      <p class="intro">
        Add a gateway to reach your devservers and devservers shared with you. Connect signs in
        once for the whole account.
      </p>
    {/if}
    <label class="field">
      Gateway URL
      <input
        type="text"
        class="mono"
        bind:value={gatewayUrl}
        placeholder="https://gateway.example.com"
        autocomplete="off"
        spellcheck="false"
        disabled={editingGateway != null}
        onkeydown={(e) => onFieldKey(e, submitGateway)} />
    </label>
    <label class="field">
      Name <span class="muted">(optional)</span>
      <input
        type="text"
        bind:value={gatewayName}
        placeholder="Defaults to the URL host"
        autocomplete="off"
        onkeydown={(e) => onFieldKey(e, submitGateway)} />
    </label>
  {:else}
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
        onkeydown={(e) => onFieldKey(e, submitDevserver)} />
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
        onkeydown={(e) => onFieldKey(e, submitDevserver)} />
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
  {/if}

  {#if error}
    <div class="error" role="alert">{error}</div>
  {/if}

  <div class="dialog-footer">
    {#if showLocal}
      <button class="btn primary" type="button" disabled={submitting} onclick={submitLocal}>
        Create workspace
      </button>
    {:else if showGateway}
      <button class="btn primary" type="button" disabled={submitting} onclick={submitGateway}>
        {editingGateway ? "Save changes" : "Add gateway"}
      </button>
    {:else if readOnlyEdit}
      <!-- Connected: read-only, so the only action is to dismiss. -->
      <button class="btn primary" type="button" onclick={closeDialog}>OK</button>
    {:else}
      <button class="btn primary" type="button" disabled={submitting} onclick={submitDevserver}>
        {editing ? "Save changes" : "Add devserver"}
      </button>
    {/if}
  </div>
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

  /* Address + path + script read as literal text the user pastes from a shell. */
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace !important;
  }

  .field textarea {
    resize: vertical;
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

  /* The command-line tip box: a terminal-iconed hint that the same thing can be
     done from a shell (chan serve). */
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
