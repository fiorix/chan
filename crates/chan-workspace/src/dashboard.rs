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
    /// workspace gets language detection + SLOC roll-up + COCOMO out of the
    /// box. The `#[serde(default)]` here resolves to `false` so a file that
    /// omits the key is not silently flipped on; the on-by-default applies only
    /// to a brand-new workspace with no file yet.
    #[serde(default)]
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

impl Default for DashboardConfig {
    fn default() -> Self {
        Self {
            semantic_enabled: false,
            // Reports default ON for a brand-new workspace (used by `load` only
            // when no dashboard.toml exists yet). An existing file keeps its
            // persisted value, and a file that omits the key deserializes to
            // false via the field's `#[serde(default)]`, so existing workspaces
            // never silently flip.
            reports_enabled: true,
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

/// The dashboard keys as they used to live in `<index_dir>/config.toml`, read
/// with the OLD `IndexConfig` serde defaults so a migration is byte-faithful to
/// what the index config would have reported. In particular `reports_enabled`
/// defaults `false` here (an existing workspace that never set it stays off);
/// the reports-default-ON only applies to a brand-new workspace, which has no
/// index config to migrate and so picks up [`DashboardConfig::default`]. The
/// search keys (model, chunking, vectors_*, excluded_dirs, schema_version) are
/// ignored.
#[derive(Deserialize)]
struct LegacyDashboardKeys {
    #[serde(default)]
    semantic_enabled: bool,
    #[serde(default)]
    reports_enabled: bool,
    #[serde(default)]
    screensaver_enabled: bool,
    #[serde(default = "default_screensaver_timeout_secs")]
    screensaver_timeout_secs: u32,
    #[serde(default)]
    screensaver_theme: ScreensaverTheme,
    #[serde(default, with = "screensaver_pin_serde")]
    screensaver_pin_hash: Option<Vec<u8>>,
}

impl LegacyDashboardKeys {
    fn into_config(self) -> DashboardConfig {
        DashboardConfig {
            semantic_enabled: self.semantic_enabled,
            reports_enabled: self.reports_enabled,
            screensaver_enabled: self.screensaver_enabled,
            screensaver_timeout_secs: self.screensaver_timeout_secs,
            screensaver_theme: self.screensaver_theme,
            screensaver_pin_hash: self.screensaver_pin_hash,
        }
    }
}

/// One-shot migration: these toggles used to squat in the search `IndexConfig`
/// (`<index_dir>/config.toml`). On first open after the re-home, move any
/// persisted values into `<root>/dashboard.toml` and strip the old keys from
/// the index config, so the dashboard config is the single home. Pre-release,
/// this is a one-shot data move, not an ongoing back-compat path.
///
/// A no-op once `dashboard.toml` exists. Gated on the legacy index config
/// EXISTING (not on which keys it carries): a workspace with an index config is
/// "existing", so even one omitting every toggle migrates to faithful values
/// (reports off) rather than picking up the new-workspace default (reports on).
/// A truly brand-new workspace has no index config, so it is skipped and
/// [`load`] returns [`DashboardConfig::default`]. A malformed index config is
/// skipped too (left for `index::config::load` to surface, so open stays as
/// lenient as before).
pub fn migrate_from_index_config(root: &Path, index_dir: &Path) -> Result<()> {
    let dash_path = config_path(root);
    if dash_path.exists() {
        return Ok(());
    }
    let index_cfg_path = crate::index::config::config_path(index_dir);
    let Ok(raw) = std::fs::read_to_string(&index_cfg_path) else {
        return Ok(()); // brand-new workspace: no legacy config → defaults apply
    };
    let Ok(legacy) = toml::from_str::<LegacyDashboardKeys>(&raw) else {
        return Ok(()); // malformed/foreign: leave it for index::config::load
    };
    save(root, &legacy.into_config())?;
    // Strip the moved keys from the index config: load it (the struct no longer
    // has those fields, so they fall away) and re-save the stripped form.
    if let Ok(index_cfg) = crate::index::config::load(index_dir) {
        let _ = crate::index::config::save(index_dir, &index_cfg);
    }
    Ok(())
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
    fn save_then_load_round_trips_all_fields() {
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
    fn missing_keys_in_a_partial_file_fall_to_defaults() {
        // A dashboard.toml that omits keys deserializes them to their defaults
        // (the serde-default behaviour the migration and existing files rely on).
        let tmp = TempDir::new().unwrap();
        std::fs::write(config_path(tmp.path()), "screensaver_enabled = true\n").unwrap();
        let cfg = load(tmp.path()).unwrap();
        assert!(cfg.screensaver_enabled);
        assert!(!cfg.semantic_enabled, "omitted key defaults to false");
        assert!(
            !cfg.reports_enabled,
            "omitted in an EXISTING file stays false"
        );
        assert_eq!(cfg.screensaver_timeout_secs, 300);
        assert_eq!(cfg.screensaver_theme, ScreensaverTheme::Plain);
    }

    #[test]
    fn migrate_moves_legacy_index_keys_then_strips_them() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("meta");
        let index_dir = root.join("index");
        std::fs::create_dir_all(&index_dir).unwrap();
        // An old index config.toml with the dashboard toggles squatting in it.
        std::fs::write(
            crate::index::config::config_path(&index_dir),
            concat!(
                "schema_version = 3\n",
                "model = \"BAAI/bge-small-en-v1.5\"\n",
                "semantic_enabled = true\n",
                "reports_enabled = false\n",
                "screensaver_enabled = true\n",
                "screensaver_timeout_secs = 90\n",
                "screensaver_theme = \"matrix\"\n",
                "screensaver_pin_hash = \"3q2+7w==\"\n",
            ),
        )
        .unwrap();

        migrate_from_index_config(&root, &index_dir).unwrap();

        // dashboard.toml now carries the migrated values, byte-faithful.
        let dash = load(&root).unwrap();
        assert!(dash.semantic_enabled);
        assert!(!dash.reports_enabled);
        assert!(dash.screensaver_enabled);
        assert_eq!(dash.screensaver_timeout_secs, 90);
        assert_eq!(dash.screensaver_theme, ScreensaverTheme::Matrix);
        assert_eq!(
            dash.screensaver_pin_hash,
            Some(vec![0xde, 0xad, 0xbe, 0xef])
        );

        // The index config kept its search keys but dropped the dashboard ones.
        let raw = std::fs::read_to_string(crate::index::config::config_path(&index_dir)).unwrap();
        assert!(raw.contains("model = \"BAAI/bge-small-en-v1.5\""));
        assert!(!raw.contains("screensaver"), "old keys stripped: {raw}");
        assert!(
            !raw.contains("semantic_enabled"),
            "old keys stripped: {raw}"
        );
        assert!(!raw.contains("reports_enabled"), "old keys stripped: {raw}");

        // Idempotent: a second run is a no-op (dashboard.toml already exists).
        migrate_from_index_config(&root, &index_dir).unwrap();
        assert_eq!(load(&root).unwrap(), dash);
    }

    #[test]
    fn migrate_is_noop_for_a_brand_new_workspace() {
        // No index config.toml → nothing to migrate; `load` falls to defaults
        // (reports ON for a brand-new workspace).
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("meta");
        let index_dir = root.join("index");
        migrate_from_index_config(&root, &index_dir).unwrap();
        assert!(!config_path(&root).exists(), "no dashboard.toml written");
        assert!(
            load(&root).unwrap().reports_enabled,
            "a brand-new workspace defaults reports ON"
        );
    }

    #[test]
    fn migrate_existing_index_without_toggles_keeps_reports_off() {
        // An existing workspace whose index config omits every toggle is NOT
        // brand-new: it migrates to faithful values (reports OFF), not the
        // new-workspace default (reports ON).
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("meta");
        let index_dir = root.join("index");
        std::fs::create_dir_all(&index_dir).unwrap();
        std::fs::write(
            crate::index::config::config_path(&index_dir),
            "schema_version = 3\nmodel = \"BAAI/bge-small-en-v1.5\"\n",
        )
        .unwrap();
        migrate_from_index_config(&root, &index_dir).unwrap();
        assert!(config_path(&root).exists(), "existing workspace migrates");
        assert!(
            !load(&root).unwrap().reports_enabled,
            "existing-without-toggle stays OFF (faithful, not the new-workspace default)"
        );
    }
}
