//! Error type and HTTP response builders.
//!
//! `Error` is the crate-wide error returned by `serve()` and the devserver.
//! The `err_*` helpers shape uniform `{"error": "..."}` JSON bodies and map
//! chan-workspace errors onto the right HTTP status. Routes call into these instead
//! of building responses by hand so the wire shape stays consistent across
//! handlers.

use axum::http::StatusCode;
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
        StateAccessError::WorkspaceCellMissing => err(
            StatusCode::SERVICE_UNAVAILABLE,
            "workspace busy: workspace state is temporarily unavailable; retry in a moment".into(),
        ),
        StateAccessError::WorkspaceCellPoisoned => {
            err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        }
    }
}

/// Map chan-workspace errors to HTTP statuses. The shape of the JSON
/// matches the old server so frontend error handling stays unchanged.
pub fn err_from(e: &chan_workspace::ChanError) -> Response {
    use chan_workspace::ChanError as C;
    let (status, msg) = match e {
        C::PathEmpty | C::PathEscape | C::SymlinkEscape(_) => {
            (StatusCode::BAD_REQUEST, e.to_string())
        }
        C::NotEditableText(_) => (StatusCode::UNSUPPORTED_MEDIA_TYPE, e.to_string()),
        C::SpecialFile { .. } => (StatusCode::UNSUPPORTED_MEDIA_TYPE, e.to_string()),
        C::WorkspaceNotRegistered(_) | C::WorkspaceRootMissing(_) => {
            (StatusCode::NOT_FOUND, e.to_string())
        }
        C::WorkspaceLocked | C::PathAlreadyExists(_) => (StatusCode::CONFLICT, e.to_string()),
        C::DraftBroken { .. } => (StatusCode::BAD_REQUEST, e.to_string()),
        C::WriteTooLarge { .. } => (StatusCode::PAYLOAD_TOO_LARGE, e.to_string()),
        C::Io(s) if s.contains("No such file") || s.contains("not found") => {
            (StatusCode::NOT_FOUND, e.to_string())
        }
        C::Io(s) if s.contains("refusing to write non-UTF-8 bytes to editable text file") => {
            (StatusCode::UNSUPPORTED_MEDIA_TYPE, e.to_string())
        }
        _ => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    err(status, msg)
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
    async fn err_state_maps_missing_workspace_to_retryable_busy() {
        let (status, msg) =
            status_and_error(err_state(&StateAccessError::WorkspaceCellMissing)).await;

        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(msg.contains("workspace busy"));
    }

    #[tokio::test]
    async fn err_from_maps_non_utf8_editable_upload_to_415() {
        let (status, msg) = status_and_error(err_from(&chan_workspace::ChanError::Io(
            "refusing to write non-UTF-8 bytes to editable text file: note.md".to_string(),
        )))
        .await;

        assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert!(msg.contains("non-UTF-8"));
    }
}
