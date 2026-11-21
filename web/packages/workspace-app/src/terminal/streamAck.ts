export type StreamAckFrame = { type: "ack"; generation: number; seq: number };

type SessionPosition = {
  generation: number;
  seq: number;
  replay_bytes?: number;
  ack_window?: number;
};

/// How long a quiet stream's last bytes wait for a report. The server needs
/// the tail to tell a view that caught up from one that stopped.
const TAIL_MS = 50;
/// Reports per window: the reader refills in steps of an eighth of it, so it
/// rarely idles on a report, at a cost of a few small frames per window.
const REPORTS_PER_WINDOW = 8;

/// Reports the raw output position the terminal has parsed, which is what
/// paces the program: a browser that keeps accepting frames while its page is
/// stalled gives the server no other signal. Reports start only after a
/// session frame advertised a window, since an older server answers an
/// unknown frame with a visible error.
export class StreamAck {
  #send: (frame: StreamAckFrame) => boolean;
  #every: number | null = null;
  #generation = 0;
  #position = 0;
  #reported = 0;
  #replayLeft = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(send: (frame: StreamAckFrame) => boolean) {
    this.#send = send;
  }

  /// Adopt a session frame. Its replay runs from `seq - replay_bytes`; the
  /// alternate-screen and mode preludes after it are not stream bytes.
  adopt(frame: SessionPosition): void {
    this.#cancelTimer();
    this.#every = frame.ack_window
      ? Math.max(1, Math.floor(frame.ack_window / REPORTS_PER_WINDOW))
      : null;
    this.#generation = frame.generation;
    this.#replayLeft = frame.replay_bytes ?? 0;
    this.#position = frame.seq - this.#replayLeft;
    this.#reported = this.#position;
  }

  /// Record a binary frame the terminal has finished parsing.
  parsed(bytes: number, replaying: boolean): void {
    if (this.#every === null) return;
    const raw = replaying ? Math.min(bytes, this.#replayLeft) : bytes;
    if (replaying) this.#replayLeft -= raw;
    this.#position += raw;
    const unreported = this.#position - this.#reported;
    if (unreported >= this.#every) this.#report();
    else if (unreported > 0 && this.#timer === null) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.#report();
      }, TAIL_MS);
    }
  }

  /// The socket is gone: its next session frame sets the position.
  stop(): void {
    this.#cancelTimer();
    this.#every = null;
  }

  #report(): void {
    this.#cancelTimer();
    if (this.#position <= this.#reported) return;
    const sent = this.#send({
      type: "ack",
      generation: this.#generation,
      seq: this.#position,
    });
    if (sent) this.#reported = this.#position;
  }

  #cancelTimer(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }
}
