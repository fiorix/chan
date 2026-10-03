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
            holders: None,
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

/// A feed that lists, under this library's id, a window id it is told
/// after the fixture is built: one this host's registry also holds.
struct EchoFeed {
    library_id: String,
    window_id: Arc<RwLock<String>>,
}

impl DevserverFeedSource for EchoFeed {
    fn windows(&self) -> Vec<WindowRecord> {
        let mut rows = RemoteFeed.windows();
        rows[0].library_id = self.library_id.clone();
        rows[0].window_id = self.window_id.read().unwrap().clone();
        rows
    }

    fn workspaces(&self) -> Vec<LauncherWorkspace> {
        Vec::new()
    }

    fn pane_color(&self, _library_id: &str) -> Option<String> {
        None
    }
}

async fn fixture_with_registry(registry: bool, local_feed: bool) -> Fixture {
    fixture_with_feed(registry, |host| {
        if local_feed {
            Arc::new(LocalFeed(host.library_id().into()))
        } else {
            Arc::new(RemoteFeed)
        }
    })
    .await
}

async fn fixture_with_feed(
    registry: bool,
    feed: impl FnOnce(&WorkspaceHost) -> Arc<dyn DevserverFeedSource>,
) -> Fixture {
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
    host.install_devserver_feed(feed(&host));
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

/// A fixture over a root registered at `holder/parent/ws` whose parent then
/// moved under a symlink, so the registry row keeps the root it stored while
/// the root resolves under the moved parent, mounted by that stored root with
/// one connected invoking window. Returns the stored root and the canonical
/// path.
#[cfg(unix)]
async fn relinked_fixture() -> (Fixture, std::path::PathBuf, std::path::PathBuf) {
    let config = tempfile::tempdir().unwrap();
    let store = tempfile::tempdir().unwrap();
    let holder = tempfile::tempdir().unwrap();
    let parent = holder.path().join("parent");
    std::fs::create_dir_all(parent.join("ws")).unwrap();
    let library = Library::open_at(config.path().join("config.toml")).unwrap();
    let stored = library
        .register_workspace(&parent.join("ws"))
        .unwrap()
        .root_path;
    let moved = holder.path().join("moved");
    std::fs::rename(&parent, &moved).unwrap();
    std::os::unix::fs::symlink(&moved, &parent).unwrap();
    let canonical = chan_workspace::paths::canonicalize_normalized(&stored);
    assert_ne!(canonical, stored, "fixture: the root did not relink");
    let host = Arc::new(WorkspaceHost::new(library, crate::route_builder()));
    host.install_window_registry(
        Arc::new(WindowRegistry::open(store.path().join("windows.json"))),
        "local".into(),
    );
    host.install_devserver_feed(Arc::new(RemoteFeed));
    let prefix = super::registered_workspace_prefix(&stored).unwrap();
    host.open_or_get_registered_workspace(
        &stored,
        tenant_config("127.0.0.1:0".parse().unwrap(), &prefix),
    )
    .await
    .expect("mount the relinked root");
    let record = host
        .mint_window_with_origin(
            WindowKind::Workspace,
            Some(stored.to_string_lossy().into_owned()),
            WindowOrigin::Browser,
        )
        .expect("mint invoking window");
    let presence = host
        .test_connect_window_presence(&prefix, &record.window_id)
        .expect("connect invoking window");
    let fixture = Fixture {
        _config: config,
        _store: store,
        _workspace: holder,
        host,
        prefix,
        window_id: record.window_id,
        tenant_token: record.token,
        presence: Some(presence),
    };
    (fixture, stored, canonical)
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

/// A row that reached the snapshot through a connected devserver's feed
/// with no holders to give, from a server that does not count them, has no
/// `holders` member: neither `null` nor the empty list of a window this
/// host serves whose sockets name none.
#[tokio::test]
async fn a_snapshot_omits_the_holders_a_fed_record_does_not_carry() {
    let fixture = fixture_with_registry(true, true).await;
    let router = launcher_router(fixture.host.clone(), None, None);
    let capability = mint(&router, &fixture).await;
    let snapshot = send(
        &router,
        "GET",
        &format!("/api/library/command-capabilities/{capability}"),
        None,
        None,
    )
    .await;
    let (status, snapshot) = json(snapshot).await;
    assert_eq!(status, StatusCode::OK, "fixture: the snapshot: {snapshot}");
    let row = |window_id: &str| {
        snapshot["windows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|window| window["window_id"] == window_id)
            .unwrap_or_else(|| panic!("fixture: the snapshot lacks {window_id}: {snapshot}"))
            .as_object()
            .expect("a window's row is an object")
            .clone()
    };
    assert!(
        !row("feed-window").contains_key("holders"),
        "the row of a fed record with no holders carries the member: {snapshot}"
    );
    assert_eq!(
        row(&fixture.window_id).get("holders"),
        Some(&serde_json::json!([])),
        "the row of a window this host serves does not list its holders: {snapshot}"
    );
}

/// Every window of the snapshot says whether this host's window registry
/// holds it. The visibility and close actions act on that registry alone, so
/// a row that reached the snapshot through a connected devserver's feed,
/// carrying this library's id, reads `managed: false`, and a window the
/// capability itself opens reads `true`.
#[tokio::test]
async fn a_snapshot_marks_the_windows_its_registry_holds() {
    let fixture = fixture_with_registry(true, true).await;
    let router = launcher_router(fixture.host.clone(), None, None);
    let capability = mint(&router, &fixture).await;
    let snapshot = send(
        &router,
        "GET",
        &format!("/api/library/command-capabilities/{capability}"),
        None,
        None,
    )
    .await;
    let (status, snapshot) = json(snapshot).await;
    assert_eq!(status, StatusCode::OK, "fixture: the snapshot: {snapshot}");
    let managed = |window_id: &str| {
        snapshot["windows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|window| window["window_id"] == window_id)
            .unwrap_or_else(|| panic!("fixture: the snapshot lacks {window_id}: {snapshot}"))
            ["managed"]
            .clone()
    };
    assert_eq!(
        managed(&fixture.window_id),
        true,
        "a window this host's registry holds"
    );
    assert_eq!(
        managed("feed-window"),
        false,
        "a window only a devserver's feed holds"
    );

    let action = send(
        &router,
        "POST",
        &format!("/api/library/command-capabilities/{capability}/actions"),
        None,
        Some(serde_json::json!({ "action": "new_terminal" })),
    )
    .await;
    let (status, action) = json(action).await;
    assert_eq!(status, StatusCode::OK, "fixture: the action: {action}");
    assert_eq!(
        action["window"]["managed"], true,
        "a window the capability opened"
    );
}

/// The mark is the row's source, read with the row: a feed row that carries
/// this library's id and the id of a window the registry holds reads
/// `managed: false` beside the registry's own row of that id.
#[tokio::test]
async fn a_feed_row_under_a_registry_windows_id_reads_unmanaged() {
    let echoed = Arc::new(RwLock::new(String::new()));
    let feed_id = Arc::clone(&echoed);
    let fixture = fixture_with_feed(true, move |host| {
        Arc::new(EchoFeed {
            library_id: host.library_id().into(),
            window_id: feed_id,
        })
    })
    .await;
    *echoed.write().unwrap() = fixture.window_id.clone();
    let router = launcher_router(fixture.host.clone(), None, None);
    let capability = mint(&router, &fixture).await;
    let snapshot = send(
        &router,
        "GET",
        &format!("/api/library/command-capabilities/{capability}"),
        None,
        None,
    )
    .await;
    let (status, snapshot) = json(snapshot).await;
    assert_eq!(status, StatusCode::OK, "fixture: the snapshot: {snapshot}");
    let mut marks: Vec<bool> = snapshot["windows"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|window| window["window_id"] == fixture.window_id.as_str())
        .map(|window| window["managed"].as_bool().expect("a window's mark"))
        .collect();
    marks.sort_unstable();
    assert_eq!(
        marks,
        [false, true],
        "the feed's row and the registry's row under one window id: {snapshot}"
    );
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

/// A workspace window the command action opens in a relinked root stores
/// the root its registry row stores, the path the launcher lists the
/// workspace by and nests its windows under.
#[cfg(unix)]
#[tokio::test]
async fn a_command_window_in_a_relinked_root_stores_its_rows_root() {
    let (fixture, stored, _canonical) = relinked_fixture().await;
    let router = launcher_router(fixture.host.clone(), None, None);
    let capability = mint(&router, &fixture).await;
    let action = send(
        &router,
        "POST",
        &format!("/api/library/command-capabilities/{capability}/actions"),
        None,
        Some(serde_json::json!({
            "action": "new_workspace_window",
            "workspace_id": fixture.prefix.trim_start_matches('/'),
        })),
    )
    .await;
    let (status, action) = json(action).await;
    assert_eq!(status, StatusCode::OK, "fixture: the action: {action}");
    assert_eq!(
        action["window"]["workspace_path"],
        &*stored.to_string_lossy(),
        "the command's window stores a path other than its registry row's root"
    );
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
        control_refusal(ControlRequest::Visibility).await;
    }

    #[tokio::test]
    async fn control_close() {
        control_refusal(ControlRequest::Close).await;
    }

    #[tokio::test]
    async fn control_count() {
        control_refusal(ControlRequest::Count).await;
    }

    enum ControlRequest {
        Visibility,
        Close,
        Count,
    }

    async fn control_refusal(request: ControlRequest) {
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
        let actions = format!("/api/library/command-capabilities/{cap}/actions");
        let response = match request {
            ControlRequest::Visibility => {
                send(&app, "POST", &actions, None, Some(serde_json::json!({"action":"set_window_visibility", "window_id":"control-local", "hidden":true}))).await
            }
            ControlRequest::Close => {
                send(&app, "POST", &actions, None, Some(serde_json::json!({"action":"close_window", "window_id":"control-local"}))).await
            }
            ControlRequest::Count => {
                send(&app, "GET", &count_path(&cap, "control-local"), None, None).await
            }
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

    /// A workspace mint in a relinked root is gated on the leader of the
    /// root's tenant whichever of the two paths the client names, the root
    /// its registry row stores or the canonical path: a claimed acting
    /// window that is not the leader is refused, and the leader's is not.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_relinked_roots_workspace_mint_is_gated_on_its_leader_by_either_path() {
        use futures::StreamExt;
        let (fixture, stored, canonical) = super::relinked_fixture().await;
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
        assert_eq!(
            roster["leader"], fixture.window_id,
            "fixture: the invoking window does not lead"
        );
        let app = launcher_router(fixture.host.clone(), None, None);
        for path in [&stored, &canonical] {
            let mint = |acting: &str| {
                serde_json::json!({
                    "kind": "workspace",
                    "workspace_path": path,
                    "acting_window_id": acting,
                })
            };
            assert_refusal(
                send(
                    &app,
                    "POST",
                    "/api/library/windows",
                    None,
                    Some(mint("follower")),
                )
                .await,
                StatusCode::FORBIDDEN,
                "not the session leader for this window",
            )
            .await;
            let (status, record) = json(
                send(
                    &app,
                    "POST",
                    "/api/library/windows",
                    None,
                    Some(mint(&fixture.window_id)),
                )
                .await,
            )
            .await;
            assert_eq!(
                status,
                StatusCode::OK,
                "the leader's mint by {} was refused: {record}",
                path.display()
            );
        }
        socket.close(None).await.unwrap();
        server.abort();
        let _ = server.await;
    }
}

/// The holders of a window: which clients have a socket on it, by the tag
/// each put on its `/ws`. Real sockets on the tenant, read back through the
/// window feed, the scoped snapshot and the launch redirect.
mod window_holders {
    use futures::StreamExt;

    use super::*;

    type Socket = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;

    const BOUND: std::time::Duration = std::time::Duration::from_secs(10);

    /// The fixture's host behind a listener, with no socket on its window,
    /// and one client of its window feed.
    struct Served {
        fixture: Fixture,
        addr: std::net::SocketAddr,
        feed: Socket,
        tasks: Vec<tokio::task::JoinHandle<()>>,
    }

    impl Drop for Served {
        fn drop(&mut self) {
            for task in &self.tasks {
                task.abort();
            }
        }
    }

    async fn served() -> Served {
        let mut fixture = fixture().await;
        // The fixture's own stand-in for a socket would count as one.
        drop(fixture.presence.take());
        let mut tasks = Vec::new();
        let mut serve = |app: axum::Router| {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let addr = listener.local_addr().unwrap();
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            tasks.push(tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            }));
            addr
        };
        let addr = serve(fixture.host.clone().router());
        let launcher = serve(launcher_router(fixture.host.clone(), None, None));
        let (feed, _) =
            tokio_tungstenite::connect_async(format!("ws://{launcher}/api/library/windows/watch"))
                .await
                .expect("the window feed");
        Served {
            fixture,
            addr,
            feed,
            tasks,
        }
    }

    impl Served {
        /// One `/ws` socket on the fixture's window with `holder` appended
        /// to its query as given, returned once the server's pump has sent
        /// its first frame: the socket is counted by then.
        async fn socket(&self, holder: &str) -> Socket {
            let url = format!(
                "ws://{}{}/ws?t={}&w={}{holder}",
                self.addr, self.fixture.prefix, self.fixture.tenant_token, self.fixture.window_id
            );
            let (mut socket, _) = tokio_tungstenite::connect_async(url)
                .await
                .expect("a window socket");
            tokio::time::timeout(BOUND, socket.next())
                .await
                .expect("the window socket's pump sent nothing")
                .expect("the window socket closed")
                .expect("the window socket failed");
            socket
        }

        /// The fixture window's row of the feed, from the first frame in
        /// which `ready` holds for it. Panics with `what` and the last row
        /// the feed sent when none does inside the bound.
        async fn row(
            &mut self,
            what: &str,
            ready: impl Fn(&serde_json::Value) -> bool,
        ) -> serde_json::Value {
            let mut last = serde_json::Value::Null;
            let window_id = self.fixture.window_id.clone();
            let feed = &mut self.feed;
            let found = tokio::time::timeout(BOUND, async {
                loop {
                    let frame = feed
                        .next()
                        .await
                        .expect("the feed closed")
                        .expect("the feed failed");
                    let Ok(text) = frame.to_text() else {
                        continue;
                    };
                    let set: serde_json::Value = serde_json::from_str(text).unwrap();
                    let row = set["windows"]
                        .as_array()
                        .and_then(|rows| rows.iter().find(|row| row["window_id"] == window_id))
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                    last = row.clone();
                    if ready(&row) {
                        break row;
                    }
                }
            })
            .await;
            found.unwrap_or_else(|_| panic!("{what}; the last row the feed sent: {last}"))
        }
    }

    fn holders(tags: &[&str]) -> serde_json::Value {
        serde_json::json!(tags)
    }

    /// The fixture window's row of the scoped snapshot, as the window is
    /// now: no frame of the feed has to carry it.
    async fn scoped_row(served: &Served) -> serde_json::Value {
        let router = launcher_router(served.fixture.host.clone(), None, None);
        let capability = mint(&router, &served.fixture).await;
        let snapshot = send(
            &router,
            "GET",
            &format!("/api/library/command-capabilities/{capability}"),
            None,
            None,
        )
        .await;
        let (status, snapshot) = json(snapshot).await;
        assert_eq!(status, StatusCode::OK, "fixture: the snapshot: {snapshot}");
        snapshot["windows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|window| window["window_id"] == served.fixture.window_id)
            .unwrap_or_else(|| panic!("fixture: the snapshot lacks the window: {snapshot}"))
            .clone()
    }

    /// Two clients hold one window, each with its own tag: the feed's row
    /// names both, sorted, so each can read whether its own socket is live.
    /// A row with no socket lists none, which is not the same as a row that
    /// cannot say. The scoped snapshot's row carries the same list.
    #[tokio::test]
    async fn the_feed_names_the_holders_of_a_windows_tagged_sockets() {
        let mut served = served().await;
        let row = served
            .row("the feed sent no row without a socket", |row| {
                row["connected"] == false
            })
            .await;
        assert_eq!(
            row["holders"],
            holders(&[]),
            "a window with no socket does not list its holders as none: {row}"
        );

        let _desk = served.socket("&h=desk-a").await;
        let row = served
            .row("the feed did not name a first holder", |row| {
                row["holders"] == holders(&["desk-a"])
            })
            .await;
        assert_eq!(row["connected"], true, "{row}");

        let _tab = served.socket("&h=Tab_b-2").await;
        let row = served
            .row("the feed did not name both holders of one window", |row| {
                row["holders"] == holders(&["Tab_b-2", "desk-a"])
            })
            .await;
        assert_eq!(row["connected"], true, "{row}");

        let scoped = scoped_row(&served).await;
        assert_eq!(
            scoped["holders"],
            holders(&["Tab_b-2", "desk-a"]),
            "the scoped row does not carry the record's holders: {scoped}"
        );
    }

    /// A holder that leaves wakes the feed although the window stays
    /// connected through another, and the row then names the one that is
    /// left. A second socket of a holder already named is no change, and
    /// its leaving is none either.
    #[tokio::test]
    async fn a_holder_leaving_wakes_the_feed_while_the_window_stays_connected() {
        let mut served = served().await;
        let _desk = served.socket("&h=desk-a").await;
        let mut again = served.socket("&h=desk-a").await;
        let mut tab = served.socket("&h=tab-b").await;
        served
            .row("the feed did not name both holders of one window", |row| {
                row["holders"] == holders(&["desk-a", "tab-b"])
            })
            .await;

        again.close(None).await.unwrap();
        tab.close(None).await.unwrap();
        let row = served
            .row(
                "the feed sent no frame when one of a window's two holders left",
                |row| row["holders"] == holders(&["desk-a"]),
            )
            .await;
        assert_eq!(
            row["connected"], true,
            "the window did not stay connected through the holder that is left: {row}"
        );
    }

    /// A socket whose `h` is missing, empty, repeated or not 1 to 64
    /// characters of `[A-Za-z0-9_-]` is not refused: it counts toward
    /// `connected` and adds no holder. A tag of exactly 64 characters is
    /// one, and so is one whose characters arrive percent-encoded.
    #[tokio::test]
    async fn a_socket_with_a_malformed_holder_counts_and_adds_none() {
        let mut served = served().await;
        let longest = "x".repeat(64);
        let malformed = [
            String::new(),
            "&h=".to_string(),
            "&h=has%20space".to_string(),
            "&h=a.b".to_string(),
            "&h=caf%C3%A9".to_string(),
            format!("&h={longest}x"),
            "&h=one&h=two".to_string(),
        ];
        let mut sockets = Vec::new();
        for query in &malformed {
            sockets.push(served.socket(query).await);
        }
        let row = served
            .row(
                "a socket with a malformed holder did not count as connected",
                |row| row["connected"] == true,
            )
            .await;
        assert_eq!(
            row["holders"],
            holders(&[]),
            "the holders of a window whose sockets name none well are not an empty list: {row}"
        );
        // That frame can be of the first socket alone, and the six after it
        // change nothing a frame carries. Every one is counted by now, so
        // the scoped snapshot reads the window with all seven.
        let scoped = scoped_row(&served).await;
        assert_eq!(
            (&scoped["connected"], &scoped["holders"]),
            (&serde_json::json!(true), &holders(&[])),
            "a socket with a malformed holder was taken as a holder: {scoped}"
        );

        sockets.push(served.socket(&format!("&h={longest}")).await);
        sockets.push(served.socket("&h=desk%2Da").await);
        let row = served
            .row("the feed did not name the two well-formed holders", |row| {
                row["holders"]
                    .as_array()
                    .is_some_and(|tags| tags.len() >= 2)
            })
            .await;
        assert_eq!(
            row["holders"],
            holders(&["desk-a", &longest]),
            "the holders are not the two well-formed tags alone: {row}"
        );
    }

    /// The launch redirect copies a well-formed `h` from its own query into
    /// the tenant URL, so the page it opens can tag its socket; with none,
    /// or a malformed one, the URL carries none and the redirect is made
    /// all the same.
    #[tokio::test]
    async fn the_launch_redirect_carries_a_holder_to_the_tenant_url() {
        let fixture = fixture().await;
        let router = launcher_router(fixture.host.clone(), None, None);
        let capability = mint(&router, &fixture).await;
        let launch = |query: &'static str| {
            let router = router.clone();
            let path = format!(
                "/api/library/command-capabilities/{capability}/windows/{}/launch{query}",
                fixture.window_id
            );
            async move {
                let response = send(&router, "GET", &path, None, None).await;
                assert_eq!(
                    response.status(),
                    StatusCode::TEMPORARY_REDIRECT,
                    "the launch of {path} did not redirect"
                );
                response.headers()[header::LOCATION]
                    .to_str()
                    .unwrap()
                    .to_string()
            }
        };
        let pairs = |location: &str| -> Vec<(String, String)> {
            let (_, query) = location.split_once('?').expect("a query on the tenant URL");
            url::form_urlencoded::parse(query.as_bytes())
                .into_owned()
                .collect()
        };
        let holder = |location: &str| -> Vec<String> {
            pairs(location)
                .into_iter()
                .filter(|(key, _)| key == "h")
                .map(|(_, value)| value)
                .collect()
        };

        let location = launch("?h=desk-a").await;
        assert_eq!(
            holder(&location),
            ["desk-a"],
            "the redirect does not carry the holder: {location}"
        );
        assert!(
            pairs(&location)
                .iter()
                .any(|(key, value)| key == "w" && *value == fixture.window_id),
            "the redirect lost the window id: {location}"
        );
        for query in ["", "?h=", "?h=has%20space", "?h=one&h=two"] {
            let location = launch(query).await;
            assert!(
                holder(&location).is_empty(),
                "the redirect of {query:?} carries a holder: {location}"
            );
        }
    }
}
