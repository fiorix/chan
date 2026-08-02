//! Terminal-session tuning carried with the registry.
//!
//! `TerminalConfig` is the terminal subsystem's own configuration: the
//! registry (`terminal_sessions`) reads it for idle pruning, the session
//! cap, the replay-ring budget, and the spawn-time TERM / font / MCP-env
//! defaults. `chan-server` embeds it in its on-disk `ServerConfig`, loads
//! and range-clamps it in the settings route, and surfaces it over
//! `/api/config`; the wire shape lives here so the registry and the route
//! layer agree on one definition.

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};

/// Maximum number of literal suffixes compiled into the terminal secret
/// assignment matcher.
pub const TERMINAL_SECRET_MASK_SUFFIX_MAX: usize = 100;

// Mirrored in web/packages/workspace-app/src/terminal/secretMasking.ts
// (DEFAULT_SECRET_MASK_SUFFIXES), the SPA fallback for servers that predate
// the field; keep in lockstep. This list is authoritative for current servers.
const DEFAULT_TERMINAL_SECRET_MASK_SUFFIXES: &[&str] = &[
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "PASSPHRASE",
    "API_KEY",
    "ACCESS_KEY",
    "SECRET_KEY",
    "PRIVATE_KEY",
    "SSH_KEY",
    "SIGNING_KEY",
    "KEY_BASE64",
    "CREDENTIALS",
];

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
    /// Whether newly opened terminals use the ghostty-web backend
    /// (Ghostty's WASM VT parser) instead of xterm.js. Consumed by the
    /// SPA at terminal start time; the server only persists the value.
    /// Off by default (xterm.js stays the battle-tested path). Applies
    /// to newly opened terminals.
    #[serde(default)]
    pub ghostty: bool,
    /// Whether xterm.js terminals visually obscure the values of
    /// secret-looking `NAME=value` assignments. The buffer remains
    /// cleartext so selection, copy, replay, and snapshots are unchanged.
    /// Ghostty terminals do not support xterm decorations and ignore this.
    #[serde(default = "default_terminal_secret_masking")]
    pub secret_masking: bool,
    /// Literal, case-insensitive variable-name suffixes that trigger visual
    /// secret masking. Deserialization rejects regex syntax and caps the list
    /// before the SPA compiles it into one alternation.
    #[serde(
        default = "default_terminal_secret_mask_suffixes",
        deserialize_with = "deserialize_terminal_secret_mask_suffixes"
    )]
    pub secret_mask_suffixes: Vec<String>,
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
            ghostty: false,
            secret_masking: default_terminal_secret_masking(),
            secret_mask_suffixes: default_terminal_secret_mask_suffixes(),
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

fn default_terminal_secret_masking() -> bool {
    true
}

fn default_terminal_secret_mask_suffixes() -> Vec<String> {
    DEFAULT_TERMINAL_SECRET_MASK_SUFFIXES
        .iter()
        .map(|suffix| (*suffix).to_string())
        .collect()
}

fn deserialize_terminal_secret_mask_suffixes<'de, D>(
    deserializer: D,
) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let suffixes = Vec::<String>::deserialize(deserializer)?;
    normalize_terminal_secret_mask_suffixes(suffixes, |entries| {
        tracing::warn!(
            entries,
            limit = TERMINAL_SECRET_MASK_SUFFIX_MAX,
            "terminal.secret_mask_suffixes exceeds its limit; ignoring trailing entries"
        );
    })
    .map_err(D::Error::custom)
}

fn normalize_terminal_secret_mask_suffixes(
    mut suffixes: Vec<String>,
    warn: impl FnOnce(usize),
) -> Result<Vec<String>, String> {
    if let Some(invalid) = suffixes.iter().find(|suffix| {
        suffix.is_empty()
            || !suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    }) {
        return Err(format!(
            "terminal.secret_mask_suffixes entry {invalid:?} must match [A-Za-z0-9_]+"
        ));
    }
    if suffixes.len() > TERMINAL_SECRET_MASK_SUFFIX_MAX {
        warn(suffixes.len());
        suffixes.truncate(TERMINAL_SECRET_MASK_SUFFIX_MAX);
    }
    Ok(suffixes)
}

/// Inclusive bounds the Settings UI exposes for the scrollback slider.
/// Mirrored in `web/packages/workspace-app/src/terminal/scrollback.ts`; keep in lockstep.
pub const TERMINAL_SCROLLBACK_MB_MIN: u32 = 10;
pub const TERMINAL_SCROLLBACK_MB_MAX: u32 = 50;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::Cell;

    #[test]
    fn secret_masking_defaults_to_the_stock_literal_suffixes() {
        let config = TerminalConfig::default();
        assert!(config.secret_masking);
        assert_eq!(
            config.secret_mask_suffixes,
            DEFAULT_TERMINAL_SECRET_MASK_SUFFIXES
        );
    }

    #[test]
    fn secret_mask_suffixes_reject_regex_syntax() {
        let err = serde_json::from_value::<TerminalConfig>(json!({
            "secret_mask_suffixes": ["TOKEN", "SECRET.*"]
        }))
        .unwrap_err();
        assert!(err.to_string().contains("[A-Za-z0-9_]+"));
    }

    #[test]
    fn secret_mask_suffixes_clamp_and_warn_once() {
        let suffixes = (0..=TERMINAL_SECRET_MASK_SUFFIX_MAX)
            .map(|index| format!("TOKEN_{index}"))
            .collect::<Vec<_>>();
        let warning_count = Cell::new(0);
        let suffixes = normalize_terminal_secret_mask_suffixes(suffixes, |_| {
            warning_count.set(warning_count.get() + 1);
        })
        .unwrap();
        assert_eq!(suffixes.len(), TERMINAL_SECRET_MASK_SUFFIX_MAX);
        assert_eq!(suffixes.last().unwrap(), "TOKEN_99");
        assert_eq!(warning_count.get(), 1);
    }
}
