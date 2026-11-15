import { describe, expect, test } from "vitest";
import { linkAge, linkFigures, linkIndicatorShown, linkSparkline, linkStateAge } from "./linkIndicatorMath";

for (const [placement, remote, state, expected] of [
  ["tab-bar", false, "unknown", false],
  ["tab-bar", false, "ok", false],
  ["tab-bar", false, "slow", true],
  ["tab-bar", false, "stalled", true],
  ["tab-bar", false, "down", true],
  ["tab-bar", true, "unknown", true],
  ["tab-bar", true, "ok", true],
  ["tab-bar", true, "slow", true],
  ["tab-bar", true, "stalled", true],
  ["tab-bar", true, "down", true],
  ["status", false, "unknown", false],
  ["status", false, "ok", false],
  ["status", false, "slow", true],
  ["status", false, "stalled", true],
  ["status", false, "down", true],
  ["status", true, "unknown", false],
  ["status", true, "ok", false],
  ["status", true, "slow", true],
  ["status", true, "stalled", true],
  ["status", true, "down", true],
] as const) {
  test(`visibility: ${placement}/${state}/remote=${remote}`, () => {
    expect(linkIndicatorShown(placement, state, remote)).toBe(expected);
  });
}

describe("link figures", () => {
  test("uses answered samples for latest, odd median and worst", () => {
    expect(linkFigures([{ at: 1, rttMs: 50 }, { at: 2, rttMs: null }, { at: 3, rttMs: 10 }, { at: 4, rttMs: 30 }]))
      .toEqual({ latest: 30, median: 30, worst: 50 });
  });

  test("averages the middle pair for an even median", () => {
    expect(linkFigures([{ at: 1, rttMs: 40 }, { at: 2, rttMs: 10 }, { at: 3, rttMs: 20 }, { at: 4, rttMs: 30 }]).median).toBe(25);
  });

  test("has no figures when all samples missed", () => {
    expect(linkFigures([{ at: 1, rttMs: null }])).toEqual({ latest: null, median: null, worst: null });
    expect(linkFigures([])).toEqual({ latest: null, median: null, worst: null });
  });

  test("sorts RTTs numerically for the median", () => {
    expect(linkFigures([5, 100, 20, 30, 9].map((rttMs, at) => ({ at, rttMs }))))
      .toEqual({ latest: 9, median: 20, worst: 100 });
  });
});

describe("sparkline", () => {
  test("breaks the line at misses and marks their baseline positions", () => {
    expect(linkSparkline([{ at: 1, rttMs: 10 }, { at: 2, rttMs: 20 }, { at: 3, rttMs: null }, { at: 4, rttMs: 30 }, { at: 5, rttMs: 40 }], 40, 40))
      .toEqual({ paths: ["M 3 35 L 12 34", "M 29 34 L 37 33"], misses: [20] });
  });

  test("keeps a slow-threshold floor and clips outliers above it", () => {
    const line = linkSparkline([{ at: 1, rttMs: 10 }, { at: 2, rttMs: 20 }, { at: 3, rttMs: 1000 }], 20, 40);
    expect(line.paths).toEqual(["M 3 35 L 10 34 L 17 4"]);
  });

  test("scales to twice the median once that passes the slow threshold", () => {
    expect(linkSparkline([500, 600, 5000].map((rttMs, at) => ({ at, rttMs })), 20, 40).paths)
      .toEqual(["M 3 23 L 10 20 L 17 4"]);
  });

  test("paints the first answer as an inset point", () => {
    expect(linkSparkline([{ at: 0, rttMs: 100 }], 40, 40))
      .toEqual({ paths: ["M 20 28 L 20 28"], misses: [] });
  });

  test("a zero median keeps one millisecond of jitter low", () => {
    expect(linkSparkline([0, 0, 1].map((rttMs, at) => ({ at, rttMs })), 40, 40).paths)
      .toEqual(["M 3 36 L 20 36 L 37 36"]);
  });

  test("paints a lone answer between missed pings", () => {
    expect(linkSparkline([{ at: 0, rttMs: null }, { at: 1, rttMs: 10 }, { at: 2, rttMs: null }], 40, 40))
      .toEqual({ paths: ["M 20 35 L 20 35"], misses: [3, 37] });
  });

  test("marks misses at both inset edges", () => {
    expect(linkSparkline([{ at: 0, rttMs: null }, { at: 1, rttMs: 10 }, { at: 2, rttMs: 20 }, { at: 3, rttMs: null }], 40, 40))
      .toEqual({ paths: ["M 14 35 L 26 34"], misses: [3, 37] });
  });

  test("keeps consecutive misses separate from zero RTT answers", () => {
    expect(linkSparkline([{ at: 0, rttMs: 0 }, { at: 1, rttMs: null }, { at: 2, rttMs: null }, { at: 3, rttMs: 0 }], 40, 40))
      .toEqual({ paths: ["M 3 36 L 3 36", "M 37 36 L 37 36"], misses: [14, 26] });
  });

  test("marks every miss when no ping was answered", () => {
    expect(linkSparkline([{ at: 0, rttMs: null }, { at: 1, rttMs: null }, { at: 2, rttMs: null }], 40, 40))
      .toEqual({ paths: [], misses: [3, 20, 37] });
  });

  test("an empty history draws nothing", () => {
    expect(linkSparkline([])).toEqual({ paths: [], misses: [] });
  });
});

describe("age wording", () => {
  test("last contact age uses a dash before any contact", () => {
    expect(linkAge(null, 12_000)).toBe("-");
    expect(linkAge(9_600, 12_000)).toBe("2 s ago");
  });

  test("clamps future contact and state timestamps to zero", () => {
    expect(linkAge(10_000, 9_000)).toBe("0 s ago");
    expect(linkStateAge("stalled", 10_000, 9_000)).toBe("No response for 0 s");
  });

  test("uses whole minutes from two minutes onward", () => {
    expect(linkAge(0, 119_999)).toBe("119 s ago");
    expect(linkAge(0, 120_000)).toBe("2 min ago");
    expect(linkAge(0, 121_000)).toBe("2 min ago");
    expect(linkAge(0, 179_000)).toBe("2 min ago");
    expect(linkStateAge("down", 0, 754_000)).toBe("Reconnecting for 12 min");
  });

  test.each([
    ["ok", "Connected"],
    ["unknown", "No reading yet"],
    ["slow", "Slow for 12 s"],
    ["stalled", "No response for 12 s"],
    ["down", "Reconnecting for 12 s"],
  ] as const)("words %s state", (state, expected) => {
    expect(linkStateAge(state, 0, 12_900)).toBe(expected);
  });
});
