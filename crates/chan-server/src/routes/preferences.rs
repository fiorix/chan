//! Unified server and editor preferences through `/api/config`.
//!
//! The unified surface joins EditorPrefs, ServerConfig, and the
//! chan-workspace registry. Agent/assistant preferences were removed with
//! the assistant overlay; MCP access is configured through the server
//! runtime, not through global user preferences.

use std::collections::BTreeMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chan_workspace::SearchAggression;
use serde::{Deserialize, Serialize};

use crate::config::{
    TerminalConfig, TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN, TERMINAL_SCROLLBACK_MB_MAX,
    TERMINAL_SCROLLBACK_MB_MIN,
};
use crate::error::{err, Error};
use crate::preferences::{
    BubbleOverlayMode, TerminalColorMode, TerminalColorPrefs, EDITOR_FONT_SIZE_MAX,
    EDITOR_FONT_SIZE_MIN,
};
use crate::state::AppState;
use crate::{
    BrowserSidePanes, EditorPrefs, EditorTheme, HybridSurfaceThemes, LineSpacing, PaneWidths,
    ServerConfig, ShortcutOverride, ThemeChoice,
};

/// Unified preferences shape returned over /api/workspace and /api/config.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreferencesView {
    pub editor_theme: EditorTheme,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editor_font_size: Option<u32>,
    #[serde(default)]
    pub terminal_colors: TerminalColorPrefs,
    pub attachments_dir: String,
    pub theme: ThemeChoice,
    pub pane_widths: PaneWidths,
    #[serde(default)]
    pub browser_side_panes: BrowserSidePanes,
    pub line_spacing: LineSpacing,
    pub date_format: String,
    pub strip_trailing_whitespace_on_save: bool,
    pub search_aggression: SearchAggression,
    pub terminal: TerminalConfig,
    #[serde(default)]
    pub bubble_overlay_mode: BubbleOverlayMode,
    #[serde(default)]
    pub hybrid_surface_themes: HybridSurfaceThemes,
    #[serde(default = "default_empty_pane_carousel_cycling")]
    pub empty_pane_carousel_cycling: bool,
    #[serde(default = "default_page_width_ratio")]
    pub page_width_ratio: f64,
    #[serde(default)]
    pub overlay_maximized: bool,
    #[serde(default)]
    pub cs_dismissed: bool,
    /// Per-command keyboard shortcut overrides, keyed by `Command` id.
    /// Opaque chord strings, sparse, `""` preserved verbatim; the server
    /// stores and serves them without parsing (see `ShortcutOverride`).
    #[serde(default)]
    pub shortcuts: BTreeMap<String, ShortcutOverride>,
}

fn default_empty_pane_carousel_cycling() -> bool {
    true
}

fn default_page_width_ratio() -> f64 {
    0.8
}

pub(super) fn preferences_view(state: &AppState) -> Result<PreferencesView, Error> {
    let editor = state
        .editor_prefs
        .lock()
        .map_err(|_| Error::Config("editor prefs lock poisoned".into()))?;
    let server = state
        .server_config
        .lock()
        .map_err(|_| Error::Config("server config lock poisoned".into()))?;
    Ok(PreferencesView {
        editor_theme: editor.editor_theme,
        editor_font_size: editor.editor_font_size,
        terminal_colors: editor.terminal_colors.clone(),
        attachments_dir: server.attachments_dir.clone(),
        theme: editor.theme,
        pane_widths: editor.pane_widths,
        browser_side_panes: editor.browser_side_panes,
        line_spacing: editor.line_spacing,
        date_format: editor.date_format.clone(),
        strip_trailing_whitespace_on_save: editor.strip_trailing_whitespace_on_save,
        search_aggression: server.search.aggression,
        terminal: server.terminal.clone(),
        bubble_overlay_mode: editor.bubble_overlay_mode,
        hybrid_surface_themes: editor.hybrid_surface_themes.clone(),
        empty_pane_carousel_cycling: editor.empty_pane_carousel_cycling,
        page_width_ratio: editor.page_width_ratio,
        overlay_maximized: editor.overlay_maximized,
        cs_dismissed: editor.cs_dismissed,
        shortcuts: editor.shortcuts.clone(),
    })
}

// ----- /api/config (unified GlobalConfig) --------------------------------

#[derive(Debug, Clone, Serialize)]
struct GlobalConfigView {
    revision: u64,
    preferences: PreferencesView,
    workspaces: Vec<KnownWorkspaceView>,
}

#[derive(Debug, Clone, Serialize)]
struct KnownWorkspaceView {
    path: String,
    metadata_key: String,
    /// RFC3339 timestamp.
    last_seen_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatchConfigBody {
    expected_revision: u64,
    preferences: PreferencesPatch,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct PreferencesPatch {
    // EditorPrefs owner.
    editor_theme: Option<EditorTheme>,
    #[serde(default, deserialize_with = "deserialize_nullable_editor_font_size")]
    editor_font_size: Option<Option<u32>>,
    terminal_colors: Option<TerminalColorPrefs>,
    theme: Option<ThemeChoice>,
    pane_widths: Option<PaneWidths>,
    browser_side_panes: Option<BrowserSidePanes>,
    line_spacing: Option<LineSpacing>,
    date_format: Option<String>,
    strip_trailing_whitespace_on_save: Option<bool>,
    bubble_overlay_mode: Option<BubbleOverlayMode>,
    hybrid_surface_themes: Option<HybridSurfaceThemes>,
    empty_pane_carousel_cycling: Option<bool>,
    page_width_ratio: Option<f64>,
    overlay_maximized: Option<bool>,
    cs_dismissed: Option<bool>,
    shortcuts: Option<BTreeMap<String, ShortcutOverride>>,

    // ServerConfig owner.
    attachments_dir: Option<String>,
    search_aggression: Option<SearchAggression>,
    terminal: Option<TerminalConfig>,
}

fn deserialize_nullable_editor_font_size<'de, D>(
    deserializer: D,
) -> Result<Option<Option<u32>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<u32>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreferencesOwner {
    Editor,
    Server,
}

impl PreferencesPatch {
    fn owner(&self) -> Result<PreferencesOwner, Error> {
        let editor = self.editor_theme.is_some()
            || self.editor_font_size.is_some()
            || self.terminal_colors.is_some()
            || self.theme.is_some()
            || self.pane_widths.is_some()
            || self.browser_side_panes.is_some()
            || self.line_spacing.is_some()
            || self.date_format.is_some()
            || self.strip_trailing_whitespace_on_save.is_some()
            || self.bubble_overlay_mode.is_some()
            || self.hybrid_surface_themes.is_some()
            || self.empty_pane_carousel_cycling.is_some()
            || self.page_width_ratio.is_some()
            || self.overlay_maximized.is_some()
            || self.cs_dismissed.is_some()
            || self.shortcuts.is_some();
        let server = self.attachments_dir.is_some()
            || self.search_aggression.is_some()
            || self.terminal.is_some();
        match (editor, server) {
            (true, false) => Ok(PreferencesOwner::Editor),
            (false, true) => Ok(PreferencesOwner::Server),
            (false, false) => Err(Error::BadRequest(
                "preferences patch must change at least one field".into(),
            )),
            (true, true) => Err(Error::BadRequest(
                "preferences patch cannot mix editor and server fields".into(),
            )),
        }
    }

    fn apply_editor(self, editor: &mut EditorPrefs) -> Result<(), Error> {
        if let Some(value) = self.editor_theme {
            editor.editor_theme = value;
        }
        if let Some(value) = self.editor_font_size {
            editor.editor_font_size =
                value.map(|size| size.clamp(EDITOR_FONT_SIZE_MIN, EDITOR_FONT_SIZE_MAX));
        }
        if let Some(value) = self.terminal_colors {
            editor.terminal_colors = sanitize_terminal_colors(value)?;
        }
        if let Some(value) = self.theme {
            editor.theme = value;
        }
        if let Some(value) = self.pane_widths {
            editor.pane_widths = value;
        }
        if let Some(value) = self.browser_side_panes {
            editor.browser_side_panes = value;
        }
        if let Some(value) = self.line_spacing {
            editor.line_spacing = value;
        }
        if let Some(value) = self.date_format {
            editor.date_format = value;
        }
        if let Some(value) = self.strip_trailing_whitespace_on_save {
            editor.strip_trailing_whitespace_on_save = value;
        }
        if let Some(value) = self.bubble_overlay_mode {
            editor.bubble_overlay_mode = value;
        }
        if let Some(value) = self.hybrid_surface_themes {
            editor.hybrid_surface_themes = value;
        }
        if let Some(value) = self.empty_pane_carousel_cycling {
            editor.empty_pane_carousel_cycling = value;
        }
        if let Some(value) = self.page_width_ratio {
            editor.page_width_ratio = value;
        }
        if let Some(value) = self.overlay_maximized {
            editor.overlay_maximized = value;
        }
        if let Some(value) = self.cs_dismissed {
            editor.cs_dismissed = value;
        }
        if let Some(value) = self.shortcuts {
            editor.shortcuts = value;
        }
        Ok(())
    }

    fn apply_server(self, server: &mut ServerConfig) -> Result<(), Error> {
        if let Some(value) = self.attachments_dir {
            if value.is_empty() {
                return Err(Error::BadRequest("attachments_dir cannot be empty".into()));
            }
            server.attachments_dir = value;
        }
        if let Some(value) = self.search_aggression {
            server.search.aggression = value;
        }
        if let Some(value) = self.terminal {
            server.terminal = sanitize_terminal_config(value);
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
struct ConfigConflictBody {
    error: &'static str,
    current: GlobalConfigView,
}

#[derive(Debug)]
enum PatchConfigError {
    Error(Error),
    Conflict(Box<GlobalConfigView>),
}

impl From<Error> for PatchConfigError {
    fn from(value: Error) -> Self {
        Self::Error(value)
    }
}

struct ConfigSnapshot {
    revision: u64,
    preferences: PreferencesView,
}

fn config_snapshot_locked(state: &AppState) -> Result<ConfigSnapshot, Error> {
    Ok(ConfigSnapshot {
        revision: state.config_revision.load(Ordering::Relaxed),
        preferences: preferences_view(state)?,
    })
}

fn global_config_from_snapshot(state: &AppState, snapshot: ConfigSnapshot) -> GlobalConfigView {
    let workspaces = state
        .library
        .list_workspaces()
        .into_iter()
        .map(|d| KnownWorkspaceView {
            path: d.root_path.to_string_lossy().into_owned(),
            metadata_key: d.metadata_key,
            last_seen_at: d.last_seen_at.to_rfc3339(),
        })
        .collect();
    GlobalConfigView {
        revision: snapshot.revision,
        preferences: snapshot.preferences,
        workspaces,
    }
}

fn global_config_view(state: &AppState) -> Result<GlobalConfigView, Error> {
    let serial = state
        .config_write_serial
        .lock()
        .map_err(|_| Error::Config("config write lock poisoned".into()))?;
    let snapshot = config_snapshot_locked(state)?;
    drop(serial);
    Ok(global_config_from_snapshot(state, snapshot))
}

pub async fn api_get_config(State(state): State<Arc<AppState>>) -> Response {
    match global_config_view(&state) {
        Ok(view) => Json(view).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

pub async fn api_patch_config(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PatchConfigBody>,
) -> Response {
    let result = tokio::task::spawn_blocking(move || patch_config(&state, body)).await;
    match result {
        Ok(result) => patch_config_response(result),
        Err(join) => err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
    }
}

fn patch_config_response(result: Result<GlobalConfigView, PatchConfigError>) -> Response {
    match result {
        Ok(view) => Json(view).into_response(),
        Err(PatchConfigError::Conflict(current)) => (
            StatusCode::CONFLICT,
            Json(ConfigConflictBody {
                error: "config_conflict",
                current: *current,
            }),
        )
            .into_response(),
        Err(PatchConfigError::Error(error)) => err(status_for_error(&error), error.to_string()),
    }
}

fn status_for_error(e: &Error) -> StatusCode {
    match e {
        Error::BadRequest(_) => StatusCode::BAD_REQUEST,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn patch_config(
    state: &AppState,
    body: PatchConfigBody,
) -> Result<GlobalConfigView, PatchConfigError> {
    patch_config_with_saves(state, body, EditorPrefs::save, ServerConfig::save)
}

fn patch_config_with_saves(
    state: &AppState,
    body: PatchConfigBody,
    save_editor: impl FnOnce(&EditorPrefs) -> Result<(), Error>,
    save_server: impl FnOnce(&ServerConfig) -> Result<(), Error>,
) -> Result<GlobalConfigView, PatchConfigError> {
    let owner = body.preferences.owner()?;
    let serial = state
        .config_write_serial
        .lock()
        .map_err(|_| Error::Config("config write lock poisoned".into()))?;
    let current_revision = state.config_revision.load(Ordering::Relaxed);
    if body.expected_revision != current_revision {
        let snapshot = config_snapshot_locked(state)?;
        drop(serial);
        return Err(PatchConfigError::Conflict(Box::new(
            global_config_from_snapshot(state, snapshot),
        )));
    }

    match owner {
        PreferencesOwner::Editor => {
            let mut current = state
                .editor_prefs
                .lock()
                .map_err(|_| Error::Config("editor prefs lock poisoned".into()))?;
            let mut next = current.clone();
            body.preferences.apply_editor(&mut next)?;
            save_editor(&next)?;
            *current = next;
        }
        PreferencesOwner::Server => {
            let mut current = state
                .server_config
                .lock()
                .map_err(|_| Error::Config("server config lock poisoned".into()))?;
            let mut next = current.clone();
            body.preferences.apply_server(&mut next)?;
            save_server(&next)?;
            *current = next;
        }
    }

    state.config_revision.fetch_add(1, Ordering::Relaxed);
    broadcast_config_changed(state);
    let snapshot = config_snapshot_locked(state)?;
    drop(serial);
    Ok(global_config_from_snapshot(state, snapshot))
}

/// Apply spawn-time terminal preferences, then broadcast a `config_changed`
/// frame on the per-tenant `/ws` bus so every open window re-fetches preferences
/// and reflects the change without a reload. This is shared by API writes and
/// external config reloads, keeping direct registry/control-socket spawns in
/// sync too. The synthetic frame bypasses filesystem self-write dedupe; a
/// no-subscriber `send` is the only `Err` a broadcast yields, so it is ignored.
pub(crate) fn broadcast_config_changed(state: &AppState) {
    if let Ok(config) = state.server_config.lock() {
        state
            .terminal_sessions
            .set_terminal_backend(config.terminal.ghostty);
    }
    let _ = state
        .events_tx
        .send(r#"{"kind":"config_changed"}"#.to_string());
}

fn sanitize_terminal_config(mut cfg: TerminalConfig) -> TerminalConfig {
    let defaults = TerminalConfig::default();
    if cfg.idle_timeout_secs == 0 {
        cfg.idle_timeout_secs = defaults.idle_timeout_secs;
    }
    if cfg.session_cap == 0 {
        cfg.session_cap = defaults.session_cap;
    }
    if cfg.ring_bytes == 0 {
        cfg.ring_bytes = defaults.ring_bytes;
    }
    cfg.font_size = cfg
        .font_size
        .clamp(TERMINAL_FONT_SIZE_MIN, TERMINAL_FONT_SIZE_MAX);
    // Scrollback clamps to the Settings slider
    // bounds. A literal 0 (legacy / cleared field) snaps to the
    // default so an over-eager wipe can't strand new terminals with
    // an empty scrollback; any other out-of-range value clamps to
    // the nearest slider edge.
    if cfg.scrollback_mb == 0 {
        cfg.scrollback_mb = defaults.scrollback_mb;
    } else {
        cfg.scrollback_mb = cfg
            .scrollback_mb
            .clamp(TERMINAL_SCROLLBACK_MB_MIN, TERMINAL_SCROLLBACK_MB_MAX);
    }
    // Trim accidental whitespace from a free-text TERM entry; empty
    // string falls back to the default so an over-eager Settings
    // edit can't strand new terminals without a TERM env var.
    let trimmed = cfg.default_term.trim();
    cfg.default_term = if trimmed.is_empty() {
        defaults.default_term
    } else {
        trimmed.to_string()
    };
    cfg
}

fn sanitize_terminal_colors(mut prefs: TerminalColorPrefs) -> Result<TerminalColorPrefs, Error> {
    let Some(custom) = prefs.custom.as_mut() else {
        return if prefs.mode == TerminalColorMode::Custom {
            Err(Error::BadRequest(
                "terminal_colors.custom is required in custom mode".into(),
            ))
        } else {
            Ok(prefs)
        };
    };
    custom.background = normalize_terminal_color("background", &custom.background)?;
    custom.foreground = normalize_terminal_color("foreground", &custom.foreground)?;
    custom.cursor = normalize_terminal_color("cursor", &custom.cursor)?;
    Ok(prefs)
}

fn normalize_terminal_color(field: &str, value: &str) -> Result<String, Error> {
    let invalid = || {
        Error::BadRequest(format!(
            "terminal_colors.custom.{field} must be #rgb or #rrggbb"
        ))
    };
    let hex = value.strip_prefix('#').ok_or_else(invalid)?;
    if !matches!(hex.len(), 3 | 6) || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid());
    }
    let mut normalized = String::with_capacity(7);
    normalized.push('#');
    if hex.len() == 3 {
        for byte in hex.bytes() {
            let digit = (byte as char).to_ascii_lowercase();
            normalized.push(digit);
            normalized.push(digit);
        }
    } else {
        normalized.push_str(&hex.to_ascii_lowercase());
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::test_support::make_test_state;
    use crate::terminal_sessions::{CloseReason, CreateOptions, SessionEvent};
    use axum::body::to_bytes;
    use portable_pty::PtySize;
    use serde_json::json;
    use std::sync::atomic::AtomicUsize;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    use tempfile::TempDir;

    fn to_json(view: &GlobalConfigView) -> serde_json::Value {
        serde_json::to_value(view).expect("serialize")
    }

    fn noop_save_editor(_prefs: &EditorPrefs) -> Result<(), Error> {
        Ok(())
    }

    fn noop_save_server(_config: &ServerConfig) -> Result<(), Error> {
        Ok(())
    }

    fn patch_body(expected_revision: u64, preferences: PreferencesPatch) -> PatchConfigBody {
        PatchConfigBody {
            expected_revision,
            preferences,
        }
    }

    #[test]
    fn preferences_view_has_no_assistant_subtree() {
        let state = make_test_state(false);
        let view = preferences_view(&state).expect("preferences view");
        let json = serde_json::to_value(view).expect("serialize");
        assert!(json.get("assistant").is_none());
    }

    #[test]
    fn preferences_view_shortcuts_round_trip_the_wire() {
        // Pin the shortcut-override wire the config UI and the keymap layer
        // consume: `preferences.shortcuts.<command-id>.<os>`, sparse (absent OS
        // slots omitted), empty string preserved verbatim, and a stable
        // serialize -> deserialize round-trip through the PATCH-body shape.
        let state = make_test_state(false);
        {
            let mut editor = state.editor_prefs.lock().unwrap();
            editor.shortcuts.insert(
                "app.launcher.toggle".to_string(),
                ShortcutOverride {
                    web: Some("Mod+K".to_string()),
                    macos: Some("Cmd+K".to_string()),
                    ..Default::default()
                },
            );
            editor.shortcuts.insert(
                "app.pane.mode".to_string(),
                ShortcutOverride {
                    web: Some(String::new()),
                    ..Default::default()
                },
            );
        }
        let view = preferences_view(&state).expect("preferences view");
        let json = serde_json::to_value(&view).expect("serialize");

        assert_eq!(json["shortcuts"]["app.launcher.toggle"]["web"], "Mod+K");
        assert_eq!(json["shortcuts"]["app.launcher.toggle"]["macos"], "Cmd+K");
        assert!(
            json["shortcuts"]["app.launcher.toggle"]
                .get("linux")
                .is_none(),
            "an unassigned OS slot is omitted, not null"
        );
        assert_eq!(
            json["shortcuts"]["app.pane.mode"]["web"], "",
            "the empty-string marker is preserved verbatim"
        );

        let back: PreferencesView = serde_json::from_value(json).expect("deserialize");
        assert_eq!(back.shortcuts, view.shortcuts);
    }

    #[test]
    fn broadcast_config_changed_emits_a_config_changed_frame_on_the_ws_bus() {
        // Cross-window settings sync: the SPA's /ws event store keys on a
        // frame whose `kind` is exactly "config_changed" (it then re-fetches
        // preferences). Pin that wire contract so a rename can't silently break
        // live sync. Tested directly rather than through `patch_config`, which
        // would save the real `~/.chan` preferences as a side effect.
        let state = make_test_state(false);
        let mut rx = state.events_tx.subscribe();
        broadcast_config_changed(&state);
        let frame = rx.try_recv().expect("a frame on the /ws bus");
        let json: serde_json::Value = serde_json::from_str(&frame).expect("valid json frame");
        assert_eq!(json["kind"], "config_changed");
    }

    #[tokio::test]
    async fn broadcast_config_changed_refreshes_direct_terminal_spawns() {
        let state = make_test_state(false);
        state.server_config.lock().unwrap().terminal.ghostty = true;
        broadcast_config_changed(&state);

        let mut handle = state
            .terminal_sessions
            .create(CreateOptions {
                size: PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                tab_name: None,
                tab_group: None,
                window_id: None,
                mcp_env: false,
                cwd: None,
                command: Some("printf 'CHAN_TERMINAL=<%s>\\n' \"$CHAN_TERMINAL\"".into()),
                env: Default::default(),
            })
            .expect("spawn terminal after preference refresh");
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut out = String::new();
        while !out.contains("CHAN_TERMINAL=<ghostty>") && Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(remaining, handle.rx.recv()).await {
                Ok(Ok(SessionEvent::Output(data))) => {
                    out.push_str(&String::from_utf8_lossy(&data));
                }
                Ok(Ok(_)) => {}
                Ok(Err(_)) | Err(_) => break,
            }
        }
        assert!(
            out.contains("CHAN_TERMINAL=<ghostty>"),
            "config broadcast did not refresh direct spawn preference: {out:?}"
        );
        state
            .terminal_sessions
            .close(handle.id(), CloseReason::Explicit);
    }

    #[test]
    fn sanitize_terminal_config_clamps_scrollback_and_trims_term() {
        let zeroed = sanitize_terminal_config(TerminalConfig {
            idle_timeout_secs: 0,
            session_cap: 0,
            ring_bytes: 0,
            scrollback_mb: 0,
            default_term: "  ".into(),
            ..TerminalConfig::default()
        });
        assert_eq!(zeroed, TerminalConfig::default());

        let too_high = sanitize_terminal_config(TerminalConfig {
            scrollback_mb: 9_999,
            font_size: 9_999,
            default_term: "  xterm  ".into(),
            ..TerminalConfig::default()
        });
        assert_eq!(too_high.scrollback_mb, TERMINAL_SCROLLBACK_MB_MAX);
        assert_eq!(too_high.font_size, TERMINAL_FONT_SIZE_MAX);
        assert_eq!(too_high.default_term, "xterm");

        let too_low = sanitize_terminal_config(TerminalConfig {
            scrollback_mb: 1,
            font_size: 1,
            ..TerminalConfig::default()
        });
        assert_eq!(too_low.scrollback_mb, TERMINAL_SCROLLBACK_MB_MIN);
        assert_eq!(too_low.font_size, TERMINAL_FONT_SIZE_MIN);

        let in_range = sanitize_terminal_config(TerminalConfig {
            scrollback_mb: 25,
            default_term: "tmux-256color".into(),
            ..TerminalConfig::default()
        });
        assert_eq!(in_range.scrollback_mb, 25);
        assert_eq!(in_range.default_term, "tmux-256color");
    }

    fn custom_terminal_colors(
        background: &str,
        foreground: &str,
        cursor: &str,
    ) -> TerminalColorPrefs {
        TerminalColorPrefs {
            mode: TerminalColorMode::Custom,
            custom: Some(crate::preferences::TerminalCustomColors {
                background: background.into(),
                foreground: foreground.into(),
                cursor: cursor.into(),
                contrast: crate::preferences::TerminalContrast::Auto,
            }),
        }
    }

    #[test]
    fn appearance_patch_clamps_sizes_and_normalizes_the_complete_colour_object() {
        let state = make_test_state(false);
        let view = patch_config_with_saves(
            &state,
            patch_body(
                1,
                PreferencesPatch {
                    editor_font_size: Some(Some(99)),
                    terminal_colors: Some(custom_terminal_colors("#ABC", "#DDEEFF", "#123456")),
                    ..Default::default()
                },
            ),
            noop_save_editor,
            noop_save_server,
        )
        .expect("appearance patch");

        assert_eq!(
            view.preferences.editor_font_size,
            Some(EDITOR_FONT_SIZE_MAX)
        );
        let custom = view.preferences.terminal_colors.custom.unwrap();
        assert_eq!(custom.background, "#aabbcc");
        assert_eq!(custom.foreground, "#ddeeff");
        assert_eq!(custom.cursor, "#123456");

        let cleared = patch_config_with_saves(
            &state,
            patch_body(
                view.revision,
                PreferencesPatch {
                    editor_font_size: Some(None),
                    ..Default::default()
                },
            ),
            noop_save_editor,
            noop_save_server,
        )
        .expect("clear editor font size");
        assert_eq!(cleared.preferences.editor_font_size, None);
    }

    #[test]
    fn invalid_terminal_colour_rejects_the_whole_owner_without_save_or_broadcast() {
        let state = make_test_state(false);
        let before = state.editor_prefs.lock().unwrap().clone();
        let editor_saves = AtomicUsize::new(0);
        let mut events = state.events_tx.subscribe();

        let error = patch_config_with_saves(
            &state,
            patch_body(
                1,
                PreferencesPatch {
                    editor_font_size: Some(Some(20)),
                    terminal_colors: Some(custom_terminal_colors(
                        "#112233",
                        "not-a-colour",
                        "#abcdef",
                    )),
                    ..Default::default()
                },
            ),
            |_| {
                editor_saves.fetch_add(1, Ordering::Relaxed);
                Ok(())
            },
            noop_save_server,
        )
        .expect_err("invalid colour must reject the owner write");

        let PatchConfigError::Error(Error::BadRequest(message)) = error else {
            panic!("expected field validation error");
        };
        assert!(message.contains("terminal_colors.custom.foreground"));
        assert_eq!(*state.editor_prefs.lock().unwrap(), before);
        assert_eq!(editor_saves.load(Ordering::Relaxed), 0);
        assert_eq!(state.config_revision.load(Ordering::Relaxed), 1);
        assert!(matches!(
            events.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
    }

    #[test]
    fn custom_mode_requires_a_payload_but_standard_accepts_none() {
        let missing = TerminalColorPrefs {
            mode: TerminalColorMode::Custom,
            custom: None,
        };
        assert!(sanitize_terminal_colors(missing).is_err());
        assert_eq!(
            sanitize_terminal_colors(TerminalColorPrefs::default()).unwrap(),
            TerminalColorPrefs::default()
        );
    }

    #[test]
    fn editor_font_size_patch_distinguishes_absent_from_explicit_null() {
        let absent: PatchConfigBody = serde_json::from_value(json!({
            "expected_revision": 1,
            "preferences": {"theme": "dark"}
        }))
        .unwrap();
        assert_eq!(absent.preferences.editor_font_size, None);

        let clear: PatchConfigBody = serde_json::from_value(json!({
            "expected_revision": 1,
            "preferences": {"editor_font_size": null}
        }))
        .unwrap();
        assert_eq!(clear.preferences.editor_font_size, Some(None));
        assert_eq!(clear.preferences.owner().unwrap(), PreferencesOwner::Editor);
    }

    #[test]
    fn global_config_view_keeps_host_fields_on_local_serve() {
        let state = make_test_state(false);
        let view = global_config_view(&state).expect("global config view");
        let json = to_json(&view);
        assert_eq!(json["revision"], 1);
        assert!(json["workspaces"].is_array());
        assert_eq!(json["preferences"]["terminal"]["secret_masking"], true);
        assert_eq!(
            json["preferences"]["terminal"]["secret_mask_suffixes"][0],
            "TOKEN"
        );
    }

    #[tokio::test]
    async fn disjoint_stale_route_updates_conflict_then_both_survive() {
        let state = make_test_state(false);
        let first = patch_config_with_saves(
            &state,
            patch_body(
                1,
                PreferencesPatch {
                    theme: Some(ThemeChoice::Dark),
                    ..Default::default()
                },
            ),
            noop_save_editor,
            noop_save_server,
        )
        .expect("first update");
        assert_eq!(first.revision, 2);

        let conflict = patch_config_with_saves(
            &state,
            patch_body(
                1,
                PreferencesPatch {
                    date_format: Some("us".to_string()),
                    ..Default::default()
                },
            ),
            noop_save_editor,
            noop_save_server,
        )
        .expect_err("stale update must conflict");
        let PatchConfigError::Conflict(current) = conflict else {
            panic!("expected conflict");
        };
        assert_eq!(current.revision, 2);
        assert_eq!(current.preferences.theme, ThemeChoice::Dark);

        let response = patch_config_response(Err(PatchConfigError::Conflict(current.clone())));
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = to_bytes(response.into_body(), 8192)
            .await
            .expect("read conflict body");
        let json: serde_json::Value = serde_json::from_slice(&body).expect("conflict JSON");
        assert_eq!(json["error"], "config_conflict");
        assert_eq!(json["current"]["revision"], 2);
        assert_eq!(json["current"]["preferences"]["theme"], "dark");

        let retried = patch_config_with_saves(
            &state,
            patch_body(
                current.revision,
                PreferencesPatch {
                    date_format: Some("us".to_string()),
                    ..Default::default()
                },
            ),
            noop_save_editor,
            noop_save_server,
        )
        .expect("retry against current revision");

        assert_eq!(retried.revision, 3);
        assert_eq!(retried.preferences.theme, ThemeChoice::Dark);
        assert_eq!(retried.preferences.date_format, "us");
    }

    #[test]
    fn same_field_stale_update_returns_current_value() {
        let state = make_test_state(false);
        patch_config_with_saves(
            &state,
            patch_body(
                1,
                PreferencesPatch {
                    theme: Some(ThemeChoice::Dark),
                    ..Default::default()
                },
            ),
            noop_save_editor,
            noop_save_server,
        )
        .expect("first update");

        let error = patch_config_with_saves(
            &state,
            patch_body(
                1,
                PreferencesPatch {
                    theme: Some(ThemeChoice::Light),
                    ..Default::default()
                },
            ),
            noop_save_editor,
            noop_save_server,
        )
        .expect_err("same-field stale update must conflict");
        let PatchConfigError::Conflict(current) = error else {
            panic!("expected conflict");
        };
        assert_eq!(current.revision, 2);
        assert_eq!(current.preferences.theme, ThemeChoice::Dark);
    }

    #[test]
    fn empty_mixed_unknown_and_workspaces_patches_are_rejected() {
        let state = make_test_state(false);
        for preferences in [
            PreferencesPatch::default(),
            PreferencesPatch {
                theme: Some(ThemeChoice::Dark),
                attachments_dir: Some("media".to_string()),
                ..Default::default()
            },
        ] {
            let error = patch_config_with_saves(
                &state,
                patch_body(1, preferences),
                noop_save_editor,
                noop_save_server,
            )
            .expect_err("invalid ownership shape must fail");
            assert!(matches!(
                error,
                PatchConfigError::Error(Error::BadRequest(_))
            ));
        }

        for body in [
            json!({
                "expected_revision": 1,
                "preferences": {"unknown": true}
            }),
            json!({
                "expected_revision": 1,
                "preferences": {"theme": "dark"},
                "workspaces": []
            }),
        ] {
            assert!(
                serde_json::from_value::<PatchConfigBody>(body).is_err(),
                "unknown and workspaces input must fail deserialization"
            );
        }
    }

    #[test]
    fn save_failure_preserves_memory_disk_revision_and_broadcast_count() {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path().join("preferences.toml");
        let state = make_test_state(false);
        let before = state.editor_prefs.lock().unwrap().clone();
        before.save_to(&path).expect("seed persisted prefs");
        let before_disk = std::fs::read(&path).expect("read seeded prefs");
        let mut rx = state.events_tx.subscribe();

        let error = patch_config_with_saves(
            &state,
            patch_body(
                1,
                PreferencesPatch {
                    theme: Some(ThemeChoice::Dark),
                    ..Default::default()
                },
            ),
            |_prefs| Err(Error::Config("injected save failure".into())),
            noop_save_server,
        )
        .expect_err("save must fail");

        assert!(matches!(error, PatchConfigError::Error(Error::Config(_))));
        assert_eq!(*state.editor_prefs.lock().unwrap(), before);
        assert_eq!(
            std::fs::read(path).expect("read prefs after failure"),
            before_disk
        );
        assert_eq!(state.config_revision.load(Ordering::Relaxed), 1);
        assert!(matches!(
            rx.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
    }

    #[test]
    fn successful_change_saves_one_owner_increments_once_and_broadcasts_once() {
        let state = make_test_state(false);
        let editor_saves = AtomicUsize::new(0);
        let server_saves = AtomicUsize::new(0);
        let mut rx = state.events_tx.subscribe();

        let view = patch_config_with_saves(
            &state,
            patch_body(
                1,
                PreferencesPatch {
                    attachments_dir: Some("media".to_string()),
                    ..Default::default()
                },
            ),
            |_| {
                editor_saves.fetch_add(1, Ordering::Relaxed);
                Ok(())
            },
            |_| {
                server_saves.fetch_add(1, Ordering::Relaxed);
                Ok(())
            },
        )
        .expect("server config update");

        assert_eq!(view.revision, 2);
        assert_eq!(view.preferences.attachments_dir, "media");
        assert_eq!(editor_saves.load(Ordering::Relaxed), 0);
        assert_eq!(server_saves.load(Ordering::Relaxed), 1);
        assert!(rx.try_recv().is_ok());
        assert!(matches!(
            rx.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
    }

    #[test]
    fn external_reload_racing_api_write_is_serialized_and_counted() {
        let dir = TempDir::new().expect("tempdir");
        let external = EditorPrefs {
            theme: ThemeChoice::Light,
            ..Default::default()
        };
        external
            .save_to(&dir.path().join("preferences.toml"))
            .expect("write external prefs");

        let state = make_test_state(false);
        let mut events = state.events_tx.subscribe();
        let (save_entered_tx, save_entered_rx) = mpsc::channel();
        let (release_save_tx, release_save_rx) = mpsc::channel();
        let api_state = state.clone();
        let api_write = std::thread::spawn(move || {
            patch_config_with_saves(
                &api_state,
                patch_body(
                    1,
                    PreferencesPatch {
                        theme: Some(ThemeChoice::Dark),
                        ..Default::default()
                    },
                ),
                move |_| {
                    save_entered_tx.send(()).expect("signal save entry");
                    release_save_rx.recv().expect("release save");
                    Ok(())
                },
                noop_save_server,
            )
        });

        save_entered_rx.recv().expect("API reached durable save");
        assert!(
            state.config_write_serial.try_lock().is_err(),
            "API write must hold the config serialization boundary through save"
        );
        let reload_state = state.clone();
        let reload_dir = dir.path().to_path_buf();
        let reload = std::thread::spawn(move || {
            crate::config_watch::reload_editor_prefs_for_test(&reload_dir, &reload_state);
        });
        release_save_tx.send(()).expect("release API save");

        let api_view = api_write.join().expect("API thread").expect("API update");
        reload.join().expect("reload thread");

        assert_eq!(api_view.revision, 2);
        assert_eq!(api_view.preferences.theme, ThemeChoice::Dark);
        assert_eq!(state.editor_prefs.lock().unwrap().theme, ThemeChoice::Light);
        assert_eq!(state.config_revision.load(Ordering::Relaxed), 3);
        assert!(matches!(
            events.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(1))
        ));
        assert!(events.try_recv().is_ok());
        assert!(matches!(
            events.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
    }
}
