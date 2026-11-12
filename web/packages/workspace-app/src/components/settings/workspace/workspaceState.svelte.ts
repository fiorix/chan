// What the "This workspace" controls show and change, held outside the
// controls: the settings index reads and writes the same state while the
// overlay is closed, and a control mounted meanwhile follows a change made
// from the launcher. Each control still loads its part when it mounts.
//
// Nothing pushes these values to a window, so the index asks for them again
// once they are older than WORKSPACE_STATE_MAX_AGE_MS. A read and a write of
// one setting travel on separate requests and can answer in either order, so
// each setting's reads are ordered against its writes: see `writeOrder`.

import { api } from "../../../api/client";
import type { BuildInfo, SemanticModelRegistry, SemanticState } from "../../../api/types";
import { applyScreensaverState } from "../../../state/screensaver.svelte";
import type { ScreensaverTheme } from "../../../state/screensaver";
import { workspace } from "../../../state/store.svelte";

export const WORKSPACE_STATE_MAX_AGE_MS = 5000;

/// What a write answers while an earlier write of the same setting is still
/// on its way. A control disables itself for that long; the launcher has no
/// such state and is told instead.
const IN_FLIGHT = "An earlier change to this setting is still in progress";

type SemanticModel = SemanticModelRegistry["models"][number];

/// Orders the reads of one setting's state against its writes. A read may
/// apply its answer only while no write has applied an answer of its own
/// since the read was sent: the read may have seen the state from before
/// that answer, and must not land over it. A read answered before the write
/// has any answer still shows, which is how a download is followed while it
/// runs.
function writeOrder() {
  let answers = 0;
  let under = 0;
  return {
    /// A write begins.
    begin(): void {
      under += 1;
    },
    /// The write under way has applied an answer and goes on. Called in the
    /// turn that applies it, so no read can land between the two.
    answered(): void {
      answers += 1;
    },
    /// The write ends, in the turn that applies its last answer.
    end(): void {
      if (under > 0) under -= 1;
      answers += 1;
    },
    /// Called as a read is sent. Its answer applies only while the returned
    /// check holds.
    reading(): () => boolean {
      const sentAt = answers;
      return () => sentAt === answers;
    },
    /// Whether a write is under way.
    writing: (): boolean => under > 0,
    /// Start over with no write under way. One left unanswered may still
    /// end later, and a read sent before now no longer applies.
    reset(): void {
      under = 0;
      answers += 1;
    },
  };
}

// ---- chan-reports --------------------------------------------------------

export const reports = $state<{
  /// Null until the first read answers.
  state: { enabled: boolean } | null;
  busy: boolean;
  error: string | null;
}>({ state: null, busy: false, error: null });

const reportsOrder = writeOrder();

export async function loadReports(): Promise<void> {
  const current = reportsOrder.reading();
  try {
    const state = await api.reportsState();
    if (!current()) return;
    reports.state = state;
    reports.error = null;
  } catch (err) {
    if (current()) reports.error = (err as Error).message;
  }
}

/// Never rejects: it answers the refusal, or null once the write landed.
/// The refusal is also `reports.error`, with the server's state read back
/// beside it.
export async function setReportsEnabled(next: boolean): Promise<string | null> {
  if (reports.busy) return IN_FLIGHT;
  reports.busy = true;
  reports.error = null;
  reportsOrder.begin();
  try {
    reports.state = next ? await api.reportsEnable() : await api.reportsDisable();
    return null;
  } catch (err) {
    const refusal = (err as Error).message;
    reports.error = refusal;
    try {
      reports.state = await api.reportsState();
    } catch {
      // Keep the original write error visible.
    }
    return refusal;
  } finally {
    reports.busy = false;
    reportsOrder.end();
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

const semanticOrder = writeOrder();

async function loadSemanticState(): Promise<void> {
  const current = semanticOrder.reading();
  const state = await api.semanticState().catch(() => null);
  if (current()) semantic.state = state;
}

async function loadSemanticModels(): Promise<void> {
  const current = semanticOrder.reading();
  const models = await api.semanticModels().catch(() => null);
  if (current()) semantic.models = models;
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

function semanticRefused(err: unknown): string {
  const refusal = (err as Error).message;
  semantic.error = refusal;
  return refusal;
}

/// Enable or disable semantic search. Enabling downloads the selected model
/// first when it is not on disk, polling the state while it lands. Never
/// rejects: it answers the refusal, which is also `semantic.error`, or null
/// once the write landed.
export async function setSemanticEnabled(next: boolean): Promise<string | null> {
  if (!semantic.state) return "Semantic search has not loaded";
  if (semantic.downloading || semantic.enabling) return IN_FLIGHT;
  semantic.error = null;
  const onDisk = selectedSemanticModel()?.downloaded || semantic.state.model_present;
  semanticOrder.begin();
  try {
    if (!next) {
      try {
        semantic.state = await api.semanticDisable();
        return null;
      } catch (err) {
        return semanticRefused(err);
      }
    }
    if (onDisk) {
      semantic.enabling = true;
      try {
        semantic.state = await api.semanticEnable();
        return null;
      } catch (err) {
        return semanticRefused(err);
      } finally {
        semantic.enabling = false;
      }
    }
    semantic.downloading = true;
    stopSemanticPoll();
    semanticPollTimer = setInterval(() => {
      void refreshSemantic();
    }, SEMANTIC_POLL_INTERVAL_MS);
    try {
      semantic.state = await api.semanticDownload();
      // A poll still on its way saw the model before it landed.
      stopSemanticPoll();
      semanticOrder.answered();
      await refreshSemantic();
      semantic.enabling = true;
      try {
        semantic.state = await api.semanticEnable();
      } finally {
        semantic.enabling = false;
      }
      return null;
    } catch (err) {
      stopSemanticPoll();
      const refusal = semanticRefused(err);
      await refreshSemantic();
      return refusal;
    } finally {
      semantic.downloading = false;
    }
  } finally {
    semanticOrder.end();
  }
}

/// Pick the workspace's embedding model. Never rejects: it answers the
/// refusal, which is also `semantic.error`, or null once the model is the
/// workspace's.
export async function setSemanticModel(model: string): Promise<string | null> {
  if (!model || model === semantic.models?.current_model) return null;
  if (semantic.modelBusy || semantic.downloading || semantic.enabling) return IN_FLIGHT;
  semantic.modelBusy = true;
  semantic.error = null;
  semanticOrder.begin();
  try {
    semantic.state = await api.semanticModelPatch(model);
    semanticOrder.answered();
    await refreshSemantic();
    return null;
  } catch (err) {
    const refusal = semanticRefused(err);
    await loadSemanticModels();
    return refusal;
  } finally {
    semantic.modelBusy = false;
    semanticOrder.end();
  }
}

// ---- screen lock -----------------------------------------------------------

/// Write a screen lock setting and load the state the write answers with
/// into the running lock, whose state is what the control and the index both
/// show. A write that landed is shown, and one that did not rejects.
export async function patchScreenLock(body: {
  enabled?: boolean;
  timeout_secs?: number;
  theme?: ScreensaverTheme;
}): Promise<void> {
  applyScreensaverState(await api.screensaverPatch(body));
}

// ---- the index's reads -----------------------------------------------------

let loadedAt: number | null = null;
let loading = false;

function writeUnderWay(): boolean {
  return reportsOrder.writing() || semanticOrder.writing();
}

/// Ask for the reports and semantic state when it has never been read or
/// has aged out. Safe to call from a derived read: the request starts in a
/// later turn and nothing is written before it answers. A write under way
/// holds it off, since its answer is the newer state.
export function refreshWorkspaceStateIfStale(): void {
  if (workspace.info === null || loading || writeUnderWay()) return;
  if (loadedAt !== null && Date.now() - loadedAt < WORKSPACE_STATE_MAX_AGE_MS) return;
  loading = true;
  queueMicrotask(() => {
    // A write that began in the turn that asked, as a press that reads the
    // value and writes its opposite does, holds this off too. A later read
    // asks again.
    if (writeUnderWay()) {
      loading = false;
      return;
    }
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
  reportsOrder.reset();
  semanticOrder.reset();
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
