//! One coalesced name-reading sweep for the registry, independent of attached viewers.

use super::terminal_program::{Foreground, NameRequest};
use super::*;
use tokio::time::Instant;

const REFRESH_INTERVAL: Duration = Duration::from_millis(150);

fn sample_interval() -> Duration {
    if cfg!(any(target_os = "macos", target_os = "freebsd")) {
        Duration::from_millis(1_000)
    } else {
        Duration::from_millis(500)
    }
}

trait ProgramSource: Send + Sync + 'static {
    fn foreground(&self, session: &Session) -> Foreground;
    fn names(&self, groups: &[u32]) -> HashMap<u32, String>;
}

struct PlatformSource;

impl ProgramSource for PlatformSource {
    fn foreground(&self, session: &Session) -> Foreground {
        session.program_foreground()
    }

    fn names(&self, groups: &[u32]) -> HashMap<u32, String> {
        process_names(groups)
    }
}

#[cfg(target_os = "linux")]
fn process_names(groups: &[u32]) -> HashMap<u32, String> {
    groups
        .iter()
        .filter_map(|&group| {
            // Kernel process names are short, but bound the read independently of procfs.
            let file = File::open(format!("/proc/{group}/comm")).ok()?;
            let mut bytes = Vec::new();
            file.take(257).read_to_end(&mut bytes).ok()?;
            if bytes.len() > 256 {
                return None;
            }
            Some((group, String::from_utf8_lossy(&bytes).trim_end().to_owned()))
        })
        .collect()
}

#[cfg(any(target_os = "macos", target_os = "freebsd"))]
fn process_names(groups: &[u32]) -> HashMap<u32, String> {
    process_names_from_table(groups)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "freebsd")))]
fn process_names(_groups: &[u32]) -> HashMap<u32, String> {
    HashMap::new()
}

#[cfg(any(
    target_os = "macos",
    target_os = "freebsd",
    all(test, target_os = "linux")
))]
fn process_names_from_table(groups: &[u32]) -> HashMap<u32, String> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    if groups.is_empty() {
        return HashMap::new();
    }
    let pids: Vec<_> = groups.iter().copied().map(Pid::from_u32).collect();
    // A fresh table avoids cached names across exec. Some platforms enumerate the
    // process table even for selected pids, so one refresh covers the entire sweep.
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        true,
        ProcessRefreshKind::nothing(),
    );
    pids.into_iter()
        .filter_map(|pid| {
            let name = system.process(pid)?.name().to_string_lossy().into_owned();
            Some((pid.as_u32(), name))
        })
        .collect()
}

/// The monotonic scheduling state also accepts a synthetic clock in tests.
struct Schedule {
    period: Duration,
    periodic: Instant,
    allowed: Instant,
    dirty: bool,
}

impl Schedule {
    fn new(now: Instant, period: Duration) -> Self {
        Self {
            period,
            periodic: now + period,
            allowed: now,
            dirty: true,
        }
    }

    fn deadline(&self) -> Instant {
        if self.dirty {
            self.allowed
        } else {
            self.periodic.max(self.allowed)
        }
    }

    fn take(&mut self, now: Instant) -> Option<bool> {
        if now < self.deadline() {
            return None;
        }
        let periodic = now >= self.periodic;
        if periodic {
            self.periodic = now + self.period;
        }
        self.allowed = now + REFRESH_INTERVAL;
        self.dirty = false;
        Some(periodic)
    }
}

struct Sample {
    session: Arc<Session>,
    request: NameRequest,
    name: Option<String>,
}

fn prepare_batch(
    sessions: Vec<Arc<Session>>,
    periodic: bool,
    source: &impl ProgramSource,
) -> Vec<(Arc<Session>, NameRequest)> {
    sessions
        .into_iter()
        .filter_map(|session| {
            let request = session.prepare_program_sample(periodic, source)?;
            Some((session, request))
        })
        .collect()
}

fn read_names(
    requests: Vec<(Arc<Session>, NameRequest)>,
    source: &impl ProgramSource,
) -> Vec<Sample> {
    let groups: Vec<_> = requests
        .iter()
        .map(|(_, request)| request.group())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    // No registry or output guard survives into this potentially blocking read.
    let names = if groups.is_empty() {
        HashMap::new()
    } else {
        source.names(&groups)
    };
    requests
        .into_iter()
        .map(|(session, request)| Sample {
            session,
            request,
            name: names.get(&request.group()).cloned(),
        })
        .collect()
}

impl Registry {
    /// Sample foreground names for every live ordinary PTY, including quiet and detached
    /// sessions. The owner must start exactly one sampler and stop it with its other tasks.
    /// A shutdown ends the async task without waiting for a running OS name read; that
    /// single blocking batch may finish later, but cannot publish after this task ends.
    pub fn spawn_program_sampler(
        self: Arc<Self>,
        shutdown_rx: watch::Receiver<bool>,
    ) -> JoinHandle<()> {
        tokio::spawn(self.run_program_sampler(
            shutdown_rx,
            Arc::new(PlatformSource),
            sample_interval(),
        ))
    }

    async fn run_program_sampler(
        self: Arc<Self>,
        mut shutdown_rx: watch::Receiver<bool>,
        source: Arc<impl ProgramSource>,
        period: Duration,
    ) {
        let mut schedule = Schedule::new(Instant::now(), period);
        loop {
            if *shutdown_rx.borrow() {
                return;
            }
            tokio::select! {
                biased;
                _ = shutdown_rx.changed() => return,
                _ = self.program_refresh.notified() => schedule.dirty = true,
                _ = tokio::time::sleep_until(schedule.deadline()) => {}
            }
            let Some(periodic) = schedule.take(Instant::now()) else {
                continue;
            };
            let sessions = self
                .sessions
                .lock()
                .expect("terminal registry poisoned")
                .values()
                .filter(|session| {
                    !session.closed.load(Ordering::Relaxed) && !session.is_tmux_pane()
                })
                .cloned()
                .collect();
            let batch_source = source.clone();
            // Observe and publish transitions before handing off the read. The
            // detached blocking work can then never publish after shutdown.
            let requests = prepare_batch(sessions, periodic, &*source);
            let mut work =
                tokio::task::spawn_blocking(move || read_names(requests, &*batch_source));
            tokio::select! {
                biased;
                _ = shutdown_rx.changed() => {
                    work.abort();
                    return;
                }
                result = &mut work => match result {
                    Ok(samples) => self.apply_program_samples(samples, &*source),
                    Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
                    Err(_) => return,
                }
            }
        }
    }

    fn apply_program_samples(&self, samples: Vec<Sample>, source: &impl ProgramSource) {
        let sessions = self.sessions.lock().expect("terminal registry poisoned");
        for sample in samples {
            // Id and generation alone can be reused by an import. The captured Arc
            // identifies the exact observer that issued this lookup token.
            if sessions
                .get(&sample.session.id)
                .is_some_and(|live| Arc::ptr_eq(live, &sample.session))
            {
                sample
                    .session
                    .apply_program_sample(sample.request, sample.name.as_deref(), source);
            }
        }
    }
}

impl SessionOutput {
    pub(super) fn publish_program(&self) {
        self.program_tx.send_if_modified(|reading| {
            if reading == self.program.reading() {
                false
            } else {
                *reading = self.program.reading().clone();
                true
            }
        });
    }

    pub(super) fn end_program(&mut self) {
        self.program_ended = true;
        self.program_dirty = false;
        self.program.clear();
        self.publish_program();
    }
}

impl Session {
    pub(super) fn request_program_refresh(&self) {
        if let Some(notify) = self.program_refresh.get() {
            notify.notify_one();
        }
    }

    fn prepare_program_sample(
        &self,
        periodic: bool,
        source: &impl ProgramSource,
    ) -> Option<NameRequest> {
        let mut output = self.output.lock().expect("terminal output poisoned");
        if self.closed.load(Ordering::Relaxed)
            || self.is_tmux_pane()
            || output.program_ended
            || (!periodic && !output.program_dirty)
        {
            return None;
        }
        output.program_dirty = false;
        let request = output.program.observe(|| source.foreground(self));
        output.publish_program();
        request
    }

    fn apply_program_sample(
        &self,
        request: NameRequest,
        name: Option<&str>,
        source: &impl ProgramSource,
    ) {
        let mut output = self.output.lock().expect("terminal output poisoned");
        if !self.closed.load(Ordering::Relaxed) && !output.program_ended {
            output
                .program
                .apply_name(request, source.foreground(self), name);
            output.publish_program();
        }
    }

    pub(super) fn seed_program(&self) {
        self.seed_program_with(&PlatformSource);
    }

    fn seed_program_with(&self, source: &impl ProgramSource) {
        if let Some(request) = self.prepare_program_sample(true, source) {
            let names = source.names(&[request.group()]);
            self.apply_program_sample(
                request,
                names.get(&request.group()).map(String::as_str),
                source,
            );
        }
    }
}

#[cfg(test)]
#[path = "terminal_program_sampling_tests.rs"]
mod tests;
