//! Error type and HTTP response builders.
//!
//! `Error` is the crate-wide error returned by `serve()` and the devserver.
//! The `err_*` helpers shape uniform `{"error": "..."}` JSON bodies and map
//! chan-workspace errors onto the right HTTP status. Routes call into these instead
//! of building responses by hand so the wire shape stays consistent across
//! handlers.

use axum::http::header::RETRY_AFTER;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::state::StateAccessError;

// The error type lives in chan-library (returned by the host lifecycle + the
// tenant builder). Re-exported so `crate::Error` / `chan_server::Error` resolve
// unchanged; the `err_*` helpers below map it onto HTTP responses.
pub use chan_library::Error;

/// Wrap a status + message into the standard `{"error": "..."}` body.
pub fn err(status: StatusCode, msg: String) -> Response {
    (status, Json(serde_json::json!({"error": msg}))).into_response()
}

/// Refusal returned by `tunnel_guard::settings_guard` when the
/// server was started with `settings_disabled = true`, i.e. a
/// `--no-settings` serve (kiosk / shared workstation). 403 because
/// the request is well-formed; the host policy just forbids the
/// operation. Single source of truth for the error body so SPA
/// error toasts stay consistent.
pub fn err_settings_locked() -> Response {
    err(
        StatusCode::FORBIDDEN,
        "settings are disabled on this server (started with \
         --no-settings); configuration changes are not permitted here"
            .into(),
    )
}

pub fn err_state(e: &StateAccessError) -> Response {
    match e {
        StateAccessError::Busy => {
            let mut response = err(
                StatusCode::SERVICE_UNAVAILABLE,
                "workspace busy: workspace state is temporarily unavailable; retry in a moment"
                    .into(),
            );
            response
                .headers_mut()
                .insert(RETRY_AFTER, HeaderValue::from_static("1"));
            response
        }
        StateAccessError::Missing => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        StateAccessError::Poisoned => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// Map chan-workspace errors to HTTP statuses. The shape of the JSON
/// matches the old server so frontend error handling stays unchanged.
pub fn err_from(e: &chan_workspace::ChanError) -> Response {
    use chan_workspace::ChanError as C;
    let (status, msg) = match e {
        C::PathEmpty | C::PathEscape | C::SymlinkEscape(_) | C::DestinationInsideSource(_) => {
            (StatusCode::BAD_REQUEST, e.to_string())
        }
        C::NotEditableText(_) | C::NonUtf8EditableText(_) => {
            (StatusCode::UNSUPPORTED_MEDIA_TYPE, e.to_string())
        }
        C::SpecialFile { .. } => (StatusCode::UNSUPPORTED_MEDIA_TYPE, e.to_string()),
        C::WorkspaceNotRegistered(_) | C::WorkspaceRootMissing(_) | C::NotFound(_) => {
            (StatusCode::NOT_FOUND, e.to_string())
        }
        C::WorkspaceFdPressure { .. } => (StatusCode::SERVICE_UNAVAILABLE, e.to_string()),
        C::WorkspaceLocked | C::PathAlreadyExists(_) => (StatusCode::CONFLICT, e.to_string()),
        C::DraftBroken { .. } => (StatusCode::BAD_REQUEST, e.to_string()),
        C::WriteTooLarge { .. } => (StatusCode::PAYLOAD_TOO_LARGE, e.to_string()),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let mut response = err(status, msg);
    if matches!(e, C::WorkspaceFdPressure { .. }) {
        response
            .headers_mut()
            .insert(RETRY_AFTER, HeaderValue::from_static("3"));
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    async fn body_json(r: Response) -> serde_json::Value {
        let (parts, body) = r.into_parts();
        let bytes = to_bytes(body, 8192).await.expect("read body");
        // Sanity: error bodies are tiny, way under 8 KiB.
        assert_eq!(parts.status, StatusCode::FORBIDDEN);
        serde_json::from_slice(&bytes).expect("error body is JSON")
    }

    async fn status_and_error(r: Response) -> (StatusCode, String) {
        let (parts, body) = r.into_parts();
        let bytes = to_bytes(body, 8192).await.expect("read body");
        let value: serde_json::Value = serde_json::from_slice(&bytes).expect("error body is JSON");
        let message = value
            .get("error")
            .and_then(|x| x.as_str())
            .expect("error field")
            .to_string();
        (parts.status, message)
    }

    #[tokio::test]
    async fn missing_kind_windows_file_is_404() {
        assert_missing_kind_status("The system cannot find the file specified. (os error 2)").await;
    }

    #[tokio::test]
    async fn missing_kind_windows_path_is_404() {
        assert_missing_kind_status("The system cannot find the path specified. (os error 3)").await;
    }

    async fn assert_missing_kind_status(message: &str) {
        let error = chan_workspace::ChanError::from(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            message.to_string(),
        ));
        let (status, body) = status_and_error(err_from(&error)).await;
        assert_eq!(body, format!("io error: {message}"));
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn missing_kind_permission_denied_text_is_500() {
        let error = chan_workspace::ChanError::from(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "permission denied: not found in access policy",
        ));
        let (status, _) = status_and_error(err_from(&error)).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn err_from_maps_workspace_fd_pressure_to_retryable_503() {
        let response = err_from(&chan_workspace::ChanError::WorkspaceFdPressure {
            active: 4,
            capacity: 4,
        });
        assert_eq!(response.headers().get(RETRY_AFTER).unwrap(), "3");
        let (status, message) = status_and_error(response).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(message.contains("file-descriptor pressure"));
        assert!(message.contains("close a workspace or retry"));
    }

    #[tokio::test]
    async fn err_settings_locked_shape() {
        let v = body_json(err_settings_locked()).await;
        let msg = v
            .get("error")
            .and_then(|x| x.as_str())
            .expect("error field");
        assert!(
            msg.contains("settings"),
            "wrong message: {msg:?}, must reference 'settings' so the SPA \
             toast is recognisable"
        );
    }

    #[tokio::test]
    async fn err_from_maps_path_already_exists_to_conflict() {
        let (status, msg) = status_and_error(err_from(
            &chan_workspace::ChanError::PathAlreadyExists("notes/draft.md".to_string()),
        ))
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(msg.contains("notes/draft.md"));
    }

    #[tokio::test]
    async fn err_from_maps_broken_draft_to_bad_request() {
        let (status, msg) = status_and_error(err_from(&chan_workspace::ChanError::DraftBroken {
            name: "untitled-1".to_string(),
            message: "missing draft.md".to_string(),
        }))
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(msg.contains("untitled-1"));
        assert!(msg.contains("missing draft.md"));
    }

    #[tokio::test]
    async fn err_from_maps_write_too_large_to_413() {
        // A user-correctable size refusal is 413, never a 500: the SPA
        // surfaces honest "write too large" messaging, not a server fault.
        let (status, msg) = status_and_error(err_from(&chan_workspace::ChanError::WriteTooLarge {
            kind: "text",
            size: 6_291_573,
            limit: 6_291_569,
        }))
        .await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(msg.contains("too large"));
    }

    #[tokio::test]
    async fn err_state_maps_missing_workspace_to_permanent_fault() {
        let response = err_state(&StateAccessError::Missing);
        assert!(response.headers().get(RETRY_AFTER).is_none());
        let (status, msg) = status_and_error(response).await;

        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(msg.contains("workspace cell missing"));
    }

    #[tokio::test]
    async fn err_state_maps_contended_workspace_to_retryable_busy() {
        let response = err_state(&StateAccessError::Busy);
        assert_eq!(response.headers().get(RETRY_AFTER).unwrap(), "1");
        let (status, msg) = status_and_error(response).await;

        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(msg.contains("workspace busy"));
    }

    #[tokio::test]
    async fn err_from_maps_non_utf8_editable_upload_to_415() {
        let (status, msg) =
            status_and_error(err_from(&chan_workspace::ChanError::NonUtf8EditableText(
                "refusing to write non-UTF-8 bytes to editable text file: note.md".to_string(),
            )))
            .await;

        assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert!(msg.contains("non-UTF-8"));
    }
}
