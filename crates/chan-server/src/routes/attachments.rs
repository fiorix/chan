//! POST /api/attachments: multipart upload from the editor.
//!
//! The frontend sends one part named `file`; we slugify the original
//! filename and publish via Workspace::create_bytes, retrying occupied
//! names with numbered suffixes. The sandbox and exclusive publication
//! protect existing entries. Returns the workspace-relative path the file
//! landed at, matching the frontend's `uploadAttachment` contract.
//!
//! Optional `dir` form field overrides the configured
//! `attachments_dir` so the editor can land an upload in the same
//! directory as the file being edited (markdown can then reference
//! it with a `./name` src). An empty `dir` saves at workspace root; an
//! absent `dir` falls back to `attachments_dir`. Workspace sandboxing
//! rejects `..` escape attempts so we don't validate manually here.

use std::sync::Arc;

use axum::extract::{Multipart, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::error::{err, err_from, err_state};
use crate::signal::now_unix_secs;
use crate::state::AppState;
use crate::util::{slugify_for_filename, split_filename};

pub async fn api_post_attachment(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Response {
    // Walk every multipart field once: we want both the file and
    // the optional `dir` override, and a streaming multipart parser
    // doesn't let us re-read parts. Order on the wire is up to the
    // client; pick the first `file` field we see and take the last
    // `dir` field (so a duplicate doesn't silently win the wrong
    // way).
    let mut chosen: Option<(String, Vec<u8>)> = None;
    let mut dir_override: Option<String> = None;
    loop {
        match multipart.next_field().await {
            Ok(Some(field)) => {
                let name = field.name().unwrap_or("").to_owned();
                match name.as_str() {
                    "file" if chosen.is_none() => {
                        let filename = field.file_name().unwrap_or("").to_owned();
                        let bytes = match field.bytes().await {
                            Ok(b) => b.to_vec(),
                            Err(e) => {
                                return err(
                                    StatusCode::BAD_REQUEST,
                                    format!("multipart read: {e}"),
                                );
                            }
                        };
                        chosen = Some((filename, bytes));
                    }
                    "dir" => match field.text().await {
                        Ok(s) => dir_override = Some(s),
                        Err(e) => {
                            return err(StatusCode::BAD_REQUEST, format!("multipart read: {e}"));
                        }
                    },
                    _ => {}
                }
            }
            Ok(None) => break,
            Err(e) => {
                return err(StatusCode::BAD_REQUEST, format!("multipart parse: {e}"));
            }
        }
    }

    let Some((original, bytes)) = chosen else {
        return err(
            StatusCode::BAD_REQUEST,
            "missing `file` part in multipart body".into(),
        );
    };

    if bytes.is_empty() {
        return err(StatusCode::BAD_REQUEST, "empty file".into());
    }

    // Resolve the target dir: caller-supplied `dir` (incl. empty
    // string for workspace root) wins; missing falls back to the
    // configured attachments_dir.
    let dir = match dir_override {
        Some(d) => d,
        None => match state.server_config.lock() {
            Ok(cfg) => cfg.attachments_dir.clone(),
            Err(_) => {
                return err(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "server config lock poisoned".into(),
                );
            }
        },
    };

    // Filename: <slugified-stem>.<ext>, kept close to what the user
    // pasted / uploaded so the markdown source reads naturally. On
    // collision in the target dir, append `-1`, `-2`, ... until we
    // find a free slot. The slug step strips path separators and
    // disallowed characters so a hostile filename can't escape the
    // chosen dir. Extension is lowercased so the browser's
    // content-type sniffer agrees with the editor's render.
    let (stem, ext) = split_filename(&original);
    let stem_slug = slugify_for_filename(stem);
    let stem_or_default = if stem_slug.is_empty() {
        "file".to_string()
    } else {
        stem_slug
    };
    let ext = ext.map(|e| e.to_ascii_lowercase()).unwrap_or_default();

    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(e) => return err_state(&e),
    };
    // Reserve suppression before publication so the watcher cannot race
    // the write's attribution. Failed attempts cancel their reservation.
    let self_writes = Arc::clone(&state.self_writes);
    let result = tokio::task::spawn_blocking(move || {
        let join_filename = |name: &str| -> String {
            if dir.is_empty() {
                name.to_owned()
            } else {
                format!("{dir}/{name}")
            }
        };
        let build_name = |suffix: Option<u32>| -> String {
            let base = match suffix {
                None => stem_or_default.clone(),
                Some(n) => format!("{stem_or_default}-{n}"),
            };
            if ext.is_empty() {
                base
            } else {
                format!("{base}.{ext}")
            }
        };
        for attempt in 0..=1001 {
            let rel = if attempt == 1001 {
                let base = format!("{stem_or_default}-{}", now_unix_secs());
                join_filename(&if ext.is_empty() {
                    base
                } else {
                    format!("{base}.{ext}")
                })
            } else {
                join_filename(&build_name((attempt > 0).then_some(attempt)))
            };
            #[cfg(test)]
            tests::pause_before_publish(workspace.root(), bytes[0]);
            let reservation = self_writes.reserve_after_preflight(&rel);
            match workspace.create_bytes(&rel, &bytes) {
                Ok(()) => return Ok(rel),
                Err(error) => {
                    self_writes.cancel(reservation);
                    if !matches!(error, chan_workspace::ChanError::PathAlreadyExists(_))
                        || attempt == 1001
                    {
                        return Err(error);
                    }
                }
            }
        }
        unreachable!("the final exclusive publication returns success or an error")
    })
    .await;
    let rel = match result {
        Ok(Ok(rel)) => rel,
        Ok(Err(e)) => return err_from(&e),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("attachment write task panicked: {e}"),
            )
                .into_response();
        }
    };
    Json(serde_json::json!({ "path": rel })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::{mpsc, Mutex, OnceLock};
    use std::time::Duration;

    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use tower::ServiceExt;

    struct Pause {
        ready: tokio::sync::oneshot::Sender<()>,
        resume: mpsc::Receiver<()>,
    }

    fn pauses() -> &'static Mutex<HashMap<(PathBuf, u8), Pause>> {
        static PAUSES: OnceLock<Mutex<HashMap<(PathBuf, u8), Pause>>> = OnceLock::new();
        PAUSES.get_or_init(Mutex::default)
    }

    pub(super) fn pause_before_publish(root: &Path, marker: u8) {
        let pause = pauses().lock().unwrap().remove(&(root.into(), marker));
        if let Some(pause) = pause {
            pause.ready.send(()).unwrap();
            pause.resume.recv_timeout(Duration::from_secs(5)).unwrap();
        }
    }

    async fn upload(state: Arc<AppState>, bytes: &str) -> (StatusCode, String) {
        let app = axum::Router::new()
            .route("/api/attachments", axum::routing::post(api_post_attachment))
            .with_state(state);
        let body = format!(
            "--upload\r\nContent-Disposition: form-data; name=\"dir\"\r\n\r\n\r\n\
             --upload\r\nContent-Disposition: form-data; name=\"file\"; filename=\"image.png\"\r\n\r\n{bytes}\r\n--upload--\r\n"
        );
        let response = app
            .oneshot(
                Request::post("/api/attachments")
                    .header("content-type", "multipart/form-data; boundary=upload")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        (status, value["path"].as_str().unwrap().to_owned())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_attachment_uploads_keep_both_payloads() {
        let state = crate::state::test_support::make_test_state(false);
        let root = tempfile::tempdir().unwrap();
        state.library.register_workspace(root.path()).unwrap();
        let workspace = state.library.open_workspace(root.path()).unwrap();
        let indexer = Arc::new(crate::indexer::Indexer::spawn(
            workspace.clone(),
            state.index_events_tx.subscribe(),
            false,
            chan_workspace::SearchAggression::Conservative,
            Arc::new(chan_workspace::NoProgress),
        ));
        *state.workspace_cell.write().unwrap() = Some(crate::state::WorkspaceCell {
            workspace: workspace.clone(),
            watch_handle: None,
            indexer,
        });
        let mut controls = Vec::new();
        for marker in [b'f', b's'] {
            let (ready, arrived) = tokio::sync::oneshot::channel();
            let (resume, receiver) = mpsc::channel();
            pauses().lock().unwrap().insert(
                (workspace.root().into(), marker),
                Pause {
                    ready,
                    resume: receiver,
                },
            );
            controls.push((arrived, resume));
        }
        let first = tokio::spawn(upload(state.clone(), "first"));
        let second = tokio::spawn(upload(state, "second"));
        let (first_ready, first_resume) = controls.remove(0);
        let (second_ready, second_resume) = controls.remove(0);
        for ready in [first_ready, second_ready] {
            tokio::time::timeout(Duration::from_secs(5), ready)
                .await
                .unwrap()
                .unwrap();
        }
        assert!(!workspace.exists("image.png"));
        first_resume.send(()).unwrap();
        let first = tokio::time::timeout(Duration::from_secs(5), first)
            .await
            .unwrap()
            .unwrap();
        second_resume.send(()).unwrap();
        let second = tokio::time::timeout(Duration::from_secs(5), second)
            .await
            .unwrap()
            .unwrap();
        let first_bytes = workspace.read(&first.1).unwrap();
        let second_bytes = workspace.read(&second.1).unwrap();
        eprintln!(
            "first={first:?} bytes={first_bytes:?}; second={second:?} bytes={second_bytes:?}"
        );
        assert_eq!((first.0, second.0), (StatusCode::OK, StatusCode::OK));
        assert_ne!(first.1, second.1);
        assert_eq!(first_bytes, b"first");
        assert_eq!(second_bytes, b"second");
    }
}
