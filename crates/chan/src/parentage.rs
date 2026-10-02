use std::path::{Path, PathBuf};
use std::time::Duration;

/// The kind of chan instance that spawned the shell `chan serve` runs in,
/// resolved from `$CHAN_CONTROL_SOCKET`. Drives the no-flag default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Parentage {
    /// A chan-desktop terminal: its control socket answers `Desktop`.
    Desktop,
    /// A `chan devserver` terminal: its control socket answers `Devserver`.
    Devserver { pid: u32 },
    /// No chan parent detected (a plain shell, not chan-spawned), an
    /// unreachable holder, or a standalone serve -- the load-bearing
    /// "undetectable -> standalone" case.
    None,
}

/// The chan control socket exported into a chan-spawned terminal
/// (`$CHAN_CONTROL_SOCKET`), trimmed and non-empty, or `None` outside a chan
/// session. Its mere presence marks "some chan context" even when the holder
/// cannot be identified.
pub(super) fn chan_control_socket() -> Option<String> {
    std::env::var("CHAN_CONTROL_SOCKET")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Overall bound on the parentage probe's `Identify` round-trip. A holder that
/// accepts the connection but never replies must not hang `chan serve` (which
/// then goes on to run a resident server -- this is the only deadline, never a
/// command-wide one). Sized to the connect+read budget the desktop / devserver
/// handoffs use.
const PARENTAGE_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// Resolve the kind of chan instance that spawned this shell by an `Identify`
/// round-trip on `$CHAN_CONTROL_SOCKET` -- the same control-socket /
/// serving-kind machinery `chan ps` uses. A chan-spawned terminal exports
/// that socket (`terminal_sessions`); a desktop shell points at the desktop's
/// embedded server, a devserver shell at the devserver. An absent socket (a
/// plain shell), an unreachable / wedged holder, or a `standalone` kind all
/// resolve to [`Parentage::None`].
pub(super) async fn detect_parentage() -> Parentage {
    match chan_control_socket() {
        Some(socket) => probe_parentage(&PathBuf::from(socket), PARENTAGE_PROBE_TIMEOUT).await,
        None => Parentage::None,
    }
}

/// Identify the serving kind behind `socket` with a `timeout`-bounded
/// `Identify` round-trip. A wedged holder (accepts but never replies), a
/// connect failure, a read error, or a non-desktop/devserver reply all resolve
/// to [`Parentage::None`] so a stale / wedged socket cannot hang `chan serve`.
/// `timeout` is injectable so the bound is unit-testable.
async fn probe_parentage(socket: &Path, timeout: Duration) -> Parentage {
    let identify = chan_shell::send_control_request(socket, chan_shell::ControlRequest::Identify);
    let Ok(Ok(message)) = tokio::time::timeout(timeout, identify).await else {
        return Parentage::None;
    };
    match serde_json::from_str::<chan_shell::Identity>(&message) {
        Ok(chan_shell::Identity {
            kind: chan_shell::ServeKind::Desktop,
            ..
        }) => Parentage::Desktop,
        Ok(chan_shell::Identity {
            kind: chan_shell::ServeKind::Devserver,
            pid,
            ..
        }) => Parentage::Devserver { pid },
        // A standalone holder, or a reply we cannot parse: not a context that
        // changes the default.
        _ => Parentage::None,
    }
}

/// True when this CLI runs inside a chan terminal that a `chan devserver`
/// serves -- `chan devserver register {url}` would otherwise register a devserver into a
/// devserver, which the registry (a desktop-config concept) does not nest.
/// Shares [`detect_parentage`]'s `Identify` round-trip on
/// `$CHAN_CONTROL_SOCKET`; an absent socket / unreachable holder / any other
/// serving kind ⇒ not a devserver context (so a plain shell or a desktop
/// terminal proceeds to the handoff).
pub(super) async fn in_devserver_context() -> bool {
    matches!(detect_parentage().await, Parentage::Devserver { .. })
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn probe_parentage_times_out_on_a_wedged_holder() {
        use tokio::net::UnixListener;
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("hung.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        // Accept the connection but never reply: the probe must elapse to None
        // rather than hang `chan serve`.
        let _accept = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                // Hold the stream open without writing a response.
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                drop(stream);
            }
        });
        let start = std::time::Instant::now();
        let p = probe_parentage(&sock, std::time::Duration::from_millis(150)).await;
        assert_eq!(p, Parentage::None);
        assert!(
            start.elapsed() < std::time::Duration::from_secs(2),
            "probe must give up promptly, took {:?}",
            start.elapsed()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn probe_parentage_none_when_no_listener() {
        // A path with no listener: the connect fails fast -> None, no hang.
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("nope.sock");
        assert_eq!(
            probe_parentage(&sock, std::time::Duration::from_secs(3)).await,
            Parentage::None
        );
    }
}
