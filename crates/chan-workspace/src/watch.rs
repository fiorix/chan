// Filesystem watcher.
//
// Callback-based on purpose: makes the API uniffi-friendly (the
// FFI client passes a Swift / Kotlin object that implements the
// callback trait, no closures across the boundary). The native
// implementation uses `notify` and runs the watcher on its own
// thread; events are filtered through `is_chan_internal` and
// `walk_workspace`'s pruning rules so `.chan/` and most `.git/` / `.hg/`
// activity never reaches the callback. A tiny allowlist of VCS
// control files (`.git/HEAD`, `.git/index`, `.hg/dirstate`) is
// forwarded so the server indexer can recognize checkout storms and
// fall back to a full rebuild.
//
// On Linux the dispatch filter is only half the policy: registration
// is a manual filtered recursion (excluded subtrees never get an
// inotify watch at all) with a registrar thread that picks up
// directories created after start and catch-up-scans moved-in trees.
// Other platforms use the backend's native recursive watch.
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
//   * `WatchEvent.path == None` is a hint to drop caches. It only
//     happens when the backend produced a path the workspace can't
//     relativize (the file lives outside the watched root, usually
//     the source side of a rename across mount points). Treat it
//     as "something moved, scope unknown" and reindex the whole
//     workspace when feasible.
//
//   * `WatchKind::ProviderError` is the watcher's signal that the
//     event stream is no longer trustworthy: inotify queue
//     overflow, fseventsd hiccup, the watched dir vanishing. The
//     correct response is the same as for the "scope unknown"
//     case: drop caches and trigger a full reindex. The handle is
//     still alive after this event; further events may resume, or
//     the consumer can rebuild the watcher entirely.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::fs_ops::{is_chan_internal, WalkFilter};
use crate::vcs::is_vcs_control_path;

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
    /// `path` carries the backend's error message; `to` is unused.
    ProviderError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

/// Holds the underlying watcher machinery; drop to stop watching.
pub struct WatchHandle {
    /// Linux: registration requests flow to the registrar thread,
    /// which owns the watcher. Dropping the sender closes the
    /// channel; the thread exits and the watcher drops with it.
    #[cfg(target_os = "linux")]
    _reg_tx: RegistrationTx,
    /// Linux: the registrar thread. Must outlive the dispatch
    /// closure, which holds a sender clone.
    #[cfg(target_os = "linux")]
    _registrar: std::thread::JoinHandle<()>,
    /// Non-Linux: the watcher itself, kept alive so its worker
    /// thread doesn't exit.
    #[cfg(not(target_os = "linux"))]
    _watcher: RecommendedWatcher,
}

/// A directory-registration request from the dispatch thread to the
/// registrar thread. The plan is computed dispatch-side (it has the
/// filter and the roots); the registrar only executes it.
struct DirRegistration {
    abs: PathBuf,
    rel: String,
    prefix: Option<String>,
    plan: DirPlan,
}

/// Registration requests to the registrar thread. The sender is
/// cheap to clone; `send` never blocks the notify worker.
type RegistrationTx = std::sync::mpsc::Sender<DirRegistration>;

/// Minimum spacing between surfaced stream-degradation events.
/// inotify queue overflow (notify's `EventKind::Other`) can repeat
/// for the whole storm, and every surfaced ProviderError is a
/// full-reconcile trigger downstream; one per second is plenty.
const DEGRADE_MIN_INTERVAL: Duration = Duration::from_secs(1);

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

/// Linux: owns the watcher and applies registration requests one at
/// a time. notify's inotify backend answers `watch()` through the
/// event loop, so calling it from the event-loop callback deadlocks
/// the worker -- registrations must happen on any OTHER thread.
/// Queued requests are drained in order; on channel close the thread
/// returns and the watcher drops, stopping the notify worker.
#[cfg(target_os = "linux")]
fn registrar_loop(
    rx: std::sync::mpsc::Receiver<DirRegistration>,
    mut watcher: RecommendedWatcher,
    filter: Arc<WalkFilter>,
    cb: Arc<dyn WatchCallback>,
) {
    while let Ok(reg) = rx.recv() {
        add_watch_quiet(&mut watcher, &reg.abs, &reg.rel);
        if reg.plan == DirPlan::WatchAndDescend {
            catch_up_subtree(
                &mut watcher,
                reg.prefix.as_deref(),
                &reg.abs,
                &reg.rel,
                &filter,
                &*cb,
            );
        }
    }
}

/// What to do with a directory encountered by the registration walk
/// or the new-directory tracker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
fn plan_dir(rel: &str, name: &str, filter: &WalkFilter) -> DirPlan {
    if is_chan_internal(rel) {
        return DirPlan::Skip;
    }
    // VCS dirs are watched top-level-only so control files stream but
    // the object store never registers -- unless the user removed the
    // VCS dir from the exclusion set, in which case treat it like any
    // other directory (the dispatch filter would forward its events).
    if matches!(name, ".git" | ".hg" | ".svn") && filter.is_excluded(name) {
        return DirPlan::WatchOnly;
    }
    if filter.is_excluded(name) {
        return DirPlan::Skip;
    }
    DirPlan::WatchAndDescend
}

fn add_watch_quiet(watcher: &mut RecommendedWatcher, abs: &Path, rel: &str) {
    if let Err(e) = watcher.watch(abs, RecursiveMode::NonRecursive) {
        // A vanished directory mid-walk is routine; an exhausted
        // inotify limit surfaces separately through the overflow path.
        tracing::warn!(error = %e, path = %rel, "watcher: failed to register directory");
    }
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
    filter: &WalkFilter,
) -> Result<()> {
    watcher.watch(&root.abs, RecursiveMode::NonRecursive)?;
    register_subdirs(watcher, &root.abs, "", filter);
    Ok(())
}

fn register_subdirs(watcher: &mut RecommendedWatcher, abs: &Path, rel: &str, filter: &WalkFilter) {
    let Ok(entries) = std::fs::read_dir(abs) else {
        return;
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
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let child_rel = if rel.is_empty() {
            name.to_string()
        } else {
            format!("{rel}/{name}")
        };
        match plan_dir(&child_rel, name, filter) {
            DirPlan::Skip => {}
            DirPlan::WatchOnly => add_watch_quiet(watcher, &entry.path(), &child_rel),
            DirPlan::WatchAndDescend => {
                add_watch_quiet(watcher, &entry.path(), &child_rel);
                register_subdirs(watcher, &entry.path(), &child_rel, filter);
            }
        }
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
    _filter: &WalkFilter,
) -> Result<()> {
    watcher.watch(&root.abs, RecursiveMode::Recursive)?;
    Ok(())
}

/// Linux: a directory that just appeared under a watched parent must
/// start streaming its subtree. The registration itself is queued
/// for the registrar thread (see registrar_loop for why it cannot
/// happen on the notify worker). inotify does not replay pre-existing
/// contents of a moved-in tree either, so an accepted directory also
/// gets a catch-up scan there that synthesizes Created events for the
/// files already inside -- without it those files are invisible until
/// the next full reconcile (a gap the blanket recursive watch had
/// too).
#[cfg(target_os = "linux")]
fn track_new_dirs(
    roots: &[WatchRoot],
    filter: &WalkFilter,
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
    let plan = plan_dir(&rel, name, filter);
    if plan == DirPlan::Skip {
        return;
    }
    let _ = reg_tx.send(DirRegistration {
        abs: abs.to_path_buf(),
        rel,
        prefix: root.prefix.clone(),
        plan,
    });
}

/// Register accepted subdirectories of a newly appeared tree and
/// emit Created events for the regular files within, filtered exactly
/// like live dispatch. Runs on the registrar thread; synthesized
/// events may race live ones (a file created in the new tree can
/// surface twice), the same duplicate class as a notify save burst.
#[cfg(target_os = "linux")]
fn catch_up_subtree(
    watcher: &mut RecommendedWatcher,
    prefix: Option<&str>,
    abs: &Path,
    rel: &str,
    filter: &WalkFilter,
    cb: &dyn WatchCallback,
) {
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
            match plan_dir(&child_rel, name, filter) {
                DirPlan::Skip => {}
                DirPlan::WatchOnly => add_watch_quiet(watcher, &entry.path(), &child_rel),
                DirPlan::WatchAndDescend => {
                    add_watch_quiet(watcher, &entry.path(), &child_rel);
                    catch_up_subtree(watcher, prefix, &entry.path(), &child_rel, filter, cb);
                }
            }
        } else if ft.is_file() && !is_filtered(&child_rel, filter) {
            safe_call(
                cb,
                WatchEvent {
                    kind: WatchKind::Created,
                    path: Some(apply_prefix(prefix, child_rel)),
                    to: None,
                },
            );
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
    /// `filter` is the SAME unified ignore set the bootstrap walk
    /// uses (`Workspace::walk_filter`): events whose relative path runs
    /// through an excluded directory (`node_modules`, `target`,
    /// `venv`, ... and the VCS dirs `.git`/`.hg`/`.svn`) are dropped
    /// here, in the watcher worker thread, BEFORE the consumer's
    /// callback runs. Filtering at this boundary keeps a git checkout
    /// storm under `node_modules`/`target` from ever reaching the
    /// broadcast bus or the indexer (the earliest possible drop, and
    /// the same ignore policy as the walk, not a second list).
    pub(crate) fn start(
        roots: &[WatchRoot],
        filter: Arc<WalkFilter>,
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
        let filter_for_cb = Arc::clone(&filter);
        #[cfg(target_os = "linux")]
        let (reg_tx, reg_rx) = std::sync::mpsc::channel::<DirRegistration>();
        #[cfg(target_os = "linux")]
        let reg_tx_for_cb = reg_tx.clone();
        // Non-Linux has no registrar thread; the sender end of a dead
        // channel keeps dispatch's call shape identical and sends are
        // silently dropped.
        #[cfg(not(target_os = "linux"))]
        let (reg_tx_for_cb, _reg_rx_unused) = std::sync::mpsc::channel::<DirRegistration>();
        let throttle_for_cb = Arc::new(DegradeThrottle::new());
        let mut watcher =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| match res {
                Ok(event) => dispatch(
                    &dispatch_roots_for_cb,
                    &filter_for_cb,
                    event,
                    &*cb_clone,
                    &reg_tx_for_cb,
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
                    safe_call(
                        &*cb_clone,
                        WatchEvent {
                            kind: WatchKind::ProviderError,
                            path: Some(e.to_string()),
                            to: None,
                        },
                    );
                }
            })?;
        for root in dispatch_roots.iter() {
            register_root(&mut watcher, root, &filter)?;
        }
        #[cfg(target_os = "linux")]
        {
            let registrar = std::thread::spawn(move || {
                registrar_loop(reg_rx, watcher, filter, cb);
            });
            Ok(Self {
                _reg_tx: reg_tx,
                _registrar: registrar,
            })
        }
        #[cfg(not(target_os = "linux"))]
        Ok(Self { _watcher: watcher })
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

fn dispatch(
    roots: &[WatchRoot],
    filter: &WalkFilter,
    event: notify::Event,
    cb: &dyn WatchCallback,
    reg_tx: &RegistrationTx,
    throttle: &DegradeThrottle,
) {
    use notify::EventKind;
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
                    WatchEvent {
                        kind: WatchKind::ProviderError,
                        path: Some("inotify queue overflow / watch stream degraded".to_string()),
                        to: None,
                    },
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
    track_new_dirs(roots, filter, reg_tx, dir_candidate.as_deref());
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
        .map(|(_, rel)| is_filtered(rel, filter))
        .unwrap_or(false)
    {
        return;
    }
    if to_resolved
        .as_ref()
        .map(|(_, rel)| is_filtered(rel, filter))
        .unwrap_or(false)
    {
        return;
    }

    let from_rel = from_resolved.map(|(prefix, rel)| apply_prefix(prefix.as_deref(), rel));
    let to_rel = to_resolved.map(|(prefix, rel)| apply_prefix(prefix.as_deref(), rel));

    safe_call(
        cb,
        WatchEvent {
            kind,
            path: from_rel,
            to: to_rel,
        },
    );
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
    if let Err(payload) = catch_unwind(AssertUnwindSafe(|| cb.on_event(event))) {
        let msg = panic_message(&payload);
        tracing::error!("watch callback panicked: {msg}");
        // Best-effort: if the panic-notification itself panics we
        // log and move on. The notify worker stays alive either way.
        let _ = catch_unwind(AssertUnwindSafe(|| {
            cb.on_event(WatchEvent {
                kind: WatchKind::ProviderError,
                path: Some(format!("callback panicked: {msg}")),
                to: None,
            });
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
/// Everything else routes through the SAME `WalkFilter` the bootstrap
/// walk uses: a path is dropped when any of its directory components
/// is an excluded basename (`node_modules`, `target`, `venv`,
/// `.git`, `.hg`, `.svn`, ... per `DEFAULT_INDEX_EXCLUDED_DIRS` plus
/// any user additions). Basename match at any depth matches
/// `walk_workspace_filtered`'s `filter_entry`.
fn is_filtered(rel: &str, filter: &WalkFilter) -> bool {
    if is_vcs_control_path(rel) {
        return false;
    }
    if is_chan_internal(rel) {
        return true;
    }
    // Any path component that is an excluded directory basename prunes
    // the event, exactly as the walk prunes that directory's subtree.
    // The final component is included: a top-level `node_modules`
    // create/remove is itself noise the index does not want.
    rel.split('/')
        .any(|component| filter.is_excluded(component))
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
            WatchEvent {
                kind: WatchKind::Modified,
                path: Some("a.md".into()),
                to: None,
            },
        );
        // Third call: a normal event after the panic. Must land,
        // proving the worker (modeled here as the test thread) is
        // alive.
        safe_call(
            &cb,
            WatchEvent {
                kind: WatchKind::Modified,
                path: Some("b.md".into()),
                to: None,
            },
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
    fn default_filter() -> WalkFilter {
        WalkFilter::new(crate::registry::DEFAULT_INDEX_EXCLUDED_DIRS.iter().copied())
    }

    #[test]
    fn filter_allows_vcs_control_paths_but_hides_other_vcs_noise() {
        let f = default_filter();
        // VCS control files forwarded (checkout-storm detection).
        assert!(!is_filtered(".git/HEAD", &f));
        assert!(!is_filtered(".git/index", &f));
        assert!(!is_filtered(".hg/dirstate", &f));
        // The rest of the VCS dirs are dropped via the excluded-dir set.
        assert!(is_filtered(".git/objects/pack/foo", &f));
        assert!(is_filtered(".hg/store/data/foo", &f));
        // The dir entries themselves are noise too.
        assert!(is_filtered(".git", &f));
        assert!(is_filtered(".hg", &f));
    }

    #[test]
    fn filter_drops_unified_ignore_set_at_any_depth() {
        let f = default_filter();
        // node_modules / target / venv at the top level.
        assert!(is_filtered("node_modules", &f));
        assert!(is_filtered("node_modules/react/index.js", &f));
        assert!(is_filtered("target", &f));
        assert!(is_filtered("target/debug/build/foo.rs", &f));
        assert!(is_filtered("venv", &f));
        assert!(is_filtered("venv/lib/python3.11/site-packages/x.py", &f));
        assert!(is_filtered(".venv/pyvenv.cfg", &f));
        // Nested deeper than the top level: a node_modules under a
        // subproject must also prune (basename match at any depth).
        assert!(is_filtered("frontend/node_modules/pkg/dist/a.js", &f));
        assert!(is_filtered("a/b/target/release/x", &f));
        assert!(is_filtered("svc/__pycache__/mod.cpython-311.pyc", &f));
        // .chan is always dropped regardless of the filter set.
        assert!(is_filtered(".chan/index/meta.json", &f));
    }

    #[test]
    fn filter_keeps_real_notes_and_source() {
        let f = default_filter();
        // Real content must pass through untouched.
        assert!(!is_filtered("README.md", &f));
        assert!(!is_filtered("docs/design.md", &f));
        assert!(!is_filtered("src/main.rs", &f));
        // A file merely NAMED like an excluded dir (but a file, not a
        // dir-in-the-path) only prunes when the basename matches; that
        // is intended -- a file literally named `target` is index noise
        // the same way the dir is. A file whose name CONTAINS the token
        // but is not equal (e.g. `targeting.md`) is kept.
        assert!(!is_filtered("notes/targeting.md", &f));
        assert!(!is_filtered("node_modules_notes.md", &f));
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
        let filter = default_filter();
        let root = PathBuf::from("/workspace");
        let roots = [WatchRoot::workspace(&root)];
        let (reg_tx, _reg_rx) = std::sync::mpsc::channel();
        let throttle = DegradeThrottle::new();

        // A modify under node_modules: dropped, callback never fires.
        dispatch(
            &roots,
            &filter,
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
            &filter,
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
        let filter = default_filter();
        let root = PathBuf::from("/workspace");
        let roots = [WatchRoot::workspace(&root)];
        let (reg_tx, _reg_rx) = std::sync::mpsc::channel();
        let throttle = DegradeThrottle::new();
        let other = || notify::Event {
            kind: notify::EventKind::Other,
            paths: vec![],
            attrs: Default::default(),
        };

        // First overflow signal: surfaced as ProviderError (the
        // consumers' full-reconcile trigger).
        dispatch(&roots, &filter, other(), &cb, &reg_tx, &throttle);
        // An immediate repeat collapses into the throttle window.
        dispatch(&roots, &filter, other(), &cb, &reg_tx, &throttle);

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
            let (tx, rx) = channel();
            let cb = Channel(std::sync::Mutex::new(tx));
            let roots = [WatchRoot::workspace(root.path())];
            let handle = WatchHandle::start(&roots, Arc::new(default_filter()), Arc::new(cb))
                .expect("watcher starts");
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
    }
}
