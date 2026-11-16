//! The single-webview auth surface: the OAuth callback the authentication
//! session captures, the devserver open that navigates the one webview, and
//! the app-lifecycle observer that pauses roster polling.
//!
//! The desktop answers its OAuth callback on a loopback listener and opens
//! each devserver tenant in a window of its own. This module carries the
//! other shape: the authorize page runs in an `ASWebAuthenticationSession`
//! sheet, the session intercepts the `chan://auth/callback` navigation
//! in-process, and the captured query settles through the exact desktop
//! classify plus redeem plus commit path ([`crate::auth`]), so the only
//! behavioral delta is the browser leg itself. Opening a rostered devserver
//! mints the window record, reinstalls the gateway session cookies (each
//! install returns only after the cookie store confirms), and navigates the
//! single webview to the tenant URL; back-to-Computers navigates it home.
//!
//! The HTTP bridge callbacks that open devservers carry no app handle, so
//! the rostered-connect path stashes one here ([`stash_mobile_app_handle`]);
//! opens refuse until a stash lands. Roster polling pauses while the app is
//! backgrounded through an `NSNotificationCenter` observer registered from
//! the same path; the OS would freeze the timers anyway, and the foreground
//! transition resyncs immediately instead of waiting out the poll period.

use std::sync::{Arc, OnceLock};

use tauri::Manager;

use crate::gateway::GatewayAttempt;

/// The OAuth callback the mobile leg sends as `redirect_uri` and the
/// authentication session intercepts. Exact value, allowlisted gateway-side
/// beside the loopback form; the same scope, PKCE, and redeem ride it.
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

/// The app handle the rostered-connect path stashes for the bridge-open path,
/// which runs without one. Set once; a rostered open before any rostered
/// connect refuses instead of navigating nowhere.
static MOBILE_APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Stash the app handle bridge opens navigate through. Idempotent: the first
/// rostered connect wins, later ones are the same handle.
#[cfg(target_os = "ios")]
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

/// Open a rostered devserver in the single webview: mint the window record,
/// resolve the tenant URL through a validated entry exchange, reinstall the
/// gateway session cookies (the install returns only after the cookie store
/// confirms both), then navigate. The record mint and the entry exchange are
/// the shared desktop implementations; only the window is different.
pub(crate) async fn mobile_open_devserver(
    state: &Arc<crate::AppState>,
    id: &str,
    kind: chan_server::WindowKind,
    path: Option<String>,
    start_terminal: bool,
) -> Result<(), String> {
    let app = mobile_app_handle()
        .ok_or_else(|| "the mobile app handle is not ready; connect again".to_string())?;
    let conn = mobile_gateway_conn(&state.devservers, id)?;
    let record =
        crate::devserver::mint_library_window_with_start(&conn, kind, path, start_terminal).await?;
    let target = crate::devserver::window_navigation_url(&conn, &record).await?;
    crate::devserver::install_gateway_webview_session(&app, &conn, None)?;
    let url = url::Url::parse(&target).map_err(|e| format!("devserver target URL: {e}"))?;
    let webview = app
        .webview_windows()
        .into_values()
        .next()
        .ok_or_else(|| "no webview to open the devserver in".to_string())?;
    webview
        .navigate(url)
        .map_err(|e| format!("opening the devserver: {e}"))?;
    Ok(())
}

/// The loopback launcher URL back-to-Computers navigates home to: the
/// embedded library's root, the same URL the single webview boots on.
pub(crate) fn mobile_launcher_url(state: &crate::AppState) -> Result<url::Url, String> {
    let addr = state
        .embedded()
        .map(|embedded| embedded.addr())
        .ok_or_else(|| "the local library is not running".to_string())?;
    launcher_url_for_addr(addr)
}

/// The launcher root URL for an embedded loopback address.
pub(crate) fn launcher_url_for_addr(addr: std::net::SocketAddr) -> Result<url::Url, String> {
    url::Url::parse(&format!("http://{addr}/")).map_err(|e| format!("launcher URL: {e}"))
}

/// Back to Computers: re-navigate the invoking webview to the loopback
/// launcher URL. Registered on the mobile build only; the native affordance
/// that invokes it lives in the app scaffold.
#[cfg(target_os = "ios")]
#[tauri::command]
pub(crate) fn mobile_back_to_computers(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<crate::AppState>>,
) -> Result<(), String> {
    let url = mobile_launcher_url(state.inner())?;
    window
        .navigate(url)
        .map_err(|e| format!("returning to Computers: {e}"))?;
    Ok(())
}

#[cfg(target_os = "ios")]
pub(crate) use ios::{ensure_mobile_lifecycle_observer, start_mobile_signin};

/// The authentication session plus the app-lifecycle observer. Both are
/// platform objects that exist on the mobile target only; the shared settle,
/// open, and roster entry points above stay platform-free so host tests drive
/// them.
#[cfg(target_os = "ios")]
mod ios {
    use std::sync::{Arc, Mutex, OnceLock};

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol};
    use objc2::{class, define_class, msg_send, sel, MainThreadMarker};
    use objc2_foundation::{NSError, NSNotification, NSNotificationCenter, NSString, NSURL};
    use tokio::sync::watch;

    use crate::gateway::GatewayAttempt;

    use super::{mobile_callback_query, MOBILE_CALLBACK_SCHEME};

    #[link(name = "AuthenticationServices", kind = "framework")]
    extern "C" {}

    /// What the authentication session answered with: exactly one arm fires
    /// per presentation.
    enum MobileAuthOutcome {
        CallbackUrl(String),
        Cancelled,
        Failed(String),
    }

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
                release_mobile_session_for(&gateway_id, &attempt);
                match outcome {
                    MobileAuthOutcome::CallbackUrl(url) => match mobile_callback_query(&url) {
                        Ok(query) => {
                            crate::auth::settle_mobile_query(app, &gateway_id, &attempt, &query);
                        }
                        Err(error) => tracing::warn!(
                            %error,
                            "ignoring a sign-in answer that is not the mobile callback",
                        ),
                    },
                    MobileAuthOutcome::Cancelled => crate::auth::fail_mobile_signin(
                        app,
                        &gateway_id,
                        &attempt,
                        "sign-in was cancelled in the browser".to_string(),
                    ),
                    MobileAuthOutcome::Failed(message) => {
                        crate::auth::fail_mobile_signin(app, &gateway_id, &attempt, message);
                    }
                }
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
        let app = app.clone();
        let gateway_id = gateway_id.to_string();
        let attempt = Arc::clone(attempt);
        let authorize_url = authorize_url.to_string();
        app.run_on_main_thread(move || {
            if let Err(error) =
                start_mobile_session(&authorize_url, &gateway_id, &attempt, outcome_tx)
            {
                crate::auth::fail_mobile_signin(app, &gateway_id, &attempt, error);
            }
        })
        .map_err(|e| format!("starting the sign-in sheet: {e}"))?;
        Ok(())
    }

    /// A presented session plus its provider (the provider property is weak,
    /// so both are retained here) and the attempt they belong to, so a stale
    /// shutdown or completion can never cancel or release a successor's.
    struct MobileSession {
        session: Retained<AnyObject>,
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
                unsafe {
                    let _: () = msg_send![&presented.session, cancel];
                }
            }
        }
    }

    /// Release this attempt's sheet after its completion fired, if it still
    /// owns the holder. A successor's presentation survives its
    /// predecessor's late answer.
    fn release_mobile_session_for(gateway_id: &str, attempt: &Arc<GatewayAttempt>) {
        let mut holder = MOBILE_SESSION.lock().unwrap();
        if holder
            .as_ref()
            .is_some_and(|presented| mobile_session_matches(presented, gateway_id, attempt))
        {
            holder.take();
        }
    }

    /// Build and start the session. Main thread only; the completion crosses
    /// to the forwarder task through the outcome sender.
    fn start_mobile_session(
        authorize_url: &str,
        gateway_id: &str,
        attempt: &Arc<GatewayAttempt>,
        outcome_tx: tokio::sync::oneshot::Sender<MobileAuthOutcome>,
    ) -> Result<(), String> {
        if MainThreadMarker::new().is_none() {
            return Err("the sign-in sheet starts on the main thread only".to_string());
        }
        let url = unsafe { NSURL::URLWithString(&NSString::from_str(authorize_url)) }
            .ok_or_else(|| "building the authorize URL".to_string())?;
        let scheme = NSString::from_str(MOBILE_CALLBACK_SCHEME);
        // The completion answers exactly once with a callback URL or an
        // error; every capture is Send, and the outcome crosses to the
        // forwarder task. The block never panics: a panic here would unwind
        // through ObjC.
        let outcome_tx = Mutex::new(Some(outcome_tx));
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
        let session: Retained<AnyObject> = unsafe {
            let allocated: *mut AnyObject = msg_send![class!(ASWebAuthenticationSession), alloc];
            if allocated.is_null() {
                return Err("allocating the sign-in sheet".to_string());
            }
            msg_send![&*allocated, initWithURL: &*url callbackURLScheme: &*scheme completionHandler: &*completion]
        };
        unsafe {
            let _: () = msg_send![&session, setPresentationContextProvider: &*provider];
        }
        let started: bool = unsafe { msg_send![&session, start] };
        if !started {
            return Err("the sign-in sheet refused to start".to_string());
        }
        MOBILE_SESSION.lock().unwrap().replace(MobileSession {
            session,
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
            error.localizedDescription().to_string(),
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
            /// The window the sheet presents from: the app's key window, else
            /// its first window. Null when neither answers, and the session
            /// then fails through the completion instead of presenting nowhere.
            #[unsafe(method(presentationAnchorForWebAuthenticationSession:))]
            fn presentation_anchor(&self, _session: *mut AnyObject) -> *mut AnyObject {
                // The shared application outlives the call, so no ownership
                // is taken; a null answer fails the session through the
                // completion instead of presenting nowhere.
                let app: *mut AnyObject =
                    unsafe { msg_send![class!(UIApplication), sharedApplication] };
                if app.is_null() {
                    return std::ptr::null_mut();
                }
                // SAFETY: non-null per the check above, and alive for the
                // process; used immediately.
                let app = unsafe { &*app };
                unsafe {
                    let key: *mut AnyObject = msg_send![app, keyWindow];
                    if !key.is_null() {
                        return key;
                    }
                    let windows: *mut AnyObject = msg_send![app, windows];
                    if windows.is_null() {
                        return std::ptr::null_mut();
                    }
                    msg_send![&*windows, firstObject]
                }
            }
        }
    );

    impl MobileAuthPresentationProvider {
        fn new() -> Retained<Self> {
            let this = Self::alloc();
            // SAFETY: NSObject's designated initializer, sent once to a
            // freshly allocated object.
            unsafe { msg_send![super(this), init] }
        }
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
                crate::gateway::set_roster_poll_suspended(self.ivars().1, true);
            }

            #[unsafe(method(mobileAppWillEnterForeground:))]
            fn will_enter_foreground(&self, _notification: &NSNotification) {
                crate::gateway::set_roster_poll_suspended(self.ivars().1, false);
                crate::gateway::resync_roster_polls(self.ivars().0, self.ivars().1);
            }
        }
    );

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

    /// Observe background and foreground transitions once per process, from the
    /// rostered-connect path that owns an app handle. Any thread may register;
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
            "https://id.example/desktop/v1/devserver/entry".into(),
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
            launcher_url_for_addr(addr).unwrap().as_str(),
            "http://127.0.0.1:8471/"
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
    async fn mobile_open_refuses_before_any_rostered_connect() {
        // The stash is iOS-only, so no host test can set it: the open always
        // refuses here, before touching the connection.
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
}
