// The link probe pairs each pong with the oldest waiting ping, since the wire
// carries no ping id and the server answers in order, and reads the link's
// state from the round trips and from how long a ping has waited. Driven with
// an injected clock: nothing here needs a socket or a timer.

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  LINK_OK_RTT_MS,
  LINK_RTT_RUN,
  LINK_SLOW_RTT_MS,
  LINK_SLOW_WAIT_MS,
  LINK_STALLED_MS,
  classifyLink,
  createLinkProbe,
  type LinkProbe,
  type LinkReading,
  type LinkSample,
} from "./linkProbe";

interface Rig {
  probe: LinkProbe;
  samples: LinkSample[];
  changes: () => number;
  /// Move the clock forward.
  wait(ms: number): void;
  /// A whole round trip that takes `rttMs`: ping, wait, pong.
  roundTrip(rttMs: number): void;
  /// An inbound pong: the frame, then the pong it carries.
  pong(): number | null;
}

function rig(): Rig {
  let t = 1_000_000;
  let changed = 0;
  const samples: LinkSample[] = [];
  const probe = createLinkProbe({
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
    const probe = createLinkProbe();
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
    // Nothing of the old socket is left for the next one.
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
});

describe("a clock jump", () => {
  test("pings in flight keep their place but are neither timed, waiting nor missed", () => {
    const r = rig();
    r.roundTrip(30);
    r.probe.pingSent(); // in flight when the machine sleeps
    r.wait(3_600_000);
    r.probe.forgetTimings();
    expect(r.probe.oldestPingAt).toBeNull();
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

describe("the state", () => {
  test("the thresholds are the contract's", () => {
    expect([
      LINK_SLOW_WAIT_MS,
      LINK_SLOW_RTT_MS,
      LINK_OK_RTT_MS,
      LINK_RTT_RUN,
      LINK_STALLED_MS,
    ]).toEqual([1_000, 400, 300, 2, 4_000]);
  });

  test("a socket that has never answered stays unknown however long its pings wait", () => {
    const r = rig();
    expect(r.probe.classify()).toBe("unknown");
    r.probe.pingSent();
    r.wait(LINK_STALLED_MS * 10);
    expect(r.probe.classify()).toBe("unknown");
    // Frames other than a pong do not make it known either.
    r.probe.frameReceived();
    r.wait(LINK_STALLED_MS * 10);
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
    r.wait(LINK_SLOW_WAIT_MS - 1);
    expect(r.probe.classify()).toBe("ok");
    r.wait(1);
    expect(r.probe.classify()).toBe("slow");
  });

  test("two round trips in a row at the slow threshold make it slow, one does not", () => {
    const r = rig();
    r.roundTrip(30);
    r.roundTrip(LINK_SLOW_RTT_MS + 50);
    expect(r.probe.classify()).toBe("ok");
    r.roundTrip(30);
    expect(r.probe.classify()).toBe("ok");
    r.roundTrip(LINK_SLOW_RTT_MS + 50);
    expect(r.probe.classify()).toBe("ok");
    r.roundTrip(LINK_SLOW_RTT_MS);
    expect(r.probe.classify()).toBe("slow");
  });

  test("it leaves slow only after two round trips in a row under the ok threshold", () => {
    const r = rig();
    r.roundTrip(LINK_SLOW_RTT_MS);
    r.roundTrip(LINK_SLOW_RTT_MS);
    expect(r.probe.classify()).toBe("slow");

    // Between the two thresholds it stays slow.
    r.roundTrip(LINK_OK_RTT_MS);
    r.roundTrip(LINK_OK_RTT_MS);
    expect(r.probe.classify()).toBe("slow");
    // One fast round trip is not a run.
    r.roundTrip(LINK_OK_RTT_MS - 1);
    expect(r.probe.classify()).toBe("slow");
    r.roundTrip(LINK_OK_RTT_MS - 1);
    expect(r.probe.classify()).toBe("ok");

    // The same round trips that kept it slow do not make an ok link slow.
    r.roundTrip(LINK_OK_RTT_MS);
    r.roundTrip(LINK_OK_RTT_MS);
    expect(r.probe.classify()).toBe("ok");
  });

  test("it does not leave slow while a ping is overdue", () => {
    const r = rig();
    r.roundTrip(30);
    r.probe.pingSent();
    r.wait(LINK_SLOW_WAIT_MS);
    expect(r.probe.classify()).toBe("slow");
    expect(r.pong()).toBe(LINK_SLOW_WAIT_MS);
    // Two fast round trips in a row would end it, but the next ping is late.
    r.roundTrip(30);
    r.roundTrip(30);
    r.probe.pingSent();
    r.wait(LINK_SLOW_WAIT_MS);
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
    r.wait(LINK_STALLED_MS - 1);
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
    r.wait(LINK_STALLED_MS - 1);
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
    r.wait(LINK_STALLED_MS - 11);
    expect(r.probe.classify()).toBe("slow");
    r.wait(1);
    expect(r.probe.classify()).toBe("stalled");
  });

  test("a stalled link is slow at its first frame and ok after two fast round trips", () => {
    const r = rig();
    r.roundTrip(30);
    r.probe.pingSent();
    r.wait(LINK_STALLED_MS + 2_000);
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

describe("classifyLink", () => {
  const base: LinkReading = { answered: true, rtts: [], oldestPingAt: null, lastFrameAt: null };

  test("is a function of the previous state, the reading and the time", () => {
    const now = 50_000;
    expect(classifyLink("ok", { ...base, answered: false, oldestPingAt: 0 }, now)).toBe("unknown");
    expect(classifyLink("unknown", base, now)).toBe("ok");
    expect(classifyLink("ok", { ...base, rtts: [500, 500] }, now)).toBe("slow");
    expect(classifyLink("ok", { ...base, rtts: [350, 350] }, now)).toBe("ok");
    expect(classifyLink("slow", { ...base, rtts: [350, 350] }, now)).toBe("slow");
    expect(classifyLink("slow", { ...base, rtts: [100, 100] }, now)).toBe("ok");
    expect(classifyLink("stalled", { ...base, rtts: [100, 100] }, now)).toBe("ok");
    expect(classifyLink("stalled", { ...base, rtts: [5_000, 100] }, now)).toBe("slow");
    const waiting = { ...base, rtts: [100, 100], oldestPingAt: now - 6_000 };
    expect(classifyLink("ok", waiting, now)).toBe("stalled");
    expect(classifyLink("ok", { ...waiting, lastFrameAt: now - 3_999 }, now)).toBe("slow");
    expect(classifyLink("ok", { ...waiting, lastFrameAt: now - 4_000 }, now)).toBe("stalled");
    expect(classifyLink("ok", { ...waiting, oldestPingAt: now - 999 }, now)).toBe("ok");
  });
});
