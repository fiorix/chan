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

/// The answer to a method a route does not serve. A router takes it with
/// `method_not_allowed_fallback` after its last route, since the framework
/// gives it only to the routes registered before the call and only where a
/// route still has the default. A sub-router whose routes sit behind a gate
/// placed with `route_layer` takes it before that gate, so the gate wraps it
/// and answers a wrong method first. The framework adds the `Allow` header to
/// its answer.
pub(crate) async fn method_not_allowed() -> Response {
    err(StatusCode::METHOD_NOT_ALLOWED, "method not allowed".into())
}

/// A refusal a client branches on. Details serialize beside the reserved
/// `error` and `code` fields. Invalid details or an empty code produce a
/// JSON 500, since a caller's construction error must not corrupt the wire.
pub(crate) fn err_code(
    status: StatusCode,
    msg: String,
    code: &'static str,
    details: impl serde::Serialize,
) -> Response {
    let details = match serde_json::to_value(details) {
        Ok(serde_json::Value::Object(details))
            if !code.is_empty()
                && !details.contains_key("error")
                && !details.contains_key("code") =>
        {
            details
        }
        _ => {
            tracing::error!("invalid coded refusal: code or details violate the envelope");
            return err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot construct refusal response".into(),
            );
        }
    };
    #[derive(serde::Serialize)]
    struct Refusal<T> {
        error: String,
        code: &'static str,
        #[serde(flatten)]
        details: T,
    }
    (
        status,
        Json(Refusal {
            error: msg,
            code,
            details,
        }),
    )
        .into_response()
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

// The words a root's row reads while an earlier call of this process has not
// let go of it live in chan-library, beside the host that writes that row;
// the routes that answer with them and the desktop read them from here.
pub use chan_library::WORKSPACE_STILL_RELEASING;

/// The refusal of a request to mount a workspace whose root did not answer
/// within [`WORKSPACE_MOUNT_TIMEOUT`](crate::WORKSPACE_MOUNT_TIMEOUT) of the
/// request's start, naming `root`. The launcher's add and on and the desktop's
/// open answer it in these words.
pub fn mount_timed_out(root: &std::path::Path) -> String {
    format!(
        "mount timed out after {} seconds: {} did not answer",
        crate::WORKSPACE_MOUNT_TIMEOUT.as_secs(),
        root.display()
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

/// Map chan-workspace errors to HTTP statuses. The JSON shape preserves the
/// frontend error-handling contract.
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
        C::WriteTooLarge { .. } | C::ArchiveLimit { .. } => {
            (StatusCode::PAYLOAD_TOO_LARGE, e.to_string())
        }
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

    #[tokio::test]
    async fn refusal_shapes_are_pinned_bytes() {
        for (response, expected) in [
            (
                err(StatusCode::NOT_FOUND, "not found".into()),
                r#"{"error":"not found"}"#,
            ),
            (
                err_code(
                    StatusCode::NOT_FOUND,
                    "not found".into(),
                    "missing",
                    serde_json::json!({}),
                ),
                r#"{"error":"not found","code":"missing"}"#,
            ),
            (
                err_code(
                    StatusCode::NOT_FOUND,
                    "not found".into(),
                    "missing",
                    serde_json::json!({"id":"item-7"}),
                ),
                r#"{"error":"not found","code":"missing","id":"item-7"}"#,
            ),
        ] {
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
            assert_eq!(
                response.headers()[axum::http::header::CONTENT_TYPE],
                "application/json"
            );
            assert_eq!(
                to_bytes(response.into_body(), 8192).await.unwrap(),
                expected
            );
        }
    }

    async fn assert_invalid_refusal(response: Response) {
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            response.headers()[axum::http::header::CONTENT_TYPE],
            "application/json"
        );
        assert_eq!(
            to_bytes(response.into_body(), 8192).await.unwrap(),
            r#"{"error":"cannot construct refusal response"}"#,
        );
    }

    macro_rules! invalid_details {
        ($name:ident, $details:expr) => {
            #[tokio::test]
            async fn $name() {
                assert_invalid_refusal(err_code(
                    StatusCode::CONFLICT,
                    "the displayed sentence".into(),
                    "conflict",
                    $details,
                ))
                .await;
            }
        };
    }

    invalid_details!(
        details_cannot_replace_error,
        serde_json::json!({"error":"token"})
    );
    invalid_details!(
        details_cannot_replace_code,
        serde_json::json!({"code":"other"})
    );
    invalid_details!(details_cannot_be_a_string, "text");
    invalid_details!(details_cannot_be_a_sequence, vec![1, 2]);
    invalid_details!(details_cannot_be_null, ());
    invalid_details!(details_cannot_be_a_number, 7);
    invalid_details!(details_cannot_be_a_boolean, true);

    #[tokio::test]
    async fn details_serialization_failure_is_a_json_server_error() {
        struct Unserializable;
        impl serde::Serialize for Unserializable {
            fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
                Err(serde::ser::Error::custom("details unavailable"))
            }
        }
        assert_invalid_refusal(err_code(
            StatusCode::CONFLICT,
            "conflict".into(),
            "conflict",
            Unserializable,
        ))
        .await;
    }

    #[tokio::test]
    async fn an_empty_code_answers_without_panicking() {
        let response = std::panic::catch_unwind(|| {
            err_code(
                StatusCode::CONFLICT,
                "conflict".into(),
                "",
                serde_json::json!({}),
            )
        });
        assert!(
            response.is_ok(),
            "an empty refusal code must answer without panicking"
        );
        assert_invalid_refusal(response.unwrap()).await;
    }

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
    async fn err_from_maps_an_archive_limit_to_413() {
        let (status, msg) = status_and_error(err_from(&chan_workspace::ChanError::ArchiveLimit {
            unit: "entries",
            limit: 10_000,
        }))
        .await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(msg, "metadata archive exceeds its limit of 10000 entries");
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
