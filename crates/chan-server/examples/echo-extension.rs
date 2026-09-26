//! Minimal extension acceptance fixture: a text field that echoes its value.

use std::fmt::Write as _;
use std::io::Write as _;

use axum::extract::{Query, State};
use axum::http::{HeaderName, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;

use chan_server::EXTENSION_HANDSHAKE_MARKER;

#[derive(Clone)]
struct EchoState {
    token: String,
}

#[derive(Deserialize)]
struct AuthQuery {
    t: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if let Some(pid_file) = std::env::args_os().nth(1) {
        std::fs::write(pid_file, std::process::id().to_string())?;
    }
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let address = listener.local_addr()?;
    let token = random_token();
    let app = Router::new().route("/", get(index)).with_state(EchoState {
        token: token.clone(),
    });

    let handshake = serde_json::json!({
        "url": format!("http://{address}/"),
        "token": token,
    });
    println!("{EXTENSION_HANDSHAKE_MARKER}{handshake}");
    std::io::stdout().flush()?;

    axum::serve(listener, app).await?;
    Ok(())
}

async fn index(State(state): State<EchoState>, Query(auth): Query<AuthQuery>) -> Response {
    if auth.t.as_deref() != Some(state.token.as_str()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let mut response = Html(ECHO_HTML).into_response();
    let headers = response.headers_mut();
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'; base-uri 'none'",
        ),
    );
    headers.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        HeaderName::from_static("cache-control"),
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    response
}

fn random_token() -> String {
    let bytes: [u8; 32] = rand::random();
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut token, "{byte:02x}").expect("writing to a String cannot fail");
    }
    token
}

const ECHO_HTML: &str = include_str!("echo-extension.html");
