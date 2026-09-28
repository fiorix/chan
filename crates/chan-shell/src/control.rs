//! Client side of the control socket: resolve the chan-terminal
//! environment ($CHAN_WINDOW_ID / $CHAN_CONTROL_SOCKET), make paths
//! absolute, and round-trip a [`ControlRequest`] to the chan-server the
//! terminal belongs to -- over a Unix-domain socket on unix, a Windows
//! named pipe on windows. Only the [`transport`] module is `#[cfg]`-split;
//! the wire (one JSON request line, one JSON response line) is identical.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::wire::{ControlRequest, ControlResponse, Identity};

/// The chan-terminal environment a window-targeting action needs: which
/// window to act on and which server socket to reach it through.
#[derive(Debug)]
pub struct OpenEnv {
    pub window_id: String,
    pub control_socket: EnvControlSocket,
}

/// The control socket a chan terminal's environment names
/// (`$CHAN_CONTROL_SOCKET`), with the workspace path the same environment
/// names beside it (`$CHAN_WORKSPACE_PATH`). Only `cs`'s resolvers make one,
/// so a request can tell a socket the terminal was handed from one that a
/// caller found by path. There is no `Deref` to [`Path`]: a call site cannot
/// pass it on as a bare path without saying so.
#[derive(Debug)]
pub struct EnvControlSocket {
    path: PathBuf,
    // Read by the search, which runs on unix only.
    #[cfg_attr(not(unix), allow(dead_code))]
    workspace_path: Option<PathBuf>,
    /// The lines this socket announced, for the tests to read.
    #[cfg(all(test, unix))]
    announced: std::sync::Mutex<Vec<String>>,
}

impl EnvControlSocket {
    fn new(path: String, workspace_path: Option<String>) -> Self {
        Self {
            path: PathBuf::from(path),
            workspace_path: workspace_path
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .map(PathBuf::from),
            #[cfg(all(test, unix))]
            announced: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// Connect to this socket. When it is gone, the devserver tenant that
    /// spawned the terminal may serve on under another prefix, as after a
    /// restart that restored the terminal in a tenant mounted elsewhere; the
    /// request then goes to the one tenant beside this socket that serves
    /// the terminal's workspace (see [`Self::find_moved_server`]). Otherwise
    /// the connect fails as it would for any path.
    async fn connect(&self) -> Result<(transport::ReadEnd, transport::WriteEnd)> {
        let err = match transport::connect(&self.path).await {
            Ok(halves) => return Ok(halves),
            Err(err) => err,
        };
        #[cfg(unix)]
        if is_gone(&err) {
            if let Some((found, root)) = self.find_moved_server().await {
                if let Ok(halves) = transport::connect(&found).await {
                    self.announce(&found, &root);
                    return Ok(halves);
                }
            }
        }
        Err(connect_error(&self.path, err))
    }

    /// The one devserver tenant beside this gone socket that serves the
    /// terminal's workspace, with the root it reports. The search runs only
    /// when this socket has a devserver's stable name (a `chan serve` or
    /// desktop socket belongs to its own process), when its directory's
    /// mode has no group or world write bit, and when the environment names
    /// a workspace. It then asks each stable socket beside this one who it
    /// is, and answers only when exactly one devserver tenant reports the
    /// canonical path of that workspace as its root.
    ///
    /// The directory rule is why a name found there may be believed: the
    /// users who can create an entry in a directory without those two bits
    /// are its owner and root, and both can already replace the socket the
    /// environment names, so the search trusts nobody that connecting to
    /// the environment's path does not. Where others can add names, as in
    /// `/tmp`, anybody could answer as a devserver.
    #[cfg(unix)]
    async fn find_moved_server(&self) -> Option<(PathBuf, PathBuf)> {
        let name = self.path.file_name()?.to_str()?;
        if !stable_control_socket_name(name, true) {
            return None;
        }
        let dir = self.path.parent()?;
        if !only_owner_writes(dir) {
            return None;
        }
        let workspace = self.workspace_path.as_deref()?;
        let mut serving = Vec::new();
        for candidate in stable_control_socket_candidates(dir, true) {
            if candidate == self.path {
                continue;
            }
            let Some(identity) = socket_identity(&candidate).await else {
                continue;
            };
            if identity.kind != crate::wire::ServeKind::Devserver {
                continue;
            }
            if let Some(root) = identity.workspace_root {
                serving.push((candidate, root));
            }
        }
        if serving.is_empty() {
            return None;
        }
        // Resolved only once a devserver tenant has answered: a workspace
        // folder that does not answer holds `cs` here, until it does or the
        // user interrupts, and only in a terminal with such a tenant beside
        // its socket.
        let root = std::fs::canonicalize(workspace).ok()?;
        let mut matching = serving.into_iter().filter(|(_, served)| *served == root);
        let found = matching.next()?;
        matching.next().is_none().then_some(found)
    }

    /// Say, only to a person at a terminal, that this terminal's server
    /// answered at another socket than the one its environment
    /// names. A script or an agent reads `cs`'s stderr through a pipe and
    /// sees nothing new.
    #[cfg(unix)]
    fn announce(&self, found: &Path, root: &Path) {
        use std::io::IsTerminal;
        let line = format!(
            "this terminal's server moved: $CHAN_CONTROL_SOCKET {} is gone, reached {} \
             (serving {}); a new terminal connects directly",
            self.path.display(),
            found.display(),
            root.display()
        );
        if std::io::stderr().is_terminal() {
            eprintln!("{line}");
        }
        #[cfg(test)]
        self.announced.lock().expect("announced lines").push(line);
    }
}

/// Whether only the owner of `dir` (and root) can create entries in it: its
/// mode has neither the group's nor the world's write bit.
#[cfg(unix)]
fn only_owner_writes(dir: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(dir).is_ok_and(|meta| meta.is_dir() && meta.permissions().mode() & 0o022 == 0)
}

/// Where a control request goes: a socket its caller found by path, or the
/// one a chan terminal's environment names. Other crates never name it; they
/// pass a path, which converts.
pub enum ControlTarget<'a> {
    Path(&'a Path),
    Env(&'a EnvControlSocket),
}

impl<'a> From<&'a Path> for ControlTarget<'a> {
    fn from(path: &'a Path) -> Self {
        Self::Path(path)
    }
}

impl<'a> From<&'a PathBuf> for ControlTarget<'a> {
    fn from(path: &'a PathBuf) -> Self {
        Self::Path(path)
    }
}

impl<'a> From<&'a EnvControlSocket> for ControlTarget<'a> {
    fn from(socket: &'a EnvControlSocket) -> Self {
        Self::Env(socket)
    }
}

/// Build an [`OpenEnv`] from explicit values (the env-var lookups live in
/// [`open_env`]; this split keeps the validation unit-testable without
/// touching the process environment).
pub(crate) fn open_env_from(
    window_id: Option<String>,
    control_socket: Option<String>,
    workspace_path: Option<String>,
) -> Result<OpenEnv> {
    let window_id = window_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!("not running inside a chan session; this needs $CHAN_WINDOW_ID")
        })?;
    let control_socket = control_socket
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!("not running inside a chan session; this needs $CHAN_CONTROL_SOCKET")
        })?;
    Ok(OpenEnv {
        window_id,
        control_socket: EnvControlSocket::new(control_socket, workspace_path),
    })
}

/// Resolve the full chan-terminal environment from the process env, for
/// category-1 actions that target a specific window.
pub(crate) fn open_env() -> Result<OpenEnv> {
    open_env_from(
        std::env::var("CHAN_WINDOW_ID").ok(),
        std::env::var("CHAN_CONTROL_SOCKET").ok(),
        std::env::var("CHAN_WORKSPACE_PATH").ok(),
    )
}

/// Resolve just the control socket, for category-2 actions (`cs terminal
/// write` / `terminal list` / `search`) that act on the server's live
/// sessions and so do not need a window to target.
pub(crate) fn control_socket_env() -> Result<EnvControlSocket> {
    let socket = std::env::var("CHAN_CONTROL_SOCKET")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!("not running inside a chan terminal; this needs $CHAN_CONTROL_SOCKET")
        })?;
    Ok(EnvControlSocket::new(
        socket,
        std::env::var("CHAN_WORKSPACE_PATH").ok(),
    ))
}

/// Make a path absolute against the shell's current working directory.
/// Relative `cs open` / `cs terminal new` paths resolve where the user
/// typed them, not where the server runs.
pub fn absolutize(path: PathBuf) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(std::env::current_dir()
            .context("resolving current directory")?
            .join(path))
    }
}

/// Overall bound on one control-socket `Identify` probe, so a wedged server
/// (accepts but never replies) cannot hang its caller.
const CONTROL_SOCKET_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// The stable-named control-socket candidates in `dir`, sorted for a
/// deterministic probe order.
pub fn stable_control_socket_candidates(dir: &Path, require_sock_ext: bool) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut candidates: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| {
            let name = entry.file_name();
            stable_control_socket_name(&name.to_string_lossy(), require_sock_ext)
        })
        .map(|entry| entry.path())
        .collect();
    candidates.sort();
    candidates
}

/// True when `name` is a devserver's STABLE control socket:
/// `chan-control-s<16 hex>`, `.sock`-suffixed on unix. The `s` marker and
/// exact shape separate it from the pid-scoped `chan-control-<digits>-<rand>`
/// family that `chan serve` and the desktop bind, which belongs to whatever
/// process minted it.
fn stable_control_socket_name(name: &str, require_sock_ext: bool) -> bool {
    let Some(rest) = name.strip_prefix("chan-control-s") else {
        return false;
    };
    let hash = match rest.strip_suffix(".sock") {
        Some(hash) => hash,
        None if require_sock_ext => return false,
        None => rest,
    };
    hash.len() == 16 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Who serves `socket`, from a bounded `Identify` round-trip. `None` for a
/// dead, unreachable or wedged socket, or an unparseable reply.
pub async fn socket_identity(socket: &Path) -> Option<Identity> {
    let identify = async {
        let (read, write) = connect_path(socket).await?;
        round_trip(read, write, ControlRequest::Identify).await
    };
    let message = tokio::time::timeout(CONTROL_SOCKET_PROBE_TIMEOUT, identify)
        .await
        .ok()?
        .ok()?;
    serde_json::from_str(&message).ok()
}

/// Connect to the control socket, mapping the two "server is gone" error
/// kinds to a friendly message. Shared by the one-shot and streaming
/// request paths so both report a dead server the same way.
async fn connect_control(
    target: ControlTarget<'_>,
) -> Result<(transport::ReadEnd, transport::WriteEnd)> {
    match target {
        ControlTarget::Path(path) => connect_path(path).await,
        ControlTarget::Env(env) => env.connect().await,
    }
}

async fn connect_path(socket: &Path) -> Result<(transport::ReadEnd, transport::WriteEnd)> {
    transport::connect(socket)
        .await
        .map_err(|err| connect_error(socket, err))
}

/// Whether a failed connect means no server is behind the socket: its node
/// is gone, or left behind and refusing.
fn is_gone(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
    )
}

fn connect_error(socket: &Path, err: std::io::Error) -> anyhow::Error {
    // A missing or refused socket means the chan window or server that
    // spawned this terminal has exited, leaving a stale
    // $CHAN_CONTROL_SOCKET (common after a devserver restart). Say that
    // instead of surfacing a raw connect trace for a path the user never
    // set by hand.
    if is_gone(&err) {
        anyhow::anyhow!(
            "the chan window or server that spawned this terminal is no longer running \
             (stale $CHAN_CONTROL_SOCKET {})",
            socket.display()
        )
    } else {
        anyhow::Error::new(err).context(format!(
            "connecting to chan control socket {}",
            socket.display()
        ))
    }
}

/// Map the server's first response line to the request's outcome. Shared by
/// the one-shot and streaming paths so both surface the same typed errors.
fn first_response_outcome(response: ControlResponse) -> Result<String> {
    match response {
        ControlResponse::Ok { message } => Ok(message),
        ControlResponse::Error { message } => anyhow::bail!("{message}"),
        // The write was accepted into the asynchronous queue, but at least
        // one target had no submit encoding. Preserve its acknowledgement in
        // a typed error so only `cs terminal write` maps it to exit 69. Only
        // an older devserver sends this; a current one encodes the agent the
        // sender named for every target.
        ControlResponse::SubmitRefused { message } => {
            Err(crate::exit_code::ControlSubmitRefused { message }.into())
        }
        // A bounded blocking request whose window elapsed (a `cs terminal
        // survey --timeout`, a `cs copy` / `cs paste` clipboard round-trip,
        // or a `cs tunnel` nothing acknowledged). Surface it as a typed
        // error the dispatch edge downcasts to a dedicated exit code (124),
        // NOT the generic bail (exit 1), so a timeout is never confused
        // with a real failure.
        ControlResponse::Timeout { message } => {
            Err(crate::exit_code::ControlTimeout { message }.into())
        }
        // The server refused the request outright because the queue that
        // serializes it is full (today only `cs terminal survey` against a
        // flooded target). A plain error: nothing was delivered and nothing
        // waits server-side, so the caller may simply retry later.
        ControlResponse::QueueFull { message } => anyhow::bail!("{message}"),
        // `cs export`'s typed success: the final workspace-relative output
        // path rides its own variant, and it IS the message the CLI prints.
        ControlResponse::Export { out_path } => Ok(out_path),
    }
}

/// Judge the half-close that follows a fully written request. The server
/// replies and closes once it has dispatched the request, without waiting
/// for this half-close, and when its close lands first macOS refuses the
/// half-close with ENOTCONN. The request is fully written and the reply, if
/// any, is already queued, so `NotConnected` is not a failure of the request
/// and the caller reads on; a server that closed without answering is reported
/// by `read_first_response`, and any other broken reply fails its read or
/// decode. Any other refusal is the error it is.
fn half_close_outcome(result: std::io::Result<()>) -> Result<()> {
    match result {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotConnected => Ok(()),
        Err(err) => Err(err).context("closing control request"),
    }
}

/// Read the server's first response line and map it to the request's
/// outcome. Shared by the one-shot and streaming paths so a server that
/// closed without answering is reported in the same words by both, and so
/// both surface the same typed errors through [`first_response_outcome`].
async fn read_first_response<R>(reader: &mut R) -> Result<String>
where
    R: tokio::io::AsyncBufRead + Unpin,
{
    use tokio::io::AsyncBufReadExt;

    let mut line = String::new();
    let n = reader
        .read_line(&mut line)
        .await
        .context("reading control response")?;
    if n == 0 {
        anyhow::bail!("the server closed the control socket before answering");
    }
    let response: ControlResponse =
        serde_json::from_str(&line).context("decoding control response")?;
    first_response_outcome(response)
}

/// Connect to the control socket, write one JSON request line, and return
/// the server's reply message (or its error, surfaced as an `Err`).
/// Platform-neutral over the `transport` module.
pub async fn send_control_request<'a>(
    socket: impl Into<ControlTarget<'a>>,
    request: ControlRequest,
) -> Result<String> {
    let (read, write) = connect_control(socket.into()).await?;
    round_trip(read, write, request).await
}

/// Write one JSON request line on a connected socket, half-close it, and
/// read the reply. The search for a moved terminal's server probes through
/// this with a connect of its own, since a probe that went through
/// [`connect_control`] could search in turn.
async fn round_trip(
    read: transport::ReadEnd,
    mut write: transport::WriteEnd,
    request: ControlRequest,
) -> Result<String> {
    use tokio::io::{AsyncWriteExt, BufReader};

    let mut payload = serde_json::to_vec(&request).context("encoding control request")?;
    payload.push(b'\n');
    write
        .write_all(&payload)
        .await
        .context("writing control request")?;
    // Harmless on both paths: a Unix stream half-closes its write side;
    // tokio's named-pipe `poll_shutdown` is a no-op (the `\n` already frames
    // the request, so the server reads it regardless).
    half_close_outcome(write.shutdown().await)?;

    read_first_response(&mut BufReader::new(read)).await
}

/// Send a blocking request while retaining the client's write half until the
/// first response arrives. The server may use EOF on that half to cancel work
/// if the client exits while the request is parked.
pub async fn send_control_request_held<'a>(
    socket: impl Into<ControlTarget<'a>>,
    request: ControlRequest,
) -> Result<String> {
    Ok(send_control_request_streaming(socket, request).await?.ack)
}

/// The still-open control connection after its first response line. `cs
/// tunnel` keeps it until [`TunnelSession::wait`] returns or the session is
/// dropped; [`send_control_request_held`] drops it as soon as that first
/// response arrives.
#[derive(Debug)]
pub struct TunnelSession {
    /// The server's acknowledgement, already unwrapped from its
    /// [`ControlResponse`] envelope.
    pub ack: String,
    reader: tokio::io::BufReader<transport::ReadEnd>,
    // Held open, never written again. For a tunnel the server reads this
    // half's EOF as "the foreground command ended", so dropping the session
    // (Ctrl-C kills the process, or `wait` returns) is the teardown signal.
    _write: transport::WriteEnd,
}

impl TunnelSession {
    /// Block until the request ends. A clean server close (EOF) means the
    /// server acknowledged this command going away and there is nothing to
    /// report. A second response line means the tunnel died before the
    /// client did; its message is surfaced as the error, whatever variant
    /// carried it.
    pub async fn wait(mut self) -> Result<()> {
        use tokio::io::AsyncBufReadExt;

        let mut line = String::new();
        let n = self
            .reader
            .read_line(&mut line)
            .await
            .context("waiting on the tunnel's control connection")?;
        if n == 0 {
            return Ok(());
        }
        let response: ControlResponse =
            serde_json::from_str(&line).context("decoding tunnel end notice")?;
        let message = match response {
            ControlResponse::Ok { message }
            | ControlResponse::Error { message }
            | ControlResponse::SubmitRefused { message }
            | ControlResponse::Timeout { message }
            | ControlResponse::QueueFull { message } => message,
            ControlResponse::Export { out_path } => out_path,
        };
        anyhow::bail!("{message}");
    }
}

/// Connect, write one JSON request line WITHOUT half-closing the write side,
/// read the first response line, and hand back the still-open connection. The
/// sibling of [`send_control_request`] for requests whose connection lifetime
/// is meaningful to the server: `cs tunnel` retains the returned session for
/// the tunnel's lifetime, while [`send_control_request_held`] drops it after
/// the first response to bound a parked request's lifetime.
pub async fn send_control_request_streaming<'a>(
    socket: impl Into<ControlTarget<'a>>,
    request: ControlRequest,
) -> Result<TunnelSession> {
    use tokio::io::{AsyncWriteExt, BufReader};

    let (read, mut write) = connect_control(socket.into()).await?;
    let mut payload = serde_json::to_vec(&request).context("encoding control request")?;
    payload.push(b'\n');
    write
        .write_all(&payload)
        .await
        .context("writing control request")?;

    let mut reader = BufReader::new(read);
    let ack = read_first_response(&mut reader).await?;
    Ok(TunnelSession {
        ack,
        reader,
        _write: write,
    })
}

/// The `cs` control client's transport module -- the only `#[cfg]`-split
/// surface. unix connects a `UnixStream`; windows opens a
/// `tokio::net::windows::named_pipe` client. Both yield read/write halves
/// the line-framed round-trip above drives identically.
mod transport {
    use std::path::Path;

    // Named halves so [`super::TunnelSession`] can hold them without a
    // `#[cfg]`-split of its own; the aliases are the only platform seam.
    #[cfg(unix)]
    pub type ReadEnd = tokio::net::unix::OwnedReadHalf;
    #[cfg(unix)]
    pub type WriteEnd = tokio::net::unix::OwnedWriteHalf;
    #[cfg(windows)]
    pub type ReadEnd = tokio::io::ReadHalf<tokio::net::windows::named_pipe::NamedPipeClient>;
    #[cfg(windows)]
    pub type WriteEnd = tokio::io::WriteHalf<tokio::net::windows::named_pipe::NamedPipeClient>;

    #[cfg(unix)]
    pub async fn connect(socket: &Path) -> std::io::Result<(ReadEnd, WriteEnd)> {
        let stream = tokio::net::UnixStream::connect(socket).await?;
        Ok(stream.into_split())
    }

    #[cfg(windows)]
    pub async fn connect(socket: &Path) -> std::io::Result<(ReadEnd, WriteEnd)> {
        use tokio::net::windows::named_pipe::ClientOptions;
        use tokio::time::{sleep, Duration, Instant};

        // ERROR_PIPE_BUSY (231): every pipe instance is momentarily in use;
        // retry until one frees. Inlined to avoid a `windows-sys` dependency
        // just for the constant.
        const ERROR_PIPE_BUSY: i32 = 231;
        // Bound the wait so a genuinely-absent server fails fast instead of
        // hanging `cs`, mirroring the unix connect's immediate ENOENT.
        let deadline = Instant::now() + Duration::from_secs(5);

        let client = loop {
            match ClientOptions::new().open(socket) {
                Ok(client) => break client,
                // Busy, or momentarily gone while the server swaps in a fresh
                // instance between clients: wait briefly and retry.
                Err(e)
                    if e.raw_os_error() == Some(ERROR_PIPE_BUSY)
                        || e.kind() == std::io::ErrorKind::NotFound =>
                {
                    if Instant::now() >= deadline {
                        return Err(e);
                    }
                    sleep(Duration::from_millis(20)).await;
                }
                Err(e) => return Err(e),
            }
        };
        Ok(tokio::io::split(client))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_control_socket_name_excludes_pid_shaped_names() {
        // A devserver's stable socket (`chan-control-s<16 hex>`, no pid) is a
        // probe candidate; a pid-named socket or an unrelated file is not.
        assert!(stable_control_socket_name(
            "chan-control-s89abcdef01234567.sock",
            true
        ));
        assert!(!stable_control_socket_name(
            "chan-control-4242-ef01.sock",
            true
        ));
        assert!(!stable_control_socket_name("chan-mcp-4242-ef01.sock", true));
        // Only the exact 16-lowercase-hex hash shape qualifies.
        assert!(!stable_control_socket_name(
            "chan-control-s89abcdef.sock",
            true
        ));
        assert!(!stable_control_socket_name(
            "chan-control-s89ABCDEF01234567.sock",
            true
        ));
        // The `.sock` suffix is required only on unix (a Windows pipe name
        // has none).
        assert!(!stable_control_socket_name(
            "chan-control-s89abcdef01234567",
            true
        ));
        assert!(stable_control_socket_name(
            "chan-control-s89abcdef01234567",
            false
        ));
    }

    #[test]
    fn absolutize_resolves_dot_and_relative_paths_against_the_cwd() {
        let cwd = std::env::current_dir().unwrap();
        // `.` resolves to the current directory: `cs upload .` / `cs download .`
        // target the terminal's cwd.
        assert_eq!(absolutize(PathBuf::from(".")).unwrap(), cwd.join("."));
        // Any relative path is joined onto the cwd.
        assert_eq!(
            absolutize(PathBuf::from("sub/x")).unwrap(),
            cwd.join("sub/x")
        );
        // An absolute path passes through unchanged.
        let abs = if cfg!(windows) {
            PathBuf::from("C:\\abs\\x")
        } else {
            PathBuf::from("/abs/x")
        };
        assert_eq!(absolutize(abs.clone()).unwrap(), abs);
    }

    #[test]
    fn open_env_requires_window_id_and_control_socket() {
        let err = open_env_from(None, Some("/tmp/chan-control.sock".into()), None).unwrap_err();
        assert!(err.to_string().contains("CHAN_WINDOW_ID"));

        let err = open_env_from(Some("win".into()), None, None).unwrap_err();
        assert!(err.to_string().contains("CHAN_CONTROL_SOCKET"));

        let env = open_env_from(
            Some(" win ".into()),
            Some(" /tmp/chan-control.sock ".into()),
            Some(" /work/notes ".into()),
        )
        .unwrap();
        assert_eq!(env.window_id, "win");
        assert_eq!(
            env.control_socket.path,
            PathBuf::from("/tmp/chan-control.sock")
        );
        assert_eq!(
            env.control_socket.workspace_path,
            Some(PathBuf::from("/work/notes"))
        );

        // A blank workspace path is no workspace path.
        let env = open_env_from(
            Some("win".into()),
            Some("/tmp/chan-control.sock".into()),
            Some("  ".into()),
        )
        .unwrap();
        assert_eq!(env.control_socket.workspace_path, None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn send_control_request_renders_queue_full_as_a_plain_error() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // A one-shot fake server that answers every request with the
        // queue-full status, standing in for a survey target whose FIFO is
        // at capacity.
        let socket =
            std::env::temp_dir().join(format!("chan-cs-queue-full-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&socket);
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move {
            let (mut conn, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = conn.read(&mut buf).await.unwrap();
            conn.write_all(
                b"{\"status\":\"queue_full\",\"message\":\"survey queue for this target is full\"}\n",
            )
            .await
            .unwrap();
        });

        let err = send_control_request(&socket, ControlRequest::WindowList)
            .await
            .unwrap_err();
        server.await.unwrap();
        let _ = std::fs::remove_file(&socket);

        // Rendered as a plain error carrying the server's line, not a decode
        // failure and not the timeout path (nothing to downcast).
        assert_eq!(err.to_string(), "survey queue for this target is full");
        assert!(err
            .downcast_ref::<crate::exit_code::ControlTimeout>()
            .is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn send_control_request_types_a_timeout_reply_for_the_124_edge() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // A one-shot fake server answering with the timeout status, standing
        // in for a clipboard round-trip (or survey window) that elapsed. The
        // reply must downcast to ControlTimeout so the dispatch edge exits
        // 124 instead of the generic 1.
        let socket =
            std::env::temp_dir().join(format!("chan-cs-timeout-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&socket);
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move {
            let (mut conn, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = conn.read(&mut buf).await.unwrap();
            conn.write_all(
                b"{\"status\":\"timeout\",\"message\":\"no clipboard reply from the window within 30s\"}\n",
            )
            .await
            .unwrap();
        });

        let err = send_control_request(&socket, ControlRequest::WindowList)
            .await
            .unwrap_err();
        server.await.unwrap();
        let _ = std::fs::remove_file(&socket);

        let timeout = err
            .downcast_ref::<crate::exit_code::ControlTimeout>()
            .expect("typed ControlTimeout");
        assert_eq!(
            timeout.message,
            "no clipboard reply from the window within 30s"
        );
    }

    // Compatibility, not current behaviour: the wire bytes below are what an
    // OLDER devserver sent when a target's spawn command named no agent. A
    // current one encodes the agent the sender named and answers Ok, so this
    // pins that a `cs` pointed at an older server still types the refusal and
    // reaches exit 69 rather than mis-reporting it as success.
    #[cfg(unix)]
    #[tokio::test]
    async fn send_control_request_types_an_older_servers_submit_refusal() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let socket = std::env::temp_dir().join(format!(
            "chan-cs-submit-refused-{}.sock",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&socket);
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move {
            let (mut conn, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = conn.read(&mut buf).await.unwrap();
            conn.write_all(
                b"{\"status\":\"submit_refused\",\"message\":\"queued at position 1; Sh is a shell session: no codex chord applied\"}\n",
            )
            .await
            .unwrap();
        });

        let err = send_control_request(&socket, ControlRequest::WindowList)
            .await
            .unwrap_err();
        server.await.unwrap();
        let _ = std::fs::remove_file(&socket);

        let refusal = err
            .downcast_ref::<crate::exit_code::ControlSubmitRefused>()
            .expect("typed ControlSubmitRefused");
        assert_eq!(
            refusal.message,
            "queued at position 1; Sh is a shell session: no codex chord applied"
        );
    }

    /// The half-close after a written request: a peer that closed first
    /// (macOS answers the client's `shutdown(2)` with ENOTCONN) is not a
    /// failure of the request; any other refusal is, with the io error kept
    /// as its cause under the closing context.
    #[test]
    fn half_close_tolerates_only_a_peer_that_closed_first() {
        use std::io::{Error, ErrorKind};

        half_close_outcome(Ok(())).unwrap();
        half_close_outcome(Err(Error::from(ErrorKind::NotConnected))).unwrap();
        for kind in [ErrorKind::BrokenPipe, ErrorKind::InvalidInput] {
            let err = half_close_outcome(Err(Error::from(kind))).unwrap_err();
            assert!(
                err.chain()
                    .any(|cause| cause.to_string() == "closing control request"),
                "{kind:?}: {err:#}"
            );
            let cause = err
                .downcast_ref::<Error>()
                .unwrap_or_else(|| panic!("{kind:?}: io error kept as the cause: {err:#}"));
            assert_eq!(cause.kind(), kind);
        }
    }

    /// The real control server's order: it reads the request line, writes
    /// its reply and returns, closing the socket without waiting for the
    /// client's half-close. On the current_thread test runtime the fake is
    /// not polled between the client's request bytes and its shutdown, so
    /// its close cannot land first and the half-close always succeeds: what
    /// this pins is the `Ok` round trip against a server that never reads
    /// to the client's EOF. The refused half-close has its own test on
    /// `half_close_outcome`.
    #[cfg(unix)]
    #[tokio::test]
    async fn send_control_request_accepts_a_reply_from_a_server_that_closes_at_once() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let socket =
            std::env::temp_dir().join(format!("chan-cs-early-close-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&socket);
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move {
            let (conn, _) = listener.accept().await.unwrap();
            let (read, mut write) = conn.into_split();
            let mut line = String::new();
            BufReader::new(read).read_line(&mut line).await.unwrap();
            assert!(line.ends_with('\n'), "request line is newline-framed");
            write
                .write_all(b"{\"status\":\"ok\",\"message\":\"[]\"}\n")
                .await
                .unwrap();
            // Returning drops the write half and closes the socket right
            // behind the reply, without reading to the client's EOF.
        });

        let reply = send_control_request(&socket, ControlRequest::WindowList)
            .await
            .unwrap();
        server.await.unwrap();
        let _ = std::fs::remove_file(&socket);

        assert_eq!(reply, "[]");
    }

    /// A server that reads the request and closes without writing a reply:
    /// the one-shot path names that in the streaming path's words, not as a
    /// decode error over an empty line.
    #[cfg(unix)]
    #[tokio::test]
    async fn send_control_request_names_a_server_that_closed_without_answering() {
        use tokio::io::{AsyncBufReadExt, BufReader};

        let socket =
            std::env::temp_dir().join(format!("chan-cs-no-answer-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&socket);
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move {
            let (conn, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(conn);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            assert!(line.ends_with('\n'), "request line is newline-framed");
            // Returning drops the connection unanswered.
        });

        let err = send_control_request(&socket, ControlRequest::WindowList)
            .await
            .unwrap_err();
        server.await.unwrap();
        let _ = std::fs::remove_file(&socket);

        assert_eq!(
            err.to_string(),
            "the server closed the control socket before answering"
        );
    }

    /// A `ControlRequest::Tunnel` for the streaming tests; the fake servers
    /// below never decode it, they only need one framed request line.
    #[cfg(unix)]
    fn tunnel_request() -> ControlRequest {
        ControlRequest::Tunnel {
            window_id: "w-1".into(),
            proto: chan_revtunnel::Proto::Tcp,
            bind_addr: "127.0.0.1".into(),
            desktop_port: 8080,
            devserver_port: 3000,
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn streaming_request_holds_the_connection_open_while_waiting() {
        use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

        // The load-bearing property of the streaming path: after the ack the
        // client's write half stays open, because the server reads its EOF as
        // "the command ended" and would tear the tunnel down. The fake server
        // proves it by reading again and expecting to time out, not to see
        // EOF, while the client blocks in `wait`.
        let socket =
            std::env::temp_dir().join(format!("chan-cs-tunnel-hold-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&socket);
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move {
            let (conn, _) = listener.accept().await.unwrap();
            let (read, mut write) = conn.into_split();
            let mut reader = BufReader::new(read);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            assert!(line.ends_with('\n'), "request line is newline-framed");
            write
                .write_all(b"{\"status\":\"ok\",\"message\":\"tunnel up\"}\n")
                .await
                .unwrap();
            let mut buf = [0u8; 1];
            let second_read =
                tokio::time::timeout(std::time::Duration::from_millis(200), reader.read(&mut buf))
                    .await;
            assert!(
                second_read.is_err(),
                "the client half-closed its write side; the server would read \
                 that EOF as the command ending"
            );
            // Dropping the connection here is the server closing: the
            // client's `wait` resolves Ok with nothing to report.
        });

        let session = send_control_request_streaming(&socket, tunnel_request())
            .await
            .unwrap();
        assert_eq!(session.ack, "tunnel up");
        session.wait().await.unwrap();
        server.await.unwrap();
        let _ = std::fs::remove_file(&socket);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn streaming_wait_surfaces_a_second_line_as_the_tunnel_dying() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let socket =
            std::env::temp_dir().join(format!("chan-cs-tunnel-died-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&socket);
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move {
            let (conn, _) = listener.accept().await.unwrap();
            let (read, mut write) = conn.into_split();
            let mut reader = BufReader::new(read);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            write
                .write_all(b"{\"status\":\"ok\",\"message\":\"tunnel up\"}\n")
                .await
                .unwrap();
            write
                .write_all(
                    b"{\"status\":\"error\",\"message\":\"tunnel closed: desktop disconnected\"}\n",
                )
                .await
                .unwrap();
        });

        let session = send_control_request_streaming(&socket, tunnel_request())
            .await
            .unwrap();
        assert_eq!(session.ack, "tunnel up");
        let err = session.wait().await.unwrap_err();
        assert_eq!(err.to_string(), "tunnel closed: desktop disconnected");
        server.await.unwrap();
        let _ = std::fs::remove_file(&socket);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn streaming_request_maps_first_line_errors_like_the_one_shot_path() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        // Two first-line failures share the one-shot mapping: an Error line
        // is a plain bail, and a Timeout line stays typed so the dispatch
        // edge can exit 124.
        let cases: [(&[u8], bool); 2] = [
            (
                b"{\"status\":\"error\",\"message\":\"no desktop is viewing window w-1\"}\n",
                false,
            ),
            (
                b"{\"status\":\"timeout\",\"message\":\"no tunnel listener within 10s\"}\n",
                true,
            ),
        ];
        for (index, (reply, expect_timeout)) in cases.into_iter().enumerate() {
            let socket = std::env::temp_dir().join(format!(
                "chan-cs-tunnel-first-{}-{index}.sock",
                std::process::id()
            ));
            let _ = std::fs::remove_file(&socket);
            let listener = tokio::net::UnixListener::bind(&socket).unwrap();
            let server = tokio::spawn(async move {
                let (conn, _) = listener.accept().await.unwrap();
                let (read, mut write) = conn.into_split();
                let mut reader = BufReader::new(read);
                let mut line = String::new();
                reader.read_line(&mut line).await.unwrap();
                write.write_all(reply).await.unwrap();
            });

            let err = send_control_request_streaming(&socket, tunnel_request())
                .await
                .unwrap_err();
            let typed = err.downcast_ref::<crate::exit_code::ControlTimeout>();
            assert_eq!(typed.is_some(), expect_timeout, "{err}");
            server.await.unwrap();
            let _ = std::fs::remove_file(&socket);
        }
    }

    /// A stand-in devserver tenant on a unix socket. It answers `Identify`
    /// with the identity it was given, or never when it was given none (a
    /// wedged server), and any other request with its own name. It counts
    /// the connections it accepts and what they asked.
    #[cfg(unix)]
    struct FakeTenant {
        connections: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        identifies: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        requests: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        accept: tokio::task::JoinHandle<()>,
    }

    #[cfg(unix)]
    impl FakeTenant {
        fn spawn(path: &Path, identity: Option<Identity>, name: &'static str) -> Self {
            use std::sync::atomic::{AtomicUsize, Ordering};
            use std::sync::Arc;
            use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

            let listener = tokio::net::UnixListener::bind(path).unwrap();
            let connections = Arc::new(AtomicUsize::new(0));
            let identifies = Arc::new(AtomicUsize::new(0));
            let requests = Arc::new(AtomicUsize::new(0));
            let counts = (connections.clone(), identifies.clone(), requests.clone());
            let accept = tokio::spawn(async move {
                let (connections, identifies, requests) = counts;
                while let Ok((stream, _)) = listener.accept().await {
                    connections.fetch_add(1, Ordering::SeqCst);
                    let identity = identity.clone();
                    let (identifies, requests) = (identifies.clone(), requests.clone());
                    tokio::spawn(async move {
                        let (read, mut write) = stream.into_split();
                        let mut line = String::new();
                        if BufReader::new(read).read_line(&mut line).await.is_err() {
                            return;
                        }
                        let message = match serde_json::from_str::<ControlRequest>(&line) {
                            Ok(ControlRequest::Identify) => {
                                identifies.fetch_add(1, Ordering::SeqCst);
                                match &identity {
                                    Some(identity) => serde_json::to_string(identity).unwrap(),
                                    None => {
                                        std::future::pending::<()>().await;
                                        return;
                                    }
                                }
                            }
                            _ => {
                                requests.fetch_add(1, Ordering::SeqCst);
                                name.to_string()
                            }
                        };
                        let mut reply =
                            serde_json::to_vec(&ControlResponse::Ok { message }).unwrap();
                        reply.push(b'\n');
                        let _ = write.write_all(&reply).await;
                    });
                }
            });
            Self {
                connections,
                identifies,
                requests,
                accept,
            }
        }

        fn connections(&self) -> usize {
            self.connections.load(std::sync::atomic::Ordering::SeqCst)
        }

        fn identifies(&self) -> usize {
            self.identifies.load(std::sync::atomic::Ordering::SeqCst)
        }

        fn requests(&self) -> usize {
            self.requests.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    #[cfg(unix)]
    impl Drop for FakeTenant {
        fn drop(&mut self) {
            self.accept.abort();
        }
    }

    /// A directory of the test's own under the temp dir, with the mode it
    /// is given, removed on drop. The name is short: macOS caps a socket
    /// path at 104 bytes.
    #[cfg(unix)]
    struct SocketDir(PathBuf);

    #[cfg(unix)]
    impl SocketDir {
        fn new(tag: &str, mode: u32) -> Self {
            use std::os::unix::fs::PermissionsExt;
            let path = std::env::temp_dir().join(format!("cs-{}-{tag}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir(&path).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
            Self(path)
        }

        /// The path of a devserver's stable socket named after `n`.
        fn stable(&self, n: u64) -> PathBuf {
            self.0.join(format!("chan-control-s{n:016x}.sock"))
        }

        /// A workspace folder reached through a symlink: the path a shell's
        /// environment would name, and the canonical root its tenant
        /// reports.
        fn workspace(&self) -> (PathBuf, PathBuf) {
            let real = self.0.join("ws-real");
            let link = self.0.join("ws-link");
            std::fs::create_dir(&real).unwrap();
            std::os::unix::fs::symlink(&real, &link).unwrap();
            (link, std::fs::canonicalize(&real).unwrap())
        }
    }

    #[cfg(unix)]
    impl Drop for SocketDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    fn identity(kind: crate::wire::ServeKind, root: Option<PathBuf>) -> Identity {
        Identity {
            kind,
            version: "test".into(),
            pid: 1,
            metadata_key: root.as_ref().map(|_| "key".into()),
            workspace_root: root,
        }
    }

    #[cfg(unix)]
    fn env_socket(path: &Path, workspace: Option<&Path>) -> EnvControlSocket {
        EnvControlSocket::new(
            path.display().to_string(),
            workspace.map(|path| path.display().to_string()),
        )
    }

    // A socket the environment names and that answers is used as it is:
    // nothing beside it is asked who it is.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_live_environment_socket_is_used_as_it_is() {
        use crate::wire::ServeKind::Devserver;
        let dir = SocketDir::new("p0", 0o700);
        let (link, root) = dir.workspace();
        let own = FakeTenant::spawn(
            &dir.stable(1),
            Some(identity(Devserver, Some(root.clone()))),
            "own",
        );
        let beside = FakeTenant::spawn(
            &dir.stable(2),
            Some(identity(Devserver, Some(root))),
            "beside",
        );
        let socket = env_socket(&dir.stable(1), Some(&link));
        let reply = send_control_request(&socket, ControlRequest::WindowList)
            .await
            .unwrap();
        assert_eq!(reply, "own");
        assert_eq!(own.identifies(), 0, "the live socket was asked who it is");
        assert_eq!(
            beside.connections(),
            0,
            "a socket beside a live one was knocked"
        );
        assert!(socket.announced.lock().unwrap().is_empty());
    }

    // A terminal whose tenant moved to another prefix keeps the socket of
    // the old one, which nothing binds. Its request reaches the one devserver
    // tenant beside that socket that serves its workspace, which is asked who
    // it is once, and the move is announced once, whether the old socket's
    // node is gone or left behind refusing.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_moved_terminal_reaches_the_tenant_serving_its_workspace() {
        use crate::wire::ServeKind::Devserver;
        for stale_node in [false, true] {
            let dir = SocketDir::new(if stale_node { "p1b" } else { "p1a" }, 0o700);
            let (link, root) = dir.workspace();
            let dead = dir.stable(1);
            if stale_node {
                // A listener dropped without an unlink leaves a node that
                // refuses, as a server that crashed does.
                drop(std::os::unix::net::UnixListener::bind(&dead).unwrap());
            }
            let other = FakeTenant::spawn(
                &dir.stable(2),
                Some(identity(Devserver, Some(dir.0.clone()))),
                "other",
            );
            let moved = FakeTenant::spawn(
                &dir.stable(3),
                Some(identity(Devserver, Some(root.clone()))),
                "moved",
            );
            let socket = env_socket(&dead, Some(&link));
            let reply = send_control_request(&socket, ControlRequest::WindowList)
                .await
                .unwrap_or_else(|e| panic!("stale node {stale_node}: {e:#}"));
            assert_eq!(reply, "moved", "stale node {stale_node}");
            assert_eq!(moved.requests(), 1, "stale node {stale_node}");
            assert_eq!(
                moved.identifies(),
                1,
                "stale node {stale_node}: the tenant was asked who it is more than once"
            );
            assert_eq!(other.requests(), 0, "stale node {stale_node}");
            let announced = socket.announced.lock().unwrap().clone();
            assert_eq!(announced.len(), 1, "stale node {stale_node}: {announced:?}");
            let line = &announced[0];
            let (dead, found) = (
                dead.display().to_string(),
                dir.stable(3).display().to_string(),
            );
            assert!(
                line.contains(&dead) && line.contains(&found),
                "stale node {stale_node}: the line names neither socket: {line}"
            );
        }
    }

    // A candidate that accepts and never answers costs the probe's bound,
    // and the search still reaches the tenant after it. The test waits the
    // real two seconds: a paused clock advances whenever the runtime idles,
    // which it does while the search waits on the tenant's real socket, so
    // it would give up on the tenant that answers as well. The guard is
    // twice the bound, so a bound twice as long as the probe's fails it.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_wedged_candidate_costs_the_bound_and_no_more() {
        use crate::wire::ServeKind::Devserver;
        let dir = SocketDir::new("p1c", 0o700);
        let (link, root) = dir.workspace();
        let _wedged = FakeTenant::spawn(&dir.stable(2), None, "wedged");
        let moved = FakeTenant::spawn(
            &dir.stable(3),
            Some(identity(Devserver, Some(root))),
            "moved",
        );
        let socket = env_socket(&dir.stable(1), Some(&link));
        let reply = tokio::time::timeout(
            std::time::Duration::from_secs(4),
            send_control_request(&socket, ControlRequest::WindowList),
        )
        .await
        .expect("the search waited on the wedged candidate past its bound")
        .unwrap_or_else(|e| panic!("{e:#}"));
        assert_eq!(reply, "moved");
        assert_eq!(moved.requests(), 1);
    }

    // Every case in which the search must not choose. Each answers as a
    // dead socket answers today, naming the socket the environment names,
    // and no candidate receives anything but `Identify`.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_moved_terminal_finds_no_tenant_where_the_choice_is_not_clear() {
        use crate::wire::ServeKind::{Desktop, Devserver, Standalone};
        struct Case {
            name: &'static str,
            mode: u32,
            // The dead socket's file name, when it is not stable-shaped.
            dead_name: Option<&'static str>,
            // How the environment names the workspace.
            workspace: fn(&SocketDir, &Path) -> Option<PathBuf>,
            // The candidates beside the dead socket, by the root they
            // serve (`None` for the terminal's own root).
            tenants: Vec<(crate::wire::ServeKind, Option<Option<PathBuf>>)>,
            // Whether a candidate may be connected to at all.
            probed: bool,
            words: &'static str,
        }
        let link = |_: &SocketDir, link: &Path| Some(link.to_path_buf());
        let gone = "no longer running";
        let cases = vec![
            Case {
                name: "a pid-scoped socket",
                mode: 0o700,
                dead_name: Some("chan-control-4242-ab01.sock"),
                workspace: link,
                tenants: vec![(Devserver, None)],
                probed: false,
                words: gone,
            },
            Case {
                name: "no workspace path",
                mode: 0o700,
                dead_name: None,
                workspace: |_, _| None,
                tenants: vec![(Devserver, None)],
                probed: false,
                words: gone,
            },
            Case {
                name: "a workspace path that does not resolve",
                mode: 0o700,
                dead_name: None,
                workspace: |dir, _| Some(dir.0.join("gone")),
                tenants: vec![(Devserver, None)],
                probed: true,
                words: gone,
            },
            Case {
                name: "a tenant of another root",
                mode: 0o700,
                dead_name: None,
                workspace: link,
                tenants: vec![(Devserver, Some(Some(PathBuf::from("/"))))],
                probed: true,
                words: gone,
            },
            Case {
                name: "a standalone server",
                mode: 0o700,
                dead_name: None,
                workspace: link,
                tenants: vec![(Standalone, None)],
                probed: true,
                words: gone,
            },
            Case {
                name: "a desktop",
                mode: 0o700,
                dead_name: None,
                workspace: link,
                tenants: vec![(Desktop, None)],
                probed: true,
                words: gone,
            },
            Case {
                name: "a tenant with no workspace",
                mode: 0o700,
                dead_name: None,
                workspace: link,
                tenants: vec![(Devserver, Some(None))],
                probed: true,
                words: gone,
            },
            Case {
                name: "two tenants of the root",
                mode: 0o700,
                dead_name: None,
                workspace: link,
                tenants: vec![(Devserver, None), (Devserver, None)],
                probed: true,
                words: gone,
            },
            Case {
                name: "a directory others can write",
                mode: 0o777,
                dead_name: None,
                workspace: link,
                tenants: vec![(Devserver, None)],
                probed: false,
                words: gone,
            },
            Case {
                name: "a directory its group can write",
                mode: 0o770,
                dead_name: None,
                workspace: link,
                tenants: vec![(Devserver, None)],
                probed: false,
                words: gone,
            },
            Case {
                name: "a directory the world can write",
                mode: 0o707,
                dead_name: None,
                workspace: link,
                tenants: vec![(Devserver, None)],
                probed: false,
                words: gone,
            },
            Case {
                name: "a connect error of another kind",
                mode: 0o700,
                dead_name: Some("loop"),
                workspace: link,
                tenants: vec![(Devserver, None)],
                probed: false,
                words: "connecting to chan control socket",
            },
        ];
        for (n, case) in cases.into_iter().enumerate() {
            let dir = SocketDir::new(&format!("p2{n}"), case.mode);
            let (link, root) = dir.workspace();
            let dead = match case.dead_name {
                // A symlink to itself: the connect fails with ELOOP, and the
                // name is a stable one, so only the error's kind refuses.
                Some("loop") => {
                    let dead = dir.stable(1);
                    std::os::unix::fs::symlink(&dead, &dead).unwrap();
                    dead
                }
                Some(name) => dir.0.join(name),
                None => dir.stable(1),
            };
            let tenants: Vec<FakeTenant> = case
                .tenants
                .iter()
                .enumerate()
                .map(|(i, (kind, served))| {
                    let served = served.clone().unwrap_or_else(|| Some(root.clone()));
                    FakeTenant::spawn(
                        &dir.stable(2 + i as u64),
                        Some(identity(*kind, served)),
                        "tenant",
                    )
                })
                .collect();
            let socket = env_socket(&dead, (case.workspace)(&dir, &link).as_deref());
            let err = send_control_request(&socket, ControlRequest::WindowList)
                .await
                .map(|reply| format!("reached a tenant: {reply}"))
                .unwrap_or_else(|e| e.to_string());
            assert!(
                err.contains(case.words) && err.contains(&dead.display().to_string()),
                "{}: {err}",
                case.name
            );
            for tenant in &tenants {
                assert_eq!(
                    tenant.requests(),
                    0,
                    "{}: a candidate got the request",
                    case.name
                );
                if !case.probed {
                    assert_eq!(
                        tenant.connections(),
                        0,
                        "{}: a candidate was knocked",
                        case.name
                    );
                }
            }
            assert!(socket.announced.lock().unwrap().is_empty(), "{}", case.name);
        }
    }

    #[tokio::test]
    async fn send_control_request_reports_a_stale_socket_in_plain_words() {
        // A $CHAN_CONTROL_SOCKET pointing at a socket whose server has exited
        // (the file is gone, common after a devserver restart) surfaces a
        // friendly stale-socket message, not a raw connect trace.
        let missing = std::env::temp_dir().join("chan-control-cs-test-does-not-exist.sock");
        let _ = std::fs::remove_file(&missing);
        let err = send_control_request(&missing, ControlRequest::WindowList)
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("no longer running") && msg.contains("stale $CHAN_CONTROL_SOCKET"),
            "{msg}"
        );
    }
}
