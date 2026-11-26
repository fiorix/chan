import { describe, expect, it } from "vitest";
import {
  clampScrollbackMb,
  SCROLLBACK_MB_DEFAULT,
  SCROLLBACK_MB_MAX,
  SCROLLBACK_MB_MIN,
} from "./scrollback";

describe("clampScrollbackMb", () => {
  it("defaults to 50 MB inside the server's bounds of 10 and 50 MB", () => {
    expect(clampScrollbackMb(undefined)).toBe(50);
    expect(clampScrollbackMb(0)).toBe(50);
    expect(clampScrollbackMb(9)).toBe(10);
    expect(clampScrollbackMb(10)).toBe(10);
    expect(clampScrollbackMb(51)).toBe(50);
  });

  it("returns the default for undefined / null / NaN / Infinity", () => {
    expect(clampScrollbackMb(undefined)).toBe(SCROLLBACK_MB_DEFAULT);
    expect(clampScrollbackMb(null)).toBe(SCROLLBACK_MB_DEFAULT);
    expect(clampScrollbackMb(NaN)).toBe(SCROLLBACK_MB_DEFAULT);
    expect(clampScrollbackMb(Number.POSITIVE_INFINITY)).toBe(SCROLLBACK_MB_DEFAULT);
  });

  it("snaps zero (and negatives) to the default rather than clamping to MIN", () => {
    // Matches the server-side `sanitize_terminal_config` policy: a
    // cleared field on disk is treated as 'unset', not as 'minimum'.
    expect(clampScrollbackMb(0)).toBe(SCROLLBACK_MB_DEFAULT);
    expect(clampScrollbackMb(-5)).toBe(SCROLLBACK_MB_DEFAULT);
  });

  it("clamps below-range values to MIN and above-range to MAX", () => {
    expect(clampScrollbackMb(1)).toBe(SCROLLBACK_MB_MIN);
    expect(clampScrollbackMb(SCROLLBACK_MB_MIN - 1)).toBe(SCROLLBACK_MB_MIN);
    expect(clampScrollbackMb(SCROLLBACK_MB_MAX + 1)).toBe(SCROLLBACK_MB_MAX);
    expect(clampScrollbackMb(99_999)).toBe(SCROLLBACK_MB_MAX);
  });

  it("passes in-range integers through unchanged", () => {
    expect(clampScrollbackMb(SCROLLBACK_MB_MIN)).toBe(SCROLLBACK_MB_MIN);
    expect(clampScrollbackMb(SCROLLBACK_MB_DEFAULT)).toBe(SCROLLBACK_MB_DEFAULT);
    expect(clampScrollbackMb(SCROLLBACK_MB_MAX)).toBe(SCROLLBACK_MB_MAX);
    expect(clampScrollbackMb(25)).toBe(25);
  });

  it("rounds fractional values to the nearest integer", () => {
    expect(clampScrollbackMb(49.4)).toBe(49);
    expect(clampScrollbackMb(49.6)).toBe(50);
  });
});
