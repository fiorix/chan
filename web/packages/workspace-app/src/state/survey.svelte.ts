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
// agent can tell). Both are real replies that unblock the CLI: Escape maps to
// the explicit Dismiss reply rather than a silent close, so a stray
// Escape/backdrop close cannot hang the waiting CLI.
//
// The server later pushes `close_survey` when that parked request disappears
// externally (timeout, cancellation, or a first reply from another window).
// The close path clears only the matching survey id so tab-targeted and group
// surveys do not erase each other. `open_survey` and `close_survey` each go
// out once, so a socket that attaches or lags is also sent `survey_sync`, the
// surveys still open in this window, and the overlays converge on it
// (`syncSurveys`).

import {
  api,
  type SurveySpec,
  type SurveyReplyRequest,
} from "../api/client";
import { ApiError, apiErrorCode } from "../api/errors";
import { notify } from "./notify.svelte";

/// One in-flight survey + its reply guard. `busy` gates the reply buttons so a
/// double-click / double-keypress cannot fire two replies for the same oneshot
/// (the second would 404, but the guard keeps the UI honest). `closed` records
/// that the server closed the survey while the reply was in flight, by a
/// `close_survey` or a sync that leaves it out, which that reply applies if it
/// fails. A survey a sync sets aside is still open and is never marked.
type SurveyEntry = { spec: SurveySpec; busy: boolean; closed?: boolean };

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

/// Ids whose reply the server accepted from this window. Survey ids are never
/// reused, and a sync built before the reply was accepted, or an `open_survey`
/// still buffered for this socket when it was, can list the survey again,
/// where its buttons would only answer 404.
const answered = new Set<string>();

/// Drop every survey this window shows and every id it answered, for a test's
/// teardown.
export function resetSurveysForTest(): void {
  surveyState.byTab = {};
  surveyState.windowWide = null;
  answered.clear();
}

function allSlots(): SurveySlot[] {
  return [...Object.keys(surveyState.byTab), null];
}

function shows(surveyId: string): boolean {
  return allSlots().some((slot) => entry(slot)?.spec.surveyId === surveyId);
}

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

/// Raise a survey on a slot. A different survey showing there is replaced, as
/// the later of two group surveys takes a shared window's window-wide slot.
/// Raising is idempotent by survey id: a sync can repeat a survey the window
/// shows, and an `open_survey` can follow a sync that listed it, so a survey
/// showing on any slot stays as it is, its reply in flight included. A survey
/// this window answered is dropped. `slot` null = window-wide fallback.
export function showSurvey(spec: SurveySpec, slot: SurveySlot = null): void {
  if (answered.has(spec.surveyId)) return;
  if (shows(spec.surveyId)) return;
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
    if (entry(slot)?.spec.surveyId !== surveyId) continue;
    return retire(slot) ? slot : undefined;
  }
  return undefined;
}

/// Converge on a `survey_sync`: `open` lists, oldest first, the surveys still
/// open in this window, each with the slot its target resolves to now. An id
/// this window answered is skipped. A slot showing a survey the list leaves
/// out is retired. A listed survey the window shows keeps the slot it shows
/// on, since its `tabName` can stop resolving to its terminal when the
/// terminal is renamed. Each listed survey the window does not show is raised
/// on its slot unless a later listed survey shows there, as the later
/// `open_survey` wins live; an earlier one it displaces is set aside, not
/// closed, and a later sync raises it again once the slot is free of later
/// entries. Applying a list twice changes nothing.
export function syncSurveys(open: ReadonlyArray<{ spec: SurveySpec; slot: SurveySlot }>): void {
  const listed = open.filter(({ spec }) => !answered.has(spec.surveyId));
  const order = new Map(listed.map(({ spec }, index) => [spec.surveyId, index]));
  for (const slot of allSlots()) {
    const shown = entry(slot);
    if (shown && !order.has(shown.spec.surveyId)) retire(slot);
  }
  listed.forEach(({ spec, slot }, index) => {
    if (shows(spec.surveyId)) return;
    const occupant = entry(slot);
    const occupantIndex = occupant ? order.get(occupant.spec.surveyId) : undefined;
    if (occupantIndex !== undefined && occupantIndex > index) return;
    showSurvey(spec, slot);
  });
}

/// Take down the survey on `slot`, which the server has closed: a
/// `close_survey` named it or a sync left it out. If a reply from THIS window
/// is in flight for it (busy), the slot is left to that reply: an accepted
/// reply clears it, and a failed one applies the close, since nothing is
/// waiting on the survey any more. A close raced against the deadline lands
/// here, and so does the `answered_elsewhere` close of an answer this window
/// has in flight, since the server sends an answered survey's close to every
/// window it targeted. A survey a sync sets aside is still open and never
/// comes here. Returns whether the slot was cleared.
function retire(slot: SurveySlot): boolean {
  const e = entry(slot);
  if (!e) return false;
  if (e.busy) {
    e.closed = true;
    return false;
  }
  clear(slot);
  return true;
}

/// Clear `slot` if it still shows `surveyId`. A reply settles after its
/// await, and by then a later survey may have taken the slot.
function release(slot: SurveySlot, surveyId: string): void {
  if (entry(slot)?.spec.surveyId === surveyId) clear(slot);
}

/// Whether the reply route refused a reply because no survey is parked under
/// its id (answered, timed out or cancelled). The route's 404 carries its own
/// code; a gateway answers a bare 404 when the devserver's tunnel is down or
/// an authorization is cancelled, which says nothing about the survey.
function refusedAsUnknown(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && apiErrorCode(err) === "survey_not_found";
}

/// Post `reply` for the survey `e` shows on `slot`, holding the slot busy
/// until it settles. An accepted reply clears the slot. Nothing can answer a
/// survey the reply route refuses as unknown, so that refusal clears the slot
/// too and says so, as does any failure after the server closed the
/// survey during the reply. Any other failure keeps the overlay for a retry,
/// or, when a sync set the survey aside meanwhile, says it is still open: the
/// next sync that lists it with its slot free raises it again.
async function send(
  slot: SurveySlot,
  e: SurveyEntry,
  reply: SurveyReplyRequest,
  failure: string,
): Promise<void> {
  const surveyId = e.spec.surveyId;
  e.busy = true;
  try {
    await api.surveyReply(reply);
    answered.add(surveyId);
    release(slot, surveyId);
  } catch (err) {
    e.busy = false;
    if (refusedAsUnknown(err) || e.closed) {
      release(slot, surveyId);
      notify("survey expired: nothing is waiting for its answer");
      return;
    }
    const aside = entry(slot)?.spec.surveyId !== surveyId;
    notify(`${failure}: ${(err as Error).message ?? err}${aside ? "; the survey is still open" : ""}`);
  }
}

/// Reply with the option at `index` (0-based; the overlay numbers them
/// [1]..[N]) for the survey on `slot`. The chosen label round-trips to the
/// blocked CLI's stdout.
export async function pickOption(slot: SurveySlot, index: number): Promise<void> {
  const e = entry(slot);
  if (!e || e.busy) return;
  const label = e.spec.options[index];
  if (label === undefined) return;
  const reply: SurveyReplyRequest = {
    surveyId: e.spec.surveyId,
    kind: "option",
    optionIndex: index,
    optionLabel: label,
  };
  await send(slot, e, reply, "survey reply failed");
}

/// Reply with [F] for the survey on `slot`. F is standard on every survey,
/// not an opt-in affordance: a bare "host will follow up later" signal,
/// dismiss-shaped (the surveyId only), telling the asking agent an
/// answer is coming in a separate prompt.
export async function requestFollowup(slot: SurveySlot): Promise<void> {
  const e = entry(slot);
  if (!e || e.busy) return;
  const reply: SurveyReplyRequest = {
    surveyId: e.spec.surveyId,
    kind: "followup",
  };
  await send(slot, e, reply, "survey followup failed");
}

/// Dismiss the survey on `slot`. A dismiss sends a distinct "dismissed" reply
/// that carries only the surveyId, so the asking agent can tell the host
/// dropped the survey rather than answering or deferring it. Still a real
/// reply, so it unblocks the CLI.
export async function dismissSurvey(slot: SurveySlot): Promise<void> {
  const e = entry(slot);
  if (!e || e.busy) return;
  const reply: SurveyReplyRequest = {
    surveyId: e.spec.surveyId,
    kind: "dismissed",
  };
  await send(slot, e, reply, "survey dismiss failed");
}
