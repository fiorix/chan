//! A capability-rooted store for chan's own records about one workspace.
//!
//! A workspace's sidecar directory in the chan home holds the state chan
//! manages for it. A layer above that keeps records there, as chan-server
//! does for the editor's recovery, writes and reads them through a
//! `SidecarStore`: the crate-private `RootedFs` core a `Workspace` delegates
//! to, opened at one directory of the sidecar. A record gets the same
//! chunk-fed atomic writer and bounded reader as a file of the workspace,
//! and its path cannot leave the store's directory, without the record
//! passing through the facade that serves the user's own tree.

use std::path::PathBuf;

use crate::error::{ChanError, Result};
use crate::fs_ops::{AtomicWriteKind, AtomicWriteSink};
use crate::rooted_fs::RootedFs;
use crate::workspace::{BoundedFileReader, FileStat, WorkspacePath};

/// Records under one directory of a workspace's sidecar. Paths are relative
/// to that directory.
pub struct SidecarStore {
    fs: RootedFs,
}

impl SidecarStore {
    /// Open the store at `dir`, creating the directory when it is absent.
    pub(crate) fn open(dir: PathBuf, transfer_max_bytes: u64) -> Result<Self> {
        std::fs::create_dir_all(&dir).map_err(|error| {
            ChanError::io_with_context(error, format!("creating {}", dir.display()))
        })?;
        Ok(Self {
            fs: RootedFs::open(dir, transfer_max_bytes)?,
        })
    }

    /// Classify a store-relative path through the capability sandbox.
    ///
    /// A missing leaf is a normal value. Lexical traversal and mid-path
    /// symlink escapes remain typed errors.
    pub fn classify(&self, rel: &str) -> Result<WorkspacePath> {
        self.fs.classify_workspace_path(rel)
    }

    /// Atomically replace one record from caller-fed chunks, creating its
    /// parent directories.
    ///
    /// The target is untouched unless `feed` returns success and every chunk
    /// satisfies the selected budget and UTF-8 policy.
    pub fn write_atomic_stream<F>(
        &self,
        rel: &str,
        kind: AtomicWriteKind,
        feed: F,
    ) -> Result<FileStat>
    where
        F: FnOnce(&mut dyn AtomicWriteSink) -> Result<()>,
    {
        self.fs.write_atomic_stream(rel, kind, feed)
    }

    /// Open one regular file for synchronous reads of at most
    /// [`BINARY_STREAM_CHUNK_SIZE`](crate::BINARY_STREAM_CHUNK_SIZE) bytes on
    /// the caller's thread.
    pub fn read_bytes_bounded(&self, rel: &str) -> Result<BoundedFileReader> {
        self.fs.read_bytes_bounded(rel)
    }
}
