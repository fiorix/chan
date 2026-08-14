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
use crate::{WindowKind, WindowOrigin, WindowRecord, WorkspaceHost};

struct RemoteFeed;

impl DevserverFeedSource for RemoteFeed {
    fn windows(&self) -> Vec<WindowRecord> {
        vec![WindowRecord {
            window_id: "remote-window-must-not-leak".into(),
            library_id: "lib-remote".into(),
            kind: WindowKind::Terminal,
            app: None,
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
    let config = tempfile::tempdir().unwrap();
    let store = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let library = Library::open_at(config.path().join("config.toml")).unwrap();
    library.register_workspace(workspace.path()).unwrap();
    let host = Arc::new(WorkspaceHost::new(library, crate::route_builder()));
    host.install_window_registry(
        Arc::new(WindowRegistry::open(store.path().join("windows.json"))),
        "local".into(),
    );
    host.install_devserver_feed(Arc::new(RemoteFeed));
    let prefix = chan_library::allocate_workspace_prefix(workspace.path()).unwrap();
    host.open_or_get_registered_workspace(
        workspace.path(),
        tenant_config("127.0.0.1:0".parse().unwrap(), &prefix),
    )
    .await
    .expect("mount invoking workspace");
    let record = host
        .mint_window_with_origin(
            WindowKind::Workspace,
            None,
            Some(workspace.path().to_string_lossy().into_owned()),
            WindowOrigin::Browser,
        )
        .expect("mint invoking window");
    let presence = host
        .test_connect_window_presence(&prefix, &record.window_id)
        .expect("connect invoking window");
    Fixture {
        _config: config,
        _store: store,
        _workspace: workspace,
        host,
        prefix,
        window_id: record.window_id,
        tenant_token: record.token,
        presence: Some(presence),
    }
}

async fn send(
    router: &axum::Router,
    method: &str,
    uri: &str,
    bearer: Option<&str>,
    body: Option<serde_json::Value>,
    tunnel_readonly: bool,
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
    let mut request = builder.body(body).unwrap();
    if tunnel_readonly {
        request
            .extensions_mut()
            .insert(crate::TunnelOrigin { caller: None });
    }
    router.clone().oneshot(request).await.unwrap()
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

#[tokio::test]
async fn mint_requires_the_same_tenant_token_and_redacts_snapshot_tokens() {
    let fixture = fixture().await;

    // A second valid tenant token passes the broad surface gate, but must not
    // authorize the invoking window from the first tenant.
    let other = tempfile::tempdir().unwrap();
    fixture
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
            None,
            Some(other.path().to_string_lossy().into_owned()),
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
            false,
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
        false,
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
        false,
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
    assert_eq!(snapshot["role"], "owner");
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
        false,
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
        false,
    )
    .await;
    assert_eq!(response.status(), StatusCode::GONE);
}

#[tokio::test]
async fn readonly_tunnel_capability_can_inspect_but_cannot_mutate() {
    let fixture = fixture().await;
    let router = launcher_router(fixture.host.clone(), None, None);
    let minted = send(
        &router,
        "POST",
        "/api/library/command-capabilities",
        None,
        Some(mint_body(&fixture)),
        true,
    )
    .await;
    assert_eq!(minted.status(), StatusCode::OK);
    let (_, minted) = json(minted).await;
    assert_eq!(minted["role"], "readonly");
    let capability = minted["token"].as_str().unwrap();

    let snapshot = send(
        &router,
        "GET",
        &format!("/api/library/command-capabilities/{capability}"),
        None,
        None,
        false,
    )
    .await;
    assert_eq!(snapshot.status(), StatusCode::OK);
    let action = send(
        &router,
        "POST",
        &format!("/api/library/command-capabilities/{capability}/actions"),
        None,
        Some(serde_json::json!({ "action": "new_terminal" })),
        false,
    )
    .await;
    assert_eq!(action.status(), StatusCode::FORBIDDEN);
}
