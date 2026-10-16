use std::sync::{Arc, Mutex};

use axum::body::{to_bytes, Body, Bytes};
use axum::http::{header, Request, StatusCode};
use axum::response::Response;
use serde_json::Value;
use tower::ServiceExt;
use tracing::instrument::WithSubscriber;

use super::tests::served_state;
use crate::state::AppState;

const BOUNDARY: &str = "incomplete-body";
const INCOMPLETE: &str = "request body ended before completion";
const SERVER_FAILURE: &str = "response failed";

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
    let events = Arc::new(Mutex::new(Vec::new()));
    let dispatch = tracing::Dispatch::new(Capture(Arc::clone(&events)));
    let _registered = tracing::Dispatch::new(tracing::subscriber::NoSubscriber::default());
    tracing::callsite::rebuild_interest_cache();
    let response = async {
        tracing::info!("incomplete-capture-control");
        crate::router(state).oneshot(request).await.unwrap()
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
