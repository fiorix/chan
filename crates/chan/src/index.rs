use std::path::PathBuf;

use anyhow::{Context, Result};

use crate::cli::IndexAction;
use crate::registry::{ensure_workspace_registered, library};
#[cfg(feature = "embeddings")]
use crate::registry::{missing_workspace_path, not_a_chan_workspace_hint, same_path};

pub(super) fn cmd_index(action: IndexAction) -> Result<()> {
    match action {
        IndexAction::Rebuild { path, path_flag } => {
            // Either form works. Both supplied → the
            // flag wins; users have to be explicit anyway and the
            // flag is the canonical shape. Neither
            // supplied → clean error, not a clap-default panic.
            let resolved = path_flag.or(path).ok_or_else(|| {
                anyhow::anyhow!(
                    "`chan workspace index rebuild` requires a workspace path (positional or `--path`)"
                )
            })?;
            cmd_index_rebuild(resolved)
        }
        IndexAction::DownloadModel { model } => cmd_index_download_model(&model),
        IndexAction::ListModels { json } => cmd_index_list_models(json),
        IndexAction::SetModel { path, model } => cmd_index_set_model(path, &model),
        IndexAction::EnableSemantic { path } => cmd_index_set_semantic(path, true),
        IndexAction::DisableSemantic { path } => cmd_index_set_semantic(path, false),
        IndexAction::Status { path, json } => cmd_index_status(path, json),
    }
}

fn cmd_index_rebuild(path: PathBuf) -> Result<()> {
    let lib = library()?;
    // Idempotent: registering an already-known workspace only touches
    // last_seen_at. CLI users expect `chan workspace index rebuild /some/path`
    // to work without a prior `chan workspace add`.
    ensure_workspace_registered(&lib, &path)?;
    let workspace = lib.open_workspace(&path)?;

    // Live progress on stderr so the user can see the embed pass
    // is making progress; on a big workspace it can run for tens of
    // minutes. Use a TTY-friendly carriage return rewrite when
    // stderr is interactive; fall back to plain lines (one per
    // file) when redirected so logs stay readable.
    use std::io::{IsTerminal, Write};
    let tty = std::io::stderr().is_terminal();
    // Progress arrives as one `ProgressEvent` per stage (IndexFile /
    // EmbedBatch / GraphRebuild / ...) with current/total counters and an
    // optional label. IndexFile and EmbedBatch get counters; every other
    // stage folds into a generic "still working" line so nothing is silent
    // on large workspaces.
    let callback = chan_workspace::progress::progress_fn(move |p| {
        let line = match p.stage {
            chan_workspace::progress::ProgressStage::IndexFile => format!(
                "[{}/{}] {}",
                p.current.saturating_add(1),
                p.total,
                p.label.as_deref().unwrap_or("")
            ),
            chan_workspace::progress::ProgressStage::EmbedBatch => format!(
                "[{}/{}] embedding {} chunks...",
                p.current.saturating_add(1),
                p.total,
                p.current
            ),
            other => format!("{other:?} {}", p.label.as_deref().unwrap_or("")),
        };
        if tty {
            let mut err = std::io::stderr().lock();
            let _ = write!(err, "\r\x1b[2K{line}");
            let _ = err.flush();
        } else {
            eprintln!("{line}");
        }
    });
    let summary = workspace
        .reindex_with(None, callback.as_ref())
        .context("reindex")?;
    if tty {
        eprintln!();
    }

    println!(
        "indexed {}/{} files, {} chunks ({} errors)",
        summary.indexed,
        summary.files,
        summary.chunks,
        summary.errors.len(),
    );
    // Surface embed-phase resumption when it fired. Skipped on full
    // first-time builds (count is 0) so the success path stays terse.
    if summary.embeds_reused > 0 {
        println!(
            "reused {} embedding shard{} from prior run",
            summary.embeds_reused,
            if summary.embeds_reused == 1 { "" } else { "s" },
        );
    }
    for (path, e) in &summary.errors {
        eprintln!("  error: {path}: {e}");
    }
    Ok(())
}

fn cmd_index_list_models(json: bool) -> Result<()> {
    let models = chan_workspace::index::config::embedding_models();
    if json {
        println!("{}", serde_json::to_string_pretty(models)?);
    } else {
        for model in models {
            let marker = if model.is_default { "default" } else { "" };
            println!(
                "{:<28} {:<19} dim={:<4} {:<8} {:<7} {}",
                model.id, model.label, model.dim, model.size_label, marker, model.note
            );
        }
    }
    Ok(())
}

/// Stub when the binary is built without
/// `--features embeddings`. The candle + hf-hub stack is gated
/// behind that feature; without it there's nothing to download.
/// Bail with a clear message instead of a missing-symbol error.
#[cfg(not(feature = "embeddings"))]
fn cmd_index_download_model(_model: &str) -> Result<()> {
    anyhow::bail!("chan was built without `--features embeddings`; semantic search is unavailable")
}

#[cfg(not(feature = "embeddings"))]
fn cmd_index_set_semantic(_path: Option<PathBuf>, _enabled: bool) -> Result<()> {
    anyhow::bail!("chan was built without `--features embeddings`; semantic search is unavailable")
}

#[cfg(not(feature = "embeddings"))]
fn cmd_index_set_model(_path: Option<PathBuf>, _model: &str) -> Result<()> {
    anyhow::bail!("chan was built without `--features embeddings`; semantic search is unavailable")
}

#[cfg(not(feature = "embeddings"))]
fn cmd_index_status(_path: Option<PathBuf>, _json: bool) -> Result<()> {
    anyhow::bail!("chan was built without `--features embeddings`; semantic search is unavailable")
}

/// Download the embedding model into the per-machine
/// cache. Blocking; the hf-hub backend prints its own progress to
/// stderr when stderr is a TTY. Idempotent -- if the model is
/// already laid out in the cache the call returns immediately.
#[cfg(feature = "embeddings")]
fn cmd_index_download_model(model: &str) -> Result<()> {
    use chan_workspace::index::embeddings::{
        global_models_dir, repo_dir_name, resolve_model, Embedder,
    };
    if chan_workspace::index::config::embedding_model(model).is_none() {
        anyhow::bail!(
            "unknown embedding model: {model} (run `chan workspace index list-models` to list supported models)"
        );
    }
    let cache_dir = global_models_dir();
    let expected_dir = cache_dir.join(repo_dir_name(model));
    if resolve_model(model).is_ok() {
        println!(
            "model {} already present at {}",
            model,
            expected_dir.display()
        );
        return Ok(());
    }
    std::fs::create_dir_all(&cache_dir)
        .with_context(|| format!("create model cache {}", cache_dir.display()))?;
    eprintln!(
        "downloading {} into {} (this may take a few minutes)",
        model,
        cache_dir.display()
    );
    Embedder::open(model, &cache_dir).with_context(|| format!("download model {model}"))?;
    println!("downloaded {} into {}", model, expected_dir.display());
    Ok(())
}

#[cfg(feature = "embeddings")]
fn cmd_index_set_model(path: Option<PathBuf>, model: &str) -> Result<()> {
    if chan_workspace::index::config::embedding_model(model).is_none() {
        anyhow::bail!(
            "unknown embedding model: {model} (run `chan workspace index list-models` to list supported models)"
        );
    }
    let lib = library()?;
    let root = path.ok_or_else(|| {
        missing_workspace_path(
            "index set-model",
            "chan workspace index set-model --path . --model BAAI/bge-small-en-v1.5",
        )
    })?;
    let workspace = lib
        .open_workspace(&root)
        .with_context(|| not_a_chan_workspace_hint(&root))?;
    workspace
        .set_semantic_model(model)
        .context("persisting semantic model")?;
    println!(
        "semantic model set to {model} for workspace at {}",
        workspace.root().display()
    );
    Ok(())
}

/// Flip the per-workspace Hybrid-search opt-in. On enable,
/// refuses if the model isn't downloaded; the user is pointed at
/// `chan workspace index download-model`. On disable, always succeeds (the
/// underlying `set_semantic_enabled` is idempotent).
///
/// Deliberately does NOT auto-register an unregistered path.
/// Refusing here surfaces a clean "not a chan workspace at <path>"
/// instead of a registration side-effect that leaks the
/// implementation detail.
#[cfg(feature = "embeddings")]
fn cmd_index_set_semantic(path: Option<PathBuf>, enabled: bool) -> Result<()> {
    use chan_workspace::index::embeddings::resolve_model;
    let lib = library()?;
    let root = path.ok_or_else(|| {
        let (cmd, hint) = if enabled {
            (
                "index enable-semantic",
                "chan workspace index enable-semantic --path .",
            )
        } else {
            (
                "index disable-semantic",
                "chan workspace index disable-semantic --path .",
            )
        };
        missing_workspace_path(cmd, hint)
    })?;
    let workspace = lib
        .open_workspace(&root)
        .with_context(|| not_a_chan_workspace_hint(&root))?;
    if enabled {
        let model = workspace
            .semantic_model()
            .context("reading workspace's model id")?;
        if let Err(err) = resolve_model(&model) {
            return Err(anyhow::anyhow!(
                "{err}\nrun `chan workspace index download-model` to fetch it"
            ));
        }
    }
    workspace
        .set_semantic_enabled(enabled)
        .context("persisting semantic_enabled flag")?;
    let verb = if enabled { "enabled" } else { "disabled" };
    println!(
        "semantic search {verb} for workspace at {}",
        workspace.root().display()
    );
    Ok(())
}

/// Print the per-workspace semantic-search state. Text by
/// default; `--json` emits a `{workspaces:[{...}]}`-style object for
/// scripting (single workspace in the response; the shape is plural so
/// a future multi-workspace variant lands as a pure extension).
///
/// Read-only access, lock-free + no auto-register.
/// Taking the writer lock via `Workspace::open` (and
/// auto-registering missing paths) would surface against a
/// live-served workspace as "workspace is locked by another
/// process", and against an
/// unregistered path leak "Error: registering <path>". So the
/// helper looks up the registered workspace's index dir directly and
/// loads `IndexConfig` from disk -- no Workspace handle, no flock, no
/// side-effects. Missing-from-registry → clean
/// "not a chan workspace at <path>".
#[cfg(feature = "embeddings")]
fn cmd_index_status(path: Option<PathBuf>, json: bool) -> Result<()> {
    use chan_workspace::index::embeddings::{global_models_dir, repo_dir_name, resolve_model};
    let lib = library()?;
    let root = path.ok_or_else(|| {
        missing_workspace_path("index status", "chan workspace index status --path .")
    })?;
    let workspace_paths = lib
        .workspace_paths_for(&root)
        .ok_or_else(|| anyhow::anyhow!(not_a_chan_workspace_hint(&root)))?;
    // Canonical path comes back from the registry entry; falls back
    // to the user-supplied root if the registry lookup somehow
    // races (impossible while we hold a Library handle, but the
    // ladder keeps the display correct without panicking).
    let canonical_root = lib
        .list_workspaces()
        .into_iter()
        .find(|d| same_path(&d.root_path, &root))
        .map(|d| d.root_path)
        .unwrap_or(root);
    let cfg = chan_workspace::index::config::load(&workspace_paths.index).with_context(|| {
        format!(
            "reading index config at {}",
            workspace_paths.index.display()
        )
    })?;
    // Report and semantic toggles live in the per-workspace dashboard config.
    let dashboard = chan_workspace::dashboard::load(&workspace_paths.root).with_context(|| {
        format!(
            "reading dashboard config at {}",
            workspace_paths.root.display()
        )
    })?;
    let model = cfg.model;
    let semantic_enabled = dashboard.semantic_enabled;
    let expected_dir = global_models_dir().join(repo_dir_name(&model));
    let model_present = resolve_model(&model).is_ok();
    let model_size_bytes = if model_present {
        Some(dir_total_size(&expected_dir))
    } else {
        None
    };
    let mode = if semantic_enabled && model_present {
        "hybrid"
    } else {
        "bm25"
    };
    if json {
        // Emit `reports_enabled` alongside `semantic_enabled` so a desktop
        // caller reads both flags from one CLI round-trip. Both come from the
        // per-workspace dashboard config; this is a strict additive extension
        // (existing JSON consumers ignore unknown fields).
        let body = serde_json::json!({
            "workspace": canonical_root.display().to_string(),
            "mode": mode,
            "model_present": model_present,
            "model_name": model,
            "model_path": expected_dir.display().to_string(),
            "model_size_bytes": model_size_bytes,
            "semantic_enabled": semantic_enabled,
            "reports_enabled": dashboard.reports_enabled,
        });
        println!("{}", serde_json::to_string_pretty(&body)?);
    } else {
        println!("workspace:            {}", canonical_root.display());
        println!("mode:             {mode}");
        println!("model:            {model}");
        println!("model path:       {}", expected_dir.display());
        println!(
            "model present:    {}",
            if model_present {
                "yes"
            } else {
                "no (run `chan workspace index download-model`)"
            }
        );
        if let Some(bytes) = model_size_bytes {
            println!("model size:       {}", humanize_bytes(bytes));
        }
        println!(
            "semantic enabled: {}",
            if semantic_enabled { "yes" } else { "no" }
        );
    }
    Ok(())
}

/// Recursive size of every regular file under `dir`. Mirrors the
/// helper in `chan-server::routes::index` so the CLI status output
/// agrees with the API's `model_size_bytes` field.
#[cfg(feature = "embeddings")]
fn dir_total_size(dir: &std::path::Path) -> u64 {
    fn walk(dir: &std::path::Path, total: &mut u64) {
        let Ok(it) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in it.flatten() {
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if ft.is_dir() {
                walk(&entry.path(), total);
            } else if ft.is_file() {
                if let Ok(meta) = entry.metadata() {
                    *total += meta.len();
                }
            }
        }
    }
    let mut total = 0;
    walk(dir, &mut total);
    total
}

#[cfg(feature = "embeddings")]
fn humanize_bytes(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    let b = bytes as f64;
    if b >= MB {
        format!("{:.1} MB", b / MB)
    } else if b >= KB {
        format!("{:.1} KB", b / KB)
    } else {
        format!("{bytes} B")
    }
}

#[cfg(test)]
mod tests {

    #[test]
    fn embedding_model_registry_json_uses_default_key() {
        let body = serde_json::to_value(chan_workspace::index::config::embedding_models()).unwrap();
        let first = &body.as_array().unwrap()[0];
        assert_eq!(first["id"], "BAAI/bge-small-en-v1.5");
        assert_eq!(first["default"], true);
        assert_eq!(first["dim"], 384);
        assert!(first.get("is_default").is_none());
    }
}
