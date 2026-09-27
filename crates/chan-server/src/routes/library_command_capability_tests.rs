use std::sync::{Arc, RwLock};

use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use axum::response::Response;
use chan_library::window_presence::PresenceGuard;
use chan_library::windows::WindowRegistry;
use chan_library::{DevserverFeedSource, LauncherWorkspace};
use chan_workspace::Library;
use tower::ServiceExt;

use super::{launcher_router, tenant_config};
use crate::route_authority::test_support::Caller;
use crate::{WindowKind, WindowOrigin, WindowRecord, WorkspaceHost};

struct RemoteFeed;

impl DevserverFeedSource for RemoteFeed {
    fn windows(&self) -> Vec<WindowRecord> {
        vec![WindowRecord {
            window_id: "remote-window-must-not-leak".into(),
            library_id: "lib-remote".into(),
            kind: WindowKind::Terminal,
            title: "Remote terminal".into(),
            ordinal: 1,
            label: String::new(),
            workspace_path: None,
            prefix: "/remote-terminal".into(),
            token: "remote-tenant-secret".into(),
            persisted: true,
            connected: true,
            active_transfer: false,
            control: false,
            hidden: false,
            origin: WindowOrigin::Native,
        }]
    }

    fn workspaces(&self) -> Vec<LauncherWorkspace> {
        Vec::new()
    }

    fn pane_color(&self, _library_id: &str) -> Option<String> {
        None
    }
}

struct LocalFeed(String);

impl DevserverFeedSource for LocalFeed {
    fn windows(&self) -> Vec<WindowRecord> {
        let mut rows = RemoteFeed.windows();
        rows[0].library_id = self.0.clone();
        rows[0].window_id = "feed-window".into();
        rows
    }

    fn workspaces(&self) -> Vec<LauncherWorkspace> {
        Vec::new()
    }

    fn pane_color(&self, _library_id: &str) -> Option<String> {
        None
    }
}

struct Fixture {
    _config: tempfile::TempDir,
    _store: tempfile::TempDir,
    _workspace: tempfile::TempDir,
    host: Arc<WorkspaceHost>,
    prefix: String,
    window_id: String,
    tenant_token: String,
    presence: Option<PresenceGuard>,
}

async fn fixture() -> Fixture {
    fixture_with_registry(true, false).await
}

async fn fixture_with_registry(registry: bool, local_feed: bool) -> Fixture {
    let config = tempfile::tempdir().unwrap();
    let store = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let library = Library::open_at(config.path().join("config.toml")).unwrap();
    let row = library.register_workspace(workspace.path()).unwrap();
    let host = Arc::new(WorkspaceHost::new(library, crate::route_builder()));
    if registry {
        host.install_window_registry(
            Arc::new(WindowRegistry::open(store.path().join("windows.json"))),
            "local".into(),
        );
    }
    if local_feed {
        host.install_devserver_feed(Arc::new(LocalFeed(host.library_id().into())));
    } else {
        host.install_devserver_feed(Arc::new(RemoteFeed));
    }
    let prefix = chan_library::allocate_workspace_prefix(workspace.path()).unwrap();
    host.open_or_get_registered_workspace(
        workspace.path(),
        tenant_config("127.0.0.1:0".parse().unwrap(), &prefix),
    )
    .await
    .expect("mount invoking workspace");
    // The record stores the registry row's root, as the window route does;
    // the tempdir's own spelling is only an alias of it wherever the temp
    // path is not canonical.
    let (window_id, tenant_token) = if registry {
        let record = host
            .mint_window_with_origin(
                WindowKind::Workspace,
                Some(row.root_path.to_string_lossy().into_owned()),
                WindowOrigin::Browser,
            )
            .expect("mint invoking window");
        (record.window_id, record.token)
    } else {
        ("unregistered-invoker".into(), String::new())
    };
    let presence = host
        .test_connect_window_presence(&prefix, &window_id)
        .expect("connect invoking window");
    Fixture {
        _config: config,
        _store: store,
        _workspace: workspace,
        host,
        prefix,
        window_id,
        tenant_token,
        presence: Some(presence),
    }
}

async fn send(
    router: &axum::Router,
    method: &str,
    uri: &str,
    bearer: Option<&str>,
    body: Option<serde_json::Value>,
) -> Response {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(bearer) = bearer {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {bearer}"));
    }
    let body = if let Some(body) = body {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
        Body::from(body.to_string())
    } else {
        Body::empty()
    };
    router
        .clone()
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap()
}

async fn json(response: Response) -> (StatusCode, serde_json::Value) {
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, value)
}

fn mint_body(fixture: &Fixture) -> serde_json::Value {
    serde_json::json!({
        "window_id": fixture.window_id,
        "tenant_prefix": fixture.prefix,
    })
}

fn count_path(capability: &str, window_id: &str) -> String {
    format!("/api/library/command-capabilities/{capability}/windows/{window_id}/live-terminals")
}

async fn mint(router: &axum::Router, fixture: &Fixture) -> String {
    let minted = send(
        router,
        "POST",
        "/api/library/command-capabilities",
        None,
        Some(mint_body(fixture)),
    )
    .await;
    let (status, minted) = json(minted).await;
    assert_eq!(status, StatusCode::OK, "mint");
    minted["token"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn mint_requires_the_same_tenant_token_and_redacts_snapshot_tokens() {
    let fixture = fixture().await;

    // A second valid tenant token passes the broad surface gate, but must not
    // authorize the invoking window from the first tenant.
    let other = tempfile::tempdir().unwrap();
    let other_row = fixture
        .host
        .library()
        .register_workspace(other.path())
        .unwrap();
    let other_prefix = chan_library::allocate_workspace_prefix(other.path()).unwrap();
    fixture
        .host
        .open_or_get_registered_workspace(
            other.path(),
            tenant_config("127.0.0.1:0".parse().unwrap(), &other_prefix),
        )
        .await
        .expect("mount other workspace");
    let other_record = fixture
        .host
        .mint_window_with_origin(
            WindowKind::Workspace,
            Some(other_row.root_path.to_string_lossy().into_owned()),
            WindowOrigin::Browser,
        )
        .unwrap();

    let router = launcher_router(
        fixture.host.clone(),
        Some(Arc::new(RwLock::new("launcher-secret".into()))),
        None,
    );
    for wrong in [&other_record.token, "launcher-secret"] {
        let response = send(
            &router,
            "POST",
            "/api/library/command-capabilities",
            Some(wrong),
            Some(mint_body(&fixture)),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    let minted = send(
        &router,
        "POST",
        "/api/library/command-capabilities",
        Some(&fixture.tenant_token),
        Some(mint_body(&fixture)),
    )
    .await;
    assert_eq!(minted.status(), StatusCode::OK);
    assert_eq!(minted.headers()[header::CACHE_CONTROL], "no-store, private");
    assert_eq!(minted.headers()[header::REFERRER_POLICY], "no-referrer");
    let (_, minted) = json(minted).await;
    let capability = minted["token"].as_str().unwrap();

    let snapshot = send(
        &router,
        "GET",
        &format!("/api/library/command-capabilities/{capability}"),
        None,
        None,
    )
    .await;
    assert_eq!(snapshot.status(), StatusCode::OK);
    let (_, snapshot) = json(snapshot).await;
    let wire = snapshot.to_string();
    assert!(!wire.contains(&fixture.tenant_token));
    assert!(!wire.contains(&other_record.token));
    assert!(!wire.contains("remote-window-must-not-leak"));
    assert!(!wire.contains("remote-tenant-secret"));
    assert_eq!(snapshot["library_id"], fixture.host.library_id());
    for window in snapshot["windows"].as_array().unwrap() {
        assert!(window.get("token").is_none());
        assert!(window.get("prefix").is_none());
        assert!(window.get("library_id").is_none());
    }
}

#[tokio::test]
async fn capability_dies_with_its_invoking_window() {
    let mut fixture = fixture().await;
    let router = launcher_router(fixture.host.clone(), None, None);
    let minted = send(
        &router,
        "POST",
        "/api/library/command-capabilities",
        None,
        Some(mint_body(&fixture)),
    )
    .await;
    let (_, minted) = json(minted).await;
    let capability = minted["token"].as_str().unwrap().to_string();

    drop(fixture.presence.take());
    let response = send(
        &router,
        "GET",
        &format!("/api/library/command-capabilities/{capability}"),
        None,
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::GONE);
}

/// The count route resolves the capability before it looks at any window, so a
/// capability whose invoking window has gone reads no count. It gets its own
/// fixture because the first refusal drops the capability from the live set,
/// after which any second use is an unknown token rather than a dead one.
#[tokio::test]
async fn a_capability_counts_nothing_once_its_invoking_window_is_gone() {
    let mut fixture = fixture().await;
    let router = launcher_router(fixture.host.clone(), None, None);
    let capability = mint(&router, &fixture).await;

    drop(fixture.presence.take());
    let response = send(
        &router,
        "GET",
        &count_path(&capability, &fixture.window_id),
        None,
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::GONE);
}

/// A capability is bound to its invoking window for liveness and scoped to the
/// library for reach: the snapshot lists every window of this library and the
/// close action discards any non-control one. Counting a sibling window's
/// terminals is therefore intended, not a leak, and it is strictly less than
/// the discard the same capability already performs on that window. The figure
/// is the launcher route's, so the two surfaces never disagree.
#[tokio::test]
async fn a_capability_counts_terminals_in_any_non_control_window_of_its_library() {
    let fixture = fixture().await;
    let sibling = fixture
        .host
        .mint_window_with_origin(WindowKind::Terminal, None, WindowOrigin::Browser)
        .expect("mint sibling window");
    let tenant = fixture.host.clone().router();
    let created = tenant
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("{}/api/terminals", fixture.prefix))
                .header(
                    header::AUTHORIZATION,
                    format!("Bearer {}", fixture.tenant_token),
                )
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "name": "counted",
                        "command": "sh",
                        "window_id": sibling.window_id,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::CREATED);

    let router = launcher_router(fixture.host.clone(), None, None);
    let capability = mint(&router, &fixture).await;
    for (window_id, expected) in [
        (fixture.window_id.clone(), 0),
        (sibling.window_id.clone(), 1),
    ] {
        let scoped = send(
            &router,
            "GET",
            &count_path(&capability, &window_id),
            None,
            None,
        )
        .await;
        let (status, scoped) = json(scoped).await;
        assert_eq!(status, StatusCode::OK, "window {window_id}");
        assert_eq!(scoped["count"], expected, "window {window_id}");
        let launcher = send(
            &router,
            "GET",
            &format!("/api/library/windows/{window_id}/live-terminals"),
            None,
            None,
        )
        .await;
        let (status, launcher) = json(launcher).await;
        assert_eq!(status, StatusCode::OK, "window {window_id}");
        assert_eq!(launcher["count"], scoped["count"], "window {window_id}");
    }
}

/// The window rule is the close action's rather than the launch redirect's:
/// this library, and not a control terminal. A connected devserver's feed row
/// belongs to another library, and a control row is refused outright, so a
/// capability may ask only about windows it could also close.
#[tokio::test]
async fn a_capability_counts_no_foreign_or_control_window() {
    let fixture = fixture().await;
    let router = launcher_router(fixture.host.clone(), None, None);
    let capability = mint(&router, &fixture).await;

    for beyond in ["remote-window-must-not-leak", "no-such-window"] {
        let response = send(&router, "GET", &count_path(&capability, beyond), None, None).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "window {beyond}");
    }

    // A control row is tagged with the FOREIGN devserver library id, so the
    // library filter hides it on its own. Tag one with this host's id to reach
    // the control check behind it: the close action refuses a control terminal
    // the same way and the two rules must not drift apart.
    fixture
        .host
        .mint_control_window(
            "control-terminal-local".into(),
            fixture.host.library_id().to_string(),
            fixture.prefix.clone(),
        )
        .expect("mint control window");
    let response = send(
        &router,
        "GET",
        &count_path(&capability, "control-terminal-local"),
        None,
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

/// The capability is the whole credential: an unknown one is refused before any
/// window is read, so the route adds no unauthenticated view of the library.
#[tokio::test]
async fn an_unknown_capability_counts_nothing() {
    let fixture = fixture().await;
    let router = launcher_router(fixture.host.clone(), None, None);
    let response = send(
        &router,
        "GET",
        &count_path("not-a-capability", &fixture.window_id),
        None,
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

/// A grant is all-or-nothing: a grantee's mint yields the capability the
/// owner's does, and the grantee inspects the library and acts on it with
/// that capability.
#[tokio::test]
async fn a_grantee_capability_inspects_and_acts_like_the_owner() {
    let fixture = fixture().await;
    let router = launcher_router(fixture.host.clone(), None, None);
    for caller in Caller::ALL {
        let request = |method: &str, uri: &str, body: Option<serde_json::Value>| {
            let mut builder = caller.stamp(Request::builder().method(method).uri(uri), None);
            let body = match body {
                Some(body) => {
                    builder = builder.header(header::CONTENT_TYPE, "application/json");
                    Body::from(body.to_string())
                }
                None => Body::empty(),
            };
            router.clone().oneshot(builder.body(body).unwrap())
        };

        let minted = request(
            "POST",
            "/api/library/command-capabilities",
            Some(mint_body(&fixture)),
        )
        .await
        .unwrap();
        let (status, minted) = json(minted).await;
        assert_eq!(status, StatusCode::OK, "{caller:?} mint");
        let capability = minted["token"].as_str().unwrap().to_string();

        let snapshot = request(
            "GET",
            &format!("/api/library/command-capabilities/{capability}"),
            None,
        )
        .await
        .unwrap();
        let (status, snapshot) = json(snapshot).await;
        assert_eq!(status, StatusCode::OK, "{caller:?} inspect");
        assert!(
            !snapshot["windows"].as_array().unwrap().is_empty(),
            "{caller:?} inspect"
        );

        let action = request(
            "POST",
            &format!("/api/library/command-capabilities/{capability}/actions"),
            Some(serde_json::json!({ "action": "new_terminal" })),
        )
        .await
        .unwrap();
        let (status, action) = json(action).await;
        assert_eq!(status, StatusCode::OK, "{caller:?} act");
        assert!(action["window"]["window_id"].is_string(), "{caller:?} act");
    }
}

mod refusal_envelopes {
    use super::super::refusal_envelopes::assert_refusal;
    use super::*;

    async fn check(response: Response, status: StatusCode, message: &str) {
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "no-store, private"
        );
        assert_eq!(response.headers()[header::REFERRER_POLICY], "no-referrer");
        assert_refusal(response, status, message).await;
    }

    async fn action_refusal(
        action: serde_json::Value,
        registry: bool,
        status: StatusCode,
        message: &str,
    ) {
        let fixture = fixture_with_registry(registry, true).await;
        let app = launcher_router(fixture.host.clone(), None, None);
        let cap = mint(&app, &fixture).await;
        check(
            send(
                &app,
                "POST",
                &format!("/api/library/command-capabilities/{cap}/actions"),
                None,
                Some(action),
            )
            .await,
            status,
            message,
        )
        .await;
    }

    macro_rules! action_refusals {
        ($($name:ident: ($action:tt, $registry:literal, $status:ident, $message:literal)),+ $(,)?) => {$(
            #[tokio::test]
            async fn $name() {
                action_refusal(serde_json::json!($action), $registry, StatusCode::$status, $message).await;
            }
        )+};
    }

    action_refusals! {
        action_workspace_missing: ({"action":"new_workspace_window", "workspace_id":"missing"}, true, NOT_FOUND, "workspace not found"),
        action_visibility_missing: ({"action":"set_window_visibility", "window_id":"missing", "hidden":true}, true, NOT_FOUND, "window not found"),
        action_visibility_unregistered: ({"action":"set_window_visibility", "window_id":"feed-window", "hidden":true}, true, NOT_FOUND, "window not found"),
        action_visibility_no_registry: ({"action":"set_window_visibility", "window_id":"feed-window", "hidden":true}, false, INTERNAL_SERVER_ERROR, "config: window registry not installed"),
        action_close_missing: ({"action":"close_window", "window_id":"missing"}, true, NOT_FOUND, "window not found"),
        action_close_unregistered: ({"action":"close_window", "window_id":"feed-window"}, true, NOT_FOUND, "window not found"),
        action_close_no_registry: ({"action":"close_window", "window_id":"feed-window"}, false, INTERNAL_SERVER_ERROR, "config: window registry not installed"),
        action_mint_no_registry: ({"action":"new_terminal"}, false, INTERNAL_SERVER_ERROR, "config: window registry not installed"),
    }

    #[tokio::test]
    async fn command_count_missing() {
        let fixture = fixture().await;
        let app = launcher_router(fixture.host.clone(), None, None);
        let cap = mint(&app, &fixture).await;
        check(
            send(&app, "GET", &count_path(&cap, "missing"), None, None).await,
            StatusCode::NOT_FOUND,
            "window not found",
        )
        .await;
    }

    #[tokio::test]
    async fn command_launch_missing() {
        let fixture = fixture().await;
        let app = launcher_router(fixture.host.clone(), None, None);
        let cap = mint(&app, &fixture).await;
        check(
            send(
                &app,
                "GET",
                &format!("/api/library/command-capabilities/{cap}/windows/missing/launch"),
                None,
                None,
            )
            .await,
            StatusCode::NOT_FOUND,
            "window not found",
        )
        .await;
    }

    #[tokio::test]
    async fn invalid_invoking_window() {
        let fixture = fixture().await;
        let app = launcher_router(fixture.host.clone(), None, None);
        check(
            send(
                &app,
                "POST",
                "/api/library/command-capabilities",
                None,
                Some(serde_json::json!({"window_id":"", "tenant_prefix":fixture.prefix})),
            )
            .await,
            StatusCode::BAD_REQUEST,
            "invalid invoking window",
        )
        .await;
    }

    #[tokio::test]
    async fn unowned_invoking_window() {
        let fixture = fixture().await;
        let app = launcher_router(
            fixture.host.clone(),
            Some(Arc::new(RwLock::new("launcher-secret".into()))),
            None,
        );
        check(
            send(
                &app,
                "POST",
                "/api/library/command-capabilities",
                Some("launcher-secret"),
                Some(mint_body(&fixture)),
            )
            .await,
            StatusCode::FORBIDDEN,
            "the tenant token does not own that live window",
        )
        .await;
    }

    #[tokio::test]
    async fn workspace_not_running() {
        let fixture = fixture().await;
        let other = tempfile::tempdir().unwrap();
        fixture
            .host
            .library()
            .register_workspace(other.path())
            .unwrap();
        let prefix = chan_library::allocate_workspace_prefix(other.path()).unwrap();
        let app = launcher_router(fixture.host.clone(), None, None);
        let cap = mint(&app, &fixture).await;
        check(send(&app, "POST", &format!("/api/library/command-capabilities/{cap}/actions"), None, Some(serde_json::json!({"action":"new_workspace_window", "workspace_id":prefix.trim_start_matches('/')}))).await, StatusCode::CONFLICT, "workspace is not running").await;
    }

    #[tokio::test]
    async fn control_visibility() {
        control_refusal(true).await;
    }

    #[tokio::test]
    async fn control_count() {
        control_refusal(false).await;
    }

    async fn control_refusal(visibility: bool) {
        let fixture = fixture().await;
        fixture
            .host
            .mint_control_window(
                "control-local".into(),
                fixture.host.library_id().to_string(),
                fixture.prefix.clone(),
            )
            .unwrap();
        let app = launcher_router(fixture.host.clone(), None, None);
        let cap = mint(&app, &fixture).await;
        let response = if visibility {
            send(&app, "POST", &format!("/api/library/command-capabilities/{cap}/actions"), None, Some(serde_json::json!({"action":"set_window_visibility", "window_id":"control-local", "hidden":true}))).await
        } else {
            send(&app, "GET", &count_path(&cap, "control-local"), None, None).await
        };
        check(
            response,
            StatusCode::FORBIDDEN,
            "control terminals are not managed by a browser capability",
        )
        .await;
    }

    #[tokio::test]
    async fn window_tenant_not_running() {
        let fixture = fixture().await;
        let record = fixture
            .host
            .mint_window(WindowKind::Terminal, None)
            .unwrap();
        let app = launcher_router(fixture.host.clone(), None, None);
        let cap = mint(&app, &fixture).await;
        check(
            send(
                &app,
                "GET",
                &format!(
                    "/api/library/command-capabilities/{cap}/windows/{}/launch",
                    record.window_id
                ),
                None,
                None,
            )
            .await,
            StatusCode::CONFLICT,
            "window tenant is not running",
        )
        .await;
    }

    async fn resolved_refusal(route: &str, dead: bool) {
        let mut fixture = fixture().await;
        let app = launcher_router(fixture.host.clone(), None, None);
        let cap = if dead {
            let cap = mint(&app, &fixture).await;
            drop(fixture.presence.take());
            cap
        } else {
            "unknown-capability".to_string()
        };
        let path = match route {
            "snapshot" => format!("/api/library/command-capabilities/{cap}"),
            "actions" => format!("/api/library/command-capabilities/{cap}/actions"),
            suffix => format!(
                "/api/library/command-capabilities/{cap}/windows/{}/{suffix}",
                fixture.window_id
            ),
        };
        let response = if route == "actions" {
            send(
                &app,
                "POST",
                &path,
                None,
                Some(serde_json::json!({"action":"new_terminal"})),
            )
            .await
        } else {
            send(&app, "GET", &path, None, None).await
        };
        let (status, message) = if dead {
            (StatusCode::GONE, "the invoking window is no longer live")
        } else {
            (
                StatusCode::UNAUTHORIZED,
                "invalid or expired library command capability",
            )
        };
        check(response, status, message).await;
    }

    macro_rules! resolve_tests {
        ($($name:ident: ($route:literal, $dead:literal)),+ $(,)?) => {$(
            #[tokio::test]
            async fn $name() {
                resolved_refusal($route, $dead).await;
            }
        )+};
    }
    resolve_tests! {
        unknown_snapshot: ("snapshot", false),
        unknown_actions: ("actions", false),
        unknown_launch: ("launch", false),
        unknown_count: ("live-terminals", false),
        dead_snapshot: ("snapshot", true),
        dead_actions: ("actions", true),
        dead_launch: ("launch", true),
        dead_count: ("live-terminals", true),
    }

    #[tokio::test]
    async fn session_leader() {
        use futures::StreamExt;
        let fixture = fixture().await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = fixture.host.clone().router();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let url = format!(
            "ws://{addr}{}/ws?t={}&w={}",
            fixture.prefix, fixture.tenant_token, fixture.window_id
        );
        let (mut socket, _) = tokio_tungstenite::connect_async(url).await.unwrap();
        let roster = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let frame = socket.next().await.unwrap().unwrap();
                if let Ok(text) = frame.to_text() {
                    let value: serde_json::Value = serde_json::from_str(text).unwrap();
                    if value["type"] == "session_roster" {
                        break value;
                    }
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(roster["leader"], fixture.window_id);
        let app = launcher_router(fixture.host.clone(), None, None);
        for (method, path, body) in [
            (
                "POST",
                "/api/library/windows".to_string(),
                Some(
                    serde_json::json!({"kind":"workspace", "workspace_path":fixture._workspace.path(), "acting_window_id":"follower"}),
                ),
            ),
            (
                "DELETE",
                format!(
                    "/api/library/windows/{}?acting_window_id=follower",
                    fixture.window_id
                ),
                None,
            ),
            (
                "POST",
                format!("/api/library/windows/{}/visibility", fixture.window_id),
                Some(serde_json::json!({"hidden":true, "acting_window_id":"follower"})),
            ),
            (
                "PUT",
                format!("/api/library/windows/{}/label", fixture.window_id),
                Some(serde_json::json!({"label":"caption", "acting_window_id":"follower"})),
            ),
        ] {
            assert_refusal(
                send(&app, method, &path, None, body).await,
                StatusCode::FORBIDDEN,
                "not the session leader for this window",
            )
            .await;
        }
        socket.close(None).await.unwrap();
        server.abort();
        let _ = server.await;
    }
}
