//! GET /ws -- bidirectional WebSocket pump.
//!
//! Server -> client: the global JSON-envelope broadcast (`watch`,
//! `progress`, `window_command`, ...) plus this socket's per-scope `fs`
//! frames from the `ScopeRegistry`. A window's socket is also sent its
//! `survey_sync` directly, on attach and whenever its broadcast receiver
//! lagged, since the survey overlays' one-shot open and close frames ride
//! that broadcast. A lagged socket also gets `watch_resync` so the page
//! rechecks the workspace root after filesystem frames may have been lost.
//!
//! Client -> server: `sub` / `unsub` frames that add/drop this socket's
//! per-directory scope subscriptions. The socket
//! registers with the `ScopeRegistry` on connect and unregisters on any
//! exit path so a disconnect cannot leak scopes.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{RawQuery, State};
use axum::response::Response;
use serde::Deserialize;
use tokio::sync::{broadcast, mpsc, watch};
use tokio::time::{Duration, Instant};

use crate::bus::{ScopeRegistry, SubId};
use crate::extract::Query;
use crate::signal::now_unix_secs;
use crate::state::AppState;
use crate::window_transfers::TransferGuard;

/// Optional window identity on the event socket (`/ws?w=<id>`): the
/// same per-window id that keys the `/api/session` blob. A socket that
/// names its window registers with `WindowPresence` so `GET /api/windows`
/// can report which windows are currently connected. Absent on clients
/// that name none (tests, curl) -- they simply don't appear in presence.
///
/// The socket's holder (`&h=<holder>`) is not a field here: it is read
/// from the raw query by `holder_tag`, which refuses nothing.
#[derive(Deserialize)]
pub struct WsQuery {
    w: Option<String>,
}

/// The longest holder tag a socket can carry.
const HOLDER_TAG_MAX: usize = 64;

/// The holder a query string names with `h`: who holds the socket, or who
/// asks for a page that will. The tag is opaque to the server, 1 to
/// `HOLDER_TAG_MAX` characters of `[A-Za-z0-9_-]`, so it needs no escaping
/// wherever it is copied. A query with no `h`, an empty one, more than one,
/// or one that is not such a tag names no holder: that is never a refusal,
/// since a window's socket counts toward its `connected` whoever holds it.
pub(crate) fn holder_tag(query: Option<&str>) -> Option<String> {
    let mut tags = url::form_urlencoded::parse(query?.as_bytes())
        .filter(|(key, _)| key == "h")
        .map(|(_, tag)| tag);
    let tag = tags.next()?;
    if tags.next().is_some() {
        return None;
    }
    let well_formed = (1..=HOLDER_TAG_MAX).contains(&tag.len())
        && tag
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
    well_formed.then(|| tag.into_owned())
}

/// The target window id of a compact `window_command` or `transfer_queue` frame, or `None` for other frames. Both put `type` and `window_id` first, so the id can be read without parsing the remaining payload, which can include multi-MB clipboard data. An unrecognized prefix broadcasts the frame. The SPA re-checks `window_id` only for `window_command`; it matches `transfer_queue` frames by transfer id.
pub(crate) fn window_command_target(frame: &str) -> Option<&str> {
    const PREFIXES: [&str; 2] = [
        "{\"type\":\"window_command\",\"window_id\":\"",
        "{\"type\":\"transfer_queue\",\"window_id\":\"",
    ];
    for prefix in PREFIXES {
        if let Some(rest) = frame.strip_prefix(prefix) {
            let end = rest.find('"')?;
            return Some(&rest[..end]);
        }
    }
    None
}

/// One `transfer_queue` frame. Field order is load-bearing: `type` and
/// `window_id` must serialize first so the socket pump can read the target off
/// a fixed prefix.
#[derive(serde::Serialize)]
struct TransferQueueFrame<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    window_id: &'a str,
    transfer_id: &'a str,
    state: &'static str,
    /// Absent, not null and not zero, while the transfer is running. The
    /// browser distinguishes "no rank" from "rank 0" and must never see the
    /// latter.
    #[serde(skip_serializing_if = "Option::is_none")]
    position: Option<usize>,
}

/// Report one tracked transfer's queue position to the window that started it,
/// until it starts running or its response goes away.
///
/// Untracked callers get no reporter at all: `curl`, MCP, and the SPA's direct
/// download anchors are admitted and bounded exactly the same, they simply
/// have no window to address. Absence of frames never means absence of
/// admission.
pub(crate) fn spawn_transfer_queue_reporter(
    events_tx: broadcast::Sender<String>,
    window_id: String,
    transfer_id: String,
    tracker: crate::bulk_transfer::BulkTracker,
    mut response_alive: tokio::sync::oneshot::Receiver<std::convert::Infallible>,
) {
    tokio::spawn(async move {
        let mut changes = tracker.changes();
        let mut last: Option<crate::bulk_transfer::BulkState> = None;
        loop {
            let now = tracker.state();
            if last != Some(now) {
                let (state, position) = match now {
                    crate::bulk_transfer::BulkState::Waiting(rank) => ("waiting", Some(rank)),
                    crate::bulk_transfer::BulkState::Active => ("active", None),
                };
                let frame = serde_json::to_string(&TransferQueueFrame {
                    kind: "transfer_queue",
                    window_id: &window_id,
                    transfer_id: &transfer_id,
                    state,
                    position,
                });
                if let Ok(frame) = frame {
                    // A send failure means no socket is attached, which is
                    // normal between reloads and is not worth reporting.
                    let _ = events_tx.send(frame);
                }
                last = Some(now);
            }
            // Running is terminal for this reporter: the HTTP response carries
            // the outcome, so a completion frame would only race it.
            if now == crate::bulk_transfer::BulkState::Active {
                return;
            }
            tokio::select! {
                // The response owner dropped, so the transfer is cancelled and
                // there is nobody left to inform.
                _ = &mut response_alive => return,
                changed = changes.changed() => {
                    if changed.is_err() {
                        return;
                    }
                }
            }
        }
    });
}

pub async fn ws_upgrade(
    State(state): State<Arc<AppState>>,
    Query(q): Query<WsQuery>,
    RawQuery(raw_query): RawQuery,
    // A `/ws` that arrived over the devserver's gateway tunnel carries the
    // `TunnelOrigin` request-extension marker; the loopback bind (and an
    // `ssh -L` forward to it) never does, nor does the desktop embedded server.
    // The `Option` extractor yields `None` on absence rather than 500ing, so
    // absence means a local-origin socket. This is the session-role seam: a
    // local socket reads Leader, a tunnel socket reads Follower.
    origin: Option<axum::Extension<crate::TunnelOrigin>>,
    ws: WebSocketUpgrade,
) -> Response {
    let local = origin.is_none();
    // Gateway assertions deliberately carry immutable authorization only.
    // Display identity can be layered through a separate lookup path later.
    let identity = None;
    let rx = state.events_tx.subscribe();
    let last_activity = state.last_activity.clone();
    let shutdown_rx = state.shutdown_rx.clone();
    let scopes = state.scope_registry.clone();
    let watch_manager = state
        .standalone_files
        .as_ref()
        .map(|files| files.watcher.clone());
    let presence = state.window_presence.clone();
    let transfers = state.window_transfers.clone();
    let session_registry = state.session_registry.clone();
    let session_events_tx = state.events_tx.clone();
    let pending_commands = state.pending_window_commands.clone();
    let survey_bus = state.survey_bus.clone();
    let window_id = q.w.map(|w| w.trim().to_string()).filter(|w| !w.is_empty());
    let holder = holder_tag(raw_query.as_deref());
    ws.on_upgrade(move |mut socket| async move {
        // RAII presence ref: held across the pump so EVERY exit path
        // (clean close, network drop, shutdown) deregisters the window, and
        // its holder with it. A holder is counted only for a window: a
        // socket with no window id is in no presence at all.
        let _presence = window_id
            .as_ref()
            .map(|id| presence.connect(id, holder.as_deref()));
        // RAII transfer guard for the same `?w=` window: the pump calls
        // `set` on each `transfers` frame, and Drop clears this socket's
        // contribution on every exit path (so a reload reads inactive).
        let transfer_guard = window_id.as_ref().map(|id| transfers.register(id));
        // RAII session participation: the first socket of a window joins the
        // leader/followers session (electing the leader when it is first); the
        // guard's Drop arms the grace clock when the last socket drops. A join
        // that moves the roster (a new or revived participant) rebroadcasts.
        let _session = window_id.as_ref().map(|id| {
            let join = session_registry.join(id, local, identity);
            if join.changed {
                crate::session_roster::broadcast_session_roster(
                    &session_events_tx,
                    &session_registry,
                );
            }
            join.guard
        });
        // Per-socket roster snapshot on connect, for tagged AND untagged sockets.
        // The broadcast above fires only when the join MOVES the roster, so a
        // reload (the socket-overlap window reports changed=false) would leave
        // this fresh socket with no roster until some unrelated change -- the
        // starvation that strands isLeader()/roster UI. Sending the current
        // snapshot straight to this socket guarantees it a first frame, and an
        // untagged observer (no `?w=`, no join) learns the roster the same way.
        if let Some(frame) = crate::session_roster::serialize_session_roster(&session_registry) {
            if socket.send(Message::text(frame)).await.is_err() {
                return;
            }
        }
        // Window commands parked while this window had no socket: an open the
        // server routed here (a `cs open` whose path left its workspace) into a
        // window it had just minted. Delivered straight to THIS socket rather
        // than broadcast, because the frames were addressed to this window id
        // and taking them is what makes them not arrive twice. An untagged
        // observer has no id and drains nothing.
        if let Some(id) = window_id.as_deref() {
            for frame in pending_commands.take(id) {
                if socket.send(Message::text(frame)).await.is_err() {
                    return;
                }
            }
            // The surveys still open in this window, sent even when there are
            // none: an `open_survey` or `close_survey` pushed while the window
            // had no socket is gone from the broadcast. It is built after this
            // socket subscribed (`rx` above): a close pushed after the
            // subscribe reaches the pump, and one pushed before it had already
            // taken its survey out of the set.
            if !send_survey_sync(&mut socket, id, &survey_bus).await {
                return;
            }
        }
        ws_pump(
            socket,
            rx,
            last_activity,
            shutdown_rx,
            scopes,
            watch_manager,
            transfer_guard,
            window_id,
            survey_bus,
        )
        .await;
    })
}

/// Send `window_id`'s `survey_sync` to this socket alone. Returns `false`
/// when the socket is gone. A frame that fails to encode is logged and
/// skipped, since the socket itself is still good.
async fn send_survey_sync(
    socket: &mut WebSocket,
    window_id: &str,
    survey_bus: &crate::survey::SurveyBus,
) -> bool {
    match crate::control_socket::survey_sync_frame(window_id, survey_bus) {
        Ok(frame) => socket.send(Message::text(frame)).await.is_ok(),
        Err(error) => {
            tracing::warn!(window_id, %error, "skipped a /ws survey_sync");
            true
        }
    }
}

/// The least time between lag recovery cues sent to a socket.
const LAG_RESYNC_INTERVAL: Duration = Duration::from_secs(1);

/// Direct cue for a page whose broadcast receiver skipped frames. Distinct
/// from `ProviderError`: broadcast lag does not mean the OS watcher failed.
const WATCH_RESYNC_FRAME: &str = r#"{"type":"watch_resync"}"#;

/// A lag owes this socket a recovery cue and, if tagged, a survey snapshot.
/// Traffic that outpaces the socket overruns its receiver again during every
/// send, so recovery sends are capped to one per second while buffered
/// broadcast frames continue flowing in between.
#[derive(Default)]
struct LagResync {
    /// When the last lag sync went out.
    last: Option<Instant>,
    /// A lag happened since it went out.
    owed: bool,
}

impl LagResync {
    /// When the owed sync may go out, `None` when none is owed.
    fn due(&self) -> Option<Instant> {
        self.owed.then(|| {
            self.last
                .map_or_else(Instant::now, |last| last + LAG_RESYNC_INTERVAL)
        })
    }
}

/// Resolve once `due` has passed, at once when it already has (so an owed
/// sync that is due goes out before the buffered frames), and never for
/// `None`.
async fn lag_resync_due(due: Option<Instant>) {
    match due {
        Some(due) if due > Instant::now() => tokio::time::sleep_until(due).await,
        Some(_) => {}
        None => std::future::pending().await,
    }
}

/// Client -> server frame. `sub`/`unsub` add/drop this socket's directory
/// scope (`dir: ""` is the workspace root); `transfers` reports this window's
/// in-flight upload/download count for the desktop close guard; `ping` is the
/// client heartbeat answered with a `pong` on the same socket. Unknown frame
/// types are ignored (the client may send other shapes we don't model here).
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ClientFrame {
    Sub {
        dir: String,
    },
    Unsub {
        dir: String,
    },
    /// `{ "type": "transfers", "active": <n> }` -- this window's current
    /// in-flight transfer count. Applied to the socket's `TransferGuard`;
    /// ignored on an untagged socket (no `?w=`, hence no guard).
    Transfers {
        active: usize,
    },
    /// `{ "type": "ping" }` -- the SPA/desktop watcher heartbeat. Answered with a
    /// `pong` on the same socket so an inbound frame keeps flowing while the
    /// window is live but quiet, below the gateway proxy's per-direction idle
    /// bridge cut. No fields; the socket already identifies the window.
    Ping,
}

/// The pump's follow-up after applying one client frame: whether it owes the
/// socket a reply. A `ping` owes a `pong`; every other frame owes nothing.
#[derive(Debug, PartialEq, Eq)]
enum ClientFrameReply {
    None,
    Pong,
    /// A `sub` past [`MAX_SCOPES_PER_SOCKET`]; carries the refusal frame.
    SubRefused(String),
}

/// Most directory scopes one socket may hold at once. A File Browser
/// subscribes one scope per expanded directory, and "Expand all" expands
/// every directory in the tree, which the listing caps at
/// `LIST_TREE_LIMIT` (500,000) entries; at about eight entries per
/// directory that is some 62,500 directories, under this cap. Each scope
/// costs its path in two maps (and, on the standalone tenant, one OS watch
/// attempt), so the cap bounds one socket's hold at a few megabytes.
const MAX_SCOPES_PER_SOCKET: usize = 65_536;

/// The `pong` answer to a client `ping` heartbeat, echoed verbatim on the same
/// socket. Pinned by [`tests::pong_frame_is_the_pinned_wire_shape`] so the
/// server -> client half cannot drift from the SPA/desktop parse.
const PONG_FRAME: &str = r#"{"type":"pong"}"#;

/// Forward server -> client frames to one WebSocket client and apply this
/// socket's inbound `sub`/`unsub` frames, until either side hangs up.
///
/// Three inbound server -> client sources are merged: the global broadcast
/// (`rx`, lagged subscribers skip ahead rather than tearing down, and a
/// socket then gets a `watch_resync` cue plus a tagged window's survey), this
/// socket's scoped `fs` outbox (`scope_rx`), and the shutdown signal. The
/// fourth `select!` arm reads client text frames and routes sub/unsub to
/// the `ScopeRegistry`. Every successful send bumps `last_activity` to keep
/// the idle-timeout window open.
///
/// The socket registers with the registry on entry and ALWAYS unregisters
/// on exit (every break path falls through to the `unregister` call), so an
/// abrupt disconnect drops all of this socket's scope subscriptions and
/// cannot leak a scope.
#[allow(clippy::too_many_arguments)]
async fn ws_pump(
    mut socket: WebSocket,
    mut rx: broadcast::Receiver<String>,
    last_activity: Arc<AtomicU64>,
    mut shutdown_rx: watch::Receiver<bool>,
    scopes: Arc<ScopeRegistry>,
    watch_manager: Option<Arc<crate::standalone_watch::ScopedWatchManager>>,
    transfer_guard: Option<TransferGuard>,
    window_id: Option<String>,
    survey_bus: Arc<crate::survey::SurveyBus>,
) {
    let (sub_id, scope_rx) = scopes.register();
    pump_loop(
        &mut socket,
        &mut rx,
        &last_activity,
        &mut shutdown_rx,
        &scopes,
        watch_manager.as_deref(),
        sub_id,
        scope_rx,
        transfer_guard.as_ref(),
        window_id.as_deref(),
        &survey_bus,
    )
    .await;
    // Unconditional teardown: drops every scope this socket held. The final
    // detach transitions feed the standalone watch manager (when this tenant
    // has one) so an abandoned scope's OS watch is released too.
    let delta = scopes.unregister(sub_id);
    if let Some(manager) = watch_manager {
        manager.apply_delta(delta);
    }
    // `transfer_guard` drops here too, clearing this socket's transfer count.
}

#[allow(clippy::too_many_arguments)]
async fn pump_loop(
    socket: &mut WebSocket,
    rx: &mut broadcast::Receiver<String>,
    last_activity: &Arc<AtomicU64>,
    shutdown_rx: &mut watch::Receiver<bool>,
    scopes: &Arc<ScopeRegistry>,
    watch_manager: Option<&crate::standalone_watch::ScopedWatchManager>,
    sub_id: SubId,
    mut scope_rx: mpsc::UnboundedReceiver<String>,
    transfer_guard: Option<&TransferGuard>,
    window_id: Option<&str>,
    survey_bus: &crate::survey::SurveyBus,
) {
    let mut scope_refusal_sent = false;
    let mut lag_resync = LagResync::default();
    loop {
        tokio::select! {
            biased;
            // Server-initiated shutdown: send a Close frame so the
            // client knows this isn't a network hiccup, then return.
            // Without this branch the recv arms below would block
            // forever during a graceful shutdown, holding axum's drain
            // open until the hard deadline expires.
            _ = shutdown_rx.changed() => {
                let _ = socket
                    .send(Message::Close(Some(CloseFrame {
                        code: 1001, // going away
                        reason: "server shutdown".into(),
                    })))
                    .await;
                break;
            }
            // A lag recovery send, once due. Ahead of the broadcast arm,
            // which a socket that keeps lagging always finds ready.
            _ = lag_resync_due(lag_resync.due()) => {
                lag_resync = LagResync {
                    last: Some(Instant::now()),
                    owed: false,
                };
                if let Some(id) = window_id {
                    if !send_survey_sync(socket, id, survey_bus).await {
                        break;
                    }
                }
                if socket.send(Message::text(WATCH_RESYNC_FRAME)).await.is_err() {
                    break;
                }
                last_activity.store(now_unix_secs(), Ordering::Relaxed);
            }
            // This socket's scoped `fs` frames. Unbounded channel, so a
            // closed sender (registry torn down) ends the stream.
            scoped = scope_rx.recv() => match scoped {
                Some(frame) => {
                    if socket.send(Message::text(frame)).await.is_err() {
                        break;
                    }
                    last_activity.store(now_unix_secs(), Ordering::Relaxed);
                }
                None => break,
            },
            recv = rx.recv() => match recv {
                Ok(frame) => {
                    // Window commands and transfer-queue updates go only to their addressed window. Untagged sockets receive neither; other frame types remain broadcast.
                    if let Some(target) = window_command_target(&frame) {
                        if window_id != Some(target) {
                            continue;
                        }
                    }
                    if socket.send(Message::text(frame)).await.is_err() {
                        break;
                    }
                    last_activity.store(now_unix_secs(), Ordering::Relaxed);
                }
                Err(broadcast::error::RecvError::Closed) => break,
                // The skipped frames may have held an `open_survey` or
                // `close_survey` for this window, and neither is sent again,
                // so the socket is owed a survey and a root cue. The frames
                // still buffered are forwarded meanwhile, in broadcast order:
                // some were broadcast before the sync is built and reach the
                // socket after it, and a frame a later lag skips owes
                // another sync. An untagged socket receives no window
                // commands.
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    lag_resync.owed = true;
                }
            },
            // Client -> server: sub/unsub/transfers/ping frames. A None / Err
            // means the client closed or sent garbage at the transport level;
            // treat a clean close as end-of-stream. A Close frame ends the pump;
            // Text frames route through `apply_client_frame`, and an app-level
            // `ping` is answered with a `pong` on this socket. Non-text frames
            // (Binary and WS-level Ping/Pong) are ignored (axum auto-replies to
            // the WS-level Ping; the app-level heartbeat is the text `ping`).
            inbound = socket.recv() => match inbound {
                Some(Ok(Message::Text(text))) => {
                    let reply = match apply_client_frame(
                        scopes,
                        watch_manager,
                        sub_id,
                        &text,
                        transfer_guard,
                    ) {
                        ClientFrameReply::None => None,
                        ClientFrameReply::Pong => Some(PONG_FRAME.to_string()),
                        // Told once per socket: the SPA has no handler for the
                        // frame and treats an unknown one as a filesystem
                        // change, so a burst of refusals must not become a
                        // burst of refreshes. The rest are only logged.
                        ClientFrameReply::SubRefused(frame) => {
                            tracing::warn!(
                                limit = MAX_SCOPES_PER_SOCKET,
                                "refused a /ws scope subscription past the per-socket limit"
                            );
                            (!std::mem::replace(&mut scope_refusal_sent, true)).then_some(frame)
                        }
                    };
                    if let Some(reply) = reply {
                        if socket.send(Message::text(reply)).await.is_err() {
                            break;
                        }
                    }
                    last_activity.store(now_unix_secs(), Ordering::Relaxed);
                }
                Some(Ok(Message::Close(_))) => break,
                Some(Ok(_)) => {}
                Some(Err(_)) => break,
                None => break,
            },
        }
    }
}

/// Parse one client text frame and apply it. `sub`/`unsub` route to the scope
/// registry; `transfers` updates the socket's `TransferGuard` (ignored when the
/// socket is untagged, so there is no guard). Malformed JSON or an unmodeled
/// `type` is dropped silently (the server controls the wire format; a stray
/// frame must not tear down the socket).
fn apply_client_frame(
    scopes: &ScopeRegistry,
    watch_manager: Option<&crate::standalone_watch::ScopedWatchManager>,
    sub_id: SubId,
    text: &str,
    transfer_guard: Option<&TransferGuard>,
) -> ClientFrameReply {
    match serde_json::from_str::<ClientFrame>(text) {
        Ok(ClientFrame::Sub { dir }) => {
            // The delta reports global 0 -> 1 / 1 -> 0 transitions; only a
            // tenant with a real per-directory watcher consumes them.
            let Some(delta) = scopes.subscribe_within(sub_id, &dir, MAX_SCOPES_PER_SOCKET) else {
                return ClientFrameReply::SubRefused(
                    serde_json::json!({
                        "type": "sub_refused",
                        "dir": dir,
                        "reason": "scope-limit",
                        "limit": MAX_SCOPES_PER_SOCKET,
                    })
                    .to_string(),
                );
            };
            if let Some(manager) = watch_manager {
                manager.apply_delta(delta);
            }
            ClientFrameReply::None
        }
        Ok(ClientFrame::Unsub { dir }) => {
            let delta = scopes.unsubscribe(sub_id, &dir);
            if let Some(manager) = watch_manager {
                manager.apply_delta(delta);
            }
            ClientFrameReply::None
        }
        Ok(ClientFrame::Transfers { active }) => {
            if let Some(guard) = transfer_guard {
                guard.set(active);
            }
            ClientFrameReply::None
        }
        Ok(ClientFrame::Ping) => ClientFrameReply::Pong,
        Err(_) => ClientFrameReply::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Pins the client -> server wire shape (the TS `WsClientFrame` union
    // serializes `{ "type": "sub"|"unsub", "dir": ... }` lowercase) and
    // that a parsed frame routes to the registry as the right sub/unsub.
    #[test]
    fn client_sub_unsub_frames_route_to_the_registry() {
        let reg = ScopeRegistry::new();
        let (id, _rx) = reg.register();

        // sub/unsub owe the socket no reply.
        assert_eq!(
            apply_client_frame(
                &reg,
                None,
                id,
                r#"{"type":"sub","dir":"notes/recipes"}"#,
                None
            ),
            ClientFrameReply::None
        );
        assert!(reg.scope_exists("notes/recipes"));
        assert_eq!(reg.subscriber_count("notes/recipes"), 1);

        assert_eq!(
            apply_client_frame(
                &reg,
                None,
                id,
                r#"{"type":"unsub","dir":"notes/recipes"}"#,
                None
            ),
            ClientFrameReply::None
        );
        assert!(!reg.scope_exists("notes/recipes"));

        // The workspace root scope rides the same path.
        apply_client_frame(&reg, None, id, r#"{"type":"sub","dir":""}"#, None);
        assert!(reg.scope_exists(""));
    }

    #[test]
    fn a_socket_holds_exactly_the_scope_limit_and_is_refused_one_more() {
        let reg = ScopeRegistry::new();
        let (id, _rx) = reg.register();
        let sub = |dir: String| {
            apply_client_frame(
                &reg,
                None,
                id,
                &serde_json::json!({"type": "sub", "dir": dir}).to_string(),
                None,
            )
        };
        for i in 0..MAX_SCOPES_PER_SOCKET {
            assert_eq!(sub(format!("d{i}")), ClientFrameReply::None, "sub {i}");
        }
        // A repeat of a held dir at the limit is idempotent, not refused.
        assert_eq!(sub("d0".to_string()), ClientFrameReply::None);

        let refused = sub("one-more".to_string());

        let ClientFrameReply::SubRefused(frame) = refused else {
            panic!("the sub past the limit must be refused: {refused:?}");
        };
        let frame: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(frame["type"], "sub_refused");
        assert_eq!(frame["reason"], "scope-limit");
        assert_eq!(frame["dir"], "one-more");
        assert_eq!(frame["limit"], MAX_SCOPES_PER_SOCKET);
        assert!(
            !reg.scope_exists("one-more"),
            "a sub past the limit must not add a scope"
        );
        assert_eq!(reg.subscribed_dirs().len(), MAX_SCOPES_PER_SOCKET);

        // Dropping one makes room again.
        apply_client_frame(&reg, None, id, r#"{"type":"unsub","dir":"d0"}"#, None);
        assert_eq!(sub("one-more".to_string()), ClientFrameReply::None);
    }

    // Contract B: the client heartbeat `{"type":"ping"}` parses to
    // `ClientFrame::Ping` and owes the socket a `pong`; it is not a
    // subscription, so it registers no scope. Old servers (no `Ping` variant)
    // drop it as unmodeled and old clients never send it, so the skew is safe
    // both ways.
    #[test]
    fn ping_frame_asks_for_a_pong_reply() {
        let reg = ScopeRegistry::new();
        let (id, _rx) = reg.register();

        assert_eq!(
            apply_client_frame(&reg, None, id, r#"{"type":"ping"}"#, None),
            ClientFrameReply::Pong
        );
        // A ping must not touch the scope registry.
        assert!(!reg.scope_exists("ping"));
        assert_eq!(reg.subscriber_count(""), 0);
    }

    // Pins the server -> client `pong` bytes so the SPA/desktop watcher's
    // read-deadline (which treats any inbound frame as liveness) and this
    // server cannot silently desync on the frame shape.
    #[test]
    fn pong_frame_is_the_pinned_wire_shape() {
        assert_eq!(PONG_FRAME, r#"{"type":"pong"}"#);
        let parsed: serde_json::Value = serde_json::from_str(PONG_FRAME).unwrap();
        assert_eq!(parsed["type"], "pong");
    }

    #[test]
    fn lag_cue_has_its_own_wire_type() {
        let parsed: serde_json::Value = serde_json::from_str(WATCH_RESYNC_FRAME).unwrap();
        assert_eq!(parsed["type"], "watch_resync");
        assert!(parsed.get("event").is_none(), "lag is not a provider error");
    }

    #[test]
    fn window_command_target_extracts_the_addressed_window() {
        // A window_command frame yields its target window_id; the pump forwards
        // it only to that window's socket.
        let frame = r#"{"type":"window_command","window_id":"workspace-aa-0","command":"clipboard_write","request_id":"r1","mime":"image/png","data_b64":"AAAA"}"#;
        assert_eq!(window_command_target(frame), Some("workspace-aa-0"));

        // Non-window_command frames are broadcast (return None), so the pump
        // forwards them to every socket unchanged.
        assert_eq!(
            window_command_target(r#"{"type":"progress","pct":10}"#),
            None
        );
        assert_eq!(
            window_command_target(r#"{"type":"session_roster","rows":[]}"#),
            None
        );
        assert_eq!(window_command_target("not json"), None);
    }

    #[test]
    fn transfer_queue_frames_are_addressed_to_one_window() {
        // Same fixed-prefix read as window_command, so a queue position never
        // reaches another window's socket.
        let waiting = r#"{"type":"transfer_queue","window_id":"workspace-aa-0","transfer_id":"t-1","state":"waiting","position":3}"#;
        assert_eq!(window_command_target(waiting), Some("workspace-aa-0"));
        let active = r#"{"type":"transfer_queue","window_id":"terminal-7","transfer_id":"t-2","state":"active"}"#;
        assert_eq!(window_command_target(active), Some("terminal-7"));
    }

    #[test]
    fn transfer_queue_frame_matches_the_published_wire_shape() {
        // Every string here is runtime-validated, not compiler-validated, and
        // the browser parses this exact shape. Field ORDER is load-bearing:
        // the pump reads window_id off a fixed prefix.
        let waiting = serde_json::to_string(&TransferQueueFrame {
            kind: "transfer_queue",
            window_id: "w-1",
            transfer_id: "t-1",
            state: "waiting",
            position: Some(2),
        })
        .expect("frame serializes");
        assert_eq!(
            waiting,
            r#"{"type":"transfer_queue","window_id":"w-1","transfer_id":"t-1","state":"waiting","position":2}"#
        );

        // Absent, not null and not zero: the browser distinguishes "no rank"
        // from "rank 0" and must never be handed the latter.
        let active = serde_json::to_string(&TransferQueueFrame {
            kind: "transfer_queue",
            window_id: "w-1",
            transfer_id: "t-1",
            state: "active",
            position: None,
        })
        .expect("frame serializes");
        assert_eq!(
            active,
            r#"{"type":"transfer_queue","window_id":"w-1","transfer_id":"t-1","state":"active"}"#
        );
        assert!(!active.contains("position"));
    }

    #[test]
    fn tracking_requires_both_headers_and_untracked_is_not_degraded() {
        use crate::routes::transfer::TransferTracking;
        let mut headers = axum::http::HeaderMap::new();
        assert!(TransferTracking::from_headers(&headers).is_none());

        headers.insert("x-chan-window-id", "w-1".parse().unwrap());
        assert!(
            TransferTracking::from_headers(&headers).is_none(),
            "one header alone must not opt in"
        );

        headers.insert("x-chan-transfer-id", "   ".parse().unwrap());
        assert!(
            TransferTracking::from_headers(&headers).is_none(),
            "a blank id must not opt in"
        );

        headers.insert("x-chan-transfer-id", "t-1".parse().unwrap());
        let tracking = TransferTracking::from_headers(&headers).expect("both headers opt in");
        assert_eq!(tracking.window_id, "w-1");
        assert_eq!(tracking.transfer_id, "t-1");
    }

    #[test]
    fn malformed_or_unknown_frames_are_dropped_without_panicking() {
        let reg = ScopeRegistry::new();
        let (id, _rx) = reg.register();
        // Bad JSON, an unmodeled type, and a missing field must all be
        // no-ops (a stray frame cannot tear down or corrupt the socket).
        apply_client_frame(&reg, None, id, "not json", None);
        apply_client_frame(&reg, None, id, r#"{"type":"bogus","dir":"x"}"#, None);
        apply_client_frame(&reg, None, id, r#"{"type":"sub"}"#, None);
        assert!(!reg.scope_exists("x"));
        assert_eq!(reg.subscriber_count(""), 0);
    }

    // Pins the `{ "type": "transfers", "active": <n> }` wire shape and that a
    // transfers frame drives the socket's TransferGuard (so the host close
    // guard reads the count). An untagged socket (no guard) ignores it.
    #[test]
    fn transfers_frame_updates_the_window_count() {
        let reg = ScopeRegistry::new();
        let (id, _rx) = reg.register();
        let transfers = Arc::new(crate::window_transfers::WindowTransfers::new());
        let guard = transfers.register("w1");

        apply_client_frame(
            &reg,
            None,
            id,
            r#"{"type":"transfers","active":2}"#,
            Some(&guard),
        );
        assert!(transfers.window_has_active_transfer("w1"));

        apply_client_frame(
            &reg,
            None,
            id,
            r#"{"type":"transfers","active":0}"#,
            Some(&guard),
        );
        assert!(!transfers.window_has_active_transfer("w1"));

        // A socket with no `?w=` (no guard) silently ignores the frame.
        apply_client_frame(&reg, None, id, r#"{"type":"transfers","active":5}"#, None);
        assert!(!transfers.window_has_active_transfer("w1"));
    }
}
