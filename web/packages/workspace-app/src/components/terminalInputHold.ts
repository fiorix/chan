// What the user sends while a terminal socket is unproven. Input written to a
// dead socket is lost and input resent after a redial can run twice, so from a
// wake until the socket answers or is replaced the user's frames wait here and
// then go out once, in order, to whichever socket won. Generated replies and
// control frames never pass through this queue.

/// The most frames and characters the hold keeps. Past either it lets go early
/// rather than lose anything: the queue goes to the current socket, whose fate
/// the Reconnected note then covers.
export const TERMINAL_HOLD_MAX_FRAMES = 4096;
export const TERMINAL_HOLD_MAX_CHARS = 256 * 1024;
/// How often an expired cap looks again while a probe's verdict is due.
const VERDICT_RECHECK_MS = 250;

export interface HeldInput {
  /// The wire frame, as `send` takes it.
  frame: Record<string, unknown>;
  /// Characters of user data in the frame.
  size: number;
  /// Whether the frame counts as typed input for the Reconnected note.
  countsAsInput: boolean;
  /// The Rich Prompt message this frame submits.
  promptId?: string;
}

export interface TerminalInputHoldOptions {
  /// Whether a socket is open to deliver to.
  canSend: () => boolean;
  deliver: (entry: HeldInput) => void;
  /// Typed input was given up on, so the next open socket owes the note.
  onDropped: () => void;
  /// A probe has gone quiet and is about to decide this socket. The cap waits
  /// for that rather than hand the queue to a socket it may declare dead.
  verdictPending?: () => boolean;
}

export interface TerminalInputHold {
  readonly active: boolean;
  /// Start holding, for at most `capMs`. A running hold keeps its deadline, so
  /// repeated wakes cannot extend it.
  begin(capMs: number): void;
  /// Take a frame. False when no hold is running and the caller should send it.
  offer(entry: HeldInput): boolean;
  /// An interrupt: everything held goes ahead of it, now, and the hold goes on.
  /// With no socket open it waits in order with the rest.
  interrupt(entry: HeldInput): boolean;
  /// The socket was proven or replaced: deliver the queue and stop holding.
  release(): void;
  /// The socket is being replaced. The first call of a hold gives it `capMs`
  /// to attach, however many dials fail; past that the queue is dropped. Until
  /// `replacementProven` or `release`, nothing goes out, interrupts included.
  awaitReplacement(capMs: number): void;
  /// The replacement reached the held session while a new probe runs on it,
  /// so it is the socket an interrupt goes to.
  replacementProven(): void;
  /// Nothing may be delivered: drop the queue and stop holding.
  abandon(): void;
  /// Take back a held Rich Prompt message. True when it had not been sent.
  remove(promptId: string): boolean;
}

export function createTerminalInputHold(options: TerminalInputHoldOptions): TerminalInputHold {
  let active = false;
  let queue: HeldInput[] = [];
  let chars = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let overflowing = false;
  let replacing = false;
  let replacementArmed = false;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const arm = (capMs: number) => {
    clearTimer();
    timer = setTimeout(expire, capMs);
  };
  const expire = () => {
    timer = null;
    if (replacing) abandon();
    else if (options.verdictPending?.()) timer = setTimeout(expire, VERDICT_RECHECK_MS);
    else if (options.canSend()) release();
    else abandon();
  };
  const flush = () => {
    const entries = queue;
    queue = [];
    chars = 0;
    for (const entry of entries) options.deliver(entry);
  };
  const stop = () => {
    active = false;
    overflowing = false;
    replacing = false;
    replacementArmed = false;
    clearTimer();
  };
  const release = () => {
    if (!active) return;
    stop();
    flush();
  };
  const abandon = () => {
    if (!active) return;
    stop();
    const lostInput = queue.some((entry) => entry.countsAsInput);
    queue = [];
    chars = 0;
    if (lostInput) options.onDropped();
  };

  return {
    get active() {
      return active;
    },
    begin(capMs) {
      if (active) return;
      active = true;
      arm(capMs);
    },
    offer(entry) {
      if (!active) return false;
      queue.push(entry);
      chars += entry.size;
      if (!overflowing && (queue.length > TERMINAL_HOLD_MAX_FRAMES || chars > TERMINAL_HOLD_MAX_CHARS)) {
        overflowing = true;
        // After the caller's turn: a submit records its message as pending
        // only once the send has returned.
        queueMicrotask(release);
      }
      return true;
    },
    interrupt(entry) {
      if (!active) return false;
      if (replacing || !options.canSend()) {
        queue.push(entry);
        chars += entry.size;
        return true;
      }
      flush();
      options.deliver(entry);
      return true;
    },
    release,
    awaitReplacement(capMs) {
      if (!active) return;
      replacing = true;
      if (replacementArmed) return;
      replacementArmed = true;
      arm(capMs);
    },
    replacementProven() {
      replacing = false;
    },
    abandon,
    remove(promptId) {
      const at = queue.findIndex((entry) => entry.promptId === promptId);
      if (at < 0) return false;
      chars -= queue[at].size;
      queue.splice(at, 1);
      return true;
    },
  };
}
