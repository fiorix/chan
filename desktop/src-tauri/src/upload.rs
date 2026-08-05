//! Desktop-native streamed uploads.
//!
//! The native picker returns paths only inside Rust. Each selected regular file
//! becomes a streaming reqwest multipart part, so neither file paths nor bytes
//! cross webview IPC. The invoking origin, destination path, cookies, CSRF
//! mirror, redirects, cancellation, and aggregate progress are validated here.

use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Bytes;
#[cfg(test)]
use futures::TryStreamExt;
use futures::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, WebviewWindow};
use tokio::io::AsyncReadExt;

use crate::native_transfer::{
    endpoint_for_window, fetch_transfer_cap, http_client, request_headers, EndpointKind,
    TransferCap, TransferProgress, TransferRegistration,
};

#[derive(Debug, Deserialize)]
pub struct NativeUploadTarget {
    dir: Option<String>,
    path: Option<String>,
    #[serde(default)]
    multiple: bool,
}

impl NativeUploadTarget {
    fn validate(&self) -> Result<(), String> {
        match (&self.dir, &self.path) {
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

#[tauri::command]
pub async fn upload_files_native(
    app: AppHandle,
    window: WebviewWindow,
    transfer_id: String,
    url: String,
    target: NativeUploadTarget,
) -> Result<Vec<UploadedFile>, String> {
    target.validate()?;
    let endpoint = endpoint_for_window(&window, &url, EndpointKind::Upload)?;
    let headers = request_headers(&window, &endpoint, true)?;
    let registration = TransferRegistration::new(transfer_id, None)?;
    let paths = tokio::select! {
        _ = registration.progress.cancelled() => return Err("upload cancelled".into()),
        paths = pick_upload_paths(app, target.multiple) => paths?,
    };
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    if registration.progress.is_cancelled() {
        return Err("upload cancelled".into());
    }
    let files = validate_picked_files(paths).await?;
    let total = files
        .iter()
        .try_fold(0u64, |sum, file| sum.checked_add(file.size))
        .ok_or_else(|| "native upload byte count overflow".to_string())?;
    registration.progress.set_total(Some(total));

    let client = http_client()?;
    // Preflight before the first POST, so an over-cap selection sends no bytes
    // and leaves no partial write on the server. Both the batch and each file
    // are checked: the route enforces per request, so a selection that only
    // exceeds the ceiling in aggregate must still be refused here rather than
    // uploading the files that individually fit and failing partway.
    let cap = fetch_transfer_cap(&client, &endpoint, headers.clone()).await;
    cap.check(total)?;
    for file in &files {
        cap.check(file.size)?;
    }
    let mut uploaded = Vec::with_capacity(files.len());
    for file in files {
        if registration.progress.is_cancelled() {
            return Err("upload cancelled".into());
        }
        let opened = tokio::fs::File::open(&file.path)
            .await
            .map_err(|error| format!("opening {}: {error}", file.path.display()))?;
        let body = reqwest::Body::wrap_stream(file_stream(
            opened,
            Arc::clone(&registration.progress),
            cap,
        ));
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
            .post(endpoint.clone())
            .headers(headers.clone())
            .multipart(form)
            .send();
        let response = tokio::select! {
            _ = registration.progress.cancelled() => return Err("upload cancelled".into()),
            response = request => response,
        };
        let response = match response {
            Ok(response) => response,
            Err(_error) if registration.progress.is_cancelled() => {
                return Err("upload cancelled".into());
            }
            Err(error) => return Err(format!("upload request failed: {error}")),
        };
        if response.status().is_redirection() {
            return Err("upload refused an unexpected redirect".into());
        }
        if !response.status().is_success() {
            return Err(response_error(response).await);
        }
        uploaded.push(
            response
                .json::<UploadedFile>()
                .await
                .map_err(|error| format!("decoding upload response: {error}"))?,
        );
    }
    Ok(uploaded)
}

struct PickedFile {
    path: PathBuf,
    name: String,
    size: u64,
}

async fn validate_picked_files(paths: Vec<PathBuf>) -> Result<Vec<PickedFile>, String> {
    tokio::task::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|path| {
                let metadata = std::fs::symlink_metadata(&path)
                    .map_err(|error| format!("stat {}: {error}", path.display()))?;
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(format!(
                        "native upload accepts regular files only: {}",
                        path.display()
                    ));
                }
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or_else(|| {
                        format!("picked path has no UTF-8 file name: {}", path.display())
                    })?
                    .to_string();
                if matches!(name.as_str(), "" | "." | "..") || name.chars().any(char::is_control) {
                    return Err(format!("picked file name is not allowed: {name:?}"));
                }
                Ok(PickedFile {
                    path,
                    name,
                    size: metadata.len(),
                })
            })
            .collect()
    })
    .await
    .map_err(|error| format!("validating native upload selection: {error}"))?
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

fn validate_workspace_rel(path: &str, allow_empty: bool) -> Result<(), String> {
    if path.is_empty() {
        return if allow_empty {
            Ok(())
        } else {
            Err("native upload target path is empty".into())
        };
    }
    if path.starts_with('/')
        || path.starts_with('\\')
        || path.contains('\\')
        || path.split('/').any(|part| {
            part.is_empty() || matches!(part, "." | "..") || part.chars().any(char::is_control)
        })
    {
        return Err("native upload target must be a workspace-relative path".into());
    }
    if path == ".chan" || path.starts_with(".chan/") {
        return Err("native upload target cannot enter workspace internals".into());
    }
    Ok(())
}

async fn response_error(response: reqwest::Response) -> String {
    let status = response.status();
    let mut detail = Vec::new();
    let mut stream = response.bytes_stream();
    while detail.len() < 512 {
        let Some(next) = stream.next().await else {
            break;
        };
        let Ok(bytes) = next else {
            break;
        };
        let remaining = 512 - detail.len();
        detail.extend_from_slice(&bytes[..bytes.len().min(remaining)]);
    }
    let detail = String::from_utf8_lossy(&detail);
    if detail.trim().is_empty() {
        format!("upload failed: HTTP {status}")
    } else {
        format!("upload failed: HTTP {status}: {}", detail.trim())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    }

    #[test]
    fn upload_destination_validation_is_workspace_relative() {
        for accepted in ["", "notes", "notes/images"] {
            assert!(validate_workspace_rel(accepted, true).is_ok(), "{accepted}");
        }
        for rejected in [
            "/tmp",
            "../tmp",
            "a/../b",
            "a//b",
            ".chan",
            ".chan/state",
            r"a\b",
        ] {
            assert!(
                validate_workspace_rel(rejected, true).is_err(),
                "{rejected}"
            );
        }
        assert!(validate_workspace_rel("", false).is_err());
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
