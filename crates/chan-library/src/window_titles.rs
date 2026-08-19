//! Desktop-written, server-read map of window label -> OS title + kind.
//!
//! The OS window title (`"Terminal Window 1"`, `"🏠 /notes Window 2"`)
//! is assembled by chan-desktop when it builds the webview; the server
//! never sees it. So that `GET /api/windows` can show the title the user
//! actually reads in the title bar, the desktop writes each window's title
//! here on build / rename and removes it on destroy, and the window-list
//! join reads it back.
//!
//! The map is empty in standalone `chan serve` / plain-browser mode (no
//! desktop writes to it), so the server stays Tauri-free and those rows
//! simply carry no title -- the CLI renders a blank cell. Keeping it
//! always-present (rather than `Option`) means every tenant shares one
//! uniform map with no per-call-site branch.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// What the desktop knows about a live window that the server can't
/// derive: its OS title and its kind (terminal vs workspace).
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct WindowMeta {
    /// The OS window title, e.g. `"Terminal Window 1"`.
    pub title: String,
    /// `"terminal"` | `"workspace"` -- the window's flavour, so the list
    /// can disambiguate the ephemeral-terminal rows from workspace rows.
    pub kind: Option<String>,
}

/// Shared label -> [`WindowMeta`] map. Cloned (cheaply, it's an `Arc`)
/// onto every tenant's control-socket context and `AppState`, written by
/// the desktop through the embedded server.
#[derive(Default)]
pub struct WindowTitles {
    inner: Mutex<HashMap<String, WindowMeta>>,
}

impl WindowTitles {
    pub fn new() -> Self {
        Self::default()
    }

    /// Desktop writes on window build / rename.
    pub fn set(&self, label: &str, meta: WindowMeta) {
        self.lock().insert(label.to_string(), meta);
    }

    /// Desktop removes on `WindowEvent::Destroyed`.
    pub fn remove(&self, label: &str) {
        self.lock().remove(label);
    }

    /// Server reads when joining window-list rows. `None` for a window
    /// the desktop never registered (browser mode) or one already
    /// destroyed (a closed-but-`saved` row).
    pub fn get(&self, label: &str) -> Option<WindowMeta> {
        self.lock().get(label).cloned()
    }

    /// Recover from a poisoned lock instead of propagating the panic:
    /// the critical sections are simple map ops that can't leave the map
    /// inconsistent, and title bookkeeping must never abort a window
    /// teardown path. Mirrors `WindowPresence::lock`.
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, WindowMeta>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Convenience handle: `Arc<WindowTitles>` is what gets threaded around.
pub type SharedWindowTitles = Arc<WindowTitles>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_get_remove_round_trip() {
        let titles = WindowTitles::new();
        assert!(titles.get("terminal-win-0").is_none());
        titles.set(
            "terminal-win-0",
            WindowMeta {
                title: "Terminal Window 1".into(),
                kind: Some("terminal".into()),
            },
        );
        let meta = titles.get("terminal-win-0").expect("set then get");
        assert_eq!(meta.title, "Terminal Window 1");
        assert_eq!(meta.kind.as_deref(), Some("terminal"));
        titles.remove("terminal-win-0");
        assert!(titles.get("terminal-win-0").is_none());
    }
}
