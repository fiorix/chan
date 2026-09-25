//! CLI-to-devserver workspace registration over per-instance discovery
//! endpoints in a well-known per-user namespace.
//!
//! When a devserver is running on a box and the user types `chan serve
//! ~/notes` in a terminal there, the natural intent is "add this workspace
//! to the devserver," not "bind a second standalone server that fights the
//! devserver for the workspace flock." This module is the same-user IPC
//! channel that makes that registration possible.
//!
//! Discovery is a well-known per-user namespace (not the per-pid socket the
//! mcp_bridge / control_socket use). Each devserver owns one stable endpoint
//! inside it, derived from its library identity and port, so several local
//! instances remain independently discoverable. It is a SECOND endpoint
//! family alongside the singleton desktop handoff (`chan-desktop.sock`); a
//! box can run a devserver, a desktop, both, or neither. Same-user is enforced
//! by owner-only filesystem permissions plus a peer-credential check on Unix,
//! matching [`crate::handoff`].
//!
//! INVARIANT: exactly one process owns a workspace's writes (the
//! per-workspace flock). On a successful registration the DEVSERVER opens
//! and owns the workspace; the CLI is a launcher that exits WITHOUT opening
//! it. The CLI must therefore consult this module BEFORE it calls
//! `open_workspace`, so it never double-opens.
//!
//! The listener and client use Unix-domain sockets on unix and a named pipe on
//! Windows (mirroring [`crate::handoff`]); on any other target the types still
//! compile but discovery resolves to "no devserver" so the CLI keeps its
//! standalone behavior.

use serde::{Deserialize, Serialize};
#[cfg(any(unix, windows))]
use std::path::Path;
use std::path::PathBuf;
#[cfg(any(unix, windows))]
use std::time::Duration;

#[cfg(any(unix, windows))]
const CONNECT_TIMEOUT: Duration = Duration::from_millis(1500);
#[cfg(any(unix, windows))]
const IO_TIMEOUT: Duration = Duration::from_millis(3000);
// Exceeds devserver.rs's WORKSPACE_MOUNT_TIMEOUT (60 seconds), but the server
// first waits without a bound on its mount lock. Startup restore can hold
// that lock for minutes, so registration just after startup can time out.
#[cfg(any(unix, windows))]
const REGISTER_REPLY_TIMEOUT: Duration = Duration::from_secs(75);
#[cfg(any(unix, windows))]
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// Wire-protocol version of the registration RPC. The CLI and devserver
/// compare it in the handshake; a mismatch means NO registration (the CLI
/// falls back to standalone) rather than a silent decode of an unknown
/// shape. Independent of the management API's `DEVSERVER_API_PROTOCOL` and
/// of the desktop handoff's `PROTOCOL_VERSION`.
pub const PROTOCOL_VERSION: u32 = 2;

/// Human-facing crate version, baked at compile time. Carried in the
/// handshake so a skew message names concrete versions.
pub const CHAN_VERSION: &str = env!("CARGO_PKG_VERSION");

/// A live local devserver returned by [`discover_devservers`].
///
/// The endpoint stays private: callers select instances through the public
/// identity fields and pass the selected value to [`try_register_devserver`],
/// which owns the transport details.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Instance {
    endpoint: PathBuf,
    /// Process that answered the identity probe.
    pub pid: u32,
    /// Chan config root backing this instance's library.
    pub library_root: PathBuf,
    /// Bound local management port, or the configured port when tunnel-only.
    pub port: u16,
    /// Human chan version reported by the devserver.
    pub version: String,
}

/// CLI to devserver request. `tag = "type"` mirrors [`crate::handoff`], so
/// the on-wire shape is `{"type":"register_workspace", ...}`. The
/// `protocol` + `cli_version` handshake fields gate dispatch before the
/// devserver acts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    /// Ask a candidate endpoint which devserver instance owns it.
    Identify { protocol: u32, cli_version: String },
    /// Ask the devserver to mount the given workspace path, mint one workspace
    /// window record, and report the prefix it landed at. Mounting is
    /// idempotent, but every accepted request mints a new window.
    RegisterWorkspace {
        protocol: u32,
        cli_version: String,
        /// The workspace root the CLI was asked to serve, sent as a string
        /// for stable JSON across platforms.
        workspace_path: String,
    },
}

impl Request {
    #[cfg(any(unix, windows))]
    fn reply_budget(&self) -> Duration {
        match self {
            Request::Identify { .. } => IO_TIMEOUT,
            Request::RegisterWorkspace { .. } => REGISTER_REPLY_TIMEOUT,
        }
    }

    /// The handshake protocol version carried by any request variant.
    pub fn protocol(&self) -> u32 {
        match self {
            Request::Identify { protocol, .. } | Request::RegisterWorkspace { protocol, .. } => {
                *protocol
            }
        }
    }

    /// The CLI's human version, for skew logging.
    pub fn cli_version(&self) -> &str {
        match self {
            Request::Identify { cli_version, .. }
            | Request::RegisterWorkspace { cli_version, .. } => cli_version,
        }
    }
}

/// Devserver to CLI response. `tag = "type"` mirrors the request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Response {
    /// Identity reported by a live devserver discovery endpoint.
    Identified {
        pid: u32,
        library_root: PathBuf,
        port: u16,
        version: String,
    },
    /// The devserver mounted (or already had) the workspace at `prefix` and
    /// minted its requested window. The CLI prints a note and exits; the
    /// devserver owns the flock.
    Registered {
        devserver_version: String,
        prefix: String,
    },
    /// The devserver speaks a different protocol version. The CLI does NOT
    /// register; it prints the skew and falls back to standalone.
    VersionSkew {
        devserver_version: String,
        devserver_protocol: u32,
    },
    /// The devserver could not mount the workspace (e.g. a runtime error).
    /// The CLI logs the reason and falls back to standalone.
    Error { message: String },
}

/// Outcome of a registration attempt as the CLI resolves it. Not on the
/// wire: once the request was sent, a reply that times out, never arrives or
/// is invalid leaves the mount's outcome unknown and must not start a
/// competing standalone server.
#[derive(Debug)]
pub enum Outcome {
    /// The devserver mounted the workspace at `prefix` and minted its requested
    /// window. The CLI reports both and exits 0.
    Registered { prefix: String },
    /// No usable endpoint: connect refused, stale socket, or an I/O error
    /// before the request was sent. Own the server standalone.
    NoDevserver,
    /// The request was sent, but the devserver did not reply within its budget.
    /// The devserver may still be mounting the workspace.
    ReplyTimedOut,
    /// The request was sent, but the connection closed or failed before a
    /// reply, or the reply is not an answer to a registration. The devserver
    /// may still be mounting the workspace, or may have died while mounting.
    ReplyLost,
    /// The devserver is a different protocol version. Fall back to
    /// standalone after printing the skew.
    VersionSkew,
    /// The devserver answered but refused/failed. Fall back to standalone
    /// after logging the message.
    Error(String),
}

/// Resolve one stable per-instance discovery endpoint.
///
/// Unix endpoints live at `$XDG_RUNTIME_DIR/chan-devserver/<16hex>.sock`, or
/// `<tmp>/chan-devserver-<uid>/<16hex>.sock` without an XDG runtime dir. The
/// directory is created owner-only and rejected if another uid owns it.
/// Windows uses a per-user named-pipe prefix plus the same stable hash.
pub fn devserver_socket_path(library_id: &str, port: u16) -> Option<PathBuf> {
    let hash = devserver_socket_hash(library_id, port);
    #[cfg(unix)]
    {
        let dir = ensure_unix_discovery_dir().ok()?;
        Some(unix_socket_path_in(&dir, hash))
    }
    #[cfg(windows)]
    {
        Some(PathBuf::from(format!(
            r"\\.\pipe\{}-{hash:016x}",
            windows_pipe_prefix()
        )))
    }
    #[cfg(not(any(unix, windows)))]
    {
        None
    }
}

fn devserver_socket_hash(library_id: &str, port: u16) -> u64 {
    crate::control_socket::fnv1a64(&format!("{library_id}\0{port}"))
}

#[cfg(unix)]
fn unix_socket_path_in(dir: &Path, hash: u64) -> PathBuf {
    dir.join(format!("{hash:016x}.sock"))
}

#[cfg(unix)]
fn current_uid() -> u32 {
    rustix::process::getuid().as_raw()
}

#[cfg(unix)]
fn effective_uid() -> u32 {
    rustix::process::geteuid().as_raw()
}

#[cfg(unix)]
fn unix_discovery_dir() -> PathBuf {
    std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .map(|dir| dir.join("chan-devserver"))
        .unwrap_or_else(|| std::env::temp_dir().join(format!("chan-devserver-{}", current_uid())))
}

#[cfg(unix)]
fn ensure_unix_discovery_dir() -> std::io::Result<PathBuf> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};

    let dir = unix_discovery_dir();
    match std::fs::symlink_metadata(&dir) {
        Ok(metadata) => {
            if !metadata.file_type().is_dir() || metadata.uid() != effective_uid() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    format!(
                        "devserver discovery directory {} is not an owner-controlled directory",
                        dir.display()
                    ),
                ));
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut builder = std::fs::DirBuilder::new();
            builder.mode(0o700);
            if let Err(create_err) = builder.create(&dir) {
                if create_err.kind() != std::io::ErrorKind::AlreadyExists {
                    return Err(create_err);
                }
            }
        }
        Err(e) => return Err(e),
    }

    let metadata = std::fs::symlink_metadata(&dir)?;
    if !metadata.file_type().is_dir() || metadata.uid() != effective_uid() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!(
                "devserver discovery directory {} is not an owner-controlled directory",
                dir.display()
            ),
        ));
    }
    if metadata.permissions().mode() & 0o777 != 0o700 {
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}

#[cfg(unix)]
fn existing_unix_discovery_dir() -> std::io::Result<PathBuf> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let dir = unix_discovery_dir();
    let metadata = std::fs::symlink_metadata(&dir)?;
    if !metadata.file_type().is_dir()
        || metadata.uid() != effective_uid()
        || metadata.permissions().mode() & 0o777 != 0o700
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!(
                "devserver discovery directory {} is not owner-controlled with mode 0700",
                dir.display()
            ),
        ));
    }
    Ok(dir)
}

#[cfg(windows)]
fn windows_pipe_prefix() -> String {
    let user: String = std::env::var("USERNAME")
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    format!(
        "chan-devserver-{}",
        if user.is_empty() { "default" } else { &user }
    )
}

/// Explicit opt-out for automation: `CHAN_NO_DEVSERVER_HANDOFF=1` forces
/// standalone even when a devserver is running. Any non-empty, non-"0"
/// value counts as set.
pub fn devserver_handoff_opt_out() -> bool {
    match std::env::var("CHAN_NO_DEVSERVER_HANDOFF") {
        Ok(v) => !v.is_empty() && v != "0",
        Err(_) => false,
    }
}

// ---------------------------------------------------------------------------
// Devserver side: listener on one stable per-instance endpoint.
// ---------------------------------------------------------------------------

/// Handle owning the registration listener. Drop aborts the accept loop and
/// unlinks only the socket this process locked and bound. A `kill -9` that
/// skips Drop leaves a stale file; the next owner reclaims it after taking the
/// stable lock.
#[cfg(any(unix, windows))]
pub struct ListenerHandle {
    socket_path: PathBuf,
    accept_loop: Option<tokio::task::JoinHandle<()>>,
    #[cfg(unix)]
    _stable_lock: std::fs::File,
}

#[cfg(not(any(unix, windows)))]
pub struct ListenerHandle {
    socket_path: PathBuf,
}

impl ListenerHandle {
    pub fn socket_path(&self) -> &std::path::Path {
        &self.socket_path
    }
}

#[cfg(any(unix, windows))]
impl ListenerHandle {
    /// Stop the listener: abort its accept loop and unlink the socket, as
    /// dropping the handle does.
    pub async fn shutdown(self) {}
}

#[cfg(any(unix, windows))]
impl Drop for ListenerHandle {
    fn drop(&mut self) {
        if let Some(h) = self.accept_loop.take() {
            h.abort();
        }
        // A Unix socket leaves a filesystem node to unlink; a Windows named
        // pipe vanishes when the owning process exits, so nothing to remove.
        #[cfg(unix)]
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

/// Bind a stable instance endpoint and spawn an accept loop. Each connection
/// carries one [`Request`]; the devserver's `handler` returns the
/// [`Response`] and the connection closes. The listener applies the
/// protocol-version gate before calling `handler`, so the handler only ever
/// sees protocol-valid requests; a skew becomes [`Response::VersionSkew`]
/// without invoking it.
///
/// The socket is chmod 0600 immediately after bind so only the owning user
/// can connect (defense in depth on top of the per-user directory). Must be
/// called from within a tokio runtime.
#[cfg(unix)]
pub fn start_listener<F, Fut>(socket_path: PathBuf, handler: F) -> std::io::Result<ListenerHandle>
where
    F: Fn(Request) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Response> + Send + 'static,
{
    start_listener_with_peer_uid(socket_path, handler, |stream| Ok(stream.peer_cred()?.uid()))
}

#[cfg(unix)]
fn start_listener_with_peer_uid<F, Fut, U>(
    socket_path: PathBuf,
    handler: F,
    peer_uid: U,
) -> std::io::Result<ListenerHandle>
where
    F: Fn(Request) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Response> + Send + 'static,
    U: Fn(&tokio::net::UnixStream) -> std::io::Result<u32> + Send + Sync + 'static,
{
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixListener;

    // The lock makes stale-node reclamation safe: only its owner may unlink,
    // bind, or later remove this stable path.
    let stable_lock = crate::control_socket::take_stable_lock(&socket_path)?;
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path)?;
    // Lock the socket to the owning user. Best-effort: a chmod failure does
    // not abort the listener; the per-user directory is the primary boundary.
    let _ = std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600));

    let handler = std::sync::Arc::new(handler);
    let peer_uid = std::sync::Arc::new(peer_uid);
    let owner_uid = effective_uid();
    let accept_loop = tokio::spawn(async move {
        loop {
            let (stream, _) = match listener.accept().await {
                Ok(pair) => pair,
                Err(e) => {
                    tracing::warn!("devserver registration accept: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };
            match peer_uid(&stream) {
                Ok(uid) if uid == owner_uid => {}
                Ok(uid) => {
                    tracing::warn!(
                        peer_uid = uid,
                        owner_uid,
                        "devserver registration refused a different-user peer"
                    );
                    continue;
                }
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        "devserver registration refused a peer without credentials"
                    );
                    continue;
                }
            }
            let handler = handler.clone();
            tokio::spawn(async move {
                let (read, write) = stream.into_split();
                serve_connection(read, write, handler.as_ref()).await;
            });
        }
    });

    Ok(ListenerHandle {
        socket_path,
        accept_loop: Some(accept_loop),
        _stable_lock: stable_lock,
    })
}

/// Windows: bind a stable per-instance named pipe and serve registration requests,
/// mirroring [`crate::handoff::start_listener`]'s Windows arm. The first
/// instance owns the name (`first_pipe_instance(true)`); each accept re-arms a
/// fresh instance BEFORE serving so a client arriving during the swap still
/// finds a live server. Same one-line-JSON framing + `dispatch` version gate as
/// the unix arm.
#[cfg(windows)]
pub fn start_listener<F, Fut>(socket_path: PathBuf, handler: F) -> std::io::Result<ListenerHandle>
where
    F: Fn(Request) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Response> + Send + 'static,
{
    use tokio::net::windows::named_pipe::ServerOptions;

    let pipe_name = socket_path.as_os_str().to_owned();
    let mut next = ServerOptions::new()
        .first_pipe_instance(true)
        .create(&pipe_name)?;

    let handler = std::sync::Arc::new(handler);
    let accept_loop = tokio::spawn(async move {
        loop {
            if let Err(e) = next.connect().await {
                tracing::warn!("devserver registration accept: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
            // Re-arm BEFORE serving so the next client doesn't race to NotFound.
            let fresh = match ServerOptions::new().create(&pipe_name) {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!("devserver registration re-arm: {e}");
                    break;
                }
            };
            let connected = std::mem::replace(&mut next, fresh);
            let handler = handler.clone();
            tokio::spawn(async move {
                let (read, write) = tokio::io::split(connected);
                serve_connection(read, write, handler.as_ref()).await;
            });
        }
    });

    Ok(ListenerHandle {
        socket_path,
        accept_loop: Some(accept_loop),
    })
}

#[cfg(not(any(unix, windows)))]
pub fn start_listener<F, Fut>(_socket_path: PathBuf, _handler: F) -> std::io::Result<ListenerHandle>
where
    F: Fn(Request) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Response> + Send + 'static,
{
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "devserver registration listener requires unix-domain sockets or windows named pipes",
    ))
}

// Bound the root path and client-version metadata on the request line.
#[cfg(any(unix, windows))]
const MAX_REGISTRATION_REQUEST_BYTES: u64 = 1024 * 1024;

#[cfg(any(unix, windows))]
async fn serve_connection<R, W, F, Fut>(read: R, mut write: W, handler: &F)
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
    F: Fn(Request) -> Fut + Send + Sync,
    Fut: std::future::Future<Output = Response> + Send,
{
    use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};

    let mut reader = BufReader::new(read.take(MAX_REGISTRATION_REQUEST_BYTES));
    let mut line = String::new();
    let Some(read_result) = crate::control_socket::read_request_line(&mut reader, &mut line).await
    else {
        return;
    };
    let response = match read_result {
        Ok(0) => Response::Error {
            message: "empty registration request".into(),
        },
        Ok(_) if !line.ends_with('\n') => Response::Error {
            message: "invalid registration request: line is not newline-terminated".into(),
        },
        Ok(_) => match serde_json::from_str::<Request>(&line) {
            Ok(req) => dispatch(req, handler).await,
            Err(e) => Response::Error {
                message: format!("invalid registration request: {e}"),
            },
        },
        Err(e) => Response::Error {
            message: format!("read registration request: {e}"),
        },
    };
    if let Ok(mut out) = serde_json::to_vec(&response) {
        out.push(b'\n');
        let _ = write.write_all(&out).await;
    }
}

/// Apply the protocol-version gate, then call the devserver's async
/// `handler`. A skew short-circuits to [`Response::VersionSkew`] and the
/// handler never runs, so the devserver never acts on a request it cannot
/// fully understand.
#[cfg(any(unix, windows))]
async fn dispatch<F, Fut>(req: Request, handler: &F) -> Response
where
    F: Fn(Request) -> Fut,
    Fut: std::future::Future<Output = Response>,
{
    if req.protocol() != PROTOCOL_VERSION {
        tracing::info!(
            cli_version = %req.cli_version(),
            cli_protocol = req.protocol(),
            "devserver registration refused: protocol skew",
        );
        return Response::VersionSkew {
            devserver_version: CHAN_VERSION.into(),
            devserver_protocol: PROTOCOL_VERSION,
        };
    }
    handler(req).await
}

// ---------------------------------------------------------------------------
// CLI side: discover + request registration.
// ---------------------------------------------------------------------------

/// Enumerate and identify every responsive same-user local devserver.
///
/// Candidate names are sorted before probing. Probes run concurrently, and
/// each complete round-trip has a fixed deadline, so one wedged endpoint does
/// not delay healthy siblings or hang `chan serve`.
#[cfg(any(unix, windows))]
pub async fn discover_devservers() -> Vec<Instance> {
    let probes = devserver_candidates()
        .into_iter()
        .map(|endpoint| probe_instance(endpoint, PROBE_TIMEOUT));
    futures::future::join_all(probes)
        .await
        .into_iter()
        .flatten()
        .collect()
}

#[cfg(not(any(unix, windows)))]
pub async fn discover_devservers() -> Vec<Instance> {
    Vec::new()
}

#[cfg(unix)]
fn devserver_candidates() -> Vec<PathBuf> {
    // A client probe is read-only: only a devserver creates or repairs the
    // namespace when publishing its endpoint.
    let Ok(dir) = existing_unix_discovery_dir() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut candidates: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| unix_candidate_name(&entry.file_name().to_string_lossy()))
        .map(|entry| entry.path())
        .collect();
    candidates.sort();
    candidates
}

#[cfg(unix)]
fn unix_candidate_name(name: &str) -> bool {
    name.strip_suffix(".sock").is_some_and(lower_hex_16)
}

#[cfg(windows)]
fn devserver_candidates() -> Vec<PathBuf> {
    let prefix = format!("{}-", windows_pipe_prefix());
    let Ok(entries) = std::fs::read_dir(r"\\.\pipe\") else {
        return Vec::new();
    };
    let mut candidates: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .and_then(|name| name.strip_prefix(&prefix))
                .is_some_and(lower_hex_16)
        })
        .map(|entry| entry.path())
        .collect();
    candidates.sort();
    candidates
}

#[cfg(any(unix, windows))]
fn lower_hex_16(value: &str) -> bool {
    value.len() == 16
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

#[cfg(any(unix, windows))]
async fn probe_instance(endpoint: PathBuf, timeout: Duration) -> Option<Instance> {
    let request = Request::Identify {
        protocol: PROTOCOL_VERSION,
        cli_version: CHAN_VERSION.into(),
    };
    let EndpointReply::Response(response) =
        tokio::time::timeout(timeout, request_endpoint(&endpoint, &request))
            .await
            .ok()?
    else {
        return None;
    };
    match response {
        Response::Identified {
            pid,
            library_root,
            port,
            version,
        } => Some(Instance {
            endpoint,
            pid,
            library_root,
            port,
            version,
        }),
        Response::Registered { .. } | Response::VersionSkew { .. } | Response::Error { .. } => None,
    }
}

/// Register `workspace_path` with the selected local devserver instance and ask
/// it to mint one workspace window record.
///
/// A sent request that exhausts its reply budget returns
/// [`Outcome::ReplyTimedOut`]. One whose connection then closes or fails, or
/// whose reply is malformed or answers another verb, returns
/// [`Outcome::ReplyLost`]. After either, the caller must not open the workspace
/// itself. A dead endpoint or a failure before the request is sent maps to
/// [`Outcome::NoDevserver`]. Protocol skew and application-level mount failures
/// retain their distinct outcomes for the CLI's diagnostics.
#[cfg(any(unix, windows))]
pub async fn try_register_devserver(instance: &Instance, workspace_path: &Path) -> Outcome {
    let request = Request::RegisterWorkspace {
        protocol: PROTOCOL_VERSION,
        cli_version: CHAN_VERSION.into(),
        workspace_path: workspace_path.display().to_string(),
    };
    registration_outcome(request_endpoint(&instance.endpoint, &request).await)
}

#[cfg(any(unix, windows))]
fn registration_outcome(reply: EndpointReply) -> Outcome {
    match reply {
        EndpointReply::Response(Response::Registered { prefix, .. }) => {
            Outcome::Registered { prefix }
        }
        EndpointReply::Response(Response::VersionSkew { .. }) => Outcome::VersionSkew,
        EndpointReply::Response(Response::Error { message }) => Outcome::Error(message),
        EndpointReply::Response(Response::Identified { .. }) | EndpointReply::Lost => {
            Outcome::ReplyLost
        }
        EndpointReply::Unavailable => Outcome::NoDevserver,
        EndpointReply::TimedOut => Outcome::ReplyTimedOut,
    }
}

#[cfg(not(any(unix, windows)))]
pub async fn try_register_devserver(
    _instance: &Instance,
    _workspace_path: &std::path::Path,
) -> Outcome {
    Outcome::NoDevserver
}

#[cfg(any(unix, windows))]
#[derive(Debug)]
enum EndpointReply {
    Response(Response),
    Unavailable,
    TimedOut,
    Lost,
}

#[cfg(any(unix, windows))]
async fn request_endpoint(endpoint: &Path, request: &Request) -> EndpointReply {
    request_endpoint_with_budget(endpoint, request, request.reply_budget()).await
}

#[cfg(unix)]
async fn request_endpoint_with_budget(
    endpoint: &Path,
    request: &Request,
    reply_budget: Duration,
) -> EndpointReply {
    use tokio::net::UnixStream;

    let Ok(Ok(stream)) = tokio::time::timeout(CONNECT_TIMEOUT, UnixStream::connect(endpoint)).await
    else {
        return EndpointReply::Unavailable;
    };
    exchange_request(stream, request, reply_budget).await
}

#[cfg(windows)]
async fn request_endpoint_with_budget(
    endpoint: &Path,
    request: &Request,
    reply_budget: Duration,
) -> EndpointReply {
    use tokio::net::windows::named_pipe::ClientOptions;

    const ERROR_PIPE_BUSY: i32 = 231;

    let deadline = std::time::Instant::now() + CONNECT_TIMEOUT;
    let client = loop {
        match ClientOptions::new().open(endpoint) {
            Ok(client) => break client,
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                if std::time::Instant::now() >= deadline {
                    return EndpointReply::Unavailable;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(_) => return EndpointReply::Unavailable,
        }
    };
    exchange_request(client, request, reply_budget).await
}

#[cfg(any(unix, windows))]
async fn exchange_request<S>(
    mut stream: S,
    request: &Request,
    reply_budget: Duration,
) -> EndpointReply
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let Ok(mut payload) = serde_json::to_vec(request) else {
        return EndpointReply::Unavailable;
    };
    payload.push(b'\n');
    let mut sent = false;
    let io = async {
        stream.write_all(&payload).await?;
        stream.flush().await?;
        sent = true;
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).await?;
        Ok::<String, std::io::Error>(line)
    };
    match tokio::time::timeout(reply_budget, io).await {
        // A line is only read after the request was sent, so an empty or
        // unparseable one is a lost reply.
        Ok(Ok(line)) => serde_json::from_str(&line)
            .map(EndpointReply::Response)
            .unwrap_or(EndpointReply::Lost),
        Ok(Err(_)) if sent => EndpointReply::Lost,
        Err(_) if sent => EndpointReply::TimedOut,
        Ok(Err(_)) | Err(_) => EndpointReply::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    async fn request_deadline_case(drip: bool) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        tokio::time::timeout(Duration::from_secs(15), async {
            let (mut client, peer) = tokio::io::duplex(1024);
            let (read, write) = tokio::io::split(peer);
            let calls = std::sync::atomic::AtomicUsize::new(0);
            let handler = |_| {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                async {
                    Response::Registered {
                        devserver_version: CHAN_VERSION.into(),
                        prefix: "/workspace".into(),
                    }
                }
            };
            let mut serving = Box::pin(serve_connection(read, write, &handler));
            assert!(futures::poll!(serving.as_mut()).is_pending());
            tokio::time::advance(Duration::from_secs(5)).await;
            if drip {
                client.write_all(b"{\"type\":").await.unwrap();
            }
            assert!(futures::poll!(serving.as_mut()).is_pending());
            tokio::time::advance(Duration::from_secs(4)).await;
            if drip {
                client.write_all(b"\"unfinished").await.unwrap();
            }
            assert!(
                futures::poll!(serving.as_mut()).is_pending(),
                "deadline fired early"
            );
            tokio::time::advance(Duration::from_secs(1)).await;
            tokio::time::timeout(Duration::from_millis(10), serving.as_mut())
                .await
                .expect("request read survived the ten-second total deadline");
            drop(serving);
            let mut reply = Vec::new();
            client.read_to_end(&mut reply).await.unwrap();
            assert!(reply.is_empty(), "expiry must close without a reply");
            assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        })
        .await
        .unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn registration_request_deadline_closes_a_silent_client() {
        request_deadline_case(false).await;
    }

    #[tokio::test(start_paused = true)]
    async fn registration_request_deadline_is_not_reset_by_partial_input() {
        request_deadline_case(true).await;
    }

    async fn request_handler_case(slow: bool) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        tokio::time::timeout(Duration::from_secs(15), async {
            let (mut client, peer) = tokio::io::duplex(1024);
            let (read, write) = tokio::io::split(peer);
            let request = Request::RegisterWorkspace {
                protocol: PROTOCOL_VERSION,
                cli_version: CHAN_VERSION.into(),
                workspace_path: "notes".into(),
            };
            let calls = std::sync::atomic::AtomicUsize::new(0);
            let release = tokio::sync::Semaphore::new(0);
            let handler = |received| {
                assert_eq!(received, request);
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let release = &release;
                async move {
                    if slow {
                        release.acquire().await.unwrap().forget();
                    }
                    Response::Registered {
                        devserver_version: CHAN_VERSION.into(),
                        prefix: "/workspace".into(),
                    }
                }
            };
            client
                .write_all(format!("{}\n", serde_json::to_string(&request).unwrap()).as_bytes())
                .await
                .unwrap();
            let mut serving = Box::pin(serve_connection(read, write, &handler));
            if slow {
                assert!(futures::poll!(serving.as_mut()).is_pending());
                assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
                tokio::time::advance(Duration::from_secs(11)).await;
                assert!(
                    futures::poll!(serving.as_mut()).is_pending(),
                    "request deadline ended the handler"
                );
                release.add_permits(1);
            }
            serving.as_mut().await;
            drop(serving);
            let mut reply = Vec::new();
            client.read_to_end(&mut reply).await.unwrap();
            assert_eq!(
                serde_json::from_slice::<Response>(&reply).unwrap(),
                Response::Registered {
                    devserver_version: CHAN_VERSION.into(),
                    prefix: "/workspace".into()
                }
            );
            assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        })
        .await
        .unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn registration_request_deadline_serves_an_immediate_request() {
        request_handler_case(false).await;
    }

    #[tokio::test(start_paused = true)]
    async fn registration_request_deadline_does_not_limit_a_slow_handler() {
        request_handler_case(true).await;
    }

    #[tokio::test(start_paused = true)]
    async fn registration_request_without_a_trailing_newline_is_refused() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        tokio::time::timeout(Duration::from_secs(15), async {
            for over_cap in [false, true] {
                let request = Request::RegisterWorkspace {
                    protocol: PROTOCOL_VERSION,
                    cli_version: CHAN_VERSION.into(),
                    workspace_path: if over_cap {
                        "x".repeat(MAX_REGISTRATION_REQUEST_BYTES as usize)
                    } else {
                        "notes".into()
                    },
                };
                let request = serde_json::to_vec(&request).unwrap();
                let (mut client, peer) = tokio::io::duplex(request.len().max(1024));
                let (read, write) = tokio::io::split(peer);
                client.write_all(&request).await.unwrap();
                client.shutdown().await.unwrap();
                let calls = std::sync::atomic::AtomicUsize::new(0);
                serve_connection(read, write, &|_| {
                    calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    async {
                        Response::Registered {
                            devserver_version: CHAN_VERSION.into(),
                            prefix: "/workspace".into(),
                        }
                    }
                })
                .await;
                let mut reply = Vec::new();
                client.read_to_end(&mut reply).await.unwrap();
                let calls = calls.load(std::sync::atomic::Ordering::SeqCst);
                assert_eq!(
                    serde_json::from_slice::<Response>(&reply).unwrap(),
                    Response::Error {
                        message: "invalid registration request: line is not newline-terminated"
                            .into(),
                    },
                    "over_cap={over_cap}, handler calls={calls}"
                );
                assert_eq!(calls, 0, "an incomplete request must not reach the handler");
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn registration_request_over_the_byte_cap_is_refused() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        tokio::time::timeout(Duration::from_secs(15), async {
            let request = Request::RegisterWorkspace {
                protocol: PROTOCOL_VERSION,
                cli_version: CHAN_VERSION.into(),
                workspace_path: "x".repeat(MAX_REGISTRATION_REQUEST_BYTES as usize),
            };
            let request = format!("{}\n", serde_json::to_string(&request).unwrap());
            let (mut client, peer) = tokio::io::duplex(request.len());
            let (read, write) = tokio::io::split(peer);
            client.write_all(request.as_bytes()).await.unwrap();
            let calls = std::sync::atomic::AtomicUsize::new(0);
            serve_connection(read, write, &|_| {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                async {
                    Response::Registered {
                        devserver_version: CHAN_VERSION.into(),
                        prefix: "/workspace".into(),
                    }
                }
            })
            .await;
            let mut reply = Vec::new();
            client.read_to_end(&mut reply).await.unwrap();
            assert!(matches!(
                serde_json::from_slice::<Response>(&reply).unwrap(),
                Response::Error { message } if message.starts_with("invalid registration request:")
            ));
            assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        })
        .await
        .unwrap();
    }

    use super::*;

    #[cfg(any(unix, windows))]
    #[test]
    fn registration_reply_budget_covers_the_workspace_mount() {
        let register = Request::RegisterWorkspace {
            protocol: PROTOCOL_VERSION,
            cli_version: CHAN_VERSION.into(),
            workspace_path: "notes".into(),
        };
        let identify = Request::Identify {
            protocol: PROTOCOL_VERSION,
            cli_version: CHAN_VERSION.into(),
        };
        assert_eq!(identify.reply_budget(), Duration::from_secs(3));
        assert!(register.reply_budget() > Duration::from_secs(60));
        assert_eq!(register.reply_budget(), Duration::from_secs(75));
    }

    #[cfg(unix)]
    async fn registration_with_delayed_reply(delay: Option<Duration>, budget: Duration) -> Outcome {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let dir = tempfile::Builder::new()
            .prefix("chan-reg-")
            .tempdir_in("/tmp")
            .unwrap();
        let socket = dir.path().join("register.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let handler = tokio::spawn(async move {
            tokio::time::timeout(Duration::from_secs(5), async {
                let (stream, _) = listener.accept().await.unwrap();
                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                reader.read_line(&mut line).await.unwrap();
                assert!(matches!(
                    serde_json::from_str::<Request>(&line).unwrap(),
                    Request::RegisterWorkspace { .. }
                ));
                match delay {
                    Some(delay) => tokio::time::sleep(delay).await,
                    None => std::future::pending::<()>().await,
                }
                let response = Response::Registered {
                    devserver_version: CHAN_VERSION.into(),
                    prefix: "/notes".into(),
                };
                let mut payload = serde_json::to_vec(&response).unwrap();
                payload.push(b'\n');
                reader.get_mut().write_all(&payload).await.unwrap();
            })
            .await
            .expect("registration stub is bounded");
        });
        let request = Request::RegisterWorkspace {
            protocol: PROTOCOL_VERSION,
            cli_version: CHAN_VERSION.into(),
            workspace_path: "notes".into(),
        };
        let reply = tokio::time::timeout(
            Duration::from_secs(3),
            request_endpoint_with_budget(&socket, &request, budget),
        )
        .await;
        handler.abort();
        if let Err(error) = tokio::time::timeout(Duration::from_secs(1), handler)
            .await
            .expect("registration handler stops")
        {
            assert!(error.is_cancelled(), "registration handler failed: {error}");
        }
        registration_outcome(reply.expect("registration client is bounded"))
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn registration_waits_for_a_delayed_mount_reply() {
        let outcome = registration_with_delayed_reply(
            Some(Duration::from_millis(300)),
            Duration::from_secs(2),
        )
        .await;
        assert!(matches!(outcome, Outcome::Registered { prefix } if prefix == "/notes"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn registration_reply_timeout_is_not_no_devserver() {
        let outcome = registration_with_delayed_reply(None, Duration::from_millis(100)).await;
        assert!(matches!(outcome, Outcome::ReplyTimedOut), "{outcome:?}");
    }

    #[cfg(any(unix, windows))]
    fn registration_request() -> Request {
        Request::RegisterWorkspace {
            protocol: PROTOCOL_VERSION,
            cli_version: CHAN_VERSION.into(),
            workspace_path: "notes".into(),
        }
    }

    /// Register over an in-memory stub that reads the whole request line, then
    /// writes `reply` if one is given and closes.
    #[cfg(any(unix, windows))]
    async fn registration_after_request(reply: Option<&str>) -> Outcome {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        tokio::time::timeout(Duration::from_secs(5), async {
            let (client, peer) = tokio::io::duplex(1024);
            let stub = async move {
                let mut reader = BufReader::new(peer);
                let mut line = String::new();
                reader.read_line(&mut line).await.unwrap();
                assert_eq!(
                    serde_json::from_str::<Request>(&line).unwrap(),
                    registration_request()
                );
                if let Some(reply) = reply {
                    reader.get_mut().write_all(reply.as_bytes()).await.unwrap();
                }
            };
            let request = registration_request();
            let (reply, ()) = tokio::join!(
                exchange_request(client, &request, Duration::from_secs(5)),
                stub
            );
            registration_outcome(reply)
        })
        .await
        .expect("registration exchange is bounded")
    }

    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn registration_eof_after_request_is_not_no_devserver() {
        let outcome = registration_after_request(None).await;
        assert!(matches!(outcome, Outcome::ReplyLost), "{outcome:?}");
    }

    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn registration_garbage_reply_after_request_is_not_no_devserver() {
        let outcome = registration_after_request(Some("not a registration reply\n")).await;
        assert!(matches!(outcome, Outcome::ReplyLost), "{outcome:?}");
    }

    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn registration_identity_reply_after_request_is_not_no_devserver() {
        let reply = serde_json::to_string(&Response::Identified {
            pid: 1,
            library_root: PathBuf::from("/tmp/chan"),
            port: 8787,
            version: CHAN_VERSION.into(),
        })
        .unwrap();
        let outcome = registration_after_request(Some(&format!("{reply}\n"))).await;
        assert!(matches!(outcome, Outcome::ReplyLost), "{outcome:?}");
    }

    /// A read half that fails every read with a connection reset.
    #[cfg(any(unix, windows))]
    struct ResetReader;

    #[cfg(any(unix, windows))]
    impl tokio::io::AsyncRead for ResetReader {
        fn poll_read(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
            _: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Ready(Err(std::io::ErrorKind::ConnectionReset.into()))
        }
    }

    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn registration_read_error_after_request_is_not_no_devserver() {
        let stream = tokio::io::join(ResetReader, tokio::io::sink());
        let reply = tokio::time::timeout(
            Duration::from_secs(5),
            exchange_request(stream, &registration_request(), Duration::from_secs(5)),
        )
        .await
        .expect("registration exchange is bounded");
        let outcome = registration_outcome(reply);
        assert!(matches!(outcome, Outcome::ReplyLost), "{outcome:?}");
    }

    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn registration_drop_before_request_is_no_devserver() {
        let (client, peer) = tokio::io::duplex(1024);
        drop(peer);
        let reply = tokio::time::timeout(
            Duration::from_secs(5),
            exchange_request(client, &registration_request(), Duration::from_secs(5)),
        )
        .await
        .expect("registration exchange is bounded");
        let outcome = registration_outcome(reply);
        assert!(matches!(outcome, Outcome::NoDevserver), "{outcome:?}");
    }

    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn registration_error_reply_after_request_is_a_mount_error() {
        let reply = serde_json::to_string(&Response::Error {
            message: "mount failed".into(),
        })
        .unwrap();
        let outcome = registration_after_request(Some(&format!("{reply}\n"))).await;
        assert!(
            matches!(&outcome, Outcome::Error(message) if message == "mount failed"),
            "{outcome:?}"
        );
    }

    #[test]
    fn request_round_trips() {
        let register = Request::RegisterWorkspace {
            protocol: PROTOCOL_VERSION,
            cli_version: "9.9.9".into(),
            workspace_path: "/tmp/notes".into(),
        };
        let json = serde_json::to_string(&register).unwrap();
        assert!(json.contains("\"type\":\"register_workspace\""));
        let back: Request = serde_json::from_str(&json).unwrap();
        assert_eq!(register, back);
        assert_eq!(register.protocol(), PROTOCOL_VERSION);
        assert_eq!(register.cli_version(), "9.9.9");

        let identify = Request::Identify {
            protocol: PROTOCOL_VERSION,
            cli_version: "9.9.9".into(),
        };
        let json = serde_json::to_string(&identify).unwrap();
        assert!(json.contains("\"type\":\"identify\""));
        assert_eq!(identify, serde_json::from_str::<Request>(&json).unwrap());
    }

    #[test]
    fn response_round_trips() {
        let identified = Response::Identified {
            pid: 123,
            library_root: PathBuf::from("/tmp/library"),
            port: 8787,
            version: "9.9.9".into(),
        };
        let json = serde_json::to_string(&identified).unwrap();
        assert!(json.contains("\"type\":\"identified\""));
        assert_eq!(identified, serde_json::from_str::<Response>(&json).unwrap());

        let registered = Response::Registered {
            devserver_version: CHAN_VERSION.into(),
            prefix: "/api/notes-1a2b3c".into(),
        };
        let json = serde_json::to_string(&registered).unwrap();
        assert!(json.contains("\"type\":\"registered\""));
        assert_eq!(registered, serde_json::from_str::<Response>(&json).unwrap());

        let skew = Response::VersionSkew {
            devserver_version: "0.1.0".into(),
            devserver_protocol: 99,
        };
        let json = serde_json::to_string(&skew).unwrap();
        assert!(json.contains("\"type\":\"version_skew\""));
        assert_eq!(skew, serde_json::from_str::<Response>(&json).unwrap());
    }

    #[test]
    fn opt_out_parsing() {
        let prev = std::env::var_os("CHAN_NO_DEVSERVER_HANDOFF");
        std::env::remove_var("CHAN_NO_DEVSERVER_HANDOFF");
        assert!(!devserver_handoff_opt_out());
        std::env::set_var("CHAN_NO_DEVSERVER_HANDOFF", "1");
        assert!(devserver_handoff_opt_out());
        std::env::set_var("CHAN_NO_DEVSERVER_HANDOFF", "0");
        assert!(!devserver_handoff_opt_out());
        std::env::set_var("CHAN_NO_DEVSERVER_HANDOFF", "");
        assert!(!devserver_handoff_opt_out());
        match prev {
            Some(v) => std::env::set_var("CHAN_NO_DEVSERVER_HANDOFF", v),
            None => std::env::remove_var("CHAN_NO_DEVSERVER_HANDOFF"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn instance_socket_names_are_stable_short_and_scoped() {
        let hash = devserver_socket_hash("lib-0011223344556677", 8787);
        let path = unix_socket_path_in(Path::new("/runtime/chan-devserver"), hash);
        let name = path.file_name().unwrap().to_string_lossy();
        assert_eq!(name.len(), 21);
        assert!(unix_candidate_name(&name));
        assert_eq!(hash, devserver_socket_hash("lib-0011223344556677", 8787));
        assert_ne!(hash, devserver_socket_hash("lib-0011223344556677", 9999));
        assert_ne!(hash, devserver_socket_hash("lib-other", 8787));
        assert!(!name.contains("lib-"));
        assert!(!unix_candidate_name(&format!("{name}.lock")));
        assert!(!unix_candidate_name("ABCDEF0123456789.sock"));
        assert!(!unix_candidate_name("0123456789abcde.sock"));
    }

    #[cfg(windows)]
    #[test]
    fn instance_socket_names_are_stable_short_and_scoped() {
        let path =
            devserver_socket_path("lib-0011223344556677", 8787).expect("Windows devserver path");
        let name = path.to_string_lossy();
        let prefix = format!(r"\\.\pipe\{}-", windows_pipe_prefix());
        assert!(name.starts_with(&prefix), "unexpected path: {name}");
        let hash = &name[prefix.len()..];
        assert!(lower_hex_16(hash));
        assert_eq!(
            path,
            devserver_socket_path("lib-0011223344556677", 8787).unwrap()
        );
        assert_ne!(
            devserver_socket_path("lib-0011223344556677", 8787),
            devserver_socket_path("lib-0011223344556677", 9999)
        );
        assert_ne!(
            devserver_socket_path("lib-0011223344556677", 8787),
            devserver_socket_path("lib-other", 8787)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn old_client_gets_clean_version_skew_from_new_server() {
        let req = Request::RegisterWorkspace {
            protocol: 1,
            cli_version: "0.73.0".into(),
            workspace_path: "/tmp/notes".into(),
        };
        // The handler returns a distinctive Registered; getting VersionSkew
        // back proves dispatch short-circuited and never ran the handler.
        let handler = |_r: Request| async {
            Response::Registered {
                devserver_version: CHAN_VERSION.into(),
                prefix: "/api/should-not-happen".into(),
            }
        };
        match dispatch(req, &handler).await {
            Response::VersionSkew {
                devserver_protocol, ..
            } => assert_eq!(devserver_protocol, PROTOCOL_VERSION),
            other => panic!("expected VersionSkew, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn new_client_treats_an_old_servers_unknown_verb_error_as_absent() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        #[allow(dead_code)]
        #[derive(Deserialize)]
        #[serde(tag = "type", rename_all = "snake_case")]
        enum OldRequest {
            RegisterWorkspace {
                protocol: u32,
                cli_version: String,
                workspace_path: String,
            },
        }

        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("old.sock");
        let listener = tokio::net::UnixListener::bind(&sock).unwrap();
        let old_server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut line = String::new();
            BufReader::new(read).read_line(&mut line).await.unwrap();
            assert!(serde_json::from_str::<OldRequest>(&line).is_err());
            let mut reply = serde_json::to_vec(&Response::Error {
                message: "invalid registration request: unknown variant identify".into(),
            })
            .unwrap();
            reply.push(b'\n');
            write.write_all(&reply).await.unwrap();
        });

        assert!(probe_instance(sock, Duration::from_secs(1)).await.is_none());
        old_server.await.unwrap();
    }

    /// A listener stop owes an accepted connection its reply: it may not
    /// return while the handler is still answering, and the client still
    /// reads the reply afterwards.
    #[cfg(unix)]
    #[tokio::test]
    async fn listener_stop_waits_for_an_in_flight_reply() {
        use std::sync::Arc;

        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("stop.sock");
        let (entered_tx, entered) = tokio::sync::oneshot::channel();
        let entered_tx = std::sync::Mutex::new(Some(entered_tx));
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let answering = Arc::clone(&release);
        let handle = start_listener(sock.clone(), move |_req| {
            let entered = entered_tx.lock().unwrap().take();
            let release = Arc::clone(&answering);
            async move {
                if let Some(entered) = entered {
                    let _ = entered.send(());
                }
                let _permit = release.acquire().await.unwrap();
                Response::Registered {
                    devserver_version: CHAN_VERSION.into(),
                    prefix: "/workspace".into(),
                }
            }
        })
        .unwrap();
        let client_sock = sock.clone();
        let client = tokio::spawn(async move { request_over(&client_sock, "/tmp/notes").await });
        tokio::time::timeout(Duration::from_secs(10), entered)
            .await
            .expect("the request never reached the handler")
            .unwrap();

        let stop = tokio::spawn(handle.shutdown());
        // The listener has taken the stop once it refuses a new peer.
        while tokio::net::UnixStream::connect(&sock).await.is_ok() {
            tokio::task::yield_now().await;
        }
        assert!(
            !stop.is_finished(),
            "the listener stop returned while an accepted connection still owed its reply"
        );

        release.add_permits(1);
        assert!(matches!(client.await.unwrap(), Response::Registered { .. }));
        tokio::time::timeout(Duration::from_secs(10), stop)
            .await
            .expect("the stop outlived its last connection")
            .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn listener_round_trip_registered() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("reg.sock");
        let _handle = start_listener(sock.clone(), test_handler).unwrap();

        // The socket should be 0600.
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&sock).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "socket perms should be 0600");

        let resp = request_over(&sock, "/tmp/notes").await;
        match resp {
            Response::Registered { prefix, .. } => assert_eq!(prefix, "/api/notes-1a2b3c"),
            other => panic!("expected Registered, got {other:?}"),
        }

        match identify_over(&sock).await {
            Response::Identified {
                pid,
                library_root,
                port,
                version,
            } => {
                assert_eq!(pid, 123);
                assert_eq!(library_root, PathBuf::from("/tmp/library"));
                assert_eq!(port, 8787);
                assert_eq!(version, CHAN_VERSION);
            }
            other => panic!("expected Identified, got {other:?}"),
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn listener_round_trip_registered_pipe() {
        let pipe = PathBuf::from(format!(
            r"\\.\pipe\chan-test-devserver-{}",
            std::process::id()
        ));
        let (handled_tx, mut handled_rx) = tokio::sync::mpsc::unbounded_channel();
        let _handle = start_listener(pipe.clone(), move |request| {
            let handled_tx = handled_tx.clone();
            async move {
                let response = match &request {
                    Request::RegisterWorkspace { .. } => Response::Registered {
                        devserver_version: CHAN_VERSION.into(),
                        prefix: "/api/notes-1a2b3c".into(),
                    },
                    Request::Identify { .. } => Response::Identified {
                        pid: 123,
                        library_root: PathBuf::from(r"C:\chan-library"),
                        port: 8787,
                        version: CHAN_VERSION.into(),
                    },
                };
                let _ = handled_tx.send(request);
                response
            }
        })
        .expect("bind named-pipe listener");

        let registration = registration_request();
        let reply = tokio::time::timeout(
            Duration::from_secs(5),
            request_endpoint(&pipe, &registration),
        )
        .await
        .expect("registration round trip is bounded");
        match reply {
            EndpointReply::Response(Response::Registered { prefix, .. }) => {
                assert_eq!(prefix, "/api/notes-1a2b3c")
            }
            other => panic!("expected Registered, got {other:?}"),
        }
        let handled = tokio::time::timeout(Duration::from_secs(1), handled_rx.recv())
            .await
            .expect("registration handler reports its request")
            .expect("registration listener keeps its request channel open");
        assert_eq!(handled, registration);

        let identify = Request::Identify {
            protocol: PROTOCOL_VERSION,
            cli_version: CHAN_VERSION.into(),
        };
        let reply =
            tokio::time::timeout(Duration::from_secs(5), request_endpoint(&pipe, &identify))
                .await
                .expect("identity round trip is bounded");
        match reply {
            EndpointReply::Response(Response::Identified {
                pid,
                library_root,
                port,
                version,
            }) => {
                assert_eq!(pid, 123);
                assert_eq!(library_root, PathBuf::from(r"C:\chan-library"));
                assert_eq!(port, 8787);
                assert_eq!(version, CHAN_VERSION);
            }
            other => panic!("expected Identified, got {other:?}"),
        }
        let handled = tokio::time::timeout(Duration::from_secs(1), handled_rx.recv())
            .await
            .expect("identity handler reports its request")
            .expect("registration listener keeps its request channel open");
        assert_eq!(handled, identify);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stable_listener_refuses_a_live_owner_and_keeps_it_reachable() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("reg.sock");
        let live = start_listener(sock.clone(), test_handler).unwrap();

        let err = start_listener(sock.clone(), test_handler)
            .err()
            .expect("a second listener must not clobber a live owner");
        assert_eq!(err.kind(), std::io::ErrorKind::AddrInUse);
        assert!(matches!(
            identify_over(&sock).await,
            Response::Identified { .. }
        ));

        drop(live);
        let _replacement = start_listener(sock.clone(), test_handler)
            .expect("the path is reusable after its owner drops");
        assert!(matches!(
            identify_over(&sock).await,
            Response::Identified { .. }
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stable_listener_reclaims_a_dead_owners_node() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("reg.sock");
        drop(std::os::unix::net::UnixListener::bind(&sock).unwrap());
        assert!(sock.exists());

        let _handle = start_listener(sock.clone(), test_handler)
            .expect("a stale node without a live lock is reclaimed");
        assert!(matches!(
            identify_over(&sock).await,
            Response::Identified { .. }
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn different_user_is_refused_before_dispatch() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("reg.sock");
        let dispatched = Arc::new(AtomicBool::new(false));
        let dispatched_in_handler = dispatched.clone();
        let _handle = start_listener_with_peer_uid(
            sock.clone(),
            move |_request| {
                dispatched_in_handler.store(true, Ordering::SeqCst);
                async {
                    Response::Error {
                        message: "must not dispatch".into(),
                    }
                }
            },
            |_stream| Ok(effective_uid().wrapping_add(1)),
        )
        .unwrap();

        let mut stream = tokio::net::UnixStream::connect(&sock).await.unwrap();
        // The refusal can land before this write reaches the server: the
        // accept loop drops the connection on the uid check, so a broken
        // pipe here IS the refusal, not a test failure.
        if let Err(e) = stream
            .write_all(b"{\"type\":\"identify\",\"protocol\":2,\"cli_version\":\"x\"}\n")
            .await
        {
            assert!(
                matches!(
                    e.kind(),
                    std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset
                ),
                "unexpected refusal write error: {e}"
            );
        }
        let mut reply = Vec::new();
        let read = tokio::time::timeout(Duration::from_secs(1), stream.read_to_end(&mut reply))
            .await
            .expect("refusal closes the connection");
        match read {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset => {}
            Err(e) => panic!("unexpected refusal read error: {e}"),
        }
        assert!(reply.is_empty());
        assert!(!dispatched.load(Ordering::SeqCst));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn hung_identity_probe_is_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("hung.sock");
        let listener = tokio::net::UnixListener::bind(&sock).unwrap();
        // The hold is far longer than the pass bound below, so an unbounded
        // probe still reddens this test while a loaded host has seconds of
        // scheduling slack instead of a 500ms wall-clock knife edge.
        let hung = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(30)).await;
        });

        let started = std::time::Instant::now();
        assert!(probe_instance(sock, Duration::from_millis(25))
            .await
            .is_none());
        assert!(started.elapsed() < Duration::from_secs(5));
        hung.abort();
    }

    #[cfg(unix)]
    async fn test_handler(request: Request) -> Response {
        match request {
            Request::Identify { .. } => Response::Identified {
                pid: 123,
                library_root: PathBuf::from("/tmp/library"),
                port: 8787,
                version: CHAN_VERSION.into(),
            },
            Request::RegisterWorkspace { workspace_path, .. } => {
                assert_eq!(workspace_path, "/tmp/notes");
                Response::Registered {
                    devserver_version: CHAN_VERSION.into(),
                    prefix: "/api/notes-1a2b3c".into(),
                }
            }
        }
    }

    /// Connect directly to `sock` and round-trip one RegisterWorkspace.
    /// Mirrors try_register_devserver's wire framing but targets an explicit
    /// socket so the test does not depend on the discovery namespace.
    #[cfg(unix)]
    async fn request_over(sock: &std::path::Path, workspace: &str) -> Response {
        let req = Request::RegisterWorkspace {
            protocol: PROTOCOL_VERSION,
            cli_version: CHAN_VERSION.into(),
            workspace_path: workspace.into(),
        };
        round_trip(sock, &req).await
    }

    #[cfg(unix)]
    async fn identify_over(sock: &std::path::Path) -> Response {
        let req = Request::Identify {
            protocol: PROTOCOL_VERSION,
            cli_version: CHAN_VERSION.into(),
        };
        round_trip(sock, &req).await
    }

    #[cfg(unix)]
    async fn round_trip(sock: &std::path::Path, req: &Request) -> Response {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::UnixStream;

        let stream = UnixStream::connect(sock).await.unwrap();
        let mut payload = serde_json::to_vec(req).unwrap();
        payload.push(b'\n');
        let (read, mut write) = stream.into_split();
        write.write_all(&payload).await.unwrap();
        write.flush().await.unwrap();
        let mut reader = BufReader::new(read);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        serde_json::from_str(&line).unwrap()
    }
}
