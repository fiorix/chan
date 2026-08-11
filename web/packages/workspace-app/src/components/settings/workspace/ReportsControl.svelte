<script lang="ts">
  // chan-reports toggle for the "This workspace" settings tab. Per-workspace:
  // DashboardConfig.reports_enabled is the source of truth, written immediately
  // through the reports endpoints.

  import { onMount } from "svelte";
  import { api } from "../../../api/client";
  import SettingField from "../SettingField.svelte";
  import PillToggle from "../PillToggle.svelte";

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

<SettingField label="chan-reports">
  {#snippet hint()}
    Per-file SLOC + language rollups (powered by <code>chan-report</code>).
    Aggregated stats surface in the file inspector + the graph directory
    inspector.
  {/snippet}
  <div class="stack">
    {#if reportsState === null}
      <p class="hint muted">Loading chan-reports state...</p>
    {:else}
      <PillToggle
        label="Enable chan-reports indexing"
        checked={reportsEnabled}
        disabled={reportsBusy}
        ontoggle={(on) => void setReportsEnabled(on)}
      />
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
  </div>
</SettingField>
