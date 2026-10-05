use std::net::SocketAddr;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};

use crate::devserver::persisted::local_devserver_dial_addr;

/// One bounded `/api/health` probe; any non-2xx, transport error, or timeout
/// is a miss.
pub(crate) async fn health_ok(client: &reqwest::Client, url: &str, timeout: Duration) -> bool {
    match tokio::time::timeout(timeout, client.get(url).send()).await {
        Ok(Ok(resp)) => resp.status().is_success(),
        _ => false,
    }
}

fn devserver_refusal(status: reqwest::StatusCode, body: &str, fallback: String) -> String {
    let Ok(body) = serde_json::from_str::<serde_json::Value>(body) else {
        return fallback;
    };
    match body
        .get("error")
        .and_then(serde_json::Value::as_str)
        .filter(|sentence| !sentence.is_empty())
    {
        Some(sentence) => format!("HTTP {status}: {sentence}"),
        None => fallback,
    }
}

/// POST the drain endpoint: every terminal session is closed and the child
/// processes waited on before this returns Ok. Err carries the reason the
/// drain could not be confirmed (no token, connect failure, timeout, or
/// lingering children); callers decide how destructive to be about it.
pub(super) async fn drain_devserver_terminals(addr: SocketAddr) -> std::result::Result<(), String> {
    let Some(token) = chan_server::persisted_devserver_token() else {
        return Err("could not read the devserver token".to_string());
    };
    drain_devserver_terminals_with_token(addr, &token).await
}

async fn drain_devserver_terminals_with_token(
    addr: SocketAddr,
    token: &str,
) -> std::result::Result<(), String> {
    let url = format!("http://{addr}/api/devserver/terminal-sessions/drain");
    let client = reqwest::Client::new();
    let request = client.post(&url).bearer_auth(token).send();
    // The server-side child wait is bounded at 5s; leave headroom.
    let response = match tokio::time::timeout(Duration::from_secs(10), request).await {
        Ok(Ok(response)) => response,
        Ok(Err(e)) => return Err(format!("request failed: {e}")),
        Err(_) => return Err("request timed out".to_string()),
    };
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(devserver_refusal(
            status,
            &body,
            format!("HTTP {status}: {body}"),
        ));
    }
    let drained: chan_server::devserver_api::DrainedTerminals = response
        .json()
        .await
        .map_err(|e| format!("parsing drain response: {e}"))?;
    eprintln!(
        "chan devserver: drained {} terminal session(s) ({} child process(es) confirmed dead)",
        drained.closed, drained.dead
    );
    if !drained.lingering.is_empty() {
        return Err(format!(
            "{} child process(es) still running: {:?}",
            drained.lingering.len(),
            drained.lingering
        ));
    }
    Ok(())
}

/// `chan devserver rotate-token`: re-mint the devserver bearer. Prefer
/// rotating THROUGH the running server's management API so the old bearer
/// stops authorizing immediately (the suspected-leak response); fall back
/// to rewriting the persisted config when nothing answers, which a
/// devserver still running elsewhere only picks up at its next restart.
/// Either way the new `CHAN_DEVSERVER_TOKEN=` marker and `/?t=` URL are
/// printed: the marker is the scrapers' distribution channel, and a
/// rotation that does not re-emit it strands them on a dead token.
pub(super) async fn cmd_rotate_devserver_token() -> Result<()> {
    let Some(current) = chan_server::persisted_devserver_token() else {
        anyhow::bail!(
            "chan devserver rotate-token: no devserver config with a token \
             found (~/.chan/devserver/config.json); start a devserver first"
        );
    };
    let dial = local_devserver_dial_addr();
    if let Some(addr) = dial {
        if let Some(rotated) = rotate_devserver_token_at(addr, &current).await? {
            eprintln!("chan devserver: token rotated; the old bearer no longer authorizes");
            print!("{}", token_marker_output(Some(addr), &rotated.token));
            return Ok(());
        }
    }
    match chan_server::rotate_persisted_devserver_token()
        .context("rewriting ~/.chan/devserver/config.json")?
    {
        Some(token) => {
            eprintln!(
                "chan devserver: NOTE: no running devserver answered; rotated the \
                 persisted token only -- a devserver still running elsewhere keeps \
                 accepting its old token until it restarts"
            );
            print!("{}", token_marker_output(dial, &token));
            Ok(())
        }
        None => anyhow::bail!(
            "chan devserver rotate-token: no devserver config with a token \
             found (~/.chan/devserver/config.json); start a devserver first"
        ),
    }
}

async fn rotate_devserver_token_at(
    addr: SocketAddr,
    current: &str,
) -> Result<Option<chan_server::devserver_api::RotatedToken>> {
    let url = format!("http://{addr}/api/devserver/rotate-token");
    let client = reqwest::Client::new();
    let request = client.post(&url).bearer_auth(current).send();
    match tokio::time::timeout(Duration::from_secs(5), request).await {
        Ok(Ok(response)) if response.status().is_success() => {
            let rotated = response
                .json()
                .await
                .context("parsing the rotate-token response")?;
            Ok(Some(rotated))
        }
        Ok(Ok(response)) if response.status() == reqwest::StatusCode::UNAUTHORIZED => {
            anyhow::bail!(
                "chan devserver rotate-token: the running devserver rejected the \
                 persisted token (401): its in-memory token and \
                 ~/.chan/devserver/config.json disagree. Restart the devserver, \
                 then rotate again."
            );
        }
        Ok(Ok(response)) => {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            let refusal = devserver_refusal(status, &body, format!("HTTP {status}"));
            anyhow::bail!("chan devserver rotate-token: the running devserver answered {refusal}");
        }
        // Nothing listening (or too slow): rotate the file instead.
        Ok(Err(_)) | Err(_) => Ok(None),
    }
}

/// The stdout block every supervisor and rotation prints: a launch URL when
/// the bound address is known and has a nonzero port, then the locked marker.
/// The desktop reads the last marker, and a person can open the line above it.
fn token_marker_output(addr: Option<SocketAddr>, token: &str) -> String {
    let mut out = String::new();
    if let Some(addr) = addr.filter(|addr| addr.port() != 0) {
        out.push_str(&super::devserver_launch_url_line(addr, token));
    }
    out.push_str(&format!("{}{token}\n", chan_server::DEVSERVER_TOKEN_MARKER));
    out
}

/// How long the supervisor waits for the service's bearer token to land in the
/// persisted config before giving up. The generated systemd unit uses
/// `Type=notify`: a listening service records its port before `READY=1`.
/// Polling bounds any delay before the persisted token becomes readable.
pub(crate) const DEVSERVER_TOKEN_WAIT: Duration = Duration::from_secs(5);

/// Resolve the persisted devserver bearer token, polling `read` until it yields
/// a token or `timeout` elapses. Injecting the reader keeps the poll/timeout
/// contract testable without a real config on disk.
async fn resolve_devserver_token(
    read: impl Fn() -> Option<String>,
    timeout: Duration,
) -> Option<String> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(token) = read() {
            return Some(token);
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Build the launch URL, when the running address is known, before the locked
/// `CHAN_DEVSERVER_TOKEN=` marker, reading the token from the persisted 0600
/// config. The marker stays last for the desktop scraper, while the line before
/// it opens the service in a browser. Token delivery must not depend on this
/// user being able to read the unit journal: a uid below `SYS_UID_MAX`, or a
/// user outside the `systemd-journal`/`adm` groups cannot read it. The desktop
/// control terminal scrapes this marker to reconnect; the journal follow is
/// only human-facing log streaming. A duplicate marker from a readable
/// journal is harmless because the scraper takes the last one.
///
/// Errors when the token never lands within `timeout`. The point of
/// `--service=systemd` supervision is to hand a client a token to reconnect
/// with; an active unit whose token cannot be surfaced is unreachable, so
/// fail loud rather than babysit it. The unit stays running, so a later
/// re-attach can recover it.
async fn supervised_token_output(
    addr: Option<SocketAddr>,
    read: impl Fn() -> Option<String>,
    timeout: Duration,
) -> Result<String> {
    match resolve_devserver_token(read, timeout).await {
        Some(token) => Ok(token_marker_output(addr, &token)),
        None => anyhow::bail!(
            "chan devserver: the supervised service is active but its bearer \
             token could not be read from ~/.chan/devserver/config.json; the \
             control terminal cannot authenticate to it"
        ),
    }
}

/// Print the launch URL when the bound address is known, then the marker,
/// directly from the supervisor so its control terminal can reconnect even
/// when the service's own log stream is unavailable.
pub(crate) async fn emit_devserver_token_marker(
    addr: Option<SocketAddr>,
    timeout: Duration,
) -> Result<()> {
    print!(
        "{}",
        supervised_token_output(addr, chan_server::persisted_devserver_token, timeout).await?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn devserver_refusal_peer(
        status: u16,
        body: &str,
        path: &str,
    ) -> (SocketAddr, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let body = body.to_owned();
        let path = path.to_owned();
        let peer = tokio::spawn(async move {
            tokio::time::timeout(Duration::from_secs(5), async {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buf = [0; 1024];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = stream.read(&mut buf).await.unwrap();
                    assert_ne!(n, 0, "client sends a complete request");
                    request.extend_from_slice(&buf[..n]);
                }
                let request = String::from_utf8(request).unwrap();
                assert!(request.starts_with(&format!("POST {path} HTTP/1.1\r\n")));
                assert!(request.to_ascii_lowercase().contains("authorization: bearer test-token\r\n"));
                let response = format!(
                    "HTTP/1.1 {status} Refused\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            })
            .await
            .expect("client and refusal peer finish");
        });
        (addr, peer)
    }

    fn devserver_refusal_bodies() -> Vec<(String, Option<String>)> {
        let mut cases = vec![
            ("plain refusal\n".to_owned(), None),
            (String::new(), None),
            (r#"{"message":"not an envelope"}"#.to_owned(), None),
            (r#"["not an envelope"]"#.to_owned(), None),
            (r#"{"error":42}"#.to_owned(), None),
            (r#"{"error":""}"#.to_owned(), None),
            (r#"{"error":"unfinished"#.to_owned(), None),
        ];
        for sentence in ["drain refused", "  keep this sentence\n", &"x".repeat(600)] {
            for code in [None, Some("operation_refused")] {
                let mut body = serde_json::json!({ "error": sentence });
                if let Some(code) = code {
                    body["code"] = code.into();
                }
                cases.push((body.to_string(), Some(sentence.to_owned())));
            }
        }
        cases
    }

    #[tokio::test]
    async fn drain_devserver_refusal_keeps_the_sentence_or_raw_body() {
        for (body, sentence) in devserver_refusal_bodies() {
            let (addr, peer) =
                devserver_refusal_peer(401, &body, "/api/devserver/terminal-sessions/drain").await;
            let result = drain_devserver_terminals_with_token(addr, "test-token").await;
            peer.await.unwrap();
            assert_eq!(
                result.unwrap_err(),
                format!(
                    "HTTP 401 Unauthorized: {}",
                    sentence.as_deref().unwrap_or(&body)
                ),
                "drain refusal body {body:?}"
            );
        }
    }

    #[tokio::test]
    async fn rotate_devserver_refusal_keeps_the_sentence_or_status() {
        let (addr, peer) = devserver_refusal_peer(
            401,
            r#"{"error":"a server sentence","code":"unauthorized"}"#,
            "/api/devserver/rotate-token",
        )
        .await;
        let result = rotate_devserver_token_at(addr, "test-token").await;
        peer.await.unwrap();
        assert_eq!(
            result.unwrap_err().to_string(),
            "chan devserver rotate-token: the running devserver rejected the \
             persisted token (401): its in-memory token and \
             ~/.chan/devserver/config.json disagree. Restart the devserver, \
             then rotate again.",
            "rotate-token 401 keeps the recovery instructions"
        );

        for (body, sentence) in devserver_refusal_bodies() {
            let (addr, peer) =
                devserver_refusal_peer(500, &body, "/api/devserver/rotate-token").await;
            let result = rotate_devserver_token_at(addr, "test-token").await;
            peer.await.unwrap();
            let suffix = sentence
                .map(|sentence| format!(": {sentence}"))
                .unwrap_or_default();
            assert_eq!(
                result.unwrap_err().to_string(),
                format!("chan devserver rotate-token: the running devserver answered HTTP 500 Internal Server Error{suffix}"),
                "rotate-token refusal body {body:?}"
            );
        }
    }

    /// A rotation MUST re-emit the locked marker line -- it is the desktop
    /// control terminal's only distribution channel -- and the `/?t=` URL
    /// when the serve address is known. Red mutation: drop either line
    /// from `token_marker_output`.
    #[test]
    fn rotated_token_output_reemits_marker_and_url() {
        let addr: SocketAddr = "127.0.0.1:8787".parse().unwrap();
        let out = token_marker_output(Some(addr), "tok-new");
        assert!(out.contains("http://127.0.0.1:8787/?t=tok-new"), "{out}");
        assert!(out.contains("CHAN_DEVSERVER_TOKEN=tok-new"), "{out}");
        // Address unknown: the marker line still goes out.
        let out = token_marker_output(None, "tok-2");
        assert!(!out.contains("listening"), "{out}");
        assert!(out.contains("CHAN_DEVSERVER_TOKEN=tok-2"), "{out}");
    }

    #[tokio::test]
    async fn a_supervised_devserver_prints_the_launch_url_before_the_marker() {
        let addr = "127.0.0.1:8787".parse().unwrap();
        let block =
            supervised_token_output(Some(addr), || Some("tok".into()), Duration::from_secs(1))
                .await
                .unwrap();
        // The desktop's control terminal consumes this two-line block and
        // takes the final marker when a token is re-emitted.
        assert_eq!(
            block.lines().last(),
            Some("CHAN_DEVSERVER_TOKEN=tok"),
            "the marker is not the block's last line: {block:?}"
        );
        assert_eq!(
            block,
            "chan devserver: listening on http://127.0.0.1:8787/?t=tok\nCHAN_DEVSERVER_TOKEN=tok\n",
            "the supervisor's block lacks the launch URL line: {block:?}"
        );
        let block = supervised_token_output(None, || Some("tok".into()), Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(
            block, "CHAN_DEVSERVER_TOKEN=tok\n",
            "with no address the marker did not go out alone: {block:?}"
        );
        let zero: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let block = token_marker_output(Some(zero), "tok");
        assert_eq!(
            block, "CHAN_DEVSERVER_TOKEN=tok\n",
            "a port-zero address emitted a launch URL: {block:?}"
        );
    }

    #[tokio::test]
    async fn resolve_devserver_token_returns_first_available() {
        // The common case: the token is already on disk, so the first read wins
        // and no polling happens.
        let token =
            resolve_devserver_token(|| Some("tok_abc".to_string()), Duration::from_secs(5)).await;
        assert_eq!(token.as_deref(), Some("tok_abc"));
    }

    #[tokio::test]
    async fn resolve_devserver_token_polls_until_the_token_lands() {
        // The fresh `Type=simple` race: the unit is active but the service has
        // not persisted yet, so the first reads miss and a later one succeeds.
        let calls = std::cell::Cell::new(0u32);
        let token = resolve_devserver_token(
            || {
                let n = calls.get() + 1;
                calls.set(n);
                (n >= 3).then(|| "tok_late".to_string())
            },
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(token.as_deref(), Some("tok_late"));
        assert!(
            calls.get() >= 3,
            "expected polling, saw {} reads",
            calls.get()
        );
    }

    #[tokio::test]
    async fn resolve_devserver_token_gives_up_after_timeout() {
        // A token that never lands resolves to None at the deadline, which the
        // caller turns into a loud failure rather than supervising blind.
        let token = resolve_devserver_token(|| None, Duration::from_millis(150)).await;
        assert_eq!(token, None);
    }
}
