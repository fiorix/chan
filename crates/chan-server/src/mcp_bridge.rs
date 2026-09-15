//! In-process MCP server exposed over a local IPC transport.
//!
//! External agents connect through `chan __mcp-proxy`, which pipes stdio
//! through the bridge endpoint. The in-process MCP service borrows the
//! tenant's workspace through its cell resolver. Each blocking tool body
//! reads the cell, waiting for any reset or import to install its replacement.
//! Waiting requests, idle sessions and stalled response writes do not retain
//! the workspace; a cleared cell answers "workspace is closed".
//!
//! Transport: the bridge reuses the control socket's cross-platform
//! [`transport`](crate::control_socket::transport) module -- a Unix-domain
//! socket on unix, a named pipe on Windows -- so MCP is reachable on both.
//! `chan_llm::mcp::Server::serve_io` is generic over `AsyncRead + AsyncWrite`,
//! so the platform-specific stream halves plug straight in with no chan-llm
//! change.
//!
//! Lifetime: `build_app` starts the bridge and keeps its `BridgeHandle` in
//! the tenant keepalive. Unmount drops it, aborting the accept loop and its
//! owned sessions before the host waits for workspace release. A blocking
//! tool body already running can retain the workspace until it returns.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rand::RngCore;
use tokio::task::{JoinHandle, JoinSet};

use crate::control_socket::transport;

/// Pick a unique IPC endpoint path: `$XDG_RUNTIME_DIR/chan-mcp-<pid>-<hex>.sock`
/// on Unix when available, `/tmp/chan-mcp-<pid>-<hex>.sock` otherwise, and
/// `\\.\pipe\chan-mcp-<pid>-<hex>` on Windows.
pub fn pick_socket_path() -> PathBuf {
    pick_named_socket_path("mcp")
}

fn random_suffix() -> String {
    let mut bytes = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// macOS caps `sun_path` at 104 bytes, so the suffix is short and the
/// no-XDG fallback stays in short `/tmp`; `/tmp/chan-<name>-<pid>-<8 hex>.sock`
/// fits well within that. On Windows a named pipe is
/// `\\.\pipe\chan-<name>-<pid>-<8 hex>`.
#[cfg(unix)]
pub(crate) fn pick_named_socket_path(name: &str) -> PathBuf {
    unix_socket_dir().join(format!(
        "chan-{name}-{}-{}.sock",
        std::process::id(),
        random_suffix()
    ))
}

#[cfg(unix)]
fn xdg_runtime_dir() -> Option<PathBuf> {
    std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
}

#[cfg(unix)]
pub(crate) fn unix_socket_dir() -> PathBuf {
    xdg_runtime_dir().unwrap_or_else(|| PathBuf::from("/tmp"))
}

#[cfg(windows)]
pub(crate) fn pick_named_socket_path(name: &str) -> PathBuf {
    PathBuf::from(format!(
        r"\\.\pipe\chan-{name}-{}-{}",
        std::process::id(),
        random_suffix()
    ))
}

/// Connect stdio to a running chan-server MCP endpoint. Used by the
/// `chan __mcp-proxy` and `chan-desktop __mcp-proxy` hidden commands.
pub async fn run_stdio_proxy(socket: PathBuf) -> std::io::Result<()> {
    use tokio::io::{stdin, stdout};

    let client = connect_mcp(&socket).await?;
    let (mut read_sock, mut write_sock) = client.into_split();
    let mut stdin = stdin();
    let mut stdout = stdout();
    let to_socket = tokio::io::copy(&mut stdin, &mut write_sock);
    let from_socket = tokio::io::copy(&mut read_sock, &mut stdout);
    tokio::select! {
        r = to_socket => {
            r?;
        }
        r = from_socket => {
            r?;
        }
    }
    Ok(())
}

/// Connect to the MCP endpoint. On unix a stale configured socket falls back
/// to a live `chan-mcp-*.sock` sibling (a server that re-minted its path);
/// named pipes are not filesystem nodes, so Windows just connects.
#[cfg(unix)]
async fn connect_mcp(socket: &Path) -> std::io::Result<transport::Client> {
    connect_mcp_in(socket, mcp_socket_fallback_dirs(socket)).await
}

#[cfg(not(unix))]
async fn connect_mcp(socket: &Path) -> std::io::Result<transport::Client> {
    transport::connect(socket).await
}

#[cfg(unix)]
async fn connect_mcp_in<I, P>(socket: &Path, fallback_dirs: I) -> std::io::Result<transport::Client>
where
    I: IntoIterator<Item = P>,
    P: AsRef<Path>,
{
    match connect_owner_socket(socket).await {
        Ok(client) => Ok(client),
        Err(primary) if should_try_mcp_socket_fallback(&primary) => {
            for candidate in mcp_socket_fallback_candidates_in(fallback_dirs, socket) {
                if let Ok(client) = connect_owner_socket(&candidate).await {
                    tracing::warn!(
                        configured = %socket.display(),
                        fallback = %candidate.display(),
                        "configured MCP socket is stale; using live fallback"
                    );
                    return Ok(client);
                }
            }
            Err(primary)
        }
        Err(primary) => Err(primary),
    }
}

#[cfg(unix)]
async fn connect_owner_socket(socket: &Path) -> std::io::Result<transport::Client> {
    crate::local_socket::owner_socket_metadata(socket, crate::local_socket::effective_uid())?;
    transport::connect(socket).await
}

#[cfg(unix)]
fn mcp_socket_fallback_dirs(socket: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(parent) = socket.parent().filter(|dir| !dir.as_os_str().is_empty()) {
        push_unique_path(&mut dirs, parent.to_path_buf());
    }
    push_unique_path(&mut dirs, unix_socket_dir());
    push_unique_path(&mut dirs, PathBuf::from("/tmp"));
    dirs
}

#[cfg(unix)]
fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

#[cfg(unix)]
fn should_try_mcp_socket_fallback(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
    )
}

#[cfg(unix)]
fn mcp_socket_fallback_candidates_in<I, P>(dirs: I, preferred: &Path) -> Vec<PathBuf>
where
    I: IntoIterator<Item = P>,
    P: AsRef<Path>,
{
    mcp_socket_fallback_candidates_for_uid(dirs, preferred, crate::local_socket::effective_uid())
}

#[cfg(unix)]
fn mcp_socket_fallback_candidates_for_uid<I, P>(
    dirs: I,
    preferred: &Path,
    euid: u32,
) -> Vec<PathBuf>
where
    I: IntoIterator<Item = P>,
    P: AsRef<Path>,
{
    let mut out = Vec::new();
    let mut seen_dirs = Vec::new();
    for dir in dirs {
        let dir = dir.as_ref();
        if seen_dirs.iter().any(|seen| seen == dir) {
            continue;
        }
        seen_dirs.push(dir.to_path_buf());
        let read_dir = match std::fs::read_dir(dir) {
            Ok(read_dir) => read_dir,
            Err(_) => continue,
        };
        let mut candidates: Vec<(std::time::SystemTime, PathBuf)> = read_dir
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| {
                let path = entry.path();
                if path == preferred {
                    return None;
                }
                let name = path.file_name()?.to_str()?;
                if !name.starts_with("chan-mcp-") || !name.ends_with(".sock") {
                    return None;
                }
                let metadata = crate::local_socket::owner_socket_metadata(&path, euid).ok()?;
                let modified = metadata
                    .modified()
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                Some((modified, path))
            })
            .collect();
        candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        out.extend(candidates.into_iter().map(|(_, path)| path));
    }
    out
}

/// Bridge handle returned from `start`. Drop = abort the accept loop and sessions
/// and (on unix) unlink the socket file; a Windows named pipe is reclaimed
/// by the OS once the last handle drops. The tenant keepalive owns this handle
/// and drops it during unmount, before the workspace-release wait.
pub struct BridgeHandle {
    socket_path: PathBuf,
    accept_loop: Option<JoinHandle<()>>,
    #[cfg(all(test, unix))]
    accepted: Arc<tokio::sync::Semaphore>,
}

impl BridgeHandle {
    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }
}

impl Drop for BridgeHandle {
    fn drop(&mut self) {
        if let Some(h) = self.accept_loop.take() {
            h.abort();
        }
        // Unix sockets are filesystem nodes that must be unlinked; a Windows
        // named pipe has no path node and is reclaimed by the OS.
        #[cfg(unix)]
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

/// Bind the endpoint and spawn an accept loop. Each accepted connection
/// gets a fresh `chan_llm::mcp::Server` with the tenant workspace resolver.
/// Only blocking tool bodies invoke the resolver, so session admission does
/// not wait on a workspace swap or retain a workspace snapshot.
pub fn start<DF>(socket_path: PathBuf, workspace_for: DF) -> std::io::Result<BridgeHandle>
where
    DF: Fn() -> Option<Arc<chan_workspace::Workspace>> + Send + Sync + 'static,
{
    let mut listener = transport::bind(&socket_path)?;
    let workspace_for = Arc::new(workspace_for);
    #[cfg(all(test, unix))]
    let accepted = Arc::new(tokio::sync::Semaphore::new(0));
    #[cfg(all(test, unix))]
    let acceptance = accepted.clone();

    let accept_loop = tokio::spawn(async move {
        let mut sessions = JoinSet::new();
        loop {
            let accepted = tokio::select! {
                accepted = listener.accept() => accepted,
                _ = sessions.join_next(), if !sessions.is_empty() => continue,
            };
            let conn = match accepted {
                Ok(conn) => conn,
                Err(e) => {
                    tracing::warn!("mcp bridge accept: {e}");
                    // Brief pause so a transient error doesn't spin
                    // a tight CPU loop; the listener stays alive.
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    continue;
                }
            };
            let resolver = workspace_for.clone();
            let server = chan_llm::mcp::Server::from_resolver(move || resolver());
            sessions.spawn(async move {
                let (read, write) = conn.into_split();
                if let Err(e) = server.serve_io(read, write).await {
                    tracing::debug!("mcp bridge session: {e}");
                }
            });
            #[cfg(all(test, unix))]
            acceptance.add_permits(1);
        }
    });

    Ok(BridgeHandle {
        socket_path,
        accept_loop: Some(accept_loop),
        #[cfg(all(test, unix))]
        accepted,
    })
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    async fn read_rpc<R: tokio::io::AsyncBufRead + Unpin>(read: &mut R) -> serde_json::Value {
        let mut line = String::new();
        assert_ne!(read.read_line(&mut line).await.unwrap(), 0);
        serde_json::from_str(&line).unwrap()
    }

    async fn bridge_call_during_workspace_swap(import: bool) {
        use axum::body::Body;
        use axum::http::{Request, StatusCode};
        use tower::ServiceExt;
        tokio::time::timeout(Duration::from_secs(15), async {
            let config = tempfile::tempdir().unwrap();
            let root = tempfile::tempdir().unwrap();
            let library = chan_workspace::Library::open_at(config.path().join("config.toml")).unwrap();
            library.register_workspace(root.path()).unwrap();
            let workspace = library.open_workspace(root.path()).unwrap();
            workspace.write_text("live.md", "original").unwrap();
            workspace.stop_open_recovery();
            let weak = Arc::downgrade(&workspace);
            let serve = chan_library::ServeConfig {
                addr: ([127, 0, 0, 1], 0).into(), prefix: "/workspace".into(),
                no_token: true, idle_timeout: None, open_browser: false,
                search_aggression: None, verbose: false, settings_disabled: false,
            };
            let mut artifacts = crate::build_app(library, workspace, &serve,
                Default::default(), chan_library::UnserveMode::Unsupported, None).await.unwrap();
            artifacts.tasks.shutdown().await;
            drop(artifacts.mcp_bridge.take());
            let state = artifacts.state.clone();
            let workspace = state.try_workspace().unwrap();
            let archive_dir = tempfile::tempdir().unwrap();
            let archive = if import {
                let path = archive_dir.path().join("metadata.tar.zst");
                state.library.export_metadata_archive(&state.workspace_root, &path,
                    chan_workspace::MetadataExportOptions { chan_version: "test".into() }).unwrap();
                Some(std::fs::read(path).unwrap())
            } else {
                None
            };
            let doc = state.doc_sessions.attach(&workspace, "live.md", "window", None).await.unwrap();
            doc.session().apply_replace("writer", "flushed content").unwrap();
            drop(workspace);
            let resolver_cell = state.workspace_cell.clone();
            let probe = Arc::new(std::sync::Mutex::new(None));
            let resolver_probe = probe.clone();
            let bridge = start(pick_socket_path(), move || {
                if let Some(entered) = resolver_probe.lock().unwrap().take() {
                    let entered: tokio::sync::oneshot::Sender<()> = entered;
                    entered.send(()).unwrap();
                }
                resolver_cell.read().unwrap().as_ref().map(|cell| cell.workspace.clone())
            }).unwrap();
            let client = tokio::net::UnixStream::connect(bridge.socket_path()).await.unwrap();
            let (read, mut write) = client.into_split();
            let mut read = BufReader::new(read);
            let initialize = serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                    "clientInfo": {"name": "swap-test", "version": "0"}}});
            write.write_all(format!("{initialize}\n").as_bytes()).await.unwrap();
            assert_eq!(read_rpc(&mut read).await["result"]["serverInfo"]["name"], "chan");
            write.write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}\n").await.unwrap();
            assert_eq!(read_rpc(&mut read).await["id"], 2);
            let (entered, entry) = tokio::sync::oneshot::channel();
            *probe.lock().unwrap() = Some(entered);
            let (flushing, flush_started) = tokio::sync::oneshot::channel();
            let (release, released) = std::sync::mpsc::channel();
            crate::routes::install_test_session_close_gate(&state.workspace_root, flushing, released);
            let app = axum::Router::new()
                .route("/reset", axum::routing::post(crate::routes::api_storage_reset))
                .route("/import", axum::routing::post(crate::routes::api_metadata_import))
                .with_state(state.clone());
            let request = if let Some(archive) = archive {
                let mut body = b"--import\r\nContent-Disposition: form-data; name=\"rescan\"\r\n\r\nfalse\r\n--import\r\nContent-Disposition: form-data; name=\"file\"; filename=\"metadata.tar.zst\"\r\n\r\n".to_vec();
                body.extend_from_slice(&archive);
                body.extend_from_slice(b"\r\n--import--\r\n");
                Request::post("/import").header("content-type", "multipart/form-data; boundary=import")
                    .body(Body::from(body)).unwrap()
            } else {
                Request::post("/reset").header("content-type", "application/json")
                    .body(Body::from(r#"{"mode":"workspace"}"#)).unwrap()
            };
            let swapping = tokio::spawn(app.oneshot(request));
            flush_started.await.unwrap();
            assert!(state.workspace_cell.try_read().is_err());
            assert_eq!(weak.strong_count(), 1);
            let request = serde_json::json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": {"name": "read_file", "arguments": {"path": "live.md"}}});
            write.write_all(format!("{request}\n").as_bytes()).await.unwrap();
            let early_reply = tokio::select! {
                entered = entry => { entered.unwrap(); None },
                reply = read_rpc(&mut read) => Some(reply),
            };
            assert_eq!(weak.strong_count(), 1);
            release.send(()).unwrap();
            let response = swapping.await.unwrap().unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert!(state.try_workspace().is_ok(), "swap left the tenant without a workspace");
            let first_reply = match early_reply {
                Some(reply) => reply,
                None => read_rpc(&mut read).await,
            };
            let request = serde_json::json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                "params": {"name": "read_file", "arguments": {"path": "live.md"}}});
            write.write_all(format!("{request}\n").as_bytes()).await.unwrap();
            let second_reply = read_rpc(&mut read).await;
            for reply in [&first_reply, &second_reply] {
                let text = reply["result"]["content"][0]["text"].as_str()
                    .unwrap_or_else(|| panic!("bridge lost the replacement workspace: {reply}"));
                let value: serde_json::Value = serde_json::from_str(text).unwrap();
                assert_eq!(value["content"], "flushed content", "tool bypassed the flush window: {reply}");
            }
            assert_eq!(weak.strong_count(), 0);
            drop(bridge);
            if let Some(cell) = artifacts.workspace_cell.write().unwrap().take() {
                cell.indexer.cancel();
                cell.workspace.stop_open_recovery();
            };
        }).await.unwrap();
    }

    #[tokio::test]
    async fn mcp_reset_flush_waits_for_the_replacement_workspace() {
        bridge_call_during_workspace_swap(false).await;
    }

    #[tokio::test]
    async fn mcp_import_flush_waits_for_the_replacement_workspace() {
        bridge_call_during_workspace_swap(true).await;
    }

    #[tokio::test]
    async fn mcp_idle_initialized_session_does_not_pin_the_workspace_cell() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let config = tempfile::tempdir().unwrap();
            let root = tempfile::tempdir().unwrap();
            let library = chan_workspace::Library::open_at(config.path().join("config.toml")).unwrap();
            library.register_workspace(root.path()).unwrap();
            let workspace = library.open_workspace(root.path()).unwrap();
            let weak = Arc::downgrade(&workspace);
            let lock_dir = workspace.paths().lock.clone();
            let cell = Arc::new(std::sync::Mutex::new(Some(workspace)));
            let bridge_cell = cell.clone();
            let handle = start(pick_socket_path(), move || bridge_cell.lock().unwrap().clone()).unwrap();
            let client = tokio::net::UnixStream::connect(handle.socket_path()).await.unwrap();
            let (read, mut write) = client.into_split();
            let mut read = BufReader::new(read);
            let initialize = serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                    "clientInfo": {"name": "cell-lifetime-test", "version": "0"}}});
            write.write_all(format!("{initialize}\n").as_bytes()).await.unwrap();
            let mut reply = String::new();
            read.read_line(&mut reply).await.unwrap();
            let reply: serde_json::Value = serde_json::from_str(&reply).unwrap();
            assert_eq!(reply["result"]["serverInfo"]["name"], "chan");
            write.write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}\n").await.unwrap();
            let mut reply = String::new();
            read.read_line(&mut reply).await.unwrap();
            assert_eq!(serde_json::from_str::<serde_json::Value>(&reply).unwrap()["id"], 2);
            drop(cell.lock().unwrap().take());
            tokio::time::timeout(Duration::from_secs(1), async {
                while weak.strong_count() != 0 || !chan_workspace::lock::is_free(&lock_dir) {
                    tokio::task::yield_now().await;
                }
            }).await.expect("idle MCP session retains the workspace cell's owner");
            let _reopened = library.open_workspace(root.path()).unwrap();
            drop(handle);
        }).await.unwrap();
    }

    #[tokio::test]
    async fn mcp_unmount_releases_a_silent_clients_workspace() {
        tokio::time::timeout(Duration::from_secs(4), async {
            let config = tempfile::tempdir().unwrap();
            let root = tempfile::tempdir().unwrap();
            let library =
                chan_workspace::Library::open_at(config.path().join("config.toml")).unwrap();
            library.register_workspace(root.path()).unwrap();
            let workspace = library.open_workspace(root.path()).unwrap();
            let weak = Arc::downgrade(&workspace);
            let lock_dir = workspace.paths().lock.clone();
            let handle = start(pick_socket_path(), move || Some(workspace.clone())).unwrap();
            let _client = tokio::net::UnixStream::connect(handle.socket_path())
                .await
                .unwrap();
            handle.accepted.acquire().await.unwrap().forget();
            drop(handle);
            let released = tokio::time::timeout(Duration::from_secs(1), async {
                while weak.strong_count() != 0 || !chan_workspace::lock::is_free(&lock_dir) {
                    tokio::task::yield_now().await;
                }
            })
            .await;
            assert!(
                released.is_ok(),
                "MCP client retains {} workspace handles",
                weak.strong_count()
            );
            let _reopened = library.open_workspace(root.path()).unwrap();
        })
        .await
        .unwrap();
    }

    struct SocketObservingBuilder(tokio::sync::mpsc::UnboundedSender<PathBuf>);

    #[async_trait::async_trait]
    impl chan_library::TenantBuilder for SocketObservingBuilder {
        async fn build_workspace(
            &self,
            library: chan_workspace::Library,
            workspace: Arc<chan_workspace::Workspace>,
            config: &chan_library::ServeConfig,
            desktop: chan_library::desktop_window_ops::DesktopBridge,
            unserve: chan_library::UnserveMode,
            control_identity: Option<String>,
        ) -> Result<chan_library::TenantArtifacts, chan_library::Error> {
            let artifacts = crate::build_app(
                library,
                workspace,
                config,
                desktop,
                unserve,
                control_identity,
            )
            .await?;
            self.0
                .send(
                    artifacts
                        .mcp_bridge
                        .as_ref()
                        .unwrap()
                        .socket_path()
                        .to_path_buf(),
                )
                .unwrap();
            Ok(crate::into_tenant_artifacts(artifacts))
        }

        async fn build_terminal(
            &self,
            _library: chan_workspace::Library,
            _config: &chan_library::ServeConfig,
            _desktop: chan_library::desktop_window_ops::DesktopBridge,
            _unserve: chan_library::UnserveMode,
            _command: Option<String>,
            _session_dir: Option<PathBuf>,
            _drafts_store_root: Option<PathBuf>,
            _control_identity: Option<String>,
        ) -> Result<chan_library::TenantArtifacts, chan_library::Error> {
            unreachable!("workspace-only test")
        }
    }

    #[tokio::test]
    async fn mcp_unmount_closes_hosted_sessions_before_waiting_for_the_flock() {
        tokio::time::timeout(Duration::from_secs(15), async {
            let config = tempfile::tempdir().unwrap();
            let root = tempfile::tempdir().unwrap();
            let library =
                chan_workspace::Library::open_at(config.path().join("config.toml")).unwrap();
            library.register_workspace(root.path()).unwrap();
            let (sockets, mut socket_rx) = tokio::sync::mpsc::unbounded_channel();
            let host = Arc::new(chan_library::WorkspaceHost::new(
                library,
                Arc::new(SocketObservingBuilder(sockets)),
            ));
            let serve = chan_library::ServeConfig {
                addr: ([127, 0, 0, 1], 0).into(),
                prefix: "/workspace".into(),
                no_token: true,
                idle_timeout: None,
                open_browser: false,
                search_aggression: None,
                verbose: false,
                settings_disabled: false,
            };
            host.open_registered_workspace(root.path(), serve.clone())
                .await
                .unwrap();
            for initialized in [false, true] {
                let socket = socket_rx.recv().await.unwrap();
                let workspace = host.live_workspace(root.path()).unwrap();
                let weak = Arc::downgrade(&workspace);
                let lock_dir = workspace.paths().lock.clone();
                let mut client = tokio::net::UnixStream::connect(socket).await.unwrap();
                let initialize = serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {},
                        "clientInfo": {"name": "close-test", "version": "0"}
                    }
                });
                client.write_all(format!("{initialize}\n").as_bytes()).await.unwrap();
                let mut reply = String::new();
                BufReader::new(&mut client).read_line(&mut reply).await.unwrap();
                let reply: serde_json::Value = serde_json::from_str(&reply).unwrap();
                assert_eq!(reply["result"]["serverInfo"]["name"], "chan");
                if initialized {
                    client.write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}\n").await.unwrap();
                    let mut reply = String::new();
                    BufReader::new(&mut client).read_line(&mut reply).await.unwrap();
                    let reply: serde_json::Value = serde_json::from_str(&reply).unwrap();
                    assert_eq!(reply["id"], 2);
                    assert!(reply.get("result").is_some(), "{reply}");
                }
                drop(workspace);
                // Allow loaded watcher backends time to stop, while staying
                // below the five-second workspace-release fallback window.
                let close_started = std::time::Instant::now();
                let closed = tokio::time::timeout(
                    Duration::from_secs(4),
                    host.close_workspace_for_root(root.path(), false),
                )
                .await;
                eprintln!(
                    "mcp_hosted_close initialized={initialized} elapsed_us={}",
                    close_started.elapsed().as_micros()
                );
                assert!(closed
                    .expect("close waited for an MCP client's flock")
                    .unwrap()
                    .completed());
                assert_eq!(weak.strong_count(), 0);
                assert!(chan_workspace::lock::is_free(&lock_dir));
                host.open_registered_workspace(root.path(), serve.clone())
                    .await
                    .unwrap();
                drop(client);
            }
            assert!(host
                .close_workspace_for_root(root.path(), false)
                .await
                .unwrap()
                .completed());
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn proxy_connect_falls_back_to_live_socket_when_configured_socket_is_stale() {
        let dir = tempfile::tempdir().unwrap();
        let preferred = dir.path().join("chan-mcp-stale.sock");
        let live = dir
            .path()
            .join(format!("chan-mcp-{}-fallback.sock", std::process::id()));
        let listener = tokio::net::UnixListener::bind(&live).unwrap();
        let accept = tokio::spawn(async move {
            let _ = listener.accept().await.unwrap();
        });

        let client = connect_mcp_in(&preferred, [dir.path()]).await.unwrap();
        drop(client);
        accept.await.unwrap();
    }

    #[test]
    fn fallback_candidates_require_owned_socket_nodes() {
        let dir = tempfile::tempdir().unwrap();
        let preferred = dir.path().join("chan-mcp-stale.sock");
        let real = dir.path().join("chan-mcp-real.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&real).unwrap();
        let file = dir.path().join("chan-mcp-file.sock");
        std::fs::write(&file, "not a socket").unwrap();
        let link = dir.path().join("chan-mcp-link.sock");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert_eq!(
            mcp_socket_fallback_candidates_in([dir.path()], &preferred),
            vec![real]
        );
    }

    #[test]
    fn fallback_candidates_reject_a_different_owner_without_chown() {
        let dir = tempfile::tempdir().unwrap();
        let preferred = dir.path().join("chan-mcp-stale.sock");
        let real = dir.path().join("chan-mcp-real.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&real).unwrap();
        let uid = rustix::process::geteuid().as_raw();
        assert_eq!(
            mcp_socket_fallback_candidates_for_uid([dir.path()], &preferred, uid),
            vec![real.clone()]
        );
        assert_eq!(
            mcp_socket_fallback_candidates_for_uid([dir.path()], &preferred, uid ^ 1),
            Vec::<PathBuf>::new()
        );
    }

    #[tokio::test]
    async fn proxy_primary_requires_an_owned_socket_node() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("chan-mcp-real.sock");
        let listener = tokio::net::UnixListener::bind(&real).unwrap();
        let link = dir.path().join("chan-mcp-link.sock");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let client = connect_mcp_in(&real, [dir.path()]).await.unwrap();
        let _ = listener.accept().await.unwrap();
        drop(client);
        let result = connect_mcp_in(&link, [dir.path()]).await;
        assert!(result.is_err_and(|e| e.kind() == std::io::ErrorKind::PermissionDenied));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(25), listener.accept())
                .await
                .is_err()
        );
    }

    #[test]
    fn fallback_dirs_cover_configured_runtime_and_tmp_once() {
        let configured = Path::new("/configured/chan-mcp-old.sock");
        let dirs = mcp_socket_fallback_dirs(configured);
        assert!(dirs.contains(&PathBuf::from("/configured")));
        assert!(dirs.contains(&PathBuf::from("/tmp")));
        let mut unique = dirs.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(dirs.len(), unique.len());
    }
}
