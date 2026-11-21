// Whether a terminal socket survived a wake gap. A gap in the page's timers
// is either a machine sleep, which can leave a half-open socket that still
// reads OPEN, or a main-thread stall, after which the engine may hold a large
// backlog on a healthy socket that a redial would throw away. Only the socket
// can tell them apart, so the owner pings it and this module reads the answer.
//
// The pong of that ping ends the probe. The server answers pings in order, so
// counting pongs identifies it without an id on the wire, and an earlier
// heartbeat's pong, which may have been queued before a sleep, does not count.
// Any other frame only extends the deadline: a backlog queued before a sleep
// still drains from a socket whose peer is gone.

/// How often a running probe reads the clock.
export const TERMINAL_WAKE_TICK_MS = 250;
/// The most quiet time one tick adds on a shown page. A tick later than this
/// ran after a stall, ahead of any frames the stall left queued, so the time
/// it missed says nothing about the socket.
export const TERMINAL_WAKE_TICK_CREDIT_MS = 2 * TERMINAL_WAKE_TICK_MS;

export interface TerminalWakeProbeOptions {
  /// Quiet time, with the page running, after which the socket is given up on.
  quietLimitMs: number;
  /// The socket did not answer. The probe has already stopped.
  onSilent: () => void;
  /// Clock, in milliseconds. Defaults to `Date.now`.
  now?: () => number;
  /// Whether the page is hidden. A hidden page's timers are throttled while
  /// its socket events still run, so its ticks count in full.
  hidden?: () => boolean;
}

export interface TerminalWakeProbe {
  /// Whether a probe is waiting for its pong.
  readonly active: boolean;
  /// Start a probe, or move a running one onto a new ping after another wake.
  /// Call just before sending the ping: a socket may answer inside the send.
  begin(): void;
  pingSent(): void;
  frameReceived(): void;
  pongReceived(): void;
  /// The socket is gone: stop, and forget its pings and pongs.
  reset(): void;
}

export function createTerminalWakeProbe(options: TerminalWakeProbeOptions): TerminalWakeProbe {
  const now = options.now ?? (() => Date.now());
  const hidden = options.hidden ?? (() => document.visibilityState === "hidden");
  let pingsSent = 0;
  let pongsReceived = 0;
  // The count of pongs at which the probe's own ping has been answered.
  let awaitedPong: number | null = null;
  let quietMs = 0;
  let lastTickAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    awaitedPong = null;
  };
  const tick = () => {
    const at = now();
    const elapsed = Math.max(0, at - lastTickAt);
    lastTickAt = at;
    quietMs += hidden() ? elapsed : Math.min(elapsed, TERMINAL_WAKE_TICK_CREDIT_MS);
    if (quietMs < options.quietLimitMs) return;
    stop();
    options.onSilent();
  };

  return {
    get active() {
      return awaitedPong !== null;
    },
    begin() {
      awaitedPong = pingsSent + 1;
      if (timer === null) {
        quietMs = 0;
        lastTickAt = now();
        timer = setInterval(tick, TERMINAL_WAKE_TICK_MS);
      } else if (!hidden()) {
        // A hidden page's throttled timers can report a gap on every tick,
        // and restarting the count there would never reach the limit.
        quietMs = 0;
      }
    },
    pingSent() {
      pingsSent += 1;
    },
    frameReceived() {
      quietMs = 0;
    },
    pongReceived() {
      pongsReceived += 1;
      if (awaitedPong !== null && pongsReceived >= awaitedPong) stop();
    },
    reset() {
      stop();
      pingsSent = 0;
      pongsReceived = 0;
    },
  };
}
