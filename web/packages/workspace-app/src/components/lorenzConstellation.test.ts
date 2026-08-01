import { describe, expect, test } from "vitest";
import {
  buildLorenzConstellationPoints,
  LORENZ_CONSTELLATION_POINT_COUNT,
} from "./lorenzConstellation";

describe("Lorenz Constellation", () => {
  test("runs at half the source cadence and credits @yuruyurau", async () => {
    const renderer = (await import("./LorenzConstellation.svelte?raw"))
      .default as string;
    const geometry = (await import("./lorenzConstellation.ts?raw"))
      .default as string;

    expect(renderer).toContain("const SOURCE_FRAME_SPEED = 30;");
    expect(renderer).toContain("Half the source sketch's 60 frames/second cadence");
    expect(geometry).toContain("@yuruyurau");
    expect(geometry).toContain(
      "https://x.com/yuruyurau/status/2053149494439800895",
    );
  });

  test("builds the source sketch's 30,000 projected Lorenz points", () => {
    const points = buildLorenzConstellationPoints(0);

    expect(points).toHaveLength(LORENZ_CONSTELLATION_POINT_COUNT * 2);
    expect(points.every(Number.isFinite)).toBe(true);
    expect(points[0]).toBeCloseTo(101.20698, 4);
    expect(points[1]).toBeCloseTo(235.13727, 4);
  });
});
