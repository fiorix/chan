//! Team config schema. `TeamConfig` (members, host, prefix
//! policy) is persisted to a `config.toml` and consumed by the
//! path-based Team Work flow via chan-server's
//! `/api/team-config/read` and `/api/team-config/write` routes.

use serde::{Deserialize, Serialize};

/// Per-team config persisted to `config.toml`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TeamConfig {
    pub team_name: String,
    pub host_name: String,
    pub host_handle: String,
    // Terminal tab group the team's tabs are grouped under. The SPA's
    // `TeamConfigWire` always carries this; `#[serde(default)]` keeps a
    // hand-edited config.toml that predates the field from 400-ing on
    // read (an empty group is harmless), rather than forcing a manual
    // edit on every pre-existing config.
    #[serde(default)]
    pub tab_group: String,
    #[serde(default = "default_auto_prefix_at")]
    pub auto_prefix_at: bool,
    // Whether the team's member terminals start with the chan MCP
    // discovery env vars (CHAN_MCP_SERVER_JSON + companions) set. Off by
    // default (MCP env starts disabled for ALL agents, since codex
    // wants a file-based config and a stray env descriptor makes it fail
    // to start). The team setup dialog and `cs terminal team new|load`
    // opt back in. `#[serde(default)]` => an absent field (hand-written
    // or pre-field config.toml) reads as false; pre-release, no migration.
    #[serde(default)]
    pub mcp_env: bool,
    // ISO 8601 UTC creation time. The SPA dialog always sends it; the CLI
    // `cs terminal team new` lets the input config.toml omit it (a
    // hand-written team spec should not carry a timestamp), and the server
    // stamps the current time on write. `#[serde(default)]` (empty string)
    // is the "not yet stamped" sentinel the server fills in.
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub members: Vec<Member>,
}

fn default_auto_prefix_at() -> bool {
    true
}

/// One member entry inside `TeamConfig.members`. `position` is
/// the airplane-style grid coordinate; `None` selects
/// tabs-in-current-Hybrid layout. `env` carries per-tab
/// environment overrides (e.g. `CHAN_TAB_NAME`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Member {
    pub handle: String,
    pub command: String,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub is_lead: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<Position>,
}

/// Airplane-style grid coordinate. Row + column are zero-based.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct Position {
    pub row: u32,
    pub col: u32,
}
