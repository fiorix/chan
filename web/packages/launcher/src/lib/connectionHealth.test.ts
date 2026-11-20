import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import type { ConnectionHealth } from "../api/library";
import {
  connectionContactTime,
  connectionFaceLabel,
  connectionFaceName,
  connectionFigures,
  connectionSampleShift,
  connectionScrollLag,
  connectionSparkline,
  connectionSparklineWidth,
  CONNECTION_SCROLL_MS,
} from "./connectionHealth";

/// The reading the desktop serves for a connection slow from two 450 ms
/// replies, read 100 ms into its next ping; the desktop's
/// connection_health.rs tests pin it to what the desktop serves.
const SLOW_IN_FLIGHT = "../../../fixtures/connection-health/slow-reply-in-flight.json";

function health(over: Partial<ConnectionHealth>): ConnectionHealth {
  return { face: "healthy", recovering: false, since: 0, rtt_ms: 20, wait_since: null, last_contact: null, samples: [], ...over };
}

describe("face words", () => {
  test("a slow face reads the larger of its reply time and its wait", () => {
    expect(connectionFaceLabel(health({ face: "slow", rtt_ms: 1_300 }), 10_000)).toBe("1.3 s");
    expect(connectionFaceLabel(health({ face: "slow", rtt_ms: 450, wait_since: 8_800 }), 10_000)).toBe("1.2 s");
    expect(connectionFaceName(health({ face: "slow", rtt_ms: 1_300 }), 10_000)).toBe("Connection slow, 1.3 s");
    expect(connectionFaceName(health({ face: "slow", rtt_ms: 450, wait_since: 8_800 }), 10_000)).toBe("Connection slow, waiting for a reply");
  });

  test("a slow face read with a quick ping in flight keeps its reply time until the next reading", () => {
    const { read_at, health } = JSON.parse(readFileSync(SLOW_IN_FLIGHT, "utf8")) as { read_at: number; health: ConnectionHealth };
    // The next reading comes 2 s after this one.
    for (const at of [read_at, read_at + 1_000, read_at + 1_999]) {
      expect(connectionFaceLabel(health, at)).toBe("450 ms");
      expect(connectionFaceName(health, at)).toBe("Connection slow, 450 ms");
    }
  });

  test("a slow face the desktop read as recovering shows the mark alone, named recovering", () => {
    const recovering = health({ face: "slow", recovering: true, rtt_ms: 250 });
    expect(connectionFaceLabel(recovering, 10_000)).toBe("");
    expect(connectionFaceName(recovering, 10_000)).toBe("Connection recovering");
    // The flag decides whatever the reply time: the launcher keeps no
    // threshold of its own for it.
    expect(connectionFaceLabel(health({ face: "slow", recovering: true, rtt_ms: 350 }), 10_000)).toBe("");
    expect(connectionFaceLabel(health({ face: "slow", recovering: false, rtt_ms: 250 }), 10_000)).toBe("250 ms");
    // A wait the desktop serves ends it.
    const waiting = health({ face: "slow", rtt_ms: 250, wait_since: 8_800 });
    expect(connectionFaceLabel(waiting, 10_000)).toBe("1.2 s");
    expect(connectionFaceName(waiting, 10_000)).toBe("Connection slow, waiting for a reply");
  });

  test("a stalled face counts its wait in whole seconds, in its words and its name", () => {
    expect(connectionFaceLabel(health({ face: "stalled", wait_since: 2_000 }), 9_999)).toBe("stalled 7 s");
    expect(connectionFaceName(health({ face: "stalled", wait_since: 2_000 }), 9_999)).toBe("Connection stalled for 7 s");
  });

  test("a wait from a moment ahead of this clock counts as none", () => {
    expect(connectionFaceLabel(health({ face: "stalled", wait_since: 11_000 }), 10_000)).toBe("stalled 0 s");
    expect(connectionFaceLabel(health({ face: "slow", rtt_ms: 500, wait_since: 11_000 }), 10_000)).toBe("500 ms");
  });

  test("reconnecting counts from the face's start whatever ping still waits", () => {
    const down = health({ face: "reconnecting", since: 28_000, wait_since: 0 });
    expect(connectionFaceLabel(down, 40_999)).toBe("reconnecting 12 s");
    expect(connectionFaceName(down, 40_999)).toBe("Connection lost, reconnecting for 12 s");
  });

  test("reconnecting counts in whole minutes from 120 s", () => {
    const down = health({ face: "reconnecting", since: 0 });
    expect(connectionFaceLabel(down, 119_999)).toBe("reconnecting 119 s");
    expect(connectionFaceLabel(down, 120_000)).toBe("reconnecting 2 min");
    expect(connectionFaceName(down, 754_000)).toBe("Connection lost, reconnecting for 12 min");
  });

  test("a reconnecting face that starts ahead of this clock counts from zero", () => {
    expect(connectionFaceLabel(health({ face: "reconnecting", since: 10_000 }), 9_000)).toBe("reconnecting 0 s");
  });

  test.each([
    ["healthy", "Connection healthy"],
    ["unknown", "Connection status unknown"],
  ] as const)("%s shows the mark alone", (face, name) => {
    expect(connectionFaceLabel(health({ face }), 10_000)).toBe("");
    expect(connectionFaceName(health({ face }), 10_000)).toBe(name);
  });
});

describe("connection figures", () => {
  test("uses answered samples for latest, odd median and worst", () => {
    expect(connectionFigures([50, null, 10, 30])).toEqual({ latest: 30, median: 30, worst: 50 });
  });

  test("averages the middle pair for an even median", () => {
    expect(connectionFigures([40, 10, 20, 30]).median).toBe(25);
  });

  test("has no figures when all samples missed", () => {
    expect(connectionFigures([null])).toEqual({ latest: null, median: null, worst: null });
    expect(connectionFigures([])).toEqual({ latest: null, median: null, worst: null });
  });

  test("sorts reply times numerically for the median", () => {
    expect(connectionFigures([5, 100, 20, 30, 9])).toEqual({ latest: 9, median: 20, worst: 100 });
  });
});

// At 64 units wide a step is one unit, so the newest point rests at 61 and
// each older one a unit to its left.
describe("chart", () => {
  test("breaks the line at misses and marks their baseline positions", () => {
    expect(connectionSparkline([10, 20, null, 30, 40], 64, 40))
      .toEqual({ paths: ["M 57 35 L 58 34", "M 60 34 L 61 33"], misses: [59] });
  });

  test("keeps a slow-threshold floor and clips outliers above it", () => {
    expect(connectionSparkline([10, 20, 1000], 64, 40).paths).toEqual(["M 59 35 L 60 34 L 61 4"]);
  });

  test("scales to twice the median once that passes the floor", () => {
    expect(connectionSparkline([500, 600, 5000], 64, 40).paths).toEqual(["M 59 23 L 60 20 L 61 4"]);
  });

  test("paints the first answer as a point at the right edge", () => {
    expect(connectionSparkline([100], 40, 40)).toEqual({ paths: ["M 37 28 L 37 28"], misses: [] });
  });

  test("a zero median keeps one millisecond of jitter low", () => {
    expect(connectionSparkline([0, 0, 1], 64, 40).paths).toEqual(["M 59 36 L 60 36 L 61 36"]);
  });

  test("paints a lone answer between missed pings", () => {
    expect(connectionSparkline([null, 10, null], 64, 40)).toEqual({ paths: ["M 60 35 L 60 35"], misses: [59, 61] });
  });

  test("marks misses on either side of a run", () => {
    expect(connectionSparkline([null, 10, 20, null], 64, 40)).toEqual({ paths: ["M 59 35 L 60 34"], misses: [58, 61] });
  });

  test("keeps consecutive misses separate from zero reply times", () => {
    expect(connectionSparkline([0, null, null, 0], 64, 40))
      .toEqual({ paths: ["M 58 36 L 58 36", "M 61 36 L 61 36"], misses: [59, 60] });
  });

  test("marks every miss when no ping was answered", () => {
    expect(connectionSparkline([null, null, null], 64, 40)).toEqual({ paths: [], misses: [59, 60, 61] });
  });

  test("an empty history draws nothing", () => {
    expect(connectionSparkline([])).toEqual({ paths: [], misses: [] });
  });

  // The oldest of a full history leaves the left edge while the newest
  // comes in at the right, so the history's first segment must be out of
  // sight before it is dropped.
  test("rests a full history with its oldest point a step past the left edge", () => {
    const misses = connectionSparkline(Array<null>(60).fill(null), 64, 40).misses;
    expect([misses[0], misses[1], misses.at(-1)]).toEqual([2, 3, 61]);
  });
});

describe("chart width", () => {
  test("spans the detail at the chart's one scale, 48 units to 69 px", () => {
    expect(connectionSparklineWidth(552)).toBe(384);
    expect(connectionSparklineWidth(276)).toBe(192);
  });

  test("keeps the default width until the detail has been measured", () => {
    expect(connectionSparklineWidth(0)).toBe(180);
  });

  test("steps the points by the width it is given, to two decimals", () => {
    expect(connectionSparkline([20, null, 24], connectionSparklineWidth(552)))
      .toEqual({ paths: ["M 367.97 42 L 367.97 42", "M 381 42 L 381 42"], misses: [374.48] });
  });
});

// The row dates no sample: the page learns of one from what a re-list
// adds to the history it drew.
describe("sample arrival", () => {
  const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);

  test("counts what a history under the cap gains", () => {
    expect(connectionSampleShift([20, null], [20, null, 24, 25])).toBe(2);
  });

  test("counts the newest a full history adds as it drops its oldest", () => {
    expect(connectionSampleShift(range(1, 60), range(2, 60))).toBe(1);
  });

  test("counts several arrivals seen in one re-list", () => {
    expect(connectionSampleShift(range(1, 60), [...range(4, 57), null, null, null])).toBe(3);
  });

  test("counts none in a re-list that brought nothing new", () => {
    expect(connectionSampleShift(range(1, 60), range(1, 60))).toBe(0);
  });

  test("takes a shorter history for one begun afresh", () => {
    expect(connectionSampleShift([20, 24, 30], [30])).toBeNull();
  });

  test("takes a history that keeps nothing of the last one for one begun afresh", () => {
    expect(connectionSampleShift([20, 24, 30], [40, 41, 42])).toBeNull();
  });
});

describe("scroll lag", () => {
  test("closes a step per ping interval and stops at the newest sample", () => {
    expect(connectionScrollLag(1, CONNECTION_SCROLL_MS / 2)).toBeCloseTo(0.5);
    expect(connectionScrollLag(1, CONNECTION_SCROLL_MS * 2)).toBe(0);
  });

  test("keeps the steady pace two steps behind, where a 2 s re-list of a 3 s cadence leaves it", () => {
    expect(connectionScrollLag(2, CONNECTION_SCROLL_MS)).toBeCloseTo(1);
  });

  test("catches up a burst, slowing to the steady pace at two steps behind", () => {
    expect(connectionScrollLag(5, CONNECTION_SCROLL_MS)).toBeCloseTo(1 + 4 / Math.E);
    expect(connectionScrollLag(5, CONNECTION_SCROLL_MS * Math.log(4))).toBeCloseTo(2);
    expect(connectionScrollLag(5, CONNECTION_SCROLL_MS * (Math.log(4) + 0.5))).toBeCloseTo(1.5);
  });
});

describe("contact clock", () => {
  test("last contact is a locale clock time with seconds or a dash", () => {
    expect(connectionContactTime(null)).toBe("-");
    const format = vi.spyOn(Date.prototype, "toLocaleTimeString").mockReturnValue("17:42:07");
    try {
      expect(connectionContactTime(9_600)).toBe("17:42:07");
      expect(format).toHaveBeenCalledWith(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      expect((format.mock.instances[0] as Date).getTime()).toBe(9_600);
    } finally {
      format.mockRestore();
    }
  });
});
