//! Authenticated reads of the process-owned metrics cache.

use crate::extract::Query;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Default, Deserialize)]
pub(crate) struct MetricsQuery {
    #[serde(default)]
    history: bool,
    since: Option<u64>,
}

pub(crate) async fn api_metrics(
    runtime: Option<Extension<Arc<crate::metrics::Runtime>>>,
    Query(query): Query<MetricsQuery>,
) -> Response {
    match runtime {
        Some(Extension(runtime)) => Json(runtime.view(query.history, query.since)).into_response(),
        None => crate::error::err(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "metrics unavailable".into(),
        ),
    }
}
