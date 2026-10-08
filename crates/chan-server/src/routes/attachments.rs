//! POST /api/attachments: multipart upload from the editor.
//!
//! The frontend sends one part named `file` and an explicit destination
//! directory. We slugify the original filename and retry occupied names
//! with numbered suffixes. Workspace uploads use `Workspace::create_bytes`;
//! draft uploads hold a draft lifetime permit and use its file facade.
//! Both paths use exclusive publication and return a tagged file identity.
//!
//! `dir` is the active document's parent, including an explicit empty
//! value for a user-root document. A draft destination also carries
//! `root=draft` and its current `draft_id`. Missing document context has
//! no implicit target.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::error::{err, err_from, err_state};
use crate::extract::{Multipart, Query};
use crate::routes::files::{draft_event, FileIdentity, FileRoot, MutationWindowQuery};
use crate::routes::run_blocking;
use crate::signal::now_unix_secs;
use crate::state::AppState;
use crate::util::{slugify_for_filename, split_filename};

pub async fn api_post_attachment(
    State(state): State<Arc<AppState>>,
    Query(window): Query<MutationWindowQuery>,
    mut multipart: Multipart,
) -> Response {
    // Walk every multipart field once: we want both the file and
    // its destination, and a streaming multipart parser
    // doesn't let us re-read parts. Order on the wire is up to the
    // client; pick the first `file` field we see and take the last
    // destination field (so a duplicate doesn't silently win the wrong way).
    let mut chosen: Option<(String, Vec<u8>)> = None;
    let mut dir_override: Option<String> = None;
    let mut root_value: Option<String> = None;
    let mut draft_id: Option<String> = None;
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
                    "root" => match field.text().await {
                        Ok(s) => root_value = Some(s),
                        Err(e) => {
                            return err(StatusCode::BAD_REQUEST, format!("multipart read: {e}"));
                        }
                    },
                    "draft_id" => match field.text().await {
                        Ok(s) => draft_id = Some(s),
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

    let root = match root_value.as_deref() {
        None | Some("workspace") => FileRoot::Workspace,
        Some("draft") => FileRoot::Draft,
        Some(_) => return err(StatusCode::BAD_REQUEST, "unknown attachment root".into()),
    };
    let Some(dir) = dir_override else {
        return err(
            StatusCode::BAD_REQUEST,
            "open or create a document before uploading an attachment".into(),
        );
    };
    if root == FileRoot::Draft
        && (dir.is_empty() || dir.contains('/') || dir.contains('\\') || dir == "." || dir == "..")
    {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid draft attachment directory".into(),
        );
    }
    if root == FileRoot::Draft && draft_id.as_deref().is_none_or(str::is_empty) {
        return err(
            StatusCode::BAD_REQUEST,
            "draft_id is required for a draft attachment".into(),
        );
    }
    if root == FileRoot::Workspace && draft_id.is_some() {
        return err(
            StatusCode::BAD_REQUEST,
            "draft_id requires root=draft".into(),
        );
    }

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
    let result = run_blocking("attachment write", move || {
        let pin = if root == FileRoot::Draft {
            Some(workspace.pin_draft(&dir, draft_id.as_deref().expect("checked above"))?)
        } else {
            None
        };
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
            let reservation =
                (root == FileRoot::Workspace).then(|| self_writes.reserve_after_preflight(&rel));
            let write = match &pin {
                Some(pin) => pin
                    .workspace()
                    .draft_files()?
                    .create_bytes(&rel, pin.id(), &bytes),
                None => workspace.create_bytes(&rel, &bytes),
            };
            match write {
                Ok(()) => {
                    return Ok::<_, chan_workspace::ChanError>(match &pin {
                        Some(pin) => FileIdentity::draft(rel, pin.id().to_string()),
                        None => FileIdentity::workspace(rel),
                    });
                }
                Err(error) => {
                    if let Some(reservation) = reservation {
                        self_writes.cancel(reservation);
                    }
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
    let identity = match result {
        Ok(Ok(identity)) => identity,
        Ok(Err(e)) => return err_from(&e),
        Err(failed) => return failed.into_response(),
    };
    if identity.root == FileRoot::Draft {
        let _ = state.events_tx.send(draft_event(
            "modified",
            identity.clone(),
            None,
            window.window(),
        ));
    }
    Json(identity).into_response()
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

    #[tokio::test]
    async fn tagged_draft_upload_does_not_alias_the_user_root() {
        let cfg = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let library = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        library.register_workspace(root.path()).unwrap();
        let workspace = library.open_workspace(root.path()).unwrap();
        workspace.create_dir("b").unwrap();
        workspace.write_bytes("b/image.png", b"user bytes").unwrap();
        workspace.create_draft_dir("b").unwrap();
        let id = workspace.draft_id("b").unwrap();
        let state = Arc::new(crate::state::test_support::workspace_app_state(
            library,
            root.path().to_path_buf(),
            workspace.clone(),
        ));
        let mut events = state.events_tx.subscribe();
        let app = axum::Router::new()
            .route("/api/attachments", axum::routing::post(api_post_attachment))
            .with_state(state);
        let body = format!(
            "--upload\r\nContent-Disposition: form-data; name=\"root\"\r\n\r\ndraft\r\n\
             --upload\r\nContent-Disposition: form-data; name=\"draft_id\"\r\n\r\n{id}\r\n\
             --upload\r\nContent-Disposition: form-data; name=\"dir\"\r\n\r\nb\r\n\
             --upload\r\nContent-Disposition: form-data; name=\"file\"; filename=\"image.png\"\r\n\r\ndraft bytes\r\n--upload--\r\n"
        );
        let response = app
            .oneshot(
                Request::post("/api/attachments?w=w-1")
                    .header("content-type", "multipart/form-data; boundary=upload")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 4096).await.unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["root"], "draft");
        assert_eq!(value["path"], "b/image.png");
        assert_eq!(value["draft_id"], id);
        assert_eq!(
            workspace
                .draft_files()
                .unwrap()
                .read("b/image.png", &id)
                .unwrap(),
            b"draft bytes"
        );
        assert_eq!(workspace.read("b/image.png").unwrap(), b"user bytes");
        let frame = tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .unwrap()
            .unwrap();
        let event: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(event["type"], "draft");
        assert_eq!(event["event"], "modified");
        assert_eq!(event["source_w"], "w-1");
        assert_eq!(event["source"], value);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn held_draft_upload_settles_before_discard_and_cannot_restore_the_source() {
        let cfg = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let library = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        library.register_workspace(root.path()).unwrap();
        let workspace = library.open_workspace(root.path()).unwrap();
        workspace.create_draft_dir("b").unwrap();
        let id = workspace.draft_id("b").unwrap();
        workspace
            .draft_files()
            .unwrap()
            .create_text_new("b/draft.md", &id, "# seed\n")
            .unwrap();
        let state = Arc::new(crate::state::test_support::workspace_app_state(
            library,
            root.path().to_path_buf(),
            workspace.clone(),
        ));
        let router = crate::router(state);
        let (ready, arrived) = tokio::sync::oneshot::channel();
        let (resume, released) = mpsc::channel();
        pauses().lock().unwrap().insert(
            (workspace.root().into(), b'h'),
            Pause {
                ready,
                resume: released,
            },
        );
        let body = format!(
            "--upload\r\nContent-Disposition: form-data; name=\"root\"\r\n\r\ndraft\r\n\
             --upload\r\nContent-Disposition: form-data; name=\"draft_id\"\r\n\r\n{id}\r\n\
             --upload\r\nContent-Disposition: form-data; name=\"dir\"\r\n\r\nb\r\n\
             --upload\r\nContent-Disposition: form-data; name=\"file\"; filename=\"image.png\"\r\n\r\nheld bytes\r\n--upload--\r\n"
        );
        let upload_router = router.clone();
        let upload = tokio::spawn(async move {
            upload_router
                .oneshot(
                    Request::post("/api/attachments")
                        .header("content-type", "multipart/form-data; boundary=upload")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap()
        });
        tokio::time::timeout(Duration::from_secs(5), arrived)
            .await
            .expect("upload reached its publish pause")
            .unwrap();

        let discard_router = router.clone();
        let source =
            serde_json::json!({"source":{"root":"draft","path":"b/draft.md","draft_id":id}});
        let mut discard = tokio::spawn(async move {
            discard_router
                .oneshot(
                    Request::post("/api/drafts/discard")
                        .header("content-type", "application/json")
                        .body(Body::from(source.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap()
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(150), &mut discard)
                .await
                .is_err(),
            "discard crossed an active upload pin"
        );
        resume.send(()).unwrap();
        let uploaded = tokio::time::timeout(Duration::from_secs(5), upload)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(uploaded.status(), StatusCode::OK);
        let discarded = tokio::time::timeout(Duration::from_secs(5), discard)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(discarded.status(), StatusCode::NO_CONTENT);
        assert!(!workspace.drafts_dir().join("b").exists());
        workspace.create_draft_dir("b").unwrap();
        let next_id = workspace.draft_id("b").unwrap();
        assert_ne!(next_id, id);
        assert!(!workspace.drafts_dir().join("b/image.png").exists());
    }

    #[tokio::test]
    async fn upload_without_document_directory_is_refused() {
        let cfg = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let library = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        library.register_workspace(root.path()).unwrap();
        let workspace = library.open_workspace(root.path()).unwrap();
        let state = Arc::new(crate::state::test_support::workspace_app_state(
            library,
            root.path().to_path_buf(),
            workspace,
        ));
        let app = axum::Router::new()
            .route("/api/attachments", axum::routing::post(api_post_attachment))
            .with_state(state);
        let body = "--upload\r\nContent-Disposition: form-data; name=\"file\"; filename=\"image.png\"\r\n\r\nbytes\r\n--upload--\r\n";
        let response = app
            .oneshot(
                Request::post("/api/attachments")
                    .header("content-type", "multipart/form-data; boundary=upload")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
