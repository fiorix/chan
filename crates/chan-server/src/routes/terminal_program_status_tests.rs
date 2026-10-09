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
        let state = crate::state::test_support::make_test_state(false);
        let handle = state
            .terminal_sessions
            .create(CreateOptions {
                size: pty_size(Some(80), Some(24)),
                command: Some("read -r line".into()),
                tab_name: None,
                tab_group: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                env: BTreeMap::new(),
                profile: None,
            })
            .expect("spawn terminal waiting for one line");
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
}

impl Drop for Rig {
    fn drop(&mut self) {
        SEND_OBSERVERS
            .lock()
            .expect("send observers")
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
