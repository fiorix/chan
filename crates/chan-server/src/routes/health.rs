//! GET /api/health.

use std::sync::{Arc, OnceLock};

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

use crate::indexer::IndexerHealth;
use crate::state::AppState;

/// Reported until a binary declares its build. Mirrors the build scripts'
/// own fallback, so an unidentifiable build reads the same everywhere.
pub const UNKNOWN_BUILD_ID: &str = "unknown";

/// The build id of the binary this process is running.
///
/// Process-wide rather than a field on [`AppState`], because that is what it
/// describes: every tenant in a process is served by one binary, so a build id
/// that could differ per tenant would be a lie. It also cannot be a
/// compile-time constant of this crate -- chan-server is a library, and the id
/// belongs to the binary linking it, stamped by THAT binary's build script and
/// handed down here at startup.
static BUILD_ID: OnceLock<String> = OnceLock::new();

/// Declare the running binary's build id. The first call wins and later ones
/// are ignored, so an in-process CLI dispatch cannot relabel a live server.
///
/// `chan::run` calls this before dispatching any subcommand. A binary that
/// embeds chan-server without calling it serves [`UNKNOWN_BUILD_ID`], which is
/// the honest answer: nothing told the process what it is.
pub fn set_build_id(id: impl Into<String>) {
    let _ = BUILD_ID.set(id.into());
}

/// The running binary's build id, or [`UNKNOWN_BUILD_ID`] when undeclared.
pub fn build_id() -> &'static str {
    declared_or_unknown(BUILD_ID.get())
}

/// The undeclared-build rule, split out from the static so it is testable:
/// a process that never declared its build says so, rather than serving an
/// empty field a reader would have to interpret.
fn declared_or_unknown(declared: Option<&'static String>) -> &'static str {
    declared.map_or(UNKNOWN_BUILD_ID, String::as_str)
}

/// The build id every test in this crate declares.
///
/// [`BUILD_ID`] is set-once and process-wide, and the test binary is one
/// process: two tests declaring DIFFERENT ids would each pass or fail on
/// which one raced in first. Sharing one value makes the order irrelevant.
#[cfg(test)]
pub(crate) const TEST_DECLARED_BUILD_ID: &str = "git-0123456789ab";

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    /// Random id minted at tenant build. The SPA compares it across
    /// `/ws` reconnects: a changed id = the process was restarted (its
    /// PTYs and in-memory state are gone) and the window reloads
    /// itself instead of going stale.
    instance: String,
    /// Which build is serving, the same id `chan --version` prints.
    ///
    /// Distinct from `instance` in what it answers: `instance` is re-minted
    /// per tenant and says only "not the same process as before", never WHICH
    /// build that process is. An operator diagnosing through a tunnel has no
    /// shell on the host, so this is the only place that answer is readable --
    /// and "I rebuilt and restarted" against an unchanged version string is
    /// exactly the invisible-skew condition it settles.
    build: &'static str,
    /// Present on workspace tenants; `null` on the workspace-less
    /// terminal tenant (no indexer exists there BY DESIGN) and during
    /// the transient storage-reset swap window.
    indexer: Option<IndexerHealth>,
}

pub async fn api_health(State(state): State<Arc<AppState>>) -> Response {
    // Health means "this process answers" on EVERY tenant. Erroring on
    // a missing indexer made the standalone terminal tenant 503 each
    // time a terminal window's instance probe ran on watch-socket
    // connect -- a tower-http ERROR line in the desktop log per
    // Cmd+T / Cmd+Shift+N. The indexer block is diagnostics, not a
    // liveness gate; absent simply means "no indexer here right now".
    let indexer = state.try_indexer().ok().map(|ix| ix.health_snapshot());
    Json(HealthResponse {
        status: "ok",
        instance: state.instance_id.clone(),
        build: build_id(),
        indexer,
    })
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::indexer::{IndexerHealth, IndexerHealthStatus};

    #[test]
    fn an_undeclared_build_reads_as_unknown_rather_than_empty() {
        assert_eq!(declared_or_unknown(None), UNKNOWN_BUILD_ID);
    }

    #[test]
    fn a_declared_build_is_what_gets_reported() {
        let declared: &'static String = Box::leak(Box::new("git-abc123def456".to_string()));
        assert_eq!(declared_or_unknown(Some(declared)), "git-abc123def456");
    }

    #[tokio::test]
    async fn health_names_the_build_the_process_declared() {
        // The wiring test, not a shape test: it proves the handler reads the
        // process-wide declaration rather than reporting a constant. The
        // devserver root's health test declares the same id, deliberately;
        // see TEST_DECLARED_BUILD_ID.
        set_build_id(TEST_DECLARED_BUILD_ID);

        let state = crate::state::test_support::make_test_state(false);
        let response = api_health(axum::extract::State(state)).await;
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("health body");
        let value: serde_json::Value = serde_json::from_slice(&bytes).expect("health json");

        assert_eq!(value["status"], "ok");
        assert_eq!(value["build"], TEST_DECLARED_BUILD_ID);
    }

    #[test]
    fn health_answers_without_an_indexer_on_workspace_less_tenants() {
        // The standalone terminal tenant has no indexer by design; the
        // route must answer 200 with a null block, not 503 (which made
        // tower-http log an ERROR per terminal-window instance probe).
        let value = serde_json::to_value(HealthResponse {
            status: "ok",
            instance: "boot-term".to_string(),
            build: "git-abc123def456",
            indexer: None,
        })
        .unwrap();
        assert_eq!(value["status"], "ok");
        assert_eq!(value["instance"], "boot-term");
        assert!(value["indexer"].is_null());
    }

    #[test]
    fn health_response_serializes_indexer_block() {
        let value = serde_json::to_value(HealthResponse {
            status: "ok",
            instance: "boot-abc123".to_string(),
            build: "git-abc123def456",
            indexer: Some(IndexerHealth {
                status: IndexerHealthStatus::Settling,
                queue_depth: 2,
                last_event_at: Some(1_700_000_000),
                last_settled_at: Some(1_699_999_999),
                coalesced_rebuild: false,
            }),
        })
        .unwrap();

        assert_eq!(value["status"], "ok");
        // Wire pin: the SPA's restart-reload check reads `instance`.
        assert_eq!(value["instance"], "boot-abc123");
        // Wire pin: an operator reading a build through a tunnel reads `build`.
        assert_eq!(value["build"], "git-abc123def456");
        assert_eq!(value["indexer"]["status"], "settling");
        assert_eq!(value["indexer"]["queue_depth"], 2);
        assert_eq!(value["indexer"]["last_event_at"], 1_700_000_000);
        assert_eq!(value["indexer"]["last_settled_at"], 1_699_999_999);
        assert_eq!(value["indexer"]["coalesced_rebuild"], false);
    }
}
