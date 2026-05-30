//! Long-lived PTY session registry.
//!
//! A terminal WebSocket is only an attachment. The PTY, child process,
//! replay ring, and lifecycle policy live here so browser reloads can
//! detach and reattach without killing the shell.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use rand::RngCore;
use serde::Serialize;
use tokio::sync::{broadcast, watch};
use tokio::task::JoinHandle;

use chan_llm::team_work::TeamWorkIdentity;

use crate::config::TerminalConfig;
use crate::signal::now_unix_secs;

#[cfg(target_os = "macos")]
use std::process::Command;

const BROADCAST_CAP: usize = 1024;
const ALT_SCREEN_ENTER: &[u8] = b"\x1b[?1049h";
const ALT_SCREEN_EXIT: &[u8] = b"\x1b[?1049l";
const ALT_SCREEN_TAIL_BYTES: usize = ALT_SCREEN_ENTER.len() - 1;
const REDRAW_WOBBLE_DELAY: Duration = Duration::from_millis(50);
const TERMINAL_FD_HEADROOM: u64 = 32;
const TERMINAL_SESSION_FD_ESTIMATE: u64 = 8;

pub const ALT_SCREEN_ATTACH_PRELUDE: &[u8] = b"\x1b[?1049h\x1b[2J\x1b[H";

#[derive(Debug, Clone)]
pub struct RegistryConfig {
    pub workspace_root: PathBuf,
    pub mcp_socket_path: Option<PathBuf>,
    pub control_socket_path: Option<PathBuf>,
    pub terminal: TerminalConfig,
}

#[derive(Debug)]
pub struct Registry {
    config: RegistryConfig,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

#[derive(Debug, Clone)]
pub struct CreateOptions {
    pub size: PtySize,
    pub tab_name: Option<String>,
    pub window_id: Option<String>,
    pub mcp_env: bool,
    pub cwd: Option<PathBuf>,
    pub command: Option<String>,
    pub env: BTreeMap<String, String>,
}

#[derive(Debug)]
pub enum CreateError {
    Capped,
    FdPressure(FdPressure),
    Spawn(anyhow::Error),
}

impl std::fmt::Display for CreateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CreateError::Capped => f.write_str("terminal session cap reached"),
            CreateError::FdPressure(pressure) => write!(f, "{pressure}"),
            CreateError::Spawn(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for CreateError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FdPressure {
    pub open: u64,
    pub limit: u64,
    pub required: u64,
}

impl std::fmt::Display for FdPressure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "too many open files to start terminal: {}/{} open, need {} fd headroom",
            self.open, self.limit, self.required
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseReason {
    Idle,
    Workspace,
    Shutdown,
    Explicit,
    Capped,
}

impl CloseReason {
    pub fn as_str(self) -> &'static str {
        match self {
            CloseReason::Idle => "idle",
            CloseReason::Workspace => "workspace",
            CloseReason::Shutdown => "shutdown",
            CloseReason::Explicit => "explicit",
            CloseReason::Capped => "capped",
        }
    }
}

#[derive(Debug, Clone)]
pub enum SessionEvent {
    Output(Vec<u8>),
    Activity { bytes_since_focus: u64 },
    Resize(PtySize),
    Exit(u32),
    Error(String),
    Closed(CloseReason),
}

#[derive(Debug)]
pub struct AttachHandle {
    id: String,
    session: Arc<Session>,
    pub rx: broadcast::Receiver<SessionEvent>,
    pub replay: Vec<Vec<u8>>,
    pub seq: u64,
    pub missed_bytes: u64,
    pub alt_screen: bool,
}

impl AttachHandle {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn send_input(&self, data: &[u8]) {
        self.session.send_input(data);
    }

    pub fn resize(&self, size: PtySize) {
        self.session.resize(size);
    }

    pub fn set_focused(&self, focused: bool) {
        self.session.set_focused(focused);
    }

    pub fn bytes_since_focus(&self) -> u64 {
        self.session.bytes_since_focus()
    }

    pub fn request_redraw(&self) {
        self.session.request_redraw();
    }

    pub fn cwd(&self) -> Option<PathBuf> {
        self.session.cwd()
    }
}

impl Drop for AttachHandle {
    fn drop(&mut self) {
        self.session.attach_count.fetch_sub(1, Ordering::Relaxed);
    }
}

impl Registry {
    pub fn new(config: RegistryConfig) -> Self {
        Self {
            config,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn create(&self, opts: CreateOptions) -> Result<AttachHandle, CreateError> {
        let mut sessions = self.sessions.lock().expect("terminal registry poisoned");
        if sessions.len() >= self.config.terminal.session_cap {
            return Err(CreateError::Capped);
        }
        reject_terminal_spawn_if_fd_pressure()?;
        let id = self.unused_id(&sessions);
        let session =
            Session::spawn(id.clone(), self.config.clone(), opts).map_err(CreateError::Spawn)?;
        sessions.insert(id.clone(), session.clone());
        Ok(session.attach(Some(0)))
    }

    pub fn restart(
        &self,
        id: &str,
        tab_name: Option<String>,
        window_id: Option<String>,
        command: Option<String>,
        env: Option<BTreeMap<String, String>>,
    ) -> Result<bool, CreateError> {
        let old = self
            .sessions
            .lock()
            .expect("terminal registry poisoned")
            .get(id)
            .cloned();
        let Some(old) = old else {
            return Ok(false);
        };
        if old.closed.load(Ordering::Relaxed) {
            return Ok(false);
        }
        reject_terminal_spawn_if_fd_pressure()?;
        let mut opts = old.restart_options();
        if tab_name.is_some() {
            opts.tab_name = tab_name;
        }
        if window_id.is_some() {
            opts.window_id = window_id;
        }
        // `fullstack-a-79` slice 5 follow-up: the team-bootstrap
        // orchestrator overrides command + env to flip the host's
        // pre-existing PTY into the lead's session (e.g. host's
        // shell -> lead's `claude` command). When None, restart
        // preserves the original spawn command/env.
        if let Some(cmd) = command {
            opts.command = Some(cmd);
        }
        if let Some(extra_env) = env {
            opts.env.extend(extra_env);
        }
        let session = Session::spawn(id.to_string(), self.config.clone(), opts)
            .map_err(CreateError::Spawn)?;
        let mut sessions = self.sessions.lock().expect("terminal registry poisoned");
        match sessions.get(id) {
            Some(current) if Arc::ptr_eq(current, &old) => {
                sessions.insert(id.to_string(), session);
                drop(sessions);
                old.close(CloseReason::Explicit);
                Ok(true)
            }
            Some(_) => Ok(false),
            None => Ok(false),
        }
    }

    #[cfg(test)]
    pub fn attach(&self, id: &str, since: Option<u64>) -> Option<AttachHandle> {
        self.attach_for_ws(id, since)
    }

    pub fn attach_for_ws(&self, id: &str, since: Option<u64>) -> Option<AttachHandle> {
        let session = self
            .sessions
            .lock()
            .expect("terminal registry poisoned")
            .get(id)
            .cloned()?;
        if session.closed.load(Ordering::Relaxed) {
            return None;
        }
        Some(session.attach(since))
    }

    #[cfg(test)]
    pub fn get_or_create(
        &self,
        id: Option<&str>,
        since: Option<u64>,
        opts: CreateOptions,
    ) -> Result<AttachHandle, CreateError> {
        self.get_or_create_for_ws(id, since, opts)
    }

    pub fn get_or_create_for_ws(
        &self,
        id: Option<&str>,
        since: Option<u64>,
        opts: CreateOptions,
    ) -> Result<AttachHandle, CreateError> {
        if let Some(id) = id {
            if let Some(handle) = self.attach_for_ws(id, since) {
                return Ok(handle);
            }
        }
        self.create(opts)
    }

    pub fn close(&self, id: &str, reason: CloseReason) -> bool {
        let session = self
            .sessions
            .lock()
            .expect("terminal registry poisoned")
            .remove(id);
        if let Some(session) = session {
            session.close(reason);
            true
        } else {
            false
        }
    }

    pub fn remove(&self, id: &str) -> bool {
        self.sessions
            .lock()
            .expect("terminal registry poisoned")
            .remove(id)
            .is_some()
    }

    pub fn close_all(&self, reason: CloseReason) {
        let sessions: Vec<Arc<Session>> = self
            .sessions
            .lock()
            .expect("terminal registry poisoned")
            .drain()
            .map(|(_, session)| session)
            .collect();
        for session in sessions {
            session.close(reason);
        }
    }

    pub fn poke_team_work_agent(&self, team: &str, agent: &str) -> usize {
        let Ok(target) = TeamWorkIdentity::validated(team, agent) else {
            return 0;
        };
        let sessions: Vec<Arc<Session>> = self
            .sessions
            .lock()
            .expect("terminal registry poisoned")
            .values()
            .cloned()
            .collect();
        let mut count = 0;
        for session in sessions {
            if session.closed.load(Ordering::Relaxed) {
                continue;
            }
            if session.team_work_identity.as_ref() == Some(&target) {
                session.send_input(b"poke\n");
                count += 1;
            }
        }
        count
    }

    pub fn prune_idle(&self) -> usize {
        self.prune_idle_at(now_unix_secs() as i64)
    }

    pub fn prune_idle_at(&self, now: i64) -> usize {
        let idle_timeout = self.config.terminal.idle_timeout_secs as i64;
        let to_close: Vec<String> = {
            let sessions = self.sessions.lock().expect("terminal registry poisoned");
            sessions
                .iter()
                .filter_map(|(id, session)| {
                    let attached = session.attach_count.load(Ordering::Relaxed);
                    let last = session.last_activity.load(Ordering::Relaxed);
                    if attached == 0 && now.saturating_sub(last) > idle_timeout {
                        Some(id.clone())
                    } else {
                        None
                    }
                })
                .collect()
        };
        let n = to_close.len();
        for id in to_close {
            self.close(&id, CloseReason::Idle);
        }
        n
    }

    pub fn spawn_pruner(self: Arc<Self>, mut shutdown_rx: watch::Receiver<bool>) -> JoinHandle<()> {
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(60));
            loop {
                tokio::select! {
                    _ = shutdown_rx.changed() => {
                        self.close_all(CloseReason::Shutdown);
                        break;
                    }
                    _ = tick.tick() => {
                        self.prune_idle();
                    }
                }
            }
        })
    }

    fn unused_id(&self, sessions: &HashMap<String, Arc<Session>>) -> String {
        loop {
            let id = random_session_id();
            if !sessions.contains_key(&id) {
                return id;
            }
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.sessions
            .lock()
            .expect("terminal registry poisoned")
            .len()
    }
}

fn reject_terminal_spawn_if_fd_pressure() -> Result<(), CreateError> {
    let Some((open, limit)) = fd_snapshot() else {
        return Ok(());
    };
    if fd_headroom_allows(open, limit, TERMINAL_SESSION_FD_ESTIMATE) {
        return Ok(());
    }
    Err(CreateError::FdPressure(FdPressure {
        open,
        limit,
        required: TERMINAL_SESSION_FD_ESTIMATE + TERMINAL_FD_HEADROOM,
    }))
}

fn fd_headroom_allows(open: u64, limit: u64, new_fds: u64) -> bool {
    open.saturating_add(new_fds)
        .saturating_add(TERMINAL_FD_HEADROOM)
        < limit
}

#[cfg(unix)]
fn fd_snapshot() -> Option<(u64, u64)> {
    let open = std::fs::read_dir("/dev/fd").ok()?.count() as u64;
    let limit = nofile_limit()?;
    Some((open, limit))
}

#[cfg(not(unix))]
fn fd_snapshot() -> Option<(u64, u64)> {
    None
}

#[cfg(target_os = "linux")]
fn nofile_limit() -> Option<u64> {
    rustix::process::getrlimit(rustix::process::Resource::Nofile).current
}

#[cfg(target_os = "macos")]
fn nofile_limit() -> Option<u64> {
    rustix::process::getrlimit(rustix::process::Resource::Nofile).current
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn nofile_limit() -> Option<u64> {
    None
}

impl Drop for Registry {
    fn drop(&mut self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, session) in sessions.drain() {
                session.close(CloseReason::Shutdown);
            }
        }
    }
}

#[derive(Debug)]
struct Session {
    id: String,
    tab_name: Option<String>,
    window_id: Option<String>,
    workspace_root: PathBuf,
    spawn_opts: CreateOptions,
    child_pid: Option<u32>,
    command_tx: std::sync::mpsc::Sender<PtyCommand>,
    output_tx: broadcast::Sender<SessionEvent>,
    ring: Mutex<RingBuffer>,
    seq: AtomicU64,
    last_activity: AtomicI64,
    attach_count: AtomicUsize,
    winsize: Mutex<PtySize>,
    focused: AtomicBool,
    bytes_since_focus: AtomicU64,
    in_alt_screen: AtomicBool,
    alt_screen_tail: Mutex<Vec<u8>>,
    closed: AtomicBool,
    team_work_identity: Option<TeamWorkIdentity>,
}

impl Session {
    fn spawn(id: String, config: RegistryConfig, opts: CreateOptions) -> anyhow::Result<Arc<Self>> {
        let team_work_identity = team_work_identity_from_options(&opts);
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(opts.size)?;
        let mut cmd = command_builder(opts.command.as_deref());
        let cwd = opts.cwd.unwrap_or_else(|| config.workspace_root.clone());
        cmd.cwd(&cwd);
        for (key, value) in &opts.env {
            cmd.env(key, value);
        }
        if let Some(home) = terminal_home_dir() {
            cmd.env("HOME", &home);
            #[cfg(windows)]
            cmd.env("USERPROFILE", home);
        }
        // `fullstack-b-11`: spawn-time TERM comes from settings. The
        // value lives in `TerminalConfig::default_term`; the SPA can
        // override the default via the Settings panel, and the change
        // takes effect on newly-spawned terminals (existing PTYs keep
        // whatever TERM they were started with).
        cmd.env("TERM", config.terminal.default_term.as_str());
        cmd.env("COLORTERM", "truecolor");
        cmd.env("CLICOLOR", "1");
        cmd.env("CLICOLOR_FORCE", "1");
        cmd.env("FORCE_COLOR", "3");
        cmd.env("CHAN", "1");
        clear_mcp_env(&mut cmd);
        if opts.mcp_env {
            if let Some(socket_path) = config.mcp_socket_path.as_deref() {
                set_mcp_env(&mut cmd, socket_path);
            }
        }
        let tab_name = opts.tab_name;
        if let Some(tab_name) = tab_name.as_deref() {
            cmd.env("CHAN_TAB_NAME", tab_name);
        }
        let window_id = opts.window_id;
        if let Some(window_id) = window_id.as_deref() {
            cmd.env("CHAN_WINDOW_ID", window_id);
        }
        if let Some(socket_path) = config.control_socket_path.as_deref() {
            if let Some(socket) = socket_path.to_str() {
                cmd.env("CHAN_CONTROL_SOCKET", socket);
            }
        }
        // Served-workspace identity for the terminal and any agents it spawns.
        // No user-managed workspace name exists; the label derives from the root
        // path basename, matching how the UI labels a workspace.
        let workspace_path = config.workspace_root.to_string_lossy();
        cmd.env("CHAN_WORKSPACE_PATH", workspace_path.as_ref());
        let workspace_name = config
            .workspace_root
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| workspace_path.into_owned());
        cmd.env("CHAN_WORKSPACE_NAME", &workspace_name);
        cmd.env_remove("NO_COLOR");
        cmd.env_remove("CI");
        cmd.env_remove("CODEX_CI");

        let mut child = pair.slave.spawn_command(cmd)?;
        let child_pid = child.process_id();
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader()?;
        let mut writer = pair.master.take_writer()?;
        let mut killer = child.clone_killer();
        let (command_tx, command_rx) = std::sync::mpsc::channel::<PtyCommand>();
        let (output_tx, _) = broadcast::channel::<SessionEvent>(BROADCAST_CAP);
        let session = Arc::new(Self {
            id,
            tab_name,
            window_id,
            workspace_root: config.workspace_root.clone(),
            spawn_opts: CreateOptions {
                size: opts.size,
                tab_name: None,
                window_id: None,
                mcp_env: opts.mcp_env,
                cwd: Some(cwd),
                command: opts.command,
                env: opts.env,
            },
            child_pid,
            command_tx,
            output_tx,
            ring: Mutex::new(RingBuffer::new(config.terminal.ring_bytes)),
            seq: AtomicU64::new(0),
            last_activity: AtomicI64::new(now_unix_secs() as i64),
            attach_count: AtomicUsize::new(0),
            winsize: Mutex::new(opts.size),
            focused: AtomicBool::new(false),
            bytes_since_focus: AtomicU64::new(0),
            in_alt_screen: AtomicBool::new(false),
            alt_screen_tail: Mutex::new(Vec::new()),
            closed: AtomicBool::new(false),
            team_work_identity,
        });

        {
            let session = session.clone();
            std::thread::Builder::new()
                .name("chan-terminal-reader".into())
                .spawn(move || {
                    let mut buf = [0u8; 8192];
                    loop {
                        match reader.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => session.record_output(&buf[..n]),
                            Err(e) => {
                                session.broadcast(SessionEvent::Error(format!(
                                    "terminal read failed: {e}"
                                )));
                                break;
                            }
                        }
                    }
                })?;
        }

        {
            let session = session.clone();
            std::thread::Builder::new()
                .name("chan-terminal-controller".into())
                .spawn(move || loop {
                    while let Ok(cmd) = command_rx.try_recv() {
                        match cmd {
                            PtyCommand::Input(data) => {
                                if let Err(e) = writer.write_all(&data) {
                                    session.broadcast(SessionEvent::Error(format!(
                                        "terminal write failed: {e}"
                                    )));
                                    let _ = killer.kill();
                                    return;
                                }
                                let _ = writer.flush();
                            }
                            PtyCommand::Resize(size) => {
                                if let Err(e) = pair.master.resize(size) {
                                    session.broadcast(SessionEvent::Error(format!(
                                        "terminal resize failed: {e}"
                                    )));
                                } else {
                                    *session.winsize.lock().expect("terminal winsize poisoned") =
                                        size;
                                    session.broadcast(SessionEvent::Resize(size));
                                }
                            }
                            PtyCommand::Redraw => {
                                let size =
                                    *session.winsize.lock().expect("terminal winsize poisoned");
                                let result =
                                    force_redraw_with_wobble(size, REDRAW_WOBBLE_DELAY, |size| {
                                        pair.master.resize(size)
                                    });
                                if let Err(e) = result {
                                    session.broadcast(SessionEvent::Error(format!(
                                        "terminal redraw resize failed: {e}"
                                    )));
                                } else {
                                    session.broadcast(SessionEvent::Resize(size));
                                }
                            }
                            PtyCommand::Kill => {
                                let _ = killer.kill();
                                return;
                            }
                        }
                    }

                    match child.try_wait() {
                        Ok(Some(status)) => {
                            session.broadcast(SessionEvent::Exit(status.exit_code()));
                            return;
                        }
                        Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                        Err(e) => {
                            session.broadcast(SessionEvent::Error(format!(
                                "terminal wait failed: {e}"
                            )));
                            return;
                        }
                    }
                })?;
        }

        Ok(session)
    }

    fn attach(self: Arc<Self>, since: Option<u64>) -> AttachHandle {
        self.attach_count.fetch_add(1, Ordering::Relaxed);
        let rx = self.output_tx.subscribe();
        let alt_screen = self.in_alt_screen.load(Ordering::Relaxed);
        let (replay, missed_bytes) = if alt_screen {
            (Vec::new(), 0)
        } else {
            self.ring
                .lock()
                .expect("terminal ring poisoned")
                .snapshot_since(since)
        };
        let seq = self.seq.load(Ordering::Relaxed);
        AttachHandle {
            id: self.id.clone(),
            session: self,
            rx,
            replay,
            seq,
            missed_bytes,
            alt_screen,
        }
    }

    fn send_input(&self, data: &[u8]) {
        self.last_activity
            .store(now_unix_secs() as i64, Ordering::Relaxed);
        let _ = self.command_tx.send(PtyCommand::Input(data.to_vec()));
    }

    fn resize(&self, size: PtySize) {
        let _ = self.command_tx.send(PtyCommand::Resize(size));
    }

    fn set_focused(&self, focused: bool) {
        self.focused.store(focused, Ordering::Relaxed);
        if focused {
            self.bytes_since_focus.store(0, Ordering::Relaxed);
            self.broadcast(SessionEvent::Activity {
                bytes_since_focus: 0,
            });
        }
    }

    fn bytes_since_focus(&self) -> u64 {
        self.bytes_since_focus.load(Ordering::Relaxed)
    }

    fn request_redraw(&self) {
        let _ = self.command_tx.send(PtyCommand::Redraw);
    }

    fn cwd(&self) -> Option<PathBuf> {
        let cwd = process_cwd(self.child_pid?)?;
        path_inside_root(&cwd, &self.workspace_root).then_some(cwd)
    }

    fn restart_options(&self) -> CreateOptions {
        let mut opts = self.spawn_opts.clone();
        opts.size = *self.winsize.lock().expect("terminal winsize poisoned");
        opts.tab_name = self.tab_name.clone();
        opts.window_id = self.window_id.clone();
        opts
    }

    fn close(&self, reason: CloseReason) {
        if self.closed.swap(true, Ordering::Relaxed) {
            return;
        }
        self.broadcast(SessionEvent::Closed(reason));
        let _ = self.command_tx.send(PtyCommand::Kill);
    }

    fn record_output(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.last_activity
            .store(now_unix_secs() as i64, Ordering::Relaxed);
        self.update_alt_screen(bytes);
        let end_seq = {
            let mut ring = self.ring.lock().expect("terminal ring poisoned");
            ring.push(bytes);
            ring.end_seq()
        };
        self.seq.store(end_seq, Ordering::Relaxed);
        if !self.focused.load(Ordering::Relaxed) {
            // PTYs emit cursor motion, SGR, OSC title changes, BEL,
            // and CR/LF redraw noise while idle. Only user-visible
            // non-whitespace text should trip the tab activity dot.
            let visible = visible_activity_bytes(bytes);
            if visible > 0 {
                let previous = self.bytes_since_focus.fetch_add(visible, Ordering::Relaxed);
                if previous == 0 {
                    self.broadcast(SessionEvent::Activity {
                        bytes_since_focus: visible,
                    });
                }
            }
        }
        self.broadcast(SessionEvent::Output(bytes.to_vec()));
    }

    fn broadcast(&self, event: SessionEvent) {
        let _ = self.output_tx.send(event);
    }

    fn update_alt_screen(&self, bytes: &[u8]) {
        let mut tail = self
            .alt_screen_tail
            .lock()
            .expect("terminal alt-screen tail poisoned");
        let mut scan = Vec::with_capacity(tail.len() + bytes.len());
        scan.extend_from_slice(&tail);
        scan.extend_from_slice(bytes);

        let mut matched_transition = false;
        if contains_subslice(&scan, ALT_SCREEN_ENTER) {
            self.in_alt_screen.store(true, Ordering::Relaxed);
            tracing::debug!(session = %self.id, "alt_screen entered");
            matched_transition = true;
        }
        if contains_subslice(&scan, ALT_SCREEN_EXIT) {
            self.in_alt_screen.store(false, Ordering::Relaxed);
            tracing::debug!(session = %self.id, "alt_screen exited");
            matched_transition = true;
        }

        if matched_transition {
            tail.clear();
            return;
        }

        if !scan.is_empty() {
            let keep = scan.len().min(ALT_SCREEN_TAIL_BYTES);
            tail.clear();
            tail.extend_from_slice(&scan[scan.len() - keep..]);
        }
    }
}

fn team_work_identity_from_options(opts: &CreateOptions) -> Option<TeamWorkIdentity> {
    let team = opts.env.get("CHAN_TEAM_NAME")?;
    let agent = opts
        .tab_name
        .as_deref()
        .or_else(|| opts.env.get("CHAN_TAB_NAME").map(String::as_str))?;
    TeamWorkIdentity::validated(team, agent).ok()
}

fn path_inside_root(path: &Path, root: &Path) -> bool {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    path == root || path.starts_with(root)
}

#[cfg(target_os = "linux")]
fn process_cwd(pid: u32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
}

#[cfg(target_os = "macos")]
fn process_cwd(pid: u32) -> Option<PathBuf> {
    let output = Command::new("/usr/sbin/lsof")
        .args(["-a", "-d", "cwd", "-Fn", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix('n'))
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn process_cwd(_pid: u32) -> Option<PathBuf> {
    None
}

enum PtyCommand {
    Input(Vec<u8>),
    Resize(PtySize),
    Redraw,
    Kill,
}

fn command_builder(command: Option<&str>) -> CommandBuilder {
    let Some(command) = command.map(str::trim).filter(|command| !command.is_empty()) else {
        return CommandBuilder::new_default_prog();
    };
    #[cfg(windows)]
    {
        let mut cmd = CommandBuilder::new("cmd");
        cmd.args(["/C", command]);
        cmd
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into());
        let mut cmd = CommandBuilder::new(shell);
        cmd.args(["-lc", command]);
        cmd
    }
}

fn contains_subslice(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|w| w == needle)
}

fn force_redraw_with_wobble<E>(
    original: PtySize,
    delay: Duration,
    mut resize: impl FnMut(PtySize) -> Result<(), E>,
) -> Result<(), E> {
    let wobble = redraw_wobble_size(original);
    resize(wobble)?;
    std::thread::sleep(delay);
    resize(original)
}

fn redraw_wobble_size(original: PtySize) -> PtySize {
    let rows = if original.rows > 1 {
        original.rows - 1
    } else {
        original.rows.saturating_add(1)
    };
    PtySize { rows, ..original }
}

#[derive(Debug)]
struct RingBuffer {
    cap: usize,
    chunks: VecDeque<(u64, Vec<u8>)>,
    start_seq: u64,
    end_seq: u64,
    len: usize,
}

impl RingBuffer {
    fn new(cap: usize) -> Self {
        Self {
            cap: cap.max(1),
            chunks: VecDeque::new(),
            start_seq: 0,
            end_seq: 0,
            len: 0,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        let start = self.end_seq;
        self.end_seq = self.end_seq.saturating_add(bytes.len() as u64);
        if bytes.len() >= self.cap {
            self.chunks.clear();
            let tail = bytes[bytes.len() - self.cap..].to_vec();
            self.start_seq = self.end_seq.saturating_sub(tail.len() as u64);
            self.len = tail.len();
            self.chunks.push_back((self.start_seq, tail));
            return;
        }
        self.len = self.len.saturating_add(bytes.len());
        self.chunks.push_back((start, bytes.to_vec()));
        while self.len > self.cap {
            if let Some((_start, chunk)) = self.chunks.pop_front() {
                self.len = self.len.saturating_sub(chunk.len());
                self.start_seq = self.start_seq.saturating_add(chunk.len() as u64);
            } else {
                self.start_seq = self.end_seq;
                self.len = 0;
                break;
            }
        }
    }

    fn end_seq(&self) -> u64 {
        self.end_seq
    }

    fn snapshot_since(&self, since: Option<u64>) -> (Vec<Vec<u8>>, u64) {
        let requested = since.unwrap_or(self.start_seq);
        let replay_start = requested.max(self.start_seq);
        let missed = self.start_seq.saturating_sub(requested);
        let mut replay = Vec::new();
        for (chunk_start, chunk) in &self.chunks {
            let chunk_end = chunk_start.saturating_add(chunk.len() as u64);
            if chunk_end <= replay_start {
                continue;
            }
            let offset = replay_start.saturating_sub(*chunk_start) as usize;
            replay.push(chunk[offset..].to_vec());
        }
        (replay, missed)
    }
}

fn random_session_id() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    let mut out = String::with_capacity(32);
    for b in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

pub(crate) fn set_mcp_env(cmd: &mut CommandBuilder, socket_path: &std::path::Path) {
    let Some(socket) = socket_path.to_str() else {
        return;
    };
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let Some(exe) = exe.to_str() else {
        return;
    };
    let argv_json = serde_json::json!([exe, "__mcp-proxy", socket]).to_string();
    let server_json = serde_json::json!({
        "name": "chan",
        "command": exe,
        "args": ["__mcp-proxy", socket],
    })
    .to_string();

    cmd.env("CHAN_MCP_SERVER_NAME", "chan");
    cmd.env("CHAN_MCP_SOCKET", socket);
    cmd.env("CHAN_MCP_COMMAND", format!("{exe} __mcp-proxy {socket}"));
    cmd.env("CHAN_MCP_COMMAND_JSON", argv_json);
    cmd.env("CHAN_MCP_SERVER_JSON", server_json);
}

fn clear_mcp_env(cmd: &mut CommandBuilder) {
    for key in [
        "CHAN_MCP_SERVER_NAME",
        "CHAN_MCP_SOCKET",
        "CHAN_MCP_COMMAND",
        "CHAN_MCP_COMMAND_JSON",
        "CHAN_MCP_SERVER_JSON",
        "CHAN_WINDOW_ID",
        "CHAN_CONTROL_SOCKET",
        "CHAN_WORKSPACE_NAME",
        "CHAN_WORKSPACE_PATH",
    ] {
        cmd.env_remove(key);
    }
}

pub(crate) fn terminal_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
}

fn visible_activity_bytes(bytes: &[u8]) -> u64 {
    let mut visible = 0;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            0x1b => i = skip_ansi_escape(bytes, i + 1),
            0x00..=0x1f | 0x7f => i += 1,
            b if b.is_ascii_whitespace() => i += 1,
            _ => {
                visible += 1;
                i += 1;
            }
        }
    }
    visible
}

fn skip_ansi_escape(bytes: &[u8], mut i: usize) -> usize {
    if i >= bytes.len() {
        return i;
    }
    match bytes[i] {
        b'[' => {
            i += 1;
            while i < bytes.len() {
                let b = bytes[i];
                i += 1;
                if (0x40..=0x7e).contains(&b) {
                    break;
                }
            }
            i
        }
        b']' => {
            i += 1;
            while i < bytes.len() {
                match bytes[i] {
                    0x07 => return i + 1,
                    0x1b if i + 1 < bytes.len() && bytes[i + 1] == b'\\' => return i + 2,
                    _ => i += 1,
                }
            }
            i
        }
        _ => i + 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config(ring_bytes: usize, cap: usize, idle: u64) -> RegistryConfig {
        let tmp = tempfile::tempdir().unwrap();
        let workspace_root = tmp.path().to_path_buf();
        std::mem::forget(tmp);
        RegistryConfig {
            workspace_root,
            mcp_socket_path: None,
            control_socket_path: None,
            terminal: TerminalConfig {
                idle_timeout_secs: idle,
                session_cap: cap,
                ring_bytes,
                ..TerminalConfig::default()
            },
        }
    }

    fn test_size() -> PtySize {
        PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        }
    }

    fn test_session_with_ring(ring_bytes: usize) -> Arc<Session> {
        let (command_tx, _command_rx) = std::sync::mpsc::channel();
        let (output_tx, _) = broadcast::channel(BROADCAST_CAP);
        Arc::new(Session {
            id: "test-session".to_string(),
            tab_name: None,
            window_id: None,
            workspace_root: PathBuf::from("/"),
            spawn_opts: CreateOptions {
                size: test_size(),
                tab_name: None,
                window_id: None,
                mcp_env: true,
                cwd: None,
                command: None,
                env: Default::default(),
            },
            child_pid: None,
            command_tx,
            output_tx,
            ring: Mutex::new(RingBuffer::new(ring_bytes)),
            seq: AtomicU64::new(0),
            last_activity: AtomicI64::new(now_unix_secs() as i64),
            attach_count: AtomicUsize::new(0),
            winsize: Mutex::new(test_size()),
            focused: AtomicBool::new(false),
            bytes_since_focus: AtomicU64::new(0),
            in_alt_screen: AtomicBool::new(false),
            alt_screen_tail: Mutex::new(Vec::new()),
            closed: AtomicBool::new(false),
            team_work_identity: None,
        })
    }

    fn test_session_with_team_identity(
        id: &str,
        team: Option<&str>,
        agent: Option<&str>,
    ) -> (Arc<Session>, std::sync::mpsc::Receiver<PtyCommand>) {
        let (command_tx, command_rx) = std::sync::mpsc::channel();
        let (output_tx, _) = broadcast::channel(BROADCAST_CAP);
        let identity = match (team, agent) {
            (Some(team), Some(agent)) => Some(TeamWorkIdentity::validated(team, agent).unwrap()),
            _ => None,
        };
        (
            Arc::new(Session {
                id: id.to_string(),
                tab_name: agent.map(str::to_string),
                window_id: None,
                workspace_root: PathBuf::from("/"),
                spawn_opts: CreateOptions {
                    size: test_size(),
                    tab_name: agent.map(str::to_string),
                    window_id: None,
                    mcp_env: true,
                    cwd: None,
                    command: None,
                    env: Default::default(),
                },
                child_pid: None,
                command_tx,
                output_tx,
                ring: Mutex::new(RingBuffer::new(1024)),
                seq: AtomicU64::new(0),
                last_activity: AtomicI64::new(now_unix_secs() as i64),
                attach_count: AtomicUsize::new(0),
                winsize: Mutex::new(test_size()),
                focused: AtomicBool::new(false),
                bytes_since_focus: AtomicU64::new(0),
                in_alt_screen: AtomicBool::new(false),
                alt_screen_tail: Mutex::new(Vec::new()),
                closed: AtomicBool::new(false),
                team_work_identity: identity,
            }),
            command_rx,
        )
    }

    fn insert_session(registry: &Registry, session: Arc<Session>) {
        registry
            .sessions
            .lock()
            .expect("terminal registry")
            .insert(session.id.clone(), session);
    }

    fn recv_input(rx: &std::sync::mpsc::Receiver<PtyCommand>) -> Vec<u8> {
        match rx.try_recv().expect("input command") {
            PtyCommand::Input(data) => data,
            _ => panic!("expected input command"),
        }
    }

    #[test]
    fn poke_team_work_agent_writes_exact_poke_to_all_matching_sessions() {
        let registry = Registry::new(test_config(1024, 8, 10));
        let (first, first_rx) =
            test_session_with_team_identity("first", Some("alpha"), Some("@@FullStackA"));
        let (second, second_rx) =
            test_session_with_team_identity("second", Some("alpha"), Some("@@FullStackA"));
        let (other_team, other_team_rx) =
            test_session_with_team_identity("other-team", Some("beta"), Some("@@FullStackA"));
        let (other_agent, other_agent_rx) =
            test_session_with_team_identity("other-agent", Some("alpha"), Some("@@Reviewer"));
        let (plain, plain_rx) = test_session_with_team_identity("plain", None, None);
        insert_session(&registry, first);
        insert_session(&registry, second);
        insert_session(&registry, other_team);
        insert_session(&registry, other_agent);
        insert_session(&registry, plain);

        let count = registry.poke_team_work_agent("alpha", "@@FullStackA");

        assert_eq!(count, 2);
        assert_eq!(recv_input(&first_rx), b"poke\n");
        assert_eq!(recv_input(&second_rx), b"poke\n");
        assert!(other_team_rx.try_recv().is_err());
        assert!(other_agent_rx.try_recv().is_err());
        assert!(plain_rx.try_recv().is_err());
    }

    #[test]
    fn poke_team_work_agent_ignores_closed_and_offline_sessions() {
        let registry = Registry::new(test_config(1024, 8, 10));
        let (closed, closed_rx) =
            test_session_with_team_identity("closed", Some("alpha"), Some("@@FullStackA"));
        closed.closed.store(true, Ordering::Relaxed);
        insert_session(&registry, closed);

        assert_eq!(registry.poke_team_work_agent("alpha", "@@FullStackA"), 0);
        assert!(closed_rx.try_recv().is_err());
        assert_eq!(registry.poke_team_work_agent("alpha", "@@Missing"), 0);
    }

    async fn collect_until(session: &mut AttachHandle, needle: &str, timeout: Duration) -> String {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut out = String::new();
        loop {
            if out.contains(needle) || tokio::time::Instant::now() >= deadline {
                return out;
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            match tokio::time::timeout(remaining, session.rx.recv()).await {
                Ok(Ok(SessionEvent::Output(data))) => out.push_str(&String::from_utf8_lossy(&data)),
                Ok(Ok(_)) => {}
                Ok(Err(_)) | Err(_) => return out,
            }
        }
    }

    #[test]
    fn activity_counter_tracks_output_since_focus() {
        let session = test_session_with_ring(1024);

        session.record_output(b"background");
        assert_eq!(session.bytes_since_focus(), 10);

        session.set_focused(true);
        assert_eq!(session.bytes_since_focus(), 0);

        session.record_output(b"visible");
        assert_eq!(session.bytes_since_focus(), 0);

        session.set_focused(false);
        session.record_output(b"hidden");
        assert_eq!(session.bytes_since_focus(), 6);
    }

    #[test]
    fn activity_counter_ignores_ansi_and_control_only_writes() {
        let session = test_session_with_ring(1024);

        session.record_output(b"\x1b[?25l\x1b[?25h\x1b[31m\x1b[0m\r\n\t \x07");
        session.record_output(b"\x1b]0;chan\x07");
        session.record_output(b"\x1b]2;title\x1b\\");

        assert_eq!(session.bytes_since_focus(), 0);
    }

    #[test]
    fn activity_counter_counts_plain_visible_text() {
        let session = test_session_with_ring(1024);

        session.record_output(b"echo hello\n");

        assert_eq!(session.bytes_since_focus(), 9);
    }

    #[test]
    fn activity_counter_counts_visible_text_inside_ansi_writes() {
        let session = test_session_with_ring(1024);

        session.record_output(b"\x1b[32mhello\x1b[0m\r\n");

        assert_eq!(session.bytes_since_focus(), 5);
    }

    #[tokio::test]
    async fn activity_event_fires_on_first_unfocused_output_and_clears_on_focus() {
        let session = test_session_with_ring(1024);
        let mut attached = session.clone().attach(Some(0));

        session.record_output(b"one");
        let event = tokio::time::timeout(Duration::from_secs(1), attached.rx.recv())
            .await
            .expect("activity event")
            .expect("activity frame");
        assert!(matches!(
            event,
            SessionEvent::Activity {
                bytes_since_focus: 3
            }
        ));

        session.record_output(b"two");
        let event = tokio::time::timeout(Duration::from_secs(1), attached.rx.recv())
            .await
            .expect("output event")
            .expect("output frame");
        assert!(matches!(event, SessionEvent::Output(_)));

        session.set_focused(true);
        loop {
            let event = tokio::time::timeout(Duration::from_secs(1), attached.rx.recv())
                .await
                .expect("focus clear event")
                .expect("focus clear frame");
            if matches!(
                event,
                SessionEvent::Activity {
                    bytes_since_focus: 0
                }
            ) {
                break;
            }
        }
    }

    #[test]
    fn ring_overflow_reports_missed_bytes() {
        let mut ring = RingBuffer::new(5);
        ring.push(b"abc");
        ring.push(b"def");
        let (replay, missed) = ring.snapshot_since(Some(0));
        assert_eq!(missed, 3);
        assert_eq!(replay.concat(), b"def");
    }

    #[test]
    fn session_ids_are_hex_and_distinct() {
        let a = random_session_id();
        let b = random_session_id();
        assert_ne!(a, b);
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn alt_screen_active_skips_replay_until_exit() {
        let session = test_session_with_ring(1024);
        session.record_output(b"before alt\n");
        let attached = session.clone().attach(Some(0));
        assert_eq!(attached.replay.concat(), b"before alt\n");
        drop(attached);

        session.record_output(b"\x1b[?1049hdraw tui frame");
        let attached = session.clone().attach(Some(0));
        assert!(attached.replay.is_empty());
        assert_eq!(attached.missed_bytes, 0);
        drop(attached);

        session.record_output(b"\x1b[?1049lback to shell\n");
        let attached = session.attach(Some(0));
        assert!(!attached.replay.is_empty());
        assert!(String::from_utf8_lossy(&attached.replay.concat()).contains("back to shell"));
    }

    #[test]
    fn alt_screen_sniffer_matches_expected_sequences() {
        assert!(contains_subslice(b"abc\x1b[?1049hdef", b"\x1b[?1049h"));
        assert!(contains_subslice(b"abc\x1b[?1049ldef", b"\x1b[?1049l"));
        assert!(!contains_subslice(b"abc\x1b[?1048hdef", b"\x1b[?1049h"));
    }

    #[test]
    fn alt_screen_sniffer_matches_sequences_across_chunks() {
        let session = test_session_with_ring(1024);

        session.record_output(b"\x1b");
        assert!(!session.in_alt_screen.load(Ordering::Relaxed));
        session.record_output(b"[?1049h");
        assert!(session.in_alt_screen.load(Ordering::Relaxed));

        session.record_output(b"\x1b[?");
        assert!(session.in_alt_screen.load(Ordering::Relaxed));
        session.record_output(b"1049l");
        assert!(!session.in_alt_screen.load(Ordering::Relaxed));
    }

    #[test]
    fn redraw_wobble_pattern_resizes_then_restores() {
        let original = PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 640,
            pixel_height: 480,
        };
        let mut calls = Vec::new();
        force_redraw_with_wobble(original, Duration::ZERO, |size| {
            calls.push(size);
            Ok::<(), ()>(())
        })
        .unwrap();

        assert_eq!(
            calls,
            vec![
                PtySize {
                    rows: 23,
                    ..original
                },
                original,
            ]
        );
    }

    #[test]
    fn redraw_wobble_keeps_single_row_sessions_moving() {
        let original = PtySize {
            rows: 1,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        };

        assert_eq!(redraw_wobble_size(original).rows, 2);
    }

    #[test]
    fn prune_idle_removes_detached_sessions() {
        let registry = Registry::new(test_config(1024, 4, 10));
        let handle = registry
            .create(CreateOptions {
                size: test_size(),
                tab_name: None,
                window_id: None,
                mcp_env: true,
                cwd: None,
                command: None,
                env: Default::default(),
            })
            .unwrap();
        let id = handle.id().to_string();
        drop(handle);
        assert_eq!(registry.len(), 1);
        assert_eq!(registry.prune_idle_at(now_unix_secs() as i64 + 11), 1);
        assert_eq!(registry.len(), 0);
        assert!(registry.attach(&id, None).is_none());
    }

    #[test]
    fn cap_exceeded_refuses_create() {
        let registry = Registry::new(test_config(1024, 1, 10));
        let _first = registry
            .create(CreateOptions {
                size: test_size(),
                tab_name: None,
                window_id: None,
                mcp_env: true,
                cwd: None,
                command: None,
                env: Default::default(),
            })
            .unwrap();
        let err = registry
            .create(CreateOptions {
                size: test_size(),
                tab_name: None,
                window_id: None,
                mcp_env: true,
                cwd: None,
                command: None,
                env: Default::default(),
            })
            .unwrap_err();
        assert!(matches!(err, CreateError::Capped));
    }

    #[test]
    fn fd_headroom_keeps_terminal_spawns_away_from_process_limit() {
        assert!(fd_headroom_allows(100, 256, TERMINAL_SESSION_FD_ESTIMATE));
        assert!(!fd_headroom_allows(216, 256, TERMINAL_SESSION_FD_ESTIMATE));
    }

    #[test]
    fn get_or_create_without_session_id_creates_fresh_even_for_same_window_and_tab_name() {
        let registry = Registry::new(test_config(1024, 4, 10));
        let first = registry
            .create(CreateOptions {
                size: test_size(),
                tab_name: Some("B19v2".into()),
                window_id: Some("window-a".into()),
                mcp_env: true,
                cwd: None,
                command: None,
                env: Default::default(),
            })
            .unwrap();
        let first_id = first.id().to_string();

        let second = registry
            .get_or_create(
                None,
                Some(0),
                CreateOptions {
                    size: test_size(),
                    tab_name: Some("B19v2".into()),
                    window_id: Some("window-a".into()),
                    mcp_env: true,
                    cwd: None,
                    command: None,
                    env: Default::default(),
                },
            )
            .unwrap();

        assert_ne!(second.id(), first_id);
        assert_eq!(registry.len(), 2);
        registry.close(&first_id, CloseReason::Explicit);
        registry.close(second.id(), CloseReason::Explicit);
    }

    #[test]
    fn get_or_create_without_session_id_does_not_match_ambiguous_window_tab_identity() {
        let registry = Registry::new(test_config(1024, 4, 10));
        let first = registry
            .create(CreateOptions {
                size: test_size(),
                tab_name: Some("dup".into()),
                window_id: Some("window-a".into()),
                mcp_env: true,
                cwd: None,
                command: None,
                env: Default::default(),
            })
            .unwrap();
        let second = registry
            .create(CreateOptions {
                size: test_size(),
                tab_name: Some("dup".into()),
                window_id: Some("window-a".into()),
                mcp_env: true,
                cwd: None,
                command: None,
                env: Default::default(),
            })
            .unwrap();

        let third = registry
            .get_or_create(
                None,
                Some(0),
                CreateOptions {
                    size: test_size(),
                    tab_name: Some("dup".into()),
                    window_id: Some("window-a".into()),
                    mcp_env: true,
                    cwd: None,
                    command: None,
                    env: Default::default(),
                },
            )
            .unwrap();

        assert_ne!(third.id(), first.id());
        assert_ne!(third.id(), second.id());
        assert_eq!(registry.len(), 3);
        registry.close(first.id(), CloseReason::Explicit);
        registry.close(second.id(), CloseReason::Explicit);
        registry.close(third.id(), CloseReason::Explicit);
    }

    #[tokio::test]
    async fn spawn_uses_configured_default_term() {
        // `fullstack-b-11`: TERM env var on the spawned shell honors
        // `TerminalConfig::default_term`. A bare `printf "$TERM"`
        // command exits immediately so the captured tail of output
        // contains the env value we set, not interactive shell noise.
        let mut config = test_config(4096, 4, 60);
        config.terminal.default_term = "tmux-256color".into();
        let registry = Arc::new(Registry::new(config));
        let mut handle = registry
            .create(CreateOptions {
                size: test_size(),
                tab_name: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                command: Some("printf 'TERM=<%s>\\n' \"$TERM\"".into()),
                env: Default::default(),
            })
            .unwrap();

        let out = collect_until(&mut handle, "TERM=<tmux-256color>", Duration::from_secs(5)).await;
        assert!(
            out.contains("TERM=<tmux-256color>"),
            "PTY did not echo configured TERM: {out:?}"
        );
        registry.close(handle.id(), CloseReason::Explicit);
    }

    #[test]
    fn workspace_close_removes_sessions() {
        let registry = Registry::new(test_config(1024, 4, 10));
        let handle = registry
            .create(CreateOptions {
                size: test_size(),
                tab_name: None,
                window_id: None,
                mcp_env: true,
                cwd: None,
                command: None,
                env: Default::default(),
            })
            .unwrap();
        let id = handle.id().to_string();
        registry.close_all(CloseReason::Workspace);
        assert_eq!(registry.len(), 0);
        assert!(registry.attach(&id, None).is_none());
    }

    #[tokio::test]
    async fn two_attaches_share_io() {
        let registry = Registry::new(test_config(4096, 4, 60));
        let first = registry
            .create(CreateOptions {
                size: PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                tab_name: None,
                window_id: None,
                mcp_env: true,
                cwd: None,
                command: None,
                env: Default::default(),
            })
            .unwrap();
        let mut second = registry.attach(first.id(), Some(first.seq)).unwrap();
        first.send_input(b"printf '\\n__SHARED__\\n'\r");
        let mut saw = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            match tokio::time::timeout(remaining, second.rx.recv()).await {
                Ok(Ok(SessionEvent::Output(bytes))) => {
                    if String::from_utf8_lossy(&bytes).contains("__SHARED__") {
                        saw = true;
                        break;
                    }
                }
                Ok(Ok(_)) => {}
                Ok(Err(_)) | Err(_) => break,
            }
        }
        assert!(saw, "second attach did not receive output from first input");
        registry.close(first.id(), CloseReason::Explicit);
    }

    #[tokio::test]
    async fn request_redraw_broadcasts_current_size() {
        let registry = Registry::new(test_config(4096, 4, 60));
        let first = registry
            .create(CreateOptions {
                size: test_size(),
                tab_name: None,
                window_id: None,
                mcp_env: true,
                cwd: None,
                command: None,
                env: Default::default(),
            })
            .unwrap();
        let mut second = registry.attach(first.id(), Some(first.seq)).unwrap();
        second.request_redraw();

        let mut saw = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            match tokio::time::timeout(remaining, second.rx.recv()).await {
                Ok(Ok(SessionEvent::Resize(size))) => {
                    saw = size.rows == test_size().rows && size.cols == test_size().cols;
                    if saw {
                        break;
                    }
                }
                Ok(Ok(_)) => {}
                Ok(Err(_)) | Err(_) => break,
            }
        }
        assert!(saw, "redraw did not re-apply the current PTY size");
        registry.close(first.id(), CloseReason::Explicit);
    }
}
