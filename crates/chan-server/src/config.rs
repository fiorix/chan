//! chan-server preferences.
//!
//! Persisted at `~/.chan/server.toml` (under `$CHAN_HOME` when that is
//! set), beside `preferences.toml`. Holds chan-server-specific
//! paths and toggles that aren't user content (those live in the
//! workspace).
//!
//! New fields land here when a route surfaces a server-shaped
//! setting (e.g. a future "open-in-browser on launch" toggle).
//! Anything filesystem-shaped on the workspace itself stays in chan-workspace.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use chan_workspace::SearchAggression;
use serde::{Deserialize, Serialize};

use crate::Error;

// The terminal-session tuning lives in chan-library alongside the registry.
// Re-export it so `ServerConfig.terminal`, the settings route, and other
// `crate::config::TerminalConfig` users name it here; the on-disk and
// `/api/config` wire shape is identical to the registry's own definition.
pub use chan_library::{
    TerminalConfig, TERMINAL_BACKGROUND_OPACITY_MAX, TERMINAL_BACKGROUND_OPACITY_MIN,
    TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN, TERMINAL_SCROLLBACK_MB_MAX,
    TERMINAL_SCROLLBACK_MB_MIN,
};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerConfig {
    #[serde(default)]
    pub search: SearchConfig,
    #[serde(default)]
    pub terminal: TerminalConfig,
    #[serde(default)]
    pub transfer: TransferConfig,
    #[serde(default)]
    pub tunnel: TunnelConfig,
}

/// File-only transfer policy, captured when a tenant starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransferConfig {
    /// Maximum time without channel progress. Zero selects the default,
    /// matching the terminal idle timeout's zero-value policy.
    #[serde(default = "default_stall_timeout_secs")]
    pub stall_timeout_secs: u64,
}

fn default_stall_timeout_secs() -> u64 {
    300
}

impl Default for TransferConfig {
    fn default() -> Self {
        Self {
            stall_timeout_secs: default_stall_timeout_secs(),
        }
    }
}

impl TransferConfig {
    pub(crate) fn stall_timeout(&self) -> std::time::Duration {
        let secs = if self.stall_timeout_secs == 0 {
            default_stall_timeout_secs()
        } else {
            self.stall_timeout_secs
        };
        std::time::Duration::from_secs(secs)
    }
}

/// File-only reverse-tunnel policy, captured when a tenant starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TunnelConfig {
    /// Live `cs tunnel` tunnels the host admits across every tenant and every
    /// command. Zero selects the default, matching the transfer stall
    /// timeout's zero-value policy.
    #[serde(default = "default_max_live")]
    pub max_live: usize,
}

fn default_max_live() -> usize {
    32
}

impl Default for TunnelConfig {
    fn default() -> Self {
        Self {
            max_live: default_max_live(),
        }
    }
}

impl TunnelConfig {
    pub(crate) fn max_live(&self) -> usize {
        if self.max_live == 0 {
            default_max_live()
        } else {
            self.max_live
        }
    }
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

/// Keys a `server.toml` may still hold after their setting was retired, read
/// for their type and their warning and never written: `ServerConfig` has no
/// field for them, so the next save drops them.
#[derive(Debug, Default, Deserialize)]
struct RetiredKeys {
    #[serde(default)]
    terminal: RetiredTerminalKeys,
}

#[derive(Debug, Default, Deserialize)]
struct RetiredTerminalKeys {
    /// The terminal engine choice. Every terminal is Ghostty. `true` is the
    /// value chan itself wrote on every save and passes silently; `false`
    /// asked for xterm.js, so it is reported.
    #[serde(default)]
    ghostty: Option<bool>,
}

/// Whether this process has reported a stored `terminal.ghostty = false`. The
/// file is loaded far more often than a user edits it (at every config-watch
/// event, at each PTY spawn of a terminal-only tenant, by the desktop), so
/// the warning is given once per process rather than once per load.
static RETIRED_TERMINAL_GHOSTTY_WARNED: AtomicBool = AtomicBool::new(false);

impl ServerConfig {
    pub fn load() -> Result<Self, Error> {
        Self::load_from(&default_path())
    }

    pub fn load_from(path: &Path) -> Result<Self, Error> {
        Self::load_warning_once(path, &RETIRED_TERMINAL_GHOSTTY_WARNED)
    }

    /// [`Self::load_from`] with the once-per-process flag of the
    /// `terminal.ghostty` warning passed in, so a test owns its flag.
    fn load_warning_once(path: &Path, ghostty_warned: &AtomicBool) -> Result<Self, Error> {
        // The typed read preserves source locations in retained-key errors.
        let mut config: Self = crate::store::load_toml(path)?;
        // So does the typed read of the retired keys, so a non-boolean
        // `terminal.ghostty` stays an error with its location.
        let retired: RetiredKeys = crate::store::load_toml(path)?;
        if retired.terminal.ghostty == Some(false) && !ghostty_warned.swap(true, Ordering::Relaxed)
        {
            tracing::warn!(
                key = "terminal.ghostty",
                path = %path.display(),
                "server.toml key is deprecated and has no effect: every terminal uses Ghostty; \
                 remove it, a future release will reject it"
            );
        }
        let warn_retired_attachments_dir = std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| toml::from_str::<toml::Value>(&raw).ok())
            .is_some_and(|value| {
                value
                    .get("attachments_dir")
                    .is_some_and(|value| value.as_str() != Some("attachments"))
            });
        if warn_retired_attachments_dir {
            tracing::warn!(
                key = "attachments_dir",
                "ignoring retired server.toml key; uploads require an explicit workspace or draft destination"
            );
        }
        config.transfer.stall_timeout_secs = config.transfer.stall_timeout().as_secs();
        config.tunnel.max_live = config.tunnel.max_live();
        Ok(config)
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

/// Default server config path: `server.toml` in the chan home
/// (`chan_workspace::paths::config_dir`, `~/.chan` by default).
/// `load_from` / `save_to` take an explicit path instead.
pub fn default_path() -> PathBuf {
    chan_workspace::paths::config_dir().join("server.toml")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn capture_warnings<T>(f: impl FnOnce() -> T) -> (Vec<String>, T) {
        struct Capture(std::sync::Arc<std::sync::Mutex<Vec<String>>>);
        impl tracing::Subscriber for Capture {
            fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
                true
            }
            fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
                tracing::span::Id::from_u64(1)
            }
            fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
            fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
            fn event(&self, event: &tracing::Event<'_>) {
                struct Line(String);
                impl tracing::field::Visit for Line {
                    fn record_debug(
                        &mut self,
                        field: &tracing::field::Field,
                        value: &dyn std::fmt::Debug,
                    ) {
                        use std::fmt::Write as _;
                        let _ = write!(self.0, " {}={value:?}", field.name());
                    }
                }
                let mut line = Line(event.metadata().level().to_string());
                event.record(&mut line);
                self.0
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(line.0);
            }
            fn enter(&self, _: &tracing::span::Id) {}
            fn exit(&self, _: &tracing::span::Id) {}
        }
        let lines = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let out = tracing::subscriber::with_default(Capture(std::sync::Arc::clone(&lines)), f);
        let warnings = lines
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        (warnings, out)
    }

    #[test]
    fn default_round_trips() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("server.toml");
        let cfg = ServerConfig::default();
        cfg.save_to(&p).unwrap();
        let loaded = ServerConfig::load_from(&p).unwrap();
        assert_eq!(cfg, loaded);
    }

    #[test]
    fn legacy_attachments_dir_loads_and_drops_on_save() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("server.toml");
        std::fs::write(
            &path,
            "attachments_dir = \"media/2026\"\n[search]\naggression = \"aggressive\"\n",
        )
        .unwrap();
        let (warnings, config) = capture_warnings(|| ServerConfig::load_from(&path).unwrap());
        assert!(
            warnings.iter().any(|line| {
                line.contains("WARN")
                    && line.contains("attachments_dir")
                    && line.contains("explicit workspace or draft destination")
            }),
            "{warnings:?}"
        );
        assert_eq!(config.search.aggression, SearchAggression::Aggressive);
        config.save_to(&path).unwrap();
        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(!saved.contains("attachments_dir"), "{saved}");
        assert!(saved.contains("aggressive"), "{saved}");
    }

    #[test]
    fn default_legacy_attachments_dir_is_silent_and_drops_on_save() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("server.toml");
        std::fs::write(&path, "attachments_dir = \"attachments\"\n").unwrap();
        let (warnings, config) = capture_warnings(|| ServerConfig::load_from(&path).unwrap());
        assert!(
            warnings.is_empty(),
            "default retired key warned: {warnings:?}"
        );
        config.save_to(&path).unwrap();
        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(!saved.contains("attachments_dir"), "{saved}");
    }

    #[test]
    fn legacy_attachments_dir_keeps_retained_type_error_location() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("server.toml");
        std::fs::write(
            &path,
            "attachments_dir = \"media/2026\"\n[transfer]\nstall_timeout_secs = \"45\"\n",
        )
        .unwrap();
        let Err(Error::Config(message)) = ServerConfig::load_from(&path) else {
            panic!("expected a config decode error");
        };
        assert!(
            message.contains("line 3, column"),
            "missing error location: {message}"
        );
    }

    #[test]
    fn malformed_legacy_attachment_toml_is_still_an_error() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("server.toml");
        std::fs::write(&path, "attachments_dir = = =\n").unwrap();
        assert!(matches!(
            ServerConfig::load_from(&path),
            Err(Error::Config(_))
        ));
    }

    /// The WARN lines a load of `path` gives under its own once-per-process
    /// flag, so the test does not depend on what other tests loaded.
    fn load_warnings(path: &Path, warned: &AtomicBool) -> (Vec<String>, ServerConfig) {
        let (lines, config) =
            capture_warnings(|| ServerConfig::load_warning_once(path, warned).unwrap());
        let warnings = lines
            .into_iter()
            .filter(|line| line.starts_with("WARN"))
            .collect();
        (warnings, config)
    }

    #[test]
    fn a_stored_false_terminal_ghostty_warns_and_is_dropped_on_save() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("server.toml");
        std::fs::write(
            &path,
            "[search]\naggression = \"aggressive\"\n[terminal]\nghostty = false\nscrollback_mb = 30\n",
        )
        .unwrap();
        let (warnings, config) = load_warnings(&path, &AtomicBool::new(false));
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        for word in [
            "terminal.ghostty",
            "deprecated",
            "no effect",
            "remove it",
            "will reject",
        ] {
            assert!(warnings[0].contains(word), "{word}: {warnings:?}");
        }
        assert_eq!(config.search.aggression, SearchAggression::Aggressive);
        assert_eq!(config.terminal.scrollback_mb, 30);

        config.save_to(&path).unwrap();
        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(!saved.contains("ghostty"), "{saved}");
        assert!(saved.contains("aggression = \"aggressive\""), "{saved}");
        assert!(saved.contains("scrollback_mb = 30"), "{saved}");
        let (warnings, reloaded) = load_warnings(&path, &AtomicBool::new(false));
        assert!(
            warnings.is_empty(),
            "the saved file still warns: {warnings:?}"
        );
        assert_eq!(reloaded, config);
    }

    #[test]
    fn a_stored_true_terminal_ghostty_is_silent_and_dropped_on_save() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("server.toml");
        std::fs::write(&path, "[terminal]\nghostty = true\nfont_size = 12\n").unwrap();
        let (warnings, config) = load_warnings(&path, &AtomicBool::new(false));
        assert!(warnings.is_empty(), "chan's own value warned: {warnings:?}");
        assert_eq!(config.terminal.font_size, 12);

        config.save_to(&path).unwrap();
        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(!saved.contains("ghostty"), "{saved}");
        assert!(saved.contains("font_size = 12"), "{saved}");
    }

    #[test]
    fn an_absent_terminal_ghostty_is_silent() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("server.toml");
        std::fs::write(&path, "[terminal]\nfont_size = 12\n").unwrap();
        let (warnings, _) = load_warnings(&path, &AtomicBool::new(false));
        assert!(warnings.is_empty(), "{warnings:?}");
        let (warnings, _) =
            load_warnings(&tmp.path().join("missing.toml"), &AtomicBool::new(false));
        assert!(warnings.is_empty(), "{warnings:?}");
    }

    #[test]
    fn a_non_boolean_terminal_ghostty_keeps_its_type_error_and_location() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("server.toml");
        std::fs::write(
            &path,
            "[search]\naggression = \"aggressive\"\n[terminal]\nghostty = \"yes\"\n",
        )
        .unwrap();
        let Err(Error::Config(message)) =
            ServerConfig::load_warning_once(&path, &AtomicBool::new(false))
        else {
            panic!("expected a config decode error");
        };
        assert!(message.contains("line 4, column"), "{message}");
        assert!(message.contains("expected a boolean"), "{message}");
    }

    #[test]
    fn the_terminal_ghostty_warning_is_given_once_per_process() {
        let tmp = TempDir::new().unwrap();
        let first = tmp.path().join("server.toml");
        let second = tmp.path().join("other.toml");
        std::fs::write(&first, "[terminal]\nghostty = false\n").unwrap();
        std::fs::write(&second, "[terminal]\nghostty = false\nfont_size = 12\n").unwrap();
        let warned = AtomicBool::new(false);
        let (mut warnings, _) = load_warnings(&first, &warned);
        warnings.extend(load_warnings(&first, &warned).0);
        warnings.extend(load_warnings(&second, &warned).0);
        assert_eq!(warnings.len(), 1, "{warnings:?}");

        // `load_from` answers to the process's own flag.
        let _ = ServerConfig::load_from(&first).unwrap();
        assert!(RETIRED_TERMINAL_GHOSTTY_WARNED.load(Ordering::Relaxed));
    }

    #[test]
    fn loading_a_retired_terminal_ghostty_leaves_the_file_unchanged() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("server.toml");
        for value in ["false", "true"] {
            let body = format!("# kept\n[terminal]\nghostty = {value}\nfont_size = 12\n");
            std::fs::write(&path, &body).unwrap();
            let before = std::fs::metadata(&path).unwrap().modified().unwrap();
            let _ = load_warnings(&path, &AtomicBool::new(false));
            assert_eq!(std::fs::read_to_string(&path).unwrap(), body);
            assert_eq!(
                std::fs::metadata(&path).unwrap().modified().unwrap(),
                before
            );
        }
    }

    #[test]
    fn populated_round_trips() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("server.toml");
        let cfg = ServerConfig {
            transfer: TransferConfig {
                stall_timeout_secs: 45,
            },
            tunnel: TunnelConfig { max_live: 7 },
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
                font_size: 18,
                background_opacity: 85,
                mcp_env: true,
                mouse_capture: false,
                program_status: true,
                tmux: chan_library::TerminalTmuxConfig {
                    enabled: true,
                    trust: vec!["ssh".into()],
                },
                secret_masking: Some(false),
                secret_mask_suffixes: vec!["TOKEN".into(), "PRIVATE_KEY".into()],
                // Populated rather than defaulted so the round trip actually
                // exercises the `[[terminal.profiles]]` array-of-tables: an
                // override, and a hide.
                profiles: vec![
                    chan_library::TerminalProfile {
                        id: "git-bash".into(),
                        name: Some("Git Bash".into()),
                        program: Some(r"C:\Program Files\Git\bin\bash.exe".into()),
                        args: Some(vec!["-l".into()]),
                        kind: Some(chan_library::ShellKind::Posix),
                        hidden: false,
                    },
                    chan_library::TerminalProfile {
                        id: "cmd".into(),
                        name: None,
                        program: None,
                        args: None,
                        kind: None,
                        hidden: true,
                    },
                ],
                default_profile: Some("git-bash".into()),
            },
        };
        cfg.save_to(&p).unwrap();
        let loaded = ServerConfig::load_from(&p).unwrap();
        assert_eq!(cfg, loaded);
    }

    #[test]
    fn transfer_config_defaults_when_absent() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("server.toml");
        std::fs::write(&path, "[terminal]\nidle_timeout_secs = 600\n").unwrap();
        let config = ServerConfig::load_from(&path).unwrap();
        assert_eq!(config.transfer.stall_timeout_secs, 300);
        assert_eq!(
            config.transfer.stall_timeout(),
            std::time::Duration::from_secs(300)
        );
    }

    #[test]
    fn transfer_config_hand_edited_timeout_round_trips() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("server.toml");
        std::fs::write(&path, "[transfer]\nstall_timeout_secs = 42\n").unwrap();
        let config = ServerConfig::load_from(&path).unwrap();
        assert_eq!(config.transfer.stall_timeout_secs, 42);
        config.save_to(&path).unwrap();
        assert_eq!(ServerConfig::load_from(&path).unwrap(), config);
    }

    #[test]
    fn transfer_config_zero_timeout_uses_default() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("server.toml");
        for (value, expected) in [(0, 300), (1, 1), (90_000, 90_000)] {
            std::fs::write(&path, format!("[transfer]\nstall_timeout_secs = {value}\n")).unwrap();
            let config = ServerConfig::load_from(&path).unwrap();
            assert_eq!(config.transfer.stall_timeout_secs, expected);
        }
    }

    #[test]
    fn tunnel_config_defaults_absent_and_zero_to_thirty_two() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("server.toml");
        std::fs::write(&path, "[terminal]\nidle_timeout_secs = 600\n").unwrap();
        assert_eq!(ServerConfig::load_from(&path).unwrap().tunnel.max_live, 32);
        for (value, expected) in [(0, 32), (1, 1), (500, 500)] {
            std::fs::write(&path, format!("[tunnel]\nmax_live = {value}\n")).unwrap();
            let config = ServerConfig::load_from(&path).unwrap();
            assert_eq!(config.tunnel.max_live, expected);
            assert_eq!(config.tunnel.max_live(), expected);
        }
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
        assert_eq!(cfg.secret_masking, None);
        assert!(cfg.secret_mask_suffixes.contains(&"TOKEN".to_string()));
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
        assert_eq!(cfg.terminal.secret_masking, None);
        assert!(cfg
            .terminal
            .secret_mask_suffixes
            .contains(&"KEY_BASE64".to_string()));
    }

    #[test]
    fn terminal_config_reads_program_status_and_takes_it_as_on_when_absent() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("server.toml");
        std::fs::write(&p, "[terminal]\nfont_size = 12\n").unwrap();
        assert!(ServerConfig::load_from(&p).unwrap().terminal.program_status);
        std::fs::write(&p, "[terminal]\nprogram_status = true\n").unwrap();
        assert!(ServerConfig::load_from(&p).unwrap().terminal.program_status);
        std::fs::write(&p, "[terminal]\nprogram_status = false\n").unwrap();
        assert!(!ServerConfig::load_from(&p).unwrap().terminal.program_status);
    }

    #[test]
    fn terminal_config_preserves_explicit_secret_masking_true() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("server.toml");
        std::fs::write(&p, "[terminal]\nsecret_masking = true\n").unwrap();
        let cfg = ServerConfig::load_from(&p).unwrap();
        assert_eq!(cfg.terminal.secret_masking, Some(true));
    }

    #[test]
    fn terminal_config_drops_non_literal_secret_suffixes_and_keeps_the_file() {
        // A malformed suffix entry must not take the rest of server.toml
        // down with it: a load Err here would fall the whole config back to
        // in-memory defaults, and the next /api/config PATCH would persist
        // those defaults over every other setting.
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("server.toml");
        std::fs::write(
            &p,
            "[terminal]\nidle_timeout_secs = 600\nsecret_mask_suffixes = [\"TOKEN\", \"SECRET.*\", \"API-KEY\", \"TOKEN\"]\n",
        )
        .unwrap();
        let cfg = ServerConfig::load_from(&p).unwrap();
        assert_eq!(cfg.terminal.idle_timeout_secs, 600);
        assert_eq!(cfg.terminal.secret_mask_suffixes, vec!["TOKEN".to_string()]);
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
