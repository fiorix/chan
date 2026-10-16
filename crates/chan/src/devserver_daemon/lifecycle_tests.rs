use super::*;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

type SignalHook = Box<dyn FnMut(u32)>;

thread_local! {
    static SPAWN: RefCell<Option<Result<Child>>> = const { RefCell::new(None) };
    static SIGNAL: RefCell<Option<SignalHook>> = const { RefCell::new(None) };
    static WAIT: RefCell<Option<Box<dyn FnMut()>>> = const { RefCell::new(None) };
    static TIMEOUT: Cell<Option<Duration>> = const { Cell::new(None) };
}

const SPAWN_REACHED: &str = "test-only daemon spawn boundary reached";
const START_REFUSAL: &str = "chan devserver: a self-managed daemon is starting but has not written its pidfile yet. Retry shortly, or use --force if it is wedged.";

struct Hooks;

impl Hooks {
    fn new() -> Self {
        SPAWN.with(|hook| *hook.borrow_mut() = Some(Err(anyhow::anyhow!(SPAWN_REACHED))));
        // A missing signal expectation must never terminate the test process.
        SIGNAL.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(|pid| panic!("unexpected signal to {pid}")))
        });
        Self
    }
}

impl Drop for Hooks {
    fn drop(&mut self) {
        SPAWN.with(|hook| hook.borrow_mut().take());
        SIGNAL.with(|hook| hook.borrow_mut().take());
        WAIT.with(|hook| hook.borrow_mut().take());
        TIMEOUT.with(|hook| hook.set(None));
    }
}

pub(super) fn spawn() -> Option<Result<Child>> {
    SPAWN.with(|hook| hook.borrow_mut().take())
}

pub(super) fn signal(pid: u32) -> bool {
    SIGNAL.with(|hook| {
        if let Some(hook) = hook.borrow_mut().as_mut() {
            hook(pid);
            true
        } else {
            false
        }
    })
}

pub(super) fn wait() -> bool {
    WAIT.with(|hook| {
        if let Some(hook) = hook.borrow_mut().as_mut() {
            hook();
            true
        } else {
            false
        }
    })
}

pub(super) fn timeout(default: Duration) -> Duration {
    TIMEOUT.with(|hook| hook.get().unwrap_or(default))
}

fn held(addr: &str) -> DaemonLock {
    match DaemonLock::acquire(&daemon_lock_path(), &daemon_record_path(), addr, false).unwrap() {
        DaemonAcquire::Daemon(guard) => guard,
        DaemonAcquire::Running(_) => panic!("fixture: private daemon lock already held"),
    }
}

fn assert_spawn_untouched() {
    assert!(
        SPAWN.with(|hook| hook.borrow().is_some()),
        "spawn interception consumed"
    );
}

fn unknown_holder_message() -> String {
    let path = daemon_lock_path();
    format!("chan devserver: the daemon lock {} is held by a process that wrote no pidfile and did not release it within 15s; stop that process (on Linux, fuser {} names it) and retry.", path.display(), path.display())
}

// The spawn interception is thread-local: polling on a different runtime
// thread would bypass it and launch the test executable as a daemon.
#[tokio::test(flavor = "current_thread")]
async fn start_proceeds_after_unrecorded_lock_is_released() {
    let _env = crate::test_env::ChanTestEnv::new();
    let _hooks = Hooks::new();
    let holder = held("127.0.0.1:8787");
    std::fs::remove_file(daemon_record_path()).unwrap();
    assert!(daemon_lock_held(&daemon_lock_path()));
    let mut start = Box::pin(start_devserver_chan(
        "127.0.0.1:8787".parse().unwrap(),
        false,
        false,
        None,
    ));
    assert!(
        futures::poll!(start.as_mut()).is_pending(),
        "start did not wait for held lock"
    );
    drop(holder);
    assert!(!daemon_lock_held(&daemon_lock_path()));
    assert_eq!(start.await.unwrap_err().to_string(), SPAWN_REACHED);
}

fn known_stop_fixture() -> (Rc<Cell<usize>>, Rc<RefCell<Vec<u32>>>) {
    let holder = held("127.0.0.1:8787");
    let signals = Rc::new(RefCell::new(Vec::new()));
    let recorded = signals.clone();
    SIGNAL.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move |pid| {
            recorded.borrow_mut().push(pid);
            std::fs::remove_file(daemon_record_path()).unwrap();
            assert!(daemon_lock_held(&daemon_lock_path()));
        }))
    });
    let waits = Rc::new(Cell::new(0));
    let observed = waits.clone();
    let mut holder = Some(holder);
    WAIT.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || {
            observed.set(observed.get() + 1);
            assert!(read_daemon_record(&daemon_record_path()).is_none());
            assert!(
                daemon_lock_held(&daemon_lock_path()),
                "stop returned before release"
            );
            // Keep the holder through another probe: a record-only check at
            // the top of the next turn must not complete shutdown either.
            assert!(observed.get() <= 2);
            if observed.get() == 2 {
                drop(holder.take().expect("second wait releases the holder"));
            }
        }))
    });
    (waits, signals)
}

#[test]
fn stop_live_daemon_waits_after_signalled_record_disappears() {
    let _env = crate::test_env::ChanTestEnv::new();
    let _hooks = Hooks::new();
    let (waits, signals) = known_stop_fixture();
    stop_live_daemon(&daemon_lock_path(), &daemon_record_path(), STOP_TIMEOUT).unwrap();
    assert_eq!(
        waits.get(),
        2,
        "stop returned before the held-lock wait point"
    );
    assert_eq!(*signals.borrow(), [std::process::id()]);
    assert!(!daemon_lock_held(&daemon_lock_path()));
}

#[tokio::test(flavor = "current_thread")]
async fn stop_command_waits_after_signalled_record_disappears() {
    let _env = crate::test_env::ChanTestEnv::new();
    let _hooks = Hooks::new();
    let (waits, signals) = known_stop_fixture();
    stop_devserver_chan(false).await.unwrap();
    assert_eq!(
        waits.get(),
        2,
        "stop returned before the held-lock wait point"
    );
    assert_eq!(*signals.borrow(), [std::process::id()]);
    assert!(!daemon_lock_held(&daemon_lock_path()));
}

#[test]
fn stop_signals_a_record_published_during_its_wait_once() {
    let _env = crate::test_env::ChanTestEnv::new();
    let _hooks = Hooks::new();
    let holder = held("127.0.0.1:8787");
    let record = std::fs::read(daemon_record_path()).unwrap();
    std::fs::remove_file(daemon_record_path()).unwrap();
    let signals = Rc::new(RefCell::new(Vec::new()));
    let recorded = signals.clone();
    SIGNAL.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move |pid| recorded.borrow_mut().push(pid)))
    });
    let waits = Rc::new(Cell::new(0));
    let observed = waits.clone();
    let recorded = signals.clone();
    let mut holder = Some(holder);
    WAIT.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || {
            let turn = observed.get();
            observed.set(turn + 1);
            assert!(daemon_lock_held(&daemon_lock_path()));
            if turn == 0 {
                assert!(recorded.borrow().is_empty());
                std::fs::write(daemon_record_path(), &record).unwrap();
            } else {
                assert_eq!(
                    *recorded.borrow(),
                    [std::process::id()],
                    "appearing record must be signalled exactly once"
                );
                if turn == 2 {
                    drop(holder.take().unwrap());
                }
                assert!(turn <= 2);
            }
        }))
    });
    stop_live_daemon(&daemon_lock_path(), &daemon_record_path(), STOP_TIMEOUT).unwrap();
    assert_eq!(
        waits.get(),
        3,
        "stop returned without waiting for the holder"
    );
    assert_eq!(*signals.borrow(), [std::process::id()]);
    assert!(!daemon_lock_held(&daemon_lock_path()));
}

#[tokio::test(flavor = "current_thread")]
async fn unrecorded_holder_keeps_the_start_refusal() {
    let _env = crate::test_env::ChanTestEnv::new();
    let _hooks = Hooks::new();
    let _holder = held("127.0.0.1:8787");
    std::fs::remove_file(daemon_record_path()).unwrap();
    TIMEOUT.with(|hook| hook.set(Some(Duration::ZERO)));
    let error = start_devserver_chan("127.0.0.1:8787".parse().unwrap(), false, false, None)
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), START_REFUSAL);
    assert_spawn_untouched();
    assert!(daemon_lock_held(&daemon_lock_path()));
}

#[tokio::test(flavor = "current_thread")]
async fn record_appearing_during_start_keeps_the_rebind_refusal() {
    let _env = crate::test_env::ChanTestEnv::new();
    let _hooks = Hooks::new();
    let _holder = held("127.0.0.1:8787");
    let record = std::fs::read(daemon_record_path()).unwrap();
    std::fs::remove_file(daemon_record_path()).unwrap();
    let requested: SocketAddr = "127.0.0.1:9898".parse().unwrap();
    let mut start = Box::pin(start_devserver_chan(requested, false, false, None));
    assert!(futures::poll!(start.as_mut()).is_pending());
    std::fs::write(daemon_record_path(), record).unwrap();
    let pid = std::process::id();
    assert_eq!(start.await.unwrap_err().to_string(), format!("chan devserver: a self-managed daemon is already running on 127.0.0.1:8787 (pid {pid}); requested {requested}. To rebind, use chan devserver restart --service=chan with the options it was started with (including tunnel options), setting --bind 127.0.0.1 and --port 9898. Use chan devserver stop --service=chan to stop it, or retry with --force to replace it."));
    assert_spawn_untouched();
    assert!(daemon_lock_held(&daemon_lock_path()));
}

#[tokio::test(flavor = "current_thread")]
async fn zero_budget_start_probes_a_free_lock_before_refusing() {
    let _env = crate::test_env::ChanTestEnv::new();
    let _hooks = Hooks::new();
    TIMEOUT.with(|hook| hook.set(Some(Duration::ZERO)));
    assert!(!daemon_lock_held(&daemon_lock_path()));
    let error = start_devserver_chan("127.0.0.1:8787".parse().unwrap(), false, false, None)
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), SPAWN_REACHED);
}

#[tokio::test(flavor = "current_thread")]
async fn unrecorded_holder_stop_and_force_name_the_lock_without_signalling() {
    let _env = crate::test_env::ChanTestEnv::new();
    let _hooks = Hooks::new();
    let _holder = held("127.0.0.1:8787");
    std::fs::remove_file(daemon_record_path()).unwrap();
    TIMEOUT.with(|hook| hook.set(Some(Duration::ZERO)));
    let error = stop_devserver_chan(false).await.unwrap_err();
    assert_eq!(error.to_string(), unknown_holder_message());
    let error = start_devserver_chan("127.0.0.1:8787".parse().unwrap(), true, false, None)
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), unknown_holder_message());
    let error = restart_devserver_chan("127.0.0.1:8787".parse().unwrap(), false, false, None)
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), unknown_holder_message());
    assert_spawn_untouched();
    assert!(daemon_lock_held(&daemon_lock_path()));
}
