//! iOS boot: the embedded loopback stack plus the single webview.
//!
//! The iOS app runs the desktop's loopback stack (`WorkspaceHost` plus the
//! installed launcher) on device and points one Tauri webview at the
//! loopback launcher URL. It keeps no other desktop boot step: no CLI
//! stems, no handoff endpoint (iOS is single-instance by OS design), no
//! migrations (a fresh sandbox has no legacy rows), no WireGuard fabric,
//! no window restore, and no terminal seeding, so an empty library opens
//! the launcher and nothing else.

use std::sync::{Arc, Mutex};

use tauri::{WebviewUrl, WebviewWindowBuilder};

use crate::config::ConfigStore;
use crate::embedded;
use crate::{AppState, CHAN_DESKTOP_BUILD_ID};

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
        .setup(move |app| {
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
