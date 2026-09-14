//! Owner checks for local Unix client endpoints.

use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::Path;

pub(crate) fn effective_uid() -> u32 {
    rustix::process::geteuid().as_raw()
}

/// Read without following symlinks: only a socket owned by `euid` is a peer
/// the client may send private request bytes to.
pub(crate) fn owner_socket_metadata(path: &Path, euid: u32) -> std::io::Result<std::fs::Metadata> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.file_type().is_socket() || metadata.uid() != euid {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!(
                "local endpoint {} is not an owner-controlled socket",
                path.display()
            ),
        ));
    }
    Ok(metadata)
}

pub(crate) fn socket_is_owner_controlled(path: &Path) -> bool {
    owner_socket_metadata(path, effective_uid()).is_ok()
}
