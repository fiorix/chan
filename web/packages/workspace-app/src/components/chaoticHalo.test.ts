import { describe, expect, test } from "vitest";
import {
  buildChaoticHaloPoints,
  CHAOTIC_HALO_INNER_STEP,
  CHAOTIC_HALO_PARTICLE_COUNT,
  CHAOTIC_HALO_REFERENCE_SIZE,
  createChaoticHaloState,
  fitChaoticHalo,
} from "./chaoticHalo";

describe("Chaotic Halo", () => {
  test("keeps the source timing, density adaptation, and attribution", async () => {
    const renderer = (await import("./ChaoticHalo.svelte?raw"))
      .default as string;
    const geometry = (await import("./chaoticHalo.ts?raw"))
      .default as string;

    expect(renderer).toMatch(
      /const SOURCE_PHASE_PER_SECOND = 0\.003;/,
    );
    expect(CHAOTIC_HALO_PARTICLE_COUNT).toBe(200);
    expect(CHAOTIC_HALO_INNER_STEP).toBe(1);
    expect(geometry).toContain(
      "https://x.com/KomaTebe/status/1929902081554497573",
    );
  });

  test("preserves the source sketch's coupled sine recurrence", () => {
    const state = createChaoticHaloState();
    const points = buildChaoticHaloPoints(0, state, 2, 1, 1);

    expect(Array.from(points)).toEqual([
      200,
      200,
      expect.closeTo(283.30563, 4),
      expect.closeTo(352.48993, 4),
    ]);
    expect(state.x).toBeCloseTo(Math.sin(1));
    expect(state.u).toBeCloseTo(Math.sin(1));
    expect(state.v).toBeCloseTo(Math.cos(1) + 1);
  });

  test("builds a finite circular field inside the source canvas", () => {
    const points = buildChaoticHaloPoints(0.04);

    expect(points.length).toBeGreaterThan(CHAOTIC_HALO_PARTICLE_COUNT);
    expect(points.every(Number.isFinite)).toBe(true);
    expect(
      points.every(
        (coordinate) =>
          coordinate >= 0 &&
          coordinate <= CHAOTIC_HALO_REFERENCE_SIZE,
      ),
    ).toBe(true);
  });

  test("fits rectangular panes with a uniform circular scale", () => {
    expect(fitChaoticHalo(1200, 800)).toEqual({
      centerX: 600,
      centerY: 400,
      scale: 2,
    });
  });
});
