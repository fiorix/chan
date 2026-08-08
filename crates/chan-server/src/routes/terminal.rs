//! Interactive PTY-backed terminal sessions and terminal control APIs.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Json, Path as AxumPath, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use chan_shell::{PaneSide, ResolvedSubmit, SubmitAgent};
use portable_pty::PtySize;
use serde::{Deserialize, Serialize};

use crate::signal::now_unix_secs;
use crate::state::AppState;
use crate::terminal_sessions::{
    AttachHandle, CloseReason, CreateError, CreateOptions, RestartOverrides, SessionEvent,
    TerminalPlacement, ALT_SCREEN_ATTACH_PRELUDE,
};

const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;
const MAX_COLS: u16 = 500;
const MAX_ROWS: u16 = 200;

/// RIS (ESC c) -- full terminal reset, sent to an attached xterm when its
/// session is restarted in place so the relaunched shell starts on a clean
/// screen. A fresh SPA reattach gets a brand-new empty xterm; a server-side
/// re-attach reuses the live one, so reset it here to match.
const RESET_TERMINAL: &[u8] = b"\x1bc";

#[derive(Debug, Default, Deserialize)]
pub struct TerminalQuery {
    session: Option<String>,
    since: Option<u64>,
    cols: Option<u16>,
    rows: Option<u16>,
    tab_name: Option<String>,
    tab_group: Option<String>,
    window_id: Option<String>,
    /// The SPA layout coordinates of the attaching view, threaded onto the live
    /// session so `cs terminal list` can trace it to its window -> pane -> tab.
    pane_id: Option<String>,
    side: Option<PaneSide>,
    tab_id: Option<String>,
    /// The session incarnation epoch the client cached its scrollback snapshot
    /// under. The server honors `since` only when it still matches the live
    /// session's generation (a restart bumps it); absent or stale -> full replay.
    generation: Option<u64>,
    mcp_env: Option<TerminalMcpEnv>,
    cwd: Option<String>,
    command: Option<String>,
    /// JSON-encoded spawn environment map. This is an internal SPA transport;
    /// the public control-socket request carries the map as structured JSON.
    env: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateTerminalBody {
    name: String,
    command: String,
    #[serde(default)]
    env: BTreeMap<String, String>,
    /// Broadcast group the new session joins (sets `$CHAN_TAB_GROUP` and
    /// the registry's per-session `tab_group`). Absent / "default" leaves
    /// it ungrouped. Used by the Team Work bootstrap so every team
    /// terminal joins the team's group.
    #[serde(default)]
    group: Option<String>,
    /// Owning window for the new session. Team-dialog terminals are
    /// created through this POST and only ATTACHED over `/ws` afterwards,
    /// and attach does not rebind `window_id`. Without binding it here the
    /// session keeps `window_id = None`, so `cs terminal survey` (which
    /// resolves its target by window) reports "no live terminal session
    /// matched". The Team Work orchestrator passes the dialog window's
    /// `sessionWindowId()` so the survey overlay lands in the right window.
    #[serde(default)]
    window_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CreateTerminalResponse {
    session: String,
    tab_label: String,
}

#[derive(Debug, Deserialize)]
pub struct RestartTerminalBody {
    name: Option<String>,
    /// Broadcast group for the respawned shell. Sets `$CHAN_TAB_GROUP`
    /// and the registry's per-session `tab_group`. Absent / "default"
    /// resolves to the default group.
    group: Option<String>,
    window_id: Option<String>,
    /// Optional command override. When supplied, the restarted PTY
    /// runs this command instead of the original spawn command.
    /// Used by the team-bootstrap orchestrator to flip the host's
    /// terminal into the lead's session (e.g. `bash` -> `claude`).
    command: Option<String>,
    /// Optional env override. Merged into the restart options' env
    /// so the lead's CHAN_TAB_NAME and any other per-member env
    /// land before the new PTY spawns. Existing entries with the
    /// same key are replaced.
    #[serde(default)]
    env: Option<std::collections::BTreeMap<String, String>>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum TerminalMcpEnv {
    #[default]
    On,
    Off,
}

impl TerminalMcpEnv {
    fn enabled(self) -> bool {
        matches!(self, Self::On)
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ClientFrame {
    #[serde(rename = "input")]
    Input { data: String },
    /// Cross-window broadcast input. Fans `data` to same-group sessions in
    /// OTHER windows (the shared terminal registry spans every standalone
    /// terminal window). The source PTY and the same-window broadcast members
    /// are covered by the normal `Input` frame plus the SPA's client-side fan;
    /// this reaches the members one window's SPA cannot see.
    #[serde(rename = "broadcast-input")]
    BroadcastInput { data: String },
    #[serde(rename = "resize")]
    Resize { cols: u16, rows: u16 },
    #[serde(rename = "cwd")]
    Cwd,
    #[serde(rename = "focus")]
    Focus { focused: bool },
    /// Sync this session's broadcast toggle to the server. The SPA sends
    /// it on toggle and on (re)connect, so the server can (1) gate the
    /// cross-window input fan on the receiver's own toggle and (2) surface
    /// the state in the cross-window roster other windows read.
    #[serde(rename = "set-broadcast")]
    SetBroadcast { on: bool },
    /// Refresh layout coordinates when a mounted terminal tab moves without
    /// reconnecting its PTY WebSocket.
    #[serde(rename = "placement")]
    Placement {
        #[serde(default)]
        pane_id: Option<String>,
        #[serde(default)]
        side: Option<PaneSide>,
        #[serde(default)]
        tab_id: Option<String>,
    },
    /// Atomically propose a new live name/group pair. The registry settles the
    /// final unique name and replies on this socket with the complete pair.
    #[serde(rename = "rename")]
    Rename {
        name: String,
        #[serde(default)]
        group: Option<String>,
    },
    #[serde(rename = "close")]
    Close,
    /// Rich Prompt bubble submit. Unlike `Input` (raw keystrokes
    /// straight to the PTY), this ENQUEUES `data` onto this session's write
    /// queue -- the SAME FIFO the control socket's `cs terminal write` feeds
    /// -- so bubble prompts and CLI pokes serialize through one drain and
    /// submit one after another when the agent is idle. The server resolves
    /// the submit template for `agent` (claude / codex / gemini / kimi /
    /// opencode)
    /// and the queue applies it at drain time; `agent` is optional and
    /// DEFAULTS to claude when the SPA does not know the terminal's launch
    /// command. A Rich Prompt is always its own agent turn: it is a boundary
    /// the notification batcher never crosses.
    #[serde(rename = "prompt")]
    Prompt {
        data: String,
        #[serde(default)]
        agent: Option<String>,
        /// Client-generated message id. When present the server acks the
        /// enqueue (`prompt-ack`) and emits `prompt-delivered` when the
        /// message leaves the queue for the PTY, so the Rich Prompt can keep
        /// the text visible until the agent consumes it. Absent = legacy
        /// fire-and-forget (the team orchestrator's lead-identity prompt
        /// stays untagged).
        #[serde(default)]
        id: Option<String>,
    },
    /// Recall a still-queued Rich Prompt message by its `prompt_id` (the `id`
    /// from a `prompt` frame). Removes every queued entry of that message
    /// before it reaches the PTY; the server replies `prompt-cancelled`
    /// (removed=true) so the SPA can pop the draft back to the editor without
    /// double-delivery, or (removed=false) when it had already drained.
    #[serde(rename = "cancel-prompt")]
    CancelPrompt { id: String },
    /// `{ "type": "ping" }` -- the terminal heartbeat, same vocabulary as the
    /// watcher socket's (`routes/ws.rs`). Answered with [`ServerFrame::Pong`]
    /// on this socket so a live-but-quiet tab keeps a frame flowing in each
    /// direction below the gateway bridge's idle cut. Never touches the PTY
    /// input path or the prompt queue.
    #[serde(rename = "ping")]
    Ping,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum ServerFrame {
    #[serde(rename = "session")]
    Session {
        id: String,
        /// Server-authoritative live metadata and immutable spawn provenance.
        /// Optional names preserve honest unknowns from legacy fd-store data;
        /// all fields are always present on the wire.
        name: Option<String>,
        group: String,
        spawn_name: Option<String>,
        spawn_group: Option<String>,
        seq: u64,
        /// This session incarnation's epoch. A restart reuses the id but bumps
        /// this and resets `seq`, so the SPA invalidates a cached scrollback
        /// snapshot whose generation no longer matches.
        generation: u64,
        missed_bytes: u64,
        bytes_since_focus: u64,
        /// MESSAGE depth of the shared write queue at attach time (a gemini
        /// text+chord pair counts once), so every (re)attach re-syncs the
        /// SPA's queue badge.
        queue_depth: usize,
        /// The `prompt_id`s of Rich Prompt messages still in this session's
        /// write queue, in FIFO order (one per message; `cs terminal write`
        /// pokes have no id and are skipped). Lets a reattaching SPA re-prove
        /// its restored pending message is still queued (and its position)
        /// instead of trusting the anonymous `queue_depth`. Always present
        /// (empty when nothing tagged is queued).
        queued_prompt_ids: Vec<String>,
        /// Submit encoding derived from this PTY incarnation's stored spawn
        /// command and `CHAN_AGENT`. Omitted for shells and unknown commands.
        /// Recomputed for every attach prelude, including after restart.
        #[serde(skip_serializing_if = "Option::is_none")]
        submit_agent: Option<&'static str>,
    },
    #[serde(rename = "renamed")]
    Renamed { name: String, group: String },
    #[serde(rename = "rename_failed")]
    RenameFailed { message: String },
    #[serde(rename = "activity")]
    Activity { bytes_since_focus: u64 },
    #[serde(rename = "ready")]
    Ready {
        cols: u16,
        rows: u16,
        #[serde(skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cwd_rel: Option<String>,
    },
    #[serde(rename = "cwd")]
    Cwd {
        #[serde(skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cwd_rel: Option<String>,
    },
    #[serde(rename = "resize")]
    Resize { cols: u16, rows: u16 },
    /// The PTY's process ended. `code` is omitted when no honest exit status
    /// exists (`TerminalExit::Unknown`: a devserver-restart-restored shell is
    /// reparented, so its real status is unobtainable); the SPA then renders
    /// a codeless "process exited".
    #[serde(rename = "exit")]
    Exit {
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<u32>,
    },
    #[serde(rename = "closed")]
    Closed { reason: CloseReason },
    #[serde(rename = "error")]
    Error {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<&'static str>,
    },
    /// Ack for a tagged `prompt` frame, sent inline on the same socket.
    /// `queued` says whether the WHOLE message fit the queue
    /// (all-or-nothing); `depth` is the message depth after the push -- the
    /// message's 1-based position -- on accept, or the unchanged depth on
    /// reject.
    #[serde(rename = "prompt-ack")]
    PromptAck {
        id: String,
        queued: bool,
        depth: usize,
    },
    /// A tagged message's LAST write reached the PTY; `depth` is the
    /// remaining message depth. Broadcast to every attached socket --
    /// non-owners ignore the unknown id but still read the depth.
    #[serde(rename = "prompt-delivered")]
    PromptDelivered { id: String, depth: usize },
    /// Ack for a `cancel-prompt`, sent inline on the requesting socket.
    /// `removed: true` = the message was still queued and every write of `id`
    /// was dropped (a `queue` depth frame follows); `removed: false` = it had
    /// already drained to the PTY, so the SPA must NOT recall it (treat as
    /// delivered). Resolves the cancel-vs-drain race.
    #[serde(rename = "prompt-cancelled")]
    PromptCancelled { id: String, removed: bool },
    /// MESSAGE depth of the shared write queue changed (an enqueue on either
    /// path, or a message fully drained). Absolute count -- idempotent under
    /// duplicates, multi-window safe.
    #[serde(rename = "queue")]
    Queue { depth: usize },
    /// Answer to the client `ping` heartbeat, echoed on the same socket.
    /// Wire shape `{"type":"pong"}`, identical to the watcher socket's
    /// `PONG_FRAME` and pinned by
    /// [`tests::pong_frame_is_the_pinned_wire_shape`]; the SPA terminal
    /// transport parses this exact object.
    #[serde(rename = "pong")]
    Pong,
}

pub async fn api_terminal_ws(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TerminalQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let size = pty_size(query.cols, query.rows);
    let tab_name = query.tab_name.as_deref().and_then(normalize_tab_name);
    let tab_group = query.tab_group.as_deref().and_then(normalize_tab_group);
    let window_id = query.window_id.as_deref().and_then(normalize_window_id);
    let pane_id = query.pane_id.as_deref().and_then(normalize_layout_id);
    let side = query.side;
    let tab_id = query.tab_id.as_deref().and_then(normalize_layout_id);
    // MCP env is off by default. An explicit `?mcp_env=on|off` query
    // wins (the SPA can force a per-terminal choice); when absent we fall
    // back to the non-team server-config default, which itself defaults
    // off. Team spawns don't reach here -- they read the team config's
    // own `mcp_env` toggle in control_socket::spawn_team.
    let mcp_env = match query.mcp_env {
        Some(choice) => choice.enabled(),
        None => state
            .server_config
            .lock()
            .map(|c| c.terminal.mcp_env)
            .unwrap_or(false),
    };
    let (command, env) = match terminal_query_spawn_overrides(&query) {
        Ok(overrides) => overrides,
        Err(message) => return (StatusCode::BAD_REQUEST, message).into_response(),
    };
    let cwd = if query.session.is_some() {
        None
    } else if let Ok(workspace) = state.try_workspace() {
        let cwd = query.cwd.clone();
        let result =
            tokio::task::spawn_blocking(move || resolve_terminal_cwd(&workspace, cwd.as_deref()))
                .await;
        match result {
            Ok(Ok(cwd)) => cwd,
            Ok(Err(message)) => return (StatusCode::BAD_REQUEST, message).into_response(),
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("terminal cwd task panicked: {e}"),
                )
                    .into_response()
            }
        }
    } else {
        // Workspace-less terminal tenant (standalone terminal window): no
        // workspace to resolve a relative cwd against, so new sessions open
        // in the registry default ($HOME). The SPA gates off the
        // From-$CWD spawn actions in this mode, so `query.cwd` is unset.
        None
    };
    let opts = TerminalWsOptions {
        session_id: query.session,
        since: query.since,
        size,
        tab_name,
        tab_group,
        window_id,
        pane_id,
        side,
        tab_id,
        generation: query.generation,
        mcp_env,
        cwd,
        command,
        env,
    };
    ws.on_upgrade(move |socket| terminal_ws(socket, state, opts))
        .into_response()
}

pub async fn api_create_terminal(
    State(state): State<Arc<AppState>>,
    body: Result<Json<CreateTerminalBody>, JsonRejection>,
) -> Response {
    let Json(body) = match body {
        Ok(body) => body,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                format!("invalid terminal create: {e}"),
            )
                .into_response()
        }
    };
    let name = match normalize_terminal_name(&body.name) {
        Some(name) => name,
        None => return (StatusCode::BAD_REQUEST, "terminal name is required").into_response(),
    };
    let command = match normalize_terminal_command(&body.command) {
        Some(command) => command,
        None => return (StatusCode::BAD_REQUEST, "terminal command is required").into_response(),
    };
    if let Err(message) = validate_terminal_env(&body.env) {
        return (StatusCode::BAD_REQUEST, message).into_response();
    }
    let opts = CreateOptions {
        size: pty_size(None, None),
        tab_name: Some(name.clone()),
        tab_group: body.group.as_deref().and_then(normalize_tab_group),
        window_id: body.window_id.as_deref().and_then(normalize_window_id),
        // Off by default; honor the non-team server-config opt-in.
        mcp_env: state
            .server_config
            .lock()
            .map(|c| c.terminal.mcp_env)
            .unwrap_or(false),
        cwd: None,
        command: Some(command),
        env: body.env,
    };
    match state.terminal_sessions.create(opts) {
        Ok(handle) => {
            let tab_label = handle.live_metadata().name.unwrap_or(name);
            (
                StatusCode::CREATED,
                Json(CreateTerminalResponse {
                    session: handle.id().to_string(),
                    tab_label,
                }),
            )
                .into_response()
        }
        Err(CreateError::Capped) => {
            (StatusCode::CONFLICT, "terminal session cap reached").into_response()
        }
        Err(CreateError::FdPressure(e)) => {
            (StatusCode::SERVICE_UNAVAILABLE, e.to_string()).into_response()
        }
        Err(CreateError::Spawn(e)) => (
            StatusCode::BAD_REQUEST,
            format!("failed to start terminal: {e}"),
        )
            .into_response(),
    }
}

pub async fn api_restart_terminal(
    State(state): State<Arc<AppState>>,
    AxumPath(session): AxumPath<String>,
    body: Option<Json<RestartTerminalBody>>,
) -> Response {
    let overrides = if let Some(Json(body)) = body {
        let tab_name = match body.name.as_deref() {
            Some(name) => match normalize_tab_name(name) {
                Some(name) => Some(name),
                None => {
                    return (StatusCode::BAD_REQUEST, "terminal name is required").into_response()
                }
            },
            None => None,
        };
        // Three-way: outer None (no `group` field) keeps the existing
        // group; `Some(None)` (blank / "default") sets the default group;
        // `Some(Some(g))` sets group g.
        let tab_group = body.group.as_deref().map(normalize_tab_group);
        let window_id = match body.window_id.as_deref() {
            Some(id) => match normalize_window_id(id) {
                Some(id) => Some(id),
                None => {
                    return (StatusCode::BAD_REQUEST, "terminal window id is required")
                        .into_response()
                }
            },
            None => None,
        };
        RestartOverrides {
            tab_name,
            tab_group,
            window_id,
            command: body.command,
            env: body.env,
        }
    } else {
        RestartOverrides::default()
    };
    match state.terminal_sessions.restart(&session, overrides) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => (StatusCode::NOT_FOUND, "terminal session not found").into_response(),
        Err(CreateError::Capped) => {
            (StatusCode::CONFLICT, "terminal session cap reached").into_response()
        }
        Err(CreateError::FdPressure(e)) => {
            (StatusCode::SERVICE_UNAVAILABLE, e.to_string()).into_response()
        }
        Err(CreateError::Spawn(e)) => (
            StatusCode::BAD_REQUEST,
            format!("failed to restart terminal: {e}"),
        )
            .into_response(),
    }
}

pub async fn api_delete_terminal(
    State(state): State<Arc<AppState>>,
    AxumPath(session): AxumPath<String>,
) -> Response {
    if state
        .terminal_sessions
        .close(&session, CloseReason::Explicit)
    {
        StatusCode::NO_CONTENT.into_response()
    } else {
        (StatusCode::NOT_FOUND, "terminal session not found").into_response()
    }
}

#[derive(Debug, Deserialize)]
pub struct SetBroadcastBody {
    on: bool,
}

/// `POST /api/terminals/{session}/broadcast`: set a terminal's broadcast
/// toggle from ANOTHER window. The broadcast state is owned by the SPA window
/// hosting the session (its tab drives the `set-broadcast` WS frame), so this
/// does not flip the flag directly; it routes a `terminal_broadcast`
/// window-command back to the OWNING window over `/ws`, and that window flips
/// its tab (which re-syncs the flag + lights the sign). Lets the broadcast
/// menu's Select All / per-row toggles act on same-group terminals in other
/// windows, not just the local layout. 404 when no live session matches or it
/// has no owning window (not remote-controllable).
pub async fn api_set_terminal_broadcast(
    State(state): State<Arc<AppState>>,
    AxumPath(session): AxumPath<String>,
    body: Result<Json<SetBroadcastBody>, JsonRejection>,
) -> Response {
    let Json(body) = match body {
        Ok(body) => body,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                format!("invalid broadcast toggle: {e}"),
            )
                .into_response()
        }
    };
    let window_id = match state.terminal_sessions.session_window_id(&session) {
        Some(Some(window_id)) => window_id,
        Some(None) => {
            return (
                StatusCode::NOT_FOUND,
                "terminal session has no owning window",
            )
                .into_response()
        }
        None => return (StatusCode::NOT_FOUND, "terminal session not found").into_response(),
    };
    // Same envelope as control_socket's window commands: `{type, window_id,
    // command, ...}`. Built inline (the WindowCommand enum is private to
    // control_socket) to keep this route decoupled from that module.
    let frame = serde_json::json!({
        "type": "window_command",
        "window_id": window_id,
        "command": "terminal_broadcast",
        "session_id": session,
        "on": body.on,
    });
    let _ = state.events_tx.send(frame.to_string());
    StatusCode::NO_CONTENT.into_response()
}

struct TerminalWsOptions {
    session_id: Option<String>,
    since: Option<u64>,
    size: PtySize,
    tab_name: Option<String>,
    tab_group: Option<String>,
    window_id: Option<String>,
    pane_id: Option<String>,
    side: Option<PaneSide>,
    tab_id: Option<String>,
    generation: Option<u64>,
    mcp_env: bool,
    cwd: Option<PathBuf>,
    command: Option<String>,
    env: BTreeMap<String, String>,
}

fn normalize_terminal_name(name: &str) -> Option<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(128).collect())
}

pub(crate) fn normalize_terminal_command(command: &str) -> Option<String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

pub(crate) fn validate_terminal_env(env: &BTreeMap<String, String>) -> Result<(), String> {
    for key in env.keys() {
        if key.trim().is_empty() || key.contains('=') || key.contains('\0') {
            return Err(format!("invalid terminal env key: {key:?}"));
        }
    }
    for value in env.values() {
        if value.contains('\0') {
            return Err("invalid terminal env value: contains NUL".into());
        }
    }
    Ok(())
}

fn terminal_query_spawn_overrides(
    query: &TerminalQuery,
) -> Result<(Option<String>, BTreeMap<String, String>), String> {
    // Reattach metadata never changes the live session's spawn identity. The
    // SPA omits these fields for a reattach; ignoring them here makes the
    // server-side contract explicit, just like cwd above.
    if query.session.is_some() {
        return Ok((None, BTreeMap::new()));
    }
    let command = match query.command.as_deref() {
        Some(command) => Some(
            normalize_terminal_command(command)
                .ok_or_else(|| "terminal command is required".to_string())?,
        ),
        None => None,
    };
    let env = match query.env.as_deref() {
        Some(env) => serde_json::from_str::<BTreeMap<String, String>>(env)
            .map_err(|e| format!("invalid terminal env: {e}"))?,
        None => BTreeMap::new(),
    };
    validate_terminal_env(&env)?;
    Ok((command, env))
}

async fn terminal_ws(mut socket: WebSocket, state: Arc<AppState>, opts: TerminalWsOptions) {
    state
        .last_activity
        .store(now_unix_secs(), Ordering::Relaxed);

    let create_opts = CreateOptions {
        size: opts.size,
        tab_name: opts.tab_name,
        tab_group: opts.tab_group,
        window_id: opts.window_id,
        mcp_env: opts.mcp_env,
        cwd: opts.cwd,
        command: opts.command,
        env: opts.env,
    };
    let mut session = match state.terminal_sessions.get_or_create_for_ws(
        opts.session_id.as_deref(),
        opts.since,
        create_opts,
        TerminalPlacement {
            pane_id: opts.pane_id,
            side: opts.side,
            tab_id: opts.tab_id,
        },
        opts.generation,
    ) {
        Ok(session) => session,
        Err(CreateError::Capped) => {
            let _ = send_frame(
                &mut socket,
                ServerFrame::Error {
                    message: "terminal session cap reached".into(),
                    reason: Some(CloseReason::Capped.as_str()),
                },
            )
            .await;
            let _ = socket
                .send(Message::Close(Some(CloseFrame {
                    code: 1013,
                    reason: "terminal session cap reached".into(),
                })))
                .await;
            return;
        }
        Err(CreateError::FdPressure(e)) => {
            let message = e.to_string();
            let _ = send_frame(
                &mut socket,
                ServerFrame::Error {
                    message: message.clone(),
                    reason: Some("fd_pressure"),
                },
            )
            .await;
            let _ = socket
                .send(Message::Close(Some(CloseFrame {
                    code: 1013,
                    reason: message.into(),
                })))
                .await;
            return;
        }
        Err(CreateError::Spawn(e)) => {
            let _ = send_frame(
                &mut socket,
                ServerFrame::Error {
                    message: format!("failed to start terminal: {e}"),
                    reason: None,
                },
            )
            .await;
            return;
        }
    };
    let mut shutdown_rx = state.shutdown_rx.clone();

    if send_attach_prelude(&mut socket, &state, &session, opts.size)
        .await
        .is_err()
    {
        return;
    }

    loop {
        tokio::select! {
            biased;
            _ = shutdown_rx.changed() => {
                let _ = socket
                    .send(Message::Close(Some(CloseFrame {
                        code: 1001,
                        reason: "server shutdown".into(),
                    })))
                    .await;
                break;
            }
            msg = socket.recv() => {
                let Some(msg) = msg else {
                    break;
                };
                match msg {
                    Ok(Message::Text(text)) => {
                        match serde_json::from_str::<ClientFrame>(&text) {
                            Ok(ClientFrame::Input { data }) => {
                                session.send_input(data.as_bytes());
                                state.last_activity.store(now_unix_secs(), Ordering::Relaxed);
                            }
                            Ok(ClientFrame::BroadcastInput { data }) => {
                                state.terminal_sessions.broadcast_input_cross_window(
                                    session.id(),
                                    data.as_bytes(),
                                );
                                state.last_activity.store(now_unix_secs(), Ordering::Relaxed);
                            }
                            Ok(ClientFrame::Resize { cols, rows }) => {
                                session.resize(pty_size(Some(cols), Some(rows)));
                                state.last_activity.store(now_unix_secs(), Ordering::Relaxed);
                            }
                            Ok(ClientFrame::Cwd) => {
                                let (cwd, cwd_rel) = terminal_cwd_payload_blocking(
                                    state.try_workspace().ok(),
                                    session.blocking_cwd_probe(),
                                )
                                .await;
                                let _ = send_frame(&mut socket, ServerFrame::Cwd { cwd, cwd_rel }).await;
                            }
                            Ok(ClientFrame::Focus { focused }) => {
                                session.set_focused(focused);
                                state.last_activity.store(now_unix_secs(), Ordering::Relaxed);
                            }
                            Ok(ClientFrame::SetBroadcast { on }) => {
                                session.set_broadcast(on);
                                // The toggle is a session-field change the
                                // registry map does not see, so nudge the
                                // roster broadcaster explicitly.
                                state.terminal_sessions.notify_roster_change();
                                state.last_activity.store(now_unix_secs(), Ordering::Relaxed);
                            }
                            Ok(ClientFrame::Placement {
                                pane_id,
                                side,
                                tab_id,
                            }) => {
                                state.terminal_sessions.update_session_layout(
                                    session.id(),
                                    pane_id.and_then(|id| normalize_layout_id(&id)),
                                    side,
                                    tab_id.and_then(|id| normalize_layout_id(&id)),
                                );
                            }
                            Ok(ClientFrame::Rename { name, group }) => {
                                let result = rename_terminal_session(
                                    &state.terminal_sessions,
                                    session.id(),
                                    &name,
                                    group.as_deref(),
                                );
                                let frame = match result {
                                    Ok(metadata) => ServerFrame::Renamed {
                                        name: metadata
                                            .name
                                            .expect("settled terminal rename has a name"),
                                        group: metadata.group,
                                    },
                                    Err(message) => ServerFrame::RenameFailed { message },
                                };
                                let _ = send_frame(&mut socket, frame).await;
                                state.last_activity.store(now_unix_secs(), Ordering::Relaxed);
                            }
                            Ok(ClientFrame::Close) => {
                                let id = session.id().to_owned();
                                state.terminal_sessions.close(&id, CloseReason::Explicit);
                            }
                            Ok(ClientFrame::Prompt { data, agent, id }) => {
                                // Rich Prompt bubble: resolve the target agent's
                                // submit spec (default claude when omitted),
                                // then ENQUEUE logical text onto the shared write queue so it
                                // serializes with `cs terminal write` pokes and
                                // submits when the agent is idle.
                                let submit = SubmitAgent::from_agent_name(
                                    agent.as_deref().unwrap_or("claude"),
                                )
                                .map(ResolvedSubmit::resolve);
                                let outcome = session.enqueue_prompt(data, submit, id.clone());
                                if let Some(id) = id {
                                    let frame = match outcome {
                                        Some(depth) => ServerFrame::PromptAck {
                                            id,
                                            queued: true,
                                            depth,
                                        },
                                        None => ServerFrame::PromptAck {
                                            id,
                                            queued: false,
                                            depth: session.queue_depth(),
                                        },
                                    };
                                    let _ = send_frame(&mut socket, frame).await;
                                }
                                state.last_activity.store(now_unix_secs(), Ordering::Relaxed);
                            }
                            Ok(ClientFrame::CancelPrompt { id }) => {
                                // Recall a still-queued Rich Prompt message. The
                                // retain-filter is authoritative under the queue
                                // lock; ack removed / already-drained so the SPA
                                // never recalls a message that already hit the
                                // PTY. On a removal, cancel_prompt re-broadcasts
                                // QueueDepth -> the `queue` frame below re-syncs
                                // the badge, so we only send the inline ack here.
                                let removed = session.cancel_prompt(&id);
                                let _ = send_frame(
                                    &mut socket,
                                    ServerFrame::PromptCancelled { id, removed },
                                )
                                .await;
                                state.last_activity.store(now_unix_secs(), Ordering::Relaxed);
                            }
                            Ok(ClientFrame::Ping) => {
                                // Heartbeat only: answer on this socket and
                                // count it as activity (a pinging tab is a
                                // live tab, matching the watcher socket's
                                // ping). Nothing reaches the PTY or the
                                // prompt queue.
                                let _ = send_frame(&mut socket, ServerFrame::Pong).await;
                                state.last_activity.store(now_unix_secs(), Ordering::Relaxed);
                            }
                            Err(e) => {
                                let _ = send_frame(
                                    &mut socket,
                                    ServerFrame::Error {
                                        message: format!("invalid terminal frame: {e}"),
                                        reason: None,
                                    },
                                )
                                .await;
                            }
                        }
                    }
                    Ok(Message::Close(_)) => break,
                    Ok(Message::Ping(_)) | Ok(Message::Pong(_)) | Ok(Message::Binary(_)) => {}
                    Err(_) => break,
                }
            }
            event = session.rx.recv() => {
                match event {
                    Ok(SessionEvent::Output(data)) => {
                        if socket.send(Message::binary(data)).await.is_err() {
                            break;
                        }
                        state.last_activity.store(now_unix_secs(), Ordering::Relaxed);
                    }
                    Ok(SessionEvent::Activity { bytes_since_focus }) => {
                        if send_frame(&mut socket, ServerFrame::Activity { bytes_since_focus }).await.is_err() {
                            break;
                        }
                    }
                    Ok(SessionEvent::QueueDepth(depth)) => {
                        if send_frame(&mut socket, ServerFrame::Queue { depth }).await.is_err() {
                            break;
                        }
                    }
                    Ok(SessionEvent::PromptDelivered { id, depth }) => {
                        if send_frame(&mut socket, ServerFrame::PromptDelivered { id, depth }).await.is_err() {
                            break;
                        }
                    }
                    Ok(SessionEvent::Resize(size)) => {
                        if send_frame(&mut socket, ServerFrame::Resize { cols: size.cols, rows: size.rows }).await.is_err() {
                            break;
                        }
                    }
                    Ok(SessionEvent::Exit(exit)) => {
                        let id = session.id().to_owned();
                        state.terminal_sessions.remove(&id);
                        let _ = send_frame(&mut socket, ServerFrame::Exit { code: exit.wire_code() }).await;
                        break;
                    }
                    Ok(SessionEvent::Error(message)) => {
                        if send_frame(&mut socket, ServerFrame::Error { message, reason: None }).await.is_err() {
                            break;
                        }
                    }
                    Ok(SessionEvent::Closed(reason)) => {
                        let _ = send_frame(&mut socket, ServerFrame::Closed { reason }).await;
                        break;
                    }
                    Ok(SessionEvent::Restarted) => {
                        // The session was restarted in place under the same id.
                        // Re-attach this socket to the relaunched session and
                        // replay it over a reset screen, so the tab stays put and
                        // transparently shows the new shell (no Closed/Exit ⇒ the
                        // SPA never drops it). If the relaunched session is gone,
                        // fall through to a normal teardown.
                        let id = session.id().to_owned();
                        match state.terminal_sessions.attach_for_ws(&id, None) {
                            Some(next) => {
                                session = next;
                                if socket
                                    .send(Message::binary(RESET_TERMINAL))
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                                if send_attach_prelude(&mut socket, &state, &session, opts.size)
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                            }
                            None => break,
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let _ = send_frame(
                            &mut socket,
                            ServerFrame::Error {
                                message: "terminal output lagged; reconnect to replay retained scrollback".into(),
                                reason: None,
                            },
                        )
                        .await;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}

/// Send the post-attach prelude for `session`: the session-control frame, the
/// retained scrollback replay, the alt-screen prelude, a redraw nudge, and the
/// `Ready` frame. Used on first attach and on an in-place restart re-attach.
/// Any socket send failure returns `Err(())` so the caller tears the
/// connection down.
async fn send_attach_prelude(
    socket: &mut WebSocket,
    state: &AppState,
    session: &AttachHandle,
    size: PtySize,
) -> Result<(), ()> {
    if send_frame(socket, session_frame(session)).await.is_err() {
        return Err(());
    }
    for chunk in &session.replay {
        if socket.send(Message::binary(chunk.clone())).await.is_err() {
            return Err(());
        }
    }
    if session.alt_screen
        && socket
            .send(Message::binary(ALT_SCREEN_ATTACH_PRELUDE))
            .await
            .is_err()
    {
        return Err(());
    }
    // Re-assert the live private-mode set (DECCKM + mouse + bracketed paste the
    // foreground program set but won't re-announce after a reattach), so a fresh
    // client whose terminal came up at defaults regains them -- otherwise arrows
    // stop navigating (DECCKM) and the wheel/clicks stop reaching the program
    // (mouse), the htop-after-reload bug. Empty for a plain shell. Sent after the
    // alt-screen prelude (alt buffer active first) and before the redraw nudge
    // (the repaint then lands with the modes already set).
    if !session.mode_reassert.is_empty()
        && socket
            .send(Message::binary(session.mode_reassert.clone()))
            .await
            .is_err()
    {
        return Err(());
    }
    session.request_redraw();
    let (cwd, cwd_rel) =
        terminal_cwd_payload_blocking(state.try_workspace().ok(), session.blocking_cwd_probe())
            .await;
    if send_frame(
        socket,
        ServerFrame::Ready {
            cols: size.cols,
            rows: size.rows,
            cwd,
            cwd_rel,
        },
    )
    .await
    .is_err()
    {
        return Err(());
    }
    Ok(())
}

fn session_frame(session: &AttachHandle) -> ServerFrame {
    let submit_agent = SubmitAgent::derive(
        session.spawn_command().unwrap_or_default(),
        session.spawn_env("CHAN_AGENT"),
    )
    .map(SubmitAgent::name);
    let metadata = session.live_metadata();
    ServerFrame::Session {
        id: session.id().to_owned(),
        name: metadata.name,
        group: metadata.group,
        spawn_name: session.spawn_name().map(str::to_string),
        spawn_group: session.spawn_group().map(str::to_string),
        seq: session.seq,
        generation: session.generation,
        missed_bytes: session.missed_bytes,
        bytes_since_focus: session.bytes_since_focus(),
        queue_depth: session.queue_depth(),
        queued_prompt_ids: session.queued_prompt_ids(),
        submit_agent,
    }
}

fn rename_terminal_session(
    registry: &crate::terminal_sessions::Registry,
    session_id: &str,
    name: &str,
    group: Option<&str>,
) -> Result<crate::terminal_sessions::LiveTerminalMetadata, String> {
    let Some(name) = normalize_tab_name(name) else {
        return Err("terminal name is required".to_string());
    };
    let group = group.and_then(normalize_tab_group);
    registry
        .update_live_metadata(session_id, name, group)
        .ok_or_else(|| "terminal session is no longer live".to_string())
}

async fn send_frame(socket: &mut WebSocket, frame: ServerFrame) -> Result<(), axum::Error> {
    socket
        .send(Message::text(serde_json::to_string(&frame).unwrap_or_else(
            |e| format!(r#"{{"type":"error","message":"serialize failed: {e}"}}"#),
        )))
        .await
}

fn path_to_wire(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

fn terminal_cwd_payload(
    workspace: Option<&chan_workspace::Workspace>,
    cwd: Option<PathBuf>,
) -> (Option<String>, Option<String>) {
    match cwd {
        Some(path) => {
            // Workspace-relative display path only when a workspace is bound;
            // a standalone terminal window has none, so it shows the absolute
            // cwd with no virtual rel.
            let rel = workspace.and_then(|w| w.physical_path_to_virtual(&path));
            (Some(path_to_wire(path)), rel)
        }
        None => (None, None),
    }
}

async fn terminal_cwd_payload_blocking<C>(
    workspace: Option<Arc<chan_workspace::Workspace>>,
    cwd_probe: C,
) -> (Option<String>, Option<String>)
where
    C: FnOnce() -> Option<PathBuf> + Send + 'static,
{
    terminal_cwd_payload_blocking_with_hook(workspace, cwd_probe, || {}).await
}

async fn terminal_cwd_payload_blocking_with_hook<C, H>(
    workspace: Option<Arc<chan_workspace::Workspace>>,
    cwd_probe: C,
    before_mapping: H,
) -> (Option<String>, Option<String>)
where
    C: FnOnce() -> Option<PathBuf> + Send + 'static,
    H: FnOnce() + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let cwd = cwd_probe();
        before_mapping();
        terminal_cwd_payload(workspace.as_deref(), cwd)
    })
    .await
    .unwrap_or((None, None))
}

fn pty_size(cols: Option<u16>, rows: Option<u16>) -> PtySize {
    PtySize {
        cols: cols.unwrap_or(DEFAULT_COLS).clamp(1, MAX_COLS),
        rows: rows.unwrap_or(DEFAULT_ROWS).clamp(1, MAX_ROWS),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn normalize_tab_name(name: &str) -> Option<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(128).collect())
}

fn normalize_window_id(id: &str) -> Option<String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(256).collect())
}

/// Normalize an opaque SPA layout id (pane or tab) the same way as a window id:
/// trim, drop blank, cap length. These are best-effort placement labels carried
/// for `cs terminal list`, not validated against any registry.
fn normalize_layout_id(id: &str) -> Option<String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(256).collect())
}

/// Normalize a broadcast group. Blank / "default" resolve to `None` so the
/// server treats the default group as the absence of an explicit group
/// (mirrors the SPA wire, which omits the default).
fn normalize_tab_group(group: &str) -> Option<String> {
    let trimmed = group.trim();
    if trimmed.is_empty() || trimmed == "default" {
        return None;
    }
    Some(trimmed.chars().take(128).collect())
}

fn resolve_terminal_cwd(
    workspace: &chan_workspace::Workspace,
    cwd: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    workspace
        .ensure_root_available()
        .map_err(|error| format!("invalid terminal cwd: {error}"))?;
    let Some(raw) = cwd else {
        return Ok(None);
    };
    let rel = raw.trim();
    workspace
        .resolve_physical_dir(rel)
        .map(Some)
        .map_err(|e| format!("invalid terminal cwd: {e}"))
}

/// `GET /api/terminal/next-name`: hand out the next per-tenant default
/// terminal name (`Terminal-1`, `Terminal-2`, ...). The counter lives on the
/// per-tenant terminal registry, so it does the right thing in BOTH modes:
/// every standalone terminal window shares one registry -> one global
/// sequence; each workspace has its own registry -> a per-workspace sequence
/// (a process-global static restarted at 1 for a second workspace window).
/// The SPA calls this for default terminal names in both modes. Plain-text
/// body.
pub async fn api_terminal_next_name(State(state): State<Arc<AppState>>) -> Response {
    state.terminal_sessions.next_terminal_name().into_response()
}

#[derive(Debug, Serialize)]
struct RosterResponse {
    sessions: Vec<crate::terminal_sessions::RosterEntry>,
}

/// `GET /api/terminals/roster`: a one-shot snapshot of every live session in
/// this tenant, for the SPA to seed its cross-window roster on `/ws`
/// (re)connect. Live updates then arrive as `terminal_roster` frames over
/// `/ws` (see [`spawn_roster_broadcaster`]); the endpoint closes the
/// reconnect gap where a window misses the last push.
pub async fn api_terminals_roster(State(state): State<Arc<AppState>>) -> Response {
    Json(RosterResponse {
        sessions: state.terminal_sessions.roster(),
    })
    .into_response()
}

/// The `terminal_roster` `/ws` envelope: a full roster snapshot the SPA
/// applies wholesale (idempotent, no delta reconciliation). Same `sessions`
/// shape as [`RosterResponse`] so one client handler serves both the seed
/// and the live push.
#[derive(Debug, Serialize)]
struct RosterFrame<'a> {
    #[serde(rename = "type")]
    frame_type: &'static str,
    sessions: &'a [crate::terminal_sessions::RosterEntry],
}

/// Republish the terminal roster onto the global `/ws` bus whenever it
/// changes. Awaits the registry's roster-change `Notify` (coalescing bursts
/// into one push) and sends a `terminal_roster` snapshot to every connected
/// window. A sibling of the registry's pruner/drainer tasks: own task,
/// shuts down on the same signal. A send error means no `/ws` client is
/// connected; the next connect re-seeds via `GET /api/terminals/roster`.
pub fn spawn_roster_broadcaster(
    registry: Arc<crate::terminal_sessions::Registry>,
    events_tx: tokio::sync::broadcast::Sender<String>,
    mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    let notify = registry.roster_notify();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => break,
                _ = notify.notified() => {
                    let sessions = registry.roster();
                    let frame = RosterFrame {
                        frame_type: "terminal_roster",
                        sessions: &sessions,
                    };
                    if let Ok(raw) = serde_json::to_string(&frame) {
                        let _ = events_tx.send(raw);
                    }
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::TerminalConfig;
    use crate::terminal_sessions::{AttachHandle, Registry, RegistryConfig};
    use axum::body::to_bytes;
    use std::fs;
    use std::process::Command;
    use std::time::{Duration, Instant};

    // The terminal heartbeat vocabulary is shared with the watcher socket
    // (routes/ws.rs): client `{"type":"ping"}` -> server `{"type":"pong"}`.
    // Old servers (no `Ping` variant) answer it with an `error` frame the SPA
    // tolerates; old clients never send it, so the skew is safe both ways.
    #[test]
    fn ping_frame_parses_to_the_heartbeat_variant() {
        assert!(matches!(
            serde_json::from_str::<ClientFrame>(r#"{"type":"ping"}"#),
            Ok(ClientFrame::Ping)
        ));
    }

    #[test]
    fn placement_frame_decodes_pane_side_and_tab() {
        let frame: ClientFrame = serde_json::from_str(
            r#"{"type":"placement","pane_id":"pane-4","side":"b","tab_id":"tab-7"}"#,
        )
        .expect("placement frame");
        match frame {
            ClientFrame::Placement {
                pane_id,
                side,
                tab_id,
            } => {
                assert_eq!(pane_id.as_deref(), Some("pane-4"));
                assert_eq!(side, Some(PaneSide::B));
                assert_eq!(tab_id.as_deref(), Some("tab-7"));
            }
            other => panic!("expected placement, got {other:?}"),
        }
        assert!(
            serde_json::from_str::<ClientFrame>(
                r#"{"type":"placement","pane_id":"pane-4","side":"c"}"#
            )
            .is_err(),
            "unknown Hybrid sides must not be accepted silently"
        );
    }

    #[test]
    fn terminal_query_spawn_overrides_validate_and_ignore_reattach_metadata() {
        let query = TerminalQuery {
            command: Some("  sleep 5  ".into()),
            env: Some(r#"{"CHAN_AGENT":"codex","TOKEN":"a=b"}"#.into()),
            ..TerminalQuery::default()
        };
        let (command, env) = terminal_query_spawn_overrides(&query).unwrap();
        assert_eq!(command.as_deref(), Some("sleep 5"));
        assert_eq!(env.get("CHAN_AGENT").map(String::as_str), Some("codex"));
        assert_eq!(env.get("TOKEN").map(String::as_str), Some("a=b"));

        assert!(terminal_query_spawn_overrides(&TerminalQuery {
            command: Some("   ".into()),
            ..TerminalQuery::default()
        })
        .unwrap_err()
        .contains("command is required"));
        assert!(terminal_query_spawn_overrides(&TerminalQuery {
            env: Some("not-json".into()),
            ..TerminalQuery::default()
        })
        .unwrap_err()
        .contains("invalid terminal env"));

        let (command, env) = terminal_query_spawn_overrides(&TerminalQuery {
            session: Some("existing".into()),
            command: Some("   ".into()),
            env: Some("not-json".into()),
            ..TerminalQuery::default()
        })
        .unwrap();
        assert_eq!(command, None);
        assert!(env.is_empty());
    }

    // Pins the server -> client `pong` bytes, mirroring ws.rs's
    // `pong_frame_is_the_pinned_wire_shape`: the SPA terminal transport's
    // read-deadline parses this exact object, so the shape must not drift.
    #[test]
    fn pong_frame_is_the_pinned_wire_shape() {
        assert_eq!(
            serde_json::to_string(&ServerFrame::Pong).unwrap(),
            r#"{"type":"pong"}"#
        );
    }

    struct TestTerminal {
        _registry: Registry,
        handle: AttachHandle,
    }

    impl TestTerminal {
        /// Run one drainer tick against this terminal's registry, the same
        /// call `Registry::spawn_drainer` makes on its interval.
        fn drain(&self) {
            self._registry.drain_writes();
        }

        fn spawn(
            cwd: std::path::PathBuf,
            size: PtySize,
            tab_name: Option<String>,
            mcp_socket_path: Option<std::path::PathBuf>,
        ) -> Self {
            Self::spawn_with_mcp_env(cwd, size, tab_name, mcp_socket_path, true)
        }

        fn spawn_with_mcp_env(
            cwd: std::path::PathBuf,
            size: PtySize,
            tab_name: Option<String>,
            mcp_socket_path: Option<std::path::PathBuf>,
            mcp_env: bool,
        ) -> Self {
            let registry = Registry::new(RegistryConfig {
                workspace_root: cwd,
                mcp_socket_path,
                control_socket_path: Some(std::path::PathBuf::from("/tmp/chan-control-test.sock")),
                terminal: TerminalConfig::default(),
            });
            let handle = registry
                .create(CreateOptions {
                    size,
                    tab_name,
                    tab_group: None,
                    window_id: Some("window-test".into()),
                    mcp_env,
                    cwd: None,
                    command: None,
                    env: Default::default(),
                })
                .expect("spawn pty");
            Self {
                _registry: registry,
                handle,
            }
        }
    }

    // The Rich Prompt wire contract: an omitted agent means claude, a tagged
    // enqueue acks immediately with its queue position, and `prompt-delivered`
    // fires only once the drainer hands the message to the PTY.
    #[tokio::test]
    async fn prompt_frame_defaults_to_claude_and_delivers_only_on_drain() {
        let frame: ClientFrame =
            serde_json::from_str(r#"{"type":"prompt","data":"hi","id":"m1"}"#).expect("prompt");
        let ClientFrame::Prompt { data, agent, id } = frame else {
            panic!("expected a prompt frame");
        };
        assert_eq!(data, "hi");
        assert_eq!(agent, None, "the SPA may omit the agent");
        assert_eq!(id.as_deref(), Some("m1"));
        // The route's default: an omitted agent resolves to claude.
        let submit = SubmitAgent::from_agent_name(agent.as_deref().unwrap_or("claude"))
            .map(ResolvedSubmit::resolve)
            .expect("claude is a known agent");
        assert_eq!(submit.agent, SubmitAgent::Claude);

        let root = tempfile::TempDir::new().expect("temp workspace");
        let mut terminal = TestTerminal::spawn(
            root.path().to_path_buf(),
            PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            },
            Some("prompt-drain".into()),
            None,
        );

        assert_eq!(
            terminal
                .handle
                .enqueue_prompt(data, Some(submit), Some("m1".into())),
            Some(1),
            "a tagged enqueue acks with its 1-based message position"
        );
        assert_eq!(terminal.handle.queued_prompt_ids(), vec!["m1".to_string()]);
        assert_eq!(terminal.handle.queue_depth(), 1);
        // The shell has just rendered its prompt, so the agent is not idle and
        // a drain tick delivers nothing.
        terminal.drain();
        assert_eq!(
            terminal.handle.queue_depth(),
            1,
            "a busy session holds the message"
        );

        // Tick until the output goes quiet and the drainer delivers.
        let deadline = Instant::now() + PROBE_BUDGET;
        let mut delivered = None;
        while Instant::now() < deadline && delivered.is_none() {
            terminal.drain();
            while let Ok(event) = terminal.handle.rx.try_recv() {
                if let SessionEvent::PromptDelivered { id, depth } = event {
                    delivered = Some((id, depth));
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(
            delivered,
            Some(("m1".to_string(), 0)),
            "prompt-delivered fires on the drain, with the remaining depth"
        );
        assert_eq!(terminal.handle.queue_depth(), 0);
        assert!(
            terminal.handle.queued_prompt_ids().is_empty(),
            "a delivered message is no longer cancellable"
        );
        assert!(
            !terminal.handle.cancel_prompt("m1"),
            "recall after delivery is honestly refused"
        );
    }

    fn command_available(name: &str) -> bool {
        Command::new("sh")
            .arg("-lc")
            .arg(format!("command -v {name} >/dev/null 2>&1"))
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// Well-known lock-file name (under the OS temp dir) for the
    /// cross-process FS-timing test gate. MUST stay identical to
    /// `chan_workspace::test_gate::GATE_FILE` and the copy in the indexer
    /// test module so every FS-timing test across both crates' separate
    /// test binaries contends on the same OS advisory lock.
    const FS_TIMING_GATE: &str = "chan-fs-timing-test.gate";

    /// Cross-process serial gate for the real-PTY shell-probe tests.
    /// Each spawns a real shell on a PTY, sends commands, and asserts on
    /// the shell's output. Correctness under load comes from the
    /// marker-window harvest (collect_marker_window: runtime-built
    /// markers, echo excluded); this gate keeps the probes from
    /// stacking real-shell load on each other and on the FS-timing
    /// tests, so they finish well inside PROBE_BUDGET.
    ///
    /// WHY a FILE lock and not a `static`/`tokio` Mutex: a `static` lock
    /// serializes only tests WITHIN this test binary, but `cargo test`
    /// runs each crate's test binary as a SEPARATE PROCESS concurrently,
    /// so these PTY tests still race chan-workspace's FS-watcher tests and
    /// this crate's indexer boot-walk tests for the CPU. An OS advisory
    /// lock on a well-known temp path spans process boundaries; opening
    /// the SAME `FS_TIMING_GATE` path here, in the indexer test module,
    /// and in chan-workspace (`crate::test_gate`) makes one named gate
    /// serialize the entire FS-timing class workspace-wide. The
    /// `std::fs::File` guard is `Send` (held across `.await` on the
    /// multi-thread runtime is fine) and releases on drop / process
    /// exit.
    fn pty_test_lock() -> std::fs::File {
        let path = std::env::temp_dir().join(FS_TIMING_GATE);
        let file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(&path)
            .expect("open FS-timing test gate file");
        file.lock().expect("acquire FS-timing test gate");
        file
    }

    /// Wait budget for a real-PTY shell probe to emit its end marker. On
    /// an idle host the shell echoes the marker in well under a second,
    /// so this ceiling is never approached; it only governs the worst
    /// case under the full parallel suite, where shell scheduling slips
    /// by seconds. The cross-process `pty_test_lock` gate is the primary
    /// fix (it removes the competing FS-timing load); this budget is the
    /// backstop and should rarely be approached now.
    const PROBE_BUDGET: Duration = Duration::from_secs(30);

    fn terminal_workspace_fixture() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        Arc<chan_workspace::Workspace>,
    ) {
        let cfg = tempfile::TempDir::new().expect("temp config");
        let root = tempfile::TempDir::new().expect("temp workspace");
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        (cfg, root, workspace)
    }

    #[test]
    fn client_frame_prompt_decodes_with_optional_agent_and_id() {
        // The Rich Prompt contract: { type: "prompt", data, agent?, id? }.
        // A Rust rename of the tag / fields would break the bubble's wire at
        // runtime with a green build, so pin the decode.
        let tagged: ClientFrame =
            serde_json::from_str(r#"{"type":"prompt","data":"hi","agent":"codex","id":"u-1"}"#)
                .unwrap();
        match tagged {
            ClientFrame::Prompt { data, agent, id } => {
                assert_eq!(data, "hi");
                assert_eq!(agent.as_deref(), Some("codex"));
                assert_eq!(id.as_deref(), Some("u-1"));
            }
            other => panic!("expected Prompt, got {other:?}"),
        }
        // agent and id omitted -> None (chord defaults to claude; no id
        // means legacy fire-and-forget: no ack, no delivered event -- the
        // team orchestrator's lead-identity prompt depends on this).
        let bare: ClientFrame = serde_json::from_str(r#"{"type":"prompt","data":"yo"}"#).unwrap();
        match bare {
            ClientFrame::Prompt { data, agent, id } => {
                assert_eq!(data, "yo");
                assert!(agent.is_none());
                assert!(id.is_none());
            }
            other => panic!("expected Prompt, got {other:?}"),
        }
    }

    #[test]
    fn server_frame_queue_wire_shapes() {
        // The SPA's frame handler switches on these exact tags + field
        // names; a Rust rename would break the wire at runtime with a green
        // build, so pin the serialized JSON byte-for-byte.
        let ack_queued = ServerFrame::PromptAck {
            id: "u-1".into(),
            queued: true,
            depth: 2,
        };
        assert_eq!(
            serde_json::to_string(&ack_queued).unwrap(),
            r#"{"type":"prompt-ack","id":"u-1","queued":true,"depth":2}"#
        );
        let ack_rejected = ServerFrame::PromptAck {
            id: "u-2".into(),
            queued: false,
            depth: 100,
        };
        assert_eq!(
            serde_json::to_string(&ack_rejected).unwrap(),
            r#"{"type":"prompt-ack","id":"u-2","queued":false,"depth":100}"#
        );
        let delivered = ServerFrame::PromptDelivered {
            id: "u-1".into(),
            depth: 1,
        };
        assert_eq!(
            serde_json::to_string(&delivered).unwrap(),
            r#"{"type":"prompt-delivered","id":"u-1","depth":1}"#
        );
        let queue = ServerFrame::Queue { depth: 3 };
        assert_eq!(
            serde_json::to_string(&queue).unwrap(),
            r#"{"type":"queue","depth":3}"#
        );
        let session = ServerFrame::Session {
            id: "abc".into(),
            name: Some("live".into()),
            group: "group".into(),
            spawn_name: Some("spawn".into()),
            spawn_group: Some("spawn-group".into()),
            seq: 7,
            generation: 3,
            missed_bytes: 0,
            bytes_since_focus: 0,
            queue_depth: 2,
            queued_prompt_ids: vec!["u-1".into(), "u-2".into()],
            submit_agent: Some("opencode"),
        };
        assert_eq!(
            serde_json::to_string(&session).unwrap(),
            r#"{"type":"session","id":"abc","name":"live","group":"group","spawn_name":"spawn","spawn_group":"spawn-group","seq":7,"generation":3,"missed_bytes":0,"bytes_since_focus":0,"queue_depth":2,"queued_prompt_ids":["u-1","u-2"],"submit_agent":"opencode"}"#
        );
        // Empty list still serializes as `[]` (always present; the SPA can
        // assume the field exists -- pre-release, no back-compat).
        let session_empty = ServerFrame::Session {
            id: "abc".into(),
            name: None,
            group: "default".into(),
            spawn_name: None,
            spawn_group: None,
            seq: 0,
            generation: 0,
            missed_bytes: 0,
            bytes_since_focus: 0,
            queue_depth: 0,
            queued_prompt_ids: vec![],
            submit_agent: None,
        };
        assert_eq!(
            serde_json::to_string(&session_empty).unwrap(),
            r#"{"type":"session","id":"abc","name":null,"group":"default","spawn_name":null,"spawn_group":null,"seq":0,"generation":0,"missed_bytes":0,"bytes_since_focus":0,"queue_depth":0,"queued_prompt_ids":[]}"#
        );
        // cancel-prompt decode (client→server) -- pin the tag + field so a
        // rename can't silently break the SPA wire with a green build.
        let cancel: ClientFrame =
            serde_json::from_str(r#"{"type":"cancel-prompt","id":"u-1"}"#).unwrap();
        match cancel {
            ClientFrame::CancelPrompt { id } => assert_eq!(id, "u-1"),
            other => panic!("expected CancelPrompt, got {other:?}"),
        }
        // prompt-cancelled serialize (server→client ack).
        let cancelled = ServerFrame::PromptCancelled {
            id: "u-1".into(),
            removed: true,
        };
        assert_eq!(
            serde_json::to_string(&cancelled).unwrap(),
            r#"{"type":"prompt-cancelled","id":"u-1","removed":true}"#
        );
    }

    fn create_identity_session(
        command: &str,
        chan_agent: Option<&str>,
    ) -> (Arc<crate::state::AppState>, AttachHandle) {
        let state = crate::state::test_support::make_test_state(false);
        let mut env = BTreeMap::new();
        if let Some(agent) = chan_agent {
            env.insert("CHAN_AGENT".into(), agent.into());
        }
        let handle = state
            .terminal_sessions
            .create(CreateOptions {
                size: PtySize {
                    cols: 80,
                    rows: 24,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                tab_name: Some("@@Identity".into()),
                tab_group: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                command: Some(command.into()),
                env,
            })
            .expect("spawn identity session");
        (state, handle)
    }

    fn frame_submit_agent(handle: &AttachHandle) -> Option<String> {
        serde_json::to_value(session_frame(handle))
            .expect("serialize session frame")
            .get("submit_agent")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    }

    #[test]
    fn session_frame_reports_command_and_environment_derived_opencode() {
        let (command_state, command_handle) =
            create_identity_session("sleep 5 # opencode-ai", None);
        assert_eq!(
            frame_submit_agent(&command_handle).as_deref(),
            Some("opencode")
        );
        command_state
            .terminal_sessions
            .close(command_handle.id(), CloseReason::Explicit);

        let (env_state, env_handle) = create_identity_session("sleep 5", Some("OpenCode"));
        assert_eq!(frame_submit_agent(&env_handle).as_deref(), Some("opencode"));
        env_state
            .terminal_sessions
            .close(env_handle.id(), CloseReason::Explicit);
    }

    #[test]
    fn websocket_spawn_overrides_derive_agent_for_an_unrecognised_launcher() {
        let query = TerminalQuery {
            command: Some("sleep 5".into()),
            env: Some(r#"{"CHAN_AGENT":"codex"}"#.into()),
            ..TerminalQuery::default()
        };
        let (command, env) = terminal_query_spawn_overrides(&query).unwrap();
        let state = crate::state::test_support::make_test_state(false);
        let forced = state
            .terminal_sessions
            .create(CreateOptions {
                size: pty_size(None, None),
                tab_name: Some("forced".into()),
                tab_group: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                command,
                env,
            })
            .unwrap();
        assert_eq!(frame_submit_agent(&forced).as_deref(), Some("codex"));
        let summary = state
            .terminal_sessions
            .session_summaries()
            .into_iter()
            .find(|summary| summary.session_id == forced.id())
            .unwrap();
        assert_eq!(summary.agent, Some(SubmitAgent::Codex));
        let submitted = state.terminal_sessions.enqueue_write_matching(
            Some("forced"),
            None,
            "poke",
            Some(SubmitAgent::Codex),
        );
        assert_eq!(submitted.queued, 1);
        assert_eq!(submitted.position, Some(1));
        assert!(
            submitted.diverged.is_empty(),
            "matching submit must apply its chord"
        );

        let command_query = TerminalQuery {
            command: Some("sleep 5 # claude".into()),
            ..TerminalQuery::default()
        };
        let (command, env) = terminal_query_spawn_overrides(&command_query).unwrap();
        let command_derived = state
            .terminal_sessions
            .create(CreateOptions {
                size: pty_size(None, None),
                tab_name: Some("command-derived".into()),
                tab_group: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                command,
                env,
            })
            .unwrap();
        assert_eq!(
            frame_submit_agent(&command_derived).as_deref(),
            Some("claude")
        );

        let plain = state
            .terminal_sessions
            .create(CreateOptions {
                size: pty_size(None, None),
                tab_name: Some("plain".into()),
                tab_group: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                command: None,
                env: BTreeMap::new(),
            })
            .unwrap();
        assert_eq!(frame_submit_agent(&plain), None);
        let summary = state
            .terminal_sessions
            .session_summaries()
            .into_iter()
            .find(|summary| summary.session_id == plain.id())
            .unwrap();
        assert_eq!(summary.agent, None);
        let refused = state.terminal_sessions.enqueue_write_matching(
            Some("plain"),
            None,
            "poke",
            Some(SubmitAgent::Codex),
        );
        assert_eq!(refused.queued, 1);
        assert_eq!(refused.diverged.len(), 1, "a shell gets no forced chord");
        state.terminal_sessions.close_all(CloseReason::Explicit);
    }

    #[test]
    fn session_frame_omits_unknown_agent_and_resyncs_restarted_identity() {
        let (state, shell_handle) = create_identity_session("sleep 5", None);
        assert_eq!(frame_submit_agent(&shell_handle), None);
        state
            .terminal_sessions
            .close(shell_handle.id(), CloseReason::Explicit);

        let (state, initial) = create_identity_session("sleep 5 # claude", None);
        let id = initial.id().to_string();
        assert_eq!(frame_submit_agent(&initial).as_deref(), Some("claude"));
        state
            .terminal_sessions
            .restart(
                &id,
                RestartOverrides {
                    command: Some("sleep 5 # opencode".into()),
                    ..RestartOverrides::default()
                },
            )
            .expect("restart identity session");
        let restarted = state
            .terminal_sessions
            .attach(&id, Some(0))
            .expect("attach restarted session");
        assert_eq!(frame_submit_agent(&restarted).as_deref(), Some("opencode"));
        let reattached = state
            .terminal_sessions
            .attach(&id, Some(0))
            .expect("reattach restarted session");
        assert_eq!(frame_submit_agent(&reattached).as_deref(), Some("opencode"));
        state.terminal_sessions.close(&id, CloseReason::Explicit);
    }

    #[test]
    fn client_frame_set_broadcast_decodes() {
        // The broadcast toggle-sync contract: { type: "set-broadcast", on }.
        // A Rust rename of the tag / field would break the SPA's wire at
        // runtime with a green build, so pin the decode.
        let on: ClientFrame =
            serde_json::from_str(r#"{"type":"set-broadcast","on":true}"#).unwrap();
        match on {
            ClientFrame::SetBroadcast { on } => assert!(on),
            other => panic!("expected SetBroadcast, got {other:?}"),
        }
        let off: ClientFrame =
            serde_json::from_str(r#"{"type":"set-broadcast","on":false}"#).unwrap();
        match off {
            ClientFrame::SetBroadcast { on } => assert!(!on),
            other => panic!("expected SetBroadcast, got {other:?}"),
        }
    }

    #[test]
    fn terminal_rename_frames_pin_the_atomic_wire_contract() {
        let proposed: ClientFrame =
            serde_json::from_str(r#"{"type":"rename","name":"requested","group":"workers"}"#)
                .unwrap();
        match proposed {
            ClientFrame::Rename { name, group } => {
                assert_eq!(name, "requested");
                assert_eq!(group.as_deref(), Some("workers"));
            }
            other => panic!("expected Rename, got {other:?}"),
        }
        assert_eq!(
            serde_json::to_string(&ServerFrame::Renamed {
                name: "settled-2".into(),
                group: "workers".into(),
            })
            .unwrap(),
            r#"{"type":"renamed","name":"settled-2","group":"workers"}"#
        );
        assert_eq!(
            serde_json::to_string(&ServerFrame::RenameFailed {
                message: "terminal name is required".into(),
            })
            .unwrap(),
            r#"{"type":"rename_failed","message":"terminal name is required"}"#
        );
    }

    #[test]
    fn terminal_rename_ack_uses_settled_pair_and_failure_preserves_live_metadata() {
        let state = crate::state::test_support::make_test_state(false);
        let create = |name: &str| CreateOptions {
            size: pty_size(None, None),
            tab_name: Some(name.into()),
            tab_group: None,
            window_id: None,
            mcp_env: false,
            cwd: None,
            command: Some("sleep 5".into()),
            env: Default::default(),
        };
        let first = state.terminal_sessions.create(create("taken")).unwrap();
        let second = state.terminal_sessions.create(create("other")).unwrap();

        let settled = rename_terminal_session(
            &state.terminal_sessions,
            second.id(),
            " taken ",
            Some(" workers "),
        )
        .unwrap();
        assert_eq!(settled.name.as_deref(), Some("taken-2"));
        assert_eq!(settled.group, "workers");
        let roster = state.terminal_sessions.roster();
        let entry = roster.iter().find(|entry| entry.id == second.id()).unwrap();
        assert_eq!(entry.tab_name.as_deref(), Some("taken-2"));
        assert_eq!(entry.tab_group, "workers");

        assert_eq!(
            rename_terminal_session(&state.terminal_sessions, second.id(), " ", None),
            Err("terminal name is required".to_string())
        );
        assert_eq!(second.live_metadata(), settled);
        assert_eq!(
            rename_terminal_session(&state.terminal_sessions, "missing", "name", None),
            Err("terminal session is no longer live".to_string())
        );
        state.terminal_sessions.close_all(CloseReason::Shutdown);
        drop(first);
    }

    #[test]
    fn reattach_prelude_ignores_query_metadata_and_returns_live_and_spawn_pairs() {
        let (state, initial) = create_identity_session("sleep 5", None);
        let id = initial.id().to_string();
        state
            .terminal_sessions
            .update_live_metadata(&id, "live-name".into(), Some("live-group".into()))
            .unwrap();
        let attached = state
            .terminal_sessions
            .get_or_create_for_ws(
                Some(&id),
                Some(0),
                CreateOptions {
                    size: pty_size(None, None),
                    tab_name: Some("query-must-not-win".into()),
                    tab_group: Some("query-group".into()),
                    window_id: None,
                    mcp_env: false,
                    cwd: None,
                    command: None,
                    env: Default::default(),
                },
                TerminalPlacement::default(),
                None,
            )
            .unwrap();
        let frame = serde_json::to_value(session_frame(&attached)).unwrap();
        assert_eq!(frame["name"], "live-name");
        assert_eq!(frame["group"], "live-group");
        assert_eq!(frame["spawn_name"], "@@Identity");
        assert_eq!(frame["spawn_group"], "default");
        state.terminal_sessions.close(&id, CloseReason::Explicit);
    }

    #[tokio::test]
    async fn set_terminal_broadcast_emits_window_command_to_owning_window() {
        // The cross-window toggle routes a `terminal_broadcast` window-command
        // to the session's owning window over the `/ws` bus. Pin the wire
        // shape the SPA's handleWindowCommand decodes.
        let state = crate::state::test_support::make_test_state(false);
        let handle = state
            .terminal_sessions
            .create(CreateOptions {
                size: pty_size(None, None),
                tab_name: Some("Term".into()),
                tab_group: None,
                window_id: Some("win-7".into()),
                mcp_env: false,
                cwd: None,
                command: Some("sleep 5".into()),
                env: Default::default(),
            })
            .expect("spawn");
        let session = handle.id().to_string();
        let mut rx = state.events_tx.subscribe();

        let resp = api_set_terminal_broadcast(
            State(state.clone()),
            AxumPath(session.clone()),
            Ok(Json(SetBroadcastBody { on: true })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);

        let raw = rx.try_recv().expect("window_command frame emitted");
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["type"], "window_command");
        assert_eq!(v["window_id"], "win-7");
        assert_eq!(v["command"], "terminal_broadcast");
        assert_eq!(v["session_id"], session);
        assert_eq!(v["on"], true);

        state
            .terminal_sessions
            .close(&session, CloseReason::Explicit);
    }

    #[tokio::test]
    async fn set_terminal_broadcast_404_for_missing_session() {
        let state = crate::state::test_support::make_test_state(false);
        let resp = api_set_terminal_broadcast(
            State(state),
            AxumPath("nope".into()),
            Ok(Json(SetBroadcastBody { on: true })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn resolve_terminal_cwd_allows_workspace_relative_directory() {
        let (_cfg, root, workspace) = terminal_workspace_fixture();
        fs::create_dir_all(root.path().join("notes/work")).expect("create dir");

        let cwd = resolve_terminal_cwd(&workspace, Some("notes/work"))
            .expect("valid cwd")
            .expect("cwd set");

        assert_eq!(cwd, root.path().canonicalize().unwrap().join("notes/work"));
    }

    #[test]
    fn resolve_terminal_cwd_maps_drafts_dir_to_in_root_path() {
        let (_cfg, _root, workspace) = terminal_workspace_fixture();
        workspace.create_draft_dir("untitled-1").unwrap();

        let cwd = resolve_terminal_cwd(&workspace, Some(".Drafts/untitled-1"))
            .expect("valid cwd")
            .expect("cwd set");

        assert_eq!(cwd, workspace.drafts_dir().join("untitled-1"));
        assert_eq!(
            workspace.physical_path_to_virtual(&cwd),
            Some(".Drafts/untitled-1".to_string())
        );

        let (cwd_abs, cwd_rel) = terminal_cwd_payload(Some(&workspace), Some(cwd.clone()));
        assert!(cwd_abs
            .as_deref()
            .is_some_and(|path| path.ends_with("untitled-1")));
        assert_eq!(cwd_rel.as_deref(), Some(".Drafts/untitled-1"));

        // Workspace-less tenant: absolute cwd, no virtual rel.
        let (cwd_abs_nw, cwd_rel_nw) = terminal_cwd_payload(None, Some(cwd));
        assert!(cwd_abs_nw.is_some());
        assert_eq!(cwd_rel_nw, None);
    }

    #[test]
    fn terminal_cwd_payload_preserves_root_outside_and_missing_cases() {
        let (_cfg, root, workspace) = terminal_workspace_fixture();
        let root_canon = root.path().canonicalize().expect("canonical root");
        let outside = tempfile::TempDir::new().expect("outside directory");
        let outside_canon = outside.path().canonicalize().expect("canonical outside");

        let (root_abs, root_rel) = terminal_cwd_payload(Some(&workspace), Some(root_canon.clone()));
        let root_wire = path_to_wire(root_canon);
        assert_eq!(root_abs.as_deref(), Some(root_wire.as_str()));
        assert_eq!(root_rel.as_deref(), Some(""));

        let (outside_abs, outside_rel) =
            terminal_cwd_payload(Some(&workspace), Some(outside_canon.clone()));
        let outside_wire = path_to_wire(outside_canon);
        assert_eq!(outside_abs.as_deref(), Some(outside_wire.as_str()));
        assert_eq!(outside_rel, None);

        let missing = workspace.root().join("removed-cwd");
        assert!(!missing.exists());
        let (missing_abs, missing_rel) =
            terminal_cwd_payload(Some(&workspace), Some(missing.clone()));
        let missing_wire = path_to_wire(missing);
        assert_eq!(missing_abs.as_deref(), Some(missing_wire.as_str()));
        assert_eq!(missing_rel.as_deref(), Some("removed-cwd"));

        assert_eq!(terminal_cwd_payload(Some(&workspace), None), (None, None));
    }

    #[test]
    fn terminal_cwd_frames_preserve_wire_shape() {
        let ready = ServerFrame::Ready {
            cols: 80,
            rows: 24,
            cwd: Some("/workspace".into()),
            cwd_rel: Some(String::new()),
        };
        assert_eq!(
            serde_json::to_string(&ready).unwrap(),
            r#"{"type":"ready","cols":80,"rows":24,"cwd":"/workspace","cwd_rel":""}"#
        );

        let missing = ServerFrame::Cwd {
            cwd: None,
            cwd_rel: None,
        };
        assert_eq!(
            serde_json::to_string(&missing).unwrap(),
            r#"{"type":"cwd"}"#
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cwd_lookup_and_mapping_do_not_block_the_async_worker() {
        let (_cfg, root, workspace) = terminal_workspace_fixture();
        let cwd = root.path().canonicalize().expect("canonical root");
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (progress_tx, progress_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let mapping_entered = Arc::new(tokio::sync::Notify::new());
        let mapping_entered_for_hook = Arc::clone(&mapping_entered);

        let observer = std::thread::spawn(move || {
            entered_rx.recv().expect("mapping hook entered");
            let progressed = progress_rx.recv_timeout(Duration::from_secs(2)).is_ok();
            release_tx.send(()).expect("release mapping hook");
            progressed
        });

        let (payload, ()) = tokio::join!(
            terminal_cwd_payload_blocking_with_hook(
                Some(workspace),
                move || Some(cwd),
                move || {
                    entered_tx.send(()).expect("announce mapping hook");
                    mapping_entered_for_hook.notify_one();
                    release_rx.recv().expect("mapping hook release");
                },
            ),
            async move {
                mapping_entered.notified().await;
                let _ = progress_tx.send(());
            }
        );

        assert_eq!(payload.1.as_deref(), Some(""));
        assert!(
            observer.join().expect("observer thread"),
            "the async worker stalled while cwd mapping ran"
        );
    }

    #[test]
    fn resolve_terminal_cwd_rejects_escape_and_files() {
        let (_cfg, root, workspace) = terminal_workspace_fixture();
        fs::create_dir_all(root.path().join("notes")).expect("create dir");
        fs::write(root.path().join("notes/today.md"), "x").expect("create file");

        assert!(resolve_terminal_cwd(&workspace, Some("../outside")).is_err());
        assert!(resolve_terminal_cwd(&workspace, Some("notes/today.md")).is_err());
    }

    #[test]
    fn resolve_terminal_cwd_refuses_a_missing_workspace_root() {
        let (_cfg, root, workspace) = terminal_workspace_fixture();
        let root_path = root.path().to_path_buf();
        fs::remove_dir_all(&root_path).expect("remove harness-owned workspace");

        let error = resolve_terminal_cwd(&workspace, None)
            .expect_err("a new terminal must not start after root deletion");
        assert!(
            error.contains("workspace root does not exist"),
            "unexpected terminal error: {error}"
        );
        assert!(!root_path.exists(), "terminal cwd check recreated the root");
    }

    async fn response_json(response: Response) -> serde_json::Value {
        let (parts, body) = response.into_parts();
        assert!(
            parts.status.is_success(),
            "response was not success: {}",
            parts.status
        );
        let bytes = to_bytes(body, 8192).await.expect("read body");
        serde_json::from_slice(&bytes).expect("response json")
    }

    fn create_terminal_body(command: &str) -> CreateTerminalBody {
        CreateTerminalBody {
            name: "@@Spawned".into(),
            command: command.into(),
            env: BTreeMap::new(),
            group: None,
            window_id: None,
        }
    }

    #[test]
    fn validate_terminal_env_rejects_bad_keys_and_values() {
        let mut env = BTreeMap::new();
        env.insert("OK".into(), "1".into());
        assert!(validate_terminal_env(&env).is_ok());
        env.insert("BAD=KEY".into(), "x".into());
        assert!(validate_terminal_env(&env).is_err());

        let mut env = BTreeMap::new();
        env.insert("BAD_VALUE".into(), "x\0y".into());
        assert!(validate_terminal_env(&env).is_err());
    }

    #[tokio::test]
    async fn api_create_terminal_spawns_command_and_returns_session() {
        let state = crate::state::test_support::make_test_state(false);
        let response = api_create_terminal(
            State(state.clone()),
            Ok(Json(create_terminal_body("printf 'hi from spawn\\n'"))),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CREATED);

        let body = response_json(response).await;
        assert_eq!(body["tab_label"], "@@Spawned");
        let session = body["session"].as_str().expect("session id");
        let mut handle = state
            .terminal_sessions
            .attach(session, Some(0))
            .expect("spawned session");
        let out = collect_until(&mut handle, "hi from spawn", PROBE_BUDGET).await;
        assert!(out.contains("hi from spawn"), "missing output: {out:?}");
        state
            .terminal_sessions
            .close(session, CloseReason::Explicit);
    }

    #[tokio::test]
    async fn api_create_terminal_returns_the_registry_settled_name() {
        let state = crate::state::test_support::make_test_state(false);
        let first = api_create_terminal(
            State(state.clone()),
            Ok(Json(create_terminal_body("sleep 5"))),
        )
        .await;
        let first = response_json(first).await;
        assert_eq!(first["tab_label"], "@@Spawned");

        let second = api_create_terminal(
            State(state.clone()),
            Ok(Json(create_terminal_body("sleep 5"))),
        )
        .await;
        let second = response_json(second).await;
        assert_eq!(second["tab_label"], "@@Spawned-2");
        state.terminal_sessions.close_all(CloseReason::Shutdown);
    }

    #[tokio::test]
    async fn api_create_terminal_joins_the_requested_group() {
        // The Team Work bootstrap spawns each team terminal with a group;
        // it must land on the session's registry tab_group (and so
        // $CHAN_TAB_GROUP + cs terminal list grouping).
        let state = crate::state::test_support::make_test_state(false);
        let mut body = create_terminal_body("sleep 1");
        body.group = Some("team-x".into());
        let response = api_create_terminal(State(state.clone()), Ok(Json(body))).await;
        assert_eq!(response.status(), StatusCode::CREATED);

        let summaries = state.terminal_sessions.session_summaries();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].tab_group, "team-x");
        state
            .terminal_sessions
            .close(&summaries[0].session_id, CloseReason::Explicit);
    }

    #[tokio::test]
    async fn api_create_terminal_rejects_missing_command() {
        let state = crate::state::test_support::make_test_state(false);
        let response = api_create_terminal(
            State(state),
            Ok(Json(CreateTerminalBody {
                name: "@@Spawned".into(),
                command: " ".into(),
                env: BTreeMap::new(),
                group: None,
                window_id: None,
            })),
        )
        .await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn terminal_control_endpoints_return_not_found_for_missing_session() {
        let state = crate::state::test_support::make_test_state(false);

        let restart =
            api_restart_terminal(State(state.clone()), AxumPath("missing".into()), None).await;
        let delete = api_delete_terminal(State(state), AxumPath("missing".into())).await;

        assert_eq!(restart.status(), StatusCode::NOT_FOUND);
        assert_eq!(delete.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn api_restart_terminal_respawns_same_session_command() {
        let state = crate::state::test_support::make_test_state(false);
        let mut body = create_terminal_body("printf \"restart-$CHAN_TEST_RESTART\\n\"; sleep 1");
        body.env.insert("CHAN_TEST_RESTART".into(), "one".into());
        let response = api_create_terminal(State(state.clone()), Ok(Json(body))).await;
        let json = response_json(response).await;
        let session = json["session"].as_str().expect("session id").to_string();
        let mut handle = state
            .terminal_sessions
            .attach(&session, Some(0))
            .expect("spawned session");
        let out = collect_until(&mut handle, "restart-one", PROBE_BUDGET).await;
        assert!(out.contains("restart-one"), "missing first output: {out:?}");

        let response =
            api_restart_terminal(State(state.clone()), AxumPath(session.clone()), None).await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let mut restarted = state
            .terminal_sessions
            .attach(&session, Some(0))
            .expect("restarted session");
        let out = collect_until(&mut restarted, "restart-one", PROBE_BUDGET).await;
        assert!(
            out.contains("restart-one"),
            "missing restarted output: {out:?}"
        );
        state
            .terminal_sessions
            .close(&session, CloseReason::Explicit);
    }

    #[tokio::test]
    async fn api_restart_terminal_updates_chan_tab_name_env() {
        let state = crate::state::test_support::make_test_state(false);
        let mut body =
            create_terminal_body("printf '<CHAN_TAB_NAME=%s>\\n' \"$CHAN_TAB_NAME\"; sleep 1");
        body.name = "@@First".into();
        let response = api_create_terminal(State(state.clone()), Ok(Json(body))).await;
        let json = response_json(response).await;
        let session = json["session"].as_str().expect("session id").to_string();
        let mut handle = state
            .terminal_sessions
            .attach(&session, Some(0))
            .expect("spawned session");
        let out = collect_until(&mut handle, "<CHAN_TAB_NAME=@@First>", PROBE_BUDGET).await;
        assert!(
            out.contains("<CHAN_TAB_NAME=@@First>"),
            "missing first tab name: {out:?}"
        );

        let response = api_restart_terminal(
            State(state.clone()),
            AxumPath(session.clone()),
            Some(Json(RestartTerminalBody {
                name: Some("@@Second".into()),
                group: None,
                window_id: None,
                command: None,
                env: None,
            })),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let mut restarted = state
            .terminal_sessions
            .attach(&session, Some(0))
            .expect("restarted session");
        let out = collect_until(&mut restarted, "<CHAN_TAB_NAME=@@Second>", PROBE_BUDGET).await;
        assert!(
            out.contains("<CHAN_TAB_NAME=@@Second>"),
            "missing restarted tab name: {out:?}"
        );
        state
            .terminal_sessions
            .close(&session, CloseReason::Explicit);
    }

    #[tokio::test]
    async fn api_delete_terminal_closes_session() {
        let state = crate::state::test_support::make_test_state(false);
        let response = api_create_terminal(
            State(state.clone()),
            Ok(Json(create_terminal_body("sleep 5"))),
        )
        .await;
        let json = response_json(response).await;
        let session = json["session"].as_str().expect("session id").to_string();

        let response = api_delete_terminal(State(state.clone()), AxumPath(session.clone())).await;

        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(state.terminal_sessions.attach(&session, None).is_none());
    }

    async fn collect_until(session: &mut AttachHandle, needle: &str, timeout: Duration) -> String {
        let deadline = Instant::now() + timeout;
        let mut out = String::new();
        loop {
            if out.contains(needle) || Instant::now() >= deadline {
                return out;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(remaining, session.rx.recv()).await {
                Ok(Ok(SessionEvent::Output(data))) => out.push_str(&String::from_utf8_lossy(&data)),
                Ok(Ok(SessionEvent::Error(message))) => {
                    out.push_str(&format!("\n__ERROR__{message}\n"));
                }
                Ok(Ok(_)) => {}
                Ok(Err(_)) | Err(_) => return out,
            }
        }
    }

    async fn collect_until_idle(
        session: &mut AttachHandle,
        timeout: Duration,
        idle: Duration,
    ) -> String {
        let deadline = Instant::now() + timeout;
        let mut out = String::new();
        let mut last_output = Instant::now();
        loop {
            if !out.is_empty() && Instant::now().duration_since(last_output) >= idle {
                return out;
            }
            if Instant::now() >= deadline {
                return out;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            let wait = remaining.min(Duration::from_millis(100));
            match tokio::time::timeout(wait, session.rx.recv()).await {
                Ok(Ok(SessionEvent::Output(data))) => {
                    out.push_str(&String::from_utf8_lossy(&data));
                    last_output = Instant::now();
                }
                Ok(Ok(SessionEvent::Error(message))) => {
                    out.push_str(&format!("\n__ERROR__{message}\n"));
                    last_output = Instant::now();
                }
                Ok(Ok(_)) => {}
                Ok(Err(_)) => return out,
                Err(_) => {}
            }
        }
    }

    /// Type `script` into an already-spawned test terminal and return
    /// ONLY the output between its `__<family>_BEGIN__` and
    /// `__<family>_END__` markers (PROBE_BUDGET cap).
    ///
    /// INVARIANT (enforced): neither marker may appear literally in
    /// `script` -- the script must build them at runtime
    /// (`printf '__X_%s__' BEGIN` / `... END`). A typed line ECHOES on
    /// the PTY (there is no reliable way to settle `stty -echo` on a
    /// loaded host before typing), so a literal end marker matches
    /// inside the echo and the harvest returns the echo alone, before
    /// the script ever ran. Slicing to the marker window drops the
    /// echoed line, the prompt, and any shell banner, so assertions
    /// (negative ones included) only ever see the script's real
    /// output.
    async fn collect_marker_window(
        session: &mut AttachHandle,
        script: &str,
        family: &str,
    ) -> String {
        let begin = format!("__{family}_BEGIN__");
        let end = format!("__{family}_END__");
        assert!(
            !script.contains(&begin) && !script.contains(&end),
            "probe markers {begin:?}/{end:?} must not appear literally in the typed script \
             (they would match the script's own echo); build them with printf '%s'"
        );
        session.send_input(format!("{script}\r").as_bytes());
        let out = collect_until(session, &end, PROBE_BUDGET).await;
        let Some(begin_at) = out.find(&begin) else {
            panic!("probe never printed {begin:?} within {PROBE_BUDGET:?}; buffer: {out:?}");
        };
        let after_begin = &out[begin_at + begin.len()..];
        let Some(end_at) = after_begin.find(&end) else {
            panic!("probe never printed {end:?} within {PROBE_BUDGET:?}; buffer: {out:?}");
        };
        after_begin[..end_at].to_string()
    }

    /// Spawn a fresh real shell in a temp workspace, type `script`, and
    /// return its marker window (see collect_marker_window for the
    /// marker discipline).
    async fn run_shell_probe(script: &str, family: &str) -> String {
        let tmp = tempfile::tempdir().expect("temp workspace");
        let mut terminal = TestTerminal::spawn(
            tmp.path().to_path_buf(),
            pty_size(Some(100), Some(31)),
            None,
            None,
        );
        // Drain the shell banner/prompt burst; correctness does not
        // depend on this (the marker window excludes anything typed or
        // printed before BEGIN), it just keeps harvested buffers small.
        let _ = collect_until_idle(
            &mut terminal.handle,
            Duration::from_millis(300),
            Duration::from_millis(100),
        )
        .await;
        collect_marker_window(&mut terminal.handle, script, family).await
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn terminal_session_reports_live_cwd() {
        // Serialize against the sibling real-PTY tests so they do not
        // stack real-shell load on each other under the full parallel run.
        let _serial = pty_test_lock();
        let tmp = tempfile::tempdir().expect("temp workspace");
        let subdir = tmp.path().join("work");
        fs::create_dir_all(&subdir).expect("create subdir");
        let root = tmp.path().canonicalize().expect("canonical root");
        let subdir = subdir.canonicalize().expect("canonical subdir");
        let mut terminal =
            TestTerminal::spawn(root.clone(), pty_size(Some(100), Some(31)), None, None);
        let _ = collect_until_idle(
            &mut terminal.handle,
            Duration::from_millis(300),
            Duration::from_millis(100),
        )
        .await;

        assert_eq!(
            terminal
                .handle
                .cwd()
                .as_ref()
                .and_then(|p| p.canonicalize().ok()),
            Some(root),
            "fresh terminal should report workspace root cwd"
        );

        terminal.handle.send_input(b"cd work\r");
        let deadline = Instant::now() + PROBE_BUDGET;
        loop {
            if terminal.handle.cwd().and_then(|p| p.canonicalize().ok()) == Some(subdir.clone()) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "terminal cwd did not update to {}",
                subdir.display()
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[tokio::test]
    async fn conditional_pty_programs_validate_real_terminal() {
        // Serialize against the sibling real-PTY tests so they do not
        // stack real-shell load on each other under the full parallel run.
        let _serial = pty_test_lock();
        let mut ran = 0usize;
        let mut passed = 0usize;

        if command_available("tty") {
            ran += 1;
            let out = run_shell_probe(
                "printf '\\n__TTY_%s__\\n' BEGIN; tty; printf '\\n__TTY_%s__\\n' END",
                "TTY",
            )
            .await;
            // A real PTY makes `tty` report a /dev/ttys… device path,
            // which is the property we want to validate. But the GitHub
            // macOS runner's spawned PTY slave does not always present a
            // device path; there `tty` prints its documented "not a tty"
            // result instead. That is a runner limitation, not a product
            // regression, and it must NOT gate CI.
            // So assert the device path ONLY when one is present, accept
            // the "not a tty" headless case as a skip, and still fail on
            // a probe that produced neither (a genuinely broken harness).
            let has_device = out.contains("/dev/");
            let headless = out.to_ascii_lowercase().contains("not a tty");
            assert!(
                has_device || headless,
                "tty probe reported neither a /dev/ device path nor 'not a tty', got {out:?}"
            );
            if has_device {
                passed += 1;
            }
        }

        if command_available("stty") {
            ran += 1;
            let out = run_shell_probe(
                "printf '\\n__STTY_%s__\\n' BEGIN; stty size; printf '\\n__STTY_%s__\\n' END",
                "STTY",
            )
            .await;
            assert!(
                out.contains("31 100"),
                "stty should see resized PTY as 31x100, got {out:?}"
            );
            passed += 1;
        }

        if command_available("tput") {
            ran += 1;
            let out = run_shell_probe(
                "printf '\\n__TPUT_%s__\\n' BEGIN; tput cols; tput lines; printf '\\n__TPUT_%s__\\n' END",
                "TPUT",
            )
            .await;
            assert!(
                out.contains("100") && out.contains("31"),
                "tput should see resized PTY dimensions, got {out:?}"
            );
            passed += 1;
        }

        if command_available("pwd") {
            ran += 1;
            let tmp = tempfile::tempdir().expect("temp workspace");
            let cwd = tmp.path().to_path_buf();
            let mut terminal = TestTerminal::spawn(
                cwd.clone(),
                pty_size(Some(100), Some(31)),
                Some("build".to_string()),
                Some(std::path::PathBuf::from("/tmp/chan-test.sock")),
            );
            let _ = collect_until_idle(
                &mut terminal.handle,
                Duration::from_millis(300),
                Duration::from_millis(100),
            )
            .await;
            let out = collect_marker_window(
                &mut terminal.handle,
                "printf '\\n__CWD_HOME_%s__\\n' BEGIN; pwd; printf '<HOME=%s>\\n' \"$HOME\"; printf '<CHAN_TAB_NAME=%s>\\n' \"$CHAN_TAB_NAME\"; printf '<CHAN_TAB_GROUP=%s>\\n' \"$CHAN_TAB_GROUP\"; printf '<CHAN_WINDOW_ID=%s>\\n' \"$CHAN_WINDOW_ID\"; printf '<CHAN_CONTROL_SOCKET=%s>\\n' \"$CHAN_CONTROL_SOCKET\"; printf '<CHAN_WORKSPACE_NAME=%s>\\n' \"$CHAN_WORKSPACE_NAME\"; printf '<CHAN_WORKSPACE_PATH=%s>\\n' \"$CHAN_WORKSPACE_PATH\"; env | grep -E '^(CHAN|CLAUDE|CODEX|GEMINI|OPENCODE)_MCP_' | sort; printf '\\n__CWD_HOME_%s__\\n' END",
                "CWD_HOME",
            )
            .await;
            assert!(
                out.contains(&cwd.display().to_string()),
                "terminal should start at workspace root cwd, got {out:?}"
            );
            assert!(
                !out.contains(&format!("<HOME={}>", cwd.display())),
                "terminal HOME should not be rewritten to workspace root, got {out:?}"
            );
            assert!(
                out.contains("<CHAN_TAB_NAME=build>"),
                "terminal should expose the tab name env var, got {out:?}"
            );
            assert!(
                out.contains("<CHAN_TAB_GROUP=default>"),
                "terminal with no group should expose CHAN_TAB_GROUP=default, got {out:?}"
            );
            assert!(
                out.contains("<CHAN_WINDOW_ID=window-test>"),
                "terminal should expose the window id env var, got {out:?}"
            );
            assert!(
                out.contains("<CHAN_CONTROL_SOCKET=/tmp/chan-control-test.sock>"),
                "terminal should expose the control socket env var, got {out:?}"
            );
            assert!(
                out.contains(&format!("<CHAN_WORKSPACE_PATH={}>", cwd.display())),
                "terminal should expose the workspace path env var, got {out:?}"
            );
            let ws_name = cwd
                .file_name()
                .expect("temp workspace has a basename")
                .to_string_lossy();
            assert!(
                out.contains(&format!("<CHAN_WORKSPACE_NAME={ws_name}>")),
                "terminal should expose the workspace name env var, got {out:?}"
            );
            assert!(
                out.contains("CHAN_MCP_SOCKET=/tmp/chan-test.sock"),
                "terminal should expose the MCP socket env var, got {out:?}"
            );
            assert!(
                out.contains("CHAN_MCP_SERVER_NAME=chan"),
                "terminal should expose the MCP server name env var, got {out:?}"
            );
            assert!(
                out.contains("CHAN_MCP_SERVER_JSON=")
                    && out.contains("CHAN_MCP_COMMAND=")
                    && out.contains("CHAN_MCP_COMMAND_JSON="),
                "terminal should expose only chan MCP discovery env vars, got {out:?}"
            );
            assert!(
                !out.contains("CLAUDE_MCP_SERVER_JSON=")
                    && !out.contains("CODEX_MCP_SERVER_JSON=")
                    && !out.contains("GEMINI_MCP_SERVER_JSON=")
                    && !out.contains("OPENCODE_MCP_SERVER_JSON="),
                "terminal should not expose third-party MCP aliases, got {out:?}"
            );
            passed += 1;
        }

        if command_available("sh") {
            ran += 1;
            let out = run_shell_probe("printf '\\n__READ_%s__\\n' BEGIN; sh -lc 'read x; printf \"<%s>\\\\n\" \"$x\"' <<'EOF'\nchan-term\nEOF\nprintf '\\n__READ_%s__\\n' END", "READ").await;
            assert!(
                out.contains("<chan-term>"),
                "shell read/write probe should roundtrip input, got {out:?}"
            );
            passed += 1;
        }

        if command_available("less") {
            ran += 1;
            let tmp = tempfile::tempdir().expect("temp workspace");
            let mut terminal = TestTerminal::spawn(
                tmp.path().to_path_buf(),
                pty_size(Some(100), Some(31)),
                None,
                None,
            );
            let _ = collect_until_idle(
                &mut terminal.handle,
                Duration::from_millis(300),
                Duration::from_millis(100),
            )
            .await;
            // The needle must differ from the TYPED text (the line
            // echoes): `al%s` in the input, `alpha` only in less's
            // rendered output.
            terminal
                .handle
                .send_input(b"printf 'al%s\\nbeta\\n' pha | less\r");
            let out = collect_until(&mut terminal.handle, "alpha", PROBE_BUDGET).await;
            assert!(
                out.contains("alpha"),
                "less should render piped text, got {out:?}"
            );
            terminal.handle.send_input(b"q");
            terminal
                .handle
                .send_input(b"printf '\\n__LESS_%s__\\n' END\r");
            let out = collect_until(&mut terminal.handle, "__LESS_END__", PROBE_BUDGET).await;
            assert!(
                out.contains("__LESS_END__"),
                "shell should remain usable after quitting less, got {out:?}"
            );
            passed += 1;
        }

        assert!(
            ran > 0,
            "no conditional PTY validation commands were available"
        );
        assert!(passed > 0, "no conditional PTY validation passed");
    }

    #[tokio::test]
    async fn mcp_env_off_omits_chan_mcp_vars() {
        if !command_available("env") {
            return;
        }
        // Serialize against the sibling real-PTY tests so they do not
        // stack real-shell load on each other under the full parallel run.
        let _serial = pty_test_lock();
        let tmp = tempfile::tempdir().expect("temp workspace");
        let mut terminal = TestTerminal::spawn_with_mcp_env(
            tmp.path().to_path_buf(),
            pty_size(Some(100), Some(31)),
            Some("plain".to_string()),
            Some(std::path::PathBuf::from("/tmp/chan-test.sock")),
            false,
        );
        let _ = collect_until_idle(
            &mut terminal.handle,
            Duration::from_millis(300),
            Duration::from_millis(100),
        )
        .await;
        // The marker window is load-bearing for the NEGATIVE assert
        // below: the typed script itself contains `CHAN_MCP_` (the
        // grep pattern), so the echoed line outside the window would
        // false-fail it.
        let out = collect_marker_window(
            &mut terminal.handle,
            "printf '\\n__MCP_ENV_OFF_%s__\\n' BEGIN; env | grep '^CHAN_MCP_' || true; printf '<CHAN_TAB_NAME=%s>\\n' \"$CHAN_TAB_NAME\"; printf '<CHAN_WINDOW_ID=%s>\\n' \"$CHAN_WINDOW_ID\"; printf '<CHAN_CONTROL_SOCKET=%s>\\n' \"$CHAN_CONTROL_SOCKET\"; printf '\\n__MCP_ENV_OFF_%s__\\n' END",
            "MCP_ENV_OFF",
        )
        .await;
        assert!(
            !out.contains("CHAN_MCP_"),
            "mcp_env=false should omit CHAN_MCP_* env vars, got {out:?}"
        );
        assert!(
            out.contains("<CHAN_TAB_NAME=plain>"),
            "mcp_env=false should not affect CHAN_TAB_NAME, got {out:?}"
        );
        assert!(
            out.contains("<CHAN_WINDOW_ID=window-test>")
                && out.contains("<CHAN_CONTROL_SOCKET=/tmp/chan-control-test.sock>"),
            "mcp_env=false should not affect chan control env vars, got {out:?}"
        );
    }
}
