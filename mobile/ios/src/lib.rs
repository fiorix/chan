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
#[cfg(any(target_os = "ios", test))]
pub(crate) mod webview_proxy;
pub(crate) mod window_ops;
pub(crate) mod wireguard;
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

const TMUX_NEW_WINDOW_DISPATCH_JS: &str =
    "window.dispatchEvent(new CustomEvent('chan:command', { detail: { name: 'app.tmux.newWindow' } }));";

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
        // Single-webview workspace-app commands.
        native_vocabulary,
        focus_library_window,
        create_library_window,
        open_new_window,
        toggle_launcher_panel,
        show_computers_for_window,
        reconnect_devserver_for_window,
        abandon_devserver_for_window,
        // Loopback-only delivery trigger for pending Computers card focus.
        mobile_deliver_pending_show_card,
    ]
}

/// Same page ignoring query and fragment, so a launcher showing its bearer
/// token still reads as home.
pub(crate) fn same_page(left: &url::Url, right: &url::Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port() == right.port()
        && left.path() == right.path()
}

/// Run post-navigation hooks when `"main"` finishes loading a page.
pub(crate) fn on_main_page_load<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    payload: &tauri::webview::PageLoadPayload<'_>,
) {
    if !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
        return;
    }
    if webview.label() != "main" {
        return;
    }
    let state = webview.state::<Arc<AppState>>();
    let Ok(home) = mobile_auth::mobile_launcher_url(&state) else {
        return;
    };
    if !same_page(payload.url(), &home) {
        return;
    }
    if state.pending_show_card.lock().unwrap().is_none() {
        return;
    }
    // Wait for a FIFO-ordered event listen on the launcher so App.svelte's
    // onMount listener is active in EventManager before emitting the card event.
    const DELIVER_SHOW_CARD_JS: &str = r#"(function(){
  var deliver=function(){
    var api=window.__TAURI__;
    var invoke=(api&&((api.core&&api.core.invoke)||api.invoke))||(window.__TAURI_INTERNALS__&&window.__TAURI_INTERNALS__.invoke);
    var listen=api&&api.event&&api.event.listen;
    if(!invoke)return;
    if(listen){
      listen("launcher-show-devserver-card",function(){}).then(function(u){
        if(typeof u==="function")u();
        return invoke("mobile_deliver_pending_show_card");
      }).catch(function(){
        return invoke("mobile_deliver_pending_show_card");
      });
    }else{
      invoke("mobile_deliver_pending_show_card");
    }
  };
  if(document.readyState==="complete"){deliver();}
  else{window.addEventListener("load",deliver,{once:true});}
})();"#;
    if let Err(error) = webview.eval(DELIVER_SHOW_CARD_JS) {
        tracing::warn!(%error, "scheduling pending show-card delivery failed");
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct NativeVocabulary {
    pub(crate) version: String,
    pub(crate) build: String,
    pub(crate) commands: Vec<String>,
}

pub(crate) fn native_vocabulary_for<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> NativeVocabulary {
    NativeVocabulary {
        version: app.package_info().version.to_string(),
        build: CHAN_IOS_BUILD_ID.to_string(),
        commands: runtime_capability::GATEWAY_WINDOW_COMMANDS
            .iter()
            .map(|cmd| (*cmd).to_string())
            .collect(),
    }
}

#[tauri::command]
fn native_vocabulary(app: tauri::AppHandle) -> NativeVocabulary {
    native_vocabulary_for(&app)
}

async fn devserver_workspace_path(
    conn: &devserver::DevserverConn,
    workspace_id: Option<String>,
) -> Result<String, String> {
    let workspace_id =
        workspace_id.ok_or_else(|| "a workspace window needs a workspace id".to_string())?;
    let wanted = workspace_id.trim_start_matches('/');
    devserver::fetch_workspaces(conn)
        .await?
        .into_iter()
        .find(|row| row.prefix.trim_start_matches('/') == wanted)
        .map(|row| row.path)
        .ok_or_else(|| format!("no workspace {wanted} on this devserver"))
}

fn is_loopback_launcher_page(state: &AppState, current: &url::Url) -> bool {
    mobile_auth::mobile_launcher_url(state).is_ok_and(|home| same_page(current, &home))
}

fn resolve_devserver_id_for_window(state: &AppState, current: &url::Url) -> Option<String> {
    if is_loopback_launcher_page(state, current) {
        return None;
    }
    let exact_origin = current.origin().ascii_serialization();
    if let Some((id, _)) = state.devservers.gateway_entry_for_origin(&exact_origin) {
        return Some(id);
    }
    if let Some(lib_id) = current
        .query_pairs()
        .find(|(k, _)| k == "lib")
        .map(|(_, v)| v.into_owned())
        .filter(|lib| lib.starts_with("lib-"))
    {
        if let Some(id) = state.devserver_feed.devserver_id_for_library(&lib_id) {
            return Some(id);
        }
    }
    state
        .last_remote_origin
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|(origin, id)| (origin == &exact_origin).then(|| id.clone()))
}

fn is_remote_devserver_page(state: &AppState, current: &url::Url) -> bool {
    if is_loopback_launcher_page(state, current) {
        return false;
    }
    let exact_origin = current.origin().ascii_serialization();
    state
        .devservers
        .gateway_entry_for_origin(&exact_origin)
        .is_some()
        || current
            .query_pairs()
            .any(|(k, v)| k == "lib" && v.starts_with("lib-"))
        || state
            .last_remote_origin
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|(origin, _)| origin == &exact_origin)
}

pub(crate) async fn focus_library_window_impl<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<AppState>,
    window: &tauri::WebviewWindow<R>,
    window_id: String,
) -> Result<(), String> {
    if window_id.is_empty() || window_id.contains("::") {
        return Err(format!("invalid window id {window_id:?}"));
    }
    let current = window
        .url()
        .map_err(|e| format!("reading window URL: {e}"))?;
    let exact_origin = current.origin().ascii_serialization();
    let (id, conn) = state
        .devservers
        .gateway_entry_for_origin(&exact_origin)
        .ok_or_else(|| "window does not belong to a connected devserver".to_string())?;
    let record = match state.devserver_feed.record_for_window_id(&window_id) {
        Some((owner_id, record)) if owner_id == id => record,
        _ => devserver::fetch_library_windows(&id, &conn)
            .await?
            .into_iter()
            .find(|r| r.window_id == window_id)
            .ok_or_else(|| format!("window {window_id} was not found"))?,
    };
    let already_open = current
        .query_pairs()
        .any(|(k, v)| k == "w" && v == window_id);
    if already_open {
        if record.hidden {
            devserver::set_window_visibility(&conn, &record.window_id, false).await?;
            if let Err(error) = refresh_devserver_windows(state, &id, &conn).await {
                tracing::warn!(devserver = %id, %error, "refreshing devserver windows after focus unhide failed");
            }
        }
        return Ok(());
    }
    mobile_auth::mobile_open_existing_window_with_app(app, state, &id, &record).await
}

#[tauri::command]
async fn focus_library_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    window: tauri::WebviewWindow,
    window_id: String,
) -> Result<(), String> {
    focus_library_window_impl(&app, state.inner(), &window, window_id).await
}

pub(crate) async fn create_library_window_impl<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<AppState>,
    window: &tauri::WebviewWindow<R>,
    kind: chan_server::WindowKind,
    workspace_id: Option<String>,
) -> Result<(), String> {
    let current = window
        .url()
        .map_err(|e| format!("reading window URL: {e}"))?;
    let exact_origin = current.origin().ascii_serialization();
    let (id, conn) = state
        .devservers
        .gateway_entry_for_origin(&exact_origin)
        .ok_or_else(|| "window does not belong to a connected devserver".to_string())?;
    let workspace_path = match kind {
        chan_server::WindowKind::Terminal => None,
        chan_server::WindowKind::Workspace => {
            Some(devserver_workspace_path(&conn, workspace_id).await?)
        }
    };
    mobile_auth::mobile_open_devserver_with_app(app, state, &id, kind, workspace_path, false).await
}

#[tauri::command]
async fn create_library_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    window: tauri::WebviewWindow,
    kind: chan_server::WindowKind,
    workspace_id: Option<String>,
) -> Result<(), String> {
    create_library_window_impl(&app, state.inner(), &window, kind, workspace_id).await
}

pub(crate) async fn open_new_window_impl<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<AppState>,
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    let current = window
        .url()
        .map_err(|e| format!("reading window URL: {e}"))?;
    let exact_origin = current.origin().ascii_serialization();
    let (id, conn) = state
        .devservers
        .gateway_entry_for_origin(&exact_origin)
        .ok_or_else(|| "window does not belong to a connected devserver".to_string())?;
    let active_window_id = current
        .query_pairs()
        .find(|(k, _)| k == "w")
        .map(|(_, v)| v.into_owned());
    let record = if let Some(wid) = active_window_id.as_deref() {
        match state.devserver_feed.record_for_window_id(wid) {
            Some((owner_id, record)) if owner_id == id => Some(record),
            _ => devserver::fetch_library_windows(&id, &conn)
                .await
                .ok()
                .and_then(|windows| windows.into_iter().find(|r| r.window_id == wid)),
        }
    } else {
        None
    };
    if let Some(r) = &record {
        if r.tmux.as_ref().is_some_and(|mark| !mark.control) {
            return window
                .eval(TMUX_NEW_WINDOW_DISPATCH_JS)
                .map_err(|e| format!("asking the tmux window for a new window: {e}"));
        }
    }
    let (kind, workspace_path) = match record {
        Some(r) => {
            let workspace_path = match r.kind {
                chan_server::WindowKind::Terminal => None,
                chan_server::WindowKind::Workspace => r.workspace_path,
            };
            (r.kind, workspace_path)
        }
        None => (chan_server::WindowKind::Terminal, None),
    };
    mobile_auth::mobile_open_devserver_with_app(app, state, &id, kind, workspace_path, false).await
}

#[tauri::command]
async fn open_new_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    open_new_window_impl(&app, state.inner(), &window).await
}

pub(crate) fn toggle_launcher_panel_impl<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    state: &AppState,
) -> Result<(), String> {
    let home = mobile_auth::mobile_launcher_url(state)?;
    if window.url().is_ok_and(|current| same_page(&current, &home)) {
        return Ok(());
    }
    mobile_auth::navigate_main_to_launcher(window, state)
}

#[tauri::command]
fn toggle_launcher_panel(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    toggle_launcher_panel_impl(&window, state.inner())
}

pub(crate) fn show_computers_for_window_impl<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    state: &AppState,
) -> Result<(), String> {
    let current = window
        .url()
        .map_err(|e| format!("reading window URL: {e}"))?;
    if !is_remote_devserver_page(state, &current) {
        return Err("window is not on a devserver page".to_string());
    }
    let card = resolve_devserver_id_for_window(state, &current);
    *state.pending_show_card.lock().unwrap() = Some(card);
    mobile_auth::navigate_main_to_launcher(window, state)
}

#[tauri::command]
fn show_computers_for_window(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    show_computers_for_window_impl(&window, state.inner())
}

pub(crate) fn mobile_deliver_pending_show_card_impl<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
    state: &AppState,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("launcher card delivery is restricted to main".to_string());
    }
    let home = mobile_auth::mobile_launcher_url(state)?;
    let current = window
        .url()
        .map_err(|e| format!("reading window URL: {e}"))?;
    if !same_page(&current, &home) {
        return Err("launcher card delivery requires the loopback launcher page".to_string());
    }
    let Some(card) = state.pending_show_card.lock().unwrap().take() else {
        return Ok(());
    };
    tauri::Emitter::emit_to(
        app,
        "main",
        "launcher-show-devserver-card",
        serde_json::json!({ "devserverId": card }),
    )
    .map_err(|e| format!("emitting launcher-show-devserver-card: {e}"))
}

#[tauri::command]
fn mobile_deliver_pending_show_card(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    mobile_deliver_pending_show_card_impl(&app, &window, state.inner())
}

pub(crate) async fn reconnect_devserver_for_window_impl<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<AppState>,
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    let current = window
        .url()
        .map_err(|e| format!("reading window URL: {e}"))?;
    let Some(id) = resolve_devserver_id_for_window(state, &current) else {
        return Ok(());
    };
    if state.devserver_connecting.lock().unwrap().contains(&id) {
        return Ok(());
    }
    let current_window_id = current
        .query_pairs()
        .find(|(k, _)| k == "w")
        .map(|(_, v)| v.into_owned());
    teardown_devserver_connection(app, state, &id).await;
    connect_rostered_devserver(app.clone(), Arc::clone(state), id.clone()).await?;
    let reconnected_record = if let Some(wid) = current_window_id.as_deref() {
        match state.devserver_feed.record_for_window_id(wid) {
            Some((owner_id, record)) if owner_id == id => Some(record),
            _ => match state.devservers.get(&id) {
                Some(conn) => devserver::fetch_library_windows(&id, &conn)
                    .await
                    .ok()
                    .and_then(|windows| windows.into_iter().find(|r| r.window_id == wid)),
                None => None,
            },
        }
    } else {
        None
    };
    if let Some(record) = reconnected_record {
        mobile_auth::mobile_open_existing_window_with_app(app, state, &id, &record).await?;
    } else if let Ok(home) = mobile_auth::mobile_launcher_url(state) {
        if !window.url().is_ok_and(|u| same_page(&u, &home)) {
            mobile_auth::navigate_main_to_launcher(window, state)?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn reconnect_devserver_for_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    reconnect_devserver_for_window_impl(&app, state.inner(), &window).await
}

pub(crate) async fn abandon_devserver_for_window_impl<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<AppState>,
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    let current = window
        .url()
        .map_err(|e| format!("reading window URL: {e}"))?;
    let Some(id) = resolve_devserver_id_for_window(state, &current) else {
        return Ok(());
    };
    teardown_devserver_connection(app, state, &id).await;
    if let Ok(home) = mobile_auth::mobile_launcher_url(state) {
        if !window.url().is_ok_and(|u| same_page(&u, &home)) {
            let _ = mobile_auth::navigate_main_to_launcher(window, state);
        }
    }
    let _ = tauri::Emitter::emit(app, "devserver-abandon", id);
    Ok(())
}

#[tauri::command]
async fn abandon_devserver_for_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    abandon_devserver_for_window_impl(&app, state.inner(), &window).await
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
pub(crate) fn refresh_launcher<R: tauri::Runtime>(app: &tauri::AppHandle<R>, state: &AppState) {
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
    if state.devservers.remove(id).is_some_and(|conn| {
        conn.gateway
            .as_ref()
            .is_some_and(|gateway| gateway.access.is_some())
    }) {
        state.bump_native_policy_generation(id);
        wireguard::stop_selected(app, state, id);
    }
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
#[cfg(test)]
async fn rostered_conn<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<AppState>,
    id: &str,
    gateway_id: &str,
    owner: &str,
    devserver_id: &str,
) -> Result<devserver::DevserverConn, String> {
    rostered_conn_at_generation(
        app,
        state,
        id,
        gateway_id,
        owner,
        devserver_id,
        state.native_policy_generation(id),
    )
    .await
}

async fn rostered_conn_at_generation<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<AppState>,
    id: &str,
    gateway_id: &str,
    owner: &str,
    devserver_id: &str,
    generation: u64,
) -> Result<devserver::DevserverConn, String> {
    let row = require_rostered_native_policy(state, gateway_id, owner, devserver_id)?;
    let Some(discovery) = state.gateway_manager.discovery(gateway_id) else {
        return Err("connect the gateway first - its roster supplies this devserver".into());
    };
    let row_label = row.label;
    let Some(pat) = auth::load_gateway_pat(&discovery.identity_origin)? else {
        return Err("the gateway sign-in is missing - reconnect the gateway".into());
    };
    let access = wireguard::AccessGuard::new(state, id, gateway_id, generation)?;
    let gateway = match devserver::gateway_conn_guarded(
        &discovery,
        pat.secret,
        Some(devserver::GatewayEntryTarget {
            owner_user_id: row.owner_user_id,
            owner: owner.to_string(),
            devserver_id: devserver_id.to_string(),
        }),
        access,
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

pub(crate) async fn refresh_devserver_windows(
    state: &AppState,
    id: &str,
    conn: &devserver::DevserverConn,
) -> Result<(), String> {
    let windows = devserver::fetch_library_windows(id, conn).await?;
    let mut changed = state.devserver_feed.set_down(id, false);
    changed |= state.devserver_feed.replace_windows(id, windows);
    if changed {
        if let Some(embedded) = state.embedded() {
            embedded.signal_library_change();
        }
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
) {
    const POLL: std::time::Duration = std::time::Duration::from_secs(5);
    tauri::async_runtime::spawn(async move {
        let initial_lib = state.devserver_feed.library_id_of(&id);
        let mut last_ws = Some((initial_ws, initial_lib));
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
                        let mut snap = snapshot.lock().unwrap();
                        if snap.windows != windows {
                            snap.windows = windows;
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
    let conn = rostered_conn_at_generation(
        app,
        state,
        id,
        gateway_id,
        owner,
        devserver_id,
        policy_generation,
    )
    .await?;

    let proxy_origin = conn
        .gateway
        .as_ref()
        .expect("rostered connections are gateway-backed")
        .proxy_origin
        .clone();
    recheck()?;
    conn.gateway
        .as_ref()
        .expect("gateway connection")
        .require_access()?;
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
    spawn_rostered_devserver_poll(Arc::clone(state), id.to_string(), conn, snapshot, rows);
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

pub(crate) async fn discard_devserver_window_in_state(
    state: &AppState,
    window_id: &str,
) -> Result<bool, String> {
    let Some((devserver_id, record)) = state
        .devserver_feed
        .record_for_window_id(window_id)
        .or_else(|| state.devserver_feed.record_for_native_label(window_id))
    else {
        return Ok(false);
    };
    let Some(conn) = state.devservers.get(&devserver_id) else {
        return Err(format!("devserver {devserver_id} is not connected"));
    };
    devserver::discard_library_window(&conn, &record.window_id).await?;
    if let Err(error) = refresh_devserver_windows(state, &devserver_id, &conn).await {
        tracing::warn!(
            devserver = %devserver_id,
            %error,
            "refreshing devserver windows after discard failed"
        );
    }
    Ok(true)
}

async fn discard_devserver_window_by_id(
    app: &tauri::AppHandle,
    window_id: &str,
) -> Result<bool, String> {
    let state = app.state::<Arc<AppState>>();
    discard_devserver_window_in_state(state.inner(), window_id).await
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
                wireguard_key_file: None,
                wireguard_pending_enrollment: None,
                wireguard_enrolled_key: None,
                wireguard_enrollment: None,
                wireguard_cleanup: None,
                wireguard_protection: Default::default(),
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
                wireguard_key_file: None,
                wireguard_pending_enrollment: None,
                wireguard_enrolled_key: None,
                wireguard_enrollment: None,
                wireguard_cleanup: None,
                wireguard_protection: Default::default(),
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
                wireguard_key_file: None,
                wireguard_pending_enrollment: None,
                wireguard_enrolled_key: None,
                wireguard_enrollment: None,
                wireguard_cleanup: None,
                wireguard_protection: Default::default(),
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
                wireguard_key_file: None,
                wireguard_pending_enrollment: None,
                wireguard_enrolled_key: None,
                wireguard_enrollment: None,
                wireguard_cleanup: None,
                wireguard_protection: Default::default(),
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

    fn sample_remote_record(
        library_id: &str,
        window_id: &str,
        kind: chan_server::WindowKind,
    ) -> chan_server::WindowRecord {
        chan_server::WindowRecord {
            window_id: window_id.into(),
            library_id: library_id.into(),
            kind,
            title: "Test".into(),
            ordinal: 1,
            label: "Test".into(),
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

    async fn install_test_embedded(
        state: &AppState,
    ) -> (tempfile::TempDir, Arc<tokio::sync::Notify>) {
        let lib_home = tempfile::tempdir().unwrap();
        let library = chan_workspace::Library::open_at(lib_home.path().join("library.toml"))
            .expect("open library");
        let embedded = crate::embedded::EmbeddedServer::for_tests(library).await;
        let notify = embedded.library_change_notify();
        embedded.install_devserver_feed(
            Arc::clone(&state.devserver_feed) as Arc<dyn chan_server::DevserverFeedSource>
        );
        let _ = state.embedded.set(embedded);
        (lib_home, notify)
    }

    fn query_map(url: &url::Url) -> std::collections::HashMap<String, String> {
        url.query_pairs().into_owned().collect()
    }

    #[tokio::test]
    async fn refresh_devserver_windows_updates_feed_and_signals_library_change() {
        use chan_server::DevserverFeedSource;

        let windows_store = Arc::new(Mutex::new(vec![sample_remote_record(
            "lib-1",
            "w-1",
            chan_server::WindowKind::Workspace,
        )]));
        let ws_get = Arc::clone(&windows_store);
        let router = axum::Router::new().route(
            "/api/library/windows",
            axum::routing::get(move || {
                let ws = Arc::clone(&ws_get);
                async move { axum::Json(ws.lock().unwrap().clone()) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        let (_dir, state) = test_state();
        let (_lib_home, notify) = install_test_embedded(&state).await;
        let origin = format!("http://127.0.0.1:{}", addr.port());
        let gw = devserver::GatewayConn::new(
            origin.clone(),
            format!("{origin}/mobile/v1/devserver/entry"),
            origin,
            "pat".into(),
        );
        gw.seed_fresh_session_for_test("csrf-ref");
        let conn = devserver::DevserverConn {
            host: "127.0.0.1".into(),
            port: addr.port(),
            token: String::new(),
            name: "box".into(),
            gateway: Some(Box::new(gw)),
        };
        state.devservers.set("gw:1".into(), conn.clone());
        state.devserver_feed.register_windows(
            "gw:1".into(),
            Arc::new(Mutex::new(state::DevserverWindowSnapshot::default())),
        );
        state.devserver_feed.set_down("gw:1", true);

        let notified = notify.notified();
        refresh_devserver_windows(&state, "gw:1", &conn)
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), notified)
            .await
            .expect("first refresh clears down and notifies");
        assert_eq!(state.devserver_feed.windows().len(), 1);

        // Repeat with unchanged response must not fire a spurious change signal.
        refresh_devserver_windows(&state, "gw:1", &conn)
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(80), notify.notified())
                .await
                .is_err(),
            "unchanged snapshot should not re-signal"
        );

        server.abort();
    }

    #[test]
    fn native_vocabulary_returns_version_build_and_gateway_commands() {
        let app = tauri::test::mock_app();
        let vocab = native_vocabulary_for(app.handle());
        assert_eq!(vocab.version, app.package_info().version.to_string());
        assert_eq!(vocab.build, CHAN_IOS_BUILD_ID);
        let expected: Vec<String> = runtime_capability::GATEWAY_WINDOW_COMMANDS
            .iter()
            .map(|c| (*c).to_string())
            .collect();
        assert_eq!(vocab.commands, expected);
    }

    #[tokio::test]
    async fn focus_library_window_validates_unhides_and_avoids_reloading_same_window() {
        let windows_store = Arc::new(Mutex::new(vec![
            {
                let mut r =
                    sample_remote_record("lib-1", "w-1", chan_server::WindowKind::Workspace);
                r.hidden = true;
                r
            },
            {
                let mut r = sample_remote_record("lib-1", "w-2", chan_server::WindowKind::Terminal);
                r.prefix = "/terminal".into();
                r.hidden = true;
                r
            },
        ]));
        let vis_hits = Arc::new(Mutex::new(Vec::<(String, bool)>::new()));
        let ws_get = Arc::clone(&windows_store);
        let ws_post = Arc::clone(&windows_store);
        let vis_r = Arc::clone(&vis_hits);

        let router = axum::Router::new()
            .route(
                "/api/library/windows",
                axum::routing::get(move || {
                    let ws = Arc::clone(&ws_get);
                    async move { axum::Json(ws.lock().unwrap().clone()) }
                }),
            )
            .route(
                "/api/library/windows/{id}/visibility",
                axum::routing::post(
                    move |axum::extract::Path(id): axum::extract::Path<String>,
                          axum::Json(body): axum::Json<serde_json::Value>| {
                        let ws = Arc::clone(&ws_post);
                        let vis = Arc::clone(&vis_r);
                        async move {
                            let hidden = body["hidden"].as_bool().unwrap_or(false);
                            vis.lock().unwrap().push((id.clone(), hidden));
                            if let Some(row) =
                                ws.lock().unwrap().iter_mut().find(|r| r.window_id == id)
                            {
                                row.hidden = hidden;
                            }
                            axum::http::StatusCode::NO_CONTENT
                        }
                    },
                ),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        let (_dir, state) = test_state();
        let origin = format!("http://127.0.0.1:{}", addr.port());
        let gw = devserver::GatewayConn::new(
            origin.clone(),
            format!("{origin}/mobile/v1/devserver/entry"),
            origin.clone(),
            "pat".into(),
        );
        gw.seed_fresh_session_for_test("csrf-focus");
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
        state.devserver_feed.register_windows(
            "gw:1".into(),
            Arc::new(Mutex::new(state::DevserverWindowSnapshot::from(
                windows_store.lock().unwrap().clone(),
            ))),
        );

        let app = tauri::test::mock_app();
        let start_url = format!("{origin}/notes/index.html?w=w-1&lib=lib-1");
        let main = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External(start_url.parse().unwrap()),
        )
        .build()
        .unwrap();

        // Reject invalid window ids.
        assert!(
            focus_library_window_impl(app.handle(), &state, &main, String::new())
                .await
                .is_err()
        );
        assert!(
            focus_library_window_impl(app.handle(), &state, &main, "lib-1::w-2".into())
                .await
                .is_err()
        );

        // Focusing already-open w-1 unhides without reloading URL.
        focus_library_window_impl(app.handle(), &state, &main, "w-1".into())
            .await
            .unwrap();
        assert_eq!(main.url().unwrap().as_str(), start_url);
        assert_eq!(vis_hits.lock().unwrap().as_slice(), [("w-1".into(), false)]);
        assert!(
            !state
                .devserver_feed
                .record_for_window_id("w-1")
                .unwrap()
                .1
                .hidden
        );

        // Focusing w-2 unhides and navigates main to w-2.
        focus_library_window_impl(app.handle(), &state, &main, "w-2".into())
            .await
            .unwrap();
        assert_eq!(
            query_map(&main.url().unwrap()).get("w").map(String::as_str),
            Some("w-2")
        );
        assert!(
            !state
                .devserver_feed
                .record_for_window_id("w-2")
                .unwrap()
                .1
                .hidden
        );

        // Loopback origin is rejected.
        main.navigate("http://127.0.0.1:8471/?t=boot".parse().unwrap())
            .unwrap();
        assert!(
            focus_library_window_impl(app.handle(), &state, &main, "w-1".into())
                .await
                .is_err()
        );

        server.abort();
    }

    #[tokio::test]
    async fn create_library_window_and_open_new_window_handle_tmux_workspace_and_terminal() {
        let minted = Arc::new(Mutex::new(Vec::<chan_server::CreateWindow>::new()));
        let minted_r = Arc::clone(&minted);
        let router = axum::Router::new()
            .route(
                "/api/library/workspaces",
                axum::routing::get(|| async {
                    axum::Json(vec![chan_server::LauncherWorkspace {
                        workspace_id: "notes-1a2b".into(),
                        path: "/srv/notes".into(),
                        status: chan_server::WorkspaceStatus::Running,
                        error: None,
                        label: "notes".into(),
                        on: true,
                        library_id: Some("lib-1".into()),
                        devserver_id: None,
                        prefix: "notes-1a2b".into(),
                    }])
                }),
            )
            .route(
                "/api/library/windows",
                axum::routing::post(
                    move |axum::Json(req): axum::Json<chan_server::CreateWindow>| {
                        let minted = Arc::clone(&minted_r);
                        async move {
                            let idx = {
                                let mut guard = minted.lock().unwrap();
                                guard.push(req.clone());
                                guard.len()
                            };
                            let mut rec =
                                sample_remote_record("lib-1", &format!("w-new-{idx}"), req.kind);
                            rec.workspace_path = req.workspace_path;
                            rec.prefix = if req.kind == chan_server::WindowKind::Workspace {
                                "/notes-1a2b".into()
                            } else {
                                "/terminal".into()
                            };
                            axum::Json(rec)
                        }
                    },
                )
                .get(|| async { axum::Json(Vec::<chan_server::WindowRecord>::new()) }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        let (_dir, state) = test_state();
        let origin = format!("http://127.0.0.1:{}", addr.port());
        let gw = devserver::GatewayConn::new(
            origin.clone(),
            format!("{origin}/mobile/v1/devserver/entry"),
            origin.clone(),
            "pat".into(),
        );
        gw.seed_fresh_session_for_test("csrf-create");
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
        let mut ws_rec = sample_remote_record("lib-1", "w-ws", chan_server::WindowKind::Workspace);
        ws_rec.workspace_path = Some("/srv/notes".into());
        let mut tmux_rec =
            sample_remote_record("lib-1", "w-tmux", chan_server::WindowKind::Terminal);
        tmux_rec.tmux = Some(chan_server::TmuxWindowMark {
            connection: "c1".into(),
            control: false,
            user_label: false,
        });
        state.devserver_feed.register_windows(
            "gw:1".into(),
            Arc::new(Mutex::new(state::DevserverWindowSnapshot::from(vec![
                ws_rec, tmux_rec,
            ]))),
        );

        let app = tauri::test::mock_app();
        let main = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External(
                format!("{origin}/notes-1a2b/index.html?w=w-tmux&lib=lib-1")
                    .parse()
                    .unwrap(),
            ),
        )
        .build()
        .unwrap();

        // Non-control tmux window dispatches app.tmux.newWindow without minting.
        open_new_window_impl(app.handle(), &state, &main)
            .await
            .unwrap();
        assert!(minted.lock().unwrap().is_empty());

        // Workspace window mints another window of the same workspace_path.
        main.navigate(
            format!("{origin}/notes-1a2b/index.html?w=w-ws&lib=lib-1")
                .parse()
                .unwrap(),
        )
        .unwrap();
        open_new_window_impl(app.handle(), &state, &main)
            .await
            .unwrap();
        assert_eq!(minted.lock().unwrap().len(), 1);
        assert_eq!(
            minted.lock().unwrap()[0].kind,
            chan_server::WindowKind::Workspace
        );
        assert_eq!(
            minted.lock().unwrap()[0].workspace_path.as_deref(),
            Some("/srv/notes")
        );
        assert_eq!(
            query_map(&main.url().unwrap()).get("w").map(String::as_str),
            Some("w-new-1")
        );

        // create_library_window resolves workspace_id to /srv/notes and navigates.
        create_library_window_impl(
            app.handle(),
            &state,
            &main,
            chan_server::WindowKind::Workspace,
            Some("notes-1a2b".into()),
        )
        .await
        .unwrap();
        assert_eq!(minted.lock().unwrap().len(), 2);
        assert_eq!(
            query_map(&main.url().unwrap()).get("w").map(String::as_str),
            Some("w-new-2")
        );

        server.abort();
    }

    #[tokio::test]
    async fn toggle_launcher_and_show_computers_and_abandon_and_reconnect_flow() {
        let (_dir, state) = test_state();
        let (_lib_home, _notify) = install_test_embedded(&state).await;
        let home = mobile_auth::mobile_launcher_url(&state).unwrap();

        let app = tauri::test::mock_app();
        let main = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External(home.clone()),
        )
        .build()
        .unwrap();

        // Loopback: toggle_launcher_panel is a no-op, show_computers refuses,
        // abandon/reconnect are inert Ok(()).
        toggle_launcher_panel_impl(&main, &state).unwrap();
        assert_eq!(main.url().unwrap(), home);
        assert!(show_computers_for_window_impl(&main, &state).is_err());
        abandon_devserver_for_window_impl(app.handle(), &state, &main)
            .await
            .unwrap();
        reconnect_devserver_for_window_impl(app.handle(), &state, &main)
            .await
            .unwrap();

        // Navigate to a remote origin with ?lib=lib-1 (simulating a disconnected
        // devserver whose library_ids cache still remembers gw:1).
        state
            .devserver_feed
            .seed_library_id("gw:1".into(), "lib-1".into());
        let remote_url: url::Url =
            "https://alice--aaaa.proxy.example/notes/index.html?w=w-1&lib=lib-1"
                .parse()
                .unwrap();
        main.navigate(remote_url.clone()).unwrap();

        // show_computers_for_window navigates home and queues pending_show_card.
        show_computers_for_window_impl(&main, &state).unwrap();
        assert!(same_page(&main.url().unwrap(), &home));
        assert_eq!(
            *state.pending_show_card.lock().unwrap(),
            Some(Some("gw:1".to_string()))
        );

        // Delivery emits launcher-show-devserver-card once and clears the slot.
        let (card_tx, mut card_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        main.listen("launcher-show-devserver-card", move |event| {
            let _ = card_tx.send(event.payload().to_string());
        });
        mobile_deliver_pending_show_card_impl(app.handle(), &main, &state).unwrap();
        let payload = card_rx.try_recv().expect("card event emitted");
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(parsed["devserverId"], "gw:1");
        assert!(state.pending_show_card.lock().unwrap().is_none());
        // Second call is a no-op.
        mobile_deliver_pending_show_card_impl(app.handle(), &main, &state).unwrap();
        assert!(card_rx.try_recv().is_err());

        // toggle_launcher_panel from remote navigates home.
        main.navigate(remote_url.clone()).unwrap();
        toggle_launcher_panel_impl(&main, &state).unwrap();
        assert!(same_page(&main.url().unwrap(), &home));

        // abandon_devserver_for_window tears down, navigates home, and emits devserver-abandon.
        let (aban_tx, mut aban_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        app.listen("devserver-abandon", move |event| {
            let _ = aban_tx.send(event.payload().to_string());
        });
        state.devservers.set(
            "gw:1".into(),
            devserver::DevserverConn {
                host: "127.0.0.1".into(),
                port: 9999,
                token: String::new(),
                name: "box".into(),
                gateway: None,
            },
        );
        main.navigate(remote_url).unwrap();
        abandon_devserver_for_window_impl(app.handle(), &state, &main)
            .await
            .unwrap();
        assert!(!state.devservers.is_connected("gw:1"));
        assert!(same_page(&main.url().unwrap(), &home));
        assert_eq!(aban_rx.try_recv().unwrap(), "\"gw:1\"");
    }

    #[tokio::test]
    async fn reconnect_devserver_for_window_reconnects_and_reopens_active_window() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let identity_origin = format!("http://{addr}");
        let proxy_apex = format!("http://localtest.me:{}", addr.port());
        let proxy_origin = format!("http://alice--bbbbbbbbbbbb.p1.localtest.me:{}", addr.port());
        let proxy_for_entry = proxy_origin.clone();
        let ds64 = "b".repeat(64);
        let ds64_entry = ds64.clone();

        let router = axum::Router::new()
            .route(
                "/mobile/v1/devserver/entry",
                axum::routing::post(move || {
                    let proxy_origin = proxy_for_entry.clone();
                    let ds64 = ds64_entry.clone();
                    async move {
                        axum::Json(serde_json::json!({
                            "owner_user_id": uuid::Uuid::from_u128(7),
                            "username": "alice",
                            "devserver_id": ds64,
                            "proxy_origin": proxy_origin,
                            "entry_exchange_url": format!("{proxy_origin}/_chan/entry"),
                            "entry_credential": "entry-cred-reconn",
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
                            "__Host-devserver_gate=gate-reconn; Path=/; HttpOnly; Max-Age=120",
                        )
                        .header(
                            "set-cookie",
                            "__Host-devserver_csrf=csrf-reconn; Path=/; Max-Age=120",
                        )
                        .body(axum::body::Body::empty())
                        .unwrap()
                }),
            )
            .route(
                "/api/library/workspaces",
                axum::routing::get(|| async { axum::Json(Vec::<chan_server::LauncherWorkspace>::new()) }),
            )
            .route(
                "/api/library/windows",
                axum::routing::get(|| async {
                    let mut rec = sample_remote_record(
                        "lib-reconn",
                        "w-reopen",
                        chan_server::WindowKind::Workspace,
                    );
                    rec.prefix = "/notes".into();
                    axum::Json(vec![rec])
                }),
            )
            .route(
                "/api/library/local-color",
                axum::routing::get(|| async { axum::Json(serde_json::json!({ "color": "#223344" })) }),
            )
            .route(
                "/",
                axum::routing::get(|| async {
                    r#"<!doctype html><html><head><meta name="chan-launcher-host-os" content="linux"></head></html>"#
                }),
            );
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        let (_dir, state) = test_state();
        let (_lib_home, _notify) = install_test_embedded(&state).await;
        let gateway_id = "gw-reconn";
        {
            let mut store = state.store.lock().unwrap();
            let mut cfg = store.get().unwrap();
            cfg.gateways.push(config::Gateway {
                id: gateway_id.into(),
                url: identity_origin.clone(),
                label: "Gateway".into(),
                enabled: true,
                added_at: 0,
                native_trust: Vec::new(),
                wireguard: None,
                wireguard_public_key: None,
                wireguard_key_file: None,
                wireguard_pending_enrollment: None,
                wireguard_enrolled_key: None,
                wireguard_enrollment: None,
                wireguard_cleanup: None,
                wireguard_protection: Default::default(),
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
                owner_user_id: uuid::Uuid::from_u128(7),
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
                id: "pat-reconn".into(),
                secret: "secret-reconn".into(),
                label: "reconn".into(),
                expires_at: String::new(),
            },
        );
        let synth_id = gateway::synthesized_row_id(gateway_id, "alice", &ds64);
        state
            .devserver_feed
            .seed_library_id(synth_id.clone(), "lib-reconn".into());

        let app = runtime_capability::tests::mock_app_with_context();
        let stale_url = format!("{proxy_origin}/notes/index.html?w=w-reopen&lib=lib-reconn");
        let main = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External(stale_url.parse().unwrap()),
        )
        .build()
        .unwrap();

        reconnect_devserver_for_window_impl(app.handle(), &state, &main)
            .await
            .expect("reconnect succeeds and reopens active window");

        assert!(state.devservers.is_connected(&synth_id));
        let reopened = main.url().unwrap();
        assert_eq!(reopened.origin().ascii_serialization(), proxy_origin);
        let q = query_map(&reopened);
        assert_eq!(q.get("w").map(String::as_str), Some("w-reopen"));
        assert_eq!(q.get("lib").map(String::as_str), Some("lib-reconn"));
        assert_eq!(q.get("pane").map(String::as_str), Some("#223344"));

        // If the window record no longer exists after reconnect, return home.
        let home = mobile_auth::mobile_launcher_url(&state).unwrap();
        main.navigate(
            format!("{proxy_origin}/notes/index.html?w=w-gone&lib=lib-reconn")
                .parse()
                .unwrap(),
        )
        .unwrap();
        reconnect_devserver_for_window_impl(app.handle(), &state, &main)
            .await
            .expect("reconnect with gone window navigates home");
        assert!(same_page(&main.url().unwrap(), &home));

        auth::test_gateway_pats()
            .lock()
            .unwrap()
            .remove(&identity_origin);
        server.abort();
    }

    #[tokio::test]
    async fn f3_f6_stopped_tunnel_refuses_reconnect_until_reconcile_saved_recovers() {
        use std::sync::atomic::Ordering;

        let peer_port_cell = Arc::new(std::sync::OnceLock::<u16>::new());
        let ds64 = "b".repeat(64);
        let owner_user_id = uuid::Uuid::from_u128(7);

        let router = axum::Router::new()
            .route(
                "/mobile/v1/devserver/entry",
                axum::routing::post({
                    let peer_port_cell = Arc::clone(&peer_port_cell);
                    let ds64 = ds64.clone();
                    move |axum::Json(req): axum::Json<serde_json::Value>| {
                        let peer_port_cell = Arc::clone(&peer_port_cell);
                        let ds64 = ds64.clone();
                        async move {
                            let path = req.get("path").and_then(|v| v.as_str()).unwrap_or("/");
                            let port = *peer_port_cell.get().expect("peer port set");
                            let proxy_origin =
                                format!("http://alice--bbbbbbbbbbbb.p1.localtest.me:{port}");
                            axum::Json(serde_json::json!({
                                "owner_user_id": owner_user_id,
                                "username": "alice",
                                "devserver_id": ds64,
                                "proxy_origin": proxy_origin,
                                "entry_exchange_url": format!("{proxy_origin}/_chan/entry"),
                                "entry_credential": format!("entry-cred-f3f6:{path}"),
                            }))
                        }
                    }
                }),
            )
            .route(
                "/_chan/entry",
                axum::routing::post(|body: String| async move {
                    let cred = url::form_urlencoded::parse(body.as_bytes())
                        .find(|(k, _)| k == "credential")
                        .map(|(_, v)| v.into_owned())
                        .expect("credential form field");
                    let location = cred
                        .strip_prefix("entry-cred-f3f6:")
                        .expect("expected entry credential prefix")
                        .to_string();
                    axum::response::Response::builder()
                        .status(axum::http::StatusCode::SEE_OTHER)
                        .header("location", location)
                        .header(
                            "set-cookie",
                            "__Host-devserver_gate=gate-f3f6; Path=/; HttpOnly; Max-Age=120",
                        )
                        .header(
                            "set-cookie",
                            "__Host-devserver_csrf=csrf-f3f6; Path=/; Max-Age=120",
                        )
                        .body(axum::body::Body::empty())
                        .unwrap()
                }),
            )
            .route(
                "/api/library/workspaces",
                axum::routing::get(|| async { axum::Json(Vec::<chan_server::LauncherWorkspace>::new()) }),
            )
            .route(
                "/api/library/windows",
                axum::routing::get(|| async {
                    let mut rec = sample_remote_record(
                        "lib-reconn",
                        "w-reopen",
                        chan_server::WindowKind::Workspace,
                    );
                    rec.prefix = "/notes".into();
                    axum::Json(vec![rec])
                }),
            )
            .route(
                "/api/library/local-color",
                axum::routing::get(|| async { axum::Json(serde_json::json!({ "color": "#223344" })) }),
            )
            .route(
                "/",
                axum::routing::get(|| async {
                    r#"<!doctype html><html><head><meta name="chan-launcher-host-os" content="linux"></head></html>"#
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let axum_addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(config::ConfigStore::at_path(
            dir.path().join("config.json"),
        )));
        let state = Arc::new(AppState::with_store(Arc::clone(&store)));
        let fabric = wireguard::tests::fabric().await;
        assert!(state
            .gateway_manager
            .fabric
            .set(Arc::clone(&fabric))
            .is_ok());

        let gateway_id = "gw-f3f6";
        let client_key = wireguard_keys::generate(dir.path(), gateway_id).unwrap();
        let peer =
            wireguard::tests::start_loopback_peer_forwarder(&client_key.public_key, axum_addr)
                .await;
        peer_port_cell.set(peer.http_port).unwrap();

        let identity_origin = format!("http://{axum_addr}");
        let proxy_apex = format!("http://localtest.me:{}", peer.http_port);
        let proxy_origin = format!(
            "http://alice--bbbbbbbbbbbb.p1.localtest.me:{}",
            peer.http_port
        );

        let mut gw_cfg: config::Gateway = serde_json::from_value(serde_json::json!({
            "id": gateway_id,
            "url": identity_origin,
        }))
        .unwrap();
        gw_cfg.wireguard_public_key = Some(client_key.public_key.clone());
        gw_cfg.wireguard_enrolled_key = Some(client_key.public_key);
        gw_cfg.wireguard_key_file = Some(client_key.path.clone());
        gw_cfg.wireguard_enrollment = Some(config::WireguardEnrollment {
            key_file: client_key.path,
            addresses: vec!["10.7.0.2/32".into()],
            allowed_ips: vec!["10.7.0.1/32".into()],
            persistent_keepalive: Some(5),
            ingresses: vec![config::WireguardIngress {
                id: "p1".into(),
                endpoint: peer.endpoint.clone(),
                public_key: peer.public_key.clone(),
                hosts: vec![config::WireguardHost {
                    name: "*.p1.localtest.me".into(),
                    addresses: vec!["10.7.0.1".parse().unwrap()],
                }],
            }],
        });
        let prepared = wireguard::prepare(&gw_cfg);
        gw_cfg.wireguard_protection = prepared.protection;
        {
            let mut guard = store.lock().unwrap();
            let mut cfg = guard.get().unwrap();
            cfg.gateways.push(gw_cfg);
            guard.save(&cfg).unwrap();
        }
        wireguard::reconcile_saved(&state, gateway_id).unwrap();
        fabric.settled_gateway(gateway_id).await.unwrap();

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
                id: "pat-f3f6".into(),
                secret: "secret-f3f6".into(),
                label: "f3f6".into(),
                expires_at: String::new(),
            },
        );
        let (_lib_home, _notify) = install_test_embedded(&state).await;

        let app = runtime_capability::tests::mock_app_with_context();
        app.manage(Arc::clone(&state));
        let main = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External("http://127.0.0.1:8471/?t=boot".parse().unwrap()),
        )
        .build()
        .unwrap();
        let synth_id = gateway::synthesized_row_id(gateway_id, "alice", &ds64);

        devserver::with_test_wireguard_http(fabric.address(), async {
            connect_rostered_devserver(app.handle().clone(), Arc::clone(&state), synth_id.clone())
                .await
                .expect("initial rostered connect over WireGuard");
            let rec = state
                .devserver_feed
                .record_for_window_id("w-reopen")
                .expect("w-reopen in feed")
                .1;
            mobile_auth::mobile_open_existing_window_with_app(
                app.handle(),
                &state,
                &synth_id,
                &rec,
            )
            .await
            .expect("open existing window over WireGuard");
            assert!(state
                .devservers
                .get(&synth_id)
                .unwrap()
                .gateway
                .as_ref()
                .unwrap()
                .access
                .is_some());
            assert!(peer.hits.load(Ordering::Relaxed) > 0);
            assert_eq!(
                main.url().unwrap().origin().ascii_serialization(),
                proxy_origin
            );

            // Stop p1's WireGuard tunnel; reconnect must fail closed with STOPPED.
            fabric
                .shut_down_ingress_for_test(gateway_id, &format!("{gateway_id}/p1"))
                .await;
            assert_eq!(
                fabric.view(gateway_id).0.as_deref(),
                Some("stopped; connect the gateway again")
            );
            let err = reconnect_devserver_for_window_impl(app.handle(), &state, &main)
                .await
                .expect_err("reconnect must fail closed while tunnel is stopped");
            assert!(err.contains("stopped; connect the gateway again"), "{err}");
            assert!(!state.devservers.is_connected(&synth_id));

            // Navigate back to the stale remote window URL, recover via reconcile_saved, and reconnect.
            let stale_url = format!("{proxy_origin}/notes/index.html?w=w-reopen&lib=lib-reconn");
            main.navigate(stale_url.parse().unwrap()).unwrap();
            wireguard::reconcile_saved(&state, gateway_id).unwrap();
            fabric.settled_gateway(gateway_id).await.unwrap();

            let hits_before = peer.hits.load(Ordering::Relaxed);
            reconnect_devserver_for_window_impl(app.handle(), &state, &main)
                .await
                .expect("reconnect succeeds after tunnel recovery");
            assert!(state.devservers.is_connected(&synth_id));
            assert!(state
                .devservers
                .get(&synth_id)
                .unwrap()
                .gateway
                .as_ref()
                .unwrap()
                .access
                .is_some());
            let reopened = main.url().unwrap();
            assert_eq!(reopened.origin().ascii_serialization(), proxy_origin);
            let q = query_map(&reopened);
            assert_eq!(q.get("w").map(String::as_str), Some("w-reopen"));
            assert_eq!(q.get("lib").map(String::as_str), Some("lib-reconn"));
            assert_eq!(q.get("pane").map(String::as_str), Some("#223344"));
            assert!(peer.hits.load(Ordering::Relaxed) > hits_before);
        })
        .await;

        auth::test_gateway_pats()
            .lock()
            .unwrap()
            .remove(&identity_origin);
        server.abort();
    }

    #[tokio::test]
    async fn f6_f7_create_mutate_close_and_focus_observe_shared_feed() {
        let mut seed_rec =
            sample_remote_record("lib-1", "w-seed", chan_server::WindowKind::Workspace);
        seed_rec.prefix = "/notes-1a2b".into();
        let windows_store = Arc::new(Mutex::new(vec![seed_rec]));

        let router = axum::Router::new()
            .route(
                "/api/library/workspaces",
                axum::routing::get(|| async {
                    axum::Json(vec![chan_server::LauncherWorkspace {
                        workspace_id: "notes-1a2b".into(),
                        path: "/srv/notes".into(),
                        status: chan_server::WorkspaceStatus::Running,
                        error: None,
                        label: "notes".into(),
                        on: true,
                        library_id: Some("lib-1".into()),
                        devserver_id: None,
                        prefix: "notes-1a2b".into(),
                    }])
                }),
            )
            .route(
                "/api/library/windows",
                axum::routing::post({
                    let windows_store = Arc::clone(&windows_store);
                    move |axum::Json(req): axum::Json<chan_server::CreateWindow>| {
                        let windows_store = Arc::clone(&windows_store);
                        async move {
                            let mut rec = sample_remote_record("lib-1", "w-new-1", req.kind);
                            rec.workspace_path = req.workspace_path;
                            rec.prefix = "/notes-1a2b".into();
                            rec.hidden = false;
                            windows_store.lock().unwrap().push(rec.clone());
                            axum::Json(rec)
                        }
                    }
                })
                .get({
                    let windows_store = Arc::clone(&windows_store);
                    move || {
                        let windows_store = Arc::clone(&windows_store);
                        async move { axum::Json(windows_store.lock().unwrap().clone()) }
                    }
                }),
            )
            .route(
                "/api/library/windows/{id}/visibility",
                axum::routing::post({
                    let windows_store = Arc::clone(&windows_store);
                    move |axum::extract::Path(id): axum::extract::Path<String>,
                          axum::Json(body): axum::Json<serde_json::Value>| {
                        let windows_store = Arc::clone(&windows_store);
                        async move {
                            let hidden = body["hidden"].as_bool().unwrap_or(false);
                            if let Some(row) = windows_store
                                .lock()
                                .unwrap()
                                .iter_mut()
                                .find(|r| r.window_id == id)
                            {
                                row.hidden = hidden;
                            }
                            axum::http::StatusCode::NO_CONTENT
                        }
                    }
                }),
            )
            .route(
                "/api/library/windows/{id}/label",
                axum::routing::put({
                    let windows_store = Arc::clone(&windows_store);
                    move |axum::extract::Path(id): axum::extract::Path<String>,
                          axum::Json(body): axum::Json<serde_json::Value>| {
                        let windows_store = Arc::clone(&windows_store);
                        async move {
                            let label = body["label"].as_str().unwrap_or("").to_string();
                            if let Some(row) = windows_store
                                .lock()
                                .unwrap()
                                .iter_mut()
                                .find(|r| r.window_id == id)
                            {
                                row.label = label;
                            }
                            axum::http::StatusCode::NO_CONTENT
                        }
                    }
                }),
            )
            .route(
                "/api/library/windows/{id}",
                axum::routing::delete({
                    let windows_store = Arc::clone(&windows_store);
                    move |axum::extract::Path(id): axum::extract::Path<String>| {
                        let windows_store = Arc::clone(&windows_store);
                        async move {
                            let mut guard = windows_store.lock().unwrap();
                            let before = guard.len();
                            guard.retain(|r| r.window_id != id);
                            if guard.len() < before {
                                axum::http::StatusCode::NO_CONTENT
                            } else {
                                axum::http::StatusCode::NOT_FOUND
                            }
                        }
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        let (_dir, state) = test_state();
        let (_lib_home, notify) = install_test_embedded(&state).await;
        let origin = format!("http://127.0.0.1:{}", addr.port());
        let gw = devserver::GatewayConn::new(
            origin.clone(),
            format!("{origin}/mobile/v1/devserver/entry"),
            origin.clone(),
            "pat".into(),
        );
        gw.seed_fresh_session_for_test("csrf-f6f7");
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
        state.devserver_feed.register_windows(
            "gw:1".into(),
            Arc::new(Mutex::new(state::DevserverWindowSnapshot::from(
                windows_store.lock().unwrap().clone(),
            ))),
        );

        let app = tauri::test::mock_app();
        let seed_url = format!("{origin}/notes-1a2b/index.html?w=w-seed&lib=lib-1");
        let main = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External(seed_url.parse().unwrap()),
        )
        .build()
        .unwrap();

        // 1. Create via single-webview command -> feed + notify + navigation.
        let notified = notify.notified();
        create_library_window_impl(
            app.handle(),
            &state,
            &main,
            chan_server::WindowKind::Workspace,
            Some("notes-1a2b".into()),
        )
        .await
        .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), notified)
            .await
            .expect("create notifies library change");
        assert!(state
            .devserver_feed
            .record_for_window_id("w-new-1")
            .is_some());
        assert_eq!(
            query_map(&main.url().unwrap()).get("w").map(String::as_str),
            Some("w-new-1")
        );

        // 2. Hide via remote window_ops -> feed reflects hidden == true + notify.
        let notified = notify.notified();
        window_ops::hide_remote_window(&state, "gw:1", "w-new-1")
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), notified)
            .await
            .expect("hide notifies library change");
        assert!(
            state
                .devserver_feed
                .record_for_window_id("w-new-1")
                .unwrap()
                .1
                .hidden
        );

        // 3. Rename via remote window_ops -> feed reflects label + notify.
        let notified = notify.notified();
        window_ops::set_remote_window_label(&state, "w-new-1", "Renamed-Pair")
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), notified)
            .await
            .expect("label notifies library change");
        assert_eq!(
            state
                .devserver_feed
                .record_for_window_id("w-new-1")
                .unwrap()
                .1
                .label,
            "Renamed-Pair"
        );

        // 4. Focus from w-seed -> observes hidden == true in feed, unhides, preserves label, navigates.
        main.navigate(seed_url.parse().unwrap()).unwrap();
        let notified = notify.notified();
        focus_library_window_impl(app.handle(), &state, &main, "w-new-1".into())
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), notified)
            .await
            .expect("focus unhide notifies library change");
        let focused_rec = state
            .devserver_feed
            .record_for_window_id("w-new-1")
            .unwrap()
            .1;
        assert!(!focused_rec.hidden);
        assert_eq!(focused_rec.label, "Renamed-Pair");
        assert_eq!(
            query_map(&main.url().unwrap()).get("w").map(String::as_str),
            Some("w-new-1")
        );

        // 5. Close via discard_devserver_window_in_state -> removes from feed + focus fails.
        let notified = notify.notified();
        assert!(discard_devserver_window_in_state(&state, "w-new-1")
            .await
            .unwrap());
        tokio::time::timeout(std::time::Duration::from_secs(2), notified)
            .await
            .expect("discard notifies library change");
        assert!(state
            .devserver_feed
            .record_for_window_id("w-new-1")
            .is_none());
        let missing_err = focus_library_window_impl(app.handle(), &state, &main, "w-new-1".into())
            .await
            .expect_err("focusing closed window must fail");
        assert!(
            missing_err.contains("window w-new-1 was not found"),
            "{missing_err}"
        );

        server.abort();
    }

    #[tokio::test]
    async fn f6_f8_runtime_acl_show_computers_delivery_and_launcher_toggle() {
        const EXACT_ORIGIN: &str = "https://alice--f6f8aabbccdd.p1.proxy.chan.app";
        const REMOTE_PAGE: &str =
            "https://alice--f6f8aabbccdd.p1.proxy.chan.app/notes/index.html?w=w-1&lib=lib-1";

        let app = runtime_capability::tests::mock_ios_app();
        let (_dir, state) = test_state();
        let (_lib_home, _notify) = install_test_embedded(&state).await;
        let home = mobile_auth::mobile_launcher_url(&state).unwrap();

        let main = runtime_capability::tests::window_at(&app, "main", home.as_str());
        let other = runtime_capability::tests::window_at(&app, "other", REMOTE_PAGE);

        assert_eq!(
            runtime_capability::mint_exact_origin_grant(&app, EXACT_ORIGIN),
            Ok(true)
        );

        for allowed in [
            "show_computers_for_window",
            "toggle_launcher_panel",
            "mobile_back_to_computers",
        ] {
            assert!(
                runtime_capability::tests::invoke_from(&main, REMOTE_PAGE, allowed).is_ok(),
                "remote main must permit {allowed}"
            );
        }
        assert!(
            runtime_capability::tests::invoke_from(
                &main,
                REMOTE_PAGE,
                "mobile_deliver_pending_show_card"
            )
            .is_err(),
            "remote main must deny loopback card delivery"
        );

        for allowed in [
            "toggle_launcher_panel",
            "mobile_back_to_computers",
            "mobile_deliver_pending_show_card",
        ] {
            assert!(
                runtime_capability::tests::invoke_from(&main, home.as_str(), allowed).is_ok(),
                "loopback main must permit {allowed}"
            );
        }
        assert!(
            runtime_capability::tests::invoke_from(
                &main,
                home.as_str(),
                "show_computers_for_window"
            )
            .is_err(),
            "loopback main must deny show_computers_for_window"
        );

        for cmd in [
            "show_computers_for_window",
            "toggle_launcher_panel",
            "mobile_back_to_computers",
            "mobile_deliver_pending_show_card",
        ] {
            assert!(
                runtime_capability::tests::invoke_from(&other, REMOTE_PAGE, cmd).is_err(),
                "non-main window must deny {cmd}"
            );
        }

        // Navigate main to remote origin, seed remote tracking + WireGuard selection + feed.
        state
            .devserver_feed
            .seed_library_id("gw:1".into(), "lib-1".into());
        main.navigate(REMOTE_PAGE.parse().unwrap()).unwrap();
        wireguard::select_for_test(&state, "gw:1", EXACT_ORIGIN);
        *state.last_remote_origin.lock().unwrap() =
            Some((EXACT_ORIGIN.to_string(), "gw:1".to_string()));
        let epoch_before = state
            .navigation_epoch
            .load(std::sync::atomic::Ordering::Acquire);

        show_computers_for_window_impl(&main, &state).unwrap();
        assert!(same_page(&main.url().unwrap(), &home));
        assert!(
            state
                .navigation_epoch
                .load(std::sync::atomic::Ordering::Acquire)
                > epoch_before
        );
        assert!(state.selected_wireguard.lock().unwrap().is_none());
        assert!(state.last_remote_origin.lock().unwrap().is_none());
        assert_eq!(
            *state.pending_show_card.lock().unwrap(),
            Some(Some("gw:1".to_string()))
        );

        // Card delivery rejects non-main and non-loopback, then emits once on main at home.
        assert!(mobile_deliver_pending_show_card_impl(app.handle(), &other, &state).is_err());
        main.navigate(REMOTE_PAGE.parse().unwrap()).unwrap();
        assert!(mobile_deliver_pending_show_card_impl(app.handle(), &main, &state).is_err());

        main.navigate(home.clone()).unwrap();
        let (card_tx, mut card_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        main.listen("launcher-show-devserver-card", move |event| {
            let _ = card_tx.send(event.payload().to_string());
        });
        mobile_deliver_pending_show_card_impl(app.handle(), &main, &state).unwrap();
        let payload = card_rx.try_recv().expect("card event emitted");
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(parsed["devserverId"], "gw:1");
        assert!(state.pending_show_card.lock().unwrap().is_none());
        mobile_deliver_pending_show_card_impl(app.handle(), &main, &state).unwrap();
        assert!(card_rx.try_recv().is_err());

        // toggle_launcher_panel returns home from remote and resets epoch/state, then is a no-op on loopback.
        main.navigate(REMOTE_PAGE.parse().unwrap()).unwrap();
        wireguard::select_for_test(&state, "gw:1", EXACT_ORIGIN);
        *state.last_remote_origin.lock().unwrap() =
            Some((EXACT_ORIGIN.to_string(), "gw:1".to_string()));
        let epoch_remote = state
            .navigation_epoch
            .load(std::sync::atomic::Ordering::Acquire);
        toggle_launcher_panel_impl(&main, &state).unwrap();
        assert!(same_page(&main.url().unwrap(), &home));
        let epoch_home = state
            .navigation_epoch
            .load(std::sync::atomic::Ordering::Acquire);
        assert!(epoch_home > epoch_remote);
        assert!(state.selected_wireguard.lock().unwrap().is_none());
        assert!(state.last_remote_origin.lock().unwrap().is_none());

        toggle_launcher_panel_impl(&main, &state).unwrap();
        assert!(same_page(&main.url().unwrap(), &home));
        assert_eq!(
            state
                .navigation_epoch
                .load(std::sync::atomic::Ordering::Acquire),
            epoch_home
        );
    }

    #[tokio::test]
    async fn f1_f9_context_boot_webview_and_embedded_launcher_align() {
        let app = runtime_capability::tests::mock_ios_app();
        let (_dir, state) = test_state();
        let lib_home = tempfile::tempdir().unwrap();
        let library = chan_workspace::Library::open_at(lib_home.path().join("library.toml"))
            .expect("open library");
        let embedded = embedded::EmbeddedServer::for_tests_listening(library).await;
        embedded.install_devserver_feed(
            Arc::clone(&state.devserver_feed) as Arc<dyn chan_server::DevserverFeedSource>
        );
        let _ = state.embedded.set(embedded);
        let embedded = state.embedded().expect("embedded server installed");
        let launcher_url = mobile_auth::mobile_launcher_url(&state).unwrap();

        let main = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External(launcher_url.clone()),
        )
        .build()
        .unwrap();

        assert_eq!(app.package_info().version.to_string(), "0.135.0");
        assert_eq!(app.config().identifier, "app.chan.ios");

        let vocab = native_vocabulary_for(app.handle());
        assert_eq!(vocab.version, "0.135.0");
        let expected_cmds: Vec<String> = runtime_capability::GATEWAY_WINDOW_COMMANDS
            .iter()
            .map(|c| (*c).to_string())
            .collect();
        assert_eq!(vocab.commands, expected_cmds);

        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let windows_url = format!("http://{}/api/library/windows", embedded.addr());
        let authed = client
            .get(&windows_url)
            .bearer_auth(embedded.launcher_token())
            .send()
            .await
            .unwrap();
        assert_eq!(authed.status(), reqwest::StatusCode::OK);
        let unauthed = client.get(&windows_url).send().await.unwrap();
        assert_eq!(unauthed.status(), reqwest::StatusCode::UNAUTHORIZED);

        for allowed in [
            "mobile_back_to_computers",
            "toggle_launcher_panel",
            "native_vocabulary",
        ] {
            assert!(
                runtime_capability::tests::invoke_from(&main, launcher_url.as_str(), allowed)
                    .is_ok(),
                "loopback main must allow {allowed}"
            );
        }
        for denied in ["show_computers_for_window", "focus_library_window"] {
            assert!(
                runtime_capability::tests::invoke_from(&main, launcher_url.as_str(), denied)
                    .is_err(),
                "loopback main must deny {denied}"
            );
        }
    }
}
