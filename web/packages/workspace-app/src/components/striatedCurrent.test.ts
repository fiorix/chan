import { describe, expect, test } from "vitest";
import {
  buildStriatedCurrentPoints,
  STRIATED_CURRENT_POINT_COUNT,
} from "./striatedCurrent";

describe("Striated Current", () => {
  test("keeps the source cadence and credits @yuruyurau", async () => {
    const renderer = (await import("./StriatedCurrent.svelte?raw"))
      .default as string;
    const geometry = (await import("./striatedCurrent.ts?raw"))
      .default as string;

    expect(renderer).toContain("const PHASE_SPEED = (3 * Math.PI) / 4;");
    expect(geometry).toContain("@yuruyurau");
    expect(geometry).toContain(
      "https://x.com/yuruyurau/status/2082474544644985022",
    );
  });

  test("builds the source sketch's 10,000 points", () => {
    const points = buildStriatedCurrentPoints(0);

    expect(points).toHaveLength(STRIATED_CURRENT_POINT_COUNT * 2);
    expect(points.every(Number.isFinite)).toBe(true);
    expect(points[0]).toBeCloseTo(152.71606, 4);
    expect(points[1]).toBeCloseTo(138.63249, 4);
  });
});
