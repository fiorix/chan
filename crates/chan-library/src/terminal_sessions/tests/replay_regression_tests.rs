use super::*;

#[test]
fn default_config_retains_two_mebibytes_of_terminal_replay() {
    let default = TerminalConfig::default();
    let omitted: TerminalConfig = serde_json::from_str("{}").unwrap();
    assert_eq!(default.ring_bytes, 2 * 1024 * 1024);
    assert_eq!(omitted.ring_bytes, 2 * 1024 * 1024);
}

/// A profiles resolver that answers `default_profile` as `id`.
fn resolving_default_profile(id: &'static str) -> TerminalProfilesResolver {
    TerminalProfilesResolver::new(move || {
        Some(TerminalProfilePrefs {
            profiles: Vec::new(),
            default_profile: Some(id.into()),
        })
    })
}

#[test]
fn a_poisoned_profiles_resolver_keeps_resolving_at_spawn_time() {
    let registry = Registry::new(test_config(4096, 4, 60));
    registry.install_terminal_profiles_resolver(resolving_default_profile("pulled"));
    let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _guard = registry.terminal_profiles_resolver.lock().unwrap();
        panic!("poison the resolver cell");
    }));
    assert!(poisoned.is_err());
    assert!(registry.terminal_profiles_resolver.is_poisoned());
    // The boot snapshot names no default, so "pulled" proves the resolver is
    // still consulted.
    assert_eq!(
        registry
            .spawn_config()
            .config
            .terminal
            .default_profile
            .as_deref(),
        Some("pulled")
    );
}

#[test]
fn a_poisoned_profiles_resolver_can_be_replaced() {
    let registry = Registry::new(test_config(4096, 4, 60));
    registry.install_terminal_profiles_resolver(resolving_default_profile("first"));
    let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _guard = registry.terminal_profiles_resolver.lock().unwrap();
        panic!("poison the resolver cell");
    }));
    assert!(poisoned.is_err());
    registry.install_terminal_profiles_resolver(resolving_default_profile("second"));
    assert_eq!(
        registry
            .spawn_config()
            .config
            .terminal
            .default_profile
            .as_deref(),
        Some("second")
    );
}

#[test]
fn a_controller_return_records_an_unknown_exit_and_releases_close_waiters() {
    let session = test_session_with_ring(1024);
    let registry_exit = Arc::new(Mutex::new(None));
    let mut attached = session.clone().attach(None);

    drop(ChildEndedOnReturn(session.clone(), registry_exit.clone()));

    assert_eq!(
        *session.exit.lock().unwrap(),
        Some(TerminalExit::Unknown),
        "controller return records the unknown exit"
    );
    assert_eq!(*registry_exit.lock().unwrap(), Some(TerminalExit::Unknown));
    assert_eq!(
        session.ended.wait(Duration::ZERO),
        Some(true),
        "controller return releases close waiters"
    );
    assert!(matches!(
        attached.rx.try_recv(),
        Ok(SessionEvent::Exit(TerminalExit::Unknown))
    ));
}

#[test]
fn a_controller_return_keeps_an_exit_already_recorded() {
    let session = test_session_with_ring(1024);
    let registry_exit = Arc::new(Mutex::new(None));
    session.record_terminal_exit(TerminalExit::Code { code: 23 }, &registry_exit);

    drop(ChildEndedOnReturn(session.clone(), registry_exit.clone()));

    assert_eq!(
        *session.exit.lock().unwrap(),
        Some(TerminalExit::Code { code: 23 }),
        "controller return preserves the recorded exit"
    );
    assert_eq!(
        *registry_exit.lock().unwrap(),
        Some(TerminalExit::Code { code: 23 })
    );
    assert_eq!(session.ended.wait(Duration::ZERO), Some(true));
}

#[test]
fn a_controller_return_after_close_does_not_publish_an_exit() {
    let session = test_session_with_ring(1024);
    let registry_exit = Arc::new(Mutex::new(None));
    session.close(CloseReason::Explicit);

    drop(ChildEndedOnReturn(session.clone(), registry_exit.clone()));

    assert_eq!(
        *session.exit.lock().unwrap(),
        None,
        "controller return after close publishes no exit"
    );
    assert_eq!(*registry_exit.lock().unwrap(), None);
    assert_eq!(session.ended.wait(Duration::ZERO), Some(true));
}

#[test]
fn creating_a_named_session_reuses_an_exited_detached_sessions_name() {
    let registry = Registry::new(test_config(1024, 4, 60));
    let (exited, _commands) =
        test_agent_session(1024, "exited-name", Some("worker"), None, None, &[]);
    exited.record_terminal_exit(TerminalExit::Code { code: 0 }, &registry.last_exit);
    register_session(&registry, &exited);

    let created = registry
        .create(CreateOptions {
            tab_name: Some("worker".into()),
            mcp_env: false,
            ..opts_with_window("win-reuse-name")
        })
        .unwrap();
    let actual_name = created.live_metadata().name;
    let retained_exited = registry.sessions.lock().unwrap().contains_key(&exited.id);
    registry.close_all(CloseReason::Shutdown);

    assert_eq!(
        actual_name.as_deref(),
        Some("worker"),
        "the next create reuses the exited sessions exact name"
    );
    assert!(
        !retained_exited,
        "the detached exited session releases its name"
    );
}
