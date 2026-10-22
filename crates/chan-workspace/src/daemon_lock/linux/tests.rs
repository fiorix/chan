use super::super::{
    corroborate_daemon_record, read_daemon_record, DaemonAcquire, DaemonLock, DaemonRecord,
    DaemonRecordCheck, DaemonRecordMethod,
};
use super::*;
use std::cell::{Cell, RefCell};
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::rc::Rc;

type ProcReader = Box<dyn Fn(&Path) -> io::Result<String>>;

thread_local! {
    static READER: RefCell<Option<ProcReader>> = const { RefCell::new(None) };
}

pub(super) fn read_proc(path: &Path) -> Option<io::Result<String>> {
    READER.with(|reader| reader.borrow().as_ref().map(|reader| reader(path)))
}

struct ReaderGuard(Option<ProcReader>);

impl Drop for ReaderGuard {
    fn drop(&mut self) {
        READER.with(|reader| *reader.borrow_mut() = self.0.take());
    }
}

fn with_reader<T>(
    reader: impl Fn(&Path) -> io::Result<String> + 'static,
    run: impl FnOnce() -> T,
) -> T {
    let _guard = ReaderGuard(READER.with(|slot| slot.replace(Some(Box::new(reader)))));
    run()
}

struct Fixture {
    _dir: tempfile::TempDir,
    _holder: DaemonLock,
    lock: PathBuf,
    record: DaemonRecord,
    key: KernelKey,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("daemon.lock");
        let record_path = dir.path().join("daemon.json");
        let holder =
            match DaemonLock::acquire(&lock, &record_path, "127.0.0.1:8787", false).unwrap() {
                DaemonAcquire::Daemon(holder) => holder,
                DaemonAcquire::Running(_) => panic!("private fixture lock is free"),
            };
        let metadata = std::fs::metadata(&lock).unwrap();
        let key = KernelKey {
            major: u64::from(libc::major(metadata.dev())) ^ 1,
            minor: u64::from(libc::minor(metadata.dev())),
            inode: metadata.ino(),
        };
        let record = read_daemon_record(&record_path).unwrap();
        Self {
            _dir: dir,
            _holder: holder,
            lock,
            record,
            key,
        }
    }

    fn check(&self, table: Result<String, io::ErrorKind>) -> DaemonRecordCheck {
        self.with_table(table, || {
            corroborate_daemon_record(&self.lock, &self.record)
        })
    }

    fn with_table<T>(&self, table: Result<String, io::ErrorKind>, run: impl FnOnce() -> T) -> T {
        let fdinfo = anchor_row(self.key);
        with_reader(
            move |path| {
                if path == Path::new("/proc/locks") {
                    table.clone().map_err(io::Error::from)
                } else {
                    assert!(path.starts_with("/proc/self/fdinfo"));
                    Ok(fdinfo.clone())
                }
            },
            run,
        )
    }
}

fn key_text(key: KernelKey) -> String {
    format!("{:x}:{:x}:{}", key.major, key.minor, key.inode)
}

fn anchor_row(key: KernelKey) -> String {
    format!(
        "pos:\t0\nlock:\t1: OFDLCK ADVISORY READ -1 {} 0 0\n",
        key_text(key)
    )
}

fn flock_row(key: KernelKey, pid: u32) -> String {
    format!("1: FLOCK ADVISORY WRITE {pid} {} 0 EOF\n", key_text(key))
}

fn exact(live: bool, holder_pid: u32) -> DaemonRecordCheck {
    DaemonRecordCheck {
        live,
        method: DaemonRecordMethod::LinuxProcLocks { holder_pid },
    }
}

#[test]
fn injected_fdinfo_key_is_used_instead_of_stat() {
    let f = Fixture::new();
    let table = flock_row(f.key, f.record.pid);
    assert_eq!(
        f.check(Ok(table)),
        exact(true, f.record.pid),
        "fdinfo selects the kernel key"
    );
}

#[test]
fn matched_wrong_pid_rejects_without_fallback() {
    let f = Fixture::new();
    let other = if f.record.pid == 1 { 2 } else { 1 };
    assert_eq!(
        f.check(Ok(flock_row(f.key, other))),
        exact(false, other),
        "owner mismatch rejects the record"
    );
}

#[test]
fn unavailable_table_and_absent_or_unusable_owner_name_the_fallback() {
    let f = Fixture::new();
    let row = flock_row(f.key, f.record.pid);
    let cases = [
        (
            Err(io::ErrorKind::PermissionDenied),
            DaemonRecordReason::TableUnreadable,
        ),
        (Ok(String::new()), DaemonRecordReason::NoMatchingFlock),
        (
            Ok(flock_row(
                KernelKey {
                    minor: f.key.minor ^ 1,
                    ..f.key
                },
                f.record.pid,
            )),
            DaemonRecordReason::NoMatchingFlock,
        ),
        (
            Ok(row.replace(" 0 EOF", " 1 EOF")),
            DaemonRecordReason::MatchingFlockMalformed,
        ),
        (
            Ok(format!("{row}{row}")),
            DaemonRecordReason::MatchingFlockAmbiguous,
        ),
    ];
    for (table, reason) in cases {
        assert_eq!(f.check(table), DaemonRecordCheck::two_facts(true, reason));
    }
}

#[test]
fn non_live_and_indeterminate_records_reject_before_proc_reads() {
    let mut f = Fixture::new();
    let mut child = std::process::Command::new("/bin/sh")
        .args(["-c", "exit 0"])
        .env_clear()
        .spawn()
        .unwrap();
    let dead_pid = child.id();
    assert!(child.wait().unwrap().success());
    assert_eq!(
        crate::lock::process_alive(dead_pid),
        crate::lock::ProcessLiveness::Dead
    );
    let reads = Rc::new(Cell::new(0));
    let observed = reads.clone();
    with_reader(
        move |_| {
            observed.set(observed.get() + 1);
            Err(io::ErrorKind::PermissionDenied.into())
        },
        || {
            for pid in [dead_pid, 0, u32::MAX] {
                f.record.pid = pid;
                assert_eq!(
                    corroborate_daemon_record(&f.lock, &f.record),
                    DaemonRecordCheck::two_facts(false, DaemonRecordReason::RecordNotLive),
                    "dead or indeterminate identity rejects"
                );
            }
        },
    );
    assert_eq!(reads.get(), 0, "rejected identity needs no proc reading");
}

#[test]
fn free_lock_rejects_without_an_ofd_anchor() {
    let f = Fixture::new();
    drop(f._holder);
    let reads = Rc::new(Cell::new(0));
    let observed = reads.clone();
    let (check, duplicate) = with_reader(
        move |_| {
            observed.set(observed.get() + 1);
            Err(io::ErrorKind::PermissionDenied.into())
        },
        || crate::lock::with_lock_duplicate(|| corroborate_daemon_record(&f.lock, &f.record)),
    );
    assert_eq!(
        check,
        DaemonRecordCheck::two_facts(false, DaemonRecordReason::LockNotHeld),
        "free lock rejects the live pid"
    );
    assert_no_ofd_lock(&duplicate);
    assert_eq!(reads.get(), 0, "a free probe takes no OFD anchor");
}

fn assert_no_ofd_lock(file: &File) {
    let fdinfo =
        std::fs::read_to_string(format!("/proc/self/fdinfo/{}", file.as_raw_fd())).unwrap();
    assert!(
        !fdinfo.contains("OFDLCK"),
        "explicit release removes the duplicate's OFD lock: {fdinfo}"
    );
}

#[test]
fn contended_anchor_unlocks_its_duplicate_after_success_and_read_failure() {
    let f = Fixture::new();
    let (check, duplicate) =
        crate::lock::with_lock_duplicate(|| corroborate_daemon_record(&f.lock, &f.record));
    assert_eq!(check, exact(true, f.record.pid));
    assert_no_ofd_lock(&duplicate);
    drop(duplicate);
    let (check, duplicate) = with_reader(
        |_| Err(io::ErrorKind::PermissionDenied.into()),
        || crate::lock::with_lock_duplicate(|| corroborate_daemon_record(&f.lock, &f.record)),
    );
    assert_eq!(
        check,
        DaemonRecordCheck::two_facts(true, DaemonRecordReason::AnchorUnreadable)
    );
    assert_no_ofd_lock(&duplicate);
}

#[test]
fn conflicting_ofd_lock_names_anchor_call_failure() {
    let f = Fixture::new();
    let writer = crate::lock::open_lock_file(&f.lock).unwrap();
    set_ofd_lock(&writer, libc::F_WRLCK as libc::c_short).unwrap();
    let check = corroborate_daemon_record(&f.lock, &f.record);
    set_ofd_lock(&writer, libc::F_UNLCK as libc::c_short).unwrap();
    assert!(
        matches!(
            check,
            DaemonRecordCheck {
                live: true,
                method: DaemonRecordMethod::TwoFacts {
                    reason: DaemonRecordReason::AnchorLockFailed {
                        errno: Some(libc::EAGAIN | libc::EACCES)
                    }
                }
            }
        ),
        "conflicting byte lock reports its errno: {check:?}"
    );
}

#[test]
fn anchor_parser_requires_one_distinct_kernel_key() {
    let key = KernelKey {
        major: 1,
        minor: 0xab,
        inode: 42,
    };
    let row = anchor_row(key);
    assert_eq!(parse_anchor(&row), Ok(key));
    assert_eq!(parse_anchor(&format!("{row}{row}")), Ok(key));
    for (input, reason) in [
        (String::new(), DaemonRecordReason::AnchorMissing),
        (
            row.replace("OFDLCK", "POSIX"),
            DaemonRecordReason::AnchorMissing,
        ),
        (
            row.replace(" -1 ", " 123 "),
            DaemonRecordReason::AnchorMissing,
        ),
        (
            row.replace("1: OFDLCK", "1: -> OFDLCK"),
            DaemonRecordReason::AnchorMissing,
        ),
        (
            row.replace("1:ab:42", "bad"),
            DaemonRecordReason::AnchorMalformed,
        ),
        (
            format!("{row}{}", anchor_row(KernelKey { inode: 43, ..key })),
            DaemonRecordReason::AnchorAmbiguous,
        ),
    ] {
        assert_eq!(parse_anchor(&input), Err(reason), "{input:?}");
    }
}

#[test]
fn unavailable_anchor_readings_keep_the_reason() {
    let f = Fixture::new();
    for (text, reason) in [
        (String::new(), DaemonRecordReason::AnchorMissing),
        (
            anchor_row(f.key).replace(" 0 0", ""),
            DaemonRecordReason::AnchorMalformed,
        ),
        (
            format!(
                "{}{}",
                anchor_row(f.key),
                anchor_row(KernelKey {
                    inode: f.key.inode ^ 1,
                    ..f.key
                })
            ),
            DaemonRecordReason::AnchorAmbiguous,
        ),
    ] {
        let check = with_reader(
            move |path| {
                assert!(
                    path.starts_with("/proc/self/fdinfo"),
                    "unavailable anchor does not read the table"
                );
                Ok(text.clone())
            },
            || corroborate_daemon_record(&f.lock, &f.record),
        );
        assert_eq!(check, DaemonRecordCheck::two_facts(true, reason));
    }
}

#[test]
fn parser_ignores_other_inodes_and_both_device_components() {
    let key = KernelKey {
        major: 1,
        minor: 2,
        inode: 3,
    };
    let target = flock_row(key, 100);
    for other in [
        KernelKey { inode: 4, ..key },
        KernelKey { major: 4, ..key },
        KernelKey { minor: 4, ..key },
    ] {
        let prefix = flock_row(other, 200);
        assert_eq!(
            parse_holder(&prefix, key),
            Err(DaemonRecordReason::NoMatchingFlock),
            "whole kernel key is required"
        );
        assert_eq!(parse_holder(&format!("{prefix}{target}"), key), Ok(100));
    }
}

#[test]
fn parser_ignores_waiters_other_classes_and_read_mode() {
    let key = KernelKey {
        major: 1,
        minor: 2,
        inode: 3,
    };
    let row = flock_row(key, 100);
    for ignored in [
        row.replace("1: FLOCK", "1: -> FLOCK"),
        row.replace("FLOCK", "POSIX"),
        row.replace("FLOCK", "OFDLCK"),
        row.replace("WRITE", "READ"),
    ] {
        assert_eq!(
            parse_holder(&ignored, key),
            Err(DaemonRecordReason::NoMatchingFlock),
            "only a granted exclusive flock identifies its taker: {ignored}"
        );
        assert_eq!(parse_holder(&format!("{ignored}{row}"), key), Ok(100));
    }
}

#[test]
fn parser_refuses_malformed_or_ambiguous_matching_rows() {
    let key = KernelKey {
        major: 1,
        minor: 2,
        inode: 3,
    };
    let row = flock_row(key, 100);
    for bad in [
        row.replace(" 100 ", " 0 "),
        row.replace(" 100 ", " -1 "),
        row.replace(" 100 ", " 2147483648 "),
        row.replace(" 100 ", " 18446744073709551616 "),
        row.replace(" 100 ", " +100 "),
        row.replace(" 100 ", " x "),
        row.replace(" 0 EOF", " 1 EOF"),
        row.replace(" EOF", " 100"),
        row.replace(" EOF", ""),
        row.replace("ADVISORY", "MANDATORY"),
        row.replace("1: FLOCK", "bad FLOCK"),
        format!("{} extra", row.trim()),
    ] {
        assert_eq!(
            parse_holder(&format!("{row}{bad}"), key),
            Err(DaemonRecordReason::MatchingFlockMalformed),
            "malformed matching row is not ignored: {bad}"
        );
    }
    for other in [100, 200] {
        assert_eq!(
            parse_holder(&format!("{row}{}", flock_row(key, other)), key),
            Err(DaemonRecordReason::MatchingFlockAmbiguous)
        );
    }
    for bad_key in [
        "1:2:18446744073709551616",
        "10000000000000000:2:3",
        "1:x:3",
        "1:2:3:4",
        "-1:2:3",
    ] {
        assert_eq!(
            parse_holder(&row.replace("1:2:3", bad_key), key),
            Err(DaemonRecordReason::NoMatchingFlock),
            "malformed keys never partially match"
        );
    }
}

#[test]
fn owner_lookup_reads_beyond_the_first_buffer() {
    let f = Fixture::new();
    let prefix = flock_row(
        KernelKey {
            inode: f.key.inode ^ 1,
            ..f.key
        },
        123,
    )
    .repeat(2048);
    assert!(prefix.len() > 8192);
    let table = format!("{prefix}{}", flock_row(f.key, f.record.pid));
    let path = f._dir.path().join("proc-locks");
    std::fs::write(&path, &table).unwrap();
    assert_eq!(
        parse_holder(&super::read_proc(&path).unwrap(), f.key),
        Ok(f.record.pid),
        "the filesystem reader includes the owner beyond its first buffer"
    );
    assert_eq!(
        f.check(Ok(table)),
        exact(true, f.record.pid),
        "owner beyond the first buffer is read"
    );
}
