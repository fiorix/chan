//! Source Code Pro download endpoint + the `<user-config>/chan/fonts/`
//! landing dir.
//!
//! Complements the cargo feature `embed-font` and the
//! user-config-dir fallback on `serve_font` with the user-facing
//! piece: the SettingsPanel dropdown fires the
//! `POST /api/fonts/source-code-pro/download` endpoint when the
//! user opts into Source Code Pro on a build that lacks the
//! embedded bundle. The endpoint fetches the woff2 + OFL.txt from
//! Adobe's official GitHub release into `<user-config>/chan/fonts/`;
//! a subsequent `GET /static/fonts/<name>` (via the
//! `serve_font` fallback) returns the bytes verbatim.
//!
//! The download URL is hardcoded to Adobe's `adobe-fonts/source-code-pro`
//! GitHub release. Stable upstream; the same URL has been the
//! canonical Source Code Pro distribution for years. If chan ever
//! needs offline-friendly hosting, the URL is a one-line swap to
//! a chan.app-hosted CDN.

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

/// Files chan ships for Source Code Pro: the variable-axis woff2
/// plus the SIL OFL notice. Both written to
/// `<user-config>/chan/fonts/` on a successful download. Names
/// match the rust-embed bundle
/// (`crates/chan-server/resources/fonts/<name>`) so the
/// `serve_font` handler resolves them identically whether they
/// came from the bundle or the download.
const SOURCE_CODE_PRO_FILES: &[(&str, &str)] = &[
    (
        "SourceCodePro-Regular.otf.woff2",
        "https://github.com/adobe-fonts/source-code-pro/raw/2.038R-ro%2F1.058R-it%2F1.018R-VAR/WOFF2/OTF/SourceCodePro-Regular.otf.woff2",
    ),
    (
        "OFL.txt",
        "https://github.com/adobe-fonts/source-code-pro/raw/2.038R-ro%2F1.058R-it%2F1.018R-VAR/LICENSE.md",
    ),
];

/// Result of a single-file download leg. Surfaced to the IPC
/// response so a partial failure (e.g. woff2 ok, OFL.txt 404s)
/// reports specifically which file is missing.
#[derive(Debug, serde::Serialize)]
pub struct FontDownloadFile {
    pub name: String,
    pub bytes: u64,
}

/// Aggregate response for the download endpoint. Always includes
/// the final target directory so the SPA can surface it in a
/// confirmation toast.
#[derive(Debug, serde::Serialize)]
pub struct FontDownloadResult {
    pub dir: String,
    pub files: Vec<FontDownloadFile>,
}

/// Where chan persists downloaded fonts.
/// `<user-config>/chan/fonts/`. Mirrors the static-assets
/// `chan_fonts_user_dir` helper so the download target and the
/// `serve_font` filesystem-fallback path match exactly.
pub fn chan_fonts_user_dir() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join("chan").join("fonts"))
}

/// `POST /api/fonts/source-code-pro/download`. The response arrives
/// when the download completes (matches `api_semantic_download`'s
/// caller-visible shape).
/// Idempotent -- if the target files already exist + have non-zero
/// size the endpoint short-circuits without re-fetching. Network and
/// filesystem work use async APIs so the route doesn't tie up the
/// Tokio runtime worker while waiting on I/O.
pub async fn api_fonts_source_code_pro_download() -> Response {
    let dir = match chan_fonts_user_dir() {
        Some(d) => d,
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to resolve user-config dir".to_string(),
            )
                .into_response();
        }
    };
    match download_font_files(&dir).await {
        Ok(files) => axum::Json(FontDownloadResult {
            dir: dir.display().to_string(),
            files,
        })
        .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("source code pro download failed: {e}"),
        )
            .into_response(),
    }
}

/// Idempotent fetch of every file in `SOURCE_CODE_PRO_FILES`. Each
/// file is written via a `.partial` tempfile + atomic rename so a
/// crash mid-download doesn't leave a half-file the next launch
/// would happily serve.
async fn download_font_files(dir: &Path) -> io::Result<Vec<FontDownloadFile>> {
    tokio::fs::create_dir_all(dir).await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(io::Error::other)?;
    let mut results = Vec::with_capacity(SOURCE_CODE_PRO_FILES.len());
    for (name, url) in SOURCE_CODE_PRO_FILES {
        let target = dir.join(name);
        if let Ok(meta) = tokio::fs::metadata(&target).await {
            if meta.len() > 1024 {
                // Idempotency: a previous download already
                // produced a non-trivial file; skip the network
                // round-trip + report the existing size.
                results.push(FontDownloadFile {
                    name: (*name).to_string(),
                    bytes: meta.len(),
                });
                continue;
            }
        }
        let resp = client.get(*url).send().await.map_err(io::Error::other)?;
        if !resp.status().is_success() {
            return Err(io::Error::other(format!(
                "fetching {url}: HTTP {}",
                resp.status()
            )));
        }
        let bytes = resp.bytes().await.map_err(io::Error::other)?;
        // Atomic write: stage in `.partial`, fsync optional (rely on
        // rename's atomicity on POSIX + ReplaceFileW on Windows).
        let staging = dir.join(format!("{name}.partial"));
        tokio::fs::write(&staging, &bytes).await?;
        tokio::fs::rename(&staging, &target).await?;
        results.push(FontDownloadFile {
            name: (*name).to_string(),
            bytes: bytes.len() as u64,
        });
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_dir_lives_under_chan_fonts() {
        // The download target + the `serve_font` filesystem
        // fallback must point at the same directory. Pin the path
        // shape so the two helpers can't drift.
        let dir = chan_fonts_user_dir().expect("config dir resolvable in test");
        let s = dir.display().to_string();
        assert!(
            s.ends_with("/chan/fonts") || s.ends_with("\\chan\\fonts"),
            "{s}"
        );
    }

    #[test]
    fn source_code_pro_files_table_carries_woff2_and_ofl() {
        // The bundle ships both the woff2 + the OFL notice; the
        // download must too so a downloaded Source Code Pro
        // satisfies the OFL attribution requirement.
        let names: Vec<&str> = SOURCE_CODE_PRO_FILES.iter().map(|(n, _)| *n).collect();
        assert!(names.contains(&"SourceCodePro-Regular.otf.woff2"));
        assert!(names.contains(&"OFL.txt"));
    }

    #[test]
    fn download_urls_point_at_adobe_github_release() {
        // Catch a future URL drift by pinning the upstream host.
        // Adobe's `adobe-fonts/source-code-pro` repo has been the
        // canonical distribution for years; if it ever moves the
        // explicit pin forces a deliberate update.
        for (_, url) in SOURCE_CODE_PRO_FILES {
            assert!(
                url.contains("github.com/adobe-fonts/source-code-pro"),
                "{url}",
            );
        }
    }
}
