//! Per-file / per-prefix / per-directory code report (chan-report).
//!
//! Surfaces the rolled-up chan-report data the file inspector renders
//! alongside size / mtime. Three read-only endpoints, all auth-gated
//! by the standard middleware:
//!
//!   - `GET /api/report/file?path=<rel>` returns the single
//!     `FileStats` row for one file, or 404 if the path is not in the
//!     index (binary, gitignored, language unknown to tokei).
//!     `GET /api/report/file?path=<rel>&stream=1` returns NDJSON:
//!     `meta`, then `report` or `missing`, then `done`. Late failures
//!     are `error` events.
//!   - `GET /api/report/prefix?path=<rel>` returns the per-directory
//!     roll-up: totals, by_language, cocomo. Walks the file map every
//!     call (O(N) over the matching prefix). Use this when the caller
//!     wants prefix-string semantics (e.g. "everything starting with
//!     'src/lib'", including the file `src/lib.rs` itself if it
//!     exists). The per-file `files` array is dropped from the
//!     response since directories can fan out to thousands of rows;
//!     the inspector only needs the summary. Empty `path` means the
//!     entire workspace.
//!   - `GET /api/report/dir?path=<rel>` returns the same shape as
//!     `prefix`, but reads from the O(1) maintained directory
//!     aggregation cache. Strict directory semantics: only files
//!     under the directory contribute (a file named identically to
//!     a directory would not). Empty `path` is the workspace root.
//!     Responds 404 when no tracked file lives at or under `path`.
//!     This is the endpoint the directory inspector consumes per-click
//!     without re-walking the file map.
//!
//! All endpoints lazily trigger chan-workspace's initial report scan on
//! first call; subsequent calls hit the warm in-memory index.

use std::{convert::Infallible, sync::Arc};

use axum::body::{Body, Bytes};
use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chan_workspace::{CocomoSummary, ReportFileStats, ReportLanguageStats, ReportTotals};
use futures::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::error::{err_from, err_state};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct ReportPathParams {
    #[serde(default)]
    path: String,
}

#[derive(Deserialize)]
pub struct ReportFileParams {
    #[serde(default)]
    path: String,
    #[serde(default)]
    stream: Option<String>,
}

#[derive(Serialize)]
pub struct PrefixReport {
    totals: ReportTotals,
    by_language: Vec<ReportLanguageStats>,
    cocomo: CocomoSummary,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ReportFileStreamEvent<'a> {
    Meta { path: &'a str },
    Report { stats: ReportFileStats },
    Missing,
    Done,
    Error { error: String },
}

enum ReportFileStreamMessage {
    Data(Bytes),
    Error(chan_workspace::ChanError),
}

async fn blocking_response(
    f: impl FnOnce() -> Response + Send + 'static,
    label: &'static str,
) -> Response {
    match tokio::task::spawn_blocking(f).await {
        Ok(response) => response,
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("{label} task panicked: {e}"),
        )
            .into_response(),
    }
}

fn query_flag(value: &Option<String>) -> bool {
    matches!(
        value.as_deref(),
        Some("1" | "true" | "TRUE" | "yes" | "YES" | "on" | "ON")
    )
}

fn ndjson_bytes(event: &ReportFileStreamEvent<'_>) -> Result<Bytes, serde_json::Error> {
    let mut line = serde_json::to_vec(event)?;
    line.push(b'\n');
    Ok(Bytes::from(line))
}

fn ndjson_error_bytes(error: String) -> Bytes {
    match ndjson_bytes(&ReportFileStreamEvent::Error { error }) {
        Ok(bytes) => bytes,
        Err(e) => Bytes::from(format!(
            "{{\"type\":\"error\",\"error\":\"failed to encode report stream error: {e}\"}}\n"
        )),
    }
}

fn emit_report_file_event<F>(
    emit: &mut F,
    event: ReportFileStreamEvent<'_>,
) -> chan_workspace::Result<bool>
where
    F: FnMut(Bytes) -> bool,
{
    let bytes = ndjson_bytes(&event).map_err(|e| {
        chan_workspace::ChanError::Io(format!("failed to encode report stream event: {e}"))
    })?;
    Ok(emit(bytes))
}

fn stream_report_file_sync<F>(
    workspace: &chan_workspace::Workspace,
    path: &str,
    mut emit: F,
) -> chan_workspace::Result<()>
where
    F: FnMut(Bytes) -> bool,
{
    if !emit_report_file_event(&mut emit, ReportFileStreamEvent::Meta { path })? {
        return Ok(());
    }

    let report = workspace.report_for_files(&[path.to_string()])?;
    let stats = report.files.into_iter().find(|f| f.path == path);
    match stats {
        Some(stats) => {
            if !emit_report_file_event(&mut emit, ReportFileStreamEvent::Report { stats })? {
                return Ok(());
            }
        }
        None => {
            if !emit_report_file_event(&mut emit, ReportFileStreamEvent::Missing)? {
                return Ok(());
            }
        }
    }

    emit_report_file_event(&mut emit, ReportFileStreamEvent::Done)?;
    Ok(())
}

/// Per-file report row. 404 when the file is not indexed; an empty
/// `path` is rejected with 400 since the file endpoint is path-keyed
/// (use `/api/report/prefix` with an empty path for the whole-workspace
/// roll-up).
pub async fn api_report_file(
    State(state): State<Arc<AppState>>,
    Query(p): Query<ReportFileParams>,
) -> Response {
    if p.path.trim().is_empty() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    if query_flag(&p.stream) {
        return stream_report_file_response(workspace, p.path).await;
    }
    blocking_response(
        move || {
            let report = match workspace.report_for_files(std::slice::from_ref(&p.path)) {
                Ok(r) => r,
                Err(e) => return err_from(&e),
            };
            match report.files.into_iter().find(|f| f.path == p.path) {
                Some(stats) => Json(stats).into_response(),
                None => StatusCode::NOT_FOUND.into_response(),
            }
        },
        "report file",
    )
    .await
}

async fn stream_report_file_response(
    workspace: Arc<chan_workspace::Workspace>,
    path: String,
) -> Response {
    let (tx, mut rx) = mpsc::channel::<ReportFileStreamMessage>(8);
    tokio::task::spawn_blocking(move || {
        let result = stream_report_file_sync(&workspace, &path, |bytes| {
            tx.blocking_send(ReportFileStreamMessage::Data(bytes))
                .is_ok()
        });
        if let Err(e) = result {
            let _ = tx.blocking_send(ReportFileStreamMessage::Error(e));
        }
    });

    let first = match rx.recv().await {
        Some(ReportFileStreamMessage::Data(bytes)) => bytes,
        Some(ReportFileStreamMessage::Error(e)) => return err_from(&e),
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "report stream ended before metadata",
            )
                .into_response()
        }
    };
    let rest = stream::unfold(rx, |mut rx| async {
        rx.recv().await.map(|message| {
            let bytes = match message {
                ReportFileStreamMessage::Data(bytes) => bytes,
                ReportFileStreamMessage::Error(e) => ndjson_error_bytes(e.to_string()),
            };
            (Ok::<Bytes, Infallible>(bytes), rx)
        })
    });
    let body =
        Body::from_stream(stream::once(async move { Ok::<Bytes, Infallible>(first) }).chain(rest));
    ([(header::CONTENT_TYPE, "application/x-ndjson")], body).into_response()
}

/// Directory roll-up: totals + per-language + COCOMO. The per-file
/// `files` array is dropped since directories can fan out to thousands of
/// rows and the inspector renders only the summary. Empty `path`
/// returns the whole-workspace roll-up.
pub async fn api_report_prefix(
    State(state): State<Arc<AppState>>,
    Query(p): Query<ReportPathParams>,
) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    blocking_response(
        move || {
            let report = match if p.path.is_empty() {
                workspace.report()
            } else {
                workspace.report_for_prefix(&p.path)
            } {
                Ok(r) => r,
                Err(e) => return err_from(&e),
            };
            Json(PrefixReport {
                totals: report.totals,
                by_language: report.by_language,
                cocomo: report.cocomo,
            })
            .into_response()
        },
        "report prefix",
    )
    .await
}

/// Per-directory roll-up via the maintained O(1) cache. Same
/// response shape as `api_report_prefix` but reads from the cache
/// instead of walking the file map. 404 when the directory has no
/// tracked files. Empty `path` returns the workspace root.
pub async fn api_report_dir(
    State(state): State<Arc<AppState>>,
    Query(p): Query<ReportPathParams>,
) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    blocking_response(
        move || {
            let report = match workspace.report_for_dir(&p.path) {
                Ok(Some(r)) => r,
                Ok(None) => return StatusCode::NOT_FOUND.into_response(),
                Err(e) => return err_from(&e),
            };
            Json(PrefixReport {
                totals: report.totals,
                by_language: report.by_language,
                cocomo: report.cocomo,
            })
            .into_response()
        },
        "report dir",
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_workspace() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        std::sync::Arc<chan_workspace::Workspace>,
    ) {
        let cfg = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        (cfg, root, workspace)
    }

    fn event_types(lines: &[Bytes]) -> Vec<String> {
        lines
            .iter()
            .map(|line| {
                let value: serde_json::Value = serde_json::from_slice(line).unwrap();
                value
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap()
                    .to_string()
            })
            .collect()
    }

    #[test]
    fn report_file_stream_emits_meta_report_done() {
        let (_cfg, _root, workspace) = open_workspace();
        workspace.write_text("CHANGELOG.md", "# Changes\n").unwrap();

        let mut lines = Vec::new();
        stream_report_file_sync(&workspace, "CHANGELOG.md", |bytes| {
            lines.push(bytes);
            true
        })
        .unwrap();

        let types = event_types(&lines);
        assert_eq!(types.first().map(String::as_str), Some("meta"));
        assert!(types.iter().any(|t| t == "report"), "got {types:?}");
        assert_eq!(types.last().map(String::as_str), Some("done"));
    }
}
