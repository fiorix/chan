//! The control-socket wire contract shared by the `cs` client (which
//! serializes a [`ControlRequest`] and deserializes a [`ControlResponse`])
//! and chan-server's control socket (which deserializes the request and
//! serializes the response). Defining the two enums once here is what
//! kills the historical client/server duplication: a tag or field rename
//! that only landed on one side used to break every `cs` command at
//! runtime with a green build (the serde tags are the wire format).
//!
//! These types carry no transport and no clap surface, so they are always
//! compiled (no `client` feature gate) and chan-server can depend on
//! chan-shell with `default-features = false` to pull just this module.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::submit::{ResolvedSubmit, SubmitAgent};

/// Default `cs terminal survey` reply window, in seconds. The CLI flag
/// `--timeout` defaults to the same value; this serde default only covers a
/// caller that omits the field on the wire, so the server still bounds the
/// wait instead of blocking forever.
pub const DEFAULT_SURVEY_TIMEOUT_SECS: u64 = 600;

fn default_survey_timeout_secs() -> u64 {
    DEFAULT_SURVEY_TIMEOUT_SECS
}

/// Largest raw clipboard payload `cs copy` / `cs paste` will carry, in bytes.
/// The clipboard is for modest content (text, a screenshot, an HTML snippet),
/// not bulk transfer, so both sides refuse more than this rather than let an
/// unbounded stdin (`cs copy < /dev/zero`) or a hostile client OOM the CLI,
/// the server, or every connected tab. Shared here so the CLI cap, the server
/// copy-handler cap, and the `POST /api/window/reply` body limit agree.
pub const MAX_CLIPBOARD_BYTES: usize = 32 * 1024 * 1024;

/// The serialized graph-link prefix (`chan://graph?...`) a `cs open` /
/// `POST /api/open` target splits on: a matching target forwards to the
/// window verbatim as a graph link (the SPA owns the parser), anything else
/// resolves as a filesystem path. Shared here so the CLI and chan-server's
/// open route can never disagree on the split.
pub const GRAPH_LINK_PREFIX: &str = "chan://graph?";

/// Largest control-socket request line the server will read, in bytes. It
/// bounds the JSON envelope, so it must clear a `MAX_CLIPBOARD_BYTES` payload
/// base64-encoded (~1.34x) plus the surrounding keys: 48 MiB leaves headroom.
/// The server frames the request read with this cap so a hostile client can't
/// grow the request `String` without bound; an over-cap line is truncated and
/// fails to parse, yielding a clean error instead of an OOM.
pub const MAX_CONTROL_REQUEST_BYTES: u64 = 48 * 1024 * 1024;

/// The submit request riding a [`ControlRequest::TermWrite`]: present means
/// "submit into the target", and the agent NAME is what the sender believed
/// the target runs (kept only for the server's divergence note). The server
/// derives each matched session's real agent and resolves the chord template
/// in its own environment, so nothing in this value picks delivery bytes.
///
/// Untagged so the current client's bare agent name (`"claude"`) and the
/// former client shape (a fully client-resolved `ResolvedSubmit` object)
/// both decode: an older `cs` against a newer server keeps working, with its
/// client-resolved template ignored in favor of the server's own resolution.
#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TermWriteSubmit {
    Agent(SubmitAgent),
    LegacyResolved(ResolvedSubmit),
}

impl TermWriteSubmit {
    /// The agent the sender named, whichever wire shape carried it.
    pub fn agent(&self) -> SubmitAgent {
        match self {
            TermWriteSubmit::Agent(agent) => *agent,
            TermWriteSubmit::LegacyResolved(resolved) => resolved.agent,
        }
    }
}

/// A command from a `cs`-spawned terminal to the chan-server it belongs
/// to. The internal `type` tag plus `snake_case` variant names are the
/// wire strings the server matches on; do not rename without changing
/// both sides (they are the same type now, so a rename moves in lockstep).
///
/// Every `Option` field carries `default` (so the server tolerates an
/// omitted key) AND `skip_serializing_if` (so the client omits `None`):
/// both attributes on one field keep the emitted JSON byte-identical to
/// the pre-unification client while staying loss-tolerant on decode.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlRequest {
    // Category 1: open a UI tab in the originating window. The server
    // pushes a window_command keyed by window_id; only that window acts.
    OpenPath {
        window_id: String,
        path: PathBuf,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        destination: Option<TabDestination>,
    },
    OpenGraphLink {
        window_id: String,
        link: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        destination: Option<TabDestination>,
    },
    OpenGraph {
        window_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<PathBuf>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        destination: Option<TabDestination>,
    },
    OpenTermNew {
        window_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<PathBuf>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_group: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        destination: Option<TabDestination>,
    },
    OpenDashboard {
        window_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        carousel_index: Option<u32>,
        // Always emitted by the client (no skip) so the wire shape matches
        // the pre-unification request byte-for-byte; `default` lets a
        // future caller omit it without a decode error.
        #[serde(default)]
        carousel_off: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        destination: Option<TabDestination>,
    },
    // Category 1: raise the Inspector upload / download action in the
    // originating window (`cs upload` / `cs download`). `path` is the
    // CLI-absolutized target; the server resolves is_dir via `stat` (like
    // `OpenPath`), so it carries no is_dir. On a workspace tenant the server
    // relativizes it to workspace-rel; on a standalone terminal it stays
    // absolute (cwd / shell-uid scoped, no workspace wall). Upload targets a
    // directory (the server falls back to the parent dir when `path` is a file;
    // omitted -> the terminal's cwd); download targets a file or directory.
    // Non-blocking: the server pushes a window_command keyed by window_id and
    // returns immediately, exactly like the sibling open_* commands; only that
    // window raises the (existing) UI.
    Upload {
        window_id: String,
        path: PathBuf,
    },
    Download {
        window_id: String,
        path: PathBuf,
    },
    // Category 3 (blocking round-trip): bridge the terminal's stdin/stdout to
    // the window's clipboard (`cs copy` / `cs paste`). The clipboard lives in
    // the SPA (browser `navigator.clipboard`, or the desktop's native arboard
    // IPC), so the server pushes a `clipboard_write` / `clipboard_read`
    // window_command to the originating window, parks a oneshot on the window
    // bus, and BLOCKS until the SPA POSTs the result to `POST
    // /api/window/reply`, exactly like `PaneQuery`. Blocking (not
    // fire-and-forget like `Upload`) so a browser clipboard denial (no user
    // gesture / permission) surfaces as a real CLI error instead of a silent
    // no-op.
    //
    // `data_b64` is base64 of the bytes read from `cs copy`'s stdin; `mime`
    // is the optional `--mime` override (`--html` sets `text/html`). When
    // absent the server sniffs the decoded bytes (image magic bytes -> HTML
    // signature -> UTF-8 text) to pick one of `image/png`, `text/html`, or
    // `text/plain;charset=utf-8`.
    ClipboardCopy {
        window_id: String,
        data_b64: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mime: Option<String>,
    },
    // `cs paste`: read the window's clipboard back to stdout. `prefer` picks
    // which representation to emit when several are present; the SPA replies
    // `{ mime, data_b64 }` and the CLI base64-decodes it to raw stdout (so
    // `cs paste > file.png` yields a real PNG).
    ClipboardPaste {
        window_id: String,
        #[serde(default)]
        prefer: PastePrefer,
    },
    // Category 2: act on / inspect live PTY sessions the server owns. No
    // window_id; the server resolves sessions through its registry.
    //
    // `submit` present means "submit this into the target(s)"; the value is
    // the agent the SENDER believes the target runs. The server is
    // authoritative over the chord: it derives each matched session's real
    // agent and applies THAT chord, reporting a divergence in the reply, so
    // the sender's value never picks delivery bytes.
    TermWrite {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_group: Option<String>,
        data: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        submit: Option<TermWriteSubmit>,
    },
    TermList,
    // Category 2: list the windows this tenant knows about -- the same
    // `{id, connected, saved, title?, kind?}` rows as `GET /api/windows`
    // (saved session blobs ∪ live `/ws` presence, enriched with the
    // desktop-supplied OS title/kind), returned as JSON in `Ok.message`
    // for the CLI to format. Works on both workspace and terminal tenants.
    WindowList,
    // Identify the serving process behind this control socket: `chan ps`
    // round-trips it to classify each served workspace's holder as a
    // standalone `serve`, a chan-desktop, or a devserver. The reply is an
    // [`Identity`] JSON in `Ok.message`.
    Identify,
    // Category 4 (desktop window lifecycle): drive the desktop's OS
    // windows from the terminal. These reach the Tauri app through the
    // in-process bridge the embedded server installs; a standalone
    // `chan open` (standalone serve) has no desktop attached and refuses them. `new` is the
    // only one without an id: the server derives the kind from the calling
    // tenant (a terminal tenant spawns a terminal window; a workspace
    // tenant spawns another window of that workspace) and returns the new
    // window id. The id-bearing verbs act on ANY window by id (the single
    // desktop AppHandle is global), so an id need not belong to this tenant.
    WindowNew,
    // Focus a live window, or un-hide a buried one; best-effort reopens a
    // closed-but-saved workspace window when its workspace is still running.
    WindowOpen {
        id: String,
    },
    // `cs window rm`: truly DESTROY a window (unlike the OS close button,
    // which buries it) and delete its saved layout. When the window has
    // live terminal shells and `force` is unset, the desktop raises a
    // confirmation dialog and this request BLOCKS until the user answers;
    // `force` skips the prompt and kills the shells.
    WindowClose {
        id: String,
        #[serde(default)]
        force: bool,
    },
    // `cs window hide`: replicate the OS close button -- bury (hide) the
    // window, keeping its terminals and layout warm and reopenable.
    WindowHide {
        id: String,
    },
    // `cs session list`: participants + leader + each one's status, as JSON
    // in `Ok.message` for the CLI to render (like WindowList). Works on both
    // workspace and terminal tenants. Session-scoped: no window id.
    SessionList,
    // `cs session self`: with BOTH fields unset (the bare invocation) this is
    // the whoami query -- the server answers with the caller's own record
    // ({window_id, name, role, status, is_leader, identity?}) as JSON in
    // `Ok.message`. `--name=` renames the CALLING client; `--reset` clears its
    // override back to gateway identity / the generated default; clap forbids
    // combining them and the handler refuses a hand-crafted both-set request.
    // window_id is the caller's own ($CHAN_WINDOW_ID), supplied via open_env().
    SessionSelf {
        window_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default)]
        reset: bool,
    },
    // `cs session handover`: a FOLLOWER requests handover from the live leader
    // (blocks for accept/reject up to timeout_secs); or the LEADER answers a
    // pending request with accept/reject (the CLI path for a non-visible
    // leader). window_id is the caller's own. `to` optionally names the target
    // window id (default: the requester).
    SessionHandover {
        window_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to: Option<String>,
        #[serde(default)]
        accept: bool,
        #[serde(default)]
        reject: bool,
        #[serde(default)]
        timeout_secs: u64,
    },
    // `cs session takeover [--force]`: become leader. Plain takeover only when
    // the leader is disconnected/gone; `--force` seizes a LIVE leader.
    SessionTakeover {
        window_id: String,
        #[serde(default)]
        force: bool,
    },
    TermRestart {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_group: Option<String>,
    },
    // Category 2: close (tear down) live session(s) by tab name and/or group,
    // for `cs terminal close`. The explicit teardown partner to `TermRestart`:
    // kills the PTY and removes the registry entry, so the tab name frees,
    // instead of killing the pid out of band and leaving the entry to linger.
    TermClose {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_group: Option<String>,
    },
    // Category 2: dump one live session's replay ring (its scrollback) by
    // tab name and return the decoded bytes on the connection (like `term
    // list`). No group axis: scrollback reads exactly ONE terminal's
    // history, so `tab_name` is required and the server rejects a zero- or
    // multi-match. The CLI prints the raw bytes to stdout.
    TermScrollback {
        tab_name: String,
    },
    // Category 2: run bounded retrieval and graph traversal against this
    // tenant's live workspace. The core request type is shared directly so
    // every transport uses the same normalization and serde vocabulary.
    WorkspaceSearch {
        request: chan_workspace::WorkspaceSearchRequest,
    },
    // Category 3 (blocking round-trip): query a SPA window's tab/pane
    // LAYOUT. The layout lives only in the frontend, so the server resolves
    // the target window, pushes a `pane_query` window_command, parks a
    // oneshot (the window bus), and BLOCKS until the SPA replies with the
    // layout snapshot via `POST /api/window/reply`. The CLI prints it
    // (markdown by default, `--json` for machine output). The target is
    // EITHER `window_id` (the caller's own window, $CHAN_WINDOW_ID) OR
    // `tab_name` (`--tab-name`, which the server resolves to the single
    // window owning that tab via `window_ids_matching`) so the command works
    // from a context with no $CHAN_WINDOW_ID (an unbound agent, a native
    // terminal).
    PaneQuery {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        window_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_name: Option<String>,
    },
    // Category 3 (blocking round-trip): EXECUTE a layout mutation on a SPA
    // window (focus / split / resize / close) over the same window bus as
    // `PaneQuery`, with the same `window_id` / `tab_name` target resolution.
    // The server pushes a `pane_exec` window_command, BLOCKS until the SPA
    // applies it and replies the result, and the CLI prints it. A close that
    // hits a dirty file or a live terminal WITHOUT `force` is a partial
    // failure (reported in the result, non-zero exit); `force` closes anyway.
    PaneExec {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        window_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_name: Option<String>,
        op: PaneOp,
    },
    // Category 3 (blocking round-trip): render a workspace file to `format`
    // in a live renderer window and write the result back into the
    // workspace (`cs export`). No window_id: only the SPA can render (the
    // `format -> exporter` registry lives there), so the server targets the
    // most recently active live workspace window. The server resolves the
    // default `out` (the source with its extension swapped for the format,
    // `notes/doc.md` -> `notes/doc.pdf`) BEFORE dispatch, pushes an
    // `export-job` window_command, parks a oneshot on the window bus, and
    // BLOCKS until the SPA uploads the bytes and replies; success rides the
    // dedicated [`ControlResponse::Export`] carrying the final
    // workspace-relative output path. Both paths are workspace-relative
    // strings end to end; `format` is an opaque string (`pdf` is the only
    // registered format today) and an unknown one fails in the renderer
    // with a clear error.
    Export {
        path: String,
        format: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        out: Option<String>,
    },
    // Category 2 (blocking): raise a survey overlay on the SPA window(s)
    // that own the matching terminal tab(s) and BLOCK until the user
    // answers. The server resolves the selector to those windows, mints
    // `spec.survey_id`, pushes the overlay, parks a oneshot keyed by that
    // id, and holds this connection open until the SPA's reply route
    // completes it. The CLI prints the chosen option (or the follow-up /
    // dismiss line) to stdout. Unlike `TermWrite`, the reply round-trip is
    // the whole point, so this is the one control request that does not
    // return immediately.
    TermSurvey {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_group: Option<String>,
        spec: SurveySpec,
        /// How many seconds the server waits for a reply before giving up and
        /// answering with [`ControlResponse::Timeout`]. The CLI flag
        /// `--timeout` carries the real default (600); the serde default keeps
        /// a direct or older caller that omits the field on the same 600s
        /// window instead of blocking forever.
        #[serde(default = "default_survey_timeout_secs")]
        timeout_secs: u64,
    },
    // Category 2: create or load a Team Work team from the CLI (`cs
    // terminal team new|load`). `new` carries the team's config.toml text
    // to validate + write (config.toml + the server-regenerated
    // bootstrap.md + the tasks/journals/followups tree); `load` reads an
    // existing `{dir}/config.toml`. With `script`, the server returns the
    // paste-and-run bootstrap shell script instead of mutating anything.
    // The config travels as raw TOML text (not a typed TeamConfig) so this
    // wire module keeps its chan-workspace-free, serde-only footprint; the
    // server owns the parse / validate / generate.
    TerminalTeam {
        /// Workspace-relative team directory (the team lives at
        /// `{dir}/config.toml`).
        dir: String,
        /// `new` (write/generate from `config_toml`) or `load` (read
        /// `{dir}/config.toml`).
        op: TeamOp,
        /// The team config.toml text for `new`; absent for `load`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        config_toml: Option<String>,
        /// The brief text (`--brief <file>`, read client-side) folded verbatim
        /// into the generated `bootstrap.md` for `new`; absent for `load` and
        /// when no brief was given. Travels as raw text alongside
        /// `config_toml`: the server has no access to the caller's filesystem,
        /// and the dialog path sends file CONTENT the same way.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        brief_content: Option<String>,
        /// Emit the paste-and-run bootstrap script instead of writing
        /// (`new`) / summarizing (`load`).
        #[serde(default)]
        script: bool,
        /// The caller's window id ($CHAN_WINDOW_ID), when `cs terminal team`
        /// runs from a chan terminal that belongs to an SPA window. The
        /// server binds each spawned agent session to it, so the agents
        /// carry $CHAN_WINDOW_ID too and `cs pane` / `cs open` work from
        /// inside an agent (the window-targeting commands resolve a window).
        /// Absent when the caller has no window (e.g. a native terminal):
        /// the agents spawn unbound, as before.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        window_id: Option<String>,
        /// Optional pane-side placement for every surfaced member tab. The
        /// outer `window_id` remains the window coordinate.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        destination: Option<TabDestination>,
    },
    // Category 5 (process teardown): tear down the server serving `path`,
    // the transport behind `chan close <path>` (and `chan workspace rm`, which
    // closes before it forgets). `cmd_close` discovers the serving process
    // from the workspace's `writer.lock` and sends this over that process's
    // control socket; THE SERVER DECIDES SCOPE from `path`: a standalone
    // `chan open <path>` of that root fires its own graceful shutdown (the
    // process exits, releasing the flock), while a multi-tenant host (a
    // `chan devserver` / chan-desktop) unmounts just that tenant and keeps
    // running. The client carries no scope hint -- the server knows its own
    // kind. `path` is the canonical workspace root.
    //
    // `remove` carries the `--remove` intent through to a HOST so the host
    // also UNREGISTERS the workspace from its library + on/off overlay (the
    // `DELETE /api/library/workspaces/{id}` equivalent) -- without it, removing
    // only the caller's local `config.toml` leaves a devserver-served workspace
    // lingering in the launcher and surviving a restart. A standalone serve
    // ignores it (it exits either way; the caller forgets the local registry).
    Close {
        path: PathBuf,
        #[serde(default)]
        remove: bool,
    },
}

/// Which clipboard representation `cs paste` emits when the clipboard holds
/// more than one. `Auto` is image-first (so `cs paste > file.png` gets the
/// picture), then plain text; the SPA falls through to whatever it can read.
/// The explicit `Text` / `Html` / `Image` are the `--text` / `--html` /
/// `--image` overrides. A bare snake_case string on the wire; the explicit
/// `rename_all` pins it so a Rust rename cannot drift the format the SPA
/// matches on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PastePrefer {
    #[default]
    Auto,
    Text,
    Html,
    Image,
}

/// One side of a Hybrid pane. Lowercase is the control and terminal wire
/// vocabulary; the SPA renders uppercase labels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "client", derive(clap::ValueEnum))]
pub enum PaneSide {
    A,
    B,
}

/// Optional coordinates within a target window for a newly surfaced tab.
/// The outer control request and window-command frame own the window id.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TabDestination {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side: Option<PaneSide>,
}

/// Which `cs terminal team` operation a [`ControlRequest::TerminalTeam`]
/// carries. A bare snake_case string on the wire, matching the CLI
/// subcommand names. The explicit `rename_all` pins the wire strings so a
/// Rust rename cannot silently drift the format the server matches on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamOp {
    /// `cs terminal team new`: validate + write the config (and the dir
    /// tree), or with `--script` emit the bootstrap script.
    New,
    /// `cs terminal team load`: read + validate `{dir}/config.toml`, or
    /// with `--script` emit the bootstrap script for the stored config.
    Load,
}

/// A `cs pane` exec operation carried in [`ControlRequest::PaneExec`], pushed
/// to the SPA nested under the `pane_exec` window command's `op` field.
/// Internally tagged on `kind` (snake_case), so each variant is
/// `{ "kind": "focus", ... }` and the SPA discriminates on `frame.op.kind`.
/// The explicit `rename_all` pins the wire strings the SPA matches on, so a
/// Rust rename cannot silently drift the format with a green build.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PaneOp {
    /// Make `pane_id` the active (focused) pane.
    Focus {
        pane_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        side: Option<PaneSide>,
    },
    /// Split a pane (the active one when `pane_id` is absent), placing the
    /// new empty pane to the `right` or `bottom`.
    Split {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pane_id: Option<String>,
        dir: SplitDir,
    },
    /// Resize the enclosing split of a pane (the active one when absent) by
    /// `delta` (a ratio step in -1.0..1.0; positive grows the pane). The SPA
    /// clamps the resulting ratio and no-ops a pane that has no parent split
    /// (the sole pane).
    Resize {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pane_id: Option<String>,
        delta: f64,
    },
    /// Set the pane's nearest enclosing split to an equal 50/50 ratio.
    Equalize {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pane_id: Option<String>,
    },
    /// Swap complete Hybrid contents between two pane positions.
    Swap {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pane_id: Option<String>,
        other_pane_id: String,
    },
    /// Close one tab: `tab_id` in `pane_id` (each defaults to the active
    /// tab / pane). `force` closes past a dirty file / live terminal.
    CloseTab {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pane_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tab_id: Option<String>,
        #[serde(default)]
        force: bool,
    },
    /// Close a whole pane (the active one when absent). `force` as above.
    ClosePane {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pane_id: Option<String>,
        #[serde(default)]
        force: bool,
    },
    /// Close every tab in every pane. `force` as above.
    CloseAll {
        #[serde(default)]
        force: bool,
    },
}

/// Which side a [`PaneOp::Split`] places the new pane. `right` splits the
/// pane horizontally (new pane to the right); `bottom` splits it vertically
/// (new pane below). Matches the hybrid pane hamburger (right / bottom). Bare
/// snake_case on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SplitDir {
    Right,
    Bottom,
}

/// A survey raised over terminal tab(s) by `cs terminal survey`. Carried in
/// [`ControlRequest::TermSurvey`] from the CLI, then pushed to the SPA in an
/// `open_survey` window command. The CLI builds it with an EMPTY `survey_id`;
/// the server mints the id before the SPA sees it, and the SPA echoes that id
/// back in its [`SurveyReply`] so the server matches the parked oneshot.
///
/// serde camelCase: this is the exact JSON the SPA reads; the SPA's
/// TypeScript types mirror this struct field for field.
/// The nullable field (`title`) serializes as `null` rather than being
/// skipped, so the SPA-facing frame matches the contract's `string | null`
/// shape exactly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurveySpec {
    /// Server-minted. Empty on the CLI -> server request; filled in before
    /// the SPA sees it. The SPA echoes it in the reply.
    #[serde(default)]
    pub survey_id: String,
    /// Optional heading rendered above the body.
    #[serde(default)]
    pub title: Option<String>,
    /// The problem description, rendered as markdown.
    pub body_markdown: String,
    /// 1..=4 option labels; the SPA numbers them `[1]`..`[4]`.
    pub options: Vec<String>,
}

/// The reply the SPA sends back through the reply route to the blocked CLI.
/// Internally tagged on `kind` (`"option"` / `"followup"`), serde camelCase.
/// The explicit `tag` + variant renames pin the wire strings so a Rust
/// rename cannot silently drift the format the SPA POSTs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SurveyReply {
    /// The user picked one of the numbered options.
    #[serde(rename = "option", rename_all = "camelCase")]
    Option {
        survey_id: String,
        option_index: u32,
        option_label: String,
    },
    /// The user hit `[F]` (follow up later): a bare signal, shaped like
    /// `Dismissed`, telling the asking agent the host will follow up in a
    /// separate prompt. No option, no payload.
    #[serde(rename = "followup", rename_all = "camelCase")]
    Followup { survey_id: String },
    /// The user hit Dismiss (Part C). A distinct reply with no option index,
    /// so the asking agent can tell the host dropped the survey rather than
    /// answering it or deferring with `[F]`.
    #[serde(rename = "dismissed", rename_all = "camelCase")]
    Dismissed { survey_id: String },
}

impl SurveyReply {
    /// The `survey_id` this reply echoes, used to match the parked oneshot
    /// regardless of which variant it is.
    pub fn survey_id(&self) -> &str {
        match self {
            SurveyReply::Option { survey_id, .. } => survey_id,
            SurveyReply::Followup { survey_id } => survey_id,
            SurveyReply::Dismissed { survey_id } => survey_id,
        }
    }
}

#[cfg(test)]
mod term_write_wire_tests {
    //! These pin the EXACT on-wire JSON of the terminal write request. The
    //! logical text is what the server retains until drain time, and the
    //! submit field is the sender's request (whether to submit, plus the
    //! agent name it believed the target runs), so a serde rename that
    //! drifts them changes delivery with a green build.
    use super::*;

    #[test]
    fn term_write_carries_logical_text_and_requested_agent() {
        let request = ControlRequest::TermWrite {
            tab_name: Some("@@Worker".into()),
            tab_group: None,
            data: "poke\n".into(),
            submit: Some(TermWriteSubmit::Agent(crate::SubmitAgent::Claude)),
        };
        let raw = serde_json::to_string(&request).unwrap();
        assert_eq!(
            raw,
            r#"{"type":"term_write","tab_name":"@@Worker","data":"poke\n","submit":"claude"}"#
        );
        let back: ControlRequest = serde_json::from_str(&raw).unwrap();
        match back {
            ControlRequest::TermWrite { data, submit, .. } => {
                assert_eq!(data, "poke\n");
                assert_eq!(submit.unwrap().agent(), crate::SubmitAgent::Claude);
            }
            other => panic!("expected term_write, got {other:?}"),
        }
    }

    #[test]
    fn term_write_still_decodes_the_legacy_resolved_submit_object() {
        // A pre-authority `cs` resolves the template client-side and sends
        // the full object. The server keeps decoding that shape, reading only
        // the agent name; the client-resolved template is superseded by the
        // server's own per-session resolution.
        let raw = concat!(
            r#"{"type":"term_write","tab_name":"@@Worker","data":"poke\n","#,
            r#""submit":{"agent":"codex","template":"{}TAIL","source":"built_in"}}"#
        );
        let back: ControlRequest = serde_json::from_str(raw).unwrap();
        match back {
            ControlRequest::TermWrite { data, submit, .. } => {
                assert_eq!(data, "poke\n");
                assert_eq!(submit.unwrap().agent(), crate::SubmitAgent::Codex);
            }
            other => panic!("expected term_write, got {other:?}"),
        }
    }
}

#[cfg(test)]
mod survey_wire_tests {
    //! These pin the EXACT on-wire JSON of the survey types. The serde
    //! tags + camelCase are the contract between the CLI and the SPA's
    //! reply route; a Rust rename that drifts them breaks at runtime
    //! with a green build, so assert the bytes, not just round-trip.
    use super::*;

    #[test]
    fn survey_spec_is_camel_case_with_explicit_nulls() {
        let spec = SurveySpec {
            survey_id: "survey-3".into(),
            title: None,
            body_markdown: "pick one".into(),
            options: vec!["A".into(), "B".into()],
        };
        let v: serde_json::Value = serde_json::to_value(&spec).unwrap();
        assert_eq!(v["surveyId"], "survey-3");
        // title is null (not omitted), matching the contract's `string|null`.
        assert!(v.get("title").is_some_and(|t| t.is_null()));
        assert_eq!(v["bodyMarkdown"], "pick one");
        assert_eq!(v["options"], serde_json::json!(["A", "B"]));
    }

    #[test]
    fn survey_spec_serializes_present_title() {
        let spec = SurveySpec {
            survey_id: String::new(),
            title: Some("Heads up".into()),
            body_markdown: "x".into(),
            options: vec!["ok".into()],
        };
        let v: serde_json::Value = serde_json::to_value(&spec).unwrap();
        assert_eq!(v["title"], "Heads up");
    }

    #[test]
    fn survey_reply_option_tag_and_fields() {
        let reply = SurveyReply::Option {
            survey_id: "survey-1".into(),
            option_index: 2,
            option_label: "Ship it".into(),
        };
        let v: serde_json::Value = serde_json::to_value(&reply).unwrap();
        assert_eq!(v["kind"], "option");
        assert_eq!(v["surveyId"], "survey-1");
        assert_eq!(v["optionIndex"], 2);
        assert_eq!(v["optionLabel"], "Ship it");
        // The SPA POSTs exactly this; round-trips back to the same variant.
        let back: SurveyReply = serde_json::from_value(v).unwrap();
        assert_eq!(back.survey_id(), "survey-1");
        assert!(matches!(
            back,
            SurveyReply::Option {
                option_index: 2,
                ..
            }
        ));
    }

    #[test]
    fn survey_reply_followup_tag_and_fields() {
        // [F] is a bare "host will follow up later" signal, shaped exactly
        // like a dismiss but under its own tag: survey id only, no payload.
        let reply = SurveyReply::Followup {
            survey_id: "survey-9".into(),
        };
        let v: serde_json::Value = serde_json::to_value(&reply).unwrap();
        assert_eq!(v["kind"], "followup");
        assert_eq!(v["surveyId"], "survey-9");
        assert_eq!(reply.survey_id(), "survey-9");
        assert_eq!(
            v.as_object().map(|o| o.len()),
            Some(2),
            "kind + surveyId only"
        );
    }

    #[test]
    fn survey_reply_dismissed_tag_and_fields() {
        // Dismiss is a distinct reply (no option index, no file) so
        // the asking agent can tell the host dropped the survey.
        let reply = SurveyReply::Dismissed {
            survey_id: "survey-7".into(),
        };
        let v: serde_json::Value = serde_json::to_value(&reply).unwrap();
        assert_eq!(v["kind"], "dismissed");
        assert_eq!(v["surveyId"], "survey-7");
        assert_eq!(reply.survey_id(), "survey-7");
    }

    #[test]
    fn term_survey_request_tag_and_spec_round_trip() {
        let req = ControlRequest::TermSurvey {
            tab_name: Some("@@Alice".into()),
            tab_group: None,
            spec: SurveySpec {
                survey_id: String::new(),
                title: None,
                body_markdown: "q".into(),
                options: vec!["yes".into()],
            },
            timeout_secs: 42,
        };
        let v: serde_json::Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["type"], "term_survey");
        assert_eq!(v["tab_name"], "@@Alice");
        // tab_group None is skipped on the wire (matches the sibling variants).
        assert!(v.get("tab_group").is_none());
        assert_eq!(v["spec"]["bodyMarkdown"], "q");
        assert_eq!(v["timeout_secs"], 42);
        // Decodes back into the same variant (the server's path).
        let raw = serde_json::to_string(&req).unwrap();
        let back: ControlRequest = serde_json::from_str(&raw).unwrap();
        assert!(matches!(
            back,
            ControlRequest::TermSurvey {
                timeout_secs: 42,
                ..
            }
        ));
    }

    #[test]
    fn term_survey_timeout_secs_defaults_when_omitted() {
        // An older / direct caller that omits `timeout_secs` decodes onto the
        // baked-in default rather than 0 (which would time out immediately) or
        // a decode error, so the server still bounds the wait.
        let raw = serde_json::json!({
            "type": "term_survey",
            "tab_name": "@@Alice",
            "spec": { "surveyId": "", "title": null, "bodyMarkdown": "q", "options": ["yes"] },
        })
        .to_string();
        let back: ControlRequest = serde_json::from_str(&raw).unwrap();
        match back {
            ControlRequest::TermSurvey { timeout_secs, .. } => {
                assert_eq!(timeout_secs, DEFAULT_SURVEY_TIMEOUT_SECS);
            }
            other => panic!("expected TermSurvey, got {other:?}"),
        }
    }

    #[test]
    fn control_response_timeout_tag_round_trips() {
        // The timeout outcome is a distinct `status` so the client never has
        // to infer it from `error` or a dropped connection.
        let resp = ControlResponse::Timeout {
            message: "no reply within 600s".into(),
        };
        let v: serde_json::Value = serde_json::to_value(&resp).unwrap();
        assert_eq!(v["status"], "timeout");
        assert_eq!(v["message"], "no reply within 600s");
        let back: ControlResponse = serde_json::from_str(&v.to_string()).unwrap();
        assert!(matches!(back, ControlResponse::Timeout { .. }));
    }

    #[test]
    fn control_response_submit_refused_tag_round_trips() {
        let resp = ControlResponse::SubmitRefused {
            message: "queued, but no chord applied".into(),
        };
        let v: serde_json::Value = serde_json::to_value(&resp).unwrap();
        assert_eq!(v["status"], "submit_refused");
        assert_eq!(v["message"], "queued, but no chord applied");
        let back: ControlResponse = serde_json::from_str(&v.to_string()).unwrap();
        assert!(matches!(back, ControlResponse::SubmitRefused { .. }));
    }

    #[test]
    fn control_response_queue_full_tag_round_trips() {
        // The queue-full refusal is a distinct `status` so the client renders
        // an explicit failure instead of a decode error or a silent drop.
        let resp = ControlResponse::QueueFull {
            message: "survey queue for this target is full".into(),
        };
        let v: serde_json::Value = serde_json::to_value(&resp).unwrap();
        assert_eq!(v["status"], "queue_full");
        assert_eq!(v["message"], "survey queue for this target is full");
        let back: ControlResponse = serde_json::from_str(&v.to_string()).unwrap();
        assert!(matches!(back, ControlResponse::QueueFull { .. }));
    }

    #[test]
    fn window_list_request_tag() {
        // The wire tag is `window_list` (a bare unit variant; no fields).
        // A Rust rename that drifts it breaks the server's decode with a
        // green build.
        let v: serde_json::Value = serde_json::to_value(ControlRequest::WindowList).unwrap();
        assert_eq!(v, serde_json::json!({"type": "window_list"}));
        let back: ControlRequest = serde_json::from_str(r#"{"type":"window_list"}"#).unwrap();
        assert!(matches!(back, ControlRequest::WindowList));
    }

    #[test]
    fn window_new_request_tag() {
        // Bare unit variant; the server derives the kind from the tenant.
        let v: serde_json::Value = serde_json::to_value(ControlRequest::WindowNew).unwrap();
        assert_eq!(v, serde_json::json!({"type": "window_new"}));
        let back: ControlRequest = serde_json::from_str(r#"{"type":"window_new"}"#).unwrap();
        assert!(matches!(back, ControlRequest::WindowNew));
    }

    #[test]
    fn window_open_request_tag_and_id() {
        let req = ControlRequest::WindowOpen {
            id: "terminal-win-2".into(),
        };
        let v: serde_json::Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["type"], "window_open");
        assert_eq!(v["id"], "terminal-win-2");
        let back: ControlRequest =
            serde_json::from_str(&serde_json::to_string(&req).unwrap()).unwrap();
        assert!(matches!(back, ControlRequest::WindowOpen { .. }));
    }

    #[test]
    fn open_graph_link_request_tag_window_id_and_link() {
        let req = ControlRequest::OpenGraphLink {
            window_id: "workspace-aa-0".into(),
            link: "chan://graph?s=dir%3Acrates%2Fchan-tunnel-proto%2Fsrc&m=s".into(),
            destination: None,
        };
        let v: serde_json::Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["type"], "open_graph_link");
        assert_eq!(v["window_id"], "workspace-aa-0");
        assert_eq!(
            v["link"],
            "chan://graph?s=dir%3Acrates%2Fchan-tunnel-proto%2Fsrc&m=s",
        );
        let back: ControlRequest =
            serde_json::from_str(&serde_json::to_string(&req).unwrap()).unwrap();
        assert!(matches!(back, ControlRequest::OpenGraphLink { .. }));
    }

    #[test]
    fn open_graph_wire_shape_stays_unchanged() {
        assert_eq!(
            serde_json::to_value(ControlRequest::OpenGraph {
                window_id: "workspace-aa-0".into(),
                path: None,
                destination: None,
            })
            .unwrap(),
            serde_json::json!({
                "type": "open_graph",
                "window_id": "workspace-aa-0"
            })
        );
        assert_eq!(
            serde_json::to_value(ControlRequest::OpenGraph {
                window_id: "workspace-aa-0".into(),
                path: Some("notes/a.md".into()),
                destination: None,
            })
            .unwrap(),
            serde_json::json!({
                "type": "open_graph",
                "window_id": "workspace-aa-0",
                "path": "notes/a.md"
            })
        );
    }

    #[test]
    fn tab_destination_omits_absent_axes_and_uses_lowercase_sides() {
        assert_eq!(
            serde_json::to_value(TabDestination {
                pane_id: Some("pane-2".into()),
                side: None,
            })
            .unwrap(),
            serde_json::json!({"pane_id": "pane-2"})
        );
        assert_eq!(
            serde_json::to_value(TabDestination {
                pane_id: None,
                side: Some(PaneSide::A),
            })
            .unwrap(),
            serde_json::json!({"side": "a"})
        );
        assert_eq!(
            serde_json::to_value(ControlRequest::OpenDashboard {
                window_id: "workspace-aa-0".into(),
                carousel_index: None,
                carousel_off: false,
                destination: Some(TabDestination {
                    pane_id: Some("pane-2".into()),
                    side: Some(PaneSide::B),
                }),
            })
            .unwrap(),
            serde_json::json!({
                "type": "open_dashboard",
                "window_id": "workspace-aa-0",
                "carousel_off": false,
                "destination": {
                    "pane_id": "pane-2",
                    "side": "b"
                }
            })
        );
    }

    #[test]
    fn close_request_tag_path_and_remove() {
        // Pin the `chan close` transport wire: tag `close`, the canonical
        // workspace `path`, and the `--remove` flag a HOST reads to also
        // unregister. A rename here would silently break `cmd_close` ↔ the
        // control-socket handler.
        let req = ControlRequest::Close {
            path: PathBuf::from("/home/u/notes"),
            remove: true,
        };
        let v: serde_json::Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["type"], "close");
        assert_eq!(v["path"], "/home/u/notes");
        assert_eq!(v["remove"], true);
        let back: ControlRequest =
            serde_json::from_str(&serde_json::to_string(&req).unwrap()).unwrap();
        assert!(matches!(back, ControlRequest::Close { remove: true, .. }));

        // `remove` defaults to false when omitted (a plain `chan close`).
        let back: ControlRequest = serde_json::from_str(r#"{"type":"close","path":"/x"}"#).unwrap();
        assert!(matches!(back, ControlRequest::Close { remove: false, .. }));
    }

    #[test]
    fn upload_request_tag_window_id_and_path() {
        // `cs upload`: wire tag `upload`, a window_id + the absolutized path
        // (the server relativizes it). A rename here would silently break
        // `cs upload` <-> the control-socket handler.
        let req = ControlRequest::Upload {
            window_id: "workspace-aa-0".into(),
            path: PathBuf::from("/home/u/notes/sub"),
        };
        let v: serde_json::Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["type"], "upload");
        assert_eq!(v["window_id"], "workspace-aa-0");
        assert_eq!(v["path"], "/home/u/notes/sub");
        let back: ControlRequest =
            serde_json::from_str(&serde_json::to_string(&req).unwrap()).unwrap();
        assert!(matches!(back, ControlRequest::Upload { .. }));
    }

    #[test]
    fn download_request_tag_window_id_and_path() {
        // `cs download`: wire tag `download`, a window_id + the absolutized
        // path. is_dir is NOT on this wire -- the server resolves it via stat
        // before pushing the window_command.
        let req = ControlRequest::Download {
            window_id: "workspace-aa-0".into(),
            path: PathBuf::from("/home/u/notes/file.md"),
        };
        let v: serde_json::Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["type"], "download");
        assert_eq!(v["window_id"], "workspace-aa-0");
        assert_eq!(v["path"], "/home/u/notes/file.md");
        assert!(
            v.get("is_dir").is_none(),
            "is_dir is server-resolved, not on the wire"
        );
        let back: ControlRequest =
            serde_json::from_str(&serde_json::to_string(&req).unwrap()).unwrap();
        assert!(matches!(back, ControlRequest::Download { .. }));
    }

    #[test]
    fn clipboard_copy_request_tag_and_fields() {
        // `cs copy`: wire tag `clipboard_copy`, the window_id, base64 stdin,
        // and an optional `mime` override (skipped when None). A rename here
        // would silently break `cs copy` <-> the control-socket handler.
        let req = ControlRequest::ClipboardCopy {
            window_id: "workspace-aa-0".into(),
            data_b64: "aGVsbG8=".into(),
            mime: Some("text/html".into()),
        };
        let v: serde_json::Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["type"], "clipboard_copy");
        assert_eq!(v["window_id"], "workspace-aa-0");
        assert_eq!(v["data_b64"], "aGVsbG8=");
        assert_eq!(v["mime"], "text/html");
        // mime None is skipped on the wire (the server sniffs instead).
        let sniffed = ControlRequest::ClipboardCopy {
            window_id: "w".into(),
            data_b64: "x".into(),
            mime: None,
        };
        let v: serde_json::Value = serde_json::to_value(&sniffed).unwrap();
        assert!(v.get("mime").is_none(), "None mime is skipped");
        let back: ControlRequest =
            serde_json::from_str(&serde_json::to_string(&req).unwrap()).unwrap();
        assert!(matches!(back, ControlRequest::ClipboardCopy { .. }));
    }

    #[test]
    fn clipboard_paste_request_tag_and_prefer() {
        // `cs paste`: wire tag `clipboard_paste`; `prefer` defaults to `auto`
        // (image-first) and decodes from the `--text`/`--html`/`--image`
        // overrides. The snake_case strings are the wire contract with the SPA.
        let req = ControlRequest::ClipboardPaste {
            window_id: "workspace-aa-0".into(),
            prefer: PastePrefer::Image,
        };
        let v: serde_json::Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["type"], "clipboard_paste");
        assert_eq!(v["window_id"], "workspace-aa-0");
        assert_eq!(v["prefer"], "image");
        // An omitted `prefer` decodes onto the Auto default.
        let back: ControlRequest =
            serde_json::from_str(r#"{"type":"clipboard_paste","window_id":"w"}"#).unwrap();
        assert!(matches!(
            back,
            ControlRequest::ClipboardPaste {
                prefer: PastePrefer::Auto,
                ..
            }
        ));
    }

    #[test]
    fn paste_prefer_wire_strings() {
        // The four selection strings are the wire contract; pin them so a
        // Rust rename cannot drift what the SPA matches on.
        for (variant, s) in [
            (PastePrefer::Auto, "auto"),
            (PastePrefer::Text, "text"),
            (PastePrefer::Html, "html"),
            (PastePrefer::Image, "image"),
        ] {
            assert_eq!(serde_json::to_value(variant).unwrap(), serde_json::json!(s));
        }
        assert_eq!(PastePrefer::default(), PastePrefer::Auto);
    }

    #[test]
    fn window_close_request_tag_id_and_force() {
        // `cs window rm`: wire tag `window_close`, `force` defaults false
        // and is omitted when false (matches the PaneOp force convention).
        let req = ControlRequest::WindowClose {
            id: "terminal-win-2".into(),
            force: false,
        };
        let v: serde_json::Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["type"], "window_close");
        assert_eq!(v["id"], "terminal-win-2");
        assert_eq!(v["force"], false);
        let forced = ControlRequest::WindowClose {
            id: "terminal-win-2".into(),
            force: true,
        };
        // Tolerates a missing `force` on decode (server-side default).
        let back: ControlRequest =
            serde_json::from_str(r#"{"type":"window_close","id":"terminal-win-2"}"#).unwrap();
        assert!(matches!(
            back,
            ControlRequest::WindowClose { force: false, .. }
        ));
        assert!(matches!(
            serde_json::from_str::<ControlRequest>(&serde_json::to_string(&forced).unwrap())
                .unwrap(),
            ControlRequest::WindowClose { force: true, .. }
        ));
    }

    #[test]
    fn window_hide_request_tag_and_id() {
        let req = ControlRequest::WindowHide {
            id: "workspace-aa-0".into(),
        };
        let v: serde_json::Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["type"], "window_hide");
        assert_eq!(v["id"], "workspace-aa-0");
        let back: ControlRequest =
            serde_json::from_str(&serde_json::to_string(&req).unwrap()).unwrap();
        assert!(matches!(back, ControlRequest::WindowHide { .. }));
    }

    #[test]
    fn session_list_request_tag() {
        let v: serde_json::Value = serde_json::to_value(ControlRequest::SessionList).unwrap();
        assert_eq!(v["type"], "session_list");
    }

    #[test]
    fn session_self_request_tag_window_id_and_name() {
        let req = ControlRequest::SessionSelf {
            window_id: "w-abc".into(),
            name: Some("alice".into()),
            reset: false,
        };
        let v: serde_json::Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["type"], "session_self");
        assert_eq!(v["window_id"], "w-abc");
        assert_eq!(v["name"], "alice");
        // A rename without `reset` (an older client's shape) decodes, and a
        // reset omits `name`.
        let back: ControlRequest =
            serde_json::from_str(r#"{"type":"session_self","window_id":"w","name":"n"}"#).unwrap();
        assert!(matches!(
            back,
            ControlRequest::SessionSelf {
                name: Some(_),
                reset: false,
                ..
            }
        ));
        let back: ControlRequest =
            serde_json::from_str(r#"{"type":"session_self","window_id":"w","reset":true}"#)
                .unwrap();
        assert!(matches!(
            back,
            ControlRequest::SessionSelf {
                name: None,
                reset: true,
                ..
            }
        ));
    }

    #[test]
    fn session_self_bare_query_shape_round_trips() {
        // The bare whoami query keeps the `session_self` tag and omits `name`
        // entirely (skip_serializing_if); `reset` serializes as false.
        let req = ControlRequest::SessionSelf {
            window_id: "w".into(),
            name: None,
            reset: false,
        };
        let v: serde_json::Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["type"], "session_self");
        assert!(v.get("name").is_none());
        // A minimal `{type, window_id}` line decodes to the query shape (the
        // serde-default tolerance the server relies on).
        let back: ControlRequest =
            serde_json::from_str(r#"{"type":"session_self","window_id":"w"}"#).unwrap();
        assert!(matches!(
            back,
            ControlRequest::SessionSelf {
                name: None,
                reset: false,
                ..
            }
        ));
    }

    #[test]
    fn session_handover_request_tag_and_optional_fields() {
        // `to` is skipped when None; accept/reject/timeout_secs default and a
        // minimal `{type, window_id}` decodes (the server's path).
        let req = ControlRequest::SessionHandover {
            window_id: "w-abc".into(),
            to: None,
            accept: false,
            reject: false,
            timeout_secs: 30,
        };
        let v: serde_json::Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["type"], "session_handover");
        assert_eq!(v["window_id"], "w-abc");
        assert!(v.get("to").is_none());
        assert_eq!(v["timeout_secs"], 30);
        let back: ControlRequest =
            serde_json::from_str(r#"{"type":"session_handover","window_id":"w-abc"}"#).unwrap();
        assert!(matches!(
            back,
            ControlRequest::SessionHandover {
                accept: false,
                reject: false,
                timeout_secs: 0,
                ..
            }
        ));
    }

    #[test]
    fn session_takeover_request_tag_and_force() {
        let req = ControlRequest::SessionTakeover {
            window_id: "w-abc".into(),
            force: false,
        };
        let v: serde_json::Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["type"], "session_takeover");
        assert_eq!(v["window_id"], "w-abc");
        assert_eq!(v["force"], false);
        let back: ControlRequest =
            serde_json::from_str(r#"{"type":"session_takeover","window_id":"w-abc","force":true}"#)
                .unwrap();
        assert!(matches!(
            back,
            ControlRequest::SessionTakeover { force: true, .. }
        ));
    }

    #[test]
    fn term_scrollback_request_tag_and_field() {
        // The wire tag is `term_scrollback` and `tab_name` is a plain
        // required string (no group axis, no skip). A Rust rename that
        // drifts either breaks the server's decode with a green build.
        let req = ControlRequest::TermScrollback {
            tab_name: "@@Alice".into(),
        };
        let v: serde_json::Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["type"], "term_scrollback");
        assert_eq!(v["tab_name"], "@@Alice");
        // Decodes back into the same variant (the server's path).
        let raw = serde_json::to_string(&req).unwrap();
        let back: ControlRequest = serde_json::from_str(&raw).unwrap();
        assert!(matches!(back, ControlRequest::TermScrollback { .. }));
    }

    #[test]
    fn term_close_request_tag_and_fields() {
        // Wire tag `term_close`; both selectors optional + skipped when None
        // (same shape as `term_restart`). A Rust rename that drifts the tag or
        // a field breaks the server's decode with a green build.
        let req = ControlRequest::TermClose {
            tab_name: Some("@@Alice".into()),
            tab_group: None,
        };
        let v: serde_json::Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["type"], "term_close");
        assert_eq!(v["tab_name"], "@@Alice");
        assert!(v.get("tab_group").is_none());
        // Decodes back into the same variant (the server's path).
        let raw = serde_json::to_string(&req).unwrap();
        let back: ControlRequest = serde_json::from_str(&raw).unwrap();
        assert!(matches!(back, ControlRequest::TermClose { .. }));
    }

    #[test]
    fn pane_query_request_tag_and_target() {
        // Wire tag `pane_query`; the target is window_id XOR tab_name (both
        // optional + skipped when None). A Rust rename that drifts either
        // breaks the server's decode with a green build.
        let by_window = ControlRequest::PaneQuery {
            window_id: Some("window-a".into()),
            tab_name: None,
        };
        let v: serde_json::Value = serde_json::to_value(&by_window).unwrap();
        assert_eq!(v["type"], "pane_query");
        assert_eq!(v["window_id"], "window-a");
        assert!(v.get("tab_name").is_none(), "None tab_name is skipped");
        let raw = serde_json::to_string(&by_window).unwrap();
        let back: ControlRequest = serde_json::from_str(&raw).unwrap();
        assert!(matches!(back, ControlRequest::PaneQuery { .. }));

        let by_tab = ControlRequest::PaneQuery {
            window_id: None,
            tab_name: Some("@@Alice".into()),
        };
        let v: serde_json::Value = serde_json::to_value(&by_tab).unwrap();
        assert_eq!(v["tab_name"], "@@Alice");
        assert!(v.get("window_id").is_none(), "None window_id is skipped");
    }

    #[test]
    fn pane_exec_request_tag_and_op_kind() {
        // `pane_exec` carries a `tab_name`/`window_id` target plus the op,
        // which is internally tagged on `kind` and nests under `op`.
        let req = ControlRequest::PaneExec {
            window_id: None,
            tab_name: Some("@@Alice".into()),
            op: PaneOp::Split {
                pane_id: Some("pane-1".into()),
                dir: SplitDir::Bottom,
            },
        };
        let v: serde_json::Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["type"], "pane_exec");
        assert_eq!(v["tab_name"], "@@Alice");
        assert_eq!(v["op"]["kind"], "split");
        assert_eq!(v["op"]["pane_id"], "pane-1");
        assert_eq!(v["op"]["dir"], "bottom");
        // Round-trips into the same variant (the server's decode path).
        let raw = serde_json::to_string(&req).unwrap();
        let back: ControlRequest = serde_json::from_str(&raw).unwrap();
        assert!(matches!(
            back,
            ControlRequest::PaneExec {
                op: PaneOp::Split { .. },
                ..
            }
        ));
    }

    #[test]
    fn pane_op_close_variants_carry_force() {
        // close_tab / close_pane / close_all all carry `force`; `force:false`
        // is emitted (default) so the SPA always reads a boolean.
        let v: serde_json::Value = serde_json::to_value(&PaneOp::CloseAll { force: true }).unwrap();
        assert_eq!(v["kind"], "close_all");
        assert_eq!(v["force"], true);
        let v: serde_json::Value = serde_json::to_value(&PaneOp::CloseTab {
            pane_id: None,
            tab_id: None,
            force: false,
        })
        .unwrap();
        assert_eq!(v["kind"], "close_tab");
        assert_eq!(v["force"], false);
    }

    #[test]
    fn terminal_team_request_tag_and_op_strings() {
        // `new` carries the config TOML; the wire tag is `terminal_team`
        // and the op is the snake_case subcommand name.
        let req = ControlRequest::TerminalTeam {
            dir: "new-team-1".into(),
            op: TeamOp::New,
            config_toml: Some("team_name = \"alpha\"\n".into()),
            brief_content: Some("# Brief\n\nRepro first.".into()),
            script: true,
            window_id: Some("window-a".into()),
            destination: Some(TabDestination {
                pane_id: Some("pane-2".into()),
                side: Some(PaneSide::B),
            }),
        };
        let v: serde_json::Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["type"], "terminal_team");
        assert_eq!(v["dir"], "new-team-1");
        assert_eq!(v["op"], "new");
        assert_eq!(v["config_toml"], "team_name = \"alpha\"\n");
        assert_eq!(v["brief_content"], "# Brief\n\nRepro first.");
        assert_eq!(v["script"], true);
        assert_eq!(v["window_id"], "window-a");
        assert_eq!(v["destination"]["pane_id"], "pane-2");
        assert_eq!(v["destination"]["side"], "b");

        // `load` omits config_toml + brief_content + window_id
        // (skip_serializing_if) and defaults script to false.
        let load = ControlRequest::TerminalTeam {
            dir: "teams/alpha".into(),
            op: TeamOp::Load,
            config_toml: None,
            brief_content: None,
            script: false,
            window_id: None,
            destination: None,
        };
        let v: serde_json::Value = serde_json::to_value(&load).unwrap();
        assert_eq!(v["op"], "load");
        assert!(
            v.get("config_toml").is_none(),
            "None config_toml is skipped"
        );
        assert!(
            v.get("brief_content").is_none(),
            "None brief_content is skipped"
        );
        assert!(v.get("window_id").is_none(), "None window_id is skipped");
        assert_eq!(v["script"], false);

        // Round-trips back into the same variant (the server's decode path).
        let raw = serde_json::to_string(&load).unwrap();
        let back: ControlRequest = serde_json::from_str(&raw).unwrap();
        assert!(matches!(
            back,
            ControlRequest::TerminalTeam {
                op: TeamOp::Load,
                ..
            }
        ));
    }

    #[test]
    fn workspace_search_request_uses_the_shared_core_shape() {
        let request = ControlRequest::WorkspaceSearch {
            request: chan_workspace::WorkspaceSearchRequest {
                query: Some("needle".into()),
                domains: vec![chan_workspace::WorkspaceSearchDomain::Content],
                ..chan_workspace::WorkspaceSearchRequest::default()
            },
        };
        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["type"], "workspace_search");
        assert_eq!(value["request"]["query"], "needle");
        assert_eq!(value["request"]["domains"], serde_json::json!(["content"]));
        assert!(matches!(
            serde_json::from_value::<ControlRequest>(value).unwrap(),
            ControlRequest::WorkspaceSearch { .. }
        ));
    }

    #[test]
    fn identify_request_and_identity_reply_wire() {
        // The request is a bare tagged unit; `chan ps` and the chan-server
        // handler must agree on the exact bytes.
        let v = serde_json::to_value(&ControlRequest::Identify).unwrap();
        assert_eq!(v, serde_json::json!({ "type": "identify" }));
        assert!(matches!(
            serde_json::from_str::<ControlRequest>(r#"{"type":"identify"}"#).unwrap(),
            ControlRequest::Identify
        ));

        // The reply payload (JSON in Ok.message): kind serializes to the
        // `standalone`/`desktop`/`devserver` strings `chan ps` shows, and pid
        // is the serving process the stable-socket discovery matches on.
        let id = Identity {
            kind: ServeKind::Devserver,
            version: "0.40.0".into(),
            pid: 4242,
            workspace_root: Some("/work/notes".into()),
            metadata_key: Some("notes-00112233".into()),
        };
        let v = serde_json::to_value(&id).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "kind": "devserver",
                "version": "0.40.0",
                "pid": 4242,
                "workspace_root": "/work/notes",
                "metadata_key": "notes-00112233"
            })
        );
        assert_eq!(id, serde_json::from_value(v).unwrap());
        let legacy: Identity = serde_json::from_value(serde_json::json!({
            "kind": "standalone",
            "version": "0.40.0",
            "pid": 7
        }))
        .unwrap();
        assert_eq!(legacy.workspace_root, None);
        assert_eq!(legacy.metadata_key, None);
        assert_eq!(
            serde_json::to_value(ServeKind::Standalone).unwrap(),
            serde_json::json!("standalone")
        );
        assert_eq!(
            serde_json::to_value(ServeKind::Desktop).unwrap(),
            serde_json::json!("desktop")
        );
    }

    #[test]
    fn export_request_and_response_wire_shapes() {
        // `cs export` request: `out` omitted when None (the server resolves
        // the default before dispatch), present when the caller chose one.
        let v = serde_json::to_value(ControlRequest::Export {
            path: "notes/doc.md".into(),
            format: "pdf".into(),
            out: None,
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "type": "export", "path": "notes/doc.md", "format": "pdf" })
        );
        let v = serde_json::to_value(ControlRequest::Export {
            path: "notes/doc.md".into(),
            format: "pdf".into(),
            out: Some("out/render.pdf".into()),
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "type": "export",
                "path": "notes/doc.md",
                "format": "pdf",
                "out": "out/render.pdf",
            })
        );
        // Decode tolerates an omitted `out`.
        assert!(matches!(
            serde_json::from_str::<ControlRequest>(
                r#"{"type":"export","path":"a.md","format":"pdf"}"#
            )
            .unwrap(),
            ControlRequest::Export { out: None, .. }
        ));

        // The dedicated success response: `status: export` + `out_path`.
        let v = serde_json::to_value(ControlResponse::Export {
            out_path: "notes/doc.pdf".into(),
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "status": "export", "out_path": "notes/doc.pdf" })
        );
    }
}

/// The single-line reply the server writes back on the control socket.
/// The internal `status` tag is the wire format; the client matches on it.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ControlResponse {
    Ok {
        message: String,
    },
    Error {
        message: String,
    },
    /// A `cs terminal write --submit` was queued, but at least one selected
    /// shell session had no server-derived agent and therefore received no
    /// submit chord. Distinct from `Ok` so the client can preserve the
    /// acknowledgement while exiting 69, without inferring the refusal from
    /// human-readable prose.
    SubmitRefused {
        message: String,
    },
    /// A blocking request the server abandoned because its reply window
    /// elapsed (a `cs terminal survey --timeout`, or a `cs copy` / `cs
    /// paste` clipboard round-trip nothing replied to). Distinct from
    /// `Error` so the client can map it to a dedicated exit code (124)
    /// instead of the generic failure path, and never has to infer a timeout
    /// from a dropped connection. `message` is the elapsed-window line the
    /// CLI prints (e.g. `no reply within 600s`).
    Timeout {
        message: String,
    },
    /// A blocking request the server refused OUTRIGHT because the queue that
    /// serializes it is at capacity (today only `cs terminal survey`, whose
    /// per-target FIFO holds the open survey plus the waiters). Distinct
    /// from `Error` on the wire so the refusal is explicit (nothing was
    /// delivered and nothing waits server-side) and never a silent drop.
    /// `message` is the queue-full line the CLI prints.
    QueueFull {
        message: String,
    },
    /// `cs export`'s success: the final workspace-relative output path the
    /// renderer wrote. A dedicated variant (not JSON in `Ok.message`)
    /// because the path is the whole result and the CLI prints it verbatim.
    Export {
        out_path: String,
    },
}

/// What kind of process serves a workspace, for `chan ps`. A `serve` standalone,
/// a chan-desktop, or a headless devserver. Serializes to `standalone` /
/// `desktop` / `devserver`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServeKind {
    Standalone,
    Desktop,
    Devserver,
}

/// Reply payload for [`ControlRequest::Identify`], JSON-encoded into the
/// `Ok.message` of a [`ControlResponse`] (the convention for structured control
/// replies). `version` is the server's `CARGO_PKG_VERSION`. `pid` is the
/// serving process: a devserver's stable-named control sockets carry no pid in
/// their filename, so `chan ps` / `chan close` resolve a lock-record holder to
/// its socket by asking each stable-named candidate who it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identity {
    pub kind: ServeKind,
    pub version: String,
    pub pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata_key: Option<String>,
}
