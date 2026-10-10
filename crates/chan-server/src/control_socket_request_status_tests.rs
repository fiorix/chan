use super::tests::{empty_registry, test_ctx, FakeHost};
use super::*;
use crate::terminal_sessions::{AttachHandle, CloseReason};
use serde_json::{json, Value};
use std::time::Duration;

struct Rig {
    _root: tempfile::TempDir,
    registry: Arc<TerminalRegistry>,
    caller: AttachHandle,
    target: AttachHandle,
    ctx: ControlSocketCtx,
    frames: broadcast::Receiver<String>,
    _window: crate::session_presence::SessionGuard,
}

impl Rig {
    fn new() -> Self {
        let (root, registry) = empty_registry();
        let registry = Arc::new(registry);
        let create = |name: &str| {
            registry
                .create(CreateOptions {
                    size: PtySize {
                        cols: 80,
                        rows: 24,
                        pixel_width: 0,
                        pixel_height: 0,
                    },
                    tab_name: Some(name.into()),
                    tab_group: None,
                    window_id: Some("window".into()),
                    mcp_env: false,
                    cwd: None,
                    command: Some("read -r line".into()),
                    env: Default::default(),
                    profile: None,
                })
                .unwrap()
        };
        let caller = create("caller");
        let target = create("target");
        let mut ctx = test_ctx(Arc::new(RwLock::new(None)), ControlTenant::Workspace);
        let (events, frames) = broadcast::channel(64);
        ctx.events_tx = events;
        ctx.terminal_registry.set(registry.clone()).unwrap();
        let window = ctx.session_registry.join("window", true, None).guard;
        Self {
            _root: root,
            registry,
            caller,
            target,
            ctx,
            frames,
            _window: window,
        }
    }

    async fn start(&self, request: Value) -> (JoinHandle<()>, BufReader<tokio::io::DuplexStream>) {
        let (mut client, server) = tokio::io::duplex(8192);
        let mut bytes = serde_json::to_vec(&request).unwrap();
        bytes.push(b'\n');
        client.write_all(&bytes).await.unwrap();
        let ctx = self.ctx.clone();
        let task = tokio::spawn(async move {
            let (read, write) = tokio::io::split(server);
            serve_connection_parts(read, write, ctx).await;
        });
        (task, BufReader::new(client))
    }

    fn survey(&self, title: &str) -> Value {
        json!({"type":"term_survey", "session_id":self.caller.id(), "tab_name":"target",
            "spec":{"surveyId":"", "title":title, "bodyMarkdown":"Question?", "options":["yes"]},
            "timeout_secs":30, "cancel_on_eof":true})
    }

    fn export(&self) -> Value {
        json!({"type":"export", "session_id":self.caller.id(), "path":"a.md", "format":"pdf", "window_id":"window", "cancel_on_eof":true})
    }

    fn tunnel(&self) -> Value {
        json!({"type":"tunnel", "session_id":self.caller.id(), "window_id":"window", "proto":"tcp", "bind_addr":"127.0.0.1", "desktop_port":0, "devserver_port":3000})
    }

    async fn frame(&mut self, command: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let frame: Value =
                    serde_json::from_str(&self.frames.recv().await.unwrap()).unwrap();
                if frame["command"] == command {
                    return frame;
                }
            }
        })
        .await
        .expect("bounded event")
    }

    async fn response(reader: &mut BufReader<tokio::io::DuplexStream>) -> ControlResponse {
        tokio::time::timeout(Duration::from_secs(40), async {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            serde_json::from_str(&line).expect("response")
        })
        .await
        .expect("bounded response")
    }

    async fn records(&self) -> Vec<Value> {
        let ControlResponse::Ok { message } = handle_request(
            serde_json::from_value(json!({"type":"term_list"})).unwrap(),
            &self.ctx,
        )
        .await
        else {
            panic!("list response")
        };
        let list: Value = serde_json::from_str(&message).unwrap();
        let rows = list["groups"]["default"].as_array().unwrap();
        let row = rows
            .iter()
            .find(|row| row["session_id"] == self.caller.id())
            .unwrap();
        assert!(
            self.target.program_status().borrow().records.is_empty(),
            "target has no requesting mark"
        );
        row["program_status"]["records"].as_array().unwrap().clone()
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.registry.close_all(CloseReason::Shutdown);
    }
}

#[tokio::test(start_paused = true)]
async fn owned_survey_cleans_up_on_every_reply_timeout_eof_and_task_drop() {
    for outcome in ["option", "followup", "dismissed", "timeout", "eof", "drop"] {
        let mut rig = Rig::new();
        let (task, mut client) = rig.start(rig.survey("Choose now")).await;
        let frame = rig.frame("open_survey").await;
        let rows = rig.records().await;
        assert_eq!(rows.len(), 1, "survey is marked: {outcome}");
        assert_eq!(rows[0]["source"], "chan");
        assert_eq!(rows[0]["state"], "blocked");
        assert_eq!(rows[0]["kind"], "question");
        assert_eq!(rows[0]["title"], "Choose now");
        match outcome {
            "option" | "followup" | "dismissed" => {
                let id = frame["survey"]["surveyId"].as_str().unwrap();
                let mut reply = json!({"kind":outcome,"surveyId":id});
                if outcome == "option" {
                    reply["optionIndex"] = json!(0);
                    reply["optionLabel"] = json!("yes");
                }
                let reply = serde_json::from_value(reply).unwrap();
                assert!(rig.ctx.survey_bus.complete_survey(id, reply));
            }
            "timeout" => tokio::time::advance(Duration::from_secs(31)).await,
            "eof" => {
                client.get_mut().shutdown().await.unwrap();
            }
            "drop" => task.abort(),
            _ => unreachable!(),
        }
        if outcome == "drop" {
            assert!(task.await.unwrap_err().is_cancelled());
        } else {
            let _ = Rig::response(&mut client).await;
            task.await.unwrap();
        }
        assert!(rig.records().await.is_empty(), "survey cleanup: {outcome}");
    }
}

#[tokio::test]
async fn owned_surveys_queue_independently_and_restart_ignores_old_cleanup() {
    let mut rig = Rig::new();
    let (first, first_client) = rig.start(rig.survey("first")).await;
    rig.frame("open_survey").await;
    let mut status = rig.caller.program_status();
    status.borrow_and_update();
    let (second, second_client) = rig.start(rig.survey("second")).await;
    status.changed().await.unwrap();
    assert_eq!(
        rig.records().await.len(),
        2,
        "queued survey has its own mark"
    );
    drop(first_client);
    first.await.unwrap();
    rig.frame("open_survey").await;
    let rows = rig.records().await;
    assert_eq!(rows.len(), 1, "ending first leaves second");
    assert_eq!(rows[0]["title"], "second");
    assert!(rig
        .registry
        .restart(
            rig.caller.id(),
            crate::terminal_sessions::RestartOverrides::default()
        )
        .unwrap());
    let replacement = rig.registry.attach(rig.caller.id(), None).unwrap();
    assert!(replacement.program_status().borrow().records.is_empty());
    rig.registry
        .submit_program_status(rig.caller.id(), b"state=done:id=replacement")
        .unwrap();
    drop(second_client);
    second.await.unwrap();
    assert_eq!(
        replacement.program_status().borrow().records.len(),
        1,
        "old request cleanup leaves replacement alone"
    );
}

#[tokio::test(start_paused = true)]
async fn owned_export_marks_rendering_and_cleans_every_exit() {
    for outcome in ["success", "failure", "timeout", "eof", "drop"] {
        let mut rig = Rig::new();
        let (task, mut client) = rig.start(rig.export()).await;
        let frame = rig.frame("export-job").await;
        let rows = rig.records().await;
        assert_eq!(rows.len(), 1, "export is marked: {outcome}");
        assert_eq!(rows[0]["state"], "working");
        match outcome {
            "success" | "failure" => {
                assert!(rig.ctx.window_bus.complete(
                    frame["id"].as_str().unwrap(),
                    if outcome == "success" {
                        json!({"ok":true,"out":"a.pdf"})
                    } else {
                        json!({"ok":false,"error":"render failed"})
                    }
                ));
            }
            "timeout" => tokio::time::advance(Duration::from_secs(91)).await,
            "eof" => client.get_mut().shutdown().await.unwrap(),
            "drop" => task.abort(),
            _ => unreachable!(),
        }
        if outcome == "drop" {
            assert!(task.await.unwrap_err().is_cancelled());
        } else {
            let _ = Rig::response(&mut client).await;
            task.await.unwrap();
        }
        assert!(rig.records().await.is_empty(), "export cleanup: {outcome}");
    }
}

#[tokio::test(start_paused = true)]
async fn owned_tunnel_waits_for_ack_and_distinguishes_client_from_desktop_end() {
    for outcome in [
        "eof-pending",
        "eof-ready",
        "desktop-gone",
        "refused",
        "timeout",
        "drop",
    ] {
        let mut rig = Rig::new();
        let fake = Arc::new(FakeHost::new(0));
        let host: Arc<dyn chan_library::HostControl> = fake.clone();
        rig.ctx.unserve = UnserveScope::Host(Arc::downgrade(&host));
        let (task, mut client) = rig.start(rig.tunnel()).await;
        let frame = rig.frame("tunnel_open").await;
        assert!(
            rig.records().await.is_empty(),
            "no mark before acknowledgement"
        );
        let id = frame["tunnel_id"].as_str().unwrap();
        match outcome {
            "eof-pending" => client.get_mut().shutdown().await.unwrap(),
            "timeout" => {
                tokio::time::advance(Duration::from_secs(
                    chan_revtunnel::wire::READY_TIMEOUT_SECS + 1,
                ))
                .await
            }
            "drop" => task.abort(),
            "refused" => {
                let attach = fake.tunnels.attach_control(id).unwrap();
                assert!(attach.report(chan_revtunnel::server::ReadyReport::Failed {
                    message: "untrusted\x1b\nmessage".into()
                }));
            }
            _ => {
                let attach = fake.tunnels.attach_control(id).unwrap();
                assert!(attach.report(chan_revtunnel::server::ReadyReport::Ready {
                    bound: "127.0.0.1:4567".into()
                }));
                assert!(matches!(
                    Rig::response(&mut client).await,
                    ControlResponse::Ok { .. }
                ));
                let rows = rig.records().await;
                assert_eq!(rows.len(), 1, "ready tunnel is marked");
                assert_eq!(rows[0]["state"], "working");
                assert_eq!(
                    rows[0]["msg"],
                    "desktop 127.0.0.1:4567 -> devserver 127.0.0.1:3000"
                );
                if outcome == "eof-ready" {
                    client.get_mut().shutdown().await.unwrap();
                    task.await.unwrap();
                    assert!(
                        rig.records().await.is_empty(),
                        "client EOF removes ready mark"
                    );
                    drop(attach);
                    continue;
                }
                drop(attach);
            }
        }
        if outcome == "drop" {
            assert!(task.await.unwrap_err().is_cancelled());
        } else {
            task.await.unwrap();
        }
        let rows = rig.records().await;
        if matches!(outcome, "desktop-gone" | "refused" | "timeout") {
            assert_eq!(rows.len(), 1, "tunnel error retained: {outcome}");
            assert_eq!(rows[0]["state"], "error");
            assert_eq!(
                rows[0]["msg"],
                if outcome == "desktop-gone" {
                    "Tunnel closed by the desktop"
                } else {
                    "Tunnel could not be opened"
                }
            );
            rig.caller.set_focused(true);
            assert!(rig.records().await.is_empty(), "seen own error is removed");
        } else {
            assert!(
                rows.is_empty(),
                "caller ending pending request has no error"
            );
        }
    }
}

#[tokio::test]
async fn owned_requests_without_live_identity_run_and_survey_titles_are_clipped() {
    for identity in [Value::Null, json!("missing")] {
        for kind in ["survey", "export", "tunnel"] {
            let mut rig = Rig::new();
            let fake = Arc::new(FakeHost::new(0));
            let host: Arc<dyn chan_library::HostControl> = fake;
            rig.ctx.unserve = UnserveScope::Host(Arc::downgrade(&host));
            let (mut request, command) = match kind {
                "survey" => (rig.survey("outside"), "open_survey"),
                "export" => (rig.export(), "export-job"),
                _ => (rig.tunnel(), "tunnel_open"),
            };
            if identity.is_null() {
                request.as_object_mut().unwrap().remove("session_id");
            } else {
                request["session_id"] = identity.clone();
            }
            let (task, client) = rig.start(request).await;
            rig.frame(command).await;
            assert!(
                rig.records().await.is_empty(),
                "no live identity marks nothing: {kind}"
            );
            drop(client);
            task.await.unwrap();
        }
    }
    let mut rig = Rig::new();
    let (task, client) = rig
        .start(rig.survey(&format!("\n{}", "é".repeat(200))))
        .await;
    rig.frame("open_survey").await;
    let rows = rig.records().await;
    assert_eq!(
        rows[0]["title"],
        format!("\u{fffd}{}", "é".repeat(94)),
        "survey title replaces controls and clips UTF-8"
    );
    drop(client);
    task.await.unwrap();
}

#[tokio::test]
async fn owned_status_cap_does_not_prevent_a_seventeenth_export() {
    let mut rig = Rig::new();
    let mut held = Vec::new();
    for _ in 0..17 {
        held.push(rig.start(rig.export()).await);
        rig.frame("export-job").await;
    }
    assert_eq!(
        rig.records().await.len(),
        16,
        "own set bounded while seventeenth renders"
    );
    for (task, client) in held {
        drop(client);
        task.await.unwrap();
    }
    assert!(rig.records().await.is_empty());
}

#[tokio::test]
async fn owned_status_reserved_session_environment_is_refused_at_control_dispatch() {
    let rig = Rig::new();
    for request in [
        json!({"type":"open_term_new","window_id":"window","env":{"CHAN_SESSION_ID":"forged"}}),
        json!({"type":"term_restart","tab_name":"caller","env":{"CHAN_SESSION_ID":"forged"}}),
    ] {
        let response = handle_request(serde_json::from_value(request).unwrap(), &rig.ctx).await;
        assert!(
            matches!(response, ControlResponse::Error { ref message } if message.contains("CHAN_SESSION_ID")),
            "reserved --env is refused: {response:?}"
        );
    }
}

#[tokio::test]
async fn owned_tunnel_admission_failures_retain_only_a_fixed_error() {
    for hosted in [true, false] {
        let mut rig = Rig::new();
        let fake = Arc::new(FakeHost::new(0));
        let host: Arc<dyn chan_library::HostControl> = fake;
        if hosted {
            rig.ctx.unserve = UnserveScope::Host(Arc::downgrade(&host));
        }
        rig.ctx.events_tx = broadcast::channel(1).0;
        let (task, mut client) = rig.start(rig.tunnel()).await;
        assert!(matches!(
            Rig::response(&mut client).await,
            ControlResponse::Error { .. }
        ));
        task.await.unwrap();
        let rows = rig.records().await;
        assert_eq!(rows.len(), 1, "unavailable tunnel is marked as failed");
        assert_eq!(rows[0]["state"], "error");
        assert_eq!(rows[0]["msg"], "Tunnel could not be opened");
        rig.caller.set_focused(true);
        assert!(rig.records().await.is_empty());
    }
}

fn status_request(rig: &Rig, body: &str) -> ControlRequest {
    serde_json::from_value(json!({"type":"term_status", "session_id":rig.caller.id(), "body":body}))
        .unwrap()
}

#[tokio::test]
async fn disabled_program_status_refuses_the_report_and_marks_no_request() {
    let mut rig = Rig::new();
    rig.registry.set_program_status(false);
    let refused = handle_request(status_request(&rig, "state=done:id=hook"), &rig.ctx).await;
    assert!(
        matches!(refused, ControlResponse::Error { ref message }
            if message == "program status is disabled by configuration"),
        "the control report is refused with the fixed text"
    );
    // The request itself runs; it only leaves no mark.
    let (task, client) = rig.start(rig.export()).await;
    rig.frame("export-job").await;
    assert!(
        rig.records().await.is_empty(),
        "no report and no mark is listed while off"
    );
    drop(client);
    task.await.unwrap();

    rig.registry.set_program_status(true);
    let accepted = handle_request(status_request(&rig, "state=done:id=hook"), &rig.ctx).await;
    assert!(matches!(accepted, ControlResponse::Ok { .. }));
    assert_eq!(rig.records().await.len(), 1);
}
