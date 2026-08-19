//! Per-library drafts for windows with no workspace behind them.
//!
//! A standalone terminal window edits the machine's own filesystem through
//! [`crate::MiniWorkspace`], which deliberately carries no workspace
//! machinery, so its drafts cannot live in-tree the way a workspace's
//! `.Drafts/` does. `DraftStore` holds them under an embedder-injected
//! state root instead (the desktop's `~/.chan`, a devserver's
//! `~/.chan/devserver`), wrapping the same path-parameterized [`drafts`]
//! and [`trash`] primitives a `Workspace` wraps with its own roots. The
//! embedder decides the root, exactly like the session store beside it,
//! because only the embedder knows which host identity it is.
//!
//! Layout under the injected root:
//!
//!   <root>/Drafts/<name>/...                    one directory per draft
//!   <root>/drafts-trash/<id>/{payload,meta.json} discarded drafts, flat
//!
//! `Drafts` is capitalized because it is user content a person browses
//! through the standalone File Browser (the convention `.Drafts` and the
//! cloud `Chan` directory set); `drafts-trash` is lowercase machine state.
//! The trash root is dedicated and flat: entries sit directly under it in
//! the exact shape `trash::{list,sweep_expired,restore,purge_one}` handle,
//! and nothing else is ever placed inside (see the layout note in
//! `trash.rs` for why nesting inside a swept root destroys data).
//!
//! Draft content under `Drafts/` is served to windows as ordinary wire
//! paths over the standalone capability root, so reading and editing a
//! draft rides the existing `/api/fs` lanes with no special routing. This
//! store only owns the lifecycle: create, list, inspect, discard into its
//! trash, and promote to a caller-resolved destination. Promotion targets
//! MUST be resolved by the `MiniWorkspace` facade (wire dialect, symlink
//! policy, protected paths); this store never resolves target paths so a
//! guard cannot exist in one facade and be missing here.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::drafts::{self, DraftInspection, DraftIssue, DraftPromoteReport, DraftRef};
use crate::error::{ChanError, Result};
use crate::fs_ops;
use crate::trash::{self, TrashEntry, TRASH_RETENTION_SECS};

/// User-visible drafts directory name under the injected store root.
const DRAFTS_DIR_NAME: &str = "Drafts";

/// Dedicated flat trash root for discarded drafts, sibling of `Drafts`.
const TRASH_DIR_NAME: &str = "drafts-trash";

/// Trash origin-label prefix for a discarded library draft. `Drafts`, not
/// `.Drafts`: the label doubles as the restore destination relative to the
/// store root, and the store's directory is not dot-hidden.
const TRASH_LABEL: &str = "Drafts";

/// One per-library drafts store. Cheap to share behind an `Arc`; the
/// internal mutex serializes the mutating draft operations because two
/// windows on one shared tenant are the common case and the primitives
/// carry no locking of their own.
pub struct DraftStore {
    /// Canonical injected root; restore destinations resolve against it.
    root_canon: PathBuf,
    /// `<root>/Drafts`, canonical-rooted. Materializes lazily on the
    /// first create so an untouched host has no `Drafts/`.
    drafts_dir: PathBuf,
    /// `<root>/drafts-trash`, canonical-rooted. Materializes on the
    /// first discard.
    trash_dir: PathBuf,
    write_serial: Mutex<()>,
}

impl DraftStore {
    /// Open the store rooted at `store_root`, creating the root itself
    /// (but neither subdirectory) and canonicalizing it. Canonicalization
    /// is load-bearing: the serving layer maps `drafts_dir()` to a wire
    /// path by stripping the capability root's canonical form, and a
    /// symlinked component would make every served path unreadable
    /// through the symlink-inert facade. A symlink squatting on either
    /// subdirectory name is refused for the same reason.
    pub fn open(store_root: &Path) -> Result<Self> {
        std::fs::create_dir_all(store_root).map_err(|e| {
            ChanError::Io(format!(
                "failed to create drafts store root {}: {e}",
                store_root.display()
            ))
        })?;
        let root_canon = store_root.canonicalize().map_err(|e| {
            ChanError::Io(format!(
                "canonicalize drafts store root {}: {e}",
                store_root.display()
            ))
        })?;
        let drafts_dir = root_canon.join(DRAFTS_DIR_NAME);
        let trash_dir = root_canon.join(TRASH_DIR_NAME);
        for dir in [&drafts_dir, &trash_dir] {
            if let Ok(meta) = std::fs::symlink_metadata(dir) {
                if meta.file_type().is_symlink() {
                    return Err(ChanError::Io(format!(
                        "drafts store entry {} is a symlink; refusing an aliased store",
                        dir.display()
                    )));
                }
            }
        }
        let store = Self {
            root_canon,
            drafts_dir,
            trash_dir,
            write_serial: Mutex::new(()),
        };
        store.sweep_expired();
        Ok(store)
    }

    /// Absolute canonical-rooted drafts directory. May not exist until
    /// the first create.
    pub fn drafts_dir(&self) -> &Path {
        &self.drafts_dir
    }

    /// Pick the smallest unused `untitled-N` name, the same algorithm the
    /// workspace lane uses: `untitled`, then `untitled-1`, filling gaps.
    /// Racy against a concurrent creator by design; `create_draft_dir`
    /// refuses the loser, who retries with a re-resolved name.
    pub fn next_untitled_name(&self) -> Result<String> {
        let existing = self.list()?;
        let names: std::collections::HashSet<&str> =
            existing.iter().map(|d| d.name.as_str()).collect();
        if !names.contains("untitled") {
            return Ok("untitled".to_string());
        }
        let mut i: u32 = 1;
        loop {
            let candidate = format!("untitled-{i}");
            if !names.contains(candidate.as_str()) {
                return Ok(candidate);
            }
            i += 1;
        }
    }

    /// Create a draft directory by name, materializing `Drafts/` lazily.
    pub fn create_draft_dir(&self, name: &str) -> Result<DraftRef> {
        let _serial = self.serial();
        drafts::create_dir(&self.drafts_dir, name)
    }

    /// Atomically write the draft's primary file (`draft.md`, or the
    /// diagram's `<name>.excalidraw`). `file_name` is a bare leaf; the
    /// draft directory must already exist so a write cannot resurrect a
    /// concurrently discarded draft.
    pub fn write_primary(&self, name: &str, file_name: &str, content: &str) -> Result<()> {
        drafts::validate_name(name)?;
        drafts::validate_name(file_name)?;
        let _serial = self.serial();
        let dir = self.drafts_dir.join(name);
        match std::fs::symlink_metadata(&dir) {
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
            Ok(_) => {
                return Err(ChanError::Io(format!(
                    "draft `{name}` is not a directory at {}",
                    dir.display()
                )))
            }
            Err(e) => {
                return Err(ChanError::Io(format!(
                    "draft `{name}` is not available at {}: {e}",
                    dir.display()
                )))
            }
        }
        fs_ops::atomic_write(&dir.join(file_name), content.as_bytes())
    }

    /// Enumerate drafts, sorted by name. Empty when `Drafts/` does not
    /// exist yet.
    pub fn list(&self) -> Result<Vec<DraftRef>> {
        drafts::list(&self.drafts_dir)
    }

    /// Inspect one draft's shape (file/dir counts, attachments).
    pub fn inspect(&self, name: &str) -> Result<DraftInspection> {
        drafts::inspect(&self.drafts_dir, name)
    }

    /// Inspect every draft and report non-fatal problems.
    pub fn preflight(&self) -> Result<Vec<DraftIssue>> {
        drafts::preflight(&self.drafts_dir)
    }

    /// Move a draft into this store's trash as a first-class flat entry
    /// labeled `Drafts/<name>`, so it lists, restores to its original
    /// place, and expires like any other soft delete.
    pub fn discard(&self, name: &str) -> Result<()> {
        let _serial = self.serial();
        self.sweep_locked();
        drafts::discard_labeled(&self.drafts_dir, &self.trash_dir, name, TRASH_LABEL)
    }

    /// Promote a draft to a caller-resolved destination. `target_abs` and
    /// `target_rel` MUST come from `MiniWorkspace::resolve_write_target`
    /// (or an equally guarded resolver): this store applies the shared
    /// promotion semantics (no-clobber, merge preflight, atomic staging)
    /// but deliberately does no path resolution of its own.
    pub fn promote_to(
        &self,
        name: &str,
        target_abs: &Path,
        target_rel: &str,
    ) -> Result<DraftPromoteReport> {
        let _serial = self.serial();
        let scan = drafts::scan_draft(&self.drafts_dir, name)?;
        drafts::promote_scanned(scan, target_abs, target_rel)
    }

    /// List trash entries, newest first, after a lazy sweep.
    pub fn trash_list(&self) -> Result<Vec<TrashEntry>> {
        self.sweep_expired();
        trash::list(&self.trash_dir)
    }

    /// Restore a trash entry to its original place under the store root
    /// (`Drafts/<name>`). Refuses with `TrashOccupied` when a live draft
    /// already sits there.
    pub fn trash_restore(&self, id: &str) -> Result<trash::RestoredEntry> {
        let _serial = self.serial();
        self.sweep_locked();
        trash::restore(&self.trash_dir, &self.root_canon, &self.root_canon, id)
    }

    /// Permanently delete one trash entry.
    pub fn trash_purge(&self, id: &str) -> Result<()> {
        let _serial = self.serial();
        self.sweep_locked();
        trash::purge_one(&self.trash_dir, id)
    }

    /// Permanently delete every trash entry.
    pub fn trash_empty(&self) -> Result<()> {
        let _serial = self.serial();
        trash::purge_all(&self.trash_dir)
    }

    /// Lazy GC of expired trash entries (30-day retention, shared
    /// constant). Best-effort: a corrupt trash dir must never block a
    /// draft operation. Runs on open and on every mutating trash path;
    /// no background thread, matching the sync-only rule.
    pub fn sweep_expired(&self) {
        let _serial = self.serial();
        self.sweep_locked();
    }

    fn sweep_locked(&self) {
        let _ = trash::sweep_expired(&self.trash_dir, TRASH_RETENTION_SECS);
    }

    fn serial(&self) -> std::sync::MutexGuard<'_, ()> {
        self.write_serial
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn store() -> (TempDir, DraftStore) {
        let tmp = TempDir::new().unwrap();
        let store = DraftStore::open(&tmp.path().join("state")).unwrap();
        (tmp, store)
    }

    #[test]
    fn open_creates_and_canonicalizes_the_root_lazily_leaving_subdirs_alone() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("state");
        let store = DraftStore::open(&root).unwrap();
        assert!(root.is_dir(), "store root is created");
        assert!(
            store.drafts_dir().starts_with(root.canonicalize().unwrap()),
            "drafts dir hangs off the canonical root"
        );
        assert!(
            !store.drafts_dir().exists(),
            "Drafts/ does not exist before the first create"
        );
        assert!(store.list().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn open_refuses_a_symlinked_drafts_dir() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("state");
        std::fs::create_dir_all(root.join("elsewhere")).unwrap();
        std::os::unix::fs::symlink(root.join("elsewhere"), root.join("Drafts")).unwrap();
        assert!(DraftStore::open(&root).is_err());
    }

    #[test]
    fn untitled_names_count_up_through_gaps() {
        let (_t, store) = store();
        assert_eq!(store.next_untitled_name().unwrap(), "untitled");
        store.create_draft_dir("untitled").unwrap();
        assert_eq!(store.next_untitled_name().unwrap(), "untitled-1");
        store.create_draft_dir("untitled-2").unwrap();
        assert_eq!(store.next_untitled_name().unwrap(), "untitled-1");
    }

    #[test]
    fn write_primary_requires_the_draft_dir_and_a_bare_leaf() {
        let (_t, store) = store();
        assert!(
            store
                .write_primary("untitled", "draft.md", "# x\n")
                .is_err(),
            "a write must not resurrect a missing draft dir"
        );
        store.create_draft_dir("untitled").unwrap();
        store
            .write_primary("untitled", "draft.md", "# x\n")
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(store.drafts_dir().join("untitled/draft.md")).unwrap(),
            "# x\n"
        );
        assert!(store.write_primary("untitled", "a/b.md", "x").is_err());
        assert!(store.write_primary("untitled", "..", "x").is_err());
    }

    #[test]
    fn discard_lands_flat_labeled_entries_that_restore_in_place() {
        let (_t, store) = store();
        store.create_draft_dir("untitled").unwrap();
        store
            .write_primary("untitled", "draft.md", "# keep\n")
            .unwrap();

        store.discard("untitled").unwrap();

        assert!(!store.drafts_dir().join("untitled").exists());
        let entries = store.trash_list().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].original_path, "Drafts/untitled");
        assert!(entries[0].is_dir);
        let restored = store.trash_restore(&entries[0].id).unwrap();
        assert_eq!(restored.rel_path, "Drafts/untitled");
        assert_eq!(
            std::fs::read_to_string(store.drafts_dir().join("untitled/draft.md")).unwrap(),
            "# keep\n"
        );
    }

    #[test]
    fn trash_restore_refuses_when_a_live_draft_occupies_the_name() {
        let (_t, store) = store();
        store.create_draft_dir("untitled").unwrap();
        store.write_primary("untitled", "draft.md", "v1").unwrap();
        store.discard("untitled").unwrap();
        store.create_draft_dir("untitled").unwrap();
        store.write_primary("untitled", "draft.md", "v2").unwrap();

        let id = store.trash_list().unwrap()[0].id.clone();
        let err = store.trash_restore(&id).unwrap_err();
        assert!(matches!(err, ChanError::TrashOccupied(_)));
        assert_eq!(
            std::fs::read_to_string(store.drafts_dir().join("untitled/draft.md")).unwrap(),
            "v2"
        );
    }

    #[test]
    fn trash_purge_and_empty_delete_permanently() {
        let (_t, store) = store();
        for name in ["a", "b"] {
            store.create_draft_dir(name).unwrap();
            store.write_primary(name, "draft.md", "x").unwrap();
            store.discard(name).unwrap();
        }
        let entries = store.trash_list().unwrap();
        assert_eq!(entries.len(), 2);
        store.trash_purge(&entries[0].id).unwrap();
        assert_eq!(store.trash_list().unwrap().len(), 1);
        store.trash_empty().unwrap();
        assert!(store.trash_list().unwrap().is_empty());
    }

    #[test]
    fn promote_moves_a_single_file_draft_to_the_resolved_target() {
        let (tmp, store) = store();
        store.create_draft_dir("untitled").unwrap();
        store
            .write_primary(
                "untitled",
                "untitled.excalidraw",
                "{\"type\":\"excalidraw\"}",
            )
            .unwrap();
        let dest_root = tmp.path().join("dest");
        std::fs::create_dir_all(&dest_root).unwrap();

        let report = store
            .promote_to(
                "untitled",
                &dest_root.join("board.excalidraw"),
                "home/user/board.excalidraw",
            )
            .unwrap();

        assert_eq!(report.target_path, "home/user/board.excalidraw");
        assert_eq!(report.mode, crate::drafts::DraftPromoteMode::File);
        assert!(!store.drafts_dir().join("untitled").exists());
        assert_eq!(
            std::fs::read_to_string(dest_root.join("board.excalidraw")).unwrap(),
            "{\"type\":\"excalidraw\"}"
        );
    }

    #[test]
    fn promote_refuses_an_occupied_target_and_keeps_the_draft() {
        let (tmp, store) = store();
        store.create_draft_dir("untitled").unwrap();
        store
            .write_primary("untitled", "draft.md", "# x\n")
            .unwrap();
        let dest = tmp.path().join("dest/note.md");
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::write(&dest, "existing").unwrap();

        let err = store
            .promote_to("untitled", &dest, "home/user/note.md")
            .unwrap_err();

        assert!(matches!(err, ChanError::PathAlreadyExists(_)));
        assert!(store.drafts_dir().join("untitled").exists());
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "existing");
    }

    #[test]
    fn sweep_reclaims_backdated_entries_on_open() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("state");
        {
            let store = DraftStore::open(&root).unwrap();
            store.create_draft_dir("old").unwrap();
            store.write_primary("old", "draft.md", "x").unwrap();
            store.discard("old").unwrap();
            // Backdate the entry past the retention window.
            let id = store.trash_list().unwrap()[0].id.clone();
            let meta_path = root.join(TRASH_DIR_NAME).join(&id).join("meta.json");
            let raw = std::fs::read_to_string(&meta_path).unwrap();
            let backdated = raw.replace(
                &format!("\"deleted_at\": {}", extract_deleted_at(&raw)),
                &format!(
                    "\"deleted_at\": {}",
                    extract_deleted_at(&raw) - TRASH_RETENTION_SECS - 1
                ),
            );
            std::fs::write(&meta_path, backdated).unwrap();
        }
        let store = DraftStore::open(&root).unwrap();
        assert!(store.trash_list().unwrap().is_empty());
    }

    fn extract_deleted_at(meta_json: &str) -> i64 {
        let value: serde_json::Value = serde_json::from_str(meta_json).unwrap();
        value["deleted_at"].as_i64().unwrap()
    }
}
