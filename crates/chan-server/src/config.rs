//! chan-server preferences.
//!
//! Persisted at `<config>/chan/server.toml` (sibling of
//! `<config>/chan/preferences.toml`). Holds chan-server-specific
//! paths and toggles that aren't user content (those live in the
//! workspace).
//!
//! Today: `attachments_dir`, a workspace-relative POSIX path; the actual
//! file I/O routes through `chan_workspace::Workspace::write_bytes` so the
//! path sandbox + special-file refusal + atomic-write invariants
//! apply.
//!
//! New fields land here when a route surfaces a server-shaped
//! setting (e.g. a future "open-in-browser on launch" toggle).
//! Anything filesystem-shaped on the workspace itself stays in chan-workspace.

use std::path::{Path, PathBuf};

use chan_workspace::SearchAggression;
use serde::{Deserialize, Serialize};

use crate::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerConfig {
    /// Workspace-relative directory where /api/attachments uploads
    /// land. Default `"attachments"` (a sibling of the user's
    /// notes). The frontend renders the configured value;
    /// callers can pass a sub-path (`"media/2026"`) and it'll
    /// be sandboxed under the workspace root via Workspace::write_bytes.
    #[serde(default = "default_attachments_dir")]
    pub attachments_dir: String,
    #[serde(default)]
    pub search: SearchConfig,
    #[serde(default)]
    pub terminal: TerminalConfig,
    #[serde(default)]
    pub team_work: TeamWorkConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchConfig {
    #[serde(default)]
    pub aggression: SearchAggression,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TeamWorkConfig {
    #[serde(default = "default_team_work_inbox_depth")]
    pub inbox_depth: usize,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self {
            aggression: SearchAggression::Balanced,
        }
    }
}

impl Default for TeamWorkConfig {
    fn default() -> Self {
        Self {
            inbox_depth: default_team_work_inbox_depth(),
        }
    }
}

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
    /// `fullstack-b-30` slice b: user's terminal-font preference.
    /// Default is `os-default` (per-OS native mono — SF Mono on
    /// macOS, Cascadia on Windows, DejaVu on Linux). Opt-in
    /// `source-code-pro` activates Source Code Pro by reordering
    /// xterm.js's fontFamily chain to put SCP first. Selecting SCP
    /// on a non-embed-font build triggers the SettingsPanel's
    /// download flow before the activation completes.
    #[serde(default)]
    pub font: TerminalFontChoice,
}

/// `fullstack-b-30` slice b: terminal-font preference. Wire shape
/// kept narrow (string enum) so a future polish task could add a
/// "Custom..." path without breaking existing config files.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalFontChoice {
    /// Per-OS native mono. Lean-default baseline from slice a.
    #[default]
    OsDefault,
    /// Source Code Pro Regular. Available either via `--features
    /// embed-font` (rust-embed bundle) or via the user-config-dir
    /// path written by the slice b download flow.
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
    1 << 20
}

fn default_terminal_scrollback_mb() -> u32 {
    50
}

fn default_terminal_default_term() -> String {
    "xterm-256color".into()
}

fn default_team_work_inbox_depth() -> usize {
    10
}

pub const TEAM_WORK_INBOX_DEPTH_MIN: usize = 1;
pub const TEAM_WORK_INBOX_DEPTH_MAX: usize = 100;

/// Inclusive bounds the Settings UI exposes for the scrollback slider.
/// Mirrored in `web/src/state/terminalPrefs.ts`; keep in lockstep.
pub const TERMINAL_SCROLLBACK_MB_MIN: u32 = 10;
pub const TERMINAL_SCROLLBACK_MB_MAX: u32 = 500;

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            attachments_dir: default_attachments_dir(),
            search: SearchConfig::default(),
            terminal: TerminalConfig::default(),
            team_work: TeamWorkConfig::default(),
        }
    }
}

fn default_attachments_dir() -> String {
    "attachments".into()
}

impl ServerConfig {
    pub fn load() -> Result<Self, Error> {
        Self::load_from(&default_path())
    }

    pub fn load_from(path: &Path) -> Result<Self, Error> {
        let mut cfg: Self = crate::store::load_toml(path)?;
        cfg.sanitize();
        Ok(cfg)
    }

    pub fn save(&self) -> Result<(), Error> {
        self.save_to(&default_path())
    }

    pub fn save_to(&self, path: &Path) -> Result<(), Error> {
        crate::store::save_toml(path, self)
    }

    pub fn effective_search_aggression(
        &self,
        override_value: Option<SearchAggression>,
    ) -> SearchAggression {
        override_value.unwrap_or(self.search.aggression)
    }

    pub fn sanitize(&mut self) {
        self.team_work.inbox_depth = sanitize_team_work_inbox_depth(self.team_work.inbox_depth);
    }
}

pub fn sanitize_team_work_inbox_depth(depth: usize) -> usize {
    depth.clamp(TEAM_WORK_INBOX_DEPTH_MIN, TEAM_WORK_INBOX_DEPTH_MAX)
}

/// Default server config path: `~/.chan/server.toml` on desktop.
/// iOS / Android callers pass an explicit path via `load_from` /
/// `save_to` since their sandbox dir isn't
/// `chan_workspace::paths::config_dir`.
pub fn default_path() -> PathBuf {
    chan_workspace::paths::config_dir().join("server.toml")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn default_round_trips() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("server.toml");
        let cfg = ServerConfig::default();
        cfg.save_to(&p).unwrap();
        let loaded = ServerConfig::load_from(&p).unwrap();
        assert_eq!(cfg, loaded);
        assert_eq!(loaded.attachments_dir, "attachments");
        assert_eq!(loaded.team_work.inbox_depth, 10);
    }

    #[test]
    fn team_work_inbox_depth_loads_and_clamps() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("server.toml");
        std::fs::write(&p, "[team_work]\ninbox_depth = 0\n").unwrap();
        let cfg = ServerConfig::load_from(&p).unwrap();
        assert_eq!(cfg.team_work.inbox_depth, 1);

        std::fs::write(&p, "[team_work]\ninbox_depth = 250\n").unwrap();
        let cfg = ServerConfig::load_from(&p).unwrap();
        assert_eq!(cfg.team_work.inbox_depth, 100);
    }

    #[test]
    fn populated_round_trips() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("server.toml");
        let cfg = ServerConfig {
            attachments_dir: "media/2026".into(),
            search: SearchConfig {
                aggression: SearchAggression::Aggressive,
            },
            terminal: TerminalConfig {
                idle_timeout_secs: 60,
                session_cap: 4,
                ring_bytes: 4096,
                scrollback_mb: 100,
                default_term: "tmux-256color".into(),
                font: TerminalFontChoice::SourceCodePro,
            },
            team_work: TeamWorkConfig { inbox_depth: 25 },
        };
        cfg.save_to(&p).unwrap();
        let loaded = ServerConfig::load_from(&p).unwrap();
        assert_eq!(cfg, loaded);
    }

    #[test]
    fn missing_file_returns_default() {
        let tmp = TempDir::new().unwrap();
        let cfg = ServerConfig::load_from(&tmp.path().join("nope.toml")).unwrap();
        assert_eq!(cfg, ServerConfig::default());
    }

    #[test]
    fn partial_file_fills_defaults() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("server.toml");
        std::fs::write(&p, "").unwrap();
        let cfg = ServerConfig::load_from(&p).unwrap();
        assert_eq!(cfg.attachments_dir, "attachments"); // default applied
        assert_eq!(cfg.search.aggression, SearchAggression::Balanced);
        assert_eq!(cfg.terminal, TerminalConfig::default());
        assert_eq!(cfg.team_work, TeamWorkConfig::default());
    }

    #[test]
    fn legacy_reports_block_is_ignored() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("server.toml");
        std::fs::write(&p, "[reports]\nenabled = false\n").unwrap();
        let cfg = ServerConfig::load_from(&p).unwrap();
        assert_eq!(cfg, ServerConfig::default());
        cfg.save_to(&p).unwrap();
        let raw = std::fs::read_to_string(&p).unwrap();
        assert!(!raw.contains("[reports]"));
        assert!(!raw.contains("enabled"));
    }

    #[test]
    fn search_aggression_round_trips_as_nested_config() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("server.toml");
        std::fs::write(&p, "[search]\naggression = \"conservative\"\n").unwrap();
        let cfg = ServerConfig::load_from(&p).unwrap();
        assert_eq!(cfg.search.aggression, SearchAggression::Conservative);
    }

    #[test]
    fn search_aggression_rejects_unknown_value() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("server.toml");
        std::fs::write(&p, "[search]\naggression = \"turbo\"\n").unwrap();
        let err = ServerConfig::load_from(&p).unwrap_err();
        assert!(err.to_string().contains("turbo"));
    }

    #[test]
    fn terminal_config_defaults_scrollback_and_term() {
        let cfg = TerminalConfig::default();
        assert_eq!(cfg.scrollback_mb, 50);
        assert_eq!(cfg.default_term, "xterm-256color");
    }

    #[test]
    fn terminal_config_legacy_file_fills_new_fields() {
        // Pre-fullstack-b-11 server.toml didn't carry scrollback_mb
        // or default_term. Serde's per-field defaults must fill them
        // so an upgrade doesn't trip the deserializer.
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("server.toml");
        std::fs::write(
            &p,
            "[terminal]\nidle_timeout_secs = 600\nsession_cap = 8\nring_bytes = 4096\n",
        )
        .unwrap();
        let cfg = ServerConfig::load_from(&p).unwrap();
        assert_eq!(cfg.terminal.idle_timeout_secs, 600);
        assert_eq!(cfg.terminal.session_cap, 8);
        assert_eq!(cfg.terminal.ring_bytes, 4096);
        assert_eq!(cfg.terminal.scrollback_mb, 50);
        assert_eq!(cfg.terminal.default_term, "xterm-256color");
    }

    #[test]
    fn cli_override_wins_over_persisted_search_aggression() {
        let cfg = ServerConfig {
            search: SearchConfig {
                aggression: SearchAggression::Conservative,
            },
            ..ServerConfig::default()
        };
        assert_eq!(
            cfg.effective_search_aggression(Some(SearchAggression::Aggressive)),
            SearchAggression::Aggressive
        );
        assert_eq!(
            cfg.effective_search_aggression(None),
            SearchAggression::Conservative
        );
    }
}
