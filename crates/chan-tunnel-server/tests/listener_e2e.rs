//! End-to-end tests for the tunnel listener.
//!
//! Workspaces a real `chan-tunnel-client` against `serve_tunnel_listener`
//! over a localhost socket, exercising the auth gates (base scope, cap)
//! that unit tests can only exercise in pieces.
//! The client dials h2c (`http://...`); no TLS plumbing on this
//! side, since TLS is nginx's job in production.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chan_tunnel_client::{dial, ClientConfig, ClientError};
use chan_tunnel_proto::error_code;
use chan_tunnel_server::{
    serve_tunnel_listener, serve_tunnel_listener_with_admission, RegistrationAdmission,
    RegistrationPermit, Registry, ServerError, Validated, Validator, TUNNEL_SCOPE,
};
use tokio::net::{TcpListener, TcpStream};
use url::Url;
use uuid::Uuid;

/// Validator stub. Maps each known token to the `devserver_id` it resolves
/// to (identity is token-resolved, not from the client's `Hello`); an unknown
/// token is `InvalidToken`. All tokens belong to one `username` so the
/// per-user cap counts distinct devservers. Announced display names are
/// recorded so tests can assert the listener's post-registration hook.
struct StubValidator {
    username: String,
    scopes: Vec<String>,
    tokens: HashMap<String, String>,
    announced: std::sync::Mutex<Vec<(String, String)>>,
}

impl StubValidator {
    fn new(username: &str, scopes: Vec<String>, tokens: &[(&str, &str)]) -> Arc<Self> {
        Arc::new(Self {
            username: username.into(),
            scopes,
            tokens: tokens
                .iter()
                .map(|(t, d)| (t.to_string(), d.to_string()))
                .collect(),
            announced: std::sync::Mutex::new(Vec::new()),
        })
    }

    fn announced(&self) -> Vec<(String, String)> {
        self.announced.lock().unwrap().clone()
    }
}

#[async_trait]
impl Validator for StubValidator {
    async fn validate(&self, token: &str) -> Result<Validated, ServerError> {
        match self.tokens.get(token) {
            Some(devserver_id) => Ok(Validated {
                user_id: Uuid::nil(),
                username: self.username.clone(),
                devserver_id: devserver_id.clone(),
                scopes: self.scopes.clone(),
                gateway_assertion_key: None,
                admission_lease: None,
                admission_lease_expires_at: None,
            }),
            None => Err(ServerError::InvalidToken),
        }
    }

    async fn announce_devserver_name(&self, token: &str, name: &str) {
        self.announced
            .lock()
            .unwrap()
            .push((token.to_string(), name.to_string()));
    }
}

struct Harness {
    port: u16,
    registry: Arc<Registry>,
    /// Kept so the listener task lives at least as long as the test.
    /// `drop(Harness)` aborts via the JoinHandle's Drop.
    _task: tokio::task::JoinHandle<()>,
}

async fn spawn_listener(validator: Arc<dyn Validator>, max_workspaces_per_user: usize) -> Harness {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind 0");
    let port = listener.local_addr().unwrap().port();
    let registry = Registry::new();
    let registry_for_task = registry.clone();
    let _task = tokio::spawn(async move {
        let _ = serve_tunnel_listener(
            listener,
            validator,
            registry_for_task,
            max_workspaces_per_user,
        )
        .await;
    });
    Harness {
        port,
        registry,
        _task,
    }
}

struct CapacityAdmission;

#[async_trait]
impl RegistrationAdmission for CapacityAdmission {
    async fn admit(
        &self,
        _hello: &chan_tunnel_proto::Hello,
        validated: &Validated,
    ) -> Result<RegistrationPermit, ServerError> {
        Err(ServerError::AdmissionAtCapacity {
            user: validated.username.clone(),
        })
    }
}

async fn spawn_controller_admitted_listener(
    validator: Arc<dyn Validator>,
    admission: Arc<dyn RegistrationAdmission>,
) -> Harness {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind 0");
    let port = listener.local_addr().unwrap().port();
    let registry = Registry::new();
    let registry_for_task = registry.clone();
    let _task = tokio::spawn(async move {
        let _ = serve_tunnel_listener_with_admission(
            listener,
            validator,
            admission,
            registry_for_task,
            0,
        )
        .await;
    });
    Harness {
        port,
        registry,
        _task,
    }
}

fn cfg(port: u16, token: &str, workspace: &str) -> ClientConfig {
    ClientConfig {
        tunnel_url: Url::parse(&format!("http://127.0.0.1:{port}/v1/tunnel"))
            .expect("hard-coded url is valid"),
        token: token.into(),
        workspace: workspace.into(),
        name: None,
        client_version: "chan/test".into(),
        initial_backoff: Duration::from_millis(50),
        max_backoff: Duration::from_secs(1),
        dial_timeout: Duration::from_secs(5),
        events: None,
        proxy: None,
        max_concurrent_substreams: chan_tunnel_client::DEFAULT_MAX_CONCURRENT_SUBSTREAMS,
    }
}

async fn auth_response(port: u16, token: &str) -> (http::StatusCode, Vec<u8>) {
    let tcp = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect listener");
    let (mut h2, conn) = h2::client::handshake(tcp).await.expect("h2 handshake");
    let _driver = tokio::spawn(async move {
        let _ = conn.await;
    });
    let request = http::Request::builder()
        .method(http::Method::POST)
        .uri(format!(
            "https://chan-tunnel{}",
            chan_tunnel_proto::TUNNEL_PATH
        ))
        .header(http::header::AUTHORIZATION, format!("Bearer {token}"))
        .body(())
        .expect("constant request");
    let (response, _send) = h2.send_request(request, true).expect("send auth request");
    let mut response = response.await.expect("auth response");
    let status = response.status();
    let mut body = Vec::new();
    while let Some(chunk) = response.body_mut().data().await {
        body.extend_from_slice(&chunk.expect("response body chunk"));
    }
    (status, body)
}

/// Spin-wait briefly for the listener to insert the registration.
/// The client's `dial` returns the moment it reads HelloAck, but
/// the server side does `register_with_cap` a few statements later;
/// without a wait, tests querying the registry can race that gap.
async fn wait_registered(reg: &Registry, user: &str, workspace: &str) -> bool {
    for _ in 0..100 {
        if reg.get(user, workspace).is_some() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    false
}

#[tokio::test]
async fn registration_keys_on_token_devserver_id_not_hello_workspace() {
    // The registry keys on the token-resolved devserver id ("ds-1"), NOT the
    // client's Hello.workspace placeholder ("devsrv"). The ack echoes the
    // resolved id.
    let validator = StubValidator::new("alice", vec![TUNNEL_SCOPE.into()], &[("good", "ds-1")]);
    let h = spawn_listener(validator, 0).await;
    let (reg, _yconn) = dial(&cfg(h.port, "good", "devsrv")).await.expect("dial ok");
    assert_eq!(reg.user, "alice");
    assert_eq!(reg.workspace, "ds-1");
    assert_eq!(reg.prefix, "/ds-1");
    // Keyed on the devserver id, not the placeholder label.
    assert!(wait_registered(&h.registry, "alice", "ds-1").await);
    assert!(h.registry.get("alice", "devsrv").is_none());
    let registered = h.registry.list_workspaces_for("alice");
    assert_eq!(registered.len(), 1);
    assert_eq!(registered[0].workspace.as_ref(), "ds-1");
}

#[tokio::test]
async fn hello_name_reaches_the_validator_hook() {
    // A Hello-announced display name lands on the validator's
    // announce hook (trimmed), with the same token the dial used.
    let validator = StubValidator::new("alice", vec![TUNNEL_SCOPE.into()], &[("good", "ds-1")]);
    let h = spawn_listener(validator.clone(), 0).await;
    let mut config = cfg(h.port, "good", "devsrv");
    config.name = Some("  office box  ".into());
    let (_reg, _yconn) = dial(&config).await.expect("dial ok");
    assert!(wait_registered(&h.registry, "alice", "ds-1").await);
    // The announce runs on a detached task; give it the same grace.
    let mut announced = validator.announced();
    for _ in 0..100 {
        if !announced.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
        announced = validator.announced();
    }
    assert_eq!(
        announced,
        vec![("good".to_string(), "office box".to_string())]
    );

    // No name (an old client's Hello): the hook stays silent.
    let quiet = StubValidator::new("bob", vec![TUNNEL_SCOPE.into()], &[("tok", "ds-2")]);
    let h2 = spawn_listener(quiet.clone(), 0).await;
    let (_reg, _yconn2) = dial(&cfg(h2.port, "tok", "devsrv")).await.expect("dial ok");
    assert!(wait_registered(&h2.registry, "bob", "ds-2").await);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(quiet.announced().is_empty());
}

#[tokio::test]
async fn invalid_token_returns_401() {
    let validator = StubValidator::new("alice", vec![TUNNEL_SCOPE.into()], &[("good", "ds-1")]);
    let h = spawn_listener(validator, 0).await;
    let err = dial(&cfg(h.port, "bad", "notes"))
        .await
        .map(|_| ())
        .expect_err("bad token should fail");
    let msg = err.to_string();
    assert!(
        msg.contains("unauthorized (bad token or missing tunnel scope)"),
        "got: {msg}"
    );
    assert!(h.registry.list_workspaces_for("alice").is_empty());
}

#[tokio::test]
async fn missing_base_scope_returns_401() {
    // Token authenticates but lacks `TUNNEL_SCOPE` entirely.
    let validator = StubValidator::new("alice", vec![], &[("good", "ds-1")]);
    let h = spawn_listener(validator, 0).await;
    let err = dial(&cfg(h.port, "good", "notes"))
        .await
        .map(|_| ())
        .expect_err("missing tunnel scope should fail");
    let msg = err.to_string();
    assert!(
        msg.contains("unauthorized (bad token or missing tunnel scope)"),
        "got: {msg}"
    );
    assert!(h.registry.list_workspaces_for("alice").is_empty());
}

#[tokio::test]
async fn invalid_and_scopeless_tokens_are_wire_indistinguishable() {
    let validator = StubValidator::new("alice", vec![], &[("scopeless", "ds-1")]);
    let h = spawn_listener(validator, 0).await;

    let invalid = auth_response(h.port, "unknown").await;
    let scopeless = auth_response(h.port, "scopeless").await;

    assert_eq!(invalid, (http::StatusCode::UNAUTHORIZED, Vec::new()));
    assert_eq!(scopeless, invalid);
}

#[tokio::test]
async fn per_user_cap_blocks_third_devserver() {
    // The cap counts distinct devservers per user. Three tokens resolve to
    // three distinct devserver ids; with cap 2 the third is refused.
    let validator = StubValidator::new(
        "alice",
        vec![TUNNEL_SCOPE.into()],
        &[("t1", "ds-1"), ("t2", "ds-2"), ("t3", "ds-3")],
    );
    let h = spawn_listener(validator, 2).await;
    let (_a, _y1) = dial(&cfg(h.port, "t1", "devsrv"))
        .await
        .expect("first dial");
    assert!(wait_registered(&h.registry, "alice", "ds-1").await);
    let (_b, _y2) = dial(&cfg(h.port, "t2", "devsrv"))
        .await
        .expect("second dial");
    assert!(wait_registered(&h.registry, "alice", "ds-2").await);
    let err = dial(&cfg(h.port, "t3", "devsrv"))
        .await
        .map(|_| ())
        .expect_err("third dial should hit the cap");
    // Refusal is in pre_ack; the server emits a structured
    // HelloAck::Refused so the client surfaces code + message.
    match err {
        ClientError::RemoteRefusal {
            ref code,
            ref message,
        } => {
            assert_eq!(code, error_code::TOO_MANY_WORKSPACES);
            assert!(message.contains("alice"), "got: {message}");
        }
        other => panic!("expected RemoteRefusal, got {other:?}"),
    }
    let registered: Vec<_> = h
        .registry
        .list_workspaces_for("alice")
        .into_iter()
        .map(|d| d.workspace.as_ref().to_string())
        .collect();
    assert_eq!(registered, vec!["ds-1".to_string(), "ds-2".to_string()]);
}

#[tokio::test]
async fn controller_capacity_denial_is_a_stable_pre_registration_refusal() {
    let validator = StubValidator::new("alice", vec![TUNNEL_SCOPE.into()], &[("good", "ds-1")]);
    let h = spawn_controller_admitted_listener(validator, Arc::new(CapacityAdmission)).await;

    let error = dial(&cfg(h.port, "good", "devsrv"))
        .await
        .map(|_| ())
        .expect_err("controller capacity denial should refuse the handshake");
    match error {
        ClientError::RemoteRefusal { code, message } => {
            assert_eq!(code, error_code::TOO_MANY_WORKSPACES);
            assert!(message.contains("fleet-wide"), "got: {message}");
        }
        other => panic!("expected RemoteRefusal, got {other:?}"),
    }
    assert!(h.registry.list_workspaces_for("alice").is_empty());
}

/// Admission that blocks inside `admit` until the test releases it.
/// This makes the admit-to-HelloAck ordering observable: while the
/// gate is held the client cannot have received `HelloAck::Ok`.
struct GatedAdmission {
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
    registration_id: std::sync::Mutex<Option<Uuid>>,
}

#[async_trait]
impl RegistrationAdmission for GatedAdmission {
    async fn admit(
        &self,
        _hello: &chan_tunnel_proto::Hello,
        _validated: &Validated,
    ) -> Result<RegistrationPermit, ServerError> {
        self.admit_registration(_hello, _validated, Uuid::new_v4())
            .await
    }

    async fn admit_registration(
        &self,
        _hello: &chan_tunnel_proto::Hello,
        _validated: &Validated,
        registration_id: Uuid,
    ) -> Result<RegistrationPermit, ServerError> {
        self.entered.notify_one();
        self.release.notified().await;
        *self.registration_id.lock().unwrap() = Some(registration_id);
        Ok(RegistrationPermit {
            request_id: Uuid::new_v4(),
            registration_id,
            admission_epoch: 0,
        })
    }
}

#[tokio::test]
async fn admission_completes_before_hello_ack_ok() {
    let validator = StubValidator::new("alice", vec![TUNNEL_SCOPE.into()], &[("good", "ds-1")]);
    let admission = Arc::new(GatedAdmission {
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        registration_id: std::sync::Mutex::new(None),
    });
    let h = spawn_controller_admitted_listener(validator, admission.clone()).await;

    let dial_task = tokio::spawn({
        let config = cfg(h.port, "good", "devsrv");
        async move { dial(&config).await }
    });
    // The handshake is parked inside admit; the client must still be
    // waiting for its HelloAck.
    tokio::time::timeout(Duration::from_secs(5), admission.entered.notified())
        .await
        .expect("admission never ran");
    assert!(
        !dial_task.is_finished(),
        "client dial completed before admission resolved"
    );
    admission.release.notify_one();

    let (_registration, _yamux) = tokio::time::timeout(Duration::from_secs(5), dial_task)
        .await
        .expect("dial never completed")
        .expect("dial task panicked")
        .expect("dial should succeed once admission resolves");
    assert!(wait_registered(&h.registry, "alice", "ds-1").await);
    // Admission observes and returns the listener-generated UUID, so
    // controller commands and the registry address the same registration.
    let registration_id = admission
        .registration_id
        .lock()
        .unwrap()
        .expect("admission captured registration id");
    assert_eq!(
        h.registry
            .get("alice", "ds-1")
            .expect("registered")
            .registration_id,
        registration_id
    );
}

/// `ControlUnavailable` maps to the stable `control_unavailable`
/// refusal code on the wire, distinct from the capacity code.
struct UnavailableAdmission;

#[async_trait]
impl RegistrationAdmission for UnavailableAdmission {
    async fn admit(
        &self,
        _hello: &chan_tunnel_proto::Hello,
        _validated: &Validated,
    ) -> Result<RegistrationPermit, ServerError> {
        Err(ServerError::ControlUnavailable)
    }
}

#[tokio::test]
async fn control_unavailable_denial_carries_the_stable_refusal_code() {
    let validator = StubValidator::new("alice", vec![TUNNEL_SCOPE.into()], &[("good", "ds-1")]);
    let h = spawn_controller_admitted_listener(validator, Arc::new(UnavailableAdmission)).await;

    let error = dial(&cfg(h.port, "good", "devsrv"))
        .await
        .map(|_| ())
        .expect_err("control-unavailable denial should refuse the handshake");
    match error {
        ClientError::RemoteRefusal { code, message } => {
            assert_eq!(code, error_code::CONTROL_UNAVAILABLE);
            assert!(message.contains("control is unavailable"), "got: {message}");
        }
        other => panic!("expected RemoteRefusal, got {other:?}"),
    }
    assert!(h.registry.list_workspaces_for("alice").is_empty());
}

#[tokio::test]
async fn reconnect_evicts_previous_registration() {
    // The same token resolves to the same devserver id, so a second dial
    // (a devserver restart reclaiming its slot) replaces the first.
    let validator = StubValidator::new("alice", vec![TUNNEL_SCOPE.into()], &[("good", "ds-1")]);
    let h = spawn_listener(validator, 0).await;
    let (_a, _y1) = dial(&cfg(h.port, "good", "devsrv"))
        .await
        .expect("first dial");
    assert!(wait_registered(&h.registry, "alice", "ds-1").await);
    let first_at = h.registry.get("alice", "ds-1").unwrap().connected_at;
    // Tiny pause so the timestamps differ unambiguously.
    tokio::time::sleep(Duration::from_millis(20)).await;
    let (_b, _y2) = dial(&cfg(h.port, "good", "devsrv"))
        .await
        .expect("second dial");
    // Wait for the new registration to land; it has a strictly
    // later connected_at than the first one.
    for _ in 0..100 {
        if let Some(h2) = h.registry.get("alice", "ds-1") {
            if h2.connected_at > first_at {
                return;
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("second registration did not supersede the first");
}
