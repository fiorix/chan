//! iOS boot: the embedded loopback stack plus the single webview.
//!
//! The iOS app runs the desktop's loopback stack (`WorkspaceHost` plus the
//! installed launcher) on device and points one Tauri webview at the
//! loopback launcher URL. It keeps no other desktop boot step: no CLI
//! stems, no handoff endpoint (iOS is single-instance by OS design), no
//! migrations (a fresh sandbox has no legacy rows), no window restore,
//! and no terminal seeding, so an empty library opens
//! the launcher and nothing else.

use std::sync::atomic::{AtomicBool, Ordering};
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

/// Whether the back gesture installed. Setup tries first; the first page
/// load retries if the window was not enumerated yet. Both run on the
/// main thread, so no race.
static BACK_GESTURE_DONE: AtomicBool = AtomicBool::new(false);

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
        .on_page_load(|_webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                ensure_back_gesture();
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

/// Install the native back affordance if it is not in place. Idempotent:
/// setup calls it at window build and the first page load retries.
fn ensure_back_gesture() {
    if BACK_GESTURE_DONE.load(Ordering::SeqCst) {
        return;
    }
    if install_back_gesture() {
        BACK_GESTURE_DONE.store(true, Ordering::SeqCst);
        tracing::info!("iOS back gesture installed");
    } else {
        tracing::warn!("iOS back gesture found no window to attach to");
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
        Ok(current) if same_page(&current, &home) => return,
        // Unknown page: navigate home anyway; the gesture means back.
        Err(e) => tracing::warn!(error = %e, "back gesture cannot read the current page"),
        _ => {}
    }
    if let Err(e) = crate::mobile_auth::mobile_back_to_computers(window, state.clone()) {
        tracing::warn!(error = %e, "back-to-Computers navigation failed");
    }
}

/// Same page ignoring query and fragment, so a launcher showing its
/// bearer token still reads as home.
fn same_page(left: &url::Url, right: &url::Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port() == right.port()
        && left.path() == right.path()
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

/// Attach a left-edge swipe recognizer to every scene window, navigating
/// home through the back-to-Computers command when it ends. Reports
/// whether any window took it. Main thread only (UIKit); every object is
/// alive for the call (the application for the process, scenes and windows
/// retained by it, each recognizer retained by its window once added, the
/// gesture target intentionally leaked below).
fn install_back_gesture() -> bool {
    let target = BackGestureTarget::new();
    // SAFETY: sharedApplication, connectedScenes, scene windows, and gesture
    // recognizer attachment are main-thread-only and both callers (setup,
    // page load) run there; every pointer is null-checked before use.
    unsafe {
        let app: *mut AnyObject = msg_send![class!(UIApplication), sharedApplication];
        if app.is_null() {
            return false;
        }
        let scenes: *mut AnyObject = msg_send![&*app, connectedScenes];
        if scenes.is_null() {
            return false;
        }
        let scenes: *mut AnyObject = msg_send![&*scenes, allObjects];
        if scenes.is_null() {
            return false;
        }
        let scenes = &*scenes;
        let scene_count: usize = msg_send![scenes, count];
        let mut installed = false;
        for scene_index in 0..scene_count {
            let scene: *mut AnyObject = msg_send![scenes, objectAtIndex: scene_index];
            if scene.is_null() {
                continue;
            }
            let scene = &*scene;
            let has_windows: bool = msg_send![scene, respondsToSelector: sel!(windows)];
            if !has_windows {
                continue;
            }
            let windows: *mut AnyObject = msg_send![scene, windows];
            if windows.is_null() {
                continue;
            }
            let windows = &*windows;
            let window_count: usize = msg_send![windows, count];
            for window_index in 0..window_count {
                let window: *mut AnyObject = msg_send![windows, objectAtIndex: window_index];
                if window.is_null() {
                    continue;
                }
                let allocated: Allocated<AnyObject> =
                    msg_send![class!(UIScreenEdgePanGestureRecognizer), alloc];
                if Allocated::as_ptr(&allocated).is_null() {
                    continue;
                }
                // UIRectEdgeLeft == 1 << 1, stable API contract.
                let swipe: Retained<AnyObject> = msg_send![
                    allocated,
                    initWithTarget: &*target,
                    action: sel!(handleSwipe:)
                ];
                let _: () = msg_send![&*swipe, setEdges: 2usize];
                let _: () = msg_send![&*window, addGestureRecognizer: &*swipe];
                installed = true;
            }
        }
        if installed {
            // Recognizers hold their target weakly: forget the retain so
            // the action can never dangle. One tiny object per process.
            std::mem::forget(target);
        }
        installed
    }
}
