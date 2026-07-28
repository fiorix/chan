import { describe, expect, test } from "vitest";
import {
  buildQuadraticBloomPoints,
  fitQuadraticBloom,
  QUADRATIC_BLOOM_GUTTER,
  QUADRATIC_BLOOM_ITERATIONS,
} from "./quadraticBloom";

describe("buildQuadraticBloomPoints", () => {
  test("keeps the named renderer tuning and source attribution", async () => {
    const renderer = (await import("./QuadraticBloom.svelte?raw"))
      .default as string;
    const geometry = (await import("./quadraticBloom.ts?raw"))
      .default as string;

    expect(renderer).toMatch(
      /const PHASE_SPEED = \(Math\.PI \* 60\) \/ 1000;/,
    );
    expect(renderer).toMatch(/--quadratic-bloom-point-alpha: 0\.075;/);
    expect(geometry).toContain(
      "https://x.com/hisadan/status/2046584749175832639",
    );
  });

  test("preserves the source sketch's quadratic recurrence", () => {
    const points = buildQuadraticBloomPoints(0, 2);

    expect(Array.from(points)).toEqual([
      expect.closeTo(0.186, 6),
      expect.closeTo(0.01, 6),
      expect.closeTo(0.3441, 6),
      expect.closeTo(0.041596, 6),
    ]);
  });

  test("emits the full stable attractor trace", () => {
    const points = buildQuadraticBloomPoints(1, QUADRATIC_BLOOM_ITERATIONS);

    expect(points).toHaveLength(QUADRATIC_BLOOM_ITERATIONS * 2);
    expect(points.every(Number.isFinite)).toBe(true);
  });

  test("stops a diverging trace before invalid coordinates reach canvas", () => {
    const points = buildQuadraticBloomPoints(0);

    expect(points.length).toBeGreaterThan(0);
    expect(points.length).toBeLessThan(QUADRATIC_BLOOM_ITERATIONS * 2);
    expect(points.every((coordinate) => Math.abs(coordinate) <= 8)).toBe(true);
  });

  test("fits the full attractor below the pane bar and near its side edges", () => {
    const width = 1400;
    const height = 800;
    const transform = fitQuadraticBloom(width, height);

    expect(transform.centerX + -1.84 * transform.scaleX).toBeCloseTo(
      QUADRATIC_BLOOM_GUTTER,
    );
    expect(transform.centerX + 1.84 * transform.scaleX).toBeCloseTo(
      width - QUADRATIC_BLOOM_GUTTER,
    );
    expect(transform.centerY + -1.43 * transform.scaleY).toBeCloseTo(
      QUADRATIC_BLOOM_GUTTER,
    );
    expect(transform.centerY + 3.38 * transform.scaleY).toBeCloseTo(
      height - QUADRATIC_BLOOM_GUTTER,
    );
    expect(transform.scaleX).toBeGreaterThan(transform.scaleY);
  });
});
