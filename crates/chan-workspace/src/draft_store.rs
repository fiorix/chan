//! Draft lifecycle store outside a workspace's user tree.
//!
//! A standalone terminal window edits the machine's own filesystem through
//! [`crate::MiniWorkspace`], which deliberately carries no workspace
//! machinery. A registered workspace also keeps new drafts outside its
//! user root, under its metadata-key sidecar. `DraftStore` wraps the same
//! path-parameterized [`drafts`] and [`trash`] primitives for both: the
//! standalone embedder injects its state root (the desktop's `~/.chan`,
//! or a devserver's `~/.chan/devserver`), while `Workspace` injects its
//! `<chan home>/workspaces/<metadata_key>` root.
//!
//! Layout under the injected root:
//!
//! ```text
//! <root>/Drafts/<name>/...                     one directory per draft
//! <root>/drafts-trash/<id>/{payload,meta.json} discarded drafts, flat
//! <root>/drafts-staging/<name>.<stamp>/...     drafts being built or retired
//! ```
//!
//! Registered workspace drafts also carry a private `.chan-draft-id` file
//! containing `v1:` plus 64 lowercase SHA-256 hex digits and a newline.
//! Its input combines timestamp, PID, a process counter and process entropy.
//! This is a non-secret stale-writer identity, not an authorization token;
//! the draft file facade hides it and promotion excludes it. Standalone
//! drafts do not create or hide the marker.
//!
//! `Drafts` is capitalized because draft text is user content; the
//! standalone File Browser can browse it directly, while a workspace
//! window uses a distinct draft file root. `drafts-trash` and
//! `drafts-staging` are lowercase machine state.
//!
//! A workspace store's creates and promotions never leave a half-made or a
//! half-removed draft in `Drafts/`. A new draft is built under
//! `drafts-staging/` (its marker, then its seeded primary) and
//! published by one rename that refuses an existing name, and a promotion
//! retires its source into `drafts-staging/` by one rename before removing
//! it, so the list, the preflight and name allocation, which read `Drafts/`
//! without a lock, see a draft complete or not at all. The two directories
//! are siblings under the canonical store root, so the rename is atomic
//! within one filesystem (`RENAME_NOREPLACE` on Linux, `RENAME_EXCL` on
//! macOS) or one volume (`MoveFileExW` on Windows), unless one of the names
//! is a mount point; then the rename answers `EXDEV` or
//! `ERROR_NOT_SAME_DEVICE` and the create fails and removes its entry,
//! copying nothing. A filesystem without the no-replace flag takes the
//! check-then-rename fallback of `no_replace`, where a writer outside chan
//! that makes an empty `Drafts/<name>` between the check and the rename has
//! it replaced rather than refused. On Windows a scanner holding a
//! just-written file open refuses the move, and the create fails the same
//! way, as a discard's move into `drafts-trash` can.
//! The trash root is dedicated and flat: entries sit directly under it in
//! the exact shape `trash::{list,sweep_expired,restore,purge_one}` handle,
//! and nothing else is ever placed inside (see the layout note in
//! `trash.rs` for why nesting inside a swept root destroys data).
//!
//! Draft content under `Drafts/` is served over the standalone capability
//! root in Files or a separate draft root in a workspace. This store owns
//! lifecycle only: create, list, inspect, discard into its trash, and
//! promote to a caller-resolved destination. Promotion targets MUST be
//! resolved by `MiniWorkspace::resolve_write_target` or the workspace's
//! corresponding facade method; this store never resolves target paths.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::drafts::{self, DraftInspection, DraftIssue, DraftPromoteReport, DraftRef};
use crate::error::{ChanError, Result};
use crate::fs_ops;
use crate::trash::{self, TrashEmptyReport, TrashEntry, TRASH_RETENTION_SECS};

/// User-visible drafts directory name under the injected store root.
const DRAFTS_DIR_NAME: &str = "Drafts";

/// Dedicated flat trash root for discarded drafts, sibling of `Drafts`.
const TRASH_DIR_NAME: &str = "drafts-trash";

/// Where a workspace draft is built before it is published into `Drafts/`
/// and where a promoted draft's source is retired before it is removed.
const STAGING_DIR_NAME: &str = "drafts-staging";

/// Age past which a staging entry is swept when a workspace opens. An entry
/// that old belongs to a create or a promotion that died with its process:
/// the sweep runs only inside `Workspace::open`, which holds the workspace's
/// writer lock, so no other process works in this store meanwhile, and a
/// reopen in this process waits for the earlier handle's operations to
/// drain. That, not the age, is why the sweep cannot meet a live operation;
/// the hour is margin.
const STAGING_MAX_AGE: Duration = Duration::from_secs(60 * 60);

/// Trash origin-label prefix for a discarded library draft. `Drafts`, not
/// `.Drafts`: the label doubles as the restore destination relative to the
/// store root, and the store's directory is not dot-hidden.
const TRASH_LABEL: &str = "Drafts";

static NEXT_DRAFT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, PartialEq, Eq)]
enum StoreMode {
    Standalone,
    Workspace,
}

/// One store per standalone library or registered workspace. Cheap to
/// share behind an `Arc`; its mutex serializes mutating operations because
/// the underlying primitives carry no locking of their own.
pub struct DraftStore {
    /// Canonical injected root; restore destinations resolve against it.
    root_canon: PathBuf,
    /// `<root>/Drafts`, canonical-rooted. Materializes lazily on the
    /// first create so an untouched host has no `Drafts/`.
    drafts_dir: PathBuf,
    /// `<root>/drafts-trash`, canonical-rooted. Materializes on the
    /// first discard.
    trash_dir: PathBuf,
    /// `<root>/drafts-staging`, canonical-rooted. Materializes on the first
    /// create or promotion of a workspace draft.
    staging_dir: PathBuf,
    mode: StoreMode,
    write_serial: Mutex<()>,
    /// Names being created, which [`Self::next_untitled_name`] skips so two
    /// creators in this process never build the same name at once.
    reserved: Mutex<HashSet<String>>,
}

/// A name held for one create, from its check to its publish or failure.
/// Dropping it releases the name, also when the create unwinds, so a name is
/// never left reserved for the life of the process.
struct Reservation<'a> {
    store: &'a DraftStore,
    name: String,
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        self.store
            .reserved
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.name);
    }
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
        Self::open_with_mode(store_root, StoreMode::Standalone)
    }

    /// Workspace drafts carry a private lifetime marker. Standalone Files
    /// uses `open` and keeps its existing visible file layout.
    pub(crate) fn open_workspace(store_root: &Path) -> Result<Self> {
        Self::open_with_mode(store_root, StoreMode::Workspace)
    }

    fn open_with_mode(store_root: &Path, mode: StoreMode) -> Result<Self> {
        std::fs::create_dir_all(store_root).map_err(|e| {
            ChanError::io_with_context(
                e,
                format!(
                    "failed to create drafts store root {}",
                    store_root.display()
                ),
            )
        })?;
        let root_canon = store_root.canonicalize().map_err(|e| {
            ChanError::io_with_context(
                e,
                format!("canonicalize drafts store root {}", store_root.display()),
            )
        })?;
        let drafts_dir = root_canon.join(DRAFTS_DIR_NAME);
        let trash_dir = root_canon.join(TRASH_DIR_NAME);
        let staging_dir = root_canon.join(STAGING_DIR_NAME);
        for dir in [&drafts_dir, &trash_dir, &staging_dir] {
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
            staging_dir,
            mode,
            write_serial: Mutex::new(()),
            reserved: Mutex::new(HashSet::new()),
        };
        store.sweep_expired();
        if mode == StoreMode::Workspace {
            drafts::sweep_staging(&store.staging_dir, STAGING_MAX_AGE);
        }
        Ok(store)
    }

    /// Absolute canonical-rooted drafts directory. May not exist until
    /// the first create.
    pub fn drafts_dir(&self) -> &Path {
        &self.drafts_dir
    }

    /// Pick the smallest unused `untitled-N` name, the same algorithm the
    /// workspace lane uses: `untitled`, then `untitled-1`, filling gaps. A
    /// name being created in this process counts as used. Racy against a
    /// creator elsewhere by design; the create refuses the loser, who
    /// retries with a re-resolved name.
    pub fn next_untitled_name(&self) -> Result<String> {
        let existing = self.list()?;
        let reserved = self.reserved.lock().unwrap_or_else(PoisonError::into_inner);
        let names: HashSet<&str> = existing
            .iter()
            .map(|d| d.name.as_str())
            .chain(reserved.iter().map(String::as_str))
            .collect();
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

    /// Create a draft whole and publish it as `Drafts/<name>`: its staging
    /// entry gets the lifetime marker (a workspace store's) and then the
    /// primary file `primary_leaf` seeded with `content`, and one rename that
    /// refuses an existing name moves it into `Drafts/`. Returns the lifetime
    /// ID a workspace store wrote; a standalone store writes none. A name
    /// that is a draft, or is being created in this process, is
    /// `PathAlreadyExists`, and so is one taken while the draft is built. A
    /// failure before the rename removes the entry and publishes nothing.
    pub(crate) fn create_draft(
        &self,
        name: &str,
        primary_leaf: &str,
        content: &str,
    ) -> Result<Option<String>> {
        drafts::validate_name(name)?;
        drafts::validate_name(primary_leaf)?;
        if self.mode == StoreMode::Workspace
            && primary_leaf.eq_ignore_ascii_case(drafts::WORKSPACE_ID_FILE)
        {
            return Err(ChanError::ProtectedPath(primary_leaf.to_string()));
        }
        let _reserved = self.reserve(name)?;
        let stage_error =
            |error| ChanError::io_with_context(error, format!("failed to stage draft `{name}`"));
        let entry = drafts::staging_entry(&self.staging_dir, name).map_err(stage_error)?;
        std::fs::create_dir(&entry).map_err(stage_error)?;
        let created = self
            .stage(&entry, primary_leaf, content)
            .and_then(|id| self.publish(&entry, name).map(|()| id));
        if created.is_err() {
            // A published entry has left this path, so this removes only
            // one that never reached `Drafts/`.
            let _ = std::fs::remove_dir_all(&entry);
        }
        created
    }

    /// Hold `name` for one create.
    fn reserve(&self, name: &str) -> Result<Reservation<'_>> {
        let _serial = self.serial();
        let mut reserved = self.reserved.lock().unwrap_or_else(PoisonError::into_inner);
        if reserved.contains(name) || std::fs::symlink_metadata(self.drafts_dir.join(name)).is_ok()
        {
            return Err(ChanError::PathAlreadyExists(name.to_string()));
        }
        reserved.insert(name.to_string());
        Ok(Reservation {
            store: self,
            name: name.to_string(),
        })
    }

    /// Write a draft's marker (a workspace store's) and its primary file
    /// into the staging `entry`.
    fn stage(&self, entry: &Path, primary_leaf: &str, content: &str) -> Result<Option<String>> {
        #[cfg(any(test, feature = "test-hooks"))]
        crate::draft_hold::reached(&self.drafts_dir, crate::draft_hold::DIRECTORY_MADE, entry)?;
        let id = if self.mode == StoreMode::Workspace {
            Some(self.write_marker(entry)?)
        } else {
            None
        };
        #[cfg(any(test, feature = "test-hooks"))]
        crate::draft_hold::reached(&self.drafts_dir, crate::draft_hold::MARKER_WRITTEN, entry)?;
        fs_ops::atomic_write(&entry.join(primary_leaf), content.as_bytes())?;
        #[cfg(any(test, feature = "test-hooks"))]
        crate::draft_hold::reached(&self.drafts_dir, crate::draft_hold::PRIMARY_WRITTEN, entry)?;
        Ok(id)
    }

    /// Move the staging `entry` to `Drafts/<name>` in one rename that refuses
    /// an existing destination, then sync both parents so the move survives
    /// a crash. The staged files are closed by now, which a Windows move of
    /// their directory needs.
    fn publish(&self, entry: &Path, name: &str) -> Result<()> {
        let _serial = self.serial();
        std::fs::create_dir_all(&self.drafts_dir).map_err(|error| {
            ChanError::io_with_context(
                error,
                format!(
                    "failed to create drafts directory {}",
                    self.drafts_dir.display()
                ),
            )
        })?;
        let root =
            cap_std::fs::Dir::open_ambient_dir(&self.root_canon, cap_std::ambient_authority())
                .map_err(|error| {
                    ChanError::io_with_context(
                        error,
                        format!(
                            "failed to open drafts store root {}",
                            self.root_canon.display()
                        ),
                    )
                })?;
        let staged =
            Path::new(STAGING_DIR_NAME).join(entry.file_name().ok_or(ChanError::PathEmpty)?);
        let published = Path::new(DRAFTS_DIR_NAME).join(name);
        crate::no_replace::rename(&root, &staged, &published).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                ChanError::PathAlreadyExists(name.to_string())
            } else {
                ChanError::io_with_context(error, format!("failed to publish draft `{name}`"))
            }
        })?;
        fs_ops::sync_dir(&self.drafts_dir)?;
        fs_ops::sync_dir(&self.staging_dir)?;
        Ok(())
    }

    /// Create an empty draft directory by name, materializing `Drafts/`
    /// lazily. A workspace store writes its lifetime marker into it. Until a
    /// primary file exists the directory lists as a broken draft, so a draft
    /// for a person is created whole through `create_draft`.
    pub fn create_draft_dir(&self, name: &str) -> Result<DraftRef> {
        let _serial = self.serial();
        let created = drafts::create_dir(&self.drafts_dir, name)?;
        if self.mode == StoreMode::Workspace {
            if let Err(error) = self.write_new_id(&created.abs) {
                let _ = std::fs::remove_dir_all(&created.abs);
                return Err(error);
            }
        }
        Ok(created)
    }

    /// Durable identity for a workspace draft; clients use it only to
    /// reject stale writes after a name is discarded and reused.
    pub fn draft_id(&self, name: &str) -> Result<String> {
        if self.mode != StoreMode::Workspace {
            return Err(ChanError::Io(
                "standalone drafts have no workspace lifetime ID".into(),
            ));
        }
        drafts::workspace_id(&self.drafts_dir, name)
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
        if self.mode == StoreMode::Workspace {
            self.draft_id(name)?;
            if file_name.eq_ignore_ascii_case(drafts::WORKSPACE_ID_FILE) {
                return Err(ChanError::ProtectedPath(file_name.to_string()));
            }
        }
        match std::fs::symlink_metadata(&dir) {
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
            Ok(_) => {
                return Err(ChanError::Io(format!(
                    "draft `{name}` is not a directory at {}",
                    dir.display()
                )))
            }
            Err(e) => {
                return Err(ChanError::io_with_context(
                    e,
                    format!("draft `{name}` is not available at {}", dir.display()),
                ))
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
        if self.mode == StoreMode::Workspace {
            drafts::inspect_workspace(&self.drafts_dir, name)
        } else {
            drafts::inspect(&self.drafts_dir, name)
        }
    }

    /// Inspect every draft and report non-fatal problems.
    pub fn preflight(&self) -> Result<Vec<DraftIssue>> {
        if self.mode == StoreMode::Workspace {
            drafts::preflight_workspace(&self.drafts_dir)
        } else {
            drafts::preflight(&self.drafts_dir)
        }
    }

    /// Move a draft into this store's trash as a first-class flat entry
    /// labeled `Drafts/<name>`, so it lists, restores to its original
    /// place, and expires like any other soft delete.
    pub fn discard(&self, name: &str) -> Result<()> {
        let _serial = self.serial();
        self.sweep_locked();
        drafts::discard_labeled(&self.drafts_dir, &self.trash_dir, name, TRASH_LABEL)
    }

    /// Discard by name only while a workspace draft has no readable identity.
    /// A healthy draft must use its ID and the server's lifecycle boundary.
    pub(crate) fn discard_broken(&self, name: &str) -> Result<()> {
        let _serial = self.serial();
        match self.draft_id(name) {
            Err(ChanError::DraftBroken { .. }) => {}
            Ok(_) | Err(ChanError::NotFound(_)) => {
                return Err(crate::draft_files::stale_draft(name));
            }
            Err(error) => return Err(error),
        }
        self.sweep_locked();
        drafts::discard_labeled(&self.drafts_dir, &self.trash_dir, name, TRASH_LABEL)
    }

    /// Promote a draft to a caller-resolved destination. `target_abs` and
    /// `target_rel` MUST come from `MiniWorkspace::resolve_write_target`
    /// (or `Workspace::resolve_write_target`): this store applies the shared
    /// promotion semantics (no-clobber, merge preflight, atomic staging)
    /// but deliberately does no path resolution of its own.
    pub fn promote_to(
        &self,
        name: &str,
        target_abs: &Path,
        target_rel: &str,
    ) -> Result<DraftPromoteReport> {
        let _serial = self.serial();
        let scan = if self.mode == StoreMode::Workspace {
            drafts::scan_workspace_draft(&self.drafts_dir, name)?.retiring_into(&self.staging_dir)
        } else {
            drafts::scan_draft(&self.drafts_dir, name)?
        };
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
        let restored = trash::restore(&self.trash_dir, &self.root_canon, &self.root_canon, id)?;
        if self.mode == StoreMode::Workspace {
            let path = self.root_canon.join(&restored.rel_path);
            match std::fs::remove_file(path.join(drafts::WORKSPACE_ID_FILE)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            self.write_new_id(&path)?;
        }
        Ok(restored)
    }

    /// Permanently delete one trash entry.
    pub fn trash_purge(&self, id: &str) -> Result<()> {
        let _serial = self.serial();
        self.sweep_locked();
        trash::purge_one(&self.trash_dir, id)
    }

    /// Permanently delete every trash entry except the ones holding the
    /// only copy of a draft, which stay until purged by id with
    /// `trash_purge`. The report counts both.
    pub fn trash_empty(&self) -> Result<TrashEmptyReport> {
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

    /// Write a fresh lifetime marker into `dir` and return its ID.
    fn write_marker(&self, dir: &Path) -> Result<String> {
        let id = mint_draft_id();
        fs_ops::atomic_write(
            &dir.join(drafts::WORKSPACE_ID_FILE),
            format!("{id}\n").as_bytes(),
        )?;
        Ok(id)
    }

    fn write_new_id(&self, dir: &Path) -> Result<()> {
        self.write_marker(dir)?;
        fs_ops::sync_dir(&self.drafts_dir)?;
        Ok(())
    }
}

/// A non-secret `v1:` identity. Timestamp, PID and a process counter make
/// creation order distinct; RandomState supplies process entropy, and the
/// existing SHA-256 dependency folds the components into fixed-length text.
fn mint_draft_id() -> String {
    use std::hash::{BuildHasher, Hasher};

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let pid = std::process::id();
    let sequence = NEXT_DRAFT_ID.fetch_add(1, Ordering::Relaxed);
    let mut process_entropy = std::collections::hash_map::RandomState::new().build_hasher();
    process_entropy.write_u128(nanos);
    process_entropy.write_u32(pid);
    process_entropy.write_u64(sequence);
    let mut digest = Sha256::new();
    digest.update(nanos.to_le_bytes());
    digest.update(pid.to_le_bytes());
    digest.update(sequence.to_le_bytes());
    digest.update(process_entropy.finish().to_le_bytes());
    format!("v1:{:x}", digest.finalize())
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

    fn workspace_store() -> (TempDir, std::sync::Arc<DraftStore>) {
        let tmp = TempDir::new().unwrap();
        let store = DraftStore::open_workspace(&tmp.path().join("state")).unwrap();
        (tmp, std::sync::Arc::new(store))
    }

    /// The entries under the store's staging directory; none when it is
    /// absent.
    fn staged(store: &DraftStore) -> Vec<String> {
        match std::fs::read_dir(&store.staging_dir) {
            Ok(entries) => entries
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => panic!("read the staging directory: {error}"),
        }
    }

    #[test]
    fn a_name_taken_while_its_draft_is_staged_refuses_the_publish() {
        let (_root, store) = workspace_store();
        let occupier = store.drafts_dir().join("untitled");
        let taken = occupier.clone();
        crate::draft_hold::on_step(
            store.drafts_dir(),
            crate::draft_hold::PRIMARY_WRITTEN,
            move |_| std::fs::create_dir_all(&taken),
        );

        let refused = store
            .create_draft("untitled", "draft.md", "# staged\n")
            .unwrap_err();

        assert!(
            matches!(refused, ChanError::PathAlreadyExists(ref name) if name == "untitled"),
            "{refused:?}"
        );
        assert_eq!(
            std::fs::read_dir(&occupier).unwrap().count(),
            0,
            "the publish replaced the empty directory that took its name"
        );
        assert_eq!(staged(&store), Vec::<String>::new());
        std::fs::remove_dir(&occupier).unwrap();
        store
            .create_draft("untitled", "draft.md", "# staged\n")
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(occupier.join("draft.md")).unwrap(),
            "# staged\n"
        );
    }

    #[test]
    fn a_name_being_created_is_not_offered_again() {
        let (_root, store) = workspace_store();
        let offered = std::sync::Arc::new(Mutex::new(None));
        let (seen, asker) = (offered.clone(), store.clone());
        crate::draft_hold::on_step(
            store.drafts_dir(),
            crate::draft_hold::PRIMARY_WRITTEN,
            move |_| {
                let name = asker
                    .next_untitled_name()
                    .map_err(|error| std::io::Error::other(error.to_string()))?;
                *seen.lock().unwrap() = Some(name);
                Ok(())
            },
        );

        store.create_draft("untitled", "draft.md", "# x\n").unwrap();

        assert_eq!(offered.lock().unwrap().as_deref(), Some("untitled-1"));
    }

    #[test]
    fn a_create_that_unwinds_releases_its_name() {
        let (_root, store) = workspace_store();
        crate::draft_hold::on_step(
            store.drafts_dir(),
            crate::draft_hold::MARKER_WRITTEN,
            |_| panic!("an unwind inside a staged create"),
        );

        let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            store.create_draft("untitled", "draft.md", "# x\n")
        }));

        assert!(unwound.is_err());
        assert_eq!(store.next_untitled_name().unwrap(), "untitled");
    }

    #[test]
    fn a_workspace_open_sweeps_staging_entries_older_than_an_hour() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("state");
        drop(DraftStore::open_workspace(&root).unwrap());
        let staging = root.canonicalize().unwrap().join(STAGING_DIR_NAME);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let old = staging.join(format!("untitled.{}.1.0", now - 2 * 60 * 60));
        let fresh = staging.join(format!("untitled.{now}.1.1"));
        let foreign = staging.join("notes");
        for dir in [&old, &fresh, &foreign] {
            std::fs::create_dir_all(dir.join("inner")).unwrap();
        }

        let _reopened = DraftStore::open_workspace(&root).unwrap();

        assert!(!old.exists(), "an entry two hours old survived the open");
        assert!(fresh.exists(), "the open swept an entry stamped now");
        assert!(foreign.exists(), "the open swept a name it did not make");
    }

    #[test]
    fn draft_collision_standalone_is_typed() {
        let (_root, store) = store();
        store.create_draft_dir("occupied").unwrap();
        let error = store.create_draft_dir("occupied").unwrap_err();
        assert!(
            matches!(error, ChanError::PathAlreadyExists(ref path) if path == "occupied"),
            "unexpected collision: {error:?}"
        );
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
        let created = store.create_draft_dir("untitled").unwrap();
        assert!(
            !created.abs.join(drafts::WORKSPACE_ID_FILE).exists(),
            "standalone Files must keep its visible draft layout"
        );
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
    fn workspace_discard_and_restore_accept_a_missing_identity_marker() {
        let root = TempDir::new().unwrap();
        let store = DraftStore::open_workspace(&root.path().join("state")).unwrap();
        let draft = store.create_draft_dir("broken").unwrap();
        let old_id = store.draft_id("broken").unwrap();
        store
            .write_primary("broken", "draft.md", "# retained\n")
            .unwrap();
        std::fs::remove_file(draft.abs.join(drafts::WORKSPACE_ID_FILE)).unwrap();
        assert!(matches!(
            store.inspect("broken"),
            Err(ChanError::DraftBroken { .. })
        ));

        store.discard("broken").unwrap();
        assert!(!draft.abs.exists());
        let entry = store.trash_list().unwrap().remove(0);
        store.trash_restore(&entry.id).unwrap();
        assert_eq!(
            std::fs::read_to_string(draft.abs.join("draft.md")).unwrap(),
            "# retained\n"
        );
        assert_ne!(store.draft_id("broken").unwrap(), old_id);
    }

    #[test]
    fn workspace_primary_refuses_folded_identity_name() {
        let root = TempDir::new().unwrap();
        let store = DraftStore::open_workspace(&root.path().join("state")).unwrap();
        store.create_draft_dir("a").unwrap();
        assert!(matches!(
            store.write_primary("a", ".CHAN-DRAFT-ID", "replacement"),
            Err(ChanError::ProtectedPath(_))
        ));
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
        assert_eq!(
            store.trash_empty().unwrap(),
            TrashEmptyReport {
                removed: 1,
                kept_for_recovery: 0
            }
        );
        assert!(store.trash_list().unwrap().is_empty());
    }

    #[test]
    fn trash_empty_keeps_an_entry_marked_for_recovery() {
        let (_t, store) = store();
        store.create_draft_dir("ordinary").unwrap();
        store.write_primary("ordinary", "draft.md", "x").unwrap();
        store.discard("ordinary").unwrap();
        // The meta write fails and the undo is blocked, so the trash entry
        // holds the only copy of the draft and carries the recovery marker.
        store.create_draft_dir("keep").unwrap();
        store
            .write_primary("keep", "draft.md", "the only copy")
            .unwrap();
        trash::inject_test_meta_write_failure(
            &store.trash_dir,
            Some(&store.drafts_dir().join("keep")),
        );
        store.discard("keep").unwrap_err();
        let marked = trash::recovery_marked_ids(&store.trash_dir);
        assert_eq!(marked.len(), 1);
        let payload = store.trash_dir.join(&marked[0]).join("payload");

        let report = store.trash_empty().unwrap();

        assert_eq!(
            report,
            TrashEmptyReport {
                removed: 1,
                kept_for_recovery: 1
            }
        );
        assert!(store.trash_list().unwrap().is_empty());
        assert_eq!(
            std::fs::read_to_string(payload.join("draft.md"))
                .ok()
                .as_deref(),
            Some("the only copy"),
            "empty trash destroyed the only remaining copy"
        );

        store.trash_purge(&marked[0]).unwrap();
        assert!(!payload.exists());
        assert!(trash::recovery_marked_ids(&store.trash_dir).is_empty());
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
