//! Privacy preferences belong to the viewing desktop, including its remote windows.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};

use crate::{config::ConfigStore, AppState};

pub(crate) const EVENT: &str = "privacy-settings";
pub(crate) const BRIDGE: &str = include_str!("privacy_bridge.js");

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default)]
pub struct PrivacySettings {
    pub enabled: bool,
    pub mask_terminal_secrets: bool,
    /// Orders snapshots and invalidates individual reveals after a mode change.
    pub revision: u64,
}

#[derive(Default, Deserialize)]
pub(crate) struct PrivacyPatch {
    enabled: Option<bool>,
    mask_terminal_secrets: Option<bool>,
}

pub(crate) fn read(store: &Mutex<ConfigStore>) -> Result<PrivacySettings, String> {
    store
        .lock()
        .map_err(|e| e.to_string())?
        .get()
        .map(|config| config.privacy)
        .map_err(|e| format!("Reading privacy settings: {e}"))
}

pub(crate) fn enabled(state: &AppState) -> bool {
    read(&state.store).map_or(true, |settings| settings.enabled)
}

pub(crate) fn window_title(state: &AppState, label: &str, title: &str) -> String {
    state
        .privacy_titles
        .lock()
        .unwrap()
        .insert(label.to_string(), title.to_string());
    if enabled(state) {
        "Chan (privacy mode)".to_string()
    } else {
        title.to_string()
    }
}

fn refresh_titles(app: &tauri::AppHandle) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let state = handle.state::<Arc<AppState>>();
        let hidden = enabled(&state);
        let titles = state.privacy_titles.lock().unwrap().clone();
        for (label, title) in titles {
            if let Some(window) = handle.get_webview_window(&label) {
                let _ = window.set_title(if hidden {
                    "Chan (privacy mode)"
                } else {
                    &title
                });
                // A frameless window in the title bar mode draws its title
                // itself while its launcher shows (`titlebar_tabs.rs`).
                crate::titlebar_tabs::title_changed(&window);
            }
        }
        crate::rebuild_window_menu(&handle);
    })
    .map_err(|e| format!("Updating private window titles: {e}"))
}

fn write(store: &Mutex<ConfigStore>, patch: PrivacyPatch) -> Result<PrivacySettings, String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let mut config = store
        .get()
        .map_err(|e| format!("Reading privacy settings: {e}"))?;
    let previous = config.privacy.clone();
    if let Some(enabled) = patch.enabled {
        config.privacy.enabled = enabled;
    }
    if let Some(mask) = patch.mask_terminal_secrets {
        config.privacy.mask_terminal_secrets = mask;
    }
    if config.privacy != previous {
        config.privacy.revision = previous
            .revision
            .checked_add(1)
            .ok_or("Privacy revision exhausted")?;
        store
            .save(&config)
            .map_err(|e| format!("Saving privacy settings: {e}"))?;
    }
    Ok(config.privacy)
}

#[tauri::command]
pub(crate) fn privacy_settings(state: State<Arc<AppState>>) -> Result<PrivacySettings, String> {
    read(&state.store)
}

#[tauri::command]
pub(crate) fn set_privacy_settings(
    app: tauri::AppHandle,
    state: State<Arc<AppState>>,
    patch: PrivacyPatch,
) -> Result<PrivacySettings, String> {
    let settings = write(&state.store, patch)?;
    // The preference is already durable. A delivery failure must not report
    // that saving failed, or the initiating window would keep its old policy.
    if let Err(error) = refresh_titles(&app) {
        tracing::warn!(%error, "refreshing privacy window titles");
    }
    if let Err(error) = app.emit(EVENT, &settings) {
        tracing::warn!(%error, "broadcasting privacy settings");
    }
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_are_concealed_before_window_creation_and_keep_the_latest_original() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(ConfigStore::at_path(
            dir.path().join("config.json"),
        )));
        let state = AppState::with_store(store);
        write(
            &state.store,
            PrivacyPatch {
                enabled: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            window_title(&state, "window", "secret host"),
            "Chan (privacy mode)"
        );
        assert_eq!(
            window_title(&state, "window", "updated host"),
            "Chan (privacy mode)"
        );
        assert_eq!(
            state.privacy_titles.lock().unwrap()["window"],
            "updated host"
        );
        write(
            &state.store,
            PrivacyPatch {
                enabled: Some(false),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            window_title(&state, "window", "updated host"),
            "updated host"
        );
    }

    #[test]
    fn privacy_persists_without_replacing_other_desktop_settings() {
        let dir = tempfile::tempdir().unwrap();
        let store = Mutex::new(ConfigStore::at_path(dir.path().join("config.json")));
        let mut config = store.lock().unwrap().get().unwrap();
        config.launcher_theme = Some("dark".into());
        store.lock().unwrap().save(&config).unwrap();
        assert_eq!(read(&store).unwrap(), PrivacySettings::default());
        let on = write(
            &store,
            PrivacyPatch {
                enabled: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(on.enabled);
        assert_eq!(on.revision, 1);
        assert_eq!(
            write(
                &store,
                PrivacyPatch {
                    enabled: Some(true),
                    ..Default::default()
                }
            )
            .unwrap(),
            on
        );
        let mask = write(
            &store,
            PrivacyPatch {
                mask_terminal_secrets: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(mask.enabled && mask.mask_terminal_secrets);
        assert_eq!(mask.revision, 2);
        assert_eq!(read(&store).unwrap(), mask);
        assert_eq!(
            store
                .lock()
                .unwrap()
                .get()
                .unwrap()
                .launcher_theme
                .as_deref(),
            Some("dark")
        );
    }

    #[test]
    fn unreadable_config_never_disables_privacy_or_gets_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, "broken").unwrap();
        let store = Mutex::new(ConfigStore::at_path(path.clone()));
        assert!(read(&store).is_err());
        assert!(write(
            &store,
            PrivacyPatch {
                enabled: Some(false),
                ..Default::default()
            }
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "broken");
    }
}
