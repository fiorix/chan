// Connection probe: times one socket's pongs and reads the connection's health from them.
//
// The server answers each `{"type":"ping"}` with a `{"type":"pong"}` that
// carries no id, in the order the pings reached it. A queue of send times
// therefore pairs every pong with its ping and yields the round-trip time
// with nothing added to the wire.
//
// A probe serves one socket at a time and knows nothing of sockets, timers or the page:
// its owner reports what the socket did and reads the result. The
// clock is injectable so a test can drive it without real time passing.

/// What the probe's pongs say about its connection. `unknown` until this socket has
/// received a pong, or any socket this probe has served with memory enabled.
export type ConnectionProbeState = "unknown" | "ok" | "slow" | "stalled";

/// A ping unanswered this long makes the connection `slow`. Well above a healthy
/// round trip through a gateway, so jitter does not trip it, and short enough
/// to show while the user still wonders why the window stopped answering.
export const CONNECTION_SLOW_WAIT_MS = 1_000;
/// Round trips at or over this make the connection `slow` once CONNECTION_RTT_RUN in a
/// row reach it: the delay at which an echoed keystroke visibly lags.
export const CONNECTION_SLOW_RTT_MS = 400;
/// Round trips must come back under this, CONNECTION_RTT_RUN in a row, for the connection
/// to leave `slow`. Lower than the entry threshold so a connection that hovers
/// around it does not change state on every pong.
export const CONNECTION_OK_RTT_MS = 300;
/// How many round trips in a row a threshold takes, so that one outlier
/// neither enters nor leaves `slow`.
export const CONNECTION_RTT_RUN = 2;
/// A ping unanswered this long, with no frame of any kind arriving meanwhile,
/// makes the connection `stalled`: it carries nothing. Long enough for TCP to
/// retransmit through a short burst of loss, and well short of the read
/// deadlines, so the state shows before the socket is retired.
export const CONNECTION_STALLED_MS = 4_000;
/// The longest round trip worth timing: the sockets' ordinary read deadline,
/// `WS_READ_DEADLINE_MS` in `transport.ts`, repeated here because this module
/// imports nothing. A socket silent that long is retired, so a pong later
/// than this crossed a jump of the page's clock, as over a machine sleep, or
/// came over a socket that other frames kept open, and neither is the connection's
/// round-trip time.
export const CONNECTION_MAX_RTT_MS = 45_000;
/// How many waiting pings keep their send time. A socket whose pongs stop
/// while other frames keep it open would otherwise hold one for every ping
/// of its life. Several times what either cadence sends inside its read
/// deadline, so a socket retired on silence never reaches it.
export const CONNECTION_PENDING_CAP = 32;

/// One finished ping.
export interface ConnectionSample {
  /// When the ping left, on the probe's clock.
  at: number;
  /// How long its pong took, or `null` for a ping the socket never answered.
  rttMs: number | null;
}

/// What `classifyConnection` reads. Times are on the probe's clock.
export interface ConnectionReading {
  /// This socket has received a pong, or an earlier one when this probe keeps
  /// answer memory across resets.
  hasAnswered: boolean;
  /// Its latest round trips, oldest first.
  rtts: readonly number[];
  /// When the oldest unanswered ping left, or `null` with none waiting.
  oldestPingAt: number | null;
  /// When the last frame of any kind arrived, or `null` with none yet.
  lastFrameAt: number | null;
}

/// The connection's state at `now`, given the state it was in. Pure: the previous
/// state is the only memory, and it matters only for leaving `slow`, which
/// takes CONNECTION_RTT_RUN round trips under CONNECTION_OK_RTT_MS where entering takes
/// as many at CONNECTION_SLOW_RTT_MS or over, or one at CONNECTION_SLOW_WAIT_MS or over.
export function classifyConnection(
  prev: ConnectionProbeState,
  reading: ConnectionReading,
  now: number,
): ConnectionProbeState {
  if (!reading.hasAnswered) return "unknown";
  const pingAt = reading.oldestPingAt;
  if (pingAt !== null) {
    // The silence counts from the ping: a frame older than the ping says
    // nothing about a connection that was not being asked. A frame newer than the
    // ping proves the connection still carries data, however late the pong.
    const quietSince = Math.max(pingAt, reading.lastFrameAt ?? pingAt);
    if (now - quietSince >= CONNECTION_STALLED_MS) return "stalled";
    if (now - pingAt >= CONNECTION_SLOW_WAIT_MS) return "slow";
  }
  // A round trip that long had its ping overdue, whether or not anything
  // read the state while it waited: a socket's first ping waits in `unknown`
  // unless this probe keeps answer memory from an earlier socket.
  const latest = reading.rtts.at(-1);
  if (latest !== undefined && latest >= CONNECTION_SLOW_WAIT_MS) return "slow";
  const run = reading.rtts.slice(-CONNECTION_RTT_RUN);
  const full = run.length === CONNECTION_RTT_RUN;
  if (prev === "slow" || prev === "stalled") {
    return full && run.every((ms) => ms < CONNECTION_OK_RTT_MS) ? "ok" : "slow";
  }
  return full && run.every((ms) => ms >= CONNECTION_SLOW_RTT_MS) ? "slow" : "ok";
}

export interface ConnectionProbeOptions {
  /// Keep whether any socket this probe has served answered a ping across reset().
  rememberAnsweredAcrossSockets?: boolean;
  /// Clock, in milliseconds. Defaults to `Date.now`.
  now?: () => number;
  /// Called once per finished ping that was timed: an answered one with its
  /// round-trip time, and each eligible one still waiting when the socket is
  /// retired as a miss.
  onSample?: (sample: ConnectionSample) => void;
  /// Called after every report that changed the probe, so an owner can read
  /// it again.
  onChange?: () => void;
}

export interface ConnectionProbe {
  /// A ping is leaving. Report it before handing the frame to the socket: a
  /// socket that answers in place, as the demo's does, delivers the pong
  /// inside the send.
  pingSent(): void;
  /// A pong arrived, reported after `frameReceived` for the same frame.
  /// Returns the send time of the ping it answers, or `null` where it
  /// answers none that was timed: a stray pong with no ping waiting, or the
  /// pong of a ping that was not timed (its timing forgotten, or the ping
  /// counted because CONNECTION_PENDING_CAP timed ones already waited). All
  /// but the stray one still count as the socket answering.
  pongReceived(): number | null;
  /// A frame of any kind arrived, a pong included.
  frameReceived(): void;
  /// The clock jumped while pings were in flight, as across a machine sleep.
  /// They keep their place in the queue, so later pongs still pair up, but
  /// their own pongs give no round-trip time and they count as neither timed
  /// waits nor misses.
  forgetTimings(): void;
  /// The socket opened or was retired. Timed waiting pings become misses if
  /// this socket answered, or if answer memory was enabled and an earlier
  /// socket answered. The probe then clears this socket's timings.
  reset(): void;
  /// Whether this socket has answered a ping.
  readonly answered: boolean;
  /// Whether any socket this probe has served has answered a ping, including
  /// earlier sockets only when rememberAnsweredAcrossSockets is enabled.
  readonly everAnswered: boolean;
  /// Whether this socket has an unanswered ping, timed or counted.
  readonly hasPendingPing: boolean;
  /// The latest round-trip time on this socket, or `null` before the first.
  readonly rttMs: number | null;
  /// When this socket's last frame arrived, or `null` before the first.
  readonly lastFrameAt: number | null;
  /// When the oldest unanswered ping that is still timed left, or `null` with
  /// none waiting.
  readonly oldestPingAt: number | null;
  /// The connection's state now, carried forward from the state at the last call.
  /// Time alone can change it while a ping waits, so an owner that wants the
  /// change without a socket event calls again on a timer.
  classify(): ConnectionProbeState;
}

export function createConnectionProbe(options: ConnectionProbeOptions = {}): ConnectionProbe {
  const now = options.now ?? (() => Date.now());
  // The pings awaiting a pong, in the order their pongs come: `ahead` of them
  // untimed, then the send times in `timed`, oldest first, then `behind` more
  // untimed. Only the timed ones take memory, and at most CONNECTION_PENDING_CAP of
  // them; an untimed ping is a count, which is all the pairing needs.
  let ahead = 0;
  let timed: number[] = [];
  let behind = 0;
  let answered = false;
  let everAnswered = false;
  let rtts: number[] = [];
  let lastFrameAt: number | null = null;
  let state: ConnectionProbeState = "unknown";

  const oldestPingAt = (): number | null => timed[0] ?? null;

  return {
    pingSent() {
      // With no timed ping left between them, the ones behind are ahead of
      // this one like any other.
      if (timed.length === 0) {
        ahead += behind;
        behind = 0;
      }
      // A send time joins `timed` only at its end, so a ping sent while
      // untimed ones wait behind is counted with them: timing it would hand
      // it the pong of an older ping.
      if (behind > 0 || timed.length >= CONNECTION_PENDING_CAP) behind += 1;
      else timed.push(now());
      options.onChange?.();
    },
    pongReceived() {
      let at: number | null = null;
      if (ahead > 0) ahead -= 1;
      else if (timed.length > 0) at = timed.shift() ?? null;
      else if (behind > 0) behind -= 1;
      else return null;
      answered = true;
      everAnswered = true;
      if (at !== null) {
        const took = Math.max(0, now() - at);
        if (took <= CONNECTION_MAX_RTT_MS) {
          rtts.push(took);
          if (rtts.length > CONNECTION_RTT_RUN) rtts.shift();
          options.onSample?.({ at, rttMs: took });
        }
      }
      options.onChange?.();
      return at;
    },
    frameReceived() {
      lastFrameAt = now();
      options.onChange?.();
    },
    forgetTimings() {
      if (timed.length === 0) return;
      ahead += timed.length + behind;
      timed = [];
      behind = 0;
      options.onChange?.();
    },
    reset() {
      if (everAnswered) {
        for (const at of timed) options.onSample?.({ at, rttMs: null });
      }
      ahead = 0;
      timed = [];
      behind = 0;
      answered = false;
      if (!options.rememberAnsweredAcrossSockets) everAnswered = false;
      rtts = [];
      lastFrameAt = null;
      state = "unknown";
      options.onChange?.();
    },
    get answered() {
      return answered;
    },
    get everAnswered() {
      return everAnswered;
    },
    get hasPendingPing() {
      return ahead > 0 || timed.length > 0 || behind > 0;
    },
    get rttMs() {
      return rtts.at(-1) ?? null;
    },
    get lastFrameAt() {
      return lastFrameAt;
    },
    get oldestPingAt() {
      return oldestPingAt();
    },
    classify() {
      state = classifyConnection(
        state,
        { hasAnswered: everAnswered, rtts, oldestPingAt: oldestPingAt(), lastFrameAt },
        now(),
      );
      return state;
    },
  };
}
