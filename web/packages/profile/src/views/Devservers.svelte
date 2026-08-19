<script lang="ts">
  import {
    api,
    HttpError,
    type Devserver,
    type DevserverGrant,
    type IncomingShare,
    type OwnedDevserverSummary,
  } from "../lib/api";
  import { meStore } from "../state/me.svelte";

  // `devservers` is the live snapshot from /api/me (one per user, keyed
  // devserver_id), used to flip owned rows online/offline.
  let { devservers }: { devservers: Devserver[] } = $props();

  // Owned devservers (label + grant_count, profile-backed) and the
  // shared-with-me list. Loaded here so /api/me stays small for users
  // who never open this tab.
  let owned = $state<OwnedDevserverSummary[]>([]);
  let incoming = $state<IncomingShare[]>([]);
  let loadingLists = $state(true);
  let listsError = $state<string | null>(null);

  // Per-devserver grant cache, keyed by devserver_id. Populated on first
  // expand; later updates mutate in place.
  let grants = $state<Record<string, DevserverGrant[]>>({});
  let grantsLoading = $state<Record<string, boolean>>({});
  let grantsError = $state<Record<string, string | null>>({});

  // Which devserver's share panel is open (single-open keeps it compact).
  let expanded = $state<string | null>(null);

  // Add-grant form state, keyed by devserver_id. Reset on submit.
  let addEmail = $state<Record<string, string>>({});
  let addBusy = $state<Record<string, boolean>>({});
  let addError = $state<Record<string, string | null>>({});

  let refreshing = $state(false);

  function unifyDevservers() {
    // My devservers = owned (profile roster, authoritative) with online
    // flipped on when a live tunnel reports the same devserver_id. A
    // live devserver missing from owned (registered before the row
    // existed) is appended so nothing disappears between renders.
    const liveIds = new Set(devservers.map((d) => d.devserver_id));
    const seen = new Set<string>();
    const rows: { id: string; label: string; online: boolean; grantCount: number }[] = [];
    for (const o of owned) {
      rows.push({
        id: o.devserver_id,
        label: o.label || o.devserver_id.slice(0, 12),
        online: liveIds.has(o.devserver_id),
        grantCount: o.grant_count,
      });
      seen.add(o.devserver_id);
    }
    for (const d of devservers) {
      if (!seen.has(d.devserver_id)) {
        rows.push({
          id: d.devserver_id,
          label: d.devserver_id.slice(0, 12),
          online: true,
          grantCount: 0,
        });
        seen.add(d.devserver_id);
      }
    }
    rows.sort((a, b) => a.label.localeCompare(b.label));
    return rows;
  }

  let myDevservers = $derived(unifyDevservers());

  async function loadLists() {
    loadingLists = true;
    listsError = null;
    try {
      const [o, i] = await Promise.all([
        api.listOwnedDevservers(),
        api.listIncomingShares(),
      ]);
      owned = o;
      incoming = i;
    } catch (e) {
      listsError = e instanceof Error ? e.message : String(e);
    } finally {
      loadingLists = false;
    }
  }

  async function refresh() {
    refreshing = true;
    try {
      await Promise.all([meStore.refresh(), loadLists()]);
    } finally {
      refreshing = false;
    }
  }

  async function loadGrants(devserverId: string, force = false) {
    if (grants[devserverId] && !force) return;
    grantsLoading[devserverId] = true;
    grantsError[devserverId] = null;
    try {
      grants[devserverId] = await api.listDevserverGrants(devserverId);
    } catch (e) {
      grantsError[devserverId] = e instanceof Error ? e.message : String(e);
    } finally {
      grantsLoading[devserverId] = false;
    }
  }

  function toggle(devserverId: string) {
    if (expanded === devserverId) {
      expanded = null;
      return;
    }
    expanded = devserverId;
    void loadGrants(devserverId);
  }

  // The `?d=` selector for a devserver: the first 12 hex chars of its
  // id (the disc that also names its `{user}--{disc}` wildcard host).
  function discOf(devserverId: string): string {
    return devserverId.slice(0, 12);
  }

  // Open one devserver: hand off to the identity `/s/{owner}?d=<disc>`
  // route, which mints a `__Host-devserver_gate` entry token and redirects
  // through the proxy to the launcher served at the devserver root.
  // These are the signed-in user's OWN devservers, so the owner is
  // always us. Only offered for an online devserver (an offline one
  // has no live tunnel to open). Same-origin navigation, so a
  // relative path is enough.
  function openDevserver(devserverId: string) {
    const username = meStore.me?.user.username;
    if (!username) return;
    window.location.href =
      `/s/${encodeURIComponent(username)}?d=${discOf(devserverId)}`;
  }

  // Copy an absolute `?d=`-qualified open link for one devserver.
  // The link runs the same access check server-side, so it is safe to
  // hand to a grantee (they land only if a grant admits them).
  let copied = $state<string | null>(null);
  async function copyDevserverLink(devserverId: string) {
    const username = meStore.me?.user.username;
    if (!username) return;
    const url =
      `${window.location.origin}/s/${encodeURIComponent(username)}?d=${discOf(devserverId)}`;
    try {
      await navigator.clipboard.writeText(url);
      copied = devserverId;
      setTimeout(() => {
        if (copied === devserverId) copied = null;
      }, 1500);
    } catch {
      // Clipboard denied (permissions/insecure context): leave the
      // button label unchanged rather than surfacing an error row.
    }
  }

  // Client-side email shape check; stricter than the backend's lax
  // `valid_email` because a grant only resolves when an OAuth sign-in
  // surfaces the same address, so a typo'd row would never claim.
  function isLikelyEmail(s: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  }

  async function addGrant(devserverId: string) {
    const email = (addEmail[devserverId] ?? "").trim();
    if (!isLikelyEmail(email)) {
      addError[devserverId] = "Enter a valid email (local@host.tld)";
      return;
    }
    addBusy[devserverId] = true;
    addError[devserverId] = null;
    try {
      const row = await api.addDevserverGrant(devserverId, email);
      const list = grants[devserverId] ?? [];
      // create-or-promote: replace an existing row for this email,
      // else prepend so the newest is visible.
      const idx = list.findIndex((g) => g.id === row.id);
      grants[devserverId] = idx >= 0
        ? [...list.slice(0, idx), row, ...list.slice(idx + 1)]
        : [row, ...list];
      addEmail[devserverId] = "";
      void loadLists();
    } catch (e) {
      addError[devserverId] = e instanceof HttpError
        ? e.message
        : e instanceof Error ? e.message : String(e);
    } finally {
      addBusy[devserverId] = false;
    }
  }

  async function removeGrant(devserverId: string, id: string) {
    try {
      await api.deleteDevserverGrant(id);
      grants[devserverId] = (grants[devserverId] ?? []).filter((g) => g.id !== id);
      void loadLists();
    } catch (e) {
      grantsError[devserverId] = e instanceof Error ? e.message : String(e);
    }
  }

  $effect(() => {
    void loadLists();
  });
</script>

<section class="devservers">
  <header>
    <h2>Devservers</h2>
    <button class="ghost" type="button" disabled={refreshing} onclick={refresh}>
      {refreshing ? "Refreshing..." : "Refresh"}
    </button>
  </header>

  <div class="block">
    <h3>My devservers</h3>
    <p class="muted small">
      A devserver is one of your access tokens running <code>chan devserver run</code>;
      it exposes your whole workspace library. Create one under the Tokens
      tab, then run <code>chan devserver run --tunnel-token=&lt;token&gt;</code>.
      Sharing grants shell-equivalent access to the whole devserver, including
      its terminals, processes, files, and every workspace it serves.
      A grantee can copy credentials or install persistence on the host.
      Revoking the grant closes future Chan access, but cannot undo host changes
      or recover secrets already copied.
    </p>

    {#if myDevservers.length === 0 && !loadingLists}
      <div class="empty">
        <p>No devservers yet.</p>
        <p class="muted small">
          Generate a token under the Tokens tab, then run
          <code>chan devserver run --tunnel-token=&lt;token&gt;</code> on the machine
          that holds your workspaces.
        </p>
      </div>
    {:else}
      <ul class="list">
        {#each myDevservers as d (d.id)}
          <li class="card" class:offline={!d.online}>
            <div class="row">
              <div class="meta">
                <div class="label">{d.label}</div>
                <div class="muted small">
                  {#if d.online}
                    Online
                  {:else}
                    Offline - run <code>chan devserver run --tunnel-token=&lt;token&gt;</code>
                  {/if}
                  {#if d.grantCount > 0}
                    &middot; {d.grantCount} grant{d.grantCount === 1 ? "" : "s"}
                  {/if}
                </div>
              </div>
              <div class="actions">
                <span class="status" data-status={d.online ? "online" : "offline"} aria-hidden="true">
                  {d.online ? "online" : "offline"}
                </span>
                {#if d.online}
                  <button type="button" class="ghost" onclick={() => openDevserver(d.id)}>
                    Open
                  </button>
                  <button
                    type="button"
                    class="ghost"
                    onclick={() => copyDevserverLink(d.id)}
                  >
                    {copied === d.id ? "Copied" : "Copy link"}
                  </button>
                {/if}
                <button
                  type="button"
                  class="ghost"
                  onclick={() => toggle(d.id)}
                  aria-expanded={expanded === d.id}
                >
                  {expanded === d.id ? "Hide" : "Share"}
                </button>
              </div>
            </div>

            {#if expanded === d.id}
              <div class="panel">
                <strong>Share this devserver</strong>
                <p class="muted small">
                  Grant by email. This is shell-equivalent access to the whole
                  devserver, including terminals, processes, files, and every
                  workspace it serves. The grant activates after sign-in with a
                  matching verified email. A grantee can copy credentials or
                  install persistence on the host; later revocation closes Chan
                  access but cannot undo host changes or secrets already copied.
                </p>

                <form
                  class="addgrant"
                  onsubmit={(e) => {
                    e.preventDefault();
                    void addGrant(d.id);
                  }}
                >
                  <input
                    type="email"
                    placeholder="grantee@example.com"
                    bind:value={addEmail[d.id]}
                    disabled={addBusy[d.id]}
                    autocomplete="off"
                    spellcheck="false"
                  />
                  <button
                    type="submit"
                    disabled={addBusy[d.id] || !isLikelyEmail((addEmail[d.id] ?? "").trim())}
                  >
                    {addBusy[d.id] ? "..." : "Add"}
                  </button>
                </form>
                {#if addError[d.id]}
                  <p class="err small">{addError[d.id]}</p>
                {/if}

                {#if grantsLoading[d.id]}
                  <p class="muted small">Loading grants...</p>
                {:else if grantsError[d.id]}
                  <p class="err small">{grantsError[d.id]}</p>
                {:else if (grants[d.id]?.length ?? 0) === 0}
                  <p class="muted small">No grants yet. The devserver stays
                    private until you add at least one.</p>
                {:else}
                  <ul class="grantlist">
                    {#each grants[d.id] ?? [] as g (g.id)}
                      <li>
                        <span class="grant-email">{g.grantee_email}</span>
                        <span class="grant-status muted small">
                          {g.accepted_at ? "active" : "pending sign-in"}
                        </span>
                        <button
                          type="button"
                          class="ghost small-btn"
                          onclick={() => removeGrant(d.id, g.id)}
                          aria-label="Revoke"
                        >
                          Revoke
                        </button>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="block">
    <h3>Shared with me</h3>
    {#if loadingLists}
      <p class="muted small">Loading...</p>
    {:else if listsError}
      <p class="err small">{listsError}</p>
    {:else if incoming.length === 0}
      <p class="muted small">Nothing has been shared with you yet.</p>
    {:else}
      <ul class="list">
        {#each incoming as s (s.grant_id)}
          <li class="card">
            <div class="row">
              <div class="meta">
                <div class="label">
                  {s.label || s.devserver_id.slice(0, 12)}
                  <span class="muted small"> - from @{s.owner_username}</span>
                </div>
                <div class="muted small">Shell-equivalent devserver access</div>
              </div>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>

<style>
  .devservers {
    max-width: 720px;
    width: 100%;
    margin: 0 auto;
    padding: 1rem;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
  }
  h3 {
    margin: 0 0 .5rem 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .block {
    display: flex;
    flex-direction: column;
    gap: .5rem;
  }
  .empty {
    border: 1px dashed var(--border);
    border-radius: 8px;
    padding: 1.25rem;
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: .5rem;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: .5rem;
  }
  .card {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: .75rem 1rem;
    background: var(--card-bg, transparent);
  }
  .card.offline {
    opacity: .85;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  .meta { min-width: 0; }
  .label {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .muted { color: var(--text-secondary); }
  .small { font-size: 13px; }
  .err { color: var(--warn-text, #b14a3a); }
  .actions {
    display: flex;
    align-items: center;
    gap: .5rem;
    flex-shrink: 0;
  }
  .status {
    text-transform: uppercase;
    font-size: 11px;
    letter-spacing: .04em;
    color: var(--text-secondary);
  }
  .status[data-status="online"] {
    color: var(--ok-text, #2a8c4a);
  }
  .panel {
    margin-top: .75rem;
    padding-top: .75rem;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: .5rem;
  }
  .addgrant {
    display: flex;
    gap: .5rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .addgrant input[type="email"] {
    flex: 1;
    min-width: 12rem;
  }
  .grantlist {
    list-style: none;
    margin: .25rem 0 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: .25rem;
  }
  .grantlist li {
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    gap: .5rem;
    padding: .25rem .5rem;
    border-radius: 4px;
  }
  .grantlist li:hover {
    background: var(--card-bg-hover, rgba(127, 127, 127, .06));
  }
  .grant-email {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  input {
    font: inherit;
    padding: .35rem .5rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--input-bg, transparent);
    color: inherit;
  }
  button {
    font: inherit;
    padding: .35rem .75rem;
    border-radius: 6px;
    cursor: pointer;
  }
  button.ghost {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-secondary);
  }
  button.ghost:hover:not(:disabled) {
    color: var(--text);
  }
  button.small-btn {
    padding: .2rem .5rem;
    font-size: 12px;
  }
  button:disabled {
    opacity: .5;
    cursor: not-allowed;
  }
  code {
    background: var(--code-bg, rgba(127, 127, 127, .12));
    padding: .1em .35em;
    border-radius: 3px;
    font-size: .9em;
  }
</style>
