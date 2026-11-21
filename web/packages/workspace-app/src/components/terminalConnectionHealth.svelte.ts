// One terminal socket's input ping and its Reconnected note. The socket owner
// reports its opens, retirements, pings, pongs and the user's input; this
// module times the input ping and the note.

import { createConnectionProbe } from "../api/connectionProbe";

/// Delay after user input before its probe pings the terminal socket.
export const TERMINAL_INPUT_PROBE_MS = 1_000;
/// Limit input-triggered pings while a terminal is busy or the connection is silent.
export const TERMINAL_INPUT_PROBE_SPACING_MS = 2_000;
/// Visible lifetime of the note that a retired socket may have lost input.
export const TERMINAL_INPUT_NOTICE_MS = 12_000;
/// Keep the note visible long enough to survive continued typing.
export const TERMINAL_INPUT_NOTICE_MIN_MS = 4_000;

/// Open before the first ping, and retire before opening the next socket. Dispose when the tab leaves the tree.
export function createTerminalConnectionHealth(
  sendPing: () => void,
  now: () => number = () => Date.now(),
) {
  const state = $state({ notice: false });
  let open = false;
  let hasOpened = false;
  let disposed = false;
  let noticeBlocked = false;
  let noticeInputOutstanding = false;
  // The last user input's stamp, held below every ping sent after it.
  // A pong answers only input sent before the ping it answers: a frame
  // proves nothing about the client-to-server direction, but a pong
  // arrives in send order.
  let lastInputAt = Number.NEGATIVE_INFINITY;
  let noticePending = false;
  let noticeRemainingMs = TERMINAL_INPUT_NOTICE_MS;
  let noticeStartedAt = 0;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  let inputTimer: ReturnType<typeof setTimeout> | null = null;
  let lastInputProbeAt = Number.NEGATIVE_INFINITY;
  const probe = createConnectionProbe({ now });

  const clearInput = () => {
    if (inputTimer !== null) clearTimeout(inputTimer);
    inputTimer = null;
  };
  const clearNotice = () => {
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    noticeTimer = null;
    state.notice = false;
  };
  const runNotice = () => {
    if (!state.notice || noticeBlocked || noticeTimer !== null) return;
    noticeStartedAt = now();
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      state.notice = false;
    }, noticeRemainingMs);
  };
  const retire = () => {
    if (state.notice || (open && noticeInputOutstanding)) noticePending = true;
    open = false;
    lastInputAt = Number.NEGATIVE_INFINITY;
    noticeInputOutstanding = false;
    clearInput();
    clearNotice();
    probe.reset();
  };

  return {
    state,
    opened() {
      if (disposed) return;
      retire();
      lastInputProbeAt = Number.NEGATIVE_INFINITY;
      open = true;
      hasOpened = true;
      state.notice = noticePending;
      noticePending = false;
      noticeRemainingMs = TERMINAL_INPUT_NOTICE_MS;
      runNotice();
    },
    pingSent() {
      if (!open || disposed) return;
      // Every input so far left this socket before this ping, whatever the clock says.
      lastInputAt = Math.min(lastInputAt, now() - 1);
      probe.pingSent();
    },
    /// True when the pong answers a ping sent since the timings were last
    /// forgotten: pongs pair with pings in order, and only those keep a time.
    pongArrived(): boolean {
      if (!open || disposed) return false;
      const answeredAt = probe.pongReceived();
      if (answeredAt !== null && answeredAt > lastInputAt) noticeInputOutstanding = false;
      return answeredAt !== null;
    },
    /// The page's clock jumped with pings in flight, so their pongs time nothing.
    forgetPingTimings() {
      probe.forgetTimings();
    },
    /// The socket's latest round trip, or null before its first.
    get rttMs() {
      return probe.rttMs;
    },
    inputSent() {
      if (!open || disposed) return;
      lastInputAt = now();
      noticeInputOutstanding = true;
      const noticeAge = TERMINAL_INPUT_NOTICE_MS - noticeRemainingMs +
        (noticeTimer !== null ? Math.max(0, now() - noticeStartedAt) : 0);
      if (state.notice && noticeAge >= TERMINAL_INPUT_NOTICE_MIN_MS) clearNotice();
      if (inputTimer !== null) return;
      const delay = Math.max(TERMINAL_INPUT_PROBE_MS, lastInputProbeAt + TERMINAL_INPUT_PROBE_SPACING_MS - now());
      inputTimer = setTimeout(() => {
        inputTimer = null;
        if (!open || disposed) return;
        lastInputProbeAt = now();
        sendPing();
      }, delay);
    },
    /// Retire a socket's probe and input tracking; a note owed for it shows at the next open.
    retired() {
      retire();
    },
    /// A user restart starts a fresh shell without carrying pending input warnings into it.
    restartRequested() {
      hasOpened = false;
      noticePending = false;
      noticeInputOutstanding = false;
      clearNotice();
    },
    /// Only user-authored input refused after a prior connection can be lost by a disconnect.
    inputRefused() {
      if (disposed || !hasOpened) return;
      noticePending = true;
      clearNotice();
    },
    /// Pause the note's time while the cover or a hidden tab keeps it out of sight.
    setNoticeBlocked(blocked: boolean) {
      if (noticeBlocked === blocked) return;
      noticeBlocked = blocked;
      if (blocked && noticeTimer !== null) {
        noticeRemainingMs -= Math.max(0, now() - noticeStartedAt);
        clearTimeout(noticeTimer);
        noticeTimer = null;
      } else if (!blocked) runNotice();
    },
    dispose() {
      if (disposed) return;
      retire();
      noticePending = false;
      disposed = true;
    },
  };
}
