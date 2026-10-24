use super::*;
use crate::terminal_sessions::{arm_attach_seam, AttachSeam};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{future::Future, task::Poll, time::Duration};
use tokio_tungstenite::tungstenite::Message as ClientMessage;

type SendObserver = tokio::sync::mpsc::UnboundedSender<Option<tokio::time::Instant>>;
static SEND_OBSERVERS: std::sync::Mutex<Vec<(String, SendObserver)>> =
    std::sync::Mutex::new(Vec::new());

pub(super) fn observe_status_send(id: &str) {
    for (_, observer) in SEND_OBSERVERS
        .lock()
        .expect("send observers")
        .iter()
        .filter(|(key, _)| key == id)
    {
        let _ = observer.send(Some(tokio::time::Instant::now()));
    }
}

pub(super) fn observe_exit_wait(id: &str) {
    for (_, observer) in SEND_OBSERVERS
        .lock()
        .expect("send observers")
        .iter()
        .filter(|(key, _)| key == id)
    {
        let _ = observer.send(None);
    }
}

/// A socket's loop parked once at its top: the parked signal, then the
/// release it waits for.
type LoopGate = (
    tokio::sync::oneshot::Sender<()>,
    tokio::sync::oneshot::Receiver<()>,
);
static LOOP_GATES: std::sync::Mutex<Vec<(String, LoopGate)>> = std::sync::Mutex::new(Vec::new());

/// Park the socket of session `id` at the top of its loop, before its
/// select, when a test armed a gate for it: tell the test, then wait for the
/// release.
pub(super) async fn loop_gate(id: &str) {
    let gate = {
        let mut gates = LOOP_GATES.lock().expect("loop gates");
        let at = gates.iter().position(|(key, _)| key == id);
        at.map(|at| gates.remove(at).1)
    };
    if let Some((parked, release)) = gate {
        let _ = parked.send(());
        let _ = release.await;
    }
}

type Client =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

// Keep IO runnable while the Tokio clock is paused, so only the test advances
// the pace. The wall deadline still bounds a missing frame or fixture failure.
async fn bounded<T>(future: impl Future<Output = T>) -> T {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    tokio::pin!(future);
    loop {
        if let Poll::Ready(value) = futures::poll!(&mut future) {
            return value;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "status socket operation exceeded its wall deadline"
        );
        tokio::task::yield_now().await;
    }
}

struct Rig {
    state: Arc<AppState>,
    handle: AttachHandle,
    address: std::net::SocketAddr,
    server: tokio::task::JoinHandle<()>,
}

impl Rig {
    async fn new() -> Self {
        Self::with_command("read -r line").await
    }

    async fn with_command(command: &str) -> Self {
        Self::with_state(
            crate::state::test_support::make_test_state_with_program_status(),
            command,
        )
        .await
    }

    /// `with_command` over a prepared state.
    async fn with_state(state: Arc<AppState>, command: &str) -> Self {
        let handle = state
            .terminal_sessions
            .create(CreateOptions {
                size: pty_size(Some(80), Some(24)),
                command: Some(command.into()),
                tab_name: None,
                tab_group: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                env: BTreeMap::new(),
                profile: None,
            })
            .expect("spawn terminal");
        let app = axum::Router::new()
            .route("/api/terminal/ws", axum::routing::get(api_terminal_ws))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move { axum::serve(listener, app).await.expect("serve") });
        Self {
            state,
            handle,
            address,
            server,
        }
    }

    fn report(&self, body: &str) {
        assert!(self.state.terminal_sessions.inject_output(
            self.handle.id(),
            format!("\x1b]7501;{body}\x1b\\").as_bytes()
        ));
    }

    async fn attach(&self) -> (Client, Value) {
        let (mut client, _) = bounded(tokio_tungstenite::connect_async(format!(
            "ws://{}/api/terminal/ws?session={}",
            self.address,
            self.handle.id()
        )))
        .await
        .expect("connect");
        let mut initial = Value::Null;
        loop {
            let frame = text_frame(&mut client).await;
            match frame["type"].as_str() {
                Some("session") => initial = frame,
                Some("ready") => return (client, initial),
                _ => {}
            }
        }
    }

    fn inject_on(&self, seam: AttachSeam, body: &'static [u8]) {
        let state = self.state.clone();
        let id = self.handle.id().to_owned();
        arm_attach_seam(self.handle.id(), seam, move || {
            assert!(state.terminal_sessions.inject_output(&id, body));
        });
    }

    /// Connect a socket and read its prelude: the `session` frame and the
    /// replayed bytes up to `ready`.
    async fn attach_with_prelude(&self) -> (Client, Prelude) {
        let (mut client, _) = bounded(tokio_tungstenite::connect_async(format!(
            "ws://{}/api/terminal/ws?session={}",
            self.address,
            self.handle.id()
        )))
        .await
        .expect("connect");
        let prelude = read_prelude(&mut client).await;
        (client, prelude)
    }

    /// A subscriber of the session's current incarnation on its own thread.
    /// When `go` fires it sends the child the line it waits for, then reads
    /// events until the exit and answers with that exit and the status the
    /// session holds after it. A hook on the runtime thread can wait for the
    /// answer while the PTY's threads record the exit.
    fn exit_observer(
        &self,
    ) -> (
        std::sync::mpsc::Sender<()>,
        std::sync::mpsc::Receiver<ExitSeen>,
    ) {
        let mut observer = self
            .state
            .terminal_sessions
            .attach(self.handle.id(), None)
            .expect("observer attaches");
        let (go_tx, go_rx) = std::sync::mpsc::channel();
        let (seen_tx, seen_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if go_rx.recv_timeout(Duration::from_secs(10)).is_err() {
                return;
            }
            observer.send_input(b"\n");
            loop {
                match observer.rx.blocking_recv() {
                    Ok(SessionEvent::Exit(exit)) => {
                        let status = serde_json::to_value(&**observer.program_status().borrow())
                            .expect("final snapshot");
                        let _ = seen_tx.send((exit, status));
                        return;
                    }
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                }
            }
        });
        (go_tx, seen_rx)
    }

    /// Hold the next attach of this id before it reads the session until
    /// `exit_observer`'s child has exited and its exit event was consumed.
    fn hold_attach_until_exit_consumed(&self) -> std::sync::mpsc::Receiver<ExitSeen> {
        let (go, seen) = self.exit_observer();
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        arm_attach_seam(
            self.handle.id(),
            AttachSeam::AttachBeforeRingLock,
            move || {
                go.send(()).expect("observer waits");
                let seen = seen
                    .recv_timeout(Duration::from_secs(10))
                    .expect("the child exited and a subscriber consumed its exit");
                let _ = held_tx.send(seen);
            },
        );
        held_rx
    }
}

/// The exit a subscriber received and the status snapshot after it.
type ExitSeen = (crate::terminal_sessions::TerminalExit, Value);

struct Prelude {
    session: Value,
    replay: Vec<u8>,
}

/// The frames from the next `session` frame to `ready`, with the binary
/// frames between them joined.
async fn read_prelude(client: &mut Client) -> Prelude {
    let mut session = None;
    let mut replay = Vec::new();
    loop {
        match bounded(client.next())
            .await
            .expect("socket open")
            .expect("frame")
        {
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("JSON frame");
                match frame["type"].as_str() {
                    Some("session") => {
                        session = Some(frame);
                        replay.clear();
                    }
                    Some("ready") => {
                        return Prelude {
                            session: session.expect("session frame before ready"),
                            replay,
                        }
                    }
                    _ => {}
                }
            }
            ClientMessage::Binary(bytes) if session.is_some() => replay.extend_from_slice(&bytes),
            ClientMessage::Close(_) => panic!("socket closed before ready"),
            _ => {}
        }
    }
}

#[derive(Debug, PartialEq)]
enum SocketEnd {
    /// The server ended the socket.
    Closed,
    /// The socket was still open when it delivered the test's output fence.
    Open,
}

/// Every text frame the socket sends from here to its end. A session still
/// in the registry also gets an output fence, so a socket that stays open
/// ends the read at that event rather than at a timeout.
async fn frames_to_end(rig: &Rig, client: &mut Client) -> (Vec<Value>, SocketEnd) {
    let marker = b"__EXIT_FENCE__";
    let fenced = rig
        .state
        .terminal_sessions
        .inject_output(rig.handle.id(), marker);
    let mut frames = Vec::new();
    loop {
        match bounded(client.next()).await {
            None | Some(Err(_)) | Some(Ok(ClientMessage::Close(_))) => {
                return (frames, SocketEnd::Closed)
            }
            Some(Ok(ClientMessage::Text(text))) => {
                frames.push(serde_json::from_str(&text).expect("JSON frame"))
            }
            Some(Ok(ClientMessage::Binary(bytes))) if fenced && bytes.as_ref() == marker => {
                return (frames, SocketEnd::Open)
            }
            Some(Ok(_)) => {}
        }
    }
}

fn kinds(frames: &[Value]) -> Vec<&str> {
    frames
        .iter()
        .map(|frame| frame["type"].as_str().unwrap_or("?"))
        .collect()
}

impl Drop for Rig {
    fn drop(&mut self) {
        SEND_OBSERVERS
            .lock()
            .expect("send observers")
            .retain(|(id, _)| id != self.handle.id());
        LOOP_GATES
            .lock()
            .expect("loop gates")
            .retain(|(id, _)| id != self.handle.id());
        self.server.abort();
        self.state
            .terminal_sessions
            .close(self.handle.id(), CloseReason::Explicit);
        self.state.terminal_sessions.remove(self.handle.id());
    }
}

async fn text_frame(client: &mut Client) -> Value {
    loop {
        match bounded(client.next())
            .await
            .expect("socket open")
            .expect("frame")
        {
            ClientMessage::Text(text) => return serde_json::from_str(&text).expect("JSON frame"),
            ClientMessage::Close(_) => panic!("socket closed before expected status"),
            _ => {}
        }
    }
}

async fn status_frame(client: &mut Client) -> Value {
    loop {
        let frame = text_frame(client).await;
        if frame["type"] == "program-status" {
            return frame;
        }
        assert_ne!(frame["type"], "exit", "final status must precede exit");
    }
}

#[tokio::test(start_paused = true)]
async fn sockets_share_status_and_late_attach_gets_the_retained_value() {
    let rig = Rig::new().await;
    let (mut first, initial) = rig.attach().await;
    assert_eq!(
        initial["program_status"],
        json!({"revision":0,"records":[]})
    );
    let (mut second, _) = rig.attach().await;
    rig.report("state=blocked:kind=permission:progress=40:msg=dGV4dA==");
    tokio::time::advance(Duration::from_millis(150)).await;
    let one = status_frame(&mut first).await;
    let two = status_frame(&mut second).await;
    assert_eq!(one, two, "each socket receives the same retained value");
    assert_eq!(one["program_status"]["records"][0]["msg"], "text");
    let (_late, prelude) = rig.attach().await;
    assert_eq!(
        prelude["program_status"], one["program_status"],
        "late attach needs no new report"
    );
}

#[tokio::test(start_paused = true)]
async fn attach_status_is_coherent_on_both_sides_of_the_output_lock() {
    for seam in [
        AttachSeam::AttachBeforeRingLock,
        AttachSeam::AttachAfterRingLock,
    ] {
        let rig = Rig::new().await;
        rig.report("state=working");
        rig.inject_on(seam, b"\x1b]7501;state=blocked\x07");
        let (mut client, prelude) = rig.attach().await;
        let revision = prelude["program_status"]["revision"]
            .as_u64()
            .expect("attach revision");
        match seam {
            AttachSeam::AttachBeforeRingLock => {
                assert_eq!(revision, 2, "report before snapshot belongs in attach")
            }
            AttachSeam::AttachAfterRingLock => {
                assert_eq!(revision, 1, "snapshot and subscription share the ring lock");
                tokio::time::advance(Duration::from_millis(150)).await;
                let later = status_frame(&mut client).await;
                assert_eq!(
                    later["program_status"]["revision"], 2,
                    "racing publication stays pending"
                );
            }
            _ => unreachable!(),
        }
    }
}

// An output fence is an acknowledgement from the same biased socket loop.
// It lets absence checks finish on an event, rather than an elapsed timeout.
async fn fence(rig: &Rig, client: &mut Client) -> Vec<Value> {
    let marker = b"__STATUS_FENCE__";
    assert!(rig
        .state
        .terminal_sessions
        .inject_output(rig.handle.id(), marker));
    let mut frames = Vec::new();
    loop {
        match bounded(client.next()).await.expect("open").expect("frame") {
            ClientMessage::Text(text) => frames.push(serde_json::from_str(&text).expect("JSON")),
            ClientMessage::Binary(bytes) if bytes.as_ref() == marker => return frames,
            ClientMessage::Close(_) => panic!("closed before fence"),
            _ => {}
        }
    }
}

fn statuses(frames: &[Value]) -> Vec<&Value> {
    frames
        .iter()
        .filter(|frame| frame["type"] == "program-status")
        .collect()
}

#[tokio::test(start_paused = true)]
async fn status_pace_coalesces_floods_without_starvation_or_clean_ticks() {
    let rig = Rig::new().await;
    let (mut client, _) = rig.attach().await;
    let mut previous = tokio::time::Instant::now();
    for interval in 1..=5 {
        rig.report("state=working:progress=0");
        assert!(
            statuses(&fence(&rig, &mut client).await).is_empty(),
            "status sent before the interval ended"
        );
        for progress in 1..100 {
            rig.report(&format!("state=working:progress={progress}"));
        }
        tokio::time::advance(Duration::from_millis(149)).await;
        assert!(
            statuses(&fence(&rig, &mut client).await).is_empty(),
            "status sent before the interval ended"
        );
        tokio::time::advance(Duration::from_millis(1)).await;
        let frames = fence(&rig, &mut client).await;
        let updates = statuses(&frames);
        assert_eq!(
            updates.len(),
            1,
            "exactly one latest frame is due despite ready output: {frames:?}"
        );
        assert_eq!(updates[0]["program_status"]["revision"], interval * 100);
        assert_eq!(updates[0]["program_status"]["records"][0]["progress"], 99);
        let now = tokio::time::Instant::now();
        assert!(now - previous >= Duration::from_millis(150));
        previous = now;
    }
    tokio::time::advance(Duration::from_secs(1)).await;
    assert!(
        statuses(&fence(&rig, &mut client).await).is_empty(),
        "a clean watch must not send periodic frames"
    );
}

#[tokio::test(start_paused = true)]
async fn output_lag_keeps_the_latest_status_without_a_further_report() {
    let rig = Rig::new().await;
    let state = rig.state.clone();
    let id = rig.handle.id().to_owned();
    arm_attach_seam(
        rig.handle.id(),
        AttachSeam::AttachAfterRingLock,
        move || {
            assert!(state
                .terminal_sessions
                .inject_output(&id, b"\x1b]7501;state=blocked\x07"));
            for _ in 0..1100 {
                assert!(state.terminal_sessions.inject_output(&id, b"x"));
            }
        },
    );
    let (mut client, initial) = rig.attach().await;
    assert_eq!(initial["program_status"]["revision"], 0);
    tokio::time::advance(Duration::from_millis(150)).await;
    let frames = fence(&rig, &mut client).await;
    assert!(
        frames.iter().any(|frame| frame["type"] == "error"
            && frame["message"]
                .as_str()
                .is_some_and(|s| s.contains("lagged"))),
        "fixture must force broadcast lag"
    );
    let updates = statuses(&frames);
    assert_eq!(updates.len(), 1, "watch update survives output lag");
    assert_eq!(
        updates[0]["program_status"]["records"][0]["state"],
        "blocked"
    );
}

#[tokio::test(start_paused = true)]
async fn focus_racing_a_report_preserves_the_newer_seen_revision() {
    let rig = Rig::new().await;
    let (mut client, _) = rig.attach().await;
    rig.report("state=working");
    tokio::time::advance(Duration::from_millis(150)).await;
    assert_eq!(
        status_frame(&mut client).await["program_status"]["revision"],
        1
    );
    rig.inject_on(AttachSeam::FocusBeforeRingLock, b"\x1b]7501;state=done\x07");
    bounded(client.send(ClientMessage::text(
        json!({"type":"focus","focused":true}).to_string(),
    )))
    .await
    .expect("focus");
    loop {
        if text_frame(&mut client).await["type"] == "activity" {
            break;
        }
    }
    tokio::time::advance(Duration::from_millis(150)).await;
    let frame = status_frame(&mut client).await;
    assert_eq!(
        frame["program_status"]["revision"], 3,
        "seen follows the admitted report"
    );
    assert_eq!(frame["program_status"]["records"][0]["seen"], true);
    assert!(
        statuses(&fence(&rig, &mut client).await).is_empty(),
        "no older publication follows the newer one"
    );
}

#[tokio::test(start_paused = true)]
async fn restart_replaces_status_receiver_generation_and_pending_deadline() {
    let rig = Rig::new().await;
    let (mut client, initial) = rig.attach().await;
    rig.report("state=blocked");
    assert!(statuses(&fence(&rig, &mut client).await).is_empty());
    tokio::time::advance(Duration::from_millis(100)).await;
    rig.state
        .terminal_sessions
        .restart(rig.handle.id(), RestartOverrides::default())
        .expect("restart");
    let new_session = loop {
        let frame = text_frame(&mut client).await;
        if frame["type"] == "session" {
            break frame;
        }
    };
    while text_frame(&mut client).await["type"] != "ready" {}
    assert!(new_session["generation"].as_u64().unwrap() > initial["generation"].as_u64().unwrap());
    assert_eq!(
        new_session["program_status"],
        json!({"revision":0,"records":[]}),
        "replacement starts empty"
    );
    rig.report("state=working:progress=42");
    tokio::time::advance(Duration::from_millis(149)).await;
    assert!(
        statuses(&fence(&rig, &mut client).await).is_empty(),
        "restart starts a new pace interval"
    );
    tokio::time::advance(Duration::from_millis(1)).await;
    let frame = status_frame(&mut client).await;
    assert_eq!(
        frame["generation"], new_session["generation"],
        "new receiver uses replacement generation"
    );
    assert_eq!(
        frame["program_status"]["records"][0]["progress"], 42,
        "old receiver cannot supply new status"
    );
}

#[tokio::test(start_paused = true)]
async fn final_status_is_paced_and_precedes_exit_for_retained_and_empty_sets() {
    for retained_count in [0, 1, 2] {
        let mut rig = Rig::new().await;
        let (send_tx, mut sends) = tokio::sync::mpsc::unbounded_channel();
        SEND_OBSERVERS
            .lock()
            .expect("send observers")
            .push((rig.handle.id().to_owned(), send_tx));
        let (mut client, _) = rig.attach().await;
        rig.report(if retained_count > 0 {
            "state=done"
        } else {
            "state=working"
        });
        tokio::time::advance(Duration::from_millis(150)).await;
        let before = status_frame(&mut client).await;
        let first_sent = bounded(sends.recv())
            .await
            .expect("first send observation")
            .expect("sent");
        if retained_count == 2 {
            rig.report("state=error:id=last");
        }
        // Exit after a frame, inside its next pace interval. The actual child
        // exits and the existing registry event acknowledges finalization.
        rig.handle.send_input(b"\n");
        loop {
            if matches!(
                bounded(rig.handle.rx.recv()).await.expect("event"),
                SessionEvent::Exit(_)
            ) {
                break;
            }
        }
        let expected =
            serde_json::to_value(&**rig.handle.program_status().borrow()).expect("final snapshot");
        assert_eq!(
            bounded(sends.recv()).await.expect("socket reached exit"),
            None
        );
        tokio::time::advance(Duration::from_millis(150)).await;
        let final_frame = loop {
            let frame = text_frame(&mut client).await;
            if matches!(frame["type"].as_str(), Some("program-status" | "exit")) {
                break frame;
            }
        };
        assert_eq!(
            final_frame["type"], "program-status",
            "final status must precede exit"
        );
        let final_sent = bounded(sends.recv())
            .await
            .expect("final send observation")
            .expect("sent");
        assert!(
            final_sent - first_sent >= Duration::from_millis(150),
            "final frame bypassed the interval"
        );
        assert_eq!(
            final_frame["program_status"], expected,
            "finalized value before exit"
        );
        assert_eq!(
            final_frame["program_status"]["records"]
                .as_array()
                .unwrap()
                .len(),
            retained_count
        );
        assert!(
            final_frame["program_status"]["revision"].as_u64().unwrap()
                >= before["program_status"]["revision"].as_u64().unwrap()
        );
        assert_eq!(text_frame(&mut client).await["type"], "exit");
    }
}

/// A child that prints a marker and exits with status 0 once it reads a line.
const MARKED_CHILD: &str = "printf 'EXIT_PIN_MARK\\n'; read -r line";

/// Assert what a socket that attached to an exited incarnation sends after
/// `ready`: the final status, then one `exit` with the child's code, then its
/// end. `seeded` is the status before the exit, which finalization changes.
fn assert_stored_exit_reported(
    prelude: &Prelude,
    frames: &[Value],
    end: SocketEnd,
    (exit, status): &ExitSeen,
    seeded: &Value,
) {
    assert_eq!(
        *exit,
        crate::terminal_sessions::TerminalExit::Code { code: 0 }
    );
    assert_ne!(status, seeded, "finalization changes the seeded status");
    assert!(
        String::from_utf8_lossy(&prelude.replay).contains("EXIT_PIN_MARK"),
        "the replay holds the child's output: {:?}",
        String::from_utf8_lossy(&prelude.replay)
    );
    assert_eq!(
        (kinds(frames), end),
        (vec!["program-status", "exit"], SocketEnd::Closed),
        "after ready: the final status, one exit, the socket's end: {frames:?}"
    );
    assert_eq!(
        frames[0]["program_status"], *status,
        "final status before exit"
    );
    assert_eq!(frames[1], json!({"type": "exit", "code": 0}));
}

// The attach has found the session and is about to read it when the child
// exits and another subscriber consumes the exit event.
#[tokio::test(start_paused = true)]
async fn an_attach_that_reads_the_session_after_its_exit_reports_the_stored_exit() {
    let rig = Rig::with_command(MARKED_CHILD).await;
    rig.report("state=working");
    let seeded = serde_json::to_value(&**rig.handle.program_status().borrow()).unwrap();
    let held = rig.hold_attach_until_exit_consumed();
    let (mut client, prelude) = rig.attach_with_prelude().await;
    let seen = held
        .try_recv()
        .expect("the attach was held across the exit");
    assert_eq!(prelude.session["program_status"], seen.1);
    tokio::time::advance(Duration::from_millis(150)).await;
    let (frames, end) = frames_to_end(&rig, &mut client).await;
    assert_stored_exit_reported(&prelude, &frames, end, &seen, &seeded);
    assert_eq!(
        rig.state.terminal_sessions.attach_count(rig.handle.id()),
        None,
        "the socket that reports the exit removes the session"
    );
}

// The attach runs after the exit is recorded and before it is broadcast, so
// it finds the stored exit and its subscription also receives the event.
#[tokio::test(start_paused = true)]
async fn an_attach_between_the_exit_record_and_its_broadcast_reports_one_exit() {
    let mut rig = Rig::with_command(MARKED_CHILD).await;
    rig.report("state=working");
    let seeded = serde_json::to_value(&**rig.handle.program_status().borrow()).unwrap();
    let (readable_tx, mut readable_rx) = tokio::sync::mpsc::unbounded_channel();
    let (attached_tx, attached_rx) = std::sync::mpsc::channel::<()>();
    arm_attach_seam(rig.handle.id(), AttachSeam::ExitReadable, move || {
        let _ = readable_tx.send(());
        attached_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the socket subscribed while the exit was unbroadcast");
    });
    rig.handle.send_input(b"\n");
    bounded(readable_rx.recv())
        .await
        .expect("the exit became readable");
    arm_attach_seam(
        rig.handle.id(),
        AttachSeam::AttachAfterRingLock,
        move || {
            let _ = attached_tx.send(());
        },
    );
    let (mut client, prelude) = rig.attach_with_prelude().await;
    let exit = loop {
        if let SessionEvent::Exit(exit) = bounded(rig.handle.rx.recv()).await.expect("event") {
            break exit;
        }
    };
    let status = serde_json::to_value(&**rig.handle.program_status().borrow()).unwrap();
    tokio::time::advance(Duration::from_millis(150)).await;
    let (frames, end) = frames_to_end(&rig, &mut client).await;
    assert_stored_exit_reported(&prelude, &frames, end, &(exit, status), &seeded);
}

// The control: an attach before the exit reports it through the live event.
#[tokio::test(start_paused = true)]
async fn an_attach_before_the_exit_reports_one_live_exit() {
    let mut rig = Rig::with_command(MARKED_CHILD).await;
    rig.report("state=working");
    let seeded = serde_json::to_value(&**rig.handle.program_status().borrow()).unwrap();
    let (mut client, prelude) = rig.attach_with_prelude().await;
    assert_eq!(prelude.session["program_status"], seeded);
    rig.handle.send_input(b"\n");
    let exit = loop {
        if let SessionEvent::Exit(exit) = bounded(rig.handle.rx.recv()).await.expect("event") {
            break exit;
        }
    };
    assert_eq!(
        exit,
        crate::terminal_sessions::TerminalExit::Code { code: 0 }
    );
    let status = serde_json::to_value(&**rig.handle.program_status().borrow()).unwrap();
    assert_ne!(status, seeded, "finalization changes the seeded status");
    tokio::time::advance(Duration::from_millis(150)).await;
    let (frames, end) = frames_to_end(&rig, &mut client).await;
    let ending: Vec<&Value> = frames
        .iter()
        .filter(|frame| matches!(frame["type"].as_str(), Some("program-status" | "exit")))
        .collect();
    assert_eq!(
        end,
        SocketEnd::Closed,
        "the exit ends the socket: {frames:?}"
    );
    assert_eq!(
        kinds(&frames).last(),
        Some(&"exit"),
        "exit is the last frame"
    );
    assert_eq!(
        kinds(&frames)
            .iter()
            .filter(|kind| **kind == "exit")
            .count(),
        1,
        "one exit: {frames:?}"
    );
    let [.., last_status, exit_frame] = ending.as_slice() else {
        panic!("a final status and an exit: {frames:?}");
    };
    assert_eq!(
        last_status["program_status"], status,
        "final status before exit"
    );
    assert_eq!(**exit_frame, json!({"type": "exit", "code": 0}));
}

// A restart in place moves the socket to the new incarnation, whose child
// exits, and has its exit consumed, before the socket's reattach reads it.
#[tokio::test(start_paused = true)]
async fn a_restart_reattach_to_an_exited_incarnation_reports_its_stored_exit() {
    let rig = Rig::with_command(MARKED_CHILD).await;
    let (mut client, initial) = rig.attach_with_prelude().await;
    assert!(rig
        .state
        .terminal_sessions
        .restart(rig.handle.id(), RestartOverrides::default())
        .expect("restart"));
    rig.report("state=working");
    let seeded = serde_json::to_value(
        &**rig
            .state
            .terminal_sessions
            .attach(rig.handle.id(), None)
            .expect("replacement")
            .program_status()
            .borrow(),
    )
    .unwrap();
    let held = rig.hold_attach_until_exit_consumed();
    let prelude = read_prelude(&mut client).await;
    let seen = held
        .try_recv()
        .expect("the reattach was held across the exit");
    assert!(
        prelude.session["generation"].as_u64() > initial.session["generation"].as_u64(),
        "the socket moved to the replacement"
    );
    tokio::time::advance(Duration::from_millis(150)).await;
    let (frames, end) = frames_to_end(&rig, &mut client).await;
    assert_stored_exit_reported(&prelude, &frames, end, &seen, &seeded);
}

#[test]
fn program_status_wire_tag_generation_sources_and_nulls() {
    use crate::terminal_sessions::{ProgramState, ProgramStatusRecord, ProgramStatusSource};
    let empty = ServerFrame::ProgramStatus {
        id: "s1".into(),
        generation: 3,
        program_status: Arc::new(ProgramStatusSnapshot {
            revision: 13,
            records: vec![],
        }),
    };
    assert_eq!(
        serde_json::to_string(&empty).unwrap(),
        r#"{"type":"program-status","id":"s1","generation":3,"program_status":{"revision":13,"records":[]}}"#
    );
    for (source, tag) in [
        (ProgramStatusSource::Program, "program"),
        (ProgramStatusSource::Chan, "chan"),
    ] {
        let frame = ServerFrame::ProgramStatus {
            id: "s1".into(),
            generation: 3,
            program_status: Arc::new(ProgramStatusSnapshot {
                revision: 1,
                records: vec![ProgramStatusRecord {
                    source,
                    id: None,
                    state: ProgramState::Working,
                    kind: None,
                    progress: Some(0),
                    app: None,
                    title: None,
                    msg: None,
                    seen: false,
                    update_order: 1,
                }],
            }),
        };
        let expected = format!(
            r#"{{"type":"program-status","id":"s1","generation":3,"program_status":{{"revision":1,"records":[{{"source":"{tag}","id":null,"state":"working","kind":null,"progress":0,"app":null,"title":null,"msg":null,"seen":false,"update_order":1}}]}}}}"#
        );
        assert_eq!(serde_json::to_string(&frame).unwrap(), expected);
    }
}

/// How a socket's transport ended, after the frames it delivered.
#[derive(Debug, PartialEq)]
enum TransportEnd {
    /// A Close frame with this code, then the connection's orderly end.
    Clean(Option<u16>),
    /// The stream ended or failed before a Close frame.
    NoClose(Failure),
    /// A Close frame, then a failed write or read.
    FailedAfterClose(Option<u16>, Failure),
}

/// How a read or write failed, by the error's kind, so the reader means the
/// same thing on every platform.
#[derive(Debug, PartialEq)]
enum Failure {
    /// The peer reset the connection.
    Reset,
    /// Any other end or failure, by its message.
    Other(String),
}

impl Failure {
    fn of_io(error: &std::io::Error) -> Self {
        if error.kind() == std::io::ErrorKind::ConnectionReset {
            Self::Reset
        } else {
            Self::Other(error.to_string())
        }
    }

    fn of_ws(error: &tokio_tungstenite::tungstenite::Error) -> Self {
        match error {
            tokio_tungstenite::tungstenite::Error::Io(error) => Self::of_io(error),
            error => Self::Other(error.to_string()),
        }
    }
}

/// What a socket delivered after `ready`: the kinds of its text frames, the
/// bytes of its binary frames, and how its transport ended.
struct Tail {
    kinds: Vec<String>,
    live_bytes: u64,
    end: TransportEnd,
}

/// Read a socket to its transport's end. Unlike `frames_to_end`, a reset is
/// not an end like a Close frame.
async fn read_to_transport_end(client: &mut Client) -> Tail {
    let mut kinds = Vec::new();
    let mut live_bytes = 0;
    loop {
        let end = match bounded(client.next()).await {
            None => TransportEnd::NoClose(Failure::Other("end".into())),
            Some(Err(e)) => TransportEnd::NoClose(Failure::of_ws(&e)),
            Some(Ok(ClientMessage::Close(frame))) => {
                tcp_end(client, frame.map(|frame| u16::from(frame.code))).await
            }
            Some(Ok(ClientMessage::Text(text))) => {
                let frame: Value = serde_json::from_str(&text).expect("JSON frame");
                kinds.push(frame["type"].as_str().unwrap_or("?").to_owned());
                continue;
            }
            Some(Ok(ClientMessage::Binary(bytes))) => {
                live_bytes += bytes.len() as u64;
                continue;
            }
            Some(Ok(_)) => continue,
        };
        return Tail {
            kinds,
            live_bytes,
            end,
        };
    }
}

/// A client Close (1000), masked with a zero key as a client frame must be.
const CLIENT_CLOSE_FRAME: [u8; 8] = [0x88, 0x82, 0, 0, 0, 0, 0x03, 0xe8];

/// How the connection under `client` ends after the server's Close. The
/// reply goes on the connection itself and the end is read there: once the
/// client library holds a Close it reports a reset as the stream's end.
async fn tcp_end(client: &mut Client, code: Option<u16>) -> TransportEnd {
    let tokio_tungstenite::MaybeTlsStream::Plain(tcp) = client.get_mut() else {
        panic!("a plain TCP client");
    };
    if let Err(e) = bounded(tokio::io::AsyncWriteExt::write_all(
        tcp,
        &CLIENT_CLOSE_FRAME,
    ))
    .await
    {
        return TransportEnd::FailedAfterClose(code, Failure::of_io(&e));
    }
    let mut byte = [0u8; 1];
    match bounded(tokio::io::AsyncReadExt::read(tcp, &mut byte)).await {
        Ok(0) => TransportEnd::Clean(code),
        Ok(_) => panic!("bytes after the Close"),
        Err(e) => TransportEnd::FailedAfterClose(code, Failure::of_io(&e)),
    }
}

/// How a scripted peer ends the connection, for the reader's own controls.
#[derive(Clone, Copy, Debug)]
enum ScriptedEnd {
    Reset,
    CloseThenReset,
    CloseThenFin,
}

/// The transport end `read_to_transport_end` reads from a peer that ends as
/// `script` says, once the client is connected.
async fn scripted_transport_end(script: ScriptedEnd) -> TransportEnd {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address = listener.local_addr().expect("address");
    let (go_tx, go_rx) = tokio::sync::oneshot::channel::<()>();
    let peer = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.expect("accept");
        let mut ws = tokio_tungstenite::accept_async(tcp)
            .await
            .expect("handshake");
        go_rx.await.expect("the client is connected");
        if !matches!(script, ScriptedEnd::Reset) {
            ws.send(ClientMessage::Close(None))
                .await
                .expect("send Close");
            // The client's Close, read whole, so a reset below follows it.
            while let Some(Ok(message)) = ws.next().await {
                if message.is_close() {
                    break;
                }
            }
        }
        if !matches!(script, ScriptedEnd::CloseThenFin) {
            ws.get_ref().set_zero_linger().expect("zero linger");
        }
    });
    let (mut client, _) = bounded(tokio_tungstenite::connect_async(format!("ws://{address}/")))
        .await
        .expect("connect");
    go_tx.send(()).expect("the peer waits");
    let tail = read_to_transport_end(&mut client).await;
    bounded(peer).await.expect("scripted peer");
    tail.end
}

// The reader's own controls: a reset before any Close, a reset after the
// Close exchange, and an orderly end after it, on a peer the test scripts.
#[tokio::test]
async fn the_transport_reader_tells_a_reset_from_an_orderly_end() {
    let ends = [
        scripted_transport_end(ScriptedEnd::Reset).await,
        scripted_transport_end(ScriptedEnd::CloseThenReset).await,
        scripted_transport_end(ScriptedEnd::CloseThenFin).await,
    ];
    assert_eq!(
        ends,
        [
            TransportEnd::NoClose(Failure::Reset),
            TransportEnd::FailedAfterClose(None, Failure::Reset),
            TransportEnd::Clean(None),
        ],
        "a reset before any Close, a reset after the Close, an orderly end"
    );
}

/// The frame the page's terminal socket sends when it opens.
fn focus_frame() -> ClientMessage {
    ClientMessage::text(json!({ "type": "focus", "focused": true }).to_string())
}

/// What a redial naming the session gets, given its query after the id: the
/// first text frame (a `session` frame reduced to whether it keeps the id),
/// what follows an `exit`, and the registry's size.
async fn redial(rig: &Rig, query: &str) -> (Value, Option<(Vec<String>, TransportEnd)>, usize) {
    let (mut client, _) = bounded(tokio_tungstenite::connect_async(format!(
        "ws://{}/api/terminal/ws?session={}{query}",
        rig.address,
        rig.handle.id()
    )))
    .await
    .expect("redial");
    let first = loop {
        match bounded(client.next()).await {
            Some(Ok(ClientMessage::Text(text))) => {
                break serde_json::from_str::<Value>(&text).expect("JSON frame")
            }
            Some(Ok(_)) => {}
            other => panic!("the redial ended before a text frame: {other:?}"),
        }
    };
    if first["type"] == "session" {
        let same_id = first["id"].as_str() == Some(rig.handle.id());
        return (
            json!({"type": "session", "same_id": same_id}),
            None,
            rig.state.terminal_sessions.len(),
        );
    }
    let rest = if first["type"] == "exit" {
        let tail = read_to_transport_end(&mut client).await;
        Some((tail.kinds, tail.end))
    } else {
        None
    };
    (first, rest, rig.state.terminal_sessions.len())
}

/// The page's redial after a socket ended without `exit`: the cursor is the
/// `session` frame's `seq` plus the binary bytes received after `ready`, with
/// the generation, and there is no command.
fn page_redial_query(prelude: &Prelude, tail: &Tail) -> String {
    let seq = prelude.session["seq"].as_u64().expect("seq");
    let generation = prelude.session["generation"].as_u64().expect("generation");
    format!("&since={}&generation={generation}", seq + tail.live_bytes)
}

/// A redial naming an exited and removed session: its exit alone, a clean
/// close, and no session made.
fn exit_answer() -> (Value, Option<(Vec<String>, TransportEnd)>, usize) {
    (
        json!({"type": "exit", "code": 0}),
        Some((Vec::new(), TransportEnd::Clean(Some(1000)))),
        0,
    )
}

/// The first socket's end: its final status, one exit, a clean close.
fn exit_end() -> (Vec<String>, TransportEnd) {
    (
        vec!["program-status".to_owned(), "exit".to_owned()],
        TransportEnd::Clean(Some(1000)),
    )
}

// The child exits while the socket is attached, and the client sends a frame
// after the socket stopped reading, as the page's `focus` can land: the
// server ends the socket with that frame unread.
#[tokio::test(start_paused = true)]
async fn a_live_exit_with_an_unread_client_frame_ends_cleanly_and_its_redial_gets_the_exit() {
    let rig = Rig::with_command(MARKED_CHILD).await;
    let (send_tx, mut sends) = tokio::sync::mpsc::unbounded_channel();
    SEND_OBSERVERS
        .lock()
        .expect("send observers")
        .push((rig.handle.id().to_owned(), send_tx));
    let (mut client, prelude) = rig.attach_with_prelude().await;
    rig.handle.send_input(b"\n");
    assert_eq!(
        bounded(sends.recv())
            .await
            .expect("the socket reached its exit"),
        None
    );
    bounded(client.send(focus_frame()))
        .await
        .expect("send focus");
    tokio::time::advance(Duration::from_millis(150)).await;
    let tail = read_to_transport_end(&mut client).await;
    // The live loop forwards the session's other frames after `ready`; the
    // end of the socket is its final status and exit.
    let ending: Vec<String> = tail
        .kinds
        .iter()
        .filter(|kind| matches!(kind.as_str(), "program-status" | "exit"))
        .cloned()
        .collect();
    let redialed = redial(&rig, &page_redial_query(&prelude, &tail)).await;
    assert_eq!(
        ((ending, tail.end), redialed),
        (exit_end(), exit_answer()),
        "the first socket: final status, exit, clean close; the redial: the exit alone"
    );
}

// The child exits before any socket attaches; the socket sends its `focus`
// at once, as the page does, and the attach finds the recorded exit. Every
// redial naming the id gets the exit alone, whatever cursor and generation
// it carries.
#[tokio::test(start_paused = true)]
async fn an_attach_after_the_exit_with_an_unread_client_frame_ends_cleanly_and_its_redial_gets_the_exit(
) {
    let mut rig = Rig::with_command(MARKED_CHILD).await;
    rig.handle.send_input(b"\n");
    loop {
        if let SessionEvent::Exit(_) = bounded(rig.handle.rx.recv()).await.expect("event") {
            break;
        }
    }
    let (mut client, _) = bounded(tokio_tungstenite::connect_async(format!(
        "ws://{}/api/terminal/ws?session={}",
        rig.address,
        rig.handle.id()
    )))
    .await
    .expect("connect");
    bounded(client.send(focus_frame()))
        .await
        .expect("send focus");
    let prelude = read_prelude(&mut client).await;
    tokio::time::advance(Duration::from_millis(150)).await;
    let tail = read_to_transport_end(&mut client).await;
    let seq = prelude.session["seq"].as_u64().expect("seq");
    let generation = prelude.session["generation"].as_u64().expect("generation");
    let queries = [
        page_redial_query(&prelude, &tail),
        format!("&since=0&generation={generation}"),
        format!("&since={}&generation={generation}", seq + 4096),
        format!("&since={seq}&generation={}", generation + 1),
        format!("&since={seq}"),
    ];
    let mut redials = Vec::new();
    for query in &queries {
        redials.push(redial(&rig, query).await);
    }
    assert_eq!(
        ((tail.kinds, tail.end), redials),
        (
            exit_end(),
            std::iter::repeat_with(exit_answer)
                .take(queries.len())
                .collect::<Vec<_>>()
        ),
        "the first socket: final status, exit, clean close; each redial \
         ({queries:?}): the exit alone"
    );
}

// The server shuts down while a frame of the client's is unread: the socket
// is parked before its first select, the client's `focus` is sent and the
// shutdown signalled, then the socket is released.
#[tokio::test(start_paused = true)]
async fn a_shutdown_with_an_unread_client_frame_ends_with_a_clean_close() {
    let mut state = crate::state::test_support::make_test_state_with_program_status();
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    Arc::get_mut(&mut state)
        .expect("an unshared test state")
        .shutdown_rx = shutdown_rx;
    let rig = Rig::with_state(state, MARKED_CHILD).await;
    let (parked_tx, parked) = tokio::sync::oneshot::channel();
    let (release, release_rx) = tokio::sync::oneshot::channel();
    LOOP_GATES
        .lock()
        .expect("loop gates")
        .push((rig.handle.id().to_owned(), (parked_tx, release_rx)));
    let (mut client, _) = rig.attach_with_prelude().await;
    bounded(parked)
        .await
        .expect("the socket parks before its first select");
    bounded(client.send(focus_frame()))
        .await
        .expect("send focus");
    shutdown_tx.send(true).expect("the server holds a receiver");
    release.send(()).expect("the socket waits for its release");
    let tail = read_to_transport_end(&mut client).await;
    assert_eq!(
        tail.end,
        TransportEnd::Clean(Some(1001)),
        "the shutdown's Close, then a clean end"
    );
}

/// A peer that records what it is sent and never sends anything, or sends
/// a Close at once when `answers`.
struct ScriptedPeer {
    sent: Arc<std::sync::Mutex<Vec<Message>>>,
    answers: bool,
}

impl futures::Sink<Message> for ScriptedPeer {
    type Error = std::convert::Infallible;

    fn poll_ready(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn start_send(self: std::pin::Pin<&mut Self>, message: Message) -> Result<(), Self::Error> {
        self.sent.lock().expect("sent").push(message);
        Ok(())
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn poll_close(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
}

impl futures::Stream for ScriptedPeer {
    type Item = Result<Message, std::convert::Infallible>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
    ) -> Poll<Option<Self::Item>> {
        if std::mem::take(&mut self.answers) {
            Poll::Ready(Some(Ok(Message::Close(None))))
        } else {
            Poll::Pending
        }
    }
}

// The helper's drain waits for the peer's Close until its bound and no
// longer, and ends at once when the peer answers.
#[tokio::test(start_paused = true)]
async fn finish_socket_drains_until_the_peers_close_or_its_bound() {
    let sent = Arc::new(std::sync::Mutex::new(Vec::new()));
    let finish = finish_socket(
        ScriptedPeer {
            sent: sent.clone(),
            answers: false,
        },
        1000,
        "exit".into(),
    );
    tokio::pin!(finish);
    assert!(
        futures::poll!(&mut finish).is_pending(),
        "the helper waits for the peer's Close"
    );
    assert_eq!(
        *sent.lock().expect("sent"),
        vec![Message::Close(Some(CloseFrame {
            code: 1000,
            reason: "exit".into()
        }))]
    );
    tokio::time::advance(FINISH_DRAIN_BOUND - Duration::from_millis(1)).await;
    assert!(
        futures::poll!(&mut finish).is_pending(),
        "the helper still waits before its bound"
    );
    tokio::time::advance(Duration::from_millis(2)).await;
    assert!(
        futures::poll!(&mut finish).is_ready(),
        "the helper ends at its bound"
    );
    let answered = finish_socket(
        ScriptedPeer {
            sent: Arc::default(),
            answers: true,
        },
        1000,
        "exit".into(),
    );
    tokio::pin!(answered);
    assert!(
        futures::poll!(&mut answered).is_ready(),
        "the helper ends when the peer answers"
    );
}

// A client that never answers the server's Close, on the wire: the server
// holds the connection open, then ends it in order once the bound passes.
#[tokio::test(start_paused = true)]
async fn a_peer_that_never_answers_the_close_is_dropped_at_the_drain_bound() {
    let mut rig = Rig::with_command(MARKED_CHILD).await;
    rig.handle.send_input(b"\n");
    loop {
        if let SessionEvent::Exit(_) = bounded(rig.handle.rx.recv()).await.expect("event") {
            break;
        }
    }
    let (mut client, _) = rig.attach_with_prelude().await;
    tokio::time::advance(Duration::from_millis(150)).await;
    // Read up to the server's Close without answering it: the client's reply
    // waits until the stream is polled again, which this test does not do.
    let mut kinds = Vec::new();
    let close = loop {
        match bounded(client.next()).await {
            Some(Ok(ClientMessage::Text(text))) => {
                let frame: Value = serde_json::from_str(&text).expect("JSON frame");
                kinds.push(frame["type"].as_str().unwrap_or("?").to_owned());
            }
            Some(Ok(ClientMessage::Close(frame))) => {
                break frame.map(|frame| u16::from(frame.code))
            }
            Some(Ok(_)) => {}
            other => panic!("the socket ended before a Close, after {kinds:?}: {other:?}"),
        }
    };
    assert_eq!(
        (kinds, close),
        (
            vec!["program-status".to_owned(), "exit".to_owned()],
            Some(1000)
        )
    );
    let tokio_tungstenite::MaybeTlsStream::Plain(tcp) = client.get_mut() else {
        panic!("a plain TCP client");
    };
    let mut byte = [0u8; 1];
    assert!(
        matches!(tcp.try_read(&mut byte), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock),
        "the server holds the connection open while it waits for the client's Close"
    );
    tokio::time::advance(FINISH_DRAIN_BOUND + Duration::from_millis(1)).await;
    let ended = bounded(tokio::io::AsyncReadExt::read(tcp, &mut byte)).await;
    assert!(
        matches!(ended, Ok(0)),
        "the server ended the connection in order after the bound: {ended:?}"
    );
}

// A restart in place puts a live incarnation under the id while an attach to
// the exited one is held: that attach reports the old exit and ends its own
// socket, the restarted incarnation stays registered, and a dial naming the
// id reaches it rather than the old exit.
#[tokio::test(start_paused = true)]
async fn an_exit_of_a_replaced_incarnation_leaves_the_restarted_one_registered() {
    let mut rig = Rig::with_command(MARKED_CHILD).await;
    rig.handle.send_input(b"\n");
    loop {
        if let SessionEvent::Exit(_) = bounded(rig.handle.rx.recv()).await.expect("event") {
            break;
        }
    }
    let replacement: Arc<std::sync::Mutex<Option<AttachHandle>>> = Arc::default();
    {
        let registry = rig.state.terminal_sessions.clone();
        let kept = replacement.clone();
        let id = rig.handle.id().to_owned();
        let old_generation = rig.handle.generation;
        arm_attach_seam(
            rig.handle.id(),
            AttachSeam::AttachBeforeRingLock,
            move || {
                assert!(registry
                    .restart(
                        &id,
                        crate::terminal_sessions::RestartOverrides {
                            command: Some("read -r line".into()),
                            ..Default::default()
                        },
                    )
                    .expect("restart the exited child"));
                let handle = registry
                    .attach_for_ws(&id, None)
                    .expect("the restarted incarnation is registered");
                assert_ne!(handle.generation, old_generation);
                *kept.lock().expect("replacement") = Some(handle);
            },
        );
    }
    let (mut client, _) = rig.attach_with_prelude().await;
    tokio::time::advance(Duration::from_millis(150)).await;
    let tail = read_to_transport_end(&mut client).await;
    let restarted = replacement
        .lock()
        .expect("replacement")
        .as_ref()
        .map(|handle| handle.generation);
    let registered = rig
        .state
        .terminal_sessions
        .attach_for_ws(rig.handle.id(), None)
        .map(|handle| handle.generation);
    let (mut live, _) = bounded(tokio_tungstenite::connect_async(format!(
        "ws://{}/api/terminal/ws?session={}",
        rig.address,
        rig.handle.id()
    )))
    .await
    .expect("dial");
    let live_session = read_prelude(&mut live).await.session;
    assert_eq!(
        (
            tail.kinds,
            registered,
            live_session["id"].as_str() == Some(rig.handle.id()),
            live_session["generation"].as_u64()
        ),
        (
            vec!["program-status".to_owned(), "exit".to_owned()],
            restarted,
            true,
            restarted
        ),
        "the old attach reports its exit; the restarted incarnation stays registered and a dial reaches it"
    );
}
