// Locations chan uses on this machine.
//
// Layout:
//
//                config_dir
//                ----------------
//   all          ~/.chan
//
// `~/.chan/config.toml` holds the registry of known workspaces
// (chan-workspace's responsibility). Editor / UI preferences (fonts,
// theme, API keys) live elsewhere and are an app-level concern;
// chan-workspace does not read or write them.
//
// Per-workspace metadata lives under `~/.chan/workspaces/<metadata_key>/`.
// The key is derived from the canonical workspace root at registration
// time and preserved across `Library::move_workspace`, so moving the
// workspace directory updates only the registry row.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// Per-user config dir. Holds the global `config.toml` (workspace
/// registry + default-workspace). `~/.chan/` on desktop targets;
/// co-located under the data dir on iOS / Android where the home
/// dir isn't user-writable.
///
/// `CHAN_HOME` overrides this with the directory to use IN PLACE OF `~/.chan`
/// (CARGO_HOME / GNUPGHOME semantics -- the dir itself, not a parent): set
/// `CHAN_HOME=/tmp/x` and chan reads its registry, devservers, and config under
/// `/tmp/x`, leaving the real `~/.chan` untouched (an isolated smoke instance).
/// Checked FIRST, so every delegator (`state_dir`, `cache_dir`,
/// `global_config_path`, `workspaces_dir`, …) inherits it. This is the SINGLE
/// authority for the chan home; nothing else resolves `~/.chan` independently.
/// On Unix, if the OS cannot resolve a home directory, chan uses the absolute
/// `/var/tmp/chan-<uid>` fallback rather than resolving state against the
/// process working directory. Windows uses `C:\ProgramData\chan`.
pub fn config_dir() -> PathBuf {
    config_dir_with_sources(chan_home_override(), dirs::home_dir())
}

fn config_dir_with_sources(override_dir: Option<PathBuf>, home: Option<PathBuf>) -> PathBuf {
    if let Some(dir) = override_dir {
        return dir;
    }
    config_dir_with_home(home)
}

/// Resolve the default chan home from an injected OS home. Keeping this input
/// explicit makes the unavailable-home branch testable without mutating the
/// process environment.
fn config_dir_with_home(home: Option<PathBuf>) -> PathBuf {
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        return state_dir();
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        home.map(|p| p.join(".chan"))
            .unwrap_or_else(home_unavailable_config_dir)
    }
}

#[cfg(all(unix, not(any(target_os = "ios", target_os = "android"))))]
fn home_unavailable_config_dir() -> PathBuf {
    PathBuf::from(format!(
        "/var/tmp/chan-{}",
        rustix::process::getuid().as_raw()
    ))
}

#[cfg(all(windows, not(any(target_os = "ios", target_os = "android"))))]
fn home_unavailable_config_dir() -> PathBuf {
    PathBuf::from(r"C:\ProgramData\chan")
}

/// The `CHAN_HOME` override, if set to a non-empty value: the directory chan
/// uses IN PLACE OF `~/.chan` (CARGO_HOME / GNUPGHOME semantics -- the dir
/// itself). The SINGLE place the env is read, shared by [`config_dir`] and
/// [`local_bin_dir`] so the two never drift. `var_os` (a path need not be
/// UTF-8); an empty value is treated as unset so `CHAN_HOME=` does not collapse
/// the home to the cwd.
fn chan_home_override() -> Option<PathBuf> {
    chan_home_override_from(std::env::var_os("CHAN_HOME"))
}

fn chan_home_override_from(value: Option<std::ffi::OsString>) -> Option<PathBuf> {
    value.filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// The dir chan-desktop installs the `chan`/`cs` bin shims into:
/// `CHAN_HOME/.local/bin` when `CHAN_HOME` is set (so an isolated smoke
/// instance's shims do not clobber the real `~/.local/bin/chan`), else
/// `$HOME/.local/bin`. `None` when neither `CHAN_HOME` nor `$HOME` resolves.
///
/// NOTE: unlike [`config_dir`], the unset fallback is `$HOME/.local/bin`, NOT
/// `$HOME/.chan/...` -- it is the standard user bin dir, so it does NOT route
/// through `config_dir`. The base is `CHAN_HOME`-or-`$HOME`, then `.local/bin`.
pub fn local_bin_dir() -> Option<PathBuf> {
    local_bin_dir_with_sources(chan_home_override(), dirs::home_dir())
}

fn local_bin_dir_with_sources(
    override_dir: Option<PathBuf>,
    home: Option<PathBuf>,
) -> Option<PathBuf> {
    override_dir
        .or(home)
        .map(|base| base.join(".local").join("bin"))
}

/// Per-user state dir. Kept as `~/.chan` for callers that still ask
/// chan-workspace for a global state root.
pub fn state_dir() -> PathBuf {
    config_dir()
}

/// Per-user cache dir. Kept as `~/.chan` for callers that still ask
/// chan-workspace for a global cache root.
pub fn cache_dir() -> PathBuf {
    config_dir()
}

/// Global config file. Workspace registry and per-machine defaults.
pub fn global_config_path() -> PathBuf {
    config_dir().join("config.toml")
}

/// Per-workspace metadata parent.
pub fn workspaces_dir() -> PathBuf {
    config_dir().join("workspaces")
}

/// Stable metadata key for a workspace root.
///
/// The readable prefix is the canonical absolute path with path
/// separators and filename-awkward characters replaced by `-`. The
/// 8-hex suffix is a deterministic hash of the same canonical path
/// string, preventing collisions between similar slugs.
pub fn metadata_key_for_root(workspace_root: &Path) -> String {
    let canonical = canonicalize_normalized(workspace_root);
    let canonical_s = canonical.as_os_str().to_string_lossy();
    let slug = metadata_slug(&canonical_s);
    format!("{slug}-{}", canonical_hash8(&canonical_s))
}

/// First 8 hex chars of the sha256 of a workspace root's canonical path.
///
/// Deterministic per root: the same root always hashes the same across
/// restarts, and two roots that share a basename but differ in their parent
/// hash differently. This is the collision-breaking suffix shared by the
/// metadata key (above) and the public mount prefix
/// ([`allocate_workspace_prefix`](../../chan_library/fn.allocate_workspace_prefix.html),
/// chan-library), so the keyed pathspec `/{basename-slug}-{8hex}` is unique
/// even across two same-basename workspaces.
pub fn canonical_root_hash8(workspace_root: &Path) -> String {
    let canonical = canonicalize_normalized(workspace_root);
    canonical_hash8(&canonical.as_os_str().to_string_lossy())
}

/// Canonicalize `workspace_root`, stripping any Windows `\\?\` verbatim
/// (extended-length) prefix so a path keys and compares identically whether a
/// process resolved it with or without the prefix. The CLI and the serving
/// devserver must agree on this, or a workspace's lock record keys under one
/// form and `chan ps` looks it up under the other and reads no PID.
/// `dunce::canonicalize` avoids emitting the prefix for legacy-length paths;
/// [`strip_verbatim_prefix`] then guarantees it is gone (long paths, or the
/// fallback when the FS can't canonicalize) and makes the normalization
/// testable off-Windows. Falls back to the (stripped) input when the root is
/// missing or asleep.
pub fn canonicalize_normalized(workspace_root: &Path) -> PathBuf {
    match dunce::canonicalize(workspace_root) {
        Ok(canonical) => strip_verbatim_prefix(&canonical),
        Err(_) => strip_verbatim_prefix(workspace_root),
    }
}

/// Strip a leading Windows `\\?\` verbatim prefix (`\\?\UNC\srv\share` ->
/// `\\srv\share`, `\\?\C:\x` -> `C:\x`) as a pure string operation, regardless
/// of build OS, so the normalization is deterministic and unit-testable
/// off-Windows. Any other path passes through unchanged.
pub fn strip_verbatim_prefix(p: &Path) -> PathBuf {
    let s = p.as_os_str().to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p.to_path_buf()
    }
}

/// Resolve `.` and `..` components lexically, without touching the
/// filesystem: a not-yet-existing path still normalizes, and a symlink keeps
/// the name the user typed (the filesystem is consulted only where a
/// canonical identity is wanted, see [`canonicalize_normalized`]). A `..`
/// that would climb above the accumulated path pops nothing more than the
/// root, so `/..` stays `/`. Prefix and root components pass through.
pub fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// sha256 of an already-canonicalized path string → its first 8 hex chars.
/// Single-sourced so the metadata key and the mount prefix derive the suffix
/// identically.
fn canonical_hash8(canonical_s: &str) -> String {
    let mut h = Sha256::new();
    h.update(canonical_s.as_bytes());
    let hex = format!("{:x}", h.finalize());
    hex[..8].to_string()
}

fn metadata_slug(path: &str) -> String {
    path.chars()
        .map(|c| match c {
            '/' | '\\' => '-',
            c if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') => c,
            _ => '-',
        })
        .collect()
}

/// Per-workspace global paths. Computed once per Workspace open.
#[derive(Debug, Clone)]
pub struct WorkspacePaths {
    /// Metadata root for this workspace, `<chan-home>/workspaces/<metadata_key>/`.
    pub root: PathBuf,
    /// Per-workspace sessions directory. Opaque JSON; chan-workspace does
    /// not interpret. Apps put window/pane layout files here.
    pub sessions: PathBuf,
    /// Per-workspace search-index directory (tantivy segments + config).
    pub index: PathBuf,
    /// Per-workspace graph database (sqlite). Regenerable from the
    /// source-of-truth markdown, but a rebuild is more expensive
    /// than a search reindex.
    pub graph_db: PathBuf,
    /// Per-workspace directory carrying graph-related sidecar state:
    /// the `rebuild.inprogress` marker (written before a graph
    /// rebuild starts, removed after the search index commits;
    /// presence on `Workspace::open` flags the workspace as needing a full
    /// reindex) and the persisted `rename_log.json`. Sibling of
    /// `graph_db` (same parent), so wiping this directory reclaims
    /// both the DB and the sidecars in one step.
    pub graph_dir: PathBuf,
    /// Per-workspace lock dir. Holds the index-writer lockfile that
    /// prevents two processes from writing the same workspace's index.
    pub lock: PathBuf,
    /// Per-workspace tokens dir. App-level surface (chan-server stores
    /// its bearer token here, mode 0600). chan-workspace only allocates
    /// the directory; it does not read or write inside.
    pub tokens: PathBuf,
    /// Per-workspace trash dir. Holds soft-deleted files / dirs as
    /// `<id>/{meta.json, payload[/]}`. Lazily GC'd on Workspace::open
    /// and on every trash_* call.
    pub trash: PathBuf,
    /// Per-workspace code/SLOC report. JSONL serialized by
    /// `chan-report`, persisted atomically by chan-workspace's
    /// ReportState writer thread. The report is regenerable from a
    /// full rescan if missing or corrupt.
    pub report: PathBuf,
}

/// Resolve the per-workspace paths for a metadata key under the process-wide
/// chan home. The key is the workspace's `KnownWorkspace.metadata_key`,
/// assigned at registration time and preserved across `Library::move_workspace`.
/// Callers that hold a `&Path` should look the key up through
/// `Library::workspace_paths_for` so an explicitly located Library uses its
/// own home and the registry remains the source of truth after moves.
pub fn workspace_paths_for_metadata_key(metadata_key: &str) -> WorkspacePaths {
    workspace_paths_for_metadata_key_in(&config_dir(), metadata_key)
}

pub(crate) fn workspace_paths_for_metadata_key_in(
    chan_home: &Path,
    metadata_key: &str,
) -> WorkspacePaths {
    let root = chan_home.join("workspaces").join(metadata_key);
    let graph_dir = root.join("graph");
    WorkspacePaths {
        root: root.clone(),
        sessions: root.join("sessions"),
        index: root.join("index"),
        graph_db: graph_dir.join("graph.sqlite"),
        graph_dir,
        lock: root.join("locks"),
        tokens: root.join("tokens"),
        trash: root.join("trash"),
        report: root.join("report").join("report.jsonl"),
    }
}

/// Create the standard per-workspace metadata directory skeleton under the
/// process-wide chan home. Library operations use their captured home instead.
pub fn ensure_workspace_metadata_dirs(metadata_key: &str) -> std::io::Result<WorkspacePaths> {
    ensure_workspace_metadata_dirs_in(&config_dir(), metadata_key)
}

pub(crate) fn ensure_workspace_metadata_dirs_in(
    chan_home: &Path,
    metadata_key: &str,
) -> std::io::Result<WorkspacePaths> {
    let paths = workspace_paths_for_metadata_key_in(chan_home, metadata_key);
    std::fs::create_dir_all(&paths.sessions)?;
    std::fs::create_dir_all(&paths.trash)?;
    std::fs::create_dir_all(paths.report.parent().expect("report has parent"))?;
    std::fs::create_dir_all(&paths.lock)?;
    std::fs::create_dir_all(&paths.graph_dir)?;
    std::fs::create_dir_all(&paths.index)?;
    std::fs::create_dir_all(&paths.tokens)?;
    Ok(paths)
}

/// Per-workspace metadata parent directories. Used by the orphan-sweep
/// path to walk metadata roots and reconcile against the registry's
/// metadata-key set. Returns absolute paths; it may not exist on a
/// fresh install, callers must handle that.
pub fn workspace_subsystem_dirs() -> Vec<PathBuf> {
    workspace_subsystem_dirs_in(&config_dir())
}

pub(crate) fn workspace_subsystem_dirs_in(chan_home: &Path) -> Vec<PathBuf> {
    vec![chan_home.join("workspaces")]
}

/// One cloud-storage provider's root the first-launch picker can
/// suggest as a chan workspace location. The `suggested_root` is the
/// concrete directory chan would land its workspace in (provider root
/// joined with "Chan" by convention so iOS / Android Files-app
/// users see a recognizable directory name across devices).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedCloud {
    /// User-facing label for the picker (e.g. "iCloud Drive",
    /// "Google Drive (alex@example.com)", "Dropbox").
    pub provider: String,
    /// Absolute path to the provider's mount point on this OS.
    pub provider_root: PathBuf,
    /// Recommended workspace location: provider_root joined with
    /// "Chan". Not created here; the picker decides whether to
    /// auto-init or prompt.
    pub suggested_root: PathBuf,
}

/// Probe the OS for known cloud-storage mount points and return
/// the ones that exist. Used by the first-launch workspace picker so
/// users on iCloud / Google Drive / Dropbox can land their workspace
/// somewhere syncing across devices instead of a local-only directory.
///
/// Per-OS coverage:
///
///   - macOS: iCloud Drive
///     (`~/Library/Mobile Documents/com~apple~CloudDocs`),
///     Google Drive
///     (`~/Library/CloudStorage/GoogleDrive-*/My Drive`, one
///     entry per signed-in account), Dropbox (`~/Dropbox`).
///   - Windows: iCloud Drive (`%USERPROFILE%\iCloudDrive`),
///     Google Drive (`G:\My Drive`, the default mapped workspace),
///     Dropbox (`%USERPROFILE%\Dropbox`).
///   - Linux: Dropbox (`~/Dropbox`); iCloud isn't available and
///     Google Drive on Linux ships through third-party tools
///     (Insync, rclone) with user-chosen paths chan can't predict.
///   - iOS / Android: empty list. The platform's own document
///     picker handles cloud-storage discovery.
///
/// Empty list = no cloud workspaces detected; the picker falls back to
/// prompting for an explicit local directory.
pub fn detected_cloud_drives() -> Vec<DetectedCloud> {
    let mut out = Vec::new();
    let Some(home) = dirs::home_dir() else {
        return out;
    };

    #[cfg(target_os = "macos")]
    {
        let icloud = home
            .join("Library")
            .join("Mobile Documents")
            .join("com~apple~CloudDocs");
        if icloud.is_dir() {
            out.push(DetectedCloud {
                provider: "iCloud Drive".into(),
                suggested_root: icloud.join("Chan"),
                provider_root: icloud,
            });
        }
        // Google Drive for Desktop mounts each signed-in account
        // under ~/Library/CloudStorage/GoogleDrive-<email>/My Drive.
        // Multiple accounts -> multiple picker entries.
        let cloud_storage = home.join("Library").join("CloudStorage");
        if let Ok(rd) = std::fs::read_dir(&cloud_storage) {
            for entry in rd.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if let Some(rest) = name.strip_prefix("GoogleDrive-") {
                    let my_drive = entry.path().join("My Drive");
                    if my_drive.is_dir() {
                        out.push(DetectedCloud {
                            provider: format!("Google Drive ({rest})"),
                            suggested_root: my_drive.join("Chan"),
                            provider_root: my_drive,
                        });
                    }
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let icloud = home.join("iCloudDrive");
        if icloud.is_dir() {
            out.push(DetectedCloud {
                provider: "iCloud Drive".into(),
                suggested_root: icloud.join("Chan"),
                provider_root: icloud,
            });
        }
        // Default G:\ mapping for Google Drive for Desktop.
        let g_my_drive = PathBuf::from("G:\\My Drive");
        if g_my_drive.is_dir() {
            out.push(DetectedCloud {
                provider: "Google Drive".into(),
                suggested_root: g_my_drive.join("Chan"),
                provider_root: g_my_drive,
            });
        }
    }

    let dropbox = home.join("Dropbox");
    if dropbox.is_dir() {
        out.push(DetectedCloud {
            provider: "Dropbox".into(),
            suggested_root: dropbox.join("Chan"),
            provider_root: dropbox,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn lexical_normalize_resolves_dots_without_the_filesystem() {
        use super::lexical_normalize;
        use std::path::{Path, PathBuf};
        assert_eq!(
            lexical_normalize(Path::new("/a/./b/../c/.")),
            PathBuf::from("/a/c")
        );
        assert_eq!(lexical_normalize(Path::new("/a/b/..")), PathBuf::from("/a"));
        assert_eq!(lexical_normalize(Path::new("/..")), PathBuf::from("/"));
        assert_eq!(
            lexical_normalize(Path::new("/a/nope/.")),
            PathBuf::from("/a/nope")
        );
        assert_eq!(lexical_normalize(Path::new("a/../b")), PathBuf::from("b"));
        assert_eq!(
            lexical_normalize(Path::new("/plain")),
            PathBuf::from("/plain")
        );
    }

    use super::*;

    #[cfg(windows)]
    fn test_home() -> PathBuf {
        PathBuf::from(r"C:\Users\chan-test")
    }

    #[cfg(not(windows))]
    fn test_home() -> PathBuf {
        PathBuf::from("/home/chan-test")
    }

    #[cfg(windows)]
    fn test_override_dir() -> PathBuf {
        PathBuf::from(r"C:\Temp\chan-home-test")
    }

    #[cfg(not(windows))]
    fn test_override_dir() -> PathBuf {
        PathBuf::from("/tmp/chan-home-test")
    }

    #[test]
    fn global_config_path_ends_in_config_toml() {
        let p = global_config_path();
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some("config.toml"));
    }

    #[test]
    fn config_dir_honors_chan_home_override() {
        let home = test_home();
        let expected_override = test_override_dir();
        let override_dir =
            chan_home_override_from(Some(expected_override.clone().into_os_string()));
        assert_eq!(
            config_dir_with_sources(override_dir, Some(home.clone())),
            expected_override
        );

        // Empty is treated as unset: the absolute home-based default, not cwd.
        let empty_override = chan_home_override_from(Some("".into()));
        let default = config_dir_with_sources(empty_override, Some(home.clone()));
        assert!(
            default.is_absolute(),
            "default chan home is absolute: {default:?}"
        );
        assert_eq!(default, home.join(".chan"));
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    #[test]
    fn config_dir_without_os_home_uses_named_absolute_fallback() {
        let fallback = config_dir_with_sources(None, None);
        assert!(
            fallback.is_absolute(),
            "fallback must be absolute: {fallback:?}"
        );
        assert_eq!(fallback, home_unavailable_config_dir());
    }

    #[test]
    fn local_bin_dir_honors_chan_home() {
        // Set: CHAN_HOME/.local/bin -- an isolated smoke instance's shims.
        assert_eq!(
            local_bin_dir_with_sources(Some(test_override_dir()), Some(test_home()),),
            Some(test_override_dir().join(".local").join("bin"))
        );

        // Unset: $HOME/.local/bin -- the standard user bin dir, NOT under `.chan`
        // (deliberately different from config_dir's `~/.chan` fallback).
        let home = test_home();
        let unset =
            local_bin_dir_with_sources(None, Some(home.clone())).expect("injected home resolves");
        assert_eq!(unset, home.join(".local").join("bin"));
        assert!(!unset.to_string_lossy().contains("/.chan"));
    }

    #[test]
    fn metadata_key_is_stable_and_path_slugged() {
        let tmp = tempfile::TempDir::new().unwrap();
        let k1 = metadata_key_for_root(tmp.path());
        let k2 = metadata_key_for_root(tmp.path());
        assert_eq!(k1, k2);
        assert!(k1.contains('-'));
        let suffix = k1.rsplit_once('-').unwrap().1;
        assert_eq!(suffix.len(), 8);
        assert!(suffix.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn metadata_key_keeps_example_readable_prefix() {
        let p = PathBuf::from("/home/hacker/dev/github.com/fiorix/chan");
        let key = metadata_key_for_root(&p);
        assert!(key.starts_with("-home-hacker-dev-github.com-fiorix-chan-"));
        assert_eq!(key.rsplit_once('-').unwrap().1.len(), 8);
    }

    #[test]
    fn strip_verbatim_prefix_removes_windows_extended_length_prefix() {
        // The disk-designator and UNC verbatim prefixes are stripped; a plain
        // path is unchanged. A pure string op, so it runs the same on every OS.
        assert_eq!(
            strip_verbatim_prefix(Path::new(r"\\?\C:\Users\me\proj")),
            PathBuf::from(r"C:\Users\me\proj")
        );
        assert_eq!(
            strip_verbatim_prefix(Path::new(r"\\?\UNC\server\share\proj")),
            PathBuf::from(r"\\server\share\proj")
        );
        assert_eq!(
            strip_verbatim_prefix(Path::new(r"C:\Users\me\proj")),
            PathBuf::from(r"C:\Users\me\proj")
        );
        assert_eq!(
            strip_verbatim_prefix(Path::new("/home/me/proj")),
            PathBuf::from("/home/me/proj")
        );
    }

    #[test]
    fn metadata_key_identical_across_verbatim_prefix() {
        // The CLI and the serving devserver must derive the SAME metadata key
        // (hence the same lock-record key) whether a process resolved the root
        // with or without the Windows `\\?\` prefix; otherwise `chan ps` keys
        // under one form and reads no PID under the other. Neither input is a
        // real path on the test host, so both take the normalized fallback and
        // must collapse to one key.
        let prefixed = Path::new(r"\\?\C:\Users\me\proj");
        let plain = Path::new(r"C:\Users\me\proj");
        assert_eq!(
            metadata_key_for_root(prefixed),
            metadata_key_for_root(plain)
        );
        assert_eq!(canonical_root_hash8(prefixed), canonical_root_hash8(plain));
    }

    #[test]
    fn workspace_paths_share_the_same_metadata_root() {
        let key = "-tmp-workspace-deadbeef";
        let p = workspace_paths_for_metadata_key(key);
        for path in [
            &p.sessions,
            &p.index,
            &p.lock,
            &p.tokens,
            &p.trash,
            &p.graph_dir,
        ] {
            assert!(path.starts_with(&p.root));
        }
        assert_eq!(p.root.file_name().and_then(|s| s.to_str()), Some(key));
    }

    #[test]
    fn workspace_subsystem_dirs_covers_each_sidecar_root() {
        let key = "-tmp-workspace-deadbeef";
        let p = workspace_paths_for_metadata_key(key);
        let dirs = workspace_subsystem_dirs();
        assert_eq!(dirs, vec![workspaces_dir()]);
        assert_eq!(p.root.parent(), Some(workspaces_dir().as_path()));
    }

    #[test]
    fn ensure_workspace_metadata_dirs_creates_expected_subdirs() {
        let key = format!("test-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap());
        let paths = ensure_workspace_metadata_dirs(&key).unwrap();
        for dir in [
            &paths.sessions,
            &paths.trash,
            paths.report.parent().unwrap(),
            &paths.lock,
            &paths.graph_dir,
            &paths.index,
            &paths.tokens,
        ] {
            assert!(dir.is_dir(), "metadata subdir missing: {dir:?}");
        }
        std::fs::remove_dir_all(paths.root).unwrap();
    }

    #[test]
    fn detected_cloud_drives_returns_a_list() {
        // Smoke test: just exercises the probe paths. Result depends
        // on the test machine's actual cloud-drive setup so we only
        // assert structural invariants (each entry has a non-empty
        // provider and a suggested_root that ends in "Chan" sitting
        // directly under provider_root).
        let workspaces = detected_cloud_drives();
        for d in &workspaces {
            assert!(!d.provider.is_empty());
            assert_eq!(
                d.suggested_root.file_name().and_then(|s| s.to_str()),
                Some("Chan"),
                "suggested_root should end in Chan: {:?}",
                d.suggested_root,
            );
            assert_eq!(d.suggested_root.parent(), Some(d.provider_root.as_path()));
        }
    }
}
