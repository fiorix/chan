import { describe, expect, it } from "vitest";
import {
  clampScrollbackMb,
  scrollbackLinesFromMb,
  SCROLLBACK_BASELINE_COLS,
  SCROLLBACK_BYTES_PER_CELL,
  SCROLLBACK_MB_DEFAULT,
  SCROLLBACK_MB_MAX,
  SCROLLBACK_MB_MIN,
} from "./scrollback";

describe("clampScrollbackMb", () => {
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

describe("scrollbackLinesFromMb", () => {
  it("uses the baseline column width when none is supplied", () => {
    // 50 MB / (80 cols * 12 bytes/cell) = 54_613 lines (floor).
    const lines = scrollbackLinesFromMb(50);
    const expected = Math.floor(
      (50 * 1024 * 1024) / (SCROLLBACK_BASELINE_COLS * SCROLLBACK_BYTES_PER_CELL),
    );
    expect(lines).toBe(expected);
  });

  it("default budget converts to ~11k lines at the baseline width", () => {
    // The 10 MB default is a deliberate budget cut; pin its line
    // translation so a constant change is a conscious decision here.
    const expected = Math.floor(
      (SCROLLBACK_MB_DEFAULT * 1024 * 1024) /
        (SCROLLBACK_BASELINE_COLS * SCROLLBACK_BYTES_PER_CELL),
    );
    expect(scrollbackLinesFromMb(SCROLLBACK_MB_DEFAULT)).toBe(expected);
    expect(expected).toBeGreaterThan(10_000);
  });

  it("scales inversely with column width", () => {
    // Wider terminals consume more bytes per line, so the same MB
    // budget translates to fewer lines.
    const eighty = scrollbackLinesFromMb(100, 80);
    const oneSixty = scrollbackLinesFromMb(100, 160);
    expect(oneSixty).toBeLessThan(eighty);
    // Halving the line cost halves the lines, modulo floor noise.
    expect(eighty / 2 - oneSixty).toBeLessThanOrEqual(1);
  });

  it("never drops below 1 line even for tiny inputs", () => {
    expect(scrollbackLinesFromMb(0)).toBe(1);
    expect(scrollbackLinesFromMb(0.0001, 80)).toBe(1);
  });

  it("tolerates degenerate column widths", () => {
    // Zero / negative cols default to 1 so the divisor stays sane.
    expect(scrollbackLinesFromMb(10, 0)).toBeGreaterThan(0);
    expect(scrollbackLinesFromMb(10, -4)).toBeGreaterThan(0);
  });
});
