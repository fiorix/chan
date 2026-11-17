//! Server-owned atomic publication for files outside a workspace.

use std::io::Write;
use std::path::Path;

pub(crate) fn write(path: &Path, bytes: &[u8], unix_mode: Option<u32>) -> std::io::Result<()> {
    write_inner(path, bytes, unix_mode, |_| Ok(()))
}

#[cfg(test)]
pub(crate) fn write_with_pre_persist_hook(
    path: &Path,
    bytes: &[u8],
    unix_mode: Option<u32>,
    pre_persist: impl FnOnce(&Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    write_inner(path, bytes, unix_mode, pre_persist)
}

fn write_inner(
    path: &Path,
    bytes: &[u8],
    unix_mode: Option<u32>,
    pre_persist: impl FnOnce(&Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    write_inner_with_byte_producer(path, unix_mode, |tmp| tmp.write_all(bytes), pre_persist)
}

#[cfg(test)]
fn write_with_byte_production_hook(
    path: &Path,
    unix_mode: Option<u32>,
    byte_producer: impl FnOnce(&mut tempfile::NamedTempFile) -> std::io::Result<()>,
) -> std::io::Result<()> {
    write_inner_with_byte_producer(path, unix_mode, byte_producer, |_| Ok(()))
}

fn write_inner_with_byte_producer(
    path: &Path,
    unix_mode: Option<u32>,
    byte_producer: impl FnOnce(&mut tempfile::NamedTempFile) -> std::io::Result<()>,
    pre_persist: impl FnOnce(&Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let dir = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;

    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    set_unix_mode(tmp.as_file(), unix_mode)?;
    byte_producer(&mut tmp)?;
    tmp.as_file().sync_all()?;
    pre_persist(tmp.path())?;
    chan_workspace::fs_ops::persist_tempfile(tmp, path)?;
    sync_dir(dir)
}

#[cfg(unix)]
fn set_unix_mode(file: &std::fs::File, unix_mode: Option<u32>) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    if let Some(mode) = unix_mode {
        file.set_permissions(std::fs::Permissions::from_mode(mode))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn set_unix_mode(_file: &std::fs::File, _unix_mode: Option<u32>) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn sync_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::File::open(dir)?.sync_all()
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier, Mutex};

    use super::*;

    #[test]
    fn interrupted_byte_production_preserves_target_and_cleans_unique_temporaries() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let target = dir.path().join("target.bin");
        let prior = b"\x00prior-target\xff";
        let replacement = b"replacement-that-must-not-publish";
        std::fs::write(&target, prior).expect("seed prior target");
        let barrier = Arc::new(Barrier::new(2));
        let temporary_paths = Arc::new(Mutex::new(Vec::new()));

        let results = std::thread::scope(|scope| {
            let first = {
                let barrier = Arc::clone(&barrier);
                let temporary_paths = Arc::clone(&temporary_paths);
                let target = &target;
                scope.spawn(move || {
                    write_with_byte_production_hook(target, None, |tmp| {
                        let partial = &replacement[..11];
                        tmp.write_all(partial)?;
                        assert_eq!(
                            std::fs::read(tmp.path())?,
                            partial,
                            "failure is injected after only a prefix was produced"
                        );
                        temporary_paths
                            .lock()
                            .expect("temporary path lock")
                            .push(tmp.path().to_path_buf());
                        barrier.wait();
                        Err(std::io::Error::other("injected mid-write failure"))
                    })
                })
            };
            let second = {
                let barrier = Arc::clone(&barrier);
                let temporary_paths = Arc::clone(&temporary_paths);
                let target = &target;
                scope.spawn(move || {
                    write_with_byte_production_hook(target, None, |tmp| {
                        let partial = &replacement[..17];
                        tmp.write_all(partial)?;
                        assert_eq!(
                            std::fs::read(tmp.path())?,
                            partial,
                            "failure is injected after only a prefix was produced"
                        );
                        temporary_paths
                            .lock()
                            .expect("temporary path lock")
                            .push(tmp.path().to_path_buf());
                        barrier.wait();
                        Err(std::io::Error::other("injected mid-write failure"))
                    })
                })
            };
            [
                first.join().expect("first writer"),
                second.join().expect("second writer"),
            ]
        });

        assert!(
            results.iter().all(|result| result
                .as_ref()
                .is_err_and(|error| { error.kind() == std::io::ErrorKind::Other })),
            "both byte producers must surface the injected failure: {results:?}"
        );
        assert_eq!(
            std::fs::read(&target).expect("read preserved target"),
            prior,
            "an interrupted replacement must preserve every prior byte"
        );
        let temporary_paths = temporary_paths.lock().expect("temporary path lock");
        assert_eq!(temporary_paths.len(), 2);
        assert_ne!(
            temporary_paths[0], temporary_paths[1],
            "overlapping attempts must use unique temporary paths"
        );
        assert!(
            temporary_paths.iter().all(|path| !path.exists()),
            "every interrupted attempt must clean its temporary file"
        );
        assert_eq!(
            std::fs::read_dir(dir.path())
                .expect("read target directory")
                .count(),
            1,
            "only the preserved target may remain visible"
        );
    }

    #[test]
    fn pre_publish_failure_leaves_target_untouched_and_cleans_up() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let target = dir.path().join("target.bin");
        let prior = b"prior-target-bytes";
        std::fs::write(&target, prior).expect("seed prior target");
        let error = write_with_pre_persist_hook(target.as_path(), b"replacement", None, |_| {
            Err(std::io::Error::other("injected pre-publish failure"))
        })
        .expect_err("pre-persist failure must surface");
        assert_eq!(error.kind(), std::io::ErrorKind::Other);
        assert_eq!(
            std::fs::read(&target).expect("read preserved target"),
            prior,
            "a refused replacement must preserve every prior byte"
        );
        assert_eq!(
            std::fs::read_dir(dir.path())
                .expect("read target directory")
                .count(),
            1,
            "only the preserved target may remain visible"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_mode_survives_publication() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("temporary directory");
        let target = dir.path().join("mode.bin");
        write(&target, b"bytes", Some(0o600)).expect("publish with mode");
        let mode = std::fs::metadata(&target)
            .expect("stat published file")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "published file lost its mode");
    }

    /// A reader holding the old file open keeps the old bytes while a fresh
    /// open sees the replacement. Windows-only: `File::open` shares by
    /// default there, so `std::fs::rename` replaces the open target; on Unix
    /// the same holds, where the old call already worked.
    #[cfg(windows)]
    #[test]
    fn write_replaces_a_file_open_by_another_handle() {
        use std::io::{Read, Seek, SeekFrom};

        let dir = tempfile::tempdir().expect("temporary directory");
        let target = dir.path().join("shared.bin");
        std::fs::write(&target, b"old-bytes").expect("seed old target");
        let mut reader = std::fs::File::open(&target).expect("open old target");
        write(&target, b"new-bytes", None).expect("replace open target");
        let mut old = Vec::new();
        reader.seek(SeekFrom::Start(0)).expect("rewind reader");
        reader.read_to_end(&mut old).expect("read old bytes");
        assert_eq!(old, b"old-bytes", "open reader did not keep the old bytes");
        assert_eq!(
            std::fs::read(&target).expect("fresh open"),
            b"new-bytes",
            "fresh open did not see the replacement"
        );
    }
}
