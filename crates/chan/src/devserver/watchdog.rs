use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::Result;

use crate::devserver::management::health_ok;
use crate::devserver::supervisor::{launchd_is_active, unit_is_active};

/// What a `--service` watchdog polls to decide the backing server is still up.
/// One probe per backend, so [`run_health_watchdog`] is shared by the
/// self-managed `chan` daemon, systemd, and launchd.
pub(crate) enum DaemonLiveness {
    /// The self-managed `chan` daemon: its pidfile still names this live pid.
    /// The pid re-pins when a `restart` replaces the daemon (see
    /// [`DaemonLiveness::adopt_restarted`]).
    Chan { record_path: PathBuf, pid: u32 },
    /// A systemd user service: `systemctl --user is-active`.
    Systemd,
    /// A launchd LaunchAgent: `launchctl print` reports running.
    Launchd { uid: u32 },
}

impl DaemonLiveness {
    async fn alive(&self) -> bool {
        match self {
            DaemonLiveness::Chan { record_path, pid } => matches!(
                chan_workspace::daemon_lock::read_daemon_record(record_path),
                Some(r) if r.pid == *pid && chan_workspace::daemon_lock::is_record_live(&r)
            ),
            DaemonLiveness::Systemd => unit_is_active().await,
            DaemonLiveness::Launchd { uid } => launchd_is_active(*uid).await,
        }
    }

    /// chan backend only: after [`DaemonLiveness::alive`] came back false,
    /// look for a RESTARTED daemon to adopt. `restart` spawns a new pid and
    /// rewrites daemon.json, so a join pinned to the attach-time pid would
    /// otherwise die by design at the first tick after every restart. A new
    /// live record is adopted only when its address equals `addr` -- the
    /// address this join resolved, health-probes, and (through the connect
    /// script's port forward) serves to whoever launched it -- because a
    /// daemon that came back on a different bind is not the server this
    /// join's callers are wired to. systemd/launchd probes re-resolve the
    /// service on every tick, so they have nothing to re-pin. Returns
    /// `(old_pid, new_pid)` when a restarted daemon was adopted.
    fn adopt_restarted(&mut self, addr: &str) -> Option<(u32, u32)> {
        let DaemonLiveness::Chan { record_path, pid } = self else {
            return None;
        };
        let record = chan_workspace::daemon_lock::read_daemon_record(record_path)?;
        if record.pid == *pid
            || record.addr != addr
            || !chan_workspace::daemon_lock::is_record_live(&record)
        {
            return None;
        }
        let old_pid = *pid;
        *pid = record.pid;
        Some((old_pid, record.pid))
    }
}

/// How long the watched backend may fail CONTINUOUSLY (liveness lost or
/// `/api/health` missing) before an attached join gives up. Sized to ride out
/// a `restart` bounce (stopping the old instance alone may take up to 15s)
/// and slow-network stalls; the trade-off is that a genuinely dead server is
/// reported up to this much later.
const WATCHDOG_GRACE: Duration = Duration::from_secs(30);

/// Pause between watchdog probe passes.
const WATCHDOG_TICK: Duration = Duration::from_secs(2);

/// Per-probe `/api/health` timeout, deliberately larger than the tick: a
/// loaded box answering in 2-4s is slow, not dead, and must not consume
/// grace.
const WATCHDOG_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// What one watchdog probe pass observed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WatchdogSample {
    /// The backend is alive and `/api/health` answered 2xx.
    Healthy,
    /// The backend liveness probe failed and (chan backend) no restarted
    /// daemon was there to adopt.
    BackendGone,
    /// The backend is alive but `/api/health` missed: non-2xx, transport
    /// error, or timeout.
    HealthMiss,
    /// chan backend: the pinned daemon is gone but a restarted one now serves
    /// the same address, and its pid was adopted. A success.
    Repinned { old_pid: u32, new_pid: u32 },
}

impl WatchdogSample {
    /// Whether this sample closes (or keeps closed) the failure window.
    fn is_success(self) -> bool {
        matches!(
            self,
            WatchdogSample::Healthy | WatchdogSample::Repinned { .. }
        )
    }
}

/// What [`WatchdogState::observe`] tells the watchdog loop to do next.
#[derive(Debug, PartialEq, Eq)]
enum WatchdogVerdict {
    /// Keep probing quietly: healthy, or inside the failure window with grace
    /// left.
    Watching,
    /// The first failing sample after health: the failure window just opened.
    /// The loop narrates the wait once.
    LostContact,
    /// A success closed an open failure window. The loop narrates it once.
    Recovered,
    /// The failure window outlived the grace: report the backend dead.
    GiveUp,
}

/// The watchdog's failure-window arithmetic, kept apart from probing and
/// sleeping so tests drive it with manufactured instants. A join bails only
/// after [`WATCHDOG_GRACE`] of CONTINUOUS failure; any success fully resets
/// the window, so restart bounces and transient stalls read as a narrated
/// wait instead of a dead connection.
struct WatchdogState {
    grace: Duration,
    /// When the current uninterrupted run of failing samples began.
    failing_since: Option<Instant>,
}

impl WatchdogState {
    fn new(grace: Duration) -> Self {
        Self {
            grace,
            failing_since: None,
        }
    }

    fn observe(&mut self, sample: WatchdogSample, now: Instant) -> WatchdogVerdict {
        if sample.is_success() {
            return match self.failing_since.take() {
                Some(_) => WatchdogVerdict::Recovered,
                None => WatchdogVerdict::Watching,
            };
        }
        match self.failing_since {
            None => {
                self.failing_since = Some(now);
                WatchdogVerdict::LostContact
            }
            Some(since) if now.duration_since(since) >= self.grace => WatchdogVerdict::GiveUp,
            Some(_) => WatchdogVerdict::Watching,
        }
    }
}

/// One watchdog probe pass: backend liveness first, then the bounded health
/// probe. A chan-backend join whose pinned pid is gone checks for a restarted
/// daemon on the same address before counting the pass as a failure, so a
/// `restart` reads as a re-pin instead of a death.
async fn watchdog_probe(
    liveness: &mut DaemonLiveness,
    client: &reqwest::Client,
    health_url: &str,
    addr: &str,
) -> WatchdogSample {
    if !liveness.alive().await {
        return match liveness.adopt_restarted(addr) {
            Some((old_pid, new_pid)) => WatchdogSample::Repinned { old_pid, new_pid },
            None => WatchdogSample::BackendGone,
        };
    }
    if health_ok(client, health_url, WATCHDOG_PROBE_TIMEOUT).await {
        WatchdogSample::Healthy
    } else {
        WatchdogSample::HealthMiss
    }
}

/// Resolve when a non-terminal stdin reaches EOF.
///
/// SSH remote commands and the desktop control terminal give `join` a pipe
/// for stdin. Closing that transport does not reliably signal the remote
/// process, so stdin EOF is the ownership boundary that keeps a healthy
/// watchdog from becoming an orphan. A real terminal stays Ctrl-C-driven.
async fn wait_for_join_stdin_eof() {
    use std::io::IsTerminal;

    if std::io::stdin().is_terminal() {
        return std::future::pending::<()>().await;
    }

    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel();
    let _ = std::thread::Builder::new()
        .name("chan-join-stdin".to_string())
        .spawn(move || {
            let _ = std::io::copy(&mut std::io::stdin().lock(), &mut std::io::sink());
            let _ = closed_tx.send(());
        });
    // A thread-spawn failure drops the sender and detaches safely. The backing
    // service remains supervised either way.
    let _ = closed_rx.await;
}

/// Stay foreground watching a running `--service` backend until it dies or the
/// user detaches with Ctrl-C or its non-TTY stdin closes -- the unified
/// reattach contract (no journald / launchd log follow). Detaching leaves the
/// backing server running and exits 0. The server dying exits non-zero, but
/// only after [`WATCHDOG_GRACE`] of continuous failure: a `restart` bounce or
/// a slow network shows as a narrated wait + re-attach instead of killing the
/// join (whose exit tears down the desktop connection riding on it). The exit
/// code still tells the launcher survey a clean detach from a crash.
pub(crate) async fn run_health_watchdog(
    addr: &str,
    mut liveness: DaemonLiveness,
    subject: &str,
) -> Result<()> {
    let health_url = format!("http://{addr}/api/health");
    let client = reqwest::Client::new();
    let mut state = WatchdogState::new(WATCHDOG_GRACE);
    let stdin_eof = wait_for_join_stdin_eof();
    tokio::pin!(stdin_eof);
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                eprintln!("chan devserver: detached; the {subject} keeps running.");
                return Ok(());
            }
            _ = &mut stdin_eof => {
                // The controlling pipe is normally gone too, so do not print:
                // eprintln! would panic on a broken stderr pipe.
                return Ok(());
            }
            // The probe rides inside the select so Ctrl-C stays responsive
            // even while a slow health request is in flight.
            sample = async {
                tokio::time::sleep(WATCHDOG_TICK).await;
                watchdog_probe(&mut liveness, &client, &health_url, addr).await
            } => {
                if let WatchdogSample::Repinned { old_pid, new_pid } = sample {
                    eprintln!(
                        "chan devserver: the {subject} restarted (pid {old_pid} -> {new_pid}); \
                         watching the new process."
                    );
                }
                match state.observe(sample, Instant::now()) {
                    WatchdogVerdict::Watching => {}
                    WatchdogVerdict::LostContact => eprintln!(
                        "chan devserver: lost contact with the {subject}; waiting up to {}s \
                         for it to come back (Ctrl-C detaches).",
                        WATCHDOG_GRACE.as_secs()
                    ),
                    WatchdogVerdict::Recovered => {
                        // A re-pin already narrated its own recovery above.
                        if !matches!(sample, WatchdogSample::Repinned { .. }) {
                            eprintln!(
                                "chan devserver: the {subject} is answering again; \
                                 staying attached."
                            );
                        }
                    }
                    WatchdogVerdict::GiveUp => match sample {
                        WatchdogSample::BackendGone => {
                            anyhow::bail!("chan devserver: the {subject} is no longer running.")
                        }
                        _ => anyhow::bail!(
                            "chan devserver: the {subject} stopped answering /api/health."
                        ),
                    },
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watchdog_failure_bursts_shorter_than_grace_never_bail() {
        let sec = Duration::from_secs;
        let t0 = Instant::now();
        let mut state = WatchdogState::new(sec(30));
        assert_eq!(
            state.observe(WatchdogSample::Healthy, t0),
            WatchdogVerdict::Watching
        );
        // The first failing sample opens the window and narrates once.
        assert_eq!(
            state.observe(WatchdogSample::HealthMiss, t0 + sec(2)),
            WatchdogVerdict::LostContact
        );
        // Mixed failure kinds inside the window stay quiet while grace
        // remains: 31s after t0 is only 29s after the window opened.
        assert_eq!(
            state.observe(WatchdogSample::BackendGone, t0 + sec(10)),
            WatchdogVerdict::Watching
        );
        assert_eq!(
            state.observe(WatchdogSample::HealthMiss, t0 + sec(31)),
            WatchdogVerdict::Watching
        );
        assert_eq!(
            state.observe(WatchdogSample::Healthy, t0 + sec(32)),
            WatchdogVerdict::Recovered
        );
    }

    #[test]
    fn watchdog_continuous_failure_past_grace_gives_up() {
        let sec = Duration::from_secs;
        let t0 = Instant::now();
        let mut state = WatchdogState::new(sec(30));
        assert_eq!(
            state.observe(WatchdogSample::BackendGone, t0),
            WatchdogVerdict::LostContact
        );
        assert_eq!(
            state.observe(WatchdogSample::BackendGone, t0 + sec(29)),
            WatchdogVerdict::Watching
        );
        // The whole grace elapsed without one success: give up.
        assert_eq!(
            state.observe(WatchdogSample::BackendGone, t0 + sec(30)),
            WatchdogVerdict::GiveUp
        );
    }

    #[test]
    fn watchdog_recovery_resets_the_grace_window() {
        let sec = Duration::from_secs;
        let t0 = Instant::now();
        let mut state = WatchdogState::new(sec(30));
        assert_eq!(
            state.observe(WatchdogSample::HealthMiss, t0),
            WatchdogVerdict::LostContact
        );
        assert_eq!(
            state.observe(WatchdogSample::Healthy, t0 + sec(29)),
            WatchdogVerdict::Recovered
        );
        // A new outage starts a FRESH window: 29 more seconds of failure sits
        // within grace again, not a continuation of the first burst.
        assert_eq!(
            state.observe(WatchdogSample::HealthMiss, t0 + sec(30)),
            WatchdogVerdict::LostContact
        );
        assert_eq!(
            state.observe(WatchdogSample::HealthMiss, t0 + sec(59)),
            WatchdogVerdict::Watching
        );
        assert_eq!(
            state.observe(WatchdogSample::HealthMiss, t0 + sec(60)),
            WatchdogVerdict::GiveUp
        );
    }

    #[test]
    fn watchdog_repin_counts_as_success() {
        let sec = Duration::from_secs;
        let t0 = Instant::now();
        let mut state = WatchdogState::new(sec(30));
        assert_eq!(
            state.observe(WatchdogSample::BackendGone, t0),
            WatchdogVerdict::LostContact
        );
        // Adopting a restarted daemon closes the window like a healthy probe.
        assert_eq!(
            state.observe(
                WatchdogSample::Repinned {
                    old_pid: 1,
                    new_pid: 2
                },
                t0 + sec(4)
            ),
            WatchdogVerdict::Recovered
        );
        assert_eq!(
            state.observe(WatchdogSample::Healthy, t0 + sec(6)),
            WatchdogVerdict::Watching
        );
    }

    #[test]
    fn watchdog_adopts_a_restarted_chan_daemon_on_the_same_address() {
        let dir = tempfile::tempdir().unwrap();
        let record_path = dir.path().join("daemon.json");
        let addr = "127.0.0.1:4444";
        // Pin a pid no record below names; the restarted record names THIS
        // test process, the one pid guaranteed to be alive.
        let mut liveness = DaemonLiveness::Chan {
            record_path: record_path.clone(),
            pid: 1,
        };
        // Mid-restart there is no record yet: nothing to adopt.
        assert_eq!(liveness.adopt_restarted(addr), None);
        let record = chan_workspace::daemon_lock::DaemonRecord {
            pid: std::process::id(),
            creation_time: 0,
            addr: addr.to_string(),
            started_at: "2026-01-01T00:00:00Z".to_string(),
        };
        std::fs::write(&record_path, serde_json::to_string(&record).unwrap()).unwrap();
        // A live record on a different address is not the server this join's
        // callers are wired to.
        assert_eq!(liveness.adopt_restarted("127.0.0.1:5555"), None);
        // Same address, live, new pid: adopt it.
        assert_eq!(
            liveness.adopt_restarted(addr),
            Some((1, std::process::id()))
        );
        // The pin moved: the same record is now the watched daemon, so there
        // is nothing further to adopt.
        assert_eq!(liveness.adopt_restarted(addr), None);
    }
}
