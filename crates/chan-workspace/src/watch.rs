// Filesystem watcher.
//
// Callback-based on purpose: makes the API uniffi-friendly (the
// FFI client passes a Swift / Kotlin object that implements the
// callback trait, no closures across the boundary). The native
// implementation uses `notify` and runs the watcher on its own
// thread; events are filtered through the active `IndexScopePolicy`
// so `.chan/` and most `.git/` / `.hg/` activity never reaches the
// callback. A tiny allowlist of VCS
// control files (`.git/HEAD`, `.git/index`, `.hg/dirstate`) is
// forwarded so the server indexer can recognize checkout storms and
// fall back to a full rebuild.
//
// On Linux the dispatch filter is only half the policy: registration
// is a manual filtered recursion (excluded subtrees never get an
// inotify watch at all). An owned supervisor picks up directories
// created after start, catch-up-scans moved-in trees, retries partial
// registration, and joins on stop. Other platforms use the backend's
// native recursive watch under the same lifecycle supervisor.
//
// Consumer expectations:
//
//   * No debouncing. A single editor save typically produces a
//     burst of events (Modify -> Rename -> Modify(metadata) etc.
//     on macOS; Create/Modify/Close on Linux). chan-workspace forwards
//     every one. Consumers that don't want to re-index per event
//     (most do) should debounce on their side, keyed by
//     `event.path`, with a small wall-clock window (50-200 ms is
//     typical).
//
//   * `WatchEvent.path == None` on `ProviderError` is a loss event:
//     the backend produced a path the workspace could not relativize
//     (usually one side of a rename across mount points). Treat it as
//     "something moved, scope unknown" and reconcile the workspace.
//
//   * `WatchKind::ProviderError` is the watcher's signal that the
//     event stream is no longer trustworthy: inotify queue
//     overflow, fseventsd hiccup, the watched dir vanishing. The
//     correct response is the same as for the "scope unknown"
//     case: drop caches and trigger a full reindex. The handle is
//     still alive after this event; further events may resume, or
//     the consumer can rebuild the watcher entirely.

use std::collections::HashSet;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::fs_ops::{IndexScopeDecision, IndexScopeExclusion, IndexScopePolicy};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WatchKind {
    Created,
    Modified,
    Removed,
    Renamed,
    /// The watcher backend itself errored. The consumer's callback
    /// is the only signal that the stream is no longer reliable;
    /// callers should treat this as a hint to drop their cached
    /// view (search index freshness, autocomplete) and trigger a
    /// full reindex. Common triggers: inotify watch limit hit,
    /// fseventsd hiccup, the watched directory being unmounted.
    /// `path` carries the backend's error message, or is `None` for
    /// path-loss events; `to` is unused.
    ProviderError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WatchEvent {
    pub kind: WatchKind,
    /// Path relative to the workspace root, POSIX-style. None when the
    /// event refers to a path outside the workspace root (rare; emitted
    /// only on best-effort). For `ProviderError` this carries the
    /// backend error message instead of a path.
    pub path: Option<String>,
    /// For Renamed events, the destination relative path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    /// True when the event target is a directory.
    #[serde(default)]
    pub is_dir: bool,
    /// Linux inotify rename correlation cookie. None for other backends,
    /// non-rename events, and synthetic events.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cookie: Option<u32>,
    /// Generated workspace scope sampled when this event was emitted.
    #[serde(default)]
    pub generation: crate::WorkspaceGeneration,
}

impl WatchEvent {
    pub fn file(
        kind: WatchKind,
        path: impl Into<String>,
        generation: crate::WorkspaceGeneration,
    ) -> Self {
        Self {
            kind,
            path: Some(path.into()),
            to: None,
            is_dir: false,
            cookie: None,
            generation,
        }
    }

    pub fn dir(
        kind: WatchKind,
        path: impl Into<String>,
        generation: crate::WorkspaceGeneration,
    ) -> Self {
        Self {
            kind,
            path: Some(path.into()),
            to: None,
            is_dir: true,
            cookie: None,
            generation,
        }
    }

    pub fn rename(
        from: Option<String>,
        to: Option<String>,
        is_dir: bool,
        cookie: Option<u32>,
        generation: crate::WorkspaceGeneration,
    ) -> Self {
        Self {
            kind: WatchKind::Renamed,
            path: from,
            to,
            is_dir,
            cookie,
            generation,
        }
    }

    pub fn loss(generation: crate::WorkspaceGeneration) -> Self {
        Self {
            kind: WatchKind::ProviderError,
            path: None,
            to: None,
            is_dir: false,
            cookie: None,
            generation,
        }
    }

    pub fn provider_error(
        message: impl Into<String>,
        generation: crate::WorkspaceGeneration,
    ) -> Self {
        Self {
            kind: WatchKind::ProviderError,
            path: Some(message.into()),
            to: None,
            is_dir: false,
            cookie: None,
            generation,
        }
    }
}

/// Implement on the consumer side. `Send + Sync` because events
/// arrive on the watcher's worker thread.
pub trait WatchCallback: Send + Sync {
    fn on_event(&self, event: WatchEvent);
}

/// One of possibly several roots the watcher is attached to. `abs`
/// is the absolute filesystem path being watched recursively;
/// `prefix` is the optional keyspace prefix prepended to relative
/// paths emitted for events under this root. The workspace root passes
/// `prefix: None`. The multi-root + prefix machinery is retained for
/// callers that need to watch an out-of-root tree under a synthetic
/// keyspace, but drafts no longer use it: they live in-root and emerge
/// through the single workspace-root watcher like any other file.
#[derive(Debug, Clone)]
pub struct WatchRoot {
    pub abs: PathBuf,
    pub prefix: Option<String>,
}

impl WatchRoot {
    /// Workspace-root convenience: no keyspace prefix.
    pub fn workspace(abs: &Path) -> Self {
        Self {
            abs: abs.to_path_buf(),
            prefix: None,
        }
    }
}

/// Coarse state of the owned watcher supervisor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WatchHealthState {
    Starting,
    Healthy,
    Degraded,
    Stopped,
}

/// Observable watcher registration and recovery status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WatchHealth {
    pub state: WatchHealthState,
    pub registration_failures: u64,
    pub provider_errors: u64,
    pub retry_attempts: u64,
    pub last_error: Option<String>,
}

impl WatchHealth {
    fn starting() -> Self {
        Self {
            state: WatchHealthState::Starting,
            registration_failures: 0,
            provider_errors: 0,
            retry_attempts: 0,
            last_error: None,
        }
    }
}

/// Holds the underlying watcher supervisor; drop stops and joins it.
pub struct WatchHandle {
    command_tx: std::sync::Mutex<Option<RegistrationTx>>,
    supervisor: std::sync::Mutex<Option<std::thread::JoinHandle<()>>>,
    health: Arc<std::sync::Mutex<WatchHealth>>,
    #[cfg(test)]
    registered_dirs: RegisteredDirs,
}

/// A directory-registration request from the dispatch thread to the
/// supervisor thread. The plan is computed dispatch-side (it has the
/// filter and the roots); the supervisor only executes it.
// Registration is a Linux-only path: non-Linux notify backends watch
// recursively and never build these per-directory records.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
struct DirRegistration {
    abs: PathBuf,
    rel: String,
    prefix: Option<String>,
    plan: DirPlan,
    generation: crate::WorkspaceGeneration,
    root_device: Option<u64>,
}

enum WatchCommand {
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    Register(DirRegistration),
    ProviderLost {
        message: String,
        #[cfg(test)]
        acknowledged: Option<std::sync::mpsc::SyncSender<()>>,
    },
    Stop,
}

/// Commands sent to the watcher supervisor. The sender is cheap to
/// clone; `send` never blocks the notify worker.
type RegistrationTx = std::sync::mpsc::Sender<WatchCommand>;

type ScopePolicySource = Arc<std::sync::RwLock<Arc<IndexScopePolicy>>>;
type RegisteredDirs = Arc<std::sync::RwLock<HashSet<PathBuf>>>;

struct WatchRegistrationScope {
    roots: Arc<Vec<WatchRoot>>,
    policy_source: ScopePolicySource,
    registered_dirs: RegisteredDirs,
}

/// Minimum spacing between surfaced stream-degradation events.
/// inotify queue overflow (notify's `EventKind::Other`) can repeat
/// for the whole storm, and every surfaced ProviderError is a
/// full-reconcile trigger downstream; one per second is plenty.
const DEGRADE_MIN_INTERVAL: Duration = Duration::from_secs(1);

const WATCH_RETRY_INTERVAL: Duration = Duration::from_millis(250);

/// Throttle state for stream-degradation events, one per WatchHandle.
/// The first degraded signal always passes; repeats inside
/// `DEGRADE_MIN_INTERVAL` collapse.
#[derive(Debug)]
struct DegradeThrottle(std::sync::Mutex<Option<Instant>>);

impl DegradeThrottle {
    fn new() -> Self {
        Self(std::sync::Mutex::new(None))
    }

    fn allow(&self, now: Instant) -> bool {
        let mut last = self.0.lock().unwrap();
        match *last {
            Some(t) if now.duration_since(t) < DEGRADE_MIN_INTERVAL => false,
            _ => {
                *last = Some(now);
                true
            }
        }
    }
}

/// Own the watcher, registration retries, and provider-loss recovery.
///
/// notify's Linux backend answers `watch()` through its event loop, so
/// registration cannot run inside the event callback. The same supervisor is
/// used on every platform to provide one stop-and-join lifecycle.
fn watch_supervisor_loop(
    rx: std::sync::mpsc::Receiver<WatchCommand>,
    mut watcher: RecommendedWatcher,
    scope: WatchRegistrationScope,
    cb: Arc<dyn WatchCallback>,
    health: Arc<std::sync::Mutex<WatchHealth>>,
    initial: std::sync::mpsc::SyncSender<()>,
) {
    let WatchRegistrationScope {
        roots,
        policy_source,
        registered_dirs,
    } = scope;
    let mut policy = Arc::clone(&policy_source.read().unwrap());
    let mut observed_generation = policy.generation();
    let errors = register_all_roots(&mut watcher, &roots, &policy, &registered_dirs);
    let mut retry_at = (!errors.is_empty()).then(|| Instant::now() + WATCH_RETRY_INTERVAL);
    record_registration_result(&health, errors, &*cb, policy.generation(), true);
    let _ = initial.send(());

    loop {
        let timeout = retry_at
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
            .unwrap_or(WATCH_RETRY_INTERVAL);
        let command = rx.recv_timeout(timeout);
        match command {
            Ok(WatchCommand::Register(registration)) => {
                policy = Arc::clone(&policy_source.read().unwrap());
                if registration.generation != policy.generation() {
                    continue;
                }
                let errors = register_dynamic_dir(
                    &mut watcher,
                    &registration,
                    &policy,
                    &registered_dirs,
                    &*cb,
                );
                if errors.is_empty() {
                    if retry_at.is_none() {
                        record_registration_result(
                            &health,
                            errors,
                            &*cb,
                            policy.generation(),
                            false,
                        );
                    }
                } else {
                    retry_at.get_or_insert_with(|| Instant::now() + WATCH_RETRY_INTERVAL);
                    record_registration_result(&health, errors, &*cb, policy.generation(), true);
                }
            }
            Ok(WatchCommand::ProviderLost {
                message,
                #[cfg(test)]
                acknowledged,
            }) => {
                {
                    let mut current = health.lock().unwrap();
                    current.state = WatchHealthState::Degraded;
                    current.provider_errors = current.provider_errors.saturating_add(1);
                    current.last_error = Some(message);
                }
                reset_registrations(&mut watcher, &registered_dirs);
                retry_at.get_or_insert_with(|| Instant::now() + WATCH_RETRY_INTERVAL);
                #[cfg(test)]
                if let Some(acknowledged) = acknowledged {
                    let _ = acknowledged.send(());
                }
            }
            Ok(WatchCommand::Stop) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                break;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) if retry_at.is_some() => {
                let mut current = health.lock().unwrap();
                current.retry_attempts = current.retry_attempts.saturating_add(1);
                drop(current);
                policy = Arc::clone(&policy_source.read().unwrap());
                if policy.generation() != observed_generation {
                    reset_registrations(&mut watcher, &registered_dirs);
                }
                observed_generation = policy.generation();
                let errors = register_all_roots(&mut watcher, &roots, &policy, &registered_dirs);
                retry_at = (!errors.is_empty()).then(|| Instant::now() + WATCH_RETRY_INTERVAL);
                record_registration_result(&health, errors, &*cb, policy.generation(), false);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                policy = Arc::clone(&policy_source.read().unwrap());
                if policy.generation() != observed_generation {
                    observed_generation = policy.generation();
                    reset_registrations(&mut watcher, &registered_dirs);
                    let errors =
                        register_all_roots(&mut watcher, &roots, &policy, &registered_dirs);
                    retry_at = (!errors.is_empty()).then(|| Instant::now() + WATCH_RETRY_INTERVAL);
                    record_registration_result(&health, errors, &*cb, policy.generation(), false);
                }
            }
        }
    }
    health.lock().unwrap().state = WatchHealthState::Stopped;
}

fn record_registration_result(
    health: &std::sync::Mutex<WatchHealth>,
    errors: Vec<String>,
    cb: &dyn WatchCallback,
    generation: crate::WorkspaceGeneration,
    surface_failure: bool,
) {
    if errors.is_empty() {
        let mut current = health.lock().unwrap();
        current.state = WatchHealthState::Healthy;
        current.last_error = None;
        return;
    }

    let message = errors
        .last()
        .cloned()
        .unwrap_or_else(|| "watch registration failed".to_string());
    {
        let mut current = health.lock().unwrap();
        current.state = WatchHealthState::Degraded;
        current.registration_failures = current
            .registration_failures
            .saturating_add(errors.len() as u64);
        current.last_error = Some(message.clone());
    }
    if surface_failure {
        safe_call(cb, WatchEvent::provider_error(message, generation));
    }
}

/// What to do with a directory encountered by the registration walk
/// or the new-directory tracker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
enum DirPlan {
    /// Never watch, never descend (`.chan`, excluded basenames).
    Skip,
    /// Watch the directory itself but never descend: VCS dirs, so
    /// `.git/HEAD` / `.git/index` / `.hg/dirstate` events keep flowing
    /// (the indexer keys checkout-storm detection off them) without
    /// registering the whole object store.
    WatchOnly,
    /// Watch and recurse.
    WatchAndDescend,
}

/// Registration policy for one directory. Only ever applied to
/// children of directories already accepted for descent, so ancestor
/// components are clean by construction; the checks here are about
/// the directory itself.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn plan_dir(rel: &str, name: &str, policy: &IndexScopePolicy) -> DirPlan {
    match policy.decision(rel, true) {
        IndexScopeDecision::Include => DirPlan::WatchAndDescend,
        IndexScopeDecision::VcsControl => DirPlan::WatchOnly,
        IndexScopeDecision::Exclude(IndexScopeExclusion::Hard)
            if matches!(name, ".git" | ".hg") =>
        {
            DirPlan::WatchOnly
        }
        IndexScopeDecision::Exclude(_) => DirPlan::Skip,
    }
}

#[cfg(test)]
struct InjectedRegistrationFailure {
    path: PathBuf,
    remaining: usize,
}

#[cfg(test)]
static INJECTED_REGISTRATION_FAILURE: std::sync::OnceLock<
    std::sync::Mutex<Option<InjectedRegistrationFailure>>,
> = std::sync::OnceLock::new();

#[cfg(test)]
fn inject_registration_failures(path: &Path, count: usize) {
    *INJECTED_REGISTRATION_FAILURE
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .unwrap() = Some(InjectedRegistrationFailure {
        path: path.to_path_buf(),
        remaining: count,
    });
}

#[cfg(test)]
fn clear_injected_registration_failure() {
    *INJECTED_REGISTRATION_FAILURE
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .unwrap() = None;
}

fn watch_registration(
    watcher: &mut RecommendedWatcher,
    abs: &Path,
    mode: RecursiveMode,
) -> notify::Result<()> {
    #[cfg(test)]
    {
        let mut injected = INJECTED_REGISTRATION_FAILURE
            .get_or_init(|| std::sync::Mutex::new(None))
            .lock()
            .unwrap();
        if let Some(failure) = injected.as_mut() {
            if failure.path == abs && failure.remaining > 0 {
                failure.remaining -= 1;
                return Err(notify::Error::generic(
                    "injected watcher registration failure",
                ));
            }
        }
    }
    watcher.watch(abs, mode)
}

fn register_all_roots(
    watcher: &mut RecommendedWatcher,
    roots: &[WatchRoot],
    policy: &IndexScopePolicy,
    registered_dirs: &RegisteredDirs,
) -> Vec<String> {
    let mut errors = Vec::new();
    for root in roots {
        register_root(watcher, root, policy, registered_dirs, &mut errors);
    }
    errors
}

fn reset_registrations(watcher: &mut RecommendedWatcher, registered_dirs: &RegisteredDirs) {
    let mut paths: Vec<PathBuf> = registered_dirs.write().unwrap().drain().collect();
    paths.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for path in paths {
        if let Err(error) = watcher.unwatch(&path) {
            tracing::debug!(%error, path = %path.display(), "watcher: unwatch during reset failed");
        }
    }
}

#[cfg(target_os = "linux")]
fn filesystem_device(path: &Path) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    std::fs::symlink_metadata(path)
        .ok()
        .map(|metadata| metadata.dev())
}

#[cfg(target_os = "linux")]
fn same_filesystem(root_device: Option<u64>, path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    same_device(
        root_device,
        std::fs::symlink_metadata(path)
            .ok()
            .map(|metadata| metadata.dev()),
    )
}

#[cfg(target_os = "linux")]
fn same_device(root_device: Option<u64>, candidate_device: Option<u64>) -> bool {
    matches!(
        (root_device, candidate_device),
        (Some(root), Some(candidate)) if root == candidate
    )
}

/// Linux: register `root` non-recursively, then walk and register
/// every accepted subdirectory ourselves. notify's blanket
/// RecursiveMode would register inotify watches on EVERY directory
/// including `node_modules`/`target`/`buck-out` subtrees the dispatch
/// filter then mutes -- pure descriptor and memory waste on build-
/// output trees, and what pushes big repos past the inotify limit.
#[cfg(target_os = "linux")]
fn register_root(
    watcher: &mut RecommendedWatcher,
    root: &WatchRoot,
    policy: &IndexScopePolicy,
    registered_dirs: &RegisteredDirs,
    errors: &mut Vec<String>,
) {
    register_one(
        watcher,
        &root.abs,
        "",
        RecursiveMode::NonRecursive,
        registered_dirs,
        errors,
    );
    let root_device = filesystem_device(&root.abs);
    register_subdirs(
        watcher,
        &root.abs,
        "",
        root_device,
        policy,
        registered_dirs,
        errors,
    );
}

#[cfg(target_os = "linux")]
fn register_subdirs(
    watcher: &mut RecommendedWatcher,
    abs: &Path,
    rel: &str,
    root_device: Option<u64>,
    policy: &IndexScopePolicy,
    registered_dirs: &RegisteredDirs,
    errors: &mut Vec<String>,
) {
    let entries = match std::fs::read_dir(abs) {
        Ok(entries) => entries,
        Err(error) => {
            errors.push(format!(
                "watcher: failed to scan directory {}: {error}",
                abs.display()
            ));
            tracing::warn!(%error, path = %rel, "watcher: failed to scan directory");
            return;
        }
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        // DirEntry::file_type does not follow symlinks: symlinked
        // directories are never registered, mirroring the walker's
        // no-follow rule.
        if !ft.is_dir() {
            continue;
        }
        if !same_filesystem(root_device, &entry.path()) {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let child_rel = if rel.is_empty() {
            name.to_string()
        } else {
            format!("{rel}/{name}")
        };
        match plan_dir(&child_rel, name, policy) {
            DirPlan::Skip => {}
            DirPlan::WatchOnly => register_one(
                watcher,
                &entry.path(),
                &child_rel,
                RecursiveMode::NonRecursive,
                registered_dirs,
                errors,
            ),
            DirPlan::WatchAndDescend => {
                register_one(
                    watcher,
                    &entry.path(),
                    &child_rel,
                    RecursiveMode::NonRecursive,
                    registered_dirs,
                    errors,
                );
                register_subdirs(
                    watcher,
                    &entry.path(),
                    &child_rel,
                    root_device,
                    policy,
                    registered_dirs,
                    errors,
                );
            }
        }
    }
}

fn register_one(
    watcher: &mut RecommendedWatcher,
    abs: &Path,
    rel: &str,
    mode: RecursiveMode,
    registered_dirs: &RegisteredDirs,
    errors: &mut Vec<String>,
) {
    if registered_dirs.read().unwrap().contains(abs) {
        return;
    }
    if let Err(error) = watch_registration(watcher, abs, mode) {
        errors.push(format!(
            "watcher: failed to register {}: {error}",
            abs.display()
        ));
        tracing::warn!(%error, path = %rel, "watcher: failed to register directory");
    } else {
        registered_dirs.write().unwrap().insert(abs.to_path_buf());
    }
}

/// Non-Linux: the backends (FSEvents, ReadDirectoryChanges) recurse
/// natively with no per-directory descriptor cost, so the blanket
/// recursive watch stays; the dispatch filter mutes excluded subtrees
/// there exactly as before.
#[cfg(not(target_os = "linux"))]
fn register_root(
    watcher: &mut RecommendedWatcher,
    root: &WatchRoot,
    _policy: &IndexScopePolicy,
    registered_dirs: &RegisteredDirs,
    errors: &mut Vec<String>,
) {
    register_one(
        watcher,
        &root.abs,
        "",
        RecursiveMode::Recursive,
        registered_dirs,
        errors,
    );
}

/// Linux: a directory that just appeared under a watched parent must
/// start streaming its subtree. The registration itself is queued
/// for the supervisor thread (see `watch_supervisor_loop` for why it cannot
/// happen on the notify worker). inotify does not replay pre-existing
/// contents of a moved-in tree either, so an accepted directory also
/// gets a catch-up scan there that synthesizes Created events for the
/// files already inside -- without it those files are invisible until
/// the next full reconcile (a gap the blanket recursive watch had
/// too).
#[cfg(target_os = "linux")]
fn track_new_dirs(
    roots: &[WatchRoot],
    policy: &IndexScopePolicy,
    reg_tx: &RegistrationTx,
    candidate: Option<&Path>,
) {
    let Some(abs) = candidate else { return };
    let Ok(meta) = std::fs::symlink_metadata(abs) else {
        return;
    };
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return;
    }
    let Some((root, rel)) = locate_root(roots, abs) else {
        return;
    };
    let Some(name) = abs.file_name().and_then(|n| n.to_str()) else {
        // The root itself; already watched at start.
        return;
    };
    if !same_filesystem(filesystem_device(&root.abs), abs) {
        return;
    }
    let plan = plan_dir(&rel, name, policy);
    if plan == DirPlan::Skip {
        return;
    }
    let _ = reg_tx.send(WatchCommand::Register(DirRegistration {
        abs: abs.to_path_buf(),
        rel,
        prefix: root.prefix.clone(),
        plan,
        generation: policy.generation(),
        root_device: filesystem_device(&root.abs),
    }));
}

/// Register accepted subdirectories of a newly appeared tree and
/// emit Created events for the regular files within, filtered exactly
/// like live dispatch. Runs on the supervisor thread; synthesized
/// events may race live ones (a file created in the new tree can
/// surface twice), the same duplicate class as a notify save burst.
#[cfg(target_os = "linux")]
fn register_dynamic_dir(
    watcher: &mut RecommendedWatcher,
    registration: &DirRegistration,
    policy: &IndexScopePolicy,
    registered_dirs: &RegisteredDirs,
    cb: &dyn WatchCallback,
) -> Vec<String> {
    let mut errors = Vec::new();
    register_one(
        watcher,
        &registration.abs,
        &registration.rel,
        RecursiveMode::NonRecursive,
        registered_dirs,
        &mut errors,
    );
    if registration.plan == DirPlan::WatchAndDescend {
        let mut catch_up = CatchUp {
            watcher,
            prefix: registration.prefix.as_deref(),
            root_device: registration.root_device,
            policy,
            registered_dirs,
            cb,
            errors: &mut errors,
        };
        catch_up.run(&registration.abs, &registration.rel);
    }
    errors
}

#[cfg(not(target_os = "linux"))]
fn register_dynamic_dir(
    _watcher: &mut RecommendedWatcher,
    _registration: &DirRegistration,
    _policy: &IndexScopePolicy,
    _registered_dirs: &RegisteredDirs,
    _cb: &dyn WatchCallback,
) -> Vec<String> {
    Vec::new()
}

#[cfg(target_os = "linux")]
struct CatchUp<'a> {
    watcher: &'a mut RecommendedWatcher,
    prefix: Option<&'a str>,
    root_device: Option<u64>,
    policy: &'a IndexScopePolicy,
    registered_dirs: &'a RegisteredDirs,
    cb: &'a dyn WatchCallback,
    errors: &'a mut Vec<String>,
}

#[cfg(target_os = "linux")]
impl CatchUp<'_> {
    fn run(&mut self, abs: &Path, rel: &str) {
        let Ok(entries) = std::fs::read_dir(abs) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let child_rel = format!("{rel}/{name}");
            if ft.is_dir() {
                if !same_filesystem(self.root_device, &entry.path()) {
                    continue;
                }
                match plan_dir(&child_rel, name, self.policy) {
                    DirPlan::Skip => {}
                    DirPlan::WatchOnly => register_one(
                        self.watcher,
                        &entry.path(),
                        &child_rel,
                        RecursiveMode::NonRecursive,
                        self.registered_dirs,
                        self.errors,
                    ),
                    DirPlan::WatchAndDescend => {
                        register_one(
                            self.watcher,
                            &entry.path(),
                            &child_rel,
                            RecursiveMode::NonRecursive,
                            self.registered_dirs,
                            self.errors,
                        );
                        self.run(&entry.path(), &child_rel);
                    }
                }
            } else if ft.is_file() && !is_filtered(&child_rel, false, self.policy) {
                safe_call(
                    self.cb,
                    WatchEvent::file(
                        WatchKind::Created,
                        apply_prefix(self.prefix, child_rel),
                        self.policy.generation(),
                    ),
                );
            }
        }
    }
}

impl WatchHandle {
    /// Attach the notify backend to one or more roots. Each root
    /// carries an optional keyspace prefix; the dispatcher relativizes
    /// events against whichever root they emerge under and prepends the
    /// prefix when set so the indexer sees a stable `<prefix>/<rel>`
    /// path. The workspace root is watched with no prefix (`<rel>`).
    /// Callers pass `&[WatchRoot::workspace(workspace_root)]`.
    ///
    /// `policy_source` is the same generation-aware policy sampled by
    /// bootstrap and indexing. Excluded events are dropped in the
    /// watcher worker before the consumer callback runs, and Linux
    /// registrations are rebuilt when the policy generation changes.
    pub(crate) fn start(
        roots: &[WatchRoot],
        policy_source: ScopePolicySource,
        cb: Arc<dyn WatchCallback>,
    ) -> Result<Self> {
        if roots.is_empty() {
            return Err(crate::error::ChanError::Io(
                "WatchHandle::start: at least one root required".into(),
            ));
        }
        let dispatch_roots: Arc<Vec<WatchRoot>> = Arc::new(roots.to_vec());
        let cb_clone = cb.clone();
        let dispatch_roots_for_cb = Arc::clone(&dispatch_roots);
        let policy_source_for_cb = Arc::clone(&policy_source);
        let registered_dirs: RegisteredDirs = Arc::new(std::sync::RwLock::new(HashSet::new()));
        #[cfg(test)]
        let registered_dirs_for_test = Arc::clone(&registered_dirs);
        let registered_dirs_for_cb = Arc::clone(&registered_dirs);
        let (command_tx, command_rx) = std::sync::mpsc::channel::<WatchCommand>();
        let command_tx_for_cb = command_tx.clone();
        let throttle_for_cb = Arc::new(DegradeThrottle::new());
        let watcher =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| match res {
                Ok(event) => dispatch(
                    &dispatch_roots_for_cb,
                    &policy_source_for_cb,
                    &registered_dirs_for_cb,
                    event,
                    &*cb_clone,
                    &command_tx_for_cb,
                    &throttle_for_cb,
                ),
                Err(e) => {
                    // notify backend errors (inotify queue overflow,
                    // fseventsd disconnect, watch path vanishing)
                    // mean the event stream is no longer trustworthy.
                    // Surface to the consumer so they can fall back
                    // to a full reindex; the previous behavior of
                    // logging-and-continuing left consumers silently
                    // stale.
                    tracing::warn!("watch error: {e}");
                    let message = e.to_string();
                    let generation = policy_source_for_cb.read().unwrap().generation();
                    safe_call(
                        &*cb_clone,
                        WatchEvent::provider_error(message.clone(), generation),
                    );
                    let _ = command_tx_for_cb.send(WatchCommand::ProviderLost {
                        message,
                        #[cfg(test)]
                        acknowledged: None,
                    });
                }
            })?;
        let health = Arc::new(std::sync::Mutex::new(WatchHealth::starting()));
        let supervisor_health = Arc::clone(&health);
        let (initial_tx, initial_rx) = std::sync::mpsc::sync_channel(1);
        let supervisor = std::thread::Builder::new()
            .name("chan-workspace::watch".to_string())
            .spawn(move || {
                watch_supervisor_loop(
                    command_rx,
                    watcher,
                    WatchRegistrationScope {
                        roots: dispatch_roots,
                        policy_source,
                        registered_dirs,
                    },
                    cb,
                    supervisor_health,
                    initial_tx,
                );
            })
            .map_err(|error| {
                crate::error::ChanError::Io(format!("spawn watcher supervisor: {error}"))
            })?;
        if initial_rx.recv().is_err() {
            let _ = supervisor.join();
            return Err(crate::error::ChanError::Io(
                "watcher supervisor exited during registration".to_string(),
            ));
        }
        Ok(Self {
            command_tx: std::sync::Mutex::new(Some(command_tx)),
            supervisor: std::sync::Mutex::new(Some(supervisor)),
            health,
            #[cfg(test)]
            registered_dirs: registered_dirs_for_test,
        })
    }

    /// Return a point-in-time snapshot of watcher health and retry counters.
    pub fn health(&self) -> WatchHealth {
        self.health.lock().unwrap().clone()
    }

    /// Stop and join the watcher supervisor. Idempotent.
    pub fn stop(&self) {
        if let Some(command_tx) = self.command_tx.lock().unwrap().take() {
            let _ = command_tx.send(WatchCommand::Stop);
        }
        self.join_supervisor();
    }

    /// Wait for watcher teardown, requesting stop first when needed.
    pub fn join(&self) {
        self.stop();
    }

    fn join_supervisor(&self) {
        if let Some(supervisor) = self.supervisor.lock().unwrap().take() {
            if supervisor.join().is_err() {
                tracing::warn!("watcher supervisor panicked");
                self.health.lock().unwrap().state = WatchHealthState::Stopped;
            }
        }
    }

    #[cfg(test)]
    fn inject_provider_loss(&self, message: &str) {
        let command_tx = self.command_tx.lock().unwrap().as_ref().cloned();
        let Some(command_tx) = command_tx else {
            return;
        };
        let (acknowledged, receiver) = std::sync::mpsc::sync_channel(1);
        if command_tx
            .send(WatchCommand::ProviderLost {
                message: message.to_string(),
                acknowledged: Some(acknowledged),
            })
            .is_ok()
        {
            let _ = receiver.recv();
        }
    }

    #[cfg(test)]
    fn is_registered(&self, path: &Path) -> bool {
        self.registered_dirs.read().unwrap().contains(path)
    }
}

impl Drop for WatchHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Find which `WatchRoot` an absolute filesystem path falls
/// under. Returns the root's index + the relative path beneath
/// it (without prefix yet). When several roots could match (one
/// nested inside another), the longer-path root wins -- practical
/// safeguard against drafts_dir being misconfigured under
/// workspace_root.
fn locate_root<'a>(roots: &'a [WatchRoot], abs: &Path) -> Option<(&'a WatchRoot, String)> {
    let mut best: Option<(&'a WatchRoot, String, usize)> = None;
    for root in roots {
        if let Some(rel) = relativize(&root.abs, abs) {
            let depth = root.abs.components().count();
            if best.as_ref().map(|(_, _, d)| depth > *d).unwrap_or(true) {
                best = Some((root, rel, depth));
            }
        }
    }
    best.map(|(r, rel, _)| (r, rel))
}

fn apply_prefix(prefix: Option<&str>, rel: String) -> String {
    match prefix {
        Some(p) if !p.is_empty() => format!("{p}/{rel}"),
        _ => rel,
    }
}

/// The directory a live event just made appear under a watched root,
/// if any. Rename modes matter: a MOVED_TO-only event carries the
/// destination in `paths[0]` (notify's `RenameMode::To`), a full
/// rename in `paths[1]`; a MOVED_FROM-only event means the tree left.
#[cfg(target_os = "linux")]
fn new_dir_candidate(kind: &notify::EventKind, paths: &[PathBuf]) -> Option<PathBuf> {
    use notify::event::{ModifyKind, RenameMode};
    use notify::EventKind;
    match kind {
        EventKind::Create(_) => paths.first().cloned(),
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => paths.get(1).cloned(),
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => paths.first().cloned(),
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => None,
        EventKind::Modify(ModifyKind::Name(_)) => {
            paths.get(1).cloned().or_else(|| paths.first().cloned())
        }
        _ => None,
    }
}

fn event_is_dir(event: &notify::Event, registered_dirs: &RegisteredDirs) -> bool {
    use notify::event::{CreateKind, RemoveKind};
    use notify::EventKind;
    match event.kind {
        EventKind::Create(CreateKind::Folder) | EventKind::Remove(RemoveKind::Folder) => true,
        EventKind::Create(CreateKind::File) | EventKind::Remove(RemoveKind::File) => false,
        _ => event
            .paths
            .iter()
            .rev()
            .find_map(|path| {
                std::fs::symlink_metadata(path)
                    .ok()
                    .map(|metadata| metadata.is_dir())
            })
            .or_else(|| {
                let registered = registered_dirs.read().unwrap();
                event
                    .paths
                    .iter()
                    .any(|path| registered.contains(path))
                    .then_some(true)
            })
            .unwrap_or(false),
    }
}

fn dispatch(
    roots: &[WatchRoot],
    policy_source: &ScopePolicySource,
    registered_dirs: &RegisteredDirs,
    event: notify::Event,
    cb: &dyn WatchCallback,
    reg_tx: &RegistrationTx,
    throttle: &DegradeThrottle,
) {
    use notify::EventKind;
    let policy = Arc::clone(&policy_source.read().unwrap());
    let generation = policy.generation();
    let is_dir = event_is_dir(&event, registered_dirs);
    #[cfg(target_os = "linux")]
    let cookie = event
        .tracker()
        .and_then(|tracker| u32::try_from(tracker).ok());
    #[cfg(not(target_os = "linux"))]
    let cookie = None;
    // Computed before the kind match moves `event.kind`: the rename
    // mode decides which path (if any) is the appeared directory.
    #[cfg(target_os = "linux")]
    let dir_candidate = new_dir_candidate(&event.kind, &event.paths);
    let kind = match event.kind {
        EventKind::Create(_) => WatchKind::Created,
        EventKind::Modify(notify::event::ModifyKind::Name(_)) => WatchKind::Renamed,
        EventKind::Modify(_) => WatchKind::Modified,
        EventKind::Remove(_) => WatchKind::Removed,
        // notify 6.1.1 delivers inotify queue overflow as
        // Ok(EventKind::Other): dropping it here meant the watcher
        // went silently stale (missed events, no rebuild trigger).
        // Surface it as ProviderError -- throttled, since overflow
        // repeats for the whole storm and every ProviderError is a
        // full-reconcile trigger downstream.
        EventKind::Other => {
            if throttle.allow(Instant::now()) {
                safe_call(
                    cb,
                    WatchEvent::provider_error(
                        "inotify queue overflow / watch stream degraded",
                        generation,
                    ),
                );
            }
            return;
        }
        _ => return,
    };
    let mut paths = event.paths.into_iter();
    let from = paths.next();
    let to = paths.next();

    // Linux: queue registration (and catch-up scan) for directories
    // that appeared under a watched parent, before the consumer
    // filter runs: the registration policy is independent of this one
    // event's fate.
    #[cfg(target_os = "linux")]
    track_new_dirs(roots, &policy, reg_tx, dir_candidate.as_deref());
    #[cfg(not(target_os = "linux"))]
    let _ = reg_tx;

    let from_resolved = from
        .as_deref()
        .and_then(|p| locate_root(roots, p))
        .map(|(root, rel)| (root.prefix.clone(), rel));
    let to_resolved = to
        .as_deref()
        .and_then(|p| locate_root(roots, p))
        .map(|(root, rel)| (root.prefix.clone(), rel));

    // Apply is_filtered against the RAW relative path (no prefix)
    // so the `.chan/` / `.git/` filters keep matching their
    // canonical shape. The prefixed path is the keyspace shape
    // the indexer consumes downstream.
    if from_resolved
        .as_ref()
        .map(|(_, rel)| is_filtered(rel, is_dir, &policy))
        .unwrap_or(false)
    {
        return;
    }
    if to_resolved
        .as_ref()
        .map(|(_, rel)| is_filtered(rel, is_dir, &policy))
        .unwrap_or(false)
    {
        return;
    }

    let from_rel = from_resolved.map(|(prefix, rel)| apply_prefix(prefix.as_deref(), rel));
    let to_rel = to_resolved.map(|(prefix, rel)| apply_prefix(prefix.as_deref(), rel));

    let watch_event = if kind == WatchKind::Renamed {
        if from_rel.is_none() && to_rel.is_none() {
            WatchEvent::loss(generation)
        } else {
            WatchEvent::rename(from_rel, to_rel, is_dir, cookie, generation)
        }
    } else if let Some(path) = from_rel {
        if is_dir {
            WatchEvent::dir(kind, path, generation)
        } else {
            WatchEvent::file(kind, path, generation)
        }
    } else {
        WatchEvent::loss(generation)
    };
    safe_call(cb, watch_event);
    if is_dir && matches!(kind, WatchKind::Removed | WatchKind::Renamed) {
        if let Some(from) = from.as_deref() {
            forget_registered_subtree(registered_dirs, from);
        }
    }
}

fn forget_registered_subtree(registered_dirs: &RegisteredDirs, root: &Path) {
    registered_dirs
        .write()
        .unwrap()
        .retain(|path| path != root && !path.starts_with(root));
}

/// Invoke the consumer's callback with one event, catching any
/// panic so the notify worker thread doesn't die. A panic in the
/// callback is turned into a `ProviderError` event so the consumer
/// learns the stream is suspect (the same signal we use for
/// inotify-queue-overflow and friends). Without this, a single
/// `unwrap` in user code stops every subsequent watcher event
/// silently and the editor's incremental indexer goes dark.
fn safe_call(cb: &dyn WatchCallback, event: WatchEvent) {
    // AssertUnwindSafe: we can't constrain consumer callbacks to
    // UnwindSafe (the WatchCallback trait is intentionally minimal),
    // and the alternative -- letting the panic unwind through
    // notify's worker -- silently kills the watcher. The consumer
    // is the one whose state may be left half-mutated by their own
    // panic; surfacing ProviderError gives them the chance to
    // recover via reindex.
    let generation = event.generation;
    if let Err(payload) = catch_unwind(AssertUnwindSafe(|| cb.on_event(event))) {
        let msg = panic_message(&payload);
        tracing::error!("watch callback panicked: {msg}");
        // Best-effort: if the panic-notification itself panics we
        // log and move on. The notify worker stays alive either way.
        let _ = catch_unwind(AssertUnwindSafe(|| {
            cb.on_event(WatchEvent::provider_error(
                format!("callback panicked: {msg}"),
                generation,
            ));
        }));
    }
}

fn panic_message(payload: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&'static str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

/// Drop policy for a workspace-relative watcher path. Mirrors the
/// bootstrap/index walk's pruning so the watcher feed and the walk
/// honor ONE ignore set, with two watcher-specific deviations:
///
///   - VCS control files (`.git/HEAD`, `.git/index`, `.hg/dirstate`)
///     are FORWARDED even though `.git`/`.hg` are excluded dirs: the
///     indexer keys checkout-storm detection off them. The walk has
///     no such need and prunes `.git`/`.hg` wholesale.
///   - `.chan/` is always dropped via `is_chan_internal` regardless
///     of the configurable filter set: it is chan's own state, an
///     internal invariant the user cannot un-exclude.
///
/// Everything else routes through the SAME `IndexScopePolicy` sampled
/// by bootstrap, indexing, report, and reconcile. That includes hard,
/// gitignore, and configured exclusions under one generation.
fn is_filtered(rel: &str, is_dir: bool, policy: &IndexScopePolicy) -> bool {
    matches!(policy.decision(rel, is_dir), IndexScopeDecision::Exclude(_))
}

fn relativize(root: &Path, p: &Path) -> Option<String> {
    let rel = p.strip_prefix(root).ok()?;
    Some(rel.to_string_lossy().replace('\\', "/"))
}

/// Re-exported for callers who want the absolute path that was
/// touched. Not currently surfaced through `WatchEvent`; add when
/// a consumer needs it.
#[allow(dead_code)]
pub(crate) fn _abs(root: &Path, rel: &str) -> PathBuf {
    root.join(rel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    /// A callback that panics on its first event, succeeds on the
    /// second. Used to verify the watcher thread survives a panic
    /// and that a synthetic ProviderError is emitted after.
    struct PanickyOnce {
        calls: AtomicUsize,
        events: Mutex<Vec<WatchEvent>>,
    }

    impl PanickyOnce {
        fn new() -> Self {
            Self {
                calls: AtomicUsize::new(0),
                events: Mutex::new(Vec::new()),
            }
        }
    }

    impl WatchCallback for PanickyOnce {
        fn on_event(&self, event: WatchEvent) {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            // Record every successful invocation, including the
            // ProviderError emitted after the panic so the test can
            // assert it landed.
            self.events.lock().unwrap().push(event.clone());
            if n == 0 {
                panic!("first-call panic");
            }
        }
    }

    #[test]
    fn callback_panic_is_caught_and_surfaces_provider_error() {
        let cb = PanickyOnce::new();
        // First call: panics inside the callback. safe_call must
        // recover; the ProviderError emitted afterwards is the
        // second invocation and lands successfully.
        safe_call(
            &cb,
            WatchEvent::file(
                WatchKind::Modified,
                "a.md",
                crate::WorkspaceGeneration::INITIAL,
            ),
        );
        // Third call: a normal event after the panic. Must land,
        // proving the worker (modeled here as the test thread) is
        // alive.
        safe_call(
            &cb,
            WatchEvent::file(
                WatchKind::Modified,
                "b.md",
                crate::WorkspaceGeneration::INITIAL,
            ),
        );
        let events = cb.events.lock().unwrap();
        assert!(
            events.len() >= 2,
            "expected at least 2 events; got {events:?}"
        );
        // First recorded event is the one that triggered the panic
        // (callback panicked AFTER the push because we record then
        // panic). The next event must be the synthetic ProviderError.
        assert_eq!(events[0].kind, WatchKind::Modified);
        assert_eq!(events[1].kind, WatchKind::ProviderError);
        assert!(
            events[1]
                .path
                .as_deref()
                .map(|s| s.contains("callback panicked"))
                .unwrap_or(false),
            "ProviderError path should describe the panic: {:?}",
            events[1].path,
        );
        // Subsequent normal event lands.
        assert_eq!(events.last().unwrap().kind, WatchKind::Modified);
        assert_eq!(events.last().unwrap().path.as_deref(), Some("b.md"));
    }

    /// Mirror the registry's DEFAULT_INDEX_EXCLUDED_DIRS so the test
    /// exercises the exact set the walk uses at runtime.
    fn default_policy(root: &Path) -> IndexScopePolicy {
        IndexScopePolicy::new(
            root.to_path_buf(),
            crate::WorkspaceGeneration::INITIAL,
            crate::WalkFilter::new(crate::registry::DEFAULT_INDEX_EXCLUDED_DIRS.iter().copied()),
        )
        .unwrap()
    }

    fn policy_source(root: &Path) -> ScopePolicySource {
        Arc::new(std::sync::RwLock::new(Arc::new(default_policy(root))))
    }

    fn registered_dirs() -> RegisteredDirs {
        Arc::new(std::sync::RwLock::new(HashSet::new()))
    }

    fn filtered(rel: &str, policy: &IndexScopePolicy) -> bool {
        is_filtered(rel, true, policy)
    }

    #[test]
    fn filter_allows_vcs_control_paths_but_hides_other_vcs_noise() {
        let f = default_policy(Path::new("/workspace"));
        // VCS control files forwarded (checkout-storm detection).
        assert!(!filtered(".git/HEAD", &f));
        assert!(!filtered(".git/index", &f));
        assert!(!filtered(".hg/dirstate", &f));
        // The rest of the VCS dirs are dropped via the excluded-dir set.
        assert!(filtered(".git/objects/pack/foo", &f));
        assert!(filtered(".hg/store/data/foo", &f));
        // The dir entries themselves are noise too.
        assert!(filtered(".git", &f));
        assert!(filtered(".hg", &f));
    }

    #[test]
    fn filter_drops_unified_ignore_set_at_any_depth() {
        let f = default_policy(Path::new("/workspace"));
        // node_modules / target / venv at the top level.
        assert!(filtered("node_modules", &f));
        assert!(filtered("node_modules/react/index.js", &f));
        assert!(filtered("target", &f));
        assert!(filtered("target/debug/build/foo.rs", &f));
        assert!(filtered("venv", &f));
        assert!(filtered("venv/lib/python3.11/site-packages/x.py", &f));
        assert!(filtered(".venv/pyvenv.cfg", &f));
        // Nested deeper than the top level: a node_modules under a
        // subproject must also prune (basename match at any depth).
        assert!(filtered("frontend/node_modules/pkg/dist/a.js", &f));
        assert!(filtered("a/b/target/release/x", &f));
        assert!(filtered("svc/__pycache__/mod.cpython-311.pyc", &f));
        // .chan is always dropped regardless of the filter set.
        assert!(filtered(".chan/index/meta.json", &f));
    }

    #[test]
    fn filter_keeps_real_notes_and_source() {
        let f = default_policy(Path::new("/workspace"));
        // Real content must pass through untouched.
        assert!(!filtered("README.md", &f));
        assert!(!filtered("docs/design.md", &f));
        assert!(!filtered("src/main.rs", &f));
        // A file merely NAMED like an excluded dir (but a file, not a
        // dir-in-the-path) only prunes when the basename matches; that
        // is intended -- a file literally named `target` is index noise
        // the same way the dir is. A file whose name CONTAINS the token
        // but is not equal (e.g. `targeting.md`) is kept.
        assert!(!filtered("notes/targeting.md", &f));
        assert!(!filtered("node_modules_notes.md", &f));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn registration_device_boundary_is_fail_closed() {
        assert!(same_device(Some(7), Some(7)));
        assert!(!same_device(Some(7), Some(8)));
        assert!(!same_device(Some(7), None));
        assert!(!same_device(None, Some(7)));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn dynamic_registration_rejects_symlinked_directory() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let link = root.path().join("linked");
        symlink(outside.path(), &link).unwrap();
        let roots = [WatchRoot::workspace(root.path())];
        let policy = default_policy(root.path());
        let (tx, rx) = std::sync::mpsc::channel();

        track_new_dirs(&roots, &policy, &tx, Some(&link));

        assert!(
            matches!(rx.try_recv(), Err(std::sync::mpsc::TryRecvError::Empty)),
            "symlinked directory must never enter the registration queue"
        );
    }

    #[test]
    fn watch_event_constructors_and_legacy_defaults_are_stable() {
        let generation: crate::WorkspaceGeneration = serde_json::from_str("7").unwrap();

        let file = WatchEvent::file(WatchKind::Modified, "note.md", generation);
        assert_eq!(file.kind, WatchKind::Modified);
        assert_eq!(file.path.as_deref(), Some("note.md"));
        assert!(!file.is_dir);
        assert_eq!(file.cookie, None);
        assert_eq!(file.generation, generation);

        let dir = WatchEvent::dir(WatchKind::Created, "folder", generation);
        assert!(dir.is_dir);

        let rename = WatchEvent::rename(
            Some("before".to_string()),
            Some("after".to_string()),
            true,
            Some(41),
            generation,
        );
        assert_eq!(rename.kind, WatchKind::Renamed);
        assert_eq!(rename.path.as_deref(), Some("before"));
        assert_eq!(rename.to.as_deref(), Some("after"));
        assert!(rename.is_dir);
        assert_eq!(rename.cookie, Some(41));

        let loss = WatchEvent::loss(generation);
        assert_eq!(loss.kind, WatchKind::ProviderError);
        assert_eq!(loss.path, None);
        assert_eq!(loss.to, None);

        let error = WatchEvent::provider_error("backend failed", generation);
        assert_eq!(error.path.as_deref(), Some("backend failed"));

        let legacy: WatchEvent =
            serde_json::from_str(r#"{"kind":"Modified","path":"old.md"}"#).unwrap();
        assert!(!legacy.is_dir);
        assert_eq!(legacy.cookie, None);
        assert_eq!(legacy.generation, crate::WorkspaceGeneration::INITIAL);
    }

    #[test]
    fn dispatch_drops_excluded_subtree_events() {
        use std::sync::Mutex;
        struct Collect(Mutex<Vec<WatchEvent>>);
        impl WatchCallback for Collect {
            fn on_event(&self, e: WatchEvent) {
                self.0.lock().unwrap().push(e);
            }
        }
        let cb = Collect(Mutex::new(Vec::new()));
        let root = PathBuf::from("/workspace");
        let policy_source = policy_source(&root);
        let roots = [WatchRoot::workspace(&root)];
        let registered = registered_dirs();
        let (reg_tx, _reg_rx) = std::sync::mpsc::channel();
        let throttle = DegradeThrottle::new();

        // A modify under node_modules: dropped, callback never fires.
        dispatch(
            &roots,
            &policy_source,
            &registered,
            notify::Event {
                kind: notify::EventKind::Modify(notify::event::ModifyKind::Data(
                    notify::event::DataChange::Content,
                )),
                paths: vec![root.join("node_modules/react/index.js")],
                attrs: Default::default(),
            },
            &cb,
            &reg_tx,
            &throttle,
        );
        assert!(
            cb.0.lock().unwrap().is_empty(),
            "node_modules event should be dropped before the callback"
        );

        // A modify on a real note: forwarded.
        dispatch(
            &roots,
            &policy_source,
            &registered,
            notify::Event {
                kind: notify::EventKind::Modify(notify::event::ModifyKind::Data(
                    notify::event::DataChange::Content,
                )),
                paths: vec![root.join("notes/today.md")],
                attrs: Default::default(),
            },
            &cb,
            &reg_tx,
            &throttle,
        );
        let events = cb.0.lock().unwrap();
        assert_eq!(events.len(), 1, "real note event should be forwarded");
        assert_eq!(events[0].path.as_deref(), Some("notes/today.md"));
        assert!(!events[0].is_dir);
        assert_eq!(events[0].cookie, None);
        assert_eq!(
            events[0].generation,
            policy_source.read().unwrap().generation()
        );
        drop(events);

        dispatch(
            &roots,
            &policy_source,
            &registered,
            notify::Event {
                kind: notify::EventKind::Modify(notify::event::ModifyKind::Data(
                    notify::event::DataChange::Content,
                )),
                paths: vec![PathBuf::from("/outside/workspace.md")],
                attrs: Default::default(),
            },
            &cb,
            &reg_tx,
            &throttle,
        );
        let events = cb.0.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].kind, WatchKind::ProviderError);
        assert_eq!(events[1].path, None);
    }

    #[test]
    fn dispatch_populates_directory_rename_cookie_and_generation() {
        use std::sync::Mutex;
        struct Collect(Mutex<Vec<WatchEvent>>);
        impl WatchCallback for Collect {
            fn on_event(&self, event: WatchEvent) {
                self.0.lock().unwrap().push(event);
            }
        }

        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("after")).unwrap();
        let generation: crate::WorkspaceGeneration = serde_json::from_str("9").unwrap();
        let policy = Arc::new(
            IndexScopePolicy::new(
                root.path().to_path_buf(),
                generation,
                crate::WalkFilter::default(),
            )
            .unwrap(),
        );
        let policy_source = Arc::new(std::sync::RwLock::new(policy));
        let roots = [WatchRoot::workspace(root.path())];
        let registered = registered_dirs();
        let (reg_tx, _reg_rx) = std::sync::mpsc::channel();
        let throttle = DegradeThrottle::new();
        let cb = Collect(Mutex::new(Vec::new()));
        let mut event = notify::Event {
            kind: notify::EventKind::Modify(notify::event::ModifyKind::Name(
                notify::event::RenameMode::Both,
            )),
            paths: vec![root.path().join("before"), root.path().join("after")],
            attrs: Default::default(),
        };
        event.attrs.set_tracker(41);

        dispatch(
            &roots,
            &policy_source,
            &registered,
            event,
            &cb,
            &reg_tx,
            &throttle,
        );

        let events = cb.0.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert!(events[0].is_dir);
        assert_eq!(events[0].generation, generation);
        #[cfg(target_os = "linux")]
        assert_eq!(events[0].cookie, Some(41));
        #[cfg(not(target_os = "linux"))]
        assert_eq!(events[0].cookie, None);
        drop(events);

        let vanished = root.path().join("vanished-dir");
        registered.write().unwrap().insert(vanished.clone());
        let mut from_only = notify::Event {
            kind: notify::EventKind::Modify(notify::event::ModifyKind::Name(
                notify::event::RenameMode::From,
            )),
            paths: vec![vanished],
            attrs: Default::default(),
        };
        from_only.attrs.set_tracker(73);
        dispatch(
            &roots,
            &policy_source,
            &registered,
            from_only,
            &cb,
            &reg_tx,
            &throttle,
        );

        let events = cb.0.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert!(
            events[1].is_dir,
            "registered directory identity must survive a From-only rename"
        );
        #[cfg(target_os = "linux")]
        assert_eq!(events[1].cookie, Some(73));
    }

    #[test]
    fn other_kind_surfaces_throttled_provider_error() {
        use std::sync::Mutex;
        struct Collect(Mutex<Vec<WatchEvent>>);
        impl WatchCallback for Collect {
            fn on_event(&self, e: WatchEvent) {
                self.0.lock().unwrap().push(e);
            }
        }
        let cb = Collect(Mutex::new(Vec::new()));
        let root = PathBuf::from("/workspace");
        let policy_source = policy_source(&root);
        let roots = [WatchRoot::workspace(&root)];
        let registered = registered_dirs();
        let (reg_tx, _reg_rx) = std::sync::mpsc::channel();
        let throttle = DegradeThrottle::new();
        let other = || notify::Event {
            kind: notify::EventKind::Other,
            paths: vec![],
            attrs: Default::default(),
        };

        // First overflow signal: surfaced as ProviderError (the
        // consumers' full-reconcile trigger).
        dispatch(
            &roots,
            &policy_source,
            &registered,
            other(),
            &cb,
            &reg_tx,
            &throttle,
        );
        // An immediate repeat collapses into the throttle window.
        dispatch(
            &roots,
            &policy_source,
            &registered,
            other(),
            &cb,
            &reg_tx,
            &throttle,
        );

        let events = cb.0.lock().unwrap();
        assert_eq!(events.len(), 1, "repeat overflow must be throttled");
        assert_eq!(events[0].kind, WatchKind::ProviderError);
        assert!(events[0].path.as_deref().unwrap_or("").contains("overflow"));
    }

    #[test]
    fn degrade_throttle_passes_first_then_collapses_then_passes() {
        let throttle = DegradeThrottle::new();
        let t0 = Instant::now();
        assert!(throttle.allow(t0), "first signal always passes");
        assert!(!throttle.allow(t0 + DEGRADE_MIN_INTERVAL / 2));
        assert!(throttle.allow(t0 + DEGRADE_MIN_INTERVAL + Duration::from_millis(1)));
    }

    // ---- Linux filtered-registration suite -------------------------

    #[cfg(target_os = "linux")]
    mod filtered_registration {
        use super::*;
        use std::sync::mpsc::{channel, Receiver};
        use std::time::{Duration, Instant};
        use tempfile::TempDir;

        struct Channel(std::sync::Mutex<std::sync::mpsc::Sender<WatchEvent>>);
        impl WatchCallback for Channel {
            fn on_event(&self, e: WatchEvent) {
                let _ = self.0.lock().unwrap().send(e);
            }
        }

        fn start_handle(root: &TempDir) -> (WatchHandle, Receiver<WatchEvent>) {
            start_handle_with_policy(root, policy_source(root.path()))
        }

        fn start_handle_with_policy(
            root: &TempDir,
            policy: ScopePolicySource,
        ) -> (WatchHandle, Receiver<WatchEvent>) {
            let (tx, rx) = channel();
            let cb = Channel(std::sync::Mutex::new(tx));
            let roots = [WatchRoot::workspace(root.path())];
            let handle = WatchHandle::start(&roots, policy, Arc::new(cb)).expect("watcher starts");
            (handle, rx)
        }

        /// Collect events until `deadline`, returning everything seen.
        fn drain(rx: &Receiver<WatchEvent>, deadline: Duration) -> Vec<WatchEvent> {
            let start = Instant::now();
            let mut out = Vec::new();
            while start.elapsed() < deadline {
                if let Ok(e) = rx.recv_timeout(Duration::from_millis(100)) {
                    out.push(e);
                }
            }
            out
        }

        /// Wait until an event matching `pred` shows up (or the
        /// deadline lapses and the collected events are returned for
        /// a useful assertion message).
        fn wait_for(
            rx: &Receiver<WatchEvent>,
            deadline: Duration,
            pred: impl Fn(&WatchEvent) -> bool,
        ) -> Option<WatchEvent> {
            let start = Instant::now();
            while start.elapsed() < deadline {
                match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(e) if pred(&e) => return Some(e),
                    Ok(_) => {}
                    Err(_) => {}
                }
            }
            None
        }

        #[test]
        fn excluded_subtree_is_never_watched() {
            let root = TempDir::new().unwrap();
            std::fs::create_dir_all(root.path().join("buck-out/gen")).unwrap();
            std::fs::create_dir_all(root.path().join("src")).unwrap();
            let (_h, rx) = start_handle(&root);
            // Registration settled (give the worker a beat), then write.
            std::thread::sleep(Duration::from_millis(300));
            std::fs::write(root.path().join("buck-out/gen/out.txt"), "x").unwrap();
            std::fs::write(root.path().join("src/real.md"), "x").unwrap();

            let seen = wait_for(&rx, Duration::from_secs(5), |e| {
                e.path.as_deref() == Some("src/real.md")
            });
            assert!(seen.is_some(), "event for src/real.md must arrive");
            let strays = drain(&rx, Duration::from_millis(500));
            assert!(
                !strays
                    .iter()
                    .any(|e| e.path.as_deref().unwrap_or("").starts_with("buck-out")),
                "excluded subtree must stay dark: {strays:?}"
            );
        }

        #[test]
        fn gitignore_only_subtree_is_never_registered_or_dispatched() {
            let root = TempDir::new().unwrap();
            let ignored = root.path().join("vendor");
            std::fs::create_dir_all(&ignored).unwrap();
            std::fs::write(root.path().join(".gitignore"), "vendor/\n").unwrap();
            inject_registration_failures(&ignored, 1);
            let policy = Arc::new(
                IndexScopePolicy::new(
                    root.path().to_path_buf(),
                    crate::WorkspaceGeneration::INITIAL,
                    crate::WalkFilter::default(),
                )
                .unwrap(),
            );
            let source = Arc::new(std::sync::RwLock::new(policy));

            let (handle, rx) = start_handle_with_policy(&root, source);
            let initial_health = handle.health();
            clear_injected_registration_failure();
            assert_eq!(
                initial_health.state,
                WatchHealthState::Healthy,
                "gitignored directory reached Linux registration"
            );

            std::fs::write(ignored.join("dark.md"), "dark").unwrap();
            std::fs::write(root.path().join("visible.md"), "visible").unwrap();
            assert!(
                wait_for(&rx, Duration::from_secs(5), |event| {
                    event.path.as_deref() == Some("visible.md")
                })
                .is_some(),
                "included control event must arrive"
            );
            let strays = drain(&rx, Duration::from_millis(500));
            assert!(
                !strays.iter().any(|event| {
                    event
                        .path
                        .as_deref()
                        .is_some_and(|path| path.starts_with("vendor/"))
                }),
                "gitignored subtree leaked through dispatch: {strays:?}"
            );
        }

        #[test]
        fn unrelated_gitignore_negation_does_not_register_configured_subtree() {
            let root = TempDir::new().unwrap();
            let target = root.path().join("target");
            std::fs::create_dir_all(target.join("deep")).unwrap();
            std::fs::create_dir_all(root.path().join("docs")).unwrap();
            std::fs::write(root.path().join(".gitignore"), "!/docs/keep.md\n").unwrap();
            inject_registration_failures(&target, 1);
            let policy = Arc::new(
                IndexScopePolicy::new(
                    root.path().to_path_buf(),
                    crate::WorkspaceGeneration::INITIAL,
                    crate::WalkFilter::new(["target"]),
                )
                .unwrap(),
            );
            let source = Arc::new(std::sync::RwLock::new(policy));

            let (handle, _rx) = start_handle_with_policy(&root, source);
            let initial_health = handle.health();
            clear_injected_registration_failure();
            assert_eq!(
                initial_health.state,
                WatchHealthState::Healthy,
                "docs-only negation widened registration into configured target/"
            );
            assert!(!handle.is_registered(&target));
        }

        #[test]
        fn policy_change_during_retry_resets_stale_registrations() {
            let root = TempDir::new().unwrap();
            let stale = root.path().join("stale");
            let retry = root.path().join("retry-me");
            std::fs::create_dir_all(&stale).unwrap();
            std::fs::create_dir_all(&retry).unwrap();
            inject_registration_failures(&retry, 1);
            let source = policy_source(root.path());

            let (handle, _rx) = start_handle_with_policy(&root, Arc::clone(&source));
            assert_eq!(handle.health().state, WatchHealthState::Degraded);
            assert!(handle.is_registered(&stale));

            let next_generation: crate::WorkspaceGeneration = serde_json::from_str("1").unwrap();
            *source.write().unwrap() = Arc::new(
                IndexScopePolicy::new(
                    root.path().to_path_buf(),
                    next_generation,
                    crate::WalkFilter::new(["stale"]),
                )
                .unwrap(),
            );

            let deadline = Instant::now() + Duration::from_secs(5);
            while handle.health().state != WatchHealthState::Healthy && Instant::now() < deadline {
                std::thread::yield_now();
            }
            clear_injected_registration_failure();
            assert_eq!(handle.health().state, WatchHealthState::Healthy);
            assert!(
                !handle.is_registered(&stale),
                "retry consumed the policy generation without resetting stale watches"
            );
        }

        #[test]
        fn new_included_dir_streams_and_new_excluded_dir_stays_dark() {
            let root = TempDir::new().unwrap();
            let (_h, rx) = start_handle(&root);
            std::thread::sleep(Duration::from_millis(300));
            // A directory created AFTER start must start streaming:
            // registration tracking picks it up on its Created event.
            std::fs::create_dir_all(root.path().join("fresh")).unwrap();
            std::fs::create_dir_all(root.path().join("buck-out")).unwrap();
            std::thread::sleep(Duration::from_millis(500));
            std::fs::write(root.path().join("fresh/new.md"), "x").unwrap();
            std::fs::write(root.path().join("buck-out/gen.txt"), "x").unwrap();

            let seen = wait_for(&rx, Duration::from_secs(5), |e| {
                e.path.as_deref() == Some("fresh/new.md")
            });
            assert!(
                seen.is_some(),
                "file inside a post-start directory must stream"
            );
            let strays = drain(&rx, Duration::from_millis(500));
            assert!(
                !strays
                    .iter()
                    .any(|e| e.path.as_deref().unwrap_or("").starts_with("buck-out")),
                "post-start excluded dir must stay dark: {strays:?}"
            );
        }

        #[test]
        fn moved_in_tree_emits_catch_up_events() {
            let root = TempDir::new().unwrap();
            let staging = TempDir::new().unwrap();
            // Build the tree OUTSIDE the watched root, then rename it
            // in: inotify cannot replay the pre-existing contents, so
            // the catch-up scan is the only way these files surface.
            std::fs::create_dir_all(staging.path().join("tree/node_modules/pkg")).unwrap();
            std::fs::create_dir_all(staging.path().join("tree/docs")).unwrap();
            std::fs::write(staging.path().join("tree/docs/a.md"), "a").unwrap();
            std::fs::write(staging.path().join("tree/node_modules/pkg/b.js"), "b").unwrap();
            let (_h, rx) = start_handle(&root);
            std::thread::sleep(Duration::from_millis(300));
            std::fs::rename(staging.path().join("tree"), root.path().join("tree")).unwrap();

            let seen = wait_for(&rx, Duration::from_secs(5), |e| {
                e.kind == WatchKind::Created && e.path.as_deref() == Some("tree/docs/a.md")
            });
            assert!(
                seen.is_some(),
                "catch-up scan must emit Created for moved-in files"
            );
            let strays = drain(&rx, Duration::from_millis(500));
            assert!(
                !strays
                    .iter()
                    .any(|e| e.path.as_deref().unwrap_or("").contains("node_modules")),
                "catch-up scan honors the exclusion set: {strays:?}"
            );
        }

        #[test]
        fn vcs_control_files_still_flow() {
            let root = TempDir::new().unwrap();
            std::fs::create_dir_all(root.path().join(".git")).unwrap();
            let (_h, rx) = start_handle(&root);
            std::thread::sleep(Duration::from_millis(300));
            std::fs::write(root.path().join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
            let seen = wait_for(&rx, Duration::from_secs(5), |e| {
                e.path.as_deref() == Some(".git/HEAD")
            });
            assert!(
                seen.is_some(),
                ".git top level stays watched so control files stream"
            );
        }

        #[test]
        fn watch_registration_lifecycle_recovers_and_joins() {
            let root = TempDir::new().unwrap();
            let retry_dir = root.path().join("retry-me");
            std::fs::create_dir_all(&retry_dir).unwrap();
            inject_registration_failures(&retry_dir, 1);

            let (handle, rx) = start_handle(&root);
            let initial = handle.health();
            assert_eq!(initial.state, WatchHealthState::Degraded);
            assert_eq!(initial.registration_failures, 1);

            let deadline = Instant::now() + Duration::from_secs(5);
            while handle.health().state != WatchHealthState::Healthy && Instant::now() < deadline {
                std::thread::yield_now();
            }
            let recovered = handle.health();
            assert_eq!(recovered.state, WatchHealthState::Healthy);
            assert!(recovered.retry_attempts >= 1);

            std::fs::write(retry_dir.join("after-retry.md"), "x").unwrap();
            assert!(
                wait_for(&rx, Duration::from_secs(5), |event| {
                    event.path.as_deref() == Some("retry-me/after-retry.md")
                })
                .is_some(),
                "retried directory must become observable"
            );

            inject_registration_failures(root.path(), 1);
            handle.inject_provider_loss("injected provider loss");
            let degraded = handle.health();
            assert_eq!(degraded.state, WatchHealthState::Degraded);
            assert_eq!(degraded.provider_errors, 1);

            let deadline = Instant::now() + Duration::from_secs(5);
            while handle.health().state != WatchHealthState::Healthy && Instant::now() < deadline {
                std::thread::yield_now();
            }
            assert_eq!(handle.health().state, WatchHealthState::Healthy);

            let _ = drain(&rx, Duration::from_millis(100));
            handle.stop();
            handle.join();
            assert_eq!(handle.health().state, WatchHealthState::Stopped);

            std::fs::write(root.path().join("after-stop.md"), "x").unwrap();
            assert!(
                wait_for(&rx, Duration::from_millis(500), |event| {
                    event.path.as_deref() == Some("after-stop.md")
                })
                .is_none(),
                "stop plus join must prevent post-stop callbacks"
            );
        }
    }
}
