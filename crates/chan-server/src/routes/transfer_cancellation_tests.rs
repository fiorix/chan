use super::*;
use axum::http::{HeaderMap, Request};
use tower::ServiceExt;

fn headers(window: &str, id: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("x-chan-window-id", window.parse().unwrap());
    headers.insert("x-chan-transfer-id", id.parse().unwrap());
    headers
}

async fn cancel(app: axum::Router, headers: HeaderMap) -> (StatusCode, serde_json::Value) {
    let mut request = Request::post("/api/transfers/cancel")
        .body(Body::empty())
        .unwrap();
    *request.headers_mut() = headers;
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn the_cancel_carrier_requires_both_keys_on_both_tenant_mounts() {
    let (_cfg, _root, state) = crate::routes::tests::served_state();
    let fixture = crate::routes::standalone_fs::test_fixture::files_fixture();
    for app in [crate::router(state), crate::terminal_router(fixture.state)] {
        for key in ["x-chan-window-id", "x-chan-transfer-id"] {
            let mut missing = headers("w", "t");
            missing.remove(key);
            let (status, body) = cancel(app.clone(), missing).await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert_eq!(body["code"], "transfer_tracking_required");
            for value in [
                axum::http::HeaderValue::from_static(""),
                axum::http::HeaderValue::from_static(" "),
                axum::http::HeaderValue::from_bytes(&[0xff]).unwrap(),
            ] {
                let mut invalid = headers("w", "t");
                invalid.insert(key, value);
                assert_eq!(
                    cancel(app.clone(), invalid).await.0,
                    StatusCode::BAD_REQUEST,
                    "blank and non-text tracking headers are refused"
                );
            }
        }
        let (status, body) = cancel(app, headers("w", "unknown")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "not_found");
    }
}

#[tokio::test]
async fn registry_scopes_live_pairs_and_forgets_them_at_handler_end() {
    let (_cfg, _root, state) = crate::routes::tests::served_state();
    let (_cfg2, _root2, sibling) = crate::routes::tests::served_state();
    let keys = headers("w", "t");
    let (status, body) = cancel(crate::router(state.clone()), keys.clone()).await;
    assert_eq!(
        (status, body["status"].as_str()),
        (StatusCode::OK, Some("not_found")),
        "cancel before registration is a miss"
    );
    let (tracking, guard) = TransferTracking::upload(&keys, &state).unwrap();
    let tracking = tracking.unwrap();
    assert!(
        !*tracking.upload.as_ref().unwrap().cancelled.borrow(),
        "an earlier miss leaves no tombstone"
    );
    assert_eq!(
        cancel(crate::router(state.clone()), headers("other", "t"))
            .await
            .1["status"],
        "not_found",
        "windows do not share cancellation authority"
    );
    assert_eq!(
        cancel(crate::router(sibling), keys.clone()).await.1["status"],
        "not_found",
        "tenants do not share cancellation authority"
    );
    let duplicate = match TransferTracking::upload(&keys, &state) {
        Err(response) => response,
        Ok(_) => panic!("a live pair was replaced"),
    };
    assert_eq!(duplicate.status(), StatusCode::CONFLICT);
    assert_eq!(
        cancel(crate::router(state.clone()), headers(" w ", " t "))
            .await
            .1["status"],
        "cancel_requested",
        "the carrier trims both routing keys"
    );
    assert_eq!(
        cancel(crate::router(state.clone()), keys.clone()).await.1["status"],
        "cancel_requested",
        "cancel is idempotent while the handler is live"
    );
    drop(guard);
    assert_eq!(
        cancel(crate::router(state.clone()), keys.clone()).await.1["status"],
        "not_found",
        "handler end removes its entry"
    );
    let (next, _next_guard) = TransferTracking::upload(&keys, &state).unwrap();
    assert!(!*next
        .as_ref()
        .unwrap()
        .upload
        .as_ref()
        .unwrap()
        .cancelled
        .borrow());
    tracking.upload.unwrap().cancel();
    assert!(
        !*next
            .as_ref()
            .unwrap()
            .upload
            .as_ref()
            .unwrap()
            .cancelled
            .borrow(),
        "an old capability cannot cancel a reused pair"
    );
}

#[tokio::test]
async fn cancellation_before_admission_never_submits_a_writer() {
    let (_cfg, _root, state) = crate::routes::tests::served_state();
    let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();
    let keys = headers("w", "t");
    let (tracking, _guard) = TransferTracking::upload(&keys, &state).unwrap();
    assert_eq!(
        cancel(crate::router(state), keys).await.1["status"],
        "cancel_requested"
    );
    let control = tracking.unwrap().upload.unwrap();
    let response = match control.submit(
        &bulk,
        |_| -> () { panic!("pre-admission cancelled writer ran") },
        err_from,
    ) {
        Err(response) => *response,
        Ok(_) => panic!("pre-admission cancellation consumed a slot"),
    };
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let bytes = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["code"],
        "upload_incomplete"
    );
    assert_eq!(
        crate::bulk_transfer::test_support::lane_counts(&bulk),
        (0, 0)
    );
}

#[tokio::test]
async fn nonupload_registration_lives_until_its_download_body_is_dropped() {
    let (_cfg, _root, state) = crate::routes::tests::served_state();
    let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();
    let keys = headers("w", "download");
    let mut tracking = TransferTracking::noncancellable(&keys, &state)
        .unwrap()
        .unwrap();
    let (tx, rx) = mpsc::channel(8);
    let job = bulk
        .submit(move |cancel| {
            let _ = cancel.send(&tx, Ok(Bytes::from_static(b"bytes")));
        })
        .unwrap();
    let (alive, _) = tokio::sync::oneshot::channel();
    let body = download_body(rx, job, alive, tracking.take_registration());
    drop(tracking);
    assert_eq!(
        cancel(crate::router(state.clone()), keys.clone()).await.1["status"],
        "not_cancellable",
        "a live response retains its noncancellable marker"
    );
    drop(body);
    assert_eq!(
        cancel(crate::router(state), keys).await.1["status"],
        "not_found",
        "dropping the body removes its entry"
    );
}

#[test]
fn terminal_upload_finalization_rejects_late_cancellation() {
    let dir = tempfile::tempdir().unwrap();
    let (tx, rx) = mpsc::channel(2);
    tx.try_send(crate::routes::files::RequestBodyMessage::Chunk(
        Bytes::from_static(b"whole"),
    ))
    .unwrap();
    tx.try_send(crate::routes::files::RequestBodyMessage::Complete)
        .unwrap();
    let (cancel, close) = crate::bulk_transfer::test_support::cancel_switch();
    terminal_upload_stream_sync(dir.path(), "finalized.bin", rx, 8192, &cancel).unwrap();
    close.cancel();
    assert!(
        !cancel.is_cancelled(),
        "terminal publication claims finalization before a late close"
    );
    assert_eq!(
        std::fs::read(dir.path().join("finalized.bin")).unwrap(),
        b"whole"
    );
}

#[tokio::test]
async fn download_and_copy_routes_hold_noncancellable_registrations() {
    use crate::bulk_transfer::{test_support, BulkOutcome};
    use futures::FutureExt;
    use std::time::Duration;
    const GUARD: Duration = Duration::from_secs(10);
    for (kind, copy) in [
        ("workspace", false),
        ("terminal", false),
        ("workspace", true),
        ("files", true),
    ] {
        let (_cfg, root, mut workspace) = crate::routes::tests::served_state();
        let mut fixture = crate::routes::standalone_fs::test_fixture::files_fixture();
        let (_lane, bulk) = test_support::isolated_tenant();
        let state = if kind == "workspace" {
            &mut workspace
        } else {
            &mut fixture.state
        };
        Arc::get_mut(state).unwrap().bulk_transfer = bulk.clone();
        let app = if kind == "workspace" {
            crate::router(state.clone())
        } else {
            crate::terminal_router(state.clone())
        };
        let dir = if kind == "workspace" {
            root.path().to_path_buf()
        } else {
            fixture.root.join("home/user")
        };
        std::fs::write(dir.join("source.bin"), b"source bytes").unwrap();
        std::fs::create_dir(dir.join("dest")).unwrap();
        let mut holds = Vec::new();
        for _ in 0..2 {
            let (ready, started) = tokio::sync::oneshot::channel();
            let (release, wait) = std::sync::mpsc::channel::<()>();
            let job = bulk
                .submit(move |_| {
                    let _ = ready.send(());
                    let _ = wait.recv_timeout(GUARD);
                })
                .unwrap();
            tokio::time::timeout(GUARD, started).await.unwrap().unwrap();
            holds.push((release, job));
        }
        let source = if kind == "workspace" {
            "source.bin".to_string()
        } else if kind == "files" {
            "home/user/source.bin".to_string()
        } else {
            dir.join("source.bin").display().to_string()
        };
        let mut request = if copy {
            let dest = if kind == "workspace" {
                "dest"
            } else {
                "home/user/dest"
            };
            Request::post(if kind == "files" {
                "/api/fs/transfer?app=files"
            } else {
                "/api/fs/transfer"
            })
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::json!({"op":"copy", "sources":[source], "dest_dir":dest}).to_string(),
            ))
            .unwrap()
        } else {
            Request::get(format!(
                "/api/fs/{}?download=1",
                source.trim_start_matches('/')
            ))
            .body(Body::empty())
            .unwrap()
        };
        let keys = headers("w", "nonupload");
        request.headers_mut().extend(keys.clone());
        let mut handler = Box::pin(app.clone().oneshot(request));
        assert!(handler.as_mut().now_or_never().is_none());
        assert_eq!(
            test_support::lane_counts(&bulk),
            (2, 1),
            "{kind}: queued transfer"
        );
        assert_eq!(
            cancel(app.clone(), keys.clone()).await.1["status"],
            "not_cancellable",
            "{kind}: route registers a nonupload"
        );
        assert_eq!(
            test_support::lane_counts(&bulk),
            (2, 1),
            "refusal leaves work queued"
        );
        for (release, job) in holds {
            drop(release);
            assert_eq!(job.outcome().await, BulkOutcome::Done(()));
        }
        let response = tokio::time::timeout(GUARD, handler).await.unwrap().unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{kind}");
        if copy {
            assert_eq!(
                std::fs::read(dir.join("dest/source.bin")).unwrap(),
                b"source bytes"
            );
        } else {
            assert_eq!(
                cancel(app.clone(), keys.clone()).await.1["status"],
                "not_cancellable",
                "download body keeps its registration after headers"
            );
            let bytes = axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap();
            assert_eq!(bytes.as_ref(), b"source bytes");
        }
        assert_eq!(
            cancel(app.clone(), keys.clone()).await.1["status"],
            "not_found",
            "completed route drops registration"
        );
        if !copy {
            let path = if kind == "workspace" {
                "missing.bin".to_string()
            } else {
                dir.join("missing.bin").display().to_string()
            };
            let mut request = Request::get(format!(
                "/api/fs/{}?download=1",
                path.trim_start_matches('/')
            ))
            .body(Body::empty())
            .unwrap();
            request.headers_mut().extend(keys.clone());
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(
                response.status(),
                StatusCode::BAD_REQUEST,
                "{kind}: missing-source planning status"
            );
            let bytes = axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap();
            let error: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            let prefix = if kind == "workspace" {
                "io error: "
            } else {
                "cannot access "
            };
            assert!(
                error["error"].as_str().unwrap().starts_with(prefix),
                "{kind}: {error}"
            );
            assert_eq!(
                cancel(app, keys).await.1["status"],
                "not_found",
                "download planning failure drops registration"
            );
        }
    }
}

#[test]
fn admission_holds_the_control_lock_until_the_lane_returns() {
    use crate::bulk_transfer::{test_support, ACTIVE_CAPACITY, WAITING_CAPACITY};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;
    struct ObserveDrop {
        control: Arc<UploadControl>,
        locked: Arc<AtomicBool>,
    }
    impl Drop for ObserveDrop {
        fn drop(&mut self) {
            self.locked.store(
                matches!(
                    self.control.phase.try_lock(),
                    Err(std::sync::TryLockError::WouldBlock)
                ),
                Ordering::SeqCst,
            );
        }
    }
    let (_lane, bulk) = test_support::isolated_tenant();
    let mut holds = Vec::new();
    for _ in 0..ACTIVE_CAPACITY {
        let (ready, started) = std::sync::mpsc::channel();
        let (release, wait) = std::sync::mpsc::channel::<()>();
        let job = bulk
            .submit(move |_| {
                ready.send(()).unwrap();
                let _ = wait.recv_timeout(Duration::from_secs(10));
            })
            .unwrap();
        started.recv_timeout(Duration::from_secs(10)).unwrap();
        holds.push((release, job));
    }
    let waiting: Vec<_> = (0..WAITING_CAPACITY)
        .map(|_| bulk.submit(|_| ()).unwrap())
        .collect();
    let control = Arc::new(UploadControl::default());
    let locked = Arc::new(AtomicBool::new(false));
    let capture = ObserveDrop {
        control: control.clone(),
        locked: locked.clone(),
    };
    let result = control.submit(
        &bulk,
        move |_| {
            drop(capture);
        },
        err_from,
    );
    assert!(result.is_err(), "the full lane refuses admission");
    assert!(
        locked.load(Ordering::SeqCst),
        "admission retains the control lock while the lane owns the writer"
    );
    drop(waiting);
    drop(holds);
}

#[test]
fn admitted_control_cancels_its_lane_job() {
    use crate::bulk_transfer::{test_support, BulkOutcome};
    use std::time::Duration;
    let (_lane, bulk) = test_support::isolated_tenant();
    let control = UploadControl::default();
    let (ready, started) = std::sync::mpsc::channel();
    let (release, wait) = std::sync::mpsc::channel::<()>();
    let job = control
        .submit(
            &bulk,
            move |_| {
                ready.send(()).unwrap();
                let _ = wait.recv_timeout(Duration::from_secs(10));
            },
            err_from,
        )
        .unwrap();
    started.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(control.cancel(), ClientCancelResult::Requested);
    drop(release);
    assert_eq!(
        job.wait(),
        BulkOutcome::ClientCancelled,
        "the admitted control carries its lane cancellation capability"
    );
}
