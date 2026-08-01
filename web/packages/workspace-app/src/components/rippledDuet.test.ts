import { describe, expect, test } from "vitest";
import {
  buildRippledDuetPoints,
  RIPPLED_DUET_POINT_COUNT,
} from "./rippledDuet";

describe("Rippled Duet", () => {
  test("keeps the source cadence and credits @yuruyurau", async () => {
    const renderer = (await import("./RippledDuet.svelte?raw"))
      .default as string;
    const geometry = (await import("./rippledDuet.ts?raw"))
      .default as string;

    expect(renderer).toContain("const PHASE_SPEED = (4 * Math.PI) / 3;");
    expect(geometry).toContain("@yuruyurau");
    expect(geometry).toContain(
      "https://x.com/yuruyurau/status/2031366569448886284",
    );
  });

  test("builds the source sketch's 20,000 interleaved points", () => {
    const points = buildRippledDuetPoints(0);

    expect(points).toHaveLength(RIPPLED_DUET_POINT_COUNT * 2);
    expect(points.every(Number.isFinite)).toBe(true);
    expect(points[0]).toBeCloseTo(290.21122, 4);
    expect(points[1]).toBeCloseTo(135.76975, 4);
    expect(points[2]).toBeCloseTo(110.8144, 4);
    expect(points[3]).toBeCloseTo(231.71367, 4);
  });
});
