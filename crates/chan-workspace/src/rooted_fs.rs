// Capability-rooted filesystem core: the open cap-std directory handle
// plus the root path, canonical form, and identity checks that every
// sandboxed user-path operation routes through.

use crate::error::{ChanError, Result};
use crate::fs_ops::{self, AtomicWriteKind, AtomicWriteSink};
use crate::workspace::{
    semantic_write_budget, BoundedFileReader, CopyOutcome, DirEntry, FileStat, TextReadEvent,
    WorkspacePath, WritableFile,
};

/// Per-owner listing policy: the workspace hides its top-level control
/// dirs and tolerates lossy names; a standalone owner shows everything
/// ordinary and skips names its strict-UTF-8 wire cannot carry.
#[derive(Clone, Copy)]
pub(crate) struct ListPolicy {
    pub(crate) hide_internal_top_level: bool,
    pub(crate) skip_non_utf8: bool,
}

/// Crate-private capability-rooted filesystem core shared by `Workspace`
/// and future root-scoped owners: the display root, its canonical form and
/// unix identity, the cap-std directory handle every user-path operation
/// routes through, and the transfer ceiling that bounds opaque-byte writes.
pub(crate) struct RootedFs {
    /// Workspace root as registered; the display form used by errors and
    /// the live path re-checked by `ensure_root_available`.
    root_path: std::path::PathBuf,
    /// Canonical form of `root_path`, computed once at open. Used where
    /// an absolute path is needed and as the slow-path baseline for
    /// trash::restore.
    root_canon: std::path::PathBuf,
    /// Device/inode identity of the capability root on Unix. A deleted root
    /// can be recreated at the same path while this handle still points at the
    /// unlinked original; path existence alone cannot distinguish them.
    #[cfg(unix)]
    root_identity: (u64, u64),
    /// Capability-based handle to the workspace root. All filesystem
    /// ops on user-controllable paths go through this so a mid-path
    /// symlink swap between path-resolution and the actual op
    /// cannot escape the sandbox: cap-std opens each path component
    /// with O_NOFOLLOW and refuses paths that walk outside the
    /// dir handle. The previous resolve_safe_strict + std::fs::op
    /// pair had a small TOCTOU window between the lexical sandbox
    /// check and the kernel-side path walk; cap-std closes it.
    dir: cap_std::fs::Dir,
    /// Effective transfer ceiling inherited immutably from the owning Library.
    /// Kept separate from the current fixed transfer enforcement sites.
    transfer_max_bytes: u64,
}

impl RootedFs {
    /// Open the capability root at `root_path`: lstat shape check, ambient
    /// `Dir` open, canonical form, and unix identity capture.
    pub(crate) fn open(root_path: std::path::PathBuf, transfer_max_bytes: u64) -> Result<RootedFs> {
        // Defensive check: the registered path must still resolve to
        // a directory. A user (or another tool) could have replaced
        // the workspace directory with a symlink, file, or socket since
        // the registry entry was written, in which case our path
        // sandbox and per-op gates would still apply but the workspace
        // shape itself is no longer what the user signed up for.
        // `exists()` follows symlinks, so we use lstat here to catch
        // a "directory turned into a symlink" replacement.
        let meta = match std::fs::symlink_metadata(&root_path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(ChanError::WorkspaceRootMissing(root_path.clone()));
            }
            Err(e) => return Err(ChanError::Io(e.to_string())),
        };
        let ft = meta.file_type();
        if !ft.is_dir() || ft.is_symlink() {
            return Err(ChanError::SpecialFile {
                kind: fs_ops::describe_file_kind(&ft).to_string(),
                path: root_path.clone(),
            });
        }
        let root_canon = match root_path.canonicalize() {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(ChanError::WorkspaceRootMissing(root_path.clone()));
            }
            Err(error) => {
                return Err(ChanError::Io(format!(
                    "canonicalize workspace root: {error}"
                )));
            }
        };
        let dir = cap_std::fs::Dir::open_ambient_dir(&root_path, cap_std::ambient_authority())
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    ChanError::WorkspaceRootMissing(root_path.clone())
                } else {
                    ChanError::Io(format!("open workspace root: {error}"))
                }
            })?;
        #[cfg(unix)]
        let root_identity = {
            use cap_std::fs::MetadataExt as _;
            let opened = dir
                .dir_metadata()
                .map_err(|e| ChanError::Io(format!("stat open workspace root: {e}")))?;
            let identity = (opened.dev(), opened.ino());
            use std::os::unix::fs::MetadataExt as _;
            if identity != (meta.dev(), meta.ino()) {
                return Err(ChanError::WorkspaceRootMissing(root_path.clone()));
            }
            identity
        };
        Ok(RootedFs {
            root_path,
            root_canon,
            #[cfg(unix)]
            root_identity,
            dir,
            transfer_max_bytes,
        })
    }

    /// Validate `rel` into a pure-`Component::Normal` path for the `Dir`.
    pub(crate) fn rel(&self, rel: &str) -> Result<std::path::PathBuf> {
        fs_ops::validate_rel(rel)
    }

    /// Resolve a workspace-relative rel to the (cap-std dir, validated
    /// PathBuf inside that dir) pair the IO helpers operate against.
    /// Every path now routes through the workspace-root `dir` handle:
    /// drafts are real in-root files under `<drafts_dir_name>/...`, so
    /// `.Drafts/untitled-1/draft.md` resolves like any other path. The
    /// cap-std sandbox prevents traversal escape.
    pub(crate) fn resolve_io(&self, rel: &str) -> Result<(&cap_std::fs::Dir, std::path::PathBuf)> {
        let validated = fs_ops::validate_rel(rel)?;
        Ok((&self.dir, validated))
    }

    /// Map a public chan path to the real host path under the root.
    pub(crate) fn resolve_physical_path(&self, rel: &str) -> Result<std::path::PathBuf> {
        let trimmed = rel.trim_matches('/');
        if trimmed.is_empty() || trimmed == "." {
            return Ok(self.root_canon.clone());
        }
        fs_ops::resolve_safe_strict_canon(self.root(), &self.root_canon, trimmed)
    }

    /// Map a public chan path to an existing real directory.
    pub(crate) fn resolve_physical_dir(&self, rel: &str) -> Result<std::path::PathBuf> {
        let abs = self.resolve_physical_path(rel)?;
        let meta = std::fs::metadata(&abs).map_err(|e| ChanError::Io(e.to_string()))?;
        if !meta.is_dir() {
            return Err(ChanError::Io("path is not a directory".into()));
        }
        Ok(abs)
    }

    /// Map a host path back into chan's public namespace when in-root.
    pub(crate) fn physical_path_to_virtual(&self, path: &std::path::Path) -> Option<String> {
        let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        if path == self.root_canon {
            return Some(String::new());
        }
        if let Ok(rel) = path.strip_prefix(&self.root_canon) {
            return Some(posix_path(rel));
        }
        None
    }

    /// Root directory as registered.
    pub(crate) fn root(&self) -> &std::path::Path {
        &self.root_path
    }

    /// Effective ceiling for opaque-byte writes.
    pub(crate) fn transfer_max_bytes(&self) -> u64 {
        self.transfer_max_bytes
    }

    /// Verify that the root path still resolves to the opened directory.
    pub(crate) fn ensure_root_available(&self) -> Result<()> {
        let meta = match std::fs::symlink_metadata(&self.root_path) {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(ChanError::WorkspaceRootMissing(self.root_path.clone()));
            }
            Err(error) => return Err(ChanError::Io(error.to_string())),
        };
        let file_type = meta.file_type();
        if !file_type.is_dir() || file_type.is_symlink() {
            return Err(ChanError::SpecialFile {
                kind: fs_ops::describe_file_kind(&file_type).to_string(),
                path: self.root_path.clone(),
            });
        }
        let live_canon = match self.root_path.canonicalize() {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(ChanError::WorkspaceRootMissing(self.root_path.clone()));
            }
            Err(error) => {
                return Err(ChanError::Io(format!(
                    "canonicalize workspace root: {error}"
                )));
            }
        };
        if live_canon != self.root_canon {
            return Err(ChanError::WorkspaceRootMissing(self.root_path.clone()));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt as _;
            if (meta.dev(), meta.ino()) != self.root_identity {
                return Err(ChanError::WorkspaceRootMissing(self.root_path.clone()));
            }
        }
        Ok(())
    }

    /// Canonical root captured at open.
    pub(crate) fn canonical_root(&self) -> &std::path::Path {
        &self.root_canon
    }

    /// Capability handle to the root; sandboxed relative ops go through it.
    pub(crate) fn dir(&self) -> &cap_std::fs::Dir {
        &self.dir
    }

    /// Classify a path through the sandbox; a missing leaf is a value.
    pub(crate) fn classify_workspace_path(&self, rel: &str) -> Result<WorkspacePath> {
        let rel_path = self.rel(rel)?;
        let metadata = match self.dir.symlink_metadata(&rel_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(WorkspacePath::Missing);
            }
            Err(error) => return Err(map_cap_err(error, &rel_path)),
        };
        let file_type = metadata.file_type();
        let stat = file_stat_from_cap(&metadata);
        if file_type.is_file() && !file_type.is_symlink() {
            return Ok(WorkspacePath::Regular(stat));
        }
        if file_type.is_dir() {
            return Ok(WorkspacePath::Directory(stat));
        }
        Ok(WorkspacePath::Special(path_kind_cap(&file_type)))
    }

    /// Strict write preflight: regular writable target, parents created.
    pub(crate) fn ensure_writable(&self, rel: &str) -> Result<WritableFile> {
        // A capability directory can outlive an unlinked workspace path on
        // Unix. Never preflight or create parents inside that unreachable
        // directory: callers need a typed root-loss error instead.
        self.ensure_root_available()?;
        let rel_path = self.rel(rel)?;
        let stat = match self.dir.symlink_metadata(&rel_path) {
            Ok(metadata) => {
                let file_type = metadata.file_type();
                if !file_type.is_file() || file_type.is_symlink() {
                    return Err(ChanError::SpecialFile {
                        kind: describe_cap_file_kind(&file_type).to_string(),
                        path: rel_path,
                    });
                }
                if metadata.permissions().readonly() {
                    return Err(ChanError::Io(format!(
                        "path is read-only: {}",
                        rel_path.display()
                    )));
                }
                Some(file_stat_from_cap(&metadata))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(map_cap_err(error, &rel_path)),
        };

        if let Some(parent) = rel_path.parent() {
            if !parent.as_os_str().is_empty() {
                self.dir
                    .create_dir_all(parent)
                    .map_err(|error| map_cap_err(error, &rel_path))?;
            }
        }
        let parent = rel_path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty());
        let parent_dir;
        let target_dir = match parent {
            Some(parent) => {
                parent_dir = self
                    .dir
                    .open_dir(parent)
                    .map_err(|error| map_cap_err(error, &rel_path))?;
                &parent_dir
            }
            None => &self.dir,
        };
        let parent_metadata = target_dir
            .dir_metadata()
            .map_err(|error| map_cap_err(error, &rel_path))?;
        if parent_metadata.permissions().readonly() {
            return Err(ChanError::Io(format!(
                "destination directory is read-only: {}",
                parent
                    .unwrap_or_else(|| std::path::Path::new("."))
                    .display()
            )));
        }
        let probe = cap_tempfile::TempFile::new(target_dir)
            .map_err(|error| map_cap_err(error, &rel_path))?;
        drop(probe);
        Ok(WritableFile { stat })
    }

    /// Atomically replace one file from caller-fed chunks.
    pub(crate) fn write_atomic_stream<F>(
        &self,
        rel: &str,
        kind: AtomicWriteKind,
        feed: F,
    ) -> Result<FileStat>
    where
        F: FnOnce(&mut dyn AtomicWriteSink) -> Result<()>,
    {
        if kind == AtomicWriteKind::Text && !self.editable_text_gate(rel) {
            return Err(ChanError::NotEditableText(rel.to_string()));
        }
        let writable = self.ensure_writable(rel)?;
        let existing_size = writable.stat.as_ref().map(|stat| stat.size);
        let limit = match kind {
            AtomicWriteKind::Text => semantic_write_budget(existing_size),
            // The byte budget is this workspace's configured transfer ceiling,
            // not a compiled-in constant, so one server-reported value governs
            // uploads, copies and every other opaque-byte write. The
            // `max(existing_size, ...)` rule is unchanged: a file already
            // larger than the ceiling stays rewritable at its current size, so
            // lowering the ceiling cannot turn existing files read-only.
            AtomicWriteKind::Bytes => {
                std::cmp::max(existing_size.unwrap_or(0), self.transfer_max_bytes)
            }
        };
        let bytes_target_is_text = kind == AtomicWriteKind::Bytes && fs_ops::is_editable_text(rel);
        let validate_utf8 = kind == AtomicWriteKind::Text || bytes_target_is_text;
        let (dir, rel_path) = self.resolve_io(rel)?;
        if let Err(error) =
            fs_ops::atomic_write_stream_in(dir, &rel_path, kind, limit, validate_utf8, feed)
        {
            // Prefer the terminal root-loss condition over an incidental
            // mid-delete I/O failure. This keeps an editor autosave racing
            // `rm -rf <root>` on the stable typed 404 path.
            self.ensure_root_available()?;
            if bytes_target_is_text
                && matches!(
                    &error,
                    ChanError::Io(message)
                        if message == "invalid UTF-8 in streamed text write"
                )
            {
                return Err(ChanError::Io(format!(
                    "refusing to write non-UTF-8 bytes to editable text file: {rel}"
                )));
            }
            return Err(error);
        }
        // The write may have begun while the root still existed and completed
        // through the retained capability after its pathname was removed.
        // Do not report that unreachable commit as success.
        self.ensure_root_available()?;
        self.stat(rel)
    }

    /// Stream one regular file as bounded byte chunks.
    pub(crate) fn read_bytes_bounded(&self, rel: &str) -> Result<BoundedFileReader> {
        self.read_bytes_bounded_slice(rel, 0, u64::MAX)
    }

    /// Stream a clamped byte window of one regular file.
    pub(crate) fn read_bytes_bounded_slice(
        &self,
        rel: &str,
        start: u64,
        len: u64,
    ) -> Result<BoundedFileReader> {
        use std::io::{Seek, SeekFrom};

        let (dir, rel_path) = self.resolve_io(rel)?;
        ensure_regular_file_in(dir, &rel_path)?;
        let mut file = dir
            .open(&rel_path)
            .map_err(|error| map_cap_err(error, &rel_path))?;
        let stat = file_stat_from_cap(&file.metadata()?);
        let start = start.min(stat.size);
        let len = len.min(stat.size - start);
        let slice = (start, len);
        // Seek once, here, so a bad offset fails the caller before any
        // response framing is derived from the slice.
        file.seek(SeekFrom::Start(start))
            .map_err(|error| ChanError::Io(error.to_string()))?;
        Ok(BoundedFileReader {
            stat,
            slice,
            file: Some(file),
            remaining: len,
        })
    }

    /// Read raw bytes from a regular file.
    pub(crate) fn read(&self, rel: &str) -> Result<Vec<u8>> {
        let (dir, rel_path) = self.resolve_io(rel)?;
        ensure_regular_file_in(dir, &rel_path)?;
        let mut f = dir
            .open(&rel_path)
            .map_err(|e| ChanError::Io(e.to_string()))?;
        use std::io::Read;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)?;
        Ok(buf)
    }

    /// Content-sniff whether `rel` is editable text.
    pub(crate) fn sniff_is_text(&self, rel: &str) -> bool {
        use std::io::Read;
        let Ok((dir, rel_path)) = self.resolve_io(rel) else {
            return false;
        };
        if ensure_regular_file_in(dir, &rel_path).is_err() {
            return false;
        }
        let Ok(f) = dir.open(&rel_path) else {
            return false;
        };
        let mut buf = Vec::with_capacity(fs_ops::TEXT_SNIFF_BYTES);
        if f.take(fs_ops::TEXT_SNIFF_BYTES as u64)
            .read_to_end(&mut buf)
            .is_err()
        {
            return false;
        }
        fs_ops::looks_like_text(&buf)
    }

    /// The editable-text gate for `read_text` / `write_text` and
    /// friends: a path the extension classifier already types as text,
    /// OR an unknown-extension file whose leading bytes sniff as text.
    /// Keep the sniff out of `fs_ops::is_editable_text` (which stays a
    /// pure, I/O-free path predicate used in hot index walks); the
    /// content read belongs only on the per-file read/write path.
    fn editable_text_gate(&self, rel: &str) -> bool {
        fs_ops::is_editable_text(rel) || self.sniff_is_text(rel)
    }

    /// Read UTF-8 text behind the editable-text gate.
    pub(crate) fn read_text(&self, rel: &str) -> Result<String> {
        if !self.editable_text_gate(rel) {
            return Err(ChanError::NotEditableText(rel.to_string()));
        }
        let (dir, rel_path) = self.resolve_io(rel)?;
        ensure_regular_file_in(dir, &rel_path)?;
        let mut f = dir
            .open(&rel_path)
            .map_err(|e| ChanError::Io(e.to_string()))?;
        use std::io::Read;
        let mut buf = String::new();
        f.read_to_string(&mut buf)?;
        Ok(buf)
    }

    /// Read UTF-8 text plus the open-handle stat.
    pub(crate) fn read_text_with_stat(&self, rel: &str) -> Result<(String, FileStat)> {
        use std::io::Read;
        if !self.editable_text_gate(rel) {
            return Err(ChanError::NotEditableText(rel.to_string()));
        }
        let (dir, rel_path) = self.resolve_io(rel)?;
        ensure_regular_file_in(dir, &rel_path)?;
        let mut f = dir
            .open(&rel_path)
            .map_err(|e| ChanError::Io(e.to_string()))?;
        let meta = f.metadata()?;
        let mut content = String::new();
        f.read_to_string(&mut content)?;
        let stat = FileStat {
            size: meta.len(),
            mtime: mtime_secs_cap(&meta),
            mtime_ns: mtime_ns_cap(&meta),
            is_dir: false,
        };
        Ok((content, stat))
    }

    /// Stream UTF-8 text chunks after the open-handle stat.
    pub(crate) fn read_text_with_stat_chunked<F>(
        &self,
        rel: &str,
        chunk_size: usize,
        mut on_event: F,
    ) -> Result<()>
    where
        F: FnMut(TextReadEvent<'_>) -> bool,
    {
        use std::io::Read;
        if !self.editable_text_gate(rel) {
            return Err(ChanError::NotEditableText(rel.to_string()));
        }
        let (dir, rel_path) = self.resolve_io(rel)?;
        ensure_regular_file_in(dir, &rel_path)?;
        let mut f = dir
            .open(&rel_path)
            .map_err(|e| ChanError::Io(e.to_string()))?;
        let meta = f.metadata()?;
        let stat = FileStat {
            size: meta.len(),
            mtime: mtime_secs_cap(&meta),
            mtime_ns: mtime_ns_cap(&meta),
            is_dir: false,
        };
        if !on_event(TextReadEvent::Meta(&stat)) {
            return Ok(());
        }

        let mut read_buf = vec![0u8; chunk_size.max(1)];
        let mut pending = Vec::new();
        loop {
            let n = f.read(&mut read_buf)?;
            if n == 0 {
                break;
            }
            pending.extend_from_slice(&read_buf[..n]);
            if !emit_valid_utf8_chunks(rel, &mut pending, &mut on_event)? {
                return Ok(());
            }
        }
        if !pending.is_empty() {
            return Err(ChanError::Io(format!(
                "invalid UTF-8 in editable text file: {rel}"
            )));
        }
        let _ = on_event(TextReadEvent::Done);
        Ok(())
    }

    /// Atomically write UTF-8 text.
    pub(crate) fn write_text(&self, rel: &str, content: &str) -> Result<()> {
        self.write_atomic_stream(rel, AtomicWriteKind::Text, |sink| {
            sink.write_chunk(content.as_bytes())
        })
        .map(|_| ())
    }

    /// CAS write against the mtime token and optional last-observed bytes.
    pub(crate) fn write_text_if_unchanged(
        &self,
        rel: &str,
        expected_mtime_ns: Option<i64>,
        expected_disk: Option<&str>,
        content: &str,
    ) -> Result<()> {
        if !self.editable_text_gate(rel) {
            return Err(ChanError::NotEditableText(rel.to_string()));
        }
        let writable = self.ensure_writable(rel)?;
        let (current, exists) = match writable.stat.as_ref() {
            Some(stat) => (stat.mtime_ns, true),
            None => (None, false),
        };
        let conflict = match (expected_mtime_ns, exists) {
            (None, false) => false,
            (Some(m), true) => current != Some(m) || !self.disk_still_holds(rel, expected_disk),
            _ => true,
        };
        if conflict {
            return Err(ChanError::WriteConflict {
                current_mtime_ns: current,
            });
        }
        self.write_atomic_stream(rel, AtomicWriteKind::Text, |sink| {
            sink.write_chunk(content.as_bytes())
        })
        .map(|_| ())
    }

    /// Whether the file still carries the bytes a CAS caller last
    /// observed. No belief to check means nothing to contradict, so
    /// the mtime stands alone. An unreadable disk answers false: a
    /// write that cannot be shown to be safe is refused rather than
    /// risked.
    fn disk_still_holds(&self, rel: &str, expected_disk: Option<&str>) -> bool {
        let Some(expected) = expected_disk else {
            return true;
        };
        self.read_text(rel).is_ok_and(|disk| disk == expected)
    }

    /// Atomically write raw bytes.
    pub(crate) fn write_bytes(&self, rel: &str, content: &[u8]) -> Result<()> {
        self.write_atomic_stream(rel, AtomicWriteKind::Bytes, |sink| {
            sink.write_chunk(content)
        })
        .map(|_| ())
    }

    /// True iff `rel` resolves under the root to a regular file.
    pub(crate) fn exists(&self, rel: &str) -> bool {
        let Ok((dir, rel_path)) = self.resolve_io(rel) else {
            return false;
        };
        match dir.symlink_metadata(&rel_path) {
            Ok(m) => m.is_file() && !m.file_type().is_symlink(),
            Err(_) => false,
        }
    }

    /// True iff `rel` resolves under the root to a directory.
    pub(crate) fn is_dir(&self, rel: &str) -> bool {
        let Ok((dir, rel_path)) = self.resolve_io(rel) else {
            return false;
        };
        match dir.symlink_metadata(&rel_path) {
            Ok(m) => m.is_dir(),
            Err(_) => false,
        }
    }

    /// Lstat `rel` into a `FileStat`.
    pub(crate) fn stat(&self, rel: &str) -> Result<FileStat> {
        let (dir, rel_path) = self.resolve_io(rel)?;
        let meta = dir
            .symlink_metadata(&rel_path)
            .map_err(|e| ChanError::Io(e.to_string()))?;
        Ok(FileStat {
            size: if meta.is_dir() { 0 } else { meta.len() },
            mtime: mtime_secs_cap(&meta),
            mtime_ns: mtime_ns_cap(&meta),
            is_dir: meta.is_dir(),
        })
    }

    /// One-level listing with the workspace posture: top-level `.chan` /
    /// `.git` hidden, non-UTF-8 names carried lossily.
    pub(crate) fn list(&self, rel: &str) -> Result<Vec<DirEntry>> {
        self.list_with(
            rel,
            ListPolicy {
                hide_internal_top_level: true,
                skip_non_utf8: false,
            },
        )
    }

    /// One-level listing under an explicit owner policy; see [`ListPolicy`].
    pub(crate) fn list_with(&self, rel: &str, policy: ListPolicy) -> Result<Vec<DirEntry>> {
        let at_root = rel.is_empty() || rel == "." || rel == "/";
        // Drafts are real in-root files under `<drafts_dir_name>/...`,
        // so `.Drafts/<name>` lists through the workspace-root handle
        // like any other path.
        let read = if at_root {
            self.dir
                .read_dir(".")
                .map_err(|e| ChanError::Io(e.to_string()))?
        } else {
            let rel_path = self.rel(rel)?;
            self.dir
                .read_dir(&rel_path)
                .map_err(|e| ChanError::Io(e.to_string()))?
        };
        let mut out = Vec::new();
        let mut skipped = 0usize;
        for entry in read {
            if out.len() >= fs_ops::LIST_DIR_LIMIT {
                return Err(ChanError::ListingTooLarge {
                    observed: out.len(),
                    limit: fs_ops::LIST_DIR_LIMIT,
                });
            }
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    tracing::warn!(?rel, ?e, "list: read_dir entry error; skipping");
                    skipped += 1;
                    continue;
                }
            };
            let name = match entry.file_name().to_str() {
                Some(name) => name.to_owned(),
                // A lossy alias cannot round-trip through the wire and can
                // collide with a real UTF-8 name, so an owner that speaks
                // strict UTF-8 paths skips the entry instead of aliasing it.
                None if policy.skip_non_utf8 => {
                    skipped += 1;
                    continue;
                }
                None => entry.file_name().to_string_lossy().into_owned(),
            };
            if policy.hide_internal_top_level && at_root && (name == ".chan" || name == ".git") {
                continue;
            }
            let ft = match entry.file_type() {
                Ok(ft) => ft,
                Err(e) => {
                    tracing::warn!(?rel, ?name, ?e, "list: file_type failed; skipping");
                    skipped += 1;
                    continue;
                }
            };
            if !(ft.is_dir() || ft.is_symlink() || ft.is_file()) {
                continue;
            }
            out.push(DirEntry {
                name,
                is_dir: ft.is_dir(),
            });
        }
        if skipped > 0 {
            tracing::warn!(
                ?rel,
                skipped,
                returned = out.len(),
                "list: directory listing partial",
            );
        }
        Ok(out)
    }

    /// Create a directory chain under the root.
    pub(crate) fn create_dir(&self, rel: &str) -> Result<()> {
        let rel_path = self.rel(rel)?;
        self.dir
            .create_dir_all(&rel_path)
            .map_err(|e| ChanError::Io(e.to_string()))?;
        Ok(())
    }

    /// Rename within the root through the capability handle.
    pub(crate) fn rename(&self, from: &str, to: &str) -> Result<()> {
        let from_rel = self.rel(from)?;
        let to_rel = self.rel(to)?;
        // Source must exist as a regular file or directory; refuse
        // to move a symlink or special file. (renaming a symlink
        // is well-defined at the syscall level but not something
        // the editor should ever do silently.)
        let src_meta = self
            .dir
            .symlink_metadata(&from_rel)
            .map_err(|e| ChanError::Io(e.to_string()))?;
        let src_ft = src_meta.file_type();
        if !(src_ft.is_dir() || (src_ft.is_file() && !src_ft.is_symlink())) {
            return Err(ChanError::SpecialFile {
                kind: describe_cap_file_kind(&src_ft).to_string(),
                path: self.root_path.join(&from_rel),
            });
        }
        self.ensure_writable(to)?;
        if let Some(parent) = to_rel.parent() {
            if !parent.as_os_str().is_empty() {
                self.dir
                    .create_dir_all(parent)
                    .map_err(|e| ChanError::Io(e.to_string()))?;
            }
        }
        // cap-std rename within the same Dir is TOCTOU-free: source
        // and destination resolve through the dir handle, no
        // path-walk through swappable ancestors.
        self.dir
            .rename(&from_rel, &self.dir, &to_rel)
            .map_err(|e| ChanError::Io(e.to_string()))?;
        Ok(())
    }

    /// Duplicate a regular file or subtree; the destination must not exist.
    pub(crate) fn copy(&self, from: &str, to: &str) -> Result<CopyOutcome> {
        let from_rel = self.rel(from)?;
        let to_rel = self.rel(to)?;
        let src_meta = self
            .dir
            .symlink_metadata(&from_rel)
            .map_err(|e| ChanError::Io(e.to_string()))?;
        let src_ft = src_meta.file_type();
        if src_ft.is_symlink() || !(src_ft.is_dir() || src_ft.is_file()) {
            return Err(ChanError::SpecialFile {
                kind: describe_cap_file_kind(&src_ft).to_string(),
                path: self.root_path.join(&from_rel),
            });
        }
        // Refuse to clobber: paste-collision resolution happens in the
        // server (it picks a free name); a bare copy onto an existing
        // path is a programming error, not a silent overwrite.
        if self.dir.symlink_metadata(&to_rel).is_ok() {
            return Err(ChanError::Io(format!(
                "copy destination already exists: {to}"
            )));
        }
        let to_canon = canonical_posix(to);
        let mut created = Vec::new();
        if src_ft.is_file() {
            self.copy_one_file(&from_rel, &to_rel, &to_canon, &mut created)?;
        } else {
            // Create the destination root dir, then walk descendants.
            self.dir
                .create_dir_all(&to_rel)
                .map_err(|e| ChanError::Io(e.to_string()))?;
            self.copy_subtree(&from_rel, &to_rel, &to_canon, &mut created)?;
        }
        created.sort();
        Ok(CopyOutcome { created })
    }

    /// Copy one regular file from `src_rel` to `dst_rel` (both relative
    /// to `self.dir`), recording the destination's workspace-rooted POSIX
    /// path in `created`.
    fn copy_one_file(
        &self,
        src_rel: &std::path::Path,
        dst_rel: &std::path::Path,
        dst_canon: &str,
        created: &mut Vec<String>,
    ) -> Result<()> {
        let src_str = src_rel.to_string_lossy();
        let dst_str = dst_rel.to_string_lossy();
        let mut reader = self.read_bytes_bounded(&src_str)?;
        // The semantic sink supplies the real binary budget, incremental UTF-8
        // validation for editable destinations, same-directory atomic commit,
        // and temp cleanup for every source-read or sink failure.
        self.write_atomic_stream(&dst_str, AtomicWriteKind::Bytes, |sink| {
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
        created.push(dst_canon.to_string());
        Ok(())
    }

    /// Recursively copy the contents of directory `src_rel` into the
    /// already-created `dst_rel`. Skips control dirs; refuses special
    /// files; recreates child directories before copying their files.
    fn copy_subtree(
        &self,
        src_rel: &std::path::Path,
        dst_rel: &std::path::Path,
        dst_canon: &str,
        created: &mut Vec<String>,
    ) -> Result<()> {
        let read = self
            .dir
            .read_dir(src_rel)
            .map_err(|e| ChanError::Io(e.to_string()))?;
        for entry in read {
            let entry = entry.map_err(|e| ChanError::Io(e.to_string()))?;
            let name = entry.file_name();
            let name_str = name.to_string_lossy().to_string();
            // Skip VCS / app control dirs: never duplicate them.
            if matches!(name_str.as_str(), ".chan" | ".git" | ".hg") {
                continue;
            }
            let ft = entry
                .file_type()
                .map_err(|e| ChanError::Io(e.to_string()))?;
            let child_src = src_rel.join(&name);
            let child_dst = dst_rel.join(&name);
            let child_dst_canon = format!("{dst_canon}/{name_str}");
            if ft.is_symlink() || !(ft.is_dir() || ft.is_file()) {
                return Err(ChanError::SpecialFile {
                    kind: describe_cap_file_kind(&ft).to_string(),
                    path: self.root_path.join(&child_src),
                });
            }
            if ft.is_dir() {
                self.dir
                    .create_dir_all(&child_dst)
                    .map_err(|e| ChanError::Io(e.to_string()))?;
                self.copy_subtree(&child_src, &child_dst, &child_dst_canon, created)?;
            } else {
                self.copy_one_file(&child_src, &child_dst, &child_dst_canon, created)?;
            }
        }
        Ok(())
    }

    /// Finder-style collision-free destination name for pasting `name`
    /// into `dest_dir`.
    pub(crate) fn resolve_free_name(&self, dest_dir: &str, name: &str) -> Result<String> {
        let base_dir = canonical_posix(dest_dir);
        let prefix = if base_dir.is_empty() {
            String::new()
        } else {
            format!("{base_dir}/")
        };
        let (stem, ext) = split_name_ext(name);
        let mut candidate = format!("{prefix}{name}");
        if !self.path_exists_any(&candidate) {
            return Ok(candidate);
        }
        // First collision uses " copy", then " copy 2", " copy 3", ...
        let mut n = 1u32;
        loop {
            let suffixed = if n == 1 {
                format!("{stem} copy{ext}")
            } else {
                format!("{stem} copy {n}{ext}")
            };
            candidate = format!("{prefix}{suffixed}");
            if !self.path_exists_any(&candidate) {
                return Ok(candidate);
            }
            n += 1;
            if n > 10_000 {
                return Err(ChanError::Io(format!(
                    "could not find a free name for {name} in {dest_dir}"
                )));
            }
        }
    }

    /// Existence check for collision resolution: true if a file OR
    /// directory (or any non-regular node) occupies `rel`.
    fn path_exists_any(&self, rel: &str) -> bool {
        let Ok(rel_path) = self.rel(rel) else {
            return false;
        };
        self.dir.symlink_metadata(&rel_path).is_ok()
    }
}

fn emit_valid_utf8_chunks<F>(rel: &str, pending: &mut Vec<u8>, on_event: &mut F) -> Result<bool>
where
    F: FnMut(TextReadEvent<'_>) -> bool,
{
    if pending.is_empty() {
        return Ok(true);
    }
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let keep_going = s.is_empty() || on_event(TextReadEvent::Chunk(s));
            pending.clear();
            Ok(keep_going)
        }
        Err(e) => {
            if e.error_len().is_some() {
                return Err(ChanError::Io(format!(
                    "invalid UTF-8 in editable text file: {rel}"
                )));
            }
            let valid_up_to = e.valid_up_to();
            if valid_up_to > 0 {
                let keep_going = {
                    let valid = std::str::from_utf8(&pending[..valid_up_to]).map_err(|e| {
                        ChanError::Io(format!("invalid UTF-8 in editable text file: {rel}: {e}"))
                    })?;
                    on_event(TextReadEvent::Chunk(valid))
                };
                if !keep_going {
                    return Ok(false);
                }
                pending.drain(..valid_up_to);
            }
            if pending.len() > 4 {
                return Err(ChanError::Io(format!(
                    "invalid UTF-8 in editable text file: {rel}"
                )));
            }
            Ok(true)
        }
    }
}

/// Map a `std::io::Error` returned by a cap-std op into our error
/// enum. cap-std rejects sandbox escapes (mid-path symlink pointing
/// outside the dir handle, absolute path passed as rel, `..` that
/// would walk above the root) with a generic io::Error; the message
/// it produces ("a path led outside of the filesystem") is the only
/// portable signal we have to distinguish "you tried to escape"
/// from "regular I/O error". Fragile if cap-std changes the string;
/// a regression test pins it.
pub(crate) fn map_cap_err(err: std::io::Error, rel: &std::path::Path) -> ChanError {
    let msg = err.to_string();
    if msg.contains("outside of the filesystem") || msg.contains("path escape") {
        return ChanError::SymlinkEscape(rel.to_path_buf());
    }
    ChanError::Io(msg)
}

/// cap-std variant of `mtime_secs` for `cap_std::fs::Metadata`.
fn mtime_secs_cap(meta: &cap_std::fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()
        .map(|t| t.into_std())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
}

/// cap-std variant of `mtime_ns` for `cap_std::fs::Metadata`.
fn mtime_ns_cap(meta: &cap_std::fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()
        .map(|t| t.into_std())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|d| i64::try_from(d.as_nanos()).ok())
}

pub(crate) fn file_stat_from_cap(meta: &cap_std::fs::Metadata) -> FileStat {
    FileStat {
        size: if meta.is_dir() { 0 } else { meta.len() },
        mtime: mtime_secs_cap(meta),
        mtime_ns: mtime_ns_cap(meta),
        is_dir: meta.is_dir(),
    }
}

pub(crate) fn path_kind_cap(ft: &cap_std::fs::FileType) -> fs_ops::PathKind {
    if ft.is_dir() {
        return fs_ops::PathKind::Directory;
    }
    if ft.is_symlink() {
        return fs_ops::PathKind::Symlink;
    }
    if ft.is_file() {
        return fs_ops::PathKind::RegularFile;
    }
    #[cfg(unix)]
    {
        use cap_std::fs::FileTypeExt;
        if ft.is_fifo() {
            return fs_ops::PathKind::Fifo;
        }
        if ft.is_socket() {
            return fs_ops::PathKind::Socket;
        }
        if ft.is_block_device() {
            return fs_ops::PathKind::BlockDevice;
        }
        if ft.is_char_device() {
            return fs_ops::PathKind::CharDevice;
        }
    }
    fs_ops::PathKind::Other
}

/// Human-readable name for a cap-std `FileType`. Mirrors
/// `fs_ops::describe_file_kind`. cap-std exposes the same is_*
/// predicates plus the unix-only fifo/socket/char/block via
/// `FileTypeExt`.
pub(crate) fn describe_cap_file_kind(ft: &cap_std::fs::FileType) -> &'static str {
    if ft.is_dir() {
        return "directory";
    }
    if ft.is_symlink() {
        return "symlink";
    }
    if ft.is_file() {
        return "regular";
    }
    #[cfg(unix)]
    {
        use cap_std::fs::FileTypeExt;
        if ft.is_fifo() {
            return "fifo";
        }
        if ft.is_socket() {
            return "socket";
        }
        if ft.is_char_device() {
            return "char_device";
        }
        if ft.is_block_device() {
            return "block_device";
        }
    }
    "unknown"
}

/// cap-std equivalent of `fs_ops::ensure_regular_file`. Lstat
/// through the sandboxed `Dir`; refuse anything that isn't a real
/// regular file (symlink / FIFO / socket / device / directory).
pub(crate) fn ensure_regular_file_in(dir: &cap_std::fs::Dir, rel: &std::path::Path) -> Result<()> {
    let meta = dir.symlink_metadata(rel).map_err(|e| map_cap_err(e, rel))?;
    let ft = meta.file_type();
    if ft.is_file() && !ft.is_symlink() {
        return Ok(());
    }
    Err(ChanError::SpecialFile {
        kind: describe_cap_file_kind(&ft).to_string(),
        path: rel.to_path_buf(),
    })
}

/// Canonicalize a workspace-relative POSIX path for use as a mapping key.
/// Strips a leading `./` and a trailing `/`; leaves an empty string
/// for the workspace root. We intentionally do NOT collapse `..` here;
/// the rename API rejects those upstream via the cap-std sandbox.
pub(crate) fn canonical_posix(p: &str) -> String {
    let s = p.strip_prefix("./").unwrap_or(p);
    s.trim_end_matches('/').to_string()
}

/// Split a basename into `(stem, ext)` where `ext` includes the leading
/// dot, for collision-suffix insertion ("foo.md" -> ("foo", ".md") so a
/// collision becomes "foo copy.md"). A dotfile with no other extension
/// ("`.gitignore`") or a name with no dot keeps the whole name as stem
/// and an empty ext, so the suffix appends at the end ("`.gitignore`" ->
/// "`.gitignore copy`"). A trailing dot is treated as part of the stem.
pub(crate) fn split_name_ext(name: &str) -> (String, String) {
    match name.rfind('.') {
        // A leading dot at index 0 is a dotfile prefix, not an ext.
        Some(idx) if idx > 0 && idx < name.len() - 1 => {
            (name[..idx].to_string(), name[idx..].to_string())
        }
        _ => (name.to_string(), String::new()),
    }
}

fn posix_path(path: &std::path::Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
