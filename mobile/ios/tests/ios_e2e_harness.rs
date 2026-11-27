use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{delete, get, post, put};
use axum::{Form, Json, Router};
use base64::Engine as _;
use chan_server::{CreateWindow, TmuxRequest, WindowKind, WindowOrigin, WindowRecord};
use chan_wireguard::config::{Cidr, Config as WgConfig};
use chan_wireguard::x25519::{PublicKey, StaticSecret};
use chan_wireguard::{ConnectProxy, HostRoute, ProtectedDestinations, ProxyRoute, Tunnel};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UdpSocket;

fn ios_manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn strip_jsonc_line_comments(raw: &str) -> String {
    raw.lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn b64_std(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn b64_url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn s256_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    b64_url(&digest)
}

fn cidr_v4(a: u8, b: u8, c: u8, d: u8, prefix: u8) -> Cidr {
    Cidr {
        addr: IpAddr::V4(Ipv4Addr::new(a, b, c, d)),
        prefix,
    }
}

fn client_tunnel_config(
    client_secret: &StaticSecret,
    server_public_key: &str,
    endpoint: &str,
    client_addr: &str,
    allowed_ip: &str,
    keepalive: Option<u16>,
) -> Result<WgConfig, String> {
    let keepalive_line = keepalive
        .map(|secs| format!("PersistentKeepalive = {secs}\n"))
        .unwrap_or_default();
    let text = format!(
        "[Interface]\nPrivateKey = {}\nAddress = {client_addr}\n\n\
         [Peer]\nPublicKey = {server_public_key}\nEndpoint = {endpoint}\n\
         AllowedIPs = {allowed_ip}\n{keepalive_line}",
        b64_std(&client_secret.to_bytes())
    );
    WgConfig::parse(&text).map_err(|e| format!("parsing client wg config: {e}"))
}

async fn spawn_peer_tunnel(
    client_pub: &PublicKey,
    peer_secret: &StaticSecret,
    http_body: &'static str,
) -> (SocketAddr, Tunnel, tokio::task::JoinHandle<()>) {
    let udp = UdpSocket::bind("127.0.0.1:0")
        .await
        .expect("bind peer udp socket");
    let udp_addr = udp.local_addr().expect("peer udp local_addr");
    let peer_conf_text = format!(
        "[Interface]\nPrivateKey = {}\nAddress = 10.7.0.2/32\n\n\
         [Peer]\nPublicKey = {}\nEndpoint = 127.0.0.1:9\nAllowedIPs = 10.7.0.1/32\n",
        b64_std(&peer_secret.to_bytes()),
        b64_std(client_pub.as_bytes()),
    );
    let peer_conf = WgConfig::parse(&peer_conf_text).expect("valid peer wg config");
    let placeholder: SocketAddr = "127.0.0.1:9".parse().expect("valid placeholder socket");
    let tunnel = Tunnel::start_on(peer_conf, udp, placeholder).expect("start peer tunnel");
    let mut listener = tunnel.listen(8080).expect("listen inside peer tunnel");
    let task = tokio::spawn(async move {
        while let Ok(mut stream) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut b = [0u8; 1];
                while !buf.ends_with(b"\r\n\r\n") && buf.len() < 8192 {
                    match stream.read(&mut b).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => buf.push(b[0]),
                    }
                }
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    http_body.len(),
                    http_body
                );
                let _ = stream.write_all(resp.as_bytes()).await;
                let _ = stream.shutdown().await;
            });
        }
    });
    (udp_addr, tunnel, task)
}

#[derive(Clone)]
struct MockGatewayState {
    origin: String,
    proxy_apex: String,
    proxy_origin: String,
    wg_server_pubkey: String,
    wg_endpoint: String,
    pending_codes: Arc<Mutex<HashMap<String, PendingMobileCode>>>,
    tokens: Arc<Mutex<HashSet<String>>>,
    windows: Arc<Mutex<Vec<WindowRecord>>>,
    tmux_requests: Arc<Mutex<Vec<(String, TmuxRequest)>>>,
    visibility_updates: Arc<Mutex<Vec<(String, bool)>>>,
    label_updates: Arc<Mutex<Vec<(String, String)>>>,
}

#[derive(Clone)]
struct PendingMobileCode {
    challenge: String,
    label: String,
    wireguard_key: Option<String>,
}

#[derive(Deserialize)]
struct MobileAuthorizeQuery {
    redirect_uri: String,
    state: String,
    label: String,
    code_challenge: String,
    code_challenge_method: String,
    scopes: Option<String>,
    expires_in: Option<i64>,
    wireguard_public_key: Option<String>,
}

#[derive(Deserialize)]
struct ConfirmForm {
    action: String,
    code: String,
    state: String,
}

#[derive(Deserialize)]
struct RedeemBody {
    code: String,
    code_verifier: String,
}

#[derive(Deserialize)]
struct EntryRequestBody {
    path: String,
    devserver_id: Option<String>,
}

#[derive(Deserialize)]
struct EntryExchangeForm {
    credential: String,
}

#[derive(Deserialize)]
struct VisibilityBody {
    hidden: bool,
}

#[derive(Deserialize)]
struct LabelBody {
    label: String,
}

fn valid_wg_pubkey(raw: &str) -> bool {
    if raw.len() != 44 {
        return false;
    }
    base64::engine::general_purpose::STANDARD
        .decode(raw)
        .is_ok_and(|bytes| bytes.len() == 32 && b64_std(&bytes) == raw)
}

fn valid_mobile_redirect(raw: &str) -> bool {
    if raw != "chan://auth/callback" {
        return false;
    }
    url::Url::parse(raw).is_ok_and(|u| {
        u.scheme() == "chan"
            && u.host_str() == Some("auth")
            && u.path() == "/callback"
            && u.port().is_none()
            && u.query().is_none()
            && u.fragment().is_none()
            && u.username().is_empty()
            && u.password().is_none()
    })
}

async fn handle_discovery(State(st): State<MockGatewayState>) -> Json<Value> {
    Json(json!({
        "kind": "chan-gateway",
        "api_version": 1,
        "identity_origin": st.origin,
        "mobile_authorize_url": format!("{}/mobile/authorize", st.origin),
        "mobile_entry_url": format!("{}/mobile/v1/devserver/entry", st.origin),
        "mobile_roster_url": format!("{}/mobile/v1/devservers", st.origin),
        "devserver_proxy_origin": st.proxy_apex,
        "devserver_proxy_host_depth": 2,
        "wireguard": {
            "mobile_enrollment": true,
            "endpoint": st.wg_endpoint,
            "public_key": st.wg_server_pubkey,
            "allowed_ips": ["10.7.0.2/32"],
            "persistent_keepalive": 5,
            "ingresses": [{
                "id": "p1",
                "endpoint": st.wg_endpoint,
                "public_key": st.wg_server_pubkey,
                "hosts": [
                    { "name": "p1.wg-e2e.invalid", "addresses": ["10.7.0.2"] },
                    { "name": "*.p1.wg-e2e.invalid", "addresses": ["10.7.0.2"] }
                ]
            }]
        }
    }))
}

async fn handle_mobile_authorize(
    State(st): State<MockGatewayState>,
    Query(q): Query<MobileAuthorizeQuery>,
) -> Response {
    if !valid_mobile_redirect(&q.redirect_uri) {
        return (StatusCode::BAD_REQUEST, "invalid redirect_uri").into_response();
    }
    if q.code_challenge_method != "S256" || q.code_challenge.len() != 43 {
        return (StatusCode::BAD_REQUEST, "invalid pkce challenge").into_response();
    }
    if q.state.is_empty() || q.state.len() > 256 {
        return (StatusCode::BAD_REQUEST, "invalid state").into_response();
    }
    let label = q.label.trim();
    if label.is_empty() || label.len() > 64 {
        return (StatusCode::BAD_REQUEST, "invalid label").into_response();
    }
    if q.scopes.as_deref() != Some("mobile.account") {
        return (StatusCode::BAD_REQUEST, "invalid scopes").into_response();
    }
    if q.expires_in.unwrap_or(0) <= 0 {
        return (StatusCode::BAD_REQUEST, "invalid expires_in").into_response();
    }
    if let Some(ref key) = q.wireguard_public_key {
        if !valid_wg_pubkey(key) {
            return (StatusCode::BAD_REQUEST, "invalid wireguard_public_key").into_response();
        }
    }
    let code = format!("code-{}", uuid::Uuid::new_v4());
    st.pending_codes.lock().unwrap().insert(
        code.clone(),
        PendingMobileCode {
            challenge: q.code_challenge,
            label: label.to_string(),
            wireguard_key: q.wireguard_public_key,
        },
    );
    let consent = format!("/mobile/authorize/consent?code={code}&state={}", q.state);
    Redirect::to(&consent).into_response()
}

#[derive(Deserialize)]
struct ConsentQuery {
    code: String,
    state: String,
}

async fn handle_mobile_consent(Query(q): Query<ConsentQuery>) -> Response {
    let html = format!(
        "<html><body><form method='post' action='/mobile/authorize/confirm'>\
         <input type='hidden' name='code' value='{}'/>\
         <input type='hidden' name='state' value='{}'/>\
         <button name='action' value='allow'>Allow</button></form></body></html>",
        q.code, q.state
    );
    (StatusCode::OK, [(header::CONTENT_TYPE, "text/html")], html).into_response()
}

async fn handle_mobile_confirm(
    State(st): State<MockGatewayState>,
    Form(form): Form<ConfirmForm>,
) -> Response {
    let target = if form.action == "allow" {
        format!(
            "chan://auth/callback?code={}&state={}",
            form.code, form.state
        )
    } else {
        let _ = st.pending_codes.lock().unwrap().remove(&form.code);
        format!(
            "chan://auth/callback?error=user_cancelled&state={}",
            form.state
        )
    };
    let html = format!(
        "<!doctype html><html><head><meta http-equiv=\"refresh\" content=\"0;url={target}\"></head></html>"
    );
    (StatusCode::OK, [(header::CONTENT_TYPE, "text/html")], html).into_response()
}

async fn handle_mobile_redeem(
    State(st): State<MockGatewayState>,
    Json(body): Json<RedeemBody>,
) -> Response {
    let pending = st.pending_codes.lock().unwrap().remove(&body.code);
    let Some(entry) = pending else {
        return (
            StatusCode::GONE,
            Json(json!({ "error": "unknown, expired, or already-redeemed code" })),
        )
            .into_response();
    };
    if s256_challenge(&body.code_verifier) != entry.challenge {
        return (
            StatusCode::GONE,
            Json(json!({ "error": "unknown, expired, or already-redeemed code" })),
        )
            .into_response();
    }
    let secret = format!("pat-{}", uuid::Uuid::new_v4());
    st.tokens.lock().unwrap().insert(secret.clone());
    let mut payload = json!({
        "id": uuid::Uuid::new_v4(),
        "secret": secret,
        "label": entry.label,
        "expires_at": Value::Null,
    });
    if entry.wireguard_key.is_some() {
        payload["wireguard"] = json!({
            "server_public_key": st.wg_server_pubkey,
            "endpoint": st.wg_endpoint,
            "addresses": ["10.7.0.1/32"],
            "allowed_ips": ["10.7.0.2/32"],
            "persistent_keepalive": 5,
            "hosts": [
                { "name": "p1.wg-e2e.invalid", "addresses": ["10.7.0.2"] },
                { "name": "*.p1.wg-e2e.invalid", "addresses": ["10.7.0.2"] }
            ],
            "ingresses": [{
                "id": "p1",
                "server_public_key": st.wg_server_pubkey,
                "endpoint": st.wg_endpoint,
                "hosts": [
                    { "name": "p1.wg-e2e.invalid", "addresses": ["10.7.0.2"] },
                    { "name": "*.p1.wg-e2e.invalid", "addresses": ["10.7.0.2"] }
                ]
            }]
        });
    }
    Json(payload).into_response()
}

fn authorized_bearer(headers: &HeaderMap, tokens: &Mutex<HashSet<String>>) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|tok| tokens.lock().unwrap().contains(tok))
}

async fn handle_roster(State(st): State<MockGatewayState>, headers: HeaderMap) -> Response {
    if !authorized_bearer(&headers, &st.tokens) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(json!({
        "user_id": "11111111-1111-4111-8111-111111111111",
        "username": "alice",
        "devservers": [{
            "owner_user_id": "11111111-1111-4111-8111-111111111111",
            "owner": "alice",
            "devserver_id": "0123456789abcdef0001",
            "label": "e2e-box",
            "online": true,
            "proxy_origin": st.proxy_origin
        }]
    }))
    .into_response()
}

async fn handle_entry(
    State(st): State<MockGatewayState>,
    headers: HeaderMap,
    Json(req): Json<EntryRequestBody>,
) -> Response {
    if !authorized_bearer(&headers, &st.tokens) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let _ = req.path;
    let ds_id = req
        .devserver_id
        .unwrap_or_else(|| "0123456789abcdef0001".to_string());
    Json(json!({
        "owner_user_id": "11111111-1111-4111-8111-111111111111",
        "username": "alice",
        "devserver_id": ds_id,
        "proxy_origin": st.proxy_origin,
        "entry_exchange_url": format!("{}/_chan/entry", st.proxy_origin),
        "entry_credential": "entry-cred-e2e"
    }))
    .into_response()
}

async fn handle_entry_exchange(Form(form): Form<EntryExchangeForm>) -> Response {
    if form.credential != "entry-cred-e2e" {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    (
        StatusCode::SEE_OTHER,
        axum::response::AppendHeaders([
            (header::LOCATION, "/".to_string()),
            (
                header::SET_COOKIE,
                "__Host-devserver_gate=gate-e2e; Path=/; HttpOnly; SameSite=Lax".to_string(),
            ),
            (
                header::SET_COOKIE,
                "__Host-devserver_csrf=csrf-e2e; Path=/; SameSite=Lax".to_string(),
            ),
        ]),
    )
        .into_response()
}

async fn handle_list_windows(State(st): State<MockGatewayState>) -> Json<Vec<WindowRecord>> {
    Json(st.windows.lock().unwrap().clone())
}

async fn handle_create_window(
    State(st): State<MockGatewayState>,
    Json(req): Json<CreateWindow>,
) -> Json<WindowRecord> {
    let mut windows = st.windows.lock().unwrap();
    let idx = windows.len() + 1;
    let record = WindowRecord {
        window_id: format!("w-{idx}"),
        library_id: "lib-e2e001".into(),
        kind: req.kind,
        title: format!("Window {idx}"),
        ordinal: idx as u32,
        label: String::new(),
        workspace_path: req.workspace_path,
        prefix: match req.kind {
            WindowKind::Terminal => "/terminal".into(),
            WindowKind::Workspace => "/api/notes-1a2b3c".into(),
        },
        token: String::new(),
        persisted: true,
        connected: false,
        holders: Some(vec![]),
        active_transfer: false,
        control: false,
        tmux: None,
        hidden: false,
        origin: req.origin,
        start_terminal: req.start_terminal,
    };
    windows.push(record.clone());
    Json(record)
}

async fn handle_delete_window(
    State(st): State<MockGatewayState>,
    AxumPath(window_id): AxumPath<String>,
) -> StatusCode {
    let mut windows = st.windows.lock().unwrap();
    let before = windows.len();
    windows.retain(|w| w.window_id != window_id);
    if windows.len() < before {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
}

async fn handle_visibility(
    State(st): State<MockGatewayState>,
    AxumPath(window_id): AxumPath<String>,
    Json(body): Json<VisibilityBody>,
) -> StatusCode {
    let mut windows = st.windows.lock().unwrap();
    let Some(w) = windows.iter_mut().find(|w| w.window_id == window_id) else {
        return StatusCode::NOT_FOUND;
    };
    w.hidden = body.hidden;
    st.visibility_updates
        .lock()
        .unwrap()
        .push((window_id, body.hidden));
    StatusCode::NO_CONTENT
}

async fn handle_label(
    State(st): State<MockGatewayState>,
    AxumPath(window_id): AxumPath<String>,
    Json(body): Json<LabelBody>,
) -> Response {
    let trimmed = body.label.trim();
    if trimmed.chars().count() > 64 {
        return (StatusCode::BAD_REQUEST, "label exceeds 64 chars").into_response();
    }
    if trimmed.chars().any(char::is_control) {
        return (StatusCode::BAD_REQUEST, "label contains control chars").into_response();
    }
    let mut windows = st.windows.lock().unwrap();
    let Some(w) = windows.iter_mut().find(|w| w.window_id == window_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if w.control {
        return (
            StatusCode::BAD_REQUEST,
            "control terminals cannot have a label",
        )
            .into_response();
    }
    w.label = trimmed.to_string();
    st.label_updates
        .lock()
        .unwrap()
        .push((window_id, w.label.clone()));
    StatusCode::NO_CONTENT.into_response()
}

async fn handle_tmux_request(
    State(st): State<MockGatewayState>,
    AxumPath(conn): AxumPath<String>,
    body: Option<Json<TmuxRequest>>,
) -> Response {
    let Some(Json(req)) = body else {
        return (StatusCode::BAD_REQUEST, "missing tmux request json").into_response();
    };
    st.tmux_requests.lock().unwrap().push((conn, req));
    StatusCode::NO_CONTENT.into_response()
}

async fn spawn_mock_gateway(
    wg_server_pubkey: String,
    wg_endpoint: String,
) -> (String, MockGatewayState, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock gateway");
    let addr = listener.local_addr().expect("mock gateway addr");
    let origin = format!("http://127.0.0.1:{}", addr.port());
    let proxy_apex = format!("http://localtest.me:{}", addr.port());
    let proxy_origin = format!("http://alice--0123456789ab.p1.localtest.me:{}", addr.port());
    let initial_windows = vec![
        WindowRecord {
            window_id: "w-ctrl".into(),
            library_id: "lib-e2e001".into(),
            kind: WindowKind::Terminal,
            title: "Control Terminal".into(),
            ordinal: 1,
            label: String::new(),
            workspace_path: None,
            prefix: "/terminal".into(),
            token: String::new(),
            persisted: true,
            connected: false,
            holders: Some(vec![]),
            active_transfer: false,
            control: true,
            tmux: None,
            hidden: false,
            origin: WindowOrigin::Native,
            start_terminal: false,
        },
        WindowRecord {
            window_id: "w-hidden".into(),
            library_id: "lib-e2e001".into(),
            kind: WindowKind::Workspace,
            title: "chan Window 1".into(),
            ordinal: 1,
            label: String::new(),
            workspace_path: Some("/srv/notes".into()),
            prefix: "/api/notes-1a2b3c".into(),
            token: String::new(),
            persisted: true,
            connected: false,
            holders: Some(vec![]),
            active_transfer: false,
            control: false,
            tmux: None,
            hidden: true,
            origin: WindowOrigin::Native,
            start_terminal: true,
        },
    ];
    let state = MockGatewayState {
        origin: origin.clone(),
        proxy_apex,
        proxy_origin,
        wg_server_pubkey,
        wg_endpoint,
        pending_codes: Arc::new(Mutex::new(HashMap::new())),
        tokens: Arc::new(Mutex::new(HashSet::new())),
        windows: Arc::new(Mutex::new(initial_windows)),
        tmux_requests: Arc::new(Mutex::new(Vec::new())),
        visibility_updates: Arc::new(Mutex::new(Vec::new())),
        label_updates: Arc::new(Mutex::new(Vec::new())),
    };
    let app = Router::new()
        .route("/.well-known/chan-gateway", get(handle_discovery))
        .route("/mobile/authorize", get(handle_mobile_authorize))
        .route("/mobile/authorize/consent", get(handle_mobile_consent))
        .route("/mobile/authorize/confirm", post(handle_mobile_confirm))
        .route("/mobile/authorize/redeem", post(handle_mobile_redeem))
        .route("/mobile/v1/devservers", get(handle_roster))
        .route("/mobile/v1/devserver/entry", post(handle_entry))
        .route("/_chan/entry", post(handle_entry_exchange))
        .route(
            "/api/library/windows",
            get(handle_list_windows).post(handle_create_window),
        )
        .route("/api/library/windows/{id}", delete(handle_delete_window))
        .route(
            "/api/library/windows/{id}/visibility",
            post(handle_visibility),
        )
        .route("/api/library/windows/{id}/label", put(handle_label))
        .route(
            "/api/library/tmux/{conn}/request",
            post(handle_tmux_request),
        )
        .with_state(state.clone());
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (origin, state, handle)
}

#[derive(Deserialize)]
struct RedeemJson {
    secret: String,
    wireguard: Option<RedeemWireguard>,
}

#[derive(Deserialize)]
struct RedeemWireguard {
    server_public_key: String,
    endpoint: String,
    addresses: Vec<String>,
    allowed_ips: Vec<String>,
    persistent_keepalive: Option<u16>,
    ingresses: Vec<RedeemIngress>,
}

#[derive(Deserialize)]
struct RedeemIngress {
    id: String,
    server_public_key: String,
    endpoint: String,
    hosts: Vec<RedeemHost>,
}

#[derive(Deserialize)]
struct RedeemHost {
    name: String,
    addresses: Vec<IpAddr>,
}

// ---------------------------------------------------------------------------
// F1: Version pins (0.135.0) and iOS deployment floor (17.0)
// ---------------------------------------------------------------------------

#[test]
fn f1_ios_version_and_deployment_floor_manifests_align() {
    let dir = ios_manifest_dir();

    let tauri_raw =
        std::fs::read_to_string(dir.join("tauri.conf.json5")).expect("read tauri.conf.json5");
    let tauri_json: Value =
        serde_json::from_str(&strip_jsonc_line_comments(&tauri_raw)).expect("parse tauri.conf");
    assert_eq!(tauri_json["version"].as_str(), Some("0.135.0"));
    assert_eq!(tauri_json["identifier"].as_str(), Some("app.chan.ios"));
    assert_eq!(
        tauri_json["bundle"]["iOS"]["minimumSystemVersion"].as_str(),
        Some("17.0")
    );

    let plist = std::fs::read_to_string(dir.join("gen/apple/chan-ios_iOS/Info.plist"))
        .expect("read Info.plist");
    assert!(
        plist.contains("<key>CFBundleShortVersionString</key>\n\t<string>0.135.0</string>"),
        "Info.plist CFBundleShortVersionString must be 0.135.0"
    );
    assert!(
        plist.contains("<key>CFBundleVersion</key>\n\t<string>0.135.0</string>"),
        "Info.plist CFBundleVersion must be 0.135.0"
    );
    assert!(
        plist.contains("<key>NSAllowsLocalNetworking</key>\n\t\t<true/>"),
        "Info.plist must enable NSAllowsLocalNetworking"
    );

    let project_yml =
        std::fs::read_to_string(dir.join("gen/apple/project.yml")).expect("read project.yml");
    assert!(
        project_yml.contains("iOS: 17.0"),
        "project.yml deploymentTarget.iOS must be 17.0"
    );
    assert!(
        project_yml.contains("CFBundleShortVersionString: 0.135.0"),
        "project.yml CFBundleShortVersionString must be 0.135.0"
    );

    let podfile = std::fs::read_to_string(dir.join("gen/apple/Podfile")).expect("read Podfile");
    assert!(
        podfile.contains("platform :ios, '17.0'"),
        "Podfile platform must be iOS 17.0"
    );
}

#[test]
fn f1_permissions_and_ios_capability_schemas_are_valid() {
    let dir = ios_manifest_dir();
    let app_toml_raw =
        std::fs::read_to_string(dir.join("permissions/app.toml")).expect("read app.toml");
    let parsed_toml: toml::Value = toml::from_str(&app_toml_raw).expect("valid permissions TOML");
    let perms = parsed_toml["permission"]
        .as_array()
        .expect("permission table array");
    assert!(
        perms
            .iter()
            .any(|p| p["identifier"].as_str() == Some("allow-mobile-back-to-computers")),
        "base permission allow-mobile-back-to-computers must exist"
    );

    let cap_raw =
        std::fs::read_to_string(dir.join("capabilities/ios.json")).expect("read ios.json");
    let cap_json: Value = serde_json::from_str(&cap_raw).expect("valid capability JSON");
    assert_eq!(cap_json["windows"], json!(["main"]));
    let urls = cap_json["remote"]["urls"]
        .as_array()
        .expect("remote.urls array");
    assert!(urls.contains(&json!("http://127.0.0.1:*")));
    assert!(urls.contains(&json!("http://localhost:*")));
}

// ---------------------------------------------------------------------------
// F2: Mobile OAuth PKCE + WireGuard enrollment + ConnectProxy routing
// ---------------------------------------------------------------------------

async fn enroll_mock_gateway(
    http: &reqwest::Client,
    origin: &str,
    client_pub: &PublicKey,
    verifier: &str,
    state_nonce: &str,
) -> RedeemJson {
    let disc: Value = http
        .get(format!("{origin}/.well-known/chan-gateway"))
        .send()
        .await
        .expect("discovery")
        .json()
        .await
        .expect("discovery json");
    assert_eq!(disc["wireguard"]["mobile_enrollment"], json!(true));
    let authorize_url = disc["mobile_authorize_url"]
        .as_str()
        .expect("mobile_authorize_url");

    let challenge = s256_challenge(verifier);
    let auth_resp = http
        .get(authorize_url)
        .query(&[
            ("redirect_uri", "chan://auth/callback"),
            ("state", state_nonce),
            ("label", "iphone-e2e"),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("scopes", "mobile.account"),
            ("expires_in", "3600"),
            ("wireguard_public_key", &b64_std(client_pub.as_bytes())),
        ])
        .send()
        .await
        .expect("authorize request");
    assert_eq!(auth_resp.status(), StatusCode::SEE_OTHER);
    let consent_loc = auth_resp
        .headers()
        .get(header::LOCATION)
        .unwrap()
        .to_str()
        .unwrap();
    let consent_url = url::Url::parse(&format!("{origin}{consent_loc}")).unwrap();
    let code = consent_url
        .query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.into_owned())
        .expect("code param");

    let confirm_resp = http
        .post(format!("{origin}/mobile/authorize/confirm"))
        .form(&[
            ("action", "allow"),
            ("code", code.as_str()),
            ("state", state_nonce),
        ])
        .send()
        .await
        .expect("confirm request");
    assert_eq!(confirm_resp.status(), StatusCode::OK);
    let handoff_html = confirm_resp.text().await.unwrap();
    assert!(handoff_html.contains(&format!(
        "chan://auth/callback?code={code}&state={state_nonce}"
    )));

    let redeem_resp = http
        .post(format!("{origin}/mobile/authorize/redeem"))
        .json(&json!({ "code": code, "code_verifier": verifier }))
        .send()
        .await
        .expect("redeem request");
    assert_eq!(redeem_resp.status(), StatusCode::OK);
    let redeemed: RedeemJson = redeem_resp.json().await.expect("redeem json");
    assert!(!redeemed.secret.is_empty());

    let replay_resp = http
        .post(format!("{origin}/mobile/authorize/redeem"))
        .json(&json!({ "code": code, "code_verifier": verifier }))
        .send()
        .await
        .expect("replay request");
    assert_eq!(replay_resp.status(), StatusCode::GONE);

    redeemed
}

async fn setup_enrolled_proxy_fixture(
    seed: u8,
) -> (
    String,
    Arc<ConnectProxy>,
    Tunnel,
    Tunnel,
    tokio::task::JoinHandle<()>,
    tokio::task::JoinHandle<()>,
) {
    let client_secret = StaticSecret::from([seed; 32]);
    let client_pub = PublicKey::from(&client_secret);
    let peer_secret = StaticSecret::from([seed.wrapping_add(4); 32]);
    let peer_pub = PublicKey::from(&peer_secret);

    let (udp_addr, peer_tunnel, peer_task) =
        spawn_peer_tunnel(&client_pub, &peer_secret, "hello-from-p1").await;
    let (origin, _state, gw_task) =
        spawn_mock_gateway(b64_std(peer_pub.as_bytes()), udp_addr.to_string()).await;

    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("http client");
    let redeemed = enroll_mock_gateway(
        &http,
        &origin,
        &client_pub,
        "e2e-pkce-verifier-0123456789abcdef012345678",
        "nonce-f2-happy",
    )
    .await;
    let wg = redeemed.wireguard.expect("enrolled wireguard params");
    assert_eq!(wg.ingresses.len(), 1);
    assert_eq!(wg.endpoint, udp_addr.to_string());
    assert_eq!(wg.server_public_key, b64_std(peer_pub.as_bytes()));

    let client_conf = client_tunnel_config(
        &client_secret,
        &wg.ingresses[0].server_public_key,
        &wg.ingresses[0].endpoint,
        &wg.addresses[0],
        &wg.allowed_ips[0],
        wg.persistent_keepalive,
    )
    .expect("client wg config");
    let client_tunnel = Tunnel::start(client_conf).expect("start client tunnel");
    let host_routes: Vec<HostRoute> = wg.ingresses[0]
        .hosts
        .iter()
        .map(|h| HostRoute {
            name: h.name.clone(),
            addresses: h.addresses.clone(),
        })
        .collect();
    let proxy = Arc::new(
        ConnectProxy::bind_routed_with_loopback_bypass(
            Vec::new(),
            SocketAddr::from(([127, 0, 0, 1], 0)),
        )
        .await
        .expect("bind proxy"),
    );
    let protected = ProtectedDestinations {
        hosts: vec!["p1.wg-e2e.invalid".into(), "*.p1.wg-e2e.invalid".into()],
        networks: vec![cidr_v4(10, 7, 0, 2, 32)],
    };
    proxy
        .replace_protected_routes(
            vec![(
                "gw/p1".to_string(),
                ProxyRoute {
                    tunnel: client_tunnel.clone(),
                    hosts: host_routes,
                },
            )],
            protected,
        )
        .expect("publish protected route")
        .wait()
        .await;

    (
        origin,
        proxy,
        client_tunnel,
        peer_tunnel,
        peer_task,
        gw_task,
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn f2_wg_tunnel_proxy_forwards_protected_host() {
    let (_origin, proxy, client_tunnel, peer_tunnel, peer_task, gw_task) =
        setup_enrolled_proxy_fixture(7).await;

    let proxied_http = reqwest::Client::builder()
        .proxy(reqwest::Proxy::http(format!("http://{}", proxy.local_addr())).unwrap())
        .timeout(Duration::from_secs(10))
        .build()
        .expect("proxied http client");
    let body = proxied_http
        .get("http://alice.p1.wg-e2e.invalid:8080/ping")
        .send()
        .await
        .expect("proxied tunnel fetch")
        .text()
        .await
        .expect("proxied body");
    assert_eq!(body, "hello-from-p1");

    drop(proxy);
    drop(client_tunnel);
    drop(peer_tunnel);
    peer_task.abort();
    gw_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn f2_loopback_bypass_stays_direct_with_protected_routes() {
    let (origin, proxy, client_tunnel, peer_tunnel, peer_task, gw_task) =
        setup_enrolled_proxy_fixture(9).await;

    let proxied_http = reqwest::Client::builder()
        .proxy(reqwest::Proxy::http(format!("http://{}", proxy.local_addr())).unwrap())
        .timeout(Duration::from_secs(10))
        .build()
        .expect("proxied http client");
    let disc_via_proxy = proxied_http
        .get(format!("{origin}/.well-known/chan-gateway"))
        .send()
        .await
        .expect("loopback bypass fetch");
    assert_eq!(disc_via_proxy.status(), StatusCode::OK);

    drop(proxy);
    drop(client_tunnel);
    drop(peer_tunnel);
    peer_task.abort();
    gw_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn f2_neg_invalid_redirect_and_wg_key_rejected() {
    let peer_secret = StaticSecret::from([22u8; 32]);
    let peer_pub = PublicKey::from(&peer_secret);
    let (origin, _state, gw_task) =
        spawn_mock_gateway(b64_std(peer_pub.as_bytes()), "127.0.0.1:51820".into()).await;

    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();

    let challenge = s256_challenge("verifier-with-43-bytes-0123456789abcdefghij");
    for bad_redirect in [
        "http://127.0.0.1:8080/auth/callback",
        "chan:///auth/callback",
        "chan://auth/callback?x=1",
        "chan://auth:9000/callback",
        "chan://user@auth/callback",
    ] {
        let resp = http
            .get(format!("{origin}/mobile/authorize"))
            .query(&[
                ("redirect_uri", bad_redirect),
                ("state", "s1"),
                ("label", "iphone"),
                ("code_challenge", &challenge),
                ("code_challenge_method", "S256"),
                ("scopes", "mobile.account"),
                ("expires_in", "3600"),
            ])
            .send()
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::BAD_REQUEST,
            "redirect_uri {bad_redirect} must be rejected"
        );
    }

    let bad_key_resp = http
        .get(format!("{origin}/mobile/authorize"))
        .query(&[
            ("redirect_uri", "chan://auth/callback"),
            ("state", "s2"),
            ("label", "iphone"),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("scopes", "mobile.account"),
            ("expires_in", "3600"),
            ("wireguard_public_key", "not-a-valid-key"),
        ])
        .send()
        .await
        .unwrap();
    assert_eq!(bad_key_resp.status(), StatusCode::BAD_REQUEST);

    let ok_auth = http
        .get(format!("{origin}/mobile/authorize"))
        .query(&[
            ("redirect_uri", "chan://auth/callback"),
            ("state", "s3"),
            ("label", "iphone"),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("scopes", "mobile.account"),
            ("expires_in", "3600"),
        ])
        .send()
        .await
        .unwrap();
    let loc = ok_auth
        .headers()
        .get(header::LOCATION)
        .unwrap()
        .to_str()
        .unwrap();
    let code = url::Url::parse(&format!("{origin}{loc}"))
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "code")
        .unwrap()
        .1
        .into_owned();
    let mismatch = http
        .post(format!("{origin}/mobile/authorize/redeem"))
        .json(&json!({ "code": code, "code_verifier": "wrong-verifier-value" }))
        .send()
        .await
        .unwrap();
    assert_eq!(mismatch.status(), StatusCode::GONE);

    gw_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn f2_neg_wrong_wg_peer_key_fails_tunnel_proxy() {
    let client_secret = StaticSecret::from([21u8; 32]);
    let client_pub = PublicKey::from(&client_secret);
    let peer_secret = StaticSecret::from([23u8; 32]);

    let (udp_addr, peer_tunnel, peer_task) =
        spawn_peer_tunnel(&client_pub, &peer_secret, "unreachable").await;
    let wrong_peer_pub = PublicKey::from(&StaticSecret::from([99u8; 32]));
    let bad_wg_conf = client_tunnel_config(
        &client_secret,
        &b64_std(wrong_peer_pub.as_bytes()),
        &udp_addr.to_string(),
        "10.7.0.1/32",
        "10.7.0.2/32",
        None,
    )
    .unwrap();
    let bad_tunnel = Tunnel::start(bad_wg_conf).unwrap();
    let proxy = Arc::new(
        ConnectProxy::bind_routed_with_loopback_bypass(
            Vec::new(),
            SocketAddr::from(([127, 0, 0, 1], 0)),
        )
        .await
        .unwrap(),
    );
    proxy
        .replace_protected_routes(
            vec![(
                "gw/bad".into(),
                ProxyRoute {
                    tunnel: bad_tunnel.clone(),
                    hosts: vec![HostRoute {
                        name: "bad.wg-e2e.invalid".into(),
                        addresses: vec![IpAddr::V4(Ipv4Addr::new(10, 7, 0, 2))],
                    }],
                },
            )],
            ProtectedDestinations {
                hosts: vec!["bad.wg-e2e.invalid".into()],
                networks: vec![cidr_v4(10, 7, 0, 2, 32)],
            },
        )
        .unwrap()
        .wait()
        .await;

    let proxied = reqwest::Client::builder()
        .proxy(reqwest::Proxy::http(format!("http://{}", proxy.local_addr())).unwrap())
        .timeout(Duration::from_secs(6))
        .build()
        .unwrap();
    let err_or_status = proxied
        .get("http://bad.wg-e2e.invalid:8080/ping")
        .send()
        .await;
    if let Ok(resp) = err_or_status {
        assert!(resp.status().is_server_error(), "got {}", resp.status());
    }

    drop(proxy);
    drop(bad_tunnel);
    drop(peer_tunnel);
    peer_task.abort();
}

// ---------------------------------------------------------------------------
// F3: Stopped-tunnel retirement, sibling preservation, and restart recovery
// ---------------------------------------------------------------------------

struct TwoIngressFixture {
    proxy: Arc<ConnectProxy>,
    client: reqwest::Client,
    t1: Tunnel,
    t2: Tunnel,
    c1_secret: StaticSecret,
    p1_pub: PublicKey,
    udp1: SocketAddr,
    h1: Vec<HostRoute>,
    h2: Vec<HostRoute>,
    protected: ProtectedDestinations,
    _peer1_tunnel: Tunnel,
    _peer2_tunnel: Tunnel,
    peer1_task: tokio::task::JoinHandle<()>,
    peer2_task: tokio::task::JoinHandle<()>,
}

impl TwoIngressFixture {
    fn make_conf1(&self) -> WgConfig {
        client_tunnel_config(
            &self.c1_secret,
            &b64_std(self.p1_pub.as_bytes()),
            &self.udp1.to_string(),
            "10.7.0.1/32",
            "10.7.0.2/32",
            Some(5),
        )
        .unwrap()
    }
}

async fn setup_two_ingress_fixture(base_seed: u8) -> TwoIngressFixture {
    let c1_secret = StaticSecret::from([base_seed; 32]);
    let c1_pub = PublicKey::from(&c1_secret);
    let p1_secret = StaticSecret::from([base_seed.wrapping_add(1); 32]);
    let p1_pub = PublicKey::from(&p1_secret);

    let c2_secret = StaticSecret::from([base_seed.wrapping_add(10); 32]);
    let c2_pub = PublicKey::from(&c2_secret);
    let p2_secret = StaticSecret::from([base_seed.wrapping_add(11); 32]);
    let p2_pub = PublicKey::from(&p2_secret);

    let (udp1, peer1_tunnel, peer1_task) = spawn_peer_tunnel(&c1_pub, &p1_secret, "from-p1").await;
    let (udp2, peer2_tunnel, peer2_task) = spawn_peer_tunnel(&c2_pub, &p2_secret, "from-p2").await;

    let conf1 = client_tunnel_config(
        &c1_secret,
        &b64_std(p1_pub.as_bytes()),
        &udp1.to_string(),
        "10.7.0.1/32",
        "10.7.0.2/32",
        Some(5),
    )
    .unwrap();
    let conf2 = client_tunnel_config(
        &c2_secret,
        &b64_std(p2_pub.as_bytes()),
        &udp2.to_string(),
        "10.7.0.1/32",
        "10.7.0.2/32",
        Some(5),
    )
    .unwrap();

    let t1 = Tunnel::start(conf1).unwrap();
    let t2 = Tunnel::start(conf2).unwrap();

    let h1 = vec![HostRoute {
        name: "*.p1.wg-e2e.invalid".into(),
        addresses: vec![IpAddr::V4(Ipv4Addr::new(10, 7, 0, 2))],
    }];
    let h2 = vec![HostRoute {
        name: "*.p2.wg-e2e.invalid".into(),
        addresses: vec![IpAddr::V4(Ipv4Addr::new(10, 7, 0, 2))],
    }];
    let protected = ProtectedDestinations {
        hosts: vec!["*.p1.wg-e2e.invalid".into(), "*.p2.wg-e2e.invalid".into()],
        networks: vec![cidr_v4(10, 7, 0, 2, 32)],
    };

    let proxy = Arc::new(
        ConnectProxy::bind_routed_with_loopback_bypass(
            Vec::new(),
            SocketAddr::from(([127, 0, 0, 1], 0)),
        )
        .await
        .unwrap(),
    );
    proxy
        .replace_protected_routes(
            vec![
                (
                    "gw/p1".into(),
                    ProxyRoute {
                        tunnel: t1.clone(),
                        hosts: h1.clone(),
                    },
                ),
                (
                    "gw/p2".into(),
                    ProxyRoute {
                        tunnel: t2.clone(),
                        hosts: h2.clone(),
                    },
                ),
            ],
            protected.clone(),
        )
        .unwrap()
        .wait()
        .await;

    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::http(format!("http://{}", proxy.local_addr())).unwrap())
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();

    TwoIngressFixture {
        proxy,
        client,
        t1,
        t2,
        c1_secret,
        p1_pub,
        udp1,
        h1,
        h2,
        protected,
        _peer1_tunnel: peer1_tunnel,
        _peer2_tunnel: peer2_tunnel,
        peer1_task,
        peer2_task,
    }
}

impl Drop for TwoIngressFixture {
    fn drop(&mut self) {
        self.peer1_task.abort();
        self.peer2_task.abort();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn f3_two_ingress_independent_routes() {
    let f = setup_two_ingress_fixture(31).await;
    assert_eq!(
        f.client
            .get("http://a.p1.wg-e2e.invalid:8080/")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "from-p1"
    );
    assert_eq!(
        f.client
            .get("http://a.p2.wg-e2e.invalid:8080/")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "from-p2"
    );
    assert!(!f.t1.is_closed());
    assert!(!f.t2.is_closed());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn f3_route_retirement_preserves_sibling_tunnel() {
    let f = setup_two_ingress_fixture(35).await;
    f.proxy
        .replace_protected_routes(
            vec![(
                "gw/p2".into(),
                ProxyRoute {
                    tunnel: f.t2.clone(),
                    hosts: f.h2.clone(),
                },
            )],
            f.protected.clone(),
        )
        .unwrap()
        .wait()
        .await;

    assert!(
        !f.t2.is_closed(),
        "preserved sibling tunnel t2 must stay open"
    );
    assert_eq!(
        f.client
            .get("http://a.p2.wg-e2e.invalid:8080/")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "from-p2"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn f3_retired_tunnel_reports_is_closed() {
    let f = setup_two_ingress_fixture(39).await;
    assert!(!f.t1.is_closed());
    f.proxy
        .replace_protected_routes(
            vec![(
                "gw/p2".into(),
                ProxyRoute {
                    tunnel: f.t2.clone(),
                    hosts: f.h2.clone(),
                },
            )],
            f.protected.clone(),
        )
        .unwrap()
        .wait()
        .await;

    assert!(
        f.t1.is_closed(),
        "retired tunnel t1 must report is_closed()"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn f3_neg_protected_host_without_tunnel_refuses_502() {
    let f = setup_two_ingress_fixture(43).await;
    f.proxy
        .replace_protected_routes(
            vec![(
                "gw/p2".into(),
                ProxyRoute {
                    tunnel: f.t2.clone(),
                    hosts: f.h2.clone(),
                },
            )],
            f.protected.clone(),
        )
        .unwrap()
        .wait()
        .await;

    let p1_refused = f
        .client
        .get("http://a.p1.wg-e2e.invalid:8080/")
        .send()
        .await
        .expect("proxy refusal response");
    assert_eq!(
        p1_refused.status(),
        StatusCode::BAD_GATEWAY,
        "protected host without live tunnel must fail closed with 502"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn f3_stopped_tunnel_restarts_and_recovers_traffic() {
    let f = setup_two_ingress_fixture(47).await;
    f.proxy
        .replace_protected_routes(
            vec![(
                "gw/p2".into(),
                ProxyRoute {
                    tunnel: f.t2.clone(),
                    hosts: f.h2.clone(),
                },
            )],
            f.protected.clone(),
        )
        .unwrap()
        .wait()
        .await;
    assert!(f.t1.is_closed());

    let t1_restarted = Tunnel::start(f.make_conf1()).unwrap();
    f.proxy
        .replace_protected_routes(
            vec![
                (
                    "gw/p1".into(),
                    ProxyRoute {
                        tunnel: t1_restarted.clone(),
                        hosts: f.h1.clone(),
                    },
                ),
                (
                    "gw/p2".into(),
                    ProxyRoute {
                        tunnel: f.t2.clone(),
                        hosts: f.h2.clone(),
                    },
                ),
            ],
            f.protected.clone(),
        )
        .unwrap()
        .wait()
        .await;

    assert!(!t1_restarted.is_closed());
    assert_eq!(
        f.client
            .get("http://a.p1.wg-e2e.invalid:8080/")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "from-p1"
    );
    drop(t1_restarted);
}

// ---------------------------------------------------------------------------
// F4 & F7: Gateway roster/entry/cookies + window CRUD/label/visibility/tmux
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn f4_gateway_entry_exchange_sets_gate_and_csrf_cookies() {
    let client_secret = StaticSecret::from([51u8; 32]);
    let client_pub = PublicKey::from(&client_secret);
    let (origin, _state, gw_task) =
        spawn_mock_gateway(b64_std(client_pub.as_bytes()), "127.0.0.1:51820".into()).await;

    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let redeemed = enroll_mock_gateway(
        &http,
        &origin,
        &client_pub,
        "f4-entry-pkce-verifier-0123456789abcdef0123",
        "s-f4-entry",
    )
    .await;

    let roster: Value = http
        .get(format!("{origin}/mobile/v1/devservers"))
        .bearer_auth(&redeemed.secret)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        roster["devservers"][0]["devserver_id"],
        "0123456789abcdef0001"
    );

    let entry: Value = http
        .post(format!("{origin}/mobile/v1/devserver/entry"))
        .bearer_auth(&redeemed.secret)
        .json(&json!({ "path": "/", "devserver_id": "0123456789abcdef0001" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let exchange_resp = http
        .post(format!("{origin}/_chan/entry"))
        .form(&[("credential", entry["entry_credential"].as_str().unwrap())])
        .send()
        .await
        .unwrap();
    assert_eq!(exchange_resp.status(), StatusCode::SEE_OTHER);
    let cookies: Vec<String> = exchange_resp
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok().map(str::to_string))
        .collect();
    assert!(cookies
        .iter()
        .any(|c| c.starts_with("__Host-devserver_gate=")));
    assert!(cookies
        .iter()
        .any(|c| c.starts_with("__Host-devserver_csrf=")));

    gw_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn f4_unauth_roster_returns_401() {
    let client_pub = PublicKey::from(&StaticSecret::from([52u8; 32]));
    let (origin, _state, gw_task) =
        spawn_mock_gateway(b64_std(client_pub.as_bytes()), "127.0.0.1:51820".into()).await;
    let http = reqwest::Client::new();
    assert_eq!(
        http.get(format!("{origin}/mobile/v1/devservers"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    gw_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn f7_remote_window_visibility_unhide_and_hide() {
    let client_pub = PublicKey::from(&StaticSecret::from([53u8; 32]));
    let (origin, state, gw_task) =
        spawn_mock_gateway(b64_std(client_pub.as_bytes()), "127.0.0.1:51820".into()).await;
    let http = reqwest::Client::new();

    let initial: Vec<WindowRecord> = http
        .get(format!("{origin}/api/library/windows"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(initial
        .iter()
        .any(|w| w.window_id == "w-hidden" && w.hidden));

    assert_eq!(
        http.post(format!("{origin}/api/library/windows/w-hidden/visibility"))
            .json(&json!({ "hidden": false }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        http.post(format!("{origin}/api/library/windows/w-hidden/visibility"))
            .json(&json!({ "hidden": true }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );

    let vis = state.visibility_updates.lock().unwrap();
    assert_eq!(
        vis.as_slice(),
        &[
            ("w-hidden".to_string(), false),
            ("w-hidden".to_string(), true)
        ]
    );
    gw_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn f7_remote_window_label_set_clear_and_validation() {
    let client_pub = PublicKey::from(&StaticSecret::from([54u8; 32]));
    let (origin, _state, gw_task) =
        spawn_mock_gateway(b64_std(client_pub.as_bytes()), "127.0.0.1:51820".into()).await;
    let http = reqwest::Client::new();

    let created: WindowRecord = http
        .post(format!("{origin}/api/library/windows"))
        .json(&CreateWindow {
            kind: WindowKind::Workspace,
            workspace_path: Some("/srv/notes".into()),
            origin: WindowOrigin::Native,
            start_terminal: true,
            acting_window_id: None,
        })
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(created.start_terminal);

    assert_eq!(
        http.put(format!(
            "{origin}/api/library/windows/{}/label",
            created.window_id
        ))
        .json(&json!({ "label": "dev / box [1] & test" }))
        .send()
        .await
        .unwrap()
        .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        http.put(format!(
            "{origin}/api/library/windows/{}/label",
            created.window_id
        ))
        .json(&json!({ "label": "" }))
        .send()
        .await
        .unwrap()
        .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        http.put(format!(
            "{origin}/api/library/windows/{}/label",
            created.window_id
        ))
        .json(&json!({ "label": "x".repeat(65) }))
        .send()
        .await
        .unwrap()
        .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        http.put(format!(
            "{origin}/api/library/windows/{}/label",
            created.window_id
        ))
        .json(&json!({ "label": "bad\nline" }))
        .send()
        .await
        .unwrap()
        .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        http.put(format!("{origin}/api/library/windows/w-ctrl/label"))
            .json(&json!({ "label": "nope" }))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );

    gw_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn f7_remote_tmux_percent_encoded_request() {
    let client_pub = PublicKey::from(&StaticSecret::from([55u8; 32]));
    let (origin, state, gw_task) =
        spawn_mock_gateway(b64_std(client_pub.as_bytes()), "127.0.0.1:51820".into()).await;
    let http = reqwest::Client::new();

    let mut tmux_url = url::Url::parse(&origin).unwrap();
    tmux_url
        .path_segments_mut()
        .unwrap()
        .extend(["api", "library", "tmux", "term/one", "request"]);
    assert!(tmux_url.as_str().contains("term%2Fone/request"));

    assert_eq!(
        http.post(tmux_url.clone())
            .json(&TmuxRequest::Split {
                pane: "%1".into(),
                horizontal: true,
            })
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        http.post(tmux_url)
            .json(&TmuxRequest::NewWindow)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );

    let tmux_log = state.tmux_requests.lock().unwrap();
    assert_eq!(tmux_log.len(), 2);
    assert_eq!(tmux_log[0].0, "term/one");

    gw_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn f7_remote_window_delete_and_404_idempotency() {
    let client_pub = PublicKey::from(&StaticSecret::from([56u8; 32]));
    let (origin, _state, gw_task) =
        spawn_mock_gateway(b64_std(client_pub.as_bytes()), "127.0.0.1:51820".into()).await;
    let http = reqwest::Client::new();

    let created: WindowRecord = http
        .post(format!("{origin}/api/library/windows"))
        .json(&CreateWindow {
            kind: WindowKind::Terminal,
            workspace_path: None,
            origin: WindowOrigin::Native,
            start_terminal: false,
            acting_window_id: None,
        })
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    assert_eq!(
        http.delete(format!(
            "{origin}/api/library/windows/{}",
            created.window_id
        ))
        .send()
        .await
        .unwrap()
        .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        http.delete(format!(
            "{origin}/api/library/windows/{}",
            created.window_id
        ))
        .send()
        .await
        .unwrap()
        .status(),
        StatusCode::NOT_FOUND
    );

    gw_task.abort();
}

// ---------------------------------------------------------------------------
// Live wg-peer integration arm driven by scripts/e2e/ios/run-wireguard-mock-e2e.sh
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires live mock-gateway.mjs and wg-peer processes launched by run-wireguard-mock-e2e.sh"]
async fn live_wg_peer_matrix() {
    let origin =
        std::env::var("CHAN_IOS_E2E_MOCK_ORIGIN").expect("CHAN_IOS_E2E_MOCK_ORIGIN must be set");
    let client_priv_b64 =
        std::env::var("CHAN_IOS_E2E_CLIENT_PRIV").expect("CHAN_IOS_E2E_CLIENT_PRIV must be set");
    let probe_red = std::env::var("CHAN_IOS_E2E_PROBE_RED").ok().as_deref() == Some("1");

    let priv_bytes: [u8; 32] = base64::engine::general_purpose::STANDARD
        .decode(client_priv_b64.trim())
        .expect("decode client private key")
        .try_into()
        .expect("32-byte client key");
    let client_secret = StaticSecret::from(priv_bytes);
    let client_pub = PublicKey::from(&client_secret);

    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();

    // 1. Fetch discovery from mock-gateway.mjs.
    let disc: Value = http
        .get(format!("{origin}/.well-known/chan-gateway"))
        .send()
        .await
        .expect("discovery")
        .json()
        .await
        .expect("discovery json");
    assert_eq!(disc["wireguard"]["mobile_enrollment"], json!(true));
    let ingresses_disc = disc["wireguard"]["ingresses"]
        .as_array()
        .expect("discovery ingresses");
    assert!(
        ingresses_disc.len() >= 2,
        "need at least 2 live wg-peer ingresses"
    );

    // 2. Complete /mobile/authorize -> chan://auth/callback -> /mobile/authorize/redeem.
    let verifier = "live-wg-peer-verifier-0123456789abcdef012345";
    let challenge = s256_challenge(verifier);
    let auth_resp = http
        .get(disc["mobile_authorize_url"].as_str().unwrap())
        .query(&[
            ("redirect_uri", "chan://auth/callback"),
            ("state", "live-wg-state"),
            ("label", "ios-live-e2e"),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("scopes", "mobile.account"),
            ("expires_in", "3600"),
            ("wireguard_public_key", &b64_std(client_pub.as_bytes())),
        ])
        .send()
        .await
        .expect("authorize");
    assert_eq!(auth_resp.status(), StatusCode::FOUND);
    let loc = auth_resp
        .headers()
        .get(header::LOCATION)
        .unwrap()
        .to_str()
        .unwrap();
    let callback = url::Url::parse(loc).expect("chan:// callback url");
    let code = callback
        .query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.into_owned())
        .expect("code in callback");

    let redeem_verifier = if probe_red {
        "mutated-wrong-verifier"
    } else {
        verifier
    };
    let redeem_resp = http
        .post(format!("{origin}/mobile/authorize/redeem"))
        .json(&json!({ "code": code, "code_verifier": redeem_verifier }))
        .send()
        .await
        .expect("redeem");
    assert_eq!(redeem_resp.status(), StatusCode::OK, "redeem status check");
    let redeemed: RedeemJson = redeem_resp.json().await.expect("redeem json");
    let wg = redeemed.wireguard.expect("wireguard payload");
    assert_eq!(wg.ingresses.len(), 2);

    // 3. Start both tunnels against the two live wg-peer processes and wire ConnectProxy.
    let mut routes = Vec::new();
    let mut tunnels = Vec::new();
    let mut protected_hosts = Vec::new();
    for ingress in &wg.ingresses {
        let conf = client_tunnel_config(
            &client_secret,
            &ingress.server_public_key,
            &ingress.endpoint,
            &wg.addresses[0],
            &wg.allowed_ips[0],
            wg.persistent_keepalive,
        )
        .unwrap();
        let tunnel = Tunnel::start(conf).expect("start live client tunnel");
        let hosts: Vec<HostRoute> = ingress
            .hosts
            .iter()
            .map(|h| {
                protected_hosts.push(h.name.clone());
                HostRoute {
                    name: h.name.clone(),
                    addresses: h.addresses.clone(),
                }
            })
            .collect();
        tunnels.push((ingress.id.clone(), tunnel.clone(), hosts.clone()));
        routes.push((format!("gw/{}", ingress.id), ProxyRoute { tunnel, hosts }));
    }

    let protected = ProtectedDestinations {
        hosts: protected_hosts,
        networks: vec![cidr_v4(10, 7, 0, 2, 32)],
    };
    let proxy = Arc::new(
        ConnectProxy::bind_routed_with_loopback_bypass(
            Vec::new(),
            SocketAddr::from(([127, 0, 0, 1], 0)),
        )
        .await
        .unwrap(),
    );
    proxy
        .replace_protected_routes(routes, protected.clone())
        .unwrap()
        .wait()
        .await;

    let proxied = reqwest::Client::builder()
        .proxy(reqwest::Proxy::http(format!("http://{}", proxy.local_addr())).unwrap())
        .timeout(Duration::from_secs(12))
        .build()
        .unwrap();

    // 4. Verify live HTTP traffic flows through BOTH wg-peer forwarders into mock-gateway.mjs.
    for (id, _, hosts) in &tunnels {
        let probe_host = hosts
            .iter()
            .find(|h| !h.name.starts_with("*."))
            .expect("exact host")
            .name
            .clone();
        let resp = proxied
            .get(format!(
                "http://{probe_host}:8080/api/library/windows?via={id}"
            ))
            .send()
            .await
            .expect("proxied fetch via wg-peer");
        assert_eq!(resp.status(), StatusCode::OK, "ingress {id} proxied fetch");
    }

    // 5. Retire p1 and confirm p1.is_closed() == true while p2 stays live and continues forwarding.
    let p2_host = tunnels[1]
        .2
        .iter()
        .find(|h| !h.name.starts_with("*."))
        .unwrap()
        .name
        .clone();
    let p1_host = tunnels[0]
        .2
        .iter()
        .find(|h| !h.name.starts_with("*."))
        .unwrap()
        .name
        .clone();

    proxy
        .replace_protected_routes(
            vec![(
                "gw/p2".into(),
                ProxyRoute {
                    tunnel: tunnels[1].1.clone(),
                    hosts: tunnels[1].2.clone(),
                },
            )],
            protected,
        )
        .unwrap()
        .wait()
        .await;

    assert!(tunnels[0].1.is_closed(), "retired p1 tunnel must be closed");
    assert!(
        !tunnels[1].1.is_closed(),
        "sibling p2 tunnel must remain open"
    );

    let p1_after = proxied
        .get(format!(
            "http://{p1_host}:8080/api/library/windows?via=p1-retired"
        ))
        .send()
        .await
        .expect("retired p1 refusal");
    assert_eq!(p1_after.status(), StatusCode::BAD_GATEWAY);

    let p2_after = proxied
        .get(format!(
            "http://{p2_host}:8080/api/library/windows?via=p2-sibling"
        ))
        .send()
        .await
        .expect("sibling p2 still live");
    assert_eq!(p2_after.status(), StatusCode::OK);
}
