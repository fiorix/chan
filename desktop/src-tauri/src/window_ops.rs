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
//! [`on_main`]; the async terminal-open path mirrors the existing
//! `spawn_terminal_window` flow (async-runtime task, build dispatches to
//! main internally). Each op runs in its own task so a blocking `rm`
//! confirmation dialog can't stall unrelated ops.

use std::path::Path;
use std::sync::Arc;

use chan_server::{DesktopWindowOp, NewWindowKind};
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc;

use crate::{serve, AppState};

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
                    serve::spawn_local_terminal_window(Arc::clone(&state)).await
                }
                NewWindowKind::Workspace { key } => new_workspace_window(&state, &key).await,
            };
            let _ = reply.send(result);
        }
        DesktopWindowOp::Open { id, reply } => {
            let app2 = app.clone();
            let state2 = Arc::clone(&state);
            let result = on_main(&app, move || {
                serve::open_window_by_label(&app2, &state2, &id)
            })
            .await
            .and_then(|inner| inner);
            let _ = reply.send(result);
        }
        DesktopWindowOp::SetWindowLabel { id, label, reply } => {
            let result = set_remote_window_label(&state, &id, &label).await;
            let _ = reply.send(result);
        }
        DesktopWindowOp::Hide { id, reply } => {
            let app2 = app.clone();
            let result = on_main(&app, move || hide_window(&app2, &id))
                .await
                .and_then(|inner| inner);
            let _ = reply.send(result);
        }
        DesktopWindowOp::Close { id, force, reply } => {
            close_window(app, state, id, force, reply).await;
        }
        DesktopWindowOp::ConnectDevserver { id, reply } => {
            // The launcher's Connect button fires this over the bridge; it runs
            // the full devserver connect flow (control terminal, token scrape,
            // dial, window watcher).
            let _ = reply.send(crate::connect_devserver_impl(app, state, id).await);
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
        DesktopWindowOp::OpenDevserverWorkspace { id, path, reply } => {
            let _ = reply.send(crate::open_devserver_workspace_impl(&state, id, path).await);
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
        DesktopWindowOp::PickFolder { reply } => {
            // The launcher's New-Workspace "Browse…" button fires this over the
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
    }
}

/// `cs window new` (workspace tenant): open another window of the
/// workspace rooted at `key` by minting a window into the library registry
/// (the watcher opens it), the same way `open_local_workspace` does. Errors
/// when that workspace isn't currently running locally. Returns the new
/// window's composite native label.
async fn new_workspace_window(state: &Arc<AppState>, key: &str) -> Result<String, String> {
    let canon = crate::canonical_key(Path::new(key));
    if !state.serves.lock().unwrap().contains_key(&canon) {
        return Err(format!("workspace {key} is not running"));
    }
    let record = state
        .embedded()
        .ok_or_else(|| "embedded local server is unavailable".to_string())?
        .mint_window(chan_server::WindowKind::Workspace, Some(canon))?;
    Ok(crate::window_watcher::native_label(&record))
}

/// `cs window hide` / the launcher window hide: route through the OS
/// close-button path so the existing bury handler (which knows this window's
/// restore key) runs. `close()` requests a close -- the handler hides SPA
/// windows -- unlike `destroy()`, which `rm` uses to truly remove. Resolves the
/// launcher's bare `window_id` to the composite native label first (see
/// [`serve::resolve_window_label`]).
fn hide_window(app: &AppHandle, id: &str) -> Result<(), String> {
    let label = serve::resolve_window_label(app, id);
    match app.get_webview_window(&label) {
        Some(w) => {
            // The launcher hide IS the explicit hide gesture, so suppress the
            // close handler's "was hidden, not closed" notice (that teaches the
            // red-button gesture). Flag the label before `close()` so the
            // CloseRequested bury consumes it; both run on the main thread.
            app.state::<Arc<AppState>>().mark_silent_hide(&label);
            w.close().map_err(|e| format!("hiding {id}: {e}"))
        }
        // A reaped / already-gone native window is an idempotent
        // silent no-op -- reply Ok(()) so the route returns 204, NOT Err (which maps
        // to 409 and floods the launcher's eye-handler console). Reaping a
        // standalone terminal's feed row on PTY exit; a client still holding the
        // just-removed row can click its eye, and that hide must land cleanly. Err
        // (→409) is reserved for the genuine "no desktop attached / manager gone"
        // case, which the route body already explains.
        None => Ok(()),
    }
}

/// `cs window rm`: truly destroy the window. When it still has live
/// terminal shells and `force` is unset, prompt first and only destroy on
/// confirm -- the reply (and thus the blocked CLI) waits for the dialog.
/// Reply: `Ok(true)` destroyed, `Ok(false)` no live window (the server
/// then deletes any saved layout), `Err("cancelled")` declined.
async fn close_window(
    app: AppHandle,
    state: Arc<AppState>,
    id: String,
    force: bool,
    reply: tokio::sync::oneshot::Sender<Result<bool, String>>,
) {
    if let Some(devserver_id) = id.strip_prefix("control-terminal-") {
        crate::close_devserver_control_terminal(&app, &state, devserver_id).await;
        let _ = reply.send(Ok(true));
        return;
    }

    // A remote row's registry lives on its devserver. Delete it there and let
    // the devserver watch reconcile close the local native view. This preserves
    // the existing remote-close behavior while local rows below gain proper
    // bare-id → composite-label resolution.
    if state.devserver_feed.record_for_window_id(&id).is_some() {
        let _ = reply.send(crate::discard_devserver_window_by_id(&app, &id).await);
        return;
    }

    let label = serve::resolve_window_label(&app, &id);
    // Probe liveness / title / live-shells on the main thread.
    let probe = {
        let app2 = app.clone();
        let state2 = Arc::clone(&state);
        let label2 = label.clone();
        on_main(&app, move || {
            app2.get_webview_window(&label2).map(|w| {
                let title = w.title().unwrap_or_else(|_| label2.clone());
                let shells = serve::window_has_live_shells(&state2, &label2);
                (title, shells)
            })
        })
        .await
    };
    let live = match probe {
        Ok(live) => live,
        Err(e) => {
            let _ = reply.send(Err(e));
            return;
        }
    };
    let Some((title, shells)) = live else {
        // An offline or buried local row has no live webview. The HTTP route
        // still discards its durable registry row after this false reply.
        let _ = reply.send(Ok(false));
        return;
    };

    if shells && !force {
        // Confirm before killing live terminals; the result callback completes
        // the reply (so the CLI blocks until the user answers). `native_dialog::
        // confirm` does the main-thread hop and, on macOS, routes Return to the
        // "Remove" default. If scheduling the modal fails, the callback never
        // runs, the reply sender drops, and the server maps that to an error.
        let app2 = app.clone();
        let state2 = Arc::clone(&state);
        let id2 = id.clone();
        let label2 = label.clone();
        crate::native_dialog::confirm(
            &app,
            "Remove window?",
            &format!("\"{title}\" has running terminals. Removing it will end them."),
            "Remove",
            "Cancel",
            move |confirmed| {
                if confirmed {
                    // Drop the authoritative row before destroying the view so
                    // the watcher cannot race the HTTP route and reopen it.
                    if let Some(embedded) = state2.embedded() {
                        let _ = embedded.discard_window(&id2);
                    }
                    let destroyed = app2
                        .get_webview_window(&label2)
                        .map(|w| w.destroy().is_ok())
                        .unwrap_or(false);
                    let _ = reply.send(Ok(destroyed));
                } else {
                    let _ = reply.send(Err("cancelled; window not removed".to_string()));
                }
            },
        );
        return;
    }

    // No shells, or forced: destroy now.
    // As in the confirmed branch, discard before destroy to prevent a watcher
    // reconcile from briefly recreating the still-authoritative row.
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

async fn set_remote_window_label(
    state: &Arc<AppState>,
    window_id: &str,
    label: &str,
) -> Result<(), String> {
    let Some((devserver_id, record)) = state.devserver_feed.record_for_window_id(window_id) else {
        return Err(format!("window {window_id} was not found"));
    };
    let Some(conn) = state.devservers.get(&devserver_id) else {
        return Err(format!("devserver {devserver_id} is not connected"));
    };
    crate::devserver::set_window_label(&conn, &record.window_id, label).await
}

/// Run `f` on the Tauri main thread and await its result. Tauri window
/// ops must run there; this bridges the async consumer task to it.
async fn on_main<T: Send + 'static>(
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
