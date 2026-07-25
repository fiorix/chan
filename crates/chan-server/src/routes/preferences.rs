//! Unified server and editor preferences through `/api/config`.
//!
//! The unified surface joins EditorPrefs, ServerConfig, and the
//! chan-workspace registry. Agent/assistant preferences were removed with
//! the assistant overlay; MCP access is configured through the server
//! runtime, not through global user preferences.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chan_workspace::SearchAggression;
use serde::{Deserialize, Serialize};

use crate::config::{TerminalConfig, TERMINAL_SCROLLBACK_MB_MAX, TERMINAL_SCROLLBACK_MB_MIN};
use crate::error::{err, Error};
use crate::preferences::BubbleOverlayMode;
use crate::state::AppState;
use crate::{
    BrowserSidePanes, EditorTheme, HybridSurfaceThemes, LineSpacing, PaneWidths, ShortcutOverride,
    ThemeChoice,
};

/// Unified preferences shape returned over /api/workspace and /api/config.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreferencesView {
    pub editor_theme: EditorTheme,
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

#[derive(Serialize)]
struct GlobalConfigView {
    preferences: PreferencesView,
    workspaces: Vec<KnownWorkspaceView>,
}

#[derive(Serialize)]
struct KnownWorkspaceView {
    path: String,
    metadata_key: String,
    /// RFC3339 timestamp.
    last_seen_at: String,
}

#[derive(Deserialize)]
pub struct PatchConfigBody {
    /// Whole-block replacement. Frontend sends the entire GlobalConfig
    /// on every save.
    #[serde(default)]
    preferences: Option<PreferencesView>,
    /// Read-only on PATCH: workspaces are managed by path through the
    /// CLI (`chan add` / `remove`). Frontend sends the field for
    /// round-tripping; we just ignore it.
    #[serde(default)]
    #[allow(dead_code)]
    workspaces: Option<serde_json::Value>,
}

fn global_config_view(state: &AppState) -> Result<GlobalConfigView, Error> {
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
    Ok(GlobalConfigView {
        preferences: preferences_view(state)?,
        workspaces,
    })
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
        Ok(Ok(view)) => Json(view).into_response(),
        Ok(Err(e)) => err(status_for_error(&e), e.to_string()),
        Err(join) => err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
    }
}

fn status_for_error(e: &Error) -> StatusCode {
    match e {
        Error::BadRequest(_) => StatusCode::BAD_REQUEST,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn patch_config(state: &AppState, body: PatchConfigBody) -> Result<GlobalConfigView, Error> {
    if let Some(prefs) = body.preferences {
        apply_preferences(state, prefs)?;
        // Tell every open window of this tenant a setting changed, so each
        // re-fetches preferences and reflects it live (theme, fonts, pane
        // widths, ...) instead of going stale until a reload.
        broadcast_config_changed(state);
    }
    global_config_view(state)
}

/// Broadcast a `config_changed` frame on the per-tenant `/ws` bus so every open
/// window re-fetches preferences and reflects the change without a reload. The
/// SPA's event store handles the `config_changed` kind by scheduling a
/// workspace refresh. This rides the same broadcast channel as filesystem
/// events but bypasses the self-write dedupe (it is a synthetic frame, not a
/// file event), so sibling windows reliably see config flips. A no-subscriber
/// `send` is the only `Err` a broadcast yields, so it is ignored.
pub(crate) fn broadcast_config_changed(state: &AppState) {
    let _ = state
        .events_tx
        .send(r#"{"kind":"config_changed"}"#.to_string());
}

fn apply_preferences(state: &AppState, view: PreferencesView) -> Result<(), Error> {
    {
        let mut editor = state
            .editor_prefs
            .lock()
            .map_err(|_| Error::Config("editor prefs lock poisoned".into()))?;
        editor.editor_theme = view.editor_theme;
        editor.theme = view.theme;
        editor.pane_widths = view.pane_widths;
        editor.browser_side_panes = view.browser_side_panes;
        editor.line_spacing = view.line_spacing;
        editor.date_format = view.date_format;
        editor.strip_trailing_whitespace_on_save = view.strip_trailing_whitespace_on_save;
        editor.bubble_overlay_mode = view.bubble_overlay_mode;
        editor.hybrid_surface_themes = view.hybrid_surface_themes;
        editor.empty_pane_carousel_cycling = view.empty_pane_carousel_cycling;
        editor.page_width_ratio = view.page_width_ratio;
        editor.overlay_maximized = view.overlay_maximized;
        editor.cs_dismissed = view.cs_dismissed;
        editor.shortcuts = view.shortcuts;
        editor.save()?;
    }
    {
        let mut server = state
            .server_config
            .lock()
            .map_err(|_| Error::Config("server config lock poisoned".into()))?;
        if !view.attachments_dir.is_empty() {
            server.attachments_dir = view.attachments_dir;
        }
        server.search.aggression = view.search_aggression;
        server.terminal = sanitize_terminal_config(view.terminal);
        server.save()?;
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::test_support::make_test_state;

    fn to_json(view: &GlobalConfigView) -> serde_json::Value {
        serde_json::to_value(view).expect("serialize")
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
            default_term: "  xterm  ".into(),
            ..TerminalConfig::default()
        });
        assert_eq!(too_high.scrollback_mb, TERMINAL_SCROLLBACK_MB_MAX);
        assert_eq!(too_high.default_term, "xterm");

        let too_low = sanitize_terminal_config(TerminalConfig {
            scrollback_mb: 1,
            ..TerminalConfig::default()
        });
        assert_eq!(too_low.scrollback_mb, TERMINAL_SCROLLBACK_MB_MIN);

        let in_range = sanitize_terminal_config(TerminalConfig {
            scrollback_mb: 25,
            default_term: "tmux-256color".into(),
            ..TerminalConfig::default()
        });
        assert_eq!(in_range.scrollback_mb, 25);
        assert_eq!(in_range.default_term, "tmux-256color");
    }

    #[test]
    fn global_config_view_keeps_host_fields_on_local_serve() {
        let state = make_test_state(false);
        let view = global_config_view(&state).expect("global config view");
        let json = to_json(&view);
        assert!(json["workspaces"].is_array());
    }
}
