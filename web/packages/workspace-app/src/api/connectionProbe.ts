// Connection probe: times one socket's pongs.
//
// The server answers each `{"type":"ping"}` with a `{"type":"pong"}` that
// carries no id, in the order the pings reached it. A queue of send times
// therefore pairs every pong with its ping and yields the round-trip time
// with nothing added to the wire.
//
// A probe serves one socket at a time and knows nothing of sockets, timers or the page:
// its owner reports what the socket did and reads the result. The
// clock is injectable so a test can drive it without real time passing.

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

export interface ConnectionProbeOptions {
  /// Clock, in milliseconds. Defaults to `Date.now`.
  now?: () => number;
  /// Called after each pong that answers a ping, the only report that can
  /// make `answered` true.
  onAnswer?: () => void;
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
  /// their own pongs give no round-trip time.
  forgetTimings(): void;
  /// The socket opened or was retired. The probe clears this socket's
  /// timings and whether it answered; `everAnswered` stays.
  reset(): void;
  /// Whether this socket has answered a ping.
  readonly answered: boolean;
  /// Whether any socket this probe has served has answered a ping.
  readonly everAnswered: boolean;
  /// Whether this socket has an unanswered ping, timed or counted.
  readonly hasPendingPing: boolean;
  /// The latest round-trip time on this socket, or `null` before the first.
  readonly rttMs: number | null;
  /// When this socket's last frame arrived, or `null` before the first.
  readonly lastFrameAt: number | null;
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
  let rttMs: number | null = null;
  let lastFrameAt: number | null = null;

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
        if (took <= CONNECTION_MAX_RTT_MS) rttMs = took;
      }
      options.onAnswer?.();
      return at;
    },
    frameReceived() {
      lastFrameAt = now();
    },
    forgetTimings() {
      if (timed.length === 0) return;
      ahead += timed.length + behind;
      timed = [];
      behind = 0;
    },
    reset() {
      ahead = 0;
      timed = [];
      behind = 0;
      answered = false;
      rttMs = null;
      lastFrameAt = null;
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
      return rttMs;
    },
    get lastFrameAt() {
      return lastFrameAt;
    },
  };
}
