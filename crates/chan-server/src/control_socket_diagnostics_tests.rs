use super::*;
use crate::terminal_sessions::{CloseReason, CreateOptions, SessionEvent};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::sync::Mutex;
use tower::ServiceExt;

/// Environment-sensitive builders run in a child so caches and discovery
/// cannot inherit another test's home or control socket.
pub(crate) async fn isolated_child(test: &str, long: bool) -> Option<std::process::Output> {
    const CHILD: &str = "CHAN_TEST_SOCKET_DIAGNOSTIC";
    if std::env::var(CHILD).ok().as_deref() == Some(test) {
        return None;
    }
    // Capture libtest's caller before awaiting, independently of the selector.
    let caller = std::thread::current()
        .name()
        .expect("libtest caller name")
        .to_owned();
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
                .args(["--exact", test, "--nocapture", "--test-threads=2"])
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
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("test result: ok. 1 passed"),
        "socket diagnostic child did not run one test: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    let passed = format!("test {caller} ... ok");
    assert!(
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|line| line == passed),
        "socket diagnostic child did not run its caller: {caller}\n{}",
        String::from_utf8_lossy(&output.stdout)
    );
    eprint!("{}", String::from_utf8_lossy(&output.stderr));
    Some(output)
}

#[tokio::test]
#[should_panic(expected = "socket diagnostic child did not run one test")]
async fn diagnostic_child_requires_one_test() {
    isolated_child("control_socket_diagnostics_tests::no_such_test", false).await;
}

#[test]
fn control_bind_report_override_is_refused_by_spawn_request() {
    let env = std::collections::BTreeMap::from([(
        "CHAN_CONTROL_SOCKET_ERROR".into(),
        "caller report".into(),
    )]);
    assert_eq!(
        routes::validate_terminal_env(&env, None),
        Err("terminal env key CHAN_CONTROL_SOCKET_ERROR is chan's own and cannot be set".into()),
        "spawn request cannot replace the server's report"
    );
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
            client_sessions: chan_library::client_sessions::ClientSessions::new(),
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
        command: Some("printf 'CHAN_MARKER=<%s>\\nSOCKET_SET=<%s>\\nSOCKET_VALUE=<%s>\\nERROR_SET=<%s>\\nERROR_VALUE=<%s>\\n__DONE__\\n' \"$CHAN\" \"${CHAN_CONTROL_SOCKET+x}\" \"$CHAN_CONTROL_SOCKET\" \"${CHAN_CONTROL_SOCKET_ERROR+x}\" \"$CHAN_CONTROL_SOCKET_ERROR\"".into()),
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
            let detail = format!("control socket bind failed at {path_text}{clause}: path must be shorter than SUN_LEN");
            assert!(
                output.contains(&format!("ERROR_VALUE=<{detail}>")),
                "overlong bind report: {output}"
            );
            assert!(
                output.contains("ERROR_SET=<x>"),
                "overlong report exported: {output}"
            );
            assert!(
                output.contains("SOCKET_SET=<>"),
                "absent variable: {output}"
            );
        } else {
            assert!(
                failures.is_empty(),
                "successful bind emitted a failure: {failures:?}"
            );
            let warnings: Vec<_> = events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| event.message.starts_with("control socket bound at "))
                .cloned()
                .collect();
            assert!(
                warnings.is_empty(),
                "UTF-8 endpoint emitted an export warning: {warnings:?}"
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
            assert!(
                output.contains("ERROR_SET=<>"),
                "bound socket has no failure report: {output}"
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

#[derive(Clone, Copy)]
enum RefusedDirectory {
    ForeignOwner,
    Symlink,
    RegularFile,
    WrongMode,
}

async fn refused_directory_case(test: &str, case: RefusedDirectory) {
    if isolated_child(test, false).await.is_some() {
        return;
    }
    let events = Arc::new(Mutex::new(Vec::new()));
    tracing::subscriber::set_global_default(Capture(events.clone())).unwrap();
    let home = PathBuf::from(std::env::var_os("CHAN_HOME").unwrap());
    let runtime = PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR").unwrap());
    let dir = match case {
        RefusedDirectory::ForeignOwner => {
            // On macOS /tmp is a symlink, which is refused before ownership.
            std::fs::canonicalize("/tmp").unwrap()
        }
        RefusedDirectory::Symlink => {
            let link = runtime.with_file_name("link");
            std::os::unix::fs::symlink(&runtime, &link).unwrap();
            link
        }
        RefusedDirectory::RegularFile => {
            let file = runtime.with_file_name("file");
            std::fs::write(&file, b"fixture").unwrap();
            file
        }
        RefusedDirectory::WrongMode => {
            std::fs::set_permissions(&runtime, std::fs::Permissions::from_mode(0o755)).unwrap();
            runtime
        }
    };
    let expected_refusal = match case {
        RefusedDirectory::ForeignOwner => {
            let owner = std::fs::symlink_metadata(&dir).unwrap().uid();
            let uid = rustix::process::geteuid().as_raw();
            assert_ne!(owner, uid, "fixture requires a directory another user owns");
            format!(
                "control socket directory {} is owned by uid {owner}, expected uid {uid}",
                dir.display()
            )
        }
        RefusedDirectory::Symlink => format!(
            "control socket directory {} is a symbolic link",
            dir.display()
        ),
        RefusedDirectory::RegularFile => format!(
            "control socket directory {} is not a directory",
            dir.display()
        ),
        RefusedDirectory::WrongMode => format!(
            "control socket directory {} has mode 0755, expected 0700",
            dir.display()
        ),
    };
    mcp_bridge::TEST_SOCKET_DIR.set(dir.clone()).unwrap();
    let library = Library::open_at(home.join("library.toml")).unwrap();
    for identity in [Some("refused-directory".to_owned()), None] {
        events.lock().unwrap().clear();
        let expected_stable = identity
            .as_ref()
            .map(|id| control_socket::stable_socket_path(id, "/socket-proof"));
        let mut app = tenant(library.clone(), identity).await;
        assert!(
            app.control_socket.is_none(),
            "refused directory bound a socket"
        );
        let (health, output) = serving_and_terminal(&mut app).await;
        assert_eq!(
            health,
            axum::http::StatusCode::OK,
            "refused directory tenant keeps serving"
        );
        assert!(
            output.contains("SOCKET_SET=<>"),
            "refused directory has no socket variable: {output}"
        );
        let failures: Vec<_> = events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event.message.starts_with("control socket bind failed at "))
            .cloned()
            .collect();
        assert_eq!(
            failures.len(),
            1,
            "one refused-directory diagnostic: {failures:?}"
        );
        let event = &failures[0];
        assert_eq!(event.level, tracing::Level::WARN);
        let path = event
            .message
            .strip_prefix("control socket bind failed at ")
            .unwrap()
            .split(": ")
            .next()
            .unwrap();
        if let Some(expected) = expected_stable {
            assert_eq!(path, expected.to_str().unwrap());
        } else {
            assert!(path.starts_with(&format!(
                "{}/chan-control-{}-",
                dir.display(),
                std::process::id()
            )));
        }
        let detail = format!("control socket bind failed at {path}: {expected_refusal}");
        assert_eq!(event.message, format!("{detail}; this tenant's terminals get no CHAN_CONTROL_SOCKET; cs cannot reach this server"), "original refused-directory reason");
        assert!(
            output.contains(&format!("ERROR_VALUE=<{detail}>")),
            "refused-directory bind report: {output}"
        );
        assert!(
            output.contains("ERROR_SET=<x>"),
            "refused-directory report exported: {output}"
        );
    }
}

#[tokio::test]
async fn foreign_directory_tenant_exports_the_owner_refusal() {
    refused_directory_case(
        "control_socket_diagnostics_tests::foreign_directory_tenant_exports_the_owner_refusal",
        RefusedDirectory::ForeignOwner,
    )
    .await;
}

#[tokio::test]
async fn symlink_directory_tenant_exports_the_refusal() {
    refused_directory_case(
        "control_socket_diagnostics_tests::symlink_directory_tenant_exports_the_refusal",
        RefusedDirectory::Symlink,
    )
    .await;
}

#[tokio::test]
async fn regular_file_directory_tenant_exports_the_refusal() {
    refused_directory_case(
        "control_socket_diagnostics_tests::regular_file_directory_tenant_exports_the_refusal",
        RefusedDirectory::RegularFile,
    )
    .await;
}

#[tokio::test]
async fn wrong_mode_directory_tenant_exports_the_refusal() {
    refused_directory_case(
        "control_socket_diagnostics_tests::wrong_mode_directory_tenant_exports_the_refusal",
        RefusedDirectory::WrongMode,
    )
    .await;
}

// APFS refuses non-UTF-8 names before the socket code can run.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn non_utf8_bound_path_has_no_failure_report() {
    use std::os::unix::ffi::OsStringExt;

    if isolated_child(
        "control_socket_diagnostics_tests::non_utf8_bound_path_has_no_failure_report",
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
    let runtime = PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR").unwrap());
    let dir = runtime.join(std::ffi::OsString::from_vec(vec![0xff]));
    std::fs::create_dir(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    mcp_bridge::TEST_SOCKET_DIR.set(dir).unwrap();
    let library = Library::open_at(home.join("library.toml")).unwrap();
    for identity in [Some("non-utf8-path".to_owned()), None] {
        events.lock().unwrap().clear();
        let mut app = tenant(library.clone(), identity).await;
        let path = app
            .control_socket
            .as_ref()
            .expect("non-UTF-8 endpoint binds")
            .socket_path()
            .to_path_buf();
        assert!(path.to_str().is_none(), "fixture path must not be UTF-8");
        let (health, output) = serving_and_terminal(&mut app).await;
        let captured = events.lock().unwrap().clone();
        let warnings: Vec<_> = captured
            .iter()
            .filter(|event| event.message.starts_with("control socket bound at "))
            .collect();
        assert_eq!(
            warnings.len(),
            1,
            "bound endpoint export warning: {warnings:?}"
        );
        let event = warnings[0];
        assert_eq!(
            event.level,
            tracing::Level::WARN,
            "bound endpoint export level"
        );
        assert_eq!(
            event.message,
            format!(
                "control socket bound at {path:?}, which is not UTF-8 and cannot be exported; \
                 this tenant's terminals get no CHAN_CONTROL_SOCKET; cs cannot reach this server"
            ),
            "bound endpoint path and consequence"
        );
        assert!(
            !captured
                .iter()
                .any(|event| event.message.starts_with("control socket bind failed at ")),
            "successful non-UTF-8 bind emitted a failure: {captured:?}"
        );
        assert_eq!(health, axum::http::StatusCode::OK);
        assert!(
            output.contains("SOCKET_SET=<>"),
            "non-UTF-8 socket is not exported: {output}"
        );
        assert!(
            output.contains("ERROR_SET=<>"),
            "non-UTF-8 bound socket has no failure report: {output}"
        );
    }
}

// APFS refuses non-UTF-8 names before the socket code can run.
#[cfg(target_os = "linux")]
async fn mcp_bound_path_case(test: &str, non_utf8: bool) {
    use std::os::unix::ffi::OsStringExt;
    use std::os::unix::fs::FileTypeExt;

    if isolated_child(test, false).await.is_some() {
        return;
    }
    let events = Arc::new(Mutex::new(Vec::new()));
    tracing::subscriber::set_global_default(Capture(events.clone())).unwrap();
    let home = PathBuf::from(std::env::var_os("CHAN_HOME").unwrap());
    let runtime = PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR").unwrap());
    let dir = if non_utf8 {
        runtime.join(std::ffi::OsString::from_vec(vec![0xff]))
    } else {
        runtime.join("mcp")
    };
    std::fs::create_dir(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    mcp_bridge::TEST_SOCKET_DIR.set(dir.clone()).unwrap();
    let root = home.join("workspace");
    std::fs::create_dir_all(&root).unwrap();
    let library = Library::open_at(home.join("library.toml")).unwrap();
    library.register_workspace(&root).unwrap();
    let workspace = library.open_workspace(&root).unwrap();
    workspace.stop_open_recovery();
    let mut app = build_app(
        library,
        workspace,
        &ServeConfig {
            addr: ([127, 0, 0, 1], 0).into(),
            prefix: "/mcp-proof".into(),
            no_token: true,
            idle_timeout: None,
            open_browser: false,
            search_aggression: None,
            settings_disabled: false,
            verbose: false,
        },
        DesktopBridge::default(),
        chan_library::UnserveMode::Standalone,
        None,
    )
    .await
    .expect("workspace tenant starts");
    let path = app
        .mcp_bridge
        .as_ref()
        .expect("MCP bridge binds")
        .socket_path()
        .to_path_buf();
    assert_eq!(
        path.parent(),
        Some(dir.as_path()),
        "configured runtime directory"
    );
    assert_eq!(path.to_str().is_none(), non_utf8, "fixture path encoding");
    assert!(
        std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_socket(),
        "bound MCP endpoint is a socket"
    );
    app.tasks.shutdown().await;
    let captured = events.lock().unwrap().clone();
    let warnings: Vec<_> = captured
        .iter()
        .filter(|event| event.message.starts_with("mcp bridge bound at "))
        .collect();
    assert_eq!(
        warnings.len(),
        usize::from(non_utf8),
        "MCP export warning count: {warnings:?}"
    );
    if non_utf8 {
        let event = warnings[0];
        assert_eq!(
            event.level,
            tracing::Level::WARN,
            "MCP export warning level"
        );
        assert_eq!(
            event.message,
            format!(
                "mcp bridge bound at {path:?}, which is not UTF-8 and cannot be exported; \
                 opted-in terminals get no CHAN_MCP_* descriptor; tools cannot discover \
                 this workspace's MCP endpoint through it"
            ),
            "MCP export path and consequence"
        );
    }
    assert!(
        !captured
            .iter()
            .any(|event| event.message.starts_with("mcp bridge bind failed at ")),
        "successful MCP bind emitted a failure: {captured:?}"
    );
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn mcp_non_utf8_bound_path_warns_once() {
    mcp_bound_path_case(
        "control_socket_diagnostics_tests::mcp_non_utf8_bound_path_warns_once",
        true,
    )
    .await;
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn mcp_utf8_bound_path_has_no_export_warning() {
    mcp_bound_path_case(
        "control_socket_diagnostics_tests::mcp_utf8_bound_path_has_no_export_warning",
        false,
    )
    .await;
}
