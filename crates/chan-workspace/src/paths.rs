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
/// registry + default-workspace). Uses `.chan` under the OS-provided home
/// on every platform.
///
/// `CHAN_HOME` overrides this with the directory to use IN PLACE OF `~/.chan`
/// (CARGO_HOME / GNUPGHOME semantics -- the dir itself, not a parent): set
/// `CHAN_HOME=/tmp/x` and chan reads its registry, devservers, and config under
/// `/tmp/x`, leaving the real `~/.chan` untouched (an isolated smoke instance).
/// Checked FIRST, so every delegator (`state_dir`, `cache_dir`,
/// `global_config_path`, `workspaces_dir`, …) inherits it. This is the SINGLE
/// authority for the chan home; nothing else resolves `~/.chan` independently.
/// If the OS cannot resolve a home directory, chan falls back to
/// `/var/tmp/chan-<uid>` on Unix and `C:\ProgramData\chan` on Windows, then
/// to a fresh private directory under a temp location, and only last to
/// `.chan` under the working directory; see `resolve_fallback_home`. The
/// choice is made once per process and logged.
pub fn config_dir() -> PathBuf {
    config_dir_with_sources(chan_home_override(), dirs::home_dir())
}

fn config_dir_with_sources(override_dir: Option<PathBuf>, home: Option<PathBuf>) -> PathBuf {
    config_dir_from(override_dir, home, home_unavailable_config_dir)
}

/// Resolve the chan home from an injected override, OS home and fallback.
/// Keeping these inputs explicit makes the unavailable-home branch testable
/// without mutating the process environment or touching the host's real
/// fallback locations.
fn config_dir_from(
    override_dir: Option<PathBuf>,
    home: Option<PathBuf>,
    fallback: impl FnOnce() -> PathBuf,
) -> PathBuf {
    if let Some(dir) = override_dir {
        return dir;
    }
    default_config_dir(home, fallback)
}

fn default_config_dir(home: Option<PathBuf>, fallback: impl FnOnce() -> PathBuf) -> PathBuf {
    home.map(|path| path.join(".chan")).unwrap_or_else(fallback)
}

#[cfg(unix)]
fn home_unavailable_config_dir() -> PathBuf {
    // Resolved once: the later steps make a fresh directory per call, and
    // one process must not scatter its state across several homes.
    static RESOLVED: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    RESOLVED
        .get_or_init(|| {
            let home = unix_fallback_home(
                Path::new("/var/tmp"),
                &std::env::temp_dir(),
                std::env::current_dir().ok().as_deref(),
                rustix::process::getuid().as_raw(),
            );
            home.report();
            home.path
        })
        .clone()
}

#[cfg(windows)]
fn home_unavailable_config_dir() -> PathBuf {
    static RESOLVED: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    RESOLVED
        .get_or_init(|| {
            let home = resolve_fallback_home(
                Path::new(r"C:\ProgramData\chan"),
                vet_windows_home,
                &[&std::env::temp_dir()],
                "chan-",
                std::env::current_dir().ok().as_deref(),
            );
            home.report();
            home.path
        })
        .clone()
}

/// Where chan put its home when the OS home could not be resolved, with
/// one line per location it refused on the way and one per caveat about the
/// location it took.
#[derive(Debug)]
struct FallbackHome {
    path: PathBuf,
    refused: Vec<String>,
    caveats: Vec<String>,
}

impl FallbackHome {
    fn report(&self) {
        for why in &self.refused {
            tracing::warn!("chan home fallback refused {why}");
        }
        for caveat in &self.caveats {
            tracing::warn!("chan home fallback: {caveat}");
        }
        tracing::warn!(
            "no OS home directory; using {} as the chan home",
            self.path.display()
        );
    }
}

/// The fallback chain, in order of preference. A broken system must never
/// stop chan from starting, so every step that fails is recorded and the
/// next one tried, and the last step cannot fail:
///
/// 1. `predictable`, accepted only if `vet` passes. It is the one location
///    a later run finds again, which keeps the registry and tokens across
///    restarts.
/// 2. A fresh directory under each of `fresh_parents`, made by mkdtemp, so
///    no other user can have prepared it. It is new per process, so state
///    kept there does not survive a restart.
/// 3. `.chan` under the working directory, where chan otherwise never keeps
///    state, created `0700` and absolute whenever the working directory can
///    be read. Nothing vets it, because nothing is left to fall back to; a
///    checkout used this way gains an untracked `.chan` holding the config
///    and its token. When the working directory cannot be read the path is
///    relative, and the caveat says so.
fn resolve_fallback_home(
    predictable: &Path,
    vet: impl Fn(&Path) -> Result<(), String>,
    fresh_parents: &[&Path],
    fresh_prefix: &str,
    cwd: Option<&Path>,
) -> FallbackHome {
    let mut refused = Vec::new();
    match vet(predictable) {
        Ok(()) => {
            return FallbackHome {
                path: predictable.to_path_buf(),
                refused,
                caveats: Vec::new(),
            }
        }
        Err(why) => refused.push(format!("{}: {why}", predictable.display())),
    }
    let mut tried: Vec<&Path> = Vec::new();
    for parent in fresh_parents {
        if tried.contains(parent) {
            continue;
        }
        tried.push(parent);
        let mut builder = tempfile::Builder::new();
        builder.prefix(fresh_prefix);
        // Private from creation rather than chmod'ed after it: the directory
        // is never visible under a laxer mode.
        #[cfg(unix)]
        builder.permissions(std::os::unix::fs::PermissionsExt::from_mode(0o700));
        match builder.tempdir_in(parent) {
            Ok(dir) => {
                return FallbackHome {
                    path: dir.keep(),
                    refused,
                    caveats: Vec::new(),
                }
            }
            Err(error) => refused.push(format!(
                "{}: cannot create a private directory there: {error}",
                parent.display()
            )),
        }
    }
    let mut caveats = Vec::new();
    let path = match cwd {
        Some(cwd) => {
            let path = cwd.join(".chan");
            if let Err(error) = create_private_dir(&path) {
                caveats.push(format!("cannot create {}: {error}", path.display()));
            }
            path
        }
        None => {
            // Nothing is created: with no readable working directory there
            // is no telling where a relative `.chan` would land.
            caveats.push(
                "the working directory could not be read, so the chan home `.chan` \
                 is relative to whatever directory chan runs in"
                    .to_string(),
            );
            PathBuf::from(".chan")
        }
    };
    FallbackHome {
        path,
        refused,
        caveats,
    }
}

/// Create `path` as a directory, `0700` on Unix; an existing one is left as
/// it is, since the last resort has nothing left to refuse it for.
fn create_private_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    match builder.create(path) {
        Err(error) if error.kind() != std::io::ErrorKind::AlreadyExists => Err(error),
        _ => Ok(()),
    }
}

/// The Unix chain: `/var/tmp/chan-<uid>`, then mkdtemp under `/var/tmp` and
/// the temp dir, then the working directory. `/var/tmp` is world-writable,
/// so another local user can create the predictable name first.
#[cfg(unix)]
fn unix_fallback_home(
    var_tmp: &Path,
    temp_dir: &Path,
    cwd: Option<&Path>,
    uid: u32,
) -> FallbackHome {
    resolve_fallback_home(
        &var_tmp.join(format!("chan-{uid}")),
        |path| vet_private_dir(path, uid),
        &[var_tmp, temp_dir],
        &format!("chan-{uid}-"),
        cwd,
    )
}

/// Make `path` a directory only `uid` can use, or say why it cannot be one:
/// create it `0700`, and accept an existing entry only when it is a real
/// directory owned by `uid`, tightening its mode if needed.
#[cfg(unix)]
fn vet_private_dir(path: &Path, uid: u32) -> Result<(), String> {
    use rustix::fs::{fchmod, fstat, lstat, mkdir, open, FileType, Mode, OFlags};
    use rustix::io::Errno;

    let describe = |errno: Errno| std::io::Error::from(errno).to_string();
    match mkdir(path, Mode::RWXU) {
        Ok(()) => {}
        Err(errno) if errno == Errno::EXIST => {}
        Err(errno) => return Err(format!("cannot create it: {}", describe(errno))),
    }
    let stat = lstat(path).map_err(|errno| format!("cannot stat it: {}", describe(errno)))?;
    match FileType::from_raw_mode(stat.st_mode) {
        FileType::Directory => {}
        FileType::Symlink => return Err("it is a symlink".to_string()),
        _ => return Err("it is not a directory".to_string()),
    }
    // Everything after the lstat goes through one descriptor that cannot
    // follow a link swapped in since, so the owner read and the mode change
    // both land on the directory that was checked.
    let dir = open(
        path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|errno| format!("cannot open it as a directory: {}", describe(errno)))?;
    let stat = fstat(&dir).map_err(|errno| format!("cannot stat it: {}", describe(errno)))?;
    if stat.st_uid != uid {
        return Err(format!("it is owned by uid {}", stat.st_uid));
    }
    if stat.st_mode & 0o777 != 0o700 {
        fchmod(&dir, Mode::RWXU).map_err(|errno| {
            format!(
                "it has mode {:o} and cannot be made private: {}",
                stat.st_mode & 0o777,
                describe(errno)
            )
        })?;
    }
    Ok(())
}

/// Windows vetting refuses a reparse point and a non-directory. It does not
/// read the owner: that needs the security API, and a subdirectory of
/// `C:\ProgramData` inherits an ACL that gives its creator full control and
/// other users read access only.
#[cfg(windows)]
fn vet_windows_home(path: &Path) -> Result<(), String> {
    match std::fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(format!("cannot create it: {error}")),
    }
    let meta =
        std::fs::symlink_metadata(path).map_err(|error| format!("cannot stat it: {error}"))?;
    if meta.file_type().is_symlink() {
        return Err("it is a symlink".to_string());
    }
    if !meta.is_dir() {
        return Err("it is not a directory".to_string());
    }
    Ok(())
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

    #[cfg(unix)]
    fn mode_of(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::symlink_metadata(path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777
    }

    #[cfg(unix)]
    fn uid() -> u32 {
        rustix::process::getuid().as_raw()
    }

    /// A private `var_tmp` and temp dir per test, so no test touches the
    /// host's real `/var/tmp`.
    #[cfg(unix)]
    struct FallbackFixture {
        _tmp: tempfile::TempDir,
        var_tmp: PathBuf,
        temp: PathBuf,
        cwd: PathBuf,
    }

    #[cfg(unix)]
    fn fallback_fixture() -> FallbackFixture {
        let tmp = tempfile::tempdir().unwrap();
        let var_tmp = tmp.path().join("var-tmp");
        let temp = tmp.path().join("temp");
        let cwd = tmp.path().join("cwd");
        for dir in [&var_tmp, &temp, &cwd] {
            std::fs::create_dir(dir).unwrap();
        }
        FallbackFixture {
            _tmp: tmp,
            var_tmp,
            temp,
            cwd,
        }
    }

    #[cfg(unix)]
    fn fresh_under(home: &FallbackHome, parent: &Path, uid: u32) -> bool {
        home.path.parent() == Some(parent)
            && home
                .path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(&format!("chan-{uid}-")))
            && home.path.is_dir()
            && mode_of(&home.path) == 0o700
    }

    #[cfg(unix)]
    #[test]
    fn the_fallback_home_is_created_private() {
        let fx = fallback_fixture();

        let home = unix_fallback_home(&fx.var_tmp, &fx.temp, Some(&fx.cwd), uid());

        assert_eq!(home.path, fx.var_tmp.join(format!("chan-{}", uid())));
        assert!(home.path.is_dir(), "the fallback home exists");
        assert_eq!(mode_of(&home.path), 0o700);
        assert!(home.refused.is_empty(), "{:?}", home.refused);
    }

    #[cfg(unix)]
    #[test]
    fn an_own_fallback_home_with_an_open_mode_is_made_private() {
        use std::os::unix::fs::PermissionsExt;
        let fx = fallback_fixture();
        let predictable = fx.var_tmp.join(format!("chan-{}", uid()));
        std::fs::create_dir(&predictable).unwrap();
        std::fs::set_permissions(&predictable, std::fs::Permissions::from_mode(0o755)).unwrap();

        let home = unix_fallback_home(&fx.var_tmp, &fx.temp, Some(&fx.cwd), uid());

        assert_eq!(home.path, predictable);
        assert_eq!(mode_of(&predictable), 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_fallback_home_is_refused_for_a_fresh_one() {
        let fx = fallback_fixture();
        let elsewhere = fx.cwd.join("attacker-owned");
        std::fs::create_dir(&elsewhere).unwrap();
        let predictable = fx.var_tmp.join(format!("chan-{}", uid()));
        std::os::unix::fs::symlink(&elsewhere, &predictable).unwrap();

        let home = unix_fallback_home(&fx.var_tmp, &fx.temp, Some(&fx.cwd), uid());

        assert!(
            fresh_under(&home, &fx.var_tmp, uid()),
            "a symlink is refused for a fresh private directory: {home:?}"
        );
        assert!(
            home.refused.iter().any(|why| why.contains("symlink")),
            "{:?}",
            home.refused
        );
        assert!(
            std::fs::read_dir(&elsewhere).unwrap().next().is_none(),
            "nothing is written through the symlink"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_fallback_home_owned_by_another_uid_is_refused_for_a_fresh_one() {
        let fx = fallback_fixture();
        // The fake uid is the check under test: the directory this process
        // creates is owned by its real uid, which is "another user" to it.
        let fake_uid = uid().wrapping_add(4242);
        let predictable = fx.var_tmp.join(format!("chan-{fake_uid}"));
        std::fs::create_dir(&predictable).unwrap();

        let home = unix_fallback_home(&fx.var_tmp, &fx.temp, Some(&fx.cwd), fake_uid);

        assert!(fresh_under(&home, &fx.var_tmp, fake_uid), "{home:?}");
        assert!(
            home.refused
                .iter()
                .any(|why| why.contains(&format!("owned by uid {}", uid()))),
            "{:?}",
            home.refused
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_fallback_home_that_is_a_file_is_refused_for_a_fresh_one() {
        let fx = fallback_fixture();
        let predictable = fx.var_tmp.join(format!("chan-{}", uid()));
        std::fs::write(&predictable, "not a directory").unwrap();

        let home = unix_fallback_home(&fx.var_tmp, &fx.temp, Some(&fx.cwd), uid());

        assert!(fresh_under(&home, &fx.var_tmp, uid()), "{home:?}");
        assert!(
            home.refused
                .iter()
                .any(|why| why.contains("not a directory")),
            "{:?}",
            home.refused
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_unusable_var_tmp_falls_back_to_the_temp_dir() {
        let fx = fallback_fixture();
        let missing = fx.var_tmp.join("missing");

        let home = unix_fallback_home(&missing, &fx.temp, Some(&fx.cwd), uid());

        assert!(fresh_under(&home, &fx.temp, uid()), "{home:?}");
        assert_eq!(home.refused.len(), 2, "{:?}", home.refused);
    }

    #[cfg(unix)]
    #[test]
    fn with_no_usable_temp_location_the_working_directory_is_the_last_resort() {
        let fx = fallback_fixture();
        let missing = fx.var_tmp.join("missing");

        let home = unix_fallback_home(&missing, &missing, Some(&fx.cwd), uid());

        assert_eq!(home.path, fx.cwd.join(".chan"));
        assert!(home.path.is_absolute());
        assert!(!home.refused.is_empty());
        assert!(home.path.is_dir(), "the last resort is created");
        assert_eq!(mode_of(&home.path), 0o700, "the last resort is private");
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_working_directory_is_logged_as_a_relative_last_resort() {
        let fx = fallback_fixture();
        let missing = fx.var_tmp.join("missing");

        let home = unix_fallback_home(&missing, &missing, None, uid());

        assert_eq!(home.path, PathBuf::from(".chan"));
        assert!(
            home.caveats
                .iter()
                .any(|why| why.contains("working directory could not be read")),
            "a relative last resort must be logged as one: {home:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn config_dir_without_os_home_uses_named_absolute_fallback() {
        let fx = fallback_fixture();
        let fallback = config_dir_from(None, None, || {
            unix_fallback_home(&fx.var_tmp, &fx.temp, Some(&fx.cwd), uid()).path
        });
        assert!(
            fallback.is_absolute(),
            "fallback must be absolute: {fallback:?}"
        );
        assert_eq!(fallback, fx.var_tmp.join(format!("chan-{}", uid())));
    }

    #[test]
    fn default_config_dir_uses_home_and_absolute_fallback() {
        let home = test_home();
        let fallback = test_override_dir();
        let resolved = [
            default_config_dir(Some(home.clone()), || fallback.clone()),
            default_config_dir(None, || fallback.clone()),
        ];
        assert_eq!(resolved, [home.join(".chan"), fallback]);
        assert!(resolved.iter().all(|path| path.is_absolute()));
        assert_eq!(
            default_config_dir(Some(home.clone()), || panic!("home must bypass fallback")),
            home.join(".chan"),
        );
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
