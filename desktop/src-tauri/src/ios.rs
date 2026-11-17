//! iOS boot: the embedded loopback stack plus the single webview.
//!
//! The iOS app runs the desktop's loopback stack (`WorkspaceHost` plus the
//! installed launcher) on device and points one Tauri webview at the
//! loopback launcher URL. It keeps no other desktop boot step: no CLI
//! stems, no handoff endpoint (iOS is single-instance by OS design), no
//! migrations (a fresh sandbox has no legacy rows), no WireGuard fabric,
//! no window restore, and no terminal seeding, so an empty library opens
//! the launcher and nothing else.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use objc2::rc::{Allocated, Retained};
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol};
use objc2::{class, define_class, extern_methods, msg_send, sel};

use crate::config::ConfigStore;
use crate::embedded;
use crate::{AppState, CHAN_DESKTOP_BUILD_ID};

/// The app handle for the back gesture: set once in setup, read when
/// the swipe ends for the life of the process.
static BACK_APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Whether the back gesture installed. Setup tries first; the first page
/// load retries if the window was not enumerated yet. Both run on the
/// main thread, so no race.
static BACK_GESTURE_DONE: AtomicBool = AtomicBool::new(false);

/// Run the iOS app. Called once from the mobile entry point; drives the
/// Tauri event loop until the process exits.
pub(crate) fn run() {
    crate::init_tracing();
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        build = CHAN_DESKTOP_BUILD_ID,
        "chan-desktop starting"
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
            let url = format!("http://{}/?t={}", server.addr(), server.launcher_token());
            if state_for_setup.embedded.set(server).is_err() {
                tracing::warn!("embedded local server initialized more than once");
            }
            WebviewWindowBuilder::new(
                app.handle(),
                "main",
                WebviewUrl::External(
                    url.parse()
                        .expect("the loopback launcher URL is always valid"),
                ),
            )
            .title("Chan")
            .build()?;
            ensure_back_gesture();
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

/// Attach a left-edge swipe recognizer to every app window, navigating
/// home through the back-to-Computers command when it ends. Reports
/// whether any window took it. Main thread only (UIKit); every object is
/// alive for the call (the application for the process, windows retained
/// by it, each recognizer retained by its window once added, the gesture
/// target intentionally leaked below).
fn install_back_gesture() -> bool {
    let target = BackGestureTarget::new();
    // SAFETY: sharedApplication, windows, and the view calls below are
    // main-thread-only and both callers (setup, page load) run there;
    // every pointer is null-checked before use.
    unsafe {
        let app: *mut AnyObject = msg_send![class!(UIApplication), sharedApplication];
        if app.is_null() {
            return false;
        }
        let windows: *mut AnyObject = msg_send![&*app, windows];
        if windows.is_null() {
            return false;
        }
        let count: usize = msg_send![&*windows, count];
        let mut installed = false;
        let mut index = 0;
        while index < count {
            let window: *mut AnyObject = msg_send![&*windows, objectAtIndex: index];
            if !window.is_null() {
                let allocated: Allocated<AnyObject> =
                    msg_send![class!(UIScreenEdgePanGestureRecognizer), alloc];
                // UIRectEdgeLeft == 1 << 0, stable API contract.
                let swipe: Retained<AnyObject> = msg_send![
                    allocated,
                    initWithTarget: &*target,
                    action: sel!(handleSwipe:)
                ];
                let _: () = msg_send![&*swipe, setEdges: 1usize];
                let _: () = msg_send![&*window, addGestureRecognizer: &*swipe];
                installed = true;
            }
            index += 1;
        }
        if installed {
            // Recognizers hold their target weakly: forget the retain so
            // the action can never dangle. One tiny object per process.
            std::mem::forget(target);
        }
        installed
    }
}
