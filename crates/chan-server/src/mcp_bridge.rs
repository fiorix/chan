//! In-process MCP server exposed over a local IPC transport.
//!
//! External MCP agents want to launch the chan MCP server as a
//! subprocess so writes round-trip through chan-workspace's gates. The
//! original wiring spawned `chan __mcp <workspace_root>`, which then
//! called `Library::open_workspace` a second time. chan-workspace holds a
//! per-workspace flock for single-writer ownership, so the child failed
//! with `WorkspaceLocked`.
//!
//! The bridge resolves that conflict: chan-server already owns an
//! `Arc<Workspace>` for the workspace it serves, so the MCP service is run
//! in-process. Each external agent connects through `chan __mcp-proxy`
//! to a local IPC endpoint the bridge listens on; the proxy just pipes
//! stdin/stdout through it. No second workspace open, no flock contention.
//!
//! Transport: the bridge reuses the control socket's cross-platform
//! [`transport`](crate::control_socket::transport) module -- a Unix-domain
//! socket on unix, a named pipe on Windows -- so MCP is reachable on both.
//! `chan_llm::mcp::Server::serve_io` is generic over `AsyncRead + AsyncWrite`,
//! so the platform-specific stream halves plug straight in with no chan-llm
//! change.
//!
//! Lifetime: the bridge spawns at boot inside `build_app`. The
//! returned `BridgeHandle` owns the socket-cleanup `Drop` and the
//! accept-loop join handle; serve()/shutdown drops it explicitly so
//! the endpoint is released even when the runtime is torn down abruptly.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rand::RngCore;
use tokio::task::JoinHandle;

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

/// Bridge handle returned from `start`. Drop = abort the accept loop
/// and (on unix) unlink the socket file; a Windows named pipe is reclaimed
/// by the OS once the last handle drops. Held by `AppState` for the lifetime
/// of the chan-server process.
pub struct BridgeHandle {
    socket_path: PathBuf,
    accept_loop: Option<JoinHandle<()>>,
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
/// gets a fresh `chan_llm::mcp::Server` constructed against the
/// current workspace Arc.
pub fn start<DF>(socket_path: PathBuf, workspace_for: DF) -> std::io::Result<BridgeHandle>
where
    DF: Fn() -> Option<Arc<chan_workspace::Workspace>> + Send + Sync + 'static,
{
    let mut listener = transport::bind(&socket_path)?;
    let workspace_for = Arc::new(workspace_for);

    let accept_loop = tokio::spawn(async move {
        loop {
            let conn = match listener.accept().await {
                Ok(conn) => conn,
                Err(e) => {
                    tracing::warn!("mcp bridge accept: {e}");
                    // Brief pause so a transient error doesn't spin
                    // a tight CPU loop; the listener stays alive.
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    continue;
                }
            };
            let Some(workspace) = workspace_for() else {
                tracing::warn!("mcp bridge session refused: workspace state unavailable");
                continue;
            };
            tokio::spawn(async move {
                let (read, write) = conn.into_split();
                let server = chan_llm::mcp::Server::new(workspace);
                if let Err(e) = server.serve_io(read, write).await {
                    tracing::debug!("mcp bridge session: {e}");
                }
            });
        }
    });

    Ok(BridgeHandle {
        socket_path,
        accept_loop: Some(accept_loop),
    })
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;

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
