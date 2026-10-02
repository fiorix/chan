//! Ownership checks for Unix control socket paths.

use std::io;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// The effective user whose control socket paths this process may trust.
pub fn effective_uid() -> u32 {
    rustix::process::geteuid().as_raw()
}

/// The short per-user directory used when the runtime directory is absent or unsafe.
pub fn control_socket_fallback_dir_at(root: &Path) -> PathBuf {
    root.join(format!("chan-control-{}", effective_uid()))
}

/// Require a real directory owned by the effective user with mode exactly 0700.
pub fn validate_control_socket_dir(dir: &Path) -> io::Result<()> {
    validate_control_socket_dir_for(dir, effective_uid())
}

fn validate_control_socket_dir_for(dir: &Path, euid: u32) -> io::Result<()> {
    let metadata = std::fs::symlink_metadata(dir).map_err(|err| {
        io::Error::new(
            err.kind(),
            format!("control socket directory {}: {err}", dir.display()),
        )
    })?;
    if metadata.file_type().is_symlink() {
        return Err(refused(dir, "is a symbolic link"));
    }
    if !metadata.file_type().is_dir() {
        return Err(refused(dir, "is not a directory"));
    }
    if metadata.uid() != euid {
        return Err(refused(
            dir,
            &format!("is owned by uid {}, expected uid {euid}", metadata.uid()),
        ));
    }
    let mode = metadata.permissions().mode() & 0o777;
    if mode != 0o700 {
        return Err(refused(dir, &format!("has mode {mode:04o}, expected 0700")));
    }
    Ok(())
}

/// Create a missing private fallback directory, then validate its owner and mode.
pub fn ensure_control_socket_dir(dir: &Path) -> io::Result<()> {
    match std::fs::symlink_metadata(dir) {
        Ok(_) => {}
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            let mut builder = std::fs::DirBuilder::new();
            builder.mode(0o700);
            if let Err(create_err) = builder.create(dir) {
                if create_err.kind() != io::ErrorKind::AlreadyExists {
                    return Err(io::Error::new(
                        create_err.kind(),
                        format!(
                            "creating control socket directory {}: {create_err}",
                            dir.display()
                        ),
                    ));
                }
            }
        }
        Err(err) => {
            return Err(io::Error::new(
                err.kind(),
                format!("reading control socket directory {}: {err}", dir.display()),
            ));
        }
    }
    validate_control_socket_dir(dir)
}

/// Require a real socket node owned by the effective user before connecting.
pub fn validate_control_socket_node(socket: &Path) -> io::Result<()> {
    let metadata = std::fs::symlink_metadata(socket).map_err(|err| {
        io::Error::new(
            err.kind(),
            format!("control socket {}: {err}", socket.display()),
        )
    })?;
    if !metadata.file_type().is_socket() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("control socket {} is not a socket node", socket.display()),
        ));
    }
    if metadata.uid() != effective_uid() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "control socket {} is owned by another user",
                socket.display()
            ),
        ));
    }
    Ok(())
}

fn refused(dir: &Path, reason: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        format!("control socket directory {} {reason}", dir.display()),
    )
}
