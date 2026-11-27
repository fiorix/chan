//! iOS boot: the embedded loopback stack plus the single webview.
//!
//! The iOS app runs the desktop's loopback stack (`WorkspaceHost` plus the
//! installed launcher) on device and points one Tauri webview at the
//! loopback launcher URL. It keeps no other desktop boot step: no CLI
//! stems, no handoff endpoint (iOS is single-instance by OS design), no
//! migrations (a fresh sandbox has no legacy rows), no window restore,
//! and no terminal seeding, so an empty library opens
//! the launcher and nothing else.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use objc2::rc::{Allocated, Retained};
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol};
use objc2::{class, define_class, extern_methods, msg_send, sel};

use crate::config::ConfigStore;
use crate::embedded;
use crate::{AppState, CHAN_IOS_BUILD_ID};

/// The app handle for the back gesture: set once in setup, read when
/// the swipe ends for the life of the process.
static BACK_APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Whether the back gesture installed on `"main"`'s `UIWindow`. Checked and
/// set inside the `with_webview` main-thread closure so a windowless early
/// call cannot mark installation done prematurely.
static BACK_GESTURE_DONE: AtomicBool = AtomicBool::new(false);

/// Address of the `UIWindow` that already carries our recognizer, preventing
/// duplicate attachment if setup and page load enqueue concurrent closures.
static ATTACHED_UI_WINDOW: AtomicUsize = AtomicUsize::new(0);

static BACK_GESTURE_TARGET: OnceLock<Retained<BackGestureTarget>> = OnceLock::new();
static BACK_GESTURE_DELEGATE: OnceLock<Retained<BackGestureDelegate>> = OnceLock::new();

/// Run the iOS app. Called once from the mobile entry point; drives the
/// Tauri event loop until the process exits.
pub fn run() {
    crate::init_tracing();
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        build = CHAN_IOS_BUILD_ID,
        "chan-ios starting"
    );
    let store = Arc::new(Mutex::new(
        ConfigStore::new().expect("failed to init config store"),
    ));
    let state = Arc::new(AppState::with_store(store));
    let state_for_setup = Arc::clone(&state);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                ensure_back_gesture();
                crate::on_main_page_load(webview, payload);
            }
        })
        .setup(move |app| {
            let _ = BACK_APP.set(app.handle().clone());
            let fabric = tauri::async_runtime::block_on(crate::wireguard::Fabric::bind())
                .map_err(std::io::Error::other)?;
            let prepared = {
                let mut store = state_for_setup.store.lock().unwrap();
                let mut config = store.get()?;
                let mut changed = false;
                let prepared = config.gateways.iter_mut().map(|gateway| {
                    let prepared = crate::wireguard::prepare(gateway);
                    changed |= gateway.wireguard_protection != prepared.protection;
                    gateway.wireguard_protection = prepared.protection.clone();
                    (gateway.clone(), prepared)
                }).collect::<Vec<_>>();
                for (_, prepared) in &prepared { prepared.validate().map_err(std::io::Error::other)?; }
                if changed { store.save(&config)?; }
                prepared
            };
            for (_, prepared) in &prepared {
                fabric.protect(&prepared.protection).map_err(std::io::Error::other)?;
            }
            fabric.install_native_proxy().map_err(std::io::Error::other)?;
            let capability = crate::webview_proxy::install(fabric.address());
            if let Err(reason) = &capability { tracing::warn!(%reason, "WireGuard WebView routing unavailable"); }
            fabric.set_capability(capability);
            for (gateway, prepared) in prepared {
                fabric.reconcile(&gateway, prepared).map_err(std::io::Error::other)?;
            }
            tauri::async_runtime::block_on(fabric.settled()).map_err(std::io::Error::other)?;
            let _ = state_for_setup.gateway_manager.fabric.set(fabric);
            let app_for_invalidate = app.handle().clone();
            let _ = state_for_setup.gateway_manager.transport_invalidate.set(Arc::new(move |id| {
                let state = app_for_invalidate.state::<Arc<AppState>>();
                crate::wireguard::invalidate_native(&app_for_invalidate, &state, id);
            }));

            let registry_deps = embedded::RegistryDeps {
                config_store: Arc::clone(&state_for_setup.store),
                devserver_remove_hook: Arc::clone(&state_for_setup.devserver_remove_hook),
                gateway_remove_hook: Arc::clone(&state_for_setup.gateway_remove_hook),
                gateway_manager: Arc::clone(&state_for_setup.gateway_manager),
                devserver_conns: Arc::clone(&state_for_setup.devservers),
                devserver_connecting: Arc::clone(&state_for_setup.devserver_connecting),
                devserver_feed: Arc::clone(&state_for_setup.devserver_feed),
                server_config_hook: crate::terminal_opacity::config_hook(app.handle().clone()),
            };
            let server =
                tauri::async_runtime::block_on(embedded::EmbeddedServer::start(registry_deps))
                    .map_err(std::io::Error::other)?;
            tracing::info!(addr = %server.addr(), "iOS webview loading loopback launcher");
            let url =
                crate::mobile_auth::launcher_url_for_addr(server.addr(), server.launcher_token())
                    .expect("the loopback launcher URL is always valid");
            if state_for_setup.embedded.set(server).is_err() {
                tracing::warn!("embedded local server initialized more than once");
            }
            // Install the connected-devserver feed source so the launcher
            // merges remote windows + workspaces, mirroring desktop setup.
            if let Some(embedded) = state_for_setup.embedded() {
                let feed = Arc::clone(&state_for_setup.devserver_feed);
                embedded.install_devserver_feed(feed);
            }
            // Fill the registry's remove hook now that the AppHandle
            // exists: the launcher's HTTP DELETE then reaps a live
            // devserver's connection. The closure holds only the AppHandle
            // (no Arc cycle) and resolves the AppState from it at call time.
            let app_for_teardown = app.handle().clone();
            let _ = state_for_setup.devserver_remove_hook.set(Arc::new(
                move |id: &str| {
                    let app = app_for_teardown.clone();
                    let id = id.to_string();
                    tauri::async_runtime::spawn(async move {
                        let state = Arc::clone(&app.state::<Arc<AppState>>());
                        crate::teardown_devserver_connection(&app, &state, &id).await;
                    })
                },
            ));
            // The roster poll's node-move handling fires this after tearing
            // the old managed connection down: the row re-enters the normal
            // connect flow with a fresh authenticated entry.
            let app_for_reconnect = app.handle().clone();
            let _ = state_for_setup
                .devserver_reconnect_hook
                .set(Arc::new(move |id: &str| {
                    let app = app_for_reconnect.clone();
                    let id = id.to_string();
                    tauri::async_runtime::spawn(async move {
                        let state = Arc::clone(&app.state::<Arc<AppState>>());
                        if crate::gateway::parse_synthesized_id(&id).is_none() {
                            tracing::warn!(devserver = %id, "reconnect hook fired for a non-gateway row");
                            return;
                        }
                        if let Err(e) =
                            crate::connect_rostered_devserver(app, state, id.clone()).await
                        {
                            tracing::warn!(devserver = %id, error = %e, "reconnect after a proxy node move failed");
                        }
                    });
                }));
            // The gateway analogue: the launcher's HTTP DELETE runs the
            // full cascade (poll stop, rostered-connection teardown, roster
            // drop). The registry's remove already dropped the config row,
            // so the cascade only reaps runtime state.
            let app_for_gw_remove = app.handle().clone();
            let _ = state_for_setup.gateway_remove_hook.set(Arc::new(
                move |id: &str| {
                    let app = app_for_gw_remove.clone();
                    let id = id.to_string();
                    let state = Arc::clone(&app.state::<Arc<AppState>>());
                    tauri::async_runtime::spawn(async move {
                        crate::gateway::cascade_disconnect(
                            &app,
                            &state,
                            &id,
                            crate::gateway::CascadeReason::Removed,
                        )
                        .await;
                    });
                },
            ));
            WebviewWindowBuilder::new(app.handle(), "main", WebviewUrl::External(url))
                .title("Chan")
                .build()?;
            ensure_back_gesture();
            // Reconnect enabled gateways from the last run. Never opens a
            // browser: PAT-less rows park as sign-in required until the
            // user taps Connect.
            crate::gateway::autoconnect_enabled_gateways(
                app.handle(),
                &state_for_setup,
            );
            // Hand the auth leg the app handle its bridge opens navigate
            // through, and start the lifecycle observer that suspends
            // and resyncs the roster across background/foreground.
            crate::mobile_auth::stash_mobile_app_handle(app.handle());
            crate::mobile_auth::ensure_mobile_lifecycle_observer(
                app.handle(),
                &state_for_setup,
            );
            // Spawn the window-ops consumer now that the AppHandle exists:
            // it owns the bridge receiver and turns lifecycle requests
            // (gateway connect/disconnect, devserver ops) into action.
            // Without it every bridge op sits unread while its handler
            // awaits a reply forever. The task lives until the channel
            // closes at exit.
            if let Some(rx) = state_for_setup
                .embedded()
                .and_then(|e| e.take_window_ops_rx())
            {
                let app_for_ops = app.handle().clone();
                let state_for_ops = Arc::clone(&state_for_setup);
                tauri::async_runtime::spawn(crate::window_ops::run(
                    app_for_ops,
                    state_for_ops,
                    rx,
                ));
            }
            Ok(())
        })
        .invoke_handler(crate::app_invoke_handler())
        .build(tauri::generate_context!())
        .expect("error building tauri application");
    app.run(|_app, _event| {
        // iOS owns the process lifecycle: no exit to confirm, no dock
        // reopen. Background and foreground hooks land with the roster
        // pause they serve.
    });
}

/// Install the native back affordance on `"main"`'s `UIWindow` if it is not
/// yet in place. Dispatches onto `"main"`'s `WKWebView` so `BACK_GESTURE_DONE`
/// flips only after a non-null `UIWindow` receives the recognizer.
fn ensure_back_gesture() {
    if BACK_GESTURE_DONE.load(Ordering::SeqCst) {
        return;
    }
    let Some(app) = BACK_APP.get() else {
        tracing::warn!("iOS back gesture checked before app handle was stored");
        return;
    };
    let Some(main) = app.get_webview_window("main") else {
        tracing::warn!("iOS back gesture found no main webview window");
        return;
    };
    if let Err(error) = main.with_webview(|wv| {
        install_back_gesture_on_webview(wv.inner());
    }) {
        tracing::warn!(%error, "scheduling iOS back gesture on main webview failed");
    }
}

/// Navigate the single webview home unless it already shows the launcher.
fn back_to_computers(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        tracing::warn!("back gesture with no main window");
        return;
    };
    let state = app.state::<Arc<AppState>>();
    let home = match crate::mobile_auth::mobile_launcher_url(&state) {
        Ok(url) => url,
        Err(e) => {
            tracing::warn!(error = %e, "back gesture with no local library");
            return;
        }
    };
    match window.url() {
        Ok(current) if crate::same_page(&current, &home) => return,
        // Unknown page: navigate home anyway; the gesture means back.
        Err(e) => tracing::warn!(error = %e, "back gesture cannot read the current page"),
        _ => {}
    }
    if let Err(e) = crate::mobile_auth::navigate_main_to_launcher(&window, state.inner()) {
        tracing::warn!(error = %e, "back-to-Computers navigation failed");
    }
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements; the target holds
    // no ivars and implements no Drop.
    #[unsafe(super(NSObject))]
    struct BackGestureTarget;

    unsafe impl NSObjectProtocol for BackGestureTarget {}

    impl BackGestureTarget {
        /// Left-edge swipe ended: navigate home. The recognizer fires on
        /// the main thread; the sender is never null for action messages.
        #[unsafe(method(handleSwipe:))]
        fn handle_swipe(&self, recognizer: *mut AnyObject) {
            if recognizer.is_null() {
                return;
            }
            // UIGestureRecognizerStateEnded == 3, stable API contract.
            // AnyObject keeps UIKit out of the dependency list.
            let state: isize = unsafe { msg_send![&*recognizer, state] };
            if state != 3 {
                return;
            }
            let Some(app) = BACK_APP.get() else {
                tracing::warn!("back gesture with no app handle yet");
                return;
            };
            back_to_computers(app);
        }
    }
);

impl BackGestureTarget {
    extern_methods!(
        // SAFETY: `new` allocates and runs NSObject's designated
        // initializer; the target holds no ivars.
        #[unsafe(method(new))]
        fn new() -> Retained<Self>;
    );
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements; the delegate holds
    // no ivars and implements no Drop.
    #[unsafe(super(NSObject))]
    struct BackGestureDelegate;

    unsafe impl NSObjectProtocol for BackGestureDelegate {}

    impl BackGestureDelegate {
        /// Allow the left-edge recognizer to arbitrate simultaneously with
        /// WKWebView's internal pan and scroll recognizers.
        #[unsafe(method(gestureRecognizer:shouldRecognizeSimultaneouslyWithGestureRecognizer:))]
        fn should_recognize_simultaneously(
            &self,
            gesture_recognizer: *mut AnyObject,
            other_gesture_recognizer: *mut AnyObject,
        ) -> bool {
            !gesture_recognizer.is_null() && !other_gesture_recognizer.is_null()
        }
    }
);

impl BackGestureDelegate {
    extern_methods!(
        // SAFETY: `new` allocates and runs NSObject's designated
        // initializer; the delegate holds no ivars.
        #[unsafe(method(new))]
        fn new() -> Retained<Self>;
    );
}

/// Attach the left-edge swipe recognizer to `"main"`'s owning `UIWindow`.
/// Must run on the main thread inside `with_webview` so `[wk_webview window]`
/// is valid and `BACK_GESTURE_DONE` reflects real attachment.
fn install_back_gesture_on_webview(wk_webview_ptr: *mut std::ffi::c_void) {
    if BACK_GESTURE_DONE.load(Ordering::SeqCst) {
        return;
    }
    if wk_webview_ptr.is_null() {
        tracing::warn!("iOS back gesture received a null WKWebView pointer");
        return;
    }
    // SAFETY: `with_webview` runs on the main thread with a live WKWebView;
    // every UIKit object is null-checked before use, and target/delegate live
    // in OnceLock for the process lifetime.
    unsafe {
        let wk_webview = &*wk_webview_ptr.cast::<AnyObject>();
        let ui_window: *mut AnyObject = msg_send![wk_webview, window];
        if ui_window.is_null() {
            tracing::debug!("iOS back gesture deferred until main WKWebView has a UIWindow");
            return;
        }
        let window_addr = ui_window as usize;
        if ATTACHED_UI_WINDOW.load(Ordering::SeqCst) == window_addr {
            BACK_GESTURE_DONE.store(true, Ordering::SeqCst);
            return;
        }
        let target = BACK_GESTURE_TARGET.get_or_init(BackGestureTarget::new);
        let delegate = BACK_GESTURE_DELEGATE.get_or_init(BackGestureDelegate::new);
        let allocated: Allocated<AnyObject> =
            msg_send![class!(UIScreenEdgePanGestureRecognizer), alloc];
        if Allocated::as_ptr(&allocated).is_null() {
            tracing::warn!("allocating UIScreenEdgePanGestureRecognizer returned nil");
            return;
        }
        let swipe: Option<Retained<AnyObject>> = msg_send![
            allocated,
            initWithTarget: &**target,
            action: sel!(handleSwipe:)
        ];
        let Some(swipe) = swipe else {
            tracing::warn!("initializing UIScreenEdgePanGestureRecognizer returned nil");
            return;
        };
        // UIRectEdgeLeft == 1 << 1, stable API contract.
        let _: () = msg_send![&*swipe, setEdges: 2usize];
        let _: () = msg_send![&*swipe, setDelegate: &**delegate];
        let _: () = msg_send![&*ui_window, addGestureRecognizer: &*swipe];
        ATTACHED_UI_WINDOW.store(window_addr, Ordering::SeqCst);
        BACK_GESTURE_DONE.store(true, Ordering::SeqCst);
        tracing::info!("iOS back gesture installed on main UIWindow");
    }
}
