// One umbrella error, so a host matches a single tagged enum. Variants
// carry primitive payloads only; no dependency error type is nested.

use thiserror::Error;

pub type Result<T> = std::result::Result<T, LlmError>;

#[derive(Debug, Error)]
pub enum LlmError {
    #[error("tool error: {0}")]
    Tool(String),
    /// Catch-all for chan-workspace errors that don't have a typed
    /// variant here. Prefer the narrow variants below when matching;
    /// they preserve the kind so hosts can branch (e.g. "show
    /// reload prompt" for `WriteConflict`, "show too-large dialog"
    /// for `WriteTooLarge`); flattening them into this string would lose
    /// the kind the host UX branches on.
    #[error("chan-workspace: {0}")]
    Core(String),
    /// chan-workspace's `WriteConflict` passthrough. The write was a
    /// CAS against `current_mtime_ns` and the file
    /// changed under it; the host should re-read and retry.
    #[error("write conflict: file changed on disk (current mtime ns: {current_mtime_ns:?})")]
    WriteConflict { current_mtime_ns: Option<i64> },
    /// chan-workspace's `WriteTooLarge` passthrough.
    #[error("write too large: {size} bytes exceeds {limit} byte cap for {kind}")]
    WriteTooLarge { kind: String, size: u64, limit: u64 },
    /// chan-workspace's `ListingTooLarge` passthrough.
    #[error("listing too large: {observed} entries (cap {limit})")]
    ListingTooLarge { observed: u64, limit: u64 },
    /// chan-workspace refused a path: sandbox escape, special file,
    /// non-editable extension, or empty rel. The string carries the
    /// chan-workspace Display so the host can show it directly.
    #[error("path refused: {0}")]
    PathRefused(String),
    #[error("io: {0}")]
    Io(String),
    #[error("mcp: {0}")]
    Mcp(String),
}

impl From<std::io::Error> for LlmError {
    fn from(e: std::io::Error) -> Self {
        LlmError::Io(e.to_string())
    }
}

impl From<chan_workspace::ChanError> for LlmError {
    fn from(e: chan_workspace::ChanError) -> Self {
        // Preserve the kind so hosts can branch on the cause.
        // Variants not enumerated here flatten into Core(_) - they
        // are operational (WorkspaceLocked, WorkspaceAlreadyOpen, etc.) or
        // already string-shaped (Search, Graph, Watch).
        match e {
            chan_workspace::ChanError::WriteConflict { current_mtime_ns } => {
                LlmError::WriteConflict { current_mtime_ns }
            }
            chan_workspace::ChanError::WriteTooLarge { kind, size, limit } => {
                LlmError::WriteTooLarge {
                    kind: kind.to_string(),
                    size,
                    limit,
                }
            }
            chan_workspace::ChanError::ListingTooLarge { observed, limit } => {
                LlmError::ListingTooLarge {
                    observed: observed as u64,
                    limit: limit as u64,
                }
            }
            chan_workspace::ChanError::PathEmpty
            | chan_workspace::ChanError::PathEscape
            | chan_workspace::ChanError::NotEditableText(_)
            | chan_workspace::ChanError::SpecialFile { .. }
            | chan_workspace::ChanError::SymlinkEscape(_) => LlmError::PathRefused(e.to_string()),
            other => LlmError::Core(other.to_string()),
        }
    }
}
