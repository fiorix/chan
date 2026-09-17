//! Filesystem watcher for the chan registry.
//!
//! chan writes `~/.chan/config.toml` via atomic-rename, so we watch
//! the parent directory rather than the file itself: a `rename(tmp,
//! config.toml)` would otherwise replace the inode under our feet
//! and leave the watch dangling. The debouncer collapses bursts
//! (write + rename + chmod) into a single notification.
//!
//! The watch is on the directory, but `~/.chan/` is shared with
//! files that change far more often than the registry:
//! `preferences.toml` (pane widths, theme, editor knobs) and
//! `server.toml`, plus the atomic-write `*.tmp` siblings every
//! `store::save_toml` lands. A dir-level "anything changed" trigger
//! therefore fires `registry-changed` on routine editing (a pane
//! drag re-saves `preferences.toml`), which storms the launcher's
//! library resync for no reason. We filter the debounced
//! events down to the registry file's own name so only a real
//! registry mutation forwards to the frontend.

use std::ffi::OsStr;
use std::path::Path;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tauri::{AppHandle, Emitter, Manager};

/// Event name pushed to all webviews when the registry changes.
/// The launcher responds by resynchronizing its library view.
pub const REGISTRY_CHANGED: &str = "registry-changed";

/// Spawn a debounced watcher over the chan config directory and emit
/// `REGISTRY_CHANGED` whenever something inside changes. The returned
/// debouncer owns the background thread; drop it to stop watching.
///
/// Errors from `notify` setup are returned. Errors observed during
/// watching are logged and otherwise swallowed:
/// the user-visible failure mode is "the UI doesn't auto-refresh",
/// not "the app crashes".
pub fn spawn(app: AppHandle, registry_path: &Path) -> notify::Result<Debouncer<impl Watcher>> {
    let dir = registry_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| Path::new(".").to_path_buf());

    // The registry file's own name (`config.toml`). Debounced events
    // whose path doesn't match this are sibling writes
    // (`preferences.toml`, `server.toml`, atomic-write tmp files) and
    // must not masquerade as a registry change. Fall back to the full
    // path when the name is somehow empty so a degenerate setup still
    // forwards rather than silently going deaf.
    let registry_name = registry_path
        .file_name()
        .map(OsStr::to_os_string)
        .unwrap_or_else(|| registry_path.as_os_str().to_os_string());

    // Best-effort: if the chan config dir doesn't exist yet, create
    // it so we have something to watch. chan will populate the file
    // on first `chan workspace add`. Failure here is non-fatal.
    let _ = std::fs::create_dir_all(&dir);

    let mut debouncer = new_debouncer(
        Duration::from_millis(150),
        move |res: DebounceEventResult| match res {
            Ok(events) => {
                if registry_event_present(&events, &registry_name) {
                    refresh_embedded_library(&app);
                    if let Err(e) = app.emit(REGISTRY_CHANGED, ()) {
                        tracing::warn!(event = REGISTRY_CHANGED, error = %e, "registry event emit failed");
                    }
                }
            }
            Err(e) => tracing::warn!(error = ?e, "registry watch error"),
        },
    )?;

    debouncer
        .watcher()
        .watch(&dir, RecursiveMode::NonRecursive)?;
    Ok(debouncer)
}

fn refresh_embedded_library(app: &AppHandle) {
    let state = app.state::<std::sync::Arc<crate::AppState>>();
    let Some(embedded) = state.embedded() else {
        return;
    };
    if let Err(e) = embedded.reload_library_registry() {
        tracing::warn!(error = %e, "reloading workspace registry failed");
        return;
    }
    embedded.signal_library_change();
}

/// True when any debounced event touched the registry file itself.
/// We compare on the file name rather than the whole path because the
/// atomic-rename leaves both the tmp file and the final
/// `config.toml` in the same directory, and only the latter is a real
/// registry mutation worth telling the frontend about.
fn registry_event_present(
    events: &[notify_debouncer_mini::DebouncedEvent],
    registry_name: &OsStr,
) -> bool {
    events
        .iter()
        .any(|e| e.path.file_name() == Some(registry_name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify_debouncer_mini::{DebouncedEvent, DebouncedEventKind};
    use std::path::PathBuf;

    fn ev(path: &str) -> DebouncedEvent {
        DebouncedEvent {
            path: PathBuf::from(path),
            kind: DebouncedEventKind::Any,
        }
    }

    #[test]
    fn registry_write_forwards() {
        let name = OsStr::new("config.toml");
        let events = vec![ev("/home/u/.chan/config.toml")];
        assert!(registry_event_present(&events, name));
    }

    #[test]
    fn sibling_preferences_write_is_filtered() {
        // A pane drag re-saves preferences.toml; that must NOT look
        // like a registry change to the frontend.
        let name = OsStr::new("config.toml");
        let events = vec![ev("/home/u/.chan/preferences.toml")];
        assert!(!registry_event_present(&events, name));
    }

    #[test]
    fn atomic_tmp_sibling_is_filtered_but_final_rename_forwards() {
        // The atomic write lands a `*.tmp` then renames it onto
        // config.toml; both events arrive in one debounce burst. The
        // tmp alone is noise, but the burst that includes the final
        // name is a real mutation.
        let name = OsStr::new("config.toml");
        let tmp_only = vec![ev("/home/u/.chan/config.toml.tmp9f2a")];
        assert!(!registry_event_present(&tmp_only, name));

        let with_final = vec![
            ev("/home/u/.chan/config.toml.tmp9f2a"),
            ev("/home/u/.chan/config.toml"),
        ];
        assert!(registry_event_present(&with_final, name));
    }

    #[test]
    fn server_toml_sibling_is_filtered() {
        let name = OsStr::new("config.toml");
        let events = vec![ev("/home/u/.chan/server.toml")];
        assert!(!registry_event_present(&events, name));
    }
}
