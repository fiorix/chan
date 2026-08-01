import { describe, expect, test } from "vitest";
import {
  buildHexagonalBloomBasePoints,
  HEXAGONAL_BLOOM_BASE_POINT_COUNT,
} from "./hexagonalBloom";

describe("Hexagonal Bloom", () => {
  test("keeps the source construction, center clearing, and credit", async () => {
    const renderer = (await import("./HexagonalBloom.svelte?raw"))
      .default as string;
    const geometry = (await import("./hexagonalBloom.ts?raw"))
      .default as string;

    expect(renderer).toContain("const PHASE_SPEED = Math.PI / 4;");
    expect(renderer).toContain("rotationCount={6}");
    expect(renderer).toContain("centerFadeRadius={140}");
    expect(geometry).toContain("@yuruyurau");
    expect(geometry).toContain(
      "https://x.com/yuruyurau/status/1973029806314004916",
    );
  });

  test("builds the source trace captured before six rotations", () => {
    const points = buildHexagonalBloomBasePoints(0);

    expect(points).toHaveLength(HEXAGONAL_BLOOM_BASE_POINT_COUNT * 2);
    expect(points[0]).toBeCloseTo(180.04782, 4);
    expect(points[1]).toBeCloseTo(363.04138, 4);
  });
});
