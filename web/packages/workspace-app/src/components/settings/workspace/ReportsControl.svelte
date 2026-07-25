<script lang="ts">
  // chan-reports toggle for the "This workspace" settings tab. Per-workspace:
  // DashboardConfig.reports_enabled is the source of truth, written immediately
  // through the reports endpoints.

  import { onMount } from "svelte";
  import { api } from "../../../api/client";

  let reportsState = $state<{ enabled: boolean } | null>(null);
  let reportsBusy = $state(false);
  let reportsError = $state<string | null>(null);

  const reportsEnabled = $derived(reportsState?.enabled ?? false);

  async function loadReportsState(): Promise<void> {
    try {
      reportsState = await api.reportsState();
      reportsError = null;
    } catch (err) {
      reportsError = (err as Error).message;
    }
  }

  async function setReportsEnabled(next: boolean): Promise<void> {
    if (reportsBusy) return;
    reportsBusy = true;
    reportsError = null;
    try {
      reportsState = next ? await api.reportsEnable() : await api.reportsDisable();
    } catch (err) {
      reportsError = (err as Error).message;
      try {
        reportsState = await api.reportsState();
      } catch {
        // Keep the original write error visible.
      }
    } finally {
      reportsBusy = false;
    }
  }

  onMount(() => {
    void loadReportsState();
  });
</script>

<section>
  <h3>chan-reports</h3>
  <p class="hint">
    Per-file SLOC + language rollups (powered by <code>chan-report</code>).
    Aggregated stats surface in the file inspector + the graph directory
    inspector.
  </p>
  {#if reportsState === null}
    <p class="hint muted">Loading chan-reports state...</p>
  {:else}
    <label class="pill" class:on={reportsEnabled}>
      <input
        type="checkbox"
        checked={reportsEnabled}
        disabled={reportsBusy}
        onchange={(e) =>
          void setReportsEnabled((e.currentTarget as HTMLInputElement).checked)}
      />
      <span>Enable chan-reports indexing</span>
    </label>
    <p class="hint muted sub-hint">
      Per-workspace setting. Disabling drops generated report data; re-enable to
      rebuild it.
    </p>
    {#if reportsBusy}
      <p class="hint muted">Updating...</p>
    {/if}
    {#if reportsError}
      <p class="hint err" role="alert">{reportsError}</p>
    {/if}
  {/if}
</section>

<style>
  .hint {
    margin: 0;
    color: var(--text-secondary);
    font-size: 13px;
  }
  .hint.muted {
    color: var(--text-secondary);
    font-style: italic;
  }
  .hint.err {
    color: var(--warn-text);
  }
  .hint.sub-hint {
    font-size: 11.5px;
  }
  .hint code {
    font-family: ui-monospace, monospace;
    font-size: 12px;
    background: var(--bg-card);
    padding: 0 4px;
    border-radius: 3px;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border: 1px solid var(--btn-border);
    border-radius: 4px;
    background: var(--btn-bg);
    cursor: pointer;
    font-size: 14px;
  }
  .pill input[type="checkbox"] {
    width: auto;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
  }
  .pill > span {
    color: var(--text);
  }
  .pill:hover {
    border-color: var(--btn-hover);
  }
  .pill.on {
    border-color: var(--link);
    background: var(--hover-bg);
  }
  .pill:has(input:disabled) {
    cursor: not-allowed;
    opacity: 0.7;
  }
</style>
