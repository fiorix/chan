// Workspace registry: the per-machine list of directories the user has
// registered as chan workspaces. Persisted to ~/.chan/config.toml.
//
// This file holds ONLY chan-workspace's own state: the registry of
// known workspaces. Editor preferences (fonts, theme, API keys) are an
// app-level concern and live in a separate file owned by the consuming
// app.

use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::error::{ChanError, Result};
use crate::fs_ops;
use crate::paths;

pub(crate) const DEFAULT_TRANSFER_MAX_BYTES: u64 = 10 * 1024 * 1024 * 1024;
pub(crate) const TRANSFER_MAX_BYTES_CEILING: u64 = 100 * 1024 * 1024 * 1024;

/// Validated global transfer configuration persisted under `[transfer]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct TransferConfig {
    #[serde(default = "default_transfer_max_bytes")]
    pub(crate) max_bytes: u64,
}

impl TransferConfig {
    fn validate(self) -> Result<Self> {
        if self.max_bytes == 0 || self.max_bytes > TRANSFER_MAX_BYTES_CEILING {
            return Err(ChanError::InvalidTransferMaxBytes {
                value: self.max_bytes,
                max: TRANSFER_MAX_BYTES_CEILING,
            });
        }
        Ok(self)
    }
}

impl Default for TransferConfig {
    fn default() -> Self {
        Self {
            max_bytes: default_transfer_max_bytes(),
        }
    }
}

const fn default_transfer_max_bytes() -> u64 {
    DEFAULT_TRANSFER_MAX_BYTES
}

/// Default directory basenames excluded from indexing and graph rebuild walks.
///
/// Stored in `~/.chan/config.toml` as `index_excluded_dirs` so users can
/// add or remove names without rebuilding chan. `.git` and `.chan` are still
/// hard-skipped by the workspace walker as internal invariants.
pub const DEFAULT_INDEX_EXCLUDED_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "__pycache__",
    ".venv",
    "venv",
    ".tox",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".cache",
    "dist",
    "build",
    // Build-system output trees (Buck2's world among them): walked,
    // watched, and indexed at enormous cost, never useful in search or
    // graph. Users can still remove a name via `index_excluded_dirs`.
    "buck-out",
    ".buckos",
    "downloads",
    "distfiles",
    "prebuilt",
    "vendor",
    "prelude",
];

/// The default set as shipped before build-system output trees were
/// added (v0.76.0). `Library::open_at` upgrades a config whose declared
/// list matches this set exactly to the current default, so stock
/// installs pick the new names up; a customized list is always the
/// user's own.
pub(crate) const OLD_DEFAULT_INDEX_EXCLUDED_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "__pycache__",
    ".venv",
    "venv",
    ".tox",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".cache",
    "dist",
    "build",
];

/// True when `declared` matches the pre-v0.76.0 default set exactly
/// (any order, case-insensitive): the list is the stock one and can be
/// upgraded to the current default without overruling a user's edit.
pub(crate) fn index_excluded_dirs_is_stock_default(declared: &[String]) -> bool {
    declared.len() == OLD_DEFAULT_INDEX_EXCLUDED_DIRS.len()
        && declared.iter().all(|name| {
            OLD_DEFAULT_INDEX_EXCLUDED_DIRS
                .iter()
                .any(|old| old.eq_ignore_ascii_case(name))
        })
}

/// On-disk shape of the chan-workspace config TOML.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Registry {
    /// Directory basenames skipped by index and graph rebuild walks.
    /// Matched at any depth by exact basename, case-insensitive.
    #[serde(default = "default_index_excluded_dirs")]
    pub index_excluded_dirs: Vec<String>,
    /// Global bounded-transfer policy. Loaded once into each `Library` so
    /// existing processes keep one effective value until restart.
    #[serde(default)]
    pub(crate) transfer: TransferConfig,
    /// Known workspaces the user has opened on this machine. Sorted
    /// most-recent first by `last_seen_at`.
    #[serde(default)]
    pub workspaces: Vec<KnownWorkspace>,
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            index_excluded_dirs: default_index_excluded_dirs(),
            transfer: TransferConfig::default(),
            workspaces: Vec::new(),
        }
    }
}

fn default_index_excluded_dirs() -> Vec<String> {
    DEFAULT_INDEX_EXCLUDED_DIRS
        .iter()
        .map(|name| (*name).to_owned())
        .collect()
}

/// Current default list as a Vec, for the open-time stock-default
/// upgrade in `Library::open_at`.
pub(crate) fn current_default_index_excluded_dirs() -> Vec<String> {
    default_index_excluded_dirs()
}

/// One entry in the registry.
///
/// `root_path` is the current canonical local workspace path. It is the
/// user-content boundary. `metadata_key` is the stable storage key
/// under `~/.chan/workspaces/`, allocated from the canonical path when
/// the workspace is first registered and preserved across
/// `Library::move_workspace`.
///
/// An optional `display_name` overrides the `root_path` basename a UI would
/// otherwise show; it is set at add-time from the launcher's "Display name"
/// field.
///
/// Two fields live in memory only and are never written: the canonical path
/// the row last resolved to, and the stored roots of other rows that had not
/// answered the alias probe when a registration appended this row. Such a
/// row may name a directory one of those rows already holds; a later
/// registration of it asks them again, and drops it once one of them
/// resolves into its directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnownWorkspace {
    pub root_path: PathBuf,
    /// Stable per-workspace metadata storage key under `~/.chan/workspaces/`.
    pub metadata_key: String,
    pub created_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    /// User-editable label a UI prefers over the `root_path` basename. `None`
    /// keeps the basename. Omitted from `workspaces.toml` when unset
    /// (`skip_serializing_if`) so an entry without a name stays byte-stable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip)]
    pub(crate) canonical_path: Option<PathBuf>,
    /// The stored roots that had not answered the alias probe when this row
    /// was appended and that no registration has heard from since. Empty for
    /// a row a load read: a restart forgets them.
    #[serde(skip)]
    pub(crate) unanswered_roots: Vec<PathBuf>,
}

impl KnownWorkspace {
    /// The canonical path this row last resolved to, without touching the
    /// filesystem: refreshed whenever the row is touched, and `root_path`,
    /// which is written canonical, until then.
    pub fn cached_canonical_path(&self) -> &Path {
        self.canonical_path.as_deref().unwrap_or(&self.root_path)
    }
}

impl Registry {
    /// Load from the default location, falling back to defaults
    /// when the file is absent. A malformed file is an error; we
    /// never silently overwrite a user's edit.
    pub fn load() -> Result<Self> {
        Self::load_from(&paths::global_config_path())
    }

    pub fn load_from(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let raw = std::fs::read_to_string(path)?;
        let value: toml::Value = toml::from_str(&raw).map_err(|e| ChanError::ConfigDecode {
            path: path.to_path_buf(),
            message: e.to_string(),
        })?;
        let retired_drafts_dir = value.get("drafts_dir").is_some();
        let mut reg: Self =
            value
                .try_into()
                .map_err(|e: toml::de::Error| ChanError::ConfigDecode {
                    path: path.to_path_buf(),
                    message: e.to_string(),
                })?;
        if retired_drafts_dir {
            tracing::warn!(
                key = "drafts_dir",
                "ignoring retired config.toml key; workspace drafts live in the per-workspace metadata sidecar Drafts/"
            );
        }
        reg.transfer = reg.transfer.validate()?;
        // Prime the canonical-path cache from the stored root, which
        // `touch` wrote canonical, rather than from the filesystem: a
        // load must not wait on a registered root whose mount has
        // stalled. A row whose root has moved under a symlink since is
        // still found, by the alias probe a lookup runs when no cached
        // path matches. A root an older Windows build stored with the
        // `\\?\` verbatim prefix is normalized here, since `touch`
        // rewrites `root_path` only on insert and every consumer prints
        // it as stored.
        for d in &mut reg.workspaces {
            d.root_path = paths::strip_verbatim_prefix(&d.root_path);
            d.canonical_path = Some(d.root_path.clone());
        }
        Ok(reg)
    }

    /// Carry over what `previous` holds in memory alone for the rows this
    /// registry shares with it, by stored root: the canonical path each had
    /// resolved to and the roots that had not answered when it was appended.
    /// A reload so keeps what earlier lookups learned without touching any
    /// root, and a row appended beside an unanswered root is still dropped
    /// once that root answers into its directory, although the file the
    /// reload read says nothing of it.
    pub(crate) fn keep_unsaved_fields(&mut self, previous: &Registry) {
        for row in &mut self.workspaces {
            if let Some(known) = previous
                .workspaces
                .iter()
                .find(|known| known.root_path == row.root_path)
            {
                row.canonical_path = known.canonical_path.clone();
                row.unanswered_roots = known.unanswered_roots.clone();
            }
        }
    }

    pub fn save(&self) -> Result<()> {
        self.save_to(&paths::global_config_path())
    }

    pub fn save_to(&self, path: &Path) -> Result<()> {
        let body = toml::to_string_pretty(self)?;
        fs_ops::atomic_write(path, body.as_bytes())
    }

    /// Find a known workspace by absolute path, canonicalized when
    /// possible. Matches by canonical path so symlink wiggles don't
    /// create duplicate registry entries.
    pub fn find(&self, root: &Path) -> Option<&KnownWorkspace> {
        self.find_matched(&self.match_root(root, false))
    }

    /// Touch-or-append the workspace entry, then sort most-recent first.
    /// Returns the entry's index after the operation.
    ///
    /// Re-touching an existing row preserves `metadata_key`, so
    /// opening the same canonical path reuses the same metadata
    /// directory.
    pub fn touch(&mut self, root: &Path) -> usize {
        let found = self.match_root(root, false);
        self.touch_matched(&found)
    }

    /// Update the `root_path` of an existing registry row,
    /// preserving the metadata key and therefore every metadata
    /// directory. Used by `Library::move_workspace` to record an `mv` of
    /// the workspace directory without moving chan-managed state.
    pub fn set_path(&mut self, old: &Path, new: &Path) -> bool {
        let old = self.match_root(old, false);
        self.set_path_matched(&old, canonical_form(new))
    }

    /// Remove a registry entry. Does not delete the directory or the
    /// per-workspace metadata on disk; the caller decides whether to
    /// purge that separately.
    pub fn remove(&mut self, root: &Path) -> bool {
        let found = self.match_root(root, true);
        self.remove_matched(&found)
    }

    /// [`RootMatch::resolve`] against this registry's rows.
    fn match_root(&self, root: &Path, every_row: bool) -> RootMatch {
        let canonical = canonical_form(root);
        let candidates = self.alias_candidates(&canonical, every_row);
        RootMatch::resolve(canonical, &candidates)
    }

    /// The rows a lookup of `canonical` has to re-resolve, by their stored
    /// root: none when a row's cached canonical path is `canonical`, unless
    /// `every_row` asks for every row whose cached path is not, as a removal
    /// does to drop a stale alias beside the cached match. A lookup that is
    /// not a registration's asks this and so never waits on a root a row was
    /// appended beside; a registration asks
    /// [`registration_candidates`](Self::registration_candidates).
    pub(crate) fn alias_candidates(&self, canonical: &Path, every_row: bool) -> Vec<PathBuf> {
        if !every_row
            && self
                .workspaces
                .iter()
                .any(|d| d.cached_canonical_path() == canonical)
        {
            return Vec::new();
        }
        self.workspaces
            .iter()
            .filter(|d| d.cached_canonical_path() != canonical)
            .map(|d| d.root_path.clone())
            .collect()
    }

    /// The rows a registration of `canonical` has to re-resolve, by their
    /// stored root: what [`alias_candidates`](Self::alias_candidates)
    /// answers a lookup, unless the row whose cached canonical path is
    /// `canonical` was appended beside roots that had not answered. Then it
    /// is those of them another row still stores, so that the registration
    /// hears whether one resolves into this row's directory.
    pub(crate) fn registration_candidates(&self, canonical: &Path) -> Vec<PathBuf> {
        let appended = self
            .workspaces
            .iter()
            .position(|d| d.cached_canonical_path() == canonical)
            .filter(|&i| !self.workspaces[i].unanswered_roots.is_empty());
        let Some(i) = appended else {
            return self.alias_candidates(canonical, false);
        };
        self.workspaces[i]
            .unanswered_roots
            .iter()
            .filter(|root| self.stored_beside(i, root))
            .cloned()
            .collect()
    }

    /// Whether a row other than the one at `i` stores `root`.
    fn stored_beside(&self, i: usize, root: &Path) -> bool {
        self.workspaces
            .iter()
            .enumerate()
            .any(|(j, d)| j != i && d.root_path == root)
    }

    /// Bring up to date what the row `found` lands on by its cached path
    /// holds of the roots that had not answered when it was appended, from a
    /// match that asked them again
    /// ([`registration_candidates`](Self::registration_candidates)). A root
    /// that answered into another directory, or that no other row stores any
    /// longer, is forgotten; one that still has not answered is kept and
    /// asked again by the next registration.
    ///
    /// Answers the row, by its stored root and its metadata key, when one of
    /// those roots now resolves into the row's directory: the row that
    /// stores that root is the directory's row, and the caller drops this
    /// one ([`remove_appended`](Self::remove_appended)). Its roots are kept
    /// until then, so a drop that is refused is tried again.
    pub(crate) fn settle_unanswered(&mut self, found: &RootMatch) -> Option<(PathBuf, String)> {
        let i = self
            .workspaces
            .iter()
            .position(|d| d.cached_canonical_path() == found.canonical)?;
        let kept: Vec<PathBuf> = self.workspaces[i]
            .unanswered_roots
            .iter()
            .filter(|root| !found.elsewhere.contains(root) && self.stored_beside(i, root))
            .cloned()
            .collect();
        let superseded = kept.iter().any(|root| found.aliases.contains(root));
        let row = &mut self.workspaces[i];
        row.unanswered_roots = kept;
        superseded.then(|| (row.root_path.clone(), row.metadata_key.clone()))
    }

    /// Index of the row `found` names: the row whose cached canonical path
    /// is its canonical form, else the first of its aliases. Pure, so it
    /// re-checks a match computed without the registry against the rows as
    /// they are now.
    fn position_matched(&self, found: &RootMatch) -> Option<usize> {
        self.workspaces
            .iter()
            .position(|d| d.cached_canonical_path() == found.canonical)
            .or_else(|| {
                self.workspaces
                    .iter()
                    .position(|d| found.aliases.contains(&d.root_path))
            })
    }

    /// The rows a registration of `found` can land on once the row that
    /// stores `stored` under `metadata_key` is gone: every other row whose
    /// cached canonical path is the match's canonical form or whose stored
    /// root is one of its aliases. [`touch_matched`](Self::touch_matched)
    /// takes one of them.
    pub(crate) fn lands_without(
        &self,
        found: &RootMatch,
        stored: &Path,
        metadata_key: &str,
    ) -> Vec<&KnownWorkspace> {
        self.workspaces
            .iter()
            .filter(|d| !(d.root_path == stored && d.metadata_key == metadata_key))
            .filter(|d| {
                d.cached_canonical_path() == found.canonical || found.aliases.contains(&d.root_path)
            })
            .collect()
    }

    /// [`find`](Self::find) for a match computed beforehand.
    pub(crate) fn find_matched(&self, found: &RootMatch) -> Option<&KnownWorkspace> {
        self.position_matched(found).map(|i| &self.workspaces[i])
    }

    /// [`touch`](Self::touch) for a match computed beforehand. Touches no
    /// root: a new row's metadata key hashes the canonical form the match
    /// already holds.
    ///
    /// A row appended while some of the roots the match asked had not
    /// answered keeps them: one of them may resolve into the same directory,
    /// and the row is then a second one for it. A registration that lands
    /// on the row later asks them again and drops it when one does
    /// ([`settle_unanswered`](Self::settle_unanswered)).
    pub(crate) fn touch_matched(&mut self, found: &RootMatch) -> usize {
        let now = Utc::now();
        if let Some(i) = self.position_matched(found) {
            self.workspaces[i].last_seen_at = now;
            // Refresh the cache: a relinked workspace would otherwise
            // keep the stale canonical, then the next touch wouldn't
            // find it on the fast path.
            self.workspaces[i].canonical_path = Some(found.canonical.clone());
        } else {
            self.workspaces.push(KnownWorkspace {
                root_path: found.canonical.clone(),
                metadata_key: paths::metadata_key_for_canonical(&found.canonical),
                created_at: now,
                last_seen_at: now,
                display_name: None,
                canonical_path: Some(found.canonical.clone()),
                unanswered_roots: found.unanswered.clone(),
            });
        }
        self.workspaces
            .sort_by_key(|d| std::cmp::Reverse(d.last_seen_at));
        self.workspaces
            .iter()
            .position(|d| d.cached_canonical_path() == found.canonical)
            .unwrap_or(0)
    }

    /// [`set_path`](Self::set_path) for a match of the old path computed
    /// beforehand and the new path's canonical form.
    pub(crate) fn set_path_matched(&mut self, old: &RootMatch, new_canonical: PathBuf) -> bool {
        let Some(i) = self.position_matched(old) else {
            return false;
        };
        self.workspaces[i].root_path = new_canonical.clone();
        self.workspaces[i].last_seen_at = Utc::now();
        self.workspaces[i].canonical_path = Some(new_canonical);
        true
    }

    /// [`remove`](Self::remove) for a match computed beforehand: drops the
    /// cached match and every alias the match found.
    pub(crate) fn remove_matched(&mut self, found: &RootMatch) -> bool {
        let before = self.workspaces.len();
        self.workspaces.retain(|d| {
            d.cached_canonical_path() != found.canonical && !found.aliases.contains(&d.root_path)
        });
        self.workspaces.len() != before
    }

    /// Remove the one row that stores `stored`, compared as the registry
    /// stores it, under `metadata_key`: the row whose state the caller wiped
    /// under that key. Resolves nothing. Answers whether a row was removed.
    ///
    /// Two rows can store one root when the registry file was written
    /// outside the Library, since a load keeps every row the file lists;
    /// the key keeps this to the one the caller means.
    pub(crate) fn remove_stored(&mut self, stored: &Path, metadata_key: &str) -> bool {
        let Some(i) = self
            .workspaces
            .iter()
            .position(|d| d.root_path == stored && d.metadata_key == metadata_key)
        else {
            return false;
        };
        self.workspaces.remove(i);
        true
    }

    /// [`remove_stored`](Self::remove_stored) for the row a registration
    /// drops: only while that row still holds a root that had not answered
    /// when it was appended. A row that lost them since the registration
    /// looked, as when another registration heard those roots answer into
    /// other directories, is not known to be a second row and stays.
    pub(crate) fn remove_appended(&mut self, stored: &Path, metadata_key: &str) -> bool {
        let Some(i) = self.workspaces.iter().position(|d| {
            d.root_path == stored
                && d.metadata_key == metadata_key
                && !d.unanswered_roots.is_empty()
        }) else {
            return false;
        };
        self.workspaces.remove(i);
        true
    }
}

/// Canonicalize-or-fall-back-to-input, normalized (any Windows `\\?\` verbatim
/// prefix stripped) so a path keys and compares identically across processes.
/// Used for the per-call target path; entries cache their own canonical form on
/// insert / load.
pub(crate) fn canonical_form(root: &Path) -> PathBuf {
    paths::canonicalize_normalized(root)
}

/// What a lookup of one path matches, computed without the registry: the
/// path's canonical form, and the registered roots that re-resolve to that
/// form although their cached canonical path says otherwise.
///
/// A row's cached path goes stale when its root moves under a symlink; the
/// aliases are how such a row is still found rather than registered twice.
/// Finding them means asking the filesystem about other workspaces' roots,
/// which is why a match is computed before the caller takes the registry's
/// mutex, and why each of those roots gets a bounded time to answer.
///
/// A match also keeps how the other roots it asked fared: the ones that had
/// not answered within that time, which a row appended on this match
/// remembers, and the ones that answered into another directory, which a
/// registration takes off what such a row remembers.
#[derive(Debug)]
pub(crate) struct RootMatch {
    canonical: PathBuf,
    aliases: Vec<PathBuf>,
    unanswered: Vec<PathBuf>,
    elsewhere: Vec<PathBuf>,
}

impl RootMatch {
    /// Re-resolve `candidates`, the stored roots of the rows a stale cache
    /// could hide `canonical` behind, and sort them by their answer: the
    /// ones that now resolve to it, the ones that resolve elsewhere, and
    /// the ones that did not answer within the probe's budget.
    pub(crate) fn resolve(canonical: PathBuf, candidates: &[PathBuf]) -> Self {
        let mut aliases = Vec::new();
        let mut unanswered = Vec::new();
        let mut elsewhere = Vec::new();
        let fresh = alias_probe::fresh_canonicals(candidates, alias_probe::budget());
        for (fresh, root) in fresh.into_iter().zip(candidates) {
            match fresh {
                Some(resolved) if resolved == canonical => aliases.push(root.clone()),
                Some(_) => elsewhere.push(root.clone()),
                None => unanswered.push(root.clone()),
            }
        }
        Self {
            canonical,
            aliases,
            unanswered,
            elsewhere,
        }
    }

    /// The looked-up path's canonical form.
    pub(crate) fn canonical(&self) -> &Path {
        &self.canonical
    }
}

/// How long one lookup waits for the roots it re-resolves. A registered
/// root that has not answered by then is taken not to be the one looked up:
/// the looked-up path has just resolved, and a root that cannot is not the
/// same directory in any case that matters, while waiting on it would let
/// one stalled mount hold up the registration, open and removal of every
/// other workspace. Where that guess is wrong a registration appends a
/// second row for the directory, which remembers the root and is dropped
/// by a later registration once the root answers into it
/// ([`Registry::settle_unanswered`]).
const ALIAS_PROBE_BUDGET: Duration = Duration::from_secs(2);

/// Run `lookups` with this thread's registry lookups waiting `budget` for the
/// roots they re-resolve, so a test can hold a lookup inside that wait for as
/// long as it needs to observe what the lookup holds meanwhile.
#[cfg(test)]
pub(crate) fn with_alias_probe_budget<T>(budget: Duration, lookups: impl FnOnce() -> T) -> T {
    alias_probe::BUDGET.with(|cell| cell.set(Some(budget)));
    let out = lookups();
    alias_probe::BUDGET.with(|cell| cell.set(None));
    out
}

/// Bounded, shared re-resolution of registered roots.
mod alias_probe {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Condvar, Mutex, OnceLock, PoisonError};
    use std::time::{Duration, Instant};

    use crate::paths;

    /// One root's re-resolution in flight, shared by every lookup that asks
    /// for that root while it runs.
    #[derive(Default)]
    struct Probe {
        resolved: Mutex<Option<PathBuf>>,
        done: Condvar,
    }

    impl Probe {
        fn wait_until(&self, deadline: Instant) -> Option<PathBuf> {
            let mut resolved = self.resolved.lock().unwrap_or_else(PoisonError::into_inner);
            loop {
                if let Some(path) = resolved.as_ref() {
                    return Some(path.clone());
                }
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return None;
                }
                resolved = self
                    .done
                    .wait_timeout(resolved, remaining)
                    .unwrap_or_else(PoisonError::into_inner)
                    .0;
            }
        }
    }

    static IN_FLIGHT: OnceLock<Mutex<HashMap<PathBuf, Arc<Probe>>>> = OnceLock::new();

    #[cfg(test)]
    thread_local! {
        pub(super) static BUDGET: std::cell::Cell<Option<Duration>> =
            const { std::cell::Cell::new(None) };
    }

    /// How long a lookup on this thread waits for the roots it re-resolves.
    pub(super) fn budget() -> Duration {
        #[cfg(test)]
        if let Some(budget) = BUDGET.with(std::cell::Cell::get) {
            return budget;
        }
        super::ALIAS_PROBE_BUDGET
    }

    fn in_flight() -> std::sync::MutexGuard<'static, HashMap<PathBuf, Arc<Probe>>> {
        IN_FLIGHT
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Re-resolve every root in `roots` at once and wait at most `budget`
    /// for the answers, `None` for a root that has not answered by then.
    ///
    /// Each root resolves on a thread of its own, joined by any lookup that
    /// asks for the same root while it runs, so one hung root holds at most
    /// one thread however many lookups meet it, and a later lookup waits on
    /// that thread instead of starting another.
    pub(super) fn fresh_canonicals(roots: &[PathBuf], budget: Duration) -> Vec<Option<PathBuf>> {
        let probes: Vec<Option<Arc<Probe>>> = roots.iter().map(|root| start(root)).collect();
        let deadline = Instant::now() + budget;
        probes
            .iter()
            .map(|probe| probe.as_ref().and_then(|probe| probe.wait_until(deadline)))
            .collect()
    }

    /// The probe in flight for `root`, or a new one on a thread of its own;
    /// `None` when no thread can be started.
    fn start(root: &Path) -> Option<Arc<Probe>> {
        let mut probes = in_flight();
        if let Some(probe) = probes.get(root) {
            return Some(Arc::clone(probe));
        }
        let probe = Arc::new(Probe::default());
        let running = Arc::clone(&probe);
        let owned = root.to_path_buf();
        // The map lock is held across the spawn, so the thread cannot
        // finish and look for its entry before the entry is inserted.
        let spawned = std::thread::Builder::new()
            .name("chan-root-probe".into())
            .spawn(move || {
                let resolved = paths::canonicalize_normalized(&owned);
                {
                    let mut probes = in_flight();
                    if probes
                        .get(&owned)
                        .is_some_and(|probe| Arc::ptr_eq(probe, &running))
                    {
                        probes.remove(&owned);
                    }
                }
                *running
                    .resolved
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner) = Some(resolved);
                running.done.notify_all();
            });
        match spawned {
            Ok(_) => {
                probes.insert(root.to_path_buf(), Arc::clone(&probe));
                Some(probe)
            }
            Err(error) => {
                tracing::warn!(
                    root = %root.display(),
                    %error,
                    "could not start a registry alias probe",
                );
                None
            }
        }
    }
}

pub(crate) fn config_declares_index_excluded_dirs(path: &Path) -> bool {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(value) = raw.parse::<toml::Value>() else {
        return false;
    };
    value.get("index_excluded_dirs").is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn capture_warnings<T>(f: impl FnOnce() -> T) -> (Vec<String>, T) {
        struct Capture(std::sync::Arc<std::sync::Mutex<Vec<String>>>);
        impl tracing::Subscriber for Capture {
            fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
                true
            }
            fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
                tracing::span::Id::from_u64(1)
            }
            fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
            fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
            fn event(&self, event: &tracing::Event<'_>) {
                struct Line(String);
                impl tracing::field::Visit for Line {
                    fn record_debug(
                        &mut self,
                        field: &tracing::field::Field,
                        value: &dyn std::fmt::Debug,
                    ) {
                        use std::fmt::Write as _;
                        let _ = write!(self.0, " {}={value:?}", field.name());
                    }
                }
                let mut line = Line(event.metadata().level().to_string());
                event.record(&mut line);
                self.0
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(line.0);
            }
            fn enter(&self, _: &tracing::span::Id) {}
            fn exit(&self, _: &tracing::span::Id) {}
        }
        let lines = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let out = tracing::subscriber::with_default(Capture(std::sync::Arc::clone(&lines)), f);
        let warnings = lines
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        (warnings, out)
    }

    #[test]
    fn touch_inserts_then_updates() {
        let tmp = TempDir::new().unwrap();
        let mut reg = Registry::default();
        let idx1 = reg.touch(tmp.path());
        assert_eq!(idx1, 0);
        assert_eq!(reg.workspaces.len(), 1);
        let key = reg.workspaces[0].metadata_key.clone();
        let first_seen = reg.workspaces[0].last_seen_at;

        std::thread::sleep(std::time::Duration::from_millis(10));
        let idx2 = reg.touch(tmp.path());
        assert_eq!(idx2, 0);
        assert_eq!(reg.workspaces.len(), 1);
        assert_eq!(reg.workspaces[0].metadata_key, key);
        assert!(reg.workspaces[0].last_seen_at > first_seen);
    }

    #[test]
    fn remove_drops_entry() {
        let tmp = TempDir::new().unwrap();
        let mut reg = Registry::default();
        reg.touch(tmp.path());
        assert!(reg.remove(tmp.path()));
        assert!(reg.workspaces.is_empty());
        assert!(!reg.remove(tmp.path()));
    }

    /// A registry file written outside the Library can list two rows that
    /// store one root, and a load keeps both; a removal by the stored root
    /// takes the row with the metadata key it is given and leaves the other.
    #[test]
    fn remove_stored_drops_only_the_row_with_the_key_given() {
        let tmp = TempDir::new().unwrap();
        let mut written = Registry::default();
        written.touch(tmp.path());
        let mut twin = written.workspaces[0].clone();
        twin.metadata_key = "written-by-hand".into();
        written.workspaces.push(twin);
        let file = tmp.path().join("config.toml");
        written.save_to(&file).unwrap();
        let mut reg = Registry::load_from(&file).unwrap();
        assert_eq!(reg.workspaces.len(), 2, "fixture: a load dropped a row");
        let stored = reg.workspaces[0].root_path.clone();
        let first = reg.workspaces[0].metadata_key.clone();

        assert!(!reg.remove_stored(&stored, "no-such-key"));
        assert!(reg.remove_stored(&stored, "written-by-hand"));
        let keys: Vec<&str> = reg
            .workspaces
            .iter()
            .map(|d| d.metadata_key.as_str())
            .collect();
        assert_eq!(
            keys,
            vec![first.as_str()],
            "the removal took a row other than the one with the key given"
        );
    }

    #[test]
    fn save_load_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let cfg_path = tmp.path().join("config.toml");
        let mut reg = Registry::default();
        reg.touch(tmp.path());
        let key = reg.workspaces[0].metadata_key.clone();
        reg.save_to(&cfg_path).unwrap();
        let raw = std::fs::read_to_string(&cfg_path).unwrap();
        assert!(raw.contains("index_excluded_dirs"));
        assert!(raw.contains("root_path"));
        assert!(raw.contains("metadata_key"));
        assert!(!raw.lines().any(|line| line.starts_with("path =")));
        assert!(!raw.lines().any(|line| line.starts_with("uuid =")));
        assert!(!raw.lines().any(|line| line.starts_with("name =")));
        let loaded = Registry::load_from(&cfg_path).unwrap();
        assert!(loaded
            .index_excluded_dirs
            .iter()
            .any(|name| name == "node_modules"));
        assert_eq!(loaded.workspaces.len(), 1);
        assert_eq!(loaded.workspaces[0].metadata_key, key);
    }

    #[test]
    fn load_strips_a_verbatim_prefix_an_older_build_stored() {
        // A Windows row written as `\\?\C:\notes` loads as `C:\notes`: the
        // stored form is what `chan ps` and the launcher print.
        let tmp = TempDir::new().unwrap();
        let cfg_path = tmp.path().join("config.toml");
        let mut reg = Registry::default();
        reg.touch(tmp.path());
        reg.save_to(&cfg_path).unwrap();
        let raw = std::fs::read_to_string(&cfg_path).unwrap();
        let rewritten: String = raw
            .lines()
            .map(|line| {
                if line.starts_with("root_path = ") {
                    r"root_path = '\\?\C:\notes'".to_string()
                } else {
                    line.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&cfg_path, rewritten).unwrap();
        let loaded = Registry::load_from(&cfg_path).unwrap();
        assert_eq!(loaded.workspaces[0].root_path, PathBuf::from(r"C:\notes"));
    }

    #[test]
    fn load_missing_index_excluded_dirs_uses_default() {
        let tmp = TempDir::new().unwrap();
        let cfg_path = tmp.path().join("config.toml");
        std::fs::write(&cfg_path, "workspaces = []\n").unwrap();
        let loaded = Registry::load_from(&cfg_path).unwrap();
        assert!(loaded
            .index_excluded_dirs
            .iter()
            .any(|name| name == "node_modules"));
    }

    #[test]
    fn load_empty_index_excluded_dirs_preserves_user_choice() {
        let tmp = TempDir::new().unwrap();
        let cfg_path = tmp.path().join("config.toml");
        std::fs::write(&cfg_path, "index_excluded_dirs = []\nworkspaces = []\n").unwrap();
        let loaded = Registry::load_from(&cfg_path).unwrap();
        assert!(loaded.index_excluded_dirs.is_empty());
    }

    #[test]
    fn most_recent_sorts_first() {
        let a = TempDir::new().unwrap();
        let b = TempDir::new().unwrap();
        let mut reg = Registry::default();
        reg.touch(a.path());
        std::thread::sleep(std::time::Duration::from_millis(10));
        reg.touch(b.path());
        assert_eq!(
            reg.workspaces[0].root_path,
            b.path().canonicalize().unwrap()
        );
    }

    #[test]
    fn touch_allocates_deterministic_metadata_key() {
        let tmp = TempDir::new().unwrap();
        let mut reg = Registry::default();
        reg.touch(tmp.path());
        let key = reg.workspaces[0].metadata_key.clone();
        assert_eq!(key, paths::metadata_key_for_root(tmp.path()));

        assert!(reg.remove(tmp.path()));
        reg.touch(tmp.path());
        assert_eq!(reg.workspaces[0].metadata_key, key);
    }

    #[test]
    fn touch_matches_trailing_slash_to_same_canonical_path() {
        let tmp = TempDir::new().unwrap();
        let mut reg = Registry::default();
        reg.touch(tmp.path());
        let key = reg.workspaces[0].metadata_key.clone();
        let with_slash = tmp.path().join("");
        reg.touch(&with_slash);

        assert_eq!(reg.workspaces.len(), 1);
        assert_eq!(reg.workspaces[0].metadata_key, key);
    }

    #[cfg(unix)]
    #[test]
    fn touch_matches_symlink_to_same_canonical_path() {
        use std::os::unix::fs::symlink;

        let tmp = TempDir::new().unwrap();
        let link_parent = TempDir::new().unwrap();
        let link = link_parent.path().join("workspace-link");
        symlink(tmp.path(), &link).unwrap();

        let mut reg = Registry::default();
        reg.touch(tmp.path());
        let key = reg.workspaces[0].metadata_key.clone();
        reg.touch(&link);

        assert_eq!(reg.workspaces.len(), 1);
        assert_eq!(reg.workspaces[0].metadata_key, key);
    }

    #[test]
    fn legacy_drafts_dir_loads_and_drops_on_save() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("config.toml");
        std::fs::write(
            &path,
            "drafts_dir = \"Scratch\"\nindex_excluded_dirs = [\"dist\"]\nworkspaces = []\n",
        )
        .unwrap();
        let (warnings, registry) = capture_warnings(|| Registry::load_from(&path).unwrap());
        assert!(
            warnings.iter().any(|line| {
                line.contains("WARN")
                    && line.contains("drafts_dir")
                    && line.contains("per-workspace metadata sidecar Drafts/")
            }),
            "{warnings:?}"
        );
        assert_eq!(registry.index_excluded_dirs, vec!["dist"]);
        registry.save_to(&path).unwrap();
        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(!saved.contains("drafts_dir"), "{saved}");
        assert!(saved.contains("dist"), "{saved}");
    }

    #[test]
    fn malformed_legacy_drafts_toml_is_still_a_decode_error() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("config.toml");
        std::fs::write(&path, "drafts_dir = = =\n").unwrap();
        assert!(matches!(
            Registry::load_from(&path),
            Err(ChanError::ConfigDecode { .. })
        ));
    }

    #[test]
    fn set_path_preserves_metadata_key() {
        let old = TempDir::new().unwrap();
        let new = TempDir::new().unwrap();
        let mut reg = Registry::default();
        reg.touch(old.path());
        let key_before = reg.workspaces[0].metadata_key.clone();

        assert!(reg.set_path(old.path(), new.path()));
        assert_eq!(
            reg.workspaces[0].metadata_key, key_before,
            "metadata key must survive a path move so metadata stays reachable",
        );
        assert!(reg.find(new.path()).is_some());
        assert!(reg.find(old.path()).is_none());
    }

    #[test]
    fn transfer_max_bytes_missing_table_and_field_use_default() {
        let tmp = TempDir::new().unwrap();
        let missing_table = tmp.path().join("missing-table.toml");
        std::fs::write(&missing_table, "workspaces = []\n").unwrap();
        assert_eq!(
            Registry::load_from(&missing_table)
                .unwrap()
                .transfer
                .max_bytes,
            DEFAULT_TRANSFER_MAX_BYTES
        );

        let missing_field = tmp.path().join("missing-field.toml");
        std::fs::write(&missing_field, "workspaces = []\n[transfer]\n").unwrap();
        assert_eq!(
            Registry::load_from(&missing_field)
                .unwrap()
                .transfer
                .max_bytes,
            DEFAULT_TRANSFER_MAX_BYTES
        );
    }

    #[test]
    fn transfer_max_bytes_persists_explicit_nonzero_value() {
        let tmp = TempDir::new().unwrap();
        let source = tmp.path().join("source.toml");
        let saved = tmp.path().join("saved.toml");
        std::fs::write(
            &source,
            "workspaces = []\n[transfer]\nmax_bytes = 123456789\n",
        )
        .unwrap();

        let registry = Registry::load_from(&source).unwrap();
        assert_eq!(registry.transfer.max_bytes, 123_456_789);
        registry.save_to(&saved).unwrap();
        assert_eq!(
            Registry::load_from(&saved).unwrap().transfer.max_bytes,
            123_456_789
        );
    }

    #[test]
    fn transfer_max_bytes_rejects_zero() {
        let tmp = TempDir::new().unwrap();
        let config = tmp.path().join("config.toml");
        std::fs::write(&config, "workspaces = []\n[transfer]\nmax_bytes = 0\n").unwrap();

        assert!(matches!(
            Registry::load_from(&config),
            Err(ChanError::InvalidTransferMaxBytes {
                value: 0,
                max: TRANSFER_MAX_BYTES_CEILING,
            })
        ));
    }

    #[test]
    fn transfer_max_bytes_accepts_exact_ceiling() {
        let tmp = TempDir::new().unwrap();
        let config = tmp.path().join("config.toml");
        std::fs::write(
            &config,
            format!("workspaces = []\n[transfer]\nmax_bytes = {TRANSFER_MAX_BYTES_CEILING}\n"),
        )
        .unwrap();

        assert_eq!(
            Registry::load_from(&config).unwrap().transfer.max_bytes,
            TRANSFER_MAX_BYTES_CEILING
        );
    }

    #[test]
    fn transfer_max_bytes_rejects_one_byte_over_ceiling() {
        let tmp = TempDir::new().unwrap();
        let config = tmp.path().join("config.toml");
        let value = TRANSFER_MAX_BYTES_CEILING + 1;
        std::fs::write(
            &config,
            format!("workspaces = []\n[transfer]\nmax_bytes = {value}\n"),
        )
        .unwrap();

        assert!(matches!(
            Registry::load_from(&config),
            Err(ChanError::InvalidTransferMaxBytes {
                value: rejected,
                max: TRANSFER_MAX_BYTES_CEILING,
            }) if rejected == value
        ));
    }

    /// A row whose cached canonical path went stale still matches the
    /// directory its root resolves to now. The root's parent moved and a
    /// symlink took its place, so the row caches the old spelling while its
    /// root resolves to the new one: a lookup and a removal of the new
    /// spelling find the row, and a touch refreshes it instead of adding a
    /// second one.
    #[cfg(unix)]
    #[test]
    fn a_row_whose_cached_canonical_path_went_stale_still_matches() {
        use std::os::unix::fs::symlink;
        let tmp = TempDir::new().unwrap();
        let parent = tmp.path().join("parent");
        std::fs::create_dir_all(parent.join("ws")).unwrap();
        let mut reg = Registry::default();
        reg.touch(&parent.join("ws"));
        let key = reg.workspaces[0].metadata_key.clone();

        let moved = tmp.path().join("moved");
        std::fs::rename(&parent, &moved).unwrap();
        symlink(&moved, &parent).unwrap();
        let relinked = moved.join("ws");

        assert_eq!(
            reg.find(&relinked).map(|row| row.metadata_key.as_str()),
            Some(key.as_str()),
            "a lookup missed the row whose cached path went stale"
        );
        let mut removing = reg.clone();
        assert!(
            removing.remove(&relinked),
            "a removal missed the row whose cached path went stale"
        );
        assert!(removing.workspaces.is_empty());
        let idx = reg.touch(&relinked);
        assert_eq!(
            reg.workspaces.len(),
            1,
            "a touch registered the relinked root a second time"
        );
        assert_eq!(reg.workspaces[idx].metadata_key, key);
    }

    /// A lookup that has to re-resolve the other rows gives a row whose root
    /// has stopped answering a bounded wait, and takes it not to be the root
    /// looked up.
    #[test]
    fn a_lookup_does_not_wait_on_a_row_whose_root_hangs() {
        let tmp = TempDir::new().unwrap();
        let hung = tmp.path().join("hung");
        let fresh = tmp.path().join("fresh");
        std::fs::create_dir_all(&hung).unwrap();
        std::fs::create_dir_all(&fresh).unwrap();
        let mut reg = Registry::default();
        reg.touch(&hung);

        let stall = crate::paths::root_stall::stall(hung);
        let reg = stall.finishes_beside(
            "registering a new root",
            std::time::Duration::from_secs(30),
            move || {
                reg.touch(&fresh);
                reg
            },
        );
        assert_eq!(reg.workspaces.len(), 2, "the new root was not registered");
    }
}
