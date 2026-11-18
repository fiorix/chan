use super::tests::{
    create_quiet_terminal, dial_terminal_with_small_buffer, pty_test_lock,
    serve_terminal_route_with_small_buffers, PROBE_BUDGET,
};
use super::*;
use crate::config::TerminalConfig;
use crate::terminal_sessions::{
    arm_attach_seam, AttachSeam, ControlSocketEnv, Registry, RegistryConfig,
};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message as ClientMessage;

type Client =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
type PendingObserver = (String, usize, oneshot::Sender<()>);
static PENDING_SENDS: Mutex<Vec<PendingObserver>> = Mutex::new(Vec::new());
static PENDING_TEXT_SENDS: Mutex<Vec<PendingObserver>> = Mutex::new(Vec::new());
const BLOCKED_BYTES: usize = 1024 * 1024;
const FLOOD_CHUNKS: usize = 1100;
const CHUNK_BYTES: usize = 32;
const CHILD_READY: &[u8] = b"__STREAM_READY__";
const LOST_PLAIN_SUFFIX: &[u8] = b"\x18\x1b7\x1b[?1049;1047;47l\x1b[?1l\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l\x1b[?2004l";

/// Observe an actual pending binary write, without holding or changing it.
pub(super) fn send_pending(id: &str, binary_bytes: usize) {
    let observer = {
        let mut observers = PENDING_SENDS.lock().expect("pending send observers");
        observers
            .iter()
            .position(|(key, minimum, _)| key == id && binary_bytes >= *minimum)
            .map(|at| observers.remove(at).2)
    };
    if let Some(observer) = observer {
        let _ = observer.send(());
    }
}

/// Distinct reply sizes identify the actual pending send without delaying it.
pub(super) fn text_send_pending(id: &str, text_bytes: usize) {
    let observer = {
        let mut observers = PENDING_TEXT_SENDS.lock().expect("pending text observers");
        observers
            .iter()
            .position(|(key, minimum, _)| key == id && text_bytes >= *minimum)
            .map(|at| observers.remove(at).2)
    };
    if let Some(observer) = observer {
        let _ = observer.send(());
    }
}

pub(super) struct PendingSend {
    id: String,
    observed: oneshot::Receiver<()>,
}

impl PendingSend {
    fn arm(id: &str) -> Self {
        Self::at_least(id, BLOCKED_BYTES)
    }

    fn at_least(id: &str, minimum: usize) -> Self {
        let (send, observed) = oneshot::channel();
        PENDING_SENDS
            .lock()
            .expect("pending send observers")
            .push((id.to_owned(), minimum, send));
        Self {
            id: id.to_owned(),
            observed,
        }
    }

    pub(super) fn text_at_least(id: &str, minimum: usize) -> Self {
        let (send, observed) = oneshot::channel();
        PENDING_TEXT_SENDS
            .lock()
            .expect("pending text observers")
            .push((id.to_owned(), minimum, send));
        Self {
            id: id.to_owned(),
            observed,
        }
    }

    pub(super) async fn wait(&mut self) {
        bounded(
            "the observed socket send becomes pending",
            &mut self.observed,
        )
        .await
        .expect("pending send observer remains registered");
    }
}

impl Drop for PendingSend {
    fn drop(&mut self) {
        PENDING_SENDS
            .lock()
            .expect("pending send observers")
            .retain(|(id, _, _)| id != &self.id);
        PENDING_TEXT_SENDS
            .lock()
            .expect("pending text observers")
            .retain(|(id, _, _)| id != &self.id);
    }
}

async fn bounded<T>(what: &str, future: impl Future<Output = T>) -> T {
    tokio::time::timeout(PROBE_BUDGET, future)
        .await
        .unwrap_or_else(|_| panic!("{what} did not finish within {PROBE_BUDGET:?}"))
}

async fn until(what: &str, mut condition: impl FnMut() -> bool) {
    bounded(what, async {
        while !condition() {
            tokio::task::yield_now().await;
        }
    })
    .await;
}

struct Rig {
    state: Arc<AppState>,
    handle: AttachHandle,
    address: std::net::SocketAddr,
    server: tokio::task::JoinHandle<()>,
}

impl Rig {
    fn state(ring_bytes: usize) -> Arc<AppState> {
        let mut state = crate::state::test_support::make_test_state(false);
        Arc::get_mut(&mut state)
            .expect("unshared fixture state")
            .terminal_sessions = Arc::new(Registry::new(RegistryConfig {
            workspace_root: std::env::temp_dir(),
            mcp_socket_path: None,
            control_socket: ControlSocketEnv::None,
            terminal: TerminalConfig {
                ring_bytes,
                ..Default::default()
            },
        }));
        state
    }

    async fn new(ring_bytes: usize, body: &str) -> Self {
        let state = Self::state(ring_bytes);
        let command = format!("stty -echo; printf '__STREAM_%s__' READY; {body}");
        let mut handle = create_quiet_terminal(&state, &command);
        let mut output: Vec<u8> = handle.replay.iter().flatten().copied().collect();
        bounded("the controlled child starts without echo", async {
            while !output
                .windows(CHILD_READY.len())
                .any(|bytes| bytes == CHILD_READY)
            {
                match handle.rx.recv().await {
                    Ok(SessionEvent::Output(bytes)) => output.extend(bytes),
                    Ok(_) => {}
                    Err(error) => panic!("child readiness event: {error}"),
                }
            }
        })
        .await;
        let (address, server) = serve_terminal_route_with_small_buffers(state.clone()).await;
        Self {
            state,
            handle,
            address,
            server,
        }
    }

    async fn tmux(ring_bytes: usize) -> Self {
        let state = Self::state(ring_bytes);
        let handle = state
            .terminal_sessions
            .create_tmux_pane_for_test(1, 1, pty_size(Some(113), Some(37)))
            .expect("create process-free tmux pane");
        let (address, server) = serve_terminal_route_with_small_buffers(state.clone()).await;
        Self {
            state,
            handle,
            address,
            server,
        }
    }

    async fn attach(&self) -> (Client, Value) {
        let mut client = bounded(
            "attach terminal socket",
            dial_terminal_with_small_buffer(
                self.address,
                &format!("session={}&cols=80&rows=24", self.handle.id()),
            ),
        )
        .await;
        let mut session = None;
        loop {
            if let ClientMessage::Text(text) = next(&mut client).await {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                match frame["type"].as_str() {
                    Some("session") => session = Some(frame),
                    Some("ready") => return (client, session.expect("session before ready")),
                    Some("error") => panic!("attach error: {frame}"),
                    _ => {}
                }
            }
        }
    }

    fn output(&self, bytes: &[u8]) {
        assert!(self
            .state
            .terminal_sessions
            .inject_output(self.handle.id(), bytes));
    }

    fn flood(&self) -> Vec<u8> {
        let mut flood = Vec::new();
        for index in 0..FLOOD_CHUNKS {
            let chunk = format!("{index:08x}:{}\n", "r".repeat(22));
            assert_eq!(chunk.len(), CHUNK_BYTES);
            self.output(chunk.as_bytes());
            flood.extend_from_slice(chunk.as_bytes());
        }
        flood
    }

    async fn block_output(&self) -> PendingSend {
        let mut pending = PendingSend::arm(self.handle.id());
        self.output(&vec![b'B'; BLOCKED_BYTES]);
        pending.wait().await;
        pending
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.state
            .terminal_sessions
            .close(self.handle.id(), CloseReason::Explicit);
        self.server.abort();
    }
}

async fn next(client: &mut Client) -> ClientMessage {
    bounded("next terminal frame", client.next())
        .await
        .expect("terminal transport stays open")
        .expect("terminal frame")
}

async fn send(client: &mut Client, frame: Value) {
    bounded(
        "send client frame",
        client.send(ClientMessage::Text(frame.to_string().into())),
    )
    .await
    .expect("client frame writes");
}

async fn next_binary(client: &mut Client) -> Vec<u8> {
    loop {
        match next(client).await {
            ClientMessage::Binary(bytes) => return bytes.to_vec(),
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                assert_ne!(frame["type"], "error", "unexpected terminal error: {frame}");
            }
            other => panic!("terminal ended before binary output: {other:?}"),
        }
    }
}

async fn finish_blocked_frame(client: &mut Client) {
    let bytes = next_binary(client).await;
    assert_eq!(
        bytes.len(),
        BLOCKED_BYTES,
        "the pending raw frame completes before recovery"
    );
    assert!(
        bytes.iter().all(|byte| *byte == b'B'),
        "the pending raw frame retains every byte"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_blocked_output_send_still_reads_input() {
    let _gate = pty_test_lock();
    let directory = tempfile::tempdir().expect("input proof directory");
    let path = directory.path().join("input");
    let quoted = format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
    let rig = Rig::new(
        2 * BLOCKED_BYTES,
        &format!(
        "IFS= read -r line; printf '%s' \"$line\" > {quoted}; while IFS= read -r line; do :; done"
    ),
    )
    .await;
    let (mut client, _) = rig.attach().await;
    let _pending = rig.block_output().await;
    send(
        &mut client,
        json!({"type":"input", "data":"input-reached-the-child\n"}),
    )
    .await;
    until("input reaches the child before output is drained", || {
        std::fs::read(&path).is_ok_and(|bytes| bytes == b"input-reached-the-child")
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_blocked_output_send_still_reads_resize() {
    let _gate = pty_test_lock();
    let rig = Rig::new(2 * BLOCKED_BYTES, "while IFS= read -r line; do :; done").await;
    let (mut client, _) = rig.attach().await;
    let _pending = rig.block_output().await;
    send(&mut client, json!({"type":"resize", "cols":97, "rows":31})).await;
    until(
        "resize reaches the controller before output is drained",
        || {
            let size = rig.handle.size();
            (size.cols, size.rows) == (97, 31)
        },
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_blocked_output_send_still_reads_close() {
    let _gate = pty_test_lock();
    let rig = Rig::new(2 * BLOCKED_BYTES, "while IFS= read -r line; do :; done").await;
    let (mut client, _) = rig.attach().await;
    let _pending = rig.block_output().await;
    send(&mut client, json!({"type":"close"})).await;
    until("close removes the session before output is drained", || {
        rig.state.terminal_sessions.is_empty()
    })
    .await;
}

async fn invalid_request(client: &mut Client, byte: char, bytes: usize) {
    send(client, json!({"type":byte.to_string().repeat(bytes)})).await;
}

async fn invalid_reply(client: &mut Client, byte: char, bytes: usize) {
    loop {
        if let ClientMessage::Text(text) = next(client).await {
            let frame: Value = serde_json::from_str(&text).expect("control JSON");
            if frame["type"] == "error" {
                let message = frame["message"].as_str().expect("error sentence");
                assert!(message.starts_with("invalid terminal frame: unknown variant `"));
                assert!(
                    message.contains(&byte.to_string().repeat(bytes)),
                    "the observed pending text is the requested large error reply"
                );
                return;
            }
        }
    }
}

async fn accept_and_drain_prompt(rig: &Rig, client: &mut Client, id: &str) {
    send(
        client,
        json!({"type":"prompt", "data":"ordered", "agent":"none", "id":id}),
    )
    .await;
    until("the blocked reply still accepts the prompt", || {
        rig.handle.queued_prompt_ids() == [id]
    })
    .await;
    let mut delivered = rig.handle.rx.resubscribe();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("wall clock")
        .as_millis() as i64;
    rig.handle.drain_queue_for_test(now_ms + 60_000);
    assert_eq!(
        rig.handle.queue_depth(),
        0,
        "the real drain consumes the prompt"
    );
    assert!(
        std::iter::from_fn(|| delivered.try_recv().ok()).any(|event| {
            matches!(event, SessionEvent::PromptDelivered { id: actual, depth: 0 } if actual == id)
        }),
        "the fixture produces a real PromptDelivered before the reply resumes"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_prompt_accepted_during_a_reply_send_is_acknowledged_before_its_events() {
    let _gate = pty_test_lock();
    let rig = Rig::tmux(64 * 1024).await;
    let (mut client, _) = rig.attach().await;
    let mut pending = PendingSend::text_at_least(rig.handle.id(), BLOCKED_BYTES);
    invalid_request(&mut client, 'A', BLOCKED_BYTES).await;
    pending.wait().await;
    let prompt_id = "during-event-reply";
    accept_and_drain_prompt(&rig, &mut client, prompt_id).await;
    invalid_reply(&mut client, 'A', BLOCKED_BYTES).await;

    let mut acknowledged = false;
    loop {
        if let ClientMessage::Text(text) = next(&mut client).await {
            let frame: Value = serde_json::from_str(&text).expect("control JSON");
            match frame["type"].as_str() {
                Some("prompt-ack") => {
                    assert_eq!(frame["id"], prompt_id);
                    assert_eq!(frame["queued"], true);
                    assert_eq!(frame["depth"], 1);
                    assert!(!acknowledged, "the prompt is acknowledged once");
                    acknowledged = true;
                }
                Some("queue") => assert!(
                    acknowledged,
                    "PromptAck must precede the first queued event, not just a later reproof: {frame}"
                ),
                Some("prompt-delivered") => {
                    assert_eq!(frame["id"], prompt_id);
                    assert_eq!(frame["depth"], 0);
                    assert!(acknowledged, "PromptDelivered must follow PromptAck");
                    break;
                }
                Some("error" | "session") => panic!("unexpected ordering frame: {frame}"),
                _ => {}
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_prompt_accepted_during_the_recovery_reply_batch_is_acknowledged_before_session() {
    let _gate = pty_test_lock();
    let rig = Rig::tmux(64 * 1024).await;
    let (mut client, initial) = rig.attach().await;
    let mut first = PendingSend::text_at_least(rig.handle.id(), BLOCKED_BYTES);
    invalid_request(&mut client, 'A', BLOCKED_BYTES).await;
    first.wait().await;

    // B is accepted inside A's bounded flush, so it remains queued when that
    // flush returns and discovers the evicted receiver. Its larger size lets
    // the observer distinguish B becoming pending from another poll of A.
    invalid_request(&mut client, 'B', 2 * BLOCKED_BYTES).await;
    send(&mut client, json!({"type":"rename", "name":"reply-fence"})).await;
    until("the input fence follows the second queued reply", || {
        rig.handle.live_metadata().name.as_deref() == Some("reply-fence")
    })
    .await;
    bury_control_events(&rig.handle);
    let mut second = PendingSend::text_at_least(rig.handle.id(), 2 * BLOCKED_BYTES);
    invalid_reply(&mut client, 'A', BLOCKED_BYTES).await;
    second.wait().await;

    let prompt_id = "during-recovery-reply";
    accept_and_drain_prompt(&rig, &mut client, prompt_id).await;
    invalid_reply(&mut client, 'B', 2 * BLOCKED_BYTES).await;
    let mut acknowledged = false;
    let mut recovered = false;
    loop {
        if let ClientMessage::Text(text) = next(&mut client).await {
            let frame: Value = serde_json::from_str(&text).expect("control JSON");
            match frame["type"].as_str() {
                Some("prompt-ack") => {
                    assert_eq!(frame["id"], prompt_id);
                    assert_eq!(frame["queued"], true);
                    assert_eq!(frame["depth"], 1);
                    assert!(!acknowledged, "the prompt is acknowledged once");
                    acknowledged = true;
                }
                Some("session") => {
                    assert!(
                        acknowledged,
                        "PromptAck must precede the recovery Session that re-proves delivery"
                    );
                    assert!(!recovered, "one recovery snapshot");
                    assert_eq!(frame["id"], initial["id"]);
                    assert_eq!(frame["generation"], initial["generation"]);
                    assert_eq!(frame["queue_depth"], 0);
                    assert_eq!(frame["queued_prompt_ids"], json!([]));
                    recovered = true;
                }
                Some("ready") => {
                    assert!(recovered, "the evicted receiver forces recovery");
                    break;
                }
                Some("error") => panic!("unexpected ordering error: {frame}"),
                _ => {}
            }
        }
    }
}

async fn assert_resume(ring_bytes: usize, tmux: bool) {
    let _gate = pty_test_lock();
    let rig = if tmux {
        Rig::tmux(ring_bytes).await
    } else {
        Rig::new(ring_bytes, "while IFS= read -r line; do :; done").await
    };
    let (mut client, initial) = rig.attach().await;
    let prefix = b"completed-prefix\n";
    rig.output(prefix);
    assert_eq!(next_binary(&mut client).await, prefix);
    let _pending = rig.block_output().await;
    if !tmux {
        rig.handle.resize(pty_size(Some(113), Some(37)));
    }
    until("co-view resize applied", || {
        let size = rig.handle.size();
        (size.cols, size.rows) == (113, 37)
    })
    .await;
    let flood = rig.flood();
    let completed_seq =
        initial["seq"].as_u64().expect("initial seq") + prefix.len() as u64 + BLOCKED_BYTES as u64;
    let replay_bytes = flood.len().min(ring_bytes);
    let missed_bytes = flood.len() - replay_bytes;
    finish_blocked_frame(&mut client).await;
    let mut resumed = None;
    let mut replay = Vec::new();
    loop {
        match next(&mut client).await {
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                match frame["type"].as_str() {
                    Some("session") => {
                        assert!(resumed.is_none(), "one recovery session frame");
                        assert_eq!(frame["generation"], initial["generation"]);
                        assert_eq!(
                            frame["seq"],
                            completed_seq + flood.len() as u64,
                            "recovery adopts the producer cursor"
                        );
                        assert_eq!(
                            frame["missed_bytes"], missed_bytes,
                            "missed bytes start after the last completed raw send"
                        );
                        assert_eq!(frame["replay_bytes"], replay_bytes);
                        resumed = Some(frame);
                    }
                    Some("ready") => {
                        assert!(
                            resumed.is_some(),
                            "recovery has an authoritative session frame"
                        );
                        assert_eq!(
                            (frame["cols"].as_u64(), frame["rows"].as_u64()),
                            (Some(113), Some(37)),
                            "recovery reports current co-view size"
                        );
                        break;
                    }
                    Some("error") => panic!("lag recovery must not emit a terminal error: {frame}"),
                    _ => {}
                }
            }
            ClientMessage::Binary(bytes) => {
                assert!(resumed.is_some(), "same-generation recovery must not send RESET or stale live bytes before Session");
                replay.extend_from_slice(&bytes);
            }
            other => panic!("recovery ended before ready: {other:?}"),
        }
    }
    assert!(
        replay.len() >= replay_bytes,
        "all retained raw bytes arrive"
    );
    assert_eq!(
        replay[..replay_bytes],
        flood[missed_bytes..],
        "recovery sends retained raw bytes exactly once without RESET"
    );
    let expected_suffix = if missed_bytes > 0 {
        LOST_PLAIN_SUFFIX
    } else {
        b""
    };
    assert_eq!(
        &replay[replay_bytes..],
        expected_suffix,
        "only an actual loss reconciles modes, outside replay_bytes and seq"
    );
    let suffix = b"live-after-recovery\n";
    rig.output(suffix);
    assert_eq!(
        next_binary(&mut client).await,
        suffix,
        "live subscription begins after replay"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lag_recovery_replays_a_retained_cursor_without_reset_or_loss() {
    assert_resume(64 * 1024, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lag_recovery_counts_evicted_bytes_after_the_last_completed_send() {
    assert_resume(8 * 1024, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tmux_pane_recovers_a_retained_cursor_without_reset_or_loss() {
    assert_resume(64 * 1024, true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tmux_pane_recovers_eviction_with_an_exact_missed_count() {
    assert_resume(8 * 1024, true).await;
}

const DONE_MARKER: &[u8] = b"__STREAM_DONE__";

/// Attach like Rig::attach but keep the prelude's replay bytes: a flood
/// already streaming when the socket subscribes replays from the ring
/// between the session frame and ready, and Rig::attach drops those.
async fn attach_collecting(address: std::net::SocketAddr, id: &str) -> (Client, Value, Vec<u8>) {
    let mut client = bounded(
        "attach terminal socket",
        dial_terminal_with_small_buffer(address, &format!("session={id}&cols=80&rows=24")),
    )
    .await;
    let mut session = None;
    let mut sessions = 0;
    let mut replay = Vec::new();
    loop {
        match next(&mut client).await {
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                match frame["type"].as_str() {
                    Some("session") => {
                        sessions += 1;
                        session = Some(frame);
                    }
                    Some("ready") => {
                        assert_eq!(sessions, 1, "one session frame opens the attach");
                        return (client, session.expect("session before ready"), replay);
                    }
                    Some("error") => panic!("attach error: {frame}"),
                    _ => {}
                }
            }
            ClientMessage::Binary(bytes) => replay.extend_from_slice(&bytes),
            other => panic!("attach ended before ready: {other:?}"),
        }
    }
}

/// Acceptance 2's second clause on real sockets, in part: what is asserted
/// is that the program finishes without the stalled view reading (no
/// earlier than about the 5 s release bound, by the >= 4 s check) and the
/// stalled view recovers without loss (one same-generation session frame,
/// numeric missed count, the retained tail once). The 5 s value is pinned
/// on a synthetic clock, with no wall time, in
/// pacing/tests::progress_renews_deadline_and_cut_loose_stays_latched
/// and pacing/tests::expiring_one_view_preserves_the_other_views_credit_and_deadline.
///
/// The 2 MiB ring holds the whole ~1.4 MiB flood, so no view can be evicted
/// and every recovery below is lossless by construction: a 64 KiB ring lets
/// even the draining view fall behind under load, which makes the live
/// view's outcome a race instead of a contract.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stalled_view_releases_the_program_while_a_second_view_drains() {
    let _gate = pty_test_lock();
    // The child waits for a newline before flooding, so both views attach
    // before the first flood byte and the hold engages by construction: the
    // flood outruns A's 1 MiB credit once A stops reading, and the stalled
    // view's release is what lets the program finish.
    let rig = Rig::new(
        2 * 1024 * 1024,
        "stty -onlcr; read -r _; seq 1 1000000; printf '__STREAM_DONE__'",
    )
    .await;
    // Socket A attaches before the flood and reads one live frame, then
    // stops draining entirely. The flood is sized so the hold engages by
    // construction on any transport: at ~6.9 MB it outruns the kernel's
    // send buffering (capped at wmem_max) plus the 1 MiB pacing credit, so
    // the slowest view is a full credit behind before the flood ends.
    let (mut stalled, initial) = rig.attach().await;
    // The hold is observed structurally: the reader parks waiting for
    // progress while A holds the session back.
    let held = Arc::new(AtomicBool::new(false));
    arm_attach_seam(rig.handle.id(), AttachSeam::ReaderWaitingForProgress, {
        let held = held.clone();
        move || held.store(true, Ordering::SeqCst)
    });
    // Socket B attaches before the flood, so its replay is READY alone and
    // the start time below carries no attach latency on any schedule.
    let (mut draining, b_session, mut received) =
        attach_collecting(rig.address, rig.handle.id()).await;
    let started = std::time::Instant::now();
    rig.handle.send_input(b"\n");
    loop {
        match next(&mut stalled).await {
            ClientMessage::Binary(_) => break,
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                assert_ne!(frame["type"], "error", "unexpected terminal error: {frame}");
            }
            other => panic!("stalled socket ended before its first frame: {other:?}"),
        }
    }
    // Socket B drains everything the program writes, prelude replay included.
    // A stalled drain is an idle transport: read the socket with a hang
    // guard directly, so a run where the program is never released fails
    // with its own name instead of a generic read timeout. Sixty seconds
    // of silence trips it; a slow but flowing drain is judged by the
    // elapsed hang guard below instead.
    let drain_hang = std::time::Duration::from_secs(60);
    loop {
        // The marker ends the stream, so only the tail can complete the
        // wait; rescanning the whole buffer per frame is quadratic.
        let frame = match tokio::time::timeout(drain_hang, draining.next()).await {
            Ok(Some(Ok(frame))) => frame,
            Ok(Some(Err(error))) => panic!("live view transport error: {error:?}"),
            Ok(None) => panic!("live view ended before the flood: transport closed"),
            Err(_) => panic!(
                "the second view received nothing for the hang guard: the program was not released"
            ),
        };
        match frame {
            ClientMessage::Binary(bytes) => {
                received.extend_from_slice(&bytes);
                if received.ends_with(DONE_MARKER) {
                    break;
                }
            }
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                assert_ne!(frame["type"], "error", "live view error frame: {frame}");
                // The draining view may be released and recover without
                // loss on a slow schedule; only loss or a new generation
                // fails it here, and the byte comparison below judges. The
                // "only the stalled view is released" property itself is
                // pinned without a clock in
                // pacing/tests::expiring_one_view_preserves_the_other_views_credit_and_deadline.
                if let Some("session") = frame["type"].as_str() {
                    assert_eq!(
                        frame["generation"], b_session["generation"],
                        "draining view changed incarnation: {frame}"
                    );
                    assert_eq!(
                        frame["missed_bytes"].as_u64(),
                        Some(0),
                        "draining view lost bytes: {frame}"
                    );
                }
            }
            other => panic!("live view ended before the flood: {other:?}"),
        }
    }
    let elapsed = started.elapsed();
    assert!(
        elapsed >= std::time::Duration::from_secs(4),
        "the hold engaged before the drain completed: {elapsed:?}"
    );
    // Hang guard, not a contract bound: provisional 120 s for the
    // measurement series below; finalized at ten times its worst there.
    // A green run never prints the timing line, so the guard names it.
    assert!(
        elapsed <= std::time::Duration::from_secs(120),
        "the drain did not complete within the hang guard after {elapsed:?}"
    );
    assert!(
        held.load(Ordering::SeqCst),
        "the reader parked waiting for progress while A stalled"
    );
    let mut expected = Vec::new();
    expected.extend_from_slice(CHILD_READY);
    for index in 1..=1000000 {
        // The child disables ONLCR, so each newline arrives as LF on both
        // systems; a macOS writer outrunning its reader through ONLCR can
        // emit CR CR LF, which renders the same and only a byte-exact reader
        // sees (inferred from the BSD tty output path).
        expected.extend_from_slice(format!("{index}\n").as_bytes());
    }
    expected.extend_from_slice(DONE_MARKER);
    let mismatch = received
        .iter()
        .zip(expected.iter())
        .position(|(got, want)| got != want);
    if received.len() != expected.len() || mismatch.is_some() {
        let hex = |window: &[u8]| {
            window
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<Vec<_>>()
                .join(" ")
        };
        let at = mismatch.unwrap_or(received.len().min(expected.len()));
        let lo = at.saturating_sub(16);
        panic!(
            "the second view receives every byte once and in order: got {} want {}; first mismatch at {mismatch:?}; got window {lo}..{} {}; want window {lo}..{} {}; tail surplus {}",
            received.len(),
            expected.len(),
            (at + 16).min(received.len()),
            hex(&received[lo..(at + 16).min(received.len())]),
            (at + 16).min(expected.len()),
            hex(&expected[lo..(at + 16).min(expected.len())]),
            hex(&received[expected.len().min(received.len())..]),
        );
    }
    // Socket A resumes: exactly one same-generation session frame, a numeric
    // missed count, the retained tail once, no error. The resume's duration
    // is the machine's like the drain's, so the same hang guard applies;
    // provisional like the drain's, finalized from the series below.
    let resume_at = std::time::Instant::now();
    let resume_bound = std::time::Duration::from_secs(120);
    let mut sessions = 0;
    let mut tail = Vec::new();
    let recovery = loop {
        if std::time::Instant::now() > resume_at + resume_bound {
            panic!(
                "stalled view saw no recovery within the hang guard after {:?}: sessions {sessions}, tail {} bytes",
                resume_at.elapsed(),
                tail.len(),
            );
        }
        match next(&mut stalled).await {
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                match frame["type"].as_str() {
                    Some("session") => {
                        sessions += 1;
                        assert_eq!(sessions, 1, "one recovery session frame: {frame}");
                        break frame;
                    }
                    Some("error") => panic!("recovery error frame: {frame}"),
                    _ => {}
                }
            }
            ClientMessage::Binary(bytes) => {
                tail.extend_from_slice(&bytes);
            }
            other => panic!("stalled view ended during recovery: {other:?}"),
        }
    };
    assert_eq!(
        recovery["generation"], initial["generation"],
        "recovery keeps the incarnation"
    );
    let missed = recovery["missed_bytes"]
        .as_u64()
        .expect("numeric missed_bytes");
    // The ring cannot hold the whole flood behind a stalled view, so the
    // release must report eviction; what matters is that the count exists
    // and the retained tail below is complete and in order.
    assert!(
        missed > 0,
        "a stalled view behind a 6.9 MB flood is evicted: {missed}"
    );
    loop {
        if tail.ends_with(DONE_MARKER) {
            break;
        }
        if std::time::Instant::now() > resume_at + resume_bound {
            panic!(
                "stalled view never received the retained tail within the hang guard after {:?}: tail {} of {} bytes",
                resume_at.elapsed(),
                tail.len(),
                expected.len(),
            );
        }
        match next(&mut stalled).await {
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                assert_ne!(frame["type"], "error", "recovery error frame: {frame}");
                assert_ne!(
                    frame["type"], "session",
                    "one recovery session frame: {frame}"
                );
            }
            ClientMessage::Binary(bytes) => tail.extend_from_slice(&bytes),
            other => panic!("stalled view ended during recovery: {other:?}"),
        }
    }
    println!(
        "streamlag-times elapsed={elapsed:?} resume={:?}",
        resume_at.elapsed()
    );
    assert_eq!(
        tail.windows(DONE_MARKER.len())
            .filter(|w| *w == DONE_MARKER)
            .count(),
        1,
        "retained tail once"
    );
    assert!(
        tail.ends_with(DONE_MARKER),
        "the tail ends at the program's end marker"
    );
}

async fn assert_lossless_split_sequence(prefix: &[u8], continuation: &[u8]) {
    let _gate = pty_test_lock();
    for tmux in [false, true] {
        let rig = if tmux {
            Rig::tmux(64 * 1024).await
        } else {
            Rig::new(64 * 1024, "while IFS= read -r line; do :; done").await
        };
        let (mut client, initial) = rig.attach().await;
        rig.output(b"\x1b[?2004h");
        assert_eq!(next_binary(&mut client).await, b"\x1b[?2004h");
        let _pending = rig.block_output().await;
        let mut expected = rig.flood();
        rig.output(prefix);
        expected.extend_from_slice(prefix);
        finish_blocked_frame(&mut client).await;
        let resumed = control(&mut client, "session").await;
        assert_eq!(resumed["generation"], initial["generation"]);
        assert_eq!(resumed["missed_bytes"], 0);
        assert_eq!(resumed["replay_bytes"], expected.len());
        let mut received = Vec::new();
        loop {
            match next(&mut client).await {
                ClientMessage::Binary(bytes) => received.extend_from_slice(&bytes),
                ClientMessage::Text(text) => {
                    let frame: Value = serde_json::from_str(&text).expect("control JSON");
                    assert_ne!(frame["type"], "error");
                    assert_ne!(frame["type"], "session", "exactly one recovery");
                    if frame["type"] == "ready" {
                        break;
                    }
                }
                other => panic!("lossless recovery ended early: {other:?}"),
            }
        }
        assert_eq!(
            received.len(),
            expected.len(),
            "lossless socket recovery must insert no synthetic mode suffix"
        );
        rig.output(continuation);
        received.extend_from_slice(&next_binary(&mut client).await);
        expected.extend_from_slice(continuation);
        assert_eq!(
            received, expected,
            "raw replay and live continuation stay contiguous"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lossless_socket_recovery_preserves_a_split_csi_sequence() {
    assert_lossless_split_sequence(b"\x1b[31", b"mRED\x1b[0m").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lossless_socket_recovery_preserves_a_split_utf8_sequence() {
    assert_lossless_split_sequence(b"\xe2\x82", b"\xac").await;
}

async fn control(client: &mut Client, kind: &str) -> Value {
    loop {
        if let ClientMessage::Text(text) = next(client).await {
            let frame: Value = serde_json::from_str(&text).expect("control JSON");
            assert_ne!(frame["type"], "error", "unexpected terminal error: {frame}");
            if frame["type"] == kind {
                return frame;
            }
        }
    }
}

async fn assert_control_recovery(tmux: bool) {
    let _gate = pty_test_lock();
    let rig = if tmux {
        Rig::tmux(64 * 1024).await
    } else {
        Rig::new(64 * 1024, "while IFS= read -r line; do :; done").await
    };
    let (mut client, initial) = rig.attach().await;
    rig.handle.set_focused(true);
    assert_eq!(
        rig.handle
            .enqueue_prompt("first".into(), None, Some("p1".into())),
        Some(1)
    );
    send(&mut client, json!({"type":"queue-details", "enabled":true})).await;
    let first = control(&mut client, "queue-details").await;
    assert_eq!(first["messages"][0]["prompt_id"], "p1");
    let _pending = rig.block_output().await;
    let mut delivered = rig.handle.rx.resubscribe();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("wall clock")
        .as_millis() as i64;
    rig.handle.drain_queue_for_test(now_ms + 60_000);
    assert_eq!(
        rig.handle.queue_depth(),
        0,
        "the real logical drain consumes p1"
    );
    assert!(
        std::iter::from_fn(|| delivered.try_recv().ok()).any(|event| {
            matches!(event, SessionEvent::PromptDelivered { id, depth: 0 } if id == "p1")
        }),
        "the delivery event exists before it is evicted"
    );
    assert_eq!(
        rig.handle
            .enqueue_prompt("second".into(), None, Some("p2".into())),
        Some(1)
    );
    assert_eq!(
        rig.handle
            .enqueue_prompt("third".into(), None, Some("p3".into())),
        Some(2)
    );
    rig.handle.set_focused(false);
    if !tmux {
        rig.handle.resize(pty_size(Some(113), Some(37)));
    }
    until("authoritative size changes before event eviction", || {
        let size = rig.handle.size();
        (size.cols, size.rows) == (113, 37)
    })
    .await;
    let flood = rig.flood();
    let activity = rig.handle.bytes_since_focus();
    assert!(activity > 0, "unfocused output creates activity to recover");
    finish_blocked_frame(&mut client).await;
    let resumed = control(&mut client, "session").await;
    assert_eq!(resumed["generation"], initial["generation"]);
    assert_eq!(
        resumed["seq"],
        initial["seq"].as_u64().unwrap() + BLOCKED_BYTES as u64 + flood.len() as u64
    );
    assert_eq!(
        resumed["bytes_since_focus"], activity,
        "Activity is recovered from current state"
    );
    assert_eq!(
        resumed["queue_depth"], 2,
        "QueueDepth is recovered from current state"
    );
    assert_eq!(
        resumed["queued_prompt_ids"],
        json!(["p2", "p3"]),
        "the delivered p1 is absent even though PromptDelivered was evicted"
    );
    let ready = control(&mut client, "ready").await;
    assert_eq!(
        (ready["cols"].as_u64(), ready["rows"].as_u64()),
        (Some(113), Some(37)),
        "Resize is recovered from current state"
    );
    let details = control(&mut client, "queue-details").await;
    assert_eq!(
        details["messages"],
        json!([
            {"text":"second", "source":"rich_prompt", "prompt_id":"p2", "awaiting_submit":false},
            {"text":"third", "source":"rich_prompt", "prompt_id":"p3", "awaiting_submit":false}
        ]),
        "an existing details subscriber receives the current queue after recovery"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lag_recovery_restores_resize_activity_queue_and_delivered_prompt_state() {
    assert_control_recovery(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tmux_pane_recovers_activity_queue_and_delivered_prompt_state() {
    assert_control_recovery(true).await;
}

fn bury_control_events(handle: &AttachHandle) {
    for count in 0..FLOOD_CHUNKS {
        handle.broadcast_for_test(SessionEvent::Activity {
            bytes_since_focus: count as u64,
        });
    }
}

async fn assert_closed_survives_eviction(tmux: bool) {
    let _gate = pty_test_lock();
    let rig = if tmux {
        Rig::tmux(64 * 1024).await
    } else {
        Rig::new(64 * 1024, "while IFS= read -r line; do :; done").await
    };
    let (mut client, _) = rig.attach().await;
    let _pending = rig.block_output().await;
    assert!(rig
        .state
        .terminal_sessions
        .close(rig.handle.id(), CloseReason::Explicit));
    bury_control_events(&rig.handle);
    finish_blocked_frame(&mut client).await;
    let closed = control(&mut client, "closed").await;
    assert_eq!(
        closed["reason"], "explicit",
        "the evicted close retains its reason"
    );
    match next(&mut client).await {
        ClientMessage::Close(Some(frame)) => assert_eq!(u16::from(frame.code), 1000),
        frame => panic!("one Closed must end in the close handshake, got {frame:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_closed_session_keeps_its_reason_after_the_event_is_evicted() {
    assert_closed_survives_eviction(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_closed_tmux_pane_keeps_its_reason_after_the_event_is_evicted() {
    assert_closed_survives_eviction(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_evicted_exit_keeps_final_raw_output_before_one_exit() {
    let _gate = pty_test_lock();
    let rig = Rig::new(64 * 1024, "IFS= read -r line; exit 23").await;
    let (mut client, _) = rig.attach().await;
    let _pending = rig.block_output().await;
    let tail = b"the-final-raw-output\n";
    rig.output(tail);
    rig.handle.send_input(b"exit-now\n");
    until(
        "the child exit is recorded while its view is blocked",
        || rig.state.terminal_sessions.last_exit().is_some(),
    )
    .await;
    bury_control_events(&rig.handle);
    finish_blocked_frame(&mut client).await;
    let mut bytes = Vec::new();
    let mut exits = 0;
    loop {
        match next(&mut client).await {
            ClientMessage::Binary(data) => bytes.extend_from_slice(&data),
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                assert_ne!(
                    frame["type"], "error",
                    "evicted exit cannot become a lag error"
                );
                if frame["type"] == "exit" {
                    exits += 1;
                    assert_eq!(frame["code"], 23);
                    assert_eq!(
                        bytes, tail,
                        "the exit drain's final raw bytes precede Exit exactly once"
                    );
                }
                assert_ne!(frame["type"], "closed", "natural exit remains Exit");
            }
            ClientMessage::Close(Some(frame)) => {
                assert_eq!(u16::from(frame.code), 1000);
                break;
            }
            frame => panic!("unexpected exit transport frame: {frame:?}"),
        }
    }
    assert_eq!(
        exits, 1,
        "one authoritative Exit survives broadcast eviction"
    );
    assert_eq!(rig.state.terminal_sessions.len(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_evicted_restart_reattaches_the_new_generation_once() {
    let _gate = pty_test_lock();
    let rig = Rig::new(64 * 1024, "while IFS= read -r line; do :; done").await;
    let (mut client, initial) = rig.attach().await;
    let _pending = rig.block_output().await;
    assert!(rig
        .state
        .terminal_sessions
        .restart(rig.handle.id(), RestartOverrides::default())
        .expect("restart controlled child"));
    bury_control_events(&rig.handle);
    finish_blocked_frame(&mut client).await;
    let mut reset = Vec::new();
    let mut sessions = 0;
    loop {
        match next(&mut client).await {
            ClientMessage::Binary(bytes) if sessions == 0 => reset.extend_from_slice(&bytes),
            ClientMessage::Binary(_) => {}
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                match frame["type"].as_str() {
                    Some("session") => {
                        sessions += 1;
                        assert_eq!(frame["id"], initial["id"]);
                        assert_ne!(
                            frame["generation"], initial["generation"],
                            "lost Restarted still moves to the replacement incarnation"
                        );
                    }
                    Some("ready") => break,
                    Some("error" | "exit" | "closed") => {
                        panic!("restart must retain the socket: {frame}")
                    }
                    _ => {}
                }
            }
            frame => panic!("restart ended before Ready: {frame:?}"),
        }
    }
    assert_eq!(sessions, 1);
    assert_eq!(
        reset, RESET_TERMINAL,
        "only a new generation gets the full reset"
    );
    assert_eq!(
        rig.state.terminal_sessions.len(),
        1,
        "the new incarnation remains registered"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_progressing_small_socket_receives_more_than_a_broadcast_of_real_pty_reads() {
    use std::fmt::Write as _;

    let _gate = pty_test_lock();
    let rig = Rig::new(1024,
        "stty -onlcr; IFS= read -r start; seq -f %.0f 1 1000000; printf '__STREAM_%s__' DONE; IFS= read -r finish"
    ).await;
    let (mut client, initial) = rig.attach().await;
    assert_eq!(initial["missed_bytes"], 0);
    let mut expected = String::new();
    for number in 1..=1_000_000 {
        writeln!(&mut expected, "{number}").unwrap();
    }
    expected.push_str("__STREAM_DONE__");
    let mut pending = PendingSend::at_least(rig.handle.id(), 1);
    send(&mut client, json!({"type":"input", "data":"start\n"})).await;
    pending.wait().await;
    let mut bytes = Vec::with_capacity(expected.len());
    let mut reads = 0;
    while bytes.len() < expected.len() {
        // A short stream reports its length instead of the generic stall.
        let frame = match tokio::time::timeout(PROBE_BUDGET, client.next()).await {
            Ok(Some(Ok(frame))) => frame,
            Ok(Some(Err(error))) => panic!(
                "progressing stream errored at {} of {} bytes: {error:?}",
                bytes.len(),
                expected.len(),
            ),
            Ok(None) => panic!(
                "progressing stream ended early at {} of {} bytes",
                bytes.len(),
                expected.len(),
            ),
            Err(_) => panic!(
                "progressing stream stalled: received {} of {} bytes",
                bytes.len(),
                expected.len(),
            ),
        };
        match frame {
            ClientMessage::Binary(data) => {
                reads += 1;
                bytes.extend_from_slice(&data);
                // One frame per turn leaves the already-backpressured writer runnable.
                tokio::task::yield_now().await;
            }
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                assert_ne!(
                    frame["type"], "error",
                    "a progressing view must never lose output"
                );
                assert_ne!(
                    frame["type"], "session",
                    "a progressing view needs no recovery prelude"
                );
                assert_ne!(
                    frame["type"], "exit",
                    "the child waits until the view consumes its stream"
                );
            }
            frame => panic!("the progressing socket ended early: {frame:?}"),
        }
    }
    assert!(
        reads > 1024,
        "the real PTY stream crosses the broadcast event capacity: {reads}"
    );
    if bytes.len() != expected.len() {
        // The child blocks on its final read, so the stream is over: a
        // short idle drain collects bytes still in flight for the report.
        // Apple's seq prints the last value twice in %g form, so the
        // generator prints integers explicitly and both systems emit the
        // same bytes; the windows below read the cause off one CI log.
        let idle = std::time::Duration::from_secs(2);
        while bytes.len() < expected.len() + 64 {
            match tokio::time::timeout(idle, next(&mut client)).await {
                Ok(ClientMessage::Binary(data)) => bytes.extend_from_slice(&data),
                Ok(ClientMessage::Text(text)) => {
                    let frame: Value = serde_json::from_str(&text).expect("control JSON");
                    assert_ne!(
                        frame["type"], "error",
                        "a progressing view must never lose output"
                    );
                    assert_ne!(
                        frame["type"], "session",
                        "a progressing view needs no recovery prelude"
                    );
                    assert_ne!(
                        frame["type"], "exit",
                        "the child waits until the view consumes its stream"
                    );
                }
                Ok(frame) => panic!("the progressing socket ended early: {frame:?}"),
                Err(_) => break,
            }
        }
        let hex = |window: &[u8]| {
            window
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<Vec<_>>()
                .join(" ")
        };
        let offset = bytes
            .iter()
            .zip(expected.as_bytes())
            .position(|(actual, want)| actual != want);
        let at = offset.unwrap_or(bytes.len().min(expected.len()));
        let lo = at.saturating_sub(16);
        let hi = (at + 16).min(bytes.len());
        let want_hi = (at + 16).min(expected.len());
        panic!(
            "the real PTY byte count is exact: got {} want {}; first mismatch at {offset:?}; got window {lo}..{hi} {}; want window {lo}..{want_hi} {}; tail surplus {} (the stream tail past the expected length; read the windows for an insertion point)",
            bytes.len(),
            expected.len(),
            hex(&bytes[lo..hi]),
            hex(&expected.as_bytes()[lo..want_hi]),
            hex(&bytes[expected.len().min(bytes.len())..]),
        );
    }
    assert_eq!(
        bytes.len(),
        expected.len(),
        "the real PTY byte count is exact"
    );
    let mismatch = bytes
        .iter()
        .zip(expected.as_bytes())
        .position(|(actual, expected)| actual != expected);
    assert!(
        mismatch.is_none(),
        "every real PTY byte arrives once and in order; first mismatch {mismatch:?}"
    );
    assert!(
        rig.state.terminal_sessions.last_exit().is_none(),
        "an exit drain did not supply the stream under test"
    );
    send(&mut client, json!({"type":"input", "data":"finish\n"})).await;
}

struct CwdHold {
    entered: oneshot::Receiver<()>,
    release: Option<std::sync::mpsc::Sender<()>>,
}

impl CwdHold {
    fn arm(id: &str) -> Self {
        let (entered, observed) = oneshot::channel();
        let (release, released) = std::sync::mpsc::channel();
        arm_attach_seam(id, AttachSeam::CwdBeforeRootCheck, move || {
            let _ = entered.send(());
            let _ = released.recv();
        });
        Self {
            entered: observed,
            release: Some(release),
        }
    }

    fn release(&mut self) {
        if let Some(release) = self.release.take() {
            let _ = release.send(());
        }
    }
}

impl Drop for CwdHold {
    fn drop(&mut self) {
        self.release();
    }
}

async fn assert_cwd_keeps_reading_input(prelude: bool) {
    let _gate = pty_test_lock();
    let directory = tempfile::tempdir().expect("cwd input proof directory");
    let path = directory.path().join("input");
    let quoted = format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
    let rig = Rig::new(
        64 * 1024,
        &format!(
        "IFS= read -r line; printf '%s' \"$line\" > {quoted}; while IFS= read -r line; do :; done"
    ),
    )
    .await;
    let (mut client, mut hold) = if prelude {
        let hold = CwdHold::arm(rig.handle.id());
        let client = bounded(
            "dial while the initial cwd probe is held",
            dial_terminal_with_small_buffer(rig.address, &format!("session={}", rig.handle.id())),
        )
        .await;
        (client, hold)
    } else {
        let (mut client, _) = rig.attach().await;
        let hold = CwdHold::arm(rig.handle.id());
        send(&mut client, json!({"type":"cwd"})).await;
        (client, hold)
    };
    bounded(
        "cwd probe enters its held filesystem check",
        &mut hold.entered,
    )
    .await
    .expect("cwd probe reaches the seam");
    send(
        &mut client,
        json!({"type":"input", "data":"input-before-cwd-completes\n"}),
    )
    .await;
    let reached = tokio::time::timeout(PROBE_BUDGET, async {
        while !std::fs::read(&path).is_ok_and(|bytes| bytes == b"input-before-cwd-completes") {
            tokio::task::yield_now().await;
        }
    })
    .await
    .is_ok();
    // Release before judging; even an old blocking await cannot strand the worker.
    hold.release();
    assert!(
        reached,
        "input must reach the child while the cwd probe is held; initial prelude={prelude}"
    );
    control(&mut client, if prelude { "ready" } else { "cwd" }).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_blocked_cwd_request_still_reads_input() {
    assert_cwd_keeps_reading_input(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_blocked_initial_cwd_probe_reads_input_before_ready() {
    assert_cwd_keeps_reading_input(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn synthetic_recovery_bytes_do_not_skip_raw_output_in_a_second_recovery() {
    let _gate = pty_test_lock();
    let rig = Rig::new(8 * 1024, "while IFS= read -r line; do :; done").await;
    let (mut client, initial) = rig.attach().await;
    let _pending = rig.block_output().await;
    let flood = rig.flood();
    let after_snapshot = b"raw-after-the-first-recovery-snapshot\n";
    let session_id = rig.handle.id().to_owned();
    let registry = rig.state.terminal_sessions.clone();
    let publisher = rig.handle.replay_from(0);
    let (captured, observed) = oneshot::channel();
    arm_attach_seam(
        rig.handle.id(),
        AttachSeam::AttachProgressAfterRingLock,
        move || {
            assert!(registry.inject_output(&session_id, after_snapshot));
            bury_control_events(&publisher);
            let _ = captured.send(());
        },
    );
    finish_blocked_frame(&mut client).await;
    let first = control(&mut client, "session").await;
    bounded("first recovery snapshot captured", observed)
        .await
        .expect("snapshot seam fired");
    assert_eq!(first["generation"], initial["generation"]);
    assert!(first["missed_bytes"].as_u64().unwrap() > 0);
    let first_seq = initial["seq"].as_u64().unwrap() + BLOCKED_BYTES as u64 + flood.len() as u64;
    assert_eq!(first["seq"], first_seq);
    control(&mut client, "ready").await;

    let second = control(&mut client, "session").await;
    assert_eq!(second["generation"], initial["generation"]);
    assert_eq!(second["seq"], first_seq + after_snapshot.len() as u64);
    assert_eq!(second["missed_bytes"], 0);
    assert_eq!(
        second["replay_bytes"],
        after_snapshot.len(),
        "synthetic suffix bytes cannot acknowledge raw output published after the snapshot"
    );
    let mut replay = Vec::new();
    loop {
        match next(&mut client).await {
            ClientMessage::Binary(bytes) => replay.extend_from_slice(&bytes),
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                assert_ne!(frame["type"], "error");
                assert_ne!(frame["type"], "session", "exactly two recoveries");
                if frame["type"] == "ready" {
                    break;
                }
            }
            other => panic!("second recovery ended early: {other:?}"),
        }
    }
    assert_eq!(
        replay, after_snapshot,
        "raw replay is acknowledged once; synthetic mode suffixes are never acknowledged"
    );
}
