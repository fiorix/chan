use std::io;

use thiserror::Error;

/// Umbrella error. Primitive payloads only (strings, integers), so a
/// consumer (chan-workspace) can map it to its own error type as text.
#[derive(Debug, Error)]
pub enum ChanReportError {
    #[error("io: {0}")]
    Io(String),

    #[error("path escapes root: {0}")]
    PathEscapesRoot(String),

    #[error("jsonl parse error at line {line}: {message}")]
    JsonlParse { line: u64, message: String },

    #[error("schema mismatch: expected {expected}, got {found}")]
    SchemaMismatch { expected: u32, found: u32 },

    #[error("walk: {0}")]
    Walk(String),

    #[error("count: {0}")]
    Count(String),
}

impl From<io::Error> for ChanReportError {
    fn from(e: io::Error) -> Self {
        Self::Io(e.to_string())
    }
}
