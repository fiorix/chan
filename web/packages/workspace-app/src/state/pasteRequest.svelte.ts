// The `cs paste` reply flow + the chan-owned paste card.
//
// A `clipboard_read` window command starts an immediate clipboard read. In a
// plain browser that read can PEND on the browser's paste-permission UI
// (WebKit's floating Paste button, a Firefox prompt) with nothing in the
// window saying why the CLI is blocked. So the read races a short threshold:
// settle fast (native desktop IPC, an already-granted browser) and the reply
// POSTs with no UI at all; still pending at the threshold and a corner card
// (PasteRequestBubble, a RequestCard) explains what is
// waiting, with a [Paste] button whose click carries the user activation a
// browser read wants, and a [Cancel] that answers the CLI immediately.
//
// The window bus completes once per request id, so whichever reply lands
// first wins and every later one 404s harmlessly (the original pending read
// resolving after the card's Paste, a stale card's Cancel). Nothing here is
// persisted: a reload leaves the CLI to the server's 30s timeout.

import { api } from "../api/client";
import {
  bytesToBase64,
  hintClipboardError,
  readClipboardPayload,
  readWebClipboardPayload,
  type ClipboardPayload,
  type PastePrefer,
} from "../api/clipboard";

/// How long the immediate read may pend before the paste card shows. Long
/// enough that a settled read (native IPC, granted permission) never
/// flashes a card; short enough that a permission-parked `cs paste` looks
/// attended within a beat.
export const PASTE_CARD_PENDING_MS = 800;

/// The paste card for one pending `cs paste`, plus its reply guard so a
/// double-click cannot fire two answers for one oneshot.
interface PasteRequestCard {
  requestId: string;
  prefer: PastePrefer;
  busy: boolean;
}

export const pasteRequestState = $state<{ card: PasteRequestCard | null }>({
  card: null,
});

/// The `{ mime, data_b64 }` reply (or `{ error }`) `/api/window/reply`
/// forwards to the blocked `cs paste`.
type PasteReplyPayload = { mime: string; data_b64: string } | { error: string };

/// A window-bus reply POST that 404s is expected (the CLI already timed out
/// or a rival reply won the once-only bus), so swallow it. Any OTHER failure
/// (a 413 body-limit rejection, a network error) would leave the CLI hanging
/// until its 30s timeout with no clue why, so surface it to the console.
export function warnUnlessStaleReply(e: unknown): void {
  const status = (e as { status?: number } | null)?.status;
  if (status === 404) return;
  console.warn("clipboard reply POST failed", e);
}

function payloadToReply(payload: ClipboardPayload): PasteReplyPayload {
  return { mime: payload.mime, data_b64: bytesToBase64(payload.bytes) };
}

/// POST a reply for `requestId` and dismiss the card if it is still THIS
/// request's (a newer `clipboard_read` may have replaced it meanwhile).
async function postPasteReply(requestId: string, payload: PasteReplyPayload): Promise<void> {
  try {
    await api.windowReply({ requestId, payload });
  } catch (e) {
    warnUnlessStaleReply(e);
  }
  if (pasteRequestState.card?.requestId === requestId) {
    pasteRequestState.card = null;
  }
}

/// Answer a `cs paste`: start the clipboard read immediately and race it
/// against [`PASTE_CARD_PENDING_MS`]. A fast settle (either way) replies with
/// no UI; a still-pending read raises the paste card while the original read
/// keeps running (the user may click the BROWSER's own permission UI, whose
/// resolution then replies and dismisses the card). Transient, no session
/// save.
export async function respondClipboardRead(
  requestId: string,
  prefer: PastePrefer,
): Promise<void> {
  const read = readClipboardPayload(prefer);
  const settled = read.then(
    (payload) => payloadToReply(payload),
    (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }),
  );
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    settled,
    new Promise<"pending">((resolve) => {
      pendingTimer = setTimeout(() => resolve("pending"), PASTE_CARD_PENDING_MS);
    }),
  ]);
  clearTimeout(pendingTimer);
  if (outcome !== "pending") {
    await postPasteReply(requestId, outcome);
    return;
  }
  // The read is parked (a browser permission UI, most likely). Raise the
  // card; a newer request simply replaces a stale one. The original read
  // stays live: its eventual settle replies too (the bus keeps first-wins).
  pasteRequestState.card = { requestId, prefer, busy: false };
  void settled.then((payload) => postPasteReply(requestId, payload));
}

/// The card's [Paste]: ONE fresh clipboard access inside the click's user
/// activation (the parked programmatic read lacked one), every
/// representation derived from that single access.
export async function confirmPasteCard(): Promise<void> {
  const card = pasteRequestState.card;
  if (!card || card.busy) return;
  card.busy = true;
  let payload: PasteReplyPayload;
  try {
    payload = payloadToReply(await readWebClipboardPayload(card.prefer));
  } catch (e) {
    payload = { error: hintClipboardError(e) };
  }
  await postPasteReply(card.requestId, payload);
}

/// The card's [Cancel] (also Escape / close): answer the blocked CLI
/// immediately instead of leaving it to the 30s timeout.
export async function cancelPasteCard(): Promise<void> {
  const card = pasteRequestState.card;
  if (!card || card.busy) return;
  card.busy = true;
  await postPasteReply(card.requestId, { error: "paste cancelled in the window" });
}
