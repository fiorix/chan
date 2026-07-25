//! Process-wide shutdown signals + idle-timeout watcher.
//!
//! The serve loop wants to react to SIGINT/SIGTERM (or Ctrl-C on Windows)
//! and to an optional idle-timeout window. Both feed a single
//! `tokio::sync::watch::Sender<bool>` that axum's `with_graceful_shutdown`
//! awaits; whichever fires first wins. The idle watcher only spawns when
//! `ServeConfig::idle_timeout` is set.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Current wall-clock unix timestamp in seconds. Saturates at 0 on
/// the impossible-but-cheap-to-handle case where the system clock
/// is set before 1970.
pub fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Spawn the idle-timeout watcher. Compares `last_activity` against
/// `now` on each tick; on a window expiry, signals shutdown.
///
/// Tick interval is `min(timeout / 4, 30s)` so short timeouts (the
/// systemd socket-activation case) get tight precision while long
/// timeouts don't burn CPU on a hot loop.
pub fn spawn_idle_watcher(
    timeout: Duration,
    last_activity: Arc<AtomicU64>,
    signal_tx: Arc<tokio::sync::watch::Sender<bool>>,
) {
    tokio::spawn(async move {
        let tick = std::cmp::min(timeout / 4, Duration::from_secs(30)).max(Duration::from_secs(1));
        let timeout_secs = timeout.as_secs().max(1);
        loop {
            tokio::time::sleep(tick).await;
            let last = last_activity.load(Ordering::Relaxed);
            let now = now_unix_secs();
            if now.saturating_sub(last) >= timeout_secs {
                eprintln!("chan: idle for {timeout_secs}s; shutting down");
                let _ = signal_tx.send(true);
                return;
            }
        }
    });
}

/// Spawn a SIGINT / SIGTERM (unix) or Ctrl-C (windows) watcher that
/// signals shutdown when the first signal arrives. Subsequent signals
/// are ignored; the runtime cleans up on return from `serve`.
pub fn spawn_signal_watcher(signal_tx: Arc<tokio::sync::watch::Sender<bool>>) {
    tokio::spawn(async move {
        wait_for_signal().await;
        eprintln!("chan: signal received; shutting down");
        let _ = signal_tx.send(true);
    });
}

#[cfg(unix)]
async fn wait_for_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut sigterm = match signal(SignalKind::terminate()) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("failed to install SIGTERM handler: {e}");
            // Fall back to SIGINT only.
            let _ = tokio::signal::ctrl_c().await;
            return;
        }
    };
    let ctrl_c = tokio::signal::ctrl_c();
    tokio::select! {
        _ = sigterm.recv() => {}
        _ = ctrl_c => {}
    }
}

#[cfg(not(unix))]
async fn wait_for_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

/// Hard deadline for the graceful drain after the shutdown signal fires.
/// Long-lived WebSocket subscribers never close on their own, so axum's
/// drain alone could hang forever; past this window the serve loop forces
/// the return and tokio drops the in-flight tasks.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(10);

/// Serve `app` on `listener`, draining gracefully on SIGINT/SIGTERM with a
/// [`SHUTDOWN_GRACE`] hard deadline.
///
/// Single-sources the shutdown wiring the local `serve()` and the headless
/// `chan devserver` share: spawn the signal watcher feeding `signal_tx`, hand
/// axum's `with_graceful_shutdown` a receiver, and race the drain against the
/// deadline so a never-closing WebSocket cannot wedge the exit. Callers that
/// also want an idle-timeout watcher or a reindex-cancel side task spawn those
/// on the same `signal_tx` before calling this.
pub async fn graceful_serve(
    listener: tokio::net::TcpListener,
    app: axum::Router,
    signal_tx: Arc<tokio::sync::watch::Sender<bool>>,
) -> std::io::Result<()> {
    graceful_serve_with_grace(listener, app, signal_tx, SHUTDOWN_GRACE).await
}

/// [`graceful_serve`] with an explicit grace window, so a test can drive the
/// deadline arm without waiting the production [`SHUTDOWN_GRACE`].
async fn graceful_serve_with_grace(
    listener: tokio::net::TcpListener,
    app: axum::Router,
    signal_tx: Arc<tokio::sync::watch::Sender<bool>>,
    grace: Duration,
) -> std::io::Result<()> {
    spawn_signal_watcher(signal_tx.clone());
    let mut signal_rx = signal_tx.subscribe();

    let mut graceful_rx = signal_rx.clone();
    let server_future = axum::serve(listener, app).with_graceful_shutdown(async move {
        let _ = graceful_rx.changed().await;
    });

    tokio::select! {
        res = server_future => res,
        _ = async move {
            let _ = signal_rx.changed().await;
            tokio::time::sleep(grace).await;
        } => {
            eprintln!("chan: graceful shutdown exceeded {grace:?}; forcing exit");
            force_exit_after_grace()
        }
    }
}

/// What the [`graceful_serve_with_grace`] deadline arm does after the drain
/// exceeds the grace window.
///
/// On Windows, returning here only drops the `axum::serve` future; under a
/// still-running runtime (the tunnel / reindex side tasks, a wedged ConPTY
/// read) the OS does not always release the listen socket synchronously, so the
/// port keeps answering after the deadline -- and there is no SIGTERM to force a
/// second teardown as on unix. Make the "forcing exit" promise literal. Safe:
/// HTTP already drained via axum's graceful shutdown, the control socket is a
/// named pipe the OS reclaims, and the unix `Drop`-unlinks are `#[cfg(unix)]`.
#[cfg(windows)]
fn force_exit_after_grace() -> std::io::Result<()> {
    std::process::exit(0)
}

/// On unix the runtime teardown on return already releases the listener, and a
/// second SIGINT/SIGTERM force-kills if anything wedges -- so just return.
#[cfg(not(windows))]
fn force_exit_after_grace() -> std::io::Result<()> {
    Ok(())
}

/// Install the shutdown-signal watcher and block until the first signal fires,
/// for a foreground server with NO local TCP listener (the tunnel-only
/// `chan devserver`). There is nothing to drain -- the tunnel task races its own
/// reconnect loop against the same `signal_tx` and stops when it flips -- so this
/// just spawns the watcher and awaits it. Callers that spawn a tunnel /
/// reindex-cancel side task on `signal_tx` do so before calling this.
pub async fn graceful_wait(signal_tx: Arc<tokio::sync::watch::Sender<bool>>) {
    spawn_signal_watcher(signal_tx.clone());
    let mut signal_rx = signal_tx.subscribe();
    let _ = signal_rx.changed().await;
}

#[cfg(test)]
#[cfg_attr(not(target_os = "linux"), allow(unused_imports, dead_code))]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Instant;
    use tokio::io::AsyncWriteExt;

    /// The no-listener path returns as soon as the shutdown signal fires.
    #[tokio::test]
    async fn graceful_wait_returns_when_signalled() {
        let signal_tx = Arc::new(tokio::sync::watch::channel(false).0);
        let wait = tokio::spawn(graceful_wait(signal_tx.clone()));
        // Let the watcher subscribe, then signal shutdown.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let _ = signal_tx.send(true);
        tokio::time::timeout(Duration::from_secs(5), wait)
            .await
            .expect("graceful_wait returned before the timeout")
            .expect("wait task joins");
    }

    /// With no connections in flight, signalling shutdown lets axum drain
    /// at once, so the call returns well inside the grace window.
    #[tokio::test]
    async fn graceful_serve_returns_promptly_when_signalled() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let app = axum::Router::new();
        let signal_tx = Arc::new(tokio::sync::watch::channel(false).0);
        let serve = tokio::spawn(graceful_serve_with_grace(
            listener,
            app,
            signal_tx.clone(),
            Duration::from_secs(10),
        ));
        // Let the accept loop start, then signal.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let _ = signal_tx.send(true);
        let res = tokio::time::timeout(Duration::from_secs(5), serve)
            .await
            .expect("graceful_serve returned before the timeout")
            .expect("serve task joins");
        assert!(res.is_ok());
    }

    /// An in-flight request that never finishes keeps axum's drain pending,
    /// so the deadline arm is what returns. A 100ms grace proves the path
    /// without a 10s test; the elapsed assertion proves the deadline (not the
    /// server) arm fired.
    ///
    /// Unix-only: on Windows the deadline arm calls `std::process::exit(0)`
    /// ([`force_exit_after_grace`]), which would terminate the whole test
    /// binary rather than return -- so the "returns Ok after the grace"
    /// assertion is meaningless there.
    #[cfg(not(windows))]
    #[tokio::test]
    async fn graceful_serve_force_exits_after_grace_deadline() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();

        // A handler that signals once it is running, then hangs far longer
        // than the grace. The oneshot makes "request is in flight" certain,
        // so the deadline arm is deterministically the one that fires.
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel::<()>();
        let entered = Arc::new(Mutex::new(Some(entered_tx)));
        let app = axum::Router::new().route(
            "/hang",
            axum::routing::get(move || {
                let entered = entered.clone();
                async move {
                    if let Some(tx) = entered.lock().unwrap().take() {
                        let _ = tx.send(());
                    }
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    "unreachable"
                }
            }),
        );

        let grace = Duration::from_millis(100);
        let signal_tx = Arc::new(tokio::sync::watch::channel(false).0);
        let serve = tokio::spawn(graceful_serve_with_grace(
            listener,
            app,
            signal_tx.clone(),
            grace,
        ));

        // Fire the request and wait until the handler is actually running.
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        stream
            .write_all(b"GET /hang HTTP/1.1\r\nHost: x\r\n\r\n")
            .await
            .unwrap();
        entered_rx.await.expect("handler entered");

        let started = Instant::now();
        let _ = signal_tx.send(true);
        let res = tokio::time::timeout(Duration::from_secs(3), serve)
            .await
            .expect("force-exit returned before the timeout")
            .expect("serve task joins");
        assert!(res.is_ok());
        // Server arm would return near-instantly; the deadline arm waits the
        // full grace before forcing the exit.
        assert!(
            started.elapsed() >= Duration::from_millis(80),
            "expected the deadline arm to fire after the grace, elapsed {:?}",
            started.elapsed()
        );
    }
}
