//! Contact routes:
//!
//!   POST /api/contacts/import : multipart import of a contact CSV.
//!   GET  /api/contacts        : list (and filter) contact notes.
//!
//! The list route powers the editor `@` picker: caller passes an
//! optional `?q=` substring; we case-insensitive-match against
//! display title, basename, and the joined email column inside
//! SQLite (so a typed `alice` finds `alice@example.com` even when
//! the contact's display name has nothing to do with the address),
//! cap at `?limit=` (default 10), and return workspace-relative paths,
//! display labels, and the contact's email list. The wiki-link the
//! picker inserts is what re-resolves to the same Contact node on
//! the next graph pass, so the round-trip stays consistent.
//!
//! Wraps `Workspace::import_contacts`. The frontend wizard (and the
//! `chan contacts import csv` CLI for parity) sends:
//!
//!   file       multipart   the CSV bytes
//!   dest_dir   text        workspace-relative directory (created if absent;
//!                          empty string writes at the workspace root)
//!   provider   text        "google" today; flag is forward-compat
//!   overwrite  text        "true" / "false" (default false)
//!
//! Response shape:
//!   {
//!     "wrote":     ["Contacts/Jane Doe.md", ...],
//!     "overwrote": [...],
//!     "skipped":   [{"path": "...", "reason": "exists"}, ...],
//!     "failed":    [{"name": "...", "reason": "..."}, ...],
//!     "warnings":  ["ignoring unknown multipart field `foo`", ...]
//!   }
//!
//! Per-file errors do not fail the request: a single bad slug
//! lands as `failed` and the rest of the batch goes through.
//! Setup-level failures (parse error, dest_dir creation refused
//! by the path sandbox) return 400. `warnings` carries non-fatal
//! issues the route detected while parsing the request, e.g.,
//! unknown multipart parts the route doesn't consume; clients
//! (the wizard, the CLI) surface them so a typo in a field name
//! doesn't fail silently.

use std::sync::Arc;

use axum::extract::{Multipart, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use chan_workspace::contacts::{
    google::parse_google_csv, ImportOpts, ImportOutcome, ImportSummary, ProviderKind,
};

use crate::error::{err, err_from, err_state};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct ContactsListQuery {
    /// Case-insensitive substring filter on display title + basename.
    /// Empty / absent returns the full alphabetical list, capped by
    /// `limit`.
    #[serde(default)]
    pub q: Option<String>,
    /// Result cap. The picker is fine with 10 by default; bump for
    /// power-user / debug callers.
    #[serde(default = "default_limit")]
    pub limit: usize,
}

fn default_limit() -> usize {
    10
}

pub async fn api_get_contacts(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ContactsListQuery>,
) -> Response {
    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    let needle = q.q;
    match tokio::task::spawn_blocking(move || {
        let needle = needle.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let rows = match workspace.contacts_filtered(needle, q.limit) {
            Ok(v) => v,
            Err(e) => return err_from(&e),
        };
        let out: Vec<serde_json::Value> = rows
            .into_iter()
            .map(|c| {
                // Picker rows show the title primarily; basename is the
                // fallback when the imported file has no `# H1` (rare,
                // but possible if the user edited the markdown). Emails
                // ride along so the picker can render the first one as a
                // secondary line and so the caller can confirm an
                // email-substring match. Aliases ride along so the picker
                // can show `@@<alias>` shortcuts and so the editor's
                // `@@` trigger can pick the alias to insert.
                let label = c.title.unwrap_or(c.basename);
                serde_json::json!({
                    "path": c.rel_path,
                    "label": label,
                    "emails": c.emails,
                    "aliases": c.aliases,
                })
            })
            .collect();
        Json(out).into_response()
    })
    .await
    {
        Ok(response) => response,
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("contacts list task panicked: {e}"),
        )
            .into_response(),
    }
}

pub async fn api_post_contacts_import(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Response {
    let mut csv_bytes: Option<Vec<u8>> = None;
    let mut dest_dir: Option<String> = None;
    let mut provider: Option<String> = None;
    let mut overwrite = false;
    // Track parts the route doesn't consume so the caller (CLI, UI)
    // can flag them. Silently dropping unknown fields hides client
    // bugs (typos like `dest-dir` for `dest_dir`, future schema drift
    // a stale chan binary doesn't recognize). We don't fail the
    // request: the import still succeeds with what we did parse.
    let mut warnings: Vec<String> = Vec::new();

    loop {
        match multipart.next_field().await {
            Ok(Some(field)) => {
                let name = field.name().unwrap_or("").to_owned();
                match name.as_str() {
                    "file" => {
                        if csv_bytes.is_some() {
                            warnings
                                .push("multiple `file` parts in request; using the first".into());
                            // Drain the duplicate so the next loop
                            // iteration sees the next field.
                            let _ = field.bytes().await;
                            continue;
                        }
                        match field.bytes().await {
                            Ok(b) => csv_bytes = Some(b.to_vec()),
                            Err(e) => {
                                return err(
                                    StatusCode::BAD_REQUEST,
                                    format!("multipart read: {e}"),
                                );
                            }
                        }
                    }
                    "dest_dir" => match field.text().await {
                        Ok(s) => dest_dir = Some(s),
                        Err(e) => {
                            return err(StatusCode::BAD_REQUEST, format!("multipart read: {e}"));
                        }
                    },
                    "provider" => match field.text().await {
                        Ok(s) => provider = Some(s),
                        Err(e) => {
                            return err(StatusCode::BAD_REQUEST, format!("multipart read: {e}"));
                        }
                    },
                    "overwrite" => match field.text().await {
                        Ok(s) => {
                            // Tolerant parse: anything that isn't a
                            // recognized truthy string is false. The
                            // wizard sends "true"/"false"; curl users
                            // sending "1" / "yes" should also work.
                            let s = s.trim().to_ascii_lowercase();
                            overwrite = matches!(s.as_str(), "true" | "1" | "yes" | "on");
                        }
                        Err(e) => {
                            return err(StatusCode::BAD_REQUEST, format!("multipart read: {e}"));
                        }
                    },
                    other => {
                        // Unknown / unexpected part. Drain its body
                        // to keep the multipart parser advancing,
                        // record it, and move on.
                        let label = if other.is_empty() {
                            "<unnamed part>".to_string()
                        } else {
                            other.to_string()
                        };
                        let _ = field.bytes().await;
                        warnings.push(format!("ignoring unknown multipart field `{label}`"));
                    }
                }
            }
            Ok(None) => break,
            Err(e) => return err(StatusCode::BAD_REQUEST, format!("multipart parse: {e}")),
        }
    }

    let Some(bytes) = csv_bytes else {
        return err(
            StatusCode::BAD_REQUEST,
            "missing `file` part in multipart body".into(),
        );
    };
    let Some(dest_dir) = dest_dir else {
        return err(
            StatusCode::BAD_REQUEST,
            "missing `dest_dir` part in multipart body".into(),
        );
    };

    let provider_str = provider.unwrap_or_else(|| "google".into());
    let prov = match ProviderKind::parse(&provider_str) {
        Some(p) => p,
        None => {
            return err(
                StatusCode::BAD_REQUEST,
                format!("unknown provider: {provider_str}"),
            );
        }
    };
    if prov != ProviderKind::Google {
        return err(
            StatusCode::BAD_REQUEST,
            "only provider=google is supported today".into(),
        );
    }

    let workspace = match state.try_workspace() {
        Ok(workspace) => workspace,
        Err(error) => return err_state(&error),
    };
    let import_workspace = workspace.clone();
    let self_writes = Arc::clone(&state.self_writes);
    let summary =
        match tokio::task::spawn_blocking(move || -> Result<ImportSummary, Box<Response>> {
            let contacts = match parse_google_csv(bytes.as_slice()) {
                Ok(v) => v,
                Err(e) => {
                    return Err(Box::new(err(
                        StatusCode::BAD_REQUEST,
                        format!("csv parse: {e}"),
                    )))
                }
            };
            let summary = import_workspace
                .import_contacts(&dest_dir, contacts, ImportOpts { overwrite })
                .map_err(|e| Box::new(err_from(&e)))?;
            // Note our own writes inside the task, before the await
            // returns, so the import flood is suppressed without the
            // post-await race (see files.rs::api_write_file).
            for o in &summary.outcomes {
                if let ImportOutcome::Wrote { path } | ImportOutcome::Overwrote { path } = o {
                    self_writes.note(path);
                }
            }
            Ok(summary)
        })
        .await
        {
            Ok(Ok(summary)) => summary,
            Ok(Err(response)) => return *response,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("contacts import task panicked: {e}"),
                )
                    .into_response()
            }
        };

    // Collect imported paths for an immediate index pass; without the
    // inline index call the watcher's 1 s debounce leaves a visible lag
    // between import and the contact showing up in the @ picker. Self-
    // write suppression already happened inside the import task above.
    let mut to_index: Vec<String> = Vec::new();
    for o in &summary.outcomes {
        if let ImportOutcome::Wrote { path } | ImportOutcome::Overwrote { path } = o {
            to_index.push(path.clone());
        }
    }
    if !to_index.is_empty() {
        let _ = tokio::task::spawn_blocking(move || {
            for p in &to_index {
                if let Err(e) = workspace.index_file(p) {
                    tracing::warn!(path = %p, error = %e, "contacts: post-import index_file failed");
                }
            }
        })
        .await;
    }

    let mut wrote = Vec::new();
    let mut overwrote = Vec::new();
    let mut skipped = Vec::new();
    let mut failed = Vec::new();
    for o in summary.outcomes {
        match o {
            ImportOutcome::Wrote { path } => wrote.push(path),
            ImportOutcome::Overwrote { path } => overwrote.push(path),
            ImportOutcome::Skipped { path, reason } => {
                skipped.push(serde_json::json!({ "path": path, "reason": reason }));
            }
            ImportOutcome::Failed { name, reason } => {
                failed.push(serde_json::json!({ "name": name, "reason": reason }));
            }
        }
    }

    Json(serde_json::json!({
        "wrote": wrote,
        "overwrote": overwrote,
        "skipped": skipped,
        "failed": failed,
        // `warnings` is always present (never omitted) so the
        // frontend / CLI can render it without a presence check. It
        // stays empty when nothing unexpected showed up in the
        // request.
        "warnings": warnings,
    }))
    .into_response()
}
