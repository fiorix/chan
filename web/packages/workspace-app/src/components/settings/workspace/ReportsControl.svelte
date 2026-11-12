<script lang="ts">
  // chan-reports toggle for the "This workspace" settings tab. Per-workspace:
  // DashboardConfig.reports_enabled is the source of truth, written immediately
  // through the reports endpoints. The state lives in workspaceState, which
  // the settings index reads and writes too.

  import { onMount } from "svelte";
  import SettingField from "../SettingField.svelte";
  import PillToggle from "../PillToggle.svelte";
  import { settingEntry } from "../settingsIndex";
  import { loadReports, reports, setReportsEnabled } from "./workspaceState.svelte";

  const REPORTS = settingEntry("workspace.reports");

  onMount(() => {
    void loadReports();
  });
</script>

<SettingField setting={REPORTS}>
  {#snippet hint()}
    Per-file SLOC + language rollups (powered by <code>chan-report</code>).
    Aggregated stats surface in the file inspector + the graph directory
    inspector.
  {/snippet}
  <div class="stack">
    {#if reports.state === null}
      <p class="hint muted">Loading chan-reports state...</p>
    {:else}
      <PillToggle
        label={REPORTS.caption}
        checked={reports.state.enabled}
        disabled={reports.busy}
        ontoggle={(on) => void setReportsEnabled(on)}
      />
      <p class="hint muted sub-hint">
        Per-workspace setting. Disabling drops generated report data; re-enable to
        rebuild it.
      </p>
      {#if reports.busy}
        <p class="hint muted">Updating...</p>
      {/if}
      {#if reports.error}
        <p class="hint err" role="alert">{reports.error}</p>
      {/if}
    {/if}
  </div>
</SettingField>
