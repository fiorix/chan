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

// The terminal-session tuning lives in chan-library alongside the registry.
// Re-export it so `ServerConfig.terminal`, the settings route, and other
// `crate::config::TerminalConfig` users name it here; the on-disk and
// `/api/config` wire shape is identical to the registry's own definition.
pub use chan_library::{TerminalConfig, TERMINAL_SCROLLBACK_MB_MAX, TERMINAL_SCROLLBACK_MB_MIN};

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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchConfig {
    #[serde(default)]
    pub aggression: SearchAggression,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self {
            aggression: SearchAggression::Balanced,
        }
    }
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            attachments_dir: default_attachments_dir(),
            search: SearchConfig::default(),
            terminal: TerminalConfig::default(),
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
        crate::store::load_toml(path)
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
                scrollback_mb: 25,
                default_term: "tmux-256color".into(),
                font: chan_library::TerminalFontChoice::SourceCodePro,
                mcp_env: true,
                mouse_capture: false,
            },
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
        assert_eq!(cfg.scrollback_mb, 10);
        assert_eq!(cfg.default_term, "xterm-256color");
        assert!(cfg.mouse_capture);
    }

    #[test]
    fn terminal_config_legacy_file_fills_new_fields() {
        // Older server.toml files didn't carry scrollback_mb or
        // default_term. Serde's per-field defaults must fill them
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
        assert_eq!(cfg.terminal.scrollback_mb, 10);
        assert_eq!(cfg.terminal.default_term, "xterm-256color");
        assert!(cfg.terminal.mouse_capture);
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
