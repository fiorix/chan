use super::super::tests::test_session_with_ring;
use super::*;

fn registry() -> Arc<Registry> {
    Arc::new(Registry::new(RegistryConfig {
        workspace_root: PathBuf::from("/"),
        mcp_socket_path: None,
        control_socket: ControlSocketEnv::None,
        terminal: TerminalConfig::default(),
    }))
}

fn register(registry: &Registry, session: &Arc<Session>) {
    registry
        .sessions
        .lock()
        .unwrap()
        .insert(session.id.clone(), session.clone());
    registry.apply_program_status(session);
}

fn reading(session: &Session) -> ProgramReading {
    session.output.lock().unwrap().program.reading().clone()
}

fn read_batch(
    sessions: Vec<Arc<Session>>,
    periodic: bool,
    source: &impl ProgramSource,
) -> Vec<Sample> {
    read_names(prepare_batch(sessions, periodic, source), source)
}

fn title(session: &Session, text: &str, group: u32) {
    session.record_plain_output_with_foreground(format!("\x1b]2;{text}\x07").as_bytes(), || {
        Foreground::Group(group)
    });
}

struct Source {
    foreground: Mutex<Foreground>,
    name: Mutex<Option<String>>,
    probes: AtomicUsize,
    reads: watch::Sender<usize>,
    registry: Weak<Registry>,
    sessions: Vec<Weak<Session>>,
    on_read: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl Source {
    fn new(registry: &Arc<Registry>, session: &Arc<Session>) -> Arc<Self> {
        Arc::new(Self {
            foreground: Mutex::new(Foreground::Group(10)),
            name: Mutex::new(Some("shell".into())),
            probes: AtomicUsize::new(0),
            reads: watch::channel(0).0,
            registry: Arc::downgrade(registry),
            sessions: vec![Arc::downgrade(session)],
            on_read: Mutex::new(None),
        })
    }

    fn change(&self, group: u32, name: &str) {
        *self.foreground.lock().unwrap() = Foreground::Group(group);
        *self.name.lock().unwrap() = Some(name.into());
    }
}

impl ProgramSource for Source {
    fn foreground(&self, _: &Session) -> Foreground {
        self.probes.fetch_add(1, Ordering::Relaxed);
        *self.foreground.lock().unwrap()
    }

    fn names(&self, groups: &[u32]) -> HashMap<u32, String> {
        let registry = self.registry.upgrade().unwrap();
        assert!(
            registry.sessions.try_lock().is_ok(),
            "name read holds the registry lock"
        );
        for session in &self.sessions {
            assert!(
                session.upgrade().unwrap().output.try_lock().is_ok(),
                "name read holds the ring lock"
            );
        }
        let name = self.name.lock().unwrap().clone();
        let count = *self.reads.borrow() + 1;
        self.reads.send_replace(count);
        let hook = self.on_read.lock().unwrap().take();
        if let Some(hook) = hook {
            hook();
        }
        groups
            .iter()
            .filter_map(|&group| name.clone().map(|name| (group, name)))
            .collect()
    }
}

fn sweep(registry: &Registry, session: &Arc<Session>, periodic: bool, source: &Source) {
    registry.apply_program_samples(read_batch(vec![session.clone()], periodic, source), source);
}

#[test]
fn terminal_program_sampler_nominal_ticks_and_dirty_coalescing() {
    for millis in [500, 1_000] {
        let start = Instant::now();
        let mut schedule = Schedule::new(start, Duration::from_millis(millis));
        assert_eq!(schedule.take(start), Some(false));
        for t in 1..150 {
            schedule.dirty = true;
            assert_eq!(schedule.take(start + Duration::from_millis(t)), None);
        }
        assert_eq!(schedule.take(start + REFRESH_INTERVAL), Some(false));
        assert_eq!(
            schedule.take(start + Duration::from_millis(millis - 1)),
            None
        );
        assert_eq!(
            schedule.take(start + Duration::from_millis(millis)),
            Some(true)
        );
        assert_eq!(schedule.periodic, start + Duration::from_millis(millis * 2));
    }
}

#[test]
fn terminal_program_sampler_quiet_detached_session_is_sampled() {
    let registry = registry();
    let session = test_session_with_ring(4096);
    register(&registry, &session);
    let source = Source::new(&registry, &session);
    session.seed_program_with(&*source);
    assert_eq!(reading(&session).command.as_deref(), Some("shell"));
    assert_eq!(session.attach_count.load(Ordering::Relaxed), 0);
    source.change(20, "sleep");
    sweep(&registry, &session, true, &source);
    assert_eq!(reading(&session).command.as_deref(), Some("sleep"));
    title(&session, "job", 20);
    sweep(&registry, &session, false, &source);
    source.change(10, "shell");
    sweep(&registry, &session, true, &source);
    assert_eq!(
        reading(&session),
        ProgramReading {
            title: None,
            command: Some("shell".into())
        }
    );
    assert_eq!(*source.reads.borrow(), 4);
}

#[test]
fn terminal_program_sampler_title_flood_has_bounded_name_reads() {
    let registry = registry();
    let session = test_session_with_ring(4096);
    register(&registry, &session);
    let source = Source::new(&registry, &session);
    let start = Instant::now();
    let mut schedule = Schedule::new(start, Duration::from_millis(500));
    for t in 0..1_000 {
        title(&session, "title", 10);
        schedule.dirty = true;
        if let Some(periodic) = schedule.take(start + Duration::from_millis(t)) {
            sweep(&registry, &session, periodic, &source);
        }
    }
    assert_eq!(
        *source.reads.borrow(),
        7,
        "one batch per 150 ms under a title flood"
    );
    assert_eq!(
        source.probes.load(Ordering::Relaxed),
        14,
        "two foreground reads per name batch"
    );
    assert_eq!(reading(&session).title.as_deref(), Some("title"));
}

#[test]
fn terminal_program_sampler_stale_title_batch_is_rejected() {
    let registry = registry();
    let session = test_session_with_ring(4096);
    register(&registry, &session);
    let source = Source::new(&registry, &session);
    session.seed_program_with(&*source);
    source.change(10, "old-sample");
    let samples = read_batch(vec![session.clone()], true, &*source);
    title(&session, "new title", 10);
    registry.apply_program_samples(samples, &*source);
    assert_eq!(
        reading(&session),
        ProgramReading {
            title: Some("new title".into()),
            command: Some("shell".into())
        }
    );
}

#[test]
fn terminal_program_sampler_group_changed_during_read_is_rejected() {
    let registry = registry();
    let session = test_session_with_ring(4096);
    register(&registry, &session);
    let source = Source::new(&registry, &session);
    title(&session, "shell title", 10);
    let samples = read_batch(vec![session.clone()], true, &*source);
    source.change(20, "job");
    registry.apply_program_samples(samples, &*source);
    assert_eq!(reading(&session), ProgramReading::default());
    sweep(&registry, &session, true, &source);
    assert_eq!(reading(&session).command.as_deref(), Some("job"));
}

#[test]
fn terminal_program_sampler_same_id_and_generation_is_another_incarnation() {
    let registry = registry();
    let old = test_session_with_ring(4096);
    register(&registry, &old);
    let source = Source::new(&registry, &old);
    let samples = read_batch(vec![old.clone()], true, &*source);
    let replacement = test_session_with_ring(4096);
    register(&registry, &replacement);
    registry.apply_program_samples(samples, &*source);
    assert_eq!(
        reading(&old),
        ProgramReading::default(),
        "an unmapped observer cannot accept a batch"
    );
    assert_eq!(reading(&replacement), ProgramReading::default());
}

#[test]
fn terminal_program_output_ring_live_replay_and_attach_snapshot() {
    let session = test_session_with_ring(4096);
    session.output.lock().unwrap().status.set_enabled(false);
    let bytes = b"plain\x1b]0;first\x07\x1b]52;c;YQ==\x07\x1b]133;A\x07\x1b]7501;state=working\x07\x1b]2;last\x1b\\tail";
    // No attached viewer is needed to retain a reading or the original stream.
    session.record_plain_output_with_foreground(bytes, || Foreground::Group(10));
    let mut attached = session.clone().attach(None);
    assert_eq!(attached.replay.concat(), bytes);
    assert_eq!(attached.initial_program.title.as_deref(), Some("last"));
    assert_eq!(*attached.program_rx.borrow(), attached.initial_program);
    assert!(!attached.program_rx.has_changed().unwrap());
    assert!(attached.initial_program_status.records.is_empty());
    session.record_plain_output_with_foreground(bytes, || Foreground::Group(10));
    let mut live = Vec::new();
    while let Ok(event) = attached.rx.try_recv() {
        if let SessionEvent::Output(bytes) = event {
            live.extend(bytes);
        }
    }
    assert_eq!(live, bytes);
    assert!(
        !attached.program_rx.has_changed().unwrap(),
        "equal readings must not publish"
    );
    let again = session.clone().attach(None);
    assert_eq!(
        again.replay.concat(),
        [bytes.as_slice(), bytes.as_slice()].concat()
    );
    assert_eq!(again.initial_program.title.as_deref(), Some("last"));
    assert_eq!(
        reading(&session),
        again.initial_program,
        "replay must not mutate ownership"
    );
    title(&session, "later", 10);
    assert!(attached.program_rx.has_changed().unwrap());
    assert_eq!(
        attached.program_rx.borrow_and_update().title.as_deref(),
        Some("later")
    );
}

#[test]
fn terminal_program_lifecycle_seed_exit_restart_and_partial_clear() {
    for restart in [false, true] {
        let registry = registry();
        let session = test_session_with_ring(4096);
        register(&registry, &session);
        let source = Source::new(&registry, &session);
        session.seed_program_with(&*source);
        let mut attached = session.clone().attach(None);
        assert_eq!(attached.initial_program.command.as_deref(), Some("shell"));
        title(&session, "active", 10);
        session.record_plain_output_with_foreground(b"\x1b]2;partial", || Foreground::Group(10));
        let samples = read_batch(vec![session.clone()], true, &*source);
        if restart {
            session.close_for_restart();
        } else {
            session.record_exit(TerminalExit::Unknown, None);
        }
        let mut ended = false;
        while let Ok(event) = attached.rx.try_recv() {
            if matches!(event, SessionEvent::Exit(_) | SessionEvent::Restarted) {
                ended = true;
                assert_eq!(
                    *attached.program_rx.borrow(),
                    ProgramReading::default(),
                    "clear precedes exit/restart"
                );
            }
        }
        assert!(ended);
        registry.apply_program_samples(samples, &*source);
        session.record_plain_output_with_foreground(b"suffix\x07", || Foreground::Group(10));
        assert_eq!(reading(&session), ProgramReading::default());
        let replacement = test_session_with_ring(4096);
        register(&registry, &replacement);
        replacement.record_plain_output_with_foreground(b"suffix\x07", || Foreground::Group(10));
        assert_eq!(reading(&replacement), ProgramReading::default());
    }
}

#[test]
fn terminal_program_unavailable_seed_and_title_only_source() {
    let registry = registry();
    let session = test_session_with_ring(4096);
    let source = Source::new(&registry, &session);
    *source.foreground.lock().unwrap() = Foreground::Unavailable;
    session.seed_program_with(&*source);
    assert_eq!(reading(&session), ProgramReading::default());
    assert_eq!(*source.reads.borrow(), 0);
    session
        .record_plain_output_with_foreground(b"\x1b]2;ConPTY title\x07", || Foreground::TitleOnly);
    assert_eq!(
        reading(&session),
        ProgramReading {
            title: Some("ConPTY title".into()),
            command: None
        }
    );
    *source.foreground.lock().unwrap() = Foreground::TitleOnly;
    session.seed_program_with(&*source);
    assert_eq!(*source.reads.borrow(), 0);
    assert_eq!(reading(&session).title.as_deref(), Some("ConPTY title"));
}

#[test]
fn terminal_program_tmux_pane_keeps_empty_pair() {
    let registry = registry();
    let mut session = test_session_with_ring(4096);
    Arc::get_mut(&mut session).unwrap().tmux_pane = Some(TmuxPaneRef {
        connection: TmuxConnectionId(1),
        pane: chan_tmux::PaneId(1),
    });
    register(&registry, &session);
    let source = Source::new(&registry, &session);
    title(&session, "tmux title", 10);
    sweep(&registry, &session, true, &source);
    assert_eq!(reading(&session), ProgramReading::default());
    assert_eq!(*source.reads.borrow(), 0);
}

struct Release(Arc<(Mutex<bool>, Condvar)>);

impl Drop for Release {
    fn drop(&mut self) {
        *self.0 .0.lock().unwrap() = true;
        self.0 .1.notify_all();
    }
}

fn block_next(source: &Source) -> Release {
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let wait = gate.clone();
    *source.on_read.lock().unwrap() = Some(Box::new(move || {
        let mut ready = wait.0.lock().unwrap();
        while !*ready {
            ready = wait.1.wait(ready).unwrap();
        }
    }));
    Release(gate)
}

#[tokio::test(start_paused = true)]
async fn terminal_program_sampler_one_batch_and_shutdown_with_work_pending() {
    let registry = registry();
    let session = test_session_with_ring(4096);
    register(&registry, &session);
    let source = Source::new(&registry, &session);
    let release = block_next(&source);
    let mut reads = source.reads.subscribe();
    let (stop, stop_rx) = watch::channel(false);
    let task = tokio::spawn(registry.clone().run_program_sampler(
        stop_rx,
        source.clone(),
        Duration::from_millis(500),
    ));
    reads.wait_for(|&count| count == 1).await.unwrap();
    for _ in 0..20 {
        title(&session, "flood", 10);
        tokio::time::advance(Duration::from_millis(150)).await;
    }
    assert_eq!(
        *source.reads.borrow(),
        1,
        "a slow lookup must not overlap another batch"
    );
    stop.send_replace(true);
    task.await.unwrap();
    assert_eq!(
        reading(&session).command,
        None,
        "shutdown must not apply pending names"
    );
    drop(release);
}

#[tokio::test(start_paused = true)]
async fn terminal_program_sampler_stopped_before_start_does_no_work() {
    let registry = registry();
    let session = test_session_with_ring(4096);
    register(&registry, &session);
    let source = Source::new(&registry, &session);
    let (_stop, rx) = watch::channel(true);
    registry
        .run_program_sampler(rx, source.clone(), Duration::from_millis(500))
        .await;
    assert_eq!(*source.reads.borrow(), 0);
}

#[tokio::test(start_paused = true)]
async fn terminal_program_sampler_output_wakes_coalesced_refresh() {
    let registry = registry();
    let session = test_session_with_ring(4096);
    register(&registry, &session);
    let source = Source::new(&registry, &session);
    let mut program = session.output.lock().unwrap().program_tx.subscribe();
    let mut reads = source.reads.subscribe();
    let (stop, rx) = watch::channel(false);
    let start = Instant::now();
    let task = tokio::spawn(registry.clone().run_program_sampler(
        rx,
        source.clone(),
        Duration::from_millis(500),
    ));
    program.changed().await.unwrap();
    let release = block_next(&source);
    for _ in 0..149 {
        title(&session, "flood", 10);
        tokio::time::advance(Duration::from_millis(1)).await;
    }
    assert_eq!(*source.reads.borrow(), 1);
    tokio::time::advance(Duration::from_millis(1)).await;
    reads.wait_for(|&count| count == 2).await.unwrap();
    assert_eq!(
        Instant::now() - start,
        REFRESH_INTERVAL,
        "output wakes the sampler before its periodic tick"
    );
    stop.send_replace(true);
    task.await.unwrap();
    drop(release);
}

#[tokio::test(start_paused = true)]
async fn terminal_program_sampler_runtime_ticks_include_quiet_sessions() {
    for millis in [500, 1_000] {
        let registry = registry();
        let session = test_session_with_ring(4096);
        register(&registry, &session);
        let source = Source::new(&registry, &session);
        let mut program = session.output.lock().unwrap().program_tx.subscribe();
        let (stop, rx) = watch::channel(false);
        let task = tokio::spawn(registry.clone().run_program_sampler(
            rx,
            source.clone(),
            Duration::from_millis(millis),
        ));
        program.changed().await.unwrap();
        assert_eq!(
            program.borrow_and_update().command.as_deref(),
            Some("shell")
        );
        source.change(20, "sleep");
        tokio::time::advance(Duration::from_millis(millis - 1)).await;
        tokio::task::yield_now().await;
        assert_eq!(*source.reads.borrow(), 1);
        tokio::time::advance(Duration::from_millis(1)).await;
        program.changed().await.unwrap();
        // The ownership change is published before the name read returns.
        while program.borrow_and_update().command.is_none() {
            program.changed().await.unwrap();
        }
        assert_eq!(program.borrow().command.as_deref(), Some("sleep"));
        assert_eq!(*source.reads.borrow(), 2);
        stop.send_replace(true);
        task.await.unwrap();
    }
}

#[cfg(target_os = "linux")]
#[test]
fn terminal_program_process_procfs_lookup_of_held_child() {
    let mut child = std::process::Command::new("sleep")
        .arg("30")
        .spawn()
        .unwrap();
    let names = process_names(&[child.id(), u32::MAX]);
    let killed = child.kill();
    let waited = child.wait();
    killed.unwrap();
    waited.unwrap();
    assert_eq!(names.get(&child.id()).map(String::as_str), Some("sleep"));
    assert!(!names.contains_key(&u32::MAX));
    let names = process_names(&[std::process::id()]);
    let executable = std::env::current_exe().unwrap();
    let expected = executable.file_name().unwrap().to_string_lossy();
    let actual = &names[&std::process::id()];
    assert!(!actual.is_empty());
    assert!(
        expected.starts_with(actual.as_str()),
        "kernel truncation: {actual:?}, {expected:?}"
    );
}

#[cfg(target_os = "linux")]
fn shell() -> (Arc<Registry>, AttachHandle) {
    let registry = registry();
    registry.set_default_program(Some(TenantProgram::Exec(
        ["/bin/bash", "--noprofile", "--norc", "-i"]
            .into_iter()
            .map(OsString::from)
            .collect(),
    )));
    let handle = registry
        .create(CreateOptions {
            env: BTreeMap::from([
                ("PS1".into(), "PROMPT_READY> ".into()),
                ("PROMPT_COMMAND".into(), String::new()),
            ]),
            size: PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            },
            tab_name: None,
            tab_group: None,
            window_id: None,
            mcp_env: false,
            cwd: None,
            command: None,
            profile: None,
        })
        .unwrap();
    (registry, handle)
}

#[cfg(target_os = "linux")]
async fn output_until(handle: &mut AttachHandle, marker: &[u8]) {
    let mut bytes = handle.replay.concat();
    tokio::time::timeout(Duration::from_secs(10), async {
        while !bytes.windows(marker.len()).any(|part| part == marker) {
            match handle.rx.recv().await.unwrap() {
                SessionEvent::Output(chunk) => bytes.extend(chunk),
                SessionEvent::Exit(exit) => panic!("shell exited before marker: {exit:?}"),
                _ => {}
            }
        }
    })
    .await
    .expect("shell output barrier");
    handle.replay.clear();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn terminal_program_process_raw_foreground_includes_shell_and_prompt_title() {
    let (registry, mut attached) = shell();
    output_until(&mut attached, b"PROMPT_READY> ").await;
    let session = attached.session.clone();
    assert_eq!(
        session.raw_foreground_group(),
        session.child_pid,
        "raw helper includes the shell"
    );
    assert!(session.child_pid.is_some());
    assert_eq!(
        session.foreground_program_group(),
        None,
        "status keeps its shell exclusion"
    );
    // Observe the shell after exec before testing the lifetime of its next title.
    let samples = read_batch(vec![session.clone()], true, &PlatformSource);
    registry.apply_program_samples(samples, &PlatformSource);
    assert_eq!(reading(&session).command.as_deref(), Some("bash"));
    attached.send_input(b"printf '\\033]2;shell-title\\007'; printf 'TITLE_%s\\n' DONE\n");
    output_until(&mut attached, b"TITLE_DONE").await;
    let samples = read_batch(vec![session.clone()], true, &PlatformSource);
    registry.apply_program_samples(samples, &PlatformSource);
    assert_eq!(reading(&session).title.as_deref(), Some("shell-title"));
    assert_eq!(reading(&session).command.as_deref(), Some("bash"));
    registry.close_all(CloseReason::Shutdown);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn terminal_program_process_job_exit_observed_on_next_sample() {
    let (registry, mut attached) = shell();
    output_until(&mut attached, b"PROMPT_READY> ").await;
    let session = attached.session.clone();
    attached.send_input(b"sh -c 'printf \"\\033]2;held-job\\007\"; exec sleep 30'\n");
    output_until(&mut attached, b"\x1b]2;held-job\x07").await;
    // The child writes before exec; read /proc until exec is observed, not for a fixed delay.
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let samples = read_batch(vec![session.clone()], true, &PlatformSource);
            registry.apply_program_samples(samples, &PlatformSource);
            if reading(&session).command.as_deref() == Some("sleep") {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    // A title emitted before an observed exec may legitimately expire. Admit the
    // held job's title after that observation so this check isolates job exit.
    session.record_plain_output(b"\x1b]2;held-job\x07");
    assert_eq!(reading(&session).title.as_deref(), Some("held-job"));
    attached.send_input(b"\x03");
    output_until(&mut attached, b"PROMPT_READY> ").await;
    let samples = read_batch(vec![session.clone()], true, &PlatformSource);
    registry.apply_program_samples(samples, &PlatformSource);
    assert_eq!(
        reading(&session),
        ProgramReading {
            title: None,
            command: Some("bash".into())
        }
    );
    registry.close_all(CloseReason::Shutdown);
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "freebsd"))]
#[test]
fn terminal_program_platform_name_only_current_process() {
    let pid = std::process::id();
    let names = process_names_from_table(&[pid, u32::MAX]);
    let executable = std::env::current_exe().unwrap();
    let expected = executable.file_name().unwrap().to_string_lossy();
    let name = names.get(&pid).unwrap();
    assert!(!name.is_empty());
    assert!(
        expected.starts_with(name.as_str()),
        "kernel may truncate the executable name: {name:?}, {expected:?}"
    );
    assert!(!names.contains_key(&u32::MAX));
}
