// The connection probe pairs each pong with the oldest waiting ping, since the wire
// carries no ping id and the server answers in order, and reads the connection's
// state from the round trips and from how long a ping has waited. Driven with
// an injected clock: nothing here needs a socket or a timer.

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CONNECTION_MAX_RTT_MS,
  CONNECTION_OK_RTT_MS,
  CONNECTION_PENDING_CAP,
  CONNECTION_RTT_RUN,
  CONNECTION_SLOW_RTT_MS,
  CONNECTION_SLOW_WAIT_MS,
  CONNECTION_STALLED_MS,
  classifyConnection,
  createConnectionProbe,
  type ConnectionProbe,
  type ConnectionReading,
  type ConnectionSample,
} from "./connectionProbe";

interface Rig {
  probe: ConnectionProbe;
  samples: ConnectionSample[];
  changes: () => number;
  /// The clock's reading.
  now(): number;
  /// Move the clock forward.
  wait(ms: number): void;
  /// A whole round trip that takes `rttMs`: ping, wait, pong.
  roundTrip(rttMs: number): void;
  /// An inbound pong: the frame, then the pong it carries.
  pong(): number | null;
}

function rig(rememberAnsweredAcrossSockets = false): Rig {
  let t = 1_000_000;
  let changed = 0;
  const samples: ConnectionSample[] = [];
  const probe = createConnectionProbe({
    rememberAnsweredAcrossSockets,
    now: () => t,
    onSample: (s) => samples.push(s),
    onChange: () => {
      changed += 1;
    },
  });
  const r: Rig = {
    probe,
    samples,
    changes: () => changed,
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
    expect(r.probe.oldestPingAt).toBe(T0);

    r.wait(50); // T0 + 300
    expect(r.pong()).toBe(300);
    expect(r.probe.oldestPingAt).toBe(T0 + 100);
    r.wait(20); // T0 + 320
    expect(r.pong()).toBe(220);
    expect(r.probe.oldestPingAt).toBe(T0 + 250);
    r.wait(580); // T0 + 900
    expect(r.pong()).toBe(650);
    expect(r.probe.oldestPingAt).toBeNull();

    expect(r.probe.rttMs).toBe(650);
    expect(r.probe.lastFrameAt).toBe(T0 + 900);
    expect(r.samples).toEqual([
      { at: T0, rttMs: 300 },
      { at: T0 + 100, rttMs: 220 },
      { at: T0 + 250, rttMs: 650 },
    ]);
  });

  test("a stray pong with no ping waiting times nothing and answers nothing", () => {
    const r = rig();
    const before = r.changes();
    expect(r.probe.pongReceived()).toBeNull();
    expect(r.probe.answered).toBe(false);
    expect(r.probe.rttMs).toBeNull();
    expect(r.samples).toEqual([]);
    expect(r.changes()).toBe(before);
    expect(r.probe.classify()).toBe("unknown");

    // The ping sent after it is not answered by it.
    r.probe.pingSent();
    r.wait(40);
    expect(r.pong()).toBe(40);
  });

  test("the default clock is the wall clock", () => {
    vi.useFakeTimers();
    const probe = createConnectionProbe();
    probe.pingSent();
    vi.advanceTimersByTime(75);
    probe.frameReceived();
    expect(probe.pongReceived()).toBe(75);
    expect(probe.lastFrameAt).toBe(Date.now());
  });
});

describe("a retired socket", () => {
  test("pings still waiting on a socket that had answered become misses", () => {
    const r = rig();
    r.roundTrip(30);
    r.wait(3_000);
    r.probe.pingSent(); // T0 + 3030
    r.wait(3_000);
    r.probe.pingSent(); // T0 + 6030
    r.wait(9_000);

    r.probe.reset();

    expect(r.samples).toEqual([
      { at: T0, rttMs: 30 },
      { at: T0 + 3_030, rttMs: null },
      { at: T0 + 6_030, rttMs: null },
    ]);
    // Socket timings and default answer knowledge clear together.
    expect(r.probe.answered).toBe(false);
    expect(r.probe.rttMs).toBeNull();
    expect(r.probe.lastFrameAt).toBeNull();
    expect(r.probe.oldestPingAt).toBeNull();
    expect(r.probe.classify()).toBe("unknown");
    // A pong of the old socket's cannot arrive on the new one.
    expect(r.probe.pongReceived()).toBeNull();
  });

  test("a socket that never answered leaves no miss", () => {
    const r = rig();
    r.probe.pingSent();
    r.wait(20_000);
    r.probe.pingSent();
    r.wait(25_000);
    r.probe.reset();
    expect(r.samples).toEqual([]);
  });

  test("a later socket's first ping ages after another socket answered and leaves a miss with memory", () => {
    const r = rig(true);
    r.roundTrip(30);
    r.probe.reset();
    expect(r.probe.answered).toBe(false);
    expect(r.probe.everAnswered).toBe(true);
    r.probe.pingSent();
    r.wait(1_000);
    expect(r.probe.classify()).toBe("slow");
    r.wait(3_000);
    expect(r.probe.classify()).toBe("stalled");
    r.probe.reset();
    expect(r.samples).toEqual([{ at: T0, rttMs: 30 }, { at: T0 + 30, rttMs: null }]);
    expect(r.probe.everAnswered).toBe(true);
    r.probe.pingSent();
    r.wait(4_000);
    expect(r.probe.classify()).toBe("stalled");
  });

  test("a default probe keeps classification, waits and misses on the current socket", () => {
    const r = rig();
    r.roundTrip(30);
    r.probe.reset();
    expect(r.probe.everAnswered).toBe(false);
    r.probe.pingSent();
    r.wait(4_000);
    expect(r.probe.oldestPingAt).toBe(T0 + 30);
    expect(r.probe.classify()).toBe("unknown");
    r.probe.reset();
    expect(r.samples).toEqual([{ at: T0, rttMs: 30 }]);
  });
});

describe("a clock jump", () => {
  test("pings in flight keep their place but are neither timed, waiting nor missed", () => {
    const r = rig();
    r.roundTrip(30);
    r.probe.pingSent(); // in flight when the machine sleeps
    r.wait(3_600_000);
    r.probe.forgetTimings();
    expect(r.probe.oldestPingAt).toBeNull();
    expect(r.probe.hasPendingPing).toBe(true);
    expect(r.probe.classify()).toBe("ok");

    r.probe.pingSent(); // the wake probe
    const probeAt = T0 + 30 + 3_600_000;
    expect(r.probe.oldestPingAt).toBe(probeAt);
    r.wait(10);
    // The sleeping ping's pong comes first and is consumed untimed.
    expect(r.pong()).toBeNull();
    expect(r.probe.oldestPingAt).toBe(probeAt);
    r.wait(35);
    expect(r.pong()).toBe(45);
    expect(r.probe.hasPendingPing).toBe(false);
    expect(r.probe.rttMs).toBe(45);
    expect(r.samples).toEqual([
      { at: T0, rttMs: 30 },
      { at: probeAt, rttMs: 45 },
    ]);
  });

  test("a forgotten ping still waiting at the retire is not a miss", () => {
    const r = rig();
    r.roundTrip(30);
    r.probe.pingSent();
    r.probe.forgetTimings();
    r.probe.reset();
    expect(r.samples).toEqual([{ at: T0, rttMs: 30 }]);
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

    expect(r.pong()).toBeNull();
    expect(r.probe.answered).toBe(true);
    expect(r.probe.rttMs).toBe(30);
    expect(r.probe.oldestPingAt).toBe(later);
    // The next pong is the later ping's own.
    expect(r.pong()).toBe(20);
    expect(r.samples).toEqual([
      { at: T0, rttMs: 30 },
      { at: later, rttMs: 20 },
    ]);
  });

  test("at exactly the read deadline it is still timed", () => {
    const r = rig();
    r.probe.pingSent();
    r.wait(CONNECTION_MAX_RTT_MS);
    expect(r.pong()).toBe(CONNECTION_MAX_RTT_MS);
    expect(r.samples).toEqual([{ at: T0, rttMs: CONNECTION_MAX_RTT_MS }]);
  });

  test("as a socket's first pong it answers without a reading", () => {
    const r = rig();
    r.probe.pingSent();
    r.wait(CONNECTION_MAX_RTT_MS + 1);
    expect(r.pong()).toBeNull();
    expect(r.probe.answered).toBe(true);
    expect(r.probe.rttMs).toBeNull();
    expect(r.samples).toEqual([]);
    expect(r.probe.classify()).toBe("ok");
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
    expect(r.probe.oldestPingAt).toBe(sent[0]);

    r.wait(500);
    for (let i = 0; i < CONNECTION_PENDING_CAP; i += 1) {
      expect(r.pong(), `pong ${i}`).toBe(r.now() - sent[i]);
    }
    expect(r.probe.oldestPingAt).toBeNull();
    // The three sent past the cap: answered in their turn, with no time.
    expect([r.pong(), r.pong(), r.pong()]).toEqual([null, null, null]);

    // Each was consumed once: the next round trip is timed as itself.
    r.probe.pingSent();
    r.wait(25);
    expect(r.pong()).toBe(25);
    expect(r.samples).toHaveLength(1 + CONNECTION_PENDING_CAP + 1);
  });

  test("a ping sent while counted ones wait is counted with them", () => {
    const r = rig();
    r.roundTrip(30);
    const sent = pings(r, CONNECTION_PENDING_CAP + 1);
    r.wait(100);
    expect(r.pong()).toBe(r.now() - sent[0]); // a timed place is free again
    r.wait(100);
    r.probe.pingSent(); // behind the counted one, so it cannot take that place
    r.wait(100);
    for (let i = 1; i < CONNECTION_PENDING_CAP; i += 1) {
      expect(r.pong(), `pong ${i}`).toBe(r.now() - sent[i]);
    }
    // The counted one, then the one sent behind it.
    expect([r.pong(), r.pong()]).toEqual([null, null]);
    r.probe.pingSent();
    r.wait(25);
    expect(r.pong()).toBe(25);
  });

  test("once the timed ones are answered, counted ones ahead do not keep the next from being timed", () => {
    const r = rig();
    r.roundTrip(30);
    pings(r, CONNECTION_PENDING_CAP + 2);
    r.wait(100);
    for (let i = 0; i < CONNECTION_PENDING_CAP; i += 1) r.pong();
    expect(r.probe.oldestPingAt).toBeNull();

    r.probe.pingSent();
    const at = r.now();
    expect(r.probe.oldestPingAt).toBe(at);
    r.wait(40);
    expect([r.pong(), r.pong()]).toEqual([null, null]);
    expect(r.pong()).toBe(40);
  });

  test("a retired socket's misses stop at the cap", () => {
    const r = rig();
    r.roundTrip(30);
    const sent = pings(r, CONNECTION_PENDING_CAP + 5);
    r.probe.reset();
    const misses = r.samples.filter((s) => s.rttMs === null);
    expect(misses.map((s) => s.at)).toEqual(sent.slice(0, CONNECTION_PENDING_CAP));
  });

  test("a clock jump leaves every waiting ping, counted ones too, ahead of the next", () => {
    const r = rig();
    r.roundTrip(30);
    pings(r, CONNECTION_PENDING_CAP + 2);
    r.probe.forgetTimings();
    expect(r.probe.oldestPingAt).toBeNull();

    r.probe.pingSent();
    const at = r.now();
    expect(r.probe.oldestPingAt).toBe(at);
    r.wait(35);
    for (let i = 0; i < CONNECTION_PENDING_CAP + 2; i += 1) {
      expect(r.pong(), `pong ${i}`).toBeNull();
    }
    expect(r.pong()).toBe(35);
    // None of the forgotten ones is a miss.
    r.probe.reset();
    expect(r.samples.filter((s) => s.rttMs === null)).toEqual([]);
  });
});

describe("the state", () => {
  test("the thresholds are the contract's", () => {
    expect([
      CONNECTION_SLOW_WAIT_MS,
      CONNECTION_SLOW_RTT_MS,
      CONNECTION_OK_RTT_MS,
      CONNECTION_RTT_RUN,
      CONNECTION_STALLED_MS,
    ]).toEqual([1_000, 400, 300, 2, 4_000]);
  });

  test("a socket that has never answered stays unknown however long its pings wait", () => {
    const r = rig();
    expect(r.probe.classify()).toBe("unknown");
    r.probe.pingSent();
    r.wait(CONNECTION_STALLED_MS * 10);
    expect(r.probe.classify()).toBe("unknown");
    // Frames other than a pong do not make it known either.
    r.probe.frameReceived();
    r.wait(CONNECTION_STALLED_MS * 10);
    expect(r.probe.classify()).toBe("unknown");
  });

  test("the first pong makes it ok", () => {
    const r = rig();
    r.roundTrip(30);
    expect(r.probe.answered).toBe(true);
    expect(r.probe.classify()).toBe("ok");
  });

  test("a ping unanswered for the slow wait makes it slow", () => {
    const r = rig();
    r.roundTrip(30);
    r.probe.pingSent();
    r.wait(CONNECTION_SLOW_WAIT_MS - 1);
    expect(r.probe.classify()).toBe("ok");
    r.wait(1);
    expect(r.probe.classify()).toBe("slow");
  });

  test("two round trips in a row at the slow threshold make it slow, one does not", () => {
    const r = rig();
    r.roundTrip(30);
    r.roundTrip(CONNECTION_SLOW_RTT_MS + 50);
    expect(r.probe.classify()).toBe("ok");
    r.roundTrip(30);
    expect(r.probe.classify()).toBe("ok");
    r.roundTrip(CONNECTION_SLOW_RTT_MS + 50);
    expect(r.probe.classify()).toBe("ok");
    r.roundTrip(CONNECTION_SLOW_RTT_MS);
    expect(r.probe.classify()).toBe("slow");
  });

  test("one round trip at the slow wait makes it slow, though nothing read the state meanwhile", () => {
    // A socket's first ping waits in `unknown`, so no reading saw it overdue.
    const first = rig();
    first.roundTrip(CONNECTION_SLOW_WAIT_MS);
    expect(first.probe.classify()).toBe("slow");

    const r = rig();
    r.roundTrip(CONNECTION_SLOW_WAIT_MS - 1);
    expect(r.probe.classify()).toBe("ok");
    r.roundTrip(30);
    expect(r.probe.classify()).toBe("ok");
    // On a connection that was ok, a page whose timers were held reads only the pong.
    r.roundTrip(CONNECTION_SLOW_WAIT_MS + 500);
    expect(r.probe.classify()).toBe("slow");
    // Leaving is as for any slow connection: two round trips in a row under the
    // ok threshold.
    r.roundTrip(30);
    expect(r.probe.classify()).toBe("slow");
    r.roundTrip(30);
    expect(r.probe.classify()).toBe("ok");
  });

  test("it leaves slow only after two round trips in a row under the ok threshold", () => {
    const r = rig();
    r.roundTrip(CONNECTION_SLOW_RTT_MS);
    r.roundTrip(CONNECTION_SLOW_RTT_MS);
    expect(r.probe.classify()).toBe("slow");

    // Between the two thresholds it stays slow.
    r.roundTrip(CONNECTION_OK_RTT_MS);
    r.roundTrip(CONNECTION_OK_RTT_MS);
    expect(r.probe.classify()).toBe("slow");
    // One fast round trip is not a run.
    r.roundTrip(CONNECTION_OK_RTT_MS - 1);
    expect(r.probe.classify()).toBe("slow");
    r.roundTrip(CONNECTION_OK_RTT_MS - 1);
    expect(r.probe.classify()).toBe("ok");

    // The same round trips that kept it slow do not make an ok connection slow.
    r.roundTrip(CONNECTION_OK_RTT_MS);
    r.roundTrip(CONNECTION_OK_RTT_MS);
    expect(r.probe.classify()).toBe("ok");
  });

  test("it does not leave slow while a ping is overdue", () => {
    const r = rig();
    r.roundTrip(30);
    r.probe.pingSent();
    r.wait(CONNECTION_SLOW_WAIT_MS);
    expect(r.probe.classify()).toBe("slow");
    expect(r.pong()).toBe(CONNECTION_SLOW_WAIT_MS);
    // Two fast round trips in a row would end it, but the next ping is late.
    r.roundTrip(30);
    r.roundTrip(30);
    r.probe.pingSent();
    r.wait(CONNECTION_SLOW_WAIT_MS);
    expect(r.probe.classify()).toBe("slow");
    r.pong();
    r.roundTrip(30);
    r.roundTrip(30);
    expect(r.probe.classify()).toBe("ok");
  });

  test("it is stalled only once nothing at all has arrived for the stall time", () => {
    const r = rig();
    r.roundTrip(30);
    r.probe.pingSent();
    r.wait(CONNECTION_STALLED_MS - 1);
    expect(r.probe.classify()).toBe("slow");
    r.wait(1);
    expect(r.probe.classify()).toBe("stalled");
  });

  test("a late pong with other frames flowing is slow, not stalled", () => {
    const r = rig();
    r.roundTrip(30);
    r.probe.pingSent();
    for (let i = 0; i < 6; i += 1) {
      r.wait(2_000);
      r.probe.frameReceived();
      expect(r.probe.classify()).toBe("slow");
    }
    // The frames stop: the stall counts from the last of them.
    r.wait(CONNECTION_STALLED_MS - 1);
    expect(r.probe.classify()).toBe("slow");
    r.wait(1_000);
    expect(r.probe.classify()).toBe("stalled");
  });

  test("the stall counts from the ping, not from an older frame", () => {
    const r = rig();
    r.roundTrip(30);
    // A quiet socket on the ordinary cadence: its last frame is long past.
    r.wait(20_000);
    r.probe.pingSent();
    r.wait(10);
    expect(r.probe.classify()).toBe("ok");
    r.wait(CONNECTION_STALLED_MS - 11);
    expect(r.probe.classify()).toBe("slow");
    r.wait(1);
    expect(r.probe.classify()).toBe("stalled");
  });

  test("a stalled connection is slow at its first frame and ok after two fast round trips", () => {
    const r = rig();
    r.roundTrip(30);
    r.probe.pingSent();
    r.wait(CONNECTION_STALLED_MS + 2_000);
    expect(r.probe.classify()).toBe("stalled");

    r.probe.frameReceived();
    expect(r.probe.classify()).toBe("slow");
    r.pong(); // the late pong itself
    expect(r.probe.classify()).toBe("slow");
    r.roundTrip(30);
    expect(r.probe.classify()).toBe("slow");
    r.roundTrip(30);
    expect(r.probe.classify()).toBe("ok");
  });
});

describe("classifyConnection", () => {
  const base: ConnectionReading = { hasAnswered: true, rtts: [], oldestPingAt: null, lastFrameAt: null };

  test("reads the latest round trip alone for the slow wait", () => {
    const now = 50_000;
    expect(classifyConnection("unknown", { ...base, rtts: [1_000] }, now)).toBe("slow");
    expect(classifyConnection("unknown", { ...base, rtts: [999] }, now)).toBe("ok");
    expect(classifyConnection("ok", { ...base, rtts: [50, 1_000] }, now)).toBe("slow");
    // An older one says nothing by itself.
    expect(classifyConnection("ok", { ...base, rtts: [1_000, 50] }, now)).toBe("ok");
    expect(classifyConnection("slow", { ...base, rtts: [1_000, 50] }, now)).toBe("slow");
  });

  test("is a function of the previous state, the reading and the time", () => {
    const now = 50_000;
    expect(classifyConnection("ok", { ...base, hasAnswered: false, oldestPingAt: 0 }, now)).toBe("unknown");
    expect(classifyConnection("unknown", base, now)).toBe("ok");
    expect(classifyConnection("ok", { ...base, rtts: [500, 500] }, now)).toBe("slow");
    expect(classifyConnection("ok", { ...base, rtts: [350, 350] }, now)).toBe("ok");
    expect(classifyConnection("slow", { ...base, rtts: [350, 350] }, now)).toBe("slow");
    expect(classifyConnection("slow", { ...base, rtts: [100, 100] }, now)).toBe("ok");
    expect(classifyConnection("stalled", { ...base, rtts: [100, 100] }, now)).toBe("ok");
    expect(classifyConnection("stalled", { ...base, rtts: [5_000, 100] }, now)).toBe("slow");
    const waiting = { ...base, rtts: [100, 100], oldestPingAt: now - 6_000 };
    expect(classifyConnection("ok", waiting, now)).toBe("stalled");
    expect(classifyConnection("ok", { ...waiting, lastFrameAt: now - 3_999 }, now)).toBe("slow");
    expect(classifyConnection("ok", { ...waiting, lastFrameAt: now - 4_000 }, now)).toBe("stalled");
    expect(classifyConnection("ok", { ...waiting, oldestPingAt: now - 999 }, now)).toBe("ok");
  });
});
