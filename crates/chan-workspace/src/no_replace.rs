//! Rename that refuses to replace an existing destination.
//!
//! Checking that a destination is free and then calling rename(2) loses to a
//! writer that creates the destination in between, because rename replaces an
//! existing file or empty directory. Each arm below commits with a rename the
//! OS itself refuses when the destination exists, so a lost race surfaces as
//! `ErrorKind::AlreadyExists` rather than as a replaced file.
//!
//! - Linux: `renameat2(RENAME_NOREPLACE)`. A filesystem without the flag
//!   answers `EINVAL`, and a kernel before 3.15 or a seccomp filter answers
//!   `ENOSYS`; both take the fallback.
//! - macOS: `renameatx_np(RENAME_EXCL)`. Its rename(2) page says the flag,
//!   "on file systems that support it, will cause EEXIST to be returned if the
//!   destination already exists", and that `ENOTSUP` means "flags has a value
//!   that is not supported by the file system", which takes the fallback.
//! - Windows: `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING` fails when the
//!   destination exists, file or directory. Without `MOVEFILE_COPY_ALLOWED` a
//!   move to another volume fails as `ERROR_NOT_SAME_DEVICE` instead of
//!   copying, which callers already read as a cross-device move. The call
//!   takes paths, so each parent is opened through the capability handle and
//!   named by that open handle's final path, as cap-std's own rename does.
//! - FreeBSD and every other target: rename(2) offers no such flag (the
//!   FreeBSD page documents only "If to exists, it is first removed"), so the
//!   fallback is the only arm.
//!
//! The fallback checks and renames under one process-wide lock, so two chan
//! operations in this process cannot both see the destination free. A writer
//! outside chan can still create it between the check and the rename, and
//! then wins. The lock spans every root because a `Workspace` and a
//! `MiniWorkspace` can cover the same directory.
//!
//! On a case-insensitive filesystem a case-only rename (`readme.md` to
//! `README.md`) names an existing entry, the source itself. It never reaches
//! this module: `MiniWorkspace::move_plain`'s early destination check finds
//! the source under the new spelling and refuses it before any arm runs.
//! Whether an arm would refuse it differs by platform and is not relied on,
//! so a caller that allows a case-only rename must handle it before coming
//! here. The other callers rename a fresh staging name, which is never a case
//! alias of its destination.

use std::io;
use std::path::Path;
use std::sync::{Mutex, PoisonError};

use cap_std::fs::Dir;

/// Rename `from` to `to`, both relative to `dir`, failing with
/// `ErrorKind::AlreadyExists` when `to` exists.
pub(crate) fn rename(dir: &Dir, from: &Path, to: &Path) -> io::Result<()> {
    #[cfg(test)]
    if hooks::fallback_forced() {
        return fallback(dir, from, to);
    }
    match native(dir, from, to) {
        Native::Done(result) => result,
        Native::Unsupported => fallback(dir, from, to),
    }
}

enum Native {
    Done(io::Result<()>),
    /// The platform or this filesystem has no no-replace rename.
    #[cfg_attr(windows, allow(dead_code, reason = "MoveFileExW always refuses"))]
    Unsupported,
}

#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
fn native(dir: &Dir, from: &Path, to: &Path) -> Native {
    use rustix::fs::{renameat_with, RenameFlags};

    // Resolve each parent through the capability handle, as cap-std's own
    // rename does, so only the leaf names reach the syscall and no path
    // component outside the sandbox is ever walked by the kernel.
    let opened = (|| Ok::<_, io::Error>((split(dir, from)?, split(dir, to)?)))();
    let ((from_parent, from_leaf), (to_parent, to_leaf)) = match opened {
        Ok(parts) => parts,
        Err(error) => return Native::Done(Err(error)),
    };
    let from_dir = from_parent.as_ref().unwrap_or(dir);
    let to_dir = to_parent.as_ref().unwrap_or(dir);
    match renameat_with(from_dir, from_leaf, to_dir, to_leaf, RenameFlags::NOREPLACE) {
        Ok(()) => Native::Done(Ok(())),
        Err(errno) if no_replace_unsupported(errno) => Native::Unsupported,
        Err(errno) => Native::Done(Err(errno.into())),
    }
}

/// Errnos that mean "this kernel or filesystem cannot refuse to replace",
/// never "the destination exists". `EINVAL` is also what rename answers for a
/// directory moved into itself; the fallback's plain rename then answers the
/// same `EINVAL`, so nothing is hidden by retrying.
#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
fn no_replace_unsupported(errno: rustix::io::Errno) -> bool {
    use rustix::io::Errno;
    errno == Errno::INVAL
        || errno == Errno::NOSYS
        || errno == Errno::NOTSUP
        || errno == Errno::OPNOTSUPP
}

/// Split a validated relative path into its opened parent (`None` for the
/// handle itself) and its leaf name.
#[cfg(any(
    target_os = "linux",
    target_os = "android",
    target_vendor = "apple",
    windows
))]
fn split<'p>(dir: &Dir, path: &'p Path) -> io::Result<(Option<Dir>, &'p std::ffi::OsStr)> {
    let leaf = path.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("rename path has no final name: {}", path.display()),
        )
    })?;
    let parent = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => Some(dir.open_dir(parent)?),
        _ => None,
    };
    Ok((parent, leaf))
}

#[cfg(windows)]
fn native(dir: &Dir, from: &Path, to: &Path) -> Native {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    // Resolve each parent through the capability handle and name it by the
    // final path of that open handle, as cap-std's own Windows rename does.
    // A junction swapped into an intermediate component after the parent is
    // opened is not walked from the root; what remains is the window between
    // reading the handle's path and the move, the same one cap-std has.
    let resolved = (|| {
        let (from_parent, from_leaf) = split(dir, from)?;
        let (to_parent, to_leaf) = split(dir, to)?;
        let mut from_path = handle_path(from_parent.as_ref().unwrap_or(dir))?;
        from_path.push(from_leaf);
        let mut to_path = handle_path(to_parent.as_ref().unwrap_or(dir))?;
        to_path.push(to_leaf);
        Ok::<_, io::Error>((from_path, to_path))
    })();
    let (from_path, to_path) = match resolved {
        Ok(paths) => paths,
        Err(error) => return Native::Done(Err(error)),
    };
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<u16>>()
    };
    let (from_wide, to_wide) = (wide(&from_path), wide(&to_path));
    // SAFETY: both buffers are NUL-terminated UTF-16 that outlive the call.
    let moved = unsafe { MoveFileExW(from_wide.as_ptr(), to_wide.as_ptr(), 0) };
    if moved != 0 {
        Native::Done(Ok(()))
    } else {
        Native::Done(Err(io::Error::last_os_error()))
    }
}

/// The final path of an open directory handle, in its `\\?\` form, which
/// takes a pushed leaf name as is and has no `MAX_PATH` limit.
#[cfg(windows)]
fn handle_path(dir: &Dir) -> io::Result<std::path::PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED,
    };

    let mut buf = vec![0u16; 512];
    loop {
        let capacity = u32::try_from(buf.len()).unwrap_or(u32::MAX);
        // SAFETY: the handle stays open for the borrow of `dir`, and `buf`
        // holds `capacity` UTF-16 units.
        let len = unsafe {
            GetFinalPathNameByHandleW(
                dir.as_raw_handle(),
                buf.as_mut_ptr(),
                capacity,
                FILE_NAME_NORMALIZED,
            )
        } as usize;
        if len == 0 {
            return Err(io::Error::last_os_error());
        }
        // Success returns the length without the NUL; a buffer too small
        // returns the size it needs, NUL included.
        if len < buf.len() {
            buf.truncate(len);
            return Ok(std::ffi::OsString::from_wide(&buf).into());
        }
        buf.resize(len, 0);
    }
}

#[cfg(not(any(
    target_os = "linux",
    target_os = "android",
    target_vendor = "apple",
    windows
)))]
fn native(_dir: &Dir, _from: &Path, _to: &Path) -> Native {
    Native::Unsupported
}

static FALLBACK_LOCK: Mutex<()> = Mutex::new(());

fn fallback(dir: &Dir, from: &Path, to: &Path) -> io::Result<()> {
    let _serial = FALLBACK_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    match dir.symlink_metadata(to) {
        Ok(_) => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("destination exists: {}", to.display()),
            ))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    #[cfg(test)]
    hooks::fallback_window();
    dir.rename(from, dir, to)
}

/// Test-only controls: force the fallback arm on a platform with a native
/// one, and run a closure inside the fallback's check-to-rename window. Both
/// are per thread, so parallel tests cannot see each other's settings.
#[cfg(test)]
pub(crate) mod hooks {
    use std::cell::{Cell, RefCell};

    type Hook = Box<dyn FnOnce()>;

    thread_local! {
        static FORCE_FALLBACK: Cell<bool> = const { Cell::new(false) };
        static WINDOW: RefCell<Option<Hook>> = const { RefCell::new(None) };
    }

    pub(crate) fn force_fallback(on: bool) {
        FORCE_FALLBACK.with(|flag| flag.set(on));
    }

    pub(super) fn fallback_forced() -> bool {
        FORCE_FALLBACK.with(Cell::get)
    }

    pub(crate) fn set_fallback_window(hook: impl FnOnce() + 'static) {
        WINDOW.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
    }

    pub(super) fn fallback_window() {
        if let Some(hook) = WINDOW.with(|slot| slot.borrow_mut().take()) {
            hook();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs as stdfs;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    fn open(tmp: &tempfile::TempDir) -> Dir {
        Dir::open_ambient_dir(tmp.path(), cap_std::ambient_authority()).unwrap()
    }

    fn assert_refuses_existing(forced: bool) {
        hooks::force_fallback(forced);
        let tmp = tempfile::tempdir().unwrap();
        let dir = open(&tmp);
        stdfs::write(tmp.path().join("a.txt"), "a").unwrap();
        stdfs::write(tmp.path().join("b.txt"), "b").unwrap();
        stdfs::create_dir(tmp.path().join("src")).unwrap();
        stdfs::create_dir(tmp.path().join("empty")).unwrap();

        let file = rename(&dir, Path::new("a.txt"), Path::new("b.txt"));
        let empty_dir = rename(&dir, Path::new("src"), Path::new("empty"));

        assert_eq!(file.unwrap_err().kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(empty_dir.unwrap_err().kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(
            stdfs::read_to_string(tmp.path().join("b.txt")).unwrap(),
            "b"
        );
        assert_eq!(
            stdfs::read_to_string(tmp.path().join("a.txt")).unwrap(),
            "a"
        );
        assert!(tmp.path().join("src").is_dir() && tmp.path().join("empty").is_dir());

        rename(&dir, Path::new("a.txt"), Path::new("src/moved.txt")).unwrap();
        assert_eq!(
            stdfs::read_to_string(tmp.path().join("src/moved.txt")).unwrap(),
            "a",
            "a free destination under a subdirectory renames"
        );
        hooks::force_fallback(false);
    }

    #[test]
    fn the_native_arm_refuses_an_existing_file_or_empty_directory() {
        assert_refuses_existing(false);
    }

    #[test]
    fn the_fallback_arm_refuses_an_existing_file_or_empty_directory() {
        assert_refuses_existing(true);
    }

    #[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
    #[test]
    fn only_capability_errnos_take_the_fallback() {
        use rustix::io::Errno;
        for errno in [Errno::INVAL, Errno::NOSYS, Errno::NOTSUP, Errno::OPNOTSUPP] {
            assert!(no_replace_unsupported(errno), "{errno:?}");
        }
        for errno in [Errno::EXIST, Errno::XDEV, Errno::NOTEMPTY, Errno::ACCESS] {
            assert!(!no_replace_unsupported(errno), "{errno:?}");
        }
    }

    /// The fallback's guarantee: a second chan rename to the same free
    /// destination waits for the first and then sees it taken.
    #[test]
    fn the_fallback_serializes_two_chan_renames_to_one_destination() {
        let tmp = tempfile::tempdir().unwrap();
        stdfs::write(tmp.path().join("first.txt"), "first").unwrap();
        stdfs::write(tmp.path().join("second.txt"), "second").unwrap();
        let root = tmp.path().to_path_buf();
        let second_done = Arc::new(AtomicBool::new(false));
        let (start_tx, start_rx) = mpsc::channel::<()>();
        let second = {
            let second_done = Arc::clone(&second_done);
            std::thread::spawn(move || {
                hooks::force_fallback(true);
                let dir = Dir::open_ambient_dir(&root, cap_std::ambient_authority()).unwrap();
                start_rx.recv().unwrap();
                let result = rename(&dir, Path::new("second.txt"), Path::new("dst.txt"));
                second_done.store(true, Ordering::SeqCst);
                result
            })
        };

        let finished_inside_window = Arc::new(AtomicBool::new(true));
        {
            let second_done = Arc::clone(&second_done);
            let finished_inside_window = Arc::clone(&finished_inside_window);
            hooks::set_fallback_window(move || {
                // The first rename holds the lock here, destination checked
                // free; the second is released into it and must wait.
                start_tx.send(()).unwrap();
                std::thread::sleep(Duration::from_millis(200));
                finished_inside_window.store(second_done.load(Ordering::SeqCst), Ordering::SeqCst);
            });
        }
        hooks::force_fallback(true);
        let dir = open(&tmp);
        let first = rename(&dir, Path::new("first.txt"), Path::new("dst.txt"));
        hooks::force_fallback(false);
        let second_result = second.join().unwrap();

        first.unwrap();
        assert!(
            !finished_inside_window.load(Ordering::SeqCst),
            "the second rename must wait while the first holds the window"
        );
        assert_eq!(
            second_result.unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(
            stdfs::read_to_string(tmp.path().join("dst.txt")).unwrap(),
            "first"
        );
        assert_eq!(
            stdfs::read_to_string(tmp.path().join("second.txt")).unwrap(),
            "second"
        );
    }

    /// The fallback's documented limit, pinned so the module text cannot
    /// drift from it: a writer outside chan that lands inside the window is
    /// replaced. The native arms exist because of this case.
    #[test]
    fn the_fallback_loses_to_a_foreign_writer_inside_the_window() {
        let tmp = tempfile::tempdir().unwrap();
        stdfs::write(tmp.path().join("mine.txt"), "mine").unwrap();
        let theirs = tmp.path().join("dst.txt");
        hooks::force_fallback(true);
        hooks::set_fallback_window(move || stdfs::write(theirs, "theirs").unwrap());
        let dir = open(&tmp);

        let result = rename(&dir, Path::new("mine.txt"), Path::new("dst.txt"));
        hooks::force_fallback(false);

        assert!(result.is_ok(), "{result:?}");
        assert_eq!(
            stdfs::read_to_string(tmp.path().join("dst.txt")).unwrap(),
            "mine"
        );
    }
}
