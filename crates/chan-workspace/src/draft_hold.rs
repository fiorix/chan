//! Test seam: hold or fail one step of a draft store operation.
//!
//! A workspace draft is built under `drafts-staging/` and published into
//! `Drafts/` by one rename, and a promotion retires its source into staging
//! by rename before removing it. A reader of `Drafts/` must never see a draft
//! between those steps, so tests hold an operation at a named [`Step`] and
//! read the list while it is held, or make the step fail. Compiled for this
//! crate's tests and for downstream builds that enable `test-hooks`, as
//! [`crate::paths::root_stall`] is; a build without the feature has none of
//! it.
//!
//! A step is armed in one of two ways:
//!
//! - [`on_step`]: a test registers a one-shot action for one store, keyed by
//!   its drafts directory, so tests that hold their own temporary stores do
//!   not interfere. The action runs on the operation's thread with the
//!   directory the step is about. It can block until the test releases it,
//!   or return an error the operation then meets as that step's failure.
//! - [`ENV`] (Linux): a server built with the feature holds the first
//!   operation of any store that reaches the named step, through two FIFOs a
//!   driver made, so a browser can be pointed at a window that is otherwise
//!   too short to see. The hold is bounded: an unattended server fails the
//!   held operation with an error naming the hold instead of wedging.
//!
//! [`SOURCE_REMOVING`] is reached inside the store's serial lock, which every
//! other draft write waits on, so a hold there pauses the whole draft store
//! until it ends.

use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, PoisonError};

/// One named step of a draft store operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Step(&'static str);

impl Step {
    /// The name [`ENV`] and a hold's report use for this step.
    pub fn name(self) -> &'static str {
        self.0
    }
}

impl fmt::Display for Step {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

/// A create's staging entry exists and is empty.
pub const DIRECTORY_MADE: Step = Step("directory-made");
/// A create's staging entry holds its lifetime marker (a standalone store
/// writes none) and no primary file yet.
pub const MARKER_WRITTEN: Step = Step("marker-written");
/// A create's staging entry is complete and is about to be published.
pub const PRIMARY_WRITTEN: Step = Step("primary-written");
/// A promotion has written its target and is about to remove the directory
/// the step names. Reached inside the store's serial lock.
pub const SOURCE_REMOVING: Step = Step("source-removing");

const STEPS: [Step; 4] = [
    DIRECTORY_MADE,
    MARKER_WRITTEN,
    PRIMARY_WRITTEN,
    SOURCE_REMOVING,
];

type Action = Box<dyn FnOnce(&Path) -> io::Result<()> + Send>;

struct Armed {
    drafts_dir: PathBuf,
    step: Step,
    action: Action,
}

static ARMED: Mutex<Vec<Armed>> = Mutex::new(Vec::new());

/// Run `action` once, the first time an operation of the store whose drafts
/// directory is `drafts_dir` reaches `step`. The action receives the
/// directory the step is about: the staging entry of a create, or the
/// directory a promotion is about to remove. An error it returns fails the
/// step.
pub fn on_step(
    drafts_dir: impl Into<PathBuf>,
    step: Step,
    action: impl FnOnce(&Path) -> io::Result<()> + Send + 'static,
) {
    ARMED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push(Armed {
            drafts_dir: drafts_dir.into(),
            step,
            action: Box::new(action),
        });
}

/// The store reached `step` on `dir`. Runs the action armed for this store
/// and step, then the environment's hold.
pub(crate) fn reached(drafts_dir: &Path, step: Step, dir: &Path) -> io::Result<()> {
    let armed = {
        let mut armed = ARMED.lock().unwrap_or_else(PoisonError::into_inner);
        armed
            .iter()
            .position(|armed| armed.step == step && armed.drafts_dir == drafts_dir)
            .map(|index| armed.swap_remove(index))
    };
    if let Some(armed) = armed {
        (armed.action)(dir)?;
    }
    environment_hold(step, dir)
}

/// The variable a server built with `test-hooks` reads its hold from, as
/// `<step>:<dir>`: a step name ([`Step::name`]) and an absolute directory
/// holding two FIFOs, `reached` and `release`. The first operation that
/// reaches the step writes one line, `<step> <directory it holds>`, to
/// `reached`, then waits until a writer opens `release` and writes to it or
/// closes it. A driver reads `reached` before it opens `release`: `release`
/// opened first ends the hold the moment the operation reaches it. The wait
/// is bounded; at the bound the held operation fails with a timed-out error
/// naming the hold. A malformed value fails every operation that reaches a
/// step, with an error naming the value.
pub const ENV: &str = "CHAN_TEST_DRAFT_HOLD";

#[cfg(target_os = "linux")]
const ENV_BOUND: std::time::Duration = std::time::Duration::from_secs(600);

#[derive(Debug, PartialEq, Eq)]
struct Spec {
    step: Step,
    dir: PathBuf,
}

fn parse_spec(value: &str) -> Result<Spec, String> {
    let refuse = || {
        let names: Vec<&str> = STEPS.iter().map(|step| step.name()).collect();
        format!(
            "{ENV}={value:?}: expected <step>:<absolute directory> with a step of {}",
            names.join(", ")
        )
    };
    if cfg!(not(target_os = "linux")) {
        return Err(format!(
            "{ENV}={value:?}: the hold's FIFOs are read on Linux only"
        ));
    }
    let (name, dir) = value.split_once(':').ok_or_else(refuse)?;
    let step = STEPS
        .into_iter()
        .find(|step| step.name() == name)
        .ok_or_else(refuse)?;
    let dir = PathBuf::from(dir);
    if !dir.is_absolute() {
        return Err(refuse());
    }
    Ok(Spec { step, dir })
}

fn environment_hold(step: Step, dir: &Path) -> io::Result<()> {
    static SPEC: OnceLock<Option<Result<Spec, String>>> = OnceLock::new();
    static TAKEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let spec = SPEC
        .get_or_init(|| std::env::var_os(ENV).map(|value| parse_spec(&value.to_string_lossy())));
    match spec {
        None => Ok(()),
        Some(Err(message)) => Err(io::Error::new(io::ErrorKind::InvalidInput, message.clone())),
        Some(Ok(spec)) if spec.step == step => {
            if TAKEN.swap(true, std::sync::atomic::Ordering::SeqCst) {
                return Ok(());
            }
            hold_on_fifos(spec, dir)
        }
        Some(Ok(_)) => Ok(()),
    }
}

#[cfg(target_os = "linux")]
fn hold_on_fifos(spec: &Spec, held: &Path) -> io::Result<()> {
    fifo_hold(&spec.dir, spec.step, held, ENV_BOUND)
}

#[cfg(not(target_os = "linux"))]
fn hold_on_fifos(spec: &Spec, _held: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        format!(
            "{ENV}: the hold's FIFOs in {} are read on Linux only",
            spec.dir.display()
        ),
    ))
}

/// Hold `step` on `held` through the FIFOs in `fifo_dir` for at most `bound`.
///
/// `reached` is opened read-write so the open does not wait for a reader:
/// Linux keeps the line in the pipe while this end stays open, for a driver
/// that reads it at any point of the hold. `release` is opened for reading
/// without blocking and polled, so the wait has a bound; Linux reports no
/// hang-up on it until a writer has opened it, so only a driver's open, its
/// write or its close ends the wait.
#[cfg(target_os = "linux")]
pub(crate) fn fifo_hold(
    fifo_dir: &Path,
    step: Step,
    held: &Path,
    bound: std::time::Duration,
) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let mut reached = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(fifo_dir.join("reached"))?;
    writeln!(reached, "{step} {}", held.display())?;
    let release_path = fifo_dir.join("release");
    let release = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(&release_path)?;
    if !wait_readable(&release, bound)? {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            format!(
                "draft hold at {step} on {} expired after {} s with no release on {}",
                held.display(),
                bound.as_secs_f64(),
                release_path.display()
            ),
        ));
    }
    drop(reached);
    Ok(())
}

#[cfg(target_os = "linux")]
fn wait_readable(file: &std::fs::File, bound: std::time::Duration) -> io::Result<bool> {
    use std::os::fd::AsRawFd;

    let deadline = std::time::Instant::now() + bound;
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        let timeout = i32::try_from(left.as_millis()).unwrap_or(i32::MAX);
        let mut fd = libc::pollfd {
            fd: file.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: `fd` is one valid pollfd for the duration of the call and
        // its descriptor stays open for the borrow of `file`.
        let ready = unsafe { libc::poll(&mut fd, 1, timeout) };
        if ready > 0 {
            return Ok(true);
        }
        if ready == 0 {
            return Ok(false);
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hold_spec_names_a_known_step_and_an_absolute_directory() {
        if cfg!(target_os = "linux") {
            assert_eq!(
                parse_spec("marker-written:/run/hold"),
                Ok(Spec {
                    step: MARKER_WRITTEN,
                    dir: PathBuf::from("/run/hold"),
                })
            );
        }
        for value in [
            "marker-written",
            "written:/run/hold",
            "marker-written:run/hold",
            "",
        ] {
            let refused = parse_spec(value).unwrap_err();
            assert!(refused.contains(ENV), "{value:?}: {refused}");
        }
    }

    #[cfg(target_os = "linux")]
    mod fifos {
        use std::io::BufRead;
        use std::sync::mpsc;
        use std::time::Duration;

        use super::*;

        fn fifo_dir() -> tempfile::TempDir {
            let dir = tempfile::TempDir::new().unwrap();
            for name in ["reached", "release"] {
                let status = std::process::Command::new("mkfifo")
                    .arg(dir.path().join(name))
                    .status()
                    .expect("mkfifo");
                assert!(status.success(), "mkfifo {name}: {status}");
            }
            dir
        }

        fn hold_on_a_thread(
            dir: &Path,
            step: Step,
            bound: Duration,
        ) -> mpsc::Receiver<io::Result<()>> {
            let (done, ended) = mpsc::channel();
            let dir = dir.to_path_buf();
            std::thread::spawn(move || {
                let _ = done.send(fifo_hold(&dir, step, Path::new("/held/entry"), bound));
            });
            ended
        }

        #[test]
        fn a_fifo_hold_reports_its_step_and_waits_for_its_release() {
            let dir = fifo_dir();
            let ended = hold_on_a_thread(dir.path(), MARKER_WRITTEN, Duration::from_secs(120));

            let mut line = String::new();
            std::io::BufReader::new(std::fs::File::open(dir.path().join("reached")).unwrap())
                .read_line(&mut line)
                .unwrap();
            assert_eq!(line, "marker-written /held/entry\n");
            assert!(
                ended.try_recv().is_err(),
                "the hold ended before its release"
            );
            std::fs::OpenOptions::new()
                .write(true)
                .open(dir.path().join("release"))
                .unwrap();

            let result = ended
                .recv_timeout(Duration::from_secs(120))
                .expect("the hold ends once its release is opened");
            result.unwrap();
        }

        #[test]
        fn a_fifo_hold_with_no_release_fails_at_its_bound_naming_itself() {
            let dir = fifo_dir();
            let ended = hold_on_a_thread(dir.path(), SOURCE_REMOVING, Duration::from_millis(300));

            let result = ended
                .recv_timeout(Duration::from_secs(120))
                .expect("an unreleased hold ends at its bound");
            let error = result.unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::TimedOut);
            let message = error.to_string();
            assert!(message.contains("source-removing"), "{message}");
            assert!(message.contains("/held/entry"), "{message}");
        }
    }
}
