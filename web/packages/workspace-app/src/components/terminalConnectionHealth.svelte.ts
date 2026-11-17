// One terminal socket's probe, stalled redial, and lost-input notice. The
// socket owner reports traffic and window health; this module owns timing.

import { createConnectionProbe } from "../api/connectionProbe";
import { WS_READ_DEADLINE_MS } from "../api/transport";
import type { ConnectionState } from "../state/connectionHealth.svelte";

/// Delay before a sent input with no answer asks the terminal socket for a pong.
export const TERMINAL_INPUT_PROBE_MS = 1_000;
/// Limit input-triggered pings while a terminal is busy or the connection is silent.
export const TERMINAL_INPUT_PROBE_SPACING_MS = 2_000;
/// Read time-driven changes while an answered socket has a ping in flight.
export const TERMINAL_CONNECTION_TICK_MS = 250;
/// Sustained healthy watcher time before replacing a stalled terminal socket.
export const TERMINAL_STALL_REDIAL_MS = 3_000;
/// Keep a terminal-only outage from recycling the same session repeatedly.
export const TERMINAL_REDIAL_SPACING_MS = 30_000;
/// Visible lifetime of the warning that a retired socket may have lost input.
export const TERMINAL_INPUT_NOTICE_MS = 12_000;
/// Keep the lost-input warning visible long enough to survive continued typing.
export const TERMINAL_INPUT_NOTICE_MIN_MS = 4_000;

/// Open before the first ping, report each frame before its pong, and retire before opening the next socket. Dispose when the tab leaves the tree.
/// The redial owner checks whether its socket can be replaced and dials through its existing resume path; lastContactAt must report the watcher's latest inbound contact.
export function createTerminalConnectionHealth(
  sendPing: () => void,
  now: () => number = () => Date.now(),
  redial?: { canRedial: () => boolean; lastContactAt: () => number | null; run: () => void },
) {
  const state = $state({ stalled: false, waitMs: 0, retiring: false, lost: false, notice: false });
  let open = false;
  let hasOpened = false;
  let disposed = false;
  let windowState: ConnectionState = "unknown";
  let noticeBlocked = false;
  let okSince: number | null = null;
  let stalledAt: number | null = null;
  let windowWaitStartedAt: number | null = null;
  let stallWaitStartedAt: number | null = null;
  let redialEligibleAt: number | null = null;
  let lastRedialAt = Number.NEGATIVE_INFINITY;
  let inputOutstanding = false;
  let noticeInputOutstanding = false;
  // When the last user input went out. A pong answers only input sent no
  // later than the ping it answers: a frame proves nothing about the
  // client-to-server direction, but a pong arrives in send order.
  let lastInputAt = Number.NEGATIVE_INFINITY;
  let noticePending = false;
  let noticeRemainingMs = TERMINAL_INPUT_NOTICE_MS;
  let noticeStartedAt = 0;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  let redialTimer: ReturnType<typeof setTimeout> | null = null;
  let redialedThisStall = false;
  let inputTimer: ReturnType<typeof setTimeout> | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let lastInputProbeAt = Number.NEGATIVE_INFINITY;

  const clearInput = () => {
    if (inputTimer !== null) clearTimeout(inputTimer);
    inputTimer = null;
  };
  const clearTicker = () => {
    if (ticker !== null) clearInterval(ticker);
    ticker = null;
  };
  const clearRedial = () => {
    if (redialTimer !== null) clearTimeout(redialTimer);
    redialTimer = null;
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
  const updateRedial = () => {
    const dial = redial;
    if (!dial) return;
    const contactAt = dial.lastContactAt();
    const eligible = open && !disposed && state.stalled && stalledAt !== null &&
      windowState === "ok" && contactAt !== null && contactAt >= stalledAt && !inputOutstanding &&
      !redialedThisStall;
    if (!eligible) {
      clearRedial();
      redialEligibleAt = null;
      return;
    }
    if (redialTimer !== null) return;
    redialEligibleAt ??= Math.max(stalledAt!, contactAt!, okSince ?? now());
    const readyAt = Math.max(redialEligibleAt + TERMINAL_STALL_REDIAL_MS, lastRedialAt + TERMINAL_REDIAL_SPACING_MS);
    redialTimer = setTimeout(() => {
      redialTimer = null;
      const freshContact = dial.lastContactAt();
      if (!open || disposed || !state.stalled || windowState !== "ok" ||
        stalledAt === null || freshContact === null || freshContact < stalledAt) return;
      if (!dial.canRedial()) {
        redialedThisStall = true;
        return;
      }
      redialedThisStall = true;
      lastRedialAt = now();
      dial.run();
    }, Math.max(0, readyAt - now()));
  };
  const sync = () => {
    if (!open || disposed) return;
    if (state.retiring) {
      updateRedial();
      return;
    }
    const pingAt = probe.answered ? probe.oldestPingAt : null;
    const waitMs = pingAt === null ? 0 : Math.max(0, now() - pingAt);
    // The read deadline has fired by this wait; its socket may still be
    // closing. A longer wall-clock wait is not a live connection measurement.
    if (waitMs > WS_READ_DEADLINE_MS) {
      probe.forgetTimings();
      state.stalled = false;
      state.waitMs = 0;
      stalledAt = null;
      stallWaitStartedAt = null;
      redialedThisStall = false;
      clearTicker();
      updateRedial();
      return;
    }
    const stalled = probe.classify() === "stalled";
    if (stalled && !state.stalled) stalledAt = now();
    if (!stalled) {
      stalledAt = null;
      stallWaitStartedAt = null;
      redialedThisStall = false;
    } else {
      const start = Math.min(pingAt ?? now(), windowWaitStartedAt ?? Number.POSITIVE_INFINITY);
      stallWaitStartedAt = Math.min(stallWaitStartedAt ?? start, start);
    }
    state.stalled = stalled;
    if (state.stalled) clearNotice();
    state.waitMs = stalled ? Math.max(0, now() - stallWaitStartedAt!) : waitMs;
    if (pingAt !== null && ticker === null) ticker = setInterval(sync, TERMINAL_CONNECTION_TICK_MS);
    else if (pingAt === null) clearTicker();
    updateRedial();
  };
  const probe = createConnectionProbe({ now });
  const markInputWritten = () => {
    if (!open || disposed) return;
    lastInputAt = now();
    inputOutstanding = true;
    updateRedial();
  };
  const retire = () => {
    if (state.notice || (open && noticeInputOutstanding)) noticePending = true;
    open = false;
    lastInputAt = Number.NEGATIVE_INFINITY;
    inputOutstanding = false;
    noticeInputOutstanding = false;
    clearInput();
    clearTicker();
    clearRedial();
    clearNotice();
    probe.reset();
    state.stalled = false;
    state.waitMs = 0;
    state.retiring = false;
    stalledAt = null;
    windowWaitStartedAt = null;
    stallWaitStartedAt = null;
    redialEligibleAt = null;
    redialedThisStall = false;
  };

  return {
    state,
    opened() {
      if (disposed) return;
      retire();
      lastInputProbeAt = Number.NEGATIVE_INFINITY;
      open = true;
      hasOpened = true;
      state.lost = false;
      state.notice = noticePending;
      noticePending = false;
      noticeRemainingMs = TERMINAL_INPUT_NOTICE_MS;
      runNotice();
    },
    pingSent() {
      if (!open || disposed) return;
      probe.pingSent();
      sync();
    },
    frameArrived() {
      if (!open || disposed) return;
      probe.frameReceived();
      const waiting = probe.answered && probe.oldestPingAt !== null;
      if (waiting || state.stalled) sync();
    },
    pongArrived() {
      if (!open || disposed) return;
      const answeredAt = probe.pongReceived();
      if (answeredAt !== null && answeredAt > lastInputAt) {
        inputOutstanding = false;
        noticeInputOutstanding = false;
      }
      sync();
    },
    inputSent() {
      if (!open || disposed) return;
      markInputWritten();
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
    /// Mark any user bytes on this socket, including mouse reports and wheel arrows that do not arm the input probe.
    inputWritten() {
      markInputWritten();
    },
    /// Retire a socket's probe and input tracking; an existing lost-connection notice remains until the next open.
    retired() {
      retire();
    },
    /// The socket closed unexpectedly; keep the connection-lost notice through backoff and dialing.
    disconnected() {
      if (!disposed && hasOpened) state.lost = true;
    },
    /// A user restart starts a fresh shell without carrying connection loss or pending input warnings into it.
    restartRequested() {
      state.lost = false;
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
    /// A read deadline has closed the socket, but its close callback may not have run yet.
    retiring() {
      if (!open || disposed) return;
      state.retiring = true;
      state.lost = true;
      if (!state.stalled) {
        state.stalled = true;
        stalledAt = now();
      }
      if (ticker === null) ticker = setInterval(sync, TERMINAL_CONNECTION_TICK_MS);
      updateRedial();
    },
    /// Re-evaluate watcher contact and pause notice time while the cover or tab hides it.
    windowChanged(next: ConnectionState, blocked: boolean, waitStartedAt: number | null = null) {
      if (windowState !== next) okSince = next === "ok" ? now() : null;
      windowState = next;
      windowWaitStartedAt = next === "stalled" ? waitStartedAt : null;
      if (state.stalled && windowWaitStartedAt !== null) {
        stallWaitStartedAt = Math.min(stallWaitStartedAt ?? now(), windowWaitStartedAt);
        state.waitMs = Math.max(0, now() - stallWaitStartedAt);
      }
      if (noticeBlocked !== blocked) {
        noticeBlocked = blocked;
        if (blocked && noticeTimer !== null) {
          noticeRemainingMs -= Math.max(0, now() - noticeStartedAt);
          clearTimeout(noticeTimer);
          noticeTimer = null;
        } else if (!blocked) runNotice();
      }
      updateRedial();
    },
    dispose() {
      if (disposed) return;
      retire();
      noticePending = false;
      state.lost = false;
      disposed = true;
    },
  };
}
