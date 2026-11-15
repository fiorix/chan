// One terminal socket's link reading and input-triggered ping. The socket
// owner reports its traffic; this module owns only the probe and timers.

import { createLinkProbe } from "../api/linkProbe";
import { WS_READ_DEADLINE_MS } from "../api/transport";

/// Delay before a sent input with no answer asks the terminal socket for a pong.
export const TERMINAL_INPUT_PROBE_MS = 1_000;
/// Limit input-triggered pings while a terminal is busy or the link is silent.
export const TERMINAL_INPUT_PROBE_SPACING_MS = 2_000;
/// Read time-driven changes while an answered socket has a ping in flight.
export const TERMINAL_LINK_TICK_MS = 250;

/// PTY mouse traffic carries input bytes but is no evidence that typing went
/// unanswered. Ghostty and xterm use these two complete report encodings.
export function terminalMouseReport(data: string): "x10" | "sgr" | null {
  if (data.startsWith("\x1b[M") && /^\x1b\[M[\x20-\xff]{3}$/.test(data)) return "x10";
  if (data.startsWith("\x1b[<") && /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data)) return "sgr";
  return null;
}

/// Open before the first ping, report each frame before its pong, and retire
/// before opening the next socket. Dispose when the tab leaves the tree.
export function createTerminalLink(sendPing: () => void, now: () => number = () => Date.now()) {
  const state = $state({ stalled: false, waitMs: 0, rttMs: null as number | null });
  let open = false;
  let disposed = false;
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
  const sync = () => {
    if (!open || disposed) return;
    const pingAt = probe.answered ? probe.oldestPingAt : null;
    const waitMs = pingAt === null ? 0 : Math.max(0, now() - pingAt);
    // The read deadline has fired by this wait; its socket may still be
    // closing. A longer wall-clock wait is not a live link measurement.
    if (waitMs > WS_READ_DEADLINE_MS) {
      probe.forgetTimings();
      state.stalled = false;
      state.waitMs = 0;
      clearTicker();
      return;
    }
    state.stalled = probe.classify() === "stalled";
    state.rttMs = probe.rttMs;
    state.waitMs = waitMs;
    if (pingAt !== null && ticker === null) ticker = setInterval(sync, TERMINAL_LINK_TICK_MS);
    else if (pingAt === null) clearTicker();
  };
  const probe = createLinkProbe({ now });
  const retire = () => {
    open = false;
    clearInput();
    clearTicker();
    probe.reset();
    state.stalled = false;
    state.waitMs = 0;
    state.rttMs = null;
  };

  return {
    state,
    opened() {
      if (disposed) return;
      retire();
      lastInputProbeAt = Number.NEGATIVE_INFINITY;
      open = true;
    },
    pingSent() {
      if (!open || disposed) return;
      probe.pingSent();
      sync();
    },
    frameArrived() {
      if (!open || disposed) return;
      clearInput();
      const waiting = probe.answered && probe.oldestPingAt !== null;
      probe.frameReceived();
      if (waiting || state.stalled) sync();
    },
    pongArrived() {
      if (!open || disposed) return;
      probe.pongReceived();
      sync();
    },
    inputSent() {
      if (!open || disposed || inputTimer !== null) return;
      const delay = Math.max(TERMINAL_INPUT_PROBE_MS, lastInputProbeAt + TERMINAL_INPUT_PROBE_SPACING_MS - now());
      inputTimer = setTimeout(() => {
        inputTimer = null;
        if (!open || disposed) return;
        lastInputProbeAt = now();
        sendPing();
      }, delay);
    },
    retired() {
      retire();
    },
    dispose() {
      if (disposed) return;
      retire();
      disposed = true;
    },
  };
}
