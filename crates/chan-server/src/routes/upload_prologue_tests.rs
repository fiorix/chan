use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::Poll;

const WINDOW: &str = "prologue-window";
const TRANSFER: &str = "prologue-transfer";
const FIELD_BYTES: &str = "metadata-value";

struct BodyDrop(Arc<AtomicBool>);

impl Drop for BodyDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

fn controlled_body() -> (
    tokio::sync::mpsc::UnboundedSender<std::io::Result<Bytes>>,
    Body,
    Arc<AtomicBool>,
) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let dropped = Arc::new(AtomicBool::new(false));
    let guard = BodyDrop(dropped.clone());
    let body = Body::from_stream(futures::stream::poll_fn(move |cx| {
        let _guard = &guard;
        rx.poll_recv(cx)
    }));
    (tx, body, dropped)
}

fn field_start(name: &str) -> String {
    format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n")
}

fn tracked(mut request: Request<Body>, enabled: bool) -> Request<Body> {
    if enabled {
        request
            .headers_mut()
            .insert("x-chan-window-id", WINDOW.parse().unwrap());
        request
            .headers_mut()
            .insert("x-chan-transfer-id", TRANSFER.parse().unwrap());
    }
    request
}

async fn cancel(app: &axum::Router) -> Value {
    let response = app
        .clone()
        .oneshot(tracked(
            Request::post("/api/transfers/cancel")
                .body(Body::empty())
                .unwrap(),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    json_body(response).await
}

#[derive(Clone, Copy, Debug)]
enum Silence {
    FirstBoundary,
    PartHeader,
    EmptyDir,
    EmptyPath,
    EmptyIgnored,
    Dir,
    Path,
    Delimiter,
    BetweenParts,
    Ignored,
    FileHeader,
    ClosingDelimiter,
}

impl Silence {
    fn prefix(self) -> String {
        let dir = format!("{}{FIELD_BYTES}", field_start("dir"));
        match self {
            Self::FirstBoundary => String::new(),
            Self::PartHeader => format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"dir\"\r\n"),
            Self::EmptyDir => field_start("dir"),
            Self::EmptyPath => field_start("path"),
            Self::EmptyIgnored => field_start("untrusted-part-name"),
            Self::Dir | Self::Delimiter => dir,
            Self::Path => format!("{}{FIELD_BYTES}", field_start("path")),
            Self::BetweenParts => format!("{dir}\r\n--{BOUNDARY}\r\n"),
            Self::Ignored => format!("{}{FIELD_BYTES}", field_start("untrusted-part-name")),
            Self::FileHeader => format!("{dir}\r\n--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"never.bin\"\r\n"),
            Self::ClosingDelimiter => format!("{dir}\r\n--{BOUNDARY}"),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::EmptyDir | Self::Dir | Self::Delimiter => "multipart dir",
            Self::EmptyPath | Self::Path => "multipart path",
            Self::EmptyIgnored | Self::Ignored => "multipart ignored part",
            _ => "multipart part header",
        }
    }

    fn bytes(self) -> usize {
        match self {
            Self::FirstBoundary
            | Self::PartHeader
            | Self::EmptyDir
            | Self::EmptyPath
            | Self::EmptyIgnored => 0,
            _ => FIELD_BYTES.len(),
        }
    }
}

async fn assert_stall(events: &[Event], response: Response, silence: Silence) {
    assert_eq!(
        response.status(),
        StatusCode::REQUEST_TIMEOUT,
        "{silence:?}: {events:?}"
    );
    let body = json_body(response).await;
    assert_eq!(body["code"], "upload_stalled", "{silence:?}: {body}");
    let expected = format!(
        "request body stalled after {} bytes with no progress for {STALL_BOUND:?}",
        silence.bytes()
    );
    assert_eq!(body["error"], expected, "{silence:?}");
    let lines = with_message(events, STALLED);
    assert_eq!(lines.len(), 1, "exactly one stall line: {events:?}");
    assert_eq!(lines[0].level, tracing::Level::WARN);
    assert_eq!(lines[0].fields["destination"], silence.label());
    assert_eq!(lines[0].fields["error"], expected);
    assert!(errors(events).is_empty(), "{events:?}");
    assert!(with_message(events, INCOMPLETE).is_empty(), "{events:?}");
}

async fn silent_arm(kind: &str, silence: Silence, tracking: bool, cancelling: bool) {
    let (_cfg, workspace_root, mut workspace_state) = served_state();
    let workspace = idle_workspace(&workspace_state).await;
    let mut files = crate::routes::standalone_fs::test_fixture::files_fixture();
    let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();
    let bulk = bulk.with_stall_timeout(STALL_BOUND);
    let state = if kind == "workspace" {
        &mut workspace_state
    } else {
        &mut files.state
    };
    Arc::get_mut(state).unwrap().bulk_transfer = bulk.clone();
    let state = state.clone();
    let app = if kind == "workspace" {
        crate::router(state.clone())
    } else {
        crate::terminal_router(state.clone())
    };
    let root = if kind == "workspace" {
        workspace_root.path().to_path_buf()
    } else {
        files.root.join("home/user")
    };
    let before = entries(&root);
    let (tx, body, dropped) = controlled_body();
    tx.send(Ok(Bytes::from(silence.prefix()))).unwrap();
    let mut request = tracked(upload(body), tracking);
    if kind == "files" {
        *request.uri_mut() = "/api/fs/upload?app=files".parse().unwrap();
    }
    tokio::time::pause();
    let mut handler = Box::pin(send_router_captured(app.clone(), request));
    assert!(
        futures::poll!(handler.as_mut()).is_pending(),
        "{kind} {silence:?}: holds at silence"
    );
    assert!(!dropped.load(Ordering::SeqCst));
    assert_eq!(
        crate::bulk_transfer::test_support::lane_counts(&bulk),
        (0, 0)
    );
    assert_eq!(workspace.strong_count(), 1, "no workspace pin");
    assert!(
        state.workspace_cell.try_write().is_ok(),
        "no workspace cell lock"
    );
    if cancelling {
        assert_eq!(cancel(&app).await["status"], "cancel_requested");
    } else {
        if tracking {
            let mut duplicate = tracked(upload(Body::empty()), true);
            if kind == "files" {
                *duplicate.uri_mut() = "/api/fs/upload?app=files".parse().unwrap();
            }
            let response = app.clone().oneshot(duplicate).await.unwrap();
            assert_eq!(
                response.status(),
                StatusCode::CONFLICT,
                "registration is live"
            );
            assert_eq!(
                json_body(response).await["code"],
                "transfer_tracking_conflict"
            );
        }
        // Pausing after fixture startup retains a fractional millisecond;
        // Tokio rounds a timer's wake up to the following millisecond tick.
        tokio::time::advance(STALL_BOUND + std::time::Duration::from_millis(1)).await;
    }
    let Poll::Ready((events, response)) = futures::poll!(handler.as_mut()) else {
        panic!("{kind} {silence:?}: prologue must release without another body byte");
    };
    assert!(
        dropped.load(Ordering::SeqCst),
        "parser releases its body at response"
    );
    assert_eq!(
        cancel(&app).await["status"],
        "not_found",
        "response removes registration"
    );
    drop(handler);
    assert_eq!(
        crate::bulk_transfer::test_support::lane_counts(&bulk),
        (0, 0)
    );
    assert_eq!(workspace.strong_count(), 1);
    assert!(state.workspace_cell.try_write().is_ok());
    assert_eq!(entries(&root), before, "no target or temporary file");
    tokio::time::resume();
    if cancelling {
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(json_body(response).await["code"], "upload_incomplete");
        let lines = with_message(&events, INCOMPLETE);
        assert_eq!(lines.len(), 1, "{events:?}");
        assert_eq!(lines[0].level, tracing::Level::INFO);
        assert!(with_message(&events, STALLED).is_empty());
        assert!(errors(&events).is_empty());
    } else {
        assert_stall(&events, response, silence).await;
    }
}

macro_rules! silent_pin {
    ($name:ident, $point:ident) => {
        #[tokio::test]
        async fn $name() {
            silent_arm("workspace", Silence::$point, true, false).await;
        }
    };
}

silent_pin!(silence_before_first_boundary_is_bounded, FirstBoundary);
silent_pin!(silence_inside_part_header_is_bounded, PartHeader);
silent_pin!(silence_inside_dir_is_bounded, Dir);
silent_pin!(silence_inside_path_is_bounded, Path);
silent_pin!(silence_before_value_delimiter_is_bounded, Delimiter);
silent_pin!(silence_between_parts_is_bounded, BetweenParts);
silent_pin!(silence_inside_ignored_part_is_bounded, Ignored);
silent_pin!(silence_inside_file_header_is_bounded, FileHeader);
silent_pin!(
    silence_inside_closing_delimiter_is_bounded,
    ClosingDelimiter
);

#[tokio::test]
async fn silence_before_the_first_field_byte_is_bounded() {
    for silence in [Silence::EmptyDir, Silence::EmptyPath, Silence::EmptyIgnored] {
        silent_arm("workspace", silence, true, false).await;
    }
}

#[tokio::test]
async fn every_entry_uses_its_tenant_bound_with_or_without_tracking() {
    for kind in ["workspace", "terminal", "files"] {
        for tracking in [false, true] {
            silent_arm(kind, Silence::Dir, tracking, false).await;
        }
    }
}

#[tokio::test]
async fn cancellation_interrupts_every_prologue_wait() {
    for kind in ["workspace", "terminal", "files"] {
        for silence in [
            Silence::Dir,
            Silence::Path,
            Silence::Ignored,
            Silence::BetweenParts,
            Silence::PartHeader,
            Silence::EmptyDir,
            Silence::EmptyPath,
            Silence::EmptyIgnored,
        ] {
            silent_arm(kind, silence, true, true).await;
        }
    }
}

struct ProloguePolicy {
    stall: crate::bulk_transfer::BulkCancel,
    control: Option<Arc<crate::routes::transfer::UploadControl>>,
}

async fn inspect_prologue(
    axum::extract::State(policy): axum::extract::State<Arc<ProloguePolicy>>,
    mut multipart: crate::extract::Multipart,
) -> Response {
    use axum::response::IntoResponse;
    crate::routes::files::with_upload_destination_checked(
        &mut multipart,
        crate::routes::files::UploadDestinationParts::DirOrPath,
        false,
        &policy.stall,
        policy.control.as_deref(),
        async |destination, _field| {
            axum::Json(serde_json::json!({
                "dir": destination.dir,
                "path": destination.replace_path,
                "filename": destination.filename,
            }))
            .into_response()
        },
    )
    .await
}

fn inspector() -> axum::Router {
    inspector_with_control(None)
}

fn inspector_with_control(
    control: Option<Arc<crate::routes::transfer::UploadControl>>,
) -> axum::Router {
    axum::Router::new()
        .route("/api/fs/upload", axum::routing::post(inspect_prologue))
        .with_state(Arc::new(ProloguePolicy {
            stall: crate::bulk_transfer::test_support::with_stall_timeout(STALL_BOUND),
            control,
        }))
}

fn file_tail() -> String {
    format!("\r\n--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"payload.bin\"\r\n\r\ndata\r\n--{BOUNDARY}--\r\n")
}

#[tokio::test]
async fn metadata_limits_and_refusal_envelopes_are_preserved() {
    for (bytes, status, error) in [
        (vec![b'x'; 64 * 1024], StatusCode::OK, None),
        (
            vec![b'x'; 64 * 1024 + 1],
            StatusCode::BAD_REQUEST,
            Some("multipart read: write too large: 65537 bytes exceeds 65536 byte cap for text"),
        ),
        (
            vec![0xff],
            StatusCode::BAD_REQUEST,
            Some("multipart read: io error: raw text write body is not valid UTF-8"),
        ),
        (
            vec![0xe2, 0x82],
            StatusCode::BAD_REQUEST,
            Some("multipart read: io error: raw text write body is not valid UTF-8"),
        ),
    ] {
        let mut content = field_start("dir").into_bytes();
        content.extend_from_slice(&bytes);
        content.extend_from_slice(file_tail().as_bytes());
        let (events, response) =
            send_router_captured(inspector(), upload(Body::from(content))).await;
        assert_eq!(response.status(), status, "{bytes:?}");
        let body = json_body(response).await;
        if let Some(error) = error {
            assert_eq!(body, serde_json::json!({"error": error}));
        } else {
            assert_eq!(body["dir"].as_str().unwrap().as_bytes(), bytes);
        }
        assert!(with_message(&events, STALLED).is_empty());
        assert!(with_message(&events, INCOMPLETE).is_empty());
        assert!(errors(&events).is_empty());
    }
    for (content, expected) in [
        (
            file_tail().trim_start_matches("\r\n").to_owned(),
            "`dir` or `path` must precede the streaming `file` part",
        ),
        (
            format!("{}ok\r\n--{BOUNDARY}--\r\n", field_start("dir")),
            "missing `file` part in multipart body",
        ),
    ] {
        let response = inspector()
            .oneshot(upload(Body::from(content)))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            json_body(response).await,
            serde_json::json!({"error": expected})
        );
    }
    for (content, prefix) in [
        ("not a multipart body".to_owned(), "multipart parse: "),
        (
            format!("{}unfinished", field_start("dir")),
            "multipart read: ",
        ),
        (
            format!("{}unfinished", field_start("ignored")),
            "multipart parse: ",
        ),
    ] {
        let response = inspector()
            .oneshot(upload(Body::from(content)))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = json_body(response).await;
        assert_eq!(body.as_object().unwrap().len(), 1);
        assert!(
            body["error"].as_str().unwrap().starts_with(prefix),
            "{body}"
        );
    }
}

#[tokio::test]
async fn split_utf8_and_binary_ignored_content_complete() {
    let (tx, body, _) = controlled_body();
    tx.send(Ok(Bytes::from(field_start("ignored")))).unwrap();
    let mut handler = Box::pin(inspector().oneshot(upload(body)));
    assert!(futures::poll!(handler.as_mut()).is_pending());
    for _ in 0..16 {
        tx.send(Ok(Bytes::from(vec![0xff; 64 * 1024]))).unwrap();
        assert!(
            futures::poll!(handler.as_mut()).is_pending(),
            "ignored content has no text or size constraint"
        );
    }
    tx.send(Ok(Bytes::from(format!("\r\n{}", field_start("dir")))))
        .unwrap();
    assert!(futures::poll!(handler.as_mut()).is_pending());
    for byte in "\u{20ac}".as_bytes() {
        tx.send(Ok(Bytes::copy_from_slice(&[*byte]))).unwrap();
        assert!(futures::poll!(handler.as_mut()).is_pending());
    }
    tx.send(Ok(Bytes::from(file_tail()))).unwrap();
    let response = handler.await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_body(response).await["dir"], "\u{20ac}");
}

#[tokio::test(start_paused = true)]
async fn progressing_fields_and_drains_reset_the_no_progress_bound() {
    for name in ["dir", "path", "ignored"] {
        let (tx, body, _) = controlled_body();
        tx.send(Ok(Bytes::from(field_start(name)))).unwrap();
        let mut handler = Box::pin(inspector().oneshot(upload(body)));
        assert!(futures::poll!(handler.as_mut()).is_pending());
        let chunks = if name == "ignored" { 16 } else { 4 };
        for _ in 0..chunks {
            tokio::time::advance(STALL_BOUND * 9 / 10).await;
            let bytes = if name == "ignored" {
                Bytes::from(vec![0xff; 64 * 1024])
            } else {
                Bytes::from_static(b"x")
            };
            tx.send(Ok(bytes)).unwrap();
            assert!(
                futures::poll!(handler.as_mut()).is_pending(),
                "{name}: progress resets the bound"
            );
        }
        if name == "ignored" {
            tx.send(Ok(Bytes::from(format!("\r\n{}ok", field_start("dir")))))
                .unwrap();
        }
        tx.send(Ok(Bytes::from(file_tail()))).unwrap();
        let response = handler.await.unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{name}");
        let body = json_body(response).await;
        let expected = if name == "ignored" { "ok" } else { "xxxx" };
        let key = if name == "path" { "path" } else { "dir" };
        assert_eq!(body[key], expected);
    }
}

#[tokio::test(start_paused = true)]
async fn empty_body_chunks_do_not_extend_the_no_progress_bound() {
    let (tx, body, _) = controlled_body();
    tx.send(Ok(Bytes::from(Silence::Dir.prefix()))).unwrap();
    let mut handler = Box::pin(send_router_captured(inspector(), upload(body)));
    assert!(futures::poll!(handler.as_mut()).is_pending());
    for _ in 0..3 {
        tokio::time::advance(STALL_BOUND / 4).await;
        tx.send(Ok(Bytes::new())).unwrap();
        assert!(futures::poll!(handler.as_mut()).is_pending());
    }
    tokio::time::advance(STALL_BOUND / 4 + std::time::Duration::from_millis(1)).await;
    let Poll::Ready((events, response)) = futures::poll!(handler.as_mut()) else {
        panic!("empty chunks must not extend the no-progress bound");
    };
    assert_stall(&events, response, Silence::Dir).await;
}

#[tokio::test(start_paused = true)]
async fn a_part_header_has_one_deadline_even_with_byte_progress() {
    for timely in [false, true] {
        let (tx, body, _) = controlled_body();
        tx.send(Ok(Bytes::from(format!(
            "--{BOUNDARY}\r\nContent-Disposition: "
        ))))
        .unwrap();
        let mut handler = Box::pin(send_router_captured(inspector(), upload(body)));
        assert!(futures::poll!(handler.as_mut()).is_pending());
        tokio::time::advance(STALL_BOUND / 2).await;
        tx.send(Ok(Bytes::from_static(b"form-data; "))).unwrap();
        assert!(futures::poll!(handler.as_mut()).is_pending());
        if timely {
            tokio::time::advance(STALL_BOUND / 4).await;
            tx.send(Ok(Bytes::from(format!(
                "name=\"dir\"\r\n\r\nok{}",
                file_tail()
            ))))
            .unwrap();
            let (_, response) = handler.await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(json_body(response).await["dir"], "ok");
        } else {
            tokio::time::advance(STALL_BOUND / 2 + std::time::Duration::from_millis(1)).await;
            tx.send(Ok(Bytes::from_static(b"name="))).unwrap();
            let Poll::Ready((events, response)) = futures::poll!(handler.as_mut()) else {
                panic!("header progress must not reset its parser deadline");
            };
            assert_stall(&events, response, Silence::PartHeader).await;
        }
    }
}

#[tokio::test(start_paused = true)]
async fn transition_byte_count_includes_named_and_ignored_fields() {
    let (tx, body, _) = controlled_body();
    let prefix = format!(
        "{}abc\r\n{}\u{20ac}\r\n{}12345\r\n--{BOUNDARY}\r\n",
        field_start("dir"),
        field_start("ignored"),
        field_start("path")
    );
    tx.send(Ok(Bytes::from(prefix))).unwrap();
    let mut handler = Box::pin(send_router_captured(inspector(), upload(body)));
    assert!(futures::poll!(handler.as_mut()).is_pending());
    tokio::time::advance(STALL_BOUND + std::time::Duration::from_millis(1)).await;
    let Poll::Ready((events, response)) = futures::poll!(handler.as_mut()) else {
        panic!("transition must end at its bound");
    };
    assert_eq!(response.status(), StatusCode::REQUEST_TIMEOUT);
    let body = json_body(response).await;
    let expected = "request body stalled after 11 bytes with no progress for 100ms";
    assert_eq!(body["error"], expected);
    let lines = with_message(&events, STALLED);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].fields["destination"], "multipart part header");
    assert_eq!(lines[0].fields["error"], expected);
}

#[tokio::test]
async fn an_upload_lands_after_a_large_binary_ignored_part() {
    let (_cfg, root, state) = served_state();
    let mut content = field_start("ignored").into_bytes();
    content.extend_from_slice(&vec![0xff; 1024 * 1024]);
    content.extend_from_slice(format!("\r\n{}{}", field_start("dir"), file_tail()).as_bytes());
    let response = crate::router(state)
        .oneshot(upload(Body::from(content)))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        std::fs::read(root.path().join("payload.bin")).unwrap(),
        b"data"
    );
}

#[tokio::test]
async fn cancellation_and_completed_data_precede_an_expired_timer() {
    let (_cfg, _root, state) = served_state();
    let _workspace = idle_workspace(&state).await;
    let carrier = crate::router(state.clone());
    tokio::time::pause();
    for point in [Silence::Dir, Silence::Ignored, Silence::PartHeader] {
        for cancelling in [false, true] {
            let headers = tracked(upload(Body::empty()), true).into_parts().0.headers;
            let (tracking, registration) =
                crate::routes::transfer::TransferTracking::upload(&headers, &state).unwrap();
            let control = tracking.unwrap().upload;
            let (tx, body, _) = controlled_body();
            tx.send(Ok(Bytes::from(point.prefix()))).unwrap();
            let mut handler = Box::pin(send_router_captured(
                inspector_with_control(control),
                upload(body),
            ));
            assert!(futures::poll!(handler.as_mut()).is_pending());
            tokio::time::advance(STALL_BOUND + std::time::Duration::from_millis(1)).await;
            if cancelling {
                assert_eq!(cancel(&carrier).await["status"], "cancel_requested");
            }
            let tail = match point {
                Silence::Dir => file_tail(),
                Silence::Ignored => format!("\r\n{}ok{}", field_start("dir"), file_tail()),
                Silence::PartHeader => format!("\r\nok{}", file_tail()),
                _ => unreachable!(),
            };
            tx.send(Ok(Bytes::from(tail))).unwrap();
            let Poll::Ready((events, response)) = futures::poll!(handler.as_mut()) else {
                panic!("ready input finishes the prologue");
            };
            if cancelling {
                assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{point:?}");
                assert_eq!(json_body(response).await["code"], "upload_incomplete");
                assert_eq!(with_message(&events, INCOMPLETE).len(), 1);
            } else {
                assert_eq!(response.status(), StatusCode::OK, "{point:?}: {events:?}");
            }
            assert!(with_message(&events, STALLED).is_empty());
            drop(registration);
        }
    }
    // Cancellation may already be set when the first parser wait is polled.
    let headers = tracked(upload(Body::empty()), true).into_parts().0.headers;
    let (tracking, registration) =
        crate::routes::transfer::TransferTracking::upload(&headers, &state).unwrap();
    assert_eq!(cancel(&carrier).await["status"], "cancel_requested");
    let (events, response) = send_router_captured(
        inspector_with_control(tracking.unwrap().upload),
        complete_upload("", "never.bin", b"body"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(json_body(response).await["code"], "upload_incomplete");
    assert_eq!(with_message(&events, INCOMPLETE).len(), 1);
    drop(registration);
    tokio::time::resume();
}

struct SocketServer(tokio::task::JoinHandle<()>);

impl Drop for SocketServer {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[tokio::test]
async fn a_silent_socket_gets_408_before_sending_another_byte() {
    use futures::StreamExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let (_cfg, root, mut state) = served_state();
    let workspace = idle_workspace(&state).await;
    let before = entries(root.path());
    let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();
    let bulk = bulk.with_stall_timeout(STALL_BOUND);
    Arc::get_mut(&mut state).unwrap().bulk_transfer = bulk.clone();
    let app = crate::router(state.clone());
    let dropped = Arc::new(AtomicBool::new(false));
    let answered = Arc::new(AtomicBool::new(false));
    let events = Arc::new(Mutex::new(Vec::new()));
    let dispatch = tracing::Dispatch::new(Capture(events.clone()));
    let _registered = tracing::Dispatch::new(tracing::subscriber::NoSubscriber::default());
    tracing::callsite::rebuild_interest_cache();
    let observed = app.clone().layer(axum::middleware::from_fn({
        let dropped = dropped.clone();
        let answered = answered.clone();
        move |request: Request<Body>, next: axum::middleware::Next| {
            let guard = BodyDrop(dropped.clone());
            let answered = answered.clone();
            let dispatch = dispatch.clone();
            async move {
                tracing::info!("socket-capture-control");
                let (parts, body) = request.into_parts();
                let mut stream = body.into_data_stream();
                let body = Body::from_stream(futures::stream::poll_fn(move |cx| {
                    let _guard = &guard;
                    stream.poll_next_unpin(cx)
                }));
                let response = next.run(Request::from_parts(parts, body)).await;
                answered.store(true, Ordering::SeqCst);
                response
            }
            .with_subscriber(dispatch)
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let _server = SocketServer(tokio::spawn(async move {
        axum::serve(listener, observed).await.unwrap();
    }));
    let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
    socket.write_all(format!(
        "POST /api/fs/upload HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: multipart/form-data; boundary={BOUNDARY}\r\nContent-Length: 1048576\r\nX-Chan-Window-Id: {WINDOW}\r\nX-Chan-Transfer-Id: {TRANSFER}\r\n\r\n{}",
        Silence::Dir.prefix(),
    ).as_bytes()).await.unwrap();
    let mut wire = String::new();
    tokio::time::timeout(HANG_GUARD, socket.read_to_string(&mut wire))
        .await
        .expect("server answers while client socket remains silent")
        .unwrap();
    assert!(wire.starts_with("HTTP/1.1 408 "), "{wire}");
    let (_, body) = wire.split_once("\r\n\r\n").unwrap();
    let body: Value = serde_json::from_str(body).unwrap();
    assert_eq!(body["code"], "upload_stalled");
    assert!(answered.load(Ordering::SeqCst), "handler returned");
    assert!(dropped.load(Ordering::SeqCst), "parser and body released");
    assert_eq!(cancel(&app).await["status"], "not_found");
    assert_eq!(
        crate::bulk_transfer::test_support::lane_counts(&bulk),
        (0, 0)
    );
    assert_eq!(workspace.strong_count(), 1);
    assert!(state.workspace_cell.try_write().is_ok());
    assert_eq!(entries(root.path()), before);
    let captured = std::mem::take(&mut *events.lock().unwrap());
    assert_eq!(with_message(&captured, "socket-capture-control").len(), 1);
    let lines = with_message(&captured, STALLED);
    assert_eq!(lines.len(), 1, "{captured:?}");
    assert_eq!(lines[0].level, tracing::Level::WARN);
    assert_eq!(lines[0].fields["destination"], "multipart dir");
    assert_eq!(lines[0].fields["error"], body["error"].as_str().unwrap());
    assert!(errors(&captured).is_empty());
}
