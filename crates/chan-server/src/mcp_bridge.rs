//! In-process MCP server exposed over a Unix-domain socket.
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
//! to a Unix-domain socket the bridge listens on; the proxy just
//! pipes stdin/stdout through the socket. No second workspace open, no
//! flock contention.
//!
//! Lifetime: the bridge spawns at boot inside `build_app`. The
//! returned `BridgeHandle` owns the socket-cleanup `Drop` and the
//! accept-loop join handle; serve()/shutdown drops it explicitly so
//! the socket file is unlinked even when the runtime is torn down
//! abruptly.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use chan_llm::mcp::AgentInboxProvider;
use chan_llm::team_work::{self, TeamWorkIdentity};
use rand::RngCore;
use tokio::io::{AsyncRead, AsyncReadExt};
#[cfg(unix)]
use tokio::net::UnixListener;
#[cfg(unix)]
use tokio::task::JoinHandle;

const PRELUDE_DETECTION_TIMEOUT: Duration = Duration::from_millis(25);
const PRELUDE_MAX_LINE_BYTES: usize = 4096;

/// Pick a unique socket path under the system tmp dir. macOS caps
/// `sun_path` at 104 bytes, so the suffix is short and the directory
/// short; `/tmp/chan-mcp-<pid>-<8 hex>.sock` fits well within that.
pub fn pick_socket_path() -> PathBuf {
    pick_named_socket_path("mcp")
}

pub(crate) fn pick_named_socket_path(name: &str) -> PathBuf {
    let mut bytes = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut bytes);
    let suffix: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    std::env::temp_dir().join(format!("chan-{name}-{}-{suffix}.sock", std::process::id()))
}

/// Bridge handle returned from `start`. Drop = abort the accept loop
/// and unlink the socket file. Held by `AppState` for the lifetime
/// of the chan-server process.
#[cfg(unix)]
pub struct BridgeHandle {
    socket_path: PathBuf,
    accept_loop: Option<JoinHandle<()>>,
}

/// Windows stub: chan-server's MCP bridge relies on Unix-domain
/// sockets, which are not how the chan stack reaches subprocess
/// agents on Windows. The handle still exists so `AppArtifacts` has
/// a stable type across targets; `start` returns `Unsupported` so
/// the caller falls back to `mcp_socket_path = None`.
#[cfg(not(unix))]
pub struct BridgeHandle {
    socket_path: PathBuf,
}

#[cfg(unix)]
impl Drop for BridgeHandle {
    fn drop(&mut self) {
        if let Some(h) = self.accept_loop.take() {
            h.abort();
        }
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

/// Bind the socket and spawn an accept loop. Each accepted connection
/// gets a fresh `chan_llm::mcp::Server` constructed against the
/// current workspace Arc.
#[cfg(unix)]
pub fn start<DF>(
    socket_path: PathBuf,
    workspace_for: DF,
    agent_inbox_provider: Option<Arc<dyn AgentInboxProvider>>,
) -> std::io::Result<BridgeHandle>
where
    DF: Fn() -> Option<Arc<chan_workspace::Workspace>> + Send + Sync + 'static,
{
    // Stale socket from a previous run that didn't get to clean up
    // (kill -9, panic in Drop): unlink so bind doesn't EADDRINUSE.
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path)?;
    let workspace_for = Arc::new(workspace_for);
    let agent_inbox_provider = agent_inbox_provider;

    let accept_loop = tokio::spawn(async move {
        loop {
            let (stream, _) = match listener.accept().await {
                Ok(pair) => pair,
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
            let agent_inbox_provider = agent_inbox_provider.clone();
            tokio::spawn(async move {
                let (read, write) = stream.into_split();
                let (identity, read) = detect_proxy_prelude(read).await;
                let mut server =
                    chan_llm::mcp::Server::new(workspace).with_team_work_identity(identity);
                if let Some(provider) = agent_inbox_provider {
                    server = server.with_agent_inbox_provider_dyn(provider);
                }
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

async fn detect_proxy_prelude<R>(
    mut reader: R,
) -> (
    TeamWorkIdentity,
    tokio::io::Chain<std::io::Cursor<Vec<u8>>, R>,
)
where
    R: AsyncRead + Unpin,
{
    let prefix = team_work::MCP_PROXY_PRELUDE_PREFIX.as_bytes();
    let mut buffered = Vec::new();
    let Some(first) = read_byte_bounded(&mut reader).await else {
        return (
            TeamWorkIdentity::default(),
            std::io::Cursor::new(buffered).chain(reader),
        );
    };
    buffered.push(first);

    while buffered.len() < prefix.len() {
        if !prefix.starts_with(&buffered) {
            return (
                TeamWorkIdentity::default(),
                std::io::Cursor::new(buffered).chain(reader),
            );
        }
        let Some(byte) = read_byte_bounded(&mut reader).await else {
            return (
                TeamWorkIdentity::default(),
                std::io::Cursor::new(buffered).chain(reader),
            );
        };
        buffered.push(byte);
    }

    if buffered != prefix {
        return (
            TeamWorkIdentity::default(),
            std::io::Cursor::new(buffered).chain(reader),
        );
    }

    while buffered.len() < PRELUDE_MAX_LINE_BYTES && !buffered.ends_with(b"\n") {
        let Some(byte) = read_byte_bounded(&mut reader).await else {
            return (
                TeamWorkIdentity::default(),
                std::io::Cursor::new(Vec::new()).chain(reader),
            );
        };
        buffered.push(byte);
    }

    let line = String::from_utf8_lossy(&buffered);
    let identity = team_work::parse_proxy_prelude(&line).unwrap_or_default();
    (identity, std::io::Cursor::new(Vec::new()).chain(reader))
}

async fn read_byte_bounded<R>(reader: &mut R) -> Option<u8>
where
    R: AsyncRead + Unpin,
{
    match tokio::time::timeout(PRELUDE_DETECTION_TIMEOUT, reader.read_u8()).await {
        Ok(Ok(byte)) => Some(byte),
        Ok(Err(_)) | Err(_) => None,
    }
}

#[cfg(not(unix))]
pub fn start<DF>(
    _socket_path: PathBuf,
    _workspace_for: DF,
    _agent_inbox_provider: Option<Arc<dyn AgentInboxProvider>>,
) -> std::io::Result<BridgeHandle>
where
    DF: Fn() -> Option<Arc<chan_workspace::Workspace>> + Send + Sync + 'static,
{
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "mcp bridge requires unix-domain sockets",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    #[tokio::test]
    async fn valid_proxy_prelude_is_stripped_and_supplies_identity() {
        let input = b"CHAN-MCP-PROXY 1 {\"team\":\"alpha\",\"agent\":\"@@FullStackA\"}\nContent-Length: 2\r\n\r\n{}";
        let (identity, mut reader) = detect_proxy_prelude(std::io::Cursor::new(input)).await;
        let mut rest = String::new();
        reader.read_to_string(&mut rest).await.unwrap();

        assert_eq!(identity.team.as_deref(), Some("alpha"));
        assert_eq!(identity.agent.as_deref(), Some("@@FullStackA"));
        assert_eq!(rest, "Content-Length: 2\r\n\r\n{}");
    }

    #[tokio::test]
    async fn non_prelude_bytes_are_replayed() {
        let input = b"Content-Length: 2\r\n\r\n{}";
        let (identity, mut reader) = detect_proxy_prelude(std::io::Cursor::new(input)).await;
        let mut rest = String::new();
        reader.read_to_string(&mut rest).await.unwrap();

        assert_eq!(identity, TeamWorkIdentity::default());
        assert_eq!(rest, "Content-Length: 2\r\n\r\n{}");
    }

    #[tokio::test]
    async fn malformed_reserved_prelude_is_consumed() {
        let input = b"CHAN-MCP-PROXY 2 {\"team\":\"alpha\",\"agent\":\"@@FullStackA\"}\nContent-Length: 2\r\n\r\n{}";
        let (identity, mut reader) = detect_proxy_prelude(std::io::Cursor::new(input)).await;
        let mut rest = String::new();
        reader.read_to_string(&mut rest).await.unwrap();

        assert_eq!(identity, TeamWorkIdentity::default());
        assert_eq!(rest, "Content-Length: 2\r\n\r\n{}");
    }

    #[tokio::test]
    async fn prelude_detection_does_not_wait_indefinitely() {
        let (_client, server) = tokio::io::duplex(64);
        let result =
            tokio::time::timeout(Duration::from_secs(1), detect_proxy_prelude(server)).await;

        assert!(result.is_ok());
    }
}
