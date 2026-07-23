//! Survey reply route (the SPA-reply side of `cs terminal survey`).
//!
//! A `cs terminal survey` call blocks in the control socket on a oneshot
//! parked in the [`crate::survey::SurveyBus`] keyed by a
//! server-minted `survey_id`. The SPA renders the overlay and, when the user
//! answers, POSTs a [`SurveyReplyRequest`] here. This route turns that into a
//! [`chan_shell::SurveyReply`] and calls [`SurveyBus::complete_survey`], which
//! fires the oneshot and unblocks the CLI. Two halves of one stable
//! `complete_survey` API keep the bus and the reply route decoupled.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chan_shell::SurveyReply;
use serde::Deserialize;

use crate::error::err;
use crate::state::AppState;

/// Body of `POST /api/survey/reply`. Internally tagged on `kind`, camelCase
/// to match the SPA (`web/packages/workspace-app/src/api/client.ts` `SurveyReplyRequest`).
///
/// `windowId` is the answering window's id (the same id the SPA matches
/// `window_command` frames against). The server excludes that window from the
/// stale-overlay close fan-out so a window answering its own survey does not
/// receive an `answered_elsewhere` close racing its own local clear. Optional:
/// a reply without it just fans the close to every target as before.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SurveyReplyRequest {
    #[serde(rename = "option", rename_all = "camelCase")]
    Option {
        survey_id: String,
        option_index: u32,
        option_label: String,
        #[serde(default)]
        window_id: Option<String>,
    },
    /// The user hit [F] (follow up later): a bare signal, shaped like
    /// `Dismissed`, telling the asking agent the host will follow up in a
    /// separate prompt. No option, no payload.
    #[serde(rename = "followup", rename_all = "camelCase")]
    Followup {
        survey_id: String,
        #[serde(default)]
        window_id: Option<String>,
    },
    /// The user hit Dismiss (Part C): carries only the survey id (no option),
    /// so the asking agent can tell a dismiss from an answer.
    #[serde(rename = "dismissed", rename_all = "camelCase")]
    Dismissed {
        survey_id: String,
        #[serde(default)]
        window_id: Option<String>,
    },
}

impl SurveyReplyRequest {
    /// The answering window's id, when the SPA reported it.
    fn window_id(&self) -> Option<&str> {
        match self {
            Self::Option { window_id, .. }
            | Self::Followup { window_id, .. }
            | Self::Dismissed { window_id, .. } => window_id.as_deref(),
        }
    }
}

/// `POST /api/survey/reply` - complete a parked `cs terminal survey`. On
/// "option" the chosen label round-trips straight to the blocked CLI;
/// "followup" and "dismissed" are bare signals carrying only the survey id.
/// 404 when no survey with that id is parked (already answered / stale id).
pub async fn api_survey_reply(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SurveyReplyRequest>,
) -> Response {
    // The answering window, excluded from the stale-overlay close fan-out
    // (read before the match consumes `req`).
    let answered_by = req.window_id().map(str::to_string);
    let reply = match req {
        SurveyReplyRequest::Option {
            survey_id,
            option_index,
            option_label,
            ..
        } => SurveyReply::Option {
            survey_id,
            option_index,
            option_label,
        },
        SurveyReplyRequest::Followup { survey_id, .. } => SurveyReply::Followup { survey_id },
        SurveyReplyRequest::Dismissed { survey_id, .. } => SurveyReply::Dismissed { survey_id },
    };

    let survey_id = reply.survey_id().to_string();
    if state
        .survey_bus
        .complete_survey(&survey_id, reply, answered_by)
    {
        Json(serde_json::json!({})).into_response()
    } else {
        err(
            StatusCode::NOT_FOUND,
            format!("no survey parked with id {survey_id} (already answered or stale)"),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn option_reply_request_deserializes_camel_case() {
        let json = r#"{"surveyId":"survey-3","kind":"option","optionIndex":2,"optionLabel":"Yes"}"#;
        let req: SurveyReplyRequest = serde_json::from_str(json).unwrap();
        match req {
            SurveyReplyRequest::Option {
                survey_id,
                option_index,
                option_label,
                window_id,
            } => {
                assert_eq!(survey_id, "survey-3");
                assert_eq!(option_index, 2);
                assert_eq!(option_label, "Yes");
                // Absent windowId defaults to None (fan the close to all).
                assert!(window_id.is_none());
            }
            _ => panic!("expected option variant"),
        }
    }

    #[test]
    fn reply_request_carries_window_id() {
        // The SPA reports the answering window so the server can exclude it
        // from the stale-overlay close fan-out. camelCase `windowId` on the
        // wire; a green compile alone would not catch a snake_case drift.
        let json = r#"{"surveyId":"survey-7","kind":"option","optionIndex":0,
            "optionLabel":"a","windowId":"win-a"}"#;
        let req: SurveyReplyRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.window_id(), Some("win-a"));
    }

    #[test]
    fn followup_reply_request_deserializes() {
        // [F] is a bare "host will follow up later" signal: survey id only,
        // shaped exactly like a dismiss but under its own kind.
        let json = r#"{"surveyId":"survey-9","kind":"followup"}"#;
        let req: SurveyReplyRequest = serde_json::from_str(json).unwrap();
        match req {
            SurveyReplyRequest::Followup {
                survey_id,
                window_id,
            } => {
                assert_eq!(survey_id, "survey-9");
                assert!(window_id.is_none());
            }
            _ => panic!("expected followup variant"),
        }
    }

    #[test]
    fn dismissed_reply_request_deserializes() {
        // A dismiss carries only the survey id (no option).
        let json = r#"{"surveyId":"survey-4","kind":"dismissed"}"#;
        let req: SurveyReplyRequest = serde_json::from_str(json).unwrap();
        match req {
            SurveyReplyRequest::Dismissed { survey_id, .. } => assert_eq!(survey_id, "survey-4"),
            _ => panic!("expected dismissed variant"),
        }
    }
}
