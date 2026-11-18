//! Chan for iOS as a library: the Tauri mobile entry point plus the
//! shared mobile modules live here so both the app binary and the
//! staticlib the Xcode project links (`libapp.a`) build from one root.
//!
//! The crate is the desktop's loopback stack narrowed to one webview:
//! the embedded chan-server host and launcher, the gateway and
//! devserver connection flows, and the OAuth leg, without the desktop's
//! window watcher, menus, updater, CLI personalities, or handoff
//! socket. Module docs carry the per-area story.

// The boot that roots this crate's call graph (`ios::run`, the invoke
// table, the window-ops consumer) compiles only for iOS, so on host
// targets - which exist so the workspace check, test, and clippy gates
// cover the crate - much of the graph has no caller. Keep the host
// gates quiet without weakening the iOS build's own dead-code checks.
#![cfg_attr(not(target_os = "ios"), allow(dead_code))]

pub mod auth;
pub mod config;
pub mod devserver;
pub mod embedded;
pub mod gateway;

#[cfg(target_os = "ios")]
pub mod ios;
pub mod last_window;
pub mod mobile_auth;
pub mod native_transfer;
pub mod serve;
pub mod state;
pub mod terminal_opacity;
pub mod window_ops;
pub mod wireguard_keys;

pub(crate) use state::{AppState, DevserverFeed};

use std::sync::Arc;

use tauri::Manager;

/// The commit this binary was built from, stamped by build.rs
/// ("unknown" outside a git checkout). The version string alone
/// cannot identify a build: the version pins bump only at release
/// cut, so a pre-release branch build and the previous release's
/// bundle carry the same version. Logged at startup.
pub(crate) const CHAN_IOS_BUILD_ID: &str = env!("CHAN_IOS_BUILD_ID");

/// Process-wide tracing: `CHAN_LOG` wins, else warnings everywhere
/// and info from this crate, to stderr (the iOS console).
pub(crate) fn init_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("CHAN_LOG")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn,app=info")),
        )
        .with_writer(std::io::stderr)
        .init();
}

/// The one IPC command table for the single webview. The ACL in
/// `capabilities/` grants exactly these names to the windows that may
/// call them; keep the two in step.
pub(crate) fn app_invoke_handler(
) -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        // The desktop's terminal background opacity: a page reads it
        // at load and the Settings slider writes it; later changes
        // reach every window as the terminal_opacity::EVENT event.
        terminal_opacity::terminal_background_opacity,
        terminal_opacity::set_terminal_background_opacity,
        // Back to Computers on the single-webview build: re-navigates
        // to the loopback launcher URL.
        mobile_auth::mobile_back_to_computers,
        // The gateway CSRF token a tenant page presents on its
        // management calls.
        devserver::gateway_csrf_token,
    ]
}

/// iOS entry, called from Swift as `start_app` through Tauri's mobile
/// entry point; runs the single-webview app and returns only when the
/// process exits.
#[cfg(target_os = "ios")]
#[tauri::mobile_entry_point]
pub fn ios_entry() {
    ios::run();
}

/// Re-push the launcher feed and tell the windows the serve set
/// changed, the pair every devserver state change ends with.
fn refresh_launcher(app: &tauri::AppHandle, state: &AppState) {
    if let Some(embedded) = state.embedded() {
        embedded.signal_library_change();
    }
    let _ = tauri::Emitter::emit(app, serve::SERVES_CHANGED, ());
}

/// Fully tear down a devserver connection: drop the connection, forget
/// its feed rows, and reap its control terminal, then refresh the
/// launcher. The full teardown behind the launcher's Disconnect bridge
/// op and the HTTP-DELETE remove hook, where the connection is going
/// away for good. Idempotent; safe to call when the devserver is
/// already disconnected. The desktop also stops a window watcher and
/// destroys native windows; iOS has neither, so the feed forget is
/// what takes the rows out of the launcher.
pub(crate) async fn teardown_devserver_connection(
    app: &tauri::AppHandle,
    state: &AppState,
    id: &str,
) {
    state.devservers.remove(id);
    // A full teardown reaps the control terminal, so the reconnect
    // block must not outlive it: the block's invariant is that a kept
    // "process exited" terminal exists for the user to close.
    state.control_terminal_dead.lock().unwrap().remove(id);
    state.devserver_feed.forget(id);
    state.devserver_feed.set_down(id, false);
    close_devserver_control_terminal(app, state, id).await;
    refresh_launcher(app, state);
}

/// Persist native trust for a shared gateway devserver and bump its policy
/// generation so an in-flight connect rechecks. An owned devserver is refused:
/// it never needs trust.
async fn grant_devserver_native_trust(
    app: &tauri::AppHandle,
    state: &Arc<AppState>,
    id: &str,
) -> Result<(), String> {
    let (gateway_id, owner, devserver_id) = gateway::parse_synthesized_id(id)
        .ok_or_else(|| "native trust is only available for gateway devservers".to_string())?;
    let policy_lock = state.native_policy_lock(id);
    let _policy_guard = policy_lock.lock().await;
    let row = state
        .gateway_manager
        .roster_row(&gateway_id, &owner, &devserver_id)
        .ok_or_else(|| "the gateway roster no longer contains this devserver".to_string())?;
    if !row.shared {
        return Err("owned devservers do not require native trust".to_string());
    }
    config::set_native_trust(
        &state.store,
        &gateway_id,
        row.owner_user_id,
        &owner,
        &devserver_id,
        true,
    )?;
    state.bump_native_policy_generation(id);
    refresh_launcher(app, state);
    Ok(())
}

/// Withdraw native trust from a shared gateway devserver, bump its policy
/// generation, and tear down its live connection, which was admitted under the
/// trust being withdrawn.
async fn revoke_devserver_native_trust(
    app: &tauri::AppHandle,
    state: &Arc<AppState>,
    id: &str,
) -> Result<(), String> {
    let (gateway_id, owner, devserver_id) = gateway::parse_synthesized_id(id)
        .ok_or_else(|| "native trust is only available for gateway devservers".to_string())?;
    let policy_lock = state.native_policy_lock(id);
    let _policy_guard = policy_lock.lock().await;
    let row = state
        .gateway_manager
        .roster_row(&gateway_id, &owner, &devserver_id)
        .ok_or_else(|| "the gateway roster no longer contains this devserver".to_string())?;
    if !row.shared {
        return Err("owned devservers do not carry revocable native trust".to_string());
    }
    config::set_native_trust(
        &state.store,
        &gateway_id,
        row.owner_user_id,
        &owner,
        &devserver_id,
        false,
    )?;
    state.bump_native_policy_generation(id);
    crate::teardown_devserver_connection(app, state, id).await;
    refresh_launcher(app, state);
    Ok(())
}

/// The user explicitly closed the control terminal window. This is
/// different from the connect script exiting inside an otherwise open
/// terminal: the row should leave the launcher, not linger flashing
/// for attention. The desktop also destroys a native window and
/// rebuilds its Window menu; iOS has neither, so reaping the registry
/// row and refreshing the launcher is the whole close.
pub(crate) async fn close_devserver_control_terminal(
    app: &tauri::AppHandle,
    state: &AppState,
    id: &str,
) {
    let was_connected = state.devservers.is_connected(id);
    if was_connected {
        state.devservers.remove(id);
    }
    // Closing a dead control terminal (the user read the death
    // reason) clears the reconnect block: the devserver is now ready
    // to connect again.
    state.control_terminal_dead.lock().unwrap().remove(id);
    state.control_terminal_runs.lock().unwrap().remove(id);
    let label = format!("control-terminal-{id}");
    state.remove_buried(&label);
    if let Some(embedded) = state.embedded() {
        embedded.reap_control_window(&label).await;
        embedded.signal_library_change();
    }
    let _ = app;
}

async fn discard_devserver_window_by_id(
    app: &tauri::AppHandle,
    window_id: &str,
) -> Result<bool, String> {
    let state = app.state::<Arc<AppState>>();
    if state
        .devserver_feed
        .record_for_window_id(window_id)
        .is_none()
    {
        return Ok(false);
    };
    // The row lives on its devserver, and this build has no devserver
    // management transport to DELETE it with (the auth lane's entry
    // client mints and navigates; it does not discard). Refuse loudly
    // rather than pretend the row went away.
    Err("closing a devserver window is not supported on this build".to_string())
}

/// Open a devserver workspace in the single webview: mint the window
/// record on the devserver's library, resolve the tenant URL through
/// the validated entry exchange, reinstall the gateway session
/// cookies, then navigate. Reached over the desktop bridge from the
/// launcher's `workspaces/open` route.
pub(crate) async fn open_devserver_workspace_impl(
    state: &Arc<AppState>,
    id: String,
    path: String,
    start_terminal: bool,
) -> Result<(), String> {
    mobile_auth::mobile_open_devserver(
        state,
        &id,
        chan_server::WindowKind::Workspace,
        Some(path),
        start_terminal,
    )
    .await
}

/// Mint a standalone terminal window on a connected devserver's
/// library and navigate the single webview to it (the launcher's
/// per-devserver New Terminal button). Reached over the desktop
/// bridge from the launcher's per-devserver `terminal` route.
pub(crate) async fn open_devserver_terminal_impl(
    state: &Arc<AppState>,
    id: String,
) -> Result<(), String> {
    mobile_auth::mobile_open_devserver(state, &id, chan_server::WindowKind::Terminal, None, false)
        .await
}

/// Forget (unmount) a workspace on a connected devserver. This build
/// has no devserver workspace-lifecycle transport (the auth lane's
/// entry client mints and navigates; it does not mount or unmount),
/// so the op refuses loudly instead of parking. Reached over the
/// desktop bridge from the launcher's `workspaces/{prefix}` DELETE
/// route.
pub(crate) async fn forget_devserver_workspace_impl(
    _state: &Arc<AppState>,
    _id: String,
    _prefix: String,
    _force: bool,
) -> Result<chan_server::SetWorkspaceOnOutcome, String> {
    Err("forgetting a devserver workspace is not supported on this build".to_string())
}

/// Set a registered devserver workspace on or off. Same refusal as
/// [`forget_devserver_workspace_impl`]: no workspace-lifecycle
/// transport exists on this build. Reached over the desktop bridge
/// from the launcher's `workspaces/on|off` routes.
pub(crate) async fn set_devserver_workspace_on_impl(
    _state: &Arc<AppState>,
    _id: String,
    _prefix: String,
    _on: bool,
    _force: bool,
) -> Result<chan_server::SetWorkspaceOnOutcome, String> {
    Err("turning a devserver workspace on or off is not supported on this build".to_string())
}

/// Ask for focus on a newly minted terminal window. The desktop's
/// watcher owns the native build and raises it; iOS has one webview
/// and no watcher, and the minted row already renders in the launcher
/// the webview shows, so there is nothing to raise.
pub(crate) fn raise_new_terminal_window(
    app: tauri::AppHandle,
    state: std::sync::Arc<AppState>,
    label: String,
    startup_id: Option<String>,
) {
    let _ = (&app, &state, &label, &startup_id);
    tracing::debug!(%label, "terminal window minted; the single webview already shows the launcher");
}
