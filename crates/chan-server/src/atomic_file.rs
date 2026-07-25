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
    tmp.persist(path).map_err(|error| error.error)?;
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
}
