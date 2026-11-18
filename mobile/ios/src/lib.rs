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

pub(crate) mod auth;
pub(crate) mod config;
pub(crate) mod devserver;
pub(crate) mod embedded;
pub(crate) mod gateway;

#[cfg(target_os = "ios")]
pub mod ios;
pub(crate) mod last_window;
pub(crate) mod mobile_auth;
pub(crate) mod native_transfer;
pub(crate) mod runtime_capability;
pub(crate) mod serve;
pub(crate) mod state;
pub(crate) mod terminal_opacity;
pub(crate) mod window_ops;
pub(crate) mod wireguard_keys;

pub(crate) use state::{AppState, DevserverFeed};

use std::sync::Arc;

use tauri::Manager;

/// The commit this binary was built from, stamped by build.rs
/// ("unknown" outside a git checkout). The version string alone
/// cannot identify a build: the version pins bump only at release
/// cut, so a pre-release branch build and the previous release's
/// bundle carry the same version. Logged at startup.
pub(crate) const CHAN_IOS_BUILD_ID: &str = env!("CHAN_IOS_BUILD_ID");

/// Error marker for native access that requires an explicit trust grant.
pub(crate) const NATIVE_TRUST_REQUIRED: &str = "native_trust_required";

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
/// `capabilities/` and [`runtime_capability`] grants exactly these names
/// to `"main"` on the origins that may call them; keep them in step.
pub(crate) fn app_invoke_handler(
) -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        // The app's terminal background opacity: a page reads it at load
        // and the Settings slider writes it; later changes reach the
        // webview as the terminal_opacity::EVENT event.
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

/// Re-push the launcher feed and tell the webview the serve set
/// changed, the pair every devserver state change ends with.
fn refresh_launcher<R: tauri::Runtime>(app: &tauri::AppHandle<R>, state: &AppState) {
    if let Some(embedded) = state.embedded() {
        embedded.signal_library_change();
    }
    let _ = tauri::Emitter::emit(app, serve::SERVES_CHANGED, ());
}

/// Fully tear down a devserver connection: drop the connection, forget
/// its feed rows, and reap its control terminal, then refresh the
/// launcher. Idempotent; safe to call when the devserver is already
/// disconnected.
pub(crate) async fn teardown_devserver_connection<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
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

/// The roster row for a gateway devserver, refused when the roster no longer
/// lists it or when a shared row has no persisted native-trust record for its
/// exact owner and devserver. An owned row never needs trust.
fn require_rostered_native_policy(
    state: &AppState,
    gateway_id: &str,
    owner: &str,
    devserver_id: &str,
) -> Result<gateway::RosterDevserver, String> {
    let row = state
        .gateway_manager
        .roster_row(gateway_id, owner, devserver_id)
        .ok_or_else(|| "the gateway roster no longer contains this devserver".to_string())?;
    let cfg = state
        .store
        .lock()
        .unwrap()
        .get()
        .map_err(|e| e.to_string())?;
    let gateway = cfg
        .gateways
        .iter()
        .find(|gateway| gateway.id == gateway_id)
        .ok_or_else(|| format!("no gateway {gateway_id}"))?;
    if row.shared && !gateway.trusts_native(row.owner_user_id, devserver_id) {
        return Err(NATIVE_TRUST_REQUIRED.to_string());
    }
    Ok(row)
}

/// [`require_rostered_native_policy`], refused as well when the devserver's
/// native-policy generation moved past `expected_generation`, so a connect
/// that raced a trust grant or revoke stops at its next recheck.
fn require_rostered_native_policy_generation(
    state: &AppState,
    id: &str,
    gateway_id: &str,
    owner: &str,
    devserver_id: &str,
    expected_generation: u64,
) -> Result<gateway::RosterDevserver, String> {
    if state.native_policy_generation(id) != expected_generation {
        return Err("devserver native trust changed while connecting".to_string());
    }
    require_rostered_native_policy(state, gateway_id, owner, devserver_id)
}

/// Split the gateway proxy origin into the host and port the connection stores.
fn origin_host_port(origin: &str) -> Result<(String, u16), String> {
    let parsed =
        url::Url::parse(origin).map_err(|e| format!("invalid gateway proxy origin: {e}"))?;
    let host = parsed
        .host_str()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| "gateway proxy origin has no host".to_string())?
        .to_string();
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "gateway proxy origin has no port and an unknown scheme".to_string())?;
    Ok((host, port))
}

/// The name shown for a gateway devserver: its configured label, else the
/// gateway URL's host, else the proxy origin's host, else the raw gateway URL.
fn gateway_display_name(configured_label: &str, gateway_url: &str, proxy_origin: &str) -> String {
    if !configured_label.is_empty() {
        return configured_label.to_string();
    }
    url::Url::parse(gateway_url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .or_else(|| {
            url::Url::parse(proxy_origin)
                .ok()
                .and_then(|u| u.host_str().map(str::to_string))
        })
        .unwrap_or_else(|| gateway_url.to_string())
}

/// The runtime-independent head of a rostered-devserver connect: mint the
/// entry through the gateway with the explicit `(owner, devserver_id)` target
/// and narrate failures (a 401 runs the gateway cascade; an offline row emits
/// a devserver-sourced notice beside the failed connect).
async fn rostered_conn<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<AppState>,
    id: &str,
    gateway_id: &str,
    owner: &str,
    devserver_id: &str,
) -> Result<devserver::DevserverConn, String> {
    let row = require_rostered_native_policy(state, gateway_id, owner, devserver_id)?;
    let Some(discovery) = state.gateway_manager.discovery(gateway_id) else {
        return Err("connect the gateway first - its roster supplies this devserver".into());
    };
    let row_label = row.label;
    let Some(pat) = auth::load_gateway_pat(&discovery.identity_origin)? else {
        return Err("the gateway sign-in is missing - reconnect the gateway".into());
    };
    let gateway = match devserver::gateway_conn(
        &discovery,
        pat.secret,
        Some(devserver::GatewayEntryTarget {
            owner_user_id: row.owner_user_id,
            owner: owner.to_string(),
            devserver_id: devserver_id.to_string(),
        }),
    )
    .await
    {
        Ok(gateway) => gateway,
        Err(devserver::GatewayEntryError::Unauthorized) => {
            // The caller holds this row's policy lock, which the cascade needs.
            // Return the refusal so the caller releases it before teardown.
            let app = app.clone();
            let state = Arc::clone(state);
            let gateway_id = gateway_id.to_string();
            tauri::async_runtime::spawn(async move {
                gateway::cascade_disconnect(
                    &app,
                    &state,
                    &gateway_id,
                    gateway::CascadeReason::Unauthorized,
                )
                .await;
            });
            return Err("the gateway sign-in is no longer valid - reconnect the gateway".into());
        }
        Err(e @ devserver::GatewayEntryError::DevserverOffline { .. }) => {
            let label = if row_label.is_empty() {
                devserver_id.chars().take(12).collect::<String>()
            } else {
                row_label.clone()
            };
            gateway::emit_notice(
                app,
                "info",
                "devserver",
                id,
                &label,
                "Devserver offline",
                &e.to_string(),
            );
            return Err(e.to_string());
        }
        Err(e) => return Err(e.to_string()),
    };
    let (host, port) = origin_host_port(&gateway.proxy_origin)?;
    let name = gateway_display_name(
        &row_label,
        &discovery.identity_origin,
        &gateway.proxy_origin,
    );
    Ok(devserver::DevserverConn {
        host,
        port,
        token: String::new(),
        name,
        gateway: Some(Box::new(gateway)),
    })
}

fn to_launcher_workspace(
    devserver_id: &str,
    library_id: Option<String>,
    row: devserver::DevserverWorkspaceRow,
) -> chan_server::LauncherWorkspace {
    let slug = row.prefix.trim_start_matches('/').to_string();
    chan_server::LauncherWorkspace {
        workspace_id: slug.clone(),
        path: row.path,
        status: row.status,
        error: row.error,
        label: row.label,
        on: row.on,
        library_id,
        devserver_id: Some(devserver_id.to_string()),
        prefix: slug,
    }
}

fn devserver_route_prefix(slug: &str) -> String {
    if slug.starts_with('/') {
        slug.to_string()
    } else {
        format!("/{slug}")
    }
}

async fn refresh_devserver_workspace_cache(
    state: &Arc<AppState>,
    id: &str,
    conn: &devserver::DevserverConn,
) -> Result<(), String> {
    let rows = devserver::fetch_workspaces(conn).await?;
    let library_id = state.devserver_feed.library_id_of(id);
    let mapped = rows
        .into_iter()
        .map(|r| to_launcher_workspace(id, library_id.clone(), r))
        .collect();
    state.devserver_feed.set_workspaces(id.to_string(), mapped);
    if let Some(embedded) = state.embedded() {
        embedded.signal_library_change();
    }
    Ok(())
}

/// Periodically refresh a connected rostered devserver's workspace and window
/// lists in [`DevserverFeed`], stopping cleanly once `id` is disconnected or
/// replaced by another connection in `state.devservers`.
fn spawn_rostered_devserver_poll(
    state: Arc<AppState>,
    id: String,
    conn: devserver::DevserverConn,
    snapshot: Arc<std::sync::Mutex<state::DevserverWindowSnapshot>>,
    initial_ws: Vec<devserver::DevserverWorkspaceRow>,
    initial_windows: Vec<chan_server::WindowRecord>,
) {
    const POLL: std::time::Duration = std::time::Duration::from_secs(5);
    tauri::async_runtime::spawn(async move {
        let initial_lib = state.devserver_feed.library_id_of(&id);
        let mut last_ws = Some((initial_ws, initial_lib));
        let mut last_windows = initial_windows;
        loop {
            tokio::time::sleep(POLL).await;
            if !state.devservers.is_same_gateway_conn(&id, &conn) {
                return;
            }
            let ws_res = devserver::fetch_workspaces(&conn).await;
            let win_res = if ws_res.is_ok() {
                Some(devserver::fetch_library_windows(&id, &conn).await)
            } else {
                None
            };
            if !state.devservers.is_same_gateway_conn(&id, &conn) {
                return;
            }
            let mut changed = false;
            match ws_res {
                Ok(rows) => {
                    if state.devserver_feed.set_down(&id, false) {
                        changed = true;
                    }
                    if let Some(Ok(windows)) = win_res {
                        if let Some(lib_id) = windows.first().map(|w| w.library_id.clone()) {
                            state.devserver_feed.seed_library_id(id.clone(), lib_id);
                        }
                        if windows != last_windows {
                            *snapshot.lock().unwrap() =
                                state::DevserverWindowSnapshot::from(windows.clone());
                            last_windows = windows;
                            changed = true;
                        }
                    }
                    let library_id = state.devserver_feed.library_id_of(&id);
                    let key = (rows.clone(), library_id.clone());
                    if last_ws.as_ref() != Some(&key) {
                        let mapped = rows
                            .into_iter()
                            .map(|r| to_launcher_workspace(&id, library_id.clone(), r))
                            .collect();
                        state.devserver_feed.set_workspaces(id.clone(), mapped);
                        last_ws = Some(key);
                        changed = true;
                    }
                }
                Err(e) => {
                    tracing::debug!(
                        devserver = %id,
                        error = %e,
                        "polling devserver workspaces failed"
                    );
                    if state.devserver_feed.set_down(&id, true) {
                        changed = true;
                    }
                }
            }
            if changed {
                if let Some(embedded) = state.embedded() {
                    embedded.signal_library_change();
                }
            }
        }
    });
}

/// Connect one rostered gateway devserver (a synthesized `gw:` row): enforce
/// native trust policy across every async seam, mint the exact-origin runtime
/// capability grant, install the WebView session cookies, authenticate the
/// proxy by fetching workspaces (plus best-effort windows, colour, and host
/// OS), populate [`DevserverFeed`], and start the background poll loop.
pub(crate) async fn connect_rostered_devserver<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: Arc<AppState>,
    id: String,
) -> Result<(), String> {
    let Some((gateway_id, owner, devserver_id)) = gateway::parse_synthesized_id(&id) else {
        return Err(format!(
            "connecting a direct devserver is not supported on this build; connect through a gateway (id {id})"
        ));
    };
    if state.devservers.is_connected(&id) {
        return Ok(());
    }
    {
        let mut connecting = state.devserver_connecting.lock().unwrap();
        if !connecting.insert(id.clone()) {
            return Ok(());
        }
    }
    refresh_launcher(&app, &state);
    let result =
        connect_rostered_devserver_inner(&app, &state, &id, &gateway_id, &owner, &devserver_id)
            .await;
    state.devserver_connecting.lock().unwrap().remove(&id);
    refresh_launcher(&app, &state);
    result
}

async fn connect_rostered_devserver_inner<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<AppState>,
    id: &str,
    gateway_id: &str,
    owner: &str,
    devserver_id: &str,
) -> Result<(), String> {
    let policy_lock = state.native_policy_lock(id);
    let _policy_guard = policy_lock.lock().await;
    if state.devservers.is_connected(id) {
        return Ok(());
    }
    let policy_generation = state.native_policy_generation(id);
    let recheck = || {
        require_rostered_native_policy_generation(
            state,
            id,
            gateway_id,
            owner,
            devserver_id,
            policy_generation,
        )
    };
    recheck()?;
    let conn = rostered_conn(app, state, id, gateway_id, owner, devserver_id).await?;

    let proxy_origin = conn
        .gateway
        .as_ref()
        .expect("rostered connections are gateway-backed")
        .proxy_origin
        .clone();
    runtime_capability::mint_exact_origin_grant(app, &proxy_origin)
        .map_err(|e| format!("granting native access for this devserver failed: {e}"))?;
    recheck()?;
    devserver::install_gateway_webview_session(app, &conn, None)
        .map_err(|e| format!("installing gateway WebView session: {e}"))?;

    let rows = devserver::fetch_workspaces(&conn)
        .await
        .map_err(|e| format!("authenticating gateway devserver proxy: {e}"))?;
    recheck()?;

    let windows = match devserver::fetch_library_windows(id, &conn).await {
        Ok(windows) => windows,
        Err(e) => {
            tracing::debug!(
                devserver = %id,
                error = %e,
                "eager gateway library windows fetch failed; the poll loop will retry",
            );
            Vec::new()
        }
    };
    recheck()?;

    let color = match devserver::fetch_local_color(&conn).await {
        Ok(color) => Some(color),
        Err(e) => {
            tracing::debug!(
                devserver = %id,
                error = %e,
                "eager gateway pane-colour seed failed",
            );
            None
        }
    };
    recheck()?;

    let host_os = match devserver::fetch_gateway_host_os(&conn).await {
        Ok(os) => Some(os),
        Err(e) => {
            tracing::debug!(
                devserver = %id,
                error = %e,
                "gateway OS seed failed; the machine icon stays neutral",
            );
            None
        }
    };
    recheck()?;

    state.devservers.set(id.to_string(), conn.clone());
    state.devserver_feed.set_down(id, false);
    if let Some(lib_id) = windows.first().map(|w| w.library_id.clone()) {
        state.devserver_feed.seed_library_id(id.to_string(), lib_id);
    }
    let snapshot = Arc::new(std::sync::Mutex::new(state::DevserverWindowSnapshot::from(
        windows.clone(),
    )));
    state
        .devserver_feed
        .register_windows(id.to_string(), Arc::clone(&snapshot));
    let library_id = state.devserver_feed.library_id_of(id);
    let mapped = rows
        .iter()
        .cloned()
        .map(|r| to_launcher_workspace(id, library_id.clone(), r))
        .collect();
    state.devserver_feed.set_workspaces(id.to_string(), mapped);
    if let Some(os) = host_os {
        state.devserver_feed.seed_os(id.to_string(), os, None);
    }
    if let Some(color) = color {
        state.devserver_feed.set_color(id.to_string(), color);
    }
    spawn_rostered_devserver_poll(
        Arc::clone(state),
        id.to_string(),
        conn,
        snapshot,
        rows,
        windows,
    );
    Ok(())
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

/// The user explicitly closed the control terminal window. Reaping the
/// registry row and refreshing the launcher removes it cleanly.
pub(crate) async fn close_devserver_control_terminal<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
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
    // The row lives on its devserver, and this build exposes no remote window
    // discard endpoint. Refuse loudly rather than pretend the row went away.
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

/// Forget (unmount) a workspace on a connected devserver via its management
/// API. Reached over the desktop bridge from the launcher's
/// `workspaces/{prefix}` DELETE route.
pub(crate) async fn forget_devserver_workspace_impl(
    state: &Arc<AppState>,
    id: String,
    prefix: String,
    force: bool,
) -> Result<chan_server::SetWorkspaceOnOutcome, String> {
    let conn = state
        .devservers
        .get(&id)
        .ok_or_else(|| format!("devserver {id} is not connected"))?;
    match devserver::forget_workspace(&conn, &devserver_route_prefix(&prefix), force).await {
        Ok(()) => {
            if let Err(e) = refresh_devserver_workspace_cache(state, &id, &conn).await {
                tracing::warn!(
                    devserver = %id,
                    error = %e,
                    "refreshing devserver workspaces after forget failed"
                );
            }
            Ok(chan_server::SetWorkspaceOnOutcome::Done { workspace: None })
        }
        Err(devserver::SetWorkspaceOnError::ActiveTerminals { active_terminals }) => {
            Ok(chan_server::SetWorkspaceOnOutcome::NeedsForce { active_terminals })
        }
        Err(devserver::SetWorkspaceOnError::Refused { message })
        | Err(devserver::SetWorkspaceOnError::Other { message }) => Err(message),
    }
}

/// Set a registered devserver workspace on or off, distinct from Forget
/// ([`forget_devserver_workspace_impl`]). Reached over the desktop bridge from
/// the launcher's `workspaces/on|off` routes.
pub(crate) async fn set_devserver_workspace_on_impl(
    state: &Arc<AppState>,
    id: String,
    prefix: String,
    on: bool,
    force: bool,
) -> Result<chan_server::SetWorkspaceOnOutcome, String> {
    let conn = state
        .devservers
        .get(&id)
        .ok_or_else(|| format!("devserver {id} is not connected"))?;
    match devserver::set_workspace_on(&conn, &devserver_route_prefix(&prefix), on, force).await {
        Ok(row) => {
            if let Err(e) = refresh_devserver_workspace_cache(state, &id, &conn).await {
                tracing::warn!(
                    devserver = %id,
                    error = %e,
                    "refreshing devserver workspaces after toggle failed"
                );
            }
            let workspace = if on {
                row.map(|row| {
                    to_launcher_workspace(&id, state.devserver_feed.library_id_of(&id), row)
                })
            } else {
                None
            };
            Ok(chan_server::SetWorkspaceOnOutcome::Done { workspace })
        }
        Err(devserver::SetWorkspaceOnError::ActiveTerminals { active_terminals }) => {
            Ok(chan_server::SetWorkspaceOnOutcome::NeedsForce { active_terminals })
        }
        Err(devserver::SetWorkspaceOnError::Refused { message })
        | Err(devserver::SetWorkspaceOnError::Other { message }) => Err(message),
    }
}

/// Ask for focus on a newly minted terminal window. On iOS the single webview
/// has no watcher and the minted row already renders in the launcher, so there
/// is nothing to raise.
pub(crate) fn raise_new_terminal_window(
    app: tauri::AppHandle,
    state: std::sync::Arc<AppState>,
    label: String,
    startup_id: Option<String>,
) {
    let _ = (&app, &state, &label, &startup_id);
    tracing::debug!(%label, "terminal window minted; the single webview already shows the launcher");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tauri::Listener;

    fn test_state() -> (tempfile::TempDir, Arc<AppState>) {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(config::ConfigStore::at_path(
            dir.path().join("config.json"),
        )));
        (dir, Arc::new(AppState::with_store(store)))
    }

    #[tokio::test]
    async fn shared_rostered_policy_requires_exact_persisted_trust() {
        let (_dir, state) = test_state();
        let gateway_id = "gw-feedface";
        let owner = "bob";
        let devserver_id = "d".repeat(64);
        let synth_id = gateway::synthesized_row_id(gateway_id, owner, &devserver_id);
        {
            let mut store = state.store.lock().unwrap();
            let mut cfg = store.get().unwrap();
            cfg.gateways.push(config::Gateway {
                id: gateway_id.into(),
                url: "https://id.example.test".into(),
                label: String::new(),
                enabled: true,
                added_at: 0,
                native_trust: Vec::new(),
                wireguard: None,
                wireguard_public_key: None,
                wireguard_enrolled_key: None,
                wireguard_enrollment: None,
                wireguard_cleanup: None,
                wireguard_hosts: Vec::new(),
            });
            store.save(&cfg).unwrap();
        }
        let discovery = devserver::GatewayDiscovery {
            kind: "chan-gateway".into(),
            api_version: 1,
            identity_origin: "https://id.example.test".into(),
            mobile_authorize_url: "https://id.example.test/mobile/authorize".into(),
            mobile_entry_url: "https://id.example.test/mobile/v1/devserver/entry".into(),
            mobile_roster_url: "https://id.example.test/mobile/v1/devservers".into(),
            devserver_proxy_origin: "https://devserver.example.test".into(),
            devserver_proxy_host_depth: 2,
            wireguard: None,
        };
        state.gateway_manager.seed_test_runtime(
            gateway_id,
            discovery.clone(),
            vec![gateway::RosterDevserver {
                owner_user_id: uuid::Uuid::from_u128(2),
                owner: owner.into(),
                devserver_id: devserver_id.clone(),
                label: "shared".into(),
                online: true,
                shared: true,
                proxy_origin: Some("https://bob--dddddddddddd.p1.devserver.example.test".into()),
            }],
        );

        let app = tauri::test::mock_app();
        assert_eq!(
            rostered_conn(
                app.handle(),
                &state,
                &synth_id,
                gateway_id,
                owner,
                &devserver_id
            )
            .await
            .unwrap_err(),
            NATIVE_TRUST_REQUIRED
        );

        config::set_native_trust(
            &state.store,
            gateway_id,
            uuid::Uuid::from_u128(3),
            "someone-else",
            &devserver_id,
            true,
        )
        .unwrap();
        assert_eq!(
            require_rostered_native_policy(&state, gateway_id, owner, &devserver_id).unwrap_err(),
            NATIVE_TRUST_REQUIRED,
            "trust for another owner must not widen the grant"
        );

        config::set_native_trust(
            &state.store,
            gateway_id,
            uuid::Uuid::from_u128(2),
            owner,
            &devserver_id,
            true,
        )
        .unwrap();
        assert!(require_rostered_native_policy_generation(
            &state,
            &synth_id,
            gateway_id,
            owner,
            &devserver_id,
            0
        )
        .is_ok());
        state.bump_native_policy_generation(&synth_id);
        assert!(
            require_rostered_native_policy_generation(
                &state,
                &synth_id,
                gateway_id,
                owner,
                &devserver_id,
                0
            )
            .unwrap_err()
            .contains("changed while connecting"),
            "bumped generation aborts an in-flight connect seam"
        );

        state
            .gateway_manager
            .seed_test_runtime(gateway_id, discovery, Vec::new());
        assert!(
            require_rostered_native_policy(&state, gateway_id, owner, &devserver_id)
                .unwrap_err()
                .contains("roster no longer contains"),
            "persisted trust must not outlive authenticated roster membership"
        );
    }

    #[tokio::test]
    async fn rostered_unauthorized_returns_before_its_row_policy_lock_is_released() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let stub = axum::Router::new().route(
            "/mobile/v1/devserver/entry",
            axum::routing::post(|| async { axum::http::StatusCode::UNAUTHORIZED }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, stub).await.unwrap();
        });
        let (_dir, state) = test_state();
        let gateway_id = "gw-feedface";
        let devserver_id = "d".repeat(64);
        let id = gateway::synthesized_row_id(gateway_id, "alice", &devserver_id);
        {
            let mut store = state.store.lock().unwrap();
            let mut cfg = store.get().unwrap();
            cfg.gateways.push(config::Gateway {
                id: gateway_id.into(),
                url: origin.clone(),
                label: String::new(),
                enabled: true,
                added_at: 0,
                native_trust: Vec::new(),
                wireguard: None,
                wireguard_public_key: None,
                wireguard_enrolled_key: None,
                wireguard_enrollment: None,
                wireguard_cleanup: None,
                wireguard_hosts: Vec::new(),
            });
            store.save(&cfg).unwrap();
        }
        state.gateway_manager.seed_test_runtime(
            gateway_id,
            devserver::GatewayDiscovery {
                kind: "chan-gateway".into(),
                api_version: 1,
                identity_origin: origin.clone(),
                mobile_authorize_url: format!("{origin}/mobile/authorize"),
                mobile_entry_url: format!("{origin}/mobile/v1/devserver/entry"),
                mobile_roster_url: format!("{origin}/mobile/v1/devservers"),
                devserver_proxy_origin: "https://proxy.chan.app".into(),
                devserver_proxy_host_depth: 2,
                wireguard: None,
            },
            vec![gateway::RosterDevserver {
                owner_user_id: uuid::Uuid::from_u128(1),
                owner: "alice".into(),
                devserver_id: devserver_id.clone(),
                label: String::new(),
                online: true,
                shared: false,
                proxy_origin: None,
            }],
        );
        auth::test_gateway_pats().lock().unwrap().insert(
            origin.clone(),
            auth::StoredPat {
                id: "test-pat".into(),
                secret: "test-only".into(),
                label: "test".into(),
                expires_at: String::new(),
            },
        );
        let app = tauri::test::mock_app();
        let (signal, mut signals) = tokio::sync::mpsc::unbounded_channel();
        app.listen(serve::SERVES_CHANGED, move |_| {
            let _ = signal.send(());
        });
        let lock = state.native_policy_lock(&id);
        let guard = lock.lock().await;
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            rostered_conn(
                app.handle(),
                &state,
                &id,
                gateway_id,
                "alice",
                &devserver_id,
            ),
        )
        .await;
        if result.is_err() {
            drop(guard);
            server.abort();
            auth::test_gateway_pats().lock().unwrap().remove(&origin);
            panic!("rostered 401 must return while its caller holds the row policy lock");
        }
        let message = result.unwrap().expect_err("401 refuses the row connect");
        assert!(message.contains("sign-in is no longer valid"), "{message}");
        tokio::time::timeout(std::time::Duration::from_secs(5), signals.recv())
            .await
            .expect("401 must start the gateway cascade before the row lock is released")
            .expect("the gateway change listener remains live");
        assert!(state.gateway_manager.view(gateway_id).is_none());
        drop(guard);
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            gateway::cascade_disconnect(
                app.handle(),
                &state,
                gateway_id,
                gateway::CascadeReason::Unauthorized,
            ),
        )
        .await
        .expect("the cascade completes after the row lock is released");
        assert!(!auth::test_gateway_pats()
            .lock()
            .unwrap()
            .contains_key(&origin));
        server.abort();
    }

    #[tokio::test]
    async fn offline_rostered_row_notices_and_fails_the_connect() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let stub = axum::Router::new().route(
            "/mobile/v1/devserver/entry",
            axum::routing::post(|| async {
                axum::http::Response::builder()
                    .status(404)
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        r#"{"error":"not found","reason":"devserver_offline","label":"lap"}"#,
                    ))
                    .unwrap()
            }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, stub).await.unwrap();
        });

        let ds64 = "d".repeat(64);
        let (_dir, state) = test_state();
        {
            let mut store = state.store.lock().unwrap();
            let mut cfg = store.get().unwrap();
            cfg.gateways.push(config::Gateway {
                id: "gw-feedface".into(),
                url: origin.clone(),
                label: String::new(),
                enabled: true,
                added_at: 0,
                native_trust: Vec::new(),
                wireguard: None,
                wireguard_public_key: None,
                wireguard_enrolled_key: None,
                wireguard_enrollment: None,
                wireguard_cleanup: None,
                wireguard_hosts: Vec::new(),
            });
            store.save(&cfg).unwrap();
        }
        state.gateway_manager.seed_test_runtime(
            "gw-feedface",
            devserver::GatewayDiscovery {
                kind: "chan-gateway".into(),
                api_version: 1,
                identity_origin: origin.clone(),
                mobile_authorize_url: format!("{origin}/mobile/authorize"),
                mobile_entry_url: format!("{origin}/mobile/v1/devserver/entry"),
                mobile_roster_url: format!("{origin}/mobile/v1/devservers"),
                devserver_proxy_origin: "https://proxy.chan.app".into(),
                devserver_proxy_host_depth: 2,
                wireguard: None,
            },
            vec![gateway::RosterDevserver {
                owner_user_id: uuid::Uuid::from_u128(1),
                owner: "alice".into(),
                devserver_id: ds64.clone(),
                label: String::new(),
                online: false,
                shared: false,
                proxy_origin: None,
            }],
        );
        auth::test_gateway_pats().lock().unwrap().insert(
            origin.clone(),
            auth::StoredPat {
                id: "pat-1".into(),
                secret: "s3cret".into(),
                label: "test".into(),
                expires_at: String::new(),
            },
        );
        let app = tauri::test::mock_app();
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        app.listen(gateway::LAUNCHER_NOTICE, move |event| {
            let _ = tx.send(event.payload().to_string());
        });

        let message = rostered_conn(
            app.handle(),
            &state,
            &format!("gw:feedface:alice:{ds64}"),
            "gw-feedface",
            "alice",
            &ds64,
        )
        .await
        .expect_err("offline entry fails the connect");
        assert!(message.contains("not currently connected"), "{message}");
        let payload = rx.try_recv().expect("offline notice emitted");
        let notice: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(notice["kind"], "info");
        assert_eq!(notice["source"]["type"], "devserver");

        auth::test_gateway_pats().lock().unwrap().remove(&origin);
        server.abort();
    }

    #[tokio::test]
    async fn rostered_conn_happy_path_builds_gateway_connection() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let identity_origin = format!("http://{addr}");
        let proxy_apex = format!("http://localtest.me:{}", addr.port());
        let proxy_origin = format!("http://alice--aaaaaaaaaaaa.p1.localtest.me:{}", addr.port());
        let response_proxy = proxy_origin.clone();
        let owner_user_id = uuid::Uuid::from_u128(7);
        let ds64 = "a".repeat(64);
        let ds64_route = ds64.clone();

        let router = axum::Router::new()
            .route(
                "/mobile/v1/devserver/entry",
                axum::routing::post(move || {
                    let proxy_origin = response_proxy.clone();
                    let ds64 = ds64_route.clone();
                    async move {
                        axum::Json(serde_json::json!({
                            "owner_user_id": owner_user_id,
                            "username": "alice",
                            "devserver_id": ds64,
                            "proxy_origin": proxy_origin,
                            "entry_exchange_url": format!("{proxy_origin}/_chan/entry"),
                            "entry_credential": "entry-cred-1",
                        }))
                    }
                }),
            )
            .route(
                "/_chan/entry",
                axum::routing::post(|| async {
                    axum::response::Response::builder()
                        .status(axum::http::StatusCode::SEE_OTHER)
                        .header("location", "/")
                        .header(
                            "set-cookie",
                            "__Host-devserver_gate=opaque-gate; Path=/; HttpOnly",
                        )
                        .header("set-cookie", "__Host-devserver_csrf=csrf-tok; Path=/")
                        .body(axum::body::Body::empty())
                        .unwrap()
                }),
            );
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });

        let (_dir, state) = test_state();
        let gateway_id = "gw-happy";
        {
            let mut store = state.store.lock().unwrap();
            let mut cfg = store.get().unwrap();
            cfg.gateways.push(config::Gateway {
                id: gateway_id.into(),
                url: identity_origin.clone(),
                label: "Prod Gateway".into(),
                enabled: true,
                added_at: 0,
                native_trust: Vec::new(),
                wireguard: None,
                wireguard_public_key: None,
                wireguard_enrolled_key: None,
                wireguard_enrollment: None,
                wireguard_cleanup: None,
                wireguard_hosts: Vec::new(),
            });
            store.save(&cfg).unwrap();
        }
        state.gateway_manager.seed_test_runtime(
            gateway_id,
            devserver::GatewayDiscovery {
                kind: "chan-gateway".into(),
                api_version: 1,
                identity_origin: identity_origin.clone(),
                mobile_authorize_url: format!("{identity_origin}/mobile/authorize"),
                mobile_entry_url: format!("{identity_origin}/mobile/v1/devserver/entry"),
                mobile_roster_url: format!("{identity_origin}/mobile/v1/devservers"),
                devserver_proxy_origin: proxy_apex,
                devserver_proxy_host_depth: 2,
                wireguard: None,
            },
            vec![gateway::RosterDevserver {
                owner_user_id,
                owner: "alice".into(),
                devserver_id: ds64.clone(),
                label: "workstation".into(),
                online: true,
                shared: false,
                proxy_origin: None,
            }],
        );
        auth::test_gateway_pats().lock().unwrap().insert(
            identity_origin.clone(),
            auth::StoredPat {
                id: "pat-happy".into(),
                secret: "secret-happy".into(),
                label: "happy".into(),
                expires_at: String::new(),
            },
        );

        let app = tauri::test::mock_app();
        let synth_id = gateway::synthesized_row_id(gateway_id, "alice", &ds64);
        let conn = rostered_conn(app.handle(), &state, &synth_id, gateway_id, "alice", &ds64)
            .await
            .expect("happy-path rostered connect builds DevserverConn");
        assert_eq!(conn.name, "workstation");
        assert_eq!(conn.port, addr.port());
        assert_eq!(conn.gateway.as_ref().unwrap().proxy_origin, proxy_origin);

        auth::test_gateway_pats()
            .lock()
            .unwrap()
            .remove(&identity_origin);
        server.abort();
    }

    #[tokio::test]
    async fn workspace_lifecycle_helpers_and_disconnected_refusals() {
        assert_eq!(devserver_route_prefix("notes-1a2b"), "/notes-1a2b");
        assert_eq!(devserver_route_prefix("/notes-1a2b"), "/notes-1a2b");

        let mapped = to_launcher_workspace(
            "gw:1",
            Some("lib-77".into()),
            devserver::DevserverWorkspaceRow {
                prefix: "/notes-1a2b".into(),
                path: "/srv/notes".into(),
                label: "notes".into(),
                on: true,
                status: chan_server::WorkspaceStatus::Running,
                error: None,
                url: "https://alice--disc.proxy.example/notes-1a2b/index.html".into(),
            },
        );
        assert_eq!(mapped.workspace_id, "notes-1a2b");
        assert_eq!(mapped.prefix, "notes-1a2b");
        assert_eq!(mapped.devserver_id.as_deref(), Some("gw:1"));
        assert_eq!(mapped.library_id.as_deref(), Some("lib-77"));

        let (_dir, state) = test_state();
        assert!(set_devserver_workspace_on_impl(
            &state,
            "gw:1".into(),
            "notes".into(),
            true,
            false
        )
        .await
        .unwrap_err()
        .contains("not connected"));
        assert!(
            forget_devserver_workspace_impl(&state, "gw:1".into(), "notes".into(), false)
                .await
                .unwrap_err()
                .contains("not connected")
        );
    }

    #[tokio::test]
    async fn set_and_forget_devserver_workspace_impl_map_outcomes() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let router = axum::Router::new()
            .route(
                "/api/library/workspaces/notes/on",
                axum::routing::post(|| async {
                    axum::Json(serde_json::json!({
                        "workspace_id": "notes",
                        "path": "/srv/notes",
                        "status": "running",
                        "error": null,
                        "label": "notes",
                        "on": true,
                        "library_id": "lib-1",
                        "devserver_id": null,
                        "prefix": "notes",
                    }))
                }),
            )
            .route(
                "/api/library/workspaces/notes/off",
                axum::routing::post(
                    |axum::Json(body): axum::Json<serde_json::Value>| async move {
                        if body.get("force").and_then(|v| v.as_bool()) == Some(true) {
                            axum::http::Response::builder()
                                .status(axum::http::StatusCode::NO_CONTENT)
                                .body(axum::body::Body::empty())
                                .unwrap()
                        } else {
                            axum::http::Response::builder()
                                .status(axum::http::StatusCode::CONFLICT)
                                .header("content-type", "application/json")
                                .body(axum::body::Body::from(
                                    r#"{"error":"live_terminals","active_terminals":2}"#,
                                ))
                                .unwrap()
                        }
                    },
                ),
            )
            .route(
                "/api/library/workspaces/notes",
                axum::routing::delete(|| async { axum::http::StatusCode::NO_CONTENT }),
            )
            .route(
                "/api/library/workspaces",
                axum::routing::get(|| async { axum::Json(Vec::<serde_json::Value>::new()) }),
            );
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });

        let (_dir, state) = test_state();
        let gw = devserver::GatewayConn::new(
            format!("http://{addr}"),
            format!("http://{addr}/mobile/v1/devserver/entry"),
            format!("http://{addr}"),
            "pat".into(),
        );
        gw.seed_fresh_session_for_test("csrf-ws");
        state.devservers.set(
            "gw:1".into(),
            devserver::DevserverConn {
                host: "127.0.0.1".into(),
                port: addr.port(),
                token: String::new(),
                name: "box".into(),
                gateway: Some(Box::new(gw)),
            },
        );
        state
            .devserver_feed
            .seed_library_id("gw:1".into(), "lib-1".into());

        let on_outcome =
            set_devserver_workspace_on_impl(&state, "gw:1".into(), "notes".into(), true, false)
                .await
                .unwrap();
        let chan_server::SetWorkspaceOnOutcome::Done { workspace } = on_outcome else {
            panic!("expected Done on mount");
        };
        let ws = workspace.expect("turn-on returns workspace row");
        assert_eq!(ws.prefix, "notes");
        assert_eq!(ws.devserver_id.as_deref(), Some("gw:1"));
        assert_eq!(ws.library_id.as_deref(), Some("lib-1"));

        let unforced_off =
            set_devserver_workspace_on_impl(&state, "gw:1".into(), "notes".into(), false, false)
                .await
                .unwrap();
        assert!(matches!(
            unforced_off,
            chan_server::SetWorkspaceOnOutcome::NeedsForce {
                active_terminals: 2
            }
        ));

        let forced_off =
            set_devserver_workspace_on_impl(&state, "gw:1".into(), "notes".into(), false, true)
                .await
                .unwrap();
        assert!(matches!(
            forced_off,
            chan_server::SetWorkspaceOnOutcome::Done { workspace: None }
        ));

        let forgotten =
            forget_devserver_workspace_impl(&state, "gw:1".into(), "notes".into(), true)
                .await
                .unwrap();
        assert!(matches!(
            forgotten,
            chan_server::SetWorkspaceOnOutcome::Done { workspace: None }
        ));

        server.abort();
    }
}
