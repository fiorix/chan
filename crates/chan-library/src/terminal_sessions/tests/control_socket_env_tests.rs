use super::*;

#[test]
fn control_bind_report_replaces_nul_before_export() {
    let mut env = ChanSpawnEnv::default();
    ControlSocketEnv::Failed("before\0after".into()).add_to_spawn_env(&mut env);
    assert_eq!(
        env.0.get("CHAN_CONTROL_SOCKET_ERROR").map(String::as_str),
        Some("before\\0after"),
        "NUL must be visible text in the exported report"
    );
    assert!(!env.0.contains_key("CHAN_CONTROL_SOCKET"));
}

#[test]
fn control_bind_report_key_refuses_caller_overrides() {
    for ignore_case in [false, true] {
        assert!(
            chan_overrides_spawn_env_on(
                "CHAN_CONTROL_SOCKET_ERROR",
                "caller report",
                None,
                ignore_case
            ),
            "a caller cannot override the bind report"
        );
    }
    assert!(chan_overrides_spawn_env_on(
        "Chan_Control_Socket_Error",
        "caller report",
        None,
        true
    ));
    assert!(!chan_overrides_spawn_env_on(
        "Chan_Control_Socket_Error",
        "caller report",
        None,
        false
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn inherited_control_bind_report_is_removed() {
    const TEST: &str = "terminal_sessions::tests::control_socket_env_tests::inherited_control_bind_report_is_removed";
    const CHILD: &str = "CHAN_TEST_INHERITED_CONTROL_REPORT";
    if std::env::var(CHILD).ok().as_deref() != Some(TEST) {
        let caller = std::thread::current()
            .name()
            .expect("libtest caller name")
            .to_owned();
        let output = tokio::time::timeout(
            Duration::from_secs(30),
            tokio::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", TEST, "--nocapture"])
                .env(CHILD, TEST)
                .env("CHAN_CONTROL_SOCKET_ERROR", "inherited bind report")
                .kill_on_drop(true)
                .output(),
        )
        .await
        .expect("inherited-report child timed out")
        .unwrap();
        assert!(
            output.status.success(),
            "inherited-report child failed: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("test result: ok. 1 passed"),
            "inherited-report child did not run"
        );
        let passed = format!("test {caller} ... ok");
        assert!(
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .any(|line| line == passed),
            "inherited-report child did not run its caller: {caller}\n{}",
            String::from_utf8_lossy(&output.stdout)
        );
        return;
    }
    assert_eq!(
        std::env::var("CHAN_CONTROL_SOCKET_ERROR").unwrap(),
        "inherited bind report",
        "inherited-value positive control"
    );
    for control_socket in [
        ControlSocketEnv::None,
        ControlSocketEnv::Bound(PathBuf::from("/bound.sock")),
    ] {
        let mut config = test_config(4096, 4, 60);
        config.control_socket = control_socket;
        let registry = Registry::new(config);
        let mut handle = registry
            .create(CreateOptions {
                size: test_size(),
                tab_name: None,
                tab_group: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                command: Some(
                    "printf 'REPORT=<%s>\\n__REPORT_DONE__\\n' \"${CHAN_CONTROL_SOCKET_ERROR+x}\""
                        .into(),
                ),
                env: Default::default(),
                profile: None,
            })
            .unwrap();
        let output = collect_until(&mut handle, "__REPORT_DONE__", Duration::from_secs(5)).await;
        registry.close(handle.id(), CloseReason::Explicit);
        assert!(
            output.contains("REPORT=<>"),
            "inherited bind report reached the PTY: {output}"
        );
    }
}
