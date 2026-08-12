//! Chan metadata archive routes.
//!
//! The CLI owns path-based import/export commands. The web surface
//! exposes browser-safe archive endpoints without giving the browser
//! host filesystem paths.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{Multipart, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chan_workspace::{
    Library, MetadataExportOptions, MetadataImportOptions, MetadataImportReport, SearchAggression,
    WatchCallback, WatchHandle, Workspace,
};

use crate::bus::{make_progress_broadcast, make_watch_bridge};
use crate::error::{err, err_from};
use crate::indexer::Indexer;
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
    let result =
        tokio::task::spawn_blocking(move || export_metadata_download(&library, &workspace_root))
            .await;

    match result {
        Ok(Ok(download)) => metadata_download_response(download),
        Ok(Err(e)) => err_from(&e),
        Err(join) => err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
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

    // Close every live doc session BEFORE the import's cell swap, for
    // the same reason storage reset does: no cell swap with live doc
    // sessions. Flush-all against the pre-swap workspace, fan
    // `closed{import}`, drop the sessions.
    let doc_workspace = state.try_workspace().ok();
    state
        .doc_sessions
        .close_all("import", doc_workspace.as_ref(), &state.self_writes)
        .await;
    state
        .scene_sessions
        .close_all("import", doc_workspace.as_ref(), &state.self_writes)
        .await;
    let state_clone = state.clone();
    let result = tokio::task::spawn_blocking(move || {
        perform_metadata_import(&state_clone, bytes, rescan, force_scm)
    })
    .await;
    match result {
        Ok(Ok(report)) => Json(report).into_response(),
        Ok(Err(e)) => err_from_metadata_import(&e),
        Err(join) => err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
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

const IMPORT_DRAIN_DEADLINE: Duration = Duration::from_secs(5);

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
    // that clears in seconds.
    let mut cell_guard = state
        .workspace_cell
        .write()
        .map_err(|_| MetadataImportError::Poisoned("workspace cell lock"))?;
    state.terminal_sessions.close_all(CloseReason::Workspace);
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
    drop(workspace_strong);

    let import_result = state
        .library
        .import_metadata_archive(
            &state.workspace_root,
            archive.path(),
            MetadataImportOptions { rescan, force_scm },
        )
        .map_err(MetadataImportError::Core);
    let restore_result = state
        .library
        .open_workspace(&state.workspace_root)
        .map_err(MetadataImportError::Core)
        .map(|workspace| {
            install_workspace_cell(state, &mut cell_guard, workspace, search_aggression)
        });

    restore_result?;
    import_result
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
}
