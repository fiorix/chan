//! Metadata-free standalone file access over a capability root.
//!
//! `MiniWorkspace` is the filesystem face of the standalone Files
//! application: the same crate-private [`RootedFs`] core a `Workspace`
//! delegates to, with none of the workspace machinery around it. Opening
//! one registers nothing, creates no metadata, takes no workspace lock,
//! starts no indexer, and never opens a graph; a write made through it is
//! an external write to any real `Workspace` covering the same physical
//! file.
//!
//! The wire dialect is stricter than the workspace one: paths are UTF-8,
//! POSIX-separated, relative to the capability root, and never begin with
//! `/`; `""` identifies the root itself and is accepted only where a root
//! query makes sense. The capability root and the canonical start
//! directory are protected from delete and move, deletion covers only
//! regular files and empty directories, and symlinks are inert everywhere:
//! visible in listings, refused by every read, write, copy, move, and
//! delete.

use std::path::{Path, PathBuf};

use crate::error::{ChanError, Result};
use crate::fs_ops::{self, AtomicWriteKind, AtomicWriteSink, PathClass};
use crate::rooted_fs::{describe_cap_file_kind, ListPolicy, RootedFs};
use crate::workspace::{
    BoundedFileReader, DirEntry, FileStat, TextReadEvent, WorkspacePath, WritableFile,
};

/// One standalone capability root plus its start directory. Cheap to share
/// behind an `Arc`; every method is `&self` and internally synchronized by
/// the filesystem alone.
pub struct MiniWorkspace {
    fs: RootedFs,
    /// Wire-relative canonical start directory (`home/user`), the protected
    /// sibling of the root itself.
    start_rel: String,
    /// Keeps the live capability-handle count bounded under descriptor
    /// pressure alongside real workspaces in the same process.
    _fd_permit: crate::fd_budget::WorkspacePermit,
}

impl MiniWorkspace {
    /// Open `root` as the capability root with `start` (an absolute path
    /// under it) as the protected start directory. Both must be existing
    /// real directories; `start` is canonicalized so the wire start path
    /// never travels through a symlink alias.
    pub fn open(root: &Path, start: &Path, transfer_max_bytes: u64) -> Result<Self> {
        let fd_permit = crate::fd_budget::acquire_workspace_permit();
        let fs = RootedFs::open(root.to_path_buf(), transfer_max_bytes)?;
        let start_canon = start
            .canonicalize()
            .map_err(|e| ChanError::Io(format!("canonicalize start directory: {e}")))?;
        let start_meta = std::fs::symlink_metadata(&start_canon)
            .map_err(|e| ChanError::Io(format!("stat start directory: {e}")))?;
        if !start_meta.is_dir() {
            return Err(ChanError::Io(format!(
                "start path is not a directory: {}",
                start_canon.display()
            )));
        }
        let start_rel = match start_canon.strip_prefix(fs.canonical_root()) {
            Ok(rel) => rel,
            Err(_) => {
                return Err(ChanError::Io(format!(
                    "start directory {} is outside the root {}",
                    start_canon.display(),
                    fs.canonical_root().display()
                )));
            }
        };
        let Some(start_rel) = start_rel.to_str() else {
            return Err(ChanError::Io(
                "start directory is not valid UTF-8".to_string(),
            ));
        };
        let start_rel = start_rel.trim_matches('/').replace('\\', "/");
        Ok(Self {
            fs,
            start_rel,
            _fd_permit: fd_permit,
        })
    }

    /// The capability root as opened (`/` in production).
    pub fn root(&self) -> &Path {
        self.fs.root()
    }

    /// Wire-relative canonical start directory (no leading slash; `""`
    /// when the start IS the root).
    pub fn start_rel(&self) -> &str {
        &self.start_rel
    }

    /// The opaque-byte write ceiling this root was opened with.
    pub fn transfer_max_bytes(&self) -> u64 {
        self.fs.transfer_max_bytes()
    }

    /// Validate one wire path: UTF-8 by construction, no leading `/` (an
    /// absolute path is refused rather than silently re-rooted), no NUL,
    /// no `..`, not empty. The stricter dialect exists because the root is
    /// the whole machine: an accepted `/etc/hosts` would resolve to the
    /// real file.
    fn wire_rel(&self, rel: &str) -> Result<String> {
        if rel.starts_with('/') {
            return Err(ChanError::PathEscape);
        }
        if rel.contains('\0') {
            return Err(ChanError::PathEscape);
        }
        let validated = fs_ops::validate_rel(rel)?;
        // Return the CANONICAL form, not the caller's spelling: every
        // downstream comparison (protected paths above all) would otherwise
        // read a raw string while the filesystem acts on the normalized one,
        // so `home/user/` or `home/./user` would slip past a guard keyed on
        // `home/user` and still resolve to it.
        let Some(canonical) = validated.to_str() else {
            return Err(ChanError::PathEscape);
        };
        Ok(canonical.to_string())
    }

    /// Validate a wire directory query into its canonical form: `""` and
    /// `.` identify the root.
    fn wire_dir(&self, rel: &str) -> Result<String> {
        if rel.is_empty() || rel == "." {
            return Ok(String::new());
        }
        self.wire_rel(rel)
    }

    /// Whether `rel` is one of the two protected paths: the root itself or
    /// the canonical start directory.
    fn is_protected(&self, rel: &str) -> bool {
        rel.is_empty() || rel == self.start_rel
    }

    /// One-level listing: every ordinary UTF-8 entry including dotfiles
    /// and control dirs; symlinks visible, special nodes omitted,
    /// non-UTF-8 names skipped with a server-side warning.
    pub fn list(&self, rel: &str) -> Result<Vec<DirEntry>> {
        let rel = self.wire_dir(rel)?;
        let rel = rel.as_str();
        self.fs.list_with(
            rel,
            ListPolicy {
                hide_internal_top_level: false,
                skip_non_utf8: true,
            },
        )
    }

    /// lstat one wire path; `""` stats the root directory itself.
    pub fn stat(&self, rel: &str) -> Result<FileStat> {
        if self.wire_dir(rel)?.is_empty() {
            let meta = self
                .fs
                .dir()
                .dir_metadata()
                .map_err(|e| ChanError::Io(e.to_string()))?;
            return Ok(crate::rooted_fs::file_stat_from_cap(&meta));
        }
        self.fs.stat(rel)
    }

    /// Classify a wire path for rendering: kind, permission, link count,
    /// symlink target. `""` classifies the root directory.
    pub fn classify(&self, rel: &str) -> Result<PathClass> {
        let rel = self.wire_dir(rel)?;
        let rel = rel.as_str();
        fs_ops::classify_path(self.fs.root(), rel)
    }

    /// Classify through the capability handle (missing leaf is a value).
    pub fn classify_capability(&self, rel: &str) -> Result<WorkspacePath> {
        let rel = self.wire_rel(rel)?;
        let rel = rel.as_str();
        self.fs.classify_workspace_path(rel)
    }

    /// Content-sniff whether `rel` is editable text.
    pub fn sniff_is_text(&self, rel: &str) -> bool {
        let Ok(rel) = self.wire_rel(rel) else {
            return false;
        };
        self.fs.sniff_is_text(&rel)
    }

    /// Raw byte read of one regular file.
    pub fn read(&self, rel: &str) -> Result<Vec<u8>> {
        let rel = self.wire_rel(rel)?;
        let rel = rel.as_str();
        self.fs.read(rel)
    }

    /// Buffered text read with the open-handle stat the CAS token derives
    /// from.
    pub fn read_text_with_stat(&self, rel: &str) -> Result<(String, FileStat)> {
        let rel = self.wire_rel(rel)?;
        let rel = rel.as_str();
        self.fs.read_text_with_stat(rel)
    }

    /// Streaming text read: `Meta`, UTF-8 `Chunk`s, `Done`; the callback
    /// returning false stops the read cleanly.
    pub fn read_text_with_stat_chunked<F>(
        &self,
        rel: &str,
        chunk_size: usize,
        on_event: F,
    ) -> Result<()>
    where
        F: FnMut(TextReadEvent<'_>) -> bool,
    {
        let rel = self.wire_rel(rel)?;
        let rel = rel.as_str();
        self.fs
            .read_text_with_stat_chunked(rel, chunk_size, on_event)
    }

    /// Bounded byte stream of one regular file (whole file).
    pub fn read_bytes_bounded(&self, rel: &str) -> Result<BoundedFileReader> {
        let rel = self.wire_rel(rel)?;
        let rel = rel.as_str();
        self.fs.read_bytes_bounded(rel)
    }

    /// Bounded byte stream of the window `[start, start+len)`.
    pub fn read_bytes_bounded_slice(
        &self,
        rel: &str,
        start: u64,
        len: u64,
    ) -> Result<BoundedFileReader> {
        let rel = self.wire_rel(rel)?;
        let rel = rel.as_str();
        self.fs.read_bytes_bounded_slice(rel, start, len)
    }

    /// Write preflight: existing targets must be writable regular files.
    pub fn ensure_writable(&self, rel: &str) -> Result<WritableFile> {
        let rel = self.wire_rel(rel)?;
        let rel = rel.as_str();
        self.fs.ensure_writable(rel)
    }

    /// Nanosecond-CAS text write; see `Workspace::write_text_if_unchanged`.
    pub fn write_text_if_unchanged(
        &self,
        rel: &str,
        expected_mtime_ns: Option<i64>,
        expected_disk: Option<&str>,
        content: &str,
    ) -> Result<()> {
        let rel = self.wire_rel(rel)?;
        let rel = rel.as_str();
        self.fs
            .write_text_if_unchanged(rel, expected_mtime_ns, expected_disk, content)
    }

    /// Unconditional atomic text write.
    pub fn write_text(&self, rel: &str, content: &str) -> Result<()> {
        let rel = self.wire_rel(rel)?;
        let rel = rel.as_str();
        self.fs.write_text(rel, content)
    }

    /// Atomic streamed write from caller-fed chunks.
    pub fn write_atomic_stream<F>(
        &self,
        rel: &str,
        kind: AtomicWriteKind,
        feed: F,
    ) -> Result<FileStat>
    where
        F: FnOnce(&mut dyn AtomicWriteSink) -> Result<()>,
    {
        let rel = self.wire_rel(rel)?;
        let rel = rel.as_str();
        self.fs.write_atomic_stream(rel, kind, feed)
    }

    /// Create a file that must not exist yet, with optional text content.
    pub fn create_file(&self, rel: &str, content: &str) -> Result<()> {
        self.wire_rel(rel)?;
        if !matches!(
            self.fs.classify_workspace_path(rel)?,
            WorkspacePath::Missing
        ) {
            return Err(ChanError::PathAlreadyExists(rel.to_string()));
        }
        self.fs.write_text(rel, content)
    }

    /// Create a directory chain; the leaf must not exist yet.
    pub fn create_dir(&self, rel: &str) -> Result<()> {
        self.wire_rel(rel)?;
        if !matches!(
            self.fs.classify_workspace_path(rel)?,
            WorkspacePath::Missing
        ) {
            return Err(ChanError::PathAlreadyExists(rel.to_string()));
        }
        self.fs.create_dir(rel)
    }

    /// Permanently delete a regular file or an EMPTY directory. There is
    /// no trash behind this root and no recursive form: the refusals are
    /// the safety model. The class-specific syscall re-checks the shape at
    /// removal time, so a swap between validation and unlink can only
    /// remove a link itself, never what it points at.
    pub fn remove_safe(&self, rel: &str) -> Result<()> {
        let rel = self.wire_rel(rel)?;
        let rel = rel.as_str();
        if self.is_protected(rel) {
            return Err(ChanError::ProtectedPath(rel.to_string()));
        }
        let (dir, rel_path) = self.fs.resolve_io(rel)?;
        let meta = dir
            .symlink_metadata(&rel_path)
            .map_err(|e| ChanError::Io(e.to_string()))?;
        let ft = meta.file_type();
        if ft.is_symlink() || !(ft.is_file() || ft.is_dir()) {
            return Err(ChanError::SpecialFile {
                kind: describe_cap_file_kind(&ft).to_string(),
                path: rel_path,
            });
        }
        if ft.is_dir() {
            dir.remove_dir(&rel_path).map_err(|e| {
                if is_not_empty_error(&e) {
                    ChanError::DirectoryNotEmpty(rel.to_string())
                } else {
                    ChanError::Io(e.to_string())
                }
            })
        } else {
            dir.remove_file(&rel_path)
                .map_err(|e| ChanError::Io(e.to_string()))
        }
    }

    /// Plain move: no link rewriting, no clobbering, both protected paths
    /// refused. Same-filesystem moves are one capability rename; a
    /// cross-device move copies the preflighted tree to a uniquely named
    /// temporary sibling of the destination, renames it into place, and
    /// removes the source only once the destination is complete.
    ///
    /// The two lanes differ on one case by construction: a rename relocates
    /// a directory wholesale, so symlinks inside it ride along untouched,
    /// while the copy lane refuses a tree containing one because it will
    /// not create symlinks to reproduce it. A move of such a directory
    /// therefore succeeds within a filesystem and is refused across one.
    pub fn move_plain(&self, from: &str, to: &str) -> Result<()> {
        let from = self.wire_rel(from)?;
        let from = from.as_str();
        let to = self.wire_rel(to)?;
        let to = to.as_str();
        if self.is_protected(from) || self.is_protected(to) {
            return Err(ChanError::ProtectedPath(from.to_string()));
        }
        let (dir, from_path) = self.fs.resolve_io(from)?;
        let src_meta = dir
            .symlink_metadata(&from_path)
            .map_err(|e| ChanError::Io(e.to_string()))?;
        let src_ft = src_meta.file_type();
        if src_ft.is_symlink() || !(src_ft.is_dir() || src_ft.is_file()) {
            return Err(ChanError::SpecialFile {
                kind: describe_cap_file_kind(&src_ft).to_string(),
                path: from_path,
            });
        }
        let (_, to_path) = self.fs.resolve_io(to)?;
        if dir.symlink_metadata(&to_path).is_ok() {
            return Err(ChanError::PathAlreadyExists(to.to_string()));
        }
        if let Some(parent) = to_path.parent() {
            if !parent.as_os_str().is_empty() {
                dir.create_dir_all(parent)
                    .map_err(|e| ChanError::Io(e.to_string()))?;
            }
        }
        match dir.rename(&from_path, dir, &to_path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {
                self.move_across_devices(from, to)
            }
            Err(e) => Err(ChanError::Io(e.to_string())),
        }
    }

    /// Plain copy: destination must not exist, the whole source tree is
    /// preflighted (readable, regular files and directories only), and the
    /// copy lands in a uniquely named temporary sibling that is renamed to
    /// the final name only when complete. A failure removes only that
    /// temporary tree, never a pre-existing destination.
    pub fn copy_plain(&self, from: &str, to: &str) -> Result<()> {
        let from = self.wire_rel(from)?;
        let from = from.as_str();
        let to = self.wire_rel(to)?;
        let to = to.as_str();
        if self.is_protected(from) || self.is_protected(to) {
            return Err(ChanError::ProtectedPath(from.to_string()));
        }
        let (dir, to_path) = self.fs.resolve_io(to)?;
        if dir.symlink_metadata(&to_path).is_ok() {
            return Err(ChanError::PathAlreadyExists(to.to_string()));
        }
        self.preflight_tree(from)?;
        let tmp = self.temp_sibling_name(to)?;
        match self.copy_tree_plain(from, &tmp) {
            Ok(()) => {}
            Err(error) => {
                self.remove_tree_best_effort(&tmp);
                return Err(error);
            }
        }
        let (_, tmp_path) = self.fs.resolve_io(&tmp)?;
        if let Err(e) = dir.rename(&tmp_path, dir, &to_path) {
            self.remove_tree_best_effort(&tmp);
            return Err(ChanError::Io(e.to_string()));
        }
        Ok(())
    }

    /// Finder-style collision-free destination name for pasting `name`
    /// into `dest_dir`.
    pub fn resolve_free_name(&self, dest_dir: &str, name: &str) -> Result<String> {
        let dest_dir = self.wire_dir(dest_dir)?;
        let dest_dir = dest_dir.as_str();
        self.fs.resolve_free_name(dest_dir, name)
    }

    /// Resolve a wire directory to its real absolute path for a PTY start
    /// directory. Requires a real, non-symlink directory.
    pub fn resolve_directory(&self, rel: &str) -> Result<PathBuf> {
        let rel = self.wire_dir(rel)?;
        let rel = rel.as_str();
        if rel.is_empty() {
            return Ok(self.fs.canonical_root().to_path_buf());
        }
        match self.fs.classify_workspace_path(rel)? {
            WorkspacePath::Directory(_) => Ok(self.fs.canonical_root().join(rel)),
            WorkspacePath::Missing => Err(ChanError::Io(format!("no such directory: {rel}"))),
            other => Err(ChanError::Io(format!(
                "not a plain directory: {rel} ({other:?})"
            ))),
        }
    }

    /// Convert an absolute host path (a PTY's reported cwd) back to the
    /// wire form when it sits under the root and is valid UTF-8.
    pub fn wire_path_from_absolute(&self, path: &Path) -> Option<String> {
        let rel = path.strip_prefix(self.fs.canonical_root()).ok()?;
        let rel = rel.to_str()?;
        Some(rel.trim_matches('/').to_string())
    }

    /// Cross-device move fallback; see [`Self::move_plain`]. The source is
    /// removed only after the destination tree is complete and renamed; a
    /// source-removal failure keeps BOTH trees and says so.
    fn move_across_devices(&self, from: &str, to: &str) -> Result<()> {
        self.preflight_tree(from)?;
        let tmp = self.temp_sibling_name(to)?;
        match self.copy_tree_plain(from, &tmp) {
            Ok(()) => {}
            Err(error) => {
                self.remove_tree_best_effort(&tmp);
                return Err(error);
            }
        }
        let (dir, tmp_path) = self.fs.resolve_io(&tmp)?;
        let (_, to_path) = self.fs.resolve_io(to)?;
        if let Err(e) = dir.rename(&tmp_path, dir, &to_path) {
            self.remove_tree_best_effort(&tmp);
            return Err(ChanError::Io(e.to_string()));
        }
        if let Err(error) = self.remove_tree(from) {
            return Err(ChanError::Io(format!(
                "cross-device move copied {from} to {to}, but removing the source failed: \
                 {error}; both source and destination remain"
            )));
        }
        Ok(())
    }

    /// Verify every node under `rel` is a readable regular file or
    /// directory before any mutation starts, so a failure cannot strand a
    /// half-copied destination.
    fn preflight_tree(&self, rel: &str) -> Result<()> {
        let (dir, rel_path) = self.fs.resolve_io(rel)?;
        let meta = dir
            .symlink_metadata(&rel_path)
            .map_err(|e| ChanError::Io(e.to_string()))?;
        let ft = meta.file_type();
        if ft.is_symlink() || !(ft.is_file() || ft.is_dir()) {
            return Err(ChanError::SpecialFile {
                kind: describe_cap_file_kind(&ft).to_string(),
                path: rel_path,
            });
        }
        if ft.is_file() {
            dir.open(&rel_path)
                .map_err(|e| ChanError::Io(format!("unreadable source {rel}: {e}")))?;
            return Ok(());
        }
        for entry in dir
            .read_dir(&rel_path)
            .map_err(|e| ChanError::Io(format!("unreadable source directory {rel}: {e}")))?
        {
            let entry = entry.map_err(|e| ChanError::Io(e.to_string()))?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                return Err(ChanError::Io(format!(
                    "source tree under {rel} contains a non-UTF-8 name"
                )));
            };
            self.preflight_tree(&format!("{rel}/{name}"))?;
        }
        Ok(())
    }

    /// Copy the preflighted tree at `from` to the (absent) `to`,
    /// preserving the atomic per-file write posture.
    fn copy_tree_plain(&self, from: &str, to: &str) -> Result<()> {
        let (dir, from_path) = self.fs.resolve_io(from)?;
        let meta = dir
            .symlink_metadata(&from_path)
            .map_err(|e| ChanError::Io(e.to_string()))?;
        if meta.is_dir() {
            self.fs.create_dir(to)?;
            for entry in dir
                .read_dir(&from_path)
                .map_err(|e| ChanError::Io(e.to_string()))?
            {
                let entry = entry.map_err(|e| ChanError::Io(e.to_string()))?;
                let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                    return Err(ChanError::Io(format!(
                        "source tree under {from} contains a non-UTF-8 name"
                    )));
                };
                self.copy_tree_plain(&format!("{from}/{name}"), &format!("{to}/{name}"))?;
            }
            return Ok(());
        }
        let mut reader = self.fs.read_bytes_bounded(from)?;
        self.fs
            .write_atomic_stream(to, AtomicWriteKind::Bytes, |sink| {
                if reader.stat().size > sink.limit() {
                    return Err(ChanError::WriteTooLarge {
                        kind: "bytes",
                        size: reader.stat().size,
                        limit: sink.limit(),
                    });
                }
                for chunk in reader.by_ref() {
                    sink.write_chunk(&chunk?)?;
                }
                Ok(())
            })?;
        Ok(())
    }

    /// Remove the tree at `rel` (regular files and directories only; the
    /// preflight already refused everything else).
    fn remove_tree(&self, rel: &str) -> Result<()> {
        let (dir, rel_path) = self.fs.resolve_io(rel)?;
        let meta = dir
            .symlink_metadata(&rel_path)
            .map_err(|e| ChanError::Io(e.to_string()))?;
        if meta.is_dir() {
            dir.remove_dir_all(&rel_path)
                .map_err(|e| ChanError::Io(e.to_string()))
        } else {
            dir.remove_file(&rel_path)
                .map_err(|e| ChanError::Io(e.to_string()))
        }
    }

    fn remove_tree_best_effort(&self, rel: &str) {
        if let Err(error) = self.remove_tree(rel) {
            tracing::warn!(rel, %error, "cleaning up temporary copy tree failed");
        }
    }

    /// A uniquely named sibling of `to` for the in-flight tree: same
    /// parent (so the final rename never crosses filesystems), dot-hidden,
    /// suffixed from a clock-plus-counter source and existence-checked so
    /// concurrent operations cannot collide.
    fn temp_sibling_name(&self, to: &str) -> Result<String> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let (parent, leaf) = match to.rsplit_once('/') {
            Some((parent, leaf)) => (parent, leaf),
            None => ("", to),
        };
        for _ in 0..16 {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos() as u64)
                .unwrap_or(0);
            let seq = SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let name = format!(".{leaf}.chan-copy-{nanos:08x}{seq:04x}");
            let candidate = if parent.is_empty() {
                name
            } else {
                format!("{parent}/{name}")
            };
            let (dir, candidate_path) = self.fs.resolve_io(&candidate)?;
            if dir.symlink_metadata(&candidate_path).is_err() {
                return Ok(candidate);
            }
        }
        Err(ChanError::Io(format!(
            "could not allocate a temporary sibling for {to}"
        )))
    }
}

fn is_not_empty_error(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::DirectoryNotEmpty
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs as stdfs;

    struct Fixture {
        _tmp: tempfile::TempDir,
        root: PathBuf,
        mini: MiniWorkspace,
    }

    /// A temp root standing in for `/`, with `home/user` as the protected
    /// start directory. No test touches the host filesystem root.
    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().to_path_buf();
        stdfs::create_dir_all(root.join("home/user")).unwrap();
        let mini =
            MiniWorkspace::open(&root, &root.join("home/user"), 10 * 1024 * 1024).expect("open");
        Fixture {
            _tmp: tmp,
            root,
            mini,
        }
    }

    #[test]
    fn open_reports_start_rel_and_rejects_bad_starts() {
        let fx = fixture();
        assert_eq!(fx.mini.start_rel(), "home/user");

        let missing = MiniWorkspace::open(&fx.root, &fx.root.join("nope"), 1024);
        assert!(missing.is_err(), "missing start directory is refused");

        stdfs::write(fx.root.join("plain.txt"), "x").unwrap();
        let file = MiniWorkspace::open(&fx.root, &fx.root.join("plain.txt"), 1024);
        assert!(file.is_err(), "a file start is refused");

        let outside = tempfile::tempdir().unwrap();
        let escaped = MiniWorkspace::open(&fx.root, outside.path(), 1024);
        assert!(escaped.is_err(), "a start outside the root is refused");
    }

    #[test]
    fn wire_paths_reject_absolute_traversal_and_nul() {
        let fx = fixture();
        for bad in ["/etc/hosts", "../up", "a/../../b", "a\0b"] {
            assert!(
                fx.mini.read(bad).is_err(),
                "read must refuse wire path {bad:?}"
            );
            assert!(
                fx.mini.remove_safe(bad).is_err(),
                "remove must refuse wire path {bad:?}"
            );
        }
        // An absolute path is refused outright, never re-rooted: the same
        // string without the slash resolves fine.
        stdfs::write(fx.root.join("etc-hosts"), "x").unwrap();
        assert!(fx.mini.read("etc-hosts").is_ok());
        assert!(matches!(
            fx.mini.read("/etc-hosts"),
            Err(ChanError::PathEscape)
        ));
    }

    #[test]
    fn root_and_home_are_protected_from_delete_and_move() {
        let fx = fixture();
        assert!(matches!(
            fx.mini.remove_safe("home/user"),
            Err(ChanError::ProtectedPath(_))
        ));
        assert!(matches!(
            fx.mini.move_plain("home/user", "home/user2"),
            Err(ChanError::ProtectedPath(_))
        ));
        assert!(fx.mini.remove_safe("").is_err());
    }

    /// A guard keyed on the canonical path must not be dodged by respelling
    /// it: the operation would still resolve to the protected directory, so
    /// every alternate spelling has to hit the same refusal.
    #[test]
    fn protection_survives_alternate_spellings_of_the_start_directory() {
        let fx = fixture();
        for spelling in [
            "home/user/",
            "home/./user",
            "home//user",
            "./home/user",
            "home/user/.",
        ] {
            assert!(
                matches!(
                    fx.mini.remove_safe(spelling),
                    Err(ChanError::ProtectedPath(_))
                ),
                "remove_safe must refuse the start directory spelled {spelling:?}"
            );
            assert!(
                matches!(
                    fx.mini.move_plain(spelling, "moved"),
                    Err(ChanError::ProtectedPath(_))
                ),
                "move_plain must refuse the start directory spelled {spelling:?}"
            );
            assert!(
                matches!(
                    fx.mini.copy_plain(spelling, "copied"),
                    Err(ChanError::ProtectedPath(_))
                ),
                "copy_plain must refuse the start directory spelled {spelling:?}"
            );
        }
        assert!(
            fx.root.join("home/user").is_dir(),
            "no spelling may have moved or removed the start directory"
        );
    }

    /// The same normalization keeps ordinary paths addressable under any
    /// spelling instead of erroring or resolving somewhere else.
    #[test]
    fn alternate_spellings_address_the_same_ordinary_path() {
        let fx = fixture();
        stdfs::write(fx.root.join("home/user/note.md"), "body").unwrap();
        for spelling in [
            "home/user/note.md",
            "home/./user/note.md",
            "home//user/note.md",
            "./home/user/note.md",
        ] {
            assert_eq!(
                fx.mini.read_text_with_stat(spelling).unwrap().0,
                "body",
                "spelling {spelling:?} must read the same file"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_inert_everywhere() {
        let fx = fixture();
        stdfs::write(fx.root.join("real.txt"), "content").unwrap();
        std::os::unix::fs::symlink(fx.root.join("real.txt"), fx.root.join("link.txt")).unwrap();
        std::os::unix::fs::symlink(fx.root.join("home"), fx.root.join("homelink")).unwrap();

        // Visible in listings, marked by classify, refused by every op.
        let names: Vec<String> = fx
            .mini
            .list("")
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert!(names.contains(&"link.txt".to_string()));
        assert_eq!(
            fx.mini.classify("link.txt").unwrap().kind,
            fs_ops::PathKind::Symlink
        );
        assert!(fx.mini.read("link.txt").is_err());
        assert!(fx.mini.write_text("link.txt", "x").is_err());
        assert!(fx.mini.remove_safe("link.txt").is_err());
        assert!(fx.mini.move_plain("link.txt", "moved.txt").is_err());
        assert!(fx.mini.copy_plain("link.txt", "copied.txt").is_err());
        // A directory symlink is not a valid terminal start directory.
        assert!(fx.mini.resolve_directory("homelink").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn special_nodes_are_omitted_and_refused() {
        let fx = fixture();
        let status = std::process::Command::new("mkfifo")
            .arg(fx.root.join("pipe"))
            .status()
            .expect("mkfifo");
        assert!(status.success());
        let names: Vec<String> = fx
            .mini
            .list("")
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert!(!names.contains(&"pipe".to_string()), "FIFOs never list");
        assert!(fx.mini.read("pipe").is_err(), "a FIFO read is refused");
        assert!(fx.mini.remove_safe("pipe").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_entries_are_skipped_not_aliased() {
        use std::os::unix::ffi::OsStrExt as _;
        let fx = fixture();
        let bad = std::ffi::OsStr::from_bytes(b"bad-\xff-name");
        stdfs::write(fx.root.join(bad), "x").unwrap();
        stdfs::write(fx.root.join("good.txt"), "x").unwrap();
        let names: Vec<String> = fx
            .mini
            .list("")
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert!(names.contains(&"good.txt".to_string()));
        assert!(
            !names.iter().any(|n| n.contains("bad-")),
            "a non-UTF-8 name must not appear under a lossy alias: {names:?}"
        );
    }

    #[test]
    fn listing_shows_dotfiles_and_control_dirs() {
        let fx = fixture();
        stdfs::create_dir(fx.root.join(".git")).unwrap();
        stdfs::create_dir(fx.root.join(".chan")).unwrap();
        stdfs::write(fx.root.join(".zshrc"), "export A=1").unwrap();
        let names: Vec<String> = fx
            .mini
            .list("")
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        for expected in [".git", ".chan", ".zshrc"] {
            assert!(names.contains(&expected.to_string()), "missing {expected}");
        }
    }

    #[test]
    fn extensionless_text_sniffs_and_binary_refuses() {
        let fx = fixture();
        stdfs::write(fx.root.join("Kconfig"), "config FOO\n\tbool\n").unwrap();
        stdfs::write(fx.root.join("blob.bin"), [0u8, 159, 146, 150]).unwrap();
        assert!(fx.mini.sniff_is_text("Kconfig"));
        assert!(fx.mini.read_text_with_stat("Kconfig").is_ok());
        assert!(!fx.mini.sniff_is_text("blob.bin"));
        assert!(fx.mini.read_text_with_stat("blob.bin").is_err());
    }

    #[test]
    fn streamed_read_emits_meta_chunks_done() {
        let fx = fixture();
        stdfs::write(fx.root.join("note.md"), "hello world").unwrap();
        let mut saw_meta = false;
        let mut body = String::new();
        let mut saw_done = false;
        fx.mini
            .read_text_with_stat_chunked("note.md", 4, |event| {
                match event {
                    TextReadEvent::Meta(stat) => {
                        assert_eq!(stat.size, 11);
                        saw_meta = true;
                    }
                    TextReadEvent::Chunk(chunk) => body.push_str(chunk),
                    TextReadEvent::Done => saw_done = true,
                }
                true
            })
            .unwrap();
        assert!(saw_meta && saw_done);
        assert_eq!(body, "hello world");
    }

    #[test]
    fn cas_write_succeeds_fresh_and_conflicts_stale() {
        let fx = fixture();
        stdfs::write(fx.root.join("note.md"), "v1").unwrap();
        let (_, stat) = fx.mini.read_text_with_stat("note.md").unwrap();
        fx.mini
            .write_text_if_unchanged("note.md", stat.mtime_ns, Some("v1"), "v2")
            .unwrap();
        // The stale token now conflicts and reports the current one.
        let conflict = fx
            .mini
            .write_text_if_unchanged("note.md", stat.mtime_ns, Some("v1"), "v3");
        assert!(matches!(conflict, Err(ChanError::WriteConflict { .. })));
        assert_eq!(fx.mini.read_text_with_stat("note.md").unwrap().0, "v2");
    }

    #[test]
    fn create_refuses_existing_paths() {
        let fx = fixture();
        fx.mini.create_file("new.md", "x").unwrap();
        assert!(matches!(
            fx.mini.create_file("new.md", "y"),
            Err(ChanError::PathAlreadyExists(_))
        ));
        fx.mini.create_dir("fresh").unwrap();
        assert!(matches!(
            fx.mini.create_dir("fresh"),
            Err(ChanError::PathAlreadyExists(_))
        ));
    }

    #[test]
    fn remove_safe_covers_files_and_empty_dirs_only() {
        let fx = fixture();
        stdfs::write(fx.root.join("gone.txt"), "x").unwrap();
        fx.mini.remove_safe("gone.txt").unwrap();
        assert!(!fx.root.join("gone.txt").exists());

        stdfs::create_dir(fx.root.join("empty")).unwrap();
        fx.mini.remove_safe("empty").unwrap();
        assert!(!fx.root.join("empty").exists());

        stdfs::create_dir(fx.root.join("full")).unwrap();
        stdfs::write(fx.root.join("full/inner.txt"), "x").unwrap();
        assert!(matches!(
            fx.mini.remove_safe("full"),
            Err(ChanError::DirectoryNotEmpty(path)) if path == "full"
        ));
        assert!(fx.root.join("full/inner.txt").exists(), "nothing mutated");
    }

    #[test]
    fn move_plain_renames_without_clobbering() {
        let fx = fixture();
        stdfs::write(fx.root.join("a.txt"), "a").unwrap();
        stdfs::write(fx.root.join("b.txt"), "b").unwrap();
        fx.mini.move_plain("a.txt", "moved/a.txt").unwrap();
        assert_eq!(
            stdfs::read_to_string(fx.root.join("moved/a.txt")).unwrap(),
            "a"
        );
        assert!(matches!(
            fx.mini.move_plain("moved/a.txt", "b.txt"),
            Err(ChanError::PathAlreadyExists(_))
        ));
        assert_eq!(stdfs::read_to_string(fx.root.join("b.txt")).unwrap(), "b");
    }

    #[test]
    fn cross_device_fallback_copies_then_removes_source() {
        let fx = fixture();
        stdfs::create_dir_all(fx.root.join("src/sub")).unwrap();
        stdfs::write(fx.root.join("src/one.txt"), "1").unwrap();
        stdfs::write(fx.root.join("src/sub/two.txt"), "2").unwrap();
        // Exercise the fallback lane directly: EXDEV itself needs two
        // filesystems, but everything after the errno branch is shared.
        fx.mini.move_across_devices("src", "dst").unwrap();
        assert!(!fx.root.join("src").exists(), "source removed last");
        assert_eq!(
            stdfs::read_to_string(fx.root.join("dst/sub/two.txt")).unwrap(),
            "2"
        );
        let leftovers: Vec<String> = fx
            .mini
            .list("")
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .filter(|n| n.contains("chan-copy"))
            .collect();
        assert!(leftovers.is_empty(), "no temp trees remain: {leftovers:?}");
    }

    #[test]
    fn copy_plain_preflights_and_cleans_temp_on_failure() {
        let fx = fixture();
        stdfs::create_dir_all(fx.root.join("tree/sub")).unwrap();
        stdfs::write(fx.root.join("tree/f.txt"), "f").unwrap();
        fx.mini.copy_plain("tree", "tree2").unwrap();
        assert!(fx.root.join("tree2/f.txt").exists());
        assert!(fx.root.join("tree/f.txt").exists(), "copy keeps the source");

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(fx.root.join("tree/f.txt"), fx.root.join("tree/l.txt"))
                .unwrap();
            assert!(
                fx.mini.copy_plain("tree", "tree3").is_err(),
                "a symlink anywhere in the source tree fails the preflight"
            );
            assert!(!fx.root.join("tree3").exists(), "no partial destination");
            let leftovers: Vec<String> = fx
                .mini
                .list("")
                .unwrap()
                .into_iter()
                .map(|e| e.name)
                .filter(|n| n.contains("chan-copy"))
                .collect();
            assert!(leftovers.is_empty(), "temp cleaned: {leftovers:?}");
        }
    }

    #[test]
    fn resolve_free_name_appends_copy_suffixes() {
        let fx = fixture();
        stdfs::write(fx.root.join("doc.md"), "x").unwrap();
        let free = fx.mini.resolve_free_name("", "doc.md").unwrap();
        assert_eq!(free, "doc copy.md");
    }

    #[test]
    fn resolve_directory_requires_a_real_directory() {
        let fx = fixture();
        assert_eq!(
            fx.mini.resolve_directory("home/user").unwrap(),
            fx.root.canonicalize().unwrap().join("home/user")
        );
        assert!(fx.mini.resolve_directory("absent").is_err());
        stdfs::write(fx.root.join("f.txt"), "x").unwrap();
        assert!(fx.mini.resolve_directory("f.txt").is_err());
        // The root itself resolves for parent navigation.
        assert_eq!(
            fx.mini.resolve_directory("").unwrap(),
            fx.root.canonicalize().unwrap()
        );
    }

    #[test]
    fn root_queries_work_through_the_wire_dialect() {
        let fx = fixture();
        assert!(fx.mini.stat("").unwrap().is_dir);
        assert_eq!(
            fx.mini.classify("").unwrap().kind,
            fs_ops::PathKind::Directory
        );
        let names: Vec<String> = fx
            .mini
            .list(".")
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert!(names.contains(&"home".to_string()));
    }
}
