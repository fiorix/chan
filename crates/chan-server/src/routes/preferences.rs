//! Server preferences: per-server config (`/api/server/config`) and
//! the unified GlobalConfig view (`/api/config`).
//!
//! The unified surface joins EditorPrefs, ServerConfig, and the
//! chan-workspace registry. Agent/assistant preferences were removed with
//! the assistant overlay; MCP access is configured through the server
//! runtime, not through global user preferences.

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
    BrowserSidePanes, EditorTheme, HybridSurfaceThemes, LineSpacing, PaneWidths, ServerConfig,
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
}

fn default_empty_pane_carousel_cycling() -> bool {
    true
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
    })
}

// ----- /api/server/config ------------------------------------------------

pub async fn api_get_server_config(State(state): State<Arc<AppState>>) -> Response {
    let cfg = match state.server_config.lock() {
        Ok(cfg) => cfg.clone(),
        Err(_) => {
            return err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "server config lock poisoned".into(),
            );
        }
    };
    Json(cfg).into_response()
}

#[derive(Deserialize)]
pub struct PatchServerConfigBody {
    /// Workspace-relative POSIX path. Empty string is rejected because the
    /// path is used as a prefix; an empty prefix would land attachments
    /// in the workspace root, surprising the user.
    #[serde(default)]
    attachments_dir: Option<String>,
    #[serde(default)]
    search: Option<crate::config::SearchConfig>,
    #[serde(default)]
    terminal: Option<TerminalConfig>,
    #[serde(default)]
    team_work: Option<crate::TeamWorkConfig>,
}

pub async fn api_patch_server_config(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PatchServerConfigBody>,
) -> Response {
    let result = tokio::task::spawn_blocking(move || patch_server_config(&state, body)).await;
    match result {
        Ok(Ok(cfg)) => Json(cfg).into_response(),
        Ok(Err(e)) => err(status_for_error(&e), e.to_string()),
        Err(join) => err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
    }
}

fn patch_server_config(
    state: &AppState,
    body: PatchServerConfigBody,
) -> Result<ServerConfig, Error> {
    let mut cfg = match state.server_config.lock() {
        Ok(cfg) => cfg,
        Err(_) => return Err(Error::Config("server config lock poisoned".into())),
    };
    if let Some(p) = body.attachments_dir {
        if p.is_empty() {
            return Err(Error::BadRequest(
                "attachments_dir must be non-empty".into(),
            ));
        }
        cfg.attachments_dir = p;
    }
    if let Some(search) = body.search {
        cfg.search = search;
    }
    if let Some(terminal) = body.terminal {
        cfg.terminal = sanitize_terminal_config(terminal);
    }
    if let Some(team_work) = body.team_work {
        cfg.team_work = team_work;
        cfg.sanitize();
        state
            .agent_inbox
            .set_depth(cfg.team_work.inbox_depth)
            .map_err(|e| Error::Config(e.to_string()))?;
    }
    cfg.save()?;
    Ok(cfg.clone())
}

// ----- /api/config (unified GlobalConfig) --------------------------------

#[derive(Serialize)]
struct GlobalConfigView {
    preferences: PreferencesView,
    /// Empty string serializes as None (the resolver falls back to the
    /// platform default).
    default_workspace_root: Option<String>,
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
    #[serde(default)]
    default_workspace_root: Option<Option<String>>,
    /// Read-only on PATCH: workspaces are managed by path through the
    /// CLI (`chan add` / `remove`). Frontend sends the field for
    /// round-tripping; we just ignore it.
    #[serde(default)]
    #[allow(dead_code)]
    workspaces: Option<serde_json::Value>,
}

fn global_config_view(state: &AppState) -> Result<GlobalConfigView, Error> {
    // On `--tunnel-public` runs we strip the whole "host machine"
    // dimension of the response: anonymous visitors must not see
    // `default_workspace_root` or the registry of other workspaces on the host.
    if state.tunnel_public {
        return Ok(GlobalConfigView {
            preferences: preferences_view(state)?,
            default_workspace_root: None,
            workspaces: Vec::new(),
        });
    }
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
        default_workspace_root: state
            .library
            .default_workspace_root()
            .map(|p| p.to_string_lossy().into_owned()),
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
    }
    if let Some(opt) = body.default_workspace_root {
        let trimmed = opt.as_ref().map(|s| s.trim().to_string());
        let value = match trimmed {
            Some(s) if s.is_empty() => None,
            other => other,
        };
        state
            .library
            .set_default_workspace_root(value.map(std::path::PathBuf::from))?;
    }
    global_config_view(state)
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
    // `fullstack-b-11`: scrollback clamps to the Settings slider
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
    fn global_config_view_redacts_host_paths_on_public_tunnel() {
        let state = make_test_state(true, true);
        let view = global_config_view(&state).expect("global config view");
        let json = to_json(&view);
        assert_eq!(json["default_workspace_root"], serde_json::Value::Null);
        assert_eq!(json["workspaces"], serde_json::json!([]));
    }

    #[test]
    fn patch_server_config_updates_active_agent_inbox_depth() {
        let state = make_test_state(false, false);
        let inbox = state.agent_inbox.clone();
        let body = PatchServerConfigBody {
            attachments_dir: None,
            search: None,
            terminal: None,
            team_work: Some(crate::TeamWorkConfig { inbox_depth: 250 }),
        };

        let cfg = patch_server_config(&state, body).expect("patch server config");

        assert_eq!(cfg.team_work.inbox_depth, 100);
        assert_eq!(inbox.depth().unwrap(), 100);
    }

    #[test]
    fn preferences_view_has_no_assistant_subtree() {
        let state = make_test_state(false, false);
        let view = preferences_view(&state).expect("preferences view");
        let json = serde_json::to_value(view).expect("serialize");
        assert!(json.get("assistant").is_none());
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
            scrollback_mb: 75,
            default_term: "tmux-256color".into(),
            ..TerminalConfig::default()
        });
        assert_eq!(in_range.scrollback_mb, 75);
        assert_eq!(in_range.default_term, "tmux-256color");
    }

    #[test]
    fn global_config_view_keeps_host_fields_on_local_serve() {
        let state = make_test_state(false, false);
        let view = global_config_view(&state).expect("global config view");
        let json = to_json(&view);
        assert!(json["workspaces"].is_array());
    }
}
