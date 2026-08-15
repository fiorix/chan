//! Embedded SPA bundle and the fallback handler that serves it.
//!
//! `WebAssets` bakes `web/dist/` at compile time (release) or reads
//! from disk on each request (debug). The fallback handler returns
//! `index.html` for any path that isn't a baked asset and isn't an
//! `/api`/`/ws` route, so client-side routes work without server-side
//! awareness of them. The SPA shell gets `<meta name="chan-prefix">`
//! and (when set) `<meta name="chan-settings-disabled">` tags
//! injected so the frontend transport layer prepends the prefix to
//! fetch and WebSocket URLs and the Settings entry point can grey
//! itself out.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

use crate::state::AppState;

/// Frontend bundle baked at compile time. The path is relative to
/// this crate's manifest. In debug builds rust-embed reads files
/// from disk on each request (so `npm run build` updates take
/// effect without a cargo rebuild). In release builds the bundle
/// is embedded; build.rs emits cargo:rerun-if-changed for every
/// file under web/dist so a re-bundled frontend triggers a relink.
#[derive(RustEmbed)]
#[folder = "../../web/dist/"]
struct WebAssets;

/// Launcher bundle baked at compile time, mirroring [`WebAssets`] but for
/// `web-launcher/dist/` -- the pure `/api/library/*` HTTP client served at the
/// devserver/library root `/` (the desktop launcher SPA and the gateway's
/// "Open devserver" both reach it through the transparent proxy). Same
/// debug-reads-from-disk / release-embeds behavior as `WebAssets`; build.rs
/// emits rerun-if-changed for the folder so a re-bundled launcher relinks.
#[derive(RustEmbed)]
#[folder = "../../web-launcher/dist/"]
struct LauncherAssets;

const SPA_CACHE_CONTROL: HeaderValue = HeaderValue::from_static("no-store");
const ASSET_CACHE_CONTROL: HeaderValue =
    HeaderValue::from_static("public, max-age=31536000, immutable");
const HOST_VARY: HeaderValue = HeaderValue::from_static("Host");

/// The launcher PWA manifest, served at `/manifest.webmanifest`. Static: the
/// launcher always mounts at the origin root, so `scope` and `start_url` are `/`
/// and every workspace / terminal prefix is a sibling that opens in-app. The
/// icons live in the launcher bundle's `public/` and ride the normal asset path.
/// The workspace-app shell gets NO manifest link (so a single workspace can't be
/// captured as its own app), and there is no service worker anywhere.
const LAUNCHER_MANIFEST: &str = r##"{
  "name": "Chan",
  "short_name": "Chan",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#1c1c1e",
  "theme_color": "#1c1c1e",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ]
}"##;

/// Single-page-app fallback: any path that doesn't match an /api or
/// /ws route, and doesn't correspond to a baked asset, returns
/// index.html so client-side routes work. For unknown /api paths
/// we return a real 404 instead of the SPA shell so callers don't
/// silently get HTML when they expected JSON.
pub async fn serve_static(State(state): State<Arc<AppState>>, uri: axum::http::Uri) -> Response {
    let path = uri.path();
    // Refuse to serve the SPA shell for /api or /ws misses; those
    // are programmatic surfaces, not browser navigation.
    if path.starts_with("/api") || path == "/ws" {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    let candidate = path.trim_start_matches('/');
    let is_index = candidate.is_empty() || candidate == "index.html";
    let candidate = if candidate.is_empty() {
        "index.html"
    } else {
        candidate
    };
    let prefix = match state.prefix.read() {
        Ok(prefix) => prefix.clone(),
        Err(_) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, "prefix lock poisoned").into_response();
        }
    };
    let settings_disabled = state.settings_disabled;
    if let Some(file) = WebAssets::get(candidate) {
        let body = if is_index {
            inject_chan_meta(&file.data, &prefix, settings_disabled)
        } else {
            file.data.into_owned()
        };
        return with_static_cache_headers(
            ([(header::CONTENT_TYPE, content_type_for(candidate))], body).into_response(),
            is_index,
        );
    }
    // SPA fallback: route paths the frontend handles client-side.
    if let Some(file) = WebAssets::get("index.html") {
        let body = inject_chan_meta(&file.data, &prefix, settings_disabled);
        return with_static_cache_headers(
            ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], body).into_response(),
            true,
        );
    }
    // No bundle baked / on disk yet (fresh clone, npm not run).
    (
        StatusCode::NOT_FOUND,
        "frontend bundle not built; run `cd web && npm install && npm run build`",
    )
        .into_response()
}

/// Which launcher surface is being served. The single boot-time discriminator
/// the launcher SPA reads to split its capabilities: whether it may mutate the
/// registry, whether a desktop window bridge is attached, and whether it manages
/// its own windows in the browser. Emitted as `chan-launcher-surface` by
/// [`inject_launcher_meta`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LauncherSurface {
    /// Desktop loopback: registry-mutable AND a native window bridge.
    Desktop,
    /// Local devserver loopback: registry-mutable, no bridge; the browser
    /// manages its own windows (the PWA-leader surface).
    Devserver,
    /// Tunnel-trust devserver / gateway: read-only, no bridge.
    ReadOnly,
}

impl LauncherSurface {
    /// The `chan-launcher-surface` meta value. The value set is the wire
    /// contract the launcher's capability split reads.
    fn meta_value(self) -> &'static str {
        match self {
            LauncherSurface::Desktop => "desktop",
            LauncherSurface::Devserver => "devserver",
            LauncherSurface::ReadOnly => "readonly",
        }
    }
}

/// Single-page-app fallback for the launcher bundle, mirroring
/// [`serve_static`] but for [`LauncherAssets`]. Stateless: the launcher
/// always mounts at the devserver/library root `/`, so there is no
/// per-workspace prefix to inject. The index gets a
/// `<meta name="chan-launcher-surface">` hint so the SPA splits its capabilities
/// without a probe round-trip. `/api`/`/ws` misses still 404
/// rather than returning the SPA shell, so the launcher's `/api/library/*`
/// calls and the reserved namespace get JSON-style 404s.
pub async fn serve_launcher(uri: axum::http::Uri, surface: LauncherSurface) -> Response {
    let path = uri.path();
    if path.starts_with("/api") || path == "/ws" {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    let candidate = path.trim_start_matches('/');
    let is_index = candidate.is_empty() || candidate == "index.html";
    let candidate = if candidate.is_empty() {
        "index.html"
    } else {
        candidate
    };
    // The PWA manifest is generated, not a baked asset: it needs the
    // application/manifest+json type and must skip the immutable one-year cache
    // (unhashed, surface-varying), so serve it with SPA_CACHE_CONTROL like the
    // shell. Intercept before the asset lookup so it never falls through to the
    // SPA fallback (which would answer HTML for it).
    if candidate == "manifest.webmanifest" {
        return with_static_cache_headers(
            (
                [(
                    header::CONTENT_TYPE,
                    content_type_for("manifest.webmanifest"),
                )],
                LAUNCHER_MANIFEST,
            )
                .into_response(),
            true,
        );
    }
    if let Some(file) = LauncherAssets::get(candidate) {
        let body = if is_index {
            inject_launcher_meta(&file.data, surface)
        } else {
            file.data.into_owned()
        };
        return with_static_cache_headers(
            ([(header::CONTENT_TYPE, content_type_for(candidate))], body).into_response(),
            is_index,
        );
    }
    // SPA fallback: client-side routes resolve to index.html.
    if let Some(file) = LauncherAssets::get("index.html") {
        let body = inject_launcher_meta(&file.data, surface);
        return with_static_cache_headers(
            ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], body).into_response(),
            true,
        );
    }
    (
        StatusCode::NOT_FOUND,
        "launcher bundle not built; run `cd web-launcher && npm install && npm run build`",
    )
        .into_response()
}

fn with_static_cache_headers(mut response: Response, spa_shell: bool) -> Response {
    let headers = response.headers_mut();
    headers.insert(
        header::CACHE_CONTROL,
        if spa_shell {
            SPA_CACHE_CONTROL
        } else {
            ASSET_CACHE_CONTROL
        },
    );
    headers.insert(header::VARY, HOST_VARY);
    response
}

/// Inject the SPA's runtime hints as `<meta>` tags right after the
/// opening `<head>` so the frontend can read them synchronously at
/// boot:
///
///   - `<meta name="chan-prefix" content="<prefix>">` when `prefix`
///     is non-empty. The transport layer prepends it to fetch and
///     WebSocket URLs.
///   - `<meta name="chan-settings-disabled" content="1">` when
///     `settings_disabled` is true. Greys out the Settings entry
///     point in the SPA.
///
/// No-op when neither hint applies, or when `<head>` isn't found in
/// the document (returns the original bytes unchanged).
pub fn inject_chan_meta(html: &[u8], prefix: &str, settings_disabled: bool) -> Vec<u8> {
    if prefix.is_empty() && !settings_disabled {
        return html.to_vec();
    }
    let needle = b"<head>";
    let Some(pos) = html.windows(needle.len()).position(|w| w == needle) else {
        return html.to_vec();
    };
    let mut insert = String::new();
    if !prefix.is_empty() {
        // Prefix is canonical (`/seg[/seg...]` with `[A-Za-z0-9-]+`
        // segments) so it cannot contain HTML-attribute-special bytes.
        insert.push_str(&format!("<meta name=\"chan-prefix\" content=\"{prefix}\">"));
    }
    if settings_disabled {
        insert.push_str("<meta name=\"chan-settings-disabled\" content=\"1\">");
    }
    let mut out = Vec::with_capacity(html.len() + insert.len());
    let after_head = pos + needle.len();
    out.extend_from_slice(&html[..after_head]);
    out.extend_from_slice(insert.as_bytes());
    out.extend_from_slice(&html[after_head..]);
    out
}

/// Inject the launcher's runtime hints right after the opening `<head>`:
///
///   - `<meta name="chan-launcher-host-os" content="<family>">` always, so the
///     LOCAL machine card can show the host's OS icon. The value is the OS
///     family enum (`macos | windows | linux | other`), which carries no
///     HTML-attribute-special bytes.
///   - `<meta name="chan-launcher-surface" content="desktop|devserver|readonly">`
///     always, the single descriptor the SPA splits its capabilities on
///     (registry mutation, desktop bridge, self-managed windows).
///   - `<link rel="manifest" href="/manifest.webmanifest">` always, so an
///     installable surface (devserver loopback, https gateway) can be added to
///     the home screen / dock as a PWA.
///
/// No-op when `<head>` is absent (returns the original bytes).
fn inject_launcher_meta(html: &[u8], surface: LauncherSurface) -> Vec<u8> {
    let needle = b"<head>";
    let Some(pos) = html.windows(needle.len()).position(|w| w == needle) else {
        return html.to_vec();
    };
    let (os, _pretty_name) = crate::devserver::detect_os();
    let mut insert = format!("<meta name=\"chan-launcher-host-os\" content=\"{os}\">");
    insert.push_str(&format!(
        "<meta name=\"chan-launcher-surface\" content=\"{}\">",
        surface.meta_value()
    ));
    // The PWA manifest link, on every launcher surface (the coherent install
    // targets are the fixed-port devserver loopback and the https gateway; the
    // ephemeral-port desktop loopback simply won't install coherently, which is
    // harmless). Root-absolute href: the launcher is always at the origin root.
    insert.push_str("<link rel=\"manifest\" href=\"/manifest.webmanifest\">");
    let after_head = pos + needle.len();
    let mut out = Vec::with_capacity(html.len() + insert.len());
    out.extend_from_slice(&html[..after_head]);
    out.extend_from_slice(insert.as_bytes());
    out.extend_from_slice(&html[after_head..]);
    out
}

/// Conservative MIME map for SPA assets and workspace file responses:
/// hashed JS / CSS, source maps, fonts, images, browser-native media, and
/// well-known toplevel files. Falls back to
/// `application/octet-stream` so unknown extensions never get the
/// wrong type assigned.
pub fn content_type_for(path: &str) -> &'static str {
    let ext = match path.rsplit_once('.') {
        Some((_, e)) => e.to_ascii_lowercase(),
        None => return "application/octet-stream",
    };
    match ext.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "wasm" => "application/wasm",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" | "md" => "text/plain; charset=utf-8",
        "webmanifest" => "application/manifest+json",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "aif" | "aiff" => "audio/aiff",
        "ogg" => "audio/ogg",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inject_chan_meta_inserts_prefix_after_head() {
        let html = b"<!doctype html><html><head><title>x</title></head></html>";
        let out = inject_chan_meta(html, "/foo", false);
        let s = std::str::from_utf8(&out).unwrap();
        assert!(s.contains("<head><meta name=\"chan-prefix\" content=\"/foo\"><title>"));
        assert!(!s.contains("chan-settings-disabled"));
    }

    #[test]
    fn inject_chan_meta_inserts_settings_disabled_after_head() {
        let html = b"<head><title>x</title></head>";
        let out = inject_chan_meta(html, "", true);
        let s = std::str::from_utf8(&out).unwrap();
        assert!(s.contains("<head><meta name=\"chan-settings-disabled\" content=\"1\"><title>"));
        assert!(!s.contains("chan-prefix"));
    }

    #[test]
    fn inject_chan_meta_combines_both_tags() {
        let html = b"<head><title>x</title></head>";
        let out = inject_chan_meta(html, "/foo", true);
        let s = std::str::from_utf8(&out).unwrap();
        // Prefix is injected first, settings-disabled second; both
        // sit immediately after the opening <head>.
        assert!(s.contains(
            "<head><meta name=\"chan-prefix\" content=\"/foo\">\
             <meta name=\"chan-settings-disabled\" content=\"1\"><title>"
        ));
    }

    #[test]
    fn inject_chan_meta_noop_when_nothing_set() {
        let html = b"<head></head>";
        let out = inject_chan_meta(html, "", false);
        assert_eq!(out, html);
    }

    #[test]
    fn inject_chan_meta_noop_when_head_missing() {
        let html = b"<html></html>";
        let out = inject_chan_meta(html, "/foo", true);
        assert_eq!(out, html);
    }

    #[test]
    fn inject_launcher_meta_advertises_the_surface_descriptor() {
        let html = b"<head><title>x</title></head>";
        let desktop =
            String::from_utf8(inject_launcher_meta(html, LauncherSurface::Desktop)).unwrap();
        assert!(desktop.contains("<meta name=\"chan-launcher-surface\" content=\"desktop\">"));
        // The host-os meta is always present.
        assert!(desktop.contains("chan-launcher-host-os"));

        let devserver =
            String::from_utf8(inject_launcher_meta(html, LauncherSurface::Devserver)).unwrap();
        assert!(devserver.contains("<meta name=\"chan-launcher-surface\" content=\"devserver\">"));

        let readonly =
            String::from_utf8(inject_launcher_meta(html, LauncherSurface::ReadOnly)).unwrap();
        assert!(readonly.contains("<meta name=\"chan-launcher-surface\" content=\"readonly\">"));

        // Every surface links the PWA manifest.
        assert!(desktop.contains(r#"<link rel="manifest" href="/manifest.webmanifest">"#));
        assert!(devserver.contains(r#"<link rel="manifest" href="/manifest.webmanifest">"#));
        assert!(readonly.contains(r#"<link rel="manifest" href="/manifest.webmanifest">"#));
    }

    #[test]
    fn content_type_for_maps_webmanifest() {
        assert_eq!(
            content_type_for("manifest.webmanifest"),
            "application/manifest+json"
        );
    }

    #[test]
    fn content_type_for_maps_audio_case_insensitively() {
        for (path, expected) in [
            ("TRACK.MP3", "audio/mpeg"),
            ("TRACK.WAV", "audio/wav"),
            ("TRACK.AIF", "audio/aiff"),
            ("TRACK.AIFF", "audio/aiff"),
            ("TRACK.OGG", "audio/ogg"),
        ] {
            assert_eq!(content_type_for(path), expected, "{path}");
        }
    }

    #[tokio::test]
    async fn serve_launcher_serves_the_pwa_manifest() {
        let uri: axum::http::Uri = "/manifest.webmanifest".parse().unwrap();
        let resp = serve_launcher(uri, LauncherSurface::Devserver).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()
                .get(header::CONTENT_TYPE)
                .unwrap()
                .to_str()
                .unwrap(),
            "application/manifest+json"
        );
        // Not the immutable asset cache: the manifest is unhashed + surface-varying.
        assert_eq!(
            resp.headers().get(header::CACHE_CONTROL),
            Some(&SPA_CACHE_CONTROL)
        );
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["scope"], "/");
        assert_eq!(v["start_url"], "/");
        assert_eq!(v["icons"][0]["src"], "/icon-192.png");
        assert_eq!(v["icons"][1]["src"], "/icon-512.png");
    }

    #[test]
    fn static_cache_headers_do_not_store_spa_shell() {
        let response = with_static_cache_headers("ok".into_response(), true);
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL),
            Some(&SPA_CACHE_CONTROL)
        );
        assert_eq!(response.headers().get(header::VARY), Some(&HOST_VARY));
    }

    #[test]
    fn static_cache_headers_allow_immutable_assets() {
        let response = with_static_cache_headers("ok".into_response(), false);
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL),
            Some(&ASSET_CACHE_CONTROL)
        );
        assert_eq!(response.headers().get(header::VARY), Some(&HOST_VARY));
    }

    #[test]
    fn font_content_type_for_woff2() {
        // The terminal's Source Code Pro face rides the SPA bundle as a
        // vite-hashed asset, so it reaches the browser through the same
        // `serve_static` path as every other asset. A wrong content type
        // here is a silently unstyled terminal, not a visible failure.
        assert_eq!(
            content_type_for("SourceCodePro-Regular-D3fa71b2.woff2"),
            "font/woff2"
        );
    }
}
