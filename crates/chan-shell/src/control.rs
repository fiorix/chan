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

/// Connect to the control socket, write one JSON request line, and return
/// the server's reply message (or its error, surfaced as an `Err`).
/// Platform-neutral over the `transport` module.
pub async fn send_control_request(socket: &Path, request: ControlRequest) -> Result<String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let (read, mut write) = transport::connect(socket).await.map_err(|err| {
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
    })?;
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
        // survey --timeout`, or a `cs copy` / `cs paste` clipboard
        // round-trip). Surface it as a typed error the dispatch edge
        // downcasts to a dedicated exit code (124), NOT the generic bail
        // (exit 1), so a timeout is never confused with a real failure.
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

/// The `cs` control client's transport module -- the only `#[cfg]`-split
/// surface. unix connects a `UnixStream`; windows opens a
/// `tokio::net::windows::named_pipe` client. Both yield read/write halves
/// the line-framed round-trip above drives identically.
mod transport {
    use std::path::Path;

    #[cfg(unix)]
    pub async fn connect(
        socket: &Path,
    ) -> std::io::Result<(
        tokio::net::unix::OwnedReadHalf,
        tokio::net::unix::OwnedWriteHalf,
    )> {
        let stream = tokio::net::UnixStream::connect(socket).await?;
        Ok(stream.into_split())
    }

    #[cfg(windows)]
    pub async fn connect(
        socket: &Path,
    ) -> std::io::Result<(
        tokio::io::ReadHalf<tokio::net::windows::named_pipe::NamedPipeClient>,
        tokio::io::WriteHalf<tokio::net::windows::named_pipe::NamedPipeClient>,
    )> {
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
