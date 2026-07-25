//! HTTP route handlers, organized by area.
//!
//! Per-area submodules host the handlers, request / response shapes,
//! and any helpers specific to that area. Cross-area types (e.g.
//! `PreferencesView`) live in the module that owns them and are
//! re-exported here. `lib.rs::router()` wires every endpoint.

mod attachments;
mod build_info;
mod contacts;
mod cs_link;
// pub(crate) so the server-side doc-session authority (registry, flusher,
// reconciler) fans the exact ServerFrame shapes the `/api/doc/ws` route
// serves; the frame enums in `doc` are the wire contract's single source.
pub(crate) mod doc;
mod drafts;
mod excluded_dirs;
mod files;
mod fonts;
mod fs_graph;
mod graph;
mod health;
#[cfg(feature = "embeddings")]
mod index;
mod inspector;
mod library;
mod mentions;
mod metadata;
mod open;
mod preferences;
mod preflight;
mod report;
mod reports_toggle;
// pub(crate) so the server-side scene-session authority (registry,
// flusher, reconciler) fans the exact ServerFrame shapes the
// `/api/scene/ws` route serves; the frame enums in `scene` are the wire
// contract's single source.
pub(crate) mod scene;
mod screensaver;
mod search;
mod session_handover;
mod sessions;
mod storage;
mod survey;
// pub(crate) so the `cs terminal team` control-socket handler
// (`crate::control_socket`, a sibling of `routes`) can reuse the team
// config write/read + bootstrap generation instead of duplicating it.
pub(crate) mod team_config;
mod terminal;
// pub(crate) so the terminal router (`crate::lib`) mounts the standalone
// transfer handlers.
pub(crate) mod transfer;
mod window;
// pub(crate) so the `cs window list` control-socket handler
// (`crate::control_socket`) reuses `join_windows` + `WindowInfo` and
// the CLI sees the exact rows `GET /api/windows` serves.
pub(crate) mod windows;
mod workspace;
mod ws;

pub use attachments::api_post_attachment;
pub use build_info::api_build_info;
pub use contacts::{api_get_contacts, api_post_contacts_import};
pub use cs_link::api_cs_link_create;
pub use doc::api_doc_ws;
pub use drafts::{
    api_create_diagram, api_create_draft, api_discard_draft, api_inspect_draft, api_promote_draft,
};
pub use excluded_dirs::{api_excluded_dirs_get, api_excluded_dirs_put};
pub use files::{
    api_create_file, api_delete_file, api_fs_transfer, api_list_files, api_move, api_read_file,
    api_resolve_session_conflict, api_upload_file, api_write_file,
};
pub use fonts::api_fonts_source_code_pro_download;
pub use fs_graph::{api_fs_graph, build_fs_graph, FsGraphResponse, FsGraphScope};
pub use graph::{
    api_backlinks, api_graph, api_headings, api_language_graph, api_link_targets, api_links,
    api_resolve_link,
};
pub use health::api_health;
#[cfg(feature = "embeddings")]
pub use index::{
    api_semantic_disable, api_semantic_download, api_semantic_enable, api_semantic_model_patch,
    api_semantic_models, api_semantic_state,
};
pub use inspector::api_inspector;
pub use library::{launcher_router, LauncherBearer};
pub use mentions::api_get_mentions;
pub use metadata::{api_metadata_export, api_metadata_import};
pub use open::api_open;
pub(crate) use preferences::broadcast_config_changed;
pub use preferences::{
    api_get_config, api_get_server_config, api_patch_config, api_patch_server_config,
};
pub use preflight::{api_preflight, api_preflight_decision};
pub use report::{api_report_dir, api_report_file, api_report_prefix};
pub use reports_toggle::{api_reports_disable, api_reports_enable, api_reports_state};
pub use scene::api_scene_ws;
pub use screensaver::{
    api_screensaver_clear_pin, api_screensaver_patch, api_screensaver_set_pin,
    api_screensaver_state, api_screensaver_verify,
};
pub use search::{
    api_index_rebuild, api_index_status, api_indexing_state, api_search_content, api_search_files,
    api_search_workspace,
};
pub use session_handover::api_session_handover_reply;
pub use sessions::{api_delete_session, api_get_session, api_list_sessions, api_put_session};
pub use storage::api_storage_reset;
pub use survey::api_survey_reply;
pub use team_config::{api_team_config_read, api_team_config_write};
pub use terminal::{
    api_create_terminal, api_delete_terminal, api_restart_terminal, api_set_terminal_broadcast,
    api_terminal_next_name, api_terminal_ws, api_terminals_roster, spawn_roster_broadcaster,
};
pub use window::api_window_reply;
pub use windows::api_list_windows;
pub use workspace::{
    api_cloud_workspaces, api_get_workspace, api_patch_workspace, api_workspace_bootstrap,
};
pub use ws::ws_upgrade;
