// Workspace registry: the per-machine list of directories the user has
// registered as chan workspaces. Persisted to ~/.chan/config.toml.
//
// This file holds ONLY chan-workspace's own state: the registry of
// known workspaces. Editor preferences (fonts, theme, API keys) are an
// app-level concern and live in a separate file owned by the consuming
// app.

use std::path::{Path, PathBuf};

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
    /// In-root directory name that holds Cmd+N drafts. A single path
    /// segment under the workspace root (default `.Drafts`). Drafts
    /// are real files inside the workspace, addressed as
    /// `<drafts_dir>/<name>/draft.md`, so they participate in the
    /// normal walk / index / watch alongside the rest of the tree.
    ///
    /// Like `index_excluded_dirs`, this is global, hand-edited in
    /// `~/.chan/config.toml`, and NOT UI-configurable. An invalid
    /// value falls back to `.Drafts` at workspace-open time.
    #[serde(default = "default_drafts_dir")]
    pub drafts_dir: String,
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
            drafts_dir: default_drafts_dir(),
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

/// Default in-root drafts directory name. Hidden (`.`-prefixed) so it
/// stays out of the way in plain file listings while still being a
/// real directory the workspace walker indexes and watches.
pub const DEFAULT_DRAFTS_DIR: &str = ".Drafts";

fn default_drafts_dir() -> String {
    DEFAULT_DRAFTS_DIR.to_string()
}

/// Whether `name` is usable as the in-root drafts directory. Valid iff
/// it is a single path segment that does not collide with chan's own
/// reserved directories or the user's configured index-exclusion set:
///
///   * non-empty,
///   * no path separator (`/` or `\`) and not `.` / `..`,
///   * not `.git` or `.chan` (hard-skipped internal invariants),
///   * not equal (case-insensitively) to any `excluded` entry, so a
///     drafts dir can never land inside an excluded subtree and become
///     invisible to search/graph.
///
/// An invalid value is rejected at workspace-open time and the caller
/// falls back to `DEFAULT_DRAFTS_DIR`.
pub fn validate_drafts_dir(name: &str, excluded: &[String]) -> bool {
    if name.is_empty() || name.contains('/') || name.contains('\\') {
        return false;
    }
    if name == "." || name == ".." || name == ".git" || name == ".chan" {
        return false;
    }
    !excluded.iter().any(|e| e.eq_ignore_ascii_case(name))
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
}

impl KnownWorkspace {
    /// Cached canonical path; falls back to a stat if the cache
    /// hasn't been primed, e.g. an entry constructed by tests
    /// outside the Registry.
    fn canonical(&self) -> PathBuf {
        if let Some(p) = &self.canonical_path {
            return p.clone();
        }
        paths::canonicalize_normalized(&self.root_path)
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
        let mut reg: Self = toml::from_str(&raw).map_err(|e| ChanError::ConfigDecode {
            path: path.to_path_buf(),
            message: e.to_string(),
        })?;
        reg.transfer = reg.transfer.validate()?;
        // Prime the canonical-path cache once at load. Comparisons
        // are then pure and don't re-canonicalize per call. Failure
        // here is non-fatal: an entry whose workspace root is missing or
        // asleep stays comparable lexically.
        for d in &mut reg.workspaces {
            d.canonical_path = Some(paths::canonicalize_normalized(&d.root_path));
        }
        Ok(reg)
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
        let target = canonicalize_or_keep(root);
        match self.workspaces.iter().position(|d| d.canonical() == target) {
            Some(i) => Some(&self.workspaces[i]),
            None => self
                .workspaces
                .iter()
                .find(|d| fresh_canonical(d) == target),
        }
    }

    /// Touch-or-append the workspace entry, then sort most-recent first.
    /// Returns the entry's index after the operation.
    ///
    /// Re-touching an existing row preserves `metadata_key`, so
    /// opening the same canonical path reuses the same metadata
    /// directory.
    pub fn touch(&mut self, root: &Path) -> usize {
        let canonical = canonicalize_or_keep(root);
        let now = Utc::now();
        let idx = position_match(&self.workspaces, &canonical);
        if let Some(i) = idx {
            self.workspaces[i].last_seen_at = now;
            // Refresh the cache: a relinked workspace would otherwise
            // keep the stale canonical, then the next touch wouldn't
            // find it on the fast path.
            self.workspaces[i].canonical_path = Some(canonical.clone());
        } else {
            self.workspaces.push(KnownWorkspace {
                root_path: canonical.clone(),
                metadata_key: paths::metadata_key_for_root(&canonical),
                created_at: now,
                last_seen_at: now,
                display_name: None,
                canonical_path: Some(canonical.clone()),
            });
        }
        self.workspaces
            .sort_by_key(|d| std::cmp::Reverse(d.last_seen_at));
        position_match(&self.workspaces, &canonical).unwrap_or(0)
    }

    /// Update the `root_path` of an existing registry row,
    /// preserving the metadata key and therefore every metadata
    /// directory. Used by `Library::move_workspace` to record an `mv` of
    /// the workspace directory without moving chan-managed state.
    pub fn set_path(&mut self, old: &Path, new: &Path) -> bool {
        let old_canon = canonicalize_or_keep(old);
        let Some(i) = position_match(&self.workspaces, &old_canon) else {
            return false;
        };
        let new_canon = canonicalize_or_keep(new);
        self.workspaces[i].root_path = new_canon.clone();
        self.workspaces[i].last_seen_at = Utc::now();
        self.workspaces[i].canonical_path = Some(new_canon);
        true
    }

    /// Remove a registry entry. Does not delete the directory or the
    /// per-workspace metadata on disk; the caller decides whether to
    /// purge that separately.
    pub fn remove(&mut self, root: &Path) -> bool {
        let canonical = canonicalize_or_keep(root);
        let before = self.workspaces.len();
        self.workspaces
            .retain(|d| d.canonical() != canonical && fresh_canonical(d) != canonical);
        self.workspaces.len() != before
    }
}

/// Canonicalize-or-fall-back-to-input, normalized (any Windows `\\?\` verbatim
/// prefix stripped) so a path keys and compares identically across processes.
/// Used for the per-call target path; entries cache their own canonical form on
/// insert / load.
fn canonicalize_or_keep(root: &Path) -> PathBuf {
    paths::canonicalize_normalized(root)
}

/// Re-canonicalize an entry's `root_path` ignoring its cache. Used
/// as the slow-path fallback when the cached canonical doesn't match
/// the target.
fn fresh_canonical(d: &KnownWorkspace) -> PathBuf {
    paths::canonicalize_normalized(&d.root_path)
}

/// Index of the workspace whose canonical, cached then fresh, matches
/// `canonical`. Centralises lookup so touch / find / remove behave
/// consistently.
fn position_match(workspaces: &[KnownWorkspace], canonical: &Path) -> Option<usize> {
    if let Some(i) = workspaces.iter().position(|d| d.canonical() == *canonical) {
        return Some(i);
    }
    workspaces
        .iter()
        .position(|d| fresh_canonical(d) == *canonical)
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
    fn load_missing_drafts_dir_uses_default() {
        let tmp = TempDir::new().unwrap();
        let cfg_path = tmp.path().join("config.toml");
        std::fs::write(&cfg_path, "workspaces = []\n").unwrap();
        let loaded = Registry::load_from(&cfg_path).unwrap();
        assert_eq!(loaded.drafts_dir, DEFAULT_DRAFTS_DIR);
    }

    #[test]
    fn validate_drafts_dir_rules() {
        let excluded = vec!["node_modules".to_string(), "Target".to_string()];
        assert!(validate_drafts_dir(".Drafts", &excluded));
        assert!(validate_drafts_dir("Scratch", &excluded));
        // Empty / separators / traversal.
        assert!(!validate_drafts_dir("", &excluded));
        assert!(!validate_drafts_dir("a/b", &excluded));
        assert!(!validate_drafts_dir("a\\b", &excluded));
        assert!(!validate_drafts_dir(".", &excluded));
        assert!(!validate_drafts_dir("..", &excluded));
        // Reserved internal dirs.
        assert!(!validate_drafts_dir(".git", &excluded));
        assert!(!validate_drafts_dir(".chan", &excluded));
        // Case-insensitive clash with an excluded dir.
        assert!(!validate_drafts_dir("node_modules", &excluded));
        assert!(!validate_drafts_dir("TARGET", &excluded));
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
}
