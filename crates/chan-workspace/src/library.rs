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
    canonical_form, config_declares_index_excluded_dirs, current_default_index_excluded_dirs,
    index_excluded_dirs_is_stock_default, KnownWorkspace, Registry, RootMatch,
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

/// Handle to one chan-workspace registry and its co-located sidecar namespace.
#[derive(Clone)]
pub struct Library {
    inner: Arc<LibraryInner>,
}

struct LibraryInner {
    config_path: PathBuf,
    /// Root for per-workspace sidecars. Derived from `config_path` once so an
    /// explicitly located Library never falls back to process-global env.
    chan_home: PathBuf,
    /// Effective transfer cap captured once when this Library opens. Registry
    /// reloads deliberately do not mutate a running process's policy.
    transfer_max_bytes: u64,
    /// In-memory registry. Persisted to `config_path` on every
    /// mutation. The Mutex serializes registry writes so
    /// `register_workspace` calls from concurrent threads don't race.
    /// It is never held across a filesystem call on a workspace root:
    /// every lookup is matched first by `match_root`, and the
    /// holder only re-checks that match against the rows and edits them.
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
    /// The rows and path keys that operations of this process hold: an
    /// exclusive claim, as an unregister holds on its row from the step
    /// that finds it to the end of the registry's update, and a shared use.
    /// Held in memory alone.
    ///
    /// Taken after `registry` when both are needed and never before it. It
    /// is a leaf: nothing is called and no other lock is taken under it, and
    /// a claim's or a use's drop takes it alone.
    operation_claims: Mutex<ClaimLedger>,
}

/// What an operation that must own its registry row is told.
#[derive(Debug)]
#[must_use = "a conflict means nothing was claimed"]
pub enum WorkspaceAdmission<T> {
    /// The operation holds what it asked for.
    Admitted(T),
    /// Another claim or use holds the row or one of the paths. Nothing was
    /// changed, and the caller answers that the workspace is still releasing.
    Conflict,
}

/// How an operation names the registry row it claims
/// ([`Library::claim_row`]). The library applies the three rules in order,
/// under its registry's mutex, to the rows as they are then.
#[derive(Debug, Clone, Copy)]
pub struct RowSelection<'a> {
    /// The path the operation was asked for, as given and lexically
    /// normalized. The row that stores it is the row named.
    pub given: &'a Path,
    /// The root a mounted workspace the caller found was opened at, when it
    /// found one. With no row storing `given`, the row that stores this is
    /// the row named.
    pub opened_at: Option<&'a Path>,
    /// The other paths the operation's work would reach. With neither rule
    /// above naming a row, the first row that goes by one of them, or that
    /// last resolved to `given`, is the row named. The claim asks for each
    /// of them.
    pub keys: &'a [PathBuf],
}

/// One hold in the ledger.
struct LedgerEntry {
    id: u64,
    /// An exclusive claim, which refuses every other hold of its row or its
    /// keys; a shared use refuses only an exclusive claim.
    exclusive: bool,
    /// The metadata key of the row held, which names the state a removal
    /// wipes; `None` for a claim of path keys that no row goes by.
    metadata_key: Option<String>,
    /// The path keys held, compared as given.
    keys: Vec<PathBuf>,
}

#[derive(Default)]
struct ClaimLedger {
    next_id: u64,
    entries: Vec<LedgerEntry>,
}

impl ClaimLedger {
    /// Whether a hold of `metadata_key` and `keys` meets one it cannot stand
    /// beside, the entry `except` aside: two holds conflict when either is
    /// exclusive and they share the metadata key or a path key.
    fn conflicts(
        &self,
        exclusive: bool,
        metadata_key: Option<&str>,
        keys: &[PathBuf],
        except: Option<u64>,
    ) -> bool {
        self.entries.iter().any(|entry| {
            Some(entry.id) != except
                && (exclusive || entry.exclusive)
                && (metadata_key.is_some_and(|key| entry.metadata_key.as_deref() == Some(key))
                    || keys.iter().any(|key| entry.keys.contains(key)))
        })
    }

    fn insert(&mut self, exclusive: bool, metadata_key: Option<String>, keys: Vec<PathBuf>) -> u64 {
        self.next_id += 1;
        self.entries.push(LedgerEntry {
            id: self.next_id,
            exclusive,
            metadata_key,
            keys,
        });
        self.next_id
    }
}

/// One entry of the ledger, which leaves it when this drops.
struct LedgerHold {
    library: Library,
    id: u64,
}

impl Drop for LedgerHold {
    fn drop(&mut self) {
        self.library
            .ledger()
            .entries
            .retain(|entry| entry.id != self.id);
    }
}

/// An exclusive hold on one registry row and on paths, or on paths that no
/// row goes by, from [`Library::claim_row`] or
/// [`Library::claim_unregistered`].
///
/// A claim of a row holds the root the row stores, always, and each further
/// path it asked for that no row storing another root goes by
/// ([`keys`](Self::keys)). A row owns the root it stores, so another row's
/// stale record of having resolved to that root takes nothing from it; and
/// a path another row goes by is that row's, so the claim leaves it out
/// and its holder does not act under it.
///
/// While it stands, a registration, an open, a move, a reset or an unregister
/// of this library that names the row or one of the held paths answers
/// [`ChanError::WorkspaceAlreadyOpen`] and changes nothing, and so does a
/// second claim. A clone shares the hold, which ends when the last clone
/// drops, so work that outlives its caller keeps it by holding a clone.
#[derive(Clone)]
pub struct WorkspaceClaim {
    hold: Arc<LedgerHold>,
    row: Option<Arc<KnownWorkspace>>,
}

impl std::fmt::Debug for WorkspaceClaim {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkspaceClaim")
            .field("row", &self.row.as_ref().map(|row| &row.root_path))
            .finish()
    }
}

impl WorkspaceClaim {
    /// The claimed row as the registry held it when it was claimed. `None`
    /// for a claim of paths that no row goes by.
    pub fn row(&self) -> Option<&KnownWorkspace> {
        self.row.as_deref()
    }

    /// The paths the claim holds, the root its row stores first. A path it
    /// asked for that another row goes by is not among them.
    pub fn keys(&self) -> Vec<PathBuf> {
        self.hold
            .library
            .ledger()
            .entries
            .iter()
            .find(|entry| entry.id == self.hold.id)
            .map(|entry| entry.keys.clone())
            .unwrap_or_default()
    }

    /// Ask for further paths, in one step under the registry's mutex. The
    /// claim takes each one that no row storing another root goes by; a
    /// path another row goes by is left out, which is not a refusal.
    /// `Conflict`, with the claim as it was, when another claim or use
    /// holds one of the paths it would take.
    pub fn extend(&self, keys: &[PathBuf]) -> WorkspaceAdmission<()> {
        let library = &self.hold.library;
        let reg = library.inner.registry.lock().unwrap();
        let own = self.row.as_ref().map(|row| row.root_path.as_path());
        let taken = unowned_paths(&reg.workspaces, own, keys.iter());
        let mut ledger = library.ledger();
        if ledger.conflicts(true, None, &taken, Some(self.hold.id)) {
            return WorkspaceAdmission::Conflict;
        }
        if let Some(entry) = ledger
            .entries
            .iter_mut()
            .find(|entry| entry.id == self.hold.id)
        {
            for key in taken {
                if !entry.keys.contains(&key) {
                    entry.keys.push(key);
                }
            }
        }
        WorkspaceAdmission::Admitted(())
    }

    /// Unregister the claimed row and wipe its chan-managed state, as
    /// [`Library::unregister_workspace`] does, by the root, the metadata key
    /// and the creation time the claim captured: no path is resolved and no
    /// row is looked up again by a name, so the row removed is the one that
    /// was claimed.
    ///
    /// `holder` names the writer lock's holder: the lock records its
    /// canonical form and compares that with its record at a contention, so
    /// it is the canonical root the caller holds the workspace by. It picks
    /// no row.
    ///
    /// Returns `Ok(false)`, having wiped nothing, when no row stores the
    /// claimed root any longer, as after another process removed it, and
    /// for a claim of paths alone. Refuses with
    /// `ChanError::WorkspaceAlreadyOpen`, having wiped nothing, while this
    /// process holds a live `Arc<Workspace>` of the row, and when the rows
    /// that store the root are all of another metadata key or creation
    /// time: another process replaced the registration, and its state is
    /// not this claim's to wipe.
    pub fn unregister(&self, holder: &Path) -> Result<bool> {
        let Some(row) = self.row.as_deref() else {
            return Ok(false);
        };
        #[cfg(any(test, feature = "test-hooks"))]
        let _step = crate::paths::root_stall::UNREGISTER_WORKSPACE.open();
        let library = &self.hold.library;
        // Asked before the lock is taken, so a holder whose filesystem does
        // not answer stops this call here, before it holds the lock.
        let holder = paths::canonicalize_normalized(holder);
        {
            let reg = library.inner.registry.lock().unwrap();
            let mut stored = reg
                .workspaces
                .iter()
                .filter(|known| known.root_path == row.root_path)
                .peekable();
            if stored.peek().is_none() {
                return Ok(false);
            }
            if !stored.any(|known| {
                known.metadata_key == row.metadata_key && known.created_at == row.created_at
            }) {
                return Err(ChanError::WorkspaceAlreadyOpen);
            }
        }
        library.refuse_if_row_live(&row.metadata_key)?;
        let (_lock, _removed) =
            library.wipe_row_state(&row.metadata_key, &holder, &crate::progress::NoProgress)?;
        // The writer lock is held across the registry update, as
        // `reset_workspace_with` holds it.
        let mut reg = library.inner.registry.lock().unwrap();
        if reg.remove_stored(&row.root_path, &row.metadata_key) {
            reg.save_to(&library.inner.config_path)?;
        }
        Ok(true)
    }
}

/// A shared hold on one registry row and on path keys, from
/// [`Library::use_row`]. It refuses, and is refused by, a
/// [`WorkspaceClaim`] of the row or of one of the keys, and stands beside
/// any other use. It ends when it drops.
pub struct WorkspaceUse {
    _hold: LedgerHold,
}

impl std::fmt::Debug for WorkspaceUse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkspaceUse").finish_non_exhaustive()
    }
}

/// The paths among `asked` that a claim of the row storing `own` may hold,
/// each once and in the order asked: every one that no row storing another
/// root goes by, by the root it stores or by the path it last resolved to.
fn unowned_paths<'a>(
    rows: &[KnownWorkspace],
    own: Option<&Path>,
    asked: impl Iterator<Item = &'a PathBuf>,
) -> Vec<PathBuf> {
    let mut unowned: Vec<PathBuf> = Vec::new();
    for key in asked {
        if unowned.contains(key) {
            continue;
        }
        let another_rows = rows.iter().any(|other| {
            Some(other.root_path.as_path()) != own && row_goes_by(other, std::slice::from_ref(key))
        });
        if !another_rows {
            unowned.push(key.clone());
        }
    }
    unowned
}

/// Whether `row` goes by one of `keys`.
fn row_goes_by(row: &KnownWorkspace, keys: &[PathBuf]) -> bool {
    keys.iter().any(|key| {
        row.root_path.as_path() == key.as_path() || row.cached_canonical_path() == key.as_path()
    })
}

impl Library {
    /// Open the default Library at `~/.chan/config.toml`. Creates
    /// the parent directory lazily on first save.
    pub fn open() -> Result<Self> {
        Self::open_at(paths::global_config_path())
    }

    /// Open a Library against an explicit config path. Workspace sidecars are
    /// rooted beside this file, so the Library never consults ambient home
    /// state after construction.
    pub fn open_at(config_path: PathBuf) -> Result<Self> {
        let chan_home = config_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default();
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
        let transfer_max_bytes = registry.transfer.max_bytes;
        Ok(Self {
            inner: Arc::new(LibraryInner {
                config_path,
                chan_home,
                transfer_max_bytes,
                registry: Mutex::new(registry),
                live_workspaces: Mutex::new(HashMap::new()),
                walk_filter: Mutex::new(walk_filter),
                operation_claims: Mutex::new(ClaimLedger::default()),
            }),
        })
    }

    /// The ledger of claims and uses. Its mutex is a leaf, and a poisoned
    /// one is still read: an entry is plain data, complete under every
    /// unwind, and a hold must leave the ledger when it drops.
    fn ledger(&self) -> std::sync::MutexGuard<'_, ClaimLedger> {
        self.inner
            .operation_claims
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Name one registry row by `selection` and claim it in one step under
    /// the registry's mutex, so that no registration or removal lands
    /// between the selection and the claim.
    ///
    /// The claim holds the row, by its metadata key and the root it stores,
    /// and of the path the row last resolved to and the paths `selection`
    /// asks for, each one that no row storing another root goes by
    /// ([`WorkspaceClaim::keys`]). `Admitted(None)` means the selection
    /// named no row, and nothing is claimed. `Conflict` means another claim
    /// or use holds the row or one of the paths the claim would hold; what
    /// another row goes by is never a conflict. Two rows that store one
    /// root, which only a registry file written outside this library holds,
    /// share every path: the first of them is the row named, and the other
    /// takes nothing from its claim.
    pub fn claim_row(
        &self,
        selection: RowSelection<'_>,
    ) -> WorkspaceAdmission<Option<WorkspaceClaim>> {
        let reg = self.inner.registry.lock().unwrap();
        let rows = &reg.workspaces;
        let stores = |root: &Path| rows.iter().position(|row| row.root_path == root);
        let named = stores(selection.given)
            .or_else(|| selection.opened_at.and_then(stores))
            .or_else(|| {
                rows.iter().position(|row| {
                    row.cached_canonical_path() == selection.given
                        || row_goes_by(row, selection.keys)
                })
            });
        match named {
            Some(index) => self.claim_at(&reg, index, selection.keys),
            None => WorkspaceAdmission::Admitted(None),
        }
    }

    /// Claim the row at `index` of the registry its caller holds, asking
    /// for `asked` beside the row's own two paths.
    fn claim_at(
        &self,
        reg: &Registry,
        index: usize,
        asked: &[PathBuf],
    ) -> WorkspaceAdmission<Option<WorkspaceClaim>> {
        let Some(row) = reg.workspaces.get(index) else {
            return WorkspaceAdmission::Admitted(None);
        };
        let resolved = row.cached_canonical_path().to_path_buf();
        let mut keys = vec![row.root_path.clone()];
        for key in unowned_paths(
            &reg.workspaces,
            Some(row.root_path.as_path()),
            std::iter::once(&resolved).chain(asked),
        ) {
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
        let mut ledger = self.ledger();
        if ledger.conflicts(true, Some(&row.metadata_key), &keys, None) {
            return WorkspaceAdmission::Conflict;
        }
        let id = ledger.insert(true, Some(row.metadata_key.clone()), keys);
        drop(ledger);
        WorkspaceAdmission::Admitted(Some(WorkspaceClaim {
            hold: Arc::new(LedgerHold {
                library: self.clone(),
                id,
            }),
            row: Some(Arc::new(row.clone())),
        }))
    }

    /// Claim `keys` for a directory that has no registration: admitted only
    /// while no registry row goes by any of them and no claim or use holds
    /// one. While the claim stands, a registration of a directory whose
    /// canonical path is one of them answers
    /// [`ChanError::WorkspaceAlreadyOpen`], so its holder can act on what it
    /// keeps under those paths knowing that no registration of them lands
    /// meanwhile.
    pub fn claim_unregistered(&self, keys: &[PathBuf]) -> WorkspaceAdmission<WorkspaceClaim> {
        let reg = self.inner.registry.lock().unwrap();
        if reg.workspaces.iter().any(|row| row_goes_by(row, keys)) {
            return WorkspaceAdmission::Conflict;
        }
        let mut ledger = self.ledger();
        if ledger.conflicts(true, None, keys, None) {
            return WorkspaceAdmission::Conflict;
        }
        let id = ledger.insert(true, None, keys.to_vec());
        drop(ledger);
        WorkspaceAdmission::Admitted(WorkspaceClaim {
            hold: Arc::new(LedgerHold {
                library: self.clone(),
                id,
            }),
            row: None,
        })
    }

    /// Take a shared use of `keys`, the paths its holder goes by, the root
    /// its registry row stores among them, and of the row whose metadata
    /// key is `metadata_key` when the holder knows it. `Conflict` while a
    /// [`WorkspaceClaim`] holds the row or one of the paths; a claim always
    /// holds the root its row stores, so a use that names that root meets
    /// it with or without the key.
    ///
    /// It takes the ledger's mutex alone and asks nothing of the registry,
    /// so a caller may take it while it holds a lock of its own, and it
    /// does not say whether the row is registered.
    pub fn use_row(
        &self,
        metadata_key: Option<&str>,
        keys: &[PathBuf],
    ) -> WorkspaceAdmission<WorkspaceUse> {
        let mut ledger = self.ledger();
        if ledger.conflicts(false, metadata_key, keys, None) {
            return WorkspaceAdmission::Conflict;
        }
        let id = ledger.insert(false, metadata_key.map(str::to_string), keys.to_vec());
        drop(ledger);
        WorkspaceAdmission::Admitted(WorkspaceUse {
            _hold: LedgerHold {
                library: self.clone(),
                id,
            },
        })
    }

    /// Whether a [`WorkspaceClaim`] holds the row whose metadata key is
    /// `metadata_key` or one of `keys`.
    fn claimed(&self, metadata_key: Option<&str>, keys: &[PathBuf]) -> bool {
        self.ledger().conflicts(false, metadata_key, keys, None)
    }

    /// Refuse a registration that would touch a claimed row, give a row a
    /// claimed path as the one it resolves to, or append a row under a
    /// claimed path or metadata key, which is the same folder added again.
    /// Called with the registry's mutex held, before the row is touched.
    fn refuse_claimed_registration(&self, reg: &Registry, found: &RootMatch) -> Result<()> {
        let ledger = self.ledger();
        if ledger.entries.is_empty() {
            return Ok(());
        }
        let canonical = found.canonical().to_path_buf();
        let refused = match reg.find_matched(found) {
            Some(row) => ledger.conflicts(
                false,
                Some(&row.metadata_key),
                &[row.root_path.clone(), canonical],
                None,
            ),
            None => ledger.conflicts(
                false,
                Some(&paths::metadata_key_for_canonical(&canonical)),
                &[canonical],
                None,
            ),
        };
        if refused {
            return Err(ChanError::WorkspaceAlreadyOpen);
        }
        Ok(())
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

    /// Effective transfer ceiling captured when this Library opened.
    pub fn transfer_max_bytes(&self) -> u64 {
        self.inner.transfer_max_bytes
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
        let mut registry = Registry::load_from(&self.inner.config_path)?;
        // What this handle holds in memory alone outlives the reload: each
        // row's resolved path, and the unanswered roots a row was appended
        // beside, which the file never carries.
        registry.keep_unsaved_fields(&registry_guard);
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
    ///
    /// One directory keeps one row, with one exception that mends itself. A
    /// row whose stored root resolves elsewhere since it was registered is
    /// found by asking every such root again, each within the alias probe's
    /// two seconds, and a root that has not answered by then is taken not
    /// to be this directory: the registration appends a row, which
    /// remembers that root. A later registration that lands on the appended
    /// row asks the root again, within the same two seconds, and once it
    /// resolves into this directory drops the appended row, wipes its
    /// chan-managed state as an unregister does, and answers the row that
    /// stores the root. It drops nothing while this process holds the
    /// appended row's workspace open or its writer lock is held: it answers
    /// that row and the next registration tries again. Only a registration
    /// asks or drops; every other lookup answers the appended row and waits
    /// on nothing.
    pub fn register_workspace_with_name(
        &self,
        root: &Path,
        display_name: Option<String>,
    ) -> Result<KnownWorkspace> {
        #[cfg(any(test, feature = "test-hooks"))]
        let _step = crate::paths::root_stall::REGISTER_WORKSPACE.open();
        if !root.exists() {
            return Err(ChanError::WorkspaceRootMissing(root.to_path_buf()));
        }
        let found = self.match_registration(root);
        let superseded = self
            .inner
            .registry
            .lock()
            .unwrap()
            .settle_unanswered(&found);
        if let Some((stored, metadata_key)) = superseded {
            // Run without the registry's mutex: the drop wipes state on
            // disk under the row's writer lock.
            self.drop_appended_row(&stored, &metadata_key, found.canonical());
        }
        let mut reg = self.inner.registry.lock().unwrap();
        self.refuse_claimed_registration(&reg, &found)?;
        let idx = reg.touch_matched(&found);
        if let Some(name) = display_name {
            let name = name.trim();
            reg.workspaces[idx].display_name = (!name.is_empty()).then(|| name.to_string());
        }
        let entry = reg.workspaces[idx].clone();
        paths::ensure_workspace_metadata_dirs_in(&self.inner.chan_home, &entry.metadata_key)?;
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
        #[cfg(any(test, feature = "test-hooks"))]
        let _step = crate::paths::root_stall::UNREGISTER_WORKSPACE.open();
        // One lookup serves the whole removal: it says whether the
        // workspace is registered, which the return value reflects, and
        // names the row, by the root it stores and its metadata key, for the
        // wipe and for the registry removal. A lookup of a root whose row's
        // cached path is stale waits on the other rows' roots, so each
        // further one would wait again beside a root that does not answer.
        let found = self.match_root(root);
        let Some((stored, metadata_key)) = self.matched_row(&found) else {
            return Ok(false);
        };
        // Held to the end of the wipe and the registry's update, so a
        // registration of the folder meanwhile answers retry and is not
        // dropped with the row.
        let Some(_claim) = self.claim_stored_row(&stored, Some(&metadata_key))? else {
            return Ok(false);
        };
        self.refuse_if_live(root)?;
        self.reset_row(
            root,
            &stored,
            &metadata_key,
            ResetMode::Everything,
            &crate::progress::NoProgress,
        )?;
        Ok(true)
    }

    /// Claim the row that stores `stored`, and under `metadata_key` when
    /// one is given, for an operation of this library that drops it. `None`
    /// when no such row is left; [`ChanError::WorkspaceAlreadyOpen`] when
    /// another operation holds it.
    fn claim_stored_row(
        &self,
        stored: &Path,
        metadata_key: Option<&str>,
    ) -> Result<Option<WorkspaceClaim>> {
        let reg = self.inner.registry.lock().unwrap();
        let named = reg.workspaces.iter().position(|row| {
            row.root_path == stored && metadata_key.is_none_or(|key| row.metadata_key == key)
        });
        let claimed = match named {
            Some(index) => self.claim_at(&reg, index, &[]),
            None => WorkspaceAdmission::Admitted(None),
        };
        match claimed {
            WorkspaceAdmission::Admitted(claim) => Ok(claim),
            WorkspaceAdmission::Conflict => Err(ChanError::WorkspaceAlreadyOpen),
        }
    }

    /// Unregister the registry row that stores `stored`, compared as the
    /// registry stores it, and wipe its chan-managed state as
    /// [`unregister_workspace`](Self::unregister_workspace) does, without
    /// resolving any path to find the row. A caller that holds the row
    /// reaches it so even when its root resolves elsewhere since the
    /// registry was loaded, where a lookup of that root finds another row
    /// or none.
    ///
    /// `holder` names the writer lock's holder: the lock records its
    /// canonical form and compares that with its record at a contention, so
    /// it is the canonical root the caller holds the workspace by. It picks
    /// no row.
    ///
    /// Refuses with `ChanError::WorkspaceAlreadyOpen` while this process
    /// holds a live `Arc<Workspace>` of the row, or while another operation
    /// holds a claim on it. Returns `Ok(false)`, having wiped nothing, when
    /// no row stores `stored`.
    ///
    /// The row is claimed in the step that finds it and the claim stands to
    /// the end of the registry's update ([`WorkspaceClaim::unregister`]), so
    /// a registration of the folder meanwhile answers
    /// `ChanError::WorkspaceAlreadyOpen` and is not dropped with the row.
    pub fn unregister_workspace_row(&self, stored: &Path, holder: &Path) -> Result<bool> {
        match self.claim_stored_row(stored, None)? {
            Some(claim) => claim.unregister(holder),
            None => Ok(false),
        }
    }

    /// Drop the row a registration found to be a second row for its
    /// directory: appended while another row's stored root had not answered
    /// the alias probe, and that root resolves into the directory now. Runs
    /// as [`unregister_workspace_row`](Self::unregister_workspace_row) does:
    /// the live check by metadata key, the wipe under the row's writer lock
    /// with `holder`, the directory's canonical path, as the root its record
    /// names, and the registry update while that lock is held.
    ///
    /// A drop that is refused changes nothing: the row stays with the roots
    /// it remembers, the registration answers it, and a later registration
    /// tries again. That is what a live handle of the row in this process,
    /// a claim another operation holds on it and a writer lock another
    /// process holds come to; any other failure is logged and treated the
    /// same, since the registration itself can still answer.
    fn drop_appended_row(&self, stored: &Path, metadata_key: &str, holder: &Path) {
        // Held through the wipe and the registry's update, as an unregister
        // holds its row.
        let _claim = match self.claim_stored_row(stored, Some(metadata_key)) {
            Ok(Some(claim)) => claim,
            Ok(None) | Err(_) => return,
        };
        let dropped = self.refuse_if_row_live(metadata_key).and_then(|()| {
            let (_lock, _removed) =
                self.wipe_row_state(metadata_key, holder, &crate::progress::NoProgress)?;
            let mut reg = self.inner.registry.lock().unwrap();
            if reg.remove_appended(stored, metadata_key) {
                reg.save_to(&self.inner.config_path)?;
            }
            Ok(())
        });
        match dropped {
            Ok(()) | Err(ChanError::WorkspaceAlreadyOpen | ChanError::WorkspaceLocked) => {}
            Err(error) => tracing::warn!(
                root = %stored.display(),
                %error,
                "could not drop a registry row that its directory's own row supersedes"
            ),
        }
    }

    /// Open a workspace handle. The workspace must already be registered;
    /// callers do `register_workspace` first if needed (CLI does both
    /// in one shot for the "point at a directory and go" path).
    pub fn open_workspace(&self, root: &Path) -> Result<Arc<Workspace>> {
        #[cfg(any(test, feature = "test-hooks"))]
        let _step = crate::paths::root_stall::OPEN_WORKSPACE.open();
        let found = self.match_root(root);
        let reg = self.inner.registry.lock().unwrap();
        let entry = reg
            .find_matched(&found)
            .ok_or_else(|| ChanError::WorkspaceNotRegistered(root.to_path_buf()))?
            .clone();
        // A row an operation holds, as a removal holds its own to the end of
        // its unregister, is not opened: the open would take the writer lock
        // that operation needs, or mount a workspace it is about to drop.
        // Asked by the root the row stores: the path it last resolved to can
        // be another row's by now.
        if self.claimed(
            Some(&entry.metadata_key),
            std::slice::from_ref(&entry.root_path),
        ) {
            return Err(ChanError::WorkspaceAlreadyOpen);
        }
        drop(reg);
        let key = canonical_key(&entry.root_path);
        // In-process pre-check: if we still hold an open handle to this
        // workspace, return WorkspaceAlreadyOpen up front instead of reaching
        // the flock. (A contended flock held by our own pid now also reports
        // WorkspaceAlreadyOpen, so the two agree; the pre-check additionally
        // short-circuits the potentially-slow Workspace::open below.) The lock
        // on `live_workspaces` is held only across the upgrade probe; we drop
        // it before calling Workspace::open so a slow metadata open
        // (canonicalize on a cloud root, sidecar readiness probes) never
        // blocks unrelated workspaces from registering / listing.
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
        let (workspace, recovery_plan) = Workspace::open(
            entry,
            filter,
            drafts_dir,
            self.inner.transfer_max_bytes,
            &self.inner.chan_home,
        )?;
        self.inner
            .live_workspaces
            .lock()
            .unwrap()
            .insert(key, Arc::downgrade(&workspace));
        workspace.start_open_recovery(recovery_plan)?;
        Ok(workspace)
    }

    /// Refuse when this process still holds a live `Arc<Workspace>` for
    /// `root`. Every destructive operation over a workspace's sidecars runs
    /// this before reaching for the writer lock: the flock reports the same
    /// clash (a lock held by our own pid answers `WorkspaceAlreadyOpen`),
    /// but the pre-check short-circuits before any slow or destructive work
    /// starts and names the clash precisely. Cross-process safety (a foreign
    /// holder => `WorkspaceLocked`) still rides on the flock.
    pub(crate) fn refuse_if_live(&self, root: &Path) -> Result<()> {
        let key = canonical_key(root);
        let mut map = self.inner.live_workspaces.lock().unwrap();
        gc_dead_entries(&mut map);
        if let Some(weak) = map.get(&key) {
            if weak.upgrade().is_some() {
                return Err(ChanError::WorkspaceAlreadyOpen);
            }
        }
        Ok(())
    }

    /// [`refuse_if_live`](Self::refuse_if_live) for a caller that holds a
    /// registry row: finds this process's live handle of the row by its
    /// metadata key and resolves nothing. By a root's canonical form, a root
    /// that resolves elsewhere since its handle opened finds another
    /// workspace's handle, or none.
    fn refuse_if_row_live(&self, metadata_key: &str) -> Result<()> {
        let mut map = self.inner.live_workspaces.lock().unwrap();
        gc_dead_entries(&mut map);
        if map
            .values()
            .filter_map(Weak::upgrade)
            .any(|workspace| workspace.metadata_key() == metadata_key)
        {
            return Err(ChanError::WorkspaceAlreadyOpen);
        }
        Ok(())
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
        // A buggy caller might hold a Workspace and call reset_workspace
        // from another thread, expecting the flock to serialize.
        self.refuse_if_live(root)?;
        // Metadata identity comes from the registry's metadata key,
        // not the current filesystem path. An unregistered root has
        // no key in the registry, so there is nothing for this
        // Library to wipe.
        let found = self.match_root(root);
        let Some((stored, metadata_key)) = self.matched_row(&found) else {
            return Ok(ResetReport { removed_entries: 0 });
        };
        // A reset that drops the row holds it as an unregister does. One
        // that keeps the row only stands aside for an operation that holds
        // it: a registration beside it touches a row that stays.
        let _claim = match mode {
            ResetMode::Everything => match self.claim_stored_row(&stored, Some(&metadata_key))? {
                Some(claim) => Some(claim),
                None => return Ok(ResetReport { removed_entries: 0 }),
            },
            ResetMode::State => {
                if self.claimed(Some(&metadata_key), std::slice::from_ref(&stored)) {
                    return Err(ChanError::WorkspaceAlreadyOpen);
                }
                None
            }
        };
        self.reset_row(root, &stored, &metadata_key, mode, progress)
    }

    /// The root the row `found` names stores and its metadata key, read from
    /// the rows as they are now. `None` when no row matches.
    fn matched_row(&self, found: &RootMatch) -> Option<(PathBuf, String)> {
        self.inner
            .registry
            .lock()
            .unwrap()
            .find_matched(found)
            .map(|row| (row.root_path.clone(), row.metadata_key.clone()))
    }

    /// Wipe the state stored under `metadata_key`, the key of the row that
    /// stores `stored`, and for [`ResetMode::Everything`] drop that row. The
    /// removal names the row by both, as the registry holds it then, and
    /// looks nothing up, so a reset looks its root up in the registry once.
    /// A row registered since that lookup for the same directory has state
    /// of its own, which this call did not wipe, and keeps its registration.
    fn reset_row(
        &self,
        root: &Path,
        stored: &Path,
        metadata_key: &str,
        mode: ResetMode,
        progress: &dyn crate::progress::ProgressCallback,
    ) -> Result<ResetReport> {
        let (_lock, removed) = self.wipe_row_state(metadata_key, root, progress)?;
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
            if reg.remove_stored(stored, metadata_key) {
                reg.save_to(&self.inner.config_path)?;
            }
        }
        Ok(ResetReport {
            removed_entries: removed,
        })
    }

    /// Wipe the chan-managed state stored under `metadata_key` (the index,
    /// the graph, the session blobs, the app tokens and the report), firing
    /// one `ProgressStage::Reset` event per subsystem as it goes. Takes the
    /// workspace's writer lock first, with `holder` as the root its record
    /// names, and returns it with the count of entries removed, so the
    /// caller holds it across its registry update.
    fn wipe_row_state(
        &self,
        metadata_key: &str,
        holder: &Path,
        progress: &dyn crate::progress::ProgressCallback,
    ) -> Result<(WorkspaceLock, usize)> {
        use crate::progress::{ProgressEvent, ProgressStage};
        let workspace_paths =
            paths::workspace_paths_for_metadata_key_in(&self.inner.chan_home, metadata_key);
        let lock = WorkspaceLock::acquire(&workspace_paths.lock, holder)?;
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
        Ok((lock, removed))
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
        self.refuse_if_live(old)?;
        let old_found = self.match_root(old);
        let new_found = self.match_root(new);
        let mut reg = self.inner.registry.lock().unwrap();
        let Some(old_entry) = reg.find_matched(&old_found) else {
            return Ok(false);
        };
        // Neither a row an operation holds nor a path it holds is moved or
        // moved onto.
        if self.claimed(
            Some(&old_entry.metadata_key),
            &[
                old_entry.root_path.clone(),
                new_found.canonical().to_path_buf(),
            ],
        ) {
            return Err(ChanError::WorkspaceAlreadyOpen);
        }
        let old_metadata_key = old_entry.metadata_key.clone();
        if let Some(existing) = reg.find_matched(&new_found) {
            if existing.metadata_key != old_metadata_key {
                return Err(ChanError::WorkspaceAlreadyRegistered(new.to_path_buf()));
            }
            // Same metadata key means `new` is already an alias for
            // this workspace, e.g. an idempotent retry after a partial
            // move. Drop through to set_path.
        }
        let ok = reg.set_path_matched(&old_found, new_found.canonical().to_path_buf());
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
        let found = self.match_root(root);
        let reg = self.inner.registry.lock().unwrap();
        let entry = reg.find_matched(&found)?;
        Some(paths::workspace_paths_for_metadata_key_in(
            &self.inner.chan_home,
            &entry.metadata_key,
        ))
    }

    /// Per-workspace paths for a registry row, from the metadata key it
    /// stores, touching no filesystem: a caller holding the row, such as a
    /// listing, needs no lookup that would resolve the workspace's root.
    pub fn workspace_paths_for_row(&self, row: &KnownWorkspace) -> paths::WorkspacePaths {
        paths::workspace_paths_for_metadata_key_in(&self.inner.chan_home, &row.metadata_key)
    }

    /// Match `root` against the registry without holding its mutex across
    /// any filesystem call: `root` is canonicalized, the rows a stale cache
    /// could hide it behind are copied out under the mutex, and those roots
    /// are re-resolved, each within a bounded wait, after it is released. The
    /// caller takes the mutex again and applies the match, which re-checks
    /// it against the rows as they are then. The other rows are re-resolved
    /// only when no row's cached canonical path is `root`'s, a removal
    /// included, so removing a workspace whose row matches waits on no other
    /// workspace's filesystem, one of which may have stalled.
    fn match_root(&self, root: &Path) -> RootMatch {
        let canonical = canonical_form(root);
        let candidates = self
            .inner
            .registry
            .lock()
            .unwrap()
            .alias_candidates(&canonical, false);
        RootMatch::resolve(canonical, &candidates)
    }

    /// [`match_root`](Self::match_root) for a registration, which alone asks
    /// again the roots that had not answered when the row it lands on was
    /// appended. While one of them still does not answer, each registration
    /// of that directory waits the probe's budget for it.
    fn match_registration(&self, root: &Path) -> RootMatch {
        let canonical = canonical_form(root);
        let candidates = self
            .inner
            .registry
            .lock()
            .unwrap()
            .registration_candidates(&canonical);
        RootMatch::resolve(canonical, &candidates)
    }

    /// Reclaim metadata directories whose key no longer appears in
    /// the registry. Walks the Library's captured metadata parent and
    /// deletes any immediate subdirectory whose name isn't a current
    /// metadata key.
    ///
    /// Use cases include an unregister that left metadata state behind
    /// and a hand-edited registry whose matching metadata roots remain
    /// on disk.
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
        sweep_orphans_in(
            &paths::workspace_subsystem_dirs_in(&self.inner.chan_home),
            &known,
        )
    }
}

/// Inner workhorse for `Library::sweep_orphans`: walk each metadata
/// parent in `parents` and remove any immediate subdirectory whose
/// name is not in `known`. Pure in its arguments so tests can drive
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
            Err(e) => return Err(ChanError::io_with_context(e, format!("read {parent:?}"))),
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
    fn open_at_keeps_workspace_metadata_beside_the_injected_config() {
        let cfg = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        let entry = lib.register_workspace(workspace.path()).unwrap();

        let expected_root = cfg.path().join("workspaces").join(&entry.metadata_key);
        let paths = lib.workspace_paths_for(workspace.path()).unwrap();
        assert_eq!(paths.root, expected_root);
        assert!(paths.sessions.is_dir());

        let opened = lib.open_workspace(workspace.path()).unwrap();
        assert_eq!(opened.paths().root, expected_root);
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
        // Adding buck-out makes this a customized exclusion list, so migration
        // must leave it intact.
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

    /// An unregister by row removes the row that stores the root it is
    /// given, and wipes that row's state, although the root now resolves to
    /// another registered workspace's folder, whose row and state it leaves.
    #[cfg(unix)]
    #[test]
    fn unregister_workspace_row_removes_the_row_that_stores_the_root() {
        use std::os::unix::fs::symlink;
        let (lib, _cfg, holder) = lib();
        std::fs::create_dir_all(holder.path().join("parent").join("ws")).unwrap();
        let first = lib
            .register_workspace(&holder.path().join("parent").join("ws"))
            .unwrap();
        let other_holder = TempDir::new().unwrap();
        std::fs::create_dir_all(other_holder.path().join("ws")).unwrap();
        let other = lib
            .register_workspace(&other_holder.path().join("ws"))
            .unwrap();
        populate_state(&lib, &first.root_path);
        populate_state(&lib, &other.root_path);
        let link = first.root_path.parent().unwrap();
        std::fs::rename(link, holder.path().join("moved")).unwrap();
        symlink(other_holder.path(), link).unwrap();
        assert_eq!(
            paths::canonicalize_normalized(&first.root_path),
            other.root_path,
            "fixture: the stored root does not resolve to the other workspace"
        );

        assert!(
            !lib.unregister_workspace_row(&other_holder.path().join("none"), &first.root_path)
                .unwrap(),
            "a root no row stores was unregistered"
        );
        assert!(lib
            .unregister_workspace_row(&first.root_path, &first.root_path)
            .unwrap());

        let keys: Vec<String> = lib
            .list_workspaces()
            .into_iter()
            .map(|row| row.metadata_key)
            .collect();
        assert_eq!(
            keys,
            vec![other.metadata_key.clone()],
            "the unregister removed another row or kept its own"
        );
        assert!(
            lib.workspace_paths_for_row(&other)
                .tokens
                .join("server.token")
                .exists(),
            "the unregister wiped another row's state"
        );
        assert!(
            !lib.workspace_paths_for_row(&first)
                .tokens
                .join("server.token")
                .exists(),
            "the unregister left its row's state"
        );
    }

    /// A live handle of a row refuses its unregister by row as already open,
    /// although the root the row stores resolves elsewhere now than where
    /// the handle opened it, which is the place its lock's record names.
    #[cfg(unix)]
    #[test]
    fn unregister_workspace_row_refuses_a_live_handle_of_its_row_as_already_open() {
        use std::os::unix::fs::symlink;
        let (lib, _cfg, holder) = lib();
        std::fs::create_dir_all(holder.path().join("parent").join("ws")).unwrap();
        let row = lib
            .register_workspace(&holder.path().join("parent").join("ws"))
            .unwrap();
        let _open = lib.open_workspace(&row.root_path).unwrap();
        let elsewhere = TempDir::new().unwrap();
        std::fs::create_dir_all(elsewhere.path().join("ws")).unwrap();
        let link = row.root_path.parent().unwrap();
        std::fs::rename(link, holder.path().join("moved")).unwrap();
        symlink(elsewhere.path(), link).unwrap();

        let err = lib
            .unregister_workspace_row(&row.root_path, &row.root_path)
            .unwrap_err();

        assert!(
            matches!(err, ChanError::WorkspaceAlreadyOpen),
            "a live handle of the row did not refuse as already open: {err:?}"
        );
        assert_eq!(lib.list_workspaces().len(), 1, "the refused row went");
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
    fn transfer_cap_is_immutable_for_library_and_all_workspace_construction() {
        let cfg = TempDir::new().unwrap();
        let config_path = cfg.path().join("config.toml");
        let initial = 8 * 1024 * 1024;
        let reloaded = 16 * 1024 * 1024;
        std::fs::write(
            &config_path,
            format!("workspaces = []\n[transfer]\nmax_bytes = {initial}\n"),
        )
        .unwrap();
        let lib = Library::open_at(config_path.clone()).unwrap();
        assert_eq!(lib.transfer_max_bytes(), initial);

        let first_root = TempDir::new().unwrap();
        lib.register_workspace(first_root.path()).unwrap();
        let first = lib.open_workspace(first_root.path()).unwrap();
        assert_eq!(first.transfer_max_bytes(), initial);

        std::fs::write(
            &config_path,
            format!("workspaces = []\n[transfer]\nmax_bytes = {reloaded}\n"),
        )
        .unwrap();
        lib.reload_registry().unwrap();
        assert_eq!(
            lib.transfer_max_bytes(),
            initial,
            "a live Library keeps the cap derived when it opened"
        );

        let second_root = TempDir::new().unwrap();
        lib.register_workspace(second_root.path()).unwrap();
        let second = lib.open_workspace(second_root.path()).unwrap();
        assert_eq!(second.transfer_max_bytes(), initial);
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
        populate_state_with(lib, root, |_| {});
    }

    fn populate_state_with(lib: &Library, root: &Path, opened: impl FnOnce(&Arc<Workspace>)) {
        let workspace = lib.open_workspace(root).unwrap();
        opened(&workspace);
        workspace.stop_open_recovery();
        workspace
            .write_text("notes/keep.md", "kept across reset")
            .unwrap();
        workspace.reindex(None).unwrap();
        workspace.put_session("win-1", b"layout").unwrap();
        let p = workspace.paths();
        std::fs::create_dir_all(&p.tokens).unwrap();
        std::fs::write(p.tokens.join("server.token"), b"deadbeef").unwrap();
    }

    #[test]
    fn populate_state_joins_startup_recovery_before_returning() {
        let (lib, _cfg, root) = lib();
        lib.register_workspace(root.path()).unwrap();
        let paths = paths_of(&lib, root.path());
        std::fs::create_dir_all(&paths.graph_dir).unwrap();
        std::fs::write(paths.graph_dir.join("rebuild.inprogress"), b"").unwrap();
        let (reached, _release) =
            crate::workspace::arm_open_recovery_pause_for_test(root.path().canonicalize().unwrap());
        let mut weak = None;
        populate_state_with(&lib, root.path(), |workspace| {
            reached
                .recv_timeout(std::time::Duration::from_secs(20))
                .expect("startup recovery did not reach the preclaim pause");
            assert_eq!(
                workspace.recovery_status().pending.unwrap().action,
                crate::workspace::RecoveryAction::FullRebuild
            );
            assert!(workspace.recovery_worker_running_for_test());
            weak = Some(Arc::downgrade(workspace));
        });

        let retained = weak.unwrap().upgrade();
        let worker_owns_handle = retained.is_some();
        if let Some(workspace) = retained {
            workspace.stop_open_recovery();
        }
        assert!(
            !worker_owns_handle,
            "populate_state returned while startup recovery still owned the handle"
        );

        let reopened = lib.open_workspace(root.path()).unwrap();
        reopened.stop_open_recovery();
        reopened.reindex(None).unwrap();
        assert!(reopened.recovery_status().is_ready());
        assert!(reopened
            .list_tree()
            .unwrap()
            .iter()
            .any(|entry| entry.path == "notes/keep.md"));
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

    #[test]
    fn sweep_orphans_uses_the_injected_library_home() {
        let cfg = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let lib = Library::open_at(cfg.path().join("config.toml")).unwrap();
        let known = lib.register_workspace(workspace.path()).unwrap();
        let parent = cfg.path().join("workspaces");
        let orphan_key = "-tmp-orphan-01234567";

        std::fs::write(parent.join(&known.metadata_key).join("keep"), b"keep").unwrap();
        std::fs::create_dir_all(parent.join(orphan_key)).unwrap();
        std::fs::write(parent.join(orphan_key).join("junk"), b"junk").unwrap();
        let file = parent.join("not-a-dir");
        std::fs::write(&file, b"keep").unwrap();

        let report = lib.sweep_orphans().unwrap();
        assert_eq!(report.removed_metadata_keys, vec![orphan_key.to_string()]);
        assert!(report.removed_entries >= 1);
        assert!(
            parent.join(&known.metadata_key).exists(),
            "known metadata root must survive"
        );
        assert!(
            !parent.join(orphan_key).exists(),
            "orphan metadata root must be gone"
        );
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
        // The fixture owns recovery because it has no retry driver.
        {
            let d = lib.open_workspace(workspace.path()).unwrap();
            d.stop_open_recovery();
            d.reindex(None).unwrap();
            let entries = d.list_tree().unwrap();
            assert!(entries.iter().any(|e| e.path == "notes/keep.md"));
            assert!(
                d.recovery_status().is_ready(),
                "fixture recovery not ready: root={} status={:?} worker_running={} unowned={} observation={:?}; state samples are separate",
                d.root().display(),
                d.recovery_status(),
                d.recovery_worker_running_for_test(),
                d.recovery_is_unowned(),
                d.recovery_observation_for_test()
            );
            let opts = crate::workspace::SearchOpts {
                mode: crate::SearchMode::Bm25,
                limit: 10,
                scope: None,
            };
            let hits = d.search("kept", &opts).unwrap();
            assert!(hits.hits.iter().any(|hit| hit.path == "notes/keep.md"));
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

    /// A registered root that moved under a symlink keeps its row through
    /// the Library's lookups, whose alias matching runs without the
    /// registry's mutex.
    #[cfg(unix)]
    #[test]
    fn a_relinked_root_keeps_its_row() {
        use std::os::unix::fs::symlink;
        let (lib, _cfg, holder) = lib();
        let parent = holder.path().join("parent");
        std::fs::create_dir_all(parent.join("ws")).unwrap();
        let first = lib.register_workspace(&parent.join("ws")).unwrap();

        let moved = holder.path().join("moved");
        std::fs::rename(&parent, &moved).unwrap();
        symlink(&moved, &parent).unwrap();
        let relinked = moved.join("ws");

        assert!(
            lib.workspace_paths_for(&relinked).is_some(),
            "a lookup missed the relinked root"
        );
        let again = lib.register_workspace(&relinked).unwrap();
        assert_eq!(again.metadata_key, first.metadata_key);
        assert_eq!(
            lib.list_workspaces().len(),
            1,
            "the relinked root was registered a second time"
        );
    }

    /// Unregistering a root looks it up in the registry once. A relinked
    /// root's row is found only by re-resolving the other rows' roots, and
    /// beside a registered root that does not answer that lookup waits out
    /// the alias probe's budget, so the unregister waits that budget once,
    /// not once for each registry step it takes.
    #[cfg(unix)]
    #[test]
    fn unregistering_a_relinked_root_beside_a_stalled_one_waits_one_lookup() {
        use std::os::unix::fs::symlink;
        const BUDGET: std::time::Duration = std::time::Duration::from_secs(1);
        let (lib, _cfg, holder) = lib();
        let hung = TempDir::new().unwrap();
        let parent = holder.path().join("parent");
        std::fs::create_dir_all(parent.join("ws")).unwrap();
        let row = lib.register_workspace(&parent.join("ws")).unwrap();
        lib.register_workspace(hung.path()).unwrap();
        let p = lib.workspace_paths_for_row(&row);
        std::fs::create_dir_all(&p.index).unwrap();
        std::fs::write(p.index.join("kept"), b"state").unwrap();

        let moved = holder.path().join("moved");
        std::fs::rename(&parent, &moved).unwrap();
        symlink(&moved, &parent).unwrap();
        let relinked = moved.join("ws");

        let stall = crate::paths::root_stall::stall(hung.path());
        let started = std::time::Instant::now();
        let removed = crate::registry::with_alias_probe_budget(BUDGET, || {
            lib.unregister_workspace(&relinked)
        })
        .expect("unregister the relinked root");
        let waited = started.elapsed();
        assert!(removed, "the relinked root's row was not found");
        assert!(
            waited >= BUDGET,
            "fixture: the lookup did not wait on the stalled root: {waited:?}"
        );
        assert!(
            waited < BUDGET * 2,
            "the unregister waited on the stalled root more than once: {waited:?}"
        );
        assert!(
            lib.list_workspaces()
                .iter()
                .all(|kept| kept.root_path != row.root_path),
            "the relinked root's row is still registered"
        );
        assert!(!p.index.exists(), "the relinked root's state was not wiped");
        drop(stall);
    }

    /// A reset that drops its row drops the row whose state it wiped and no
    /// other. A registration can land between the reset's lookup and its
    /// removal, and when the relinked row's root does not answer that
    /// registration's alias probe in time it appends a row of its own for
    /// the same directory, under the canonical path the reset matched. That
    /// row keeps its registration: its state was not wiped.
    #[cfg(unix)]
    #[test]
    fn a_reset_keeps_a_row_registered_under_its_match_since_its_lookup() {
        use std::os::unix::fs::symlink;
        // Registers `root` once, from the reset's first progress event:
        // after the reset's lookup and before its registry removal.
        struct RegisterDuringTheWipe {
            lib: Library,
            stored: PathBuf,
            root: PathBuf,
            registered: std::sync::Mutex<Option<KnownWorkspace>>,
        }
        impl crate::progress::ProgressCallback for RegisterDuringTheWipe {
            fn on_progress(&self, _: crate::progress::ProgressEvent) {
                let mut registered = self.registered.lock().unwrap();
                if registered.is_some() {
                    return;
                }
                // The registration's own lookup of its root goes through;
                // the probe of the relinked row's root after it is held past
                // the probe's budget.
                let stall = crate::paths::root_stall::stall_after(&self.stored, 1);
                let row = crate::registry::with_alias_probe_budget(
                    std::time::Duration::from_millis(50),
                    || self.lib.register_workspace(&self.root),
                )
                .expect("fixture: register during the wipe");
                assert!(
                    stall.wait_entered(std::time::Duration::from_secs(10)),
                    "fixture: the registration's alias probe never reached the stall"
                );
                *registered = Some(row);
            }
        }
        let (lib, _cfg, holder) = lib();
        let parent = holder.path().join("parent");
        std::fs::create_dir_all(parent.join("ws")).unwrap();
        let row = lib.register_workspace(&parent.join("ws")).unwrap();
        let moved = holder.path().join("moved");
        std::fs::rename(&parent, &moved).unwrap();
        symlink(&moved, &parent).unwrap();
        let relinked = std::fs::canonicalize(moved.join("ws")).unwrap();

        let during = RegisterDuringTheWipe {
            lib: lib.clone(),
            stored: row.root_path.clone(),
            root: relinked.clone(),
            registered: std::sync::Mutex::new(None),
        };
        lib.reset_workspace_with(&relinked, ResetMode::Everything, &during)
            .expect("reset the relinked root");
        let later = during
            .registered
            .lock()
            .unwrap()
            .take()
            .expect("fixture: the reset reported no progress");
        assert_ne!(
            later.metadata_key, row.metadata_key,
            "fixture: the registration found the relinked row"
        );
        let kept: Vec<String> = lib
            .list_workspaces()
            .into_iter()
            .map(|kept| kept.metadata_key)
            .collect();
        assert!(
            !kept.contains(&row.metadata_key),
            "the reset kept the row whose state it wiped"
        );
        assert!(
            kept.contains(&later.metadata_key),
            "the reset removed a row registered since its lookup, whose state it did not wipe"
        );
    }

    /// Registers `parent/ws` under `holder`, moves `parent` away and leaves
    /// a link at its old path, so the row's stored root resolves into
    /// `moved/ws`. Answers the row and that directory's canonical path.
    #[cfg(unix)]
    fn relinked_row(lib: &Library, holder: &Path) -> (KnownWorkspace, PathBuf) {
        use std::os::unix::fs::symlink;
        let parent = holder.join("parent");
        std::fs::create_dir_all(parent.join("ws")).unwrap();
        let row = lib.register_workspace(&parent.join("ws")).unwrap();
        let moved = holder.join("moved");
        std::fs::rename(&parent, &moved).unwrap();
        symlink(&moved, &parent).unwrap();
        let relinked = std::fs::canonicalize(moved.join("ws")).unwrap();
        (row, relinked)
    }

    /// Registers `root` while the alias probe of `stored` is held past the
    /// probe's budget: the registration's own lookup of its root goes
    /// through, and the probe after it has not answered when the
    /// registration ends. The probe is let go before this returns.
    fn register_beside_a_held_probe(lib: &Library, stored: &Path, root: &Path) -> KnownWorkspace {
        let resolves_above =
            std::fs::canonicalize(stored).is_ok_and(|resolved| root.starts_with(resolved));
        let passes = usize::from(root.starts_with(stored) || resolves_above);
        let stall = crate::paths::root_stall::stall_after(stored, passes);
        let row =
            crate::registry::with_alias_probe_budget(std::time::Duration::from_millis(50), || {
                lib.register_workspace(root)
            })
            .expect("fixture: register beside the held probe");
        assert!(
            stall.wait_entered(std::time::Duration::from_secs(10)),
            "fixture: the registration's alias probe never reached the stall"
        );
        row
    }

    /// Writes a file among the session blobs of `row`, part of the state an
    /// unregister wipes, and answers its path.
    #[cfg(unix)]
    fn state_file(lib: &Library, row: &KnownWorkspace) -> PathBuf {
        let sessions = lib.workspace_paths_for_row(row).sessions;
        std::fs::create_dir_all(&sessions).unwrap();
        let file = sessions.join("kept");
        std::fs::write(&file, b"state").unwrap();
        file
    }

    /// A row a registration appended while the alias probe of a relinked
    /// row's root had not answered is dropped by a later registration, once
    /// that root answers into the appended row's directory: the directory
    /// keeps one row, the relinked one with its state, and the appended
    /// row's state is wiped. What the registration learned of the unanswered
    /// root outlives a reload of the registry.
    #[cfg(unix)]
    #[test]
    fn a_row_appended_beside_an_unanswered_probe_is_dropped_once_its_root_answers() {
        let (lib, _cfg, holder) = lib();
        let (row, relinked) = relinked_row(&lib, holder.path());
        let appended = register_beside_a_held_probe(&lib, &row.root_path, &relinked);
        assert_ne!(
            appended.metadata_key, row.metadata_key,
            "fixture: the registration found the relinked row"
        );
        assert_eq!(
            lib.list_workspaces().len(),
            2,
            "fixture: the registration beside the held probe appended no row"
        );
        let kept = state_file(&lib, &row);
        let wiped = state_file(&lib, &appended);

        lib.reload_registry().expect("reload the registry");
        // The root answers at once; the budget only has to outlast a slow
        // start of the probe's thread.
        let answered =
            crate::registry::with_alias_probe_budget(std::time::Duration::from_secs(30), || {
                lib.register_workspace(&relinked)
            })
            .expect("register the directory again");

        let rows = lib.list_workspaces();
        assert_eq!(
            rows.len(),
            1,
            "a row appended beside an unanswered probe outlived its root's answer: {rows:#?}"
        );
        assert_eq!(
            answered.metadata_key, row.metadata_key,
            "the registration answered a row other than the relinked one"
        );
        assert!(kept.exists(), "the relinked row's state was wiped");
        assert!(!wiped.exists(), "the dropped row's state was kept");
    }

    /// A row appended beside an unanswered probe is not dropped while this
    /// process holds its workspace open: a registration answers it, both
    /// rows stay and its state is whole. The first registration after the
    /// handle is let go drops it.
    #[cfg(unix)]
    #[test]
    fn a_row_appended_beside_an_unanswered_probe_is_kept_while_it_is_held_open() {
        const ANSWERS: std::time::Duration = std::time::Duration::from_secs(30);
        let (lib, _cfg, holder) = lib();
        let (row, relinked) = relinked_row(&lib, holder.path());
        let appended = register_beside_a_held_probe(&lib, &row.root_path, &relinked);
        let open = lib
            .open_workspace(&relinked)
            .expect("fixture: open the appended row");
        assert_eq!(
            open.metadata_key(),
            appended.metadata_key,
            "fixture: the open took a row other than the appended one"
        );
        let state = state_file(&lib, &appended);

        let beside =
            crate::registry::with_alias_probe_budget(ANSWERS, || lib.register_workspace(&relinked))
                .expect("register beside the open handle");
        let rows_beside = lib.list_workspaces().len();
        let state_beside = state.exists();

        let handle = Arc::downgrade(&open);
        drop(open);
        let lock_dir = lib.workspace_paths_for_row(&appended).lock;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while handle.strong_count() > 0 || !crate::lock::is_free(&lock_dir) {
            assert!(
                std::time::Instant::now() < deadline,
                "fixture: the appended row's workspace was not let go"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let after =
            crate::registry::with_alias_probe_budget(ANSWERS, || lib.register_workspace(&relinked))
                .expect("register once the handle is let go");
        let rows = lib.list_workspaces();

        assert_eq!(
            beside.metadata_key, appended.metadata_key,
            "a registration beside a held appended row answered another row"
        );
        assert_eq!(
            rows_beside, 2,
            "an appended row was dropped while this process held it open"
        );
        assert!(
            state_beside,
            "an appended row's state was wiped while this process held it open"
        );
        assert_eq!(
            rows.len(),
            1,
            "an appended row outlived the handle that held it: {rows:#?}"
        );
        assert_eq!(
            after.metadata_key, row.metadata_key,
            "the registration after the handle answered a row other than the relinked one"
        );
        assert!(!state.exists(), "the dropped row's state was kept");
    }

    /// What a registration learned of an unanswered root ends, with no row
    /// dropped, once that root answers into a directory of its own: a later
    /// registration of the row appended beside it asks that root nothing,
    /// and finishes beside the root's stall without entering it.
    #[test]
    fn a_registration_asks_no_root_that_answered_into_another_directory() {
        const BOUND: std::time::Duration = std::time::Duration::from_secs(30);
        let (lib, _cfg, first) = lib();
        let second = TempDir::new().unwrap();
        let stored = lib.register_workspace(first.path()).unwrap().root_path;
        let root = std::fs::canonicalize(second.path()).unwrap();
        register_beside_a_held_probe(&lib, &stored, &root);

        crate::registry::with_alias_probe_budget(BOUND, || lib.register_workspace(&root))
            .expect("register beside the root that answers");
        assert_eq!(
            lib.list_workspaces().len(),
            2,
            "a registration dropped a row beside a root that answered into another directory"
        );

        let stall = crate::paths::root_stall::stall(&stored);
        let registering = lib.clone();
        stall
            .finishes_beside(
                "a registration of a row beside a root that had answered",
                BOUND,
                move || {
                    crate::registry::with_alias_probe_budget(
                        std::time::Duration::from_millis(50),
                        || registering.register_workspace(&root),
                    )
                },
            )
            .expect("register beside the stall");
        let entered = stall.entered();
        assert!(
            entered.is_empty(),
            "a registration asked a root that had answered into another directory: {entered:#?}"
        );
        assert_eq!(lib.list_workspaces().len(), 2);
    }

    /// A test that holds one named step of an open holds that step's call in
    /// every build profile, a release build's stripped symbols included.
    #[test]
    fn a_named_step_is_held_in_any_profile() {
        let (lib, _cfg, root) = lib();
        let stored = lib.register_workspace(root.path()).unwrap().root_path;
        let stall = crate::paths::root_stall::stall_matching(
            &stored,
            &[crate::paths::root_stall::OPEN_WORKSPACE],
        );
        let opening = lib.clone();
        let opened_root = stored.clone();
        let open = std::thread::spawn(move || opening.open_workspace(&opened_root).map(|_| ()));
        let held = stall.wait_entered(std::time::Duration::from_secs(10));
        let entered = stall.entered();
        let passed = stall.passed();
        drop(stall);
        open.join()
            .expect("open thread")
            .expect("the open once released");
        assert!(
            held,
            "the seam held nothing: {passed} calls under the root went through"
        );
        assert!(
            entered
                .iter()
                .all(|call| call.contains("Library::open_workspace")),
            "a held call is not the open's: {entered:#?}"
        );
    }

    /// While one registered root hangs, registering a new root does not hold
    /// the registry. The registration's wait on the hung root is stretched past
    /// this test's bound, so a lookup of another registered root and the reload
    /// a registry watcher runs answer within the bound only when the
    /// registration waits without the registry's mutex. The registration
    /// finishes once the hung root answers.
    #[test]
    fn a_hung_root_does_not_hold_the_registry() {
        const BOUND: std::time::Duration = std::time::Duration::from_secs(30);
        let (lib, _cfg, registered) = lib();
        let hung = TempDir::new().unwrap();
        let fresh = TempDir::new().unwrap();
        lib.register_workspace(registered.path()).unwrap();
        lib.register_workspace(hung.path()).unwrap();

        let stall = crate::paths::root_stall::stall(hung.path());
        let registering = lib.clone();
        let fresh_root = fresh.path().to_path_buf();
        let (registered_tx, registration) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let outcome = crate::registry::with_alias_probe_budget(
                std::time::Duration::from_secs(3600),
                || registering.register_workspace(&fresh_root),
            );
            let _ = registered_tx.send(outcome);
        });
        assert!(
            stall.wait_entered(std::time::Duration::from_secs(10)),
            "fixture: registering a new root never consulted the hung root"
        );

        let looking = lib.clone();
        let registered_root = registered.path().to_path_buf();
        let found = stall.finishes_beside(
            "a lookup of a registered root while a new root registers",
            BOUND,
            move || looking.workspace_paths_for(&registered_root),
        );
        assert!(found.is_some(), "the registered root was not found");
        let reloading = lib.clone();
        stall
            .finishes_beside("a registry reload", BOUND, move || {
                reloading.reload_registry()
            })
            .expect("reload");

        drop(stall);
        registration
            .recv_timeout(BOUND)
            .expect("the registration finishes once the hung root answers")
            .expect("register the new root");
        assert_eq!(lib.list_workspaces().len(), 3);
    }

    /// A registration of a folder whose row an unregister is removing answers
    /// that the workspace is still releasing and changes nothing. The
    /// unregister, held here before its wipe, drops the row once it goes on,
    /// so a registration that answered that row would hand its caller one the
    /// registry then loses. Once the unregister has ended, the same
    /// registration makes a row of its own.
    #[test]
    fn a_registration_beside_an_unregister_of_its_row_answers_retry() {
        const BOUND: std::time::Duration = std::time::Duration::from_secs(30);
        let (lib, _cfg, root) = lib();
        let stored = lib.register_workspace(root.path()).unwrap().root_path;
        let stall = crate::paths::root_stall::stall_matching(
            &stored,
            &[crate::paths::root_stall::UNREGISTER_WORKSPACE],
        );
        let unregistering = lib.clone();
        let removed_root = stored.clone();
        let unregister = std::thread::spawn(move || {
            unregistering.unregister_workspace_row(&removed_root, &removed_root)
        });
        assert!(
            stall.wait_entered(BOUND),
            "fixture: the unregister never asked its holder's root"
        );

        let beside = lib.register_workspace(root.path());

        drop(stall);
        let removed = unregister
            .join()
            .expect("unregister thread")
            .expect("the unregister once released");
        assert!(removed, "fixture: the unregister found no row to remove");
        assert!(
            matches!(beside, Err(ChanError::WorkspaceAlreadyOpen)),
            "a registration beside an unregister of its row answered {beside:?}, \
             and the registry then holds {} rows",
            lib.list_workspaces().len()
        );

        let fresh = lib
            .register_workspace(root.path())
            .expect("a registration once the unregister has ended");
        assert_eq!(fresh.root_path, stored);
        assert_eq!(lib.list_workspaces().len(), 1);
        assert!(
            paths_of(&lib, root.path()).sessions.is_dir(),
            "the fresh registration has no metadata directories"
        );
    }

    fn admitted<T>(admission: WorkspaceAdmission<T>) -> T {
        match admission {
            WorkspaceAdmission::Admitted(held) => held,
            WorkspaceAdmission::Conflict => panic!("fixture: the hold was refused"),
        }
    }

    /// Claim the row that stores `stored`, asking for `keys`.
    fn claim_of(
        lib: &Library,
        stored: &Path,
        keys: &[PathBuf],
    ) -> WorkspaceAdmission<Option<WorkspaceClaim>> {
        lib.claim_row(RowSelection {
            given: stored,
            opened_at: None,
            keys,
        })
    }

    /// While a claim holds a row, every operation of the library that names
    /// the row answers that it is still releasing and changes nothing, a
    /// second claim included, and a clone of the claim keeps the hold.
    #[test]
    fn a_claimed_row_refuses_every_operation_that_names_it() {
        let (lib, _cfg, root) = lib();
        let elsewhere = TempDir::new().unwrap();
        let row = lib.register_workspace(root.path()).unwrap();
        let claim = admitted(claim_of(&lib, &row.root_path, &[])).expect("the registered row");
        assert_eq!(claim.row(), Some(&row));

        let refusals = [
            ("register", lib.register_workspace(root.path()).err()),
            ("open", lib.open_workspace(root.path()).map(|_| ()).err()),
            (
                "move",
                lib.move_workspace(root.path(), elsewhere.path()).err(),
            ),
            (
                "reset of state",
                lib.reset_workspace(root.path(), ResetMode::State).err(),
            ),
            (
                "reset of everything",
                lib.reset_workspace(root.path(), ResetMode::Everything)
                    .err(),
            ),
            (
                "unregister by path",
                lib.unregister_workspace(root.path()).err(),
            ),
            (
                "unregister by row",
                lib.unregister_workspace_row(&row.root_path, &row.root_path)
                    .err(),
            ),
        ];
        for (operation, refusal) in refusals {
            assert!(
                matches!(refusal, Some(ChanError::WorkspaceAlreadyOpen)),
                "{operation} of a claimed row answered {refusal:?}"
            );
        }
        assert!(
            matches!(
                claim_of(&lib, &row.root_path, &[]),
                WorkspaceAdmission::Conflict
            ),
            "a second claim of a claimed row was admitted"
        );
        assert_eq!(
            lib.list_workspaces(),
            vec![row.clone()],
            "a refused operation changed the claimed row"
        );

        let shared = claim.clone();
        drop(claim);
        assert!(
            matches!(
                lib.register_workspace(root.path()),
                Err(ChanError::WorkspaceAlreadyOpen)
            ),
            "the hold ended while a clone of the claim lived"
        );
        drop(shared);
        lib.register_workspace(root.path())
            .expect("a registration once every clone of the claim has dropped");
        lib.open_workspace(root.path())
            .expect("an open once the claim has dropped")
            .stop_open_recovery();
    }

    /// A claim holds the paths it is given beside its row's own: a folder
    /// whose canonical path is one of them does not register, a folder it
    /// does not name does, and of further paths it takes the ones no other
    /// row goes by and leaves the others to their rows.
    #[test]
    fn a_claim_holds_the_paths_it_is_given() {
        let (lib, _cfg, root) = lib();
        let named = TempDir::new().unwrap();
        let unnamed = TempDir::new().unwrap();
        let later = TempDir::new().unwrap();
        let row = lib.register_workspace(root.path()).unwrap();
        let named_key = canonical_form(named.path());
        let claim =
            admitted(claim_of(&lib, &row.root_path, &[named_key])).expect("the registered row");

        assert!(
            matches!(
                lib.register_workspace(named.path()),
                Err(ChanError::WorkspaceAlreadyOpen)
            ),
            "a folder at a claimed path registered"
        );
        assert_eq!(lib.list_workspaces().len(), 1);
        let beside = lib
            .register_workspace(unnamed.path())
            .expect("a folder the claim does not name registers beside it");

        assert!(
            matches!(
                claim.extend(std::slice::from_ref(&beside.root_path)),
                WorkspaceAdmission::Admitted(())
            ),
            "a path another row goes by refused the claim"
        );
        assert!(
            !claim.keys().contains(&beside.root_path),
            "a claim took a path another row goes by"
        );
        lib.register_workspace(unnamed.path())
            .expect("a row the claim was not given registers again beside it");
        assert!(
            matches!(
                claim.extend(&[canonical_form(later.path())]),
                WorkspaceAdmission::Admitted(())
            ),
            "a claim was refused a path nothing goes by"
        );
        assert!(
            matches!(
                lib.register_workspace(later.path()),
                Err(ChanError::WorkspaceAlreadyOpen)
            ),
            "a folder at a path the claim took later registered"
        );

        drop(claim);
        lib.register_workspace(named.path())
            .expect("the named folder once the claim has dropped");
        lib.register_workspace(later.path())
            .expect("the later folder once the claim has dropped");
        assert_eq!(lib.list_workspaces().len(), 4);
    }

    /// A claim that asks for a path another row goes by is admitted without
    /// it: the path is that row's, and the row stays free.
    #[test]
    fn a_claim_leaves_out_a_path_another_row_goes_by() {
        let (lib, _cfg, root) = lib();
        let other = TempDir::new().unwrap();
        let row = lib.register_workspace(root.path()).unwrap();
        let other_row = lib.register_workspace(other.path()).unwrap();

        let claim = admitted(claim_of(
            &lib,
            &row.root_path,
            std::slice::from_ref(&other_row.root_path),
        ))
        .expect("the registered row");
        assert_eq!(
            claim.keys(),
            vec![row.root_path.clone()],
            "a claim holds more than its row's own root"
        );
        lib.register_workspace(other.path())
            .expect("the other row is not held by a claim of this one");
        lib.open_workspace(other.path())
            .expect("the other row opens beside a claim of this one")
            .stop_open_recovery();
        drop(claim);
    }

    /// A selection names the row that stores the path given; with none, the
    /// row that stores the root a mounted workspace was opened at; with
    /// neither, the first row that goes by one of the paths asked; and with
    /// none of those, no row, and nothing is claimed.
    #[test]
    fn a_selection_names_its_row_by_three_rules_in_order() {
        let (lib, _cfg, root) = lib();
        let other = TempDir::new().unwrap();
        let unregistered = TempDir::new().unwrap();
        let row = lib.register_workspace(root.path()).unwrap();
        let other_row = lib.register_workspace(other.path()).unwrap();
        let nowhere = canonical_form(unregistered.path());
        let named = |selection: RowSelection<'_>| {
            admitted(lib.claim_row(selection)).map(|claim| claim.row().cloned().unwrap().root_path)
        };

        assert_eq!(
            named(RowSelection {
                given: &row.root_path,
                opened_at: Some(&other_row.root_path),
                keys: std::slice::from_ref(&other_row.root_path),
            }),
            Some(row.root_path.clone()),
            "the row that stores the path given was not the row named"
        );
        assert_eq!(
            named(RowSelection {
                given: &nowhere,
                opened_at: Some(&other_row.root_path),
                keys: std::slice::from_ref(&row.root_path),
            }),
            Some(other_row.root_path.clone()),
            "the row a mounted workspace was opened at was not the row named"
        );
        assert_eq!(
            named(RowSelection {
                given: &nowhere,
                opened_at: None,
                keys: std::slice::from_ref(&other_row.root_path),
            }),
            Some(other_row.root_path.clone()),
            "the row that goes by a path asked was not the row named"
        );
        assert_eq!(
            named(RowSelection {
                given: &nowhere,
                opened_at: None,
                keys: std::slice::from_ref(&nowhere),
            }),
            None,
            "a selection that names no row claimed one"
        );
    }

    /// Two rows where one still records having resolved to the folder the
    /// other stores: `stale` stores a root that was pointed at `folder`, was
    /// registered there, and was then pointed elsewhere, and another
    /// process registered `folder` as a row of its own, `owner`.
    #[cfg(unix)]
    struct StaleCache {
        lib: Library,
        /// The row whose record of `folder` is stale.
        stale: KnownWorkspace,
        /// The row that stores `folder`.
        owner: KnownWorkspace,
        folder: PathBuf,
        /// Where `stale`'s root resolves now.
        elsewhere: PathBuf,
        _dirs: (TempDir, TempDir),
    }

    #[cfg(unix)]
    impl StaleCache {
        fn new() -> Self {
            use std::os::unix::fs::symlink;
            let cfg = TempDir::new().unwrap();
            let holder = TempDir::new().unwrap();
            let config_path = cfg.path().join("config.toml");
            let lib = Library::open_at(config_path.clone()).unwrap();
            for parent in ["first", "second", "third"] {
                std::fs::create_dir_all(holder.path().join(parent).join("ws")).unwrap();
            }
            let stored = lib
                .register_workspace(&holder.path().join("first").join("ws"))
                .unwrap()
                .root_path;
            // Point the stored root at the second folder, and register
            // through it, so the row records that folder.
            std::fs::rename(holder.path().join("first"), holder.path().join("gone")).unwrap();
            symlink(holder.path().join("second"), holder.path().join("first")).unwrap();
            let folder = canonical_form(&holder.path().join("second").join("ws"));
            let landed = lib.register_workspace(&stored).unwrap();
            assert_eq!(
                landed.root_path, stored,
                "fixture: the relinked root made a row"
            );
            assert_eq!(landed.cached_canonical_path(), folder);
            // Point the stored root elsewhere, and let another process
            // register the second folder: it finds no row for it.
            std::fs::remove_file(holder.path().join("first")).unwrap();
            symlink(holder.path().join("third"), holder.path().join("first")).unwrap();
            let elsewhere = canonical_form(&holder.path().join("third").join("ws"));
            let other_process = Library::open_at(config_path).unwrap();
            let owner = other_process.register_workspace(&folder).unwrap();
            assert_eq!(
                owner.root_path, folder,
                "fixture: the folder got no row of its own"
            );
            lib.reload_registry().unwrap();
            let rows = lib.list_workspaces();
            assert_eq!(rows.len(), 2, "fixture: the registry holds {rows:?}");
            let stale = rows
                .iter()
                .find(|row| row.root_path == stored)
                .cloned()
                .expect("fixture: the relinked row");
            assert_eq!(
                stale.cached_canonical_path(),
                folder,
                "fixture: the reload dropped the stale record"
            );
            Self {
                lib,
                stale,
                owner,
                folder,
                elsewhere,
                _dirs: (cfg, holder),
            }
        }

        /// A file in the state of `row`, which its unregister wipes.
        fn sentinel(&self, row: &KnownWorkspace) -> PathBuf {
            let sessions = self.lib.workspace_paths_for_row(row).sessions;
            std::fs::create_dir_all(&sessions).unwrap();
            let file = sessions.join("kept");
            std::fs::write(&file, b"state").unwrap();
            file
        }

        fn stored_roots(&self) -> Vec<PathBuf> {
            let mut roots: Vec<PathBuf> = self
                .lib
                .list_workspaces()
                .into_iter()
                .map(|row| row.root_path)
                .collect();
            roots.sort();
            roots
        }
    }

    /// A row is claimed and removed by the root it stores although another
    /// row still records having resolved to that root: the record is that
    /// row's stale hint, and the other row and its state stay.
    #[cfg(unix)]
    #[test]
    fn a_row_is_removed_by_its_stored_root_beside_another_rows_stale_record() {
        let state = StaleCache::new();
        let kept = state.sentinel(&state.stale);
        let wiped = state.sentinel(&state.owner);

        let claim = admitted(claim_of(
            &state.lib,
            &state.folder,
            std::slice::from_ref(&state.folder),
        ))
        .expect("the row that stores the folder");
        assert_eq!(claim.row(), Some(&state.owner));
        assert_eq!(claim.keys(), vec![state.folder.clone()]);
        assert!(claim.unregister(&state.folder).expect("unregister"));
        drop(claim);

        assert_eq!(state.stored_roots(), vec![state.stale.root_path.clone()]);
        assert!(!wiped.exists(), "the removed row's state was left");
        assert!(kept.is_file(), "the other row's state was wiped");
    }

    /// A row whose record of the folder it last resolved to is stale is
    /// claimed and removed without that folder, which another row stores:
    /// the claim holds the row's own root and where it resolves now, and
    /// the other row and its state stay.
    #[cfg(unix)]
    #[test]
    fn a_row_with_a_stale_record_is_removed_without_the_folder_another_row_stores() {
        let state = StaleCache::new();
        let wiped = state.sentinel(&state.stale);
        let kept = state.sentinel(&state.owner);

        let claim = admitted(claim_of(
            &state.lib,
            &state.stale.root_path,
            std::slice::from_ref(&state.elsewhere),
        ))
        .expect("the row with the stale record");
        assert_eq!(claim.row(), Some(&state.stale));
        assert_eq!(
            claim.keys(),
            vec![state.stale.root_path.clone(), state.elsewhere.clone()],
            "the claim holds a folder another row stores, or lacks its own"
        );
        state
            .lib
            .register_workspace(&state.folder)
            .expect("the row that stores the folder registers beside the claim");
        assert!(claim.unregister(&state.elsewhere).expect("unregister"));
        drop(claim);

        assert_eq!(state.stored_roots(), vec![state.folder.clone()]);
        assert!(!wiped.exists(), "the removed row's state was left");
        assert!(kept.is_file(), "the other row's state was wiped");
    }

    /// A claim's unregister wipes the state and drops the row it captured,
    /// and the claim holds the folder until it drops.
    #[test]
    fn a_claims_unregister_wipes_and_drops_the_row_it_captured() {
        let (lib, _cfg, root) = lib();
        let row = lib.register_workspace(root.path()).unwrap();
        let sentinel = paths_of(&lib, root.path()).sessions.join("held");
        std::fs::write(&sentinel, b"state").unwrap();
        let claim = admitted(claim_of(&lib, &row.root_path, &[])).expect("the registered row");

        assert!(claim.unregister(&row.root_path).expect("unregister"));
        assert!(!sentinel.exists(), "the unregister left the row's state");
        assert!(lib.list_workspaces().is_empty());
        assert!(
            matches!(
                lib.register_workspace(root.path()),
                Err(ChanError::WorkspaceAlreadyOpen)
            ),
            "the folder registered again while its removal's claim stood"
        );
        assert!(
            !claim
                .unregister(&row.root_path)
                .expect("a second unregister"),
            "a second unregister found a row"
        );
        drop(claim);
        lib.register_workspace(root.path())
            .expect("the folder once the claim has dropped");
    }

    /// A claim's unregister wipes nothing of a registration another process
    /// made at the claimed root after the claim was taken: it refuses a row
    /// of another creation time, and answers that nothing was removed once
    /// no row stores the root.
    #[test]
    fn a_claims_unregister_leaves_a_row_another_process_put_in_its_place() {
        let cfg = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let config_path = cfg.path().join("config.toml");
        let lib = Library::open_at(config_path.clone()).unwrap();
        let other_process = Library::open_at(config_path).unwrap();
        let row = lib.register_workspace(root.path()).unwrap();
        let claim = admitted(claim_of(&lib, &row.root_path, &[])).expect("the registered row");

        other_process.reload_registry().unwrap();
        let mut replaced = None;
        for _ in 0..1000 {
            assert!(other_process.unregister_workspace(root.path()).unwrap());
            let added = other_process.register_workspace(root.path()).unwrap();
            if added.created_at != row.created_at {
                replaced = Some(added);
                break;
            }
        }
        let replaced = replaced.expect("fixture: the clock never moved between two registrations");
        assert_eq!(replaced.metadata_key, row.metadata_key);
        let sentinel = other_process
            .workspace_paths_for(root.path())
            .unwrap()
            .sessions
            .join("kept");
        std::fs::write(&sentinel, b"state of the later registration").unwrap();
        lib.reload_registry().unwrap();

        let refused = claim.unregister(&row.root_path);
        assert!(
            matches!(refused, Err(ChanError::WorkspaceAlreadyOpen)),
            "a claim's unregister of a replaced row answered {refused:?}"
        );
        assert!(
            sentinel.is_file(),
            "a claim's unregister wiped a registration made after the claim"
        );
        assert_eq!(lib.list_workspaces().len(), 1);

        assert!(other_process.unregister_workspace(root.path()).unwrap());
        lib.reload_registry().unwrap();
        assert!(
            !claim
                .unregister(&row.root_path)
                .expect("a row that is gone"),
            "a claim's unregister answered that it removed a row that was gone"
        );
    }

    /// A claim of a path that no row goes by is admitted only while that
    /// holds, refuses a registration of the folder while it stands, and
    /// unregisters nothing.
    #[test]
    fn a_claim_of_an_unregistered_path_refuses_its_registration() {
        let (lib, _cfg, root) = lib();
        let key = canonical_form(root.path());
        let claim = admitted(lib.claim_unregistered(std::slice::from_ref(&key)));
        assert!(claim.row().is_none());

        assert!(
            matches!(
                lib.register_workspace(root.path()),
                Err(ChanError::WorkspaceAlreadyOpen)
            ),
            "a folder registered while its path was claimed as unregistered"
        );
        assert!(lib.list_workspaces().is_empty());
        assert!(
            matches!(
                lib.claim_unregistered(std::slice::from_ref(&key)),
                WorkspaceAdmission::Conflict
            ),
            "two claims held one path"
        );
        assert!(!claim.unregister(&key).expect("a claim of paths alone"));

        drop(claim);
        lib.register_workspace(root.path())
            .expect("the folder once the claim has dropped");
        assert!(
            matches!(
                lib.claim_unregistered(std::slice::from_ref(&key)),
                WorkspaceAdmission::Conflict
            ),
            "a path a row goes by was claimed as unregistered"
        );
    }

    /// A use and a claim of one row refuse each other, by the row's metadata
    /// key or by a path they share, whichever comes first; two uses stand
    /// together, and a use refuses no registration.
    #[test]
    fn a_use_and_a_claim_of_one_row_refuse_each_other() {
        let (lib, _cfg, root) = lib();
        let row = lib.register_workspace(root.path()).unwrap();
        let by_row = std::slice::from_ref(&row.root_path);

        let used = admitted(lib.use_row(Some(&row.metadata_key), by_row));
        let again = admitted(lib.use_row(None, by_row));
        assert!(
            matches!(
                claim_of(&lib, &row.root_path, &[]),
                WorkspaceAdmission::Conflict
            ),
            "a row in use was claimed"
        );
        lib.register_workspace(root.path())
            .expect("a registration beside a use");
        drop(used);
        assert!(
            matches!(
                claim_of(&lib, &row.root_path, &[]),
                WorkspaceAdmission::Conflict
            ),
            "a row was claimed while one of its two uses stood"
        );
        drop(again);

        let claim = admitted(claim_of(&lib, &row.root_path, &[])).expect("the registered row");
        assert!(
            matches!(
                lib.use_row(Some(&row.metadata_key), &[]),
                WorkspaceAdmission::Conflict
            ),
            "a claimed row was used by its metadata key"
        );
        assert!(
            matches!(
                lib.use_row(Some("another-key"), by_row),
                WorkspaceAdmission::Conflict
            ),
            "a claimed path was used"
        );
        drop(claim);
        drop(admitted(lib.use_row(Some(&row.metadata_key), by_row)));
    }
}
