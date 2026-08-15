//! The chan library: the authoritative window / terminal / workspace
//! lifecycle.
//!
//! This crate is the source of truth a chan deployment owns -- the
//! per-library standalone terminals and the persisted window/terminal
//! lifecycle. Clients (native desktop windows, browser tabs, `cs`) are views
//! that reconcile to its state; `chan-server` is the HTTP route layer over it.
//!
//! It houses the terminal-session registry plus the terminal config and
//! unix-time helpers the registry needs; `chan-server`'s route layer
//! re-exports them so its handlers reach them unqualified.

#![forbid(unsafe_code)]

pub mod config;
pub mod desktop_window_ops;
pub mod devserver_registry;
pub mod error;
pub mod gateway_registry;
pub mod host;
pub mod participant_names;
pub mod pending_window_commands;
pub mod prefix;
pub mod serve_config;
pub mod session_presence;
pub mod tenant;
pub mod terminal_sessions;
pub mod time;
pub mod window_presence;
pub mod window_titles;
pub mod window_transfers;
pub mod windows;
pub mod workspace_persist;

pub use config::{
    TerminalConfig, TerminalFontChoice, TerminalProfile, TERMINAL_FONT_SIZE_MAX,
    TERMINAL_FONT_SIZE_MIN, TERMINAL_PROFILE_MAX, TERMINAL_SCROLLBACK_MB_MAX,
    TERMINAL_SCROLLBACK_MB_MIN, TERMINAL_SECRET_MASK_SUFFIX_MAX,
};
pub use devserver_registry::{DevserverEntry, DevserverInput, DevserverRegistry, DevserverStatus};
pub use error::Error;
pub use gateway_registry::{GatewayEntry, GatewayInput, GatewayRegistry, GatewayStatus};
pub use host::{
    CollapsedMachinesStore, DevserverFeedSource, HostedWorkspace, LauncherWorkspace,
    LocalColorStore, LocalThemeStore, WorkspaceHost, WorkspaceLifecycleOutcome, WorkspaceStatus,
};
pub use prefix::{allocate_workspace_prefix, workspace_slug};
pub use serve_config::{sanitize_prefix, ServeConfig, ServeHandle};
pub use tenant::{
    BrowserWindowTarget, HostControl, OpenOutsideAck, StandaloneFiles, StandaloneOpenFrame,
    TenantArtifacts, TenantBuilder, TenantTaskOwner, UnserveMode, UnserveScope,
    WorkspaceCellHandle,
};
pub use terminal_sessions::shell_profiles::{ProfileSource, ShellKind, ShellProfile};
/// The single-sourced shell resolver (`$SHELL` → passwd → `/bin/sh`); unix-only.
/// Re-exported at the crate root so callers say `chan_library::user_shell()`.
#[cfg(unix)]
pub use terminal_sessions::user_shell;
pub use workspace_persist::{FileLocalColor, PersistedWorkspace, WorkspaceOverlay};
