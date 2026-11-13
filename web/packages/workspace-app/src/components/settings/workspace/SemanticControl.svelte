<script lang="ts">
  // Semantic-search opt-in + embedding-model picker for the "This workspace"
  // settings tab. The endpoints are stateful POSTs, and their state and the
  // downloading/enabling spinners live in workspaceState, which the settings
  // index reads and writes too (a model download runs a 3s poller while it
  // lands). The model file is shared across workspaces, but the enable state
  // is per-workspace.

  import { onMount } from "svelte";
  import { formatSize } from "../../../state/format";
  import SettingField from "../SettingField.svelte";
  import PillToggle from "../PillToggle.svelte";
  import { optionsOf, settingEntry } from "../settingsIndex";
  import {
    loadSemantic,
    selectedSemanticModel,
    semantic,
    semanticCompiledIn,
    setSemanticEnabled,
    setSemanticModel,
  } from "./workspaceState.svelte";

  const SEMANTIC = settingEntry("workspace.semantic");
  const MODEL = settingEntry("workspace.embeddingModel");

  function formatModelSize(bytes: number | null | undefined): string {
    if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "size unknown";
    return formatSize(bytes);
  }

  onMount(() => {
    void loadSemantic();
  });
</script>

<SettingField setting={SEMANTIC}>
  <div class="stack">
    {#if !semanticCompiledIn()}
      <p class="hint">
        Semantic search isn't compiled into this binary. Rebuild with
        <code>--features embed-model</code> (or install a chan release that
        includes it) to enable Hybrid search.
      </p>
    {:else if semantic.state === null}
      <p class="hint muted">Loading semantic-search state...</p>
    {:else}
      <p class="hint">
        Hybrid search blends BM25 keyword scoring with dense-vector similarity
        from <code>{semantic.state.model_name}</code>
        ({formatModelSize(semantic.state.model_size_bytes)}). The model file is
        shared across workspaces.
      </p>
      <PillToggle
        label={SEMANTIC.caption}
        checked={semantic.state.semantic_enabled}
        disabled={semantic.downloading || semantic.enabling}
        ontoggle={(on) => void setSemanticEnabled(on)}
      />
      {#if semantic.downloading}
        <p class="hint muted">
          <span class="spinner" aria-hidden="true"></span>
          Downloading model... this may take a few minutes.
        </p>
      {:else if semantic.enabling}
        <p class="hint muted">Enabling...</p>
      {/if}
      <div class="grid">
        <span class="k">Active</span>
        <span class="v">
          {#if semantic.state.mode === "hybrid"}
            <span class="ok">Hybrid (BM25 + semantic)</span>
          {:else}
            <span class="muted">BM25</span>
          {/if}
        </span>
        <span class="k">Stored at</span>
        <span class="v mono path" title="Shared across workspaces">{semantic.state.model_path}</span>
      </div>
      {#if semantic.error}
        <p class="hint err" role="alert">{semantic.error}</p>
      {/if}
    {/if}
  </div>
</SettingField>

<SettingField
  setting={MODEL}
  hint="Pick the workspace-wide embedding model used for dense-vector indexing. Changing it persists immediately; enabling Hybrid search downloads the selected model first when needed."
>
  <div class="stack">
    <label class="model-row">
      <span>{MODEL.caption}</span>
      <select
        disabled={semantic.models === null ||
          semantic.modelBusy ||
          semantic.downloading ||
          semantic.enabling}
        value={semantic.models?.current_model ?? ""}
        onchange={(e) => void setSemanticModel(e.currentTarget.value)}
        aria-label="Embedding model picker"
      >
        {#if semantic.models === null}
          <option value="">Loading models...</option>
        {:else}
          {#each optionsOf(MODEL) as model (model.value)}
            <option value={model.value}>{model.label}</option>
          {/each}
        {/if}
      </select>
    </label>
    {#if semantic.models !== null && selectedSemanticModel()}
      <p class="hint muted sub-hint">
        Selected: <code>{selectedSemanticModel()!.id}</code>.
      </p>
    {/if}
  </div>
</SettingField>

<style>
  .model-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
  }
  .model-row > span {
    color: var(--text-secondary);
    font-size: 14px;
    min-width: 5em;
  }
  .model-row select {
    flex: 1;
    min-width: 12em;
  }
  .v .ok {
    color: var(--accent);
  }
  .muted {
    color: var(--text-secondary);
    font-style: italic;
  }
  .spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    margin-right: 4px;
    border: 2px solid var(--border);
    border-top-color: var(--link);
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
    vertical-align: -2px;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
      border-top-color: var(--border);
    }
  }
</style>
