use std::io::{IoSlice, Read, Result};
use std::mem::MaybeUninit;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
use std::os::linux::net::SocketAddrExt;
use std::os::unix::net::{SocketAddr, UnixDatagram, UnixStream};
use std::path::PathBuf;
use std::time::Duration;

use rustix::fs::{fstat, fstatfs};
use rustix::io::{fcntl_getfd, fcntl_setfd, FdFlags};
use rustix::net::{sendmsg, SendAncillaryBuffer, SendAncillaryMessage, SendFlags};
use rustix::process::{pidfd_open, Pid, PidfdFlags};

const LISTEN_FDS_START: i32 = 3;
const PID_FS_MAGIC: u64 = 0x5049_4446;

#[derive(Debug)]
pub struct NamedFd {
    pub name: String,
    pub fd: OwnedFd,
}

pub fn take_listen_fds() -> Vec<NamedFd> {
    let pid_ok = std::env::var("LISTEN_PID")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .is_some_and(|pid| pid == std::process::id());
    let pidfdid = std::env::var("LISTEN_PIDFDID").ok();
    let pidfdid_ok = listen_pidfdid_ok(pidfdid.as_deref(), own_pidfdid());
    let count = std::env::var("LISTEN_FDS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let names = std::env::var("LISTEN_FDNAMES").unwrap_or_default();

    std::env::remove_var("LISTEN_PID");
    std::env::remove_var("LISTEN_PIDFDID");
    std::env::remove_var("LISTEN_FDS");
    std::env::remove_var("LISTEN_FDNAMES");

    if !pid_ok || !pidfdid_ok || count == 0 {
        return Vec::new();
    }

    let names: Vec<&str> = names.split(':').collect();
    let mut out = Vec::with_capacity(count);
    for idx in 0..count {
        let raw = LISTEN_FDS_START + idx as i32;
        let name = names.get(idx).copied().unwrap_or_default().to_string();
        // SAFETY: systemd's socket activation/fdstore protocol transfers
        // ownership of descriptors 3..3+LISTEN_FDS to this process when
        // LISTEN_PID matches our pid. When systemd supplies LISTEN_PIDFDID and
        // this kernel can expose a pidfs-backed pidfd inode, we verify that too.
        // We remove the env vars above so children cannot accidentally adopt
        // the same descriptors.
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };
        let _ = fcntl_getfd(&fd).and_then(|flags| fcntl_setfd(&fd, flags | FdFlags::CLOEXEC));
        out.push(NamedFd { name, fd });
    }
    out
}

pub fn notify_ready() -> Result<()> {
    notify("READY=1")
}

pub fn notify_watchdog() -> Result<()> {
    notify("WATCHDOG=1")
}

/// The ping cadence for the systemd watchdog: half of `WATCHDOG_USEC`
/// (systemd sets it only when the unit configures `WatchdogSec=`, and
/// expects pings well inside the window). None when the process is
/// not watchdog-supervised -- no pings, no ping task.
pub fn watchdog_interval() -> Option<Duration> {
    let raw = std::env::var("WATCHDOG_USEC").ok()?;
    let usec = raw.parse::<u64>().ok()?;
    if usec == 0 {
        return None;
    }
    Some(Duration::from_micros(usec) / 2)
}

pub fn notify_barrier(timeout: Duration) -> Result<()> {
    if notify_socket_addr()?.is_none() {
        return Ok(());
    }

    let (mut reader, writer) = UnixStream::pair()?;
    reader.set_read_timeout(Some(timeout))?;
    send_notify(Some(writer.as_fd()), "BARRIER=1")?;
    drop(writer);

    let mut buf = [0u8; 1];
    match reader.read(&mut buf) {
        Ok(0) => Ok(()),
        Ok(_) => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "systemd barrier fd became readable before close",
        )),
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ) =>
        {
            Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "timed out waiting for systemd notify barrier",
            ))
        }
        Err(e) => Err(e),
    }
}

pub fn fdstore(name: &str, fd: BorrowedFd<'_>) -> Result<()> {
    send_notify(
        Some(fd),
        &format!(
            "FDSTORE=1
FDNAME={name}
FDPOLL=0"
        ),
    )
}

pub fn fdstore_remove_many<'a>(names: impl IntoIterator<Item = &'a str>) {
    for name in names {
        let _ = fdstore_remove(name);
    }
}

pub fn pty_master_has_live_slave(fd: BorrowedFd<'_>) -> Result<bool> {
    let Some(tty_index) = pty_master_tty_index(fd)? else {
        return Ok(true);
    };
    let slave = PathBuf::from(format!("/dev/pts/{tty_index}"));
    for proc_entry in std::fs::read_dir("/proc")? {
        let Ok(proc_entry) = proc_entry else {
            continue;
        };
        let file_name = proc_entry.file_name();
        let Some(pid) = file_name.to_str() else {
            continue;
        };
        if !pid.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        let Ok(fds) = std::fs::read_dir(proc_entry.path().join("fd")) else {
            continue;
        };
        for fd in fds {
            let Ok(fd) = fd else {
                continue;
            };
            if std::fs::read_link(fd.path()).is_ok_and(|path| path == slave) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn fdstore_remove(name: &str) -> Result<()> {
    send_notify(
        None,
        &format!(
            "FDSTOREREMOVE=1
FDNAME={name}"
        ),
    )
}

fn notify(message: &str) -> Result<()> {
    send_notify(None, message)
}

fn send_notify(fd: Option<BorrowedFd<'_>>, message: &str) -> Result<()> {
    let Some(addr) = notify_socket_addr()? else {
        return Ok(());
    };
    let sock = UnixDatagram::unbound()?;
    sock.connect_addr(&addr)?;
    let iov = [IoSlice::new(message.as_bytes())];
    if let Some(fd) = fd {
        let fds = [fd];
        let mut space = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(1))];
        let mut ancillary = SendAncillaryBuffer::new(&mut space);
        if !ancillary.push(SendAncillaryMessage::ScmRights(&fds)) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "ancillary buffer too small for systemd notify message",
            ));
        }
        sendmsg(&sock, &iov, &mut ancillary, SendFlags::empty())?;
    } else {
        sock.send(message.as_bytes())?;
    }
    Ok(())
}

fn pty_master_tty_index(fd: BorrowedFd<'_>) -> Result<Option<u32>> {
    let fdinfo = std::fs::read_to_string(format!("/proc/self/fdinfo/{}", fd.as_raw_fd()))?;
    Ok(parse_pty_master_tty_index(&fdinfo))
}

fn parse_pty_master_tty_index(fdinfo: &str) -> Option<u32> {
    fdinfo.lines().find_map(|line| {
        let value = line.strip_prefix("tty-index:")?;
        value.trim().parse().ok()
    })
}

fn notify_socket_addr() -> Result<Option<SocketAddr>> {
    let Some(raw) = std::env::var_os("NOTIFY_SOCKET") else {
        return Ok(None);
    };
    if raw.is_empty() {
        return Ok(None);
    }
    let raw = raw.to_string_lossy();
    if let Some(name) = raw.strip_prefix('@') {
        return SocketAddr::from_abstract_name(name.as_bytes()).map(Some);
    }
    SocketAddr::from_pathname(raw.as_ref()).map(Some)
}

fn listen_pidfdid_ok(raw: Option<&str>, own: Option<u64>) -> bool {
    let Some(raw) = raw else {
        return true;
    };
    let Ok(expected) = raw.parse::<u64>() else {
        return false;
    };
    own.is_some_and(|actual| actual == expected)
}

fn own_pidfdid() -> Option<u64> {
    let raw_pid = i32::try_from(std::process::id()).ok()?;
    let pid = Pid::from_raw(raw_pid)?;
    let pidfd = pidfd_open(pid, PidfdFlags::empty()).ok()?;
    let statfs = fstatfs(&pidfd).ok()?;
    if statfs.f_type as u64 != PID_FS_MAGIC {
        return None;
    }
    let stat = fstat(&pidfd).ok()?;
    if std::mem::size_of_val(&stat.st_ino) < 8 {
        return None;
    }
    Some(stat.st_ino as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::ffi::{OsStr, OsString};
    use std::fs::{remove_file, File, OpenOptions};
    use std::io::{ErrorKind, IoSliceMut, Read, Write};
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::Mutex;
    use std::thread;
    use std::time::{Instant, SystemTime, UNIX_EPOCH};

    use rustix::fs::{fcntl_getfl, fcntl_setfl, OFlags};
    use rustix::net::{recvmsg, RecvAncillaryBuffer, RecvAncillaryMessage, RecvFlags};
    use rustix::pty::{grantpt, openpt, ptsname, unlockpt, OpenptFlags};
    use rustix::termios::{tcgetattr, tcsetattr, OptionalActions};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvGuard {
        key: &'static str,
        old: Option<OsString>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: impl AsRef<OsStr>) -> Self {
            let old = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, old }
        }

        fn remove(key: &'static str) -> Self {
            let old = std::env::var_os(key);
            std::env::remove_var(key);
            Self { key, old }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.old {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    struct SocketPathGuard(PathBuf);

    impl Drop for SocketPathGuard {
        fn drop(&mut self) {
            let _ = remove_file(&self.0);
        }
    }

    #[test]
    fn fdstore_remove_is_noop_without_notify_socket() {
        let _env_lock = ENV_LOCK.lock().unwrap();
        let _notify_socket = EnvGuard::remove("NOTIFY_SOCKET");
        fdstore_remove("chan.test").unwrap();
    }

    #[test]
    fn notify_barrier_is_noop_without_notify_socket() {
        let _env_lock = ENV_LOCK.lock().unwrap();
        let _notify_socket = EnvGuard::remove("NOTIFY_SOCKET");
        notify_barrier(Duration::from_millis(1)).unwrap();
    }

    #[test]
    fn watchdog_interval_reads_half_of_watchdog_usec() {
        let _env_lock = ENV_LOCK.lock().unwrap();
        {
            let _guard = EnvGuard::set("WATCHDOG_USEC", "30000000");
            assert_eq!(watchdog_interval(), Some(Duration::from_secs(15)));
        }
        {
            let _guard = EnvGuard::set("WATCHDOG_USEC", "0");
            assert_eq!(watchdog_interval(), None, "zero means no watchdog");
        }
        {
            let _guard = EnvGuard::set("WATCHDOG_USEC", "nope");
            assert_eq!(watchdog_interval(), None, "garbage means no watchdog");
        }
        {
            let _guard = EnvGuard::remove("WATCHDOG_USEC");
            assert_eq!(watchdog_interval(), None, "unset means no watchdog");
        }
    }

    #[test]
    fn listen_pidfdid_is_checked_when_available() {
        assert!(listen_pidfdid_ok(None, Some(42)));
        assert!(listen_pidfdid_ok(Some("42"), Some(42)));
        assert!(!listen_pidfdid_ok(Some("43"), Some(42)));
        assert!(!listen_pidfdid_ok(Some("nope"), Some(42)));
    }

    #[test]
    fn listen_pidfdid_is_rejected_when_kernel_cannot_report_own_id() {
        assert!(!listen_pidfdid_ok(Some("42"), None));
    }

    #[test]
    fn take_listen_fds_clears_systemd_activation_env_on_pid_mismatch() {
        let _env_lock = ENV_LOCK.lock().unwrap();
        let _listen_pid = EnvGuard::set("LISTEN_PID", "0");
        let _listen_pidfdid = EnvGuard::set("LISTEN_PIDFDID", "123");
        let _listen_fds = EnvGuard::set("LISTEN_FDS", "1");
        let _listen_fdnames = EnvGuard::set("LISTEN_FDNAMES", "chan.pty.test");

        assert!(take_listen_fds().is_empty());
        assert!(std::env::var_os("LISTEN_PID").is_none());
        assert!(std::env::var_os("LISTEN_PIDFDID").is_none());
        assert!(std::env::var_os("LISTEN_FDS").is_none());
        assert!(std::env::var_os("LISTEN_FDNAMES").is_none());
    }

    #[test]
    fn systemd_fdstore_e2e() {
        let _env_lock = ENV_LOCK.lock().unwrap();
        if std::env::var_os("CHAN_SYSTEMD_FDSTORE_E2E").is_none() {
            eprintln!("skipping systemd fdstore e2e; set CHAN_SYSTEMD_FDSTORE_E2E=1");
            return;
        }
        if !command_status(Command::new("systemctl").args(["--user", "show-environment"])) {
            panic!("CHAN_SYSTEMD_FDSTORE_E2E=1 but systemctl --user is unavailable");
        }
        if !command_status(Command::new("systemd-run").arg("--version")) {
            panic!("CHAN_SYSTEMD_FDSTORE_E2E=1 but systemd-run is unavailable");
        }

        let unique = format!("{}-{}", std::process::id(), timestamp_nanos());
        let unit = format!("chan-systemd-fdstore-e2e-{unique}.service");
        let helper_unit = format!("chan-systemd-fdstore-e2e-helper-{unique}.service");
        let state = std::env::temp_dir().join(format!("chan-systemd-fdstore-e2e-{unique}.state"));
        let _state_guard = SocketPathGuard(state.clone());
        std::fs::write(&state, "store\n").unwrap();
        let cleanup = SystemdE2eCleanup {
            main_unit: unit.clone(),
            helper_unit: helper_unit.clone(),
            state: state.clone(),
        };

        let exe = std::env::current_exe().unwrap();
        let output = Command::new("systemd-run")
            .arg("--user")
            .arg("--unit")
            .arg(&unit)
            .arg("--property=Type=notify")
            .arg("--property=NotifyAccess=main")
            .arg("--property=FileDescriptorStoreMax=4")
            .arg("--property=KillMode=process")
            .arg("--property=RemainAfterExit=yes")
            .arg(format!(
                "--setenv=CHAN_SYSTEMD_FDSTORE_E2E_STATE={}",
                state.display()
            ))
            .arg(format!(
                "--setenv=CHAN_SYSTEMD_FDSTORE_E2E_HELPER={helper_unit}"
            ))
            .arg("--setenv=CHAN_SYSTEMD_FDSTORE_E2E_CHILD=1")
            .arg(exe.as_os_str())
            .arg("linux::tests::systemd_fdstore_e2e_child")
            .arg("--exact")
            .arg("--nocapture")
            .output()
            .unwrap();
        if !output.status.success() {
            panic_systemd_e2e(
                &cleanup,
                format!(
                    "systemd-run failed\nstdout:\n{}\nstderr:\n{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                ),
            );
        }
        if let Err(err) = wait_for_state(&state, "restore") {
            panic_systemd_e2e(&cleanup, err);
        }

        let output = Command::new("systemctl")
            .args(["--user", "restart", &unit])
            .output()
            .unwrap();
        if !output.status.success() {
            panic_systemd_e2e(
                &cleanup,
                format!(
                    "systemctl restart failed\nstdout:\n{}\nstderr:\n{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr),
                ),
            );
        }
        if let Err(err) = wait_for_state(&state, "done") {
            panic_systemd_e2e(&cleanup, err);
        }
    }

    #[test]
    fn systemd_fdstore_e2e_child() {
        if std::env::var_os("CHAN_SYSTEMD_FDSTORE_E2E_CHILD").is_none() {
            return;
        }
        let state = PathBuf::from(std::env::var_os("CHAN_SYSTEMD_FDSTORE_E2E_STATE").unwrap());
        match read_state_phase(&state).as_str() {
            "store" => systemd_fdstore_e2e_store(&state),
            "restore" => systemd_fdstore_e2e_restore(&state),
            phase => panic!("unexpected e2e phase {phase:?}"),
        }
    }

    #[test]
    fn fdstore_preserves_pty_master_io_across_transfer() {
        let _env_lock = ENV_LOCK.lock().unwrap();
        let socket_path = temp_notify_socket_path();
        let _socket_path = SocketPathGuard(socket_path.clone());
        let notify = UnixDatagram::bind(&socket_path).unwrap();
        notify
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let _notify_socket = EnvGuard::set("NOTIFY_SOCKET", socket_path.as_os_str());

        let (mut master, mut slave) = open_test_pty();

        set_raw(&slave);
        set_nonblocking(&master);
        set_nonblocking(&slave);

        assert!(pty_master_has_live_slave(master.as_fd()).unwrap());
        assert_pty_roundtrip(&mut master, &mut slave, b"before-store");

        fdstore("chan.pty.test", master.as_fd()).unwrap();
        let (message, stored_master) = recv_fdstore_message(&notify);
        assert!(message.contains("FDSTORE=1"), "message: {message:?}");
        assert!(
            message.contains("FDNAME=chan.pty.test"),
            "message: {message:?}"
        );
        assert!(message.contains("FDPOLL=0"), "message: {message:?}");

        drop(master);

        let mut restored_master = File::from(stored_master);
        set_nonblocking(&restored_master);
        assert!(pty_master_has_live_slave(restored_master.as_fd()).unwrap());
        assert_pty_roundtrip(&mut restored_master, &mut slave, b"after-store");

        drop(slave);
        assert!(!pty_master_has_live_slave(restored_master.as_fd()).unwrap());
    }

    #[test]
    fn pty_master_tty_index_parser_accepts_fdinfo_spacing() {
        assert_eq!(
            parse_pty_master_tty_index("pos:\t0\nflags:\t02400002\ntty-index:\t3\n"),
            Some(3)
        );
        assert_eq!(
            parse_pty_master_tty_index("pos:\t0\ntty-index: 12\n"),
            Some(12)
        );
        assert_eq!(parse_pty_master_tty_index("pos:\t0\n"), None);
    }

    fn systemd_fdstore_e2e_store(state: &Path) {
        let helper_unit = std::env::var("CHAN_SYSTEMD_FDSTORE_E2E_HELPER").unwrap();
        let (mut master, slave, slave_path) = open_test_pty_with_slave_path();

        set_raw(&slave);
        set_nonblocking(&master);

        start_systemd_cat_helper(&helper_unit, &slave_path);
        drop(slave);

        wait_for_live_pty_slave(master.as_fd(), "systemd helper");
        assert_cat_echo(&mut master, b"real-systemd-before-store");

        fdstore("chan.pty.e2e", master.as_fd()).unwrap();
        notify_barrier(Duration::from_secs(5)).unwrap();
        write_e2e_state(state, "restore", &helper_unit);
        notify_ready().unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            thread::sleep(Duration::from_millis(100));
        }
        panic!("timed out waiting for systemd to restart e2e unit");
    }

    fn systemd_fdstore_e2e_restore(state: &Path) {
        let helper_unit = read_state_helper_unit(state).expect("helper_unit in e2e state");
        let mut named = take_listen_fds();
        let idx = named
            .iter()
            .position(|fd| fd.name == "chan.pty.e2e")
            .unwrap_or_else(|| panic!("chan.pty.e2e missing from LISTEN_FDS: {named:?}"));
        let mut master = File::from(named.remove(idx).fd);
        set_nonblocking(&master);

        assert!(pty_master_has_live_slave(master.as_fd()).unwrap());
        assert_cat_echo(&mut master, b"real-systemd-after-store");

        stop_systemd_unit(&helper_unit).unwrap_or_else(|err| panic!("{err}"));
        write_e2e_state(state, "done", &helper_unit);
        notify_ready().unwrap();
    }

    fn temp_notify_socket_path() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "chan-systemd-test-{}-{nanos}.sock",
            std::process::id()
        ))
    }

    fn open_test_pty() -> (File, File) {
        let (master, slave, _) = open_test_pty_with_slave_path();
        (master, slave)
    }

    fn open_test_pty_with_slave_path() -> (File, File, PathBuf) {
        let master_fd =
            openpt(OpenptFlags::RDWR | OpenptFlags::NOCTTY | OpenptFlags::CLOEXEC).unwrap();
        grantpt(&master_fd).unwrap();
        unlockpt(&master_fd).unwrap();
        let slave_path = PathBuf::from(
            ptsname(&master_fd, Vec::new())
                .unwrap()
                .into_string()
                .unwrap(),
        );
        let slave = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&slave_path)
            .unwrap();
        (File::from(master_fd), slave, slave_path)
    }

    fn set_raw(file: &File) {
        let mut termios = tcgetattr(file).unwrap();
        termios.make_raw();
        tcsetattr(file, OptionalActions::Now, &termios).unwrap();
    }

    fn set_nonblocking(file: &File) {
        let flags = fcntl_getfl(file).unwrap();
        fcntl_setfl(file, flags | OFlags::NONBLOCK).unwrap();
    }

    fn recv_fdstore_message(sock: &UnixDatagram) -> (String, OwnedFd) {
        let mut bytes = [0u8; 512];
        let mut control_space = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(1))];
        let mut received_fds = Vec::new();
        let received_bytes = {
            let mut iov = [IoSliceMut::new(&mut bytes)];
            let mut control = RecvAncillaryBuffer::new(&mut control_space);
            let msg = recvmsg(sock, &mut iov, &mut control, RecvFlags::empty()).unwrap();
            for ancillary in control.drain() {
                if let RecvAncillaryMessage::ScmRights(fds) = ancillary {
                    received_fds.extend(fds);
                }
            }
            msg.bytes
        };
        assert_eq!(received_fds.len(), 1);
        (
            String::from_utf8_lossy(&bytes[..received_bytes]).into_owned(),
            received_fds.remove(0),
        )
    }

    fn assert_cat_echo(master: &mut File, bytes: &[u8]) {
        write_all_eventually(master, bytes);
        read_exact_eventually(master, bytes);
    }

    fn assert_pty_roundtrip(master: &mut File, slave: &mut File, label: &[u8]) {
        let to_slave = [label, b":master-to-slave"].concat();
        write_all_eventually(master, &to_slave);
        read_exact_eventually(slave, &to_slave);

        let to_master = [label, b":slave-to-master"].concat();
        write_all_eventually(slave, &to_master);
        read_exact_eventually(master, &to_master);
    }

    fn write_all_eventually(file: &mut File, mut bytes: &[u8]) {
        let deadline = Instant::now() + Duration::from_secs(1);
        while !bytes.is_empty() {
            match file.write(bytes) {
                Ok(0) => panic!("PTY write returned EOF"),
                Ok(n) => bytes = &bytes[n..],
                Err(e) if transient_io(&e) => wait_for_io(deadline, "write"),
                Err(e) => panic!("PTY write failed: {e}"),
            }
        }
    }

    fn read_exact_eventually(file: &mut File, expected: &[u8]) {
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut got = Vec::with_capacity(expected.len());
        let mut buf = [0u8; 64];
        while got.len() < expected.len() {
            match file.read(&mut buf) {
                Ok(0) => wait_for_io(deadline, "read"),
                Ok(n) => got.extend_from_slice(&buf[..n]),
                Err(e) if transient_io(&e) => wait_for_io(deadline, "read"),
                Err(e) => panic!("PTY read failed: {e}"),
            }
        }
        assert_eq!(got, expected);
    }

    fn transient_io(e: &std::io::Error) -> bool {
        matches!(
            e.kind(),
            ErrorKind::WouldBlock | ErrorKind::Interrupted | ErrorKind::TimedOut
        )
    }

    fn wait_for_io(deadline: Instant, op: &str) {
        assert!(Instant::now() < deadline, "timed out waiting for PTY {op}");
        thread::sleep(Duration::from_millis(10));
    }

    fn command_status(command: &mut Command) -> bool {
        command
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    fn timestamp_nanos() -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    }

    fn read_state_phase(state: &Path) -> String {
        std::fs::read_to_string(state)
            .unwrap_or_default()
            .lines()
            .next()
            .unwrap_or_default()
            .to_string()
    }

    fn read_state_helper_unit(state: &Path) -> Option<String> {
        std::fs::read_to_string(state)
            .ok()?
            .lines()
            .find_map(|line| line.strip_prefix("helper_unit="))
            .filter(|unit| !unit.is_empty())
            .map(ToOwned::to_owned)
    }

    fn write_e2e_state(state: &Path, phase: &str, helper_unit: &str) {
        std::fs::write(state, format!("{phase}\nhelper_unit={helper_unit}\n")).unwrap();
    }

    fn wait_for_state(state: &Path, expected: &str) -> std::result::Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if read_state_phase(state) == expected {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "timed out waiting for e2e state {expected:?}; current state:\n{}",
                    std::fs::read_to_string(state).unwrap_or_default()
                ));
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    fn wait_for_live_pty_slave(fd: BorrowedFd<'_>, label: &str) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match pty_master_has_live_slave(fd) {
                Ok(true) => return,
                Ok(false) => {}
                Err(e) => panic!("failed to inspect PTY slave for {label}: {e}"),
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for PTY slave owned by {label}"
            );
            thread::sleep(Duration::from_millis(50));
        }
    }

    fn start_systemd_cat_helper(unit: &str, slave_path: &Path) {
        let output = Command::new("systemd-run")
            .arg("--user")
            .arg("--unit")
            .arg(unit)
            .arg("--property=Type=simple")
            .arg("--property=KillMode=process")
            .arg(format!(
                "--property=StandardInput=file:{}",
                slave_path.display()
            ))
            .arg(format!(
                "--property=StandardOutput=file:{}",
                slave_path.display()
            ))
            .arg("--property=StandardError=null")
            .arg("cat")
            .output()
            .unwrap();
        if !output.status.success() {
            panic!(
                "systemd-run helper failed\nunit: {unit}\nslave: {}\nstdout:\n{}\nstderr:\n{}",
                slave_path.display(),
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    fn stop_systemd_unit(unit: &str) -> std::result::Result<(), String> {
        let output = Command::new("systemctl")
            .args(["--user", "stop", unit])
            .output()
            .map_err(|e| format!("systemctl stop {unit} failed: {e}"))?;
        if output.status.success() {
            return Ok(());
        }
        Err(format!(
            "systemctl stop {unit} failed\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ))
    }

    struct SystemdE2eCleanup {
        main_unit: String,
        helper_unit: String,
        state: PathBuf,
    }

    impl Drop for SystemdE2eCleanup {
        fn drop(&mut self) {
            cleanup_systemd_e2e_units(&self.main_unit, &self.helper_unit, &self.state);
        }
    }

    fn panic_systemd_e2e(cleanup: &SystemdE2eCleanup, message: impl AsRef<str>) -> ! {
        let state = std::fs::read_to_string(&cleanup.state).unwrap_or_default();
        let helper_unit =
            read_state_helper_unit(&cleanup.state).unwrap_or_else(|| cleanup.helper_unit.clone());
        let main_journal = unit_journal(&cleanup.main_unit);
        let helper_journal = unit_journal(&helper_unit);
        panic!(
            "{}\nstate:\n{}\nmain journal ({}):\n{}\nhelper journal ({}):\n{}",
            message.as_ref(),
            state,
            cleanup.main_unit,
            main_journal,
            helper_unit,
            helper_journal
        );
    }

    fn cleanup_systemd_e2e_units(main_unit: &str, helper_unit: &str, state: &Path) {
        let state_helper = read_state_helper_unit(state);
        if let Some(helper) = state_helper.as_deref() {
            cleanup_systemd_stop(helper);
        }
        if state_helper.as_deref() != Some(helper_unit) {
            cleanup_systemd_stop(helper_unit);
        }
        cleanup_systemd_stop(main_unit);
        cleanup_systemd_clean_fdstore(main_unit);
        if let Some(helper) = state_helper.as_deref() {
            cleanup_systemd_reset_failed(helper);
        }
        if state_helper.as_deref() != Some(helper_unit) {
            cleanup_systemd_reset_failed(helper_unit);
        }
        cleanup_systemd_reset_failed(main_unit);
    }

    fn cleanup_systemd_stop(unit: &str) {
        let _ = Command::new("systemctl")
            .args(["--user", "stop", unit])
            .status();
    }

    fn cleanup_systemd_clean_fdstore(unit: &str) {
        let _ = Command::new("systemctl")
            .args(["--user", "clean", "--what=fdstore", unit])
            .status();
    }

    fn cleanup_systemd_reset_failed(unit: &str) {
        let _ = Command::new("systemctl")
            .args(["--user", "reset-failed", unit])
            .status();
    }

    fn unit_journal(unit: &str) -> String {
        Command::new("journalctl")
            .args(["--user", "-u", unit, "-n", "80", "--no-pager"])
            .output()
            .ok()
            .map(|output| {
                let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
                text.push_str(&String::from_utf8_lossy(&output.stderr));
                text
            })
            .unwrap_or_default()
    }
}
