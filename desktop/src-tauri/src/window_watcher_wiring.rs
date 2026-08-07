//! Binds the surface-agnostic window-watcher core ([`crate::window_watcher`])
//! to the live desktop: the local library's in-process window feed and the
//! Tauri native-window surface.
//!
//! [`spawn_local_window_watcher`] runs one [`watch_loop`] for the embedded
//! local library (`"local"`). The feed snapshots
//! [`EmbeddedServer::assemble_window_records`](crate::embedded::EmbeddedServer::assemble_window_records)
//! and wakes on its aggregate change `Notify`; the surface opens windows
//! through [`serve::open_watched_local_window`] (the shared SPA builder) and
//! closes them by destroying the Tauri window. The watcher is inert until a
//! local window is minted (an empty registry reconciles to nothing); routing
//! the window-creation paths through the registry mint makes it the SOLE driver
//! of local windows, so reconnect/relaunch cannot duplicate windows and is
//! unreachable by construction.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chan_server::{WindowRecord, WindowSet};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{watch, Notify};

use crate::devserver::DevserverConn;
use crate::window_watcher::{
    native_label, watch_loop, NativeSurface, PendingDeleteAttempt, PendingDeleteState,
    WatchLoopStop, WatcherViewState, WindowFeed,
};
use crate::{serve, AppState};

/// Library id of the embedded local-disk library.
const LOCAL_LIBRARY_ID: &str = "local";

/// How a devserver watcher should stop. Disconnect closes that devserver's
/// native windows; token-rotation handoff retires only the old watcher because a
/// fresh watcher will refresh the same labels in place.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DevserverWatcherStop {
    Running,
    RetireKeepWindows,
    CloseWindows,
}

impl DevserverWatcherStop {
    pub(crate) fn is_stopped(self) -> bool {
        self != Self::Running
    }

    fn watch_loop_stop(self) -> Option<WatchLoopStop> {
        match self {
            Self::Running => None,
            Self::RetireKeepWindows => Some(WatchLoopStop::KeepWindows),
            Self::CloseWindows => Some(WatchLoopStop::CloseWindows),
        }
    }
}

/// How a watched window opens its SPA -- the only library-specific bit of the
/// otherwise surface-agnostic [`TauriNativeSurface`]. Local windows load the
/// in-process loopback library; remote windows load a connected devserver's SPA
/// at `host:port` (through the connecting screen, since the remote may be down).
enum WindowOpener {
    Local {
        addr: SocketAddr,
    },
    Remote {
        /// The devserver this watcher serves; navigation URLs resolve through
        /// it at open/retarget time (`devserver::window_navigation_url`).
        conn: crate::devserver::DevserverConn,
    },
}

impl WindowOpener {
    fn is_remote(&self) -> bool {
        matches!(self, WindowOpener::Remote { .. })
    }

    fn is_gateway(&self) -> bool {
        matches!(self, WindowOpener::Remote { conn } if conn.gateway.is_some())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RemoteLaunchKey {
    prefix: String,
    /// Raw-tunnel devservers only: their per-tenant token is stable, and a
    /// rotation (devserver restart) invalidates the loaded page, so it forces
    /// a retarget. Gateway windows blank this field -- their entry credential
    /// is single-use and minted fresh per navigation, and the page's standing
    /// auth is the opaque devserver-gate cookie, so a re-mint must
    /// NOT retarget (that churn was a per-feed-push reload loop).
    token: String,
    kind: chan_server::WindowKind,
    workspace_path: Option<String>,
    ordinal: u32,
}

impl RemoteLaunchKey {
    fn from_record(record: &WindowRecord, gateway: bool) -> Self {
        Self {
            prefix: record.prefix.clone(),
            token: if gateway {
                String::new()
            } else {
                record.token.clone()
            },
            kind: record.kind,
            workspace_path: record.workspace_path.clone(),
            ordinal: record.ordinal,
        }
    }
}

/// The local library's window-set feed, read in-process from the embedded host.
struct LocalWindowFeed {
    state: Arc<AppState>,
    /// The aggregate change signal, captured once at spawn (a stable `Arc` the
    /// host re-hands on every call, so capturing it once is sufficient).
    change: Arc<Notify>,
}

impl WindowFeed for LocalWindowFeed {
    fn snapshot(&self) -> Vec<WindowRecord> {
        // LOCAL records only (`local_window_records`): the merged launcher set
        // includes devserver windows, but the LOCAL native watcher must only
        // reconcile LOCAL windows -- devserver windows are driven by their own
        // per-devserver watcher -- else the local reconcile would try to open
        // remote records via the local opener (and trip its same-library assert).
        self.state
            .embedded()
            .map(|embedded| embedded.local_window_records())
            .unwrap_or_default()
    }

    fn change_notify(&self) -> Arc<Notify> {
        self.change.clone()
    }
}

/// The Tauri native-window surface: opens windows via the shared SPA builder,
/// closes them by destroying the OS window, and enumerates the open native
/// windows for a library by their `{library_id}::` label prefix.
struct TauriNativeSurface {
    app: AppHandle,
    opener: WindowOpener,
    /// Labels whose build was dispatched to the Tauri main thread but may not yet
    /// be in `webview_windows()` -- the build is async (`open` returns before
    /// `build_workspace_window`'s `run_on_main_thread` closure runs). Tracked and
    /// folded into `open_labels` so a reconcile in the dispatch→build gap treats
    /// the window as already open and does NOT double-`open` the same label (the
    /// TOCTOU that produced "webview label already exists" + a stuck/duplicate
    /// window during the multi-notify boot burst). Self-cleaning: a label that
    /// has landed in `webview_windows` is dropped from the set.
    in_flight: Arc<Mutex<HashSet<String>>>,
    /// Last launch-only state used for remote devserver windows. A devserver
    /// restart keeps the same `{library_id}::{window_id}` label but rotates the
    /// tenant token in the URL, so an existing webview may need an in-place
    /// rebuild even though it is already "open" to the reconciler.
    remote_launches: Arc<Mutex<HashMap<String, RemoteLaunchKey>>>,
    /// The watch loop's change signal (remote watchers only): settled
    /// navigation tasks nudge it so a follow-up reconcile validates their
    /// outcome, and failed ones nudge it after a delay as a bounded retry
    /// driver. `None` for the local watcher, whose opens have no async gap.
    nudge: Option<Arc<Notify>>,
}

impl TauriNativeSurface {
    /// Open or retarget a remote window: resolve the navigation URL (a fresh
    /// gateway entry mint, or the raw tenant URL) off the reconcile path, then
    /// build/navigate.
    ///
    /// Bookkeeping is settled around the async gap so racing reconciles stay
    /// coherent: the launch key is remembered at DISPATCH time (a reconcile
    /// during the mint sees the intended key and does not spawn a duplicate
    /// task) and rolled back on failure; the open path's in-flight marker
    /// doubles as a cancellation token (a `close()` during the mint removes
    /// it, and the task re-checks it before building, so a closed or
    /// disconnected window is never resurrected by a late build); a retarget
    /// whose webview vanished mid-gap BAILS instead of rebuilding (the close
    /// was deliberate -- reconcile owns reopening). Every settled task nudges
    /// the watch loop: immediately on success (one cheap idempotent reconcile
    /// validates the outcome against the current snapshot) and after a delay
    /// on failure (a bounded retry driver for transient mint failures, since
    /// the feed only pushes on real changes).
    fn navigate_remote(&self, record: &WindowRecord, retarget: bool) {
        const RETRY_NUDGE: Duration = Duration::from_secs(15);
        let WindowOpener::Remote { conn } = &self.opener else {
            return;
        };
        let app = self.app.clone();
        let conn = conn.clone();
        let record = record.clone();
        let gateway = self.opener.is_gateway();
        let in_flight = Arc::clone(&self.in_flight);
        let remote_launches = Arc::clone(&self.remote_launches);
        let nudge = self.nudge.clone();
        let label = native_label(&record);
        // Dispatch-time remember: refreshes during the gap compare equal and
        // skip; rolled back on failure so a retry pass can fire again.
        remote_launches.lock().unwrap().insert(
            label.clone(),
            RemoteLaunchKey::from_record(&record, gateway),
        );
        tauri::async_runtime::spawn(async move {
            let fail = |e: String| {
                remote_launches.lock().unwrap().remove(&label);
                if !retarget {
                    // Only the open path owns an in-flight marker; a failed
                    // retarget must not strip a concurrent open's marker.
                    in_flight.lock().unwrap().remove(&label);
                }
                tracing::warn!(
                    window = %record.window_id,
                    error = %e,
                    "window watcher: opening a window failed",
                );
                if let Some(nudge) = nudge.clone() {
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(RETRY_NUDGE).await;
                        nudge.notify_one();
                    });
                }
            };
            let url = match crate::devserver::window_navigation_url(&conn, &record).await {
                Ok(url) => url,
                Err(e) => return fail(e),
            };
            if let Err(e) = crate::devserver::install_gateway_webview_session(
                &app,
                &conn,
                retarget.then_some(label.as_str()),
            ) {
                return fail(e);
            }
            let result = if retarget {
                match serve::retarget_watched_remote_window(&app, &url, &record) {
                    // The webview vanished mid-gap: a close raced this
                    // retarget. Do NOT rebuild here -- if the record still
                    // wants a window, the nudged reconcile below reopens it.
                    Ok(false) => {
                        remote_launches.lock().unwrap().remove(&label);
                        if let Some(nudge) = &nudge {
                            nudge.notify_one();
                        }
                        return;
                    }
                    Ok(true) => Ok(()),
                    Err(e) => Err(e),
                }
            } else {
                // Cancellation check: a close()/disconnect during the mint
                // removed the marker; building now would resurrect a window
                // the user just closed.
                if !in_flight.lock().unwrap().contains(&label) {
                    remote_launches.lock().unwrap().remove(&label);
                    return;
                }
                serve::open_watched_remote_window(&app, &url, &conn.name, &record)
            };
            match result {
                Ok(()) => {
                    if let Some(nudge) = &nudge {
                        nudge.notify_one();
                    }
                }
                Err(e) => fail(e),
            }
        });
    }
}

impl NativeSurface for TauriNativeSurface {
    fn open_labels(&self, library_id: &str) -> HashSet<String> {
        let prefix = format!("{library_id}::");
        let mut labels: HashSet<String> = self
            .app
            .webview_windows()
            .into_keys()
            .filter(|label| label.starts_with(&prefix))
            .collect();
        // A dispatched build that has now landed in `webview_windows` is no
        // longer in-flight; drop it, then fold the still-pending ones in so the
        // reconcile sees them as open.
        let mut in_flight = self.in_flight.lock().unwrap();
        in_flight.retain(|label| !labels.contains(label));
        labels.extend(in_flight.iter().filter(|l| l.starts_with(&prefix)).cloned());
        labels
    }

    fn open(&self, record: &WindowRecord) {
        // Mark the label in-flight BEFORE dispatching the (async) build, so a
        // reconcile that runs before the build lands won't re-open it.
        let label = native_label(record);
        self.in_flight.lock().unwrap().insert(label.clone());
        match &self.opener {
            // The local builder dispatches to the Tauri main thread
            // internally, so this returns promptly.
            WindowOpener::Local { addr } => {
                if let Err(e) = serve::open_watched_local_window(&self.app, *addr, record) {
                    self.in_flight.lock().unwrap().remove(&label);
                    tracing::warn!(
                        window = %record.window_id,
                        error = %e,
                        "window watcher: opening a window failed",
                    );
                }
            }
            // Remote builds resolve their navigation URL asynchronously
            // first (a gateway mint is an HTTP round trip); the in-flight
            // marker covers the whole gap.
            WindowOpener::Remote { .. } => self.navigate_remote(record, false),
        }
    }

    fn refresh(&self, record: &WindowRecord) {
        if !self.opener.is_remote() {
            return;
        }
        let label = native_label(record);
        let next = RemoteLaunchKey::from_record(record, self.opener.is_gateway());
        let current = self.remote_launches.lock().unwrap().get(&label).cloned();
        if current.as_ref() != Some(&next) {
            self.navigate_remote(record, true);
        }
    }

    fn close(&self, label: &str) {
        // No longer in-flight (also covers a close before the build landed).
        self.in_flight.lock().unwrap().remove(label);
        self.remote_launches.lock().unwrap().remove(label);
        // Destroying a window must run on the Tauri main thread.
        let app = self.app.clone();
        let dispatch = self.app.clone();
        let label_owned = label.to_string();
        let result = dispatch.run_on_main_thread(move || {
            if let Some(window) = app.get_webview_window(&label_owned) {
                let _ = window.destroy();
            }
        });
        if let Err(e) = result {
            tracing::warn!(window = %label, error = %e, "window watcher: closing a local window failed");
        }
    }
}

/// Spawn the local library's window watcher (one [`watch_loop`] for `"local"`),
/// living for the process lifetime. A no-op when the embedded server is not up.
pub(crate) fn spawn_local_window_watcher(app: AppHandle, state: Arc<AppState>) {
    let Some(embedded) = state.embedded() else {
        tracing::warn!("local window watcher not started: embedded server unavailable");
        return;
    };
    let addr = embedded.addr();
    let change = embedded.library_change_notify();
    let feed = LocalWindowFeed {
        state: Arc::clone(&state),
        change,
    };
    let surface = TauriNativeSurface {
        app,
        opener: WindowOpener::Local { addr },
        in_flight: Arc::new(Mutex::new(HashSet::new())),
        remote_launches: Arc::new(Mutex::new(HashMap::new())),
        nudge: None,
    };
    let view = Arc::new(WatcherViewState::default());
    // Share the view state so the desktop close handlers can bury/unbury
    // through the watcher, then hand the same Arc to the loop.
    state.set_local_watcher_view(Arc::clone(&view));
    // The local library lives for the whole process, so the watcher is never
    // cancelled -- `cancel` is a future that only resolves at process exit
    // (which drops the spawned task).
    tauri::async_runtime::spawn(watch_loop(
        Some(LOCAL_LIBRARY_ID),
        feed,
        surface,
        view,
        std::future::pending::<WatchLoopStop>(),
    ));
}

/// A connected devserver's window-set feed, pushed over the
/// `GET /api/library/windows/watch` WebSocket. A background task holds the
/// latest snapshot and wakes the watcher on every push; it reconnects on a
/// dropped socket (resubscribe + the idempotent reconcile self-heals).
struct DevserverWindowFeed {
    snapshot: Arc<Mutex<Vec<WindowRecord>>>,
    change: Arc<Notify>,
}

impl WindowFeed for DevserverWindowFeed {
    fn snapshot(&self) -> Vec<WindowRecord> {
        self.snapshot.lock().unwrap().clone()
    }

    fn change_notify(&self) -> Arc<Notify> {
        self.change.clone()
    }
}

/// The raw devserver window-feed WS URL. Gateway-backed devservers use the
/// gateway proxy origin instead.
fn watch_ws_url(host: &str, port: u16) -> String {
    format!("ws://{host}:{port}/api/library/windows/watch")
}

type GatewayWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// The exact canonical external origin the gateway requires on every
/// cookie-authenticated upgrade. Shared with the reverse-tunnel sockets, which
/// ride the same hop.
pub(crate) fn gateway_ws_origin(conn: &DevserverConn) -> Result<&str, String> {
    conn.gateway
        .as_ref()
        .map(|gateway| gateway.proxy_origin.as_str())
        .ok_or_else(|| "not a gateway connection".to_string())
}

async fn gateway_ws_request(
    conn: &DevserverConn,
    path: &str,
) -> Result<
    (
        tokio_tungstenite::tungstenite::handshake::client::Request,
        String,
    ),
    String,
> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let url = crate::devserver::gateway_ws_url(conn, path)?;
    let mut request = url
        .into_client_request()
        .map_err(|e| format!("bad gateway watch url: {e}"))?;
    let cookie_header = crate::devserver::gateway_cookie_header(conn).await?;
    request.headers_mut().insert(
        "Cookie",
        cookie_header
            .clone()
            .parse()
            .map_err(|e| format!("bad gateway cookie header: {e}"))?,
    );
    request.headers_mut().insert(
        "Origin",
        gateway_ws_origin(conn)?
            .parse()
            .map_err(|e| format!("bad gateway origin header: {e}"))?,
    );
    Ok((request, cookie_header))
}

fn ws_auth_shaped(e: &tokio_tungstenite::tungstenite::Error) -> bool {
    matches!(
        e,
        tokio_tungstenite::tungstenite::Error::Http(resp)
            if matches!(resp.status().as_u16(), 401 | 404)
    )
}

async fn connect_gateway_ws(conn: &DevserverConn, path: &str) -> Result<GatewayWs, String> {
    let (request, cookie_header) = gateway_ws_request(conn, path).await?;
    match tokio_tungstenite::connect_async(request).await {
        Ok((ws, _)) => Ok(ws),
        Err(e) if ws_auth_shaped(&e) => {
            crate::devserver::refresh_gateway_session_if_current(conn, &cookie_header).await?;
            let (request, _) = gateway_ws_request(conn, path).await?;
            tokio_tungstenite::connect_async(request)
                .await
                .map(|(ws, _)| ws)
                .map_err(|e| format!("connect gateway watch after refresh: {e}"))
        }
        Err(e) => Err(format!("connect gateway watch: {e}")),
    }
}

/// Keepalive cadence for a devserver feed socket: send a WS Ping after this long
/// with no inbound frame. Well under the gateway proxy's 300s bridge idle cut, so
/// the Ping/Pong both keeps the tunnel warm and probes liveness.
const FEED_PING_INTERVAL: Duration = Duration::from_secs(30);
/// Consecutive ping intervals with NO inbound frame (not even a pong) before a
/// feed socket is declared a half-open zombie and the stream errors out.
const FEED_MAX_MISSED: u32 = 2;
/// Consecutive feed rounds that never received a frame (connect kept failing, or
/// the socket died before any data) before the devserver is marked Unreachable.
/// A round that gets a frame resets the count, so a transient drop that
/// reconnects never flips it -- only a persistent outage does.
const FEED_UNREACHABLE_AFTER: u32 = 2;

/// Stream a devserver's window-set feed into `snapshot` + wake `change` on every
/// push, reconnecting on a dropped socket until `cancel` fires. The server
/// pushes a full snapshot on connect, so a drop self-heals on the next reconcile.
///
/// Feeds go half-open silently after a laptop sleep (the gateway proxy tears the
/// bridge down at its idle cut while the machine is frozen, and no FIN reaches
/// us), so a bare `next()` would pend forever and the launcher would show a
/// stale-but-green devserver. `stream_window_feed` keepalive-pings and errors out
/// on a dead socket; this loop counts consecutive rounds that never saw a frame
/// and, past `FEED_UNREACHABLE_AFTER`, marks the devserver `Unreachable` so the
/// launcher dot is honest. The flag clears on the next frame (recovery).
async fn run_devserver_window_feed(
    id: String,
    app: AppHandle,
    conn: DevserverConn,
    snapshot: Arc<Mutex<Vec<WindowRecord>>>,
    change: Arc<Notify>,
    state: Arc<AppState>,
    mut cancel: watch::Receiver<DevserverWatcherStop>,
) {
    use std::sync::atomic::{AtomicBool, Ordering};
    const RECONNECT_BACKOFF: Duration = Duration::from_secs(2);
    // One WARN per outage window, DEBUG in between: an offline devserver is a
    // routine long-lived state, and this loop retries every 2s for the app's
    // lifetime -- unthrottled WARNs would flood stderr while saying nothing new.
    const WARN_EVERY: Duration = Duration::from_secs(5 * 60);
    let mut last_warn: Option<std::time::Instant> = None;
    let mut consecutive_failures: u32 = 0;
    loop {
        // A `watch` (not a `Notify`) so the cancel PERSISTS: a disconnect that
        // flips it while we are between selects is still seen here, not missed.
        if (*cancel.borrow_and_update()).is_stopped() {
            return;
        }
        let saw_frame = AtomicBool::new(false);
        tokio::select! {
            _ = cancel.changed() => return,
            result = stream_window_feed(&id, &app, &conn, &snapshot, &change, &state, &saw_frame) => {
                if saw_frame.load(Ordering::Relaxed) {
                    // The feed delivered at least one frame this round: healthy.
                    consecutive_failures = 0;
                } else {
                    consecutive_failures = consecutive_failures.saturating_add(1);
                    // Persistent feed failure while the connection record still
                    // exists: a green machine icon would lie (the 5s workspace poll heals
                    // on fresh TCP). Mark Unreachable + raise attention on the
                    // real flip; entry_from_devserver renders the red icon off the
                    // flag, and it clears on the next frame inside the stream.
                    if consecutive_failures >= FEED_UNREACHABLE_AFTER
                        && state.devservers.is_connected(&id)
                        && state.devserver_feed.set_unreachable(&id, true)
                    {
                        let _ = app.emit(crate::DEVSERVER_CONTROL_ATTENTION_EVENT, id.clone());
                        if let Some(embedded) = state.embedded() {
                            embedded.signal_library_change();
                        }
                    }
                }
                if let Err(e) = result {
                    // WARN (rate-limited), not debug: a dead feed means no
                    // devserver window ever materializes and the launcher
                    // list goes stale -- the whole devserver surface is dark
                    // while this loops.
                    if last_warn.is_none_or(|t| t.elapsed() >= WARN_EVERY) {
                        last_warn = Some(std::time::Instant::now());
                        tracing::warn!(
                            host = %conn.host,
                            error = %e,
                            "devserver window feed disconnected; reconnecting",
                        );
                    } else {
                        tracing::debug!(
                            host = %conn.host,
                            error = %e,
                            "devserver window feed disconnected; reconnecting",
                        );
                    }
                }
            }
        }
        if (*cancel.borrow_and_update()).is_stopped() {
            return;
        }
        tokio::select! {
            _ = cancel.changed() => return,
            _ = tokio::time::sleep(RECONNECT_BACKOFF) => {}
        }
    }
}

/// Pump a devserver feed WS with a keepalive Ping + read-deadline. `on_text` runs
/// for each text frame; a clean close returns Ok; `max_missed` consecutive
/// `ping_interval` windows with NO inbound frame -- a half-open socket that a
/// laptop sleep leaves behind -- returns Err instead of a forever-pending
/// `next()`. The interval + threshold are parameters so a unit test can drive a
/// silent mock socket (short interval) without a real Tauri app/state.
async fn keepalive_pump(
    ws: &mut GatewayWs,
    ping_interval: Duration,
    max_missed: u32,
    mut on_text: impl FnMut(&str),
) -> Result<(), String> {
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let mut missed = 0u32;
    loop {
        match tokio::time::timeout(ping_interval, ws.next()).await {
            Ok(Some(message)) => {
                missed = 0;
                match message.map_err(|e| format!("watch stream: {e}"))? {
                    Message::Text(text) => on_text(&text),
                    Message::Close(_) => break,
                    // Pong (our keepalive answered), Ping (axum auto-pongs the
                    // peer's), Binary, Frame: not data, but arriving already reset
                    // `missed` -- proof the socket is alive.
                    _ => {}
                }
            }
            Ok(None) => break,
            Err(_) => {
                // No inbound for a whole interval: send a keepalive Ping. The
                // gateway bridge forwards Ping/Pong and axum auto-pongs, so a live
                // feed answers within the next interval; `max_missed` intervals
                // with nothing inbound is a half-open zombie.
                missed += 1;
                if missed > max_missed {
                    return Err("feed idle: no frame or pong within deadline".to_string());
                }
                ws.send(Message::Ping(Vec::new().into()))
                    .await
                    .map_err(|e| format!("feed keepalive ping: {e}"))?;
            }
        }
    }
    Ok(())
}

/// Settle DELETEs already absent from a full feed snapshot, then claim one
/// retry attempt for each remaining close intent on the first snapshot of a
/// connection round. Later frames only settle state; they cannot create an
/// unbounded retry loop on a persistent 4xx.
fn pending_delete_attempts_for_feed_snapshot(
    pending: &PendingDeleteState,
    devserver_id: &str,
    windows: &[WindowRecord],
    first_snapshot: bool,
) -> Vec<PendingDeleteAttempt> {
    pending.settle_snapshot(devserver_id, windows);
    if first_snapshot {
        pending.begin_for_devserver(devserver_id)
    } else {
        Vec::new()
    }
}

/// One connection's lifetime: open the `/watch` WS, then push every `WindowSet`
/// text frame into `snapshot` + wake `change`. Raw tunnel devservers auth with a
/// bearer header; gateway devservers auth with the devserver-gate cookie.
///
/// The [`keepalive_pump`] read-deadline turns a half-open socket into an error
/// instead of a forever-pending `next()`. `saw_frame` is set on the first inbound
/// frame so the caller can tell a healthy round from a never-connected one; the
/// first frame also clears any `Unreachable` state (recovery) and announces it.
async fn stream_window_feed(
    id: &str,
    app: &AppHandle,
    conn: &DevserverConn,
    snapshot: &Arc<Mutex<Vec<WindowRecord>>>,
    change: &Arc<Notify>,
    state: &Arc<AppState>,
    saw_frame: &std::sync::atomic::AtomicBool,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut ws = if conn.gateway.is_some() {
        connect_gateway_ws(conn, "/api/library/windows/watch").await?
    } else {
        let url = watch_ws_url(&conn.host, conn.port);
        let mut request = url
            .into_client_request()
            .map_err(|e| format!("bad watch url: {e}"))?;
        request.headers_mut().insert(
            "Authorization",
            format!("Bearer {}", conn.token)
                .parse()
                .map_err(|e| format!("bad bearer header: {e}"))?,
        );
        tokio_tungstenite::connect_async(request)
            .await
            .map(|(ws, _)| ws)
            .map_err(|e| format!("connect /watch: {e}"))?
    };
    let mut saw_snapshot = false;
    keepalive_pump(&mut ws, FEED_PING_INTERVAL, FEED_MAX_MISSED, |text| {
        // Any inbound data frame means the feed is live. Mark it, and on the FIRST
        // such frame clear any Unreachable state so the launcher's red icon clears
        // the instant the feed reconnects, not at the next drop.
        if !saw_frame.swap(true, Ordering::Relaxed)
            && state.devserver_feed.set_unreachable(id, false)
        {
            let _ = app.emit(crate::DEVSERVER_CONTROL_RESTORED_EVENT, id.to_string());
            if let Some(embedded) = state.embedded() {
                embedded.signal_library_change();
            }
        }
        if let Ok(set) = serde_json::from_str::<WindowSet>(text) {
            // Rows keep their devserver-local tokens: `should_show` reads
            // token emptiness as the tenant on/off signal, and gateway
            // navigation credentials are minted at open/retarget time
            // (`devserver::window_navigation_url`), never stamped into
            // the feed.
            let windows = set.windows;
            let first_snapshot = !saw_snapshot;
            saw_snapshot = true;
            let pending_attempts = pending_delete_attempts_for_feed_snapshot(
                &state.pending_window_deletes,
                id,
                &windows,
                first_snapshot,
            );
            for attempt in pending_attempts {
                crate::spawn_pending_window_delete_attempt(
                    app.clone(),
                    Arc::clone(state),
                    conn.clone(),
                    attempt,
                );
            }
            // Refresh this library's active-transfer cache so the desktop
            // close guard can see a remote window's in-flight transfer (the
            // desktop sees no remote `/ws`; the feed bit is its only signal).
            // The library_id is constant per devserver; an empty snapshot
            // carries none, but then there are no windows to guard either.
            if let Some(library_id) = windows.first().map(|r| r.library_id.clone()) {
                let active: Vec<String> = windows
                    .iter()
                    .filter(|r| r.active_transfer)
                    .map(native_label)
                    .collect();
                state.refresh_devserver_active_transfers(&library_id, &active);
            }
            *snapshot.lock().unwrap() = windows;
            // Re-push the launcher feed: a devserver window change
            // shifts the merged launcher window set, so signal the embedded
            // host to re-assemble + re-push. The devserver only pushes on a
            // real change, so this is already change-gated.
            if let Some(embedded) = state.embedded() {
                embedded.signal_library_change();
            }
            change.notify_one();
        }
    })
    .await
}

/// Subscribe to a connected devserver's pane-highlight COLOUR feed
/// (`GET /api/library/local-color/watch`): on each `{ color }` push,
/// refresh the launcher's per-devserver colour cache and -- only on a real change
/// -- re-push the library feed, so a NEW window of this devserver reads the fresh
/// `?pane=` colour at build. Push-based; replaces the old 5s colour poll (the
/// workspace list stays polled -- there is no `workspaces/watch`). Reconnects on a
/// dropped socket until `cancel` flips true (disconnect), like the window feed.
pub(crate) fn spawn_devserver_color_watch(
    state: Arc<AppState>,
    id: String,
    conn: DevserverConn,
    mut cancel: watch::Receiver<DevserverWatcherStop>,
) {
    const RECONNECT_BACKOFF: Duration = Duration::from_secs(2);
    tauri::async_runtime::spawn(async move {
        loop {
            if (*cancel.borrow_and_update()).is_stopped() {
                return;
            }
            tokio::select! {
                _ = cancel.changed() => return,
                result = stream_color_feed(&state, &id, &conn) => {
                    if let Err(e) = result {
                        tracing::debug!(
                            devserver = %id,
                            error = %e,
                            "devserver colour feed disconnected; reconnecting",
                        );
                    }
                }
            }
            if (*cancel.borrow_and_update()).is_stopped() {
                return;
            }
            tokio::select! {
                _ = cancel.changed() => return,
                _ = tokio::time::sleep(RECONNECT_BACKOFF) => {}
            }
        }
    });
}

/// One `{ color }` frame of the devserver colour watch.
#[derive(serde::Deserialize)]
struct LocalColorFrame {
    color: Option<String>,
}

/// One connection's lifetime on the devserver colour watch: raw devservers auth
/// with bearer; gateway devservers auth with the devserver-gate cookie. Each
/// `{ color }` frame refreshes the per-devserver colour cache, re-pushing the
/// launcher feed only on a real change.
async fn stream_color_feed(
    state: &Arc<AppState>,
    id: &str,
    conn: &DevserverConn,
) -> Result<(), String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut ws = if conn.gateway.is_some() {
        connect_gateway_ws(conn, "/api/library/local-color/watch").await?
    } else {
        let url = format!(
            "ws://{}:{}/api/library/local-color/watch",
            conn.host, conn.port
        );
        let mut request = url
            .into_client_request()
            .map_err(|e| format!("bad colour watch url: {e}"))?;
        request.headers_mut().insert(
            "Authorization",
            format!("Bearer {}", conn.token)
                .parse()
                .map_err(|e| format!("bad bearer header: {e}"))?,
        );
        tokio_tungstenite::connect_async(request)
            .await
            .map(|(ws, _)| ws)
            .map_err(|e| format!("connect colour watch: {e}"))?
    };
    // Same keepalive Ping + read-deadline as the window feed so a half-open
    // colour socket self-heals instead of pending forever. The colour feed does
    // NOT drive the Unreachable flag (the window feed owns it -- one writer).
    keepalive_pump(&mut ws, FEED_PING_INTERVAL, FEED_MAX_MISSED, |text| {
        if let Ok(frame) = serde_json::from_str::<LocalColorFrame>(text) {
            if state.devserver_feed.set_color(id.to_string(), frame.color) {
                if let Some(embedded) = state.embedded() {
                    embedded.signal_library_change();
                }
            }
        }
    })
    .await
}

/// Spawn a connected devserver's window watcher: one [`watch_loop`] driven by the
/// devserver's `/api/library/windows/watch` feed, opening windows as remote SPA
/// webviews. Returns the `cancel` (a `watch::Sender`) -- send
/// [`DevserverWatcherStop::CloseWindows`] on disconnect, or
/// [`DevserverWatcherStop::RetireKeepWindows`] for token-rotation handoff.
///
/// The `library_id` (`lib-<hex>`) is NOT needed up front: an EMPTY feed is valid
/// (a devserver with no windows, or one the user emptied before disconnecting),
/// so the watcher learns the id LAZILY from the first record (`watch_loop`). The
/// initial seed is best-effort -- an empty or failed fetch is fine; the `/watch`
/// WS pushes the authoritative snapshot on connect.
pub(crate) async fn spawn_devserver_window_watcher(
    id: String,
    app: AppHandle,
    conn: DevserverConn,
) -> Result<
    (
        watch::Sender<DevserverWatcherStop>,
        Arc<Mutex<Vec<WindowRecord>>>,
        Arc<WatcherViewState>,
    ),
    String,
> {
    let seed = crate::devserver::fetch_library_windows(&conn)
        .await
        .unwrap_or_default();
    let snapshot = Arc::new(Mutex::new(seed));
    // A handle on the snapshot for the caller's launcher feed: the same
    // Arc the feed task mutates, so the launcher reads this devserver's live windows.
    let snapshot_handle = Arc::clone(&snapshot);
    let change = Arc::new(Notify::new());
    let (cancel_tx, cancel_rx) = watch::channel(DevserverWatcherStop::Running);
    // Shared state so the feed task can refresh the active-transfer cache the
    // close guard reads for this devserver's windows.
    let state = Arc::clone(app.state::<Arc<AppState>>().inner());
    let pending_deletes = Arc::clone(&state.pending_window_deletes);
    // The WS feed task owns a `conn` clone, pushes changes into `snapshot` +
    // wakes `change`, and stops when `cancel` flips true.
    tauri::async_runtime::spawn(run_devserver_window_feed(
        id,
        app.clone(),
        conn.clone(),
        Arc::clone(&snapshot),
        Arc::clone(&change),
        state,
        cancel_rx.clone(),
    ));
    let surface = TauriNativeSurface {
        app,
        opener: WindowOpener::Remote { conn },
        in_flight: Arc::new(Mutex::new(HashSet::new())),
        remote_launches: Arc::new(Mutex::new(HashMap::new())),
        nudge: Some(Arc::clone(&change)),
    };
    let feed = DevserverWindowFeed { snapshot, change };
    let view = Arc::new(WatcherViewState::with_pending_deletes(pending_deletes));
    // A handle on the view for the caller so the close handler can bury THIS
    // devserver's windows through it: a bury flips `should_show` false and
    // the reconcile CLOSES the webview (drops the `/ws`), so the launcher dot
    // reflects hidden -- unlike a bare `window.hide()`, which keeps the `/ws` live.
    let view_handle = Arc::clone(&view);
    let mut cancel_loop = cancel_rx;
    tauri::async_runtime::spawn(watch_loop(None, feed, surface, view, async move {
        loop {
            let stop = *cancel_loop.borrow_and_update();
            if let Some(stop) = stop.watch_loop_stop() {
                return stop;
            }
            if cancel_loop.changed().await.is_err() {
                return WatchLoopStop::CloseWindows;
            }
        }
    }));
    Ok((cancel_tx, snapshot_handle, view_handle))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec() -> WindowRecord {
        WindowRecord {
            window_id: "w-1".into(),
            library_id: "lib-test".into(),
            kind: chan_server::WindowKind::Terminal,
            title: "Terminal".into(),
            ordinal: 1,
            label: String::new(),
            workspace_path: None,
            prefix: "/terminal".into(),
            token: "tok-1".into(),
            persisted: true,
            connected: false,
            active_transfer: false,
            control: false,
            hidden: false,
            origin: chan_server::WindowOrigin::Native,
        }
    }

    #[test]
    fn native_gateway_websocket_uses_the_exact_proxy_origin() {
        let conn = DevserverConn {
            host: "alice--0123456789ab.p1.usr.chan.app".into(),
            port: 443,
            token: String::new(),
            name: "alice".into(),
            gateway: Some(Box::new(crate::devserver::GatewayConn::new(
                "https://gw.chan.app".into(),
                "https://gw.chan.app/desktop/v1/devserver/entry".into(),
                "https://alice--0123456789ab.p1.usr.chan.app".into(),
                "pat".into(),
            ))),
        };
        assert_eq!(
            gateway_ws_origin(&conn).unwrap(),
            "https://alice--0123456789ab.p1.usr.chan.app"
        );
    }

    #[test]
    fn remote_launch_key_ignores_feed_status_fields() {
        let a = rec();
        let mut b = a.clone();
        b.connected = true;
        b.active_transfer = true;
        b.control = true;
        b.hidden = true;

        for gateway in [false, true] {
            assert_eq!(
                RemoteLaunchKey::from_record(&a, gateway),
                RemoteLaunchKey::from_record(&b, gateway)
            );
        }
    }

    #[test]
    fn remote_launch_key_tracks_url_and_window_shape_fields() {
        let base = rec();

        let mut token = base.clone();
        token.token = "tok-2".into();
        // A raw devserver's token is the stable tenant bearer: rotation means
        // the loaded page's auth died, so it must retarget.
        assert_ne!(
            RemoteLaunchKey::from_record(&base, false),
            RemoteLaunchKey::from_record(&token, false)
        );

        let mut prefix = base.clone();
        prefix.prefix = "/other".into();
        assert_ne!(
            RemoteLaunchKey::from_record(&base, false),
            RemoteLaunchKey::from_record(&prefix, false)
        );

        let mut workspace = base.clone();
        workspace.kind = chan_server::WindowKind::Workspace;
        workspace.workspace_path = Some("/repo".into());
        assert_ne!(
            RemoteLaunchKey::from_record(&base, false),
            RemoteLaunchKey::from_record(&workspace, false)
        );
    }

    #[test]
    fn remote_launch_key_ignores_token_churn_for_gateway_windows() {
        // A gateway window's entry credential is single-use and minted fresh
        // per navigation; the page's standing auth is the opaque
        // devserver-gate cookie. A re-mint therefore must NOT change the
        // launch key -- keying on it made every feed push retarget every
        // open window into a reload loop.
        let base = rec();
        let mut token = base.clone();
        token.token = "tok-2".into();
        assert_eq!(
            RemoteLaunchKey::from_record(&base, true),
            RemoteLaunchKey::from_record(&token, true)
        );
        // Real shape changes still retarget.
        let mut prefix = base.clone();
        prefix.prefix = "/other".into();
        assert_ne!(
            RemoteLaunchKey::from_record(&base, true),
            RemoteLaunchKey::from_record(&prefix, true)
        );
    }

    #[test]
    fn pending_delete_retries_on_first_feed_snapshot_and_settles_when_absent() {
        let record = rec();
        let pending = PendingDeleteState::default();
        pending.queue("devserver-1", &record);
        let initial = pending.begin("lib-test::w-1").unwrap();
        let _ = pending.finish(&initial.label, false);

        assert!(pending_delete_attempts_for_feed_snapshot(
            &pending,
            "devserver-1",
            std::slice::from_ref(&record),
            false,
        )
        .is_empty());

        let retries = pending_delete_attempts_for_feed_snapshot(
            &pending,
            "devserver-1",
            std::slice::from_ref(&record),
            true,
        );
        assert_eq!(retries.len(), 1);
        assert_eq!(retries[0].attempt, 2);
        let _ = pending.finish(&retries[0].label, true);

        assert!(pending.contains("lib-test::w-1"));
        assert!(
            pending_delete_attempts_for_feed_snapshot(&pending, "devserver-1", &[], false,)
                .is_empty()
        );
        assert!(!pending.contains("lib-test::w-1"));
    }

    #[tokio::test]
    async fn keepalive_pump_errs_on_a_silent_socket() {
        // A mock feed WS that completes the handshake then stays silent: it never
        // sends a frame and never polls, so it does not even auto-pong. The pump
        // must give up after `max_missed` idle intervals rather than pend forever
        // on `next()` -- the half-open zombie a laptop sleep leaves behind. Short
        // injected interval so the deadline fires in ~120ms of real time.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let _ws = tokio_tungstenite::accept_async(sock).await.unwrap();
            tokio::time::sleep(Duration::from_secs(5)).await; // hold it open, silent
        });
        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/"))
            .await
            .expect("connect to the mock feed");
        let mut frames = 0u32;
        let result = keepalive_pump(&mut ws, Duration::from_millis(40), 2, |_| frames += 1).await;
        assert!(
            result.is_err(),
            "a silent socket must error out, got {result:?}"
        );
        assert_eq!(frames, 0, "no frames should have arrived");
    }

    #[tokio::test]
    async fn keepalive_pump_forwards_frames_then_ok_on_clean_close() {
        use futures::SinkExt;
        use tokio_tungstenite::tungstenite::Message;
        // A mock feed that pushes two frames then closes cleanly: every frame
        // reaches `on_text` and the clean close returns Ok (no false deadline).
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(sock).await.unwrap();
            ws.send(Message::text("{\"windows\":[]}")).await.unwrap();
            ws.send(Message::text("{\"windows\":[]}")).await.unwrap();
            ws.send(Message::Close(None)).await.unwrap();
        });
        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/"))
            .await
            .expect("connect to the mock feed");
        let mut frames = 0u32;
        let result = keepalive_pump(&mut ws, Duration::from_secs(5), 2, |_| frames += 1).await;
        assert!(result.is_ok(), "a clean close returns Ok, got {result:?}");
        assert_eq!(frames, 2, "both text frames forwarded to on_text");
    }
}
