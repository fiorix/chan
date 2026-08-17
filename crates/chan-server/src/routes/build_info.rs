//! GET /api/build-info -- compile-time identity for the running binary.

use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

#[derive(Serialize)]
struct BuildInfo {
    version: &'static str,
    /// The running binary's build id, so a reader can tell two builds of one
    /// version apart. Reads `unknown` until a binary declares it, which is the
    /// same fallback `/api/health` serves rather than an empty field.
    build: &'static str,
    features: BuildFeatures,
}

#[derive(Serialize)]
struct BuildFeatures {
    /// Hybrid (BM25 + dense) search depends on the embeddings cargo
    /// feature being on at build time. When false, search falls back
    /// to BM25-only and the Settings "Search" section reflects that.
    /// chan-server itself doesn't gate on this feature; we forward
    /// chan-workspace's compile-time flag as exposed through the
    /// `chan_workspace::has_embeddings` helper.
    embeddings: bool,
}

pub async fn api_build_info() -> Response {
    Json(BuildInfo {
        version: env!("CARGO_PKG_VERSION"),
        build: crate::routes::build_id(),
        features: BuildFeatures {
            // Mirrors chan-workspace's `embeddings` cargo feature. ON in
            // default builds; OFF on platforms where candle won't
            // build (currently iOS), which use `--no-default-features`.
            embeddings: cfg!(feature = "embeddings"),
        },
    })
    .into_response()
}
