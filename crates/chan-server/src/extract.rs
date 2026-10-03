//! Extractors whose rejection answers with the refusal envelope.
//!
//! Each wraps the framework's extractor of the same name and shape, so a
//! handler's `Json(body): Json<T>` pattern and its signature compile
//! unchanged once its import names this module. A rejection keeps the
//! framework's status and answers one fixed sentence for its kind, in the
//! API's terms, through [`crate::error::err`]. It displays as that sentence,
//! for the handlers that format it themselves. What the framework said of
//! the request, which can repeat a deserializer's message and name a Rust
//! type, goes to the log and never to the caller.

use std::ops::{Deref, DerefMut};

use axum::extract::multipart::MultipartRejection;
use axum::extract::rejection::{
    BytesRejection, ExtensionRejection, JsonRejection, PathRejection, QueryRejection,
};
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
    Bytes(BytesRejection),
    Multipart(MultipartRejection),
    Extension(ExtensionRejection),
}

/// The sentence of a rejection the framework blames on the server: a route
/// declared with path parameters its handler does not take, or a handler
/// whose extension no layer carries.
const MISASSEMBLED: &str = "this route cannot read its request";

impl Rejection {
    fn status(&self) -> StatusCode {
        match self {
            Self::Json(rejection) => rejection.status(),
            Self::Query(rejection) => rejection.status(),
            Self::Path(rejection) => rejection.status(),
            Self::Bytes(rejection) => rejection.status(),
            Self::Multipart(rejection) => rejection.status(),
            Self::Extension(rejection) => rejection.status(),
        }
    }

    /// The sentence the caller reads: one for each kind of rejection. It
    /// names no field, since the framework gives a field's path only inside
    /// the deserializer's message.
    pub(crate) fn body_text(&self) -> String {
        self.sentence().to_string()
    }

    fn sentence(&self) -> &'static str {
        if self.status().is_server_error() {
            return MISASSEMBLED;
        }
        match self {
            Self::Json(JsonRejection::JsonSyntaxError(_)) => "the request body is not valid JSON",
            Self::Json(JsonRejection::MissingJsonContentType(_)) => {
                "the request body must have the content type application/json"
            }
            // The framework tells a body over the limit from one it could
            // not read by the status alone.
            Self::Json(JsonRejection::BytesRejection(rejection)) | Self::Bytes(rejection) => {
                if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
                    "the request body is too large"
                } else {
                    "the request body could not be read"
                }
            }
            Self::Json(_) => "the request body does not match what this route accepts",
            Self::Query(_) => "the query string does not match what this route accepts",
            Self::Path(_) => "the request path does not match what this route accepts",
            Self::Multipart(_) => "the multipart request has no valid boundary",
            Self::Extension(_) => MISASSEMBLED,
        }
    }

    /// What the framework said of the request. It can repeat a deserializer's
    /// message, which names Rust types and quotes values of the request.
    fn detail(&self) -> String {
        match self {
            Self::Json(rejection) => rejection.body_text(),
            Self::Query(rejection) => rejection.body_text(),
            Self::Path(rejection) => rejection.body_text(),
            Self::Bytes(rejection) => rejection.body_text(),
            Self::Multipart(rejection) => rejection.body_text(),
            Self::Extension(rejection) => rejection.body_text(),
        }
    }

    /// Logs what the framework said, where the rejection is made: some
    /// handlers take the rejection and answer it themselves. A request its
    /// caller got wrong logs at debug, since the caller chooses the text and
    /// how often it is written; a route that cannot read its request is a
    /// fault of the router's assembly and logs at error.
    fn logged(self) -> Self {
        let status = self.status();
        if status.is_server_error() {
            tracing::error!(
                status = status.as_u16(),
                detail = %self.detail(),
                "a route cannot read its request"
            );
        } else {
            tracing::debug!(
                status = status.as_u16(),
                detail = %self.detail(),
                "request rejected"
            );
        }
        self
    }
}

impl std::fmt::Display for Rejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.sentence())
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
            .map_err(|rejection| Rejection::Json(rejection).logged())?;
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
            .map_err(|rejection| Rejection::Json(rejection).logged())?;
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
            .map_err(|rejection| Rejection::Query(rejection).logged())?;
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
            .map_err(|rejection| Rejection::Path(rejection).logged())?;
        Ok(Self(value))
    }
}

/// [`axum::Extension`] with the envelope for its rejection: a handler whose
/// extension no layer of its router carries.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct Extension<T>(pub T);

impl<T, S> FromRequestParts<S> for Extension<T>
where
    T: Clone + Send + Sync + 'static,
    S: Send + Sync,
{
    type Rejection = Rejection;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let axum::Extension(value) =
            <axum::Extension<T> as FromRequestParts<S>>::from_request_parts(parts, state)
                .await
                .map_err(|rejection| Rejection::Extension(rejection).logged())?;
        Ok(Self(value))
    }
}

/// A request body as [`axum::body::Bytes`], with the envelope for its
/// rejection.
#[derive(Debug, Clone, Default)]
pub(crate) struct Bytes(pub axum::body::Bytes);

impl<S> FromRequest<S> for Bytes
where
    S: Send + Sync,
{
    type Rejection = Rejection;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        <axum::body::Bytes as FromRequest<S>>::from_request(req, state)
            .await
            .map(Self)
            .map_err(|rejection| Rejection::Bytes(rejection).logged())
    }
}

impl Deref for Bytes {
    type Target = axum::body::Bytes;

    fn deref(&self) -> &axum::body::Bytes {
        &self.0
    }
}

/// [`axum::extract::Multipart`] with the envelope for its rejection. Its
/// fields are read through the framework's own, which it dereferences to.
#[derive(Debug)]
pub(crate) struct Multipart(pub axum::extract::Multipart);

impl<S> FromRequest<S> for Multipart
where
    S: Send + Sync,
{
    type Rejection = Rejection;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        <axum::extract::Multipart as FromRequest<S>>::from_request(req, state)
            .await
            .map(Self)
            .map_err(|rejection| Rejection::Multipart(rejection).logged())
    }
}

impl Deref for Multipart {
    type Target = axum::extract::Multipart;

    fn deref(&self) -> &axum::extract::Multipart {
        &self.0
    }
}

impl DerefMut for Multipart {
    fn deref_mut(&mut self) -> &mut axum::extract::Multipart {
        &mut self.0
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

deref_to_inner!(Json, Query, Path, Extension);

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

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

    /// An extension no layer of the probe routers carries.
    #[derive(Clone)]
    struct Marker;

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
                .route("/pair/{first}/{second}", get(|_: Path<String>| async {}))
                .route("/extension", get(|_: Extension<Marker>| async {}))
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
        use axum::{Extension, Json};

        pub(super) fn app() -> Router {
            probe_routes!()
        }
    }

    mod subject {
        use super::*;
        // The extractors under test.
        use crate::extract::{Bytes, Extension, Json, Multipart, Path, Query};

        pub(super) fn app() -> Router {
            probe_routes!()
        }
    }

    async fn body_text(response: Response) -> String {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    const NOT_JSON: &str = "the request body is not valid JSON";
    const WRONG_SHAPE: &str = "the request body does not match what this route accepts";
    const NOT_JSON_CONTENT_TYPE: &str =
        "the request body must have the content type application/json";
    const TOO_LARGE: &str = "the request body is too large";
    const UNREADABLE_BODY: &str = "the request body could not be read";
    const BAD_QUERY: &str = "the query string does not match what this route accepts";
    const BAD_PATH: &str = "the request path does not match what this route accepts";
    const NO_BOUNDARY: &str = "the multipart request has no valid boundary";
    const MISASSEMBLED: &str = "this route cannot read its request";

    /// Sends one request to the framework's extractors and to the ones under
    /// test, and requires the second to answer the first's status with
    /// `sentence` in the envelope.
    async fn assert_enveloped(kind: &str, sentence: &str, request: impl Fn() -> Request<Body>) {
        let framework = framework::app().oneshot(request()).await.unwrap();
        let status = framework.status();
        assert!(
            status.is_client_error() || status.is_server_error(),
            "{kind}: the framework refuses"
        );
        assert_eq!(
            framework.headers().get(header::CONTENT_TYPE),
            Some(&HeaderValue::from_static("text/plain; charset=utf-8")),
            "{kind}: the framework's own rejection is plain text"
        );
        eprintln!(
            "rejection\t{kind}\t{}\t{}",
            status.as_u16(),
            body_text(framework).await
        );
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
            "{kind}: the envelope carries the kind's sentence"
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
        assert_enveloped("JsonSyntaxError", NOT_JSON, || json_request("/json", "{")).await;
    }

    #[tokio::test]
    async fn json_data() {
        assert_enveloped("JsonDataError", WRONG_SHAPE, || {
            json_request("/json", r#"{"count":"x"}"#)
        })
        .await;
    }

    /// A body of the wrong JSON type: the framework's sentence names the
    /// type the handler takes.
    #[tokio::test]
    async fn json_wrong_type() {
        assert_enveloped("JsonDataError (wrong type)", WRONG_SHAPE, || {
            json_request("/json", r#""x""#)
        })
        .await;
    }

    #[tokio::test]
    async fn json_content_type() {
        assert_enveloped("MissingJsonContentType", NOT_JSON_CONTENT_TYPE, || {
            Request::post("/json").body(Body::from("{}")).unwrap()
        })
        .await;
    }

    #[tokio::test]
    async fn json_length_limit() {
        assert_enveloped("LengthLimitError (Json)", TOO_LARGE, || {
            json_request("/json", format!(r#"{{"count":{}}}"#, "1".repeat(LIMIT)))
        })
        .await;
    }

    #[tokio::test]
    async fn json_broken_body() {
        assert_enveloped("UnknownBodyError (Json)", UNREADABLE_BODY, || {
            json_request("/json", broken_body())
        })
        .await;
    }

    #[tokio::test]
    async fn optional_json_content_type() {
        assert_enveloped(
            "MissingJsonContentType (Option<Json>)",
            NOT_JSON_CONTENT_TYPE,
            || {
                Request::post("/optional-json")
                    .header(header::CONTENT_TYPE, "text/plain")
                    .body(Body::from("{}"))
                    .unwrap()
            },
        )
        .await;
    }

    /// A request with no content type and no body reads as no JSON, as the
    /// framework's optional JSON does, and reaches the handler.
    #[tokio::test]
    async fn optional_json_absent() {
        let request = || Request::post("/optional-json").body(Body::empty()).unwrap();
        let framework = framework::app().oneshot(request()).await.unwrap();
        assert_eq!(framework.status(), axum::http::StatusCode::OK);
        let response = subject::app().oneshot(request()).await.unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
    }

    #[tokio::test]
    async fn query() {
        assert_enveloped("FailedToDeserializeQueryString", BAD_QUERY, || {
            Request::get("/query?count=x").body(Body::empty()).unwrap()
        })
        .await;
    }

    #[tokio::test]
    async fn path_utf8() {
        assert_enveloped("FailedToDeserializePathParams", BAD_PATH, || {
            Request::get("/path/%FF").body(Body::empty()).unwrap()
        })
        .await;
    }

    /// A route declared with more parameters than its handler takes is a
    /// fault of the router's assembly: the framework's sentence names its
    /// own extractor type.
    #[tokio::test]
    async fn path_wrong_number_of_parameters() {
        assert_enveloped("WrongNumberOfParameters", MISASSEMBLED, || {
            Request::get("/pair/a/b").body(Body::empty()).unwrap()
        })
        .await;
    }

    /// A handler's extension on a router assembled without its layer: the
    /// framework's sentence names the extension's Rust type.
    #[tokio::test]
    async fn extension_missing() {
        assert_enveloped("MissingExtension", MISASSEMBLED, || {
            Request::get("/extension").body(Body::empty()).unwrap()
        })
        .await;
    }

    #[tokio::test]
    async fn bytes_length_limit() {
        assert_enveloped("LengthLimitError (Bytes)", TOO_LARGE, || {
            Request::post("/bytes")
                .body(Body::from("x".repeat(LIMIT + 1)))
                .unwrap()
        })
        .await;
    }

    #[tokio::test]
    async fn bytes_broken_body() {
        assert_enveloped("UnknownBodyError (Bytes)", UNREADABLE_BODY, || {
            Request::post("/bytes").body(broken_body()).unwrap()
        })
        .await;
    }

    #[tokio::test]
    async fn multipart_boundary() {
        assert_enveloped("InvalidBoundary", NO_BOUNDARY, || {
            Request::post("/multipart")
                .header(header::CONTENT_TYPE, "multipart/form-data")
                .body(Body::empty())
                .unwrap()
        })
        .await;
    }

    /// The rejection a handler formats itself displays its sentence.
    #[tokio::test]
    async fn a_rejection_displays_its_sentence() {
        let cases: [(&str, Request<Body>); 2] = [
            (NOT_JSON, json_request("/json-display", "{")),
            (
                BAD_PATH,
                Request::get("/path-display/%FF")
                    .body(Body::empty())
                    .unwrap(),
            ),
        ];
        for (sentence, request) in cases {
            assert_eq!(
                body_text(subject::app().oneshot(request).await.unwrap()).await,
                sentence
            );
        }
    }

    /// Collects one line per event on the calling thread, `LEVEL name=value`
    /// per field. chan-server has plain `tracing` only.
    struct CapturedLogs(Arc<Mutex<Vec<String>>>);

    impl tracing::Subscriber for CapturedLogs {
        fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
            true
        }
        fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
            tracing::span::Id::from_u64(1)
        }
        fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
        fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
        fn event(&self, event: &tracing::Event<'_>) {
            struct Line(String);
            impl tracing::field::Visit for Line {
                fn record_debug(
                    &mut self,
                    field: &tracing::field::Field,
                    value: &dyn std::fmt::Debug,
                ) {
                    use std::fmt::Write as _;
                    let _ = write!(self.0, " {}={value:?}", field.name());
                }
            }
            let mut line = Line(event.metadata().level().to_string());
            event.record(&mut line);
            self.0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(line.0);
        }
        fn enter(&self, _: &tracing::span::Id) {}
        fn exit(&self, _: &tracing::span::Id) {}
    }

    /// Set in the re-run of [`a_rejection_logs_what_the_framework_said`]:
    /// the re-run captures and prints its log lines instead of asserting.
    const LOG_CHILD: &str = "CHAN_TEST_REJECTION_LOG_CHILD";

    /// What the framework said about a request goes to the log and not to
    /// the caller: at debug for a request its caller got wrong, at error for
    /// a route that cannot read its request.
    ///
    /// The capture runs in a re-run of this test alone in its process.
    /// tracing caches each callsite's interest process-wide, and a test on
    /// another thread that reaches the same event first, with no subscriber
    /// of its own, can store "never" for it; a capture in this process then
    /// misses the event.
    #[tokio::test]
    async fn a_rejection_logs_what_the_framework_said() {
        if std::env::var_os(LOG_CHILD).is_some() {
            let lines = Arc::new(Mutex::new(Vec::new()));
            let guard = tracing::subscriber::set_default(CapturedLogs(Arc::clone(&lines)));
            for request in [
                json_request("/json", r#""x""#),
                Request::get("/pair/a/b").body(Body::empty()).unwrap(),
            ] {
                subject::app().oneshot(request).await.unwrap();
            }
            drop(guard);
            // libtest can leave the line it names the test on unfinished.
            println!();
            for line in lines.lock().unwrap().iter() {
                println!("LOG={}", line.replace('\n', " "));
            }
            return;
        }
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            tokio::process::Command::new(std::env::current_exe().expect("test binary"))
                .args([
                    "--exact",
                    "extract::tests::a_rejection_logs_what_the_framework_said",
                    "--nocapture",
                ])
                .env(LOG_CHILD, "1")
                .kill_on_drop(true)
                .output(),
        )
        .await
        .expect("the re-run timed out")
        .expect("spawn the re-run");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success(),
            "the re-run failed:\n{stdout}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let logs: Vec<&str> = stdout
            .lines()
            .filter_map(|line| line.strip_prefix("LOG="))
            .collect();
        assert!(
            logs.iter().any(|line| line.starts_with("DEBUG")
                && line.contains("Failed to deserialize the JSON body into the target type")
                && line.contains("expected struct Probe")),
            "no debug line carries what the framework said of a body of the wrong type: {logs:#?}"
        );
        assert!(
            logs.iter()
                .any(|line| line.starts_with("ERROR")
                    && line.contains("Wrong number of path arguments")),
            "no error line carries what the framework said of a misassembled route: {logs:#?}"
        );
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
