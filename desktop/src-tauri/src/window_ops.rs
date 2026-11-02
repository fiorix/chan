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
//! main internally). Each op runs in its own task so a blocking folder
//! picker cannot stall unrelated ops.

use std::path::Path;
use std::sync::Arc;

use chan_server::{DesktopWindowOp, NewWindowKind};
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::mpsc;

use crate::last_window::{self, Gesture};
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
            let result = on_main(&app, move || serve::open_window_by_label(&app2, &id))
                .await
                .and_then(|inner| inner);
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
            let app2 = app.clone();
            let result = on_main(&app, move || hide_window(&app2, &id))
                .await
                .and_then(|inner| inner);
            let _ = reply.send(result);
        }
        DesktopWindowOp::Close { id, reply } => {
            close_window(app, state, id, reply).await;
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
/// (the watcher opens it). Errors when no workspace runtime of the embedded
/// host goes by `key`. The host is asked rather than the desktop's own map
/// of what it mounted, since the launcher's on and off mount and unmount
/// through the host alone; it answers from the keys it stores, and `key`,
/// the root the workspace's registry row stores as its control socket sends
/// it, is one of them, so nothing is resolved. Returns the new window's
/// composite native label.
async fn new_workspace_window(state: &Arc<AppState>, key: &str) -> Result<String, String> {
    let embedded = state
        .embedded()
        .ok_or_else(|| "embedded local server is unavailable".to_string())?;
    if !embedded.is_workspace_mounted_by_key(Path::new(key)) {
        return Err(format!("workspace {key} is not running"));
    }
    let record = embedded.mint_workspace_window(Path::new(key))?;
    Ok(crate::window_watcher::native_label(&record))
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
        // (→409) is reserved for the genuine "no desktop attached / manager gone"
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
    // bare-id → composite-label resolution.
    if state.devserver_feed.record_for_window_id(&id).is_some() {
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

async fn request_remote_tmux(
    state: &Arc<AppState>,
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
    crate::devserver::tmux_request(&conn, connection, request).await
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
    use super::*;
    use crate::tests::handoff_row::Desktop;

    fn own_home(test: &str) -> bool {
        crate::embedded::in_own_chan_home(&format!("window_ops::tests::{test}"))
    }

    /// `cs window new` opens a window of a workspace the launcher turned on:
    /// the host mounted it, and the desktop's own map of what it serves never
    /// saw it.
    #[test]
    fn cs_window_new_opens_a_window_of_a_workspace_the_launcher_turned_on() {
        if !own_home("cs_window_new_opens_a_window_of_a_workspace_the_launcher_turned_on") {
            return;
        }
        let desktop = Desktop::new();
        let root = tempfile::tempdir().expect("root");
        let stored = desktop.register(root.path());
        let key = stored.to_string_lossy().into_owned();
        desktop
            .runtime
            .block_on(desktop.embedded().open_workspace(&key))
            .expect("the host mounts the workspace");
        let opened = desktop
            .runtime
            .block_on(new_workspace_window(&desktop.state, &key));
        assert!(
            opened.is_ok(),
            "cs window new refused a workspace the host serves: {opened:?}"
        );
        assert_eq!(
            desktop.window_paths(),
            [stored],
            "cs window new did not open a window under the registry row"
        );
    }

    /// `cs window hide` and the launcher's Hide on chan's last shown window
    /// are refused while a hidden window's terminal lives: the reply carries
    /// the guard's sentence and the window is neither flagged nor closed.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_hide_of_the_last_shown_window_is_refused_with_the_reason() {
        let desk = crate::last_window::tests::Desk::new().await;
        let shown = desk.window("local::w-shown");
        desk.window("local::w-hidden");
        desk.state.bury_window("local::w-hidden", "Hidden");
        let url = desk
            .embedded()
            .open_terminal_with_command("true".into())
            .await
            .unwrap()
            .0;
        desk.embedded()
            .spawn_terminal_for_tests(&url, Some("w-hidden"))
            .await;
        let refused = hide_window(desk.app.handle(), "w-shown");
        assert!(
            matches!(&refused, Err(sentence) if sentence.starts_with("this is chan's last shown window: hiding it")),
            "got {refused:?}"
        );
        assert!(
            !desk.state.take_silent_hide("local::w-shown"),
            "a refused hide flagged the window for a bury"
        );
        assert!(
            shown.is_visible().unwrap_or(true),
            "a refused hide closed the window"
        );
        // A second shown window lets the same hide go ahead.
        desk.window("local::w-other");
        assert_eq!(hide_window(desk.app.handle(), "w-shown"), Ok(()));
    }

    /// With no live terminal the hide of the last shown window goes ahead as
    /// it always has.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_hide_of_the_last_shown_window_with_no_live_terminal_goes_ahead() {
        let desk = crate::last_window::tests::Desk::new().await;
        desk.window("local::w-last");
        assert_eq!(hide_window(desk.app.handle(), "w-last"), Ok(()));
        assert!(
            desk.state.take_silent_hide("local::w-last"),
            "the hide flagged the window for its bury"
        );
    }

    /// `cs window rm` and the launcher's Close of chan's last shown window
    /// ask the guard by the window's bare id, as the bridge sends it: the
    /// sessions of other windows refuse it, its own do not.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_removal_of_the_last_shown_window_is_refused_for_other_windows_terminals() {
        let desk = crate::last_window::tests::Desk::new().await;
        desk.window("local::w-last");
        let url = desk
            .embedded()
            .open_terminal_with_command("true".into())
            .await
            .unwrap()
            .0;
        desk.embedded()
            .spawn_terminal_for_tests(&url, Some("w-last"))
            .await;
        assert_eq!(
            close_refusal(desk.app.handle(), &desk.state, "w-last"),
            Ok(()),
            "the window's own shell ends with the forced removal"
        );
        desk.embedded()
            .spawn_terminal_for_tests(&url, Some("w-hidden"))
            .await;
        let refused = close_refusal(desk.app.handle(), &desk.state, "w-last");
        assert!(
            matches!(&refused, Err(sentence) if sentence.contains("end 1 other running terminal session(s)")),
            "got {refused:?}"
        );
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

    /// `cs window new` in a relinked root the boot restored opens a window
    /// under its registry row: the key a workspace's control socket sends is
    /// the root the row stores.
    #[cfg(unix)]
    #[test]
    fn cs_window_new_opens_a_window_of_a_restored_relinked_root_under_its_row() {
        if !own_home("cs_window_new_opens_a_window_of_a_restored_relinked_root_under_its_row") {
            return;
        }
        let desktop = Desktop::new();
        let root = crate::tests::handoff_row::Relinked::register(&desktop);
        desktop.restore(&root.stored);
        let key = root.stored.to_string_lossy().into_owned();
        let opened = desktop
            .runtime
            .block_on(new_workspace_window(&desktop.state, &key));
        assert!(
            opened.is_ok(),
            "cs window new refused a restored relinked root: {opened:?}"
        );
        assert_eq!(
            desktop.window_paths(),
            std::slice::from_ref(&root.stored),
            "cs window new did not open a window under the registry row"
        );
    }
}
