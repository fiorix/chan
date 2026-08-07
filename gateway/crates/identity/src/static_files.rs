//! Embed identity-service's Svelte SPA at compile time and serve it
//! via the shared SPA-fallback handler.
//!
//! `web/dist/` is the output of `npm run build -w @chan/profile` in
//! the repo-root `web/` npm workspace (`make gateway-spa`).
//! On a fresh checkout the directory may not exist yet; the shared
//! handler returns the "frontend not built" banner so developers see
//! a clear next step instead of a blank 404.

use axum::http::{header, HeaderName, HeaderValue, Uri};
use axum::response::Response;

#[derive(rust_embed::Embed)]
#[folder = "web/dist/"]
struct Assets;

const NOT_BUILT_BANNER: &[u8] = b"<!doctype html><meta charset=utf-8><title>identity</title>\
<style>body{font:14px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;\
background:#1c1c1e;color:#e8e8ea;padding:2rem;max-width:640px;margin:0 auto}\
code{background:#2a2a2c;padding:.1em .35em;border-radius:3px}</style>\
<h1>identity-service</h1><p>Frontend bundle is missing. Build it once:\
<pre><code>cd web &amp;&amp; npm install &amp;&amp; npm run build</code></pre>\
<p>Then re-run this binary; the SPA will be embedded.";

const SPA_CSP: &str = "default-src 'self'; img-src 'self' data: https:; \
                       style-src 'self' 'unsafe-inline'; connect-src 'self'; \
                       form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

pub async fn handler(uri: Uri) -> Response {
    let mut response = gateway_common::static_files::serve::<Assets>(uri, NOT_BUILT_BANNER).await;
    let is_html = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/html"));
    if is_html {
        response.headers_mut().insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(SPA_CSP),
        );
        response.headers_mut().insert(
            HeaderName::from_static("x-frame-options"),
            HeaderValue::from_static("DENY"),
        );
    }
    response
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;

    use super::*;

    #[tokio::test]
    async fn html_responses_carry_spa_security_headers() {
        for path in ["/", "/workspaces"] {
            let response = handler(path.parse().unwrap()).await;
            assert_eq!(response.status(), StatusCode::OK, "{path}");
            assert_eq!(
                response
                    .headers()
                    .get(header::CONTENT_SECURITY_POLICY)
                    .expect("HTML response carries CSP")
                    .to_str()
                    .unwrap(),
                "default-src 'self'; img-src 'self' data: https:; \
                 style-src 'self' 'unsafe-inline'; connect-src 'self'; \
                 form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
                "{path}"
            );
            assert_eq!(
                response
                    .headers()
                    .get(HeaderName::from_static("x-frame-options")),
                Some(&HeaderValue::from_static("DENY")),
                "{path}"
            );
        }
    }

    #[tokio::test]
    async fn javascript_asset_keeps_its_mime_without_document_headers() {
        let asset = Assets::iter()
            .find(|path| path.starts_with("assets/") && path.ends_with(".js"))
            .expect("built identity bundle contains JavaScript");
        let response = handler(format!("/{asset}").parse().unwrap()).await;

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE),
            Some(&HeaderValue::from_static("text/javascript"))
        );
        assert!(!response
            .headers()
            .contains_key(header::CONTENT_SECURITY_POLICY));
        assert!(!response
            .headers()
            .contains_key(HeaderName::from_static("x-frame-options")));
    }
}
