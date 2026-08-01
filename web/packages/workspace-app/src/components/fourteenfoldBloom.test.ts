import { describe, expect, test } from "vitest";
import {
  buildFourteenfoldBloomBasePoints,
  FOURTEENFOLD_BLOOM_BASE_POINT_COUNT,
} from "./fourteenfoldBloom";

describe("Fourteenfold Bloom", () => {
  test("keeps the source construction, center clearing, and credit", async () => {
    const renderer = (await import("./FourteenfoldBloom.svelte?raw"))
      .default as string;
    const geometry = (await import("./fourteenfoldBloom.ts?raw"))
      .default as string;

    expect(renderer).toContain("const PHASE_SPEED = Math.PI / 4;");
    expect(renderer).toContain("rotationCount={14}");
    expect(renderer).toContain("centerFadeRadius={140}");
    expect(geometry).toContain("@yuruyurau");
    expect(geometry).toContain(
      "https://x.com/yuruyurau/status/1974495782792507630",
    );
  });

  test("builds the source trace captured before fourteen rotations", () => {
    const points = buildFourteenfoldBloomBasePoints(0);

    expect(points).toHaveLength(FOURTEENFOLD_BLOOM_BASE_POINT_COUNT * 2);
    expect(points[0]).toBeCloseTo(205.20724, 4);
    expect(points[1]).toBeCloseTo(376.24322, 4);
  });
});
