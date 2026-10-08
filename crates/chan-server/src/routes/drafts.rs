//! Drafts route.
//!
//! Workspace draft routes serve the sidecar Drafts capability. Their file
//! identities carry a root and lifetime ID so a path in the user's root
//! cannot alias a draft of the same name.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};

use crate::error::{err, err_from, err_state};
use crate::extract::{Json, Query};
use crate::routes::files::MutationWindowQuery;
use crate::routes::files::{draft_event, FileIdentity, FileRoot};
use crate::routes::run_blocking;
use crate::routes::workspace::{workspace_warnings, WorkspaceWarning};
use crate::state::AppState;

pub(crate) const NEW_DRAFT_CONTENT: &str = "# Draft\n";

/// Seed for a brand-new slide deck: the canonical `chan: kind: slides`
/// frontmatter block the SPA's `parseSlidesSpec` recognizes (16:9 default
/// aspect) plus a first slide heading and its page-break authoring hint, so the
/// draft opens straight into the slides layout. The primary file is still
/// `draft.md`: a deck is markdown.
pub(crate) const NEW_SLIDES_CONTENT: &str = r#"---
chan:
  kind: slides
  slides:
    aspect_ratio: "16:9"
    zoom_factor: 2
---

# Slide 1
* use `@pagebreak` on empty line to create new slide
"#;

/// Seed for a brand-new diagram: a valid, non-empty Excalidraw scene so
/// the board opens cleanly and is not treated as an empty file that
/// auto-discards on close. `ExcalidrawCanvas` parses it as an empty
/// board. The frontend mirrors this exact string as its diagram seed so
/// a never-drawn board still discards silently on close.
pub(crate) const NEW_DIAGRAM_CONTENT: &str =
    r#"{"type":"excalidraw","version":2,"source":"chan","elements":[],"appState":{},"files":{}}"#;

fn draft_name_from_identity(source: &FileIdentity) -> Result<&str, chan_workspace::ChanError> {
    if source.root != FileRoot::Draft {
        return Err(chan_workspace::ChanError::PathEscape);
    }
    chan_workspace::fs_ops::validate_rel(&source.path)?;
    let name = source.path.split('/').next().unwrap_or("");
    if name.is_empty() || source.path.ends_with('/') {
        return Err(chan_workspace::ChanError::PathEmpty);
    }
    Ok(name)
}

fn draft_id_from_identity(source: &FileIdentity) -> Result<&str, chan_workspace::ChanError> {
    source
        .draft_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .ok_or(chan_workspace::ChanError::PathEscape)
}

#[derive(Deserialize)]
pub struct DraftPathPayload {
    /// Any path inside the draft directory, usually
    /// `<drafts_dir>/<name>/draft.md`.
    pub path: String,
}

#[derive(Deserialize)]
pub struct DraftPromotePayload {
    /// Any path inside the draft directory.
    pub path: String,
    /// Workspace-relative destination. Single-file drafts save to this
    /// file; workspace drafts save to this directory.
    pub target: String,
}

#[derive(Deserialize)]
pub(crate) struct TaggedDraftSourcePayload {
    source: FileIdentity,
}

#[derive(Deserialize)]
pub(crate) struct TaggedDraftPromotePayload {
    source: FileIdentity,
    target: String,
}

#[derive(Serialize)]
pub struct DraftCreateResponse {
    /// Path relative to the draft capability root.
    pub path: String,
    /// Bare draft name, kept for display and name allocation.
    pub name: String,
}

#[derive(Serialize)]
struct TaggedDraftCreateResponse {
    #[serde(flatten)]
    base: DraftCreateResponse,
    primary: FileIdentity,
}

#[derive(Serialize)]
struct DraftListRow {
    name: String,
    primary: FileIdentity,
    has_attachments: bool,
}

#[derive(Serialize)]
struct DraftListResponse {
    drafts: Vec<DraftListRow>,
    warnings: Vec<WorkspaceWarning>,
}

#[derive(Deserialize)]
pub(crate) struct DraftTerminalPathsPayload {
    sources: Vec<FileIdentity>,
}

#[derive(Serialize)]
struct DraftTerminalPath {
    source: FileIdentity,
    absolute_path: String,
}

#[derive(Serialize)]
struct DraftTerminalPathsResponse {
    paths: Vec<DraftTerminalPath>,
}

#[derive(Serialize, PartialEq, Eq, Debug)]
pub struct DraftInspectResponse {
    pub path: String,
    pub name: String,
    pub file_count: usize,
    pub dir_count: usize,
    pub total_size: u64,
    pub has_attachments: bool,
}

#[derive(Serialize)]
struct TaggedDraftInspectResponse {
    #[serde(flatten)]
    base: DraftInspectResponse,
    primary: FileIdentity,
}

#[derive(Serialize, PartialEq, Eq, Debug)]
pub struct DraftPromoteResponse {
    pub path: String,
    pub name: String,
    pub mode: &'static str,
}

#[derive(Serialize)]
struct TaggedDraftPromoteResponse {
    #[serde(flatten)]
    base: DraftPromoteResponse,
    primary: FileIdentity,
    target: String,
}

/// Optional body of `POST /api/drafts/new`. The plain Cmd+N path sends no
/// body at all; `kind` picks the seed content when present.
#[derive(Deserialize, Default)]
pub struct DraftCreatePayload {
    /// `"slides"` seeds a slide deck; absent seeds a markdown draft.
    #[serde(default)]
    kind: Option<String>,
}

/// Resolve the `draft.md` seed for a create-draft request body. An empty
/// body or an omitted `kind` seeds the markdown draft; `{"kind":"slides"}`
/// seeds the slide deck. Anything else is a client error, refused before
/// touching the workspace.
pub(crate) fn draft_seed_for_body(body: &[u8]) -> Result<&'static str, String> {
    if body.is_empty() {
        return Ok(NEW_DRAFT_CONTENT);
    }
    let payload: DraftCreatePayload =
        serde_json::from_slice(body).map_err(|e| format!("invalid create-draft body: {e}"))?;
    match payload.kind.as_deref() {
        None => Ok(NEW_DRAFT_CONTENT),
        Some("slides") => Ok(NEW_SLIDES_CONTENT),
        Some(other) => Err(format!(
            "unknown draft kind {other:?} (expected \"slides\")"
        )),
    }
}

/// List healthy sidecar drafts and their non-fatal preflight warnings in one read.
pub async fn api_list_drafts(State(state): State<Arc<AppState>>) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    let result = run_blocking("list drafts", move || list_drafts_sync(&workspace)).await;
    match result {
        Ok(Ok(out)) => Json(out).into_response(),
        Ok(Err(error)) => err_from(&error),
        Err(failed) => failed.into_response(),
    }
}

fn list_drafts_sync(
    workspace: &Arc<chan_workspace::Workspace>,
) -> Result<DraftListResponse, chan_workspace::ChanError> {
    let warnings = workspace_warnings(workspace);
    if warnings
        .iter()
        .any(|warning| warning.kind == "draft_preflight_failed")
    {
        return Ok(DraftListResponse {
            drafts: Vec::new(),
            warnings,
        });
    }
    let mut drafts = Vec::new();
    for draft in workspace.list_drafts()? {
        if warnings.iter().any(|warning| {
            warning.kind == "broken_draft"
                && warning.path.as_str() == draft.abs.to_string_lossy().as_ref()
        }) {
            continue;
        }
        let id = workspace.draft_id(&draft.name)?;
        let pin = workspace.pin_draft(&draft.name, &id)?;
        let info = pin.workspace().inspect_draft(&draft.name)?;
        drafts.push(DraftListRow {
            primary: FileIdentity::draft(format!("{}/{}", draft.name, info.primary_path), id),
            name: draft.name,
            has_attachments: info.has_attachments,
        });
    }
    Ok(DraftListResponse { drafts, warnings })
}

/// Resolve terminal-facing absolute paths only after each draft file is validated.
pub async fn api_draft_terminal_paths(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<DraftTerminalPathsPayload>,
) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    let result = run_blocking("draft terminal paths", move || {
        terminal_paths_sync(&workspace, payload.sources)
    })
    .await;
    match result {
        Ok(Ok(out)) => Json(out).into_response(),
        Ok(Err(error)) => err_from(&error),
        Err(failed) => failed.into_response(),
    }
}

fn terminal_paths_sync(
    workspace: &Arc<chan_workspace::Workspace>,
    sources: Vec<FileIdentity>,
) -> Result<DraftTerminalPathsResponse, chan_workspace::ChanError> {
    let mut paths = Vec::with_capacity(sources.len());
    for source in sources {
        let name = draft_name_from_identity(&source)?;
        let id = draft_id_from_identity(&source)?;
        let pin = workspace.pin_draft(name, id)?;
        let absolute = pin
            .workspace()
            .draft_files()?
            .terminal_path(&source.path, pin.id())?;
        paths.push(DraftTerminalPath {
            source,
            absolute_path: absolute.to_string_lossy().into_owned(),
        });
    }
    Ok(DraftTerminalPathsResponse { paths })
}

/// Create a fresh draft directory + a seeded `draft.md` inside.
///
/// Race-window note: `next_untitled_draft_name` + `create_draft_dir`
/// can race against another concurrent creator; if `create_draft_dir`
/// returns `AlreadyExists` we retry once with a re-resolved name.
/// The race is rare in practice (single-user / single-machine) but
/// the retry keeps the contract clean.
pub async fn api_create_draft(
    State(state): State<Arc<AppState>>,
    Query(window): Query<MutationWindowQuery>,
    body: crate::extract::Bytes,
) -> Response {
    let seed = match draft_seed_for_body(&body) {
        Ok(seed) => seed,
        Err(message) => return err(StatusCode::BAD_REQUEST, message),
    };
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    let source_w = window.window().map(str::to_string);
    let result = run_blocking("create draft", move || {
        let name = create_draft_sync(&workspace, seed)?;
        let id = workspace.draft_id(&name)?;
        let primary = FileIdentity::draft(format!("{name}/draft.md"), id);
        Ok::<_, chan_workspace::ChanError>((name, primary))
    })
    .await;

    let (name, primary) = match result {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => return err_from(&e),
        Err(failed) => return failed.into_response(),
    };

    let event = draft_event("created", primary.clone(), None, source_w.as_deref());
    let _ = state.events_tx.send(event);
    Json(TaggedDraftCreateResponse {
        base: DraftCreateResponse {
            path: primary.path.clone(),
            name,
        },
        primary,
    })
    .into_response()
}

/// Create a fresh draft directory + a seeded `<name>.excalidraw` board
/// inside, mirroring `api_create_draft`. The diagram is a real draft
/// (promotable + discardable) whose primary file is the Excalidraw
/// scene rather than `draft.md`.
pub async fn api_create_diagram(
    State(state): State<Arc<AppState>>,
    Query(window): Query<MutationWindowQuery>,
) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    let source_w = window.window().map(str::to_string);
    let result = run_blocking("create diagram", move || {
        let (name, path) = create_diagram_sync(&workspace)?;
        let id = workspace.draft_id(&name)?;
        Ok::<_, chan_workspace::ChanError>((name, FileIdentity::draft(path, id)))
    })
    .await;

    let (name, primary) = match result {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => return err_from(&e),
        Err(failed) => return failed.into_response(),
    };

    let event = draft_event("created", primary.clone(), None, source_w.as_deref());
    let _ = state.events_tx.send(event);
    Json(TaggedDraftCreateResponse {
        base: DraftCreateResponse {
            path: primary.path.clone(),
            name,
        },
        primary,
    })
    .into_response()
}

fn create_diagram_sync(
    workspace: &chan_workspace::Workspace,
) -> Result<(String, String), chan_workspace::ChanError> {
    for _ in 0..2 {
        let name = workspace.next_untitled_draft_name()?;
        #[cfg(test)]
        tests::collide_next_name(workspace, &name);
        match workspace.create_draft_dir(&name) {
            Ok(_) => {
                let path = format!("{name}/{name}.excalidraw");
                let id = workspace.draft_id(&name)?;
                workspace
                    .draft_files()?
                    .create_text_new(&path, &id, NEW_DIAGRAM_CONTENT)?;
                return Ok((name, path));
            }
            Err(chan_workspace::ChanError::PathAlreadyExists(_)) => {
                continue;
            }
            Err(e) => return Err(e),
        }
    }
    Err(chan_workspace::ChanError::Io(
        "race condition picking next untitled diagram name (retried 2x)".to_string(),
    ))
}

fn create_draft_sync(
    workspace: &chan_workspace::Workspace,
    seed: &str,
) -> Result<String, chan_workspace::ChanError> {
    for _ in 0..2 {
        let name = workspace.next_untitled_draft_name()?;
        #[cfg(test)]
        tests::collide_next_name(workspace, &name);
        match workspace.create_draft_dir(&name) {
            Ok(_) => {
                let path = format!("{name}/draft.md");
                let id = workspace.draft_id(&name)?;
                workspace.draft_files()?.create_text_new(&path, &id, seed)?;
                return Ok(name);
            }
            Err(chan_workspace::ChanError::PathAlreadyExists(_)) => {
                continue;
            }
            Err(e) => return Err(e),
        }
    }
    Err(chan_workspace::ChanError::Io(
        "race condition picking next untitled draft name (retried 2x)".to_string(),
    ))
}

pub async fn api_inspect_draft(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<TaggedDraftSourcePayload>,
) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    let result = run_blocking("inspect draft", move || {
        inspect_draft_sync(&workspace, &payload.source)
    })
    .await;

    match result {
        Ok(Ok(out)) => Json(out).into_response(),
        Ok(Err(e)) => err_from(&e),
        Err(failed) => failed.into_response(),
    }
}

pub async fn api_discard_draft(
    State(state): State<Arc<AppState>>,
    Query(window): Query<MutationWindowQuery>,
    Json(payload): Json<TaggedDraftSourcePayload>,
) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    let source = payload.source.clone();
    let source_w = window.window().map(str::to_string);
    let result = run_blocking("discard draft", move || {
        discard_draft_sync(&workspace, &payload.source)
    })
    .await;

    match result {
        Ok(Ok(())) => {
            let event = draft_event("discarded", source, None, source_w.as_deref());
            let _ = state.events_tx.send(event);
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(Err(e)) => err_from(&e),
        Err(failed) => failed.into_response(),
    }
}

pub async fn api_promote_draft(
    State(state): State<Arc<AppState>>,
    Query(window): Query<MutationWindowQuery>,
    Json(payload): Json<TaggedDraftPromotePayload>,
) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    let source = payload.source.clone();
    let source_w = window.window().map(str::to_string);
    let result = run_blocking("promote draft", move || {
        promote_draft_sync(&workspace, &payload.source, &payload.target)
    })
    .await;

    match result {
        Ok(Ok(out)) => {
            let event = draft_event(
                "promoted",
                source,
                Some(out.primary.clone()),
                source_w.as_deref(),
            );
            let _ = state.events_tx.send(event);
            Json(out).into_response()
        }
        Ok(Err(e)) => err_from(&e),
        Err(failed) => failed.into_response(),
    }
}

fn inspect_draft_sync(
    workspace: &Arc<chan_workspace::Workspace>,
    source: &FileIdentity,
) -> Result<TaggedDraftInspectResponse, chan_workspace::ChanError> {
    let name = draft_name_from_identity(source)?;
    let id = draft_id_from_identity(source)?;
    let pin = workspace.pin_draft(name, id)?;
    pin.workspace()
        .draft_files()?
        .check_file(&source.path, id)?;
    let info = pin.workspace().inspect_draft(name)?;
    let primary = FileIdentity::draft(format!("{name}/{}", info.primary_path), id.to_string());
    Ok(TaggedDraftInspectResponse {
        base: DraftInspectResponse {
            path: primary.path.clone(),
            name: name.to_string(),
            file_count: info.file_count,
            dir_count: info.dir_count,
            total_size: info.total_size,
            has_attachments: info.has_attachments,
        },
        primary,
    })
}

fn discard_draft_sync(
    workspace: &Arc<chan_workspace::Workspace>,
    source: &FileIdentity,
) -> Result<(), chan_workspace::ChanError> {
    let name = draft_name_from_identity(source)?;
    let Some(id) = source.draft_id.as_deref() else {
        return workspace.discard_broken_draft(name);
    };
    if id.is_empty() {
        return Err(chan_workspace::ChanError::Io(
            "a draft source requires a nonempty draft_id".into(),
        ));
    }
    let mut lifecycle = workspace.begin_draft_lifecycle(name, id)?;
    if source.path == name {
        if !matches!(
            lifecycle.workspace().inspect_draft(name),
            Err(chan_workspace::ChanError::DraftBroken { .. })
        ) {
            return Err(chan_workspace::ChanError::Io(
                "a bare draft name may discard only a broken draft".into(),
            ));
        }
    } else {
        lifecycle
            .workspace()
            .draft_files()?
            .check_file(&source.path, id)?;
    }
    lifecycle.workspace().discard_draft(name)?;
    lifecycle.retire();
    Ok(())
}

fn promote_draft_sync(
    workspace: &Arc<chan_workspace::Workspace>,
    source: &FileIdentity,
    target: &str,
) -> Result<TaggedDraftPromoteResponse, chan_workspace::ChanError> {
    let name = draft_name_from_identity(source)?;
    let id = draft_id_from_identity(source)?;
    let mut lifecycle = workspace.begin_draft_lifecycle(name, id)?;
    lifecycle
        .workspace()
        .draft_files()?
        .check_file(&source.path, id)?;
    let report = lifecycle.workspace().promote_draft(name, target)?;
    lifecycle.retire();
    let primary = FileIdentity::workspace(report.primary_path.clone());
    Ok(TaggedDraftPromoteResponse {
        base: DraftPromoteResponse {
            path: report.primary_path,
            name: report.name,
            mode: promote_mode_label(report.mode),
        },
        target: report.target_path,
        primary,
    })
}

pub(crate) fn promote_mode_label(mode: chan_workspace::DraftPromoteMode) -> &'static str {
    match mode {
        chan_workspace::DraftPromoteMode::File => "file",
        chan_workspace::DraftPromoteMode::DirectoryCreated => "directory_created",
        chan_workspace::DraftPromoteMode::DirectoryMerged => "directory_merged",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_workspace() -> (TempDir, TempDir, std::sync::Arc<chan_workspace::Workspace>) {
        let cfg = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        (cfg, root, workspace)
    }

    static COLLIDE_NEXT_NAME: Mutex<Vec<std::path::PathBuf>> = Mutex::new(Vec::new());

    pub(super) fn collide_next_name(workspace: &chan_workspace::Workspace, name: &str) {
        let mut pending = COLLIDE_NEXT_NAME.lock().unwrap();
        if let Some(index) = pending.iter().position(|root| root == workspace.root()) {
            pending.swap_remove(index);
            workspace.create_draft_dir(name).unwrap();
            let id = workspace.draft_id(name).unwrap();
            workspace
                .draft_files()
                .unwrap()
                .create_text_new(&format!("{name}/draft.md"), &id, "# occupied\n")
                .unwrap();
        }
    }

    #[tokio::test]
    async fn draft_collision_retries_workspace_note() {
        assert_collision_retry("/api/drafts/new", "draft.md", NEW_DRAFT_CONTENT).await;
    }

    #[tokio::test]
    async fn draft_collision_retries_workspace_diagram() {
        assert_collision_retry(
            "/api/diagrams/new",
            "untitled-1.excalidraw",
            NEW_DIAGRAM_CONTENT,
        )
        .await;
    }

    async fn assert_collision_retry(uri: &str, leaf: &str, seed: &str) {
        let app = route_test_app();
        let workspace = app.state.try_workspace().unwrap();
        COLLIDE_NEXT_NAME
            .lock()
            .unwrap()
            .push(workspace.root().to_path_buf());
        let response = crate::router(app.state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(uri)
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 8192)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["name"], "untitled-1");
        let occupied_id = workspace.draft_id("untitled").unwrap();
        assert_eq!(
            workspace
                .draft_files()
                .unwrap()
                .read_text_with_stat("untitled/draft.md", &occupied_id)
                .unwrap()
                .0,
            "# occupied\n"
        );
        let id = workspace.draft_id("untitled-1").unwrap();
        assert_eq!(
            workspace
                .draft_files()
                .unwrap()
                .read_text_with_stat(&format!("untitled-1/{leaf}"), &id)
                .unwrap()
                .0,
            seed
        );
    }

    #[test]
    fn create_draft_sync_seeds_title() {
        let (_cfg, _root, workspace) = make_workspace();

        let name = create_draft_sync(&workspace, NEW_DRAFT_CONTENT).unwrap();
        let path = format!("{name}/draft.md");
        let id = workspace.draft_id(&name).unwrap();

        assert_eq!(name, "untitled");
        assert_eq!(
            workspace
                .draft_files()
                .unwrap()
                .read_text_with_stat(&path, &id)
                .unwrap()
                .0,
            NEW_DRAFT_CONTENT
        );
    }

    #[test]
    fn workspace_draft_create_seeds_only_the_sidecar() {
        let (_cfg, root, workspace) = make_workspace();

        let name = create_draft_sync(&workspace, NEW_DRAFT_CONTENT).unwrap();

        assert_eq!(name, "untitled");
        assert_eq!(
            std::fs::read_to_string(workspace.drafts_dir().join("untitled/draft.md")).unwrap(),
            NEW_DRAFT_CONTENT
        );
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn create_response_carries_a_tagged_draft_lifetime() {
        let app = route_test_app();
        let response = crate::router(app.state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/drafts/new")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 8192)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["primary"]["root"], "draft");
        assert_eq!(body["primary"]["path"], "untitled/draft.md");
        assert!(!body["primary"]["draft_id"].as_str().unwrap().is_empty());
    }

    #[test]
    fn draft_seed_for_body_picks_the_kind() {
        // No body / no kind: the plain markdown draft (the Cmd+N path).
        assert_eq!(draft_seed_for_body(b"").unwrap(), NEW_DRAFT_CONTENT);
        assert_eq!(draft_seed_for_body(b"{}").unwrap(), NEW_DRAFT_CONTENT);
        // The slides kind seeds the deck.
        assert_eq!(
            draft_seed_for_body(br#"{"kind":"slides"}"#).unwrap(),
            NEW_SLIDES_CONTENT
        );
        // An unknown kind (and a malformed body) is refused, not defaulted.
        assert!(draft_seed_for_body(br#"{"kind":"sculpture"}"#)
            .unwrap_err()
            .contains("sculpture"));
        assert!(draft_seed_for_body(b"not json").is_err());
    }

    #[test]
    fn slides_seed_carries_the_canonical_frontmatter_block() {
        let (frontmatter, body) = NEW_SLIDES_CONTENT
            .split_once("\n\n")
            .expect("slides seed separates frontmatter from its body");
        assert_eq!(
            frontmatter,
            "---\nchan:\n  kind: slides\n  slides:\n    aspect_ratio: \"16:9\"\n    zoom_factor: 2\n---"
        );
        assert_eq!(
            body,
            "# Slide 1\n* use `@pagebreak` on empty line to create new slide\n"
        );
    }

    #[test]
    fn create_diagram_sync_seeds_a_valid_board_that_inspects_and_promotes() {
        let (_cfg, root, workspace) = make_workspace();

        let (name, path) = create_diagram_sync(&workspace).unwrap();

        assert_eq!(name, "untitled");
        assert_eq!(path, "untitled/untitled.excalidraw");

        // The seed is non-empty valid JSON and classifies as editable
        // text, so the editor opens it as a board.
        let id = workspace.draft_id(&name).unwrap();
        let content = workspace
            .draft_files()
            .unwrap()
            .read_text_with_stat(&path, &id)
            .unwrap()
            .0;
        assert_eq!(content, NEW_DIAGRAM_CONTENT);
        assert!(!content.is_empty());
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed["type"], "excalidraw");
        assert_eq!(
            chan_workspace::fs_ops::classify(&path),
            chan_workspace::FileClass::Text
        );

        // It is a real single-file draft: inspects cleanly (no
        // "missing draft.md" broken) and promotes to an .excalidraw file.
        let info = workspace.inspect_draft(&name).unwrap();
        assert!(!info.has_attachments);
        std::fs::create_dir_all(root.path().join("boards")).unwrap();
        let promoted = workspace
            .promote_draft(&name, "boards/diagram.excalidraw")
            .unwrap();
        assert_eq!(promoted.target_path, "boards/diagram.excalidraw");
        assert_eq!(
            std::fs::read_to_string(root.path().join("boards/diagram.excalidraw")).unwrap(),
            NEW_DIAGRAM_CONTENT
        );
    }

    #[test]
    fn inspect_draft_sync_reports_workspace_shape() {
        let (_cfg, _root, workspace) = make_workspace();
        workspace.create_draft_dir("untitled-1").unwrap();
        let id = workspace.draft_id("untitled-1").unwrap();
        workspace
            .draft_files()
            .unwrap()
            .create_text_new("untitled-1/draft.md", &id, "# draft\n")
            .unwrap();
        workspace
            .draft_files()
            .unwrap()
            .create_bytes("untitled-1/pasted.png", &id, &[1, 2, 3])
            .unwrap();

        let source = FileIdentity::draft("untitled-1/draft.md".into(), id.clone());
        let out = inspect_draft_sync(&workspace, &source).unwrap();

        assert_eq!(out.base.name, "untitled-1");
        assert_eq!(out.base.path, "untitled-1/draft.md");
        assert_eq!(out.primary.draft_id.as_deref(), Some(id.as_str()));
        assert_eq!(out.base.file_count, 2);
        assert!(out.base.has_attachments);
    }

    #[test]
    fn promote_draft_sync_returns_target_path_and_mode() {
        let (_cfg, root, workspace) = make_workspace();
        std::fs::create_dir_all(root.path().join("notes")).unwrap();
        workspace.create_draft_dir("untitled-1").unwrap();
        let id = workspace.draft_id("untitled-1").unwrap();
        workspace
            .draft_files()
            .unwrap()
            .create_text_new("untitled-1/draft.md", &id, "# draft\n")
            .unwrap();

        let source = FileIdentity::draft("untitled-1/draft.md".into(), id);
        let out = promote_draft_sync(&workspace, &source, "notes/draft.md").unwrap();

        assert_eq!(out.base.name, "untitled-1");
        assert_eq!(out.base.path, "notes/draft.md");
        assert_eq!(out.base.mode, "file");
        assert_eq!(out.primary.path, "notes/draft.md");
        assert_eq!(
            std::fs::read_to_string(root.path().join("notes/draft.md")).unwrap(),
            "# draft\n"
        );
    }

    #[test]
    fn discard_draft_sync_removes_workspace() {
        let (_cfg, _root, workspace) = make_workspace();
        workspace.create_draft_dir("untitled-1").unwrap();
        let id = workspace.draft_id("untitled-1").unwrap();
        workspace
            .draft_files()
            .unwrap()
            .create_text_new("untitled-1/draft.md", &id, "# draft\n")
            .unwrap();

        let source = FileIdentity::draft("untitled-1/draft.md".into(), id);
        discard_draft_sync(&workspace, &source).unwrap();

        assert!(!workspace.drafts_dir().join("untitled-1").exists());
    }

    #[test]
    fn healthy_draft_discard_requires_its_current_id() {
        let (_cfg, _root, workspace) = make_workspace();
        workspace.create_draft_dir("untitled").unwrap();
        let current_id = workspace.draft_id("untitled").unwrap();
        let mut source = FileIdentity::draft("untitled/draft.md".into(), current_id.clone());
        source.draft_id = None;
        assert!(matches!(
            discard_draft_sync(&workspace, &source),
            Err(chan_workspace::ChanError::StaleDraft { .. })
        ));
        source.draft_id = Some("v1:wrong".into());
        assert!(matches!(
            discard_draft_sync(&workspace, &source),
            Err(chan_workspace::ChanError::StaleDraft { .. })
        ));
        assert_eq!(workspace.draft_id("untitled").unwrap(), current_id);
    }

    #[test]
    fn draft_autosave_loop_keeps_sidecar_cas_and_user_file_separate() {
        let (_cfg, _root, workspace) = make_workspace();
        workspace.create_dir("untitled").unwrap();
        workspace
            .write_text("untitled/draft.md", "# user file\n")
            .unwrap();
        let name = create_draft_sync(&workspace, NEW_DRAFT_CONTENT).unwrap();
        let path = format!("{name}/draft.md");
        let id = workspace.draft_id(&name).unwrap();
        let files = workspace.draft_files().unwrap();
        let mut token_ns = files.stat(&path, &id).unwrap().mtime_ns;
        for i in 0..200 {
            let body = format!("# Draft\n\nautosave {i}\n");
            files
                .write_text_if_unchanged(&path, &id, token_ns, None, &body)
                .unwrap_or_else(|error| panic!("autosave {i} failed: {error:?}"));
            token_ns = files.stat(&path, &id).unwrap().mtime_ns;
            assert_eq!(files.read_text_with_stat(&path, &id).unwrap().0, body);
            assert_eq!(workspace.inspect_draft(&name).unwrap().file_count, 1);
        }
        assert_eq!(
            workspace.read_text("untitled/draft.md").unwrap(),
            "# user file\n"
        );
        assert!(matches!(
            files.write_text_if_unchanged(&path, &id, Some(1), None, "# stale\n"),
            Err(chan_workspace::ChanError::WriteConflict { .. })
        ));
    }

    // ---- Route-level create-draft tests --------------------------------
    //
    // These go through the real router (auth middleware + body extraction),
    // pinning the `POST /api/drafts/new` contract: no body seeds the plain
    // markdown draft, `{"kind":"slides"}` seeds the deck, an unknown kind
    // is a 400. Mirrors the route_test_app harness in routes/index.rs.

    use std::sync::Mutex;

    use axum::body::Body;
    use axum::http::{header, Request};
    use tower::ServiceExt;

    use crate::state::test_support::workspace_app_state;

    struct RouteTestApp {
        _cfg: TempDir,
        _root: TempDir,
        state: Arc<AppState>,
    }

    fn route_test_app() -> RouteTestApp {
        let cfg = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();

        let state = Arc::new(AppState {
            token: Some("secret".to_string()),
            ..workspace_app_state(lib, root.path().to_path_buf(), workspace)
        });

        RouteTestApp {
            _cfg: cfg,
            _root: root,
            state,
        }
    }

    /// POST /api/drafts/new with an optional JSON body, the way the SPA
    /// does: no body means no content-type header either.
    async fn post_create_draft(
        router: &axum::Router,
        body: Option<&str>,
    ) -> (StatusCode, serde_json::Value) {
        let mut req = Request::builder()
            .method("POST")
            .uri("/api/drafts/new")
            .header(header::AUTHORIZATION, "Bearer secret");
        let body = if let Some(b) = body {
            req = req.header(header::CONTENT_TYPE, "application/json");
            Body::from(b.to_string())
        } else {
            Body::empty()
        };
        let response = router
            .clone()
            .oneshot(req.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    async fn post_window_mutation(
        router: &axum::Router,
        uri: &str,
        body: Option<&str>,
    ) -> (StatusCode, serde_json::Value) {
        let mut request = Request::builder()
            .method("POST")
            .uri(uri)
            .header(header::AUTHORIZATION, "Bearer secret");
        let body = if let Some(body) = body {
            request = request.header(header::CONTENT_TYPE, "application/json");
            Body::from(body.to_string())
        } else {
            Body::empty()
        };
        let response = router
            .clone()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, value)
    }

    async fn get_draft_list(router: &axum::Router) -> (StatusCode, serde_json::Value) {
        let response = router
            .clone()
            .oneshot(
                Request::get("/api/drafts")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 8192)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or_default())
    }

    #[tokio::test]
    async fn draft_list_has_healthy_rows_and_broken_warning_sources() {
        let app = route_test_app();
        let router = crate::router(app.state.clone());
        let (status, healthy) = post_create_draft(&router, None).await;
        assert_eq!(status, StatusCode::OK);
        let workspace = app.state.try_workspace().unwrap();
        let id = healthy["primary"]["draft_id"].as_str().unwrap();
        workspace
            .draft_files()
            .unwrap()
            .create_bytes("untitled/image.png", id, &[1, 2, 3])
            .unwrap();
        workspace.create_draft_dir("broken").unwrap();
        std::fs::remove_file(workspace.drafts_dir().join("broken/.chan-draft-id")).unwrap();

        let (status, list) = get_draft_list(&router).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(list["drafts"].as_array().unwrap().len(), 1);
        assert_eq!(list["drafts"][0]["name"], "untitled");
        assert_eq!(list["drafts"][0]["primary"], healthy["primary"]);
        assert_eq!(list["drafts"][0]["has_attachments"], true);
        assert_eq!(list["warnings"].as_array().unwrap().len(), 1);
        assert_eq!(list["warnings"][0]["kind"], "broken_draft");
        assert_eq!(list["warnings"][0]["source"]["root"], "draft");
        assert_eq!(list["warnings"][0]["source"]["path"], "broken");
        assert!(list["warnings"][0]["source"].get("draft_id").is_none());
    }

    #[tokio::test]
    async fn draft_list_keeps_the_other_row_while_one_lifecycle_is_closing() {
        let app = route_test_app();
        let router = crate::router(app.state.clone());
        let (status, first) = post_create_draft(&router, None).await;
        assert_eq!(status, StatusCode::OK);
        let (status, second) = post_create_draft(&router, None).await;
        assert_eq!(status, StatusCode::OK);
        let workspace = app.state.try_workspace().unwrap();
        let id = first["primary"]["draft_id"].as_str().unwrap().to_owned();
        let held = workspace.pin_draft("untitled", &id).unwrap();
        let closing = workspace.clone();
        let closing_id = id.clone();
        let worker = std::thread::spawn(move || {
            let lifecycle = closing
                .begin_draft_lifecycle("untitled", &closing_id)
                .unwrap();
            drop(lifecycle);
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            if matches!(
                workspace.pin_draft("untitled", &id),
                Err(chan_workspace::ChanError::StaleDraft { .. })
            ) {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "lifecycle did not close admission"
            );
            std::thread::yield_now();
        }
        let listed =
            tokio::time::timeout(std::time::Duration::from_secs(3), get_draft_list(&router)).await;
        drop(held);
        worker.join().unwrap();
        let (status, list) = listed.expect("draft list must answer while a row is closing");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(list["drafts"].as_array().unwrap().len(), 1);
        assert_eq!(list["drafts"][0]["name"], second["name"]);
        assert!(list["warnings"].as_array().unwrap().iter().any(|warning| {
            warning["kind"] == "draft_busy"
                && warning["path"].as_str().unwrap().ends_with("/untitled")
        }));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn draft_list_reports_a_refused_store() {
        let cfg = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let first = lib.open_workspace(root.path()).unwrap();
        let sidecar = first.drafts_dir().to_path_buf();
        drop(first);
        std::fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(root.path(), &sidecar).unwrap();
        let workspace = lib.open_workspace(root.path()).unwrap();
        let state = Arc::new(AppState {
            token: Some("secret".to_string()),
            ..workspace_app_state(lib, root.path().to_path_buf(), workspace)
        });

        let (status, list) = get_draft_list(&crate::router(state)).await;
        assert_eq!(status, StatusCode::OK);
        assert!(list["drafts"].as_array().unwrap().is_empty());
        assert_eq!(list["warnings"][0]["kind"], "draft_preflight_failed");
        assert_eq!(
            list["warnings"][0]["path"],
            sidecar.to_string_lossy().as_ref()
        );
        assert!(list["warnings"][0]["source"].is_null());
    }

    #[tokio::test]
    async fn draft_terminal_paths_validate_each_tagged_file() {
        let app = route_test_app();
        let router = crate::router(app.state.clone());
        let (status, draft) = post_create_draft(&router, None).await;
        assert_eq!(status, StatusCode::OK);
        let workspace = app.state.try_workspace().unwrap();
        let id = draft["primary"]["draft_id"].as_str().unwrap();
        workspace
            .draft_files()
            .unwrap()
            .create_bytes("untitled/image.png", id, &[1, 2, 3])
            .unwrap();
        let image = serde_json::json!({"root":"draft","path":"untitled/image.png","draft_id":id});
        let request = serde_json::json!({"sources":[draft["primary"], image]}).to_string();
        let (status, paths) =
            post_window_mutation(&router, "/api/drafts/terminal-paths", Some(&request)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(paths["paths"].as_array().unwrap().len(), 2);
        assert_eq!(paths["paths"][0]["source"], draft["primary"]);
        assert_eq!(
            paths["paths"][0]["absolute_path"],
            workspace
                .drafts_dir()
                .join("untitled/draft.md")
                .to_string_lossy()
                .as_ref()
        );
        assert_eq!(paths["paths"][1]["source"], image);
        assert_eq!(
            paths["paths"][1]["absolute_path"],
            workspace
                .drafts_dir()
                .join("untitled/image.png")
                .to_string_lossy()
                .as_ref()
        );

        let invalid = [
            (
                serde_json::json!({"root":"workspace","path":"untitled/image.png","draft_id":id}),
                StatusCode::BAD_REQUEST,
                None,
            ),
            (
                serde_json::json!({"root":"draft","path":"untitled/image.png","draft_id":"old"}),
                StatusCode::CONFLICT,
                Some("draft_stale"),
            ),
            (
                serde_json::json!({"root":"draft","path":"../outside.png","draft_id":id}),
                StatusCode::BAD_REQUEST,
                None,
            ),
        ];
        for (source, expected_status, expected_code) in invalid {
            let request = serde_json::json!({"sources":[source]}).to_string();
            let (status, body) =
                post_window_mutation(&router, "/api/drafts/terminal-paths", Some(&request)).await;
            assert_eq!(status, expected_status);
            if let Some(code) = expected_code {
                assert_eq!(body["code"], code);
            }
        }
    }

    #[tokio::test]
    async fn draft_mutations_send_tagged_events_with_origin() {
        use crate::self_writes::SelfWriteOrigin;
        async fn next_draft_event(
            events: &mut tokio::sync::broadcast::Receiver<String>,
        ) -> serde_json::Value {
            loop {
                let frame = tokio::time::timeout(std::time::Duration::from_secs(5), events.recv())
                    .await
                    .expect("draft event timed out")
                    .expect("draft event channel closed");
                let value: serde_json::Value = serde_json::from_str(&frame).unwrap();
                if value["type"] == "draft" {
                    return value;
                }
            }
        }
        let app = route_test_app();
        let router = crate::router(app.state.clone());
        let mut events = app.state.events_tx.subscribe();

        let (status, draft) = post_window_mutation(&router, "/api/drafts/new?w=w-1", None).await;
        assert_eq!(status, StatusCode::OK);
        let created = next_draft_event(&mut events).await;
        assert_eq!(created["event"], "created");
        assert_eq!(created["source"], draft["primary"]);
        assert_eq!(created["source_w"], "w-1");
        assert_eq!(
            app.state.self_writes.origin("untitled/draft.md"),
            SelfWriteOrigin::Unnoted
        );

        let discard = serde_json::json!({"source": draft["primary"]}).to_string();
        let (status, _) =
            post_window_mutation(&router, "/api/drafts/discard?w=w-1", Some(&discard)).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let discarded = next_draft_event(&mut events).await;
        assert_eq!(discarded["event"], "discarded");
        assert_eq!(discarded["source"], draft["primary"]);

        let (status, diagram) =
            post_window_mutation(&router, "/api/diagrams/new?w=w-1", None).await;
        assert_eq!(status, StatusCode::OK);
        let diagram_created = next_draft_event(&mut events).await;
        assert_eq!(diagram_created["source"], diagram["primary"]);
        app.state
            .try_workspace()
            .unwrap()
            .create_dir("boards")
            .unwrap();
        let promote =
            serde_json::json!({"source": diagram["primary"], "target": "boards/sketch.excalidraw"})
                .to_string();
        let (status, promoted) =
            post_window_mutation(&router, "/api/drafts/promote?w=w-1", Some(&promote)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(promoted["primary"]["path"], "boards/sketch.excalidraw");
        let event = next_draft_event(&mut events).await;
        assert_eq!(event["event"], "promoted");
        assert_eq!(event["source"], diagram["primary"]);
        assert_eq!(event["destination"], promoted["primary"]);
    }

    #[tokio::test]
    async fn create_draft_route_with_slides_kind_seeds_the_slides_deck() {
        let app = route_test_app();
        let router = crate::router(app.state.clone());

        let (status, body) = post_create_draft(&router, Some(r#"{"kind":"slides"}"#)).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["name"], "untitled");
        assert_eq!(body["path"], "untitled/draft.md");
        let id = body["primary"]["draft_id"].as_str().unwrap();
        // Seeded with EXACTLY the slides content (frontmatter + heading).
        assert_eq!(
            app.state
                .try_workspace()
                .expect("slides draft test workspace")
                .draft_files()
                .unwrap()
                .read_text_with_stat("untitled/draft.md", id)
                .unwrap()
                .0,
            NEW_SLIDES_CONTENT
        );
    }

    #[tokio::test]
    async fn missing_kind_file_read_route_is_404() {
        let app = route_test_app();
        let response = crate::router(app.state.clone())
            .oneshot(
                Request::builder()
                    .uri("/api/fs/missing.md")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn missing_draft_inspect_is_a_stale_lifetime() {
        let app = route_test_app();
        let response = crate::router(app.state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/drafts/inspect")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"source":{"root":"draft","path":"missing/draft.md","draft_id":"old"}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 8192)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["code"], "draft_stale");
        assert_eq!(status, StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn broken_draft_can_be_discarded_without_its_marker() {
        let app = route_test_app();
        let router = crate::router(app.state.clone());
        let (status, draft) = post_create_draft(&router, None).await;
        assert_eq!(status, StatusCode::OK);
        let workspace = app.state.try_workspace().unwrap();
        std::fs::remove_file(workspace.drafts_dir().join("untitled/.chan-draft-id")).unwrap();
        let source = draft["primary"].clone();

        let inspect = serde_json::json!({"source": source}).to_string();
        let (status, _) =
            post_window_mutation(&router, "/api/drafts/inspect", Some(&inspect)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let response = router
            .clone()
            .oneshot(
                Request::get("/api/workspace")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 8192)
            .await
            .unwrap();
        let info: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(info["warnings"][0]["kind"], "broken_draft");
        let source = info["warnings"][0]["source"].clone();
        assert_eq!(source["path"], "untitled");
        assert!(source.get("draft_id").is_none());
        let discard = serde_json::json!({"source": source}).to_string();
        let (status, _) =
            post_window_mutation(&router, "/api/drafts/discard", Some(&discard)).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert!(!workspace.drafts_dir().join("untitled").exists());
        assert_eq!(
            std::fs::read_dir(&workspace.paths().drafts_trash)
                .unwrap()
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn a_broken_draft_without_a_primary_can_discard_with_its_warning_identity() {
        let app = route_test_app();
        let router = crate::router(app.state.clone());
        let (status, draft) = post_create_draft(&router, None).await;
        assert_eq!(status, StatusCode::OK);
        let workspace = app.state.try_workspace().unwrap();
        std::fs::remove_file(workspace.drafts_dir().join("untitled/draft.md")).unwrap();

        let response = router
            .clone()
            .oneshot(
                Request::get("/api/workspace")
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 8192)
            .await
            .unwrap();
        let info: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(info["warnings"][0]["kind"], "broken_draft");
        let source = info["warnings"][0]["source"].clone();
        assert_eq!(source["path"], "untitled");
        assert_eq!(source["draft_id"], draft["primary"]["draft_id"]);
        let discard = serde_json::json!({"source": source}).to_string();
        let (status, _) =
            post_window_mutation(&router, "/api/drafts/discard", Some(&discard)).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert!(!workspace.drafts_dir().join("untitled").exists());
        assert_eq!(
            std::fs::read_dir(&workspace.paths().drafts_trash)
                .unwrap()
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn create_draft_route_without_body_seeds_the_markdown_draft() {
        // The plain Cmd+N path sends no body and no content-type; it keeps
        // seeding the markdown draft.
        let app = route_test_app();
        let router = crate::router(app.state.clone());

        let (status, body) = post_create_draft(&router, None).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["name"], "untitled");
        let id = body["primary"]["draft_id"].as_str().unwrap();
        assert_eq!(
            app.state
                .try_workspace()
                .expect("markdown draft test workspace")
                .draft_files()
                .unwrap()
                .read_text_with_stat("untitled/draft.md", id)
                .unwrap()
                .0,
            NEW_DRAFT_CONTENT
        );
    }

    #[tokio::test]
    async fn create_draft_route_refuses_an_unknown_kind() {
        let app = route_test_app();
        let router = crate::router(app.state.clone());

        let (status, body) = post_create_draft(&router, Some(r#"{"kind":"sculpture"}"#)).await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body["error"]
                .as_str()
                .unwrap_or_default()
                .contains("sculpture"),
            "unexpected error body: {body}"
        );
        // Nothing was created for the refused request.
        assert!(!app
            .state
            .try_workspace()
            .expect("draft test workspace")
            .drafts_dir()
            .join("untitled")
            .exists());
    }
}
