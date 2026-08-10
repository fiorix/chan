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
//!     workspace's authoritative `WorkspaceReadiness`. NO index work blocks
//!     the boot -- not a cold build, not an incremental reindex, and not a
//!     recovery pass that is progressing. Reading a file, using a terminal
//!     and editing all need no index; only search does, so a pass in flight
//!     reports `pending` (the SPA renders it as a passive "rebuilding search
//!     index" state) and the user is let into the workspace with an index
//!     that is briefly stale. A genuine index error reports `failed`.
//!     Recovery that has no worker assigned to it never converges, so it
//!     reports as a decision carrying the rebuild that clears it -- that DOES
//!     lock, because a decision is the only thing that clears it.
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
    /// leaves it `None`; the route handlers attach it only once the workspace is
    /// SETTLED (see [`PreflightSnapshot::is_settled`]), which is exactly when
    /// the onboarding card consumes it. Settled, not merely `Ready`: the boot
    /// now unlocks while a pass is still in flight.
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<Summary>,
}

impl PreflightSnapshot {
    /// Boot is done AND the workspace has settled: nothing locked, and no
    /// recovery or index pass still in flight.
    ///
    /// `phase == Ready` alone no longer implies settled -- that is the point of
    /// this route now -- so the onboarding summary keys on this instead. The
    /// summary describes a settled workspace, and `indexed_docs` read during a
    /// full rebuild can be 0 on a workspace that is anything but empty, which
    /// would show an established library the first-run nudge it dismissed long
    /// ago.
    fn is_settled(&self) -> bool {
        self.phase == Phase::Ready && self.readiness.is_ready()
    }
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

/// What the boot overlay does with the snapshot.
///
/// There is deliberately no `Running`. Boot waits on a user decision or a
/// failure and on nothing else: an index pass in flight is reported through
/// `readiness` and the `index` step, never by holding the overlay. Removing
/// the variant is what makes "a progressing pass does not lock the workspace"
/// structural rather than a flag someone can flip back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
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
/// Precedence, highest first. A genuine index error maps to `Failed` so the
/// shell can surface it. A recovery pass with no claimant (`unowned`) maps to
/// `NeedsDecision`: it converges nowhere, so reporting it as recovery in
/// progress spins the overlay forever, and the decision it carries is the only
/// escape the product surface offers. Ordinary pending or active recovery maps
/// to `Pending`, while a ready generation keeps build/reindex progress
/// non-blocking.
///
/// The unowned arm sits ahead of the readiness arm deliberately: a stalled
/// recovery and a running one are both `!is_ready()`, and testing readiness
/// first is exactly what made the two indistinguishable.
///
/// `Pending` here means "in flight", not "the boot is waiting". It no longer
/// feeds the lock at all (see [`build_snapshot`]), so the two cases stay as far
/// apart as they can be: a claimed pass is `Pending` on an UNLOCKED snapshot, a
/// stalled one is `NeedsDecision` on a locked one.
fn index_step(status: &IndexStatus, readiness: WorkspaceReadiness, unowned: bool) -> PreflightStep {
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
        _ if unowned => PreflightStep {
            state: StepState::NeedsDecision,
            decision: Some(Decision {
                prompt: "Workspace recovery is stalled: the pending pass has no worker assigned, \
                         so it will not clear on its own.",
                choices: vec![DecisionChoice {
                    id: "rebuild",
                    label: "Rebuild the search index",
                }],
            }),
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
    let mut steps = vec![index_step(
        status,
        readiness,
        workspace.recovery_is_unowned(),
    )];
    if let Some(step) = model_step(workspace) {
        steps.push(step);
    }

    // Phase precedence: a failure dominates, then a pending decision, and
    // everything else is ready.
    //
    // The two arms that used to sit between them -- `!readiness.is_ready()` and
    // "every step is done" -- are gone on purpose, and that deletion IS this
    // change. A recovery or index pass that is progressing left the workspace
    // unusable behind an overlay that only search needed: reading a file, using
    // a terminal and editing need no index. The pass is still reported (through
    // `readiness`, and through the `index` step's `pending`); it just no longer
    // holds the door.
    //
    // What still locks is what a user has to answer or cannot use: a failed
    // index, a missing embedding model, and a stalled pass with no claimant.
    // That last one is the regression to guard -- it converges nowhere, so the
    // decision it carries is the only escape, and collapsing it back together
    // with a progressing pass is the pre-v0.87.0 behaviour that
    // `gitignore-write-strands-the-workspace-in-recovering` shipped to fix.
    let phase = if steps.iter().any(|s| s.state == StepState::Failed) {
        Phase::Failed
    } else if steps.iter().any(|s| s.state == StepState::NeedsDecision) {
        Phase::NeedsDecision
    } else {
        Phase::Ready
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
    let (semantic_enabled, reports_enabled) = workspace
        .dashboard_snapshot()
        .map(|config| (config.semantic_enabled, config.reports_enabled))
        .unwrap_or((false, false));
    Summary {
        indexed_docs,
        scm: detect_scm(workspace.root()),
        semantic_enabled,
        reports_enabled,
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
        if snapshot.is_settled() {
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
    choice: String,
}

pub async fn api_preflight_decision(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DecisionBody>,
) -> Response {
    match body.step.as_str() {
        "index" => index_decision(&state, &body.choice).await,
        #[cfg(feature = "embeddings")]
        "model" => model_decision(&state, &body.choice).await,
        other => err(
            StatusCode::BAD_REQUEST,
            format!("no pending pre-flight decision for step {other:?}"),
        ),
    }
}

/// Apply an `index` step decision, then return the fresh snapshot so the shell
/// re-renders without a second poll.
///
/// The step offers this only when a recovery pass is parked with no claimant.
/// `rebuild` is the one choice: it raises the parked pass to a full rebuild and
/// hands it to the indexer, which is the request that always finds a claimant.
/// This is the escape that previously existed only as an out-of-band
/// `POST /api/index/rebuild` carrying a token dug out of the devserver config.
async fn index_decision(state: &Arc<AppState>, choice: &str) -> Response {
    if choice != "rebuild" {
        return err(
            StatusCode::BAD_REQUEST,
            format!("unknown choice {choice:?} for pre-flight step \"index\""),
        );
    }
    let workspace = match state.try_workspace() {
        Ok(w) => w,
        Err(e) => return err_state(&e),
    };
    let indexer = match state.try_indexer() {
        Ok(i) => i,
        Err(e) => return err_state(&e),
    };
    indexer.request_rebuild();
    let allow_cs = cs_link_allowed(state);
    let cs_dismissed = cs_dismissed_pref(state);
    match tokio::task::spawn_blocking(move || {
        let status = indexer.snapshot();
        let mut snapshot = build_snapshot(&workspace, &status);
        snapshot.cs_link = cs_link::detect(allow_cs);
        snapshot.cs_dismissed = cs_dismissed;
        if snapshot.is_settled() {
            snapshot.summary = Some(workspace_summary(&workspace));
        }
        snapshot
    })
    .await
    {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(e) => err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("preflight decision task panicked: {e}"),
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
        if snapshot.is_settled() {
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

    /// How many times to re-open a fixture workspace that did not open cleanly.
    ///
    /// Bounded by ATTEMPTS, deliberately, not by a clock. There is no duration
    /// here to tune, none to go stale on a slower host, and nothing that reads
    /// scheduler pressure as a defect. Three independent draws against a path
    /// that is rare even under a saturated 1-CPU rig leaves a residue far below
    /// the rate of any other failure in this suite.
    const SETTLED_OPEN_ATTEMPTS: u32 = 3;

    /// A workspace that opened CLEANLY, which is what every test here assumes
    /// and none of them used to establish.
    ///
    /// `Workspace::open` probes the persisted graph and index, and a probe that
    /// fails does not error: it DEGRADES. The failure logs a warning, yields
    /// `(None, None)`, and lands on the `(None, _) | (_, None) => Inconsistent`
    /// arm, which seeds a `FullRebuild` and spawns the startup recovery worker.
    /// That workspace is then legitimately recovering and legitimately owned,
    /// which is correct behaviour and the exact opposite of the quiescent
    /// fixture these tests need.
    ///
    /// Each open is an INDEPENDENT DRAW against that path, so a test opening two
    /// workspaces takes two chances to lose it. That is why the two tests here
    /// that open twice were the only ones that ever went red under a 1-CPU rig
    /// at `--test-threads=32`, while the fifteen taking one draw never did. They
    /// asserted a precondition they never established.
    ///
    /// Establishing it here rather than asserting readiness at each call site
    /// keeps the contract assertions unweakened: nothing about `is_settled()`,
    /// the phase derivation, or the stall guard changes, and a fixture that
    /// cannot be settled fails as a fixture rather than as a contract.
    ///
    /// Two properties of the retry that are not visible from this file:
    ///
    /// A discarded attempt does not leak its recovery thread. `RecoveryWorker`
    /// implements `Drop` as `stop_and_join()`, so each abandoned workspace joins
    /// its worker before the next attempt begins and three attempts cannot leave
    /// two workers racing. The cost of that is real and bounded: the worst case
    /// is three open-and-join cycles rather than three opens.
    ///
    /// The writer-lock hazard does NOT apply here, and it is worth saying why
    /// because the shape looks like it should. `lock::is_free` warns that a
    /// reopen can lose the lock to an in-flight `Workspace::drop` whose flock
    /// release has not completed. That is the close-then-reopen handoff on ONE
    /// path. Every attempt below opens a FRESH pair of `TempDir`s, so attempt
    /// N+1 takes a different lock file entirely and cannot contend with attempt
    /// N. A lock failure would also surface as an `Err` from `open_workspace`
    /// and panic on its own message, never as another silent degraded draw.
    fn workspace() -> (TempDir, TempDir, Arc<chan_workspace::Workspace>) {
        for _ in 1..SETTLED_OPEN_ATTEMPTS {
            let opened = open_workspace_once();
            if opened.2.readiness().is_ready() {
                return opened;
            }
            // Degraded open. Drop it, including its TempDirs, and draw again.
        }
        let last = open_workspace_once();
        assert!(
            last.2.readiness().is_ready(),
            "fixture workspace did not open cleanly in {SETTLED_OPEN_ATTEMPTS} attempts: the \
             graph/index readiness probe degraded every time, seeding a FullRebuild. This is a \
             FIXTURE failure, not a preflight contract failure."
        );
        last
    }

    fn open_workspace_once() -> (TempDir, TempDir, Arc<chan_workspace::Workspace>) {
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

    /// Stands in for the indexer coordinator: a pass requested with this
    /// installed has a claimant, which is what separates recovery in progress
    /// from a stall.
    struct RecordingDriver;

    impl chan_workspace::RecoveryDriver for RecordingDriver {
        fn wake(&self, _generation: chan_workspace::WorkspaceGeneration) {}
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
    fn recovery_with_a_claimant_does_not_lock_the_workspace() {
        // The item this replaces the old assertion for: a pass that is
        // PROGRESSING is reported, not enforced. The workspace is recovering
        // and the index step says so, but nothing is locked -- reading a file,
        // using a terminal and editing need no index, and only search does.
        let (_c, _r, ws) = workspace();
        ws.set_recovery_driver(Arc::new(RecordingDriver));
        ws.request_recovery(chan_workspace::RecoveryAction::Reconcile);

        let snap = build_snapshot(&ws, &idle());

        assert_eq!(snap.phase, Phase::Ready);
        assert!(
            !snap.locked,
            "a recovery pass with a claimant must not lock the workspace behind its own rebuild"
        );
        assert_eq!(
            serde_json::to_value(snap.readiness).unwrap()["state"],
            "recovering",
            "unlocking must not hide the pass: readiness still reports it"
        );
        let index = snap.steps.iter().find(|step| step.id == "index").unwrap();
        assert_eq!(
            index.state,
            StepState::Pending,
            "the step stays honest about work in flight even though it no longer blocks"
        );
        assert!(
            index.decision.is_none(),
            "recovery that is actually progressing must not ask the user for anything"
        );
        // Deliberately NOT asserting `summary.is_none()` here: `build_snapshot`
        // never attaches a summary at all, so it would pass for a reason that
        // has nothing to do with settledness and read as coverage it is not.
        // `settled_separates_unlocked_from_finished` carries that check.
    }

    #[test]
    fn a_stall_and_a_running_pass_never_collapse_together() {
        // THE regression guard for this item, written as one test on purpose.
        //
        // Both states are `!is_ready()` with an identical index status; the only
        // difference is whether a driver claimed the pass. Before v0.87.0 they
        // rendered identically (both locked, both "running"), which is the
        // defect `gitignore-write-strands-the-workspace-in-recovering` shipped
        // to fix. Unlocking the progressing case here widens that gap rather
        // than narrowing it, and this asserts BOTH axes -- phase and locked --
        // so a future change cannot re-collapse them by matching on one field
        // while the other silently agrees.
        let (_c1, _r1, running) = workspace();
        running.set_recovery_driver(Arc::new(RecordingDriver));
        running.request_recovery(chan_workspace::RecoveryAction::Reconcile);

        let (_c2, _r2, stalled) = workspace();
        stalled.request_recovery(chan_workspace::RecoveryAction::Reconcile);

        let running_snap = build_snapshot(&running, &idle());
        let stalled_snap = build_snapshot(&stalled, &idle());

        // Same readiness tag, same index status: the claimant is the only
        // variable, so anything that differs below differs BECAUSE of it.
        assert_eq!(
            serde_json::to_value(running_snap.readiness).unwrap()["state"],
            serde_json::to_value(stalled_snap.readiness).unwrap()["state"],
        );
        assert!(!running.recovery_is_unowned());
        assert!(stalled.recovery_is_unowned());

        assert_ne!(
            running_snap.phase, stalled_snap.phase,
            "a stalled pass and a running one must not report the same phase"
        );
        assert_ne!(
            running_snap.locked, stalled_snap.locked,
            "a stalled pass and a running one must not lock the same way"
        );
        assert_eq!(running_snap.phase, Phase::Ready);
        assert!(!running_snap.locked);
        assert_eq!(stalled_snap.phase, Phase::NeedsDecision);
        assert!(
            stalled_snap.locked,
            "a pass that converges nowhere still holds the boot: the decision is the only escape"
        );
    }

    #[test]
    fn a_stalled_recovery_is_reported_and_offers_a_way_out() {
        // The defect this step exists for: a pass parked with no claimant is
        // `!is_ready()` exactly like a running one, so the pre-fix ordering
        // rendered it as an overlay that spins forever. It must instead be
        // distinguishable from the running case above -- same readiness, same
        // index status, different step -- and carry the rebuild that clears it.
        let (_c, _r, ws) = workspace();
        ws.request_recovery(chan_workspace::RecoveryAction::Reconcile);
        assert!(
            ws.recovery_is_unowned(),
            "no driver installed, so the pass has nothing to claim it"
        );

        let snap = build_snapshot(&ws, &idle());

        assert_eq!(snap.phase, Phase::NeedsDecision);
        assert_eq!(
            serde_json::to_value(snap.readiness).unwrap()["state"],
            "recovering"
        );
        let index = snap.steps.iter().find(|step| step.id == "index").unwrap();
        assert_eq!(index.state, StepState::NeedsDecision);
        let decision = index
            .decision
            .as_ref()
            .expect("a stalled recovery must offer the escape");
        assert!(
            decision.choices.iter().any(|choice| choice.id == "rebuild"),
            "the escape is a rebuild: {:?}",
            decision.choices
        );
    }

    #[test]
    fn installing_a_claimant_clears_the_stall_report() {
        // The stall report keys on there being no claimant, not on the pass
        // itself, so it must disappear the moment a driver takes ownership
        // while the pass is still pending.
        let (_c, _r, ws) = workspace();
        ws.request_recovery(chan_workspace::RecoveryAction::Reconcile);
        assert_eq!(
            build_snapshot(&ws, &idle()).phase,
            Phase::NeedsDecision,
            "unowned pass must report as a decision before a driver exists"
        );

        ws.set_recovery_driver(Arc::new(RecordingDriver));

        let snap = build_snapshot(&ws, &idle());
        assert_eq!(snap.phase, Phase::Ready);
        assert!(
            !snap.locked,
            "the pass now has an owner, so it is reported rather than enforced"
        );
        let index = snap.steps.iter().find(|step| step.id == "index").unwrap();
        assert_eq!(index.state, StepState::Pending);
        assert!(index.decision.is_none(), "the stall's escape hatch is gone");
    }

    #[test]
    fn settled_separates_unlocked_from_finished() {
        // `phase == Ready` no longer means the workspace stopped working, so
        // the onboarding summary needs its own gate. A claimed pass is unlocked
        // but NOT settled; the same workspace with no pass is both.
        let (_c, _r, ws) = workspace();
        ws.set_recovery_driver(Arc::new(RecordingDriver));
        ws.request_recovery(chan_workspace::RecoveryAction::Reconcile);
        let during = build_snapshot(&ws, &idle());
        assert_eq!(during.phase, Phase::Ready);
        assert!(!during.locked);
        assert!(
            !during.is_settled(),
            "a rebuild in flight is unlocked, not finished: indexed_docs is mid-pass here"
        );

        let (_c2, _r2, quiet) = workspace();
        let after = build_snapshot(&quiet, &idle());
        assert!(after.is_settled());
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
                false,
            )
            .state,
            StepState::Done
        );
    }

    #[test]
    fn an_index_error_outranks_a_stalled_recovery() {
        // Both map to a locked overlay, but a failed index carries the real
        // diagnosis; offering "rebuild the index" over an index that just
        // failed to build would send the user in a circle.
        assert_eq!(
            index_step(
                &IndexStatus::Error {
                    message: "boom".into(),
                },
                WorkspaceReadiness::default(),
                true,
            )
            .state,
            StepState::Failed
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
            index_step(&building(), WorkspaceReadiness::default(), false).state,
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
