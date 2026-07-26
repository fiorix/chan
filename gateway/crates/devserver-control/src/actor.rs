use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use devserver_control_proto::{
    AdmissionLease, BrowserSessionRow, CanonicalOrigin, ProxyId, ServerFrame, SessionRevocation,
    TunnelRow,
};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::{Instant, MissedTickBehavior};
use uuid::Uuid;

use crate::{
    BrowserSessionView, CommandOutcome, ControllerState, Effect, ProxyView, SessionIncarnation,
    SessionKey, StateError, TunnelView,
};

const ACTOR_QUEUE_CAPACITY: usize = 1024;
const SESSION_QUEUE_CAPACITY: usize = 1024;
const TICK_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone)]
pub struct ControllerHandle {
    tx: mpsc::Sender<Command>,
    readiness_watch: watch::Receiver<bool>,
    tunnel_watch: watch::Receiver<Arc<Vec<TunnelView>>>,
    proxy_watch: watch::Receiver<Arc<Vec<ProxyView>>>,
    browser_session_watch: watch::Receiver<Arc<Vec<BrowserSessionView>>>,
}

pub struct ProxyControlSession {
    pub incarnation: SessionIncarnation,
    pub commands: mpsc::Receiver<ServerFrame>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MutationStatus {
    Applied,
    Resyncing,
}

/// Plan returned to an admin kill request. Each receiver in `Issued`
/// resolves when the corresponding kill command settles (result, timeout,
/// or owning-session loss), so the HTTP handler never blocks the actor
/// loop while awaiting proxy confirmations.
pub enum KillPlan {
    /// No aggregate row matched the target key.
    NotFound,
    /// One kill command per owning proxy session.
    Issued(Vec<oneshot::Receiver<CommandOutcome>>),
}

pub struct SessionRevocationPlan {
    pub confirmations: Vec<oneshot::Receiver<CommandOutcome>>,
    pub unreachable_proxies: usize,
    pub authority_ready: bool,
}

enum Command {
    BeginSession {
        proxy_id: ProxyId,
        base_url: CanonicalOrigin,
        package_version: String,
        boot_id: Uuid,
        command_tx: mpsc::Sender<ServerFrame>,
        reply: oneshot::Sender<Result<SessionIncarnation, StateError>>,
    },
    AcceptSnapshot {
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
        base_generation: u64,
        rows: Vec<TunnelRow>,
        browser_sessions: Vec<BrowserSessionRow>,
        reply: StateReply,
    },
    TunnelUp {
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
        generation: u64,
        row: TunnelRow,
        reply: StateReply,
    },
    TunnelDown {
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
        generation: u64,
        registration_id: Uuid,
        reply: StateReply,
    },
    BrowserSessionUp {
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
        generation: u64,
        row: BrowserSessionRow,
        reply: StateReply,
    },
    BrowserSessionDown {
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
        generation: u64,
        admin_session_id: Uuid,
        reply: StateReply,
    },
    RequestAdmission {
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
        request_id: Uuid,
        registration_id: Uuid,
        owner_user_id: Uuid,
        user: String,
        devserver_id: String,
        max_connected_devservers: u32,
        admission_lease: AdmissionLease,
        admission_lease_expires_at: DateTime<Utc>,
        reply: StateReply,
    },
    RefreshLease {
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
        registration_id: Uuid,
        owner_user_id: Uuid,
        user: String,
        devserver_id: String,
        max_connected_devservers: u32,
        admission_lease: AdmissionLease,
        admission_lease_expires_at: DateTime<Utc>,
        reply: StateReply,
    },
    CancelAdmission {
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
        request_id: Uuid,
        registration_id: Uuid,
        reply: StateReply,
    },
    Pong {
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
        nonce: u64,
        reply: StateReply,
    },
    RecordActivity {
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
        reply: StateReply,
    },
    ReportResult {
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
        command_id: Uuid,
        killed: Vec<Uuid>,
        missing: Vec<Uuid>,
        failed: Vec<Uuid>,
        reply: StateReply,
    },
    ReportSessionRevocation {
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
        command_id: Uuid,
        revoked: usize,
        reply: StateReply,
    },
    Disconnect {
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
        reply: StateReply,
    },
    RequireResync {
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
        reply: StateReply,
    },
    Readiness {
        reply: oneshot::Sender<bool>,
    },
    Tunnels {
        reply: oneshot::Sender<Result<Vec<TunnelView>, StateError>>,
    },
    OwnerTunnels {
        owner_user_id: Uuid,
        reply: oneshot::Sender<Result<Vec<TunnelView>, StateError>>,
    },
    Proxies {
        reply: oneshot::Sender<Result<Vec<ProxyView>, StateError>>,
    },
    BrowserSessions {
        reply: oneshot::Sender<Result<Vec<BrowserSessionView>, StateError>>,
    },
    KillTunnel {
        owner_user_id: Uuid,
        devserver_id: String,
        reply: oneshot::Sender<Result<KillPlan, StateError>>,
    },
    KillUserTunnels {
        owner_user_id: Uuid,
        reply: oneshot::Sender<Result<KillPlan, StateError>>,
    },
    KillAllTunnels {
        reply: oneshot::Sender<Result<KillPlan, StateError>>,
    },
    RevokeSessions {
        revocation: SessionRevocation,
        reply: oneshot::Sender<Result<SessionRevocationPlan, StateError>>,
    },
}

impl Command {
    fn affects_watch_views(&self) -> bool {
        !matches!(
            self,
            Self::Readiness { .. }
                | Self::Tunnels { .. }
                | Self::OwnerTunnels { .. }
                | Self::Proxies { .. }
                | Self::BrowserSessions { .. }
        )
    }
}

type StateReply = oneshot::Sender<Result<MutationStatus, StateError>>;

pub fn spawn_controller(max_devservers_per_user: usize) -> ControllerHandle {
    spawn_controller_owned(max_devservers_per_user).0
}

pub fn spawn_controller_owned(
    max_devservers_per_user: usize,
) -> (ControllerHandle, tokio::task::JoinHandle<()>) {
    let (tx, mut rx) = mpsc::channel::<Command>(ACTOR_QUEUE_CAPACITY);
    let (readiness_watch_tx, readiness_watch) = watch::channel(false);
    let (tunnel_watch_tx, tunnel_watch) = watch::channel(Arc::new(Vec::new()));
    let (proxy_watch_tx, proxy_watch) = watch::channel(Arc::new(Vec::new()));
    let (browser_session_watch_tx, browser_session_watch) = watch::channel(Arc::new(Vec::new()));

    let task = tokio::spawn(async move {
        let mut state = ControllerState::new(max_devservers_per_user);
        let mut sessions = HashMap::new();
        let mut waiters = HashMap::new();
        let mut ticker = tokio::time::interval(TICK_INTERVAL);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut watch_views_dirty = true;

        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    let before = state.watch_shape();
                    let effects = state.tick(Instant::now(), Utc::now());
                    let has_effects = !effects.is_empty();
                    apply_effects(&mut state, &mut sessions, &mut waiters, effects);
                    watch_views_dirty |= has_effects || before != state.watch_shape();
                    if watch_views_dirty {
                        publish_watches(
                            &state,
                            &readiness_watch_tx,
                            &tunnel_watch_tx,
                            &proxy_watch_tx,
                            &browser_session_watch_tx,
                        );
                        watch_views_dirty = false;
                    }
                }
                command = rx.recv() => {
                    let Some(command) = command else {
                        break;
                    };
                    let affects_watch_views = command.affects_watch_views();
                    let effects = handle_command(command, &mut state, &mut sessions, &mut waiters);
                    apply_effects(&mut state, &mut sessions, &mut waiters, effects);
                    watch_views_dirty |= affects_watch_views;
                }
            }
        }
    });

    (
        ControllerHandle {
            tx,
            readiness_watch,
            tunnel_watch,
            proxy_watch,
            browser_session_watch,
        },
        task,
    )
}

fn handle_command(
    command: Command,
    state: &mut ControllerState,
    sessions: &mut HashMap<SessionKey, mpsc::Sender<ServerFrame>>,
    waiters: &mut HashMap<Uuid, oneshot::Sender<CommandOutcome>>,
) -> Vec<Effect> {
    let now = Instant::now();
    let wall_now = Utc::now();
    match command {
        Command::BeginSession {
            proxy_id,
            base_url,
            package_version,
            boot_id,
            command_tx,
            reply,
        } => {
            let proxy_id_text = proxy_id.as_str().to_string();
            let (incarnation, effects) = match state.begin_session_authorized(
                proxy_id,
                base_url,
                package_version,
                boot_id,
                now,
                wall_now,
            ) {
                Ok(result) => result,
                Err(error) => {
                    let _ = reply.send(Err(error));
                    return Vec::new();
                }
            };
            sessions.insert(
                SessionKey {
                    proxy_id: proxy_id_text,
                    incarnation,
                },
                command_tx,
            );
            let _ = reply.send(Ok(incarnation));
            effects
        }
        Command::AcceptSnapshot {
            proxy_id,
            incarnation,
            base_generation,
            rows,
            browser_sessions,
            reply,
        } => finish(
            reply,
            state.accept_snapshot(
                &proxy_id,
                incarnation,
                base_generation,
                rows,
                browser_sessions,
                now,
                wall_now,
            ),
        ),
        Command::TunnelUp {
            proxy_id,
            incarnation,
            generation,
            row,
            reply,
        } => finish(
            reply,
            state.tunnel_up(&proxy_id, incarnation, generation, row, now, wall_now),
        ),
        Command::TunnelDown {
            proxy_id,
            incarnation,
            generation,
            registration_id,
            reply,
        } => finish(
            reply,
            state.tunnel_down(
                &proxy_id,
                incarnation,
                generation,
                registration_id,
                now,
                wall_now,
            ),
        ),
        Command::BrowserSessionUp {
            proxy_id,
            incarnation,
            generation,
            row,
            reply,
        } => finish(
            reply,
            state.browser_session_up(&proxy_id, incarnation, generation, row, now, wall_now),
        ),
        Command::BrowserSessionDown {
            proxy_id,
            incarnation,
            generation,
            admin_session_id,
            reply,
        } => finish(
            reply,
            state.browser_session_down(
                &proxy_id,
                incarnation,
                generation,
                admin_session_id,
                now,
                wall_now,
            ),
        ),
        Command::RequestAdmission {
            proxy_id,
            incarnation,
            request_id,
            registration_id,
            owner_user_id,
            user,
            devserver_id,
            max_connected_devservers,
            admission_lease,
            admission_lease_expires_at,
            reply,
        } => finish(
            reply,
            state.request_admission_authorized(
                &proxy_id,
                incarnation,
                request_id,
                registration_id,
                owner_user_id,
                user,
                devserver_id,
                max_connected_devservers,
                admission_lease,
                admission_lease_expires_at,
                now,
                wall_now,
            ),
        ),
        Command::RefreshLease {
            proxy_id,
            incarnation,
            registration_id,
            owner_user_id,
            user,
            devserver_id,
            max_connected_devservers,
            admission_lease,
            admission_lease_expires_at,
            reply,
        } => finish(
            reply,
            state.refresh_lease(
                &proxy_id,
                incarnation,
                registration_id,
                owner_user_id,
                user,
                devserver_id,
                max_connected_devservers,
                admission_lease,
                admission_lease_expires_at,
                now,
                wall_now,
            ),
        ),
        Command::CancelAdmission {
            proxy_id,
            incarnation,
            request_id,
            registration_id,
            reply,
        } => finish_unit(
            reply,
            state.cancel_admission(
                &proxy_id,
                incarnation,
                request_id,
                registration_id,
                now,
                wall_now,
            ),
        ),
        Command::Pong {
            proxy_id,
            incarnation,
            nonce,
            reply,
        } => finish_unit(
            reply,
            state.pong(&proxy_id, incarnation, nonce, now, wall_now),
        ),
        Command::RecordActivity {
            proxy_id,
            incarnation,
            reply,
        } => finish_unit(
            reply,
            state.record_activity(&proxy_id, incarnation, now, wall_now),
        ),
        Command::ReportResult {
            proxy_id,
            incarnation,
            command_id,
            killed,
            missing,
            failed,
            reply,
        } => finish(
            reply,
            state.command_result(
                &proxy_id,
                incarnation,
                command_id,
                killed,
                missing,
                failed,
                now,
                wall_now,
            ),
        ),
        Command::ReportSessionRevocation {
            proxy_id,
            incarnation,
            command_id,
            revoked,
            reply,
        } => finish(
            reply,
            state.session_revocation_result(&proxy_id, incarnation, command_id, revoked),
        ),
        Command::Disconnect {
            proxy_id,
            incarnation,
            reply,
        } => {
            sessions.remove(&SessionKey {
                proxy_id: proxy_id.as_str().to_string(),
                incarnation,
            });
            finish(reply, state.disconnect(&proxy_id, incarnation, now))
        }
        Command::RequireResync {
            proxy_id,
            incarnation,
            reply,
        } => finish(reply, state.require_resync(&proxy_id, incarnation)),
        Command::Readiness { reply } => {
            let _ = reply.send(state.is_ready());
            Vec::new()
        }
        Command::Tunnels { reply } => {
            let _ = reply.send(state.read_tunnels());
            Vec::new()
        }
        Command::OwnerTunnels {
            owner_user_id,
            reply,
        } => {
            let _ = reply.send(state.read_owner_tunnels(owner_user_id));
            Vec::new()
        }
        Command::Proxies { reply } => {
            let _ = reply.send(state.read_proxies());
            Vec::new()
        }
        Command::BrowserSessions { reply } => {
            let _ = reply.send(state.read_browser_sessions());
            Vec::new()
        }
        Command::KillTunnel {
            owner_user_id,
            devserver_id,
            reply,
        } => {
            let (command_id, effects) =
                match state.begin_exact_kill(owner_user_id, &devserver_id, now) {
                    Ok(plan) => plan,
                    Err(error) => {
                        let _ = reply.send(Err(error));
                        return Vec::new();
                    }
                };
            let plan = match command_id {
                Some(command_id) => KillPlan::Issued(vec![register_waiter(waiters, command_id)]),
                None => KillPlan::NotFound,
            };
            let _ = reply.send(Ok(plan));
            effects
        }
        Command::KillUserTunnels {
            owner_user_id,
            reply,
        } => {
            let (command_ids, effects) = match state.begin_owner_kill(owner_user_id, now) {
                Ok(plan) => plan,
                Err(error) => {
                    let _ = reply.send(Err(error));
                    return Vec::new();
                }
            };
            let confirmations = command_ids
                .into_iter()
                .map(|command_id| register_waiter(waiters, command_id))
                .collect();
            let _ = reply.send(Ok(KillPlan::Issued(confirmations)));
            effects
        }
        Command::KillAllTunnels { reply } => {
            let (command_ids, effects) = match state.begin_all_kill(now) {
                Ok(plan) => plan,
                Err(error) => {
                    let _ = reply.send(Err(error));
                    return Vec::new();
                }
            };
            let confirmations = command_ids
                .into_iter()
                .map(|command_id| register_waiter(waiters, command_id))
                .collect();
            let _ = reply.send(Ok(KillPlan::Issued(confirmations)));
            effects
        }
        Command::RevokeSessions { revocation, reply } => {
            let (command_ids, effects, unreachable_proxies, authority_ready) =
                match state.begin_session_revocation(revocation, now) {
                    Ok(plan) => plan,
                    Err(error) => {
                        let _ = reply.send(Err(error));
                        return Vec::new();
                    }
                };
            let confirmations = command_ids
                .into_iter()
                .map(|command_id| register_waiter(waiters, command_id))
                .collect();
            let _ = reply.send(Ok(SessionRevocationPlan {
                confirmations,
                unreachable_proxies,
                authority_ready,
            }));
            effects
        }
    }
}

/// Waiters register inside the command handler, before `apply_effects`
/// runs, so a command that settles immediately (dead session queue, an
/// already-expired command) still resolves its waiter instead of losing
/// the settle effect.
fn register_waiter(
    waiters: &mut HashMap<Uuid, oneshot::Sender<CommandOutcome>>,
    command_id: Uuid,
) -> oneshot::Receiver<CommandOutcome> {
    let (tx, rx) = oneshot::channel();
    waiters.insert(command_id, tx);
    rx
}

fn finish(reply: StateReply, result: Result<Vec<Effect>, StateError>) -> Vec<Effect> {
    match result {
        Ok(effects) => {
            let status = if effects.iter().any(|effect| {
                matches!(
                    effect,
                    Effect::Send {
                        frame: ServerFrame::ResyncRequired { .. },
                        ..
                    }
                )
            }) {
                MutationStatus::Resyncing
            } else {
                MutationStatus::Applied
            };
            let _ = reply.send(Ok(status));
            effects
        }
        Err(error) => {
            let _ = reply.send(Err(error));
            Vec::new()
        }
    }
}

fn finish_unit(reply: StateReply, result: Result<(), StateError>) -> Vec<Effect> {
    let _ = reply.send(result.map(|()| MutationStatus::Applied));
    Vec::new()
}

fn apply_effects(
    state: &mut ControllerState,
    sessions: &mut HashMap<SessionKey, mpsc::Sender<ServerFrame>>,
    waiters: &mut HashMap<Uuid, oneshot::Sender<CommandOutcome>>,
    effects: Vec<Effect>,
) {
    let mut effects: VecDeque<_> = effects.into();
    let mut failed = HashSet::new();
    while !effects.is_empty() || !failed.is_empty() {
        while let Some(effect) = effects.pop_front() {
            match effect {
                Effect::Send { session, frame } => {
                    let send_failed = match sessions.get(&session) {
                        Some(sender) => sender.try_send(frame).is_err(),
                        None => true,
                    };
                    if send_failed {
                        failed.insert(session);
                    }
                }
                Effect::Retire { session, reason } => {
                    if let Some(sender) = sessions.remove(&session) {
                        let _ = sender.try_send(ServerFrame::Shutdown {
                            reason,
                            retryable: true,
                        });
                    }
                }
                Effect::CommandSettled {
                    command_id,
                    outcome,
                } => {
                    // Commands issued without an admin waiter (replacement
                    // and unclaimed-row kills) settle with no registered
                    // waiter; the removal is the whole handling.
                    if let Some(waiter) = waiters.remove(&command_id) {
                        let _ = waiter.send(outcome);
                    }
                }
            }
        }

        for session in failed.drain() {
            sessions.remove(&session);
            let proxy_id =
                ProxyId::parse(&session.proxy_id).expect("session proxy id was validated");
            if let Ok(more) = state.disconnect(&proxy_id, session.incarnation, Instant::now()) {
                effects.extend(more);
            }
        }
    }
}

fn publish_watches(
    state: &ControllerState,
    readiness_watch: &watch::Sender<bool>,
    tunnel_watch: &watch::Sender<Arc<Vec<TunnelView>>>,
    proxy_watch: &watch::Sender<Arc<Vec<ProxyView>>>,
    browser_session_watch: &watch::Sender<Arc<Vec<BrowserSessionView>>>,
) {
    readiness_watch.send_if_modified(|ready| {
        let next = state.is_ready();
        if *ready == next {
            false
        } else {
            *ready = next;
            true
        }
    });
    publish(tunnel_watch, Arc::new(state.tunnel_views()));
    publish(proxy_watch, Arc::new(state.proxy_views()));
    publish(
        browser_session_watch,
        Arc::new(state.browser_session_views()),
    );
}

fn publish<T: PartialEq>(sender: &watch::Sender<Arc<Vec<T>>>, next: Arc<Vec<T>>) {
    sender.send_if_modified(|current| {
        if current.as_ref() == next.as_ref() {
            false
        } else {
            *current = next;
            true
        }
    });
}

impl ControllerHandle {
    pub async fn begin_session(
        &self,
        proxy_id: ProxyId,
        base_url: CanonicalOrigin,
        package_version: String,
        boot_id: Uuid,
    ) -> Result<ProxyControlSession, ActorError> {
        let (command_tx, commands) = mpsc::channel(SESSION_QUEUE_CAPACITY);
        let incarnation = self
            .request(|reply| Command::BeginSession {
                proxy_id,
                base_url,
                package_version,
                boot_id,
                command_tx,
                reply,
            })
            .await?
            .map_err(ActorError::State)?;
        Ok(ProxyControlSession {
            incarnation,
            commands,
        })
    }

    pub async fn accept_snapshot(
        &self,
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
        base_generation: u64,
        rows: Vec<TunnelRow>,
        browser_sessions: Vec<BrowserSessionRow>,
    ) -> Result<MutationStatus, ActorError> {
        self.state_request(|reply| Command::AcceptSnapshot {
            proxy_id,
            incarnation,
            base_generation,
            rows,
            browser_sessions,
            reply,
        })
        .await
    }

    pub async fn tunnel_up(
        &self,
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
        generation: u64,
        row: TunnelRow,
    ) -> Result<MutationStatus, ActorError> {
        self.state_request(|reply| Command::TunnelUp {
            proxy_id,
            incarnation,
            generation,
            row,
            reply,
        })
        .await
    }

    pub async fn tunnel_down(
        &self,
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
        generation: u64,
        registration_id: Uuid,
    ) -> Result<MutationStatus, ActorError> {
        self.state_request(|reply| Command::TunnelDown {
            proxy_id,
            incarnation,
            generation,
            registration_id,
            reply,
        })
        .await
    }

    pub async fn browser_session_up(
        &self,
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
        generation: u64,
        row: BrowserSessionRow,
    ) -> Result<MutationStatus, ActorError> {
        self.state_request(|reply| Command::BrowserSessionUp {
            proxy_id,
            incarnation,
            generation,
            row,
            reply,
        })
        .await
    }

    pub async fn browser_session_down(
        &self,
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
        generation: u64,
        admin_session_id: Uuid,
    ) -> Result<MutationStatus, ActorError> {
        self.state_request(|reply| Command::BrowserSessionDown {
            proxy_id,
            incarnation,
            generation,
            admin_session_id,
            reply,
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn request_admission_authorized(
        &self,
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
        request_id: Uuid,
        registration_id: Uuid,
        owner_user_id: Uuid,
        user: String,
        devserver_id: String,
        max_connected_devservers: u32,
        admission_lease: AdmissionLease,
        admission_lease_expires_at: DateTime<Utc>,
    ) -> Result<MutationStatus, ActorError> {
        self.state_request(|reply| Command::RequestAdmission {
            proxy_id,
            incarnation,
            request_id,
            registration_id,
            owner_user_id,
            user,
            devserver_id,
            max_connected_devservers,
            admission_lease,
            admission_lease_expires_at,
            reply,
        })
        .await
    }

    #[cfg(test)]
    pub async fn request_admission(
        &self,
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
        request_id: Uuid,
        registration_id: Uuid,
        user: String,
        devserver_id: String,
    ) -> Result<MutationStatus, ActorError> {
        self.request_admission_authorized(
            proxy_id,
            incarnation,
            request_id,
            registration_id,
            crate::state::legacy_owner_user_id(&user),
            user,
            devserver_id,
            devserver_control_proto::MAX_SIGNED_CONNECTED_DEVSERVERS,
            AdmissionLease::parse("test").expect("test lease"),
            Utc::now() + chrono::Duration::minutes(5),
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn refresh_lease(
        &self,
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
        registration_id: Uuid,
        owner_user_id: Uuid,
        user: String,
        devserver_id: String,
        max_connected_devservers: u32,
        admission_lease: AdmissionLease,
        admission_lease_expires_at: DateTime<Utc>,
    ) -> Result<MutationStatus, ActorError> {
        self.state_request(|reply| Command::RefreshLease {
            proxy_id,
            incarnation,
            registration_id,
            owner_user_id,
            user,
            devserver_id,
            max_connected_devservers,
            admission_lease,
            admission_lease_expires_at,
            reply,
        })
        .await
    }

    pub async fn cancel_admission(
        &self,
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
        request_id: Uuid,
        registration_id: Uuid,
    ) -> Result<MutationStatus, ActorError> {
        self.state_request(|reply| Command::CancelAdmission {
            proxy_id,
            incarnation,
            request_id,
            registration_id,
            reply,
        })
        .await
    }

    pub async fn pong(
        &self,
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
        nonce: u64,
    ) -> Result<MutationStatus, ActorError> {
        self.state_request(|reply| Command::Pong {
            proxy_id,
            incarnation,
            nonce,
            reply,
        })
        .await
    }

    pub async fn record_activity(
        &self,
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
    ) -> Result<MutationStatus, ActorError> {
        self.state_request(|reply| Command::RecordActivity {
            proxy_id,
            incarnation,
            reply,
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn command_result(
        &self,
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
        command_id: Uuid,
        killed: Vec<Uuid>,
        missing: Vec<Uuid>,
        failed: Vec<Uuid>,
    ) -> Result<MutationStatus, ActorError> {
        self.state_request(|reply| Command::ReportResult {
            proxy_id,
            incarnation,
            command_id,
            killed,
            missing,
            failed,
            reply,
        })
        .await
    }

    pub async fn session_revocation_result(
        &self,
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
        command_id: Uuid,
        revoked: usize,
    ) -> Result<MutationStatus, ActorError> {
        self.state_request(|reply| Command::ReportSessionRevocation {
            proxy_id,
            incarnation,
            command_id,
            revoked,
            reply,
        })
        .await
    }

    pub async fn disconnect(
        &self,
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
    ) -> Result<MutationStatus, ActorError> {
        self.state_request(|reply| Command::Disconnect {
            proxy_id,
            incarnation,
            reply,
        })
        .await
    }

    pub async fn require_resync(
        &self,
        proxy_id: ProxyId,
        incarnation: SessionIncarnation,
    ) -> Result<MutationStatus, ActorError> {
        self.state_request(|reply| Command::RequireResync {
            proxy_id,
            incarnation,
            reply,
        })
        .await
    }

    pub async fn is_ready(&self) -> Result<bool, ActorError> {
        self.request(|reply| Command::Readiness { reply }).await
    }

    pub async fn tunnels(&self) -> Result<Vec<TunnelView>, ActorError> {
        self.request(|reply| Command::Tunnels { reply })
            .await?
            .map_err(ActorError::State)
    }

    pub async fn owner_tunnels(&self, owner_user_id: Uuid) -> Result<Vec<TunnelView>, ActorError> {
        self.request(|reply| Command::OwnerTunnels {
            owner_user_id,
            reply,
        })
        .await?
        .map_err(ActorError::State)
    }

    pub async fn proxies(&self) -> Result<Vec<ProxyView>, ActorError> {
        self.request(|reply| Command::Proxies { reply })
            .await?
            .map_err(ActorError::State)
    }

    pub async fn browser_sessions(&self) -> Result<Vec<BrowserSessionView>, ActorError> {
        self.request(|reply| Command::BrowserSessions { reply })
            .await?
            .map_err(ActorError::State)
    }

    pub async fn plan_tunnel_kill(
        &self,
        owner_user_id: Uuid,
        devserver_id: &str,
    ) -> Result<KillPlan, ActorError> {
        self.request(|reply| Command::KillTunnel {
            owner_user_id,
            devserver_id: devserver_id.to_string(),
            reply,
        })
        .await?
        .map_err(ActorError::State)
    }

    pub async fn plan_owner_kill(&self, owner_user_id: Uuid) -> Result<KillPlan, ActorError> {
        self.request(|reply| Command::KillUserTunnels {
            owner_user_id,
            reply,
        })
        .await?
        .map_err(ActorError::State)
    }

    pub async fn plan_all_kill(&self) -> Result<KillPlan, ActorError> {
        self.request(|reply| Command::KillAllTunnels { reply })
            .await?
            .map_err(ActorError::State)
    }

    pub async fn plan_session_revocation(
        &self,
        revocation: SessionRevocation,
    ) -> Result<SessionRevocationPlan, ActorError> {
        self.request(|reply| Command::RevokeSessions { revocation, reply })
            .await?
            .map_err(ActorError::State)
    }

    pub fn watch_tunnels(&self) -> watch::Receiver<Arc<Vec<TunnelView>>> {
        self.tunnel_watch.clone()
    }

    pub fn watch_readiness(&self) -> watch::Receiver<bool> {
        self.readiness_watch.clone()
    }

    pub fn watch_proxies(&self) -> watch::Receiver<Arc<Vec<ProxyView>>> {
        self.proxy_watch.clone()
    }

    pub fn watch_browser_sessions(&self) -> watch::Receiver<Arc<Vec<BrowserSessionView>>> {
        self.browser_session_watch.clone()
    }

    async fn state_request(
        &self,
        build: impl FnOnce(StateReply) -> Command,
    ) -> Result<MutationStatus, ActorError> {
        self.request(build).await?.map_err(ActorError::State)
    }

    async fn request<T>(
        &self,
        build: impl FnOnce(oneshot::Sender<T>) -> Command,
    ) -> Result<T, ActorError> {
        let (reply, wait) = oneshot::channel();
        self.tx
            .send(build(reply))
            .await
            .map_err(|_| ActorError::Stopped)?;
        wait.await.map_err(|_| ActorError::Stopped)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ActorError {
    #[error("controller actor stopped")]
    Stopped,
    #[error(transparent)]
    State(#[from] StateError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SESSION_DEAD_AFTER;

    fn proxy() -> ProxyId {
        ProxyId::parse("p1").unwrap()
    }

    async fn keep_alive_until_ready(actor: &ControllerHandle, session: &mut ProxyControlSession) {
        for _ in 0..6 {
            tokio::time::advance(crate::HEARTBEAT_INTERVAL).await;
            let mut nonce = None;
            for _ in 0..8 {
                let frame =
                    tokio::time::timeout(crate::HEARTBEAT_INTERVAL, session.commands.recv())
                        .await
                        .expect("controller command wait timed out")
                        .expect("controller command channel closed");
                if let ServerFrame::Ping { nonce: ping_nonce } = frame {
                    nonce = Some(ping_nonce);
                    break;
                }
            }
            actor
                .pong(
                    proxy(),
                    session.incarnation,
                    nonce.expect("controller did not send a Ping within eight frames"),
                )
                .await
                .unwrap();
        }
        tokio::task::yield_now().await;
    }

    #[tokio::test(start_paused = true)]
    async fn actor_holds_reads_until_convergence_and_expires_silent_sessions() {
        let actor = spawn_controller(100);
        let mut proxy_watch = actor.watch_proxies();
        let mut session = actor
            .begin_session(
                proxy(),
                CanonicalOrigin::parse("https://p1.proxy.example.test").unwrap(),
                env!("CARGO_PKG_VERSION").into(),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        actor
            .accept_snapshot(proxy(), session.incarnation, 0, Vec::new(), Vec::new())
            .await
            .unwrap();
        assert!(matches!(
            actor.proxies().await,
            Err(ActorError::State(StateError::NotReady))
        ));

        keep_alive_until_ready(&actor, &mut session).await;
        assert!(actor.is_ready().await.unwrap());
        assert_eq!(actor.proxies().await.unwrap().len(), 1);
        while let Some(frame) = session.commands.recv().await {
            if frame == ServerFrame::FleetReady {
                break;
            }
        }

        tokio::time::advance(SESSION_DEAD_AFTER).await;
        tokio::task::yield_now().await;
        assert!(!actor.is_ready().await.unwrap());
        assert!(matches!(
            actor.tunnels().await,
            Err(ActorError::State(StateError::NotReady))
        ));
        while !proxy_watch.borrow_and_update().is_empty() {
            proxy_watch.changed().await.unwrap();
        }
        assert!(proxy_watch.borrow().is_empty());
        assert!(matches!(
            session.commands.try_recv(),
            Ok(ServerFrame::Shutdown { reason, .. })
                if reason == "proxy control heartbeat expired"
        ));
        assert!(matches!(
            session.commands.try_recv(),
            Err(mpsc::error::TryRecvError::Disconnected)
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn command_flood_coalesces_watch_publication_to_the_one_second_tick() {
        let actor = spawn_controller(100);
        tokio::task::yield_now().await;
        let mut proxy_watch = actor.watch_proxies();
        proxy_watch.borrow_and_update();
        let _session = actor
            .begin_session(
                proxy(),
                CanonicalOrigin::parse("https://p1.proxy.example.test").unwrap(),
                env!("CARGO_PKG_VERSION").into(),
                Uuid::new_v4(),
            )
            .await
            .unwrap();

        for _ in 0..512 {
            assert!(!actor.is_ready().await.unwrap());
        }
        assert!(
            !proxy_watch.has_changed().unwrap(),
            "commands published a whole-fleet view before the tick"
        );
        tokio::time::advance(TICK_INTERVAL - Duration::from_millis(1)).await;
        tokio::task::yield_now().await;
        assert!(!proxy_watch.has_changed().unwrap());
        tokio::time::advance(Duration::from_millis(1)).await;
        proxy_watch.changed().await.unwrap();
        assert_eq!(proxy_watch.borrow_and_update().len(), 1);
        assert!(!proxy_watch.has_changed().unwrap());
    }

    #[tokio::test(start_paused = true)]
    async fn actor_publishes_complete_watch_snapshots() {
        let actor = spawn_controller(100);
        let mut proxies = actor.watch_proxies();
        let mut tunnels = actor.watch_tunnels();
        let mut session = actor
            .begin_session(
                proxy(),
                CanonicalOrigin::parse("https://p1.proxy.example.test").unwrap(),
                env!("CARGO_PKG_VERSION").into(),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        proxies.changed().await.unwrap();
        assert_eq!(proxies.borrow().len(), 1);
        actor
            .accept_snapshot(proxy(), session.incarnation, 0, Vec::new(), Vec::new())
            .await
            .unwrap();
        keep_alive_until_ready(&actor, &mut session).await;

        let registration_id = Uuid::new_v4();
        actor
            .request_admission(
                proxy(),
                session.incarnation,
                Uuid::new_v4(),
                registration_id,
                "alice".into(),
                "one".into(),
            )
            .await
            .unwrap();
        actor
            .tunnel_up(
                proxy(),
                session.incarnation,
                1,
                TunnelRow {
                    registration_id,
                    owner_user_id: crate::state::legacy_owner_user_id("alice"),
                    user: "alice".into(),
                    devserver_id: "one".into(),
                    max_connected_devservers:
                        devserver_control_proto::MAX_SIGNED_CONNECTED_DEVSERVERS,
                    admission_lease: AdmissionLease::parse("test").unwrap(),
                    admission_lease_expires_at: Utc::now() + chrono::Duration::days(365),
                    peer_addr: None,
                    connected_at: Utc::now(),
                },
            )
            .await
            .unwrap();
        tunnels.changed().await.unwrap();
        assert_eq!(tunnels.borrow().len(), 1);
        assert_eq!(tunnels.borrow()[0].proxy_id, "p1");
    }

    fn row(user: &str, devserver_id: &str, registration_id: Uuid) -> TunnelRow {
        TunnelRow {
            registration_id,
            owner_user_id: crate::state::legacy_owner_user_id(user),
            user: user.into(),
            devserver_id: devserver_id.into(),
            max_connected_devservers: devserver_control_proto::MAX_SIGNED_CONNECTED_DEVSERVERS,
            admission_lease: AdmissionLease::parse("test").unwrap(),
            admission_lease_expires_at: Utc::now() + chrono::Duration::days(365),
            peer_addr: None,
            connected_at: Utc::now(),
        }
    }

    async fn keep_alive_sessions_until_ready(
        actor: &ControllerHandle,
        sessions: &mut [(ProxyId, ProxyControlSession)],
    ) {
        for _ in 0..6 {
            tokio::time::advance(crate::HEARTBEAT_INTERVAL).await;
            for (proxy_id, session) in sessions.iter_mut() {
                let mut nonce = None;
                for _ in 0..8 {
                    let frame =
                        tokio::time::timeout(crate::HEARTBEAT_INTERVAL, session.commands.recv())
                            .await
                            .expect("controller command wait timed out")
                            .expect("controller command channel closed");
                    if let ServerFrame::Ping { nonce: ping_nonce } = frame {
                        nonce = Some(ping_nonce);
                        break;
                    }
                }
                actor
                    .pong(
                        proxy_id.clone(),
                        session.incarnation,
                        nonce.expect("controller did not send a Ping within eight frames"),
                    )
                    .await
                    .unwrap();
            }
        }
        tokio::task::yield_now().await;
    }

    async fn recv_kill(session: &mut ProxyControlSession) -> (Uuid, Vec<Uuid>) {
        loop {
            let frame = tokio::time::timeout(crate::HEARTBEAT_INTERVAL, session.commands.recv())
                .await
                .expect("kill command wait timed out")
                .expect("controller command channel closed");
            if let ServerFrame::KillRegistrations {
                command_id,
                registration_ids,
            } = frame
            {
                return (command_id, registration_ids);
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn user_kill_fans_out_and_resolves_when_both_proxies_confirm() {
        let actor = spawn_controller(100);
        let p1 = ProxyId::parse("p1").unwrap();
        let p2 = ProxyId::parse("p2").unwrap();
        let registration_one = Uuid::new_v4();
        let registration_two = Uuid::new_v4();
        let mut sessions = Vec::new();
        for (proxy_id, origin, devserver_id, registration_id) in [
            (
                p1.clone(),
                "https://p1.proxy.example.test",
                "one",
                registration_one,
            ),
            (
                p2.clone(),
                "https://p2.proxy.example.test",
                "two",
                registration_two,
            ),
        ] {
            let session = actor
                .begin_session(
                    proxy_id.clone(),
                    CanonicalOrigin::parse(origin).unwrap(),
                    env!("CARGO_PKG_VERSION").into(),
                    Uuid::new_v4(),
                )
                .await
                .unwrap();
            actor
                .accept_snapshot(
                    proxy_id.clone(),
                    session.incarnation,
                    0,
                    vec![row("alice", devserver_id, registration_id)],
                    Vec::new(),
                )
                .await
                .unwrap();
            sessions.push((proxy_id, session));
        }
        keep_alive_sessions_until_ready(&actor, &mut sessions).await;
        assert!(actor.is_ready().await.unwrap());

        let plan = actor
            .plan_owner_kill(crate::state::legacy_owner_user_id("alice"))
            .await
            .unwrap();
        let KillPlan::Issued(confirmations) = plan else {
            panic!("alice has live rows");
        };
        assert_eq!(confirmations.len(), 2);

        let mut reported = Vec::new();
        for (proxy_id, session) in &mut sessions {
            let (command_id, registration_ids) = recv_kill(session).await;
            assert_eq!(registration_ids.len(), 1);
            actor
                .command_result(
                    proxy_id.clone(),
                    session.incarnation,
                    command_id,
                    registration_ids.clone(),
                    Vec::new(),
                    Vec::new(),
                )
                .await
                .unwrap();
            reported.push(registration_ids[0]);
        }
        for confirmation in confirmations {
            assert_eq!(
                confirmation.await.unwrap(),
                CommandOutcome::Confirmed {
                    killed: 1,
                    missing: 0
                }
            );
        }
        reported.sort();
        let mut expected = vec![registration_one, registration_two];
        expected.sort();
        assert_eq!(reported, expected);
        assert!(actor.tunnels().await.unwrap().is_empty());

        // No aggregate row matches after the kill: the plan reports not
        // found instead of issuing another command.
        assert!(matches!(
            actor
                .plan_tunnel_kill(crate::state::legacy_owner_user_id("alice"), "one")
                .await
                .unwrap(),
            KillPlan::NotFound
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn kill_timeout_settles_waiter_without_wedging_actor() {
        let actor = spawn_controller(100);
        let registration_id = Uuid::new_v4();
        let mut session = actor
            .begin_session(
                proxy(),
                CanonicalOrigin::parse("https://p1.proxy.example.test").unwrap(),
                env!("CARGO_PKG_VERSION").into(),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        actor
            .accept_snapshot(
                proxy(),
                session.incarnation,
                0,
                vec![row("alice", "one", registration_id)],
                Vec::new(),
            )
            .await
            .unwrap();
        keep_alive_until_ready(&actor, &mut session).await;

        let plan = actor
            .plan_tunnel_kill(crate::state::legacy_owner_user_id("alice"), "one")
            .await
            .unwrap();
        let KillPlan::Issued(mut confirmations) = plan else {
            panic!("alice/one has a live row");
        };
        let confirmation = confirmations.pop().unwrap();

        tokio::time::advance(crate::COMMAND_TIMEOUT + Duration::from_secs(2)).await;
        assert_eq!(confirmation.await.unwrap(), CommandOutcome::TimedOut);
        assert!(actor.is_ready().await.unwrap());
        assert_eq!(actor.tunnels().await.unwrap().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn session_disconnect_mid_kill_settles_its_waiters() {
        let actor = spawn_controller(100);
        let registration_id = Uuid::new_v4();
        let mut session = actor
            .begin_session(
                proxy(),
                CanonicalOrigin::parse("https://p1.proxy.example.test").unwrap(),
                env!("CARGO_PKG_VERSION").into(),
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        actor
            .accept_snapshot(
                proxy(),
                session.incarnation,
                0,
                vec![row("alice", "one", registration_id)],
                Vec::new(),
            )
            .await
            .unwrap();
        keep_alive_until_ready(&actor, &mut session).await;

        let plan = actor
            .plan_owner_kill(crate::state::legacy_owner_user_id("alice"))
            .await
            .unwrap();
        let KillPlan::Issued(mut confirmations) = plan else {
            panic!("alice has a live row");
        };
        let confirmation = confirmations.pop().unwrap();
        actor
            .disconnect(proxy(), session.incarnation)
            .await
            .unwrap();
        assert_eq!(confirmation.await.unwrap(), CommandOutcome::SessionLost);
    }

    #[test]
    fn full_session_command_queue_disconnects_instead_of_dropping_state() {
        let now = Instant::now();
        let mut state = ControllerState::new(100);
        let proxy_id = proxy();
        let (incarnation, _) = state.begin_session(
            proxy_id.clone(),
            CanonicalOrigin::parse("https://p1.proxy.example.test").unwrap(),
            env!("CARGO_PKG_VERSION").into(),
            Uuid::new_v4(),
            now,
            Utc::now(),
        );
        let key = SessionKey {
            proxy_id: proxy_id.as_str().to_string(),
            incarnation,
        };
        let (sender, _receiver) = mpsc::channel(1);
        sender.try_send(ServerFrame::Ping { nonce: 1 }).unwrap();
        let mut sessions = HashMap::from([(key.clone(), sender)]);
        apply_effects(
            &mut state,
            &mut sessions,
            &mut HashMap::new(),
            vec![Effect::Send {
                session: key,
                frame: ServerFrame::Ping { nonce: 2 },
            }],
        );
        assert!(sessions.is_empty());
        assert!(state.proxy_views().is_empty());
    }
}
