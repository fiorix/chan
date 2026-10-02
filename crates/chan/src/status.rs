use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use chan_server::WorkspaceStatus;
use chan_workspace::{KnownWorkspace, Library, RecoveryAction, Workspace, WorkspaceReadiness};
use serde::{Deserialize, Serialize};

use crate::control::control_socket_for_pid;
use crate::devserver::persisted::local_devserver_dial_addr;
use crate::registry::{library, missing_workspace_path, not_a_chan_workspace_hint};

/// The process serving a workspace, behind its writer-lock holder.
/// Produced by `serving_kind`'s `Identify` round-trip; serializes to
/// `standalone` / `desktop` / `devserver` for `chan ps --json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ServedBy {
    /// A dedicated `chan serve` bound to this one workspace.
    Standalone,
    /// chan-desktop's embedded server.
    Desktop,
    /// A multi-workspace `chan devserver`.
    Devserver,
}

impl ServedBy {
    fn label(self) -> &'static str {
        match self {
            ServedBy::Standalone => "standalone",
            ServedBy::Desktop => "desktop",
            ServedBy::Devserver => "devserver",
        }
    }
}

/// One `chan ps` row: a registered workspace and its serving state.
#[derive(Serialize)]
struct PsRow {
    path: String,
    served: bool,
    /// `None` when free, or served but the kind is not yet resolved.
    served_by: Option<ServedBy>,
    pid: Option<u32>,
    /// RFC3339 lock-acquisition time of the holder.
    since: Option<String>,
    /// What the workspace is DOING, for a workspace served by a devserver
    /// this credential can reach. `null` everywhere else -- a standalone or
    /// desktop serve persists no address/token pair `chan ps` may read, and
    /// inventing one would create a new credential authority. Rendered as
    /// `-`, never as `0`.
    activity: Option<PsActivity>,
}

/// The answer to "what is this workspace doing", assembled from the two
/// surfaces that already compute it: `GET {prefix}/api/index/status` for
/// readiness and `GET {prefix}/api/health` for indexer telemetry.
///
/// `readiness` is the server's OWN [`WorkspaceReadiness`], not a copy of its
/// shape, so `chan ps` cannot drift into reporting a different truth than the
/// endpoint it read: a variant or field the server changes stops compiling
/// here rather than silently rendering something stale.
#[derive(Serialize)]
struct PsActivity {
    /// The holder's own live mount state for this root, straight off its
    /// workspace listing. `unavailable` is the one that changes what an
    /// operator does: the tenant is mounted over a directory it cannot use,
    /// and `mount_error` says why.
    mount: WorkspaceStatus,
    /// The reason behind `mount`, when the holder reports one.
    #[serde(skip_serializing_if = "Option::is_none")]
    mount_error: Option<String>,
    /// `None` when the status call did not answer.
    readiness: Option<WorkspaceReadiness>,
    /// `None` when the tenant carries no indexer AT ALL -- `/api/health`
    /// reports `indexer: null` on the workspace-less terminal tenant and
    /// during the storage-reset swap window, and that absence is a fact worth
    /// showing rather than flattening. Renders `-`: an unreported value is not
    /// a zero, the same rule `cs terminal list` follows.
    indexer: Option<PsIndexer>,
}

/// Indexer telemetry as `chan ps` reads it off `/api/health`.
///
/// Deliberately a client-side mirror of the server's `IndexerHealth` rather
/// than that type itself: chan-server declares `mod indexer` privately, so the
/// type is unreachable from this crate. Every field is optional so a payload
/// that stops carrying one renders `-` instead of failing the whole row.
#[derive(Serialize, Deserialize)]
struct PsIndexer {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    queue_depth: Option<u64>,
    #[serde(default)]
    last_event_at: Option<i64>,
    #[serde(default)]
    last_settled_at: Option<i64>,
}

/// `GET {prefix}/api/index/status`: `IndexStatus` flattened, plus readiness.
/// Only readiness is read here; the flattened index state is already
/// represented by the indexer's own status on `/api/health`.
#[derive(Deserialize)]
struct PsIndexStatus {
    #[serde(default)]
    readiness: Option<WorkspaceReadiness>,
}

/// `GET {prefix}/api/health`, narrowed to the field this command needs.
#[derive(Deserialize)]
struct PsHealth {
    /// `null` on a tenant with no indexer, which is why it is a nested Option
    /// rather than a defaulted struct.
    #[serde(default)]
    indexer: Option<PsIndexer>,
}

#[derive(Serialize)]
struct PsOutput {
    workspaces: Vec<PsRow>,
}

/// The `chan ps` / `chan workspace status` STATE column: what this
/// workspace's serving is worth right now.
///
/// `free` when no live writer holds it. `degraded` when the holder reports a
/// root it cannot use ([`WorkspaceStatus::Unavailable`]): the flock is held,
/// so the workspace is served, but the holder's own health check could not
/// validate the directory under it, and the reason says what it found.
/// `served` otherwise, including for a holder that reports no mount state at
/// all (a standalone or desktop serve, or a devserver this credential cannot
/// reach): unreported is not unusable.
fn ps_state_column(served: bool, mount: Option<WorkspaceStatus>) -> &'static str {
    if !served {
        return "free";
    }
    match mount {
        Some(WorkspaceStatus::Unavailable) => "degraded",
        _ => "served",
    }
}

/// The `chan ps` BY column: the resolved serving kind, or `-` when the
/// workspace is served but its kind could not be probed (the STATE column
/// already distinguishes served vs free).
fn ps_by_column(kind: Option<ServedBy>) -> &'static str {
    kind.map_or("-", ServedBy::label)
}

/// Every activity column renders this when the value is not reported, never
/// `0` and never blank, the same rule `cs terminal list` follows: a
/// queue depth of zero and an unknown queue depth are different facts, and
/// showing the second as the first is how an operator concludes "nothing
/// queued" about a workspace nobody asked.
const PS_ABSENT: &str = "-";

/// READY column: the readiness state word.
fn ps_ready_column(readiness: Option<WorkspaceReadiness>) -> &'static str {
    match readiness {
        Some(WorkspaceReadiness::Ready { .. }) => "ready",
        Some(WorkspaceReadiness::Recovering { .. }) => "recovering",
        None => PS_ABSENT,
    }
}

/// GEN column: `generation/completed` while recovering, bare `generation`
/// when ready. The gap between the two is the lag that says a pass is owed.
fn ps_gen_column(readiness: Option<WorkspaceReadiness>) -> String {
    match readiness {
        Some(WorkspaceReadiness::Ready { generation }) => generation.get().to_string(),
        Some(WorkspaceReadiness::Recovering {
            generation,
            completed_generation,
            ..
        }) => format!("{}/{}", generation.get(), completed_generation.get()),
        None => PS_ABSENT.to_string(),
    }
}

/// PASS column: `pending->active`, the pair that distinguishes a recovery
/// with a worker from one without. `14->none` is the stall fingerprint --
/// a pass is owed and nothing is running it -- and it is the column this
/// whole command exists to put on screen.
fn ps_pass_column(readiness: Option<WorkspaceReadiness>) -> String {
    match readiness {
        Some(WorkspaceReadiness::Recovering {
            active_generation,
            pending_generation,
            ..
        }) => {
            let render = |g: Option<chan_workspace::WorkspaceGeneration>| {
                g.map_or_else(|| "none".to_string(), |g| g.get().to_string())
            };
            format!(
                "{}->{}",
                render(pending_generation),
                render(active_generation)
            )
        }
        // A ready workspace has no pass in flight and no pass owed; that is
        // an absence of work, not an unknown, but rendering it `-` keeps the
        // column honest about carrying no pass rather than implying one.
        Some(WorkspaceReadiness::Ready { .. }) | None => PS_ABSENT.to_string(),
    }
}

/// ACTION column: the recovery action the pass would run.
fn ps_action_column(readiness: Option<WorkspaceReadiness>) -> &'static str {
    match readiness {
        Some(WorkspaceReadiness::Recovering {
            required_action: Some(action),
            ..
        }) => match action {
            RecoveryAction::Replay => "replay",
            RecoveryAction::Reconcile => "reconcile",
            RecoveryAction::FullRebuild => "rebuild",
        },
        _ => PS_ABSENT,
    }
}

/// INDEXER column: the indexer's own health word, or `-` when the tenant
/// carries no indexer or the call did not answer.
fn ps_indexer_column(indexer: Option<&PsIndexer>) -> &str {
    indexer
        .and_then(|i| i.status.as_deref())
        .unwrap_or(PS_ABSENT)
}

/// QUEUE column. A tenant with no indexer renders `-`, NOT `0`: "nothing is
/// queued" and "nobody is reporting a queue" are different facts, and a
/// workspace with no indexer at all reporting `0` reads as the healthy one.
fn ps_queue_column(indexer: Option<&PsIndexer>) -> String {
    indexer
        .and_then(|i| i.queue_depth)
        .map_or_else(|| PS_ABSENT.to_string(), |q| q.to_string())
}

/// Ask the local devserver what each of the workspaces it serves is doing.
///
/// Returns a map keyed by workspace root path. An empty map is the normal
/// answer whenever this credential does not reach a devserver -- no persisted
/// config, nothing listening, a refused bearer -- and every activity column
/// then renders `-`. `chan ps` reporting where a workspace lives must not
/// start failing because the thing serving it is unreachable.
///
/// Authority note: the bearer is the one already persisted at
/// `~/.chan/devserver/config.json`, which this CLI reads today to rotate that
/// same token (a mutating call). Reading two status endpoints with it grants
/// nothing new.
async fn devserver_activity(wanted: &HashSet<String>) -> HashMap<String, PsActivity> {
    let mut out = HashMap::new();
    if wanted.is_empty() {
        return out;
    }
    let Some(token) = chan_server::persisted_devserver_token() else {
        return out;
    };
    let Some(addr) = local_devserver_dial_addr() else {
        return out;
    };
    let client = reqwest::Client::new();
    // One gate for the whole enrichment: if the listing does not answer, we
    // stop here rather than waiting out a timeout per workspace.
    let Some(entries) = ps_get::<Vec<chan_server::devserver_api::WorkspaceEntry>>(
        &client,
        &format!("http://{addr}"),
        "/api/devserver/workspaces",
        &token,
    )
    .await
    else {
        return out;
    };
    for entry in entries {
        if !wanted.contains(&entry.path) {
            continue;
        }
        let base = format!("http://{addr}{}", entry.prefix);
        let readiness = ps_get::<PsIndexStatus>(&client, &base, "/api/index/status", &entry.token)
            .await
            .and_then(|status| status.readiness);
        let indexer = ps_get::<PsHealth>(&client, &base, "/api/health", &entry.token)
            .await
            .and_then(|health| health.indexer);
        out.insert(
            entry.path,
            PsActivity {
                mount: entry.status,
                mount_error: entry.error,
                readiness,
                indexer,
            },
        );
    }
    out
}

/// How long any one `chan ps` / workspace-status enrichment call may take,
/// including reading and decoding the response body. Short on purpose:
/// this is decoration on a command whose primary answer (where a workspace
/// is and whether it is served) is already in hand from the filesystem.
const PS_ACTIVITY_TIMEOUT: Duration = Duration::from_secs(2);

/// One authenticated status GET, decoded, with every failure flattened to
/// `None` -- an unreachable or unparseable endpoint renders `-`, it does not
/// fail the row or the command.
async fn ps_get<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    base: &str,
    path: &str,
    token: &str,
) -> Option<T> {
    let request = async {
        let response = client
            .get(format!("{base}{path}"))
            .bearer_auth(token)
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        response.json::<T>().await.ok()
    };
    tokio::time::timeout(PS_ACTIVITY_TIMEOUT, request)
        .await
        .ok()
        .flatten()
}

/// `chan ps`: report each registered workspace's serving state. Serving
/// is decided by a live writer-lock holder (`lock::is_free` is false);
/// the holder's pid + start time come from the `writer.lock` record.
pub(super) async fn cmd_ps(json: bool) -> Result<()> {
    let lib = library()?;
    let mut rows = Vec::new();
    for ws in lib.list_workspaces() {
        // By the row's metadata key, so one root that has stopped answering
        // holds up no other row.
        let lock_dir = Some(lib.workspace_paths_for_row(&ws).lock);
        let served = lock_dir
            .as_deref()
            .map(|d| !chan_workspace::lock::is_free(d))
            .unwrap_or(false);
        let record = if served {
            lock_dir
                .as_deref()
                .and_then(chan_workspace::lock::read_lock_record)
        } else {
            None
        };
        let pid = record.as_ref().map(|r| r.pid);
        let since = record.map(|r| r.started_at);
        let served_by = match (served, pid) {
            (true, Some(p)) => serving_kind(p).await,
            _ => None,
        };
        rows.push(PsRow {
            path: ws.root_path.display().to_string(),
            served,
            served_by,
            pid,
            since,
            activity: None,
        });
    }
    // Only a devserver-served workspace can be enriched: a standalone or
    // desktop serve persists no address/token pair this command may read.
    let wanted: HashSet<String> = rows
        .iter()
        .filter(|r| r.served_by == Some(ServedBy::Devserver))
        .map(|r| r.path.clone())
        .collect();
    let mut activity = devserver_activity(&wanted).await;
    for row in &mut rows {
        row.activity = activity.remove(&row.path);
    }
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&PsOutput { workspaces: rows })?
        );
        return Ok(());
    }
    if rows.is_empty() {
        println!("(no workspaces registered)");
        return Ok(());
    }
    println!(
        "{:<7}  {:<11}  {:>8}  {:<10}  {:<7}  {:<9}  {:<9}  {:<8}  {:>5}  WORKSPACE",
        "STATE", "BY", "PID", "READY", "GEN", "PASS", "ACTION", "INDEXER", "QUEUE"
    );
    for r in &rows {
        let state = ps_state_column(r.served, r.activity.as_ref().map(|a| a.mount));
        let by = ps_by_column(r.served_by);
        let pid = r
            .pid
            .map_or_else(|| PS_ABSENT.to_string(), |p| p.to_string());
        let readiness = r.activity.as_ref().and_then(|a| a.readiness);
        let indexer = r.activity.as_ref().and_then(|a| a.indexer.as_ref());
        println!(
            "{:<7}  {:<11}  {:>8}  {:<10}  {:<7}  {:<9}  {:<9}  {:<8}  {:>5}  {}",
            state,
            by,
            pid,
            ps_ready_column(readiness),
            ps_gen_column(readiness),
            ps_pass_column(readiness),
            ps_action_column(readiness),
            ps_indexer_column(indexer),
            ps_queue_column(indexer),
            r.path
        );
    }
    Ok(())
}

/// Resolve the serving kind behind `holder_pid` with an `Identify`
/// round-trip to its control socket. Returns `None` when the holder has
/// no reachable control socket or does not answer; `chan ps` then shows
/// `-` in the BY column (the STATE column still distinguishes served vs
/// free).
async fn serving_kind(holder_pid: u32) -> Option<ServedBy> {
    let socket = control_socket_for_pid(holder_pid).await?;
    let identity = chan_shell::socket_identity(&socket).await?;
    Some(match identity.kind {
        chan_shell::ServeKind::Standalone => ServedBy::Standalone,
        chan_shell::ServeKind::Desktop => ServedBy::Desktop,
        chan_shell::ServeKind::Devserver => ServedBy::Devserver,
    })
}

#[derive(Serialize)]
struct StatusOutput {
    root: String,
    metadata_key: Option<String>,
    served: bool,
    served_by: Option<ServedBy>,
    pid: Option<u32>,
    /// The holder's live mount state, when it reports one. `unavailable`
    /// means the tenant is mounted over a directory it cannot use.
    #[serde(skip_serializing_if = "Option::is_none")]
    mount: Option<WorkspaceStatus>,
    /// The reason behind `mount`, when the holder reports one.
    #[serde(skip_serializing_if = "Option::is_none")]
    mount_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    readiness: Option<WorkspaceReadiness>,
    #[serde(skip_serializing_if = "Option::is_none")]
    indexer: Option<PsIndexer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    index: Option<StatusIndex>,
    #[serde(skip_serializing_if = "Option::is_none")]
    graph: Option<StatusGraph>,
    #[serde(skip_serializing_if = "Option::is_none")]
    report: Option<StatusReport>,
}

#[derive(Serialize)]
struct StatusIndex {
    ready: bool,
    indexed_docs: u64,
    indexed_vectors: u64,
    model: String,
}

#[derive(Serialize)]
struct StatusGraph {
    files: usize,
    edges: usize,
    tags: usize,
}

#[derive(Serialize)]
struct StatusReport {
    files: u64,
    code: u64,
    comments: u64,
    blanks: u64,
    complexity: u64,
    by_language: Vec<StatusLanguage>,
    cocomo_model: String,
    estimated_cost_usd: f64,
}

#[derive(Serialize)]
struct StatusLanguage {
    name: String,
    files: u64,
    code: u64,
}

async fn workspace_status_for(lib: &Library, root: &Path) -> Result<StatusOutput> {
    let paths = lib
        .workspace_paths_for(root)
        .ok_or_else(|| anyhow::anyhow!(not_a_chan_workspace_hint(root)))?;
    let known = lib
        .list_workspaces()
        .into_iter()
        .find(|workspace| {
            paths
                .root
                .file_name()
                .is_some_and(|key| key == workspace.metadata_key.as_str())
        })
        .context("registered workspace disappeared during status lookup")?;
    // A holder the probe observed is reported as served. When the probe
    // established nothing, reporting `served` would claim a holder nobody saw,
    // and opening locally could race one, so refuse instead.
    if paths.lock.is_dir() {
        match chan_workspace::lock::probe_foreign_holder(&paths.lock, &known.root_path) {
            chan_workspace::lock::ForeignHolder::Present => {
                return Ok(served_workspace_status(&known, &paths.lock).await);
            }
            chan_workspace::lock::ForeignHolder::Unknown { reason } => {
                return Err(anyhow::anyhow!(
                    "cannot determine workspace lock status: {reason}"
                ));
            }
            chan_workspace::lock::ForeignHolder::Absent => {}
        }
    }
    match lib.open_workspace(root) {
        Ok(workspace) => workspace_status_output(&workspace, Some(known.metadata_key)),
        Err(
            chan_workspace::ChanError::WorkspaceLocked
            | chan_workspace::ChanError::WorkspaceAlreadyOpen,
        ) => Ok(served_workspace_status(&known, &paths.lock).await),
        Err(error) => Err(error.into()),
    }
}

async fn served_workspace_status(known: &KnownWorkspace, lock_dir: &Path) -> StatusOutput {
    let pid = chan_workspace::lock::read_lock_record(lock_dir).map(|record| record.pid);
    let served_by = match pid {
        Some(pid) => serving_kind(pid).await,
        None => None,
    };
    let root = known.root_path.display().to_string();
    let activity = if served_by == Some(ServedBy::Devserver) {
        devserver_activity(&HashSet::from([root.clone()]))
            .await
            .remove(&root)
    } else {
        None
    };
    let (mount, mount_error, readiness, indexer) = match activity {
        Some(activity) => (
            Some(activity.mount),
            activity.mount_error,
            activity.readiness,
            activity.indexer,
        ),
        None => (None, None, None, None),
    };
    StatusOutput {
        root,
        metadata_key: Some(known.metadata_key.clone()),
        served: true,
        served_by,
        pid,
        mount,
        mount_error,
        readiness,
        indexer,
        index: None,
        graph: None,
        report: None,
    }
}

pub(super) async fn cmd_status(path: Option<PathBuf>, json: bool) -> Result<()> {
    let lib = library()?;
    let root = path.ok_or_else(|| missing_workspace_path("status", "chan workspace status ."))?;
    let out = workspace_status_for(&lib, &root).await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&out)?);
        return Ok(());
    }
    println!("workspace: {}", out.root);
    if let Some(metadata_key) = &out.metadata_key {
        println!("metadata: {metadata_key}");
    }
    if out.served {
        // `served` is the flock; the holder's mount state is what says whether
        // serving it is worth anything, so the same word `chan ps` prints.
        println!("state: {}", ps_state_column(true, out.mount));
        if let Some(reason) = &out.mount_error {
            println!("reason: {reason}");
        }
        println!("by: {}", ps_by_column(out.served_by));
        println!(
            "pid: {}",
            out.pid
                .map_or_else(|| PS_ABSENT.to_string(), |pid| pid.to_string())
        );
    }
    println!("readiness: {}", ps_ready_column(out.readiness));
    if out.served {
        println!(
            "indexer: {} queue={}",
            ps_indexer_column(out.indexer.as_ref()),
            ps_queue_column(out.indexer.as_ref())
        );
        return Ok(());
    }
    if matches!(out.readiness, Some(WorkspaceReadiness::Recovering { .. })) {
        println!("derived state: unavailable while workspace recovery is in progress");
        return Ok(());
    }
    let index = out
        .index
        .as_ref()
        .context("ready workspace status missing index snapshot")?;
    let graph = out
        .graph
        .as_ref()
        .context("ready workspace status missing graph snapshot")?;
    let report = out
        .report
        .as_ref()
        .context("ready workspace status missing report snapshot")?;
    println!(
        "index: ready={} docs={} vectors={} model={}",
        index.ready, index.indexed_docs, index.indexed_vectors, index.model
    );
    println!(
        "graph: files={} edges={} tags={}",
        graph.files, graph.edges, graph.tags
    );
    println!(
        "report: files={} code={} comments={} blanks={} complexity={} cocomo={} cost=${:.2}",
        report.files,
        report.code,
        report.comments,
        report.blanks,
        report.complexity,
        report.cocomo_model,
        report.estimated_cost_usd
    );
    if !report.by_language.is_empty() {
        println!("languages:");
        for lang in &report.by_language {
            println!(
                "  {:<18} files={:<5} code={}",
                lang.name, lang.files, lang.code
            );
        }
    }
    Ok(())
}

fn workspace_status_output(
    workspace: &Workspace,
    metadata_key: Option<String>,
) -> Result<StatusOutput> {
    let readiness = workspace.readiness();
    if matches!(readiness, WorkspaceReadiness::Recovering { .. }) {
        return Ok(StatusOutput {
            root: workspace.root().display().to_string(),
            metadata_key,
            served: false,
            served_by: None,
            pid: None,
            mount: None,
            mount_error: None,
            readiness: Some(readiness),
            indexer: None,
            index: None,
            graph: None,
            report: None,
        });
    }

    let index = workspace.index_stats().context("reading index stats")?;
    let graph = workspace.graph().context("opening graph")?;
    let graph_files = graph.files().context("reading graph files")?;
    let mut graph_edges = 0usize;
    for file in &graph_files {
        graph_edges += graph
            .neighbors(file)
            .with_context(|| format!("querying graph neighbors for {file}"))?
            .len();
    }
    let tags = graph.tags().context("reading graph tags")?.len();
    let report = workspace.report().context("reading code report")?;
    let by_language = report
        .by_language
        .into_iter()
        .take(12)
        .map(|l| StatusLanguage {
            name: l.name,
            files: l.files,
            code: l.code,
        })
        .collect();
    let out = StatusOutput {
        root: workspace.root().display().to_string(),
        metadata_key,
        served: false,
        served_by: None,
        pid: None,
        mount: None,
        mount_error: None,
        readiness: Some(readiness),
        indexer: None,
        index: Some(StatusIndex {
            ready: index.ready,
            indexed_docs: index.indexed_docs,
            indexed_vectors: index.indexed_vectors,
            model: index.model,
        }),
        graph: Some(StatusGraph {
            files: graph_files.len(),
            edges: graph_edges,
            tags,
        }),
        report: Some(StatusReport {
            files: report.totals.files,
            code: report.totals.code,
            comments: report.totals.comments,
            blanks: report.totals.blanks,
            complexity: report.totals.complexity,
            by_language,
            cocomo_model: report.cocomo.model,
            estimated_cost_usd: report.cocomo.estimated_cost_usd,
        }),
    };
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn workspace_status_reports_a_served_workspace_without_taking_the_lock() {
        let config = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let config_path = config.path().join("config.toml");
        let holder = Library::open_at(config_path.clone()).unwrap();
        let known = holder.register_workspace(root.path()).unwrap();
        let held = holder.open_workspace(root.path()).unwrap();
        let querying = Library::open_at(config_path.clone()).unwrap();
        let before = std::fs::read(&config_path).unwrap();

        let output = tokio::time::timeout(
            Duration::from_secs(10),
            workspace_status_for(&querying, root.path()),
        )
        .await
        .expect("status is bounded")
        .expect("status reports the existing holder");
        let json = serde_json::to_value(output).unwrap();
        assert_eq!(json["root"], held.root().display().to_string());
        assert_eq!(json["metadata_key"], known.metadata_key);
        assert_eq!(json["served"], true);
        assert_eq!(json["pid"], std::process::id());
        for field in ["index", "graph", "report"] {
            assert!(json.get(field).is_none(), "{json}");
        }
        assert_eq!(std::fs::read(&config_path).unwrap(), before);
        assert!(matches!(
            querying.open_workspace(root.path()),
            Err(chan_workspace::ChanError::WorkspaceAlreadyOpen)
        ));
    }

    #[tokio::test]
    async fn workspace_status_opens_a_workspace_with_a_missing_lock_directory() {
        let config = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let config_path = config.path().join("config.toml");
        let lib = Library::open_at(config_path.clone()).unwrap();
        let known = lib.register_workspace(root.path()).unwrap();
        let paths = lib.workspace_paths_for(root.path()).unwrap();
        let before = std::fs::read(&config_path).unwrap();
        std::fs::remove_dir_all(&paths.lock).unwrap();

        let output = tokio::time::timeout(
            Duration::from_secs(4),
            workspace_status_for(&lib, root.path()),
        )
        .await
        .expect("status is bounded")
        .expect("status recreates missing metadata directories");

        assert!(!output.served, "a missing lock directory has no holder");
        assert_eq!(output.metadata_key, Some(known.metadata_key));
        assert_eq!(output.pid, None);
        assert_eq!(output.served_by, None);
        assert!(output.readiness.is_some());
        assert!(paths.lock.is_dir());
        assert_eq!(std::fs::read(&config_path).unwrap(), before);
    }

    #[tokio::test]
    async fn ps_get_bounds_a_stalled_response_body() {
        use tokio::io::AsyncWriteExt;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (done, finished) = tokio::sync::oneshot::channel();
        let peer = async {
            let (mut stream, _) = tokio::time::timeout(Duration::from_secs(2), listener.accept())
                .await
                .expect("client connects")
                .unwrap();
            tokio::time::timeout(
                Duration::from_secs(2),
                stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: application/json\r\n\r\n["),
            )
            .await
            .expect("headers sent")
            .unwrap();
            tokio::time::timeout(Duration::from_secs(6), finished)
                .await
                .expect("client check finishes")
                .unwrap();
            drop(stream);
        };
        let query = async {
            let client = reqwest::Client::new();
            let result = tokio::time::timeout(
                Duration::from_secs(4),
                ps_get::<serde_json::Value>(&client, &base, "/api/health", "test-token"),
            )
            .await;
            done.send(()).unwrap();
            result
        };
        let (result, ()) = tokio::join!(query, peer);
        assert!(result
            .expect("activity body decode must be bounded")
            .is_none());
    }

    #[tokio::test]
    async fn workspace_status_refuses_an_unregistered_path_without_registering() {
        let config = tempfile::tempdir().unwrap();
        let registered = tempfile::tempdir().unwrap();
        let unregistered = tempfile::tempdir().unwrap();
        let config_path = config.path().join("config.toml");
        let lib = Library::open_at(config_path.clone()).unwrap();
        lib.register_workspace(registered.path()).unwrap();
        let before = std::fs::read(&config_path).unwrap();
        let metadata_count = std::fs::read_dir(config.path().join("workspaces"))
            .unwrap()
            .count();

        let result = workspace_status_for(&lib, unregistered.path()).await;

        assert_eq!(
            lib.list_workspaces().len(),
            1,
            "status must not register a path"
        );
        assert_eq!(std::fs::read(&config_path).unwrap(), before);
        assert!(lib.workspace_paths_for(unregistered.path()).is_none());
        assert_eq!(
            std::fs::read_dir(config.path().join("workspaces"))
                .unwrap()
                .count(),
            metadata_count
        );
        assert_eq!(
            result.err().expect("unregistered status fails").to_string(),
            not_a_chan_workspace_hint(unregistered.path())
        );
    }

    #[test]
    fn workspace_status_skips_derived_snapshots_during_recovery() {
        let config = tempfile::tempdir().expect("config dir");
        let root = tempfile::tempdir().expect("workspace root");
        let lib = Library::open_at(config.path().join("config.toml")).expect("library");
        let known = lib.register_workspace(root.path()).expect("register");
        let workspace = lib.open_workspace(root.path()).expect("open");
        workspace.request_recovery(chan_workspace::RecoveryAction::FullRebuild);

        let output =
            workspace_status_output(&workspace, Some(known.metadata_key)).expect("status output");
        let json = serde_json::to_value(&output).expect("status JSON");

        assert_eq!(json["readiness"]["state"], "recovering");
        assert!(json.get("index").is_none(), "{json}");
        assert!(json.get("graph").is_none(), "{json}");
        assert!(json.get("report").is_none(), "{json}");
    }

    /// A writer lock the probe could not open refuses `chan workspace status`
    /// instead of reporting the workspace as served, which would claim a
    /// holder nobody observed. Pinned apart from the search path because the
    /// two callers reach different fallbacks when the probe does establish
    /// something.
    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_status_refuses_when_the_lock_status_is_unknown() {
        let config = tempfile::TempDir::new().unwrap();
        let root = tempfile::TempDir::new().unwrap();
        let lib = Library::open_at(config.path().join("config.toml")).unwrap();
        lib.register_workspace(root.path()).unwrap();
        let paths = lib.workspace_paths_for(root.path()).unwrap();
        std::fs::create_dir_all(paths.lock.join("writer.lock")).unwrap();

        match workspace_status_for(&lib, root.path()).await {
            Err(error) => assert!(
                error
                    .to_string()
                    .contains("cannot determine workspace lock status"),
                "{error}"
            ),
            Ok(_) => panic!("an unknown lock status must not report the workspace as served"),
        }
    }

    #[test]
    fn ps_by_column_never_emits_bare_served() {
        // An unprobed kind renders `-` (STATE carries the served/free
        // distinction).
        assert_eq!(ps_by_column(None), "-");
        // A resolved kind renders its label.
        assert_eq!(ps_by_column(Some(ServedBy::Devserver)), "devserver");
        assert_eq!(ps_by_column(Some(ServedBy::Standalone)), "standalone");
        assert_eq!(ps_by_column(Some(ServedBy::Desktop)), "desktop");
    }

    #[test]
    fn ps_state_column_separates_a_degraded_mount_from_a_healthy_one() {
        // The flock decides served vs free; a mount state never revives a
        // workspace nobody holds.
        assert_eq!(ps_state_column(false, None), "free");
        assert_eq!(
            ps_state_column(false, Some(WorkspaceStatus::Unavailable)),
            "free"
        );
        // A holder that reports no mount state (a standalone or desktop serve,
        // or a devserver this credential cannot reach) is not called degraded:
        // unreported is not unusable.
        assert_eq!(ps_state_column(true, None), "served");
        assert_eq!(
            ps_state_column(true, Some(WorkspaceStatus::Running)),
            "served"
        );
        // The one case an operator has to act on: mounted over a directory the
        // tenant cannot use, which the flock alone cannot tell from a healthy
        // serve.
        assert_eq!(
            ps_state_column(true, Some(WorkspaceStatus::Unavailable)),
            "degraded"
        );
    }

    /// The payload is one recorded from a live devserver whose workspace was
    /// stranded in recovery: generation 14, completed 12, reconcile owed,
    /// nothing active. Parsing the real evidence
    /// rather than a hand-built value is deliberate -- it pins the wire shape
    /// this command reads, so a server-side rename fails here instead of
    /// quietly rendering `-` forever.
    #[test]
    fn ps_columns_render_the_stall_fingerprint() {
        let readiness: WorkspaceReadiness = serde_json::from_str(
            r#"{"state":"recovering","generation":14,"completed_generation":12,
                "required_action":"reconcile","active_generation":null,
                "pending_generation":14}"#,
        )
        .expect("the recorded live readiness payload must parse");
        let readiness = Some(readiness);

        assert_eq!(ps_ready_column(readiness), "recovering");
        // generation/completed: the lag that says a pass is owed.
        assert_eq!(ps_gen_column(readiness), "14/12");
        // pending->active. `14->none` IS the stall: work owed, nobody running
        // it. This is the column the whole item exists to put on screen.
        assert_eq!(ps_pass_column(readiness), "14->none");
        assert_eq!(ps_action_column(readiness), "reconcile");
    }

    /// A recovery that HAS a claimant must not render like the stall. Same
    /// state word, same readiness variant, different PASS column -- which is
    /// the distinction v0.87.0 shipped and that this command must not collapse.
    #[test]
    fn ps_pass_column_distinguishes_a_claimed_pass_from_a_stalled_one() {
        let claimed: WorkspaceReadiness = serde_json::from_str(
            r#"{"state":"recovering","generation":14,"completed_generation":12,
                "required_action":"reconcile","active_generation":14,
                "pending_generation":null}"#,
        )
        .unwrap();
        assert_eq!(ps_ready_column(Some(claimed)), "recovering");
        assert_eq!(ps_pass_column(Some(claimed)), "none->14");

        let stalled: WorkspaceReadiness = serde_json::from_str(
            r#"{"state":"recovering","generation":14,"completed_generation":12,
                "required_action":"reconcile","active_generation":null,
                "pending_generation":14}"#,
        )
        .unwrap();
        assert_ne!(ps_pass_column(Some(claimed)), ps_pass_column(Some(stalled)));
    }

    /// A healthy workspace, from a payload captured off a live devserver.
    #[test]
    fn ps_columns_render_a_ready_workspace() {
        let readiness: WorkspaceReadiness =
            serde_json::from_str(r#"{"state":"ready","generation":3}"#).unwrap();
        let readiness = Some(readiness);
        assert_eq!(ps_ready_column(readiness), "ready");
        assert_eq!(ps_gen_column(readiness), "3");
        // No pass in flight and none owed.
        assert_eq!(ps_pass_column(readiness), "-");
        assert_eq!(ps_action_column(readiness), "-");
    }

    /// The v0.85.0 `cs terminal list` ruling, applied here: an unreported
    /// value renders `-`, never `0`. A tenant with no indexer reporting a
    /// queue depth of `0` would read as the healthy one, which is the exact
    /// misreading this command exists to prevent.
    #[test]
    fn ps_absent_indexer_renders_dash_not_zero() {
        // `/api/health` reports `indexer: null` on a tenant with no indexer.
        let health: PsHealth = serde_json::from_str(r#"{"indexer":null}"#).unwrap();
        assert!(health.indexer.is_none());
        assert_eq!(ps_indexer_column(health.indexer.as_ref()), "-");
        assert_eq!(ps_queue_column(health.indexer.as_ref()), "-");

        // A real indexer reporting an empty queue renders `0`, and the two
        // must not be the same string.
        let live: PsHealth = serde_json::from_str(
            r#"{"indexer":{"status":"idle","queue_depth":0,"last_event_at":null,
                "last_settled_at":1786352908,"coalesced_rebuild":false}}"#,
        )
        .unwrap();
        assert_eq!(ps_indexer_column(live.indexer.as_ref()), "idle");
        assert_eq!(ps_queue_column(live.indexer.as_ref()), "0");
        assert_ne!(
            ps_queue_column(health.indexer.as_ref()),
            ps_queue_column(live.indexer.as_ref())
        );
    }

    /// Every column degrades to `-` when nothing answered, so an unreachable
    /// devserver costs the operator the activity columns and not the command.
    #[test]
    fn ps_columns_render_absent_when_nothing_answered() {
        assert_eq!(ps_ready_column(None), "-");
        assert_eq!(ps_gen_column(None), "-");
        assert_eq!(ps_pass_column(None), "-");
        assert_eq!(ps_action_column(None), "-");
        assert_eq!(ps_indexer_column(None), "-");
        assert_eq!(ps_queue_column(None), "-");
    }

    /// `/api/index/status` flattens `IndexStatus` alongside `readiness`, so
    /// the reader must pick readiness out of a payload carrying other keys
    /// rather than expecting a bare object. Payload captured live.
    #[test]
    fn ps_index_status_reads_readiness_out_of_the_flattened_payload() {
        let status: PsIndexStatus = serde_json::from_str(
            r#"{"state":"idle","indexed_docs":3,"indexed_vectors":0,
                "model":"BAAI/bge-small-en-v1.5",
                "readiness":{"state":"ready","generation":1}}"#,
        )
        .unwrap();
        assert_eq!(ps_ready_column(status.readiness), "ready");
        assert_eq!(ps_gen_column(status.readiness), "1");
    }

    #[test]
    fn served_by_json_labels_are_stable() {
        // The `chan ps --json` `served_by` strings are a machine contract.
        assert_eq!(
            serde_json::to_value(ServedBy::Standalone).unwrap(),
            "standalone"
        );
        assert_eq!(serde_json::to_value(ServedBy::Desktop).unwrap(), "desktop");
        assert_eq!(
            serde_json::to_value(ServedBy::Devserver).unwrap(),
            "devserver"
        );
        assert_eq!(ServedBy::Devserver.label(), "devserver");
    }
}
