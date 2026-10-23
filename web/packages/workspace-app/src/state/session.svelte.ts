// Session presence (leader / followers) + the handover-request prompt.
//
// The server keeps a per-tenant participant registry: the first /ws client
// leads, and handover/takeover act on those participants. `cs session list`
// lists clients across the library; `cs session self --name` names the client
// and this window's participant together. The server pushes a `session_roster`
// /ws frame on every participant change. store.svelte.ts routes that frame to
// applySessionRoster. A `cs session handover` request reaches the leader's
// window as a `handover_prompt` window command; showHandover raises the prompt
// and accept/reject POSTs to /api/session/handover/reply, which fires the
// parked oneshot and unblocks the requester's blocked CLI.
//
// Like the survey overlay, EVERY exit (Accept / Reject / Escape / close) is a
// real reply, so a stray close can never hang the waiting CLI. Nothing here is
// persisted: a live handover is a blocking request, so a reload resolves it
// server-side as a timeout rather than leaving a stale card.

import { api, sessionWindowId, type SessionHandoverReplyRequest } from "../api/client";
import { notify } from "./notify.svelte";

export type ParticipantRole = "leader" | "follower";
export type ParticipantStatus = "live" | "disconnecting" | "disconnected" | "gone";

/// One session participant, mirroring the server's ParticipantInfo row in
/// the `session_roster` frame for this workspace window.
export interface SessionParticipant {
  window_id: string;
  name: string | null;
  role: ParticipantRole;
  status: ParticipantStatus;
}

/// The pending handover prompt shown on THIS (leader) window, plus its reply
/// guard so a double-click cannot fire two answers for one oneshot.
interface HandoverPrompt {
  requestId: string;
  fromWindowId: string;
  fromName: string | null;
  busy: boolean;
}

export const sessionState = $state<{
  participants: SessionParticipant[];
  leader: string | null;
  handover: HandoverPrompt | null;
}>({ participants: [], leader: null, handover: null });

/// Apply a `session_roster` /ws snapshot (a full snapshot, applied wholesale).
export function applySessionRoster(snapshot: {
  participants?: SessionParticipant[];
  leader?: string | null;
}): void {
  sessionState.participants = snapshot.participants ?? [];
  sessionState.leader = snapshot.leader ?? null;
}

/// This window's own participant row, or null when it is not in the roster.
export function selfParticipant(): SessionParticipant | null {
  const me = sessionWindowId();
  return sessionState.participants.find((p) => p.window_id === me) ?? null;
}

/// Whether this window reads as a session LEADER. Role is ORIGIN-derived on the
/// server (a local-origin `/ws` reads leader, a tunnel `/ws` follower), so this
/// reads the self participant's role rather than comparing the single owner
/// slot. A window with no self participant (untagged / not-yet-seeded) is
/// NEITHER leader nor follower.
export function isLeader(): boolean {
  return selfParticipant()?.role === "leader";
}

/// Whether this window is definitively a FOLLOWER: its own origin-derived role
/// is follower (a tunnel/gateway session). Distinct from `!isLeader()`, which is
/// ALSO true for a solo or not-yet-seeded window with no self participant that
/// must still act as its own owner (e.g. persist/discard its own layout blob).
export function isFollower(): boolean {
  return selfParticipant()?.role === "follower";
}

/// Raise the handover prompt: the leader's window received a `handover_prompt`
/// for an in-flight `cs session handover`. A new request replaces a showing one
/// (the server allows only one handover in flight, so this is a refresh).
export function showHandover(prompt: {
  requestId: string;
  fromWindowId: string;
  fromName: string | null;
}): void {
  sessionState.handover = { ...prompt, busy: false };
}

async function answerHandover(accept: boolean): Promise<void> {
  const h = sessionState.handover;
  if (!h || h.busy) return;
  h.busy = true;
  const reply: SessionHandoverReplyRequest = {
    requestId: h.requestId,
    windowId: sessionWindowId(),
    accept,
  };
  try {
    await api.sessionHandoverReply(reply);
    sessionState.handover = null;
  } catch (err) {
    // A failed reply means the request is gone (timed out, or seized by a
    // takeover) or unreachable -- either way the prompt is stale, so drop it
    // rather than leaving a card that only ever 404s.
    sessionState.handover = null;
    notify(`handover ${accept ? "accept" : "reject"} failed: ${(err as Error).message ?? err}`);
  }
}

/// Accept the pending handover (the requester becomes leader).
export const acceptHandover = (): Promise<void> => answerHandover(true);

/// Reject the pending handover (also the Escape / close action).
export const rejectHandover = (): Promise<void> => answerHandover(false);
