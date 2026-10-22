use super::*;

const QUEUE_WINDOW: &str = "w-queue";

fn tracked_upload(body: Body, transfer: &str) -> Request<Body> {
    let mut request = upload(body);
    let headers = request.headers_mut();
    headers.insert("x-chan-window-id", QUEUE_WINDOW.parse().unwrap());
    headers.insert("x-chan-transfer-id", transfer.parse().unwrap());
    request
}

/// A body that yields `head` and one 4 KiB chunk of file data, then holds its
/// file part open until `release`, then ends it, as an upload whose client
/// keeps sending slowly does. The stream is pending once before each item
/// after the head, as a socket is between reads.
fn held_body(head: Vec<u8>, release: tokio::sync::oneshot::Receiver<()>) -> Body {
    let head = Bytes::from(head);
    Body::from_stream(futures::stream::unfold(
        (0usize, Some(release)),
        move |(stage, release)| {
            let head = head.clone();
            async move {
                if stage > 0 {
                    tokio::task::yield_now().await;
                }
                match stage {
                    0 => Some((Ok::<Bytes, std::io::Error>(head), (1, release))),
                    1 => Some((Ok(Bytes::from(vec![7; 4096])), (2, release))),
                    2 => {
                        let _ = release?.await;
                        let tail = Bytes::from(format!("\r\n--{BOUNDARY}--\r\n"));
                        Some((Ok(tail), (3, None)))
                    }
                    _ => None,
                }
            }
        },
    ))
}

/// A body that yields `head` and two 4 KiB chunks of file data, far fewer
/// messages than the feed's channel holds, then waits for `arm` and fails as
/// a client that closes mid-body does, telling `yielded` as the failure is
/// handed to the reader.
fn armed_broken_body(
    head: Vec<u8>,
    arm: tokio::sync::oneshot::Receiver<()>,
    yielded: tokio::sync::oneshot::Sender<()>,
) -> Body {
    let head = Bytes::from(head);
    Body::from_stream(futures::stream::unfold(
        (0usize, Some((arm, yielded))),
        move |(stage, signals)| {
            let head = head.clone();
            async move {
                if stage > 0 {
                    tokio::task::yield_now().await;
                }
                match stage {
                    0 => Some((Ok::<Bytes, std::io::Error>(head), (1, signals))),
                    1 | 2 => Some((Ok(Bytes::from(vec![7; 4096])), (stage + 1, signals))),
                    3 => {
                        let (arm, yielded) = signals?;
                        let _ = arm.await;
                        let _ = yielded.send(());
                        let reset = std::io::Error::new(
                            std::io::ErrorKind::ConnectionReset,
                            "client went away",
                        );
                        Some((Err(reset), (4, None)))
                    }
                    _ => None,
                }
            }
        },
    ))
}

/// The next queue frame for `transfer`, as `(state, position)`, skipping
/// every other event; `awaited` names the frame in the hang guard's panic.
async fn next_queue_frame(
    frames: &mut tokio::sync::broadcast::Receiver<String>,
    transfer: &str,
    awaited: &str,
) -> (String, Option<u64>) {
    loop {
        let frame = tokio::time::timeout(HANG_GUARD, frames.recv())
            .await
            .unwrap_or_else(|_| panic!("{awaited}: no queue frame for {transfer}"))
            .expect("the event channel holds every frame");
        let frame: Value = serde_json::from_str(&frame).unwrap();
        if frame["type"] == "transfer_queue" && frame["transfer_id"] == transfer {
            return (
                frame["state"].as_str().unwrap().to_owned(),
                frame["position"].as_u64(),
            );
        }
    }
}

/// Yield to the request tasks until the lane holds `counts` as
/// `(running, waiting)`.
async fn lane_reaches(bulk: &crate::bulk_transfer::BulkTransferTenant, counts: (usize, usize)) {
    tokio::time::timeout(HANG_GUARD, async {
        while crate::bulk_transfer::test_support::lane_counts(bulk) != counts {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("fixture: the lane reaches {counts:?}"));
}

/// Four uploads through the tenant router
/// on a lane of its own. Two uploads hold both slots, a third waits and its
/// client closes while its feed still reads, a fourth waits behind it. The
/// runtime is current-thread, so once the third body's failure has been
/// handed to its reader, that handler's continuation has run before this
/// test resumes: the order of the answers and the announced ranks is owned
/// by the test, and no assertion reads a latency.
async fn queued_upload_case(explicit: bool, kind: &str) {
    let (_cfg, root, mut workspace) = served_state();
    let mut fixture = crate::routes::standalone_fs::test_fixture::files_fixture();
    let state = if kind == "workspace" {
        &mut workspace
    } else {
        &mut fixture.state
    };
    let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();
    let view = bulk.clone();
    let (events_tx, mut frames) = tokio::sync::broadcast::channel(256);
    {
        let state = Arc::get_mut(state).unwrap();
        state.bulk_transfer = bulk;
        state.events_tx = events_tx;
    }
    let app = if kind == "workspace" {
        crate::router(state.clone())
    } else {
        crate::terminal_router(state.clone())
    };
    let target_dir = if kind == "workspace" {
        root.path().to_path_buf()
    } else {
        fixture.root.join("home/user")
    };
    let directory = match kind {
        "workspace" => String::new(),
        "files" => "home/user".into(),
        _ => target_dir.display().to_string(),
    };
    let upload_head = |name: &str| {
        format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"dir\"\r\n\r\n{directory}\r\n--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n\r\n").into_bytes()
    };
    let entries = || -> std::collections::BTreeSet<String> {
        std::fs::read_dir(&target_dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect()
    };
    let before = entries();
    let (answers_tx, mut answers) = tokio::sync::mpsc::unbounded_channel();
    let send = |name: &'static str, mut request: Request<Body>| {
        let app = app.clone();
        if kind == "files" {
            *request.uri_mut() = "/api/fs/upload?app=files".parse().unwrap();
        }
        let answers = answers_tx.clone();
        tokio::spawn(async move {
            let (events, response) = send_router_captured(app, request).await;
            let _ = answers.send((name, events, response));
        });
    };

    let (release_a, held_a) = tokio::sync::oneshot::channel();
    let (release_b, held_b) = tokio::sync::oneshot::channel();
    send("a", upload(held_body(upload_head("a.bin"), held_a)));
    send("b", upload(held_body(upload_head("b.bin"), held_b)));
    lane_reaches(&view, (2, 0)).await;

    let (arm_c, armed_c) = tokio::sync::oneshot::channel();
    let (yielded_c, failed_c) = tokio::sync::oneshot::channel();
    let c_frames = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let body = if explicit {
        use futures::StreamExt;
        let seen = c_frames.clone();
        let head = upload_head("c.bin");
        Body::from_stream(
            futures::stream::unfold(0usize, move |n| {
                let head = head.clone();
                async move {
                    tokio::task::yield_now().await;
                    let bytes = if n == 0 {
                        Bytes::from(head)
                    } else {
                        Bytes::from(vec![7; 4096])
                    };
                    Some((Ok::<_, std::io::Error>(bytes), n + 1))
                }
            })
            .map(move |frame| {
                seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                frame
            }),
        )
    } else {
        armed_broken_body(upload_head("c.bin"), armed_c, yielded_c)
    };
    send("c", tracked_upload(body, "t-c"));
    assert_eq!(
        next_queue_frame(&mut frames, "t-c", "fixture: the third upload waits").await,
        ("waiting".to_owned(), Some(1))
    );
    let (release_d, held_d) = tokio::sync::oneshot::channel();
    send(
        "d",
        tracked_upload(held_body(upload_head("d.bin"), held_d), "t-d"),
    );
    assert_eq!(
        next_queue_frame(&mut frames, "t-d", "fixture: the fourth upload waits").await,
        ("waiting".to_owned(), Some(2))
    );
    lane_reaches(&view, (2, 2)).await;

    let answered_at_failure = if explicit {
        tokio::time::timeout(HANG_GUARD, async {
            while c_frames.load(std::sync::atomic::Ordering::SeqCst) < 10 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("queued feed fills its eight-message channel");
        let request = Request::post("/api/transfers/cancel")
            .header("x-chan-window-id", QUEUE_WINDOW)
            .header("x-chan-transfer-id", "t-c")
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(json_body(response).await["status"], "cancel_requested");
        Some(
            tokio::time::timeout(HANG_GUARD, answers.recv())
                .await
                .unwrap()
                .unwrap(),
        )
    } else {
        arm_c.send(()).unwrap();
        failed_c
            .await
            .expect("fixture: the body hands its failure to the reader");
        answers.try_recv().ok()
    };

    let moved_up = "the fourth upload moves up once the third leaves the queue";
    assert_eq!(
        next_queue_frame(&mut frames, "t-d", moved_up).await,
        ("waiting".to_owned(), Some(1)),
        "{moved_up}"
    );
    let (name, events, response) =
        answered_at_failure.expect("the third upload is answered before any slot frees");
    assert_eq!(name, "c");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = json_body(response).await;
    assert_eq!(body["code"], "upload_incomplete", "{body}");
    assert!(errors(&events).is_empty(), "{events:?}");
    let incomplete = with_message(&events, INCOMPLETE);
    assert_eq!(incomplete.len(), 1, "one incomplete-body line: {events:?}");
    assert_eq!(incomplete[0].level, tracing::Level::INFO);
    assert_eq!(
        crate::bulk_transfer::test_support::lane_counts(&view),
        (2, 1),
        "the withdrawn upload releases nothing it did not hold"
    );

    release_a.send(()).unwrap();
    let (name, _, response) = tokio::time::timeout(HANG_GUARD, answers.recv())
        .await
        .expect("the first held upload completes")
        .unwrap();
    assert_eq!(
        name, "a",
        "the third upload answers before the first held one"
    );
    assert_eq!(response.status(), StatusCode::OK);
    let promoted = "the fourth upload takes the slot that frees";
    assert_eq!(
        next_queue_frame(&mut frames, "t-d", promoted).await,
        ("active".to_owned(), None),
        "{promoted}"
    );
    assert_eq!(
        crate::bulk_transfer::test_support::lane_counts(&view),
        (2, 0)
    );

    release_b.send(()).unwrap();
    release_d.send(()).unwrap();
    let mut rest = Vec::new();
    for _ in 0..2 {
        let (name, _, response) = tokio::time::timeout(HANG_GUARD, answers.recv())
            .await
            .expect("the remaining uploads complete")
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{name}");
        rest.push(name);
    }
    rest.sort_unstable();
    assert_eq!(rest, ["b", "d"]);
    assert_eq!(
        crate::bulk_transfer::test_support::lane_counts(&view),
        (0, 0)
    );
    assert_eq!(
        std::fs::read(target_dir.join("d.bin")).unwrap(),
        vec![7; 4096]
    );
    let added: Vec<_> = entries().difference(&before).cloned().collect();
    assert_eq!(
        added,
        ["a.bin", "b.bin", "d.bin"],
        "the withdrawn upload left no file and no temp entry"
    );
}

/// A body failing under a job a worker has taken leaves the job to end on
/// its own: the handler, polled here by the test itself, stays pending while
/// the test holds the writer, and answers the writer's own end.
#[tokio::test]
async fn a_body_failing_under_a_running_job_waits_for_the_jobs_end() {
    use axum::extract::FromRequest;

    let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();
    let (arm, armed) = tokio::sync::oneshot::channel();
    let (yielded, mut failed) = tokio::sync::oneshot::channel();
    let head = format!(
        "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"held.bin\"\r\n\
         Content-Type: application/octet-stream\r\n\r\n"
    )
    .into_bytes();
    let request = upload(armed_broken_body(head, armed, yielded));
    let mut multipart = axum::extract::Multipart::from_request(request, &())
        .await
        .unwrap();
    let field = multipart.next_field().await.unwrap().unwrap();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let handler = crate::routes::files::stream_upload_tracked(
        &bulk,
        None,
        None,
        field,
        "held.bin".to_owned(),
        move |cancel, mut rx| {
            let _ = started_tx.send(());
            let _ = release_rx.recv();
            crate::routes::files::consume_transfer_body(&mut rx, cancel, "held.bin", |_| Ok(()))
        },
        crate::error::err_from,
    );
    tokio::pin!(handler);

    tokio::time::timeout(HANG_GUARD, async {
        loop {
            assert!(
                futures::poll!(handler.as_mut()).is_pending(),
                "answered before the writer started"
            );
            if started_rx.try_recv().is_ok() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("fixture: a worker takes the job");

    arm.send(()).unwrap();
    tokio::time::timeout(HANG_GUARD, async {
        loop {
            let polled = futures::poll!(handler.as_mut());
            if failed.try_recv().is_ok() {
                assert!(
                    polled.is_pending(),
                    "a running job's handler waits for the job's own end"
                );
                break;
            }
            assert!(polled.is_pending(), "answered before the body failed");
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("fixture: the body hands its failure to the reader");

    release_tx.send(()).unwrap();
    let response = tokio::time::timeout(HANG_GUARD, handler)
        .await
        .expect("the job's end answers the upload");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = json_body(response).await;
    assert_eq!(body["code"], "upload_incomplete", "{body}");
}

#[tokio::test]
async fn a_queued_upload_whose_client_closes_leaves_the_queue_at_once() {
    queued_upload_case(false, "workspace").await;
}

#[tokio::test]
async fn a_queued_upload_cancelled_by_its_carrier_leaves_the_queue_at_once() {
    for kind in ["workspace", "terminal", "files"] {
        queued_upload_case(true, kind).await;
    }
}

fn identify(mut request: Request<Body>, window: &str, transfer: &str) -> Request<Body> {
    request
        .headers_mut()
        .insert("x-chan-window-id", window.parse().unwrap());
    request
        .headers_mut()
        .insert("x-chan-transfer-id", transfer.parse().unwrap());
    request
}

async fn cancel_request(app: axum::Router, transfer: &str) -> Value {
    let request = identify(
        Request::post("/api/transfers/cancel")
            .body(Body::empty())
            .unwrap(),
        QUEUE_WINDOW,
        transfer,
    );
    let (events, response) = send_router_captured(app, request).await;
    assert!(
        errors(&events).is_empty(),
        "carrier acknowledgments log no error"
    );
    assert_eq!(response.status(), StatusCode::OK);
    json_body(response).await
}

#[tokio::test]
async fn all_upload_lanes_cancel_active_writers_and_reuse_pairs_after_each_response() {
    for (kind, replace) in [
        ("workspace", false),
        ("terminal", false),
        ("files", false),
        ("workspace", true),
        ("files", true),
    ] {
        let (_cfg, root, mut workspace) = served_state();
        let mut fixture = crate::routes::standalone_fs::test_fixture::files_fixture();
        let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();
        let state = if kind == "workspace" {
            &mut workspace
        } else {
            &mut fixture.state
        };
        Arc::get_mut(state).unwrap().bulk_transfer = bulk.clone();
        let state = state.clone();
        let app = if kind == "workspace" {
            crate::router(state)
        } else {
            crate::terminal_router(state)
        };
        let directory = match kind {
            "workspace" => String::new(),
            "files" => "home/user".into(),
            _ => fixture.root.join("home/user").display().to_string(),
        };
        let target_dir = if kind == "workspace" {
            root.path().to_path_buf()
        } else {
            fixture.root.join("home/user")
        };
        if replace {
            std::fs::write(target_dir.join("cancelled.bin"), b"keep this target").unwrap();
        }
        let before: std::collections::BTreeSet<_> = std::fs::read_dir(&target_dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        let uri = if kind == "files" {
            "/api/fs/upload?app=files"
        } else {
            "/api/fs/upload"
        };
        let (part, destination) = if replace {
            (
                "path",
                if directory.is_empty() {
                    "cancelled.bin".into()
                } else {
                    format!("{directory}/cancelled.bin")
                },
            )
        } else {
            ("dir", directory.clone())
        };
        let head = format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"{part}\"\r\n\r\n{destination}\r\n--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"cancelled.bin\"\r\n\r\n").into_bytes();
        let (release, held) = tokio::sync::oneshot::channel();
        let mut request = tracked_upload(held_body(head, held), "active");
        *request.uri_mut() = uri.parse().unwrap();
        let task = tokio::spawn(send_router_captured(app.clone(), request));
        lane_reaches(&bulk, (1, 0)).await;
        assert_eq!(
            cancel_request(app.clone(), "active").await["status"],
            "cancel_requested",
            "{kind}"
        );
        let (events, response) = tokio::time::timeout(HANG_GUARD, task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{kind}");
        assert_eq!(
            json_body(response).await["code"],
            "upload_incomplete",
            "{kind}"
        );
        assert!(errors(&events).is_empty(), "{kind}: {events:?}");
        let incomplete = with_message(&events, INCOMPLETE);
        assert_eq!(incomplete.len(), 1, "{kind}: {events:?}");
        assert_eq!(incomplete[0].level, tracing::Level::INFO);
        assert_eq!(
            crate::bulk_transfer::test_support::lane_counts(&bulk),
            (0, 0)
        );
        let after: std::collections::BTreeSet<_> = std::fs::read_dir(&target_dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(
            after, before,
            "{kind}: cancelled writer leaves no target or temp"
        );
        if replace {
            assert_eq!(
                std::fs::read(target_dir.join("cancelled.bin")).unwrap(),
                b"keep this target",
                "{kind}: active cancellation preserves the replacement target"
            );
        }
        drop(release);
        assert_eq!(
            cancel_request(app.clone(), "active").await["status"],
            "not_found",
            "{kind}: handler return removes its entry"
        );
        for name in ["first.bin", "second.bin"] {
            let mut request = identify(
                complete_upload(&directory, name, b"complete"),
                QUEUE_WINDOW,
                "two-files",
            );
            *request.uri_mut() = uri.parse().unwrap();
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(
                response.status(),
                StatusCode::OK,
                "{kind}: {name} reuses the pair after the previous response"
            );
            assert_eq!(std::fs::read(target_dir.join(name)).unwrap(), b"complete");
            assert_eq!(
                cancel_request(app.clone(), "two-files").await["status"],
                "not_found"
            );
        }
    }
}

#[tokio::test]
async fn registration_lives_past_body_completion_and_ends_on_handler_drop() {
    let (_cfg, root, mut state) = served_state();
    let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();
    Arc::get_mut(&mut state).unwrap().bulk_transfer = bulk.clone();
    let app = crate::router(state);
    let mut releases = Vec::new();
    let mut jobs = Vec::new();
    for _ in 0..2 {
        let (ready, started) = tokio::sync::oneshot::channel();
        let (release, park) = std::sync::mpsc::channel::<()>();
        let job = bulk
            .submit(move |_| {
                let _ = ready.send(());
                let _ = park.recv_timeout(HANG_GUARD);
            })
            .unwrap();
        releases.push(release);
        jobs.push(job);
        tokio::time::timeout(HANG_GUARD, started)
            .await
            .unwrap()
            .unwrap();
    }
    let request = identify(
        complete_upload("", "held.bin", b"complete"),
        QUEUE_WINDOW,
        "complete-body",
    );
    let mut handler = Box::pin(app.clone().oneshot(request));
    assert!(futures::poll!(handler.as_mut()).is_pending());
    assert_eq!(
        crate::bulk_transfer::test_support::lane_counts(&bulk),
        (2, 1)
    );
    assert_eq!(
        cancel_request(app.clone(), "complete-body").await["status"],
        "cancel_requested",
        "reading the complete body does not remove a live handler's entry"
    );
    let response = tokio::time::timeout(HANG_GUARD, handler)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(json_body(response).await["code"], "upload_incomplete");
    assert!(!root.path().join("held.bin").exists());
    assert_eq!(
        cancel_request(app.clone(), "complete-body").await["status"],
        "not_found"
    );

    for kind in ["workspace", "terminal", "files"] {
        let (_cfg, _root, workspace) = served_state();
        let fixture = crate::routes::standalone_fs::test_fixture::files_fixture();
        let app = if kind == "workspace" {
            crate::router(workspace)
        } else {
            crate::terminal_router(fixture.state.clone())
        };
        let directory = match kind {
            "workspace" => String::new(),
            "files" => "home/user".into(),
            _ => fixture.root.join("home/user").display().to_string(),
        };
        let (release_body, held) = tokio::sync::oneshot::channel();
        let head = format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"dir\"\r\n\r\n{directory}"
        );
        let mut request = tracked_upload(held_body(head.into_bytes(), held), "prologue");
        if kind == "files" {
            *request.uri_mut() = "/api/fs/upload?app=files".parse().unwrap();
        }
        let mut handler = Box::pin(app.clone().oneshot(request));
        assert!(
            futures::poll!(handler.as_mut()).is_pending(),
            "{kind}: destination parsing waits for the held body"
        );
        assert_eq!(
            cancel_request(app.clone(), "prologue").await["status"],
            "cancel_requested",
            "{kind}: registration precedes destination parsing"
        );
        drop(handler);
        drop(release_body);
        assert_eq!(
            cancel_request(app, "prologue").await["status"],
            "not_found",
            "{kind}: dropping a handler removes its pre-admission entry"
        );
    }
    let malformed = identify(
        upload(Body::from("not a multipart body")),
        QUEUE_WINDOW,
        "malformed",
    );
    let response = app.clone().oneshot(malformed).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        cancel_request(app, "malformed").await["status"],
        "not_found",
        "a planning error removes its entry"
    );
    drop(releases);
    for job in jobs {
        assert_eq!(
            job.outcome().await,
            crate::bulk_transfer::BulkOutcome::Done(())
        );
    }
}

#[tokio::test]
async fn cancellation_releases_a_full_feed_before_the_active_writer_finishes() {
    use axum::extract::FromRequest;
    use futures::StreamExt;
    use std::sync::atomic::{AtomicUsize, Ordering};
    let (_cfg, _root, state) = served_state();
    let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();
    let observed = Arc::new(AtomicUsize::new(0));
    let frames = observed.clone();
    let stream = futures::stream::unfold(0usize, move |n| async move {
        tokio::task::yield_now().await;
        let bytes = if n == 0 {
            Bytes::from(format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"held.bin\"\r\n\r\n{}", "x".repeat(4096)))
        } else { Bytes::from(vec![b'x'; 4096]) };
        Some((Ok::<_, std::io::Error>(bytes), n + 1))
    }).map(move |item| { frames.fetch_add(1, Ordering::SeqCst); item });
    let request = tracked_upload(Body::from_stream(stream), "full-feed");
    let (tracking, _guard) =
        crate::routes::transfer::TransferTracking::upload(request.headers(), &state).unwrap();
    let mut multipart = axum::extract::Multipart::from_request(request, &())
        .await
        .unwrap();
    let field = multipart.next_field().await.unwrap().unwrap();
    let (command, commands) = std::sync::mpsc::channel::<()>();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (closed, inspected) = tokio::sync::oneshot::channel();
    let (release, park) = std::sync::mpsc::channel::<()>();
    let response = crate::routes::files::stream_upload_tracked(
        &bulk,
        None,
        tracking,
        field,
        "held.bin".into(),
        move |_cancel, rx| {
            let _ = started.send(());
            commands.recv_timeout(HANG_GUARD).unwrap();
            let _ = closed.send(rx.is_closed());
            let _ = park.recv_timeout(HANG_GUARD);
            Ok(())
        },
        crate::error::err_from,
    );
    tokio::pin!(response);
    tokio::time::timeout(HANG_GUARD, async {
        while observed.load(Ordering::SeqCst) < 9 {
            assert!(futures::poll!(response.as_mut()).is_pending());
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(futures::poll!(response.as_mut()).is_pending());
    tokio::time::timeout(HANG_GUARD, ready)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        cancel_request(crate::router(state), "full-feed").await["status"],
        "cancel_requested"
    );
    assert!(
        futures::poll!(response.as_mut()).is_pending(),
        "active cleanup still owns the response"
    );
    command.send(()).unwrap();
    assert!(
        tokio::time::timeout(HANG_GUARD, inspected)
            .await
            .unwrap()
            .unwrap(),
        "cancel releases the blocked feed before writer cleanup ends"
    );
    drop(release);
    let response = tokio::time::timeout(HANG_GUARD, response).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn cancellation_releases_a_reading_feed_before_the_active_writer_finishes() {
    use axum::extract::FromRequest;
    use futures::StreamExt;
    use std::sync::atomic::{AtomicBool, Ordering};

    let (_cfg, _root, state) = served_state();
    let (_lane, bulk) = crate::bulk_transfer::test_support::isolated_tenant();
    let waiting = Arc::new(AtomicBool::new(false));
    let observed = waiting.clone();
    let head = format!(
        "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"held.bin\"\r\n\r\n"
    );
    let stream = futures::stream::once(async move { Ok::<_, std::io::Error>(Bytes::from(head)) })
        .chain(futures::stream::once(async {
            tokio::task::yield_now().await;
            Ok(Bytes::from(vec![7; 4096]))
        }))
        .chain(futures::stream::once(async move {
            tokio::task::yield_now().await;
            waiting.store(true, Ordering::SeqCst);
            std::future::pending::<Result<Bytes, std::io::Error>>().await
        }));
    let request = tracked_upload(Body::from_stream(stream), "reading-feed");
    let (tracking, _guard) =
        crate::routes::transfer::TransferTracking::upload(request.headers(), &state).unwrap();
    let mut multipart = axum::extract::Multipart::from_request(request, &())
        .await
        .unwrap();
    let field = multipart.next_field().await.unwrap().unwrap();
    let (command, commands) = std::sync::mpsc::channel::<()>();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (closed, inspected) = tokio::sync::oneshot::channel();
    let (release, park) = std::sync::mpsc::channel::<()>();
    let response = crate::routes::files::stream_upload_tracked(
        &bulk,
        None,
        tracking,
        field,
        "held.bin".into(),
        move |_cancel, mut rx| {
            assert!(matches!(
                rx.blocking_recv(),
                Some(crate::routes::files::RequestBodyMessage::Chunk(bytes)) if bytes.len() == 4096
            ));
            let _ = started.send(());
            commands.recv_timeout(HANG_GUARD).unwrap();
            let _ = closed.send(rx.is_closed());
            let _ = park.recv_timeout(HANG_GUARD);
            Ok(())
        },
        crate::error::err_from,
    );
    tokio::pin!(response);
    tokio::time::timeout(HANG_GUARD, async {
        while !observed.load(Ordering::SeqCst) {
            assert!(futures::poll!(response.as_mut()).is_pending());
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    tokio::time::timeout(HANG_GUARD, ready)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        cancel_request(crate::router(state), "reading-feed").await["status"],
        "cancel_requested"
    );
    assert!(
        futures::poll!(response.as_mut()).is_pending(),
        "active cleanup still owns the response"
    );
    command.send(()).unwrap();
    assert!(
        tokio::time::timeout(HANG_GUARD, inspected)
            .await
            .unwrap()
            .unwrap(),
        "cancel releases a feed waiting on the client's body before writer cleanup ends"
    );
    drop(release);
    let response = tokio::time::timeout(HANG_GUARD, response).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(json_body(response).await["code"], "upload_incomplete");
}
