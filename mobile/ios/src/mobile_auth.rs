//! The single-webview auth surface: the OAuth callback the authentication
//! session captures, the devserver open that navigates the one webview, and
//! the app-lifecycle observer that pauses roster polling.
//!
//! The desktop answers its OAuth callback on a loopback listener and opens
//! each devserver tenant in a window of its own. This module carries the
//! mobile shape: `/mobile/authorize` (`mobile.account` scope) runs in an
//! `ASWebAuthenticationSession` sheet, the session intercepts the
//! `chan://auth/callback` navigation in-process, and the captured query
//! settles through [`crate::auth`] (`POST /mobile/authorize/redeem`, with
//! unkept tokens self-revoked via `DELETE /mobile/v1/token`). Opening a
//! rostered devserver mints the window record, reinstalls the gateway
//! session cookies (each install returns only after the cookie store
//! confirms), and navigates the single webview to the tenant URL;
//! back-to-Computers navigates it home.
//!
//! The HTTP bridge callbacks that open devservers carry no app handle, so app
//! boot setup (`ios.rs`) stashes one here (`stash_mobile_app_handle`); opens
//! refuse until setup completes. Roster polling pauses while the app is
//! backgrounded through an `NSNotificationCenter` observer registered from
//! app boot setup (`ensure_mobile_lifecycle_observer`); the OS would freeze
//! the timers anyway, and the foreground transition resyncs immediately
//! instead of waiting out the poll period.

use std::sync::{Arc, OnceLock};

use tauri::Manager;

use crate::gateway::GatewayAttempt;

/// The OAuth callback the mobile leg sends to `/mobile/authorize` as
/// `redirect_uri` and the authentication session intercepts. Exact value,
/// allowlisted on the gateway's mobile authorize flow with `mobile.account`
/// scope, PKCE, and `/mobile/authorize/redeem`.
pub(crate) const MOBILE_REDIRECT_URI: &str = "chan://auth/callback";

/// The callback scheme the authentication session watches for.
pub(crate) const MOBILE_CALLBACK_SCHEME: &str = "chan";

/// The query of a captured mobile callback URL, after pinning the URL to the
/// exact callback shape. Parsed-part equality, the way the gateway pins the
/// loopback form: a username, a port, or another host or path is a different
/// URL, not this callback. The query itself is untrusted input for the slot
/// classify; a missing one classifies as a mismatch there, never here.
pub(crate) fn mobile_callback_query(callback_url: &str) -> Result<String, String> {
    let url = url::Url::parse(callback_url)
        .map_err(|_| "the sign-in answer was not a URL".to_string())?;
    if url.scheme() != "chan" {
        return Err("the sign-in answer names another scheme".to_string());
    }
    if url.host_str() != Some("auth") {
        return Err("the sign-in answer names another host".to_string());
    }
    if url.path() != "/callback" {
        return Err("the sign-in answer names another path".to_string());
    }
    if url.port().is_some() || !url.username().is_empty() || url.password().is_some() {
        return Err("the sign-in answer carries authority this callback never has".to_string());
    }
    Ok(url.query().unwrap_or_default().to_string())
}

/// What the authentication session answered with: exactly one arm fires
/// per presentation. Shared so host tests drive the mapping the forwarder
/// runs on device.
pub(crate) enum MobileAuthOutcome {
    CallbackUrl(String),
    Cancelled,
    Failed(String),
}

/// Where a captured callback URL settles: the validated query, or a fail
/// carrying the reason. A URL that is not the callback fails the live slot
/// loudly instead of ignoring it: the sheet just vanished, and silence
/// would strand the user on a Connecting row.
pub(crate) enum MobileCallbackAction {
    Settle(String),
    Fail(String),
}

pub(crate) fn mobile_callback_action(callback_url: &str) -> MobileCallbackAction {
    match mobile_callback_query(callback_url) {
        Ok(query) => MobileCallbackAction::Settle(query),
        Err(error) => MobileCallbackAction::Fail(format!("sign-in failed in the browser: {error}")),
    }
}

/// Settle a session outcome through the exact desktop paths: a captured
/// callback settles or fails by shape, a dismissal fails as a browser
/// cancel, and any other failure fails with the system's words.
pub(crate) fn settle_mobile_outcome<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    gateway_id: &str,
    attempt: &Arc<GatewayAttempt>,
    outcome: MobileAuthOutcome,
) {
    match outcome {
        MobileAuthOutcome::CallbackUrl(url) => match mobile_callback_action(&url) {
            MobileCallbackAction::Settle(query) => {
                crate::auth::settle_mobile_query(app, gateway_id, attempt, &query);
            }
            MobileCallbackAction::Fail(message) => {
                crate::auth::fail_mobile_signin(app, gateway_id, attempt, message);
            }
        },
        MobileAuthOutcome::Cancelled => crate::auth::fail_mobile_signin(
            app,
            gateway_id,
            attempt,
            "sign-in was cancelled in the browser".to_string(),
        ),
        MobileAuthOutcome::Failed(message) => {
            crate::auth::fail_mobile_signin(app, gateway_id, attempt, message);
        }
    }
}

/// The app handle app boot setup (`ios.rs`) stashes for the bridge-open path,
/// which runs without one. Set once; an open before setup completes refuses
/// instead of navigating nowhere.
static MOBILE_APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Stash the app handle bridge opens navigate through. Idempotent: app boot
/// setup sets it once and any repeat call carries the same handle.
pub(crate) fn stash_mobile_app_handle(app: &tauri::AppHandle) {
    let _ = MOBILE_APP.set(app.clone());
}

pub(crate) fn mobile_app_handle() -> Option<tauri::AppHandle> {
    MOBILE_APP.get().cloned()
}

/// The connected gateway-backed connection `id` names, for a mobile open.
/// Anything else refuses with its reason: an unknown id is not connected, and
/// a direct (non-gateway) devserver has no entry exchange to navigate through
/// on this build.
pub(crate) fn mobile_gateway_conn(
    conns: &crate::devserver::DevserverConns,
    id: &str,
) -> Result<crate::devserver::DevserverConn, String> {
    let conn = conns
        .get(id)
        .ok_or_else(|| "devserver is not connected".to_string())?;
    if conn.gateway.is_none() {
        return Err(
            "opening a direct devserver is not supported on this build; connect through a gateway"
                .to_string(),
        );
    }
    Ok(conn)
}

/// Build the navigation URL for a remote window on `"main"`, stamping the
/// boot query parameters (`w`, `h`, `client_name`, `kind`, `seed`, `start`,
/// `lib`, `pane`) expected by `workspace-app`.
pub(crate) fn mobile_window_target_url(
    state: &crate::AppState,
    base_url: &str,
    record: &chan_server::WindowRecord,
    holder: Option<&str>,
) -> Result<url::Url, String> {
    let mut parsed = url::Url::parse(base_url).map_err(|e| format!("devserver target URL: {e}"))?;
    if parsed.query_pairs().any(|(key, _)| key == "client_name") {
        let retained = parsed
            .query_pairs()
            .filter(|(key, _)| key != "client_name")
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect::<Vec<_>>();
        parsed.set_query(None);
        if !retained.is_empty() {
            parsed.query_pairs_mut().extend_pairs(retained);
        }
    }
    if holder.is_some() {
        let name = state
            .store
            .lock()
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| e.to_string())?
            .client_session_name;
        if !name.is_empty() {
            parsed.query_pairs_mut().append_pair("client_name", &name);
        }
    }
    parsed.query_pairs_mut().append_pair("w", &record.window_id);
    if let Some(holder) = holder {
        parsed.query_pairs_mut().append_pair("h", holder);
    }
    match record.kind {
        chan_server::WindowKind::Terminal => {
            let kind = if record.control {
                "control"
            } else {
                "terminal"
            };
            parsed.query_pairs_mut().append_pair("kind", kind);
            if record.tmux.is_some() {
                parsed.query_pairs_mut().append_pair("seed", "0");
            }
        }
        chan_server::WindowKind::Workspace => {
            if record.start_terminal {
                parsed.query_pairs_mut().append_pair("start", "terminal");
            }
        }
    }
    if !record.library_id.is_empty() {
        parsed
            .query_pairs_mut()
            .append_pair("lib", &record.library_id);
        let pane = state
            .embedded()
            .and_then(|embedded| embedded.pane_color(&record.library_id))
            .or_else(|| {
                chan_server::DevserverFeedSource::pane_color(
                    &*state.devserver_feed,
                    &record.library_id,
                )
            });
        if let Some(color) = pane {
            parsed.query_pairs_mut().append_pair("pane", &color);
        }
    }
    Ok(parsed)
}

fn record_last_remote_origin(state: &crate::AppState, url: &url::Url, id: &str) {
    *state.last_remote_origin.lock().unwrap() =
        Some((url.origin().ascii_serialization(), id.to_string()));
}

/// Open a rostered devserver in the single webview: mint the window record,
/// refresh the feed, resolve the tenant URL through a validated entry
/// exchange, reinstall the gateway session cookies (the install returns only
/// after the cookie store confirms both), stamp the boot query parameters, and
/// navigate.
pub(crate) async fn mobile_open_devserver(
    state: &Arc<crate::AppState>,
    id: &str,
    kind: chan_server::WindowKind,
    path: Option<String>,
    start_terminal: bool,
) -> Result<(), String> {
    let app = mobile_app_handle()
        .ok_or_else(|| "the mobile app handle is not ready; connect again".to_string())?;
    mobile_open_devserver_with_app(&app, state, id, kind, path, start_terminal).await
}

pub(crate) async fn mobile_open_devserver_with_app<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<crate::AppState>,
    id: &str,
    kind: chan_server::WindowKind,
    path: Option<String>,
    start_terminal: bool,
) -> Result<(), String> {
    let conn = mobile_gateway_conn(&state.devservers, id)?;
    let epoch = conn
        .gateway
        .as_ref()
        .map(|gateway| gateway.begin_operation())
        .transpose()?
        .flatten();
    let record =
        crate::devserver::mint_library_window_with_start(&conn, kind, path, start_terminal).await?;
    if let Err(error) = crate::refresh_devserver_windows(state, id, &conn).await {
        tracing::warn!(devserver = %id, %error, "refreshing devserver windows after mint failed");
    }
    let target = crate::devserver::window_navigation_url(&conn, &record).await?;
    if let Some(gateway) = &conn.gateway {
        gateway.require_operation(epoch)?;
    }
    crate::devserver::install_gateway_webview_session(app, &conn, None)?;
    let url =
        mobile_window_target_url(state, &target, &record, crate::serve::desktop_holder_tag())?;
    record_last_remote_origin(state, &url, id);
    let webview = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().into_values().next())
        .ok_or_else(|| "no webview to open the devserver in".to_string())?;
    let res = crate::wireguard::navigate(app, state, id, &conn, webview, url, epoch).await;
    if res.is_err() {
        state.last_remote_origin.lock().unwrap().take();
    }
    res
}

/// Navigate `"main"` to an already-existing remote window record on a connected
/// gateway devserver, unhiding it if hidden and reinstalling the WebView
/// session cookies first.
pub(crate) async fn mobile_open_existing_window(
    state: &Arc<crate::AppState>,
    id: &str,
    record: &chan_server::WindowRecord,
) -> Result<(), String> {
    let app = mobile_app_handle()
        .ok_or_else(|| "the mobile app handle is not ready; connect again".to_string())?;
    mobile_open_existing_window_with_app(&app, state, id, record).await
}

pub(crate) async fn mobile_open_existing_window_with_app<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<crate::AppState>,
    id: &str,
    record: &chan_server::WindowRecord,
) -> Result<(), String> {
    let conn = mobile_gateway_conn(&state.devservers, id)?;
    let epoch = conn
        .gateway
        .as_ref()
        .map(|gateway| gateway.begin_operation())
        .transpose()?
        .flatten();
    if record.hidden {
        crate::devserver::set_window_visibility(&conn, &record.window_id, false).await?;
        if let Some(gateway) = &conn.gateway {
            gateway.require_operation(epoch)?;
        }
        if let Err(error) = crate::refresh_devserver_windows(state, id, &conn).await {
            tracing::warn!(devserver = %id, %error, "refreshing devserver windows after unhide failed");
        }
    }
    let target = crate::devserver::window_navigation_url(&conn, record).await?;
    if let Some(gateway) = &conn.gateway {
        gateway.require_operation(epoch)?;
    }
    crate::devserver::install_gateway_webview_session(app, &conn, None)?;
    let url = mobile_window_target_url(state, &target, record, crate::serve::desktop_holder_tag())?;
    record_last_remote_origin(state, &url, id);
    let webview = app
        .get_webview_window("main")
        .ok_or_else(|| "no main webview to open the devserver in".to_string())?;
    let res = crate::wireguard::navigate(app, state, id, &conn, webview, url, epoch).await;
    if res.is_err() {
        state.last_remote_origin.lock().unwrap().take();
    }
    res
}

/// The loopback launcher URL back-to-Computers navigates home to: the
/// embedded library's root carrying its per-launch bearer token, the same URL
/// the single webview boots on.
pub(crate) fn mobile_launcher_url(state: &crate::AppState) -> Result<url::Url, String> {
    let embedded = state
        .embedded()
        .ok_or_else(|| "the local library is not running".to_string())?;
    launcher_url_for_addr(embedded.addr(), embedded.launcher_token())
}

/// The launcher root URL for an embedded loopback address and bearer token.
pub(crate) fn launcher_url_for_addr(
    addr: std::net::SocketAddr,
    token: &str,
) -> Result<url::Url, String> {
    url::Url::parse_with_params(&format!("http://{addr}/"), &[("t", token)])
        .map_err(|e| format!("launcher URL: {e}"))
}

/// Navigate `window` back to the loopback launcher URL, clearing active
/// WireGuard selection and remote-origin tracking.
pub(crate) fn navigate_main_to_launcher<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    state: &crate::AppState,
) -> Result<(), String> {
    let url = mobile_launcher_url(state)?;
    state
        .navigation_epoch
        .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    state.selected_wireguard.lock().unwrap().take();
    state.last_remote_origin.lock().unwrap().take();
    window
        .navigate(url)
        .map_err(|e| format!("returning to Computers: {e}"))?;
    Ok(())
}

/// Back to Computers: re-navigate the invoking webview to the loopback
/// launcher URL. Registered on the mobile build only; the native affordance
/// that invokes it lives in the app scaffold.
#[tauri::command]
pub(crate) fn mobile_back_to_computers(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<crate::AppState>>,
) -> Result<(), String> {
    navigate_main_to_launcher(&window, state.inner())
}

#[cfg(target_os = "ios")]
pub(crate) use ios::{ensure_mobile_lifecycle_observer, start_mobile_signin};

/// The authentication session plus the app-lifecycle observer. Both are
/// platform objects that exist on the mobile target only; the shared settle,
/// open, and roster entry points above stay platform-free so host tests drive
/// them.
#[cfg(target_os = "ios")]
mod ios {
    use std::ptr::NonNull;
    use std::sync::{Arc, Mutex, OnceLock};

    use block2::RcBlock;
    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol};
    use objc2::{
        class, define_class, extern_methods, msg_send, sel, AnyThread, DefinedClass,
        MainThreadMarker,
    };
    use objc2_foundation::{NSError, NSNotification, NSNotificationCenter, NSString, NSURL};
    use tokio::sync::watch;

    use crate::gateway::GatewayAttempt;

    use super::{MobileAuthOutcome, MOBILE_CALLBACK_SCHEME};

    #[link(name = "AuthenticationServices", kind = "framework")]
    extern "C" {}

    /// Start the sign-in sheet for the pending slot's authorize URL, on the
    /// main thread. The session completion forwards into the exact desktop
    /// settle; a slot shutdown (expiry, re-click, cancel) cancels the sheet.
    /// A start failure fails the live slot directly, since no completion will
    /// ever fire for it; the caller clears the rest on `Err`.
    pub(crate) fn start_mobile_signin<R: tauri::Runtime>(
        app: &tauri::AppHandle<R>,
        authorize_url: &str,
        gateway_id: &str,
        attempt: &Arc<GatewayAttempt>,
        shutdown: watch::Receiver<bool>,
    ) -> Result<(), String> {
        let (outcome_tx, outcome_rx) = tokio::sync::oneshot::channel();
        {
            let app = app.clone();
            let gateway_id = gateway_id.to_string();
            let attempt = Arc::clone(attempt);
            tauri::async_runtime::spawn(async move {
                let outcome = outcome_rx.await.unwrap_or(MobileAuthOutcome::Failed(
                    "the sign-in sheet closed without an answer".to_string(),
                ));
                // Release on the main thread: the drop may deallocate the
                // session. Independent of the settle below either way.
                let release = {
                    let gateway_id = gateway_id.clone();
                    let attempt = Arc::clone(&attempt);
                    move || release_mobile_session_for(&gateway_id, &attempt)
                };
                let _ = app.run_on_main_thread(release);
                super::settle_mobile_outcome(app, &gateway_id, &attempt, outcome);
            });
        }
        {
            let app = app.clone();
            let gateway_id = gateway_id.to_string();
            let attempt = Arc::clone(attempt);
            tauri::async_runtime::spawn(async move {
                let mut shutdown = shutdown;
                let _ = shutdown.changed().await;
                let _ = app.run_on_main_thread(move || {
                    cancel_mobile_session_for(&gateway_id, &attempt);
                });
            });
        }
        let start = {
            let gateway_id = gateway_id.to_string();
            let attempt = Arc::clone(attempt);
            let authorize_url = authorize_url.to_string();
            move || {
                let outcome_tx = Arc::new(Mutex::new(Some(outcome_tx)));
                if let Err(error) = start_mobile_session(
                    &authorize_url,
                    &gateway_id,
                    &attempt,
                    Arc::clone(&outcome_tx),
                ) {
                    if let Some(tx) = outcome_tx.lock().unwrap().take() {
                        let _ = tx.send(MobileAuthOutcome::Failed(error));
                    }
                }
            }
        };
        app.run_on_main_thread(start)
            .map_err(|e| format!("starting the sign-in sheet: {e}"))?;
        Ok(())
    }

    /// The presented session object. Neither `AnyObject` nor a plain
    /// pointer to it carries `Send`, so the pointer rides a wrapper whose
    /// `Send` holds by main-thread confinement: every store, message, and
    /// reclaim runs on the main thread.
    struct MainSession(NonNull<AnyObject>);

    // SAFETY: main-thread confinement, as above; the holder is touched from
    // the main thread at the start and from main-dispatched closures for
    // cancel and release.
    unsafe impl Send for MainSession {}

    /// A presented session plus its provider (the provider property is weak,
    /// so both are retained here) and the attempt they belong to, so a stale
    /// shutdown or completion can never cancel or release a successor's. The
    /// holder owns the session's +1 from init, and cancel plus release
    /// reclaim exactly once.
    struct MobileSession {
        session: MainSession,
        _provider: Retained<MobileAuthPresentationProvider>,
        gateway_id: String,
        attempt: Arc<GatewayAttempt>,
    }

    static MOBILE_SESSION: Mutex<Option<MobileSession>> = Mutex::new(None);

    fn mobile_session_matches(
        presented: &MobileSession,
        gateway_id: &str,
        attempt: &Arc<GatewayAttempt>,
    ) -> bool {
        presented.gateway_id == gateway_id && Arc::ptr_eq(&presented.attempt, attempt)
    }

    /// Cancel this attempt's sheet, if it still owns the holder. Main thread
    /// only, like the start.
    fn cancel_mobile_session_for(gateway_id: &str, attempt: &Arc<GatewayAttempt>) {
        let mut holder = MOBILE_SESSION.lock().unwrap();
        if holder
            .as_ref()
            .is_some_and(|presented| mobile_session_matches(presented, gateway_id, attempt))
        {
            if let Some(presented) = holder.take() {
                // SAFETY: the holder owns this +1 and the object is alive
                // here; the reclaim below releases exactly once.
                unsafe {
                    let session = &*presented.session.0.as_ptr();
                    let _: () = msg_send![session, cancel];
                    drop(Retained::from_raw(presented.session.0.as_ptr()));
                }
            }
        }
    }

    /// Release this attempt's sheet after its completion fired, if it still
    /// owns the holder. A successor's presentation survives its
    /// predecessor's late answer. Main thread only: the drop may deallocate.
    fn release_mobile_session_for(gateway_id: &str, attempt: &Arc<GatewayAttempt>) {
        let mut holder = MOBILE_SESSION.lock().unwrap();
        if holder
            .as_ref()
            .is_some_and(|presented| mobile_session_matches(presented, gateway_id, attempt))
        {
            if let Some(presented) = holder.take() {
                // SAFETY: same ownership as the cancel path; the drop
                // releases the +1 init handed over.
                drop(unsafe { Retained::from_raw(presented.session.0.as_ptr()) });
            }
        }
    }

    /// Build and start the session. Main thread only; the completion crosses
    /// to the forwarder task through the outcome sender.
    fn start_mobile_session(
        authorize_url: &str,
        gateway_id: &str,
        attempt: &Arc<GatewayAttempt>,
        outcome_tx: Arc<Mutex<Option<tokio::sync::oneshot::Sender<MobileAuthOutcome>>>>,
    ) -> Result<(), String> {
        if MainThreadMarker::new().is_none() {
            return Err("the sign-in sheet starts on the main thread only".to_string());
        }
        let url = NSURL::URLWithString(&NSString::from_str(authorize_url))
            .ok_or_else(|| "building the authorize URL".to_string())?;
        let scheme = NSString::from_str(MOBILE_CALLBACK_SCHEME);
        // The completion answers exactly once with a callback URL or an
        // error; every capture is Send, and the outcome crosses to the
        // forwarder task. The block never panics: a panic here would unwind
        // through ObjC.
        let completion = RcBlock::new(move |callback_url: *mut NSURL, error: *mut NSError| {
            let outcome = read_session_outcome(callback_url, error);
            if let Some(tx) = outcome_tx.lock().unwrap().take() {
                let _ = tx.send(outcome);
            }
        });
        let provider = MobileAuthPresentationProvider::new();
        // SAFETY: the session's designated initializer; the session copies
        // (retains) the block, and the holder retains the session plus the
        // provider until the completion or a shutdown cancel releases them.
        let allocated: Allocated<AnyObject> =
            unsafe { msg_send![class!(ASWebAuthenticationSession), alloc] };
        if Allocated::as_ptr(&allocated).is_null() {
            return Err("allocating the sign-in sheet".to_string());
        }
        let session: Retained<AnyObject> = unsafe {
            msg_send![allocated, initWithURL: &*url, callbackURLScheme: &*scheme, completionHandler: &*completion]
        };
        unsafe {
            let _: () = msg_send![&session, setPresentationContextProvider: &*provider];
        }
        let started: bool = unsafe { msg_send![&session, start] };
        if !started {
            return Err("the sign-in sheet refused to start".to_string());
        }
        MOBILE_SESSION.lock().unwrap().replace(MobileSession {
            // The +1 from init transfers into the holder; cancel and release
            // reclaim it exactly once. Non-null by construction from a live
            // object.
            session: MainSession(
                NonNull::new(Retained::into_raw(session)).expect("a live session"),
            ),
            _provider: provider,
            gateway_id: gateway_id.to_string(),
            attempt: Arc::clone(attempt),
        });
        Ok(())
    }

    /// Read the session completion into an outcome. The objects are alive for
    /// the call, which is the only time they are touched.
    fn read_session_outcome(callback_url: *mut NSURL, error: *mut NSError) -> MobileAuthOutcome {
        if !callback_url.is_null() {
            let url = unsafe { &*callback_url };
            match url.absoluteString() {
                Some(answer) => return MobileAuthOutcome::CallbackUrl(answer.to_string()),
                None => {
                    return MobileAuthOutcome::Failed(
                        "the sign-in sheet answered without a URL".to_string(),
                    );
                }
            }
        }
        if error.is_null() {
            return MobileAuthOutcome::Failed("the sign-in sheet answered nothing".to_string());
        }
        let error = unsafe { &*error };
        let domain = error.domain().to_string();
        // ASWebAuthenticationSessionErrorCodeCanceledLogin: the user dismissed
        // the sheet. Every other error fails the slot with the system's words.
        if domain == "com.apple.AuthenticationServices.WebAuthenticationSession"
            && error.code() == 1
        {
            return MobileAuthOutcome::Cancelled;
        }
        MobileAuthOutcome::Failed(format!(
            "sign-in failed in the browser: {} ({domain} {})",
            error.localizedDescription(),
            error.code(),
        ))
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and the provider
        // holds no ivars and implements no Drop.
        #[unsafe(super(NSObject))]
        struct MobileAuthPresentationProvider;

        unsafe impl NSObjectProtocol for MobileAuthPresentationProvider {}

        impl MobileAuthPresentationProvider {
            /// The window the sheet presents from: the key window of the
            /// foreground-active window scene, else its first window. Null
            /// when no scene answers, and the session then fails through
            /// the completion instead of presenting nowhere.
            #[unsafe(method(presentationAnchorForWebAuthenticationSession:))]
            fn presentation_anchor(&self, _session: *mut AnyObject) -> *mut AnyObject {
                // Scene lookup: the app is scene-based, where the legacy
                // shared-application windows answer nil. All public API.
                let app: *mut AnyObject =
                    unsafe { msg_send![class!(UIApplication), sharedApplication] };
                if app.is_null() {
                    return std::ptr::null_mut();
                }
                // SAFETY: the application is non-null per the check above and
                // alive for the process; every object below is autoreleased
                // and used immediately on this main-thread call.
                unsafe {
                    let app = &*app;
                    let scenes: *mut AnyObject = msg_send![app, connectedScenes];
                    if scenes.is_null() {
                        return std::ptr::null_mut();
                    }
                    let scenes: *mut AnyObject = msg_send![&*scenes, allObjects];
                    if scenes.is_null() {
                        return std::ptr::null_mut();
                    }
                    let scenes = &*scenes;
                    let count: usize = msg_send![scenes, count];
                    for index in 0..count {
                        let scene: *mut AnyObject = msg_send![scenes, objectAtIndex: index];
                        if scene.is_null() {
                            continue;
                        }
                        let scene = &*scene;
                        // Foreground-active scenes only (0); the rest cannot
                        // present.
                        let state: isize = msg_send![scene, activationState];
                        if state != 0 {
                            continue;
                        }
                        // A scene of any other kind has no windows; ask
                        // instead of assuming the class.
                        let has_windows: bool =
                            msg_send![scene, respondsToSelector: sel!(windows)];
                        if !has_windows {
                            continue;
                        }
                        let windows: *mut AnyObject = msg_send![scene, windows];
                        if windows.is_null() {
                            continue;
                        }
                        let windows = &*windows;
                        let windows_count: usize = msg_send![windows, count];
                        let mut first: *mut AnyObject = std::ptr::null_mut();
                        for window_index in 0..windows_count {
                            let window: *mut AnyObject =
                                msg_send![windows, objectAtIndex: window_index];
                            if window.is_null() {
                                continue;
                            }
                            if first.is_null() {
                                first = window;
                            }
                            let is_key: bool = msg_send![&*window, isKeyWindow];
                            if is_key {
                                return window;
                            }
                        }
                        if !first.is_null() {
                            return first;
                        }
                    }
                    std::ptr::null_mut()
                }
            }
        }
    );

    impl MobileAuthPresentationProvider {
        extern_methods!(
            // SAFETY: `new` allocates and runs NSObject's designated
            // initializer; the provider holds no ivars.
            #[unsafe(method(new))]
            fn new() -> Retained<Self>;
        );
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and the observer
        // holds no Drop ivars; the handles drop with it, on no fixed thread,
        // which both tolerate.
        #[unsafe(super(NSObject))]
        #[ivars = (tauri::AppHandle, Arc<crate::AppState>)]
        struct MobileLifecycleObserver;

        unsafe impl NSObjectProtocol for MobileLifecycleObserver {}

        impl MobileLifecycleObserver {
            #[unsafe(method(mobileAppDidEnterBackground:))]
            fn did_enter_background(&self, _notification: &NSNotification) {
                if let Some(fabric) = self.ivars().1.gateway_manager.fabric.get() { fabric.suspend(); }
                crate::gateway::set_roster_poll_suspended(&self.ivars().1, true);
            }

            #[unsafe(method(mobileAppWillEnterForeground:))]
            fn will_enter_foreground(&self, _notification: &NSNotification) {
                let (app, state) = self.ivars().clone();
                let ticket = state.gateway_manager.fabric.get().map(|fabric| fabric.resume_ticket());
                tauri::async_runtime::spawn(async move {
                    let ready = resume_wireguard(&state, ticket).await;
                    if let (Some(fabric), Some(ticket)) = (state.gateway_manager.fabric.get(), ticket) {
                        if fabric.resume_ticket() != ticket { return; }
                        if !fabric.resume(ticket) { return; }
                    }
                    if let Err(error) = ready { tracing::warn!(%error, "foreground WireGuard access remains parked"); }
                    // Public identity polling also serves gateways without WireGuard.
                    crate::gateway::set_roster_poll_suspended(&state, false);
                    crate::gateway::resync_roster_polls(&app, &state);
                });
            }
        }
    );

    async fn resume_wireguard(state: &crate::AppState, ticket: Option<u64>) -> Result<(), String> {
        let (Some(fabric), Some(ticket)) = (state.gateway_manager.fabric.get(), ticket) else {
            return Ok(());
        };
        let ids = state
            .store
            .lock()
            .unwrap()
            .get()
            .map_err(|error| error.to_string())?
            .gateways
            .into_iter()
            .filter(|gateway| gateway.enabled)
            .map(|gateway| gateway.id)
            .collect::<Vec<_>>();
        let mut refused = None;
        for id in ids {
            let result = async {
                fabric.settled_gateway(&id).await?;
                crate::wireguard::reconcile_saved(state, &id)?;
                fabric.settled_gateway(&id).await
            }
            .await;
            match result {
                Ok(()) => {
                    if !fabric.resume_gateway(&id, ticket) {
                        return Err("WireGuard: foreground attempt superseded".into());
                    }
                }
                Err(error) => {
                    tracing::warn!(gateway = %id, %error, "gateway foreground recovery refused");
                    refused = Some(error);
                }
            }
        }
        match refused {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    impl MobileLifecycleObserver {
        fn new(app: tauri::AppHandle, state: Arc<crate::AppState>) -> Retained<Self> {
            let this = Self::alloc().set_ivars((app, state));
            // SAFETY: NSObject's designated initializer, sent once to a
            // freshly allocated object whose ivars are set.
            unsafe { msg_send![super(this), init] }
        }
    }

    static MOBILE_LIFECYCLE_REGISTER: Mutex<()> = Mutex::new(());
    static MOBILE_LIFECYCLE: OnceLock<Retained<MobileLifecycleObserver>> = OnceLock::new();

    /// Observe background and foreground transitions once per process,
    /// registered from app boot setup (`ios.rs`). Any thread may register;
    /// the callbacks only flip the poll flag and spawn resync ticks.
    pub(crate) fn ensure_mobile_lifecycle_observer(
        app: &tauri::AppHandle,
        state: &Arc<crate::AppState>,
    ) {
        let _register = MOBILE_LIFECYCLE_REGISTER.lock().unwrap();
        if MOBILE_LIFECYCLE.get().is_some() {
            return;
        }
        let observer = MobileLifecycleObserver::new(app.clone(), Arc::clone(state));
        let center = NSNotificationCenter::defaultCenter();
        // The notification names as strings: the center matches names, so no
        // UIKit constants are needed to observe them.
        let background = NSString::from_str("UIApplicationDidEnterBackgroundNotification");
        let foreground = NSString::from_str("UIApplicationWillEnterForegroundNotification");
        // SAFETY: the observer answers both selectors, each taking the one
        // notification the center passes, and MOBILE_LIFECYCLE retains it for
        // the app's life, so no center messages a freed object.
        unsafe {
            center.addObserver_selector_name_object(
                &observer,
                sel!(mobileAppDidEnterBackground:),
                Some(&background),
                None,
            );
            center.addObserver_selector_name_object(
                &observer,
                sel!(mobileAppWillEnterForeground:),
                Some(&foreground),
                None,
            );
        }
        let _ = MOBILE_LIFECYCLE.set(observer);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callback_query_pins_the_exact_callback_shape() {
        assert_eq!(
            mobile_callback_query("chan://auth/callback?code=c1&state=s1").as_deref(),
            Ok("code=c1&state=s1"),
        );
        assert_eq!(
            mobile_callback_query("chan://auth/callback").as_deref(),
            Ok(""),
            "a missing query classifies downstream, never here",
        );
        assert_eq!(
            mobile_callback_query("chan://auth/callback?code=c1#frag").as_deref(),
            Ok("code=c1"),
            "a fragment is ignored; only the query classifies",
        );
        for url in [
            "https://auth/callback?code=c1",
            "chan://evil.example/callback?code=c1",
            "chan://auth@evil.example/callback?code=c1",
            "chan://auth:1/callback?code=c1",
            "chan://auth/callback/x?code=c1",
            "chan://auth/other?code=c1",
            "chan://auth?code=c1",
            "::::",
            "",
        ] {
            assert!(
                mobile_callback_query(url).is_err(),
                "{url:?} is not the mobile callback",
            );
        }
    }

    #[test]
    fn redirect_uri_is_the_registered_callback() {
        assert_eq!(MOBILE_REDIRECT_URI, "chan://auth/callback");
        assert_eq!(MOBILE_CALLBACK_SCHEME, "chan");
        assert!(
            mobile_callback_query(MOBILE_REDIRECT_URI).is_ok(),
            "the redirect we send parses as the callback we accept",
        );
    }

    fn direct_conn() -> crate::devserver::DevserverConn {
        crate::devserver::DevserverConn {
            host: "127.0.0.1".into(),
            port: 7000,
            token: "token".into(),
            name: "direct".into(),
            gateway: None,
        }
    }

    fn gateway_conn() -> crate::devserver::DevserverConn {
        let mut conn = direct_conn();
        conn.gateway = Some(Box::new(crate::devserver::GatewayConn::new(
            "https://id.example".into(),
            "https://id.example/mobile/v1/devserver/entry".into(),
            "https://owner--disc.proxy.example".into(),
            "chan_pat_x".into(),
        )));
        conn
    }

    #[test]
    fn mobile_open_takes_only_connected_gateway_backed_rows() {
        let conns = crate::devserver::DevserverConns::default();
        assert_eq!(
            mobile_gateway_conn(&conns, "gw:1").unwrap_err(),
            "devserver is not connected",
        );
        conns.set("direct".into(), direct_conn());
        assert!(mobile_gateway_conn(&conns, "direct")
            .unwrap_err()
            .contains("not supported on this build"),);
        conns.set("gw:1".into(), gateway_conn());
        let conn = mobile_gateway_conn(&conns, "gw:1").expect("gateway-backed row opens");
        assert!(conn.gateway.is_some());
    }

    #[test]
    fn launcher_url_format() {
        let addr: std::net::SocketAddr = "127.0.0.1:8471".parse().unwrap();
        assert_eq!(
            launcher_url_for_addr(addr, "tok-123").unwrap().as_str(),
            "http://127.0.0.1:8471/?t=tok-123"
        );
        assert_eq!(
            launcher_url_for_addr(addr, "a+b&c=d/e").unwrap().as_str(),
            "http://127.0.0.1:8471/?t=a%2Bb%26c%3Dd%2Fe",
            "bearer token query parameter must be URL-encoded"
        );
    }

    #[test]
    fn launcher_url_needs_the_embedded_library() {
        let (_dir, state) = crate::gateway::tests::pat_load_test_state("https://id.example");
        assert_eq!(
            mobile_launcher_url(&state).unwrap_err(),
            "the local library is not running",
        );
    }

    #[tokio::test]
    async fn mobile_open_refuses_before_app_setup_stashes_handle() {
        // App boot setup (ios.rs) stashes MOBILE_APP on iOS; in a host unit
        // test MOBILE_APP is unset, so the open refuses before touching the
        // connection.
        let (_dir, state) = crate::gateway::tests::pat_load_test_state("https://id.example");
        assert!(mobile_app_handle().is_none());
        let refused = mobile_open_devserver(
            &state,
            "gw:1",
            chan_server::WindowKind::Workspace,
            None,
            false,
        )
        .await
        .unwrap_err();
        assert!(
            refused.contains("not ready"),
            "an unstashed open names the missing handle: {refused}",
        );

        let record = chan_server::WindowRecord {
            window_id: "w-1".into(),
            library_id: "lib-1".into(),
            kind: chan_server::WindowKind::Workspace,
            title: "notes Window 1".into(),
            ordinal: 1,
            label: "notes".into(),
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
        };
        let refused_existing = mobile_open_existing_window(&state, "gw:1", &record)
            .await
            .unwrap_err();
        assert!(refused_existing.contains("not ready"), "{refused_existing}");
    }

    #[tokio::test]
    async fn mobile_open_existing_window_navigates_main_to_gateway_tenant_url() {
        let (_dir, state) = crate::gateway::tests::pat_load_test_state("https://id.example");
        let conn = gateway_conn();
        conn.gateway
            .as_ref()
            .unwrap()
            .seed_fresh_session_for_test("csrf-open");
        let record = chan_server::WindowRecord {
            window_id: "w-42".into(),
            library_id: "lib-99".into(),
            kind: chan_server::WindowKind::Workspace,
            title: "notes Window 1".into(),
            ordinal: 1,
            label: "notes".into(),
            workspace_path: Some("/srv/notes".into()),
            prefix: "/api/notes-1a2b3c".into(),
            token: "unused-on-gateway".into(),
            persisted: true,
            connected: true,
            holders: None,
            active_transfer: false,
            control: false,
            tmux: None,
            hidden: false,
            origin: chan_server::WindowOrigin::Native,
            start_terminal: false,
        };

        let app = tauri::test::mock_app();
        // Refuses when disconnected.
        assert_eq!(
            mobile_open_existing_window_with_app(app.handle(), &state, "gw:1", &record)
                .await
                .unwrap_err(),
            "devserver is not connected"
        );

        state.devservers.set("gw:1".into(), conn);
        // Refuses when main webview does not exist.
        assert!(
            mobile_open_existing_window_with_app(app.handle(), &state, "gw:1", &record)
                .await
                .unwrap_err()
                .contains("no main webview")
        );

        let main = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External("http://127.0.0.1:8471/?t=boot".parse().unwrap()),
        )
        .build()
        .expect("mock main webview");

        mobile_open_existing_window_with_app(app.handle(), &state, "gw:1", &record)
            .await
            .expect("existing gateway window opens in main");
        let navigated = main.url().unwrap();
        assert_eq!(
            format!(
                "{}{}",
                navigated.origin().ascii_serialization(),
                navigated.path()
            ),
            "https://owner--disc.proxy.example/api/notes-1a2b3c/index.html"
        );
        let pairs: std::collections::HashMap<String, String> =
            navigated.query_pairs().into_owned().collect();
        assert_eq!(pairs.get("w").map(String::as_str), Some("w-42"));
        assert_eq!(pairs.get("lib").map(String::as_str), Some("lib-99"));
        assert_eq!(pairs.get("kind"), None);
        assert_eq!(pairs.get("seed"), None);
        assert_eq!(pairs.get("start"), None);
        assert_eq!(
            pairs.get("h").map(String::as_str),
            crate::serve::desktop_holder_tag()
        );
        assert_eq!(
            state.last_remote_origin.lock().unwrap().as_ref(),
            Some(&(
                "https://owner--disc.proxy.example".to_string(),
                "gw:1".to_string()
            ))
        );
    }

    /// Settle a mobile query against a live slot through the real
    /// [`crate::auth::settle_mobile_query`], holding the slot lock the
    /// desktop callback tests serialize on.
    async fn settle_against_test_slot(query: &str) -> bool {
        let _serial = crate::auth::tests::SLOT_TEST_LOCK.lock().await;
        let attempt = Arc::new(GatewayAttempt::default());
        crate::auth::tests::install_pending_for_test("gw-mobile", &attempt);
        let (_dir, state) = crate::gateway::tests::pat_load_test_state("https://id.example");
        let app = tauri::test::mock_app();
        app.manage(state);
        crate::auth::settle_mobile_query(app.handle().clone(), "gw-mobile", &attempt, query);
        // The spawned settle runs detached; the slot verdict is synchronous.
        !crate::auth::tests::take_pending_for_test()
    }

    #[tokio::test]
    async fn mobile_query_consumes_the_slot_on_a_state_match() {
        // The error arm, so no redeem runs: classify plus take plus the
        // spawned settle are what this proves, and the redeem is the shared
        // desktop path with its own tests.
        assert!(
            settle_against_test_slot("error=user_cancelled&state=cancel-test").await,
            "a matching mobile query consumes the slot",
        );
    }

    #[tokio::test]
    async fn mobile_query_ignores_a_mismatch_and_leaves_the_slot() {
        assert!(
            !settle_against_test_slot("error=user_cancelled&state=wrong").await,
            "a state mismatch ignores without consuming",
        );
        let _serial = crate::auth::tests::SLOT_TEST_LOCK.lock().await;
        let attempt = Arc::new(GatewayAttempt::default());
        crate::auth::tests::install_pending_for_test("gw-mobile", &attempt);
        let (_dir, state) = crate::gateway::tests::pat_load_test_state("https://id.example");
        let app = tauri::test::mock_app();
        app.manage(state);
        crate::auth::settle_mobile_query(app.handle().clone(), "gw-other", &attempt, "code=c1");
        assert!(
            crate::auth::tests::take_pending_for_test(),
            "another id ignores without consuming",
        );
    }

    #[tokio::test]
    async fn mobile_fail_consumes_only_its_own_slot() {
        let _serial = crate::auth::tests::SLOT_TEST_LOCK.lock().await;
        let attempt = Arc::new(GatewayAttempt::default());
        crate::auth::tests::install_pending_for_test("gw-mobile", &attempt);
        let (_dir, state) = crate::gateway::tests::pat_load_test_state("https://id.example");
        let app = tauri::test::mock_app();
        app.manage(state);
        crate::auth::fail_mobile_signin(
            app.handle().clone(),
            "gw-other",
            &attempt,
            "sheet gone".into(),
        );
        assert!(
            crate::auth::tests::take_pending_for_test(),
            "a foreign fail leaves the slot",
        );
        crate::auth::tests::install_pending_for_test("gw-mobile", &attempt);
        crate::auth::fail_mobile_signin(
            app.handle().clone(),
            "gw-mobile",
            &attempt,
            "sheet gone".into(),
        );
        assert!(
            !crate::auth::tests::take_pending_for_test(),
            "a matching fail consumes the slot",
        );
    }

    #[test]
    fn malformed_callback_maps_to_a_fail_carrying_the_reason() {
        match mobile_callback_action("chan://auth/callback?code=c1&state=s1") {
            MobileCallbackAction::Settle(query) => {
                assert_eq!(query, "code=c1&state=s1");
            }
            MobileCallbackAction::Fail(message) => {
                panic!("a well-formed callback settles, failing with: {message}")
            }
        }
        match mobile_callback_action("chan://auth/other?code=c1") {
            MobileCallbackAction::Fail(message) => {
                assert!(
                    message.contains("another path"),
                    "the fail carries the system's words: {message}"
                );
            }
            MobileCallbackAction::Settle(query) => {
                panic!("a malformed callback fails, settling with: {query}")
            }
        }
    }

    #[tokio::test]
    async fn malformed_callback_fails_loudly_instead_of_ignoring() {
        let _serial = crate::auth::tests::SLOT_TEST_LOCK.lock().await;
        let attempt = Arc::new(GatewayAttempt::default());
        crate::auth::tests::install_pending_for_test("gw-mobile", &attempt);
        let (_dir, state) = crate::gateway::tests::pat_load_test_state("https://id.example");
        let app = tauri::test::mock_app();
        app.manage(state);
        settle_mobile_outcome(
            app.handle().clone(),
            "gw-mobile",
            &attempt,
            MobileAuthOutcome::CallbackUrl("https://evil.example/phish?code=c1".into()),
        );
        assert!(
            !crate::auth::tests::take_pending_for_test(),
            "a malformed callback fails the slot instead of ignoring it",
        );
    }

    #[tokio::test]
    async fn cancel_and_failure_outcomes_consume_the_slot() {
        let _serial = crate::auth::tests::SLOT_TEST_LOCK.lock().await;
        let (_dir, state) = crate::gateway::tests::pat_load_test_state("https://id.example");
        let app = tauri::test::mock_app();
        app.manage(state);
        for outcome in [
            MobileAuthOutcome::Cancelled,
            MobileAuthOutcome::Failed("sheet exploded".into()),
        ] {
            let attempt = Arc::new(GatewayAttempt::default());
            crate::auth::tests::install_pending_for_test("gw-mobile", &attempt);
            settle_mobile_outcome(app.handle().clone(), "gw-mobile", &attempt, outcome);
            assert!(
                !crate::auth::tests::take_pending_for_test(),
                "a terminal outcome fails the slot instead of ignoring it",
            );
        }
    }

    #[tokio::test]
    async fn mobile_query_with_no_slot_ignores_quietly() {
        let _serial = crate::auth::tests::SLOT_TEST_LOCK.lock().await;
        assert!(
            !crate::auth::tests::take_pending_for_test(),
            "the serial lock means no slot is live here",
        );
        let attempt = Arc::new(GatewayAttempt::default());
        let (_dir, state) = crate::gateway::tests::pat_load_test_state("https://id.example");
        let app = tauri::test::mock_app();
        app.manage(state);
        crate::auth::settle_mobile_query(app.handle().clone(), "gw-mobile", &attempt, "code=c1");
    }

    fn test_window_record(
        window_id: &str,
        library_id: &str,
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

    fn query_map(url: &url::Url) -> std::collections::HashMap<String, String> {
        url.query_pairs().into_owned().collect()
    }

    #[test]
    fn mobile_window_target_url_stamps_every_branch_and_sanitizes_client_name() {
        let (_dir, state) = crate::gateway::tests::pat_load_test_state("https://id.example");
        {
            let mut store = state.store.lock().unwrap();
            let mut cfg = store.get().unwrap();
            cfg.client_session_name = "iPhone 16 & Pro".into();
            store.save(&cfg).unwrap();
        }
        state
            .devserver_feed
            .seed_library_id("gw:1".into(), "lib-99".into());
        state
            .devserver_feed
            .set_color("gw:1".into(), Some("#112233".into()));

        // Workspace with start_terminal, untrusted client_name, and feed pane fallback.
        let mut ws = test_window_record("w-1/a", "lib-99", chan_server::WindowKind::Workspace);
        ws.start_terminal = true;
        let ws_url = mobile_window_target_url(
            &state,
            "https://owner--disc.proxy.example/notes/index.html?client_name=evil",
            &ws,
            Some("deadbeef00112233"),
        )
        .unwrap();
        let ws_q = query_map(&ws_url);
        assert_eq!(
            ws_q.get("client_name").map(String::as_str),
            Some("iPhone 16 & Pro")
        );
        assert_eq!(ws_q.get("w").map(String::as_str), Some("w-1/a"));
        assert_eq!(ws_q.get("h").map(String::as_str), Some("deadbeef00112233"));
        assert_eq!(ws_q.get("start").map(String::as_str), Some("terminal"));
        assert_eq!(ws_q.get("lib").map(String::as_str), Some("lib-99"));
        assert_eq!(ws_q.get("pane").map(String::as_str), Some("#112233"));
        assert_eq!(ws_q.get("kind"), None);
        assert_eq!(ws_q.get("seed"), None);
        assert!(ws_url.as_str().contains("pane=%23112233"), "{ws_url}");
        assert!(ws_url.as_str().contains("w=w-1%2Fa"), "{ws_url}");
        assert!(!ws_url.as_str().contains("evil"), "{ws_url}");

        // Standalone tmux terminal stamps kind=terminal and seed=0.
        let mut term = test_window_record("w-2", "lib-99", chan_server::WindowKind::Terminal);
        term.tmux = Some(chan_server::TmuxWindowMark {
            connection: "tmux-1".into(),
            control: false,
            user_label: false,
        });
        let term_url = mobile_window_target_url(
            &state,
            "https://owner--disc.proxy.example/terminal/index.html",
            &term,
            Some("holder1"),
        )
        .unwrap();
        let term_q = query_map(&term_url);
        assert_eq!(term_q.get("kind").map(String::as_str), Some("terminal"));
        assert_eq!(term_q.get("seed").map(String::as_str), Some("0"));
        assert_eq!(term_q.get("start"), None);

        // Plain terminal without tmux omits seed.
        term.tmux = None;
        let plain_term_url = mobile_window_target_url(
            &state,
            "https://owner--disc.proxy.example/terminal/index.html",
            &term,
            Some("holder1"),
        )
        .unwrap();
        assert_eq!(query_map(&plain_term_url).get("seed"), None);

        // Control terminal stamps kind=control and preserves raw ?t= alongside stripped client_name.
        term.control = true;
        term.tmux = Some(chan_server::TmuxWindowMark {
            connection: "tmux-1".into(),
            control: true,
            user_label: false,
        });
        let ctrl_url = mobile_window_target_url(
            &state,
            "http://127.0.0.1:7001/control-0/index.html?client_name=evil&t=raw-tok",
            &term,
            None,
        )
        .unwrap();
        let ctrl_q = query_map(&ctrl_url);
        assert_eq!(ctrl_q.get("t").map(String::as_str), Some("raw-tok"));
        assert_eq!(ctrl_q.get("kind").map(String::as_str), Some("control"));
        assert_eq!(ctrl_q.get("seed").map(String::as_str), Some("0"));
        assert_eq!(ctrl_q.get("client_name"), None);
        assert_eq!(ctrl_q.get("h"), None);

        // Empty client_session_name omits client_name even when holder is Some.
        {
            let mut store = state.store.lock().unwrap();
            let mut cfg = store.get().unwrap();
            cfg.client_session_name.clear();
            store.save(&cfg).unwrap();
        }
        let empty_name_url = mobile_window_target_url(
            &state,
            "https://owner--disc.proxy.example/notes/index.html?client_name=evil",
            &ws,
            Some("holder1"),
        )
        .unwrap();
        assert_eq!(query_map(&empty_name_url).get("client_name"), None);
    }

    #[tokio::test]
    async fn mobile_open_existing_window_unhides_refreshes_feed_and_stamps_url() {
        use chan_server::DevserverFeedSource;

        let hidden_flag = Arc::new(std::sync::Mutex::new(true));
        let vis_requests = Arc::new(std::sync::Mutex::new(Vec::<(
            String,
            serde_json::Value,
            Option<String>,
            Option<String>,
        )>::new()));
        let hidden_r = Arc::clone(&hidden_flag);
        let vis_r = Arc::clone(&vis_requests);
        let hidden_list = Arc::clone(&hidden_flag);

        let router = axum::Router::new()
            .route(
                "/api/library/windows/{id}/visibility",
                axum::routing::post(
                    move |axum::extract::Path(id): axum::extract::Path<String>,
                          headers: axum::http::HeaderMap,
                          axum::Json(body): axum::Json<serde_json::Value>| {
                        let hidden = Arc::clone(&hidden_r);
                        let vis = Arc::clone(&vis_r);
                        async move {
                            let cookie = headers
                                .get(axum::http::header::COOKIE)
                                .and_then(|v| v.to_str().ok())
                                .map(str::to_string);
                            let csrf = headers
                                .get("x-chan-csrf")
                                .and_then(|v| v.to_str().ok())
                                .map(str::to_string);
                            vis.lock().unwrap().push((id, body.clone(), cookie, csrf));
                            if let Some(val) = body.get("hidden").and_then(|v| v.as_bool()) {
                                *hidden.lock().unwrap() = val;
                            }
                            axum::http::StatusCode::NO_CONTENT
                        }
                    },
                ),
            )
            .route(
                "/api/library/windows",
                axum::routing::get(move || {
                    let hidden = *hidden_list.lock().unwrap();
                    async move {
                        let mut rec = test_window_record(
                            "w-77",
                            "lib-77",
                            chan_server::WindowKind::Workspace,
                        );
                        rec.prefix = "/api/notes".into();
                        rec.hidden = hidden;
                        axum::Json(vec![rec])
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        let (_dir, state) = crate::gateway::tests::pat_load_test_state("https://id.example");
        let origin = format!("http://127.0.0.1:{}", addr.port());
        let gw = crate::devserver::GatewayConn::new(
            origin.clone(),
            format!("{origin}/mobile/v1/devserver/entry"),
            origin.clone(),
            "pat".into(),
        );
        gw.seed_fresh_session_for_test("csrf-unhide");
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
        let mut record = test_window_record("w-77", "lib-77", chan_server::WindowKind::Workspace);
        record.prefix = "/api/notes".into();
        record.hidden = true;
        state.devserver_feed.register_windows(
            "gw:1".into(),
            Arc::new(std::sync::Mutex::new(
                crate::state::DevserverWindowSnapshot::from(vec![record.clone()]),
            )),
        );
        state
            .devserver_feed
            .set_color("gw:1".into(), Some("#abcdef".into()));

        let app = tauri::test::mock_app();
        let main = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External("http://127.0.0.1:8471/?t=boot".parse().unwrap()),
        )
        .build()
        .unwrap();

        mobile_open_existing_window_with_app(app.handle(), &state, "gw:1", &record)
            .await
            .expect("open existing hidden window");

        let vis = vis_requests.lock().unwrap().clone();
        assert_eq!(vis.len(), 1);
        assert_eq!(vis[0].0, "w-77");
        assert_eq!(vis[0].1, serde_json::json!({ "hidden": false }));
        assert!(vis[0]
            .2
            .as_deref()
            .is_some_and(|c| c.contains("__Host-devserver_gate=test-gate")));
        assert_eq!(vis[0].3.as_deref(), Some("csrf-unhide"));

        let feed_windows = state.devserver_feed.windows();
        assert_eq!(feed_windows.len(), 1);
        assert!(!feed_windows[0].hidden);

        let q = query_map(&main.url().unwrap());
        assert_eq!(q.get("w").map(String::as_str), Some("w-77"));
        assert_eq!(q.get("lib").map(String::as_str), Some("lib-77"));
        assert_eq!(q.get("pane").map(String::as_str), Some("#abcdef"));

        server.abort();
    }

    #[tokio::test]
    async fn mobile_open_devserver_with_app_mints_refreshes_feed_and_navigates() {
        let library_home = tempfile::tempdir().unwrap();
        let library = chan_workspace::Library::open_at(library_home.path().join("library.toml"))
            .expect("open library");
        let embedded = crate::embedded::EmbeddedServer::for_tests(library).await;
        let notify = embedded.library_change_notify();

        let minted_list = Arc::new(std::sync::Mutex::new(
            Vec::<chan_server::WindowRecord>::new(),
        ));
        let minted_post = Arc::clone(&minted_list);
        let minted_get = Arc::clone(&minted_list);

        let router = axum::Router::new().route(
            "/api/library/windows",
            axum::routing::post(
                move |axum::Json(req): axum::Json<chan_server::CreateWindow>| {
                    let minted = Arc::clone(&minted_post);
                    async move {
                        let mut rec = test_window_record("w-minted", "lib-88", req.kind);
                        rec.prefix = "/terminal".into();
                        rec.workspace_path = req.workspace_path;
                        rec.start_terminal = req.start_terminal;
                        minted.lock().unwrap().push(rec.clone());
                        axum::Json(rec)
                    }
                },
            )
            .get(move || {
                let minted = Arc::clone(&minted_get);
                async move { axum::Json(minted.lock().unwrap().clone()) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        let (_dir, state) = crate::gateway::tests::pat_load_test_state("https://id.example");
        let _ = state.embedded.set(embedded);
        let origin = format!("http://127.0.0.1:{}", addr.port());
        let gw = crate::devserver::GatewayConn::new(
            origin.clone(),
            format!("{origin}/mobile/v1/devserver/entry"),
            origin.clone(),
            "pat".into(),
        );
        gw.seed_fresh_session_for_test("csrf-mint");
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
            Arc::new(std::sync::Mutex::new(
                crate::state::DevserverWindowSnapshot::default(),
            )),
        );
        state
            .devserver_feed
            .set_color("gw:1".into(), Some("#445566".into()));
        state.embedded().unwrap().install_devserver_feed(
            Arc::clone(&state.devserver_feed) as Arc<dyn chan_server::DevserverFeedSource>
        );

        let notified = notify.notified();
        let app = tauri::test::mock_app();
        let main = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External("http://127.0.0.1:8471/?t=boot".parse().unwrap()),
        )
        .build()
        .unwrap();

        mobile_open_devserver_with_app(
            app.handle(),
            &state,
            "gw:1",
            chan_server::WindowKind::Terminal,
            None,
            false,
        )
        .await
        .expect("mint and open devserver window");

        tokio::time::timeout(std::time::Duration::from_secs(2), notified)
            .await
            .expect("refresh fires library_change_notify");
        assert_eq!(
            state
                .devserver_feed
                .record_for_window_id("w-minted")
                .map(|(id, _)| id),
            Some("gw:1".to_string())
        );
        let q = query_map(&main.url().unwrap());
        assert_eq!(q.get("w").map(String::as_str), Some("w-minted"));
        assert_eq!(q.get("kind").map(String::as_str), Some("terminal"));
        assert_eq!(q.get("lib").map(String::as_str), Some("lib-88"));
        assert_eq!(q.get("pane").map(String::as_str), Some("#445566"));

        server.abort();
    }
}
