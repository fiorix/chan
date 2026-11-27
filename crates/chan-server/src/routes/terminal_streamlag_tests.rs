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
    collections::BTreeSet,
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
const LOST_ALT_SUFFIX: &[u8] = b"\x18\x1b[?1047h\x1b[?1l\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l\x1b[?2004l";

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
        self.attach_with("").await
    }

    /// Attach as a client that reports what it has parsed.
    async fn attach_acking(&self) -> (Client, Value) {
        self.attach_with("&ack=1").await
    }

    async fn attach_with(&self, query: &str) -> (Client, Value) {
        let mut client = bounded(
            "attach terminal socket",
            dial_terminal_with_small_buffer(
                self.address,
                &format!("session={}&cols=80&rows=24{query}", self.handle.id()),
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

async fn ack(client: &mut Client, generation: u64, seq: u64) {
    send(
        client,
        json!({"type": "ack", "generation": generation, "seq": seq}),
    )
    .await;
}

fn number(frame: &Value, key: &str) -> u64 {
    frame[key]
        .as_u64()
        .unwrap_or_else(|| panic!("numeric {key} in {frame}"))
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
                        assert_eq!(
                            replay_screen(&frame),
                            (missed_bytes > 0).then_some("normal"),
                            "a live recovery names its replay's screen only past missed bytes"
                        );
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
        dial_terminal_with_small_buffer(address, &format!("session={id}&cols=80&rows=24&ack=1")),
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

/// A view that stops reading and acknowledging, on real sockets: what is
/// asserted is that the program finishes without it (no earlier than about
/// the 5 s release bound, by the >= 4 s check) and the
/// stalled view recovers without loss (one same-generation session frame,
/// zero missed bytes, the retained tail once, the replay suffix and the
/// cursor arithmetic asserted exact). The 5 s value is pinned
/// on a synthetic clock, with no wall time, in
/// pacing/tests::progress_renews_deadline_and_cut_loose_stays_latched
/// and pacing/tests::expiring_one_view_preserves_the_other_views_credit_and_deadline.
///
/// The 8 MiB ring holds the whole ~6.9 MB stream, so no view is evicted
/// and every recovery below is lossless by construction: both missed
/// counts are asserted zero, and the stalled view's replay suffix and
/// cursor arithmetic are asserted exact. A 64 KiB ring would let even
/// the draining view fall behind under load, which makes the live view's
/// outcome a race instead of a contract.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stalled_view_releases_the_program_while_a_second_view_drains() {
    let _gate = pty_test_lock();
    // The child waits for a newline before flooding, so both views attach
    // before the first flood byte and the hold engages by construction:
    // the stream exceeds A's 4 MiB credit by about 2.7 MB once A stops
    // reading, and the stalled view's release is what lets the program
    // finish.
    let rig = Rig::new(
        8 * 1024 * 1024,
        "stty -onlcr; read -r _; seq -f %.0f 1 1000000; printf '__STREAM_DONE__'",
    )
    .await;
    // Socket A attaches before the flood and reads one live frame, then
    // stops draining entirely. The hold engages by construction: every
    // read is capped at the remaining credit and preceded by an admission
    // check, so no chunk jumps the limit, and the ~6.9 MB stream exceeds
    // A's 4 MiB credit (half the 8 MiB ring, or 512 events) by about
    // 2.7 MB (6,888,927 minus 4,194,304), far past what A's fixed 64 KiB
    // socket buffers absorb (doubled on Linux), so a check must park the
    // reader before the flood ends.
    let (mut stalled, initial) = rig.attach_acking().await;
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
    let b_generation = number(&b_session, "generation");
    let b_start = number(&b_session, "seq") - received.len() as u64;
    let started = std::time::Instant::now();
    rig.handle.send_input(b"\n");
    let pre_frame = loop {
        match next(&mut stalled).await {
            ClientMessage::Binary(bytes) => break bytes.len(),
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                assert_ne!(frame["type"], "error", "unexpected terminal error: {frame}");
            }
            other => panic!("stalled socket ended before its first frame: {other:?}"),
        }
    };
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
                ack(&mut draining, b_generation, b_start + received.len() as u64).await;
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
    // Hang guard, not a contract bound: 180 s is fourteen times the 12.6 s
    // macOS run and thirty-two times the 5.57 s host worst. A green run
    // never prints the timing line, so the guard names it.
    assert!(
        elapsed <= std::time::Duration::from_secs(180),
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
    // is the machine's like the drain's, so a hang guard, not a contract
    // bound, applies: 60 s, sized like the drain guard, since a green run
    // never prints the timing line and the guard names the elapsed time.
    // The resume replays about 6.6 MB through one socket.
    let resume_at = std::time::Instant::now();
    let resume_bound = std::time::Duration::from_secs(60);
    let mut sessions = 0;
    let mut tail = Vec::new();
    let generation = number(&initial, "generation");
    let resumed_at = number(&initial, "seq") + pre_frame as u64;
    ack(&mut stalled, generation, resumed_at).await;
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
                // Recovery waits until the view has parsed its backlog.
                ack(&mut stalled, generation, resumed_at + tail.len() as u64).await;
            }
            other => panic!("stalled view ended during recovery: {other:?}"),
        }
    };
    assert_eq!(
        recovery["generation"], initial["generation"],
        "recovery keeps the incarnation"
    );
    // Bytes arriving before the recovery frame are the socket's own
    // stalled backlog: the server kept sending into kernel buffers the
    // test never drained, and those sends complete once the test reads
    // again, ahead of the re-attach. TCP keeps them complete and in
    // order, so the frame's replay count plus cursor arithmetic below
    // check the whole stream exactly.
    let stale_len = tail.len();
    let missed = recovery["missed_bytes"]
        .as_u64()
        .expect("numeric missed_bytes");
    // The 8 MiB ring holds the whole ~6.9 MB stream, so the stalled view
    // is never evicted: the release reports a zero missed count, and the
    // attach cursor plus the consumed first frame plus the drained
    // backlog plus the replayed bytes must reach the recovery cursor.
    assert_eq!(
        missed, 0,
        "a stalled view behind a fitting stream keeps every byte: {missed}"
    );
    let replay = recovery["replay_bytes"]
        .as_u64()
        .expect("numeric replay_bytes") as usize;
    let initial_seq = initial["seq"].as_u64().expect("numeric attach seq");
    let recovery_seq = recovery["seq"].as_u64().expect("numeric recovery seq");
    assert_eq!(
        initial_seq + pre_frame as u64 + stale_len as u64 + missed + replay as u64,
        recovery_seq,
        "attach cursor plus consumed plus backlog plus replayed reaches the recovery cursor"
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
            ClientMessage::Binary(bytes) => {
                tail.extend_from_slice(&bytes);
                // The replay is itself paced by the window.
                let replayed = (tail.len() - stale_len) as u64;
                ack(
                    &mut stalled,
                    generation,
                    recovery_seq - replay as u64 + replayed,
                )
                .await;
            }
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
    let post = &tail[stale_len..];
    let suffix_at = expected
        .len()
        .checked_sub(replay)
        .expect("replay fits the expected stream");
    assert_eq!(
        post,
        &expected[suffix_at..],
        "bytes after the recovery frame equal the last replay bytes of the stream"
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

/// Dial `query` and collect its attach window up to Ready: the session
/// frame and the raw bytes before and after it.
async fn dial_until_ready(
    address: std::net::SocketAddr,
    query: &str,
) -> (Client, Value, Vec<u8>, Vec<u8>) {
    let mut client = bounded(
        "dial terminal socket",
        dial_terminal_with_small_buffer(address, query),
    )
    .await;
    let (mut session, mut before, mut after) = (None, Vec::new(), Vec::new());
    loop {
        match next(&mut client).await {
            ClientMessage::Binary(bytes) if session.is_none() => before.extend_from_slice(&bytes),
            ClientMessage::Binary(bytes) => after.extend_from_slice(&bytes),
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                match frame["type"].as_str() {
                    Some("session") => {
                        assert!(session.is_none(), "one session frame before Ready");
                        session = Some(frame);
                    }
                    Some("ready") => {
                        let session = session.expect("session before Ready");
                        return (client, session, before, after);
                    }
                    Some("error" | "exit" | "closed") => panic!("the dial ended: {frame}"),
                    _ => {}
                }
            }
            other => panic!("the dial ended before Ready: {other:?}"),
        }
    }
}

/// Attach a view, show it `modes` and drop its socket the way a sleep or a
/// network drop does, keeping the widget that parsed them. Returns the
/// view's generation and cursor, which its redial echoes.
async fn view_modes_then_drop(rig: &Rig, modes: &[u8]) -> (u64, u64) {
    let (mut client, initial) = rig.attach().await;
    rig.output(modes);
    assert_eq!(next_binary(&mut client).await, modes);
    drop(client);
    (
        number(&initial, "generation"),
        number(&initial, "seq") + modes.len() as u64,
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_redial_past_a_lost_mode_reset_gets_the_live_recovery_suffix() {
    const RING: usize = 4096;
    let _gate = pty_test_lock();
    let rig = Rig::new(RING, "while IFS= read -r line; do :; done").await;
    let (generation, cursor) = view_modes_then_drop(&rig, b"\x1b[?1049h\x1b[?1000h").await;
    // The program resets its modes while the socket is down, and the ring
    // moves past the reset before the redial.
    let lost = b"\x1b[?1049l\x1b[?1000l";
    rig.output(lost);
    let shell = vec![b's'; RING / 4];
    for _ in 0..4 {
        rig.output(&shell);
    }
    let (_redial, session, before, after) = dial_until_ready(
        rig.address,
        &format!(
            "session={}&cols=80&rows=24&since={cursor}&generation={generation}",
            rig.handle.id()
        ),
    )
    .await;
    assert_eq!(
        number(&session, "generation"),
        generation,
        "fixture: the same PTY life"
    );
    assert_eq!(
        number(&session, "missed_bytes"),
        lost.len() as u64,
        "fixture: the ring moved past the cursor and the reset with it"
    );
    let replay = number(&session, "replay_bytes") as usize;
    assert_eq!(replay, RING, "fixture: the ring's tail is replayed");
    assert!(
        before.is_empty(),
        "a redial of the same PTY life gets no reset before its session frame"
    );
    assert_eq!(
        replay_screen(&session),
        Some("normal"),
        "the session frame names the normal screen the lost reset selected"
    );
    assert_eq!(after[..replay], shell.repeat(4)[..]);
    assert_eq!(
        String::from_utf8_lossy(&after[replay..]),
        String::from_utf8_lossy(LOST_PLAIN_SUFFIX),
        "a redial that lost bytes gets the live recovery suffix after its replay"
    );
}

/// A ring of 4 KiB for the redial tests that read the replay's screen: its
/// chunks are the rig's writes, so a test places what the ring keeps.
const SCREEN_RING: usize = 4096;

/// Redial past a ring that kept only the last of `writes`, after a view
/// that parsed `shown` dropped, and return the redial's session frame and
/// its bytes before and after that frame.
async fn redial_past(rig: &Rig, shown: &[u8], writes: &[&[u8]]) -> (Value, Vec<u8>, Vec<u8>) {
    let (generation, cursor) = view_modes_then_drop(rig, shown).await;
    for bytes in writes {
        rig.output(bytes);
    }
    let (_redial, session, before, after) = redial(rig, cursor, generation).await;
    assert_eq!(
        number(&session, "generation"),
        generation,
        "fixture: the same PTY life"
    );
    assert!(
        number(&session, "missed_bytes") > 0,
        "fixture: the ring moved past the view's cursor"
    );
    assert!(
        before.is_empty(),
        "the server sends no screen switch, or any byte, ahead of the session frame"
    );
    (session, before, after)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_redial_past_a_lost_alternate_screen_exit_names_the_normal_screen() {
    let _gate = pty_test_lock();
    let rig = Rig::new(SCREEN_RING, "while IFS= read -r line; do :; done").await;
    let shown = b"$ probe\r\n\x1b[?1049h\x1b[?1000hthe probe's frame";
    // While the socket is down the program resets its mode, leaves its
    // alternate screen, writes past the ring and exits, and the shell
    // prints its prompt. The ring moves past the switch, so the replay
    // holds normal-screen output only.
    let lost = b"\x1b[?1000l\x1b[?1049l";
    let filler = b"filler\r\n".repeat(SCREEN_RING / 4 / 8);
    let tail = b"probe exited\r\n$ ";
    let (session, before, after) = redial_past(
        &rig,
        shown,
        &[lost, &filler, &filler, &filler, &filler, tail],
    )
    .await;
    assert_eq!(
        number(&session, "missed_bytes"),
        (lost.len() + filler.len()) as u64,
        "fixture: the ring moved past the switch to the normal screen"
    );
    let replay = number(&session, "replay_bytes") as usize;
    assert_eq!(
        String::from_utf8_lossy(&after[..replay]),
        String::from_utf8_lossy(&[filler.repeat(3), tail.to_vec()].concat()),
        "the replay is the retained output, unchanged"
    );
    assert_eq!(
        String::from_utf8_lossy(&after[replay..]),
        String::from_utf8_lossy(LOST_PLAIN_SUFFIX),
        "the recovery suffix follows the replay, unchanged"
    );
    assert_eq!(
        replay_screen(&session),
        Some("normal"),
        "the session frame names the normal screen, which the program selected inside the \
         missed span"
    );
    let screens = drawn_after_frame(shown, &session, &before, &after);
    assert!(
        !screens.alternate_shown,
        "the view ends on the normal screen"
    );
    assert!(
        screens.normal.ends_with(tail),
        "a view that takes the named screen draws the program's last line and the prompt on \
         the normal screen: it ends {:?}",
        last(&screens.normal, 32)
    );
    assert_redial_holds_the_program_state(
        shown,
        &after,
        false,
        &[],
        "a redial past an alternate-screen exit",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_redial_past_a_lost_full_reset_names_the_normal_screen() {
    let _gate = pty_test_lock();
    let rig = Rig::new(SCREEN_RING, "while IFS= read -r line; do :; done").await;
    let shown = b"$ probe\r\n\x1b[?1049h\x1b[?1000hthe probe's frame";
    // While the socket is down the program resets the terminal, as
    // `reset` does, which leaves the alternate screen and turns every mode
    // off; it writes past the ring and exits, and the shell prints its
    // prompt. The ring moves past the reset, so the replay holds
    // normal-screen output only.
    let lost = b"\x1bc";
    let filler = b"filler\r\n".repeat(SCREEN_RING / 4 / 8);
    let tail = b"probe exited\r\n$ ";
    let (session, before, after) = redial_past(
        &rig,
        shown,
        &[lost, &filler, &filler, &filler, &filler, tail],
    )
    .await;
    assert_eq!(
        number(&session, "missed_bytes"),
        (lost.len() + filler.len()) as u64,
        "fixture: the ring moved past the reset"
    );
    let replay = number(&session, "replay_bytes") as usize;
    assert_eq!(
        String::from_utf8_lossy(&after[..replay]),
        String::from_utf8_lossy(&[filler.repeat(3), tail.to_vec()].concat()),
        "fixture: the replay is the retained output, unchanged"
    );
    assert_eq!(
        replay_screen(&session),
        Some("normal"),
        "the session frame names the normal screen, which the program's reset selected \
         inside the missed span"
    );
    assert_eq!(
        String::from_utf8_lossy(&after[replay..]),
        String::from_utf8_lossy(LOST_PLAIN_SUFFIX),
        "the recovery suffix follows the replay and reasserts no mode the reset turned off"
    );
    let screens = drawn_after_frame(shown, &session, &before, &after);
    assert!(
        !screens.alternate_shown,
        "the view ends on the normal screen"
    );
    assert!(
        screens.normal.ends_with(tail),
        "a view that takes the named screen draws the program's last line and the prompt on \
         the normal screen: it ends {:?}",
        last(&screens.normal, 32)
    );
    assert_redial_holds_the_program_state(shown, &after, false, &[], "a redial past a full reset");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_redial_past_a_lost_exit_names_the_normal_screen_before_a_redundant_one() {
    let _gate = pty_test_lock();
    let rig = Rig::new(SCREEN_RING, "while IFS= read -r line; do :; done").await;
    let shown = b"$ probe\r\n\x1b[?1049h\x1b[?1000hthe probe's frame";
    // The retained output ends with a switch to the normal screen that
    // the program was already on, as a prompt's reset can send.
    let filler = b"filler\r\n".repeat(SCREEN_RING / 4 / 8);
    let tail = b"IMPORTANT_NORMAL_LINE\r\n\x1b[?1049l$ ";
    let (session, before, after) = redial_past(
        &rig,
        shown,
        &[
            b"\x1b[?1000l\x1b[?1049l",
            &filler,
            &filler,
            &filler,
            &filler,
            tail,
        ],
    )
    .await;
    assert_eq!(
        replay_screen(&session),
        Some("normal"),
        "the session frame names the screen the replay starts on, not the opposite of its \
         first switch"
    );
    let screens = drawn_after_frame(shown, &session, &before, &after);
    assert!(
        screens.normal.ends_with(b"IMPORTANT_NORMAL_LINE\r\n$ "),
        "the output before the redundant switch is drawn on the normal screen: it ends {:?}",
        last(&screens.normal, 32)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_redial_past_a_lost_alternate_screen_entry_names_the_alternate_screen() {
    let _gate = pty_test_lock();
    let rig = Rig::new(SCREEN_RING, "while IFS= read -r line; do :; done").await;
    let shown = b"$ probe\r\n";
    // While the socket is down a program enters its alternate screen,
    // draws past the ring, then leaves it and exits inside the retained
    // tail.
    let frames = b"\x1b[Hframe".repeat(SCREEN_RING / 4 / 8);
    let tail = b"\x1b[?1000l\x1b[?1049lprobe exited\r\n$ ";
    let (session, before, after) = redial_past(
        &rig,
        shown,
        &[
            b"\x1b[?1049h\x1b[?1000h",
            &frames,
            &frames,
            &frames,
            &frames,
            tail,
        ],
    )
    .await;
    assert_eq!(
        replay_screen(&session),
        Some("alternate"),
        "the session frame names the alternate screen the program entered inside the missed \
         span"
    );
    let screens = drawn_after_frame(shown, &session, &before, &after);
    assert!(
        !screens.alternate_shown,
        "the view ends on the normal screen"
    );
    assert_eq!(
        String::from_utf8_lossy(&screens.normal),
        "$ probe\r\nprobe exited\r\n$ ",
        "the program's frames are drawn on its alternate screen, and only its last output on \
         the normal screen"
    );
    assert_redial_holds_the_program_state(
        shown,
        &after,
        false,
        &[],
        "a redial past an alternate-screen entry",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_redial_whose_replay_leaves_the_alternate_screen_names_it() {
    let _gate = pty_test_lock();
    let rig = Rig::new(SCREEN_RING, "while IFS= read -r line; do :; done").await;
    let shown = b"$ probe\r\n\x1b[?1049h\x1b[?1000h";
    // The program draws past the ring on the alternate screen the view
    // shows, then leaves it and exits inside the retained tail.
    let frames = b"\x1b[Hframe".repeat(SCREEN_RING / 4 / 8);
    let tail = b"\x1b[?1000l\x1b[?1049lprobe exited\r\n$ ";
    let (session, before, after) =
        redial_past(&rig, shown, &[&frames, &frames, &frames, &frames, tail]).await;
    assert_eq!(
        replay_screen(&session),
        Some("alternate"),
        "the session frame names the alternate screen, which the view already shows"
    );
    let screens = drawn_after_frame(shown, &session, &before, &after);
    assert_eq!(
        String::from_utf8_lossy(&screens.normal),
        "$ probe\r\nprobe exited\r\n$ ",
        "the program's frames stay on its alternate screen"
    );
}

/// The output between two programs, the second of which enters its
/// alternate screen, as one write of nearly the ring's size so that the
/// ring keeps it alone. `head` starts it.
fn between_two_programs(head: &[u8]) -> Vec<u8> {
    let mut bytes = [head, b"BETWEEN_TUIS\r\n\x1b[?1049h"].concat();
    let frame = b"tui2 frame\r\n";
    let rows = (SCREEN_RING - bytes.len()) / frame.len();
    bytes.extend_from_slice(&frame.repeat(rows));
    bytes
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_redial_between_two_programs_names_the_normal_screen_between_them() {
    let _gate = pty_test_lock();
    let rig = Rig::new(SCREEN_RING, "while IFS= read -r line; do :; done").await;
    let shown = b"$ tui1\r\n\x1b[?1049htui1 frame";
    // The first program leaves its alternate screen while the socket is
    // down, the shell prints, and a second program enters its own inside
    // the write the ring keeps.
    let filler = b"filler\r\n".repeat(SCREEN_RING / 4 / 8);
    let between = between_two_programs(b"");
    let (session, before, after) = redial_past(
        &rig,
        shown,
        &[b"\x1b[?1049l", &filler, &filler, &filler, &between],
    )
    .await;
    assert_eq!(
        number(&session, "replay_bytes"),
        between.len() as u64,
        "fixture: the ring keeps the last write alone"
    );
    assert_eq!(
        replay_screen(&session),
        Some("normal"),
        "the session frame names the normal screen of the replay's first byte, not the \
         alternate one its write ends on"
    );
    let screens = drawn_after_frame(shown, &session, &before, &after);
    assert!(
        screens.alternate_shown,
        "the view ends on the second program's alternate screen"
    );
    assert_eq!(
        String::from_utf8_lossy(&screens.normal),
        "$ tui1\r\nBETWEEN_TUIS\r\n",
        "the output between the programs is drawn on the normal screen"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_redial_whose_ring_starts_inside_a_switch_names_the_screen_it_selects() {
    let _gate = pty_test_lock();
    let rig = Rig::new(SCREEN_RING, "while IFS= read -r line; do :; done").await;
    let shown = b"$ tui1\r\n\x1b[?1049htui1 frame";
    // Two reads split the first program's switch to the normal screen, and
    // the ring keeps only the second. A view parses its rest as text, so
    // the screen the switch selects is the one the replay is drawn on.
    let frames = b"\x1b[Hframe".repeat(SCREEN_RING / 4 / 8);
    let between = between_two_programs(b"49l");
    let (session, before, after) =
        redial_past(&rig, shown, &[&frames, b"tui1 last\r\n\x1b[?10", &between]).await;
    assert_eq!(
        number(&session, "replay_bytes"),
        between.len() as u64,
        "fixture: the ring starts inside the switch"
    );
    assert_eq!(
        replay_screen(&session),
        Some("normal"),
        "the session frame names the screen the cut switch selects"
    );
    let screens = drawn_after_frame(shown, &session, &before, &after);
    assert_eq!(
        String::from_utf8_lossy(&screens.normal),
        "$ tui1\r\n49lBETWEEN_TUIS\r\n",
        "the switch's rest and the output after it are drawn on the normal screen"
    );
}

/// The probe's last frame, a bare ESC and the ESC of its switch to the
/// normal screen, as the write that ends there.
const BARE_ESCAPE_HEAD: &[u8] = b"\x1b[?1000lthe probe's last frame\x1b\x1b";

/// The probe's last line and the shell's prompt.
const PROBE_EXITED: &[u8] = b"probe exited\r\n$ ";

/// `head`, the rest of the probe's normal-screen output and
/// [`PROBE_EXITED`], `len` bytes in all.
fn the_probe_exits(head: &[u8], len: usize) -> Vec<u8> {
    let mut bytes = head.to_vec();
    bytes.resize(len - PROBE_EXITED.len(), b'.');
    bytes.extend_from_slice(PROBE_EXITED);
    bytes
}

/// Redial past `writes`, in which the probe left its alternate screen
/// right after a bare ESC, where the ring kept only the last `replay`
/// bytes, from inside the switch, and check that the session frame names
/// the normal screen that switch selects.
async fn assert_a_redial_past_a_bare_escape_names_the_normal_screen(
    writes: &[&[u8]],
    replay: usize,
) {
    let rig = Rig::new(SCREEN_RING, "while IFS= read -r line; do :; done").await;
    let shown = b"$ probe\r\n\x1b[?1049h\x1b[?1000hthe probe's frame";
    let (session, before, after) = redial_past(&rig, shown, writes).await;
    assert_eq!(
        number(&session, "replay_bytes") as usize,
        replay,
        "fixture: the ring keeps the bytes from inside the switch"
    );
    assert_eq!(
        after.first(),
        Some(&b'['),
        "fixture: the ring dropped both ESCs"
    );
    assert_eq!(
        replay_screen(&session),
        Some("normal"),
        "the session frame names the screen the cut switch selects, whatever ESC came before \
         its own"
    );
    assert_eq!(
        String::from_utf8_lossy(&after[replay..]),
        String::from_utf8_lossy(LOST_PLAIN_SUFFIX),
        "the recovery suffix follows the replay, unchanged"
    );
    let screens = drawn_after_frame(shown, &session, &before, &after);
    assert!(
        !screens.alternate_shown,
        "the view ends on the normal screen"
    );
    assert!(
        screens.normal.ends_with(PROBE_EXITED),
        "the probe's last line and the prompt are drawn on the normal screen: it ends {:?}",
        last(&screens.normal, 32)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_redial_whose_ring_starts_inside_a_switch_after_a_bare_escape_names_the_screen_it_selects(
) {
    let _gate = pty_test_lock();
    // Two reads split the switch after its ESC, which a bare one came
    // before, and the ring keeps only the second.
    let kept = the_probe_exits(b"[?1049l", SCREEN_RING - 1);
    assert_a_redial_past_a_bare_escape_names_the_normal_screen(
        &[BARE_ESCAPE_HEAD, &kept],
        kept.len(),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_redial_whose_ring_cuts_a_write_inside_a_switch_after_a_bare_escape_names_the_screen_it_selects(
) {
    let _gate = pty_test_lock();
    // One write larger than the ring holds the bare ESC and the switch,
    // and the ring keeps it from just after the switch's ESC.
    let write = [BARE_ESCAPE_HEAD, &the_probe_exits(b"[?1049l", SCREEN_RING)].concat();
    assert_a_redial_past_a_bare_escape_names_the_normal_screen(&[&write], SCREEN_RING).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_redial_whose_ring_starts_inside_a_switch_split_twice_after_a_bare_escape_names_the_screen_it_selects(
) {
    let _gate = pty_test_lock();
    // Three reads split the switch after its ESC and inside its number,
    // and the ring keeps the last two.
    let kept = the_probe_exits(b"49l", SCREEN_RING - 4);
    assert_a_redial_past_a_bare_escape_names_the_normal_screen(
        &[BARE_ESCAPE_HEAD, b"[?10", &kept],
        SCREEN_RING,
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tmux_pane_redial_names_the_alternate_screen_its_capture_selected() {
    let _gate = pty_test_lock();
    let rig = Rig::tmux(SCREEN_RING).await;
    let shown = b"$ ";
    // While the socket is down the pane is captured on its alternate
    // screen, draws past the ring and is captured again for a redraw, which
    // repeats the switch, in the bytes the gate's capture writes.
    let capture = |rows: &[u8]| {
        [
            b"\x1b[?1049h\x1b[0m\x1b[H\x1b[2J".as_slice(),
            rows,
            b"\x1b[0m\x1b[1;1H",
        ]
        .concat()
    };
    let frames = b"\x1b[Hframe".repeat(SCREEN_RING / 4 / 8);
    let (session, before, after) = redial_past(
        &rig,
        shown,
        &[
            &capture(b"top 1\r\ntop 2"),
            &frames,
            &frames,
            &frames,
            &frames,
            &capture(b"top 3\r\ntop 4"),
        ],
    )
    .await;
    assert_eq!(
        replay_screen(&session),
        Some("alternate"),
        "the session frame names the alternate screen the first capture selected"
    );
    let screens = drawn_after_frame(shown, &session, &before, &after);
    assert!(
        screens.alternate_shown,
        "the view ends on the pane's alternate screen"
    );
    assert_eq!(
        String::from_utf8_lossy(&screens.normal),
        "$ ",
        "none of the pane's frames is drawn on the normal screen"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fresh_dial_past_an_overflowed_ring_names_no_replay_screen() {
    let _gate = pty_test_lock();
    let rig = Rig::new(SCREEN_RING, "while IFS= read -r line; do :; done").await;
    let filler = b"filler\r\n".repeat(SCREEN_RING / 4 / 8);
    for _ in 0..5 {
        rig.output(&filler);
    }
    let (_fresh, session, before, _after) = dial_until_ready(
        rig.address,
        &format!("session={}&cols=80&rows=24&since=0", rig.handle.id()),
    )
    .await;
    assert!(
        number(&session, "missed_bytes") > 0,
        "fixture: the ring overflowed before the dial"
    );
    assert!(before.is_empty());
    assert_eq!(
        replay_screen(&session),
        None,
        "a fresh view dialed at 0 parsed none of the missed span, so it gets no screen"
    );
}

/// Show a live view of `rig` `shown`, then block its socket's send and,
/// while the socket stays up, let the program write `lost`, flood past the
/// ring and write `tail`. Returns everything the view parsed before the
/// recovery (`shown` and the blocked frame), the recovery's session frame,
/// and its bytes before and after that frame, read to Ready.
async fn live_recovery_past(
    rig: &Rig,
    shown: &[u8],
    lost: &[u8],
    tail: &[u8],
) -> (Vec<u8>, Value, Vec<u8>, Vec<u8>) {
    let (mut client, _initial) = rig.attach().await;
    rig.output(shown);
    assert_eq!(next_binary(&mut client).await, shown);
    let _pending = rig.block_output().await;
    rig.output(lost);
    rig.flood();
    rig.output(tail);
    finish_blocked_frame(&mut client).await;
    let (mut session, mut before, mut after) = (None, Vec::new(), Vec::new());
    loop {
        match next(&mut client).await {
            ClientMessage::Binary(bytes) if session.is_none() => before.extend_from_slice(&bytes),
            ClientMessage::Binary(bytes) => after.extend_from_slice(&bytes),
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                match frame["type"].as_str() {
                    Some("session") => session = Some(frame),
                    Some("ready") => break,
                    Some("error") => panic!("lag recovery error: {frame}"),
                    _ => {}
                }
            }
            other => panic!("recovery ended before ready: {other:?}"),
        }
    }
    let session = session.expect("a recovery session frame");
    assert!(
        number(&session, "missed_bytes") > 0,
        "fixture: the ring moved past the view"
    );
    assert!(
        before.is_empty(),
        "the live recovery sends no byte ahead of its session frame"
    );
    let parsed = [shown, &vec![b'B'; BLOCKED_BYTES]].concat();
    (parsed, session, before, after)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lossy_live_recovery_past_a_lost_alternate_screen_exit_names_the_normal_screen() {
    let _gate = pty_test_lock();
    let rig = Rig::new(16 * 1024, "while IFS= read -r line; do :; done").await;
    let shown = b"$ probe\r\n\x1b[?1049h\x1b[?1000hthe probe's frame";
    // The socket stays up while its send blocks; the program leaves its
    // alternate screen and floods past the ring meanwhile.
    let tail = b"probe exited\r\n$ ";
    let (shown, session, before, after) =
        live_recovery_past(&rig, shown, b"\x1b[?1000l\x1b[?1049l", tail).await;
    assert_eq!(
        replay_screen(&session),
        Some("normal"),
        "the live recovery's session frame names the normal screen the program selected \
         while the view was behind"
    );
    let screens = drawn_after_frame(&shown, &session, &before, &after);
    assert!(
        !screens.alternate_shown,
        "the view ends on the normal screen"
    );
    assert!(
        screens.normal.ends_with(tail),
        "the retained tail is drawn on the normal screen: it ends {:?}",
        last(&screens.normal, 32)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lossy_live_recovery_past_a_lost_full_reset_names_the_normal_screen() {
    let _gate = pty_test_lock();
    let rig = Rig::new(16 * 1024, "while IFS= read -r line; do :; done").await;
    let shown = b"$ probe\r\n\x1b[?1049h\x1b[?1000hthe probe's frame";
    // The socket stays up while its send blocks; the program resets the
    // terminal, as `reset` does, and floods past the ring meanwhile.
    let tail = b"probe exited\r\n$ ";
    let (shown, session, before, after) = live_recovery_past(&rig, shown, b"\x1bc", tail).await;
    let replay = number(&session, "replay_bytes") as usize;
    assert!(
        after.len() >= replay && after[..replay].ends_with(tail),
        "fixture: the replay ends with the retained tail"
    );
    assert_eq!(
        replay_screen(&session),
        Some("normal"),
        "the live recovery's session frame names the normal screen the program's reset \
         selected while the view was behind"
    );
    assert_eq!(
        String::from_utf8_lossy(&after[replay..]),
        String::from_utf8_lossy(LOST_PLAIN_SUFFIX),
        "the recovery suffix follows the replay and reasserts no mode the reset turned off"
    );
    let screens = drawn_after_frame(&shown, &session, &before, &after);
    assert!(
        !screens.alternate_shown,
        "the view ends on the normal screen"
    );
    assert!(
        screens.normal.ends_with(tail),
        "the retained tail is drawn on the normal screen: it ends {:?}",
        last(&screens.normal, 32)
    );
    assert_redial_holds_the_program_state(
        &shown,
        &after,
        false,
        &[],
        "a live recovery past a full reset",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_redial_across_a_restart_gets_the_restart_reset() {
    let _gate = pty_test_lock();
    let rig = Rig::new(64 * 1024, "while IFS= read -r line; do :; done").await;
    let (generation, cursor) = view_modes_then_drop(&rig, b"\x1b[?1049h\x1b[?1000h").await;
    assert!(rig
        .state
        .terminal_sessions
        .restart(rig.handle.id(), RestartOverrides::default())
        .expect("restart controlled child"));
    // The next life prints before the redial, so its replay is not empty.
    let mut next_life = rig
        .state
        .terminal_sessions
        .attach_for_ws(rig.handle.id(), None, None)
        .expect("watch the next PTY life");
    assert_ne!(next_life.generation, generation, "fixture: a new PTY life");
    let mut printed = next_life.replay.concat();
    bounded("the next PTY life prints", async {
        while !printed
            .windows(CHILD_READY.len())
            .any(|bytes| bytes == CHILD_READY)
        {
            match next_life.rx.recv().await {
                Ok(SessionEvent::Output(bytes)) => printed.extend_from_slice(&bytes),
                Ok(_) => {}
                Err(error) => panic!("next PTY life event: {error}"),
            }
        }
    })
    .await;
    let (_redial, session, before, after) = dial_until_ready(
        rig.address,
        &format!(
            "session={}&cols=80&rows=24&since={cursor}&generation={generation}",
            rig.handle.id()
        ),
    )
    .await;
    assert_eq!(session["id"], rig.handle.id(), "fixture: the same session");
    assert_eq!(
        session["generation"], next_life.generation,
        "fixture: the redial reached the next PTY life"
    );
    // A live socket gets RESET_TERMINAL ahead of the new life's session
    // frame, and so does a redial: a client takes what precedes its session
    // frame as the old life's output.
    assert_eq!(
        String::from_utf8_lossy(&before),
        String::from_utf8_lossy(RESET_TERMINAL),
        "a redial across a restart gets the restart's reset ahead of its session frame"
    );
    let received = [before, after].concat();
    assert_eq!(
        String::from_utf8_lossy(&received[..received.len().min(RESET_TERMINAL.len())]),
        String::from_utf8_lossy(RESET_TERMINAL),
        "a redial across a restart gets the restart's reset before the new replay: {:?}",
        String::from_utf8_lossy(&received[..received.len().min(64)])
    );
    assert!(
        received[RESET_TERMINAL.len()..]
            .windows(CHILD_READY.len())
            .any(|bytes| bytes == CHILD_READY),
        "the new life's replay follows the reset"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_redial_a_restart_overtakes_before_its_lookup_gets_the_restart_reset() {
    let _gate = pty_test_lock();
    a_restart_overtakes_a_redial_at(AttachSeam::ResumeBeforeLookup).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_redial_a_restart_overtakes_before_its_attach_gets_the_restart_reset() {
    let _gate = pty_test_lock();
    a_restart_overtakes_a_redial_at(AttachSeam::ResumeBeforeAttach).await;
}

/// A restart overtakes a redial inside its attach, at `seam`: before the
/// attach looks the session up, or once the redial's resume is chosen and
/// before that session is attached. A generation read by a lookup of its
/// own ahead of the attach's would be stale at the first point, and a
/// session taken by a second lookup after the choice at the second. At
/// either, the redial gets the restart's reset and the next life's replay
/// from its start.
async fn a_restart_overtakes_a_redial_at(seam: AttachSeam) {
    let rig = Rig::new(64 * 1024, "while IFS= read -r line; do :; done").await;
    let shown = b"\x1b[?1049h\x1b[?1000h";
    let (generation, cursor) = view_modes_then_drop(&rig, shown).await;
    // The next life prints past the old life's cursor, so that cursor
    // would fall inside the next life's output.
    let next_life = vec![b'n'; 2 * cursor as usize];
    let registry = rig.state.terminal_sessions.clone();
    let id = rig.handle.id().to_owned();
    let printed = next_life.clone();
    arm_attach_seam(&id.clone(), seam, move || {
        assert!(registry
            .restart(&id, RestartOverrides::default())
            .expect("restart controlled child"));
        assert!(registry.inject_output(&id, &printed));
    });
    let mut client = bounded(
        "dial terminal socket",
        dial_terminal_with_small_buffer(
            rig.address,
            &format!(
                "session={}&cols=80&rows=24&since={cursor}&generation={generation}",
                rig.handle.id()
            ),
        ),
    )
    .await;
    // Read to the Ready that follows the next life's session frame. A view
    // of the old life may come first and end at the restart, as a live
    // socket's does.
    let (mut received, mut next_session) = (Vec::new(), None);
    let split = loop {
        match next(&mut client).await {
            ClientMessage::Binary(bytes) => received.extend_from_slice(&bytes),
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                match frame["type"].as_str() {
                    Some("session") if number(&frame, "generation") != generation => {
                        assert!(next_session.is_none(), "one session frame of the next life");
                        next_session = Some((frame, received.len()));
                    }
                    Some("ready") => {
                        if let Some((_, split)) = &next_session {
                            break *split;
                        }
                    }
                    Some("error" | "exit" | "closed") => panic!("the dial ended: {frame}"),
                    _ => {}
                }
            }
            other => panic!("the dial ended before Ready: {other:?}"),
        }
    };
    let (session, _) = next_session.expect("the next life's session frame");
    let (before, after) = received.split_at(split);
    assert!(
        before.ends_with(RESET_TERMINAL),
        "a redial a restart overtook gets the restart's reset ahead of the next life's \
         session frame, got {:?} before it",
        String::from_utf8_lossy(before)
    );
    assert_eq!(
        number(&session, "replay_bytes"),
        number(&session, "seq"),
        "the next life replays from its start, not from the old life's cursor"
    );
    assert!(
        after
            .windows(next_life.len())
            .any(|bytes| bytes == next_life),
        "the next life's output follows the reset"
    );
    assert_eq!(
        parsed_modes(&[&shown[..], &received].concat()),
        (false, BTreeSet::new()),
        "no mode of the old life survives on the view"
    );
}

/// What a terminal holds after parsing `bytes` of the state a redial must
/// not leave stale: whether it is on the alternate screen, and which other
/// DEC private modes are on. CAN, an escape or the end cuts a partial
/// sequence short, a final other than `h` or `l` (a DECRQM query) changes
/// nothing, and RIS resets the terminal, as in the client's core.
fn parsed_modes(bytes: &[u8]) -> (bool, BTreeSet<u16>) {
    let (mut alt_screen, mut modes) = (false, BTreeSet::new());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at..].starts_with(b"\x1bc") {
            (alt_screen, modes) = (false, BTreeSet::new());
            at += 2;
            continue;
        }
        if !bytes[at..].starts_with(b"\x1b[?") {
            at += 1;
            continue;
        }
        let start = at + 3;
        let end = start
            + bytes[start..]
                .iter()
                .take_while(|byte| byte.is_ascii_digit() || **byte == b';')
                .count();
        at = end;
        let on = match bytes.get(end) {
            Some(b'h') => true,
            Some(b'l') => false,
            _ => continue,
        };
        at = end + 1;
        for param in bytes[start..end].split(|byte| *byte == b';') {
            let Some(mode) = std::str::from_utf8(param)
                .ok()
                .and_then(|param| param.parse::<u16>().ok())
            else {
                continue;
            };
            match mode {
                47 | 1047 | 1049 => alt_screen = on,
                _ if on => {
                    modes.insert(mode);
                }
                _ => {
                    modes.remove(&mode);
                }
            }
        }
    }
    (alt_screen, modes)
}

#[test]
fn parsed_modes_reads_switches_cut_sequences_queries_and_resets() {
    assert_eq!(
        parsed_modes(b"\x1b[?1049;1000h\x1b[?1h"),
        (true, BTreeSet::from([1, 1000]))
    );
    assert_eq!(
        parsed_modes(b"\x1b[?1000h\x1b[?10\x18\x1b[?1l00l"),
        (false, BTreeSet::from([1000])),
        "CAN cuts the reset short and its digits are text"
    );
    assert_eq!(
        parsed_modes(b"\x1b[?1049h\x1b[?1000h\x1b[?1047l\x1b[?1000$p"),
        (false, BTreeSet::from([1000])),
        "a query is not a reset"
    );
    assert_eq!(
        parsed_modes(b"\x1b[?1049h\x1b[?1000h\x1bc"),
        (false, BTreeSet::new())
    );
}

/// The text a terminal draws on each of its screens as it parses a stream,
/// in the order it lands there, and the screen it shows at the end.
#[derive(Debug, Default)]
struct DrawnScreens {
    normal: Vec<u8>,
    alternate: Vec<u8>,
    alternate_shown: bool,
}

/// Follow the screen switches in `bytes` (47, 1047 and 1049) and put every
/// printed byte, CR and LF included, on the screen shown when it arrives.
/// Escapes print nothing, CAN or an escape cuts a partial CSI short, a
/// switch takes only digits and semicolons after its `?`, and RIS clears
/// both screens and shows the normal one. Cursor motion and erases are not
/// followed: the redial tests read where output lands, not the grid it
/// makes.
fn drawn_screens(bytes: &[u8]) -> DrawnScreens {
    let mut screens = DrawnScreens::default();
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            0x1b if bytes.get(at + 1) == Some(&b'[') => {
                let start = at + 2;
                let end = start
                    + bytes[start..]
                        .iter()
                        .take_while(|byte| (0x20..=0x3f).contains(*byte))
                        .count();
                at = end;
                let Some(&last) = bytes.get(end).filter(|byte| (0x40..=0x7e).contains(*byte))
                else {
                    continue;
                };
                at = end + 1;
                let Some(params) = bytes[start..end].strip_prefix(b"?") else {
                    continue;
                };
                if !matches!(last, b'h' | b'l') {
                    continue;
                }
                let switches = params
                    .iter()
                    .all(|byte| byte.is_ascii_digit() || *byte == b';')
                    && params
                        .split(|byte| *byte == b';')
                        .any(|param| matches!(param, b"47" | b"1047" | b"1049"));
                if switches {
                    screens.alternate_shown = last == b'h';
                }
            }
            0x1b if bytes.get(at + 1) == Some(&b'c') => {
                screens = DrawnScreens::default();
                at += 2;
            }
            // An escape before another starts nothing: the second begins
            // its own sequence.
            0x1b if bytes.get(at + 1) == Some(&0x1b) => at += 1,
            0x1b => at += 2,
            byte if byte >= 0x20 || matches!(byte, b'\r' | b'\n') => {
                if screens.alternate_shown {
                    screens.alternate.push(byte);
                } else {
                    screens.normal.push(byte);
                }
                at += 1;
            }
            _ => at += 1,
        }
    }
    screens
}

#[test]
fn drawn_screens_puts_text_on_the_screen_shown_when_it_arrives() {
    let screens = drawn_screens(
        b"$ top\r\n\x1b[?1049;1000hframe\x1b[?1000;1049l\x1b7\x18exited\r\n\x1b[?1047hagain",
    );
    assert_eq!(
        String::from_utf8_lossy(&screens.normal),
        "$ top\r\nexited\r\n"
    );
    assert_eq!(String::from_utf8_lossy(&screens.alternate), "frameagain");
    assert!(screens.alternate_shown);
    let screens = drawn_screens(b"\x1b[?1049h\x1b[?104\x18\x1b[?1049$pon\x1b[2Jit");
    assert_eq!(
        String::from_utf8_lossy(&screens.alternate),
        "onit",
        "a cut CSI, a query and an erase switch nothing"
    );
    let screens = drawn_screens(b"\x1b\x1b[?1049hon\x1b[?1049;1000 lstill\x1b[?1049;?1lstill");
    assert_eq!(
        (
            String::from_utf8_lossy(&screens.alternate),
            screens.alternate_shown
        ),
        ("onstillstill".into(), true),
        "a doubled escape starts the switch, and a CSI with an intermediate or a second `?` \
         is none"
    );
    let screens = drawn_screens(b"\x1b[?47hframe\x1bcplain");
    assert_eq!(
        (screens.normal, screens.alternate, screens.alternate_shown),
        (b"plain".to_vec(), Vec::new(), false),
        "RIS clears both screens and shows the normal one"
    );
}

/// The screen a session frame names for its replay's first byte, when it
/// names one.
fn replay_screen(session: &Value) -> Option<&str> {
    match &session["replay_screen"] {
        Value::Null => None,
        Value::String(screen) if screen == "normal" || screen == "alternate" => Some(screen),
        other => panic!("replay_screen is \"normal\" or \"alternate\" when present: {other}"),
    }
}

/// What a view draws when it parses `shown`, then the bytes a socket sent
/// ahead of its session frame, then the bytes after the frame. Where the
/// frame names a replay screen the view does not show, the view switches to
/// it before the replay, as the tab does, without the server sending a byte
/// for it.
fn drawn_after_frame(shown: &[u8], session: &Value, before: &[u8], after: &[u8]) -> DrawnScreens {
    let mut stream = [shown, before].concat();
    if let Some(screen) = replay_screen(session) {
        let alternate = screen == "alternate";
        if drawn_screens(&stream).alternate_shown != alternate {
            stream.extend_from_slice(if alternate {
                b"\x1b[?1047h"
            } else {
                b"\x1b[?1047l"
            });
        }
    }
    stream.extend_from_slice(after);
    drawn_screens(&stream)
}

/// The last `n` bytes of `text`, for a message.
fn last(text: &[u8], n: usize) -> std::borrow::Cow<'_, str> {
    String::from_utf8_lossy(&text[text.len().saturating_sub(n)..])
}

/// A view that parsed `shown` and then its redial's `after` holds the
/// alternate screen and the modes its program has now, and none of the
/// state the program left while the socket was down.
fn assert_redial_holds_the_program_state(
    shown: &[u8],
    after: &[u8],
    alt_screen: bool,
    modes: &[u16],
    redial: &str,
) {
    let (view_alt_screen, view_modes) = parsed_modes(&[shown, after].concat());
    assert_eq!(
        (view_alt_screen, view_modes.into_iter().collect::<Vec<_>>()),
        (alt_screen, modes.to_vec()),
        "{redial} holds the program's alternate screen and modes, (alternate screen, modes \
         on), and none its program left while the socket was down"
    );
}

/// Redial a view of `rig` from `cursor` in `generation`, as the client does
/// after its socket ends.
async fn redial(rig: &Rig, cursor: u64, generation: u64) -> (Client, Value, Vec<u8>, Vec<u8>) {
    dial_until_ready(
        rig.address,
        &format!(
            "session={}&cols=80&rows=24&since={cursor}&generation={generation}",
            rig.handle.id()
        ),
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_alternate_screen_redial_holds_no_mode_its_program_reset_while_away() {
    let _gate = pty_test_lock();
    let rig = Rig::new(64 * 1024, "while IFS= read -r line; do :; done").await;
    let shown = b"\x1b[?1049h\x1b[?1000h";
    let (generation, cursor) = view_modes_then_drop(&rig, shown).await;
    // The program turns mouse tracking off while the socket is down and
    // draws on its alternate screen. Nothing is lost.
    let away = b"\x1b[?1000l\x1b[2;1Hthe program's alternate screen";
    rig.output(away);
    let (_redial, session, before, after) = redial(&rig, cursor, generation).await;
    assert_eq!(
        number(&session, "generation"),
        generation,
        "fixture: the same PTY life"
    );
    assert_eq!(
        number(&session, "missed_bytes"),
        0,
        "fixture: nothing was lost"
    );
    assert!(before.is_empty(), "fixture: no reset for the same life");
    assert_eq!(
        replay_screen(&session),
        None,
        "a redial that missed nothing names no replay screen"
    );
    assert_redial_holds_the_program_state(
        shown,
        &after,
        true,
        &[],
        "a lossless alternate-screen redial",
    );
    assert_eq!(
        number(&session, "replay_bytes"),
        away.len() as u64,
        "the redial replays the raw delta after its cursor"
    );
    assert_eq!(
        String::from_utf8_lossy(&after),
        String::from_utf8_lossy(away),
        "the delta continues the view's screen with nothing added: no alternate-screen \
         attach prelude and no mode bytes"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_acknowledging_redial_larger_than_the_window_replays_its_delta_within_credit() {
    let _gate = pty_test_lock();
    let rig = Rig::new(64 * 1024, "while IFS= read -r line; do :; done").await;
    let shown = b"\x1b[?1049h\x1b[?1000h";
    let (generation, cursor) = view_modes_then_drop(&rig, shown).await;
    // While the socket is down the program turns mouse tracking off and
    // draws more than the window on its alternate screen. Nothing is lost.
    let reset = b"\x1b[?1000l";
    rig.output(reset);
    let chunk = vec![b'd'; 1024];
    for _ in 0..40 {
        rig.output(&chunk);
    }
    let delta = (reset.len() + 40 * chunk.len()) as u64;
    // The app's redial: it echoes its cursor and generation, and reports
    // what it parsed whenever the replay goes quiet.
    let mut client = bounded(
        "dial terminal socket",
        dial_terminal_with_small_buffer(
            rig.address,
            &format!(
                "session={}&cols=80&rows=24&since={cursor}&generation={generation}&ack=1",
                rig.handle.id()
            ),
        ),
    )
    .await;
    let (mut session, mut after): (Option<Value>, Vec<u8>) = (None, Vec::new());
    let (mut acked, mut quiet, mut waits) = (0u64, 0usize, 0usize);
    loop {
        match tokio::time::timeout(std::time::Duration::from_millis(400), client.next()).await {
            Err(_) => {
                quiet += 1;
                assert!(
                    quiet < 20,
                    "the redial never reached Ready: {} of {delta} bytes",
                    after.len()
                );
                // A client reports only once a session frame gave it a window.
                if session.is_some() {
                    waits += 1;
                    acked = after.len() as u64;
                    ack(&mut client, generation, cursor + acked).await;
                }
            }
            Ok(Some(Ok(ClientMessage::Binary(bytes)))) => {
                after.extend_from_slice(&bytes);
                let frame = session.as_ref().expect("session before the replay");
                assert!(
                    after.len() as u64 <= acked + number(frame, "ack_window"),
                    "the replay never runs past the credit the view's reports give: {} sent, \
                     {acked} reported",
                    after.len()
                );
            }
            Ok(Some(Ok(ClientMessage::Text(text)))) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                match frame["type"].as_str() {
                    Some("session") => session = Some(frame),
                    Some("ready") => break,
                    Some("error" | "exit" | "closed") => panic!("the dial ended: {frame}"),
                    _ => {}
                }
            }
            other => panic!("the dial ended before Ready: {other:?}"),
        }
    }
    let session = session.expect("session before Ready");
    assert_eq!(
        number(&session, "generation"),
        generation,
        "fixture: the same PTY life"
    );
    assert_eq!(
        number(&session, "missed_bytes"),
        0,
        "fixture: nothing was lost"
    );
    assert!(
        number(&session, "ack_window") < delta,
        "fixture: the delta is larger than the window"
    );
    assert_eq!(
        (
            number(&session, "seq") - number(&session, "replay_bytes"),
            number(&session, "replay_bytes")
        ),
        (cursor, delta),
        "the redial replays the delta from its cursor"
    );
    assert_eq!(
        after.len() as u64,
        delta,
        "an acknowledging redial gets the delta and nothing else"
    );
    assert_redial_holds_the_program_state(
        shown,
        &after,
        true,
        &[],
        "an acknowledging redial larger than the window",
    );
    assert!(waits > 0, "fixture: the replay waited for credit");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lossy_alternate_screen_redial_holds_no_mode_its_program_reset_while_away() {
    const RING: usize = 4096;
    let _gate = pty_test_lock();
    let rig = Rig::new(RING, "while IFS= read -r line; do :; done").await;
    let shown = b"\x1b[?1049h\x1b[?1000h";
    let (generation, cursor) = view_modes_then_drop(&rig, shown).await;
    // The program turns mouse tracking off while the socket is down and
    // stays on its alternate screen; the ring moves past the reset.
    let lost = b"\x1b[?1000l";
    rig.output(lost);
    let screen = vec![b'a'; RING / 4];
    for _ in 0..4 {
        rig.output(&screen);
    }
    let (_redial, session, before, after) = redial(&rig, cursor, generation).await;
    assert_eq!(
        number(&session, "generation"),
        generation,
        "fixture: the same PTY life"
    );
    assert!(before.is_empty(), "fixture: no reset for the same life");
    assert_eq!(
        replay_screen(&session),
        Some("alternate"),
        "the session frame names the alternate screen the program stayed on"
    );
    assert_redial_holds_the_program_state(
        shown,
        &after,
        true,
        &[],
        "an alternate-screen redial that lost bytes",
    );
    assert_eq!(
        number(&session, "missed_bytes"),
        lost.len() as u64,
        "the redial counts the lost reset"
    );
    let replay = number(&session, "replay_bytes") as usize;
    assert_eq!(replay, RING, "the ring's tail is replayed");
    assert_eq!(after[..replay], screen.repeat(4)[..]);
    assert_eq!(
        String::from_utf8_lossy(&after[replay..]),
        String::from_utf8_lossy(LOST_ALT_SUFFIX),
        "the live recovery's alternate-screen suffix follows the replay"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_alternate_screen_view_closed_for_its_short_ack_redials_with_no_dead_mode() {
    let _gate = pty_test_lock();
    // The program enters its alternate screen with mouse tracking, writes
    // past the window until the reader releases the view, and turns the
    // tracking off past it.
    let (rig, mut view, generation, start, received) = released_view_running(
        "stty -onlcr; read -r _; printf '\\033[?1049h\\033[?1000h'; seq -f %.0f 1 200000; \
         printf '\\033[?1000l__STREAM_DONE__'; read -r _",
    )
    .await;
    assert_eq!(
        parsed_modes(&received),
        (true, BTreeSet::from([1000])),
        "fixture: the view parsed the switch to the alternate screen and mouse tracking"
    );
    let sent = received.len() as u64;
    assert_short_ack_is_closed(&mut view, generation, start + sent - 1).await;
    drop(view);
    // The client redials from what it received, as it does after any close
    // not preceded by an exit.
    let (_redial, session, before, after) = redial(&rig, start + sent, generation).await;
    assert_eq!(
        number(&session, "generation"),
        generation,
        "fixture: the same PTY life"
    );
    assert!(before.is_empty(), "fixture: no reset for the same life");
    assert_redial_holds_the_program_state(
        &received,
        &after,
        true,
        &[],
        "a redial after a stall close",
    );
    assert_eq!(
        replay_screen(&session),
        Some("alternate"),
        "the session frame names the alternate screen the program stayed on"
    );
    let replay = number(&session, "replay_bytes") as usize;
    assert!(
        number(&session, "missed_bytes") > 0,
        "the ring moved past the view's cursor while it was released"
    );
    assert_eq!(
        String::from_utf8_lossy(&after[replay..]),
        String::from_utf8_lossy(LOST_ALT_SUFFIX),
        "the live recovery's alternate-screen suffix follows the replay"
    );
    rig.handle.send_input(b"\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_normal_screen_lossless_redial_gets_its_delta_and_nothing_else() {
    let _gate = pty_test_lock();
    let rig = Rig::new(64 * 1024, "while IFS= read -r line; do :; done").await;
    let shown = b"\x1b[?1h\x1b[?1000h";
    let (generation, cursor) = view_modes_then_drop(&rig, shown).await;
    // The program turns mouse tracking off while the socket is down and
    // keeps application cursor keys. Nothing is lost.
    let away = b"\x1b[?1000l$ back at the prompt\r\n";
    rig.output(away);
    let (_redial, session, before, after) = redial(&rig, cursor, generation).await;
    assert_eq!(
        number(&session, "generation"),
        generation,
        "fixture: the same PTY life"
    );
    assert_eq!(
        number(&session, "missed_bytes"),
        0,
        "fixture: nothing was lost"
    );
    assert!(before.is_empty(), "no reset for the same life");
    assert_eq!(
        replay_screen(&session),
        None,
        "a redial that missed nothing names no replay screen"
    );
    assert_eq!(
        number(&session, "replay_bytes"),
        away.len() as u64,
        "the redial replays the raw delta after its cursor"
    );
    assert_eq!(
        after[..away.len()],
        away[..],
        "the delta is the program's bytes"
    );
    assert_redial_holds_the_program_state(
        shown,
        &after,
        false,
        &[1],
        "a lossless normal-screen redial",
    );
    assert_eq!(
        String::from_utf8_lossy(&after),
        String::from_utf8_lossy(away),
        "a lossless redial adds no mode bytes after its delta, as a live recovery adds none"
    );
}

/// Count the resizes `watcher` hears within `window`. A redraw request is
/// heard as one: it wobbles the PTY's size and broadcasts the size it
/// restores to every view.
async fn count_resizes(watcher: &mut AttachHandle, window: std::time::Duration) -> usize {
    let mut resizes = 0;
    let until = tokio::time::Instant::now() + window;
    loop {
        match tokio::time::timeout_at(until, watcher.rx.recv()).await {
            Err(_) => return resizes,
            Ok(Ok(SessionEvent::Resize(_))) => resizes += 1,
            Ok(Ok(_)) => {}
            Ok(Err(error)) => panic!("the watcher may have lost a resize: {error}"),
        }
    }
}

/// The grids `view` is told in resize frames within `window`.
async fn resizes_heard(view: &mut Client, window: std::time::Duration) -> Vec<(u64, u64)> {
    let mut heard = Vec::new();
    let until = tokio::time::Instant::now() + window;
    while let Ok(frame) = tokio::time::timeout_at(until, next(view)).await {
        if let ClientMessage::Text(text) = frame {
            let frame: Value = serde_json::from_str(&text).expect("control JSON");
            if frame["type"] == "resize" {
                heard.push((number(&frame, "cols"), number(&frame, "rows")));
            }
        }
    }
    heard
}

/// Redial a view of the live generation from its cursor with the grid the
/// PTY has, past bytes the ring dropped when `lost`, and count the redraws
/// the dial asks of its program.
async fn live_redial_redraws(lost: bool) -> usize {
    const RING: usize = 4096;
    let rig = Rig::new(RING, "while IFS= read -r line; do :; done").await;
    let (generation, cursor) = view_modes_then_drop(&rig, b"\x1b[?1h").await;
    let mut watcher = rig
        .state
        .terminal_sessions
        .attach_for_ws(rig.handle.id(), None, None)
        .expect("watch the session");
    // The first view's own dial asked for a redraw; let its resize land first.
    count_resizes(&mut watcher, std::time::Duration::from_secs(1)).await;
    if lost {
        let shell = vec![b's'; RING / 4];
        for _ in 0..5 {
            rig.output(&shell);
        }
    } else {
        rig.output(b"$ back at the prompt\r\n");
    }
    let (_redial, session, before, _after) = redial(&rig, cursor, generation).await;
    assert_eq!(
        number(&session, "generation"),
        generation,
        "fixture: the same PTY life"
    );
    assert!(before.is_empty(), "fixture: no reset for the same life");
    assert_eq!(
        replay_screen(&session),
        lost.then_some("normal"),
        "a redial names the normal screen of its replay only past missed bytes"
    );
    assert_eq!(
        number(&session, "missed_bytes") > 0,
        lost,
        "fixture: the redial misses bytes only past a ring overflow"
    );
    count_resizes(&mut watcher, std::time::Duration::from_millis(1500)).await
}

/// A redial that continues its view and missed nothing shows the screen its
/// program drew, as a lossless live recovery does, so it asks for no
/// redraw: one wobbles the PTY's size, sends every view a resize and has
/// the program repaint a screen the delta already made exact.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lossless_live_redial_asks_its_program_for_no_redraw() {
    let _gate = pty_test_lock();
    assert_eq!(
        live_redial_redraws(false).await,
        0,
        "a lossless redial that continues its view asks for no redraw"
    );
}

/// A redial that continues its view past missed bytes asks its program to
/// repaint what the lost span drew, after the suffix that reconciles its
/// modes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lossy_live_redial_asks_its_program_to_redraw() {
    let _gate = pty_test_lock();
    assert_eq!(
        live_redial_redraws(true).await,
        1,
        "a redial that continues its view past missed bytes asks for one redraw"
    );
}

/// A hidden view's dial sizes only a PTY no view has sized, so the resize a
/// redraw broadcasts is what tells it the PTY's grid. A hidden view that
/// redials its live generation losslessly with the grid the PTY has asks
/// for no redraw; one whose PTY another view resized while its socket was
/// down asks for the redraw whose resize reports the new grid.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_hidden_live_redial_asks_for_a_redraw_only_for_a_grid_it_missed() {
    let _gate = pty_test_lock();
    let rig = Rig::new(64 * 1024, "while IFS= read -r line; do :; done").await;
    let (mut shown, _) = rig.attach().await;
    let (hidden, initial) = rig.attach_with("&size_if_unset=true").await;
    let generation = number(&initial, "generation");
    drop(hidden);
    let mut watcher = rig
        .state
        .terminal_sessions
        .attach_for_ws(rig.handle.id(), None, None)
        .expect("watch the session");
    // Both dials asked for a redraw; let their resizes land first.
    count_resizes(&mut watcher, std::time::Duration::from_secs(1)).await;
    let dial = |cursor: u64| {
        format!(
            "session={}&cols=80&rows=24&size_if_unset=true&since={cursor}&generation={generation}",
            rig.handle.id()
        )
    };
    let (redial, session, before, _after) =
        dial_until_ready(rig.address, &dial(number(&initial, "seq"))).await;
    assert_eq!(
        number(&session, "generation"),
        generation,
        "fixture: the same PTY life"
    );
    assert!(before.is_empty(), "fixture: no reset for the same life");
    assert_eq!(
        number(&session, "missed_bytes"),
        0,
        "fixture: nothing was lost"
    );
    assert_eq!(
        count_resizes(&mut watcher, std::time::Duration::from_millis(1500)).await,
        0,
        "a hidden view that redials with the PTY's grid asks for no redraw"
    );
    let cursor = number(&session, "seq");
    drop(redial);
    send(
        &mut shown,
        json!({"type": "resize", "cols": 100, "rows": 30}),
    )
    .await;
    bounded("the PTY takes the shown view's grid", async {
        loop {
            match watcher.rx.recv().await {
                Ok(SessionEvent::Resize(size)) if (size.cols, size.rows) == (100, 30) => break,
                Ok(_) => {}
                Err(error) => panic!("the watcher may have lost the resize: {error}"),
            }
        }
    })
    .await;
    let (mut redial, session, _before, _after) = dial_until_ready(rig.address, &dial(cursor)).await;
    assert_eq!(
        number(&session, "missed_bytes"),
        0,
        "fixture: nothing was lost"
    );
    assert_eq!(
        resizes_heard(&mut redial, std::time::Duration::from_millis(1500)).await,
        [(100, 30)],
        "a hidden view whose PTY another view resized while its socket was down is told \
         the PTY's grid"
    );
}

/// A view that declares no grid on its dial, as a hidden view that adopted
/// a grid another view broadcast does, did not size the PTY, so a lossless
/// redial of its live generation asks for the redraw whose resize reports
/// the grid another view chose while its socket was down.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_undeclared_live_redial_hears_a_grid_it_missed() {
    let _gate = pty_test_lock();
    let rig = Rig::new(64 * 1024, "while IFS= read -r line; do :; done").await;
    let (mut shown, _) = rig.attach().await;
    let id = rig.handle.id().to_owned();
    let (undeclared, initial, _, _) = dial_until_ready(rig.address, &format!("session={id}")).await;
    let generation = number(&initial, "generation");
    let cursor = number(&initial, "seq");
    assert!(cursor > 0, "fixture: a non-zero cursor");
    drop(undeclared);
    let mut watcher = rig
        .state
        .terminal_sessions
        .attach_for_ws(&id, None, None)
        .expect("watch the session");
    // Both dials asked for a redraw; let their resizes land first.
    count_resizes(&mut watcher, std::time::Duration::from_secs(1)).await;
    send(
        &mut shown,
        json!({"type": "resize", "cols": 100, "rows": 30}),
    )
    .await;
    bounded("the PTY takes the shown view's grid", async {
        loop {
            match watcher.rx.recv().await {
                Ok(SessionEvent::Resize(size)) if (size.cols, size.rows) == (100, 30) => break,
                Ok(_) => {}
                Err(error) => panic!("the watcher may have lost the resize: {error}"),
            }
        }
    })
    .await;
    let (mut redial, session, before, _after) = dial_until_ready(
        rig.address,
        &format!("session={id}&since={cursor}&generation={generation}"),
    )
    .await;
    assert_eq!(
        number(&session, "generation"),
        generation,
        "fixture: the same PTY life"
    );
    assert!(before.is_empty(), "fixture: no reset for the same life");
    assert_eq!(
        number(&session, "missed_bytes"),
        0,
        "fixture: nothing was lost"
    );
    assert_eq!(
        resizes_heard(&mut redial, std::time::Duration::from_millis(1500)).await,
        [(100, 30)],
        "a view that declared no grid is told the grid the PTY took while its socket was down"
    );
}

/// A lag recovery sends the PTY's grid ahead of its replay, so a lossless
/// one asks its program for no redraw even for a view that declared no
/// grid: the redraw would only wobble the PTY under every attached view.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_undeclared_lossless_recovery_asks_for_no_redraw() {
    let _gate = pty_test_lock();
    let rig = Rig::new(64 * 1024, "while IFS= read -r line; do :; done").await;
    let id = rig.handle.id().to_owned();
    let (mut client, initial, _, _) = dial_until_ready(rig.address, &format!("session={id}")).await;
    let prefix = b"completed-prefix\n";
    rig.output(prefix);
    assert_eq!(next_binary(&mut client).await, prefix);
    let _pending = rig.block_output().await;
    rig.handle.resize(pty_size(Some(113), Some(37)));
    until("co-view resize applied", || {
        let size = rig.handle.size();
        (size.cols, size.rows) == (113, 37)
    })
    .await;
    let _flood = rig.flood();
    finish_blocked_frame(&mut client).await;
    let mut recovery = None;
    loop {
        match next(&mut client).await {
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                match frame["type"].as_str() {
                    Some("session") => recovery = Some(frame),
                    Some("ready") if recovery.is_some() => break,
                    Some("error") => panic!("no terminal error: {frame}"),
                    _ => {}
                }
            }
            ClientMessage::Binary(_) => {}
            other => panic!("recovery ended before ready: {other:?}"),
        }
    }
    let recovery = recovery.expect("a recovery session frame");
    assert_eq!(
        number(&recovery, "generation"),
        number(&initial, "generation"),
        "fixture: the same PTY life"
    );
    assert_eq!(
        number(&recovery, "missed_bytes"),
        0,
        "fixture: a lossless recovery"
    );
    let heard = resizes_heard(&mut client, std::time::Duration::from_millis(1500)).await;
    assert!(
        heard.is_empty(),
        "a lossless recovery asks for no redraw: {heard:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_progressing_small_socket_receives_more_than_a_broadcast_of_real_pty_reads() {
    use std::fmt::Write as _;

    let _gate = pty_test_lock();
    let rig = Rig::new(1024,
        "stty -onlcr; IFS= read -r start; seq -f %.0f 1 1000000; printf '__STREAM_%s__' DONE; IFS= read -r finish"
    ).await;
    let (mut client, initial) = rig.attach_acking().await;
    assert_eq!(initial["missed_bytes"], 0);
    let generation = number(&initial, "generation");
    let start = number(&initial, "seq");
    let mut expected = String::new();
    for number in 1..=1_000_000 {
        writeln!(&mut expected, "{number}").unwrap();
    }
    expected.push_str("__STREAM_DONE__");
    send(&mut client, json!({"type":"input", "data":"start\n"})).await;
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
                ack(&mut client, generation, start + bytes.len() as u64).await;
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

/// The WebKit shape: the socket keeps delivering every frame to a page that
/// parses none of them, so only the missing acknowledgement can show it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_view_that_reads_without_acknowledging_is_bounded_and_resumes_with_a_count() {
    use std::fmt::Write as _;

    const RING: usize = 2 * 1024 * 1024;
    let _gate = pty_test_lock();
    let rig = Rig::new(
        RING,
        "stty -onlcr; read -r _; seq -f %.0f 1 1000000; printf '__STREAM_DONE__'; read -r _",
    )
    .await;
    let (mut stopped, initial) = rig.attach_acking().await;
    let window = number(&initial, "ack_window");
    assert_eq!(window, (RING / 2) as u64, "the window is half the ring");
    let (mut live, live_session, mut live_bytes) =
        attach_collecting(rig.address, rig.handle.id()).await;
    let live_generation = number(&live_session, "generation");
    let live_start = number(&live_session, "seq") - live_bytes.len() as u64;
    let generation = number(&initial, "generation");
    let start = number(&initial, "seq");
    let mut expected = String::new();
    for line in 1..=1_000_000 {
        writeln!(&mut expected, "{line}").expect("write to a string");
    }
    expected.push_str("__STREAM_DONE__");

    rig.handle.send_input(b"\n");
    let mut unparsed = Vec::new();
    let hang = tokio::time::sleep(std::time::Duration::from_secs(120));
    tokio::pin!(hang);
    loop {
        tokio::select! {
            frame = stopped.next() => match frame.expect("stopped view open").expect("frame") {
                ClientMessage::Binary(bytes) => unparsed.extend_from_slice(&bytes),
                ClientMessage::Text(text) => {
                    let frame: Value = serde_json::from_str(&text).expect("control JSON");
                    assert_ne!(frame["type"], "error", "no lag line: {frame}");
                    assert_ne!(frame["type"], "session", "no replay before an ack: {frame}");
                }
                other => panic!("stopped view ended: {other:?}"),
            },
            frame = live.next() => match frame.expect("live view open").expect("frame") {
                ClientMessage::Binary(bytes) => {
                    live_bytes.extend_from_slice(&bytes);
                    ack(&mut live, live_generation, live_start + live_bytes.len() as u64).await;
                    if live_bytes.ends_with(DONE_MARKER) {
                        break;
                    }
                }
                ClientMessage::Text(text) => {
                    let frame: Value = serde_json::from_str(&text).expect("control JSON");
                    assert_ne!(frame["type"], "error", "live view error: {frame}");
                }
                other => panic!("live view ended: {other:?}"),
            },
            _ = &mut hang => panic!(
                "the stream never finished: live {} of {} bytes, stopped view holds {}",
                live_bytes.len(), expected.len(), unparsed.len(),
            ),
        }
    }
    assert!(
        live_bytes.ends_with(expected.as_bytes()),
        "the acknowledging view holds every byte, once and in order"
    );
    assert!(
        unparsed.len() as u64 <= window,
        "the engine's queue stays inside the window: {} > {window}",
        unparsed.len()
    );
    assert_eq!(
        unparsed,
        expected.as_bytes()[..unparsed.len()],
        "what the stopped view holds is the stream's head"
    );
    rig.handle.resize(pty_size(Some(101), Some(33)));
    until("the resize applied", || rig.handle.size().cols == 101).await;

    // A position from another PTY life moves nothing.
    let sent = start + unparsed.len() as u64;
    ack(&mut stopped, generation + 1, sent).await;
    let silent = tokio::time::timeout(std::time::Duration::from_millis(400), stopped.next()).await;
    assert!(
        silent.is_err(),
        "an acknowledgement of another generation resumes nothing: {silent:?}"
    );

    ack(&mut stopped, generation, sent).await;
    let recovery = loop {
        if let ClientMessage::Text(text) = next(&mut stopped).await {
            let frame: Value = serde_json::from_str(&text).expect("control JSON");
            assert_ne!(frame["type"], "error", "no lag line on resume: {frame}");
            if frame["type"] == "session" {
                break frame;
            }
        }
    };
    let replay = number(&recovery, "replay_bytes");
    let missed = number(&recovery, "missed_bytes");
    let end = number(&recovery, "seq");
    assert!(missed > 0, "the ring moved past the stopped view");
    assert_eq!(
        sent + missed + replay,
        end,
        "the count closes the gap between the view's cursor and the server's"
    );
    let replay_start = end - replay;
    let mut replayed = Vec::new();
    loop {
        match next(&mut stopped).await {
            ClientMessage::Binary(bytes) => {
                replayed.extend_from_slice(&bytes);
                let raw = (replayed.len() as u64).min(replay);
                ack(&mut stopped, generation, replay_start + raw).await;
                assert!(
                    (replayed.len() as u64) < replay + window,
                    "the replay honours the window"
                );
            }
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                assert_ne!(frame["type"], "error", "no lag line on replay: {frame}");
                if frame["type"] == "ready" {
                    assert_eq!(frame["cols"], 101, "the missed resize is restored");
                    break;
                }
            }
            other => panic!("stopped view ended in replay: {other:?}"),
        }
    }
    assert_eq!(
        replayed[..replay as usize],
        expected.as_bytes()[expected.len() - replay as usize..],
        "the resume carries the ring's tail, once"
    );
    send(&mut live, json!({"type": "input", "data": "\n"})).await;
}

/// Scheduling slack on a loaded host, past [`NO_PROGRESS_LIMIT`], the time
/// a view that needs recovery and whose client shows it is alive has to
/// report the rest of what it was sent.
const SHORT_ACK_SLACK: std::time::Duration = std::time::Duration::from_secs(5);

/// The close a socket ends a stalled view with: 1013, try again later,
/// which the client answers by redialing.
fn assert_stall_close(frame: Option<&tokio_tungstenite::tungstenite::protocol::CloseFrame>) {
    let frame = frame.expect("a stalled view's close carries a code");
    assert_eq!(
        u16::from(frame.code),
        1013,
        "a stalled view is closed with 1013: {frame:?}"
    );
    assert_eq!(frame.reason.as_str(), "terminal view stalled");
}

/// Report `short`, a position before what the view was sent, then ping as
/// a live page does, and read until the server ends the socket. The
/// client redials when it does.
async fn assert_short_ack_is_closed(view: &mut Client, generation: u64, short: u64) {
    ack(view, generation, short).await;
    let acked_at = tokio::time::Instant::now();
    let deadline = acked_at + NO_PROGRESS_LIMIT + SHORT_ACK_SLACK;
    let mut ping = tokio::time::interval(std::time::Duration::from_millis(250));
    let mut pongs = 0usize;
    let closed_at = loop {
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(deadline) => break None,
            frame = view.next() => match frame {
                Some(Ok(ClientMessage::Text(text))) => {
                    let frame: Value = serde_json::from_str(&text).expect("control JSON");
                    match frame["type"].as_str() {
                        Some("pong") => pongs += 1,
                        Some("error" | "session" | "exit" | "closed") => {
                            panic!("a view whose ack stays short gets no {frame}")
                        }
                        _ => {}
                    }
                }
                Some(Ok(ClientMessage::Binary(bytes))) => panic!(
                    "a view waiting for its ack is sent no raw output: {} bytes",
                    bytes.len()
                ),
                Some(Ok(ClientMessage::Close(frame))) => {
                    assert_stall_close(frame.as_ref());
                    break Some(tokio::time::Instant::now());
                }
                Some(Err(error)) => panic!("the socket ended without a close frame: {error}"),
                None => panic!("the socket ended without a close frame"),
                Some(Ok(_)) => {}
            },
            _ = ping.tick() => {
                // A write that races the close is read as the close below.
                let _ = view
                    .send(ClientMessage::Text(json!({"type": "ping"}).to_string().into()))
                    .await;
            }
        }
    };
    assert!(
        closed_at.is_some(),
        "a view whose ack stays short is closed within {NO_PROGRESS_LIMIT:?} \
         (+{SHORT_ACK_SLACK:?}) while it pings: {pongs} pongs and no close"
    );
    assert!(pongs > 0, "the client showed it was alive before the close");
    let waited = closed_at.expect("closed") - acked_at;
    assert!(
        waited >= NO_PROGRESS_LIMIT,
        "a live client gets the whole bound to report progress: closed after {waited:?}"
    );
}

/// A view the reader released, whose client has sent nothing since it
/// attached: it read what it was sent and reported none of it, so it held
/// the reader until the bound, and the program then ran to its end past
/// it. The program waits for a line before it exits. Returns the rig, the
/// view, its generation, the position its session frame gave and the count
/// of raw bytes it was sent.
async fn released_view() -> (Rig, Client, u64, u64, u64) {
    let (rig, view, generation, start, received) = released_view_running(
        "stty -onlcr; read -r _; seq -f %.0f 1 200000; printf '__STREAM_DONE__'; read -r _",
    )
    .await;
    (rig, view, generation, start, received.len() as u64)
}

/// [`released_view`] over a program `body` that reads a line, then writes
/// past the window and ends its output with [`DONE_MARKER`]. Returns the
/// raw bytes the view was sent after its attach.
async fn released_view_running(body: &str) -> (Rig, Client, u64, u64, Vec<u8>) {
    let rig = Rig::new(64 * 1024, body).await;
    let (mut view, initial) = rig.attach_acking().await;
    let generation = number(&initial, "generation");
    let start = number(&initial, "seq");
    let mut watcher = rig
        .state
        .terminal_sessions
        .attach_for_ws(rig.handle.id(), None, None)
        .expect("watch the session");
    rig.handle.send_input(b"\n");
    // The view reads what it is sent and reports none of it, so it holds
    // the reader until the release; only then can the program end.
    let mut received = Vec::new();
    let mut tail = Vec::new();
    bounded("the program ends past the released view", async {
        loop {
            tokio::select! {
                frame = view.next() => match frame.expect("view open").expect("frame") {
                    ClientMessage::Binary(bytes) => received.extend_from_slice(&bytes),
                    ClientMessage::Text(text) => {
                        let frame: Value = serde_json::from_str(&text).expect("control JSON");
                        assert_ne!(frame["type"], "error", "no lag line: {frame}");
                        assert_ne!(frame["type"], "session", "no recovery before an ack: {frame}");
                    }
                    other => panic!("view ended: {other:?}"),
                },
                event = watcher.rx.recv() => match event {
                    Ok(SessionEvent::Output(bytes)) => {
                        tail.extend_from_slice(&bytes);
                        let keep = tail.len().saturating_sub(DONE_MARKER.len());
                        tail.drain(..keep);
                        if tail.ends_with(DONE_MARKER) {
                            break;
                        }
                    }
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(error) => panic!("session ended: {error}"),
                },
            }
        }
    })
    .await;
    // Take what is still in flight; a released view is sent nothing more.
    while let Ok(frame) =
        tokio::time::timeout(std::time::Duration::from_millis(300), view.next()).await
    {
        if let ClientMessage::Binary(bytes) = frame.expect("view open").expect("frame") {
            received.extend_from_slice(&bytes);
        }
    }
    assert!(!received.is_empty(), "fixture: the view was sent output");
    (rig, view, generation, start, received)
}

/// The client's first frame since the release is an ack that advances and
/// stays short. An advance is progress, so that frame starts no clock and a
/// client quiet after it stays open past the bound; its next frame does.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_released_view_whose_ack_stays_short_is_closed_within_the_bound() {
    let _gate = pty_test_lock();
    let (rig, mut view, generation, start, received) = released_view().await;
    let short = start + received - 1;
    ack(&mut view, generation, short).await;
    let quiet_until =
        tokio::time::Instant::now() + NO_PROGRESS_LIMIT + std::time::Duration::from_secs(2);
    assert_eq!(
        read_until_closed(&mut view, quiet_until).await,
        None,
        "an advancing ack read as the first frame after the release starts no clock"
    );
    assert_short_ack_is_closed(&mut view, generation, short).await;
    rig.handle.send_input(b"\n");
}

/// Read `view`, sending nothing, until the server closes it or `deadline`
/// passes, and say when the close arrived. A view waiting for its client is
/// sent nothing but that close: no raw output, recovery or error.
async fn read_until_closed(
    view: &mut Client,
    deadline: tokio::time::Instant,
) -> Option<tokio::time::Instant> {
    loop {
        match tokio::time::timeout_at(deadline, view.next()).await {
            Err(_) => return None,
            Ok(Some(Ok(ClientMessage::Close(frame)))) => {
                assert_stall_close(frame.as_ref());
                return Some(tokio::time::Instant::now());
            }
            Ok(Some(Ok(ClientMessage::Text(text)))) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                if let Some("error" | "session" | "exit" | "closed") = frame["type"].as_str() {
                    panic!("a view waiting for its client gets no {frame}");
                }
            }
            Ok(Some(Ok(ClientMessage::Binary(bytes)))) => panic!(
                "a view waiting for its client is sent no raw output: {} bytes",
                bytes.len()
            ),
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(error))) => panic!("the socket ended without a close frame: {error}"),
            Ok(None) => panic!("the socket ended without a close frame"),
        }
    }
}

/// The view's client reports everything it was sent, and the view recovers
/// on its socket: a session frame whose count closes the gap between that
/// position and the server's. Returns that frame.
async fn assert_recovers_on_its_socket(view: &mut Client, generation: u64, sent: u64) -> Value {
    ack(view, generation, sent).await;
    let recovery = loop {
        match next(view).await {
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                assert_ne!(frame["type"], "error", "no lag line on resume: {frame}");
                if frame["type"] == "session" {
                    break frame;
                }
            }
            ClientMessage::Binary(bytes) => panic!(
                "a view waiting for its client is sent no raw output: {} bytes",
                bytes.len()
            ),
            other => panic!("the view ended instead of recovering: {other:?}"),
        }
    };
    assert_eq!(number(&recovery, "generation"), generation);
    assert_eq!(
        sent + number(&recovery, "missed_bytes") + number(&recovery, "replay_bytes"),
        number(&recovery, "seq"),
        "the count closes the gap between the view's cursor and the server's"
    );
    recovery
}

/// A released view's client that sends one frame shows it runs, and that
/// frame is its first since the release: the close comes the bound after
/// it, with no second frame needed to start the clock.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_released_view_that_pings_once_is_closed_the_bound_after_its_ping() {
    let _gate = pty_test_lock();
    let (rig, mut view, _generation, _start, _received) = released_view().await;
    let pinged_at = tokio::time::Instant::now();
    send(&mut view, json!({"type": "ping"})).await;
    let closed_at =
        read_until_closed(&mut view, pinged_at + NO_PROGRESS_LIMIT + SHORT_ACK_SLACK).await;
    let Some(closed_at) = closed_at else {
        panic!(
            "a released view whose client pinged once is closed within \
             {NO_PROGRESS_LIMIT:?} (+{SHORT_ACK_SLACK:?}) of that ping: still open"
        );
    };
    let waited = closed_at - pinged_at;
    assert!(
        waited >= NO_PROGRESS_LIMIT,
        "the client gets the whole bound from its frame: closed after {waited:?}"
    );
    rig.handle.send_input(b"\n");
}

/// A released view that sends nothing keeps waiting past the bound, as a
/// stopped page does, and recovers on its socket once it reports.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_released_view_silent_past_the_bound_stays_open_and_recovers() {
    let _gate = pty_test_lock();
    let (rig, mut view, generation, start, received) = released_view().await;
    let silent_until =
        tokio::time::Instant::now() + NO_PROGRESS_LIMIT + std::time::Duration::from_secs(3);
    assert_eq!(
        read_until_closed(&mut view, silent_until).await,
        None,
        "a released view whose client sends nothing stays open past the bound"
    );
    assert_recovers_on_its_socket(&mut view, generation, start + received).await;
    rig.handle.send_input(b"\n");
}

/// A released view that sends nothing keeps waiting when its program exits,
/// as a stopped page does. The exit wakes the socket loop with no client
/// frame, so the loop creates the view's wait itself, and that wait's clock
/// starts only at a frame from the client.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_released_silent_view_stays_open_when_its_program_exits() {
    let _gate = pty_test_lock();
    let (rig, mut view, generation, start, received) = released_view().await;
    let mut lifecycle = rig.handle.lifecycle_rx.clone();
    rig.handle.send_input(b"\n");
    let exited = bounded(
        "the program exits",
        lifecycle.wait_for(|lifecycle| matches!(lifecycle, Some(SessionLifecycle::Exit(_)))),
    )
    .await
    .is_ok();
    assert!(exited, "fixture: the program exits after the release");
    let silent_until =
        tokio::time::Instant::now() + NO_PROGRESS_LIMIT + std::time::Duration::from_secs(3);
    assert_eq!(
        read_until_closed(&mut view, silent_until).await,
        None,
        "a released view whose client sends nothing stays open when its program exits"
    );
    assert_recovers_on_its_socket(&mut view, generation, start + received).await;
}

/// A stopped page's network stack can still answer protocol pings, so they
/// do not show that the page runs: a released view that only exchanges
/// them keeps waiting past the bound and recovers once it reports.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_released_view_that_only_answers_protocol_pings_stays_open_and_recovers() {
    let _gate = pty_test_lock();
    let (rig, mut view, generation, start, received) = released_view().await;
    let until = tokio::time::Instant::now() + NO_PROGRESS_LIMIT + std::time::Duration::from_secs(2);
    let mut ping = tokio::time::interval(std::time::Duration::from_millis(250));
    let mut pongs = 0usize;
    loop {
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(until) => break,
            frame = view.next() => match frame {
                Some(Ok(ClientMessage::Pong(_))) => pongs += 1,
                Some(Ok(ClientMessage::Text(text))) => {
                    let frame: Value = serde_json::from_str(&text).expect("control JSON");
                    if let Some("error" | "session" | "exit" | "closed") = frame["type"].as_str() {
                        panic!("a view waiting for its client gets no {frame}");
                    }
                }
                other => panic!(
                    "a released view that only answers protocol pings stays open past \
                     the bound: {other:?} after {pongs} pongs"
                ),
            },
            _ = ping.tick() => {
                bounded("send a protocol ping", view.send(ClientMessage::Ping(Vec::new().into())))
                    .await
                    .expect("protocol ping writes");
            }
        }
    }
    assert!(pongs > 0, "fixture: the server answered the protocol pings");
    assert_recovers_on_its_socket(&mut view, generation, start + received).await;
    rig.handle.send_input(b"\n");
}

/// A client whose frames are ready at every poll of the socket loop, here a
/// flood of acknowledgements of another generation, which move nothing
/// and get no reply, is closed at the bound all the same.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_released_view_flooding_frames_is_closed_within_the_bound() {
    let _gate = pty_test_lock();
    let (rig, view, generation, start, received) = released_view().await;
    assert_flooding_view_is_closed(view, generation, start + received).await;
    rig.handle.send_input(b"\n");
}

/// Flood `view` with acknowledgements of the generation after
/// `generation`, which move nothing and get no reply, and require the
/// stall close the bound after the flood starts.
async fn assert_flooding_view_is_closed(view: Client, generation: u64, seq: u64) {
    let (mut sink, mut stream) = view.split();
    let frames = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let flooded_at = tokio::time::Instant::now();
    let flood = tokio::spawn({
        let frames = frames.clone();
        async move {
            let frame =
                json!({"type": "ack", "generation": generation + 1, "seq": seq}).to_string();
            loop {
                for _ in 0..64 {
                    if sink
                        .feed(ClientMessage::Text(frame.clone().into()))
                        .await
                        .is_err()
                    {
                        return;
                    }
                    frames.fetch_add(1, Ordering::Relaxed);
                }
                if sink.flush().await.is_err() {
                    return;
                }
            }
        }
    });
    let deadline = flooded_at + NO_PROGRESS_LIMIT + SHORT_ACK_SLACK;
    // The flood gets no reply, so the first frame the view is sent is its
    // close.
    let closed_at = match tokio::time::timeout_at(deadline, stream.next()).await {
        Err(_) => None,
        Ok(Some(Ok(ClientMessage::Close(frame)))) => {
            assert_stall_close(frame.as_ref());
            Some(tokio::time::Instant::now())
        }
        Ok(Some(Ok(ClientMessage::Text(text)))) => {
            let frame: Value = serde_json::from_str(&text).expect("control JSON");
            panic!("a flooding view waiting for its client gets no {frame}");
        }
        Ok(Some(Ok(other))) => {
            panic!("a flooding view is sent nothing but its close: {other:?}")
        }
        Ok(Some(Err(error))) => panic!("the socket ended without a close frame: {error}"),
        Ok(None) => panic!("the socket ended without a close frame"),
    };
    flood.abort();
    let frames = frames.load(Ordering::Relaxed);
    let Some(closed_at) = closed_at else {
        panic!(
            "a released view flooding frames is closed within {NO_PROGRESS_LIMIT:?} \
             (+{SHORT_ACK_SLACK:?}): still open after {frames} frames"
        );
    };
    assert!(
        closed_at - flooded_at >= NO_PROGRESS_LIMIT,
        "the client gets the whole bound from its first frame: closed after {:?}, {frames} frames",
        closed_at - flooded_at
    );
}

/// Wait until the watcher has seen one more output of the program's `T`.
async fn next_tick(watcher: &mut AttachHandle) {
    bounded("the program's tick reaches the watcher", async {
        loop {
            match watcher.rx.recv().await {
                Ok(SessionEvent::Output(bytes)) if bytes.contains(&b'T') => return,
                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(error) => panic!("session ended: {error}"),
            }
        }
    })
    .await;
}

/// A view the reader released while its socket's send is still pending: a
/// window of output its client has not read holds that send, and the view
/// holds the reader until the release. The program prints a `T` for each
/// line it reads; the second tick past the view can only follow the
/// release, whichever tick the reader held. Returns the rig, the view, its
/// generation, the position its session frame gave and the pending send.
async fn released_under_a_pending_send() -> (Rig, Client, u64, u64, PendingSend) {
    let rig = Rig::new(
        2 * BLOCKED_BYTES,
        "while IFS= read -r line; do printf 'T'; done",
    )
    .await;
    let (view, initial) = rig.attach_acking().await;
    let generation = number(&initial, "generation");
    let start = number(&initial, "seq");
    let mut watcher = rig
        .state
        .terminal_sessions
        .attach_for_ws(rig.handle.id(), None, None)
        .expect("watch the session");
    let pending = rig.block_output().await;
    for _ in 0..2 {
        rig.handle.send_input(b"\n");
        next_tick(&mut watcher).await;
    }
    (rig, view, generation, start, pending)
}

/// The client pings while its released view's send is pending, so the send
/// reads the ping, and reads the frame that ends the send `hold` later.
/// Says when the send ended.
async fn ping_into_the_pending_send(
    view: &mut Client,
    hold: std::time::Duration,
) -> tokio::time::Instant {
    send(view, json!({"type": "ping"})).await;
    tokio::time::sleep(hold).await;
    finish_blocked_frame(view).await;
    tokio::time::Instant::now()
}

/// The first frame read after a release starts the clock wherever the
/// socket reads it, here inside the send that was pending at the release.
/// The send outlasts the bound, so the close follows the send's end; a
/// clock started there instead would close a whole bound later.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_ping_read_by_a_send_pending_at_the_release_starts_the_stall_clock() {
    let _gate = pty_test_lock();
    let (_rig, mut view, _generation, _start, _pending) = released_under_a_pending_send().await;
    let hold = NO_PROGRESS_LIMIT + std::time::Duration::from_secs(2);
    let sent_at = ping_into_the_pending_send(&mut view, hold).await;
    let Some(closed_at) = read_until_closed(&mut view, sent_at + SHORT_ACK_SLACK).await else {
        panic!(
            "a released view whose client pinged once while its send was pending is \
             closed once the bound from that ping has passed: still open \
             {SHORT_ACK_SLACK:?} after the send ended"
        );
    };
    // Timers never fire early, so a clock started at the send's end closes
    // no sooner than a bound after it, and a second short of that tells
    // the two apart on a loaded host.
    let after_send = closed_at - sent_at;
    assert!(
        after_send < NO_PROGRESS_LIMIT - std::time::Duration::from_secs(1),
        "the clock runs from the ping, not from the send's end: closed {after_send:?} \
         after the send ended"
    );
}

/// A ping read by the pending send gets the whole bound: the view is open
/// a second short of it. An ack advance read after that ping is progress,
/// so the wait restarts with no clock and the view stays open past the
/// ping's bound, and the client's next frame starts the clock again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_ack_advance_after_a_ping_read_by_a_pending_send_restarts_the_wait() {
    let _gate = pty_test_lock();
    let (_rig, mut view, generation, start, _pending) = released_under_a_pending_send().await;
    let pinged_at = tokio::time::Instant::now();
    ping_into_the_pending_send(&mut view, std::time::Duration::from_secs(1)).await;
    let open_until = pinged_at + NO_PROGRESS_LIMIT - std::time::Duration::from_secs(1);
    assert_eq!(
        read_until_closed(&mut view, open_until).await,
        None,
        "the client gets the whole bound from its ping"
    );
    // Short of what the view was sent, so it keeps waiting for its client.
    ack(&mut view, generation, start + BLOCKED_BYTES as u64 - 1).await;
    let quiet_until = pinged_at + NO_PROGRESS_LIMIT + std::time::Duration::from_secs(2);
    assert_eq!(
        read_until_closed(&mut view, quiet_until).await,
        None,
        "an ack advance after the ping restarts the wait with no clock"
    );
    let pinged_again_at = tokio::time::Instant::now();
    send(&mut view, json!({"type": "ping"})).await;
    let deadline = pinged_again_at + NO_PROGRESS_LIMIT + SHORT_ACK_SLACK;
    let Some(closed_at) = read_until_closed(&mut view, deadline).await else {
        panic!(
            "the frame after the advance starts the clock: still open \
             {NO_PROGRESS_LIMIT:?} (+{SHORT_ACK_SLACK:?}) after it"
        );
    };
    let waited = closed_at - pinged_again_at;
    assert!(
        waited >= NO_PROGRESS_LIMIT,
        "the client gets the whole bound from its frame: closed after {waited:?}"
    );
}

/// Read what `view` is sent until it goes quiet, and say how many raw bytes
/// that was. A replay waiting for credit sends nothing past its window and
/// no `ready`.
async fn read_replay_until_quiet(view: &mut Client) -> u64 {
    let mut received = 0u64;
    while let Ok(frame) =
        tokio::time::timeout(std::time::Duration::from_millis(400), next(view)).await
    {
        match frame {
            ClientMessage::Binary(bytes) => received += bytes.len() as u64,
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                if let Some("ready" | "error") = frame["type"].as_str() {
                    panic!("a replay waiting for credit gets no {frame}");
                }
            }
            other => panic!("the view ended in its replay: {other:?}"),
        }
    }
    received
}

/// A view released while its first replay waits for send credit: the
/// replay is larger than the window, and the client reads the window it is
/// sent and reports none of it. The program prints a `T` for each line it
/// reads; the second tick past the view can only follow the release,
/// whichever tick the reader held. Returns the rig, the view and its
/// generation.
async fn released_in_its_replay() -> (Rig, Client, u64) {
    const RING: usize = 64 * 1024;
    let rig = Rig::new(RING, "while IFS= read -r line; do printf 'T'; done").await;
    rig.output(&vec![b'x'; RING - 1024]);
    let mut view = bounded(
        "attach terminal socket",
        dial_terminal_with_small_buffer(
            rig.address,
            &format!("session={}&since=0&cols=80&rows=24&ack=1", rig.handle.id()),
        ),
    )
    .await;
    let session = loop {
        if let ClientMessage::Text(text) = next(&mut view).await {
            let frame: Value = serde_json::from_str(&text).expect("control JSON");
            if frame["type"] == "session" {
                break frame;
            }
        }
    };
    let window = number(&session, "ack_window");
    assert!(
        number(&session, "replay_bytes") > window,
        "fixture: the replay exceeds the window"
    );
    assert_eq!(
        read_replay_until_quiet(&mut view).await,
        window,
        "fixture: the replay waits for credit at the window"
    );
    let mut watcher = rig
        .state
        .terminal_sessions
        .attach_for_ws(rig.handle.id(), None, None)
        .expect("watch the session");
    for _ in 0..2 {
        rig.handle.send_input(b"\n");
        next_tick(&mut watcher).await;
    }
    (rig, view, number(&session, "generation"))
}

/// A view released while its replay waits for send credit never returns to
/// the socket loop, so the bound closes it from inside that wait: the
/// client's first frame starts the clock there.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_view_released_while_its_replay_waits_for_credit_is_closed_the_bound_after_its_ping() {
    let _gate = pty_test_lock();
    let (_rig, mut view, _generation) = released_in_its_replay().await;
    let pinged_at = tokio::time::Instant::now();
    send(&mut view, json!({"type": "ping"})).await;
    let closed_at =
        read_until_closed(&mut view, pinged_at + NO_PROGRESS_LIMIT + SHORT_ACK_SLACK).await;
    let Some(closed_at) = closed_at else {
        panic!(
            "a view released while its replay waits for credit, whose client pinged \
             once, is closed within {NO_PROGRESS_LIMIT:?} (+{SHORT_ACK_SLACK:?}) of \
             that ping: still open"
        );
    };
    let waited = closed_at - pinged_at;
    assert!(
        waited >= NO_PROGRESS_LIMIT,
        "the client gets the whole bound from its frame: closed after {waited:?}"
    );
}

/// The credit wait polls the bound ahead of the client's frames, as the
/// socket loop does, so a client whose frames are ready at every poll
/// cannot hold the close off there either.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_view_released_while_its_replay_waits_for_credit_flooding_frames_is_closed_within_the_bound(
) {
    let _gate = pty_test_lock();
    let (_rig, view, generation) = released_in_its_replay().await;
    assert_flooding_view_is_closed(view, generation, 0).await;
}

/// A wait belongs to the view it started for. A recovery whose replay is
/// larger than the window waits for credit as a first replay does, for a
/// new view that has not been released: its client's frames there start
/// no clock, and the wait the released view ended with cannot close it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_recovery_waiting_for_credit_is_not_closed_by_the_wait_it_recovered_from() {
    let _gate = pty_test_lock();
    let (rig, mut view, generation, start, received) = released_view().await;
    ack(&mut view, generation, start + received).await;
    let recovery = loop {
        match next(&mut view).await {
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                assert_ne!(frame["type"], "error", "no lag line on resume: {frame}");
                if frame["type"] == "session" {
                    break frame;
                }
            }
            ClientMessage::Binary(bytes) => {
                panic!("output before recovery: {} bytes", bytes.len())
            }
            other => panic!("the view ended instead of recovering: {other:?}"),
        }
    };
    let window = number(&recovery, "ack_window");
    assert!(
        number(&recovery, "replay_bytes") > window,
        "fixture: the recovery's replay exceeds the window"
    );
    assert_eq!(
        read_replay_until_quiet(&mut view).await,
        window,
        "fixture: the recovery waits for credit at the window"
    );
    let pinged_at = tokio::time::Instant::now();
    for _ in 0..2 {
        send(&mut view, json!({"type": "ping"})).await;
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    let open_until = pinged_at + NO_PROGRESS_LIMIT + std::time::Duration::from_secs(2);
    assert_eq!(
        read_until_closed(&mut view, open_until).await,
        None,
        "a recovery whose client pings while its replay waits for credit stays open \
         past the bound"
    );
    rig.handle.send_input(b"\n");
}

/// A lagged view recovers on its socket into a replay larger than the
/// window, and the reader releases the new view while that replay waits for
/// credit. The wait runs inside the socket loop's recovery, which it ends:
/// the socket still ends with the stall close the bound after the client's
/// ping, not with a dropped connection.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_recovery_released_while_its_replay_waits_for_credit_is_closed_the_bound_after_its_ping()
{
    let _gate = pty_test_lock();
    let rig = Rig::new(64 * 1024, "while IFS= read -r line; do printf 'T'; done").await;
    let (mut view, initial) = rig.attach_acking().await;
    let generation = number(&initial, "generation");
    let start = number(&initial, "seq");
    let mut watcher = rig
        .state
        .terminal_sessions
        .attach_for_ws(rig.handle.id(), None, None)
        .expect("watch the session");
    let _pending = rig.block_output().await;
    rig.flood();
    finish_blocked_frame(&mut view).await;
    // The flood overran the view's broadcast while its send was pending.
    let recovery =
        assert_recovers_on_its_socket(&mut view, generation, start + BLOCKED_BYTES as u64).await;
    let window = number(&recovery, "ack_window");
    assert!(
        number(&recovery, "replay_bytes") > window,
        "fixture: the recovery's replay exceeds the window"
    );
    assert_eq!(
        read_replay_until_quiet(&mut view).await,
        window,
        "fixture: the recovery waits for credit at the window"
    );
    // The program prints a `T` for each line it reads; the second tick
    // past the new view can only follow its release, whichever tick the
    // reader held.
    for _ in 0..2 {
        rig.handle.send_input(b"\n");
        next_tick(&mut watcher).await;
    }
    let pinged_at = tokio::time::Instant::now();
    send(&mut view, json!({"type": "ping"})).await;
    let closed_at =
        read_until_closed(&mut view, pinged_at + NO_PROGRESS_LIMIT + SHORT_ACK_SLACK).await;
    let Some(closed_at) = closed_at else {
        panic!(
            "a recovery released while its replay waits for credit, whose client pinged \
             once, is closed within {NO_PROGRESS_LIMIT:?} (+{SHORT_ACK_SLACK:?}) of that \
             ping: still open"
        );
    };
    let waited = closed_at - pinged_at;
    assert!(
        waited >= NO_PROGRESS_LIMIT,
        "the client gets the whole bound from its frame: closed after {waited:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lagged_view_whose_ack_stays_short_is_closed_within_the_bound() {
    let _gate = pty_test_lock();
    let rig = Rig::new(64 * 1024, "while IFS= read -r line; do :; done").await;
    let (mut view, initial) = rig.attach_acking().await;
    let generation = number(&initial, "generation");
    let start = number(&initial, "seq");
    let _pending = rig.block_output().await;
    rig.flood();
    finish_blocked_frame(&mut view).await;
    // The flood overran the view's broadcast while its send was pending, so
    // the view waits for its client to report the frame it was sent.
    assert_short_ack_is_closed(&mut view, generation, start + BLOCKED_BYTES as u64 - 1).await;
}

/// An exit ends the reader's waits, so a view whose window is full when its
/// program exits is never released, and only its client's ack lets the rest
/// of the output and the exit reach it. It waits for its client under the
/// same bound as a released view: an ack that makes room ends the wait, a
/// frame read while the view can send starts no clock for the next one,
/// and a client quiet past the bound stays open. The client's next frame
/// starts the clock, the bound closes the view, and its redial gets what it
/// was still owed and the exit.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_view_with_a_full_window_when_its_program_exits_is_closed_the_bound_after_its_ping() {
    let _gate = pty_test_lock();
    const RING: usize = 64 * 1024;
    // What the program writes once the view's window is full, before it
    // exits. The exit must not wait on the reader: macOS holds a
    // controlling process's exit until the master has read all of its
    // terminal's output. A Linux reader waits for output before it takes
    // credit, so it waits for the view with the tail in the PTY, which
    // holds more than one read returns (4095 bytes): the exit ends that
    // wait, its drain records the tail as two events, and the view, sent
    // the first whole once it can send, is still owed the second at its
    // close. Elsewhere the read the reader is blocked in when the window
    // fills took its credit before, so it takes a tail written at once and
    // within macOS's 100-byte terminal output chunk whole, nothing is left
    // in the PTY at the exit, and the redial carries the exit alone.
    #[cfg(target_os = "linux")]
    const TAIL: usize = 6000;
    #[cfg(not(target_os = "linux"))]
    const TAIL: usize = 64;
    let rig = Rig::new(
        RING,
        &format!("stty -onlcr; read -r _; head -c {TAIL} /dev/zero | tr '\\0' 'x'; exit 23"),
    )
    .await;
    let (mut view, initial) = rig.attach_acking().await;
    let generation = number(&initial, "generation");
    let start = number(&initial, "seq");
    let window = number(&initial, "ack_window");
    assert_eq!(
        window,
        (RING / 2) as u64,
        "fixture: the window is half the ring"
    );
    // The window counts the view's replay, and output recorded while the
    // program waits for its line fills the rest.
    let fill = window - number(&initial, "replay_bytes");
    rig.output(&vec![b'x'; fill as usize]);
    let total = fill + TAIL as u64;
    let mut watcher = rig
        .state
        .terminal_sessions
        .attach_for_ws(rig.handle.id(), None, None)
        .expect("watch the session");
    #[cfg(target_os = "linux")]
    let held = Arc::new(AtomicBool::new(false));
    #[cfg(target_os = "linux")]
    arm_attach_seam(rig.handle.id(), AttachSeam::ReaderWaitingForProgress, {
        let held = held.clone();
        move || held.store(true, Ordering::SeqCst)
    });
    let input_at = tokio::time::Instant::now();
    rig.handle.send_input(b"\n");
    bounded("the program exits", async {
        loop {
            match watcher.rx.recv().await {
                Ok(SessionEvent::Exit(_)) => break,
                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(error) => panic!("session ended without an exit event: {error}"),
            }
        }
    })
    .await;
    // The exit ends every wait of the reader, so one seen now came first.
    // Off Linux nothing is pending in the PTY at the exit, so the reader
    // need not be waiting for the view then.
    #[cfg(target_os = "linux")]
    assert!(
        held.load(Ordering::SeqCst),
        "fixture: the reader waits for the view when the program exits"
    );
    assert!(
        tokio::time::Instant::now() - input_at
            < NO_PROGRESS_LIMIT - std::time::Duration::from_secs(1),
        "fixture: the program exits before the reader's bound can release the view"
    );
    // The view reads the window it is sent and reports none of it.
    let mut received = read_replay_until_quiet(&mut view).await;
    assert!(
        received < total,
        "fixture: the full window holds back the rest of the output and the exit"
    );
    // An ack that advances makes room for the rest, and a ping in the same
    // write is read while the view can send.
    let withheld_from = received;
    bounded("send the client's ack and ping", async {
        view.feed(ClientMessage::Text(
            json!({"type": "ack", "generation": generation, "seq": start})
                .to_string()
                .into(),
        ))
        .await?;
        view.feed(ClientMessage::Text(
            json!({"type": "ping"}).to_string().into(),
        ))
        .await?;
        view.flush().await
    })
    .await
    .expect("client frames write");
    let pinged_at = tokio::time::Instant::now();
    let quiet_until = pinged_at + NO_PROGRESS_LIMIT + std::time::Duration::from_secs(2);
    while let Ok(frame) = tokio::time::timeout_at(quiet_until, next(&mut view)).await {
        match frame {
            ClientMessage::Binary(bytes) => received += bytes.len() as u64,
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                if let Some("error" | "session" | "exit" | "closed") = frame["type"].as_str() {
                    panic!("a view whose window is full again gets no {frame}");
                }
            }
            ClientMessage::Close(frame) => panic!(
                "a frame read while the view could send starts no clock for its next \
                 wait: closed {:?} after it: {frame:?}",
                tokio::time::Instant::now() - pinged_at
            ),
            other => panic!("the view ended: {other:?}"),
        }
    }
    assert!(
        received > withheld_from,
        "fixture: the advance let the view send more of the output"
    );
    let pinged_again_at = tokio::time::Instant::now();
    send(&mut view, json!({"type": "ping"})).await;
    let closed_at = read_until_closed(
        &mut view,
        pinged_again_at + NO_PROGRESS_LIMIT + SHORT_ACK_SLACK,
    )
    .await;
    let Some(closed_at) = closed_at else {
        panic!(
            "a view with a full window whose program exited, whose client pinged once, \
             is closed within {NO_PROGRESS_LIMIT:?} (+{SHORT_ACK_SLACK:?}) of that ping: \
             still open"
        );
    };
    let waited = closed_at - pinged_again_at;
    assert!(
        waited >= NO_PROGRESS_LIMIT,
        "the client gets the whole bound from its frame: closed after {waited:?}"
    );
    assert!(
        cfg!(not(target_os = "linux")) || received < total,
        "fixture: the view was still owed output at its close"
    );
    drop(view);
    // The client redials from what it received, as it does after any close
    // not preceded by an exit.
    let (mut redial, session, before, after) = redial(&rig, start + received, generation).await;
    assert_eq!(
        number(&session, "generation"),
        generation,
        "fixture: the same PTY life"
    );
    assert!(before.is_empty(), "fixture: no reset for the same life");
    assert_eq!(
        received + after.len() as u64,
        total,
        "the redial gets the output the view was still owed"
    );
    let mut exit = None;
    let close = loop {
        match next(&mut redial).await {
            ClientMessage::Binary(bytes) => {
                panic!(
                    "the redial is sent nothing past its replay: {} bytes",
                    bytes.len()
                )
            }
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                if frame["type"] == "exit" {
                    exit = Some(frame);
                }
            }
            ClientMessage::Close(frame) => break frame,
            other => panic!("the redial ended without a close frame: {other:?}"),
        }
    };
    assert_eq!(
        exit.expect("the redial gets the program's exit")["code"],
        23
    );
    let close = close.expect("the exit's close carries a code");
    assert_eq!(
        (u16::from(close.code), close.reason.as_str()),
        (1000, "exit")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_client_that_does_not_acknowledge_never_holds_the_program() {
    let _gate = pty_test_lock();
    let rig = Rig::new(
        64 * 1024,
        "stty -onlcr; read -r _; seq -f %.0f 1 200000; printf '__STREAM_DONE__'; read -r _",
    )
    .await;
    let (mut old, initial) = rig.attach().await;
    assert!(
        initial.get("ack_window").is_none(),
        "no window is advertised to a client that did not ask: {initial}"
    );
    let held = Arc::new(AtomicBool::new(false));
    arm_attach_seam(rig.handle.id(), AttachSeam::ReaderWaitingForProgress, {
        let held = held.clone();
        move || held.store(true, Ordering::SeqCst)
    });
    let mut watcher = rig
        .state
        .terminal_sessions
        .attach_for_ws(rig.handle.id(), None, None)
        .expect("watch the session");
    rig.handle.send_input(b"\n");
    let mut tail = Vec::new();
    bounded(
        "the program runs to its end with a view not reading",
        async {
            while !tail.ends_with(DONE_MARKER) {
                match watcher.rx.recv().await {
                    Ok(SessionEvent::Output(bytes)) => {
                        tail.extend_from_slice(&bytes);
                        let keep = tail.len().saturating_sub(DONE_MARKER.len());
                        tail.drain(..keep);
                    }
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(error) => panic!("session ended: {error}"),
                }
            }
        },
    )
    .await;
    assert!(
        !held.load(Ordering::SeqCst),
        "a client that does not acknowledge never makes the reader wait"
    );

    // PTY reads can be large enough for the broadcast to hold the whole stream,
    // so events past its capacity are what make this stopped view lag.
    const FLOOD_END: &[u8] = b"__FLOOD_DONE__";
    rig.flood();
    rig.output(FLOOD_END);

    // It then reads on and hears the loss as a count, never as a lag line.
    // An early recovery can still fit the ring, so the count is the sum.
    let (mut missed, mut recoveries, mut end) = (0, 0, Vec::new());
    while !end.ends_with(FLOOD_END) {
        match next(&mut old).await {
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                assert_ne!(frame["type"], "error", "the lag line is gone: {frame}");
                if frame["type"] == "session" {
                    recoveries += 1;
                    missed += number(&frame, "missed_bytes");
                    assert!(
                        frame.get("ack_window").is_none(),
                        "a recovery does not enroll it either: {frame}"
                    );
                }
            }
            ClientMessage::Binary(bytes) => {
                end.extend_from_slice(&bytes);
                let keep = end.len().saturating_sub(FLOOD_END.len());
                end.drain(..keep);
            }
            other => panic!("old client ended: {other:?}"),
        }
    }
    assert!(recoveries > 0, "the view fell behind and recovered");
    assert!(missed > 0, "the loss is counted");
    send(&mut old, json!({"type": "input", "data": "\n"})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replay_larger_than_the_window_waits_for_acknowledgements() {
    const RING: usize = 64 * 1024;
    let _gate = pty_test_lock();
    let rig = Rig::new(RING, "while IFS= read -r line; do :; done").await;
    rig.output(&vec![b'x'; RING - 1024]);
    let mut client = bounded(
        "attach terminal socket",
        dial_terminal_with_small_buffer(
            rig.address,
            &format!("session={}&since=0&cols=80&rows=24&ack=1", rig.handle.id()),
        ),
    )
    .await;
    let session = loop {
        if let ClientMessage::Text(text) = next(&mut client).await {
            let frame: Value = serde_json::from_str(&text).expect("control JSON");
            if frame["type"] == "session" {
                break frame;
            }
        }
    };
    let window = number(&session, "ack_window") as usize;
    let replay = number(&session, "replay_bytes") as usize;
    assert!(replay > window, "the fixture's replay exceeds the window");
    let start = number(&session, "seq") - replay as u64;
    let mut received = 0;
    while let Ok(frame) =
        tokio::time::timeout(std::time::Duration::from_millis(400), next(&mut client)).await
    {
        match frame {
            ClientMessage::Binary(bytes) => received += bytes.len(),
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                assert_ne!(frame["type"], "ready", "the replay stopped at the window");
            }
            other => panic!("socket ended in replay: {other:?}"),
        }
    }
    assert_eq!(
        received, window,
        "a replay stops at the unacknowledged window"
    );
    let generation = number(&session, "generation");
    ack(&mut client, generation, start + received as u64).await;
    loop {
        match next(&mut client).await {
            ClientMessage::Binary(bytes) => {
                received += bytes.len();
                ack(&mut client, generation, start + received.min(replay) as u64).await;
            }
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                if frame["type"] == "ready" {
                    break;
                }
            }
            other => panic!("socket ended in replay: {other:?}"),
        }
    }
    assert_eq!(received, replay, "the rest of the replay follows the ack");
}

/// A tmux pane's producer cannot be held, so its view gets the bound and the
/// count: the socket stops at the window and resumes from the ring.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stopped_tmux_view_is_bounded_by_the_window_and_resumes_with_a_count() {
    let _gate = pty_test_lock();
    let ring = 8 * 1024;
    let rig = Rig::tmux(ring).await;
    let (mut client, initial) = rig.attach_acking().await;
    let window = number(&initial, "ack_window");
    let generation = number(&initial, "generation");
    // Two floods outrun the broadcast's 1,024 events as well as the ring.
    let mut flood = rig.flood();
    flood.extend(rig.flood());
    let mut unparsed = Vec::new();
    // The socket goes quiet at the window; a read that times out is the bound.
    while let Ok(frame) =
        tokio::time::timeout(std::time::Duration::from_millis(400), next(&mut client)).await
    {
        match frame {
            ClientMessage::Binary(bytes) => unparsed.extend_from_slice(&bytes),
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                assert_ne!(frame["type"], "error", "no lag line: {frame}");
                assert_ne!(frame["type"], "session", "no replay before an ack: {frame}");
            }
            other => panic!("the pane's socket ended: {other:?}"),
        }
    }
    assert!(
        unparsed.len() as u64 >= window && unparsed.len() as u64 <= window + CHUNK_BYTES as u64,
        "the view holds the window and at most one more event: {}",
        unparsed.len()
    );
    assert_eq!(unparsed, flood[..unparsed.len()], "the stream's head");
    let sent = number(&initial, "seq") + unparsed.len() as u64;
    ack(&mut client, generation, sent).await;
    let recovery = loop {
        match next(&mut client).await {
            ClientMessage::Text(text) => {
                let frame: Value = serde_json::from_str(&text).expect("control JSON");
                assert_ne!(frame["type"], "error", "no lag line on resume: {frame}");
                if frame["type"] == "session" {
                    break frame;
                }
            }
            ClientMessage::Binary(bytes) => panic!("output before recovery: {} bytes", bytes.len()),
            other => panic!("the pane's socket ended: {other:?}"),
        }
    };
    let (missed, replay) = (
        number(&recovery, "missed_bytes"),
        number(&recovery, "replay_bytes"),
    );
    assert!(missed > 0, "the ring moved past the view: {recovery}");
    assert_eq!(
        sent + missed + replay,
        number(&recovery, "seq"),
        "the count closes the gap to the server's cursor"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_the_known_ack_version_is_advertised_and_a_stray_ack_is_harmless() {
    let _gate = pty_test_lock();
    let rig = Rig::new(64 * 1024, "while IFS= read -r line; do :; done").await;
    let (_acking, frame) = rig.attach_acking().await;
    assert_eq!(number(&frame, "ack_window"), 32 * 1024);
    let (_future, frame) = rig.attach_with("&ack=2").await;
    assert!(
        frame.get("ack_window").is_none(),
        "unknown version: {frame}"
    );
    let (_word, frame) = rig.attach_with("&ack=next").await;
    assert!(
        frame.get("ack_window").is_none(),
        "unknown spelling: {frame}"
    );
    let (mut plain, frame) = rig.attach().await;
    assert!(frame.get("ack_window").is_none(), "no ack key: {frame}");
    ack(&mut plain, number(&frame, "generation"), 1).await;
    send(&mut plain, json!({"type": "ping"})).await;
    loop {
        if let ClientMessage::Text(text) = next(&mut plain).await {
            let frame: Value = serde_json::from_str(&text).expect("control JSON");
            assert_ne!(frame["type"], "error", "a stray ack is ignored: {frame}");
            if frame["type"] == "pong" {
                break;
            }
        }
    }
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
        AttachSeam::AttachAfterRingLock,
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
