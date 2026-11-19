import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import type { ConnectionHealth } from "../api/library";
import {
  connectionContactTime,
  connectionFaceLabel,
  connectionFaceName,
  connectionFigures,
  connectionSparkline,
  connectionStateAge,
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

  test("a stalled face counts its wait in whole seconds", () => {
    expect(connectionFaceLabel(health({ face: "stalled", wait_since: 2_000 }), 9_999)).toBe("stalled 7 s");
    expect(connectionFaceName(health({ face: "stalled", wait_since: 2_000 }), 9_999)).toBe("Connection stalled");
  });

  test("a wait from a moment ahead of this clock counts as none", () => {
    expect(connectionFaceLabel(health({ face: "stalled", wait_since: 11_000 }), 10_000)).toBe("stalled 0 s");
    expect(connectionFaceLabel(health({ face: "slow", rtt_ms: 500, wait_since: 11_000 }), 10_000)).toBe("500 ms");
  });

  test("reconnecting reads its word whatever ping still waits", () => {
    const down = health({ face: "reconnecting", wait_since: 0 });
    expect(connectionFaceLabel(down, 40_000)).toBe("reconnecting");
    expect(connectionFaceName(down, 40_000)).toBe("Connection lost, reconnecting");
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

describe("chart", () => {
  test("breaks the line at misses and marks their baseline positions", () => {
    expect(connectionSparkline([10, 20, null, 30, 40], 40, 40))
      .toEqual({ paths: ["M 3 35 L 12 34", "M 29 34 L 37 33"], misses: [20] });
  });

  test("keeps a slow-threshold floor and clips outliers above it", () => {
    expect(connectionSparkline([10, 20, 1000], 20, 40).paths).toEqual(["M 3 35 L 10 34 L 17 4"]);
  });

  test("scales to twice the median once that passes the floor", () => {
    expect(connectionSparkline([500, 600, 5000], 20, 40).paths).toEqual(["M 3 23 L 10 20 L 17 4"]);
  });

  test("paints the first answer as an inset point", () => {
    expect(connectionSparkline([100], 40, 40)).toEqual({ paths: ["M 20 28 L 20 28"], misses: [] });
  });

  test("a zero median keeps one millisecond of jitter low", () => {
    expect(connectionSparkline([0, 0, 1], 40, 40).paths).toEqual(["M 3 36 L 20 36 L 37 36"]);
  });

  test("paints a lone answer between missed pings", () => {
    expect(connectionSparkline([null, 10, null], 40, 40)).toEqual({ paths: ["M 20 35 L 20 35"], misses: [3, 37] });
  });

  test("marks misses at both inset edges", () => {
    expect(connectionSparkline([null, 10, 20, null], 40, 40)).toEqual({ paths: ["M 14 35 L 26 34"], misses: [3, 37] });
  });

  test("keeps consecutive misses separate from zero reply times", () => {
    expect(connectionSparkline([0, null, null, 0], 40, 40))
      .toEqual({ paths: ["M 3 36 L 3 36", "M 37 36 L 37 36"], misses: [14, 26] });
  });

  test("marks every miss when no ping was answered", () => {
    expect(connectionSparkline([null, null, null], 40, 40)).toEqual({ paths: [], misses: [3, 20, 37] });
  });

  test("an empty history draws nothing", () => {
    expect(connectionSparkline([])).toEqual({ paths: [], misses: [] });
  });
});

describe("contact clock and state age", () => {
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

  test("clamps a face that starts ahead of this clock to zero", () => {
    expect(connectionStateAge(health({ face: "slow", since: 10_000 }), 9_000)).toBe("Slow for 0 s");
  });

  test("uses whole minutes for long state ages", () => {
    expect(connectionStateAge(health({ face: "reconnecting", since: 0 }), 754_000)).toBe("Reconnecting for 12 min");
  });

  test("changes state age from seconds to minutes at 120 s", () => {
    expect(connectionStateAge(health({ face: "reconnecting", since: 0 }), 119_999)).toBe("Reconnecting for 119 s");
    expect(connectionStateAge(health({ face: "reconnecting", since: 0 }), 120_000)).toBe("Reconnecting for 2 min");
  });

  test.each([
    ["healthy", "Connected"],
    ["unknown", "No reading yet"],
    ["slow", "Slow for 12 s"],
    ["stalled", "No response for 12 s"],
    ["reconnecting", "Reconnecting for 12 s"],
  ] as const)("words the %s face", (face, expected) => {
    expect(connectionStateAge(health({ face, since: 0, wait_since: 0 }), 12_900)).toBe(expected);
  });

  test("stalled counts the ping's wait, while slow and reconnecting count from the face's start", () => {
    expect(connectionStateAge(health({ face: "stalled", since: 16_000, wait_since: 11_100 }), 20_000)).toBe("No response for 8 s");
    expect(connectionStateAge(health({ face: "slow", since: 16_000, wait_since: 11_100 }), 20_000)).toBe("Slow for 4 s");
    expect(connectionStateAge(health({ face: "reconnecting", since: 16_000, wait_since: 11_100 }), 20_000)).toBe("Reconnecting for 4 s");
  });
});
