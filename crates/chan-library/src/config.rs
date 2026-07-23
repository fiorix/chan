//! Terminal-session tuning carried with the registry.
//!
//! `TerminalConfig` is the terminal subsystem's own configuration: the
//! registry (`terminal_sessions`) reads it for idle pruning, the session
//! cap, the replay-ring budget, and the spawn-time TERM / font / MCP-env
//! defaults. `chan-server` embeds it in its on-disk `ServerConfig`, loads
//! and range-clamps it in the settings route, and surfaces it over
//! `/api/config`; the wire shape lives here so the registry and the route
//! layer agree on one definition.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalConfig {
    #[serde(default = "default_terminal_idle_timeout_secs")]
    pub idle_timeout_secs: u64,
    #[serde(default = "default_terminal_session_cap")]
    pub session_cap: usize,
    #[serde(default = "default_terminal_ring_bytes")]
    pub ring_bytes: usize,
    /// Per-terminal scrollback budget in MB. Consumed by the SPA at
    /// xterm.js construction time to compute the scrollback line cap;
    /// the server only persists + range-clamps the value. Spawn-time-
    /// only: existing terminals keep their current scrollback until
    /// the session restarts.
    #[serde(default = "default_terminal_scrollback_mb")]
    pub scrollback_mb: u32,
    /// Default TERM value handed to newly-spawned PTYs. The SPA
    /// surfaces a dropdown of common values plus a free-text "Custom"
    /// path for exotic terminfo entries. Spawn-time-only: existing
    /// terminals keep their original TERM until restart.
    #[serde(default = "default_terminal_default_term")]
    pub default_term: String,
    /// User's terminal-font preference.
    /// Default is `os-default` (per-OS native mono -- SF Mono on
    /// macOS, Cascadia on Windows, DejaVu on Linux). Opt-in
    /// `source-code-pro` activates Source Code Pro by reordering
    /// xterm.js's fontFamily chain to put SCP first. Selecting SCP
    /// on a non-embed-font build triggers the SettingsPanel's
    /// download flow before the activation completes.
    #[serde(default)]
    pub font: TerminalFontChoice,
    /// The non-team default for whether a newly-spawned terminal
    /// gets the chan MCP discovery env vars (`CHAN_MCP_*`). Off by
    /// default for ALL agents (a stray env descriptor makes codex fail
    /// to start; it wants a file-based config). Plain `cs terminal new`
    /// / server-spawned terminals consult this; the per-request
    /// `?mcp_env=on` query still overrides it, and team spawns use the
    /// team config's own `mcp_env` toggle instead.
    #[serde(default)]
    pub mcp_env: bool,
    /// Whether full-screen TUIs may capture the mouse. Consumed by the
    /// SPA at terminal start time; the server only persists the value.
    /// On by default (today's behavior: mouse-reporting programs own
    /// the pointer). When off the SPA strips the mouse-enable escape
    /// sequences so click-drag keeps selecting text over such programs.
    /// Applies to newly opened terminals.
    #[serde(default = "default_terminal_mouse_capture")]
    pub mouse_capture: bool,
}

/// Terminal-font preference. Wire shape kept narrow (string enum)
/// so a future polish task could add a "Custom..." path without
/// breaking existing config files.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalFontChoice {
    /// Per-OS native mono. The lean default.
    #[default]
    OsDefault,
    /// Source Code Pro Regular. Available either via `--features
    /// embed-font` (rust-embed bundle) or via the user-config-dir
    /// path written by the font download flow.
    SourceCodePro,
}

impl Default for TerminalConfig {
    fn default() -> Self {
        Self {
            idle_timeout_secs: default_terminal_idle_timeout_secs(),
            session_cap: default_terminal_session_cap(),
            ring_bytes: default_terminal_ring_bytes(),
            scrollback_mb: default_terminal_scrollback_mb(),
            default_term: default_terminal_default_term(),
            font: TerminalFontChoice::default(),
            mcp_env: false,
            mouse_capture: default_terminal_mouse_capture(),
        }
    }
}

fn default_terminal_idle_timeout_secs() -> u64 {
    30 * 60
}

fn default_terminal_session_cap() -> usize {
    32
}

fn default_terminal_ring_bytes() -> usize {
    2 << 20
}

fn default_terminal_scrollback_mb() -> u32 {
    10
}

fn default_terminal_default_term() -> String {
    "xterm-256color".into()
}

fn default_terminal_mouse_capture() -> bool {
    true
}

/// Inclusive bounds the Settings UI exposes for the scrollback slider.
/// Mirrored in `web/packages/workspace-app/src/terminal/scrollback.ts`; keep in lockstep.
pub const TERMINAL_SCROLLBACK_MB_MIN: u32 = 10;
pub const TERMINAL_SCROLLBACK_MB_MAX: u32 = 50;
