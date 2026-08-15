//! Bridge from the control socket to chan-desktop's window manager.
//!
//! `cs window list` reads server-side state, but spawning, focusing,
//! closing, hiding, and renaming OS windows are desktop operations: they
//! need the Tauri `AppHandle`, which only the desktop process owns. The
//! embedded server runs in that same process but is handed no
//! `AppHandle` (and chan-server must stay Tauri-free so `chan open`
//! builds standalone). So the desktop installs a [`DesktopBridge`]: an
//! mpsc channel the control socket sends [`DesktopWindowOp`]s down, plus
//! the shared title map (see [`crate::window_titles`]). Each op carries a
//! `oneshot` the desktop completes, so the control handler can `await` a
//! result exactly like the existing window-bus round-trips -- but without
//! bouncing through the SPA.
//!
//! In standalone `chan open` the channel is absent ([`DesktopBridge`]'s
//! `window_ops` is `None`); every lifecycle op then refuses with
//! [`NO_DESKTOP`]. The `None` *is* the "no desktop attached" invariant,
//! encoded in the type rather than a runtime flag.

use tokio::sync::{mpsc, oneshot};

use crate::window_titles::SharedWindowTitles;

/// Which kind of window `cs window new` spawns. The control socket fills
/// this in from the CALLER, so the CLI never has to name the kind: a
/// workspace tenant spawns another window of that workspace, and a terminal
/// tenant spawns whichever app the calling window (`$CHAN_WINDOW_ID`) runs --
/// [`Files`](Self::Files) from a Files window, [`Terminal`](Self::Terminal)
/// otherwise, since both ride the same shared terminal tenant.
#[derive(Debug)]
pub enum NewWindowKind {
    /// A standalone terminal window (the shared `/terminal` tenant).
    Terminal,
    /// A standalone Files window (the same shared tenant, files app).
    Files,
    /// Another window of the workspace rooted at `key` (its canonical
    /// path), which the desktop matches against its running workspaces.
    Workspace { key: String },
}

/// Outcome of a [`DesktopWindowOp::SetDevserverWorkspaceOn`] request. An `on`
/// request, or a forced off, always resolves to [`Done`](Self::Done); an UNforced
/// off of a workspace with live terminal sessions resolves to
/// [`NeedsForce`](Self::NeedsForce) so the launcher can confirm-then-force.
///
/// Richer than the plain `Result<(), String>` the other ops reply with: the live
/// terminal COUNT has to round-trip the bridge so the launcher shows it in the
/// confirm prompt and retries with `force: true` -- parity with the local/remote
/// workspace-off confirm flow.
#[derive(Debug)]
pub enum SetWorkspaceOnOutcome {
    /// The mount state was set (on, off, or a forced off).
    Done,
    /// An unforced off was refused: `active_terminals` live terminal sessions
    /// would be killed. The launcher confirms, then retries with `force: true`.
    NeedsForce { active_terminals: usize },
}

/// A window-management request the control socket hands to the desktop.
/// Each carries a `oneshot` the desktop completes with `Ok(..)`/`Err(msg)`.
#[derive(Debug)]
pub enum DesktopWindowOp {
    /// Spawn a new window; the reply carries its new id (Tauri label).
    New {
        kind: NewWindowKind,
        reply: oneshot::Sender<Result<String, String>>,
    },
    /// Focus a live window or un-hide a buried one; best-effort reopen a
    /// closed-but-saved workspace window when its workspace is running.
    Open {
        id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Persist user text appended to one non-control window's generated label.
    /// The library route handles local rows directly; this bridge arm forwards
    /// rows owned by a connected devserver to that server's registry.
    SetWindowLabel {
        id: String,
        label: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Destroy a window (and let the server drop its saved layout). With
    /// live terminal shells and `force` unset, the desktop raises a
    /// confirmation dialog and this op BLOCKS until the user answers; the
    /// reply is `Ok(true)` (destroyed), `Ok(false)` (no live window
    /// found), or `Err("cancelled")` (user declined).
    Close {
        id: String,
        force: bool,
        reply: oneshot::Sender<Result<bool, String>>,
    },
    /// Bury (hide) a window -- the OS close-button behaviour.
    Hide {
        id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Connect a registered devserver by id: run its connect command in a
    /// control terminal, scrape the token, dial the URL, and open its
    /// window. The launcher's Connect button drives this over the bridge;
    /// the reply is `Ok(())` once the connect flow is under way (or the
    /// error string when it fails). Inert without a desktop attached -- the
    /// route then answers [`NO_DESKTOP`], like the other window ops.
    ConnectDevserver {
        id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Disconnect a connected devserver by id: drop the live connection and its
    /// windows, returning it to the registered-but-offline state. The launcher's
    /// Disconnect button drives this over the bridge; the reply is `Ok(())` once
    /// torn down. Inert without a desktop attached -- the route then answers
    /// [`NO_DESKTOP`], like the other devserver ops.
    DisconnectDevserver {
        id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Persist native-IPC consent for one current shared gateway roster row.
    /// The desktop validates the synthesized id against its authenticated
    /// roster; plain and owned rows refuse the operation.
    GrantDevserverNativeTrust {
        id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Revoke native-IPC consent for one current shared gateway roster row,
    /// tearing down its connection and windows before replying.
    RevokeDevserverNativeTrust {
        id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Open a fresh standalone-terminal window on a connected devserver by id.
    /// The launcher's per-devserver New-Terminal button drives this; the reply is
    /// `Ok(())` once the window is spawning. Inert without a desktop attached  --
    /// the route then answers [`NO_DESKTOP`].
    OpenDevserverTerminal {
        id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Open (or focus) a workspace window on a connected devserver by id, rooted
    /// at the remote workspace `path`. The launcher's devserver-workspace Open
    /// button drives this; the reply is `Ok(())` once the window is spawning.
    /// Inert without a desktop attached -- the route then answers [`NO_DESKTOP`].
    OpenDevserverWorkspace {
        id: String,
        path: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Turn a connected devserver's workspace on or off, keyed by `(id, prefix)`
    /// (the remote mount prefix). The launcher's devserver-workspace on/off toggle
    /// drives this. `force` is consulted only for an off: an unforced off of a
    /// workspace with live terminals replies [`SetWorkspaceOnOutcome::NeedsForce`]
    /// (carrying the count) so the launcher confirms-then-retries with
    /// `force: true`; an on, or a forced off, replies
    /// [`SetWorkspaceOnOutcome::Done`]. Inert without a desktop attached -- the
    /// route then answers [`NO_DESKTOP`].
    SetDevserverWorkspaceOn {
        id: String,
        prefix: String,
        on: bool,
        force: bool,
        reply: oneshot::Sender<Result<SetWorkspaceOnOutcome, String>>,
    },
    /// Forget (unregister) a connected devserver's workspace, keyed by
    /// `(id, prefix)`. The launcher's devserver-workspace Remove button drives
    /// this; the reply is `Ok(())` once the remote registry drops it. Inert
    /// without a desktop attached -- the route then answers [`NO_DESKTOP`].
    ForgetDevserverWorkspace {
        id: String,
        prefix: String,
        force: bool,
        reply: oneshot::Sender<Result<SetWorkspaceOnOutcome, String>>,
    },
    /// Connect a configured gateway by id: discover it, hand off to the
    /// browser sign-in when no account credential is stored, fetch the
    /// devserver roster, and start its poll. The Gateways screen's Connect
    /// button drives this over the bridge; the reply is `Ok(())` once the
    /// connect flow settles (or the error string). Inert without a desktop
    /// attached -- the route then answers [`NO_DESKTOP`].
    ConnectGateway {
        id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Disconnect a connected gateway by id: stop its roster poll, tear
    /// down its rostered devserver connections, drop its synthesized rows,
    /// and persist the disabled intent. The Gateways screen's Disconnect
    /// button drives this over the bridge; the reply is `Ok(())` once torn
    /// down. Inert without a desktop attached -- the route then answers
    /// [`NO_DESKTOP`].
    DisconnectGateway {
        id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Open the OS native folder-picker dialog and return the chosen
    /// directory, or `None` when the user cancels. The launcher's
    /// New-Workspace dialog drives this over the bridge so the Folder field
    /// gets a real "Browse…" affordance instead of typing an absolute path.
    /// Inert without a desktop attached -- the route then answers
    /// [`NO_DESKTOP`], so a plain browser keeps the text-entry fallback.
    PickFolder {
        reply: oneshot::Sender<Result<Option<String>, String>>,
    },
}

/// Pinned refusal when no desktop is attached (standalone serve / browser).
pub const NO_DESKTOP: &str = "window management requires the chan desktop app";

/// The sender the control socket holds. Bounded so a runaway caller can't
/// grow the queue unbounded; 32 is far above any realistic concurrency of
/// interactive `cs window` calls.
pub type DesktopWindowSender = mpsc::Sender<DesktopWindowOp>;

/// Desktop integration handed to the embedded server. `window_ops` is
/// `None` in standalone mode (lifecycle ops refuse); `window_titles` is
/// always present (empty when no desktop writes to it).
#[derive(Clone, Default)]
pub struct DesktopBridge {
    pub window_ops: Option<DesktopWindowSender>,
    pub window_titles: SharedWindowTitles,
}

impl DesktopBridge {
    /// Send an op and await its reply, mapping the channel-closed / sender
    /// failures to a user-facing string. `None` (standalone) → [`NO_DESKTOP`].
    /// Returns `Err` when no desktop is attached or the manager is gone.
    pub async fn dispatch<T>(
        &self,
        make_op: impl FnOnce(oneshot::Sender<Result<T, String>>) -> DesktopWindowOp,
    ) -> Result<T, String> {
        let Some(sender) = self.window_ops.as_ref() else {
            return Err(NO_DESKTOP.to_string());
        };
        let (reply_tx, reply_rx) = oneshot::channel();
        sender
            .send(make_op(reply_tx))
            .await
            .map_err(|_| "desktop window manager unavailable".to_string())?;
        reply_rx
            .await
            .map_err(|_| "desktop window manager dropped the request".to_string())?
    }
}
