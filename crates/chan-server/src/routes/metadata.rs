//! Chan metadata archive routes.
//!
//! The CLI owns path-based import/export commands. The web surface
//! exposes browser-safe archive endpoints without giving the browser
//! host filesystem paths.

use std::path::Path;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chan_workspace::{
    Library, MetadataExportOptions, MetadataImportOptions, MetadataImportReport, SearchAggression,
    WatchCallback, WatchHandle, Workspace,
};

use crate::bus::{make_progress_broadcast, make_watch_bridge};
use crate::error::{err, err_from};
use crate::extract::Multipart;
use crate::indexer::Indexer;
use crate::routes::run_blocking;
use crate::state::{AppState, WorkspaceCell};
use crate::terminal_sessions::CloseReason;

struct MetadataExportDownload {
    bytes: Vec<u8>,
    filename: String,
    files: usize,
    size: u64,
}

pub async fn api_metadata_export(State(state): State<Arc<AppState>>) -> Response {
    let library = state.library.clone();
    let workspace_root = state.workspace_root.clone();
    let result = run_blocking("export metadata", move || {
        export_metadata_download(&library, &workspace_root)
    })
    .await;

    match result {
        Ok(Ok(download)) => metadata_download_response(download),
        Ok(Err(e)) => err_from(&e),
        Err(failed) => failed.into_response(),
    }
}

pub async fn api_metadata_import(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Response {
    let mut archive_bytes: Option<Vec<u8>> = None;
    let mut rescan = true;
    let mut force_scm = false;

    loop {
        match multipart.next_field().await {
            Ok(Some(field)) => {
                let name = field.name().unwrap_or("").to_owned();
                match name.as_str() {
                    "file" if archive_bytes.is_none() => match field.bytes().await {
                        Ok(bytes) => archive_bytes = Some(bytes.to_vec()),
                        Err(e) => {
                            return err(StatusCode::BAD_REQUEST, format!("multipart read: {e}"));
                        }
                    },
                    "rescan" => match field.text().await {
                        Ok(value) => rescan = parse_bool_field(&value),
                        Err(e) => {
                            return err(StatusCode::BAD_REQUEST, format!("multipart read: {e}"));
                        }
                    },
                    "force_scm" => match field.text().await {
                        Ok(value) => force_scm = parse_bool_field(&value),
                        Err(e) => {
                            return err(StatusCode::BAD_REQUEST, format!("multipart read: {e}"));
                        }
                    },
                    _ => {
                        let _ = field.bytes().await;
                    }
                }
            }
            Ok(None) => break,
            Err(e) => return err(StatusCode::BAD_REQUEST, format!("multipart parse: {e}")),
        }
    }

    let Some(bytes) = archive_bytes else {
        return err(
            StatusCode::BAD_REQUEST,
            "missing `file` part in multipart body".into(),
        );
    };
    if bytes.is_empty() {
        return err(StatusCode::BAD_REQUEST, "empty metadata archive".into());
    }

    let state_clone = state.clone();
    let result = run_blocking("import metadata", move || {
        perform_metadata_import(&state_clone, bytes, rescan, force_scm)
    })
    .await;
    match result {
        Ok(Ok(report)) => Json(report).into_response(),
        Ok(Err(e)) => err_from_metadata_import(&e),
        Err(failed) => failed.into_response(),
    }
}

fn export_metadata_download(
    library: &Library,
    workspace_root: &Path,
) -> chan_workspace::Result<MetadataExportDownload> {
    let tmp = tempfile::tempdir()?;
    let archive = tmp.path().join("chan-metadata.tar.zst");
    let report = library.export_metadata_archive(
        workspace_root,
        &archive,
        MetadataExportOptions {
            chan_version: env!("CARGO_PKG_VERSION").to_string(),
        },
    )?;
    let bytes = std::fs::read(&archive)?;
    Ok(MetadataExportDownload {
        bytes,
        filename: format!(
            "chan-metadata-{}.tar.zst",
            safe_filename_fragment(&report.manifest.source_metadata_key)
        ),
        files: report.files,
        size: report.bytes,
    })
}

fn metadata_download_response(download: MetadataExportDownload) -> Response {
    let mut response = download.bytes.into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/zstd"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{}\"", download.filename))
            .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
    );
    if let Ok(value) = HeaderValue::from_str(&download.files.to_string()) {
        headers.insert("x-chan-metadata-files", value);
    }
    if let Ok(value) = HeaderValue::from_str(&download.size.to_string()) {
        headers.insert("x-chan-metadata-bytes", value);
    }
    response
}

#[cfg(not(test))]
pub(super) const IMPORT_DRAIN_DEADLINE: Duration = Duration::from_secs(5);
#[cfg(test)]
pub(super) const IMPORT_DRAIN_DEADLINE: Duration = Duration::from_millis(500);

#[derive(Debug)]
enum MetadataImportError {
    Busy,
    Core(chan_workspace::ChanError),
    Poisoned(&'static str),
}

#[derive(Debug)]
pub(super) enum WorkspaceCellInstallError {
    Poisoned(&'static str),
}

impl From<WorkspaceCellInstallError> for MetadataImportError {
    fn from(error: WorkspaceCellInstallError) -> Self {
        match error {
            WorkspaceCellInstallError::Poisoned(what) => Self::Poisoned(what),
        }
    }
}

fn err_from_metadata_import(e: &MetadataImportError) -> Response {
    match e {
        MetadataImportError::Busy => err(
            StatusCode::CONFLICT,
            "workspace busy: in-flight requests still hold the writer lock; retry in a moment"
                .into(),
        ),
        MetadataImportError::Core(c) => err_from(c),
        MetadataImportError::Poisoned(what) => err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("{what} poisoned"),
        ),
    }
}

fn parse_bool_field(value: &str) -> bool {
    let value = value.trim().to_ascii_lowercase();
    matches!(value.as_str(), "true" | "1" | "yes" | "on")
}

fn perform_metadata_import(
    state: &AppState,
    archive_bytes: Vec<u8>,
    rescan: bool,
    force_scm: bool,
) -> Result<MetadataImportReport, MetadataImportError> {
    perform_metadata_import_with(
        state,
        archive_bytes,
        MetadataImportOptions { rescan, force_scm },
        &LiveImportWorkspaceOps,
    )
}

/// The two calls an import makes to chan-workspace once it has let its
/// workspace go, so a test can stand in for either.
trait ImportWorkspaceOps {
    fn import_archive(
        &self,
        state: &AppState,
        archive: &Path,
        options: MetadataImportOptions,
    ) -> chan_workspace::Result<MetadataImportReport>;

    fn open_workspace(&self, state: &AppState) -> chan_workspace::Result<Arc<Workspace>>;
}

struct LiveImportWorkspaceOps;

impl ImportWorkspaceOps for LiveImportWorkspaceOps {
    fn import_archive(
        &self,
        state: &AppState,
        archive: &Path,
        options: MetadataImportOptions,
    ) -> chan_workspace::Result<MetadataImportReport> {
        state
            .library
            .import_metadata_archive(&state.workspace_root, archive, options)
    }

    fn open_workspace(&self, state: &AppState) -> chan_workspace::Result<Arc<Workspace>> {
        state.library.open_workspace(&state.workspace_root)
    }
}

fn perform_metadata_import_with(
    state: &AppState,
    archive_bytes: Vec<u8>,
    options: MetadataImportOptions,
    ops: &impl ImportWorkspaceOps,
) -> Result<MetadataImportReport, MetadataImportError> {
    let archive = tempfile::Builder::new()
        .prefix("chan-metadata-import-")
        .suffix(".tar.zst")
        .tempfile()
        .map_err(|e| MetadataImportError::Core(e.into()))?;
    std::fs::write(archive.path(), archive_bytes)
        .map_err(|e| MetadataImportError::Core(e.into()))?;

    let search_aggression = workspace_search_aggression(state)?;
    // Hold the cell's write guard across the whole import, the same shape
    // as `perform_reset_with`. A concurrent request then reads the held
    // lock as Busy (503 with Retry-After) for the life of the drain,
    // extraction, and reopen; releasing the guard around the empty slot
    // would instead read as Missing, a permanent-looking 500 for a window
    // that clears in seconds. Missing is what a reopen that fails leaves
    // behind: its error returns below with the slot still empty.
    let mut cell_guard = state
        .workspace_cell
        .write()
        .map_err(|_| MetadataImportError::Poisoned("workspace cell lock"))?;
    let Some(mut cell) = cell_guard.take() else {
        return Err(MetadataImportError::Busy);
    };
    cell.indexer.cancel();
    cell.watch_handle.take();
    let workspace_strong = cell.workspace.clone();
    drop(cell);

    let deadline = Instant::now() + IMPORT_DRAIN_DEADLINE;
    while Arc::strong_count(&workspace_strong) > 1 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
    if Arc::strong_count(&workspace_strong) > 1 {
        install_workspace_cell(state, &mut cell_guard, workspace_strong, search_aggression);
        return Err(MetadataImportError::Busy);
    }
    close_workspace_sessions(state, &workspace_strong, "import");
    let released = Arc::downgrade(&workspace_strong);
    let lock_dir = workspace_strong.paths().lock.clone();
    drop(workspace_strong);
    let releasing = match held_past_release(&released, &lock_dir, IMPORT_DRAIN_DEADLINE) {
        Release::Held(workspace) => {
            install_workspace_cell(state, &mut cell_guard, workspace, search_aggression);
            return Err(MetadataImportError::Busy);
        }
        Release::LetGo => false,
        Release::LockNotFreed => true,
    };

    let import_result = ops.import_archive(state, archive.path(), options);
    let reopened = reopen_released(releasing.then_some(IMPORT_DRAIN_DEADLINE), || {
        ops.open_workspace(state)
    })
    .map_err(MetadataImportError::Core)?;
    install_workspace_cell(
        state,
        &mut cell_guard,
        reopened.workspace,
        search_aggression,
    );

    match (import_result, reopened.recovered_from) {
        // The lock this route gave up waiting for was still on its way out
        // when chan-workspace refused the import over it, and is free again
        // by the reopen: a retry finds it free. A lock refusal after the wait
        // saw the lock free is another process's, and answers as that.
        (Err(error), _) if releasing && lock_still_held(&error) => Err(MetadataImportError::Busy),
        (Err(error), _) | (Ok(_), Some(error)) => Err(MetadataImportError::Core(error)),
        (Ok(report), None) => Ok(report),
    }
}

/// How often a route looks again for the workspace it let go.
const RELEASE_POLL: Duration = Duration::from_millis(2);

/// How often a route asks again for a workspace whose lock is still held.
const REOPEN_POLL: Duration = Duration::from_millis(25);

/// Wait, once a route has dropped its own reference, until the workspace is
/// let go: no strong reference left and its writer lock free, the two facts
/// the host's teardown waits for before it answers.
///
/// A route counts its reference down to one before it drops it, but the count
/// does not see a weak reference, and an owner that upgrades one between the
/// count and the drop becomes the workspace's last owner. The workspace and
/// its lock then go when that owner lets go, on its thread, and until then
/// chan-workspace refuses a reset or an import as a workspace still open in
/// this process.
///
/// The wait has two bounds of `bound` each. The first is for that owner. The
/// second starts when no owner is left: the workspace's drop is then under
/// way on its last owner's thread, and it releases the lock last, after it
/// has joined the recovery worker and closed the index.
///
/// What the wait ended on is the caller's to act on: see [`Release`].
pub(super) fn held_past_release(
    released: &Weak<Workspace>,
    lock_dir: &Path,
    bound: Duration,
) -> Release {
    let owners_deadline = Instant::now() + bound;
    while released.strong_count() > 0 {
        if Instant::now() >= owners_deadline {
            // An owner that lets go between the count and this upgrade leaves
            // nothing to put back, and its drop is under way.
            if let Some(workspace) = released.upgrade() {
                return Release::Held(workspace);
            }
            break;
        }
        std::thread::sleep(RELEASE_POLL);
    }
    let lock_deadline = Instant::now() + bound;
    while !chan_workspace::lock::is_free(lock_dir) {
        if Instant::now() >= lock_deadline {
            return Release::LockNotFreed;
        }
        std::thread::sleep(RELEASE_POLL);
    }
    Release::LetGo
}

/// What [`held_past_release`] ended on.
pub(super) enum Release {
    /// No owner is left and the writer lock was seen free. A lock that
    /// chan-workspace then refuses the caller over was taken since, by
    /// another process.
    LetGo,
    /// An owner still holds the workspace at the end of the first bound. The
    /// caller puts it back in its cell and answers busy.
    Held(Arc<Workspace>),
    /// No owner is left and the wait gave up on the writer lock at the end
    /// of the second bound: the drop this process started still holds it.
    /// The caller's own call to chan-workspace is then refused over it, the
    /// reopen waits for it, and the answer is busy.
    LockNotFreed,
}

/// True for chan-workspace's two refusals of a root whose writer lock is
/// held. The drop of a workspace this process let go answers the first while
/// the lock's record still names this process, and the second once the drop
/// has cleared the record and not yet closed the lock. Another process that
/// holds the lock answers the second too, so a caller reads a refusal as its
/// own late release only after [`Release::LockNotFreed`].
pub(super) fn lock_still_held(error: &chan_workspace::ChanError) -> bool {
    matches!(
        error,
        chan_workspace::ChanError::WorkspaceAlreadyOpen
            | chan_workspace::ChanError::WorkspaceLocked
    )
}

/// A workspace reopened for a route's cell, with the first failure of a
/// reopen that a retry recovered from.
pub(super) struct Reopened {
    pub(super) workspace: Arc<Workspace>,
    pub(super) recovered_from: Option<chan_workspace::ChanError>,
}

/// Reopen the workspace a route let go, as restoration work for its cell: a
/// cell left empty reads as a missing workspace to every later request. That
/// is what an `Err` from here leaves: the route returns it with its cell
/// empty, since no workspace is left to put back.
///
/// `releasing` is the bound to wait in when the route gave up waiting for the
/// writer lock ([`Release::LockNotFreed`]): the lock is then on its way out
/// with the drop of the workspace the route let go, so a reopen refused over
/// it is asked again until the bound has passed, and such a refusal is not
/// reported once a reopen succeeds. Without it a lock refusal is another
/// process's lock and no wait. Any other failure is retried once and kept for
/// the caller's answer when the retry recovers.
pub(super) fn reopen_released(
    releasing: Option<Duration>,
    mut open: impl FnMut() -> chan_workspace::Result<Arc<Workspace>>,
) -> chan_workspace::Result<Reopened> {
    let deadline = releasing.map(|bound| Instant::now() + bound);
    let mut recovered_from = None;
    loop {
        match open() {
            Ok(workspace) => {
                return Ok(Reopened {
                    workspace,
                    recovered_from,
                })
            }
            Err(error) if deadline.is_some() && lock_still_held(&error) => {
                if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                    return Err(error);
                }
                std::thread::sleep(REOPEN_POLL);
            }
            Err(error) => {
                if recovered_from.is_some() {
                    return Err(error);
                }
                recovered_from = Some(error);
            }
        }
    }
}

#[cfg(all(test, unix))]
struct TestSessionCloseGate {
    entered: tokio::sync::oneshot::Sender<()>,
    release: std::sync::mpsc::Receiver<()>,
}

#[cfg(all(test, unix))]
static TEST_SESSION_CLOSE_GATES: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, TestSessionCloseGate>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

#[cfg(all(test, unix))]
pub(crate) fn install_test_session_close_gate(
    root: &Path,
    entered: tokio::sync::oneshot::Sender<()>,
    release: std::sync::mpsc::Receiver<()>,
) {
    let root = std::fs::canonicalize(root).unwrap();
    assert!(TEST_SESSION_CLOSE_GATES
        .lock()
        .unwrap()
        .insert(root, TestSessionCloseGate { entered, release })
        .is_none());
}

/// Hold `root`'s writer lock the way another process does: the lock is taken
/// and its record names a live process that is not this one, so chan-workspace
/// refuses this process as it refuses any other and never as the lock's owner.
#[cfg(all(test, unix))]
pub(super) fn another_processes_lock(
    library: &Library,
    root: &Path,
) -> chan_workspace::lock::WorkspaceLock {
    let paths = library
        .workspace_paths_for(root)
        .expect("a registered workspace");
    let lock =
        chan_workspace::lock::WorkspaceLock::acquire(&paths.lock, root).expect("a free lock");
    let record = chan_workspace::lock::LockRecord {
        // Process 1 is alive on every unix and is never this process.
        pid: 1,
        path: std::fs::canonicalize(root)
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        started_at: "2000-01-01T00:00:00Z".to_string(),
    };
    std::fs::write(
        paths.lock.join("writer.lock"),
        serde_json::to_vec(&record).unwrap(),
    )
    .unwrap();
    lock
}

/// Run only after the old workspace has drained, while its cell write guard
/// still excludes new handlers. These callers run on the blocking pool; the
/// flush futures use the retained workspace directly and never read the cell.
/// The sessions stay closed when the caller then answers busy, whether
/// [`held_past_release`] found the workspace still held or chan-workspace
/// refused the operation over a lock still held.
pub(super) fn close_workspace_sessions(
    state: &AppState,
    workspace: &Arc<Workspace>,
    reason: &'static str,
) {
    #[cfg(all(test, unix))]
    {
        let gate = TEST_SESSION_CLOSE_GATES
            .lock()
            .unwrap()
            .remove(workspace.root());
        if let Some(gate) = gate {
            gate.entered.send(()).unwrap();
            gate.release
                .recv_timeout(Duration::from_secs(5))
                .expect("session-close test gate was not released");
        }
    }
    futures::executor::block_on(async {
        state
            .doc_sessions
            .close_all(reason, Some(workspace), &state.self_writes)
            .await;
        state
            .scene_sessions
            .close_all(reason, Some(workspace), &state.self_writes)
            .await;
    });
    state.terminal_sessions.close_all(CloseReason::Workspace);
}

pub(super) fn workspace_search_aggression(
    state: &AppState,
) -> Result<SearchAggression, WorkspaceCellInstallError> {
    state
        .server_config
        .lock()
        .map(|config| config.search.aggression)
        .map_err(|_| WorkspaceCellInstallError::Poisoned("server config lock"))
}

pub(super) fn install_workspace_cell(
    state: &AppState,
    cell_slot: &mut Option<WorkspaceCell>,
    workspace: Arc<Workspace>,
    search_aggression: SearchAggression,
) {
    let bridge = make_watch_bridge(
        &state.events_tx,
        &state.index_events_tx,
        &state.self_writes,
        &state.scope_registry,
        workspace.root().to_path_buf(),
    );
    // A watcher is an accelerator, not workspace authority. Boot already
    // serves without one when the host exhausts its watch limit; a cell swap
    // must preserve the same degraded-but-serving contract.
    let watch_handle = match register_workspace_watch(&workspace, bridge) {
        Ok(handle) => Some(handle),
        Err(error) => {
            tracing::warn!(
                %error,
                path = %workspace.root().display(),
                "filesystem watcher registration failed after workspace swap"
            );
            None
        }
    };
    let indexer = Arc::new(Indexer::spawn(
        workspace.clone(),
        state.index_events_tx.subscribe(),
        true,
        search_aggression,
        make_progress_broadcast(&state.events_tx),
    ));
    *cell_slot = Some(WorkspaceCell {
        workspace,
        watch_handle,
        indexer,
    });
}

fn register_workspace_watch(
    workspace: &Arc<Workspace>,
    bridge: Arc<dyn WatchCallback>,
) -> chan_workspace::Result<WatchHandle> {
    #[cfg(test)]
    if take_test_watch_registration_failure(workspace.root()) {
        return Err(chan_workspace::ChanError::Io(
            "injected watcher registration failure".into(),
        ));
    }
    workspace.watch(bridge)
}

#[cfg(test)]
thread_local! {
    static TEST_WATCH_REGISTRATION_FAILURES: std::cell::RefCell<std::collections::HashSet<std::path::PathBuf>> =
        std::cell::RefCell::new(std::collections::HashSet::new());
}

/// Key both ends of the injection on the canonical path.
///
/// The injecting side holds a raw `TempDir` path while the consuming side
/// asks `Workspace::root()`, which is the registry's already-canonicalized
/// `root_path`. On Linux a `/tmp` path canonicalizes to itself and the two
/// agree by accident. On macOS `/var` is a symlink to `/private/var`, so the
/// same workspace is `/var/folders/...` on one side and `/private/var/folders/...`
/// on the other, the lookup misses, no failure is injected, and a test that
/// asserts the watcher did NOT register sees a healthy handle instead.
///
/// Falling back to the input when canonicalization fails matches
/// `Library`'s own `canonical_key`: a root that cannot be resolved still has
/// to produce a stable key rather than an error.
#[cfg(test)]
fn watch_failure_key(root: &Path) -> std::path::PathBuf {
    std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf())
}

#[cfg(test)]
pub(super) fn inject_test_watch_registration_failure(root: &Path) {
    TEST_WATCH_REGISTRATION_FAILURES.with(|roots| {
        roots.borrow_mut().insert(watch_failure_key(root));
    });
}

#[cfg(test)]
fn take_test_watch_registration_failure(root: &Path) -> bool {
    TEST_WATCH_REGISTRATION_FAILURES
        .with(|roots| roots.borrow_mut().remove(&watch_failure_key(root)))
}

fn safe_filename_fragment(value: &str) -> String {
    let out: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "workspace".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A writer lock held with no owner left, which is what the drop of a
    /// workspace looks like from outside: its last reference is gone and
    /// its lock goes last.
    fn a_held_lock() -> (
        tempfile::TempDir,
        std::path::PathBuf,
        chan_workspace::lock::WorkspaceLock,
    ) {
        let dir = tempfile::TempDir::new().unwrap();
        let lock_dir = dir.path().join("lock");
        let held = chan_workspace::lock::WorkspaceLock::acquire(&lock_dir, dir.path()).unwrap();
        (dir, lock_dir, held)
    }

    #[test]
    fn the_wait_for_a_released_workspace_ends_only_once_its_lock_is_free() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let (_dir, lock_dir, held) = a_held_lock();
        let freed = Arc::new(AtomicBool::new(false));
        let holder = std::thread::spawn({
            let freed = freed.clone();
            move || {
                std::thread::sleep(Duration::from_millis(100));
                freed.store(true, Ordering::SeqCst);
                drop(held);
            }
        });

        let release = held_past_release(&Weak::new(), &lock_dir, Duration::from_secs(30));

        assert!(
            freed.load(Ordering::SeqCst),
            "the wait ended while the writer lock was still held"
        );
        assert!(matches!(release, Release::LetGo));
        holder.join().unwrap();
    }

    #[test]
    fn the_wait_for_a_released_workspace_gives_up_on_its_lock_at_its_bound() {
        let (_dir, lock_dir, held) = a_held_lock();
        let bound = Duration::from_millis(100);
        // A wait that has no bound never returns, so it runs on a thread of
        // its own and the pin gives it this long past its bound.
        let margin = Duration::from_secs(5);
        let (ended, wait_ended) = std::sync::mpsc::channel();
        let started = Instant::now();
        let waiter = std::thread::spawn(move || {
            let release = held_past_release(&Weak::new(), &lock_dir, bound);
            let gave_up_on_the_lock = matches!(release, Release::LockNotFreed);
            let _ = ended.send((started.elapsed(), gave_up_on_the_lock));
        });

        let outcome = wait_ended.recv_timeout(bound + margin);
        // Free the lock, so a wait that outlasted its bound can end.
        drop(held);
        waiter.join().unwrap();

        let (waited, gave_up_on_the_lock) = outcome.unwrap_or_else(|_| {
            panic!(
                "the wait for a held lock was still going {margin:?} past its bound of {bound:?}"
            )
        });
        assert!(
            waited >= bound,
            "the wait for a held lock ended after {waited:?}, inside its bound of {bound:?}"
        );
        assert!(
            gave_up_on_the_lock,
            "the wait did not say that it gave up on a lock still held at its bound"
        );
    }

    #[test]
    fn safe_filename_fragment_strips_path_characters() {
        assert_eq!(
            safe_filename_fragment("/tmp/workspace root"),
            "tmp-workspace-root"
        );
        assert_eq!(safe_filename_fragment(""), "workspace");
    }

    #[test]
    fn export_metadata_download_returns_archive_bytes() {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        workspace.write_text("note.md", "hello").unwrap();
        drop(workspace);

        let download = export_metadata_download(&lib, root.path()).unwrap();

        assert!(download.filename.ends_with(".tar.zst"));
        assert!(!download.bytes.is_empty());
    }

    #[cfg(unix)]
    struct ImportTestState {
        _config: tempfile::TempDir,
        _root: tempfile::TempDir,
        state: Arc<AppState>,
        archive: Vec<u8>,
    }

    /// A served workspace and an archive of its own metadata. Called inside a
    /// runtime, where the state's indexer starts its tasks.
    #[cfg(unix)]
    fn import_test_state() -> ImportTestState {
        let config = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let library = Library::open_at(config.path().join("config.toml")).unwrap();
        library.register_workspace(root.path()).unwrap();
        let workspace = library.open_workspace(root.path()).unwrap();
        workspace.write_text("note.md", "hello").unwrap();
        let state = Arc::new(crate::state::test_support::workspace_app_state(
            library,
            root.path().to_path_buf(),
            workspace,
        ));
        let exported = tempfile::TempDir::new().unwrap();
        let path = exported.path().join("metadata.tar.zst");
        state
            .library
            .export_metadata_archive(
                &state.workspace_root,
                &path,
                MetadataExportOptions {
                    chan_version: "test".into(),
                },
            )
            .unwrap();
        let archive = std::fs::read(path).unwrap();
        ImportTestState {
            _config: config,
            _root: root,
            state,
            archive,
        }
    }

    /// When another process that took the workspace's writer lock lets it go.
    #[cfg(unix)]
    #[derive(Clone, Copy)]
    enum LetsGo {
        /// As the route asks for its workspace the given time: at the first
        /// the lock is free before the route reopens, at the second the
        /// route's one retry finds it free, and from the third on only a
        /// route that waits at its reopen does.
        AtOpen(usize),
        /// Three of the route's bounds after it first asked for its
        /// workspace, so a reopen that has no bound ends too.
        PastTheBound,
    }

    /// Stands in for another process that takes the workspace's writer lock
    /// once the archive is imported: the route has let its workspace go and
    /// seen the lock free by then. The import's rescan reopens the
    /// workspace, which that lock refuses; an import with no rescan is done.
    #[cfg(unix)]
    struct BesideAnotherProcess {
        lock: std::cell::RefCell<Option<chan_workspace::lock::WorkspaceLock>>,
        rescans: bool,
        lets_go: LetsGo,
        open_calls: std::cell::Cell<usize>,
        first_open: std::cell::Cell<Option<Instant>>,
    }

    #[cfg(unix)]
    impl BesideAnotherProcess {
        fn that_refuses_the_rescan(lets_go: LetsGo) -> Self {
            Self::new(true, lets_go)
        }

        fn that_locks_once_the_import_is_done(lets_go: LetsGo) -> Self {
            Self::new(false, lets_go)
        }

        fn new(rescans: bool, lets_go: LetsGo) -> Self {
            Self {
                lock: std::cell::RefCell::new(None),
                rescans,
                lets_go,
                open_calls: std::cell::Cell::new(0),
                first_open: std::cell::Cell::new(None),
            }
        }

        fn import(
            &self,
            state: &Arc<AppState>,
            archive: &[u8],
        ) -> Result<MetadataImportReport, MetadataImportError> {
            perform_metadata_import_with(
                state,
                archive.to_vec(),
                MetadataImportOptions {
                    rescan: self.rescans,
                    force_scm: false,
                },
                self,
            )
        }
    }

    #[cfg(unix)]
    impl ImportWorkspaceOps for BesideAnotherProcess {
        fn import_archive(
            &self,
            state: &AppState,
            archive: &Path,
            options: MetadataImportOptions,
        ) -> chan_workspace::Result<MetadataImportReport> {
            let report = state.library.import_metadata_archive(
                &state.workspace_root,
                archive,
                MetadataImportOptions {
                    rescan: false,
                    ..options
                },
            )?;
            *self.lock.borrow_mut() = Some(another_processes_lock(
                &state.library,
                &state.workspace_root,
            ));
            if !self.rescans {
                return Ok(report);
            }
            // The rescan's own reopen, which the other process's lock refuses.
            state
                .library
                .open_workspace(&state.workspace_root)
                .map(|_| report)
        }

        fn open_workspace(&self, state: &AppState) -> chan_workspace::Result<Arc<Workspace>> {
            self.open_calls.set(self.open_calls.get() + 1);
            let first_open = self.first_open.get().unwrap_or_else(Instant::now);
            self.first_open.set(Some(first_open));
            let lets_go = match self.lets_go {
                LetsGo::AtOpen(open) => self.open_calls.get() >= open,
                LetsGo::PastTheBound => first_open.elapsed() >= IMPORT_DRAIN_DEADLINE * 3,
            };
            if lets_go {
                self.lock.borrow_mut().take();
            }
            state.library.open_workspace(&state.workspace_root)
        }
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_import_whose_rescan_meets_another_processes_lock_answers_that_lock() {
        let test = import_test_state();
        let ops = BesideAnotherProcess::that_refuses_the_rescan(LetsGo::AtOpen(1));

        let result = ops.import(&test.state, &test.archive);

        assert!(
            matches!(
                result,
                Err(MetadataImportError::Core(
                    chan_workspace::ChanError::WorkspaceLocked
                ))
            ),
            "an import that completed and whose rescan met another process's lock \
             must answer that lock: {:?}",
            result.as_ref().err()
        );
        test.state
            .try_workspace()
            .expect("the reopen after the other process let go fills the cell");
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_import_refused_over_a_lock_let_go_inside_its_reopens_bound_fills_its_cell() {
        let test = import_test_state();
        let ops = BesideAnotherProcess::that_refuses_the_rescan(LetsGo::AtOpen(3));

        let result = ops.import(&test.state, &test.archive);

        assert!(
            matches!(
                result,
                Err(MetadataImportError::Core(
                    chan_workspace::ChanError::WorkspaceLocked
                ))
            ),
            "an import whose rescan met another process's lock must answer that lock: {:?}",
            result.as_ref().err()
        );
        assert!(
            test.state.try_workspace().is_ok(),
            "an import left its cell empty beside a lock that was let go inside its reopen's bound: {:?}",
            test.state.try_workspace().err()
        );
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_import_done_beside_a_lock_let_go_at_its_second_reopen_answers_success() {
        let test = import_test_state();
        let ops = BesideAnotherProcess::that_locks_once_the_import_is_done(LetsGo::AtOpen(2));

        let result = ops.import(&test.state, &test.archive);

        assert!(
            result.is_ok(),
            "an import that was done must answer success over the workspace it reopened: {:?}",
            result.as_ref().err()
        );
        test.state
            .try_workspace()
            .expect("the reopen after the other process let go fills the cell");
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_import_done_beside_a_lock_let_go_inside_its_reopens_bound_answers_success() {
        let test = import_test_state();
        let ops = BesideAnotherProcess::that_locks_once_the_import_is_done(LetsGo::AtOpen(3));

        let result = ops.import(&test.state, &test.archive);

        assert!(
            result.is_ok(),
            "an import that was done must answer success over the workspace it reopened: {:?}",
            result.as_ref().err()
        );
        test.state
            .try_workspace()
            .expect("the reopen after the other process let go fills the cell");
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_import_beside_a_lock_held_past_its_reopens_bound_answers_that_lock_with_no_cell() {
        let test = import_test_state();
        let ops = BesideAnotherProcess::that_refuses_the_rescan(LetsGo::PastTheBound);
        let started = Instant::now();

        let result = ops.import(&test.state, &test.archive);

        let took = started.elapsed();
        assert!(
            matches!(
                result,
                Err(MetadataImportError::Core(
                    chan_workspace::ChanError::WorkspaceLocked
                ))
            ),
            "an import beside a lock held past its reopen's bound must answer that lock: {:?}",
            result.as_ref().err()
        );
        assert!(
            took >= IMPORT_DRAIN_DEADLINE,
            "the import gave up on another process's lock after {took:?}, inside its \
             reopen's bound of {IMPORT_DRAIN_DEADLINE:?}"
        );
        assert!(
            matches!(
                test.state.try_workspace(),
                Err(crate::state::StateAccessError::Missing)
            ),
            "an import whose reopen was refused to the end of its bound has no workspace \
             to fill its cell with"
        );
    }
}
