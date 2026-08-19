//! Draft routes for the standalone terminal tenant.
//!
//! Siblings of the workspace draft routes in [`super::drafts`], never the
//! same functions: the wire SHAPES are shared by importing the seeds,
//! payload types, and response types from there, while the semantics
//! differ where the tenants differ. A workspace draft is an in-root
//! relpath under `.Drafts/`; a standalone draft lives in the per-library
//! [`chan_workspace::DraftStore`] and is addressed by MINI WIRE PATHS
//! over the capability root (e.g. `home/user/.chan/Drafts/untitled/draft.md`),
//! so the SPA reads and edits it over the existing `/api/fs` lanes with
//! no special routing.
//!
//! Every handler snapshots the drafts bundle and answers 404 on a tenant
//! that did not construct it, the `standalone_fs` posture. Mutating
//! handlers ride the `?w=` mutation-ticket bus, never the workspace
//! tenants' `self_writes` suppression: the shared tenant's sibling
//! windows must relist while the writer's own window stays attributed.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chan_workspace::{ChanError, WatchEvent, WatchKind};

use crate::error::{err, err_from};
use crate::state::{AppState, StandaloneDrafts, StandaloneFilesState};

use super::drafts::{
    draft_seed_for_body, promote_mode_label, DraftCreateResponse, DraftInspectResponse,
    DraftPathPayload, DraftPromotePayload, DraftPromoteResponse, NEW_DIAGRAM_CONTENT,
};
use super::standalone_fs::{
    begin_mutation, cancel_mutation, commit_mutation, generation, StandaloneMutationQuery,
};

/// Snapshot the tenant's drafts bundle, or `None` when this tenant serves
/// no drafts (no files surface, or the store did not construct).
fn drafts_state(state: &AppState) -> Option<(Arc<StandaloneFilesState>, Arc<StandaloneDrafts>)> {
    let files = state.standalone_files.clone()?;
    let drafts = files.drafts.clone()?;
    Some((files, drafts))
}

/// The uniform miss for every handler here; mounting is unconditional, so
/// this 404 is the per-tenant gate.
fn drafts_not_served() -> Response {
    err(
        StatusCode::NOT_FOUND,
        "drafts not served on this tenant".to_string(),
    )
}

/// Extract the draft leaf name from a mini wire path, the standalone
/// mirror of the workspace lane's `draft_name_from_path`: strip the
/// tenant's drafts wire root, take the first segment.
fn draft_name_from_wire(wire_root: &str, path: &str) -> Result<String, ChanError> {
    let trimmed = path.trim_matches('/');
    let rest = trimmed
        .strip_prefix(wire_root)
        .and_then(|r| r.strip_prefix('/'))
        .ok_or_else(|| {
            ChanError::Io(format!(
                "path `{path}` is not under the drafts directory `{wire_root}`"
            ))
        })?;
    let name = rest.split('/').next().unwrap_or("");
    if name.is_empty() {
        return Err(ChanError::Io(format!(
            "path `{path}` carries no draft name under `{wire_root}`"
        )));
    }
    Ok(name.to_string())
}

/// One name-resolve/create/seed attempt cycle shared by the draft and
/// diagram creators. The untitled name is picked before the mutation
/// ticket opens (the ticket needs the expected wire paths, which carry
/// the name), so a lost create race cancels the ticket and re-resolves;
/// mirrors the workspace lane's retry-once contract.
async fn create_with_retry(
    files: &Arc<StandaloneFilesState>,
    drafts: &Arc<StandaloneDrafts>,
    w: Option<&str>,
    primary_leaf: fn(&str) -> String,
    seed: &'static str,
) -> Response {
    for _ in 0..2 {
        let store = drafts.clone();
        let name = match tokio::task::spawn_blocking(move || store.store.next_untitled_name()).await
        {
            Ok(Ok(name)) => name,
            Ok(Err(e)) => return err_from(&e),
            Err(join) => return err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
        };
        let leaf = primary_leaf(&name);
        let dir_wire = format!("{}/{name}", drafts.wire_root);
        let primary_wire = format!("{dir_wire}/{leaf}");
        // The ticket opens before the first disk syscall so a subscribed
        // sibling watch cannot observe an untracked echo. The drafts
        // ROOT dir's own first-time materialization is deliberately not
        // in the expected set: that echo should reach every window
        // (including the writer) as the genuine new directory it is.
        let ticket = begin_mutation(files, w, &[dir_wire.clone(), primary_wire.clone()]);
        let store = drafts.clone();
        let task_name = name.clone();
        let task_leaf = leaf.clone();
        let result = tokio::task::spawn_blocking(move || {
            store.store.create_draft_dir(&task_name)?;
            store.store.write_primary(&task_name, &task_leaf, seed)
        })
        .await;
        match result {
            Ok(Ok(())) => {
                commit_mutation(
                    files,
                    ticket,
                    vec![
                        WatchEvent::file(WatchKind::Created, &dir_wire, generation()),
                        WatchEvent::file(WatchKind::Created, &primary_wire, generation()),
                    ],
                );
                return Json(DraftCreateResponse {
                    path: primary_wire,
                    name,
                })
                .into_response();
            }
            Ok(Err(ChanError::Io(message))) if message.contains("already exists") => {
                cancel_mutation(files, ticket);
                continue;
            }
            Ok(Err(e)) => {
                cancel_mutation(files, ticket);
                return err_from(&e);
            }
            Err(join) => {
                cancel_mutation(files, ticket);
                return err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string());
            }
        }
    }
    err(
        StatusCode::INTERNAL_SERVER_ERROR,
        "race condition picking next untitled draft name (retried 2x)".to_string(),
    )
}

/// `POST /api/drafts/new?w=`: create a seeded draft in the per-library
/// store. Same body contract as the workspace route (empty or `{}` seeds
/// markdown, `{"kind":"slides"}` the deck, anything else 400), shared by
/// importing `draft_seed_for_body` rather than copying it.
pub async fn api_standalone_create_draft(
    State(state): State<Arc<AppState>>,
    Query(query): Query<StandaloneMutationQuery>,
    body: axum::body::Bytes,
) -> Response {
    let Some((files, drafts)) = drafts_state(&state) else {
        return drafts_not_served();
    };
    let seed = match draft_seed_for_body(&body) {
        Ok(seed) => seed,
        Err(message) => return err(StatusCode::BAD_REQUEST, message),
    };
    create_with_retry(
        &files,
        &drafts,
        query.w.as_deref(),
        |_| "draft.md".to_string(),
        seed,
    )
    .await
}

/// `POST /api/diagrams/new?w=`: create a seeded Excalidraw draft, the
/// standalone mirror of the workspace route (same odd `/api/diagrams`
/// path, same seed bytes).
pub async fn api_standalone_create_diagram(
    State(state): State<Arc<AppState>>,
    Query(query): Query<StandaloneMutationQuery>,
) -> Response {
    let Some((files, drafts)) = drafts_state(&state) else {
        return drafts_not_served();
    };
    create_with_retry(
        &files,
        &drafts,
        query.w.as_deref(),
        |name| format!("{name}.excalidraw"),
        NEW_DIAGRAM_CONTENT,
    )
    .await
}

/// `POST /api/drafts/inspect`: same response shape as the workspace
/// route, with the `path` echoed in wire form. Read-only, no ticket.
pub async fn api_standalone_inspect_draft(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<DraftPathPayload>,
) -> Response {
    let Some((_files, drafts)) = drafts_state(&state) else {
        return drafts_not_served();
    };
    let name = match draft_name_from_wire(&drafts.wire_root, &payload.path) {
        Ok(name) => name,
        Err(e) => return err_from(&e),
    };
    let store = drafts.clone();
    let task_name = name.clone();
    let result = tokio::task::spawn_blocking(move || store.store.inspect(&task_name)).await;
    match result {
        Ok(Ok(info)) => Json(DraftInspectResponse {
            path: format!("{}/{name}/draft.md", drafts.wire_root),
            name,
            file_count: info.file_count,
            dir_count: info.dir_count,
            total_size: info.total_size,
            has_attachments: info.has_attachments,
        })
        .into_response(),
        Ok(Err(e)) => err_from(&e),
        Err(join) => err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string()),
    }
}

/// `POST /api/drafts/discard?w=`: move the draft into the store's trash.
/// 204 like the workspace route.
pub async fn api_standalone_discard_draft(
    State(state): State<Arc<AppState>>,
    Query(query): Query<StandaloneMutationQuery>,
    Json(payload): Json<DraftPathPayload>,
) -> Response {
    let Some((files, drafts)) = drafts_state(&state) else {
        return drafts_not_served();
    };
    let name = match draft_name_from_wire(&drafts.wire_root, &payload.path) {
        Ok(name) => name,
        Err(e) => return err_from(&e),
    };
    let dir_wire = format!("{}/{name}", drafts.wire_root);
    let ticket = begin_mutation(&files, query.w.as_deref(), std::slice::from_ref(&dir_wire));
    let store = drafts.clone();
    let task_name = name.clone();
    let result = tokio::task::spawn_blocking(move || store.store.discard(&task_name)).await;
    match result {
        Ok(Ok(())) => {
            commit_mutation(
                &files,
                ticket,
                vec![WatchEvent::file(
                    WatchKind::Removed,
                    &dir_wire,
                    generation(),
                )],
            );
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(Err(e)) => {
            cancel_mutation(&files, ticket);
            err_from(&e)
        }
        Err(join) => {
            cancel_mutation(&files, ticket);
            err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string())
        }
    }
}

/// `POST /api/drafts/promote?w=`: move the draft to a destination in
/// the machine tree. The target is a mini wire path resolved through the
/// facade (`MiniWorkspace::resolve_write_target`), so the wire dialect,
/// symlink inertness, and protected paths hold before the store's shared
/// no-clobber and merge semantics run.
pub async fn api_standalone_promote_draft(
    State(state): State<Arc<AppState>>,
    Query(query): Query<StandaloneMutationQuery>,
    Json(payload): Json<DraftPromotePayload>,
) -> Response {
    let Some((files, drafts)) = drafts_state(&state) else {
        return drafts_not_served();
    };
    let name = match draft_name_from_wire(&drafts.wire_root, &payload.path) {
        Ok(name) => name,
        Err(e) => return err_from(&e),
    };
    let (target_rel, target_abs) = match files.fs.resolve_write_target(&payload.target) {
        Ok(resolved) => resolved,
        Err(e) => return err_from(&e),
    };
    let dir_wire = format!("{}/{name}", drafts.wire_root);
    let ticket = begin_mutation(
        &files,
        query.w.as_deref(),
        &[dir_wire.clone(), target_rel.clone()],
    );
    let store = drafts.clone();
    let task_name = name.clone();
    let task_rel = target_rel.clone();
    let result = tokio::task::spawn_blocking(move || {
        store.store.promote_to(&task_name, &target_abs, &task_rel)
    })
    .await;
    match result {
        Ok(Ok(report)) => {
            commit_mutation(
                &files,
                ticket,
                vec![
                    WatchEvent::file(WatchKind::Removed, &dir_wire, generation()),
                    WatchEvent::file(WatchKind::Created, &target_rel, generation()),
                ],
            );
            Json(DraftPromoteResponse {
                path: report.target_path,
                name: report.name,
                mode: promote_mode_label(report.mode),
            })
            .into_response()
        }
        Ok(Err(e)) => {
            cancel_mutation(&files, ticket);
            err_from(&e)
        }
        Err(join) => {
            cancel_mutation(&files, ticket);
            err(StatusCode::INTERNAL_SERVER_ERROR, join.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::body::{to_bytes, Body};
    use axum::http::{header, Request, StatusCode};
    use serde_json::{json, Value};
    use tower::ServiceExt;

    use super::super::drafts::{NEW_DIAGRAM_CONTENT, NEW_DRAFT_CONTENT, NEW_SLIDES_CONTENT};
    use super::super::standalone_fs::test_fixture::{files_fixture, Fixture};

    fn router(fixture: &Fixture) -> axum::Router {
        crate::terminal_router(fixture.state.clone())
    }

    async fn body_json(response: axum::response::Response) -> Value {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    }

    /// POST with an optional JSON body the way the SPA does: no body
    /// means no content-type header either.
    async fn post(fx: &Fixture, uri: &str, body: Option<&str>) -> axum::response::Response {
        let mut req = Request::builder().method("POST").uri(uri);
        let body = if let Some(b) = body {
            req = req.header(header::CONTENT_TYPE, "application/json");
            Body::from(b.to_string())
        } else {
            Body::empty()
        };
        router(fx).oneshot(req.body(body).unwrap()).await.unwrap()
    }

    #[tokio::test]
    async fn create_draft_serves_wire_paths_readable_over_the_fs_lane() {
        let fx = files_fixture();

        let response = post(&fx, "/api/drafts/new", None).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            body_json(response).await,
            json!({
                "path": "home/user/.chan/Drafts/untitled/draft.md",
                "name": "untitled",
            })
        );
        // Byte-identical seed on disk: the SPA's pristine-discard
        // detection compares against this exact string.
        assert_eq!(
            std::fs::read_to_string(fx.root.join("home/user/.chan/Drafts/untitled/draft.md"))
                .unwrap(),
            NEW_DRAFT_CONTENT
        );
        // The returned path is an ordinary wire path: the EXISTING
        // /api/fs read lane serves it (as the editor's JSON envelope)
        // with no draft-specific routing.
        let read = router(&fx)
            .oneshot(
                Request::builder()
                    .uri("/api/fs/home/user/.chan/Drafts/untitled/draft.md")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(read.status(), StatusCode::OK);
        let body = body_json(read).await;
        assert_eq!(body["content"], NEW_DRAFT_CONTENT);
        assert_eq!(body["writable"], true);

        // A second create picks the next untitled name.
        let response = post(&fx, "/api/drafts/new", None).await;
        assert_eq!(
            body_json(response).await["path"],
            "home/user/.chan/Drafts/untitled-1/draft.md"
        );
    }

    #[tokio::test]
    async fn create_draft_kinds_mirror_the_workspace_contract() {
        let fx = files_fixture();

        let response = post(&fx, "/api/drafts/new", Some(r#"{"kind":"slides"}"#)).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            std::fs::read_to_string(fx.root.join("home/user/.chan/Drafts/untitled/draft.md"))
                .unwrap(),
            NEW_SLIDES_CONTENT
        );

        let response = post(&fx, "/api/drafts/new", Some(r#"{"kind":"sculpture"}"#)).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(
            !fx.root.join("home/user/.chan/Drafts/untitled-1").exists(),
            "a refused kind must create nothing"
        );
    }

    #[tokio::test]
    async fn create_diagram_seeds_the_excalidraw_board() {
        let fx = files_fixture();

        let response = post(&fx, "/api/diagrams/new", None).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            body_json(response).await,
            json!({
                "path": "home/user/.chan/Drafts/untitled/untitled.excalidraw",
                "name": "untitled",
            })
        );
        assert_eq!(
            std::fs::read_to_string(
                fx.root
                    .join("home/user/.chan/Drafts/untitled/untitled.excalidraw")
            )
            .unwrap(),
            NEW_DIAGRAM_CONTENT
        );
    }

    #[tokio::test]
    async fn inspect_then_discard_lands_the_draft_in_the_store_trash() {
        let fx = files_fixture();
        post(&fx, "/api/drafts/new", None).await;

        let response = post(
            &fx,
            "/api/drafts/inspect",
            Some(r#"{"path":"home/user/.chan/Drafts/untitled/draft.md"}"#),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        assert_eq!(body["name"], "untitled");
        assert_eq!(body["file_count"], 1);
        assert_eq!(body["has_attachments"], false);

        let response = post(
            &fx,
            "/api/drafts/discard",
            Some(r#"{"path":"home/user/.chan/Drafts/untitled/draft.md"}"#),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(!fx.root.join("home/user/.chan/Drafts/untitled").exists());
        // The discard is a first-class flat trash entry under the store's
        // dedicated trash root, labeled for restore.
        let trash = fx.root.join("home/user/.chan/drafts-trash");
        let entries: Vec<_> = std::fs::read_dir(&trash).unwrap().flatten().collect();
        assert_eq!(entries.len(), 1);
        let meta: Value =
            serde_json::from_slice(&std::fs::read(entries[0].path().join("meta.json")).unwrap())
                .unwrap();
        assert_eq!(meta["original_path"], "Drafts/untitled");
    }

    #[tokio::test]
    async fn promote_resolves_targets_through_the_facade() {
        let fx = files_fixture();
        post(&fx, "/api/drafts/new", None).await;

        // Refusals first: the wire dialect holds for promotion targets.
        for target in ["/etc/pwned.md", "../escape.md"] {
            let body = format!(
                r#"{{"path":"home/user/.chan/Drafts/untitled/draft.md","target":"{target}"}}"#
            );
            let response = post(&fx, "/api/drafts/promote", Some(&body)).await;
            assert_ne!(
                response.status(),
                StatusCode::OK,
                "promote must refuse target {target:?}"
            );
            assert!(
                fx.root.join("home/user/.chan/Drafts/untitled").exists(),
                "a refused promote must keep the draft"
            );
        }

        // The target parent must exist, exactly like the workspace lane's
        // promote (a missing parent refuses rather than mkdir-ing).
        std::fs::create_dir_all(fx.root.join("home/user/notes")).unwrap();
        let response = post(
            &fx,
            "/api/drafts/promote",
            Some(
                r#"{"path":"home/user/.chan/Drafts/untitled/draft.md","target":"home/user/notes/note.md"}"#,
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            body_json(response).await,
            json!({
                "path": "home/user/notes/note.md",
                "name": "untitled",
                "mode": "file",
            })
        );
        assert!(!fx.root.join("home/user/.chan/Drafts/untitled").exists());
        assert_eq!(
            std::fs::read_to_string(fx.root.join("home/user/notes/note.md")).unwrap(),
            NEW_DRAFT_CONTENT
        );

        // No-clobber: promoting onto the file that now exists refuses.
        post(&fx, "/api/drafts/new", None).await;
        let response = post(
            &fx,
            "/api/drafts/promote",
            Some(
                r#"{"path":"home/user/.chan/Drafts/untitled/draft.md","target":"home/user/notes/note.md"}"#,
            ),
        )
        .await;
        assert_ne!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn mutating_draft_routes_emit_attributed_fs_frames() {
        let fx = files_fixture();
        let (id, mut rx) = fx.registry.register();
        fx.registry.subscribe(id, "home/user/.chan/Drafts");

        let response = post(&fx, "/api/drafts/new?w=w-writer", None).await;
        assert_eq!(response.status(), StatusCode::OK);
        let frame: Value =
            serde_json::from_str(&rx.try_recv().expect("attributed create frame")).unwrap();
        assert_eq!(frame["type"], "fs");
        assert_eq!(frame["source_w"], "w-writer");
        assert_eq!(frame["event"]["path"], "home/user/.chan/Drafts/untitled");

        // Unattributed mutations skip the bus entirely.
        let response = post(
            &fx,
            "/api/drafts/discard",
            Some(r#"{"path":"home/user/.chan/Drafts/untitled/draft.md"}"#),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(
            rx.try_recv().is_err(),
            "an unattributed discard must not emit a synthetic frame"
        );
    }

    #[tokio::test]
    async fn draft_routes_answer_not_served_without_the_store() {
        let state = crate::state::test_support::make_test_state(false);
        let app = crate::terminal_router(state);
        for (uri, body) in [
            ("/api/drafts/new", None),
            ("/api/diagrams/new", None),
            ("/api/drafts/inspect", Some(r#"{"path":"x"}"#)),
            ("/api/drafts/discard", Some(r#"{"path":"x"}"#)),
            ("/api/drafts/promote", Some(r#"{"path":"x","target":"y"}"#)),
        ] {
            let mut req = Request::builder().method("POST").uri(uri);
            let body = if let Some(b) = body {
                req = req.header(header::CONTENT_TYPE, "application/json");
                Body::from(b.to_string())
            } else {
                Body::empty()
            };
            let response = app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri}");
            assert_eq!(
                body_json(response).await,
                json!({"error": "drafts not served on this tenant"}),
                "{uri}"
            );
        }
    }
}
