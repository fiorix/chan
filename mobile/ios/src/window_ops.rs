//! Consumer for the desktop window bridge.
//!
//! The embedded chan-server hands each window request to the desktop over an
//! mpsc channel (see `chan_server::DesktopBridge`); this module owns the
//! receiver and turns each [`DesktopWindowOp`] into the matching Tauri action,
//! then completes the op's `oneshot` so the blocked caller unblocks. The
//! requests come from two surfaces: the `cs window new|open|rm|hide|title` CLI,
//! and the launcher's `/api/library/*` HTTP routes (window open/hide, the
//! devserver Connect button, the New-Workspace folder picker).
//!
//! Tauri window operations (build / show / destroy / set_title / dialogs)
//! must run on the main thread, so the handlers hop there via
//! `on_main`; the async terminal-open path mirrors the existing
//! `spawn_terminal_window` flow (async-runtime task, build dispatches to
//! main internally). Each op runs in its own task so a blocking folder
//! picker cannot stall unrelated ops.

use std::path::Path;
use std::sync::Arc;

use chan_server::{DesktopWindowOp, NewWindowKind};
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::mpsc;

use crate::last_window::{self, Gesture};
use crate::serve;
use crate::AppState;

/// Drain the window-ops channel until it closes (process exit drops the
/// host that owns the sender). Spawned once from Tauri `.setup()`.
pub async fn run(app: AppHandle, state: Arc<AppState>, mut rx: mpsc::Receiver<DesktopWindowOp>) {
    while let Some(op) = rx.recv().await {
        let app = app.clone();
        let state = Arc::clone(&state);
        tauri::async_runtime::spawn(async move {
            handle(app, state, op).await;
        });
    }
}

async fn handle(app: AppHandle, state: Arc<AppState>, op: DesktopWindowOp) {
    match op {
        DesktopWindowOp::New { kind, reply } => {
            let result = match kind {
                NewWindowKind::Terminal => {
                    let result = serve::spawn_local_terminal_window(Arc::clone(&state)).await;
                    if let Ok(id) = &result {
                        let label = serve::resolve_window_label(&app, id);
                        crate::raise_new_terminal_window(app, state, label, None);
                    }
                    result
                }
                NewWindowKind::Workspace { key } => new_workspace_window(&state, &key).await,
            };
            let _ = reply.send(result);
        }
        DesktopWindowOp::Open { id, reply } => {
            let remote = state
                .devserver_feed
                .record_for_window_id(&id)
                .or_else(|| state.devserver_feed.record_for_native_label(&id));
            let result = if let Some((devserver_id, record)) = remote {
                crate::mobile_auth::mobile_open_existing_window(&state, &devserver_id, &record)
                    .await
            } else {
                let app2 = app.clone();
                on_main(&app, move || serve::open_window_by_label(&app2, &id))
                    .await
                    .and_then(|inner| inner)
            };
            let _ = reply.send(result);
        }
        DesktopWindowOp::SetWindowLabel { id, label, reply } => {
            let result = set_remote_window_label(&state, &id, &label).await;
            let _ = reply.send(result);
        }
        DesktopWindowOp::TmuxRequest {
            library_id,
            connection,
            request,
            reply,
        } => {
            let result = request_remote_tmux(&state, &library_id, &connection, request).await;
            let _ = reply.send(result);
        }
        DesktopWindowOp::Hide { id, reply } => {
            let remote = state
                .devserver_feed
                .record_for_window_id(&id)
                .or_else(|| state.devserver_feed.record_for_native_label(&id));
            let result = if let Some((devserver_id, record)) = remote {
                hide_remote_window(&state, &devserver_id, &record.window_id).await
            } else {
                let app2 = app.clone();
                on_main(&app, move || hide_window(&app2, &id))
                    .await
                    .and_then(|inner| inner)
            };
            let _ = reply.send(result);
        }
        DesktopWindowOp::Close { id, reply } => {
            close_window(app, state, id, reply).await;
        }
        DesktopWindowOp::ConnectDevserver { id, reply } => {
            // The launcher's Connect button fires this over the bridge.
            // A synthesized gateway row connects as a rostered devserver
            // (policy check, entry exchange, exact-origin capability mint,
            // WebView cookie install, workspace/window feed population); a
            // direct devserver has no control-terminal connect flow on this
            // build and refuses loudly instead of parking.
            let result = if crate::gateway::parse_synthesized_id(&id).is_some() {
                crate::connect_rostered_devserver(app, state, id).await
            } else {
                Err(format!(
                    "connecting a direct devserver is not supported on this build; connect through a gateway (id {id})"
                ))
            };
            let _ = reply.send(result);
        }
        // The launcher's connected-devserver row buttons fire these over the
        // desktop bridge. Each reuses the same connection state the connect
        // flow set up; the reply unblocks the route's `dispatch_window_op`.
        DesktopWindowOp::DisconnectDevserver { id, reply } => {
            crate::teardown_devserver_connection(&app, &state, &id).await;
            let _ = reply.send(Ok(()));
        }
        DesktopWindowOp::GrantDevserverNativeTrust { id, reply } => {
            let _ = reply.send(crate::grant_devserver_native_trust(&app, &state, &id).await);
        }
        DesktopWindowOp::RevokeDevserverNativeTrust { id, reply } => {
            let _ = reply.send(crate::revoke_devserver_native_trust(&app, &state, &id).await);
        }
        DesktopWindowOp::ConnectGateway { id, reply } => {
            // The Gateways screen's Connect button: discovery, browser
            // sign-in hand-off when needed, roster fetch, poll spawn.
            let _ = reply.send(crate::gateway::connect_gateway(app, state, id, true).await);
        }
        DesktopWindowOp::GenerateWireguardKey { id, reply } => {
            // The Gateways form's Generate WireGuard key action.
            let _ = reply.send(
                crate::config::generate_wireguard_key(&state.store, &state.gateway_manager, &id)
                    .await,
            );
        }
        DesktopWindowOp::DisconnectGateway { id, reply } => {
            crate::gateway::cascade_disconnect(
                &app,
                &state,
                &id,
                crate::gateway::CascadeReason::UserDisconnect,
            )
            .await;
            let _ = reply.send(Ok(()));
        }
        DesktopWindowOp::OpenDevserverTerminal { id, reply } => {
            let _ = reply.send(crate::open_devserver_terminal_impl(&state, id).await);
        }
        DesktopWindowOp::OpenDevserverWorkspace {
            id,
            path,
            start_terminal,
            reply,
        } => {
            let _ = reply
                .send(crate::open_devserver_workspace_impl(&state, id, path, start_terminal).await);
        }
        DesktopWindowOp::SetDevserverWorkspaceOn {
            id,
            prefix,
            on,
            force,
            reply,
        } => {
            let _ = reply
                .send(crate::set_devserver_workspace_on_impl(&state, id, prefix, on, force).await);
        }
        DesktopWindowOp::ForgetDevserverWorkspace {
            id,
            prefix,
            force,
            reply,
        } => {
            let _ =
                reply.send(crate::forget_devserver_workspace_impl(&state, id, prefix, force).await);
        }
        #[cfg(not(target_os = "ios"))]
        DesktopWindowOp::PickFolder { reply } => {
            // The launcher's New-Workspace "Browse..." button fires this over the
            // bridge to get a real native folder dialog. The picker is async-
            // callback based and Tauri dialogs must run on the main thread, so the
            // `on_main` hop only SCHEDULES the dialog; the chosen path (or cancel)
            // completes the oneshot from the picker callback. `Ok(None)` = the
            // user cancelled.
            let app2 = app.clone();
            let scheduled = on_main(&app, move || {
                use tauri_plugin_dialog::DialogExt;
                app2.dialog().file().pick_folder(move |chosen| {
                    let path = chosen
                        .and_then(|fp| fp.into_path().ok())
                        .map(|p| p.to_string_lossy().into_owned());
                    let _ = reply.send(Ok(path));
                });
            })
            .await;
            if let Err(e) = scheduled {
                // The reply moved into the picker callback; if SCHEDULING the
                // dialog failed nothing completes it, and the dropped sender maps
                // to an error server-side.
                tracing::warn!(error = %e, "scheduling the folder picker failed");
            }
        }
        // iOS has no folder picker: local workspaces are not an iOS story, so
        // the launcher's Browse answers like a cancelled dialog.
        #[cfg(target_os = "ios")]
        DesktopWindowOp::PickFolder { reply } => {
            let _ = reply.send(Ok(None));
        }
    }
}

/// `cs window new` (workspace tenant): open another window of the
/// workspace rooted at `key` by minting a window into the library registry
/// (the watcher opens it). Errors when no workspace runtime of the embedded
/// host goes by `key`. The host is asked rather than the desktop's own map
/// of what it mounted, since the launcher's on and off mount and unmount
/// through the host alone; it answers from the keys it stores, and `key`,
/// the root the workspace's registry row stores as its control socket sends
/// it, is one of them, so nothing is resolved. Returns the new window's id
/// as the registry stores it: the id `cs window list` shows and `--window`
/// takes, not the native label the desktop names its view by.
async fn new_workspace_window(state: &Arc<AppState>, key: &str) -> Result<String, String> {
    let embedded = state
        .embedded()
        .ok_or_else(|| "embedded local server is unavailable".to_string())?;
    if !embedded.is_workspace_mounted_by_key(Path::new(key)) {
        return Err(format!("workspace {key} is not running"));
    }
    let record = embedded.mint_workspace_window(Path::new(key))?;
    Ok(record.window_id)
}

/// `cs window hide` / the launcher window hide: route through the OS
/// close-button path so the existing bury handler (which knows this window's
/// restore key) runs. `close()` requests a close -- the handler hides SPA
/// windows -- unlike `destroy()`, which `rm` uses to truly remove. Resolves the
/// launcher's bare `window_id` to the composite native label first (see
/// [`serve::resolve_window_label`]). Refused, with nothing hidden, when the
/// window is chan's last shown one and terminals would end with the process
/// ([`last_window`]).
fn hide_window<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    let label = serve::resolve_window_label(app, id);
    if label == "main" {
        return Ok(());
    }
    match app.get_webview_window(&label) {
        Some(w) => {
            let state = Arc::clone(app.state::<Arc<AppState>>().inner());
            last_window::check(app, &state, &label, Gesture::Hide)?;
            // The launcher hide IS the explicit hide gesture, so suppress the
            // close handler's "was hidden, not closed" notice (that teaches the
            // red-button gesture). Flag the label before `close()` so the
            // CloseRequested bury consumes it; both run on the main thread.
            state.mark_silent_hide(&label);
            w.close().map_err(|e| {
                // No close request is coming to consume the flag, and a flag
                // left behind would read as a hide under way.
                state.take_silent_hide(&label);
                format!("hiding {id}: {e}")
            })
        }
        // A reaped / already-gone native window is an idempotent
        // silent no-op -- reply Ok(()) so the route returns 204, NOT Err (which maps
        // to 409 and floods the launcher's eye-handler console). Reaping a
        // standalone terminal's feed row on PTY exit; a client still holding the
        // just-removed row can click its eye, and that hide must land cleanly. Err
        // (-> 409) is reserved for the genuine "no desktop attached / manager gone"
        // case, which the route body already explains.
        None => Ok(()),
    }
}

/// Truly destroy a window after the caller applies its live-terminal guard or
/// confirmation. Reply: `Ok(true)` destroyed, `Ok(false)` no live window (the
/// server then deletes any saved layout), or an error when destruction fails
/// or [`close_refusal`] refuses it, which happens before anything is
/// discarded or destroyed.
async fn close_window(
    app: AppHandle,
    state: Arc<AppState>,
    id: String,
    reply: tokio::sync::oneshot::Sender<Result<bool, String>>,
) {
    if let Err(refusal) = close_refusal(&app, &state, &id) {
        let _ = reply.send(Err(refusal));
        return;
    }
    if let Some(devserver_id) = id.strip_prefix("control-terminal-") {
        crate::close_devserver_control_terminal(&app, &state, devserver_id).await;
        let _ = reply.send(Ok(true));
        return;
    }

    // A remote row's registry lives on its devserver. Delete it there and let
    // the devserver watch reconcile close the local native view. This preserves
    // the existing remote-close behavior while local rows below gain proper
    // bare-id -> composite-label resolution.
    if state
        .devserver_feed
        .record_for_window_id(&id)
        .or_else(|| state.devserver_feed.record_for_native_label(&id))
        .is_some()
    {
        let _ = reply.send(crate::discard_devserver_window_by_id(&app, &id).await);
        return;
    }

    let label = serve::resolve_window_label(&app, &id);
    // Drop the authoritative row before destroying the view so a watcher
    // reconcile cannot briefly recreate it.
    if let Some(embedded) = state.embedded() {
        let _ = embedded.discard_window(&id);
    }
    let label2 = label.clone();
    let app2 = app.clone();
    let result = on_main(&app, move || match app2.get_webview_window(&label2) {
        Some(w) => w
            .destroy()
            .map(|()| true)
            .map_err(|e| format!("destroying {label2}: {e}")),
        None => Ok(false),
    })
    .await
    .and_then(|inner| inner);
    let _ = reply.send(result);
}

/// The last shown window guard for a removal of window `id` (`cs window rm`,
/// the launcher's Close): its native label resolves as the hide's does, and a
/// control terminal's id is its label.
fn close_refusal<R: Runtime>(app: &AppHandle<R>, state: &AppState, id: &str) -> Result<(), String> {
    let label = serve::resolve_window_label(app, id);
    last_window::check(app, state, &label, Gesture::Close)
}

pub(crate) async fn hide_remote_window(
    state: &AppState,
    devserver_id: &str,
    window_id: &str,
) -> Result<(), String> {
    let Some(conn) = state.devservers.get(devserver_id) else {
        return Err(format!("devserver {devserver_id} is not connected"));
    };
    crate::devserver::set_window_visibility(&conn, window_id, true).await?;
    if let Err(error) = crate::refresh_devserver_windows(state, devserver_id, &conn).await {
        tracing::warn!(devserver = %devserver_id, %error, "refreshing devserver windows after hide failed");
    }
    Ok(())
}

pub(crate) async fn set_remote_window_label(
    state: &AppState,
    window_id: &str,
    label: &str,
) -> Result<(), String> {
    let Some((devserver_id, record)) = state
        .devserver_feed
        .record_for_window_id(window_id)
        .or_else(|| state.devserver_feed.record_for_native_label(window_id))
    else {
        return Err(format!("window {window_id} was not found"));
    };
    let Some(conn) = state.devservers.get(&devserver_id) else {
        return Err(format!("devserver {devserver_id} is not connected"));
    };
    crate::devserver::set_window_label(&conn, &record.window_id, label).await?;
    if let Err(error) = crate::refresh_devserver_windows(state, &devserver_id, &conn).await {
        tracing::warn!(devserver = %devserver_id, %error, "refreshing devserver windows after rename failed");
    }
    Ok(())
}

pub(crate) async fn request_remote_tmux(
    state: &AppState,
    library_id: &str,
    connection: &str,
    request: chan_server::TmuxRequest,
) -> Result<(), String> {
    let Some(id) = state.devserver_feed.devserver_id_for_library(library_id) else {
        return Err(format!("library {library_id} is not connected"));
    };
    let Some(conn) = state.devservers.get(&id) else {
        return Err(format!("devserver {id} is not connected"));
    };
    crate::devserver::tmux_request(&conn, connection, request).await?;
    if let Err(error) = crate::refresh_devserver_windows(state, &id, &conn).await {
        tracing::warn!(devserver = %id, %error, "refreshing devserver windows after tmux request failed");
    }
    Ok(())
}

/// Run `f` on the Tauri main thread and await its result. Tauri window
/// ops must run there; this bridges the async consumer task to it.
pub(crate) async fn on_main<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| format!("scheduling on main thread: {e}"))?;
    rx.await
        .map_err(|_| "main-thread task dropped before replying".to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn new_terminal_requests_raise_with_native_label_and_replies_with_registry_id() {
        let source = include_str!("window_ops.rs")
            .split_once("\n#[cfg(test)]")
            .expect("production precedes tests")
            .0;
        let arm = source
            .split_once("NewWindowKind::Terminal => {")
            .expect("terminal window creation arm")
            .1
            .split_once("NewWindowKind::Workspace { key } =>")
            .expect("workspace arm follows terminal arm")
            .0;
        assert!(
            arm.contains("crate::raise_new_terminal_window("),
            "terminal window creation must request the shared raise"
        );
        let calls = [
            "let result = serve::spawn_local_terminal_window(Arc::clone(&state)).await;",
            "if let Ok(id) = &result {",
            "let label = serve::resolve_window_label(&app, id);",
            "crate::raise_new_terminal_window(app, state, label, None);",
            "}\n                    result",
        ];
        let mut after = 0;
        for call in calls {
            let at = arm[after..]
                .find(call)
                .unwrap_or_else(|| panic!("terminal creation must include {call}"));
            after += at + call.len();
        }
        assert_eq!(arm.matches("raise_new_terminal_window(").count(), 1);
    }

    /// The removal's reply is the guard's, before the close discards or
    /// destroys anything; `close_window` takes the production app, which the
    /// mock runtime cannot stand in for, so its order is pinned here.
    #[test]
    fn a_removal_asks_the_guard_before_it_discards_or_destroys() {
        const WINDOW_OPS_RS: &str = include_str!("window_ops.rs");
        let body = WINDOW_OPS_RS
            .split_once("\nasync fn close_window(")
            .expect("close_window")
            .1;
        let body = &body[..body.find("\n}\n").expect("close_window ends")];
        let guard = body
            .find("close_refusal(&app, &state, &id)")
            .expect("guard call");
        for later in [
            "close_devserver_control_terminal",
            "discard_window",
            "destroy()",
        ] {
            let at = body
                .find(later)
                .unwrap_or_else(|| panic!("{later} in close_window"));
            assert!(guard < at, "{later} runs before the guard");
        }
    }

    /// iOS boots the bridge consumer: ios.rs setup takes the window-ops
    /// receiver and spawns window_ops::run, or every gateway bridge op
    /// sits unread while its handler awaits a reply forever. Pinned in
    /// source: ios::run blocks on the Tauri event loop, so no host test
    /// can drive the setup itself.
    #[test]
    fn ios_setup_spawns_the_window_ops_consumer() {
        const IOS_RS: &str = include_str!("ios.rs");
        for required in [
            "take_window_ops_rx()",
            "window_ops::run(",
            "connect_rostered_devserver(",
            "with_webview",
            "gestureRecognizer:shouldRecognizeSimultaneouslyWithGestureRecognizer:",
        ] {
            assert!(IOS_RS.contains(required), "ios.rs must contain {required}");
        }
        assert!(
            !IOS_RS.contains("[&*app, windows]"),
            "ios.rs must enumerate scene windows rather than legacy UIApplication.windows"
        );
    }

    fn test_record(library_id: &str, window_id: &str) -> chan_server::WindowRecord {
        chan_server::WindowRecord {
            window_id: window_id.into(),
            library_id: library_id.into(),
            kind: chan_server::WindowKind::Workspace,
            title: "Notes".into(),
            ordinal: 1,
            label: "Notes".into(),
            workspace_path: Some("/srv/notes".into()),
            prefix: "/notes".into(),
            token: "tok".into(),
            persisted: true,
            connected: true,
            holders: None,
            active_transfer: false,
            control: false,
            tmux: None,
            hidden: false,
            origin: chan_server::WindowOrigin::Native,
            start_terminal: false,
        }
    }

    #[tokio::test]
    async fn remote_hide_close_label_and_tmux_mutate_devserver_and_refresh_feed() {
        use std::sync::{Arc, Mutex};
        use tauri::Manager;

        let windows_store = Arc::new(Mutex::new(vec![test_record("lib-1", "w-1")]));
        let tmux_calls = Arc::new(Mutex::new(Vec::<(String, chan_server::TmuxRequest)>::new()));

        let ws_vis = Arc::clone(&windows_store);
        let ws_lbl = Arc::clone(&windows_store);
        let ws_del = Arc::clone(&windows_store);
        let ws_get = Arc::clone(&windows_store);
        let tmux_r = Arc::clone(&tmux_calls);

        let router = axum::Router::new()
            .route(
                "/api/library/windows/{id}/visibility",
                axum::routing::post(
                    move |axum::extract::Path(id): axum::extract::Path<String>,
                          axum::Json(body): axum::Json<serde_json::Value>| {
                        let store = Arc::clone(&ws_vis);
                        async move {
                            if let Some(row) = store.lock().unwrap().iter_mut().find(|r| r.window_id == id) {
                                row.hidden = body["hidden"].as_bool().unwrap_or(false);
                            }
                            axum::http::StatusCode::NO_CONTENT
                        }
                    },
                ),
            )
            .route(
                "/api/library/windows/{id}/label",
                axum::routing::put(
                    move |axum::extract::Path(id): axum::extract::Path<String>,
                          axum::Json(body): axum::Json<serde_json::Value>| {
                        let store = Arc::clone(&ws_lbl);
                        async move {
                            if let Some(row) = store.lock().unwrap().iter_mut().find(|r| r.window_id == id) {
                                row.label = body["label"].as_str().unwrap_or_default().to_string();
                            }
                            axum::http::StatusCode::NO_CONTENT
                        }
                    },
                ),
            )
            .route(
                "/api/library/windows/{id}",
                axum::routing::delete(move |axum::extract::Path(id): axum::extract::Path<String>| {
                    let store = Arc::clone(&ws_del);
                    async move {
                        store.lock().unwrap().retain(|r| r.window_id != id);
                        axum::http::StatusCode::NO_CONTENT
                    }
                }),
            )
            .route(
                "/api/library/windows",
                axum::routing::get(move || {
                    let store = Arc::clone(&ws_get);
                    async move { axum::Json(store.lock().unwrap().clone()) }
                }),
            )
            .route(
                "/api/library/tmux/{conn}/request",
                axum::routing::post(
                    move |axum::extract::Path(conn): axum::extract::Path<String>,
                          axum::Json(req): axum::Json<chan_server::TmuxRequest>| {
                        let tmux = Arc::clone(&tmux_r);
                        async move {
                            tmux.lock().unwrap().push((conn, req));
                            axum::http::StatusCode::NO_CONTENT
                        }
                    },
                ),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(crate::config::ConfigStore::at_path(
            dir.path().join("config.json"),
        )));
        let state = Arc::new(super::AppState::with_store(store));

        let lib_home = tempfile::tempdir().unwrap();
        let library = chan_workspace::Library::open_at(lib_home.path().join("library.toml"))
            .expect("open library");
        let embedded = crate::embedded::EmbeddedServer::for_tests(library).await;
        let notify = embedded.library_change_notify();
        embedded.install_devserver_feed(
            Arc::clone(&state.devserver_feed) as Arc<dyn chan_server::DevserverFeedSource>
        );
        let _ = state.embedded.set(embedded);

        let origin = format!("http://127.0.0.1:{}", addr.port());
        let gw = crate::devserver::GatewayConn::new(
            origin.clone(),
            format!("{origin}/mobile/v1/devserver/entry"),
            origin,
            "pat".into(),
        );
        gw.seed_fresh_session_for_test("csrf-ops");
        state.devservers.set(
            "gw:1".into(),
            crate::devserver::DevserverConn {
                host: "127.0.0.1".into(),
                port: addr.port(),
                token: String::new(),
                name: "box".into(),
                gateway: Some(Box::new(gw)),
            },
        );
        state.devserver_feed.register_windows(
            "gw:1".into(),
            Arc::new(Mutex::new(crate::state::DevserverWindowSnapshot::from(
                vec![test_record("lib-1", "w-1")],
            ))),
        );
        state
            .devserver_feed
            .seed_library_id("gw:1".into(), "lib-1".into());

        // Hide refreshes DevserverFeed and notifies library_change_notify.
        let n1 = notify.notified();
        super::hide_remote_window(&state, "gw:1", "w-1")
            .await
            .expect("remote hide succeeds");
        tokio::time::timeout(std::time::Duration::from_secs(2), n1)
            .await
            .expect("hide fires library_change_notify");
        assert!(
            state
                .devserver_feed
                .record_for_window_id("w-1")
                .unwrap()
                .1
                .hidden
        );

        // SetWindowLabel (via composite native label too) refreshes DevserverFeed.
        let n2 = notify.notified();
        super::set_remote_window_label(&state, "lib-1::w-1", "Renamed")
            .await
            .expect("remote rename succeeds");
        tokio::time::timeout(std::time::Duration::from_secs(2), n2)
            .await
            .expect("rename fires library_change_notify");
        assert_eq!(
            state
                .devserver_feed
                .record_for_window_id("w-1")
                .unwrap()
                .1
                .label,
            "Renamed"
        );

        // TmuxRequest forwards to /api/library/tmux/{conn}/request.
        super::request_remote_tmux(
            &state,
            "lib-1",
            "tmux-conn",
            chan_server::TmuxRequest::NewWindow,
        )
        .await
        .expect("remote tmux request succeeds");
        assert_eq!(
            tmux_calls.lock().unwrap().as_slice(),
            [("tmux-conn".into(), chan_server::TmuxRequest::NewWindow)]
        );

        // last_window::check never refuses closing a remote window when "main" is sole window.
        let app = tauri::test::mock_app();
        app.manage(Arc::clone(&state));
        let _main = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External("http://127.0.0.1:8471/?t=boot".parse().unwrap()),
        )
        .build()
        .unwrap();
        assert!(super::close_refusal(app.handle(), &state, "w-1").is_ok());

        // Close discards remote window, returns Ok(true), and removes it from DevserverFeed.
        let n3 = notify.notified();
        let closed = crate::discard_devserver_window_in_state(&state, "w-1")
            .await
            .expect("remote discard succeeds");
        assert!(closed);
        tokio::time::timeout(std::time::Duration::from_secs(2), n3)
            .await
            .expect("discard fires library_change_notify");
        assert!(state.devserver_feed.record_for_window_id("w-1").is_none());

        server.abort();
    }

    #[tokio::test]
    async fn remote_hide_and_close_unknown_or_disconnected_behave_cleanly() {
        use std::sync::{Arc, Mutex};

        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(crate::config::ConfigStore::at_path(
            dir.path().join("config.json"),
        )));
        let state = Arc::new(super::AppState::with_store(store));

        // Unknown / local id returns Ok(false) from discard_devserver_window_in_state.
        assert_eq!(
            crate::discard_devserver_window_in_state(&state, "w-missing").await,
            Ok(false)
        );
        assert!(super::set_remote_window_label(&state, "w-missing", "X")
            .await
            .unwrap_err()
            .contains("was not found"));
        assert!(super::request_remote_tmux(
            &state,
            "lib-missing",
            "conn",
            chan_server::TmuxRequest::Detach
        )
        .await
        .unwrap_err()
        .contains("is not connected"));

        // Feed row present without live connection returns Err("devserver ... is not connected").
        state.devserver_feed.register_windows(
            "gw:gone".into(),
            Arc::new(Mutex::new(crate::state::DevserverWindowSnapshot::from(
                vec![test_record("lib-gone", "w-gone")],
            ))),
        );
        state
            .devserver_feed
            .seed_library_id("gw:gone".into(), "lib-gone".into());
        assert_eq!(
            super::hide_remote_window(&state, "gw:gone", "w-gone")
                .await
                .unwrap_err(),
            "devserver gw:gone is not connected"
        );
        assert_eq!(
            super::set_remote_window_label(&state, "w-gone", "Label")
                .await
                .unwrap_err(),
            "devserver gw:gone is not connected"
        );
        assert_eq!(
            super::request_remote_tmux(
                &state,
                "lib-gone",
                "conn",
                chan_server::TmuxRequest::Detach
            )
            .await
            .unwrap_err(),
            "devserver gw:gone is not connected"
        );
        assert_eq!(
            crate::discard_devserver_window_in_state(&state, "w-gone")
                .await
                .unwrap_err(),
            "devserver gw:gone is not connected"
        );

        // hide_window on "main" is a safe no-op.
        let app = tauri::test::mock_app();
        let _main = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External("http://127.0.0.1:8471/?t=boot".parse().unwrap()),
        )
        .build()
        .unwrap();
        assert!(super::hide_window(app.handle(), "main").is_ok());
    }
}
