// The connection probe pairs each pong with the oldest waiting ping, since the wire
// carries no ping id and the server answers in order, and times the round
// trip. Driven with an injected clock: nothing here needs a socket or a timer.

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CONNECTION_MAX_RTT_MS,
  CONNECTION_PENDING_CAP,
  createConnectionProbe,
  type ConnectionProbe,
} from "./connectionProbe";

interface Rig {
  probe: ConnectionProbe;
  /// How many times the probe reported an answering pong.
  answers: () => number;
  /// The clock's reading.
  now(): number;
  /// Move the clock forward.
  wait(ms: number): void;
  /// A whole round trip that takes `rttMs`: ping, wait, pong.
  roundTrip(rttMs: number): void;
  /// An inbound pong: the frame, then the pong it carries.
  pong(): number | null;
}

function rig(): Rig {
  let t = 1_000_000;
  let answers = 0;
  const probe = createConnectionProbe({
    now: () => t,
    onAnswer: () => {
      answers += 1;
    },
  });
  const r: Rig = {
    probe,
    answers: () => answers,
    now: () => t,
    wait(ms) {
      t += ms;
    },
    roundTrip(rttMs) {
      probe.pingSent();
      t += rttMs;
      r.pong();
    },
    pong() {
      probe.frameReceived();
      return probe.pongReceived();
    },
  };
  return r;
}

const T0 = 1_000_000;

afterEach(() => {
  vi.useRealTimers();
});

describe("pong timing", () => {
  test("each pong answers the oldest waiting ping", () => {
    const r = rig();
    r.probe.pingSent(); // T0
    r.wait(100);
    r.probe.pingSent(); // T0 + 100
    r.wait(150);
    r.probe.pingSent(); // T0 + 250
    expect(r.probe.hasPendingPing).toBe(true);

    r.wait(50); // T0 + 300
    expect(r.pong()).toBe(T0);
    expect(r.probe.rttMs).toBe(300);
    r.wait(20); // T0 + 320
    expect(r.pong()).toBe(T0 + 100);
    expect(r.probe.rttMs).toBe(220);
    r.wait(580); // T0 + 900
    expect(r.pong()).toBe(T0 + 250);
    expect(r.probe.hasPendingPing).toBe(false);

    expect(r.probe.rttMs).toBe(650);
    expect(r.probe.lastFrameAt).toBe(T0 + 900);
  });

  test("a stray pong with no ping waiting times nothing and answers nothing", () => {
    const r = rig();
    expect(r.probe.pongReceived()).toBeNull();
    expect(r.probe.answered).toBe(false);
    expect(r.probe.rttMs).toBeNull();
    expect(r.answers()).toBe(0);

    // The ping sent after it is not answered by it.
    r.probe.pingSent();
    r.wait(40);
    expect(r.pong()).toBe(T0);
  });

  test("the default clock is the wall clock", () => {
    vi.useFakeTimers();
    const probe = createConnectionProbe();
    const at = Date.now();
    probe.pingSent();
    vi.advanceTimersByTime(75);
    probe.frameReceived();
    expect(probe.pongReceived()).toBe(at);
    expect(probe.lastFrameAt).toBe(Date.now());
  });
});

describe("a retired socket", () => {
  test("clears its timings and its answer, and the probe remembers that a socket answered", () => {
    const r = rig();
    r.probe.pingSent();
    r.wait(4_000);
    r.probe.reset();
    expect(r.probe.everAnswered, "no socket has answered yet").toBe(false);

    r.roundTrip(30);
    expect(r.answers()).toBe(1);
    r.wait(3_000);
    r.probe.pingSent();
    r.wait(9_000);

    r.probe.reset();

    expect(r.probe.answered).toBe(false);
    expect(r.probe.everAnswered).toBe(true);
    expect(r.probe.hasPendingPing).toBe(false);
    expect(r.probe.rttMs).toBeNull();
    expect(r.probe.lastFrameAt).toBeNull();
    // A pong of the old socket's cannot arrive on the new one.
    expect(r.probe.pongReceived()).toBeNull();
    expect(r.answers()).toBe(1);
  });
});

describe("a clock jump", () => {
  test("pings in flight keep their place but are not timed", () => {
    const r = rig();
    r.roundTrip(30);
    r.probe.pingSent(); // in flight when the machine sleeps
    r.wait(3_600_000);
    r.probe.forgetTimings();
    expect(r.probe.hasPendingPing).toBe(true);

    r.probe.pingSent(); // the wake probe
    const probeAt = T0 + 30 + 3_600_000;
    r.wait(10);
    // The sleeping ping's pong comes first and is consumed untimed.
    expect(r.pong()).toBeNull();
    expect(r.probe.rttMs).toBe(30);
    r.wait(35);
    expect(r.pong()).toBe(probeAt);
    expect(r.probe.hasPendingPing).toBe(false);
    expect(r.probe.rttMs).toBe(45);
  });
});

describe("an over-long round trip", () => {
  test("the bounds are the contract's", () => {
    expect([CONNECTION_MAX_RTT_MS, CONNECTION_PENDING_CAP]).toEqual([45_000, 32]);
  });

  test("past the read deadline it is not timed, but it answers and keeps the pairing", () => {
    const r = rig();
    r.roundTrip(30);
    r.probe.pingSent(); // T0 + 30
    r.wait(CONNECTION_MAX_RTT_MS + 1);
    const later = r.now();
    r.probe.pingSent(); // sent before the late pong arrives
    r.wait(20);

    expect(r.pong()).toBe(T0 + 30);
    expect(r.probe.answered).toBe(true);
    expect(r.probe.rttMs).toBe(30);
    // The next pong is the later ping's own.
    expect(r.pong()).toBe(later);
    expect(r.probe.rttMs).toBe(20);
  });

  test("at exactly the read deadline it is still timed", () => {
    const r = rig();
    r.probe.pingSent();
    r.wait(CONNECTION_MAX_RTT_MS);
    expect(r.pong()).toBe(T0);
    expect(r.probe.rttMs).toBe(CONNECTION_MAX_RTT_MS);
  });

  test("as a socket's first pong it answers without a reading", () => {
    const r = rig();
    r.probe.pingSent();
    r.wait(CONNECTION_MAX_RTT_MS + 1);
    expect(r.pong()).toBe(T0);
    expect(r.probe.answered).toBe(true);
    expect(r.probe.rttMs).toBeNull();
  });
});

describe("a long queue", () => {
  /// Send `count` pings 100 ms apart and return when each left.
  function pings(r: Rig, count: number): number[] {
    const sent: number[] = [];
    for (let i = 0; i < count; i += 1) {
      r.wait(100);
      sent.push(r.now());
      r.probe.pingSent();
    }
    return sent;
  }

  test("past the cap a ping is counted, not timed, and every pong still finds its own ping", () => {
    const r = rig();
    r.roundTrip(30);
    const sent = pings(r, CONNECTION_PENDING_CAP + 3);

    r.wait(500);
    for (let i = 0; i < CONNECTION_PENDING_CAP; i += 1) {
      expect(r.pong(), `pong ${i}`).toBe(sent[i]);
    }
    // The three sent past the cap: answered in their turn, with no time.
    expect([r.pong(), r.pong(), r.pong()]).toEqual([null, null, null]);
    expect(r.probe.hasPendingPing).toBe(false);

    // Each was consumed once: the next round trip is timed as itself.
    r.probe.pingSent();
    const atCap = r.now();
    r.wait(25);
    expect(r.pong()).toBe(atCap);
    expect(r.probe.rttMs).toBe(25);
  });

  test("a ping sent while counted ones wait is counted with them", () => {
    const r = rig();
    r.roundTrip(30);
    const sent = pings(r, CONNECTION_PENDING_CAP + 1);
    r.wait(100);
    expect(r.pong()).toBe(sent[0]); // a timed place is free again
    r.wait(100);
    r.probe.pingSent(); // behind the counted one, so it cannot take that place
    r.wait(100);
    for (let i = 1; i < CONNECTION_PENDING_CAP; i += 1) {
      expect(r.pong(), `pong ${i}`).toBe(sent[i]);
    }
    // The counted one, then the one sent behind it.
    expect([r.pong(), r.pong()]).toEqual([null, null]);
    r.probe.pingSent();
    const atBehind = r.now();
    r.wait(25);
    expect(r.pong()).toBe(atBehind);
  });

  test("once the timed ones are answered, counted ones ahead do not keep the next from being timed", () => {
    const r = rig();
    r.roundTrip(30);
    pings(r, CONNECTION_PENDING_CAP + 2);
    r.wait(100);
    for (let i = 0; i < CONNECTION_PENDING_CAP; i += 1) r.pong();

    r.probe.pingSent();
    const at = r.now();
    r.wait(40);
    expect([r.pong(), r.pong()]).toEqual([null, null]);
    expect(r.pong()).toBe(at);
  });

  test("a clock jump leaves every waiting ping, counted ones too, ahead of the next", () => {
    const r = rig();
    r.roundTrip(30);
    pings(r, CONNECTION_PENDING_CAP + 2);
    r.probe.forgetTimings();

    r.probe.pingSent();
    const at = r.now();
    r.wait(35);
    for (let i = 0; i < CONNECTION_PENDING_CAP + 2; i += 1) {
      expect(r.pong(), `pong ${i}`).toBeNull();
    }
    expect(r.pong()).toBe(at);
  });
});
