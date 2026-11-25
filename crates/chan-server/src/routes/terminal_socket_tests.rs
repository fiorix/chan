use super::*;

fn input_state() -> InputState {
    let client = chan_library::client_sessions::ClientTenant::default()
        .connect(Some("pending-replies"), "reply-tests", "terminal")
        .expect("register fixture client");
    InputState {
        client,
        size: None,
        size_conditional: false,
        focus: None,
        queue_details: false,
        frames: 0,
        replies: VecDeque::new(),
        reply_bytes: 0,
        cwd: None,
    }
}

fn text_bytes(message: &Message) -> usize {
    match message {
        Message::Text(text) => text.len(),
        other => panic!("expected a control frame, got {other:?}"),
    }
}

fn sized_reply(bytes: usize) -> ServerFrame {
    let overhead = text_bytes(&frame_message(ServerFrame::RenameFailed {
        message: String::new(),
    }));
    let frame = ServerFrame::RenameFailed {
        message: "x".repeat(
            bytes
                .checked_sub(overhead)
                .expect("frame fits its envelope"),
        ),
    };
    assert_eq!(
        serde_json::to_string(&frame)
            .expect("serialize sized reply")
            .len(),
        bytes
    );
    frame
}

#[test]
fn a_pending_reply_batch_accepts_32_frames_and_refuses_the_33rd() {
    let mut input = input_state();
    for number in 0..32 {
        assert!(
            input
                .reply(ServerFrame::RenameFailed {
                    message: number.to_string(),
                })
                .is_ok(),
            "reply {number} fits the message bound"
        );
    }
    let bytes = input.reply_bytes;
    assert!(
        input.reply(ServerFrame::Pong).is_err(),
        "the 33rd reply exceeds the message bound"
    );
    assert_eq!(
        input.replies.len(),
        32,
        "refusal leaves every accepted reply queued"
    );
    assert_eq!(input.reply_bytes, bytes, "refusal consumes no byte credit");
    for (number, (_, message)) in input.replies.iter().enumerate() {
        let Message::Text(text) = message else {
            panic!("control reply is text");
        };
        let frame: serde_json::Value = serde_json::from_str(text).expect("serialized reply JSON");
        assert_eq!(
            frame["message"],
            number.to_string(),
            "accepted replies retain FIFO order"
        );
    }
}

#[test]
fn pending_reply_bytes_accept_exactly_eight_mib_and_refuse_more() {
    let mut input = input_state();
    let half = 4 * 1024 * 1024;
    assert!(input.reply(sized_reply(half)).is_ok());
    assert!(
        input.reply(sized_reply(half)).is_ok(),
        "the byte bound is inclusive"
    );
    assert_eq!(input.reply_bytes, 8 * 1024 * 1024);
    assert_eq!(
        input.replies.len(),
        2,
        "the message-count bound is not involved"
    );
    assert!(
        input.reply(ServerFrame::Pong).is_err(),
        "another small reply exceeds the aggregate byte bound"
    );
    assert_eq!(
        input.reply_bytes,
        8 * 1024 * 1024,
        "refusal leaves byte accounting intact"
    );
    assert_eq!(
        input.replies.len(),
        2,
        "refusal retains both accepted replies"
    );
}

#[test]
fn a_single_oversized_reply_preserves_the_pending_batch() {
    let mut input = input_state();
    input.reply(ServerFrame::Pong).expect("small reply");
    let bytes = input.reply_bytes;
    assert!(
        input.reply(sized_reply(8 * 1024 * 1024 + 1)).is_err(),
        "one reply cannot exceed the entire byte budget"
    );
    assert_eq!(input.replies.len(), 1);
    assert_eq!(input.reply_bytes, bytes);
    let (_, message) = input.replies.front().expect("accepted reply remains");
    let Message::Text(text) = message else {
        panic!("control reply is text");
    };
    let frame: serde_json::Value = serde_json::from_str(text).expect("serialized reply JSON");
    assert_eq!(frame["type"], "pong");
}

#[test]
fn a_full_queue_with_maximum_escaped_bodies_fits_one_reply() {
    use crate::terminal_sessions::{ControlSocketEnv, Registry, RegistryConfig};

    let registry = Registry::new(RegistryConfig {
        workspace_root: std::env::temp_dir(),
        mcp_socket_path: None,
        control_socket: ControlSocketEnv::None,
        terminal: crate::config::TerminalConfig::default(),
    });
    let session = registry
        .create_tmux_pane_for_test(1, 1, pty_size(Some(80), Some(24)))
        .expect("process-free terminal queue");
    let body = "\u{0001}".repeat(4096);
    for number in 0..100 {
        assert_eq!(
            session.enqueue_prompt(body.clone(), None, Some(format!("prompt-{number}"))),
            Some(number + 1),
            "all 100 maximum-size messages fit the real terminal queue"
        );
    }
    assert_eq!(
        session.enqueue_prompt("overflow".into(), None, None),
        None,
        "the fixture reached the real queue capacity"
    );
    let messages = session.queued_message_previews();
    assert_eq!(messages.len(), 100);
    assert!(messages.iter().all(|message| message.text == body));
    let mut input = input_state();
    assert!(
        input.reply(ServerFrame::QueueDetails { messages }).is_ok(),
        "a valid full queue preview fits the reply budget after JSON escaping"
    );
    assert_eq!(input.replies.len(), 1);
    assert!(
        input.reply_bytes > 2 * 1024 * 1024,
        "the fixture exercises JSON escaping beyond the raw text size"
    );
    let (counted, message) = input.replies.front().expect("preview reply");
    assert_eq!(*counted, text_bytes(message));
    let Message::Text(text) = message else {
        panic!("control reply is text");
    };
    let frame: serde_json::Value = serde_json::from_str(text).expect("serialized preview JSON");
    assert_eq!(frame["type"], "queue-details");
    let previews = frame["messages"].as_array().expect("preview array");
    assert_eq!(previews.len(), 100);
    for (number, preview) in previews.iter().enumerate() {
        assert_eq!(preview["text"].as_str(), Some(body.as_str()));
        assert_eq!(preview["prompt_id"], format!("prompt-{number}"));
    }
    assert_eq!(
        session.queue_depth(),
        100,
        "building a preview does not drain the queue"
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replies_received_during_a_flush_wait_for_the_next_output_turn() {
    use super::super::streamlag_tests::PendingSend;
    use super::super::tests::{dial_terminal_with_small_buffer, PROBE_BUDGET};
    use serde_json::json;
    use tokio_tungstenite::tungstenite::Message as ClientMessage;

    struct Server(tokio::task::JoinHandle<()>);
    impl Drop for Server {
        fn drop(&mut self) {
            self.0.abort();
        }
    }

    let state = crate::state::test_support::make_test_state(false);
    let session = state
        .terminal_sessions
        .create_tmux_pane_for_test(1, 1, pty_size(Some(80), Some(24)))
        .expect("process-free terminal");
    let mut pending = PendingSend::text_at_least(session.id(), 1024 * 1024);
    let route_state = state.clone();
    let id = session.id().to_owned();
    let app = axum::Router::new().route(
        "/api/terminal/ws",
        axum::routing::get(move |upgrade: WebSocketUpgrade| {
            let state = route_state.clone();
            let id = id.clone();
            async move {
                upgrade.on_upgrade(move |socket| async move {
                    let session = state
                        .terminal_sessions
                        .attach(&id, None)
                        .expect("fixture session");
                    let client = state
                        .client_sessions
                        .connect(Some("flush-client"), "flush-window", "terminal")
                        .expect("register socket client");
                    let mut socket = TerminalSocket::new(socket, state, client, None, false);
                    socket
                        .input
                        .reply(sized_reply(1024 * 1024))
                        .expect("large initial reply");
                    socket
                        .flush_replies(&session)
                        .await
                        .expect("first reply batch");
                    socket
                        .frame(&session, ServerFrame::Pong)
                        .await
                        .expect("intervening output turn");
                    socket
                        .flush_replies(&session)
                        .await
                        .expect("next reply batch");
                })
            }
        }),
    );
    let listener = tokio::net::TcpSocket::new_v4().expect("TCP socket");
    listener
        .set_send_buffer_size(64 * 1024)
        .expect("small send buffer");
    listener
        .bind("127.0.0.1:0".parse().expect("loopback address"))
        .expect("bind fixture socket");
    let listener = listener.listen(1).expect("listen fixture socket");
    let address = listener.local_addr().expect("fixture address");
    let _server = Server(tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve fixture route");
    }));
    let mut client =
        tokio::time::timeout(PROBE_BUDGET, dial_terminal_with_small_buffer(address, ""))
            .await
            .expect("connect before deadline");
    pending.wait().await;
    tokio::time::timeout(
        PROBE_BUDGET,
        client.send(ClientMessage::Text(
            json!({"type":"rename", "name":"renamed-during-reply"})
                .to_string()
                .into(),
        )),
    )
    .await
    .expect("send before deadline")
    .expect("rename request writes");
    tokio::time::timeout(PROBE_BUDGET, async {
        while session.live_metadata().name.as_deref() != Some("renamed-during-reply") {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the pending send pumps the rename request before any reply is drained");

    let frames = tokio::time::timeout(PROBE_BUDGET, async {
        let mut frames = Vec::new();
        while frames.len() < 3 {
            match client
                .next()
                .await
                .expect("socket remains open")
                .expect("server frame")
            {
                ClientMessage::Text(text) => frames
                    .push(serde_json::from_str::<serde_json::Value>(&text).expect("reply JSON")),
                frame => panic!("expected three control frames, got {frame:?}"),
            }
        }
        frames
    })
    .await
    .expect("both reply batches and their intervening output arrive");
    assert_eq!(frames[0]["type"], "rename_failed");
    assert_eq!(
        frames[1]["type"], "pong",
        "a request accepted during a reply send must leave the next output turn runnable"
    );
    assert_eq!(frames[2]["type"], "renamed");
    assert_eq!(frames[2]["name"], "renamed-during-reply");
}
