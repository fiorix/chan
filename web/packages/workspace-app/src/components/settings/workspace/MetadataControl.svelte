<script lang="ts">
  // Per-workspace metadata archive export/import for the "This workspace"
  // settings tab. Import replaces the per-workspace metadata (index, graph,
  // report, sessions) and reloads the window.

  import { Download, Upload } from "lucide-svelte";
  import { api } from "../../../api/client";
  import { formatSize } from "../../../state/format";
  import SettingField from "../SettingField.svelte";

  let metadataBusy = $state(false);
  let metadataStatus = $state<string | null>(null);
  let metadataError = $state<string | null>(null);
  let importInput: HTMLInputElement | undefined = $state();
  let metadataImportFile = $state<File | null>(null);
  let metadataImportBusy = $state(false);
  let metadataImportRescan = $state(true);
  let metadataImportForceScm = $state(false);

  async function exportMetadataArchive(): Promise<void> {
    if (metadataBusy) return;
    metadataBusy = true;
    metadataStatus = null;
    metadataError = null;
    try {
      const download = await api.metadataExport();
      const href = URL.createObjectURL(download.blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = download.filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 0);

      const details: string[] = [];
      if (download.files !== null) {
        details.push(`${download.files} ${download.files === 1 ? "file" : "files"}`);
      }
      if (download.bytes !== null) {
        details.push(formatSize(download.bytes));
      }
      metadataStatus =
        details.length > 0 ? `Exported ${details.join(", ")}` : "Archive exported";
    } catch (e) {
      metadataError = e instanceof Error ? e.message : String(e);
    } finally {
      metadataBusy = false;
    }
  }

  function chooseMetadataImportFile(): void {
    metadataError = null;
    importInput?.click();
  }

  function onMetadataImportFileChange(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    metadataImportFile = input.files?.[0] ?? null;
    metadataStatus = null;
    metadataError = null;
  }

  function clearMetadataImport(): void {
    metadataImportFile = null;
    metadataImportForceScm = false;
    metadataImportRescan = true;
    if (importInput) importInput.value = "";
  }

  async function importMetadataArchive(): Promise<void> {
    if (!metadataImportFile || metadataImportBusy) return;
    metadataImportBusy = true;
    metadataStatus = null;
    metadataError = null;
    try {
      const report = await api.metadataImport(metadataImportFile, {
        rescan: metadataImportRescan,
        forceScm: metadataImportForceScm,
      });
      const details: string[] = [`${report.files} ${report.files === 1 ? "file" : "files"}`];
      details.push(formatSize(report.bytes));
      if (report.rescanned) details.push("rescanned");
      metadataStatus = `Imported ${details.join(", ")}; reloading...`;
      clearMetadataImport();
      window.setTimeout(() => window.location.reload(), 700);
    } catch (e) {
      metadataError = e instanceof Error ? e.message : String(e);
    } finally {
      metadataImportBusy = false;
    }
  }
</script>

<SettingField
  label="Metadata archive"
  hint="Export or restore this workspace's index, graph, report, and sessions metadata as a single archive."
>
  <div class="stack">
    <div class="metadata-row">
      <button
        type="button"
        class="metadata-action"
        onclick={exportMetadataArchive}
        disabled={metadataBusy || metadataImportBusy}
      >
        <Download size={16} strokeWidth={1.75} aria-hidden="true" />
        <span>{metadataBusy ? "Exporting..." : "Export metadata archive"}</span>
      </button>
      <input
        bind:this={importInput}
        class="metadata-file-input"
        type="file"
        accept=".tar.zst,application/zstd"
        onchange={onMetadataImportFileChange}
      />
      <button
        type="button"
        class="metadata-action"
        onclick={chooseMetadataImportFile}
        disabled={metadataBusy || metadataImportBusy}
      >
        <Upload size={16} strokeWidth={1.75} aria-hidden="true" />
        <span>Import metadata archive</span>
      </button>
    </div>
    {#if metadataImportFile}
      <div class="metadata-import-panel">
        <div class="metadata-import-file">{metadataImportFile.name}</div>
        <p class="metadata-warning">
          Import replaces index, graph, report, and sessions metadata.
        </p>
        <label class="metadata-check">
          <input
            type="checkbox"
            bind:checked={metadataImportRescan}
            disabled={metadataImportBusy}
          />
          <span>Rescan after import</span>
        </label>
        <label class="metadata-check">
          <input
            type="checkbox"
            bind:checked={metadataImportForceScm}
            disabled={metadataImportBusy}
          />
          <span>Force SCM mismatch</span>
        </label>
        <div class="metadata-import-actions">
          <button
            type="button"
            class="metadata-action"
            onclick={importMetadataArchive}
            disabled={metadataImportBusy}
          >
            <Upload size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>{metadataImportBusy ? "Importing..." : "Import"}</span>
          </button>
          <button
            type="button"
            class="metadata-action subtle"
            onclick={clearMetadataImport}
            disabled={metadataImportBusy}
          >
            Cancel
          </button>
        </div>
      </div>
    {/if}
    {#if metadataStatus}
      <p class="metadata-status ok">{metadataStatus}</p>
    {/if}
    {#if metadataError}
      <p class="hint err" role="alert">{metadataError}</p>
    {/if}
  </div>
</SettingField>

<style>
  .metadata-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .metadata-action {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 30px;
    padding: 5px 10px;
    border: 1px solid var(--btn-border);
    border-radius: 4px;
    background: var(--btn-bg);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
  .metadata-action:hover:not(:disabled) {
    border-color: var(--btn-hover);
  }
  .metadata-action:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .metadata-action.subtle {
    background: transparent;
  }
  .metadata-file-input {
    display: none;
  }
  .metadata-import-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 560px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--panel-bg, transparent);
  }
  .metadata-import-file {
    font-size: 13px;
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .metadata-warning {
    margin: 0;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .metadata-check {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    width: fit-content;
    font-size: 13px;
    color: var(--text);
  }
  .metadata-check input[type="checkbox"] {
    width: auto;
    margin: 0;
  }
  .metadata-import-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .metadata-status {
    margin: 0;
    font-size: 12px;
  }
  .metadata-status.ok {
    color: var(--text-secondary);
  }
</style>
