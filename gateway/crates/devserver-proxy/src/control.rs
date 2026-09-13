use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use axum::http::{header, Method, Request, StatusCode};
use chan_tunnel_proto::H2Duplex;
use chan_tunnel_server::{
    RegistrationAdmission, RegistrationPermit, RegistryEvent, ServerError, TunnelInfo,
};
use devserver_control_proto::{
    read_frame, write_frame, AdmissionDecision, AdmissionLease, AdmissionLeaseBinding,
    AdmissionLeaseVerifier, ClientFrame, ProxyId, ServerFrame, SessionRevocation, TunnelRow,
    CONNECT_PATH, CONTENT_TYPE, MAX_SNAPSHOT_CHUNK_ROWS, PROTOCOL_VERSION,
    PROXY_CONTROL_LOSS_GRACE_SECONDS, PROXY_CONVERGENCE_GRACE_SECONDS,
};
use rand::Rng;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::Instant;
use uuid::Uuid;

use crate::{
    registry::Registry,
    session_store::{SessionEvent, SessionStore},
    Config,
};

const REQUEST_QUEUE_CAPACITY: usize = 1024;
const SERVER_FRAME_QUEUE_CAPACITY: usize = 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(30);
const CONTROLLER_DEAD_AFTER: Duration = Duration::from_secs(15);
const GRACE_PERIOD: Duration = Duration::from_secs(PROXY_CONTROL_LOSS_GRACE_SECONDS);
/// Once a replacement controller has accepted the signed snapshot it still
/// needs the controller's 30s fleet convergence window and one 5s command
/// round. This separate hard deadline prevents a peer that never sends
/// `FleetReady` from extending old authority indefinitely.
const CONVERGENCE_GRACE_PERIOD: Duration = Duration::from_secs(PROXY_CONVERGENCE_GRACE_SECONDS);
const BACKOFF_MIN: Duration = Duration::from_millis(500);
const BACKOFF_MAX: Duration = Duration::from_secs(10);

pub struct ControlRuntime {
    pub admission: Arc<dyn RegistrationAdmission>,
    pub readiness: watch::Receiver<bool>,
    pub task: tokio::task::JoinHandle<anyhow::Result<()>>,
}

struct AbortOnDropTask(Option<tokio::task::JoinHandle<()>>);

impl AbortOnDropTask {
    fn new(task: tokio::task::JoinHandle<()>) -> Self {
        Self(Some(task))
    }

    async fn cancel(mut self) {
        if let Some(task) = self.0.take() {
            task.abort();
            let _ = task.await;
        }
    }
}

impl Drop for AbortOnDropTask {
    fn drop(&mut self) {
        if let Some(task) = &self.0 {
            task.abort();
        }
    }
}

pub fn spawn_control_supervisor(
    config: Arc<Config>,
    registry: Registry,
    sessions: SessionStore,
    shutdown: watch::Receiver<bool>,
) -> ControlRuntime {
    spawn_supervisor(
        config,
        registry,
        sessions,
        shutdown,
        BackoffObserver::disabled(),
    )
}

/// Test-only tap on the computed reconnect delay. Asserting the
/// backoff schedule from connection-attempt timestamps does not work
/// under paused Tokio time, so tests read the delays the supervisor
/// actually sleeps on. Compiles to a ZST outside test builds.
struct BackoffObserver {
    #[cfg(test)]
    delays: Option<mpsc::UnboundedSender<Duration>>,
}

impl BackoffObserver {
    fn disabled() -> Self {
        Self {
            #[cfg(test)]
            delays: None,
        }
    }

    #[cfg(test)]
    fn recording(delays: mpsc::UnboundedSender<Duration>) -> Self {
        Self {
            delays: Some(delays),
        }
    }

    fn observe(&self, delay: Duration) {
        #[cfg(test)]
        if let Some(delays) = &self.delays {
            let _ = delays.send(delay);
        }
        #[cfg(not(test))]
        let _ = delay;
    }
}

fn spawn_supervisor(
    config: Arc<Config>,
    registry: Registry,
    sessions: SessionStore,
    shutdown: watch::Receiver<bool>,
    backoff_observer: BackoffObserver,
) -> ControlRuntime {
    let (requests_tx, requests_rx) = mpsc::channel(REQUEST_QUEUE_CAPACITY);
    let (readiness_tx, readiness) = watch::channel(false);
    let admission_epoch = Arc::new(AtomicU64::new(1));
    let admission: Arc<dyn RegistrationAdmission> = Arc::new(ControlAdmission {
        requests: requests_tx,
        readiness: readiness.clone(),
        admission_epoch: admission_epoch.clone(),
        admission_lease_verifier: config.admission_lease_verifier.clone(),
        proxy_id: config.proxy_id.clone(),
    });
    let task = tokio::spawn(async move {
        supervise(
            config,
            registry,
            sessions,
            requests_rx,
            readiness_tx,
            admission_epoch,
            shutdown,
            backoff_observer,
        )
        .await
    });
    ControlRuntime {
        admission,
        readiness,
        task,
    }
}

#[derive(Clone)]
struct ControlAdmission {
    requests: mpsc::Sender<LocalRequest>,
    readiness: watch::Receiver<bool>,
    admission_epoch: Arc<AtomicU64>,
    /// The ring the control stream verifies every published row under. A
    /// lease it cannot verify, or one bound to anything but the
    /// registration being admitted on `proxy_id`, is refused here, before
    /// the controller refuses it or reserves capacity for a tunnel this
    /// proxy could never publish.
    admission_lease_verifier: AdmissionLeaseVerifier,
    proxy_id: ProxyId,
}

#[async_trait]
impl RegistrationAdmission for ControlAdmission {
    /// A lease is bound to one registration id, and a fresh one here is
    /// not it, so this refuses every leased registration; the tunnel
    /// listener admits through `admit_registration`.
    async fn admit(
        &self,
        _hello: &chan_tunnel_proto::Hello,
        validated: &chan_tunnel_server::Validated,
    ) -> Result<RegistrationPermit, ServerError> {
        self.admit_registration(_hello, validated, Uuid::new_v4())
            .await
    }

    async fn admit_registration(
        &self,
        _hello: &chan_tunnel_proto::Hello,
        validated: &chan_tunnel_server::Validated,
        registration_id: Uuid,
    ) -> Result<RegistrationPermit, ServerError> {
        if !*self.readiness.borrow() {
            return Err(ServerError::ControlUnavailable);
        }
        let admission_epoch = self.admission_epoch.load(Ordering::Acquire);
        if !*self.readiness.borrow() {
            return Err(ServerError::ControlUnavailable);
        }
        let request_id = Uuid::new_v4();
        let admission_lease = validated
            .admission_lease
            .as_ref()
            .and_then(|lease| AdmissionLease::parse(lease.clone()).ok())
            .ok_or(ServerError::ControlUnavailable)?;
        let claims = match self
            .admission_lease_verifier
            .verify(&admission_lease, chrono::Utc::now())
        {
            Ok(claims) => claims,
            Err(error) => {
                tracing::warn!(
                    %registration_id,
                    user = %validated.username,
                    %error,
                    "refusing a registration whose admission lease this proxy cannot verify"
                );
                return Err(ServerError::ControlUnavailable);
            }
        };
        // The controller compares exactly this binding with the request.
        let expected = AdmissionLeaseBinding {
            owner_user_id: validated.user_id,
            user: validated.username.clone(),
            devserver_id: validated.devserver_id.clone(),
            registration_id,
            proxy_id: self.proxy_id.clone(),
        };
        if claims.binding != expected {
            tracing::warn!(
                %registration_id,
                user = %validated.username,
                "refusing a registration whose admission lease is bound to another registration, proxy, owner or devserver"
            );
            return Err(ServerError::ControlUnavailable);
        }
        let (reply, wait) = oneshot::channel();
        self.requests
            .send(LocalRequest::Admit {
                request_id,
                registration_id,
                owner_user_id: validated.user_id,
                user: validated.username.clone(),
                devserver_id: validated.devserver_id.clone(),
                admission_lease,
                admission_epoch,
                reply,
            })
            .await
            .map_err(|_| ServerError::ControlUnavailable)?;
        let mut cancel = CancelOnDrop {
            requests: self.requests.clone(),
            request_id,
            registration_id,
            armed: true,
        };
        let result = wait.await.map_err(|_| ServerError::ControlUnavailable)?;
        if !*self.readiness.borrow()
            || self.admission_epoch.load(Ordering::Acquire) != admission_epoch
        {
            return Err(ServerError::ControlUnavailable);
        }
        cancel.armed = false;
        result
    }

    fn permit_is_current(&self, permit: RegistrationPermit) -> bool {
        *self.readiness.borrow()
            && self.admission_epoch.load(Ordering::Acquire) == permit.admission_epoch
    }

    async fn cancel(&self, permit: RegistrationPermit) {
        let _ = self
            .requests
            .send(LocalRequest::Cancel {
                request_id: permit.request_id,
                registration_id: permit.registration_id,
            })
            .await;
    }
}

struct CancelOnDrop {
    requests: mpsc::Sender<LocalRequest>,
    request_id: Uuid,
    registration_id: Uuid,
    armed: bool,
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.requests.try_send(LocalRequest::Cancel {
                request_id: self.request_id,
                registration_id: self.registration_id,
            });
        }
    }
}

enum LocalRequest {
    Admit {
        request_id: Uuid,
        registration_id: Uuid,
        owner_user_id: Uuid,
        user: String,
        devserver_id: String,
        admission_lease: AdmissionLease,
        admission_epoch: u64,
        reply: oneshot::Sender<Result<RegistrationPermit, ServerError>>,
    },
    Cancel {
        request_id: Uuid,
        registration_id: Uuid,
    },
}

struct PendingAdmission {
    registration_id: Uuid,
    user: String,
    admission_epoch: u64,
    reply: oneshot::Sender<Result<RegistrationPermit, ServerError>>,
}

enum LifecycleEvent {
    SnapshotAccepted,
    FleetReady,
}

#[allow(clippy::too_many_arguments)]
async fn supervise(
    config: Arc<Config>,
    registry: Registry,
    sessions: SessionStore,
    mut requests: mpsc::Receiver<LocalRequest>,
    readiness: watch::Sender<bool>,
    admission_epoch: Arc<AtomicU64>,
    mut shutdown: watch::Receiver<bool>,
    backoff_observer: BackoffObserver,
) -> anyhow::Result<()> {
    let boot_id = Uuid::new_v4();
    let mut backoff = BACKOFF_MIN;
    let mut grace_deadline = None;
    let mut grace_armed = false;
    let mut convergence_deadline = None;

    loop {
        reject_queued(&mut requests);
        let (lifecycle_tx, mut lifecycle_rx) = mpsc::channel(1);
        let mut attempt = Box::pin(run_connection(
            config.as_ref(),
            boot_id,
            &registry,
            &sessions,
            &mut requests,
            &readiness,
            lifecycle_tx,
        ));
        let outcome = loop {
            tokio::select! {
                biased;
                changed = shutdown.changed() => {
                    let _ = readiness.send(false);
                    if changed.is_err() || *shutdown.borrow() {
                        return Ok(());
                    }
                }
                event = lifecycle_rx.recv() => {
                    match event {
                        Some(LifecycleEvent::SnapshotAccepted) => {
                            if grace_deadline.is_some() && convergence_deadline.is_none() {
                                convergence_deadline =
                                    Some(Instant::now() + CONVERGENCE_GRACE_PERIOD);
                                grace_deadline = convergence_deadline;
                            }
                            backoff = BACKOFF_MIN;
                            tracing::info!(proxy_id = config.proxy_id.as_str(), %boot_id, "controller snapshot accepted; awaiting FleetReady");
                        }
                        Some(LifecycleEvent::FleetReady) => {
                            grace_deadline = None;
                            convergence_deadline = None;
                            grace_armed = true;
                            backoff = BACKOFF_MIN;
                            tracing::info!(proxy_id = config.proxy_id.as_str(), %boot_id, "controller authority restored");
                        }
                        None => {}
                    }
                }
                _ = wait_deadline(grace_deadline) => {
                    let killed = registry.evict_all_for_control_loss();
                    let cleared_sessions = match sessions.clear().await {
                        Ok(cleared) => cleared,
                        Err(error) => {
                            tracing::error!(proxy_id = config.proxy_id.as_str(), %error, "revoked browser-session transports did not drain after controller grace expired");
                            0
                        }
                    };
                    grace_deadline = None;
                    convergence_deadline = None;
                    tracing::warn!(proxy_id = config.proxy_id.as_str(), killed, cleared_sessions, "controller reconnect grace expired");
                }
                outcome = &mut attempt => break outcome,
            }
        };
        drop(attempt);

        admission_epoch.fetch_add(1, Ordering::AcqRel);
        let _ = readiness.send(false);
        reject_queued(&mut requests);
        if grace_armed {
            grace_armed = false;
            grace_deadline = Some(Instant::now() + GRACE_PERIOD);
            convergence_deadline = None;
        }
        match outcome {
            Err(AttemptError::Permanent(message)) => anyhow::bail!(message),
            Err(AttemptError::Retry(message)) => {
                tracing::warn!(proxy_id = config.proxy_id.as_str(), error = %message, "controller connection lost");
            }
            Ok(()) => {
                tracing::warn!(
                    proxy_id = config.proxy_id.as_str(),
                    "controller stream ended"
                );
            }
        }

        let delay = jitter(backoff);
        // The observer exists so tests can assert the backoff schedule
        // without measuring wall-clock gaps between connection attempts,
        // which paused time does not preserve faithfully.
        backoff_observer.observe(delay);
        let sleep = tokio::time::sleep(delay);
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                biased;
                changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow() {
                        return Ok(());
                    }
                }
                _ = wait_deadline(grace_deadline) => {
                    let killed = registry.evict_all_for_control_loss();
                    let cleared_sessions = match sessions.clear().await {
                        Ok(cleared) => cleared,
                        Err(error) => {
                            tracing::error!(proxy_id = config.proxy_id.as_str(), %error, "revoked browser-session transports did not drain after controller grace expired");
                            0
                        }
                    };
                    grace_deadline = None;
                    convergence_deadline = None;
                    tracing::warn!(proxy_id = config.proxy_id.as_str(), killed, cleared_sessions, "controller reconnect grace expired");
                }
                request = requests.recv() => {
                    match request {
                        Some(request) => reject_request(request),
                        None => return Err(anyhow::anyhow!("control admission channel closed")),
                    }
                }
                _ = &mut sleep => break,
            }
        }
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

async fn run_connection(
    config: &Config,
    boot_id: Uuid,
    registry: &Registry,
    sessions: &SessionStore,
    requests: &mut mpsc::Receiver<LocalRequest>,
    readiness: &watch::Sender<bool>,
    lifecycle: mpsc::Sender<LifecycleEvent>,
) -> Result<(), AttemptError> {
    let host = config
        .control_url
        .host_str()
        .ok_or_else(|| AttemptError::Permanent("controller URL has no host".into()))?;
    let port = config
        .control_url
        .port_or_known_default()
        .ok_or_else(|| AttemptError::Permanent("controller URL has no port".into()))?;
    let tcp = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host, port)))
        .await
        .map_err(|_| AttemptError::Retry("controller TCP connect timed out".into()))?
        .map_err(|error| AttemptError::Retry(format!("controller TCP connect: {error}")))?;
    let loopback_host = host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback());
    if loopback_host
        && !tcp
            .peer_addr()
            .map(|peer| peer.ip().is_loopback())
            .unwrap_or(false)
    {
        return Err(AttemptError::Permanent(
            "loopback controller URL resolved to a non-loopback peer".into(),
        ));
    }
    let _ = tcp.set_nodelay(true);
    let (mut sender, mut connection) =
        tokio::time::timeout(CONNECT_TIMEOUT, h2::client::handshake(tcp))
            .await
            .map_err(|_| AttemptError::Retry("controller h2 handshake timed out".into()))?
            .map_err(|error| AttemptError::Retry(format!("controller h2 handshake: {error}")))?;

    let mut connect_url = config.control_url.clone();
    connect_url.set_path(CONNECT_PATH);
    let request = Request::builder()
        .method(Method::POST)
        .uri(connect_url.as_str())
        .header(
            header::AUTHORIZATION,
            format!("Bearer {}", config.proxy_token),
        )
        .header("x-chan-proxy-id", config.proxy_id.as_str())
        .header(header::CONTENT_TYPE, CONTENT_TYPE)
        .body(())
        .map_err(|error| AttemptError::Permanent(format!("build controller request: {error}")))?;
    let (response, send) = sender
        .send_request(request, false)
        .map_err(|error| AttemptError::Retry(format!("send controller request: {error}")))?;
    let response = tokio::select! {
        result = &mut connection => {
            return Err(AttemptError::Retry(format!("controller h2 connection: {:?}", result.err())));
        }
        result = tokio::time::timeout(CONNECT_TIMEOUT, response) => {
            result
                .map_err(|_| AttemptError::Retry("controller response timed out".into()))?
                .map_err(|error| AttemptError::Retry(format!("controller response: {error}")))?
        }
    };
    if response.status() != StatusCode::OK {
        let message = format!("controller rejected proxy with HTTP {}", response.status());
        return if response.status().is_client_error() {
            Err(AttemptError::Permanent(message))
        } else {
            Err(AttemptError::Retry(message))
        };
    }
    if response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        != Some(CONTENT_TYPE)
    {
        return Err(AttemptError::Permanent(
            "controller returned the wrong content type".into(),
        ));
    }

    let stream = run_stream(
        H2Duplex::new(send, response.into_body()),
        config,
        boot_id,
        registry,
        sessions,
        requests,
        readiness,
        lifecycle,
    );
    tokio::pin!(stream);
    tokio::select! {
        result = stream => result,
        result = &mut connection => {
            Err(AttemptError::Retry(format!("controller h2 connection ended: {:?}", result.err())))
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_stream<S>(
    stream: S,
    config: &Config,
    boot_id: Uuid,
    registry: &Registry,
    sessions: &SessionStore,
    requests: &mut mpsc::Receiver<LocalRequest>,
    readiness: &watch::Sender<bool>,
    lifecycle: mpsc::Sender<LifecycleEvent>,
) -> Result<(), AttemptError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut reader, mut writer) = tokio::io::split(stream);
    tokio::time::timeout(
        CONNECT_TIMEOUT,
        write_control(
            &mut writer,
            &ClientFrame::ClientHello {
                protocol_version: PROTOCOL_VERSION,
                package_version: env!("CARGO_PKG_VERSION").into(),
                proxy_id: config.proxy_id.clone(),
                proxy_base_url: config.proxy_base_url.clone(),
                boot_id,
            },
        ),
    )
    .await
    .map_err(|_| AttemptError::Retry("controller ClientHello write timed out".into()))??;
    let hello = tokio::time::timeout(CONNECT_TIMEOUT, read_control(&mut reader))
        .await
        .map_err(|_| AttemptError::Retry("controller ServerHello read timed out".into()))??;
    match hello {
        ServerFrame::ServerHello {
            protocol_version,
            package_version,
            heartbeat_seconds,
            dead_seconds,
            grace_seconds,
        } if protocol_version == PROTOCOL_VERSION
            && package_version == env!("CARGO_PKG_VERSION")
            && heartbeat_seconds == 5
            && dead_seconds == 15
            && grace_seconds == PROXY_CONTROL_LOSS_GRACE_SECONDS => {}
        ServerFrame::Shutdown {
            reason,
            retryable: _,
        } => return Err(AttemptError::Retry(reason)),
        _ => {
            return Err(AttemptError::Retry(
                "controller returned an invalid ServerHello".into(),
            ))
        }
    }

    let (_registry_generation, snapshot, mut events) = registry.tunnels().snapshot_and_subscribe();
    let (session_snapshot, mut session_events) = sessions.snapshot_and_subscribe();
    // Registrations this connection never published: rows left out of the
    // snapshot and TunnelUps not sent, each already evicted. Their later
    // registry events describe rows the controller does not hold, so they
    // are dropped without spending a generation.
    let mut unpublished = HashSet::new();
    // Rows are built before chunking so a row left out cannot leave a
    // chunk short or empty; the snapshot carries exactly the rows counted.
    let rows: Vec<TunnelRow> = snapshot
        .iter()
        .filter_map(|info| match tunnel_row(info, config) {
            Ok(row) => Some(row),
            Err(reason) => {
                evict_unpublishable(registry, config, info, reason, &mut unpublished);
                None
            }
        })
        .collect();
    // Tunnel and browser-session mutations share one connection-local
    // generation. Source registries retain their own counters only for their
    // local broadcast mechanics.
    let base_generation = 0;
    tracing::info!(
        proxy_id = config.proxy_id.as_str(),
        %boot_id,
        base_generation,
        rows = rows.len(),
        browser_sessions = session_snapshot.len(),
        "publishing controller registry snapshot"
    );
    let publish_snapshot = async {
        write_control(&mut writer, &ClientFrame::SnapshotStart { base_generation }).await?;
        for chunk in rows.chunks(MAX_SNAPSHOT_CHUNK_ROWS) {
            write_control(
                &mut writer,
                &ClientFrame::SnapshotChunk {
                    rows: chunk.to_vec(),
                },
            )
            .await?;
        }
        for chunk in session_snapshot.chunks(MAX_SNAPSHOT_CHUNK_ROWS) {
            write_control(
                &mut writer,
                &ClientFrame::BrowserSessionSnapshotChunk {
                    rows: chunk.to_vec(),
                },
            )
            .await?;
        }
        write_control(&mut writer, &ClientFrame::SnapshotEnd { base_generation }).await
    };
    tokio::time::timeout(SNAPSHOT_TIMEOUT, publish_snapshot)
        .await
        .map_err(|_| AttemptError::Retry("controller snapshot write timed out".into()))??;

    // Keep exactly one framed read alive for the lifetime of the active
    // session. Recreating `read_frame` inside `select!` would cancel a
    // partially consumed length or JSON payload whenever a local registry
    // event won the race, corrupting the next frame boundary.
    let (frames_tx, mut frames) = mpsc::channel(SERVER_FRAME_QUEUE_CAPACITY);
    let (overflow_tx, mut overflow) = mpsc::channel(1);
    let reader_task = AbortOnDropTask::new(tokio::spawn(async move {
        loop {
            let frame = read_control(&mut reader).await;
            let terminal = frame.is_err();
            match frames_tx.try_send(frame) {
                Ok(()) if !terminal => {}
                Ok(()) => break,
                Err(mpsc::error::TrySendError::Full(_)) => {
                    let _ = overflow_tx.try_send(());
                    break;
                }
                Err(mpsc::error::TrySendError::Closed(_)) => break,
            }
        }
    }));

    let mut fleet_ready = false;
    let mut snapshot_accepted = false;
    let mut controller_deadline = Instant::now() + CONTROLLER_DEAD_AFTER;
    let mut pending: HashMap<Uuid, PendingAdmission> = HashMap::new();
    let mut overflow_open = true;
    let mut generation = base_generation;
    let mut expiry_tick = tokio::time::interval(Duration::from_secs(1));
    expiry_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let result = async {
        loop {
            tokio::select! {
                biased;
                _ = tokio::time::sleep_until(controller_deadline) => {
                    break Err(AttemptError::Retry("controller heartbeat deadline expired".into()));
                }
                overflowed = overflow.recv(), if overflow_open => {
                    match overflowed {
                        Some(()) => break Err(AttemptError::Retry("controller frame queue overflowed".into())),
                        None => overflow_open = false,
                    }
                }
                frame = frames.recv() => {
                    let frame = frame
                        .ok_or_else(|| AttemptError::Retry("controller frame reader stopped".into()))??;
                    controller_deadline = Instant::now() + CONTROLLER_DEAD_AFTER;
                    match frame {
                    ServerFrame::SnapshotAccepted { base_generation: accepted }
                        if !snapshot_accepted && accepted == base_generation => {
                            snapshot_accepted = true;
                            lifecycle.send(LifecycleEvent::SnapshotAccepted).await
                                .map_err(|_| AttemptError::Retry("control supervisor stopped".into()))?;
                        }
                    ServerFrame::FleetReady if snapshot_accepted && !fleet_ready => {
                        fleet_ready = true;
                        sessions.resume_authority();
                        let _ = readiness.send(true);
                        lifecycle.send(LifecycleEvent::FleetReady).await
                            .map_err(|_| AttemptError::Retry("control supervisor stopped".into()))?;
                        tracing::info!(
                            proxy_id = config.proxy_id.as_str(),
                            %boot_id,
                            "proxy control session reached FleetReady"
                        );
                    }
                    ServerFrame::AdmissionDecision {
                        request_id,
                        registration_id,
                        decision,
                    } if fleet_ready => {
                        let Some(pending_admission) = pending.remove(&request_id) else {
                            continue;
                        };
                        if pending_admission.registration_id != registration_id {
                            break Err(AttemptError::Retry("controller admission id mismatch".into()));
                        }
                        tracing::debug!(
                            proxy_id = config.proxy_id.as_str(),
                            %request_id,
                            %registration_id,
                            ?decision,
                            "controller admission decision received"
                        );
                        let reply = match decision {
                            AdmissionDecision::Admit => Ok(RegistrationPermit {
                                request_id,
                                registration_id,
                                admission_epoch: pending_admission.admission_epoch,
                            }),
                            AdmissionDecision::AtCapacity => Err(ServerError::AdmissionAtCapacity { user: pending_admission.user }),
                            AdmissionDecision::ControlWarming | AdmissionDecision::Stale => Err(ServerError::ControlUnavailable),
                        };
                        let _ = pending_admission.reply.send(reply);
                    }
                    ServerFrame::KillRegistrations { command_id, registration_ids }
                        if snapshot_accepted => {
                        let mut killed = Vec::new();
                        let mut missing = Vec::new();
                        for registration_id in registration_ids {
                            if registry.tunnels().evict_registration(registration_id) {
                                killed.push(registration_id);
                            } else {
                                missing.push(registration_id);
                            }
                        }
                        tracing::info!(
                            proxy_id = config.proxy_id.as_str(),
                            %command_id,
                            killed = killed.len(),
                            missing = missing.len(),
                            "controller kill command completed"
                        );
                        write_active(&mut writer, &ClientFrame::CommandResult {
                            command_id,
                            killed,
                            missing,
                            failed: Vec::new(),
                        }, controller_deadline).await?;
                    }
                    ServerFrame::RevokeSessions {
                        command_id,
                        revocation,
                    } => {
                        let revocation = match revocation {
                            SessionRevocation::Exact {
                                subject_user_id,
                                owner_user_id,
                                devserver_id,
                            } => crate::session_store::Revocation::Exact {
                                subject_user_id,
                                owner_user_id,
                                devserver_id,
                            },
                            SessionRevocation::Subject { subject_user_id } => {
                                crate::session_store::Revocation::Subject { subject_user_id }
                            }
                            SessionRevocation::SessionId { admin_session_id } => {
                                crate::session_store::Revocation::SessionId { admin_session_id }
                            }
                            SessionRevocation::Owner { owner_user_id } => {
                                crate::session_store::Revocation::Owner { owner_user_id }
                            }
                            SessionRevocation::All => crate::session_store::Revocation::All,
                        };
                        let revoked = sessions.revoke(&revocation).await.map_err(|error| {
                            AttemptError::Retry(format!(
                                "session revocation transport shutdown failed: {error}"
                            ))
                        })?;
                        write_active(
                            &mut writer,
                            &ClientFrame::SessionRevocationResult {
                                command_id,
                                revoked,
                            },
                            controller_deadline,
                        )
                        .await?;
                    }
                    ServerFrame::ResyncRequired { expected_generation } => {
                        tracing::warn!(
                            proxy_id = config.proxy_id.as_str(),
                            expected_generation,
                            "controller requested registry resync"
                        );
                        break Err(AttemptError::Retry("controller requested a fresh snapshot".into()));
                    }
                    ServerFrame::Ping { nonce } => {
                        tracing::debug!(nonce, "controller heartbeat received");
                        write_active(
                            &mut writer,
                            &ClientFrame::Pong { nonce },
                            controller_deadline,
                        )
                        .await?;
                    }
                    ServerFrame::Shutdown {
                        reason,
                        retryable: _,
                    } => break Err(AttemptError::Retry(reason)),
                    _ => break Err(AttemptError::Retry("controller sent a frame illegal in the current state".into())),
                    }
                }
                event = events.recv() => {
                    match event {
                        Ok(RegistryEvent::TunnelUp { generation: _, row: info }) => {
                            // The row is built before the generation moves, so
                            // one left out leaves no gap.
                            let row = match tunnel_row(&info, config) {
                                Ok(row) => row,
                                Err(reason) => {
                                    evict_unpublishable(registry, config, &info, reason, &mut unpublished);
                                    continue;
                                }
                            };
                            generation = next_generation(generation)?;
                            tracing::debug!(
                                proxy_id = config.proxy_id.as_str(),
                                generation,
                                registration_id = %row.registration_id,
                                "publishing tunnel up"
                            );
                            write_active(
                                &mut writer,
                                &ClientFrame::TunnelUp { generation, row },
                                controller_deadline,
                            )
                            .await?;
                        }
                        Ok(RegistryEvent::TunnelDown { generation: _, registration_id }) => {
                            // Every registration is removed exactly once, so
                            // this is the last event naming it.
                            if unpublished.remove(&registration_id) {
                                continue;
                            }
                            generation = next_generation(generation)?;
                            tracing::debug!(
                                proxy_id = config.proxy_id.as_str(),
                                generation,
                                %registration_id,
                                "publishing tunnel down"
                            );
                            write_active(
                                &mut writer,
                                &ClientFrame::TunnelDown { generation, registration_id },
                                controller_deadline,
                            )
                            .await?;
                        }
                        Ok(RegistryEvent::LeaseRefresh {
                            registration_id,
                            owner_user_id,
                            admission_lease,
                            admission_lease_expires_at: _,
                        }) => {
                            if unpublished.contains(&registration_id) {
                                continue;
                            }
                            let admission_lease = match refreshed_lease(config, registration_id, owner_user_id, &admission_lease) {
                                Ok(admission_lease) => admission_lease,
                                Err(reason) => {
                                    // The registration was published, so the
                                    // eviction's TunnelDown is an ordinary delta:
                                    // it is not added to `unpublished`.
                                    let evicted = registry.tunnels().evict_registration(registration_id);
                                    tracing::warn!(
                                        proxy_id = config.proxy_id.as_str(),
                                        %registration_id,
                                        evicted,
                                        %reason,
                                        "evicted a local tunnel whose refreshed admission lease this proxy cannot verify"
                                    );
                                    continue;
                                }
                            };
                            write_active(
                                &mut writer,
                                &ClientFrame::LeaseRefresh {
                                    registration_id,
                                    admission_lease,
                                },
                                controller_deadline,
                            )
                            .await?;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            break Err(AttemptError::Retry("registry event receiver lagged".into()));
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                            break Err(AttemptError::Permanent("registry event stream closed".into()));
                        }
                    }
                }
                event = session_events.recv() => {
                    generation = next_generation(generation)?;
                    let frame = match event {
                        Ok(SessionEvent::Up(row)) => {
                            ClientFrame::BrowserSessionUp { generation, row }
                        }
                        Ok(SessionEvent::Down(admin_session_id)) => {
                            ClientFrame::BrowserSessionDown {
                                generation,
                                admin_session_id,
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            break Err(AttemptError::Retry(
                                "browser-session event receiver lagged".into(),
                            ));
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                            break Err(AttemptError::Permanent(
                                "browser-session event stream closed".into(),
                            ));
                        }
                    };
                    write_active(&mut writer, &frame, controller_deadline).await?;
                }
                _ = expiry_tick.tick() => {
                    sessions.prune_expired();
                }
                request = requests.recv() => {
                    let Some(request) = request else {
                        break Err(AttemptError::Permanent("control admission channel closed".into()));
                    };
                    match request {
                        LocalRequest::Admit {
                            request_id,
                            registration_id,
                            owner_user_id,
                            user,
                            devserver_id,
                            admission_lease,
                            admission_epoch,
                            reply,
                        } => {
                            if !fleet_ready {
                                let _ = reply.send(Err(ServerError::ControlUnavailable));
                                continue;
                            }
                            write_active(
                                &mut writer,
                                &ClientFrame::AdmissionRequest {
                                    request_id,
                                    registration_id,
                                    owner_user_id,
                                    user: user.clone(),
                                    devserver_id,
                                    admission_lease,
                                },
                                controller_deadline,
                            )
                            .await?;
                            pending.insert(request_id, PendingAdmission {
                                registration_id,
                                user,
                                admission_epoch,
                                reply,
                            });
                        }
                        LocalRequest::Cancel { request_id, registration_id } => {
                            pending.remove(&request_id);
                            write_active(
                                &mut writer,
                                &ClientFrame::AdmissionCancel { request_id, registration_id },
                                controller_deadline,
                            )
                            .await?;
                        }
                    }
                }
            }
        }
    }
    .await;
    for (_, pending) in pending {
        let _ = pending.reply.send(Err(ServerError::ControlUnavailable));
    }
    reader_task.cancel().await;
    result
}

/// Why one local registration cannot be published to the controller.
enum Unpublishable {
    /// The registration carries no lease or no expiry. Controller admission
    /// never registers such a tunnel, so this is a local invariant broken.
    MissingLease(&'static str),
    /// The lease does not parse, or no longer verifies under this proxy's
    /// ring: signed by a key outside it, expired, or past a signed bound.
    Lease(String),
}

fn tunnel_row(info: &TunnelInfo, config: &Config) -> Result<TunnelRow, Unpublishable> {
    let admission_lease = info
        .admission_lease
        .as_deref()
        .ok_or(Unpublishable::MissingLease("no admission lease"))?;
    let admission_lease_expires_at = info
        .admission_lease_expires_at
        .ok_or(Unpublishable::MissingLease("no admission lease expiry"))?;
    let admission_lease = AdmissionLease::parse(admission_lease.to_string())
        .map_err(|error| Unpublishable::Lease(error.to_string()))?;
    let claims = config
        .admission_lease_verifier
        .verify(&admission_lease, chrono::Utc::now())
        .map_err(|error| Unpublishable::Lease(error.to_string()))?;
    Ok(TunnelRow {
        registration_id: info.registration_id,
        owner_user_id: info.owner_user_id,
        user: info.user.as_ref().to_string(),
        devserver_id: info.workspace.as_ref().to_string(),
        max_connected_devservers: claims.max_connected_devservers,
        admission_lease,
        admission_lease_expires_at,
        peer_addr: info.peer_addr,
        connected_at: info.connected_at,
    })
}

/// Check a refreshed lease the way the controller will before forwarding
/// it: it must parse, verify under this proxy's ring, and name this
/// registration, on this proxy, for the owner the registry holds it under.
/// The controller compares the user and devserver with its row as well.
fn refreshed_lease(
    config: &Config,
    registration_id: Uuid,
    owner_user_id: Uuid,
    raw: &str,
) -> Result<AdmissionLease, String> {
    let lease = AdmissionLease::parse(raw).map_err(|error| error.to_string())?;
    let claims = config
        .admission_lease_verifier
        .verify(&lease, chrono::Utc::now())
        .map_err(|error| error.to_string())?;
    if claims.binding.registration_id != registration_id
        || claims.binding.proxy_id != config.proxy_id
        || claims.binding.owner_user_id != owner_user_id
    {
        return Err("admission lease is bound to another registration, proxy or owner".into());
    }
    Ok(lease)
}

/// Take one registration whose row cannot be published off this node,
/// and remember that the controller never saw it.
///
/// Ending the control stream instead would not help: the registry still
/// holds the tunnel, so every reconnect's snapshot meets the same row, and
/// the loop ends only when the reconnect grace evicts every tunnel on the
/// node. Evicting just this registration fails it closed and leaves the
/// rest of the node served. The eviction raises a `TunnelDown` for it,
/// which `run_stream` drops by this set: the controller has no such row
/// and would read the delta as a reason to resync.
fn evict_unpublishable(
    registry: &Registry,
    config: &Config,
    info: &TunnelInfo,
    reason: Unpublishable,
    unpublished: &mut HashSet<Uuid>,
) {
    let evicted = registry.tunnels().evict_registration(info.registration_id);
    unpublished.insert(info.registration_id);
    match reason {
        Unpublishable::MissingLease(reason) => tracing::error!(
            proxy_id = config.proxy_id.as_str(),
            registration_id = %info.registration_id,
            user = %info.user,
            evicted,
            reason,
            "evicted a local tunnel that cannot be published to the controller"
        ),
        Unpublishable::Lease(reason) => tracing::warn!(
            proxy_id = config.proxy_id.as_str(),
            registration_id = %info.registration_id,
            user = %info.user,
            evicted,
            %reason,
            "evicted a local tunnel whose admission lease this proxy cannot verify"
        ),
    }
}

fn next_generation(current: u64) -> Result<u64, AttemptError> {
    current
        .checked_add(1)
        .ok_or_else(|| AttemptError::Retry("control generation overflowed".into()))
}

async fn write_control<S>(stream: &mut S, frame: &ClientFrame) -> Result<(), AttemptError>
where
    S: tokio::io::AsyncWrite + Unpin,
{
    write_frame(stream, frame)
        .await
        .map_err(|error| AttemptError::Retry(format!("write controller frame: {error}")))
}

async fn write_active<S>(
    stream: &mut S,
    frame: &ClientFrame,
    controller_deadline: Instant,
) -> Result<(), AttemptError>
where
    S: tokio::io::AsyncWrite + Unpin,
{
    tokio::select! {
        biased;
        _ = tokio::time::sleep_until(controller_deadline) => {
            Err(AttemptError::Retry("controller heartbeat deadline expired during write".into()))
        }
        result = write_control(stream, frame) => result,
    }
}

async fn read_control<S>(stream: &mut S) -> Result<ServerFrame, AttemptError>
where
    S: tokio::io::AsyncRead + Unpin,
{
    read_frame(stream)
        .await
        .map_err(|error| AttemptError::Retry(format!("read controller frame: {error}")))
}

fn reject_queued(requests: &mut mpsc::Receiver<LocalRequest>) {
    while let Ok(request) = requests.try_recv() {
        reject_request(request);
    }
}

fn reject_request(request: LocalRequest) {
    if let LocalRequest::Admit { reply, .. } = request {
        let _ = reply.send(Err(ServerError::ControlUnavailable));
    }
}

fn jitter(base: Duration) -> Duration {
    let percent = rand::thread_rng().gen_range(80_u32..=120);
    base.mul_f64(f64::from(percent) / 100.0)
}

async fn wait_deadline(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

#[derive(Debug, thiserror::Error)]
enum AttemptError {
    #[error("{0}")]
    Retry(String),
    #[error("{0}")]
    Permanent(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    use async_trait::async_trait;
    use chan_tunnel_proto::{Hello, ProtocolVersion};
    use chan_tunnel_server::{serve_tunnel_listener_with_admission, Validated, Validator};
    use devserver_control::{
        serve_control_listener, spawn_controller_owned, ControllerHandle, ProxyCredentials,
        ProxyStatus,
    };
    use devserver_control_proto::{
        AdmissionLeaseSigner, AdmissionLeaseVerifier, ProxyOriginTemplate,
    };
    use http_body_util::BodyExt;
    use tokio::io::duplex;
    use tokio::net::TcpListener;
    use tokio_util::compat::FuturesAsyncReadCompatExt;

    const TEST_PROXY_TOKEN: &str = "0123456789abcdef0123456789abcdef";

    fn test_config(control_addr: std::net::SocketAddr) -> Arc<Config> {
        Arc::new(Config {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            tunnel_bind_addr: "127.0.0.1:0".parse().unwrap(),
            apex_host: "p1.proxy.chan.app".into(),
            wildcard_suffix: ".p1.proxy.chan.app".into(),
            identity_url: "http://127.0.0.1:7000/".parse().unwrap(),
            identity_auth_token: "identity-token".into(),
            dashboard_url: "https://gw.chan.app/workspaces".into(),
            identity_origin: devserver_control_proto::CanonicalOrigin::parse("https://gw.chan.app")
                .unwrap(),
            entry_verifiers: {
                let signer = gateway_common::devserver_gate::EntrySigner::from_base64(
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                )
                .unwrap();
                gateway_common::devserver_gate::EntryVerifierRing::from_base64_list(
                    &signer.verifying_key_base64(),
                )
                .unwrap()
            },
            admission_lease_verifier: {
                let signer = AdmissionLeaseSigner::from_base64(
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                )
                .unwrap();
                AdmissionLeaseVerifier::from_base64(&signer.verifying_key_base64()).unwrap()
            },
            control_url: format!("http://{control_addr}/").parse().unwrap(),
            proxy_token: TEST_PROXY_TOKEN.into(),
            proxy_id: devserver_control_proto::ProxyId::parse("p1").unwrap(),
            proxy_base_url: devserver_control_proto::CanonicalOrigin::parse(
                "https://p1.proxy.chan.app",
            )
            .unwrap(),
            max_response_bytes: None,
            max_request_bytes: None,
            request_timeout: None,
            ws_idle_timeout: crate::config::DEFAULT_WS_IDLE_TIMEOUT,
            session_max_active: 10_000,
            session_lifetime: Duration::from_secs(3600),
            entry_replay_max_active: 10_000,
            forwarded_proto: "https".into(),
        })
    }

    async fn settle() {
        for _ in 0..100 {
            tokio::task::yield_now().await;
        }
    }

    async fn assert_snapshot_active(controller: &ControllerHandle) {
        let mut proxies = controller.watch_proxies();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if proxies
                    .borrow()
                    .first()
                    .is_some_and(|proxy| proxy.status == ProxyStatus::Active)
                {
                    return;
                }
                proxies.changed().await.unwrap();
            }
        })
        .await
        .expect("controller never accepted the proxy snapshot");
    }

    #[tokio::test]
    async fn real_controller_accepts_the_supervisor_snapshot_over_h2() {
        let _ = tracing_subscriber::fmt()
            .with_test_writer()
            .with_env_filter(tracing_subscriber::EnvFilter::new(
                "devserver_proxy::control=debug,devserver_control=debug,h2=off",
            ))
            .try_init();
        let (controller, actor_task) = spawn_controller_owned(100);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let control_addr = listener.local_addr().unwrap();
        let template = ProxyOriginTemplate::parse("https://{proxy_id}.proxy.chan.app").unwrap();
        let (listener_shutdown, listener_shutdown_rx) = watch::channel(false);
        let signer =
            AdmissionLeaseSigner::from_base64("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
                .unwrap();
        let verifier = AdmissionLeaseVerifier::from_base64(&signer.verifying_key_base64()).unwrap();
        let listener_task = tokio::spawn(serve_control_listener(
            listener,
            controller.clone(),
            ProxyCredentials::parse(&format!("p1={TEST_PROXY_TOKEN}")).unwrap(),
            verifier,
            template.clone(),
            listener_shutdown_rx,
        ));

        let registry = Registry::new();
        let (proxy_shutdown, proxy_shutdown_rx) = watch::channel(false);
        let ControlRuntime {
            admission: _admission,
            readiness,
            task: mut supervisor_task,
        } = spawn_control_supervisor(
            test_config(control_addr),
            registry,
            SessionStore::new(100, Duration::from_secs(3600)),
            proxy_shutdown_rx,
        );

        settle().await;
        tokio::select! {
            result = &mut supervisor_task => {
                panic!("control supervisor exited before snapshot: {result:?}");
            }
            () = assert_snapshot_active(&controller) => {}
        }
        assert!(!*readiness.borrow());

        proxy_shutdown.send(true).unwrap();
        listener_shutdown.send(true).unwrap();
        supervisor_task.await.unwrap().unwrap();
        listener_task.await.unwrap().unwrap();
        drop(controller);
        actor_task.await.unwrap();
    }

    #[tokio::test]
    async fn stream_correlates_admission_and_heartbeats_after_fleet_ready() {
        let config = test_config("127.0.0.1:1".parse().unwrap());
        let registry = Registry::new();
        let (requests_tx, mut requests_rx) = mpsc::channel(8);
        let (readiness_tx, readiness) = watch::channel(false);
        let (lifecycle_tx, mut lifecycle_rx) = mpsc::channel(1);
        let admission = ControlAdmission {
            requests: requests_tx,
            readiness: readiness.clone(),
            admission_epoch: Arc::new(AtomicU64::new(1)),
            admission_lease_verifier: config.admission_lease_verifier.clone(),
            proxy_id: config.proxy_id.clone(),
        };
        let boot_id = Uuid::new_v4();
        let (proxy, mut controller) = duplex(64 * 1024);

        let server = tokio::spawn(async move {
            let hello: ClientFrame = read_frame(&mut controller).await.unwrap();
            assert!(matches!(
                hello,
                ClientFrame::ClientHello {
                    protocol_version: PROTOCOL_VERSION,
                    ..
                }
            ));
            write_frame(
                &mut controller,
                &ServerFrame::ServerHello {
                    protocol_version: PROTOCOL_VERSION,
                    package_version: env!("CARGO_PKG_VERSION").into(),
                    heartbeat_seconds: 5,
                    dead_seconds: 15,
                    grace_seconds: 30,
                },
            )
            .await
            .unwrap();

            assert!(matches!(
                read_frame::<_, ClientFrame>(&mut controller).await.unwrap(),
                ClientFrame::SnapshotStart { base_generation: 0 }
            ));
            assert!(matches!(
                read_frame::<_, ClientFrame>(&mut controller).await.unwrap(),
                ClientFrame::SnapshotEnd { base_generation: 0 }
            ));
            let warming_revocation = Uuid::new_v4();
            write_frame(
                &mut controller,
                &ServerFrame::RevokeSessions {
                    command_id: warming_revocation,
                    revocation: SessionRevocation::Subject {
                        subject_user_id: Uuid::new_v4(),
                    },
                },
            )
            .await
            .unwrap();
            assert!(matches!(
                read_frame::<_, ClientFrame>(&mut controller).await.unwrap(),
                ClientFrame::SessionRevocationResult {
                    command_id,
                    revoked: 0,
                } if command_id == warming_revocation
            ));
            write_frame(
                &mut controller,
                &ServerFrame::SnapshotAccepted { base_generation: 0 },
            )
            .await
            .unwrap();
            write_frame(&mut controller, &ServerFrame::FleetReady)
                .await
                .unwrap();

            let request = read_frame::<_, ClientFrame>(&mut controller).await.unwrap();
            let ClientFrame::AdmissionRequest {
                request_id,
                registration_id,
                user,
                devserver_id,
                ..
            } = request
            else {
                panic!("expected admission request, got {request:?}");
            };
            assert_eq!(user, "alice");
            assert_eq!(devserver_id, "devserver-a");
            write_frame(
                &mut controller,
                &ServerFrame::AdmissionDecision {
                    request_id,
                    registration_id,
                    decision: AdmissionDecision::Admit,
                },
            )
            .await
            .unwrap();
            assert!(matches!(
                read_frame::<_, ClientFrame>(&mut controller).await.unwrap(),
                ClientFrame::AdmissionCancel {
                    request_id: canceled_request,
                    registration_id: canceled_registration,
                } if canceled_request == request_id && canceled_registration == registration_id
            ));

            let request = read_frame::<_, ClientFrame>(&mut controller).await.unwrap();
            let ClientFrame::AdmissionRequest {
                request_id,
                registration_id,
                ..
            } = request
            else {
                panic!("expected second admission request, got {request:?}");
            };
            write_frame(
                &mut controller,
                &ServerFrame::AdmissionDecision {
                    request_id,
                    registration_id,
                    decision: AdmissionDecision::AtCapacity,
                },
            )
            .await
            .unwrap();

            write_frame(&mut controller, &ServerFrame::Ping { nonce: 42 })
                .await
                .unwrap();
            assert!(matches!(
                read_frame::<_, ClientFrame>(&mut controller).await.unwrap(),
                ClientFrame::Pong { nonce: 42 }
            ));
            write_frame(&mut controller, &ServerFrame::FleetReady)
                .await
                .unwrap();
        });

        let client = tokio::spawn(async move {
            run_stream(
                proxy,
                config.as_ref(),
                boot_id,
                &registry,
                &SessionStore::new(100, Duration::from_secs(3600)),
                &mut requests_rx,
                &readiness_tx,
                lifecycle_tx,
            )
            .await
        });

        let mut readiness_wait = readiness.clone();
        while !*readiness_wait.borrow() {
            readiness_wait.changed().await.unwrap();
        }
        assert!(matches!(
            lifecycle_rx.recv().await,
            Some(LifecycleEvent::SnapshotAccepted)
        ));

        let hello = Hello {
            protocol: ProtocolVersion::V1,
            client_version: "test".into(),
            workspace: "devserver".into(),
            name: None,
        };
        let registration_id = Uuid::new_v4();
        let validated = validated_with_lease(
            Uuid::new_v4(),
            "alice",
            "devserver-a",
            registration_id,
            TEST_ADMISSION_SIGNING_KEY,
        );
        let permit = admission
            .admit_registration(&hello, &validated, registration_id)
            .await
            .unwrap();
        admission.cancel(permit).await;
        let error = admission
            .admit_registration(&hello, &validated, registration_id)
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            ServerError::AdmissionAtCapacity { user } if user == "alice"
        ));

        server.await.unwrap();
        let error = client.await.unwrap().unwrap_err();
        assert!(matches!(
            error,
            AttemptError::Retry(reason)
                if reason == "controller sent a frame illegal in the current state"
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn stream_expires_when_an_active_controller_goes_silent() {
        let config = test_config("127.0.0.1:1".parse().unwrap());
        let registry = Registry::new();
        let (_requests_tx, mut requests_rx) = mpsc::channel(1);
        let (readiness_tx, readiness) = watch::channel(false);
        // `run_stream` reports both SnapshotAccepted and FleetReady. This
        // direct unit test does not run the supervisor, so retain both
        // events without backpressuring the stream before its heartbeat
        // deadline can fire.
        let (lifecycle_tx, _lifecycle_rx) = mpsc::channel(2);
        let boot_id = Uuid::new_v4();
        let (proxy, mut controller) = duplex(64 * 1024);

        let server = tokio::spawn(async move {
            let _: ClientFrame = read_frame(&mut controller).await.unwrap();
            write_frame(
                &mut controller,
                &ServerFrame::ServerHello {
                    protocol_version: PROTOCOL_VERSION,
                    package_version: env!("CARGO_PKG_VERSION").into(),
                    heartbeat_seconds: 5,
                    dead_seconds: 15,
                    grace_seconds: 30,
                },
            )
            .await
            .unwrap();
            assert!(matches!(
                read_frame::<_, ClientFrame>(&mut controller).await.unwrap(),
                ClientFrame::SnapshotStart { base_generation: 0 }
            ));
            assert!(matches!(
                read_frame::<_, ClientFrame>(&mut controller).await.unwrap(),
                ClientFrame::SnapshotEnd { base_generation: 0 }
            ));
            write_frame(
                &mut controller,
                &ServerFrame::SnapshotAccepted { base_generation: 0 },
            )
            .await
            .unwrap();
            write_frame(&mut controller, &ServerFrame::FleetReady)
                .await
                .unwrap();
            std::future::pending::<()>().await;
        });

        let client = tokio::spawn(async move {
            run_stream(
                proxy,
                config.as_ref(),
                boot_id,
                &registry,
                &SessionStore::new(100, Duration::from_secs(3600)),
                &mut requests_rx,
                &readiness_tx,
                lifecycle_tx,
            )
            .await
        });

        let mut readiness_wait = readiness.clone();
        while !*readiness_wait.borrow() {
            readiness_wait.changed().await.unwrap();
        }
        let error = client.await.unwrap().unwrap_err();
        assert!(matches!(
            error,
            AttemptError::Retry(reason)
                if reason == "controller heartbeat deadline expired"
        ));
        server.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn stream_bounds_the_server_hello_wait() {
        let config = test_config("127.0.0.1:1".parse().unwrap());
        let registry = Registry::new();
        let (_requests_tx, mut requests_rx) = mpsc::channel(1);
        let (readiness_tx, _readiness) = watch::channel(false);
        let (lifecycle_tx, _lifecycle_rx) = mpsc::channel(1);
        let (proxy, mut controller) = duplex(64 * 1024);
        let server = tokio::spawn(async move {
            let _: ClientFrame = read_frame(&mut controller).await.unwrap();
            std::future::pending::<()>().await;
        });

        let error = run_stream(
            proxy,
            config.as_ref(),
            Uuid::new_v4(),
            &registry,
            &SessionStore::new(100, Duration::from_secs(3600)),
            &mut requests_rx,
            &readiness_tx,
            lifecycle_tx,
        )
        .await
        .unwrap_err();
        assert!(matches!(
            error,
            AttemptError::Retry(reason)
                if reason == "controller ServerHello read timed out"
        ));
        server.abort();
    }

    #[tokio::test]
    async fn admission_rejects_immediately_while_unready() {
        let (requests, _requests_rx) = mpsc::channel(1);
        let (_readiness_tx, readiness) = watch::channel(false);
        let admission = ControlAdmission {
            requests,
            readiness,
            admission_epoch: Arc::new(AtomicU64::new(1)),
            admission_lease_verifier: test_config("127.0.0.1:1".parse().unwrap())
                .admission_lease_verifier
                .clone(),
            proxy_id: devserver_control_proto::ProxyId::parse("p1").unwrap(),
        };
        let (hello, validated, registration_id) = admission_inputs();
        let error = admission
            .admit_registration(&hello, &validated, registration_id)
            .await
            .unwrap_err();
        assert!(matches!(error, ServerError::ControlUnavailable));
    }

    #[test]
    fn admission_permit_is_fenced_by_readiness_and_epoch() {
        let (requests, _requests_rx) = mpsc::channel(1);
        let (readiness_tx, readiness) = watch::channel(true);
        let admission_epoch = Arc::new(AtomicU64::new(7));
        let admission = ControlAdmission {
            requests,
            readiness,
            admission_epoch: admission_epoch.clone(),
            admission_lease_verifier: test_config("127.0.0.1:1".parse().unwrap())
                .admission_lease_verifier
                .clone(),
            proxy_id: devserver_control_proto::ProxyId::parse("p1").unwrap(),
        };
        let permit = RegistrationPermit {
            request_id: Uuid::new_v4(),
            registration_id: Uuid::new_v4(),
            admission_epoch: 7,
        };

        assert!(admission.permit_is_current(permit));
        admission_epoch.fetch_add(1, Ordering::AcqRel);
        assert!(!admission.permit_is_current(permit));
        readiness_tx.send(false).unwrap();
        assert!(!admission.permit_is_current(RegistrationPermit {
            admission_epoch: 8,
            ..permit
        }));
    }

    // Fake controller: a minimal in-test peer for the control supervisor.
    // It speaks just enough of the control protocol over real h2/TCP for
    // supervise() to treat a session as established, and it exposes
    // per-session commands plus an online switch so tests can sever and
    // restore control connectivity on demand. A 5s Ping keeps the
    // proxy's 15s controller deadline satisfied while a session is up.
    enum FakeEvent {
        Session {
            boot_id: Uuid,
            cmd: mpsc::Sender<FakeCommand>,
        },
        Snapshot {
            base_generation: u64,
            rows: usize,
        },
        /// Every frame the proxy sends once its snapshot is accepted.
        Frame(ClientFrame),
    }

    enum FakeCommand {
        FleetReady,
        Drop,
    }

    struct FakeControl {
        addr: std::net::SocketAddr,
        online: Arc<AtomicBool>,
        events: mpsc::UnboundedReceiver<FakeEvent>,
        shutdown: watch::Sender<bool>,
        accept_task: tokio::task::JoinHandle<()>,
    }

    impl FakeControl {
        async fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let online = Arc::new(AtomicBool::new(true));
            let (events_tx, events) = mpsc::unbounded_channel();
            let (shutdown, shutdown_rx) = watch::channel(false);
            let accept_task = tokio::spawn(fake_accept_loop(
                listener,
                online.clone(),
                events_tx,
                shutdown_rx,
            ));
            Self {
                addr,
                online,
                events,
                shutdown,
                accept_task,
            }
        }

        fn set_online(&self, online: bool) {
            self.online.store(online, Ordering::Relaxed);
        }

        async fn next_session(&mut self) -> (Uuid, mpsc::Sender<FakeCommand>) {
            loop {
                if let FakeEvent::Session { boot_id, cmd } = self.next_event().await {
                    return (boot_id, cmd);
                }
            }
        }

        async fn next_snapshot(&mut self) -> (u64, usize) {
            loop {
                if let FakeEvent::Snapshot {
                    base_generation,
                    rows,
                } = self.next_event().await
                {
                    return (base_generation, rows);
                }
            }
        }

        /// The events recorded so far, without waiting for more.
        fn drain(&mut self) -> Vec<FakeEvent> {
            let mut drained = Vec::new();
            while let Ok(event) = self.events.try_recv() {
                drained.push(event);
            }
            drained
        }

        async fn next_event(&mut self) -> FakeEvent {
            tokio::time::timeout(Duration::from_secs(30), self.events.recv())
                .await
                .expect("fake controller event timed out")
                .expect("fake controller event channel closed")
        }

        async fn stop(self) {
            let _ = self.shutdown.send(true);
            self.accept_task.await.unwrap();
        }
    }

    async fn fake_accept_loop(
        listener: TcpListener,
        online: Arc<AtomicBool>,
        events: mpsc::UnboundedSender<FakeEvent>,
        mut shutdown: watch::Receiver<bool>,
    ) {
        let mut sessions = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                biased;
                changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow() {
                        break;
                    }
                }
                _ = sessions.join_next(), if !sessions.is_empty() => {}
                accepted = listener.accept() => {
                    match accepted {
                        Ok((stream, _)) => {
                            if !online.load(Ordering::Relaxed) {
                                // Simulated controller outage: the
                                // proxy's connect succeeds but the
                                // session dies before the h2 handshake.
                                drop(stream);
                                continue;
                            }
                            sessions.spawn(fake_connection(stream, events.clone(), shutdown.clone()));
                        }
                        Err(_) => break,
                    }
                }
            }
        }
        sessions.shutdown().await;
    }

    async fn fake_connection(
        stream: TcpStream,
        events: mpsc::UnboundedSender<FakeEvent>,
        mut shutdown: watch::Receiver<bool>,
    ) {
        let mut connection = match h2::server::handshake(stream).await {
            Ok(connection) => connection,
            Err(_) => return,
        };
        let Some(Ok((request, mut respond))) = connection.accept().await else {
            return;
        };
        let expected_authorization = format!("Bearer {TEST_PROXY_TOKEN}");
        let authorized = request.method() == Method::POST
            && request.uri().path() == CONNECT_PATH
            && request
                .headers()
                .get(header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                == Some(expected_authorization.as_str());
        if !authorized {
            let response = axum::http::Response::builder()
                .status(StatusCode::UNAUTHORIZED)
                .body(())
                .unwrap();
            let _ = respond.send_response(response, true);
            return;
        }
        let response = axum::http::Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, CONTENT_TYPE)
            .body(())
            .unwrap();
        let send = match respond.send_response(response, false) {
            Ok(send) => send,
            Err(_) => return,
        };
        let session = run_fake_session(H2Duplex::new(send, request.into_body()), events);
        tokio::pin!(session);
        // The h2 connection future must be polled for the session's
        // frames to flow; when the peer goes away accept() returns None.
        tokio::select! {
            _ = &mut session => {}
            _ = async { while connection.accept().await.is_some() {} } => {}
            _ = shutdown.changed() => {}
        }
    }

    async fn run_fake_session<S>(stream: S, events: mpsc::UnboundedSender<FakeEvent>)
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        let (mut reader, mut writer) = tokio::io::split(stream);
        let hello: ClientFrame = match read_frame(&mut reader).await {
            Ok(frame) => frame,
            Err(_) => return,
        };
        let ClientFrame::ClientHello { boot_id, .. } = hello else {
            return;
        };
        let server_hello = ServerFrame::ServerHello {
            protocol_version: PROTOCOL_VERSION,
            package_version: env!("CARGO_PKG_VERSION").into(),
            heartbeat_seconds: 5,
            dead_seconds: 15,
            grace_seconds: 30,
        };
        if write_frame(&mut writer, &server_hello).await.is_err() {
            return;
        }
        let (cmd, mut commands) = mpsc::channel(8);
        let _ = events.send(FakeEvent::Session { boot_id, cmd });
        let mut rows = 0usize;
        let base_generation = loop {
            match read_frame::<_, ClientFrame>(&mut reader).await {
                Ok(ClientFrame::SnapshotStart { .. }) => {}
                Ok(ClientFrame::SnapshotChunk { rows: chunk }) => rows += chunk.len(),
                Ok(ClientFrame::BrowserSessionSnapshotChunk { .. }) => {}
                Ok(ClientFrame::SnapshotEnd { base_generation }) => break base_generation,
                _ => return,
            }
        };
        let accepted = ServerFrame::SnapshotAccepted { base_generation };
        if write_frame(&mut writer, &accepted).await.is_err() {
            return;
        }
        let _ = events.send(FakeEvent::Snapshot {
            base_generation,
            rows,
        });
        // One framed reader for the rest of the session. Recreating
        // read_frame inside select! would cancel a partially consumed
        // frame whenever a command or the ping ticker wins the race.
        let (frames_tx, mut frames) = mpsc::channel(64);
        let reader_task = tokio::spawn(async move {
            loop {
                let frame = read_frame::<_, ClientFrame>(&mut reader).await;
                let terminal = frame.is_err();
                if frames_tx.send(frame).await.is_err() || terminal {
                    break;
                }
            }
        });
        let mut ping = tokio::time::interval(Duration::from_secs(5));
        let mut nonce = 0_u64;
        loop {
            tokio::select! {
                _ = ping.tick() => {
                    nonce += 1;
                    if write_frame(&mut writer, &ServerFrame::Ping { nonce }).await.is_err() {
                        break;
                    }
                }
                command = commands.recv() => {
                    match command {
                        Some(FakeCommand::FleetReady) => {
                            if write_frame(&mut writer, &ServerFrame::FleetReady).await.is_err() {
                                break;
                            }
                        }
                        Some(FakeCommand::Drop) | None => break,
                    }
                }
                frame = frames.recv() => {
                    if let Some(Ok(frame)) = &frame {
                        let _ = events.send(FakeEvent::Frame(frame.clone()));
                    }
                    match frame {
                        Some(Ok(ClientFrame::AdmissionRequest {
                            request_id,
                            registration_id,
                            ..
                        })) => {
                            let decision = ServerFrame::AdmissionDecision {
                                request_id,
                                registration_id,
                                decision: AdmissionDecision::Admit,
                            };
                            if write_frame(&mut writer, &decision).await.is_err() {
                                break;
                            }
                        }
                        Some(Ok(_)) => {}
                        Some(Err(_)) | None => break,
                    }
                }
            }
        }
        reader_task.abort();
        let _ = reader_task.await;
    }

    const TEST_ADMISSION_SIGNING_KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    /// A well-formed signing key whose verifying key is not in the ring
    /// `test_config` gives the proxy.
    const FOREIGN_ADMISSION_SIGNING_KEY: &str = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

    fn lease_binding(
        user_id: Uuid,
        user: &str,
        devserver_id: &str,
        registration_id: Uuid,
        proxy_id: &str,
    ) -> devserver_control_proto::AdmissionLeaseBinding {
        devserver_control_proto::AdmissionLeaseBinding {
            owner_user_id: user_id,
            user: user.into(),
            devserver_id: devserver_id.into(),
            registration_id,
            proxy_id: devserver_control_proto::ProxyId::parse(proxy_id).unwrap(),
        }
    }

    fn signed_lease(
        binding: devserver_control_proto::AdmissionLeaseBinding,
        signing_key: &str,
    ) -> AdmissionLease {
        AdmissionLeaseSigner::from_base64(signing_key)
            .unwrap()
            .sign(binding, 100, chrono::Utc::now(), 120)
            .unwrap()
    }

    /// Validation of `user_id`, `user` and `devserver_id` carrying a lease
    /// signed for `binding`, which need not be bound to them. One clock read
    /// dates both the lease and the expiry reported beside it, so the two
    /// agree to the second, as the controller requires of a published row.
    fn validated_carrying(
        user_id: Uuid,
        user: &str,
        devserver_id: &str,
        binding: devserver_control_proto::AdmissionLeaseBinding,
        signing_key: &str,
    ) -> Validated {
        let now = chrono::Utc::now();
        let lease = AdmissionLeaseSigner::from_base64(signing_key)
            .unwrap()
            .sign(binding, 100, now, 120)
            .unwrap();
        Validated {
            user_id,
            username: user.into(),
            devserver_id: devserver_id.into(),
            scopes: vec!["tunnel".into()],
            gateway_assertion_key: None,
            admission_lease: Some(lease.as_str().into()),
            admission_lease_expires_at: Some(now + chrono::Duration::seconds(120)),
        }
    }

    fn validated_with_lease(
        user_id: Uuid,
        user: &str,
        devserver_id: &str,
        registration_id: Uuid,
        signing_key: &str,
    ) -> Validated {
        let binding = lease_binding(user_id, user, devserver_id, registration_id, "p1");
        validated_carrying(user_id, user, devserver_id, binding, signing_key)
    }

    struct StubValidator;

    #[async_trait]
    impl Validator for StubValidator {
        async fn validate(&self, token: &str) -> Result<Validated, ServerError> {
            self.validate_registration(token, Uuid::new_v4()).await
        }

        async fn validate_registration(
            &self,
            token: &str,
            registration_id: Uuid,
        ) -> Result<Validated, ServerError> {
            match token {
                "good" => Ok(validated_with_lease(
                    Uuid::from_u128(1),
                    "alice",
                    "ds-1",
                    registration_id,
                    TEST_ADMISSION_SIGNING_KEY,
                )),
                // Identity signed this lease with a key the proxy's
                // verifying ring does not hold.
                "foreign" => Ok(validated_with_lease(
                    Uuid::from_u128(2),
                    "bob",
                    "ds-2",
                    registration_id,
                    FOREIGN_ADMISSION_SIGNING_KEY,
                )),
                // `member-N`: owner N, user `member-N`, devserver `ds-N`,
                // for tests that need several tunnels with good leases.
                _ => match token
                    .strip_prefix("member-")
                    .and_then(|member| member.parse::<u128>().ok())
                {
                    Some(member) => Ok(validated_with_lease(
                        Uuid::from_u128(member),
                        token,
                        &format!("ds-{member}"),
                        registration_id,
                        TEST_ADMISSION_SIGNING_KEY,
                    )),
                    None => Err(ServerError::InvalidToken),
                },
            }
        }
    }

    /// Dial the tunnel listener as a real client and keep the yamux
    /// connection driven in the background so the registration stays
    /// alive across paused-time advances. The returned handle aborts
    /// the pump (and the per-dial listener, when owned) on drop-free
    /// cleanup via `stop`.
    struct TunnelClient {
        pump: tokio::task::JoinHandle<()>,
        listener: Option<tokio::task::JoinHandle<()>>,
    }

    impl TunnelClient {
        async fn stop(self) {
            self.pump.abort();
            if let Some(listener) = self.listener {
                listener.abort();
            }
        }
    }

    async fn dial_tunnel(port: u16, router: axum::Router) -> TunnelClient {
        dial_tunnel_as(port, router, "good").await
    }

    async fn dial_tunnel_as(port: u16, router: axum::Router, token: &str) -> TunnelClient {
        let config = chan_tunnel_client::ClientConfig {
            tunnel_url: format!("http://127.0.0.1:{port}/v1/tunnel")
                .parse()
                .unwrap(),
            token: token.into(),
            workspace: "devsrv".into(),
            name: None,
            client_version: "chan/test".into(),
            initial_backoff: Duration::from_millis(50),
            max_backoff: Duration::from_secs(1),
            dial_timeout: Duration::from_secs(5),
            events: None,
            proxy: None,
            max_concurrent_substreams: chan_tunnel_client::DEFAULT_MAX_CONCURRENT_SUBSTREAMS,
        };
        let (_registration, connection) = chan_tunnel_client::dial(&config)
            .await
            .expect("tunnel dial");
        let pump = tokio::spawn(async move {
            let _ = chan_tunnel_client::serve_substreams(connection, router).await;
        });
        TunnelClient {
            pump,
            listener: None,
        }
    }

    async fn spawn_tunnel_listener(
        registry: &Registry,
        admission: Arc<dyn RegistrationAdmission>,
        capture_users: bool,
    ) -> (u16, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let _ = capture_users;
        let validator: Arc<dyn Validator> = Arc::new(StubValidator);
        let tunnels = registry.tunnels();
        let task = tokio::spawn(async move {
            let _ =
                serve_tunnel_listener_with_admission(listener, validator, admission, tunnels, 0)
                    .await;
        });
        (port, task)
    }

    struct ProxyHarness {
        registry: Registry,
        sessions: SessionStore,
        control: FakeControl,
        admission: Arc<dyn RegistrationAdmission>,
        readiness: watch::Receiver<bool>,
        tunnel_port: u16,
        shutdown: watch::Sender<bool>,
        supervisor: tokio::task::JoinHandle<anyhow::Result<()>>,
        tunnel_listener: tokio::task::JoinHandle<()>,
    }

    async fn spawn_proxy() -> ProxyHarness {
        let control = FakeControl::start().await;
        let registry = Registry::new();
        let sessions = SessionStore::new(100, Duration::from_secs(3600));
        let (shutdown, shutdown_rx) = watch::channel(false);
        let ControlRuntime {
            admission,
            readiness,
            task,
        } = spawn_control_supervisor(
            test_config(control.addr),
            registry.clone(),
            sessions.clone(),
            shutdown_rx,
        );
        let (tunnel_port, tunnel_listener) = spawn_tunnel_listener(
            &registry,
            Arc::new(chan_tunnel_server::AllowAllAdmission),
            true,
        )
        .await;
        ProxyHarness {
            registry,
            sessions,
            control,
            admission,
            readiness,
            tunnel_port,
            shutdown,
            supervisor: task,
            tunnel_listener,
        }
    }

    impl ProxyHarness {
        async fn wait_readiness(&self, want: bool) {
            let mut readiness = self.readiness.clone();
            tokio::time::timeout(Duration::from_secs(30), async move {
                while *readiness.borrow_and_update() != want {
                    readiness.changed().await.unwrap();
                }
            })
            .await
            .expect("readiness transition timed out");
        }

        /// Drive the first control session to FleetReady and return its
        /// command channel.
        async fn become_ready(&mut self) -> mpsc::Sender<FakeCommand> {
            let (_, session) = self.control.next_session().await;
            self.control.next_snapshot().await;
            session.send(FakeCommand::FleetReady).await.unwrap();
            self.wait_readiness(true).await;
            session
        }

        async fn wait_registration(&self) {
            tokio::time::timeout(Duration::from_secs(30), async {
                while self.registry.get("alice", "ds-1").is_none() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("registration never landed");
        }

        async fn stop(self) {
            let _ = self.shutdown.send(true);
            self.supervisor.await.unwrap().unwrap();
            self.tunnel_listener.abort();
            self.control.stop().await;
        }
    }

    /// Advance simulated time in small steps with real-time yields in
    /// between. One long sleep under paused time lets the clock jump
    /// past the fake controller's keepalive ticks without the socket
    /// round trips those ticks need, so the proxy would see a silent
    /// controller and tear the session down.
    async fn advance_paced(total: Duration) {
        let mut remaining = total;
        while remaining > Duration::ZERO {
            let step = remaining.min(Duration::from_secs(1));
            tokio::time::sleep(step).await;
            settle().await;
            remaining -= step;
        }
    }

    /// A handshake, and a validation whose lease is bound to the returned
    /// registration id on this proxy, so admission refuses it only for the
    /// reason a test names.
    fn admission_inputs() -> (Hello, Validated, Uuid) {
        let registration_id = Uuid::new_v4();
        (
            Hello {
                protocol: ProtocolVersion::V1,
                client_version: "test".into(),
                workspace: "devserver".into(),
                name: None,
            },
            validated_with_lease(
                Uuid::new_v4(),
                "alice",
                "ds-9",
                registration_id,
                TEST_ADMISSION_SIGNING_KEY,
            ),
            registration_id,
        )
    }

    /// Round-trip one h1 request through the registry's yamux handle:
    /// the same data path the public listener uses for tenant traffic.
    async fn http_get(registry: &Registry, path: &str) -> String {
        let entry = registry.get("alice", "ds-1").expect("registered tunnel");
        let stream = entry.handle.open().await.expect("substream open");
        let io = hyper_util::rt::TokioIo::new(stream.compat());
        let (mut sender, connection) = hyper::client::conn::http1::handshake(io)
            .await
            .expect("h1 handshake");
        let driver = tokio::spawn(async move {
            let _ = connection.await;
        });
        let request = Request::get(path)
            .header(header::HOST, "alice.p1.proxy.chan.app")
            .body(http_body_util::Empty::<bytes::Bytes>::new())
            .unwrap();
        let response = sender.send_request(request).await.expect("h1 response");
        let body = response.into_body().collect().await.unwrap().to_bytes();
        driver.abort();
        String::from_utf8(body.to_vec()).unwrap()
    }

    #[tokio::test(start_paused = true)]
    async fn reconnect_backoff_doubles_from_half_a_second_to_a_ten_second_cap() {
        // The sink accepts and holds every connection without speaking
        // h2, so each supervise attempt dies at the 10s handshake
        // timeout and the supervisor keeps cycling through its backoff
        // schedule. The observer reports each computed delay; jitter()
        // scales each base by 0.8..=1.2, so every reported delay must
        // land inside the band of its schedule step.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let sink = tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((stream, _)) = listener.accept().await {
                held.push(stream);
            }
        });
        let registry = Registry::new();
        let (shutdown, shutdown_rx) = watch::channel(false);
        let (delays_tx, mut delays) = mpsc::unbounded_channel::<Duration>();
        let runtime = spawn_supervisor(
            test_config(addr),
            registry,
            SessionStore::new(100, Duration::from_secs(3600)),
            shutdown_rx,
            BackoffObserver::recording(delays_tx),
        );

        let bases = [
            Duration::from_millis(500),
            Duration::from_secs(1),
            Duration::from_secs(2),
            Duration::from_secs(4),
            Duration::from_secs(8),
            Duration::from_secs(10),
            Duration::from_secs(10),
        ];
        for (index, base) in bases.iter().enumerate() {
            let delay = tokio::time::timeout(Duration::from_secs(120), delays.recv())
                .await
                .expect("reconnect attempt never happened")
                .unwrap();
            assert!(
                delay >= base.mul_f64(0.8),
                "backoff {index} {delay:?} below the jitter floor for {base:?}"
            );
            assert!(
                delay <= base.mul_f64(1.2),
                "backoff {index} {delay:?} above the jitter ceiling for {base:?}"
            );
        }
        shutdown.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(30), runtime.task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        sink.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn reconnect_inside_grace_cancels_the_eviction_timer() {
        let mut proxy = spawn_proxy().await;
        let (first_boot, session) = proxy.control.next_session().await;
        proxy.control.next_snapshot().await;
        session.send(FakeCommand::FleetReady).await.unwrap();
        proxy.wait_readiness(true).await;
        let client = dial_tunnel(proxy.tunnel_port, axum::Router::new()).await;
        proxy.wait_registration().await;
        assert_eq!(proxy.registry.cached_user_count(), 1);

        session.send(FakeCommand::Drop).await.unwrap();
        proxy.wait_readiness(false).await;
        advance_paced(Duration::from_secs(20)).await;
        assert!(proxy.registry.get("alice", "ds-1").is_some());

        // The boot id survives the reconnect; the controller matches the
        // replacement session to the same proxy incarnation.
        let (boot_id, session) = proxy.control.next_session().await;
        assert_eq!(boot_id, first_boot);
        let (_, rows) = proxy.control.next_snapshot().await;
        assert_eq!(rows, 1);
        // SnapshotAccepted cancels the eviction timer but does not make
        // the proxy ready or open admission: only FleetReady does.
        assert!(!*proxy.readiness.borrow());
        let (hello, validated, registration_id) = admission_inputs();
        let error = proxy
            .admission
            .admit_registration(&hello, &validated, registration_id)
            .await
            .unwrap_err();
        assert!(matches!(error, ServerError::ControlUnavailable));

        session.send(FakeCommand::FleetReady).await.unwrap();
        proxy.wait_readiness(true).await;
        // Push well past the original 30s deadline: the reconnect must
        // have disarmed the eviction, not merely delayed it.
        advance_paced(Duration::from_secs(60)).await;
        assert!(proxy.registry.get("alice", "ds-1").is_some());
        client.stop().await;
        proxy.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn snapshot_convergence_has_a_distinct_hard_deadline_and_clears_sessions() {
        let mut proxy = spawn_proxy().await;
        let first = proxy.become_ready().await;
        let client = dial_tunnel(proxy.tunnel_port, axum::Router::new()).await;
        proxy.wait_registration().await;
        proxy
            .sessions
            .issue(
                crate::session_store::SessionPrincipal {
                    subject_user_id: Uuid::new_v4(),
                    owner_user_id: Uuid::new_v4(),
                    devserver_id: "ds-1".into(),
                    audience: "https://alice--0123456789ab.p1.proxy.chan.app".into(),
                },
                chan_tunnel_proto::gateway_assertion::ClientType::Browser,
            )
            .unwrap();
        assert_eq!(proxy.sessions.len(), 1);

        first.send(FakeCommand::Drop).await.unwrap();
        proxy.wait_readiness(false).await;
        advance_paced(Duration::from_secs(20)).await;
        let (_, replacement) = proxy.control.next_session().await;
        let (_, rows) = proxy.control.next_snapshot().await;
        assert_eq!(rows, 1);

        // The first paced step lets the supervisor consume SnapshotAccepted.
        // Fifteen seconds then carries us beyond the old disconnect grace,
        // proving that acceptance armed a distinct convergence deadline.
        advance_paced(Duration::from_secs(15)).await;
        assert!(proxy.registry.get("alice", "ds-1").is_some());
        assert_eq!(proxy.sessions.len(), 1);
        advance_paced(CONVERGENCE_GRACE_PERIOD - Duration::from_secs(10)).await;
        settle().await;
        assert!(proxy.registry.get("alice", "ds-1").is_none());
        assert!(proxy.sessions.is_empty());
        assert!(!*proxy.readiness.borrow());

        drop(replacement);
        let _ = tokio::time::timeout(Duration::from_secs(30), client.pump).await;
        proxy.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn normal_controller_convergence_finishes_before_the_hard_deadline() {
        let mut proxy = spawn_proxy().await;
        let first = proxy.become_ready().await;
        let client = dial_tunnel(proxy.tunnel_port, axum::Router::new()).await;
        proxy.wait_registration().await;

        first.send(FakeCommand::Drop).await.unwrap();
        proxy.wait_readiness(false).await;
        advance_paced(Duration::from_secs(10)).await;
        let (_, replacement) = proxy.control.next_session().await;
        proxy.control.next_snapshot().await;
        advance_paced(Duration::from_secs(30)).await;
        assert!(proxy.registry.get("alice", "ds-1").is_some());
        replacement.send(FakeCommand::FleetReady).await.unwrap();
        proxy.wait_readiness(true).await;
        advance_paced(CONVERGENCE_GRACE_PERIOD).await;
        assert!(proxy.registry.get("alice", "ds-1").is_some());

        client.stop().await;
        proxy.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn grace_expiry_evicts_everything_until_a_fresh_fleet_ready() {
        let mut proxy = spawn_proxy().await;
        let session = proxy.become_ready().await;
        let client = dial_tunnel(proxy.tunnel_port, axum::Router::new()).await;
        proxy.wait_registration().await;
        assert_eq!(proxy.registry.cached_user_count(), 1);

        // Controller hard-down: refuse reconnects so the grace deadline
        // runs out with no session to cancel it.
        proxy.control.set_online(false);
        session.send(FakeCommand::Drop).await.unwrap();
        proxy.wait_readiness(false).await;
        advance_paced(Duration::from_secs(35)).await;

        assert!(proxy.registry.tunnels().list_all().is_empty());
        assert_eq!(proxy.registry.cached_user_count(), 0);
        // The eviction closed the tunnel's yamux connection underneath
        // the client.
        tokio::time::timeout(Duration::from_secs(30), client.pump)
            .await
            .expect("client connection outlived the eviction")
            .unwrap();

        // Recovery: SnapshotAccepted alone must not reopen admission;
        // only FleetReady on the fresh session does.
        proxy.control.set_online(true);
        let (_, session) = proxy.control.next_session().await;
        let (_, rows) = proxy.control.next_snapshot().await;
        assert_eq!(rows, 0);
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert!(!*proxy.readiness.borrow());
        session.send(FakeCommand::FleetReady).await.unwrap();
        proxy.wait_readiness(true).await;
        proxy.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn tunnel_traffic_survives_a_control_disconnect_inside_grace() {
        let mut proxy = spawn_proxy().await;
        let session = proxy.become_ready().await;
        let router = axum::Router::new().route("/ping", axum::routing::get(|| async { "pong" }));
        let client = dial_tunnel(proxy.tunnel_port, router).await;
        proxy.wait_registration().await;
        assert_eq!(http_get(&proxy.registry, "/ping").await, "pong");

        proxy.control.set_online(false);
        session.send(FakeCommand::Drop).await.unwrap();
        proxy.wait_readiness(false).await;
        advance_paced(Duration::from_secs(15)).await;
        assert_eq!(http_get(&proxy.registry, "/ping").await, "pong");
        client.stop().await;
        proxy.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn control_disconnect_refuses_new_admission_and_stales_outstanding_permits() {
        let mut proxy = spawn_proxy().await;
        let session = proxy.become_ready().await;
        let (hello, validated, registration_id) = admission_inputs();
        // The fake controller auto-admits while the session is ready.
        let permit = proxy
            .admission
            .admit_registration(&hello, &validated, registration_id)
            .await
            .unwrap();
        assert!(proxy.admission.permit_is_current(permit));

        proxy.control.set_online(false);
        session.send(FakeCommand::Drop).await.unwrap();
        proxy.wait_readiness(false).await;

        // The epoch bump on connection loss fences the pre-disconnect
        // permit, and the readiness fast-path refuses fresh admissions
        // without queuing a request for a dead session.
        assert!(!proxy.admission.permit_is_current(permit));
        let error = proxy
            .admission
            .admit_registration(&hello, &validated, registration_id)
            .await
            .unwrap_err();
        assert!(matches!(error, ServerError::ControlUnavailable));
        proxy.stop().await;
    }

    struct FixedPermitAdmission(Uuid);

    #[async_trait]
    impl RegistrationAdmission for FixedPermitAdmission {
        async fn admit(
            &self,
            _hello: &Hello,
            _validated: &Validated,
        ) -> Result<RegistrationPermit, ServerError> {
            Ok(RegistrationPermit {
                request_id: Uuid::new_v4(),
                registration_id: self.0,
                admission_epoch: 0,
            })
        }

        async fn admit_registration(
            &self,
            hello: &Hello,
            validated: &Validated,
            _registration_id: Uuid,
        ) -> Result<RegistrationPermit, ServerError> {
            self.admit(hello, validated).await
        }
    }

    /// Register one tunnel with a caller-chosen registration UUID by
    /// dialing a throwaway listener through the real handshake path.
    async fn dial_with_registration_id(registry: &Registry, registration_id: Uuid) -> TunnelClient {
        let (port, listener) = spawn_tunnel_listener(
            registry,
            Arc::new(FixedPermitAdmission(registration_id)),
            false,
        )
        .await;
        let mut client = dial_tunnel(port, axum::Router::new()).await;
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                if registry
                    .tunnels()
                    .get("alice", "ds-1")
                    .is_some_and(|handle| handle.registration_id == registration_id)
                {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("registration never landed");
        client.listener = Some(listener);
        client
    }

    async fn read_command_result<S>(stream: &mut S, command_id: Uuid) -> (Vec<Uuid>, Vec<Uuid>)
    where
        S: tokio::io::AsyncRead + Unpin,
    {
        loop {
            match read_frame::<_, ClientFrame>(stream).await.unwrap() {
                ClientFrame::CommandResult {
                    command_id: id,
                    killed,
                    missing,
                    ..
                } if id == command_id => return (killed, missing),
                _ => {}
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_delayed_kill_targets_only_its_own_registration_uuid() {
        // Two registrations for the same (user, devserver) key: the
        // second replaces the first, as a client reconnect would. A kill
        // command addressed at the first registration's UUID arrives
        // afterwards (issued by the controller against its pre-reconnect
        // view) and must leave the replacement untouched.
        let registry = Registry::new();
        let u1 = Uuid::new_v4();
        let u2 = Uuid::new_v4();
        let first = dial_with_registration_id(&registry, u1).await;
        let second = dial_with_registration_id(&registry, u2).await;
        assert_eq!(
            registry
                .tunnels()
                .get("alice", "ds-1")
                .unwrap()
                .registration_id,
            u2
        );

        let config = test_config("127.0.0.1:1".parse().unwrap());
        let (_requests_tx, mut requests_rx) = mpsc::channel(1);
        let (readiness_tx, _readiness) = watch::channel(false);
        let (lifecycle_tx, _lifecycle_rx) = mpsc::channel(1);
        let (proxy_stream, mut controller) = duplex(64 * 1024);
        let client = tokio::spawn({
            let registry = registry.clone();
            async move {
                run_stream(
                    proxy_stream,
                    config.as_ref(),
                    Uuid::new_v4(),
                    &registry,
                    &SessionStore::new(100, Duration::from_secs(3600)),
                    &mut requests_rx,
                    &readiness_tx,
                    lifecycle_tx,
                )
                .await
            }
        });

        let _: ClientFrame = read_frame(&mut controller).await.unwrap();
        write_frame(
            &mut controller,
            &ServerFrame::ServerHello {
                protocol_version: PROTOCOL_VERSION,
                package_version: env!("CARGO_PKG_VERSION").into(),
                heartbeat_seconds: 5,
                dead_seconds: 15,
                grace_seconds: 30,
            },
        )
        .await
        .unwrap();
        let mut snapshot_rows = Vec::new();
        let base_generation = loop {
            match read_frame::<_, ClientFrame>(&mut controller).await.unwrap() {
                ClientFrame::SnapshotStart { .. } => {}
                ClientFrame::SnapshotChunk { rows } => snapshot_rows.extend(rows),
                ClientFrame::SnapshotEnd { base_generation } => break base_generation,
                other => panic!("unexpected frame during snapshot: {other:?}"),
            }
        };
        assert_eq!(snapshot_rows.len(), 1);
        assert_eq!(snapshot_rows[0].registration_id, u2);
        write_frame(
            &mut controller,
            &ServerFrame::SnapshotAccepted { base_generation },
        )
        .await
        .unwrap();

        let stale_kill = Uuid::new_v4();
        write_frame(
            &mut controller,
            &ServerFrame::KillRegistrations {
                command_id: stale_kill,
                registration_ids: vec![u1],
            },
        )
        .await
        .unwrap();
        let (killed, missing) = read_command_result(&mut controller, stale_kill).await;
        assert!(killed.is_empty());
        assert_eq!(missing, vec![u1]);
        assert_eq!(
            registry
                .tunnels()
                .get("alice", "ds-1")
                .unwrap()
                .registration_id,
            u2
        );

        let live_kill = Uuid::new_v4();
        write_frame(
            &mut controller,
            &ServerFrame::KillRegistrations {
                command_id: live_kill,
                registration_ids: vec![u2],
            },
        )
        .await
        .unwrap();
        let (killed, missing) = read_command_result(&mut controller, live_kill).await;
        assert_eq!(killed, vec![u2]);
        assert!(missing.is_empty());
        assert!(registry.tunnels().get("alice", "ds-1").is_none());

        drop(controller);
        let _ = client.await;
        first.stop().await;
        second.stop().await;
    }

    impl FakeControl {
        /// The next frame the proxy sends that is not a heartbeat reply.
        async fn next_delta(&mut self) -> ClientFrame {
            loop {
                match self.next_event().await {
                    FakeEvent::Frame(ClientFrame::Pong { .. }) => {}
                    FakeEvent::Frame(frame) => return frame,
                    _ => {}
                }
            }
        }
    }

    /// The registration id of the next tunnel `user` registers, read from
    /// the registry's own events: the proxy may evict it before a lookup
    /// by key could see it.
    async fn next_registration_of(
        events: &mut tokio::sync::broadcast::Receiver<RegistryEvent>,
        user: &str,
    ) -> Uuid {
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                if let RegistryEvent::TunnelUp { row, .. } = events.recv().await.unwrap() {
                    if row.user.as_ref() == user {
                        return row.registration_id;
                    }
                }
            }
        })
        .await
        .expect("the tunnel never registered")
    }

    /// Every recorded frame that names `registration_id`.
    fn frames_naming(events: &[FakeEvent], registration_id: Uuid) -> Vec<String> {
        events
            .iter()
            .filter_map(|event| match event {
                FakeEvent::Frame(frame @ ClientFrame::TunnelUp { row, .. })
                    if row.registration_id == registration_id =>
                {
                    Some(format!("{frame:?}"))
                }
                FakeEvent::Frame(
                    frame @ (ClientFrame::TunnelDown {
                        registration_id: id,
                        ..
                    }
                    | ClientFrame::LeaseRefresh {
                        registration_id: id,
                        ..
                    }
                    | ClientFrame::AdmissionRequest {
                        registration_id: id,
                        ..
                    }),
                ) if *id == registration_id => Some(format!("{frame:?}")),
                _ => None,
            })
            .collect()
    }

    fn issue_browser_session(sessions: &SessionStore) {
        sessions
            .issue(
                crate::session_store::SessionPrincipal {
                    subject_user_id: Uuid::new_v4(),
                    owner_user_id: Uuid::from_u128(1),
                    devserver_id: "ds-1".into(),
                    audience: "https://alice--0123456789ab.p1.proxy.chan.app".into(),
                },
                chan_tunnel_proto::gateway_assertion::ClientType::Browser,
            )
            .unwrap();
    }

    /// One registration whose admission lease this proxy cannot verify
    /// (identity signed it under a key outside the proxy's ring) must cost
    /// that registration and nothing else: the control stream stays up,
    /// every other tunnel stays registered and published, and the
    /// generation the controller checks has no gap.
    #[tokio::test(start_paused = true)]
    async fn a_tunnel_whose_lease_this_proxy_cannot_verify_is_evicted_alone() {
        let mut proxy = spawn_proxy().await;
        let _session = proxy.become_ready().await;
        let mut readiness = proxy.readiness.clone();
        readiness.borrow_and_update();
        let (_, _, mut registry_events) = proxy.registry.tunnels().snapshot_and_subscribe();

        let good = dial_tunnel(proxy.tunnel_port, axum::Router::new()).await;
        let good_id = next_registration_of(&mut registry_events, "alice").await;
        let published = proxy.control.next_delta().await;
        assert!(
            matches!(&published, ClientFrame::TunnelUp { generation: 1, row } if row.registration_id == good_id),
            "{published:?}"
        );

        // The harness's tunnel listener admits locally, so the tunnel
        // registers and its TunnelUp reaches the control stream.
        let bad = dial_tunnel_as(proxy.tunnel_port, axum::Router::new(), "foreign").await;
        let bad_id = next_registration_of(&mut registry_events, "bob").await;
        drop(registry_events);
        tokio::time::timeout(Duration::from_secs(30), async {
            while proxy.registry.tunnels().get("bob", "ds-2").is_some() && *readiness.borrow() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the registration was neither evicted nor did the control stream end");
        // Past the reconnect grace, a control stream that kept failing would
        // have evicted every tunnel on the node.
        advance_paced(GRACE_PERIOD + Duration::from_secs(5)).await;

        let events = proxy.control.drain();
        let sessions_opened = events
            .iter()
            .filter(|event| matches!(event, FakeEvent::Session { .. }))
            .count();
        let naming_bad = frames_naming(&events, bad_id);
        let stream_stayed_up = !readiness.has_changed().unwrap();
        let good_registered = proxy.registry.tunnels().get("alice", "ds-1").is_some();
        let bad_registered = proxy.registry.tunnels().get("bob", "ds-2").is_some();
        assert!(
            stream_stayed_up
                && sessions_opened == 0
                && good_registered
                && !bad_registered
                && naming_bad.is_empty(),
            "control stream stayed up: {stream_stayed_up}; control sessions opened since: \
             {sessions_opened}; good tunnel registered: {good_registered}; unverifiable \
             tunnel registered: {bad_registered}; frames naming the unverifiable \
             registration: {naming_bad:?}"
        );

        // Neither the TunnelUp left out nor the TunnelDown its eviction
        // raised consumed a generation: the next delta extends the good
        // tunnel's by exactly one.
        issue_browser_session(&proxy.sessions);
        let next = proxy.control.next_delta().await;
        assert!(
            matches!(next, ClientFrame::BrowserSessionUp { generation: 2, .. }),
            "{next:?}"
        );
        bad.stop().await;
        good.stop().await;
        proxy.stop().await;
    }

    /// The same registration met in the snapshot a control stream
    /// publishes when it connects: the snapshot leaves that row out and
    /// carries only the rows it counts, the registration is evicted, and
    /// the TunnelDown the eviction raises never reaches the controller,
    /// which has no such row and would read it as a reason to resync.
    /// The controller side is driven by hand over an in-memory stream, as
    /// in `a_delayed_kill_targets_only_its_own_registration_uuid`, so
    /// every frame the proxy sends is read in order. Real time: nothing
    /// here waits on a long timer, and under paused time each dial lets
    /// the clock run past the tunnels' 120-second lease expiry.
    #[tokio::test]
    async fn a_snapshot_row_this_proxy_cannot_verify_is_left_out_and_evicted() {
        // Both tunnels register before any control stream exists, so the
        // first thing to look at either is the stream's snapshot.
        let registry = Registry::new();
        let (port, listener) = spawn_tunnel_listener(
            &registry,
            Arc::new(chan_tunnel_server::AllowAllAdmission),
            false,
        )
        .await;
        let (_, _, mut registry_events) = registry.tunnels().snapshot_and_subscribe();
        let good = dial_tunnel(port, axum::Router::new()).await;
        let good_id = next_registration_of(&mut registry_events, "alice").await;
        let bad = dial_tunnel_as(port, axum::Router::new(), "foreign").await;
        let bad_id = next_registration_of(&mut registry_events, "bob").await;
        drop(registry_events);
        assert!(registry.tunnels().get("alice", "ds-1").is_some());
        assert!(registry.tunnels().get("bob", "ds-2").is_some());

        let config = test_config("127.0.0.1:1".parse().unwrap());
        let sessions = SessionStore::new(100, Duration::from_secs(3600));
        let (_requests_tx, mut requests_rx) = mpsc::channel(1);
        let (readiness_tx, mut readiness) = watch::channel(false);
        let (lifecycle_tx, _lifecycle_rx) = mpsc::channel(8);
        let (proxy_stream, mut controller) = duplex(64 * 1024);
        let stream = tokio::spawn({
            let registry = registry.clone();
            let sessions = sessions.clone();
            async move {
                run_stream(
                    proxy_stream,
                    config.as_ref(),
                    Uuid::new_v4(),
                    &registry,
                    &sessions,
                    &mut requests_rx,
                    &readiness_tx,
                    lifecycle_tx,
                )
                .await
            }
        });

        let _: ClientFrame = read_frame(&mut controller).await.unwrap();
        write_frame(
            &mut controller,
            &ServerFrame::ServerHello {
                protocol_version: PROTOCOL_VERSION,
                package_version: env!("CARGO_PKG_VERSION").into(),
                heartbeat_seconds: 5,
                dead_seconds: 15,
                grace_seconds: 30,
            },
        )
        .await
        .unwrap();
        let mut snapshot_rows = Vec::new();
        let base_generation = loop {
            match read_frame::<_, ClientFrame>(&mut controller).await {
                Ok(ClientFrame::SnapshotStart { .. }) => {}
                Ok(ClientFrame::SnapshotChunk { rows }) => {
                    snapshot_rows.extend(rows.iter().map(|row| row.registration_id));
                }
                Ok(ClientFrame::SnapshotEnd { base_generation }) => break base_generation,
                Ok(other) => panic!("unexpected frame during the snapshot: {other:?}"),
                Err(error) => panic!(
                    "the control stream ended before its snapshot did ({error}): {:?}; \
                     rows sent before it ended: {snapshot_rows:?} (good {good_id}, \
                     unverifiable {bad_id}); unverifiable tunnel registered: {}",
                    stream.await.unwrap(),
                    registry.tunnels().get("bob", "ds-2").is_some(),
                ),
            }
        };
        assert_eq!(snapshot_rows, vec![good_id]);
        assert!(registry.tunnels().get("alice", "ds-1").is_some());
        assert!(registry.tunnels().get("bob", "ds-2").is_none());

        write_frame(
            &mut controller,
            &ServerFrame::SnapshotAccepted { base_generation },
        )
        .await
        .unwrap();
        write_frame(&mut controller, &ServerFrame::FleetReady)
            .await
            .unwrap();
        readiness.wait_for(|ready| *ready).await.unwrap();

        // The next frame after the snapshot is the next delta, at the next
        // generation: the eviction's TunnelDown was never sent and consumed
        // no generation.
        issue_browser_session(&sessions);
        let next = read_frame::<_, ClientFrame>(&mut controller).await.unwrap();
        assert!(
            matches!(next, ClientFrame::BrowserSessionUp { generation, .. } if generation == base_generation + 1),
            "{next:?}"
        );

        drop(controller);
        let _ = stream.await;
        bad.stop().await;
        good.stop().await;
        listener.abort();
    }

    /// Admission is where a lease this proxy cannot verify is cheapest to
    /// stop: refused there, it never becomes a registered tunnel whose row
    /// the control stream cannot publish.
    #[tokio::test(start_paused = true)]
    async fn admission_refuses_a_lease_this_proxy_cannot_verify() {
        let mut proxy = spawn_proxy().await;
        let _session = proxy.become_ready().await;
        let (hello, validated, admitted_id) = admission_inputs();

        // The control case: a lease under the proxy's ring goes to the
        // controller, which admits it.
        let admitted = proxy
            .admission
            .admit_registration(&hello, &validated, admitted_id)
            .await;
        let refused_id = Uuid::new_v4();
        let foreign = validated_with_lease(
            validated.user_id,
            "alice",
            "ds-9",
            refused_id,
            FOREIGN_ADMISSION_SIGNING_KEY,
        );
        let refused = proxy
            .admission
            .admit_registration(&hello, &foreign, refused_id)
            .await;
        settle().await;

        let events = proxy.control.drain();
        assert!(
            admitted.is_ok() && !frames_naming(&events, admitted_id).is_empty(),
            "the control case was not admitted through the controller: {admitted:?}"
        );
        let requests_for_refused = frames_naming(&events, refused_id);
        assert!(
            matches!(refused, Err(ServerError::ControlUnavailable))
                && requests_for_refused.is_empty(),
            "a lease this proxy cannot verify: {refused:?}; sent to the controller: \
             {requests_for_refused:?}"
        );
        proxy.stop().await;
    }

    /// A lease is authority for one registration on one proxy. One that
    /// verifies but names another registration, proxy, owner or devserver
    /// is refused here, before the controller would refuse it.
    #[tokio::test(start_paused = true)]
    async fn admission_refuses_a_lease_bound_to_another_registration() {
        let mut proxy = spawn_proxy().await;
        let _session = proxy.become_ready().await;
        let (hello, _, _) = admission_inputs();
        let owner = Uuid::new_v4();
        // Every validation here is for alice's ds-9; only the lease varies.
        let carrying = |binding| {
            validated_carrying(owner, "alice", "ds-9", binding, TEST_ADMISSION_SIGNING_KEY)
        };

        // The control case: bound to exactly this registration.
        let admitted_id = Uuid::new_v4();
        let admitted = proxy
            .admission
            .admit_registration(
                &hello,
                &carrying(lease_binding(owner, "alice", "ds-9", admitted_id, "p1")),
                admitted_id,
            )
            .await;

        let [registration, proxy_case, owner_case, devserver_case] =
            std::array::from_fn(|_| Uuid::new_v4());
        let cases = [
            (
                "another registration",
                registration,
                lease_binding(owner, "alice", "ds-9", Uuid::new_v4(), "p1"),
            ),
            (
                "another proxy",
                proxy_case,
                lease_binding(owner, "alice", "ds-9", proxy_case, "p2"),
            ),
            (
                "another owner",
                owner_case,
                lease_binding(Uuid::new_v4(), "alice", "ds-9", owner_case, "p1"),
            ),
            (
                "another devserver",
                devserver_case,
                lease_binding(owner, "alice", "ds-other", devserver_case, "p1"),
            ),
        ];
        let mut refusals = Vec::new();
        for (step, registration_id, binding) in cases {
            let result = proxy
                .admission
                .admit_registration(&hello, &carrying(binding), registration_id)
                .await;
            refusals.push((step, registration_id, result));
        }
        settle().await;

        let events = proxy.control.drain();
        assert!(
            admitted.is_ok() && !frames_naming(&events, admitted_id).is_empty(),
            "the control case was not admitted through the controller: {admitted:?}"
        );
        let wrong: Vec<_> = refusals
            .iter()
            .filter_map(|(step, registration_id, result)| {
                let sent = frames_naming(&events, *registration_id);
                (!matches!(result, Err(ServerError::ControlUnavailable)) || !sent.is_empty())
                    .then(|| format!("{step}: {result:?}, sent to the controller: {sent:?}"))
            })
            .collect();
        assert!(
            wrong.is_empty(),
            "leases bound to something else were not refused locally: {wrong:#?}"
        );
        proxy.stop().await;
    }

    /// A refreshed lease this proxy cannot verify, or one bound to another
    /// registration, proxy or owner, means that registration's authority
    /// can no longer be renewed here. It must cost that registration and
    /// nothing else: the refresh is not forwarded (the controller would
    /// refuse it), the registration is evicted, its TunnelDown goes out at
    /// the next generation because the registration was published, and
    /// the stream and every other tunnel stay up. Driven by hand in real
    /// time, as `a_snapshot_row_this_proxy_cannot_verify_is_left_out_and_evicted`
    /// is, so every frame is read in order and no dial outruns a lease.
    #[tokio::test]
    async fn a_lease_refresh_this_proxy_cannot_verify_evicts_only_that_registration() {
        const MEMBERS: std::ops::RangeInclusive<u128> = 3..=8;
        let registry = Registry::new();
        let (port, listener) = spawn_tunnel_listener(
            &registry,
            Arc::new(chan_tunnel_server::AllowAllAdmission),
            false,
        )
        .await;
        let (_, _, mut registry_events) = registry.tunnels().snapshot_and_subscribe();
        let mut clients = Vec::new();
        let mut ids = Vec::new();
        for member in MEMBERS {
            let token = format!("member-{member}");
            clients.push(dial_tunnel_as(port, axum::Router::new(), &token).await);
            ids.push(next_registration_of(&mut registry_events, &token).await);
        }
        drop(registry_events);
        let registered = |member: u128| {
            registry
                .tunnels()
                .get(&format!("member-{member}"), &format!("ds-{member}"))
                .is_some()
        };

        let config = test_config("127.0.0.1:1".parse().unwrap());
        let sessions = SessionStore::new(100, Duration::from_secs(3600));
        let (_requests_tx, mut requests_rx) = mpsc::channel(1);
        let (readiness_tx, mut readiness) = watch::channel(false);
        let (lifecycle_tx, _lifecycle_rx) = mpsc::channel(8);
        let (proxy_stream, mut controller) = duplex(64 * 1024);
        let stream = tokio::spawn({
            let registry = registry.clone();
            let sessions = sessions.clone();
            async move {
                run_stream(
                    proxy_stream,
                    config.as_ref(),
                    Uuid::new_v4(),
                    &registry,
                    &sessions,
                    &mut requests_rx,
                    &readiness_tx,
                    lifecycle_tx,
                )
                .await
            }
        });

        let _: ClientFrame = read_frame(&mut controller).await.unwrap();
        write_frame(
            &mut controller,
            &ServerFrame::ServerHello {
                protocol_version: PROTOCOL_VERSION,
                package_version: env!("CARGO_PKG_VERSION").into(),
                heartbeat_seconds: 5,
                dead_seconds: 15,
                grace_seconds: 30,
            },
        )
        .await
        .unwrap();
        let mut snapshot_rows = HashSet::new();
        let base_generation = loop {
            match read_frame::<_, ClientFrame>(&mut controller).await.unwrap() {
                ClientFrame::SnapshotStart { .. } => {}
                ClientFrame::SnapshotChunk { rows } => {
                    snapshot_rows.extend(rows.iter().map(|row| row.registration_id));
                }
                ClientFrame::SnapshotEnd { base_generation } => break base_generation,
                other => panic!("unexpected frame during the snapshot: {other:?}"),
            }
        };
        assert_eq!(snapshot_rows, ids.iter().copied().collect::<HashSet<_>>());
        write_frame(
            &mut controller,
            &ServerFrame::SnapshotAccepted { base_generation },
        )
        .await
        .unwrap();
        write_frame(&mut controller, &ServerFrame::FleetReady)
            .await
            .unwrap();
        readiness.wait_for(|ready| *ready).await.unwrap();

        let binding = |member: u128, registration_id, proxy_id| {
            lease_binding(
                Uuid::from_u128(member),
                &format!("member-{member}"),
                &format!("ds-{member}"),
                registration_id,
                proxy_id,
            )
        };
        let refused = [
            (
                "a refresh signed outside the ring",
                3,
                signed_lease(binding(3, ids[0], "p1"), FOREIGN_ADMISSION_SIGNING_KEY)
                    .as_str()
                    .to_string(),
            ),
            (
                "a refresh bound to another registration",
                4,
                signed_lease(binding(4, Uuid::new_v4(), "p1"), TEST_ADMISSION_SIGNING_KEY)
                    .as_str()
                    .to_string(),
            ),
            (
                "a refresh bound to another proxy",
                5,
                signed_lease(binding(5, ids[2], "p2"), TEST_ADMISSION_SIGNING_KEY)
                    .as_str()
                    .to_string(),
            ),
            (
                "a refresh bound to another owner",
                6,
                signed_lease(
                    lease_binding(Uuid::new_v4(), "member-6", "ds-6", ids[3], "p1"),
                    TEST_ADMISSION_SIGNING_KEY,
                )
                .as_str()
                .to_string(),
            ),
            ("a refresh that does not parse", 7, String::new()),
        ];
        let expires_at = chrono::Utc::now() + chrono::Duration::seconds(120);
        let mut generation = base_generation;
        for (step, member, lease) in refused {
            let registration_id = ids[(member - 3) as usize];
            assert!(
                registry.tunnels().refresh_admission_lease(
                    registration_id,
                    Uuid::from_u128(member),
                    lease.into(),
                    expires_at,
                ),
                "{step}: the registry did not take the refresh"
            );
            generation += 1;
            match read_frame::<_, ClientFrame>(&mut controller).await {
                Ok(ClientFrame::TunnelDown {
                    generation: sent,
                    registration_id: down,
                }) if sent == generation && down == registration_id => {}
                Ok(other) => panic!(
                    "{step}: expected TunnelDown {{ generation: {generation}, registration_id: \
                     {registration_id} }}, got {other:?}; still registered: {}",
                    registered(member)
                ),
                Err(error) => panic!(
                    "{step}: the control stream ended ({error}); stream task finished: {}; \
                     still registered: {}",
                    stream.is_finished(),
                    registered(member)
                ),
            }
            assert!(
                !registered(member),
                "{step}: the registration was not evicted"
            );
        }

        // The control case: a refresh that verifies is forwarded, and its
        // tunnel stays.
        let renewal = signed_lease(binding(8, ids[5], "p1"), TEST_ADMISSION_SIGNING_KEY);
        assert!(registry.tunnels().refresh_admission_lease(
            ids[5],
            Uuid::from_u128(8),
            renewal.as_str().into(),
            expires_at,
        ));
        let forwarded = read_frame::<_, ClientFrame>(&mut controller).await.unwrap();
        assert!(
            matches!(
                &forwarded,
                ClientFrame::LeaseRefresh { registration_id, admission_lease }
                    if *registration_id == ids[5] && *admission_lease == renewal
            ),
            "{forwarded:?}"
        );
        issue_browser_session(&sessions);
        let next = read_frame::<_, ClientFrame>(&mut controller).await.unwrap();
        assert!(
            matches!(next, ClientFrame::BrowserSessionUp { generation: sent, .. } if sent == generation + 1),
            "{next:?}"
        );
        assert!(registered(8));
        assert!(!stream.is_finished());

        drop(controller);
        let _ = stream.await;
        for client in clients {
            client.stop().await;
        }
        listener.abort();
    }
}
