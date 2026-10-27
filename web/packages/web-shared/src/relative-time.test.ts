import { describe, expect, it, vi } from "vitest";
import { exactStamp, relativeAge } from "./relative-time";

const at = Date.UTC(2026, 0, 2, 12, 34, 56);
const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

describe("relativeAge", () => {
  it.each([
    [59_000, "just now"],
    [minute, "1 minute ago"],
    [2 * minute, "2 minutes ago"],
    [59 * minute, "59 minutes ago"],
    [hour, "1 hour ago"],
    [2 * hour, "2 hours ago"],
    [23 * hour, "23 hours ago"],
    [day, "1 day ago"],
    [2 * day, "2 days ago"],
    [6 * day, "6 days ago"],
    [7 * day, "2026-01-02"],
  ])("formats an age of %i ms as %s", (elapsed, expected) => {
    expect(relativeAge(at, at + elapsed)).toBe(expected);
  });
});

describe("exactStamp", () => {
  it("includes the local date, time, and the offset at the event across DST", () => {
    vi.stubEnv("TZ", "America/New_York");
    try {
      expect(exactStamp(at)).toBe("2026-01-02 07:34:56 -05:00");
      expect(exactStamp(Date.UTC(2026, 6, 2, 12, 34, 56))).toBe("2026-07-02 08:34:56 -04:00");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
