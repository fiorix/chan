<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../../api/client";
  import type { GlobalConfig } from "../../api/types";

  // Recent workspaces: a read-only list from the global config endpoint.
  // chan serve takes an explicit workspace path, so there is no default-root
  // field to edit here; this section only surfaces recently-opened workspaces.
  let globalConfig = $state<GlobalConfig | null>(null);

  async function loadGlobalConfig(): Promise<void> {
    try {
      globalConfig = await api.config();
    } catch {
      globalConfig = null;
    }
  }

  function displayPathLabel(path: string): string {
    const stripped = path.replace(/[/\\]+$/, "");
    if (!stripped) return path || "(root)";
    const slash = Math.max(stripped.lastIndexOf("/"), stripped.lastIndexOf("\\"));
    return slash < 0 ? stripped : stripped.slice(slash + 1);
  }

  function formatLastSeen(iso: string): string {
    try {
      const d = new Date(iso);
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      const hh = String(d.getUTCHours()).padStart(2, "0");
      const mi = String(d.getUTCMinutes()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd} ${hh}:${mi} UTC`;
    } catch {
      return iso;
    }
  }

  onMount(() => {
    void loadGlobalConfig();
  });
</script>

<section>
  <h3>Workspaces</h3>
  <p class="hint">Workspaces you've recently opened on this machine.</p>

  {#if globalConfig?.workspaces && globalConfig.workspaces.length > 0}
    <h5 class="recents-head">Recent</h5>
    <ul class="recents">
      {#each globalConfig.workspaces as u (u.path)}
        <li>
          <span class="recents-time">{formatLastSeen(u.last_seen_at)}</span>
          <span class="recents-name" title={u.path}>{displayPathLabel(u.path)}</span>
          <span class="recents-path mono" title={u.path}>{u.path}</span>
        </li>
      {/each}
    </ul>
    <p class="hint">
      Updated every time you open a directory. In-app open-from-list
      lands in a follow-up; for now use the menu's Open Directory.
    </p>
  {/if}
</section>

<style>
  .hint {
    margin: 0;
    color: var(--text-secondary);
    font-size: 13px;
  }
  .recents-head {
    margin: 0.6rem 0 0.25rem 0;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
  }
  .recents {
    list-style: none;
    padding: 0;
    margin: 0 0 0.4rem 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .recents li {
    display: grid;
    grid-template-columns: 12em auto 1fr;
    gap: 0.6rem;
    font-size: 13px;
    color: var(--text);
    align-items: baseline;
  }
  .recents-time {
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
  .recents-name { color: var(--text); font-weight: 500; }
  .recents-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
