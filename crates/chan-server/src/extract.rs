//! Extractors whose rejection answers with the refusal envelope.
//!
//! Each wraps the framework's extractor of the same name and shape, so a
//! handler's `Json(body): Json<T>` pattern and its signature compile
//! unchanged once its import names this module. A rejection keeps the
//! framework's status and the sentence the framework would answer, and
//! answers them through [`crate::error::err`]. It displays as the
//! framework's rejection does, for the handlers that format it themselves.

use std::ops::{Deref, DerefMut};

use axum::extract::rejection::{JsonRejection, PathRejection, QueryRejection};
use axum::extract::{FromRequest, FromRequestParts, OptionalFromRequest, Request};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::de::DeserializeOwned;
use serde::Serialize;

/// A framework extractor's rejection, answered as the refusal envelope.
#[derive(Debug)]
pub(crate) enum Rejection {
    Json(JsonRejection),
    Query(QueryRejection),
    Path(PathRejection),
}

impl Rejection {
    fn status(&self) -> StatusCode {
        match self {
            Self::Json(rejection) => rejection.status(),
            Self::Query(rejection) => rejection.status(),
            Self::Path(rejection) => rejection.status(),
        }
    }

    /// The sentence the framework answers. For a path rejection it differs
    /// from the display, which leaves out the "Invalid URL" prefix.
    fn body_text(&self) -> String {
        match self {
            Self::Json(rejection) => rejection.body_text(),
            Self::Query(rejection) => rejection.body_text(),
            Self::Path(rejection) => rejection.body_text(),
        }
    }
}

impl std::fmt::Display for Rejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Json(rejection) => rejection.fmt(f),
            Self::Query(rejection) => rejection.fmt(f),
            Self::Path(rejection) => rejection.fmt(f),
        }
    }
}

impl IntoResponse for Rejection {
    fn into_response(self) -> Response {
        crate::error::err(self.status(), self.body_text())
    }
}

/// [`axum::Json`] with the envelope for its rejection. As a response it
/// answers exactly as the framework's does.
#[derive(Debug, Clone, Copy, Default)]
#[must_use]
pub(crate) struct Json<T>(pub T);

impl<T, S> FromRequest<S> for Json<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = Rejection;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let axum::Json(value) = <axum::Json<T> as FromRequest<S>>::from_request(req, state)
            .await
            .map_err(Rejection::Json)?;
        Ok(Self(value))
    }
}

/// A body with no content type is absent; one with another content type is
/// refused, as the framework's `Option<Json<T>>` does.
impl<T, S> OptionalFromRequest<S> for Json<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = Rejection;

    async fn from_request(req: Request, state: &S) -> Result<Option<Self>, Self::Rejection> {
        let value = <axum::Json<T> as OptionalFromRequest<S>>::from_request(req, state)
            .await
            .map_err(Rejection::Json)?;
        Ok(value.map(|axum::Json(value)| Self(value)))
    }
}

impl<T: Serialize> IntoResponse for Json<T> {
    fn into_response(self) -> Response {
        axum::Json(self.0).into_response()
    }
}

impl<T> From<T> for Json<T> {
    fn from(value: T) -> Self {
        Self(value)
    }
}

/// [`axum::extract::Query`] with the envelope for its rejection.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct Query<T>(pub T);

impl<T, S> FromRequestParts<S> for Query<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = Rejection;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let axum::extract::Query(value) = axum::extract::Query::from_request_parts(parts, state)
            .await
            .map_err(Rejection::Query)?;
        Ok(Self(value))
    }
}

/// [`axum::extract::Path`] with the envelope for its rejection.
#[derive(Debug)]
pub(crate) struct Path<T>(pub T);

impl<T, S> FromRequestParts<S> for Path<T>
where
    T: DeserializeOwned + Send,
    S: Send + Sync,
{
    type Rejection = Rejection;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let axum::extract::Path(value) = axum::extract::Path::from_request_parts(parts, state)
            .await
            .map_err(Rejection::Path)?;
        Ok(Self(value))
    }
}

macro_rules! deref_to_inner {
    ($($extractor:ident),+) => {
        $(
            impl<T> Deref for $extractor<T> {
                type Target = T;

                fn deref(&self) -> &T {
                    &self.0
                }
            }

            impl<T> DerefMut for $extractor<T> {
                fn deref_mut(&mut self) -> &mut T {
                    &mut self.0
                }
            }
        )+
    };
}

deref_to_inner!(Json, Query, Path);

#[cfg(test)]
mod tests {
    use axum::body::{to_bytes, Body};
    use axum::extract::{DefaultBodyLimit, FromRequest};
    use axum::http::{header, HeaderValue, Request};
    use axum::response::Response;
    use axum::routing::{get, post};
    use axum::Router;
    use tower::ServiceExt;

    /// Bodies above this many bytes are refused, so a length rejection is
    /// cheap to provoke.
    const LIMIT: usize = 16;

    #[derive(serde::Deserialize)]
    struct Probe {
        #[allow(dead_code)]
        count: u64,
    }

    /// The same routes over whichever `Json`, `Query`, `Path`, `Bytes` and
    /// `Multipart` are in scope where the macro is invoked.
    macro_rules! probe_routes {
        () => {
            Router::new()
                .route("/json", post(|_: Json<Probe>| async {}))
                .route("/optional-json", post(|_: Option<Json<Probe>>| async {}))
                .route(
                    "/json-display",
                    post(
                        |r: Result<Json<Probe>, <Json<Probe> as FromRequest<()>>::Rejection>| async move {
                            r.err().map(|e| e.to_string()).unwrap_or_default()
                        },
                    ),
                )
                .route("/respond", get(|| async { Json(serde_json::json!({"ok": true})) }))
                .route("/query", get(|_: Query<Probe>| async {}))
                .route("/path/{key}", get(|_: Path<String>| async {}))
                .route(
                    "/path-display/{key}",
                    get(
                        |r: Result<Path<String>, <Path<String> as axum::extract::FromRequestParts<()>>::Rejection>| async move {
                            r.err().map(|e| e.to_string()).unwrap_or_default()
                        },
                    ),
                )
                .route("/bytes", post(|_: Bytes| async {}))
                .route("/multipart", post(|_: Multipart| async {}))
                .layer(DefaultBodyLimit::max(LIMIT))
        };
    }

    mod framework {
        use super::*;
        use axum::body::Bytes;
        use axum::extract::{Multipart, Path, Query};
        use axum::Json;

        pub(super) fn app() -> Router {
            probe_routes!()
        }
    }

    mod subject {
        use super::*;
        // The extractors under test.
        use crate::extract::{Json, Path, Query};
        use axum::body::Bytes;
        use axum::extract::Multipart;

        pub(super) fn app() -> Router {
            probe_routes!()
        }
    }

    async fn body_text(response: Response) -> String {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    /// Sends one request to the framework's extractors and to the ones under
    /// test, and requires the second to answer the first's status with its
    /// sentence in the envelope.
    async fn assert_enveloped(kind: &str, request: impl Fn() -> Request<Body>) {
        let framework = framework::app().oneshot(request()).await.unwrap();
        let status = framework.status();
        assert!(status.is_client_error(), "{kind}: the framework refuses");
        assert_eq!(
            framework.headers().get(header::CONTENT_TYPE),
            Some(&HeaderValue::from_static("text/plain; charset=utf-8")),
            "{kind}: the framework's own rejection is plain text"
        );
        let sentence = body_text(framework).await;
        eprintln!("rejection\t{kind}\t{}\t{sentence}", status.as_u16());
        let response = subject::app().oneshot(request()).await.unwrap();
        assert_eq!(response.status(), status, "{kind}: the status is kept");
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE),
            Some(&HeaderValue::from_static("application/json")),
            "{kind}: the rejection answers the envelope's content type"
        );
        assert_eq!(
            body_text(response).await,
            serde_json::json!({"error": sentence}).to_string(),
            "{kind}: the envelope carries the framework's sentence"
        );
    }

    fn json_request(uri: &str, body: impl Into<Body>) -> Request<Body> {
        Request::post(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .body(body.into())
            .unwrap()
    }

    fn broken_body() -> Body {
        Body::from_stream(futures::stream::iter([Err::<axum::body::Bytes, _>(
            std::io::Error::other("the client went away"),
        )]))
    }

    #[tokio::test]
    async fn json_syntax() {
        assert_enveloped("JsonSyntaxError", || json_request("/json", "{")).await;
    }

    #[tokio::test]
    async fn json_data() {
        assert_enveloped("JsonDataError", || {
            json_request("/json", r#"{"count":"x"}"#)
        })
        .await;
    }

    #[tokio::test]
    async fn json_content_type() {
        assert_enveloped("MissingJsonContentType", || {
            Request::post("/json").body(Body::from("{}")).unwrap()
        })
        .await;
    }

    #[tokio::test]
    async fn json_length_limit() {
        assert_enveloped("LengthLimitError (Json)", || {
            json_request("/json", format!(r#"{{"count":{}}}"#, "1".repeat(LIMIT)))
        })
        .await;
    }

    #[tokio::test]
    async fn json_broken_body() {
        assert_enveloped("UnknownBodyError (Json)", || {
            json_request("/json", broken_body())
        })
        .await;
    }

    #[tokio::test]
    async fn optional_json_content_type() {
        assert_enveloped("MissingJsonContentType (Option<Json>)", || {
            Request::post("/optional-json")
                .header(header::CONTENT_TYPE, "text/plain")
                .body(Body::from("{}"))
                .unwrap()
        })
        .await;
    }

    #[tokio::test]
    async fn query() {
        assert_enveloped("FailedToDeserializeQueryString", || {
            Request::get("/query?count=x").body(Body::empty()).unwrap()
        })
        .await;
    }

    #[tokio::test]
    async fn path_utf8() {
        assert_enveloped("FailedToDeserializePathParams", || {
            Request::get("/path/%FF").body(Body::empty()).unwrap()
        })
        .await;
    }

    #[tokio::test]
    async fn bytes_length_limit() {
        assert_enveloped("LengthLimitError (Bytes)", || {
            Request::post("/bytes")
                .body(Body::from("x".repeat(LIMIT + 1)))
                .unwrap()
        })
        .await;
    }

    #[tokio::test]
    async fn bytes_broken_body() {
        assert_enveloped("UnknownBodyError (Bytes)", || {
            Request::post("/bytes").body(broken_body()).unwrap()
        })
        .await;
    }

    #[tokio::test]
    async fn multipart_boundary() {
        assert_enveloped("InvalidBoundary", || {
            Request::post("/multipart")
                .header(header::CONTENT_TYPE, "multipart/form-data")
                .body(Body::empty())
                .unwrap()
        })
        .await;
    }

    /// The rejection a handler formats itself reads as the framework's does:
    /// for the path, its display drops the prefix its response carries.
    #[tokio::test]
    async fn rejections_display_as_the_framework_does() {
        let requests: [fn() -> Request<Body>; 2] = [
            || json_request("/json-display", "{"),
            || {
                Request::get("/path-display/%FF")
                    .body(Body::empty())
                    .unwrap()
            },
        ];
        for request in requests {
            let framework = body_text(framework::app().oneshot(request()).await.unwrap()).await;
            assert!(!framework.is_empty());
            assert_eq!(
                body_text(subject::app().oneshot(request()).await.unwrap()).await,
                framework
            );
        }
    }

    #[tokio::test]
    async fn json_answers_as_the_framework_does() {
        let request = || Request::get("/respond").body(Body::empty()).unwrap();
        let framework = framework::app().oneshot(request()).await.unwrap();
        let response = subject::app().oneshot(request()).await.unwrap();
        assert_eq!(response.status(), framework.status());
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE),
            framework.headers().get(header::CONTENT_TYPE)
        );
        assert_eq!(body_text(response).await, body_text(framework).await);
    }
}
