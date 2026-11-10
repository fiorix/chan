//! Owned collection for dashboard and diagnostic clients.
//!
//! Readers only copy cached data. OS sampling and chan-home scans have separate
//! workers, so filesystem latency cannot delay process samples or requests.
//! The process sampler runs from the start; the chan-home walker runs only
//! while someone reads, since a walk costs a stat per entry of the home.

mod storage;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chan_metrics::Activity;
use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

pub use storage::Storage;

/// The response contract [`View`] serializes, sent as `schemaVersion`. A
/// reader checks it first and refuses a version it does not know. Within a
/// version fields are only added, and a reader takes an added field as
/// optional; a rename, a removal, or a change of type or unit takes a new
/// version.
pub const SCHEMA_VERSION: u32 = 1;
/// One second per aggregate sample, with ten minutes retained in memory.
pub const HISTORY_CAPACITY: usize = 600;
const INTERVAL: Duration = Duration::from_secs(1);
/// The chan-home walker rescans once a minute while reads arrive, and rests
/// once five minutes pass with no read: a dashboard polls every second, so a
/// rest means nobody is looking.
const STORAGE_SCHEDULE: Schedule = Schedule {
    period: Duration::from_secs(60),
    quiet: Duration::from_secs(300),
};

/// Running server identity. A restart gets a new id even if the PID is reused.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub instance_id: String,
    pub version: String,
    pub build: String,
    pub pid: u32,
    pub hostname: Option<String>,
}

/// Server process counters; child shells and WebView processes are excluded.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Process {
    pub uptime_seconds: u64,
    pub cpu_time_ms: u64,
    /// One logical core is 100%. No rate before two observations exist.
    pub cpu_percent: Option<f64>,
    pub resident_bytes: u64,
    /// Windows reports all process I/O; Linux/macOS report storage I/O.
    /// FreeBSD byte counters are unavailable.
    pub io_scope: String,
    pub read_bytes: Option<u64>,
    pub written_bytes: Option<u64>,
    pub read_bytes_per_second: Option<f64>,
    pub written_bytes_per_second: Option<f64>,
}

/// Per-layer counters and rates. Nested layers must never be summed.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Traffic {
    #[serde(flatten)]
    pub totals: Activity,
    pub received_bytes_per_second: Option<f64>,
    pub sent_bytes_per_second: Option<f64>,
}

/// Aggregate transfer-lane occupancy and outcomes since process start.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfers {
    pub queued: u64,
    pub running: u64,
    pub worker_capacity: usize,
    pub queue_capacity: usize,
    pub finished: u64,
    pub cancelled: u64,
    pub stalled: u64,
    pub panicked: u64,
    pub refused: u64,
}

/// One immutable observation. All rate intervals use the monotonic clock.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub sequence: u64,
    pub elapsed_ms: u64,
    pub sampled_at_ms: u64,
    pub collection_micros: u64,
    pub process: Option<Process>,
    pub network: Traffic,
    pub http2: Traffic,
    pub yamux: Traffic,
    pub reverse_connections: Traffic,
    pub transfer_payload: Traffic,
    pub transfers: Transfers,
    pub gateway_tunnels: u64,
    pub tunnel_dial_failures: u64,
    pub reverse_listeners: u64,
    pub yamux_waiting: u64,
    pub yamux_serving: u64,
    pub yamux_service_capacity: u64,
    pub yamux_stream_limit: usize,
}

/// Cached response used by HTTP, CLI and Varlink. History is opt-in.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub schema_version: u32,
    pub identity: Identity,
    pub latest: Option<Sample>,
    pub history: Vec<Sample>,
    pub storage: Storage,
}

struct Cached {
    history: VecDeque<Sample>,
    storage: Storage,
}

/// The runtime's owned stop signal also wakes workers sleeping between scans.
#[derive(Default)]
struct Stop {
    stopped: Mutex<bool>,
    wake: Condvar,
}

impl Stop {
    fn is_stopped(&self) -> bool {
        *self.stopped.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn wait(&self, duration: Duration) -> bool {
        let stopped = self.stopped.lock().unwrap_or_else(|e| e.into_inner());
        let (stopped, _) = self
            .wake
            .wait_timeout_while(stopped, duration, |v| !*v)
            .unwrap_or_else(|e| e.into_inner());
        *stopped
    }
    fn stop(&self) {
        *self.stopped.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.wake.notify_all();
    }
}

/// When the chan-home walker scans: every `period` while reads arrive, and
/// never once `quiet` has passed since the last read.
#[derive(Clone, Copy, Debug)]
struct Schedule {
    period: Duration,
    quiet: Duration,
}

#[derive(Debug, PartialEq)]
enum Walk {
    Now,
    After(Duration),
    Rest,
}

impl Schedule {
    /// The walker's next step at `now`. Pure, so the start-on-read and
    /// rest-after-quiet rules are testable without waiting.
    fn next(&self, now: Instant, last_read: Option<Instant>, last_scan: Option<Instant>) -> Walk {
        let Some(read) = last_read else {
            return Walk::Rest;
        };
        let quiet_left = self
            .quiet
            .saturating_sub(now.saturating_duration_since(read));
        if quiet_left.is_zero() {
            return Walk::Rest;
        }
        let due = last_scan.map_or(Duration::ZERO, |scan| {
            self.period
                .saturating_sub(now.saturating_duration_since(scan))
        });
        if due.is_zero() {
            Walk::Now
        } else {
            Walk::After(due.min(quiet_left))
        }
    }
}

/// Reads that drive the walker. Its own lock and condvar pair the stop flag
/// with the last read, so neither a read nor a stop can slip past a walker
/// that is about to wait.
#[derive(Default)]
struct Demand {
    state: Mutex<DemandState>,
    wake: Condvar,
}

#[derive(Default)]
struct DemandState {
    stopped: bool,
    last_read: Option<Instant>,
}

impl Demand {
    fn read(&self) {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .last_read = Some(Instant::now());
        self.wake.notify_all();
    }

    fn stop(&self) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).stopped = true;
        self.wake.notify_all();
    }

    /// Block until a scan is due. False once the runtime has stopped.
    fn wait_for_scan(&self, schedule: Schedule, last_scan: Option<Instant>) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if state.stopped {
                return false;
            }
            state = match schedule.next(Instant::now(), state.last_read, last_scan) {
                Walk::Now => return true,
                Walk::After(wait) => {
                    self.wake
                        .wait_timeout(state, wait)
                        .unwrap_or_else(|e| e.into_inner())
                        .0
                }
                Walk::Rest => self.wake.wait(state).unwrap_or_else(|e| e.into_inner()),
            };
        }
    }
}

/// Run `scan` whenever `schedule` says, until the runtime stops or `scan`
/// returns false. Each period runs from the end of the previous scan, so a
/// slow scan is followed by a full period of rest, never by the next scan
/// at once.
fn walk(demand: &Demand, schedule: Schedule, mut scan: impl FnMut() -> bool) {
    let mut last_scan = None;
    while demand.wait_for_scan(schedule, last_scan) {
        if !scan() {
            break;
        }
        last_scan = Some(Instant::now());
    }
}

/// Lifetime owner for the sampler and disk walker. Workers hold only their
/// cache and stop signal, so there is no owner/worker reference cycle.
pub struct Runtime {
    identity: Identity,
    cached: Arc<Mutex<Cached>>,
    stop: Arc<Stop>,
    demand: Arc<Demand>,
}

impl Drop for Runtime {
    fn drop(&mut self) {
        // A filesystem syscall can stall indefinitely on a remote mount. Never
        // join that worker on the serving thread; it observes stop on return.
        self.stop.stop();
        self.demand.stop();
    }
}

impl Runtime {
    /// Start once at the outer server router, before serving any requests.
    pub fn start(home: PathBuf) -> std::io::Result<Arc<Self>> {
        Self::start_with(home, STORAGE_SCHEDULE)
    }

    fn start_with(home: PathBuf, schedule: Schedule) -> std::io::Result<Arc<Self>> {
        let stop = Arc::new(Stop::default());
        let demand = Arc::new(Demand::default());
        let cached = Arc::new(Mutex::new(Cached {
            history: VecDeque::with_capacity(HISTORY_CAPACITY),
            storage: Storage::pending(&home),
        }));
        let runtime = Arc::new(Self {
            identity: Identity {
                instance_id: format!("{:032x}", rand::random::<u128>()),
                version: env!("CARGO_PKG_VERSION").into(),
                build: crate::build_id().into(),
                pid: std::process::id(),
                hostname: System::host_name(),
            },
            cached: cached.clone(),
            stop: stop.clone(),
            demand: demand.clone(),
        });
        let process_cache = cached.clone();
        let process_stop = stop.clone();
        std::thread::Builder::new()
            .name("chan-metrics".into())
            .spawn(move || {
                let mut sampler = Sampler::new();
                loop {
                    if process_stop.is_stopped() {
                        break;
                    }
                    let started = Instant::now();
                    let sample = sampler.sample();
                    let mut cache = process_cache.lock().unwrap_or_else(|e| e.into_inner());
                    if cache.history.len() == HISTORY_CAPACITY {
                        cache.history.pop_front();
                    }
                    cache.history.push_back(sample);
                    drop(cache);
                    if process_stop.wait(INTERVAL.saturating_sub(started.elapsed())) {
                        break;
                    }
                }
            })?;
        std::thread::Builder::new()
            .name("chan-storage-metrics".into())
            .spawn(move || {
                walk(&demand, schedule, || {
                    let result = storage::scan(&home, &stop);
                    if stop.is_stopped() {
                        return false;
                    }
                    let mut cache = cached.lock().unwrap_or_else(|e| e.into_inner());
                    // A failed scan updates its diagnostic, preserving the last
                    // completed total and its age instead of publishing a partial sum.
                    match result {
                        Ok(storage) => cache.storage = storage,
                        Err(error) => cache.storage.error = Some(error.to_string()),
                    }
                    true
                })
            })?;
        Ok(runtime)
    }

    /// Copy cached samples newer than `since`, without performing collection.
    /// A read keeps the chan-home walker running; until its next scan
    /// completes, storage holds the last completed total or pending.
    pub fn view(&self, history: bool, since: Option<u64>) -> View {
        self.demand.read();
        let cache = self.cached.lock().unwrap_or_else(|e| e.into_inner());
        View {
            schema_version: SCHEMA_VERSION,
            identity: self.identity.clone(),
            latest: cache.history.back().cloned(),
            history: if history {
                cache
                    .history
                    .iter()
                    .filter(|sample| since.is_none_or(|seq| sample.sequence > seq))
                    .cloned()
                    .collect()
            } else {
                Vec::new()
            },
            storage: cache.storage.clone(),
        }
    }
}

/// Install a metrics owner on the outer server router. Tenant routers consume
/// its extension and share the same history, including the launcher root.
pub fn with_metrics(router: axum::Router) -> axum::Router {
    match Runtime::start(chan_workspace::paths::config_dir()) {
        Ok(runtime) => router.layer(axum::Extension(runtime)),
        Err(error) => {
            tracing::error!(%error, "metrics workers could not start");
            router
        }
    }
}

struct Sampler {
    system: System,
    started: Instant,
    previous: Option<Sample>,
}

impl Sampler {
    fn new() -> Self {
        Self {
            system: System::new(),
            started: Instant::now(),
            previous: None,
        }
    }
    fn sample(&mut self) -> Sample {
        let started = Instant::now();
        let pid = Pid::from_u32(std::process::id());
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing()
                .with_cpu()
                .with_memory()
                .with_disk_usage(),
        );
        let elapsed_ms = self.started.elapsed().as_millis() as u64;
        let interval = self
            .previous
            .as_ref()
            .map(|p| elapsed_ms.saturating_sub(p.elapsed_ms))
            .filter(|ms| *ms > 0);
        let process = self.system.process(pid).map(|p| {
            let previous = self.previous.as_ref().and_then(|p| p.process.as_ref());
            // sysinfo exposes FreeBSD ru_inblock/ru_oublock operations as
            // bytes. Their operation sizes are unknown, so no byte rate can
            // be derived from them.
            let io = (!cfg!(target_os = "freebsd")).then(|| p.disk_usage());
            let read_bytes = io.as_ref().map(|io| io.total_read_bytes);
            let written_bytes = io.as_ref().map(|io| io.total_written_bytes);
            Process {
                uptime_seconds: p.run_time(),
                cpu_time_ms: p.accumulated_cpu_time(),
                cpu_percent: rate(
                    p.accumulated_cpu_time(),
                    previous.map(|p| p.cpu_time_ms),
                    interval,
                )
                .map(|v| v / 10.0),
                resident_bytes: p.memory(),
                io_scope: if io.is_none() {
                    "unavailable"
                } else if cfg!(windows) {
                    "process_io"
                } else {
                    "storage_io"
                }
                .into(),
                read_bytes,
                written_bytes,
                read_bytes_per_second: read_bytes
                    .and_then(|bytes| rate(bytes, previous.and_then(|p| p.read_bytes), interval)),
                written_bytes_per_second: written_bytes.and_then(|bytes| {
                    rate(bytes, previous.and_then(|p| p.written_bytes), interval)
                }),
            }
        });
        let prev = self.previous.as_ref();
        let sample = Sample {
            sequence: prev.map_or(1, |s| s.sequence + 1),
            elapsed_ms,
            sampled_at_ms: now_ms(),
            collection_micros: started.elapsed().as_micros() as u64,
            process,
            network: traffic(&chan_metrics::NETWORK, prev.map(|s| &s.network), interval),
            http2: traffic(&chan_metrics::HTTP2, prev.map(|s| &s.http2), interval),
            yamux: traffic(&chan_metrics::YAMUX, prev.map(|s| &s.yamux), interval),
            reverse_connections: traffic(
                &chan_metrics::REVERSE,
                prev.map(|s| &s.reverse_connections),
                interval,
            ),
            transfer_payload: traffic(
                &chan_metrics::TRANSFERS,
                prev.map(|s| &s.transfer_payload),
                interval,
            ),
            transfers: crate::bulk_transfer::metrics(),
            gateway_tunnels: chan_metrics::TUNNELS.snapshot().active,
            tunnel_dial_failures: chan_metrics::TUNNEL_DIAL_FAILURES.get(),
            reverse_listeners: chan_metrics::REVERSE_LISTENERS.snapshot().active,
            yamux_waiting: chan_metrics::YAMUX_WAITING.snapshot().active,
            yamux_serving: chan_metrics::YAMUX_SERVING.snapshot().active,
            yamux_service_capacity: chan_metrics::YAMUX_SERVICE_CAPACITY.snapshot().active,
            yamux_stream_limit: chan_tunnel_proto::TUNNEL_YAMUX_MAX_STREAMS,
        };
        self.previous = Some(sample.clone());
        sample
    }
}

fn traffic(
    counter: &chan_metrics::Counter,
    previous: Option<&Traffic>,
    interval: Option<u64>,
) -> Traffic {
    let totals = counter.snapshot();
    Traffic {
        received_bytes_per_second: rate(
            totals.received_bytes,
            previous.map(|s| s.totals.received_bytes),
            interval,
        ),
        sent_bytes_per_second: rate(
            totals.sent_bytes,
            previous.map(|s| s.totals.sent_bytes),
            interval,
        ),
        totals,
    }
}

fn rate(total: u64, previous: Option<u64>, interval_ms: Option<u64>) -> Option<f64> {
    let delta = total.checked_sub(previous?)?;
    let ms = interval_ms.filter(|ms| *ms > 0)?;
    Some(delta as f64 * 1000.0 / ms as f64)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// TCP listener accounting that also covers upgraded WebSockets. Counts
/// userspace socket bytes, including HTTP framing, not packet/TLS overhead.
pub struct MeteredListener(pub tokio::net::TcpListener);

impl axum::serve::Listener for MeteredListener {
    type Io = chan_metrics::MeteredIo<tokio::net::TcpStream>;
    type Addr = std::net::SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        let (stream, addr) = axum::serve::Listener::accept(&mut self.0).await;
        (
            chan_metrics::MeteredIo::new(stream, &chan_metrics::NETWORK),
            addr,
        )
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.0.local_addr()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rates_handle_warmup_resets_and_real_intervals() {
        assert_eq!(rate(100, None, Some(1000)), None);
        assert_eq!(rate(10, Some(20), Some(1000)), None);
        assert_eq!(rate(100, Some(50), Some(0)), None);
        assert_eq!(rate(110, Some(10), Some(2000)), Some(50.0));
    }

    #[test]
    fn collection_runs_without_readers_and_owner_drop_stops_it() {
        let home = tempfile::tempdir().unwrap();
        let runtime = Runtime::start(home.path().into()).unwrap();
        let stop = runtime.stop.clone();
        let cache = runtime.cached.clone();
        let deadline = Instant::now() + Duration::from_secs(5);
        while cache.lock().unwrap().history.len() < 2 {
            assert!(Instant::now() < deadline, "sampler did not run");
            std::thread::sleep(Duration::from_millis(20));
        }
        let view = runtime.view(true, Some(1));
        assert!(view.history.iter().all(|s| s.sequence > 1));
        assert_eq!(view.identity.pid, std::process::id());
        let process = view.latest.unwrap().process.unwrap();
        assert!(process.resident_bytes > 0);
        if cfg!(target_os = "freebsd") {
            assert_eq!(process.io_scope, "unavailable");
            assert_eq!(process.read_bytes, None);
            assert_eq!(process.written_bytes, None);
            assert_eq!(process.read_bytes_per_second, None);
            assert_eq!(process.written_bytes_per_second, None);
        } else {
            assert!(process.read_bytes.is_some());
            assert!(process.written_bytes.is_some());
        }
        let demand = runtime.demand.clone();
        drop(runtime);
        assert!(stop.is_stopped());
        assert!(demand.state.lock().unwrap().stopped);
    }

    #[test]
    fn the_walker_starts_on_a_read_and_rests_after_a_quiet_period() {
        let schedule = Schedule {
            period: Duration::from_secs(60),
            quiet: Duration::from_secs(300),
        };
        let boot = Instant::now();
        let at = |secs| boot + Duration::from_secs(secs);
        // No read yet: no walk at boot, however long the process has run.
        assert_eq!(schedule.next(at(0), None, None), Walk::Rest);
        assert_eq!(schedule.next(at(3600), None, None), Walk::Rest);
        // The first read starts a scan at once.
        assert_eq!(schedule.next(at(10), Some(at(10)), None), Walk::Now);
        // While reads arrive, scans repeat each period.
        assert_eq!(
            schedule.next(at(30), Some(at(30)), Some(at(10))),
            Walk::After(Duration::from_secs(40))
        );
        assert_eq!(schedule.next(at(70), Some(at(69)), Some(at(10))), Walk::Now);
        // The wait never outlasts the quiet deadline.
        assert_eq!(
            schedule.next(at(340), Some(at(60)), Some(at(320))),
            Walk::After(Duration::from_secs(20))
        );
        // Quiet for the whole period: the walker rests.
        assert_eq!(
            schedule.next(at(360), Some(at(60)), Some(at(320))),
            Walk::Rest
        );
        assert_eq!(
            schedule.next(at(900), Some(at(60)), Some(at(320))),
            Walk::Rest
        );
        // A read after the quiet period starts a scan again at once.
        assert_eq!(
            schedule.next(at(900), Some(at(900)), Some(at(320))),
            Walk::Now
        );
    }

    #[test]
    fn each_rescan_waits_a_full_period_after_the_previous_scan_completes() {
        let demand = std::sync::Arc::new(Demand::default());
        let schedule = Schedule {
            period: Duration::from_millis(200),
            quiet: Duration::from_secs(60),
        };
        demand.read();
        let walker = {
            let demand = demand.clone();
            std::thread::spawn(move || {
                let mut scans = Vec::new();
                walk(&demand, schedule, || {
                    let started = Instant::now();
                    // A scan slower than the period.
                    std::thread::sleep(Duration::from_millis(300));
                    scans.push((started, Instant::now()));
                    scans.len() < 3
                });
                scans
            })
        };
        let scans = walker.join().unwrap();
        assert_eq!(scans.len(), 3);
        for pair in scans.windows(2) {
            let rest = pair[1].0.duration_since(pair[0].1);
            assert!(
                rest >= schedule.period,
                "rescanned {rest:?} after the last scan ended"
            );
        }
    }

    #[test]
    fn reads_drive_the_walker_and_storage_keeps_its_last_total_while_it_rests() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join("file"), b"12345").unwrap();
        let schedule = Schedule {
            period: Duration::from_millis(50),
            quiet: Duration::from_millis(300),
        };
        let runtime = Runtime::start_with(home.path().into(), schedule).unwrap();
        // Peek at the cache without counting as a read.
        let storage = || runtime.cached.lock().unwrap().storage.clone();
        let wait_for = |what: &str, done: &dyn Fn(&Storage) -> bool| {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let storage = storage();
                if done(&storage) {
                    return storage;
                }
                assert!(Instant::now() < deadline, "{what}: {storage:?}");
                std::thread::sleep(Duration::from_millis(10));
            }
        };
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(storage().sampled_at_ms, None, "walked before any read");
        let first = runtime.view(false, None);
        assert_eq!(first.storage.logical_bytes, None, "pending, not zero");
        let scanned = wait_for("no scan after a read", &|s| s.sampled_at_ms.is_some());
        assert_eq!(scanned.logical_bytes, Some(5));
        // Reads keep the walker scanning.
        let read_until = Instant::now() + Duration::from_millis(400);
        while Instant::now() < read_until {
            runtime.view(false, None);
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            storage().sampled_at_ms > scanned.sampled_at_ms,
            "no rescan while read"
        );
        // No reads: once the quiet period ends the walker rests and the last
        // total stays, with its timestamp.
        std::thread::sleep(Duration::from_millis(1500));
        let rested = storage();
        std::thread::sleep(Duration::from_millis(600));
        assert_eq!(
            storage().sampled_at_ms,
            rested.sampled_at_ms,
            "walked while quiet"
        );
        assert_eq!(rested.logical_bytes, Some(5));
        // A read after the quiet period restarts it.
        std::fs::write(home.path().join("more"), b"123").unwrap();
        let view = runtime.view(false, None);
        assert_eq!(
            view.storage.logical_bytes,
            Some(5),
            "last total until the scan"
        );
        let rescanned = wait_for("no scan after the quiet period", &|s| {
            s.sampled_at_ms > rested.sampled_at_ms
        });
        assert_eq!(rescanned.logical_bytes, Some(8));
    }
}
