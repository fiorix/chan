use std::future::{poll_fn, Future};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::Poll;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{FromRequest, State};
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use futures::Stream;
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc, watch, Notify, Semaphore};

use crate::bulk_transfer::{test_support, BulkState, BulkTransferTenant};
use crate::routes::files::stream_upload_tracked;

const BOUNDARY: &str = "q1-probe";
const GUARD: Duration = Duration::from_secs(15);

struct Probe {
    lane: BulkTransferTenant,
    events: Mutex<Vec<String>>,
    changed: watch::Sender<usize>,
    state: Arc<crate::state::AppState>,
    admit: Semaphore,
    pulse: Notify,
    pulses: AtomicUsize,
    reports: broadcast::Sender<String>,
}

impl Probe {
    fn mark(&self, text: impl Into<String>) {
        let text = text.into();
        let mut events = self.events.lock().unwrap();
        eprintln!("EVENT {} {text}", events.len() + 1);
        events.push(text);
        self.changed.send_replace(events.len());
    }

    fn has(&self, text: &str) -> bool {
        self.events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event == text)
    }

    async fn wait(&self, text: &str) {
        let mut changes = self.changed.subscribe();
        tokio::time::timeout(GUARD, async {
            while !self.has(text) {
                changes.changed().await.unwrap();
            }
        })
        .await
        .unwrap_or_else(|_| panic!("missing event {text}: {:?}", self.events.lock().unwrap()));
    }

    fn before(&self, first: &str, second: &str) {
        let events = self.events.lock().unwrap();
        let a = events.iter().position(|event| event == first).unwrap();
        let b = events.iter().position(|event| event == second).unwrap();
        assert!(a < b, "{first} must precede {second}: {events:?}");
    }
}

struct HandlerDrop(Arc<Probe>, String);
impl Drop for HandlerDrop {
    fn drop(&mut self) {
        self.0.mark(format!("{}:handler_dropped", self.1));
    }
}

fn map_error(error: &chan_workspace::ChanError) -> Response {
    (StatusCode::BAD_REQUEST, error.to_string()).into_response()
}

async fn upload(State(probe): State<Arc<Probe>>, request: Request<Body>) -> Response {
    let id = request.headers()["x-chan-transfer-id"]
        .to_str()
        .unwrap()
        .to_owned();
    let _dropped = HandlerDrop(probe.clone(), id.clone());
    let (tracking, _registration) =
        crate::routes::transfer::TransferTracking::upload(request.headers(), &probe.state).unwrap();
    probe.mark(format!("{id}:handler_entered"));
    if id == "target" {
        probe.admit.acquire().await.unwrap().forget();
        probe.mark("target:parsing_allowed");
    }
    let (parts, body) = request.into_parts();
    let frames = Arc::new(AtomicUsize::new(0));
    let observed_frames = frames.clone();
    let pending_frames = Arc::new(AtomicUsize::new(0));
    let body_pending_frames = pending_frames.clone();
    let body_probe = probe.clone();
    let body_id = id.clone();
    let mut body_stream = Box::pin(body.into_data_stream());
    let mut held = None;
    let mut ended = false;
    let stream = futures::stream::poll_fn(move |cx| {
        if ended {
            return Poll::Ready(None);
        }
        loop {
            match body_stream.as_mut().poll_next(cx) {
                Poll::Ready(Some(frame)) => {
                    if let Ok(bytes) = &frame {
                        let count = observed_frames.fetch_add(1, Ordering::SeqCst) + 1;
                        body_probe.mark(format!(
                            "{body_id}:body_frame:{count}:bytes={}",
                            bytes.len()
                        ));
                    } else {
                        body_probe.mark(format!("{body_id}:body_error"));
                    }
                    if body_id != "target" {
                        return Poll::Ready(Some(frame));
                    }
                    // Multer can stop at the closing boundary, so hold each frame until the raw body is polled past it.
                    if let Some(previous) = held.replace(frame) {
                        return Poll::Ready(Some(previous));
                    }
                }
                Poll::Ready(None) => {
                    ended = true;
                    if body_id == "target" {
                        body_probe.mark("target:body_stream_end");
                    }
                    return Poll::Ready(held.take());
                }
                Poll::Pending => {
                    if body_id == "target" {
                        let count = observed_frames.load(Ordering::SeqCst);
                        if count > body_pending_frames.fetch_max(count, Ordering::SeqCst) {
                            body_probe.mark(format!("target:pending:{count}"));
                        }
                    }
                    return Poll::Pending;
                }
            }
        }
    });
    let request = Request::from_parts(parts, Body::from_stream(stream));
    let mut multipart = axum::extract::Multipart::from_request(request, &())
        .await
        .unwrap();
    let field = multipart.next_field().await.unwrap().unwrap();
    let writer_probe = probe.clone();
    let writer_id = id.clone();
    let response = stream_upload_tracked(
        &probe.lane,
        Some(probe.reports.clone()),
        tracking,
        field,
        id.clone(),
        move |cancel, mut receive| {
            writer_probe.mark(format!("{writer_id}:writer_entered"));
            let mut bytes = 0usize;
            crate::routes::files::consume_transfer_body(
                &mut receive,
                cancel,
                &writer_id,
                |chunk| {
                    bytes += chunk.len();
                    Ok(())
                },
            )?;
            cancel.begin_finalization()?;
            Ok(bytes)
        },
        map_error,
    );
    tokio::pin!(response);
    loop {
        tokio::select! {
            result = poll_fn(|cx| {
                let polled = response.as_mut().poll(cx);
                if polled.is_pending() {
                    let count = frames.load(Ordering::SeqCst);
                    if count > pending_frames.fetch_max(count, Ordering::SeqCst) {
                        probe.mark(format!("{id}:pending:{count}"));
                    }
                }
                polled
            }) => {
                probe.mark(format!("{id}:answered:{}", result.status().as_u16()));
                return result;
            },
            () = probe.pulse.notified(), if id == "target" => {
                let polled = poll_fn(|cx| Poll::Ready(response.as_mut().poll(cx))).await;
                match polled {
                    Poll::Ready(result) => {
                        probe.mark(format!("{id}:answered:{}", result.status().as_u16()));
                        return result;
                    }
                    Poll::Pending => {
                        let n = probe.pulses.fetch_add(1, Ordering::SeqCst) + 1;
                        probe.mark(format!("target:forced_pending:{n}"));
                    }
                }
            }
        }
    }
}

struct ObservedListener {
    listener: TcpListener,
    accepted: mpsc::UnboundedSender<(SocketAddr, TcpStream)>,
}

impl axum::serve::Listener for ObservedListener {
    type Io = TcpStream;
    type Addr = SocketAddr;
    async fn accept(&mut self) -> (TcpStream, SocketAddr) {
        let (socket, peer) = self.listener.accept().await.unwrap();
        let socket = socket.into_std().unwrap();
        let observer = TcpStream::from_std(socket.try_clone().unwrap()).unwrap();
        self.accepted.send((peer, observer)).unwrap();
        (TcpStream::from_std(socket).unwrap(), peer)
    }
    fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.listener.local_addr()
    }
}

struct Server(tokio::task::JoinHandle<()>);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn head() -> String {
    format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"probe.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n")
}
fn tail() -> String {
    format!("\r\n--{BOUNDARY}--\r\n")
}
async fn chunk(socket: &mut TcpStream, body: &[u8]) {
    chunk_data(socket, body).await;
    socket.write_all(b"\r\n").await.unwrap();
}
async fn chunk_data(socket: &mut TcpStream, body: &[u8]) {
    socket
        .write_all(format!("{:x}\r\n", body.len()).as_bytes())
        .await
        .unwrap();
    socket.write_all(body).await.unwrap();
}
async fn connect(addr: SocketAddr, id: &str) -> TcpStream {
    let mut socket = TcpStream::connect(addr).await.unwrap();
    socket.set_nodelay(true).unwrap();
    socket.write_all(format!("POST /upload HTTP/1.1\r\nHost: localhost\r\nContent-Type: multipart/form-data; boundary={BOUNDARY}\r\nTransfer-Encoding: chunked\r\nX-Chan-Window-Id: q1-window\r\nX-Chan-Transfer-Id: {id}\r\n\r\n").as_bytes()).await.unwrap();
    socket
}
async fn complete(socket: &mut TcpStream) {
    chunk(socket, tail().as_bytes()).await;
    socket.write_all(b"0\r\n\r\n").await.unwrap();
}

#[derive(Clone, Copy)]
enum DeliveryOrder {
    EarlyRead,
    LateRead,
}

async fn experiment(buffered: bool, order: DeliveryOrder) {
    let (_lane, tenant) = test_support::isolated_tenant();
    let (_cfg, _root, mut state) = super::served_state();
    Arc::get_mut(&mut state).unwrap().bulk_transfer = tenant.clone();
    let probe = Arc::new(Probe {
        lane: tenant.clone(),
        events: Mutex::new(Vec::new()),
        changed: watch::channel(0).0,
        state: state.clone(),
        admit: Semaphore::new(0),
        pulse: Notify::new(),
        pulses: AtomicUsize::new(0),
        reports: broadcast::channel(64).0,
    });
    let mut reports = probe.reports.subscribe();
    let router = axum::Router::new()
        .route("/upload", axum::routing::post(upload))
        .with_state(probe.clone())
        .merge(
            axum::Router::new()
                .route(
                    "/api/transfers/cancel",
                    axum::routing::post(crate::routes::transfer::api_cancel_transfer),
                )
                .with_state(state),
        );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (accepted, mut observers) = mpsc::unbounded_channel();
    let server = Server(tokio::spawn(async move {
        axum::serve(ObservedListener { listener, accepted }, router)
            .await
            .unwrap();
    }));
    let mut held = Vec::new();
    for id in ["hold1", "hold2"] {
        let mut socket = connect(addr, id).await;
        let (_, observer) = observers.recv().await.unwrap();
        drop(observer);
        chunk(&mut socket, format!("{}held", head()).as_bytes()).await;
        probe.wait(&format!("{id}:writer_entered")).await;
        held.push(socket);
    }
    assert_eq!(test_support::active_jobs(&tenant), 2);
    let mut target = connect(addr, "target").await;
    let (peer, observer) = observers.recv().await.unwrap();
    assert_eq!(peer, target.local_addr().unwrap());
    probe.wait("target:handler_entered").await;
    probe.admit.add_permits(1);
    probe.wait("target:parsing_allowed").await;
    if buffered {
        chunk(
            &mut target,
            format!("{}{}", head(), "x".repeat(4096)).as_bytes(),
        )
        .await;
        probe.wait("target:pending:1").await;
        for count in 2..=8 {
            chunk(&mut target, &vec![b'x'; 4096]).await;
            probe.wait(&format!("target:pending:{count}")).await;
        }
        if matches!(order, DeliveryOrder::EarlyRead) {
            chunk_data(&mut target, &vec![b'x'; 4096]).await;
            probe.wait("target:pending:9").await;
            probe.mark("target:ninth_crlf_withheld");
            probe.before("target:pending:9", "target:ninth_crlf_withheld");
            assert!(!probe.has("target:ninth_crlf_written"));
        } else {
            chunk(&mut target, &vec![b'x'; 4096]).await;
            probe.mark("target:ninth_crlf_written");
            probe.wait("target:pending:9").await;
            probe.before("target:ninth_crlf_written", "target:pending:9");
        }
    } else {
        if matches!(order, DeliveryOrder::EarlyRead) {
            chunk(&mut target, format!("{}whole", head()).as_bytes()).await;
            probe.wait("target:pending:1").await;
            complete(&mut target).await;
            probe.mark("target:terminator_written");
            probe.before("target:pending:1", "target:terminator_written");
        } else {
            chunk(&mut target, format!("{}whole{}", head(), tail()).as_bytes()).await;
            target.write_all(b"0\r\n\r\n").await.unwrap();
            probe.mark("target:terminator_written");
            probe.wait("target:pending:1").await;
            probe.before("target:terminator_written", "target:pending:1");
        }
        probe.wait("target:body_stream_end").await;
        probe.before("target:terminator_written", "target:body_stream_end");
    }
    let sentinel = tenant.submit(|_| ()).unwrap();
    let tracker = sentinel.tracker();
    let mut changes = tracker.changes();
    assert_eq!(tracker.state(), BulkState::Waiting(2));
    probe.mark("sentinel:waiting:2");
    while let Ok(report) = reports.try_recv() {
        probe.mark(format!("queue_frame:{report}"));
    }
    target.shutdown().await.unwrap();
    drop(target);
    probe.mark("target:client_aborted");
    if buffered {
        probe.before("target:pending:9", "target:client_aborted");
    } else {
        probe.before("target:body_stream_end", "target:client_aborted");
    }
    let mut peek = [0u8; 1];
    let eof = tokio::time::timeout(GUARD, observer.peek(&mut peek))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        eof, 0,
        "observer must prove transport EOF, not unread socket bytes"
    );
    probe.mark("target:transport_eof_observed");
    if buffered {
        probe.pulse.notify_one();
        probe.wait("target:forced_pending:1").await;
        assert_eq!(tracker.state(), BulkState::Waiting(2));
        assert_eq!(test_support::active_jobs(&tenant), 2);
        assert!(!probe.has("target:handler_dropped"));
        assert!(!probe.has("target:writer_entered"));
        let answer = reqwest::Client::new()
            .post(format!("http://{addr}/api/transfers/cancel"))
            .header("x-chan-window-id", "q1-window")
            .header("x-chan-transfer-id", "target")
            .send()
            .await
            .unwrap();
        assert_eq!(answer.status(), StatusCode::OK);
        let body: serde_json::Value = answer.json().await.unwrap();
        assert_eq!(body["status"], "cancel_requested");
        probe.wait("target:answered:400").await;
        probe.wait("target:handler_dropped").await;
        let finished: serde_json::Value = reqwest::Client::new()
            .post(format!("http://{addr}/api/transfers/cancel"))
            .header("x-chan-window-id", "q1-window")
            .header("x-chan-transfer-id", "target")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            finished["status"], "not_found",
            "handler drop removes the real connection's registration"
        );
        tokio::time::timeout(GUARD, async {
            while tracker.state() != BulkState::Waiting(1) {
                changes.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        assert_eq!(test_support::active_jobs(&tenant), 2);
        assert!(
            !probe.has("target:writer_entered"),
            "a buffered cancelled upload never runs its writer"
        );
        probe.mark("sentinel:waiting:1_before_release");
        probe.mark("hold1:release_body");
        complete(&mut held[0]).await;
        probe.before("target:answered:400", "hold1:release_body");
        eprintln!(
            "UPSLOT_SOCKET_CANCEL_VERDICT released_before_worker=true active=2 sentinel_rank=1"
        );
    } else {
        probe.wait("target:handler_dropped").await;
        let finished: serde_json::Value = reqwest::Client::new()
            .post(format!("http://{addr}/api/transfers/cancel"))
            .header("x-chan-window-id", "q1-window")
            .header("x-chan-transfer-id", "target")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            finished["status"], "not_found",
            "handler drop removes the real connection's registration"
        );
        tokio::time::timeout(GUARD, async {
            while tracker.state() != BulkState::Waiting(1) {
                changes.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        assert_eq!(test_support::active_jobs(&tenant), 2);
        assert!(!probe.has("target:writer_entered"));
        probe.mark("sentinel:waiting:1_after_announcement");
        eprintln!("UPSLOT_D2_VERDICT retained=false active=2 sentinel_rank=1 release_order=client_abort,target_drop,rank_announcement_before_held_release");
        probe.mark("hold1:release_body");
        complete(&mut held[0]).await;
    }
    complete(&mut held[1]).await;
    probe.wait("hold1:handler_dropped").await;
    probe.wait("hold2:handler_dropped").await;
    drop(sentinel);
    drop(server);
}

#[tokio::test]
async fn a_buffered_disconnected_upload_is_withdrawn_by_its_carrier() {
    tokio::time::timeout(
        Duration::from_secs(45),
        experiment(true, DeliveryOrder::LateRead),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn a_whole_body_disconnect_drops_its_handler_and_registration() {
    tokio::time::timeout(
        Duration::from_secs(45),
        experiment(false, DeliveryOrder::LateRead),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn a_buffered_disconnect_after_early_read_is_withdrawn_by_its_carrier() {
    tokio::time::timeout(
        Duration::from_secs(45),
        experiment(true, DeliveryOrder::EarlyRead),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn a_whole_body_disconnect_after_early_read_drops_its_handler() {
    tokio::time::timeout(
        Duration::from_secs(45),
        experiment(false, DeliveryOrder::EarlyRead),
    )
    .await
    .unwrap();
}
