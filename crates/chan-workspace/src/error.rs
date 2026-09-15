// One umbrella error type so the FFI surface stays a single enum.
// Variants map cleanly across uniffi (no nested non-uniffi types in
// Display/Debug payloads).

use std::path::PathBuf;

use thiserror::Error;

pub type Result<T> = std::result::Result<T, ChanError>;

#[derive(Debug, Error)]
pub enum ChanError {
    #[error("path is empty")]
    PathEmpty,
    #[error("path escapes workspace root")]
    PathEscape,
    #[error("path is not editable text: {0}")]
    NotEditableText(String),
    #[error("refusing to operate on non-regular file ({kind}): {path}")]
    SpecialFile { kind: String, path: PathBuf },
    #[error("path resolves through a symlink that escapes workspace root: {0}")]
    SymlinkEscape(PathBuf),
    #[error("invalid blob key: {0}")]
    InvalidKey(String),
    #[error("workspace not registered: {0}")]
    WorkspaceNotRegistered(PathBuf),
    #[error("workspace root does not exist: {0}")]
    WorkspaceRootMissing(PathBuf),
    /// The workspace root is not reachable right now, and we cannot say
    /// whether its contents still exist.
    ///
    /// Distinct from [`ChanError::WorkspaceRootMissing`], which is terminal:
    /// this is a TRANSPORT failure. A network filesystem whose client has
    /// stalled, been killed, or been remounted answers every syscall
    /// `ENOTCONN`/`ESTALE`/`EIO` rather than `ENOENT`, and folding that into
    /// "the root is gone" tells an editor its file was deleted when the file
    /// is fine and the mount is not. Callers hold their state and retry;
    /// they must not treat this as removal.
    #[error("workspace root is unavailable ({reason}): {path}")]
    RootUnavailable { path: PathBuf, reason: String },
    #[error("workspace is locked by another process")]
    WorkspaceLocked,
    #[error("workspace is already open in this process; drop the existing handle first")]
    WorkspaceAlreadyOpen,
    #[error("file-descriptor pressure: {active} open workspaces at capacity {capacity}; close a workspace or retry shortly")]
    WorkspaceFdPressure { active: usize, capacity: usize },
    #[error("workspace is already registered at: {0}")]
    WorkspaceAlreadyRegistered(PathBuf),
    #[error("write conflict: file changed on disk (current mtime ns: {current_mtime_ns:?})")]
    WriteConflict { current_mtime_ns: Option<i64> },
    #[error("path already exists: {0}")]
    PathAlreadyExists(String),
    #[error("directory is not empty: {0}")]
    DirectoryNotEmpty(String),
    #[error("path is protected: {0}")]
    ProtectedPath(String),
    #[error("destination is inside the source tree: {0}")]
    DestinationInsideSource(String),
    #[error("draft `{name}` is broken: {message}")]
    DraftBroken { name: String, message: String },
    #[error("write too large: {size} bytes exceeds {limit} byte cap for {kind}")]
    WriteTooLarge {
        kind: &'static str,
        size: u64,
        limit: u64,
    },
    #[error("listing exceeds {limit} entries (encountered at least {observed}); narrow the path or clean up the directory")]
    ListingTooLarge { observed: usize, limit: usize },
    #[error("config decode error in {path}: {message}")]
    ConfigDecode { path: PathBuf, message: String },
    #[error("invalid transfer.max_bytes {value}: expected a value from 1 through {max} bytes")]
    InvalidTransferMaxBytes { value: u64, max: u64 },
    #[error("config encode error: {0}")]
    ConfigEncode(String),
    #[error("search error: {0}")]
    Search(String),
    #[error("graph error: {0}")]
    Graph(String),
    #[error("watch error: {0}")]
    Watch(String),
    #[error("report error: {0}")]
    Report(String),
    #[error("contacts error: {0}")]
    Contacts(String),
    #[error("trash entry not found: {0}")]
    TrashEntryNotFound(String),
    #[error("trash entry corrupt ({id}): {message}")]
    TrashCorrupt { id: String, message: String },
    #[error("trash restore target already exists: {0}")]
    TrashOccupied(String),
    /// A missing path, with the original I/O message preserved for callers.
    #[error("io error: {0}")]
    NotFound(String),
    /// A byte write would put invalid UTF-8 in an editable text file.
    #[error("io error: {0}")]
    NonUtf8EditableText(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("operation cancelled")]
    Cancelled,
}

impl ChanError {
    /// Add operation/resource context without losing a missing-path kind.
    pub fn io_with_context(error: std::io::Error, context: impl std::fmt::Display) -> Self {
        let kind = error.kind();
        let message = format!("{context}: {error}");
        Self::from(std::io::Error::new(kind, message))
    }
}

impl From<std::io::Error> for ChanError {
    fn from(e: std::io::Error) -> Self {
        if e.kind() == std::io::ErrorKind::NotFound {
            ChanError::NotFound(e.to_string())
        } else {
            ChanError::Io(e.to_string())
        }
    }
}

impl From<toml::de::Error> for ChanError {
    fn from(e: toml::de::Error) -> Self {
        ChanError::ConfigDecode {
            path: PathBuf::new(),
            message: e.to_string(),
        }
    }
}

impl From<toml::ser::Error> for ChanError {
    fn from(e: toml::ser::Error) -> Self {
        ChanError::ConfigEncode(e.to_string())
    }
}

impl From<rusqlite::Error> for ChanError {
    fn from(e: rusqlite::Error) -> Self {
        ChanError::Graph(e.to_string())
    }
}

impl From<notify::Error> for ChanError {
    fn from(e: notify::Error) -> Self {
        ChanError::Watch(e.to_string())
    }
}

impl From<crate::index::IndexError> for ChanError {
    fn from(e: crate::index::IndexError) -> Self {
        ChanError::Search(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_kind_survives_io_context() {
        let error = std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "The system cannot find the path specified. (os error 3)",
        );
        let mapped = ChanError::io_with_context(error, "read notes/x.md");
        assert_eq!(
            mapped.to_string(),
            "io error: read notes/x.md: The system cannot find the path specified. (os error 3)"
        );
        assert!(
            matches!(mapped, ChanError::NotFound(_)),
            "kind lost: {mapped:?}"
        );
    }

    #[test]
    fn io_variants_preserve_display() {
        let message = "No such file or directory (os error 2)";
        assert_eq!(
            ChanError::NotFound(message.into()).to_string(),
            ChanError::Io(message.into()).to_string()
        );
        let message = "refusing to write non-UTF-8 bytes to editable text file: note.md";
        assert_eq!(
            ChanError::NonUtf8EditableText(message.into()).to_string(),
            ChanError::Io(message.into()).to_string()
        );
        for kind in [
            std::io::ErrorKind::PermissionDenied,
            std::io::ErrorKind::AlreadyExists,
            std::io::ErrorKind::NotADirectory,
        ] {
            let error =
                ChanError::io_with_context(std::io::Error::new(kind, "not found"), "operation");
            assert!(matches!(error, ChanError::Io(_)));
            assert_eq!(error.to_string(), "io error: operation: not found");
        }
    }
}
