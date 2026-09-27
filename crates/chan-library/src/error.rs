//! The library-wide error type.
//!
//! `Error` is returned by the host lifecycle (`WorkspaceHost::open_*`/`close_*`)
//! and the tenant builder. The variants are generic (workspace / io / config /
//! bad-request / shutting-down) with no HTTP coupling; `chan-server` maps them
//! onto HTTP responses with its own `err_*` helpers and re-exports this type.

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("chan-workspace: {0}")]
    Core(#[from] chan_workspace::ChanError),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("config: {0}")]
    Config(String),
    #[error("{0}")]
    BadRequest(String),
    /// The devserver is stopping or the host's last shutdown sweep has begun.
    /// The message names what was not mounted.
    #[error("{0}")]
    ShuttingDown(String),
}
