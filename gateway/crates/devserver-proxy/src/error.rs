use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("not found")]
    NotFound,

    #[error("upstream error: {0}")]
    Upstream(String),

    #[error(transparent)]
    Anyhow(#[from] anyhow::Error),
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            Error::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
            // Upstream detail (hyper / yamux message) stays in the
            // server log; the public body is intentionally fixed so a probe
            // cannot enumerate failure modes by reading the response.
            Error::Upstream(detail) => {
                tracing::warn!(detail = %detail, "upstream error");
                (StatusCode::BAD_GATEWAY, "upstream unreachable".to_string())
            }
            Error::Anyhow(e) => {
                tracing::error!(error = ?e, "internal error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal error".to_string(),
                )
            }
        };
        (status, Json(json!({"error": message}))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;

    use super::*;

    async fn status_and_body(error: Error) -> (StatusCode, Bytes) {
        let response = error.into_response();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .expect("body");
        (status, body)
    }

    #[tokio::test]
    async fn each_variant_maps_to_a_fixed_status_and_body() {
        let (status, body) = status_and_body(Error::NotFound).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body.as_ref(), br#"{"error":"not found"}"#);

        let (status, body) = status_and_body(Error::Upstream("x".into())).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(body.as_ref(), br#"{"error":"upstream unreachable"}"#);

        let (status, body) = status_and_body(Error::Anyhow(anyhow::anyhow!("x"))).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body.as_ref(), br#"{"error":"internal error"}"#);
    }
}
