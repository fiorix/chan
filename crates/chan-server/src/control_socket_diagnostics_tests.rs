use super::*;
use crate::terminal_sessions::{CloseReason, CreateOptions, SessionEvent};
use std::os::unix::fs::PermissionsExt;
use std::sync::Mutex;
use tower::ServiceExt;

/// Environment-sensitive builders run in a child so caches and discovery
/// cannot inherit another test's home or control socket.
pub(crate) async fn isolated_child(test: &str, long: bool) -> Option<std::process::Output> {
    const CHILD: &str = "CHAN_TEST_SOCKET_DIAGNOSTIC";
    if std::env::var(CHILD).ok().as_deref() == Some(test) {
        return None;
    }
    let home = tempfile::tempdir().expect("isolated home");
    let runtime_root = tempfile::Builder::new()
        .prefix("chan-sock-")
        .tempdir_in("/tmp")
        .expect("short runtime root");
    let runtime = if long {
        runtime_root.path().join("\u{e9}".repeat(60))
    } else {
        runtime_root.path().join("run")
    };
    std::fs::create_dir(&runtime).expect("runtime directory");
    std::fs::set_permissions(&runtime, std::fs::Permissions::from_mode(0o700)).unwrap();
    let output =
        tokio::time::timeout(
            Duration::from_secs(60),
            tokio::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", test, "--nocapture"])
                .env_clear()
                .envs(std::env::vars_os().filter(|(key, _)| {
                    key != "CHAN" && !key.to_string_lossy().starts_with("CHAN_")
                }))
                .env(CHILD, test)
                .env("HOME", home.path())
                .env("CHAN_HOME", home.path().join("chan"))
                .env("XDG_CONFIG_HOME", home.path().join("config"))
                .env("XDG_RUNTIME_DIR", &runtime)
                .env("SHELL", "/bin/sh")
                .kill_on_drop(true)
                .output(),
        )
        .await
        .expect("socket diagnostic child timed out")
        .unwrap();
    assert!(
        output.status.success(),
        "socket diagnostic child failed: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&output.stderr));
    Some(output)
}

#[derive(Clone, Debug)]
struct Event {
    level: tracing::Level,
    message: String,
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
        struct Message(String);
        impl tracing::field::Visit for Message {
            fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
                if field.name() == "message" {
                    self.0 = format!("{value:?}");
                }
            }
        }
        let mut message = Message(String::new());
        event.record(&mut message);
        self.0.lock().unwrap().push(Event {
            level: *event.metadata().level(),
            message: message.0,
        });
    }
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
}

async fn tenant(library: Library, identity: Option<String>) -> AppArtifacts {
    build_tenant_app(
        TenantBuild {
            library,
            tenant: TenantKind::Terminal {
                session_dir: None,
                drafts_store_root: None,
            },
            desktop: DesktopBridge::default(),
            unserve: chan_library::UnserveMode::Unsupported,
            control_identity: identity,
            bulk_transfer: crate::bulk_transfer::BulkTransferLane::new(),
        },
        &ServeConfig {
            addr: "127.0.0.1:0".parse().unwrap(),
            prefix: "/socket-proof".into(),
            no_token: true,
            idle_timeout: None,
            open_browser: false,
            search_aggression: None,
            settings_disabled: false,
            verbose: false,
        },
    )
    .await
    .expect("the tenant still starts")
}

async fn serving_and_terminal(artifacts: &mut AppArtifacts) -> (axum::http::StatusCode, String) {
    let response = artifacts
        .app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .uri("/socket-proof/api/health")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mut terminal = artifacts.terminal_sessions.create(CreateOptions {
        size: portable_pty::PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 },
        tab_name: None, tab_group: None, window_id: None, mcp_env: false, cwd: None,
        command: Some("printf 'CHAN_MARKER=<%s>\\nSOCKET_SET=<%s>\\nSOCKET_VALUE=<%s>\\n__DONE__\\n' \"$CHAN\" \"${CHAN_CONTROL_SOCKET+x}\" \"$CHAN_CONTROL_SOCKET\"".into()),
        env: Default::default(), profile: None,
    }).expect("real terminal");
    let mut output = String::from_utf8_lossy(&terminal.replay.concat()).into_owned();
    let observed = tokio::time::timeout(Duration::from_secs(20), async {
        while !output.lines().any(|line| line == "__DONE__") {
            match terminal.rx.recv().await.expect("terminal output") {
                SessionEvent::Output(bytes) => output.push_str(&String::from_utf8_lossy(&bytes)),
                SessionEvent::Error(error) => panic!("terminal error: {error}"),
                _ => {}
            }
        }
    })
    .await;
    artifacts
        .terminal_sessions
        .close(terminal.id(), CloseReason::Explicit);
    artifacts.tasks.shutdown().await;
    observed.expect("terminal environment observation timed out");
    (response.status(), output)
}

async fn run_tenant_case(long: bool) {
    let events = Arc::new(Mutex::new(Vec::new()));
    tracing::subscriber::set_global_default(Capture(events.clone())).unwrap();
    let home = PathBuf::from(std::env::var_os("CHAN_HOME").unwrap());
    let runtime = PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR").unwrap());
    let library = Library::open_at(home.join("library.toml")).unwrap();
    for identity in [Some("socket-diagnostic".to_owned()), None] {
        events.lock().unwrap().clear();
        let expected_stable = identity
            .as_ref()
            .map(|id| control_socket::stable_socket_path(id, "/socket-proof"));
        let mut app = tenant(library.clone(), identity).await;
        let bound = app
            .control_socket
            .as_ref()
            .map(|handle| handle.socket_path().to_owned());
        let (health, output) = serving_and_terminal(&mut app).await;
        let failures: Vec<_> = events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event.message.starts_with("control socket bind failed at "))
            .cloned()
            .collect();
        if long {
            assert_eq!(failures.len(), 1, "failed endpoint event: {failures:?}");
            let event = &failures[0];
            assert_eq!(event.level, tracing::Level::WARN, "failed bind level");
            let prefix = format!(
                "control socket bind failed at {}/chan-control-",
                runtime.display()
            );
            assert!(
                event.message.starts_with(&prefix),
                "diagnostic path: {event:?}"
            );
            let path_text = event
                .message
                .strip_prefix("control socket bind failed at ")
                .unwrap()
                .split(": ")
                .next()
                .unwrap()
                .split(" (")
                .next()
                .unwrap();
            if let Some(path) = expected_stable {
                assert_eq!(path_text, path.to_str().unwrap(), "stable path");
            }
            let maximum = if cfg!(target_os = "macos") { 103 } else { 107 };
            let clause = format!(
                " ({} bytes; maximum {maximum} pathname bytes)",
                path_text.len()
            );
            assert!(
                event.message.contains(&clause),
                "diagnostic byte count and maximum: {event:?}"
            );
            assert!(
                event.message.contains("path must be shorter than SUN_LEN"),
                "original bind error: {event:?}"
            );
            assert!(event.message.ends_with("this tenant's terminals get no CHAN_CONTROL_SOCKET; cs cannot reach this server"), "diagnostic consequence: {event:?}");
            assert!(bound.is_none(), "failed bind cannot supply a socket");
            assert!(
                output.contains("SOCKET_SET=<>"),
                "absent variable: {output}"
            );
        } else {
            assert!(
                failures.is_empty(),
                "successful bind emitted a failure: {failures:?}"
            );
            let path = bound.expect("short path binds");
            assert!(
                output.contains(&format!("SOCKET_VALUE=<{}>", path.display())),
                "bound socket: {output}"
            );
            assert!(
                output.contains("SOCKET_SET=<x>"),
                "supplied variable: {output}"
            );
        }
        assert_eq!(
            health,
            axum::http::StatusCode::OK,
            "the tenant keeps serving"
        );
        assert!(output.contains("CHAN_MARKER=<1>"), "chan marker: {output}");
    }
}

#[tokio::test]
async fn overlong_socket_tenant_warns_and_keeps_serving() {
    if isolated_child(
        "control_socket_diagnostics_tests::overlong_socket_tenant_warns_and_keeps_serving",
        true,
    )
    .await
    .is_some()
    {
        return;
    }
    run_tenant_case(true).await;
}

#[tokio::test]
async fn short_socket_tenant_binds_without_a_failure_diagnostic() {
    if isolated_child(
        "control_socket_diagnostics_tests::short_socket_tenant_binds_without_a_failure_diagnostic",
        false,
    )
    .await
    .is_some()
    {
        return;
    }
    run_tenant_case(false).await;
}

#[tokio::test]
async fn live_socket_owner_failure_has_no_length_clause() {
    if isolated_child(
        "control_socket_diagnostics_tests::live_socket_owner_failure_has_no_length_clause",
        false,
    )
    .await
    .is_some()
    {
        return;
    }
    let events = Arc::new(Mutex::new(Vec::new()));
    tracing::subscriber::set_global_default(Capture(events.clone())).unwrap();
    let home = PathBuf::from(std::env::var_os("CHAN_HOME").unwrap());
    let library = Library::open_at(home.join("library.toml")).unwrap();
    let mut live = tenant(library.clone(), Some("same-owner".into())).await;
    let path = live
        .control_socket
        .as_ref()
        .expect("live socket")
        .socket_path()
        .to_owned();
    let mut contender = tenant(library, Some("same-owner".into())).await;
    contender.tasks.shutdown().await;
    live.tasks.shutdown().await;
    let failures: Vec<_> = events
        .lock()
        .unwrap()
        .iter()
        .filter(|event| event.message.starts_with("control socket bind failed at "))
        .cloned()
        .collect();
    assert_eq!(failures.len(), 1, "failed endpoint event: {failures:?}");
    assert_eq!(failures[0].level, tracing::Level::WARN);
    assert_eq!(failures[0].message, format!("control socket bind failed at {}: socket {} is owned by a live process; this tenant's terminals get no CHAN_CONTROL_SOCKET; cs cannot reach this server", path.display(), path.display()));
}
