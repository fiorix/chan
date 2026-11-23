//! The desktop's terminal background opacity: the `terminal.background_opacity`
//! key of the desktop's own `server.toml`, which every terminal tab the
//! desktop shows paints with, whatever tenant its window is on. A page reads
//! the value once at load through [`terminal_background_opacity`], writes the
//! Settings slider through [`set_terminal_background_opacity`] and follows
//! [`EVENT`] for every later change, whether a window's slider or a `chan
//! config set` outside the desktop wrote the file: the embedded server's
//! config watch hands every `server.toml` change to [`config_hook`].
//!
//! The desktop writes the file the way `chan config set` does rather than
//! through a tenant's `PATCH /api/config`: the clamp is the same constant,
//! the config watch refreshes every mounted local tenant and calls the hook,
//! and no tenant needs to be mounted for a write.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chan_server::{ServerConfig, TERMINAL_BACKGROUND_OPACITY_MAX, TERMINAL_BACKGROUND_OPACITY_MIN};
use serde::Serialize;
use tauri::{Emitter, Manager, State};

use crate::AppState;

/// The event every window receives when the desktop's value changes, with a
/// [`Payload`].
pub(crate) const EVENT: &str = "terminal-background-opacity";

/// The event's payload: the percent every terminal tab paints with.
#[derive(Debug, Clone, Serialize)]
struct Payload {
    percent: u32,
}

/// The settings range, applied to every value read, written or announced:
/// the file may hold any number.
fn clamp(percent: u32) -> u32 {
    percent.clamp(
        TERMINAL_BACKGROUND_OPACITY_MIN,
        TERMINAL_BACKGROUND_OPACITY_MAX,
    )
}

/// The desktop's `server.toml`: the file `ServerConfig::load` reads and
/// `chan config set` writes.
fn server_toml() -> PathBuf {
    chan_workspace::paths::config_dir().join("server.toml")
}

/// The value stored at `path`, clamped. A missing file holds the default; a
/// file that fails to load is logged and read as the default too, so a
/// window still paints rather than failing its load over a settings file.
pub(crate) fn read_from(path: &Path) -> u32 {
    match ServerConfig::load_from(path) {
        Ok(cfg) => clamp(cfg.terminal.background_opacity),
        Err(e) => {
            tracing::warn!(
                path = %path.display(),
                error = %e,
                "reading terminal.background_opacity failed; using the default"
            );
            clamp(ServerConfig::default().terminal.background_opacity)
        }
    }
}

/// Store `percent` at `path` as `chan config set` does (load, set, save) and
/// answer the clamped value. An unchanged value writes nothing, so the config
/// watch sees no event for it.
pub(crate) fn write_to(path: &Path, percent: u32) -> Result<u32, String> {
    let percent = clamp(percent);
    let mut cfg =
        ServerConfig::load_from(path).map_err(|e| format!("loading {}: {e}", path.display()))?;
    if cfg.terminal.background_opacity == percent {
        return Ok(percent);
    }
    cfg.terminal.background_opacity = percent;
    cfg.save_to(path)
        .map_err(|e| format!("saving {}: {e}", path.display()))?;
    Ok(percent)
}

/// The desktop's own value.
pub(crate) fn read() -> u32 {
    read_from(&server_toml())
}

/// Store the desktop's own value.
pub(crate) fn write(percent: u32) -> Result<u32, String> {
    write_to(&server_toml(), percent)
}

/// Tell every window the value, once per distinct value. The hook runs on
/// every `server.toml` event, the desktop's own write included, which the
/// command that wrote it has already announced; the dedupe keeps that from
/// reaching the windows twice.
pub(crate) fn publish<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &AppState,
    percent: u32,
) {
    let percent = clamp(percent);
    {
        let mut last = state
            .terminal_background_opacity
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if *last == Some(percent) {
            return;
        }
        *last = Some(percent);
    }
    if let Err(e) = app.emit(EVENT, Payload { percent }) {
        tracing::warn!(error = %e, "publishing terminal.background_opacity failed");
    }
}

/// The embedded server's hook: every change of the desktop's `server.toml`
/// reaches the windows as the value they paint with.
pub(crate) fn config_hook(app: tauri::AppHandle) -> chan_server::ServerConfigHook {
    Arc::new(move |cfg: &ServerConfig| {
        let state = app.state::<Arc<AppState>>();
        publish(&app, &state, cfg.terminal.background_opacity);
    })
}

/// The desktop's value, for a window's first paint.
#[tauri::command]
pub(crate) fn terminal_background_opacity() -> u32 {
    read()
}

/// Store the Settings slider's value and tell every window; answers the
/// clamped value the page applies.
#[tauri::command]
pub(crate) fn set_terminal_background_opacity(
    app: tauri::AppHandle,
    state: State<Arc<AppState>>,
    percent: u32,
) -> Result<u32, String> {
    let percent = write(percent)?;
    publish(&app, &state, percent);
    Ok(percent)
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::Mutex;

    use tauri::Listener;

    use crate::config::ConfigStore;

    #[test]
    fn a_missing_file_reads_the_default() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_from(&dir.path().join("server.toml")), 100);
    }

    #[test]
    fn a_stored_value_reads_clamped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("server.toml");
        std::fs::write(&path, "[terminal]\nbackground_opacity = 50\n").unwrap();
        assert_eq!(read_from(&path), 80);
        std::fs::write(&path, "[terminal]\nbackground_opacity = 90\n").unwrap();
        assert_eq!(read_from(&path), 90);
    }

    #[test]
    fn a_malformed_file_reads_the_default_and_refuses_a_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("server.toml");
        std::fs::write(&path, "terminal = = =\n").unwrap();
        assert_eq!(read_from(&path), 100);
        assert!(
            write_to(&path, 90).is_err(),
            "a write never replaces a file it cannot load"
        );
    }

    #[test]
    fn write_clamps_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("server.toml");
        // 120 clamps to the default, which a missing file already holds, so
        // nothing is written.
        assert_eq!(write_to(&path, 120).unwrap(), 100);
        assert!(!path.exists(), "an unchanged value writes nothing");
        assert_eq!(write_to(&path, 90).unwrap(), 90);
        assert_eq!(read_from(&path), 90);
        assert_eq!(
            ServerConfig::load_from(&path)
                .unwrap()
                .terminal
                .background_opacity,
            90,
            "the value lands where `chan config` reads it"
        );
        assert_eq!(write_to(&path, 10).unwrap(), 80);
        assert_eq!(read_from(&path), 80);
    }

    /// The WARN events about `terminal.ghostty` that `f` gives on this thread.
    fn ghostty_warnings<T>(f: impl FnOnce() -> T) -> (usize, T) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct Count(Arc<AtomicUsize>);
        struct Key(bool);
        impl tracing::field::Visit for Key {
            fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
                self.0 |= field.name() == "key" && value == "terminal.ghostty";
            }
            fn record_debug(&mut self, _: &tracing::field::Field, _: &dyn std::fmt::Debug) {}
        }
        impl tracing::Subscriber for Count {
            fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
                true
            }
            fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
                tracing::span::Id::from_u64(1)
            }
            fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
            fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
            fn event(&self, event: &tracing::Event<'_>) {
                let mut key = Key(false);
                event.record(&mut key);
                if key.0 && *event.metadata().level() == tracing::Level::WARN {
                    self.0.fetch_add(1, Ordering::Relaxed);
                }
            }
            fn enter(&self, _: &tracing::span::Id) {}
            fn exit(&self, _: &tracing::span::Id) {}
        }
        let count = Arc::new(AtomicUsize::new(0));
        let out = tracing::subscriber::with_default(Count(Arc::clone(&count)), f);
        (count.load(Ordering::Relaxed), out)
    }

    #[test]
    fn a_stored_terminal_ghostty_warns_once_and_a_write_drops_it() {
        // The only test in this binary that loads a stored `false`, so this
        // process's one warning is its to read.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("server.toml");
        let body = "[search]\naggression = \"aggressive\"\n\
                    [terminal]\nghostty = false\nbackground_opacity = 90\n";
        std::fs::write(&path, body).unwrap();
        let (warnings, ()) = ghostty_warnings(|| {
            assert_eq!(read_from(&path), 90);
            assert_eq!(read_from(&path), 90);
            assert_eq!(
                std::fs::read_to_string(&path).unwrap(),
                body,
                "a read leaves the file alone"
            );
            assert_eq!(write_to(&path, 85).unwrap(), 85);
            assert_eq!(read_from(&path), 85);
        });
        assert_eq!(warnings, 1, "the desktop process warns once");
        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(!saved.contains("ghostty"), "{saved}");
        assert!(saved.contains("background_opacity = 85"), "{saved}");
        assert!(saved.contains("aggression = \"aggressive\""), "{saved}");
    }

    #[test]
    fn publish_emits_once_per_distinct_value() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(ConfigStore::at_path(
            dir.path().join("config.json"),
        )));
        let state = AppState::with_store(store);
        let app = tauri::test::mock_app();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        app.listen_any(EVENT, move |event| {
            sink.lock().unwrap().push(event.payload().to_string());
        });

        publish(app.handle(), &state, 80);
        publish(app.handle(), &state, 80);
        publish(app.handle(), &state, 90);
        publish(app.handle(), &state, 120);

        assert_eq!(
            *seen.lock().unwrap(),
            vec![
                r#"{"percent":80}"#.to_string(),
                r#"{"percent":90}"#.to_string(),
                r#"{"percent":100}"#.to_string(),
            ],
            "a second publish of the same value is silent and the payload is clamped"
        );
    }
}
