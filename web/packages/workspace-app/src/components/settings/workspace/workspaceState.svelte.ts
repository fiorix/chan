// What the "This workspace" controls show and change, held outside the
// controls: the settings index reads and writes the same state while the
// overlay is closed, and a control mounted meanwhile follows a change made
// from the launcher. Each control still loads its part when it mounts.
//
// Nothing pushes these values to a window, so the index asks for them again
// once they are older than WORKSPACE_STATE_MAX_AGE_MS.

import { api } from "../../../api/client";
import type { BuildInfo, SemanticModelRegistry, SemanticState } from "../../../api/types";
import { loadScreensaverState } from "../../../state/screensaver.svelte";
import type { ScreensaverTheme } from "../../../state/screensaver";
import { workspace } from "../../../state/store.svelte";

export const WORKSPACE_STATE_MAX_AGE_MS = 5000;

type SemanticModel = SemanticModelRegistry["models"][number];

// ---- chan-reports --------------------------------------------------------

export const reports = $state<{
  /// Null until the first read answers.
  state: { enabled: boolean } | null;
  busy: boolean;
  error: string | null;
}>({ state: null, busy: false, error: null });

export async function loadReports(): Promise<void> {
  try {
    reports.state = await api.reportsState();
    reports.error = null;
  } catch (err) {
    reports.error = (err as Error).message;
  }
}

/// Never rejects: a refusal is `reports.error`, with the server's state
/// read back beside it.
export async function setReportsEnabled(next: boolean): Promise<void> {
  if (reports.busy) return;
  reports.busy = true;
  reports.error = null;
  try {
    reports.state = next ? await api.reportsEnable() : await api.reportsDisable();
  } catch (err) {
    reports.error = (err as Error).message;
    try {
      reports.state = await api.reportsState();
    } catch {
      // Keep the original write error visible.
    }
  } finally {
    reports.busy = false;
  }
}

// ---- semantic search and its embedding model -------------------------------

export const semantic = $state<{
  buildInfo: BuildInfo | null;
  /// Null until the first read answers.
  state: SemanticState | null;
  models: SemanticModelRegistry | null;
  downloading: boolean;
  enabling: boolean;
  modelBusy: boolean;
  error: string | null;
}>({
  buildInfo: null,
  state: null,
  models: null,
  downloading: false,
  enabling: false,
  modelBusy: false,
  error: null,
});

const SEMANTIC_POLL_INTERVAL_MS = 3000;
let semanticPollTimer: ReturnType<typeof setInterval> | null = null;

async function loadBuildInfo(): Promise<void> {
  try {
    semantic.buildInfo = await api.buildInfo();
  } catch {
    semantic.buildInfo = null;
  }
}

async function loadSemanticState(): Promise<void> {
  try {
    semantic.state = await api.semanticState();
  } catch {
    semantic.state = null;
  }
}

async function loadSemanticModels(): Promise<void> {
  try {
    semantic.models = await api.semanticModels();
  } catch {
    semantic.models = null;
  }
}

async function refreshSemantic(): Promise<void> {
  await Promise.all([loadSemanticState(), loadSemanticModels()]);
}

export async function loadSemantic(): Promise<void> {
  await Promise.all([loadBuildInfo(), refreshSemantic()]);
}

function stopSemanticPoll(): void {
  if (semanticPollTimer !== null) {
    clearInterval(semanticPollTimer);
    semanticPollTimer = null;
  }
}

/// Whether this binary can run semantic search; true until the build says
/// otherwise.
export function semanticCompiledIn(): boolean {
  return !(semantic.buildInfo && !semantic.buildInfo.features.embeddings);
}

export function selectedSemanticModel(): SemanticModel | undefined {
  return semantic.models?.models.find((model) => model.id === semantic.models?.current_model);
}

/// A model as the picker lists it.
export function semanticModelLabel(model: SemanticModel): string {
  const meta = [`${model.dim}d`, model.size_label, model.downloaded ? "downloaded" : "not downloaded"];
  return `${model.label} - ${meta.join(" - ")}`;
}

/// Enable or disable semantic search. Enabling downloads the selected model
/// first when it is not on disk, polling the state while it lands. Never
/// rejects: a refusal is `semantic.error`.
export async function setSemanticEnabled(next: boolean): Promise<void> {
  if (!semantic.state || semantic.downloading || semantic.enabling) return;
  semantic.error = null;
  if (!next) {
    try {
      semantic.state = await api.semanticDisable();
    } catch (err) {
      semantic.error = (err as Error).message;
    }
    return;
  }
  if (selectedSemanticModel()?.downloaded || semantic.state.model_present) {
    semantic.enabling = true;
    try {
      semantic.state = await api.semanticEnable();
    } catch (err) {
      semantic.error = (err as Error).message;
    } finally {
      semantic.enabling = false;
    }
    return;
  }
  semantic.downloading = true;
  stopSemanticPoll();
  semanticPollTimer = setInterval(() => {
    void refreshSemantic();
  }, SEMANTIC_POLL_INTERVAL_MS);
  try {
    semantic.state = await api.semanticDownload();
    await refreshSemantic();
    stopSemanticPoll();
    semantic.enabling = true;
    try {
      semantic.state = await api.semanticEnable();
    } finally {
      semantic.enabling = false;
    }
  } catch (err) {
    stopSemanticPoll();
    semantic.error = (err as Error).message;
    await refreshSemantic();
  } finally {
    semantic.downloading = false;
  }
}

/// Pick the workspace's embedding model. Never rejects: a refusal is
/// `semantic.error`.
export async function setSemanticModel(model: string): Promise<void> {
  if (!model || model === semantic.models?.current_model || semantic.modelBusy) return;
  semantic.modelBusy = true;
  semantic.error = null;
  try {
    semantic.state = await api.semanticModelPatch(model);
    await refreshSemantic();
  } catch (err) {
    semantic.error = (err as Error).message;
    await loadSemanticModels();
  } finally {
    semantic.modelBusy = false;
  }
}

// ---- screen lock -----------------------------------------------------------

/// Write a screen lock setting and load it into the running lock, whose
/// state is what the control and the index both show.
export async function patchScreenLock(body: {
  enabled?: boolean;
  timeout_secs?: number;
  theme?: ScreensaverTheme;
}): Promise<void> {
  await api.screensaverPatch(body);
  await loadScreensaverState();
}

// ---- the index's reads -----------------------------------------------------

let loadedAt: number | null = null;
let loading = false;

/// Ask for the reports and semantic state when it has never been read or
/// has aged out. Safe to call from a derived read: the request starts in a
/// later turn and nothing is written before it answers.
export function refreshWorkspaceStateIfStale(): void {
  if (workspace.info === null || loading) return;
  if (loadedAt !== null && Date.now() - loadedAt < WORKSPACE_STATE_MAX_AGE_MS) return;
  loading = true;
  queueMicrotask(() => {
    // What the binary was built with does not change under a window.
    const semanticLoad = semantic.buildInfo ? refreshSemantic() : loadSemantic();
    void Promise.all([loadReports(), semanticLoad]).finally(() => {
      loadedAt = Date.now();
      loading = false;
    });
  });
}

export function resetWorkspaceStateForTests(): void {
  stopSemanticPoll();
  loadedAt = null;
  loading = false;
  Object.assign(reports, { state: null, busy: false, error: null });
  Object.assign(semantic, {
    buildInfo: null,
    state: null,
    models: null,
    downloading: false,
    enabling: false,
    modelBusy: false,
    error: null,
  });
}
