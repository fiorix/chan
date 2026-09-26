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
/// Shipped clients also send `windowId`, the answering window's id. The
/// server does not read it, since a survey's close goes to every target
/// window, the answering one included, and a body carrying it still parses
/// because this type does not deny unknown fields.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SurveyReplyRequest {
    #[serde(rename = "option", rename_all = "camelCase")]
    Option {
        survey_id: String,
        option_index: u32,
        option_label: String,
    },
    /// The user hit [F] (follow up later): a bare signal, shaped like
    /// `Dismissed`, telling the asking agent the host will follow up in a
    /// separate prompt. No option, no payload.
    #[serde(rename = "followup", rename_all = "camelCase")]
    Followup { survey_id: String },
    /// The user hit Dismiss (Part C): carries only the survey id (no option),
    /// so the asking agent can tell a dismiss from an answer.
    #[serde(rename = "dismissed", rename_all = "camelCase")]
    Dismissed { survey_id: String },
}

impl SurveyReplyRequest {
    /// The reply the parked survey's handler receives.
    fn into_reply(self) -> SurveyReply {
        match self {
            Self::Option {
                survey_id,
                option_index,
                option_label,
            } => SurveyReply::Option {
                survey_id,
                option_index,
                option_label,
            },
            Self::Followup { survey_id } => SurveyReply::Followup { survey_id },
            Self::Dismissed { survey_id } => SurveyReply::Dismissed { survey_id },
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
    let reply = req.into_reply();
    let survey_id = reply.survey_id().to_string();
    if state.survey_bus.complete_survey(&survey_id, reply) {
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
    use axum::body::Body;
    use axum::http::{header, Request};
    use tower::ServiceExt;

    #[test]
    fn option_reply_request_deserializes_camel_case() {
        let json = r#"{"surveyId":"survey-3","kind":"option","optionIndex":2,"optionLabel":"Yes"}"#;
        let req: SurveyReplyRequest = serde_json::from_str(json).unwrap();
        match req {
            SurveyReplyRequest::Option {
                survey_id,
                option_index,
                option_label,
            } => {
                assert_eq!(survey_id, "survey-3");
                assert_eq!(option_index, 2);
                assert_eq!(option_label, "Yes");
            }
            _ => panic!("expected option variant"),
        }
    }

    /// One reply body of each kind for survey `{ID}`, open at the end so a
    /// test can close it with or without the `windowId` shipped clients send.
    const REPLY_BODIES: [&str; 3] = [
        r#"{"surveyId":"{ID}","kind":"option","optionIndex":0,"optionLabel":"a""#,
        r#"{"surveyId":"{ID}","kind":"followup""#,
        r#"{"surveyId":"{ID}","kind":"dismissed""#,
    ];

    #[test]
    fn a_reply_body_with_a_window_id_parses_to_the_same_reply() {
        // Shipped SPAs and desktops send `windowId` on every reply; the field
        // must neither fail the parse nor change the reply.
        for body in REPLY_BODIES {
            let body = body.replace("{ID}", "survey-7");
            let without: SurveyReplyRequest = serde_json::from_str(&format!("{body}}}")).unwrap();
            let with: SurveyReplyRequest =
                serde_json::from_str(&format!(r#"{body},"windowId":"win-a"}}"#)).unwrap();
            assert_eq!(
                serde_json::to_value(with.into_reply()).unwrap(),
                serde_json::to_value(without.into_reply()).unwrap(),
                "{body} with a windowId"
            );
        }
    }

    #[tokio::test]
    async fn a_reply_carrying_a_window_id_completes_its_survey() {
        let state = crate::state::test_support::make_test_state(false);
        let router = axum::Router::new()
            .route("/api/survey/reply", axum::routing::post(api_survey_reply))
            .with_state(state.clone());
        for body in REPLY_BODIES {
            let (id, rx) = state.survey_bus.register();
            let body = body.replace("{ID}", &id);
            let request = Request::post("/api/survey/reply")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(format!(r#"{body},"windowId":"win-a"}}"#)))
                .unwrap();
            let response = router.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{body}");
            assert_eq!(
                rx.await.expect("the reply reaches the survey").survey_id(),
                id
            );
        }
    }

    #[test]
    fn followup_reply_request_deserializes() {
        // [F] is a bare "host will follow up later" signal: survey id only,
        // shaped exactly like a dismiss but under its own kind.
        let json = r#"{"surveyId":"survey-9","kind":"followup"}"#;
        let req: SurveyReplyRequest = serde_json::from_str(json).unwrap();
        match req {
            SurveyReplyRequest::Followup { survey_id } => assert_eq!(survey_id, "survey-9"),
            _ => panic!("expected followup variant"),
        }
    }

    #[test]
    fn dismissed_reply_request_deserializes() {
        // A dismiss carries only the survey id (no option).
        let json = r#"{"surveyId":"survey-4","kind":"dismissed"}"#;
        let req: SurveyReplyRequest = serde_json::from_str(json).unwrap();
        match req {
            SurveyReplyRequest::Dismissed { survey_id } => assert_eq!(survey_id, "survey-4"),
            _ => panic!("expected dismissed variant"),
        }
    }
}
