use std::sync::{Arc, Mutex};

use axum::body::{to_bytes, Body, Bytes};
use axum::http::{header, Request, StatusCode};
use axum::response::Response;
use serde_json::Value;
use tower::ServiceExt;
use tracing::instrument::WithSubscriber;

use super::tests::served_state;
use crate::state::AppState;

#[path = "upload_cancellation_tests.rs"]
mod cancellation;

#[path = "upload_socket_cancellation_tests.rs"]
mod socket_cancellation;

const BOUNDARY: &str = "incomplete-body";
const INCOMPLETE: &str = "request body ended before completion";
const STALLED: &str = "request body stalled at the no-progress bound";
const SERVER_FAILURE: &str = "response failed";
/// The tenant's no-progress bound in these pins, short so the stall is
/// reached quickly.
const STALL_BOUND: std::time::Duration = std::time::Duration::from_millis(100);
/// A hang guard on waits that the answer ends; a green run never reaches it.
const HANG_GUARD: std::time::Duration = std::time::Duration::from_secs(10);

/// One captured event: its level and its fields as formatted text.
#[derive(Debug)]
struct Event {
    level: tracing::Level,
    fields: std::collections::BTreeMap<String, String>,
}

impl tracing::field::Visit for Event {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        self.fields
            .insert(field.name().to_owned(), format!("{value:?}"));
    }
}

struct Capture(Arc<Mutex<Vec<Event>>>);

impl tracing::Subscriber for Capture {
    fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
        true
    }
    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }
    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn event(&self, event: &tracing::Event<'_>) {
        let mut recorded = Event {
            level: *event.metadata().level(),
            fields: Default::default(),
        };
        event.record(&mut recorded);
        self.0.lock().unwrap().push(recorded);
    }
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
}

/// Send `request` through the tenant router with the request task's events
/// captured.
///
/// tracing-core caches a callsite's interest from the first thread that
/// registers it while at most one dispatcher is registered, so another test's
/// thread reaching one of these log lines first would cache it as disabled. A
/// second registered dispatcher, held through the request, makes that
/// registration consult every dispatcher, and rebuilding the interest cache
/// corrects a callsite cached before the capture existed.
async fn send_captured(state: Arc<AppState>, request: Request<Body>) -> (Vec<Event>, Response) {
    send_router_captured(crate::router(state), request).await
}

async fn send_router_captured(app: axum::Router, request: Request<Body>) -> (Vec<Event>, Response) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let dispatch = tracing::Dispatch::new(Capture(Arc::clone(&events)));
    let _registered = tracing::Dispatch::new(tracing::subscriber::NoSubscriber::default());
    tracing::callsite::rebuild_interest_cache();
    let response = async {
        tracing::info!("incomplete-capture-control");
        app.oneshot(request).await.unwrap()
    }
    .with_subscriber(dispatch)
    .await;
    let captured = std::mem::take(&mut *events.lock().unwrap());
    assert!(captured.iter().any(|event| event
        .fields
        .get("message")
        .is_some_and(|message| message == "incomplete-capture-control")));
    (captured, response)
}

fn with_message<'a>(events: &'a [Event], message: &str) -> Vec<&'a Event> {
    events
        .iter()
        .filter(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|text| text.starts_with(message))
        })
        .collect()
}

fn errors(events: &[Event]) -> Vec<&Event> {
    events
        .iter()
        .filter(|event| event.level == tracing::Level::ERROR)
        .collect()
}

fn upload_head(name: &str) -> Vec<u8> {
    format!(
        "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"dir\"\r\n\r\n\r\n\
         --{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n\
         Content-Type: application/octet-stream\r\n\r\n"
    )
    .into_bytes()
}

fn upload(body: Body) -> Request<Body> {
    Request::post("/api/fs/upload")
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={BOUNDARY}"),
        )
        .body(body)
        .unwrap()
}

fn complete_upload(dir: &str, name: &str, bytes: &[u8]) -> Request<Body> {
    let mut body = format!(
        "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"dir\"\r\n\r\n{dir}\r\n\
         --{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n\
         Content-Type: application/octet-stream\r\n\r\n"
    )
    .into_bytes();
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    upload(Body::from(body))
}

/// A body whose stream yields `head`, then `data_chunks` chunks of file data,
/// then fails as a connection the client closes mid-body does. The stream is
/// pending once before each item after the head, as a socket is between
/// reads: the multipart reader polls the stream on every read and hands a
/// stream error to whichever part it is reading, so the error has to arrive
/// while the file part streams, which is where an aborted browser upload
/// breaks off.
fn broken_body(head: Vec<u8>, data_chunks: usize) -> Body {
    let head = Bytes::from(head);
    Body::from_stream(futures::stream::unfold(0usize, move |stage| {
        let head = head.clone();
        async move {
            if stage > 0 {
                tokio::task::yield_now().await;
            }
            if stage == 0 {
                Some((Ok::<Bytes, std::io::Error>(head), 1))
            } else if stage <= data_chunks {
                Some((Ok(Bytes::from(vec![7; 4096])), stage + 1))
            } else if stage == data_chunks + 1 {
                let reset =
                    std::io::Error::new(std::io::ErrorKind::ConnectionReset, "client went away");
                Some((Err(reset), stage + 1))
            } else {
                None
            }
        }
    }))
}

/// A body whose stream yields `head` and one chunk of file data, then stays
/// pending, as a client that stops sending and keeps its connection open
/// does. `delivered` is told once the reader has polled past the data.
fn silent_body(head: Vec<u8>, delivered: Option<tokio::sync::oneshot::Sender<()>>) -> Body {
    use futures::StreamExt;
    let mut delivered = delivered;
    let items = [
        Ok::<Bytes, std::io::Error>(Bytes::from(head)),
        Ok(Bytes::from(vec![7; 4096])),
    ];
    Body::from_stream(
        futures::stream::iter(items).chain(futures::stream::poll_fn(move |_| {
            if let Some(delivered) = delivered.take() {
                let _ = delivered.send(());
            }
            std::task::Poll::<Option<std::io::Result<Bytes>>>::Pending
        })),
    )
}

async fn json_body(response: Response) -> Value {
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn an_aborted_upload_answers_upload_incomplete() {
    let (_cfg, root, state) = served_state();
    let response = crate::router(state)
        .oneshot(upload(broken_body(upload_head("aborted.bin"), 4)))
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::BAD_REQUEST,
        "an aborted upload is the client's end, not a server error"
    );
    let body = json_body(response).await;
    assert_eq!(body["code"], "upload_incomplete", "{body}");
    assert!(!root.path().join("aborted.bin").exists());
}

#[tokio::test]
async fn an_aborted_upload_logs_below_error() {
    let (_cfg, _root, state) = served_state();
    let (events, response) =
        send_captured(state, upload(broken_body(upload_head("aborted.bin"), 4))).await;
    assert!(
        errors(&events).is_empty(),
        "an aborted upload logs no ERROR line: {events:?}"
    );
    let incomplete = with_message(&events, INCOMPLETE);
    assert_eq!(incomplete.len(), 1, "one incomplete-body line: {events:?}");
    assert_eq!(incomplete[0].level, tracing::Level::INFO);
    assert!(
        incomplete[0].fields["error"].starts_with("request body read failed: "),
        "{events:?}"
    );
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn an_aborted_raw_write_answers_upload_incomplete_at_info() {
    let (_cfg, root, state) = served_state();
    let request = Request::put("/api/fs/aborted.txt")
        .body(broken_body(b"partial text".to_vec(), 2))
        .unwrap();
    let (events, response) = send_captured(state, request).await;
    assert_eq!(
        response.status(),
        StatusCode::BAD_REQUEST,
        "an aborted raw write is the client's end, not a server error"
    );
    let body = json_body(response).await;
    assert_eq!(body["code"], "upload_incomplete", "{body}");
    assert!(errors(&events).is_empty(), "{events:?}");
    assert_eq!(with_message(&events, INCOMPLETE).len(), 1, "{events:?}");
    assert!(!root.path().join("aborted.txt").exists());
}

#[cfg(unix)]
struct RestoreMode(std::path::PathBuf);

#[cfg(unix)]
impl Drop for RestoreMode {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_server_failure_under_a_complete_upload_keeps_its_500() {
    use std::os::unix::fs::PermissionsExt;
    let (_cfg, root, state) = served_state();
    let locked = root.path().join("locked");
    std::fs::create_dir(&locked).unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o500)).unwrap();
    let _restore = RestoreMode(locked.clone());
    assert_eq!(
        std::fs::write(locked.join("probe"), b"probe")
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::PermissionDenied,
        "the fixture must deny a plain write by this non-root test user"
    );
    let (events, response) =
        send_captured(state, complete_upload("locked", "denied.bin", b"bytes")).await;
    assert_eq!(
        response.status(),
        StatusCode::INTERNAL_SERVER_ERROR,
        "a write the server cannot make stays a server error"
    );
    assert_eq!(with_message(&events, SERVER_FAILURE).len(), 1, "{events:?}");
    assert!(with_message(&events, INCOMPLETE).is_empty(), "{events:?}");
}

#[tokio::test]
async fn a_complete_upload_commits() {
    let (_cfg, root, state) = served_state();
    let (events, response) = send_captured(state, complete_upload("", "whole.bin", b"whole")).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        std::fs::read(root.path().join("whole.bin")).unwrap(),
        b"whole"
    );
    assert!(errors(&events).is_empty(), "{events:?}");
    assert!(with_message(&events, INCOMPLETE).is_empty(), "{events:?}");
}

#[tokio::test]
async fn a_silent_upload_answers_upload_stalled_at_warn() {
    let (_cfg, root, mut state) = served_state();
    let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();
    Arc::get_mut(&mut state).unwrap().bulk_transfer = bulk.with_stall_timeout(STALL_BOUND);
    let before = std::fs::read_dir(root.path()).unwrap().count();
    let (events, response) = tokio::time::timeout(
        HANG_GUARD,
        send_captured(state, upload(silent_body(upload_head("silent.bin"), None))),
    )
    .await
    .expect("a silent upload is answered once its stall bound ends the job");
    assert_eq!(
        response.status(),
        StatusCode::REQUEST_TIMEOUT,
        "a client's silence ends its own request, not a server error"
    );
    let body = json_body(response).await;
    assert_eq!(body["code"], "upload_stalled", "{body}");
    assert!(
        errors(&events).is_empty(),
        "a silent upload logs no ERROR line: {events:?}"
    );
    let stalled = with_message(&events, STALLED);
    assert_eq!(stalled.len(), 1, "one stalled-body line: {events:?}");
    assert_eq!(stalled[0].level, tracing::Level::WARN);
    assert_eq!(stalled[0].fields["destination"], "silent.bin", "{events:?}");
    let error = &stalled[0].fields["error"];
    let forwarded: u64 = error
        .strip_prefix("request body stalled after ")
        .and_then(|rest| rest.strip_suffix(" bytes with no progress for 100ms"))
        .and_then(|bytes| bytes.parse().ok())
        .unwrap_or_else(|| panic!("the line names the bytes and the bound: {error}"));
    assert!(
        forwarded > 0,
        "the feed forwarded the file's first bytes: {error}"
    );
    assert_eq!(body["error"], error.as_str(), "{body}");
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lane_shutdown_under_an_upload_keeps_its_503_and_error_line() {
    let (_cfg, _root, mut state) = served_state();
    let (lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();
    let mut admitted = crate::bulk_transfer::test_support::lane_changes(&bulk);
    let view = bulk.clone();
    Arc::get_mut(&mut state).unwrap().bulk_transfer = bulk;
    let (delivered_tx, delivered_rx) = tokio::sync::oneshot::channel();
    let request = tokio::spawn(send_captured(
        state,
        upload(silent_body(upload_head("shutdown.bin"), Some(delivered_tx))),
    ));
    // The multipart reader reads the body ahead of the handler, so the
    // body's silence can come before the upload's admission: wait for both.
    tokio::time::timeout(HANG_GUARD, admitted.changed())
        .await
        .expect("fixture: the upload was admitted")
        .expect("fixture: the lane announced the admission");
    tokio::time::timeout(HANG_GUARD, delivered_rx)
        .await
        .expect("fixture: the body reached its silence")
        .expect("fixture: the body told its silence");
    // The admission announces when the job is queued, and a queued job ends
    // through its dropped sender whatever the shutdown writes, so the
    // shutdown must find the job running: wait for a worker to take it.
    tokio::time::timeout(HANG_GUARD, async {
        while crate::bulk_transfer::test_support::active_jobs(&view) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("fixture: the upload's job is running");
    // The tenant keeps the default five-minute bound, so only the shutdown
    // ends the admitted job.
    drop(lane);
    let (events, response) = tokio::time::timeout(HANG_GUARD, request)
        .await
        .expect("a shut-down lane answers the upload")
        .expect("request task");
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = json_body(response).await;
    assert_eq!(body["error"], "upload did not complete", "{body}");
    assert_eq!(with_message(&events, SERVER_FAILURE).len(), 1, "{events:?}");
    assert!(with_message(&events, STALLED).is_empty(), "{events:?}");
}

const RAW_CHUNK: &[u8] = b"partial UTF-8 text\n";

struct BodyDropped(Arc<std::sync::atomic::AtomicBool>);

impl Drop for BodyDropped {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

struct HeldRawWrite {
    release: Option<tokio::sync::oneshot::Sender<()>>,
    dropped: Arc<std::sync::atomic::AtomicBool>,
    request: tokio::task::JoinHandle<(Vec<Event>, Response)>,
    answer: Option<(Vec<Event>, Response)>,
}

impl Drop for HeldRawWrite {
    fn drop(&mut self) {
        // A fixture assertion must not strand the blocking consumer.
        if let Some(release) = self.release.take() {
            let _ = release.send(());
        }
    }
}

impl HeldRawWrite {
    fn spawn(
        app: axum::Router,
        uri: &str,
        chunk: &'static [u8],
    ) -> (Self, tokio::sync::oneshot::Receiver<()>) {
        use futures::StreamExt;
        let (pending_tx, pending_rx) = tokio::sync::oneshot::channel();
        let (release, released) = tokio::sync::oneshot::channel();
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let marker = BodyDropped(dropped.clone());
        let stream =
            futures::stream::once(
                async move { Ok::<_, std::io::Error>(Bytes::from_static(chunk)) },
            )
            .chain(futures::stream::once(async move {
                let _marker = marker;
                let _ = pending_tx.send(());
                let _ = released.await;
                Err(std::io::Error::new(
                    std::io::ErrorKind::ConnectionReset,
                    "held body released",
                ))
            }));
        let request = Request::put(uri).body(Body::from_stream(stream)).unwrap();
        let held = Self {
            release: Some(release),
            dropped,
            request: tokio::spawn(send_router_captured(app, request)),
            answer: None,
        };
        (held, pending_rx)
    }

    async fn start(app: axum::Router, uri: &str, chunk: &'static [u8]) -> Self {
        let (mut held, pending_rx) = Self::spawn(app, uri, chunk);
        tokio::time::timeout(HANG_GUARD, pending_rx)
            .await
            .expect("fixture: the raw body reaches its pending read")
            .expect("fixture: the body announces its pending read");
        held.observe_answer().await;
        held
    }

    async fn observe_answer(&mut self) {
        self.answer = tokio::time::timeout(HANG_GUARD, &mut self.request)
            .await
            .ok()
            .map(|result| result.expect("raw request task"));
    }

    fn body_dropped(&self) -> bool {
        self.dropped.load(std::sync::atomic::Ordering::SeqCst)
    }

    async fn finish(mut self) -> (Vec<Event>, Response) {
        let _ = self.release.take().unwrap().send(());
        match self.answer.take() {
            Some(answer) => answer,
            None => tokio::time::timeout(HANG_GUARD, &mut self.request)
                .await
                .expect("released raw body ends its consumer")
                .expect("raw request task"),
        }
    }
}

async fn idle_workspace(state: &Arc<AppState>) -> std::sync::Weak<chan_workspace::Workspace> {
    let workspace = state.try_workspace().unwrap();
    tokio::time::timeout(HANG_GUARD, async {
        while !workspace.recovery_status().is_ready() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("fixture: startup recovery completes");
    let weak = Arc::downgrade(&workspace);
    drop(workspace);
    // Completion publishes before the worker drops its local handle. No
    // watcher is installed in this fixture, so only the cell remains.
    tokio::time::timeout(HANG_GUARD, async {
        while weak.strong_count() != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("fixture: startup worker releases its workspace");
    weak
}

fn entries(path: &std::path::Path) -> Vec<std::ffi::OsString> {
    let mut names: Vec<_> = std::fs::read_dir(path)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    names.sort();
    names
}

async fn assert_raw_stall(events: &[Event], response: Response, destination: &str) {
    assert_eq!(response.status(), StatusCode::REQUEST_TIMEOUT, "{events:?}");
    let body = json_body(response).await;
    assert_eq!(body["code"], "upload_stalled", "{body}");
    assert!(errors(events).is_empty(), "{events:?}");
    let stalled = with_message(events, STALLED);
    assert_eq!(stalled.len(), 1, "one stalled-body line: {events:?}");
    assert_eq!(stalled[0].level, tracing::Level::WARN);
    assert_eq!(stalled[0].fields["destination"], destination, "{events:?}");
    let error = &stalled[0].fields["error"];
    let received: u64 = error
        .strip_prefix("request body stalled after ")
        .and_then(|rest| rest.strip_suffix(" bytes with no progress for 100ms"))
        .and_then(|bytes| bytes.parse().ok())
        .unwrap_or_else(|| panic!("the line names the bytes and the bound: {error}"));
    assert_eq!(
        received,
        RAW_CHUNK.len() as u64,
        "the count names every received byte: {error}"
    );
    assert_eq!(body["error"], error.as_str(), "{body}");
}

#[tokio::test]
async fn a_silent_raw_workspace_write_releases_before_reset() {
    let (_cfg, root, mut state) = served_state();
    let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();
    Arc::get_mut(&mut state).unwrap().bulk_transfer = bulk.with_stall_timeout(STALL_BOUND);
    state
        .try_workspace()
        .unwrap()
        .write_text("held.txt", "original\n")
        .unwrap();
    let weak = idle_workspace(&state).await;
    let baseline = weak.strong_count();
    let before = entries(root.path());
    let app = crate::router(state);
    let started = std::time::Instant::now();
    let held = HeldRawWrite::start(app.clone(), "/api/fs/held.txt", RAW_CHUNK).await;
    let answered = held.answer.is_some();
    let elapsed = started.elapsed();
    let count = weak.strong_count();
    let dropped = held.body_dropped();
    let bytes = std::fs::read(root.path().join("held.txt"));
    let after = entries(root.path());
    let reset = tokio::time::timeout(
        HANG_GUARD,
        app.oneshot(
            Request::post("/api/storage/reset")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"mode":"workspace"}"#))
                .unwrap(),
        ),
    )
    .await;
    let (events, response) = held.finish().await;
    eprintln!("workspace raw write: answered={answered} elapsed={elapsed:?} count={count} baseline={baseline} dropped={dropped} reset={:?}", reset.as_ref().map(|r| r.as_ref().map(Response::status)));
    assert!(
        answered,
        "a silent raw workspace write is answered before body release"
    );
    assert_raw_stall(&events, response, "held.txt").await;
    assert_eq!(
        count, baseline,
        "the consumer releases its workspace before answering"
    );
    assert!(dropped, "the unanswered feed is dropped before answering");
    assert_eq!(bytes.unwrap(), b"original\n");
    assert_eq!(after, before, "no partial temporary file remains");
    assert_eq!(
        reset.unwrap().unwrap().status(),
        StatusCode::OK,
        "the reset has no raw-write hold to drain"
    );
}

#[tokio::test]
async fn a_silent_raw_draft_write_releases_its_pin() {
    let (_cfg, _root, mut state) = served_state();
    let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();
    Arc::get_mut(&mut state).unwrap().bulk_transfer = bulk.with_stall_timeout(STALL_BOUND);
    let workspace = state.try_workspace().unwrap();
    workspace.create_draft_dir("untitled").unwrap();
    let id = workspace.draft_id("untitled").unwrap();
    workspace
        .draft_files()
        .unwrap()
        .create_text_new("untitled/draft.md", &id, "original\n")
        .unwrap();
    let directory = workspace.paths().drafts.join("untitled");
    drop(workspace);
    let weak = idle_workspace(&state).await;
    let baseline = weak.strong_count();
    let before = entries(&directory);
    let uri = format!("/api/fs/untitled/draft.md?root=draft&draft_id={id}");
    let held = HeldRawWrite::start(crate::router(state.clone()), &uri, RAW_CHUNK).await;
    let answered = held.answer.is_some();
    let count = weak.strong_count();
    let dropped = held.body_dropped();
    let bytes = std::fs::read(directory.join("draft.md"));
    let after = entries(&directory);
    let (events, response) = held.finish().await;
    eprintln!(
        "draft raw write: answered={answered} count={count} baseline={baseline} dropped={dropped}"
    );
    assert!(
        answered,
        "a silent raw draft write is answered before body release"
    );
    assert_raw_stall(&events, response, "untitled/draft.md").await;
    assert_eq!(
        count, baseline,
        "the consumer releases its draft pin before answering"
    );
    assert!(dropped);
    assert_eq!(bytes.unwrap(), b"original\n");
    assert_eq!(after, before, "no partial draft temporary file remains");
}

#[tokio::test]
async fn a_silent_raw_standalone_write_drops_its_body() {
    let mut fixture = super::standalone_fs::test_fixture::files_fixture();
    let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();
    Arc::get_mut(&mut fixture.state).unwrap().bulk_transfer = bulk.with_stall_timeout(STALL_BOUND);
    let directory = fixture.root.join("home/user");
    std::fs::write(directory.join("held.txt"), b"original\n").unwrap();
    let before = entries(&directory);
    let held = HeldRawWrite::start(
        crate::terminal_router(fixture.state.clone()),
        "/api/fs/home/user/held.txt",
        RAW_CHUNK,
    )
    .await;
    let answered = held.answer.is_some();
    let dropped = held.body_dropped();
    let bytes = std::fs::read(directory.join("held.txt"));
    let after = entries(&directory);
    let (events, response) = held.finish().await;
    eprintln!("standalone raw write: answered={answered} dropped={dropped}");
    assert!(
        answered,
        "a silent raw standalone write is answered before body release"
    );
    assert_raw_stall(&events, response, "home/user/held.txt").await;
    assert!(dropped);
    assert_eq!(bytes.unwrap(), b"original\n");
    assert_eq!(after, before);
}

async fn silent_live_write(scene: bool) {
    let (_cfg, root, mut state) = served_state();
    let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();
    Arc::get_mut(&mut state).unwrap().bulk_transfer = bulk.with_stall_timeout(STALL_BOUND);
    let workspace = state.try_workspace().unwrap();
    let (path, original) = if scene {
        (
            "held.excalidraw",
            r#"{"type":"excalidraw","version":2,"source":"test","elements":[],"appState":{},"files":{}}"#,
        )
    } else {
        ("held.md", "original\n")
    };
    workspace.write_text(path, original).unwrap();
    let doc = if scene {
        None
    } else {
        Some(
            state
                .doc_sessions
                .attach(&workspace, path, "raw-writer", None)
                .await
                .unwrap(),
        )
    };
    let drawing = if scene {
        Some(
            state
                .scene_sessions
                .attach(&workspace, path, "raw-writer")
                .await
                .unwrap(),
        )
    } else {
        None
    };
    let before = entries(root.path());
    let version = if let Some(handle) = &doc {
        handle.session().http_write_view().authority_version
    } else {
        drawing
            .as_ref()
            .unwrap()
            .session()
            .http_write_view()
            .authority_version
    };
    let uri = format!("/api/fs/{path}?authority_version={version}");
    let held = HeldRawWrite::start(crate::router(state.clone()), &uri, RAW_CHUNK).await;
    let answered = held.answer.is_some();
    let dropped = held.body_dropped();
    let bytes = std::fs::read(root.path().join(path));
    let after = entries(root.path());
    let authority = if let Some(handle) = &doc {
        handle.session().http_write_view().authority_version
    } else {
        drawing
            .as_ref()
            .unwrap()
            .session()
            .http_write_view()
            .authority_version
    };
    let (events, response) = held.finish().await;
    eprintln!("live raw write: scene={scene} answered={answered} dropped={dropped}");
    assert!(
        answered,
        "a silent raw live-authority write is answered before body release"
    );
    assert_raw_stall(&events, response, path).await;
    assert!(dropped);
    assert_eq!(bytes.unwrap(), original.as_bytes());
    assert_eq!(after, before);
    assert_eq!(
        authority, version,
        "a partial body never reaches the live authority"
    );
}

#[tokio::test]
async fn a_silent_raw_doc_write_preserves_authority() {
    silent_live_write(false).await;
}

#[tokio::test]
async fn a_silent_raw_scene_write_preserves_authority() {
    silent_live_write(true).await;
}

#[tokio::test]
async fn raw_write_complete_and_aborted_controls() {
    let (_cfg, root, state) = served_state();
    let workspace = state.try_workspace().unwrap();
    workspace.create_draft_dir("untitled").unwrap();
    let id = workspace.draft_id("untitled").unwrap();
    workspace
        .draft_files()
        .unwrap()
        .create_text_new("untitled/draft.md", &id, "original")
        .unwrap();
    let fixture = super::standalone_fs::test_fixture::files_fixture();
    let cases = [
        (
            crate::router(state.clone()),
            "/api/fs/whole.txt".to_string(),
            root.path().join("whole.txt"),
        ),
        (
            crate::router(state),
            format!("/api/fs/untitled/draft.md?root=draft&draft_id={id}"),
            workspace.paths().drafts.join("untitled/draft.md"),
        ),
        (
            crate::terminal_router(fixture.state.clone()),
            "/api/fs/home/user/whole.txt".to_string(),
            fixture.root.join("home/user/whole.txt"),
        ),
    ];
    for (app, uri, path) in cases {
        let request = Request::put(&uri).body(Body::from("whole text\n")).unwrap();
        let (events, response) = send_router_captured(app.clone(), request).await;
        assert_eq!(response.status(), StatusCode::OK, "{uri}: {events:?}");
        assert!(with_message(&events, STALLED).is_empty());
        assert!(errors(&events).is_empty());
        assert_eq!(std::fs::read(&path).unwrap(), b"whole text\n");
        let request = Request::put(&uri)
            .body(broken_body(b"partial".to_vec(), 1))
            .unwrap();
        let (events, response) = send_router_captured(app, request).await;
        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "{uri}: {events:?}"
        );
        assert_eq!(json_body(response).await["code"], "upload_incomplete");
        assert!(errors(&events).is_empty());
        let incomplete = with_message(&events, INCOMPLETE);
        assert_eq!(incomplete.len(), 1, "{events:?}");
        assert_eq!(incomplete[0].level, tracing::Level::INFO);
        assert!(with_message(&events, STALLED).is_empty());
        assert_eq!(std::fs::read(&path).unwrap(), b"whole text\n");
    }
}

#[tokio::test]
async fn raw_consumer_error_answers_without_waiting_for_the_feed() {
    let (_cfg, root, state) = served_state();
    let held = HeldRawWrite::start(crate::router(state), "/api/fs/invalid.txt", b"\xff").await;
    let answered = held.answer.is_some();
    let dropped = held.body_dropped();
    let (events, response) = held.finish().await;
    assert!(
        answered,
        "a consumer error is answered before the pending feed ends"
    );
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(json_body(response).await["error"]
        .as_str()
        .unwrap()
        .contains("UTF-8"));
    assert!(with_message(&events, STALLED).is_empty());
    assert!(dropped);
    assert!(!root.path().join("invalid.txt").exists());
}

#[tokio::test]
async fn raw_precondition_refusal_does_not_wait_for_body_completion() {
    let (_cfg, root, state) = served_state();
    state
        .try_workspace()
        .unwrap()
        .write_text("held.txt", "original\n")
        .unwrap();
    let (mut held, _pending) = HeldRawWrite::spawn(
        crate::router(state),
        "/api/fs/held.txt?expected_mtime_ns=-1",
        RAW_CHUNK,
    );
    held.observe_answer().await;
    let answered = held.answer.is_some();
    let dropped = held.body_dropped();
    let (events, response) = held.finish().await;
    assert!(
        answered,
        "a precondition refusal is answered before the pending body completes"
    );
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(json_body(response).await["code"], "write_conflict");
    assert!(dropped);
    assert!(with_message(&events, INCOMPLETE).is_empty());
    assert!(with_message(&events, STALLED).is_empty());
    assert!(errors(&events).is_empty());
    assert_eq!(
        std::fs::read(root.path().join("held.txt")).unwrap(),
        b"original\n"
    );
}
