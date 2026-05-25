//! Multi-drive host runtime.
//!
//! `DriveHost` is the in-process owner that chan-desktop can embed
//! instead of spawning one `chan serve` child per local drive. Each
//! mounted drive still gets its own `AppState`, watcher, indexer,
//! MCP bridge, control socket, terminal registry, and route prefix.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;
use chan_drive::{Drive, Library};
use tower::ServiceExt;

use crate::state::DriveCell;
use crate::{build_app, sanitize_prefix, AppArtifacts, Error, ServeConfig, ServeHandle};

/// One drive mounted into a [`DriveHost`].
#[derive(Debug, Clone)]
pub struct HostedDrive {
    /// Drive root for diagnostics and desktop state correlation.
    pub root: PathBuf,
    /// Canonical route prefix where the drive is mounted.
    pub prefix: String,
    /// Launch handle for browser/webview clients.
    pub handle: ServeHandle,
}

/// In-process multi-drive host.
///
/// This is intentionally a thin owner around the existing per-drive
/// server runtime. It does not share route state across drives:
/// mounting two drives builds two independent `AppState` instances
/// and dispatches by URL prefix.
pub struct DriveHost {
    library: Library,
    drives: RwLock<HashMap<String, HostedDriveRuntime>>,
}

struct HostedDriveRuntime {
    root: PathBuf,
    artifacts: AppArtifacts,
}

impl HostedDriveRuntime {
    fn router(&self) -> Router {
        self.artifacts.app.clone()
    }

    fn shutdown(&self) {
        let _ = self.artifacts.shutdown_tx.send(true);
        clear_drive_cell(&self.artifacts.drive_cell);
    }
}

impl Drop for HostedDriveRuntime {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl DriveHost {
    /// Create an empty host backed by the caller's `Library`.
    pub fn new(library: Library) -> Self {
        Self {
            library,
            drives: RwLock::new(HashMap::new()),
        }
    }

    /// Return the shared drive registry handle.
    pub fn library(&self) -> &Library {
        &self.library
    }

    /// Open a registered drive path and mount it under
    /// `config.prefix`.
    ///
    /// The path must already be registered with this host's
    /// `Library`. Desktop first-launch code can create/register the
    /// drive before calling this method; the CLI compatibility path
    /// keeps its existing auto-create behavior outside the host.
    pub async fn open_registered_drive(
        &self,
        root: impl AsRef<Path>,
        config: ServeConfig,
    ) -> Result<HostedDrive, Error> {
        let drive = self.library.open_drive(root.as_ref())?;
        self.open_drive(drive, config).await
    }

    /// Mount an already-open drive under `config.prefix`.
    pub async fn open_drive(
        &self,
        drive: Arc<Drive>,
        mut config: ServeConfig,
    ) -> Result<HostedDrive, Error> {
        config.prefix = sanitize_prefix(&config.prefix).map_err(Error::Config)?;
        let prefix = config.prefix.clone();
        let root = drive.root().to_path_buf();

        {
            let drives = self
                .drives
                .read()
                .map_err(|_| Error::Config("drive host lock poisoned".into()))?;
            if drives.contains_key(&prefix) {
                return Err(Error::Config(format!(
                    "drive prefix already mounted: {}",
                    display_prefix(&prefix)
                )));
            }
            if drives.values().any(|runtime| runtime.root == root) {
                return Err(Error::Config(format!(
                    "drive already mounted: {}",
                    root.display()
                )));
            }
        }

        let artifacts = build_app(self.library.clone(), drive, &config).await?;
        let handle = ServeHandle {
            addr: config.addr,
            prefix: prefix.clone(),
            token: artifacts.token.clone(),
        };
        let hosted = HostedDrive {
            root: root.clone(),
            prefix: prefix.clone(),
            handle,
        };
        let runtime = HostedDriveRuntime { root, artifacts };

        let mut drives = self
            .drives
            .write()
            .map_err(|_| Error::Config("drive host lock poisoned".into()))?;
        if drives.contains_key(&prefix) {
            return Err(Error::Config(format!(
                "drive prefix already mounted: {}",
                display_prefix(&prefix)
            )));
        }
        drives.insert(prefix, runtime);
        Ok(hosted)
    }

    /// Close the drive mounted at `prefix`.
    ///
    /// Returns `Ok(false)` when no drive is mounted there. Closing
    /// sends the shared shutdown signal before dropping the runtime,
    /// so active WebSockets and terminal sessions get a clean exit
    /// path.
    pub fn close_drive(&self, prefix: &str) -> Result<bool, Error> {
        let prefix = sanitize_prefix(prefix).map_err(Error::Config)?;
        let runtime = {
            let mut drives = self
                .drives
                .write()
                .map_err(|_| Error::Config("drive host lock poisoned".into()))?;
            drives.remove(&prefix)
        };
        Ok(runtime.is_some())
    }

    /// Snapshot the mounted prefixes.
    pub fn mounted_prefixes(&self) -> Result<Vec<String>, Error> {
        let drives = self
            .drives
            .read()
            .map_err(|_| Error::Config("drive host lock poisoned".into()))?;
        let mut prefixes: Vec<String> = drives.keys().cloned().collect();
        prefixes.sort();
        Ok(prefixes)
    }

    /// Build a dynamic router for all mounted drives.
    ///
    /// The returned router consults the host map on every request, so
    /// later `open_*` and `close_drive` calls are visible without
    /// rebuilding the outer axum app.
    pub fn router(self: Arc<Self>) -> Router {
        Router::new().fallback(host_dispatch).with_state(self)
    }

    fn router_for_path(&self, path: &str) -> Result<Option<Router>, Error> {
        let drives = self
            .drives
            .read()
            .map_err(|_| Error::Config("drive host lock poisoned".into()))?;
        Ok(drives
            .iter()
            .filter(|(prefix, _)| path_matches_prefix(path, prefix))
            .max_by_key(|(prefix, _)| prefix.len())
            .map(|(_, runtime)| runtime.router()))
    }
}

async fn host_dispatch(State(host): State<Arc<DriveHost>>, req: Request<Body>) -> Response {
    let Some(router) = (match host.router_for_path(req.uri().path()) {
        Ok(router) => router,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    match router.oneshot(req).await {
        Ok(response) => response,
        Err(e) => match e {},
    }
}

fn path_matches_prefix(path: &str, prefix: &str) -> bool {
    if prefix.is_empty() {
        return true;
    }
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn display_prefix(prefix: &str) -> &str {
    if prefix.is_empty() {
        "/"
    } else {
        prefix
    }
}

fn clear_drive_cell(drive_cell: &Arc<RwLock<Option<DriveCell>>>) {
    let cell = match drive_cell.write() {
        Ok(mut cell) => cell.take(),
        Err(_) => return,
    };
    let Some(cell) = cell else {
        return;
    };
    let DriveCell {
        drive,
        watch_handle,
        indexer,
    } = cell;
    // Clear the shared cell before socket accept loops finish aborting;
    // otherwise their stale Arc can keep the drive marked open.
    indexer.cancel();
    drop(watch_handle);
    drop(indexer);
    drop(drive);
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    fn serve_config(prefix: &str) -> ServeConfig {
        ServeConfig {
            addr: ([127, 0, 0, 1], 0).into(),
            no_token: true,
            prefix: prefix.to_string(),
            idle_timeout: None,
            open_browser: false,
            search_aggression: None,
            settings_disabled: false,
            tunnel_public: false,
        }
    }

    async fn response_json(response: Response) -> serde_json::Value {
        let (parts, body) = response.into_parts();
        assert_eq!(parts.status, StatusCode::OK);
        let bytes = to_bytes(body, 1024 * 1024).await.expect("read body");
        serde_json::from_slice(&bytes).expect("json response")
    }

    #[tokio::test]
    async fn host_routes_requests_to_the_matching_drive_prefix() {
        let cfg = tempfile::tempdir().expect("config dir");
        let root_a = tempfile::tempdir().expect("drive a");
        let root_b = tempfile::tempdir().expect("drive b");
        std::fs::write(root_a.path().join("a.md"), "# A\n").expect("write a");
        std::fs::write(root_b.path().join("b.md"), "# B\n").expect("write b");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_drive(root_a.path()).expect("register a");
        lib.register_drive(root_b.path()).expect("register b");
        let host = Arc::new(DriveHost::new(lib.clone()));

        host.open_registered_drive(root_a.path(), serve_config("/a"))
            .await
            .expect("open a");
        host.open_registered_drive(root_b.path(), serve_config("/b"))
            .await
            .expect("open b");

        let app = host.router();
        let a = response_json(
            app.clone()
                .oneshot(
                    Request::builder()
                        .uri("/a/api/drive")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        let b = response_json(
            app.oneshot(
                Request::builder()
                    .uri("/b/api/drive")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
        )
        .await;

        let root_a = root_a.path().canonicalize().expect("canonical a");
        let root_b = root_b.path().canonicalize().expect("canonical b");
        assert_eq!(a["root"], root_a.to_string_lossy().as_ref());
        assert_eq!(b["root"], root_b.to_string_lossy().as_ref());
    }

    #[tokio::test]
    async fn host_close_drive_removes_the_route() {
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("drive");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_drive(root.path()).expect("register");
        let host = Arc::new(DriveHost::new(lib.clone()));
        host.open_registered_drive(root.path(), serve_config("/drive"))
            .await
            .expect("open");
        let app = host.clone().router();

        assert!(host.close_drive("/drive").expect("close"));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/drive/api/drive")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn host_close_drive_releases_handle_for_immediate_reopen() {
        let cfg = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("drive");
        let lib = Library::open_at(cfg.path().join("config.toml")).expect("library");
        lib.register_drive(root.path()).expect("register");
        let host = Arc::new(DriveHost::new(lib.clone()));

        host.open_registered_drive(root.path(), serve_config("/first"))
            .await
            .expect("open first");
        assert!(host.close_drive("/first").expect("close first"));

        host.open_registered_drive(root.path(), serve_config("/second"))
            .await
            .expect("reopen after close");
    }

    #[test]
    fn path_prefix_matching_uses_segment_boundaries() {
        assert!(path_matches_prefix("/drive", "/drive"));
        assert!(path_matches_prefix("/drive/api/drive", "/drive"));
        assert!(!path_matches_prefix("/driveway/api/drive", "/drive"));
        assert!(path_matches_prefix("/anything", ""));
    }
}
