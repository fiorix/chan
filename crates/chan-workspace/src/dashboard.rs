//! Per-workspace dashboard config: the screensaver overlay plus the
//! chan-report and semantic-search opt-ins. Persisted at
//! `<workspace-metadata-root>/dashboard.toml`, separate from the search
//! `IndexConfig` -- these are workspace feature/presentation toggles, not
//! search-index cache, so a search reindex or vector wipe must not reset them.
//! The SPA reaches every field through dedicated chan-server endpoints
//! (`/api/screensaver/state`, `/api/index/{reports,semantic}/state`) and the
//! workspace preflight, never this file directly.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{ChanError, Result};

/// Visual theme rendered behind the screensaver unlock card.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScreensaverTheme {
    #[default]
    Plain,
    Matrix,
}

/// On-disk shape of `<root>/dashboard.toml`. Every field is `#[serde(default)]`
/// so a partial or absent file degrades to the struct defaults rather than
/// failing the parse.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DashboardConfig {
    /// Per-workspace Hybrid-search opt-in. Default-false: a workspace stays
    /// BM25-only until the user flips it on (`chan workspace index
    /// enable-semantic` or the Settings UI). The query path consults
    /// `Workspace::semantic_enabled` to pick the default search mode; an
    /// explicit `Mode::Hybrid` on a single `search` still overrides regardless.
    #[serde(default)]
    pub semantic_enabled: bool,
    /// Per-workspace chan-report opt-in. Default ON (see `Default`): a new
    /// workspace or partial current config gets language detection + SLOC
    /// roll-up + COCOMO out of the box.
    #[serde(default = "default_reports_enabled")]
    pub reports_enabled: bool,
    /// Screensaver overlay opt-in. Default-false so a workspace without the
    /// feature configured stays unchanged. The SPA arms the overlay state
    /// machine when true.
    #[serde(default)]
    pub screensaver_enabled: bool,
    /// Idle window in seconds before the overlay fires. Default 300 (5 min).
    /// The SPA computes "idle" client-side; chan-server just persists the
    /// threshold.
    #[serde(default = "default_screensaver_timeout_secs")]
    pub screensaver_timeout_secs: u32,
    /// Visual theme for the overlay. Default `Plain` keeps the lock screen
    /// quiet unless the user opts into an animated scene.
    #[serde(default)]
    pub screensaver_theme: ScreensaverTheme,
    /// Per-workspace PIN hash; `None` when no PIN is set (the overlay still
    /// arms but auto-dismisses on any input). Stored verbatim -- the SPA does
    /// PBKDF2 client-side and the verify path is a byte-equality compare.
    /// NEVER serialized back over the wire in plaintext: the
    /// `/api/screensaver/state` endpoint reports `pin_set: bool` only.
    #[serde(default, with = "screensaver_pin_serde")]
    pub screensaver_pin_hash: Option<Vec<u8>>,
}

fn default_screensaver_timeout_secs() -> u32 {
    300
}

fn default_reports_enabled() -> bool {
    true
}

impl Default for DashboardConfig {
    fn default() -> Self {
        Self {
            semantic_enabled: false,
            reports_enabled: default_reports_enabled(),
            screensaver_enabled: false,
            screensaver_timeout_secs: default_screensaver_timeout_secs(),
            screensaver_theme: ScreensaverTheme::Plain,
            screensaver_pin_hash: None,
        }
    }
}

/// Base64 serde adapter for `screensaver_pin_hash` so the TOML stays text-only
/// and the bytes round-trip cleanly (a raw `Vec<u8>` would land as a noisy TOML
/// integer array).
mod screensaver_pin_serde {
    use base64::Engine;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(value: &Option<Vec<u8>>, ser: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match value {
            Some(bytes) => {
                let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
                ser.serialize_some(&b64)
            }
            None => ser.serialize_none(),
        }
    }

    pub fn deserialize<'de, D>(de: D) -> Result<Option<Vec<u8>>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let opt = Option::<String>::deserialize(de)?;
        match opt {
            Some(s) => base64::engine::general_purpose::STANDARD
                .decode(s.as_bytes())
                .map(Some)
                .map_err(serde::de::Error::custom),
            None => Ok(None),
        }
    }
}

/// Path to the dashboard config inside the workspace metadata `root`.
pub fn config_path(root: &Path) -> PathBuf {
    root.join("dashboard.toml")
}

/// Load the dashboard config, falling back to defaults when the file is absent.
/// A malformed file is an error; we don't silently overwrite a user's edit.
pub fn load(root: &Path) -> Result<DashboardConfig> {
    let path = config_path(root);
    if !path.exists() {
        return Ok(DashboardConfig::default());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| ChanError::Io(e.to_string()))?;
    toml::from_str(&raw).map_err(|e| ChanError::ConfigDecode {
        path,
        message: e.to_string(),
    })
}

/// Persist the dashboard config; `atomic_write` creates the parent directory if
/// needed.
pub fn save(root: &Path, cfg: &DashboardConfig) -> Result<()> {
    #[cfg(test)]
    record_test_save(root)?;
    let path = config_path(root);
    let body = toml::to_string_pretty(cfg).map_err(|e| ChanError::ConfigEncode(e.to_string()))?;
    crate::fs_ops::atomic_write(&path, body.as_bytes())?;
    Ok(())
}

#[cfg(test)]
#[derive(Default)]
struct TestSaveProbe {
    calls: usize,
    fail_next: bool,
}

#[cfg(test)]
thread_local! {
    static TEST_SAVE_PROBES: std::cell::RefCell<std::collections::HashMap<PathBuf, TestSaveProbe>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

#[cfg(test)]
fn record_test_save(root: &Path) -> Result<()> {
    TEST_SAVE_PROBES.with(|probes| {
        let mut probes = probes.borrow_mut();
        let probe = probes.entry(root.to_path_buf()).or_default();
        probe.calls += 1;
        if probe.fail_next {
            probe.fail_next = false;
            return Err(ChanError::Io("injected dashboard save failure".into()));
        }
        Ok(())
    })
}

#[cfg(test)]
pub(crate) fn reset_test_save_probe(root: &Path) {
    TEST_SAVE_PROBES.with(|probes| {
        probes
            .borrow_mut()
            .insert(root.to_path_buf(), TestSaveProbe::default());
    });
}

#[cfg(test)]
pub(crate) fn inject_test_save_failure(root: &Path) {
    TEST_SAVE_PROBES.with(|probes| {
        probes
            .borrow_mut()
            .entry(root.to_path_buf())
            .or_default()
            .fail_next = true;
    });
}

#[cfg(test)]
pub(crate) fn test_save_calls(root: &Path) -> usize {
    TEST_SAVE_PROBES.with(|probes| {
        probes
            .borrow()
            .get(root)
            .map(|probe| probe.calls)
            .unwrap_or(0)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn load_returns_default_when_absent() {
        let tmp = TempDir::new().unwrap();
        let cfg = load(tmp.path()).unwrap();
        assert_eq!(cfg, DashboardConfig::default());
        // Reports default ON for a brand-new workspace; the rest off/plain.
        assert!(cfg.reports_enabled);
        assert!(!cfg.semantic_enabled);
        assert!(!cfg.screensaver_enabled);
        assert_eq!(cfg.screensaver_timeout_secs, 300);
        assert_eq!(cfg.screensaver_theme, ScreensaverTheme::Plain);
        assert!(cfg.screensaver_pin_hash.is_none());
    }

    #[test]
    fn complete_config_round_trips_all_fields() {
        let tmp = TempDir::new().unwrap();
        let cfg = DashboardConfig {
            semantic_enabled: true,
            reports_enabled: false,
            screensaver_enabled: true,
            screensaver_timeout_secs: 60,
            screensaver_theme: ScreensaverTheme::Matrix,
            screensaver_pin_hash: Some(vec![1, 2, 3, 4]),
        };
        save(tmp.path(), &cfg).unwrap();
        assert_eq!(load(tmp.path()).unwrap(), cfg);
    }

    #[test]
    fn theme_wire_is_lowercase() {
        // The SPA consumes `screensaver_theme` over /api/screensaver/state;
        // pin the on-wire spelling so a rename is a deliberate, visible change.
        let json = serde_json::to_string(&ScreensaverTheme::Matrix).unwrap();
        assert_eq!(json, "\"matrix\"");
        let plain = serde_json::to_string(&ScreensaverTheme::Plain).unwrap();
        assert_eq!(plain, "\"plain\"");
    }

    #[test]
    fn pin_hash_persists_as_base64_text() {
        let tmp = TempDir::new().unwrap();
        let cfg = DashboardConfig {
            screensaver_pin_hash: Some(vec![0xde, 0xad, 0xbe, 0xef]),
            ..DashboardConfig::default()
        };
        save(tmp.path(), &cfg).unwrap();
        let raw = std::fs::read_to_string(config_path(tmp.path())).unwrap();
        // base64 of 0xdeadbeef, stored as a quoted TOML string (not an int array).
        assert!(raw.contains("screensaver_pin_hash = \"3q2+7w==\""), "{raw}");
    }

    #[test]
    fn partial_current_config_fills_struct_defaults() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(config_path(tmp.path()), "screensaver_enabled = true\n").unwrap();
        let cfg = load(tmp.path()).unwrap();
        assert!(cfg.screensaver_enabled);
        assert!(!cfg.semantic_enabled, "omitted key defaults to false");
        assert!(cfg.reports_enabled, "omitted key uses the struct default");
        assert_eq!(cfg.screensaver_timeout_secs, 300);
        assert_eq!(cfg.screensaver_theme, ScreensaverTheme::Plain);
        assert!(cfg.screensaver_pin_hash.is_none());
    }

    #[test]
    fn malformed_config_is_rejected_without_rewrite() {
        let tmp = TempDir::new().unwrap();
        let path = config_path(tmp.path());
        let malformed = "reports_enabled = not-a-bool\n";
        std::fs::write(&path, malformed).unwrap();
        assert!(matches!(
            load(tmp.path()),
            Err(ChanError::ConfigDecode { .. })
        ));
        assert_eq!(std::fs::read_to_string(path).unwrap(), malformed);
    }
}
