//! `GET /api/preflight` + `POST /api/preflight/decision`: first-boot
//! workspace readiness, rendered by the SPA on a locked OverlayShell.
//! chan-server owns the readiness flow so local and remote (tunnel)
//! workspaces get the identical experience; the desktop shell only picks
//! a path and launches `chan open`.
//!
//! The snapshot is DERIVED from live state on every poll, so there is no
//! first-boot flag to persist or reset:
//!
//!   - `index` step: the background indexer's `IndexStatus` plus the
//!     workspace's authoritative `WorkspaceReadiness`. Progress-only
//!     indexing on a ready generation stays non-blocking, but pending or
//!     active recovery reports `running` and locks the overlay until its
//!     required generation converges. A genuine index error reports
//!     `failed`.
//!   - `model` step (embeddings builds only): when the workspace has
//!     semantic search enabled but the embedding model is not on disk,
//!     the user must choose -- download it or fall back to keyword
//!     search. Derived from the workspace's semantic config, so a "skip"
//!     decision sticks via the existing `semantic_enabled` flag rather
//!     than needing new state.
//!
//! `locked` is simply `phase != ready`; the OverlayShell hides its close
//! button + ignores ESC while it is true and dismisses on `ready`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chan_workspace::WorkspaceReadiness;
use serde::{Deserialize, Serialize};

use super::cs_link::{self, CsLink};
use crate::error::{err, err_state};
use crate::indexer::IndexStatus;
use crate::state::AppState;

#[derive(Debug, Serialize)]
struct PreflightSnapshot {
    phase: Phase,
    /// True until `phase == ready`. The single signal the OverlayShell
    /// keys its lock on.
    locked: bool,
    readiness: WorkspaceReadiness,
    steps: Vec<PreflightStep>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<PreflightError>,
    /// The `cs` terminal-alias offer, present only when `cs` is missing
    /// from `$PATH`. NON-BLOCKING: it never feeds `phase` / `locked`, so a
    /// missing alias never holds the boot overlay; the SPA renders it as a
    /// dismissible card once the workspace is ready. `build_snapshot`
    /// leaves it `None`; the route handlers attach it behind the owner
    /// gate.
    #[serde(skip_serializing_if = "Option::is_none")]
    cs_link: Option<CsLink>,
    /// The per-library `cs_dismissed` editor pref, surfaced ON the snapshot
    /// (not only `/api/config` preferences) because the cs offer card renders
    /// DURING preflight polling -- before `workspace.info.preferences` exists, so
    /// the SPA cannot gate the card from the prefs summary at that point. Always
    /// present so the card can be gated at preflight time; the WRITE stays
    /// `PATCH /api/config`. `build_snapshot` defaults it false; the route
    /// handlers set it from the editor prefs alongside `cs_link`.
    cs_dismissed: bool,
    /// Post-open workspace facts for the SPA onboarding surface. Cleanly
    /// SEPARATED from the lock gate: it carries
    /// no readiness signal and never feeds `phase` / `locked`. `build_snapshot`
    /// leaves it `None`; the route handlers attach it only once the workspace
    /// is `Ready`, which is exactly when the onboarding card consumes it.
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<Summary>,
}

/// Workspace facts the onboarding card renders to confirm "this is the folder
/// I meant" and to offer the optional layers. Derived entirely from data that
/// is already free post-open (the index stats, the workspace's own config
/// flags, and a read-only VCS-marker probe at the sandboxed root), so it adds
/// no walk and no new server plumbing.
#[derive(Debug, Clone, Serialize)]
struct Summary {
    /// BM25-indexed chunk count from `index_stats`. A coarse "there is content
    /// here" signal for the confirmation, not a file count.
    indexed_docs: u64,
    /// Detected source-control kind at the workspace root ("git" / "hg" /
    /// "svn"), or `None`. Helps the user confirm the folder is what they meant.
    #[serde(skip_serializing_if = "Option::is_none")]
    scm: Option<String>,
    /// Current optional-layer state, so the card renders the enable prompts
    /// against the truth rather than assuming both are off.
    semantic_enabled: bool,
    reports_enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Running,
    NeedsDecision,
    Ready,
    Failed,
}

#[derive(Debug, Serialize)]
struct PreflightStep {
    id: &'static str,
    label: &'static str,
    state: StepState,
    #[serde(skip_serializing_if = "Option::is_none")]
    decision: Option<Decision>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum StepState {
    Pending,
    Done,
    NeedsDecision,
    Failed,
}

#[derive(Debug, Serialize)]
struct Decision {
    prompt: &'static str,
    choices: Vec<DecisionChoice>,
}

#[derive(Debug, Serialize)]
struct DecisionChoice {
    id: &'static str,
    label: &'static str,
}

#[derive(Debug, Serialize)]
struct PreflightError {
    step: &'static str,
    message: String,
}

/// Map the indexer's status onto the `index` readiness step.
///
/// Recovery readiness dominates healthy progress states: pending or active
/// derived-state recovery maps to `Pending`, while a ready generation keeps
/// ordinary build/reindex progress non-blocking. A genuine index error maps
/// to `Failed` so the shell can surface it.
fn index_step(status: &IndexStatus, readiness: WorkspaceReadiness) -> PreflightStep {
    let base = PreflightStep {
        id: "index",
        label: "Build search index",
        state: StepState::Pending,
        decision: None,
    };
    match status {
        IndexStatus::Error { .. } => PreflightStep {
            state: StepState::Failed,
            ..base
        },
        _ if !readiness.is_ready() => base,
        IndexStatus::Building { .. }
        | IndexStatus::Reindexing { .. }
        | IndexStatus::Idle { .. } => PreflightStep {
            state: StepState::Done,
            ..base
        },
    }
}

fn index_error(status: &IndexStatus) -> Option<PreflightError> {
    match status {
        IndexStatus::Error { message } => Some(PreflightError {
            step: "index",
            message: message.clone(),
        }),
        _ => None,
    }
}

/// The `model` step, embeddings builds only. Present only when the
/// workspace has semantic search enabled: a BM25 workspace has nothing
/// to decide. When enabled + the model is on disk the step is `done`;
/// when enabled + the model is missing it is `needs_decision`
/// (download the model vs. fall back to keyword search). A plain BM25
/// workspace returns `None` (no step).
#[cfg(feature = "embeddings")]
fn model_step(workspace: &chan_workspace::Workspace) -> Option<PreflightStep> {
    if !workspace.semantic_enabled().unwrap_or(false) {
        return None;
    }
    let model = workspace.semantic_model().unwrap_or_default();
    let present = chan_workspace::index::embeddings::resolve_model(&model).is_ok();
    let base = PreflightStep {
        id: "model",
        label: "Embedding model",
        state: StepState::Pending,
        decision: None,
    };
    Some(if present {
        PreflightStep {
            state: StepState::Done,
            ..base
        }
    } else {
        PreflightStep {
            state: StepState::NeedsDecision,
            decision: Some(Decision {
                prompt: "Download the embedding model for semantic search, or use keyword search?",
                choices: vec![
                    DecisionChoice {
                        id: "download",
                        label: "Download model",
                    },
                    DecisionChoice {
                        id: "skip",
                        label: "Use keyword search",
                    },
                ],
            }),
            ..base
        }
    })
}

#[cfg(not(feature = "embeddings"))]
fn model_step(_workspace: &chan_workspace::Workspace) -> Option<PreflightStep> {
    None
}

fn build_snapshot(
    workspace: &chan_workspace::Workspace,
    status: &IndexStatus,
) -> PreflightSnapshot {
    let readiness = workspace.readiness();
    let mut steps = vec![index_step(status, readiness)];
    if let Some(step) = model_step(workspace) {
        steps.push(step);
    }

    // Phase precedence: a failure dominates, then a pending decision,
    // then "all done" is ready, otherwise still running.
    let phase = if steps.iter().any(|s| s.state == StepState::Failed) {
        Phase::Failed
    } else if !readiness.is_ready() {
        Phase::Running
    } else if steps.iter().any(|s| s.state == StepState::NeedsDecision) {
        Phase::NeedsDecision
    } else if steps.iter().all(|s| s.state == StepState::Done) {
        Phase::Ready
    } else {
        Phase::Running
    };

    PreflightSnapshot {
        phase,
        locked: phase != Phase::Ready,
        readiness,
        error: index_error(status),
        steps,
        // Attached by the route handlers; neither gates the boot overlay.
        cs_link: None,
        cs_dismissed: false,
        summary: None,
    }
}

/// The `cs` offer is owner-only: a settings-locked (kiosk) deployment must
/// not let the operator at the keyboard mutate the host's PATH. The default
/// leaves `settings_disabled` false, so the offer shows on a plain `chan open`.
fn cs_link_allowed(state: &AppState) -> bool {
    !state.settings_disabled
}

/// The per-library `cs_dismissed` editor pref for the preflight snapshot.
/// Degrades to `false` (offer shows) on a poisoned lock -- a settings read must
/// never block or fail the boot snapshot.
fn cs_dismissed_pref(state: &AppState) -> bool {
    state
        .editor_prefs
        .lock()
        .map(|prefs| prefs.cs_dismissed)
        .unwrap_or(false)
}

/// Source-control kind at the workspace root, mirroring chan's own walk: a
/// read-only existence probe on the well-known VCS marker dir, no climb above
/// the root. This is a metadata check at the sandboxed root, not a content
/// read or write, so it stays clear of the workspace write boundary.
fn detect_scm(root: &std::path::Path) -> Option<String> {
    for (kind, dir) in [("git", ".git"), ("hg", ".hg"), ("svn", ".svn")] {
        if root.join(dir).exists() {
            return Some(kind.to_string());
        }
    }
    None
}

/// Assemble the onboarding `summary` from data that is already free post-open.
/// Every read degrades to a benign default on error so a transient stats /
/// config read never turns an otherwise-ready snapshot into a failure.
fn workspace_summary(workspace: &chan_workspace::Workspace) -> Summary {
    let indexed_docs = workspace.index_stats().map(|s| s.indexed_docs).unwrap_or(0);
    Summary {
        indexed_docs,
        scm: detect_scm(workspace.root()),
        semantic_enabled: workspace.semantic_enabled().unwrap_or(false),
        reports_enabled: workspace.reports_enabled().unwrap_or(false),
    }
}

pub async fn api_preflight(State(state): State<Arc<AppState>>) -> Response {
    let workspace = match state.try_workspace() {
        Ok(w) => w,
        Err(e) => return err_state(&e),
    };
    let indexer = match state.try_indexer() {
        Ok(i) => i,
        Err(e) => return err_state(&e),
    };
    let allow_cs = cs_link_allowed(&state);
    let cs_dismissed = cs_dismissed_pref(&state);
    // Semantic reads hit sqlite + the model resolver touches the
    // filesystem, and the cs detection scans $PATH; do the whole
    // derivation on the blocking pool.
    match tokio::task::spawn_blocking(move || {
        let status = indexer.snapshot();
        let mut snapshot = build_snapshot(&workspace, &status);
        snapshot.cs_link = cs_link::detect(allow_cs);
        snapshot.cs_dismissed = cs_dismissed;
        // The onboarding summary describes an OPEN workspace, so attach it only
        // once ready (also keeps the per-poll work off the cold-build path).
        if snapshot.phase == Phase::Ready {
            snapshot.summary = Some(workspace_summary(&workspace));
        }
        snapshot
    })
    .await
    {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(e) => err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("preflight task panicked: {e}"),
        ),
    }
}

#[derive(Debug, Deserialize)]
pub struct DecisionBody {
    step: String,
    /// Only the embeddings build's `model` step reads this; on a
    /// no-embeddings build there are no decisions, so the field is
    /// deserialized but unused.
    #[cfg_attr(not(feature = "embeddings"), allow(dead_code))]
    choice: String,
}

// `state` is consumed only by the embeddings `model` decision arm; on a
// no-embeddings build there are no decisions, so the binding is unused.
#[cfg_attr(not(feature = "embeddings"), allow(unused_variables))]
pub async fn api_preflight_decision(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DecisionBody>,
) -> Response {
    match body.step.as_str() {
        #[cfg(feature = "embeddings")]
        "model" => model_decision(&state, &body.choice).await,
        other => err(
            StatusCode::BAD_REQUEST,
            format!("no pending pre-flight decision for step {other:?}"),
        ),
    }
}

/// Apply a `model` step decision, then return the fresh snapshot so the
/// shell re-renders without a second poll. `download` fetches the model
/// (and the workspace's semantic flag stays on); `skip` flips the
/// workspace back to keyword-only, which makes the model step drop out
/// of the snapshot entirely.
#[cfg(feature = "embeddings")]
async fn model_decision(state: &Arc<AppState>, choice: &str) -> Response {
    let workspace = match state.try_workspace() {
        Ok(w) => w,
        Err(e) => return err_state(&e),
    };
    let indexer = match state.try_indexer() {
        Ok(i) => i,
        Err(e) => return err_state(&e),
    };
    let choice = choice.to_owned();
    let allow_cs = cs_link_allowed(state);
    let cs_dismissed = cs_dismissed_pref(state);
    // The blocking closure carries its error as `Box<Response>` so the
    // `Result` Err variant stays pointer-sized (an axum `Response` is
    // large; clippy::result_large_err otherwise fires under -D warnings).
    match tokio::task::spawn_blocking(move || -> Result<PreflightSnapshot, Box<Response>> {
        use chan_workspace::index::embeddings::{global_models_dir, Embedder};
        match choice.as_str() {
            "download" => {
                let model = workspace
                    .semantic_model()
                    .map_err(|e| Box::new(crate::error::err_from(&e)))?;
                let cache_dir = global_models_dir();
                if let Err(e) = std::fs::create_dir_all(&cache_dir) {
                    return Err(Box::new(err(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("creating model cache {}: {e}", cache_dir.display()),
                    )));
                }
                if let Err(e) = Embedder::open(&model, &cache_dir).map(|_| ()) {
                    let chan_err: chan_workspace::ChanError =
                        chan_workspace::index::IndexError::Embed(e).into();
                    return Err(Box::new(crate::error::err_from(&chan_err)));
                }
            }
            "skip" => {
                workspace
                    .set_semantic_enabled(false)
                    .map_err(|e| Box::new(crate::error::err_from(&e)))?;
            }
            other => {
                return Err(Box::new(err(
                    StatusCode::BAD_REQUEST,
                    format!("unknown choice {other:?} for pre-flight step \"model\""),
                )));
            }
        }
        let status = indexer.snapshot();
        let mut snapshot = build_snapshot(&workspace, &status);
        snapshot.cs_link = cs_link::detect(allow_cs);
        snapshot.cs_dismissed = cs_dismissed;
        if snapshot.phase == Phase::Ready {
            snapshot.summary = Some(workspace_summary(&workspace));
        }
        Ok(snapshot)
    })
    .await
    {
        Ok(Ok(snapshot)) => Json(snapshot).into_response(),
        Ok(Err(response)) => *response,
        Err(e) => err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("preflight decision task panicked: {e}"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn workspace() -> (TempDir, TempDir, Arc<chan_workspace::Workspace>) {
        let cfg = TempDir::new().unwrap();
        let root = TempDir::new().unwrap();
        let lib = chan_workspace::Library::open_at(cfg.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let ws = lib.open_workspace(root.path()).unwrap();
        (cfg, root, ws)
    }

    fn idle() -> IndexStatus {
        IndexStatus::Idle {
            indexed_docs: 0,
            indexed_vectors: 0,
            model: "m".into(),
            embedding: None,
        }
    }

    #[test]
    fn detect_scm_finds_git_then_none() {
        let dir = TempDir::new().unwrap();
        assert_eq!(detect_scm(dir.path()), None);
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        assert_eq!(detect_scm(dir.path()).as_deref(), Some("git"));
    }

    #[test]
    fn summary_reflects_a_fresh_workspace() {
        let (_c, _r, ws) = workspace();
        let s = workspace_summary(&ws);
        // Fresh workspace defaults: semantic off, reports ON,
        // no VCS in the tempdir root.
        assert!(!s.semantic_enabled);
        assert!(s.reports_enabled);
        assert_eq!(s.scm, None);
    }

    #[test]
    fn build_snapshot_leaves_summary_for_the_handler() {
        // The summary, cs_link, and cs_dismissed are all attached by the route
        // handler (cs_link/cs_dismissed behind the owner path, summary once
        // ready), never by the gate logic. build_snapshot must leave them at
        // their defaults so the phase/locked derivation stays free of them.
        let (_c, _r, ws) = workspace();
        let snap = build_snapshot(&ws, &idle());
        assert!(snap.summary.is_none());
        assert!(snap.cs_link.is_none());
        assert!(!snap.cs_dismissed);
    }

    #[test]
    fn cold_build_does_not_lock_the_boot() {
        // Indexing is non-blocking: a cold initial build (indexed_docs == 0)
        // reports phase Ready / locked:false, so the SPA is usable at once and
        // the build's progress surfaces through the carousel +
        // /api/index/status, not the boot overlay.
        let (_c, _r, ws) = workspace();
        let snap = build_snapshot(
            &ws,
            &IndexStatus::Building {
                current: 3,
                total: 10,
                file: "a.md".into(),
            },
        );
        assert_eq!(snap.phase, Phase::Ready);
        assert!(
            !snap.locked,
            "a cold initial build must not lock the boot overlay"
        );
        let index = snap.steps.iter().find(|s| s.id == "index").unwrap();
        assert_eq!(index.state, StepState::Done);
    }

    #[test]
    fn recovery_is_explicitly_running_and_locks_preflight() {
        let (_c, _r, ws) = workspace();
        ws.request_recovery(chan_workspace::RecoveryAction::Reconcile);

        let snap = build_snapshot(&ws, &idle());

        assert_eq!(snap.phase, Phase::Running);
        assert!(snap.locked);
        assert_eq!(
            serde_json::to_value(snap.readiness).unwrap()["state"],
            "recovering"
        );
        let index = snap.steps.iter().find(|step| step.id == "index").unwrap();
        assert_eq!(index.state, StepState::Pending);
    }

    #[test]
    fn reindexing_never_locks() {
        // An incremental watcher reindex maps to a ready (unlocked) step: all
        // index activity is non-blocking, so this holds by construction.
        assert_eq!(
            index_step(
                &IndexStatus::Reindexing {
                    file: "note-490.md".into(),
                },
                WorkspaceReadiness::default(),
            )
            .state,
            StepState::Done
        );
    }

    #[test]
    fn every_building_state_maps_to_done() {
        // Cold and warm builds are indistinguishable here: `index_step` is
        // doc-count-independent, so a `Building` status never locks the boot
        // regardless of how much is already committed.
        let building = || IndexStatus::Building {
            current: 3,
            total: 10,
            file: "a.md".into(),
        };
        assert_eq!(
            index_step(&building(), WorkspaceReadiness::default()).state,
            StepState::Done
        );
    }

    #[test]
    fn reindexing_keeps_preflight_unlocked() {
        let (_c, _r, ws) = workspace();
        // End-to-end through build_snapshot: a fresh BM25 workspace whose
        // status reads Reindexing must report phase Ready / locked:false.
        let snap = build_snapshot(
            &ws,
            &IndexStatus::Reindexing {
                file: "n.md".into(),
            },
        );
        assert_eq!(snap.phase, Phase::Ready);
        assert!(
            !snap.locked,
            "an incremental reindex must not lock the boot overlay"
        );
        let index = snap.steps.iter().find(|s| s.id == "index").unwrap();
        assert_eq!(index.state, StepState::Done);
    }

    #[test]
    fn idle_bm25_workspace_is_ready_unlocked() {
        let (_c, _r, ws) = workspace();
        // A fresh workspace defaults to BM25 (semantic off), so there is
        // no model step and an idle index means ready at once.
        let snap = build_snapshot(&ws, &idle());
        assert_eq!(snap.phase, Phase::Ready);
        assert!(!snap.locked);
        assert!(
            snap.steps.iter().all(|s| s.id != "model"),
            "a BM25 workspace must not show a model step"
        );
        assert!(snap.error.is_none());
    }

    #[test]
    fn index_error_fails_with_message() {
        let (_c, _r, ws) = workspace();
        let snap = build_snapshot(
            &ws,
            &IndexStatus::Error {
                message: "boom".into(),
            },
        );
        assert_eq!(snap.phase, Phase::Failed);
        assert!(snap.locked);
        let error = snap.error.as_ref().expect("failed phase carries an error");
        assert_eq!(error.step, "index");
        assert_eq!(error.message, "boom");
    }

    #[cfg(feature = "embeddings")]
    #[test]
    fn semantic_enabled_surfaces_a_model_step() {
        let (_c, _r, ws) = workspace();
        // Enable semantic directly: the HTTP enable route guards on
        // model presence, but the raw setter does not, which is exactly
        // the "enabled but model maybe-missing" state the model step
        // exists for.
        ws.set_semantic_enabled(true).unwrap();
        let snap = build_snapshot(&ws, &idle());
        let model = snap
            .steps
            .iter()
            .find(|s| s.id == "model")
            .expect("semantic-enabled workspace must show a model step");
        // The test environment's global model cache decides presence;
        // assert the phase is consistent with whichever state results.
        match model.state {
            StepState::NeedsDecision => {
                assert_eq!(snap.phase, Phase::NeedsDecision);
                assert!(snap.locked);
                assert!(model.decision.is_some(), "a decision step carries choices");
            }
            StepState::Done => {
                assert_eq!(snap.phase, Phase::Ready);
                assert!(!snap.locked);
            }
            other => panic!("unexpected model step state: {other:?}"),
        }
    }

    #[cfg(feature = "embeddings")]
    #[test]
    fn skip_decision_drops_the_model_step() {
        let (_c, _r, ws) = workspace();
        ws.set_semantic_enabled(true).unwrap();
        // The "skip" decision flips semantic back off; the model step
        // then drops out entirely and an idle index is ready.
        ws.set_semantic_enabled(false).unwrap();
        let snap = build_snapshot(&ws, &idle());
        assert!(snap.steps.iter().all(|s| s.id != "model"));
        assert_eq!(snap.phase, Phase::Ready);
    }
}
