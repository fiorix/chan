//! Capability-rooted file operations for a registered workspace's drafts.
//!
//! The root is only `<metadata_key>/Drafts`, never the metadata key itself.
//! Every public path begins with one draft name and is checked against its
//! durable lifetime ID before the rooted filesystem opens it. Callers hold
//! the current `Arc<Workspace>` and a draft operation permit throughout a
//! write; this facade owns neither, so a reset cannot be bypassed through
//! an independently cached handle.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::drafts::{self, WORKSPACE_ID_FILE};
use crate::error::{ChanError, Result};
use crate::fs_ops::{self, AtomicWriteKind, AtomicWriteSink};
use crate::rooted_fs::{ListPolicy, RootedFs};
use crate::workspace::{
    BoundedFileReader, DirEntry, FileStat, TextReadEvent, Workspace, WorkspacePath, WritableFile,
};

/// One operation boundary per draft name in a live Workspace. It is not
/// process-wide state: reset drops the owner after all pinned operations
/// finish, and a new Workspace reopens the preserved marker IDs.
#[derive(Default)]
pub(crate) struct DraftOperations {
    gates: Mutex<HashMap<String, Arc<DraftGate>>>,
}

struct DraftGate {
    id: String,
    state: Mutex<DraftGateState>,
    drained: Condvar,
}

#[derive(Default)]
struct DraftGateState {
    active: usize,
    closing: bool,
    retired: bool,
}

/// Keeps both the draft lifetime and its owning Workspace live through an
/// HTTP request, a WebSocket push or a background writer.
pub struct DraftPin {
    workspace: Arc<Workspace>,
    gate: Arc<DraftGate>,
    name: String,
    id: String,
}

impl DraftPin {
    pub fn workspace(&self) -> &Arc<Workspace> {
        &self.workspace
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn id(&self) -> &str {
        &self.id
    }
}

impl Drop for DraftPin {
    fn drop(&mut self) {
        let mut state = self.gate.state.lock().unwrap_or_else(|e| e.into_inner());
        state.active -= 1;
        if state.active == 0 {
            self.gate.drained.notify_all();
        }
    }
}

/// Exclusive draft boundary. The server settles live authority while this
/// is held, then publishes discard or promotion and retires the lifetime.
/// Dropping an unfinished boundary reopens the still-live source.
pub struct DraftLifecycle {
    workspace: Arc<Workspace>,
    gate: Arc<DraftGate>,
    name: String,
    id: String,
    finished: bool,
}

impl DraftLifecycle {
    pub fn workspace(&self) -> &Arc<Workspace> {
        &self.workspace
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    /// The source was durably removed or moved. Old pins now refuse even
    /// if a new draft reuses its visible name.
    pub fn retire(&mut self) {
        let mut state = self.gate.state.lock().unwrap_or_else(|e| e.into_inner());
        state.retired = true;
        self.finished = true;
        self.gate.drained.notify_all();
    }

    /// A partial publish needs reconciliation before any new writer uses
    /// this lifetime. A fresh Workspace may reopen after reset/recovery.
    pub fn quarantine(&mut self) {
        self.retire();
    }
}

impl Drop for DraftLifecycle {
    fn drop(&mut self) {
        if !self.finished {
            let mut state = self.gate.state.lock().unwrap_or_else(|e| e.into_inner());
            state.closing = false;
            self.gate.drained.notify_all();
        }
    }
}

impl DraftOperations {
    fn gate(&self, name: &str, id: &str) -> Result<Arc<DraftGate>> {
        let mut gates = self.gates.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = gates.get(name) {
            if existing.id == id {
                return Ok(Arc::clone(existing));
            }
            let state = existing.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.active > 0 || state.closing && !state.retired {
                return Err(stale_draft(name));
            }
        }
        let gate = Arc::new(DraftGate {
            id: id.to_string(),
            state: Mutex::new(DraftGateState::default()),
            drained: Condvar::new(),
        });
        gates.insert(name.to_string(), Arc::clone(&gate));
        Ok(gate)
    }

    pub(crate) fn pin(&self, workspace: Arc<Workspace>, name: &str, id: &str) -> Result<DraftPin> {
        let gate = self.gate(name, id)?;
        {
            let mut state = gate.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.closing || state.retired {
                return Err(stale_draft(name));
            }
            state.active += 1;
        }
        Ok(DraftPin {
            workspace,
            gate,
            name: name.to_string(),
            id: id.to_string(),
        })
    }

    /// This wait runs on the server's blocking pool. A long upload gets
    /// five seconds to finish; on timeout the source remains writable.
    pub(crate) fn begin(
        &self,
        workspace: Arc<Workspace>,
        name: &str,
        id: &str,
    ) -> Result<DraftLifecycle> {
        let gate = self.gate(name, id)?;
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut state = gate.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closing || state.retired {
            return Err(stale_draft(name));
        }
        state.closing = true;
        while state.active > 0 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                state.closing = false;
                gate.drained.notify_all();
                return Err(stale_draft(name));
            }
            let (next, _) = gate
                .drained
                .wait_timeout(state, remaining)
                .unwrap_or_else(|e| e.into_inner());
            state = next;
        }
        drop(state);
        Ok(DraftLifecycle {
            workspace,
            gate,
            name: name.to_string(),
            id: id.to_string(),
            finished: false,
        })
    }
}

pub(crate) fn stale_draft(name: &str) -> ChanError {
    ChanError::StaleDraft {
        name: name.to_string(),
    }
}

pub struct DraftFiles {
    fs: RootedFs,
}

impl DraftFiles {
    pub(crate) fn open(root: &Path, transfer_max_bytes: u64) -> Result<Self> {
        Ok(Self {
            fs: RootedFs::open(root.to_path_buf(), transfer_max_bytes)?,
        })
    }

    pub fn root(&self) -> &Path {
        self.fs.root()
    }

    pub fn transfer_max_bytes(&self) -> u64 {
        self.fs.transfer_max_bytes()
    }

    pub fn check_file(&self, rel: &str, draft_id: &str) -> Result<String> {
        self.checked(rel, draft_id, true)
    }

    pub fn check_dir(&self, rel: &str, draft_id: &str) -> Result<String> {
        self.checked(rel, draft_id, false)
    }

    fn checked(&self, rel: &str, draft_id: &str, require_file: bool) -> Result<String> {
        self.fs.ensure_root_available()?;
        let rel = fs_ops::rel_path_text(&fs_ops::validate_rel(rel)?);
        let mut parts = rel.split('/');
        let name = parts.next().ok_or(ChanError::PathEmpty)?;
        drafts::validate_name(name)?;
        let next = parts.next();
        if require_file && next.is_none() {
            return Err(ChanError::PathEmpty);
        }
        if next == Some(WORKSPACE_ID_FILE) {
            return Err(ChanError::ProtectedPath(rel));
        }
        let marker = format!("{name}/{WORKSPACE_ID_FILE}");
        match self.fs.classify_workspace_path(&marker)? {
            WorkspacePath::Regular(stat) if stat.size == 68 => {}
            _ => {
                return Err(ChanError::DraftBroken {
                    name: name.to_string(),
                    message: "draft identity marker is missing or invalid".into(),
                })
            }
        }
        let marker_bytes = self.fs.read(&marker)?;
        let marker_text =
            std::str::from_utf8(&marker_bytes).map_err(|_| ChanError::DraftBroken {
                name: name.to_string(),
                message: "draft identity marker is not UTF-8".into(),
            })?;
        let actual = drafts::parse_workspace_id(name, marker_text)?;
        if actual != draft_id {
            return Err(stale_draft(name));
        }
        Ok(rel)
    }

    pub fn list(&self, dir: &str, draft_id: &str) -> Result<Vec<DirEntry>> {
        let dir = self.check_dir(dir, draft_id)?;
        let mut entries = self.fs.list_with(
            &dir,
            ListPolicy {
                hide_internal_top_level: false,
                skip_non_utf8: true,
            },
        )?;
        if !dir.contains('/') {
            entries.retain(|entry| entry.name != WORKSPACE_ID_FILE);
        }
        Ok(entries)
    }

    pub fn classify(&self, rel: &str, draft_id: &str) -> Result<WorkspacePath> {
        let rel = self.check_file(rel, draft_id)?;
        self.fs.classify_workspace_path(&rel)
    }

    pub fn stat(&self, rel: &str, draft_id: &str) -> Result<FileStat> {
        let rel = self.check_file(rel, draft_id)?;
        self.fs.stat(&rel)
    }

    pub fn sniff_is_text(&self, rel: &str, draft_id: &str) -> bool {
        self.check_file(rel, draft_id)
            .is_ok_and(|rel| self.fs.sniff_is_text(&rel))
    }

    pub fn read(&self, rel: &str, draft_id: &str) -> Result<Vec<u8>> {
        let rel = self.check_file(rel, draft_id)?;
        self.fs.read(&rel)
    }

    pub fn read_text_with_stat(&self, rel: &str, draft_id: &str) -> Result<(String, FileStat)> {
        let rel = self.check_file(rel, draft_id)?;
        self.fs.read_text_with_stat(&rel)
    }

    pub fn read_text_with_stat_chunked<F>(
        &self,
        rel: &str,
        draft_id: &str,
        chunk_size: usize,
        on_event: F,
    ) -> Result<()>
    where
        F: FnMut(TextReadEvent<'_>) -> bool,
    {
        let rel = self.check_file(rel, draft_id)?;
        self.fs
            .read_text_with_stat_chunked(&rel, chunk_size, on_event)
    }

    pub fn read_bytes_bounded(&self, rel: &str, draft_id: &str) -> Result<BoundedFileReader> {
        let rel = self.check_file(rel, draft_id)?;
        self.fs.read_bytes_bounded(&rel)
    }

    pub fn read_bytes_bounded_slice(
        &self,
        rel: &str,
        draft_id: &str,
        start: u64,
        len: u64,
    ) -> Result<BoundedFileReader> {
        let rel = self.check_file(rel, draft_id)?;
        self.fs.read_bytes_bounded_slice(&rel, start, len)
    }

    pub fn ensure_writable(&self, rel: &str, draft_id: &str) -> Result<WritableFile> {
        let rel = self.check_file(rel, draft_id)?;
        self.fs.ensure_writable(&rel)
    }

    pub fn write_text(&self, rel: &str, draft_id: &str, content: &str) -> Result<()> {
        let rel = self.check_file(rel, draft_id)?;
        self.fs.write_text(&rel, content)
    }

    pub fn write_text_if_unchanged(
        &self,
        rel: &str,
        draft_id: &str,
        expected_mtime_ns: Option<i64>,
        expected_disk: Option<&str>,
        content: &str,
    ) -> Result<()> {
        let rel = self.check_file(rel, draft_id)?;
        self.fs
            .write_text_if_unchanged(&rel, expected_mtime_ns, expected_disk, content)
    }

    pub fn write_atomic_stream<F>(
        &self,
        rel: &str,
        draft_id: &str,
        kind: AtomicWriteKind,
        feed: F,
    ) -> Result<FileStat>
    where
        F: FnOnce(&mut dyn AtomicWriteSink) -> Result<()>,
    {
        let rel = self.check_file(rel, draft_id)?;
        self.fs.write_atomic_stream(&rel, kind, feed)
    }

    pub fn create_text_new(&self, rel: &str, draft_id: &str, content: &str) -> Result<()> {
        let rel = self.check_file(rel, draft_id)?;
        self.fs.create_text_new(&rel, content)
    }

    pub fn create_bytes(&self, rel: &str, draft_id: &str, content: &[u8]) -> Result<()> {
        let rel = self.check_file(rel, draft_id)?;
        self.fs.create_bytes(&rel, content)
    }

    /// Absolute path for same-machine terminal delivery after validation.
    pub fn terminal_path(&self, rel: &str, draft_id: &str) -> Result<PathBuf> {
        let rel = self.check_file(rel, draft_id)?;
        if !matches!(
            self.fs.classify_workspace_path(&rel)?,
            WorkspacePath::Regular(_)
        ) {
            return Err(ChanError::NotFound(format!(
                "not a regular draft file: {rel}"
            )));
        }
        self.fs.resolve_physical_path(&rel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Library;

    #[test]
    fn facade_reaches_only_the_named_live_draft_and_hides_its_marker() {
        let config = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let library = Library::open_at(config.path().join("config.toml")).unwrap();
        library.register_workspace(root.path()).unwrap();
        let workspace = library.open_workspace(root.path()).unwrap();
        workspace.create_draft_dir("a").unwrap();
        workspace.create_draft_dir("b").unwrap();
        let a_id = workspace.draft_id("a").unwrap();
        let files = workspace.draft_files().unwrap();

        files.create_text_new("a/draft.md", &a_id, "# a\n").unwrap();
        files
            .create_bytes("a/image.png", &a_id, &[1, 2, 3])
            .unwrap();
        assert_eq!(
            files.read_text_with_stat("a/draft.md", &a_id).unwrap().0,
            "# a\n"
        );
        assert_eq!(files.read("a/image.png", &a_id).unwrap(), [1, 2, 3]);
        assert_eq!(
            files.terminal_path("a/image.png", &a_id).unwrap(),
            workspace.drafts_dir().join("a/image.png")
        );
        assert!(!files
            .list("a", &a_id)
            .unwrap()
            .iter()
            .any(|e| e.name == WORKSPACE_ID_FILE));
        assert!(matches!(
            files.read("a/.chan-draft-id", &a_id),
            Err(ChanError::ProtectedPath(_))
        ));
        assert!(files.read("b/draft.md", &a_id).is_err());
        assert!(files.read("../token", &a_id).is_err());
        assert!(!root.path().join("Drafts").exists());
    }

    #[cfg(unix)]
    #[test]
    fn facade_refuses_symlinked_draft_content() {
        let config = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let library = Library::open_at(config.path().join("config.toml")).unwrap();
        library.register_workspace(root.path()).unwrap();
        let workspace = library.open_workspace(root.path()).unwrap();
        let draft = workspace.create_draft_dir("a").unwrap();
        let id = workspace.draft_id("a").unwrap();
        std::os::unix::fs::symlink(root.path(), draft.abs.join("escape")).unwrap();

        assert!(workspace
            .draft_files()
            .unwrap()
            .read("a/escape/secret.txt", &id)
            .is_err());
    }
}
