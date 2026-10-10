use super::*;
use rustix::process::{Pid, Signal};
use std::io;
use std::time::Instant;

struct JobShell {
    registry: Arc<Registry>,
    client: AttachHandle,
    _shutdown: watch::Sender<bool>,
    drainer: JoinHandle<()>,
}

impl JobShell {
    async fn new() -> Self {
        let registry = Arc::new(Registry::new(test_config(65536, 4, 60)));
        let mut opts = opts_with_window("status-job-control");
        opts.command = Some("exec bash --noprofile --norc -i".into());
        opts.env.insert("PS1".into(), "STATUS_PROMPT>".into());
        opts.env.insert("PROMPT_COMMAND".into(), "".into());
        let client = registry.create(opts).unwrap();
        let (shutdown, rx) = watch::channel(false);
        let drainer = registry.clone().spawn_drainer(rx);
        let mut this = Self {
            registry,
            client,
            _shutdown: shutdown,
            drainer,
        };
        this.command(
            "stty -echo; PS1='STATUS_PROMPT>'; PROMPT_COMMAND=; printf 'SHELL_<%s>' READY",
            "SHELL_<READY>",
        )
        .await;
        this
    }

    async fn marker(&mut self, marker: &str) {
        let output = collect_until(&mut self.client, marker, Duration::from_secs(5)).await;
        assert!(output.contains(marker), "missing {marker:?}: {output:?}");
    }

    async fn command(&mut self, command: &str, marker: &str) {
        self.client.send_input(format!("{command}\n").as_bytes());
        self.marker(marker).await;
    }

    fn snapshot(&self) -> ProgramStatusSnapshot {
        self.client.program_status().borrow().as_ref().clone()
    }

    async fn start_job(&mut self, id: &str) -> Pid {
        let command = format!("bash -c 'printf \"\\033]7501;state=working:id={id}/working\\007\\033]7501;state=blocked:id={id}/blocked\\007\\033]7501;state=idle:id={id}/idle\\007\\033]7501;state=done:id={id}/done\\007READY_<{id}>\"; read -r answer'; printf 'REAPED_<{id}>'");
        self.command(&command, &format!("READY_<{id}>")).await;
        let group = self
            .client
            .session
            .foreground_program_group()
            .expect("job owns foreground");
        Pid::from_raw(group.try_into().unwrap()).unwrap()
    }

    async fn wait_records(&self, expected: &[&str]) {
        let mut status = self.client.program_status();
        let observed = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let ids = status
                    .borrow_and_update()
                    .records
                    .iter()
                    .map(|r| r.id.clone().unwrap())
                    .collect::<Vec<_>>();
                if ids.iter().map(String::as_str).eq(expected.iter().copied()) {
                    break;
                }
                status.changed().await.unwrap();
            }
        })
        .await;
        assert!(
            observed.is_ok(),
            "record lifetime within one second: expected {expected:?}, got {:?}",
            self.snapshot()
        );
    }
}

impl Drop for JobShell {
    fn drop(&mut self) {
        self.drainer.abort();
        self.registry.close_all(CloseReason::Shutdown);
    }
}

#[tokio::test]
async fn control_reports_use_foreground_group_at_arrival() {
    let mut shell = JobShell::new().await;
    let group = shell.start_job("control-owner").await;
    shell
        .registry
        .submit_program_status(shell.client.id(), b"state=working:id=control-transient")
        .unwrap();
    shell
        .registry
        .submit_program_status(shell.client.id(), b"state=done:id=control-result")
        .unwrap();
    let tags = shell
        .client
        .session
        .output
        .lock()
        .unwrap()
        .status
        .tagged_records();
    let transient_order = shell
        .snapshot()
        .records
        .iter()
        .find(|r| r.id.as_deref() == Some("control-transient"))
        .unwrap()
        .update_order;
    assert!(
        tags.contains(&(transient_order, group.as_raw_nonzero().get() as u32)),
        "control report was not attributed to the foreground job"
    );
    rustix::process::kill_process_group(group, Signal::KILL).unwrap();
    shell.marker("REAPED_<control-owner>").await;
    shell
        .wait_records(&["control-owner/done", "control-result"])
        .await;
}

#[tokio::test]
async fn status_job_sigkill_interrupt_and_silent_exit_drop_transients() {
    for end in ["kill", "interrupt", "silent"] {
        let mut shell = JobShell::new().await;
        let group = shell.start_job(end).await;
        assert_eq!(shell.snapshot().records.len(), 4);
        match end {
            "kill" => rustix::process::kill_process_group(group, Signal::KILL).unwrap(),
            "interrupt" => {
                shell.client.send_input(b"\x03");
                shell.marker("STATUS_PROMPT>").await;
                shell.client.send_input(b"printf 'REAPED_<interrupt>'\n");
            }
            _ => shell.client.send_input(b"finish\n"),
        }
        shell.marker(&format!("REAPED_<{end}>")).await;
        assert_eq!(
            rustix::process::test_kill_process_group(group),
            Err(rustix::io::Errno::SRCH),
            "shell reaped the job"
        );
        shell.wait_records(&[&format!("{end}/done")]).await;
    }
}

#[tokio::test]
async fn status_stopped_job_and_second_group_have_independent_records() {
    let mut shell = JobShell::new().await;
    shell.drainer.abort();
    let first = shell.start_job("first").await;
    shell.client.send_input(b"\x1a");
    shell.marker("REAPED_<first>").await;
    shell
        .command(
            "jobs -s; printf 'STOPPED_<%s>' OBSERVED",
            "STOPPED_<OBSERVED>",
        )
        .await;
    shell.registry.drain_writes();
    assert_eq!(
        shell.snapshot().records.len(),
        4,
        "stopped group still owns its records"
    );
    let second = shell.start_job("second").await;
    assert_ne!(first, second);
    rustix::process::kill_process_group(second, Signal::KILL).unwrap();
    shell.marker("REAPED_<second>").await;
    shell.registry.drain_writes();
    shell
        .wait_records(&[
            "first/working",
            "first/blocked",
            "first/idle",
            "first/done",
            "second/done",
        ])
        .await;
    rustix::process::kill_process_group(first, Signal::KILL).unwrap();
    shell
        .command("wait %1; printf 'FIRST_<%s>' REAPED", "FIRST_<REAPED>")
        .await;
    shell.registry.drain_writes();
    shell.wait_records(&["first/done", "second/done"]).await;
}

#[tokio::test]
async fn status_shell_and_background_at_prompt_are_untagged() {
    let mut shell = JobShell::new().await;
    shell.command("printf '\\033]7501;state=working:id=shell\\007SHELL_REPORT'; (printf '\\033]7501;state=blocked:id=background\\007BG_REPORT') & wait; printf 'BG_<%s>' REAPED", "BG_<REAPED>").await;
    assert_eq!(shell.snapshot().records.len(), 2);
    assert!(
        shell
            .client
            .session
            .output
            .lock()
            .unwrap()
            .status
            .tagged_records()
            .is_empty(),
        "shell foreground reports carry no job tag"
    );
    shell.registry.drain_writes();
    assert_eq!(
        shell.snapshot().records.len(),
        2,
        "shell and background-at-prompt reports stay"
    );
}

#[tokio::test]
async fn status_background_report_inherits_another_jobs_foreground_limit() {
    let mut shell = JobShell::new().await;
    let dir = tempfile::tempdir().unwrap();
    let fifo = dir.path().join("release");
    let command = format!("mkfifo '{}'; (read -r token < '{}'; printf '\\033]7501;state=working:id=background\\007BG_<REPORT>') & printf 'BG_<WAITING>'", fifo.display(), fifo.display());
    shell.command(&command, "BG_<WAITING>").await;
    let group = shell.start_job("foreground").await;
    std::fs::write(&fifo, b"go\n").unwrap();
    shell.marker("BG_<REPORT>").await;
    assert_eq!(
        shell.snapshot().records.last().unwrap().id.as_deref(),
        Some("background")
    );
    rustix::process::kill_process_group(group, Signal::KILL).unwrap();
    shell.marker("REAPED_<foreground>").await;
    shell.wait_records(&["foreground/done"]).await;
}

#[tokio::test]
async fn status_group_outliving_inner_job_is_a_constructed_ssh_standin() {
    let mut shell = JobShell::new().await;
    shell.drainer.abort();
    let dir = tempfile::tempdir().unwrap();
    let inner = dir.path().join("inner.sh");
    std::fs::write(&inner, r"printf '\033]7501;state=working:id=inner\007'").unwrap();
    let command = format!("bash -c 'bash \"{}\"; printf \"INNER_<EXITED>\"; read -r keep_group'; printf 'GROUP_<EXITED>'", inner.display());
    shell.command(&command, "INNER_<EXITED>").await;
    assert_eq!(shell.snapshot().records.len(), 1);
    shell.registry.drain_writes();
    assert_eq!(
        shell.snapshot().records.len(),
        1,
        "outer group outlives the inner job; no ssh measurement claimed"
    );
    shell.client.send_input(b"done\n");
    shell.marker("GROUP_<EXITED>").await;
    shell.registry.drain_writes();
    shell.wait_records(&[]).await;
}

#[tokio::test]
async fn status_group_probe_cannot_remove_a_replacement_report() {
    let mut shell = JobShell::new().await;
    shell.drainer.abort();
    let group = shell.start_job("replace").await;
    rustix::process::kill_process_group(group, Signal::KILL).unwrap();
    shell.marker("REAPED_<replace>").await;
    let registry = shell.registry.clone();
    let id = shell.client.id().to_owned();
    let inject_id = id.clone();
    arm_attach_seam(&id, AttachSeam::ProgramGroupsBeforeRemoval, move || {
        assert!(registry.inject_output(
            &inject_id,
            b"\x1b]7501;state=working:id=replace/working\x07"
        ));
    });
    shell.registry.drain_writes();
    assert_eq!(
        shell
            .snapshot()
            .records
            .iter()
            .map(|r| r.id.as_deref().unwrap())
            .collect::<Vec<_>>(),
        ["replace/done", "replace/working"],
        "remove only the inspected update order"
    );
}

#[test]
fn status_read_failure_uses_the_shared_finalizer_without_self_wait() {
    struct FailedReader;
    impl Read for FailedReader {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("constructed read failure"))
        }
    }
    for imported in [false, true] {
        let rig = Rig::new();
        rig.report("state=working");
        rig.report("state=error:id=kept");
        let before = rig.snapshot();
        let mut events = rig.session.output_tx.subscribe();
        let (wait_tx, wait_rx) = std::sync::mpsc::channel();
        arm_attach_seam(
            &rig.session.id,
            AttachSeam::ExitWaitingForReader,
            move || {
                wait_tx.send(()).unwrap();
            },
        );
        let running = ReaderRunning::start(&rig.session);
        rig.session.read_output(
            &mut FailedReader,
            running,
            imported,
            &Arc::new(Mutex::new(None)),
        );
        assert_eq!(
            rig.snapshot().records,
            before.records[1..],
            "read failure retains only completion"
        );
        assert!(
            wait_rx.try_recv().is_err(),
            "reader releases its running guard before finalizing"
        );
        assert!(matches!(events.try_recv(), Ok(SessionEvent::Error(_))));
        assert!(matches!(events.try_recv(), Ok(SessionEvent::Exit(_))));
    }
}

#[tokio::test]
async fn status_fresh_exit_waits_for_a_report_already_read() {
    let mut shell = JobShell::new().await;
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    arm_attach_seam(
        shell.client.id(),
        AttachSeam::ReaderBeforeRecord,
        move || {
            entered_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        },
    );
    let release_wait = release_tx.clone();
    arm_attach_seam(
        shell.client.id(),
        AttachSeam::ExitWaitingForReader,
        move || {
            release_wait.send(()).unwrap();
        },
    );
    shell.client.send_input(
        b"printf '\\033]7501;state=working:id=discard\\007\\033]7501;state=blocked:id=blocked\\007\\033]7501;state=idle:id=idle\\007\\033]7501;state=done\\007\\033]7501;state=error:id=error\\007'; exit 7\n",
    );
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let exit = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let SessionEvent::Exit(exit) = shell.client.rx.recv().await.unwrap() {
                break exit;
            }
        }
    })
    .await
    .unwrap();
    let snapshot = shell.snapshot();
    let _ = release_tx.send(());
    assert_eq!(
        snapshot.records.iter().map(|r| r.state).collect::<Vec<_>>(),
        [ProgramState::Done, ProgramState::Error],
        "last done is retained before the exit event"
    );
    assert_eq!(exit, TerminalExit::Code { code: 7 });
}

#[test]
fn status_exit_bounds_a_reader_held_by_a_descendant() {
    let rig = Rig::new();
    rig.report("state=working");
    let running = ReaderRunning::start(&rig.session);
    let start = Instant::now();
    rig.session
        .record_terminal_exit(TerminalExit::Unknown, &Arc::new(Mutex::new(None)));
    let elapsed = start.elapsed();
    assert!(
        elapsed < Duration::from_secs(2),
        "descendant-held reader must not hold exit indefinitely"
    );
    assert!(
        rig.snapshot().records.is_empty(),
        "bounded finalization drops transient state"
    );
    rig.report("state=done");
    assert!(
        rig.snapshot().records.is_empty(),
        "report beyond the drain bound stays outside final status"
    );
    drop(running);
}

fn import_status_pty(master_fd: OwnedFd, child_pid: Option<u32>) -> (Registry, Arc<Session>) {
    let meta = FdStoreSessionMeta {
        tenant_prefix: "/w".into(),
        session_id: random_session_id(),
        tab_name: None,
        tab_group: None,
        spawn_name: None,
        spawn_group: None,
        window_id: None,
        pane_id: None,
        side: None,
        tab_id: None,
        cwd: None,
        command: None,
        env: BTreeMap::new(),
        profile: None,
        mcp_env: false,
        child_pid,
        size: test_size().into(),
        seq: 0,
        generation: 1,
        alt_screen: false,
        private_modes: Vec::new(),
        program_status: None,
    };
    let child_identity = RecordedChildIdentity {
        boot_id: current_boot_id(),
        start_time: child_pid.and_then(process_start_time),
    };
    let registry = Registry::new(test_config(65536, 4, 60));
    let session = Session::from_imported(
        test_config(65536, 4, 60),
        FdStoreSessionImport {
            meta,
            child_identity,
            master_fd,
            ring_fd: None,
            replay: Vec::new(),
            sealed_manifest: true,
        },
        Arc::new(Mutex::new(None)),
        Arc::new(ReaderWake::new()),
        || 2,
    )
    .unwrap();
    register_session(&registry, &session);
    (registry, session)
}

async fn status_exit_event(client: &mut AttachHandle) -> TerminalExit {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let SessionEvent::Exit(exit) = client.rx.recv().await.unwrap() {
                break exit;
            }
        }
    })
    .await
    .expect("exit arrives within its reader bound")
}

#[tokio::test]
async fn status_restored_eof_keeps_last_completion() {
    let (pair, mut slave) = raw_query_pty();
    let master = clone_master_fd(pair.master.as_raw_fd().unwrap()).unwrap();
    let (registry, session) = import_status_pty(master, None);
    let mut client = session.clone().attach(None);
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    arm_attach_seam(&session.id, AttachSeam::ReaderBeforeRecord, move || {
        entered_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    });
    slave
        .write_all(b"\x1b]7501;state=working\x07\x1b]7501;state=done:id=last\x07")
        .unwrap();
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    drop(slave);
    drop(pair.slave);
    release_tx.send(()).unwrap();
    let exit = status_exit_event(&mut client).await;
    let snapshot = client.program_status().borrow().clone();
    registry.close_all(CloseReason::Shutdown);
    assert_eq!(exit, TerminalExit::Unknown);
    assert_eq!(
        snapshot.records.iter().map(|r| r.state).collect::<Vec<_>>(),
        [ProgramState::Done],
        "restored EOF finalizes after recording its last read"
    );
}

#[tokio::test]
async fn status_restored_child_exit_bounds_a_real_descendant_and_rejects_late_report() {
    let dir = tempfile::tempdir().unwrap();
    let fifo = dir.path().join("release");
    let (pair, slave) = raw_query_pty();
    let mut cmd = portable_pty::CommandBuilder::new("/bin/bash");
    cmd.arg("-c");
    cmd.arg(format!("trap '' HUP; mkfifo '{}'; bash -c 'trap \"\" HUP; printf \"DESCENDANT_<READY>\"; read -r token < \"{}\"; printf \"\\033]7501;state=error:id=late\\007DESCENDANT_<DONE>\"' & printf '\\033]7501;state=working\\007\\033]7501;state=done:id=parent\\007'; read -r exit_now; exit 0", fifo.display(), fifo.display()));
    let mut child = pair.slave.spawn_command(cmd).unwrap();
    let pin = rustix::process::pidfd_open(
        Pid::from_raw(child.process_id().unwrap().try_into().unwrap()).unwrap(),
        rustix::process::PidfdFlags::empty(),
    )
    .unwrap();
    let master = clone_master_fd(pair.master.as_raw_fd().unwrap()).unwrap();
    let mut writer = pair.master.take_writer().unwrap();
    let (registry, session) = import_status_pty(master, child.process_id());
    let mut client = session.clone().attach(None);
    let output = collect_until(&mut client, "DESCENDANT_<READY>", Duration::from_secs(5)).await;
    assert!(output.contains("DESCENDANT_<READY>"));
    // The test closes its slave copies: only the real child/descendant can
    // keep the reader alive now.
    drop(slave);
    drop(pair.slave);
    writer.write_all(b"exit\n").unwrap();
    assert!(
        imported_child_exited_within(&pin, Duration::from_secs(5)),
        "child exits within the fixture bound"
    );
    assert!(
        child.wait().unwrap().success(),
        "the recorded child has exited"
    );
    let exit = status_exit_event(&mut client).await;
    let final_status = client.program_status().borrow().as_ref().clone();
    assert_eq!(exit, TerminalExit::Unknown);
    assert!(
        session.reader_stop.lock().running,
        "descendant still keeps the PTY reader open"
    );
    std::fs::write(&fifo, b"release\n").unwrap();
    let output = collect_until(&mut client, "DESCENDANT_<DONE>", Duration::from_secs(5)).await;
    registry.close_all(CloseReason::Shutdown);
    assert_eq!(
        final_status
            .records
            .iter()
            .map(|r| r.state)
            .collect::<Vec<_>>(),
        [ProgramState::Done],
        "pinned child exit finalizes despite a live descendant"
    );
    assert!(
        output.contains("DESCENDANT_<DONE>"),
        "late bytes continue through the ring"
    );
    assert_eq!(
        client.program_status().borrow().as_ref(),
        &final_status,
        "late descendant report cannot alter final status"
    );
}

#[tokio::test]
async fn status_group_probe_requires_no_such_process() {
    let mut shell = JobShell::new().await;
    let group = shell.start_job("permission").await;
    assert!(shell.registry.inject_output(
        shell.client.id(),
        b"\x1b]7501;state=error:id=kept-error\x07"
    ));
    let before = shell.snapshot();
    for result in [
        Ok(()),
        Err(rustix::io::Errno::PERM),
        Err(rustix::io::Errno::INTR),
    ] {
        let mut probes = 0;
        shell.client.session.prune_program_groups_with(|observed| {
            assert_eq!(observed, group);
            probes += 1;
            result
        });
        assert_eq!(probes, 3, "only the three transient records are tagged");
        assert_eq!(
            shell.snapshot(),
            before,
            "only no-such-process removes a record: {result:?}"
        );
    }
    shell
        .client
        .session
        .prune_program_groups_with(|_| Err(rustix::io::Errno::SRCH));
    assert_eq!(
        shell.snapshot().records,
        before.records[3..],
        "ESRCH positive control removes the tagged records"
    );
}
