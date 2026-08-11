//! Long-lived PTY session registry.
//!
//! A terminal WebSocket is only an attachment. The PTY, child process,
//! replay ring, and lifecycle policy live here so browser reloads can
//! detach and reattach without killing the shell.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
#[cfg(target_os = "linux")]
use std::fs::File;
#[cfg(target_os = "linux")]
use std::io;
use std::io::{Read, Write};
#[cfg(target_os = "linux")]
use std::os::fd::{AsFd, AsRawFd, OwnedFd, RawFd};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use portable_pty::{native_pty_system, Child, PtySize};
use rand::RngCore;
#[cfg(target_os = "linux")]
use serde::Deserialize;
use serde::Serialize;
use tokio::sync::{broadcast, watch, Notify};
use tokio::task::JoinHandle;

use chan_shell::{
    plan_submitted_input, PaneSide, PtyInputPlan, ResolvedSubmit, SubmitAgent,
    MAX_TERMINAL_WRITE_BYTES,
};

use crate::config::TerminalConfig;
use crate::time::{now_unix_millis, now_unix_secs};

mod bytes;
mod platform;
mod redraw;
mod ring;

use bytes::{contains_subslice, visible_activity_bytes};
#[cfg(windows)]
pub use platform::prime_windows_shell;
#[cfg(unix)]
pub use platform::user_shell;
use platform::{
    clear_mcp_env, command_builder, locale_selects_utf8, path_inside_root, process_cwd,
    reject_terminal_spawn_if_fd_pressure, set_mcp_env, terminal_home_dir,
};
#[cfg(test)]
use platform::{fd_headroom_allows, TERMINAL_SESSION_FD_ESTIMATE};
use redraw::force_redraw_with_wobble;
#[cfg(test)]
use redraw::redraw_wobble_size;
use ring::RingBuffer;

const BROADCAST_CAP: usize = 1024;

// `cs terminal write` serialization queue (the auto-deliver poke chain).
// Each session has a bounded logical FIFO. When the agent is IDLE (its output
// has quiesced), the drainer delivers the largest safe batch at the head and
// awaits the agent's generation-START before the next drain. The signal is
// purely output quiescence (`last_output_at`); see cs-write-queue-design.md.
const WRITE_QUEUE_CAP: usize = 100;
/// Output-idle threshold: the agent is considered done generating when no
/// output has arrived for this long. Conservative to ride over brief
/// mid-stream gaps; tune against real agent streaming.
const WRITE_QUEUE_QUIET_MS: i64 = 800;
/// After a deliver+submit, wait at most this long for the agent's generation
/// to START before allowing the next delivery. Caps the post-submit window
/// so a message that did not trigger generation (e.g. no submit chord) does
/// not wedge the queue.
const WRITE_QUEUE_GEN_START_CAP_MS: i64 = 2000;
/// How often the drainer scans sessions for a deliverable queued write.
const WRITE_QUEUE_DRAIN_TICK: Duration = Duration::from_millis(150);
/// Maximum UTF-8 byte size of one framed notification batch. An oversized
/// head still drains as a singleton so it cannot wedge the FIFO.
const WRITE_QUEUE_BATCH_MAX_BYTES: usize = 64 * 1024;
/// Gap between the two parts of a batched Claude delivery, its only user.
/// Claude Code 2.1.215 passed 3/3 busy-queue runs at 64 KiB for 50, 100, 200,
/// and 400 ms; the smallest passing value also passed 3/3 advisory runs at
/// 256 KiB. Gemini did not preserve a 64 KiB batch under any tested fixed gap
/// below the idle threshold, so it takes a queue entry per part instead.
const WRITE_QUEUE_INPUT_GAP: Duration = Duration::from_millis(50);
/// Live-probe override for `WRITE_QUEUE_INPUT_GAP`, read once per process.
/// `scripts/e2e/terminal-queue-drain.sh --gap` re-runs the paste matrix
/// against a new Claude Code release without a rebuild. A value outside
/// 1..`WRITE_QUEUE_QUIET_MS` ms is ignored, because a gap at or above the idle
/// threshold would let the drainer treat the split as two turns.
const WRITE_QUEUE_INPUT_GAP_ENV: &str = "CHAN_TERMINAL_INPUT_GAP_MS";

fn parse_input_gap(raw: &str) -> Option<Duration> {
    raw.trim()
        .parse::<u64>()
        .ok()
        .filter(|ms| *ms > 0 && i64::try_from(*ms).is_ok_and(|ms| ms < WRITE_QUEUE_QUIET_MS))
        .map(Duration::from_millis)
}

fn write_queue_input_gap() -> Duration {
    static GAP: OnceLock<Duration> = OnceLock::new();
    *GAP.get_or_init(|| {
        std::env::var(WRITE_QUEUE_INPUT_GAP_ENV)
            .ok()
            .and_then(|raw| parse_input_gap(&raw))
            .unwrap_or(WRITE_QUEUE_INPUT_GAP)
    })
}

const ALT_SCREEN_ENTER: &[u8] = b"\x1b[?1049h";
const ALT_SCREEN_EXIT: &[u8] = b"\x1b[?1049l";
const ALT_SCREEN_TAIL_BYTES: usize = ALT_SCREEN_ENTER.len() - 1;
const REDRAW_WOBBLE_DELAY: Duration = Duration::from_millis(50);
pub const ALT_SCREEN_ATTACH_PRELUDE: &[u8] = b"\x1b[?1049h\x1b[2J\x1b[H";

/// DEC private modes whose loss on a fresh client's reattach breaks INPUT  --
/// key encoding (DECCKM) and mouse-event delivery/encoding -- because the live
/// foreground program set them once at startup and will NOT re-announce after
/// a reattach. Reattaching in alt-screen replays no scrollback, so the original
/// set sequences are gone and the fresh terminal comes up at defaults: arrows
/// stop navigating (DECCKM) and the wheel/clicks stop reaching the program
/// (mouse). We track the set currently on (scanned from PTY output by
/// [`Session::update_private_modes`]) and re-assert it in the attach prelude  --
/// generalizing the single-bool alt-screen restore. Screen-rendering modes
/// (autowrap, cursor visibility) are deliberately NOT tracked: the program's
/// post-attach redraw re-establishes them. Alt-screen (1049/1047/47) is NOT
/// here either -- it is handled by [`ALT_SCREEN_ATTACH_PRELUDE`].
const TRACKED_PRIVATE_MODES: &[u16] = &[
    1,    // DECCKM -- application cursor keys (arrow encoding: \e[A vs \eOA)
    1000, // mouse: normal button (press/release) tracking
    1002, // mouse: button-event (drag) tracking
    1003, // mouse: any-event (motion) tracking
    1004, // focus in/out reporting
    1006, // mouse: SGR extended coordinate encoding
    BRACKETED_PASTE_MODE,
];
const BRACKETED_PASTE_MODE: u16 = 2004;
/// Upper bound on a carried partial private-mode CSI (`\e[?<params>(h|l)`) split
/// across PTY reads: a handful of `;`-joined mode numbers. Past this, a dangling
/// `\e[?…` is not a real mode toggle and is dropped rather than buffered.
const PRIVATE_MODE_TAIL_CAP: usize = 64;
#[cfg(target_os = "linux")]
const FDSTORE_REPLAY_BYTES: usize = 128 * 1024;

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
    /// Last known terminal-engine preference, sampled once for each PTY spawn.
    /// Workspace servers push config changes into this cell. A long-lived
    /// terminal-only tenant can additionally install `terminal_backend_resolver`
    /// because it has no settings route or config-change push channel.
    terminal_ghostty: AtomicBool,
    /// Optional spawn-time preference pull for a terminal-only tenant. Kept
    /// absent on workspace registries, whose config-change path updates the
    /// atomic cell directly.
    terminal_backend_resolver: Mutex<Option<TerminalBackendResolver>>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// Names settled for a create/restart whose PTY is still spawning. A
    /// reservation prevents another caller from receiving the same name
    /// without holding `sessions` across openpty/fork/exec.
    name_reservations: Mutex<HashSet<String>>,
    /// Last PTY process exit observed in this registry. This is sticky at the
    /// tenant/registry level so a control-terminal poller can still see the
    /// script exit after an attached terminal websocket removes the session.
    last_exit: Arc<Mutex<Option<TerminalExit>>>,
    /// Fires whenever the live roster changes (create / close / restart /
    /// broadcast-toggle). The roster broadcaster task awaits this and
    /// republishes a fresh snapshot onto the `/ws` bus so every window's
    /// SPA sees the same cross-window terminal set. `Notify` coalesces
    /// bursts into one wakeup (natural debounce) and stores a permit when
    /// no waiter is parked, so a change is never missed.
    roster_notify: Arc<Notify>,
    /// Command this tenant's terminals run on their PTY when an open
    /// request carries no command of its own. `None` keeps the user's
    /// default interactive shell. A single-purpose terminal tenant (a
    /// window whose PTY runs a connect script) sets it once at creation.
    default_command: Mutex<Option<String>>,
    /// Window ids (the `?w=` session-blob key) that currently have a durable
    /// saved layout blob. Maintained by the session routes: a `PUT
    /// /api/session?w=W` marks W persisted, a `DELETE` forgets it. Drives the
    /// persistence-based session lifetime (see [`Registry::prune_idle_at`]): a
    /// persisted window's detached sessions survive a client disconnect
    /// indefinitely (browser-tab semantics -- reattach on reconnect), while a
    /// window with no durable blob is an orphan and its detached sessions are
    /// reaped after a grace. The durable blob store is the source of truth;
    /// this set is the in-process cache the pruner consults without touching
    /// disk. It tracks marks for THIS process's lifetime -- sessions never
    /// outlive the process (PTYs die with it), so it needs no startup seed.
    persisted_windows: Mutex<HashSet<String>>,
    /// Optional hook fired when [`reap_exited`](Self::reap_exited) reaps a
    /// session that owns a window: the host installs it (on the SHARED terminal
    /// tenant only) to drop the standalone terminal's window-feed row when its
    /// PTY exits, so it does not linger. A workspace tenant
    /// leaves this unset -- a pane's death must never close its workspace window.
    window_reaper: Mutex<Option<WindowReaper>>,
    /// Optional hook fired on an EXPLICIT window discard (via
    /// [`reap_window_layout`](Self::reap_window_layout)) to delete the standalone
    /// terminal window's durable layout blob from the chan-server `terminal_blob`
    /// store, which chan-library cannot reach directly. The host wires this on
    /// the persisted terminal tenant only. Deliberately NOT fired from
    /// [`reap_exited`](Self::reap_exited): a persisted terminal whose PTY exits
    /// keeps its blob so the window resurrects on reconnect; only an explicit
    /// discard drops it.
    blob_reaper: Mutex<Option<BlobReaper>>,
    /// Systemd fd-store parking hook (see [`Registry::install_fd_parker`]).
    /// `None` on every non-systemd serving path.
    #[cfg(target_os = "linux")]
    fd_parker: Mutex<Option<FdStoreParker>>,
    /// Per-PTY-life epoch source. Each spawn (create OR restart) takes the next
    /// value and stamps it on the session, so a reattach can prove its cached
    /// scrollback belongs to the SAME incarnation: a restart reuses the session
    /// id but resets `seq` to 0, so without the bumped generation a stale client
    /// `since` cursor would desync silently (empty replay, no warning).
    generation_counter: AtomicU64,
    /// Unit-test seam that pins multiple creators after reservation but before
    /// PTY spawn, proving overlap without scheduler timing assumptions.
    #[cfg(test)]
    spawn_barrier: Mutex<Option<Arc<std::sync::Barrier>>>,
}

/// Host-installed hook to reap a terminal WINDOW row when its session is reaped.
/// Takes the reaped session's `window_id`. See
/// [`Registry::install_window_reaper`]. A newtype so [`Registry`] keeps deriving
/// `Debug` (a bare `dyn Fn` does not implement it).
#[derive(Clone)]
pub struct WindowReaper(Arc<dyn Fn(&str) + Send + Sync>);

impl WindowReaper {
    /// Wrap a closure taking the reaped session's `window_id`.
    pub fn new(f: impl Fn(&str) + Send + Sync + 'static) -> Self {
        Self(Arc::new(f))
    }

    fn call(&self, window_id: &str) {
        (self.0)(window_id)
    }
}

impl std::fmt::Debug for WindowReaper {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WindowReaper(..)")
    }
}

/// Host-installed hook to delete a discarded terminal window's durable layout
/// blob (the chan-server `terminal_blob` store, which chan-library can't reach).
/// Takes the discarded `window_id`. See [`Registry::install_blob_reaper`]. A
/// newtype so [`Registry`] keeps deriving `Debug` (a bare `dyn Fn` does not).
#[derive(Clone)]
pub struct BlobReaper(Arc<dyn Fn(&str) + Send + Sync>);

impl BlobReaper {
    /// Wrap a closure taking the discarded window's `window_id`.
    pub fn new(f: impl Fn(&str) + Send + Sync + 'static) -> Self {
        Self(Arc::new(f))
    }

    fn call(&self, window_id: &str) {
        (self.0)(window_id)
    }
}

impl std::fmt::Debug for BlobReaper {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("BlobReaper(..)")
    }
}

/// Spawn-time terminal-engine preference pull for registries that cannot
/// receive a config-change push. `Some(bool)` is a successful read;
/// `None` asks the registry to retain its last known value.
#[derive(Clone)]
pub struct TerminalBackendResolver(Arc<dyn Fn() -> Option<bool> + Send + Sync>);

impl TerminalBackendResolver {
    pub fn new(f: impl Fn() -> Option<bool> + Send + Sync + 'static) -> Self {
        Self(Arc::new(f))
    }

    fn resolve(&self) -> Option<bool> {
        (self.0)()
    }
}

impl std::fmt::Debug for TerminalBackendResolver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TerminalBackendResolver(..)")
    }
}

/// Namespace prefix for chan PTY entries in the systemd fd store.
#[cfg(target_os = "linux")]
pub const FDSTORE_FD_PREFIX: &str = "chan.pty.";

/// The fd-store entry name for a session incarnation:
/// `chan.pty.<session_id>.<child_pid>`. Session ids are 32 hex chars and the
/// pid is the last dot-separated segment (0 when the spawn reported no pid),
/// so consumers can parse the pid without knowing the id shape. A restart
/// mints a new name because the child pid changes.
#[cfg(target_os = "linux")]
pub fn fdstore_fd_name(session_id: &str, child_pid: Option<u32>) -> String {
    format!("{FDSTORE_FD_PREFIX}{session_id}.{}", child_pid.unwrap_or(0))
}

/// Store-side half of continuous PTY parking. The devserver implements this
/// against the systemd fd store; the registry drives it from session
/// lifecycle events. Absent (never installed) on every non-systemd serving
/// path, which keeps those paths byte-identical.
#[cfg(target_os = "linux")]
pub trait FdStorePark: Send + Sync {
    /// Store `fd` under `fd_name` AND durably commit the restart manifest
    /// before returning. The caller has already made the session's
    /// provisional parked state visible, so the commit's snapshot includes
    /// it. `false` means the fd is NOT stored (the implementation rolled
    /// back) and the caller must clear the provisional state.
    fn park(&self, fd_name: &str, fd: std::os::fd::BorrowedFd<'_>) -> bool;
    /// Remove `fd_name` from the store. Manifest republication may be
    /// deferred: a manifest entry without a stored fd is skipped and cleaned
    /// at the next boot, so staleness in this direction is safe.
    fn unpark(&self, fd_name: &str);
    /// Accept an inherited fd that the store already retains under
    /// `fd_name` (boot restore). No store call; `false` refuses adoption
    /// and the caller clears the provisional state.
    fn adopt(&self, fd_name: &str) -> bool;
    /// Manifest-relevant metadata of a parked session changed (e.g. a
    /// cross-window move rebound `window_id`).
    fn changed(&self);
}

/// Cloneable handle to the installed [`FdStorePark`] hook. A newtype so
/// [`Registry`] and [`Session`] keep deriving `Debug`.
#[cfg(target_os = "linux")]
#[derive(Clone)]
pub struct FdStoreParker(Arc<dyn FdStorePark>);

#[cfg(target_os = "linux")]
impl FdStoreParker {
    pub fn new(hook: impl FdStorePark + 'static) -> Self {
        Self(Arc::new(hook))
    }

    fn park(&self, fd_name: &str, fd: std::os::fd::BorrowedFd<'_>) -> bool {
        self.0.park(fd_name, fd)
    }

    fn unpark(&self, fd_name: &str) {
        self.0.unpark(fd_name)
    }

    fn adopt(&self, fd_name: &str) -> bool {
        self.0.adopt(fd_name)
    }

    fn changed(&self) {
        self.0.changed()
    }
}

#[cfg(target_os = "linux")]
impl std::fmt::Debug for FdStoreParker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("FdStoreParker(..)")
    }
}

/// A session's live fd-store reservation: the entry name plus the hook that
/// manages it, taken exactly once on the first close/exit path to reach it.
#[cfg(target_os = "linux")]
#[derive(Debug)]
struct ParkedFd {
    name: String,
    parker: FdStoreParker,
}

/// Parse the ordinal from a default `Terminal-N` name for lowest-free
/// numbering. Bare `Terminal` counts as `1` (matching the frontend
/// `nextTerminalTitle` regex `^Terminal(?:-(\d+))?$`). Any non-default name
/// (`build`, a team `lead-2`, ...) returns `None` so it never occupies a
/// numbering slot. `Terminal-0` and malformed forms (`Terminal-`,
/// `Terminal-1x`) are rejected.
fn parse_terminal_ordinal(name: &str) -> Option<u64> {
    let rest = name.strip_prefix("Terminal")?;
    if rest.is_empty() {
        return Some(1);
    }
    rest.strip_prefix('-')?
        .parse::<u64>()
        .ok()
        .filter(|&n| n >= 1)
}

/// Broadcast group default. A terminal with no explicit group belongs to
/// this group; it is never special-cased, just the value absence resolves
/// to (mirrors the SPA's `terminalTabGroup`).
pub const DEFAULT_TERMINAL_GROUP: &str = "default";

/// The server-authoritative terminal identity used by inventory, targeting,
/// and broadcast routing. Name and group share one mutex-backed value so no
/// reader can observe a pair assembled across two metadata commits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveTerminalMetadata {
    pub name: Option<String>,
    pub group: String,
}

#[derive(Debug, Clone)]
pub struct CreateOptions {
    pub size: PtySize,
    pub tab_name: Option<String>,
    /// Broadcast group label. `None` resolves to `DEFAULT_TERMINAL_GROUP`.
    /// Stored per live session so `cs term list` / `term write` can
    /// resolve groups server-side, and exported as `$CHAN_TAB_GROUP`.
    pub tab_group: Option<String>,
    pub window_id: Option<String>,
    pub mcp_env: bool,
    pub cwd: Option<PathBuf>,
    pub command: Option<String>,
    pub env: BTreeMap<String, String>,
}

/// Best-effort SPA layout coordinates supplied by a terminal WebSocket
/// attachment. Grouping them keeps the session creation API from growing one
/// positional argument per layout axis.
#[derive(Debug, Default)]
pub struct TerminalPlacement {
    pub pane_id: Option<String>,
    pub side: Option<PaneSide>,
    pub tab_id: Option<String>,
}

/// Optional per-call overrides for [`Registry::restart`], applied onto the
/// session's own `restart_options()`. `default()` (every field `None`)
/// restarts the session exactly as it was spawned.
#[derive(Debug, Clone, Default)]
pub struct RestartOverrides {
    pub tab_name: Option<String>,
    /// Outer `None` keeps the existing group; `Some(None)` sets the
    /// default group; `Some(Some(g))` sets group `g`.
    pub tab_group: Option<Option<String>>,
    pub window_id: Option<String>,
    /// The team-bootstrap orchestrator overrides command + env to flip the
    /// host's pre-existing PTY into the lead's session (e.g. host's shell ->
    /// lead's `claude` command). When `None`, restart preserves the original
    /// spawn command/env.
    pub command: Option<String>,
    pub env: Option<BTreeMap<String, String>>,
}

/// Read-only view of a live terminal session, for the control socket's
/// `cs term list`. The control socket holds a read handle to the
/// `Registry` and renders these grouped by `tab_group`.
#[derive(Debug, Clone)]
pub struct TerminalSessionSummary {
    pub session_id: String,
    pub tab_name: Option<String>,
    /// Name injected into this PTY incarnation. `None` only when provenance
    /// is genuinely unknown (for example, an imported legacy manifest).
    pub spawn_name: Option<String>,
    /// Resolved group (never empty; `DEFAULT_TERMINAL_GROUP` when unset).
    pub tab_group: String,
    /// The window that owns this session (the `?w=` key), or `None` for a session
    /// created outside a browser window. The control socket resolves it to the
    /// owning window's kind + connected state for `cs term list`.
    pub window_id: Option<String>,
    /// The SPA pane + tab this session was last attached under, threading
    /// window->pane->tab for `cs term list`. Best-effort: `None` until a browser
    /// attaches, and re-bound on split/move.
    pub pane_id: Option<String>,
    pub side: Option<PaneSide>,
    pub tab_id: Option<String>,
    pub cwd: Option<PathBuf>,
    /// Logical messages still waiting in this session's write queue. The same
    /// count the SPA badge shows, so `cs terminal list --json` can observe a
    /// drain from outside a browser.
    pub queue_depth: usize,
    /// The submit agent this session's terminal runs, derived server-side
    /// from its spawn command and `CHAN_AGENT` (the same rule the SPA session
    /// frame uses). `None` is a shell session with no submit chord. Exposed
    /// so a `cs terminal write` sender can discover a target's agent at
    /// runtime instead of guessing it.
    pub agent: Option<SubmitAgent>,
}

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredPtySize {
    pub rows: u16,
    pub cols: u16,
    pub pixel_width: u16,
    pub pixel_height: u16,
}

#[cfg(target_os = "linux")]
impl From<PtySize> for StoredPtySize {
    fn from(size: PtySize) -> Self {
        Self {
            rows: size.rows,
            cols: size.cols,
            pixel_width: size.pixel_width,
            pixel_height: size.pixel_height,
        }
    }
}

#[cfg(target_os = "linux")]
impl From<StoredPtySize> for PtySize {
    fn from(size: StoredPtySize) -> Self {
        Self {
            rows: size.rows,
            cols: size.cols,
            pixel_width: size.pixel_width,
            pixel_height: size.pixel_height,
        }
    }
}

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FdStoreSessionMeta {
    pub tenant_prefix: String,
    pub session_id: String,
    pub tab_name: Option<String>,
    pub tab_group: Option<String>,
    /// Immutable name/group injected into the current PTY incarnation.
    /// Defaults preserve compatibility with manifests written before spawn
    /// provenance was persisted; missing values remain unknown on import.
    #[serde(default)]
    pub spawn_name: Option<String>,
    #[serde(default)]
    pub spawn_group: Option<String>,
    pub window_id: Option<String>,
    pub pane_id: Option<String>,
    #[serde(default)]
    pub side: Option<PaneSide>,
    pub tab_id: Option<String>,
    pub cwd: Option<PathBuf>,
    pub command: Option<String>,
    pub env: BTreeMap<String, String>,
    pub mcp_env: bool,
    pub child_pid: Option<u32>,
    pub size: StoredPtySize,
    pub seq: u64,
    pub generation: u64,
    pub alt_screen: bool,
    pub private_modes: Vec<u16>,
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
pub struct FdStoreManifestEntry {
    /// The fd-store entry name this session is parked under.
    pub fd_name: String,
    pub meta: FdStoreSessionMeta,
    /// Bounded tail of the server replay ring, carried through the restart
    /// manifest so a fresh browser attach can repaint the imported PTY.
    pub replay: Vec<u8>,
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
pub struct FdStoreSessionImport {
    pub meta: FdStoreSessionMeta,
    pub master_fd: OwnedFd,
    pub replay: Vec<u8>,
}

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FdStoreSkippedSession {
    pub tenant_prefix: String,
    pub session_id: String,
    pub window_id: Option<String>,
    pub child_pid: Option<u32>,
    pub reason: String,
}

#[cfg(target_os = "linux")]
impl FdStoreSkippedSession {
    pub fn from_meta(meta: &FdStoreSessionMeta, reason: impl Into<String>) -> Self {
        Self {
            tenant_prefix: meta.tenant_prefix.clone(),
            session_id: meta.session_id.clone(),
            window_id: meta.window_id.clone(),
            child_pid: meta.child_pid,
            reason: reason.into(),
        }
    }
}

#[cfg(target_os = "linux")]
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct FdStoreRestoreReport {
    pub restored: usize,
    pub skipped: Vec<String>,
    pub skipped_sessions: Vec<FdStoreSkippedSession>,
}

#[cfg(target_os = "linux")]
impl FdStoreRestoreReport {
    pub fn skip_session(&mut self, meta: &FdStoreSessionMeta, reason: impl Into<String>) {
        let reason = reason.into();
        let session_id = if meta.session_id.is_empty() {
            "<missing>"
        } else {
            meta.session_id.as_str()
        };
        self.skipped.push(format!("session {session_id}: {reason}"));
        self.skipped_sessions
            .push(FdStoreSkippedSession::from_meta(meta, reason));
    }
}

/// One live terminal session in the cross-window roster the SPA reads to
/// render broadcast targets + indicators across every window of a tenant.
/// Unlike [`TerminalSessionSummary`] (the `cs term list` view, grouped by
/// `tab_group` with a live `cwd`), this carries the `window_id` and the
/// per-session `broadcast` toggle and omits the (expensive) cwd lookup: the
/// roster is pushed on every change, so it stays cheap to build. Serialized
/// directly into the `/ws` `terminal_roster` frame and the
/// `GET /api/terminals/roster` seed body.
#[derive(Debug, Clone, Serialize)]
pub struct RosterEntry {
    pub id: String,
    pub tab_name: Option<String>,
    /// Resolved group (never empty; `DEFAULT_TERMINAL_GROUP` when unset),
    /// matching the SPA's `terminalTabGroup` so a group compares equal on
    /// both sides of the wire.
    pub tab_group: String,
    pub window_id: Option<String>,
    /// The session's own broadcast toggle, synced from the SPA via the
    /// `set-broadcast` WS frame. Cross-window input is only fanned to
    /// members with this on (see [`Registry::broadcast_input_cross_window`]).
    pub broadcast: bool,
}

fn live_metadata_matches(
    metadata: &LiveTerminalMetadata,
    tab_name: Option<&str>,
    tab_group: Option<&str>,
) -> bool {
    tab_name.is_none_or(|name| metadata.name.as_deref() == Some(name))
        && tab_group.is_none_or(|group| metadata.group == group)
}

/// Result of enqueuing a `cs terminal write` onto the matched sessions'
/// write queues. `queued` is how many sessions accepted it, `full` how many
/// were already at `WRITE_QUEUE_CAP` (the write was dropped for those), and
/// `oversized` how many refused a body above `MAX_TERMINAL_WRITE_BYTES`.
/// `position` is the message depth after the push when EXACTLY one session
/// matched (the caller's 1-based position among the pending messages; `None`
/// for a broadcast or a full single). `diverged` lists each QUEUED session
/// whose server-derived agent disagrees with the agent the sender named, so
/// the control reply can say what was actually applied.
#[derive(Debug, Default, Clone)]
pub struct EnqueueOutcome {
    pub queued: usize,
    pub full: usize,
    pub oversized: usize,
    pub position: Option<usize>,
    pub diverged: Vec<SubmitDivergence>,
}

/// One queued session whose own derived agent disagrees with the agent the
/// sender named in `--submit`. The requested chord is applied either way;
/// this records what the session looks like from the spawn side, so the reply
/// can surface the disagreement without acting on it. `derived: None` is a
/// session whose spawn command names no agent, which is precisely the case a
/// sender overrides when an agent was started by hand inside a shell session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmitDivergence {
    /// The session's tab name, or its session id when unnamed, so the reply
    /// can address the target the way the sender selected it.
    pub tab: String,
    pub derived: Option<SubmitAgent>,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TerminalExit {
    Code { code: u32 },
    Signal { signal: String },
    Unknown,
}

impl TerminalExit {
    fn from_status(status: &portable_pty::ExitStatus) -> Self {
        if let Some(signal) = status.signal() {
            return Self::Signal {
                signal: signal.to_string(),
            };
        }
        Self::Code {
            code: status.exit_code(),
        }
    }

    /// The exit code for the terminal `/ws` exit frame, `None` when there is
    /// no honest one to report. A signal death maps to the generic failure
    /// code 1; `Unknown` stays codeless -- it means the real status is
    /// unobtainable (a restored session's shell was reparented when the old
    /// server died), and inventing a number there mislabels a clean `logout`
    /// as a failure.
    pub fn wire_code(&self) -> Option<u32> {
        match self {
            Self::Code { code } => Some(*code),
            Self::Signal { .. } => Some(1),
            Self::Unknown => None,
        }
    }
}

impl std::fmt::Display for TerminalExit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Code { code } => write!(f, "status {code}"),
            Self::Signal { signal } => write!(f, "signal {signal}"),
            Self::Unknown => f.write_str("unknown status"),
        }
    }
}

#[derive(Debug, Clone)]
pub enum SessionEvent {
    Output(Vec<u8>),
    Activity {
        bytes_since_focus: u64,
    },
    Resize(PtySize),
    Exit(TerminalExit),
    Error(String),
    Closed(CloseReason),
    /// The session was RESTARTED in place: its PTY is being replaced under the
    /// SAME session id (the roster keeps the id). Broadcast on the OLD
    /// session's channel just before it is killed, so an attached `/ws` reader
    /// re-attaches to the relaunched session instead of tearing the socket
    /// down -- the SPA tab stays put and transparently shows the new shell (no
    /// `Closed`/`Exit`, so it is never dropped). Consumed server-side in the
    /// `/ws` loop; never serialized to a client frame.
    Restarted,
    /// The write queue's MESSAGE depth changed after an enqueue or drain. The
    /// depth is the absolute logical-message count, so consumers stay
    /// idempotent under duplicate events and multi-window attaches.
    QueueDepth(usize),
    /// A Rich Prompt message began delivery. `depth` is the message depth of
    /// the remainder, broadcast just before the matching `QueueDepth` so a
    /// consumer resolving `id` already has the new count.
    PromptDelivered {
        id: String,
        depth: usize,
    },
}

#[derive(Debug)]
pub struct AttachHandle {
    id: String,
    session: Arc<Session>,
    pub rx: broadcast::Receiver<SessionEvent>,
    pub replay: Vec<Vec<u8>>,
    pub seq: u64,
    /// This session incarnation's epoch, sent in the attach prelude so the
    /// client can prove a cached scrollback snapshot belongs to the SAME PTY
    /// life before resuming from a `since` cursor (a restart bumps it).
    pub generation: u64,
    pub missed_bytes: u64,
    pub alt_screen: bool,
    /// Bytes re-asserting the live tracked private-mode set (DECCKM + mouse +
    /// bracketed-paste the foreground program had on) so a fresh client that
    /// came up at defaults regains them. Empty for a plain shell. Sent by the
    /// attach prelude after the alt-screen prelude, before the redraw nudge.
    pub mode_reassert: Vec<u8>,
}

impl AttachHandle {
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The command stored for this PTY incarnation. A restart handle reads
    /// from the replacement session, so callers never retain stale launch
    /// identity after command overrides.
    pub fn spawn_command(&self) -> Option<&str> {
        self.session.spawn_opts.command.as_deref()
    }

    /// One value from the environment stored for this PTY incarnation.
    /// This intentionally exposes only lookup, not the full map: callers that
    /// derive terminal identity need `CHAN_AGENT`, while spawn configuration
    /// remains registry-owned.
    pub fn spawn_env(&self, key: &str) -> Option<&str> {
        self.session.spawn_opts.env.get(key).map(String::as_str)
    }

    /// Current server-authoritative live name/group pair.
    pub fn live_metadata(&self) -> LiveTerminalMetadata {
        self.session.live_metadata()
    }

    /// Immutable name injected into this PTY incarnation, or unknown after a
    /// legacy fd-store import.
    pub fn spawn_name(&self) -> Option<&str> {
        self.session.spawn_name.as_deref()
    }

    /// Immutable group injected into this PTY incarnation, or unknown after a
    /// legacy fd-store import.
    pub fn spawn_group(&self) -> Option<&str> {
        self.session.spawn_group.as_deref()
    }

    pub fn send_input(&self, data: &[u8]) {
        self.session.send_input(data);
    }

    /// Wait until this PTY enables bracketed-paste mode, the readiness signal
    /// that an interactive agent's TUI owns the terminal input. Returns false
    /// when the PTY ends or is replaced before reaching that state. The caller
    /// owns any deadline appropriate to its operation.
    pub async fn wait_for_bracketed_paste(&mut self) -> bool {
        loop {
            if self.session.closed.load(Ordering::Relaxed)
                || self
                    .session
                    .exit
                    .lock()
                    .expect("session exit poisoned")
                    .is_some()
            {
                return false;
            }
            if self
                .session
                .private_modes
                .lock()
                .expect("terminal private modes poisoned")
                .contains(&BRACKETED_PASTE_MODE)
            {
                return true;
            }
            match self.rx.recv().await {
                Ok(SessionEvent::Exit(_) | SessionEvent::Closed(_) | SessionEvent::Restarted) => {
                    return false
                }
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => return false,
            }
        }
    }

    /// Enqueue a Rich Prompt message onto this session's `cs terminal write`
    /// FIFO instead of writing it straight to the PTY, so bubble prompts and
    /// CLI pokes share ONE queue + one drain. The logical text and resolved
    /// submit spec stay intact until delivery. The whole message is
    /// all-or-nothing at the cap. Returns the message depth
    /// after the push (the message's 1-based position), or `None` when the
    /// message does not fit.
    pub fn enqueue_prompt(
        &self,
        data: String,
        submit: Option<ResolvedSubmit>,
        prompt_id: Option<String>,
    ) -> Option<usize> {
        self.session.enqueue_prompt(data, submit, prompt_id)
    }

    /// Current MESSAGE depth of this session's write queue, for the `session` frame's depth re-sync
    /// on every (re)attach.
    pub fn queue_depth(&self) -> usize {
        self.session.queue_depth()
    }

    /// Recall a still-queued Rich Prompt message by its `prompt_id`, removing
    /// every queued write that shares it. Returns `true` if it was still
    /// queued (and removed), `false` if it had already drained to the PTY.
    /// Backs the `cancel-prompt` WS frame; the depth re-sync rides the normal
    /// `QueueDepth` broadcast on a successful removal.
    pub fn cancel_prompt(&self, prompt_id: &str) -> bool {
        self.session.cancel_prompt(prompt_id)
    }

    /// The `prompt_id`s of the Rich Prompt messages still queued, in FIFO
    /// order, for the `session` frame so a reattaching SPA can re-prove a
    /// restored pending message is still queued (vs the anonymous depth).
    pub fn queued_prompt_ids(&self) -> Vec<String> {
        self.session.queued_prompt_ids()
    }

    pub fn resize(&self, size: PtySize) {
        self.session.resize(size);
    }

    pub fn set_focused(&self, focused: bool) {
        self.session.set_focused(focused);
    }

    /// Sync this session's broadcast toggle from the SPA. The caller
    /// (`terminal_ws`) follows up with `Registry::notify_roster_change`
    /// so the new state reaches other windows' rosters.
    pub fn set_broadcast(&self, on: bool) {
        self.session.set_broadcast(on);
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

    /// Return an owned PTY cwd probe for composition with other blocking
    /// filesystem work in one blocking-pool operation.
    pub fn blocking_cwd_probe(&self) -> impl FnOnce() -> Option<PathBuf> + Send + 'static {
        let session = Arc::clone(&self.session);
        move || session.cwd()
    }

    /// Like [`cwd`](Self::cwd) but runs the probe (which shells `lsof` on
    /// macOS) on the blocking pool, so an async caller never stalls the
    /// runtime on the PTY's cwd lookup. `None` if the blocking task is
    /// cancelled or the cwd can't be read.
    pub async fn cwd_blocking(&self) -> Option<PathBuf> {
        tokio::task::spawn_blocking(self.blocking_cwd_probe())
            .await
            .ok()
            .flatten()
    }
}

impl Drop for AttachHandle {
    fn drop(&mut self) {
        // On the last client detaching (count 1 -> 0), stamp the detach time so
        // the orphan-grace pruner can age the session from when it went idle,
        // not from its last output byte.
        if self.session.attach_count.fetch_sub(1, Ordering::Relaxed) == 1 {
            self.session
                .detached_at
                .store(now_unix_secs() as i64, Ordering::Relaxed);
        }
    }
}

/// A name held while one PTY incarnation is being spawned. Dropping an
/// uncommitted reservation releases it, including every early spawn error.
struct MetadataReservation<'a> {
    reservations: &'a Mutex<HashSet<String>>,
    metadata: LiveTerminalMetadata,
    name: String,
    active: bool,
}

impl MetadataReservation<'_> {
    fn release_locked(&mut self, reservations: &mut HashSet<String>) {
        if self.active {
            let removed = reservations.remove(&self.name);
            debug_assert!(removed, "active terminal name reservation disappeared");
            self.active = false;
        }
    }
}

impl Drop for MetadataReservation<'_> {
    fn drop(&mut self) {
        if self.active {
            self.reservations
                .lock()
                .expect("terminal name reservations poisoned")
                .remove(&self.name);
        }
    }
}

impl Registry {
    pub fn new(config: RegistryConfig) -> Self {
        let terminal_ghostty = config.terminal.ghostty;
        Self {
            config,
            terminal_ghostty: AtomicBool::new(terminal_ghostty),
            terminal_backend_resolver: Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
            name_reservations: Mutex::new(HashSet::new()),
            last_exit: Arc::new(Mutex::new(None)),
            roster_notify: Arc::new(Notify::new()),
            default_command: Mutex::new(None),
            persisted_windows: Mutex::new(HashSet::new()),
            window_reaper: Mutex::new(None),
            blob_reaper: Mutex::new(None),
            #[cfg(target_os = "linux")]
            fd_parker: Mutex::new(None),
            generation_counter: AtomicU64::new(0),
            #[cfg(test)]
            spawn_barrier: Mutex::new(None),
        }
    }

    /// Refresh the backend preference sampled by subsequent PTY spawns.
    pub fn set_terminal_backend(&self, ghostty: bool) {
        self.terminal_ghostty.store(ghostty, Ordering::Relaxed);
    }

    /// Install the backend preference pull used by a long-lived terminal-only
    /// tenant. A later install replaces the prior resolver.
    pub fn install_terminal_backend_resolver(&self, resolver: TerminalBackendResolver) {
        // A poisoned cell still holds a callable resolver, so recovering keeps
        // spawns working instead of turning one panic into a process abort.
        *self
            .terminal_backend_resolver
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(resolver);
    }

    /// Sample the configured backend for one PTY spawn. A successful pull also
    /// refreshes the live cell. `None` means the backing store is malformed or
    /// unreadable: terminal creation stays fail-open and uses the LAST good
    /// value, which may remain stale until a later spawn can read the store.
    fn resolve_terminal_backend(&self) -> bool {
        let resolver = self
            .terminal_backend_resolver
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        if let Some(ghostty) = resolver.and_then(|resolver| resolver.resolve()) {
            self.terminal_ghostty.store(ghostty, Ordering::Relaxed);
            ghostty
        } else {
            self.terminal_ghostty.load(Ordering::Relaxed)
        }
    }

    /// Install the systemd fd-store parking hook. Installed by the devserver
    /// (via the host, at tenant mount) only when it runs under systemd
    /// notify; every other serving path leaves it unset and no session is
    /// ever parked. A later install replaces the prior hook.
    #[cfg(target_os = "linux")]
    pub fn install_fd_parker(&self, parker: FdStoreParker) {
        *self.fd_parker.lock().expect("terminal registry poisoned") = Some(parker);
    }

    #[cfg(target_os = "linux")]
    fn fd_parker(&self) -> Option<FdStoreParker> {
        self.fd_parker
            .lock()
            .expect("terminal registry poisoned")
            .clone()
    }

    /// Park every live windowed session that is not parked yet: the
    /// activation reconcile for sessions that spawned while parking was
    /// still disabled (boot, before the inherited-fd restore applied).
    #[cfg(target_os = "linux")]
    pub fn park_unparked_windowed_sessions(&self) {
        let Some(parker) = self.fd_parker() else {
            return;
        };
        let candidates: Vec<Arc<Session>> = {
            let sessions = self.sessions.lock().expect("terminal registry poisoned");
            sessions
                .values()
                .filter(|session| !session.closed.load(Ordering::Relaxed))
                .filter(|session| session.window_id().is_some())
                .filter(|session| !session.is_fdstore_parked())
                .cloned()
                .collect()
        };
        for session in candidates {
            session.park_fdstore(&parker);
        }
    }

    /// Park `session` if parking is enabled and it belongs to a window.
    /// Windowless sessions are not restorable (boot restore requires a
    /// persisted window row), so they are never parked. Must be called with
    /// no registry lock held: the park commit snapshots every registry.
    #[cfg(target_os = "linux")]
    fn park_if_windowed(&self, session: &Arc<Session>) {
        let Some(parker) = self.fd_parker() else {
            return;
        };
        if session.window_id().is_none() {
            return;
        }
        session.park_fdstore(&parker);
    }

    /// Install the hook that reaps a standalone terminal's WINDOW row when its
    /// session is reaped by [`reap_exited`](Self::reap_exited) (PTY exited and
    /// no client attached). The host wires this on the SHARED terminal tenant
    /// only, so a workspace tenant's pane death never closes its workspace
    /// window. A later install replaces the prior hook.
    pub fn install_window_reaper(&self, reaper: WindowReaper) {
        *self
            .window_reaper
            .lock()
            .expect("terminal registry poisoned") = Some(reaper);
    }

    /// Install the hook that deletes a discarded window's durable terminal layout
    /// blob ([`reap_window_layout`](Self::reap_window_layout)). The host wires
    /// this on the persisted terminal tenant only (the one whose `DELETE
    /// /api/session` routes to `terminal_blob`); ephemeral/control tenants leave
    /// it unset. A later install replaces the prior hook.
    pub fn install_blob_reaper(&self, reaper: BlobReaper) {
        *self.blob_reaper.lock().expect("terminal registry poisoned") = Some(reaper);
    }

    /// Reap the durable terminal layout blob for an EXPLICITLY discarded
    /// `window_id` via the installed [`BlobReaper`]. A no-op when no hook is
    /// installed (workspace / ephemeral / control tenants). The hook is cloned
    /// out under the lock and the (blocking, file-I/O) delete runs after release,
    /// matching the lock discipline of [`session_summaries`](Self::session_summaries).
    pub fn reap_window_layout(&self, window_id: &str) {
        let reaper = self
            .blob_reaper
            .lock()
            .expect("terminal registry poisoned")
            .clone();
        if let Some(reaper) = reaper {
            reaper.call(window_id);
        }
    }

    /// Settle one complete live metadata value against the sessions and
    /// in-flight spawn reservations already locked by the caller. The caller
    /// decides whether to reserve the result for a spawn or commit it directly
    /// to an existing session.
    fn settle_metadata_locked(
        sessions: &HashMap<String, Arc<Session>>,
        reservations: &HashSet<String>,
        proposed_name: Option<String>,
        proposed_group: Option<String>,
        exclude_id: Option<&str>,
    ) -> LiveTerminalMetadata {
        let name_taken = |candidate: &str| {
            reservations.contains(candidate)
                || sessions.iter().any(|(id, session)| {
                    exclude_id != Some(id.as_str())
                        && !session.closed.load(Ordering::Relaxed)
                        && session.live_metadata().name.as_deref() == Some(candidate)
                })
        };

        let proposed_name = proposed_name.filter(|name| !name.is_empty());
        let name = match proposed_name {
            Some(base) if !name_taken(&base) => base,
            Some(base) => (2u64..)
                .map(|suffix| format!("{base}-{suffix}"))
                .find(|candidate| !name_taken(candidate))
                .expect("the naturals always contain a free terminal suffix"),
            None => (1u64..)
                .map(|suffix| format!("Terminal-{suffix}"))
                .find(|candidate| !name_taken(candidate))
                .expect("the naturals always contain a free terminal name"),
        };
        LiveTerminalMetadata {
            name: Some(name),
            group: proposed_group
                .filter(|group| !group.is_empty())
                .unwrap_or_else(|| DEFAULT_TERMINAL_GROUP.to_string()),
        }
    }

    /// Settle and reserve metadata for a PTY spawn without retaining the
    /// registry lock across PTY creation. The returned guard releases the
    /// reservation on every error path unless insertion consumes it.
    fn reserve_metadata(
        &self,
        proposed_name: Option<String>,
        proposed_group: Option<String>,
        exclude_id: Option<&str>,
    ) -> MetadataReservation<'_> {
        let sessions = self.sessions.lock().expect("terminal registry poisoned");
        let mut reservations = self
            .name_reservations
            .lock()
            .expect("terminal name reservations poisoned");
        let metadata = Self::settle_metadata_locked(
            &sessions,
            &reservations,
            proposed_name,
            proposed_group,
            exclude_id,
        );
        let name = metadata
            .name
            .clone()
            .expect("settled spawn metadata always has a name");
        let inserted = reservations.insert(name.clone());
        debug_assert!(inserted, "settlement returned a reserved terminal name");
        MetadataReservation {
            reservations: &self.name_reservations,
            metadata,
            name,
            active: true,
        }
    }

    #[cfg(test)]
    fn wait_at_spawn_barrier(&self) {
        let barrier = self
            .spawn_barrier
            .lock()
            .expect("terminal spawn barrier poisoned")
            .clone();
        if let Some(barrier) = barrier {
            barrier.wait();
        }
    }

    /// Hand out the next per-tenant default terminal name: the LOWEST-FREE
    /// `Terminal-N` (`N >= 1`) not currently in use by a live session, so a
    /// number freed by a closed terminal is reused (open Terminal-1 +
    /// Terminal-2, close Terminal-2, the next open is Terminal-2 again).
    /// Backs `GET /api/terminal/next-name`. Per-tenant because it scans only
    /// THIS registry's sessions: standalone terminal windows share one
    /// registry; each workspace has its own.
    ///
    /// This only SUGGESTS a name (the session isn't registered until the WS
    /// spawn), so two near-simultaneous calls can receive the same suggestion.
    /// Creation settles and reserves the final unique name server-side.
    pub fn next_terminal_name(&self) -> String {
        let taken: HashSet<u64> = {
            let sessions = self.sessions.lock().expect("terminal registry poisoned");
            let reservations = self
                .name_reservations
                .lock()
                .expect("terminal name reservations poisoned");
            sessions
                .values()
                .filter(|s| !s.closed.load(Ordering::Relaxed))
                .filter_map(|s| {
                    s.live_metadata()
                        .name
                        .as_deref()
                        .and_then(parse_terminal_ordinal)
                })
                .chain(
                    reservations
                        .iter()
                        .filter_map(|name| parse_terminal_ordinal(name)),
                )
                .collect()
        };
        let n = (1u64..)
            .find(|n| !taken.contains(n))
            .expect("the naturals always contain a free slot");
        format!("Terminal-{n}")
    }

    /// A handle to the roster-change signal for the broadcaster task to
    /// await. Cloning the `Arc` is cheap; both the registry and the task
    /// reference the same `Notify`.
    pub fn roster_notify(&self) -> Arc<Notify> {
        self.roster_notify.clone()
    }

    /// Wake the roster broadcaster so it republishes a fresh snapshot.
    /// Called internally on every map mutation (create / close / restart)
    /// and by the terminal WS handler after a `set-broadcast` toggle (a
    /// session-field change the map does not see).
    pub fn notify_roster_change(&self) {
        self.roster_notify.notify_one();
    }

    /// Atomically settle and commit a complete live name/group proposal. The
    /// current session is excluded from its own collision check, so submitting
    /// an unchanged name is stable. Returns `None` only when the session is no
    /// longer live.
    pub fn update_live_metadata(
        &self,
        id: &str,
        proposed_name: String,
        proposed_group: Option<String>,
    ) -> Option<LiveTerminalMetadata> {
        let sessions = self.sessions.lock().expect("terminal registry poisoned");
        let reservations = self
            .name_reservations
            .lock()
            .expect("terminal name reservations poisoned");
        let session = sessions.get(id)?.clone();
        if session.closed.load(Ordering::Relaxed) {
            return None;
        }
        let settled = Self::settle_metadata_locked(
            &sessions,
            &reservations,
            Some(proposed_name),
            proposed_group,
            Some(id),
        );
        *session
            .live_metadata
            .lock()
            .expect("terminal live metadata poisoned") = settled.clone();
        // `reservations` is intentionally held through the metadata write:
        // settlement and publication are one uniqueness critical section.
        drop(reservations);
        drop(sessions);
        #[cfg(target_os = "linux")]
        session.parked_changed();
        self.notify_roster_change();
        Some(settled)
    }

    /// The window that owns a live session, for routing a cross-window
    /// broadcast-toggle command back to the right SPA window. Outer `None`
    /// = no such live session; inner `None` = the session has no owning
    /// window (created outside a browser window, so not remote-controllable).
    pub fn session_window_id(&self, id: &str) -> Option<Option<String>> {
        let sessions = self.sessions.lock().expect("terminal registry poisoned");
        let session = sessions.get(id)?;
        if session.closed.load(Ordering::Relaxed) {
            return None;
        }
        Some(session.window_id())
    }

    /// The live session's current incarnation epoch, or `None` if there is no
    /// such live session. Used by the WS attach path to honor a client `since`
    /// cursor only when the client's cached generation still matches.
    fn session_generation(&self, id: &str) -> Option<u64> {
        let sessions = self.sessions.lock().expect("terminal registry poisoned");
        let session = sessions.get(id)?;
        if session.closed.load(Ordering::Relaxed) {
            return None;
        }
        Some(session.generation())
    }

    /// Snapshot of every live session for the cross-window roster. Mirrors
    /// [`Registry::session_summaries`] but carries `window_id` + the
    /// `broadcast` toggle and skips the per-session cwd probe (the roster
    /// is pushed on every change, so it must stay cheap).
    pub fn roster(&self) -> Vec<RosterEntry> {
        let sessions = self.sessions.lock().expect("terminal registry poisoned");
        sessions
            .values()
            .filter(|session| !session.closed.load(Ordering::Relaxed))
            .map(|session| {
                let metadata = session.live_metadata();
                RosterEntry {
                    id: session.id.clone(),
                    tab_name: metadata.name,
                    tab_group: metadata.group,
                    window_id: session.window_id(),
                    broadcast: session.broadcast.load(Ordering::Relaxed),
                }
            })
            .collect()
    }

    /// The exit state of any PTY in this registry that has exited, or `None`
    /// while they all run. For the desktop's control-terminal connect flow:
    /// the control tenant runs exactly one PTY (the connect script), so
    /// `Some(exit)` means that script exited -- the token will never come, so
    /// the desktop can stop the scrape early (instead of the full timeout) and
    /// survey on a failing connect instead of stranding an empty window.
    /// The registry-level copy is sticky after a session has been removed by
    /// the websocket path.
    pub fn last_exit(&self) -> Option<TerminalExit> {
        if let Some(exit) = self
            .last_exit
            .lock()
            .expect("terminal registry poisoned")
            .clone()
        {
            return Some(exit);
        }
        let sessions = self.sessions.lock().expect("terminal registry poisoned");
        sessions
            .values()
            .find_map(|session| session.exit.lock().expect("session exit poisoned").clone())
    }

    /// Set the command this tenant's terminals run when an open request
    /// carries no command of its own. `None` restores the default shell.
    /// A single-purpose terminal tenant sets this once at creation so its
    /// window's PTY runs a given command (e.g. an interactive connect
    /// script) instead of an interactive shell.
    pub fn set_default_command(&self, command: Option<String>) {
        *self
            .default_command
            .lock()
            .expect("terminal registry poisoned") = command;
    }

    pub fn create(&self, mut opts: CreateOptions) -> Result<AttachHandle, CreateError> {
        // Clear dead-process ghosts before minting: a killed session lingers in
        // the map (its controller thread records `exit` on exit but never
        // reaps the entry), so it would hold its tab name + occupy a
        // `session_cap` slot against a re-spawn under the same name. See
        // [`reap_exited`].
        self.reap_exited();
        // Global pre-spawn gate (fd pressure -- an fd_snapshot read_dir): does
        // not need the sessions lock, so run it before taking it, keeping that
        // blocking I/O off the registry lock.
        reject_terminal_spawn_if_fd_pressure()?;
        // Validate the cap + mint the id under the lock, but SPAWN (openpty +
        // fork/exec) OUTSIDE it so a create's PTY launch doesn't stall every
        // other terminal op on the registry mutex.
        let (id, announce_command) = {
            let sessions = self.sessions.lock().expect("terminal registry poisoned");
            if sessions.len() >= self.config.terminal.session_cap {
                return Err(CreateError::Capped);
            }
            // A tenant opened to run a specific command applies it to any
            // session that brings none of its own, so the window's terminal
            // runs the command; an explicit per-session command wins.
            //
            // Only a session that inherits the TENANT's default command
            // (a single-purpose / devserver CONTROL tenant) echoes the bare
            // `{command}\r\n` banner. A per-session command (a team agent
            // terminal spawned via `POST /api/terminals`, or a restart override)
            // is NOT a single-purpose tenant and gets no banner.
            let announce_command = if opts.command.is_none() {
                let default = self
                    .default_command
                    .lock()
                    .expect("terminal registry poisoned")
                    .clone();
                let from_tenant_default = default.is_some();
                opts.command = default;
                from_tenant_default
            } else {
                false
            };
            (self.unused_id(&sessions), announce_command)
        };
        let mut reservation =
            self.reserve_metadata(opts.tab_name.take(), opts.tab_group.take(), None);
        opts.tab_name = reservation.metadata.name.clone();
        opts.tab_group = Some(reservation.metadata.group.clone());
        #[cfg(test)]
        self.wait_at_spawn_barrier();
        let mut config = self.config.clone();
        config.terminal.ghostty = self.resolve_terminal_backend();
        let session = Session::spawn(
            id.clone(),
            config,
            opts,
            announce_command,
            self.generation_counter.fetch_add(1, Ordering::Relaxed),
            self.last_exit.clone(),
        )
        .map_err(CreateError::Spawn)?;
        let mut sessions = self.sessions.lock().expect("terminal registry poisoned");
        let mut reservations = self
            .name_reservations
            .lock()
            .expect("terminal name reservations poisoned");
        // Re-check under the re-acquired lock: a concurrent create may have
        // filled the cap (or -- astronomically -- taken the random id) while we
        // spawned. If so, reap the orphan PTY before dropping it (no Drop).
        if sessions.len() >= self.config.terminal.session_cap || sessions.contains_key(&id) {
            reservation.release_locked(&mut reservations);
            drop(reservations);
            drop(sessions);
            session.close(CloseReason::Shutdown);
            return Err(CreateError::Capped);
        }
        sessions.insert(id.clone(), session.clone());
        // Convert reservation -> live session while both uniqueness stores
        // are locked, so another settlement never sees an unowned gap.
        reservation.release_locked(&mut reservations);
        drop(reservations);
        drop(sessions);
        // Park after the insert so the park commit's host snapshot sees the
        // session; a windowed create only reports success once its fd name
        // is durably in the restart manifest.
        #[cfg(target_os = "linux")]
        self.park_if_windowed(&session);
        self.notify_roster_change();
        Ok(session.attach(Some(0)))
    }

    pub fn restart(&self, id: &str, overrides: RestartOverrides) -> Result<bool, CreateError> {
        let RestartOverrides {
            tab_name,
            tab_group,
            window_id,
            command,
            env,
        } = overrides;
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
        if let Some(group) = tab_group {
            opts.tab_group = group;
        }
        if window_id.is_some() {
            opts.window_id = window_id;
        }
        // Command/env override semantics: see [`RestartOverrides::command`].
        if let Some(cmd) = command {
            opts.command = Some(cmd);
        }
        if let Some(extra_env) = env {
            opts.env.extend(extra_env);
        }
        let mut reservation =
            self.reserve_metadata(opts.tab_name.take(), opts.tab_group.take(), Some(id));
        opts.tab_name = reservation.metadata.name.clone();
        opts.tab_group = Some(reservation.metadata.group.clone());
        // A restart re-runs the command but does NOT re-echo the running banner:
        // the banner names a tenant's launch command (control connect), while a
        // restart override (e.g. the team-bootstrap flip from a host shell to
        // the lead's `claude`) is not a single-purpose-tenant launch.
        let mut config = self.config.clone();
        config.terminal.ghostty = self.resolve_terminal_backend();
        let session = Session::spawn(
            id.to_string(),
            config,
            opts,
            false,
            self.generation_counter.fetch_add(1, Ordering::Relaxed),
            self.last_exit.clone(),
        )
        .map_err(CreateError::Spawn)?;
        let mut sessions = self.sessions.lock().expect("terminal registry poisoned");
        let mut reservations = self
            .name_reservations
            .lock()
            .expect("terminal name reservations poisoned");
        match sessions.get(id) {
            Some(current) if Arc::ptr_eq(current, &old) => {
                sessions.insert(id.to_string(), session.clone());
                reservation.release_locked(&mut reservations);
                drop(reservations);
                drop(sessions);
                // Restart transaction order: park the NEW incarnation (store +
                // durable manifest commit) BEFORE the old entry is removed and
                // its child killed, so no crash instant leaves the terminal
                // absent from both the store and the manifest. The names never
                // collide (the child pid differs). `close_for_restart` unparks
                // the old incarnation on its way to the kill.
                #[cfg(target_os = "linux")]
                self.park_if_windowed(&session);
                // Signal an in-place restart (not a close) on the old channel so
                // an attached `/ws` reader re-attaches to the relaunched session
                // under the same id instead of dropping the tab.
                old.close_for_restart();
                self.notify_roster_change();
                Ok(true)
            }
            // A concurrent op replaced or removed the session while we spawned;
            // the freshly-spawned `session` was never inserted, so reap its PTY
            // before dropping it (Session has no Drop) -- else the orphan child +
            // fds leak.
            Some(_) | None => {
                reservation.release_locked(&mut reservations);
                drop(reservations);
                drop(sessions);
                session.close(CloseReason::Shutdown);
                Ok(false)
            }
        }
    }

    #[cfg(any(test, feature = "test-util"))]
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
        self.get_or_create_for_ws(id, since, opts, TerminalPlacement::default(), None)
    }

    pub fn get_or_create_for_ws(
        &self,
        id: Option<&str>,
        since: Option<u64>,
        opts: CreateOptions,
        placement: TerminalPlacement,
        client_generation: Option<u64>,
    ) -> Result<AttachHandle, CreateError> {
        let TerminalPlacement {
            pane_id,
            side,
            tab_id,
        } = placement;
        if let Some(id) = id {
            // Honor the client's `since` cursor for a SNAPSHOT RESUME only when
            // its cached generation still matches the live session: a restart
            // reuses the id but resets the ring/`seq` to 0, so a stale cursor
            // would otherwise replay an empty delta with missed=0 (silent
            // desync). A client that is not resuming echoes NO generation -- its
            // `since` (the SPA's `Some(0)`) is honored as sent so a ring
            // overflow still surfaces via `missed_bytes`.
            let effective_since = match client_generation {
                Some(g) if self.session_generation(id) == Some(g) => since,
                // Echoed a generation that no longer matches (e.g. a restart it
                // did not observe): the cached cursor is stale -> full replay.
                Some(_) => None,
                // Not a resume attempt: pass `since` through unchanged.
                None => since,
            };
            if let Some(handle) = self.attach_for_ws(id, effective_since) {
                // Move invariant: re-home the session to the attaching window.
                // A cross-window terminal move re-binds it here, so a later
                // `close_for_window(source)` reaps only sessions still bound to
                // the source -- not the one that just moved away.
                self.rebind_session_window(id, opts.window_id.clone());
                self.bind_session_layout(id, pane_id, side, tab_id);
                return Ok(handle);
            }
        }
        let handle = self.create(opts)?;
        self.bind_session_layout(handle.id(), pane_id, side, tab_id);
        Ok(handle)
    }

    /// Re-home a live session to `window_id` (the attaching window). No-op for a
    /// windowless (`None`) reattach or a vanished session. See
    /// [`Session::set_window_id`].
    fn rebind_session_window(&self, id: &str, window_id: Option<String>) {
        if window_id.is_none() {
            return;
        }
        // Clone the Arc out and release the map lock before touching parking:
        // the park commit snapshots every registry and would deadlock under
        // this sessions mutex.
        let session = self
            .sessions
            .lock()
            .expect("terminal registry poisoned")
            .get(id)
            .cloned();
        let Some(session) = session else {
            return;
        };
        #[cfg(target_os = "linux")]
        let previous = session.window_id();
        session.set_window_id(window_id.clone());
        #[cfg(target_os = "linux")]
        if session.is_fdstore_parked() {
            // A cross-window move must republish the manifest: restore skips
            // a session whose recorded window row no longer exists.
            if previous != window_id {
                session.parked_changed();
            }
        } else {
            // A windowless session gaining its first window becomes parkable.
            self.park_if_windowed(&session);
        }
    }

    /// Record the browser-reported pane + tab placement on a live session, for
    /// `cs term list` window->pane->tab tracing. Sent on every (re)attach; a
    /// `None` on either axis leaves the prior value (a server-spawned session
    /// that never attached has neither). Best-effort -- the ids re-bind on
    /// split/move, so the list shows the last attach's coordinates.
    fn bind_session_layout(
        &self,
        id: &str,
        pane_id: Option<String>,
        side: Option<PaneSide>,
        tab_id: Option<String>,
    ) {
        if pane_id.is_none() && side.is_none() && tab_id.is_none() {
            return;
        }
        let session = self
            .sessions
            .lock()
            .expect("terminal registry poisoned")
            .get(id)
            .cloned();
        let Some(session) = session else {
            return;
        };
        session.set_pane_id(pane_id);
        session.set_side(side);
        session.set_tab_id(tab_id);
        // Placement rides the restart manifest; republish so a crash restore
        // does not resurrect an arbitrarily old pane placement.
        #[cfg(target_os = "linux")]
        session.parked_changed();
    }

    /// Refresh browser-reported layout coordinates without reconnecting the
    /// terminal WebSocket. Moving a tab between Hybrid sides keeps the mounted
    /// terminal alive, so its socket sends a placement frame instead.
    pub fn update_session_layout(
        &self,
        id: &str,
        pane_id: Option<String>,
        side: Option<PaneSide>,
        tab_id: Option<String>,
    ) -> bool {
        let session = self
            .sessions
            .lock()
            .expect("terminal registry poisoned")
            .get(id)
            .cloned();
        let Some(session) = session else {
            return false;
        };
        session.set_pane_id(pane_id);
        session.set_side(side);
        session.set_tab_id(tab_id);
        // Same manifest republish as `bind_session_layout`: a Hybrid-side
        // move without a reconnect still changes the restored placement.
        #[cfg(target_os = "linux")]
        session.parked_changed();
        true
    }

    pub fn close(&self, id: &str, reason: CloseReason) -> bool {
        let session = self
            .sessions
            .lock()
            .expect("terminal registry poisoned")
            .remove(id);
        if let Some(session) = session {
            session.close(reason);
            self.notify_roster_change();
            true
        } else {
            false
        }
    }

    pub fn remove(&self, id: &str) -> bool {
        let removed = self
            .sessions
            .lock()
            .expect("terminal registry poisoned")
            .remove(id);
        if let Some(session) = removed {
            // A removal without a close still ends the session's store
            // membership; unpark is take-once, so a prior exit/close already
            // having done it is fine.
            session.unpark_fdstore();
            self.notify_roster_change();
            true
        } else {
            false
        }
    }

    /// Record that window `window_id` has a durable saved layout blob, so its
    /// detached terminal sessions are kept alive (reattachable on reconnect)
    /// instead of orphan-reaped. Called on a `PUT /api/session?w=<window_id>`.
    /// Idempotent.
    pub fn mark_window_persisted(&self, window_id: &str) {
        self.persisted_windows
            .lock()
            .expect("terminal registry poisoned")
            .insert(window_id.to_string());
    }

    /// Whether `window_id` is marked persisted (its detached sessions are spared
    /// the orphan-grace reap). The read side of
    /// [`mark_window_persisted`](Self::mark_window_persisted).
    pub fn is_window_persisted(&self, window_id: &str) -> bool {
        self.persisted_windows
            .lock()
            .expect("terminal registry poisoned")
            .contains(window_id)
    }

    /// Close every live session owned by `window_id` (its PTYs are killed and
    /// fds released). Returns how many were closed. The window-scoped sibling
    /// of [`Registry::close`]; the discard primitive behind
    /// [`Registry::forget_window`].
    pub fn close_for_window(&self, window_id: &str, reason: CloseReason) -> usize {
        let ids: Vec<String> = {
            let sessions = self.sessions.lock().expect("terminal registry poisoned");
            sessions
                .iter()
                .filter(|(_, session)| session.window_id().as_deref() == Some(window_id))
                .map(|(id, _)| id.clone())
                .collect()
        };
        let mut closed = 0;
        for id in ids {
            if self.close(&id, reason) {
                closed += 1;
            }
        }
        closed
    }

    /// How many LIVE sessions window `window_id` owns -- the read-only twin of
    /// [`close_for_window`](Self::close_for_window), for the `cs window rm`
    /// `--force` guard. Counts only sessions not yet marked closed.
    pub fn count_for_window(&self, window_id: &str) -> usize {
        let sessions = self.sessions.lock().expect("terminal registry poisoned");
        sessions
            .values()
            .filter(|session| !session.closed.load(Ordering::Relaxed))
            .filter(|session| session.window_id().as_deref() == Some(window_id))
            .count()
    }

    /// A window was DISCARDED (its layout blob was DELETEd -- `^W` to empty,
    /// `^D`, `Ctrl+Shift+W` (off-mac tab close) / `Ctrl+Alt+W` (off-mac window
    /// close), or an empty window). Drop it from the persisted
    /// set and immediately reap its terminal sessions. This is what frees a
    /// busy detached session the idle pruner deliberately keeps alive, and so
    /// is the discard half of "discard ⇒ reap; persist ⇒ keep". Returns how
    /// many sessions were reaped. Called on a `DELETE /api/session?w=<window_id>`.
    pub fn forget_window(&self, window_id: &str) -> usize {
        self.unpersist_window(window_id);
        self.close_for_window(window_id, CloseReason::Explicit)
    }

    /// Drop `window_id` from the persisted set WITHOUT reaping its sessions.
    /// The discard half of a cross-window move-out: the source
    /// window emptied because its tab moved away, so its layout blob is deleted
    /// (it leaves `cs window list`) but the moved PTY must survive; reattach
    /// rebinds it to the target. A move-out DELETE
    /// (`?w=W&moved=1`) routes here; a real discard (`?w=W`) routes through
    /// [`forget_window`](Self::forget_window) and reaps.
    pub fn unpersist_window(&self, window_id: &str) {
        self.persisted_windows
            .lock()
            .expect("terminal registry poisoned")
            .remove(window_id);
    }

    /// Snapshot of every live session, for `cs term list`. The control
    /// socket holds a read handle to the registry and groups these by
    /// `tab_group`. `cwd` is the session's current working directory when
    /// it can be read from the child process.
    pub fn session_summaries(&self) -> Vec<TerminalSessionSummary> {
        // Snapshot the live sessions under the lock, then read each cwd AFTER
        // releasing it. `cwd()` shells `lsof` on macOS, so computing it under
        // the sessions mutex made a multi-session `cs term list` serialize N
        // lsof probes while holding the registry lock -- stalling every other
        // terminal op. The snapshot keeps the lock hold to a cheap Arc clone.
        let live: Vec<Arc<Session>> = {
            let sessions = self.sessions.lock().expect("terminal registry poisoned");
            sessions
                .values()
                .filter(|session| !session.closed.load(Ordering::Relaxed))
                .cloned()
                .collect()
        };
        live.into_iter()
            .map(|session| {
                let metadata = session.live_metadata();
                TerminalSessionSummary {
                    session_id: session.id.clone(),
                    tab_name: metadata.name,
                    spawn_name: session.spawn_name.clone(),
                    tab_group: metadata.group,
                    window_id: session.window_id(),
                    pane_id: session.pane_id(),
                    side: session.side(),
                    tab_id: session.tab_id(),
                    cwd: session.cwd(),
                    queue_depth: session.queue_depth(),
                    agent: session.derived_submit_agent(),
                }
            })
            .collect()
    }

    /// Write raw bytes to the PTY stdin of every live session matching the
    /// given tab name and/or group, for `cs term write`. A `None` filter
    /// matches every session on that axis; passing both narrows to the
    /// intersection. Returns how many sessions were written to. This is the
    /// natural PTY-stdin path, independent of any SPA state.
    pub fn write_input_matching(
        &self,
        tab_name: Option<&str>,
        tab_group: Option<&str>,
        data: &[u8],
    ) -> usize {
        let sessions = self.sessions.lock().expect("terminal registry poisoned");
        let mut written = 0;
        for session in sessions.values() {
            if session.closed.load(Ordering::Relaxed) {
                continue;
            }
            let metadata = session.live_metadata();
            if !live_metadata_matches(&metadata, tab_name, tab_group) {
                continue;
            }
            session.send_input(data);
            written += 1;
        }
        written
    }

    /// Fan raw input from `source_id` to every OTHER live session in the same
    /// broadcast group whose window differs from the source's. The source PTY
    /// and the source window's broadcast members are handled by the SPA (the
    /// normal `input` frame + the client-side fan, which also respects the
    /// per-member selection); this covers only the cross-window members a
    /// single standalone terminal window's SPA cannot reach, since they live
    /// in this shared registry. Group resolves like `write_input_matching`
    /// (absent = `DEFAULT_TERMINAL_GROUP`).
    pub fn broadcast_input_cross_window(&self, source_id: &str, data: &[u8]) {
        let sessions = self.sessions.lock().expect("terminal registry poisoned");
        let Some(source) = sessions.get(source_id) else {
            return;
        };
        let source_group = source.live_metadata().group;
        let source_window = source.window_id();
        for (id, session) in sessions.iter() {
            if id == source_id || session.closed.load(Ordering::Relaxed) {
                continue;
            }
            let group = session.live_metadata().group;
            // Same group, different window: same-window members are fanned
            // client-side, so skip them here to avoid double-delivery.
            if group != source_group || session.window_id() == source_window {
                continue;
            }
            // Respect the receiver's own broadcast toggle (synced via the
            // `set-broadcast` WS frame). Without this the cross-window fan
            // would reach group members with broadcast OFF, unlike the
            // same-window fan which honors the per-member selection. A
            // member that has not opted in does not receive.
            if !session.broadcast.load(Ordering::Relaxed) {
                continue;
            }
            session.send_input(data);
        }
    }

    /// Enqueue `data` onto the write FIFO of every live session matching the
    /// given tab name and/or group, for `cs terminal write`. Same selector
    /// semantics as `write_input_matching` (a `None` axis matches all; both
    /// narrow to the intersection), but the bytes are QUEUED, not written
    /// straight to the PTY: the drainer delivers logical messages when the
    /// agent is idle. See [`EnqueueOutcome`] for the return shape.
    ///
    /// The SENDER is authoritative over which chord applies. `submit` names
    /// the agent to encode for, and that agent's chord is what every matched
    /// session receives; its template still resolves in this process's
    /// environment (env `CHAN_SUBMIT_<AGENT>` > `submit.toml` > built-in).
    ///
    /// The per-session derivation from spawn command and `CHAN_AGENT` is
    /// still computed, but only to report disagreement, never to override the
    /// request. It cannot be authoritative: it is a sniff of the string a
    /// session was spawned with, so it is blind to an agent started by hand
    /// inside a shell session, and there is no way to correct it on a live
    /// session short of restarting it. A sender who names the wrong agent
    /// gets the wrong chord and an ack that says which session disagreed,
    /// which is a better failure than one nobody can override.
    ///
    /// A group write onto a mixed-agent team therefore delivers ONE chord to
    /// every member, so target a mixed group per-session rather than by
    /// group when the members run different agents.
    pub fn enqueue_write_matching(
        &self,
        tab_name: Option<&str>,
        tab_group: Option<&str>,
        data: &str,
        submit: Option<SubmitAgent>,
    ) -> EnqueueOutcome {
        let sessions = self.sessions.lock().expect("terminal registry poisoned");
        let matched: Vec<(&Arc<Session>, LiveTerminalMetadata)> = sessions
            .values()
            .filter(|session| !session.closed.load(Ordering::Relaxed))
            .map(|session| (session, session.live_metadata()))
            .filter(|(_, metadata)| live_metadata_matches(metadata, tab_name, tab_group))
            .collect();
        let single = matched.len() == 1;
        let mut outcome = EnqueueOutcome::default();
        for (session, metadata) in matched {
            let derived = session.derived_submit_agent();
            let resolved = submit.map(ResolvedSubmit::resolve);
            match session.enqueue_cs_write(data.to_string(), resolved) {
                Some(position) => {
                    outcome.queued += 1;
                    if single {
                        outcome.position = Some(position);
                    }
                    if let Some(requested) = submit {
                        if derived != Some(requested) {
                            outcome.diverged.push(SubmitDivergence {
                                tab: metadata.name.unwrap_or_else(|| session.id.clone()),
                                derived,
                            });
                        }
                    }
                }
                None if data.len() > MAX_TERMINAL_WRITE_BYTES => outcome.oversized += 1,
                None => outcome.full += 1,
            }
        }
        outcome
    }

    /// Full replay-ring snapshots of every live session whose tab name is
    /// `tab_name`, as `(session_id, bytes)`, for `cs terminal scrollback`.
    /// The bytes are the raw PTY stream the WS attach replays (ANSI and
    /// all), so a reader sees exactly what is on screen. There is no group
    /// axis: scrollback targets one terminal, and the control socket
    /// enforces the single-match policy, so this stays a thin selector like
    /// `write_input_matching`.
    pub fn scrollback_matching(&self, tab_name: &str) -> Vec<(String, Vec<u8>)> {
        let sessions = self.sessions.lock().expect("terminal registry poisoned");
        sessions
            .values()
            .filter(|session| !session.closed.load(Ordering::Relaxed))
            .filter(|session| session.live_metadata().name.as_deref() == Some(tab_name))
            .map(|session| (session.id.clone(), session.scrollback()))
            .collect()
    }

    /// Raw replay-ring bytes of every live session in this registry,
    /// concatenated. A standalone terminal tenant typically holds one
    /// session, so this is its full PTY output for a caller that scrapes
    /// it (e.g. reading a connect script's output to find a printed token).
    pub fn all_scrollback(&self) -> Vec<u8> {
        let sessions = self.sessions.lock().expect("terminal registry poisoned");
        let mut out = Vec::new();
        for session in sessions.values() {
            if !session.closed.load(Ordering::Relaxed) {
                out.extend_from_slice(&session.scrollback());
            }
        }
        out
    }

    /// Restart every live session matching the given tab name and/or
    /// group, for `cs terminal restart`. Same selector semantics as
    /// `write_input_matching` (a `None` axis matches all; both narrow to
    /// the intersection). Returns how many sessions were restarted.
    ///
    /// Passing [`RestartOverrides::default`] preserves each session's spawn
    /// command + env, so a session launched with an agent startup command
    /// relaunches that agent. This is the out-of-band server path the Team
    /// Work self-restart needs: a shell cannot restart the very shell running
    /// its own bootstrap script, but the server can. Ids are collected under
    /// the lock and restarted after it is dropped, since `restart()` re-locks
    /// the registry internally.
    pub fn restart_matching(
        &self,
        tab_name: Option<&str>,
        tab_group: Option<&str>,
        overrides: RestartOverrides,
    ) -> Result<usize, CreateError> {
        let ids: Vec<String> = {
            let sessions = self.sessions.lock().expect("terminal registry poisoned");
            sessions
                .values()
                .filter(|session| !session.closed.load(Ordering::Relaxed))
                .filter(|session| {
                    live_metadata_matches(&session.live_metadata(), tab_name, tab_group)
                })
                .map(|session| session.id.clone())
                .collect()
        };
        let mut restarted = 0;
        for id in &ids {
            if self.restart(id, overrides.clone())? {
                restarted += 1;
            }
        }
        Ok(restarted)
    }

    /// Close every live session matching the given tab name and/or group, for
    /// `cs terminal close`. Same selector semantics as `restart_matching` (a
    /// `None` axis matches all; both narrow to the intersection). Closes the
    /// PTY and removes the registry entry -- the explicit teardown that was
    /// missing (killing the pid out-of-band left the entry to linger and hold
    /// its tab name). Returns how many sessions were closed.
    pub fn close_matching(&self, tab_name: Option<&str>, tab_group: Option<&str>) -> usize {
        let ids: Vec<String> = {
            let sessions = self.sessions.lock().expect("terminal registry poisoned");
            sessions
                .values()
                .filter(|session| !session.closed.load(Ordering::Relaxed))
                .filter(|session| {
                    live_metadata_matches(&session.live_metadata(), tab_name, tab_group)
                })
                .map(|session| session.id.clone())
                .collect()
        };
        let mut closed = 0;
        for id in &ids {
            if self.close(id, CloseReason::Explicit) {
                closed += 1;
            }
        }
        closed
    }

    /// The DISTINCT window ids that own a live session matching the given
    /// tab name and/or group, for `cs terminal survey`. Same selector
    /// semantics as `write_input_matching` (a `None` axis matches all; both
    /// narrow to the intersection). A survey overlay is an SPA-window
    /// affordance, not a PTY one, so the survey transport resolves the tab
    /// selector to the window(s) hosting those tabs and pushes the overlay
    /// there. Sessions with no `window_id` (rare: a session created outside
    /// a browser window) contribute nothing. Order is unspecified; callers
    /// fan the overlay out to each.
    pub fn window_ids_matching(
        &self,
        tab_name: Option<&str>,
        tab_group: Option<&str>,
    ) -> Vec<String> {
        let sessions = self.sessions.lock().expect("terminal registry poisoned");
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for session in sessions.values() {
            if session.closed.load(Ordering::Relaxed) {
                continue;
            }
            let metadata = session.live_metadata();
            if !live_metadata_matches(&metadata, tab_name, tab_group) {
                continue;
            }
            if let Some(window_id) = session.window_id() {
                if seen.insert(window_id.clone()) {
                    out.push(window_id);
                }
            }
        }
        out
    }

    /// Close every session (kill + unpark), returning how many were drained.
    /// Tenant teardown and process shutdown both land here; parked sessions
    /// that must SURVIVE a shutdown are removed beforehand by
    /// [`detach_parked_sessions`](Self::detach_parked_sessions), which only
    /// the devserver's pre-shutdown sweep calls.
    pub fn close_all(&self, reason: CloseReason) -> usize {
        let sessions: Vec<Arc<Session>> = self
            .sessions
            .lock()
            .expect("terminal registry poisoned")
            .drain()
            .map(|(_, session)| session)
            .collect();
        let drained = sessions.len();
        for session in sessions {
            session.close(reason);
        }
        self.notify_roster_change();
        drained
    }

    /// Remove and DETACH every parked session: no kill, no unpark, so the
    /// children keep running against masters the systemd fd store retains.
    /// Only the devserver's graceful-shutdown sweep calls this, after the
    /// final manifest write and before tenant teardown. Unparked sessions
    /// are untouched and die normally in the following `close_all`.
    #[cfg(target_os = "linux")]
    pub fn detach_parked_sessions(&self) -> usize {
        let parked: Vec<Arc<Session>> = {
            let mut sessions = self.sessions.lock().expect("terminal registry poisoned");
            let ids: Vec<String> = sessions
                .iter()
                .filter(|(_, session)| session.is_fdstore_parked())
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter().filter_map(|id| sessions.remove(id)).collect()
        };
        for session in &parked {
            session.detach_for_fdstore_restart();
        }
        if !parked.is_empty() {
            self.notify_roster_change();
        }
        parked.len()
    }

    /// Child pids of every not-yet-closed session, for the drain endpoint's
    /// bounded child-death wait.
    pub fn live_child_pids(&self) -> Vec<u32> {
        let sessions = self.sessions.lock().expect("terminal registry poisoned");
        sessions
            .values()
            .filter(|session| !session.closed.load(Ordering::Relaxed))
            .filter_map(|session| session.child_pid)
            .collect()
    }

    /// Reap sessions whose child PROCESS has exited and that have no client
    /// attached. A dead, unviewed session is a pure ghost -- no process, no
    /// viewer -- so keeping it only leaks the slot and HOLDS its tab name,
    /// making a re-spawn under the same name collide and come up renamed (the
    /// `cs terminal restart` ghost-tab regression: a killed agent's entry lingered
    /// because the controller thread records `exit` on exit but never
    /// removes the entry). Distinct axis from `prune_idle_at`, which times
    /// out *live* detached sessions and deliberately keeps persisted windows:
    /// a dead process can't be reattached, only re-spawned, so a persisted
    /// window comes back fresh on reconnect rather than stranding the ghost.
    /// An attached dead session is KEPT (a client is still viewing its final
    /// output -- no natural-`exit`-vanishes regression). Returns how many were
    /// reaped. Run before every [`create`](Self::create) and on the pruner tick.
    pub fn reap_exited(&self) -> usize {
        // Capture each reaped session's owning window_id alongside its id: a
        // standalone terminal window IS its session, so reaping the session must
        // also drop the window-feed row, and `close` removes the session
        // before we could read it back.
        let to_reap: Vec<(String, Option<String>)> = {
            let sessions = self.sessions.lock().expect("terminal registry poisoned");
            sessions
                .iter()
                .filter(|(_, session)| {
                    session.attach_count.load(Ordering::Relaxed) == 0
                        && session
                            .exit
                            .lock()
                            .expect("session exit poisoned")
                            .is_some()
                })
                .map(|(id, session)| (id.clone(), session.window_id()))
                .collect()
        };
        let reaper = self
            .window_reaper
            .lock()
            .expect("terminal registry poisoned")
            .clone();
        let mut reaped = 0;
        for (id, window_id) in &to_reap {
            if self.close(id, CloseReason::Explicit) {
                reaped += 1;
                // The shared terminal tenant's hook drops the window-feed row +
                // refreshes the feed. No-op on a workspace / control window
                // (the host scopes it; the row guard double-checks the kind).
                if let (Some(window_id), Some(reaper)) = (window_id, reaper.as_ref()) {
                    reaper.call(window_id);
                }
            }
        }
        reaped
    }

    pub fn prune_idle(&self) -> usize {
        self.prune_idle_at(now_unix_secs() as i64)
    }

    /// Reap sessions whose window can never come back. Persistence-driven, NOT
    /// activity-driven (a busy detached session refreshes `last_activity` on
    /// every output byte, so the old activity timer kept htop / a `for` loop
    /// immortal). The rule:
    ///
    /// - **attached** (`attach_count > 0`) -- keep; a client is live on it.
    /// - **detached, window persisted** (a durable layout blob exists, tracked
    ///   in `persisted_windows`) -- keep indefinitely; the window survives a
    ///   client disconnect and reattaches on reconnect (browser-tab / devserver
    ///   semantics). Discard reaps it explicitly via [`Registry::forget_window`].
    /// - **detached, window NOT persisted** (browser window that never saved a
    ///   blob -- a hard client crash before any save) -- orphan; reap once it has
    ///   been detached longer than the grace.
    /// - **detached, no `window_id`** (a headless `cs terminal new` from a
    ///   native terminal) -- unchanged activity-idle cleanup, timed off
    ///   `last_activity`; these are intentional, not browser-window orphans.
    ///
    /// The detach/idle grace reuses `terminal.idle_timeout_secs`.
    pub fn prune_idle_at(&self, now: i64) -> usize {
        let idle_timeout = self.config.terminal.idle_timeout_secs as i64;
        let persisted = self
            .persisted_windows
            .lock()
            .expect("terminal registry poisoned")
            .clone();
        let to_close: Vec<String> = {
            let sessions = self.sessions.lock().expect("terminal registry poisoned");
            sessions
                .iter()
                .filter_map(|(id, session)| {
                    if session.attach_count.load(Ordering::Relaxed) != 0 {
                        return None; // a client is attached
                    }
                    match session.window_id() {
                        // Persisted window: kept until an explicit discard.
                        Some(window_id) if persisted.contains(&window_id) => None,
                        // Browser window with no durable blob: orphan-grace from
                        // when it last went detached.
                        Some(_) => {
                            let detached = session.detached_at.load(Ordering::Relaxed);
                            (now.saturating_sub(detached) > idle_timeout).then(|| id.clone())
                        }
                        // Headless / control terminal: legacy activity-idle.
                        None => {
                            let last = session.last_activity.load(Ordering::Relaxed);
                            (now.saturating_sub(last) > idle_timeout).then(|| id.clone())
                        }
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
                        self.reap_exited();
                        self.prune_idle();
                    }
                }
            }
        })
    }

    /// One drain pass over every live session's `cs terminal write` queue.
    /// Snapshots the session Arcs under the lock, then drains each outside it
    /// (delivery touches the session's own queue + PTY, never the registry
    /// map). A no-op for sessions with an empty queue or a busy agent.
    pub fn drain_writes(&self) {
        let now = now_unix_millis();
        let sessions: Vec<Arc<Session>> = self
            .sessions
            .lock()
            .expect("terminal registry poisoned")
            .values()
            .filter(|session| !session.closed.load(Ordering::Relaxed))
            .cloned()
            .collect();
        for session in sessions {
            session.try_drain_batch(now);
        }
    }

    /// The write-queue drainer: ticks every `WRITE_QUEUE_DRAIN_TICK` and
    /// delivers each session's next queued write once its agent is idle. A
    /// sibling of `spawn_pruner` (own task, shuts down on the same signal).
    pub fn spawn_drainer(
        self: Arc<Self>,
        mut shutdown_rx: watch::Receiver<bool>,
    ) -> JoinHandle<()> {
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(WRITE_QUEUE_DRAIN_TICK);
            loop {
                tokio::select! {
                    _ = shutdown_rx.changed() => break,
                    _ = tick.tick() => {
                        self.drain_writes();
                    }
                }
            }
        })
    }

    #[cfg(target_os = "linux")]
    /// Manifest entries for every PARKED live session: fd name, restore
    /// metadata, and the bounded replay tail. No fd duplication: the store
    /// already holds the fds; the manifest only describes them.
    pub fn fdstore_manifest_sessions(&self, tenant_prefix: &str) -> Vec<FdStoreManifestEntry> {
        let sessions = self.sessions.lock().expect("terminal registry poisoned");
        sessions
            .values()
            .filter_map(|session| session.fdstore_manifest_entry(tenant_prefix))
            .collect()
    }

    #[cfg(target_os = "linux")]
    pub fn restore_fdstore_sessions(
        &self,
        imports: Vec<FdStoreSessionImport>,
    ) -> FdStoreRestoreReport {
        let mut report = FdStoreRestoreReport::default();
        for import in imports {
            let meta = import.meta.clone();
            if meta.tenant_prefix.is_empty() || meta.session_id.is_empty() {
                report.skip_session(&meta, "missing tenant prefix or session id");
                continue;
            }
            let id = meta.session_id.clone();
            {
                let sessions = self.sessions.lock().expect("terminal registry poisoned");
                if sessions.contains_key(&id) {
                    report.skip_session(&meta, "already exists");
                    continue;
                }
                if sessions.len() >= self.config.terminal.session_cap {
                    report.skip_session(&meta, "session cap reached");
                    continue;
                }
            }
            // An imported manifest is provenance, not a proposal: preserve its
            // live name exactly. Reuse settlement only to reserve that exact
            // name; if settlement would suffix it, skip the conflicting import
            // instead of fabricating different restored metadata.
            let mut name_reservation = if meta.tab_name.is_some() {
                let reservation =
                    self.reserve_metadata(meta.tab_name.clone(), meta.tab_group.clone(), None);
                if reservation.metadata.name != meta.tab_name {
                    report.skip_session(&meta, "live terminal name already exists");
                    continue;
                }
                Some(reservation)
            } else {
                None
            };
            let generation = meta.generation;
            let session =
                match Session::from_imported(self.config.clone(), import, self.last_exit.clone()) {
                    Ok(session) => session,
                    Err(e) => {
                        report.skip_session(&meta, e.to_string());
                        continue;
                    }
                };
            self.generation_counter
                .fetch_max(generation.saturating_add(1), Ordering::Relaxed);
            let window_id = session.window_id();
            let mut sessions = self.sessions.lock().expect("terminal registry poisoned");
            let mut reservations = self
                .name_reservations
                .lock()
                .expect("terminal name reservations poisoned");
            if sessions.len() >= self.config.terminal.session_cap || sessions.contains_key(&id) {
                report.skip_session(&meta, "raced with another restore");
                if let Some(reservation) = name_reservation.as_mut() {
                    reservation.release_locked(&mut reservations);
                }
                drop(reservations);
                drop(sessions);
                session.close(CloseReason::Shutdown);
                continue;
            }
            sessions.insert(id, session.clone());
            if let Some(reservation) = name_reservation.as_mut() {
                reservation.release_locked(&mut reservations);
            }
            drop(reservations);
            drop(sessions);
            // ADOPT, not park: the store retained this fd across the restart,
            // so a second FDSTORE would duplicate the entry. Adoption only
            // records the name for the later unpark and manifest membership.
            if let Some(parker) = self.fd_parker() {
                session.adopt_fdstore(&parker);
            }
            if let Some(window_id) = window_id {
                self.mark_window_persisted(&window_id);
            }
            report.restored += 1;
        }
        if report.restored > 0 {
            self.notify_roster_change();
        }
        report
    }

    fn unused_id(&self, sessions: &HashMap<String, Arc<Session>>) -> String {
        loop {
            let id = random_session_id();
            if !sessions.contains_key(&id) {
                return id;
            }
        }
    }

    #[cfg(any(test, feature = "test-util"))]
    pub fn len(&self) -> usize {
        self.sessions
            .lock()
            .expect("terminal registry poisoned")
            .len()
    }

    #[cfg(any(test, feature = "test-util"))]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Drop for Registry {
    fn drop(&mut self) {
        // An unexpected tenant drop is NOT a restart: kill and unpark
        // everything so no child leaks. The devserver's explicit detach
        // sweep is the only preservation path, and it empties the map
        // before any orderly drop gets here.
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, session) in sessions.drain() {
                session.close(CloseReason::Shutdown);
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QueueSource {
    CsWrite,
    RichPrompt,
}

impl QueueSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::CsWrite => "cs_write",
            Self::RichPrompt => "rich_prompt",
        }
    }
}

/// Which portion of a logical message a queue entry delivers. Gemini is the
/// one agent whose submit chord must arrive as its OWN keypress, and live
/// probing found no fixed sub-idle gap safe across the required input shapes.
/// A Gemini message therefore takes a `Body` entry and a `Chord` entry that
/// the drainer separates with a full idle gate. Everything else is one
/// `Whole` entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MessagePart {
    Whole,
    Body,
    Chord,
}

impl MessagePart {
    /// Whether this entry COMPLETES its logical message. Depth counts tails,
    /// and `PromptDelivered` fires on a tagged tail's drain, so a `Body` drain
    /// leaves its message pending.
    fn is_tail(self) -> bool {
        !matches!(self, Self::Body)
    }
}

/// One entry of the per-session FIFO. Submit bytes stay unresolved until
/// drain so consecutive compatible `cs terminal write` notifications can be
/// framed once without embedded submit chords.
#[derive(Debug)]
struct QueuedMessage {
    /// Logical message text. Empty on a `Chord` entry, which carries no text.
    data: String,
    submit: Option<ResolvedSubmit>,
    source: QueueSource,
    /// Rich Prompt message id, on EVERY entry of the message so recall is a
    /// pure retain-filter. `None` for `cs terminal write` pokes.
    prompt_id: Option<String>,
    part: MessagePart,
}

/// Message depth of a queue: the count of TAIL entries. A split Gemini message
/// contributes exactly one tail, so this counts messages, not entries.
fn msg_depth(queue: &VecDeque<QueuedMessage>) -> usize {
    queue
        .iter()
        .filter(|message| message.part.is_tail())
        .count()
}

/// The write-queue gate a session starts with: an empty FIFO, no recorded
/// delivery, and no pending generation-start wait. The fresh and
/// fdstore-restored constructors both take their fields from here, so a
/// restored session cannot come up mid-delivery and stall its own drainer.
fn fresh_queue_state() -> (Mutex<VecDeque<QueuedMessage>>, AtomicI64, AtomicBool) {
    (
        Mutex::new(VecDeque::new()),
        AtomicI64::new(0),
        AtomicBool::new(false),
    )
}

/// The entries one logical message occupies, in order. A Gemini body and its
/// bare CR are separate entries; everything else is one.
fn message_parts(data: &str, submit: Option<&ResolvedSubmit>) -> &'static [MessagePart] {
    match submit {
        Some(submit) if chan_shell::splits_submit_chord(data, submit) => {
            &[MessagePart::Body, MessagePart::Chord]
        }
        _ => &[MessagePart::Whole],
    }
}

/// Append one logical message as its ordered entries, all-or-nothing at the
/// byte and entry caps. A partial push could deliver a body whose submit chord
/// was silently dropped. `None` leaves the queue untouched.
fn push_message(
    queue: &mut VecDeque<QueuedMessage>,
    data: String,
    submit: Option<ResolvedSubmit>,
    source: QueueSource,
    prompt_id: Option<String>,
) -> Option<()> {
    if data.len() > MAX_TERMINAL_WRITE_BYTES {
        return None;
    }
    let parts = message_parts(&data, submit.as_ref());
    if queue.len() + parts.len() > WRITE_QUEUE_CAP {
        return None;
    }
    let mut text = Some(data);
    for part in parts {
        queue.push_back(QueuedMessage {
            // A chord entry carries no text; the body entry owns it.
            data: match part {
                MessagePart::Chord => String::new(),
                _ => text.take().unwrap_or_default(),
            },
            submit: submit.clone(),
            source,
            prompt_id: prompt_id.clone(),
            part: *part,
        });
    }
    Some(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BatchStopReason {
    End,
    RichPrompt,
    NoSubmit,
    SplitWrite,
    UnbatchableAgent,
    Override,
    DifferentSubmit,
    ByteCeiling,
}

impl BatchStopReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::End => "end",
            Self::RichPrompt => "rich_prompt",
            Self::NoSubmit => "no_submit",
            Self::SplitWrite => "split_write",
            Self::UnbatchableAgent => "unbatchable_agent",
            Self::Override => "override",
            Self::DifferentSubmit => "different_submit",
            Self::ByteCeiling => "byte_ceiling",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct BatchSelection {
    count: usize,
    stop: BatchStopReason,
}

fn batch_boundary(message: &QueuedMessage) -> Option<BatchStopReason> {
    if message.source != QueueSource::CsWrite {
        return Some(BatchStopReason::RichPrompt);
    }
    if message.part != MessagePart::Whole {
        return Some(BatchStopReason::SplitWrite);
    }
    let Some(submit) = message.submit.as_ref() else {
        return Some(BatchStopReason::NoSubmit);
    };
    if submit.source == chan_shell::SubmitTemplateSource::Override {
        return Some(BatchStopReason::Override);
    }
    if !submit.is_batchable() {
        return Some(BatchStopReason::UnbatchableAgent);
    }
    None
}

/// Select the largest compatible prefix without scanning past a boundary.
/// The returned count is always at least one for a non-empty queue.
///
/// Runs under the queue mutex, so it measures a candidate batch from a running
/// content total plus [`batch_framing_overhead`] instead of re-framing the
/// payload on every step. The framing itself happens after the pop, outside
/// the lock.
fn select_batch_prefix(queue: &VecDeque<QueuedMessage>, max_bytes: usize) -> BatchSelection {
    let Some(head) = queue.front() else {
        return BatchSelection {
            count: 0,
            stop: BatchStopReason::End,
        };
    };
    if let Some(stop) = batch_boundary(head) {
        return BatchSelection { count: 1, stop };
    }

    let head_submit = head.submit.as_ref().expect("batchable head has submit");
    let mut content = framed_content_len(head);
    let mut count = 1;
    let mut stop = BatchStopReason::End;
    for message in queue.iter().skip(1) {
        if let Some(reason) = batch_boundary(message) {
            stop = reason;
            break;
        }
        if message.submit.as_ref() != Some(head_submit) {
            stop = BatchStopReason::DifferentSubmit;
            break;
        }
        let grown = content + framed_content_len(message);
        if batch_framing_overhead(count + 1) + grown > max_bytes {
            stop = BatchStopReason::ByteCeiling;
            break;
        }
        content = grown;
        count += 1;
    }

    BatchSelection { count, stop }
}

const BATCH_HEADING: &str = "# Queued terminal notifications\n\n";
const BATCH_PREAMBLE: &str = " messages, oldest first. Read the entire batch before acting. Later\nmessages may update or supersede earlier messages.\n\n";

/// Message bytes a framed batch carries before its one framing newline.
fn framed_content_len(message: &QueuedMessage) -> usize {
    message.data.trim_end_matches('\n').len()
}

/// Byte size of everything [`format_notification_batch`] adds around `count`
/// messages, so prefix selection can size a candidate without building it.
/// `batch_framing_overhead_matches_the_formatter` pins it against the formatter.
fn batch_framing_overhead(count: usize) -> usize {
    let total_digits = decimal_digits(count);
    let mut overhead = BATCH_HEADING.len() + total_digits + BATCH_PREAMBLE.len();
    for number in 1..=count {
        // "--- notification N/C ---\n", the message, "\n",
        // "--- end notification N/C ---\n", and a blank line between entries.
        overhead += 23 + decimal_digits(number) + total_digits;
        overhead += 1;
        overhead += 27 + decimal_digits(number) + total_digits;
        if number != count {
            overhead += 1;
        }
    }
    overhead
}

fn decimal_digits(n: usize) -> usize {
    let mut digits = 1;
    let mut rest = n / 10;
    while rest > 0 {
        digits += 1;
        rest /= 10;
    }
    digits
}

/// Frame logical notifications in chronological order. Each body is trimmed
/// and followed by exactly one framing newline, matching singleton submit-body
/// normalization.
fn format_notification_batch(messages: &[&QueuedMessage]) -> String {
    let count = messages.len();
    let mut out = String::with_capacity(
        batch_framing_overhead(count)
            + messages
                .iter()
                .copied()
                .map(framed_content_len)
                .sum::<usize>(),
    );
    out.push_str(BATCH_HEADING);
    out.push_str(&count.to_string());
    out.push_str(BATCH_PREAMBLE);
    for (index, message) in messages.iter().enumerate() {
        let number = index + 1;
        out.push_str(&format!("--- notification {number}/{count} ---\n"));
        out.push_str(message.data.trim_end_matches('\n'));
        out.push('\n');
        out.push_str(&format!("--- end notification {number}/{count} ---\n"));
        if number != count {
            out.push('\n');
        }
    }
    out
}

fn pop_batch(
    queue: &mut VecDeque<QueuedMessage>,
    max_bytes: usize,
) -> (Vec<QueuedMessage>, BatchStopReason) {
    let selection = select_batch_prefix(queue, max_bytes);
    let mut messages = Vec::with_capacity(selection.count);
    for _ in 0..selection.count {
        if let Some(message) = queue.pop_front() {
            messages.push(message);
        }
    }
    (messages, selection.stop)
}

#[derive(Debug)]
struct Session {
    id: String,
    live_metadata: Mutex<LiveTerminalMetadata>,
    /// Immutable values injected into this PTY incarnation. Live metadata
    /// edits never mutate these fields or the running shell environment.
    spawn_name: Option<String>,
    spawn_group: Option<String>,
    /// The window this session currently belongs to (the `?w=` label). Interior
    /// mutable because a reattach REBINDS it to the attaching window: a
    /// cross-window terminal move re-homes the session, so a later
    /// `close_for_window(source)` reaps only sessions STILL bound to the source
    /// Read via [`Session::window_id`].
    window_id: Mutex<Option<String>>,
    /// The SPA layout coordinates -- pane id + side + tab id -- this session was last
    /// attached under, reported by the browser on each (re)attach. Interior
    /// mutable and best-effort: they re-bind on split/move and stay `None` for
    /// a session that never attached from a browser (e.g. `cs terminal new`).
    /// Read via [`Session::pane_id`] / [`Session::side`] / [`Session::tab_id`]
    /// for `cs term list`.
    pane_id: Mutex<Option<String>>,
    side: Mutex<Option<PaneSide>>,
    tab_id: Mutex<Option<String>>,
    /// Per-PTY-life epoch stamped at spawn (see [`Registry::generation_counter`]).
    /// A restart mints a new session under the same id with this bumped and the
    /// ring/`seq` reset, so a client compares it before trusting a `since` cursor.
    generation: u64,
    workspace_root: PathBuf,
    spawn_opts: CreateOptions,
    child_pid: Option<u32>,
    #[cfg(target_os = "linux")]
    master_fd: Option<OwnedFd>,
    command_tx: std::sync::mpsc::Sender<PtyCommand>,
    output_tx: broadcast::Sender<SessionEvent>,
    ring: Mutex<RingBuffer>,
    seq: AtomicU64,
    last_activity: AtomicI64,
    /// Wall-clock millis of the most recent OUTPUT byte (the agent
    /// rendering / generating), distinct from `last_activity` (which also
    /// bumps on input). The `cs terminal write` queue drains only when this
    /// has been quiet for `WRITE_QUEUE_QUIET_MS` (the agent is idle).
    last_output_at: AtomicI64,
    /// FIFO of pending logical messages for this session -- `cs terminal
    /// write` pokes and Rich Prompt messages share it -- drained when the
    /// agent is idle. Bounded at `WRITE_QUEUE_CAP` entries; dropped on session
    /// recycle (the session, and this queue with it, is replaced on
    /// restart/close -- attached clients get Closed/Exit and re-sync their
    /// queue depth from the next attach's session frame).
    write_queue: Mutex<VecDeque<QueuedMessage>>,
    /// Millis of the drainer's last delivery (0 when nothing is pending), to
    /// time the await-generation-start window after a deliver.
    last_deliver_at: AtomicI64,
    /// True between a delivery and the agent's generation-START (or the cap),
    /// so the next queued message does not fire into the same compose.
    awaiting_gen: AtomicBool,
    attach_count: AtomicUsize,
    /// Unix seconds when `attach_count` last fell to 0 (every client detached).
    /// Seeded at spawn. The orphan-grace pruner times a detached session from
    /// THIS, not `last_activity` -- a busy detached session (htop, a `for` loop)
    /// keeps `last_activity` fresh forever, so timing the grace off output kept
    /// it immortal (the FD leak). Meaningless while `attach_count > 0`.
    detached_at: AtomicI64,
    winsize: Mutex<PtySize>,
    focused: AtomicBool,
    bytes_since_focus: AtomicU64,
    in_alt_screen: AtomicBool,
    alt_screen_tail: Mutex<Vec<u8>>,
    /// The [`TRACKED_PRIVATE_MODES`] the live program currently has ON, scanned
    /// from PTY output by [`Session::update_private_modes`] and re-asserted on
    /// reattach (see [`Session::attach`]) so a fresh client whose terminal came
    /// up at defaults regains the program's key/mouse modes.
    private_modes: Mutex<BTreeSet<u16>>,
    /// Carry for a private-mode CSI split across PTY reads (mirrors
    /// `alt_screen_tail`, bounded by [`PRIVATE_MODE_TAIL_CAP`]).
    private_mode_tail: Mutex<Vec<u8>>,
    /// This session's broadcast toggle, synced from the SPA via the
    /// `set-broadcast` WS frame on toggle and on (re)connect. Gates the
    /// cross-window input fan (see `broadcast_input_cross_window`) and is
    /// surfaced in the roster so other windows can render the broadcast
    /// state of members they do not host.
    broadcast: AtomicBool,
    closed: AtomicBool,
    /// The systemd fd-store reservation this session's PTY master is parked
    /// under, when continuous parking is enabled. Taken exactly once by
    /// [`Session::unpark_fdstore`] on the first close/exit path to reach it,
    /// so store removal is idempotent across converging paths. Lock order: a
    /// registry sessions lock may be held while this is READ (manifest
    /// snapshot); never invoke the parker while holding this lock.
    #[cfg(target_os = "linux")]
    fdstore_parked: Mutex<Option<ParkedFd>>,
    /// The PTY's exit state, set once its child process exits (the same value
    /// broadcast as [`SessionEvent::Exit`]). `None` while the process runs.
    /// Stored -- not only broadcast -- so a poller (the desktop's control-script
    /// scrape) can see the script died without subscribing to the event
    /// stream. Retained on the still-mapped session after a natural exit.
    exit: Mutex<Option<TerminalExit>>,
}

impl Session {
    fn live_metadata(&self) -> LiveTerminalMetadata {
        self.live_metadata
            .lock()
            .expect("terminal live metadata poisoned")
            .clone()
    }

    fn spawn(
        id: String,
        config: RegistryConfig,
        opts: CreateOptions,
        announce_command: bool,
        generation: u64,
        registry_last_exit: Arc<Mutex<Option<TerminalExit>>>,
    ) -> anyhow::Result<Arc<Self>> {
        #[cfg(test)]
        if opts.env.contains_key("CHAN_TEST_FAIL_TERMINAL_SPAWN") {
            anyhow::bail!("injected terminal spawn failure");
        }
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
        // Windows: the terminal shell is Git BASH (a hard dependency). Prepend
        // the chan bin dir (`%LOCALAPPDATA%\chan\bin`) so the `chan` /
        // `cs` shims resolve. The shim dir is only ever added to the HKCU PATH
        // registry by `cs_install::ensure_on_user_path`, which never reaches
        // this already-running process's inherited env -- so prepend it here,
        // independent of registry propagation. Must match `cs_install`'s
        // `shim_bin_dir` (`dirs::data_local_dir().join("chan").join("bin")`).
        // Layered over any per-session PATH override, then the inherited PATH.
        #[cfg(windows)]
        {
            let mut prepend: Vec<PathBuf> = Vec::new();
            if let Some(local) = dirs::data_local_dir() {
                prepend.push(local.join("chan").join("bin"));
            }
            if !prepend.is_empty() {
                let inherited = opts
                    .env
                    .get("PATH")
                    .cloned()
                    .or_else(|| std::env::var("PATH").ok())
                    .unwrap_or_default();
                prepend.extend(std::env::split_paths(&inherited));
                if let Ok(joined) = std::env::join_paths(prepend) {
                    cmd.env("PATH", joined);
                }
            }
        }
        // Spawn-time TERM comes from settings. The value lives in
        // `TerminalConfig::default_term`; the SPA can
        // override the default via the Settings panel, and the change
        // takes effect on newly-spawned terminals (existing PTYs keep
        // whatever TERM they were started with).
        cmd.env("TERM", config.terminal.default_term.as_str());
        cmd.env("COLORTERM", "truecolor");
        cmd.env("CLICOLOR", "1");
        cmd.env("CLICOLOR_FORCE", "1");
        cmd.env("FORCE_COLOR", "3");
        // GUI-launched servers (notably chan-desktop on macOS) frequently
        // inherit an empty locale, so `less` and `vim` fall back to the
        // POSIX/C codeset and render multibyte UTF-8 (e.g. an em dash) as raw
        // bytes. Provide a language-neutral UTF-8 default when nothing already
        // selects one, and drop any non-UTF-8 LC_ALL/LC_CTYPE so the LANG
        // default actually controls the codeset (the user's shell profile can
        // still re-export LANG). C.UTF-8 is present on macOS, every musl Linux
        // build, and glibc >= 2.35 / Debian / Ubuntu / RHEL 8+.
        if !locale_selects_utf8(&opts.env) {
            cmd.env("LANG", "C.UTF-8");
            cmd.env_remove("LC_ALL");
            cmd.env_remove("LC_CTYPE");
        }
        cmd.env("CHAN", "1");
        clear_mcp_env(&mut cmd);
        cmd.env(
            "CHAN_TERMINAL",
            if config.terminal.ghostty {
                "ghostty"
            } else {
                "xterm"
            },
        );
        if opts.mcp_env {
            if let Some(socket_path) = config.mcp_socket_path.as_deref() {
                set_mcp_env(&mut cmd, socket_path);
            }
        }
        let spawn_name = opts.tab_name.clone();
        if let Some(tab_name) = spawn_name.as_deref() {
            cmd.env("CHAN_TAB_NAME", tab_name);
        }
        // Every terminal has a well-defined group, so $CHAN_TAB_GROUP is
        // always set (default when unset) -- an agent can read it
        // unconditionally to learn its broadcast group.
        let spawn_group = Some(
            opts.tab_group
                .clone()
                .unwrap_or_else(|| DEFAULT_TERMINAL_GROUP.to_string()),
        );
        cmd.env(
            "CHAN_TAB_GROUP",
            spawn_group
                .as_deref()
                .expect("new terminal spawn group is resolved"),
        );
        let window_id = opts.window_id.clone();
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
        chan_systemd::scrub_child_supervision_env(|key| cmd.env_remove(key));

        let mut child = pair.slave.spawn_command(cmd)?;
        let child_pid = child.process_id();
        #[cfg(target_os = "linux")]
        let master_fd = pair
            .master
            .as_raw_fd()
            .and_then(|fd| clone_master_fd(fd).ok());
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader()?;
        let mut writer = pair.master.take_writer()?;
        let (command_tx, command_rx) = std::sync::mpsc::channel::<PtyCommand>();
        let (output_tx, _) = broadcast::channel::<SessionEvent>(BROADCAST_CAP);
        let (write_queue, last_deliver_at, awaiting_gen) = fresh_queue_state();
        let session = Arc::new(Self {
            id,
            live_metadata: Mutex::new(LiveTerminalMetadata {
                name: spawn_name.clone(),
                group: spawn_group
                    .clone()
                    .expect("new terminal spawn group is resolved"),
            }),
            spawn_name,
            spawn_group,
            window_id: Mutex::new(window_id),
            pane_id: Mutex::new(None),
            side: Mutex::new(None),
            tab_id: Mutex::new(None),
            generation,
            workspace_root: config.workspace_root.clone(),
            #[cfg(target_os = "linux")]
            master_fd,
            spawn_opts: CreateOptions {
                size: opts.size,
                tab_name: None,
                tab_group: None,
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
            // Seed output-idle at spawn time so a brand-new session is not
            // treated as instantly idle before it has rendered anything.
            last_output_at: AtomicI64::new(now_unix_millis()),
            write_queue,
            last_deliver_at,
            awaiting_gen,
            attach_count: AtomicUsize::new(0),
            detached_at: AtomicI64::new(now_unix_secs() as i64),
            winsize: Mutex::new(opts.size),
            focused: AtomicBool::new(false),
            bytes_since_focus: AtomicU64::new(0),
            in_alt_screen: AtomicBool::new(false),
            alt_screen_tail: Mutex::new(Vec::new()),
            private_modes: Mutex::new(BTreeSet::new()),
            private_mode_tail: Mutex::new(Vec::new()),
            broadcast: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            #[cfg(target_os = "linux")]
            fdstore_parked: Mutex::new(None),
            exit: Mutex::new(None),
        });

        // A single-purpose / devserver CONTROL tenant echoes a banner naming
        // the command it is about to run, so the user sees the launch command
        // before its output. Recorded into the replay ring HERE -- after the
        // session exists but BEFORE the reader thread starts -- so the banner is
        // the first ring bytes (precedes the child's output) and survives
        // scrollback replay on reload. Display-only: the executed command
        // (`command_builder` above) is untouched; this never wraps or re-quotes
        // it.
        if announce_command {
            if let Some(command) = session.spawn_opts.command.as_deref() {
                session.record_output(format!("{command}\r\n").as_bytes());
            }
        }

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
                                if let Err(e) = write_input_parts(
                                    writer.as_mut(),
                                    &[data],
                                    Duration::ZERO,
                                    std::thread::sleep,
                                ) {
                                    session.broadcast(SessionEvent::Error(format!(
                                        "terminal write failed: {e}"
                                    )));
                                    terminate_child(child.as_mut());
                                    return;
                                }
                            }
                            PtyCommand::InputSequence { parts, gap } => {
                                if let Err(e) = write_input_parts(
                                    writer.as_mut(),
                                    &parts,
                                    gap,
                                    std::thread::sleep,
                                ) {
                                    session.broadcast(SessionEvent::Error(format!(
                                        "terminal write failed: {e}"
                                    )));
                                    terminate_child(child.as_mut());
                                    return;
                                }
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
                                terminate_child(child.as_mut());
                                return;
                            }
                        }
                    }

                    match child.try_wait() {
                        Ok(Some(status)) => {
                            let exit = TerminalExit::from_status(&status);
                            // The PTY is dead: its store entry leaves NOW, not
                            // at the eventual reap, so a restart in between
                            // never inherits a dead master.
                            session.unpark_fdstore();
                            // Record before broadcasting so a poller that reads
                            // the registry right after the event still sees it.
                            *session.exit.lock().expect("session exit poisoned") =
                                Some(exit.clone());
                            *registry_last_exit
                                .lock()
                                .expect("terminal registry poisoned") = Some(exit.clone());
                            session.broadcast(SessionEvent::Exit(exit));
                            return;
                        }
                        Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                        Err(e) => {
                            session.unpark_fdstore();
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

    #[cfg(target_os = "linux")]
    fn fdstore_manifest_entry(&self, tenant_prefix: &str) -> Option<FdStoreManifestEntry> {
        if self.closed.load(Ordering::Relaxed) {
            return None;
        }
        let fd_name = self
            .fdstore_parked
            .lock()
            .expect("terminal fdstore parked poisoned")
            .as_ref()?
            .name
            .clone();
        let size = *self.winsize.lock().expect("terminal winsize poisoned");
        let private_modes = self
            .private_modes
            .lock()
            .expect("terminal private modes poisoned")
            .iter()
            .copied()
            .collect();
        let live_metadata = self.live_metadata();
        let meta = FdStoreSessionMeta {
            tenant_prefix: tenant_prefix.to_string(),
            session_id: self.id.clone(),
            tab_name: live_metadata.name,
            tab_group: Some(live_metadata.group),
            spawn_name: self.spawn_name.clone(),
            spawn_group: self.spawn_group.clone(),
            window_id: self.window_id(),
            pane_id: self.pane_id(),
            side: self.side(),
            tab_id: self.tab_id(),
            cwd: self.cwd().or_else(|| self.spawn_opts.cwd.clone()),
            command: self.spawn_opts.command.clone(),
            env: self.spawn_opts.env.clone(),
            mcp_env: self.spawn_opts.mcp_env,
            child_pid: self.child_pid,
            size: size.into(),
            seq: self.seq.load(Ordering::Relaxed),
            generation: self.generation,
            alt_screen: self.in_alt_screen.load(Ordering::Relaxed),
            private_modes,
        };
        Some(FdStoreManifestEntry {
            fd_name,
            meta,
            replay: self.fdstore_replay_tail(),
        })
    }

    #[cfg(target_os = "linux")]
    fn from_imported(
        config: RegistryConfig,
        import: FdStoreSessionImport,
        registry_last_exit: Arc<Mutex<Option<TerminalExit>>>,
    ) -> anyhow::Result<Arc<Self>> {
        let FdStoreSessionImport {
            meta,
            master_fd,
            replay,
        } = import;
        let size: PtySize = meta.size.into();
        let cwd = meta
            .cwd
            .clone()
            .unwrap_or_else(|| config.workspace_root.clone());
        let reader_fd = master_fd.as_fd().try_clone_to_owned()?;
        let writer_fd = master_fd.as_fd().try_clone_to_owned()?;
        let mut reader = ImportedPtyFd(File::from(reader_fd));
        let mut writer = File::from(writer_fd);
        let (command_tx, command_rx) = std::sync::mpsc::channel::<PtyCommand>();
        let (output_tx, _) = broadcast::channel::<SessionEvent>(BROADCAST_CAP);
        let (write_queue, last_deliver_at, awaiting_gen) = fresh_queue_state();
        let session = Arc::new(Self {
            id: meta.session_id.clone(),
            live_metadata: Mutex::new(LiveTerminalMetadata {
                name: meta.tab_name.clone(),
                group: meta
                    .tab_group
                    .clone()
                    .unwrap_or_else(|| DEFAULT_TERMINAL_GROUP.to_string()),
            }),
            spawn_name: meta.spawn_name.clone(),
            spawn_group: meta.spawn_group.clone(),
            window_id: Mutex::new(meta.window_id.clone()),
            pane_id: Mutex::new(meta.pane_id.clone()),
            side: Mutex::new(meta.side),
            tab_id: Mutex::new(meta.tab_id.clone()),
            generation: meta.generation,
            workspace_root: config.workspace_root.clone(),
            spawn_opts: CreateOptions {
                size,
                tab_name: None,
                tab_group: None,
                window_id: None,
                mcp_env: meta.mcp_env,
                cwd: Some(cwd),
                command: meta.command.clone(),
                env: meta.env.clone(),
            },
            child_pid: meta.child_pid,
            master_fd: Some(master_fd),
            command_tx,
            output_tx,
            ring: Mutex::new(RingBuffer::new_with_replay(
                config.terminal.ring_bytes,
                meta.seq,
                &replay,
            )),
            seq: AtomicU64::new(meta.seq),
            last_activity: AtomicI64::new(now_unix_secs() as i64),
            last_output_at: AtomicI64::new(now_unix_millis()),
            write_queue,
            last_deliver_at,
            awaiting_gen,
            attach_count: AtomicUsize::new(0),
            detached_at: AtomicI64::new(now_unix_secs() as i64),
            winsize: Mutex::new(size),
            focused: AtomicBool::new(false),
            bytes_since_focus: AtomicU64::new(0),
            in_alt_screen: AtomicBool::new(meta.alt_screen),
            alt_screen_tail: Mutex::new(Vec::new()),
            private_modes: Mutex::new(meta.private_modes.into_iter().collect()),
            private_mode_tail: Mutex::new(Vec::new()),
            broadcast: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            #[cfg(target_os = "linux")]
            fdstore_parked: Mutex::new(None),
            exit: Mutex::new(None),
        });

        {
            let session = session.clone();
            let registry_last_exit = registry_last_exit.clone();
            std::thread::Builder::new()
                .name("chan-terminal-fdstore-reader".into())
                .spawn(move || {
                    let mut buf = [0u8; 8192];
                    loop {
                        match reader.read(&mut buf) {
                            Ok(0) => {
                                session.record_terminal_exit(
                                    TerminalExit::Unknown,
                                    &registry_last_exit,
                                );
                                break;
                            }
                            Ok(n) => session.record_output(&buf[..n]),
                            Err(e) => {
                                session.broadcast(SessionEvent::Error(format!(
                                    "terminal read failed: {e}"
                                )));
                                session.record_terminal_exit(
                                    TerminalExit::Unknown,
                                    &registry_last_exit,
                                );
                                break;
                            }
                        }
                    }
                })?;
        }

        {
            let session = session.clone();
            std::thread::Builder::new()
                .name("chan-terminal-fdstore-controller".into())
                .spawn(move || {
                    while let Ok(cmd) = command_rx.recv() {
                        match cmd {
                            PtyCommand::Input(data) => {
                                if let Err(e) = write_input_parts(
                                    &mut writer,
                                    &[data],
                                    Duration::ZERO,
                                    std::thread::sleep,
                                ) {
                                    session.broadcast(SessionEvent::Error(format!(
                                        "terminal write failed: {e}"
                                    )));
                                    return;
                                }
                            }
                            PtyCommand::InputSequence { parts, gap } => {
                                if let Err(e) =
                                    write_input_parts(&mut writer, &parts, gap, std::thread::sleep)
                                {
                                    session.broadcast(SessionEvent::Error(format!(
                                        "terminal write failed: {e}"
                                    )));
                                    return;
                                }
                            }
                            PtyCommand::Resize(size) => {
                                if let Err(e) = resize_imported_master(&writer, size) {
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
                                        resize_imported_master(&writer, size)
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
                                if let Some(pid) = session.child_pid {
                                    signal_imported_child(pid);
                                }
                                return;
                            }
                        }
                    }
                })?;
        }

        Ok(session)
    }

    #[cfg(target_os = "linux")]
    fn fdstore_replay_tail(&self) -> Vec<u8> {
        let (chunks, _missed) = self
            .ring
            .lock()
            .expect("terminal ring poisoned")
            .snapshot_since(None);
        let replay = chunks.concat();
        if replay.len() <= FDSTORE_REPLAY_BYTES {
            return replay;
        }
        replay[replay.len() - FDSTORE_REPLAY_BYTES..].to_vec()
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
        let generation = self.generation;
        let mode_reassert = self.private_mode_prelude();
        AttachHandle {
            id: self.id.clone(),
            session: self,
            rx,
            replay,
            seq,
            generation,
            missed_bytes,
            alt_screen,
            mode_reassert,
        }
    }

    fn send_input(&self, data: &[u8]) {
        self.last_activity
            .store(now_unix_secs() as i64, Ordering::Relaxed);
        let _ = self.command_tx.send(PtyCommand::Input(data.to_vec()));
    }

    fn send_input_plan(&self, parts: Vec<Vec<u8>>) {
        self.last_activity
            .store(now_unix_secs() as i64, Ordering::Relaxed);
        let command = if parts.len() == 1 {
            PtyCommand::Input(parts.into_iter().next().unwrap_or_default())
        } else {
            PtyCommand::InputSequence {
                parts,
                gap: write_queue_input_gap(),
            }
        };
        let _ = self.command_tx.send(command);
    }

    /// One drainer step for this session's logical input queue. At one safe
    /// idle opportunity, pop the maximal eligible notification prefix and
    /// deliver it as one agent turn. Boundaries and singletons retain their
    /// normal encoding. The generation-start wait applies once to the whole
    /// delivery plan.
    fn try_drain_batch(&self, now_ms: i64) {
        if self
            .write_queue
            .lock()
            .expect("terminal write queue poisoned")
            .is_empty()
        {
            // Nothing pending: clear the post-deliver await state so the next
            // enqueue starts clean.
            self.last_deliver_at.store(0, Ordering::Relaxed);
            self.awaiting_gen.store(false, Ordering::Relaxed);
            return;
        }
        let last_output = self.last_output_at.load(Ordering::Relaxed);
        // After a deliver, hold the next message until the agent's generation
        // has STARTED (output advanced past the delivery) or the cap elapses
        // (the message did not trigger generation), so two messages never
        // fire into one compose in the post-submit, pre-generation window.
        if self.awaiting_gen.load(Ordering::Relaxed) {
            let delivered_at = self.last_deliver_at.load(Ordering::Relaxed);
            let generation_started = last_output > delivered_at;
            let timed_out = now_ms - delivered_at >= WRITE_QUEUE_GEN_START_CAP_MS;
            if generation_started || timed_out {
                self.awaiting_gen.store(false, Ordering::Relaxed);
            } else {
                return;
            }
        }
        // Deliver only once the agent is idle (the previous turn, if any, has
        // quiesced).
        if now_ms - last_output < WRITE_QUEUE_QUIET_MS {
            return;
        }
        // Select and pop under the queue mutex; frame and encode outside it.
        let next = {
            let mut q = self
                .write_queue
                .lock()
                .expect("terminal write queue poisoned");
            let (messages, stop) = pop_batch(&mut q, WRITE_QUEUE_BATCH_MAX_BYTES);
            let depth = msg_depth(&q);
            (!messages.is_empty()).then_some((messages, depth, stop))
        };
        if let Some((mut messages, depth, stop)) = next {
            let count = messages.len();
            let batched = count > 1;
            let source = messages[0].source.as_str();
            let submit = messages[0].submit.clone();
            let part = messages[0].part;
            let agent = submit
                .as_ref()
                .map(|resolved| resolved.agent.name())
                .unwrap_or("none");
            let prompt_id = (!batched).then(|| messages[0].prompt_id.clone()).flatten();
            let text = if batched {
                let refs: Vec<&QueuedMessage> = messages.iter().collect();
                format_notification_batch(&refs)
            } else {
                messages.pop().expect("non-empty selected batch").data
            };
            let plan = match part {
                // A batch is always whole `cs terminal write` messages: a split
                // entry is a FIFO boundary, so `part` here is the singleton's.
                MessagePart::Whole => plan_submitted_input(text, submit.as_ref(), batched),
                MessagePart::Body => PtyInputPlan {
                    parts: vec![chan_shell::submitted_body_bytes(&text)],
                },
                MessagePart::Chord => PtyInputPlan {
                    parts: vec![chan_shell::submit_chord_bytes(
                        submit
                            .as_ref()
                            .expect("a chord entry carries its submit spec"),
                    )],
                },
            };
            let bytes = plan.parts.iter().map(Vec::len).sum::<usize>();
            tracing::trace!(
                event = "terminal_write_drain",
                session = %self.id,
                messages = count,
                bytes,
                parts = plan.parts.len(),
                remaining = depth,
                agent,
                delivery = if batched { "batch" } else { "single" },
                source,
                boundary = stop.as_str()
            );
            self.send_input_plan(plan.parts);
            self.last_deliver_at.store(now_ms, Ordering::Relaxed);
            self.awaiting_gen.store(true, Ordering::Relaxed);
            // Only a TAIL drain completes a message; a split body leaves its
            // message pending until the chord lands one idle gate later, so it
            // emits nothing (the message depth did not change).
            if part.is_tail() {
                if let Some(id) = prompt_id {
                    self.broadcast(SessionEvent::PromptDelivered { id, depth });
                }
                self.broadcast(SessionEvent::QueueDepth(depth));
            }
        }
    }

    /// The submit agent this session's terminal runs, derived from its own
    /// spawn command and `CHAN_AGENT` spawn env -- the same
    /// `SubmitAgent::derive` rule the SPA session frame uses
    /// (`routes/terminal.rs::session_frame`). This is the server-side
    /// authority for chord selection on the write path: `None` is a shell
    /// session that never receives a chord.
    fn derived_submit_agent(&self) -> Option<SubmitAgent> {
        SubmitAgent::derive(
            self.spawn_opts.command.as_deref().unwrap_or_default(),
            self.spawn_opts.env.get("CHAN_AGENT").map(String::as_str),
        )
    }

    /// Push one `cs terminal write` message, all-or-nothing at the byte and
    /// entry caps (a partial push could deliver a body whose chord was silently
    /// dropped).
    /// Returns the message depth after the push: the poke's 1-based position
    /// among the PENDING MESSAGES, the same number the SPA badge and
    /// `cs terminal list --json` show. A Gemini poke occupies two entries and
    /// still reports position 1 on an empty queue.
    fn enqueue_cs_write(&self, data: String, submit: Option<ResolvedSubmit>) -> Option<usize> {
        let depth = {
            let mut q = self
                .write_queue
                .lock()
                .expect("terminal write queue poisoned");
            push_message(&mut q, data, submit, QueueSource::CsWrite, None)?;
            msg_depth(&q)
        };
        // Outside the QUEUE guard. The enqueue_write_matching caller does
        // hold the REGISTRY guard here, which is fine: broadcast::send is
        // sync, takes only the channel's internal lock, and nothing it
        // wakes can re-enter the registry synchronously.
        self.broadcast(SessionEvent::QueueDepth(depth));
        Some(depth)
    }

    /// Push a Rich Prompt as one logical message, all-or-nothing at the byte
    /// and entry caps. Returns the message depth after the push, its 1-based
    /// queue position.
    fn enqueue_prompt(
        &self,
        data: String,
        submit: Option<ResolvedSubmit>,
        prompt_id: Option<String>,
    ) -> Option<usize> {
        let depth = {
            let mut q = self
                .write_queue
                .lock()
                .expect("terminal write queue poisoned");
            push_message(&mut q, data, submit, QueueSource::RichPrompt, prompt_id)?;
            msg_depth(&q)
        };
        self.broadcast(SessionEvent::QueueDepth(depth));
        Some(depth)
    }

    /// Recall a still-queued Rich Prompt message: drop EVERY entry sharing
    /// `prompt_id` (a split body plus its chord) atomically under the queue
    /// lock, so the all-or-nothing invariant and the tail count stay
    /// consistent. Returns whether anything was removed; on a removal, re-emit
    /// `QueueDepth` so every attached socket re-syncs its badge.
    ///
    /// The in-flight entry is `pop_front`'ed before delivery
    /// (`try_drain_batch`), so it is NOT in `write_queue`: the retain-filter can
    /// never touch or reorder the message currently being delivered. The
    /// cancel-vs-drain race is resolved here under the lock -- if the message
    /// drained the same tick, `removed` is `false` and the caller acks that so
    /// the UI does not claim to recall a message that already hit the PTY.
    fn cancel_prompt(&self, prompt_id: &str) -> bool {
        let (removed, depth) = {
            let mut q = self
                .write_queue
                .lock()
                .expect("terminal write queue poisoned");
            let before = q.len();
            q.retain(|message| message.prompt_id.as_deref() != Some(prompt_id));
            (q.len() != before, msg_depth(&q))
        };
        if removed {
            self.broadcast(SessionEvent::QueueDepth(depth));
        }
        removed
    }

    /// The `prompt_id`s of the tail-bearing entries still queued, in FIFO
    /// order -- one id per Rich Prompt message. `cs terminal write` pokes carry
    /// no `prompt_id` and are skipped, so membership is exact (a restored
    /// pending id is in the list iff still queued).
    fn queued_prompt_ids(&self) -> Vec<String> {
        self.write_queue
            .lock()
            .expect("terminal write queue poisoned")
            .iter()
            .filter(|message| message.part.is_tail())
            .filter_map(|message| message.prompt_id.clone())
            .collect()
    }

    /// Current logical MESSAGE depth of the write queue (tail count).
    fn queue_depth(&self) -> usize {
        msg_depth(
            &self
                .write_queue
                .lock()
                .expect("terminal write queue poisoned"),
        )
    }

    /// The full replay ring, flattened, for `cs terminal scrollback`.
    /// `snapshot_since(None)` returns every chunk currently held (no
    /// `missed`, since we ask from the ring's own start), so this is the
    /// whole scrollback the ring still has, raw PTY bytes and all. Unlike
    /// `attach`, this does not special-case the alt screen: a scrollback
    /// dump wants whatever bytes the ring holds, including a live TUI draw.
    fn scrollback(&self) -> Vec<u8> {
        let (chunks, _missed) = self
            .ring
            .lock()
            .expect("terminal ring poisoned")
            .snapshot_since(None);
        chunks.concat()
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

    fn set_broadcast(&self, on: bool) {
        self.broadcast.store(on, Ordering::Relaxed);
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
        let metadata = self.live_metadata();
        opts.size = *self.winsize.lock().expect("terminal winsize poisoned");
        opts.tab_name = metadata.name;
        opts.tab_group = Some(metadata.group);
        opts.window_id = self.window_id();
        opts
    }

    fn close(&self, reason: CloseReason) {
        if self.closed.swap(true, Ordering::Relaxed) {
            return;
        }
        // After the swap guard: a DETACHED session (closed=true, still
        // parked) must keep its store entry through process exit, so a late
        // close() on it returns above without unparking.
        self.unpark_fdstore();
        self.broadcast(SessionEvent::Closed(reason));
        let _ = self.command_tx.send(PtyCommand::Kill);
    }

    /// Reserve the parked state, then store the fd and durably commit the
    /// manifest. The reservation is made visible BEFORE the park call so the
    /// commit's host snapshot includes this session, and rolled back if the
    /// hook reports failure. Never called under a registry sessions lock.
    #[cfg(target_os = "linux")]
    fn park_fdstore(&self, parker: &FdStoreParker) {
        if self.closed.load(Ordering::Relaxed) {
            return;
        }
        let Some(master_fd) = self.master_fd.as_ref() else {
            return;
        };
        let name = fdstore_fd_name(&self.id, self.child_pid);
        {
            let mut parked = self
                .fdstore_parked
                .lock()
                .expect("terminal fdstore parked poisoned");
            if parked.is_some() {
                return;
            }
            *parked = Some(ParkedFd {
                name: name.clone(),
                parker: parker.clone(),
            });
        }
        if !parker.park(&name, master_fd.as_fd()) {
            self.fdstore_parked
                .lock()
                .expect("terminal fdstore parked poisoned")
                .take();
            return;
        }
        // Did the reservation survive the in-flight park? A concurrent
        // close/exit may have CONSUMED it while `park` ran: its take-once
        // unpark then sent FDSTOREREMOVE before our FDSTORE landed, so the
        // just-stored fd is ownerless and no later take can ever remove it.
        let survived = self
            .fdstore_parked
            .lock()
            .expect("terminal fdstore parked poisoned")
            .as_ref()
            .is_some_and(|parked| parked.name == name);
        if !survived {
            // Compensate directly: the reservation is gone, so this is the
            // only remover left for the stored name.
            parker.unpark(&name);
            return;
        }
        // Exit/close may have LANDED without consuming the reservation yet
        // (between the closed swap and its take): converge through the
        // take-once unpark, which exactly one of the two sides wins.
        if self.closed.load(Ordering::Relaxed)
            || self.exit.lock().expect("session exit poisoned").is_some()
        {
            self.unpark_fdstore();
        }
    }

    /// Record an inherited fd the store already retains (boot restore).
    /// Same reservation/rollback shape as [`Session::park_fdstore`], without
    /// a store call.
    #[cfg(target_os = "linux")]
    fn adopt_fdstore(&self, parker: &FdStoreParker) {
        if self.closed.load(Ordering::Relaxed) {
            return;
        }
        let name = fdstore_fd_name(&self.id, self.child_pid);
        {
            let mut parked = self
                .fdstore_parked
                .lock()
                .expect("terminal fdstore parked poisoned");
            if parked.is_some() {
                return;
            }
            *parked = Some(ParkedFd {
                name: name.clone(),
                parker: parker.clone(),
            });
        }
        if !parker.adopt(&name) {
            self.fdstore_parked
                .lock()
                .expect("terminal fdstore parked poisoned")
                .take();
            return;
        }
        // Same exit/close race convergence as `park_fdstore`: the imported
        // reader may observe an instant EOF before the adoption lands.
        if self.closed.load(Ordering::Relaxed)
            || self.exit.lock().expect("session exit poisoned").is_some()
        {
            self.unpark_fdstore();
        }
    }

    /// Remove this session's fd-store entry, exactly once. Every close/exit
    /// path converges here: explicit close, in-place restart, child exit,
    /// read failure, registry removal. Safe to call repeatedly and from any
    /// state; a never-parked or already-unparked session is a no-op.
    #[cfg(target_os = "linux")]
    fn unpark_fdstore(&self) {
        let taken = self
            .fdstore_parked
            .lock()
            .expect("terminal fdstore parked poisoned")
            .take();
        if let Some(parked) = taken {
            parked.parker.unpark(&parked.name);
        }
    }

    #[cfg(not(target_os = "linux"))]
    fn unpark_fdstore(&self) {}

    #[cfg(target_os = "linux")]
    fn is_fdstore_parked(&self) -> bool {
        self.fdstore_parked
            .lock()
            .expect("terminal fdstore parked poisoned")
            .is_some()
    }

    /// Republish parked metadata after a manifest-relevant change.
    #[cfg(target_os = "linux")]
    fn parked_changed(&self) {
        let parker = self
            .fdstore_parked
            .lock()
            .expect("terminal fdstore parked poisoned")
            .as_ref()
            .map(|parked| parked.parker.clone());
        if let Some(parker) = parker {
            parker.changed();
        }
    }

    /// Mark closed WITHOUT killing the child or unparking: the master stays
    /// in the systemd fd store and the child keeps running for the next
    /// devserver instance to re-import. Only the graceful-shutdown detach
    /// sweep calls this.
    #[cfg(target_os = "linux")]
    fn detach_for_fdstore_restart(&self) {
        if self.closed.swap(true, Ordering::Relaxed) {
            return;
        }
        self.broadcast(SessionEvent::Closed(CloseReason::Shutdown));
    }

    /// Like [`close`](Self::close) but signals an in-place RESTART instead of a
    /// teardown: broadcast [`SessionEvent::Restarted`] (not `Closed`) before
    /// killing the old PTY, so an attached `/ws` reader re-attaches to the
    /// relaunched session (same id) rather than dropping the tab. The `Kill`
    /// command returns the controller thread before its `try_wait` `Exit`
    /// branch, so no `Exit` leaks either; and the reader moves to the new
    /// channel on `Restarted`, so any racing old-PTY event goes unseen.
    fn close_for_restart(&self) {
        if self.closed.swap(true, Ordering::Relaxed) {
            return;
        }
        // The replacement incarnation is already parked under its own name
        // (the pid differs), so removing this one's entry cannot touch it.
        self.unpark_fdstore();
        self.broadcast(SessionEvent::Restarted);
        let _ = self.command_tx.send(PtyCommand::Kill);
    }

    /// The window (`?w=` label) this session currently belongs to.
    fn window_id(&self) -> Option<String> {
        self.window_id
            .lock()
            .expect("terminal window_id poisoned")
            .clone()
    }

    /// This session incarnation's epoch. Stable for the PTY's life; a restart
    /// mints a new session under the same id with a higher value.
    fn generation(&self) -> u64 {
        self.generation
    }

    /// Rebind the owning window on reattach. A `None`
    /// (windowless) reattach does NOT clear an existing binding -- only a real
    /// attaching window re-homes the session.
    fn set_window_id(&self, window_id: Option<String>) {
        if window_id.is_none() {
            return;
        }
        *self.window_id.lock().expect("terminal window_id poisoned") = window_id;
    }

    /// The SPA pane id this session was last attached under (`cs term list`).
    fn pane_id(&self) -> Option<String> {
        self.pane_id
            .lock()
            .expect("terminal pane_id poisoned")
            .clone()
    }

    /// The Hybrid side this session was last attached under.
    fn side(&self) -> Option<PaneSide> {
        *self.side.lock().expect("terminal side poisoned")
    }

    /// The SPA tab id this session was last attached under (`cs term list`).
    fn tab_id(&self) -> Option<String> {
        self.tab_id
            .lock()
            .expect("terminal tab_id poisoned")
            .clone()
    }

    /// Rebind the pane id on reattach. Like [`Session::set_window_id`], a `None`
    /// (the id was not reported) does NOT clear an existing binding.
    fn set_pane_id(&self, pane_id: Option<String>) {
        if pane_id.is_none() {
            return;
        }
        *self.pane_id.lock().expect("terminal pane_id poisoned") = pane_id;
    }

    /// Rebind the Hybrid side on attach or a live placement update.
    fn set_side(&self, side: Option<PaneSide>) {
        if side.is_none() {
            return;
        }
        *self.side.lock().expect("terminal side poisoned") = side;
    }

    /// Rebind the tab id on reattach. A `None` does NOT clear the binding.
    fn set_tab_id(&self, tab_id: Option<String>) {
        if tab_id.is_none() {
            return;
        }
        *self.tab_id.lock().expect("terminal tab_id poisoned") = tab_id;
    }

    #[cfg(target_os = "linux")]
    fn record_terminal_exit(
        &self,
        exit: TerminalExit,
        registry_last_exit: &Arc<Mutex<Option<TerminalExit>>>,
    ) {
        if self.closed.load(Ordering::Relaxed) {
            return;
        }
        let mut stored = self.exit.lock().expect("session exit poisoned");
        if stored.is_some() {
            return;
        }
        *stored = Some(exit.clone());
        drop(stored);
        // Imported-session exit/EOF/read-failure convergence: the dead PTY
        // leaves the store immediately (idempotent take).
        self.unpark_fdstore();
        *registry_last_exit
            .lock()
            .expect("terminal registry poisoned") = Some(exit.clone());
        self.broadcast(SessionEvent::Exit(exit));
    }

    fn record_output(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.last_activity
            .store(now_unix_secs() as i64, Ordering::Relaxed);
        // Output-only timestamp for the write-queue's idle/quiescence signal
        // (the agent is rendering / generating).
        self.last_output_at
            .store(now_unix_millis(), Ordering::Relaxed);
        self.update_alt_screen(bytes);
        self.update_private_modes(bytes);
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

    /// Track the live [`TRACKED_PRIVATE_MODES`] set by parsing DEC private-mode
    /// CSIs -- `ESC [ ? <;-joined decimal params> (h|l)` -- out of PTY output.
    /// `h` adds each tracked param to the set, `l` removes it; a sequence split
    /// across reads is carried in `private_mode_tail`. Non-`h`/`l` finals (a
    /// DECRQM `$p` query, a report, …) are skipped without toggling. Sequences
    /// can carry several modes at once (htop emits `\e[?1006;1000h`).
    fn update_private_modes(&self, bytes: &[u8]) {
        let mut tail = self
            .private_mode_tail
            .lock()
            .expect("terminal private-mode tail poisoned");
        let mut scan = Vec::with_capacity(tail.len() + bytes.len());
        scan.extend_from_slice(&tail);
        scan.extend_from_slice(bytes);
        tail.clear();

        let mut changes: Vec<(u16, bool)> = Vec::new();
        let n = scan.len();
        let mut i = 0;
        while i < n {
            if scan[i] != 0x1b {
                i += 1;
                continue;
            }
            // A private-mode CSI begins ESC '[' '?'. Fewer than 3 trailing bytes
            // could still grow into one on the next read -- carry from the ESC.
            if n - i < 3 {
                if n - i <= PRIVATE_MODE_TAIL_CAP {
                    tail.extend_from_slice(&scan[i..]);
                }
                break;
            }
            if scan[i + 1] != b'[' || scan[i + 2] != b'?' {
                i += 1;
                continue;
            }
            // Consume `;`-joined decimal params up to the final byte.
            let mut j = i + 3;
            while j < n && (scan[j].is_ascii_digit() || scan[j] == b';') {
                j += 1;
            }
            if j == n {
                // Params not yet terminated -- carry the partial (bounded).
                if n - i <= PRIVATE_MODE_TAIL_CAP {
                    tail.extend_from_slice(&scan[i..]);
                }
                break;
            }
            let final_byte = scan[j];
            if final_byte == b'h' || final_byte == b'l' {
                let on = final_byte == b'h';
                for param in scan[i + 3..j].split(|&b| b == b';') {
                    if let Ok(mode) = std::str::from_utf8(param).unwrap_or("x").parse::<u16>() {
                        if TRACKED_PRIVATE_MODES.contains(&mode) {
                            changes.push((mode, on));
                        }
                    }
                }
            }
            i = j + 1;
        }
        drop(tail);

        if changes.is_empty() {
            return;
        }
        let mut modes = self
            .private_modes
            .lock()
            .expect("terminal private modes poisoned");
        for (mode, on) in changes {
            if on {
                modes.insert(mode);
            } else {
                modes.remove(&mode);
            }
        }
    }

    /// Bytes that re-assert the live tracked private-mode set on reattach  --
    /// `ESC [ ? <n> h` per mode currently on, in mode-number order. Empty when
    /// none are on (a plain shell never bloats the prelude).
    fn private_mode_prelude(&self) -> Vec<u8> {
        let modes = self
            .private_modes
            .lock()
            .expect("terminal private modes poisoned");
        let mut out = Vec::new();
        for mode in modes.iter() {
            out.extend_from_slice(format!("\x1b[?{mode}h").as_bytes());
        }
        out
    }
}

#[cfg(target_os = "linux")]
struct ImportedPtyFd(File);

#[cfg(target_os = "linux")]
impl Read for ImportedPtyFd {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self.0.read(buf) {
            // On Linux a PTY master read returns EIO once the last slave fd
            // closes (the shell exited). portable_pty's reader translates
            // that to EOF for freshly spawned sessions; mirror it here so a
            // restored session's shell exit is a clean end-of-stream, not a
            // broadcast "terminal read failed: I/O error" plus a fabricated
            // failure exit. Any other errno is a genuine read failure and
            // still surfaces as one.
            Err(e) if e.raw_os_error() == Some(rustix::io::Errno::IO.raw_os_error()) => Ok(0),
            other => other,
        }
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn clone_master_fd(raw_fd: RawFd) -> io::Result<OwnedFd> {
    // PTY masters must be duplicated, not reopened through /proc/self/fd:
    // reopening can allocate a different PTY master, so fdstore preserves a
    // handle that is not keeping the live slave-side process attached.
    let fd = filedescriptor::FileDescriptor::dup(&RawMasterFd(raw_fd)).map_err(io::Error::other)?;
    fd.as_fd().try_clone_to_owned()
}

#[cfg(target_os = "linux")]
fn resize_imported_master(master: &File, size: PtySize) -> io::Result<()> {
    let winsize = rustix::termios::Winsize {
        ws_row: size.rows,
        ws_col: size.cols,
        ws_xpixel: size.pixel_width,
        ws_ypixel: size.pixel_height,
    };
    rustix::termios::tcsetwinsize(master, winsize).map_err(io::Error::from)
}

#[cfg(target_os = "linux")]
struct RawMasterFd(RawFd);

#[cfg(target_os = "linux")]
impl AsRawFd for RawMasterFd {
    fn as_raw_fd(&self) -> RawFd {
        self.0
    }
}

#[cfg(target_os = "linux")]
fn signal_imported_child(pid: u32) {
    let Ok(raw_pid) = i32::try_from(pid) else {
        return;
    };
    let Some(pid) = rustix::process::Pid::from_raw(raw_pid) else {
        return;
    };
    let _ = rustix::process::kill_process(pid, rustix::process::Signal::HUP);
    let _ = rustix::process::kill_process(pid, rustix::process::Signal::TERM);
}

enum PtyCommand {
    Input(Vec<u8>),
    InputSequence { parts: Vec<Vec<u8>>, gap: Duration },
    Resize(PtySize),
    Redraw,
    Kill,
}

/// Terminate and reap a child through the owning handle. A cloned killer can
/// signal from another thread, but only the owner can consume the exit status
/// and release the process-table entry.
fn terminate_child(child: &mut dyn Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// Write one input plan to the PTY, flushing each part and pausing `gap`
/// between parts so a following part cannot be coalesced into its predecessor.
/// Shared by the fresh and fdstore-restored controllers so their delivery
/// cannot drift.
///
/// A flush error is as fatal as a write error: the PTY writer is unbuffered,
/// so a failing flush means the fd is already broken and the bytes did not
/// reach the child. Continuing would write a submit chord against a body the
/// agent never received, and the caller's "delivered" acknowledgment would be
/// a lie. Callers tear the session down on `Err`.
fn write_input_parts(
    writer: &mut dyn Write,
    parts: &[Vec<u8>],
    gap: Duration,
    mut sleep: impl FnMut(Duration),
) -> std::io::Result<()> {
    for (index, part) in parts.iter().enumerate() {
        writer.write_all(part)?;
        writer.flush()?;
        if index + 1 < parts.len() {
            sleep(gap);
        }
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use chan_shell::{SubmitAgent, SubmitTemplateSource};
    use std::process::Command;

    #[derive(Debug)]
    struct RecordingChild {
        calls: Arc<Mutex<Vec<&'static str>>>,
    }

    #[derive(Debug)]
    struct RecordingKiller(Arc<Mutex<Vec<&'static str>>>);

    impl portable_pty::ChildKiller for RecordingKiller {
        fn kill(&mut self) -> std::io::Result<()> {
            self.0.lock().unwrap().push("clone-kill");
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(Self(self.0.clone()))
        }
    }

    impl portable_pty::ChildKiller for RecordingChild {
        fn kill(&mut self) -> std::io::Result<()> {
            self.calls.lock().unwrap().push("kill");
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(RecordingKiller(self.calls.clone()))
        }
    }

    impl portable_pty::Child for RecordingChild {
        fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
            Ok(None)
        }

        fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
            self.calls.lock().unwrap().push("wait");
            Ok(portable_pty::ExitStatus::with_exit_code(0))
        }

        fn process_id(&self) -> Option<u32> {
            Some(1)
        }

        #[cfg(windows)]
        fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
            None
        }
    }

    #[test]
    fn termination_kills_then_waits_on_the_owning_child() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut child = RecordingChild {
            calls: calls.clone(),
        };

        terminate_child(&mut child);

        assert_eq!(*calls.lock().unwrap(), ["kill", "wait"]);
    }

    fn built_in_submit(agent: SubmitAgent) -> ResolvedSubmit {
        let template = match agent {
            SubmitAgent::Claude => "{}\x1b[27;9;13~",
            SubmitAgent::Codex => "\x1b[200~{}\x1b[201~\r",
            SubmitAgent::Gemini => "{}\r",
            SubmitAgent::Kimi => "\x1b[200~{}\x1b[201~\r",
            SubmitAgent::OpenCode => "\x1b[200~{}\x1b[201~\r",
        };
        ResolvedSubmit {
            agent,
            template: template.to_string(),
            source: SubmitTemplateSource::BuiltIn,
        }
    }

    fn queued_message(
        data: &str,
        submit: Option<ResolvedSubmit>,
        source: QueueSource,
    ) -> QueuedMessage {
        QueuedMessage {
            data: data.to_string(),
            submit,
            source,
            prompt_id: None,
            part: MessagePart::Whole,
        }
    }

    #[derive(Default)]
    struct RecordingWriter {
        writes: Vec<Vec<u8>>,
        flushes: usize,
    }

    impl Write for RecordingWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.writes.push(buf.to_vec());
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            self.flushes += 1;
            Ok(())
        }
    }

    #[test]
    fn input_parts_flush_separately_and_sleep_only_between_parts() {
        let mut writer = RecordingWriter::default();
        let parts = vec![b"body".to_vec(), b"chord".to_vec(), b"tail".to_vec()];
        let gap = Duration::from_millis(50);
        let mut sleeps = Vec::new();

        write_input_parts(&mut writer, &parts, gap, |duration| sleeps.push(duration)).unwrap();

        assert_eq!(writer.writes, parts);
        assert_eq!(writer.flushes, 3);
        assert_eq!(sleeps, vec![gap, gap]);
    }

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

    #[cfg(unix)]
    fn process_exists(pid: u32) -> bool {
        let Some(pid) = i32::try_from(pid)
            .ok()
            .and_then(rustix::process::Pid::from_raw)
        else {
            return false;
        };
        rustix::process::test_kill_process(pid).is_ok()
    }

    #[cfg(windows)]
    fn process_exists(pid: u32) -> bool {
        let output = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output()
            .expect("run tasklist");
        String::from_utf8_lossy(&output.stdout).contains(&pid.to_string())
    }

    #[cfg(any(unix, windows))]
    fn wait_for_process_to_disappear(pid: u32) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while process_exists(pid) {
            assert!(
                std::time::Instant::now() < deadline,
                "child pid {pid} still exists after termination"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(unix)]
    fn wait_for_output(handle: &mut AttachHandle, needle: &[u8]) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if handle.rx.try_recv().is_ok_and(|event| {
                matches!(event, SessionEvent::Output(data) if contains_subslice(&data, needle))
            }) {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "terminal never emitted {:?}",
                String::from_utf8_lossy(needle)
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn test_session_with_ring(ring_bytes: usize) -> Arc<Session> {
        test_session_with_commands(ring_bytes).0
    }

    fn test_session_with_commands(
        ring_bytes: usize,
    ) -> (Arc<Session>, std::sync::mpsc::Receiver<PtyCommand>) {
        test_agent_session(ring_bytes, "test-session", None, None, None, &[])
    }

    /// A fake session with explicit identity and spawn command/env, so the
    /// server-side chord-authority tests can register mixed-agent sessions in
    /// a Registry and observe delivered PTY bytes via the recorded commands.
    fn test_agent_session(
        ring_bytes: usize,
        id: &str,
        tab_name: Option<&str>,
        tab_group: Option<&str>,
        command: Option<&str>,
        env: &[(&str, &str)],
    ) -> (Arc<Session>, std::sync::mpsc::Receiver<PtyCommand>) {
        let (command_tx, command_rx) = std::sync::mpsc::channel();
        let (output_tx, _) = broadcast::channel(BROADCAST_CAP);
        let (write_queue, last_deliver_at, awaiting_gen) = fresh_queue_state();
        let live_metadata = LiveTerminalMetadata {
            name: tab_name.map(str::to_string),
            group: tab_group.unwrap_or(DEFAULT_TERMINAL_GROUP).to_string(),
        };
        let session = Arc::new(Session {
            id: id.to_string(),
            live_metadata: Mutex::new(live_metadata),
            spawn_name: tab_name.map(str::to_string),
            spawn_group: Some(tab_group.unwrap_or(DEFAULT_TERMINAL_GROUP).to_string()),
            window_id: Mutex::new(None),
            pane_id: Mutex::new(None),
            side: Mutex::new(None),
            tab_id: Mutex::new(None),
            generation: 0,
            workspace_root: PathBuf::from("/"),
            spawn_opts: CreateOptions {
                size: test_size(),
                tab_name: None,
                tab_group: None,
                window_id: None,
                mcp_env: true,
                cwd: None,
                command: command.map(str::to_string),
                env: env
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
            },
            child_pid: None,
            #[cfg(target_os = "linux")]
            master_fd: None,
            command_tx,
            output_tx,
            ring: Mutex::new(RingBuffer::new(ring_bytes)),
            seq: AtomicU64::new(0),
            last_activity: AtomicI64::new(now_unix_secs() as i64),
            last_output_at: AtomicI64::new(now_unix_millis()),
            write_queue,
            last_deliver_at,
            awaiting_gen,
            attach_count: AtomicUsize::new(0),
            detached_at: AtomicI64::new(now_unix_secs() as i64),
            winsize: Mutex::new(test_size()),
            focused: AtomicBool::new(false),
            bytes_since_focus: AtomicU64::new(0),
            in_alt_screen: AtomicBool::new(false),
            alt_screen_tail: Mutex::new(Vec::new()),
            private_modes: Mutex::new(BTreeSet::new()),
            private_mode_tail: Mutex::new(Vec::new()),
            broadcast: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            #[cfg(target_os = "linux")]
            fdstore_parked: Mutex::new(None),
            exit: Mutex::new(None),
        });
        (session, command_rx)
    }

    /// Register a fake session the way `create` would, so
    /// `enqueue_write_matching` sees it. The write-authority tests need
    /// sessions whose spawn command names an agent WITHOUT spawning that
    /// agent for real.
    fn register_session(registry: &Registry, session: &Arc<Session>) {
        registry
            .sessions
            .lock()
            .expect("terminal registry poisoned")
            .insert(session.id.clone(), Arc::clone(session));
    }

    /// Deliver a session's queue head now: mark its output quiet, then tick
    /// the drainer past the idle threshold.
    fn drain_now(session: &Arc<Session>) {
        let base = now_unix_millis();
        session.last_output_at.store(base, Ordering::Relaxed);
        session.try_drain_batch(base + WRITE_QUEUE_QUIET_MS + 10);
    }

    fn delivered_input(rx: &std::sync::mpsc::Receiver<PtyCommand>) -> Vec<u8> {
        match rx.try_recv().expect("a delivered PTY command") {
            PtyCommand::Input(data) => data,
            PtyCommand::InputSequence { .. } => {
                panic!("expected a single input write, got an input sequence")
            }
            _ => panic!("expected a single input write, got a non-input command"),
        }
    }

    #[test]
    fn agent_submit_delivers_one_newline_ahead_of_the_chord() {
        let registry = Registry::new(test_config(1024, 4, 10));
        let (codex, rx) =
            test_agent_session(1024, "s-codex", Some("@@Agent"), None, Some("codex"), &[]);
        register_session(&registry, &codex);

        let outcome = registry.enqueue_write_matching(
            Some("@@Agent"),
            None,
            "body\n\n",
            Some(SubmitAgent::Codex),
        );
        assert_eq!(outcome.queued, 1);

        drain_now(&codex);
        assert_eq!(delivered_input(&rx), b"\x1b[200~body\n\x1b[201~\r".to_vec());
    }

    #[test]
    fn shell_raw_write_delivers_the_logical_bytes_verbatim() {
        let registry = Registry::new(test_config(1024, 4, 10));
        let (shell, rx) =
            test_agent_session(1024, "s-shell", Some("@@Shell"), None, Some("bash"), &[]);
        register_session(&registry, &shell);

        let outcome = registry.enqueue_write_matching(Some("@@Shell"), None, "body\n\n", None);
        assert_eq!(outcome.queued, 1);

        drain_now(&shell);
        assert_eq!(delivered_input(&rx), b"body\n\n".to_vec());
    }

    // The sender-side chord authority: the agent named in `--submit` picks the
    // delivery bytes for every matched session. Each session's own derivation
    // from spawn command + CHAN_AGENT is still computed, but only to report a
    // disagreement, never to override the request.

    #[test]
    fn the_senders_chord_wins_over_the_targets_own_derivation() {
        let registry = Registry::new(test_config(1024, 4, 10));
        let (codex, rx) =
            test_agent_session(1024, "s-codex", Some("@@T"), None, Some("codex"), &[]);
        register_session(&registry, &codex);

        let outcome =
            registry.enqueue_write_matching(Some("@@T"), None, "poke\n", Some(SubmitAgent::Claude));
        assert_eq!(outcome.queued, 1);
        assert_eq!(outcome.position, Some(1));
        assert_eq!(
            outcome.diverged,
            vec![SubmitDivergence {
                tab: "@@T".into(),
                derived: Some(SubmitAgent::Codex),
            }],
            "the disagreement is reported, naming what the session derives"
        );

        drain_now(&codex);
        assert_eq!(
            delivered_input(&rx),
            b"poke\n\x1b[27;9;13~".to_vec(),
            "the sender's claude chord must win over the target's own codex"
        );
    }

    #[test]
    fn a_kimi_target_still_receives_the_chord_the_sender_named() {
        let registry = Registry::new(test_config(1024, 4, 10));
        let (kimi, rx) = test_agent_session(
            1024,
            "s-kimi",
            Some("@@Kimi"),
            None,
            Some("/home/fiorix/.kimi-code/bin/kimi"),
            &[],
        );
        register_session(&registry, &kimi);
        assert_eq!(
            registry.session_summaries()[0].agent.map(SubmitAgent::name),
            Some("kimi"),
            "terminal list summaries expose the derived Kimi identity"
        );

        let outcome = registry.enqueue_write_matching(
            Some("@@Kimi"),
            None,
            "poke\n",
            Some(SubmitAgent::Claude),
        );
        assert_eq!(outcome.queued, 1);
        assert_eq!(outcome.diverged.len(), 1);
        assert_eq!(
            outcome.diverged[0].derived.map(SubmitAgent::name),
            Some("kimi"),
            "the ack still tells the sender the target was spawned as kimi"
        );

        drain_now(&kimi);
        assert_eq!(delivered_input(&rx), b"poke\n\x1b[27;9;13~".to_vec());
    }

    // The motivating case for sender authority: a session spawned as a plain
    // shell whose operator then started an agent inside it derives nothing,
    // and nothing can correct that derivation while the session is live. The
    // sender's named chord is the only way to reach it.
    #[test]
    fn a_target_deriving_no_agent_still_gets_the_requested_chord() {
        let registry = Registry::new(test_config(1024, 4, 10));
        let (shell, rx) =
            test_agent_session(1024, "s-shell", Some("@@Sh"), None, Some("bash"), &[]);
        register_session(&registry, &shell);

        let outcome = registry.enqueue_write_matching(
            Some("@@Sh"),
            None,
            "poke\n",
            Some(SubmitAgent::Claude),
        );
        assert_eq!(outcome.queued, 1);
        assert_eq!(
            outcome.diverged,
            vec![SubmitDivergence {
                tab: "@@Sh".into(),
                derived: None,
            }],
            "deriving nothing is reported, so the override stays visible"
        );

        drain_now(&shell);
        assert_eq!(
            delivered_input(&rx),
            b"poke\n\x1b[27;9;13~".to_vec(),
            "the requested claude chord is encoded even with no derived agent"
        );
    }

    #[test]
    fn omitting_submit_still_delivers_raw_text_to_every_target() {
        let registry = Registry::new(test_config(1024, 4, 10));
        let (agent, rx) =
            test_agent_session(1024, "s-claude", Some("@@Raw"), None, Some("claude"), &[]);
        register_session(&registry, &agent);

        let outcome = registry.enqueue_write_matching(Some("@@Raw"), None, "draft: ", None);
        assert_eq!(outcome.queued, 1);
        assert!(
            outcome.diverged.is_empty(),
            "no submit request means nothing to disagree about"
        );

        drain_now(&agent);
        assert_eq!(
            delivered_input(&rx),
            b"draft: ".to_vec(),
            "without --submit the bytes stay raw and park in the compose box"
        );
    }

    #[test]
    fn a_mixed_agent_group_broadcast_encodes_one_chord_for_everyone() {
        let registry = Registry::new(test_config(1024, 8, 10));
        let (claude, rx_claude) = test_agent_session(
            1024,
            "s-claude",
            Some("@@A"),
            Some("alpha"),
            Some("claude"),
            &[],
        );
        let (codex, rx_codex) = test_agent_session(
            1024,
            "s-codex",
            Some("@@B"),
            Some("alpha"),
            Some("codex"),
            &[],
        );
        let (shell, rx_shell) = test_agent_session(
            1024,
            "s-shell",
            Some("@@C"),
            Some("alpha"),
            Some("bash"),
            &[],
        );
        for session in [&claude, &codex, &shell] {
            register_session(&registry, session);
        }

        let outcome =
            registry.enqueue_write_matching(None, Some("alpha"), "poke", Some(SubmitAgent::Claude));
        assert_eq!(outcome.queued, 3);
        assert_eq!(outcome.position, None, "a broadcast reports no position");
        let mut diverged = outcome.diverged;
        diverged.sort_by(|a, b| a.tab.cmp(&b.tab));
        assert_eq!(
            diverged,
            vec![
                SubmitDivergence {
                    tab: "@@B".into(),
                    derived: Some(SubmitAgent::Codex),
                },
                SubmitDivergence {
                    tab: "@@C".into(),
                    derived: None,
                },
            ],
            "both mismatched members are named so the cost of one chord is visible"
        );

        for session in [&claude, &codex, &shell] {
            drain_now(session);
        }
        let delivered = [
            delivered_input(&rx_claude),
            delivered_input(&rx_codex),
            delivered_input(&rx_shell),
        ];
        let claude_bytes = b"poke\n\x1b[27;9;13~".to_vec();
        assert_eq!(delivered[0], claude_bytes);
        assert_eq!(delivered[1], claude_bytes);
        assert_eq!(delivered[2], claude_bytes);
        assert!(
            delivered[0] == delivered[1] && delivered[1] == delivered[2],
            "one chord per command: a mixed group is targeted per session instead"
        );
    }

    #[test]
    fn chan_agent_spawn_env_wins_over_the_spawn_command() {
        let registry = Registry::new(test_config(1024, 8, 10));
        // bash + CHAN_AGENT=codex: the env override names the agent.
        let (env_codex, rx_codex) = test_agent_session(
            1024,
            "s-env-codex",
            Some("@@E1"),
            None,
            Some("bash"),
            &[("CHAN_AGENT", "codex")],
        );
        // codex + CHAN_AGENT=claude: the env override beats the command sniff.
        let (env_claude, rx_claude) = test_agent_session(
            1024,
            "s-env-claude",
            Some("@@E2"),
            None,
            Some("codex"),
            &[("CHAN_AGENT", "claude")],
        );
        register_session(&registry, &env_codex);
        register_session(&registry, &env_claude);

        let outcome =
            registry.enqueue_write_matching(Some("@@E1"), None, "poke", Some(SubmitAgent::Codex));
        assert_eq!(outcome.queued, 1);
        assert!(outcome.diverged.is_empty(), "requested matches derived");
        let outcome =
            registry.enqueue_write_matching(Some("@@E2"), None, "poke", Some(SubmitAgent::Claude));
        assert_eq!(outcome.queued, 1);
        assert!(outcome.diverged.is_empty(), "requested matches derived");

        drain_now(&env_codex);
        drain_now(&env_claude);
        assert_eq!(
            delivered_input(&rx_codex),
            b"\x1b[200~poke\n\x1b[201~\r".to_vec()
        );
        assert_eq!(delivered_input(&rx_claude), b"poke\n\x1b[27;9;13~".to_vec());
    }

    /// Collect a session's output until `needle` appears or `timeout` elapses.
    ///
    /// Reads BOTH halves of the attach contract. [`Session::attach`] subscribes
    /// `rx` and snapshots whatever the ring already holds into `replay`, so
    /// output produced before the subscribe exists only in `replay`. A session
    /// created with a one-shot `command` can run to completion before
    /// `Registry::create` reaches its `attach`, which puts the whole of that
    /// command's output on the replay side; draining `rx` alone then reads back
    /// empty rather than wrong. The serving path honours both halves the same
    /// way (`chan-server`'s terminal attach replays before streaming).
    async fn collect_until(session: &mut AttachHandle, needle: &str, timeout: Duration) -> String {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut out = String::new();
        for chunk in session.replay.drain(..) {
            out.push_str(&String::from_utf8_lossy(&chunk));
        }
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

    /// Pins the half of the attach contract that is easy to drop: output the
    /// ring already holds reaches a fresh attach through `replay`, never
    /// through `rx`.
    ///
    /// Ordering is deterministic rather than raced. The first handle drives its
    /// output with `send_input`, which necessarily follows its own attach, so
    /// the bytes are provably in the ring before the second handle subscribes.
    /// The second collect can therefore only succeed by reading `replay`, which
    /// is exactly what a create whose one-shot command outran its attach
    /// depends on.
    #[tokio::test]
    async fn a_fresh_attach_reads_output_the_ring_already_holds() {
        let registry = Arc::new(Registry::new(test_config(4096, 4, 60)));
        let mut first = registry
            .create(CreateOptions {
                size: test_size(),
                tab_name: None,
                tab_group: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                command: None,
                env: Default::default(),
            })
            .unwrap();
        let id = first.id().to_string();

        first.send_input(b"printf 'RINGED=<%s>\\n' ok\n");
        let live = collect_until(&mut first, "RINGED=<ok>", Duration::from_secs(5)).await;
        assert!(
            live.contains("RINGED=<ok>"),
            "the shell never produced the marker: {live:?}"
        );

        let mut second = registry.attach(&id, Some(0)).unwrap();
        let replayed = collect_until(&mut second, "RINGED=<ok>", Duration::from_secs(2)).await;
        assert!(
            replayed.contains("RINGED=<ok>"),
            "a fresh attach dropped the replay half of the contract: {replayed:?}"
        );

        registry.close(&id, CloseReason::Explicit);
    }

    // LC_ALL is the highest-precedence locale category, so when it is present
    // in the requested map the helper never consults the (test-host-dependent)
    // process environment; these cases stay deterministic.
    #[test]
    fn locale_selects_utf8_honors_lc_all_codeset() {
        let utf8 = |v: &str| {
            let mut env = BTreeMap::new();
            env.insert("LC_ALL".to_string(), v.to_string());
            locale_selects_utf8(&env)
        };
        assert!(utf8("en_US.UTF-8"));
        assert!(utf8("C.UTF-8"));
        assert!(utf8("en_GB.utf8"));
        assert!(!utf8("C"));
        assert!(!utf8("POSIX"));
        assert!(!utf8("en_US.ISO8859-1"));
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
    fn restored_ring_replays_preserved_history_without_false_missed_bytes() {
        let ring = RingBuffer::new_with_replay(1024, 6, b"abcdef");

        let (replay, missed) = ring.snapshot_since(Some(0));

        assert_eq!(missed, 0);
        assert_eq!(replay.concat(), b"abcdef");
        assert_eq!(ring.end_seq(), 6);
    }

    #[test]
    fn restored_ring_keeps_sequence_coordinates_when_replay_is_truncated() {
        let ring = RingBuffer::new_with_replay(4, 10, b"abcdef");

        let (replay, missed) = ring.snapshot_since(Some(0));

        assert_eq!(missed, 6);
        assert_eq!(replay.concat(), b"cdef");
        assert_eq!(ring.end_seq(), 10);
    }

    #[test]
    fn restored_ring_without_replay_reports_pre_import_bytes_as_missed() {
        let ring = RingBuffer::new_with_replay(1024, 552, b"");

        let (replay, missed) = ring.snapshot_since(Some(0));

        assert_eq!(missed, 552);
        assert!(replay.is_empty());
        assert_eq!(ring.end_seq(), 552);
    }

    #[test]
    fn scrollback_flattens_the_whole_ring() {
        let session = test_session_with_ring(1024);
        session.record_output(b"hello\n");
        session.record_output(b"world\n");
        // The full ring, in order, raw bytes and all.
        assert_eq!(session.scrollback(), b"hello\nworld\n");
    }

    #[test]
    fn scrollback_matching_selects_exactly_the_named_tab() {
        let registry = Registry::new(test_config(4096, 4, 60));
        let handle = registry
            .create(CreateOptions {
                size: test_size(),
                tab_name: Some("@@Alice".into()),
                tab_group: None,
                window_id: None,
                mcp_env: true,
                cwd: None,
                command: None,
                env: Default::default(),
            })
            .unwrap();
        // One session owns the tab name; a different name matches none. The
        // count is what the control socket's single-match policy gates on.
        assert_eq!(registry.scrollback_matching("@@Alice").len(), 1);
        assert!(registry.scrollback_matching("@@Nope").is_empty());
        registry.close(handle.id(), CloseReason::Explicit);
    }

    #[test]
    fn write_queue_enqueue_bounds_at_cap() {
        let session = test_session_with_ring(1024);
        for i in 1..=WRITE_QUEUE_CAP {
            assert_eq!(
                session.enqueue_cs_write("x".into(), None),
                Some(i),
                "position grows"
            );
        }
        assert_eq!(
            session.enqueue_cs_write("x".into(), None),
            None,
            "rejected at cap"
        );
    }

    #[test]
    fn notification_batch_format_preserves_order_utf8_newlines_and_empty_messages() {
        let submit = built_in_submit(SubmitAgent::Codex);
        let messages = [
            queued_message(
                "first\ninside\n\n",
                Some(submit.clone()),
                QueueSource::CsWrite,
            ),
            queued_message("snowman ☃", Some(submit.clone()), QueueSource::CsWrite),
            queued_message("", Some(submit), QueueSource::CsWrite),
        ];
        let refs: Vec<&QueuedMessage> = messages.iter().collect();

        assert_eq!(
            format_notification_batch(&refs),
            "# Queued terminal notifications\n\n3 messages, oldest first. Read the entire batch before acting. Later\nmessages may update or supersede earlier messages.\n\n--- notification 1/3 ---\nfirst\ninside\n--- end notification 1/3 ---\n\n--- notification 2/3 ---\nsnowman ☃\n--- end notification 2/3 ---\n\n--- notification 3/3 ---\n\n--- end notification 3/3 ---\n"
        );
    }

    #[test]
    fn batch_prefix_stops_at_every_semantic_boundary_without_skipping() {
        let codex = built_in_submit(SubmitAgent::Codex);
        let head = || queued_message("head", Some(codex.clone()), QueueSource::CsWrite);
        let mut cases = vec![
            (
                queued_message("rich", Some(codex.clone()), QueueSource::RichPrompt),
                BatchStopReason::RichPrompt,
            ),
            (
                queued_message("raw", None, QueueSource::CsWrite),
                BatchStopReason::NoSubmit,
            ),
            (
                queued_message(
                    "gemini",
                    Some(built_in_submit(SubmitAgent::Gemini)),
                    QueueSource::CsWrite,
                ),
                BatchStopReason::UnbatchableAgent,
            ),
            (
                queued_message(
                    "opencode",
                    Some(built_in_submit(SubmitAgent::OpenCode)),
                    QueueSource::CsWrite,
                ),
                BatchStopReason::DifferentSubmit,
            ),
            (
                queued_message(
                    "claude",
                    Some(built_in_submit(SubmitAgent::Claude)),
                    QueueSource::CsWrite,
                ),
                BatchStopReason::DifferentSubmit,
            ),
        ];
        let gemini = built_in_submit(SubmitAgent::Gemini);
        for part in [MessagePart::Body, MessagePart::Chord] {
            cases.push((
                QueuedMessage {
                    data: "gemini".to_string(),
                    submit: Some(gemini.clone()),
                    source: QueueSource::CsWrite,
                    prompt_id: None,
                    part,
                },
                BatchStopReason::SplitWrite,
            ));
        }
        let mut override_submit = codex.clone();
        override_submit.source = SubmitTemplateSource::Override;
        cases.push((
            queued_message("override", Some(override_submit), QueueSource::CsWrite),
            BatchStopReason::Override,
        ));
        let mut different_template = codex.clone();
        different_template.template.push('x');
        cases.push((
            queued_message(
                "different template",
                Some(different_template),
                QueueSource::CsWrite,
            ),
            BatchStopReason::DifferentSubmit,
        ));

        for (boundary, expected) in cases {
            let queue = VecDeque::from([head(), boundary, head()]);
            assert_eq!(
                select_batch_prefix(&queue, WRITE_QUEUE_BATCH_MAX_BYTES),
                BatchSelection {
                    count: 1,
                    stop: expected,
                }
            );
        }
    }

    #[test]
    fn batch_prefix_honors_framed_byte_ceiling_and_oversized_head_progresses() {
        let submit = built_in_submit(SubmitAgent::Codex);
        let first = queued_message("first", Some(submit.clone()), QueueSource::CsWrite);
        let second = queued_message("second", Some(submit.clone()), QueueSource::CsWrite);
        let refs = [&first, &second];
        let two_bytes = format_notification_batch(&refs).len();
        let queue = VecDeque::from([first, second]);
        assert_eq!(
            select_batch_prefix(&queue, two_bytes - 1),
            BatchSelection {
                count: 1,
                stop: BatchStopReason::ByteCeiling,
            }
        );

        let oversized = VecDeque::from([queued_message(
            &"x".repeat(1024),
            Some(submit),
            QueueSource::CsWrite,
        )]);
        assert_eq!(select_batch_prefix(&oversized, 1).count, 1);
    }

    #[test]
    fn five_codex_notifications_drain_as_one_framed_input_and_one_depth_event() {
        let (session, command_rx) = test_session_with_commands(1024);
        let submit = built_in_submit(SubmitAgent::Codex);
        for index in 1..=5 {
            session.enqueue_cs_write(format!("message {index}"), Some(submit.clone()));
        }
        let mut events = session.output_tx.subscribe();
        let base = now_unix_millis();
        session.last_output_at.store(base, Ordering::Relaxed);

        session.try_drain_batch(base);
        assert_eq!(session.queue_depth(), 5, "busy output holds the batch");
        assert!(command_rx.try_recv().is_err(), "busy output writes nothing");

        session.try_drain_batch(base + WRITE_QUEUE_QUIET_MS + 10);

        let PtyCommand::Input(data) = command_rx.try_recv().expect("one controller command") else {
            panic!("codex batch must be one input command");
        };
        let text = String::from_utf8(data).unwrap();
        assert!(text.starts_with("\x1b[200~# Queued terminal notifications\n"));
        for index in 1..=5 {
            assert!(text.contains(&format!("message {index}")));
        }
        assert!(text.ends_with("\n\x1b[201~\r"));
        assert!(command_rx.try_recv().is_err(), "one controller command");
        assert_eq!(session.queue_depth(), 0);
        assert!(session.awaiting_gen.load(Ordering::Relaxed));
        assert!(matches!(events.try_recv(), Ok(SessionEvent::QueueDepth(0))));
        assert!(events.try_recv().is_err(), "no intermediate badge churn");
    }

    #[test]
    fn five_opencode_notifications_drain_as_one_framed_input_and_one_depth_event() {
        let (session, command_rx) = test_session_with_commands(1024);
        let submit = built_in_submit(SubmitAgent::OpenCode);
        for index in 1..=5 {
            session.enqueue_cs_write(format!("message {index}"), Some(submit.clone()));
        }
        let mut events = session.output_tx.subscribe();
        let base = now_unix_millis();
        session.last_output_at.store(base, Ordering::Relaxed);

        session.try_drain_batch(base + WRITE_QUEUE_QUIET_MS + 10);

        let PtyCommand::Input(data) = command_rx.try_recv().expect("one controller command") else {
            panic!("opencode batch must be one input command");
        };
        let text = String::from_utf8(data).unwrap();
        assert!(text.starts_with("\x1b[200~# Queued terminal notifications\n"));
        for index in 1..=5 {
            assert!(text.contains(&format!("message {index}")));
        }
        assert!(text.ends_with("\n\x1b[201~\r"));
        assert!(command_rx.try_recv().is_err(), "one controller command");
        assert_eq!(session.queue_depth(), 0);
        assert!(session.awaiting_gen.load(Ordering::Relaxed));
        assert!(matches!(events.try_recv(), Ok(SessionEvent::QueueDepth(0))));
        assert!(events.try_recv().is_err(), "no intermediate badge churn");
    }

    #[test]
    fn five_claude_notifications_drain_as_one_two_part_sequence() {
        let (session, command_rx) = test_session_with_commands(1024);
        let submit = built_in_submit(SubmitAgent::Claude);
        for index in 1..=5 {
            session.enqueue_cs_write(format!("message {index}"), Some(submit.clone()));
        }
        let base = now_unix_millis();
        session.last_output_at.store(base, Ordering::Relaxed);

        session.try_drain_batch(base + WRITE_QUEUE_QUIET_MS + 10);

        let PtyCommand::InputSequence { parts, gap } =
            command_rx.try_recv().expect("one controller sequence")
        else {
            panic!("claude batch must be an input sequence");
        };
        assert_eq!(parts.len(), 2);
        assert!(String::from_utf8_lossy(&parts[0]).contains("message 5"));
        assert!(parts[0].ends_with(b"\n"));
        assert_eq!(parts[1], b"\x1b[27;9;13~");
        assert_eq!(gap, WRITE_QUEUE_INPUT_GAP);
    }

    #[test]
    fn submitted_singleton_keeps_exact_bytes_without_batch_envelope() {
        let (session, command_rx) = test_session_with_commands(1024);
        session.enqueue_cs_write(
            "singleton\n".into(),
            Some(built_in_submit(SubmitAgent::Codex)),
        );
        let base = now_unix_millis();
        session.last_output_at.store(base, Ordering::Relaxed);

        session.try_drain_batch(base + WRITE_QUEUE_QUIET_MS + 10);

        let PtyCommand::Input(data) = command_rx.try_recv().expect("singleton input") else {
            panic!("codex singleton must be one input");
        };
        assert_eq!(data, b"\x1b[200~singleton\n\x1b[201~\r");
    }

    #[test]
    fn enqueue_after_atomic_batch_selection_stays_for_the_next_turn() {
        let session = test_session_with_ring(1024);
        let submit = built_in_submit(SubmitAgent::Codex);
        for index in 1..=5 {
            session.enqueue_cs_write(format!("message {index}"), Some(submit.clone()));
        }
        let selected = {
            let mut queue = session.write_queue.lock().expect("queue");
            pop_batch(&mut queue, WRITE_QUEUE_BATCH_MAX_BYTES).0
        };
        session.enqueue_cs_write("late sixth".into(), Some(submit));

        assert_eq!(selected.len(), 5);
        assert_eq!(session.queue_depth(), 1);
        assert_eq!(
            session
                .write_queue
                .lock()
                .expect("queue")
                .front()
                .map(|message| message.data.as_str()),
            Some("late sixth")
        );
    }

    #[test]
    fn write_queue_drains_only_when_idle_and_awaits_generation() {
        let session = test_session_with_ring(1024);
        session.enqueue_cs_write("one".into(), None);
        session.enqueue_cs_write("two".into(), None);
        let qlen = |s: &Session| s.write_queue.lock().expect("queue").len();
        let base = now_unix_millis();

        // Agent busy (output just now): nothing delivered.
        session.last_output_at.store(base, Ordering::Relaxed);
        session.try_drain_batch(base);
        assert_eq!(qlen(&session), 2, "busy -> hold");

        // Agent idle (output quiet > QUIET_MS): deliver one, then await the
        // next generation-start.
        let idle_now = base + WRITE_QUEUE_QUIET_MS + 10;
        session.try_drain_batch(idle_now);
        assert_eq!(qlen(&session), 1, "idle -> delivered one");
        assert!(session.awaiting_gen.load(Ordering::Relaxed), "awaiting gen");

        // Still awaiting generation-start (no new output, under the cap): hold.
        session.try_drain_batch(idle_now + 10);
        assert_eq!(qlen(&session), 1, "awaiting gen -> hold the second");

        // Generation started (output advanced past the deliver) then finished
        // (idle again): the second delivers.
        let gen_at = idle_now + 20;
        session.last_output_at.store(gen_at, Ordering::Relaxed);
        session.try_drain_batch(gen_at + WRITE_QUEUE_QUIET_MS + 10);
        assert_eq!(qlen(&session), 0, "turn done -> second delivered");
    }

    #[test]
    fn write_queue_gen_start_cap_unwedges_a_non_generating_message() {
        // A delivered message that never triggers generation (no output
        // advance) must not wedge the queue forever: after the gen-start cap,
        // the next message delivers.
        let session = test_session_with_ring(1024);
        session.enqueue_cs_write("one".into(), None);
        session.enqueue_cs_write("two".into(), None);
        let base = now_unix_millis();
        // last output well in the past -> always "idle".
        session.last_output_at.store(base, Ordering::Relaxed);
        let t1 = base + WRITE_QUEUE_QUIET_MS + 10;
        session.try_drain_batch(t1);
        assert!(session.awaiting_gen.load(Ordering::Relaxed));
        // No output ever arrives; past the cap the await clears + the second
        // delivers (idle the whole time).
        session.try_drain_batch(t1 + WRITE_QUEUE_GEN_START_CAP_MS + 10);
        assert_eq!(session.write_queue.lock().expect("queue").len(), 0);
    }

    #[test]
    fn enqueue_prompt_is_all_or_nothing_at_cap() {
        // A 2-write message (gemini) near the cap must not split: the old
        // per-write path enqueued the body at 99/100 and silently dropped
        // the CR. The whole message is rejected, the queue untouched.
        let session = test_session_with_ring(1024);
        for _ in 1..WRITE_QUEUE_CAP {
            session.enqueue_cs_write("x".into(), None);
        }
        assert_eq!(
            session.enqueue_prompt(
                "hi there".into(),
                Some(built_in_submit(SubmitAgent::Gemini)),
                Some("msg-1".into())
            ),
            None,
            "2-write message must not split into the last slot"
        );
        assert_eq!(
            session.write_queue.lock().expect("queue").len(),
            WRITE_QUEUE_CAP - 1,
            "rejected message leaves the queue unchanged"
        );
        // A single-write message still fits the remaining slot.
        assert_eq!(
            session.enqueue_prompt(
                "poke".into(),
                Some(built_in_submit(SubmitAgent::Claude)),
                Some("msg-2".into())
            ),
            Some(WRITE_QUEUE_CAP),
            "1-write message fits; return is the message depth"
        );
    }

    #[test]
    fn write_queue_refuses_over_4096_bytes_on_raw_and_prompt_paths() {
        let session = test_session_with_ring(1024);
        let oversized = "x".repeat(MAX_TERMINAL_WRITE_BYTES + 1);

        assert_eq!(
            session.enqueue_cs_write(oversized.clone(), None),
            None,
            "raw cs write is refused"
        );
        assert_eq!(
            session.enqueue_prompt(
                oversized,
                Some(built_in_submit(SubmitAgent::Codex)),
                Some("too-large".into())
            ),
            None,
            "Rich Prompt submit is refused"
        );
        assert!(
            session.write_queue.lock().expect("queue").is_empty(),
            "a refusal leaves the queue untouched"
        );

        assert_eq!(
            session.enqueue_cs_write("x".repeat(MAX_TERMINAL_WRITE_BYTES), None),
            Some(1),
            "the exact byte limit is accepted"
        );
    }

    #[test]
    fn queue_depth_counts_messages_not_writes() {
        let session = test_session_with_ring(1024);
        assert_eq!(
            session.enqueue_prompt(
                "hi there".into(),
                Some(built_in_submit(SubmitAgent::Gemini)),
                Some("gem-1".into())
            ),
            Some(1),
            "first message -> depth/position 1"
        );
        assert_eq!(
            session.write_queue.lock().expect("queue").len(),
            2,
            "a gemini message occupies two idle-gated entries"
        );
        assert_eq!(session.queue_depth(), 1, "but ONE message");
        // A CLI poke behind it reports position 2: the number the SPA badge
        // shows, not the raw entry count (3).
        assert_eq!(session.enqueue_cs_write("poke".into(), None), Some(2));
        assert_eq!(session.write_queue.lock().expect("queue").len(), 3);
        assert_eq!(session.queue_depth(), 2);
    }

    #[test]
    fn a_gemini_cs_write_is_one_position_even_though_it_takes_two_entries() {
        // The position `cs terminal write` prints counts MESSAGES: a lone
        // gemini poke on an empty queue is at position 1, not at the position
        // its bare-CR entry would give it.
        let session = test_session_with_ring(1024);
        assert_eq!(
            session.enqueue_cs_write("poke".into(), Some(built_in_submit(SubmitAgent::Gemini))),
            Some(1),
            "one message ahead of nothing is at position 1"
        );
        assert_eq!(
            session.write_queue.lock().expect("queue").len(),
            2,
            "body + bare CR"
        );
        assert_eq!(
            session.enqueue_cs_write("next".into(), Some(built_in_submit(SubmitAgent::Gemini))),
            Some(2),
            "the second message is at position 2, not 3"
        );
    }

    #[test]
    fn cancel_prompt_removes_logical_message_atomically_and_reemits_depth() {
        let session = test_session_with_ring(1024);
        // m1 has one write-cost unit; m2 is a Gemini logical message with two;
        // a CLI poke (no id) follows them.
        session.enqueue_prompt("first".into(), None, Some("m1".into()));
        session.enqueue_prompt(
            "second".into(),
            Some(built_in_submit(SubmitAgent::Gemini)),
            Some("m2".into()),
        );
        session.enqueue_cs_write("poke".into(), None);
        assert_eq!(session.queue_depth(), 3, "two prompts + one poke");

        let mut rx = session.output_tx.subscribe();
        // Cancel the Gemini logical message and both of its write-cost units.
        assert!(session.cancel_prompt("m2"), "m2 was still queued");
        match rx.try_recv() {
            Ok(SessionEvent::QueueDepth(depth)) => assert_eq!(depth, 2, "depth re-emitted"),
            other => panic!("expected QueueDepth, got {other:?}"),
        }
        assert_eq!(session.queue_depth(), 2);
        // m2 is gone; m1 + the poke remain, ordering preserved.
        let q = session.write_queue.lock().expect("queue");
        assert_eq!(q.len(), 2, "m1 + poke remain, Gemini's two entries gone");
        assert_eq!(q[0].prompt_id.as_deref(), Some("m1"));
        assert_eq!(q[1].prompt_id, None, "the CLI poke stays, in order");
    }

    #[test]
    fn cancel_cannot_recall_a_message_already_popped_for_delivery() {
        // The drainer pops before it hands bytes to the controller, so a recall
        // that arrives after the pop is honestly refused: delivery has begun.
        let session = test_session_with_ring(1024);
        session.enqueue_prompt(
            "first".into(),
            Some(built_in_submit(SubmitAgent::Claude)),
            Some("m1".into()),
        );
        session.enqueue_prompt(
            "second".into(),
            Some(built_in_submit(SubmitAgent::Claude)),
            Some("m2".into()),
        );
        let base = now_unix_millis();
        session.last_output_at.store(base, Ordering::Relaxed);
        session.try_drain_batch(base + WRITE_QUEUE_QUIET_MS + 10);
        assert_eq!(session.queued_prompt_ids(), vec!["m2".to_string()]);

        let mut rx = session.output_tx.subscribe();
        assert!(
            !session.cancel_prompt("m1"),
            "m1 was popped for delivery, so it cannot be recalled"
        );
        assert!(
            matches!(rx.try_recv(), Err(broadcast::error::TryRecvError::Empty)),
            "a refused recall must not perturb the badge"
        );
        assert_eq!(session.queue_depth(), 1, "m2 is untouched");
        assert!(
            session.cancel_prompt("m2"),
            "the queued message still recalls"
        );
    }

    #[test]
    fn fresh_queue_state_is_empty_with_no_delivery_and_no_pending_generation() {
        // This checks the helper and a fresh session only. The fresh and
        // fdstore-restored PTY constructors both destructure `fresh_queue_state`
        // for these three fields, so a restored session cannot come up
        // awaiting a generation its previous process already finished, but
        // that guarantee is structural: no restored session is built here.
        let (queue, last_deliver_at, awaiting_gen) = fresh_queue_state();
        assert!(queue.lock().expect("queue").is_empty());
        assert_eq!(last_deliver_at.load(Ordering::Relaxed), 0);
        assert!(!awaiting_gen.load(Ordering::Relaxed));

        let session = test_session_with_ring(1024);
        assert_eq!(session.queue_depth(), 0);
        assert!(session.queued_prompt_ids().is_empty());
        assert_eq!(session.last_deliver_at.load(Ordering::Relaxed), 0);
        assert!(!session.awaiting_gen.load(Ordering::Relaxed));
    }

    #[test]
    fn input_gap_override_rejects_values_at_or_above_the_idle_threshold() {
        // The split gap must stay inside one idle window: at or above it the
        // drainer would read the pause as a finished turn.
        assert_eq!(parse_input_gap("200"), Some(Duration::from_millis(200)));
        assert_eq!(parse_input_gap(" 50 "), Some(Duration::from_millis(50)));
        assert_eq!(parse_input_gap("0"), None);
        assert_eq!(parse_input_gap(&WRITE_QUEUE_QUIET_MS.to_string()), None);
        assert_eq!(parse_input_gap("400ms"), None);
        assert_eq!(parse_input_gap(""), None);
    }

    #[test]
    fn batch_framing_overhead_matches_the_formatter() {
        // Prefix selection sizes a candidate batch from a running content total
        // plus this overhead instead of re-framing the payload under the queue
        // lock, so the two must agree exactly, including delimiter digit width.
        let submit = built_in_submit(SubmitAgent::Codex);
        for count in [1usize, 2, 5, 9, 10, 11, 99, 100] {
            let messages: Vec<QueuedMessage> = (0..count)
                .map(|index| {
                    queued_message(
                        &format!("body {index}\n"),
                        Some(submit.clone()),
                        QueueSource::CsWrite,
                    )
                })
                .collect();
            let refs: Vec<&QueuedMessage> = messages.iter().collect();
            let content: usize = refs.iter().copied().map(framed_content_len).sum();
            assert_eq!(
                format_notification_batch(&refs).len(),
                batch_framing_overhead(count) + content,
                "count {count}"
            );
        }
    }

    #[test]
    fn cancel_prompt_on_an_absent_id_reports_not_removed_and_is_silent() {
        let session = test_session_with_ring(1024);
        session.enqueue_prompt("x".into(), None, Some("m1".into()));
        let mut rx = session.output_tx.subscribe();
        // The id already drained (or never existed): nothing to remove, and a
        // no-op cancel must not perturb depth (the cancel-vs-drain race: the
        // caller acks removed=false so the UI does not recall a drained msg).
        assert!(!session.cancel_prompt("gone"));
        assert!(
            matches!(rx.try_recv(), Err(broadcast::error::TryRecvError::Empty)),
            "a no-op cancel must not re-emit depth"
        );
        assert_eq!(session.queue_depth(), 1, "m1 untouched");
    }

    #[test]
    fn queued_prompt_ids_lists_rich_messages_in_fifo_order_skipping_pokes() {
        let session = test_session_with_ring(1024);
        session.enqueue_prompt("a".into(), None, Some("m1".into()));
        session.enqueue_cs_write("poke".into(), None); // no prompt_id -> not listed
        session.enqueue_prompt(
            "b".into(),
            Some(built_in_submit(SubmitAgent::Gemini)),
            Some("m2".into()),
        );
        assert_eq!(
            session.queued_prompt_ids(),
            vec!["m1".to_string(), "m2".to_string()],
            "one id per rich message, FIFO, CLI poke skipped"
        );
        // Membership tracks cancellation: after recalling m1, only m2 remains.
        assert!(session.cancel_prompt("m1"));
        assert_eq!(session.queued_prompt_ids(), vec!["m2".to_string()]);
    }

    #[test]
    fn logical_prompt_drain_emits_delivered_before_depth() {
        let session = test_session_with_ring(1024);
        session.enqueue_prompt(
            "hi there".into(),
            Some(built_in_submit(SubmitAgent::Claude)),
            Some("msg-1".into()),
        );
        // Subscribe AFTER the enqueue so its QueueDepth stays out of frame.
        let mut rx = session.output_tx.subscribe();
        let base = now_unix_millis();
        session.last_output_at.store(base, Ordering::Relaxed);

        let t1 = base + WRITE_QUEUE_QUIET_MS + 10;
        session.try_drain_batch(t1);
        assert_eq!(session.queue_depth(), 0);
        match rx.try_recv() {
            Ok(SessionEvent::PromptDelivered { id, depth }) => {
                assert_eq!(id, "msg-1");
                assert_eq!(depth, 0);
            }
            other => panic!("expected PromptDelivered first, got {other:?}"),
        }
        match rx.try_recv() {
            Ok(SessionEvent::QueueDepth(depth)) => assert_eq!(depth, 0),
            other => panic!("expected QueueDepth after PromptDelivered, got {other:?}"),
        }
    }

    #[test]
    fn gemini_drains_as_two_separately_gated_entries() {
        // No tested fixed gap below the idle threshold preserved a 64 KiB
        // Gemini batch, so body and CR stay two queue entries separated by the
        // normal idle gate. Only the chord completes the logical message.
        let (session, commands) = test_session_with_commands(1024);
        session.enqueue_prompt(
            "hi there".into(),
            Some(built_in_submit(SubmitAgent::Gemini)),
            Some("msg-1".into()),
        );
        assert_eq!(session.queue_depth(), 1, "two entries, ONE message");
        assert_eq!(
            session.write_queue.lock().expect("queue").len(),
            2,
            "body and chord occupy separate entries"
        );

        let mut rx = session.output_tx.subscribe();
        let base = now_unix_millis();
        session.last_output_at.store(base, Ordering::Relaxed);

        // First idle opportunity: the body alone, no events (the message is
        // still pending) and no multi-part sequence.
        let t1 = base + WRITE_QUEUE_QUIET_MS + 10;
        session.try_drain_batch(t1);
        let PtyCommand::Input(data) = commands.try_recv().expect("the body write") else {
            panic!("a split body must be one input, not a sequence");
        };
        assert_eq!(data, b"hi there\n");
        assert!(
            matches!(rx.try_recv(), Err(broadcast::error::TryRecvError::Empty)),
            "a body drain completes no message"
        );
        assert_eq!(session.queue_depth(), 1, "the message is still pending");

        // The CR waits for the next idle opportunity, a full generation-start
        // wait and quiet window later, not a fixed inter-part gap.
        session.try_drain_batch(t1 + 10);
        assert!(
            matches!(
                commands.try_recv(),
                Err(std::sync::mpsc::TryRecvError::Empty)
            ),
            "the chord holds until the next idle opportunity"
        );
        let echo_at = t1 + 20;
        session.last_output_at.store(echo_at, Ordering::Relaxed);
        session.try_drain_batch(echo_at + WRITE_QUEUE_QUIET_MS + 10);
        let PtyCommand::Input(data) = commands.try_recv().expect("the chord write") else {
            panic!("a split chord must be one input, not a sequence");
        };
        assert_eq!(data, b"\r");
        assert_eq!(session.queue_depth(), 0);
        match rx.try_recv() {
            Ok(SessionEvent::PromptDelivered { id, depth }) => {
                assert_eq!(id, "msg-1");
                assert_eq!(depth, 0);
            }
            other => panic!("expected PromptDelivered on the chord drain, got {other:?}"),
        }
        match rx.try_recv() {
            Ok(SessionEvent::QueueDepth(depth)) => assert_eq!(depth, 0),
            other => panic!("expected QueueDepth after PromptDelivered, got {other:?}"),
        }
    }

    #[test]
    fn gemini_cs_writes_never_batch_and_keep_fifo_order() {
        // Two consecutive Gemini pokes are four entries drained one at a time:
        // the batcher must not fold a body, a chord, or a following poke into
        // one framed prompt.
        let (session, commands) = test_session_with_commands(1024);
        let gemini = built_in_submit(SubmitAgent::Gemini);
        session.enqueue_cs_write("first".into(), Some(gemini.clone()));
        session.enqueue_cs_write("second".into(), Some(gemini));
        assert_eq!(session.queue_depth(), 2);

        let mut now = now_unix_millis();
        let mut writes = Vec::new();
        for _ in 0..4 {
            // The agent echoes the previous entry, which clears the
            // generation-start wait, then goes quiet again.
            now += 1;
            session.last_output_at.store(now, Ordering::Relaxed);
            now += WRITE_QUEUE_QUIET_MS + 10;
            session.try_drain_batch(now);
            let PtyCommand::Input(data) = commands.try_recv().expect("one write per drain") else {
                panic!("gemini entries must never batch into a sequence");
            };
            writes.push(data);
        }
        assert_eq!(
            writes,
            vec![
                b"first\n".to_vec(),
                b"\r".to_vec(),
                b"second\n".to_vec(),
                b"\r".to_vec()
            ]
        );
        assert_eq!(session.queue_depth(), 0);
    }

    #[test]
    fn enqueue_broadcasts_queue_depth_on_both_paths() {
        let session = test_session_with_ring(1024);
        let mut rx = session.output_tx.subscribe();

        // CLI path: returns the raw position, broadcasts the message depth.
        assert_eq!(session.enqueue_cs_write("poke".into(), None), Some(1));
        match rx.try_recv() {
            Ok(SessionEvent::QueueDepth(depth)) => assert_eq!(depth, 1),
            other => panic!("expected QueueDepth, got {other:?}"),
        }

        // Prompt path: return == ack position == message depth.
        assert_eq!(
            session.enqueue_prompt(
                "hi".into(),
                Some(built_in_submit(SubmitAgent::Gemini)),
                Some("m".into())
            ),
            Some(2)
        );
        match rx.try_recv() {
            Ok(SessionEvent::QueueDepth(depth)) => assert_eq!(depth, 2),
            other => panic!("expected QueueDepth, got {other:?}"),
        }
    }

    #[test]
    fn enqueue_write_matching_reports_position_for_a_single_target() {
        let registry = Registry::new(test_config(4096, 4, 60));
        let handle = registry
            .create(CreateOptions {
                size: test_size(),
                tab_name: Some("@@A".into()),
                tab_group: None,
                window_id: None,
                mcp_env: true,
                cwd: None,
                command: None,
                env: Default::default(),
            })
            .unwrap();
        // No drainer runs in this test, so positions are stable.
        let first = registry.enqueue_write_matching(Some("@@A"), None, "x", None);
        assert_eq!(first.queued, 1);
        assert_eq!(first.position, Some(1));
        let second = registry.enqueue_write_matching(Some("@@A"), None, "y", None);
        assert_eq!(second.position, Some(2), "FIFO position grows");
        // No match -> nothing queued, no position.
        let none = registry.enqueue_write_matching(Some("@@Nope"), None, "z", None);
        assert_eq!(none.queued, 0);
        assert_eq!(none.position, None);
        registry.close(handle.id(), CloseReason::Explicit);
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

    fn modes_on(session: &Arc<Session>) -> Vec<u16> {
        session
            .private_modes
            .lock()
            .unwrap()
            .iter()
            .copied()
            .collect()
    }

    /// THE htop-after-reload regression. A live PTY running htop set DECCKM(1) +
    /// mouse(1000;1006) + alt-screen(1049) at startup; a fresh client reattaching
    /// in alt-screen replays no scrollback, so the prelude is the ONLY chance to
    /// restore those modes. Before the fix the prelude re-asserted ONLY alt-screen,
    /// so arrows (DECCKM) and wheel/clicks (mouse) died. The reattach must now
    /// re-assert the live INPUT modes -- and NOT alt-screen (handled separately).
    #[test]
    fn reattach_reasserts_htop_input_modes() {
        let session = test_session_with_ring(4096);
        // The exact private-mode set real htop 3.4.1 emits at startup (captured).
        session.record_output(b"\x1b[?1049h\x1b[?7h\x1b[?1h\x1b[?25l\x1b[?1006;1000h");
        assert_eq!(modes_on(&session), vec![1, 1000, 1006]);

        let attached = session.clone().attach(Some(0));
        // BTreeSet order → 1, 1000, 1006. Alt-screen (1049) is NOT here; autowrap
        // (7) and cursor-hide (25) are untracked screen state, also absent.
        assert_eq!(attached.mode_reassert, b"\x1b[?1h\x1b[?1000h\x1b[?1006h");
        assert!(attached.alt_screen, "alt-screen still tracked separately");
    }

    #[test]
    fn private_modes_track_set_and_reset() {
        let session = test_session_with_ring(1024);
        session.record_output(b"\x1b[?1h");
        assert_eq!(modes_on(&session), vec![1]);
        session.record_output(b"\x1b[?1000h");
        assert_eq!(modes_on(&session), vec![1, 1000]);
        // Reset DECCKM (rmkx): 1 leaves the set, 1000 stays.
        session.record_output(b"\x1b[?1l");
        assert_eq!(modes_on(&session), vec![1000]);
    }

    #[test]
    fn private_modes_parse_grouped_and_split_across_reads() {
        let session = test_session_with_ring(1024);
        // Grouped params in one CSI (htop's `\e[?1006;1000h`).
        session.record_output(b"\x1b[?1006;1000h");
        assert_eq!(modes_on(&session), vec![1000, 1006]);
        // A single CSI split across two reads must still resolve.
        session.record_output(b"\x1b[?2");
        assert_eq!(modes_on(&session), vec![1000, 1006]);
        session.record_output(b"004h");
        assert_eq!(modes_on(&session), vec![1000, 1006, 2004]);
    }

    #[tokio::test]
    async fn bracketed_paste_readiness_waits_for_a_complete_split_decset() {
        let session = test_session_with_ring(1024);
        let mut handle = session.clone().attach(Some(0));
        let completed = Arc::new(AtomicBool::new(false));
        let waiter_completed = completed.clone();

        let wait = async {
            let ready = handle.wait_for_bracketed_paste().await;
            waiter_completed.store(true, Ordering::Relaxed);
            ready
        };
        let emit = async {
            tokio::task::yield_now().await;
            session.record_output(b"\x1b[?2");
            tokio::task::yield_now().await;
            assert!(
                !completed.load(Ordering::Relaxed),
                "a partial DECSET must not signal readiness"
            );
            session.record_output(b"004h");
        };

        let (ready, ()) = tokio::join!(wait, emit);
        assert!(ready, "DECSET 2004 signals bracketed-paste readiness");
    }

    #[tokio::test]
    async fn bracketed_paste_readiness_stops_when_the_session_closes() {
        let session = test_session_with_ring(1024);
        let mut handle = session.clone().attach(Some(0));
        let wait = handle.wait_for_bracketed_paste();
        let close = async {
            tokio::task::yield_now().await;
            session.close(CloseReason::Explicit);
        };

        let (ready, ()) =
            tokio::time::timeout(Duration::from_secs(1), async { tokio::join!(wait, close) })
                .await
                .expect("closed readiness wait returns");
        assert!(!ready, "a closed PTY cannot become ready");
    }

    #[test]
    fn private_modes_ignore_untracked_and_queries() {
        let session = test_session_with_ring(1024);
        // Untracked screen modes (autowrap, cursor visibility) never enter the set.
        session.record_output(b"\x1b[?7h\x1b[?25l\x1b[?12l");
        assert!(modes_on(&session).is_empty());
        // A DECRQM query (`$p` final) must not toggle anything.
        session.record_output(b"\x1b[?1006;1000$p");
        assert!(modes_on(&session).is_empty());
        // Alt-screen is tracked separately, not in the re-assert set.
        session.record_output(b"\x1b[?1049h");
        assert!(modes_on(&session).is_empty());
        assert!(session.clone().attach(Some(0)).mode_reassert.is_empty());
    }

    #[test]
    fn plain_shell_has_empty_mode_reassert() {
        // A session that never set a tracked mode re-asserts nothing -- a plain
        // shell must not bloat the prelude.
        let session = test_session_with_ring(1024);
        session.record_output(b"$ echo hi\r\nhi\r\n");
        assert!(session.attach(Some(0)).mode_reassert.is_empty());
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
                tab_group: None,
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

    fn opts_with_window(window_id: &str) -> CreateOptions {
        CreateOptions {
            size: test_size(),
            tab_name: None,
            tab_group: None,
            window_id: Some(window_id.to_string()),
            mcp_env: true,
            cwd: None,
            command: None,
            env: Default::default(),
        }
    }

    fn opts_with_command(command: &str) -> CreateOptions {
        CreateOptions {
            size: test_size(),
            tab_name: None,
            tab_group: None,
            window_id: Some("win-exit".to_string()),
            mcp_env: false,
            cwd: None,
            command: Some(command.to_string()),
            env: Default::default(),
        }
    }

    async fn wait_for_last_exit(registry: &Registry) -> TerminalExit {
        for _ in 0..120 {
            if let Some(exit) = registry.last_exit() {
                return exit;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("terminal exit was not recorded");
    }

    #[tokio::test]
    async fn last_exit_zero_is_sticky_after_session_removal() {
        let registry = Registry::new(test_config(1024, 4, 10));
        let handle = registry.create(opts_with_command("exit 0")).unwrap();
        let id = handle.id().to_string();

        assert_eq!(
            wait_for_last_exit(&registry).await,
            TerminalExit::Code { code: 0 }
        );
        assert!(registry.remove(&id));
        assert_eq!(registry.last_exit(), Some(TerminalExit::Code { code: 0 }));
    }

    #[tokio::test]
    async fn last_exit_nonzero_is_sticky_after_session_removal() {
        let registry = Registry::new(test_config(1024, 4, 10));
        let handle = registry.create(opts_with_command("exit 7")).unwrap();
        let id = handle.id().to_string();

        assert_eq!(
            wait_for_last_exit(&registry).await,
            TerminalExit::Code { code: 7 }
        );
        assert!(registry.remove(&id));
        assert_eq!(registry.last_exit(), Some(TerminalExit::Code { code: 7 }));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_signal_exit_is_recorded_as_exit_state() {
        let registry = Registry::new(test_config(1024, 4, 10));
        let _handle = registry.create(opts_with_command("kill -TERM $$")).unwrap();

        match wait_for_last_exit(&registry).await {
            TerminalExit::Signal { signal } => assert!(!signal.is_empty()),
            other => panic!("expected a signal exit, got {other:?}"),
        }
    }

    #[test]
    fn wire_code_reports_no_code_for_an_unknown_exit() {
        // The `/ws` exit frame: a real code passes through, a signal death
        // keeps the generic failure code, and Unknown stays codeless (the
        // restored-session case where the true status is unobtainable).
        assert_eq!(TerminalExit::Code { code: 0 }.wire_code(), Some(0));
        assert_eq!(TerminalExit::Code { code: 7 }.wire_code(), Some(7));
        assert_eq!(
            TerminalExit::Signal {
                signal: "SIGTERM".into()
            }
            .wire_code(),
            Some(1)
        );
        assert_eq!(TerminalExit::Unknown.wire_code(), None);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn imported_session_slave_close_is_a_clean_exit_not_an_error() {
        // A devserver-restart-restored PTY reads its master through
        // `ImportedPtyFd`. When the restored shell exits, the kernel reports
        // EIO on the master (not EOF); that must surface as an Exit event
        // with no fabricated code, and never as a "terminal read failed"
        // Error broadcast.
        let pair = native_pty_system().openpty(test_size()).unwrap();
        let master_fd = pair
            .master
            .as_raw_fd()
            .and_then(|fd| clone_master_fd(fd).ok())
            .expect("dup master fd");
        let meta = FdStoreSessionMeta {
            tenant_prefix: "/w".to_string(),
            session_id: "restored-1".to_string(),
            tab_name: None,
            tab_group: None,
            spawn_name: None,
            spawn_group: None,
            window_id: Some("win-1".to_string()),
            pane_id: None,
            side: None,
            tab_id: None,
            cwd: None,
            command: None,
            env: BTreeMap::new(),
            mcp_env: false,
            child_pid: None,
            size: test_size().into(),
            seq: 0,
            generation: 1,
            alt_screen: false,
            private_modes: Vec::new(),
        };
        let registry_last_exit = Arc::new(Mutex::new(None));
        let session = Session::from_imported(
            test_config(1024, 4, 10),
            FdStoreSessionImport {
                meta,
                master_fd,
                replay: Vec::new(),
            },
            registry_last_exit.clone(),
        )
        .expect("import session");
        let mut rx = session.output_tx.subscribe();

        // The restored shell exits: the last slave fd closes, so the
        // reader's next master read fails EIO.
        drop(pair);

        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Ok(SessionEvent::Exit(exit))) => {
                    assert_eq!(exit, TerminalExit::Unknown);
                    assert_eq!(exit.wire_code(), None);
                    break;
                }
                Ok(Ok(SessionEvent::Error(message))) => {
                    panic!("slave close must not broadcast an error: {message}")
                }
                Ok(Ok(_)) => {}
                Ok(Err(e)) => panic!("event channel closed before the exit event: {e}"),
                Err(_) => panic!("no exit event within 10s of slave close"),
            }
        }
        assert_eq!(
            *registry_last_exit.lock().unwrap(),
            Some(TerminalExit::Unknown)
        );
    }

    #[test]
    fn persisted_window_session_survives_prune_and_reattaches() {
        // persist ⇒ keep: a detached session whose window has a durable blob is
        // kept indefinitely (browser-tab / devserver semantics), reattachable.
        let registry = Registry::new(test_config(1024, 4, 10));
        let handle = registry.create(opts_with_window("win-keep")).unwrap();
        let id = handle.id().to_string();
        drop(handle); // every client detached
        registry.mark_window_persisted("win-keep");
        let now = now_unix_secs() as i64;
        // Far past the idle grace -- a persisted window is never idle-reaped.
        assert_eq!(registry.prune_idle_at(now + 100_000), 0);
        assert_eq!(registry.len(), 1);
        assert!(registry.attach(&id, None).is_some());
    }

    #[test]
    fn busy_orphan_window_session_is_reaped_from_detach_time() {
        // The FD-leak fix: a BUSY detached session (fresh `last_activity`) whose
        // window was never persisted is still reaped, because the grace is timed
        // off the detach instant, not the last output byte.
        let registry = Registry::new(test_config(1024, 4, 10));
        let handle = registry.create(opts_with_window("win-orphan")).unwrap();
        drop(handle); // detached; window never persisted
        let now = now_unix_secs() as i64;
        {
            let sessions = registry.sessions.lock().unwrap();
            let session = sessions.values().next().unwrap();
            // Simulate a busy session: output kept arriving "just now"...
            session
                .last_activity
                .store(now + 100_000, Ordering::Relaxed);
            // ...but it has been detached since `now`.
            session.detached_at.store(now, Ordering::Relaxed);
        }
        // 11s past detach > the 10s grace ⇒ reaped despite the fresh activity.
        assert_eq!(registry.prune_idle_at(now + 11), 1);
        assert_eq!(registry.len(), 0);
    }

    #[test]
    fn forget_window_reaps_its_sessions_and_unpersists() {
        // discard ⇒ reap: a window-blob DELETE kills exactly that window's
        // sessions and drops it from the persisted set.
        let registry = Registry::new(test_config(1024, 4, 10));
        let a1 = registry.create(opts_with_window("win-a")).unwrap();
        let a2 = registry.create(opts_with_window("win-a")).unwrap();
        let b = registry.create(opts_with_window("win-b")).unwrap();
        registry.mark_window_persisted("win-a");
        drop(a1);
        drop(a2);
        drop(b);
        assert_eq!(registry.forget_window("win-a"), 2);
        assert_eq!(registry.len(), 1); // win-b untouched
        assert!(!registry.persisted_windows.lock().unwrap().contains("win-a"));
    }

    #[test]
    fn unpersist_window_drops_persistence_without_reaping() {
        // Move-out invariant: the source's `?w=W&moved=1` DELETE unpersists
        // the window but must NOT reap; attach rebinds the moved PTY to the
        // target window.
        let registry = Registry::new(test_config(1024, 4, 10));
        let _a = registry.create(opts_with_window("win-a")).unwrap();
        registry.mark_window_persisted("win-a");

        registry.unpersist_window("win-a");
        assert_eq!(registry.len(), 1, "move-out keeps the PTY alive (no reap)");
        assert!(
            !registry.persisted_windows.lock().unwrap().contains("win-a"),
            "the source window is no longer persisted"
        );
    }

    #[test]
    fn close_for_window_only_closes_the_matching_window() {
        let registry = Registry::new(test_config(1024, 4, 10));
        let _a = registry.create(opts_with_window("win-a")).unwrap();
        let _b = registry.create(opts_with_window("win-b")).unwrap();
        assert_eq!(registry.close_for_window("win-a", CloseReason::Explicit), 1);
        assert_eq!(registry.len(), 1);
        assert_eq!(
            registry.close_for_window("win-missing", CloseReason::Explicit),
            0
        );
    }

    #[test]
    fn count_for_window_counts_only_live_matching_sessions() {
        // The read-only basis for the `cs window rm` --force guard.
        let registry = Registry::new(test_config(1024, 4, 10));
        let _a1 = registry.create(opts_with_window("win-a")).unwrap();
        let _a2 = registry.create(opts_with_window("win-a")).unwrap();
        let _b = registry.create(opts_with_window("win-b")).unwrap();
        assert_eq!(registry.count_for_window("win-a"), 2);
        assert_eq!(registry.count_for_window("win-b"), 1);
        assert_eq!(registry.count_for_window("win-missing"), 0);
        // Closing a window's sessions drops it to zero.
        registry.close_for_window("win-a", CloseReason::Explicit);
        assert_eq!(registry.count_for_window("win-a"), 0);
        registry.close_all(CloseReason::Shutdown);
    }

    #[test]
    fn reap_exited_removes_a_dead_detached_session() {
        // A killed agent: its controller thread recorded `exit` on process
        // exit but the entry lingered (the ghost-tab name-holding bug). Once
        // detached (frontend gone) it is a pure ghost ⇒ reaped, freeing the name.
        let registry = Registry::new(test_config(1024, 4, 10));
        let handle = registry.create(opts_with_window("win-dead")).unwrap();
        drop(handle); // frontend gone (detached)
        {
            let sessions = registry.sessions.lock().unwrap();
            let session = sessions.values().next().unwrap();
            *session.exit.lock().unwrap() = Some(TerminalExit::Code { code: 0 });
        }
        assert_eq!(registry.reap_exited(), 1);
        assert_eq!(registry.len(), 0);
    }

    #[test]
    fn reap_exited_keeps_an_attached_dead_session() {
        // A natural `exit` while a client still views the final output: the
        // process is dead but a viewer is attached, so the pane survives until
        // the client detaches. Guards against a natural-exit-vanishes regression.
        let registry = Registry::new(test_config(1024, 4, 10));
        let _handle = registry.create(opts_with_window("win-viewed")).unwrap(); // attached
        {
            let sessions = registry.sessions.lock().unwrap();
            let session = sessions.values().next().unwrap();
            *session.exit.lock().unwrap() = Some(TerminalExit::Code { code: 0 });
        }
        assert_eq!(registry.reap_exited(), 0);
        assert_eq!(registry.len(), 1);
        registry.close_all(CloseReason::Shutdown);
    }

    #[test]
    fn reap_exited_keeps_a_live_detached_session() {
        // Detached but the process is still running (a busy background agent):
        // NOT a ghost -- kept. Process-death is the reap axis, not detach.
        let registry = Registry::new(test_config(1024, 4, 10));
        let handle = registry.create(opts_with_window("win-live")).unwrap();
        drop(handle); // detached, but exit stays None (still running)
        assert_eq!(registry.reap_exited(), 0);
        assert_eq!(registry.len(), 1);
        registry.close_all(CloseReason::Shutdown);
    }

    #[test]
    fn reap_exited_fires_the_window_reaper_for_a_dead_detached_session() {
        // A standalone terminal's PTY exits while detached -> reap_exited
        // closes the session AND fires the window-reaper hook with its
        // window_id, so the host can drop the window-feed row with it.
        let registry = Registry::new(test_config(1024, 4, 10));
        let reaped: Arc<std::sync::Mutex<Vec<String>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = Arc::clone(&reaped);
        registry.install_window_reaper(WindowReaper::new(move |window_id: &str| {
            sink.lock().unwrap().push(window_id.to_string());
        }));
        let handle = registry.create(opts_with_window("win-term")).unwrap();
        drop(handle); // detached
        {
            let sessions = registry.sessions.lock().unwrap();
            let session = sessions.values().next().unwrap();
            *session.exit.lock().unwrap() = Some(TerminalExit::Code { code: 0 });
        }
        assert_eq!(registry.reap_exited(), 1);
        assert_eq!(*reaped.lock().unwrap(), vec!["win-term".to_string()]);
    }

    #[test]
    fn reap_exited_does_not_fire_the_window_reaper_for_an_attached_session() {
        // The guard: an attached dead terminal is KEPT (a viewer sees the final
        // output), so the window-reaper must NOT fire and the window stays.
        let registry = Registry::new(test_config(1024, 4, 10));
        let reaped: Arc<std::sync::Mutex<Vec<String>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = Arc::clone(&reaped);
        registry.install_window_reaper(WindowReaper::new(move |window_id: &str| {
            sink.lock().unwrap().push(window_id.to_string());
        }));
        let _handle = registry.create(opts_with_window("win-viewed")).unwrap(); // attached
        {
            let sessions = registry.sessions.lock().unwrap();
            let session = sessions.values().next().unwrap();
            *session.exit.lock().unwrap() = Some(TerminalExit::Code { code: 0 });
        }
        assert_eq!(registry.reap_exited(), 0);
        assert!(reaped.lock().unwrap().is_empty());
        registry.close_all(CloseReason::Shutdown);
    }

    #[test]
    fn reap_window_layout_fires_the_blob_reaper() {
        // The explicit-discard hook: the host calls reap_window_layout so a
        // discarded terminal window's durable layout blob is dropped too.
        let registry = Registry::new(test_config(1024, 4, 10));
        let reaped: Arc<std::sync::Mutex<Vec<String>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = Arc::clone(&reaped);
        registry.install_blob_reaper(BlobReaper::new(move |window_id: &str| {
            sink.lock().unwrap().push(window_id.to_string());
        }));
        registry.reap_window_layout("win-blob");
        assert_eq!(*reaped.lock().unwrap(), vec!["win-blob".to_string()]);
    }

    #[test]
    fn reap_window_layout_is_a_noop_without_a_blob_reaper() {
        // Workspace / ephemeral / control tenants install no hook; the call must
        // be a harmless no-op, never a panic.
        let registry = Registry::new(test_config(1024, 4, 10));
        registry.reap_window_layout("win-none");
    }

    #[test]
    fn session_summaries_carry_the_owning_window_id() {
        // cs term list resolves each session's owning window from this field.
        let registry = Registry::new(test_config(4096, 4, 60));
        let _h = registry.create(opts_with_window("win-sum")).unwrap();
        let summaries = registry.session_summaries();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].window_id.as_deref(), Some("win-sum"));
        registry.close_all(CloseReason::Shutdown);
    }

    #[test]
    fn session_summaries_carry_the_attached_pane_side_and_tab() {
        // cs term list traces window -> pane -> side -> tab; the coordinates
        // ride the WS attach query and are recorded best-effort.
        let registry = Registry::new(test_config(4096, 4, 60));
        let handle = registry
            .get_or_create_for_ws(
                None,
                None,
                opts_with_window("win-pt"),
                TerminalPlacement {
                    pane_id: Some("pane-7".to_string()),
                    side: Some(PaneSide::B),
                    tab_id: Some("tab-3".to_string()),
                },
                None,
            )
            .unwrap();
        let id = handle.id().to_string();
        let summaries = registry.session_summaries();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].pane_id.as_deref(), Some("pane-7"));
        assert_eq!(summaries[0].side, Some(PaneSide::B));
        assert_eq!(summaries[0].tab_id.as_deref(), Some("tab-3"));

        // A reattach (split/move into another pane) re-binds the pane id; a
        // `None` on either axis leaves the prior value untouched.
        drop(handle);
        let _re = registry
            .get_or_create_for_ws(
                Some(&id),
                Some(0),
                opts_with_window("win-pt"),
                TerminalPlacement {
                    pane_id: Some("pane-9".to_string()),
                    ..TerminalPlacement::default()
                },
                None,
            )
            .unwrap();
        let summaries = registry.session_summaries();
        assert_eq!(summaries[0].pane_id.as_deref(), Some("pane-9"));
        assert_eq!(summaries[0].side, Some(PaneSide::B));
        assert_eq!(summaries[0].tab_id.as_deref(), Some("tab-3"));

        // A side-only move keeps the terminal socket mounted and refreshes
        // placement through its client frame.
        assert!(registry.update_session_layout(&id, None, Some(PaneSide::A), None));
        assert_eq!(registry.session_summaries()[0].side, Some(PaneSide::A));
        registry.close_all(CloseReason::Shutdown);
    }

    #[test]
    fn close_matching_closes_by_tab_name_and_leaves_others() {
        let registry = Registry::new(test_config(1024, 4, 10));
        let _a = registry
            .create(CreateOptions {
                tab_name: Some("@@Alice".into()),
                ..opts_with_window("win-a")
            })
            .unwrap();
        let _b = registry
            .create(CreateOptions {
                tab_name: Some("@@Bob".into()),
                ..opts_with_window("win-b")
            })
            .unwrap();
        assert_eq!(registry.close_matching(Some("@@Alice"), None), 1);
        assert_eq!(registry.len(), 1);
        // A selector that matches nothing closes nothing.
        assert_eq!(registry.close_matching(Some("@@Nobody"), None), 0);
        assert_eq!(registry.len(), 1);
        registry.close_all(CloseReason::Shutdown);
    }

    #[cfg(any(unix, windows))]
    fn assert_close_reaps_child() {
        let registry = Registry::new(test_config(4096, 8, 60));
        let handle = registry.create(opts_with_window("win-close-reap")).unwrap();
        let id = handle.id().to_string();
        let pid = registry.live_child_pids()[0];

        assert!(registry.close(&id, CloseReason::Explicit));
        wait_for_process_to_disappear(pid);
    }

    #[cfg(any(unix, windows))]
    fn assert_restart_reaps_old_child() {
        let registry = Registry::new(test_config(4096, 8, 60));
        let handle = registry
            .create(opts_with_window("win-restart-reap"))
            .unwrap();
        let id = handle.id().to_string();
        let old_pid = registry.live_child_pids()[0];

        assert!(registry.restart(&id, RestartOverrides::default()).unwrap());
        wait_for_process_to_disappear(old_pid);
        registry.close_all(CloseReason::Shutdown);
    }

    #[cfg(unix)]
    #[test]
    fn close_reaps_child_pid_on_unix() {
        assert_close_reaps_child();
    }

    #[cfg(unix)]
    #[test]
    fn restart_reaps_old_child_pid_on_unix() {
        assert_restart_reaps_old_child();
    }

    #[cfg(unix)]
    #[test]
    fn close_forces_and_reaps_hup_immune_child() {
        let registry = Registry::new(test_config(4096, 8, 60));
        let mut opts = opts_with_window("win-hup-immune");
        opts.command = Some(
            "trap '' HUP TERM; printf CHAN_HUP_IMMUNE_READY; while :; do sleep 1; done".into(),
        );
        let mut handle = registry.create(opts).unwrap();
        let id = handle.id().to_string();
        let pid = registry.live_child_pids()[0];
        wait_for_output(&mut handle, b"CHAN_HUP_IMMUNE_READY");

        assert!(registry.close(&id, CloseReason::Explicit));
        wait_for_process_to_disappear(pid);
    }

    #[cfg(windows)]
    #[test]
    fn conpty_close_reaps_child_process() {
        assert_close_reaps_child();
    }

    #[cfg(windows)]
    #[test]
    fn conpty_restart_reaps_old_child_process() {
        assert_restart_reaps_old_child();
    }

    #[test]
    fn restart_signals_restarted_not_closed_on_the_old_channel() {
        // Restart-reconcile contract: a restart broadcasts
        // `Restarted` (never `Closed`/`Exit`) on the OLD channel, so the /ws
        // reader re-attaches to the relaunched session under the SAME id
        // instead of dropping the tab. The id stays live afterwards.
        let registry = Registry::new(test_config(4096, 8, 60));
        let mut handle = registry.create(opts_with_window("win-restart")).unwrap();
        let id = handle.id().to_string();
        assert!(registry.restart(&id, RestartOverrides::default()).unwrap());
        let mut saw_restarted = false;
        while let Ok(event) = handle.rx.try_recv() {
            match event {
                SessionEvent::Restarted => saw_restarted = true,
                SessionEvent::Closed(_) | SessionEvent::Exit(_) => {
                    panic!("restart must not broadcast Closed/Exit on the old channel")
                }
                _ => {}
            }
        }
        assert!(
            saw_restarted,
            "restart must broadcast Restarted on the old channel"
        );
        // The id still resolves to a live, relaunched session.
        assert!(registry.attach_for_ws(&id, None).is_some());
        registry.close_all(CloseReason::Shutdown);
    }

    #[test]
    fn generation_bumps_on_restart() {
        // The per-PTY-life epoch must advance on restart: the session keeps its
        // id but the ring/`seq` reset to 0, so a reattach with a stale `since`
        // cursor would silently desync. The bumped generation is the client's
        // cache-invalidation signal (see `get_or_create_for_ws`'s gate).
        let registry = Registry::new(test_config(4096, 8, 60));
        let first = registry.create(opts_with_window("win-gen")).unwrap();
        let id = first.id().to_string();
        let gen1 = first.generation;
        drop(first);
        assert!(registry.restart(&id, RestartOverrides::default()).unwrap());
        let second = registry.attach(&id, None).unwrap();
        assert!(
            second.generation > gen1,
            "restart must mint a higher generation (was {gen1}, got {})",
            second.generation
        );
        registry.close_all(CloseReason::Shutdown);
    }

    #[tokio::test]
    async fn reattach_honors_since_only_on_matching_generation() {
        // A reattach resumes from `since` only when the client's cached
        // generation still matches the live session; a mismatch forces a full
        // replay so a stale cursor never yields a silently-truncated screen.
        let registry = Registry::new(test_config(1 << 16, 4, 60));
        let mut first = registry.create(opts_with_window("win-gate")).unwrap();
        let id = first.id().to_string();
        let gen = first.generation;
        // Drive output so the ring is non-empty and `seq` advances.
        first.send_input(b"echo chan-gate-probe\n");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let mut got_output = false;
        while tokio::time::Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            match tokio::time::timeout(remaining, first.rx.recv()).await {
                Ok(Ok(SessionEvent::Output(_))) => {
                    got_output = true;
                    break;
                }
                Ok(Ok(_)) => {}
                Ok(Err(_)) | Err(_) => break,
            }
        }
        assert!(got_output, "session produced no output to seed the ring");
        let end = registry.attach(&id, None).unwrap().seq;
        assert!(end > 0, "seq did not advance past 0");
        // Matching generation: `since` honored -> a small delta from `end`.
        let matched = registry
            .get_or_create_for_ws(
                Some(&id),
                Some(end),
                opts_with_window("win-gate"),
                TerminalPlacement::default(),
                Some(gen),
            )
            .unwrap();
        // Mismatched generation: `since` ignored -> full ring replay. The full
        // replay carries the pre-`end` history the delta omits, so it is
        // strictly larger -- robust to any trailing prompt output both observe.
        let mismatched = registry
            .get_or_create_for_ws(
                Some(&id),
                Some(end),
                opts_with_window("win-gate"),
                TerminalPlacement::default(),
                Some(gen + 1),
            )
            .unwrap();
        assert!(
            mismatched.replay.concat().len() > matched.replay.concat().len(),
            "a mismatched generation must replay more (full ring) than the matched delta"
        );
        registry.close_all(CloseReason::Shutdown);
    }

    #[test]
    fn cross_window_move_rebinds_window_and_survives_source_discard() {
        // Move invariant: a terminal dragged from window A to window B must
        // re-home to B on reattach, so A's discard (it emptied out) does NOT
        // reap the moved session -- only sessions STILL bound to A.
        let registry = Registry::new(test_config(1024, 4, 10));
        // Opened in window A...
        let handle = registry.create(opts_with_window("win-a")).unwrap();
        let id = handle.id().to_string();
        drop(handle); // the move detaches it from the source

        // ...dragged to window B: B reattaches by id with window_id=B.
        let reattached = registry
            .get_or_create_for_ws(
                Some(&id),
                Some(0),
                opts_with_window("win-b"),
                TerminalPlacement::default(),
                None,
            )
            .expect("reattach");
        assert_eq!(
            reattached.id(),
            id,
            "reattached the SAME session (no respawn)"
        );
        drop(reattached);

        // The SOURCE window A discards. It must reap nothing -- the session
        // moved to B.
        assert_eq!(
            registry.forget_window("win-a"),
            0,
            "discarding the source must not reap the moved session"
        );
        assert_eq!(registry.len(), 1, "the moved session survives");
        assert!(registry.attach(&id, None).is_some(), "moved PTY still live");

        // Discarding B (its true owner now) reaps it.
        assert_eq!(registry.forget_window("win-b"), 1);
        assert_eq!(registry.len(), 0);
    }

    #[test]
    fn cap_exceeded_refuses_create() {
        let registry = Registry::new(test_config(1024, 1, 10));
        let _first = registry
            .create(CreateOptions {
                size: test_size(),
                tab_name: None,
                tab_group: None,
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
                tab_group: None,
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
                tab_group: None,
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
                    tab_group: None,
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
                tab_group: None,
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
                tab_group: None,
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
                    tab_group: None,
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
        // TERM env var on the spawned shell honors
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
                tab_group: None,
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

    #[tokio::test]
    async fn standalone_spawn_exports_configured_terminal_backend() {
        // No workspace window, control socket, or MCP environment participates
        // in this spawn. Reading from the child proves CHAN_TERMINAL survives
        // the shared environment scrub and reaches a standalone PTY.
        for (ghostty, expected) in [(false, "xterm"), (true, "ghostty")] {
            let mut config = test_config(4096, 4, 60);
            config.terminal.ghostty = ghostty;
            let registry = Arc::new(Registry::new(config));
            let mut handle = registry
                .create(CreateOptions {
                    size: test_size(),
                    tab_name: None,
                    tab_group: None,
                    window_id: None,
                    mcp_env: false,
                    cwd: None,
                    command: Some("printf 'CHAN_TERMINAL=<%s>\\n' \"$CHAN_TERMINAL\"".into()),
                    env: Default::default(),
                })
                .unwrap();

            let needle = format!("CHAN_TERMINAL=<{expected}>");
            let out = collect_until(&mut handle, &needle, Duration::from_secs(5)).await;
            assert!(
                out.contains(&needle),
                "standalone PTY did not export configured backend {expected}: {out:?}"
            );
            registry.close(handle.id(), CloseReason::Explicit);
        }
    }

    #[tokio::test]
    async fn backend_preference_flip_applies_to_direct_create_and_restart_only() {
        let registry = Arc::new(Registry::new(test_config(4096, 4, 60)));
        // State the starting backend rather than inheriting it: the config
        // default is platform-keyed (ghostty on Linux), and what this test is
        // about is that a FLIP does not reach a running PTY, whichever value
        // it flips from.
        registry.set_terminal_backend(false);
        let mut original = registry
            .create(CreateOptions {
                size: test_size(),
                tab_name: None,
                tab_group: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                command: None,
                env: Default::default(),
            })
            .unwrap();
        let original_id = original.id().to_string();

        registry.set_terminal_backend(true);
        original.send_input(b"printf 'ORIGINAL=<%s>\\n' \"$CHAN_TERMINAL\"\n");
        let old_out =
            collect_until(&mut original, "ORIGINAL=<xterm>", Duration::from_secs(5)).await;
        assert!(
            old_out.contains("ORIGINAL=<xterm>"),
            "live preference change reached an already-running PTY: {old_out:?}"
        );

        let mut created = registry
            .create(CreateOptions {
                size: test_size(),
                tab_name: None,
                tab_group: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                command: Some("printf 'CREATED=<%s>\\n' \"$CHAN_TERMINAL\"".into()),
                env: Default::default(),
            })
            .unwrap();
        let created_out =
            collect_until(&mut created, "CREATED=<ghostty>", Duration::from_secs(5)).await;
        assert!(
            created_out.contains("CREATED=<ghostty>"),
            "direct create did not sample the live preference: {created_out:?}"
        );

        assert!(registry
            .restart(&original_id, RestartOverrides::default())
            .unwrap());
        let mut restarted = registry.attach(&original_id, None).unwrap();
        restarted.send_input(b"printf 'RESTARTED=<%s>\\n' \"$CHAN_TERMINAL\"\n");
        let restarted_out = collect_until(
            &mut restarted,
            "RESTARTED=<ghostty>",
            Duration::from_secs(5),
        )
        .await;
        assert!(
            restarted_out.contains("RESTARTED=<ghostty>"),
            "direct restart did not sample the live preference: {restarted_out:?}"
        );

        registry.close(created.id(), CloseReason::Explicit);
        registry.close(&original_id, CloseReason::Explicit);
    }

    #[tokio::test]
    async fn spawn_time_backend_resolver_updates_new_children_and_keeps_last_good_value() {
        let resolved = Arc::new(Mutex::new(Some(false)));
        let registry = Arc::new(Registry::new(test_config(4096, 4, 60)));
        registry.install_terminal_backend_resolver(TerminalBackendResolver::new({
            let resolved = resolved.clone();
            move || *resolved.lock().unwrap()
        }));
        let mut original = registry
            .create(CreateOptions {
                size: test_size(),
                tab_name: None,
                tab_group: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                command: None,
                env: Default::default(),
            })
            .unwrap();
        let original_id = original.id().to_string();

        *resolved.lock().unwrap() = Some(true);
        original.send_input(b"printf 'ORIGINAL=<%s>\\n' \"$CHAN_TERMINAL\"\n");
        let original_out =
            collect_until(&mut original, "ORIGINAL=<xterm>", Duration::from_secs(5)).await;
        assert!(
            original_out.contains("ORIGINAL=<xterm>"),
            "resolver changed an already-running child: {original_out:?}"
        );

        let mut created = registry
            .create(CreateOptions {
                size: test_size(),
                tab_name: None,
                tab_group: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                command: Some("printf 'CREATED=<%s>\\n' \"$CHAN_TERMINAL\"".into()),
                env: Default::default(),
            })
            .unwrap();
        let created_out =
            collect_until(&mut created, "CREATED=<ghostty>", Duration::from_secs(5)).await;
        assert!(
            created_out.contains("CREATED=<ghostty>"),
            "new child did not sample the resolver: {created_out:?}"
        );

        assert!(registry
            .restart(&original_id, RestartOverrides::default())
            .unwrap());
        let mut restarted = registry.attach(&original_id, None).unwrap();
        restarted.send_input(b"printf 'RESTARTED=<%s>\\n' \"$CHAN_TERMINAL\"\n");
        let restarted_out = collect_until(
            &mut restarted,
            "RESTARTED=<ghostty>",
            Duration::from_secs(5),
        )
        .await;
        assert!(
            restarted_out.contains("RESTARTED=<ghostty>"),
            "restart did not sample the resolver: {restarted_out:?}"
        );

        // A malformed/unreadable store resolves to None. Spawning remains
        // fail-open and keeps the last successful value (ghostty), rather than
        // falling all the way back to the registry's startup xterm value.
        *resolved.lock().unwrap() = None;
        let mut fallback = registry
            .create(CreateOptions {
                size: test_size(),
                tab_name: None,
                tab_group: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                command: Some("printf 'FALLBACK=<%s>\\n' \"$CHAN_TERMINAL\"".into()),
                env: Default::default(),
            })
            .unwrap();
        let fallback_out =
            collect_until(&mut fallback, "FALLBACK=<ghostty>", Duration::from_secs(5)).await;
        assert!(
            fallback_out.contains("FALLBACK=<ghostty>"),
            "resolver failure did not keep the last good value: {fallback_out:?}"
        );

        registry.close(created.id(), CloseReason::Explicit);
        registry.close(fallback.id(), CloseReason::Explicit);
        registry.close(&original_id, CloseReason::Explicit);
    }

    #[test]
    fn session_spawn_scrubs_systemd_notification_env() {
        let output = Command::new(std::env::current_exe().unwrap())
            .env("CHAN_SYSTEMD_ENV_SCRUB_CHILD", "1")
            .env("WATCHDOG_USEC", "30000000")
            .env("WATCHDOG_PID", std::process::id().to_string())
            .env("NOTIFY_SOCKET", "/run/chan-test-notify.sock")
            .arg("terminal_sessions::tests::session_spawn_scrubs_systemd_notification_env_child")
            .arg("--exact")
            .arg("--nocapture")
            .output()
            .unwrap();

        assert!(
            output.status.success(),
            "spawned terminal inherited systemd notification state\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }

    #[tokio::test]
    async fn session_spawn_scrubs_systemd_notification_env_child() {
        if std::env::var_os("CHAN_SYSTEMD_ENV_SCRUB_CHILD").is_none() {
            return;
        }

        let registry = Arc::new(Registry::new(test_config(4096, 4, 60)));
        let mut handle = registry
            .create(CreateOptions {
                size: test_size(),
                tab_name: None,
                tab_group: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                command: Some(
                    "sleep 0.1; printf 'WATCHDOG_USEC=<%s> WATCHDOG_PID=<%s> NOTIFY_SOCKET=<%s>\\n' \
                     \"$WATCHDOG_USEC\" \"$WATCHDOG_PID\" \"$NOTIFY_SOCKET\""
                        .into(),
                ),
                env: Default::default(),
            })
            .unwrap();

        let expected = "WATCHDOG_USEC=<> WATCHDOG_PID=<> NOTIFY_SOCKET=<>";
        let out = collect_until(&mut handle, expected, Duration::from_secs(5)).await;
        assert!(
            out.contains(expected),
            "systemd notification variables reached the terminal: {out:?}"
        );
        registry.close(handle.id(), CloseReason::Explicit);
    }

    #[tokio::test]
    async fn tenant_default_command_runs_when_session_omits_one() {
        // A tenant default command set after construction runs on a session
        // that brings none of its own, so a single-purpose terminal window's
        // PTY runs the given command instead of an interactive shell.
        let registry = Arc::new(Registry::new(test_config(4096, 4, 60)));
        registry.set_default_command(Some("printf 'DEFAULT=<ran>\\n'".into()));
        let mut handle = registry
            .create(CreateOptions {
                size: test_size(),
                tab_name: None,
                tab_group: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                command: None,
                env: Default::default(),
            })
            .unwrap();
        let out = collect_until(&mut handle, "DEFAULT=<ran>", Duration::from_secs(5)).await;
        assert!(
            out.contains("DEFAULT=<ran>"),
            "tenant default command did not run: {out:?}"
        );
        registry.close(handle.id(), CloseReason::Explicit);
    }

    #[tokio::test]
    async fn explicit_command_overrides_tenant_default() {
        // An explicit per-session command wins over the tenant default.
        let registry = Arc::new(Registry::new(test_config(4096, 4, 60)));
        registry.set_default_command(Some("printf 'PICK=<default>\\n'".into()));
        let mut handle = registry
            .create(CreateOptions {
                size: test_size(),
                tab_name: None,
                tab_group: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                command: Some("printf 'PICK=<explicit>\\n'".into()),
                env: Default::default(),
            })
            .unwrap();
        let out = collect_until(&mut handle, "PICK=<explicit>", Duration::from_secs(5)).await;
        assert!(
            out.contains("PICK=<explicit>"),
            "explicit command did not win over tenant default: {out:?}"
        );
        assert!(
            !out.contains("PICK=<default>"),
            "tenant default ran despite an explicit command: {out:?}"
        );
        registry.close(handle.id(), CloseReason::Explicit);
    }

    #[test]
    fn control_tenant_session_echoes_command_banner_first() {
        // A session that inherits the TENANT default command (the devserver
        // control / single-purpose tenant) writes the bare `{command}\r\n` as the
        // FIRST ring bytes -- before the child's output and so durable across a
        // scrollback replay. The banner is the bare script + newline (no prefix)
        // so the command's own output begins on the next line.
        let registry = Registry::new(test_config(4096, 4, 60));
        registry.set_default_command(Some("printf done".into()));
        let _handle = registry.create(opts_with_window("win-ctl")).unwrap();
        let ring = registry.all_scrollback();
        assert!(
            ring.starts_with(b"printf done\r\n"),
            "command banner must be the first ring bytes: {:?}",
            String::from_utf8_lossy(&ring)
        );
        assert!(
            !ring.starts_with(b"running:"),
            "banner must carry no `running:` prefix: {:?}",
            String::from_utf8_lossy(&ring)
        );
        registry.close_all(CloseReason::Shutdown);
    }

    #[test]
    fn shared_tenant_session_has_no_command_banner() {
        // The shared interactive tenant has no default command, so its session
        // runs the user's shell and gets NO banner -- the announce path never
        // fires, so the ring never leads with an injected `{command}\r\n` line
        // (a degenerate empty banner would lead with `\r\n`).
        let registry = Registry::new(test_config(4096, 4, 60));
        let _handle = registry.create(opts_with_window("win-sh")).unwrap();
        let ring = registry.all_scrollback();
        assert!(
            !ring.starts_with(b"\r\n"),
            "shared interactive terminal must have no banner: {:?}",
            String::from_utf8_lossy(&ring)
        );
        registry.close_all(CloseReason::Shutdown);
    }

    #[test]
    fn per_session_command_has_no_command_banner() {
        // A per-session command (a team agent terminal spawned via
        // `POST /api/terminals`) is NOT a single-purpose tenant -- the command did
        // not come from the tenant default, so it gets NO banner: the ring must
        // not lead with the bare `printf agent\r\n` echo a control tenant would
        // inject.
        let registry = Registry::new(test_config(4096, 4, 60));
        let mut opts = opts_with_window("win-agent");
        opts.command = Some("printf agent".into());
        let _handle = registry.create(opts).unwrap();
        let ring = registry.all_scrollback();
        assert!(
            !ring.starts_with(b"printf agent\r\n"),
            "a per-session command must have no banner: {:?}",
            String::from_utf8_lossy(&ring)
        );
        registry.close_all(CloseReason::Shutdown);
    }

    #[cfg(unix)]
    #[test]
    fn user_shell_resolves_to_a_nonempty_executable() {
        // The single-sourced resolver: $SHELL → passwd → /bin/sh, each validated
        // executable. Whatever it returns must be a real, runnable shell.
        use std::os::unix::fs::PermissionsExt;
        let shell = user_shell();
        assert!(!shell.is_empty(), "resolver returned an empty shell");
        let path = std::path::Path::new(&shell);
        assert!(path.is_absolute(), "shell path should be absolute: {shell}");
        let meta = std::fs::metadata(path).expect("resolved shell exists on disk");
        assert!(
            meta.permissions().mode() & 0o111 != 0,
            "resolved shell is executable: {shell}"
        );
    }

    #[tokio::test]
    async fn all_scrollback_returns_session_output() {
        let registry = Arc::new(Registry::new(test_config(4096, 4, 60)));
        let mut handle = registry
            .create(CreateOptions {
                size: test_size(),
                tab_name: None,
                tab_group: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                command: Some("printf 'SCRAPE=<tok123>\\n'".into()),
                env: Default::default(),
            })
            .unwrap();
        let _ = collect_until(&mut handle, "SCRAPE=<tok123>", Duration::from_secs(5)).await;
        let text = String::from_utf8_lossy(&registry.all_scrollback()).into_owned();
        assert!(
            text.contains("SCRAPE=<tok123>"),
            "all_scrollback missing the session output: {text:?}"
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
                tab_group: None,
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
                tab_group: None,
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
                tab_group: None,
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

    /// A registry session with a controllable id / window / group /
    /// broadcast flag and NO real PTY. `send_input` still bumps
    /// `last_activity` (the PTY write fails silently because the command
    /// receiver is dropped), so a delivery is observable as a bumped
    /// `last_activity` without spawning a shell.
    fn dummy_session(
        id: &str,
        window_id: Option<&str>,
        tab_group: Option<&str>,
        broadcast: bool,
    ) -> Arc<Session> {
        // `test_session_with_ring` already drops the command/output
        // receivers, so `send_input` fails silently but still bumps
        // `last_activity` (the delivery signal). Sole owner, so unwrap to
        // set the fields the cross-window fan reads (private, same module).
        let mut s = Arc::try_unwrap(test_session_with_ring(64)).expect("sole owner");
        s.id = id.to_string();
        s.window_id = Mutex::new(window_id.map(str::to_string));
        s.live_metadata = Mutex::new(LiveTerminalMetadata {
            name: None,
            group: tab_group.unwrap_or(DEFAULT_TERMINAL_GROUP).to_string(),
        });
        // Sentinel: 0 is distinguishable from any real `now_unix_secs()`.
        s.last_activity = AtomicI64::new(0);
        s.broadcast = AtomicBool::new(broadcast);
        Arc::new(s)
    }

    fn insert_session(registry: &Registry, session: Arc<Session>) {
        registry
            .sessions
            .lock()
            .unwrap()
            .insert(session.id.clone(), session);
    }

    /// A live session carrying a `tab_name`, for exercising the lowest-free
    /// `next_terminal_name` scan (which reads `tab_name`, not `id`).
    fn named_session(id: &str, tab_name: &str) -> Arc<Session> {
        let mut s = Arc::try_unwrap(test_session_with_ring(64)).expect("sole owner");
        s.id = id.to_string();
        s.live_metadata = Mutex::new(LiveTerminalMetadata {
            name: Some(tab_name.to_string()),
            group: DEFAULT_TERMINAL_GROUP.to_string(),
        });
        Arc::new(s)
    }

    fn was_delivered(registry: &Registry, id: &str) -> bool {
        registry
            .sessions
            .lock()
            .unwrap()
            .get(id)
            .map(|s| s.last_activity.load(Ordering::Relaxed) != 0)
            .unwrap_or(false)
    }

    #[test]
    fn cross_window_fan_respects_group_window_and_broadcast_toggle() {
        let registry = Registry::new(test_config(64, 16, 600));
        // Source in window A, group G.
        insert_session(
            &registry,
            dummy_session("src", Some("winA"), Some("G"), true),
        );
        // Same group, other window, broadcast ON -> receives.
        insert_session(
            &registry,
            dummy_session("on", Some("winB"), Some("G"), true),
        );
        // Same group, other window, broadcast OFF -> skipped (the fix).
        insert_session(
            &registry,
            dummy_session("off", Some("winB"), Some("G"), false),
        );
        // Other group, other window, broadcast ON -> skipped (wrong group).
        insert_session(
            &registry,
            dummy_session("other_group", Some("winB"), Some("H"), true),
        );
        // Same group, SAME window -> skipped (fanned client-side).
        insert_session(
            &registry,
            dummy_session("same_window", Some("winA"), Some("G"), true),
        );

        registry.broadcast_input_cross_window("src", b"hi");

        assert!(
            was_delivered(&registry, "on"),
            "broadcast-on member should receive"
        );
        assert!(
            !was_delivered(&registry, "off"),
            "broadcast-off member must not receive"
        );
        assert!(
            !was_delivered(&registry, "other_group"),
            "other-group member must not receive"
        );
        assert!(
            !was_delivered(&registry, "same_window"),
            "same-window member is handled client-side, not here"
        );
        assert!(
            !was_delivered(&registry, "src"),
            "source must not echo to itself"
        );
    }

    #[test]
    fn next_terminal_name_is_per_tenant() {
        let one = Registry::new(test_config(64, 16, 600));
        let two = Registry::new(test_config(64, 16, 600));
        insert_session(&one, named_session("a", "Terminal-1"));
        // A second tenant has its own numbering (the bug a process-global
        // static caused: a second workspace window restarting past 1). It is
        // unaffected by `one`'s live terminals.
        assert_eq!(two.next_terminal_name(), "Terminal-1");
        // `one` already has Terminal-1 live -> next is 2.
        assert_eq!(one.next_terminal_name(), "Terminal-2");
    }

    #[test]
    fn next_terminal_name_reuses_the_lowest_free_slot() {
        let reg = Registry::new(test_config(64, 16, 600));
        // Empty registry starts at 1.
        assert_eq!(reg.next_terminal_name(), "Terminal-1");
        // Two live terminals -> next extends past the max.
        insert_session(&reg, named_session("a", "Terminal-1"));
        insert_session(&reg, named_session("b", "Terminal-2"));
        assert_eq!(reg.next_terminal_name(), "Terminal-3");
        // Free the middle one -> its number is REUSED (the numbering regression:
        // open 1+2, close 2, next should be 2, not 3).
        reg.sessions.lock().unwrap().remove("b");
        assert_eq!(reg.next_terminal_name(), "Terminal-2");
        // A gap below the max is filled before extending: live {1, 3} -> 2.
        insert_session(&reg, named_session("c", "Terminal-3"));
        assert_eq!(reg.next_terminal_name(), "Terminal-2");
        // Non-default names never occupy a slot; bare "Terminal" counts as 1.
        let reg2 = Registry::new(test_config(64, 16, 600));
        insert_session(&reg2, named_session("x", "build"));
        insert_session(&reg2, named_session("y", "Terminal"));
        assert_eq!(reg2.next_terminal_name(), "Terminal-2");
    }

    #[test]
    fn parse_terminal_ordinal_parses_default_names_only() {
        assert_eq!(parse_terminal_ordinal("Terminal-1"), Some(1));
        assert_eq!(parse_terminal_ordinal("Terminal-12"), Some(12));
        assert_eq!(parse_terminal_ordinal("Terminal"), Some(1));
        assert_eq!(parse_terminal_ordinal("build"), None);
        assert_eq!(parse_terminal_ordinal("lead-2"), None);
        assert_eq!(parse_terminal_ordinal("Terminal-"), None);
        assert_eq!(parse_terminal_ordinal("Terminal-1x"), None);
        assert_eq!(parse_terminal_ordinal("Terminal-0"), None);
    }

    fn concurrent_created_names(proposed_name: Option<&str>) -> Vec<String> {
        let registry = Arc::new(Registry::new(test_config(1024, 4, 60)));
        *registry.spawn_barrier.lock().unwrap() = Some(Arc::new(std::sync::Barrier::new(2)));
        let mut creators = Vec::new();
        for window_id in ["win-a", "win-b"] {
            let registry = registry.clone();
            let proposed_name = proposed_name.map(str::to_string);
            creators.push(std::thread::spawn(move || {
                registry
                    .create(CreateOptions {
                        tab_name: proposed_name,
                        ..opts_with_window(window_id)
                    })
                    .expect("concurrent terminal create")
                    .live_metadata()
                    .name
                    .expect("new terminal has a settled name")
            }));
        }
        let mut names: Vec<String> = creators
            .into_iter()
            .map(|creator| creator.join().expect("creator thread"))
            .collect();
        *registry.spawn_barrier.lock().unwrap() = None;
        registry.close_all(CloseReason::Shutdown);
        names.sort();
        names
    }

    #[test]
    fn concurrent_default_creates_reserve_distinct_lowest_free_names() {
        assert_eq!(
            concurrent_created_names(None),
            vec!["Terminal-1".to_string(), "Terminal-2".to_string()]
        );
    }

    #[test]
    fn concurrent_duplicate_explicit_creates_use_the_shared_suffix_policy() {
        assert_eq!(
            concurrent_created_names(Some("worker")),
            vec!["worker".to_string(), "worker-2".to_string()]
        );
    }

    #[test]
    fn failed_spawn_releases_its_name_reservation() {
        let registry = Registry::new(test_config(1024, 4, 60));
        let mut failed_opts = opts_with_window("win-failed");
        failed_opts.tab_name = Some("released".into());
        failed_opts
            .env
            .insert("CHAN_TEST_FAIL_TERMINAL_SPAWN".into(), "1".into());
        let failed = registry.create(failed_opts);
        assert!(matches!(failed, Err(CreateError::Spawn(_))));
        assert!(registry.name_reservations.lock().unwrap().is_empty());

        let handle = registry
            .create(CreateOptions {
                tab_name: Some("released".into()),
                ..opts_with_window("win-ok")
            })
            .unwrap();
        assert_eq!(handle.live_metadata().name.as_deref(), Some("released"));
        registry.close_all(CloseReason::Shutdown);
    }

    #[test]
    fn create_restart_and_live_rename_share_suffixes_and_self_exclusion() {
        let registry = Registry::new(test_config(1024, 8, 60));
        let first = registry
            .create(CreateOptions {
                tab_name: Some("lane".into()),
                ..opts_with_window("win-a")
            })
            .unwrap();
        let second = registry
            .create(CreateOptions {
                tab_name: Some("lane".into()),
                ..opts_with_window("win-b")
            })
            .unwrap();
        assert_eq!(first.live_metadata().name.as_deref(), Some("lane"));
        assert_eq!(second.live_metadata().name.as_deref(), Some("lane-2"));

        let second_id = second.id().to_string();
        assert!(registry
            .restart(
                &second_id,
                RestartOverrides {
                    tab_name: Some("lane".into()),
                    tab_group: Some(Some("workers".into())),
                    ..RestartOverrides::default()
                },
            )
            .unwrap());
        let restarted = registry.attach(&second_id, None).unwrap();
        assert_eq!(
            restarted.live_metadata(),
            LiveTerminalMetadata {
                name: Some("lane-2".into()),
                group: "workers".into(),
            }
        );
        assert_eq!(restarted.spawn_name(), Some("lane-2"));
        assert_eq!(restarted.spawn_group(), Some("workers"));

        let third = registry
            .create(CreateOptions {
                tab_name: Some("lane".into()),
                ..opts_with_window("win-c")
            })
            .unwrap();
        let third_id = third.id().to_string();
        assert_eq!(third.live_metadata().name.as_deref(), Some("lane-3"));
        let settled = registry
            .update_live_metadata(&third_id, "lane".into(), Some("review".into()))
            .unwrap();
        assert_eq!(
            settled,
            LiveTerminalMetadata {
                name: Some("lane-3".into()),
                group: "review".into(),
            }
        );

        let first_id = first.id().to_string();
        registry
            .update_live_metadata(&first_id, "renamed".into(), Some("workers".into()))
            .unwrap();
        assert_eq!(
            registry
                .restart_matching(Some("lane"), None, RestartOverrides::default())
                .unwrap(),
            0
        );
        assert_eq!(
            registry
                .restart_matching(Some("renamed"), None, RestartOverrides::default())
                .unwrap(),
            1
        );
        let renamed = registry.attach(&first_id, None).unwrap();
        assert_eq!(renamed.live_metadata().name.as_deref(), Some("renamed"));
        assert_eq!(renamed.spawn_name(), Some("renamed"));
        registry.close_all(CloseReason::Shutdown);
    }

    #[test]
    fn live_metadata_readers_never_observe_a_torn_name_group_pair() {
        let registry = Arc::new(Registry::new(test_config(64, 4, 60)));
        let (session, _commands) =
            test_agent_session(64, "atomic", Some("old"), Some("old-group"), None, &[]);
        insert_session(&registry, session.clone());
        let start = Arc::new(std::sync::Barrier::new(2));
        let writer_registry = registry.clone();
        let writer_start = start.clone();
        let writer = std::thread::spawn(move || {
            writer_start.wait();
            for n in 0..10_000 {
                let (name, group) = if n % 2 == 0 {
                    ("new", "new-group")
                } else {
                    ("old", "old-group")
                };
                writer_registry
                    .update_live_metadata("atomic", name.into(), Some(group.into()))
                    .unwrap();
                std::thread::yield_now();
            }
        });
        start.wait();
        while !writer.is_finished() {
            let metadata = session.live_metadata();
            assert!(
                metadata
                    == (LiveTerminalMetadata {
                        name: Some("old".into()),
                        group: "old-group".into(),
                    })
                    || metadata
                        == (LiveTerminalMetadata {
                            name: Some("new".into()),
                            group: "new-group".into(),
                        }),
                "observed torn live metadata: {metadata:?}"
            );
        }
        writer.join().unwrap();
        registry.close_all(CloseReason::Shutdown);
    }

    #[test]
    fn by_name_selectors_ignore_spawn_and_prior_live_names() {
        let registry = Registry::new(test_config(1024, 4, 60));
        let (mut session, commands) =
            test_agent_session(1024, "selector", Some("spawn-name"), Some("old"), None, &[]);
        Arc::get_mut(&mut session).unwrap().window_id = Mutex::new(Some("win-selector".into()));
        session.record_output(b"selector tail");
        insert_session(&registry, session);

        let settled = registry
            .update_live_metadata("selector", "live-name".into(), Some("new".into()))
            .unwrap();
        assert_eq!(settled.name.as_deref(), Some("live-name"));
        let summary = registry.session_summaries().pop().unwrap();
        assert_eq!(summary.tab_name.as_deref(), Some("live-name"));
        assert_eq!(summary.spawn_name.as_deref(), Some("spawn-name"));

        assert_eq!(
            registry.write_input_matching(Some("spawn-name"), None, b"old"),
            0
        );
        assert_eq!(
            registry.write_input_matching(Some("live-name"), None, b"new"),
            1
        );
        assert!(matches!(commands.recv().unwrap(), PtyCommand::Input(data) if data == b"new"));
        assert_eq!(
            registry
                .enqueue_write_matching(Some("spawn-name"), None, "old", None)
                .queued,
            0
        );
        assert_eq!(
            registry
                .enqueue_write_matching(Some("live-name"), None, "new", None)
                .queued,
            1
        );
        assert!(registry.scrollback_matching("spawn-name").is_empty());
        assert_eq!(registry.scrollback_matching("live-name").len(), 1);
        assert!(registry
            .window_ids_matching(Some("spawn-name"), None)
            .is_empty());
        assert_eq!(
            registry.window_ids_matching(Some("live-name"), None),
            vec!["win-selector".to_string()]
        );
        assert_eq!(registry.close_matching(Some("spawn-name"), None), 0);
        assert_eq!(registry.close_matching(Some("live-name"), None), 1);
    }

    #[test]
    fn live_group_update_changes_cross_window_broadcast_membership_immediately() {
        let registry = Registry::new(test_config(64, 4, 60));
        insert_session(
            &registry,
            dummy_session("source", Some("win-a"), Some("group-a"), true),
        );
        insert_session(
            &registry,
            dummy_session("target", Some("win-b"), Some("group-b"), true),
        );
        registry.broadcast_input_cross_window("source", b"before");
        assert!(!was_delivered(&registry, "target"));

        registry
            .update_live_metadata("target", "target".into(), Some("group-a".into()))
            .unwrap();
        registry.broadcast_input_cross_window("source", b"after");
        assert!(was_delivered(&registry, "target"));
    }

    #[test]
    fn roster_reports_window_group_and_broadcast() {
        let registry = Registry::new(test_config(64, 16, 600));
        insert_session(&registry, dummy_session("a", Some("winA"), Some("G"), true));
        insert_session(&registry, dummy_session("b", Some("winB"), None, false));

        let mut roster = registry.roster();
        roster.sort_by(|x, y| x.id.cmp(&y.id));
        assert_eq!(roster.len(), 2);

        assert_eq!(roster[0].id, "a");
        assert_eq!(roster[0].window_id.as_deref(), Some("winA"));
        assert_eq!(roster[0].tab_group, "G");
        assert!(roster[0].broadcast);

        assert_eq!(roster[1].id, "b");
        // No explicit group resolves to the default, matching the SPA.
        assert_eq!(roster[1].tab_group, DEFAULT_TERMINAL_GROUP);
        assert!(!roster[1].broadcast);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn fdstore_metadata_round_trips_distinct_live_and_spawn_values_and_reads_legacy() {
        let meta = FdStoreSessionMeta {
            tenant_prefix: "tenant".into(),
            session_id: "session".into(),
            tab_name: Some("live-name".into()),
            tab_group: Some("live-group".into()),
            spawn_name: Some("spawn-name".into()),
            spawn_group: Some("spawn-group".into()),
            window_id: Some("window".into()),
            pane_id: None,
            side: None,
            tab_id: None,
            cwd: None,
            command: None,
            env: Default::default(),
            mcp_env: false,
            child_pid: None,
            size: test_size().into(),
            seq: 0,
            generation: 1,
            alt_screen: false,
            private_modes: Vec::new(),
        };
        let encoded = serde_json::to_value(&meta).unwrap();
        let decoded: FdStoreSessionMeta = serde_json::from_value(encoded.clone()).unwrap();
        assert_eq!(decoded, meta);

        let mut legacy = encoded;
        let object = legacy.as_object_mut().unwrap();
        object.remove("spawn_name");
        object.remove("spawn_group");
        let decoded: FdStoreSessionMeta = serde_json::from_value(legacy).unwrap();
        assert_eq!(decoded.tab_name.as_deref(), Some("live-name"));
        assert_eq!(decoded.tab_group.as_deref(), Some("live-group"));
        assert_eq!(decoded.spawn_name, None);
        assert_eq!(decoded.spawn_group, None);
    }

    #[cfg(target_os = "linux")]
    mod fdstore_parking {
        use super::*;

        #[derive(Default)]
        struct RecordingParkState {
            calls: Mutex<Vec<String>>,
            refuse_park: AtomicBool,
            snapshot_registry: Mutex<Option<Arc<Registry>>>,
            snapshot_seen: Mutex<Vec<String>>,
        }

        #[derive(Clone, Default)]
        struct RecordingPark(Arc<RecordingParkState>);

        impl RecordingPark {
            fn parker(&self) -> FdStoreParker {
                FdStoreParker::new(self.clone())
            }

            fn calls(&self) -> Vec<String> {
                self.0.calls.lock().unwrap().clone()
            }

            fn unpark_calls(&self) -> Vec<String> {
                self.calls()
                    .into_iter()
                    .filter(|call| call.starts_with("unpark:"))
                    .collect()
            }

            fn wait_for_call(&self, prefix: &str) -> String {
                let deadline = std::time::Instant::now() + Duration::from_secs(10);
                loop {
                    if let Some(call) = self
                        .calls()
                        .into_iter()
                        .find(|call| call.starts_with(prefix))
                    {
                        return call;
                    }
                    assert!(
                        std::time::Instant::now() < deadline,
                        "no {prefix} call within deadline; calls: {:?}",
                        self.calls()
                    );
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        }

        impl FdStorePark for RecordingPark {
            fn park(&self, fd_name: &str, _fd: std::os::fd::BorrowedFd<'_>) -> bool {
                // Simulate the devserver commit: snapshot the registry from
                // inside the hook. Deadlock-free only if the caller holds no
                // registry lock, and the provisional parked state must
                // already be visible here.
                if let Some(registry) = self.0.snapshot_registry.lock().unwrap().clone() {
                    let seen: Vec<String> = registry
                        .fdstore_manifest_sessions("t")
                        .into_iter()
                        .map(|entry| entry.fd_name)
                        .collect();
                    self.0.snapshot_seen.lock().unwrap().extend(seen);
                }
                self.0.calls.lock().unwrap().push(format!("park:{fd_name}"));
                !self.0.refuse_park.load(Ordering::Relaxed)
            }

            fn unpark(&self, fd_name: &str) {
                self.0
                    .calls
                    .lock()
                    .unwrap()
                    .push(format!("unpark:{fd_name}"));
            }

            fn adopt(&self, fd_name: &str) -> bool {
                self.0
                    .calls
                    .lock()
                    .unwrap()
                    .push(format!("adopt:{fd_name}"));
                true
            }

            fn changed(&self) {
                self.0.calls.lock().unwrap().push("changed".to_string());
            }
        }

        fn opts(window_id: Option<&str>, command: Option<&str>) -> CreateOptions {
            CreateOptions {
                size: test_size(),
                tab_name: None,
                tab_group: None,
                window_id: window_id.map(str::to_string),
                mcp_env: false,
                cwd: None,
                command: command.map(str::to_string),
                env: Default::default(),
            }
        }

        fn parked_registry(hook: &RecordingPark) -> Registry {
            let registry = Registry::new(test_config(4096, 8, 600));
            registry.install_fd_parker(hook.parker());
            registry
        }

        #[test]
        fn windowed_create_parks_and_close_unparks_same_name() {
            let hook = RecordingPark::default();
            let registry = parked_registry(&hook);
            let handle = registry.create(opts(Some("w1"), None)).unwrap();
            let id = handle.id().to_string();

            let park = hook.wait_for_call("park:");
            let name = park.strip_prefix("park:").unwrap().to_string();
            assert!(name.starts_with(FDSTORE_FD_PREFIX));
            assert!(name.contains(&id));

            assert!(registry.close(&id, CloseReason::Explicit));
            assert_eq!(hook.unpark_calls(), vec![format!("unpark:{name}")]);
        }

        #[test]
        fn windowless_create_parks_only_on_first_window_rebind() {
            let hook = RecordingPark::default();
            let registry = parked_registry(&hook);
            let handle = registry.create(opts(None, None)).unwrap();
            let id = handle.id().to_string();
            assert!(hook.calls().is_empty(), "windowless session parked");

            drop(handle);
            let handle = registry
                .get_or_create_for_ws(
                    Some(&id),
                    None,
                    opts(Some("w1"), None),
                    TerminalPlacement::default(),
                    None,
                )
                .unwrap();
            assert_eq!(handle.id(), id);
            hook.wait_for_call("park:");
            registry.close_all(CloseReason::Shutdown);
        }

        #[test]
        fn child_exit_unparks_immediately_and_keeps_attached_session() {
            let hook = RecordingPark::default();
            let registry = parked_registry(&hook);
            // `true` exits at once; the attached handle keeps the dead
            // session viewable while its store entry must already be gone.
            let handle = registry.create(opts(Some("w1"), Some("true"))).unwrap();
            let id = handle.id().to_string();
            hook.wait_for_call("park:");
            hook.wait_for_call("unpark:");
            assert!(
                registry.session_window_id(&id).is_some(),
                "attached dead session was removed from the registry"
            );

            // A later close converges on the same take-once state: no second
            // store removal.
            registry.close(&id, CloseReason::Explicit);
            assert_eq!(hook.unpark_calls().len(), 1);
        }

        #[test]
        fn restart_parks_new_incarnation_before_unparking_old() {
            let hook = RecordingPark::default();
            let registry = parked_registry(&hook);
            let handle = registry.create(opts(Some("w1"), None)).unwrap();
            let id = handle.id().to_string();
            let old_park = hook.wait_for_call("park:");
            let old_name = old_park.strip_prefix("park:").unwrap().to_string();

            assert!(registry
                .restart(
                    &id,
                    RestartOverrides {
                        tab_name: None,
                        tab_group: None,
                        window_id: None,
                        command: None,
                        env: None,
                    },
                )
                .unwrap());
            hook.wait_for_call("unpark:");

            let calls = hook.calls();
            let parks: Vec<&String> = calls.iter().filter(|c| c.starts_with("park:")).collect();
            assert_eq!(parks.len(), 2, "calls: {calls:?}");
            let new_name = parks[1].strip_prefix("park:").unwrap().to_string();
            assert_ne!(new_name, old_name, "incarnations must not share a name");
            let new_park_at = calls.iter().position(|c| *c == *parks[1]).unwrap();
            let old_unpark_at = calls
                .iter()
                .position(|c| *c == format!("unpark:{old_name}"))
                .expect("old incarnation unparked");
            assert!(
                new_park_at < old_unpark_at,
                "new must be stored before old is removed: {calls:?}"
            );
            registry.close_all(CloseReason::Shutdown);
        }

        #[test]
        fn park_refusal_leaves_session_alive_and_unparked() {
            let hook = RecordingPark::default();
            hook.0.refuse_park.store(true, Ordering::Relaxed);
            let registry = parked_registry(&hook);
            let handle = registry.create(opts(Some("w1"), None)).unwrap();
            let id = handle.id().to_string();
            hook.wait_for_call("park:");

            assert!(registry.close(&id, CloseReason::Explicit));
            assert!(
                hook.unpark_calls().is_empty(),
                "refused park must roll back the reservation"
            );
        }

        #[test]
        fn park_commit_snapshot_sees_provisional_state_without_deadlock() {
            let hook = RecordingPark::default();
            let registry = Arc::new(Registry::new(test_config(4096, 8, 600)));
            registry.install_fd_parker(hook.parker());
            *hook.0.snapshot_registry.lock().unwrap() = Some(registry.clone());

            let handle = registry.create(opts(Some("w1"), None)).unwrap();
            let park = hook.wait_for_call("park:");
            let name = park.strip_prefix("park:").unwrap();
            let seen = hook.0.snapshot_seen.lock().unwrap().clone();
            assert!(
                seen.iter().any(|entry| entry == name),
                "commit snapshot missed the provisional parked session: {seen:?}"
            );
            drop(handle);
            registry.close_all(CloseReason::Shutdown);
        }

        #[test]
        fn detach_parked_sessions_preserves_children_and_skips_unparked() {
            let hook = RecordingPark::default();
            let registry = parked_registry(&hook);
            let parked = registry.create(opts(Some("w1"), None)).unwrap();
            let parked_id = parked.id().to_string();
            let windowless = registry.create(opts(None, None)).unwrap();
            let windowless_id = windowless.id().to_string();
            hook.wait_for_call("park:");
            let child_pid = {
                let sessions = registry.sessions.lock().unwrap();
                sessions.get(&parked_id).unwrap().child_pid.unwrap()
            };

            assert_eq!(registry.detach_parked_sessions(), 1);
            assert!(registry.session_window_id(&parked_id).is_none());
            assert!(registry.session_window_id(&windowless_id).is_some());
            assert!(
                hook.unpark_calls().is_empty(),
                "detach must keep the store entry"
            );
            assert!(
                std::fs::metadata(format!("/proc/{child_pid}")).is_ok(),
                "detached child was killed"
            );

            // The preserved shell is this test's responsibility now.
            let pid = rustix::process::Pid::from_raw(child_pid as i32).unwrap();
            let _ = rustix::process::kill_process(pid, rustix::process::Signal::KILL);
            registry.close_all(CloseReason::Shutdown);
        }

        #[test]
        fn registry_drop_unparks_and_kills_leftovers() {
            let hook = RecordingPark::default();
            let registry = parked_registry(&hook);
            let _handle = registry.create(opts(Some("w1"), None)).unwrap();
            hook.wait_for_call("park:");
            drop(registry);
            assert_eq!(hook.unpark_calls().len(), 1, "drop must not preserve");
        }

        #[test]
        fn close_all_reports_count_and_unparks() {
            let hook = RecordingPark::default();
            let registry = parked_registry(&hook);
            let _windowed = registry.create(opts(Some("w1"), None)).unwrap();
            let _windowless = registry.create(opts(None, None)).unwrap();
            hook.wait_for_call("park:");

            assert_eq!(registry.close_all(CloseReason::Shutdown), 2);
            assert_eq!(hook.unpark_calls().len(), 1);
        }

        /// A close that runs WHILE `park` is in flight consumes the
        /// provisional reservation and fires its FDSTOREREMOVE before the
        /// FDSTORE lands; the successful park must then compensate with its
        /// own removal of the same name, because no take-once path is left.
        /// Deterministic via re-entrancy: the hook closes the session
        /// through the registry from INSIDE `park`, with enter/exit markers
        /// distinguishing the early provisional remove (between them) from
        /// the required compensating remove (after them).
        #[derive(Default)]
        struct ReentrantCloseState {
            calls: Mutex<Vec<String>>,
            registry: Mutex<Option<Arc<Registry>>>,
        }

        #[derive(Clone, Default)]
        struct ReentrantClosePark(Arc<ReentrantCloseState>);

        impl FdStorePark for ReentrantClosePark {
            fn park(&self, fd_name: &str, _fd: std::os::fd::BorrowedFd<'_>) -> bool {
                self.0
                    .calls
                    .lock()
                    .unwrap()
                    .push(format!("park-enter:{fd_name}"));
                // The session id is the middle of the fd name:
                // chan.pty.<session_id>.<child_pid>.
                let sid = fd_name
                    .strip_prefix(FDSTORE_FD_PREFIX)
                    .and_then(|rest| rest.rsplit_once('.'))
                    .map(|(sid, _)| sid.to_string())
                    .expect("chan fd name");
                if let Some(registry) = self.0.registry.lock().unwrap().clone() {
                    // The mid-flight close: consumes the provisional
                    // reservation and sends the early remove.
                    assert!(registry.close(&sid, CloseReason::Explicit));
                }
                self.0
                    .calls
                    .lock()
                    .unwrap()
                    .push(format!("park-exit:{fd_name}"));
                true
            }

            fn unpark(&self, fd_name: &str) {
                self.0
                    .calls
                    .lock()
                    .unwrap()
                    .push(format!("unpark:{fd_name}"));
            }

            fn adopt(&self, _fd_name: &str) -> bool {
                true
            }

            fn changed(&self) {}
        }

        #[test]
        fn close_during_park_gets_a_compensating_remove() {
            let hook = ReentrantClosePark::default();
            let registry = Arc::new(Registry::new(test_config(4096, 8, 600)));
            registry.install_fd_parker(FdStoreParker::new(hook.clone()));
            *hook.0.registry.lock().unwrap() = Some(registry.clone());

            let _handle = registry.create(opts(Some("w1"), None)).unwrap();

            let calls = hook.0.calls.lock().unwrap().clone();
            assert_eq!(calls.len(), 4, "calls: {calls:?}");
            let name = calls[0]
                .strip_prefix("park-enter:")
                .expect("first call is park entry");
            assert_eq!(
                calls,
                vec![
                    format!("park-enter:{name}"),
                    // The consumed reservation's EARLY remove, racing ahead
                    // of the store.
                    format!("unpark:{name}"),
                    format!("park-exit:{name}"),
                    // The COMPENSATING remove for the now-ownerless fd.
                    format!("unpark:{name}"),
                ],
                "the successful park must compensate for the consumed reservation"
            );
        }

        #[test]
        fn restore_adopts_without_a_store_call_and_unparks_on_close() {
            let hook = RecordingPark::default();
            let registry = parked_registry(&hook);

            let pty = native_pty_system().openpty(test_size()).unwrap();
            let raw_fd = pty.master.as_raw_fd().unwrap();
            let master_fd = clone_master_fd(raw_fd).unwrap();
            let meta = FdStoreSessionMeta {
                tenant_prefix: "t".into(),
                session_id: "imported-session".into(),
                tab_name: Some("live-name".into()),
                tab_group: Some("live-group".into()),
                spawn_name: Some("spawn-name".into()),
                spawn_group: Some("spawn-group".into()),
                window_id: Some("w1".into()),
                pane_id: None,
                side: None,
                tab_id: None,
                cwd: None,
                command: None,
                env: Default::default(),
                mcp_env: false,
                child_pid: Some(4242),
                size: test_size().into(),
                seq: 7,
                generation: 3,
                alt_screen: false,
                private_modes: Vec::new(),
            };
            let report = registry.restore_fdstore_sessions(vec![FdStoreSessionImport {
                meta,
                master_fd,
                replay: b"tail".to_vec(),
            }]);
            assert_eq!(report.restored, 1, "skipped: {:?}", report.skipped);

            let handle = registry.attach("imported-session", None).unwrap();
            assert_eq!(
                handle.live_metadata(),
                LiveTerminalMetadata {
                    name: Some("live-name".into()),
                    group: "live-group".into(),
                }
            );
            assert_eq!(handle.spawn_name(), Some("spawn-name"));
            assert_eq!(handle.spawn_group(), Some("spawn-group"));

            let adopt = hook.wait_for_call("adopt:");
            let name = adopt.strip_prefix("adopt:").unwrap().to_string();
            assert_eq!(name, fdstore_fd_name("imported-session", Some(4242)));
            assert!(
                !hook.calls().iter().any(|c| c.starts_with("park:")),
                "adoption must not re-store an inherited fd"
            );

            assert!(registry.close("imported-session", CloseReason::Explicit));
            assert_eq!(hook.unpark_calls(), vec![format!("unpark:{name}")]);
        }
    }
}
