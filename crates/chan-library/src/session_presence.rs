//! Per-tenant session presence: the leader and followers collaborating on one
//! served workspace (one `AppState`).
//!
//! [`window_presence`](crate::window_presence) answers "is this window
//! connected somewhere" with a bare `window_id -> socket count` refcount and
//! stays underneath unchanged (the `GET /api/windows` connected flag reads it).
//! This registry layers the COLLABORATION model on top: a per-tenant set of
//! participants keyed by the same `?w=<window_id>`, each with an origin-derived
//! role (a local-origin socket reads Leader, a tunnel socket reads Follower), a
//! lifecycle state, an optional display name, and a join order. A single
//! DESIGNATED-OWNER slot (the `leader` field) is elected local-first: the
//! lowest-join-order live LOCAL participant, falling back to the lowest-join
//! live remote only when no local is present. That slot drives handover
//! routing, the launcher gate, and the aggregate leaders map; when its holder's
//! last socket drops and stays gone past the grace, the slot is re-elected the
//! same way.
//!
//! Identity is the `window_id`, not the socket: a reload drops and reopens the
//! SAME `?w=` within the grace, so it must read as "still live, same
//! participant", never a leader-loss. The registry therefore keeps its own
//! per-participant socket count (independent of `window_presence`) so a reload's
//! brief old+new overlap holds the participant `Live`, and only a real
//! disconnect arms the grace clock.
//!
//! The state machine and grace clock are PURE and time-injectable
//! ([`reap_due`](SessionRegistry::reap_due) takes `now`); the `/ws` pump drives
//! the socket count via the RAII [`SessionGuard`], and a per-tenant reaper task
//! advances disconnected -> gone and broadcasts. Handover is a blocked
//! request/reply owned by the control layer; the registry holds only the
//! at-most-one pending request so the leader's separate `cs session handover
//! --accept` connection can find it.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::Notify;

use crate::name_casefold::comparison_key;

/// A participant whose last socket dropped holds `Disconnecting` for this long
/// before it surfaces as `Disconnected` -- the reload-overlap window, during
/// which a reconnect of the same `window_id` is a silent reload, not a blip.
pub const RELOAD_GRACE: Duration = Duration::from_secs(5);

/// Total grace from the last socket dropping to the participant going `Gone`
/// (removed; leader auto-promotion fires). Outlasts a reload and a brief
/// network blip without stranding a session on a dead leader. The host-approved
/// "~30s grace".
pub const GONE_GRACE: Duration = Duration::from_secs(30);

/// Maximum stored length of an explicit display-name override, in chars.
pub const NAME_CAP: usize = 64;

/// Unicode 15.0.0 general-category Cf ranges.
const FORMAT_RANGES: &[(u32, u32)] = &[
    (0xAD, 0xAD),
    (0x600, 0x605),
    (0x61C, 0x61C),
    (0x6DD, 0x6DD),
    (0x70F, 0x70F),
    (0x890, 0x891),
    (0x8E2, 0x8E2),
    (0x180E, 0x180E),
    (0x200B, 0x200F),
    (0x202A, 0x202E),
    (0x2060, 0x2064),
    (0x2066, 0x206F),
    (0xFEFF, 0xFEFF),
    (0xFFF9, 0xFFFB),
    (0x110BD, 0x110BD),
    (0x110CD, 0x110CD),
    (0x13430, 0x1343F),
    (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A),
    (0xE0001, 0xE0001),
    (0xE0020, 0xE007F),
];

fn is_format(c: char) -> bool {
    let point = u32::from(c);
    FORMAT_RANGES
        .iter()
        .any(|&(start, end)| (start..=end).contains(&point))
}

/// Validate an explicit client or participant name without silently removing
/// characters. The length applies after trimming; controls are refused even
/// at the edges because a terminal can interpret them when printing a name.
pub(crate) fn validate_name(name: &str) -> Result<&str, RenameError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(RenameError::Empty);
    }
    if trimmed.chars().count() > NAME_CAP {
        return Err(RenameError::TooLong);
    }
    if name.chars().any(char::is_control) {
        return Err(RenameError::Control);
    }
    if name.chars().any(is_format) {
        return Err(RenameError::Format);
    }
    Ok(trimmed)
}

/// A participant's connection lifecycle. `Gone` participants are removed from
/// the registry, so the enum surfaces in snapshots only as `Live` /
/// `Disconnecting` / `Disconnected`; `Gone` is the transition that drops the
/// entry (and is reported once in the reap outcome).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ParticipantState {
    /// At least one live `/ws` socket.
    Live,
    /// No socket, within [`RELOAD_GRACE`] -- treated as a reload in progress.
    Disconnecting,
    /// No socket, past [`RELOAD_GRACE`] but within [`GONE_GRACE`].
    Disconnected,
    /// Past [`GONE_GRACE`]: removed from the registry; if it was the leader,
    /// the slot is reassigned.
    Gone,
}

/// A participant's DISPLAY role, derived from the socket's ORIGIN: a
/// local-origin `/ws` (the loopback bind or an `ssh -L` forward to it) reads
/// `Leader`, a tunnel `/ws` reads `Follower`. This is separate from the single
/// designated-owner slot ([`SessionRegistry::leader`]) that handover routing
/// and the launcher gate consume; a remote holding the fallback owner slot
/// still reads `Follower` here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Leader,
    Follower,
}

/// One participant's public state in the `session_roster` `/ws` frame.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ParticipantInfo {
    pub window_id: String,
    /// The participant's display name: an explicit `cs session self --name`
    /// override, else the gateway identity (`Display Name <email>`), else the
    /// generated default. Always present and non-empty.
    pub name: Option<String>,
    pub role: Role,
    pub status: ParticipantState,
}

/// Gateway-resolved identity for a tunnel participant, mapped by chan-server
/// from the proxy's per-request assertion at the `/ws` join. Loopback
/// participants never traverse the tunnel layer and carry none. Inherits
/// exactly the assertion's trust (PAT-derived HMAC, signed per request).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParticipantIdentity {
    pub display_name: Option<String>,
    pub email: Option<String>,
}

impl ParticipantIdentity {
    /// `Display Name <email>`, degrading to whichever half is present.
    fn display_string(&self) -> Option<String> {
        match (self.display_name.as_deref(), self.email.as_deref()) {
            (Some(name), Some(email)) => Some(format!("{name} <{email}>")),
            (Some(name), None) => Some(name.to_string()),
            (None, Some(email)) => Some(email.to_string()),
            (None, None) => None,
        }
    }
}

/// A point-in-time view of the whole session: every participant plus the
/// current leader's `window_id` (absent only when the session is empty or the
/// leader slot is transiently vacant).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionSnapshot {
    pub participants: Vec<ParticipantInfo>,
    pub leader: Option<String>,
}

/// The participant part of a workspace window's `cs session self` response:
/// its public row, designated-owner status and asserted gateway identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WhoamiInfo {
    pub window_id: String,
    /// The effective display name (rename -> identity -> default); never
    /// empty, so no consumer needs an absent case.
    pub name: String,
    pub role: Role,
    pub status: ParticipantState,
    /// Whether this window holds the designated-owner slot, as opposed to the
    /// origin-derived display `role` (a remote fallback owner reads follower
    /// but leads).
    pub is_leader: bool,
    /// `Display Name <email>` from the gateway assertion; absent for a
    /// loopback participant (or an identity with neither half).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
}

/// An at-most-one in-flight handover request, parked here so the leader's
/// separate `cs session handover --accept/--reject` connection (or the overlay
/// reply route) can resolve the request the requester's blocked CLI is awaiting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingHandover {
    /// The `handover_bus` id the requester's handler is awaiting on.
    pub request_id: String,
    /// The window that asked for the handover (the prospective new leader when
    /// `target` is unset).
    pub requester: String,
    /// The window that becomes leader on accept.
    pub target: String,
    /// The leader being asked -- the only window allowed to accept/reject from
    /// the CLI.
    pub leader: String,
}

struct Participant {
    /// The explicit display-name override (`cs session self --name`); wins
    /// over gateway identity and the generated default.
    name: Option<String>,
    /// Gateway identity, when the join arrived over the tunnel with identity
    /// claims. Fixed at first insert; a reload overlap keeps the original,
    /// like `local`.
    identity: Option<ParticipantIdentity>,
    /// Generated default display name, collision-checked at join and stable
    /// for the participant's lifetime (it survives socket drops via the
    /// grace clock).
    default_name: String,
    /// Whether this window's `/ws` arrived local-origin (no `TunnelOrigin`: the
    /// loopback bind or an `ssh -L` forward to it). Fixed at first insert; a
    /// reload overlap keeps the original, mirroring `disconnected_at`. Drives
    /// the display role and biases the designated-owner election local-first.
    local: bool,
    /// Live `/ws` socket count for this window (reload overlap can exceed 1).
    sockets: usize,
    /// Monotonic join order; the lowest among live participants wins an
    /// auto-promotion.
    join_seq: u64,
    state: ParticipantState,
    /// When the last socket dropped (`sockets == 0`); drives the grace clock.
    disconnected_at: Option<Instant>,
}

impl Participant {
    fn whoami(&self, window_id: &str, leader: Option<&str>, now: Instant) -> WhoamiInfo {
        WhoamiInfo {
            window_id: window_id.to_owned(),
            name: self.effective_name(),
            role: self.role(),
            status: self.computed_state(now),
            is_leader: leader == Some(window_id),
            identity: self.identity.as_ref().and_then(|i| i.display_string()),
        }
    }

    /// The display name `snapshot()` publishes: an explicit rename wins, then
    /// the gateway identity as `Display Name <email>`, then the generated
    /// default. Never empty.
    fn effective_name(&self) -> String {
        if let Some(name) = &self.name {
            return name.clone();
        }
        if let Some(display) = self.identity.as_ref().and_then(|i| i.display_string()) {
            return display;
        }
        self.default_name.clone()
    }

    /// The display role, derived from origin and independent of the single
    /// designated-owner slot: a local window reads Leader, a tunnel window
    /// reads Follower, even the remote holding the fallback owner slot.
    fn role(&self) -> Role {
        if self.local {
            Role::Leader
        } else {
            Role::Follower
        }
    }

    /// The lifecycle state implied by the socket count and the grace clock at
    /// `now`. Live while a socket is held; otherwise stepped by elapsed grace.
    fn computed_state(&self, now: Instant) -> ParticipantState {
        if self.sockets > 0 {
            return ParticipantState::Live;
        }
        let elapsed = self
            .disconnected_at
            .map(|t| now.saturating_duration_since(t))
            .unwrap_or_default();
        if elapsed >= GONE_GRACE {
            ParticipantState::Gone
        } else if elapsed >= RELOAD_GRACE {
            ParticipantState::Disconnected
        } else {
            ParticipantState::Disconnecting
        }
    }
}

#[derive(Default)]
struct Inner {
    /// window_id -> participant.
    participants: HashMap<String, Participant>,
    /// The elected leader's window_id.
    leader: Option<String>,
    /// Monotonic join counter for ordering.
    next_seq: u64,
    /// The single in-flight handover, if any.
    pending: Option<PendingHandover>,
}

/// The per-tenant session registry. One per `AppState`, shared by the `/ws`
/// pump (which drives the socket counts) and the control socket (which reads
/// snapshots and drives handover/takeover).
#[derive(Default)]
pub struct SessionRegistry {
    inner: Mutex<Inner>,
    /// Fired whenever a participant disconnects so the reaper recomputes its
    /// sleep deadline. Runtime-agnostic to fire; only the reaper awaits it.
    reaper_wake: Notify,
    /// The library's aggregate change signal, installed by the host when it
    /// mounts the tenant. A roster or leader change fires it so the window
    /// watch feed re-publishes the per-tenant leaders map. Absent in unit tests
    /// and before install, in which case a change is silent to the feed. This is
    /// the leaders-map analogue of `window_presence`'s connect/disconnect nudge:
    /// it also covers the reaper-driven leader promotion, which happens with no
    /// presence transition to piggyback on.
    change_notify: OnceLock<Arc<Notify>>,
}

/// The outcome of a [`reap_due`](SessionRegistry::reap_due) pass: whether the
/// public snapshot changed (a state stepped, a participant went gone, or the
/// leader was reassigned) and when the next transition is due so the reaper can
/// sleep precisely.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReapOutcome {
    pub changed: bool,
    pub next_deadline: Option<Instant>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Recover from a poisoned lock: every critical section is a small state
    /// mutation that cannot leave the map inconsistent, and presence must never
    /// panic a `/ws` teardown path.
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A `Notify` the reaper task awaits to recompute its sleep when a socket
    /// drops (the only event that arms a new grace deadline).
    pub fn reaper_wake(&self) -> &Notify {
        &self.reaper_wake
    }

    /// Run a short, non-blocking dispatch while `window_id` has at least one
    /// live socket. Holding the presence lock across the dispatch closes the
    /// check-then-send race: the target socket's [`SessionGuard`] cannot drop
    /// between proving exact presence and enqueueing its frame.
    pub fn dispatch_if_live<T>(&self, window_id: &str, dispatch: impl FnOnce() -> T) -> Option<T> {
        let inner = self.lock();
        let live = inner
            .participants
            .get(window_id)
            .is_some_and(|participant| {
                participant.sockets > 0 && participant.state == ParticipantState::Live
            });
        live.then(dispatch)
    }

    /// Install the library's aggregate change signal so a roster/leader change
    /// wakes the window watch feed. Idempotent set-once; the host calls this
    /// once per tenant right after the builder constructs the registry.
    pub fn install_change_notify(&self, notify: Arc<Notify>) {
        let _ = self.change_notify.set(notify);
    }

    /// Wake the window watch feed if a change signal is installed. Fired outside
    /// the registry lock by every mutation that moves the public snapshot.
    fn fire_change(&self) {
        if let Some(notify) = self.change_notify.get() {
            notify.notify_waiters();
        }
    }

    /// Register one live `/ws` socket for `window_id` and return the RAII guard
    /// that releases it. `local` marks a local-origin socket (see [`Role`]); it
    /// is stored on first insert and fixes this window's display role and its
    /// weight in the designated-owner election. `identity` is the gateway
    /// identity of a tunnel socket, also stored on first insert. A socket
    /// arriving for a participant in its grace window re-lives it (a reload)
    /// and keeps the ORIGINAL `local` and `identity`. `changed` reports whether
    /// the public snapshot moved (a new participant, a revived one, or a
    /// re-elected owner) so the caller can broadcast.
    pub fn join(
        self: &Arc<Self>,
        window_id: &str,
        local: bool,
        identity: Option<ParticipantIdentity>,
    ) -> JoinResult {
        let changed = {
            let mut inner = self.lock();
            match inner.participants.get_mut(window_id) {
                Some(p) => {
                    let was_live = p.sockets > 0;
                    p.sockets += 1;
                    p.disconnected_at = None;
                    if !was_live && p.state != ParticipantState::Live {
                        p.state = ParticipantState::Live;
                        true
                    } else {
                        false
                    }
                }
                None => {
                    let seq = inner.next_seq;
                    inner.next_seq += 1;
                    // Draw the generated default against every name in play
                    // (effective names plus overridden defaults), so two
                    // windows never render the same generated name.
                    let taken: HashSet<String> = inner
                        .participants
                        .values()
                        .flat_map(|p| [p.effective_name(), p.default_name.clone()])
                        .collect();
                    let default_name = crate::participant_names::generate_name(&taken);
                    inner.participants.insert(
                        window_id.to_string(),
                        Participant {
                            name: None,
                            identity,
                            default_name,
                            local,
                            sockets: 1,
                            join_seq: seq,
                            state: ParticipantState::Live,
                            disconnected_at: None,
                        },
                    );
                    // Elect the designated owner local-first. Re-elect when the
                    // slot is empty, or when a remote fallback holds it and this
                    // new participant is local: a real local window reclaims
                    // ownership from a remote that only held the slot because no
                    // local was present. A live LOCAL owner is left untouched, so
                    // an explicit takeover/handover among local windows stands.
                    let owner_is_local = inner
                        .leader
                        .as_ref()
                        .and_then(|id| inner.participants.get(id))
                        .is_some_and(|p| p.local);
                    if inner.leader.is_none() || (local && !owner_is_local) {
                        Self::elect_leader(&mut inner);
                    }
                    true
                }
            }
        };
        if changed {
            self.fire_change();
        }
        JoinResult {
            guard: SessionGuard {
                registry: Arc::clone(self),
                window_id: window_id.to_string(),
            },
            changed,
        }
    }

    /// Release one socket for `window_id` (the guard's Drop). When the last
    /// socket drops the participant enters `Disconnecting` and the grace clock
    /// starts at `at`; the reaper is woken to recompute its deadline.
    fn socket_dropped(&self, window_id: &str, at: Instant) {
        let mut armed = false;
        {
            let mut inner = self.lock();
            if let Some(p) = inner.participants.get_mut(window_id) {
                p.sockets = p.sockets.saturating_sub(1);
                if p.sockets == 0 {
                    p.state = ParticipantState::Disconnecting;
                    p.disconnected_at = Some(at);
                    armed = true;
                }
            }
        }
        if armed {
            // The single reaper may still be between its scan and next wait;
            // retain a permit so a last-socket drop in that gap wakes it too.
            self.reaper_wake.notify_one();
        }
    }

    /// Advance every disconnected participant's state by the grace clock at
    /// `now`: step `Disconnecting -> Disconnected -> Gone`, remove gone
    /// participants, and auto-promote the longest-connected live participant
    /// when a gone participant held the leader slot. Idempotent; the reaper
    /// calls it on each wake and `next_deadline` tells it when to wake next.
    pub fn reap_due(&self, now: Instant) -> ReapOutcome {
        let (changed, next_deadline) = {
            let mut inner = self.lock();
            let mut changed = false;

            // Step states and collect the windows that went gone.
            let mut gone: Vec<String> = Vec::new();
            for (window_id, p) in inner.participants.iter_mut() {
                if p.sockets > 0 {
                    continue;
                }
                let next = p.computed_state(now);
                if next != p.state {
                    p.state = next;
                    changed = true;
                }
                if next == ParticipantState::Gone {
                    gone.push(window_id.clone());
                }
            }

            // Remove gone participants and reassign the leader if it left.
            let mut leader_lost = false;
            for window_id in &gone {
                inner.participants.remove(window_id);
                if inner.leader.as_deref() == Some(window_id.as_str()) {
                    inner.leader = None;
                    leader_lost = true;
                }
                // A pending handover whose leader or target vanished is stale.
                if inner
                    .pending
                    .as_ref()
                    .is_some_and(|h| h.leader == *window_id || h.target == *window_id)
                {
                    inner.pending = None;
                }
            }
            if leader_lost {
                Self::elect_leader(&mut inner);
            }

            let next_deadline = Self::soonest_deadline(&inner, now);
            (changed, next_deadline)
        };
        // The reaper-driven leader promotion happens with no presence transition
        // to piggyback on, so wake the library watch here (not only clients'
        // /ws rosters) to refresh the leaders map.
        if changed {
            self.fire_change();
        }
        ReapOutcome {
            changed,
            next_deadline,
        }
    }

    /// The earliest future state transition across disconnected participants,
    /// so the reaper sleeps exactly until the next `reap_due` would do work.
    fn soonest_deadline(inner: &Inner, now: Instant) -> Option<Instant> {
        inner
            .participants
            .values()
            .filter(|p| p.sockets == 0)
            .filter_map(|p| {
                let t = p.disconnected_at?;
                // The next threshold this participant has not crossed yet.
                let elapsed = now.saturating_duration_since(t);
                if elapsed < RELOAD_GRACE {
                    Some(t + RELOAD_GRACE)
                } else if elapsed < GONE_GRACE {
                    Some(t + GONE_GRACE)
                } else {
                    None
                }
            })
            .min()
    }

    /// The designated owner under the local-first rule: the lowest-`join_seq`
    /// live LOCAL participant, or the lowest-`join_seq` live remote when no local
    /// is live. `None` when nobody is live. Origin biases the choice; join order
    /// only breaks ties within the winning locality.
    fn best_owner(participants: &HashMap<String, Participant>) -> Option<String> {
        let lowest_of = |local: bool| {
            participants
                .iter()
                .filter(|(_, p)| p.sockets > 0 && p.local == local)
                .min_by_key(|(_, p)| p.join_seq)
                .map(|(id, _)| id.clone())
        };
        lowest_of(true).or_else(|| lowest_of(false))
    }

    /// Re-elect the designated owner local-first (see [`Self::best_owner`]).
    /// Leaves the slot vacant when none is live.
    fn elect_leader(inner: &mut Inner) {
        inner.leader = Self::best_owner(&inner.participants);
    }

    /// Set a participant's explicit display name. The trimmed name must have
    /// 1 to [`NAME_CAP`] characters, contain no Unicode Cc or Cf characters,
    /// and differ ignoring case from every other participant's name. A refusal
    /// preserves the override; [`Self::reset_name`] restores its default.
    pub fn rename(&self, window_id: &str, name: &str) -> Result<String, RenameError> {
        self.rename_validated_with(window_id, Some(validate_name(name)?), || ())
            .map(|(_, participant)| participant.name)
    }

    /// Clear a participant's explicit override (`cs session self --reset`) so
    /// it falls back to its gateway identity or its generated default. Returns
    /// the effective default name. A generated default must differ ignoring
    /// case from the other participants' names; gateway identities may be
    /// shared by one person's windows.
    pub fn reset_name(&self, window_id: &str) -> Result<String, RenameError> {
        self.rename_validated_with(window_id, None, || ())
            .map(|(_, participant)| participant.name)
    }

    /// Apply a validated name and an infallible companion update only after
    /// checking the participant and its name under the same lock.
    pub(crate) fn rename_validated_with<T>(
        &self,
        window_id: &str,
        name: Option<&str>,
        update: impl FnOnce() -> T,
    ) -> Result<(T, WhoamiInfo), RenameError> {
        let result = {
            let mut inner = self.lock();
            let participant = inner
                .participants
                .get(window_id)
                .ok_or(RenameError::NotAParticipant)?;
            let checked_name = name.or_else(|| {
                participant
                    .identity
                    .as_ref()
                    .and_then(ParticipantIdentity::display_string)
                    .is_none()
                    .then_some(participant.default_name.as_str())
            });
            if let Some(checked_name) = checked_name {
                let folded = comparison_key(checked_name);
                if let Some((other, _)) = inner.participants.iter().find(|(id, p)| {
                    id.as_str() != window_id && comparison_key(&p.effective_name()) == folded
                }) {
                    return Err(RenameError::Clash {
                        window_id: other.clone(),
                    });
                }
            }
            let leader = inner.leader.clone();
            let p = inner
                .participants
                .get_mut(window_id)
                .expect("participant checked under the same lock");
            p.name = name.map(str::to_owned);
            (
                update(),
                p.whoami(window_id, leader.as_deref(), Instant::now()),
            )
        };
        self.fire_change();
        Ok(result)
    }

    /// The current leader's window_id, if any.
    pub fn leader(&self) -> Option<String> {
        self.lock().leader.clone()
    }

    /// A public snapshot of every participant plus the leader, ordered by join
    /// sequence. `now` resolves each participant's grace-clock state.
    pub fn snapshot(&self, now: Instant) -> SessionSnapshot {
        let inner = self.lock();
        let leader = inner.leader.clone();
        let mut rows: Vec<(u64, ParticipantInfo)> = inner
            .participants
            .iter()
            .map(|(window_id, p)| {
                let role = p.role();
                (
                    p.join_seq,
                    ParticipantInfo {
                        window_id: window_id.clone(),
                        name: Some(p.effective_name()),
                        role,
                        status: p.computed_state(now),
                    },
                )
            })
            .collect();
        rows.sort_by_key(|(seq, _)| *seq);
        SessionSnapshot {
            participants: rows.into_iter().map(|(_, info)| info).collect(),
            leader,
        }
    }

    /// The calling window's participant record, or `None` when it is not a
    /// participant. `now` resolves the grace-clock state, like [`Self::snapshot`].
    pub fn whoami(&self, window_id: &str, now: Instant) -> Option<WhoamiInfo> {
        let inner = self.lock();
        let p = inner.participants.get(window_id)?;
        Some(p.whoami(window_id, inner.leader.as_deref(), now))
    }

    /// Park a handover request from `requester` (becoming leader as `target`,
    /// defaulting to the requester). Errors when the requester is not a
    /// participant, there is no live leader to ask, the requester already leads,
    /// or another handover is already pending. On success returns the leader's
    /// window_id (the prompt recipient).
    pub fn request_handover(
        &self,
        request_id: &str,
        requester: &str,
        target: Option<&str>,
    ) -> Result<String, HandoverError> {
        let mut inner = self.lock();
        if inner.pending.is_some() {
            return Err(HandoverError::AlreadyPending);
        }
        if !inner.participants.contains_key(requester) {
            return Err(HandoverError::NotAParticipant);
        }
        let target = target.unwrap_or(requester).to_string();
        if !inner.participants.contains_key(&target) {
            return Err(HandoverError::UnknownTarget);
        }
        let leader = inner.leader.clone().ok_or(HandoverError::NoLeader)?;
        if leader == target {
            return Err(HandoverError::AlreadyLeader);
        }
        // The leader must be live to consent; a non-live leader is taken over,
        // not handed over.
        let leader_live = inner
            .participants
            .get(&leader)
            .is_some_and(|p| p.sockets > 0);
        if !leader_live {
            return Err(HandoverError::LeaderNotLive);
        }
        inner.pending = Some(PendingHandover {
            request_id: request_id.to_string(),
            requester: requester.to_string(),
            target,
            leader: leader.clone(),
        });
        Ok(leader)
    }

    /// The pending handover this `leader` may answer, for the CLI
    /// accept/reject path (which has no request id of its own).
    pub fn pending_for_leader(&self, leader: &str) -> Option<PendingHandover> {
        self.lock()
            .pending
            .as_ref()
            .filter(|h| h.leader == leader)
            .cloned()
    }

    /// Resolve the pending handover identified by `request_id`: on `accept`
    /// promote the target to leader; either way clear the pending slot. Returns
    /// the new leader on a leadership change (so the caller can broadcast), or
    /// `None` when the id no longer matches (already resolved / stale).
    pub fn resolve_handover(&self, request_id: &str, accept: bool) -> Option<HandoverResolved> {
        let resolved = {
            let mut inner = self.lock();
            let matches = inner
                .pending
                .as_ref()
                .is_some_and(|h| h.request_id == request_id);
            if !matches {
                return None;
            }
            let pending = inner.pending.take().expect("matched just above");
            if accept && inner.participants.contains_key(&pending.target) {
                inner.leader = Some(pending.target.clone());
                HandoverResolved {
                    accepted: true,
                    new_leader: Some(pending.target),
                }
            } else {
                HandoverResolved {
                    accepted: accept,
                    new_leader: None,
                }
            }
        };
        // Only an accepted handover moves the leader, so refresh the leaders map
        // then; a reject leaves it unchanged.
        if resolved.new_leader.is_some() {
            self.fire_change();
        }
        Some(resolved)
    }

    /// Drop the pending handover identified by `request_id` without resolving
    /// it (the requester's handler timed out or disconnected). No-op when the id
    /// no longer matches.
    pub fn cancel_handover(&self, request_id: &str) {
        let mut inner = self.lock();
        if inner
            .pending
            .as_ref()
            .is_some_and(|h| h.request_id == request_id)
        {
            inner.pending = None;
        }
    }

    /// Take leadership for `caller`. Plain takeover (`force == false`) succeeds
    /// only when there is no live leader (none elected, or the leader's sockets
    /// are gone); `force` seizes even a live leader. The caller must be a
    /// participant. Returns whether leadership actually moved.
    pub fn takeover(&self, caller: &str, force: bool) -> Result<bool, HandoverError> {
        {
            let mut inner = self.lock();
            if !inner.participants.contains_key(caller) {
                return Err(HandoverError::NotAParticipant);
            }
            if inner.leader.as_deref() == Some(caller) {
                return Ok(false);
            }
            let leader_live = inner
                .leader
                .as_ref()
                .and_then(|l| inner.participants.get(l))
                .is_some_and(|p| p.sockets > 0);
            if leader_live && !force {
                return Err(HandoverError::LeaderLive);
            }
            inner.leader = Some(caller.to_string());
            // A seized handover no longer applies.
            inner.pending = None;
        }
        // Leadership moved; refresh the leaders map.
        self.fire_change();
        Ok(true)
    }
}

/// The new-leader result of resolving a handover.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandoverResolved {
    pub accepted: bool,
    pub new_leader: Option<String>,
}

/// Why a rename was refused, with a display sentence for the caller.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RenameError {
    /// The trimmed name is empty.
    #[error("session name must not be empty")]
    Empty,
    /// The trimmed name exceeds the character limit.
    #[error("session name must have at most 64 characters")]
    TooLong,
    /// A Unicode control character appears in the supplied name.
    #[error("session name must not contain control characters (Unicode Cc)")]
    Control,
    /// A Unicode format character appears in the supplied name.
    #[error("session name must not contain format characters (Unicode Cf)")]
    Format,
    /// Another participant holds the name, compared ignoring case.
    #[error("session name is already held by participant window {window_id}")]
    Clash { window_id: String },
    /// The calling window is not a session participant.
    #[error("this window is not a session participant")]
    NotAParticipant,
}

/// Why a handover/takeover request could not be parked or applied. The control
/// handler maps each to a clear CLI message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandoverError {
    /// The calling window is not a session participant.
    NotAParticipant,
    /// No leader is currently elected.
    NoLeader,
    /// The requested target window is not a participant.
    UnknownTarget,
    /// The requester (or target) already leads.
    AlreadyLeader,
    /// Another handover is already in flight.
    AlreadyPending,
    /// The leader has no live socket, so it cannot consent (use takeover).
    LeaderNotLive,
    /// Plain takeover refused because the leader is live (needs `--force`).
    LeaderLive,
}

/// The result of [`SessionRegistry::join`]: the RAII guard plus whether the
/// public snapshot changed (so the caller can decide to broadcast).
pub struct JoinResult {
    pub guard: SessionGuard,
    pub changed: bool,
}

/// RAII handle for one `/ws` socket's participation. Dropping it releases the
/// socket; the last drop arms the grace clock. Held by the `/ws` pump for the
/// socket's lifetime, so every exit path (clean close, network drop, shutdown)
/// releases without bookkeeping at the call site.
pub struct SessionGuard {
    registry: Arc<SessionRegistry>,
    window_id: String,
}

impl SessionGuard {
    /// The window this guard's socket belongs to.
    pub fn window_id(&self) -> &str {
        &self.window_id
    }
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        self.registry
            .socket_dropped(&self.window_id, Instant::now());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn naming_repair_caseless_participant_clash_preserves_spelling() {
        let registry = Arc::new(SessionRegistry::new());
        let _a = registry.join("a", true, None).guard;
        let _b = registry.join("b", true, None).guard;
        registry.rename("a", "Sam").unwrap();
        registry.rename("b", "before").unwrap();
        assert_eq!(
            registry.rename("b", "\u{17f}am"),
            Err(RenameError::Clash {
                window_id: "a".into()
            })
        );
        assert_eq!(registry.whoami("a", Instant::now()).unwrap().name, "Sam");
        assert_eq!(registry.whoami("b", Instant::now()).unwrap().name, "before");
    }

    fn status_of(reg: &SessionRegistry, now: Instant, window_id: &str) -> Option<ParticipantState> {
        reg.snapshot(now)
            .participants
            .into_iter()
            .find(|p| p.window_id == window_id)
            .map(|p| p.status)
    }

    #[test]
    fn local_owns_the_slot_and_remote_follows() {
        let reg = Arc::new(SessionRegistry::new());
        let a = reg.join("w-a", true, None); // local origin
        assert!(a.changed);
        assert_eq!(reg.leader().as_deref(), Some("w-a"));

        let b = reg.join("w-b", false, None); // tunnel origin
        assert!(b.changed);
        // A remote joining does not move the designated-owner slot off the local.
        assert_eq!(reg.leader().as_deref(), Some("w-a"));

        let now = Instant::now();
        let snap = reg.snapshot(now);
        assert_eq!(snap.participants.len(), 2);
        assert_eq!(snap.participants[0].window_id, "w-a");
        // Role is origin-derived: the local reads Leader, the remote Follower.
        assert_eq!(snap.participants[0].role, Role::Leader);
        assert_eq!(snap.participants[1].role, Role::Follower);
    }

    #[test]
    fn dispatch_if_live_runs_only_while_the_exact_window_has_a_socket() {
        let reg = Arc::new(SessionRegistry::new());
        let other = reg.join("w-other", true, None).guard;
        let mut calls = 0;

        assert_eq!(reg.dispatch_if_live("w-target", || calls += 1), None);
        assert_eq!(calls, 0, "another live window is not sufficient");

        let target = reg.join("w-target", true, None).guard;
        assert_eq!(reg.dispatch_if_live("w-target", || calls += 1), Some(()));
        assert_eq!(calls, 1);

        drop(target);
        assert_eq!(reg.dispatch_if_live("w-target", || calls += 1), None);
        assert_eq!(calls, 1, "a dropped target cannot dispatch during grace");
        drop(other);
    }

    #[test]
    fn role_is_origin_derived_regardless_of_join_order() {
        // A remote joins FIRST, a local second: role tracks ORIGIN, not join
        // order, so the later local still reads Leader and the earlier remote
        // Follower.
        let reg = Arc::new(SessionRegistry::new());
        let _remote = reg.join("w-remote", false, None).guard;
        let _local = reg.join("w-local", true, None).guard;
        let snap = reg.snapshot(Instant::now());
        let role_of = |id: &str| {
            snap.participants
                .iter()
                .find(|p| p.window_id == id)
                .map(|p| p.role)
        };
        assert_eq!(role_of("w-remote"), Some(Role::Follower));
        assert_eq!(role_of("w-local"), Some(Role::Leader));
    }

    #[test]
    fn local_is_elected_owner_over_an_earlier_join_remote() {
        // A remote connects first and holds the fallback owner slot; when a
        // local window joins it RECLAIMS the slot even though it joined later.
        let reg = Arc::new(SessionRegistry::new());
        let _remote = reg.join("w-remote", false, None).guard;
        assert_eq!(reg.leader().as_deref(), Some("w-remote"));
        let _local = reg.join("w-local", true, None).guard;
        assert_eq!(reg.leader().as_deref(), Some("w-local"));
    }

    #[test]
    fn remote_only_session_falls_back_to_the_first_remote() {
        // No local present: the lowest-join remote is the fallback owner so a
        // real remote-only devserver still has a working owner and handover
        // target -- but every remote still reads Follower for display.
        let reg = Arc::new(SessionRegistry::new());
        let _r1 = reg.join("w-r1", false, None).guard;
        let _r2 = reg.join("w-r2", false, None).guard;
        assert_eq!(reg.leader().as_deref(), Some("w-r1"));
        let snap = reg.snapshot(Instant::now());
        assert!(
            snap.participants.iter().all(|p| p.role == Role::Follower),
            "a remote fallback owner still displays as Follower"
        );
    }

    #[test]
    fn reload_overlap_keeps_the_participant_live() {
        let reg = Arc::new(SessionRegistry::new());
        let g1 = reg.join("w-a", true, None).guard; // local origin
                                                    // A second socket for the same window (the reload overlap) reports no
                                                    // snapshot change and keeps it live after the first guard drops. Even
                                                    // when the reconnect is marked remote it keeps the ORIGINAL local flag,
                                                    // so the role stays Leader (mirrors how it keeps disconnected_at = None).
        let g2 = reg.join("w-a", false, None);
        assert!(!g2.changed);
        drop(g1);
        let now = Instant::now();
        assert_eq!(status_of(&reg, now, "w-a"), Some(ParticipantState::Live));
        let role = reg
            .snapshot(now)
            .participants
            .into_iter()
            .find(|p| p.window_id == "w-a")
            .map(|p| p.role);
        assert_eq!(
            role,
            Some(Role::Leader),
            "reload keeps the original local flag"
        );
        drop(g2.guard);
    }

    #[test]
    fn lifecycle_steps_disconnecting_then_disconnected_then_gone() {
        let reg = Arc::new(SessionRegistry::new());
        let t0 = Instant::now();
        let guard = reg.join("w-a", true, None).guard;
        let _follower = reg.join("w-b", true, None).guard; // keep the session non-empty
        drop(guard); // last socket of w-a drops at ~t0

        // Immediately: Disconnecting.
        assert_eq!(
            status_of(&reg, t0, "w-a"),
            Some(ParticipantState::Disconnecting)
        );
        // Past the reload grace: Disconnected.
        let mid = t0 + RELOAD_GRACE + Duration::from_secs(1);
        let out = reg.reap_due(mid);
        assert!(out.changed);
        assert_eq!(
            status_of(&reg, mid, "w-a"),
            Some(ParticipantState::Disconnected)
        );
        // Past the gone grace: removed.
        let later = t0 + GONE_GRACE + Duration::from_secs(1);
        let out = reg.reap_due(later);
        assert!(out.changed);
        assert_eq!(status_of(&reg, later, "w-a"), None);
    }

    #[test]
    fn leader_gone_auto_promotes_longest_connected_live() {
        let reg = Arc::new(SessionRegistry::new());
        let t0 = Instant::now();
        let leader = reg.join("w-a", true, None).guard;
        let _b = reg.join("w-b", true, None).guard; // join_seq 1, live
        let _c = reg.join("w-c", true, None).guard; // join_seq 2, live
        assert_eq!(reg.leader().as_deref(), Some("w-a"));

        drop(leader);
        let later = t0 + GONE_GRACE + Duration::from_secs(1);
        let out = reg.reap_due(later);
        assert!(out.changed);
        // The longest-connected remaining live participant (lowest join_seq) wins.
        assert_eq!(reg.leader().as_deref(), Some("w-b"));
    }

    #[test]
    fn leader_vacant_when_no_live_participant_remains() {
        let reg = Arc::new(SessionRegistry::new());
        let t0 = Instant::now();
        let only = reg.join("w-a", true, None).guard;
        drop(only);
        let later = t0 + GONE_GRACE + Duration::from_secs(1);
        reg.reap_due(later);
        assert_eq!(reg.leader(), None);
    }

    #[tokio::test]
    async fn reaper_wake_retains_a_drop_before_waiting() {
        let reg = Arc::new(SessionRegistry::new());
        let guard = reg.join("w-a", true, None).guard;
        assert_eq!(reg.reap_due(Instant::now()).next_deadline, None);
        drop(guard);

        let notify = reg.reaper_wake();
        let mut notified = std::pin::pin!(notify.notified());
        let ready = std::future::poll_fn(|cx| {
            std::task::Poll::Ready(std::future::Future::poll(notified.as_mut(), cx).is_ready())
        })
        .await;
        assert!(
            ready,
            "the last socket drop must leave a reaper wake permit"
        );
    }

    #[test]
    fn next_deadline_tracks_the_soonest_transition() {
        let reg = Arc::new(SessionRegistry::new());
        let t0 = Instant::now();
        let g = reg.join("w-a", true, None).guard;
        let _keep = reg.join("w-b", true, None).guard;
        drop(g);
        // The disconnect stamp lands at drop time, so bound the deadline
        // with an instant taken AFTER the drop: joins + drop can take
        // arbitrarily long under load, and a fixed allowance from t0
        // flakes.
        let after_drop = Instant::now();
        // Before the reload grace, the next transition is the reload threshold.
        let out = reg.reap_due(t0);
        let deadline = out.next_deadline.expect("a disconnected participant");
        assert!(deadline <= after_drop + RELOAD_GRACE);
    }

    #[test]
    fn rename_trims_and_refuses_invalid_names() {
        let reg = Arc::new(SessionRegistry::new());
        let _g = reg.join("w-a", true, None).guard;
        assert_eq!(reg.rename("w-a", "  Alex  "), Ok("Alex".to_string()));
        let now = Instant::now();
        assert_eq!(
            reg.snapshot(now).participants[0].name.as_deref(),
            Some("Alex")
        );
        // Empty or whitespace-only is rejected, not a silent clear.
        assert_eq!(reg.rename("w-a", "   "), Err(RenameError::Empty));
        assert_eq!(
            reg.snapshot(Instant::now()).participants[0].name.as_deref(),
            Some("Alex"),
            "a rejected rename leaves the override in place"
        );
        for invalid in [
            "x".repeat(NAME_CAP + 1),
            "a\x1b]0;title\x07b\r\n".into(),
            "A\u{200b}".into(),
            "A\u{202e}".into(),
        ] {
            assert!(reg.rename("w-a", &invalid).is_err(), "{invalid:?}");
            assert_eq!(reg.whoami("w-a", Instant::now()).unwrap().name, "Alex");
        }
        // Unknown window does not match.
        assert_eq!(reg.rename("w-nope", "x"), Err(RenameError::NotAParticipant));
        assert_eq!(reg.reset_name("w-nope"), Err(RenameError::NotAParticipant));
    }

    #[test]
    fn format_category_range_boundaries_and_named_characters_are_refused() {
        // Boundary fixtures come from Unicode 15.0.0 category data, independent
        // of the production lookup so dropping a range also fails this test.
        let boundaries = [
            (0xAD, 0xAD),
            (0x600, 0x605),
            (0x61C, 0x61C),
            (0x6DD, 0x6DD),
            (0x70F, 0x70F),
            (0x890, 0x891),
            (0x8E2, 0x8E2),
            (0x180E, 0x180E),
            (0x200B, 0x200F),
            (0x202A, 0x202E),
            (0x2060, 0x2064),
            (0x2066, 0x206F),
            (0xFEFF, 0xFEFF),
            (0xFFF9, 0xFFFB),
            (0x110BD, 0x110BD),
            (0x110CD, 0x110CD),
            (0x13430, 0x1343F),
            (0x1BCA0, 0x1BCA3),
            (0x1D173, 0x1D17A),
            (0xE0001, 0xE0001),
            (0xE0020, 0xE007F),
        ];
        for (start, end) in boundaries {
            for point in [start, end] {
                let name = format!("A{}B", char::from_u32(point).unwrap());
                assert_eq!(
                    validate_name(&name),
                    Err(RenameError::Format),
                    "U+{point:X}"
                );
            }
            for point in [start - 1, end + 1] {
                let name = format!("A{}B", char::from_u32(point).unwrap());
                assert_eq!(validate_name(&name), Ok(name.as_str()), "U+{point:X}");
            }
        }
        for point in [0xAD, 0x200B, 0x202E, 0x2066, 0xFEFF, 0xE0001] {
            assert_eq!(
                validate_name(&format!("A{}", char::from_u32(point).unwrap())),
                Err(RenameError::Format)
            );
        }
        assert!(FORMAT_RANGES.windows(2).all(|pair| pair[0].1 < pair[1].0));
    }

    #[test]
    fn explicit_name_refuses_empty() {
        assert_eq!(validate_name("   "), Err(RenameError::Empty));
    }

    #[test]
    fn explicit_name_refuses_more_than_64_characters() {
        assert_eq!(validate_name(&"x".repeat(65)), Err(RenameError::TooLong));
        assert_eq!(
            validate_name(&"\u{e9}".repeat(65)),
            Err(RenameError::TooLong)
        );
    }

    #[test]
    fn explicit_name_refuses_controls_even_at_trimmed_edges() {
        assert_eq!(validate_name("Alice\u{85}"), Err(RenameError::Control));
        assert_eq!(validate_name("Ali\u{1b}ce"), Err(RenameError::Control));
    }

    #[test]
    fn explicit_name_refuses_format_characters() {
        assert_eq!(validate_name("Ali\u{200b}ce"), Err(RenameError::Format));
        assert_eq!(validate_name("Ali\u{202e}ce"), Err(RenameError::Format));
    }

    #[test]
    fn rename_refuses_another_participants_name_case_insensitively() {
        let reg = Arc::new(SessionRegistry::new());
        let _a = reg.join("w-a", true, None).guard;
        let b = reg.join("w-b", false, None).guard;
        reg.rename("w-b", "\u{c9}lodie").unwrap();
        reg.rename("w-b", "\u{e9}LODIE").unwrap();
        drop(b);
        let before = reg.whoami("w-a", Instant::now()).unwrap();
        assert_eq!(
            reg.rename("w-a", "\u{c9}lodie"),
            Err(RenameError::Clash {
                window_id: "w-b".into()
            })
        );
        assert_eq!(reg.whoami("w-a", Instant::now()).unwrap(), before);
        assert_eq!(
            reg.rename("w-a", &"\u{e9}".repeat(64))
                .unwrap()
                .chars()
                .count(),
            64
        );
    }

    #[test]
    fn name_precedence_is_rename_then_identity_then_default() {
        let reg = Arc::new(SessionRegistry::new());
        let identity = ParticipantIdentity {
            display_name: Some("Ada Lovelace".to_string()),
            email: Some("ada@example.com".to_string()),
        };
        let _g = reg.join("w-a", false, Some(identity)).guard;

        // No override: the gateway identity renders as `Display Name <email>`.
        let name_of = |reg: &SessionRegistry| {
            reg.snapshot(Instant::now()).participants[0]
                .name
                .clone()
                .expect("name is never absent")
        };
        assert_eq!(name_of(&reg), "Ada Lovelace <ada@example.com>");

        // An explicit rename wins over the identity.
        reg.rename("w-a", "ops").expect("accepted");
        assert_eq!(name_of(&reg), "ops");

        // Reset falls back to the identity, not the generated default.
        assert_eq!(
            reg.reset_name("w-a"),
            Ok("Ada Lovelace <ada@example.com>".to_string())
        );
        assert_eq!(name_of(&reg), "Ada Lovelace <ada@example.com>");
    }

    #[test]
    fn whoami_reports_role_status_owner_slot_and_identity() {
        let reg = Arc::new(SessionRegistry::new());
        let _a = reg.join("w-a", true, None).guard;
        let identity = ParticipantIdentity {
            display_name: Some("Ada Lovelace".to_string()),
            email: Some("ada@example.com".to_string()),
        };
        let _b = reg.join("w-b", false, Some(identity)).guard;

        let now = Instant::now();
        let a = reg.whoami("w-a", now).expect("participant");
        assert_eq!(a.window_id, "w-a");
        assert_eq!(a.role, Role::Leader);
        assert_eq!(a.status, ParticipantState::Live);
        assert!(a.is_leader, "the local window holds the owner slot");
        assert_eq!(a.identity, None, "loopback joins carry no identity");

        let b = reg.whoami("w-b", now).expect("participant");
        assert_eq!(b.role, Role::Follower);
        assert!(!b.is_leader);
        assert_eq!(
            b.identity.as_deref(),
            Some("Ada Lovelace <ada@example.com>")
        );
        assert_eq!(b.name, "Ada Lovelace <ada@example.com>");

        assert_eq!(reg.whoami("w-ghost", now), None);
    }

    #[test]
    fn whoami_name_follows_precedence_but_identity_stays() {
        let reg = Arc::new(SessionRegistry::new());
        let identity = ParticipantIdentity {
            display_name: Some("Ada Lovelace".to_string()),
            email: Some("ada@example.com".to_string()),
        };
        let _g = reg.join("w-a", false, Some(identity)).guard;

        // A rename changes the effective name but the identity row keeps
        // reporting the gateway assertion.
        reg.rename("w-a", "ops").expect("accepted");
        let me = reg.whoami("w-a", Instant::now()).expect("participant");
        assert_eq!(me.name, "ops");
        assert_eq!(
            me.identity.as_deref(),
            Some("Ada Lovelace <ada@example.com>")
        );

        // Reset: the name falls back to the identity string.
        reg.reset_name("w-a").expect("accepted");
        let me = reg.whoami("w-a", Instant::now()).expect("participant");
        assert_eq!(me.name, "Ada Lovelace <ada@example.com>");
    }

    #[test]
    fn identity_halves_degrade_gracefully() {
        let reg = Arc::new(SessionRegistry::new());
        let name_only = ParticipantIdentity {
            display_name: Some("Ada".to_string()),
            email: None,
        };
        let email_only = ParticipantIdentity {
            display_name: None,
            email: Some("ada@example.com".to_string()),
        };
        let _a = reg.join("w-name", false, Some(name_only)).guard;
        let _b = reg.join("w-email", false, Some(email_only)).guard;
        let snap = reg.snapshot(Instant::now());
        let name_of = |id: &str| {
            snap.participants
                .iter()
                .find(|p| p.window_id == id)
                .and_then(|p| p.name.clone())
                .expect("name is never absent")
        };
        assert_eq!(name_of("w-name"), "Ada");
        assert_eq!(name_of("w-email"), "ada@example.com");
    }

    #[test]
    fn default_names_are_generated_unique_and_reload_stable() {
        let reg = Arc::new(SessionRegistry::new());
        let g1 = reg.join("w-a", true, None).guard;
        let _g2 = reg.join("w-b", true, None).guard;
        let snap = reg.snapshot(Instant::now());
        let names: Vec<String> = snap
            .participants
            .iter()
            .map(|p| p.name.clone().expect("name is never absent"))
            .collect();
        assert!(names.iter().all(|n| !n.trim().is_empty()));
        assert_ne!(names[0], names[1], "two windows never share a default");

        // A reload (socket overlap) keeps the participant and its default.
        let before = names[0].clone();
        let g1b = reg.join("w-a", true, None);
        assert!(!g1b.changed);
        drop(g1);
        let after = reg
            .snapshot(Instant::now())
            .participants
            .iter()
            .find(|p| p.window_id == "w-a")
            .and_then(|p| p.name.clone())
            .expect("still present");
        assert_eq!(before, after, "reload keeps the generated default");
        drop(g1b.guard);
    }

    #[test]
    fn handover_request_then_accept_moves_leadership() {
        let reg = Arc::new(SessionRegistry::new());
        let _leader = reg.join("w-a", true, None).guard;
        let _follower = reg.join("w-b", true, None).guard;
        let id = "handover-1".to_string();
        // w-b asks to become leader; the prompt goes to the live leader w-a.
        let recipient = reg
            .request_handover(&id, "w-b", None)
            .expect("request parked");
        assert_eq!(recipient, "w-a");
        // The leader can find the pending request from its own connection.
        assert_eq!(
            reg.pending_for_leader("w-a").map(|h| h.request_id),
            Some(id.clone())
        );
        let resolved = reg.resolve_handover(&id, true).expect("resolved");
        assert!(resolved.accepted);
        assert_eq!(resolved.new_leader.as_deref(), Some("w-b"));
        assert_eq!(reg.leader().as_deref(), Some("w-b"));
        // The pending slot is cleared.
        assert_eq!(reg.pending_for_leader("w-b"), None);
    }

    #[test]
    fn handover_reject_keeps_leadership_and_clears_pending() {
        let reg = Arc::new(SessionRegistry::new());
        let _leader = reg.join("w-a", true, None).guard;
        let _follower = reg.join("w-b", true, None).guard;
        let id = "handover-1".to_string();
        reg.request_handover(&id, "w-b", None).expect("parked");
        let resolved = reg.resolve_handover(&id, false).expect("resolved");
        assert!(!resolved.accepted);
        assert_eq!(reg.leader().as_deref(), Some("w-a"));
        assert!(reg.pending_for_leader("w-a").is_none());
    }

    #[test]
    fn handover_rejects_second_request_while_pending() {
        let reg = Arc::new(SessionRegistry::new());
        let _leader = reg.join("w-a", true, None).guard;
        let _b = reg.join("w-b", true, None).guard;
        let _c = reg.join("w-c", true, None).guard;
        let id = "handover-1".to_string();
        reg.request_handover(&id, "w-b", None).expect("parked");
        let id2 = "handover-2".to_string();
        assert_eq!(
            reg.request_handover(&id2, "w-c", None),
            Err(HandoverError::AlreadyPending)
        );
    }

    #[test]
    fn handover_to_a_non_live_leader_is_refused() {
        let reg = Arc::new(SessionRegistry::new());
        let t0 = Instant::now();
        let leader = reg.join("w-a", true, None).guard;
        let _b = reg.join("w-b", true, None).guard;
        drop(leader);
        reg.reap_due(t0 + RELOAD_GRACE + Duration::from_secs(1)); // leader Disconnected
        let id = "handover-1".to_string();
        assert_eq!(
            reg.request_handover(&id, "w-b", None),
            Err(HandoverError::LeaderNotLive)
        );
    }

    #[test]
    fn plain_takeover_only_when_leader_not_live() {
        let reg = Arc::new(SessionRegistry::new());
        let t0 = Instant::now();
        let leader = reg.join("w-a", true, None).guard;
        let _b = reg.join("w-b", true, None).guard;
        // Live leader: plain takeover refused.
        assert_eq!(reg.takeover("w-b", false), Err(HandoverError::LeaderLive));
        // Leader drops and ages out of live: plain takeover succeeds.
        drop(leader);
        reg.reap_due(t0 + RELOAD_GRACE + Duration::from_secs(1));
        assert_eq!(reg.takeover("w-b", false), Ok(true));
        assert_eq!(reg.leader().as_deref(), Some("w-b"));
    }

    #[test]
    fn force_takeover_seizes_a_live_leader() {
        let reg = Arc::new(SessionRegistry::new());
        let _leader = reg.join("w-a", true, None).guard;
        let _b = reg.join("w-b", true, None).guard;
        assert_eq!(reg.takeover("w-b", true), Ok(true));
        assert_eq!(reg.leader().as_deref(), Some("w-b"));
        // Taking over when you already lead is a no-op, not an error.
        assert_eq!(reg.takeover("w-b", false), Ok(false));
    }

    #[test]
    fn takeover_by_non_participant_errors() {
        let reg = Arc::new(SessionRegistry::new());
        let _leader = reg.join("w-a", true, None).guard;
        assert_eq!(
            reg.takeover("w-ghost", true),
            Err(HandoverError::NotAParticipant)
        );
    }

    // The reaper-driven leader promotion happens with no presence transition to
    // piggyback on, so it must fire the installed change signal itself, or the
    // window watch feed's leaders map would go stale until an unrelated change.
    #[tokio::test]
    async fn install_change_notify_fires_on_reaper_leader_promotion() {
        let reg = Arc::new(SessionRegistry::new());
        let notify = Arc::new(Notify::new());
        reg.install_change_notify(notify.clone());

        let t0 = Instant::now();
        let leader = reg.join("w-a", true, None).guard; // leader, join_seq 0
        let _b = reg.join("w-b", true, None).guard; // live follower, promotes next
        drop(leader); // the leader's last socket drops at ~t0

        // Arm the waiter AFTER the join fires so it only wakes on the reap; a
        // yield parks it before we reap (current-thread runtime is deterministic).
        let waiter = tokio::spawn(async move { notify.notified().await });
        tokio::task::yield_now().await;

        let later = t0 + GONE_GRACE + Duration::from_secs(1);
        let out = reg.reap_due(later);
        assert!(out.changed);
        assert_eq!(
            reg.leader().as_deref(),
            Some("w-b"),
            "promoted to the live follower"
        );
        tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("reaper promotion fired the change signal")
            .expect("waiter task ok");
    }
}
