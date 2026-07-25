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
    let dir = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;

    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    set_unix_mode(tmp.as_file(), unix_mode)?;
    tmp.write_all(bytes)?;
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
