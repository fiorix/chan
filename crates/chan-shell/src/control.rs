//! Client side of the control socket: resolve the chan-terminal
//! environment ($CHAN_WINDOW_ID / $CHAN_CONTROL_SOCKET), make paths
//! absolute, and round-trip a [`ControlRequest`] to the chan-server the
//! terminal belongs to -- over a Unix-domain socket on unix, a Windows
//! named pipe on windows. Only the [`transport`] module is `#[cfg]`-split;
//! the wire (one JSON request line, one JSON response line) is identical.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::wire::{ControlRequest, ControlResponse};

/// The chan-terminal environment a window-targeting action needs: which
/// window to act on and which server socket to reach it through.
#[derive(Debug)]
pub struct OpenEnv {
    pub window_id: String,
    pub control_socket: PathBuf,
}

/// Build an [`OpenEnv`] from explicit values (the env-var lookups live in
/// [`open_env`]; this split keeps the validation unit-testable without
/// touching the process environment).
pub fn open_env_from(window_id: Option<String>, control_socket: Option<String>) -> Result<OpenEnv> {
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
        control_socket: PathBuf::from(control_socket),
    })
}

/// Resolve the full chan-terminal environment from the process env, for
/// category-1 actions that target a specific window.
pub fn open_env() -> Result<OpenEnv> {
    open_env_from(
        std::env::var("CHAN_WINDOW_ID").ok(),
        std::env::var("CHAN_CONTROL_SOCKET").ok(),
    )
}

/// Resolve just the control socket, for category-2 actions (`cs terminal
/// write` / `terminal list` / `search`) that act on the server's live
/// sessions and so do not need a window to target.
pub fn control_socket_env() -> Result<PathBuf> {
    let socket = std::env::var("CHAN_CONTROL_SOCKET")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!("not running inside a chan terminal; this needs $CHAN_CONTROL_SOCKET")
        })?;
    Ok(PathBuf::from(socket))
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

/// Connect to the control socket, mapping the two "server is gone" error
/// kinds to a friendly message. Shared by the one-shot and streaming
/// request paths so both report a dead server the same way.
async fn connect_control(socket: &Path) -> Result<(transport::ReadEnd, transport::WriteEnd)> {
    transport::connect(socket).await.map_err(|err| {
        // A missing or refused socket means the chan window or server that
        // spawned this terminal has exited, leaving a stale
        // $CHAN_CONTROL_SOCKET (common after a devserver restart). Say that
        // instead of surfacing a raw connect trace for a path the user never
        // set by hand.
        if matches!(
            err.kind(),
            std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
        ) {
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
    })
}

/// Map the server's first response line to the request's outcome. Shared by
/// the one-shot and streaming paths so both surface the same typed errors.
fn first_response_outcome(response: ControlResponse) -> Result<String> {
    match response {
        ControlResponse::Ok { message } => Ok(message),
        ControlResponse::Error { message } => anyhow::bail!("{message}"),
        // The write was accepted into the asynchronous queue, but at least
        // one target had no submit encoding. Preserve its acknowledgement in
        // a typed error so only `cs terminal write` maps it to exit 69.
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

/// Connect to the control socket, write one JSON request line, and return
/// the server's reply message (or its error, surfaced as an `Err`).
/// Platform-neutral over the `transport` module.
pub async fn send_control_request(socket: &Path, request: ControlRequest) -> Result<String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let (read, mut write) = connect_control(socket).await?;
    let mut payload = serde_json::to_vec(&request).context("encoding control request")?;
    payload.push(b'\n');
    write
        .write_all(&payload)
        .await
        .context("writing control request")?;
    // Harmless on both paths: a Unix stream half-closes its write side;
    // tokio's named-pipe `poll_shutdown` is a no-op (the `\n` already frames
    // the request, so the server reads it regardless).
    write.shutdown().await.context("closing control request")?;

    let mut line = String::new();
    BufReader::new(read)
        .read_line(&mut line)
        .await
        .context("reading control response")?;
    let response: ControlResponse =
        serde_json::from_str(&line).context("decoding control response")?;
    first_response_outcome(response)
}

/// The still-open control connection behind a long-lived request
/// (`cs tunnel`). The server's ack line has already been read; the
/// connection stays up until [`TunnelSession::wait`] returns or the
/// session is dropped, and that lifetime IS the request's lifetime on the
/// server side.
#[derive(Debug)]
pub struct TunnelSession {
    /// The server's acknowledgement, already unwrapped from its
    /// [`ControlResponse`] envelope.
    pub ack: String,
    reader: tokio::io::BufReader<transport::ReadEnd>,
    // Held open, never written again: the server reads this half's EOF as
    // "the foreground command ended" and tears the tunnel down, so it must
    // live exactly as long as the session. Dropping the session (Ctrl-C
    // kills the process, or `wait` returns) is the teardown signal.
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

/// Connect, write one JSON request line WITHOUT half-closing the write
/// side, read the first response line, and hand back the still-open
/// connection. The sibling of [`send_control_request`] for requests whose
/// connection lifetime is the request's lifetime (`cs tunnel`): the server
/// treats this connection's EOF as the command ending, so the write half
/// rides inside the returned [`TunnelSession`] and is only dropped with it.
pub async fn send_control_request_streaming(
    socket: &Path,
    request: ControlRequest,
) -> Result<TunnelSession> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let (read, mut write) = connect_control(socket).await?;
    let mut payload = serde_json::to_vec(&request).context("encoding control request")?;
    payload.push(b'\n');
    write
        .write_all(&payload)
        .await
        .context("writing control request")?;

    let mut reader = BufReader::new(read);
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
    let ack = first_response_outcome(response)?;
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
        let err = open_env_from(None, Some("/tmp/chan-control.sock".into())).unwrap_err();
        assert!(err.to_string().contains("CHAN_WINDOW_ID"));

        let err = open_env_from(Some("win".into()), None).unwrap_err();
        assert!(err.to_string().contains("CHAN_CONTROL_SOCKET"));

        let env = open_env_from(
            Some(" win ".into()),
            Some(" /tmp/chan-control.sock ".into()),
        )
        .unwrap();
        assert_eq!(env.window_id, "win");
        assert_eq!(env.control_socket, PathBuf::from("/tmp/chan-control.sock"));
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

    #[cfg(unix)]
    #[tokio::test]
    async fn send_control_request_types_a_submit_refusal_for_the_69_edge() {
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
