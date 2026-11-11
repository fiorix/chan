//! Desktop-native streamed uploads.
//!
//! The native picker returns paths only inside Rust. Each selected regular file
//! becomes a streaming reqwest multipart part, so neither file paths nor bytes
//! cross webview IPC, and an error names a picked file by its base name. The
//! page is told what to call the selection, the first file's base name and the
//! file count, through the transfer's status, and, when the page asks for it,
//! with the reason of a failure. The invoking origin, destination path,
//! cookies, CSRF mirror, redirects, cancellation, and aggregate progress are
//! validated here.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Bytes;
#[cfg(test)]
use futures::TryStreamExt;
use futures::{stream, StreamExt};
use reqwest::header::HeaderMap;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, WebviewWindow};
use tokio::io::AsyncReadExt;

use crate::native_transfer::{
    endpoint_for_window, fetch_transfer_cap, http_client, reason_without_url, request_headers,
    EndpointKind, PickedFiles, TransferCap, TransferProgress, TransferRegistration,
    ValidatedEndpoint,
};

#[derive(Debug, Deserialize)]
pub struct NativeUploadTarget {
    dir: Option<String>,
    path: Option<String>,
    #[serde(default)]
    multiple: bool,
    /// `"filesystem"` for a standalone window's uid-scoped transfer lane,
    /// where the destination is an absolute path (leading `/` stripped on
    /// unix, a drive-qualified `C:\...` on Windows); absent for the
    /// workspace lane, where it is workspace-relative.
    #[serde(default)]
    root: Option<String>,
}

impl NativeUploadTarget {
    fn validate(&self) -> Result<(), String> {
        let filesystem = self.root.as_deref() == Some("filesystem");
        match (&self.dir, &self.path) {
            (Some(dir), None) if filesystem => validate_filesystem_target(dir, true),
            (None, Some(path)) if filesystem => validate_filesystem_target(path, false),
            (Some(dir), None) => validate_workspace_rel(dir, true),
            (None, Some(path)) => validate_workspace_rel(path, false),
            _ => Err("native upload requires exactly one destination dir or path".into()),
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct UploadedFile {
    path: String,
    size: u64,
}

/// The reason a cancelled upload answers with. A page older than the named
/// failure reads a cancel by this text alone.
const UPLOAD_CANCELLED: &str = "upload cancelled";

/// How a failed upload answers the page. A page that asks for a named failure
/// is told what was picked with the reason, once the selection is known, so a
/// failure that ends the upload before any status poll read the selection
/// still names its row, and is told a cancel by `cancelled`, which no server
/// reason can set. Any other page is told the bare reason, which is the only
/// answer a page older than the request reads; so is a failure that comes
/// before the transfer is registered.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum UploadFailure {
    Reason(String),
    Named {
        message: String,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        cancelled: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        picked: Option<PickedFiles>,
    },
}

impl From<String> for UploadFailure {
    fn from(reason: String) -> Self {
        Self::Reason(reason)
    }
}

impl UploadFailure {
    /// The answer for an upload that `stopped` after its registration, naming
    /// what `progress` recorded as picked when the page asked for a named
    /// failure.
    fn after_registration(stopped: Stopped, progress: &TransferProgress, named: bool) -> Self {
        let (message, cancelled) = match stopped {
            Stopped::Cancelled => (UPLOAD_CANCELLED.to_string(), true),
            Stopped::Failed(reason) => (reason, false),
        };
        if named {
            Self::Named {
                message,
                cancelled,
                picked: progress.picked(),
            }
        } else {
            Self::Reason(message)
        }
    }
}

/// Why a registered upload ended without its files: the page cancelled it, or
/// it failed for a reason. Only the cancel arms produce `Cancelled`, so a
/// reason that happens to say "upload cancelled" stays a failure.
#[derive(Debug, PartialEq, Eq)]
enum Stopped {
    Cancelled,
    Failed(String),
}

impl From<String> for Stopped {
    fn from(reason: String) -> Self {
        Self::Failed(reason)
    }
}

/// `named_failure` is the page asking for a failure as [`UploadFailure::Named`];
/// a page that does not send it is answered with the bare reason.
#[tauri::command]
pub async fn upload_files_native(
    app: AppHandle,
    window: WebviewWindow,
    transfer_id: String,
    url: String,
    target: NativeUploadTarget,
    named_failure: Option<bool>,
) -> Result<Vec<UploadedFile>, UploadFailure> {
    target.validate()?;
    let endpoint = endpoint_for_window(&window, &url, EndpointKind::Upload)?;
    let headers = request_headers(&window, endpoint.url(), true)?;
    let registration = TransferRegistration::new(transfer_id, None)?;
    upload_picked(app, &target, &endpoint, headers, &registration.progress)
        .await
        .map_err(|stopped| {
            UploadFailure::after_registration(
                stopped,
                &registration.progress,
                named_failure == Some(true),
            )
        })
}

/// Raise the picker and upload what it returns, reporting through
/// `progress`. An empty answer is a picker closed without a choice.
///
/// The page offers no Cancel while the picker is open, since nothing here can
/// close a native dialog; a cancel that comes then anyway, from the page's
/// own teardown, ends the upload at once.
async fn upload_picked(
    app: AppHandle,
    target: &NativeUploadTarget,
    endpoint: &ValidatedEndpoint,
    headers: HeaderMap,
    progress: &Arc<TransferProgress>,
) -> Result<Vec<UploadedFile>, Stopped> {
    let paths = tokio::select! {
        _ = progress.cancelled() => return Err(Stopped::Cancelled),
        paths = pick_upload_paths(app, target.multiple) => paths?,
    };
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    if progress.is_cancelled() {
        return Err(Stopped::Cancelled);
    }
    let (files, total) = take_selection(progress, paths).await?;

    let client = http_client()?;
    // Preflight before the first POST, so an over-cap selection sends no bytes
    // and leaves no partial write on the server. Both the batch and each file
    // are checked: the route enforces per request, so a selection that only
    // exceeds the ceiling in aggregate must still be refused here rather than
    // uploading the files that individually fit and failing partway.
    let cap = fetch_transfer_cap(&client, endpoint, headers.clone()).await;
    cap.check(total)?;
    for file in &files {
        cap.check(file.size)?;
    }
    let mut uploaded = Vec::with_capacity(files.len());
    for file in files {
        if progress.is_cancelled() {
            return Err(Stopped::Cancelled);
        }
        let opened = open_picked(&file).await?;
        let body = reqwest::Body::wrap_stream(file_stream(opened, Arc::clone(progress), cap));
        let part = reqwest::multipart::Part::stream_with_length(body, file.size)
            .file_name(file.name.clone())
            .mime_str("application/octet-stream")
            .map_err(|error| format!("building upload part: {error}"))?;
        let form = if let Some(dir) = &target.dir {
            reqwest::multipart::Form::new().text("dir", dir.clone())
        } else {
            reqwest::multipart::Form::new()
                .text("path", target.path.clone().expect("validated replace path"))
        }
        .part("file", part);
        let request = client
            .post(endpoint.url().clone())
            .headers(headers.clone())
            .multipart(form)
            .send();
        let response = tokio::select! {
            _ = progress.cancelled() => return Err(Stopped::Cancelled),
            response = request => response,
        };
        let response = match response {
            Ok(response) => response,
            Err(_error) if progress.is_cancelled() => return Err(Stopped::Cancelled),
            Err(error) => {
                return Err(format!("upload request failed: {}", reason_without_url(error)).into())
            }
        };
        if response.status().is_redirection() {
            return Err(Stopped::Failed(
                "upload refused an unexpected redirect".into(),
            ));
        }
        if !response.status().is_success() {
            return Err(response_error(response, progress).await);
        }
        uploaded.push(
            response.json::<UploadedFile>().await.map_err(|error| {
                format!("decoding upload response: {}", reason_without_url(error))
            })?,
        );
    }
    Ok(uploaded)
}

struct PickedFile {
    path: PathBuf,
    name: String,
    size: u64,
}

/// A picked file's name as the page may read it: the base name, never the
/// directory it was picked in, with anything that is not UTF-8 replaced and
/// control characters escaped. A path with no file name shows its last
/// component.
pub(crate) fn shown_name(path: &Path) -> String {
    let name = path
        .file_name()
        .or_else(|| path.components().next_back().map(|last| last.as_os_str()))
        .unwrap_or_default()
        .to_string_lossy();
    let mut shown = String::with_capacity(name.len());
    for c in name.chars() {
        if c.is_control() {
            shown.extend(c.escape_default());
        } else {
            shown.push(c);
        }
    }
    shown
}

async fn validate_picked_files(paths: Vec<PathBuf>) -> Result<Vec<PickedFile>, String> {
    tokio::task::spawn_blocking(move || paths.into_iter().map(validate_picked_file).collect())
        .await
        .map_err(|error| format!("validating native upload selection: {error}"))?
}

fn validate_picked_file(path: PathBuf) -> Result<PickedFile, String> {
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|error| format!("stat {}: {error}", shown_name(&path)))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "native upload accepts regular files only: {}",
            shown_name(&path)
        ));
    }
    let name = path
        .file_name()
        .ok_or_else(|| "picked path has no file name".to_string())?
        .to_str()
        .ok_or_else(|| format!("picked file name is not UTF-8: {}", shown_name(&path)))?
        .to_string();
    if matches!(name.as_str(), "" | "." | "..") || name.chars().any(char::is_control) {
        return Err(format!("picked file name is not allowed: {name:?}"));
    }
    Ok(PickedFile {
        path,
        name,
        size: metadata.len(),
    })
}

/// Take what the picker returned: record the selection in the transfer's
/// status, validate it, and publish its byte total, answering the files and
/// the total. The status gets the first file's base name with the file count,
/// which is all the page learns of what was picked. The selection is recorded
/// before the validation, so a failure answers what was picked even when the
/// validation refuses a file, and before the total, so a poll that reads a
/// total reads the selection with it.
async fn take_selection(
    progress: &TransferProgress,
    paths: Vec<PathBuf>,
) -> Result<(Vec<PickedFile>, u64), String> {
    if let Some(first) = paths.first() {
        progress.set_picked(&shown_name(first), paths.len());
    }
    let files = validate_picked_files(paths).await?;
    let total = files
        .iter()
        .try_fold(0u64, |sum, file| sum.checked_add(file.size))
        .ok_or_else(|| "native upload byte count overflow".to_string())?;
    progress.set_total(Some(total));
    Ok((files, total))
}

async fn open_picked(file: &PickedFile) -> Result<tokio::fs::File, String> {
    tokio::fs::File::open(&file.path)
        .await
        .map_err(|error| format!("opening {}: {error}", file.name))
}

fn file_stream(
    file: tokio::fs::File,
    progress: Arc<TransferProgress>,
    cap: TransferCap,
) -> impl futures::Stream<Item = std::io::Result<Bytes>> + Send + 'static {
    stream::try_unfold((file, 0u64), move |(mut file, sent)| {
        let progress = Arc::clone(&progress);
        async move {
            if progress.is_cancelled() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "upload cancelled",
                ));
            }
            let mut chunk = vec![0u8; 64 * 1024];
            let count = file.read(&mut chunk).await?;
            if count == 0 {
                return Ok(None);
            }
            // Backstop on the bytes actually read: the preflight measured the
            // file at stat time, and a file that grows between stat and send
            // would otherwise stream past the ceiling under a declared length
            // that no longer describes it.
            let sent = sent
                .checked_add(count as u64)
                .ok_or_else(|| std::io::Error::other("native upload byte count overflow"))?;
            cap.check(sent).map_err(std::io::Error::other)?;
            chunk.truncate(count);
            progress.add_loaded(count as u64);
            Ok(Some((Bytes::from(chunk), (file, sent))))
        }
    })
}

async fn pick_upload_paths(app: AppHandle, multiple: bool) -> Result<Vec<PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (sender, receiver) = tokio::sync::oneshot::channel();
    let app_for_dialog = app.clone();
    app.run_on_main_thread(move || {
        let picker = app_for_dialog.dialog().file();
        if multiple {
            picker.pick_files(move |chosen| {
                let paths = chosen
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|path| path.into_path().ok())
                    .collect();
                let _ = sender.send(paths);
            });
        } else {
            picker.pick_file(move |chosen| {
                let paths = chosen
                    .and_then(|path| path.into_path().ok())
                    .into_iter()
                    .collect();
                let _ = sender.send(paths);
            });
        }
    })
    .map_err(|error| format!("scheduling native upload picker: {error}"))?;
    receiver
        .await
        .map_err(|error| format!("native upload picker was dropped: {error}"))
}

/// The filesystem-root lane: the control socket already normalized `.` and
/// `..` away, so any that remain are a forged target, as is a control
/// character. Backslashes and a drive prefix are what a Windows path is made
/// of: a `\` separates components here, where the workspace rule reads it
/// as part of a name.
fn validate_filesystem_target(path: &str, allow_empty: bool) -> Result<(), String> {
    if path.is_empty() {
        return if allow_empty {
            Ok(())
        } else {
            Err("native upload target path is empty".into())
        };
    }
    if path
        .split(['/', '\\'])
        .any(|part| matches!(part, "." | "..") || part.chars().any(char::is_control))
    {
        return Err("native upload target must be a normalized filesystem path".into());
    }
    Ok(())
}

/// The workspace lane: the target is the server's text for a path under the
/// workspace root, whose components `/` joins on every platform, so it is
/// split there and a `\` stays in the name it is part of, as in a directory
/// the server lists as `x\y`. Only what the server refuses of that text is
/// refused, for its reason: a `..` component, which would leave the root, and a
/// file's path that names nothing. A leading or doubled `/` and a `.`
/// component the server reads past, and whatever else a target holds the
/// server answers itself, against the workspace.
fn validate_workspace_rel(path: &str, allow_empty: bool) -> Result<(), String> {
    let mut names = false;
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err("native upload target escapes the workspace root".into()),
            _ => names = true,
        }
    }
    if names || allow_empty {
        Ok(())
    } else {
        Err("native upload target path is empty".into())
    }
}

/// Why the server refused an upload request. The reason carries no "upload
/// failed" of its own, since the page's status line and transfer row each say
/// that the upload failed.
async fn response_error(response: reqwest::Response, progress: &TransferProgress) -> Stopped {
    let status = response.status();
    let mut body = Vec::new();
    const REFUSAL_BODY_LIMIT: usize = 64 * 1024;
    let mut stream = response.bytes_stream();
    let mut complete = true;
    loop {
        let chunk = tokio::select! {
            biased;
            _ = progress.cancelled() => return Stopped::Cancelled,
            chunk = stream.next() => chunk,
        };
        let bytes = match chunk {
            Some(Ok(bytes)) => bytes,
            Some(Err(_)) => {
                complete = false;
                break;
            }
            None => break,
        };
        let remaining = REFUSAL_BODY_LIMIT - body.len();
        body.extend_from_slice(&bytes[..bytes.len().min(remaining)]);
        if bytes.len() > remaining {
            complete = false;
            break;
        }
    }
    // Only a complete body within the bound can supply an envelope sentence.
    let detail = String::from_utf8_lossy(&body[..body.len().min(512)]);
    let fallback = if detail.trim().is_empty() {
        format!("HTTP {status}")
    } else {
        format!("HTTP {status}: {}", detail.trim())
    };
    Stopped::Failed(if complete {
        crate::devserver::refusal_message(status, &String::from_utf8_lossy(&body), &fallback)
    } else {
        fallback
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn transfer_error_body_limit_preserves_whole_envelopes() {
        let empty = r#"{"error":"try again","padding":""}"#;
        for size in [64 * 1024, 64 * 1024 + 1] {
            let body = format!(
                r#"{{"error":"try again","padding":"{}"}}"#,
                "x".repeat(size - empty.len())
            );
            assert_eq!(body.len(), size);
            let expected = if size == 64 * 1024 {
                "try again".to_string()
            } else {
                body[..512].to_string()
            };
            let response = reqwest::Response::from(
                axum::http::Response::builder()
                    .status(503)
                    .body(body)
                    .unwrap(),
            );
            assert_eq!(response_error(response, &TransferProgress::new_for_test(None)).await, Stopped::Failed(format!("HTTP 503 Service Unavailable: {expected}")), "a refusal within 64 KiB is parsed whole; an oversized refusal keeps its plain-body excerpt");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn cancelling_a_transfer_leaves_an_unfinished_refusal_body() {
        let id = "upload-refusal-cancel".to_string();
        let registration = TransferRegistration::new(id.clone(), None).unwrap();
        let stream = futures::stream::pending::<Result<Vec<u8>, std::io::Error>>();
        let response = reqwest::Response::from(
            axum::http::Response::builder()
                .status(503)
                .body(reqwest::Body::wrap_stream(stream))
                .unwrap(),
        );
        let mut reading = Box::pin(response_error(response, &registration.progress));
        assert!(
            futures::poll!(&mut reading).is_pending(),
            "the refusal body is still being read"
        );
        assert!(crate::native_transfer::cancel_native_transfer(id));
        assert!(registration.progress.is_cancelled());
        let stopped = tokio::time::timeout(std::time::Duration::from_secs(1), reading)
            .await
            .expect("cancellation must interrupt an unfinished refusal body");
        assert_eq!(stopped, Stopped::Cancelled);
    }

    #[tokio::test]
    async fn transfer_errors_show_refusal_sentences() {
        let padded = format!(r#"{{"padding":"{}","error":"try again"}}"#, "x".repeat(600));
        for (body, detail) in [
            (" plain refusal ".to_string(), ": plain refusal".to_string()),
            (String::new(), String::new()),
            (
                r#"{"error":"try again","code":"starting"}"#.to_string(),
                ": try again".to_string(),
            ),
            (padded, ": try again".to_string()),
            ("x".repeat(600), format!(": {}", "x".repeat(512))),
        ] {
            let response = reqwest::Response::from(
                axum::http::Response::builder()
                    .status(503)
                    .body(body)
                    .unwrap(),
            );
            assert_eq!(
                response_error(response, &TransferProgress::new_for_test(None)).await,
                Stopped::Failed(format!("HTTP 503 Service Unavailable{detail}")),
                "transfers must show the sentence and preserve plain-body excerpts, with no prefix the page adds again",
            );
        }
    }

    #[test]
    fn desktop_upload_never_reads_or_returns_whole_file_bytes() {
        let rust = include_str!("upload.rs");
        let production = rust
            .split("#[cfg(test)]")
            .next()
            .expect("production upload module");
        let web = include_str!("../../../web/packages/workspace-app/src/api/desktop.ts");
        assert!(!production.contains("std::fs::read(&path)"));
        assert!(!production.contains("PickedUploadFile"));
        assert!(!web.contains("new Uint8Array(f.bytes)"));
        // The SPA tells the desktop which lane a target belongs to, so a
        // filesystem target is held to the filesystem rule.
        assert!(web.contains(r#"target: root === "filesystem" ? { ...target, root } : target,"#));
    }

    #[test]
    fn filesystem_targets_accept_absolute_paths_and_refuse_dot_components() {
        for accepted in [
            "",
            "home/u/proj",
            r"C:\Users\me\proj",
            r"C:\",
            r"\\server\share\dir",
        ] {
            assert!(
                validate_filesystem_target(accepted, true).is_ok(),
                "{accepted}"
            );
        }
        for rejected in ["a/../b", r"C:\x\.\y", "home/u/\u{7}bell"] {
            assert!(
                validate_filesystem_target(rejected, true).is_err(),
                "{rejected}"
            );
        }
        assert!(validate_filesystem_target("", false).is_err());
        // The lane is chosen by the target's root: the filesystem rule reads
        // a `\` as a separator and refuses the `..` between two, and the
        // workspace rule reads the same text as one name.
        let fs_target: NativeUploadTarget =
            serde_json::from_str(r#"{"dir":"C:\\x\\..\\y","root":"filesystem"}"#).unwrap();
        assert!(fs_target.validate().is_err());
        let ws_target: NativeUploadTarget =
            serde_json::from_str(r#"{"dir":"C:\\x\\..\\y"}"#).unwrap();
        assert_eq!(ws_target.validate(), Ok(()));
    }

    /// A directory whose name holds a `\` is one the server lists, by that
    /// name, so a native upload into it, or over a file in it, is accepted.
    #[test]
    fn a_native_upload_into_a_directory_named_with_a_backslash_is_accepted() {
        let into: NativeUploadTarget = serde_json::from_str(r#"{"dir":"x\\y"}"#).unwrap();
        assert_eq!(into.validate(), Ok(()));
        let over: NativeUploadTarget =
            serde_json::from_str(r#"{"path":"notes/x\\y/a\\b.md"}"#).unwrap();
        assert_eq!(over.validate(), Ok(()));
    }

    /// The workspace rule refuses what the server refuses of a target's
    /// text, each for the server's reason, and leaves the rest for the
    /// server to read against the workspace.
    #[test]
    fn upload_destination_validation_refuses_what_the_server_refuses() {
        for accepted in [
            "",
            "notes",
            "notes/images",
            r"a\b",
            "/tmp",
            "notes/",
            "a//b",
            "a/./b",
            ".chan",
            ".chan/state",
            "a\tb",
        ] {
            assert_eq!(validate_workspace_rel(accepted, true), Ok(()), "{accepted}");
        }
        for escaping in ["..", "../tmp", "a/../b", "a/.."] {
            assert_eq!(
                validate_workspace_rel(escaping, true),
                Err("native upload target escapes the workspace root".into()),
                "{escaping}"
            );
        }
        for unnamed in ["", "/", ".", "./"] {
            assert_eq!(
                validate_workspace_rel(unnamed, false),
                Err("native upload target path is empty".into()),
                "{unnamed}"
            );
        }
    }

    /// The status as the page reads it over IPC.
    fn status_payload(id: &str) -> serde_json::Value {
        serde_json::to_value(
            crate::native_transfer::native_transfer_status(id.into()).expect("a live transfer"),
        )
        .unwrap()
    }

    /// The page learns what was picked from the status alone. A taken
    /// selection puts the first file's base name and the file count there
    /// with the byte total, and nothing of the directory it was picked in.
    #[tokio::test]
    async fn a_taken_selection_reaches_the_status_as_a_base_name_and_a_count() {
        let dir = tempfile::tempdir().unwrap();
        let report = dir.path().join("report.pdf");
        let notes = dir.path().join("notes.md");
        std::fs::write(&report, b"12345").unwrap();
        std::fs::write(&notes, b"12").unwrap();

        let several = TransferRegistration::new("upload-picked-several".into(), None).unwrap();
        assert_eq!(
            status_payload("upload-picked-several"),
            serde_json::json!({ "loaded": 0, "total": null }),
            "nothing is picked while the picker is open"
        );
        let (files, total) = take_selection(&several.progress, vec![report.clone(), notes])
            .await
            .unwrap();
        assert_eq!((files.len(), total), (2, 7));
        assert_eq!(
            status_payload("upload-picked-several"),
            serde_json::json!({
                "loaded": 0,
                "total": 7,
                "picked": { "name": "report.pdf", "count": 2 },
            }),
            "the first file's base name and the count, with no directory"
        );

        let one = TransferRegistration::new("upload-picked-one".into(), None).unwrap();
        let (_, total) = take_selection(&one.progress, vec![report]).await.unwrap();
        assert_eq!(total, 5);
        assert_eq!(
            status_payload("upload-picked-one"),
            serde_json::json!({
                "loaded": 0,
                "total": 5,
                "picked": { "name": "report.pdf", "count": 1 },
            }),
        );
    }

    /// A selection the validation refuses was recorded before it was
    /// validated, so the failure still names what was picked, as the status
    /// would have: the first file's base name and the count, whichever file
    /// was refused. The refusal itself names the refused file.
    #[tokio::test]
    async fn a_selection_the_validation_refuses_still_names_what_was_picked() {
        let dir = tempfile::tempdir().unwrap();
        let report = dir.path().join("report.pdf");
        std::fs::write(&report, b"12345").unwrap();
        let missing = dir.path().join("missing.pdf");

        for (id, paths, refused, picked) in [
            (
                "upload-refused-one",
                vec![missing.clone()],
                "stat missing.pdf: ",
                serde_json::json!({ "name": "missing.pdf", "count": 1 }),
            ),
            (
                "upload-refused-second",
                vec![report.clone(), missing.clone()],
                "stat missing.pdf: ",
                serde_json::json!({ "name": "report.pdf", "count": 2 }),
            ),
        ] {
            let registration = TransferRegistration::new(id.into(), None).unwrap();
            let reason = take_selection(&registration.progress, paths)
                .await
                .err()
                .expect("the validation refuses the missing file");
            assert!(reason.starts_with(refused), "{reason:?}");
            assert_eq!(
                status_payload(id),
                serde_json::json!({ "loaded": 0, "total": null, "picked": picked }),
                "the selection is recorded, and no total for a refused one"
            );
            let answer = serde_json::to_value(UploadFailure::after_registration(
                Stopped::Failed(reason.clone()),
                &registration.progress,
                true,
            ))
            .unwrap();
            assert_eq!(
                answer,
                serde_json::json!({ "message": reason, "picked": picked }),
                "a refused selection's failure names what was picked"
            );
        }
    }

    /// Every error the command answers for a picked file names it by its base
    /// name: the page can be a remote devserver's, and no local path crosses
    /// the webview IPC. Each fixture sits in a temporary directory, whose path
    /// and whose own name the error must not hold.
    #[tokio::test]
    async fn every_error_for_a_picked_file_names_it_by_its_base_name() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_string_lossy().into_owned();
        let folder_name = dir
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let holds_the_directory =
            |error: &str| error.contains(&folder) || error.contains(&folder_name);

        std::fs::create_dir(dir.path().join("photos")).unwrap();
        #[allow(unused_mut)]
        let mut refused = vec![
            (
                dir.path().join("missing.pdf"),
                "stat missing.pdf: ".to_string(),
            ),
            (
                dir.path().join("photos"),
                "native upload accepts regular files only: photos".to_string(),
            ),
        ];
        #[cfg(unix)]
        {
            let link = dir.path().join("link.md");
            std::os::unix::fs::symlink(dir.path().join("missing.pdf"), &link).unwrap();
            refused.push((
                link,
                "native upload accepts regular files only: link.md".to_string(),
            ));
        }
        // Names macOS and Windows filesystems do not store.
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::ffi::OsStrExt;
            let latin1 = dir.path().join(std::ffi::OsStr::from_bytes(b"caf\xe9.txt"));
            std::fs::write(&latin1, b"x").unwrap();
            refused.push((
                latin1,
                "picked file name is not UTF-8: caf\u{FFFD}.txt".to_string(),
            ));
            let newline = dir.path().join("line\nbreak.md");
            std::fs::write(&newline, b"x").unwrap();
            refused.push((
                newline,
                r#"picked file name is not allowed: "line\nbreak.md""#.to_string(),
            ));
        }
        for (path, expected) in refused {
            let error = validate_picked_files(vec![path.clone()])
                .await
                .err()
                .unwrap_or_else(|| panic!("{path:?} is refused"));
            assert!(error.starts_with(&expected), "{error:?} for {path:?}");
            assert!(
                !holds_the_directory(&error),
                "{error:?} names the directory"
            );
        }

        // A file that goes between the validation and the upload's open.
        let gone = dir.path().join("gone.md");
        std::fs::write(&gone, b"x").unwrap();
        let files = validate_picked_files(vec![gone.clone()]).await.unwrap();
        std::fs::remove_file(&gone).unwrap();
        let error = open_picked(&files[0]).await.unwrap_err();
        assert!(error.starts_with("opening gone.md: "), "{error:?}");
        assert!(
            !holds_the_directory(&error),
            "{error:?} names the directory"
        );
    }

    /// A failure answers a page that asked for a named failure with the reason
    /// and what was picked, as the status carries it, and any other page with
    /// the bare reason: the string a page older than the request reads.
    #[test]
    fn a_failure_names_the_selection_only_to_a_page_that_asks() {
        let progress = TransferProgress::new_for_test(None);
        let answer = |named| {
            serde_json::to_value(UploadFailure::after_registration(
                Stopped::Failed("HTTP 409 Conflict".into()),
                &progress,
                named,
            ))
            .unwrap()
        };
        assert_eq!(
            answer(true),
            serde_json::json!({ "message": "HTTP 409 Conflict" }),
            "a failure before the selection is known names nothing"
        );
        progress.set_picked("report.pdf", 3);
        assert_eq!(
            answer(true),
            serde_json::json!({
                "message": "HTTP 409 Conflict",
                "picked": { "name": "report.pdf", "count": 3 },
            }),
            "the base name and the count the status would carry"
        );
        assert_eq!(
            answer(false),
            serde_json::json!("HTTP 409 Conflict"),
            "a page that did not ask reads the bare reason"
        );
        assert_eq!(
            serde_json::to_value(UploadFailure::from(
                "native transfer id is already active".to_string()
            ))
            .unwrap(),
            serde_json::json!("native transfer id is already active"),
            "a failure before the transfer is registered is the bare reason"
        );
    }

    /// A named failure marks the command's own cancel, and nothing else: a
    /// server reason that says "upload cancelled" is still a failure. A page
    /// that did not ask reads the cancel by its reason, as it always has.
    #[test]
    fn a_named_failure_marks_only_the_command_s_own_cancel() {
        let progress = TransferProgress::new_for_test(None);
        let answer = |stopped, named| {
            serde_json::to_value(UploadFailure::after_registration(stopped, &progress, named))
                .unwrap()
        };
        assert_eq!(
            answer(Stopped::Cancelled, true),
            serde_json::json!({ "message": "upload cancelled", "cancelled": true }),
            "a cancel while the picker is open"
        );
        progress.set_picked("report.pdf", 1);
        assert_eq!(
            answer(Stopped::Cancelled, true),
            serde_json::json!({
                "message": "upload cancelled",
                "cancelled": true,
                "picked": { "name": "report.pdf", "count": 1 },
            }),
            "a cancel after the pick names what was picked"
        );
        assert_eq!(
            answer(
                Stopped::Failed("HTTP 409 Conflict: upload cancelled upstream".into()),
                true
            ),
            serde_json::json!({
                "message": "HTTP 409 Conflict: upload cancelled upstream",
                "picked": { "name": "report.pdf", "count": 1 },
            }),
            "a reason that says it is no cancel"
        );
        assert_eq!(
            answer(Stopped::Cancelled, false),
            serde_json::json!("upload cancelled"),
            "the bare reason a page older than the marker reads"
        );
    }

    #[tokio::test]
    async fn file_stream_is_chunked_and_honors_cancellation() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(temp.path(), vec![0x5a; 128 * 1024 + 9]).unwrap();
        let progress = Arc::new(TransferProgress::new_for_test(Some(128 * 1024 + 9)));
        let file = tokio::fs::File::open(temp.path()).await.unwrap();
        let chunks: Vec<Bytes> = file_stream(file, Arc::clone(&progress), TransferCap::Unknown)
            .try_collect()
            .await
            .unwrap();
        assert_eq!(
            chunks.iter().map(Bytes::len).collect::<Vec<_>>(),
            [64 * 1024, 64 * 1024, 9]
        );
        progress.cancel_for_test();
        let file = tokio::fs::File::open(temp.path()).await.unwrap();
        let cancelled_stream = file_stream(file, progress, TransferCap::Unknown);
        futures::pin_mut!(cancelled_stream);
        assert!(
            cancelled_stream.next().await.unwrap().is_err(),
            "cancel stops before the first file chunk"
        );
    }

    /// The upload backstop. The preflight measures a file at stat time, so a
    /// file that grows before it is read would otherwise stream past the
    /// ceiling; the stream stops at the boundary instead of sending it all.
    #[tokio::test]
    async fn native_transfer_cap_stops_the_upload_stream_at_the_ceiling() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(temp.path(), vec![0x5a; 128 * 1024]).unwrap();
        let progress = Arc::new(TransferProgress::new_for_test(Some(128 * 1024)));
        let file = tokio::fs::File::open(temp.path()).await.unwrap();

        // A ceiling inside the second chunk: the first 64 KiB chunk fits, the
        // running total after the second does not.
        let capped = file_stream(
            file,
            Arc::clone(&progress),
            TransferCap::Known(64 * 1024 + 1),
        );
        futures::pin_mut!(capped);
        assert_eq!(capped.next().await.unwrap().unwrap().len(), 64 * 1024);
        let refused = capped
            .next()
            .await
            .unwrap()
            .expect_err("the chunk crossing the ceiling must refuse");
        assert!(refused.to_string().contains("exceeds"), "{refused}");

        // An unknown ceiling enforces nothing, which is the same file streaming
        // to completion rather than a substituted default refusing it.
        let file = tokio::fs::File::open(temp.path()).await.unwrap();
        let uncapped: Vec<Bytes> = file_stream(file, progress, TransferCap::Unknown)
            .try_collect()
            .await
            .unwrap();
        assert_eq!(uncapped.iter().map(Bytes::len).sum::<usize>(), 128 * 1024);
    }
}
