import { describe, expect, test } from "vitest";
import {
  buildTwinVeilDancePoints,
  TWIN_VEIL_DANCE_POINT_COUNT,
} from "./twinVeilDance";

describe("Twin Veil Dance", () => {
  test("keeps the source cadence and credits @yuruyurau", async () => {
    const renderer = (await import("./TwinVeilDance.svelte?raw"))
      .default as string;
    const geometry = (await import("./twinVeilDance.ts?raw"))
      .default as string;

    expect(renderer).toContain("const PHASE_SPEED = (4 * Math.PI) / 3;");
    expect(geometry).toContain("@yuruyurau");
    expect(geometry).toContain(
      "https://x.com/yuruyurau/status/2051676013902639591",
    );
  });

  test("builds the source sketch's 20,000 interleaved points", () => {
    const points = buildTwinVeilDancePoints(0);

    expect(points).toHaveLength(TWIN_VEIL_DANCE_POINT_COUNT * 2);
    expect(points.every(Number.isFinite)).toBe(true);
    expect(points[0]).toBeCloseTo(269.8125, 4);
    expect(points[1]).toBeCloseTo(180.12452, 4);
    expect(points[2]).toBeCloseTo(143.87201, 4);
    expect(points[3]).toBeCloseTo(172.23804, 4);
  });
});
