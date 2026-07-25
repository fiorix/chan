//! Cmd+N drafts. In-progress drafts live in-tree under a
//! configurable in-root directory (default `.Drafts`, set globally as
//! `drafts_dir` in `~/.chan/config.toml`). Each draft is a DIRECTORY
//! (e.g. `.Drafts/untitled-1/draft.md`, or a diagram's
//! `.Drafts/untitled-1/untitled-1.excalidraw`) so the user can paste
//! images and drop files alongside the primary file. New drafts are
//! named `untitled-N`, but the lister and `create_dir` accept any
//! leaf name; nothing here assumes the `untitled-` prefix.
//!
//! Drafts are real files inside the workspace root, so they sit in
//! `<root>/<drafts_dir>/<name>/...` with no `~/.chan` metadata mirror
//! and no virtual namespace. The normal workspace walker / indexer /
//! watcher pick them up like any other in-root path; there is no
//! special draft routing. This module is the filesystem primitive
//! layer only (`create_dir`, `list`, `inspect`, `promote`, `discard`,
//! `preflight`), each operating directly on the
//! `<root>/<drafts_dir>` directory the caller passes in.

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{ChanError, Result};
use crate::fs_ops;
use crate::trash;

/// Trash original-path label prefix for a discarded draft. Drafts no
/// longer have a virtual namespace, but the trash entry still records a
/// stable human-readable origin label so the user can tell a trashed
/// draft from a trashed workspace file. Kept a literal here so the
/// caller does not have to thread the configured dir name through.
const DRAFTS_TRASH_LABEL: &str = ".Drafts";

/// Handle to a single draft directory under `drafts_dir`. `name`
/// is the leaf component (e.g. `"untitled-1"`); `abs` is the
/// absolute path on disk so callers can read / write entries
/// inside without re-joining.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftRef {
    pub name: String,
    pub abs: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftInspection {
    pub name: String,
    pub file_count: usize,
    pub dir_count: usize,
    pub total_size: u64,
    pub has_attachments: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DraftPromoteMode {
    File,
    DirectoryCreated,
    DirectoryMerged,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftPromoteReport {
    pub name: String,
    pub target_path: String,
    pub mode: DraftPromoteMode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftIssue {
    pub name: String,
    pub message: String,
}

#[derive(Debug, Clone)]
struct DraftScan {
    inspection: DraftInspection,
    src: PathBuf,
    /// The root-level file the draft tab opens: a note's `draft.md` or
    /// a diagram's `<name>.excalidraw`. `promote_single_file` moves this
    /// leaf when the draft has no attachments.
    primary: PathBuf,
    entries: Vec<DraftEntry>,
}

#[derive(Debug, Clone)]
struct DraftEntry {
    rel: PathBuf,
    is_dir: bool,
}

#[cfg(test)]
fn ensure_root(drafts_dir: &Path) -> Result<()> {
    fs::create_dir_all(drafts_dir).map_err(|e| {
        ChanError::Io(format!(
            "failed to create drafts directory {}: {e}",
            drafts_dir.display()
        ))
    })
}

/// Inspect every draft and return non-fatal problems.
///
/// This is intentionally a report, not a hard failure: a single
/// broken draft should warn the user on workspace boot without blocking
/// access to the rest of the workspace.
pub fn preflight(drafts_dir: &Path) -> Result<Vec<DraftIssue>> {
    let rd = match fs::read_dir(drafts_dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(ChanError::Io(format!(
                "failed to read drafts dir {}: {e}",
                drafts_dir.display()
            )))
        }
    };
    let mut issues = Vec::new();
    for entry in rd {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                issues.push(DraftIssue {
                    name: "<unknown>".to_string(),
                    message: format!("failed to read drafts entry: {e}"),
                });
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(e) => {
                issues.push(DraftIssue {
                    name,
                    message: format!("failed to inspect {}: {e}", path.display()),
                });
                continue;
            }
        };
        if !meta.is_dir() || meta.file_type().is_symlink() {
            issues.push(DraftIssue {
                name,
                message: "draft root is not a directory".to_string(),
            });
            continue;
        }
        match scan_draft(drafts_dir, &name) {
            Ok(_) => {}
            Err(ChanError::DraftBroken { message, .. }) => {
                issues.push(DraftIssue { name, message });
            }
            Err(e) => {
                issues.push(DraftIssue {
                    name,
                    message: e.to_string(),
                });
            }
        }
    }
    issues.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(issues)
}

/// Create a draft directory by name. Returns the `DraftRef` for
/// the newly created entry. Errors when the name is empty,
/// contains a path separator (`/` or `\`), traverses (`..`), or
/// already exists under `drafts_dir`.
pub fn create_dir(drafts_dir: &Path, name: &str) -> Result<DraftRef> {
    validate_name(name)?;
    let abs = drafts_dir.join(name);
    if abs.exists() {
        return Err(ChanError::Io(format!(
            "draft `{name}` already exists at {}",
            abs.display()
        )));
    }
    fs::create_dir_all(&abs).map_err(|e| {
        ChanError::Io(format!(
            "failed to create draft directory {}: {e}",
            abs.display()
        ))
    })?;
    Ok(DraftRef {
        name: name.to_string(),
        abs,
    })
}

/// Enumerate drafts under `drafts_dir`. Returns directories only
/// (a stray regular file under drafts is skipped silently so a
/// busted import doesn't take the list path down). Empty when
/// the drafts root doesn't exist yet.
pub fn list(drafts_dir: &Path) -> Result<Vec<DraftRef>> {
    let rd = match fs::read_dir(drafts_dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(ChanError::Io(format!(
                "failed to read drafts dir {}: {e}",
                drafts_dir.display()
            )))
        }
    };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        out.push(DraftRef {
            name: name.to_string(),
            abs: path,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Inspect a draft directory and classify whether it is still a
/// single-file draft or has directory attachments.
pub fn inspect(drafts_dir: &Path, name: &str) -> Result<DraftInspection> {
    Ok(scan_draft(drafts_dir, name)?.inspection)
}

/// Move a draft into metadata trash.
pub fn discard(drafts_dir: &Path, draft_trash_dir: &Path, name: &str) -> Result<()> {
    validate_name(name)?;
    let src = drafts_dir.join(name);
    let meta = fs::symlink_metadata(&src).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            ChanError::Io(format!("not found: draft `{name}` at {}", src.display()))
        } else {
            ChanError::Io(format!("failed to inspect draft `{name}`: {e}"))
        }
    })?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err(broken(name, "draft root is not a directory"));
    }
    trash::move_into(
        draft_trash_dir,
        &src,
        &format!("{DRAFTS_TRASH_LABEL}/{name}"),
        true,
    )
}

/// Promote a draft into the workspace root with explicit no-clobber
/// semantics.
pub fn promote(
    drafts_dir: &Path,
    workspace_root: &Path,
    workspace_root_canon: &Path,
    name: &str,
    target_rel: &str,
) -> Result<DraftPromoteReport> {
    let scan = scan_draft(drafts_dir, name)?;
    let target_rel_path = fs_ops::validate_rel(target_rel)?;
    let target_rel_str = posix_path(&target_rel_path);
    let target_abs =
        fs_ops::resolve_safe_strict_canon(workspace_root, workspace_root_canon, target_rel)?;

    if !fs_ops::is_editable_text(&target_rel_str) && !scan.inspection.has_attachments {
        return Err(ChanError::NotEditableText(target_rel_str));
    }

    if scan.inspection.has_attachments {
        promote_draft(scan, &target_abs, &target_rel_str)
    } else {
        promote_single_file(scan, &target_abs, &target_rel_str)
    }
}

fn scan_draft(drafts_dir: &Path, name: &str) -> Result<DraftScan> {
    validate_name(name)?;
    let src = drafts_dir.join(name);
    let meta = fs::symlink_metadata(&src).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            ChanError::Io(format!("not found: draft `{name}` at {}", src.display()))
        } else {
            ChanError::Io(format!("failed to inspect draft `{name}`: {e}"))
        }
    })?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err(broken(name, "draft root is not a directory"));
    }

    let mut acc = DraftScanAccum::default();
    scan_entries(name, &src, Path::new(""), &mut acc)?;
    let primary = pick_primary(&acc).ok_or_else(|| broken(name, "draft has no primary file"))?;
    // A single root-level file with no subdirectories is a single-file
    // draft (a note's draft.md or a diagram's <name>.excalidraw);
    // anything more carries attachments and promotes as a directory.
    let has_attachments = !(acc.file_count == 1 && acc.dir_count == 0);
    Ok(DraftScan {
        inspection: DraftInspection {
            name: name.to_string(),
            file_count: acc.file_count,
            dir_count: acc.dir_count,
            total_size: acc.total_size,
            has_attachments,
        },
        src,
        primary,
        entries: acc.entries,
    })
}

/// The draft's primary file: the root-level file the tab opens. Prefers
/// `draft.md` so a note with attachments keeps its markdown as the
/// primary; otherwise the sole root-level file (a diagram draft's
/// `<name>.excalidraw`). None when the draft has no root-level file, or
/// more than one and none is `draft.md`.
fn pick_primary(acc: &DraftScanAccum) -> Option<PathBuf> {
    let root_files: Vec<&PathBuf> = acc
        .entries
        .iter()
        .filter(|entry| !entry.is_dir && entry.rel.parent() == Some(Path::new("")))
        .map(|entry| &entry.rel)
        .collect();
    if root_files
        .iter()
        .any(|rel| rel.as_path() == Path::new("draft.md"))
    {
        return Some(PathBuf::from("draft.md"));
    }
    match root_files.as_slice() {
        [only] => Some((*only).clone()),
        _ => None,
    }
}

/// Accumulator for the recursive draft-tree walk; the counters mirror
/// what `scan_draft` folds into `DraftInspection`.
#[derive(Default)]
struct DraftScanAccum {
    entries: Vec<DraftEntry>,
    file_count: usize,
    dir_count: usize,
    total_size: u64,
}

fn scan_entries(name: &str, root: &Path, rel_dir: &Path, acc: &mut DraftScanAccum) -> Result<()> {
    let dir = root.join(rel_dir);
    let mut read = fs::read_dir(&dir)
        .map_err(|e| broken(name, format!("failed to read {}: {e}", dir.display())))?;
    while let Some(entry) = read
        .next()
        .transpose()
        .map_err(|e| broken(name, format!("failed to read {}: {e}", dir.display())))?
    {
        let entry_name = entry.file_name();
        let rel = rel_dir.join(entry_name);
        let path = entry.path();
        let meta = fs::symlink_metadata(&path)
            .map_err(|e| broken(name, format!("failed to inspect {}: {e}", path.display())))?;
        let ft = meta.file_type();
        if ft.is_symlink() {
            return Err(broken(name, format!("refusing symlink {}", rel.display())));
        }
        if ft.is_dir() {
            acc.dir_count += 1;
            acc.entries.push(DraftEntry {
                rel: rel.clone(),
                is_dir: true,
            });
            scan_entries(name, root, &rel, acc)?;
        } else if ft.is_file() {
            acc.file_count += 1;
            acc.total_size = acc.total_size.saturating_add(meta.len());
            acc.entries.push(DraftEntry { rel, is_dir: false });
        } else {
            return Err(broken(
                name,
                format!("refusing special file {}", rel.display()),
            ));
        }
    }
    Ok(())
}

fn promote_single_file(
    scan: DraftScan,
    target_abs: &Path,
    target_rel: &str,
) -> Result<DraftPromoteReport> {
    let parent = target_abs.parent().ok_or(ChanError::PathEmpty)?;
    ensure_existing_dir(parent, "target parent")?;
    ensure_absent(target_abs, target_rel)?;
    let src_file = scan.src.join(&scan.primary);
    copy_file_atomic(&src_file, target_abs)?;
    fs::remove_dir_all(&scan.src).map_err(|e| {
        broken(
            &scan.inspection.name,
            format!("saved to {target_rel} but failed to remove draft: {e}"),
        )
    })?;
    Ok(DraftPromoteReport {
        name: scan.inspection.name,
        target_path: target_rel.to_string(),
        mode: DraftPromoteMode::File,
    })
}

fn promote_draft(
    scan: DraftScan,
    target_abs: &Path,
    target_rel: &str,
) -> Result<DraftPromoteReport> {
    match fs::symlink_metadata(target_abs) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
            preflight_draft_merge(&scan, target_abs, target_rel)?;
            copy_draft_into_existing_dir(scan, target_abs, target_rel)
        }
        Ok(_) => Err(ChanError::PathAlreadyExists(target_rel.to_string())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let parent = target_abs.parent().ok_or(ChanError::PathEmpty)?;
            ensure_existing_dir(parent, "target parent")?;
            copy_draft_to_new_dir(scan, target_abs, target_rel)
        }
        Err(e) => Err(ChanError::Io(format!(
            "failed to inspect target {target_rel}: {e}"
        ))),
    }
}

fn preflight_draft_merge(scan: &DraftScan, target_abs: &Path, target_rel: &str) -> Result<()> {
    for entry in &scan.entries {
        let dest = target_abs.join(&entry.rel);
        if dest.exists() || fs::symlink_metadata(&dest).is_ok() {
            let rel = format!("{target_rel}/{}", posix_path(&entry.rel));
            return Err(ChanError::PathAlreadyExists(rel));
        }
    }
    Ok(())
}

fn copy_draft_to_new_dir(
    scan: DraftScan,
    target_abs: &Path,
    target_rel: &str,
) -> Result<DraftPromoteReport> {
    ensure_absent(target_abs, target_rel)?;
    let stage = unique_temp_sibling(target_abs)?;
    if let Err(e) = copy_dir_checked(&scan.src, &stage, &scan.inspection.name) {
        let _ = fs::remove_dir_all(&stage);
        return Err(e);
    }
    fs_ops::sync_tree(&stage)?;
    if let Err(e) = fs::rename(&stage, target_abs) {
        let _ = fs::remove_dir_all(&stage);
        return Err(ChanError::Io(format!(
            "failed to install draft at {target_rel}: {e}"
        )));
    }
    remove_promoted_source(&scan, target_rel)?;
    Ok(DraftPromoteReport {
        name: scan.inspection.name,
        target_path: target_rel.to_string(),
        mode: DraftPromoteMode::DirectoryCreated,
    })
}

fn copy_draft_into_existing_dir(
    scan: DraftScan,
    target_abs: &Path,
    target_rel: &str,
) -> Result<DraftPromoteReport> {
    let stage = unique_temp_sibling(target_abs)?;
    if let Err(e) = copy_dir_checked(&scan.src, &stage, &scan.inspection.name) {
        let _ = fs::remove_dir_all(&stage);
        return Err(e);
    }
    fs_ops::sync_tree(&stage)?;
    move_children(&stage, target_abs, target_rel)?;
    let _ = fs::remove_dir(&stage);
    remove_promoted_source(&scan, target_rel)?;
    Ok(DraftPromoteReport {
        name: scan.inspection.name,
        target_path: target_rel.to_string(),
        mode: DraftPromoteMode::DirectoryMerged,
    })
}

fn copy_dir_checked(src: &Path, dst: &Path, name: &str) -> Result<()> {
    fs::create_dir(dst)?;
    for entry in fs::read_dir(src)
        .map_err(|e| broken(name, format!("failed to read {}: {e}", src.display())))?
    {
        let entry =
            entry.map_err(|e| broken(name, format!("failed to read {}: {e}", src.display())))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        let meta = fs::symlink_metadata(&src_path).map_err(|e| {
            broken(
                name,
                format!("failed to inspect {}: {e}", src_path.display()),
            )
        })?;
        let ft = meta.file_type();
        if ft.is_symlink() {
            return Err(broken(
                name,
                format!("refusing symlink {}", src_path.display()),
            ));
        }
        if ft.is_dir() {
            copy_dir_checked(&src_path, &dst_path, name)?;
        } else if ft.is_file() {
            fs::copy(&src_path, &dst_path).map_err(|e| {
                ChanError::Io(format!(
                    "failed to copy draft file {} to {}: {e}",
                    src_path.display(),
                    dst_path.display()
                ))
            })?;
            fs_ops::sync_file(&dst_path)?;
        } else {
            return Err(broken(
                name,
                format!("refusing special file {}", src_path.display()),
            ));
        }
    }
    Ok(())
}

fn move_children(stage: &Path, target_abs: &Path, target_rel: &str) -> Result<()> {
    for entry in fs::read_dir(stage)? {
        let entry = entry?;
        let dest = target_abs.join(entry.file_name());
        if dest.exists() || fs::symlink_metadata(&dest).is_ok() {
            return Err(ChanError::PathAlreadyExists(format!(
                "{target_rel}/{}",
                entry.file_name().to_string_lossy()
            )));
        }
        fs::rename(entry.path(), &dest).map_err(|e| {
            ChanError::Io(format!(
                "failed to move draft entry into {}: {e}",
                dest.display()
            ))
        })?;
    }
    fs_ops::sync_tree(target_abs)?;
    Ok(())
}

fn remove_promoted_source(scan: &DraftScan, target_rel: &str) -> Result<()> {
    fs::remove_dir_all(&scan.src).map_err(|e| {
        broken(
            &scan.inspection.name,
            format!("saved to {target_rel} but failed to remove draft: {e}"),
        )
    })
}

fn copy_file_atomic(src: &Path, target: &Path) -> Result<()> {
    let tmp = unique_temp_sibling(target)?;
    if let Err(e) = fs::copy(src, &tmp) {
        let _ = fs::remove_file(&tmp);
        return Err(ChanError::Io(format!(
            "failed to copy draft file {} to {}: {e}",
            src.display(),
            target.display()
        )));
    }
    if let Err(e) = fs_ops::sync_file(&tmp) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = fs::rename(&tmp, target) {
        let _ = fs::remove_file(&tmp);
        return Err(ChanError::Io(format!(
            "failed to install draft file at {}: {e}",
            target.display()
        )));
    }
    Ok(())
}

fn unique_temp_sibling(target: &Path) -> Result<PathBuf> {
    let parent = target.parent().ok_or(ChanError::PathEmpty)?;
    let leaf = target
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or(ChanError::PathEmpty)?;
    for i in 0..1000u32 {
        let candidate = parent.join(format!(".{leaf}.chan-draft-tmp-{}-{i}", std::process::id()));
        if !candidate.exists() && fs::symlink_metadata(&candidate).is_err() {
            return Ok(candidate);
        }
    }
    Err(ChanError::Io(format!(
        "failed to allocate temporary sibling for {}",
        target.display()
    )))
}

fn ensure_existing_dir(path: &Path, label: &str) -> Result<()> {
    let meta = fs::symlink_metadata(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            ChanError::Io(format!("not found: {label} {}", path.display()))
        } else {
            ChanError::Io(format!("failed to inspect {label} {}: {e}", path.display()))
        }
    })?;
    if meta.is_dir() && !meta.file_type().is_symlink() {
        return Ok(());
    }
    Err(ChanError::Io(format!(
        "{label} {} is not a directory",
        path.display()
    )))
}

fn ensure_absent(path: &Path, rel: &str) -> Result<()> {
    if path.exists() || fs::symlink_metadata(path).is_ok() {
        return Err(ChanError::PathAlreadyExists(rel.to_string()));
    }
    Ok(())
}

fn broken(name: &str, message: impl Into<String>) -> ChanError {
    ChanError::DraftBroken {
        name: name.to_string(),
        message: message.into(),
    }
}

fn posix_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

pub(crate) fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(ChanError::Io("draft name cannot be empty".into()));
    }
    if name.contains('/') || name.contains('\\') {
        return Err(ChanError::Io(format!(
            "draft name `{name}` must not contain path separators"
        )));
    }
    if name == "." || name == ".." {
        return Err(ChanError::Io(format!("draft name `{name}` is reserved")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn list_returns_empty_when_root_missing() {
        let td = TempDir::new().unwrap();
        let root = td.path().join("drafts");
        let drafts = list(&root).unwrap();
        assert!(drafts.is_empty());
    }

    #[test]
    fn create_dir_then_list_roundtrips() {
        let td = TempDir::new().unwrap();
        let root = td.path().join("drafts");
        ensure_root(&root).unwrap();
        let a = create_dir(&root, "untitled-1").unwrap();
        assert_eq!(a.name, "untitled-1");
        assert!(a.abs.is_dir());
        // An arbitrary non-`untitled` leaf name: the lister must not
        // assume the Cmd+N prefix.
        let b = create_dir(&root, "scratch-3").unwrap();
        assert!(b.abs.is_dir());

        let listed = list(&root).unwrap();
        assert_eq!(listed.len(), 2);
        // list() sorts; scratch-3 before untitled-1.
        assert_eq!(listed[0].name, "scratch-3");
        assert_eq!(listed[1].name, "untitled-1");
    }

    #[test]
    fn create_dir_rejects_traversal_and_separators() {
        let td = TempDir::new().unwrap();
        let root = td.path().join("drafts");
        ensure_root(&root).unwrap();
        assert!(create_dir(&root, "").is_err());
        assert!(create_dir(&root, "..").is_err());
        assert!(create_dir(&root, "a/b").is_err());
        assert!(create_dir(&root, "a\\b").is_err());
    }

    #[test]
    fn create_dir_rejects_existing() {
        let td = TempDir::new().unwrap();
        let root = td.path().join("drafts");
        ensure_root(&root).unwrap();
        create_dir(&root, "untitled-1").unwrap();
        assert!(create_dir(&root, "untitled-1").is_err());
    }

    #[test]
    fn preflight_reports_draft_with_no_primary_file() {
        let td = TempDir::new().unwrap();
        let root = td.path().join("drafts");
        ensure_root(&root).unwrap();
        let draft = create_dir(&root, "untitled-1").unwrap();
        // A subdirectory with no root-level file: nothing for the tab
        // to open, so preflight flags it broken.
        fs::create_dir_all(draft.abs.join("media")).unwrap();
        fs::write(draft.abs.join("media/pasted.png"), [1, 2, 3]).unwrap();

        let issues = preflight(&root).unwrap();

        assert_eq!(
            issues,
            vec![DraftIssue {
                name: "untitled-1".to_string(),
                message: "draft has no primary file".to_string(),
            }]
        );
    }

    #[test]
    fn preflight_reports_non_directory_draft_root() {
        let td = TempDir::new().unwrap();
        let root = td.path().join("drafts");
        ensure_root(&root).unwrap();
        fs::write(root.join("stray"), "not a draft").unwrap();

        let issues = preflight(&root).unwrap();

        assert_eq!(
            issues,
            vec![DraftIssue {
                name: "stray".to_string(),
                message: "draft root is not a directory".to_string(),
            }]
        );
    }

    #[test]
    fn list_skips_non_dir_entries() {
        let td = TempDir::new().unwrap();
        let root = td.path().join("drafts");
        ensure_root(&root).unwrap();
        create_dir(&root, "untitled-1").unwrap();
        fs::write(root.join("stray.txt"), b"not a draft").unwrap();
        let listed = list(&root).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "untitled-1");
    }

    #[test]
    fn inspect_classifies_single_file_and_dir_drafts() {
        let td = TempDir::new().unwrap();
        let root = td.path().join("drafts");
        ensure_root(&root).unwrap();
        let single = create_dir(&root, "untitled-1").unwrap();
        fs::write(single.abs.join("draft.md"), b"# hello\n").unwrap();
        let info = inspect(&root, "untitled-1").unwrap();
        assert_eq!(info.file_count, 1);
        assert!(!info.has_attachments);

        let workspace = create_dir(&root, "untitled-2").unwrap();
        fs::create_dir_all(workspace.abs.join("media")).unwrap();
        fs::write(workspace.abs.join("draft.md"), b"# hello\n").unwrap();
        fs::write(workspace.abs.join("media/pasted.png"), [1, 2, 3]).unwrap();
        let info = inspect(&root, "untitled-2").unwrap();
        assert_eq!(info.file_count, 2);
        assert_eq!(info.dir_count, 1);
        assert!(info.has_attachments);
    }

    #[test]
    fn inspect_marks_empty_draft_broken() {
        let td = TempDir::new().unwrap();
        let root = td.path().join("drafts");
        ensure_root(&root).unwrap();
        create_dir(&root, "untitled-1").unwrap();
        assert!(matches!(
            inspect(&root, "untitled-1"),
            Err(ChanError::DraftBroken { .. })
        ));
    }

    #[test]
    fn inspect_treats_a_single_non_markdown_file_as_a_single_file_draft() {
        let td = TempDir::new().unwrap();
        let root = td.path().join("drafts");
        ensure_root(&root).unwrap();
        let draft = create_dir(&root, "untitled-1").unwrap();
        fs::write(
            draft.abs.join("untitled-1.excalidraw"),
            br#"{"type":"excalidraw","elements":[]}"#,
        )
        .unwrap();

        let info = inspect(&root, "untitled-1").unwrap();

        assert_eq!(info.file_count, 1);
        assert!(!info.has_attachments);
    }

    #[test]
    fn promote_single_file_moves_a_diagram_leaf_to_target() {
        let td = TempDir::new().unwrap();
        let drafts_root = td.path().join("drafts");
        let workspace_root = td.path().join("workspace");
        ensure_root(&drafts_root).unwrap();
        fs::create_dir_all(workspace_root.join("notes")).unwrap();
        let draft = create_dir(&drafts_root, "untitled-1").unwrap();
        fs::write(
            draft.abs.join("untitled-1.excalidraw"),
            br#"{"type":"excalidraw","elements":[]}"#,
        )
        .unwrap();
        let workspace_root_canon = workspace_root.canonicalize().unwrap();

        let report = promote(
            &drafts_root,
            &workspace_root,
            &workspace_root_canon,
            "untitled-1",
            "notes/diagram.excalidraw",
        )
        .unwrap();

        assert_eq!(report.mode, DraftPromoteMode::File);
        assert!(!drafts_root.join("untitled-1").exists());
        assert_eq!(
            fs::read_to_string(workspace_root.join("notes/diagram.excalidraw")).unwrap(),
            r#"{"type":"excalidraw","elements":[]}"#
        );
    }

    #[test]
    fn promote_moves_directory_atomically() {
        let td = TempDir::new().unwrap();
        let drafts_root = td.path().join("drafts");
        let workspace_root = td.path().join("workspace");
        ensure_root(&drafts_root).unwrap();
        fs::create_dir_all(&workspace_root).unwrap();
        let draft = create_dir(&drafts_root, "untitled-1").unwrap();
        fs::write(draft.abs.join("draft.md"), b"# hello\n").unwrap();
        fs::write(draft.abs.join("image.png"), [1, 2, 3]).unwrap();

        let target = workspace_root.join("notes").join("untitled-1");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        let workspace_root_canon = workspace_root.canonicalize().unwrap();
        let report = promote(
            &drafts_root,
            &workspace_root,
            &workspace_root_canon,
            "untitled-1",
            "notes/untitled-1",
        )
        .unwrap();

        assert!(!drafts_root.join("untitled-1").exists());
        assert!(target.is_dir());
        assert!(target.join("draft.md").is_file());
        assert!(target.join("image.png").is_file());
        assert_eq!(report.mode, DraftPromoteMode::DirectoryCreated);
    }

    #[test]
    fn promote_single_file_moves_draft_md_to_target_file() {
        let td = TempDir::new().unwrap();
        let drafts_root = td.path().join("drafts");
        let workspace_root = td.path().join("workspace");
        ensure_root(&drafts_root).unwrap();
        fs::create_dir_all(workspace_root.join("notes")).unwrap();
        let draft = create_dir(&drafts_root, "untitled-1").unwrap();
        fs::write(draft.abs.join("draft.md"), b"# hello\n").unwrap();
        let workspace_root_canon = workspace_root.canonicalize().unwrap();

        let report = promote(
            &drafts_root,
            &workspace_root,
            &workspace_root_canon,
            "untitled-1",
            "notes/draft.md",
        )
        .unwrap();

        assert_eq!(report.mode, DraftPromoteMode::File);
        assert!(!drafts_root.join("untitled-1").exists());
        assert_eq!(
            fs::read_to_string(workspace_root.join("notes/draft.md")).unwrap(),
            "# hello\n"
        );
    }

    #[test]
    fn promote_draft_merges_into_existing_dir_without_clobber() {
        let td = TempDir::new().unwrap();
        let drafts_root = td.path().join("drafts");
        let workspace_root = td.path().join("workspace");
        ensure_root(&drafts_root).unwrap();
        fs::create_dir_all(workspace_root.join("notes")).unwrap();
        let draft = create_dir(&drafts_root, "untitled-1").unwrap();
        fs::write(draft.abs.join("draft.md"), b"# hello\n").unwrap();
        fs::write(draft.abs.join("pasted.png"), [1, 2, 3]).unwrap();
        let workspace_root_canon = workspace_root.canonicalize().unwrap();

        let report = promote(
            &drafts_root,
            &workspace_root,
            &workspace_root_canon,
            "untitled-1",
            "notes",
        )
        .unwrap();

        assert_eq!(report.mode, DraftPromoteMode::DirectoryMerged);
        assert!(!drafts_root.join("untitled-1").exists());
        assert!(workspace_root.join("notes/draft.md").is_file());
        assert!(workspace_root.join("notes/pasted.png").is_file());
    }

    #[test]
    fn promote_draft_rejects_nested_collision() {
        let td = TempDir::new().unwrap();
        let drafts_root = td.path().join("drafts");
        let workspace_root = td.path().join("workspace");
        ensure_root(&drafts_root).unwrap();
        fs::create_dir_all(workspace_root.join("notes")).unwrap();
        fs::write(workspace_root.join("notes/draft.md"), b"existing").unwrap();
        let draft = create_dir(&drafts_root, "untitled-1").unwrap();
        fs::write(draft.abs.join("draft.md"), b"# hello\n").unwrap();
        fs::write(draft.abs.join("pasted.png"), [1, 2, 3]).unwrap();
        let workspace_root_canon = workspace_root.canonicalize().unwrap();

        let err = promote(
            &drafts_root,
            &workspace_root,
            &workspace_root_canon,
            "untitled-1",
            "notes",
        )
        .unwrap_err();

        assert!(matches!(err, ChanError::PathAlreadyExists(_)));
        assert!(drafts_root.join("untitled-1").exists());
    }

    #[test]
    fn promote_rejects_target_escape() {
        let td = TempDir::new().unwrap();
        let drafts_root = td.path().join("drafts");
        let workspace_root = td.path().join("workspace");
        ensure_root(&drafts_root).unwrap();
        fs::create_dir_all(&workspace_root).unwrap();
        let draft = create_dir(&drafts_root, "untitled-1").unwrap();
        fs::write(draft.abs.join("draft.md"), b"# hello\n").unwrap();
        let workspace_root_canon = workspace_root.canonicalize().unwrap();

        let err = promote(
            &drafts_root,
            &workspace_root,
            &workspace_root_canon,
            "untitled-1",
            "../outside.md",
        )
        .unwrap_err();

        assert!(matches!(err, ChanError::PathEscape));
        assert!(drafts_root.join("untitled-1").exists());
    }

    #[test]
    fn discard_moves_draft_to_metadata_trash() {
        let td = TempDir::new().unwrap();
        let drafts_root = td.path().join("drafts");
        let trash_root = td.path().join("trash");
        ensure_root(&drafts_root).unwrap();
        let draft = create_dir(&drafts_root, "untitled-1").unwrap();
        fs::write(draft.abs.join("draft.md"), b"# hello\n").unwrap();

        discard(&drafts_root, &trash_root, "untitled-1").unwrap();

        assert!(!drafts_root.join("untitled-1").exists());
        let trashed = trash::list(&trash_root).unwrap();
        assert_eq!(trashed.len(), 1);
        assert_eq!(trashed[0].original_path, ".Drafts/untitled-1");
    }

    #[test]
    fn promote_rejects_when_target_exists() {
        let td = TempDir::new().unwrap();
        let drafts_root = td.path().join("drafts");
        let workspace_root = td.path().join("workspace");
        ensure_root(&drafts_root).unwrap();
        fs::create_dir_all(&workspace_root).unwrap();
        create_dir(&drafts_root, "untitled-1").unwrap();
        let target = workspace_root.join("untitled-1");
        fs::create_dir_all(&target).unwrap();
        let workspace_root_canon = workspace_root.canonicalize().unwrap();
        assert!(promote(
            &drafts_root,
            &workspace_root,
            &workspace_root_canon,
            "untitled-1",
            "untitled-1",
        )
        .is_err());
        assert!(drafts_root.join("untitled-1").exists());
    }

    #[test]
    fn promote_rejects_missing_draft() {
        let td = TempDir::new().unwrap();
        let drafts_root = td.path().join("drafts");
        let workspace_root = td.path().join("workspace");
        ensure_root(&drafts_root).unwrap();
        fs::create_dir_all(&workspace_root).unwrap();
        let workspace_root_canon = workspace_root.canonicalize().unwrap();
        assert!(promote(
            &drafts_root,
            &workspace_root,
            &workspace_root_canon,
            "ghost",
            "untitled-1",
        )
        .is_err());
    }
}
