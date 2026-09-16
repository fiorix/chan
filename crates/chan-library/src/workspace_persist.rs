//! The persisted workspace on/off overlay shared by every chan-library
//! deployment.
//!
//! A chan-library's existence source is its registry (`chan workspace ls` /
//! `Library::list_workspaces`) -- the set of workspaces it owns. What the
//! registry does NOT record is whether a given deployment intends each
//! workspace to be mounted (`on`) or registered-but-unmounted (`off`). That
//! durable intent is this overlay: a [`PersistedWorkspace`] row keyed by path,
//! owned by the library and persisted in a [`WorkspaceOverlay`] store
//! co-located with the window registry (local `~/.chan/workspaces.json`,
//! devserver `~/.chan/devserver/workspaces.json`). Both the desktop-local boot
//! and the headless `run_devserver` restore route through the same store -- one
//! implementation in the library.
//!
//! The route `prefix` a workspace mounts at is deliberately NOT persisted: it is
//! a pure function of the root path, derived per library by that library's own
//! scheme (the devserver's gateway-legible slug via
//! [`allocate_workspace_prefix`](crate::allocate_workspace_prefix); a hashed
//! window label for the local desktop). Persisting it would pin one library's
//! scheme into a shape the other reads -- so each library re-derives its own
//! prefix at restore.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// One workspace's persisted mount intent plus its ordering generation.
///
/// The registry is the existence source; this overlay records whether the
/// deployment desires the row on. A row absent from the overlay defaults to
/// off. The mount prefix is re-derived per library at restore, not stored here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PersistedWorkspace {
    /// Filesystem path identifying the workspace (the registry key).
    pub path: String,
    /// Durable desired mount state. Serialized as the established `on` key.
    #[serde(rename = "on")]
    pub desired_on: bool,
    /// Per-row intent ordering generation; old overlay files start at zero.
    #[serde(default)]
    pub generation: u64,
}

impl PersistedWorkspace {
    /// Construct a new row before its first accepted intent is allocated.
    pub fn new(path: impl Into<String>, desired_on: bool) -> Self {
        Self {
            path: path.into(),
            desired_on,
            generation: 0,
        }
    }
}

/// The library's workspace on/off overlay store: the durable set of
/// [`PersistedWorkspace`] rows, persisted to `store_path`. Library-level (one
/// per library), cheap to share behind an `Arc`; installed on the
/// [`WorkspaceHost`](crate::WorkspaceHost) like the window registry, and both
/// the desktop boot and the devserver restore read/write it. Rows are sorted by
/// path on save for a stable file.
pub struct WorkspaceOverlay {
    store_path: PathBuf,
    rows: Mutex<Vec<PersistedWorkspace>>,
    // Allocated while holding the data lock; saves may acquire their lock in
    // a different order, but only newer snapshots may reach disk.
    next_save: AtomicU64,
    latest_save: Mutex<u64>,
    #[cfg(test)]
    pre_save_hook: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl WorkspaceOverlay {
    /// Open the overlay at `store_path`, loading any persisted rows. An absent
    /// or unreadable store degrades to an empty set rather than refusing to
    /// start (the workspaces reappear off, surfaced by the registry, until the
    /// user turns them back on).
    pub fn open(store_path: PathBuf) -> Self {
        let rows = match std::fs::read(&store_path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        Self {
            store_path,
            rows: Mutex::new(rows),
            next_save: AtomicU64::new(0),
            latest_save: Mutex::new(0),
            #[cfg(test)]
            pre_save_hook: Mutex::new(None),
        }
    }

    /// Upsert a workspace's desired on/off state, advance its generation, and
    /// persist. Returns the accepted generation.
    pub fn set(&self, path: &str, desired_on: bool) -> u64 {
        let generation = {
            let mut rows = self.rows.lock().unwrap_or_else(|e| e.into_inner());
            match rows.iter_mut().find(|r| r.path == path) {
                Some(row) => {
                    row.desired_on = desired_on;
                    row.generation = row.generation.wrapping_add(1);
                    row.generation
                }
                None => {
                    let mut row = PersistedWorkspace::new(path, desired_on);
                    row.generation = 1;
                    rows.push(row);
                    1
                }
            }
        };
        self.persist();
        generation
    }

    /// Forget a workspace entirely (it left the library) and persist.
    pub fn forget(&self, path: &str) {
        {
            let mut rows = self.rows.lock().unwrap_or_else(|e| e.into_inner());
            rows.retain(|r| r.path != path);
        }
        self.persist();
    }

    /// Replace the whole overlay with `new_rows` and persist. The bulk-snapshot
    /// hook (the desktop snapshots its live serve set; the devserver snapshots
    /// its registered-workspace map). For a retained path, a newer concurrently
    /// accepted generation wins over an older snapshot.
    pub fn replace(&self, mut new_rows: Vec<PersistedWorkspace>) {
        {
            let mut rows = self.rows.lock().unwrap_or_else(|e| e.into_inner());
            for replacement in &mut new_rows {
                let current = rows.iter().find(|row| row.path == replacement.path);
                match current {
                    Some(current) if replacement.generation == 0 => {
                        replacement.generation = if replacement.desired_on == current.desired_on {
                            current.generation
                        } else {
                            current.generation.wrapping_add(1)
                        };
                    }
                    None if replacement.generation == 0 => replacement.generation = 1,
                    Some(current) if current.generation > replacement.generation => {
                        *replacement = current.clone();
                    }
                    _ => {}
                }
            }
            *rows = new_rows;
        }
        self.persist();
    }

    /// The paths currently on, for the boot/restore re-serve.
    pub fn on_paths(&self) -> Vec<String> {
        self.rows
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|r| r.desired_on)
            .map(|r| r.path.clone())
            .collect()
    }

    /// Every row (on and off), for the devserver restore that tracks off rows.
    pub fn entries(&self) -> Vec<PersistedWorkspace> {
        self.rows.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Persist the current rows (sorted by path for a stable file) atomically.
    fn persist(&self) {
        let (generation, mut snapshot) = {
            let rows = self.rows.lock().unwrap_or_else(|e| e.into_inner());
            let generation = self.next_save.fetch_add(1, Ordering::Relaxed) + 1;
            (generation, rows.clone())
        };
        snapshot.sort_by(|a, b| a.path.cmp(&b.path));
        #[cfg(test)]
        {
            let hook = self.pre_save_hook.lock().unwrap().take();
            if let Some(hook) = hook {
                hook();
            }
        }
        let mut latest_save = self.latest_save.lock().unwrap_or_else(|e| e.into_inner());
        if generation <= *latest_save {
            return;
        }
        // A directory-sync error can follow a successful rename, so exclude
        // older snapshots before attempting publication.
        *latest_save = generation;
        if let Err(e) = save_atomic(&self.store_path, &snapshot) {
            tracing::warn!("persisting workspace overlay: {e}");
        }
    }
}

/// Persist pretty JSON through a unique temporary file with file and directory
/// fsync, shared with the workspace filesystem's atomic-write implementation.
pub(crate) fn save_atomic<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    chan_workspace::fs_ops::atomic_write(path, &bytes).map_err(std::io::Error::other)
}

/// A library's persisted pane-highlight colour: one hex string (or none), stored
/// at `store_path` co-located with the window registry + workspace overlay (the
/// devserver's `~/.chan/devserver/color.json`). Implements
/// [`LocalColorStore`](crate::LocalColorStore) so the headless devserver serves
/// the launcher's `local-color` route over a durable file -- each devserver
/// "sticks" to its own colour across restarts, and the desktop caches it for the
/// pane-highlight inject. Mirrors [`WorkspaceOverlay`]'s degrade-to-default open
/// + atomic save.
pub struct FileLocalColor {
    store_path: PathBuf,
    color: Mutex<Option<String>>,
    // Allocated while holding the data lock; saves may acquire their lock in
    // a different order, but only newer snapshots may reach disk.
    next_save: AtomicU64,
    latest_save: Mutex<u64>,
    #[cfg(test)]
    pre_save_hook: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl FileLocalColor {
    /// Open the colour store at `store_path`, loading the persisted hex (or none).
    /// An absent or unreadable store degrades to the default accent (`None`)
    /// rather than refusing to start.
    pub fn open(store_path: PathBuf) -> Self {
        let color = match std::fs::read(&store_path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
            Err(_) => None,
        };
        Self {
            store_path,
            color: Mutex::new(color),
            next_save: AtomicU64::new(0),
            latest_save: Mutex::new(0),
            #[cfg(test)]
            pre_save_hook: Mutex::new(None),
        }
    }
}

impl crate::LocalColorStore for FileLocalColor {
    fn get(&self) -> Option<String> {
        self.color.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn set(&self, color: Option<String>) -> Result<(), String> {
        let (generation, snapshot) = {
            let mut guard = self.color.lock().unwrap_or_else(|e| e.into_inner());
            *guard = color;
            let generation = self.next_save.fetch_add(1, Ordering::Relaxed) + 1;
            (generation, guard.clone())
        };
        #[cfg(test)]
        {
            let hook = self.pre_save_hook.lock().unwrap().take();
            if let Some(hook) = hook {
                hook();
            }
        }
        let mut latest_save = self.latest_save.lock().unwrap_or_else(|e| e.into_inner());
        if generation <= *latest_save {
            return Ok(());
        }
        // A directory-sync error can follow a successful rename, so exclude
        // older snapshots before attempting publication.
        *latest_save = generation;
        save_atomic(&self.store_path, &snapshot)
            .map_err(|e| format!("persisting local colour: {e}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn overlay() -> (WorkspaceOverlay, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let ov = WorkspaceOverlay::open(dir.path().join("workspaces.json"));
        (ov, dir)
    }

    #[test]
    fn color_save_cannot_overwrite_a_newer_snapshot() {
        use crate::LocalColorStore;
        let dir = tempfile::tempdir().expect("tempdir");
        let store = FileLocalColor::open(dir.path().join("color.json"));
        let store = std::sync::Arc::new(store);
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let wait = std::time::Duration::from_secs(5);
        *store.pre_save_hook.lock().unwrap() = Some(Box::new(move || {
            entered_tx.send(()).expect("save entered");
            release_rx.recv_timeout(wait).expect("release first save");
        }));
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let first = {
            let store = std::sync::Arc::clone(&store);
            std::thread::spawn(move || {
                store.set(Some("#123".into())).expect("first color");
                done_tx.send(()).expect("first save done");
            })
        };
        entered_rx
            .recv_timeout(wait)
            .expect("first snapshot captured");
        store.set(Some("#abc".into())).expect("second color");
        release_tx.send(()).expect("release stale snapshot");
        done_rx.recv_timeout(wait).expect("first writer finishes");
        first.join().expect("first writer");

        assert_eq!(
            FileLocalColor::open(dir.path().join("color.json")).get(),
            store.get(),
            "an older save must not replace the newer durable state"
        );
    }

    #[test]
    fn overlay_save_cannot_overwrite_a_newer_snapshot() {
        let (store, dir) = overlay();
        let store = std::sync::Arc::new(store);
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let wait = std::time::Duration::from_secs(5);
        *store.pre_save_hook.lock().unwrap() = Some(Box::new(move || {
            entered_tx.send(()).expect("save entered");
            release_rx.recv_timeout(wait).expect("release first save");
        }));
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let first = {
            let store = std::sync::Arc::clone(&store);
            std::thread::spawn(move || {
                store.set("/a", true);
                done_tx.send(()).expect("first save done");
            })
        };
        entered_rx
            .recv_timeout(wait)
            .expect("first snapshot captured");
        store.set("/b", true);
        release_tx.send(()).expect("release stale snapshot");
        done_rx.recv_timeout(wait).expect("first writer finishes");
        first.join().expect("first writer");

        assert_eq!(
            WorkspaceOverlay::open(dir.path().join("workspaces.json")).entries(),
            store.entries(),
            "an older save must not replace the newer durable state"
        );
    }

    #[test]
    fn set_upserts_and_on_paths_filters() {
        let (ov, _dir) = overlay();
        ov.set("/a", true);
        ov.set("/b", false);
        ov.set("/a", true); // idempotent upsert, no dup
        assert_eq!(ov.on_paths(), vec!["/a".to_string()]);
        assert_eq!(ov.entries().len(), 2);
    }

    #[test]
    fn set_off_keeps_a_remembered_off_row() {
        let (ov, _dir) = overlay();
        ov.set("/a", true);
        ov.set("/a", false); // toggle off → on:false row, not removed
        assert!(ov.on_paths().is_empty());
        let entries = ov.entries();
        assert_eq!(entries.len(), 1);
        assert!(!entries[0].desired_on);
    }

    #[test]
    fn forget_drops_the_row() {
        let (ov, _dir) = overlay();
        ov.set("/a", true);
        ov.forget("/a");
        assert!(ov.entries().is_empty());
    }

    #[test]
    fn reopen_restores_persisted_rows() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("workspaces.json");
        {
            let ov = WorkspaceOverlay::open(path.clone());
            ov.set("/b", true);
            ov.set("/a", false);
        }
        let reopened = WorkspaceOverlay::open(path);
        let entries = reopened.entries();
        // Sorted by path on save.
        assert_eq!(entries[0].path, "/a");
        assert!(!entries[0].desired_on);
        assert_eq!(entries[1].path, "/b");
        assert!(entries[1].desired_on);
    }

    #[test]
    fn replace_overwrites_the_whole_set() {
        let (ov, _dir) = overlay();
        ov.set("/old", true);
        ov.replace(vec![PersistedWorkspace::new("/new", true)]);
        assert_eq!(ov.on_paths(), vec!["/new".to_string()]);
        assert_eq!(ov.entries().len(), 1);
    }

    #[test]
    fn replace_cannot_overwrite_a_newer_concurrent_intent() {
        let (ov, _dir) = overlay();
        ov.set("/notes", true);
        let stale = ov.entries().pop().unwrap();
        ov.set("/notes", false);

        ov.replace(vec![stale]);

        let current = ov.entries().pop().unwrap();
        assert!(!current.desired_on);
        assert_eq!(current.generation, 2);
    }

    #[test]
    fn persisted_workspace_pins_field_names() {
        // The on-disk record field names are part of the persisted contract;
        // pin them so a rename is a visible, deliberate change.
        let mut ws = PersistedWorkspace::new("/home/u/notes", true);
        ws.generation = 7;
        let v = serde_json::to_value(&ws).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "path": "/home/u/notes",
                "on": true,
                "generation": 7
            })
        );
        assert_eq!(ws, serde_json::from_value(v).unwrap());
    }

    #[test]
    fn desired_intent_generation_survives_crash_and_old_rows_start_at_zero() {
        let old: PersistedWorkspace =
            serde_json::from_value(serde_json::json!({ "path": "/old", "on": true })).unwrap();
        assert!(old.desired_on);
        assert_eq!(old.generation, 0);

        let (ov, dir) = overlay();
        ov.set("/notes", true);
        let first = ov.entries().pop().expect("first intent");
        assert!(first.desired_on);
        assert_eq!(first.generation, 1);
        ov.set("/notes", false);
        let second = ov.entries().pop().expect("second intent");
        assert!(!second.desired_on);
        assert_eq!(second.generation, 2);

        drop(ov);
        let restored = WorkspaceOverlay::open(dir.path().join("workspaces.json"));
        assert_eq!(restored.entries(), vec![second]);
    }

    #[test]
    fn file_local_color_persists_set_and_reopen() {
        use crate::LocalColorStore;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("color.json");
        let store = FileLocalColor::open(path.clone());
        assert_eq!(store.get(), None, "absent store = default accent");
        store.set(Some("#0af".into())).expect("set");
        assert_eq!(store.get(), Some("#0af".into()));
        // A fresh open reads the persisted colour back (the devserver "sticks").
        assert_eq!(
            FileLocalColor::open(path.clone()).get(),
            Some("#0af".into())
        );
        // Clearing to None persists too.
        store.set(None).expect("clear");
        assert_eq!(FileLocalColor::open(path).get(), None);
    }
}
