//! Durable document/scene authority metadata.
//!
//! A session owns one bounded JSON record under the workspace-internal
//! `.chan/editor-sessions/v1/` tree. Records use the workspace's canonical
//! chunk-fed atomic writer, so a crash exposes either the previous complete
//! record or the next one, never a partial JSON file. The matching reader is
//! the workspace's bounded reader and refuses records above
//! [`RECOVERY_RECORD_LIMIT`].

use std::io::{self, Write};

use chan_workspace::{AtomicWriteKind, AtomicWriteSink, ChanError, Workspace, WorkspacePath};
use serde::{Deserialize, Serialize};

const RECOVERY_FORMAT: u8 = 1;

/// Largest editor-session recovery record this reader will accept.
///
/// This deliberately does NOT track the workspace transfer ceiling, and the
/// two being equal today is coincidence rather than duplication. A recovery
/// record is read whole into memory on the editor-open path, so its bound is
/// an allocation bound; the transfer ceiling governs streamed writes and is
/// configured in the tens of gigabytes. Pointing this at the transfer ceiling
/// would turn a corrupt or hostile record into a multi-gigabyte allocation the
/// moment a user opens a file. Do not unify the two constants.
const RECOVERY_RECORD_LIMIT: u64 = 50 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RecoveryKind {
    Document,
    Scene,
}

impl RecoveryKind {
    fn directory(self) -> &'static str {
        match self {
            Self::Document => "documents",
            Self::Scene => "scenes",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RecoveryBaseline {
    pub content: String,
    pub content_hash: u64,
    pub mtime_ns: Option<i64>,
    pub authority_version: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RecoveryConflict {
    pub id: String,
    pub baseline_version: u64,
    pub disk_version: u64,
    pub authority_version: u64,
    pub disk_mtime_ns: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(crate) enum RecoveryState {
    Clean,
    Dirty,
    Conflicted { conflict: RecoveryConflict },
    Removed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RecoveryRecord {
    format: u8,
    pub kind: RecoveryKind,
    pub path: String,
    #[serde(flatten)]
    pub authority: RecoveryAuthority,
    pub baseline: RecoveryBaseline,
    pub lifecycle: RecoveryState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RecoveryAuthority {
    #[serde(rename = "authority")]
    pub content: String,
    #[serde(rename = "authority_version")]
    pub version: u64,
    pub write_budget: u64,
    pub flushed_mtime_ns: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SkippedRecovery {
    format: u8,
    kind: RecoveryKind,
    path: String,
    skipped: bool,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum StoredRecovery {
    Record(RecoveryRecord),
    Skipped(SkippedRecovery),
}

impl RecoveryRecord {
    pub fn new(
        kind: RecoveryKind,
        path: String,
        authority: RecoveryAuthority,
        baseline: RecoveryBaseline,
        lifecycle: RecoveryState,
    ) -> Self {
        Self {
            format: RECOVERY_FORMAT,
            kind,
            path,
            authority,
            baseline,
            lifecycle,
        }
    }

    fn validate_identity(&self, kind: RecoveryKind, path: &str) -> Result<(), ChanError> {
        if self.format != RECOVERY_FORMAT {
            return Err(ChanError::Io(format!(
                "unsupported editor-session recovery format {}",
                self.format
            )));
        }
        if self.kind != kind || self.path != path {
            return Err(ChanError::Io(
                "editor-session recovery identity does not match its path".into(),
            ));
        }
        if self.authority.content.len() as u64 > self.authority.write_budget {
            return Err(ChanError::Io(
                "editor-session recovery authority exceeds its write budget".into(),
            ));
        }
        if crate::disk_echo::content_hash(&self.baseline.content) != self.baseline.content_hash {
            return Err(ChanError::Io(
                "editor-session recovery baseline hash mismatch".into(),
            ));
        }
        if self.baseline.authority_version > self.authority.version {
            return Err(ChanError::Io(
                "editor-session recovery baseline version is ahead of authority".into(),
            ));
        }
        if let RecoveryState::Conflicted { conflict } = &self.lifecycle {
            if conflict.baseline_version != self.baseline.content_hash
                || conflict.authority_version != self.authority.version
            {
                return Err(ChanError::Io(
                    "editor-session recovery conflict version mismatch".into(),
                ));
            }
        }
        Ok(())
    }
}

impl SkippedRecovery {
    fn new(record: &RecoveryRecord) -> Self {
        Self {
            format: RECOVERY_FORMAT,
            kind: record.kind,
            path: record.path.clone(),
            skipped: true,
        }
    }

    fn validate_identity(&self, kind: RecoveryKind, path: &str) -> Result<(), ChanError> {
        if self.format != RECOVERY_FORMAT || self.kind != kind || self.path != path || !self.skipped
        {
            return Err(ChanError::Io(
                "invalid editor-session skipped-recovery marker".into(),
            ));
        }
        Ok(())
    }
}

fn recovery_path(kind: RecoveryKind, path: &str) -> Result<String, ChanError> {
    chan_workspace::fs_ops::validate_rel(path)?;
    Ok(format!(
        ".chan/editor-sessions/v1/{}/{}.json",
        kind.directory(),
        path
    ))
}

pub(crate) fn load(
    workspace: &Workspace,
    kind: RecoveryKind,
    path: &str,
) -> Result<Option<RecoveryRecord>, ChanError> {
    let recovery_path = recovery_path(kind, path)?;
    match load_inner(workspace, kind, path, &recovery_path) {
        Ok(record) => Ok(record),
        Err(error) => {
            tracing::warn!(
                path,
                ?kind,
                %error,
                "ignoring unusable editor-session recovery record"
            );
            Ok(None)
        }
    }
}

fn load_inner(
    workspace: &Workspace,
    kind: RecoveryKind,
    path: &str,
    recovery_path: &str,
) -> Result<Option<RecoveryRecord>, ChanError> {
    match workspace.classify_workspace_path(recovery_path)? {
        WorkspacePath::Missing => return Ok(None),
        WorkspacePath::Regular(stat) if stat.size <= RECOVERY_RECORD_LIMIT => {}
        WorkspacePath::Regular(_) => {
            return Err(ChanError::Io(format!(
                "editor-session recovery record exceeds {RECOVERY_RECORD_LIMIT} bytes"
            )));
        }
        WorkspacePath::Directory(_) | WorkspacePath::Special(_) => {
            return Err(ChanError::Io(
                "editor-session recovery record is not a regular file".into(),
            ));
        }
    }

    let mut reader = workspace.read_bytes_bounded(recovery_path)?;
    let capacity = usize::try_from(reader.stat().size)
        .unwrap_or(usize::MAX)
        .min(RECOVERY_RECORD_LIMIT as usize);
    let mut bytes = Vec::with_capacity(capacity);
    for chunk in &mut reader {
        let chunk = chunk?;
        let next_len = bytes
            .len()
            .checked_add(chunk.len())
            .ok_or_else(|| ChanError::Io("editor-session recovery size overflow".into()))?;
        if next_len as u64 > RECOVERY_RECORD_LIMIT {
            return Err(ChanError::Io(format!(
                "editor-session recovery record exceeds {RECOVERY_RECORD_LIMIT} bytes"
            )));
        }
        bytes.extend_from_slice(&chunk);
    }
    let stored: StoredRecovery = serde_json::from_slice(&bytes)
        .map_err(|error| ChanError::Io(format!("parse editor-session recovery: {error}")))?;
    match stored {
        StoredRecovery::Record(record) => {
            record.validate_identity(kind, path)?;
            Ok(Some(record))
        }
        StoredRecovery::Skipped(marker) => {
            marker.validate_identity(kind, path)?;
            Ok(None)
        }
    }
}

pub(crate) fn store(workspace: &Workspace, record: &RecoveryRecord) -> Result<(), ChanError> {
    record.validate_identity(record.kind, &record.path)?;
    let recovery_path = recovery_path(record.kind, &record.path)?;
    let encoded_size = serialized_size(record)?;
    let record_budget = record.authority.write_budget.min(RECOVERY_RECORD_LIMIT);
    if encoded_size > record_budget {
        tracing::warn!(
            path = record.path,
            ?record.kind,
            encoded_size,
            record_budget,
            "skipping editor-session recovery record that exceeds the file budget"
        );
        return write_json(workspace, &recovery_path, &SkippedRecovery::new(record));
    }
    write_json(workspace, &recovery_path, record)
}

fn serialized_size(value: &impl Serialize) -> Result<u64, ChanError> {
    let mut counter = SizeCounter::default();
    serde_json::to_writer(&mut counter, value)
        .map_err(|error| ChanError::Io(format!("size editor-session recovery: {error}")))?;
    Ok(counter.bytes)
}

fn write_json(
    workspace: &Workspace,
    recovery_path: &str,
    value: &impl Serialize,
) -> Result<(), ChanError> {
    workspace
        .write_atomic_stream(recovery_path, AtomicWriteKind::Bytes, |sink| {
            let mut writer = SinkWriter { sink };
            serde_json::to_writer(&mut writer, value).map_err(|error| {
                ChanError::Io(format!("serialize editor-session recovery: {error}"))
            })
        })
        .map(|_| ())
}

#[derive(Default)]
struct SizeCounter {
    bytes: u64,
}

impl Write for SizeCounter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.bytes = self
            .bytes
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| io::Error::other("editor-session recovery size overflow"))?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct SinkWriter<'a> {
    sink: &'a mut dyn AtomicWriteSink,
}

impl Write for SinkWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.sink
            .write_chunk(bytes)
            .map_err(|error| io::Error::other(error.to_string()))?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        std::sync::Arc<Workspace>,
    ) {
        let config = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let library = chan_workspace::Library::open_at(config.path().join("config.toml")).unwrap();
        library.register_workspace(root.path()).unwrap();
        let workspace = library.open_workspace(root.path()).unwrap();
        (config, root, workspace)
    }

    fn record(
        authority: String,
        baseline: String,
        write_budget: u64,
        lifecycle: RecoveryState,
    ) -> RecoveryRecord {
        RecoveryRecord::new(
            RecoveryKind::Document,
            "a.md".into(),
            RecoveryAuthority {
                content: authority,
                version: 2,
                write_budget,
                flushed_mtime_ns: None,
            },
            RecoveryBaseline {
                content_hash: crate::disk_echo::content_hash(&baseline),
                content: baseline,
                mtime_ns: None,
                authority_version: 1,
            },
            lifecycle,
        )
    }

    fn write_raw(workspace: &Workspace, bytes: &[u8]) {
        let path = recovery_path(RecoveryKind::Document, "a.md").unwrap();
        workspace
            .write_atomic_stream(&path, AtomicWriteKind::Bytes, |sink| {
                sink.write_chunk(bytes)
            })
            .unwrap();
    }

    #[test]
    fn corrupt_or_incompatible_record_is_treated_as_absent() {
        let (_config, _root, workspace) = fixture();

        write_raw(&workspace, b"{not json");
        assert!(load(&workspace, RecoveryKind::Document, "a.md")
            .unwrap()
            .is_none());

        let mut incompatible = record(
            "authority".into(),
            "baseline".into(),
            1024,
            RecoveryState::Dirty,
        );
        incompatible.format = RECOVERY_FORMAT + 1;
        write_raw(&workspace, &serde_json::to_vec(&incompatible).unwrap());
        assert!(load(&workspace, RecoveryKind::Document, "a.md")
            .unwrap()
            .is_none());
    }

    #[test]
    fn record_larger_than_file_budget_replaces_stale_recovery_with_absent_marker() {
        let (_config, _root, workspace) = fixture();
        let small = record("local".into(), "disk".into(), 1024, RecoveryState::Dirty);
        store(&workspace, &small).unwrap();
        assert!(load(&workspace, RecoveryKind::Document, "a.md")
            .unwrap()
            .is_some());

        let large = record(
            "a".repeat(1_100_000),
            "b".repeat(1_100_000),
            chan_workspace::TEXT_WRITE_LIMIT,
            RecoveryState::Dirty,
        );
        store(&workspace, &large).unwrap();
        assert!(
            load(&workspace, RecoveryKind::Document, "a.md")
                .unwrap()
                .is_none(),
            "an oversized record must not leave stale recovery authority behind"
        );
    }

    #[test]
    fn conflicted_record_does_not_serialize_a_third_full_content_copy() {
        let conflict = RecoveryConflict {
            id: "doc-1".into(),
            baseline_version: 1,
            disk_version: 2,
            authority_version: 2,
            disk_mtime_ns: None,
        };
        let value = serde_json::to_value(record(
            "authority".into(),
            "baseline".into(),
            1024,
            RecoveryState::Conflicted { conflict },
        ))
        .unwrap();
        assert!(
            value["lifecycle"]["conflict"].get("disk_content").is_none(),
            "live disk content is reconstructed from disk and must not be persisted"
        );
    }
}
