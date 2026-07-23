// Survey overlay state + reply round-trip for `cs terminal survey`.
//
// An agent runs `cs terminal survey --tab-name=<target>`; the server mints a
// survey id, pushes an `open_survey` window command carrying a SurveySpec +
// the target `tabName` to the owning window, and BLOCKS the CLI on a
// oneshot. store.svelte.ts routes that frame to `showSurvey`; the overlay
// (BubbleOverlay.svelte) renders it and the user picks an option or [F]. The
// reply POSTs to /api/survey/reply, which completes the oneshot and unblocks
// the CLI.
//
// PER-TERMINAL: surveys are keyed by terminal tab id (the
// rich-prompt pattern), so two terminals can each show their own survey without
// colliding - answering/dismissing one does not touch the other. A survey with
// no resolvable target (`tabName` absent/unmatched, or a --tab-group broadcast)
// falls back to a single window-wide slot.
//
// Every survey overlay offers its options PLUS an [F]
// follow-up AND a Dismiss. The host can defer (F: a bare "host will follow up
// later" signal, so the asking agent expects an answer in a separate prompt)
// or dismiss (a distinct "dismissed" reply, no answer coming, so the asking
// agent can tell). Both are real replies that unblock the CLI, so a stray
// Escape/backdrop close is no longer the hang risk it was: Escape now maps to
// the explicit Dismiss reply rather than a silent close.
//
// The server later pushes `close_survey` when that parked request disappears
// externally (timeout, cancellation, or a first reply from another window).
// The close path clears only the matching survey id so tab-targeted and group
// surveys do not erase each other.

import {
  api,
  sessionWindowId,
  type SurveySpec,
  type SurveyReplyRequest,
} from "../api/client";
import { notify } from "./notify.svelte";

/// One in-flight survey + its reply guard. `busy` gates the reply buttons so a
/// double-click / double-keypress cannot fire two replies for the same oneshot
/// (the second would 404, but the guard keeps the UI honest).
type SurveyEntry = { spec: SurveySpec; busy: boolean };

/// A survey's slot: a terminal tab id (per-terminal) or `null` (the window-wide
/// fallback). The reply functions + BubbleOverlay take this so they act on
/// exactly one survey.
export type SurveySlot = string | null;
export type SurveyCloseReason = "cancelled" | "timed_out" | "answered_elsewhere";

/// Active surveys: one per terminal (keyed by tab id) plus a single window-wide
/// fallback. Two terminals answer independently.
export const surveyState = $state<{
  byTab: Record<string, SurveyEntry>;
  windowWide: SurveyEntry | null;
}>({ byTab: {}, windowWide: null });

function entry(slot: SurveySlot): SurveyEntry | null {
  return slot === null ? surveyState.windowWide : (surveyState.byTab[slot] ?? null);
}

function clear(slot: SurveySlot): void {
  if (slot === null) surveyState.windowWide = null;
  else delete surveyState.byTab[slot];
}

/// The active survey spec for a slot, or null. BubbleOverlay/TerminalTab gate
/// the render on this.
export function surveyFor(slot: SurveySlot): SurveySpec | null {
  return entry(slot)?.spec ?? null;
}

/// Whether a slot's reply is in flight (disables its buttons).
export function surveyBusy(slot: SurveySlot): boolean {
  return entry(slot)?.busy ?? false;
}

/// Raise a survey on a slot. A new survey replaces a showing one in the same
/// slot; the server mints distinct ids. `slot` null = window-wide fallback.
export function showSurvey(spec: SurveySpec, slot: SurveySlot = null): void {
  if (slot === null) surveyState.windowWide = { spec, busy: false };
  else surveyState.byTab[slot] = { spec, busy: false };
}

/// Close a survey because the server-side parked request is no longer waiting:
/// another window answered, the timeout elapsed, or the control side cancelled.
/// The survey id is authoritative; the preferred slot only preserves the
/// per-terminal vs window-wide intent when multiple slots exist.
export function closeSurveyFromRemote(
  surveyId: string,
  preferredSlot?: SurveySlot,
): SurveySlot | undefined {
  const slots: SurveySlot[] = [];
  if (preferredSlot !== undefined) slots.push(preferredSlot);
  for (const key of Object.keys(surveyState.byTab)) slots.push(key);
  slots.push(null);
  const seen = new Set<SurveySlot>();
  for (const slot of slots) {
    if (seen.has(slot)) continue;
    seen.add(slot);
    const e = entry(slot);
    if (e?.spec.surveyId !== surveyId) continue;
    // Belt: a reply from THIS window is in flight (busy). The local clear on
    // reply success will win, so ignore a late close for this survey (e.g. an
    // `answered_elsewhere` that the server fanned back to the answerer before
    // the reply POST resolved) rather than clear it out from under the reply.
    // The server-side exclude (windowId on the reply) is the primary guard;
    // this covers the case where windowId is absent.
    if (e.busy) return undefined;
    clear(slot);
    return slot;
  }
  return undefined;
}

/// Reply with the option at `index` (0-based; the overlay numbers them
/// [1]..[N]) for the survey on `slot`. The chosen label round-trips to the
/// blocked CLI's stdout.
export async function pickOption(slot: SurveySlot, index: number): Promise<void> {
  const e = entry(slot);
  if (!e || e.busy) return;
  const label = e.spec.options[index];
  if (label === undefined) return;
  e.busy = true;
  const reply: SurveyReplyRequest = {
    surveyId: e.spec.surveyId,
    kind: "option",
    optionIndex: index,
    optionLabel: label,
    windowId: sessionWindowId(),
  };
  try {
    await api.surveyReply(reply);
    clear(slot);
  } catch (err) {
    e.busy = false;
    notify(`survey reply failed: ${(err as Error).message ?? err}`);
  }
}

/// Reply with [F] for the survey on `slot`. F is standard on every survey,
/// not an opt-in affordance: a bare "host will follow up later" signal,
/// dismiss-shaped (surveyId + windowId only), telling the asking agent an
/// answer is coming in a separate prompt.
export async function requestFollowup(slot: SurveySlot): Promise<void> {
  const e = entry(slot);
  if (!e || e.busy) return;
  e.busy = true;
  const reply: SurveyReplyRequest = {
    surveyId: e.spec.surveyId,
    kind: "followup",
    windowId: sessionWindowId(),
  };
  try {
    await api.surveyReply(reply);
    clear(slot);
  } catch (err) {
    e.busy = false;
    notify(`survey followup failed: ${(err as Error).message ?? err}`);
  }
}

/// Dismiss the survey on `slot`. A dismiss sends a distinct "dismissed" reply
/// that carries only the surveyId, so the asking agent can tell the host
/// dropped the survey rather than answering or deferring it. Still a real
/// reply, so it unblocks the CLI.
export async function dismissSurvey(slot: SurveySlot): Promise<void> {
  const e = entry(slot);
  if (!e || e.busy) return;
  e.busy = true;
  const reply: SurveyReplyRequest = {
    surveyId: e.spec.surveyId,
    kind: "dismissed",
    windowId: sessionWindowId(),
  };
  try {
    await api.surveyReply(reply);
    clear(slot);
  } catch (err) {
    e.busy = false;
    notify(`survey dismiss failed: ${(err as Error).message ?? err}`);
  }
}
