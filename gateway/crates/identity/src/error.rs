use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use gateway_common::devserver_control_client::DevserverControlError;
use gateway_common::profile_client::ProfileError;
use serde_json::json;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("unauthorized")]
    Unauthorized,

    /// Authenticated but the action is refused (e.g. the account is
    /// blocked). Distinct from Unauthorized so the SPA can render a
    /// "blocked" view instead of bouncing back to sign-in.
    #[error("forbidden: {0}")]
    Forbidden(&'static str),

    #[error("devserver access disabled")]
    DevserverAccessDisabled,

    #[error("devserver access disabled")]
    AdminDevserverAccessDisabled,

    #[error("bad request: {0}")]
    BadRequest(String),

    #[error("not found")]
    NotFound,

    /// 404 for `POST /desktop/v1/devserver/entry` carrying a
    /// machine-readable failure reason so the desktop can narrate the
    /// failure instead of showing a generic string. The reason tokens
    /// are documented next to the handler in `http.rs`. This shape is
    /// safe only on self-scoped surfaces (a PAT-authenticated caller
    /// asking about their own account); the cross-user share-landing
    /// 404s stay uniform on purpose.
    #[error("not found: {reason}")]
    DesktopEntryNotFound {
        reason: &'static str,
        username: String,
        label: Option<String>,
    },

    /// 410 for a consumed or expired one-time artifact (today: the
    /// desktop-authorize redemption code).
    #[error("gone: {0}")]
    Gone(String),

    #[error("conflict: {0}")]
    Conflict(String),

    #[error("upstream error: {0}")]
    Upstream(String),

    #[error("service unavailable: {0}")]
    Unavailable(&'static str),

    #[error(transparent)]
    Anyhow(#[from] anyhow::Error),

    #[error(transparent)]
    Reqwest(#[from] reqwest::Error),

    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

/// Map profile-service client errors onto the local axum error so
/// request handlers can `?` a profile call straight through. Each
/// ProfileError variant has a 1-1 axum response: NotFound -> 404,
/// BadRequest -> 400, Conflict -> 409, Upstream/Reqwest -> 502.
impl From<ProfileError> for Error {
    fn from(e: ProfileError) -> Self {
        match e {
            ProfileError::NotFound => Error::NotFound,
            ProfileError::BadRequest(m) => Error::BadRequest(m),
            ProfileError::Conflict(m) => Error::Conflict(m),
            ProfileError::Upstream(m) => Error::Upstream(m),
            ProfileError::Reqwest(e) => Error::Reqwest(e),
        }
    }
}

/// devserver-control admin failures only surface in the account-delete
/// and token-revoke paths. Map them to Upstream so the caller can decide
/// whether to log-and-continue (every current caller does) or to
/// `?` straight through.
impl From<DevserverControlError> for Error {
    fn from(e: DevserverControlError) -> Self {
        match e {
            DevserverControlError::Upstream(m) => Error::Upstream(m),
            DevserverControlError::Reqwest(e) => Error::Reqwest(e),
        }
    }
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let (status, body) = match &self {
            Error::Unauthorized => (StatusCode::UNAUTHORIZED, error_body("unauthorized")),
            Error::Forbidden(m) => (StatusCode::FORBIDDEN, error_body(m)),
            Error::DevserverAccessDisabled => (
                StatusCode::FORBIDDEN,
                error_body("devserver_access_disabled"),
            ),
            Error::AdminDevserverAccessDisabled => (
                StatusCode::CONFLICT,
                error_body("devserver_access_disabled"),
            ),
            Error::BadRequest(m) => (StatusCode::BAD_REQUEST, error_body(m)),
            Error::NotFound => (StatusCode::NOT_FOUND, error_body("not found")),
            // Superset of the plain {"error": msg} 404 body: a desktop
            // that predates the reason fields keeps reading `error`, a
            // reason-aware one branches on the extras.
            Error::DesktopEntryNotFound {
                reason,
                username,
                label,
            } => {
                let mut body = json!({
                    "error": "not found",
                    "reason": reason,
                    "username": username,
                });
                if let Some(label) = label {
                    body["label"] = json!(label);
                }
                (StatusCode::NOT_FOUND, body)
            }
            Error::Gone(m) => (StatusCode::GONE, error_body(m)),
            Error::Conflict(m) => (StatusCode::CONFLICT, error_body(m)),
            // Upstream detail (oauth2 RequestTokenError, profile-service body,
            // devserver-control admin response) stays in the server log; the public
            // body is fixed so OAuth provider errors and profile SQL fragments
            // do not leak through the 502.
            Error::Upstream(detail) => {
                tracing::warn!(detail = %detail, "upstream error");
                (StatusCode::BAD_GATEWAY, error_body("upstream unreachable"))
            }
            Error::Unavailable(message) => (StatusCode::SERVICE_UNAVAILABLE, error_body(message)),
            Error::Anyhow(e) => {
                tracing::error!(error = ?e, "internal error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    error_body("internal error"),
                )
            }
            Error::Reqwest(e) => {
                tracing::error!(error = ?e, "reqwest error");
                (StatusCode::BAD_GATEWAY, error_body("upstream unreachable"))
            }
            Error::Database(e) => {
                tracing::error!(error = ?e, "database error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    error_body("internal error"),
                )
            }
        };
        (status, Json(body)).into_response()
    }
}

fn error_body(message: &str) -> serde_json::Value {
    json!({ "error": message })
}
