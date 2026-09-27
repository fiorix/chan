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

    /// The same routes over whichever `Json`, `Query` and `Path` are in scope
    /// where the macro is invoked.
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
                .layer(DefaultBodyLimit::max(LIMIT))
        };
    }

    mod framework {
        use super::*;
        use axum::extract::{Path, Query};
        use axum::Json;

        pub(super) fn app() -> Router {
            probe_routes!()
        }
    }

    mod subject {
        use super::*;
        // The extractors under test.
        use axum::extract::{Path, Query};
        use axum::Json;

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
