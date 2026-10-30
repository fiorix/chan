//! Filesystem watch on the per-library config files.
//!
//! `PATCH /api/config` already pushes a `config_changed` frame to open
//! windows on write. This watch closes the other half: an edit that did
//! NOT go through the API (the `chan config` CLI, a hand-edit of
//! `server.toml` / `preferences.toml`, a synced dotfile) still refreshes
//! open windows. It reloads the changed store into `AppState` and
//! re-broadcasts `config_changed`.
//!
//! Every tenant keeps its own in-memory copy of the files, so a host that
//! mounts several (chan-desktop, a devserver) runs one watch for all of
//! them: a write through one tenant's API is then an external change to
//! every other, and reaches their windows the same way.
//!
//! Self-writes are deduped by CONTENT, not by a time window: after a
//! notify event the file is reloaded and compared against the in-memory
//! value, so an identical reload (the server's own save just landed) is a
//! no-op and the API PATCH path's own broadcast is not doubled. Only a
//! genuine external change reaches the bus. The same comparison absorbs
//! notify's habit of emitting several events per logical write.

use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, PoisonError, Weak};

use notify::{RecursiveMode, Watcher};

use crate::config::ServerConfig;
use crate::preferences::EditorPrefs;
use crate::routes::broadcast_config_changed;
use crate::state::AppState;

const SERVER_TOML: &str = "server.toml";
const PREFERENCES_TOML: &str = "preferences.toml";

/// Refresh the windows of every tenant added to it when `server.toml` or
/// `preferences.toml` in the per-library config directory (`~/.chan`, or
/// the `CHAN_HOME` override) changes on disk outside that tenant's API.
/// The owner keeps it for as long as its tenants serve; dropping it stops
/// the watch.
pub(crate) struct ConfigWatch {
    tenants: Arc<Tenants>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

impl ConfigWatch {
    pub(crate) fn new() -> Self {
        Self {
            tenants: Arc::default(),
            watcher: Mutex::new(None),
        }
    }

    /// Add a tenant, starting the watch with the first one so an owner that
    /// mounts no tenant watches nothing. A registration failure is logged and
    /// the next tenant tries again; until then external edits reach the
    /// windows at the next reload instead of failing the tenant's build.
    pub(crate) fn add(&self, state: &Arc<AppState>) {
        self.tenants.add(state);
        let mut watcher = self.watcher.lock().unwrap_or_else(PoisonError::into_inner);
        if watcher.is_some() {
            return;
        }
        match start(Arc::clone(&self.tenants)) {
            Ok(started) => *watcher = Some(started),
            Err(e) => tracing::warn!(
                error = %e,
                "config watch registration failed; external config edits reconcile on reload"
            ),
        }
    }
}

/// The tenants one watch refreshes, held weakly so the watch never keeps a
/// torn-down tenant alive.
#[derive(Default)]
struct Tenants(Mutex<Vec<Weak<AppState>>>);

impl Tenants {
    fn add(&self, state: &Arc<AppState>) {
        let mut tenants = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        tenants.retain(|tenant| tenant.strong_count() > 0);
        tenants.push(Arc::downgrade(state));
    }

    /// The tenants still serving, dropping the rest from the list.
    fn live(&self) -> Vec<Arc<AppState>> {
        let mut tenants = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        tenants.retain(|tenant| tenant.strong_count() > 0);
        tenants.iter().filter_map(Weak::upgrade).collect()
    }
}

fn start(tenants: Arc<Tenants>) -> notify::Result<notify::RecommendedWatcher> {
    let dir = chan_workspace::paths::config_dir();
    // The files are written lazily on first save; create the directory so
    // the watch registers even before any config exists on disk.
    let _ = std::fs::create_dir_all(&dir);
    let watch_dir = dir.clone();
    let mut watcher =
        notify::recommended_watcher(move |res: notify::Result<notify::Event>| match res {
            Ok(event) => dispatch(&watch_dir, &tenants, &event),
            Err(e) => tracing::warn!(error = %e, "config watch error"),
        })?;
    watcher.watch(&dir, RecursiveMode::NonRecursive)?;
    Ok(watcher)
}

/// Hand one event to every live tenant. Each compares the reloaded file with
/// its own copy, so the tenant whose write caused the event stays quiet and
/// the others refresh. The list lock is released before any reload runs.
fn dispatch(dir: &Path, tenants: &Tenants, event: &notify::Event) {
    for state in tenants.live() {
        handle_event(dir, &state, event);
    }
}

/// Reload whichever config file the event touched and re-broadcast on a
/// real change. A directory watch surfaces the atomic-rename target
/// (`save_toml` writes tmpfile + rename), so filtering by file name
/// catches the write reliably where a per-file inode watch would go
/// stale.
fn handle_event(dir: &Path, state: &AppState, event: &notify::Event) {
    if event_touches(event, SERVER_TOML) {
        reload_server_config(dir, state);
    }
    if event_touches(event, PREFERENCES_TOML) {
        reload_editor_prefs(dir, state);
    }
}

fn event_touches(event: &notify::Event, name: &str) -> bool {
    event
        .paths
        .iter()
        .any(|p| p.file_name().and_then(|n| n.to_str()) == Some(name))
}

fn reload_server_config(dir: &Path, state: &AppState) {
    let _serial = match state.config_write_serial.lock() {
        Ok(serial) => serial,
        Err(_) => {
            tracing::warn!("config write lock poisoned; skipping server config reload");
            return;
        }
    };
    let fresh = match ServerConfig::load_from(&dir.join(SERVER_TOML)) {
        Ok(cfg) => cfg,
        Err(e) => {
            tracing::warn!(error = %e, "reloading server.toml failed; keeping in-memory config");
            return;
        }
    };
    let changed = {
        let mut cur = match state.server_config.lock() {
            Ok(cur) => cur,
            Err(_) => {
                tracing::warn!("server config lock poisoned; skipping config reload");
                return;
            }
        };
        if *cur == fresh {
            false
        } else {
            *cur = fresh;
            true
        }
    };
    if changed {
        state.config_revision.fetch_add(1, Ordering::Relaxed);
        broadcast_config_changed(state);
    }
}

fn reload_editor_prefs(dir: &Path, state: &AppState) {
    let _serial = match state.config_write_serial.lock() {
        Ok(serial) => serial,
        Err(_) => {
            tracing::warn!("config write lock poisoned; skipping editor prefs reload");
            return;
        }
    };
    let fresh = match EditorPrefs::load_from(&dir.join(PREFERENCES_TOML)) {
        Ok(prefs) => prefs,
        Err(e) => {
            tracing::warn!(error = %e, "reloading preferences.toml failed; keeping in-memory prefs");
            return;
        }
    };
    let changed = {
        let mut cur = match state.editor_prefs.lock() {
            Ok(cur) => cur,
            Err(_) => {
                tracing::warn!("editor prefs lock poisoned; skipping config reload");
                return;
            }
        };
        if *cur == fresh {
            false
        } else {
            *cur = fresh;
            true
        }
    };
    if changed {
        state.config_revision.fetch_add(1, Ordering::Relaxed);
        broadcast_config_changed(state);
    }
}

#[cfg(test)]
pub(crate) fn reload_editor_prefs_for_test(dir: &Path, state: &AppState) {
    reload_editor_prefs(dir, state);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::test_support::make_test_state;
    use notify::event::{Event, EventKind};
    use tempfile::TempDir;

    fn no_frame_pending(rx: &mut tokio::sync::broadcast::Receiver<String>) -> bool {
        matches!(
            rx.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        )
    }

    #[test]
    fn reload_server_config_broadcasts_on_external_change() {
        let dir = TempDir::new().unwrap();
        std::fs::write(
            dir.path().join(SERVER_TOML),
            "[search]\naggression = \"aggressive\"\n",
        )
        .unwrap();
        let state = make_test_state(false);
        let mut rx = state.events_tx.subscribe();

        reload_server_config(dir.path(), &state);

        assert_eq!(
            state.server_config.lock().unwrap().search.aggression,
            chan_workspace::SearchAggression::Aggressive,
            "external edit is reloaded into the in-memory config"
        );
        let frame = rx.try_recv().expect("a config_changed frame");
        let json: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(json["kind"], "config_changed");
        assert_eq!(state.config_revision.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn reload_server_config_dedupes_a_self_write() {
        // The on-disk file already matches the in-memory value (the shape a
        // server-side PATCH leaves behind after its own save + broadcast).
        // A reload must NOT re-broadcast, or every PATCH would double the
        // refresh.
        let dir = TempDir::new().unwrap();
        let state = make_test_state(false);
        // Write out exactly what the in-memory default serializes to.
        state
            .server_config
            .lock()
            .unwrap()
            .save_to(&dir.path().join(SERVER_TOML))
            .unwrap();
        let mut rx = state.events_tx.subscribe();

        reload_server_config(dir.path(), &state);

        assert!(
            no_frame_pending(&mut rx),
            "an identical reload must not broadcast"
        );
        assert_eq!(state.config_revision.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn reload_server_config_ignores_retired_key_only_edit() {
        let dir = TempDir::new().unwrap();
        std::fs::write(
            dir.path().join(SERVER_TOML),
            "attachments_dir = \"media/2026\"\n",
        )
        .unwrap();
        let state = make_test_state(false);
        let mut rx = state.events_tx.subscribe();

        reload_server_config(dir.path(), &state);

        assert_eq!(
            *state.server_config.lock().unwrap(),
            ServerConfig::default()
        );
        assert!(no_frame_pending(&mut rx));
        assert_eq!(state.config_revision.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn reload_editor_prefs_broadcasts_on_external_change() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join(PREFERENCES_TOML), "theme = \"dark\"\n").unwrap();
        let state = make_test_state(false);
        let mut rx = state.events_tx.subscribe();

        reload_editor_prefs(dir.path(), &state);

        assert_eq!(
            state.editor_prefs.lock().unwrap().theme,
            crate::preferences::ThemeChoice::Dark,
            "external edit is reloaded into the in-memory prefs"
        );
        assert!(rx.try_recv().is_ok(), "a config_changed frame is broadcast");
        assert_eq!(state.config_revision.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn reload_ignores_a_malformed_file() {
        // A half-written / corrupt file must not clobber the in-memory value
        // and must not broadcast a spurious refresh.
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join(SERVER_TOML), "search = = =\n").unwrap();
        let state = make_test_state(false);
        let before = state.server_config.lock().unwrap().clone();
        let mut rx = state.events_tx.subscribe();

        reload_server_config(dir.path(), &state);

        assert_eq!(
            *state.server_config.lock().unwrap(),
            before,
            "a malformed reload keeps the in-memory config"
        );
        assert!(
            no_frame_pending(&mut rx),
            "a malformed reload does not broadcast"
        );
    }

    #[test]
    fn handle_event_routes_by_file_name_and_ignores_others() {
        let dir = TempDir::new().unwrap();
        std::fs::write(
            dir.path().join(SERVER_TOML),
            "[search]\naggression = \"conservative\"\n",
        )
        .unwrap();
        let state = make_test_state(false);
        let mut rx = state.events_tx.subscribe();

        // An unrelated file under the same dir is ignored.
        let other = Event::new(EventKind::Modify(notify::event::ModifyKind::Any))
            .add_path(dir.path().join("config.toml"));
        handle_event(dir.path(), &state, &other);
        assert!(
            no_frame_pending(&mut rx),
            "an unrelated file does not refresh config"
        );

        // A server.toml event routes to the server-config reload.
        let hit = Event::new(EventKind::Modify(notify::event::ModifyKind::Any))
            .add_path(dir.path().join(SERVER_TOML));
        handle_event(dir.path(), &state, &hit);
        assert_eq!(
            state.server_config.lock().unwrap().search.aggression,
            chan_workspace::SearchAggression::Conservative
        );
        assert!(rx.try_recv().is_ok(), "server.toml change broadcasts");
    }

    #[test]
    fn dispatch_refreshes_every_other_tenant_and_forgets_dropped_ones() {
        // One host, three tenants. The writer saved through its own API, so
        // its copy already matches the file; the reader still holds the old
        // value; the third has been torn down.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(SERVER_TOML);
        let writer = make_test_state(false);
        let reader = make_test_state(false);
        let gone = make_test_state(false);
        {
            let mut written = writer.server_config.lock().unwrap();
            written.terminal.background_opacity = 90;
            written.save_to(&path).unwrap();
        }
        let tenants = Tenants::default();
        tenants.add(&writer);
        tenants.add(&reader);
        tenants.add(&gone);
        drop(gone);
        let mut writer_rx = writer.events_tx.subscribe();
        let mut reader_rx = reader.events_tx.subscribe();

        let event = Event::new(EventKind::Modify(notify::event::ModifyKind::Any)).add_path(path);
        dispatch(dir.path(), &tenants, &event);

        let reloaded = reader
            .server_config
            .lock()
            .unwrap()
            .terminal
            .background_opacity;
        assert_eq!(reloaded, 90, "the other tenant reloads the write");
        assert!(reader_rx.try_recv().is_ok(), "and refreshes its windows");
        assert_eq!(reader.config_revision.load(Ordering::Relaxed), 2);
        assert!(
            no_frame_pending(&mut writer_rx),
            "the writer already pushed its own change"
        );
        assert_eq!(writer.config_revision.load(Ordering::Relaxed), 1);
        assert_eq!(tenants.live().len(), 2, "a dropped tenant leaves the list");
    }

    #[test]
    fn tenants_hold_no_tenant_alive() {
        let tenants = Tenants::default();
        let state = make_test_state(false);
        let weak = Arc::downgrade(&state);
        tenants.add(&state);
        drop(state);
        assert!(weak.upgrade().is_none());
        assert!(tenants.live().is_empty());
    }
}
