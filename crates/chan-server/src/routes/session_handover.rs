//! Session handover reply route (the leader's answer to `cs session handover`).
//!
//! A `cs session handover` call blocks in the control socket on a oneshot
//! parked in the [`crate::handover_bus::HandoverBus`] keyed by a server-minted
//! `request_id`. The leader's SPA shows the handover prompt and POSTs a
//! [`HandoverReplyRequest`] here; this route fires the oneshot through
//! [`crate::handover_bus::HandoverBus::complete`], unblocking the requester.
//! Mirrors `routes::window` / `routes::survey`, plus a leader-identity gate the
//! bus itself cannot enforce (it keys on the id alone).

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use crate::error::err;
use crate::extract::Json;
use crate::handover_bus::HandoverReply;
use crate::state::AppState;

/// Body of `POST /api/session/handover/reply`. camelCase to match the SPA.
/// `window_id` is the answering client's own id: only the current leader
/// holding this request may answer, so the route checks it against the parked
/// request's leader.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoverReplyRequest {
    pub request_id: String,
    pub window_id: String,
    pub accept: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

/// `POST /api/session/handover/reply` - the leader accepts or rejects a parked
/// `cs session handover`. Only the current leader holding THIS request may
/// answer (403 otherwise); 404 when nothing with that id is parked (already
/// answered, timed out, or stale). The leadership move itself is applied by the
/// requester's unblocked handler, not here.
pub async fn api_session_handover_reply(
    State(state): State<Arc<AppState>>,
    Json(req): Json<HandoverReplyRequest>,
) -> Response {
    match state.session_registry.pending_for_leader(&req.window_id) {
        Some(pending) if pending.request_id == req.request_id => {
            let reply = if req.accept {
                HandoverReply::Accept
            } else {
                HandoverReply::Reject { reason: req.reason }
            };
            if state.handover_bus.complete(&req.request_id, reply) {
                Json(serde_json::json!({})).into_response()
            } else {
                err(
                    StatusCode::NOT_FOUND,
                    format!(
                        "no handover parked with id {} (already answered, timed out, or stale)",
                        req.request_id
                    ),
                )
            }
        }
        _ => err(
            StatusCode::FORBIDDEN,
            "only the current leader may answer this handover".to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handover_reply_request_deserializes_camel_case() {
        let json = r#"{"requestId":"handover-2","windowId":"w-a","accept":false,"reason":"busy"}"#;
        let req: HandoverReplyRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.request_id, "handover-2");
        assert_eq!(req.window_id, "w-a");
        assert!(!req.accept);
        assert_eq!(req.reason.as_deref(), Some("busy"));
    }

    #[test]
    fn handover_reply_reason_is_optional() {
        let json = r#"{"requestId":"handover-3","windowId":"w-b","accept":true}"#;
        let req: HandoverReplyRequest = serde_json::from_str(json).unwrap();
        assert!(req.accept);
        assert_eq!(req.reason, None);
    }
}
