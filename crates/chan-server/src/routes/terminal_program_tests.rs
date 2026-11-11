use super::*;
use serde_json::json;

#[tokio::test]
async fn terminal_program_prelude_carries_the_retained_pair() {
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
        .expect("spawn terminal");
    let frame = serde_json::to_value(session_frame(&handle)).expect("session JSON");
    state
        .terminal_sessions
        .close(handle.id(), CloseReason::Explicit);
    state.terminal_sessions.remove(handle.id());
    assert_eq!(frame["program"], json!(handle.initial_program));
}

use crate::terminal_sessions::{arm_attach_seam, AttachSeam};
use futures::{SinkExt, StreamExt};
use serde_json::Value;
use std::{future::Future, task::Poll, time::Duration};
use tokio_tungstenite::tungstenite::Message as ClientMessage;

type Client =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

// Keep network I/O runnable without advancing the paused clock implicitly.
async fn bounded<T>(future: impl Future<Output = T>) -> T {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    tokio::pin!(future);
    loop {
        if let Poll::Ready(value) = futures::poll!(&mut future) {
            return value;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "program socket deadline"
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
        let mut handle = state
            .terminal_sessions
            .create(CreateOptions {
                size: pty_size(Some(80), Some(24)),
                command: Some("printf 'PROGRAM_READY\\n'; read -r line".into()),
                tab_name: Some("Build".into()),
                tab_group: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                env: BTreeMap::new(),
                profile: None,
            })
            .expect("spawn terminal");
        child_ready(&mut handle).await;
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

    fn output(&self, bytes: &[u8]) {
        assert!(self
            .state
            .terminal_sessions
            .inject_output(self.handle.id(), bytes));
    }

    fn title(&self, title: &str) {
        self.output(format!("\x1b]2;{title}\x07").as_bytes());
        assert_eq!(
            self.handle.program_rx.borrow().title.as_deref(),
            Some(title)
        );
    }

    async fn attach(&self, query: &str) -> (Client, Value) {
        let (mut client, _) = bounded(tokio_tungstenite::connect_async(format!(
            "ws://{}/api/terminal/ws?session={}{}",
            self.address,
            self.handle.id(),
            query
        )))
        .await
        .expect("connect");
        let prelude = prelude(&mut client).await;
        (client, prelude)
    }
}

async fn child_ready(handle: &mut AttachHandle) {
    let mut output = handle.replay.concat();
    while !output
        .windows(b"PROGRAM_READY".len())
        .any(|s| s == b"PROGRAM_READY")
    {
        if let SessionEvent::Output(bytes) = bounded(handle.rx.recv()).await.expect("output") {
            output.extend_from_slice(&bytes);
        }
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        EXIT_OBSERVERS
            .lock()
            .expect("exit observers")
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
            ClientMessage::Text(text) => return serde_json::from_str(&text).expect("JSON"),
            ClientMessage::Close(_) => panic!("closed before expected frame"),
            _ => {}
        }
    }
}

async fn prelude(client: &mut Client) -> Value {
    let mut session = Value::Null;
    loop {
        let frame = text_frame(client).await;
        match frame["type"].as_str() {
            Some("session") => session = frame,
            Some("ready") => return session,
            _ => {}
        }
    }
}

async fn program_frame(client: &mut Client) -> Value {
    loop {
        let frame = text_frame(client).await;
        if frame["type"] == "program" {
            return frame;
        }
        assert_ne!(
            frame["type"], "exit",
            "the cleared reading must precede exit"
        );
    }
}

// The output event is handled after all due watch updates in the biased select.
async fn fence(rig: &Rig, client: &mut Client) -> Vec<Value> {
    let marker = b"__PROGRAM_FENCE__";
    rig.output(marker);
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

fn programs(frames: &[Value]) -> Vec<&Value> {
    frames
        .iter()
        .filter(|frame| frame["type"] == "program")
        .collect()
}

#[tokio::test(start_paused = true)]
async fn terminal_program_fanout_and_late_hidden_resumed_attaches() {
    let rig = Rig::new().await;
    let (mut first, initial) = rig.attach("").await;
    let (mut second, _) = rig.attach("&size_if_unset=true").await;
    rig.title("build");
    tokio::time::advance(Duration::from_millis(150)).await;
    let one = program_frame(&mut first).await;
    assert_eq!(one, program_frame(&mut second).await);
    assert_eq!(
        one,
        json!({"type":"program", "id":rig.handle.id(),
        "generation":initial["generation"], "program":*rig.handle.program_rx.borrow()})
    );
    let retained = rig.handle.program_rx.borrow().clone();
    for query in [
        String::new(),
        format!(
            "&size_if_unset=true&since={}&generation={}",
            initial["seq"], initial["generation"]
        ),
    ] {
        let (mut late, session) = rig.attach(&query).await;
        assert_eq!(session["program"], json!(retained));
        assert_eq!(session["name"], "Build");
        tokio::time::advance(Duration::from_millis(150)).await;
        assert!(
            programs(&fence(&rig, &mut late).await).is_empty(),
            "replay must not mutate the reading"
        );
    }
    rig.output(b"\x1b[?1049h");
    let (_alternate, session) = rig.attach("").await;
    assert_eq!(session["replay_bytes"], 0);
    assert_eq!(session["program"], json!(retained));
}

#[tokio::test(start_paused = true)]
async fn terminal_program_attach_snapshot_and_subscription_are_atomic() {
    for seam in [
        AttachSeam::AttachBeforeRingLock,
        AttachSeam::AttachAfterRingLock,
    ] {
        let rig = Rig::new().await;
        rig.title("before");
        let registry = rig.state.terminal_sessions.clone();
        let id = rig.handle.id().to_owned();
        arm_attach_seam(&id.clone(), seam, move || {
            assert!(registry.inject_output(&id, b"\x1b]2;after\x07"));
        });
        let (mut client, session) = rig.attach("").await;
        match seam {
            AttachSeam::AttachBeforeRingLock => assert_eq!(session["program"]["title"], "after"),
            AttachSeam::AttachAfterRingLock => {
                assert_eq!(session["program"]["title"], "before");
                tokio::time::advance(Duration::from_millis(150)).await;
                assert_eq!(
                    program_frame(&mut client).await["program"]["title"],
                    "after"
                );
            }
            _ => unreachable!(),
        }
    }
}

#[tokio::test(start_paused = true)]
async fn terminal_program_coalesces_under_output_load_and_suppresses_equal_pairs() {
    let rig = Rig::new().await;
    rig.title("same");
    let (mut client, _) = rig.attach("").await;
    rig.title("temporary");
    rig.title("same");
    tokio::time::advance(Duration::from_millis(150)).await;
    assert!(
        programs(&fence(&rig, &mut client).await).is_empty(),
        "equal pair after coalescing"
    );
    for interval in 0..4 {
        // Consume the first watch notification, then cancel its timer on output.
        rig.title("first");
        let frames = fence(&rig, &mut client).await;
        if interval > 0 {
            assert!(programs(&frames).is_empty());
        }
        for n in 0..100 {
            rig.title(&format!("title-{interval}-{n}"));
        }
        tokio::time::advance(Duration::from_millis(149)).await;
        assert!(
            programs(&fence(&rig, &mut client).await).is_empty(),
            "no frame before 150 ms"
        );
        tokio::time::advance(Duration::from_millis(1)).await;
        let frames = fence(&rig, &mut client).await;
        let updates = programs(&frames);
        assert_eq!(
            updates.len(),
            1,
            "one latest value despite queued output: {frames:?}"
        );
        assert_eq!(
            updates[0]["program"]["title"],
            format!("title-{interval}-99")
        );
    }
    tokio::time::advance(Duration::from_secs(1)).await;
    assert!(
        programs(&fence(&rig, &mut client).await).is_empty(),
        "clean watches have no timer frames"
    );
}

#[tokio::test(start_paused = true)]
async fn terminal_program_watch_survives_output_lag() {
    let rig = Rig::new().await;
    let registry = rig.state.terminal_sessions.clone();
    let id = rig.handle.id().to_owned();
    arm_attach_seam(&id.clone(), AttachSeam::AttachAfterRingLock, move || {
        assert!(registry.inject_output(&id, b"\x1b]2;retained\x07"));
        for _ in 0..1100 {
            assert!(registry.inject_output(&id, b"x"));
        }
    });
    let (mut client, initial) = rig.attach("").await;
    assert_eq!(initial["program"]["title"], Value::Null);
    tokio::time::advance(Duration::from_millis(150)).await;
    let frames = fence(&rig, &mut client).await;
    assert!(
        frames.iter().any(|frame| frame["type"] == "error"
            && frame["message"]
                .as_str()
                .is_some_and(|s| s.contains("lagged"))),
        "fixture forces lag"
    );
    let updates = programs(&frames);
    assert_eq!(updates.len(), 1);
    assert_eq!(updates[0]["program"]["title"], "retained");
}

#[tokio::test(start_paused = true)]
async fn terminal_program_restart_rebinds_generation_receiver_and_deadline() {
    let rig = Rig::new().await;
    let (mut client, initial) = rig.attach("").await;
    rig.title("old");
    assert!(programs(&fence(&rig, &mut client).await).is_empty());
    tokio::time::advance(Duration::from_millis(100)).await;
    rig.state
        .terminal_sessions
        .restart(rig.handle.id(), RestartOverrides::default())
        .expect("restart");
    let fresh = prelude(&mut client).await;
    assert!(fresh["generation"].as_u64().unwrap() > initial["generation"].as_u64().unwrap());
    assert_eq!(fresh["program"]["title"], Value::Null);
    let mut replacement = rig
        .state
        .terminal_sessions
        .attach(rig.handle.id(), None)
        .expect("new incarnation");
    child_ready(&mut replacement).await;
    rig.output(b"\x1b]2;new\x07");
    tokio::time::advance(Duration::from_millis(149)).await;
    assert!(programs(&fence(&rig, &mut client).await).is_empty());
    tokio::time::advance(Duration::from_millis(1)).await;
    let update = program_frame(&mut client).await;
    assert_eq!(update["generation"], fresh["generation"]);
    assert_eq!(update["program"]["title"], "new");
}

#[tokio::test(start_paused = true)]
async fn terminal_program_clear_precedes_exit() {
    let mut rig = Rig::new().await;
    let (mut client, _) = rig.attach("").await;
    rig.title("running");
    tokio::time::advance(Duration::from_millis(150)).await;
    assert_eq!(
        program_frame(&mut client).await["program"]["title"],
        "running"
    );
    let (exit_tx, exit_rx) = tokio::sync::oneshot::channel();
    EXIT_OBSERVERS
        .lock()
        .expect("exit observers")
        .push((rig.handle.id().to_owned(), exit_tx));
    rig.handle.send_input(b"\n");
    while !matches!(
        bounded(rig.handle.rx.recv()).await.expect("event"),
        SessionEvent::Exit(_)
    ) {}
    bounded(exit_rx)
        .await
        .expect("socket waits inside send_exit before its timer is due");
    tokio::time::advance(Duration::from_millis(150)).await;
    assert_eq!(
        program_frame(&mut client).await["program"],
        json!({"title":null,"command":null})
    );
    loop {
        let frame = text_frame(&mut client).await;
        if frame["type"] == "exit" {
            assert_eq!(frame["code"], 0);
            break;
        }
        assert_ne!(frame["type"], "program", "no duplicate clear");
    }
}

#[tokio::test(start_paused = true)]
async fn terminal_program_changes_do_not_acknowledge_or_change_names() {
    let rig = Rig::new().await;
    let (mut client, _) = rig.attach("").await;
    rig.title("different");
    tokio::time::advance(Duration::from_millis(150)).await;
    let frames = fence(&rig, &mut client).await;
    assert!(!frames.iter().any(|f| f["type"] == "renamed"));
    assert_eq!(rig.handle.live_metadata().name.as_deref(), Some("Build"));
    bounded(client.send(ClientMessage::text(
        json!({"type":"rename","name":"Edited","group":"work"}).to_string(),
    )))
    .await
    .expect("rename");
    let renamed = loop {
        let frame = text_frame(&mut client).await;
        if frame["type"] == "renamed" {
            break frame;
        }
    };
    assert_eq!(
        renamed,
        json!({"type":"renamed","name":"Edited","group":"work"})
    );
}

type ExitObserver = (String, tokio::sync::oneshot::Sender<()>);
static EXIT_OBSERVERS: std::sync::Mutex<Vec<ExitObserver>> = std::sync::Mutex::new(Vec::new());

pub(super) fn observe_exit_wait(id: &str) {
    let mut observers = EXIT_OBSERVERS.lock().expect("exit observers");
    if let Some(at) = observers.iter().position(|(key, _)| key == id) {
        let _ = observers.remove(at).1.send(());
    }
}

fn reading(title: &str) -> ProgramReading {
    ProgramReading {
        title: Some(title.into()),
        command: Some("sh".into()),
    }
}

fn feed(initial: ProgramReading) -> (tokio::sync::watch::Sender<ProgramReading>, ProgramFeed) {
    let (sender, receiver) = tokio::sync::watch::channel(initial.clone());
    (
        sender,
        ProgramFeed {
            receiver,
            last_sent: initial,
            pending: false,
            next_send: tokio::time::Instant::now() + PROGRAM_INTERVAL,
        },
    )
}

#[tokio::test(start_paused = true)]
async fn terminal_program_feed_suppresses_equal_pairs_including_return_to_sent_value() {
    let (sender, mut feed) = feed(reading("same"));
    sender.send(reading("temporary")).unwrap();
    assert!(futures::poll!(std::pin::pin!(feed.next())).is_pending());
    sender.send(reading("same")).unwrap();
    tokio::time::advance(Duration::from_millis(150)).await;
    assert!(
        futures::poll!(std::pin::pin!(feed.next())).is_pending(),
        "equal pairs must not produce a delta"
    );
    sender.send(reading("same")).unwrap();
    assert!(
        futures::poll!(std::pin::pin!(feed.next())).is_pending(),
        "even an equal-value watch notification is suppressed"
    );
    tokio::time::advance(Duration::from_secs(1)).await;
    assert!(
        futures::poll!(std::pin::pin!(feed.next())).is_pending(),
        "a clean receiver must stay idle"
    );
    sender.send(reading("different")).unwrap();
    assert_eq!(feed.next().await.unwrap(), reading("different"));
}

#[tokio::test(start_paused = true)]
async fn terminal_program_feed_keeps_deadline_across_cancellation_and_sends_latest() {
    let (sender, mut feed) = feed(ProgramReading::default());
    for n in 0..150 {
        sender.send(reading(&n.to_string())).unwrap();
        assert!(
            futures::poll!(std::pin::pin!(feed.next())).is_pending(),
            "no send before the 150 ms deadline"
        );
        tokio::time::advance(Duration::from_millis(1)).await;
    }
    assert_eq!(feed.next().await.unwrap(), reading("149"));
    feed.sent();
    sender.send(reading("next")).unwrap();
    assert!(futures::poll!(std::pin::pin!(feed.next())).is_pending());
    tokio::time::advance(Duration::from_millis(149)).await;
    assert!(futures::poll!(std::pin::pin!(feed.next())).is_pending());
    tokio::time::advance(Duration::from_millis(1)).await;
    assert_eq!(feed.next().await.unwrap(), reading("next"));
}

#[test]
fn terminal_program_wire_has_only_the_pair_and_incarnation() {
    for program in [ProgramReading::default(), reading("build")] {
        let frame = ServerFrame::Program {
            id: "s1".into(),
            generation: 3,
            program: program.clone(),
        };
        assert_eq!(
            serde_json::to_value(frame).unwrap(),
            json!({
                "type":"program","id":"s1","generation":3,"program":program
            })
        );
    }
    assert_eq!(
        serde_json::to_string(&ServerFrame::Program {
            id: "s1".into(),
            generation: 3,
            program: ProgramReading::default(),
        })
        .unwrap(),
        r#"{"type":"program","id":"s1","generation":3,"program":{"title":null,"command":null}}"#
    );
    assert_eq!(
        serde_json::to_value(TmuxPaneWire {
            connection: 7,
            pane: "%3".into()
        })
        .unwrap(),
        json!({"connection":7,"pane":"%3"})
    );
}
