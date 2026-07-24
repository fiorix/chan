// Library: top-level handle. Owns the registry persisted at
// ~/.chan/config.toml and resolves OS state/cache paths.
//
// In practice apps create one Library at startup and keep it
// alive. Workspaces are opened against it. Cheap to clone (Arc inside).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use serde::{Deserialize, Serialize};

use crate::error::{ChanError, Result};
use crate::fs_ops::WalkFilter;
use crate::lock::WorkspaceLock;
use crate::paths;
use crate::registry::{
    config_declares_index_excluded_dirs, current_default_index_excluded_dirs,
    index_excluded_dirs_is_stock_default, KnownWorkspace, Registry,
};
use crate::workspace::Workspace;

/// Selects how aggressive `Library::reset_workspace` is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ResetMode {
    /// Wipe per-workspace chan-managed state (search index, graph DB,
    /// session blobs, app tokens). Keep the registry entry, the
    /// user's notes tree, and the trash.
    State,
    /// `State` plus drop the registry entry. The next `open_workspace`
    /// against this path treats it as a fresh, never-seen workspace.
    Everything,
}

/// What `Library::reset_workspace` removed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResetReport {
    /// Total file + subdirectory entries removed across the wiped
    /// state directories. Useful as a "removed N items" toast.
    pub removed_entries: usize,
}

/// What `Library::sweep_orphans` reclaimed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SweepReport {
    /// Distinct metadata keys whose roots were reclaimed. Sorted.
    pub removed_metadata_keys: Vec<String>,
    /// Total file + subdirectory entries removed across wiped
    /// metadata roots.
    pub removed_entries: usize,
}

/// Per-machine handle to the chan-workspace registry + paths.
#[derive(Clone)]
pub struct Library {
    inner: Arc<LibraryInner>,
}

struct LibraryInner {
    config_path: PathBuf,
    /// In-memory registry. Persisted to `config_path` on every
    /// mutation. The Mutex serializes registry writes so
    /// `register_workspace` calls from concurrent threads don't race.
    registry: Mutex<Registry>,
    /// Directory-name blocklist for indexing walks. Loaded from
    /// the registry config so CLI and desktop share the same noise
    /// policy (`node_modules`, `target`, ...). The Mutex lets the
    /// consumer swap the filter at runtime after config changes.
    /// Workspaces capture a snapshot at `open_workspace` time.
    walk_filter: Mutex<Arc<WalkFilter>>,
    /// In-process map of currently-open Workspaces, keyed by canonical
    /// path. Each entry is a `Weak<Workspace>` so the map doesn't
    /// keep workspaces alive past the caller's last `Arc`. The
    /// per-workspace flock already prevents two processes (or two
    /// concurrent opens in this process) from racing on disk; the
    /// map adds two things on top:
    ///
    ///   1. A clearer in-process error: `WorkspaceAlreadyOpen` instead
    ///      of `WorkspaceLocked`. The latter implies cross-process
    ///      contention, which would mislead a developer who is
    ///      really fighting their own forgotten `Arc`.
    ///   2. Defense-in-depth on filesystems where flock is
    ///      unreliable (NFS-mounted metadata roots, certain SMB
    ///      configurations). Even if the kernel-side lock is a
    ///      no-op, the in-process map still serializes within a
    ///      single Library handle.
    ///
    /// Dead entries (Weak that no longer upgrades) are GC'd lazily
    /// on every map access; no background thread.
    live_workspaces: Mutex<HashMap<PathBuf, Weak<Workspace>>>,
}

impl Library {
    /// Open the default Library at `~/.chan/config.toml`. Creates
    /// the parent directory lazily on first save.
    pub fn open() -> Result<Self> {
        Self::open_at(paths::global_config_path())
    }

    /// Open a Library against an explicit config path. Used in
    /// tests and by callers that want a non-default location.
    pub fn open_at(config_path: PathBuf) -> Result<Self> {
        let mut registry = Registry::load_from(&config_path)?;
        // Stock-default upgrade: a config whose declared exclusions
        // match the pre-v0.76.0 default exactly gets migrated to the
        // current default (build-system output trees joined the set).
        // A customized list -- including an empty one, and including
        // one that already carries buck-out by hand -- is the user's
        // own and is never touched.
        let upgraded = index_excluded_dirs_is_stock_default(&registry.index_excluded_dirs);
        if upgraded {
            registry.index_excluded_dirs = current_default_index_excluded_dirs();
        }
        if upgraded || (config_path.exists() && !config_declares_index_excluded_dirs(&config_path))
        {
            if let Err(e) = registry.save_to(&config_path) {
                tracing::warn!(
                    error = %e,
                    path = %config_path.display(),
                    "open library: failed to persist default index_excluded_dirs"
                );
            }
        }
        let walk_filter = Arc::new(WalkFilter::new(registry.index_excluded_dirs.clone()));
        Ok(Self {
            inner: Arc::new(LibraryInner {
                config_path,
                registry: Mutex::new(registry),
                live_workspaces: Mutex::new(HashMap::new()),
                walk_filter: Mutex::new(walk_filter),
            }),
        })
    }

    /// Replace the directory-name blocklist applied to reindex
    /// walks for workspaces opened against this Library. This is mainly
    /// for tests and future config reloads; ordinary callers get
    /// the value loaded from `~/.chan/config.toml`.
    pub fn set_walk_filter(&self, filter: WalkFilter) {
        *self.inner.walk_filter.lock().unwrap() = Arc::new(filter);
    }

    /// Snapshot of the current filter. Cheap clone (Arc).
    pub fn walk_filter(&self) -> Arc<WalkFilter> {
        Arc::clone(&self.inner.walk_filter.lock().unwrap())
    }

    /// Path backing this library's registry config.
    pub fn config_path(&self) -> PathBuf {
        self.inner.config_path.clone()
    }

    /// Validated in-root drafts directory name from the registry
    /// (`drafts_dir` in `~/.chan/config.toml`). Global and hand-edited,
    /// NOT UI-configurable, so there is no setter. An invalid configured
    /// value (separator, traversal, clash with `.git`/`.chan` or an
    /// excluded dir) falls back to `DEFAULT_DRAFTS_DIR` with a warning,
    /// mirroring the graceful handling of `index_excluded_dirs`.
    /// `Workspace::open` re-validates the value it is handed, so this
    /// always returns a usable single-segment name.
    pub fn drafts_dir(&self) -> String {
        let configured = self.inner.registry.lock().unwrap().drafts_dir.clone();
        let excluded = &self.inner.walk_filter.lock().unwrap().excluded_dir_names;
        if crate::registry::validate_drafts_dir(&configured, excluded) {
            configured
        } else {
            tracing::warn!(
                configured = %configured,
                fallback = crate::registry::DEFAULT_DRAFTS_DIR,
                "invalid drafts_dir in config; falling back to default"
            );
            crate::registry::DEFAULT_DRAFTS_DIR.to_string()
        }
    }

    /// Snapshot of all registered workspaces, most-recent first.
    pub fn list_workspaces(&self) -> Vec<KnownWorkspace> {
        self.inner.registry.lock().unwrap().workspaces.clone()
    }

    /// Reload the registry config from disk.
    ///
    /// `Library` keeps the registry in memory for cheap list/open calls. Long-lived
    /// embedders such as chan-desktop call this from their `config.toml` watcher
    /// after another process (`chan devserver`, `chan workspace add`, etc.) mutates
    /// the shared registry.
    pub fn reload_registry(&self) -> Result<()> {
        // Serialize reload with same-handle writers. The notify event that
        // triggers a reload can lag behind a local register/remove; reading
        // before this mutex risks applying an older on-disk snapshot after the
        // writer has already saved and updated memory.
        let mut registry_guard = self.inner.registry.lock().unwrap();
        let registry = Registry::load_from(&self.inner.config_path)?;
        let walk_filter = Arc::new(WalkFilter::new(registry.index_excluded_dirs.clone()));
        *registry_guard = registry;
        *self.inner.walk_filter.lock().unwrap() = walk_filter;
        Ok(())
    }

    /// Add a workspace to the registry. Idempotent: re-registering an
    /// existing workspace only updates `last_seen_at`, preserving its
    /// metadata key. The directory itself is NOT created here; pass
    /// a path that already exists.
    pub fn register_workspace(&self, root: &Path) -> Result<KnownWorkspace> {
        self.register_workspace_with_name(root, None)
    }

    /// Like [`register_workspace`](Self::register_workspace) but also sets the
    /// workspace's display name. `Some(name)` stores a trimmed name (empty or
    /// whitespace-only clears it); `None` leaves any existing name intact, so
    /// re-registering a workspace without a name never wipes one set earlier.
    pub fn register_workspace_with_name(
        &self,
        root: &Path,
        display_name: Option<String>,
    ) -> Result<KnownWorkspace> {
        if !root.exists() {
            return Err(ChanError::WorkspaceRootMissing(root.to_path_buf()));
        }
        let mut reg = self.inner.registry.lock().unwrap();
        let idx = reg.touch(root);
        if let Some(name) = display_name {
            let name = name.trim();
            reg.workspaces[idx].display_name = (!name.is_empty()).then(|| name.to_string());
        }
        let entry = reg.workspaces[idx].clone();
        paths::ensure_workspace_metadata_dirs(&entry.metadata_key)?;
        reg.save_to(&self.inner.config_path)?;
        Ok(entry)
    }

    /// Drop a workspace from the registry AND wipe its per-workspace
    /// chan-managed state (search index, graph DB, session blobs,
    /// app tokens). Equivalent to
    /// `reset_workspace(root, ResetMode::Everything)` plus a `false`
    /// return when the workspace wasn't registered.
    ///
    /// The user's notes tree is never touched; chan-workspace never
    /// writes inside it. The trash is preserved (it holds
    /// recoverable user data, semantically owned by the user even
    /// after the workspace is forgotten).
    ///
    /// Why state is wiped here: the metadata key is deterministic
    /// for a canonical path. Without this wipe, deleting the workspace
    /// directory and re-creating it at the same path would reuse the
    /// old metadata root.
    ///
    /// Preconditions: same as `reset_workspace`. The caller must drop
    /// any open `Arc<Workspace>` for `root` first; otherwise this
    /// returns `ChanError::WorkspaceAlreadyOpen`.
    ///
    /// Returns `Ok(false)` when no registry row matched `root` and
    /// no wipe was attempted.
    pub fn unregister_workspace(&self, root: &Path) -> Result<bool> {
        // Peek before delegating so we can preserve the previous
        // bool semantic. reset_workspace itself is idempotent on a
        // never-opened workspace (returns removed_entries = 0), but we
        // don't want to wipe state for a path the user never
        // registered with this Library, just in case it collides
        // with an unrelated cached entry from an earlier install.
        let registered = self.inner.registry.lock().unwrap().find(root).is_some();
        if !registered {
            return Ok(false);
        }
        self.reset_workspace(root, ResetMode::Everything)?;
        Ok(true)
    }

    /// Open a workspace handle. The workspace must already be registered;
    /// callers do `register_workspace` first if needed (CLI does both
    /// in one shot for the "point at a directory and go" path).
    pub fn open_workspace(&self, root: &Path) -> Result<Arc<Workspace>> {
        let reg = self.inner.registry.lock().unwrap();
        let entry = reg
            .find(root)
            .ok_or_else(|| ChanError::WorkspaceNotRegistered(root.to_path_buf()))?
            .clone();
        drop(reg);
        let key = canonical_key(&entry.root_path);
        // In-process pre-check: if we still hold an open handle to this
        // workspace, return WorkspaceAlreadyOpen up front instead of reaching
        // the flock. (A contended flock held by our own pid now also reports
        // WorkspaceAlreadyOpen, so the two agree; the pre-check additionally
        // short-circuits the potentially-slow Workspace::open below.) The lock
        // on `live_workspaces` is held only across the upgrade probe; we drop
        // it before calling Workspace::open so a slow open (canonicalize on a
        // cloud root, lazy index init) never blocks unrelated workspaces from
        // registering / listing.
        {
            let mut map = self.inner.live_workspaces.lock().unwrap();
            gc_dead_entries(&mut map);
            if let Some(weak) = map.get(&key) {
                if weak.upgrade().is_some() {
                    return Err(ChanError::WorkspaceAlreadyOpen);
                }
            }
        }
        let filter = Arc::clone(&self.inner.walk_filter.lock().unwrap());
        let drafts_dir = self.drafts_dir();
        let workspace = Workspace::open(entry, filter, drafts_dir)?;
        self.inner
            .live_workspaces
            .lock()
            .unwrap()
            .insert(key, Arc::downgrade(&workspace));
        Ok(workspace)
    }

    /// Wipe per-workspace chan-managed state for `root`. The user's
    /// notes tree is never touched (chan-workspace never writes inside
    /// it). The trash is preserved (it holds user-deleted files,
    /// recoverable user data). The lock dir is preserved (it holds
    /// no data, only cross-process coordination).
    ///
    /// Wipe set:
    ///   - search index (`~/.chan/workspaces/<metadata_key>/index/`)
    ///   - graph DB and sqlite sidecars (`.../graph/`)
    ///   - session blobs (`.../sessions/`)
    ///   - app tokens (`.../tokens/`)
    ///   - report artifacts (`.../report/`)
    ///
    /// `ResetMode::Everything` additionally drops the registry
    /// entry so the next `open_workspace` treats this path as fresh.
    ///
    /// Preconditions:
    ///   - The caller MUST drop any open `Arc<Workspace>` for `root`
    ///     before calling. We acquire the writer lock briefly to
    ///     verify exclusive access; a FOREIGN process holding it fails
    ///     with `ChanError::WorkspaceLocked`, while this process's own
    ///     lock (a handle we didn't drop) fails with
    ///     `ChanError::WorkspaceAlreadyOpen`.
    ///   - On Unix this is mostly defense-in-depth (open files
    ///     survive unlink). On Windows the lock check is load-
    ///     bearing because removing files-in-use fails.
    ///
    /// Idempotent: calling on a never-opened workspace (no state dirs
    /// on disk) returns `removed_entries = 0` without erroring.
    /// Re-creation of the skeleton happens lazily on the next
    /// `open_workspace` + first `index()` / `graph()` access.
    pub fn reset_workspace(&self, root: &Path, mode: ResetMode) -> Result<ResetReport> {
        self.reset_workspace_with(root, mode, &crate::progress::NoProgress)
    }

    /// `reset_workspace` plus a `ProgressCallback`. Fires one
    /// `ProgressStage::Reset` event per subsystem (index, graph,
    /// sessions, tokens, report) as it is wiped, so a UI can
    /// surface "wiping `<subsystem>`..." without instrumenting each
    /// caller. The label carries the subsystem name; `current` /
    /// `total` count through the fixed subsystem list.
    pub fn reset_workspace_with(
        &self,
        root: &Path,
        mode: ResetMode,
        progress: &dyn crate::progress::ProgressCallback,
    ) -> Result<ResetReport> {
        use crate::progress::{ProgressEvent, ProgressStage};
        // In-process pre-check: a buggy caller might hold a Workspace
        // and call reset_workspace from another thread, expecting the
        // flock to serialize. It does -- and `WorkspaceLock::acquire`
        // below now also reports `WorkspaceAlreadyOpen` for a lock held
        // by our own pid, so the two agree -- but the pre-check
        // short-circuits before touching the flock and names the clash
        // precisely. Cross-process safety (a foreign holder ⇒
        // `WorkspaceLocked`) still rides on the flock.
        let key = canonical_key(root);
        {
            let mut map = self.inner.live_workspaces.lock().unwrap();
            gc_dead_entries(&mut map);
            if let Some(weak) = map.get(&key) {
                if weak.upgrade().is_some() {
                    return Err(ChanError::WorkspaceAlreadyOpen);
                }
            }
        }
        // Metadata identity comes from the registry's metadata key,
        // not the current filesystem path. An unregistered root has
        // no key in the registry, so there is nothing for this
        // Library to wipe.
        let Some(metadata_key) = self
            .inner
            .registry
            .lock()
            .unwrap()
            .find(root)
            .map(|e| e.metadata_key.clone())
        else {
            return Ok(ResetReport { removed_entries: 0 });
        };
        let workspace_paths = paths::workspace_paths_for_metadata_key(&metadata_key);
        let _lock = WorkspaceLock::acquire(&workspace_paths.lock, root)?;
        let mut removed = 0;
        let report_dir = workspace_paths
            .report
            .parent()
            .expect("report path has parent");
        let subsystems: [(&str, &Path); 5] = [
            ("index", &workspace_paths.index),
            ("graph", &workspace_paths.graph_dir),
            ("sessions", &workspace_paths.sessions),
            ("tokens", &workspace_paths.tokens),
            ("report", report_dir),
        ];
        let total = subsystems.len() as u64;
        for (idx, (name, dir)) in subsystems.iter().enumerate() {
            progress.on_progress(ProgressEvent {
                stage: ProgressStage::Reset,
                current: idx as u64,
                total,
                label: Some((*name).to_string()),
                eta_secs: None,
            });
            removed += wipe_dir(dir)?;
        }
        // Hold the writer lock across the registry update so a
        // concurrent open_workspace cannot lazily recreate the state we
        // just wiped, lazily commit a half-formed index/graph dir,
        // and then notice its registry entry has been dropped. The
        // registry mutex composes cleanly here: it's a lock we own,
        // the flock is process-wide, and no path acquires them in
        // the opposite order. _lock is dropped at the end of the
        // function after the registry write completes.
        if matches!(mode, ResetMode::Everything) {
            let mut reg = self.inner.registry.lock().unwrap();
            if reg.remove(root) {
                reg.save_to(&self.inner.config_path)?;
            }
        }
        Ok(ResetReport {
            removed_entries: removed,
        })
    }

    /// Record an `mv` of a registered workspace's directory. Preserves
    /// the workspace's `metadata_key` and therefore all metadata state,
    /// only rewriting the `root_path` field on the registry row.
    ///
    /// Refuses if:
    ///   - `old` is not registered (`Ok(false)`),
    ///   - `new` does not exist on disk (`WorkspaceRootMissing`),
    ///   - `new` is already registered to a different metadata key
    ///     (`WorkspaceAlreadyRegistered`), since collapsing two
    ///     registry rows onto one path would orphan one workspace's
    ///     metadata under a key the registry no longer references.
    ///   - any `Arc<Workspace>` for `old` is still alive
    ///     (`WorkspaceAlreadyOpen`), since the live workspace is caching
    ///     `entry.root_path` and would silently disagree with the
    ///     registry after the move.
    ///
    /// The caller is responsible for actually moving the directory
    /// on disk (`std::fs::rename(old, new)` or an `mv` from the
    /// shell). This call only updates the registry.
    pub fn move_workspace(&self, old: &Path, new: &Path) -> Result<bool> {
        if !new.exists() {
            return Err(ChanError::WorkspaceRootMissing(new.to_path_buf()));
        }
        let key = canonical_key(old);
        {
            let mut map = self.inner.live_workspaces.lock().unwrap();
            gc_dead_entries(&mut map);
            if let Some(weak) = map.get(&key) {
                if weak.upgrade().is_some() {
                    return Err(ChanError::WorkspaceAlreadyOpen);
                }
            }
        }
        let mut reg = self.inner.registry.lock().unwrap();
        let Some(old_entry) = reg.find(old) else {
            return Ok(false);
        };
        let old_metadata_key = old_entry.metadata_key.clone();
        if let Some(existing) = reg.find(new) {
            if existing.metadata_key != old_metadata_key {
                return Err(ChanError::WorkspaceAlreadyRegistered(new.to_path_buf()));
            }
            // Same metadata key means `new` is already an alias for
            // this workspace, e.g. an idempotent retry after a partial
            // move. Drop through to set_path.
        }
        let ok = reg.set_path(old, new);
        if ok {
            reg.save_to(&self.inner.config_path)?;
        }
        Ok(ok)
    }

    /// Per-workspace paths for a registered root. `None` when the
    /// workspace isn't registered, so no metadata identity can resolve.
    /// Use this rather than `paths::workspace_paths_for_metadata_key`
    /// directly so the registry stays the only source of truth for
    /// "which metadata key is this path."
    pub fn workspace_paths_for(&self, root: &Path) -> Option<paths::WorkspacePaths> {
        let reg = self.inner.registry.lock().unwrap();
        let entry = reg.find(root)?;
        Some(paths::workspace_paths_for_metadata_key(&entry.metadata_key))
    }

    /// Reclaim metadata directories whose key no longer appears in
    /// the registry. Walks the metadata parent from
    /// `paths::workspace_subsystem_dirs` and deletes any immediate
    /// subdirectory whose name isn't a current metadata key.
    ///
    /// Use cases:
    ///   - A previous chan version `unregister`'d a workspace without
    ///     wiping the metadata root.
    ///   - A registry was hand-edited and the matching metadata
    ///     roots stayed behind.
    ///
    /// Cross-process safety: this routine snapshots the registry
    /// under the in-process mutex and walks each subsystem dir
    /// independently. A concurrent `register_workspace` on another
    /// process can race: it creates a metadata root and saves the
    /// registry; our sweep, working from the snapshot, then deletes
    /// the just-created root. The worst case is "the next index
    /// access on the new workspace rebuilds from scratch". We accept the
    /// race rather than introduce a cross-process registry lock for
    /// what is fundamentally a garbage-collection pass.
    pub fn sweep_orphans(&self) -> Result<SweepReport> {
        let known: std::collections::HashSet<String> = self
            .inner
            .registry
            .lock()
            .unwrap()
            .workspaces
            .iter()
            .map(|d| d.metadata_key.clone())
            .collect();
        sweep_orphans_in(&paths::workspace_subsystem_dirs(), &known)
    }
}

/// Inner workhorse for `Library::sweep_orphans`: walk each metadata
/// parent in `parents` and remove any immediate subdirectory whose
/// name is not in `known`. Pure in its arguments so tests can workspace
/// it against a TempDir tree without mutating the host's real
/// metadata root.
///
/// Tolerates concurrent removal: a metadata root deleted between
/// `read_dir` and `wipe_dir` simply contributes zero entries to
/// the report.
fn sweep_orphans_in(
    parents: &[PathBuf],
    known: &std::collections::HashSet<String>,
) -> Result<SweepReport> {
    let mut removed_metadata_keys: Vec<String> = Vec::new();
    let mut removed_entries: usize = 0;
    for parent in parents {
        let read = match std::fs::read_dir(parent) {
            Ok(r) => r,
            // Not yet created on a fresh install; nothing to sweep.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(ChanError::Io(format!("read {parent:?}: {e}"))),
        };
        for entry in read.flatten() {
            let name = entry.file_name();
            let Some(name_str) = name.to_str() else {
                continue;
            };
            if known.contains(name_str) {
                continue;
            }
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let entry_count = wipe_dir(&path)?;
            removed_entries += entry_count;
            removed_metadata_keys.push(name_str.to_string());
        }
    }
    removed_metadata_keys.sort();
    removed_metadata_keys.dedup();
    Ok(SweepReport {
        removed_metadata_keys,
        removed_entries,
    })
}

/// Canonical-form key for the live-workspaces map. Falls back to the
/// input path when the filesystem can't canonicalize (workspace root
/// missing or asleep), so the map still tracks "this exact request
/// path" through the rest of the operation.
fn canonical_key(root: &Path) -> PathBuf {
    paths::canonicalize_normalized(root)
}

/// Drop dead entries from the live-workspaces map. A `Weak<Workspace>`
/// whose Arc has been dropped will fail to upgrade; we remove it
/// so the map's footprint stays bounded by the actually-open
/// workspaces, not by every workspace ever opened in the process.
fn gc_dead_entries(map: &mut HashMap<PathBuf, Weak<Workspace>>) {
    map.retain(|_, w| w.strong_count() > 0);
}

/// Recursively delete `dir` and return the number of entries
/// (files + subdirectories, not counting `dir` itself) that were
/// inside it. Missing dir contributes 0. Tolerates a race where
/// the directory disappears between the walk and the remove (a
/// second sweep, a concurrent workspace teardown, an external tool)
/// by treating NotFound on remove as zero-impact rather than an
/// error.
fn wipe_dir(dir: &Path) -> Result<usize> {
    if !dir.exists() {
        return Ok(0);
    }
    let count = walkdir::WalkDir::new(dir)
        .min_depth(1)
        .into_iter()
        .filter_map(|e| e.ok())
        .count();
    // A workspace teardown (forget / unregister) can run while a background
    // indexer reindex is still finishing. That reindex writes to the index dir
    // on a `spawn_blocking` task the teardown cancels but cannot abort
    // mid-write, so it can land a last file between the walk above and the
    // remove below, losing the race to ENOTEMPTY. The cancelled reindex stops
    // within a few ms once it next checks its cancel flag, so retry the remove
    // on a non-empty dir with a short bounded backoff before surfacing it.
    let mut attempt = 0u32;
    loop {
        match std::fs::remove_dir_all(dir) {
            Ok(()) => return Ok(count),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(e) if e.kind() == std::io::ErrorKind::DirectoryNotEmpty && attempt < 20 => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(e) => return Err(e.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn lib() -> (Library, TempDir, TempDir) {
        let cfg = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        (lib, cfg, workspace)
    }

    #[test]
    fn register_then_list() {
        let (lib, _cfg, workspace) = lib();
        lib.register_workspace(workspace.path()).unwrap();
        let workspaces = lib.list_workspaces();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(
            workspaces[0].root_path,
            workspace.path().canonicalize().unwrap()
        );
        assert_eq!(
            workspaces[0].metadata_key,
            paths::metadata_key_for_root(workspace.path())
        );
        assert!(lib
            .workspace_paths_for(workspace.path())
            .unwrap()
            .root
            .is_dir());
    }

    #[test]
    fn reload_registry_picks_up_external_workspace_add() {
        let cfg = TempDir::new().unwrap();
        let config_path = cfg.path().join("config.toml");
        let workspace = TempDir::new().unwrap();
        let lib = Library::open_at(config_path.clone()).unwrap();
        let other = Library::open_at(config_path).unwrap();

        other.register_workspace(workspace.path()).unwrap();
        assert!(lib.list_workspaces().is_empty());

        lib.reload_registry().unwrap();
        let workspaces = lib.list_workspaces();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(
            workspaces[0].root_path,
            workspace.path().canonicalize().unwrap()
        );
    }

    #[test]
    fn reload_registry_refreshes_config_derived_fields() {
        let cfg = TempDir::new().unwrap();
        let config_path = cfg.path().join("config.toml");
        std::fs::write(
            &config_path,
            "index_excluded_dirs = [\"node_modules\"]\ndrafts_dir = \"Drafts\"\nworkspaces = []\n",
        )
        .unwrap();
        let lib = Library::open_at(config_path.clone()).unwrap();
        assert!(lib.walk_filter().is_excluded("node_modules"));
        assert!(!lib.walk_filter().is_excluded("dist"));
        assert_eq!(lib.drafts_dir(), "Drafts");

        std::fs::write(
            &config_path,
            "index_excluded_dirs = [\"dist\"]\ndrafts_dir = \"Scratch\"\nworkspaces = []\n",
        )
        .unwrap();
        lib.reload_registry().unwrap();

        assert!(!lib.walk_filter().is_excluded("node_modules"));
        assert!(lib.walk_filter().is_excluded("dist"));
        assert_eq!(lib.drafts_dir(), "Scratch");
    }

    #[test]
    fn open_at_upgrades_a_stock_default_exclusion_list() {
        let cfg = TempDir::new().unwrap();
        let config_path = cfg.path().join("config.toml");
        // The exact pre-v0.76.0 default set, as materialized into an
        // existing config.toml by an older chan.
        std::fs::write(
            &config_path,
            "index_excluded_dirs = [\".git\", \".hg\", \".svn\", \"node_modules\", \"target\", \"__pycache__\", \".venv\", \"venv\", \".tox\", \".pytest_cache\", \".mypy_cache\", \".ruff_cache\", \".cache\", \"dist\", \"build\"]\nworkspaces = []\n",
        )
        .unwrap();
        let lib = Library::open_at(config_path.clone()).unwrap();
        // The build-system output trees joined the default set...
        for name in ["buck-out", ".buckos", "distfiles", "prebuilt", "vendor"] {
            assert!(
                lib.walk_filter().is_excluded(name),
                "stock default must pick up {name}"
            );
        }
        // ...and the upgrade is persisted back to the file.
        let raw = std::fs::read_to_string(&config_path).unwrap();
        assert!(raw.contains("buck-out"), "upgrade persisted: {raw}");
    }

    #[test]
    fn open_at_leaves_a_customized_exclusion_list_alone() {
        let cfg = TempDir::new().unwrap();
        let config_path = cfg.path().join("config.toml");
        // One hand edit (buck-out added per the incident-relief note):
        // no longer the stock default, so no migration.
        std::fs::write(
            &config_path,
            "index_excluded_dirs = [\".git\", \".hg\", \".svn\", \"node_modules\", \"target\", \"__pycache__\", \".venv\", \"venv\", \".tox\", \".pytest_cache\", \".mypy_cache\", \".ruff_cache\", \".cache\", \"dist\", \"build\", \"buck-out\"]\nworkspaces = []\n",
        )
        .unwrap();
        let lib = Library::open_at(config_path).unwrap();
        assert!(lib.walk_filter().is_excluded("buck-out"));
        assert!(
            !lib.walk_filter().is_excluded("distfiles"),
            "a customized list is the user's own; no silent union"
        );
    }

    #[test]
    fn open_at_leaves_an_empty_exclusion_list_alone() {
        let cfg = TempDir::new().unwrap();
        let config_path = cfg.path().join("config.toml");
        std::fs::write(&config_path, "index_excluded_dirs = []\nworkspaces = []\n").unwrap();
        let lib = Library::open_at(config_path).unwrap();
        assert!(
            !lib.walk_filter().is_excluded("target"),
            "explicit empty is a user choice, not a stock default"
        );
    }

    #[test]
    fn register_missing_path_errors() {
        let (lib, _cfg, _workspace) = lib();
        let bogus = std::path::PathBuf::from("/nonexistent/path/to/nowhere/12345");
        let err = lib.register_workspace(&bogus).unwrap_err();
        assert!(matches!(err, ChanError::WorkspaceRootMissing(_)));
    }

    #[test]
    fn unregister_returns_false_when_absent() {
        let (lib, _cfg, workspace) = lib();
        assert!(!lib.unregister_workspace(workspace.path()).unwrap());
    }

    #[test]
    fn open_uses_default_index_excluded_dirs() {
        let (lib, _cfg, _workspace) = lib();
        let filter = lib.walk_filter();
        assert!(filter.is_excluded("node_modules"));
        assert!(filter.is_excluded("NODE_MODULES"));
        assert!(filter.is_excluded("target"));
        assert!(!filter.is_excluded("notes"));
    }

    #[test]
    fn drafts_dir_defaults_to_dot_drafts() {
        let (lib, _cfg, _workspace) = lib();
        assert_eq!(lib.drafts_dir(), ".Drafts");
    }

    #[test]
    fn drafts_dir_reads_valid_config_value() {
        let cfg = TempDir::new().unwrap();
        let config_path = cfg.path().join("config.toml");
        std::fs::write(&config_path, "drafts_dir = \"Scratch\"\nworkspaces = []\n").unwrap();
        let lib = Library::open_at(config_path).unwrap();
        assert_eq!(lib.drafts_dir(), "Scratch");
    }

    #[test]
    fn drafts_dir_falls_back_when_config_value_invalid() {
        // A drafts_dir that clashes with an excluded dir is rejected
        // and falls back to the default rather than landing drafts in
        // an unindexed subtree.
        let cfg = TempDir::new().unwrap();
        let config_path = cfg.path().join("config.toml");
        std::fs::write(
            &config_path,
            "drafts_dir = \"node_modules\"\nworkspaces = []\n",
        )
        .unwrap();
        let lib = Library::open_at(config_path).unwrap();
        assert_eq!(lib.drafts_dir(), crate::registry::DEFAULT_DRAFTS_DIR);
    }

    #[test]
    fn open_workspace_uses_configured_drafts_dir_name() {
        let cfg = TempDir::new().unwrap();
        let config_path = cfg.path().join("config.toml");
        std::fs::write(&config_path, "drafts_dir = \"Scratch\"\nworkspaces = []\n").unwrap();
        let lib = Library::open_at(config_path).unwrap();
        let workspace = TempDir::new().unwrap();
        lib.register_workspace(workspace.path()).unwrap();
        let ws = lib.open_workspace(workspace.path()).unwrap();
        assert_eq!(ws.drafts_dir_name(), "Scratch");
        assert_eq!(ws.drafts_dir(), ws.root().join("Scratch"));
    }

    #[test]
    fn open_preserves_user_empty_index_excluded_dirs() {
        let cfg = TempDir::new().unwrap();
        let config_path = cfg.path().join("config.toml");
        std::fs::write(&config_path, "index_excluded_dirs = []\nworkspaces = []\n").unwrap();

        let lib = Library::open_at(config_path).unwrap();
        let filter = lib.walk_filter();
        assert!(!filter.is_excluded("node_modules"));
    }

    #[test]
    fn open_persists_default_index_excluded_dirs_into_existing_config() {
        let cfg = TempDir::new().unwrap();
        let config_path = cfg.path().join("config.toml");
        std::fs::write(&config_path, "workspaces = []\n").unwrap();

        let lib = Library::open_at(config_path.clone()).unwrap();
        assert!(lib.walk_filter().is_excluded("node_modules"));
        let raw = std::fs::read_to_string(config_path).unwrap();
        assert!(raw.contains("index_excluded_dirs"));
        assert!(raw.contains("node_modules"));
    }

    #[test]
    fn walk_filter_excludes_dir_from_reindex() {
        // Library-set filter must reach the indexer: a `node_modules`
        // directory under the workspace should not show up in the search
        // index even when it contains markdown. The editor's file
        // tree still sees it (list_tree is unfiltered) so the user
        // can open files there on demand.
        use crate::SearchMode;
        let (lib, _cfg, workspace) = lib();
        lib.set_walk_filter(WalkFilter::new(["node_modules"]));
        lib.register_workspace(workspace.path()).unwrap();
        std::fs::create_dir_all(workspace.path().join("notes")).unwrap();
        std::fs::write(
            workspace.path().join("notes/a.md"),
            "# alpha\nfoo unique-keep-token bar\n",
        )
        .unwrap();
        std::fs::create_dir_all(workspace.path().join("node_modules/pkg")).unwrap();
        std::fs::write(
            workspace.path().join("node_modules/pkg/README.md"),
            "# junk\nbaz unique-skip-token qux\n",
        )
        .unwrap();
        let d = lib.open_workspace(workspace.path()).unwrap();
        d.reindex(None).unwrap();
        let opts = crate::workspace::SearchOpts {
            mode: SearchMode::Bm25,
            limit: 10,
            scope: None,
        };
        let kept = d.search("unique-keep-token", &opts).unwrap();
        assert_eq!(kept.hits.len(), 1, "kept file should be indexed");
        let skipped = d.search("unique-skip-token", &opts).unwrap();
        assert!(
            skipped.hits.is_empty(),
            "skipped file should not be indexed; got {:?}",
            skipped.hits
        );
        // list_tree must still surface the noise dir so the editor's
        // tree view doesn't lie about what's on disk.
        let entries = d.list_tree().unwrap();
        assert!(entries.iter().any(|e| e.path.starts_with("node_modules")));
    }

    #[test]
    fn open_unregistered_errors() {
        let (lib, _cfg, workspace) = lib();
        let err = lib.open_workspace(workspace.path()).unwrap_err();
        assert!(matches!(err, ChanError::WorkspaceNotRegistered(_)));
    }

    /// Populate per-workspace state so we have something to wipe:
    /// reindex (creates index segments + graph DB), put a session
    /// blob, drop a fake token. Also writes a markdown file inside
    /// the workspace so the test can verify reset doesn't touch the
    /// user's notes.
    fn populate_state(lib: &Library, root: &Path) {
        let workspace = lib.open_workspace(root).unwrap();
        workspace
            .write_text("notes/keep.md", "kept across reset")
            .unwrap();
        workspace.reindex(None).unwrap();
        workspace.put_session("win-1", b"layout").unwrap();
        let p = workspace.paths();
        std::fs::create_dir_all(&p.tokens).unwrap();
        std::fs::write(p.tokens.join("server.token"), b"deadbeef").unwrap();
    }

    fn paths_of(lib: &Library, root: &Path) -> paths::WorkspacePaths {
        lib.workspace_paths_for(root)
            .expect("test helper expects a registered workspace")
    }

    #[test]
    fn workspace_paths_for_returns_none_for_unregistered_root() {
        let (lib, _cfg, workspace) = lib();
        assert!(lib.workspace_paths_for(workspace.path()).is_none());
        lib.register_workspace(workspace.path()).unwrap();
        assert!(lib.workspace_paths_for(workspace.path()).is_some());
    }

    #[test]
    fn move_workspace_preserves_metadata_key_and_metadata_dirs() {
        let (lib, _cfg, workspace_a) = lib();
        let workspace_b = TempDir::new().unwrap();
        lib.register_workspace(workspace_a.path()).unwrap();
        populate_state(&lib, workspace_a.path());

        let key_before = lib.list_workspaces()[0].metadata_key.clone();
        let pa = paths_of(&lib, workspace_a.path());
        assert!(pa.graph_db.exists());

        // Move the workspace's registry entry. The user is responsible
        // for the actual directory move; we simulate that by writing
        // notes into workspace_b after the registry update.
        assert!(lib
            .move_workspace(workspace_a.path(), workspace_b.path())
            .unwrap());

        // Registry now points at workspace_b with the same metadata key.
        // The metadata root on disk is untouched.
        let after = lib.list_workspaces();
        assert_eq!(after.len(), 1);
        assert_eq!(
            after[0].metadata_key, key_before,
            "metadata key must survive a move"
        );
        assert_eq!(
            after[0].root_path,
            workspace_b.path().canonicalize().unwrap()
        );

        let pb = paths_of(&lib, workspace_b.path());
        assert_eq!(
            pb.graph_db, pa.graph_db,
            "metadata paths follow the metadata key"
        );
        assert!(pb.graph_db.exists(), "graph DB still present after move");
    }

    #[test]
    fn move_workspace_refuses_when_target_missing() {
        let (lib, _cfg, workspace_a) = lib();
        lib.register_workspace(workspace_a.path()).unwrap();
        let missing = std::path::PathBuf::from("/nonexistent/destination/12345");
        let err = lib
            .move_workspace(workspace_a.path(), &missing)
            .unwrap_err();
        assert!(matches!(err, ChanError::WorkspaceRootMissing(_)));
    }

    #[test]
    fn move_workspace_refuses_when_target_is_another_registered_workspace() {
        let (lib, _cfg, workspace_a) = lib();
        let workspace_b = TempDir::new().unwrap();
        lib.register_workspace(workspace_a.path()).unwrap();
        lib.register_workspace(workspace_b.path()).unwrap();
        let err = lib
            .move_workspace(workspace_a.path(), workspace_b.path())
            .unwrap_err();
        assert!(matches!(err, ChanError::WorkspaceAlreadyRegistered(_)));
        // Both registry rows survive untouched.
        assert_eq!(lib.list_workspaces().len(), 2);
    }

    #[test]
    fn move_workspace_refuses_when_source_is_open() {
        let (lib, _cfg, workspace_a) = lib();
        let workspace_b = TempDir::new().unwrap();
        lib.register_workspace(workspace_a.path()).unwrap();
        let _open = lib.open_workspace(workspace_a.path()).unwrap();
        let err = lib
            .move_workspace(workspace_a.path(), workspace_b.path())
            .unwrap_err();
        assert!(matches!(err, ChanError::WorkspaceAlreadyOpen));
    }

    #[test]
    fn move_workspace_returns_false_when_source_unregistered() {
        let (lib, _cfg, _workspace_a) = lib();
        let workspace_b = TempDir::new().unwrap();
        let missing = TempDir::new().unwrap();
        // Source is never registered; destination exists but is irrelevant.
        assert!(!lib
            .move_workspace(missing.path(), workspace_b.path())
            .unwrap());
    }

    /// Workspaces `sweep_orphans_in` against an isolated TempDir tree
    /// so the test never touches the host's real XDG_STATE_HOME /
    /// XDG_CACHE_HOME. The public `Library::sweep_orphans` is a
    /// thin wrapper that supplies `paths::workspace_subsystem_dirs()`
    /// and the registry's metadata-key set; the structural behavior
    /// we care about lives in the inner fn.
    #[test]
    fn sweep_orphans_in_reclaims_unknown_metadata_keys() {
        use std::collections::HashSet;
        let root = TempDir::new().unwrap();
        let parents = vec![root.path().join("workspaces")];
        let known_key = "-tmp-known-feedface";
        let orphan_key = "-tmp-orphan-01234567";
        let mut known = HashSet::new();
        known.insert(known_key.to_string());

        for parent in &parents {
            std::fs::create_dir_all(parent.join(known_key)).unwrap();
            std::fs::write(parent.join(known_key).join("keep"), b"keep").unwrap();
            std::fs::create_dir_all(parent.join(orphan_key)).unwrap();
            std::fs::write(parent.join(orphan_key).join("junk"), b"junk").unwrap();
        }
        let file = parents[0].join("not-a-dir");
        std::fs::write(&file, b"keep").unwrap();

        let report = sweep_orphans_in(&parents, &known).unwrap();
        assert_eq!(report.removed_metadata_keys, vec![orphan_key.to_string()]);
        assert!(report.removed_entries >= 1);

        for parent in &parents {
            assert!(
                parent.join(known_key).exists(),
                "known metadata root must survive"
            );
            assert!(
                !parent.join(orphan_key).exists(),
                "orphan metadata root must be gone"
            );
        }
        assert!(file.exists(), "non-directory entry must survive");
    }

    #[test]
    fn sweep_orphans_in_handles_missing_parent_dirs() {
        // Parents that don't exist (fresh install, no workspaces ever
        // opened) must not error: the sweep simply skips them.
        use std::collections::HashSet;
        let root = TempDir::new().unwrap();
        let parents = vec![
            root.path().join("never-created"),
            root.path().join("also-not-here"),
        ];
        let known = HashSet::new();
        let report = sweep_orphans_in(&parents, &known).unwrap();
        assert!(report.removed_metadata_keys.is_empty());
        assert_eq!(report.removed_entries, 0);
    }

    #[test]
    fn reset_state_wipes_chan_state_and_keeps_user_notes_and_registry() {
        let (lib, _cfg, workspace) = lib();
        lib.register_workspace(workspace.path()).unwrap();
        populate_state(&lib, workspace.path());

        let p = paths_of(&lib, workspace.path());
        // Sanity: state dirs populated.
        assert!(p.index.exists());
        assert!(p.graph_db.exists());
        assert!(p.sessions.exists());
        assert!(p.tokens.exists());

        let report = lib
            .reset_workspace(workspace.path(), ResetMode::State)
            .unwrap();
        assert!(report.removed_entries > 0);

        // State dirs gone.
        assert!(!p.index.exists());
        assert!(!p.graph_db.parent().unwrap().exists());
        assert!(!p.sessions.exists());
        assert!(!p.tokens.exists());

        // User's notes and the registry survive.
        assert!(workspace.path().join("notes/keep.md").exists());
        let workspaces = lib.list_workspaces();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(
            workspaces[0].root_path,
            workspace.path().canonicalize().unwrap()
        );
    }

    #[test]
    fn reset_everything_also_drops_registry_entry() {
        let (lib, _cfg, workspace) = lib();
        lib.register_workspace(workspace.path()).unwrap();
        populate_state(&lib, workspace.path());

        lib.reset_workspace(workspace.path(), ResetMode::Everything)
            .unwrap();

        assert!(lib.list_workspaces().is_empty());
        // User's notes still survive (chan-workspace never owns them).
        assert!(workspace.path().join("notes/keep.md").exists());
    }

    #[test]
    fn reset_workspace_rejects_when_workspace_is_open_in_process() {
        let (lib, _cfg, workspace) = lib();
        lib.register_workspace(workspace.path()).unwrap();
        let _open = lib.open_workspace(workspace.path()).unwrap();
        // In-process pre-check fires first: clearer error than the
        // cross-process flock would surface, since we know we're
        // racing ourselves rather than another process.
        let err = lib
            .reset_workspace(workspace.path(), ResetMode::State)
            .unwrap_err();
        assert!(matches!(err, ChanError::WorkspaceAlreadyOpen));
    }

    // A second Library handle on the same config has its own live_workspaces
    // map, so reset's in-process pre-check doesn't fire and it reaches the
    // flock. The flock is held by our OWN pid (this OS process), so reset
    // refuses with `WorkspaceAlreadyOpen` -- this chan already has it -- not the
    // cross-process `WorkspaceLocked`. The refusal protects the index either
    // way; a genuinely foreign holder (a separate process, a different pid)
    // still yields `WorkspaceLocked` (see lock.rs
    // `foreign_live_holder_is_workspace_locked`). (`lock::is_contended` maps the
    // Windows LockFileEx error to contention too, so this holds on Windows.)
    #[test]
    fn reset_workspace_refuses_when_another_handle_in_process_holds_lock() {
        let (lib, cfg, workspace) = lib();
        lib.register_workspace(workspace.path()).unwrap();
        let _open = lib.open_workspace(workspace.path()).unwrap();
        let lib2 = Library::open_at(cfg.path().join("config.toml")).unwrap();
        let err = lib2
            .reset_workspace(workspace.path(), ResetMode::State)
            .unwrap_err();
        assert!(matches!(err, ChanError::WorkspaceAlreadyOpen));
    }

    #[test]
    fn second_open_in_same_process_returns_already_open() {
        let (lib, _cfg, workspace) = lib();
        lib.register_workspace(workspace.path()).unwrap();
        let first = lib.open_workspace(workspace.path()).unwrap();
        let err = lib.open_workspace(workspace.path()).unwrap_err();
        assert!(matches!(err, ChanError::WorkspaceAlreadyOpen));
        // Once the first handle is dropped, the second open succeeds.
        drop(first);
        let _second = lib.open_workspace(workspace.path()).unwrap();
    }

    #[test]
    fn reset_is_idempotent_on_never_opened_workspace() {
        let (lib, _cfg, workspace) = lib();
        lib.register_workspace(workspace.path()).unwrap();
        let report = lib
            .reset_workspace(workspace.path(), ResetMode::State)
            .unwrap();
        assert_eq!(report.removed_entries, 0);
        // Registry still has it.
        assert_eq!(lib.list_workspaces().len(), 1);
    }

    #[test]
    fn reset_does_not_touch_other_workspaces_state() {
        let (lib, _cfg, workspace_a) = lib();
        let workspace_b = TempDir::new().unwrap();
        lib.register_workspace(workspace_a.path()).unwrap();
        lib.register_workspace(workspace_b.path()).unwrap();
        populate_state(&lib, workspace_a.path());
        populate_state(&lib, workspace_b.path());

        let pa = paths_of(&lib, workspace_a.path());
        let pb = paths_of(&lib, workspace_b.path());

        lib.reset_workspace(workspace_a.path(), ResetMode::State)
            .unwrap();

        // A wiped.
        assert!(!pa.index.exists());
        assert!(!pa.sessions.exists());
        // B intact.
        assert!(pb.index.exists());
        assert!(pb.sessions.exists());

        // Cleanup B so we don't leak state for the next run.
        let _ = lib.reset_workspace(workspace_b.path(), ResetMode::State);
    }

    /// Regression for the "delete-and-recreate at the same path
    /// surfaces stale graph data" bug. Before PR1, `unregister_workspace`
    /// only dropped the registry row; the per-workspace metadata root
    /// lived on. Re-registering the same path reuses the
    /// deterministic metadata key, so unregister must wipe state.
    #[test]
    fn unregister_wipes_state_so_recreate_at_same_path_starts_fresh() {
        let (lib, _cfg, workspace) = lib();
        lib.register_workspace(workspace.path()).unwrap();
        populate_state(&lib, workspace.path());

        let p = paths_of(&lib, workspace.path());
        assert!(p.graph_db.exists(), "graph DB should exist after populate");
        // Sanity: the graph actually has the file we wrote.
        {
            let d = lib.open_workspace(workspace.path()).unwrap();
            let entries = d.list_tree().unwrap();
            assert!(entries.iter().any(|e| e.path == "notes/keep.md"));
        }

        assert!(lib.unregister_workspace(workspace.path()).unwrap());

        // Per-workspace state is gone.
        assert!(!p.index.exists());
        assert!(!p.graph_db.parent().unwrap().exists());
        assert!(!p.sessions.exists());
        assert!(!p.tokens.exists());
        assert!(lib.list_workspaces().is_empty());

        // Re-register at the same path. Sidecar dirs must be absent
        // until the new workspace lazily creates them, and the new
        // workspace's graph must not surface anything until the user
        // reindexes (here: nothing on disk, so nothing to surface).
        std::fs::remove_dir_all(workspace.path().join("notes")).ok();
        lib.register_workspace(workspace.path()).unwrap();
        let d = lib.open_workspace(workspace.path()).unwrap();
        d.reindex(None).unwrap();
        let opts = crate::workspace::SearchOpts {
            mode: crate::SearchMode::Bm25,
            limit: 10,
            scope: None,
        };
        // The token used in populate_state's reindexed file was
        // "kept across reset"; searching for it must return zero
        // results, because the underlying file was removed before
        // this reindex.
        let hits = d.search("kept", &opts).unwrap();
        assert!(
            hits.hits.is_empty(),
            "stale index entries leaked across unregister/re-register; got {:?}",
            hits.hits
        );
    }

    #[test]
    fn unregister_returns_workspace_already_open_when_handle_is_live() {
        // unregister_workspace now wipes state, which requires exclusive
        // access. Holding an open handle must produce a clear error
        // rather than silently leaving the registry row gone and
        // metadata half-wiped.
        let (lib, _cfg, workspace) = lib();
        lib.register_workspace(workspace.path()).unwrap();
        let _open = lib.open_workspace(workspace.path()).unwrap();
        let err = lib.unregister_workspace(workspace.path()).unwrap_err();
        assert!(matches!(err, ChanError::WorkspaceAlreadyOpen));
        // Registry row survives, because we bailed before touching it.
        assert_eq!(lib.list_workspaces().len(), 1);
    }

    #[test]
    fn reset_state_preserves_trash() {
        let (lib, _cfg, workspace) = lib();
        lib.register_workspace(workspace.path()).unwrap();
        {
            let d = lib.open_workspace(workspace.path()).unwrap();
            d.write_text("doomed.md", "bye").unwrap();
            d.remove("doomed.md").unwrap();
            assert_eq!(d.trash_list().unwrap().len(), 1);
        }
        let p = paths_of(&lib, workspace.path());
        assert!(p.trash.exists());

        lib.reset_workspace(workspace.path(), ResetMode::State)
            .unwrap();

        // Trash survives a State-mode reset.
        assert!(p.trash.exists());
        let d = lib.open_workspace(workspace.path()).unwrap();
        assert_eq!(d.trash_list().unwrap().len(), 1);
    }
}
