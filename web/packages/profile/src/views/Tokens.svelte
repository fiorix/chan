<script lang="ts">
  import { onMount } from "svelte";
  import {
    api,
    type Token,
    type CreatedToken,
    type AuditEntry,
  } from "../lib/api";

  let tokens = $state<Token[]>([]);
  let loading = $state(true);
  let listError = $state<string | null>(null);

  // Create-modal state.
  let showCreate = $state(false);
  let newLabel = $state("");
  let newExpiry = $state<"30d" | "90d" | "1y" | "never">("90d");
  let creating = $state(false);
  let createError = $state<string | null>(null);
  let justCreated = $state<CreatedToken | null>(null);
  let copied = $state(false);

  // Per-token audit drilldown: id -> rows | "loading" | "error".
  // Absent key means the row is collapsed.
  let auditOpen = $state<Record<string, AuditEntry[] | "loading" | "error">>(
    {},
  );

  onMount(refresh);

  async function refresh() {
    loading = true;
    listError = null;
    try {
      tokens = await api.listTokens();
    } catch (e) {
      listError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  function expiresInSeconds(preset: typeof newExpiry): number | null {
    switch (preset) {
      case "30d": return 30 * 24 * 60 * 60;
      case "90d": return 90 * 24 * 60 * 60;
      case "1y":  return 365 * 24 * 60 * 60;
      case "never": return null;
    }
  }

  async function create(e: Event) {
    e.preventDefault();
    if (!newLabel.trim()) return;
    creating = true;
    createError = null;
    try {
      const created = await api.createToken(
        newLabel.trim(),
        expiresInSeconds(newExpiry),
      );
      justCreated = created;
      newLabel = "";
      newExpiry = "90d";
      await refresh();
    } catch (err) {
      createError = err instanceof Error ? err.message : String(err);
    } finally {
      creating = false;
    }
  }

  let copyError = $state<string | null>(null);

  async function copySecret() {
    if (!justCreated) return;
    copyError = null;
    try {
      await navigator.clipboard.writeText(justCreated.secret);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      copyError = "Copy failed. Select the token and copy manually.";
    }
  }

  function dismissCreated() {
    justCreated = null;
    showCreate = false;
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this token? Existing chan devserver sessions using it will be disconnected.")) return;
    await api.revokeToken(id);
    await refresh();
  }

  async function toggleAudit(id: string) {
    if (auditOpen[id]) {
      delete auditOpen[id];
      return;
    }
    auditOpen[id] = "loading";
    try {
      auditOpen[id] = await api.tokenAudit(id);
    } catch {
      auditOpen[id] = "error";
    }
  }

  function fmt(ts: string | null): string {
    if (!ts) return "-";
    return new Date(ts).toLocaleString();
  }

  function status(t: Token): string {
    if (t.revoked_at) return "revoked";
    if (t.expires_at && new Date(t.expires_at) < new Date()) return "expired";
    return "active";
  }
</script>

<section class="page">
  <div class="head">
    <h1>Personal access tokens</h1>
    <button onclick={() => (showCreate = true)}>New token</button>
  </div>
  <p class="muted">
    Tokens authenticate <code>chan devserver run --tunnel-token</code> and other
    CLI clients. Treat them like passwords: a token grants the same
    access as your account, scoped to your workspaces only.
  </p>

  {#if listError}
    <p class="error small">{listError}</p>
  {/if}

  {#if loading}
    <p class="muted">Loading...</p>
  {:else if tokens.length === 0}
    <p class="muted small">No tokens yet.</p>
  {:else}
    <ul class="tokens">
      {#each tokens as t (t.id)}
        <li>
          <div class="row">
            <strong>{t.label}</strong>
            <span class="status {status(t)}">{status(t)}</span>
            <span class="muted small">
              created {fmt(t.created_at)}
              {#if t.expires_at} - expires {fmt(t.expires_at)}{/if}
              {#if t.last_used_at} - last used {fmt(t.last_used_at)}{/if}
            </span>
            <span class="actions">
              <button onclick={() => toggleAudit(t.id)}>
                {auditOpen[t.id] ? "Hide audit" : "Audit"}
              </button>
              {#if !t.revoked_at}
                <button class="destructive" onclick={() => revoke(t.id)}>
                  Revoke
                </button>
              {/if}
            </span>
          </div>
          {#if auditOpen[t.id]}
            <div class="audit">
              {#if auditOpen[t.id] === "loading"}
                <p class="muted small">Loading audit...</p>
              {:else if auditOpen[t.id] === "error"}
                <p class="error small">Could not load audit log.</p>
              {:else}
                <table>
                  <thead>
                    <tr><th>When</th><th>Action</th><th>IP</th><th>UA</th></tr>
                  </thead>
                  <tbody>
                    {#each auditOpen[t.id] as AuditEntry[] as row (row.id)}
                      <tr>
                        <td>{fmt(row.ts)}</td>
                        <td>{row.action}</td>
                        <td>{row.ip ?? "-"}</td>
                        <td class="ua">{row.user_agent ?? "-"}</td>
                      </tr>
                    {/each}
                    {#if (auditOpen[t.id] as AuditEntry[]).length === 0}
                      <tr><td colspan="4" class="muted">No events.</td></tr>
                    {/if}
                  </tbody>
                </table>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<svelte:window
  onkeydown={(e) => {
    if (showCreate && e.key === "Escape") dismissCreated();
  }}
/>

{#if showCreate}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- Backdrop closes on click; keyboard close is handled by the
       window Escape listener above, so the backdrop itself does
       not need a keydown handler. -->
  <div class="modal-backdrop" onclick={dismissCreated} role="presentation">
    <div
      class="modal"
      onclick={(e) => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
      tabindex="-1"
    >
      {#if justCreated}
        <h2>Token created</h2>
        <p class="muted small">
          Copy this token now. We won't show it again.
        </p>
        <div class="secret-row">
          <code class="secret">{justCreated.secret}</code>
          <button onclick={copySecret}>{copied ? "Copied" : "Copy"}</button>
        </div>
        {#if copyError}
          <p class="error small">{copyError}</p>
        {/if}
        <div class="modal-actions">
          <button onclick={dismissCreated}>Done</button>
        </div>
      {:else}
        <h2>New personal access token</h2>
        <form onsubmit={create}>
          <label>
            Label
            <input
              type="text"
              bind:value={newLabel}
              placeholder="e.g. laptop, ci-runner"
              maxlength="64"
              required
            />
          </label>
          <label>
            Expiry
            <select bind:value={newExpiry}>
              <option value="30d">30 days</option>
              <option value="90d">90 days</option>
              <option value="1y">1 year</option>
              <option value="never">Never</option>
            </select>
          </label>
          {#if createError}
            <p class="error small">{createError}</p>
          {/if}
          <div class="modal-actions">
            <button type="button" onclick={dismissCreated}>Cancel</button>
            <button type="submit" disabled={creating}>
              {creating ? "Creating..." : "Create"}
            </button>
          </div>
        </form>
      {/if}
    </div>
  </div>
{/if}

<style>
  .page {
    max-width: 720px;
    width: 100%;
    margin: 0 auto;
    padding: 1.5rem 1rem 4rem;
    box-sizing: border-box;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: .5rem;
  }
  h1 { color: var(--text-heading); font-size: 22px; margin: .25rem 0; }
  ul.tokens {
    list-style: none;
    margin: .75rem 0 0;
    padding: 0;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  ul.tokens li {
    padding: .65rem .85rem;
    border-bottom: 1px solid var(--border);
  }
  ul.tokens li:last-child { border-bottom: none; }
  .row {
    display: grid;
    grid-template-columns: minmax(6ch, 16ch) auto 1fr auto;
    align-items: center;
    gap: .5rem;
  }
  .actions { display: flex; gap: .35rem; }
  .status {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: .05em;
    padding: 2px 6px;
    border-radius: 999px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    color: var(--text-secondary);
  }
  .status.active { color: var(--accent); border-color: var(--accent); }
  .status.revoked, .status.expired {
    color: var(--warn-text);
    border-color: var(--warn-text);
  }
  .audit {
    margin-top: .5rem;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: .35rem .65rem;
  }
  .audit table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .audit th, .audit td {
    text-align: left;
    padding: .25rem .35rem;
    border-bottom: 1px solid var(--border);
  }
  .audit tr:last-child td { border-bottom: none; }
  .audit .ua {
    max-width: 24ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10;
  }
  .modal {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1rem 1.1rem;
    width: min(440px, calc(100% - 2rem));
  }
  .modal h2 {
    margin: 0 0 .5rem;
    font-size: 16px;
    color: var(--text-heading);
    text-transform: none;
    letter-spacing: 0;
  }
  .modal label {
    display: flex;
    flex-direction: column;
    gap: .25rem;
    margin-bottom: .65rem;
    font-size: 13px;
    color: var(--text-secondary);
  }
  .modal input, .modal select {
    font: inherit;
    color: var(--text);
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: .4rem .55rem;
  }
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: .5rem;
    margin-top: .5rem;
  }
  .secret-row {
    display: flex;
    gap: .5rem;
    align-items: center;
  }
  code.secret {
    flex: 1;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: .4rem .55rem;
    font-size: 12px;
    overflow-x: auto;
    white-space: nowrap;
  }
  button.destructive {
    border-color: var(--warn-text);
    color: var(--warn-text);
  }
  .error { color: var(--warn-text); }
  .small { font-size: 12px; }
  .muted { color: var(--text-secondary); }
</style>
