import { describe, expect, test } from "vitest";
import {
  buildThreefoldVeilPoints,
  fitThreefoldVeil,
  THREEFOLD_VEIL_POINT_COUNT,
} from "./threefoldVeil";

describe("Threefold Veil", () => {
  test("keeps the source timing and credits @yuruyurau", async () => {
    const renderer = (await import("./ThreefoldVeil.svelte?raw"))
      .default as string;
    const geometry = (await import("./threefoldVeil.ts?raw"))
      .default as string;

    expect(renderer).toMatch(/const PHASE_SPEED = Math\.PI;/);
    expect(geometry).toContain("@yuruyurau");
    expect(geometry).toContain(
      "https://x.com/yuruyurau/status/2083185617345921400",
    );
  });

  test("builds the source sketch's 10,000 points", () => {
    const points = buildThreefoldVeilPoints(0);

    expect(points).toHaveLength(THREEFOLD_VEIL_POINT_COUNT * 2);
    expect(points.every(Number.isFinite)).toBe(true);
  });

  test("preserves the three interleaved phase offsets", () => {
    const points = buildThreefoldVeilPoints(0, 3);

    expect(points[0]).toBeCloseTo(82.05225, 4);
    expect(points[1]).toBeCloseTo(288.70142, 4);
    expect(points[2]).toBeCloseTo(343.55653, 4);
    expect(points[3]).toBeCloseTo(206.18337, 4);
    expect(points[4]).toBeCloseTo(186.77179, 4);
    expect(points[5]).toBeCloseTo(59.33509, 4);
  });

  test("fits the square source canvas into rectangular panes", () => {
    const transform = fitThreefoldVeil(1400, 900);

    expect(transform.centerX).toBe(700);
    expect(transform.centerY).toBe(450);
    expect(transform.sourceCenterX).toBe(200);
    expect(transform.sourceCenterY).toBe(200);
    expect(transform.scale).toBeGreaterThan(4);
  });
});
