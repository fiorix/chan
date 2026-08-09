// Background indexer driven by the existing watcher bridge.
//
// Two responsibilities:
//
//   1. On server start, kick off a full `Workspace::reindex` if the
//      workspace's index is empty (cold workspace / fresh schema bump).
//      Runs on the tokio blocking pool so the rest of `chan open`
//      keeps responding.
//   2. Subscribe to the watcher's `WatchEvent` broadcast and
//      debounce per-path file changes into incremental
//      `Workspace::index_file` / `Workspace::forget_file` calls.
//
// Status is exposed through a `Mutex<IndexStatus>` snapshot the
// `/api/index/status` endpoint reads. We deliberately don't push
// status over the WS in v1: polling the status endpoint every few
// seconds while the user is on the Settings panel is simpler and
// the payload is tiny.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chan_workspace::{
    ProgressCallback, ProgressEvent, ProgressStage, RecoveryAction, RecoveryOutcome,
    SearchAggression, VcsKind, WatchEvent, WatchKind, Workspace, WorkspaceGeneration,
};
use serde::Serialize;
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;

const VCS_BURST_REBUILD_THRESHOLD: usize = 64;

/// Background embedding progress carried on `IndexStatus::Idle`. File-
/// based and monotonic: `done` is the number of files drained so far,
/// `total` the workspace file count. `done <= total` always (the
/// producer's per-batch chunk counters overshoot, so we report file
/// progress instead). Serialized camelCase to match the SPA.
///
/// `file` is the workspace-relative path the embed pass is currently
/// draining. It carries the same live label the foreground build stamps on
/// `Building.file`, so the indexing-state endpoint can pulse the one directory
/// being embedded instead of the whole spine. `None` between batch flushes.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmbedProgress {
    pub done: u32,
    pub total: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
}

/// Background-embed progress, owned independently of `IndexStatus`. The cold
/// build's embed pass writes it;
/// `set_idle` reads it when stamping `Idle`; the coordinator clears it when
/// the build resolves. Decoupling it from the status enum is what stops a
/// watcher reindex (status -> Reindexing -> Idle) from clobbering the embed
/// chip mid-pass: `set_idle` re-attaches the still-running progress instead
/// of forcing `embedding: None`.
type BgEmbed = Arc<Mutex<Option<EmbedProgress>>>;

/// Snapshot of indexer state. Returned verbatim by
/// `/api/index/status` (the frontend's IndexStatus tagged union).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum IndexStatus {
    /// Initial scan in progress. `current` is 1-based, `total`
    /// counts the markdown files we found at scan start.
    Building {
        current: usize,
        total: usize,
        file: String,
    },
    /// One incremental re-index after a watcher event.
    Reindexing { file: String },
    /// Steady state. Counters mirror `Workspace::index_stats`.
    ///
    /// `embedding` is `Some` while the search index is BM25-ready (so
    /// preflight unlocks and search answers) but the background embedding
    /// pass is still running; `None` once fully settled. This is the
    /// Option-A split: a heavy cold reindex reaches Idle as soon as BM25
    /// is searchable, and the slow embed forward-pass finishes in the
    /// background (search upgrades bm25 -> hybrid as vectors land) instead
    /// of pinning the status at `Building` for minutes.
    Idle {
        indexed_docs: u64,
        indexed_vectors: u64,
        model: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        embedding: Option<EmbedProgress>,
    },
    /// The last operation failed; users are still allowed to query
    /// (over the previous index state).
    Error { message: String },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IndexerHealthStatus {
    Idle,
    Settling,
    Rebuilding,
    Error,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct IndexerHealth {
    pub status: IndexerHealthStatus,
    pub queue_depth: usize,
    pub last_event_at: Option<i64>,
    pub last_settled_at: Option<i64>,
    pub coalesced_rebuild: bool,
}

#[derive(Debug)]
struct IndexerTelemetry {
    queue_depth: usize,
    last_event_at: Option<i64>,
    last_settled_at: Option<i64>,
    coalesced_rebuild: bool,
}

#[derive(Clone)]
struct IndexerShared {
    status: Arc<Mutex<IndexStatus>>,
    telemetry: Arc<Mutex<IndexerTelemetry>>,
    bg_embed: BgEmbed,
    cancel: Arc<AtomicBool>,
    search_aggression: SearchAggression,
}

/// Handle to the background indexer. Drop it (or call `shutdown`)
/// to stop both the watcher loop and the in-flight initial build.
pub struct Indexer {
    status: Arc<Mutex<IndexStatus>>,
    telemetry: Arc<Mutex<IndexerTelemetry>>,
    rebuild_requester: RebuildRequester,
    /// Set to true on shutdown so the in-flight `Workspace::reindex`
    /// blocking task bails at its next per-file check. Without this
    /// the runtime drop after `serve()` returns would have to wait
    /// for the rebuild to finish naturally; on a large workspace that's
    /// minutes. Cancelled rebuilds leave the index in a clean
    /// "empty" state (no commit, graph cleared but not refilled),
    /// so the on-boot `indexed_docs == 0` trigger re-fires next run.
    cancel: Arc<AtomicBool>,
    /// Held to keep the spawned tasks alive for as long as the
    /// indexer is. Aborted on drop.
    _watcher_task: JoinHandle<()>,
    _coordinator_task: JoinHandle<()>,
}

impl std::fmt::Debug for Indexer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Indexer").finish()
    }
}

impl Drop for Indexer {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
        self._watcher_task.abort();
        self._coordinator_task.abort();
    }
}

impl Indexer {
    /// Spawn the indexer over `workspace`, tied to `watch_events`. If
    /// `initial_build` is true and the workspace's index reports zero
    /// chunks, kicks off a full rebuild on boot. `progress_sink` is
    /// the WS fan-out (see `bus::make_progress_broadcast`); per-file
    /// progress events forward there in addition to updating the
    /// local `IndexStatus` mutex behind `/api/index/status`.
    pub fn spawn(
        workspace: Arc<Workspace>,
        watch_events: broadcast::Receiver<WatchEvent>,
        initial_build: bool,
        search_aggression: SearchAggression,
        progress_sink: Arc<dyn ProgressCallback>,
    ) -> Self {
        let stats = workspace.index_stats().unwrap_or_else(|e| {
            tracing::warn!("indexer: initial stats failed: {e}");
            chan_workspace::IndexStats {
                ready: false,
                indexed_docs: 0,
                indexed_vectors: 0,
                model: chan_workspace::DEFAULT_MODEL.to_owned(),
            }
        });
        let status = Arc::new(Mutex::new(IndexStatus::Idle {
            indexed_docs: stats.indexed_docs,
            indexed_vectors: stats.indexed_vectors,
            model: stats.model.clone(),
            embedding: None,
        }));
        // Shared embed-progress signal. Lives outside the
        // IndexStatus mutex so the watcher's Reindexing -> Idle transitions
        // never drop the cold-build embed chip.
        let bg_embed: BgEmbed = Arc::new(Mutex::new(None));
        let telemetry = Arc::new(Mutex::new(IndexerTelemetry {
            queue_depth: 0,
            last_event_at: None,
            last_settled_at: Some(now_unix()),
            coalesced_rebuild: false,
        }));
        let watch_context = WatchContext {
            vcs_kind: chan_workspace::detect_workspace_vcs(workspace.root()),
        };

        // Coordinator task: serializes "rebuild now" requests so
        // the watcher loop and the on-boot trigger can't both ask
        // for a full rebuild concurrently. Listening on an
        // unbounded mpsc since the bursts are tiny (one or two
        // requests per session) and dropping a request would just
        // leave the index stale.
        let cancel = Arc::new(AtomicBool::new(false));
        let shared = IndexerShared {
            status: status.clone(),
            telemetry: telemetry.clone(),
            bg_embed: bg_embed.clone(),
            cancel: cancel.clone(),
            search_aggression,
        };
        let (rebuild_tx, rebuild_rx) = mpsc::unbounded_channel::<WorkspaceGeneration>();
        let workspace_weak = Arc::downgrade(&workspace);
        let rebuild_requester = RebuildRequester {
            workspace: workspace_weak.clone(),
        };
        let coordinator_task = spawn_coordinator(
            workspace_weak.clone(),
            shared.clone(),
            rebuild_rx,
            progress_sink.clone(),
            REBUILD_COOLDOWN,
        );
        // Install the driver before anything requests work, and before the
        // first poll can observe readiness. Installing also announces whatever
        // is already pending, which covers the passes parked between
        // `Workspace::open` and here.
        workspace.set_recovery_driver(Arc::new(CoordinatorDriver { tx: rebuild_tx }));
        // Trigger a full rebuild when either side of the index is
        // empty. Checking BM25 alone misses the case where a prior
        // rebuild was killed mid-graph-pass: the graph DB stays
        // empty (cancellation leaves it cleared, see Workspace::reindex
        // doc) while BM25 still carries data from a much earlier
        // run, so without the graph check the server would never
        // notice and `/api/graph` would keep returning 0 nodes.
        let graph_empty = workspace
            .graph()
            .and_then(|g| g.files().map(|fs| fs.is_empty()))
            .unwrap_or_else(|e| {
                tracing::warn!("indexer: initial graph check failed: {e}");
                false
            });
        if initial_build && (stats.indexed_docs == 0 || graph_empty) {
            rebuild_requester.request();
        }
        // Drafts are real in-root files under the configured drafts dir
        // now, so the normal `Workspace::reindex` walk and the watcher
        // pick them up like any other path. No dedicated drafts boot
        // walk is needed.

        let watcher_task = spawn_watcher_loop(
            workspace_weak,
            shared,
            watch_events,
            rebuild_requester.clone(),
            watch_context,
        );

        Self {
            status,
            telemetry,
            rebuild_requester,
            cancel,
            _watcher_task: watcher_task,
            _coordinator_task: coordinator_task,
        }
    }

    /// Signal an in-flight rebuild to bail. Idempotent. Safe to call
    /// from any task; takes effect on the rebuild's next per-file
    /// check.
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    /// Snapshot the current status. Cheap.
    pub fn snapshot(&self) -> IndexStatus {
        self.status.lock().unwrap().clone()
    }

    /// Snapshot the lightweight health view used by `/api/health`.
    pub fn health_snapshot(&self) -> IndexerHealth {
        let status = self.status.lock().unwrap().clone();
        let telemetry = self.telemetry.lock().unwrap();
        health_from(&status, &telemetry)
    }

    /// Ask the indexer to run a full rebuild. Returns immediately;
    /// the actual work runs on the blocking pool. The status flips
    /// to `Building` when the worker picks the request up.
    pub fn request_rebuild(&self) {
        self.rebuild_requester.request();
    }
}

#[derive(Clone)]
struct RebuildRequester {
    workspace: Weak<Workspace>,
}

impl RebuildRequester {
    /// Park a full rebuild. The coordinator hears about it through the
    /// workspace's recovery driver, so this path cannot request work the
    /// coordinator is never told to claim.
    fn request(&self) {
        let Some(workspace) = self.workspace.upgrade() else {
            return;
        };
        workspace.request_recovery(RecoveryAction::FullRebuild);
    }
}

/// The workspace's recovery driver, installed at spawn.
///
/// Every pass the workspace parks arrives here and is forwarded to the
/// coordinator, which is the only claimant a served workspace has. Routing all
/// of them through one channel is what stops a pass from being parked by a path
/// that forgot to poke the coordinator: the poke is no longer the caller's to
/// remember.
///
/// A later `Indexer::spawn` over the same workspace replaces this driver rather
/// than stacking on it; dropping an indexer leaves the stale sender installed,
/// whose sends are simply discarded.
struct CoordinatorDriver {
    tx: mpsc::UnboundedSender<WorkspaceGeneration>,
}

impl chan_workspace::RecoveryDriver for CoordinatorDriver {
    fn wake(&self, generation: WorkspaceGeneration) {
        let _ = self.tx.send(generation);
    }
}

/// Minimum spacing between consecutive full rebuilds. The rebuild
/// triggers (watcher-channel lag, the VCS-burst threshold, provider
/// errors, `.git/HEAD` writes) are level-triggered: under a sustained
/// build storm they keep arriving. Without a cooldown, one trigger
/// per rebuild-duration keeps full-tree rebuilds running back-to-back
/// forever (the buckos livelock). 30 s bounds the damage to two full
/// walks a minute while a storm runs; ordinary one-shot rebuilds
/// (boot, manual reindex) never notice it. The per-file debounced
/// path is unaffected.
const REBUILD_COOLDOWN: Duration = Duration::from_secs(30);

#[cfg(test)]
static COORDINATOR_RETRY_FAILURE: std::sync::OnceLock<Mutex<Option<std::path::PathBuf>>> =
    std::sync::OnceLock::new();

#[cfg(test)]
fn arm_coordinator_retry_failure(root: std::path::PathBuf) {
    *COORDINATOR_RETRY_FAILURE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap() = Some(root);
}

#[cfg(test)]
fn take_coordinator_retry_failure(root: &std::path::Path) -> bool {
    let mut failure = COORDINATOR_RETRY_FAILURE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap();
    if failure.as_deref() == Some(root) {
        failure.take();
        true
    } else {
        false
    }
}

/// Coordinator task: drains recovery requests to the newest required
/// workspace generation and keeps claiming and running passes until that
/// generation is complete. It executes every action the workspace can park
/// (replay, reconcile, full rebuild), because for a served workspace it is the
/// only claimant there is: a pass it declines converges nowhere. Its progress
/// callback updates the local status mutex AND forwards each tick to the WS
/// fan-out so the frontend's status pill animates in real time. Without the WS
/// forward we'd be polling `/api/index/status` at a coarse cadence; with it we
/// get every per-file event.
fn spawn_coordinator(
    workspace: Weak<Workspace>,
    shared: IndexerShared,
    mut rx: mpsc::UnboundedReceiver<WorkspaceGeneration>,
    progress_sink: Arc<dyn ProgressCallback>,
    cooldown: Duration,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut next_start_at = Instant::now();
        while let Some(mut required_generation) = rx.recv().await {
            required_generation = drain_required_generation(&mut rx, required_generation);
            loop {
                if shared.cancel.load(Ordering::Relaxed) {
                    break;
                }
                let Some(workspace_w) = workspace.upgrade() else {
                    return;
                };
                required_generation = drain_required_generation(&mut rx, required_generation);
                let recovery = workspace_w.recovery_status();
                if recovery.completed_generation >= required_generation
                    && recovery.active.is_none()
                    && recovery.pending.is_none()
                {
                    reconcile_idle(&workspace, &shared);
                    break;
                }
                if recovery.active.is_some() {
                    drop(workspace_w);
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    continue;
                }
                let Some(pass) = workspace_w.begin_recovery() else {
                    drop(workspace_w);
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    continue;
                };
                let full_rebuild = pass.action == RecoveryAction::FullRebuild;
                drop(workspace_w);
                // Only full rebuilds ride the storm cooldown. A reconcile or a
                // replay is bounded work over derived state, and holding one
                // back keeps the workspace in `recovering` for no gain.
                if full_rebuild {
                    let delay = next_start_at.saturating_duration_since(Instant::now());
                    if !delay.is_zero() {
                        tokio::time::sleep(delay).await;
                    }
                }

                let Some(workspace_for_pass) = workspace.upgrade() else {
                    return;
                };
                let status_w = shared.status.clone();
                let cancel_w = shared.cancel.clone();
                let progress_w = progress_sink.clone();
                let bg_embed_w = shared.bg_embed.clone();
                let aggression = shared.search_aggression;
                // A reconcile or replay leaves the status alone: neither
                // reports per-file progress, and readiness already says the
                // workspace is recovering.
                if full_rebuild {
                    *status_w.lock().unwrap() = IndexStatus::Building {
                        current: 0,
                        total: 0,
                        file: String::new(),
                    };
                }
                let workspace_weak = Arc::downgrade(&workspace_for_pass);
                let result = tokio::task::spawn_blocking(move || {
                    let progress = StatusUpdater {
                        status: status_w,
                        forward: progress_w,
                        workspace: workspace_weak,
                        embed: Mutex::new(EmbedPhaseState::default()),
                        bg_embed: bg_embed_w,
                    };
                    #[cfg(test)]
                    if take_coordinator_retry_failure(workspace_for_pass.root()) {
                        return Err(chan_workspace::ChanError::Io(
                            "injected coordinator retry".to_string(),
                        ));
                    }
                    // Every action the workspace can park is executed here.
                    // Refusing one strands it: the coordinator is the only
                    // claimant a served workspace has, so a refusal is
                    // terminal for that pass rather than a deferral.
                    match pass.action {
                        RecoveryAction::FullRebuild => workspace_for_pass
                            .run_full_rebuild_pass(pass, Some(&cancel_w), &progress, aggression)
                            .map(|_| ()),
                        RecoveryAction::Reconcile => workspace_for_pass.reconcile().map(|_| ()),
                        RecoveryAction::Replay => {
                            workspace_for_pass.replay_pending_writes().map(|_| ())
                        }
                    }
                })
                .await;

                *shared.bg_embed.lock().unwrap() = None;
                let outcome = if matches!(&result, Ok(Ok(_))) {
                    RecoveryOutcome::Complete
                } else {
                    RecoveryOutcome::Retry
                };
                let Some(workspace_w) = workspace.upgrade() else {
                    return;
                };
                let recovery = match workspace_w.finish_recovery(pass, outcome) {
                    Ok(recovery) => recovery,
                    Err(error) => {
                        *shared.status.lock().unwrap() = IndexStatus::Error {
                            message: error.to_string(),
                        };
                        break;
                    }
                };
                if full_rebuild {
                    next_start_at = Instant::now() + cooldown;
                }
                required_generation = drain_required_generation(&mut rx, required_generation);

                match &result {
                    Ok(Ok(_summary)) => {
                        if recovery.is_ready()
                            && recovery.completed_generation >= required_generation
                        {
                            reconcile_idle(&workspace, &shared);
                        } else {
                            mark_coalesced_rebuild(&shared.telemetry);
                            *shared.status.lock().unwrap() = IndexStatus::Building {
                                current: 0,
                                total: 0,
                                file: String::new(),
                            };
                        }
                    }
                    Ok(Err(chan_workspace::ChanError::Cancelled)) => {
                        tracing::info!("indexer: rebuild cancelled");
                        if recovery.is_ready() {
                            reconcile_idle(&workspace, &shared);
                        }
                    }
                    Ok(Err(error)) => {
                        *shared.status.lock().unwrap() = IndexStatus::Error {
                            message: error.to_string(),
                        };
                    }
                    Err(error) => {
                        *shared.status.lock().unwrap() = IndexStatus::Error {
                            message: format!("rebuild task: {error}"),
                        };
                    }
                }
                if matches!(&result, Ok(Err(chan_workspace::ChanError::Cancelled)))
                    || shared.cancel.load(Ordering::Relaxed)
                {
                    break;
                }
                if !matches!(&result, Ok(Ok(_))) {
                    if recovery.pending.is_some() {
                        continue;
                    }
                    break;
                }
                if recovery.completed_generation >= required_generation
                    && recovery.pending.is_none()
                {
                    break;
                }
            }
        }
    })
}

fn drain_required_generation(
    rx: &mut mpsc::UnboundedReceiver<WorkspaceGeneration>,
    mut required: WorkspaceGeneration,
) -> WorkspaceGeneration {
    while let Ok(generation) = rx.try_recv() {
        required = std::cmp::max(required, generation);
    }
    required
}

/// Listen to the watcher and re-index per file with a 1 s debounce.
/// Multiple events for the same path inside the window collapse
/// into one re-index.
fn spawn_watcher_loop(
    workspace: Weak<Workspace>,
    shared: IndexerShared,
    mut rx: broadcast::Receiver<WatchEvent>,
    rebuild_requester: RebuildRequester,
    watch_context: WatchContext,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let pending: Arc<Mutex<HashMap<String, PendingChange>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let pending_w = pending.clone();
        let workspace_w = workspace.clone();
        let shared_w = shared.clone();

        // Worker: every 200 ms, drain paths whose last event is at
        // least the configured debounce in the past and apply them.
        // If the listener task is aborted, this worker exits on the
        // shared cancel flag and only holds a weak workspace reference.
        let worker = tokio::spawn(async move {
            let debounce = shared_w.search_aggression.debounce();
            loop {
                tokio::time::sleep(Duration::from_millis(200)).await;
                if shared_w.cancel.load(Ordering::Relaxed) {
                    return;
                }
                let due = collect_due(&pending_w, debounce);
                update_queue_depth(&pending_w, &shared_w.telemetry);
                for change in due {
                    *shared_w.status.lock().unwrap() = IndexStatus::Reindexing {
                        file: change.path.clone(),
                    };
                    let Some(workspace2) = workspace_w.upgrade() else {
                        return;
                    };
                    let p = change.path.clone();
                    let deleted = change.deleted;
                    let is_dir = change.is_dir;
                    let result = tokio::task::spawn_blocking(move || {
                        apply_watch_change(&workspace2, &p, deleted, is_dir)
                    })
                    .await;
                    match result {
                        Ok(Ok(ApplyOutcome::Indexed)) => {
                            if let Some(workspace) = workspace_w.upgrade() {
                                set_idle(&workspace, &shared_w)
                            } else {
                                return;
                            }
                        }
                        Ok(Ok(ApplyOutcome::Forgotten)) => {
                            if let Some(workspace) = workspace_w.upgrade() {
                                set_idle(&workspace, &shared_w)
                            } else {
                                return;
                            }
                        }
                        Ok(Ok(ApplyOutcome::SkippedSpecial))
                        | Ok(Ok(ApplyOutcome::SkippedMissing)) => {
                            // Symlinks/FIFOs/sockets/devices and "the
                            // file was gone by the time we looked"
                            // are not index health signals. Drop
                            // back to Idle so the dashboard does
                            // not flash "search is broken" on a
                            // legitimate watcher event.
                            if let Some(workspace) = workspace_w.upgrade() {
                                set_idle(&workspace, &shared_w);
                            } else {
                                return;
                            }
                        }
                        Ok(Err(e)) => {
                            tracing::warn!(
                                path = %change.path,
                                error = %e,
                                "indexer: per-file apply failed"
                            );
                            *shared_w.status.lock().unwrap() = IndexStatus::Error {
                                message: format!("{}: {e}", change.path),
                            };
                        }
                        Err(e) => {
                            *shared_w.status.lock().unwrap() = IndexStatus::Error {
                                message: format!("join error: {e}"),
                            };
                        }
                    }
                }
            }
        });

        // Listener: feed `pending` from the watcher channel.
        loop {
            match rx.recv().await {
                Ok(event) => {
                    record_watcher_event(&shared.telemetry);
                    match classify_watch_event(&event, watch_context) {
                        WatchAction::Changes(changes) => {
                            let mut p = pending.lock().unwrap();
                            for change in changes {
                                let entry = p
                                    .entry(change.path.clone())
                                    .or_insert_with(|| change.clone());
                                // Latest event wins on the deleted flag:
                                // a create-then-delete burst should end
                                // as a delete.
                                entry.deleted = change.deleted;
                                entry.is_dir = change.is_dir;
                                entry.last_seen = change.last_seen;
                            }
                            if should_rebuild_for_vcs_burst(watch_context, p.len()) {
                                p.clear();
                                mark_coalesced_rebuild(&shared.telemetry);
                                tracing::warn!(
                                threshold = VCS_BURST_REBUILD_THRESHOLD,
                                "indexer: VCS-aware watcher burst exceeded threshold; requesting rebuild"
                            );
                                rebuild_requester.request();
                            }
                            drop(p);
                            update_queue_depth(&pending, &shared.telemetry);
                        }
                        WatchAction::Rebuild { reason } => {
                            pending.lock().unwrap().clear();
                            mark_coalesced_rebuild(&shared.telemetry);
                            update_queue_depth(&pending, &shared.telemetry);
                            tracing::warn!(
                                reason,
                                "indexer: watcher event stream lost scope; requesting rebuild"
                            );
                            rebuild_requester.request();
                        }
                        WatchAction::Ignore => {}
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    // Dropped events; we've missed `n` of them. The
                    // safest catch-up is a full rebuild request,
                    // which the coordinator coalesces with anything
                    // already queued.
                    mark_coalesced_rebuild(&shared.telemetry);
                    tracing::warn!(
                        "indexer: watcher channel lagged ({n} events); requesting rebuild"
                    );
                    rebuild_requester.request();
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
        worker.abort();
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingChange {
    path: String,
    deleted: bool,
    is_dir: bool,
    last_seen: Instant,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct WatchContext {
    vcs_kind: Option<VcsKind>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum WatchAction {
    Changes(Vec<PendingChange>),
    Rebuild { reason: &'static str },
    Ignore,
}

/// Result of applying one debounced watcher change. Distinguishes
/// real index updates from "the path was never indexable to begin
/// with" cases so the status reporter can stay calm. A user dropping
/// a symlink into their workspace must not park the indexer in `Error`
/// forever (see syseng-1 hardening pass).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ApplyOutcome {
    /// `Workspace::index_file` succeeded.
    Indexed,
    /// `Workspace::forget_file` succeeded (delete event, or cleanup for
    /// a vanished / replaced-by-symlink path).
    Forgotten,
    /// Path exists but is not a regular file (symlink, FIFO, socket,
    /// device, directory). The chan-workspace walker already drops these
    /// from cold-boot indexing; the watch path mirrors that here.
    /// Any prior index entry for the path is best-effort cleared via
    /// `forget_file` in case a regular file was just replaced by a
    /// symlink.
    SkippedSpecial,
    /// Path no longer exists by the time we looked (typical for a
    /// quick create-then-delete burst). Same semantics as a Removed
    /// event: forget any prior index entry.
    SkippedMissing,
}

/// Per-file watch apply. Performs an explicit `std::fs::symlink_metadata`
/// check on the workspace-relative path and dispatches accordingly.
///
/// Symmetric with `chan_workspace::fs_ops::walk_workspace_with`; the cold-
/// boot walker drops symlinks/specials, and this helper does the
/// same for the watch path. Without this gate a single user-created
/// symlink would surface `Workspace::index_file`'s `SpecialFile` error
/// and stick `IndexStatus::Error` until something else indexed
/// successfully.
fn apply_watch_change(
    workspace: &Workspace,
    path: &str,
    deleted: bool,
    is_dir: bool,
) -> chan_workspace::Result<ApplyOutcome> {
    if deleted {
        if is_dir {
            workspace.forget_subtree(path)?;
        } else {
            workspace.forget_file(path)?;
        }
        return Ok(ApplyOutcome::Forgotten);
    }
    // Drafts are real in-root files under the configured drafts dir now,
    // so a `<drafts_dir>/...` watcher event is just a normal in-root
    // path: the generic resolve + `index_file` below handles it with no
    // special casing.
    let abs = match chan_workspace::fs_ops::resolve_safe(workspace.root(), path) {
        Ok(abs) => abs,
        Err(_) => return Ok(ApplyOutcome::SkippedMissing),
    };
    match std::fs::symlink_metadata(&abs) {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => {
            workspace.index_file(path)?;
            Ok(ApplyOutcome::Indexed)
        }
        Ok(_) => {
            // Path exists but is not indexable. Drop any stale row
            // in case the path used to be a regular markdown file.
            // forget_file is tolerant of "no such row".
            let _ = workspace.forget_file(path);
            Ok(ApplyOutcome::SkippedSpecial)
        }
        Err(_) => {
            // Vanished between the watcher event and our wake-up.
            let _ = workspace.forget_file(path);
            Ok(ApplyOutcome::SkippedMissing)
        }
    }
}

/// Translate a watcher event into indexer work. `Workspace::watch` has
/// already warmed chan-report and runs its report fan-out before the
/// event reaches this scheduler; full rebuilds run graph-first inside
/// `Workspace::reindex_with`, so provider-loss recovery preserves the
/// graph/report-before-search priority boundary.
fn classify_watch_event(event: &WatchEvent, context: WatchContext) -> WatchAction {
    if context.vcs_kind.is_some() && watch_event_touches_vcs_control(event) {
        return WatchAction::Rebuild {
            reason: "vcs-control",
        };
    }
    let now = Instant::now();
    match event.kind {
        WatchKind::ProviderError => WatchAction::Rebuild {
            reason: "provider-error",
        },
        WatchKind::Created | WatchKind::Modified | WatchKind::Removed => {
            let Some(path) = event.path.as_deref() else {
                // macOS FSEvents can emit ordinary path-less
                // create/modify/remove notifications during metadata
                // churn. ProviderError and channel lag are the actual
                // loss-of-scope signals; rebuilding here makes normal
                // Team Work workspace activity look broken.
                return WatchAction::Ignore;
            };
            if event.is_dir && event.kind == WatchKind::Removed {
                return WatchAction::Changes(vec![PendingChange {
                    path: path.to_owned(),
                    deleted: true,
                    is_dir: true,
                    last_seen: now,
                }]);
            }
            if event.is_dir || !chan_workspace::fs_ops::is_indexable_text(path) {
                return WatchAction::Ignore;
            }
            WatchAction::Changes(vec![PendingChange {
                path: path.to_owned(),
                deleted: matches!(event.kind, WatchKind::Removed),
                is_dir: false,
                last_seen: now,
            }])
        }
        WatchKind::Renamed => {
            if event.is_dir {
                return WatchAction::Rebuild {
                    reason: "directory-rename",
                };
            }
            let mut changes = Vec::with_capacity(2);
            if let Some(from) = event.path.as_deref() {
                if chan_workspace::fs_ops::is_indexable_text(from) {
                    changes.push(PendingChange {
                        path: from.to_owned(),
                        deleted: true,
                        is_dir: false,
                        last_seen: now,
                    });
                }
            }
            if let Some(to) = event.to.as_deref() {
                if chan_workspace::fs_ops::is_indexable_text(to) {
                    changes.push(PendingChange {
                        path: to.to_owned(),
                        deleted: false,
                        is_dir: false,
                        last_seen: now,
                    });
                }
            }
            if changes.is_empty() {
                WatchAction::Ignore
            } else {
                WatchAction::Changes(changes)
            }
        }
    }
}

fn watch_event_touches_vcs_control(event: &WatchEvent) -> bool {
    event
        .path
        .as_deref()
        .is_some_and(chan_workspace::is_vcs_control_path)
        || event
            .to
            .as_deref()
            .is_some_and(chan_workspace::is_vcs_control_path)
}

fn should_rebuild_for_vcs_burst(context: WatchContext, pending_len: usize) -> bool {
    context.vcs_kind.is_some() && pending_len >= VCS_BURST_REBUILD_THRESHOLD
}

/// Pull paths whose last event is older than `window` and remove
/// them from the pending map.
fn collect_due(
    pending: &Mutex<HashMap<String, PendingChange>>,
    window: Duration,
) -> Vec<PendingChange> {
    let now = Instant::now();
    let mut p = pending.lock().unwrap();
    let due_paths: Vec<String> = p
        .iter()
        .filter(|(_, c)| now.duration_since(c.last_seen) >= window)
        .map(|(k, _)| k.clone())
        .collect();
    let mut out = Vec::with_capacity(due_paths.len());
    for k in due_paths {
        if let Some(v) = p.remove(&k) {
            out.push(v);
        }
    }
    // Deletions first: stale graph/search rows disappear before any
    // upserts from the same burst add new rows.
    out.sort_by_key(|c| !c.deleted);
    out
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn health_from(status: &IndexStatus, telemetry: &IndexerTelemetry) -> IndexerHealth {
    let status = match status {
        IndexStatus::Error { .. } => IndexerHealthStatus::Error,
        IndexStatus::Building { .. } | IndexStatus::Reindexing { .. } => {
            IndexerHealthStatus::Rebuilding
        }
        IndexStatus::Idle { .. } if telemetry.queue_depth > 0 => IndexerHealthStatus::Settling,
        IndexStatus::Idle { .. } if telemetry.coalesced_rebuild => IndexerHealthStatus::Rebuilding,
        IndexStatus::Idle { .. } => IndexerHealthStatus::Idle,
    };
    IndexerHealth {
        status,
        queue_depth: telemetry.queue_depth,
        last_event_at: telemetry.last_event_at,
        last_settled_at: telemetry.last_settled_at,
        coalesced_rebuild: telemetry.coalesced_rebuild,
    }
}

fn record_watcher_event(telemetry: &Mutex<IndexerTelemetry>) {
    telemetry.lock().unwrap().last_event_at = Some(now_unix());
}

fn mark_coalesced_rebuild(telemetry: &Mutex<IndexerTelemetry>) {
    let mut telemetry = telemetry.lock().unwrap();
    telemetry.coalesced_rebuild = true;
    telemetry.queue_depth = 0;
}

fn update_queue_depth(
    pending: &Mutex<HashMap<String, PendingChange>>,
    telemetry: &Mutex<IndexerTelemetry>,
) {
    telemetry.lock().unwrap().queue_depth = pending.lock().unwrap().len();
}

/// `ProgressCallback` wrapper that mirrors progress events into two
/// places: the local `IndexStatus` mutex (so `/api/index/status`
/// reflects the in-flight build for clients that poll instead of
/// subscribing to /ws) AND a forwarded sink (the WS broadcast). The
/// status flips to `Building` on file / graph stages; other stages
/// (model load, contact import, reset) are forwarded to /ws but
/// don't override the indexer status; they live on their own
/// frontend surfaces.
struct StatusUpdater {
    status: Arc<Mutex<IndexStatus>>,
    forward: Arc<dyn ProgressCallback>,
    /// Live workspace handle for reading index stats when we flip to
    /// Idle mid-build (the Option-A background-embed state). Weak so the
    /// updater never keeps the workspace alive past reset/shutdown.
    workspace: Weak<Workspace>,
    /// Latch + last file progress for the background-embed flip. Once the
    /// first EmbedBatch fires in a pass, BM25 is committed and searchable
    /// (facade.rs commits before each embed flush), so we report
    /// Idle{embedding:Some} and stop reverting to Building on the
    /// interleaved IndexFile ticks.
    embed: Mutex<EmbedPhaseState>,
    /// The shared embed signal this pass publishes to. set_idle (driven by
    /// the watcher) reads it so a concurrent reindex re-attaches the chip
    /// instead of dropping it.
    bg_embed: BgEmbed,
}

#[derive(Default)]
struct EmbedPhaseState {
    started: bool,
    files_done: u32,
    files_total: u32,
    /// Last per-file label seen on an IndexFile tick. Carried onto the
    /// embed chip so a batch flush (which has no file of its own) still
    /// reports the directory it just drained.
    file: Option<String>,
}

impl ProgressCallback for StatusUpdater {
    fn on_progress(&self, event: ProgressEvent) {
        match event.stage {
            ProgressStage::GraphRebuild | ProgressStage::IndexFile => {
                // Clamp so the pill never shows current > total. Display-only.
                let total = event.total as usize;
                let current = (event.current as usize).min(total);
                // Keep the file-progress counters + the current label fresh
                // for the background-embed chip, and read the latch.
                let started = {
                    let mut p = self.embed.lock().unwrap();
                    p.files_done = current as u32;
                    p.files_total = total as u32;
                    p.file = event.label.clone();
                    p.started
                };
                // Before the first embed flush this is the foreground
                // BM25/graph pass, which legitimately gates preflight ->
                // Building. After it, BM25 is searchable and embeddings are
                // a background refinement, so we must NOT revert to Building
                // (that would re-lock preflight on every interleaved
                // IndexFile tick).
                if !started {
                    let file = event.label.clone().unwrap_or_default();
                    if let Ok(mut s) = self.status.lock() {
                        *s = IndexStatus::Building {
                            current,
                            total,
                            file,
                        };
                    }
                } else {
                    // CHIP UX: post-embed-start IndexFile ticks fire between
                    // the (slow, infrequent) embed flushes. Publish the chip
                    // progress to the SHARED signal so it ADVANCES per file
                    // during the fast drain windows (the embed flushes on a
                    // big workspace are minutes apart and made the chip look
                    // frozen) AND survives a concurrent watcher reindex. Cap
                    // `done` below `total` so the chip never reads done==total
                    // while the tail embed still runs; the coordinator clears
                    // the signal when the pass returns.
                    let done = current.min(total.saturating_sub(1)) as u32;
                    let progress = EmbedProgress {
                        done,
                        total: total as u32,
                        // The live label of the file this drain tick is
                        // embedding; lets the indexing spine pulse one dir.
                        file: event.label.clone(),
                    };
                    *self.bg_embed.lock().unwrap() = Some(progress.clone());
                    // Mirror onto the live status when it is Idle (the common
                    // case). A transient Reindexing from a concurrent watcher
                    // event resolves back through set_idle, which re-reads the
                    // same signal, so the chip is not lost either way.
                    if let Ok(mut s) = self.status.lock() {
                        if let IndexStatus::Idle { embedding, .. } = &mut *s {
                            *embedding = Some(progress);
                        }
                    }
                }
            }
            // Option A: the embed phase runs AFTER BM25 indexing. The first
            // EmbedBatch means BM25 has been committed and is searchable
            // (facade.rs commits before each embed flush), so flip the
            // status to Idle now. preflight maps Idle -> ready, so the
            // overlay unlocks and the slow embed forward-pass finishes in
            // the background instead of pinning Building for minutes (the
            // original heavy-drive wedge). `embedding: Some` carries
            // file-based progress for a passive status chip; reconcile_idle
            // clears it to None when the pass returns.
            ProgressStage::EmbedBatch => {
                let (done, total, file) = {
                    let mut p = self.embed.lock().unwrap();
                    p.started = true;
                    (p.files_done, p.files_total, p.file.clone())
                };
                let embedding = Some(EmbedProgress { done, total, file });
                // Publish to the shared signal too, so a concurrent watcher
                // reindex that lands in set_idle re-attaches this same chip.
                *self.bg_embed.lock().unwrap() = embedding.clone();
                // Read live stats so the chip shows the growing index. If
                // the workspace is gone (reset/shutdown) fall back to a
                // zeroed Idle rather than dropping the embedding signal.
                let idle = match self.workspace.upgrade() {
                    Some(ws) => match ws.index_stats() {
                        Ok(st) => IndexStatus::Idle {
                            indexed_docs: st.indexed_docs,
                            indexed_vectors: st.indexed_vectors,
                            model: st.model,
                            embedding,
                        },
                        Err(_) => IndexStatus::Idle {
                            indexed_docs: 0,
                            indexed_vectors: 0,
                            model: chan_workspace::DEFAULT_MODEL.to_owned(),
                            embedding,
                        },
                    },
                    None => IndexStatus::Idle {
                        indexed_docs: 0,
                        indexed_vectors: 0,
                        model: chan_workspace::DEFAULT_MODEL.to_owned(),
                        embedding,
                    },
                };
                if let Ok(mut s) = self.status.lock() {
                    *s = idle;
                }
            }
            // Model load, contact import, reset, rename rewrite,
            // heartbeat: WS subscribers see the event; the local index
            // status mutex stays where it is. Imports have their own
            // status field on the frontend (driven by the import
            // wizard).
            _ => {}
        }
        self.forward.on_progress(event);
    }
}

/// Bug 9 clear-path helper for the coordinator: move the status out of
/// `Building` when a rebuild resolves, whether or not the workspace `Weak`
/// still upgrades. With a live workspace this reads fresh stats via
/// `set_idle`. If the workspace was dropped (reset/shutdown swapped the
/// cell), there is nothing to query, but we still must not leave the
/// pill frozen on `Building` for the brief window before the indexer
/// itself is dropped, so we stamp a zeroed idle. Either way the pill
/// hides (it is visible only on non-idle states).
fn reconcile_idle(workspace: &Weak<Workspace>, shared: &IndexerShared) {
    match workspace.upgrade() {
        Some(workspace) => set_idle(&workspace, shared),
        None => {
            if let Ok(mut s) = shared.status.lock() {
                *s = IndexStatus::Idle {
                    indexed_docs: 0,
                    indexed_vectors: 0,
                    model: chan_workspace::DEFAULT_MODEL.to_owned(),
                    embedding: None,
                };
            }
        }
    }
}

fn set_idle(workspace: &Workspace, shared: &IndexerShared) {
    // Read the shared embed signal rather than forcing None: if a cold-build
    // embed pass is still running, an incremental watcher reindex that lands
    // here must RE-ATTACH the chip, not drop it. The coordinator clears the
    // signal when the build resolves, so a settled index reads None here.
    let embedding = shared.bg_embed.lock().unwrap().clone();
    match workspace.index_stats() {
        Ok(s) => {
            *shared.status.lock().unwrap() = IndexStatus::Idle {
                indexed_docs: s.indexed_docs,
                indexed_vectors: s.indexed_vectors,
                model: s.model,
                embedding,
            };
            let mut telemetry = shared.telemetry.lock().unwrap();
            telemetry.last_settled_at = Some(now_unix());
            telemetry.coalesced_rebuild = false;
        }
        Err(e) => {
            *shared.status.lock().unwrap() = IndexStatus::Error {
                message: format!("stats: {e}"),
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chan_workspace::{Library, RecoveryAction, SearchMode, SearchOpts};
    use std::fs;
    use std::sync::atomic::AtomicUsize;
    use tempfile::TempDir;

    /// Bound for waits on the coordinator's rebuild pipeline (pass start
    /// signals and rebuild completions). These waits only detect a lost or
    /// stuck generation, so the value must absorb rebuild work on a
    /// contended host -- spawn_blocking scheduling, disk, the index build
    /// itself -- instead of racing it: a tight bound reads scheduler load as
    /// a lost generation. 30 s matches the rebuild smoke budget in
    /// chan-workspace's index facade.
    const CONVERGENCE_BUDGET: Duration = Duration::from_secs(30);

    fn setup_workspace() -> (TempDir, TempDir, Arc<Workspace>) {
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();
        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        (cfg, workspace_dir, workspace)
    }

    fn idle_status() -> Arc<Mutex<IndexStatus>> {
        Arc::new(Mutex::new(IndexStatus::Idle {
            indexed_docs: 0,
            indexed_vectors: 0,
            model: "bm25".to_string(),
            embedding: None,
        }))
    }

    fn test_shared(status: Arc<Mutex<IndexStatus>>) -> IndexerShared {
        IndexerShared {
            status,
            telemetry: Arc::new(Mutex::new(IndexerTelemetry {
                queue_depth: 0,
                last_event_at: None,
                last_settled_at: None,
                coalesced_rebuild: false,
            })),
            bg_embed: Arc::new(Mutex::new(None)),
            cancel: Arc::new(AtomicBool::new(false)),
            search_aggression: SearchAggression::Conservative,
        }
    }

    /// The watcher fan-out needs a downstream callback; nothing in these tests
    /// reads the events themselves, only the policy refresh they trigger.
    struct DiscardEvents;

    impl chan_workspace::WatchCallback for DiscardEvents {
        fn on_event(&self, _event: WatchEvent) {}
    }

    async fn await_ready(workspace: &Arc<Workspace>, required: WorkspaceGeneration) -> bool {
        tokio::time::timeout(CONVERGENCE_BUDGET, async {
            loop {
                let recovery = workspace.recovery_status();
                if recovery.is_ready() && recovery.completed_generation >= required {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .is_ok()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_gitignore_write_converges_without_an_external_rebuild() {
        // The reported defect, end to end: writing `.gitignore` in a served
        // workspace parks a Reconcile from the watcher fan-out. Before the
        // driver existed nothing was told to claim it, and the workspace sat
        // in `recovering` until someone called POST /api/index/rebuild by
        // hand. Nothing in this test calls a rebuild.
        let (_cfg, dir, workspace) = setup_workspace();
        fs::write(dir.path().join("a.md"), "# A\nbody\n").unwrap();

        let (_events_tx, events_rx) = broadcast::channel(64);
        let _indexer = Indexer::spawn(
            workspace.clone(),
            events_rx,
            false,
            SearchAggression::Conservative,
            Arc::new(chan_workspace::NoProgress),
        );
        let _watch = workspace.watch(Arc::new(DiscardEvents)).unwrap();
        assert!(
            workspace.recovery_status().is_ready(),
            "the workspace must start settled or the convergence below proves nothing: {:?}",
            workspace.recovery_status()
        );

        let before = workspace.generation();
        fs::write(dir.path().join(".gitignore"), "target/\n").unwrap();

        // First that the write actually reached the policy path: without this
        // the convergence assert would pass on a workspace that never left
        // `ready` because the watcher missed the file entirely.
        let bumped = tokio::time::timeout(CONVERGENCE_BUDGET, async {
            loop {
                if workspace.generation() > before {
                    break workspace.generation();
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the .gitignore write never reached the scope-policy path");

        assert!(
            await_ready(&workspace, bumped).await,
            "the parked pass never converged; recovery={:?}",
            workspace.recovery_status()
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_coordinator_runs_a_reconcile_instead_of_erroring_on_it() {
        // The coordinator used to refuse any non-rebuild pass outright: it
        // requeued the pass and flipped the indexer to Error, which is
        // terminal for that generation. It is the only claimant a served
        // workspace has, so refusing is stranding.
        let (_cfg, dir, workspace) = setup_workspace();
        fs::write(dir.path().join("a.md"), "# A\nbody\n").unwrap();
        let status = idle_status();
        let (tx, rx) = mpsc::unbounded_channel::<WorkspaceGeneration>();
        let coordinator = spawn_coordinator(
            Arc::downgrade(&workspace),
            test_shared(status.clone()),
            rx,
            Arc::new(chan_workspace::NoProgress),
            Duration::from_millis(50),
        );

        let required = workspace.request_policy_recovery(RecoveryAction::Reconcile);
        tx.send(required).unwrap();

        assert!(
            await_ready(&workspace, required).await,
            "a Reconcile pass did not converge; recovery={:?}, status={:?}",
            workspace.recovery_status(),
            status.lock().unwrap()
        );
        assert!(
            !matches!(*status.lock().unwrap(), IndexStatus::Error { .. }),
            "claiming a Reconcile must not fault the indexer: {:?}",
            status.lock().unwrap()
        );

        drop(tx);
        coordinator.await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_coordinator_runs_a_replay_instead_of_erroring_on_it() {
        // Same branch, the other action that reaches it. A Replay parked by a
        // crash-recovery path is claimed and executed rather than refused.
        let (_cfg, _dir, workspace) = setup_workspace();
        let status = idle_status();
        let (tx, rx) = mpsc::unbounded_channel::<WorkspaceGeneration>();
        let coordinator = spawn_coordinator(
            Arc::downgrade(&workspace),
            test_shared(status.clone()),
            rx,
            Arc::new(chan_workspace::NoProgress),
            Duration::from_millis(50),
        );

        let required = workspace.request_recovery(RecoveryAction::Replay);
        tx.send(required).unwrap();

        assert!(
            await_ready(&workspace, required).await,
            "a Replay pass did not converge; recovery={:?}, status={:?}",
            workspace.recovery_status(),
            status.lock().unwrap()
        );
        assert!(
            !matches!(*status.lock().unwrap(), IndexStatus::Error { .. }),
            "claiming a Replay must not fault the indexer: {:?}",
            status.lock().unwrap()
        );

        drop(tx);
        coordinator.await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn spawning_the_indexer_claims_a_pass_parked_before_it() {
        // The boot window, and the startup worker's bail path with it: a pass
        // parked before the coordinator exists is announced when the driver
        // goes in, so no wake-up is lost to a driver that was not there yet.
        let (_cfg, dir, workspace) = setup_workspace();
        fs::write(dir.path().join("a.md"), "# A\nbody\n").unwrap();
        let required = workspace.request_policy_recovery(RecoveryAction::Reconcile);
        assert!(
            workspace.recovery_is_unowned(),
            "the pass must be unowned before the indexer exists: {:?}",
            workspace.recovery_status()
        );

        let (_events_tx, events_rx) = broadcast::channel(64);
        let _indexer = Indexer::spawn(
            workspace.clone(),
            events_rx,
            false,
            SearchAggression::Conservative,
            Arc::new(chan_workspace::NoProgress),
        );

        assert!(
            await_ready(&workspace, required).await,
            "the pass parked before spawn was never claimed; recovery={:?}",
            workspace.recovery_status()
        );
    }

    fn ev(kind: WatchKind, path: Option<&str>, to: Option<&str>) -> WatchEvent {
        let generation = chan_workspace::WorkspaceGeneration::default();
        match (kind, path, to) {
            (WatchKind::ProviderError, Some(message), _) => {
                WatchEvent::provider_error(message, generation)
            }
            (WatchKind::ProviderError, None, _) => WatchEvent::loss(generation),
            (WatchKind::Renamed, from, to) => WatchEvent::rename(
                from.map(str::to_owned),
                to.map(str::to_owned),
                false,
                None,
                generation,
            ),
            (kind, Some(path), _) => WatchEvent::file(kind, path, generation),
            (kind, None, _) => {
                let mut event = WatchEvent::file(kind, "", generation);
                event.path = None;
                event
            }
        }
    }

    fn classify(event: &WatchEvent) -> WatchAction {
        classify_watch_event(event, WatchContext::default())
    }

    fn classify_vcs(event: &WatchEvent) -> WatchAction {
        classify_watch_event(
            event,
            WatchContext {
                vcs_kind: Some(VcsKind::Git),
            },
        )
    }

    #[test]
    fn classify_watch_event_uses_chan_workspace_indexable_gate() {
        match classify(&ev(WatchKind::Modified, Some("notes/a.txt"), None)) {
            WatchAction::Changes(changes) => {
                assert_eq!(changes.len(), 1);
                assert_eq!(changes[0].path, "notes/a.txt");
                assert!(!changes[0].deleted);
            }
            other => panic!("expected .txt change, got {other:?}"),
        }

        assert!(matches!(
            classify(&ev(WatchKind::Modified, Some("src/lib.rs"), None)),
            WatchAction::Ignore
        ));
    }

    #[test]
    fn classify_watch_event_requests_rebuild_on_provider_loss() {
        assert!(matches!(
            classify(&ev(WatchKind::ProviderError, Some("overflow"), None)),
            WatchAction::Rebuild {
                reason: "provider-error"
            }
        ));
    }

    #[test]
    fn classify_watch_event_ignores_pathless_non_provider_noise() {
        assert!(matches!(
            classify(&ev(WatchKind::Modified, None, None)),
            WatchAction::Ignore
        ));
        assert!(matches!(
            classify(&ev(WatchKind::Renamed, None, None)),
            WatchAction::Ignore
        ));
    }

    #[test]
    fn classify_watch_event_splits_indexable_rename() {
        match classify(&ev(WatchKind::Renamed, Some("old.md"), Some("new.txt"))) {
            WatchAction::Changes(changes) => {
                assert_eq!(changes.len(), 2);
                assert_eq!(changes[0].path, "old.md");
                assert!(changes[0].deleted);
                assert_eq!(changes[1].path, "new.txt");
                assert!(!changes[1].deleted);
            }
            other => panic!("expected rename changes, got {other:?}"),
        }
    }

    #[test]
    fn classify_directory_rename_requires_subtree_recovery() {
        let event = WatchEvent::rename(
            Some("old".to_string()),
            Some("moved".to_string()),
            true,
            Some(9),
            chan_workspace::WorkspaceGeneration::default(),
        );
        assert!(
            !matches!(classify(&event), WatchAction::Ignore),
            "directory rename must not be treated as a non-indexable file"
        );
    }

    #[test]
    fn classify_watch_event_requests_rebuild_on_vcs_control_paths() {
        assert!(matches!(
            classify_vcs(&ev(WatchKind::Modified, Some(".git/HEAD"), None)),
            WatchAction::Rebuild {
                reason: "vcs-control"
            }
        ));
        assert!(matches!(
            classify_vcs(&ev(WatchKind::Renamed, Some("tmp"), Some(".hg/dirstate"))),
            WatchAction::Rebuild {
                reason: "vcs-control"
            }
        ));
        assert!(matches!(
            classify(&ev(WatchKind::Modified, Some(".git/HEAD"), None)),
            WatchAction::Ignore
        ));
    }

    #[test]
    fn vcs_burst_threshold_only_applies_to_vcs_aware_workspaces() {
        assert!(!should_rebuild_for_vcs_burst(
            WatchContext::default(),
            VCS_BURST_REBUILD_THRESHOLD
        ));
        assert!(!should_rebuild_for_vcs_burst(
            WatchContext {
                vcs_kind: Some(VcsKind::Git),
            },
            VCS_BURST_REBUILD_THRESHOLD - 1,
        ));
        assert!(should_rebuild_for_vcs_burst(
            WatchContext {
                vcs_kind: Some(VcsKind::Git),
            },
            VCS_BURST_REBUILD_THRESHOLD,
        ));
    }

    #[test]
    fn collect_due_applies_deletions_before_upserts() {
        let pending = Mutex::new(HashMap::from([
            (
                "new.md".to_string(),
                PendingChange {
                    path: "new.md".to_string(),
                    deleted: false,
                    is_dir: false,
                    last_seen: Instant::now() - Duration::from_secs(2),
                },
            ),
            (
                "old.md".to_string(),
                PendingChange {
                    path: "old.md".to_string(),
                    deleted: true,
                    is_dir: false,
                    last_seen: Instant::now() - Duration::from_secs(2),
                },
            ),
        ]));

        let due = collect_due(&pending, Duration::from_secs(1));
        assert_eq!(due.len(), 2);
        assert_eq!(due[0].path, "old.md");
        assert!(due[0].deleted);
        assert_eq!(due[1].path, "new.md");
        assert!(!due[1].deleted);
    }

    #[test]
    fn health_snapshot_reports_settling_and_rebuilding_transitions() {
        let idle = IndexStatus::Idle {
            indexed_docs: 3,
            indexed_vectors: 0,
            model: "bm25".to_string(),
            embedding: None,
        };
        let mut telemetry = IndexerTelemetry {
            queue_depth: 0,
            last_event_at: None,
            last_settled_at: Some(10),
            coalesced_rebuild: false,
        };
        assert_eq!(
            health_from(&idle, &telemetry).status,
            IndexerHealthStatus::Idle
        );

        telemetry.queue_depth = 2;
        telemetry.last_event_at = Some(11);
        assert_eq!(
            health_from(&idle, &telemetry),
            IndexerHealth {
                status: IndexerHealthStatus::Settling,
                queue_depth: 2,
                last_event_at: Some(11),
                last_settled_at: Some(10),
                coalesced_rebuild: false,
            }
        );

        telemetry.queue_depth = 0;
        telemetry.coalesced_rebuild = true;
        assert_eq!(
            health_from(&idle, &telemetry).status,
            IndexerHealthStatus::Rebuilding
        );
        assert_eq!(
            health_from(
                &IndexStatus::Reindexing {
                    file: "note.md".to_string()
                },
                &telemetry
            )
            .status,
            IndexerHealthStatus::Rebuilding
        );
    }

    #[test]
    fn apply_watch_change_indexes_regular_file() {
        let (_cfg, dir, workspace) = setup_workspace();
        fs::write(dir.path().join("a.md"), "# A\n\nbody\n").unwrap();
        let outcome = apply_watch_change(&workspace, "a.md", false, false).unwrap();
        assert_eq!(outcome, ApplyOutcome::Indexed);
    }

    #[test]
    fn apply_watch_change_directory_delete_forgets_subtree() {
        let (_cfg, dir, workspace) = setup_workspace();
        for (path, body) in [
            ("old/a.md", "# A\nold-a-token\n"),
            ("old/nested/b.md", "# B\nold-b-token\n"),
            ("keep.md", "# Keep\nkeep-token\n"),
        ] {
            workspace.write_text(path, body).unwrap();
        }
        workspace.reindex(None).unwrap();
        fs::rename(dir.path().join("old"), dir.path().join("moved")).unwrap();

        apply_watch_change(&workspace, "old", true, true).unwrap();

        let graph_paths = workspace.graph().unwrap().files().unwrap();
        let index_paths = workspace.indexed_paths().unwrap();
        assert!(
            graph_paths.iter().all(|path| !path.starts_with("old/")),
            "directory event left stale graph rows: {graph_paths:?}"
        );
        assert!(
            index_paths.iter().all(|path| !path.starts_with("old/")),
            "directory event left stale search rows: {index_paths:?}"
        );

        let opts = SearchOpts {
            mode: SearchMode::Bm25,
            limit: 10,
            scope: None,
        };
        for query in ["old-a-token", "old-b-token"] {
            let hits = workspace.search(query, &opts).unwrap().hits;
            assert!(
                hits.is_empty(),
                "directory event left stale BM25 hits for {query}: {hits:?}"
            );
        }
        let keep_hits = workspace.search("keep-token", &opts).unwrap().hits;
        assert!(
            keep_hits.iter().any(|hit| hit.path == "keep.md"),
            "directory event removed the retained BM25 hit: {keep_hits:?}"
        );
    }

    #[test]
    fn apply_watch_change_workspace_root_delete_forgets_every_indexed_path() {
        let (_cfg, _dir, workspace) = setup_workspace();
        for (path, body) in [
            ("a.md", "# A\nroot-a-token\n"),
            ("nested/b.md", "# B\nroot-b-token\n"),
        ] {
            workspace.write_text(path, body).unwrap();
        }
        workspace.reindex(None).unwrap();

        let outcome = apply_watch_change(&workspace, "", true, true).unwrap();

        assert_eq!(outcome, ApplyOutcome::Forgotten);
        assert!(
            workspace.graph().unwrap().files().unwrap().is_empty(),
            "root deletion left stale graph rows"
        );
        assert!(
            workspace.indexed_paths().unwrap().is_empty(),
            "root deletion left stale search rows"
        );
    }

    struct BlockingRebuildProgress {
        passes: AtomicUsize,
        started: tokio::sync::mpsc::UnboundedSender<usize>,
        release_first: Mutex<std::sync::mpsc::Receiver<()>>,
    }

    impl ProgressCallback for BlockingRebuildProgress {
        fn on_progress(&self, event: ProgressEvent) {
            if event.stage != ProgressStage::GraphRebuild || event.current != 0 {
                return;
            }
            let pass = self.passes.fetch_add(1, Ordering::SeqCst) + 1;
            let _ = self.started.send(pass);
            if pass == 1 {
                let _ = self.release_first.lock().unwrap().recv();
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn retry_with_pending_runs_without_a_new_channel_signal() {
        let (_cfg, dir, workspace) = setup_workspace();
        fs::write(dir.path().join("a.md"), "# A\nbody\n").unwrap();
        arm_coordinator_retry_failure(workspace.root().to_path_buf());

        let shared = IndexerShared {
            status: Arc::new(Mutex::new(IndexStatus::Idle {
                indexed_docs: 0,
                indexed_vectors: 0,
                model: "bm25".to_string(),
                embedding: None,
            })),
            telemetry: Arc::new(Mutex::new(IndexerTelemetry {
                queue_depth: 0,
                last_event_at: None,
                last_settled_at: None,
                coalesced_rebuild: false,
            })),
            bg_embed: Arc::new(Mutex::new(None)),
            cancel: Arc::new(AtomicBool::new(false)),
            search_aggression: SearchAggression::Conservative,
        };
        let status = shared.status.clone();
        let (tx, rx) = mpsc::unbounded_channel::<WorkspaceGeneration>();
        let coordinator = spawn_coordinator(
            Arc::downgrade(&workspace),
            shared,
            rx,
            Arc::new(chan_workspace::NoProgress),
            Duration::from_millis(200),
        );

        let required_generation = workspace.request_recovery(RecoveryAction::FullRebuild);
        tx.send(required_generation).unwrap();
        tokio::time::timeout(CONVERGENCE_BUDGET, async {
            loop {
                if matches!(*status.lock().unwrap(), IndexStatus::Error { .. }) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("first rebuild did not reach the injected retry");
        let recovery = workspace.recovery_status();
        assert!(
            recovery.pending.is_some() || recovery.active.is_some(),
            "failed rebuild should remain queued or already be reclaimed: {recovery:?}"
        );

        let convergence = tokio::time::timeout(CONVERGENCE_BUDGET, async {
            loop {
                let recovery = workspace.recovery_status();
                if recovery.is_ready() && recovery.completed_generation >= required_generation {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        assert!(
            convergence.is_ok(),
            "pending retry did not converge without a new channel signal; recovery={:?}, status={:?}",
            workspace.recovery_status(),
            status.lock().unwrap()
        );

        drop(tx);
        coordinator.await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn trigger_during_active_rebuild_forces_one_follow_up_generation() {
        let cooldown = Duration::from_millis(75);
        let (_cfg, _dir, workspace) = setup_workspace();
        workspace.write_text("a.md", "# A\nbody\n").unwrap();
        let status = Arc::new(Mutex::new(IndexStatus::Idle {
            indexed_docs: 0,
            indexed_vectors: 0,
            model: "bm25".to_string(),
            embedding: None,
        }));
        let telemetry = Arc::new(Mutex::new(IndexerTelemetry {
            queue_depth: 0,
            last_event_at: None,
            last_settled_at: None,
            coalesced_rebuild: false,
        }));
        let shared = IndexerShared {
            status,
            telemetry,
            bg_embed: Arc::new(Mutex::new(None)),
            cancel: Arc::new(AtomicBool::new(false)),
            search_aggression: SearchAggression::Conservative,
        };
        let (started_tx, mut started_rx) = tokio::sync::mpsc::unbounded_channel();
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
        let progress = Arc::new(BlockingRebuildProgress {
            passes: AtomicUsize::new(0),
            started: started_tx,
            release_first: Mutex::new(release_rx),
        });
        let (tx, rx) = mpsc::unbounded_channel::<WorkspaceGeneration>();
        let coordinator = spawn_coordinator(
            Arc::downgrade(&workspace),
            shared,
            rx,
            progress.clone(),
            cooldown,
        );

        let first_generation = workspace.request_recovery(RecoveryAction::FullRebuild);
        tx.send(first_generation).unwrap();
        assert_eq!(
            tokio::time::timeout(CONVERGENCE_BUDGET, started_rx.recv())
                .await
                .unwrap(),
            Some(1)
        );

        let required_generation = workspace.request_recovery(RecoveryAction::FullRebuild);
        assert!(required_generation > first_generation);
        for _ in 0..3 {
            assert_eq!(
                workspace.request_recovery(RecoveryAction::FullRebuild),
                required_generation
            );
            tx.send(required_generation).unwrap();
        }
        release_tx.send(()).unwrap();
        let released_at = Instant::now();

        // Pass 1 must finish real work before the follow-up starts, so the
        // wait rides the convergence budget; a swallowed generation is the
        // only way it elapses.
        assert_eq!(
            tokio::time::timeout(CONVERGENCE_BUDGET, started_rx.recv())
                .await
                .expect("mid-rebuild generation was swallowed"),
            Some(2)
        );
        assert!(
            released_at.elapsed() >= cooldown,
            "follow-up rebuild started before the cooldown floor"
        );
        tokio::time::timeout(CONVERGENCE_BUDGET, async {
            loop {
                let recovery = workspace.recovery_status();
                if recovery.is_ready() && recovery.completed_generation >= required_generation {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("follow-up generation did not complete");
        assert_eq!(progress.passes.load(Ordering::SeqCst), 2);
        drop(tx);
        coordinator.await.unwrap();
    }

    fn progress_event(
        stage: ProgressStage,
        current: u64,
        total: u64,
        label: &str,
    ) -> ProgressEvent {
        ProgressEvent {
            stage,
            current,
            total,
            label: Some(label.to_owned()),
            eta_secs: None,
        }
    }

    #[test]
    fn embed_batch_flips_to_idle_background_embedding() {
        // Option A: BM25 is committed before the embed flush (facade.rs),
        // so the first EmbedBatch flips the status from Building to
        // Idle{embedding:Some}. preflight maps Idle -> ready, so the
        // overlay unlocks while the slow embed pass finishes in the
        // background instead of pinning Building for minutes. File-progress
        // for the chip comes from the preceding IndexFile ticks.
        let status = Arc::new(Mutex::new(IndexStatus::Building {
            current: 0,
            total: 0,
            file: String::new(),
        }));
        let updater = StatusUpdater {
            status: status.clone(),
            forward: Arc::new(chan_workspace::NoProgress),
            // No live workspace: the EmbedBatch arm falls back to a zeroed
            // Idle but still carries the embedding signal.
            workspace: Weak::new(),
            embed: Mutex::new(EmbedPhaseState::default()),
            bg_embed: Arc::new(Mutex::new(None)),
        };
        // A foreground IndexFile tick gates preflight (Building) and seeds
        // the file counters.
        updater.on_progress(progress_event(
            ProgressStage::IndexFile,
            120,
            512,
            "notes/note-120.md",
        ));
        assert!(matches!(
            &*status.lock().unwrap(),
            IndexStatus::Building {
                current: 120,
                total: 512,
                ..
            }
        ));
        // The first EmbedBatch means BM25 is ready: flip to Idle+embedding.
        updater.on_progress(progress_event(
            ProgressStage::EmbedBatch,
            4096,
            8192,
            "files=512 last=notes/note-511.md",
        ));
        match status.lock().unwrap().clone() {
            IndexStatus::Idle {
                embedding: Some(p), ..
            } => {
                assert_eq!(p.done, 120, "file-based embed progress, not chunk count");
                assert_eq!(p.total, 512);
            }
            other => panic!("expected Idle+embedding after EmbedBatch, got {other:?}"),
        }
        // A later interleaved IndexFile tick must NOT revert to Building
        // (preflight must stay unlocked); it only advances the counters.
        updater.on_progress(progress_event(
            ProgressStage::IndexFile,
            300,
            512,
            "notes/note-300.md",
        ));
        assert!(
            matches!(&*status.lock().unwrap(), IndexStatus::Idle { .. }),
            "interleaved IndexFile after embed start must stay Idle"
        );
    }

    #[test]
    fn model_load_progress_does_not_clobber_the_index_status() {
        // ModelLoad is a phase boundary on its own surface; it must not
        // overwrite an in-flight Building status.
        let status = Arc::new(Mutex::new(IndexStatus::Building {
            current: 10,
            total: 100,
            file: "x.md".to_owned(),
        }));
        let updater = StatusUpdater {
            status: status.clone(),
            forward: Arc::new(chan_workspace::NoProgress),
            workspace: Weak::new(),
            embed: Mutex::new(EmbedPhaseState::default()),
            bg_embed: Arc::new(Mutex::new(None)),
        };
        updater.on_progress(progress_event(ProgressStage::ModelLoad, 1, 3, "resolve"));
        assert!(matches!(
            &*status.lock().unwrap(),
            IndexStatus::Building {
                current: 10,
                total: 100,
                ..
            }
        ));
    }

    #[test]
    fn reconcile_idle_clears_pill_when_workspace_is_gone() {
        // Bug 9 clear path: a rebuild that resolves after the workspace
        // cell was swapped out (reset/shutdown) must still leave the
        // status out of `Building`, or the pill is stuck forever.
        let status = Arc::new(Mutex::new(IndexStatus::Building {
            current: 5,
            total: 10,
            file: "y.md".to_owned(),
        }));
        let telemetry = Arc::new(Mutex::new(IndexerTelemetry {
            queue_depth: 0,
            last_event_at: None,
            last_settled_at: None,
            coalesced_rebuild: true,
        }));
        // A Weak that never upgrades: nothing to query, but the status
        // must not stay Building.
        let dead: Weak<Workspace> = Weak::new();
        let shared = IndexerShared {
            status: status.clone(),
            telemetry,
            bg_embed: Arc::new(Mutex::new(None)),
            cancel: Arc::new(AtomicBool::new(false)),
            search_aggression: chan_workspace::SearchAggression::Conservative,
        };
        reconcile_idle(&dead, &shared);
        assert!(matches!(&*status.lock().unwrap(), IndexStatus::Idle { .. }));
    }

    #[test]
    fn reconcile_idle_reads_live_stats_when_workspace_present() {
        let (_cfg, dir, workspace) = setup_workspace();
        fs::write(dir.path().join("a.md"), "# A\n\nbody token\n").unwrap();
        apply_watch_change(&workspace, "a.md", false, false).unwrap();
        let status = Arc::new(Mutex::new(IndexStatus::Building {
            current: 0,
            total: 1,
            file: String::new(),
        }));
        let telemetry = Arc::new(Mutex::new(IndexerTelemetry {
            queue_depth: 3,
            last_event_at: Some(1),
            last_settled_at: None,
            coalesced_rebuild: true,
        }));
        let weak = Arc::downgrade(&workspace);
        let shared = IndexerShared {
            status: status.clone(),
            telemetry: telemetry.clone(),
            bg_embed: Arc::new(Mutex::new(None)),
            cancel: Arc::new(AtomicBool::new(false)),
            search_aggression: chan_workspace::SearchAggression::Conservative,
        };
        reconcile_idle(&weak, &shared);
        let snapshot = status.lock().unwrap().clone();
        match snapshot {
            IndexStatus::Idle { indexed_docs, .. } => assert!(indexed_docs >= 1),
            other => panic!("expected Idle, got {other:?}"),
        }
        // set_idle also resets the coalesced-rebuild flag.
        assert!(!telemetry.lock().unwrap().coalesced_rebuild);
    }

    #[test]
    fn set_idle_reattaches_the_embed_chip_from_the_shared_signal() {
        // An incremental reindex that lands in
        // set_idle WHILE a cold-build embed pass is still running must
        // RE-ATTACH the chip from the shared signal, not drop it (the old
        // bug: set_idle hard-coded embedding: None, so any file edit during
        // a background embed cleared the chip). With the signal cleared (the
        // coordinator clears it when the build settles), set_idle reports
        // embedding: None.
        let (_cfg, dir, workspace) = setup_workspace();
        fs::write(dir.path().join("a.md"), "# A\n\nbody token\n").unwrap();
        apply_watch_change(&workspace, "a.md", false, false).unwrap();
        let status = Arc::new(Mutex::new(IndexStatus::Reindexing {
            file: "a.md".to_owned(),
        }));
        let telemetry = Arc::new(Mutex::new(IndexerTelemetry {
            queue_depth: 0,
            last_event_at: None,
            last_settled_at: None,
            coalesced_rebuild: false,
        }));

        // A cold-build embed is in flight: the shared signal carries progress.
        let bg_embed: BgEmbed = Arc::new(Mutex::new(Some(EmbedProgress {
            done: 3,
            total: 10,
            file: Some("notes/a.md".to_owned()),
        })));
        let shared = IndexerShared {
            status: status.clone(),
            telemetry,
            bg_embed: bg_embed.clone(),
            cancel: Arc::new(AtomicBool::new(false)),
            search_aggression: chan_workspace::SearchAggression::Conservative,
        };
        set_idle(&workspace, &shared);
        match status.lock().unwrap().clone() {
            IndexStatus::Idle { embedding, .. } => {
                assert_eq!(
                    embedding,
                    Some(EmbedProgress {
                        done: 3,
                        total: 10,
                        file: Some("notes/a.md".to_owned()),
                    })
                );
            }
            other => panic!("expected Idle re-attaching the chip, got {other:?}"),
        }

        // Build settled -> the coordinator cleared the signal -> no chip.
        *bg_embed.lock().unwrap() = None;
        set_idle(&workspace, &shared);
        let settled = status.lock().unwrap().clone();
        match settled {
            IndexStatus::Idle { embedding, .. } => assert_eq!(embedding, None),
            other => panic!("expected settled Idle, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn idle_indexer_does_not_keep_workspace_handle_alive() {
        let (_cfg, _dir, workspace) = setup_workspace();
        let (_events_tx, events_rx) = tokio::sync::broadcast::channel(1);
        let indexer = super::Indexer::spawn(
            workspace.clone(),
            events_rx,
            false,
            chan_workspace::SearchAggression::Conservative,
            Arc::new(chan_workspace::NoProgress),
        );
        assert_eq!(Arc::strong_count(&workspace), 1);

        drop(indexer);
        assert_eq!(Arc::strong_count(&workspace), 1);
    }

    #[test]
    fn apply_watch_change_indexes_in_root_draft_path() {
        // Drafts are real in-root files under the configured drafts dir
        // now, so a `<drafts_dir>/...` watcher event is just a normal
        // in-root path: `apply_watch_change` resolves it under the root
        // and indexes it via the generic `index_file` path, with no
        // drafts-specific routing.
        let (_cfg, _dir, workspace) = setup_workspace();
        workspace.create_draft_dir("untitled-1").unwrap();
        fs::write(
            workspace.drafts_dir().join("untitled-1").join("draft.md"),
            "# hello\napply-watch-marker here\n",
        )
        .unwrap();

        let outcome =
            apply_watch_change(&workspace, ".Drafts/untitled-1/draft.md", false, false).unwrap();
        assert_eq!(outcome, ApplyOutcome::Indexed);

        // Verify the side-effect: graph + BM25 now know about the draft
        // file under its real in-root path.
        let graph = workspace.graph().unwrap();
        let files = graph.files().unwrap();
        assert!(
            files.iter().any(|p| p == ".Drafts/untitled-1/draft.md"),
            "graph should know the in-root draft path; got {files:?}"
        );

        let opts = chan_workspace::SearchOpts {
            mode: chan_workspace::SearchMode::Bm25,
            limit: 10,
            scope: None,
        };
        let hits = workspace.search("apply-watch-marker", &opts).unwrap();
        assert!(
            hits.hits
                .iter()
                .any(|h| h.path == ".Drafts/untitled-1/draft.md"),
            "BM25 should return the draft hit; got {:?}",
            hits.hits
        );
    }

    #[test]
    fn create_event_admits_new_indexable_file_into_bm25() {
        let (_cfg, dir, workspace) = setup_workspace();
        fs::write(
            dir.path().join("brand.md"),
            "# Brand\n\nnew doc with keyword brandnewprobe\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("brand.txt"),
            "plain text with keyword brandnewprobetxt\n",
        )
        .unwrap();

        for path in ["brand.md", "brand.txt"] {
            let change = match classify(&ev(WatchKind::Created, Some(path), None)) {
                WatchAction::Changes(mut changes) => {
                    assert_eq!(changes.len(), 1);
                    changes.remove(0)
                }
                other => panic!("expected created change for {path}, got {other:?}"),
            };
            assert_eq!(
                apply_watch_change(&workspace, &change.path, change.deleted, change.is_dir)
                    .unwrap(),
                ApplyOutcome::Indexed
            );
        }

        let stats = workspace.index_stats().unwrap();
        assert_eq!(stats.indexed_docs, 2);

        let opts = SearchOpts {
            mode: SearchMode::Bm25,
            limit: 10,
            scope: None,
        };
        assert!(workspace
            .search("brandnewprobe", &opts)
            .unwrap()
            .hits
            .iter()
            .any(|hit| hit.path == "brand.md"));
        assert!(workspace
            .search("brandnewprobetxt", &opts)
            .unwrap()
            .hits
            .iter()
            .any(|hit| hit.path == "brand.txt"));
    }

    #[test]
    fn rapid_modify_burst_indexes_latest_file_body() {
        let (_cfg, dir, workspace) = setup_workspace();
        let path = dir.path().join("rapid.md");
        fs::write(&path, "# Rapid\n\nrapid-token-00\n").unwrap();
        assert_eq!(
            apply_watch_change(&workspace, "rapid.md", false, false).unwrap(),
            ApplyOutcome::Indexed
        );

        for n in 1..=5 {
            fs::write(&path, format!("# Rapid\n\nrapid-token-{n:02}\n")).unwrap();
        }
        assert_eq!(
            apply_watch_change(&workspace, "rapid.md", false, false).unwrap(),
            ApplyOutcome::Indexed
        );

        let opts = SearchOpts {
            mode: SearchMode::Bm25,
            limit: 10,
            scope: None,
        };
        let latest = workspace.search("rapid-token-05", &opts).unwrap();
        assert!(
            latest.hits.iter().any(|hit| hit.path == "rapid.md"),
            "latest rapid edit should be searchable; got {:?}",
            latest.hits
        );
        let stale = workspace.search("rapid-token-00", &opts).unwrap();
        assert!(
            stale.hits.is_empty(),
            "stale rapid edit token should not survive; got {:?}",
            stale.hits
        );
    }

    #[test]
    fn apply_watch_change_forgets_on_delete_flag() {
        let (_cfg, _dir, workspace) = setup_workspace();
        let outcome = apply_watch_change(&workspace, "gone.md", true, false).unwrap();
        assert_eq!(outcome, ApplyOutcome::Forgotten);
    }

    #[test]
    fn apply_watch_change_skips_missing_path() {
        let (_cfg, _dir, workspace) = setup_workspace();
        let outcome = apply_watch_change(&workspace, "never-existed.md", false, false).unwrap();
        assert_eq!(outcome, ApplyOutcome::SkippedMissing);
    }

    #[cfg(unix)]
    #[test]
    fn apply_watch_change_skips_symlink_to_existing_target() {
        let (_cfg, dir, workspace) = setup_workspace();
        fs::write(dir.path().join("real.md"), "# Real\n").unwrap();
        std::os::unix::fs::symlink("real.md", dir.path().join("alias.md")).unwrap();
        let outcome = apply_watch_change(&workspace, "alias.md", false, false).unwrap();
        assert_eq!(outcome, ApplyOutcome::SkippedSpecial);
    }

    #[cfg(unix)]
    #[test]
    fn apply_watch_change_skips_broken_symlink() {
        let (_cfg, dir, workspace) = setup_workspace();
        std::os::unix::fs::symlink("does-not-exist.md", dir.path().join("broken.md")).unwrap();
        let outcome = apply_watch_change(&workspace, "broken.md", false, false).unwrap();
        assert_eq!(outcome, ApplyOutcome::SkippedSpecial);
    }

    #[cfg(unix)]
    #[test]
    fn apply_watch_change_skips_fifo() {
        // syseng-1 fixture had `attach/named.pipe`; the pre-fix
        // watch path called `index_file` on a FIFO and stuck
        // `IndexStatus::Error`. Probe with `mkfifo`; skip the
        // assertion if the binary is unavailable so test runs on
        // minimal containers stay green.
        let (_cfg, dir, workspace) = setup_workspace();
        let fifo_path = dir.path().join("attach.fifo");
        let status = std::process::Command::new("mkfifo")
            .arg(&fifo_path)
            .status();
        match status {
            Ok(s) if s.success() => {}
            _ => return,
        }
        let outcome = apply_watch_change(&workspace, "attach.fifo", false, false).unwrap();
        assert_eq!(outcome, ApplyOutcome::SkippedSpecial);
    }

    #[cfg(unix)]
    #[test]
    fn apply_watch_change_special_clears_prior_index_entry() {
        // Regression: if a user replaces a regular .md with a symlink
        // of the same name, the apply path should clean out the old
        // index row instead of leaving it stale.
        let (_cfg, dir, workspace) = setup_workspace();
        fs::write(dir.path().join("a.md"), "# A\n").unwrap();
        assert_eq!(
            apply_watch_change(&workspace, "a.md", false, false).unwrap(),
            ApplyOutcome::Indexed
        );
        let before = workspace.index_stats().unwrap().indexed_docs;
        fs::remove_file(dir.path().join("a.md")).unwrap();
        fs::write(dir.path().join("real.md"), "# Real\n").unwrap();
        std::os::unix::fs::symlink("real.md", dir.path().join("a.md")).unwrap();
        assert_eq!(
            apply_watch_change(&workspace, "a.md", false, false).unwrap(),
            ApplyOutcome::SkippedSpecial
        );
        // Best-effort cleanup ran: the prior `a.md` row is gone.
        let after = workspace.index_stats().unwrap().indexed_docs;
        assert!(
            after < before,
            "expected indexed_docs to drop after symlink replacement; before={before} after={after}"
        );
    }

    #[test]
    fn drain_required_generation_keeps_newest_obligation() {
        let generation_1: WorkspaceGeneration = serde_json::from_str("1").unwrap();
        let generation_2: WorkspaceGeneration = serde_json::from_str("2").unwrap();
        let generation_3: WorkspaceGeneration = serde_json::from_str("3").unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        tx.send(generation_2).unwrap();
        tx.send(generation_2).unwrap();
        tx.send(generation_3).unwrap();

        assert_eq!(
            drain_required_generation(&mut rx, generation_1),
            generation_3
        );
    }
}
