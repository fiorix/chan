// Workspace: a registered directory exposed as a sandboxed filesystem
// plus search and graph. All I/O routes through `resolve_safe` and
// the editable-text gate. Per-workspace metadata (index, graph,
// sessions, tokens, trash, report) lives outside the user's notes
// tree under ~/.chan/workspaces/<metadata_key>/.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::dashboard::{self, DashboardConfig, ScreensaverTheme};
use crate::drafts::{self, DraftRef};
use crate::error::{ChanError, Result};
use crate::fs_ops;
use crate::graph::{FileRecord, GraphView};
use crate::index::{
    BuildOptions, BuildSummary, Index, Mode as SearchMode, SearchAggression, SearchResult,
};
use crate::lock::WorkspaceLock;
use crate::markdown;
use crate::paths::{ensure_workspace_metadata_dirs, WorkspacePaths};
use crate::registry::KnownWorkspace;
use crate::report::{ReportFanOut, ReportState};
use crate::trash::{self, TrashEntry, TRASH_RETENTION_SECS};
use crate::watch::{WatchCallback, WatchEvent, WatchHandle, WatchKind};
use crate::{Report, ReportScope};

pub use crate::fs_ops::{AtomicWriteKind, AtomicWriteSink};

/// Hard cap on `write_text` content size. Markdown / txt notes are
/// human-authored; 2 MiB is roughly 2M characters of dense English,
/// far past any realistic note. Anything larger is almost certainly
/// either a bug, a binary file mislabelled with `.md`, or an LLM tool
/// running away. We stop it at the boundary so a misbehaving caller
/// cannot fill the user's workspace without an explicit code change.
pub const TEXT_WRITE_LIMIT: u64 = 2 * 1024 * 1024;

/// Hard cap on `write_bytes` (binary attachments / media). 50 MiB
/// covers typical PDF / image / short audio attachments with margin.
/// Same rationale as `TEXT_WRITE_LIMIT`: defense against runaway
/// callers, not a UX feature; raise via a code change if a real use
/// case appears.
pub const BYTES_WRITE_LIMIT: u64 = 50 * 1024 * 1024;

/// Chunk size for streaming editable text reads. Large enough to amortize
/// syscalls, small enough that the editor can paint early on large files.
pub const TEXT_READ_CHUNK_SIZE: usize = 64 * 1024;

/// Chunk size for bounded opaque-byte reads.
pub const BINARY_STREAM_CHUNK_SIZE: usize = 64 * 1024;

/// Maximum number of unread chunks held by a bounded opaque-byte reader.
pub const BINARY_STREAM_QUEUE_DEPTH: usize = 8;

/// File written to `paths.graph_dir` before `rebuild_graph` starts
/// and removed after `Index::build_all` commits. Its presence at
/// `Workspace::open` time means a previous reindex did not run to
/// completion: the graph may have been rebuilt while the search
/// index never reached `bm25.commit()`, so graph + index can
/// disagree about freshness. The next open seeds a supervised full
/// rebuild while `Workspace::needs_rebuild()` keeps readiness truthful.
const REBUILD_MARKER: &str = "rebuild.inprogress";

/// Persisted form of the in-process rename log, kept under
/// `paths.graph_dir`. Carries every `(old_path -> current_path)`
/// pair the workspace has accumulated since the last `reindex`. The
/// editor batches link rewrites across multiple renames using this
/// table, so losing it on a crash silently breaks the chain: a
/// rename A->B followed by B->C would, on restart, not know that
/// the original A name now points at C. Persisting after every
/// append rebuilds that knowledge on the next open. Cleared
/// together with the in-memory map at the end of `reindex_with`.
const RENAME_LOG_FILE: &str = "rename_log.json";

/// Pending-writes journal: a JSON map of `{rel_path: PendingOp}`
/// kept under `paths.graph_dir`. Every per-file mutation
/// (`index_file`, `forget_file`) adds an entry before touching
/// graph/index and removes it after both backends commit, all
/// serialized via `Workspace.write_serial`. The journal exists because
/// the per-file op is not a single transaction: the graph commit
/// runs first (sqlite), the index commit runs second (tantivy +
/// vectors), and a crash between them leaves graph and index
/// disagreeing about the file. On the next `Workspace::open` any
/// entries still in the journal seed supervised replay;
/// `needs_replay_writes()` remains the compatibility status projection.
const PENDING_WRITES_FILE: &str = "pending_writes.json";

/// What `replay_pending_writes` should do for a journaled entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum PendingOp {
    /// The mutation in flight was an upsert. Replay re-runs the
    /// indexer against the file at its current on-disk state. If
    /// the file is gone (deleted between the crash and the replay)
    /// the replay degrades to a forget, since "rel was being
    /// indexed but no longer exists" is unambiguous.
    Index,
    /// The mutation in flight was a forget. Replay re-runs the
    /// forget, idempotent against an already-cleaned backend.
    Forget,
}

/// User-facing search knobs. The mode defaults to Hybrid (BM25 +
/// dense, RRF-fused) when the binary is built with `embeddings`,
/// otherwise the facade falls back to BM25 with `ready: false`.
#[derive(Debug, Clone, Default)]
pub struct SearchOpts {
    pub mode: SearchMode,
    /// Hard cap on results returned. Defaults to 50 when 0.
    pub limit: u32,
    /// Optional subdir scope (relative to workspace root). When set,
    /// only paths under this prefix are returned. None = whole
    /// workspace. Filtering is post-rank: the index doesn't track
    /// scope, the Workspace does.
    pub scope: Option<String>,
}

pub use fs_ops::TreeEntry;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileStat {
    pub size: u64,
    /// Last modification time as Unix seconds. Coarse, useful for
    /// display and for the graph DB which stores i64 seconds.
    pub mtime: Option<i64>,
    /// Last modification time as Unix nanoseconds. Fits an i64
    /// until year 2262. Used by `write_text_if_unchanged` so two
    /// edits within the same wall-clock second are still detected
    /// as a conflict on filesystems with sub-second mtime (ext4 /
    /// xfs / APFS / btrfs). May be None on filesystems that only
    /// expose seconds (FAT, some network mounts), in which case
    /// the optimistic-concurrency check degrades to seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mtime_ns: Option<i64>,
    pub is_dir: bool,
}

/// Sandboxed classification of a workspace-relative path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum WorkspacePath {
    Missing,
    Regular(FileStat),
    Directory(FileStat),
    Special(fs_ops::PathKind),
}

/// Successful strict write preflight.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WritableFile {
    /// Existing target stat, or `None` when the write will create it.
    pub stat: Option<FileStat>,
}

/// Bounded opaque-byte reader backed by one owned producer thread.
pub struct BoundedFileReader {
    stat: FileStat,
    receiver: Option<std::sync::mpsc::Receiver<Result<Vec<u8>>>>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl BoundedFileReader {
    /// Metadata from the open file handle that supplies the byte stream.
    pub fn stat(&self) -> &FileStat {
        &self.stat
    }
}

impl Iterator for BoundedFileReader {
    type Item = Result<Vec<u8>>;

    fn next(&mut self) -> Option<Self::Item> {
        self.receiver.as_ref()?.recv().ok()
    }
}

impl Drop for BoundedFileReader {
    fn drop(&mut self) {
        self.receiver.take();
        if let Some(worker) = self.worker.take() {
            if worker.join().is_err() {
                tracing::warn!("bounded file reader producer panicked");
            }
        }
    }
}

#[cfg(test)]
static ACTIVE_BOUNDED_FILE_READERS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
struct ActiveBoundedFileReaderGuard;

#[cfg(test)]
impl Drop for ActiveBoundedFileReaderGuard {
    fn drop(&mut self) {
        ACTIVE_BOUNDED_FILE_READERS.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}

#[cfg(test)]
pub(crate) fn active_bounded_file_readers() -> usize {
    ACTIVE_BOUNDED_FILE_READERS.load(std::sync::atomic::Ordering::Acquire)
}

/// Ordered events produced by `Workspace::read_text_with_stat_chunked`.
pub enum TextReadEvent<'a> {
    /// Metadata from the open file handle. This is emitted before
    /// chunks so editor callers can keep the CAS token tied to the
    /// bytes being streamed.
    Meta(&'a FileStat),
    /// A valid UTF-8 chunk from the file.
    Chunk(&'a str),
    /// The file was read to EOF.
    Done,
}

/// A wiki-link resolved to an actual workspace file. `path` is the
/// POSIX rel path of the file that exists today; `anchor` is the
/// `#section` fragment from the original target, passed through
/// unchanged. `kind` is the graph-recorded node kind (file vs
/// contact); callers (the editor) use it to render a kind-aware
/// pill without re-parsing the target's frontmatter. See
/// `Workspace::resolve_link` for the resolution rules.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedLink {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<String>,
    /// Defaults to `File` when the graph hasn't indexed the target
    /// yet (fresh file, indexer behind), or when a future variant
    /// is introduced and an older client deserializes the response.
    /// `#[serde(default)]` keeps wire compatibility with payloads
    /// that omit the field entirely.
    #[serde(default)]
    pub kind: crate::graph::NodeKind,
    /// True when `path` is a directory rather than a file. Directory
    /// links open the file browser at that folder instead of the text
    /// editor. `#[serde(default)]` keeps wire compatibility with older
    /// payloads that omit the field.
    #[serde(default)]
    pub is_dir: bool,
}

/// Result of `Workspace::rename_with_link_rewrite`. Captures both halves
/// of the operation: which files physically moved, and which other
/// files had their content rewritten to keep links valid.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameOutcome {
    /// Every `(old_path, new_path)` pair the rename moved. For a
    /// file-to-file rename this is a single entry; for a directory
    /// rename it is one entry per regular-file descendant. Sorted
    /// lexicographically by old path so callers can diff stably.
    pub renamed: Vec<(String, String)>,
    /// Source files whose markdown contents were rewritten to point
    /// at the new locations. Workspace-rooted POSIX paths (post-rename).
    pub rewritten: Vec<String>,
    /// Source files where the rewrite was aborted because the file
    /// changed between read and write (CAS conflict). The rename
    /// itself still stands; a follow-up reindex + rewrite-retry can
    /// reconcile these later.
    pub conflicts: Vec<String>,
}

/// Result of `Workspace::copy`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CopyOutcome {
    /// Every destination path created by the copy (workspace-rooted POSIX),
    /// sorted lexicographically. One entry for a file copy; one per
    /// copied regular-file descendant for a subtree copy.
    pub created: Vec<String>,
}

/// What `Workspace::reconcile` did.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReconcileReport {
    /// Files whose graph + index were refreshed because they were
    /// new on disk or had a different mtime than the graph row.
    /// Sorted by path.
    pub upserted: Vec<String>,
    /// Files dropped from graph + index because they no longer
    /// exist on disk. Sorted by path.
    pub forgotten: Vec<String>,
    /// Files that matched the graph and were skipped. Cardinality
    /// only; the path list would dwarf the diff on large workspaces.
    pub unchanged: usize,
}

/// Monotonic tag for recovery and policy-convergence work.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct WorkspaceGeneration(u64);

impl WorkspaceGeneration {
    pub const INITIAL: Self = Self(0);

    pub fn get(self) -> u64 {
        self.0
    }

    fn next(self) -> Self {
        Self(self.0.saturating_add(1))
    }
}

/// Recovery work ordered by dominance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryAction {
    Replay,
    Reconcile,
    FullRebuild,
}

/// One immutable unit of recovery work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryPass {
    pub generation: WorkspaceGeneration,
    pub action: RecoveryAction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryOutcome {
    Complete,
    Retry,
}

/// Point-in-time state of the workspace recovery coordinator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryStatus {
    pub generation: WorkspaceGeneration,
    pub completed_generation: WorkspaceGeneration,
    pub active: Option<RecoveryPass>,
    pub pending: Option<RecoveryPass>,
}

impl RecoveryStatus {
    pub fn is_ready(self) -> bool {
        self.active.is_none()
            && self.pending.is_none()
            && self.completed_generation >= self.generation
    }

    pub fn required_action(self) -> Option<RecoveryAction> {
        self.pending.or(self.active).map(|pass| pass.action)
    }

    fn ready() -> Self {
        Self {
            generation: WorkspaceGeneration::INITIAL,
            completed_generation: WorkspaceGeneration::INITIAL,
            active: None,
            pending: None,
        }
    }

    fn seeded(action: RecoveryAction) -> Self {
        let generation = WorkspaceGeneration::INITIAL.next();
        Self {
            generation,
            completed_generation: WorkspaceGeneration::INITIAL,
            active: None,
            pending: Some(RecoveryPass { generation, action }),
        }
    }
}

/// Consumer-facing readiness projection for server, desktop, and CLI.
///
/// This is copied from one recovery-coordinator snapshot and carries no
/// synchronization primitive or worker handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum WorkspaceReadiness {
    Ready {
        generation: WorkspaceGeneration,
    },
    Recovering {
        generation: WorkspaceGeneration,
        completed_generation: WorkspaceGeneration,
        required_action: Option<RecoveryAction>,
        active_generation: Option<WorkspaceGeneration>,
        pending_generation: Option<WorkspaceGeneration>,
    },
}

impl WorkspaceReadiness {
    pub fn is_ready(self) -> bool {
        matches!(self, Self::Ready { .. })
    }
}

impl Default for WorkspaceReadiness {
    fn default() -> Self {
        Self::Ready {
            generation: WorkspaceGeneration::INITIAL,
        }
    }
}

impl From<RecoveryStatus> for WorkspaceReadiness {
    fn from(status: RecoveryStatus) -> Self {
        if status.is_ready() {
            Self::Ready {
                generation: status.generation,
            }
        } else {
            Self::Recovering {
                generation: status.generation,
                completed_generation: status.completed_generation,
                required_action: status.required_action(),
                active_generation: status.active.map(|pass| pass.generation),
                pending_generation: status.pending.map(|pass| pass.generation),
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PersistedStateReadiness {
    Cold,
    Populated,
    Inconsistent,
}

/// Metadata-only startup work derived before `Workspace::open` returns.
///
/// The plan contains no filesystem walk result. It is built from durable
/// recovery markers, the pending-write journal, graph state readiness, the
/// generated scope, and whether a persisted report needs loading.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RecoveryPlan {
    generation: WorkspaceGeneration,
    replay_pending_writes: bool,
    action: Option<RecoveryAction>,
    refresh_report: bool,
}

impl RecoveryPlan {
    fn derive(
        needs_rebuild: bool,
        replay_pending_writes: bool,
        readiness: PersistedStateReadiness,
        refresh_report: bool,
    ) -> (RecoveryStatus, Self) {
        let action = if needs_rebuild || readiness == PersistedStateReadiness::Inconsistent {
            Some(RecoveryAction::FullRebuild)
        } else if replay_pending_writes {
            Some(RecoveryAction::Replay)
        } else if readiness == PersistedStateReadiness::Populated || refresh_report {
            Some(RecoveryAction::Reconcile)
        } else {
            None
        };
        let recovery = action
            .map(RecoveryStatus::seeded)
            .unwrap_or_else(RecoveryStatus::ready);
        (
            recovery,
            Self {
                generation: recovery.generation,
                replay_pending_writes,
                action,
                refresh_report,
            },
        )
    }

    fn has_work(self) -> bool {
        self.replay_pending_writes || self.action.is_some() || self.refresh_report
    }
}

struct RecoveryWorker {
    stop: Arc<AtomicBool>,
    worker: std::sync::Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl RecoveryWorker {
    fn new() -> Self {
        Self {
            stop: Arc::new(AtomicBool::new(false)),
            worker: std::sync::Mutex::new(None),
        }
    }

    fn start(&self, workspace: std::sync::Weak<Workspace>, plan: RecoveryPlan) -> Result<()> {
        if !plan.has_work() {
            return Ok(());
        }
        let stop = Arc::clone(&self.stop);
        let worker = std::thread::Builder::new()
            .name("chan-workspace-recovery".to_string())
            .spawn(move || run_open_recovery(workspace, plan, &stop))
            .map_err(|error| ChanError::Io(format!("spawn workspace recovery worker: {error}")))?;
        *self.worker.lock().unwrap() = Some(worker);
        Ok(())
    }

    fn stop_and_join(&self) {
        self.stop.store(true, Ordering::Release);
        self.join();
    }

    fn join(&self) {
        let Some(worker) = self.worker.lock().unwrap().take() else {
            return;
        };
        if worker.thread().id() == std::thread::current().id() {
            return;
        }
        if worker.join().is_err() {
            tracing::warn!("workspace recovery worker panicked");
        }
    }
}

impl Drop for RecoveryWorker {
    fn drop(&mut self) {
        self.stop_and_join();
    }
}

struct RecoveryExecutionGuard<'a> {
    workspace: &'a Workspace,
    pass: Option<RecoveryPass>,
}

impl RecoveryExecutionGuard<'_> {
    fn complete(mut self) -> Result<()> {
        if let Some(pass) = self.pass {
            self.workspace
                .finish_recovery(pass, RecoveryOutcome::Complete)?;
            self.pass = None;
        }
        Ok(())
    }
}

impl Drop for RecoveryExecutionGuard<'_> {
    fn drop(&mut self) {
        if let Some(pass) = self.pass.take() {
            if let Err(error) = self.workspace.finish_recovery(pass, RecoveryOutcome::Retry) {
                tracing::warn!(?error, "failed to requeue interrupted recovery pass");
            }
        }
    }
}

/// One open workspace. Holds the writer lock for as long as it lives,
/// so two processes can't both write the same workspace's index/graph.
/// Cheap reads are unlocked; writes go through the locked handle.
pub struct Workspace {
    entry: KnownWorkspace,
    /// Canonical form of `entry.root_path`, computed once at open.
    /// Used where we need an absolute path and as the slow-path
    /// baseline for trash::restore.
    root_canon: std::path::PathBuf,
    /// Device/inode identity of the capability root on Unix. A deleted root
    /// can be recreated at the same path while this handle still points at the
    /// unlinked original; path existence alone cannot distinguish them.
    #[cfg(unix)]
    root_identity: (u64, u64),
    /// Capability-based handle to the workspace root. All filesystem
    /// ops on user-controllable paths go through this so a mid-path
    /// symlink swap between path-resolution and the actual op
    /// cannot escape the sandbox: cap-std opens each path component
    /// with O_NOFOLLOW and refuses paths that walk outside the
    /// dir handle. The previous resolve_safe_strict + std::fs::op
    /// pair had a small TOCTOU window between the lexical sandbox
    /// check and the kernel-side path walk; cap-std closes it.
    dir: cap_std::fs::Dir,
    /// Validated in-root drafts directory name (single path segment,
    /// e.g. `.Drafts`). Resolved from the global `drafts_dir` config at
    /// open; falls back to the default when the configured value is
    /// invalid. Exposed via `drafts_dir_name` so chan-server can build
    /// `<drafts_dir>/<name>/draft.md` public paths.
    drafts_dir_name: String,
    /// Absolute path to the in-root drafts directory
    /// (`root/<drafts_dir_name>`). Drafts are real in-root files, so
    /// they read/write/list/stat through the workspace-root `dir`
    /// handle like any other path; this is only used by the draft
    /// wrapper methods (`create_draft_dir`, `list_drafts`, ...) that
    /// operate on the drafts directory as a whole. Created lazily on
    /// the first `create_draft_dir`.
    drafts_root: std::path::PathBuf,
    paths: WorkspacePaths,
    /// Held for the lifetime of the Workspace. Released on drop.
    _lock: WorkspaceLock,
    /// Keeps live Workspace count bounded under descriptor pressure.
    /// This leaves room for editor reads, writes, PTYs, and watchers
    /// even when tests or callers try to open many workspaces at once.
    _fd_permit: crate::fd_budget::WorkspacePermit,
    /// Opened from sidecar metadata during startup readiness probing.
    /// `OnceLock` retains the existing retry-on-access behavior when
    /// a corrupt sidecar could not be opened during that probe.
    index: std::sync::OnceLock<Index>,
    graph: std::sync::OnceLock<GraphView>,
    /// Cumulative rename log accumulated since the last `reindex`.
    /// Maps any path the workspace has ever known a file by to its
    /// current on-disk location, transitively closed: after `a -> b`
    /// is appended and then `b -> c`, the log holds both `a -> c`
    /// and `b -> c` so a lookup against either intermediate name
    /// resolves to the same current path.
    ///
    /// Used by `rename_with_link_rewrite` to translate graph src
    /// columns (frozen at last reindex) to the source's current
    /// location, so a file moved in a prior rename still gets its
    /// outgoing links rewritten in subsequent renames. Cleared by
    /// `reindex` (which rebuilds the graph against the live tree,
    /// making every translation a no-op).
    rename_log: std::sync::Mutex<std::collections::HashMap<String, String>>,
    /// Pending per-file write journal. See `PENDING_WRITES_FILE`.
    /// Mutated under `write_serial` so the on-disk JSON always
    /// agrees with the in-memory map: every add-or-remove + persist
    /// pair runs while no other index_file/forget_file can interleave.
    pending_writes: std::sync::Mutex<std::collections::HashMap<String, PendingOp>>,
    /// Single derived-state mutation boundary. Per-file index/forget,
    /// replay, reconcile as a unit, full rebuild, and warm report
    /// watcher updates all take this lock. Queries and file I/O never do.
    /// The recovery coordinator is a separate short-lived mutex.
    write_serial: Arc<std::sync::Mutex<()>>,
    /// Serializes dashboard snapshots and read-modify-write publication.
    /// This stays separate from `write_serial`: dashboard changes are small
    /// config operations and must not wait behind an index or report walk.
    dashboard_serial: std::sync::Mutex<()>,
    /// Short-lived recovery coordinator state. This mutex is never held
    /// across replay, reconcile, or rebuild work; the derived-state
    /// mutation boundary remains a separate lock.
    recovery: std::sync::Mutex<RecoveryStatus>,
    /// One owned startup worker. It executes the metadata-derived recovery
    /// plan off the open caller and joins on ordinary workspace teardown.
    recovery_worker: RecoveryWorker,
    /// Lazily-initialized SLOC / language / COCOMO report. First
    /// touch (`report()` / `boot()`) does a full scan; further access
    /// reads the cached state, and the watcher fanout keeps it current
    /// incrementally. Kept behind `OnceLock` so workspaces that never
    /// query the report skip the scan entirely. Wrapped in `Arc` so the
    /// watcher's `ReportFanOut` shares the same cell: `watch()` attaches
    /// the fan-out without warming the report, and a later scan fills
    /// this cell for both the query path and the fan-out at once.
    report: Arc<std::sync::OnceLock<Arc<ReportState>>>,
    /// Global directory-name baseline captured from the parent `Library`.
    /// The generated scope unions this with the per-workspace additions;
    /// raw editor listings deliberately bypass both so blocked paths remain
    /// available for explicit open-on-demand operations.
    walk_filter: Arc<fs_ops::WalkFilter>,
    /// Immutable generated scope sampled by every derived-state consumer.
    /// Replacements swap one Arc under a short lock; in-flight work keeps its
    /// generation while newer recovery remains pending.
    scope_policy: Arc<std::sync::RwLock<Arc<fs_ops::IndexScopePolicy>>>,
}

fn run_open_recovery(workspace: std::sync::Weak<Workspace>, plan: RecoveryPlan, stop: &AtomicBool) {
    let Some(workspace) = workspace.upgrade() else {
        return;
    };
    tracing::debug!(
        generation = plan.generation.get(),
        action = ?plan.action,
        replay_pending_writes = plan.replay_pending_writes,
        refresh_report = plan.refresh_report,
        "workspace startup recovery worker started",
    );

    if plan.replay_pending_writes
        && plan.action != Some(RecoveryAction::Replay)
        && !stop.load(Ordering::Acquire)
    {
        if let Err(error) = workspace.replay_pending_writes() {
            tracing::warn!(
                workspace = %workspace.root().display(),
                ?error,
                "startup pending-write replay failed; recovery remains pending",
            );
            return;
        }
    }

    while !stop.load(Ordering::Acquire) {
        let Some(pass) = workspace.begin_recovery() else {
            break;
        };
        let mut result = match pass.action {
            RecoveryAction::Replay => workspace.replay_pending_writes().map(|_| ()),
            RecoveryAction::Reconcile => workspace.reconcile().map(|_| ()),
            RecoveryAction::FullRebuild => workspace.reindex(Some(stop)).map(|_| ()),
        };
        if result.is_ok() && plan.refresh_report && !stop.load(Ordering::Acquire) {
            result = workspace.rescan_persisted_report();
        }
        let outcome = if result.is_ok() {
            RecoveryOutcome::Complete
        } else {
            RecoveryOutcome::Retry
        };
        if let Err(error) = workspace.finish_recovery(pass, outcome) {
            tracing::warn!(
                workspace = %workspace.root().display(),
                ?error,
                "startup recovery coordinator completion failed",
            );
            return;
        }
        if let Err(error) = result {
            tracing::warn!(
                workspace = %workspace.root().display(),
                generation = pass.generation.get(),
                action = ?pass.action,
                ?error,
                "startup recovery pass failed; recovery remains pending",
            );
            return;
        }
    }
}

/// Refresh repository-ignore policy before the report and user callbacks see
/// the `.gitignore` event that invalidated the current generation.
struct ScopePolicyFanOut {
    workspace: std::sync::Weak<Workspace>,
    downstream: Arc<dyn WatchCallback>,
}

impl WatchCallback for ScopePolicyFanOut {
    fn on_event(&self, event: WatchEvent) {
        if event.kind != WatchKind::ProviderError
            && [event.path.as_deref(), event.to.as_deref()]
                .into_iter()
                .flatten()
                .any(is_repository_policy_path)
        {
            if let Some(workspace) = self.workspace.upgrade() {
                if let Err(error) = workspace.refresh_repository_scope() {
                    tracing::warn!(?error, "failed to refresh repository ignore policy");
                }
            }
        }
        self.downstream.on_event(event);
    }
}

fn is_repository_policy_path(rel: &str) -> bool {
    Path::new(rel)
        .file_name()
        .is_some_and(|name| name == ".gitignore")
}

impl std::fmt::Debug for Workspace {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Workspace")
            .field("root", &self.entry.root_path)
            .field("metadata_key", &self.entry.metadata_key)
            .finish()
    }
}

impl Workspace {
    pub(crate) fn open(
        entry: KnownWorkspace,
        walk_filter: Arc<fs_ops::WalkFilter>,
        drafts_dir: String,
    ) -> Result<(Arc<Self>, RecoveryPlan)> {
        // Defensive check: the registered path must still resolve to
        // a directory. A user (or another tool) could have replaced
        // the workspace directory with a symlink, file, or socket since
        // the registry entry was written, in which case our path
        // sandbox and per-op gates would still apply but the workspace
        // shape itself is no longer what the user signed up for.
        // `exists()` follows symlinks, so we use lstat here to catch
        // a "directory turned into a symlink" replacement.
        let meta = match std::fs::symlink_metadata(&entry.root_path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(ChanError::WorkspaceRootMissing(entry.root_path.clone()));
            }
            Err(e) => return Err(ChanError::Io(e.to_string())),
        };
        let ft = meta.file_type();
        if !ft.is_dir() || ft.is_symlink() {
            return Err(ChanError::SpecialFile {
                kind: fs_ops::describe_file_kind(&ft).to_string(),
                path: entry.root_path.clone(),
            });
        }
        let root_canon = match entry.root_path.canonicalize() {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(ChanError::WorkspaceRootMissing(entry.root_path.clone()));
            }
            Err(error) => {
                return Err(ChanError::Io(format!(
                    "canonicalize workspace root: {error}"
                )));
            }
        };
        let fd_permit = crate::fd_budget::acquire_workspace_permit();
        let dir =
            cap_std::fs::Dir::open_ambient_dir(&entry.root_path, cap_std::ambient_authority())
                .map_err(|error| {
                    if error.kind() == std::io::ErrorKind::NotFound {
                        ChanError::WorkspaceRootMissing(entry.root_path.clone())
                    } else {
                        ChanError::Io(format!("open workspace root: {error}"))
                    }
                })?;
        #[cfg(unix)]
        let root_identity = {
            use cap_std::fs::MetadataExt as _;
            let opened = dir
                .dir_metadata()
                .map_err(|e| ChanError::Io(format!("stat open workspace root: {e}")))?;
            let identity = (opened.dev(), opened.ino());
            use std::os::unix::fs::MetadataExt as _;
            if identity != (meta.dev(), meta.ino()) {
                return Err(ChanError::WorkspaceRootMissing(entry.root_path.clone()));
            }
            identity
        };
        if entry.metadata_key.is_empty() {
            return Err(ChanError::Io(format!(
                "registry entry for {:?} has empty metadata key; open the workspace via Library::open_workspace",
                entry.root_path,
            )));
        }
        let paths = ensure_workspace_metadata_dirs(&entry.metadata_key)
            .map_err(|e| ChanError::Io(format!("ensure workspace metadata dirs: {e}")))?;
        let lock = WorkspaceLock::acquire(&paths.lock, &root_canon)?;
        // Lazy GC: reclaim expired trash entries on every open. No
        // background thread, matches the codebase's sync-only rule.
        // Errors are swallowed: a corrupt trash dir must never block
        // a legitimate workspace open.
        let _ = trash::sweep_expired(&paths.trash, TRASH_RETENTION_SECS);
        // Validate the configured in-root drafts dir name. An invalid
        // value (separator, traversal, clash with `.git`/`.chan` or an
        // excluded dir) falls back to the default rather than failing
        // the open, mirroring the graceful handling of other global
        // config. Drafts are real in-root files: nothing is created
        // here; `<root>/<drafts_dir_name>` materializes lazily on the
        // first `create_draft_dir`.
        let drafts_dir_name =
            if crate::registry::validate_drafts_dir(&drafts_dir, &walk_filter.excluded_dir_names) {
                drafts_dir
            } else {
                tracing::warn!(
                    configured = %drafts_dir,
                    fallback = crate::registry::DEFAULT_DRAFTS_DIR,
                    "invalid drafts_dir config; falling back to default"
                );
                crate::registry::DEFAULT_DRAFTS_DIR.to_string()
            };
        let drafts_root = entry.root_path.join(&drafts_dir_name);
        // A stale `rebuild.inprogress` marker means the previous
        // reindex did not finish atomically. Promote it to an
        // pending full-rebuild plan. The plan runs on the owned recovery
        // worker after open returns.
        let needs_rebuild = paths.graph_dir.join(REBUILD_MARKER).exists();
        if needs_rebuild {
            tracing::warn!(
                workspace = %entry.root_path.display(),
                "rebuild.inprogress marker found at open; full reindex required",
            );
        }
        // Rehydrate the rename log from disk. A previous process
        // session's renames must remain visible to the link-rewrite
        // path; without this, a chain spanning a crash silently
        // breaks. Best-effort: a missing or malformed file falls
        // back to an empty map (the next reindex would rebuild the
        // graph either way).
        let rename_log = load_rename_log(&paths.graph_dir);
        // Rehydrate the pending-writes journal: any entries still
        // present mean a previous index_file / forget_file crashed
        // between the graph and index commits. The startup plan replays
        // these entries off the open caller. Best-effort against malformed
        // JSON, same rationale as the rename log.
        let pending_writes = load_pending_writes(&paths.graph_dir);
        let needs_replay_writes = !pending_writes.is_empty();
        if needs_replay_writes {
            tracing::warn!(
                workspace = %entry.root_path.display(),
                count = pending_writes.len(),
                "pending_writes journal non-empty at open; replay required",
            );
        }
        // Probe persisted graph and search metadata only. No workspace path is
        // visited. A populated pair needs an offline-change reconcile, an empty
        // pair stays on the existing cold-boot path, and unreadable or
        // graph-populated/search-empty state requests a rebuild.
        let (graph, graph_populated) = match GraphView::open(&paths.graph_db) {
            Ok(graph) => match graph.files() {
                Ok(files) => (Some(graph), Some(!files.is_empty())),
                Err(error) => {
                    tracing::warn!(
                        workspace = %entry.root_path.display(),
                        ?error,
                        "graph readiness probe failed; full rebuild required",
                    );
                    (Some(graph), None)
                }
            },
            Err(error) => {
                tracing::warn!(
                    workspace = %entry.root_path.display(),
                    ?error,
                    "graph open failed during readiness probe; full rebuild required",
                );
                (None, None)
            }
        };
        let index_config = crate::index::config::load(&paths.index)
            .map_err(|error| ChanError::Search(error.to_string()))?;
        let (index, index_populated) = match Index::open(&entry.root_path, &paths.index) {
            Ok(index) => {
                let populated = index.stats().indexed_docs > 0;
                (Some(index), Some(populated))
            }
            Err(error) => {
                tracing::warn!(
                    workspace = %entry.root_path.display(),
                    ?error,
                    "search readiness probe failed; full rebuild required",
                );
                (None, None)
            }
        };
        let state_readiness = match (graph_populated, index_populated) {
            (Some(false), Some(false)) => PersistedStateReadiness::Cold,
            (Some(true), Some(false)) | (None, _) | (_, None) => {
                PersistedStateReadiness::Inconsistent
            }
            (Some(_), Some(true)) => PersistedStateReadiness::Populated,
        };
        let refresh_report = paths.report.is_file();
        let (recovery, recovery_plan) = RecoveryPlan::derive(
            needs_rebuild,
            needs_replay_writes,
            state_readiness,
            refresh_report,
        );
        let mut configured = walk_filter.excluded_dir_names.clone();
        configured.extend(index_config.excluded_dirs);
        let scope_policy = Arc::new(fs_ops::IndexScopePolicy::new(
            entry.root_path.clone(),
            recovery.generation,
            fs_ops::WalkFilter::new(configured),
        )?);
        if let Some(index) = &index {
            index.set_scope_policy(Arc::clone(&scope_policy));
        }
        let index_cell = {
            let cell = std::sync::OnceLock::new();
            if let Some(index) = index {
                let _ = cell.set(index);
            }
            cell
        };
        let graph_cell = {
            let cell = std::sync::OnceLock::new();
            if let Some(graph) = graph {
                let _ = cell.set(graph);
            }
            cell
        };
        let workspace = Arc::new(Self {
            entry,
            root_canon,
            #[cfg(unix)]
            root_identity,
            dir,
            drafts_dir_name,
            drafts_root,
            paths,
            _lock: lock,
            _fd_permit: fd_permit,
            index: index_cell,
            graph: graph_cell,
            rename_log: std::sync::Mutex::new(rename_log),
            pending_writes: std::sync::Mutex::new(pending_writes),
            write_serial: Arc::new(std::sync::Mutex::new(())),
            dashboard_serial: std::sync::Mutex::new(()),
            recovery: std::sync::Mutex::new(recovery),
            recovery_worker: RecoveryWorker::new(),
            report: Arc::new(std::sync::OnceLock::new()),
            walk_filter,
            scope_policy: Arc::new(std::sync::RwLock::new(scope_policy)),
        });

        Ok((workspace, recovery_plan))
    }

    pub(crate) fn start_open_recovery(self: &Arc<Self>, plan: RecoveryPlan) -> Result<()> {
        self.recovery_worker.start(Arc::downgrade(self), plan)
    }

    /// Cancel and synchronously join the owned startup recovery worker.
    ///
    /// Hosts call this before dropping their last workspace handle so a
    /// crash-recovery full rebuild cannot retain the workspace flock across
    /// close and block an immediate reopen.
    pub fn stop_open_recovery(&self) {
        self.recovery_worker.stop_and_join();
    }

    #[cfg(test)]
    pub(crate) fn join_open_recovery(&self) {
        self.recovery_worker.join();
    }

    /// Latest recovery or policy generation known to this workspace.
    pub fn generation(&self) -> WorkspaceGeneration {
        self.recovery.lock().unwrap().generation
    }

    /// Snapshot the recovery coordinator without waiting for recovery work.
    pub fn recovery_status(&self) -> RecoveryStatus {
        *self.recovery.lock().unwrap()
    }

    /// Consumer-facing readiness without exposing the coordinator lock.
    pub fn readiness(&self) -> WorkspaceReadiness {
        self.recovery_status().into()
    }

    /// Request convergence for a lossy signal such as provider overflow.
    ///
    /// Equivalent requests coalesce into the existing pending generation.
    pub fn request_recovery(&self, action: RecoveryAction) -> WorkspaceGeneration {
        let mut status = self.recovery.lock().unwrap();
        if let Some(mut pending) = status.pending {
            pending.action = std::cmp::max(pending.action, action);
            status.pending = Some(pending);
            return pending.generation;
        }

        let generation = status.generation.next();
        status.generation = generation;
        status.pending = Some(RecoveryPass { generation, action });
        generation
    }

    /// Request convergence for an immutable policy replacement.
    ///
    /// Every policy replacement advances the generation. Pending work can
    /// collapse into the newest generation while retaining action dominance.
    pub fn request_policy_recovery(&self, action: RecoveryAction) -> WorkspaceGeneration {
        let mut status = self.recovery.lock().unwrap();
        let generation = status.generation.next();
        status.generation = generation;
        let action = status
            .pending
            .map(|pending| std::cmp::max(pending.action, action))
            .unwrap_or(action);
        status.pending = Some(RecoveryPass { generation, action });
        generation
    }

    /// Move pending recovery into the single active slot.
    pub fn begin_recovery(&self) -> Option<RecoveryPass> {
        let mut status = self.recovery.lock().unwrap();
        if status.active.is_some() {
            return None;
        }
        let pass = status.pending.take()?;
        status.active = Some(pass);
        Some(pass)
    }

    /// Complete or requeue one active recovery pass.
    pub fn finish_recovery(
        &self,
        pass: RecoveryPass,
        outcome: RecoveryOutcome,
    ) -> Result<RecoveryStatus> {
        let mut status = self.recovery.lock().unwrap();
        if status.active != Some(pass) {
            return Err(ChanError::Io(format!(
                "recovery pass is not active: generation {}",
                pass.generation.get()
            )));
        }
        status.active = None;
        match outcome {
            RecoveryOutcome::Complete => {
                status.completed_generation =
                    std::cmp::max(status.completed_generation, pass.generation);
            }
            RecoveryOutcome::Retry => {
                status.pending = Some(match status.pending {
                    Some(pending) => RecoveryPass {
                        generation: pending.generation,
                        action: std::cmp::max(pending.action, pass.action),
                    },
                    None => pass,
                });
            }
        }
        Ok(*status)
    }

    fn recovery_execution(&self, action: RecoveryAction) -> RecoveryExecutionGuard<'_> {
        let mut status = self.recovery.lock().unwrap();
        let pass = if status.active.is_some()
            || status
                .pending
                .is_some_and(|pending| pending.action > action)
        {
            None
        } else {
            let pass = match status.pending.take() {
                Some(mut pending) => {
                    pending.action = std::cmp::max(pending.action, action);
                    pending
                }
                None => {
                    let generation = status.generation.next();
                    status.generation = generation;
                    RecoveryPass { generation, action }
                }
            };
            status.active = Some(pass);
            Some(pass)
        };
        drop(status);
        RecoveryExecutionGuard {
            workspace: self,
            pass,
        }
    }

    /// True when the last reindex did not run to completion (either
    /// because the process crashed between graph rebuild and BM25
    /// commit, or because a marker from a prior install still
    /// lingers). Startup recovery consumes this automatically; callers
    /// can use the projection to avoid serving a not-yet-ready index.
    pub fn needs_rebuild(&self) -> bool {
        let status = self.recovery_status();
        status
            .active
            .into_iter()
            .chain(status.pending)
            .any(|pass| pass.action == RecoveryAction::FullRebuild)
    }

    /// True while a full-rebuild recovery pass is active. The
    /// Web App / WebSocket fan-out uses this on first connect to
    /// render "indexing..." without having to wait for the next
    /// `ProgressEvent` push; combine with `index_stats()` for the
    /// chunk count and `needs_rebuild()` for the "needs catch-up"
    /// signal. Direct reindex calls own a recovery guard; externally
    /// coordinated calls use the pass begun by their caller.
    pub fn is_reindexing(&self) -> bool {
        self.recovery_status()
            .active
            .is_some_and(|pass| pass.action == RecoveryAction::FullRebuild)
    }

    /// Validate `rel` for use with the cap-std `Dir`. Returns a
    /// pure-Component::Normal PathBuf or a `PathEmpty` / `PathEscape`
    /// error. cap-std would refuse a bad path anyway; this gate
    /// gives crisp error variants.
    fn rel(&self, rel: &str) -> Result<std::path::PathBuf> {
        fs_ops::validate_rel(rel)
    }

    /// Resolve a workspace-relative rel to the (cap-std dir, validated
    /// PathBuf inside that dir) pair the IO helpers operate against.
    /// Every path now routes through the workspace-root `dir` handle:
    /// drafts are real in-root files under `<drafts_dir_name>/...`, so
    /// `.Drafts/untitled-1/draft.md` resolves like any other path. The
    /// cap-std sandbox prevents traversal escape.
    fn resolve_io(&self, rel: &str) -> Result<(&cap_std::fs::Dir, std::path::PathBuf)> {
        let validated = fs_ops::validate_rel(rel)?;
        Ok((&self.dir, validated))
    }

    /// Resolve a public chan path to the real host filesystem path,
    /// rooted at the workspace root. Drafts have no separate namespace:
    /// `<drafts_dir_name>/<name>/...` resolves under the root like any
    /// other in-tree path.
    pub fn resolve_physical_path(&self, rel: &str) -> Result<std::path::PathBuf> {
        let trimmed = rel.trim_matches('/');
        if trimmed.is_empty() || trimmed == "." {
            return Ok(self.root_canon.clone());
        }
        fs_ops::resolve_safe_strict_canon(self.root(), &self.root_canon, trimmed)
    }

    /// Resolve a public chan path to an existing real directory.
    pub fn resolve_physical_dir(&self, rel: &str) -> Result<std::path::PathBuf> {
        let abs = self.resolve_physical_path(rel)?;
        let meta = std::fs::metadata(&abs).map_err(|e| ChanError::Io(e.to_string()))?;
        if !meta.is_dir() {
            return Err(ChanError::Io("path is not a directory".into()));
        }
        Ok(abs)
    }

    /// Convert a real filesystem path back to chan's public path
    /// namespace when it is inside the workspace root. Drafts live
    /// in-root under `<drafts_dir_name>/...`, so they fall out of the
    /// normal root-relative mapping with no special case.
    pub fn physical_path_to_virtual(&self, path: &std::path::Path) -> Option<String> {
        let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        if path == self.root_canon {
            return Some(String::new());
        }
        if let Ok(rel) = path.strip_prefix(&self.root_canon) {
            return Some(posix_path(rel));
        }
        None
    }

    pub fn root(&self) -> &std::path::Path {
        &self.entry.root_path
    }

    /// Verify that the workspace root still resolves to the directory this
    /// handle was opened for.
    ///
    /// The capability directory remains usable as an object after its path is
    /// recursively removed on Unix. Callers that are about to publish a tenant
    /// or begin a new root-dependent operation therefore cannot infer path
    /// availability from the open handle alone. This check deliberately uses
    /// the live path and the same file-shape contract as [`Workspace::open`]:
    /// missing roots are typed, and a root replaced by a symlink or non-
    /// directory is refused.
    pub fn ensure_root_available(&self) -> Result<()> {
        let meta = match std::fs::symlink_metadata(&self.entry.root_path) {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(ChanError::WorkspaceRootMissing(
                    self.entry.root_path.clone(),
                ));
            }
            Err(error) => return Err(ChanError::Io(error.to_string())),
        };
        let file_type = meta.file_type();
        if !file_type.is_dir() || file_type.is_symlink() {
            return Err(ChanError::SpecialFile {
                kind: fs_ops::describe_file_kind(&file_type).to_string(),
                path: self.entry.root_path.clone(),
            });
        }
        let live_canon = match self.entry.root_path.canonicalize() {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(ChanError::WorkspaceRootMissing(
                    self.entry.root_path.clone(),
                ));
            }
            Err(error) => {
                return Err(ChanError::Io(format!(
                    "canonicalize workspace root: {error}"
                )));
            }
        };
        if live_canon != self.root_canon {
            return Err(ChanError::WorkspaceRootMissing(
                self.entry.root_path.clone(),
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt as _;
            if (meta.dev(), meta.ino()) != self.root_identity {
                return Err(ChanError::WorkspaceRootMissing(
                    self.entry.root_path.clone(),
                ));
            }
        }
        Ok(())
    }

    /// Canonical workspace root captured when the writer handle opened.
    pub fn canonical_root(&self) -> &std::path::Path {
        &self.root_canon
    }

    /// Stable registry key for this workspace's sidecar state.
    pub fn metadata_key(&self) -> &str {
        &self.entry.metadata_key
    }

    /// Effective display label: configured name, then root basename.
    pub fn display_name(&self) -> String {
        self.entry.display_name.clone().unwrap_or_else(|| {
            self.root_canon
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| self.root_canon.display().to_string())
        })
    }

    /// Per-workspace paths (sessions, index dir, graph DB, lock).
    /// Exposed for apps that want to put their own state alongside
    /// chan-workspace's.
    pub fn paths(&self) -> &WorkspacePaths {
        &self.paths
    }

    /// The directory-name blocklist this Workspace applies to its
    /// reindex walks. Snapshot from the parent Library at open
    /// time; survives across reindex calls. Editor-visible walks
    /// (the file tree, search, trash) do not consult it.
    pub fn walk_filter(&self) -> &fs_ops::WalkFilter {
        &self.walk_filter
    }

    /// Immutable generated scope currently shared by derived-state consumers.
    pub fn scope_policy(&self) -> Arc<fs_ops::IndexScopePolicy> {
        Arc::clone(&self.scope_policy.read().unwrap())
    }

    /// Structural bootstrap snapshot of the workspace root: the immediate
    /// files + directories, each directory carrying its recursive
    /// (filtered) subtree file count and byte total, plus the
    /// whole-workspace aggregate. Stat-only (no content read), filtered by
    /// the same `WalkFilter` the indexer uses. This is the spine the
    /// UI renders before the paced index / report jobs run; deeper
    /// levels load lazily on File Browser expand / Graph depth.
    pub fn bootstrap(&self) -> Result<crate::bootstrap::BootstrapTree> {
        let policy = self.scope_policy();
        crate::bootstrap::bootstrap_root_scoped(self.root(), &policy)
    }

    /// Bootstrap snapshot for a nested directory at workspace-relative
    /// `rel` ("" is the root, equivalent to `bootstrap()`). Same
    /// eager-level shape as `bootstrap`; used when a caller wants the
    /// subtree-stats shape for an expanded directory rather than the
    /// plain per-file listing.
    pub fn bootstrap_dir(&self, rel: &str) -> Result<crate::bootstrap::BootstrapTree> {
        let policy = self.scope_policy();
        crate::bootstrap::bootstrap_dir_scoped(self.root(), rel, &policy)
    }

    // ---- filesystem primitives (path-based, rel-only) ----
    //
    // Every entry point here routes through the cap-std `Dir`
    // opened at `Workspace::open`. cap-std uses openat-per-component
    // with O_NOFOLLOW (or RESOLVE_BENEATH on Linux openat2), so a
    // mid-path symlink swap between path validation and the actual
    // op cannot escape the workspace root. Reads additionally call
    // `ensure_regular_file_in` (lstat) so we never block on a FIFO,
    // drain a device, or follow a symlink off the workspace. Writes
    // that target an existing path use the same classification and
    // temp-file probe through `ensure_writable`.

    /// Classify a workspace-relative path through the capability sandbox.
    ///
    /// A missing leaf is a normal value. Lexical traversal and mid-path
    /// symlink escapes remain typed errors.
    pub fn classify_workspace_path(&self, rel: &str) -> Result<WorkspacePath> {
        let rel_path = self.rel(rel)?;
        let metadata = match self.dir.symlink_metadata(&rel_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(WorkspacePath::Missing);
            }
            Err(error) => return Err(map_cap_err(error, &rel_path)),
        };
        let file_type = metadata.file_type();
        let stat = file_stat_from_cap(&metadata);
        if file_type.is_file() && !file_type.is_symlink() {
            return Ok(WorkspacePath::Regular(stat));
        }
        if file_type.is_dir() {
            return Ok(WorkspacePath::Directory(stat));
        }
        Ok(WorkspacePath::Special(path_kind_cap(&file_type)))
    }

    /// Verify that an atomic replacement can create its same-directory temp.
    ///
    /// Existing targets must be writable regular files. Missing targets are
    /// allowed, and their parent directories are created with the same
    /// semantics as the eventual write.
    pub fn ensure_writable(&self, rel: &str) -> Result<WritableFile> {
        // A capability directory can outlive an unlinked workspace path on
        // Unix. Never preflight or create parents inside that unreachable
        // directory: callers need a typed root-loss error instead.
        self.ensure_root_available()?;
        let rel_path = self.rel(rel)?;
        let stat = match self.dir.symlink_metadata(&rel_path) {
            Ok(metadata) => {
                let file_type = metadata.file_type();
                if !file_type.is_file() || file_type.is_symlink() {
                    return Err(ChanError::SpecialFile {
                        kind: describe_cap_file_kind(&file_type).to_string(),
                        path: rel_path,
                    });
                }
                if metadata.permissions().readonly() {
                    return Err(ChanError::Io(format!(
                        "path is read-only: {}",
                        rel_path.display()
                    )));
                }
                Some(file_stat_from_cap(&metadata))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(map_cap_err(error, &rel_path)),
        };

        if let Some(parent) = rel_path.parent() {
            if !parent.as_os_str().is_empty() {
                self.dir
                    .create_dir_all(parent)
                    .map_err(|error| map_cap_err(error, &rel_path))?;
            }
        }
        let parent = rel_path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty());
        let parent_dir;
        let target_dir = match parent {
            Some(parent) => {
                parent_dir = self
                    .dir
                    .open_dir(parent)
                    .map_err(|error| map_cap_err(error, &rel_path))?;
                &parent_dir
            }
            None => &self.dir,
        };
        let parent_metadata = target_dir
            .dir_metadata()
            .map_err(|error| map_cap_err(error, &rel_path))?;
        if parent_metadata.permissions().readonly() {
            return Err(ChanError::Io(format!(
                "destination directory is read-only: {}",
                parent
                    .unwrap_or_else(|| std::path::Path::new("."))
                    .display()
            )));
        }
        let probe = cap_tempfile::TempFile::new(target_dir)
            .map_err(|error| map_cap_err(error, &rel_path))?;
        drop(probe);
        Ok(WritableFile { stat })
    }

    /// Atomically replace one workspace file from caller-fed chunks.
    ///
    /// The target is untouched unless `feed` returns success and every chunk
    /// satisfies the selected budget and UTF-8 policy.
    pub fn write_atomic_stream<F>(
        &self,
        rel: &str,
        kind: AtomicWriteKind,
        feed: F,
    ) -> Result<FileStat>
    where
        F: FnOnce(&mut dyn AtomicWriteSink) -> Result<()>,
    {
        if kind == AtomicWriteKind::Text && !self.editable_text_gate(rel) {
            return Err(ChanError::NotEditableText(rel.to_string()));
        }
        let writable = self.ensure_writable(rel)?;
        let existing_size = writable.stat.as_ref().map(|stat| stat.size);
        let limit = match kind {
            AtomicWriteKind::Text => semantic_write_budget(existing_size),
            AtomicWriteKind::Bytes => std::cmp::max(existing_size.unwrap_or(0), BYTES_WRITE_LIMIT),
        };
        let bytes_target_is_text = kind == AtomicWriteKind::Bytes && fs_ops::is_editable_text(rel);
        let validate_utf8 = kind == AtomicWriteKind::Text || bytes_target_is_text;
        let (dir, rel_path) = self.resolve_io(rel)?;
        if let Err(error) =
            fs_ops::atomic_write_stream_in(dir, &rel_path, kind, limit, validate_utf8, feed)
        {
            // Prefer the terminal root-loss condition over an incidental
            // mid-delete I/O failure. This keeps an editor autosave racing
            // `rm -rf <root>` on the stable typed 404 path.
            self.ensure_root_available()?;
            if bytes_target_is_text
                && matches!(
                    &error,
                    ChanError::Io(message)
                        if message == "invalid UTF-8 in streamed text write"
                )
            {
                return Err(ChanError::Io(format!(
                    "refusing to write non-UTF-8 bytes to editable text file: {rel}"
                )));
            }
            return Err(error);
        }
        // The write may have begun while the root still existed and completed
        // through the retained capability after its pathname was removed.
        // Do not report that unreachable commit as success.
        self.ensure_root_available()?;
        self.stat(rel)
    }

    /// Open one regular file and stream it through a fixed-size bounded queue.
    pub fn read_bytes_bounded(&self, rel: &str) -> Result<BoundedFileReader> {
        use std::io::Read;

        let (dir, rel_path) = self.resolve_io(rel)?;
        ensure_regular_file_in(dir, &rel_path)?;
        let mut file = dir
            .open(&rel_path)
            .map_err(|error| map_cap_err(error, &rel_path))?;
        let stat = file_stat_from_cap(&file.metadata()?);
        let (sender, receiver) =
            std::sync::mpsc::sync_channel::<Result<Vec<u8>>>(BINARY_STREAM_QUEUE_DEPTH);
        let worker = std::thread::Builder::new()
            .name("chan-byte-reader".to_string())
            .spawn(move || {
                #[cfg(test)]
                ACTIVE_BOUNDED_FILE_READERS.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                #[cfg(test)]
                let _active_guard = ActiveBoundedFileReaderGuard;

                loop {
                    let mut chunk = vec![0u8; BINARY_STREAM_CHUNK_SIZE];
                    let count = match file.read(&mut chunk) {
                        Ok(0) => return,
                        Ok(count) => count,
                        Err(error) => {
                            let _ = sender.send(Err(ChanError::Io(error.to_string())));
                            return;
                        }
                    };
                    chunk.truncate(count);
                    if sender.send(Ok(chunk)).is_err() {
                        return;
                    }
                }
            })
            .map_err(|error| ChanError::Io(format!("spawn bounded file reader: {error}")))?;
        Ok(BoundedFileReader {
            stat,
            receiver: Some(receiver),
            worker: Some(worker),
        })
    }

    /// Read raw bytes from a file relative to the workspace root. No
    /// editable-text gate: callers like image previews need binary
    /// reads. The path must resolve to a regular file under the
    /// workspace root; symlinks, FIFOs, sockets, and devices are
    /// rejected.
    pub fn read(&self, rel: &str) -> Result<Vec<u8>> {
        let (dir, rel_path) = self.resolve_io(rel)?;
        ensure_regular_file_in(dir, &rel_path)?;
        let mut f = dir
            .open(&rel_path)
            .map_err(|e| ChanError::Io(e.to_string()))?;
        use std::io::Read;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)?;
        Ok(buf)
    }

    /// Sniff whether `rel` is editable text by *content*. Reads up to
    /// `fs_ops::TEXT_SNIFF_BYTES` and applies `fs_ops::looks_like_text`.
    /// This is the fall-back arm of the editable-text gate (and the
    /// file browser's kind resolver): it is what lets the editor open
    /// `.zshrc`, `*.service`, `Kconfig`, and other extensionless /
    /// odd-suffix text files that the path-only `fs_ops::is_editable_text`
    /// refuses. Returns false on any I/O error or non-regular file: a
    /// file we cannot sample stays non-editable.
    pub fn sniff_is_text(&self, rel: &str) -> bool {
        use std::io::Read;
        let Ok((dir, rel_path)) = self.resolve_io(rel) else {
            return false;
        };
        if ensure_regular_file_in(dir, &rel_path).is_err() {
            return false;
        }
        let Ok(f) = dir.open(&rel_path) else {
            return false;
        };
        let mut buf = Vec::with_capacity(fs_ops::TEXT_SNIFF_BYTES);
        if f.take(fs_ops::TEXT_SNIFF_BYTES as u64)
            .read_to_end(&mut buf)
            .is_err()
        {
            return false;
        }
        fs_ops::looks_like_text(&buf)
    }

    /// The editable-text gate for `read_text` / `write_text` and
    /// friends: a path the extension classifier already types as text,
    /// OR an unknown-extension file whose leading bytes sniff as text.
    /// Keep the sniff out of `fs_ops::is_editable_text` (which stays a
    /// pure, I/O-free path predicate used in hot index walks); the
    /// content read belongs only on the per-file read/write path.
    fn editable_text_gate(&self, rel: &str) -> bool {
        fs_ops::is_editable_text(rel) || self.sniff_is_text(rel)
    }

    /// Read UTF-8 text. Errors if the file isn't editable text (by
    /// extension or content sniff) or isn't a regular file.
    pub fn read_text(&self, rel: &str) -> Result<String> {
        if !self.editable_text_gate(rel) {
            return Err(ChanError::NotEditableText(rel.to_string()));
        }
        let (dir, rel_path) = self.resolve_io(rel)?;
        ensure_regular_file_in(dir, &rel_path)?;
        let mut f = dir
            .open(&rel_path)
            .map_err(|e| ChanError::Io(e.to_string()))?;
        use std::io::Read;
        let mut buf = String::new();
        f.read_to_string(&mut buf)?;
        Ok(buf)
    }

    /// Read UTF-8 text and return the file's stat alongside the
    /// content. The stat is taken from the open file handle (fstat)
    /// so the returned mtime corresponds to the bytes returned, with
    /// no second-syscall race window. Pair with `write_text_if_unchanged`
    /// for optimistic-concurrency editor saves.
    pub fn read_text_with_stat(&self, rel: &str) -> Result<(String, FileStat)> {
        use std::io::Read;
        if !self.editable_text_gate(rel) {
            return Err(ChanError::NotEditableText(rel.to_string()));
        }
        let (dir, rel_path) = self.resolve_io(rel)?;
        ensure_regular_file_in(dir, &rel_path)?;
        let mut f = dir
            .open(&rel_path)
            .map_err(|e| ChanError::Io(e.to_string()))?;
        let meta = f.metadata()?;
        let mut content = String::new();
        f.read_to_string(&mut content)?;
        let stat = FileStat {
            size: meta.len(),
            mtime: mtime_secs_cap(&meta),
            mtime_ns: mtime_ns_cap(&meta),
            is_dir: false,
        };
        Ok((content, stat))
    }

    /// Stream UTF-8 text in chunks and include the open-handle stat.
    /// Returns early with `Ok(())` when the callback returns false,
    /// which lets HTTP callers stop disk reads after the client
    /// disconnects without treating it as a storage failure.
    pub fn read_text_with_stat_chunked<F>(
        &self,
        rel: &str,
        chunk_size: usize,
        mut on_event: F,
    ) -> Result<()>
    where
        F: FnMut(TextReadEvent<'_>) -> bool,
    {
        use std::io::Read;
        if !self.editable_text_gate(rel) {
            return Err(ChanError::NotEditableText(rel.to_string()));
        }
        let (dir, rel_path) = self.resolve_io(rel)?;
        ensure_regular_file_in(dir, &rel_path)?;
        let mut f = dir
            .open(&rel_path)
            .map_err(|e| ChanError::Io(e.to_string()))?;
        let meta = f.metadata()?;
        let stat = FileStat {
            size: meta.len(),
            mtime: mtime_secs_cap(&meta),
            mtime_ns: mtime_ns_cap(&meta),
            is_dir: false,
        };
        if !on_event(TextReadEvent::Meta(&stat)) {
            return Ok(());
        }

        let mut read_buf = vec![0u8; chunk_size.max(1)];
        let mut pending = Vec::new();
        loop {
            let n = f.read(&mut read_buf)?;
            if n == 0 {
                break;
            }
            pending.extend_from_slice(&read_buf[..n]);
            if !emit_valid_utf8_chunks(rel, &mut pending, &mut on_event)? {
                return Ok(());
            }
        }
        if !pending.is_empty() {
            return Err(ChanError::Io(format!(
                "invalid UTF-8 in editable text file: {rel}"
            )));
        }
        let _ = on_event(TextReadEvent::Done);
        Ok(())
    }

    /// Atomically write UTF-8 text. Editable-text gate applies.
    /// Refuses to write through a path whose final component is a
    /// non-regular file (symlink, device, FIFO, socket); the user
    /// must remove the existing entry first if they intend to
    /// replace it.
    pub fn write_text(&self, rel: &str, content: &str) -> Result<()> {
        self.write_atomic_stream(rel, AtomicWriteKind::Text, |sink| {
            sink.write_chunk(content.as_bytes())
        })
        .map(|_| ())
    }

    /// Optimistic-concurrency write: succeeds only when the file's
    /// current mtime (nanoseconds) matches `expected_mtime_ns`. The
    /// editor pairs this with `read_text_with_stat`: it reads
    /// (content, stat), the user edits, then it writes back with
    /// `expected_mtime_ns = stat.mtime_ns`. If the file changed under
    /// the editor (another process, another pane), the write fails
    /// with `ChanError::WriteConflict` and the editor can prompt to
    /// reload, merge, or overwrite.
    ///
    /// Why nanoseconds: most filesystems chan runs on (ext4, xfs,
    /// APFS, btrfs) expose nanosecond mtime. Two saves landing within
    /// the same wall-clock second produce identical second-resolution
    /// mtimes; an editor saving on top of an autosave from a tool a
    /// few hundred ms earlier would silently win. Ns resolution
    /// catches that. On filesystems that only carry seconds (FAT,
    /// some SMB mounts), `mtime_ns` is the seconds value times 1e9
    /// and the check degrades gracefully.
    ///
    /// Conventions for `expected_mtime_ns`:
    ///   - `None` + missing file: create.
    ///   - `None` + existing file: `WriteConflict`. The caller did
    ///     not know a file was there; treating that as a silent
    ///     overwrite would be the bug we're trying to prevent.
    ///   - `Some(m)` + current mtime_ns == m: write.
    ///   - any other case: `WriteConflict { current_mtime_ns }`.
    ///
    /// Residual race: between the mtime check and the atomic rename,
    /// another writer can land. The window is small (no syscalls
    /// between the two) and the next watcher event will surface the
    /// foreign change so the editor can re-prompt. Callers that need
    /// stronger semantics must serialize at a higher level.
    pub fn write_text_if_unchanged(
        &self,
        rel: &str,
        expected_mtime_ns: Option<i64>,
        content: &str,
    ) -> Result<()> {
        if !self.editable_text_gate(rel) {
            return Err(ChanError::NotEditableText(rel.to_string()));
        }
        let writable = self.ensure_writable(rel)?;
        let (current, exists) = match writable.stat.as_ref() {
            Some(stat) => (stat.mtime_ns, true),
            None => (None, false),
        };
        let conflict = match (expected_mtime_ns, exists) {
            (None, false) => false,
            (Some(m), true) => current != Some(m),
            _ => true,
        };
        if conflict {
            return Err(ChanError::WriteConflict {
                current_mtime_ns: current,
            });
        }
        self.write_atomic_stream(rel, AtomicWriteKind::Text, |sink| {
            sink.write_chunk(content.as_bytes())
        })
        .map(|_| ())
    }

    /// Atomically write raw bytes. Text-class targets still require
    /// valid UTF-8 so a binary upload cannot later be rendered by
    /// the editor as markdown or source text. Same special-file
    /// refusal as `write_text`.
    pub fn write_bytes(&self, rel: &str, content: &[u8]) -> Result<()> {
        self.write_atomic_stream(rel, AtomicWriteKind::Bytes, |sink| {
            sink.write_chunk(content)
        })
        .map(|_| ())
    }

    /// True iff the path resolves under the workspace and refers to a
    /// regular file. Matches the gate `read` / `read_text` apply,
    /// so a `true` return is a strong signal that a read will
    /// succeed.
    pub fn exists(&self, rel: &str) -> bool {
        let Ok((dir, rel_path)) = self.resolve_io(rel) else {
            return false;
        };
        match dir.symlink_metadata(&rel_path) {
            Ok(m) => m.is_file() && !m.file_type().is_symlink(),
            Err(_) => false,
        }
    }

    /// True iff the path resolves under the workspace and refers to a
    /// directory (not a symlink, which `lstat` reports as non-directory).
    /// `resolve_link` uses it to route a link that points at a folder to
    /// the file browser instead of the text editor.
    pub fn is_dir(&self, rel: &str) -> bool {
        let Ok((dir, rel_path)) = self.resolve_io(rel) else {
            return false;
        };
        match dir.symlink_metadata(&rel_path) {
            Ok(m) => m.is_dir(),
            Err(_) => false,
        }
    }

    /// Stat the path using `lstat` semantics (so a symlink reports
    /// as such, not as its target). Refuses paths that escape the
    /// workspace root through a mid-path symlink. Drafts under
    /// `<drafts_dir_name>/...` resolve through the workspace-root
    /// handle like any other in-tree path.
    pub fn stat(&self, rel: &str) -> Result<FileStat> {
        let (dir, rel_path) = self.resolve_io(rel)?;
        let meta = dir
            .symlink_metadata(&rel_path)
            .map_err(|e| ChanError::Io(e.to_string()))?;
        Ok(FileStat {
            size: if meta.is_dir() { 0 } else { meta.len() },
            mtime: mtime_secs_cap(&meta),
            mtime_ns: mtime_ns_cap(&meta),
            is_dir: meta.is_dir(),
        })
    }

    /// One-level directory listing. Use `list_tree` for the
    /// recursive variant. Skips workspace-internal noise (`.chan/`,
    /// `.git/`) at the top level and drops special entries (FIFOs,
    /// sockets, devices) at every level. Symlinks stay visible to
    /// the browser and are classified by the server-side wire view.
    /// Errors with `ListingTooLarge` past `LIST_DIR_LIMIT`.
    ///
    /// Per-entry errors (a vanished entry mid-iteration, a
    /// permission denied on stat) are logged at warn and the entry
    /// is skipped rather than aborting the listing. Without the log
    /// the editor's tree view would silently miss entries and the
    /// user has no signal anything went wrong; with it, the issue
    /// shows up in `tracing` output and the indexer / status surface
    /// can act on the count later if needed.
    pub fn list(&self, rel: &str) -> Result<Vec<DirEntry>> {
        let at_root = rel.is_empty() || rel == "." || rel == "/";
        // Drafts are real in-root files under `<drafts_dir_name>/...`,
        // so `.Drafts/<name>` lists through the workspace-root handle
        // like any other path.
        let read = if at_root {
            self.dir
                .read_dir(".")
                .map_err(|e| ChanError::Io(e.to_string()))?
        } else {
            let rel_path = self.rel(rel)?;
            self.dir
                .read_dir(&rel_path)
                .map_err(|e| ChanError::Io(e.to_string()))?
        };
        let mut out = Vec::new();
        let mut skipped = 0usize;
        for entry in read {
            if out.len() >= fs_ops::LIST_DIR_LIMIT {
                return Err(ChanError::ListingTooLarge {
                    observed: out.len(),
                    limit: fs_ops::LIST_DIR_LIMIT,
                });
            }
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    tracing::warn!(?rel, ?e, "list: read_dir entry error; skipping");
                    skipped += 1;
                    continue;
                }
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if at_root && (name == ".chan" || name == ".git") {
                continue;
            }
            let ft = match entry.file_type() {
                Ok(ft) => ft,
                Err(e) => {
                    tracing::warn!(?rel, ?name, ?e, "list: file_type failed; skipping");
                    skipped += 1;
                    continue;
                }
            };
            if !(ft.is_dir() || ft.is_symlink() || ft.is_file()) {
                continue;
            }
            out.push(DirEntry {
                name,
                is_dir: ft.is_dir(),
            });
        }
        if skipped > 0 {
            tracing::warn!(
                ?rel,
                skipped,
                returned = out.len(),
                "list: directory listing partial",
            );
        }
        Ok(out)
    }

    pub fn list_tree(&self) -> Result<Vec<TreeEntry>> {
        fs_ops::list_tree(self.root())
    }

    /// Recursive listing in chan's public namespace. Drafts now live
    /// in-root under `<drafts_dir_name>/...`, so the plain `list_tree`
    /// walk already surfaces them; this is a thin alias kept for the
    /// chan-server callers that still address the unified view.
    pub fn list_tree_unified(&self) -> Result<Vec<TreeEntry>> {
        self.list_tree()
    }

    /// Subtree variant of `list_tree`: walk only the descendants of
    /// `prefix` instead of the entire workspace. Returned `TreeEntry.path`
    /// values stay relative to the workspace root, so the caller sees the
    /// same shape as `list_tree`. The prefix entry itself is included
    /// (file: one entry; directory: that directory plus its descendants).
    ///
    /// Same gates as the rest of the Workspace API: `resolve_safe_strict`
    /// rejects `..` traversal and mid-path symlinks pointing outside
    /// the workspace. A non-existent prefix returns `Ok(vec![])` rather
    /// than an error, so model-driven `list_files(prefix=...)` calls
    /// gracefully report an empty listing for typos instead of
    /// surfacing a hard failure.
    ///
    /// Performance: walks only the requested subtree, so on a workspace
    /// with hundreds of thousands of files a narrow prefix returns
    /// promptly. Use `list_tree` when the caller actually wants the
    /// whole workspace.
    pub fn list_tree_prefix(&self, prefix: &str) -> Result<Vec<TreeEntry>> {
        let resolved = fs_ops::resolve_safe_strict(self.root(), prefix)?;
        fs_ops::list_tree_prefix(self.root(), &resolved)
    }

    /// Subtree variant of `list_tree_unified`. Drafts live in-root
    /// under `<drafts_dir_name>/...`, so a `.Drafts/...` prefix walks
    /// the workspace tree like any other prefix.
    pub fn list_tree_prefix_unified(&self, prefix: &str) -> Result<Vec<TreeEntry>> {
        self.list_tree_prefix(prefix.trim_matches('/'))
    }

    /// Filtered counterpart of `list_tree_unified`. Applies the
    /// per-workspace `WalkFilter` so blocklisted dirs (`node_modules/`,
    /// `target/`, `venv/`, ...) are excluded, matching the index and
    /// the File Browser spine. The graph layer uses this so the
    /// semantic graph does not surface dependency trees as nodes. The
    /// raw `list_tree_unified` stays unfiltered for the editor's
    /// on-demand open-inside-a-noisy-dir path.
    pub fn list_tree_filtered_unified(&self) -> Result<Vec<TreeEntry>> {
        let policy = self.scope_policy();
        fs_ops::list_tree_scoped(self.root(), &policy)
    }

    /// Filtered counterpart of `list_tree_prefix_unified`. Drafts live
    /// in-root, so a `.Drafts/...` prefix prunes the per-workspace
    /// `WalkFilter` dirs like any other prefix.
    pub fn list_tree_prefix_filtered_unified(&self, prefix: &str) -> Result<Vec<TreeEntry>> {
        let trimmed = prefix.trim_matches('/');
        let resolved = fs_ops::resolve_safe_strict(self.root(), trimmed)?;
        let policy = self.scope_policy();
        fs_ops::list_tree_prefix_scoped(self.root(), &resolved, &policy)
    }

    pub fn create_dir(&self, rel: &str) -> Result<()> {
        let rel_path = self.rel(rel)?;
        self.dir
            .create_dir_all(&rel_path)
            .map_err(|e| ChanError::Io(e.to_string()))?;
        Ok(())
    }

    /// Soft-delete a file or directory: move it into the per-workspace
    /// trash. `trash_list` / `trash_restore` / `trash_purge` /
    /// `trash_empty` operate on the trash. Expired entries are
    /// GC'd lazily on `Workspace::open` and on every `trash_*` call;
    /// retention is `TRASH_RETENTION_SECS` (30 days at v1).
    ///
    /// Accepted: regular files and real directories (recursively;
    /// the foot-gun guard against recursive delete is satisfied by
    /// the soft-delete + restore path). Rejected with `SpecialFile`:
    /// symlinks, FIFOs, sockets, char/block devices. Users who
    /// really want those gone can `rm` them out-of-band.
    pub fn remove(&self, rel: &str) -> Result<()> {
        let rel_path = self.rel(rel)?;
        // cap-std lstat: TOCTOU-free type check. The subsequent
        // trash::move_into still operates path-based (it has to
        // bridge into the trash dir which lives outside the cap-std
        // Workspace sandbox), so the rename itself has a small residual
        // TOCTOU window. The damage if exploited is "wrong file
        // goes to trash" - recoverable via `trash_restore`.
        let meta = self
            .dir
            .symlink_metadata(&rel_path)
            .map_err(|e| ChanError::Io(e.to_string()))?;
        let ft = meta.file_type();
        let is_dir = ft.is_dir();
        let is_regular_file = ft.is_file() && !ft.is_symlink();
        let abs = self.entry.root_path.join(&rel_path);
        if !(is_dir || is_regular_file) {
            return Err(ChanError::SpecialFile {
                kind: describe_cap_file_kind(&ft).to_string(),
                path: abs,
            });
        }
        // Snapshot every editable-text path under `rel` BEFORE the
        // trash move so the search index has a deterministic delete
        // set. After the move the source paths are gone and a walk
        // would miss them. Non-editable files (images, PDFs) aren't
        // in BM25 / the vector store, so they're skipped here; the
        // graph cleanup below clears their inbound edges via the
        // prefix delete.
        let indexed_paths = self.collect_indexed_paths_for_remove(&abs, rel, is_dir);
        let _ = trash::sweep_expired(&self.paths.trash, TRASH_RETENTION_SECS);
        trash::move_into(&self.paths.trash, &abs, rel, is_dir)?;
        // Best-effort post-move cleanup. The user-visible operation
        // (file disappears, restorable from trash) has already
        // succeeded; failures here would only leave stale rows that
        // the next reindex sweeps away, so they're logged not
        // returned. Order: graph first (a stale BM25 hit pointing at
        // a node-less path is recoverable when the user clicks
        // through; a stale graph row pointing at a no-longer-indexed
        // file is the cosmetic ghost).
        self.cleanup_after_remove(rel, &indexed_paths);
        Ok(())
    }

    /// Walk the (still-present) target of a `remove` and collect
    /// the editable-text paths the search index needs to drop. For
    /// a single file this collapses to `[rel]` when editable; for a
    /// directory it walks the subtree, applying the same `.git/` /
    /// `.chan/` filter as the rest of the crate.
    fn collect_indexed_paths_for_remove(
        &self,
        abs: &std::path::Path,
        rel: &str,
        is_dir: bool,
    ) -> Vec<String> {
        if !is_dir {
            return if fs_ops::is_indexable_text(rel) {
                vec![rel.to_string()]
            } else {
                Vec::new()
            };
        }
        let mut out = Vec::new();
        // Filtered so we don't waste time collecting paths under
        // `node_modules/` etc. that were never indexed in the first
        // place; symmetric with the filtered index/graph build.
        let policy = self.scope_policy();
        for entry in fs_ops::walk_workspace_scoped(abs, &policy) {
            if !entry.file_type().is_file() {
                continue;
            }
            let rel_path = match entry.path().strip_prefix(&self.entry.root_path) {
                Ok(p) => p.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };
            if fs_ops::is_indexable_text(&rel_path) {
                out.push(rel_path);
            }
        }
        out
    }

    /// Drop graph rows and search-index entries for a path that
    /// `remove` just trashed. Best-effort: `graph()` / `index()` may
    /// not be initialized yet (a remove on a never-opened workspace), or
    /// the underlying store may transiently fail. We log and move on;
    /// the next reindex is the safety net.
    fn cleanup_after_remove(&self, rel: &str, indexed_paths: &[String]) {
        match self.graph() {
            Ok(g) => {
                if let Err(e) = g.forget_under(rel) {
                    tracing::warn!(rel, ?e, "remove: graph forget_under failed");
                }
            }
            Err(e) => {
                tracing::warn!(rel, ?e, "remove: graph unavailable, skipping cleanup");
            }
        }
        if indexed_paths.is_empty() {
            return;
        }
        match self.index() {
            Ok(idx) => {
                if let Err(e) = idx.forget_many(indexed_paths) {
                    tracing::warn!(
                        rel,
                        count = indexed_paths.len(),
                        ?e,
                        "remove: index forget_many failed",
                    );
                }
            }
            Err(e) => {
                tracing::warn!(rel, ?e, "remove: index unavailable, skipping cleanup");
            }
        }
    }

    /// List trashed entries for this workspace, most-recent-first.
    pub fn trash_list(&self) -> Result<Vec<TrashEntry>> {
        let _ = trash::sweep_expired(&self.paths.trash, TRASH_RETENTION_SECS);
        trash::list(&self.paths.trash)
    }

    /// Restore a trashed entry to its original path. Errors with
    /// `TrashOccupied` if the destination already exists; the caller
    /// can rename the live entry first or `trash_purge` the trash
    /// entry to give up.
    ///
    /// After the filesystem restore lands, the graph and search
    /// index are repopulated for every editable-text path that came
    /// back (`remove` cleared them on the way into trash, so this is
    /// the symmetric step). Cleanup of stale entries is best-effort
    /// for the same reason as in `remove`: the trash op already
    /// succeeded from the user's view, and a missed re-index falls
    /// back to the next reindex pass.
    pub fn trash_restore(&self, id: &str) -> Result<()> {
        let _ = trash::sweep_expired(&self.paths.trash, TRASH_RETENTION_SECS);
        let restored = trash::restore(&self.paths.trash, self.root(), &self.root_canon, id)?;
        self.reindex_after_restore(&restored);
        Ok(())
    }

    /// Walk the freshly-restored target and feed every editable-text
    /// path back into the graph + search index. Best-effort: a
    /// failure here leaves the file on disk but absent from indexes,
    /// which the next reindex rebuilds. We don't propagate the error
    /// because the user's intent ("undo my delete") already
    /// succeeded at the filesystem level.
    fn reindex_after_restore(&self, restored: &trash::RestoredEntry) {
        let abs = self.entry.root_path.join(&restored.rel_path);
        let is_dir = restored.is_dir;
        if !is_dir {
            if !fs_ops::is_indexable_text(&restored.rel_path) {
                return;
            }
            if let Err(e) = self.index_file(&restored.rel_path) {
                tracing::warn!(rel = %restored.rel_path, ?e, "restore: index_file failed");
            }
            return;
        }
        // Filtered so restoring a directory that happens to contain a
        // `node_modules/` / `target/` subtree does not re-index a
        // dependency tree the index deliberately excludes.
        let policy = self.scope_policy();
        for entry in fs_ops::walk_workspace_scoped(&abs, &policy) {
            if !entry.file_type().is_file() {
                continue;
            }
            let rel_path = match entry.path().strip_prefix(&self.entry.root_path) {
                Ok(p) => p.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };
            if !fs_ops::is_indexable_text(&rel_path) {
                continue;
            }
            if let Err(e) = self.index_file(&rel_path) {
                tracing::warn!(rel = %rel_path, ?e, "restore: index_file failed");
            }
        }
    }

    /// Permanently delete a single trash entry.
    pub fn trash_purge(&self, id: &str) -> Result<()> {
        let _ = trash::sweep_expired(&self.paths.trash, TRASH_RETENTION_SECS);
        trash::purge_one(&self.paths.trash, id)
    }

    /// Permanently delete every trash entry for this workspace.
    pub fn trash_empty(&self) -> Result<()> {
        trash::purge_all(&self.paths.trash)
    }

    // ---- drafts ----
    //
    // In-root Drafts folder. Lives in `<root>/<drafts_dir_name>/`
    // (default `.Drafts`), holds in-progress drafts as directories so
    // users can paste images / drop config files alongside `draft.md`.
    // Because the directory is inside the workspace root, drafts are
    // real files the normal walk / index / watch already cover; the
    // directory materializes lazily on the first `create_draft_dir`.

    /// In-root drafts directory absolute path
    /// (`<root>/<drafts_dir_name>`). May not exist on disk until the
    /// first `create_draft_dir` lazily creates it.
    pub fn drafts_dir(&self) -> &std::path::Path {
        &self.drafts_root
    }

    /// Configured in-root drafts directory name (single path segment,
    /// e.g. `.Drafts`). chan-server composes public draft paths as
    /// `<drafts_dir_name>/<name>/draft.md` from this.
    pub fn drafts_dir_name(&self) -> &str {
        &self.drafts_dir_name
    }

    /// Create a draft directory by name (e.g. `"untitled-1"`).
    /// Returns a handle with the leaf name + absolute path. Errors
    /// when the name contains a path separator / traversal segment /
    /// already exists. Lazily creates the in-root drafts directory
    /// first; this is the only place `<root>/<drafts_dir_name>` is
    /// materialized.
    pub fn create_draft_dir(&self, name: &str) -> Result<DraftRef> {
        self.ensure_root_available()?;
        drafts::validate_name(name)?;
        let drafts_rel = std::path::Path::new(&self.drafts_dir_name);
        let rel = drafts_rel.join(name);
        let abs = self.drafts_root.join(name);
        // Create relative to the retained capability so a concurrent
        // `rm -rf <root>` cannot recreate the absolute workspace pathname.
        // The postcondition turns an otherwise-successful orphaned create into
        // the shared typed root-loss error.
        self.dir.create_dir_all(drafts_rel).map_err(|error| {
            ChanError::Io(format!(
                "failed to create drafts directory {}: {error}",
                self.drafts_root.display()
            ))
        })?;
        self.dir.create_dir(&rel).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                ChanError::Io(format!(
                    "draft `{name}` already exists at {}",
                    abs.display()
                ))
            } else {
                ChanError::Io(format!(
                    "failed to create draft directory {}: {error}",
                    abs.display()
                ))
            }
        })?;
        self.ensure_root_available()?;
        Ok(DraftRef {
            name: name.to_string(),
            abs,
        })
    }

    /// Enumerate drafts. Sorted by name. Empty when the drafts
    /// directory does not exist yet. Skips stray non-directory
    /// entries silently.
    pub fn list_drafts(&self) -> Result<Vec<DraftRef>> {
        drafts::list(&self.drafts_root)
    }

    /// Inspect drafts and report non-fatal problems that should be
    /// surfaced on workspace boot.
    pub fn draft_preflight(&self) -> Result<Vec<drafts::DraftIssue>> {
        drafts::preflight(&self.drafts_root)
    }

    /// Inspect a draft before save or discard.
    pub fn inspect_draft(&self, name: &str) -> Result<drafts::DraftInspection> {
        drafts::inspect(&self.drafts_root, name)
    }

    /// Move a draft to metadata trash.
    pub fn discard_draft(&self, name: &str) -> Result<()> {
        drafts::discard(&self.drafts_root, &self.paths.trash.join("drafts"), name)
    }

    /// Promote a draft into the workspace root with no-clobber
    /// semantics. Single-file drafts move their primary file (a note's
    /// `draft.md` or a diagram's `<name>.excalidraw`) to `target_rel`;
    /// directory drafts move or merge the whole draft directory into the
    /// target directory.
    pub fn promote_draft(
        &self,
        name: &str,
        target_rel: &str,
    ) -> Result<drafts::DraftPromoteReport> {
        drafts::promote(
            &self.drafts_root,
            self.root(),
            &self.root_canon,
            name,
            target_rel,
        )
    }

    /// Pick the smallest unused `untitled-N` name under the drafts
    /// directory. Returns `"untitled"` on the first call (no
    /// `untitled` dir exists); `"untitled-1"` if `untitled` is taken;
    /// `"untitled-2"` if both are taken; etc. The caller composes the
    /// full path (e.g. `format!("{}/{name}/draft.md",
    /// workspace.drafts_dir_name())`) when calling
    /// `Workspace::write_text`. Race-window note: two concurrent
    /// callers can both observe the same gap and race on
    /// `create_draft_dir`; the loser's `create_draft_dir` errors
    /// with `AlreadyExists` and the caller can retry.
    pub fn next_untitled_draft_name(&self) -> Result<String> {
        let existing = self.list_drafts()?;
        let names: std::collections::HashSet<&str> =
            existing.iter().map(|d| d.name.as_str()).collect();
        if !names.contains("untitled") {
            return Ok("untitled".to_string());
        }
        let mut i: u32 = 1;
        loop {
            let candidate = format!("untitled-{i}");
            if !names.contains(candidate.as_str()) {
                return Ok(candidate);
            }
            i += 1;
        }
    }

    // ---- session blobs ----
    //
    // Per-window opaque JSON owned by the host (window/pane
    // layout, active tabs, scroll positions). chan-workspace stores
    // bytes; the host decides the schema. Native shells link these
    // via uniffi and avoid reimplementing the atomic-write story
    // per platform.

    /// Atomically write `content` to the session bucket under
    /// `key`. Bucket dir is created on first call.
    pub fn put_session(&self, key: &str, content: &[u8]) -> Result<()> {
        crate::blob::put(&self.paths.sessions, key, content)
    }

    /// Read a session blob; returns `Ok(None)` when missing.
    pub fn get_session(&self, key: &str) -> Result<Option<Vec<u8>>> {
        crate::blob::get(&self.paths.sessions, key)
    }

    /// Sorted flat session keys for this workspace.
    pub fn list_sessions(&self) -> Result<Vec<String>> {
        crate::blob::list(&self.paths.sessions)
    }

    /// Idempotent delete; missing key is `Ok(())`.
    pub fn delete_session(&self, key: &str) -> Result<()> {
        crate::blob::delete(&self.paths.sessions, key)
    }

    /// Write one markdown note per `Contact` into `dir` (workspace-
    /// relative; created if missing). Each note carries nested
    /// `chan: { kind: contact }` frontmatter so downstream consumers
    /// (graph builder, editor `@` picker) can classify it without a
    /// separate index. Path collisions are handled per `opts`:
    /// either skipped or overwritten.
    ///
    /// All writes go through `write_text`, so the path sandbox,
    /// editable-text gate, and atomic-rename rules apply per file.
    /// One bad contact does not abort the batch; per-file errors
    /// land in the returned `ImportSummary` as `Failed`.
    pub fn import_contacts(
        &self,
        dir: &str,
        contacts: Vec<crate::contacts::Contact>,
        opts: crate::contacts::ImportOpts,
    ) -> Result<crate::contacts::ImportSummary> {
        self.import_contacts_with(dir, contacts, opts, &crate::progress::NoProgress)
    }

    /// `import_contacts` plus a `ProgressCallback`. Fires one
    /// `ProgressStage::Import` event per contact processed (wrote /
    /// overwrote / skipped / failed), with `current` / `total`
    /// counting through the input vec. The CLI's `chan workspace contacts
    /// import` uses this to show live status; the no-arg version is
    /// fine for scripted callers that just want the summary.
    pub fn import_contacts_with(
        &self,
        dir: &str,
        contacts: Vec<crate::contacts::Contact>,
        opts: crate::contacts::ImportOpts,
        progress: &dyn crate::progress::ProgressCallback,
    ) -> Result<crate::contacts::ImportSummary> {
        crate::contacts::import::run(self, dir, contacts, opts, progress)
    }

    pub fn rename(&self, from: &str, to: &str) -> Result<()> {
        let from_rel = self.rel(from)?;
        let to_rel = self.rel(to)?;
        // Source must exist as a regular file or directory; refuse
        // to move a symlink or special file. (renaming a symlink
        // is well-defined at the syscall level but not something
        // the editor should ever do silently.)
        let src_meta = self
            .dir
            .symlink_metadata(&from_rel)
            .map_err(|e| ChanError::Io(e.to_string()))?;
        let src_ft = src_meta.file_type();
        if !(src_ft.is_dir() || (src_ft.is_file() && !src_ft.is_symlink())) {
            return Err(ChanError::SpecialFile {
                kind: describe_cap_file_kind(&src_ft).to_string(),
                path: self.entry.root_path.join(&from_rel),
            });
        }
        self.ensure_writable(to)?;
        if let Some(parent) = to_rel.parent() {
            if !parent.as_os_str().is_empty() {
                self.dir
                    .create_dir_all(parent)
                    .map_err(|e| ChanError::Io(e.to_string()))?;
            }
        }
        // cap-std rename within the same Dir is TOCTOU-free: source
        // and destination resolve through the dir handle, no
        // path-walk through swappable ancestors.
        self.dir
            .rename(&from_rel, &self.dir, &to_rel)
            .map_err(|e| ChanError::Io(e.to_string()))?;
        Ok(())
    }

    /// Copy a regular file or a directory subtree from `from` to `to`,
    /// both workspace-rooted POSIX paths. Unlike `rename` this DUPLICATES:
    /// the source is left untouched and no inbound links are rewritten
    /// (a copy creates new files with their own future identity; the
    /// next reindex picks up whatever links the copies carry).
    ///
    /// Invariants matched to `rename`:
    ///   * Source must be a regular file or a directory; a symlink or
    ///     other special file is refused (`SpecialFile`). Inside a
    ///     subtree copy, any special-file descendant is refused too, so
    ///     a copy can never materialize a symlink/device under the
    ///     workspace.
    ///   * `.chan/`, `.git/`, `.hg/` are skipped inside a subtree copy
    ///     (the same control dirs the walk filter and rename never
    ///     touch); copying them would duplicate VCS / app metadata.
    ///   * Each file write goes through `atomic_write_in` (the same
    ///     atomic + parent-fsync path every user write uses) and honors
    ///     the editable-text UTF-8 gate.
    ///
    /// `to` must NOT already exist (the caller resolves a free name
    /// first via `resolve_free_name` for paste-collision handling).
    ///
    /// Returns the list of created destination paths (workspace-rooted
    /// POSIX), so the server can note them as self-writes and the UI /
    /// graph can react. Sorted for stable diffs.
    pub fn copy(&self, from: &str, to: &str) -> Result<CopyOutcome> {
        let from_rel = self.rel(from)?;
        let to_rel = self.rel(to)?;
        let src_meta = self
            .dir
            .symlink_metadata(&from_rel)
            .map_err(|e| ChanError::Io(e.to_string()))?;
        let src_ft = src_meta.file_type();
        if src_ft.is_symlink() || !(src_ft.is_dir() || src_ft.is_file()) {
            return Err(ChanError::SpecialFile {
                kind: describe_cap_file_kind(&src_ft).to_string(),
                path: self.entry.root_path.join(&from_rel),
            });
        }
        // Refuse to clobber: paste-collision resolution happens in the
        // server (it picks a free name); a bare copy onto an existing
        // path is a programming error, not a silent overwrite.
        if self.dir.symlink_metadata(&to_rel).is_ok() {
            return Err(ChanError::Io(format!(
                "copy destination already exists: {to}"
            )));
        }
        let to_canon = canonical_posix(to);
        let mut created = Vec::new();
        if src_ft.is_file() {
            self.copy_one_file(&from_rel, &to_rel, &to_canon, &mut created)?;
        } else {
            // Create the destination root dir, then walk descendants.
            self.dir
                .create_dir_all(&to_rel)
                .map_err(|e| ChanError::Io(e.to_string()))?;
            self.copy_subtree(&from_rel, &to_rel, &to_canon, &mut created)?;
        }
        created.sort();
        Ok(CopyOutcome { created })
    }

    /// Copy one regular file from `src_rel` to `dst_rel` (both relative
    /// to `self.dir`), recording the destination's workspace-rooted POSIX
    /// path in `created`.
    fn copy_one_file(
        &self,
        src_rel: &std::path::Path,
        dst_rel: &std::path::Path,
        dst_canon: &str,
        created: &mut Vec<String>,
    ) -> Result<()> {
        let bytes = {
            use std::io::Read;
            let mut f = self
                .dir
                .open(src_rel)
                .map_err(|e| ChanError::Io(e.to_string()))?;
            let mut buf = Vec::new();
            f.read_to_end(&mut buf)?;
            buf
        };
        // Mirror write_bytes' editable-text UTF-8 gate so a copy can
        // never land non-UTF-8 bytes in an editable-text path.
        let dst_str = dst_rel.to_string_lossy();
        if fs_ops::is_editable_text(&dst_str) && std::str::from_utf8(&bytes).is_err() {
            return Err(ChanError::Io(format!(
                "refusing to copy non-UTF-8 bytes to editable text file: {dst_str}"
            )));
        }
        if let Some(parent) = dst_rel.parent() {
            if !parent.as_os_str().is_empty() {
                self.dir
                    .create_dir_all(parent)
                    .map_err(|e| ChanError::Io(e.to_string()))?;
            }
        }
        fs_ops::atomic_write_in(&self.dir, dst_rel, &bytes)?;
        created.push(dst_canon.to_string());
        Ok(())
    }

    /// Recursively copy the contents of directory `src_rel` into the
    /// already-created `dst_rel`. Skips control dirs; refuses special
    /// files; recreates child directories before copying their files.
    fn copy_subtree(
        &self,
        src_rel: &std::path::Path,
        dst_rel: &std::path::Path,
        dst_canon: &str,
        created: &mut Vec<String>,
    ) -> Result<()> {
        let read = self
            .dir
            .read_dir(src_rel)
            .map_err(|e| ChanError::Io(e.to_string()))?;
        for entry in read {
            let entry = entry.map_err(|e| ChanError::Io(e.to_string()))?;
            let name = entry.file_name();
            let name_str = name.to_string_lossy().to_string();
            // Skip VCS / app control dirs: never duplicate them.
            if matches!(name_str.as_str(), ".chan" | ".git" | ".hg") {
                continue;
            }
            let ft = entry
                .file_type()
                .map_err(|e| ChanError::Io(e.to_string()))?;
            let child_src = src_rel.join(&name);
            let child_dst = dst_rel.join(&name);
            let child_dst_canon = format!("{dst_canon}/{name_str}");
            if ft.is_symlink() || !(ft.is_dir() || ft.is_file()) {
                return Err(ChanError::SpecialFile {
                    kind: describe_cap_file_kind(&ft).to_string(),
                    path: self.entry.root_path.join(&child_src),
                });
            }
            if ft.is_dir() {
                self.dir
                    .create_dir_all(&child_dst)
                    .map_err(|e| ChanError::Io(e.to_string()))?;
                self.copy_subtree(&child_src, &child_dst, &child_dst_canon, created)?;
            } else {
                self.copy_one_file(&child_src, &child_dst, &child_dst_canon, created)?;
            }
        }
        Ok(())
    }

    /// Resolve a non-colliding destination path for pasting `name` into
    /// directory `dest_dir` (workspace-rooted POSIX). If `dest_dir/name` is
    /// free it is returned as-is; otherwise a Finder-style " copy" /
    /// " copy 2" suffix is inserted before the extension until a free
    /// name is found. Used by the server's paste handler so copy AND
    /// cut-into-a-name-collision both resolve to a fresh name rather
    /// than overwriting (we never silently clobber).
    ///
    /// The check is best-effort against the live tree; the actual write
    /// (copy / rename) is the TOCTOU-authoritative step and will fail on
    /// a lost race, at which point the caller can retry with the next
    /// suffix.
    pub fn resolve_free_name(&self, dest_dir: &str, name: &str) -> Result<String> {
        let base_dir = canonical_posix(dest_dir);
        let prefix = if base_dir.is_empty() {
            String::new()
        } else {
            format!("{base_dir}/")
        };
        let (stem, ext) = split_name_ext(name);
        let mut candidate = format!("{prefix}{name}");
        if !self.path_exists_any(&candidate) {
            return Ok(candidate);
        }
        // First collision uses " copy", then " copy 2", " copy 3", ...
        let mut n = 1u32;
        loop {
            let suffixed = if n == 1 {
                format!("{stem} copy{ext}")
            } else {
                format!("{stem} copy {n}{ext}")
            };
            candidate = format!("{prefix}{suffixed}");
            if !self.path_exists_any(&candidate) {
                return Ok(candidate);
            }
            n += 1;
            if n > 10_000 {
                return Err(ChanError::Io(format!(
                    "could not find a free name for {name} in {dest_dir}"
                )));
            }
        }
    }

    /// Existence check for collision resolution: true if a file OR
    /// directory (or any non-regular node) occupies `rel`.
    fn path_exists_any(&self, rel: &str) -> bool {
        let Ok(rel_path) = self.rel(rel) else {
            return false;
        };
        self.dir.symlink_metadata(&rel_path).is_ok()
    }

    /// Rename a file or directory and rewrite every inbound link
    /// affected by the move. Atomicity is per-file: the rename is one
    /// filesystem op, then each affected source is rewritten via a
    /// CAS write so concurrent edits surface as a recorded conflict
    /// rather than a silent overwrite. The rename itself stands even
    /// if some rewrites fail; the link-rewrite pass is idempotent and
    /// can be retried later.
    ///
    /// What gets rewritten:
    ///   * `[label](href)` and `![alt](src)` whose normalized target
    ///     (resolved against the source file's pre-rename directory)
    ///     matches an old path that moved.
    ///   * `[[target]]` and `[[target|label]]` wiki links.
    ///   * Sources that were themselves inside the renamed subtree:
    ///     their outgoing relative links may need re-relativization
    ///     even when the target itself did not move, because the
    ///     source's directory changed.
    ///
    /// What does NOT get rewritten:
    ///   * Reference-style links (`[label][ref]` + `[ref]: url`).
    ///   * Bare autolinks (`<https://...>`).
    ///   * Any link with no graph backlink to the moved target. The
    ///     graph is the index of "what points where" and is built by
    ///     `reindex`; a freshly-added link landed since the last
    ///     reindex will not be picked up here. The next reindex pass
    ///     restores accuracy.
    ///
    /// On a stale graph (a freshly-renamed file whose backlinks were
    /// indexed before this call) this method behaves correctly: the
    /// graph still records edges by pre-rename target paths, which is
    /// exactly the lookup key we want.
    pub fn rename_with_link_rewrite(&self, from: &str, to: &str) -> Result<RenameOutcome> {
        self.rename_with_link_rewrite_with(from, to, &crate::progress::NoProgress)
    }

    /// `rename_with_link_rewrite` plus a `ProgressCallback`. One
    /// `ProgressStage::RenameRewrite` event fires per source file
    /// the rewriter visits, with `current` / `total` counting
    /// progress through the sorted source list. The split lets a
    /// directory rename of a 5k-file tree show live status in the
    /// editor instead of looking frozen.
    pub fn rename_with_link_rewrite_with(
        &self,
        from: &str,
        to: &str,
        progress: &dyn crate::progress::ProgressCallback,
    ) -> Result<RenameOutcome> {
        use crate::progress::{ProgressEvent, ProgressStage};
        // Snapshot mapping BEFORE the rename so the file walker sees
        // the subtree in its old location. Empty mapping is fine
        // (e.g., directory rename with no descendants) and means the
        // rewrite pass is a no-op.
        let from_canon = canonical_posix(from);
        let to_canon = canonical_posix(to);
        let mapping = self.snapshot_rename_mapping(&from_canon, &to_canon)?;

        // Single rename op. From here on the on-disk tree reflects the
        // new layout; the graph is intentionally still stale (rebuilt
        // by the indexer later) and we use that staleness on purpose.
        self.rename(from, to)?;

        if mapping.is_empty() {
            self.rename_log_append(&from_canon, &to_canon);
            return Ok(RenameOutcome {
                renamed: vec![(from_canon, to_canon)],
                rewritten: vec![],
                conflicts: vec![],
            });
        }

        // Effective mapping = prior rename log + this rename. The log
        // captures any moves since the last reindex; combining it with
        // this rename's pairs lets us:
        //   * Translate graph src columns (frozen at last reindex) to
        //     each source's current on-disk location, so a file moved
        //     in a prior rename still gets its outgoing links rewritten
        //     when a later rename touches one of its outgoing targets.
        //   * Translate stale link text whose target moved in a prior
        //     rename to the new current path, so a link that points to
        //     a path no longer on disk still rewrites correctly when
        //     it's brought back into scope by this rename.
        let mut effective: HashMap<String, String> = self.rename_log.lock().unwrap().clone();
        for (old, new) in &mapping {
            // Transitive close: anything previously redirected at `old`
            // now redirects at `new`.
            for v in effective.values_mut() {
                if v == old {
                    *v = new.clone();
                }
            }
            effective.insert(old.clone(), new.clone());
        }

        // Wiki-link targets are stored in the graph extensionless
        // (`[[old]]` -> dst "old"), per chan's wiki convention. The
        // markdown rewriter resolves them the same way; `normalize_href`
        // returns the bare stem. Augment the effective mapping with
        // extensionless pairs so both backlinks lookups and the rewrite
        // callback succeed for either form.
        let mut augmented = effective.clone();
        for (old, new) in &effective {
            if let (Some(old_stem), Some(new_stem)) =
                (old.strip_suffix(".md"), new.strip_suffix(".md"))
            {
                augmented.insert(old_stem.to_string(), new_stem.to_string());
            }
        }

        // Collect source files that need a rewrite pass. Two sources of
        // candidates:
        //   1. Backlinks into the (cumulative) renamed set. The graph's
        //      src column is keyed by the path at last-index time; we
        //      translate it through `effective` to find the source's
        //      current on-disk location.
        //   2. Every file that moved in THIS rename. Its outgoing
        //      relative links may need re-relativization because the
        //      source's directory changed, even when the link target
        //      did not move.
        let mut sources_current: HashSet<String> = HashSet::new();
        if let Ok(graph) = self.graph() {
            for old in augmented.keys() {
                if let Ok(edges) = graph.backlinks(old) {
                    for e in edges {
                        let current = effective.get(&e.src).cloned().unwrap_or(e.src);
                        sources_current.insert(current);
                    }
                }
            }
        }
        for new in mapping.values() {
            sources_current.insert(new.clone());
        }

        // Reverse view of this rename's mapping so a source that moved
        // in this op can recover its pre-rename directory for the
        // rewriter's source-dir resolution. Sources that did NOT move
        // in this op fall through to the `unwrap_or` and treat their
        // current dir as the source dir on both sides.
        let inverse_this: HashMap<String, String> = mapping
            .iter()
            .map(|(k, v)| (v.clone(), k.clone()))
            .collect();

        let mut rewritten = Vec::new();
        let mut conflicts = Vec::new();
        let mut sources_sorted: Vec<String> = sources_current.into_iter().collect();
        sources_sorted.sort();
        let total_sources = sources_sorted.len() as u64;
        for (idx, src_current) in sources_sorted.into_iter().enumerate() {
            // Only rewrite markdown-class files (.md / .txt): images,
            // binaries, and arbitrary-text source files can be graph
            // nodes but never carry rewriteable markdown links.
            if !fs_ops::is_indexable_text(&src_current) {
                continue;
            }
            progress.on_progress(ProgressEvent {
                stage: ProgressStage::RenameRewrite,
                current: idx as u64,
                total: total_sources,
                label: Some(src_current.clone()),
                eta_secs: None,
            });
            let (content, stat) = match self.read_text_with_stat(&src_current) {
                Ok(pair) => pair,
                Err(_) => continue,
            };
            let src_old_for_dir = inverse_this
                .get(&src_current)
                .cloned()
                .unwrap_or_else(|| src_current.clone());
            let src_old_dir = parent_dir(&src_old_for_dir);
            let src_new_dir = parent_dir(&src_current);
            let new_content = markdown::links::rewrite_link_targets(&content, |link| {
                rewrite_href_for_move(link, &src_old_dir, &src_new_dir, &augmented)
            });
            if let Some(new_md) = new_content {
                match self.write_text_if_unchanged(&src_current, stat.mtime_ns, &new_md) {
                    Ok(()) => rewritten.push(src_current),
                    Err(_) => conflicts.push(src_current),
                }
            }
        }

        // Persist this rename's pairs to the cumulative log so the
        // next rename inside the same reindex window can see through
        // to current locations. The disk sidecar is updated in the
        // same critical section so a crash between the in-memory
        // mutation and the durable write would just drop the last
        // pair (`reindex` would rebuild the graph regardless).
        {
            let mut log = self.rename_log.lock().unwrap();
            for (old, new) in &mapping {
                for v in log.values_mut() {
                    if v == old {
                        *v = new.clone();
                    }
                }
                log.insert(old.clone(), new.clone());
            }
            if let Err(e) = persist_rename_log(&self.paths.graph_dir, &log) {
                tracing::warn!(
                    ?e,
                    "failed to persist rename_log after directory rename; \
                     cross-process chain will rely on reindex to recover",
                );
            }
        }

        let mut renamed: Vec<(String, String)> = mapping.into_iter().collect();
        renamed.sort();
        Ok(RenameOutcome {
            renamed,
            rewritten,
            conflicts,
        })
    }

    /// Append a single pair to the cumulative rename log. Used for
    /// renames that don't go through the directory-snapshot path (e.g.
    /// a file `from` that doesn't exist on disk; rename still fired
    /// and chan-workspace can't know what was on the other side without
    /// re-reading the disk).
    fn rename_log_append(&self, old: &str, new: &str) {
        let mut log = self.rename_log.lock().unwrap();
        for v in log.values_mut() {
            if v == old {
                *v = new.to_string();
            }
        }
        log.insert(old.to_string(), new.to_string());
        // Persist before releasing the mutex so a concurrent reader
        // never sees a divergence between memory and disk. Failure
        // here is logged at warn but does not propagate: the rename
        // already succeeded on the filesystem, the link-rewrite
        // pass already used the (now-updated) in-memory map, and a
        // missed persist degrades to "next process loses cross-call
        // rename memory" -- recoverable via reindex.
        if let Err(e) = persist_rename_log(&self.paths.graph_dir, &log) {
            tracing::warn!(
                ?e,
                "failed to persist rename_log; cross-process chain will rely on reindex to recover",
            );
        }
    }

    /// Pre-rename snapshot of every concrete file under `from`, paired
    /// with its post-rename path. Returns an empty Vec if `from` is a
    /// single file (the caller's `(from, to)` pair already covers it)
    /// or a non-existent path. Returns just the single pair if `from`
    /// is one file. Directories return one entry per descendant file.
    fn snapshot_rename_mapping(&self, from: &str, to: &str) -> Result<HashMap<String, String>> {
        let from_rel = self.rel(from)?;
        let meta = match self.dir.symlink_metadata(&from_rel) {
            Ok(m) => m,
            Err(_) => return Ok(HashMap::new()),
        };
        if meta.is_file() {
            let mut m = HashMap::new();
            m.insert(from.to_string(), to.to_string());
            return Ok(m);
        }
        if !meta.is_dir() {
            return Ok(HashMap::new());
        }
        // Directory walk. list_tree returns workspace-rooted POSIX paths
        // for every regular file + dir under the workspace; we filter to
        // descendants of `from/` and pair them with their new home
        // under `to/`.
        let entries = self.list_tree()?;
        let prefix = if from.is_empty() {
            String::new()
        } else {
            format!("{from}/")
        };
        let mut out = HashMap::new();
        for e in entries {
            if e.is_dir {
                continue;
            }
            let suffix_opt = if prefix.is_empty() {
                Some(e.path.as_str())
            } else {
                e.path.strip_prefix(&prefix)
            };
            let Some(suffix) = suffix_opt else { continue };
            let new_path = if to.is_empty() {
                suffix.to_string()
            } else {
                format!("{to}/{suffix}")
            };
            out.insert(e.path, new_path);
        }
        Ok(out)
    }

    // ---- search ----

    /// Run a search query against this workspace. Routes through the
    /// hybrid index facade; opens the index lazily on first call.
    /// Scope filtering is applied post-rank: the index doesn't
    /// track scope, so a buffered top-N is fetched and pruned to
    /// the requested limit after the prefix check.
    pub fn search(&self, query: &str, opts: &SearchOpts) -> Result<SearchResult> {
        let limit = if opts.limit == 0 { 50 } else { opts.limit } as usize;
        let fetch = if opts.scope.is_some() {
            limit * 4
        } else {
            limit
        };
        let mut res = self.index()?.search(query, opts.mode, fetch)?;
        if let Some(scope) = &opts.scope {
            res.hits.retain(|h| path_under(&h.path, scope));
        }
        res.hits.truncate(limit);
        Ok(res)
    }

    /// Re-index the whole workspace from scratch: walks the tree,
    /// parses every editable-text file, and rebuilds both the
    /// search index and the graph DB. Synchronous and blocking;
    /// the caller decides whether to spawn a worker. Returns the
    /// search-side build summary; graph-side errors short-circuit
    /// the rebuild.
    ///
    /// `cancel`: if set to true mid-build, the rebuild bails out
    /// with `ChanError::Cancelled`. The graph DB is cleared at the
    /// start so a cancelled rebuild leaves an empty graph (the next
    /// `index_stats()` reports `indexed_docs == 0`, which lets the
    /// server's auto-rebuild trigger re-fire on next boot). The BM25
    /// index is unaffected by cancellation: we never reach the
    /// commit, so tantivy discards every pending write.
    pub fn reindex(&self, cancel: Option<&AtomicBool>) -> Result<BuildSummary> {
        self.reindex_with(cancel, &crate::progress::NoProgress)
    }

    /// Same as `reindex`, but `progress` receives events from both
    /// passes: `ProgressStage::GraphRebuild` while the graph is
    /// being collected and `ProgressStage::IndexFile` /
    /// `ProgressStage::EmbedBatch` while the search index is being
    /// built. Consumers that don't care about progress pass
    /// `&NoProgress`; the no-arg `reindex` does that for them.
    /// Foreign-language shells pass an `Arc<dyn ProgressCallback>`
    /// (uniffi-bridged), deref-coerced to `&dyn ProgressCallback`.
    pub fn reindex_with(
        &self,
        cancel: Option<&AtomicBool>,
        progress: &dyn crate::progress::ProgressCallback,
    ) -> Result<BuildSummary> {
        self.reindex_with_aggression(cancel, progress, SearchAggression::Balanced)
    }

    /// Same as `reindex_with`, with an explicit search indexer
    /// resource profile for the search pass. The graph rebuild stays
    /// unchanged; the aggression level only affects search build
    /// workers, queue depth, embed batching, and server debounce.
    pub fn reindex_with_aggression(
        &self,
        cancel: Option<&AtomicBool>,
        progress: &dyn crate::progress::ProgressCallback,
        aggression: SearchAggression,
    ) -> Result<BuildSummary> {
        let recovery = self.recovery_execution(RecoveryAction::FullRebuild);
        let _serial = self.write_serial.lock().unwrap();
        let policy = self.scope_policy();

        // Graph rebuild walks the tree once for headings + edges.
        // The search facade walks again for chunking + embeddings.
        // Two passes is the trade for a clean separation; per-file
        // I/O cost is trivial against the embedding work.
        //
        // The `rebuild.inprogress` marker spans both passes: it is
        // written before the graph rebuild starts and removed only
        // after the search index commits. A process killed at any
        // point in between leaves the marker on disk, which the
        // next `Workspace::open` promotes into a supervised full rebuild
        // instead of trusting an index that may have skipped its final commit.
        self.write_rebuild_marker()?;
        self.rebuild_graph(cancel, progress, &policy)?;
        let index = self.index()?;
        // Push the EFFECTIVE filter (global baseline unioned with this
        // workspace's `excluded_dirs` additions) to the index facade so the
        // walk under `build_all` agrees with the graph rebuild on which
        // subtrees to skip. Re-derived here, so a blocklist edit + reindex
        // re-walks against the new set without mutating the shared snapshot.
        index.set_scope_policy(policy);
        // Snapshot the vector epoch BEFORE reading the opt-in flag. A disable
        // flips the flag then bumps the epoch (clear_vectors), so sampling the
        // epoch first guarantees a build that read a stale `true` still observes
        // the bump via its in-build guards and drops the vectors, closing the
        // TOCTOU between the flag read and the build's epoch snapshot.
        // `unwrap_or(false)` fails safe: a dashboard read error yields a
        // BM25-only build, never an accidental embed. When opted in, bypass the
        // file cap so the whole tree embeds rather than falling back to
        // BM25-only above `EMBED_FILE_CAP`.
        let guard_epoch = index.vectors_epoch();
        let include_vectors = self.semantic_enabled().unwrap_or(false);
        let summary = index
            .build_all(
                BuildOptions {
                    include_vectors,
                    aggression,
                    ignore_embed_cap: include_vectors,
                    guard_epoch: Some(guard_epoch),
                },
                progress,
                cancel,
            )
            .map_err(|e| match e {
                crate::index::IndexError::Cancelled => ChanError::Cancelled,
                other => other.into(),
            })?;
        self.clear_rebuild_marker();
        // Drafts live in-root under `<drafts_dir_name>/...`, so the
        // main reindex walk above already covers them; there is no
        // separate drafts subtree to walk.
        // Drop the cumulative rename log: the freshly-rebuilt graph
        // already reflects every current path, so any prior in-process
        // translation is now a no-op (and would be wrong if the user
        // re-creates a file at a path we'd previously redirected).
        // Clear the in-memory map and remove the persisted sidecar in
        // the same critical section so a concurrent reader can't see
        // an empty map while the file still claims entries (or vice
        // versa).
        {
            let mut log = self.rename_log.lock().unwrap();
            log.clear();
            let path = self.paths.graph_dir.join(RENAME_LOG_FILE);
            if let Err(e) = std::fs::remove_file(&path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(
                        path = %path.display(),
                        ?e,
                        "failed to remove persisted rename_log after reindex",
                    );
                }
            }
        }
        recovery.complete()?;
        Ok(summary)
    }

    /// Execute one full-rebuild pass already claimed from the recovery
    /// coordinator. The caller owns the matching `finish_recovery` call.
    pub fn run_full_rebuild_pass(
        &self,
        pass: RecoveryPass,
        cancel: Option<&AtomicBool>,
        progress: &dyn crate::progress::ProgressCallback,
        aggression: SearchAggression,
    ) -> Result<BuildSummary> {
        if pass.action != RecoveryAction::FullRebuild || self.recovery_status().active != Some(pass)
        {
            return Err(ChanError::Io(format!(
                "full rebuild pass is not active: generation {}",
                pass.generation.get()
            )));
        }
        self.reindex_with_aggression(cancel, progress, aggression)
    }

    /// Stamp `paths.graph_dir/rebuild.inprogress`. Atomic write so a
    /// crash during marker creation never leaves a half-written file
    /// that would confuse the next open. The file body carries the
    /// unix timestamp so a stuck marker can be diagnosed against the
    /// workspace's modification history; we don't read the contents on
    /// open (existence is the signal).
    fn write_rebuild_marker(&self) -> Result<()> {
        std::fs::create_dir_all(&self.paths.graph_dir)?;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let body = format!("started_at = {ts}\n");
        fs_ops::atomic_write(&self.paths.graph_dir.join(REBUILD_MARKER), body.as_bytes())
    }

    /// Remove the marker. Best-effort: a stuck marker is harmless
    /// (next open just re-triggers the rebuild), so a remove failure
    /// here is logged but doesn't fail the reindex.
    fn clear_rebuild_marker(&self) {
        let path = self.paths.graph_dir.join(REBUILD_MARKER);
        if let Err(e) = std::fs::remove_file(&path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(
                    path = %path.display(),
                    error = %e,
                    "failed to clear rebuild.inprogress marker; \
                     next open will still re-trigger the rebuild",
                );
            }
        }
    }

    fn rebuild_graph(
        &self,
        cancel: Option<&AtomicBool>,
        progress: &dyn crate::progress::ProgressCallback,
        policy: &fs_ops::IndexScopePolicy,
    ) -> Result<()> {
        use crate::progress::{eta_secs_from, ProgressEvent, ProgressStage};
        #[cfg(test)]
        open_rebuild_probe(self, cancel);
        // Staged-and-swap: parse each file straight into sqlite
        // staging tables, then atomically swap them into the live
        // tables at the end. The staging rows are committed
        // per-file by the writer, so a mid-rebuild crash leaves a
        // durable parse cursor (MAX(rel_path) in staging_nodes).
        // The next reindex reads the cursor and resumes the walk
        // past it, skipping the redo of every already-staged file.
        // The swap is the only point where live tables are
        // mutated, so the previously-committed graph stays visible
        // to readers (autocomplete, backlinks) for the entire
        // duration of the rebuild and atomically flips to the new
        // shape at the end.
        let graph = self.graph()?;
        // Effective filter = global baseline + this workspace's blocklist
        // additions, so the graph rebuild skips the same subtrees the index
        // build does (both re-derive it per reindex).
        let entries = fs_ops::list_tree_scoped(self.root(), policy)?;
        // The graph is Markdown-only: only `.md` files become document
        // nodes (and contribute wikilink / heading / token edges). `.txt`
        // stays editable + BM25-searchable (the search pass in `build_all`
        // still keys off the wider `is_indexable_text`) but is not a graph
        // document, so the staging walk filters on `is_markdown_file`.
        let total: u64 = entries
            .iter()
            .filter(|e| !e.is_dir && fs_ops::is_markdown_file(&e.path))
            .count() as u64;

        // Resume-or-fresh decision. A non-empty cursor means a
        // prior reindex crashed mid-parse and left staged rows;
        // those represent honest parse output for the files at or
        // below the cursor and should not be redone. We do
        // sanitize against the current disk file set so a file
        // that was staged but has since been deleted from disk
        // gets purged from staging before the swap.
        let initial_cursor: Option<String> = graph.staging_cursor()?;
        if initial_cursor.is_some() {
            tracing::info!(
                cursor = ?initial_cursor,
                "rebuild_graph: resuming from staged cursor",
            );
            let live: std::collections::HashMap<String, (Option<i64>, Option<i64>)> = entries
                .iter()
                .filter(|e| !e.is_dir && fs_ops::is_markdown_file(&e.path))
                .map(|e| (e.path.clone(), (e.mtime, Some(e.size as i64))))
                .collect();
            let purged = graph.sanitize_staging_against_live(&live, true)?;
            if purged > 0 {
                tracing::info!(
                    purged,
                    "rebuild_graph: removed staged rows stale against disk",
                );
            }
        } else {
            // Belt-and-braces clear in the fresh path: in
            // principle staging is already empty when cursor
            // is None, but a previous swap that committed live
            // but failed to clear staging would leave junk.
            // Cheap to run unconditionally on the no-resume
            // path.
            graph.clear_staging()?;
        }
        // Re-read the cursor AFTER sanitize so the skip below
        // uses the post-purge value. Sanitize can move the cursor
        // backwards (or to None) by deleting the tail of staged
        // rows, and using the pre-sanitize value would cause the
        // walk to skip past files that are no longer represented
        // in staging.
        let cursor: Option<String> = graph.staging_cursor()?;

        let mut seen: u64 = 0;
        let started = std::time::Instant::now();
        for e in &entries {
            if let Some(c) = cancel {
                if c.load(Ordering::Relaxed) {
                    return Err(ChanError::Cancelled);
                }
            }
            if e.is_dir || !fs_ops::is_markdown_file(&e.path) {
                continue;
            }
            // Resume skip: the walk is sorted, so a strictly-
            // less-or-equal comparison against the cursor matches
            // every file already staged in a prior session.
            if let Some(c) = cursor.as_deref() {
                if e.path.as_str() <= c {
                    seen += 1;
                    continue;
                }
            }
            progress.on_progress(ProgressEvent {
                stage: ProgressStage::GraphRebuild,
                current: seen,
                total,
                label: Some(e.path.clone()),
                eta_secs: eta_secs_from(started, seen, total),
            });
            seen += 1;
            let content = match self.read_text(&e.path) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let (title, node_kind, headings, edges, emails, aliases) =
                parse_for_graph(&e.path, &content);
            let fg = crate::graph::FileGraph {
                rel: e.path.as_str(),
                title: title.as_deref(),
                mtime: e.mtime,
                size: Some(size_to_i64(e.size)),
                node_kind,
                edges: &edges,
                headings: &headings,
                emails: emails.as_deref(),
                aliases: aliases.as_deref(),
            };
            graph.stage_file(&fg)?;
        }
        if let Some(c) = cancel {
            if c.load(Ordering::Relaxed) {
                return Err(ChanError::Cancelled);
            }
        }
        // Swap staging into the live tables in one atomic txn.
        // Past this commit the previous live state is gone and the
        // new one is visible to readers.
        graph.swap_staging()?;
        Ok(())
    }

    /// How many BM25 chunks are currently in the search index.
    /// Lazily opens the index on first call.
    pub fn num_indexed(&self) -> Result<u64> {
        Ok(self.index()?.stats().indexed_docs)
    }

    /// Snapshot of the search index. Used by the server's status
    /// endpoint.
    pub fn index_stats(&self) -> Result<crate::index::IndexStats> {
        Ok(self.index()?.stats())
    }

    /// Sorted workspace-relative file paths currently known to the
    /// persisted full-text index.
    pub fn indexed_paths(&self) -> Result<Vec<String>> {
        Ok(self.index()?.known_paths()?)
    }

    fn dashboard_lock(&self) -> Result<std::sync::MutexGuard<'_, ()>> {
        self.dashboard_serial
            .lock()
            .map_err(|_| ChanError::Io("dashboard config lock poisoned".into()))
    }

    /// Load one coherent dashboard snapshot. The config remains disk-backed,
    /// but snapshots share the same boundary as updates so a reader cannot
    /// observe an update between individual fields.
    pub fn dashboard_snapshot(&self) -> Result<DashboardConfig> {
        let _serial = self.dashboard_lock()?;
        dashboard::load(&self.paths.root)
    }

    /// Apply `mutate` to the dashboard config and persist it only when the
    /// closure reports a change (so the toggles stay idempotent -- re-setting
    /// the current value writes nothing). The lock covers load through durable
    /// publication, so concurrent disjoint changes compose instead of replacing
    /// fields from a stale snapshot.
    fn update_dashboard(
        &self,
        mutate: impl FnOnce(&mut DashboardConfig) -> bool,
    ) -> Result<DashboardConfig> {
        let _serial = self.dashboard_lock()?;
        let mut cfg = dashboard::load(&self.paths.root)?;
        if mutate(&mut cfg) {
            dashboard::save(&self.paths.root, &cfg)?;
        }
        Ok(cfg)
    }

    /// Read the per-workspace Hybrid-search preference.
    /// Mirrors `DashboardConfig::semantic_enabled`; default-false on a
    /// workspace that has never set it via the CLI / API.
    /// Query-path callers consult this when no explicit `Mode` is
    /// passed.
    pub fn semantic_enabled(&self) -> Result<bool> {
        Ok(self.dashboard_snapshot()?.semantic_enabled)
    }

    /// Flip the per-workspace Hybrid-search preference.
    /// Enabling just persists the flag (the server's indexer rebuilds the
    /// vectors); disabling is destructive: it bins the vector store so a later
    /// re-enable rebuilds from scratch, mirroring `set_reports_enabled` dropping
    /// `report.jsonl`. The `chan workspace index enable-semantic` /
    /// `disable-semantic` CLI and the `/api/index/semantic/{enable,disable}`
    /// endpoints both route here; the change persists to `<root>/dashboard.toml`
    /// so a `chan open` restart honours it.
    pub fn set_semantic_enabled(&self, enabled: bool) -> Result<()> {
        self.update_dashboard(|cfg| {
            if cfg.semantic_enabled == enabled {
                return false;
            }
            cfg.semantic_enabled = enabled;
            true
        })?;
        if !enabled {
            // Opting out bins the vectors so a later re-enable rebuilds from
            // scratch. Best-effort: BM25 is untouched, and a wipe error logs and
            // proceeds rather than failing the toggle. The vector epoch (see
            // `Index::clear_vectors`) stops an embed pass that races this wipe
            // from leaving orphan shards, so only an outright filesystem wipe
            // failure (rare, logged) can leave vectors on disk while disabled.
            if let Err(e) = self.clear_semantic_index() {
                tracing::warn!(
                    error = %e,
                    "set_semantic_enabled(false): failed to clear vector store"
                );
            }
        }
        Ok(())
    }

    /// Read the configured embedding model id from the
    /// per-workspace index config. Used by the resolver so the model
    /// name flows through the same source as `set_model`.
    pub fn semantic_model(&self) -> Result<String> {
        Ok(self.index()?.config().model)
    }

    /// Persist the per-workspace embedding model.
    /// The index layer validates the curated model id, clears stale
    /// vector metadata, and preserves BM25.
    pub fn set_semantic_model(&self, model: &str) -> Result<()> {
        self.index()?.set_model(model.to_owned())?;
        Ok(())
    }

    /// Bin the semantic vector store, leaving BM25 intact. Delegates to
    /// `Index::clear_vectors`. Called by the semantic-search disable path so a
    /// re-enable rebuilds vectors from scratch.
    pub fn clear_semantic_index(&self) -> Result<()> {
        self.index()?.clear_vectors()?;
        Ok(())
    }

    /// Read the per-workspace chan-report opt-in flag.
    /// Mirrors `DashboardConfig::reports_enabled`; default-TRUE for a brand-new
    /// workspace (reports on by default), while an
    /// existing workspace keeps its persisted value. Consumers gate
    /// `Workspace::report()` initialization + the per-workspace
    /// language-graph layer on this flag.
    pub fn reports_enabled(&self) -> Result<bool> {
        Ok(self.dashboard_snapshot()?.reports_enabled)
    }

    /// Flip the per-workspace chan-report opt-in.
    /// Idempotent on re-set. Enabling triggers a lazy
    /// initialization the next time `Workspace::report()` is called
    /// (no eager scan here so a flip from CLI returns fast);
    /// disabling is destructive -- drops the persisted
    /// `report.jsonl` so re-enabling later triggers a fresh
    /// scan. Mirrors `set_semantic_enabled`'s shape.
    pub fn set_reports_enabled(&self, enabled: bool) -> Result<()> {
        self.update_dashboard(|cfg| {
            if cfg.reports_enabled == enabled {
                return false;
            }
            cfg.reports_enabled = enabled;
            true
        })?;
        if !enabled {
            // Drop the persisted JSONL so a re-enable later
            // starts from a fresh scan. Best-effort: a missing
            // file is the desired state; any other error logs +
            // proceeds (next flush would overwrite anyway).
            let jsonl = self.paths.report.clone();
            match std::fs::remove_file(&jsonl) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => tracing::warn!(
                    error = %e,
                    path = %jsonl.display(),
                    "set_reports_enabled(false): failed to drop report jsonl"
                ),
            }
        }
        Ok(())
    }

    /// The global machine-wide directory blocklist baseline (the
    /// `Registry::index_excluded_dirs` snapshot this workspace opened with),
    /// read-only here. The per-workspace CRUD only edits the additions; this
    /// is surfaced so the UI can show the baseline it sits on top of.
    pub fn global_excluded_dirs(&self) -> Vec<String> {
        self.walk_filter.excluded_dir_names.clone()
    }

    /// This workspace's own blocklist ADDITIONS (the editable set), on top of
    /// the global baseline.
    pub fn excluded_dirs(&self) -> Result<Vec<String>> {
        Ok(self.index()?.config().excluded_dirs)
    }

    /// The effective blocklist applied to this workspace's index + graph walk:
    /// union(global baseline, per-workspace additions). What the reindex walk
    /// actually skips.
    pub fn effective_excluded_dirs(&self) -> Result<Vec<String>> {
        Ok(self.scope_policy().configured().excluded_dir_names.clone())
    }

    /// Replace this workspace's blocklist additions. Persists the set, swaps
    /// one new generated scope, and requests reconciliation; the caller
    /// triggers the recovery off its async executor. Names are stored as
    /// given; matching is
    /// case-insensitive basename-at-any-depth, so the caller normalizes
    /// (trim / drop blanks / reject path separators / lower-case + dedupe).
    pub fn set_excluded_dirs(&self, dirs: Vec<String>) -> Result<()> {
        let _serial = self.write_serial.lock().unwrap();
        if self.excluded_dirs()? == dirs {
            return Ok(());
        }
        self.index()?.set_excluded_dirs(dirs)?;
        let mut configured = self.walk_filter.excluded_dir_names.clone();
        configured.extend(self.index()?.config().excluded_dirs);
        let policy = {
            let mut current = self.scope_policy.write().unwrap();
            let generation = self.request_policy_recovery(RecoveryAction::Reconcile);
            let policy = Arc::new(fs_ops::IndexScopePolicy::new(
                self.root().to_path_buf(),
                generation,
                fs_ops::WalkFilter::new(configured),
            )?);
            *current = Arc::clone(&policy);
            policy
        };
        if let Some(report) = self.report.get() {
            report.replace_policy(self.root(), policy)?;
        }
        Ok(())
    }

    fn refresh_repository_scope(&self) -> Result<()> {
        let mut current = self.scope_policy.write().unwrap();
        let configured = current.configured().clone();
        let generation = self.request_policy_recovery(RecoveryAction::Reconcile);
        *current = Arc::new(fs_ops::IndexScopePolicy::new(
            self.root().to_path_buf(),
            generation,
            configured,
        )?);
        Ok(())
    }

    /// Read the per-workspace screensaver-enabled flag.
    /// Default-false on workspaces that pre-date the field; SPA arms
    /// the overlay state machine when true.
    pub fn screensaver_enabled(&self) -> Result<bool> {
        Ok(self.dashboard_snapshot()?.screensaver_enabled)
    }

    /// Flip the per-workspace screensaver-enabled flag.
    /// Idempotent. No filesystem side effects (unlike
    /// `set_reports_enabled`'s jsonl drop) -- the overlay state
    /// lives entirely client-side; this just persists the toggle.
    pub fn set_screensaver_enabled(&self, enabled: bool) -> Result<()> {
        self.update_dashboard(|cfg| {
            if cfg.screensaver_enabled == enabled {
                return false;
            }
            cfg.screensaver_enabled = enabled;
            true
        })
        .map(|_| ())
    }

    /// Read the idle window (seconds) before the
    /// SPA arms the overlay. Default 300.
    pub fn screensaver_timeout_secs(&self) -> Result<u32> {
        Ok(self.dashboard_snapshot()?.screensaver_timeout_secs)
    }

    /// Persist the idle window. SPA enforces a
    /// minimum + maximum client-side; chan-workspace stores whatever
    /// value lands.
    pub fn set_screensaver_timeout_secs(&self, secs: u32) -> Result<()> {
        self.update_dashboard(|cfg| {
            if cfg.screensaver_timeout_secs == secs {
                return false;
            }
            cfg.screensaver_timeout_secs = secs;
            true
        })
        .map(|_| ())
    }

    /// Read the persisted visual theme. Default
    /// plain on workspaces that pre-date the field.
    pub fn screensaver_theme(&self) -> Result<ScreensaverTheme> {
        Ok(self.dashboard_snapshot()?.screensaver_theme)
    }

    /// Persist the visual theme.
    pub fn set_screensaver_theme(&self, theme: ScreensaverTheme) -> Result<()> {
        self.update_dashboard(|cfg| {
            if cfg.screensaver_theme == theme {
                return false;
            }
            cfg.screensaver_theme = theme;
            true
        })
        .map(|_| ())
    }

    /// Atomically apply the optional screensaver state fields and return the
    /// resulting dashboard snapshot. Callers validate values before entering
    /// this core persistence boundary.
    pub fn update_screensaver(
        &self,
        enabled: Option<bool>,
        timeout_secs: Option<u32>,
        theme: Option<ScreensaverTheme>,
    ) -> Result<DashboardConfig> {
        self.update_dashboard(|cfg| {
            let mut changed = false;
            if let Some(enabled) = enabled {
                changed |= cfg.screensaver_enabled != enabled;
                cfg.screensaver_enabled = enabled;
            }
            if let Some(timeout_secs) = timeout_secs {
                changed |= cfg.screensaver_timeout_secs != timeout_secs;
                cfg.screensaver_timeout_secs = timeout_secs;
            }
            if let Some(theme) = theme {
                changed |= cfg.screensaver_theme != theme;
                cfg.screensaver_theme = theme;
            }
            changed
        })
    }

    /// Read the persisted PIN hash. `None` means no
    /// PIN is set. The hash bytes themselves NEVER leave the
    /// server in plaintext -- the `/api/screensaver/state` endpoint
    /// reports `pin_set: bool` and the verify endpoint compares
    /// bytes server-side. This getter is for the chan-server route
    /// + tests only.
    pub fn screensaver_pin_hash(&self) -> Result<Option<Vec<u8>>> {
        Ok(self.dashboard_snapshot()?.screensaver_pin_hash)
    }

    /// Persist or clear the PIN hash. `Some(bytes)`
    /// stores them verbatim (SPA does PBKDF2 client-side);
    /// `None` clears the PIN.
    pub fn set_screensaver_pin_hash(&self, hash: Option<Vec<u8>>) -> Result<()> {
        self.update_dashboard(|cfg| {
            if cfg.screensaver_pin_hash == hash {
                return false;
            }
            cfg.screensaver_pin_hash = hash;
            true
        })
        .map(|_| ())
    }

    /// BOOT entry-point. Consumers call this after
    /// `Workspace::open` to kick off the optional indexing layers
    /// (semantic + reports) per the persisted feature flags. The
    /// baseline BM25 + graph + watcher path runs regardless; this
    /// is purely the optional-layer activation. Idempotent -- a
    /// second call is a no-op when the layers are already
    /// initialized. Errors during one layer don't block the
    /// other.
    pub fn boot(&self) -> Result<()> {
        let reports_enabled = self
            .dashboard_snapshot()
            .map(|config| config.reports_enabled)
            .unwrap_or(false);
        if reports_enabled {
            // Lazy initialization: `report_state()` constructs
            // `ReportState`, runs the initial scan if no JSONL
            // is persisted, and primes the watcher fanout. A
            // subsequent `Workspace::report()` consumes the same
            // OnceLock'd state.
            if let Err(e) = self.report_state() {
                tracing::warn!(
                    error = %e,
                    "boot: report_state initialization failed"
                );
            }
        }
        // Semantic-search initialization is already lazy through
        // the index() accessor; no separate boot step needed
        // here. The flag is consulted at query time by
        // `Workspace::search` to decide whether to engage Hybrid
        // mode.
        Ok(())
    }

    /// Re-index a single file. Reads, parses, updates the search
    /// index and graph for just this path. Used by the watcher
    /// consumer when a file changes.
    ///
    /// Journal-bracketed: the call records a `PendingOp::Index`
    /// entry for `rel` before touching either backend and removes
    /// it after both commit. A crash mid-call leaves the entry on
    /// disk; the next `Workspace::open` schedules replay and exposes
    /// `needs_replay_writes()` while it remains outstanding.
    pub fn index_file(&self, rel: &str) -> Result<()> {
        let _serial = self.write_serial.lock().unwrap();
        self.index_file_serial(rel)
    }

    fn index_file_serial(&self, rel: &str) -> Result<()> {
        if !fs_ops::is_indexable_text(rel) {
            return Ok(());
        }
        if !self.scope_policy().includes(rel, false) {
            return self.forget_file_serial(rel);
        }
        self.journal_record(rel, PendingOp::Index)?;
        let result = self.index_file_inner(rel);
        if result.is_ok() {
            self.journal_clear_one(rel)?;
        }
        result
    }

    fn index_file_inner(&self, rel: &str) -> Result<()> {
        // Stat BEFORE read. If a concurrent writer lands between the
        // two calls, the graph then holds the older (mtime, size)
        // tuple alongside the newer content; reconcile compares the
        // stamped tuple against the live stat on its next pass and
        // catches the drift. The opposite order (read-then-stat)
        // would stamp the post-write (mtime, size) onto the pre-write
        // content, leaving graph.stat == disk.stat and the drift
        // invisible to reconcile.
        let stat = self.stat(rel).ok();
        let mtime = stat.as_ref().and_then(|s| s.mtime);
        let size = stat.as_ref().map(|s| size_to_i64(s.size));
        #[cfg(test)]
        index_file_between_stat_and_read_hook();
        let content = self.read_text(rel)?;
        // Graph first, then search index. The graph is what the
        // editor consults for backlinks and link-autocomplete on
        // every keystroke; a stale graph is the more user-visible
        // failure mode. The search index is queried explicitly and
        // a stale BM25 row gets corrected on the next save or
        // rebuild. If graph succeeds and index_one fails, the
        // resulting drift is "search slightly stale", which the
        // user is less likely to notice and can recover via the
        // server's auto-rebuild trigger. The opposite ordering
        // (search-then-graph) made backlinks the silent victim.
        // The journal entry covers either ordering: the replay
        // path re-runs both so an asymmetric crash converges.
        //
        // Graph is Markdown-only: only `.md` becomes a document node.
        // A non-Markdown indexable file (`.txt`) is still BM25-indexed
        // below but carries no graph node; evict any stale node (e.g. a
        // `.md` renamed to `.txt`) so the graph never holds a `.txt`.
        if fs_ops::is_markdown_file(rel) {
            let (title, node_kind, headings, edges, emails, aliases) =
                parse_for_graph(rel, &content);
            self.graph()?.replace_file(FileRecord {
                rel,
                title: title.as_deref(),
                mtime,
                size,
                node_kind,
                outgoing: &edges,
                headings: &headings,
                emails: emails.as_deref(),
                aliases: aliases.as_deref(),
            })?;
        } else {
            self.graph()?.forget_file(rel)?;
        }
        // Hand the already-read content to the index so the read goes through
        // the Workspace sandbox exactly once. Snapshot the vector epoch BEFORE
        // reading the opt-in so a disable that races this save is reconciled by
        // index_one's post-write check even if we read a stale `true`. Embed
        // only when opted in; fail-safe to no-embed on a dashboard read error.
        let index = self.index()?;
        let guard_epoch = index.vectors_epoch();
        let include_vectors = self.semantic_enabled().unwrap_or(false);
        index.index_one(rel, &content, include_vectors, guard_epoch)?;
        Ok(())
    }

    /// Link-autocomplete lookup. Pass-through to
    /// `GraphView::link_targets`. The editor's `[[` typeahead binds
    /// to this: an empty `q` returns recent files; a non-empty `q`
    /// returns ranked file + heading matches. See `GraphView::link_targets`
    /// for the ranking and case-folding rules.
    pub fn link_targets(&self, q: &str, limit: u32) -> Result<Vec<crate::graph::LinkTarget>> {
        self.graph()?.link_targets(q, limit)
    }

    /// Resolve a wiki-link target string to an existing workspace
    /// file. The graph stores link dst nodes verbatim from
    /// markdown (e.g. `[[recipes/pasta]]` -> `dst="recipes/pasta"`),
    /// so backlinks queries match the stored form. Consumers that
    /// want to navigate to or read the actual file (the editor's
    /// click-on-link, or an MCP `read_file` call given a wiki target)
    /// call this to find the real path.
    ///
    /// Algorithm:
    ///   1. Split off `#anchor` (everything after the first `#`).
    ///      An empty anchor (target ends in `#`) becomes None.
    ///   2. Try `path.md`, then `path.txt`, then the exact `path`
    ///      (rare case: a file with no extension that matches by
    ///      name). Return the first hit as a regular file.
    ///   3. None when no candidate exists.
    ///
    /// Anchor strings are passed through unchanged; chan-workspace
    /// doesn't validate them against the file's headings (callers
    /// can do that via `GraphView::headings_of`).
    pub fn resolve_link(&self, target: &str) -> Option<ResolvedLink> {
        if target.is_empty() {
            return None;
        }
        let (path, anchor) = match target.split_once('#') {
            Some((p, a)) if !a.is_empty() => (p, Some(a.to_string())),
            // Trailing `#` (empty anchor): strip it; path is the
            // prefix, anchor None.
            Some((p, _)) => (p, None),
            None => (target, None),
        };
        if path.is_empty() {
            return None;
        }
        for candidate in [
            format!("{path}.md"),
            format!("{path}.txt"),
            path.to_string(),
        ] {
            if self.exists(&candidate) {
                // Best-effort kind lookup against the graph. If the
                // graph isn't open yet, the row is missing (file
                // indexed after this resolve, or never indexed), or
                // the query fails for any reason, fall back to
                // `File` so the caller still gets a resolution.
                // Kind-aware rendering is a hint, not a contract.
                let kind = self
                    .graph()
                    .ok()
                    .and_then(|g| g.node_kind(&candidate).ok().flatten())
                    .unwrap_or_default();
                return Some(ResolvedLink {
                    path: candidate,
                    anchor,
                    kind,
                    is_dir: false,
                });
            }
        }
        // A link that points at a directory resolves to the folder
        // itself; the caller opens it in the file browser rather than the
        // editor. Kind is irrelevant here (directories are not graph
        // nodes), so it keeps its default.
        if self.is_dir(path) {
            return Some(ResolvedLink {
                path: path.to_string(),
                anchor,
                kind: crate::graph::NodeKind::default(),
                is_dir: true,
            });
        }
        None
    }

    /// Drop a single file from the search index and graph. Used
    /// when the watcher reports a deletion.
    ///
    /// Graph first, search second, mirroring `index_file`. If the
    /// graph delete succeeds and the search delete fails, queries
    /// surface a "ghost" search hit pointing at a missing file; the
    /// caller then asks `Workspace::read` and gets `NotFound`, which is
    /// recoverable. The reverse ordering (search-then-graph) would
    /// leave backlinks pointing at a missing file, a silently broken
    /// state the editor cannot self-heal.
    pub fn forget_file(&self, rel: &str) -> Result<()> {
        let _serial = self.write_serial.lock().unwrap();
        self.forget_file_serial(rel)
    }

    /// Drop every graph and search entry at or below a directory path.
    ///
    /// Each file remains journal-bracketed so a crash between the graph and
    /// search commits is replayable on the next open.
    pub fn forget_subtree(&self, rel: &str) -> Result<usize> {
        let _serial = self.write_serial.lock().unwrap();
        let rel = rel.trim_end_matches('/');
        let mut paths = self.graph()?.files()?;
        paths.extend(self.index()?.known_paths()?);
        if !rel.is_empty() {
            let child_prefix = format!("{rel}/");
            paths.retain(|path| path == rel || path.starts_with(&child_prefix));
        }
        // The empty relative path is the workspace root. Keep every known
        // path so a watcher `Removed { path: \"\", is_dir: true }` clears the
        // entire graph + search catalog instead of matching nothing against
        // the otherwise-invalid child prefix "/".
        paths.sort();
        paths.dedup();
        for path in &paths {
            self.forget_file_serial(path)?;
        }
        Ok(paths.len())
    }

    fn forget_file_serial(&self, rel: &str) -> Result<()> {
        self.journal_record(rel, PendingOp::Forget)?;
        let result = self.forget_file_inner(rel);
        if result.is_ok() {
            self.journal_clear_one(rel)?;
        }
        result
    }

    fn forget_file_inner(&self, rel: &str) -> Result<()> {
        self.graph()?.forget_file(rel)?;
        self.index()?.forget(rel)?;
        Ok(())
    }

    /// True while the pending-writes journal still needs replay.
    /// Open schedules replay automatically; callers may also invoke
    /// `replay_pending_writes()` explicitly.
    pub fn needs_replay_writes(&self) -> bool {
        if !self.pending_writes.lock().unwrap().is_empty() {
            return true;
        }
        let status = self.recovery_status();
        status
            .active
            .into_iter()
            .chain(status.pending)
            .any(|pass| pass.action == RecoveryAction::Replay)
    }

    /// Snapshot of the currently-journaled `(rel, op)` pairs.
    /// Exposed mostly for UI ("N pending writes") and tests; the
    /// recovery itself runs through `replay_pending_writes`.
    pub fn pending_writes(&self) -> Vec<(String, &'static str)> {
        self.pending_writes
            .lock()
            .unwrap()
            .iter()
            .map(|(rel, op)| {
                (
                    rel.clone(),
                    match op {
                        PendingOp::Index => "index",
                        PendingOp::Forget => "forget",
                    },
                )
            })
            .collect()
    }

    /// Re-run every journaled per-file op so graph and index
    /// converge to the on-disk truth, then clear the journal.
    /// Idempotent: an empty journal is a no-op, and a partial
    /// replay (errors on some entries) leaves the unprocessed
    /// entries journaled for the next call.
    ///
    /// Per-entry policy:
    ///   - `Index`: if the file still exists on disk, re-run
    ///     `index_file` (re-reads and re-commits both backends).
    ///     If it no longer exists, degrade to `forget_file`,
    ///     since the original mutation's intent (index this rel)
    ///     no longer makes sense against a missing file.
    ///   - `Forget`: re-run `forget_file`. Idempotent against
    ///     already-cleaned backends.
    ///
    /// Returns the number of entries successfully replayed.
    pub fn replay_pending_writes(&self) -> Result<usize> {
        let recovery = self.recovery_execution(RecoveryAction::Replay);
        let _serial = self.write_serial.lock().unwrap();
        let entries: Vec<(String, PendingOp)> = self
            .pending_writes
            .lock()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), *v))
            .collect();
        let mut replayed = 0usize;
        for (rel, op) in entries {
            // Each replay runs through the journal-bracketed
            // public API, so a crash mid-replay leaves the entry
            // journaled again (in fact, never removed) and the
            // next open will retry.
            match op {
                PendingOp::Index => {
                    if self.exists(&rel) {
                        self.index_file_serial(&rel)?;
                    } else {
                        self.forget_file_serial(&rel)?;
                    }
                }
                PendingOp::Forget => {
                    self.forget_file_serial(&rel)?;
                }
            }
            replayed += 1;
        }
        recovery.complete()?;
        Ok(replayed)
    }

    /// Diff the live filesystem against the graph and emit per-file
    /// index_file / forget_file calls only for the files that
    /// actually changed. Cheaper than a full `reindex` because
    /// unchanged files are skipped entirely; matches a clean reindex
    /// in end state when the diff is correct.
    ///
    /// Use cases:
    ///   - Cold open after edits while the process was down: the
    ///     watcher missed every event between the last shutdown and
    ///     this open, so graph + index are stale. Reconcile catches
    ///     up without paying for files that did not change.
    ///   - Watcher overflow (inotify `IN_Q_OVERFLOW`, FSEvents
    ///     coalesce-loss): the consumer cannot trust the event
    ///     stream and falls back to reconcile to converge.
    ///   - Post-recovery sanity pass: after `replay_pending_writes`
    ///     drains the journal, a reconcile picks up any files
    ///     touched outside the journaled set.
    ///
    /// Diff policy compares the `(mtime, size)` tuple stamped on the
    /// graph row against the live `stat()` snapshot:
    ///   - File on disk but not in graph -> `index_file`.
    ///   - File on disk + graph row with different mtime -> `index_file`.
    ///   - File on disk + graph row with same mtime but a different
    ///     non-null size -> `index_file`. Catches same-mtime rewrites
    ///     that mtime alone misses (rapid back-to-back saves on
    ///     coarse-mtime filesystems, or tools that explicitly preserve
    ///     mtime across content edits).
    ///   - Legacy rows (size = NULL, predating the v5 migration) fall
    ///     back to mtime-only; the first `index_file` after upgrade
    ///     backfills the size column.
    ///   - File on disk + matching `(mtime, size)` tuple -> skip.
    ///   - File in graph but missing from disk -> `forget_file`.
    ///
    /// Each emitted op runs through the journal-bracketed public
    /// API, so a crash during reconcile leaves a recoverable
    /// pending-writes journal behind. Reconcile is not transactional
    /// across the file set; partial progress is fine.
    ///
    /// Residual false-negative window: a rewrite that leaves both
    /// mtime AND size unchanged still slips by. The next save or full
    /// reindex covers it; closing this gap would require content
    /// hashing, which is far more expensive than the (mtime, size)
    /// stat check.
    pub fn reconcile(&self) -> Result<ReconcileReport> {
        let recovery = self.recovery_execution(RecoveryAction::Reconcile);
        let _serial = self.write_serial.lock().unwrap();
        #[cfg(test)]
        open_recovery_probe(self);
        // Snapshot the graph's view of the world: per-file
        // (mtime, size) tuples. Graph stores mtime as Unix
        // seconds and size as bytes (None for either component
        // on legacy rows predating the v5 migration).
        let graph_snapshot: std::collections::HashMap<String, (Option<i64>, Option<i64>)> = self
            .graph()?
            .files_with_stat()?
            .into_iter()
            .map(|(rel, mtime, size)| (rel, (mtime, size)))
            .collect();

        // Walk the workspace applying the same filter the reindex uses
        // (.git, .chan, plus the per-Library WalkFilter blocklist).
        // Only editable-text files participate; binaries / images
        // are not indexed by either backend and so do not need
        // reconciliation.
        let policy = self.scope_policy();
        let mut disk_files: std::collections::HashMap<String, (Option<i64>, Option<i64>)> =
            std::collections::HashMap::new();
        for entry in fs_ops::walk_workspace_scoped(self.root(), &policy) {
            if !entry.file_type().is_file() {
                continue;
            }
            let rel = match entry.path().strip_prefix(self.root()) {
                Ok(p) => p.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };
            if !fs_ops::is_indexable_text(&rel) {
                continue;
            }
            let meta = entry.metadata().ok();
            let mtime = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64);
            let size = meta.as_ref().map(|m| size_to_i64(m.len()));
            disk_files.insert(rel, (mtime, size));
        }

        let mut upserted: Vec<String> = Vec::new();
        let mut forgotten: Vec<String> = Vec::new();
        let mut unchanged = 0usize;

        // Pass 1: every file currently on disk. New or modified
        // entries trigger an index_file; the journal in PR5 covers
        // crash recovery for each per-file commit pair.
        for (rel, (disk_mtime, disk_size)) in &disk_files {
            let needs_index = match graph_snapshot.get(rel) {
                None => true,
                Some((graph_mtime, graph_size)) => {
                    // Tighter diff than mtime alone: a file rewritten
                    // to the same length AND same mtime still slips
                    // by, but a change in either component is caught.
                    // Legacy rows (size = None) treat the size check
                    // as a skip and rely on mtime; a single subsequent
                    // index_file backfills the size column.
                    graph_mtime != disk_mtime
                        || (graph_size.is_some() && disk_size.is_some() && graph_size != disk_size)
                }
            };
            if needs_index {
                self.index_file_serial(rel)?;
                upserted.push(rel.clone());
            } else {
                unchanged += 1;
            }
        }

        // Pass 2: every file in graph but not on disk. These are
        // deletions the watcher missed (or a downtime deletion).
        for rel in graph_snapshot.keys() {
            if !disk_files.contains_key(rel) {
                self.forget_file_serial(rel)?;
                forgotten.push(rel.clone());
            }
        }

        upserted.sort();
        forgotten.sort();
        let report = ReconcileReport {
            upserted,
            forgotten,
            unchanged,
        };
        recovery.complete()?;
        Ok(report)
    }

    /// Add an entry to the pending-writes journal and persist it.
    /// Must be called only while `write_serial` is held by the
    /// caller, so the on-disk shape stays in lockstep with the
    /// in-memory map.
    fn journal_record(&self, rel: &str, op: PendingOp) -> Result<()> {
        let snapshot = {
            let mut map = self.pending_writes.lock().unwrap();
            map.insert(rel.to_string(), op);
            map.clone()
        };
        persist_pending_writes(&self.paths.graph_dir, &snapshot)?;
        // The presence of any journaled entry implies "graph and
        // index may disagree about this rel until replay." A normal
        // in-process call does not request recovery because it clears
        // its own entry before returning. A crash leaves the durable
        // entry for the next open to seed into the coordinator.
        Ok(())
    }

    /// Remove a journaled entry and persist. Same locking
    /// preconditions as `journal_record`.
    fn journal_clear_one(&self, rel: &str) -> Result<()> {
        let snapshot = {
            let mut map = self.pending_writes.lock().unwrap();
            map.remove(rel);
            map.clone()
        };
        persist_pending_writes(&self.paths.graph_dir, &snapshot)?;
        Ok(())
    }

    fn index(&self) -> Result<&Index> {
        if let Some(idx) = self.index.get() {
            return Ok(idx);
        }
        let idx = Index::open(self.root(), &self.paths.index)?;
        let _ = self.index.set(idx);
        Ok(self.index.get().unwrap())
    }

    // ---- graph ----

    /// View into the workspace's graph DB.
    pub fn graph(&self) -> Result<&GraphView> {
        if let Some(g) = self.graph.get() {
            return Ok(g);
        }
        let g = GraphView::open(&self.paths.graph_db)?;
        let _ = self.graph.set(g);
        Ok(self.graph.get().unwrap())
    }

    /// All contact-kind notes in the workspace, sorted by display name.
    /// Pass-through to `GraphView::contacts`. Convenience for callers
    /// (CLI, tests) that want the full list; the editor `@` picker
    /// and `GET /api/contacts` should call `contacts_filtered`
    /// instead so the case-insensitive contains filter and result cap
    /// run inside SQLite.
    pub fn contacts(&self) -> Result<Vec<crate::graph::ContactNode>> {
        self.graph()?.contacts()
    }

    /// Filtered contact-kind notes. `query` is matched case-
    /// insensitively against title, basename, and the joined email
    /// column inside SQLite, and `limit` caps the row count so
    /// picker keystrokes stay O(limit) regardless of how many
    /// contacts the workspace holds. `query` of `None` or empty returns
    /// up to `limit` contacts in display-name order.
    pub fn contacts_filtered(
        &self,
        query: Option<&str>,
        limit: usize,
    ) -> Result<Vec<crate::graph::ContactNode>> {
        self.graph()?.contacts_filtered(query, limit)
    }

    // ---- watch ----

    /// Start a recursive filesystem watcher on the workspace. Drop
    /// the returned `WatchHandle` to stop. Events for `.chan/`
    /// and `.git/` are filtered out.
    ///
    /// This does not warm the SLOC / language / COCOMO report: that full
    /// content scan is the biggest cold-boot cost and must not gate watcher
    /// registration, so `watch()` performs only the notify registration. The
    /// report is wired through a lazy fan-out keyed on the shared `self.report`
    /// cell: once a scan fills the cell (via `report()` / `boot()`) the watcher
    /// keeps the report current incrementally; until then report events are
    /// dropped, since the scan reflects the on-disk state regardless. Callers
    /// that need a warm report call `report()` / `boot()`.
    pub fn watch(self: &Arc<Self>, cb: Arc<dyn WatchCallback>) -> Result<WatchHandle> {
        let report_fan: Arc<dyn WatchCallback> =
            ReportFanOut::new(cb, Arc::clone(&self.report), Arc::clone(&self.write_serial));
        let fan: Arc<dyn WatchCallback> = Arc::new(ScopePolicyFanOut {
            workspace: Arc::downgrade(self),
            downstream: report_fan,
        });
        // Single recursive root watcher. Drafts live in-root under
        // `<drafts_dir_name>/...`, so the workspace-root watcher already
        // covers them; no separate drafts watch root is needed.
        let roots = [crate::watch::WatchRoot::workspace(self.root())];
        // Same unified ignore set the bootstrap/index walk uses, so a
        // node_modules/target/venv/.git storm never reaches the
        // broadcast bus or the indexer.
        WatchHandle::start(&roots, Arc::clone(&self.scope_policy), fan)
    }

    /// Start the built-in graph indexer on this workspace. Returns a
    /// handle; drop or `stop()` to tear down. The indexer attaches
    /// its own watcher, debounces per-path with `debounce_ms`, and
    /// workspaces `index_file` / `forget_file` / `reconcile` so the
    /// consumer (CLI, chan-server, FFI shells) doesn't need to
    /// write its own indexing loop.
    pub fn start_graph_indexer(
        self: &Arc<Self>,
        debounce_ms: u64,
    ) -> Result<crate::indexer::GraphIndexer> {
        crate::indexer::GraphIndexer::start_on(Arc::clone(self), debounce_ms)
    }

    // ---- report ----

    /// Snapshot of the workspace's code/SLOC report covering every
    /// indexed file. Lazy on first call (full scan). Returned
    /// `Report` is a plain serde value; clone-and-shape is the
    /// caller's job.
    pub fn report(&self) -> Result<Report> {
        Ok(self.report_state()?.snapshot(&ReportScope::All))
    }

    /// Return a maintained report snapshot without initializing a cold report.
    /// A warm report captured under an older scope generation is rescanned
    /// before it is returned.
    pub fn report_if_available(&self) -> Result<Option<Report>> {
        if self.report.get().is_some() {
            return Ok(Some(self.report_state()?.snapshot(&ReportScope::All)));
        }
        if !self.reports_enabled()? {
            return Ok(None);
        }
        crate::report::load_snapshot_if_available(
            self.root(),
            &self.paths.report,
            self.scope_policy(),
        )
    }

    /// Snapshot of the report restricted to a workspace-relative
    /// POSIX prefix. Empty `prefix` is equivalent to `report()`.
    /// Missing files in the prefix produce empty roll-ups.
    pub fn report_for_prefix(&self, prefix: &str) -> Result<Report> {
        Ok(self
            .report_state()?
            .snapshot(&ReportScope::Prefix(prefix.to_string())))
    }

    /// Snapshot of the report restricted to an explicit list of
    /// workspace-relative paths. Paths absent from the index are
    /// silently ignored.
    pub fn report_for_files(&self, paths: &[String]) -> Result<Report> {
        Ok(self
            .report_state()?
            .snapshot(&ReportScope::Files(paths.to_vec())))
    }

    /// O(1) lookup of the maintained per-directory aggregation
    /// cache. `dir` is workspace-relative POSIX with no leading
    /// slash; trailing slashes are stripped. Empty string maps
    /// to the workspace root.
    ///
    /// Returns `Ok(None)` when no tracked file lives at or under
    /// the requested directory (so callers can serve a clean 404
    /// instead of an empty roll-up that looks indistinguishable
    /// from "real but empty"). The returned `Report` carries
    /// `totals`, `by_language`, and `cocomo` from the cache;
    /// `files` is left empty (dir queries do not enumerate
    /// per-file rows). Mirrors the shape `report_for_prefix`
    /// returns so chan-server can use the same response type for
    /// both endpoints.
    pub fn report_for_dir(&self, dir: &str) -> Result<Option<Report>> {
        Ok(self.report_state()?.dir_snapshot(dir))
    }

    /// Path to the persisted JSONL form of the report on disk.
    /// chan-workspace's writer thread keeps this file in sync with
    /// the in-memory index via debounced atomic writes.
    pub fn report_jsonl_path(&self) -> Result<std::path::PathBuf> {
        Ok(self.report_state()?.jsonl_path().to_path_buf())
    }

    fn report_state(&self) -> Result<&Arc<ReportState>> {
        if let Some(s) = self.report.get() {
            self.refresh_report_scope_if_needed(s)?;
            return Ok(s);
        }
        // Bug 7: the report's initial `Index::scan` walks the workspace and
        // reads every file (one descriptor at a time, but a full pass).
        // When it warms concurrently with a cold-boot search reindex it
        // adds to the descriptor pressure. Gate the scan start behind
        // the same reserve the reindex workers honor so the report walk
        // yields the table to editing + the terminal when fds are
        // tight. Cheap and best-effort: clear headroom returns at once.
        crate::fd_budget::pace_reindex_worker(None);
        let state = ReportState::open(self.root(), &self.paths.report, self.scope_policy())?;
        // OnceLock::set is racy with a concurrent caller; the
        // loser drops its state cleanly, which terminates its
        // writer thread via Drop. The winner's state stays.
        let _ = self.report.set(state);
        let state = self.report.get().expect("report state just set");
        self.refresh_report_scope_if_needed(state)?;
        Ok(state)
    }

    fn refresh_report_scope_if_needed(&self, report: &ReportState) -> Result<()> {
        let policy = self.scope_policy();
        if report.policy_generation() == Some(policy.generation().get()) {
            return Ok(());
        }
        let _serial = self.write_serial.lock().unwrap();
        let policy = self.scope_policy();
        if report.policy_generation() != Some(policy.generation().get()) {
            report.replace_policy(self.root(), policy)?;
        }
        Ok(())
    }

    fn rescan_persisted_report(&self) -> Result<()> {
        let report = self.report_state()?;
        let _serial = self.write_serial.lock().unwrap();
        report.replace_policy(self.root(), self.scope_policy())
    }
}

/// Semantic text-write budget for a target with optional existing content.
///
/// New files use `TEXT_WRITE_LIMIT`. A legacy file already above that cap may
/// be rewritten up to its current size but may not grow.
pub fn semantic_write_budget(existing_file_size: Option<u64>) -> u64 {
    std::cmp::max(existing_file_size.unwrap_or(0), TEXT_WRITE_LIMIT)
}

fn emit_valid_utf8_chunks<F>(rel: &str, pending: &mut Vec<u8>, on_event: &mut F) -> Result<bool>
where
    F: FnMut(TextReadEvent<'_>) -> bool,
{
    if pending.is_empty() {
        return Ok(true);
    }
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let keep_going = s.is_empty() || on_event(TextReadEvent::Chunk(s));
            pending.clear();
            Ok(keep_going)
        }
        Err(e) => {
            if e.error_len().is_some() {
                return Err(ChanError::Io(format!(
                    "invalid UTF-8 in editable text file: {rel}"
                )));
            }
            let valid_up_to = e.valid_up_to();
            if valid_up_to > 0 {
                let keep_going = {
                    let valid = std::str::from_utf8(&pending[..valid_up_to]).map_err(|e| {
                        ChanError::Io(format!("invalid UTF-8 in editable text file: {rel}: {e}"))
                    })?;
                    on_event(TextReadEvent::Chunk(valid))
                };
                if !keep_going {
                    return Ok(false);
                }
                pending.drain(..valid_up_to);
            }
            if pending.len() > 4 {
                return Err(ChanError::Io(format!(
                    "invalid UTF-8 in editable text file: {rel}"
                )));
            }
            Ok(true)
        }
    }
}

/// `u64` byte counts (from `Metadata::len()` / `TreeEntry.size`)
/// projected into the `i64` column the graph uses for `size`.
/// Saturates instead of wrapping; a real-world file will never come
/// close to `i64::MAX` (9.22 EB), and a saturating value is still
/// usable for the reconcile `(mtime, size)` equality check.
fn size_to_i64(size: u64) -> i64 {
    i64::try_from(size).unwrap_or(i64::MAX)
}

#[cfg(test)]
struct OpenRecoveryProbe {
    root: std::path::PathBuf,
    tx: std::sync::mpsc::Sender<std::thread::ThreadId>,
}

#[cfg(test)]
static OPEN_RECOVERY_PROBE: std::sync::OnceLock<std::sync::Mutex<Option<OpenRecoveryProbe>>> =
    std::sync::OnceLock::new();

#[cfg(test)]
fn open_recovery_probe(workspace: &Workspace) {
    let slot = OPEN_RECOVERY_PROBE.get_or_init(|| std::sync::Mutex::new(None));
    let mut probe = slot.lock().unwrap();
    if probe
        .as_ref()
        .is_some_and(|probe| probe.root == workspace.root())
    {
        if let Some(probe) = probe.take() {
            let _ = probe.tx.send(std::thread::current().id());
        }
    }
}

#[cfg(test)]
fn arm_open_recovery_probe(
    root: std::path::PathBuf,
    tx: std::sync::mpsc::Sender<std::thread::ThreadId>,
) {
    let slot = OPEN_RECOVERY_PROBE.get_or_init(|| std::sync::Mutex::new(None));
    *slot.lock().unwrap() = Some(OpenRecoveryProbe { root, tx });
}

#[cfg(test)]
struct OpenRebuildProbe {
    root: std::path::PathBuf,
    started: std::sync::mpsc::Sender<()>,
    release: std::sync::mpsc::Receiver<()>,
}

#[cfg(test)]
static OPEN_REBUILD_PROBE: std::sync::OnceLock<std::sync::Mutex<Option<OpenRebuildProbe>>> =
    std::sync::OnceLock::new();

#[cfg(test)]
fn open_rebuild_probe(workspace: &Workspace, cancel: Option<&AtomicBool>) {
    let slot = OPEN_REBUILD_PROBE.get_or_init(|| std::sync::Mutex::new(None));
    let probe = {
        let mut probe = slot.lock().unwrap();
        if probe
            .as_ref()
            .is_some_and(|probe| probe.root == workspace.root())
        {
            probe.take()
        } else {
            None
        }
    };
    let Some(probe) = probe else {
        return;
    };
    let _ = probe.started.send(());
    loop {
        if cancel.is_some_and(|cancel| cancel.load(Ordering::Acquire)) {
            return;
        }
        match probe
            .release
            .recv_timeout(std::time::Duration::from_millis(2))
        {
            Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
}

#[cfg(test)]
fn arm_open_rebuild_probe(
    root: std::path::PathBuf,
    started: std::sync::mpsc::Sender<()>,
    release: std::sync::mpsc::Receiver<()>,
) {
    let slot = OPEN_REBUILD_PROBE.get_or_init(|| std::sync::Mutex::new(None));
    *slot.lock().unwrap() = Some(OpenRebuildProbe {
        root,
        started,
        release,
    });
}

// Test-only hook fired by `index_file_inner` between the `stat`
// and `read` syscalls so tests can deterministically simulate a
// concurrent writer landing in that window. The hook is a
// thread-local one-shot: `take()`'d on fire so a single
// `index_file` invocation triggers it at most once. In production
// builds the entire helper is `cfg(test)`-gated and there is no
// call site.
#[cfg(test)]
thread_local! {
    static INDEX_FILE_STAT_READ_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn index_file_between_stat_and_read_hook() {
    let hook = INDEX_FILE_STAT_READ_HOOK.with(|h| h.borrow_mut().take());
    if let Some(f) = hook {
        f();
    }
}

/// Arm the one-shot stat/read interleave hook for tests. The next
/// `index_file_inner` call on this thread fires `f` after the stat
/// and before the read, then clears the slot.
#[cfg(test)]
fn arm_index_file_stat_read_hook(f: Box<dyn FnOnce()>) {
    INDEX_FILE_STAT_READ_HOOK.with(|h| *h.borrow_mut() = Some(f));
}

/// Map a `std::io::Error` returned by a cap-std op into our error
/// enum. cap-std rejects sandbox escapes (mid-path symlink pointing
/// outside the dir handle, absolute path passed as rel, `..` that
/// would walk above the root) with a generic io::Error; the message
/// it produces ("a path led outside of the filesystem") is the only
/// portable signal we have to distinguish "you tried to escape"
/// from "regular I/O error". Fragile if cap-std changes the string;
/// a regression test in this module pins it.
fn map_cap_err(err: std::io::Error, rel: &std::path::Path) -> ChanError {
    let msg = err.to_string();
    if msg.contains("outside of the filesystem") || msg.contains("path escape") {
        return ChanError::SymlinkEscape(rel.to_path_buf());
    }
    ChanError::Io(msg)
}

/// cap-std variant of `mtime_secs` for `cap_std::fs::Metadata`.
fn mtime_secs_cap(meta: &cap_std::fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()
        .map(|t| t.into_std())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
}

/// cap-std variant of `mtime_ns` for `cap_std::fs::Metadata`.
fn mtime_ns_cap(meta: &cap_std::fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()
        .map(|t| t.into_std())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|d| i64::try_from(d.as_nanos()).ok())
}

fn file_stat_from_cap(meta: &cap_std::fs::Metadata) -> FileStat {
    FileStat {
        size: if meta.is_dir() { 0 } else { meta.len() },
        mtime: mtime_secs_cap(meta),
        mtime_ns: mtime_ns_cap(meta),
        is_dir: meta.is_dir(),
    }
}

fn path_kind_cap(ft: &cap_std::fs::FileType) -> fs_ops::PathKind {
    if ft.is_dir() {
        return fs_ops::PathKind::Directory;
    }
    if ft.is_symlink() {
        return fs_ops::PathKind::Symlink;
    }
    if ft.is_file() {
        return fs_ops::PathKind::RegularFile;
    }
    #[cfg(unix)]
    {
        use cap_std::fs::FileTypeExt;
        if ft.is_fifo() {
            return fs_ops::PathKind::Fifo;
        }
        if ft.is_socket() {
            return fs_ops::PathKind::Socket;
        }
        if ft.is_block_device() {
            return fs_ops::PathKind::BlockDevice;
        }
        if ft.is_char_device() {
            return fs_ops::PathKind::CharDevice;
        }
    }
    fs_ops::PathKind::Other
}

/// Human-readable name for a cap-std `FileType`. Mirrors
/// `fs_ops::describe_file_kind`. cap-std exposes the same is_*
/// predicates plus the unix-only fifo/socket/char/block via
/// `FileTypeExt`.
fn describe_cap_file_kind(ft: &cap_std::fs::FileType) -> &'static str {
    if ft.is_dir() {
        return "directory";
    }
    if ft.is_symlink() {
        return "symlink";
    }
    if ft.is_file() {
        return "regular";
    }
    #[cfg(unix)]
    {
        use cap_std::fs::FileTypeExt;
        if ft.is_fifo() {
            return "fifo";
        }
        if ft.is_socket() {
            return "socket";
        }
        if ft.is_char_device() {
            return "char_device";
        }
        if ft.is_block_device() {
            return "block_device";
        }
    }
    "unknown"
}

/// cap-std equivalent of `fs_ops::ensure_regular_file`. Lstat
/// through the sandboxed `Dir`; refuse anything that isn't a real
/// regular file (symlink / FIFO / socket / device / directory).
fn ensure_regular_file_in(dir: &cap_std::fs::Dir, rel: &std::path::Path) -> Result<()> {
    let meta = dir.symlink_metadata(rel).map_err(|e| map_cap_err(e, rel))?;
    let ft = meta.file_type();
    if ft.is_file() && !ft.is_symlink() {
        return Ok(());
    }
    Err(ChanError::SpecialFile {
        kind: describe_cap_file_kind(&ft).to_string(),
        path: rel.to_path_buf(),
    })
}

/// Parse a file's content into the graph-side structures: the
/// title (for the graph node), the heading list (for graph
/// headings), the outgoing edges (links + tokens), and, for
/// contact-kind files, the joined email list and alias list
/// (both space-separated, lowercased). The search-side chunking is
/// done separately by the index facade.
//
// clippy's `type_complexity` lint fires because the return tuple is
// 6-wide. Folding into a struct would churn every call site in
// `rebuild_graph` + `index_file` for a style win; we keep the
// shape and silence the lint locally.
#[allow(clippy::type_complexity)]
fn parse_for_graph(
    rel: &str,
    raw: &str,
) -> (
    Option<String>,
    crate::graph::NodeKind,
    Vec<markdown::Heading>,
    Vec<crate::graph::Edge>,
    Option<String>,
    Option<String>,
) {
    let fm = markdown::parse_frontmatter(raw);
    let body_src = &raw[fm.body_offset..];
    let headings = markdown::parse_headings(body_src);
    let title = fm
        .data
        .get("title")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .or_else(|| {
            headings
                .iter()
                .find(|h| h.level == 1)
                .map(|h| h.text.clone())
        });
    // `chan.kind` lives under the chan namespace so user frontmatter
    // (which may already carry a `kind:` of its own for app-specific
    // reasons) cannot accidentally tip a regular note into a typed
    // surface. The registry is the extension point for future kinds.
    let node_kind = markdown::chan_kind(&fm.data)
        .map(|spec| spec.node_kind)
        .unwrap_or(crate::graph::NodeKind::File);
    let links = markdown::extract_links(body_src);
    let mut tokens = markdown::extract_tokens(body_src);
    if !fs_ops::is_markdown_file(rel) {
        tokens.retain(|token| {
            !matches!(
                token,
                markdown::Token::Tag { .. } | markdown::Token::Mention { .. }
            )
        });
    }
    let edges = build_edges(rel, &links, &tokens);
    // Email extraction runs only for contact-kind files: a regular
    // note that mentions an email in passing should not get its
    // address mirrored into a `nodes.emails` column the picker can
    // surface, and skipping the scan for File-kind keeps the
    // hot-path cost zero on normal indexes.
    let emails = if matches!(node_kind, crate::graph::NodeKind::Contact) {
        let list = crate::contacts::extract_emails(body_src);
        if list.is_empty() {
            None
        } else {
            Some(list.join(" "))
        }
    } else {
        None
    };
    // Alias extraction: the `aliases:` top-level
    // frontmatter array names alternate strings that `@@<alias>`
    // mentions should resolve to this contact. Skip for File-kind
    // nodes (regular notes have no resolver semantics tied to the
    // word "aliases"); for contacts, lowercase + space-join so the
    // picker / mention resolver can run a single LIKE against the
    // column, mirroring the `emails` pattern.
    let aliases = if matches!(node_kind, crate::graph::NodeKind::Contact) {
        let list = fm
            .data
            .get("aliases")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .map(|s| s.trim().to_ascii_lowercase())
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if list.is_empty() {
            None
        } else {
            Some(list.join(" "))
        }
    } else {
        None
    };
    (title, node_kind, headings, edges, emails, aliases)
}

/// Whether `path` lies under the `prefix` directory. POSIX
/// separators on both sides; ASCII case-insensitive comparison.
///
/// Why case-insensitive: scope filters live in the search/UI layer
/// and reflect the user's mental model of directories, not the
/// filesystem's strict casing. APFS (default) and NTFS are
/// case-insensitive, so a scope of `"Notes"` matching a stored path
/// of `"notes/foo.md"` is what the user wants. ext4 is technically
/// case-sensitive, so the over-match here is theoretical: a user
/// would have to maintain `Notes/` and `notes/` as distinct directories
/// AND ask the search to scope into one without bleeding the other.
/// We accept that minor risk in exchange for predictable UX across
/// platforms. ASCII-only fold (no Unicode) matches the rest of the
/// crate's case-folding policy.
fn path_under(path: &str, prefix: &str) -> bool {
    let prefix = prefix.trim_end_matches('/');
    if prefix.is_empty() {
        return true;
    }
    if path.eq_ignore_ascii_case(prefix) {
        return true;
    }
    // Byte-level check sidesteps any UTF-8 boundary risk if a path
    // contains multibyte chars. We're comparing ASCII, so this is
    // safe and equivalent to the str form.
    let pb = prefix.as_bytes();
    let path_b = path.as_bytes();
    if path_b.len() < pb.len() + 1 {
        return false;
    }
    path_b[..pb.len()].eq_ignore_ascii_case(pb) && path_b[pb.len()] == b'/'
}

/// Canonicalize a workspace-relative POSIX path for use as a mapping key.
/// Strips a leading `./` and a trailing `/`; leaves an empty string
/// for the workspace root. We intentionally do NOT collapse `..` here;
/// the rename API rejects those upstream via the cap-std sandbox.
fn canonical_posix(p: &str) -> String {
    let s = p.strip_prefix("./").unwrap_or(p);
    s.trim_end_matches('/').to_string()
}

/// Split a basename into `(stem, ext)` where `ext` includes the leading
/// dot, for collision-suffix insertion ("foo.md" -> ("foo", ".md") so a
/// collision becomes "foo copy.md"). A dotfile with no other extension
/// ("`.gitignore`") or a name with no dot keeps the whole name as stem
/// and an empty ext, so the suffix appends at the end ("`.gitignore`" ->
/// "`.gitignore copy`"). A trailing dot is treated as part of the stem.
fn split_name_ext(name: &str) -> (String, String) {
    match name.rfind('.') {
        // A leading dot at index 0 is a dotfile prefix, not an ext.
        Some(idx) if idx > 0 && idx < name.len() - 1 => {
            (name[..idx].to_string(), name[idx..].to_string())
        }
        _ => (name.to_string(), String::new()),
    }
}

fn posix_path(path: &std::path::Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Read the persisted rename log from `graph_dir/rename_log.json`.
/// Best-effort: a missing file returns an empty map (fresh workspace,
/// or a clean reindex landed since the last process exit), and a
/// malformed file is logged and discarded rather than blocking
/// `Workspace::open`. The downside of "drop on parse error" is a one-
/// time loss of cross-process rename chain memory; the next reindex
/// rebuilds the graph from the live tree and the log becomes
/// irrelevant anyway.
fn load_rename_log(graph_dir: &std::path::Path) -> HashMap<String, String> {
    let path = graph_dir.join(RENAME_LOG_FILE);
    let raw = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return HashMap::new(),
        Err(e) => {
            tracing::warn!(path = %path.display(), ?e, "failed to read rename_log; starting empty");
            return HashMap::new();
        }
    };
    match serde_json::from_slice::<HashMap<String, String>>(&raw) {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!(
                path = %path.display(),
                ?e,
                "rename_log decode failed; starting empty (next reindex rebuilds anyway)",
            );
            HashMap::new()
        }
    }
}

/// Atomically persist the rename log so the on-disk copy never
/// observes a half-written body. We hold the in-memory mutex while
/// calling this (see `rename_log_append`), so the serialization
/// snapshot is consistent. Atomic-write is required: tearing under
/// power loss would leave a truncated JSON file that
/// `load_rename_log` would refuse and silently drop on next open.
fn persist_rename_log(graph_dir: &std::path::Path, log: &HashMap<String, String>) -> Result<()> {
    std::fs::create_dir_all(graph_dir)?;
    let body =
        serde_json::to_vec(log).map_err(|e| ChanError::Io(format!("rename_log encode: {e}")))?;
    fs_ops::atomic_write(&graph_dir.join(RENAME_LOG_FILE), &body)
}

/// Read the pending-writes journal from
/// `graph_dir/pending_writes.json`. Same best-effort semantics as
/// the rename log: missing file -> empty map; malformed -> warn +
/// empty map. A dropped journal under malformed-JSON is worse than
/// for the rename log (the consumer never replays the journaled
/// op), but the cost of refusing to open the workspace is higher; the
/// next per-file write or full reindex still converges. The next
/// per-file write or `reindex_with` repopulates a consistent
/// state.
fn load_pending_writes(graph_dir: &std::path::Path) -> HashMap<String, PendingOp> {
    let path = graph_dir.join(PENDING_WRITES_FILE);
    let raw = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return HashMap::new(),
        Err(e) => {
            tracing::warn!(
                path = %path.display(),
                ?e,
                "failed to read pending_writes; starting empty",
            );
            return HashMap::new();
        }
    };
    match serde_json::from_slice::<HashMap<String, PendingOp>>(&raw) {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!(
                path = %path.display(),
                ?e,
                "pending_writes decode failed; starting empty (any drift will surface at next save or full reindex)",
            );
            HashMap::new()
        }
    }
}

/// Atomically persist the pending-writes journal. Removes the file
/// entirely when the map is empty so the next `load_pending_writes`
/// short-circuits without a parse, and so an external eye on the
/// graph_dir sees "clean state" instead of "{}".
fn persist_pending_writes(
    graph_dir: &std::path::Path,
    map: &HashMap<String, PendingOp>,
) -> Result<()> {
    let path = graph_dir.join(PENDING_WRITES_FILE);
    if map.is_empty() {
        match std::fs::remove_file(&path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(ChanError::Io(format!("remove pending_writes: {e}"))),
        }
    }
    std::fs::create_dir_all(graph_dir)?;
    let body = serde_json::to_vec(map)
        .map_err(|e| ChanError::Io(format!("pending_writes encode: {e}")))?;
    fs_ops::atomic_write(&path, &body)
}

/// Parent directory of a workspace-rooted POSIX path. Returns the empty
/// string for files at the root (`"foo.md"` -> `""`). Used to seed
/// `normalize_href` so relative link resolution matches the rules in
/// `chan_workspace::markdown::links::normalize_href`.
fn parent_dir(rel: &str) -> String {
    match rel.rfind('/') {
        Some(i) => rel[..i].to_string(),
        None => String::new(),
    }
}

/// Compute a POSIX relative path from `source_dir` to `target`. Both
/// inputs are workspace-rooted (no leading slash). Walks up the source's
/// path until a common prefix with the target is reached, then
/// descends into the target. Returns `"."` if the two are equal.
fn relative_from(source_dir: &str, target: &str) -> String {
    let src_parts: Vec<&str> = if source_dir.is_empty() {
        Vec::new()
    } else {
        source_dir.split('/').collect()
    };
    let tgt_parts: Vec<&str> = if target.is_empty() {
        Vec::new()
    } else {
        target.split('/').collect()
    };
    let mut common = 0usize;
    while common < src_parts.len()
        && common < tgt_parts.len()
        && src_parts[common] == tgt_parts[common]
    {
        common += 1;
    }
    let ups = src_parts.len() - common;
    let mut out = String::new();
    for _ in 0..ups {
        out.push_str("../");
    }
    if common < tgt_parts.len() {
        out.push_str(&tgt_parts[common..].join("/"));
    }
    if out.is_empty() {
        ".".to_string()
    } else {
        out.trim_end_matches('/').to_string()
    }
}

/// Rewrite-callback wired to `Workspace::rename_with_link_rewrite`. Given
/// one link surfaced by the markdown scanner, returns `Some(new_href)`
/// to replace it. Resolves the link against the source's PRE-rename
/// directory (so a self-referential link inside a moved file still
/// resolves to the right target), maps the resolved target through
/// the rename, and reconstructs the href preserving its flavor
/// (workspace-rooted vs. `./` explicit vs. bare vs. `../`-rooted) and
/// the `?query` / `#anchor` suffix.
fn rewrite_href_for_move(
    link: markdown::links::LinkRef<'_>,
    src_old_dir: &str,
    src_new_dir: &str,
    mapping: &HashMap<String, String>,
) -> Option<String> {
    let href = link.href;
    // Split path vs ?query / #anchor.
    let (path_part, suffix) = split_path_suffix(href);
    if path_part.is_empty() {
        return None;
    }
    // Wiki convention (mirrors `build_edges`): a bare or `/`-prefixed
    // wiki target is workspace-rooted, NOT source-relative. Only `./` or
    // `../` prefixes flip it to source-relative. Standard markdown
    // hrefs follow ordinary relative-path semantics.
    let normalized_target = if matches!(link.kind, markdown::links::LinkRefKind::Wiki)
        && !path_part.starts_with("./")
        && !path_part.starts_with("../")
    {
        format!("/{}", path_part.trim_start_matches('/'))
    } else {
        path_part.to_string()
    };
    let resolved_old = markdown::links::normalize_href(&normalized_target, src_old_dir)?;
    let resolved_new = mapping
        .get(&resolved_old)
        .cloned()
        .unwrap_or_else(|| resolved_old.clone());
    // If the target didn't move AND the source didn't move, nothing
    // to do; bail before allocating the replacement string.
    if resolved_old == resolved_new && src_old_dir == src_new_dir {
        return None;
    }
    // Reconstruct the href as a relative path. Workspace-rooted forms
    // (markdown `/path` and wiki bare `[[name]]`) read as filesystem-
    // rooted to anything that isn't chan's own renderer (browsers,
    // GitHub, Obsidian on export), so every rewrite pass migrates
    // them to the round-trippable relative form. Wiki bare `[[name]]`
    // resolves to workspace root by chan's pre-existing convention, so
    // wiki rewrites MUST use an explicit `./` or `../` prefix to be
    // unambiguous as relative.
    let rel = relative_from(src_new_dir, &resolved_new);
    let new_path = match link.kind {
        markdown::links::LinkRefKind::Wiki => {
            if rel.starts_with("../") || rel == "." {
                rel
            } else {
                format!("./{rel}")
            }
        }
        markdown::links::LinkRefKind::Markdown => {
            // Same shape as wiki except the bare form is meaningful
            // for standard markdown links (it's a sibling-relative
            // path), so we only emit the `./` prefix when the original
            // had it OR when the original was workspace-rooted.
            let dot_explicit = path_part.starts_with('/') || path_part.starts_with("./");
            if dot_explicit && !rel.starts_with("../") && rel != "." {
                format!("./{rel}")
            } else {
                rel
            }
        }
    };
    let new_href = format!("{new_path}{suffix}");
    if new_href == href {
        None
    } else {
        Some(new_href)
    }
}

/// Split a link href into (path, suffix) where suffix is the first
/// `?query` / `#anchor` and everything after it. Either side may be
/// empty; whichever delimiter appears first wins.
fn split_path_suffix(href: &str) -> (&str, &str) {
    let q = href.find('?');
    let a = href.find('#');
    let cut = match (q, a) {
        (Some(qi), Some(ai)) => Some(qi.min(ai)),
        (Some(qi), None) => Some(qi),
        (None, Some(ai)) => Some(ai),
        (None, None) => None,
    };
    match cut {
        Some(i) => (&href[..i], &href[i..]),
        None => (href, ""),
    }
}

#[cfg(test)]
mod cap_err_tests {
    use super::map_cap_err;
    use crate::error::ChanError;
    use std::io;
    use std::path::Path;

    /// Pin the cap-std error-string match. If cap-std ever rewords
    /// the message we use to detect a sandbox escape, this test
    /// fails and we fix the matcher in `map_cap_err`. Without this
    /// pin a silent regression would let "you tried to escape" land
    /// as a generic `Io` and break `ChanError::SymlinkEscape`
    /// callers.
    #[test]
    fn maps_cap_std_escape_message_to_symlink_escape() {
        let e = io::Error::other("a path led outside of the filesystem");
        let mapped = map_cap_err(e, Path::new("notes/x.md"));
        assert!(matches!(mapped, ChanError::SymlinkEscape(_)));
    }

    #[test]
    fn maps_other_io_errors_passthrough_to_io() {
        let e = io::Error::new(io::ErrorKind::PermissionDenied, "denied");
        let mapped = map_cap_err(e, Path::new("notes/x.md"));
        assert!(matches!(mapped, ChanError::Io(_)));
    }
}

#[cfg(test)]
mod path_under_tests {
    use super::path_under;

    #[test]
    fn matches_exact_and_descendant() {
        assert!(path_under("notes", "notes"));
        assert!(path_under("notes/a.md", "notes"));
        assert!(path_under("notes/sub/a.md", "notes"));
    }

    #[test]
    fn empty_prefix_matches_anything() {
        assert!(path_under("any/thing.md", ""));
        assert!(path_under("any/thing.md", "/"));
    }

    #[test]
    fn rejects_sibling_prefix_share() {
        // "notes-archive" must not match scope "notes".
        assert!(!path_under("notes-archive/a.md", "notes"));
    }

    #[test]
    fn case_insensitive_ascii() {
        assert!(path_under("Notes/a.md", "notes"));
        assert!(path_under("notes/a.md", "NOTES"));
        assert!(path_under("Notes/Sub/a.md", "notes/sub"));
    }

    #[test]
    fn trailing_slash_on_prefix_is_normalized() {
        assert!(path_under("notes/a.md", "notes/"));
        assert!(path_under("notes", "notes/"));
    }

    #[test]
    fn does_not_panic_on_multibyte_paths() {
        // Real-world: a directory named with non-ASCII. The byte-level
        // boundary check shouldn't trip.
        assert!(path_under("Café/a.md", "Café"));
        assert!(!path_under("Other/a.md", "Café"));
    }
}

/// Convert links + tokens into graph edges. Wiki links and
/// internal markdown links produce `Link` edges; tokens produce
/// `Tag` / `Mention` edges. External links (http://, mailto:) are
/// dropped because they don't connect to anything else in the
/// workspace's graph.
///
/// Markdown link hrefs (`[label](href)`) and image embeds
/// (`![alt](src)`) are run through `markdown::normalize_href` so
/// `/abs` and `../rel` write the same workspace-relative dst as the
/// equivalent bare path. Wiki-link targets (`[[name]]`) keep the
/// existing workspace-rooted-by-default convention; an explicit `./`
/// or `..` prefix opts into source-relative resolution.
fn build_edges(
    src: &str,
    links: &[markdown::Link],
    tokens: &[markdown::Token],
) -> Vec<crate::graph::Edge> {
    use crate::graph::{Edge, EdgeKind};
    let source_dir = match src.rfind('/') {
        Some(i) => &src[..i],
        None => "",
    };
    let mut out = Vec::new();
    for l in links {
        // Wiki-link convention: bare `[[name]]` and `[[a/b]]` are
        // workspace-rooted (the picker has always inserted them this
        // way). An explicit `./` / `..` prefix flips to source-
        // relative. Markdown links use standard relative semantics.
        let normalize_target = if l.wiki && !is_relative_marker(&l.target) {
            format!("/{}", l.target.trim_start_matches('/'))
        } else {
            l.target.clone()
        };
        let Some(dst) = markdown::normalize_href(&normalize_target, source_dir) else {
            continue;
        };
        // Anchors only mean something for markdown targets (heading
        // refs like `note.md#section`). For images/PDFs/etc. the `#`
        // suffix is an Obsidian-style param (`img.png#width=300`),
        // not a heading anchor, so drop it.
        let (_, anchor) = split_anchor(&l.target);
        let anchor = if dst.ends_with(".md") { anchor } else { None };
        out.push(Edge {
            src: src.to_string(),
            dst,
            kind: EdgeKind::Link,
            anchor,
        });
    }
    for t in tokens {
        match t {
            markdown::Token::Tag { name } => out.push(Edge {
                src: src.to_string(),
                dst: format!("#{name}"),
                kind: EdgeKind::Tag,
                anchor: None,
            }),
            markdown::Token::Mention { name } => out.push(Edge {
                src: src.to_string(),
                dst: format!("@@{name}"),
                kind: EdgeKind::Mention,
                anchor: None,
            }),
            // Dates aren't graph edges yet; the graph view groups
            // files by date through a future query rather than a
            // stored edge. Skip for now.
            markdown::Token::Date { .. } => {}
        }
    }
    out
}

/// True when a wiki-link target opts into source-relative resolution
/// via a leading `./` or `..` segment. Plain `[[name]]` and `[[a/b]]`
/// stay workspace-rooted (the picker's existing convention).
fn is_relative_marker(target: &str) -> bool {
    target == "." || target == ".." || target.starts_with("./") || target.starts_with("../")
}

/// Split a link target into (path, anchor). `path#section` becomes
/// `("path", Some("section"))`; a target without `#` returns
/// `(target, None)`.
fn split_anchor(target: &str) -> (String, Option<String>) {
    match target.split_once('#') {
        Some((p, a)) if !a.is_empty() => (p.to_string(), Some(a.to_string())),
        _ => (target.to_string(), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::Library;
    use tempfile::TempDir;

    fn fixture() -> (TempDir, TempDir, Arc<Workspace>) {
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();
        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        (cfg, workspace_dir, workspace)
    }

    fn await_recovery_ready(workspace: &Workspace) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while !workspace.recovery_status().is_ready() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(
            workspace.recovery_status().is_ready(),
            "background startup recovery did not converge: {:?}",
            workspace.recovery_status()
        );
    }

    #[test]
    fn recovery_generation_signal_during_active_forces_follow_up() {
        let (_cfg, _root, workspace) = fixture();
        assert!(workspace.recovery_status().is_ready());

        let first_generation = workspace.request_policy_recovery(RecoveryAction::Reconcile);
        let first = workspace.begin_recovery().unwrap();
        assert_eq!(first.generation, first_generation);
        assert_eq!(first.action, RecoveryAction::Reconcile);

        let second_generation = workspace.request_policy_recovery(RecoveryAction::FullRebuild);
        assert!(second_generation > first_generation);
        let during = workspace.recovery_status();
        assert_eq!(during.active, Some(first));
        assert_eq!(
            during.pending,
            Some(RecoveryPass {
                generation: second_generation,
                action: RecoveryAction::FullRebuild,
            })
        );
        assert!(!during.is_ready());

        let after_first = workspace
            .finish_recovery(first, RecoveryOutcome::Complete)
            .unwrap();
        assert_eq!(after_first.completed_generation, first_generation);
        assert_eq!(
            after_first.required_action(),
            Some(RecoveryAction::FullRebuild)
        );

        let second = workspace.begin_recovery().unwrap();
        workspace
            .finish_recovery(second, RecoveryOutcome::Complete)
            .unwrap();
        assert!(workspace.recovery_status().is_ready());
    }

    #[test]
    fn readiness_projection_exposes_active_and_follow_up_generations() {
        let (_cfg, _root, workspace) = fixture();
        let first_generation = workspace.request_policy_recovery(RecoveryAction::Reconcile);
        let first = workspace.begin_recovery().unwrap();
        let required_generation = workspace.request_policy_recovery(RecoveryAction::FullRebuild);

        let readiness = workspace.readiness();
        assert_eq!(
            serde_json::to_value(readiness).unwrap(),
            serde_json::json!({
                "state": "recovering",
                "generation": required_generation.get(),
                "completed_generation": 0,
                "required_action": "full_rebuild",
                "active_generation": first_generation.get(),
                "pending_generation": required_generation.get(),
            })
        );

        workspace
            .finish_recovery(first, RecoveryOutcome::Complete)
            .unwrap();
    }

    #[test]
    fn recovery_generation_provider_errors_coalesce_one_pending_pass() {
        let (_cfg, _root, workspace) = fixture();
        workspace.request_recovery(RecoveryAction::Reconcile);
        let active = workspace.begin_recovery().unwrap();

        let pending_generation = workspace.request_recovery(RecoveryAction::Reconcile);
        assert_eq!(
            workspace.request_recovery(RecoveryAction::Reconcile),
            pending_generation
        );
        assert_eq!(
            workspace.request_recovery(RecoveryAction::FullRebuild),
            pending_generation
        );

        let status = workspace.recovery_status();
        assert_eq!(status.generation, pending_generation);
        assert_eq!(
            status.pending,
            Some(RecoveryPass {
                generation: pending_generation,
                action: RecoveryAction::FullRebuild,
            })
        );

        workspace
            .finish_recovery(active, RecoveryOutcome::Complete)
            .unwrap();
        let follow_up = workspace.begin_recovery().unwrap();
        assert_eq!(follow_up.generation, pending_generation);
        assert_eq!(follow_up.action, RecoveryAction::FullRebuild);
    }

    #[test]
    fn recovery_generation_policy_requests_advance_and_discard_stale_tag() {
        let (_cfg, _root, workspace) = fixture();
        let stale_generation = workspace.request_policy_recovery(RecoveryAction::Replay);
        let current_generation = workspace.request_policy_recovery(RecoveryAction::Reconcile);

        assert!(current_generation > stale_generation);
        assert_eq!(workspace.generation(), current_generation);
        let current = workspace.begin_recovery().unwrap();
        assert_eq!(current.generation, current_generation);
        assert_eq!(current.action, RecoveryAction::Reconcile);
        assert!(workspace
            .finish_recovery(
                RecoveryPass {
                    generation: stale_generation,
                    action: RecoveryAction::Replay,
                },
                RecoveryOutcome::Complete,
            )
            .is_err());
        assert_eq!(workspace.recovery_status().active, Some(current));
    }

    fn assert_waits_for_write_serial(
        workspace: &Arc<Workspace>,
        operation: impl FnOnce(Arc<Workspace>) + Send + 'static,
    ) {
        let guard = workspace.write_serial.lock().unwrap();
        let worker_workspace = Arc::clone(workspace);
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (completed_tx, completed_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            operation(worker_workspace);
            completed_tx.send(()).unwrap();
        });

        started_rx.recv().unwrap();
        assert!(
            completed_rx
                .recv_timeout(std::time::Duration::from_millis(250))
                .is_err(),
            "derived-state mutation bypassed write_serial"
        );
        drop(guard);
        completed_rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("derived-state mutation did not resume after write_serial released");
        worker.join().unwrap();
    }

    #[test]
    fn serialize_all_derived_mutations_share_write_serial() {
        let (_cfg, _root, workspace) = fixture();
        workspace.write_text("a.md", "# a\nserial-token\n").unwrap();

        assert_waits_for_write_serial(&workspace, |workspace| {
            workspace.index_file("a.md").unwrap();
        });
        assert_waits_for_write_serial(&workspace, |workspace| {
            workspace.replay_pending_writes().unwrap();
        });
        assert_waits_for_write_serial(&workspace, |workspace| {
            workspace.reconcile().unwrap();
        });
        assert_waits_for_write_serial(&workspace, |workspace| {
            workspace.reindex(None).unwrap();
        });
    }

    struct ChannelWatchCallback(std::sync::Mutex<std::sync::mpsc::Sender<crate::WatchEvent>>);

    impl crate::WatchCallback for ChannelWatchCallback {
        fn on_event(&self, event: crate::WatchEvent) {
            let _ = self.0.lock().unwrap().send(event);
        }
    }

    #[test]
    fn serialize_report_mutation_uses_write_serial() {
        let (_cfg, _root, workspace) = fixture();
        workspace.write_text("report.md", "# before\n").unwrap();
        workspace.report().unwrap();

        let (event_tx, event_rx) = std::sync::mpsc::channel();
        let callback: Arc<dyn crate::WatchCallback> =
            Arc::new(ChannelWatchCallback(std::sync::Mutex::new(event_tx)));
        let fan = ReportFanOut::new(
            callback,
            Arc::clone(&workspace.report),
            Arc::clone(&workspace.write_serial),
        );

        let guard = workspace.write_serial.lock().unwrap();
        workspace.write_text("report.md", "# after\n").unwrap();
        let generation = workspace.generation();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            fan.on_event(crate::WatchEvent::file(
                crate::WatchKind::Modified,
                "report.md",
                generation,
            ));
        });
        started_rx.recv().unwrap();
        assert!(
            event_rx
                .recv_timeout(std::time::Duration::from_millis(250))
                .is_err(),
            "report mutation bypassed write_serial"
        );
        drop(guard);
        event_rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("report mutation did not resume after write_serial released");
        worker.join().unwrap();
    }

    #[test]
    fn serialize_queries_and_file_streams_remain_lock_free() {
        let (_cfg, _root, workspace) = fixture();
        workspace
            .write_text("query.md", "# query\nlock-free-token\n")
            .unwrap();
        workspace.index_file("query.md").unwrap();
        workspace.report().unwrap();

        let guard = workspace.write_serial.lock().unwrap();
        let worker_workspace = Arc::clone(&workspace);
        let (completed_tx, completed_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            assert_eq!(
                worker_workspace.read_text("query.md").unwrap(),
                "# query\nlock-free-token\n"
            );
            let bytes = worker_workspace
                .read_bytes_bounded("query.md")
                .unwrap()
                .collect::<Result<Vec<_>>>()
                .unwrap()
                .concat();
            assert_eq!(bytes, b"# query\nlock-free-token\n");
            assert!(!worker_workspace
                .search(
                    "lock-free-token",
                    &SearchOpts {
                        mode: crate::SearchMode::Bm25,
                        limit: 10,
                        scope: None,
                    },
                )
                .unwrap()
                .hits
                .is_empty());
            assert!(!worker_workspace
                .graph()
                .unwrap()
                .files()
                .unwrap()
                .is_empty());
            assert!(worker_workspace.report_if_available().unwrap().is_some());
            completed_tx.send(()).unwrap();
        });
        completed_rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("query or file stream waited for write_serial");
        drop(guard);
        worker.join().unwrap();
    }

    #[test]
    fn write_then_read_text_round_trips() {
        let (_cfg, _root, workspace) = fixture();
        workspace.write_text("notes/a.md", "hello").unwrap();
        assert_eq!(workspace.read_text("notes/a.md").unwrap(), "hello");
    }

    #[test]
    fn read_text_sniffs_unknown_extension_text() {
        // B11: the editable-text gate falls back to a content sniff for
        // files the extension classifier types as Other. A UTF-8,
        // NUL-free `.service` file opens; a NUL-bearing one does not.
        let (_cfg, root, workspace) = fixture();
        std::fs::write(root.path().join("app.service"), "[Unit]\nX=1\n").unwrap();
        std::fs::write(root.path().join("blob.weird"), [b'o', b'k', 0u8, 9]).unwrap();

        assert!(workspace.sniff_is_text("app.service"));
        assert_eq!(workspace.read_text("app.service").unwrap(), "[Unit]\nX=1\n");

        assert!(!workspace.sniff_is_text("blob.weird"));
        assert!(matches!(
            workspace.read_text("blob.weird"),
            Err(ChanError::NotEditableText(_))
        ));
    }

    #[test]
    fn rename_log_persists_across_workspace_reopen() {
        // Simulate "process kill after a rename, restart": rename
        // A.md -> B.md once, drop the workspace (and so the in-memory
        // log), then re-open. The persisted sidecar must hydrate
        // the new in-memory log so a subsequent rename B.md -> C.md
        // still knows that A.md once mapped to B.md.
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();

        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();
        // Resolve paths after register so the lookup uses the
        // registry-assigned metadata key rather than guessing from
        // the path.
        let paths = lib.workspace_paths_for(workspace_dir.path()).unwrap();
        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        workspace.write_text("A.md", "# A\n").unwrap();
        workspace.rename_with_link_rewrite("A.md", "B.md").unwrap();

        // Sidecar must exist with the (A -> B) entry.
        let log_path = paths.graph_dir.join(RENAME_LOG_FILE);
        assert!(
            log_path.exists(),
            "rename_log.json should exist after first rename"
        );
        let raw = std::fs::read(&log_path).unwrap();
        let parsed: std::collections::HashMap<String, String> =
            serde_json::from_slice(&raw).unwrap();
        assert_eq!(parsed.get("A.md").map(String::as_str), Some("B.md"));

        // Drop and re-open: in-memory log starts empty, hydrates
        // from the sidecar.
        drop(workspace);
        let workspace2 = lib.open_workspace(workspace_dir.path()).unwrap();
        {
            let mem = workspace2.rename_log.lock().unwrap();
            assert_eq!(
                mem.get("A.md").map(String::as_str),
                Some("B.md"),
                "rename log should reload from disk: {:?}",
                *mem,
            );
        }
        // A follow-up rename transitively updates both old and new
        // names so the entry rewrite covers the cross-process chain.
        workspace2.rename_with_link_rewrite("B.md", "C.md").unwrap();
        {
            let mem = workspace2.rename_log.lock().unwrap();
            assert_eq!(mem.get("A.md").map(String::as_str), Some("C.md"));
            assert_eq!(mem.get("B.md").map(String::as_str), Some("C.md"));
        }
        let raw2 = std::fs::read(&log_path).unwrap();
        let parsed2: std::collections::HashMap<String, String> =
            serde_json::from_slice(&raw2).unwrap();
        assert_eq!(parsed2.get("A.md").map(String::as_str), Some("C.md"));
        assert_eq!(parsed2.get("B.md").map(String::as_str), Some("C.md"));

        // A successful reindex clears both the in-memory map and the
        // sidecar so a stale name doesn't outlive its usefulness.
        workspace2.reindex(None).unwrap();
        assert!(workspace2.rename_log.lock().unwrap().is_empty());
        assert!(
            !log_path.exists(),
            "rename_log.json should be removed after reindex",
        );
    }

    #[test]
    fn needs_rebuild_flag_tracks_marker() {
        // Pre-stamp the rebuild.inprogress marker as if a prior
        // reindex had been killed between graph rebuild and BM25
        // commit. Workspace::open must schedule a full rebuild without
        // performing it on the caller.
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();

        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();
        // Stamp the marker AFTER register so the metadata key is
        // known. Open then drop the workspace once to let the metadata
        // skeleton (graph_dir) come into existence before we plant
        // the marker; otherwise create_dir_all does the same work
        // but explicit-open is the production code path.
        let paths = lib.workspace_paths_for(workspace_dir.path()).unwrap();
        std::fs::create_dir_all(&paths.graph_dir).unwrap();
        let marker = paths.graph_dir.join(REBUILD_MARKER);
        std::fs::write(&marker, b"started_at = 1\n").unwrap();

        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        await_recovery_ready(&workspace);
        assert!(
            !workspace.needs_rebuild(),
            "startup recovery should clear needs_rebuild()",
        );
        assert!(
            !marker.exists(),
            "marker file should be gone after a clean reindex",
        );

        // Sanity: a fresh workspace without a marker reports false from
        // the start so consumers don't reindex every time they open
        // a known-clean workspace.
        let workspace2_dir = TempDir::new().unwrap();
        lib.register_workspace(workspace2_dir.path()).unwrap();
        let workspace2 = lib.open_workspace(workspace2_dir.path()).unwrap();
        assert!(!workspace2.needs_rebuild());
    }

    #[test]
    #[cfg_attr(
        not(target_os = "linux"),
        ignore = "recovery-worker begin-probe timing is sensitive to macOS CI scheduling; recovery correctness is covered by the other recovery tests on all platforms"
    )]
    fn stopping_seeded_full_rebuild_releases_workspace_for_reopen() {
        use std::sync::mpsc::RecvTimeoutError;
        use std::time::Duration;

        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let root = workspace_dir.path();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root).unwrap();
        std::fs::write(root.join("a.md"), "# A\nbody\n").unwrap();
        let paths = lib.workspace_paths_for(root).unwrap();
        std::fs::create_dir_all(&paths.graph_dir).unwrap();
        std::fs::write(
            paths.graph_dir.join(REBUILD_MARKER),
            b"started_at = simulated\n",
        )
        .unwrap();

        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        arm_open_rebuild_probe(root.to_path_buf(), started_tx, release_rx);
        let workspace = lib.open_workspace(root).unwrap();
        started_rx
            .recv_timeout(Duration::from_secs(30))
            .expect("seeded full rebuild did not begin");

        let (stopped_tx, stopped_rx) = std::sync::mpsc::channel();
        let workspace_for_stop = Arc::clone(&workspace);
        let stopper = std::thread::spawn(move || {
            workspace_for_stop.stop_open_recovery();
            let _ = stopped_tx.send(());
        });
        let stopped = stopped_rx.recv_timeout(Duration::from_millis(500));
        if stopped == Err(RecvTimeoutError::Timeout) {
            let _ = release_tx.send(());
        }
        stopper.join().unwrap();
        assert!(
            stopped.is_ok(),
            "startup full rebuild ignored the recovery worker stop signal"
        );

        let weak = Arc::downgrade(&workspace);
        drop(workspace);
        assert_eq!(
            weak.strong_count(),
            0,
            "stopped recovery worker retained the workspace"
        );
        assert!(
            crate::lock::is_free(&paths.lock),
            "stopped recovery worker retained the workspace flock"
        );

        let reopened = lib
            .open_workspace(root)
            .expect("workspace should reopen immediately after recovery teardown");
        reopened.stop_open_recovery();
    }

    /// Snapshot of the queryable end state of a workspace. Two workspaces
    /// (or two states of the same workspace) are "converged" when these
    /// fields match: same graph node set, same search results for a
    /// known token. Used by the crash-recovery tests below as a
    /// convergence oracle.
    #[derive(Debug, PartialEq, Eq)]
    struct RecoveryState {
        graph_files: Vec<String>,
        hit_paths: Vec<String>,
    }

    fn capture_recovery_state(workspace: &Workspace, probe_token: &str) -> RecoveryState {
        let mut graph_files = workspace.graph().unwrap().files().unwrap();
        graph_files.sort();
        let opts = crate::workspace::SearchOpts {
            mode: crate::SearchMode::Bm25,
            limit: 100,
            scope: None,
        };
        let mut hit_paths: Vec<String> = workspace
            .search(probe_token, &opts)
            .unwrap()
            .hits
            .into_iter()
            .map(|h| h.path)
            .collect();
        hit_paths.sort();
        hit_paths.dedup();
        RecoveryState {
            graph_files,
            hit_paths,
        }
    }

    /// Stand up a workspace with a fixed content set so the
    /// crash-recovery tests can compare "what a clean reindex
    /// produces" against "what a post-crash reindex produces."
    fn populate_recoverable_workspace(lib: &Library, root: &std::path::Path) -> &'static str {
        let workspace = lib.open_workspace(root).unwrap();
        workspace
            .write_text("alpha.md", "# alpha\n[[beta]] crash-probe-token in alpha\n")
            .unwrap();
        workspace
            .write_text("beta.md", "# beta\nback to [[alpha]]\n")
            .unwrap();
        workspace
            .write_text("notes/sub.md", "# sub\ncrash-probe-token here too\n")
            .unwrap();
        "crash-probe-token"
    }

    #[test]
    fn reindex_converges_after_marker_only_crash() {
        // Simulate the simplest crash shape: previous run finished
        // building the index but died before clearing the marker.
        // The recovery action ("reindex once more") must produce the
        // same end state as the original clean build. If it does
        // not, recovery is destructive (loses data) or non-idempotent
        // (visible churn between two equivalent states).
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();
        let probe = populate_recoverable_workspace(&lib, workspace_dir.path());
        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        workspace.reindex(None).unwrap();
        let baseline = capture_recovery_state(&workspace, probe);
        drop(workspace);

        // Plant the marker as if the previous reindex had not
        // managed to clear it. Don't touch any other state; we want
        // to isolate the "marker present, store intact" recovery.
        let paths = lib.workspace_paths_for(workspace_dir.path()).unwrap();
        let marker = paths.graph_dir.join(REBUILD_MARKER);
        std::fs::write(&marker, b"started_at = simulated\n").unwrap();

        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        await_recovery_ready(&workspace);
        assert!(
            !workspace.needs_rebuild(),
            "background reindex must clear the flag"
        );
        let recovered = capture_recovery_state(&workspace, probe);
        assert_eq!(
            recovered, baseline,
            "post-crash reindex must converge to the clean-build state",
        );
    }

    #[test]
    fn reindex_converges_after_partial_index_corruption() {
        // Harder crash shape: previous run died between the graph
        // commit and the BM25 commit. We simulate by tearing down
        // the on-disk BM25 segments and re-stamping the marker,
        // leaving the graph DB intact. Reopening must surface the
        // marker, and a follow-up reindex must rebuild BM25 to the
        // same shape as a clean build.
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();
        let probe = populate_recoverable_workspace(&lib, workspace_dir.path());
        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        workspace.reindex(None).unwrap();
        let baseline = capture_recovery_state(&workspace, probe);
        drop(workspace);

        // Simulate the crash: nuke the on-disk BM25 dir + plant
        // the marker. The graph DB stays (graph rebuild ran first
        // and committed), index config stays, vector store stays.
        let paths = lib.workspace_paths_for(workspace_dir.path()).unwrap();
        let bm25_dir = paths.index.join("bm25");
        if bm25_dir.exists() {
            std::fs::remove_dir_all(&bm25_dir).unwrap();
        }
        std::fs::create_dir_all(&paths.graph_dir).unwrap();
        std::fs::write(
            paths.graph_dir.join(REBUILD_MARKER),
            b"started_at = simulated\n",
        )
        .unwrap();

        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        await_recovery_ready(&workspace);
        let recovered = capture_recovery_state(&workspace, probe);
        assert_eq!(
            recovered, baseline,
            "post-crash reindex must rebuild BM25 to the same shape",
        );
        assert!(!workspace.needs_rebuild());
    }

    #[test]
    fn reset_workspace_completes_after_partial_wipe() {
        // Simulate "reset_workspace crashed after wiping some subsystem
        // dirs but before getting to others." Calling reset_workspace
        // again must complete the wipe without erroring on the
        // already-missing dirs. Resumability of destructive ops is
        // load-bearing: a UI that retries on transient failure
        // would otherwise refuse to ever cleanly reset.
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();
        {
            let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
            workspace.write_text("a.md", "alpha\n").unwrap();
            workspace.reindex(None).unwrap();
            workspace.put_session("win-1", b"layout").unwrap();
        }

        let paths = lib.workspace_paths_for(workspace_dir.path()).unwrap();
        assert!(paths.index.exists());
        assert!(paths.graph_db.parent().unwrap().exists());
        assert!(paths.sessions.exists());

        // Simulate the crash: index + sessions removed, graph still
        // there. reset_workspace(State) must mop up the rest without
        // tripping over the missing dirs.
        std::fs::remove_dir_all(&paths.index).unwrap();
        std::fs::remove_dir_all(&paths.sessions).unwrap();
        assert!(paths.graph_db.parent().unwrap().exists());

        let report = lib
            .reset_workspace(workspace_dir.path(), crate::ResetMode::State)
            .unwrap();
        // removed_entries reflects what THIS reset actually wiped;
        // we don't pin a number, only that the operation completed
        // and the post-condition is a clean state.
        let _ = report;
        assert!(!paths.index.exists());
        assert!(!paths.graph_db.parent().unwrap().exists());
        assert!(!paths.sessions.exists());

        // Registry row survives a State-mode reset (Everything would
        // drop it). The workspace is reopenable and reindexes from
        // scratch with no leaked state.
        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        workspace.reindex(None).unwrap();
        assert!(!workspace.needs_rebuild());
    }

    #[test]
    fn reindex_consumes_pending_rename_log_after_reopen() {
        // Cross-process rename chain: a rename produces a durable
        // log entry; if the process dies before the next reindex,
        // the next open hydrates that log and the next reindex must
        // converge the graph to the post-rename tree. End state must
        // match what a clean build of the renamed tree would produce.
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();
        let probe = "rename-recovery-token";
        {
            let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
            workspace
                .write_text("orig.md", &format!("# orig\n{probe} body\n"))
                .unwrap();
            workspace.reindex(None).unwrap();
            workspace
                .rename_with_link_rewrite("orig.md", "renamed.md")
                .unwrap();
        }
        // After drop, the rename_log sidecar must still be present.
        let paths = lib.workspace_paths_for(workspace_dir.path()).unwrap();
        let log_path = paths.graph_dir.join(RENAME_LOG_FILE);
        assert!(
            log_path.exists(),
            "rename_log must persist across drop so the next process can replay it",
        );

        // Reopen + reindex; the recovered state must show the
        // renamed file and only the renamed file, with no trace of
        // the original.
        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        workspace.reindex(None).unwrap();
        let recovered = capture_recovery_state(&workspace, probe);
        assert!(
            recovered.graph_files.iter().any(|f| f == "renamed.md"),
            "graph must reflect the renamed path: {:?}",
            recovered.graph_files,
        );
        assert!(
            !recovered.graph_files.iter().any(|f| f == "orig.md"),
            "graph must not retain the pre-rename path: {:?}",
            recovered.graph_files,
        );
        assert_eq!(
            recovered.hit_paths,
            vec!["renamed.md".to_string()],
            "search must hit only the renamed file",
        );
        assert!(
            !log_path.exists(),
            "rename_log must be cleared after a successful reindex",
        );
    }

    #[test]
    fn pending_writes_journal_is_empty_on_a_clean_path() {
        // A successful index_file must leave no trace in the
        // journal: enter -> record -> graph -> index -> clear.
        // Without this, every save would leak a journal entry and
        // the next open would always flag needs_replay_writes.
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();
        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        workspace.write_text("a.md", "# a\nbody\n").unwrap();
        workspace.index_file("a.md").unwrap();
        assert!(workspace.pending_writes().is_empty());
        assert!(!workspace.needs_replay_writes());

        // Persisted form: the JSON file should be gone (empty map
        // is serialized as "no file" so the journal dir stays
        // visually clean across normal use).
        let paths = lib.workspace_paths_for(workspace_dir.path()).unwrap();
        assert!(!paths.graph_dir.join(PENDING_WRITES_FILE).exists());
    }

    #[test]
    fn write_text_does_not_wait_for_indexer_serial_lock() {
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();
        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();

        // Hold the indexer serialization lock, then race a small write
        // against it. write_text must NOT acquire write_serial, so the
        // write completes while we still hold the guard.
        //
        // The recv timeout is a DEADLOCK BACKSTOP, not a latency budget.
        // If write_text wrongly took write_serial it would block forever
        // (we hold the lock), so the test needs *some* ceiling to fail
        // instead of hang. It is deliberately generous (seconds, not the
        // old 150 ms) so a loaded CI runner's scheduling jitter on a
        // tiny write cannot trip a false failure: the 150 ms budget
        // red-lighted a release once. A
        // correct write finishes in microseconds; only the bug path ever
        // approaches this ceiling.
        let guard = workspace.write_serial.lock().unwrap();
        let workspace_for_write = workspace.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let writer = std::thread::spawn(move || {
            workspace_for_write
                .write_text("fast.md", "# fast\nbody\n")
                .unwrap();
            tx.send(()).unwrap();
        });

        let completed = rx.recv_timeout(std::time::Duration::from_secs(10));
        drop(guard);
        writer.join().unwrap();
        completed.expect("write_text blocked on the indexer serial lock (deadlock backstop hit)");
        assert_eq!(workspace.read_text("fast.md").unwrap(), "# fast\nbody\n");
    }

    #[test]
    fn pending_writes_journal_replay_converges_after_simulated_crash() {
        // Simulate the crash window: a journal entry is left behind
        // as if index_file had committed graph but died before the
        // search index commit (or before journal_clear). Reopen,
        // verify the flag, replay, verify convergence.
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();
        let probe = "pending-recovery-token";
        {
            let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
            workspace
                .write_text("a.md", &format!("# a\n{probe} body\n"))
                .unwrap();
            // Stamp a journal entry as if index_file had crashed
            // mid-call, BEFORE running any backend commits. The
            // file's content is fresh on disk; neither graph nor
            // index have seen it yet.
            let mut map = HashMap::new();
            map.insert("a.md".to_string(), PendingOp::Index);
            persist_pending_writes(&workspace.paths.graph_dir, &map).unwrap();
        }

        // Reopen schedules the durable journal replay off the caller.
        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        await_recovery_ready(&workspace);
        assert!(!workspace.needs_replay_writes());
        assert!(workspace.pending_writes().is_empty());

        let opts = crate::workspace::SearchOpts {
            mode: crate::SearchMode::Bm25,
            limit: 10,
            scope: None,
        };
        let hits = workspace.search(probe, &opts).unwrap();
        assert_eq!(hits.hits.len(), 1);
        assert_eq!(hits.hits[0].path, "a.md");
        assert!(workspace
            .graph()
            .unwrap()
            .files()
            .unwrap()
            .iter()
            .any(|f| f == "a.md"));
    }

    #[test]
    fn pending_writes_replay_degrades_index_op_to_forget_when_file_is_gone() {
        // index_file was journaled before the crash, but between
        // the crash and the replay the user deleted the file from
        // disk. Replay must degrade to forget so the journal entry
        // does not perpetually fail trying to index a missing file.
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();
        {
            let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
            workspace.write_text("ghost.md", "# ghost\nbody\n").unwrap();
            // Index the file so graph + BM25 see it...
            workspace.index_file("ghost.md").unwrap();
            // ...then plant a journal entry as if a follow-up
            // index_file had crashed, and remove the file from
            // disk to simulate "user also deleted it before
            // process restart."
            std::fs::remove_file(workspace_dir.path().join("ghost.md")).unwrap();
            let mut map = HashMap::new();
            map.insert("ghost.md".to_string(), PendingOp::Index);
            persist_pending_writes(&workspace.paths.graph_dir, &map).unwrap();
        }

        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        await_recovery_ready(&workspace);
        assert!(!workspace.needs_replay_writes());

        // After replay the entry should be gone from both backends.
        let opts = crate::workspace::SearchOpts {
            mode: crate::SearchMode::Bm25,
            limit: 10,
            scope: None,
        };
        assert!(workspace.search("ghost", &opts).unwrap().hits.is_empty());
        assert!(!workspace
            .graph()
            .unwrap()
            .files()
            .unwrap()
            .iter()
            .any(|f| f == "ghost.md"));
    }

    #[test]
    fn pending_writes_journal_handles_forget_op() {
        // Symmetric to the index_op replay test: a forget_file
        // call that crashed mid-flight has its journal entry
        // replayed and the backends converge to "no entry."
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();
        {
            let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
            workspace
                .write_text("doomed.md", "# doomed\nbody\n")
                .unwrap();
            workspace.index_file("doomed.md").unwrap();
            // Simulate: forget_file was about to run but crashed
            // after journaling. File is still on disk; journal
            // says "forget."
            let mut map = HashMap::new();
            map.insert("doomed.md".to_string(), PendingOp::Forget);
            persist_pending_writes(&workspace.paths.graph_dir, &map).unwrap();
        }

        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        await_recovery_ready(&workspace);

        let opts = crate::workspace::SearchOpts {
            mode: crate::SearchMode::Bm25,
            limit: 10,
            scope: None,
        };
        assert!(workspace.search("doomed", &opts).unwrap().hits.is_empty());
        assert!(!workspace
            .graph()
            .unwrap()
            .files()
            .unwrap()
            .iter()
            .any(|f| f == "doomed.md"));
    }

    #[test]
    fn reconcile_is_noop_when_disk_matches_graph() {
        // Steady state after a clean reindex: every file on disk
        // has a graph row with matching mtime. Reconcile must
        // touch nothing and report all-unchanged.
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();
        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        workspace.write_text("a.md", "# a\nalpha\n").unwrap();
        workspace.write_text("b.md", "# b\nbeta\n").unwrap();
        workspace.reindex(None).unwrap();

        let report = workspace.reconcile().unwrap();
        assert!(report.upserted.is_empty());
        assert!(report.forgotten.is_empty());
        assert_eq!(report.unchanged, 2);
    }

    #[test]
    fn reconcile_picks_up_files_added_offline() {
        // Simulate "user added files while the watcher was down":
        // the graph snapshot is missing entries that exist on disk.
        // Reconcile must index them and end state must match a
        // fresh reindex.
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();
        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        workspace.write_text("a.md", "# a\nalpha\n").unwrap();
        workspace.reindex(None).unwrap();
        // Add a file directly through write_text (skip index_file
        // to mimic "watcher missed it").
        workspace
            .write_text("c.md", "# c\nreconcile-token gamma\n")
            .unwrap();

        let report = workspace.reconcile().unwrap();
        assert_eq!(report.upserted, vec!["c.md".to_string()]);
        assert!(report.forgotten.is_empty());
        assert_eq!(report.unchanged, 1);

        // End state matches a clean reindex: search hits c.md.
        let opts = crate::workspace::SearchOpts {
            mode: crate::SearchMode::Bm25,
            limit: 10,
            scope: None,
        };
        let hits = workspace.search("reconcile-token", &opts).unwrap();
        assert_eq!(hits.hits.len(), 1);
        assert_eq!(hits.hits[0].path, "c.md");
    }

    #[test]
    fn reconcile_forgets_files_removed_offline() {
        // Symmetric to the add case: a file in the graph is gone
        // from disk. Reconcile drops it from both backends.
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();
        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        workspace
            .write_text("doomed.md", "# doomed\nbye-token\n")
            .unwrap();
        workspace
            .write_text("kept.md", "# kept\nkeep-token\n")
            .unwrap();
        workspace.reindex(None).unwrap();

        // Remove the file directly (mimic watcher miss / external rm).
        std::fs::remove_file(workspace_dir.path().join("doomed.md")).unwrap();

        let report = workspace.reconcile().unwrap();
        assert!(report.upserted.is_empty());
        assert_eq!(report.forgotten, vec!["doomed.md".to_string()]);
        assert_eq!(report.unchanged, 1);

        let opts = crate::workspace::SearchOpts {
            mode: crate::SearchMode::Bm25,
            limit: 10,
            scope: None,
        };
        assert!(workspace
            .search("bye-token", &opts)
            .unwrap()
            .hits
            .is_empty());
        assert!(!workspace
            .graph()
            .unwrap()
            .files()
            .unwrap()
            .iter()
            .any(|f| f == "doomed.md"));
    }

    #[test]
    fn reconcile_picks_up_modified_files() {
        // A file's mtime changed since the last index but the
        // watcher missed the modify event. Reconcile detects the
        // mtime diff and refreshes the indices. Content from the
        // post-modify body must be searchable after.
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();
        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        workspace
            .write_text("a.md", "# a\noriginal-content-token\n")
            .unwrap();
        workspace.reindex(None).unwrap();

        // Sleep past the 1-second mtime granularity floor of HFS+
        // / older ext4 so the modify is observable via stat. APFS
        // and modern ext4 are nanosecond, but the lowest common
        // denominator workspaces the test sleep.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(
            workspace_dir.path().join("a.md"),
            "# a\nreplaced-content-token\n",
        )
        .unwrap();

        let report = workspace.reconcile().unwrap();
        assert_eq!(report.upserted, vec!["a.md".to_string()]);
        assert!(report.forgotten.is_empty());

        let opts = crate::workspace::SearchOpts {
            mode: crate::SearchMode::Bm25,
            limit: 10,
            scope: None,
        };
        assert!(workspace
            .search("replaced-content-token", &opts)
            .unwrap()
            .hits
            .iter()
            .any(|h| h.path == "a.md"));
        assert!(workspace
            .search("original-content-token", &opts)
            .unwrap()
            .hits
            .is_empty());
    }

    #[test]
    fn reconcile_catches_same_mtime_different_size_rewrite() {
        // Regression for the same-mtime-different-content gap that
        // PR9's size column closes. We forcibly stamp the graph's
        // mtime back onto the file after editing so reconcile
        // cannot rely on mtime to spot the change; the size delta
        // is the only signal.
        use std::fs;
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();
        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        workspace
            .write_text("twin.md", "# twin\noriginal-token short\n")
            .unwrap();
        workspace.reindex(None).unwrap();

        let file_path = workspace_dir.path().join("twin.md");
        let original_modified = fs::metadata(&file_path).unwrap().modified().unwrap();

        // Rewrite with different length, then stamp the original
        // mtime back. A pure-mtime reconcile would skip this file.
        fs::write(
            &file_path,
            "# twin\nreplaced-token much much longer body to flip the size signal\n",
        )
        .unwrap();
        let f = fs::OpenOptions::new().write(true).open(&file_path).unwrap();
        f.set_modified(original_modified).unwrap();
        drop(f);

        // The mtime restore is load-bearing: without it, this test
        // would pass even with a mtime-only reconcile. Assert it
        // landed (futimens on Unix / SetFileTime on Windows round-
        // trip exactly on every filesystem we target) instead of
        // silently no-opping if it didn't.
        let stamped = fs::metadata(&file_path).unwrap().modified().unwrap();
        assert_eq!(
            stamped, original_modified,
            "File::set_modified must round-trip exactly; without it the size \
             column is unobservable via this test",
        );
        let report = workspace.reconcile().unwrap();
        assert!(
            report.upserted.iter().any(|p| p == "twin.md"),
            "size check should detect content rewrite with restored mtime; got {:?}",
            report,
        );
        let opts = crate::workspace::SearchOpts {
            mode: crate::SearchMode::Bm25,
            limit: 10,
            scope: None,
        };
        assert!(workspace
            .search("replaced-token", &opts)
            .unwrap()
            .hits
            .iter()
            .any(|h| h.path == "twin.md"));
    }

    #[test]
    #[cfg_attr(
        not(target_os = "linux"),
        ignore = "recovery-worker begin-probe timing is sensitive to macOS CI scheduling; recovery correctness is covered by the other recovery tests on all platforms"
    )]
    fn nonblocking_open_recovery_reconciles_offline_tree_changes() {
        use std::fs;
        use std::time::{Duration, Instant};

        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let root = workspace_dir.path();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root).unwrap();

        let workspace = lib.open_workspace(root).unwrap();
        for index in 0..128 {
            fs::write(
                root.join(format!("bulk-{index:03}.md")),
                format!("# bulk {index}\nfixture-token-{index}\n"),
            )
            .unwrap();
        }
        fs::write(root.join("modified.md"), "# modified\nbefore-modify\n").unwrap();
        fs::write(root.join("same-mtime.md"), "# same\nbefore-size\n").unwrap();
        fs::write(root.join("rename-old.md"), "# rename\nrename-token\n").unwrap();
        fs::write(root.join("removed.md"), "# remove\nremove-token\n").unwrap();
        workspace.reindex(None).unwrap();
        workspace.report().unwrap();
        let report_path = workspace.paths().report.clone();
        let report_deadline = Instant::now() + Duration::from_secs(5);
        while !report_path.exists() && Instant::now() < report_deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(report_path.exists(), "baseline report was not persisted");

        let same_mtime_path = root.join("same-mtime.md");
        let original_modified = fs::metadata(&same_mtime_path).unwrap().modified().unwrap();
        drop(workspace);

        fs::write(
            root.join("created.md"),
            "# created\ncreated-offline-token\n",
        )
        .unwrap();
        fs::write(
            root.join("modified.md"),
            "# modified\nmodified-offline-token with a changed length\n",
        )
        .unwrap();
        fs::write(
            &same_mtime_path,
            "# same\nsame-mtime-offline-token with a much longer body\n",
        )
        .unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&same_mtime_path)
            .unwrap()
            .set_modified(original_modified)
            .unwrap();
        fs::rename(root.join("rename-old.md"), root.join("rename-new.md")).unwrap();
        fs::remove_file(root.join("removed.md")).unwrap();

        let (probe_tx, probe_rx) = std::sync::mpsc::channel();
        arm_open_recovery_probe(root.to_path_buf(), probe_tx);
        let caller = std::thread::current().id();
        let reopened = lib.open_workspace(root).unwrap();
        let recovery_thread = probe_rx
            .recv_timeout(Duration::from_secs(30))
            .expect("startup recovery did not begin");
        assert_ne!(
            recovery_thread, caller,
            "Workspace::open walked the populated tree on its caller"
        );

        await_recovery_ready(&reopened);
        reopened.join_open_recovery();

        let graph_files = reopened.graph().unwrap().files().unwrap();
        for expected in [
            "created.md",
            "modified.md",
            "same-mtime.md",
            "rename-new.md",
        ] {
            assert!(
                graph_files.iter().any(|path| path == expected),
                "background recovery missed {expected}: {graph_files:?}"
            );
        }
        for stale in ["rename-old.md", "removed.md"] {
            assert!(
                !graph_files.iter().any(|path| path == stale),
                "background recovery retained {stale}: {graph_files:?}"
            );
        }

        let opts = SearchOpts {
            mode: SearchMode::Bm25,
            limit: 10,
            scope: None,
        };
        for token in [
            "created-offline-token",
            "modified-offline-token",
            "same-mtime-offline-token",
            "rename-token",
        ] {
            assert_eq!(
                reopened.search(token, &opts).unwrap().hits.len(),
                1,
                "background recovery did not index {token}"
            );
        }
        assert!(
            reopened
                .search("remove-token", &opts)
                .unwrap()
                .hits
                .is_empty(),
            "background recovery retained removed content"
        );

        let report_paths: Vec<String> = reopened
            .report()
            .unwrap()
            .files
            .into_iter()
            .map(|file| file.path)
            .collect();
        for expected in [
            "created.md",
            "modified.md",
            "same-mtime.md",
            "rename-new.md",
        ] {
            assert!(
                report_paths.iter().any(|path| path == expected),
                "background report recovery missed {expected}: {report_paths:?}"
            );
        }
        for stale in ["rename-old.md", "removed.md"] {
            assert!(
                !report_paths.iter().any(|path| path == stale),
                "background report recovery retained {stale}: {report_paths:?}"
            );
        }
    }

    #[test]
    fn index_file_stamps_pre_read_stat_so_concurrent_writes_stay_visible() {
        // TOCTOU between `stat` and `read_text` inside
        // `index_file_inner`. We use a test-only thread-local hook
        // that fires AFTER stat returns and BEFORE read_text begins
        // to deterministically simulate a concurrent writer landing
        // in that window.
        //
        // Required invariant: the graph row ends up with the
        // POST-write content (because read_text runs after the hook)
        // alongside the PRE-write `(mtime, size)` stamp (because
        // stat ran before the hook). Reconcile, comparing the
        // stamped tuple against the live disk stat, must then see
        // the size delta and trigger a reindex on its next pass.
        //
        // The opposite ordering (read-then-stat) would stamp the
        // POST-write `(mtime, size)` onto the PRE-write content;
        // reconcile would see graph.stat == disk.stat and skip,
        // leaving the drift in place. That regression is exactly
        // what this test pins.
        use std::fs;
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();
        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();

        workspace
            .write_text("race.md", "# race\nv1 small\n")
            .unwrap();
        workspace.index_file("race.md").unwrap();

        let pre_stat = workspace.stat("race.md").unwrap();
        let pre_size = pre_stat.size;

        // Arm the one-shot hook: between stat and read inside the
        // next `index_file_inner`, overwrite the file with a body
        // that differs in size so the graph ends up with the
        // pre-write stat + post-write content if the ordering is
        // correct.
        let file_path = workspace_dir.path().join("race.md");
        let new_body = b"# race\nv2 with a noticeably larger payload than v1\n";
        let new_body_len = new_body.len() as u64;
        super::arm_index_file_stat_read_hook(Box::new(move || {
            fs::write(&file_path, new_body).unwrap();
        }));

        workspace.index_file("race.md").unwrap();

        // Post-conditions: the file on disk is the new body, and the
        // graph row carries the pre-write size. The size delta is
        // the load-bearing observable proof of stat-before-read.
        let disk_size = fs::metadata(workspace_dir.path().join("race.md"))
            .unwrap()
            .len();
        assert_eq!(disk_size, new_body_len, "writer hook must have run");
        let graph_rows = workspace.graph().unwrap().files_with_stat().unwrap();
        let (_, _graph_mtime, graph_size) = graph_rows
            .into_iter()
            .find(|(rel, _, _)| rel == "race.md")
            .expect("race.md must have a graph row after index_file");
        assert_eq!(
            graph_size,
            Some(size_to_i64(pre_size)),
            "graph must hold the PRE-write size; got {:?} (pre={pre_size}, post={new_body_len})",
            graph_size,
        );

        // Reconcile must catch the drift (graph size != disk size)
        // and reindex the file on its next pass.
        let report = workspace.reconcile().unwrap();
        assert!(
            report.upserted.iter().any(|p| p == "race.md"),
            "reconcile should detect the stat/content drift; got {:?}",
            report,
        );
    }

    #[test]
    fn reconcile_on_empty_graph_indexes_everything_like_a_fresh_reindex() {
        // Edge case: graph is empty (fresh workspace, or after a
        // reset_workspace). Reconcile sees every disk file as "new"
        // and indexes them all. End state must match what a
        // direct reindex would produce.
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();
        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        workspace.write_text("a.md", "# a\nshared-token\n").unwrap();
        workspace.write_text("b.md", "# b\nshared-token\n").unwrap();
        // Skip the initial reindex so the graph stays empty.

        let report = workspace.reconcile().unwrap();
        assert_eq!(
            report.upserted,
            vec!["a.md".to_string(), "b.md".to_string()]
        );
        assert!(report.forgotten.is_empty());
        assert_eq!(report.unchanged, 0);

        let opts = crate::workspace::SearchOpts {
            mode: crate::SearchMode::Bm25,
            limit: 10,
            scope: None,
        };
        let mut hit_paths: Vec<String> = workspace
            .search("shared-token", &opts)
            .unwrap()
            .hits
            .into_iter()
            .map(|h| h.path)
            .collect();
        hit_paths.sort();
        assert_eq!(hit_paths, vec!["a.md".to_string(), "b.md".to_string()]);
    }

    #[test]
    fn open_picks_up_nested_file_added_offline() {
        // Startup-level regression: a markdown file dropped into a
        // nested subdir while no server was watching (so neither the
        // watcher nor reconcile ran) must be in the graph after the
        // next `open`. This drives the real consumer entry point
        // (`Library::open_workspace` -> `Workspace::open`), NOT a
        // direct `reconcile()` call, because the bug was that the
        // startup path never scheduled recovery when the graph was non-empty.
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();

        {
            let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
            workspace
                .write_text("top.md", "# top\nalready-indexed\n")
                .unwrap();
            workspace.reindex(None).unwrap();
            // Sanity: the graph knows about the pre-existing file but
            // not (yet) the nested one we are about to drop offline.
            let files = workspace.graph().unwrap().files().unwrap();
            assert!(files.iter().any(|f| f == "top.md"));
            // Drop the handle so the flock + live-workspace weak ref
            // release; the re-open below then takes the same path a
            // fresh `chan open` would.
        }

        // Simulate "added while no server watched": write the nested
        // .md straight to disk, bypassing index_file/reconcile. This
        // mirrors `new-team-1/journals/journal-Lead.md` landing while
        // the workspace was offline. Tests may touch the temp tree
        // directly; production user-content writes still route through
        // Workspace.
        let nested_dir = workspace_dir.path().join("new-team-1").join("journals");
        std::fs::create_dir_all(&nested_dir).unwrap();
        std::fs::write(
            nested_dir.join("journal-Lead.md"),
            "# journal\noffline-nested-token\n",
        )
        .unwrap();

        // Re-open via the real startup entry point.
        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        await_recovery_ready(&workspace);
        let files = workspace.graph().unwrap().files().unwrap();
        assert!(
            files
                .iter()
                .any(|f| f == "new-team-1/journals/journal-Lead.md"),
            "offline-added nested file missing from graph after open: {files:?}"
        );

        // And it must be searchable, matching a fresh reindex.
        let opts = crate::workspace::SearchOpts {
            mode: crate::SearchMode::Bm25,
            limit: 10,
            scope: None,
        };
        let hits = workspace.search("offline-nested-token", &opts).unwrap();
        assert_eq!(hits.hits.len(), 1);
        assert_eq!(hits.hits[0].path, "new-team-1/journals/journal-Lead.md");
    }

    #[test]
    fn reindex_resumes_from_staged_cursor_after_simulated_crash() {
        // Simulate a reindex that crashed mid-parse: pre-stage some
        // of the files via graph.stage_file (bypassing the full
        // reindex), leave the marker, then call reindex. The
        // resume path must skip the already-staged files (no second
        // parse) and the final live graph must include both the
        // pre-staged and the newly-parsed entries.
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();
        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        workspace.write_text("a.md", "# a\n").unwrap();
        workspace.write_text("b.md", "# b\n").unwrap();
        workspace.write_text("c.md", "# c\n").unwrap();
        // Stage a.md and b.md as if a prior reindex got that far
        // and crashed before reaching c.md.
        let graph = workspace.graph().unwrap();
        for rel in ["a.md", "b.md"] {
            let meta = std::fs::metadata(workspace_dir.path().join(rel)).unwrap();
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64);
            let fg = crate::graph::FileGraph {
                rel,
                title: Some("staged-title-must-be-overwritten"),
                mtime,
                size: Some(meta.len() as i64),
                node_kind: crate::graph::NodeKind::File,
                edges: &[],
                headings: &[],
                emails: None,
                aliases: None,
            };
            graph.stage_file(&fg).unwrap();
        }
        assert_eq!(graph.staging_cursor().unwrap().as_deref(), Some("b.md"));

        // Reindex: should skip a.md + b.md (already staged) and
        // parse c.md only. Swap then promotes the staged set.
        workspace.reindex(None).unwrap();
        // Live graph contains all three.
        let mut files = workspace.graph().unwrap().files().unwrap();
        files.sort();
        assert_eq!(files, vec!["a.md", "b.md", "c.md"]);
        // Staging is empty after the swap.
        assert!(workspace
            .graph()
            .unwrap()
            .staging_cursor()
            .unwrap()
            .is_none());
    }

    #[test]
    fn reindex_resume_reparses_staged_file_changed_by_checkout() {
        // Checkout-storm hardening: a prior run staged a.md and
        // crashed. Before the next process resumes, the working tree
        // changes a.md in place. Resume must not trust the stale
        // staged row just because its path is <= the cursor; the
        // staging stat tuple no longer matches disk, so the row is
        // purged and parsed again.
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();
        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        workspace
            .write_text("a.md", "# old\nold-checkout-token\n")
            .unwrap();
        workspace.write_text("b.md", "# b\n").unwrap();

        let graph = workspace.graph().unwrap();
        let fg = crate::graph::FileGraph {
            rel: "a.md",
            title: Some("old"),
            mtime: Some(1),
            size: Some(1),
            node_kind: crate::graph::NodeKind::File,
            edges: &[],
            headings: &[],
            emails: None,
            aliases: None,
        };
        graph.stage_file(&fg).unwrap();
        assert_eq!(graph.staging_cursor().unwrap().as_deref(), Some("a.md"));

        std::fs::write(
            workspace_dir.path().join("a.md"),
            "# new\nnew-checkout-token after checkout\n",
        )
        .unwrap();
        workspace.reindex(None).unwrap();

        let opts = crate::workspace::SearchOpts {
            mode: crate::SearchMode::Bm25,
            limit: 10,
            scope: None,
        };
        assert!(
            workspace
                .search("old-checkout-token", &opts)
                .unwrap()
                .hits
                .is_empty(),
            "stale staged content must not survive resume",
        );
        let hits = workspace.search("new-checkout-token", &opts).unwrap().hits;
        assert_eq!(hits.first().map(|h| h.path.as_str()), Some("a.md"));
    }

    #[test]
    fn reindex_after_simulated_checkout_matches_fresh_full_reindex() {
        // Simulate a checkout by replacing a tracked set of files
        // through atomic renames outside Workspace's write APIs. Once the
        // full rebuild settles, graph + search must match a fresh
        // workspace built directly from the post-checkout tree.
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let fresh_dir = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();
        lib.register_workspace(fresh_dir.path()).unwrap();

        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        workspace
            .write_text("keep.md", "# keep\nshared-token\n")
            .unwrap();
        workspace
            .write_text("swap.md", "# old\nold-token\n")
            .unwrap();
        workspace
            .write_text("delete.md", "# delete\nold-token\n")
            .unwrap();
        workspace.reindex(None).unwrap();

        std::fs::write(
            workspace_dir.path().join("swap.tmp"),
            "# new\ncheckout-token shared-token\n",
        )
        .unwrap();
        std::fs::rename(
            workspace_dir.path().join("swap.tmp"),
            workspace_dir.path().join("swap.md"),
        )
        .unwrap();
        std::fs::remove_file(workspace_dir.path().join("delete.md")).unwrap();
        std::fs::write(
            workspace_dir.path().join("add.md"),
            "# add\ncheckout-token\n",
        )
        .unwrap();
        workspace.reindex(None).unwrap();

        std::fs::write(fresh_dir.path().join("keep.md"), "# keep\nshared-token\n").unwrap();
        std::fs::write(
            fresh_dir.path().join("swap.md"),
            "# new\ncheckout-token shared-token\n",
        )
        .unwrap();
        std::fs::write(fresh_dir.path().join("add.md"), "# add\ncheckout-token\n").unwrap();
        let fresh = lib.open_workspace(fresh_dir.path()).unwrap();
        fresh.reindex(None).unwrap();

        assert_eq!(
            capture_recovery_state(&workspace, "checkout-token"),
            capture_recovery_state(&fresh, "checkout-token"),
        );
    }

    #[test]
    #[ignore = "manual checkout/resume profile; not a CI benchmark"]
    fn checkout_and_resume_profile() {
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();
        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        for i in 0..80 {
            workspace
                .write_text(
                    &format!("notes/note-{i:03}.md"),
                    &format!("# note {i}\n\nseed-token {i}\n"),
                )
                .unwrap();
        }

        let started = std::time::Instant::now();
        workspace.reindex(None).unwrap();
        let initial = started.elapsed();

        let started = std::time::Instant::now();
        for i in 0..20 {
            let rel = format!("notes/note-{i:03}.md");
            let tmp = workspace_dir.path().join(format!("notes/.swap-{i:03}.md"));
            std::fs::write(&tmp, format!("# note {i}\n\ncheckout-token {i}\n")).unwrap();
            std::fs::rename(tmp, workspace_dir.path().join(&rel)).unwrap();
        }
        workspace.reindex(None).unwrap();
        let checkout = started.elapsed();

        let graph = workspace.graph().unwrap();
        for i in 0..20 {
            let rel = format!("notes/note-{i:03}.md");
            let meta = std::fs::metadata(workspace_dir.path().join(&rel)).unwrap();
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64);
            let fg = crate::graph::FileGraph {
                rel: &rel,
                title: Some("profile-staged"),
                mtime,
                size: Some(meta.len() as i64),
                node_kind: crate::graph::NodeKind::File,
                edges: &[],
                headings: &[],
                emails: None,
                aliases: None,
            };
            graph.stage_file(&fg).unwrap();
        }
        let started = std::time::Instant::now();
        workspace.reindex(None).unwrap();
        let resume = started.elapsed();

        println!(
            "checkout_profile files=80 touched=20 initial_ms={} checkout_settle_ms={} resume_ms={}",
            initial.as_millis(),
            checkout.as_millis(),
            resume.as_millis(),
        );
    }

    #[test]
    fn reindex_sanitizes_staging_when_files_disappear_between_runs() {
        // Pre-stage a file that's no longer on disk; reindex must
        // purge it before the swap so the live graph does not end
        // up with a ghost row pointing at a missing file.
        let cfg = TempDir::new().unwrap();
        let workspace_dir = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(workspace_dir.path()).unwrap();
        let workspace = lib.open_workspace(workspace_dir.path()).unwrap();
        workspace.write_text("alive.md", "# alive\n").unwrap();
        // Stage a row for a file that does not exist on disk.
        let fg = crate::graph::FileGraph {
            rel: "ghost.md",
            title: None,
            mtime: Some(1),
            size: None,
            node_kind: crate::graph::NodeKind::File,
            edges: &[],
            headings: &[],
            emails: None,
            aliases: None,
        };
        workspace.graph().unwrap().stage_file(&fg).unwrap();
        assert_eq!(
            workspace
                .graph()
                .unwrap()
                .staging_cursor()
                .unwrap()
                .as_deref(),
            Some("ghost.md"),
        );

        workspace.reindex(None).unwrap();
        let files = workspace.graph().unwrap().files().unwrap();
        assert!(files.iter().any(|f| f == "alive.md"));
        assert!(
            !files.iter().any(|f| f == "ghost.md"),
            "sanitize must drop staged files not on disk: {files:?}",
        );
    }

    #[test]
    fn write_text_rejects_non_text_extensions() {
        let (_cfg, _root, workspace) = fixture();
        let err = workspace.write_text("img.png", "x").unwrap_err();
        assert!(matches!(err, ChanError::NotEditableText(_)));
    }

    #[test]
    fn read_text_with_stat_returns_content_and_mtime() {
        let (_cfg, _root, workspace) = fixture();
        workspace.write_text("a.md", "hello").unwrap();
        let (content, stat) = workspace.read_text_with_stat("a.md").unwrap();
        assert_eq!(content, "hello");
        assert_eq!(stat.size, 5);
        assert!(stat.mtime.is_some());
        assert!(stat.mtime_ns.is_some());
        assert!(!stat.is_dir);
    }

    #[test]
    fn read_text_with_stat_chunked_preserves_utf8_boundaries() {
        let (_cfg, _root, workspace) = fixture();
        workspace.write_text("a.md", "aé€𐍈z").unwrap();
        let mut saw_meta = false;
        let mut saw_done = false;
        let mut chunks = Vec::new();

        workspace
            .read_text_with_stat_chunked("a.md", 1, |event| {
                match event {
                    TextReadEvent::Meta(stat) => {
                        saw_meta = true;
                        assert_eq!(stat.size, "aé€𐍈z".len() as u64);
                        assert!(stat.mtime_ns.is_some());
                    }
                    TextReadEvent::Chunk(chunk) => chunks.push(chunk.to_string()),
                    TextReadEvent::Done => saw_done = true,
                }
                true
            })
            .unwrap();

        assert!(saw_meta);
        assert!(saw_done);
        assert_eq!(chunks.concat(), "aé€𐍈z");
    }

    #[test]
    fn read_text_with_stat_chunked_rejects_invalid_utf8() {
        let (_cfg, root, workspace) = fixture();
        std::fs::write(root.path().join("bad.md"), [b'a', 0xff]).unwrap();

        let err = workspace
            .read_text_with_stat_chunked("bad.md", 1, |_| true)
            .unwrap_err();

        assert!(err.to_string().contains("invalid UTF-8"));
    }

    #[test]
    fn read_text_with_stat_chunked_rejects_non_editable_paths() {
        let (_cfg, root, workspace) = fixture();
        std::fs::write(root.path().join("image.bin"), [0, 1, 2, 3]).unwrap();

        let err = workspace
            .read_text_with_stat_chunked("image.bin", TEXT_READ_CHUNK_SIZE, |_| true)
            .unwrap_err();

        assert!(matches!(err, ChanError::NotEditableText(_)));
    }

    #[cfg(unix)]
    #[test]
    fn read_text_with_stat_chunked_rejects_symlink_target() {
        use std::os::unix::fs::symlink;
        let (_cfg, root, workspace) = fixture();
        std::fs::write(root.path().join("real.md"), "hi").unwrap();
        symlink("real.md", root.path().join("alias.md")).unwrap();

        let err = workspace
            .read_text_with_stat_chunked("alias.md", TEXT_READ_CHUNK_SIZE, |_| true)
            .unwrap_err();

        assert!(matches!(err, ChanError::SpecialFile { .. }));
    }

    #[test]
    fn read_text_with_stat_chunked_stops_when_callback_returns_false() {
        let (_cfg, _root, workspace) = fixture();
        workspace.write_text("a.md", "abcdef").unwrap();
        let mut chunks = 0usize;

        workspace
            .read_text_with_stat_chunked("a.md", 1, |event| match event {
                TextReadEvent::Meta(_) => true,
                TextReadEvent::Chunk(_) => {
                    chunks += 1;
                    false
                }
                TextReadEvent::Done => panic!("done should not be emitted after cancellation"),
            })
            .unwrap();

        assert_eq!(chunks, 1);
    }

    #[test]
    fn write_text_if_unchanged_creates_when_missing_with_none() {
        let (_cfg, _root, workspace) = fixture();
        workspace
            .write_text_if_unchanged("a.md", None, "v1")
            .unwrap();
        assert_eq!(workspace.read_text("a.md").unwrap(), "v1");
    }

    #[test]
    fn write_text_if_unchanged_conflicts_when_none_but_file_exists() {
        let (_cfg, _root, workspace) = fixture();
        workspace.write_text("a.md", "v1").unwrap();
        let err = workspace
            .write_text_if_unchanged("a.md", None, "v2")
            .unwrap_err();
        assert!(matches!(
            err,
            ChanError::WriteConflict {
                current_mtime_ns: Some(_)
            }
        ));
        assert_eq!(workspace.read_text("a.md").unwrap(), "v1");
    }

    #[test]
    fn write_text_if_unchanged_conflicts_when_expected_but_missing() {
        let (_cfg, _root, workspace) = fixture();
        let err = workspace
            .write_text_if_unchanged("a.md", Some(0), "v1")
            .unwrap_err();
        assert!(matches!(
            err,
            ChanError::WriteConflict {
                current_mtime_ns: None
            }
        ));
        assert!(!workspace.exists("a.md"));
    }

    #[test]
    fn write_text_if_unchanged_succeeds_with_matching_mtime() {
        let (_cfg, _root, workspace) = fixture();
        workspace.write_text("a.md", "v1").unwrap();
        let (_, stat) = workspace.read_text_with_stat("a.md").unwrap();
        workspace
            .write_text_if_unchanged("a.md", stat.mtime_ns, "v2")
            .unwrap();
        assert_eq!(workspace.read_text("a.md").unwrap(), "v2");
    }

    #[test]
    fn write_text_if_unchanged_conflicts_with_stale_mtime() {
        let (_cfg, _root, workspace) = fixture();
        workspace.write_text("a.md", "v1").unwrap();
        let stale = Some(0i64);
        let err = workspace
            .write_text_if_unchanged("a.md", stale, "v2")
            .unwrap_err();
        match err {
            ChanError::WriteConflict { current_mtime_ns } => {
                assert!(current_mtime_ns.is_some());
                assert_ne!(current_mtime_ns, stale);
            }
            other => panic!("expected WriteConflict, got {other:?}"),
        }
        assert_eq!(workspace.read_text("a.md").unwrap(), "v1");
    }

    /// Two saves landing within the same wall-clock second on a
    /// nanosecond-resolution filesystem must still produce a conflict
    /// when the second writer presents the first writer's stat token.
    /// Filesystems without ns mtime degrade to seconds; on those the
    /// assertion may not exercise the new precision, so we only run
    /// it when we can observe distinct ns values from back-to-back
    /// writes.
    #[test]
    fn write_text_if_unchanged_detects_subsecond_conflict() {
        let (_cfg, _root, workspace) = fixture();
        workspace.write_text("a.md", "v1").unwrap();
        let stale_ns = workspace.stat("a.md").unwrap().mtime_ns;
        // Tight loop until mtime_ns advances. On filesystems with
        // only seconds resolution this would spin until the next
        // second boundary; cap at 200ms.
        let start = std::time::Instant::now();
        loop {
            workspace.write_text("a.md", "v2").unwrap();
            let now_ns = workspace.stat("a.md").unwrap().mtime_ns;
            if now_ns != stale_ns {
                break;
            }
            if start.elapsed() > std::time::Duration::from_millis(200) {
                // FS likely lacks sub-second resolution; skip rather
                // than spin into the next wall-clock second.
                return;
            }
        }
        // Now an attempt to write back with the original (pre-v2)
        // stat must conflict. Without ns precision, two same-second
        // writes would collide and let this through.
        let err = workspace
            .write_text_if_unchanged("a.md", stale_ns, "v3")
            .unwrap_err();
        assert!(matches!(err, ChanError::WriteConflict { .. }));
        assert_eq!(workspace.read_text("a.md").unwrap(), "v2");
    }

    #[test]
    fn write_bytes_allows_binary() {
        let (_cfg, _root, workspace) = fixture();
        workspace
            .write_bytes("img.png", &[0xff, 0xd8, 0xff])
            .unwrap();
        assert_eq!(workspace.read("img.png").unwrap(), vec![0xff, 0xd8, 0xff]);
    }

    #[test]
    fn write_bytes_rejects_binary_for_editable_text_path() {
        let (_cfg, _root, workspace) = fixture();

        let err = workspace.write_bytes("note.md", &[0xff, 0xfe]).unwrap_err();

        assert!(err
            .to_string()
            .contains("non-UTF-8 bytes to editable text file"));
        assert!(!workspace.exists("note.md"));
    }

    #[test]
    fn write_bytes_routes_drafts_binary_into_in_root_drafts_dir() {
        let (_cfg, root, workspace) = fixture();
        workspace.create_draft_dir("untitled-1").unwrap();
        // Drafts are real in-root files under `.Drafts/...`, so a
        // pasted image writes and reads back through the normal path
        // machinery and lands on disk inside the workspace root.
        workspace
            .write_bytes(".Drafts/untitled-1/pasted.png", &[0x89, b'P', b'N', b'G'])
            .unwrap();

        assert_eq!(
            workspace.read(".Drafts/untitled-1/pasted.png").unwrap(),
            vec![0x89, b'P', b'N', b'G']
        );
        assert!(workspace
            .drafts_dir()
            .join("untitled-1/pasted.png")
            .is_file());
        assert!(root.path().join(".Drafts/untitled-1/pasted.png").is_file());
    }

    #[test]
    fn write_text_rejects_oversize_content_for_new_file() {
        let (_cfg, _root, workspace) = fixture();
        // One byte over the cap. Allocating 2 MiB+1 is fine; the
        // guard rejects before any I/O.
        let big = "x".repeat(TEXT_WRITE_LIMIT as usize + 1);
        let err = workspace.write_text("a.md", &big).unwrap_err();
        match err {
            ChanError::WriteTooLarge { kind, size, limit } => {
                assert_eq!(kind, "text");
                assert_eq!(limit, TEXT_WRITE_LIMIT);
                assert_eq!(size, TEXT_WRITE_LIMIT + 1);
            }
            other => panic!("unexpected error: {other:?}"),
        }
        assert!(!workspace.exists("a.md"));
    }

    #[test]
    fn write_bytes_rejects_oversize_content_for_new_file() {
        let (_cfg, _root, workspace) = fixture();
        // 50 MiB+1 byte. Heap-alloc once; cheap.
        let big = vec![0u8; BYTES_WRITE_LIMIT as usize + 1];
        let err = workspace.write_bytes("blob.bin", &big).unwrap_err();
        assert!(matches!(
            err,
            ChanError::WriteTooLarge { kind: "bytes", .. }
        ));
        assert!(!workspace.exists("blob.bin"));
    }

    /// A pre-cap file (or a binary mistakenly named `.md`) larger
    /// than the configured limit must remain editable: writes up to
    /// its current size go through, only growth beyond it is
    /// rejected. Without this rule, shipping the cap would silently
    /// turn every legacy big file read-only on next save.
    #[test]
    fn write_text_allows_edits_to_legacy_oversize_file() {
        let (_cfg, root, workspace) = fixture();
        // Plant a 3 MiB file directly via std (bypasses the cap).
        let path = root.path().join("legacy.md");
        let big = "y".repeat(TEXT_WRITE_LIMIT as usize + 1024 * 1024);
        std::fs::write(&path, &big).unwrap();
        // Editing the file at the same size succeeds.
        let same_size = "z".repeat(big.len());
        workspace.write_text("legacy.md", &same_size).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().len() as usize, big.len());
        // Shrinking succeeds (well within max(prev, limit)).
        workspace.write_text("legacy.md", "shrunk").unwrap();
        assert_eq!(workspace.read_text("legacy.md").unwrap(), "shrunk");
    }

    /// Growing a legacy oversize file past its current size IS
    /// rejected: the effective limit is max(prev_size, configured
    /// limit), so a 3 MiB file caps at 3 MiB on the next write.
    #[test]
    fn write_text_rejects_growth_past_legacy_size() {
        let (_cfg, root, workspace) = fixture();
        let path = root.path().join("legacy.md");
        let prev = "y".repeat(TEXT_WRITE_LIMIT as usize + 1024);
        std::fs::write(&path, &prev).unwrap();
        // One byte over the existing size, well above the configured cap.
        let grown = "z".repeat(prev.len() + 1);
        let err = workspace.write_text("legacy.md", &grown).unwrap_err();
        match err {
            ChanError::WriteTooLarge { limit, size, .. } => {
                assert_eq!(limit, prev.len() as u64, "effective limit = prev size");
                assert_eq!(size, grown.len() as u64);
            }
            other => panic!("unexpected error: {other:?}"),
        }
        // File on disk unchanged.
        assert_eq!(std::fs::metadata(&path).unwrap().len() as usize, prev.len());
    }

    #[test]
    fn list_skips_chan_and_git_at_top_level() {
        let (_cfg, root, workspace) = fixture();
        std::fs::create_dir_all(root.path().join(".chan")).unwrap();
        std::fs::create_dir_all(root.path().join(".git")).unwrap();
        std::fs::write(root.path().join("note.md"), "hi").unwrap();
        let entries = workspace.list("").unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"note.md"));
        assert!(!names.contains(&".chan"));
        assert!(!names.contains(&".git"));
    }

    #[test]
    fn rename_moves_file() {
        let (_cfg, _root, workspace) = fixture();
        workspace.write_text("a.md", "x").unwrap();
        workspace.rename("a.md", "b/c.md").unwrap();
        assert!(!workspace.exists("a.md"));
        assert!(workspace.exists("b/c.md"));
    }

    // A second open of the same root in THIS process is refused: the writer
    // flock is held by our own pid, so it surfaces `WorkspaceAlreadyOpen` (this
    // chan already has it), not the cross-process `WorkspaceLocked`. The refusal
    // -- no second writer -- is the load-bearing invariant; only the error type
    // distinguishes our own process from a foreign holder (a separate process,
    // a different pid, still yields `WorkspaceLocked`). A fresh `Library` handle
    // has an empty live_workspaces map, so the open reaches the flock rather
    // than the map's pre-check. (`lock::is_contended` maps the Windows
    // LockFileEx error to contention too, so this holds on Windows as on Unix.)
    #[test]
    fn second_open_in_same_process_is_already_open() {
        let (cfg, root, _workspace) = fixture();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        let err = lib.open_workspace(root.path()).unwrap_err();
        assert!(matches!(err, ChanError::WorkspaceAlreadyOpen));
    }

    /// Defensive: if the registered workspace path has been replaced by
    /// a symlink (or a regular file) between registration and the
    /// next open, refuse rather than carry on as if it were still a
    /// real directory.
    #[cfg(unix)]
    #[test]
    fn open_refuses_when_root_is_symlink() {
        use std::os::unix::fs::symlink;
        let cfg = TempDir::new().unwrap();
        let real = TempDir::new().unwrap();
        let staging = TempDir::new().unwrap();
        // Register a real directory ...
        let registered_path = staging.path().join("workspace");
        std::fs::create_dir(&registered_path).unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(&registered_path).unwrap();
        // ... then swap it for a symlink to a different directory.
        std::fs::remove_dir(&registered_path).unwrap();
        symlink(real.path(), &registered_path).unwrap();
        let err = lib.open_workspace(&registered_path).unwrap_err();
        assert!(matches!(err, ChanError::SpecialFile { .. }));
    }

    #[test]
    fn open_refuses_when_root_is_regular_file() {
        let cfg = TempDir::new().unwrap();
        let staging = TempDir::new().unwrap();
        let registered_path = staging.path().join("workspace");
        std::fs::create_dir(&registered_path).unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(&registered_path).unwrap();
        // Replace the directory with a regular file.
        std::fs::remove_dir(&registered_path).unwrap();
        std::fs::write(&registered_path, b"not a workspace").unwrap();
        let err = lib.open_workspace(&registered_path).unwrap_err();
        assert!(matches!(err, ChanError::SpecialFile { .. }));
    }

    #[cfg(unix)]
    #[test]
    fn read_text_rejects_symlink_target() {
        use std::os::unix::fs::symlink;
        let (_cfg, root, workspace) = fixture();
        std::fs::write(root.path().join("real.md"), "hi").unwrap();
        symlink("real.md", root.path().join("alias.md")).unwrap();
        let err = workspace.read_text("alias.md").unwrap_err();
        assert!(matches!(err, ChanError::SpecialFile { .. }));
    }

    #[cfg(unix)]
    #[test]
    fn read_rejects_unix_socket() {
        use std::os::unix::net::UnixListener;
        let (_cfg, root, workspace) = fixture();
        let _l = UnixListener::bind(root.path().join("s")).unwrap();
        let err = workspace.read("s").unwrap_err();
        assert!(matches!(err, ChanError::SpecialFile { .. }));
    }

    #[cfg(unix)]
    #[test]
    fn write_text_refuses_to_clobber_symlink() {
        use std::os::unix::fs::symlink;
        let (_cfg, root, workspace) = fixture();
        std::fs::write(root.path().join("target.md"), "v1").unwrap();
        symlink("target.md", root.path().join("today.md")).unwrap();
        let err = workspace.write_text("today.md", "v2").unwrap_err();
        assert!(matches!(err, ChanError::SpecialFile { .. }));
        // Both the symlink and its target are intact.
        assert_eq!(
            std::fs::read_to_string(root.path().join("target.md")).unwrap(),
            "v1"
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_refuses_through_midpath_symlink_to_outside() {
        use std::os::unix::fs::symlink;
        let outside = TempDir::new().unwrap();
        let (_cfg, root, workspace) = fixture();
        symlink(outside.path(), root.path().join("Backup")).unwrap();
        let err = workspace.write_text("Backup/today.md", "x").unwrap_err();
        assert!(matches!(err, ChanError::SymlinkEscape(_)));
        // The escape path was never written.
        assert!(!outside.path().join("today.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn list_tree_drops_symlinks_and_sockets() {
        use std::os::unix::fs::symlink;
        use std::os::unix::net::UnixListener;
        let (_cfg, root, workspace) = fixture();
        std::fs::write(root.path().join("note.md"), "hi").unwrap();
        symlink("note.md", root.path().join("alias.md")).unwrap();
        let _l = UnixListener::bind(root.path().join("sock")).unwrap();
        let entries = workspace.list_tree().unwrap();
        let paths: Vec<_> = entries.iter().map(|e| e.path.clone()).collect();
        assert!(paths.contains(&"note.md".to_string()));
        assert!(!paths.iter().any(|p| p == "alias.md"));
        assert!(!paths.iter().any(|p| p == "sock"));
    }

    #[cfg(unix)]
    #[test]
    fn list_keeps_symlink_entries_visible() {
        use std::os::unix::fs::symlink;
        use std::os::unix::net::UnixListener;
        let (_cfg, root, workspace) = fixture();
        std::fs::write(root.path().join("note.md"), "hi").unwrap();
        symlink("note.md", root.path().join("alias.md")).unwrap();
        let _l = UnixListener::bind(root.path().join("sock")).unwrap();

        let entries = workspace.list("").unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"note.md"));
        assert!(names.contains(&"alias.md"));
        assert!(!names.contains(&"sock"));
    }

    #[test]
    fn list_tree_prefix_scopes_walk_and_keeps_root_relative_paths() {
        let (_cfg, _root, workspace) = fixture();
        workspace.write_text("notes/a.md", "a").unwrap();
        workspace.write_text("notes/deep/b.md", "b").unwrap();
        workspace.write_text("other/c.md", "c").unwrap();
        workspace.write_text("top.md", "t").unwrap();

        let entries = workspace.list_tree_prefix("notes").unwrap();
        let paths: Vec<_> = entries.iter().map(|e| e.path.as_str()).collect();
        // Prefix entry plus everything under it; nothing outside.
        assert!(paths.contains(&"notes"));
        assert!(paths.contains(&"notes/a.md"));
        assert!(paths.contains(&"notes/deep"));
        assert!(paths.contains(&"notes/deep/b.md"));
        assert!(!paths.contains(&"top.md"));
        assert!(!paths.iter().any(|p| p.starts_with("other")));
    }

    #[test]
    fn list_tree_prefix_with_trailing_slash_normalizes() {
        // The list_files tool trims a trailing slash before calling
        // us; verify the workspace method itself accepts both shapes so
        // host-direct callers don't trip on the slash.
        let (_cfg, _root, workspace) = fixture();
        workspace.write_text("notes/a.md", "a").unwrap();
        let with_slash = workspace.list_tree_prefix("notes/").unwrap();
        let without = workspace.list_tree_prefix("notes").unwrap();
        assert_eq!(
            with_slash.iter().map(|e| &e.path).collect::<Vec<_>>(),
            without.iter().map(|e| &e.path).collect::<Vec<_>>(),
        );
    }

    #[cfg(unix)]
    #[test]
    fn list_tree_prefix_rejects_midpath_symlink_outside_workspace() {
        use std::os::unix::fs::symlink;
        let (_cfg, root, workspace) = fixture();
        let outside = TempDir::new().unwrap();
        std::fs::create_dir_all(outside.path().join("victim")).unwrap();
        std::fs::write(outside.path().join("victim/leak.md"), "secret").unwrap();
        // Create a symlink inside the workspace that points outside it.
        // resolve_safe_strict canonicalizes the deepest existing
        // ancestor and rejects anything that lands above the workspace
        // root, so list_tree_prefix must error rather than walk into
        // the foreign tree.
        symlink(outside.path(), root.path().join("escape")).unwrap();
        let err = workspace.list_tree_prefix("escape/victim").unwrap_err();
        assert!(matches!(err, ChanError::SymlinkEscape(_)), "got {err:?}");
    }

    #[test]
    fn list_tree_prefix_rejects_dotdot() {
        let (_cfg, _root, workspace) = fixture();
        let err = workspace.list_tree_prefix("../escape").unwrap_err();
        assert!(matches!(err, ChanError::PathEscape), "got {err:?}");
    }

    #[test]
    fn list_tree_unified_includes_in_root_drafts_dir() {
        let (_cfg, _root, workspace) = fixture();
        workspace.write_text("notes/intro.md", "# intro\n").unwrap();
        workspace.create_draft_dir("untitled-1").unwrap();
        workspace
            .write_text(".Drafts/untitled-1/draft.md", "# draft\n")
            .unwrap();
        workspace
            .write_bytes(".Drafts/untitled-1/pasted.png", &[1, 2, 3])
            .unwrap();

        // Drafts are in-root files, so the plain unified walk surfaces
        // them under their real `.Drafts/...` relpaths.
        let entries = workspace.list_tree_unified().unwrap();
        let paths: Vec<_> = entries.iter().map(|entry| entry.path.as_str()).collect();
        assert!(paths.contains(&"notes/intro.md"));
        assert!(paths.contains(&".Drafts"));
        assert!(paths.contains(&".Drafts/untitled-1"));
        assert!(paths.contains(&".Drafts/untitled-1/draft.md"));
        assert!(paths.contains(&".Drafts/untitled-1/pasted.png"));
    }

    #[test]
    fn list_tree_prefix_unified_scopes_in_root_drafts_dir() {
        let (_cfg, _root, workspace) = fixture();
        workspace.create_draft_dir("untitled-1").unwrap();
        workspace.create_draft_dir("untitled-2").unwrap();
        workspace
            .write_text(".Drafts/untitled-1/draft.md", "# draft\n")
            .unwrap();
        workspace
            .write_text(".Drafts/untitled-2/draft.md", "# other\n")
            .unwrap();

        let entries = workspace
            .list_tree_prefix_unified(".Drafts/untitled-1")
            .unwrap();
        let paths: Vec<_> = entries.iter().map(|entry| entry.path.as_str()).collect();
        assert!(paths.contains(&".Drafts/untitled-1"));
        assert!(paths.contains(&".Drafts/untitled-1/draft.md"));
        assert!(!paths
            .iter()
            .any(|path| path.starts_with(".Drafts/untitled-2")));
    }

    #[cfg(unix)]
    #[test]
    fn remove_rejects_symlink_with_special_file_error() {
        use std::os::unix::fs::symlink;
        let (_cfg, root, workspace) = fixture();
        std::fs::write(root.path().join("real.md"), "hi").unwrap();
        symlink("real.md", root.path().join("alias.md")).unwrap();
        // Trash refuses to swallow non-regular non-directory entries:
        // restoring a symlink across a cross-fs trash is fragile, and
        // chan-workspace never creates them on its own. Users delete them
        // out-of-band if they really want them gone.
        let err = workspace.remove("alias.md").unwrap_err();
        assert!(matches!(err, ChanError::SpecialFile { .. }));
        // Both the symlink and its target are intact.
        assert!(root.path().join("alias.md").symlink_metadata().is_ok());
        assert!(root.path().join("real.md").exists());
    }

    #[test]
    fn remove_then_restore_round_trips() {
        let (_cfg, _root, workspace) = fixture();
        workspace.write_text("notes/a.md", "hello").unwrap();
        workspace.remove("notes/a.md").unwrap();
        assert!(!workspace.exists("notes/a.md"));
        let entries = workspace.trash_list().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].original_path, "notes/a.md");
        workspace.trash_restore(&entries[0].id).unwrap();
        assert_eq!(workspace.read_text("notes/a.md").unwrap(), "hello");
        assert!(workspace.trash_list().unwrap().is_empty());
    }

    #[test]
    fn remove_recursive_directory() {
        let (_cfg, _root, workspace) = fixture();
        workspace.write_text("notes/a.md", "a").unwrap();
        workspace.write_text("notes/sub/b.md", "bb").unwrap();
        workspace.remove("notes").unwrap();
        assert!(!workspace.exists("notes/a.md"));
        let entries = workspace.trash_list().unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].is_dir);
        workspace.trash_restore(&entries[0].id).unwrap();
        assert_eq!(workspace.read_text("notes/a.md").unwrap(), "a");
        assert_eq!(workspace.read_text("notes/sub/b.md").unwrap(), "bb");
    }

    #[test]
    fn trash_restore_refuses_when_dest_exists() {
        let (_cfg, _root, workspace) = fixture();
        workspace.write_text("a.md", "v1").unwrap();
        workspace.remove("a.md").unwrap();
        workspace.write_text("a.md", "v2").unwrap();
        let id = workspace.trash_list().unwrap()[0].id.clone();
        let err = workspace.trash_restore(&id).unwrap_err();
        assert!(matches!(err, ChanError::TrashOccupied(_)));
        assert_eq!(workspace.read_text("a.md").unwrap(), "v2");
        assert_eq!(workspace.trash_list().unwrap().len(), 1);
    }

    #[test]
    fn trash_purge_and_empty() {
        let (_cfg, _root, workspace) = fixture();
        workspace.write_text("a.md", "x").unwrap();
        workspace.write_text("b.md", "y").unwrap();
        workspace.remove("a.md").unwrap();
        workspace.remove("b.md").unwrap();
        let entries = workspace.trash_list().unwrap();
        assert_eq!(entries.len(), 2);
        workspace.trash_purge(&entries[0].id).unwrap();
        assert_eq!(workspace.trash_list().unwrap().len(), 1);
        workspace.trash_empty().unwrap();
        assert!(workspace.trash_list().unwrap().is_empty());
    }

    // ---- drafts ----

    #[test]
    fn drafts_dir_created_lazily_on_first_draft() {
        // Drafts live in-root and the directory is created lazily: a
        // fresh workspace has no `.Drafts` until the first
        // `create_draft_dir`. `drafts_dir()` reports the configured
        // default name under the root.
        let (_cfg, _root, workspace) = fixture();
        assert_eq!(workspace.drafts_dir_name(), ".Drafts");
        // `drafts_dir()` is the configured name joined onto the
        // workspace root (the registry-canonicalized form).
        assert_eq!(
            workspace.drafts_dir(),
            workspace.root().join(".Drafts"),
            "drafts dir should be <root>/.Drafts"
        );
        assert!(
            !workspace.drafts_dir().exists(),
            "drafts dir should not exist before the first draft"
        );
        assert!(workspace.list_drafts().unwrap().is_empty());

        workspace.create_draft_dir("untitled-1").unwrap();
        assert!(
            workspace.drafts_dir().is_dir(),
            "drafts dir should materialize after the first draft"
        );
    }

    #[test]
    fn draft_creation_refuses_missing_workspace_root_without_recreating_it() {
        let (_cfg, root, workspace) = fixture();
        let root_path = root.path().to_path_buf();
        std::fs::remove_dir_all(&root_path).expect("remove harness-owned workspace");
        assert!(!root_path.exists(), "workspace root survived deletion");

        let error = workspace
            .create_draft_dir("untitled-1")
            .expect_err("missing workspace root must reject a new draft");
        assert!(
            matches!(
                error,
                ChanError::WorkspaceRootMissing(ref missing) if missing == &root_path
            ),
            "unexpected draft error: {error}"
        );
        assert!(
            !root_path.exists(),
            "draft creation recreated the deleted workspace root"
        );
    }

    #[test]
    fn text_write_refuses_missing_workspace_root_without_recreating_it() {
        let (_cfg, root, workspace) = fixture();
        let root_path = root.path().to_path_buf();
        std::fs::remove_dir_all(&root_path).expect("remove harness-owned workspace");

        let error = workspace
            .write_text("new.md", "must not land in an orphaned capability")
            .expect_err("missing workspace root must reject a text write");
        assert!(
            matches!(
                error,
                ChanError::WorkspaceRootMissing(ref missing) if missing == &root_path
            ),
            "unexpected write error: {error}"
        );
        assert!(
            !root_path.exists(),
            "text write recreated the deleted workspace root"
        );
    }

    #[cfg(unix)]
    #[test]
    fn open_handle_refuses_a_replacement_at_the_same_root_path() {
        let (_cfg, root, workspace) = fixture();
        let root_path = root.path().to_path_buf();
        std::fs::remove_dir_all(&root_path).expect("remove original workspace root");
        std::fs::create_dir(&root_path).expect("create replacement workspace root");

        let error = workspace
            .write_text("new.md", "must not land in the unlinked original")
            .expect_err("an open handle must reject a replacement root");
        assert!(
            matches!(
                error,
                ChanError::WorkspaceRootMissing(ref missing) if missing == &root_path
            ),
            "unexpected replacement error: {error}"
        );
        assert!(
            !root_path.join("new.md").exists(),
            "write crossed from the original capability into its replacement"
        );
    }

    #[cfg(unix)]
    #[test]
    fn atomic_text_write_reports_root_removed_during_stream() {
        let (_cfg, root, workspace) = fixture();
        let root_path = root.path().to_path_buf();
        workspace.write_text("note.md", "before").unwrap();

        let error = workspace
            .write_atomic_stream("note.md", AtomicWriteKind::Text, |sink| {
                sink.write_chunk(b"after")?;
                std::fs::remove_dir_all(&root_path)?;
                Ok(())
            })
            .expect_err("a write racing root deletion must not report success");
        assert!(
            matches!(
                error,
                ChanError::WorkspaceRootMissing(ref missing) if missing == &root_path
            ),
            "unexpected write error: {error}"
        );
        assert!(!root_path.exists(), "workspace root survived deletion");
    }

    #[test]
    fn drafts_create_list_and_promote_roundtrip() {
        // Round-trip: create two drafts, list them,
        // promote one into the workspace root + verify the directory
        // moved + the draft is no longer listed.
        let (_cfg, root, workspace) = fixture();
        let a = workspace.create_draft_dir("untitled-1").unwrap();
        // An arbitrary non-`untitled` draft dir: listing must not
        // assume the Cmd+N prefix.
        let b = workspace.create_draft_dir("scratch-2").unwrap();
        assert!(a.abs.is_dir());
        assert!(b.abs.is_dir());

        // Seed a draft.md plus companion content so promotion treats
        // this as a directory draft.
        std::fs::write(a.abs.join("draft.md"), b"# hello\n").unwrap();
        std::fs::write(a.abs.join("pasted.png"), [1, 2, 3]).unwrap();

        let listed = workspace.list_drafts().unwrap();
        assert_eq!(listed.len(), 2);
        // Sorted by name.
        assert_eq!(listed[0].name, "scratch-2");
        assert_eq!(listed[1].name, "untitled-1");

        // Promote untitled-1 into the workspace root.
        workspace.promote_draft("untitled-1", "untitled-1").unwrap();
        assert!(root.path().join("untitled-1").is_dir());
        assert!(root.path().join("untitled-1").join("draft.md").is_file());
        assert!(root.path().join("untitled-1").join("pasted.png").is_file());
        assert!(!workspace.drafts_dir().join("untitled-1").exists());

        // scratch-2 still listed; untitled-1 gone.
        let after = workspace.list_drafts().unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].name, "scratch-2");
    }

    #[test]
    fn drafts_reject_traversal_and_existing() {
        // Name validation + collision detection.
        let (_cfg, _root, workspace) = fixture();
        assert!(workspace.create_draft_dir("").is_err());
        assert!(workspace.create_draft_dir("..").is_err());
        assert!(workspace.create_draft_dir("a/b").is_err());

        workspace.create_draft_dir("untitled-1").unwrap();
        assert!(workspace.create_draft_dir("untitled-1").is_err());
    }

    #[test]
    fn graph_mentions_aggregates_unique_handles_by_count() {
        // graph::mentions() enumerates unique
        // `@@<Name>` mention edges, sorted by count desc + label
        // asc (mirrors tags() shape). Consumed by chan-server's
        // /api/mentions for editor mention-completion.
        let (_cfg, root, workspace) = fixture();
        // 3 files: 2 mention @@Bob, 1 mentions @@Alice
        // + @@Bob, so @@Bob count = 3, @@Alice = 1. The
        // higher-count handle sorts LAST alphabetically, so the
        // expected order proves count-desc dominates label-asc.
        workspace
            .write_text("notes/a.md", "Met @@Bob today.\n")
            .unwrap();
        workspace
            .write_text("notes/b.md", "Discussed with @@Bob.\n")
            .unwrap();
        workspace
            .write_text("notes/c.md", "@@Alice and @@Bob synced on the design.\n")
            .unwrap();
        workspace.reindex(None).unwrap();
        assert!(root.path().join("notes/a.md").is_file());

        let graph = workspace.graph().unwrap();
        let mentions = graph.mentions().unwrap();
        // The bare names (no `@@` sigil) come back in count-desc
        // + label-asc order. Bob = 3 > Alice = 1.
        assert_eq!(mentions.len(), 2, "got {mentions:?}");
        assert_eq!(mentions[0].name, "Bob");
        assert_eq!(mentions[0].count, 3);
        assert_eq!(mentions[1].name, "Alice");
        assert_eq!(mentions[1].count, 1);
    }

    #[test]
    fn reindex_walks_in_root_drafts_into_graph_and_bm25() {
        // Drafts live in-root under `.Drafts/...`, so the normal
        // reindex walk indexes them like any other file; there is no
        // separate drafts subtree walk.
        let (_cfg, _root, workspace) = fixture();
        workspace.create_draft_dir("untitled-1").unwrap();
        // Write the file directly (bypass write_text so the
        // watcher doesn't catch it; we want to verify the boot
        // walk picks it up).
        std::fs::write(
            workspace.drafts_dir().join("untitled-1").join("draft.md"),
            "# hello\nboot-walk-marker here\n",
        )
        .unwrap();

        // Reindex (boot-equivalent path).
        workspace.reindex(None).unwrap();

        // BM25 should now know about the draft under its real
        // `.Drafts/untitled-1/draft.md` key.
        let opts = crate::workspace::SearchOpts {
            mode: SearchMode::Bm25,
            limit: 10,
            scope: None,
        };
        let hits = workspace.search("boot-walk-marker", &opts).unwrap();
        assert!(
            hits.hits
                .iter()
                .any(|h| h.path == ".Drafts/untitled-1/draft.md"),
            "boot walk should have indexed the draft; got {:?}",
            hits.hits
        );

        // Graph DB should also have the file as a node -- verified
        // via the public files() listing (which the chan-server
        // graph route consumes).
        let graph = workspace.graph().unwrap();
        let files = graph.files().unwrap();
        assert!(
            files.iter().any(|p| p == ".Drafts/untitled-1/draft.md"),
            "graph files() should include the draft; got {files:?}"
        );
    }

    #[test]
    fn stat_routes_in_root_drafts_paths_through_root_handle() {
        // Drafts are in-root files, so stat on `.Drafts/...` resolves
        // through the workspace-root handle like any other path.
        let (_cfg, _root, workspace) = fixture();
        workspace.create_draft_dir("untitled-1").unwrap();
        workspace
            .write_text(".Drafts/untitled-1/draft.md", "# hello\n")
            .unwrap();

        // Stat the drafts directory.
        let root_stat = workspace.stat(".Drafts").unwrap();
        assert!(root_stat.is_dir, "drafts root should stat as is_dir");

        let dir_stat = workspace.stat(".Drafts/untitled-1").unwrap();
        assert!(dir_stat.is_dir, "draft directory should stat as is_dir");

        // Stat a file inside the draft directory.
        let file_stat = workspace.stat(".Drafts/untitled-1/draft.md").unwrap();
        assert!(!file_stat.is_dir);
        // "# hello\n" is 8 bytes.
        assert_eq!(file_stat.size, 8);

        // Workspace-root path continues to route through the workspace
        // handle (regression check).
        workspace.write_text("notes/intro.md", "hello\n").unwrap();
        let workspace_stat = workspace.stat("notes/intro.md").unwrap();
        assert!(!workspace_stat.is_dir);
        assert_eq!(workspace_stat.size, 6);
    }

    #[test]
    fn physical_path_resolution_maps_in_root_drafts() {
        let (_cfg, _root, workspace) = fixture();
        workspace.create_draft_dir("untitled-1").unwrap();
        workspace
            .write_text(".Drafts/untitled-1/draft.md", "# hello\n")
            .unwrap();
        workspace.write_text("notes/intro.md", "# intro\n").unwrap();

        let root_canon = workspace.root().canonicalize().unwrap();
        assert_eq!(workspace.resolve_physical_path("").unwrap(), root_canon);
        // Drafts resolve under the root like any other in-tree path.
        assert_eq!(
            workspace.resolve_physical_path(".Drafts").unwrap(),
            root_canon.join(".Drafts")
        );
        assert_eq!(
            workspace
                .resolve_physical_dir(".Drafts/untitled-1")
                .unwrap(),
            root_canon.join(".Drafts").join("untitled-1")
        );
        assert_eq!(
            workspace
                .physical_path_to_virtual(&root_canon.join(".Drafts").join("untitled-1"))
                .unwrap(),
            ".Drafts/untitled-1"
        );
        assert_eq!(
            workspace
                .physical_path_to_virtual(&workspace.root().join("notes"))
                .unwrap(),
            "notes"
        );
    }

    #[test]
    fn list_routes_in_root_drafts_through_root_handle() {
        // Drafts are in-root, so listing `.Drafts` / `.Drafts/<name>`
        // routes through the workspace-root handle like any other path.
        let (_cfg, root, workspace) = fixture();
        workspace.create_draft_dir("untitled-1").unwrap();
        workspace.create_draft_dir("untitled-2").unwrap();
        workspace
            .write_text(".Drafts/untitled-1/draft.md", "# hello\n")
            .unwrap();
        std::fs::write(
            workspace.drafts_dir().join("untitled-1").join("pasted.png"),
            b"\x89PNG\r\n",
        )
        .unwrap();

        // List the drafts directory via ".Drafts/".
        let drafts_root_listing = workspace.list(".Drafts/").unwrap();
        let mut names: Vec<String> = drafts_root_listing.iter().map(|e| e.name.clone()).collect();
        names.sort();
        assert_eq!(names, ["untitled-1", "untitled-2"]);

        // Same via bare ".Drafts" (no trailing slash).
        let bare = workspace.list(".Drafts").unwrap();
        assert_eq!(bare.len(), 2);

        // List inside a draft directory.
        let inside = workspace.list(".Drafts/untitled-1").unwrap();
        let mut leaves: Vec<String> = inside.iter().map(|e| e.name.clone()).collect();
        leaves.sort();
        assert_eq!(leaves, ["draft.md", "pasted.png"]);

        // Workspace-root list: backward-compat regression check.
        workspace.write_text("notes/intro.md", "# intro\n").unwrap();
        let workspace_root_listing = workspace.list("notes").unwrap();
        let workspace_leaves: Vec<&str> = workspace_root_listing
            .iter()
            .map(|e| e.name.as_str())
            .collect();
        assert_eq!(workspace_leaves, ["intro.md"]);
        assert!(root.path().join("notes/intro.md").is_file());
    }

    #[test]
    fn list_drafts_empty_when_no_drafts() {
        // Drafts are created lazily: a fresh workspace has no `.Drafts`
        // directory at all, so `list_drafts()` (the draft enumeration
        // API) returns empty and the directory is absent on disk.
        let (_cfg, _root, workspace) = fixture();
        assert!(workspace.list_drafts().unwrap().is_empty());
        assert!(!workspace.drafts_dir().exists());
    }

    #[test]
    fn in_root_draft_path_read_write_roundtrip() {
        // A `.Drafts/<name>/<file>` rel reads/writes through the same
        // path machinery as any in-root file, so the editor's autosave
        // path can target drafts without API branching.
        let (_cfg, _root, workspace) = fixture();
        workspace.create_draft_dir("untitled-1").unwrap();

        let rel = ".Drafts/untitled-1/draft.md";
        workspace
            .write_text(rel, "# hello from a draft\n")
            .expect("write_text should land in the in-root drafts dir");
        let content = workspace
            .read_text(rel)
            .expect("read_text should read back the in-root draft");
        assert_eq!(content, "# hello from a draft\n");
    }

    #[test]
    fn in_root_draft_path_write_text_atomic() {
        // Atomic-write parity: overwriting an existing draft file via
        // write_text replaces atomically, same as any in-root file.
        let (_cfg, _root, workspace) = fixture();
        workspace.create_draft_dir("untitled-1").unwrap();
        let rel = ".Drafts/untitled-1/draft.md";
        workspace.write_text(rel, "v1").unwrap();
        workspace.write_text(rel, "v2").unwrap();
        let content = workspace.read_text(rel).unwrap();
        assert_eq!(content, "v2");
    }

    #[test]
    fn drafts_dir_itself_is_not_a_valid_file_target() {
        // The drafts directory itself is a directory, not a file, so
        // read/write against it fails like any directory path.
        let (_cfg, _root, workspace) = fixture();
        workspace.create_draft_dir("untitled-1").unwrap();
        assert!(workspace.read_text(".Drafts/").is_err());
        assert!(workspace.write_text(".Drafts/", "anything").is_err());
    }

    #[test]
    fn non_draft_paths_land_outside_drafts_dir() {
        // Regression check: paths outside `.Drafts/` continue to route
        // through the workspace-root handle and land under the root,
        // not inside the drafts dir.
        let (_cfg, root, workspace) = fixture();
        workspace.write_text("notes/intro.md", "# intro\n").unwrap();
        assert_eq!(workspace.read_text("notes/intro.md").unwrap(), "# intro\n");
        assert!(root.path().join("notes/intro.md").is_file());
        assert!(!workspace.drafts_dir().join("notes").exists());
    }

    #[test]
    fn screensaver_primitives_round_trip_and_default_correctly() {
        // The 6 Workspace::screensaver_* methods round-trip
        // through IndexConfig + atomic write. Defaults: enabled
        // false, timeout 300, pin_hash None.
        let (_cfg, _root, workspace) = fixture();

        // Defaults.
        assert!(!workspace.screensaver_enabled().unwrap());
        assert_eq!(workspace.screensaver_timeout_secs().unwrap(), 300);
        assert_eq!(
            workspace.screensaver_theme().unwrap(),
            ScreensaverTheme::Plain
        );
        assert!(workspace.screensaver_pin_hash().unwrap().is_none());

        // Flip enabled.
        workspace.set_screensaver_enabled(true).unwrap();
        assert!(workspace.screensaver_enabled().unwrap());

        // Update timeout.
        workspace.set_screensaver_timeout_secs(60).unwrap();
        assert_eq!(workspace.screensaver_timeout_secs().unwrap(), 60);

        // Update theme.
        workspace
            .set_screensaver_theme(ScreensaverTheme::Matrix)
            .unwrap();
        assert_eq!(
            workspace.screensaver_theme().unwrap(),
            ScreensaverTheme::Matrix
        );

        // Set PIN.
        let pin_bytes = vec![0xDE, 0xAD, 0xBE, 0xEF, 0x42];
        workspace
            .set_screensaver_pin_hash(Some(pin_bytes.clone()))
            .unwrap();
        assert_eq!(workspace.screensaver_pin_hash().unwrap(), Some(pin_bytes));

        // Clear PIN (None).
        workspace.set_screensaver_pin_hash(None).unwrap();
        assert!(workspace.screensaver_pin_hash().unwrap().is_none());

        // Idempotent re-set (same value).
        workspace.set_screensaver_enabled(true).unwrap();
        workspace.set_screensaver_timeout_secs(60).unwrap();
        workspace
            .set_screensaver_theme(ScreensaverTheme::Matrix)
            .unwrap();
        workspace.set_screensaver_pin_hash(None).unwrap();
    }

    mod dashboard_concurrency {
        use super::*;

        fn run_concurrent_dashboard_updates(
            first: fn(&mut DashboardConfig),
            second: fn(&mut DashboardConfig),
        ) -> DashboardConfig {
            let (_cfg, _root, workspace) = fixture();
            let (first_loaded_tx, first_loaded_rx) = std::sync::mpsc::sync_channel(1);
            let (release_first_tx, release_first_rx) = std::sync::mpsc::sync_channel(1);
            let first_workspace = Arc::clone(&workspace);
            let first_thread = std::thread::spawn(move || {
                first_workspace
                    .update_dashboard(|config| {
                        first_loaded_tx.send(()).unwrap();
                        release_first_rx.recv().unwrap();
                        first(config);
                        true
                    })
                    .unwrap();
            });
            first_loaded_rx.recv().unwrap();

            let (second_loaded_tx, second_loaded_rx) = std::sync::mpsc::sync_channel(1);
            let second_workspace = Arc::clone(&workspace);
            let second_thread = std::thread::spawn(move || {
                second_workspace
                    .update_dashboard(|config| {
                        second_loaded_tx.send(()).unwrap();
                        second(config);
                        true
                    })
                    .unwrap();
            });

            match second_loaded_rx.recv_timeout(std::time::Duration::from_secs(1)) {
                Ok(()) => {
                    second_thread.join().unwrap();
                    release_first_tx.send(()).unwrap();
                    first_thread.join().unwrap();
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    release_first_tx.send(()).unwrap();
                    first_thread.join().unwrap();
                    second_thread.join().unwrap();
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    panic!("second dashboard update disconnected before mutation")
                }
            }

            workspace.dashboard_snapshot().unwrap()
        }

        #[test]
        fn concurrent_semantic_and_screensaver_updates_both_survive() {
            let config = run_concurrent_dashboard_updates(
                |config| config.semantic_enabled = true,
                |config| config.screensaver_enabled = true,
            );

            assert!(config.semantic_enabled);
            assert!(config.screensaver_enabled);
        }

        #[test]
        fn concurrent_reports_and_pin_updates_both_survive() {
            let config = run_concurrent_dashboard_updates(
                |config| config.reports_enabled = false,
                |config| config.screensaver_pin_hash = Some(vec![1, 2, 3, 4]),
            );

            assert!(!config.reports_enabled);
            assert_eq!(config.screensaver_pin_hash, Some(vec![1, 2, 3, 4]));
        }

        #[test]
        fn concurrent_dashboard_same_field_follows_serial_completion_order() {
            let config = run_concurrent_dashboard_updates(
                |config| config.screensaver_enabled = true,
                |config| config.screensaver_enabled = false,
            );

            assert!(!config.screensaver_enabled);
        }
    }

    #[test]
    fn dashboard_multi_field_screensaver_update_saves_once() {
        let (_cfg, _root, workspace) = fixture();
        dashboard::reset_test_save_probe(&workspace.paths.root);

        let config = workspace
            .update_screensaver(Some(true), Some(60), Some(ScreensaverTheme::Matrix))
            .unwrap();

        assert!(config.screensaver_enabled);
        assert_eq!(config.screensaver_timeout_secs, 60);
        assert_eq!(config.screensaver_theme, ScreensaverTheme::Matrix);
        assert_eq!(dashboard::test_save_calls(&workspace.paths.root), 1);
    }

    #[test]
    fn dashboard_malformed_toml_is_not_overwritten() {
        let (_cfg, _root, workspace) = fixture();
        let path = dashboard::config_path(&workspace.paths.root);
        let malformed = "screensaver_enabled = [\n";
        std::fs::write(&path, malformed).unwrap();

        let error = workspace
            .update_screensaver(Some(true), None, None)
            .unwrap_err();

        assert!(matches!(error, ChanError::ConfigDecode { .. }));
        assert_eq!(std::fs::read_to_string(path).unwrap(), malformed);
    }

    #[test]
    fn dashboard_injected_save_failure_preserves_prior_file() {
        let (_cfg, _root, workspace) = fixture();
        workspace
            .update_screensaver(Some(true), Some(60), None)
            .unwrap();
        let before = workspace.dashboard_snapshot().unwrap();
        dashboard::reset_test_save_probe(&workspace.paths.root);
        dashboard::inject_test_save_failure(&workspace.paths.root);

        let error = workspace
            .update_screensaver(None, Some(120), None)
            .unwrap_err();

        assert!(error
            .to_string()
            .contains("injected dashboard save failure"));
        assert_eq!(workspace.dashboard_snapshot().unwrap(), before);
        assert_eq!(dashboard::test_save_calls(&workspace.paths.root), 1);
    }

    #[test]
    fn semantic_model_setter_rejects_unknown_and_preserves_bm25() {
        let (_cfg, _root, workspace) = fixture();
        workspace.write_text("note.md", "alpha beta\n").unwrap();
        workspace.reindex(None).unwrap();
        let opts = SearchOpts {
            mode: SearchMode::Bm25,
            limit: 10,
            scope: None,
        };
        assert_eq!(workspace.search("alpha", &opts).unwrap().hits.len(), 1);

        let embeddings_dir = workspace.paths.index.join("embeddings");
        std::fs::create_dir_all(&embeddings_dir).unwrap();
        std::fs::write(embeddings_dir.join("stale.bin"), b"stale").unwrap();

        let before = workspace.semantic_model().unwrap();
        let err = workspace.set_semantic_model("not-a-model").unwrap_err();
        assert!(
            err.to_string().contains("unknown embedding model"),
            "unexpected error: {err}",
        );
        assert_eq!(workspace.semantic_model().unwrap(), before);

        workspace
            .set_semantic_model("BAAI/bge-base-en-v1.5")
            .unwrap();
        assert_eq!(workspace.semantic_model().unwrap(), "BAAI/bge-base-en-v1.5");
        assert!(
            !embeddings_dir.join("stale.bin").exists(),
            "switching models must clear stale embeddings",
        );
        assert_eq!(workspace.search("alpha", &opts).unwrap().hits.len(), 1);
    }

    #[test]
    fn reindex_disabled_writes_no_vectors_but_indexes_bm25() {
        // A workspace with semantic search OFF (the default) must never embed
        // on reindex: BM25 is populated and searchable, the vector count stays
        // zero. This is the opt-out guarantee: a cached model on disk is not a
        // reason to index.
        let (_cfg, _root, workspace) = fixture();
        assert!(
            !workspace.semantic_enabled().unwrap(),
            "a new workspace defaults to semantic OFF",
        );
        workspace
            .write_text("note.md", "alpha beta gamma\n")
            .unwrap();
        workspace.reindex(None).unwrap();

        let stats = workspace.index_stats().unwrap();
        assert!(stats.indexed_docs > 0, "BM25 must be populated");
        assert_eq!(
            stats.indexed_vectors, 0,
            "semantic off must produce zero vectors",
        );
        let opts = SearchOpts {
            mode: SearchMode::Bm25,
            limit: 10,
            scope: None,
        };
        assert_eq!(workspace.search("alpha", &opts).unwrap().hits.len(), 1);
    }

    #[test]
    fn per_file_index_disabled_writes_no_vectors() {
        // The incremental per-file path honours the same opt-out: a save while
        // semantic is off writes BM25 only, no vector shard.
        let (_cfg, _root, workspace) = fixture();
        workspace.write_text("note.md", "alpha beta\n").unwrap();
        workspace.index_file("note.md").unwrap();
        assert_eq!(
            workspace.index_stats().unwrap().indexed_vectors,
            0,
            "per-file save with semantic off must not embed",
        );
        let opts = SearchOpts {
            mode: SearchMode::Bm25,
            limit: 10,
            scope: None,
        };
        assert_eq!(workspace.search("alpha", &opts).unwrap().hits.len(), 1);
    }

    #[test]
    fn disabling_semantic_bins_the_vector_store() {
        // Toggling semantic OFF is destructive: it wipes the vector store so a
        // later re-enable rebuilds from scratch, while BM25 is preserved.
        // Mirrors the stale-shard setup used by the model-switch test since no
        // embedder is loaded in tests.
        let (_cfg, _root, workspace) = fixture();
        workspace.write_text("note.md", "alpha beta\n").unwrap();
        workspace.reindex(None).unwrap();
        workspace.set_semantic_enabled(true).unwrap();
        assert!(workspace.semantic_enabled().unwrap());

        // Stand in for real embeddings: drop a shard file the wipe must remove.
        let embeddings_dir = workspace.paths.index.join("embeddings");
        std::fs::create_dir_all(&embeddings_dir).unwrap();
        std::fs::write(embeddings_dir.join("stale.bin"), b"stale").unwrap();

        workspace.set_semantic_enabled(false).unwrap();
        assert!(!workspace.semantic_enabled().unwrap());
        assert!(
            !embeddings_dir.join("stale.bin").exists(),
            "disabling semantic must bin the vector store",
        );

        // BM25 survives the wipe.
        let opts = SearchOpts {
            mode: SearchMode::Bm25,
            limit: 10,
            scope: None,
        };
        assert_eq!(workspace.search("alpha", &opts).unwrap().hits.len(), 1);

        // Re-enabling flips the flag back (non-destructive; the server's
        // indexer rebuilds the vectors from scratch).
        workspace.set_semantic_enabled(true).unwrap();
        assert!(workspace.semantic_enabled().unwrap());
    }

    #[test]
    fn reports_enabled_defaults_true_round_trips_and_boot_kicks_off_initial_scan() {
        // Workspace::reports_enabled defaults
        // TRUE for a new workspace (reports on by default); boot kicks off the
        // initial scan when the flag is on so the first `Workspace::report()`
        // consumer sees populated data; set_reports_enabled round-trips the
        // flag; disable drops the persisted jsonl.
        let (_cfg, _root, workspace) = fixture();
        assert!(
            workspace.reports_enabled().unwrap(),
            "a new workspace defaults to reports ON"
        );

        // On by default, so boot kicks the initial scan. boot() is idempotent.
        workspace.boot().unwrap();
        workspace.boot().unwrap(); // re-call no-op
                                   // Confirm the report state was initialized (the persisted
                                   // jsonl now exists after boot's initial scan + flush). The
                                   // writer thread flushes async, so give it a small window.
        for _ in 0..50 {
            if workspace.paths().report.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        // Disable drops the persisted jsonl + round-trips the flag off.
        workspace.set_reports_enabled(false).unwrap();
        assert!(!workspace.reports_enabled().unwrap());
        assert!(
            !workspace.paths().report.exists(),
            "disable should drop the persisted report.jsonl"
        );

        // Re-enable round-trips back on.
        workspace.set_reports_enabled(true).unwrap();
        assert!(workspace.reports_enabled().unwrap());
    }

    #[test]
    fn excluded_dirs_additions_union_with_the_global_baseline() {
        // Per-workspace blocklist additions union
        // with the global baseline; the effective set drives the reindex walk.
        let (_cfg, _root, workspace) = fixture();
        // Fresh workspace: no additions; effective == the global baseline.
        assert!(workspace.excluded_dirs().unwrap().is_empty());
        let base = workspace.global_excluded_dirs();
        assert_eq!(workspace.effective_excluded_dirs().unwrap(), base);

        // Add a per-workspace dir: persisted, and effective = base + addition.
        workspace
            .set_excluded_dirs(vec!["vendor".to_string()])
            .unwrap();
        assert_eq!(
            workspace.excluded_dirs().unwrap(),
            vec!["vendor".to_string()]
        );
        let eff = workspace.effective_excluded_dirs().unwrap();
        assert!(eff.contains(&"vendor".to_string()), "addition in effective");
        for b in &base {
            assert!(eff.contains(b), "baseline {b} preserved in effective");
        }

        // Round-trips back to empty (clearing the additions).
        workspace.set_excluded_dirs(vec![]).unwrap();
        assert!(workspace.excluded_dirs().unwrap().is_empty());
        assert_eq!(workspace.effective_excluded_dirs().unwrap(), base);
    }

    #[test]
    fn boot_is_noop_when_features_disabled() {
        // boot() with both feature flags off is a
        // pure no-op. No report scan kicked off; no eager
        // initialization that would slow down chan-server startup
        // on a lean workspace. Reports default ON, so
        // explicitly turn it off to exercise the both-off no-op path.
        let (_cfg, _root, workspace) = fixture();
        workspace.set_reports_enabled(false).unwrap();
        assert!(!workspace.semantic_enabled().unwrap());
        assert!(!workspace.reports_enabled().unwrap());
        workspace.boot().unwrap();
        // No-op: report jsonl never created since reports_enabled
        // stayed false.
        assert!(!workspace.paths().report.exists());
    }

    #[test]
    fn next_untitled_draft_name_counts_up_through_gaps() {
        // Smallest-unused-N picker. First call
        // returns bare `untitled`. After `untitled` exists the
        // picker returns `untitled-1`, then `untitled-2`, etc.
        // Gaps in the existing-set ARE filled (smallest unused,
        // not always last+1) -- the caller of create_draft_dir is
        // free to skip-number names by hand.
        let (_cfg, _root, workspace) = fixture();
        assert_eq!(workspace.next_untitled_draft_name().unwrap(), "untitled");
        workspace.create_draft_dir("untitled").unwrap();
        assert_eq!(workspace.next_untitled_draft_name().unwrap(), "untitled-1");
        workspace.create_draft_dir("untitled-1").unwrap();
        workspace.create_draft_dir("untitled-3").unwrap();
        // Gap: untitled-2 free → that's the next pick.
        assert_eq!(workspace.next_untitled_draft_name().unwrap(), "untitled-2");
    }

    #[test]
    fn in_root_draft_path_write_text_if_unchanged() {
        // Optimistic-concurrency parity: in-root draft edits get the
        // same WriteConflict semantics as any other in-root edit.
        let (_cfg, _root, workspace) = fixture();
        workspace.create_draft_dir("untitled-1").unwrap();
        let rel = ".Drafts/untitled-1/draft.md";
        // First write: file doesn't exist; expected_mtime=None
        // succeeds.
        workspace.write_text_if_unchanged(rel, None, "v1").unwrap();
        let (_, stat) = workspace.read_text_with_stat(rel).unwrap();
        // Stale-mtime write: rejected.
        let err = workspace
            .write_text_if_unchanged(rel, Some(stat.mtime_ns.unwrap_or(0) + 1), "v2")
            .unwrap_err();
        assert!(matches!(err, ChanError::WriteConflict { .. }));
        // Current-mtime write: accepted.
        workspace
            .write_text_if_unchanged(rel, stat.mtime_ns, "v2")
            .unwrap();
        assert_eq!(workspace.read_text(rel).unwrap(), "v2");
    }

    #[test]
    fn drafts_promote_rejects_when_target_exists() {
        // promote_draft refuses to clobber an existing workspace-root
        // file/directory. The draft remains in place for the caller to
        // retry under a different target.
        let (_cfg, root, workspace) = fixture();
        workspace.create_draft_dir("untitled-1").unwrap();
        workspace
            .write_text(".Drafts/untitled-1/draft.md", "# draft\n")
            .unwrap();
        workspace
            .write_bytes(".Drafts/untitled-1/pasted.png", &[1, 2, 3])
            .unwrap();
        workspace.write_text("untitled-1/sentinel.md", "x").unwrap();
        workspace
            .write_text("untitled-1/draft.md", "existing")
            .unwrap();
        assert!(workspace.promote_draft("untitled-1", "untitled-1").is_err());
        // Draft still exists; nothing in the workspace's untitled-1
        // dir was disturbed.
        assert!(workspace.drafts_dir().join("untitled-1").is_dir());
        assert!(root.path().join("untitled-1").join("sentinel.md").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn remove_rejects_unix_socket() {
        use std::os::unix::net::UnixListener;
        let (_cfg, root, workspace) = fixture();
        let _l = UnixListener::bind(root.path().join("s")).unwrap();
        let err = workspace.remove("s").unwrap_err();
        assert!(matches!(err, ChanError::SpecialFile { .. }));
        // Socket survives the rejected remove.
        assert!(root.path().join("s").symlink_metadata().is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn stat_uses_lstat_for_symlinks() {
        use std::os::unix::fs::symlink;
        let (_cfg, root, workspace) = fixture();
        std::fs::create_dir(root.path().join("d")).unwrap();
        symlink("d", root.path().join("link_to_dir")).unwrap();
        // lstat reports the symlink itself, which is a symlink (not
        // a directory). is_dir is false because symlink_metadata
        // does not follow.
        let st = workspace.stat("link_to_dir").unwrap();
        assert!(!st.is_dir);
    }

    #[test]
    fn link_targets_finds_file_after_index() {
        let (_cfg, _root, workspace) = fixture();
        workspace
            .write_text("recipes/carbonara.md", "# Carbonara\n\n## Ingredients\n")
            .unwrap();
        workspace.index_file("recipes/carbonara.md").unwrap();
        let hits = workspace.link_targets("carb", 10).unwrap();
        assert!(hits
            .iter()
            .any(|h| h.path == "recipes/carbonara.md"
                && h.kind == crate::graph::LinkTargetKind::File));
        // Heading is also searchable by the same surface.
        let hits = workspace.link_targets("ingred", 10).unwrap();
        assert!(hits
            .iter()
            .any(|h| h.kind == crate::graph::LinkTargetKind::Heading
                && h.heading.as_deref() == Some("Ingredients")));
    }

    #[test]
    fn graph_handle_is_stable_after_metadata_open() {
        let (_cfg, _root, workspace) = fixture();
        // Calling graph() twice returns the same handle; this is
        // the contract the editor relies on for incremental
        // updates from the watcher.
        let _g1 = workspace.graph().unwrap();
        let _g2 = workspace.graph().unwrap();
    }

    #[test]
    fn session_blob_round_trip() {
        let (_cfg, _root, workspace) = fixture();
        workspace.put_session("win-1", b"layout-v1").unwrap();
        assert_eq!(
            workspace.get_session("win-1").unwrap().unwrap(),
            b"layout-v1"
        );
        workspace.put_session("win-1", b"layout-v2").unwrap();
        workspace.put_session("win-2", b"other").unwrap();
        let mut keys = workspace.list_sessions().unwrap();
        keys.sort();
        assert_eq!(keys, vec!["win-1", "win-2"]);
        workspace.delete_session("win-1").unwrap();
        assert!(workspace.get_session("win-1").unwrap().is_none());
        // Idempotent.
        workspace.delete_session("win-1").unwrap();
    }

    #[test]
    fn workspace_open_preserves_opaque_session_bytes() {
        let (cfg, root, workspace) = fixture();
        workspace.put_session("host-session", b"null").unwrap();
        drop(workspace);

        let library = Library::open_at(cfg.path().join("config.toml")).unwrap();
        let reopened = library.open_workspace(root.path()).unwrap();
        assert_eq!(
            reopened.get_session("host-session").unwrap().as_deref(),
            Some(&b"null"[..]),
        );
    }

    #[test]
    fn blob_key_validation_blocks_traversal() {
        let (_cfg, _root, workspace) = fixture();
        let err = workspace.put_session("../escape", b"x").unwrap_err();
        assert!(matches!(err, ChanError::InvalidKey(_)));
    }

    // ---- resolve_link ----

    fn link_fixture() -> (TempDir, TempDir, Arc<Workspace>) {
        let (cfg, root, workspace) = fixture();
        std::fs::create_dir_all(root.path().join("recipes")).unwrap();
        std::fs::write(root.path().join("recipes").join("pasta.md"), "# Pasta\n").unwrap();
        std::fs::write(root.path().join("intro.md"), "# Intro\n").unwrap();
        std::fs::write(root.path().join("note.txt"), "plain\n").unwrap();
        std::fs::write(root.path().join("README"), "no ext\n").unwrap();
        (cfg, root, workspace)
    }

    #[test]
    fn resolve_link_md_extension() {
        let (_cfg, _root, workspace) = link_fixture();
        let r = workspace.resolve_link("recipes/pasta").unwrap();
        assert_eq!(r.path, "recipes/pasta.md");
        assert_eq!(r.anchor, None);
        assert!(!r.is_dir);
    }

    #[test]
    fn resolve_link_directory_resolves_to_folder_with_is_dir() {
        let (_cfg, _root, workspace) = link_fixture();
        // `recipes` is a directory, not a file: no `.md`/`.txt`/exact
        // file candidate matches, so it resolves to the folder itself.
        let r = workspace.resolve_link("recipes").unwrap();
        assert_eq!(r.path, "recipes");
        assert!(r.is_dir);
    }

    #[test]
    fn resolve_link_file_is_not_dir() {
        let (_cfg, _root, workspace) = link_fixture();
        assert!(!workspace.resolve_link("intro").unwrap().is_dir);
    }

    #[test]
    fn resolve_link_with_anchor() {
        let (_cfg, _root, workspace) = link_fixture();
        let r = workspace.resolve_link("recipes/pasta#ingredients").unwrap();
        assert_eq!(r.path, "recipes/pasta.md");
        assert_eq!(r.anchor.as_deref(), Some("ingredients"));
    }

    #[test]
    fn resolve_link_txt_fallback() {
        let (_cfg, _root, workspace) = link_fixture();
        let r = workspace.resolve_link("note").unwrap();
        assert_eq!(r.path, "note.txt");
    }

    #[test]
    fn resolve_link_exact_match_no_extension() {
        let (_cfg, _root, workspace) = link_fixture();
        let r = workspace.resolve_link("README").unwrap();
        assert_eq!(r.path, "README");
    }

    #[test]
    fn resolve_link_prefers_md_over_txt() {
        let (_cfg, root, workspace) = link_fixture();
        // both intro.md AND intro.txt exist -> .md wins
        std::fs::write(root.path().join("intro.txt"), "plain\n").unwrap();
        let r = workspace.resolve_link("intro").unwrap();
        assert_eq!(r.path, "intro.md");
    }

    // ---- .txt is searchable but not a graph document ----

    /// Only Markdown (.md) is a graph document; .txt stays editable +
    /// BM25-searchable but is never a graph node. A full reindex must
    /// stage the .md node and skip the .txt, while BM25 still indexes the
    /// .txt content so a shared token finds both files.
    #[test]
    fn reindex_txt_searchable_but_not_a_graph_document() {
        let (_cfg, root, workspace) = fixture();
        std::fs::write(root.path().join("note.md"), "# Note\n\nzebraword\n").unwrap();
        std::fs::write(root.path().join("plain.txt"), "zebraword in plain text\n").unwrap();
        workspace.reindex(None).unwrap();

        let graph_files = workspace.graph().unwrap().files().unwrap();
        assert!(
            graph_files.iter().any(|p| p == "note.md"),
            "markdown must be a graph document: {graph_files:?}"
        );
        assert!(
            !graph_files.iter().any(|p| p == "plain.txt"),
            ".txt must not be a graph document: {graph_files:?}"
        );

        let opts = crate::workspace::SearchOpts {
            mode: crate::SearchMode::Bm25,
            limit: 100,
            scope: None,
        };
        let hits: Vec<String> = workspace
            .search("zebraword", &opts)
            .unwrap()
            .hits
            .into_iter()
            .map(|h| h.path)
            .collect();
        assert!(
            hits.iter().any(|p| p == "plain.txt"),
            ".txt must stay BM25-searchable: {hits:?}"
        );
        assert!(
            hits.iter().any(|p| p == "note.md"),
            ".md must stay BM25-searchable: {hits:?}"
        );
    }

    /// The incremental per-file path keeps the same split: `index_file`
    /// on a .md creates a graph node, on a .txt it does not (but BM25
    /// still indexes it).
    #[test]
    fn index_file_txt_skips_graph_node() {
        let (_cfg, _root, workspace) = fixture();
        workspace
            .write_text("a.md", "# A\n\nmarkertoken\n")
            .unwrap();
        workspace
            .write_text("b.txt", "markertoken in plain text\n")
            .unwrap();
        workspace.index_file("a.md").unwrap();
        workspace.index_file("b.txt").unwrap();

        let graph_files = workspace.graph().unwrap().files().unwrap();
        assert!(
            graph_files.iter().any(|p| p == "a.md"),
            "markdown must be a graph node: {graph_files:?}"
        );
        assert!(
            !graph_files.iter().any(|p| p == "b.txt"),
            ".txt must not be a graph node: {graph_files:?}"
        );
    }

    #[test]
    fn resolve_link_nonexistent_returns_none() {
        let (_cfg, _root, workspace) = link_fixture();
        assert!(workspace.resolve_link("does/not/exist").is_none());
    }

    #[test]
    fn resolve_link_empty_target_returns_none() {
        let (_cfg, _root, workspace) = link_fixture();
        assert!(workspace.resolve_link("").is_none());
    }

    #[test]
    fn resolve_link_trailing_hash_drops_anchor() {
        let (_cfg, _root, workspace) = link_fixture();
        // `target#` (empty anchor) resolves the path with anchor None.
        let r = workspace.resolve_link("recipes/pasta#").unwrap();
        assert_eq!(r.path, "recipes/pasta.md");
        assert_eq!(r.anchor, None);
    }

    #[test]
    fn resolve_link_path_escape_rejected() {
        let (_cfg, _root, workspace) = link_fixture();
        // resolve_link goes through Workspace::exists which rejects
        // path traversal. Should return None, not panic.
        assert!(workspace.resolve_link("../etc/passwd").is_none());
    }

    /// The graph row workspaces the kind. An unindexed file still
    /// resolves (we found it on disk) but the kind defaults to
    /// `File` so the editor can render a generic doc pill while the
    /// indexer catches up.
    #[test]
    fn resolve_link_kind_defaults_to_file_when_unindexed() {
        let (_cfg, _root, workspace) = link_fixture();
        let r = workspace.resolve_link("recipes/pasta").unwrap();
        assert_eq!(r.kind, crate::graph::NodeKind::File);
    }

    /// After indexing a contact-frontmatter file, resolve_link's kind
    /// matches what the picker put in the graph. This is the path
    /// that workspaces the editor's kind-aware pill rendering.
    #[test]
    fn resolve_link_returns_contact_kind_for_contact_node() {
        let (_cfg, root, workspace) = link_fixture();
        std::fs::create_dir_all(root.path().join("Contacts")).unwrap();
        let contact = "---\nchan:\n  kind: contact\n---\n\n# Alice Anderson\n\n- **Email**: alice@example.com\n";
        std::fs::write(root.path().join("Contacts").join("Alice.md"), contact).unwrap();
        workspace.index_file("Contacts/Alice.md").unwrap();
        let r = workspace.resolve_link("Contacts/Alice").unwrap();
        assert_eq!(r.path, "Contacts/Alice.md");
        assert_eq!(r.kind, crate::graph::NodeKind::Contact);
    }

    /// Plain markdown files index as `NodeKind::File`; round-trip
    /// resolve_link to confirm the kind reflects the indexed value
    /// (not a constant default).
    #[test]
    fn resolve_link_returns_file_kind_for_plain_note() {
        let (_cfg, _root, workspace) = link_fixture();
        workspace.index_file("recipes/pasta.md").unwrap();
        let r = workspace.resolve_link("recipes/pasta").unwrap();
        assert_eq!(r.kind, crate::graph::NodeKind::File);
    }

    #[test]
    fn resolve_link_path_with_md_extension_unchanged() {
        let (_cfg, _root, workspace) = link_fixture();
        // If the user already wrote `[[recipes/pasta.md]]`, our
        // first probe is `recipes/pasta.md.md` which doesn't
        // exist; second is `.txt`; third is the exact path which
        // does. Resolves to the original verbatim.
        let r = workspace.resolve_link("recipes/pasta.md").unwrap();
        assert_eq!(r.path, "recipes/pasta.md");
    }

    // ---- build_edges (link normalization) ----

    fn md_link(target: &str) -> markdown::Link {
        markdown::Link {
            target: target.to_string(),
            label: None,
            wiki: false,
        }
    }

    fn wiki_link(target: &str) -> markdown::Link {
        markdown::Link {
            target: target.to_string(),
            label: None,
            wiki: true,
        }
    }

    fn dsts(edges: &[crate::graph::Edge]) -> Vec<&str> {
        edges.iter().map(|e| e.dst.as_str()).collect()
    }

    #[test]
    fn build_edges_normalizes_workspace_rooted_markdown_link() {
        // `[link](/images/foo.png)` from notes/post.md should land
        // at dst=images/foo.png, not /images/foo.png.
        let edges = build_edges("notes/post.md", &[md_link("/images/foo.png")], &[]);
        assert_eq!(dsts(&edges), vec!["images/foo.png"]);
    }

    #[test]
    fn build_edges_normalizes_parent_relative_markdown_link() {
        // `[link](../images/foo.png)` from notes/post.md collapses
        // lexically to images/foo.png.
        let edges = build_edges("notes/post.md", &[md_link("../images/foo.png")], &[]);
        assert_eq!(dsts(&edges), vec!["images/foo.png"]);
    }

    #[test]
    fn build_edges_skips_external_markdown_link() {
        let edges = build_edges("notes/post.md", &[md_link("https://example.com/x")], &[]);
        assert!(edges.is_empty());
    }

    #[test]
    fn build_edges_skips_fragment_only_link() {
        let edges = build_edges("notes/post.md", &[md_link("#section")], &[]);
        assert!(edges.is_empty());
    }

    #[test]
    fn build_edges_skips_workspace_escape() {
        // `../../x.md` from a depth-1 file pops past the workspace root.
        let edges = build_edges("notes/post.md", &[md_link("../../x.md")], &[]);
        assert!(edges.is_empty());
    }

    #[test]
    fn build_edges_preserves_anchor_column() {
        let edges = build_edges("notes/post.md", &[md_link("/a.md#sec")], &[]);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].dst, "a.md");
        assert_eq!(edges[0].anchor.as_deref(), Some("sec"));
    }

    #[test]
    fn build_edges_drops_anchor_for_non_markdown_target() {
        // `![alt](img.png#width=300)` is the Obsidian image-sizing
        // syntax; the `#...` suffix is a render hint, not a heading
        // anchor. The graph edge must point at `img.png` with an
        // empty anchor so the inspector's backlinks query and the
        // anchor column itself stay semantically clean.
        let edges = build_edges("notes/post.md", &[md_link("img.png#width=300")], &[]);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].dst, "notes/img.png");
        assert!(edges[0].anchor.is_none(), "got: {:?}", edges[0].anchor);
    }

    #[test]
    fn build_edges_wiki_default_workspace_rooted() {
        // Plain `[[Contacts/Jane Doe]]` from any source dir resolves
        // to the workspace root. Matches the picker's existing insertion
        // form and keeps the smoke-test invariant.
        let edges = build_edges("notes/post.md", &[wiki_link("Contacts/Jane Doe")], &[]);
        assert_eq!(dsts(&edges), vec!["Contacts/Jane Doe"]);
    }

    #[test]
    fn build_edges_wiki_explicit_absolute() {
        let edges = build_edges("notes/post.md", &[wiki_link("/Contacts/Jane Doe")], &[]);
        assert_eq!(dsts(&edges), vec!["Contacts/Jane Doe"]);
    }

    #[test]
    fn build_edges_wiki_relative_walks_up() {
        // `[[../foo]]` from notes/post.md walks up to workspace root.
        let edges = build_edges("notes/post.md", &[wiki_link("../foo")], &[]);
        assert_eq!(dsts(&edges), vec!["foo"]);
    }

    #[test]
    fn build_edges_wiki_dot_relative_resolves_to_source_dir() {
        let edges = build_edges("notes/post.md", &[wiki_link("./sibling")], &[]);
        assert_eq!(dsts(&edges), vec!["notes/sibling"]);
    }

    // ---- rename_with_link_rewrite ---------------------------------------

    /// Set up two files and reindex so the graph knows about the
    /// `src -> dst` link. Returns the fixture handles plus the path
    /// strings so tests can rename and assert.
    fn rename_fixture(
        src_rel: &str,
        src_body: &str,
        dst_rel: &str,
        dst_body: &str,
    ) -> (TempDir, TempDir, Arc<Workspace>) {
        let (cfg, root, workspace) = fixture();
        // Create parent directories as needed (write_text only creates
        // the immediate parent at the cap-std layer).
        for p in [src_rel, dst_rel] {
            if let Some(slash) = p.rfind('/') {
                std::fs::create_dir_all(root.path().join(&p[..slash])).unwrap();
            }
        }
        workspace.write_text(dst_rel, dst_body).unwrap();
        workspace.write_text(src_rel, src_body).unwrap();
        // Build the graph so `backlinks` returns the right edge.
        workspace.reindex(None).unwrap();
        (cfg, root, workspace)
    }

    #[test]
    fn rename_with_link_rewrite_updates_inbound_markdown_link() {
        let (_cfg, _root, workspace) = rename_fixture(
            "src.md",
            "see [target](./old.md) for context\n",
            "old.md",
            "# Old\n",
        );
        let outcome = workspace
            .rename_with_link_rewrite("old.md", "new.md")
            .unwrap();
        assert_eq!(outcome.renamed, vec![("old.md".into(), "new.md".into())]);
        assert_eq!(outcome.rewritten, vec!["src.md".to_string()]);
        assert!(outcome.conflicts.is_empty());
        assert_eq!(
            workspace.read_text("src.md").unwrap(),
            "see [target](./new.md) for context\n",
        );
    }

    #[test]
    fn rename_with_link_rewrite_preserves_anchor() {
        let (_cfg, _root, workspace) = rename_fixture(
            "src.md",
            "see [target](./old.md#section-2) for context\n",
            "old.md",
            "# Old\n\n## Section 2\n",
        );
        workspace
            .rename_with_link_rewrite("old.md", "new.md")
            .unwrap();
        assert_eq!(
            workspace.read_text("src.md").unwrap(),
            "see [target](./new.md#section-2) for context\n",
        );
    }

    #[test]
    fn rename_with_link_rewrite_demotes_workspace_rooted_markdown_to_relative() {
        // Workspace-rooted markdown links (`/foo.md`) read as filesystem-
        // rooted in any renderer that isn't chan's own (browsers,
        // GitHub, Obsidian on export). We use every rewrite pass as
        // an opportunity to migrate them to the relative form so the
        // markdown round-trips outside chan.
        let (_cfg, _root, workspace) = rename_fixture(
            "notes/src.md",
            "see [target](/old.md) for context\n",
            "old.md",
            "# Old\n",
        );
        workspace
            .rename_with_link_rewrite("old.md", "deep/new.md")
            .unwrap();
        assert_eq!(
            workspace.read_text("notes/src.md").unwrap(),
            "see [target](../deep/new.md) for context\n",
        );
    }

    #[test]
    fn rename_with_link_rewrite_demotes_workspace_rooted_when_source_moves() {
        // Demotion also kicks in when the source file itself moves
        // and the target hadn't: the link is now relative-eligible
        // because the source's directory changed even if the target
        // didn't.
        let (_cfg, root, workspace) = fixture();
        std::fs::create_dir_all(root.path().join("notes")).unwrap();
        workspace.write_text("home.md", "# Home\n").unwrap();
        workspace
            .write_text("notes/src.md", "see [home](/home.md) tail\n")
            .unwrap();
        workspace.reindex(None).unwrap();
        workspace
            .rename_with_link_rewrite("notes/src.md", "archive/src.md")
            .unwrap();
        assert_eq!(
            workspace.read_text("archive/src.md").unwrap(),
            "see [home](../home.md) tail\n",
        );
    }

    #[test]
    fn rename_with_link_rewrite_handles_wiki_link() {
        // Wiki rewrites emit an explicit `./` or `../` prefix because
        // the bare `[[name]]` form means workspace-rooted by chan
        // convention; relativization needs the prefix to disambiguate.
        let (_cfg, _root, workspace) =
            rename_fixture("src.md", "see [[old]] for context\n", "old.md", "# Old\n");
        workspace
            .rename_with_link_rewrite("old.md", "archive/old.md")
            .unwrap();
        assert_eq!(
            workspace.read_text("src.md").unwrap(),
            "see [[./archive/old]] for context\n",
        );
    }

    #[test]
    fn rename_with_link_rewrite_handles_image_ref() {
        let (_cfg, _root, workspace) = fixture();
        std::fs::create_dir_all(_root.path().join("images")).unwrap();
        std::fs::write(
            _root.path().join("images").join("cat.png"),
            b"\x89PNG\r\n\x1a\n",
        )
        .unwrap();
        workspace
            .write_text("src.md", "![cat](images/cat.png) ok\n")
            .unwrap();
        workspace.reindex(None).unwrap();
        workspace
            .rename_with_link_rewrite("images/cat.png", "img/cat.png")
            .unwrap();
        assert_eq!(
            workspace.read_text("src.md").unwrap(),
            "![cat](img/cat.png) ok\n",
        );
    }

    #[test]
    fn rename_with_link_rewrite_directory_rewrites_all_inbound() {
        let (_cfg, root, workspace) = fixture();
        std::fs::create_dir_all(root.path().join("A")).unwrap();
        workspace.write_text("A/x.md", "# X\n").unwrap();
        workspace.write_text("A/y.md", "# Y\n").unwrap();
        workspace
            .write_text("src.md", "links: [x](A/x.md) and [y](A/y.md) end\n")
            .unwrap();
        workspace.reindex(None).unwrap();
        workspace.rename_with_link_rewrite("A", "B").unwrap();
        assert_eq!(
            workspace.read_text("src.md").unwrap(),
            "links: [x](B/x.md) and [y](B/y.md) end\n",
        );
    }

    #[test]
    fn rename_with_link_rewrite_does_not_touch_external_links() {
        let (_cfg, _root, workspace) = rename_fixture(
            "src.md",
            "ext [a](https://example.com/old.md) and [b](./old.md)\n",
            "old.md",
            "# Old\n",
        );
        workspace
            .rename_with_link_rewrite("old.md", "new.md")
            .unwrap();
        assert_eq!(
            workspace.read_text("src.md").unwrap(),
            "ext [a](https://example.com/old.md) and [b](./new.md)\n",
        );
    }

    #[test]
    fn rename_with_link_rewrite_self_referential_relative_link() {
        // src lives inside the moved subtree; a relative link inside src
        // pointing at a sibling that ALSO moves with the rename should
        // stay valid (./sib.md still resolves correctly post-rename),
        // so no rewrite is required.
        let (_cfg, root, workspace) = fixture();
        std::fs::create_dir_all(root.path().join("A")).unwrap();
        workspace
            .write_text("A/x.md", "see [sib](./sib.md)\n")
            .unwrap();
        workspace.write_text("A/sib.md", "# Sib\n").unwrap();
        workspace.reindex(None).unwrap();
        workspace.rename_with_link_rewrite("A", "B").unwrap();
        assert_eq!(
            workspace.read_text("B/x.md").unwrap(),
            "see [sib](./sib.md)\n",
        );
    }

    #[test]
    fn rename_with_link_rewrite_self_to_external_target() {
        // src moves but a link inside it points at a file OUTSIDE the
        // moved subtree. The relative reference must be re-relativized.
        let (_cfg, root, workspace) = fixture();
        std::fs::create_dir_all(root.path().join("A")).unwrap();
        std::fs::create_dir_all(root.path().join("shared")).unwrap();
        workspace
            .write_text("A/x.md", "see [s](../shared/note.md)\n")
            .unwrap();
        workspace
            .write_text("shared/note.md", "# Shared\n")
            .unwrap();
        workspace.reindex(None).unwrap();
        workspace.rename_with_link_rewrite("A", "deep/B").unwrap();
        // Source is now at deep/B/x.md. Relative to that, the target
        // is at ../../shared/note.md.
        assert_eq!(
            workspace.read_text("deep/B/x.md").unwrap(),
            "see [s](../../shared/note.md)\n",
        );
    }

    #[test]
    fn rename_with_link_rewrite_wiki_workspace_rooted_from_subdir() {
        // Regression: a wiki link `[[friends/alice]]` from a source
        // file that LIVES in `friends/` must still resolve to the
        // workspace-rooted `friends/alice`, not to `friends/friends/alice`
        // as plain `normalize_href` would do for a bare relative path.
        // build_edges applies this rule on the index side; the rewrite
        // callback mirrors it. After resolution, we emit the new path
        // as an up-relative wiki target.
        let (_cfg, root, workspace) = fixture();
        std::fs::create_dir_all(root.path().join("friends")).unwrap();
        workspace
            .write_text("friends/alice.md", "# Alice\n")
            .unwrap();
        workspace
            .write_text("friends/bob.md", "see [[friends/alice]] end\n")
            .unwrap();
        workspace.reindex(None).unwrap();
        workspace
            .rename_with_link_rewrite("friends/alice.md", "archive/alice.md")
            .unwrap();
        assert_eq!(
            workspace.read_text("friends/bob.md").unwrap(),
            "see [[../archive/alice]] end\n",
        );
    }

    #[test]
    fn rename_with_link_rewrite_wiki_workspace_rooted_in_moved_source() {
        // When the source moves, its outgoing wiki links re-anchor
        // against the new source dir: `[[index]]` from a file moved
        // to `friends/` becomes `[[../index]]` so it still points at
        // the same file outside chan's renderer too.
        let (_cfg, root, workspace) = fixture();
        std::fs::create_dir_all(root.path().join("friends")).unwrap();
        workspace.write_text("index.md", "# Index\n").unwrap();
        workspace
            .write_text("alice.md", "ref [[index]] tail\n")
            .unwrap();
        workspace.reindex(None).unwrap();
        workspace
            .rename_with_link_rewrite("alice.md", "friends/alice.md")
            .unwrap();
        assert_eq!(
            workspace.read_text("friends/alice.md").unwrap(),
            "ref [[../index]] tail\n",
        );
    }

    #[test]
    fn rename_with_link_rewrite_chain_of_renames_on_same_file() {
        // Rename the same file twice between reindexes. The second
        // rename must still find the inbound backlink even though the
        // graph's src column was indexed against the original path.
        let (_cfg, _root, workspace) =
            rename_fixture("src.md", "see [a](./a.md) end\n", "a.md", "# A\n");
        workspace.rename_with_link_rewrite("a.md", "b.md").unwrap();
        // After the first rename, src.md points at ./b.md.
        assert_eq!(
            workspace.read_text("src.md").unwrap(),
            "see [a](./b.md) end\n",
        );
        // Now rename b.md to c.md WITHOUT reindexing. The graph still
        // records the inbound edge against the original "a.md" path,
        // so the second rename must use the cumulative log to find
        // src.md as a backlink source via the original name.
        workspace.rename_with_link_rewrite("b.md", "c.md").unwrap();
        assert_eq!(
            workspace.read_text("src.md").unwrap(),
            "see [a](./c.md) end\n",
        );
    }

    #[test]
    fn rename_with_link_rewrite_source_moved_in_prior_rename() {
        // The original failing scenario: source file moves first
        // (friends/alice.md -> archive/alice-2.md), then a target the
        // source references moves (notes/beta.md -> archive/beta.md).
        // The graph's backlinks query for the moved target returns the
        // source's ORIGINAL path; without the log we'd read at that
        // stale path, fail, and skip the rewrite. With the log we
        // translate to the source's current path and update the link.
        let (_cfg, root, workspace) = fixture();
        std::fs::create_dir_all(root.path().join("notes")).unwrap();
        std::fs::create_dir_all(root.path().join("friends")).unwrap();
        workspace.write_text("notes/beta.md", "# Beta\n").unwrap();
        workspace
            .write_text("friends/alice.md", "ref [beta](../notes/beta.md)\n")
            .unwrap();
        workspace.reindex(None).unwrap();
        // Move 1: source moves.
        workspace
            .rename_with_link_rewrite("friends/alice.md", "archive/alice-2.md")
            .unwrap();
        // Move 2: target moves. Bug 2 was here: alice-2.md kept the
        // stale `../notes/beta.md` because the graph still had alice's
        // pre-move src path and the lookup failed silently.
        workspace
            .rename_with_link_rewrite("notes/beta.md", "archive/beta.md")
            .unwrap();
        // Original href was `../notes/beta.md` (up-relative, no `./`),
        // so the rewritten bare-relative form is `beta.md`; the
        // dot-explicit prefix is only added when the original used it.
        assert_eq!(
            workspace.read_text("archive/alice-2.md").unwrap(),
            "ref [beta](beta.md)\n",
        );
    }

    #[test]
    fn rename_with_link_rewrite_log_cleared_by_reindex() {
        // After a reindex the graph is fresh and the cumulative log
        // becomes a liability (it could redirect a path the user has
        // re-created with new content). Reindex must clear it.
        let (_cfg, _root, workspace) =
            rename_fixture("src.md", "see [a](./a.md) end\n", "a.md", "# A\n");
        workspace.rename_with_link_rewrite("a.md", "b.md").unwrap();
        // Reindex now sees the fresh tree.
        workspace.reindex(None).unwrap();
        // Recreate a fresh file at the original name `a.md`. Without
        // the clear, the log would translate "a.md" to "b.md" and a
        // future rename of the FRESH a.md would behave wrongly.
        workspace.write_text("a.md", "# fresh A\n").unwrap();
        workspace
            .write_text("src2.md", "see [a](./a.md) end\n")
            .unwrap();
        workspace.reindex(None).unwrap();
        // Renaming the fresh a.md to z.md should rewrite src2.md
        // without confusion from the prior log entry.
        workspace.rename_with_link_rewrite("a.md", "z.md").unwrap();
        assert_eq!(
            workspace.read_text("src2.md").unwrap(),
            "see [a](./z.md) end\n",
        );
    }

    #[test]
    fn rename_with_link_rewrite_returns_empty_outcome_for_no_backlinks() {
        let (_cfg, _root, workspace) = fixture();
        workspace.write_text("old.md", "# Old\n").unwrap();
        workspace.reindex(None).unwrap();
        let outcome = workspace
            .rename_with_link_rewrite("old.md", "new.md")
            .unwrap();
        assert_eq!(outcome.renamed, vec![("old.md".into(), "new.md".into())]);
        assert!(outcome.rewritten.is_empty());
        assert!(outcome.conflicts.is_empty());
    }

    // ---- FB capabilities: copy + collision resolution -------------------

    #[test]
    fn copy_duplicates_a_file_and_leaves_the_source() {
        let (_cfg, _root, workspace) = fixture();
        workspace.write_text("notes/a.md", "hello").unwrap();
        let out = workspace.copy("notes/a.md", "notes/b.md").unwrap();
        assert_eq!(out.created, vec!["notes/b.md".to_string()]);
        // Source untouched, destination a faithful duplicate.
        assert_eq!(workspace.read_text("notes/a.md").unwrap(), "hello");
        assert_eq!(workspace.read_text("notes/b.md").unwrap(), "hello");
    }

    #[test]
    fn copy_duplicates_a_directory_subtree_skipping_control_dirs() {
        let (_cfg, root, workspace) = fixture();
        workspace.write_text("proj/a.md", "a").unwrap();
        workspace.write_text("proj/sub/b.md", "b").unwrap();
        // A .git control dir inside the source must NOT be duplicated.
        // Seed it directly on disk (write_text refuses control-dir
        // paths, which is exactly the gate we are NOT testing here).
        let git_dir = root.path().join("proj/.git");
        std::fs::create_dir_all(&git_dir).unwrap();
        std::fs::write(git_dir.join("HEAD"), "ref: x").unwrap();
        let out = workspace.copy("proj", "proj-copy").unwrap();
        assert_eq!(
            out.created,
            vec![
                "proj-copy/a.md".to_string(),
                "proj-copy/sub/b.md".to_string()
            ],
        );
        assert_eq!(workspace.read_text("proj-copy/a.md").unwrap(), "a");
        assert_eq!(workspace.read_text("proj-copy/sub/b.md").unwrap(), "b");
        // The control dir was skipped: its file does not exist in the copy.
        assert!(!workspace.exists("proj-copy/.git/HEAD"));
        // Source subtree is intact.
        assert_eq!(workspace.read_text("proj/a.md").unwrap(), "a");
    }

    #[test]
    fn copy_refuses_an_existing_destination() {
        let (_cfg, _root, workspace) = fixture();
        workspace.write_text("a.md", "x").unwrap();
        workspace.write_text("b.md", "y").unwrap();
        let err = workspace.copy("a.md", "b.md").unwrap_err();
        assert!(matches!(err, ChanError::Io(_)));
        // b.md was not clobbered.
        assert_eq!(workspace.read_text("b.md").unwrap(), "y");
    }

    #[test]
    fn resolve_free_name_suffixes_on_collision_before_extension() {
        let (_cfg, _root, workspace) = fixture();
        workspace.write_text("notes/a.md", "x").unwrap();
        // No collision: returns the bare path.
        assert_eq!(
            workspace.resolve_free_name("notes", "new.md").unwrap(),
            "notes/new.md"
        );
        // First collision -> " copy" before the extension.
        assert_eq!(
            workspace.resolve_free_name("notes", "a.md").unwrap(),
            "notes/a copy.md"
        );
        // Second collision -> " copy 2".
        workspace.write_text("notes/a copy.md", "x").unwrap();
        assert_eq!(
            workspace.resolve_free_name("notes", "a.md").unwrap(),
            "notes/a copy 2.md"
        );
    }

    #[test]
    fn resolve_free_name_at_workspace_root_has_no_prefix() {
        let (_cfg, _root, workspace) = fixture();
        assert_eq!(workspace.resolve_free_name("", "top.md").unwrap(), "top.md");
    }

    #[test]
    fn split_name_ext_handles_dotfiles_and_no_extension() {
        assert_eq!(split_name_ext("foo.md"), ("foo".into(), ".md".into()));
        assert_eq!(
            split_name_ext("archive.tar.gz"),
            ("archive.tar".into(), ".gz".into())
        );
        // Dotfile: the leading dot is a prefix, not an extension.
        assert_eq!(
            split_name_ext(".gitignore"),
            (".gitignore".into(), String::new())
        );
        // No dot: whole name is the stem.
        assert_eq!(split_name_ext("README"), ("README".into(), String::new()));
        // Trailing dot stays part of the stem.
        assert_eq!(split_name_ext("weird."), ("weird.".into(), String::new()));
    }
}
