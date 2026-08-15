//! The `?app=` request marker.
//!
//! A standalone terminal window is one window family, not two: the same window
//! that holds shells also browses and edits the server machine's filesystem
//! wherever the shared terminal tenant could mount that surface. So a window
//! carries no application discriminator -- but a REQUEST does, on the handful
//! of paths that serve two contracts at once:
//!
//!   - `POST /api/files/upload?app=files` and the other file mutations: the
//!     standalone filesystem contract, next to the `cs upload` transfer lane
//!     that shares the path.
//!   - `GET|PUT /api/session?app=files`: the layout blob of a window that can
//!     hold browser/editor tabs, kept in its own namespace so the same window
//!     booted against a host with no filesystem never restores tabs whose
//!     routes are not there.
//!   - `GET /api/terminal/attach?app=files`: a fresh shell's `cwd` is a
//!     wire-relative path to resolve through the standalone capability root,
//!     not through a workspace.
//!
//! An enum rather than a bool so an unrecognized `?app=` value is a parse
//! rejection instead of a silent fall-through to the default contract.

use serde::{Deserialize, Serialize};

/// Which application contract a request is on, where one path serves two.
/// Absent means the path's default contract (the workspace's, or the transfer
/// lane's). `rename_all = "lowercase"` pins the wire tag `"files"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppQuery {
    /// The standalone filesystem surface the shared terminal tenant mounts.
    Files,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_files_marker_and_rejects_anything_else() {
        assert_eq!(
            serde_json::from_str::<AppQuery>("\"files\"").expect("files parses"),
            AppQuery::Files
        );
        assert_eq!(
            serde_json::to_string(&AppQuery::Files).unwrap(),
            "\"files\""
        );
        // An unknown contract is a rejection, not a quiet default: a client
        // asking for a contract this server does not have must hear so.
        assert!(serde_json::from_str::<AppQuery>("\"graph\"").is_err());
    }
}
