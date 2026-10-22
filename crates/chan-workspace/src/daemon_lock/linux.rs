use std::fs::File;
use std::io;
use std::os::fd::AsRawFd;
use std::path::Path;

use super::DaemonRecordReason;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct KernelKey {
    major: u64,
    minor: u64,
    inode: u64,
}

impl KernelKey {
    fn parse(value: &str) -> Option<Self> {
        let mut fields = value.split(':');
        let major = number(fields.next()?, 16)?;
        let minor = number(fields.next()?, 16)?;
        let inode = number(fields.next()?, 10)?;
        if fields.next().is_some() {
            return None;
        }
        Some(Self {
            major,
            minor,
            inode,
        })
    }
}

fn number(value: &str, radix: u32) -> Option<u64> {
    if value.is_empty() || !value.chars().all(|c| c.is_digit(radix)) {
        return None;
    }
    u64::from_str_radix(value, radix).ok()
}

fn set_ofd_lock(file: &File, kind: libc::c_short) -> io::Result<()> {
    // SAFETY: flock has integer fields; zero initializes its padding and pid.
    let mut lock: libc::flock = unsafe { std::mem::zeroed() };
    lock.l_type = kind;
    lock.l_whence = libc::SEEK_SET as libc::c_short;
    lock.l_start = 0;
    lock.l_len = 1;
    lock.l_pid = 0;
    // SAFETY: file owns a live fd, and lock is initialized for this nonblocking
    // operation. OFD locks use the open description, not process-wide ownership.
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_OFD_SETLK, &lock) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

struct OfdReadLock<'a>(&'a File);

impl Drop for OfdReadLock<'_> {
    fn drop(&mut self) {
        // Closing alone would leave the lock on a fork-inherited duplicate.
        let _ = set_ofd_lock(self.0, libc::F_UNLCK as libc::c_short);
    }
}

fn kernel_key(file: &File) -> Result<KernelKey, DaemonRecordReason> {
    set_ofd_lock(file, libc::F_RDLCK as libc::c_short).map_err(|error| {
        DaemonRecordReason::AnchorLockFailed {
            errno: error.raw_os_error(),
        }
    })?;
    let _anchor = OfdReadLock(file);
    #[cfg(test)]
    crate::lock::capture_lock_duplicate(file);
    let fdinfo = read_proc(Path::new(&format!(
        "/proc/self/fdinfo/{}",
        file.as_raw_fd()
    )))
    .map_err(|_| DaemonRecordReason::AnchorUnreadable)?;
    parse_anchor(&fdinfo)
}

fn parse_anchor(fdinfo: &str) -> Result<KernelKey, DaemonRecordReason> {
    let mut key = None;
    for line in fdinfo.lines() {
        let Some(row) = line.strip_prefix("lock:") else {
            continue;
        };
        let fields: Vec<_> = row.split_whitespace().collect();
        if fields.get(1) != Some(&"OFDLCK") || fields.get(4) != Some(&"-1") {
            continue;
        }
        if fields.len() != 8 || fields[2] != "ADVISORY" || !matches!(fields[3], "READ" | "WRITE") {
            return Err(DaemonRecordReason::AnchorMalformed);
        }
        let found = KernelKey::parse(fields[5]).ok_or(DaemonRecordReason::AnchorMalformed)?;
        if key.is_some_and(|prior| prior != found) {
            return Err(DaemonRecordReason::AnchorAmbiguous);
        }
        key = Some(found);
    }
    key.ok_or(DaemonRecordReason::AnchorMissing)
}

pub(super) fn holder_pid(file: &File) -> Result<u32, DaemonRecordReason> {
    // Both fdinfo and /proc/locks use the kernel lock printer. stat can name a
    // different device for a btrfs subvolume, so it is not a lookup key.
    let key = kernel_key(file)?;
    let table =
        read_proc(Path::new("/proc/locks")).map_err(|_| DaemonRecordReason::TableUnreadable)?;
    parse_holder(&table, key)
}

fn parse_holder(table: &str, key: KernelKey) -> Result<u32, DaemonRecordReason> {
    let mut holder = None;
    for line in table.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.get(1) == Some(&"->") {
            continue;
        }
        if fields.get(1) != Some(&"FLOCK") || fields.get(3) != Some(&"WRITE") {
            continue;
        }
        let Some(found) = fields.get(5).and_then(|value| KernelKey::parse(value)) else {
            continue;
        };
        if found.inode != key.inode || found.major != key.major || found.minor != key.minor {
            continue;
        }
        if fields.len() != 8
            || fields[2] != "ADVISORY"
            || fields[6] != "0"
            || fields[7] != "EOF"
            || fields[0]
                .strip_suffix(':')
                .and_then(|id| number(id, 10))
                .is_none()
        {
            return Err(DaemonRecordReason::MatchingFlockMalformed);
        }
        let pid = number(fields[4], 10)
            .and_then(|pid| u32::try_from(pid).ok())
            .filter(|pid| *pid > 0 && *pid <= i32::MAX as u32)
            .ok_or(DaemonRecordReason::MatchingFlockMalformed)?;
        if holder.replace(pid).is_some() {
            return Err(DaemonRecordReason::MatchingFlockAmbiguous);
        }
    }
    holder.ok_or(DaemonRecordReason::NoMatchingFlock)
}

fn read_proc(path: &Path) -> io::Result<String> {
    #[cfg(test)]
    if let Some(result) = tests::read_proc(path) {
        return result;
    }
    std::fs::read_to_string(path)
}

#[cfg(test)]
mod tests;
