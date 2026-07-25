//! Durable document/scene authority metadata.
//!
//! A session owns one bounded JSON record under the workspace-internal
//! `.chan/editor-sessions/v1/` tree. Records use the workspace's canonical
//! chunk-fed atomic writer, so a crash exposes either the previous complete
//! record or the next one, never a partial JSON file. The matching reader is
//! the bounded W4 reader and refuses records above the binary semantic cap.

use std::io::{self, Write};

use chan_workspace::{
    AtomicWriteKind, AtomicWriteSink, ChanError, Workspace, WorkspacePath, BYTES_WRITE_LIMIT,
};
use serde::{Deserialize, Serialize};

const RECOVERY_FORMAT: u8 = 1;

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
    pub disk_content: String,
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
    match workspace.classify_workspace_path(&recovery_path)? {
        WorkspacePath::Missing => return Ok(None),
        WorkspacePath::Regular(stat) if stat.size <= BYTES_WRITE_LIMIT => {}
        WorkspacePath::Regular(_) => {
            return Err(ChanError::Io(format!(
                "editor-session recovery record exceeds {BYTES_WRITE_LIMIT} bytes"
            )));
        }
        WorkspacePath::Directory(_) | WorkspacePath::Special(_) => {
            return Err(ChanError::Io(
                "editor-session recovery record is not a regular file".into(),
            ));
        }
    }

    let mut reader = workspace.read_bytes_bounded(&recovery_path)?;
    let capacity = usize::try_from(reader.stat().size)
        .unwrap_or(usize::MAX)
        .min(BYTES_WRITE_LIMIT as usize);
    let mut bytes = Vec::with_capacity(capacity);
    for chunk in &mut reader {
        let chunk = chunk?;
        let next_len = bytes
            .len()
            .checked_add(chunk.len())
            .ok_or_else(|| ChanError::Io("editor-session recovery size overflow".into()))?;
        if next_len as u64 > BYTES_WRITE_LIMIT {
            return Err(ChanError::Io(format!(
                "editor-session recovery record exceeds {BYTES_WRITE_LIMIT} bytes"
            )));
        }
        bytes.extend_from_slice(&chunk);
    }
    let record: RecoveryRecord = serde_json::from_slice(&bytes)
        .map_err(|error| ChanError::Io(format!("parse editor-session recovery: {error}")))?;
    record.validate_identity(kind, path)?;
    Ok(Some(record))
}

pub(crate) fn store(workspace: &Workspace, record: &RecoveryRecord) -> Result<(), ChanError> {
    record.validate_identity(record.kind, &record.path)?;
    let recovery_path = recovery_path(record.kind, &record.path)?;
    workspace
        .write_atomic_stream(&recovery_path, AtomicWriteKind::Bytes, |sink| {
            let mut writer = SinkWriter { sink };
            serde_json::to_writer(&mut writer, record).map_err(|error| {
                ChanError::Io(format!("serialize editor-session recovery: {error}"))
            })
        })
        .map(|_| ())
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
