//! The launcher panel: the Computers launcher shown inside a chan window.
//!
//! Every window that hosts the SPA (a watcher-opened `local::*` or `lib-*`
//! window, a `control-terminal-*` window) can toggle the launcher over its
//! whole content area, keeping its own title bar. The launcher is a second
//! webview inside the same native window, which chan-desktop builds with wry
//! directly rather than through Tauri: on macOS it is a subview of the
//! window's content view laid over the window's own webview, on Windows a
//! child of the window over it, and on Linux it takes the window webview's
//! place in the window's GTK box, which works on X11 and Wayland alike. It is
//! built on the first toggle, kept hidden on toggle-off so the next show is
//! instant, and dropped with its host, which removes its native view.
//!
//! Built outside Tauri because Tauri's own multi-webview windows need its
//! `unstable` feature, which changes the webview kind of every window and
//! stops a window holding two webviews from resolving as a `WebviewWindow`.
//! Outside Tauri the launcher webview has no Tauri IPC, so launcher_ipc.js
//! gives the page the two calls its desktop module makes, and this module
//! answers exactly the commands in `LauncherCommand` and forwards exactly the
//! events in `FORWARDED_EVENTS`.
//!
//! The toggle animates each page in its own webview (launcher_transition.js)
//! and this module sequences the handoff: the host's panes gather, the
//! launcher shows and fades up; the launcher fades down and hides, and the
//! panes deal back out.
//!
//! A wry webview is not `Send`, so every launcher lives in a main-thread map
//! and every touch of one runs on the main thread.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Listener, Manager, WebviewWindow, WindowEvent};
use tauri_plugin_opener::OpenerExt;

use crate::{serve, window_ops, AppState};

/// The toggle's transition stages, evaluated into the host and the launcher.
pub(crate) const TRANSITION_JS: &str = include_str!("launcher_transition.js");

/// The launcher page's stand-in for Tauri's global API, over wry's message
/// channel.
pub(crate) const LAUNCHER_IPC_JS: &str = include_str!("launcher_ipc.js");

/// The launcher's key bridge: reload, plus the Ctrl+Shift+P toggle. On macOS
/// the menubar's Cmd+P accelerator pre-empts the page, so the bridge claims
/// only the Ctrl+Shift form.
pub(crate) const LAUNCHER_BRIDGE_JS: &str = include_str!("launcher_bridge.js");

/// The events the launcher subscribes to (web-launcher App.svelte), forwarded
/// from the app's event bus into every launcher.
pub(crate) const FORWARDED_EVENTS: [&str; 6] = [
    "devserver-control-attention",
    "devserver-control-restored",
    crate::DESKTOP_UPDATE_READY_EVENT,
    "auth-error",
    "auth-changed",
    crate::gateway::LAUNCHER_NOTICE,
];

/// The gather's budget: launcher_transition.js runs each pane for 180ms and
/// spreads the starts over at most 80ms, so the launcher shows once that ends.
pub(crate) const HOST_OUT_MS: u64 = 260;
/// The launcher's fade-down in launcher_transition.js; it hides after it.
pub(crate) const LAUNCHER_OUT_MS: u64 = 160;
/// How long the first show waits for the launcher page to finish loading, so
/// it never shows an unpainted webview; it shows anyway after this.
const FIRST_LOAD_TIMEOUT: Duration = Duration::from_secs(3);
/// How long a show waits for the launcher's start frame to be applied.
const PRIME_TIMEOUT: Duration = Duration::from_millis(250);

thread_local! {
    /// Each host's launcher webview, by host label. Main thread only.
    static LAUNCHERS: RefCell<HashMap<String, wry::WebView>> = RefCell::new(HashMap::new());
}

/// The hosts whose launcher is showing; readable from any thread.
static VISIBLE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
/// The hosts whose resize events already re-fit their launcher. A host hidden
/// in place keeps its window, and with it the hook, across a launcher rebuild;
/// only the host's destruction drops the entry.
static SYNC_HOOKED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
/// One transition per host at a time: a second toggle while one runs is
/// dropped, so the stages can never interleave on a page.
static IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn set(cell: &'static OnceLock<Mutex<HashSet<String>>>) -> &'static Mutex<HashSet<String>> {
    cell.get_or_init(Default::default)
}

/// The windows that host a launcher: every window that shows the SPA, which
/// is the watcher-opened local and devserver windows and the control
/// terminals.
pub(crate) fn can_host_panel(label: &str) -> bool {
    serve::is_workspace_webview_label(label) || label.starts_with("control-terminal-")
}

pub(crate) fn panel_is_visible(host: &str) -> bool {
    set(&VISIBLE).lock().unwrap().contains(host)
}

/// What the toggle does for the focused window.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ToggleTarget {
    /// The focused window hosts a launcher: show or hide it.
    TogglePanelOf(String),
    /// Nothing that can host a launcher is focused: open a standalone terminal.
    OpenTerminal,
}

pub(crate) fn toggle_target(focused: Option<&str>) -> ToggleTarget {
    match focused {
        Some(label) if can_host_panel(label) => ToggleTarget::TogglePanelOf(label.to_string()),
        _ => ToggleTarget::OpenTerminal,
    }
}

/// Wire the app's event bus to the launchers: each forwarded event reaches
/// every launcher as it would a Tauri listener. Called once at setup.
pub(crate) fn install(app: &AppHandle) {
    for event in FORWARDED_EVENTS {
        let app_for_event = app.clone();
        app.listen_any(event, move |emitted| {
            let payload = match emitted.payload().trim() {
                "" => "null".to_string(),
                payload => payload.to_string(),
            };
            let js = format!(
                "window.__chanLauncherHost&&window.__chanLauncherHost.emit({},{payload});",
                serde_json::json!(event)
            );
            let _ = app_for_event.run_on_main_thread(move || {
                LAUNCHERS.with(|launchers| {
                    if let Ok(launchers) = launchers.try_borrow() {
                        for webview in launchers.values() {
                            let _ = webview.evaluate_script(&js);
                        }
                    }
                });
            });
        });
    }
}

/// Route the menubar's Toggle Launcher by the focused window.
pub(crate) fn toggle_for_focused(app: &AppHandle) {
    let focused = app
        .webview_windows()
        .into_iter()
        .find(|(_, w)| w.is_focused().unwrap_or(false))
        .map(|(label, _)| label);
    match toggle_target(focused.as_deref()) {
        ToggleTarget::TogglePanelOf(host) => toggle(app, &host),
        ToggleTarget::OpenTerminal => crate::spawn_terminal_window(app),
    }
}

/// The toggle chord from a host window's key bridge (Ctrl+Shift+P).
#[tauri::command]
pub(crate) async fn toggle_launcher_panel(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    match toggle_target(Some(window.label())) {
        ToggleTarget::TogglePanelOf(host) => {
            toggle(&app, &host);
            Ok(())
        }
        ToggleTarget::OpenTerminal => Err(format!("{} cannot host the launcher", window.label())),
    }
}

/// Show the launcher where the user is looking, on the focused host, else on
/// the first visible one, and return once it is shown, so an event sent next
/// reaches a page that has loaded and subscribed. `false` when no window can
/// host it. A toggle already running on that host is left to finish.
pub(crate) async fn show_for_attention(app: &AppHandle) -> bool {
    let hosts: Vec<WebviewWindow> = app
        .webview_windows()
        .into_values()
        .filter(|w| can_host_panel(w.label()) && w.is_visible().unwrap_or(false))
        .collect();
    let Some(host) = hosts
        .iter()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| hosts.first())
        .map(|w| w.label().to_string())
    else {
        return false;
    };
    if panel_is_visible(&host) {
        return true;
    }
    let Some(_guard) = TransitionGuard::take(&host) else {
        return true;
    };
    if let Err(e) = show_async(app, &host).await {
        tracing::warn!(host = %host, error = %e, "showing the launcher for attention failed");
    }
    true
}

pub(crate) fn toggle(app: &AppHandle, host: &str) {
    spawn_transition(app, host, !panel_is_visible(host));
}

pub(crate) fn hide(app: &AppHandle, host: &str) {
    spawn_transition(app, host, false);
}

/// Drop a host's launcher, giving the host its own webview back first. Runs
/// where the host is hidden in place, so a host shown again shows itself.
pub(crate) fn close_for_host<R: tauri::Runtime>(app: &AppHandle<R>, host: &str) {
    let was_visible = set(&VISIBLE).lock().unwrap().remove(host);
    let host = host.to_string();
    let app_for_main = app.clone();
    let _ = app.run_on_main_thread(move || {
        if was_visible {
            if let Some(window) = app_for_main.get_webview_window(&host) {
                restore_host(&window);
            }
        }
        LAUNCHERS.with(|launchers| {
            if let Ok(mut launchers) = launchers.try_borrow_mut() {
                launchers.remove(&host);
            }
        });
    });
}

/// Forget a destroyed host: its launcher goes with it, and a later window that
/// reuses the label hooks its own events afresh.
pub(crate) fn forget_host<R: tauri::Runtime>(app: &AppHandle<R>, host: &str) {
    close_for_host(app, host);
    set(&SYNC_HOOKED).lock().unwrap().remove(host);
}

struct TransitionGuard(String);

impl TransitionGuard {
    fn take(host: &str) -> Option<Self> {
        set(&IN_FLIGHT)
            .lock()
            .unwrap()
            .insert(host.to_string())
            .then(|| Self(host.to_string()))
    }
}

impl Drop for TransitionGuard {
    fn drop(&mut self) {
        set(&IN_FLIGHT).lock().unwrap().remove(&self.0);
    }
}

fn spawn_transition(app: &AppHandle, host: &str, show: bool) {
    let Some(guard) = TransitionGuard::take(host) else {
        tracing::debug!(host, "launcher toggle dropped: a transition is running");
        return;
    };
    let app = app.clone();
    let host = host.to_string();
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        let result = if show {
            show_async(&app, &host).await
        } else {
            hide_async(&app, &host).await
        };
        if let Err(e) = result {
            tracing::warn!(host = %host, show, error = %e, "launcher toggle failed");
        }
    });
}

fn stage_js(stage: &str) -> String {
    format!("{TRANSITION_JS}\nwindow.__chanLauncherTransition.{stage}();")
}

fn eval_host(window: &WebviewWindow, stage: &str) {
    if let Err(e) = window.eval(stage_js(stage)) {
        tracing::debug!(label = window.label(), stage, error = %e, "transition stage eval failed");
    }
}

/// Evaluate a stage in a host's launcher and wait for the page to have run it,
/// bounded by `PRIME_TIMEOUT`.
async fn eval_launcher(app: &AppHandle, host: &str, stage: &str) {
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let tx = Mutex::new(Some(tx));
    let js = stage_js(stage);
    let host = host.to_string();
    let scheduled = app.run_on_main_thread(move || {
        LAUNCHERS.with(|launchers| {
            let Ok(launchers) = launchers.try_borrow() else {
                return;
            };
            if let Some(webview) = launchers.get(&host) {
                let _ = webview.evaluate_script_with_callback(&js, move |_| {
                    if let Some(tx) = tx.lock().unwrap().take() {
                        let _ = tx.send(());
                    }
                });
            }
        });
    });
    if scheduled.is_ok() {
        let _ = tokio::time::timeout(PRIME_TIMEOUT, rx).await;
    }
}

async fn show_async(app: &AppHandle, host: &str) -> Result<(), String> {
    let host_window = app
        .get_webview_window(host)
        .ok_or_else(|| format!("{host} isn't open"))?;
    // The gather and the launcher's build (on the first toggle) run together,
    // so a cold launcher costs no more than its page load beyond the animation.
    let gather = async {
        eval_host(&host_window, "hostOut");
        tokio::time::sleep(Duration::from_millis(HOST_OUT_MS)).await;
    };
    let (_, built) = tokio::join!(gather, ensure_panel(app, &host_window));
    built?;
    // Primed before it shows, so the launcher's first painted frame is the
    // start of its fade rather than the settled page.
    eval_launcher(app, host, "launcherPrimeIn").await;
    let app_for_main = app.clone();
    let host_for_main = host_window.clone();
    window_ops::on_main(app, move || show_now(&app_for_main, &host_for_main)).await?;
    eval_launcher(app, host, "launcherIn").await;
    eval_host(&host_window, "hostReset");
    Ok(())
}

async fn hide_async(app: &AppHandle, host: &str) -> Result<(), String> {
    if !panel_is_visible(host) {
        return Ok(());
    }
    let host_window = app.get_webview_window(host);
    if let Some(host_window) = &host_window {
        eval_host(host_window, "hostPrimeIn");
    }
    eval_launcher(app, host, "launcherOut").await;
    tokio::time::sleep(Duration::from_millis(LAUNCHER_OUT_MS)).await;
    let app_for_main = app.clone();
    let host_label = host.to_string();
    let host_for_main = host_window.clone();
    window_ops::on_main(app, move || {
        hide_now(&app_for_main, &host_label, host_for_main.as_ref())
    })
    .await?;
    if let Some(host_window) = &host_window {
        eval_host(host_window, "hostIn");
    }
    eval_launcher(app, host, "launcherReset").await;
    Ok(())
}

/// Show a host's launcher over its content and give it the keyboard. Main
/// thread.
fn show_now(app: &AppHandle, host: &WebviewWindow) {
    let label = host.label().to_string();
    let shown = LAUNCHERS.with(|launchers| {
        let Ok(launchers) = launchers.try_borrow() else {
            return false;
        };
        let Some(webview) = launchers.get(&label) else {
            return false;
        };
        #[cfg(not(target_os = "linux"))]
        fit(host, webview);
        #[cfg(target_os = "linux")]
        swap_gtk(host, webview, true);
        let _ = webview.set_visible(true);
        let _ = webview.focus();
        true
    });
    if !shown {
        return;
    }
    set(&VISIBLE).lock().unwrap().insert(label);
    // Off macOS the launcher carries the only menubar, so the host wears it
    // while its launcher shows.
    #[cfg(not(target_os = "macos"))]
    {
        match crate::build_launcher_menu(app) {
            Ok(menu) => {
                if let Err(e) = host.set_menu(menu) {
                    tracing::warn!(error = %e, "attaching the launcher menu failed");
                }
            }
            Err(e) => tracing::warn!(error = %e, "building the launcher menu failed"),
        }
        crate::rebuild_window_menu(app);
    }
    #[cfg(target_os = "macos")]
    let _ = app;
}

/// Hide a host's launcher and hand the keyboard back to the host's own
/// webview. Main thread.
fn hide_now(app: &AppHandle, host: &str, host_window: Option<&WebviewWindow>) {
    set(&VISIBLE).lock().unwrap().remove(host);
    LAUNCHERS.with(|launchers| {
        if let Ok(launchers) = launchers.try_borrow() {
            if let Some(webview) = launchers.get(host) {
                let _ = webview.set_visible(false);
            }
        }
    });
    let Some(host_window) = host_window else {
        return;
    };
    restore_host(host_window);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = host_window.remove_menu();
        crate::rebuild_window_menu(app);
    }
    #[cfg(target_os = "macos")]
    let _ = app;
}

/// Give a host its own webview back: visible (Linux swaps them) and focused.
fn restore_host<R: tauri::Runtime>(host: &WebviewWindow<R>) {
    #[cfg(target_os = "linux")]
    LAUNCHERS.with(|launchers| {
        if let Ok(launchers) = launchers.try_borrow() {
            if let Some(webview) = launchers.get(host.label()) {
                swap_gtk(host, webview, false);
            }
        }
    });
    let webview: &tauri::Webview<R> = host.as_ref();
    let _ = webview.set_focus();
}

/// The host's content area as a wry rect at the content view's origin, in
/// logical points.
#[cfg(not(target_os = "linux"))]
fn content_bounds(host: &WebviewWindow) -> Option<wry::Rect> {
    let size = host.inner_size().ok()?;
    let scale = host.scale_factor().ok()?;
    Some(content_rect(size, scale))
}

#[cfg(any(not(target_os = "linux"), test))]
fn content_rect(size: tauri::PhysicalSize<u32>, scale: f64) -> wry::Rect {
    let logical = size.to_logical::<f64>(scale);
    wry::Rect {
        position: wry::dpi::LogicalPosition::new(0.0, 0.0).into(),
        size: wry::dpi::LogicalSize::new(logical.width, logical.height).into(),
    }
}

#[cfg(not(target_os = "linux"))]
fn fit(host: &WebviewWindow, webview: &wry::WebView) {
    if let Some(bounds) = content_bounds(host) {
        if let Err(e) = webview.set_bounds(bounds) {
            tracing::warn!(host = host.label(), error = %e, "sizing the launcher failed");
        }
    }
}

/// Linux: the host's webview and the launcher share the window's GTK box, so
/// showing the launcher hides the host's webview and the launcher takes its
/// place; the menubar, when attached, stays.
#[cfg(target_os = "linux")]
fn swap_gtk<R: tauri::Runtime>(
    host: &WebviewWindow<R>,
    launcher: &wry::WebView,
    show_launcher: bool,
) {
    use gtk::prelude::*;
    use wry::WebViewExtUnix;
    let Ok(vbox) = host.default_vbox() else {
        return;
    };
    let launcher_widget: gtk::Widget = launcher.webview().upcast();
    for child in vbox.children() {
        if child == launcher_widget || child.type_().name() != "WebKitWebView" {
            continue;
        }
        child.set_visible(!show_launcher);
        if !show_launcher {
            child.grab_focus();
        }
    }
}

/// Re-fit a host's launcher to the host's content area.
fn sync_for_host(host: &WebviewWindow) {
    #[cfg(not(target_os = "linux"))]
    LAUNCHERS.with(|launchers| {
        if let Ok(launchers) = launchers.try_borrow() {
            if let Some(webview) = launchers.get(host.label()) {
                fit(host, webview);
            }
        }
    });
    #[cfg(target_os = "linux")]
    let _ = host;
}

/// The loopback launcher URL and the origin its pages may come from.
fn launcher_target(app: &AppHandle) -> Result<(String, String), String> {
    let state = app.state::<Arc<AppState>>();
    let embedded = state
        .embedded()
        .ok_or_else(|| "embedded local server is unavailable".to_string())?;
    let origin = format!("http://{}", embedded.addr());
    let url = format!("{origin}/?t={}", embedded.launcher_token());
    Ok((url, origin))
}

/// Build the host's launcher if it has none, waiting on the first build for
/// the page to finish loading (bounded by `FIRST_LOAD_TIMEOUT`) so the show
/// never paints an empty webview.
async fn ensure_panel(app: &AppHandle, host: &WebviewWindow) -> Result<(), String> {
    let (url, origin) = launcher_target(app)?;
    let (loaded_tx, loaded_rx) = tokio::sync::oneshot::channel::<()>();
    let loaded_tx = Arc::new(Mutex::new(Some(loaded_tx)));
    let app_for_build = app.clone();
    let host_for_build = host.clone();
    let built = window_ops::on_main(app, move || {
        build_panel(&app_for_build, &host_for_build, url, origin, loaded_tx)
    })
    .await??;
    if built
        && tokio::time::timeout(FIRST_LOAD_TIMEOUT, loaded_rx)
            .await
            .is_err()
    {
        tracing::warn!(
            host = host.label(),
            "launcher page load timed out; showing it anyway"
        );
    }
    Ok(())
}

/// Build a host's launcher hidden, on the main thread. `false` when the host
/// already has one.
fn build_panel(
    app: &AppHandle,
    host: &WebviewWindow,
    url: String,
    origin: String,
    loaded_tx: Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
) -> Result<bool, String> {
    let label = host.label().to_string();
    let exists = LAUNCHERS.with(|launchers| {
        launchers
            .try_borrow()
            .map(|launchers| launchers.contains_key(&label))
            .unwrap_or(true)
    });
    if exists {
        return Ok(false);
    }
    let page_origin = format!("{origin}/");
    let app_for_ipc = app.clone();
    let host_for_ipc = label.clone();
    let origin_for_ipc = page_origin.clone();
    let app_for_nav = app.clone();
    let origin_for_nav = page_origin.clone();
    let app_for_new = app.clone();
    let app_for_load = app.clone();
    let builder = wry::WebViewBuilder::new()
        .with_url(url)
        .with_visible(false)
        .with_focused(false)
        .with_devtools(true)
        .with_initialization_script(LAUNCHER_IPC_JS)
        .with_initialization_script(LAUNCHER_BRIDGE_JS)
        .with_ipc_handler(move |request: wry::http::Request<String>| {
            // Only the launcher page itself may speak for the launcher.
            if !request.uri().to_string().starts_with(&origin_for_ipc) {
                tracing::warn!(uri = %request.uri(), "launcher IPC from a foreign page refused");
                return;
            }
            handle_ipc(&app_for_ipc, &host_for_ipc, request.body());
        })
        .with_navigation_handler(move |target: String| {
            if target.starts_with(&origin_for_nav) {
                return true;
            }
            open_externally(&app_for_nav, &target);
            false
        })
        .with_new_window_req_handler(move |target: String, _features| {
            open_externally(&app_for_new, &target);
            wry::NewWindowResponse::Deny
        })
        .with_on_page_load_handler(move |event, _url| {
            if matches!(event, wry::PageLoadEvent::Finished) {
                if let Some(tx) = loaded_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
                // The migration summary waits for the first launcher page:
                // its notice has no replay. It is one-shot by construction.
                let state = Arc::clone(&app_for_load.state::<Arc<AppState>>());
                crate::narrate_parked_migration(&app_for_load, &state);
            }
        });
    #[cfg(not(target_os = "linux"))]
    let webview = {
        let bounds =
            content_bounds(host).ok_or_else(|| format!("reading {label}'s content size failed"))?;
        builder
            .with_bounds(bounds)
            .build_as_child(host)
            .map_err(|e| format!("building the launcher for {label}: {e}"))?
    };
    #[cfg(target_os = "linux")]
    let webview = {
        use wry::WebViewBuilderExtUnix;
        let vbox = host
            .default_vbox()
            .map_err(|e| format!("reading {label}'s GTK box: {e}"))?;
        builder
            .build_gtk(&vbox)
            .map_err(|e| format!("building the launcher for {label}: {e}"))?
    };
    LAUNCHERS.with(|launchers| {
        launchers.borrow_mut().insert(label.clone(), webview);
    });
    if set(&SYNC_HOOKED).lock().unwrap().insert(label) {
        let host_for_sync = host.clone();
        host.on_window_event(move |event| {
            if matches!(
                event,
                WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }
            ) {
                sync_for_host(&host_for_sync);
            }
        });
    }
    Ok(true)
}

fn open_externally(app: &AppHandle, target: &str) {
    if target.starts_with("https://") || target.starts_with("http://") {
        if let Err(e) = app.opener().open_url(target, None::<&str>) {
            tracing::warn!(url = %target, error = %e, "opening a launcher link failed");
        }
    }
}

/// A command the launcher page may invoke: its desktop module's two
/// (api/desktop.ts) and its key bridge's two.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LauncherCommand {
    RequestAppQuit,
    RestartAfterUpdate,
    TogglePanel,
    Reload,
}

impl LauncherCommand {
    pub(crate) fn parse(cmd: &str) -> Option<Self> {
        match cmd {
            "request_app_quit" => Some(Self::RequestAppQuit),
            "restart_desktop_after_update" => Some(Self::RestartAfterUpdate),
            "toggle_launcher_panel" => Some(Self::TogglePanel),
            "reload_window" => Some(Self::Reload),
            _ => None,
        }
    }
}

#[derive(Deserialize)]
struct IpcMessage {
    id: u64,
    cmd: String,
}

/// Answer one launcher invoke. Main thread (wry calls the IPC handler there).
fn handle_ipc(app: &AppHandle, host: &str, body: &str) {
    let Ok(message) = serde_json::from_str::<IpcMessage>(body) else {
        tracing::warn!(host, "unreadable launcher IPC message");
        return;
    };
    let result = match LauncherCommand::parse(&message.cmd) {
        Some(LauncherCommand::RequestAppQuit) => {
            crate::request_quit(app);
            Ok(())
        }
        Some(LauncherCommand::RestartAfterUpdate) => {
            crate::restart_desktop_after_update(app.clone())
        }
        Some(LauncherCommand::TogglePanel) => {
            hide(app, host);
            Ok(())
        }
        Some(LauncherCommand::Reload) => LAUNCHERS.with(|launchers| {
            launchers
                .try_borrow()
                .ok()
                .and_then(|launchers| launchers.get(host).map(|webview| webview.reload()))
                .unwrap_or(Ok(()))
                .map_err(|e| e.to_string())
        }),
        None => Err(format!("{} is not available in the launcher", message.cmd)),
    };
    let (ok, value) = match result {
        Ok(()) => (true, serde_json::Value::Null),
        Err(e) => (false, serde_json::Value::String(e)),
    };
    let js = format!(
        "window.__chanLauncherHost&&window.__chanLauncherHost.settle({},{ok},{value});",
        message.id
    );
    LAUNCHERS.with(|launchers| {
        if let Ok(launchers) = launchers.try_borrow() {
            if let Some(webview) = launchers.get(host) {
                let _ = webview.evaluate_script(&js);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_spa_window_hosts_a_launcher() {
        for host in ["local::w-1", "lib-ab12::w-7", "control-terminal-ds-1"] {
            assert!(can_host_panel(host));
            assert_eq!(
                toggle_target(Some(host)),
                ToggleTarget::TogglePanelOf(host.into())
            );
        }
        assert!(!can_host_panel("about"));
        assert_eq!(toggle_target(Some("about")), ToggleTarget::OpenTerminal);
        assert_eq!(toggle_target(None), ToggleTarget::OpenTerminal);
    }

    #[test]
    fn content_rect_is_in_points_on_every_scale() {
        let rect = content_rect(tauri::PhysicalSize::new(2400, 1600), 2.0);
        assert_eq!(rect.size, wry::dpi::LogicalSize::new(1200.0, 800.0).into());
        assert_eq!(
            rect.position,
            wry::dpi::LogicalPosition::new(0.0, 0.0).into()
        );
        let rect = content_rect(tauri::PhysicalSize::new(1280, 720), 1.0);
        assert_eq!(rect.size, wry::dpi::LogicalSize::new(1280.0, 720.0).into());
    }

    #[test]
    fn stage_budgets_match_the_transition_script() {
        // The Rust side sleeps these between stages; the script's literals
        // are the animation lengths they cover.
        assert!(TRANSITION_JS.contains("const HOST_OUT_MS = 180;"));
        assert!(TRANSITION_JS.contains("const STAGGER_BUDGET_MS = 80;"));
        assert_eq!(HOST_OUT_MS, 180 + 80);
        assert!(TRANSITION_JS.contains("const LAUNCHER_OUT_MS = 160;"));
        assert_eq!(LAUNCHER_OUT_MS, 160);
        for stage in [
            "hostOut",
            "hostReset",
            "hostPrimeIn",
            "hostIn",
            "launcherPrimeIn",
            "launcherIn",
            "launcherOut",
            "launcherReset",
        ] {
            assert!(
                TRANSITION_JS.contains(&format!("    {stage}() {{")),
                "launcher_transition.js must define {stage}"
            );
        }
    }

    #[test]
    fn transition_selectors_are_the_pages_own() {
        // The gather animates the workspace app's panes and the fade the
        // launcher's mount node; a rename in either SPA must land here too.
        const PANE_SVELTE: &str =
            include_str!("../../../web/packages/workspace-app/src/components/Pane.svelte");
        const LAUNCHER_HTML: &str = include_str!("../../../web/packages/launcher/index.html");
        assert!(TRANSITION_JS.contains("querySelectorAll('.pane')"));
        assert!(PANE_SVELTE.contains("\n  class=\"pane\"\n"));
        assert!(TRANSITION_JS.contains("getElementById('app')"));
        assert!(LAUNCHER_HTML.contains("<div id=\"app\"></div>"));
    }

    #[test]
    fn one_transition_per_host_at_a_time() {
        let first = TransitionGuard::take("local::w-guard").expect("first take");
        assert!(TransitionGuard::take("local::w-guard").is_none());
        assert!(TransitionGuard::take("local::w-other").is_some());
        drop(first);
        assert!(TransitionGuard::take("local::w-guard").is_some());
    }

    /// The invoke names in a source: `tauriInvoke("…")` calls in the SPA's
    /// desktop module and `invoke('…'` calls in the key bridge.
    fn invoked(src: &str, needle: &str, quote: char) -> Vec<String> {
        src.match_indices(needle)
            .filter_map(|(at, _)| {
                let rest = &src[at + needle.len()..];
                rest.split_once(quote).map(|(name, _)| name.to_string())
            })
            .collect()
    }

    #[test]
    fn the_launcher_ipc_answers_every_invoke_the_launcher_makes() {
        const LAUNCHER_DESKTOP_TS: &str =
            include_str!("../../../web/packages/launcher/src/api/desktop.ts");
        let spa = invoked(LAUNCHER_DESKTOP_TS, "tauriInvoke(\"", '"');
        // Parser honesty: the module's own definition line spells the
        // function with a type parameter, so only real calls are found.
        assert_eq!(
            spa,
            vec!["restart_desktop_after_update", "request_app_quit"],
            "the launcher's invoke vocabulary changed; teach LauncherCommand the new command",
        );
        let bridge = invoked(LAUNCHER_BRIDGE_JS, "invoke('", '\'');
        assert_eq!(bridge, vec!["reload_window", "toggle_launcher_panel"]);
        for command in spa.iter().chain(bridge.iter()) {
            assert!(
                LauncherCommand::parse(command).is_some(),
                "the launcher invokes `{command}` but the in-window IPC does not answer it",
            );
        }
        assert_eq!(LauncherCommand::parse("open_devtools"), None);
        assert_eq!(LauncherCommand::parse("probe_url"), None);
    }

    #[test]
    fn every_event_the_launcher_listens_to_is_forwarded() {
        const LAUNCHER_APP: &str = include_str!("../../../web/packages/launcher/src/App.svelte");
        let mut listened: Vec<String> = LAUNCHER_APP
            .match_indices("onTauriEvent")
            .skip(1) // the import line
            .filter_map(|(at, _)| {
                let rest = &LAUNCHER_APP[at..];
                let open = rest.find('"')?;
                let name = &rest[open + 1..];
                name.split_once('"').map(|(name, _)| name.to_string())
            })
            .collect();
        listened.sort();
        let mut forwarded: Vec<String> = FORWARDED_EVENTS.iter().map(|e| e.to_string()).collect();
        forwarded.sort();
        assert_eq!(listened, forwarded);
    }

    #[test]
    fn the_ipc_shim_stands_in_for_the_tauri_calls_the_launcher_makes() {
        // api/desktop.ts reaches `__TAURI__.core.invoke` and
        // `__TAURI__.event.listen`, and reads an event's `payload`.
        assert!(
            LAUNCHER_IPC_JS.contains("window.__TAURI__ = { core: { invoke }, event: { listen } };")
        );
        assert!(LAUNCHER_IPC_JS.contains("handler({ event, payload });"));
        assert!(LAUNCHER_IPC_JS.contains("window.ipc.postMessage("));
        assert!(LAUNCHER_IPC_JS.contains("    settle(id, ok, value) {"));
    }

    #[test]
    fn the_launcher_lives_inside_its_host_window() {
        // A second webview in the host's own native window, never a window
        // of its own: built with wry against the host, and never through a
        // Tauri window builder. concat! so the pins don't match this test.
        const LAUNCHER_PANEL_RS: &str = include_str!("launcher_panel.rs");
        let (production, _) = LAUNCHER_PANEL_RS
            .split_once("\n#[cfg(test)]\nmod tests {")
            .expect("the test module separates the production code");
        assert!(!production.contains(concat!("WebviewWindow", "Builder")));
        assert!(production.contains(concat!(".build_as_child", "(host)")));
        assert!(production.contains(concat!(".build_gtk", "(&vbox)")));
    }

    #[test]
    fn launcher_bridge_claims_reload_and_the_ctrl_shift_toggle_only() {
        assert!(LAUNCHER_BRIDGE_JS.contains("invoke('reload_window'"));
        assert!(LAUNCHER_BRIDGE_JS.contains("invoke('toggle_launcher_panel'"));
        assert!(LAUNCHER_BRIDGE_JS.contains("key === 'p' && e.shiftKey && !e.metaKey"));
    }
}
