//! Editor preferences: the fields that don't have another home.
//!
//! Most "preferences" the Settings UI surfaces already live in
//! existing config files:
//!
//! - `attachments_dir`: ServerConfig
//! - `workspaces`: chan-workspace's Registry
//!
//! What's left lives here, persisted to
//! `<config>/chan/preferences.toml`:
//!
//!   - editor_theme (github / google_docs / word)
//!   - editor_font_size (optional absolute body size)
//!   - terminal_colors (standard or custom terminal colour set)
//!   - theme  (system / light / dark)
//!   - pane_widths (inspector / graph / file-browser sidebars)
//!   - browser_side_panes (left / right docked file-browser state)
//!   - line_spacing (standard / compact; legacy `tight` deserializes as
//!     compact)
//!   - date_format (id; UI-side mapping in dateFormats.ts)
//!   - strip_trailing_whitespace_on_save
//!   - bubble_overlay_mode (stack / tray for watcher notifications)
//!   - empty_pane_carousel_cycling (auto-rotate the empty-pane
//!     carousel; per-user toggle, default true)
//!   - page_width_ratio (editor page-width cap as a ratio of the
//!     window width, (0, 1]; migrated from the SPA
//!     `chan.pageWidth.ratio` localStorage so it lives in the library)
//!   - overlay_maximized (global overlay-maximize toggle; migrated
//!     from the SPA `chan.overlayMaximized` localStorage)
//!   - cs_dismissed (the `cs` terminal-alias offer was dismissed;
//!     migrated from the SPA `chan.csLinkDismissed` localStorage)
//!   - hybrid_surface_themes (optional body-theme overrides for
//!     Hybrid Editor / Terminal / File Browser / Graph / Dashboard)
//!   - shortcuts (per-command keyboard overrides, keyed by Command id,
//!     one optional chord per platform; a local-machine part that travels
//!     with the client, see [`ShortcutOverride`])
//!
//! The Preferences view returned over /api/workspace and /api/config is
//! assembled in lib.rs by joining EditorPrefs with ServerConfig.
//! PATCH /api/config accepts a revisioned partial update for exactly
//! one of those owners.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::Error;

pub const EDITOR_FONT_SIZE_MIN: u32 = 10;
pub const EDITOR_FONT_SIZE_MAX: u32 = 32;

/// Fields persisted to `<config>/chan/preferences.toml`. A fresh
/// install defaults to the GitHub editor theme so the renderer
/// matches what most users expect from a markdown editor without
/// any further configuration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EditorPrefs {
    #[serde(default)]
    pub editor_theme: EditorTheme,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editor_font_size: Option<u32>,
    #[serde(default)]
    pub terminal_colors: TerminalColorPrefs,
    #[serde(default)]
    pub theme: ThemeChoice,
    #[serde(default)]
    pub pane_widths: PaneWidths,
    #[serde(default)]
    pub browser_side_panes: BrowserSidePanes,
    #[serde(default)]
    pub line_spacing: LineSpacing,
    #[serde(default = "default_date_format")]
    pub date_format: String,
    #[serde(default)]
    pub strip_trailing_whitespace_on_save: bool,
    #[serde(default)]
    pub bubble_overlay_mode: BubbleOverlayMode,
    #[serde(default)]
    pub hybrid_surface_themes: HybridSurfaceThemes,
    /// Auto-rotate the empty-pane carousel. Default true so
    /// first-launch behaviour matches the original implementation;
    /// users who want a stationary welcome state toggle it off and
    /// the choice persists. Pointer-hover-pause remains independent
    /// of this flag.
    #[serde(default = "default_empty_pane_carousel_cycling")]
    pub empty_pane_carousel_cycling: bool,
    /// Editor page-width cap as a ratio of the window width, in (0, 1]
    /// (1.0 = no cap). Migrated from the SPA `chan.pageWidth.ratio`
    /// localStorage so the setting lives in the library and travels with
    /// it. The SPA clamps to its slider bounds [0.25, 1.0] on read; the
    /// value is stored verbatim here (mirrors the other prefs: storage,
    /// not validation).
    #[serde(default = "default_page_width_ratio")]
    pub page_width_ratio: f64,
    /// Global overlay-maximize toggle (widens every OverlayShell panel).
    /// Migrated from the SPA `chan.overlayMaximized` localStorage so it
    /// lives in the library.
    #[serde(default)]
    pub overlay_maximized: bool,
    /// The `cs` terminal-alias offer (PreflightOverlay) was dismissed.
    /// Migrated from the SPA `chan.csLinkDismissed` localStorage so the
    /// dismissal lives in the library. Default false (the offer shows
    /// until dismissed).
    #[serde(default)]
    pub cs_dismissed: bool,
    /// Per-command keyboard shortcut overrides, keyed by `Command` id
    /// (`state/commands.ts`). A local-machine part under the per-OS
    /// shortcut model: the desktop client's overrides travel to every
    /// devserver it reaches; a devserver's own table serves that
    /// devserver's browser clients. Sparse and opaque to the server (see
    /// [`ShortcutOverride`]). Skipped from the file when empty so an
    /// unconfigured library writes no `[shortcuts]` table.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub shortcuts: BTreeMap<String, ShortcutOverride>,
}

/// One command's shortcut override: an optional chord per platform. The
/// running CLIENT's platform selects which field applies (a browser uses
/// `web`, chan-desktop uses its native-OS field). Chord strings are stored
/// verbatim in the app's registry grammar (the `Mod`-token form, e.g.
/// `"Mod+K"`); the server does NO chord parsing or validation, and an empty
/// string is preserved verbatim rather than coerced to absent (reserved as
/// a future "suppressed" marker). Sparse: only the platforms a user
/// assigned are present, and an absent slot falls through to the
/// compile-time default.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShortcutOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub macos: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linux: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub windows: Option<String>,
}

fn default_empty_pane_carousel_cycling() -> bool {
    true
}

/// Mirrors the SPA `DEFAULT_RATIO` in `pageWidth.svelte.ts`: 80% leaves a
/// clear off-page band on each side, matching the document-style page look.
fn default_page_width_ratio() -> f64 {
    0.8
}

impl Default for EditorPrefs {
    fn default() -> Self {
        Self {
            editor_theme: EditorTheme::default(),
            editor_font_size: None,
            terminal_colors: TerminalColorPrefs::default(),
            theme: ThemeChoice::default(),
            pane_widths: PaneWidths::default(),
            browser_side_panes: BrowserSidePanes::default(),
            line_spacing: LineSpacing::default(),
            date_format: default_date_format(),
            strip_trailing_whitespace_on_save: false,
            bubble_overlay_mode: BubbleOverlayMode::default(),
            hybrid_surface_themes: HybridSurfaceThemes::default(),
            empty_pane_carousel_cycling: default_empty_pane_carousel_cycling(),
            page_width_ratio: default_page_width_ratio(),
            overlay_maximized: false,
            cs_dismissed: false,
            shortcuts: BTreeMap::new(),
        }
    }
}

/// Editor theme. Workspaces the markdown renderer + source view
/// typography and chrome (headings, body, code blocks, blockquotes,
/// tables). Light/dark variants are picked from the active
/// `ThemeChoice`; density from `LineSpacing`. App chrome
/// (toolbar, panes, status bar) is not affected.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EditorTheme {
    #[default]
    Github,
    GoogleDocs,
    Word,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalColorPrefs {
    #[serde(default)]
    pub mode: TerminalColorMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom: Option<TerminalCustomColors>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalColorMode {
    #[default]
    Standard,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalCustomColors {
    pub background: String,
    pub foreground: String,
    pub cursor: String,
    pub contrast: TerminalContrast,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalContrast {
    #[default]
    Auto,
    Dark,
    Light,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeChoice {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SurfaceThemeChoice {
    Light,
    Dark,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HybridSurfaceThemes {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editor: Option<SurfaceThemeChoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<SurfaceThemeChoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser: Option<SurfaceThemeChoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph: Option<SurfaceThemeChoice>,
    // Configs on disk may spell this key `infographics`; the alias loads
    // them and the next save flushes the canonical `dashboard` token (the
    // frontend keys it `dashboard`). The shim self-erodes, like
    // `line_spacing`'s `tight`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "infographics"
    )]
    pub dashboard: Option<SurfaceThemeChoice>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaneWidths {
    pub inspector: u32,
    pub graph: u32,
    pub browser: u32,
    // Per-field default so older preferences.toml (written before the
    // search inspector got its own width slot) load cleanly.
    #[serde(default = "default_search_width")]
    pub search: u32,
    // Per-field default so older preferences.toml (written before the
    // outline pane was split out of the right-side inspector) load
    // cleanly. Width of the left-side outline pane in the file editor.
    #[serde(default = "default_outline_width")]
    pub outline: u32,
}

impl Default for PaneWidths {
    // Mirrors web/packages/workspace-app/src/state/store.svelte.ts DEFAULT_PANE_WIDTHS.
    fn default() -> Self {
        Self {
            inspector: 220,
            graph: 260,
            browser: 240,
            search: default_search_width(),
            outline: default_outline_width(),
        }
    }
}

fn default_search_width() -> u32 {
    280
}

fn default_outline_width() -> u32 {
    220
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserSidePanes {
    pub left: bool,
    pub right: bool,
}

impl Default for BrowserSidePanes {
    /// A new workspace opens with just the empty pane: no docked
    /// File Browser on either side. The SPA's `browserSidePanes`
    /// default mirrors this shape. Users who explicitly toggle a
    /// dock on keep their setting (serde reads their persisted
    /// preferences before this default kicks in).
    fn default() -> Self {
        Self {
            left: false,
            right: false,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BubbleOverlayMode {
    #[default]
    Stack,
    Tray,
}

/// Editor density. `Standard` is the roomier default Google Docs /
/// Word-style spacing; `Compact` tightens prose + list line-height
/// for the Google Docs "single" look. The legacy `tight` value that
/// older workspaces wrote to preferences.toml deserializes as
/// `Compact` so existing config files load without manual migration;
/// the next save flushes the canonical `compact` token to disk.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LineSpacing {
    #[default]
    Standard,
    #[serde(alias = "tight")]
    Compact,
}

fn default_date_format() -> String {
    // Matches the editor's `dateFormats.ts` default.
    "iso".into()
}

impl EditorPrefs {
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
}

/// `~/.chan/preferences.toml` on desktop. iOS / Android pass an
/// explicit path via `load_from` / `save_to` since their sandbox
/// dir isn't `chan_workspace::paths::config_dir`.
pub fn default_path() -> PathBuf {
    chan_workspace::paths::config_dir().join("preferences.toml")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn browser_side_panes_default_is_undocked() {
        // A new workspace opens with just the empty pane: both
        // docks off. Mirrors the SPA `browserSidePanes` default.
        let bsp = BrowserSidePanes::default();
        assert!(!bsp.left);
        assert!(!bsp.right);
    }

    #[test]
    fn editor_prefs_default_carries_undocked_fb() {
        // Cross-check: the prefs-level default also keeps both
        // docks off so a missing preferences.toml produces the
        // same first-boot UX as a fresh one.
        let prefs = EditorPrefs::default();
        assert!(!prefs.browser_side_panes.left);
        assert!(!prefs.browser_side_panes.right);
    }

    #[test]
    fn default_round_trips() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("preferences.toml");
        let prefs = EditorPrefs::default();
        prefs.save_to(&p).unwrap();
        let loaded = EditorPrefs::load_from(&p).unwrap();
        assert_eq!(prefs, loaded);
        assert_eq!(loaded.editor_font_size, None);
        assert_eq!(loaded.terminal_colors, TerminalColorPrefs::default());
    }

    #[test]
    fn appearance_preferences_round_trip_with_dormant_custom_colours() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("preferences.toml");
        let prefs = EditorPrefs {
            editor_font_size: Some(20),
            terminal_colors: TerminalColorPrefs {
                mode: TerminalColorMode::Standard,
                custom: Some(TerminalCustomColors {
                    background: "#112233".into(),
                    foreground: "#ddeeff".into(),
                    cursor: "#abcdef".into(),
                    contrast: TerminalContrast::Auto,
                }),
            },
            ..Default::default()
        };

        prefs.save_to(&path).unwrap();
        let loaded = EditorPrefs::load_from(&path).unwrap();
        assert_eq!(loaded, prefs);
        let saved = std::fs::read_to_string(path).unwrap();
        assert!(saved.contains("editor_font_size = 20"), "got: {saved}");
        assert!(saved.contains("mode = \"standard\""), "got: {saved}");
        assert!(saved.contains("background = \"#112233\""), "got: {saved}");
    }

    #[test]
    fn missing_file_returns_default() {
        let tmp = TempDir::new().unwrap();
        let prefs = EditorPrefs::load_from(&tmp.path().join("nope.toml")).unwrap();
        assert_eq!(prefs, EditorPrefs::default());
    }

    #[test]
    fn partial_file_fills_defaults() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("preferences.toml");
        std::fs::write(&p, "date_format = \"long\"\n").unwrap();
        let prefs = EditorPrefs::load_from(&p).unwrap();
        assert_eq!(prefs.date_format, "long");
        assert_eq!(prefs.theme, ThemeChoice::System);
    }

    #[test]
    fn pane_widths_partial_fills_missing_defaults() {
        // A preferences.toml that omits some pane-width slots must
        // still load, with the missing slots resolved to their
        // current defaults. Guards against the partial-config
        // resilience contract for `[pane_widths]`.
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("preferences.toml");
        std::fs::write(
            &p,
            "[pane_widths]\ninspector = 240\ngraph = 300\nbrowser = 250\n",
        )
        .unwrap();
        let prefs = EditorPrefs::load_from(&p).unwrap();
        assert_eq!(prefs.pane_widths.inspector, 240);
        assert_eq!(prefs.pane_widths.graph, 300);
        assert_eq!(prefs.pane_widths.browser, 250);
        assert_eq!(prefs.pane_widths.search, default_search_width());
        assert_eq!(prefs.pane_widths.outline, default_outline_width());
    }

    #[test]
    fn theme_serializes_lowercase() {
        let prefs = EditorPrefs {
            theme: ThemeChoice::Dark,
            ..Default::default()
        };
        let s = toml::to_string(&prefs).unwrap();
        assert!(s.contains("theme = \"dark\""), "got: {s}");
    }

    #[test]
    fn editor_theme_defaults_to_github_and_serializes_snake_case() {
        let prefs = EditorPrefs::default();
        assert_eq!(prefs.editor_theme, EditorTheme::Github);
        let prefs = EditorPrefs {
            editor_theme: EditorTheme::GoogleDocs,
            ..Default::default()
        };
        let s = toml::to_string(&prefs).unwrap();
        assert!(s.contains("editor_theme = \"google_docs\""), "got: {s}");
    }

    #[test]
    fn line_spacing_default_is_standard() {
        // The default is observable on a fresh workspace that never wrote
        // a preferences.toml; lock it down so a future refactor that
        // re-orders the variants doesn't silently change behavior.
        let prefs = EditorPrefs::default();
        assert_eq!(prefs.line_spacing, LineSpacing::Standard);
    }

    #[test]
    fn line_spacing_serializes_canonical_tokens() {
        // Wire form must use the variant's lowercase name; the
        // legacy `tight` token is read-only via #[serde(alias)] and
        // must never be emitted on save.
        let standard = toml::to_string(&EditorPrefs {
            line_spacing: LineSpacing::Standard,
            ..Default::default()
        })
        .unwrap();
        assert!(
            standard.contains("line_spacing = \"standard\""),
            "got: {standard}"
        );
        let compact = toml::to_string(&EditorPrefs {
            line_spacing: LineSpacing::Compact,
            ..Default::default()
        })
        .unwrap();
        assert!(
            compact.contains("line_spacing = \"compact\""),
            "got: {compact}"
        );
        assert!(
            !compact.contains("\"tight\""),
            "compact serializes as `tight`: {compact}"
        );
    }

    #[test]
    fn line_spacing_legacy_tight_loads_as_compact() {
        // Older workspaces have `line_spacing = "tight"` on disk.
        // The serde alias lets those files load without manual
        // migration; the next save flushes the canonical `compact`
        // token, so this compatibility shim self-erodes over time.
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("preferences.toml");
        std::fs::write(&p, "line_spacing = \"tight\"\n").unwrap();
        let prefs = EditorPrefs::load_from(&p).unwrap();
        assert_eq!(prefs.line_spacing, LineSpacing::Compact);
        // Sanity: re-saving emits the canonical token.
        prefs.save_to(&p).unwrap();
        let saved = std::fs::read_to_string(&p).unwrap();
        assert!(saved.contains("line_spacing = \"compact\""), "got: {saved}");
    }

    #[test]
    fn line_spacing_compact_loads_as_compact() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("preferences.toml");
        std::fs::write(&p, "line_spacing = \"compact\"\n").unwrap();
        let prefs = EditorPrefs::load_from(&p).unwrap();
        assert_eq!(prefs.line_spacing, LineSpacing::Compact);
    }

    #[test]
    fn empty_pane_carousel_cycling_defaults_true_and_round_trips() {
        // Fresh install defaults to true so the carousel
        // auto-rotates; older preferences files don't carry the
        // field, and serde's default fills it in on load.
        // Re-saving promotes the default into the file.
        let prefs = EditorPrefs::default();
        assert!(prefs.empty_pane_carousel_cycling);

        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("preferences.toml");
        std::fs::write(&p, "theme = \"dark\"\n").unwrap();
        let loaded = EditorPrefs::load_from(&p).unwrap();
        assert!(loaded.empty_pane_carousel_cycling);

        let stopped = EditorPrefs {
            empty_pane_carousel_cycling: false,
            ..Default::default()
        };
        stopped.save_to(&p).unwrap();
        let saved = std::fs::read_to_string(&p).unwrap();
        assert!(
            saved.contains("empty_pane_carousel_cycling = false"),
            "got: {saved}"
        );
        let reloaded = EditorPrefs::load_from(&p).unwrap();
        assert!(!reloaded.empty_pane_carousel_cycling);
    }

    #[test]
    fn migrated_settings_defaults_and_round_trip() {
        // Fresh install defaults for the migrated localStorage settings:
        // 80% page-width ratio, overlay not maximized, cs offer not
        // dismissed (mirrors the SPA defaults).
        let prefs = EditorPrefs::default();
        assert_eq!(prefs.page_width_ratio, 0.8);
        assert!(!prefs.overlay_maximized);
        assert!(!prefs.cs_dismissed);

        // Older preferences.toml omits the fields; serde fills the
        // defaults on load.
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("preferences.toml");
        std::fs::write(&p, "theme = \"dark\"\n").unwrap();
        let loaded = EditorPrefs::load_from(&p).unwrap();
        assert_eq!(loaded.page_width_ratio, 0.8);
        assert!(!loaded.overlay_maximized);
        assert!(!loaded.cs_dismissed);

        // Non-default values persist and round-trip verbatim.
        let custom = EditorPrefs {
            page_width_ratio: 0.5,
            overlay_maximized: true,
            cs_dismissed: true,
            ..Default::default()
        };
        custom.save_to(&p).unwrap();
        let saved = std::fs::read_to_string(&p).unwrap();
        assert!(saved.contains("page_width_ratio = 0.5"), "got: {saved}");
        assert!(saved.contains("overlay_maximized = true"), "got: {saved}");
        assert!(saved.contains("cs_dismissed = true"), "got: {saved}");
        let reloaded = EditorPrefs::load_from(&p).unwrap();
        assert_eq!(reloaded.page_width_ratio, 0.5);
        assert!(reloaded.overlay_maximized);
        assert!(reloaded.cs_dismissed);
    }

    #[test]
    fn shortcuts_round_trip_sparse_and_preserve_empty_string() {
        // The keymap override table is sparse (only assigned slots), stores
        // chord strings verbatim, and preserves an empty string (the reserved
        // "suppressed" marker) rather than coercing it to absent.
        let mut shortcuts = BTreeMap::new();
        shortcuts.insert(
            "app.launcher.toggle".to_string(),
            ShortcutOverride {
                web: Some("Mod+K".to_string()),
                macos: Some("Cmd+K".to_string()),
                ..Default::default()
            },
        );
        shortcuts.insert(
            "app.pane.mode".to_string(),
            ShortcutOverride {
                web: Some(String::new()),
                ..Default::default()
            },
        );
        let prefs = EditorPrefs {
            shortcuts: shortcuts.clone(),
            ..Default::default()
        };

        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("preferences.toml");
        prefs.save_to(&p).unwrap();
        let raw = std::fs::read_to_string(&p).unwrap();
        // Command ids carry dots, so the table header quotes the key; only
        // assigned slots appear (linux/windows absent), and the empty-string
        // slot is written verbatim.
        assert!(raw.contains("[shortcuts.\"app.launcher.toggle\"]"), "{raw}");
        assert!(raw.contains("web = \"Mod+K\""), "{raw}");
        assert!(raw.contains("web = \"\""), "empty string preserved: {raw}");
        assert!(!raw.contains("linux"), "absent slots stay absent: {raw}");

        let loaded = EditorPrefs::load_from(&p).unwrap();
        assert_eq!(loaded.shortcuts, shortcuts);
    }

    #[test]
    fn empty_shortcuts_writes_no_table() {
        // An unconfigured library writes no `[shortcuts]` table.
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("preferences.toml");
        EditorPrefs::default().save_to(&p).unwrap();
        let raw = std::fs::read_to_string(&p).unwrap();
        assert!(
            !raw.contains("shortcuts"),
            "no shortcuts table when empty: {raw}"
        );
    }

    #[test]
    fn hybrid_dashboard_round_trips_and_migrates_legacy_infographics() {
        // The frontend keys this surface `dashboard`; the field must
        // round-trip that key. The pre-rename field name dropped a
        // `dashboard` override on the way in, losing the user's choice.
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("preferences.toml");
        std::fs::write(&p, "[hybrid_surface_themes]\ndashboard = \"dark\"\n").unwrap();
        let prefs = EditorPrefs::load_from(&p).unwrap();
        assert_eq!(
            prefs.hybrid_surface_themes.dashboard,
            Some(SurfaceThemeChoice::Dark)
        );
        // Saving emits the canonical `dashboard` token, never `infographics`.
        prefs.save_to(&p).unwrap();
        let saved = std::fs::read_to_string(&p).unwrap();
        assert!(saved.contains("dashboard = \"dark\""), "got: {saved}");
        assert!(!saved.contains("infographics"), "got: {saved}");

        // A config written before the rename keyed it `infographics`. The
        // serde alias migrates it into `dashboard` on load (so the override
        // survives), and the next save flushes the canonical token.
        std::fs::write(&p, "[hybrid_surface_themes]\ninfographics = \"light\"\n").unwrap();
        let migrated = EditorPrefs::load_from(&p).unwrap();
        assert_eq!(
            migrated.hybrid_surface_themes.dashboard,
            Some(SurfaceThemeChoice::Light)
        );
        migrated.save_to(&p).unwrap();
        let resaved = std::fs::read_to_string(&p).unwrap();
        assert!(resaved.contains("dashboard = \"light\""), "got: {resaved}");
        assert!(!resaved.contains("infographics"), "got: {resaved}");
    }
}
