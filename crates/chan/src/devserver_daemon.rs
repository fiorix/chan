//! The `--service=chan` self-managed daemon: a cross-OS background devserver
//! guarded by a single-instance pidfile + flock ([`chan_workspace::daemon_lock`]).
//! It is the portable service backend where there is no OS supervisor, and the
//! explicit portable choice everywhere.

use std::fs::{File, OpenOptions};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};

use chan_workspace::daemon_lock::{
    daemon_lock_held, is_record_live, read_daemon_record, signal_terminate, DaemonAcquire,
    DaemonLock, DaemonRecord,
};

const START_TIMEOUT: Duration = Duration::from_secs(15);
const STOP_TIMEOUT: Duration = Duration::from_secs(15);

/// `~/.chan/devserver/daemon.lock`, routed through `CHAN_HOME`.
fn daemon_lock_path() -> PathBuf {
    chan_workspace::paths::config_dir()
        .join("devserver")
        .join("daemon.lock")
}

/// `~/.chan/devserver/daemon.json`, routed through `CHAN_HOME`.
fn daemon_record_path() -> PathBuf {
    chan_workspace::paths::config_dir()
        .join("devserver")
        .join("daemon.json")
}

/// `chan devserver start --service=chan`: start the background daemon and return.
/// Idempotent when the same daemon is already running on the requested address.
pub async fn run_devserver_as_chan(
    addr: SocketAddr,
    force: bool,
    verbose: bool,
    tunnel: Option<chan_server::DevserverTunnel>,
) -> Result<()> {
    start_devserver_chan(addr, force, verbose, tunnel)
        .await
        .map(|_| ())
}

/// `--service=chan --start`: start the background daemon and return.
pub async fn start_devserver_chan(
    addr: SocketAddr,
    force: bool,
    verbose: bool,
    tunnel: Option<chan_server::DevserverTunnel>,
) -> Result<DaemonRecord> {
    let lock_path = daemon_lock_path();
    let record_path = daemon_record_path();
    let log_path = crate::devserver_log_path()?;
    if verbose {
        print_daemon_paths(&lock_path, &record_path, &log_path);
    }

    if force {
        stop_live_daemon(&lock_path, &record_path, STOP_TIMEOUT)?;
    }

    if daemon_lock_held(&lock_path) {
        if let Some(record) =
            wait_for_live_record(&lock_path, &record_path, Duration::from_secs(2)).await
        {
            return attach_existing(record, addr, &log_path).await;
        }
        anyhow::bail!(
            "chan devserver: a self-managed daemon is starting but has not written \
             its pidfile yet. Retry shortly, or use --force if it is wedged."
        );
    }

    clear_stale_record(&lock_path, &record_path);
    let mut child = spawn_daemon_child(addr, tunnel, &log_path)?;
    let record =
        wait_for_spawned_daemon(&mut child, addr, &lock_path, &record_path, &log_path).await?;
    crate::emit_devserver_token_marker(crate::DEVSERVER_TOKEN_WAIT).await?;
    eprintln!(
        "chan devserver: started the self-managed daemon (pid {}) on {}.",
        record.pid, record.addr
    );
    Ok(record)
}

/// `--restart`: stop any running daemon, then start a new background daemon.
pub async fn restart_devserver_chan(
    addr: SocketAddr,
    force: bool,
    verbose: bool,
    tunnel: Option<chan_server::DevserverTunnel>,
) -> Result<()> {
    let lock_path = daemon_lock_path();
    let record_path = daemon_record_path();
    if verbose {
        let log_path = crate::devserver_log_path()?;
        print_daemon_paths(&lock_path, &record_path, &log_path);
    }
    stop_live_daemon(&lock_path, &record_path, STOP_TIMEOUT)?;
    let record = start_devserver_chan(addr, force, false, tunnel).await?;
    eprintln!(
        "chan devserver: restarted the self-managed daemon (pid {}) on {}.",
        record.pid, record.addr
    );
    Ok(())
}

/// `--service=chan --join`: start the background daemon if needed, then attach
/// as a watchdog until interrupted. Ctrl-C detaches and leaves the daemon alive.
pub async fn join_devserver_chan(
    addr: SocketAddr,
    force: bool,
    verbose: bool,
    tunnel: Option<chan_server::DevserverTunnel>,
) -> Result<()> {
    let record = start_devserver_chan(addr, force, verbose, tunnel).await?;
    watchdog(record).await
}

/// Hidden child command. This process owns the daemon lock and foreground
/// devserver; its parent owns detaching, log redirection, and readiness waits.
pub async fn run_devserver_daemon_child(
    addr: SocketAddr,
    tunnel: Option<chan_server::DevserverTunnel>,
) -> Result<()> {
    let lock_path = daemon_lock_path();
    let record_path = daemon_record_path();
    match DaemonLock::acquire(&lock_path, &record_path, &addr.to_string(), false)
        .map_err(|e| anyhow::anyhow!("acquiring the devserver daemon lock: {e}"))?
    {
        DaemonAcquire::Daemon(guard) => serve_as_daemon(guard, addr, tunnel).await,
        DaemonAcquire::Running(record) => anyhow::bail!(
            "chan devserver: a self-managed daemon is already running on {} (pid {}).",
            record.addr,
            record.pid
        ),
    }
}

/// `--stop`: terminate the running daemon and clear stale pidfiles.
pub async fn stop_devserver_chan(verbose: bool) -> Result<()> {
    let lock_path = daemon_lock_path();
    let record_path = daemon_record_path();
    if verbose {
        let log_path = crate::devserver_log_path()?;
        print_daemon_paths(&lock_path, &record_path, &log_path);
    }

    match read_daemon_record(&record_path) {
        None => {
            eprintln!("chan devserver: no self-managed daemon is running.");
            Ok(())
        }
        Some(record) if live_record(&lock_path, &record) => {
            signal_terminate(record.pid);
            if wait_for_record_gone(&lock_path, &record_path, STOP_TIMEOUT) {
                let _ = std::fs::remove_file(&record_path);
                eprintln!(
                    "chan devserver: stopped the self-managed daemon (pid {}).",
                    record.pid
                );
                Ok(())
            } else {
                anyhow::bail!(
                    "chan devserver: the self-managed daemon (pid {}) did not stop within 15s.",
                    record.pid
                )
            }
        }
        Some(record) => {
            let _ = std::fs::remove_file(&record_path);
            eprintln!(
                "chan devserver: no self-managed daemon is running (cleared a stale pidfile for pid {}).",
                record.pid
            );
            Ok(())
        }
    }
}

/// `--status`: report whether the background daemon is running.
pub fn status_devserver_chan(verbose: bool) -> Result<()> {
    let lock_path = daemon_lock_path();
    let record_path = daemon_record_path();
    let log_path = crate::devserver_log_path()?;
    if verbose {
        print_daemon_paths(&lock_path, &record_path, &log_path);
    }
    match read_daemon_record(&record_path) {
        Some(r) if live_record(&lock_path, &r) => {
            println!(
                "chan devserver (chan): running -- pid {}, bind {}, since {}",
                r.pid, r.addr, r.started_at
            );
            if let Ok(addr) = r.addr.parse::<SocketAddr>() {
                println!(
                    "  command: chan devserver start --service=chan --bind={} --port={}",
                    addr.ip(),
                    addr.port()
                );
            }
            println!("  log: {}", log_path.display());
        }
        Some(r) => {
            let _ = std::fs::remove_file(&record_path);
            println!(
                "chan devserver (chan): not running (cleared a stale pidfile for pid {}).",
                r.pid
            );
        }
        None => println!("chan devserver (chan): not running."),
    }
    Ok(())
}

/// The pid of a live self-managed devserver daemon under this `CHAN_HOME`,
/// or `None`. A stale record (dead pid or a released lock) counts as not
/// running and is left for `stop`/`status` to clear. The desktop asks this
/// before a Windows self-update: the daemon runs from the install's own
/// `chan.exe`, which the installer cannot overwrite while it is mapped.
pub fn self_managed_devserver_pid() -> Option<u32> {
    let record = read_daemon_record(&daemon_record_path())?;
    live_record(&daemon_lock_path(), &record).then_some(record.pid)
}

/// The address the running (or last crashed) self-managed daemon recorded.
pub fn persisted_devserver_addr_chan() -> Option<SocketAddr> {
    read_daemon_record(&daemon_record_path())?.addr.parse().ok()
}

async fn attach_existing(
    record: DaemonRecord,
    requested: SocketAddr,
    log_path: &Path,
) -> Result<DaemonRecord> {
    if record.addr != requested.to_string() {
        anyhow::bail!(
            "chan devserver: a self-managed daemon is already running on {} \
             (pid {}); requested {requested}. Use --restart to rebind, --stop \
             to stop it, or --force to replace it.",
            record.addr,
            record.pid
        );
    }
    wait_for_daemon_ready(
        requested,
        &daemon_lock_path(),
        &daemon_record_path(),
        log_path,
        Duration::from_secs(5),
    )
    .await?;
    crate::emit_devserver_token_marker(crate::DEVSERVER_TOKEN_WAIT).await?;
    eprintln!(
        "chan devserver: the self-managed daemon is already running (pid {}) on {}.",
        record.pid, record.addr
    );
    Ok(record)
}

async fn serve_as_daemon(
    guard: DaemonLock,
    addr: SocketAddr,
    tunnel: Option<chan_server::DevserverTunnel>,
) -> Result<()> {
    eprintln!("chan devserver: self-managed daemon running in the background (bind={addr}).");
    let result = crate::run_devserver_foreground(addr, tunnel, true).await;
    drop(guard);
    result
}

fn spawn_daemon_child(
    addr: SocketAddr,
    tunnel: Option<chan_server::DevserverTunnel>,
    log_path: &Path,
) -> Result<Child> {
    let exe = crate::resolve_relaunchable_exe()?;
    let (stdout, stderr) = open_daemon_log(log_path)?;
    let mut cmd = Command::new(&exe);
    cmd.arg("__devserver-daemon")
        .arg(format!("--bind={}", addr.ip()))
        .arg(format!("--port={}", addr.port()))
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    match tunnel {
        Some(tunnel) => {
            cmd.arg(format!("--tunnel-url={}", tunnel.tunnel_url));
            // The resolved display name is not a secret; it rides argv
            // (no shell in between, so spaces survive). Only the token
            // stays env-only.
            cmd.arg(format!("--tunnel-devserver-name={}", tunnel.name));
            cmd.env("CHAN_TUNNEL_TOKEN", tunnel.token);
        }
        None => {
            cmd.env_remove("CHAN_TUNNEL_TOKEN");
        }
    }
    detach_command(&mut cmd);
    cmd.spawn()
        .with_context(|| format!("spawning `{}` __devserver-daemon", exe.display()))
}

fn open_daemon_log(log_path: &Path) -> Result<(File, File)> {
    if let Some(parent) = log_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .with_context(|| format!("opening {}", log_path.display()))?;
    let stderr = stdout
        .try_clone()
        .with_context(|| format!("cloning {}", log_path.display()))?;
    Ok((stdout, stderr))
}

#[cfg(unix)]
fn detach_command(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;

    // SAFETY: this runs in the child after fork and before exec. setsid is a
    // single syscall that detaches the daemon from the launching terminal.
    unsafe {
        cmd.pre_exec(|| {
            rustix::process::setsid()
                .map(|_| ())
                .map_err(|e| std::io::Error::from_raw_os_error(e.raw_os_error()))
        });
    }
}

#[cfg(windows)]
fn detach_command(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;

    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
}

#[cfg(not(any(unix, windows)))]
fn detach_command(_cmd: &mut Command) {}

async fn wait_for_spawned_daemon(
    child: &mut Child,
    addr: SocketAddr,
    lock_path: &Path,
    record_path: &Path,
    log_path: &Path,
) -> Result<DaemonRecord> {
    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        if let Some(status) = child.try_wait().context("checking daemon child status")? {
            anyhow::bail!(
                "chan devserver: daemon child exited before readiness ({status}).\n{}",
                recent_log_tail(log_path)
            );
        }
        if let Some(record) = ready_record(addr, lock_path, record_path).await? {
            return Ok(record);
        }
        if Instant::now() >= deadline {
            anyhow::bail!(
                "chan devserver: daemon did not become ready within 15s.\n{}",
                recent_log_tail(log_path)
            );
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn wait_for_daemon_ready(
    addr: SocketAddr,
    lock_path: &Path,
    record_path: &Path,
    log_path: &Path,
    timeout: Duration,
) -> Result<DaemonRecord> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(record) = ready_record(addr, lock_path, record_path).await? {
            return Ok(record);
        }
        if Instant::now() >= deadline {
            anyhow::bail!(
                "chan devserver: daemon pidfile exists but health did not become ready.\n{}",
                recent_log_tail(log_path)
            );
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn ready_record(
    addr: SocketAddr,
    lock_path: &Path,
    record_path: &Path,
) -> Result<Option<DaemonRecord>> {
    let Some(record) = live_daemon_record(lock_path, record_path) else {
        return Ok(None);
    };
    if record.addr != addr.to_string() {
        anyhow::bail!(
            "chan devserver: daemon pidfile reports {}, expected {addr}.",
            record.addr
        );
    }
    let client = reqwest::Client::new();
    let url = format!("http://{addr}/api/health");
    // Startup polls loop at 100ms under their own deadline; the short cap
    // keeps one hung probe from eating the whole readiness budget.
    if crate::health_ok(&client, &url, Duration::from_secs(2)).await {
        Ok(Some(record))
    } else {
        Ok(None)
    }
}

async fn wait_for_live_record(
    lock_path: &Path,
    record_path: &Path,
    timeout: Duration,
) -> Option<DaemonRecord> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(record) = live_daemon_record(lock_path, record_path) {
            return Some(record);
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn live_daemon_record(lock_path: &Path, record_path: &Path) -> Option<DaemonRecord> {
    let record = read_daemon_record(record_path)?;
    live_record(lock_path, &record).then_some(record)
}

fn live_record(lock_path: &Path, record: &DaemonRecord) -> bool {
    daemon_lock_held(lock_path) && is_record_live(record)
}

fn clear_stale_record(lock_path: &Path, record_path: &Path) {
    if let Some(record) = read_daemon_record(record_path) {
        if !live_record(lock_path, &record) {
            let _ = std::fs::remove_file(record_path);
        }
    }
}

fn stop_live_daemon(lock_path: &Path, record_path: &Path, timeout: Duration) -> Result<()> {
    let Some(record) = read_daemon_record(record_path) else {
        return Ok(());
    };
    if !live_record(lock_path, &record) {
        let _ = std::fs::remove_file(record_path);
        return Ok(());
    }
    eprintln!(
        "chan devserver: stopping the running daemon (pid {}).",
        record.pid
    );
    signal_terminate(record.pid);
    if wait_for_record_gone(lock_path, record_path, timeout) {
        let _ = std::fs::remove_file(record_path);
        Ok(())
    } else {
        anyhow::bail!(
            "chan devserver: the self-managed daemon (pid {}) did not stop within 15s.",
            record.pid
        )
    }
}

fn wait_for_record_gone(lock_path: &Path, record_path: &Path, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match read_daemon_record(record_path) {
            None => return true,
            Some(r) if !live_record(lock_path, &r) => return true,
            Some(_) => {}
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

async fn watchdog(record: DaemonRecord) -> Result<()> {
    eprintln!(
        "chan devserver: attached to the running self-managed daemon (pid {}) on {}; \
         Ctrl-C to detach.",
        record.pid, record.addr
    );
    // The subject deliberately omits the pid: the watchdog re-pins to a
    // restarted daemon's pid, so a pid baked in here would go stale.
    crate::run_health_watchdog(
        &record.addr,
        crate::DaemonLiveness::Chan {
            record_path: daemon_record_path(),
            pid: record.pid,
        },
        "self-managed daemon",
    )
    .await
}

fn recent_log_tail(path: &Path) -> String {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            let mut tail: Vec<&str> = text.lines().rev().take(30).collect();
            tail.reverse();
            tail.join("\n")
        }
        Err(e) => format!("(could not read {}: {e})", path.display()),
    }
}

/// `-v`: print the daemon subsystem and the files it touches.
fn print_daemon_paths(lock_path: &Path, record_path: &Path, log_path: &Path) {
    eprintln!("chan devserver: subsystem=chan (self-managed background daemon)");
    eprintln!("  pidfile: {}", record_path.display());
    eprintln!("  lock:    {}", lock_path.display());
    eprintln!("  log:     {}", log_path.display());
    eprintln!(
        "  config:  {}",
        chan_workspace::paths::config_dir()
            .join("devserver")
            .join("config.json")
            .display()
    );
}
