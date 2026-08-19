// Per-workspace Trash. Soft-delete model: `Workspace::remove` moves the
// entry here instead of unlinking it. Apps can list, restore, purge,
// or empty. Expired entries are GC'd lazily on `Workspace::open` and on
// every `trash_*` call (no background thread; matches the codebase's
// sync-only API rule).
//
// Layout (under `paths.trash`, which is `state_dir/trash/<key>/`):
//
//   trash/<key>/
//     <id>/
//       payload | payload/   the moved file or directory
//       meta.json            written LAST so a half-written entry
//                            (e.g. crash mid-copy on a cross-fs
//                            workspace) has no meta and the next sweep
//                            treats it as junk.
//
// `<id>` is `unix_nanos`, with a `-N` suffix retry on the rare
// same-nanosecond collision. Opaque to callers.
//
// A trash root contains ONLY entry dirs. Never nest another store (or
// any non-entry file) inside a swept root: the sweep classifies any
// child without a parsable meta.json as a half-written entry and
// reclaims it wholesale, so a nested bucket is destroyed on the next
// sweep no matter what it holds.
//
// Cross-filesystem note: state_dir and the workspace root may be on
// different mounts (external disk, network workspace). We try
// `fs::rename` first (atomic on the same fs); on failure we fall
// back to copy-then-remove. The fallback writes meta.json BEFORE
// removing the source, so a remove failure leaves a complete trash
// entry plus a partial source (recoverable) instead of data loss.

use std::fs;
use std::io;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{ChanError, Result};
use crate::fs_ops;

/// 30 days. Hardcoded for v1; promote to a `Library` setting later
/// if users want to tune it.
pub const TRASH_RETENTION_SECS: i64 = 30 * 24 * 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Meta {
    /// POSIX-style relative path from the workspace root the entry came
    /// from. Used as the restore destination.
    original_path: String,
    /// Unix seconds at the time of soft-delete.
    deleted_at: i64,
    /// True iff the trashed item is a directory.
    is_dir: bool,
    /// File length, or summed lengths for a directory tree.
    size: u64,
}

/// One entry visible to callers. Owned strings + primitives so the
/// type round-trips cleanly through uniffi later.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrashEntry {
    pub id: String,
    pub original_path: String,
    pub deleted_at: i64,
    pub is_dir: bool,
    pub size: u64,
}

/// Move `src_abs` (an absolute path inside the workspace) into the trash
/// at `trash_dir`, recording `original_rel` as the restore target.
///
/// Same-fs path: one atomic `rename`. Cross-fs path: copy, write
/// meta, then remove the source (so a failure to delete the source
/// leaves a complete trash entry the user can purge or restore from).
pub fn move_into(trash_dir: &Path, src_abs: &Path, original_rel: &str, is_dir: bool) -> Result<()> {
    fs::create_dir_all(trash_dir)?;
    let id = allocate_id(trash_dir)?;
    let entry_dir = trash_dir.join(&id);
    fs::create_dir(&entry_dir)?;
    let payload = entry_dir.join("payload");

    let size = if is_dir {
        dir_size(src_abs).unwrap_or(0)
    } else {
        fs::symlink_metadata(src_abs).map(|m| m.len()).unwrap_or(0)
    };

    if fs::rename(src_abs, &payload).is_ok() {
        // Atomic same-fs move. Source is gone; payload is in place.
        write_meta(&entry_dir, original_rel, size, is_dir)?;
        return Ok(());
    }

    // Cross-fs fallback. Copy first, fsync the copied bytes so a
    // crash after `write_meta` cannot leave a "complete" trash entry
    // pointing at non-durable payload bytes, then write meta, then
    // drop source. `fs::copy` does not fsync; without the explicit
    // sync, the meta atomic_write only guarantees the meta itself.
    if is_dir {
        copy_dir(src_abs, &payload)?;
        fs_ops::sync_tree(&payload)?;
    } else {
        fs::copy(src_abs, &payload)?;
        fs_ops::sync_file(&payload)?;
    }
    write_meta(&entry_dir, original_rel, size, is_dir)?;
    if is_dir {
        fs::remove_dir_all(src_abs)?;
    } else {
        fs::remove_file(src_abs)?;
    }
    Ok(())
}

pub fn list(trash_dir: &Path) -> Result<Vec<TrashEntry>> {
    let mut out = Vec::new();
    let rd = match fs::read_dir(trash_dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e.into()),
    };
    for entry in rd.flatten() {
        let id = entry.file_name().to_string_lossy().into_owned();
        let meta_path = entry.path().join("meta.json");
        // Half-written or corrupt entries are silently skipped here;
        // sweep_expired's mtime-blind cleanup catches them later.
        let raw = match fs::read(&meta_path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let meta: Meta = match serde_json::from_slice(&raw) {
            Ok(m) => m,
            Err(_) => continue,
        };
        out.push(TrashEntry {
            id,
            original_path: meta.original_path,
            deleted_at: meta.deleted_at,
            is_dir: meta.is_dir,
            size: meta.size,
        });
    }
    out.sort_by_key(|e| std::cmp::Reverse(e.deleted_at));
    Ok(out)
}

/// Summary of a successful `restore`: what came out of the trash
/// and where it now lives. The caller (`Workspace::trash_restore`) uses
/// this to workspace a graph + search re-index of the restored subtree
/// without re-reading meta.json or re-walking from the trash side.
#[derive(Debug, Clone)]
pub struct RestoredEntry {
    /// Workspace-relative POSIX path the entry was restored to.
    pub rel_path: String,
    /// Whether the restored entry is a directory subtree.
    pub is_dir: bool,
}

pub fn restore(
    trash_dir: &Path,
    workspace_root: &Path,
    workspace_root_canon: &Path,
    id: &str,
) -> Result<RestoredEntry> {
    let entry_dir = trash_dir.join(id);
    let meta_path = entry_dir.join("meta.json");
    let raw = match fs::read(&meta_path) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Err(ChanError::TrashEntryNotFound(id.to_string()));
        }
        Err(e) => return Err(e.into()),
    };
    let meta: Meta = serde_json::from_slice(&raw).map_err(|e| ChanError::TrashCorrupt {
        id: id.to_string(),
        message: format!("meta decode: {e}"),
    })?;

    let payload = entry_dir.join("payload");
    if fs::symlink_metadata(&payload).is_err() {
        return Err(ChanError::TrashCorrupt {
            id: id.to_string(),
            message: "payload missing".into(),
        });
    }

    // The leaf doesn't exist yet (we're restoring), so the strict
    // resolve canonicalizes the deepest existing ancestor. That's
    // enough to catch mid-path symlinks pointing outside the workspace.
    // The Workspace caller passes its cached canonical root so we don't
    // re-canonicalize on every restore.
    let dest = fs_ops::resolve_safe_strict_canon(
        workspace_root,
        workspace_root_canon,
        &meta.original_path,
    )?;
    if fs::symlink_metadata(&dest).is_ok() {
        return Err(ChanError::TrashOccupied(meta.original_path.clone()));
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }

    if fs::rename(&payload, &dest).is_err() {
        // Cross-fs again: copy, fsync, then drop the trash payload.
        // Without the fsync, a crash between copy and remove can
        // leave a non-durable destination plus a still-present trash
        // entry. With it, the destination is durable; if the remove
        // races a crash the trash entry survives but the destination
        // is intact (next list will show TrashOccupied if the user
        // tries to re-restore, prompting a manual purge).
        if meta.is_dir {
            copy_dir(&payload, &dest)?;
            fs_ops::sync_tree(&dest)?;
            fs::remove_dir_all(&payload)?;
        } else {
            fs::copy(&payload, &dest)?;
            fs_ops::sync_file(&dest)?;
            fs::remove_file(&payload)?;
        }
    }

    // Drop the now-empty entry. Best-effort; sweep cleans leftovers.
    let _ = fs::remove_file(&meta_path);
    let _ = fs::remove_dir(&entry_dir);
    Ok(RestoredEntry {
        rel_path: meta.original_path,
        is_dir: meta.is_dir,
    })
}

pub fn purge_one(trash_dir: &Path, id: &str) -> Result<()> {
    let entry_dir = trash_dir.join(id);
    match fs::symlink_metadata(&entry_dir) {
        Ok(_) => {
            fs::remove_dir_all(&entry_dir)?;
            Ok(())
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            Err(ChanError::TrashEntryNotFound(id.to_string()))
        }
        Err(e) => Err(e.into()),
    }
}

/// Permanently delete every trash entry. Reports per-entry totals so
/// the caller can distinguish "wiped clean" from "filesystem refused
/// some entries". Previous behavior was to log-and-continue and
/// return `Ok(())`, which made a fully-failed empty look identical
/// to a successful one. We now bubble up an error when at least one
/// entry remained AND nothing was successfully removed; partial
/// success returns Ok with the failed entries logged.
pub fn purge_all(trash_dir: &Path) -> Result<()> {
    let rd = match fs::read_dir(trash_dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    let mut removed = 0usize;
    let mut failed = 0usize;
    let mut last_err: Option<std::io::Error> = None;
    for entry in rd.flatten() {
        match fs::remove_dir_all(entry.path()) {
            Ok(()) => removed += 1,
            Err(e) => {
                failed += 1;
                tracing::warn!(?e, path = ?entry.path(), "purge_all: failed to remove entry");
                last_err = Some(e);
            }
        }
    }
    if removed == 0 && failed > 0 {
        // Total failure: the trash is unchanged and the caller's UX
        // ("trash emptied") would be a lie. Surface the last error.
        return Err(ChanError::Io(format!(
            "purge_all: 0 of {failed} entries removed; last error: {}",
            last_err
                .map(|e| e.to_string())
                .unwrap_or_else(|| "unknown".into()),
        )));
    }
    Ok(())
}

/// Best-effort sweep: drop entries whose `deleted_at + retention_secs`
/// is in the past, plus any entry whose meta is missing or corrupt
/// (those are crash leftovers, not user content).
pub fn sweep_expired(trash_dir: &Path, retention_secs: i64) -> Result<()> {
    let rd = match fs::read_dir(trash_dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    let cutoff = now_secs() - retention_secs;
    for entry in rd.flatten() {
        let entry_dir = entry.path();
        let meta_path = entry_dir.join("meta.json");
        let expired = match fs::read(&meta_path) {
            Ok(b) => match serde_json::from_slice::<Meta>(&b) {
                Ok(m) => m.deleted_at <= cutoff,
                // Corrupt meta -> treat as junk and reclaim.
                Err(_) => true,
            },
            // Missing meta -> half-written entry. Reclaim.
            Err(_) => true,
        };
        if expired {
            let _ = fs::remove_dir_all(&entry_dir);
        }
    }
    Ok(())
}

/// Hoist complete entries out of a nested bucket (`trash_dir/<bucket>/<id>`)
/// up into `trash_dir` itself, where the flat contract puts them.
///
/// Older releases discarded drafts into a `drafts/` bucket nested inside
/// the workspace trash root. The sweep reads such a bucket as one
/// meta-less junk entry and reclaims it wholesale (see the layout note
/// above), so any complete entries still inside are rescued here BEFORE
/// the first sweep runs. Entries move under their existing id (suffixed
/// on collision); children without a parsable meta.json stay behind and
/// are reclaimed with the bucket by the next sweep, exactly as junk
/// always is.
pub(crate) fn hoist_nested_entries(trash_dir: &Path, bucket: &str) -> Result<()> {
    let bucket_dir = trash_dir.join(bucket);
    let rd = match fs::read_dir(&bucket_dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    for entry in rd.flatten() {
        let entry_dir = entry.path();
        let complete = fs::read(entry_dir.join("meta.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Meta>(&b).ok())
            .is_some();
        if !complete {
            continue;
        }
        let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let mut dest = trash_dir.join(&id);
        let mut n = 1u32;
        while fs::symlink_metadata(&dest).is_ok() {
            dest = trash_dir.join(format!("{id}-{n}"));
            n += 1;
        }
        if let Err(error) = fs::rename(&entry_dir, &dest) {
            tracing::warn!(entry = %entry_dir.display(), %error, "failed to hoist nested trash entry");
        }
    }
    // An emptied bucket disappears now; one still holding junk is left
    // for the sweep, which reclaims it as the meta-less entry it is.
    let _ = fs::remove_dir(&bucket_dir);
    Ok(())
}

fn write_meta(entry_dir: &Path, original_rel: &str, size: u64, is_dir: bool) -> Result<()> {
    let meta = Meta {
        original_path: original_rel.to_string(),
        deleted_at: now_secs(),
        is_dir,
        size,
    };
    let bytes = serde_json::to_vec_pretty(&meta).map_err(|e| ChanError::Io(e.to_string()))?;
    fs_ops::atomic_write(&entry_dir.join("meta.json"), &bytes)
}

fn allocate_id(trash_dir: &Path) -> Result<String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // 19 digits fits any date the i64-ns mtime convention can
    // produce (max ~2262), so lexicographic id sort tracks
    // chronological order for diagnostics. Suffix-retry covers the
    // rare same-nanosecond burst (and tests that mock time).
    let mut id = format!("{nanos:019}");
    let mut n = 1u32;
    while trash_dir.join(&id).exists() {
        id = format!("{nanos:019}-{n}");
        n += 1;
    }
    Ok(id)
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn copy_dir(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if ft.is_dir() {
            copy_dir(&src_path, &dst_path)?;
        } else if ft.is_file() {
            fs::copy(&src_path, &dst_path)?;
        }
        // Symlinks / FIFOs / sockets / devices inside a trashed
        // directory are dropped on the cross-fs path. chan-workspace
        // never creates them, and the same-fs rename path preserves
        // them anyway.
    }
    Ok(())
}

fn dir_size(path: &Path) -> Result<u64> {
    let mut total = 0u64;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        // lstat (symlink_metadata), not metadata: the latter follows
        // symlinks. A user dir containing `link -> /` would otherwise
        // recurse outside the workspace and double-count the host fs.
        // chan-workspace never creates symlinks itself, but a third-party
        // tool inside the user's notes tree might.
        let meta = match entry.path().symlink_metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let ft = meta.file_type();
        if ft.is_symlink() {
            continue;
        }
        if meta.is_dir() {
            total = total.saturating_add(dir_size(&entry.path()).unwrap_or(0));
        } else if meta.is_file() {
            total = total.saturating_add(meta.len());
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn ts() -> (TempDir, std::path::PathBuf) {
        let tmp = TempDir::new().unwrap();
        let trash = tmp.path().join("trash");
        (tmp, trash)
    }

    #[test]
    fn move_into_then_list_round_trips() {
        let workspace = TempDir::new().unwrap();
        let src = workspace.path().join("a.md");
        std::fs::write(&src, b"hi").unwrap();
        let (_t, trash) = ts();
        move_into(&trash, &src, "a.md", false).unwrap();
        assert!(!src.exists(), "source should be moved");
        let entries = list(&trash).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].original_path, "a.md");
        assert!(!entries[0].is_dir);
        assert_eq!(entries[0].size, 2);
    }

    #[test]
    fn restore_brings_file_back() {
        let workspace = TempDir::new().unwrap();
        let src = workspace.path().join("notes/a.md");
        std::fs::create_dir_all(src.parent().unwrap()).unwrap();
        std::fs::write(&src, b"hello").unwrap();
        let (_t, trash) = ts();
        move_into(&trash, &src, "notes/a.md", false).unwrap();
        let id = list(&trash).unwrap()[0].id.clone();
        restore(
            &trash,
            workspace.path(),
            &workspace.path().canonicalize().unwrap(),
            &id,
        )
        .unwrap();
        assert_eq!(std::fs::read(&src).unwrap(), b"hello");
        assert!(list(&trash).unwrap().is_empty());
    }

    #[test]
    fn restore_refuses_when_dest_exists() {
        let workspace = TempDir::new().unwrap();
        let src = workspace.path().join("a.md");
        std::fs::write(&src, b"v1").unwrap();
        let (_t, trash) = ts();
        move_into(&trash, &src, "a.md", false).unwrap();
        std::fs::write(&src, b"v2").unwrap();
        let id = list(&trash).unwrap()[0].id.clone();
        let err = restore(
            &trash,
            workspace.path(),
            &workspace.path().canonicalize().unwrap(),
            &id,
        )
        .unwrap_err();
        assert!(matches!(err, ChanError::TrashOccupied(_)));
        // Trash entry still present; user can purge or pick a new path.
        assert_eq!(list(&trash).unwrap().len(), 1);
        assert_eq!(std::fs::read(&src).unwrap(), b"v2");
    }

    #[test]
    fn move_into_recursive_directory() {
        let workspace = TempDir::new().unwrap();
        let dir = workspace.path().join("notes");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.md"), b"a").unwrap();
        std::fs::write(dir.join("sub/b.md"), b"bb").unwrap();
        let (_t, trash) = ts();
        move_into(&trash, &dir, "notes", true).unwrap();
        assert!(!dir.exists());
        let entries = list(&trash).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].is_dir);
        assert_eq!(entries[0].size, 3); // 1 + 2 bytes
        let id = entries[0].id.clone();
        restore(
            &trash,
            workspace.path(),
            &workspace.path().canonicalize().unwrap(),
            &id,
        )
        .unwrap();
        assert_eq!(std::fs::read(dir.join("a.md")).unwrap(), b"a");
        assert_eq!(std::fs::read(dir.join("sub/b.md")).unwrap(), b"bb");
    }

    #[test]
    fn purge_one_removes_entry() {
        let workspace = TempDir::new().unwrap();
        let src = workspace.path().join("a.md");
        std::fs::write(&src, b"x").unwrap();
        let (_t, trash) = ts();
        move_into(&trash, &src, "a.md", false).unwrap();
        let id = list(&trash).unwrap()[0].id.clone();
        purge_one(&trash, &id).unwrap();
        assert!(list(&trash).unwrap().is_empty());
        assert!(matches!(
            purge_one(&trash, &id).unwrap_err(),
            ChanError::TrashEntryNotFound(_)
        ));
    }

    #[test]
    fn purge_all_clears_everything() {
        let workspace = TempDir::new().unwrap();
        let (_t, trash) = ts();
        for i in 0..3 {
            let src = workspace.path().join(format!("f{i}.md"));
            std::fs::write(&src, b"x").unwrap();
            move_into(&trash, &src, &format!("f{i}.md"), false).unwrap();
        }
        assert_eq!(list(&trash).unwrap().len(), 3);
        purge_all(&trash).unwrap();
        assert!(list(&trash).unwrap().is_empty());
    }

    #[test]
    fn sweep_drops_expired_entries() {
        let workspace = TempDir::new().unwrap();
        let src = workspace.path().join("old.md");
        std::fs::write(&src, b"x").unwrap();
        let (_t, trash) = ts();
        move_into(&trash, &src, "old.md", false).unwrap();
        // Backdate the meta to before the cutoff.
        let id = list(&trash).unwrap()[0].id.clone();
        let meta_path = trash.join(&id).join("meta.json");
        let mut m: Meta = serde_json::from_slice(&fs::read(&meta_path).unwrap()).unwrap();
        m.deleted_at = now_secs() - TRASH_RETENTION_SECS - 1;
        fs::write(&meta_path, serde_json::to_vec_pretty(&m).unwrap()).unwrap();
        sweep_expired(&trash, TRASH_RETENTION_SECS).unwrap();
        assert!(list(&trash).unwrap().is_empty());
    }

    #[test]
    fn sweep_reclaims_entry_with_missing_meta() {
        let (_t, trash) = ts();
        std::fs::create_dir_all(trash.join("orphan")).unwrap();
        std::fs::write(trash.join("orphan/payload"), b"junk").unwrap();
        sweep_expired(&trash, TRASH_RETENTION_SECS).unwrap();
        assert!(!trash.join("orphan").exists());
    }

    #[test]
    fn hoist_rescues_nested_entries_before_the_sweep_reads_them_as_junk() {
        let workspace = TempDir::new().unwrap();
        let (_t, trash) = ts();
        // A complete entry inside a nested `drafts/` bucket, the layout
        // older releases wrote for discarded drafts.
        let src = workspace.path().join("untitled-1");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("draft.md"), b"# hello\n").unwrap();
        move_into(&trash.join("drafts"), &src, ".Drafts/untitled-1", true).unwrap();
        // Invisible to the flat lister while nested.
        assert!(list(&trash).unwrap().is_empty());

        hoist_nested_entries(&trash, "drafts").unwrap();

        let entries = list(&trash).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].original_path, ".Drafts/untitled-1");
        assert!(entries[0].is_dir);
        assert!(!trash.join("drafts").exists(), "emptied bucket removed");
        // The hoisted entry is a first-class citizen: the sweep keeps it.
        sweep_expired(&trash, TRASH_RETENTION_SECS).unwrap();
        assert_eq!(list(&trash).unwrap().len(), 1);
        // And it restores through the normal lane.
        let restored = restore(
            &trash,
            workspace.path(),
            &workspace.path().canonicalize().unwrap(),
            &entries[0].id,
        )
        .unwrap();
        assert_eq!(restored.rel_path, ".Drafts/untitled-1");
        assert_eq!(
            std::fs::read(workspace.path().join(".Drafts/untitled-1/draft.md")).unwrap(),
            b"# hello\n"
        );
    }

    #[test]
    fn hoist_suffixes_on_id_collision_and_leaves_junk_for_the_sweep() {
        let workspace = TempDir::new().unwrap();
        let (_t, trash) = ts();
        let src = workspace.path().join("a.md");
        std::fs::write(&src, b"flat").unwrap();
        move_into(&trash, &src, "a.md", false).unwrap();
        let flat_id = list(&trash).unwrap()[0].id.clone();
        // A nested entry whose id collides with the flat one, plus a
        // meta-less junk sibling.
        let nested = trash.join("drafts").join(&flat_id);
        std::fs::create_dir_all(nested.join("payload")).unwrap();
        std::fs::write(
            nested.join("meta.json"),
            serde_json::to_vec_pretty(&Meta {
                original_path: ".Drafts/untitled-1".into(),
                deleted_at: now_secs(),
                is_dir: true,
                size: 0,
            })
            .unwrap(),
        )
        .unwrap();
        std::fs::create_dir_all(trash.join("drafts/half-written")).unwrap();

        hoist_nested_entries(&trash, "drafts").unwrap();

        let mut paths: Vec<String> = list(&trash)
            .unwrap()
            .into_iter()
            .map(|e| e.original_path)
            .collect();
        paths.sort();
        assert_eq!(
            paths,
            vec![".Drafts/untitled-1".to_string(), "a.md".to_string()]
        );
        assert!(
            trash.join(format!("{flat_id}-1")).is_dir(),
            "collision suffixed"
        );
        // Junk stays behind for the sweep, which reclaims bucket and all.
        assert!(trash.join("drafts/half-written").is_dir());
        sweep_expired(&trash, TRASH_RETENTION_SECS).unwrap();
        assert!(!trash.join("drafts").exists());
        assert_eq!(list(&trash).unwrap().len(), 2);
    }

    #[test]
    fn restore_unknown_id_errors() {
        let workspace = TempDir::new().unwrap();
        let (_t, trash) = ts();
        std::fs::create_dir_all(&trash).unwrap();
        let err = restore(
            &trash,
            workspace.path(),
            &workspace.path().canonicalize().unwrap(),
            "missing",
        )
        .unwrap_err();
        assert!(matches!(err, ChanError::TrashEntryNotFound(_)));
    }
}
