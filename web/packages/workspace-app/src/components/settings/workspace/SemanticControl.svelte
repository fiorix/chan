<script lang="ts">
  // Semantic-search opt-in + embedding-model picker for the "This workspace"
  // settings tab. The endpoints are stateful POSTs; the SPA owns the
  // downloading/enabling spinners (a model download runs a 3s poller while it
  // lands). The model file is shared across workspaces, but the enable state is
  // per-workspace.

  import { onDestroy, onMount } from "svelte";
  import { api } from "../../../api/client";
  import type {
    BuildInfo,
    SemanticModelRegistry,
    SemanticState,
  } from "../../../api/types";
  import SettingField from "../SettingField.svelte";
  import PillToggle from "../PillToggle.svelte";

  let buildInfo = $state<BuildInfo | null>(null);
  let semanticState = $state<SemanticState | null>(null);
  let semanticDownloading = $state(false);
  let semanticEnabling = $state(false);
  let semanticModelBusy = $state(false);
  let semanticModels = $state<SemanticModelRegistry | null>(null);
  let semanticError = $state<string | null>(null);
  let semanticPollTimer: ReturnType<typeof setInterval> | null = null;
  const SEMANTIC_POLL_INTERVAL_MS = 3000;

  async function loadBuildInfo(): Promise<void> {
    try {
      buildInfo = await api.buildInfo();
    } catch {
      buildInfo = null;
    }
  }

  async function loadSemanticState(): Promise<void> {
    try {
      semanticState = await api.semanticState();
    } catch {
      semanticState = null;
    }
  }

  async function loadSemanticModels(): Promise<void> {
    try {
      semanticModels = await api.semanticModels();
    } catch {
      semanticModels = null;
    }
  }

  function stopSemanticPoll(): void {
    if (semanticPollTimer !== null) {
      clearInterval(semanticPollTimer);
      semanticPollTimer = null;
    }
  }

  async function semanticToggle(next: boolean): Promise<void> {
    if (!semanticState) return;
    semanticError = null;
    if (next) {
      const selected = selectedModel();
      if (selected?.downloaded || semanticState.model_present) {
        semanticEnabling = true;
        try {
          semanticState = await api.semanticEnable();
        } catch (err) {
          semanticError = (err as Error).message;
        } finally {
          semanticEnabling = false;
        }
        return;
      }
      semanticDownloading = true;
      stopSemanticPoll();
      semanticPollTimer = setInterval(() => {
        void refreshSemanticSearchState();
      }, SEMANTIC_POLL_INTERVAL_MS);
      try {
        semanticState = await api.semanticDownload();
        await refreshSemanticSearchState();
        stopSemanticPoll();
        semanticEnabling = true;
        try {
          semanticState = await api.semanticEnable();
        } finally {
          semanticEnabling = false;
        }
      } catch (err) {
        stopSemanticPoll();
        semanticError = (err as Error).message;
        await refreshSemanticSearchState();
      } finally {
        semanticDownloading = false;
      }
    } else {
      try {
        semanticState = await api.semanticDisable();
      } catch (err) {
        semanticError = (err as Error).message;
      }
    }
  }

  function selectedModel(): SemanticModelRegistry["models"][number] | undefined {
    return semanticModels?.models.find((model) => model.id === semanticModels?.current_model);
  }

  function formatModelSize(bytes: number | null | undefined): string {
    if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "size unknown";
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  }

  function formatModelMeta(model: SemanticModelRegistry["models"][number]): string {
    const parts: string[] = [];
    parts.push(`${model.dim}d`);
    parts.push(model.size_label);
    parts.push(model.downloaded ? "downloaded" : "not downloaded");
    return parts.join(" - ");
  }

  async function changeSemanticModel(e: Event): Promise<void> {
    const model = (e.currentTarget as HTMLSelectElement).value;
    if (!model || model === semanticModels?.current_model || semanticModelBusy) return;
    semanticModelBusy = true;
    semanticError = null;
    try {
      semanticState = await api.semanticModelPatch(model);
      await refreshSemanticSearchState();
    } catch (err) {
      semanticError = (err as Error).message;
      await loadSemanticModels();
    } finally {
      semanticModelBusy = false;
    }
  }

  async function refreshSemanticSearchState(): Promise<void> {
    await Promise.all([loadSemanticState(), loadSemanticModels()]);
  }

  onMount(() => {
    void loadBuildInfo();
    void refreshSemanticSearchState();
  });

  onDestroy(() => {
    stopSemanticPoll();
  });
</script>

<SettingField label="Semantic search">
  <div class="stack">
    {#if buildInfo && !buildInfo.features.embeddings}
      <p class="hint">
        Semantic search isn't compiled into this binary. Rebuild with
        <code>--features embed-model</code> (or install a chan release that
        includes it) to enable Hybrid search.
      </p>
    {:else if semanticState === null}
      <p class="hint muted">Loading semantic-search state...</p>
    {:else}
      <p class="hint">
        Hybrid search blends BM25 keyword scoring with dense-vector similarity
        from <code>{semanticState.model_name}</code>
        ({formatModelSize(semanticState.model_size_bytes)}). The model file is
        shared across workspaces.
      </p>
      <PillToggle
        label="Enable semantic search (Hybrid mode)"
        checked={semanticState.semantic_enabled}
        disabled={semanticDownloading || semanticEnabling}
        ontoggle={(on) => void semanticToggle(on)}
      />
      {#if semanticDownloading}
        <p class="hint muted">
          <span class="spinner" aria-hidden="true"></span>
          Downloading model... this may take a few minutes.
        </p>
      {:else if semanticEnabling}
        <p class="hint muted">Enabling...</p>
      {/if}
      <div class="grid">
        <span class="k">Active</span>
        <span class="v">
          {#if semanticState.mode === "hybrid"}
            <span class="ok">Hybrid (BM25 + semantic)</span>
          {:else}
            <span class="muted">BM25</span>
          {/if}
        </span>
        <span class="k">Stored at</span>
        <span class="v mono path" title="Shared across workspaces">{semanticState.model_path}</span>
      </div>
      {#if semanticError}
        <p class="hint err" role="alert">{semanticError}</p>
      {/if}
    {/if}
  </div>
</SettingField>

<SettingField
  label="Embedding model"
  hint="Pick the workspace-wide embedding model used for dense-vector indexing. Changing it persists immediately; enabling Hybrid search downloads the selected model first when needed."
>
  <div class="stack">
    <label class="model-row">
      <span>Model</span>
      <select
        disabled={semanticModels === null ||
          semanticModelBusy ||
          semanticDownloading ||
          semanticEnabling}
        value={semanticModels?.current_model ?? ""}
        onchange={changeSemanticModel}
        aria-label="Embedding model picker"
      >
        {#if semanticModels === null}
          <option value="">Loading models...</option>
        {:else}
          {#each semanticModels.models as model (model.id)}
            <option value={model.id}>
              {model.label} - {formatModelMeta(model)}
            </option>
          {/each}
        {/if}
      </select>
    </label>
    {#if semanticModels !== null && selectedModel()}
      <p class="hint muted sub-hint">
        Selected: <code>{selectedModel()!.id}</code>.
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
