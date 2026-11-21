// Whether a terminal socket survived a wake gap. A gap in the page's timers
// is either a machine sleep, which can leave a half-open socket that still
// reads OPEN, or a main-thread stall, after which the engine may hold a large
// backlog on a healthy socket that a redial would throw away. Only the socket
// can tell them apart, so the owner pings it and this module times the wait.
//
// The answer to a ping sent since the wake ends the probe. Any other frame
// only extends the deadline: a backlog queued before a sleep still drains from
// a socket whose peer is gone.

/// How often a running probe reads the clock.
export const TERMINAL_WAKE_TICK_MS = 250;
/// The most quiet time one tick adds on a shown page. A tick later than this
/// ran after a stall, ahead of any frames the stall left queued, so the time
/// it missed says nothing about the socket.
export const TERMINAL_WAKE_TICK_CREDIT_MS = 2 * TERMINAL_WAKE_TICK_MS;

export interface TerminalWakeProbeOptions {
  /// The socket did not answer. The probe has already stopped.
  onSilent: () => void;
  /// Clock, in milliseconds. Defaults to `Date.now`.
  now?: () => number;
  /// Whether the page is hidden. A hidden page's timers are throttled while
  /// its socket events still run, so a gap it was hidden for from one tick to
  /// the next counts in full. A page shown at either end may have stalled.
  hidden?: () => boolean;
}

export interface TerminalWakeProbe {
  /// Whether a probe is waiting for its answer.
  readonly active: boolean;
  /// Whether a running probe has gone quiet, so its verdict is what comes next.
  readonly settling: boolean;
  /// Start a probe, or move a running one onto a new ping after another wake.
  /// `quietLimitMs` is the quiet time, with the page running, after which the
  /// socket is given up on. Call just before sending the ping: a socket may
  /// answer inside the send.
  begin(quietLimitMs: number): void;
  frameReceived(): void;
  /// A ping sent since the wake was answered.
  answered(): void;
  /// The socket is gone: stop.
  reset(): void;
}

export function createTerminalWakeProbe(options: TerminalWakeProbeOptions): TerminalWakeProbe {
  const now = options.now ?? (() => Date.now());
  const hidden = options.hidden ?? (() => document.visibilityState === "hidden");
  let limitMs = 0;
  let quietMs = 0;
  let lastTickAt = 0;
  let hiddenAtLastTick = false;
  // A late tick reached the limit: the next one decides, after the frames the
  // stall held back have had their turn.
  let confirming = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    confirming = false;
  };
  const tick = () => {
    const at = now();
    const elapsed = Math.max(0, at - lastTickAt);
    lastTickAt = at;
    const pageHidden = hidden();
    const hiddenThroughout = pageHidden && hiddenAtLastTick;
    hiddenAtLastTick = pageHidden;
    quietMs += hiddenThroughout ? elapsed : Math.min(elapsed, TERMINAL_WAKE_TICK_CREDIT_MS);
    if (quietMs < limitMs) return;
    if (!hiddenThroughout && elapsed > TERMINAL_WAKE_TICK_CREDIT_MS && !confirming) {
      confirming = true;
      return;
    }
    stop();
    options.onSilent();
  };

  return {
    get active() {
      return timer !== null;
    },
    get settling() {
      return timer !== null && quietMs >= TERMINAL_WAKE_TICK_CREDIT_MS;
    },
    begin(quietLimitMs) {
      limitMs = quietLimitMs;
      if (timer === null) {
        quietMs = 0;
        lastTickAt = now();
        hiddenAtLastTick = hidden();
        timer = setInterval(tick, TERMINAL_WAKE_TICK_MS);
      } else if (!hidden()) {
        // A hidden page's throttled timers can report a gap on every tick,
        // and restarting the count there would never reach the limit.
        quietMs = 0;
        confirming = false;
      }
    },
    frameReceived() {
      quietMs = 0;
      confirming = false;
    },
    answered() {
      stop();
    },
    reset() {
      stop();
    },
  };
}
