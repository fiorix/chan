use super::*;
use crate::terminal_sessions::{AttachHandle, CloseReason};
use serde_json::{json, Value};
use std::time::Duration;

struct Rig {
    _root: tempfile::TempDir,
    registry: Arc<TerminalRegistry>,
    session: AttachHandle,
    socket: ControlHandle,
    path: PathBuf,
}

impl Rig {
    fn new() -> Self {
        let (root, registry) = tests::empty_registry();
        let registry = Arc::new(registry);
        let session = registry
            .create(CreateOptions {
                size: PtySize {
                    cols: 80,
                    rows: 24,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                tab_name: Some("control-status".into()),
                tab_group: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                command: Some("read -r line".into()),
                env: Default::default(),
                profile: None,
            })
            .unwrap();
        let ctx = tests::test_ctx(Arc::new(RwLock::new(None)), ControlTenant::TerminalOnly);
        ctx.terminal_registry.set(registry.clone()).unwrap();
        let path = root.path().join("control.sock");
        let socket = start(path.clone(), ctx).unwrap();
        Self {
            _root: root,
            registry,
            session,
            socket,
            path,
        }
    }

    async fn request(&self, request: Value) -> ControlResponse {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        tokio::time::timeout(Duration::from_secs(10), async {
            let mut stream = tokio::net::UnixStream::connect(&self.path).await.unwrap();
            let mut bytes = serde_json::to_vec(&request).unwrap();
            bytes.push(b'\n');
            stream.write_all(&bytes).await.unwrap();
            stream.shutdown().await.unwrap();
            let mut line = String::new();
            BufReader::new(stream).read_line(&mut line).await.unwrap();
            serde_json::from_str(&line).unwrap()
        })
        .await
        .expect("bounded control request")
    }

    async fn status(&self, body: &str) -> ControlResponse {
        self.request(json!({"type":"term_status", "session_id":self.session.id(), "body":body}))
            .await
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.socket.accept_loop.abort();
        self.registry.close_all(CloseReason::Shutdown);
    }
}

#[tokio::test]
async fn loopback_control_report_between_pty_halves_and_list_agree() {
    let rig = Rig::new();
    let prefix = b"visible\x1b]7501;state=blocked:id=pty:msg=";
    assert!(rig.registry.inject_output(rig.session.id(), prefix));
    let before = rig.registry.attach(rig.session.id(), None).unwrap();
    let visible = rig.session.bytes_since_focus();
    assert!(
        matches!(rig.status("state=done:id=control").await, ControlResponse::Ok { message } if message == "program status accepted")
    );
    let after = rig.registry.attach(rig.session.id(), None).unwrap();
    assert_eq!(after.seq, before.seq, "control changes no ring position");
    assert_eq!(after.replay, before.replay, "control changes no ring bytes");
    assert_eq!(
        rig.session.bytes_since_focus(),
        visible,
        "control changes no activity"
    );
    assert_eq!(
        after.initial_program_status.records.len(),
        1,
        "complete report persists after request EOF"
    );
    assert_eq!(
        after.initial_program_status.records[0].id.as_deref(),
        Some("control")
    );
    assert!(rig
        .registry
        .inject_output(rig.session.id(), b"SGVsbG8=\x1b\\"));
    let status = rig.session.program_status().borrow().as_ref().clone();
    assert_eq!(status.records.len(), 2, "both reports applied whole");
    assert_eq!(status.records[1].msg.as_deref(), Some("Hello"));
    let ControlResponse::Ok { message } = rig.request(json!({"type":"term_list"})).await else {
        panic!("list failed")
    };
    let list: Value = serde_json::from_str(&message).unwrap();
    assert_eq!(
        list["groups"]["default"][0]["program_status"],
        serde_json::to_value(&status).unwrap(),
        "list carries control report"
    );
    assert!(matches!(
        rig.status("state=clear:id=control").await,
        ControlResponse::Ok { .. }
    ));
    assert_eq!(
        rig.session.program_status().borrow().records.len(),
        1,
        "clear accepted through control socket"
    );
}

#[tokio::test]
async fn loopback_refuses_query_reset_second_report_and_dead_session() {
    let rig = Rig::new();
    for body in [
        "?",
        "state=done:\u{1b}c",
        "\u{1b}]7501;state=done\u{1b}\\\u{1b}]7501;state=error\u{1b}\\",
        "state=done:id=",
        "state=done:msg=/w==",
    ] {
        assert!(
            matches!(rig.status(body).await, ControlResponse::Error { .. }),
            "invalid request accepted"
        );
        assert!(
            rig.session.program_status().borrow().records.is_empty(),
            "refused request changes no records"
        );
    }
    assert!(
        matches!(
            rig.status("\nstate = working:id=escaped-newline").await,
            ControlResponse::Ok { .. }
        ),
        "JSON newline is body whitespace, not another transport line"
    );
    rig.registry.close(rig.session.id(), CloseReason::Explicit);
    assert!(
        matches!(
            rig.status("state=done").await,
            ControlResponse::Error { .. }
        ),
        "dead session accepted"
    );
}
